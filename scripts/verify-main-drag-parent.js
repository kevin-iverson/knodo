'use strict';
/**
 * 主窗口「标题拖拽改父级 / 脱离成独立任务」+ 展开箭头放大的端对端验收。
 *
 * 两条需求：
 *  1. 子任务可拖到其他父任务下，或拖到列表空白脱离成独立任务；⠿ 手柄仍做同级排序。
 *  2. 父任务的展开箭头从 20px 放大到 26px（点击热区更大）。
 *
 * 交互范式（与浮窗一致）：拖动标题 .task-title-text = 改父级，落行=挂为其子任务，
 * 落空白=parentId=null，落自己/后代=禁止；拖动 ⠿ .drag-handle = 同级排序。
 * HTML5 DnD 事件序列：pointerdown 解锁 draggable → dragstart → dragover → drop → dragend。
 *
 * 用法：node scripts/verify-main-drag-parent.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9543';
const profile = path.join(os.tmpdir(), `knodo-main-drag-${Date.now()}`);
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

async function listPages() {
  for (let i = 0; i < 100; i += 1) {
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
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
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

(async () => {
  const checks = [];
  const ck = (name, ok, extra) => checks.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
  const fail = (msg, extra) => {
    console.log(`[MAIN-DRAG] FAIL：${msg}`);
    if (extra) console.log(`[MAIN-DRAG] ${JSON.stringify(extra)}`);
    if (childLog) console.log('[MAIN-DRAG] 窗口日志：', childLog.split('\n').slice(-10).join(' | '));
    killChild();
    process.exit(1);
  };

  try {
    await listPages();
    const pages = await listPages();
    const mainPage = pages.find((t) => /index\.html/.test(t.url));
    if (!mainPage) fail('没找到主窗口页面');
    const main = await connect(mainPage.webSocketDebuggerUrl);
    await sleep(1300);

    // 造数：父A（带子 kid）+ 父B + 一个独立任务 C（做排序用）。切到「全部任务」视图。
    const setup = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const info = await window.api.env.getStorageInfo();
      if (!/knodo-main-drag-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离：' + JSON.stringify(info));
      for (let i = 0; i < 80 && !window.__appReady; i += 1) await wait(100);
      const a = await window.api.tasks.create({ title: '主窗拖拽-A父' });
      const b = await window.api.tasks.create({ title: '主窗拖拽-B父' });
      const kid = await window.api.tasks.create({ title: '主窗拖拽-子任务', parentId: a.id });
      const c = await window.api.tasks.create({ title: '主窗拖拽-C独立' });
      document.querySelector('.nav-item[data-view="all"]').click();
      await wait(900);
      return { a: a.id, b: b.id, kid: kid.id, c: c.id };
    })()`);
    if (!setup || !setup.a) fail('造数失败', setup);
    await sleep(500);
    // 展开父 A 让 kid 现身（用已在 Node 侧的 id，避免跨模板拼接）
    await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const arrow = document.querySelector('.task-item[data-id="${setup.a}"] [data-act="toggle-expand"]');
      if (arrow) arrow.click();
      await wait(500);
      return true;
    })()`);

    // 注入拖拽工具：把标题拖拽模拟封装成可复用函数
    await main.evaluate(`(function () {
      window.__fireDrag = function (fromRow, toRowOrNull, handleSel) {
        const handleSel2 = handleSel || '.task-title-text';
        const handle = fromRow.querySelector(handleSel2);
        const dt = new DataTransfer();
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        fromRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const land = toRowOrNull || document.getElementById('view');
        land.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        land.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        fromRow.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      };
      return true;
    })()`);

    /* ---- A. 箭头尺寸 26×26 ---- */
    const arrowSize = await main.evaluate(`(function () {
      const el = document.querySelector('.task-item[data-id="${setup.a}"] .task-expand');
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), fs: getComputedStyle(el).fontSize };
    })()`);
    ck('展开箭头宽 26px', arrowSize.w === 26, JSON.stringify(arrowSize));
    ck('展开箭头高 26px', arrowSize.h === 26, JSON.stringify(arrowSize));

    /* ---- B. 标题拖拽：把 kid 从 A 下拖到 B 下 ---- */
    const b1 = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      // 重新展开 A（上一轮可能收起）
      let ar = document.querySelector('.task-item[data-id="${setup.a}"] [data-act="toggle-expand"]');
      if (ar && ar.textContent.trim() === '▸') { ar.click(); await wait(400); }
      const kidRow = document.querySelector('.task-item[data-id="${setup.kid}"]');
      const bRow = document.querySelector('.task-item[data-id="${setup.b}"]');
      if (!kidRow || !bRow) return { err: 'kid 或 B 行不存在' };
      window.__fireDrag(kidRow, bRow, '.task-title-text');
      await wait(1200);
      const saved = await window.api.tasks.get(${setup.kid});
      return { parent: saved && saved.parent_id };
    })()`);
    ck('标题拖拽：子任务挂到另一个父任务下', Number(b1.parent) === Number(setup.b), JSON.stringify(b1));

    /* ---- C. 落点非法态：拖 A 到它自己的后代 kid 上 ---- */
    // kid 现在是 B 的子任务，把 B 拖到 kid 上也应禁止（kid 是 B 的后代）
    const c1 = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      let br = document.querySelector('.task-item[data-id="${setup.b}"] [data-act="toggle-expand"]');
      if (br && br.textContent.trim() === '▸') { br.click(); await wait(400); }
      const bRow = document.querySelector('.task-item[data-id="${setup.b}"]');
      const kidRow = document.querySelector('.task-item[data-id="${setup.kid}"]');
      if (!bRow || !kidRow) return { err: 'B 或 kid 行不存在' };
      const handle = bRow.querySelector('.task-title-text');
      const dt = new DataTransfer();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      bRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      kidRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const forbidden = kidRow.classList.contains('drag-forbidden');
      kidRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      bRow.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await wait(900);
      const saved = await window.api.tasks.get(${setup.b});
      return { forbidden, parent: saved && saved.parent_id };
    })()`);
    ck('拖父任务到后代显示禁止态', c1.forbidden === true, JSON.stringify(c1));
    ck('防环：父任务未被挂到后代下', c1.parent == null || c1.parent !== Number(setup.kid), JSON.stringify(c1));

    /* ---- D. 落列表空白：kid 脱离成独立任务 ---- */
    const d1 = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const kidRow = document.querySelector('.task-item[data-id="${setup.kid}"]');
      if (!kidRow) return { err: 'kid 行不存在' };
      window.__fireDrag(kidRow, null, '.task-title-text');
      await wait(1200);
      const saved = await window.api.tasks.get(${setup.kid});
      return { parent: saved && saved.parent_id };
    })()`);
    ck('落空白：子任务脱离成独立任务', d1.parent == null, JSON.stringify(d1));

    /* ---- E. ⠿ 手柄排序仍工作（两种手势并存，未被改父级破坏） ---- */
    const e1 = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('.nav-item[data-view="all"]').click();
      await wait(700);
      const aRow = document.querySelector('.task-item[data-id="${setup.a}"]');
      const cRow = document.querySelector('.task-item[data-id="${setup.c}"]');
      if (!aRow || !cRow) return { err: 'A/C 行不存在' };
      const before = [...document.querySelectorAll('.task-list > .task-item:not(.is-subtask)')].map(e => e.dataset.id);
      window.__fireDrag(aRow, cRow, '.drag-handle');
      await wait(1000);
      const after = [...document.querySelectorAll('.task-list > .task-item:not(.is-subtask)')].map(e => e.dataset.id);
      return { before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
    })()`);
    ck('⠿ 手柄排序仍工作', e1.changed === true, JSON.stringify(e1));

    await main.close();

    let failed = 0;
    for (const c2 of checks) {
      console.log(`  ${c2.ok ? '✓' : '✗'} ${c2.name}${c2.extra ? `  → ${c2.extra}` : ''}`);
      if (!c2.ok) failed += 1;
    }
    console.log(failed
      ? `\n[MAIN-DRAG] MAIN_DRAG_PARENT_FAIL ${failed}/${checks.length}`
      : `\n[MAIN-DRAG] MAIN_DRAG_PARENT_OK ${checks.length}/${checks.length}`);
    killChild();
    process.exit(failed ? 1 : 0);
  } catch (e) {
    fail('检测异常：' + ((e && e.message) || e));
  }
})();
