'use strict';
/**
 * 「录音 / 录屏拆分 + 分段设置迁移」回归验证。
 *
 * 钉四件事：
 *  1. 顶栏与会议纪要工具栏都只给「录音」「录屏」两个入口，不再有单个「录制」按钮；
 *  2. 点「录音」不弹任何配置窗（一键直启）——这是本次改动的核心用户可见差异；
 *  3. 点「录屏」必须弹选源面板：有画面网格、两种音源勾选、无「采集方式」单选、无分片选项；
 *  4. 分段时长在会议纪要界面配置，写入 tool.recorder 偏好，改完 select 能持久化和回显。
 *
 * 用法：node scripts/verify-recorder-split.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9533';
const profile = path.join(os.tmpdir(), `knodo-rec-split-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [
  root,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

let childLog = '';
child.stdout.on('data', (b) => { childLog += b.toString(); });
child.stderr.on('data', (b) => { childLog += b.toString(); });

let closed = false;
function killChild() {
  if (closed) return;
  closed = true;
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* 已退出 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 交给系统清理 */ }
}

async function listPages() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) return list.filter((t) => t.type === 'page');
    } catch (_) { /* 窗口还没起来 */ }
    await sleep(300);
  }
  throw new Error('找不到渲染进程调试页（CDP 连接超时）');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`WebSocket 连接失败：${e && e.message ? e.message : e}`));
  });
  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      consoleErrors.push((d && d.exception && d.exception.description) || (d && d.text) || '未知异常');
      return;
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable', {}).catch(() => {});
  return {
    evaluate: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || '渲染层表达式异常');
      }
      return r && r.result ? r.result.value : undefined;
    },
    consoleErrors,
    close: () => ws.close(),
  };
}

(async () => {
  const fail = (msg, extra) => {
    console.log(`[REC-SPLIT] FAIL：${msg}`);
    if (extra) console.log(`[REC-SPLIT] ${JSON.stringify(extra)}`);
    killChild();
    process.exit(1);
  };

  try {
    await listPages();
    const pages = await listPages();
    const mainPage = pages.find((t) => /index\.html/.test(t.url));
    if (!mainPage) throw new Error('没找到主窗口页面');
    const main = await connect(mainPage.webSocketDebuggerUrl);
    await sleep(1400);

    const out = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const info = await window.api.env.getStorageInfo();
      if (!/knodo-rec-split-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离：' + JSON.stringify(info));
      const o = {};

      // ---- 1) 顶栏两个入口，旧的单个「录制」按钮必须在 DOM 里消失 ----
      o.tbAudio = !!document.getElementById('btn-record-audio');
      o.tbScreen = !!document.getElementById('btn-record-screen');
      o.tbOldGone = !document.getElementById('btn-record');
      o.tbAudioText = (document.getElementById('btn-record-audio') || {}).textContent || '';
      o.tbScreenText = (document.getElementById('btn-record-screen') || {}).textContent || '';

      // 进会议纪要视图
      document.querySelector('.nav-item[data-view="meetings"]').click();
      await wait(900);

      // ---- 2) 工具栏两个入口 + 分段下拉 ----
      o.viewAudio = !!document.querySelector('[data-mt="record-audio"]');
      o.viewScreen = !!document.querySelector('[data-mt="record-screen"]');
      o.viewOldGone = !document.querySelector('[data-mt="record"]');
      const slice = document.getElementById('mt-slice');
      o.sliceInView = !!slice;
      o.sliceOptCount = slice ? slice.querySelectorAll('option').length : 0;

      // ---- 3) 分段设置持久化：改 select → 读偏好 → 重绘回显 ----
      const original = slice ? slice.value : '600000';
      if (slice) {
        slice.value = '900000';
        slice.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(250);
      }
      const pref = await window.api.ui.getToolPref('recorder');
      o.slicePersisted = !!pref && pref.sliceMs === 900000;
      document.querySelector('[data-view="meetings"]').click();
      await wait(700);
      const slice2 = document.getElementById('mt-slice');
      o.sliceEcho = slice2 ? slice2.value : '';

      // ---- 4) 点「录音」不弹配置窗（核心：一键直启）----
      // 无采集硬件时 getUserMedia 会失败并被吞掉，但绝不能弹配置面板。
      document.querySelector('[data-mt="record-audio"]').click();
      await wait(900);
      o.audioNoDialog = !document.querySelector('.rec-setup') && !document.querySelector('.modal-mask');
      o.audioToastOrDock = !!document.querySelector('#rec-dock') || !(document.getElementById('toast') || {}).hidden;
      // 若真的开录了，收尾停掉，别把会话带进下一步
      if (document.querySelector('#rec-dock [data-rec="stop"]')) {
        document.querySelector('#rec-dock [data-rec="stop"]').click();
        await wait(1200);
      }
      // 清掉可能残留的 toast
      const toastEl = document.getElementById('toast');
      if (toastEl) toastEl.hidden = true;

      // ---- 5) 点「录屏」弹选源面板：有网格、无采集方式、无分片、音源默认勾选 ----
      document.querySelector('[data-mt="record-screen"]').click();
      await wait(900);
      const setup = document.querySelector('.rec-setup');
      o.screenDialog = !!setup;
      if (setup) {
        o.sourceGrid = !!setup.querySelector('#rec-source-grid');
        o.modeCount = setup.querySelectorAll('input[name="rec-mode"]').length;
        o.audioChecks = setup.querySelectorAll('input[name="rec-sys"]:checked, input[name="rec-mic"]:checked').length;
        o.setupSlice = !!setup.querySelector('#rec-slice');
        o.titlePrefilled = /^会议 /.test((setup.querySelector('#rec-title') || {}).value || '');
        const cancel = setup.querySelector('[data-modal="cancel"]');
        if (cancel) { cancel.click(); await wait(300); }
      }
      o.screenClosed = !document.querySelector('.rec-setup');

      // 还原分段偏好与界面
      if (slice2) {
        slice2.value = original;
        slice2.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(200);
      }
      return o;
    })()`);

    console.log(`[REC-SPLIT] 顶栏入口：录音=${out.tbAudio} 录屏=${out.tbScreen} 旧按钮已移除=${out.tbOldGone}`);
    console.log(`[REC-SPLIT] 纪要工具栏：录音=${out.viewAudio} 录屏=${out.viewScreen} 旧按钮已移除=${out.viewOldGone}；分段档位=${out.sliceOptCount}`);
    console.log(`[REC-SPLIT] 分段设置：持久化=${out.slicePersisted} 重绘回显=${out.sliceEcho}`);
    console.log(`[REC-SPLIT] 录音一键直启：无配置窗=${out.audioNoDialog} 有录音动作=${out.audioToastOrDock}`);
    console.log(`[REC-SPLIT] 录屏选源面板：弹出=${out.screenDialog} 画面网格=${out.sourceGrid} 采集方式项=${out.modeCount} 音源勾选=${out.audioChecks} 面板内分片=${out.setupSlice} 取消关闭=${out.screenClosed}`);

    const problems = [];
    if (!out.tbAudio || !out.tbScreen || !out.tbOldGone) problems.push('顶栏录音/录屏两个入口不齐全，或旧「录制」按钮还在');
    if (!/录音/.test(out.tbAudioText) || !/录屏/.test(out.tbScreenText)) problems.push('顶栏按钮文案不对');
    if (!out.viewAudio || !out.viewScreen || !out.viewOldGone) problems.push('纪要工具栏录音/录屏入口不齐全');
    if (!out.sliceInView || out.sliceOptCount !== 4) problems.push(`纪要界面没有分段设置（档位 ${out.sliceOptCount}）`);
    if (!out.slicePersisted) problems.push('分段设置没有写入 tool.recorder 偏好');
    if (out.sliceEcho !== '900000') problems.push(`重绘后分段没有回显，仍是 ${out.sliceEcho}`);
    if (!out.audioNoDialog) problems.push('点「录音」弹出了配置窗——没有做到一键直启');
    if (!out.screenDialog) problems.push('点「录屏」没有弹出选源面板');
    if (!out.sourceGrid) problems.push('录屏面板缺少画面选源网格');
    if (out.modeCount !== 0) problems.push('录屏面板仍有「采集方式」单选');
    if (out.audioChecks !== 2) problems.push(`录屏面板音源默认勾选 ${out.audioChecks} 个（应为 2）`);
    if (out.setupSlice) problems.push('录屏面板里仍有分片时长选项（应已迁到纪要界面）');
    if (!out.titlePrefilled) problems.push('录屏面板会议名没有预填');
    if (!out.screenClosed) problems.push('录屏面板点取消没有关闭');
    if (main.consoleErrors.length) problems.push(`渲染层有未捕获异常：${main.consoleErrors.join(' | ')}`);

    main.close();
    if (problems.length) fail(problems.join('；'), out);
    console.log('[REC-SPLIT] PASS：录音一键直启 / 录屏选源 / 分段设置迁移 均符合要求');
    killChild();
    process.exit(0);
  } catch (e) {
    if (childLog) console.log(`[REC-SPLIT] 主进程日志：\n${childLog.slice(-2000)}`);
    fail(`${e && e.message ? e.message : e}`);
  }
})();
