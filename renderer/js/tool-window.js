'use strict';
/**
 * 非模态「工具浮窗」：菜单「实用工具」下的小工具（代码格式化 / 文本对比）都用它承载。
 *
 * 与 openPanelModal 的区别（也是这里存在的理由）：
 *  - 无遮罩、不抢全局焦点：开着工具窗照样能操作主界面（列任务、写笔记），互不打断；
 *  - 标题栏可拖动、右下角可缩放，支持最小化（收成标题条）/ 最大化（铺满窗口）/ 还原；
 *  - 同一 key 只允许一个实例（重复点菜单只置顶已开的那个），不同 key 可同时开、互相叠放；
 *  - 位置 / 尺寸 / 最小化最大化状态按 key 记在 localStorage，下次打开回到上次的摆放。
 *
 * z-index 刻意压在 .modal-mask(300) 之下：模态对话框（如任务详情、确认框）必须盖住工具窗，
 * 否则会出现"弹窗被工具窗挡住点不到"的情况。
 */
const Z_BASE = 210;
const Z_MAX = 248;
let zTop = Z_BASE;

/** key → 窗口实例（同一工具只开一个） */
const registry = new Map();

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const storeKey = (key) => `tool-win:${key}`;

function readState(key) {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey(key)) || 'null');
    return s && typeof s === 'object' ? s : null;
  } catch (e) {
    return null; // 记忆值损坏就当没记过
  }
}

function writeState(key, patch) {
  try {
    localStorage.setItem(storeKey(key), JSON.stringify({ ...(readState(key) || {}), ...patch }));
  } catch (e) { /* 隐私模式 / 配额不可用时静默降级为「只本次有效」 */ }
}

/** 把位置尺寸夹进可视区（窗口变小、多屏拔掉后都要能救回来） */
function clampBox(box, minW, minH) {
  const vw = Math.max(320, window.innerWidth);
  const vh = Math.max(240, window.innerHeight);
  const w = Math.max(minW, Math.min(Math.round(box.w || minW), Math.max(minW, vw - 24)));
  const h = Math.max(minH, Math.min(Math.round(box.h || minH), Math.max(minH, vh - 24)));
  const x = Math.max(8, Math.min(Math.round(box.x ?? (vw - w) / 2), Math.max(8, vw - w - 8)));
  const y = Math.max(8, Math.min(Math.round(box.y ?? 72), Math.max(8, vh - h - 8)));
  return { x, y, w, h };
}

/**
 * 打开（或置顶已有的）工具浮窗。
 * @param {object} opts
 * @param {string} opts.key 唯一标识（同一 key 复用同一个窗口）
 * @param {string} opts.title 标题
 * @param {string} [opts.html] 主体 HTML（由调用方给出，事件也在 onMount 里自行挂载）
 * @param {string} [opts.headHtml] 标题栏右侧、按钮左侧的额外内容
 * @param {{width?:number,height?:number}} [opts.size] 默认尺寸
 * @param {number} [opts.minWidth]
 * @param {number} [opts.minHeight]
 * @param {(root:HTMLElement, win:object) => void} [opts.onMount]
 * @param {() => void} [opts.onClose]
 * @returns {object} 窗口句柄 { root, close, raise, isOpen }
 */
export function openToolWindow({
  key, title, html = '', headHtml = '', size = {}, minWidth = 560, minHeight = 360,
  onMount, onClose,
}) {
  const exist = registry.get(key);
  if (exist && exist.root.isConnected) {
    exist.raise();
    return exist;
  }

  const saved = readState(key) || {};
  const defaultBox = clampBox(
    { x: saved.x, y: saved.y, w: saved.w || size.width || 980, h: saved.h || size.height || 640 },
    minWidth, minHeight,
  );
  // 多个工具窗同时开时错开一点，免得完全重叠看不见底下那个
  const offset = Math.min(registry.size, 5) * 26;
  let box = clampBox(
    { x: (saved.x == null ? defaultBox.x + offset : defaultBox.x),
      y: (saved.y == null ? defaultBox.y + offset : defaultBox.y),
      w: defaultBox.w, h: defaultBox.h },
    minWidth, minHeight,
  );

  const el = document.createElement('div');
  el.className = 'tool-win';
  el.dataset.tool = key;
  el.innerHTML = `
    <div class="tool-win-head">
      <span class="tool-win-title">${esc(title)}</span>
      ${headHtml}
      <span class="tool-win-btns">
        <button type="button" class="tool-win-btn" data-act="min" title="最小化（收起为标题条）" aria-label="最小化">─</button>
        <button type="button" class="tool-win-btn" data-act="max" title="最大化（铺满窗口）" aria-label="最大化">□</button>
        <button type="button" class="tool-win-btn" data-act="close" title="关闭" aria-label="关闭">✕</button>
      </span>
    </div>
    <div class="tool-win-body">${html}</div>
    <div class="tool-win-grip" title="拖动调整大小（双击恢复默认）" role="separator" aria-label="调整窗口大小"></div>`;
  document.body.appendChild(el);

  const bodyEl = el.querySelector('.tool-win-body');
  let minimized = !!saved.min;
  let maximized = !!saved.max;
  let preMaxBox = { ...box };

  const applyGeometry = () => {
    if (maximized) {
      el.style.left = '12px';
      el.style.top = '12px';
      el.style.width = `${Math.max(minWidth, window.innerWidth - 24)}px`;
      el.style.height = `${Math.max(minHeight, window.innerHeight - 24)}px`;
    } else if (minimized) {
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
      el.style.width = `${Math.min(box.w, Math.max(minWidth, window.innerWidth - 24))}px`;
      el.style.height = ''; // 收起为标题条：高度交给内容
    } else {
      const b = clampBox(box, minWidth, minHeight);
      box.x = b.x; box.y = b.y; box.w = b.w; box.h = b.h;
      el.style.left = `${b.x}px`;
      el.style.top = `${b.y}px`;
      el.style.width = `${b.w}px`;
      el.style.height = `${b.h}px`;
    }
    el.classList.toggle('is-max', maximized);
    el.classList.toggle('is-min', minimized);
  };
  applyGeometry();

  const raise = () => {
    zTop = Math.min(Z_MAX, zTop + 1);
    el.style.zIndex = String(zTop);
  };
  raise();

  const persist = () => writeState(key, { x: box.x, y: box.y, w: box.w, h: box.h, min: minimized, max: maximized });
  const notifyResize = () => el.dispatchEvent(new CustomEvent('toolwin:resize'));

  /* ---- 标题栏拖动 ---- */
  const head = el.querySelector('.tool-win-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, a')) return; // 标题栏上的控件照常可用
    if (maximized) return; // 最大化时不允许拖动（拖动没有意义，先还原）
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, bx: box.x, by: box.y };
    head.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');
    const onMove = (ev) => {
      box.x = start.bx + (ev.clientX - start.x);
      box.y = start.by + (ev.clientY - start.y);
      applyGeometry();
    };
    const onUp = () => {
      head.removeEventListener('pointermove', onMove);
      head.removeEventListener('pointerup', onUp);
      head.removeEventListener('pointercancel', onUp);
      el.classList.remove('is-dragging');
      persist();
    };
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp);
    head.addEventListener('pointercancel', onUp);
  });
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, select, textarea')) return;
    toggleMax();
  });

  /* ---- 右下角缩放 ---- */
  const grip = el.querySelector('.tool-win-grip');
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    raise();
    e.preventDefault();
    e.stopPropagation();
    maximized = false;
    minimized = false;
    const start = { x: e.clientX, y: e.clientY, w: box.w, h: box.h };
    grip.setPointerCapture(e.pointerId);
    el.classList.add('is-resizing');
    const onMove = (ev) => {
      box.w = start.w + (ev.clientX - start.x);
      box.h = start.h + (ev.clientY - start.y);
      applyGeometry();
      notifyResize();
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      el.classList.remove('is-resizing');
      persist();
      notifyResize();
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
  grip.addEventListener('dblclick', () => {
    try { localStorage.removeItem(storeKey(key)); } catch (e) { /* 忽略 */ }
    maximized = false;
    minimized = false;
    box.w = size.width || 980;
    box.h = size.height || 640;
    box.x = Math.round((window.innerWidth - box.w) / 2);
    box.y = 72;
    applyGeometry();
    persist();
    notifyResize();
  });

  function setMin(on) {
    const next = on == null ? !minimized : !!on;
    if (next === minimized) return;
    minimized = next;
    if (minimized) maximized = false;
    applyGeometry();
    persist();
    notifyResize();
  }

  function toggleMax() {
    if (maximized) {
      maximized = false;
      box = { ...preMaxBox };
    } else {
      preMaxBox = { ...box };
      maximized = true;
      minimized = false;
    }
    applyGeometry();
    persist();
    notifyResize();
  }

  el.addEventListener('pointerdown', () => raise()); // 点窗口任意处即置顶

  const win = { key, root: el, body: bodyEl, raise, setMin, toggleMax, close: () => close() };

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    win.isOpen = false;
    window.removeEventListener('resize', onWinResize);
    registry.delete(key);
    if (typeof onClose === 'function') {
      try { onClose(); } catch (e) { /* 关闭钩子失败不能拦住关闭 */ }
    }
    el.remove();
  }
  win.isOpen = true;

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'close') close();
    else if (act === 'min') setMin();
    else if (act === 'max') toggleMax();
  });

  /** 主窗口尺寸变化时把浮窗拉回可视区（最大化状态自动跟随） */
  function onWinResize() {
    applyGeometry();
    notifyResize();
  }
  window.addEventListener('resize', onWinResize);

  registry.set(key, win);
  if (typeof onMount === 'function') {
    try { onMount(el, win, bodyEl); } catch (e) { console.error('[tool-win] onMount 失败', e); }
  }
  return win;
}

/** 已打开的工具窗（供菜单判断"再点一次就置顶"） */
export function getToolWindow(key) {
  const w = registry.get(key);
  return w && w.root.isConnected ? w : null;
}
