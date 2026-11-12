'use strict';
/**
 * 侧吸（dock: 'left' / 'right'）端到端验证（开发辅助脚本，非应用运行时依赖）。
 * 用法：npm run verify:dock-side
 *
 * 覆盖：
 *  1) redock(left/right) 后窗口贴住那条边、收起成 30px 竖条；
 *  2) 渲染层切到竖条形态（竖排标题、无横向溢出）；
 *  3) 悬停展开成 320 宽、移开收回 30px；
 *  4) 真实鼠标把普通浮窗拖到屏幕左边缘 → 自动侧吸；
 *  5) 吸边高度记进投影、不越过工作区。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const koffi = require('koffi');

/* 真实鼠标拖动（和 verify-dock 同一套 P/Invoke）：坐标是物理像素 */
const user32 = koffi.load('user32.dll');
user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t v)')(-4);
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const mouseEvent = user32.func('void __stdcall mouse_event(uint32_t f, int dx, int dy, uint32_t d, intptr_t e)');

async function nativeDrag(x1, y1, x2, y2, steps = 14) {
  SetCursorPos(x1 - 40, Math.max(0, y1 - 30)); await sleep(150);
  SetCursorPos(x1, y1); await sleep(200);
  mouseEvent(0x0002, 0, 0, 0, 0); await sleep(80);
  mouseEvent(0x0004, 0, 0, 0, 0); await sleep(250);
  SetCursorPos(x1, y1); await sleep(150);
  mouseEvent(0x0002, 0, 0, 0, 0); await sleep(150);
  for (let i = 1; i <= steps; i += 1) {
    mouseEvent(0x0001, Math.round((x2 - x1) / steps), Math.round((y2 - y1) / steps), 0, 0);
    await sleep(40);
  }
  await sleep(250);
  mouseEvent(0x0004, 0, 0, 0, 0);
  await sleep(300);
}

const root = path.join(__dirname, '..');
const port = '9469';
const profile = path.join(os.tmpdir(), `knodo-dockside-${Date.now()}`);
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
          throw new Error('页面异常：' + JSON.stringify((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
        }
        return r.result && r.result.value;
      }),
    close: () => ws.close(),
  };
}

async function pageOf(pred, tries = 50) {
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
    results.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra).slice(0, 260) });
  };
  try {
    const mainWs = await pageOf((u) => /index\.html/.test(u));
    const main = await connect(mainWs);
    await sleep(1200);

    const setup = await main.evaluate(`(async () => {
      const d = new Date(); const p = (n) => String(n).padStart(2, '0');
      const fmt = (x) => x.getFullYear() + '-' + p(x.getMonth()+1) + '-' + p(x.getDate());
      const y = new Date(); y.setDate(y.getDate() - 1);
      for (let i = 1; i <= 6; i += 1) await window.api.tasks.create({ title: '侧吸测试 ' + i, planEnd: fmt(y) });
      const pins = await window.api.desktop.list();
      return { pins: pins.length };
    })()`);
    ok('数据准备', setup && setup.pins === 0, JSON.stringify(setup));

    /* 1) 普通浮窗 → 左边缘侧吸 */
    const pinned = await main.evaluate(`(async () => {
      const r = await window.api.desktop.pin('unfinished', null, {});
      await window.api.desktop.redock(r.projection.id, 'left');
      const list = await window.api.desktop.list();
      const p = list.find((x) => x.id === r.projection.id);
      return { id: r.projection.id, dock: p.dock, collapsed: p.collapsed };
    })()`);
    ok('redock(left) 后投影变侧吸', pinned && pinned.dock === 'left' && pinned.collapsed === true, JSON.stringify(pinned));

    await sleep(1600);
    const diag = async (id) => main.evaluate(`(async () => {
      const d = await window.api.desktop.diagnostics();
      const list = await window.api.desktop.list();
      const p = list.find((x) => x.id === '${id}');
      const w = d.windows.find((x) => x.id === '${id}');
      return { proj: p && { dock: p.dock, collapsed: p.collapsed, dockPinned: p.dockPinned }, bounds: w && w.bounds, content: w && w.content };
    })()`);

    const d0 = await diag(pinned.id);
    const sideWs = await pageOf((u) => /desktop\.html/.test(u) && u.includes(pinned.id));
    if (!sideWs) throw new Error('找不到侧吸窗页面');
    const side = await connect(sideWs);
    const shape = await side.evaluate(`(async () => {
      await new Promise(r => setTimeout(r, 800));
      const root = document.getElementById('dw');
      const head = document.getElementById('dw-head');
      const title = document.getElementById('dw-title');
      const cs = getComputedStyle(title);
      const r = root.getBoundingClientRect();
      return {
        rootW: Math.round(r.width), rootH: Math.round(r.height),
        innerW: window.innerWidth,
        side: root.classList.contains('is-dock-side'),
        left: root.classList.contains('is-dock-left'),
        right: root.classList.contains('is-dock-right'),
        collapsed: root.classList.contains('is-collapsed'),
        isDock: root.classList.contains('is-dock'),
        writingMode: cs.writingMode,
        headOverflowX: head.scrollWidth - head.clientWidth,
        titleText: title.textContent,
        availLeft: window.screen.availLeft,
        availWidth: window.screen.availWidth,
        availTop: window.screen.availTop,
        availHeight: window.screen.availHeight,
      };
    })()`);
    ok('渲染层切到侧吸竖条形态',
      shape && shape.side && shape.left && !shape.isDock && shape.collapsed, JSON.stringify(shape));
    ok('标题竖排（writing-mode: vertical-rl）', shape && shape.writingMode === 'vertical-rl', shape && shape.writingMode);
    ok('竖条里标题不被横向裁掉', shape && shape.headOverflowX <= 0, shape && `overflowX=${shape.headOverflowX}`);
    ok('窗口贴住工作区左边', d0 && d0.content && Math.abs(d0.content.x - shape.availLeft) <= 1,
      JSON.stringify({ content: d0 && d0.content, availLeft: shape.availLeft }));
    ok('收起宽度是 30px 竖条', shape && shape.rootW <= 40, `rootW=${shape && shape.rootW} / innerW=${shape && shape.innerW} / content=${(d0.content || {}).width}`);
    ok('收起高度沿用内容高度', d0 && d0.content && d0.content.height >= 200 && d0.content.height <= 521,
      `h=${d0.content && d0.content.height} / proj.h=${d0.proj && d0.proj.h}`);

    /* 2) 悬停展开 → 320 宽 */
    await side.evaluate(`(() => { document.dispatchEvent(new MouseEvent('mouseenter')); return true; })()`);
    await sleep(1400);
    const d1 = await diag(pinned.id);
    const open = await side.evaluate(`(async () => {
      const root = document.getElementById('dw');
      const head = document.getElementById('dw-head');
      const r = root.getBoundingClientRect();
      return {
        rootW: Math.round(r.width), collapsed: root.classList.contains('is-collapsed'),
        headOverflowX: head.scrollWidth - head.clientWidth,
        rows: document.querySelectorAll('.dw-row').length,
        listH: Math.round(document.getElementById('dw-list').getBoundingClientRect().height),
      };
    })()`);
    ok('悬停展开成 320 宽', open && !open.collapsed && open.rootW >= 310 && open.rootW <= 330,
      JSON.stringify({ open, content: d1 && d1.content }));
    ok('展开态列表正常渲染', open && open.rows > 0 && open.listH > 40, JSON.stringify(open));
    ok('展开后仍贴住左边', d1 && d1.content && Math.abs(d1.content.x - shape.availLeft) <= 1, JSON.stringify(d1 && d1.content));
    ok('展开态标题栏不溢出', open && open.headOverflowX <= 0, `overflowX=${open && open.headOverflowX}`);

    /* 3) 移开 → 收回 30px */
    await side.evaluate(`(() => { document.dispatchEvent(new MouseEvent('mouseleave')); return true; })()`);
    await sleep(1200);
    const d2 = await diag(pinned.id);
    const closed = await side.evaluate(`(() => {
      const root = document.getElementById('dw');
      return { collapsed: root.classList.contains('is-collapsed'), rootW: Math.round(root.getBoundingClientRect().width) };
    })()`);
    ok('移开后收回成竖条', closed && closed.collapsed && closed.rootW <= 40,
      JSON.stringify({ closed, content: d2 && d2.content }));

    /* 4) 换到右边缘 */
    await main.evaluate(`(async () => { await window.api.desktop.redock('${pinned.id}', 'right'); return true; })()`);
    await sleep(1500);
    const d3 = await diag(pinned.id);
    const rightShape = await side.evaluate(`(() => {
      const root = document.getElementById('dw');
      const cs = getComputedStyle(root);
      return {
        right: root.classList.contains('is-dock-right'),
        left: root.classList.contains('is-dock-left'),
        radius: cs.borderTopLeftRadius + ' ' + cs.borderTopRightRadius,
        availLeft: window.screen.availLeft, availWidth: window.screen.availWidth,
        rootW: Math.round(root.getBoundingClientRect().width),
      };
    })()`);
    ok('切到右边缘：窗口贴住右边',
      d3 && d3.content && Math.abs((d3.content.x + d3.content.width) - (rightShape.availLeft + rightShape.availWidth)) <= 1,
      JSON.stringify({ content: d3 && d3.content, screen: [rightShape.availLeft, rightShape.availWidth] }));
    ok('右吸只留左侧圆角', rightShape && rightShape.right && !rightShape.left
      && rightShape.radius.startsWith('14px 0px'), JSON.stringify(rightShape));

    /* 5) ⋯ 菜单里的吸边位置：切回顶边再回侧吸（不进菜单，直接走同一函数） */
    await main.evaluate(`(async () => { await window.api.desktop.redock('${pinned.id}', 'top'); return true; })()`);
    await sleep(1200);
    const d4 = await diag(pinned.id);
    ok('吸边位置可回切顶条', d4 && d4.proj.dock === 'top' && d4.content && Math.abs(d4.content.y - shape.availTop) <= 1,
      JSON.stringify(d4 && { proj: d4.proj, content: d4.content }));

    /* 6) 真实鼠标：普通浮窗拖到屏幕左边缘 → 自动侧吸 */
    const loose = await main.evaluate(`(async () => {
      const list = await window.api.desktop.list();
      for (const p of list) await window.api.desktop.unpin(p.id);
      const r = await window.api.desktop.pin('unfinished', null, {});
      return { id: r.projection.id };
    })()`);
    await sleep(1600);
    const beforeDrag = await diag(loose.id);
    const scale = (await main.evaluate(`window.screen.width / window.screen.availWidth`)) || 1;
    const dr = beforeDrag && beforeDrag.bounds;
    let autoDocked = null;
    if (dr) {
      const gx = Math.round((dr.x + dr.width / 2) * scale);
      const gy = Math.round((dr.y + 16) * scale);
      await nativeDrag(gx, gy, 2, gy);
      await sleep(1600);
      autoDocked = await diag(loose.id);
      for (let attempt = 0; attempt < 2 && (!autoDocked || autoDocked.proj.dock !== 'left'); attempt += 1) {
        const cur = await diag(loose.id);
        if (!cur || !cur.bounds) break;
        await nativeDrag(
          Math.round((cur.bounds.x + cur.bounds.width / 2) * scale),
          Math.round((cur.bounds.y + 16) * scale),
          2,
          Math.round((cur.bounds.y + 16) * scale),
          20,
        );
        await sleep(1600);
        autoDocked = await diag(loose.id);
      }
    }
    ok('拖到屏幕左边缘后自动侧吸',
      autoDocked && autoDocked.proj.dock === 'left' && autoDocked.proj.collapsed === true,
      JSON.stringify({ before: dr, after: autoDocked && autoDocked.proj, content: autoDocked && autoDocked.content }));
    ok('自动侧吸后贴住左边、宽度 30-40',
      autoDocked && autoDocked.content && Math.abs(autoDocked.content.x - shape.availLeft) <= 1
        && autoDocked.content.width <= 45,
      JSON.stringify(autoDocked && autoDocked.content));

    side.close();
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
