'use strict';
/**
 * 侧边栏宽度拖拽调整（拖它与主内容区之间的那条边）。
 *
 * 与详情抽屉的拖拽手柄同一套做法：Pointer Events + setPointerCapture（指针移出窗口也不丢事件）、
 * 宽度只在 requestAnimationFrame 里落地（mousemove 高频触发不抖）、拖动期间禁用文本选中。
 *
 * 宽度写在 .app 的 --sidebar-width 上，由 .sidebar 消费：主区是 flex:1，
 * 侧边栏变化只会挤压主区宽度，不会把布局顶歪。
 */
import { api } from './api.js';

const LIMITS = { min: 180, max: 420, def: 220 };
const LS_KEY = 'ui.sidebarWidth';

let width = null;
let dragging = false;

/** 上限同时受视口约束：至少给主内容区留 480px，否则窄窗口下主区会被挤没 */
function clamp(v, winW = window.innerWidth) {
  const max = Math.max(LIMITS.min, Math.min(LIMITS.max, winW - 480));
  return Math.round(Math.min(max, Math.max(LIMITS.min, Number(v) || LIMITS.def)));
}

function apply(w) {
  width = w;
  const app = document.querySelector('.app');
  if (!app) return;
  app.style.setProperty('--sidebar-width', `${w}px`);
  const bar = document.querySelector('.sidebar');
  if (bar) { bar.style.width = `${w}px`; bar.style.minWidth = `${w}px`; }
}

/** 先写 localStorage（下次启动瞬间生效），再异步落库 */
let saveTimer = 0;
function persist(w) {
  try { localStorage.setItem(LS_KEY, String(w)); } catch (_e) { /* 忽略配额异常 */ }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.ui.setSidebarWidth(w).catch((e) => console.warn('[sidebar] 保存宽度失败', e && e.message));
  }, 350);
}

export async function initSidebarResize() {
  const bar = document.querySelector('.sidebar');
  const handle = document.getElementById('sidebar-resizer');
  if (!bar || !handle) return;

  // 本地缓存兜底，再读库里的值（库里为准）
  width = clamp(Number(localStorage.getItem(LS_KEY)) || LIMITS.def);
  try {
    const saved = await api.ui.getSidebarWidth();
    if (saved) width = clamp(saved);
  } catch (e) { /* 读取失败用缓存/默认值 */ }
  apply(width);

  let drag = null;
  let raf = 0;

  const flush = () => {
    raf = 0;
    if (!drag || drag.next == null) return;
    const w = clamp(drag.next - drag.offset);
    if (w === drag.last) return;
    drag.last = w;
    apply(w);
  };
  const onMove = (e) => {
    if (!drag) return;
    drag.next = e.clientX;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const endDrag = () => {
    if (!drag) return;
    const lastX = drag.next;
    drag = null;
    dragging = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    document.documentElement.classList.remove('is-resizing');
    document.body.style.removeProperty('user-select');
    handle.classList.remove('is-active');
    try { handle.releasePointerCapture(handle.__pointerId); } catch (_e) { /* 已释放 */ }
    // 收尾补一次：窗口被遮挡时 rAF 会被节流，最后一帧可能没落地
    const w = lastX != null ? clamp(lastX - (handle.__dragOffset || 0)) : width;
    apply(w);
    persist(w);
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 阻止拖拽时选中文字
    const rect = bar.getBoundingClientRect();
    const offset = e.clientX - rect.right; // 指针相对边界的偏移，避免按下瞬间跳宽
    drag = { next: e.clientX, offset, last: null };
    handle.__dragOffset = offset;
    dragging = true;
    handle.__pointerId = e.pointerId;
    try { handle.setPointerCapture(e.pointerId); } catch (_e) { /* 退回 window 监听 */ }
    document.documentElement.classList.add('is-resizing');
    document.body.style.userSelect = 'none';
    handle.classList.add('is-active');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  });

  // 双击恢复默认宽度
  handle.addEventListener('dblclick', () => {
    const w = clamp(LIMITS.def);
    apply(w);
    persist(w);
  });

  // 窗口变窄时收敛回上限内（拖拽中不打断）
  window.addEventListener('resize', () => {
    if (dragging || width == null) return;
    const w = clamp(width);
    if (w !== width) { apply(w); persist(w); }
  });
}
