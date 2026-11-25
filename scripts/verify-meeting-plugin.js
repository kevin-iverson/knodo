'use strict';
/**
 * 「会议纪要 · 插件开关」回归验证。
 *
 * 钉四件事：
 *  1. 老库 / 新库默认是开启，会议视图与录制入口可用；
 *  2. 关闭后主进程不再有 meeting:* handler，渲染层卸载，侧栏进入开启引导；
 *  3. 重新开启后 handler 与视图都恢复；
 *  4. 切换过程中渲染层没有未捕获异常。
 *
 * 用法：node scripts/verify-meeting-plugin.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9522';
const profile = path.join(os.tmpdir(), `knodo-mt-plugin-${Date.now()}`);
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
    console.log(`[MT-PLUGIN] FAIL：${msg}`);
    if (extra) console.log(`[MT-PLUGIN] ${JSON.stringify(extra)}`);
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
      for (let i = 0; i < 50 && !window.KnodoMeetings; i++) await wait(100);
      const info = await window.api.env.getStorageInfo();
      if (!/knodo-mt-plugin-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离：' + JSON.stringify(info));

      const defaultPref = await window.api.features.pref('meeting');
      const mounted = () => !!(window.KnodoMeetings && window.KnodoMeetings.debugState().mounted);
      const buttonsHidden = () => ['btn-record-audio', 'btn-record-screen']
        .every((id) => !document.getElementById(id) || document.getElementById(id).hidden);
      const nav = document.querySelector('.nav-item[data-view="meetings"]');
      nav.click();
      await wait(900);
      const viewOn = !!document.querySelector('.mt-wrap');
      const buttonsOn = !buttonsHidden();

      const offResult = await window.api.features.setPref('meeting', { enabled: false });
      await wait(900);
      const offPref = await window.api.features.pref('meeting');
      const offMounted = mounted();
      const offView = !!document.querySelector('[data-meeting-off]');
      const buttonsOff = buttonsHidden();
      let recBlocked = false;
      try { await window.api.meeting.list(); } catch (e) { recBlocked = true; }

      const onResult = await window.api.features.setPref('meeting', { enabled: true });
      await wait(1200);
      const onPref = await window.api.features.pref('meeting');
      const onMounted = mounted();
      const viewBack = !!document.querySelector('.mt-wrap');
      const buttonsBack = !buttonsHidden();
      let recRestored = false;
      try { recRestored = Array.isArray(await window.api.meeting.list()); } catch (e) { /* 保留 false */ }

      return {
        defaultEnabled: !!(defaultPref && defaultPref.enabled),
        viewOn, buttonsOn,
        offOk: !!(offResult && offResult.ok), offEnabled: !!(offPref && offPref.enabled),
        offMounted, offView, buttonsOff, recBlocked,
        onOk: !!(onResult && onResult.ok), onEnabled: !!(onPref && onPref.enabled),
        onMounted, viewBack, buttonsBack, recRestored,
      };
    })()`);

    console.log(`[MT-PLUGIN] 默认开启=${out.defaultEnabled}，初始视图=${out.viewOn}，录制入口=${out.buttonsOn}`);
    console.log(`[MT-PLUGIN] 关闭后：开关=${out.offEnabled}，挂载=${out.offMounted}，引导页=${out.offView}，IPC 阻断=${out.recBlocked}`);
    console.log(`[MT-PLUGIN] 重开后：开关=${out.onEnabled}，挂载=${out.onMounted}，视图恢复=${out.viewBack}，IPC 恢复=${out.recRestored}`);

    const problems = [];
    if (!out.defaultEnabled) problems.push('会议纪要默认未开启');
    if (!out.viewOn || !out.buttonsOn) problems.push('默认开启时会议视图或录制入口不可用');
    if (!out.offOk || out.offEnabled) problems.push('关闭开关没有生效');
    if (out.offMounted || !out.offView) problems.push('关闭后渲染层没有卸载成引导页');
    if (!out.buttonsOff) problems.push('关闭后录制入口没有隐藏');
    if (!out.recBlocked) problems.push('关闭后 meeting:* handler 仍在');
    if (!out.onOk || !out.onEnabled) problems.push('重新开启没有生效');
    if (!out.onMounted || !out.viewBack) problems.push('重新开启后视图没有恢复');
    if (!out.buttonsBack || !out.recRestored) problems.push('重新开启后录制入口或 IPC 没有恢复');
    if (main.consoleErrors.length) problems.push(`渲染层有未捕获异常：${main.consoleErrors.join(' | ')}`);

    main.close();
    if (problems.length) fail(problems.join('；'), out);
    console.log('[MT-PLUGIN] PASS：会议纪要默认开启、可关闭、可重开，入口与 IPC 同步切换');
    killChild();
    process.exit(0);
  } catch (e) {
    if (childLog) console.log(`[MT-PLUGIN] 主进程日志：\n${childLog.slice(-2000)}`);
    fail(`${e && e.message ? e.message : e}`);
  }
})();
