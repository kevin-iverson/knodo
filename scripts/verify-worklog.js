'use strict';
/**
 * 工时插件的端到端验收（真实 Electron 窗口 + CDP，沿用 verify:* 既有写法）。
 *
 * 覆盖方案 §十 的验收项：
 *  1. 关闭态：入口常驻标题栏但无插件代码（无 worklog.css、`worklog:*` 未注册）；
 *     点进去是「未启用」引导页（提示去 设置 → 功能插件 开启）；
 *  2. 开启态：样式 / 胶囊 / 视图 / 详情块全部出现；
 *  3. 累积：父任务「含子任务」= 自身 + 子任务，与详情、视图同一个出口；
 *  4. 计时：开始 → 胶囊出现 → 结束（<1 分钟按 FR-02 丢弃）；
 *  5. 关→开→关→开：无重复注册报错（RK-01）。
 *
 * 用法：node scripts/verify-worklog.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9521';
const profile = path.join(os.tmpdir(), `knodo-worklog-${Date.now()}`);
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
process.on('exit', killChild);
process.on('SIGINT', () => { killChild(); process.exit(130); });

async function findPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
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

const SCRIPT = `(async () => {
  const out = { checks: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ck = (name, ok, extra) => out.checks.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
  // CDP 找到页面不等于 preload 已执行完：冷启动（首次建库 / v18 迁移）时会差几百毫秒
  let api = window.api;
  for (let i = 0; i < 60 && !api; i += 1) { await wait(200); api = window.api; }
  if (!api) throw new Error('window.api 未注入（preload 未执行）');
  // preload 在 document_start 就注入，此时 body 可能还没解析完 —— 再等应用初始化完成
  for (let i = 0; i < 120 && (document.readyState !== 'complete' || !window.__appReady); i += 1) {
    await wait(100);
  }

  // 数据隔离：只在临时 userData 里造数
  const info = await api.env.getStorageInfo();
  out.dir = info && info.dir;
  if (!/knodo-worklog-/.test(JSON.stringify(info || {}))) {
    throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
  }

  /* ---------- 1. 关闭态 ---------- */
  const pref0 = await api.features.pref();
  ck('默认关闭', pref0 && pref0.enabled === false, JSON.stringify(pref0));
  // 入口常驻标题栏（统计右侧），但关闭态渲染层没有任何插件代码
  const nav0 = document.querySelector('.titlebar .nav-item[data-view="worklog"]');
  ck('顶栏有工时入口', !!nav0, nav0 ? nav0.textContent.trim() : '');
  ck('入口不标「插件」', !!nav0 && !nav0.querySelector('.nav-tag'));
  const navOrder = Array.from(document.querySelectorAll('.titlebar .tb-nav [data-view], .titlebar .tb-nav > button'))
    .map((b) => b.dataset.view || b.id);
  ck('入口在统计右侧', navOrder.indexOf('worklog') === navOrder.indexOf('stats') + 1, navOrder.join(' > '));
  ck('无 worklog.css', !document.getElementById('wl-css'));
  let threw = false;
  try { await api.worklog.state(); } catch (e) { threw = true; }
  ck('worklog:state 未注册', threw);
  // 点进工时页：应看到居中引导页，且文案指向 设置 → 功能插件
  if (!nav0) {
    const tb = document.querySelector('.tb-nav');
    throw new Error('未找到顶栏工时入口 | tb-nav=' + (tb ? tb.outerHTML.slice(0, 220) : 'none'));
  }
  nav0.click();
  await wait(700);
  const offBox = document.querySelector('#view .wl-off');
  ck('关闭态显示引导页', !!offBox);
  // 注意：这段在模板字符串里，正则/转义里的反斜杠会被吃掉，所以这里不用正则也不用 \n
  const offTxt = offBox
    ? offBox.textContent.split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean).join(' ')
    : '';
  ck('引导页文案正确',
    offTxt.indexOf('设置') >= 0 && offTxt.indexOf('功能插件') >= 0 && offTxt.indexOf('工时记录') >= 0
      && offTxt.indexOf('设置') < offTxt.indexOf('功能插件'),
    offTxt.slice(0, 44));
  ck('引导页标题', document.getElementById('view-title').textContent === '工时', document.getElementById('view-title').textContent);
  document.querySelector('.nav-item[data-view="today"]').click();
  await wait(400);

  /* ---------- 2. 开启 ---------- */
  const on = await api.features.setPref({ enabled: true });
  ck('开启返回 ok', on && on.ok === true, JSON.stringify(on && on.reason));
  await wait(800);
  ck('worklog.css 已注入', !!document.getElementById('wl-css'));
  ck('入口仍在（常驻）', !!document.querySelector('.titlebar .nav-item[data-view="worklog"]'));

  /* ---------- 3. 造数：父 + 子 ---------- */
  const parent = await api.tasks.create({ title: '验收-父任务' });
  const kid = await api.tasks.create({ title: '验收-子任务', parentId: parent.id });
  await api.worklog.manualAdd({ taskId: parent.id, date: '2026-11-12', start: '09:00', end: '10:00', note: '父任务自身' });
  await api.worklog.manualAdd({ taskId: kid.id, date: '2026-11-12', start: '10:00', end: '10:30', note: '子任务' });
  const sum = await api.worklog.task(parent.id);
  ck('本任务 3600s', sum.ownSec === 3600, sum.ownSec);
  ck('含子任务 5400s', sum.aggSec === 5400, sum.aggSec);
  ck('子任务贡献 1 条', sum.children.length === 1, sum.children.length);
  ck('记录列表 1 条', sum.entries.length === 1, sum.entries.length);

  /* ---------- 4. 工时视图 ---------- */
  document.querySelector('.nav-item[data-view="worklog"]').click();
  await wait(900);
  ck('视图标题', document.getElementById('view-title').textContent === '工时', document.getElementById('view-title').textContent);
  ck('表格存在', !!document.querySelector('.wl-table'));
  const totalText = (document.querySelector('.wl-sum-card .wl-v') || {}).textContent || '';
  ck('总工时 1h30m', totalText.trim() === '1h30m', totalText);
  const parentRow = document.querySelector('.wl-table tbody tr[data-wl-row="' + parent.id + '"]');
  ck('父行存在', !!parentRow);
  const cells = parentRow ? Array.from(parentRow.querySelectorAll('td')).map((td) => td.textContent.trim()) : [];
  ck('父行自身/含子任务', cells[1] === '1h' && cells[2] === '1h30m', cells.slice(1, 3).join(' / '));
  ck('每日分布有柱', document.querySelectorAll('.wl-chart-bar').length >= 7, document.querySelectorAll('.wl-chart-bar').length);
  ck('工具栏有补录入口', !!document.querySelector('.wl-toolbar [data-wl="manual"]'));

  /* ---------- 4b. 补录弹窗（详情里的入口已挪到这里） ---------- */
  document.querySelector('.wl-toolbar [data-wl="manual"]').click();
  await wait(800);
  const fm = document.querySelector('.modal-form');
  ck('补录弹窗打开', !!fm);
  const taskSel = fm && fm.querySelector('[data-field="taskId"]');
  ck('补录可选任务', !!taskSel && taskSel.options.length >= 2, taskSel ? taskSel.options.length : 0);
  ck('补录字段齐全', !!fm && !!fm.querySelector('[data-field="date"]')
    && !!fm.querySelector('[data-field="start"]') && !!fm.querySelector('[data-field="end"]'));
  if (fm) fm.querySelector('[data-modal="cancel"]').click();
  await wait(500);
  ck('补录弹窗可取消', !document.querySelector('.modal-form'));

  /* ---------- 5. 任务行内入口（详情抽屉里不再有工时块） ---------- */
  document.querySelector('.nav-item[data-view="all"]').click();
  await wait(900);
  const rowP = document.querySelector('.task-item[data-id="' + parent.id + '"]');
  ck('行内出现 ▶ 计时', !!rowP && !!rowP.querySelector('[data-wl-row-run]'));
  ck('行内出现 ☯ 禅模式', !!rowP && !!rowP.querySelector('[data-wl-row-zen]'));
  ck('未计时时 ■ 隐藏', !!rowP && !!rowP.querySelector('[data-wl-row-stop].is-off'));

  const d = await import('./js/detail.js');
  d.openDetail(parent.id);
  await wait(800);
  ck('详情里没有工时块', !document.querySelector('.wl-detail') && !document.querySelector('[data-wl-slot]'));
  d.closeDetail();
  await wait(400);

  /* ---------- 6. 行内计时 + 顶栏胶囊 ---------- */
  const runBtn = document.querySelector('.task-item[data-id="' + parent.id + '"] [data-wl-row-run]');
  ck('行内按钮可点击', !!runBtn);
  runBtn.click();
  await wait(1300);
  const st = await api.worklog.state();
  ck('点击后开始计时', st && st.mode === 'running' && Number(st.taskId) === Number(parent.id), (st && st.mode) + '/' + (st && st.taskId));
  const runBtn2 = document.querySelector('.task-item[data-id="' + parent.id + '"] [data-wl-row-run]');
  ck('▶ 变成计时读数', !!runBtn2 && !!runBtn2.querySelector('[data-wl-row-time]'), runBtn2 ? runBtn2.textContent.trim() : '');
  ck('计时中显示 ■', !!document.querySelector('.task-item[data-id="' + parent.id + '"] [data-wl-row-stop]:not(.is-off)'));
  const dock = document.getElementById('wl-dock');
  ck('底部计时条可见', dock && !dock.hidden);
  ck('计时条带工时标记', !!dock && dock.textContent.indexOf('工时计时') >= 0,
    dock ? dock.querySelector('.wl-dock-tag').textContent.trim() : '');
  const dockStyle = dock ? getComputedStyle(dock) : null;
  ck('计时条固定在底部', !!dockStyle && dockStyle.position === 'fixed'
    && dock.getBoundingClientRect().bottom > innerHeight - 120,
  dockStyle ? dockStyle.position + '/bottom=' + dockStyle.bottom : '');
  ck('计时条挂在 body 上（不随视图重绘）', !!dock && dock.parentElement === document.body);
  const pz = dock ? dock.querySelector('[data-wl="pause"]') : null;
  ck('底部有暂停按钮', !!pz);
  if (pz) {
    pz.click();
    await wait(800);
    const ps = await api.worklog.state();
    ck('暂停生效', ps && ps.mode === 'paused', ps && ps.mode);
    ck('暂停态按钮变「继续」', pz.textContent.indexOf('继续') >= 0, pz.textContent.trim());
    pz.click();
    await wait(800);
    const rs = await api.worklog.state();
    ck('继续生效', rs && rs.mode === 'running', rs && rs.mode);
  }
  const stopped = await api.worklog.stop();
  ck('短记录被丢弃', stopped && stopped.discarded === true, JSON.stringify(stopped && stopped.sec));
  await wait(500);
  ck('计时条已隐藏', document.getElementById('wl-dock').hidden === true);
  const runBtn3 = document.querySelector('.task-item[data-id="' + parent.id + '"] [data-wl-row-run]');
  ck('行内恢复 ▶', !!runBtn3 && !runBtn3.querySelector('[data-wl-row-time]'), runBtn3 ? runBtn3.textContent.trim() : '');

  /* ---------- 7. 关闭 ---------- */
  // 先停回工时视图：稍后关闭开关时应当「就地换成引导页」，而不是把人踢回任务列表
  document.querySelector('.nav-item[data-view="worklog"]').click();
  await wait(700);
  await api.features.setPref({ enabled: false });
  await wait(700);
  ck('入口保留（常驻标题栏）', !!document.querySelector('.titlebar .nav-item[data-view="worklog"]'));
  ck('样式移除', !document.getElementById('wl-css'));
  threw = false;
  try { await api.worklog.state(); } catch (e) { threw = true; }
  ck('handler 已注销', threw);
  ck('行内按钮已移除', !document.querySelector('[data-wl-row-run]'));
  ck('关闭后就地回引导页', !!document.querySelector('#view .wl-off'));

  /* ---------- 8. 再开启（RK-01） ---------- */
  const again = await api.features.setPref({ enabled: true });
  ck('再次开启成功', again && again.ok === true, again && again.reason);
  await wait(700);
  const snap = await api.worklog.state();
  ck('再次开启后计时可用', snap && snap.mode === 'idle', snap && snap.mode);
  // 停在引导页上把开关打开：应自动换成真视图，不用手动再点一次导航
  ck('再开启后视图恢复', !!document.querySelector('#view .wl-table') && !document.querySelector('#view .wl-off'));

  return out;
})()`;

(async () => {
  const wsUrl = await findPage();
  const cdp = await connect(wsUrl);
  let result;
  try {
    result = await cdp.evaluate(SCRIPT);
  } finally {
    try { cdp.close(); } catch (_) { /* 忽略 */ }
  }
  console.log('数据目录:', result.dir);
  let failed = 0;
  for (const c of result.checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.extra ? `  → ${c.extra}` : ''}`);
    if (!c.ok) failed += 1;
  }
  console.log(failed ? `\nWORKLOG_FAIL ${failed}/${result.checks.length}` : `\nWORKLOG_OK ${result.checks.length}/${result.checks.length}`);
  killChild();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('验收失败：', e && e.message);
  if (childLog) console.error(childLog.slice(-2000));
  killChild();
  process.exit(1);
});
