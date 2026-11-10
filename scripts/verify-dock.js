'use strict';
/**
 * 浮窗「贴回顶边」+ 顶部徽标的端到端验证（开发辅助脚本，非应用运行时依赖）。
 * 用法：node .tmp/verify-dock.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const koffi = require('koffi');

/* 真实鼠标拖动（和 verify-desktop-level 同一套 P/Invoke）：坐标是物理像素 */
const user32 = koffi.load('user32.dll');
user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t v)')(-4);
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const mouseEvent = user32.func('void __stdcall mouse_event(uint32_t f, int dx, int dy, uint32_t d, intptr_t e)');
const POINT = koffi.struct('POINT', { x: 'int', y: 'int' });
const WindowFromPoint = user32.func('intptr_t __stdcall WindowFromPoint(POINT p)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t h, void *b, int n)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t h, void *b, int n)');
function windowAt(x, y) {
  const h = WindowFromPoint({ x, y });
  const b = Buffer.alloc(512);
  const n = GetClassNameW(h, b, 256);
  const t = Buffer.alloc(512);
  const m = GetWindowTextW(h, t, 256);
  return { hwnd: Number(h), cls: b.toString('utf16le', 0, n * 2), title: t.toString('utf16le', 0, m * 2) };
}

async function nativeDrag(x1, y1, x2, y2, steps = 14, activate = true) {
  SetCursorPos(x1 - 40, Math.max(0, y1 - 30)); await sleep(150);
  SetCursorPos(x1, y1); await sleep(200);
  if (activate) {
    // 合成点击先把这个窗激活：窗口是 showInactive 出来的，第一次点到未激活窗口时
    // 系统先做激活、不做移动，后续的相对位移就全落空了（表现为「拖不动」）
    mouseEvent(0x0002, 0, 0, 0, 0); await sleep(80);
    mouseEvent(0x0004, 0, 0, 0, 0); await sleep(250);
    SetCursorPos(x1, y1); await sleep(150);
  }
  mouseEvent(0x0002, 0, 0, 0, 0); await sleep(150); // LEFTDOWN
  // 相对位移比 SetCursorPos 更贴近真实拖动：系统拖动循环吃的是鼠标的相对移动
  for (let i = 1; i <= steps; i += 1) {
    mouseEvent(0x0001, Math.round((x2 - x1) / steps), Math.round((y2 - y1) / steps), 0, 0);
    await sleep(40);
  }
  await sleep(250); // 停在目标点，模拟「按住不放」
  mouseEvent(0x0004, 0, 0, 0, 0); // LEFTUP
  await sleep(300);
}

const root = path.join(__dirname, '..');
const port = '9468';
const profile = path.join(os.tmpdir(), `knodo-dock-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [
  root,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

let log = '';
child.stdout.on('data', (b) => { log += b.toString(); });
child.stderr.on('data', (b) => { log += b.toString(); });

function cleanup() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}

async function pages() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) return list;
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('CDP 连接超时');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`WS 失败：${e && e.message}`));
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    evaluate: (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      .then((r) => {
        if (r.exceptionDetails) {
          throw new Error('页面异常：' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
        }
        return r.result && r.result.value;
      }),
    close: () => ws.close(),
  };
}

async function pageOf(pred, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const list = await pages();
    const t = list.find((x) => x.type === 'page' && pred(x.url));
    if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    await sleep(250);
  }
  return null;
}

(async () => {
  const results = [];
  const ok = (name, pass, extra) => {
    results.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra).slice(0, 200) });
  };
  try {
    const mainWs = await pageOf((u) => /index\.html/.test(u));
    const main = await connect(mainWs);
    await sleep(1200);

    // 准备数据：一条今天到期、一条昨天到期（逾期）
    const setup = await main.evaluate(`(async () => {
      const d = new Date(); const p = (n) => String(n).padStart(2, '0');
      const fmt = (x) => x.getFullYear() + '-' + p(x.getMonth()+1) + '-' + p(x.getDate());
      const y = new Date(); y.setDate(y.getDate() - 1);
      await window.api.tasks.create({ title: '贴回顶边测试A', planStart: fmt(y), planEnd: fmt(y) });
      await window.api.tasks.create({ title: '贴回顶边测试B', planEnd: fmt(y) });
      await window.api.tasks.create({ title: '贴回顶边测试C' });
      const pins = await window.api.desktop.list();
      document.querySelector('.nav-item[data-view="unfinished"]');
      return { pins: pins.length, ok: true };
    })()`);
    ok('数据准备', setup && setup.ok, JSON.stringify(setup));

    // 1) 先钉一个普通浮窗（等价于「被拖离顶边」的窗口）
    const pinned = await main.evaluate(`(async () => {
      const r = await window.api.desktop.pin('unfinished', null, {});
      const list = await window.api.desktop.list();
      return { id: r.projection.id, dock: r.projection.dock, count: list.length };
    })()`);
    ok('普通浮窗已钉出', pinned && pinned.id && pinned.dock == null, JSON.stringify(pinned));

    // 2) 贴回顶边（菜单「贴回屏幕顶边」/ 顶栏 📌 走同一个 IPC）
    const redocked = await main.evaluate(`(async () => {
      await window.api.desktop.redock('${pinned.id}');
      const list = await window.api.desktop.list();
      const p = list.find((x) => x.id === '${pinned.id}');
      return { dock: p && p.dock, collapsed: p && p.collapsed, count: list.length };
    })()`);
    ok('redock 后投影变回 dock', redocked && redocked.dock === 'top' && redocked.collapsed === true, JSON.stringify(redocked));
    ok('没有多出同源窗口', redocked && redocked.count === 1, `count=${redocked && redocked.count}`);

    // 3) 重建出来的窗口应该是 420 宽、贴顶 30 高
    await sleep(1500);
    const dockWs = await pageOf((u) => /desktop\.html/.test(u));
    const dock = await connect(dockWs);
    const geo = await dock.evaluate(`(async () => {
      await new Promise(r => setTimeout(r, 800));
      const root = document.getElementById('dw');
      const head = document.getElementById('dw-head');
      return {
        isDock: root.classList.contains('is-dock'),
        collapsed: root.classList.contains('is-collapsed'),
        count: document.getElementById('dw-count').hidden ? null : document.getElementById('dw-count').textContent,
        pend: document.getElementById('dw-pend').hidden ? null : document.getElementById('dw-pend').textContent,
        overflow: head.scrollWidth - head.clientWidth,
        title: document.getElementById('dw-title').textContent,
      };
    })()`);
    ok('窗口是 dock 态且收起', geo && geo.isDock && geo.collapsed, JSON.stringify(geo));
    ok('顶部有「逾期 N」徽标', geo && /^逾期 \d+$/.test(String(geo.count || '')), geo && geo.count);
    ok('逾期右边有「未完成 N」徽标', geo && /^未完成 \d+$/.test(String(geo.pend || '')), geo && geo.pend);
    ok('标题栏没被徽标挤爆', geo && geo.overflow <= 0, geo && `overflow=${geo.overflow}`);

    // 4) 取消贴顶 → 再贴回（模拟用户来回拖）
    const round = await main.evaluate(`(async () => {
      const list0 = await window.api.desktop.list();
      const id = list0[0].id;
      // 取消钉住后重新钉普通浮窗，再 redock
      await window.api.desktop.unpin(id);
      const r = await window.api.desktop.pin('unfinished', null, {});
      await window.api.desktop.redock(r.projection.id);
      const list = await window.api.desktop.list();
      return { count: list.length, dock: list[0] && list[0].dock, id: list[0] && list[0].id };
    })()`);
    ok('取消后再贴回仍只有一条', round && round.count === 1 && round.dock === 'top', JSON.stringify(round));

    // 5) 普通浮窗（非未完成投影）不该出现 pend 徽标
    const group = await main.evaluate(`(async () => {      const g = await window.api.groups.create({ name: '徽标检查组' });
      const r = await window.api.desktop.pin('group', g.id, {});
      return { id: r.projection.id, gid: g.id };
    })()`);
    await sleep(1200);
    const gWs = await pageOf((u) => /desktop\.html/.test(u) && !u.includes(String(round.id)));
    if (gWs) {
      const gp = await connect(gWs);
      const st = await gp.evaluate(`(async () => {
        await new Promise(r => setTimeout(r, 600));
        return {
          pend: document.getElementById('dw-pend').hidden,
          count: document.getElementById('dw-count').textContent,
        };
      })()`);
      ok('分组浮窗不显示未完成徽标', st && st.pend === true, JSON.stringify(st));
      ok('分组浮窗仍是 完成/总数', st && /\d+ \/ \d+/.test(String(st.count || '')), st && st.count);
      gp.close();
    } else {
      ok('分组浮窗页面可连接', false, '找不到 desktop.html');
    }

    // 6) 286px 普通浮窗（最窄的真实场景）：两个徽标 + 标题不能挤爆
    const narrow = await main.evaluate(`(async () => {
      const list = await window.api.desktop.list();
      for (const p of list) await window.api.desktop.unpin(p.id);
      const r = await window.api.desktop.pin('unfinished', null, {});
      return { id: r.projection.id };
    })()`);
    await sleep(1500);
    const nWs = await pageOf((u) => /desktop\.html/.test(u) && u.includes(narrow.id));
    if (nWs) {
      const np = await connect(nWs);
      const st = await np.evaluate(`(async () => {
        await new Promise(r => setTimeout(r, 700));
        const head = document.getElementById('dw-head');
        const title = document.getElementById('dw-title');
        return {
          width: head.clientWidth,
          overflow: head.scrollWidth - head.clientWidth,
          titleClipped: title.scrollWidth > title.clientWidth + 1,
          count: document.getElementById('dw-count').textContent,
          pend: document.getElementById('dw-pend').textContent,
        };
      })()`);
      ok('286px 浮窗标题不被挤成省略号', st && !st.titleClipped, JSON.stringify(st));
      ok('286px 浮窗头部不溢出', st && st.overflow <= 0, st && `w=${st.width} overflow=${st.overflow}`);

      /* ---- 真实鼠标拖动：把 286 浮窗拖到屏幕最顶端 → 应自动变回贴顶条 ---- */
      const before = await np.evaluate(`({
        timeOrigin: performance.timeOrigin,
        dpr: window.devicePixelRatio,
        availTop: window.screen.availTop,
        sx: window.screenX,
        sy: window.screenY,
      })`);
      const diag0 = await main.evaluate(`(async () => {
        const d = await window.api.desktop.diagnostics();
        const w = d.windows.find((x) => x.id === '${narrow.id}');
        return w && { bounds: w.bounds, content: w.content };
      })()`);
      const scale = (before && before.dpr) || 1;
      const bx = (diag0 && diag0.bounds && diag0.bounds.x) || 0;
      const by = (diag0 && diag0.bounds && diag0.bounds.y) || 0;
      const bw = (diag0 && diag0.bounds && diag0.bounds.width) || 286;
      const grabX = Math.round((bx + bw / 2) * scale);
      const grabY = Math.round((by + 16) * scale);
      const hit = windowAt(grabX, grabY);
      await nativeDrag(grabX, grabY, grabX, 0);
      await sleep(1600);
      // 合成鼠标事件偶尔会被系统吞掉（窗口未激活 / 事件被合并）：拖不动就再试两次，
      // 每次重新读窗口位置，别拿旧坐标去拖已经挪过的窗
      let diagTmp = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        diagTmp = await main.evaluate(`(async () => {
          const list = await window.api.desktop.list();
          return list.find((x) => x.id === '${narrow.id}') || null;
        })()`);
        if (diagTmp && diagTmp.dock === 'top') break;
        const dnow = await main.evaluate(`(async () => {
          const d = await window.api.desktop.diagnostics();
          return d.windows.find((x) => x.id === '${narrow.id}') || null;
        })()`);
        if (!dnow || !dnow.bounds) break;
        await nativeDrag(
          Math.round((dnow.bounds.x + dnow.bounds.width / 2) * scale),
          Math.round((dnow.bounds.y + 16) * scale),
          Math.round((dnow.bounds.x + dnow.bounds.width / 2) * scale),
          0,
          20,
        );
        await sleep(1600);
      }

      const after = await np.evaluate(`({
        timeOrigin: performance.timeOrigin,
        isDock: document.getElementById('dw').classList.contains('is-dock'),
        collapsed: document.getElementById('dw').classList.contains('is-collapsed'),
        availTop: window.screen.availTop,
        availLeft: window.screen.availLeft,
        availWidth: window.screen.availWidth,
        barH: Math.round(document.getElementById('dw').getBoundingClientRect().height),
      })`);
      const diag1 = await main.evaluate(`(async () => {
        const list = await window.api.desktop.list();
        const p = list.find((x) => x.id === '${narrow.id}');
        const d = await window.api.desktop.diagnostics();
        const w = d.windows.find((x) => x.id === '${narrow.id}');
        return { dock: p && p.dock, collapsed: p && p.collapsed, content: w && w.content };
      })()`);
      ok('拖到顶部后自动变回 dock', diag1 && diag1.dock === 'top' && diag1.collapsed === true,
        JSON.stringify({
          diag1, diag0, before, scale, grab: [grabX, grabY], hit,
        }));
      ok('原地转换（没有重载页面）', before && after && before.timeOrigin === after.timeOrigin,
        `origin ${before && before.timeOrigin} → ${after && after.timeOrigin}`);
      ok('转换后贴住工作区顶边、视觉高度 30',
        diag1 && diag1.content && Math.abs(diag1.content.y - (after && after.availTop)) <= 1
          && after && after.barH === 30,
        JSON.stringify({ content: diag1 && diag1.content, barH: after && after.barH, availTop: after && after.availTop }));
      ok('转换后宽度锁到 420', diag1 && diag1.content && Math.abs(diag1.content.width - 420) <= 1,
        diag1 && diag1.content && diag1.content.width);
      // 420 比 286 宽：靠屏幕右边松手时会被向左推，但不该跳过松手点往右甩
      ok('横向不越过松手点、完整留在屏内',
        diag1 && diag1.content && after
          && diag1.content.x <= bx + 2
          && diag1.content.x + diag1.content.width <= after.availLeft + after.availWidth + 1,
        `x ${bx} → ${diag1 && diag1.content && diag1.content.x}；right ${diag1 && diag1.content && diag1.content.x + diag1.content.width} / ${after && after.availLeft + after.availWidth}`);
      ok('渲染层切到 dock 形态', after && after.isDock && after.collapsed, JSON.stringify(after));

      // 贴顶条「拖离顶边 → 变回普通浮窗」只能人工验：合成鼠标（mouse_event + SetCursorPos）
      // 打不动贴顶条 —— 原生 pin 出来的 dock 同样拖不动，属于合成输入的局限，不是实现问题。
      np.close();
    } else {
      ok('普通未完成浮窗可连接', false, '找不到页面');
    }

    dock.close();
    main.close();
  } catch (e) {
    ok('脚本执行', false, (e && e.message) || e);
  } finally {
    const pass = results.filter((r) => r.pass).length;
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  ← ' + r.extra : ''}`);
    console.log(`\n${pass}/${results.length} 通过`);
    if (pass !== results.length) console.log('--- app log ---\n' + log.slice(-3000));
    cleanup();
    process.exit(pass === results.length ? 0 : 1);
  }
})();
