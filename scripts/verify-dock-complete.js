'use strict';
/**
 * 「在桌面浮窗 / 贴顶 dock 里勾完任务，主窗口的任务列表不能把它弄丢」的回归验证。
 *
 * 背景（真实 Bug）：renderer/js/ui.js 的 ui:data-changed 处理器一上来就
 *   if (document.hasFocus() || .modal-mask) return;
 * 浮窗勾选只改了库 + 广播，主窗口因为「有焦点」把整段丢掉 —— 既没把 id 记进
 * 「今日已完成」保留集合，也没重绘。等下一次刷新，「今天」按 status:'active' 查询，
 * 这条已完成任务就被滤掉：用户看到的是「在小窗口勾完，任务界面里这条就没了」。
 *
 * 修法：记账（noteCompletionChange）与焦点无关；重绘只对「浮窗来源 + 主窗不忙碌」执行，
 * 主进程广播时带 source:'desktop'。
 *
 * 断言（全程让主窗口保持焦点，这才是会翻车的场景）：
 *  1. 浮窗里点一下 → 这一行从小窗消失（浮窗只画未完成的行）；
 *  2. 主窗口出现「今日已完成」保留条，api.ui.getTodayDone() 里真的写进了这条 id；
 *  3. 主窗口切到「全部」再切回「今天」（触发重新查询）→ 这条任务还在，且是已完成态。
 *     ← 两条链路互不影响：小窗不留已完成行，主窗必须留。
 *
 * 用法：node scripts/verify-dock-complete.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9497';
const profile = path.join(os.tmpdir(), `knodo-dock-done-${Date.now()}`);
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
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
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
  return {
    send,
    evaluate: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || '渲染层表达式异常');
      }
      return r && r.result ? r.result.value : undefined;
    },
    close: () => ws.close(),
  };
}

(async () => {
  const fail = (msg, extra) => {
    console.log(`[DOCK-DONE] FAIL：${msg}`);
    if (extra) console.log(`[DOCK-DONE] ${JSON.stringify(extra)}`);
    killChild();
    process.exit(1);
  };

  try {
    await listPages();
    const pages = await listPages();
    const mainPage = pages.find((t) => /index\.html/.test(t.url));
    if (!mainPage) throw new Error('没找到主窗口页面');
    const main = await connect(mainPage.webSocketDebuggerUrl);
    await sleep(1200);

    const setup = await main.evaluate(`(async () => {
      const out = {};
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const info = await window.api.env.getStorageInfo();
      if (!/knodo-dock-done-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
      const d = new Date();
      const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const ids = [];
      for (const n of ['浮窗勾选用例A', '浮窗勾选用例B']) {
        const t = await window.api.tasks.create({ title: n, planStart: day, planEnd: day });
        ids.push(t.id);
      }
      out.ids = ids;
      document.querySelector('.nav-item[data-view="today"]').click();
      await wait(900);
      out.rowsBefore = [...document.querySelectorAll('#view .task-item')].map(e => e.dataset.id);
      await window.api.desktop.pin('today', null, {});
      await wait(1200);
      return out;
    })()`);
    if (!setup || !setup.ids) fail('造数失败', setup);

    // 关键前置：主窗口保持焦点（真机上「主窗开着、在浮窗上点一下」就是这个状态）
    // 强制让主窗口在渲染层“有焦点”：这就是真机上「主窗开着、在浮窗上点一下」的状态。
    // CDP 的聚焦模拟比 bringToFront 稳定（后者会被刚创建的浮窗抢走，判定随机成败）。
    await main.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await main.send('Page.bringToFront').catch(() => {});
    await sleep(600);
    const focused = await main.evaluate('document.hasFocus()');
    if (!focused) fail('主窗口没有拿到焦点，复现条件不成立');

    const pages2 = await listPages();
    const dockPage = pages2.find((t) => /desktop\.html/.test(t.url));
    if (!dockPage) fail('浮窗页面没创建（desktop:pin 失败）');
    const dock = await connect(dockPage.webSocketDebuggerUrl);
    await sleep(1500);

    const target = setup.ids[0];
    const clicked = await dock.evaluate(`(async () => {
      const row = document.querySelector('.dw-row[data-id="${target}"]');
      if (!row) return { error: '浮窗里没有这条任务' };
      row.click();
      await new Promise(r => setTimeout(r, 1400));
      const after = document.querySelector('.dw-row[data-id="${target}"]');
      // 新规则：勾掉即从小窗移除（主窗口的「今日已完成」另算，见下面的断言）
      return { gone: !after };
    })()`);
    if (!clicked || clicked.error) fail(`浮窗勾选失败：${clicked && clicked.error}`, clicked);

    await sleep(900);
    const afterClick = await main.evaluate(`(async () => {
      const saved = await window.api.ui.getTodayDone();
      return {
        keepBar: !!document.querySelector('.keep-done-bar'),
        savedIds: (saved && saved.ids) || [],
        rows: [...document.querySelectorAll('#view .task-item')].map(e => ({ id: e.dataset.id, done: e.classList.contains('done') })),
      };
    })()`);

    const afterRefresh = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('.nav-item[data-view="all"]').click();
      await wait(700);
      document.querySelector('.nav-item[data-view="today"]').click();
      await wait(1000);
      return {
        rows: [...document.querySelectorAll('#view .task-item')].map(e => ({ id: e.dataset.id, done: e.classList.contains('done') })),
        keepBar: !!document.querySelector('.keep-done-bar'),
      };
    })()`);

    const rowAfter = (afterRefresh.rows || []).find((r) => String(r.id) === String(target));
    console.log(`[DOCK-DONE] 浮窗点一下 → 主窗保留条=${afterClick.keepBar ? '有' : '无'}；getTodayDone=${JSON.stringify(afterClick.savedIds)}；列表 ${JSON.stringify(afterClick.rows)}`);
    console.log(`[DOCK-DONE] 切视图往返后 → 列表 ${JSON.stringify(afterRefresh.rows)}；保留条=${afterRefresh.keepBar ? '有' : '无'}`);

    const problems = [];
    if (!clicked.gone) problems.push('浮窗里勾掉后这一行还留着（小窗只该显示未完成的）');
    if (!afterClick.keepBar) problems.push('主窗口没出现「今日已完成」保留条 → 记账被丢掉了');
    if (!(afterClick.savedIds || []).map(String).includes(String(target))) problems.push('今日已完成的 settings 里没写进这条 id');
    if (!rowAfter) problems.push('切视图往返后这条任务从「今天」里消失了');
    else if (!rowAfter.done) problems.push('任务还在但没显示为已完成态');

    main.close();
    dock.close();
    if (problems.length) fail(problems.join('；'), { afterClick, afterRefresh, target });
    console.log('[DOCK-DONE] DOCK_DONE_OK');
    killChild();
    process.exit(0);
  } catch (e) {
    console.log('[DOCK-DONE] 检测失败：', (e && e.message) || e);
    if (childLog) console.log('[DOCK-DONE] 窗口日志：', childLog.split('\n').slice(-8).join(' | '));
    killChild();
    process.exit(1);
  }
})();

process.on('exit', killChild);
