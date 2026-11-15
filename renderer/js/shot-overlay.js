'use strict';
/**
 * 框选覆盖层 · 交互状态机
 *
 * ┌ idle ──pointerdown（空白处）──▶ new ──pointerup（够大）──▶ selected
 * │                                  │                          │  │
 * │                                  └ pointerup（太小）→ 还原 / 取消  │
 * │                                                             │  │
 * │   selected ──pointerdown（内部）──▶ move ──pointerup──▶ selected
 * │   selected ──pointerdown（手柄）──▶ resize ──pointerup──▶ selected
 * │                                                             │
 * └──────────────────── Enter / 双击 ──▶ done ◀─────────────────┘
 *
 * 初始框选与二次调整**共用一套 rect 与一套指针捕获**，靠 `S.mode` 分流：
 *  - 只有 pointerdown 那一刻判断 `e.target`（手柄 / 内部 / 空白），之后一律用捕获的 drag 描述，
 *    这样 pointermove 里不可能"又回到框选阶段"；
 *  - `new` 阶段换用真实的 mousemove 计算锚点反向拖；`move` 用位移；`resize` 用边的绝对坐标；
 *  - 松手时把 mode 归位到 selected —— 于是「框一次 → 再拖角」和「拖角 → 再拖角」走的是同一条路径。
 *
 * 误操作保护：
 *  - 已有选区时在空白处点一下（没拖动）→ 还原旧选区，不退出；
 *  - 调整过程中的 Esc → 退回调整前的选区，不退出；
 *  - 其余 Esc / 右键 / 点「取消」→ 放弃整次截图。
 */

/** 最小可确认边长（CSS px）：和主进程 MIN_SIDE 保持一致 */
const MIN = 8;
/** 边缘留白：尺寸标签 / 底栏不贴死屏幕边 */
const PAD = 8;

const el = {
  root: document.getElementById('so'),
  bg: document.getElementById('so-bg'),
  scrim: document.getElementById('so-scrim'),
  sel: document.getElementById('so-sel'),
  size: document.getElementById('so-size'),
  sizeW: document.getElementById('so-size-w'),
  sizeH: document.getElementById('so-size-h'),
  bar: document.getElementById('so-bar'),
  barIdle: document.getElementById('so-bar-idle'),
  barAct: document.getElementById('so-bar-act'),
};

const S = {
  /** 'idle' | 'new' | 'selected' | 'move' | 'resize' | 'done' */
  mode: 'idle',
  /** 当前选区（画布坐标，CSS px 整数） */
  rect: null,
  /** 本次指针拖拽的描述：{ kind, p0, rect0, handle } */
  drag: null,
  stageW: 0,
  stageH: 0,
  done: false,
  /** 上一次给主进程报「有操作」的时间（节流用） */
  touchedAt: 0,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function setMode(mode) {
  S.mode = mode;
  el.root.dataset.state = mode;
}

/** 有操作 → 重置主进程那 60 秒超时（节流 2 秒一次，别拿 IPC 当 mousemove 用） */
function touch() {
  const now = Date.now();
  if (now - S.touchedAt < 2000) return;
  S.touchedAt = now;
  if (window.overlay && window.overlay.touch) window.overlay.touch().catch(() => {});
}

/* ------------------------------ 几何 ------------------------------ */

function rectFromPoints(x0, y0, x1, y1) {
  const left = Math.round(Math.min(x0, x1));
  const top = Math.round(Math.min(y0, y1));
  const right = Math.round(Math.max(x0, x1));
  const bottom = Math.round(Math.max(y0, y1));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * 手柄拖拽 → 新矩形。
 * 以「四条边」为单位算，而不是以 x/y/w/h 加减：反向拖（把左边拖到右边之外）时不会出现负宽高，
 * 越界时自动夹在画布内，并且始终保留 MIN 的最小边长。
 */
function resizeRect(r0, handle, px, py) {
  const h = String(handle);
  let left = r0.x;
  let top = r0.y;
  let right = r0.x + r0.w;
  let bottom = r0.y + r0.h;
  const x = clamp(px, 0, S.stageW);
  const y = clamp(py, 0, S.stageH);

  if (h.includes('w')) left = Math.min(x, right - MIN);
  if (h.includes('e')) right = Math.max(x, left + MIN);
  if (h.includes('n')) top = Math.min(y, bottom - MIN);
  if (h.includes('s')) bottom = Math.max(y, top + MIN);

  left = clamp(left, 0, Math.max(0, S.stageW - MIN));
  right = clamp(right, MIN, S.stageW);
  top = clamp(top, 0, Math.max(0, S.stageH - MIN));
  bottom = clamp(bottom, MIN, S.stageH);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

/* ------------------------------ 绘制 ------------------------------ */

/**
 * 尺寸标签跟着选区左上角；上方放不下就翻到内侧，左右也夹在画布内。
 * 「实时反馈选区范围」主要靠它 —— 拖动时数字跟着变，用户不需要看底栏。
 */
function placeChip() {
  if (!S.rect) return;
  const w = el.size.offsetWidth || 88;
  const h = el.size.offsetHeight || 22;
  const r = S.rect;
  let y = r.y - h - 5;
  if (y < PAD) y = r.y + 5;
  y = clamp(y, PAD, S.stageH - h - PAD);
  const x = clamp(r.x, PAD, Math.max(PAD, S.stageW - w - PAD));
  el.size.style.transform = `translate(${x}px, ${y}px)`;
}

/**
 * 底栏贴着选区走：优先放下方，其次上方，都放不下就压进选区底部。
 * 不这样做的话，框选屏幕下半部分时底栏会正好盖住刚选中的内容。
 */
function placeBar() {
  const bw = el.bar.offsetWidth || 300;
  const bh = el.bar.offsetHeight || 38;
  const r = S.rect;
  if (!r || S.mode === 'new') {
    el.bar.style.transform = `translate(${Math.round(S.stageW / 2 - bw / 2)}px, ${S.stageH - bh - 40}px)`;
    return;
  }
  const gap = 10;
  let y;
  if (r.y + r.h + gap + bh <= S.stageH - PAD) y = r.y + r.h + gap;
  else if (r.y - gap - bh >= PAD) y = r.y - gap - bh;
  else y = clamp(r.y + r.h - bh - 10, PAD, S.stageH - bh - PAD);
  const x = clamp(Math.round(r.x + r.w / 2 - bw / 2), PAD, Math.max(PAD, S.stageW - bw - PAD));
  el.bar.style.transform = `translate(${x}px, ${y}px)`;
}

function paint() {
  const r = S.rect;
  const has = !!r && r.w > 0 && r.h > 0;
  if (!has) {
    el.sel.hidden = true;
    el.size.hidden = true;
    el.scrim.hidden = false;
    el.barIdle.hidden = false;
    el.barAct.hidden = true;
    placeBar();
    return;
  }
  // 一旦有选区，压暗就交给 .so-sel 的 box-shadow（挖洞），整屏 scrim 撤掉
  el.scrim.hidden = true;
  el.sel.hidden = false;
  el.size.hidden = false;
  el.sel.style.transform = `translate(${r.x}px, ${r.y}px)`;
  el.sel.style.width = `${r.w}px`;
  el.sel.style.height = `${r.h}px`;
  el.sel.classList.toggle('is-tiny', r.w < 40 || r.h < 40);
  el.sizeW.textContent = String(r.w);
  el.sizeH.textContent = String(r.h);

  const settled = S.mode === 'selected' || S.mode === 'move' || S.mode === 'resize';
  el.barIdle.hidden = settled;
  el.barAct.hidden = !settled;
  placeChip();
  placeBar();
}

/* ------------------------------ 指针 ------------------------------ */

function onPointerDown(e) {
  if (S.done) return;
  // 右键 = 放弃（不用抬起，按下就退）
  if (e.button === 2) {
    e.preventDefault();
    cancel('right');
    return;
  }
  if (e.button !== 0) return;
  // 底栏 / 尺寸标签上的按下不算画布操作
  if (e.target.closest('.so-bar')) return;
  e.preventDefault();
  touch();

  try { el.root.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败也还能靠 document 监听 */ }

  const p0 = { x: e.clientX, y: e.clientY };
  const handle = e.target.closest('.so-h');

  if (S.rect && handle) {
    setMode('resize');
    S.drag = { kind: 'resize', handle: handle.dataset.h, p0, rect0: { ...S.rect }, moved: false };
    return;
  }
  if (S.rect && e.target.closest('.so-move')) {
    setMode('move');
    S.drag = { kind: 'move', p0, rect0: { ...S.rect }, moved: false };
    return;
  }
  // 空白处按下 = 重新框选；记下旧选区，点一下没拖动时还原，避免误触丢掉已经调好的框
  setMode('new');
  S.drag = { kind: 'new', p0, rect0: S.rect ? { ...S.rect } : null, moved: false };
  S.rect = { x: Math.round(p0.x), y: Math.round(p0.y), w: 0, h: 0 };
  paint();
}

function onPointerMove(e) {
  if (S.done) return;
  const d = S.drag;
  if (!d) { touch(); return; }
  touch();
  const px = e.clientX;
  const py = e.clientY;
  if (!d.moved && (Math.abs(px - d.p0.x) > 2 || Math.abs(py - d.p0.y) > 2)) d.moved = true;

  if (d.kind === 'new') {
    S.rect = rectFromPoints(d.p0.x, d.p0.y, px, py);
  } else if (d.kind === 'move') {
    const r = { ...d.rect0 };
    r.x = clamp(Math.round(r.x + (px - d.p0.x)), 0, Math.max(0, S.stageW - r.w));
    r.y = clamp(Math.round(r.y + (py - d.p0.y)), 0, Math.max(0, S.stageH - r.h));
    S.rect = r;
  } else {
    S.rect = resizeRect(d.rect0, d.handle, px, py);
  }
  paint();
}

function endDrag() {
  const d = S.drag;
  S.drag = null;
  if (!d) return;
  if (d.kind !== 'new') {
    // 二次调整结束：回到可继续调整的状态，进入下一轮不再是"重新框选"
    setMode('selected');
    paint();
    return;
  }
  const r = S.rect;
  if (!r || r.w < MIN || r.h < MIN) {
    if (d.rect0) {
      // 空白处点了一下（或手抖了一下）：保留原来的选区
      S.rect = d.rect0;
      setMode('selected');
      paint();
      return;
    }
    cancel(d.moved ? 'tiny' : 'click');
    return;
  }
  setMode('selected');
  paint();
}

function onPointerUp(e) {
  if (S.done) return;
  try { el.root.releasePointerCapture(e.pointerId); } catch (err) { /* 没捕获成功 */ }
  endDrag();
}

/* ------------------------------ 确认 / 放弃 ------------------------------ */

function confirm() {
  const r = S.rect;
  if (S.done || !r || r.w < MIN || r.h < MIN) return;
  S.done = true;
  setMode('done');
  el.barAct.hidden = true;
  el.barIdle.hidden = false;
  placeBar();
  // 画布尺寸一起带回去：主进程按「原图物理宽 / 画布逻辑宽」换算裁剪坐标
  const msg = { x: r.x, y: r.y, w: r.w, h: r.h, stage: { w: S.stageW, h: S.stageH } };
  if (window.overlay && window.overlay.done) window.overlay.done(msg).catch(() => {});
}

function cancel(reason) {
  if (S.done) return;
  S.done = true;
  if (window.overlay && window.overlay.cancel) window.overlay.cancel(reason || 'cancel').catch(() => {});
}

/** Esc：调整中 → 撤销这次调整；其余 → 放弃整次截图 */
function onEsc() {
  const d = S.drag;
  if ((S.mode === 'move' || S.mode === 'resize') && d && d.rect0) {
    S.drag = null;
    S.rect = d.rect0;
    setMode('selected');
    paint();
    return;
  }
  if (S.mode === 'new' && d && d.rect0) {
    S.drag = null;
    S.rect = d.rect0;
    setMode('selected');
    paint();
    return;
  }
  cancel('esc');
}

/* ------------------------------ 键盘 ------------------------------ */

function onKeyDown(e) {
  if (S.done) return;
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); onEsc(); return; }
  if (k === 'Enter') { e.preventDefault(); confirm(); return; }
  if (!S.rect) return;
  const step = e.shiftKey ? 10 : 1;
  const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const delta = map[k];
  if (!delta) return;
  e.preventDefault();
  const dx = delta[0] * step;
  const dy = delta[1] * step;
  if (e.altKey) {
    // Alt + 方向：改大小（右 / 下边跟着走）
    const r = { ...S.rect };
    if (dx) r.w = clamp(r.w + dx, MIN, S.stageW - r.x);
    if (dy) r.h = clamp(r.h + dy, MIN, S.stageH - r.y);
    S.rect = r;
  } else {
    S.rect = {
      ...S.rect,
      x: clamp(S.rect.x + dx, 0, Math.max(0, S.stageW - S.rect.w)),
      y: clamp(S.rect.y + dy, 0, Math.max(0, S.stageH - S.rect.h)),
    };
  }
  if (S.mode === 'idle' || S.mode === 'new') setMode('selected');
  paint();
}

/* ------------------------------ 启动 ------------------------------ */

el.root.addEventListener('pointerdown', onPointerDown);
el.root.addEventListener('pointermove', onPointerMove);
el.root.addEventListener('pointerup', onPointerUp);
el.root.addEventListener('pointercancel', () => { endDrag(); });
el.root.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel('right'); });
el.root.addEventListener('dblclick', (e) => {
  // 双击选区内部 = 确认（与多数截图工具一致）
  if (S.done) return;
  if (S.rect && e.target.closest('.so-move')) confirm();
});
el.root.addEventListener('selectstart', (e) => e.preventDefault());
document.addEventListener('keydown', onKeyDown);

el.bar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'ok') confirm();
  else cancel('button');
});

async function boot() {
  S.stageW = Math.max(1, window.innerWidth);
  S.stageH = Math.max(1, window.innerHeight);
  let info = null;
  try { info = await window.overlay.ready(); } catch (err) { info = null; }
  if (info && info.image) {
    el.bg.src = info.image;
    try { await el.bg.decode(); } catch (err) { /* 解码失败就显示黑底，不阻塞框选 */ }
  }
  paint();
  // 背景真的画好了再让主进程 show：否则会先闪一帧黑
  try { await window.overlay.shown(); } catch (err) { /* 显不出来也不影响后续操作 */ }
}

// 窗口尺寸变化（缩放 / 任务栏变化）时重新夹一遍选区，避免框出屏幕外
window.addEventListener('resize', () => {
  S.stageW = Math.max(1, window.innerWidth);
  S.stageH = Math.max(1, window.innerHeight);
  if (S.rect) {
    S.rect.x = clamp(S.rect.x, 0, Math.max(0, S.stageW - S.rect.w));
    S.rect.y = clamp(S.rect.y, 0, Math.max(0, S.stageH - S.rect.h));
    S.rect.w = Math.min(S.rect.w, S.stageW);
    S.rect.h = Math.min(S.rect.h, S.stageH);
  }
  paint();
});

boot();
