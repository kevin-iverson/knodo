'use strict';
/**
 * 「贴桌面」档端到端验证（开发辅助脚本，非应用运行时依赖）。
 *
 * 用法：node scripts/verify-desktop-level.js [port]
 *
 * 覆盖这一档最容易「看起来选了但没生效」的六个环节：
 *  1. 切到 desktop 档后，窗口是否真的挂进了桌面层（Progman / WorkerW），且在图标视图之上
 *     —— 挂不上就是「选了没反应」；
 *  2. 「显示桌面」（Win+D）之后浮窗是否仍露在桌面上 —— 这是「贴桌面」与「不置前」的分水岭；
 *  3. 鼠标能否落到浮窗上（命中测试 = 系统投递点击的依据）；
 *  4. 勾一行任务能否真的勾掉、标题栏能否拖拽 —— 原有交互不能被这档破坏；
 *  5. 回到工作桌面后是否被普通窗口盖住；
 *  6. 切回 always 档是否摘出桌面层并重新置顶。
 *
 * 全程跑在独立的临时 userData 里，不影响本机已有数据；脚本会短暂切一次「显示桌面」
 * 并在结束时还原，再强制结束自己拉起的进程树。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const koffi = require('koffi');

const root = path.join(__dirname, '..');
const port = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '9455';
const profile = path.join(root, '.tmp', `verify-desktop-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ Win32 ------------------------------ */
const user32 = koffi.load('user32.dll');
user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t v)')(-4);
const RECT = koffi.struct('RECT', {
  left: 'int', top: 'int', right: 'int', bottom: 'int',
});
const POINT = koffi.struct('POINT', { x: 'int', y: 'int' });
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t h, _Out_ RECT *r)');
const WindowFromPoint = user32.func('intptr_t __stdcall WindowFromPoint(POINT p)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t h, void *b, int n)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const mouseEvent = user32.func('void __stdcall mouse_event(uint32_t f, int dx, int dy, uint32_t d, intptr_t e)');
const keybdEvent = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, intptr_t extra)');

const clsOf = (h) => {
  const b = Buffer.alloc(256);
  const n = GetClassNameW(h, b, 128);
  return b.toString('utf16le', 0, n * 2);
};
const rectOf = (h) => { const r = {}; GetWindowRect(h, r); return r; };
const winAt = (x, y) => {
  const h = WindowFromPoint({ x, y });
  return { h, hwnd: `0x${h.toString(16)}`, cls: clsOf(h) };
};
/** 与用户按 Win+D 等价（keybd_event 走的就是真实键盘通道） */
const showDesktop = () => {
  keybdEvent(0x5b, 0, 0, 0); keybdEvent(0x44, 0, 0, 0);
  keybdEvent(0x44, 0, 2, 0); keybdEvent(0x5b, 0, 2, 0);
};

async function click(x, y) {
  // 必须先「走」进窗口：Chromium 要先收到窗口内的 mousemove 才会把这次点击算到元素上
  // （真实鼠标天然满足；直接闪现到点位再按下，鼠标事件会被当成激活点击吞掉）
  SetCursorPos(x - 60, y - 60); await sleep(200);
  SetCursorPos(x - 20, y - 10); await sleep(120);
  SetCursorPos(x, y); await sleep(250);
  mouseEvent(0x0002, 0, 0, 0, 0); await sleep(90); // LEFTDOWN
  mouseEvent(0x0004, 0, 0, 0, 0); await sleep(700); // LEFTUP
}

async function drag(x, y, dx, dy) {
  SetCursorPos(x, y); await sleep(200);
  mouseEvent(0x0002, 0, 0, 0, 0);
  for (let i = 1; i <= 10; i += 1) {
    SetCursorPos(x + Math.round((dx * i) / 10), y + Math.round((dy * i) / 10));
    await sleep(35);
  }
  await sleep(120);
  mouseEvent(0x0004, 0, 0, 0, 0); await sleep(700);
}

/* ------------------------------ CDP ------------------------------ */
async function targets() {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
}

async function evalOn(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const out = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP 超时')), 20000);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result.result.value);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
  ws.close();
  return out;
}

/* ------------------------------ 主流程 ------------------------------ */
let appPid = null;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  const app = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
    { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: 'ignore' });
  appPid = app.pid;

  let list = [];
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try { list = await targets(); } catch (e) { list = []; }
    if (list.find((t) => /index\.html/.test(t.url))) break;
  }
  const main = list.find((t) => /index\.html/.test(t.url));
  if (!main) throw new Error('主窗口未就绪');
  await sleep(1200);

  const id = await evalOn(main, `(async () => {
    const p = await window.api.desktop.pin('today');
    await window.api.desktop.addTask(p.projection.id, '任务甲');
    await window.api.desktop.addTask(p.projection.id, '任务乙');
    await window.api.desktop.addTask(p.projection.id, '任务丙');
    return p.projection.id;
  })()`);

  let float = null;
  for (let i = 0; i < 20 && !float; i += 1) {
    await sleep(400);
    float = (await targets()).find((t) => /desktop\.html/.test(t.url));
  }
  if (!float) throw new Error('浮窗 target 未出现');
  void float;

  const diag = async () => JSON.parse(await evalOn(main, 'window.api.desktop.diagnostics().then(v=>JSON.stringify(v))'));
  const counts = async () => JSON.parse(await evalOn(main, `window.api.desktop.get('${id}').then(v=>JSON.stringify(v.counts))`));

  // 1) 切到贴桌面
  await evalOn(main, `window.api.desktop.update('${id}', { pinMode: 'desktop' })`);
  await sleep(2000);
  let w = (await diag()).windows.find((x) => x.id === id) || {};
  check('贴桌面：挂进桌面层', w.attached === true, `parent=${w.parentClass}`);
  check('贴桌面：在图标视图之上', w.aboveIcons === true);
  check('贴桌面：没有 topmost 标记', w.topmost === false);

  const hwnd = Number(w.hwnd);
  let r = rectOf(hwnd);

  // 2) 显示桌面
  showDesktop();
  await sleep(3500);
  w = (await diag()).windows.find((x) => x.id === id) || {};
  r = rectOf(hwnd);
  const hit = winAt(Math.round((r.left + r.right) / 2), r.top + 30);
  check('显示桌面：浮窗仍在桌面层', w.attached === true, `parent=${w.parentClass}`);
  check('显示桌面：浮窗没被桌面盖住', hit.hwnd === `0x${hwnd.toString(16)}`, `命中=${hit.cls}`);

  // 3) 勾选一行
  // 第一下点击可能只是把窗口激活（真实鼠标不会，注入的会），所以给一次重试余量
  const before = await counts();
  let after = before;
  for (let i = 0; i < 3 && after.done === before.done; i += 1) {
    await click(r.left + Math.round(18 * 1.25), r.top + Math.round(59 * 1.25));
    after = await counts();
  }
  check('交互：点一行能勾掉任务', after.done === before.done + 1, `${before.done} → ${after.done}`);

  // 4) 拖拽
  const box1 = rectOf(hwnd);
  await drag(Math.round((box1.left + box1.right) / 2), box1.top + 18, 80, 60);
  const box2 = rectOf(hwnd);
  check('交互：标题栏可拖拽', box2.left !== box1.left || box2.top !== box1.top,
    `delta=${box2.left - box1.left},${box2.top - box1.top}`);

  // 5) 先把浮窗拖到主窗口范围内（此刻桌面可见，还能拖），再回到工作桌面验证会被盖住
  const box3a = rectOf(hwnd);
  const cx3 = Math.round((box3a.left + box3a.right) / 2);
  await drag(cx3, box3a.top + 18, 760 - cx3, 560 - box3a.top);
  showDesktop();
  await sleep(3200);
  const box3 = rectOf(hwnd);
  const covered = winAt(Math.round((box3.left + box3.right) / 2), Math.round((box3.top + box3.bottom) / 2));
  check('回到桌面：被普通窗口盖住', covered.hwnd !== `0x${hwnd.toString(16)}`, `命中=${covered.cls} box3=${JSON.stringify(box3)}`);

  // 6) 切回始终置顶
  await evalOn(main, `window.api.desktop.update('${id}', { pinMode: 'always' })`);
  await sleep(1000);
  w = (await diag()).windows.find((x) => x.id === id) || {};
  const box4 = rectOf(hwnd);
  const top = winAt(Math.round((box4.left + box4.right) / 2), Math.round((box4.top + box4.bottom) / 2));
  check('切回始终置顶：摘出桌面层', w.attached === false);
  check('切回始终置顶：重新浮到最前', w.topmost === true && top.hwnd === `0x${hwnd.toString(16)}`, `命中=${top.cls}`);

  const failed = results.filter((x) => !x.ok).length;
  console.log(failed
    ? `[RESULT] FAIL ${failed}/${results.length}`
    : `[RESULT] PASS ${results.length}/${results.length}`);
  return failed === 0;
}

main()
  .then((ok) => { process.exitCode = ok ? 0 : 1; })
  .catch((e) => { console.error('[RESULT] FAIL', e && e.message); process.exitCode = 1; })
  .finally(() => {
    if (appPid) {
      try { execSync(`taskkill /F /T /PID ${appPid}`, { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
    }
    setTimeout(() => {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 占用中留给系统 */ }
      process.exit(process.exitCode || 0);
    }, 800);
  });
