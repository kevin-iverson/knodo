'use strict';
/**
 * 外观主题 · 渲染层入口（主界面用）。
 *
 * 与 js/theme-core.js 的分工：那边是纯数据与算法（同步、无 IPC），这边负责
 *   · 从主进程取真值、写回缓存、跟随系统深浅色
 *   · 选图 / 移除 / 恢复默认三个带主进程动作的操作
 *   · 背景图丢失的兜底（退回纯色 + 提示条，不阻塞启动）
 *
 * 状态不在这里另存一份：主进程是唯一权威，收到 ui:theme-changed 就用整份对象覆盖。
 * 设置面板改完也走同一个 paint()，不会出现「面板说樱粉、界面还是雾灰」。
 */
import { api } from './api.js';

const T = window.KnodoTheme;
let current = T.normalize(null);
/** 图片探测只做一次（同一个路径反复 new Image 会反复打协议请求） */
let probedUrl = '';
/** 加载失败过的图片地址：之后每次 paint 都直接按「丢失」处理，避免坏图闪回来 */
const badUrls = new Set();

/** 注册到 ui.js 的钩子：主题生效后要通知（Mermaid / 图表按新配色重画） */
let onPainted = null;
export function setThemeHook(fn) { onPainted = typeof fn === 'function' ? fn : null; }

function paint(theme, { dispatch = true } = {}) {
  const next = T.normalize(theme);
  const url = next.backdrop.image ? T.mediaUrl(next.backdrop.image) : '';
  if (url && badUrls.has(url)) {
    // 之前加载失败过（盘拔了 / 文件被删）：别让它再闪回来，按丢失态渲染
    next.backdrop.missing = true;
    next.backdrop.type = 'none';
  }
  current = next;
  const r = T.paint(current);
  T.cache(current);
  if (dispatch) {
    try { document.dispatchEvent(new CustomEvent('app:theme-changed')); } catch (e) { /* 无 DOM */ }
    if (onPainted) onPainted(current, r);
  }
  probeImage();
  paintLostBanner(r);
  return r;
}

/**
 * 背景图文件被手动删掉时，主进程已把 type 改回 none 并置 missing。
 * 这里再补一道：文件在、但协议加载失败（移动硬盘拔了）也要退得干净。
 */
function probeImage() {
  const bd = current.backdrop;
  if (!bd.image || bd.type !== 'image' || bd.missing) { probedUrl = ''; return; }
  const url = T.mediaUrl(bd.image);
  if (!url || url === probedUrl) return;
  probedUrl = url;
  const img = new Image();
  img.onerror = () => {
    badUrls.add(url);
    current = T.normalize({
      ...current,
      backdrop: { ...current.backdrop, type: 'none', missing: true },
    });
    T.paint(current);
    paintLostBanner(T.resolve(current));
    document.dispatchEvent(new CustomEvent('app:theme-changed'));
  };
  img.src = url;
}

function paintLostBanner(r) {
  const bar = document.getElementById('bd-lost');
  if (!bar) return;
  bar.hidden = !r.missing;
}

/** 绑定提示条（只绑一次） */
let bannerBound = false;
function bindBanner() {
  if (bannerBound) return;
  bannerBound = true;
  const bar = document.getElementById('bd-lost');
  if (!bar) return;
  bar.querySelector('#bd-lost-close')?.addEventListener('click', () => { bar.hidden = true; });
  bar.querySelector('#bd-lost-fix')?.addEventListener('click', () => {
    bar.hidden = true;
    // 打开设置中心的「外观」分区（ui.js 已经把 ui:settings 接到同一处，这里直接发事件）
    document.dispatchEvent(new CustomEvent('knodo:open-appearance'));
  });
}

/* ---------------- 对外 API ---------------- */

export function getTheme() { return current; }

export function applyTheme(theme) { return paint(theme); }

/** 启动：取主进程真值 → 落 DOM；跟系统深浅色时监听 media query */
export async function initTheme() {
  bindBanner();
  let theme;
  try {
    theme = await api.theme.get();
  } catch (e) {
    theme = T.cached() || T.normalize(null);
  }
  paint(theme);

  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (current.mode === 'system') paint(current);
    });
  } catch (e) { /* 老内核不支持 addEventListener */ }

  // 主进程是权威：切模式 / 换风格 / 换图都推整份对象过来
  api.on('ui:theme-changed', (t) => { if (t) paint(t); });
}

/** 局部更新（只传要改的字段）；失败时回滚到原状态 */
export async function setTheme(patch) {
  const before = current;
  try {
    const next = await api.theme.set(patch);
    paint(next);
    return next;
  } catch (e) {
    paint(before);
    throw e;
  }
}

/** 选背景图：主进程压缩落盘后返回新主题 + 图片信息（体积 / 尺寸） */
export async function pickBackdrop() {
  const r = await api.theme.pickImage();
  if (r && r.ok && r.theme) paint(r.theme);
  return r;
}

export async function clearBackdrop() {
  const next = await api.theme.clearImage();
  paint(next);
  return next;
}

export async function resetTheme() {
  const next = await api.theme.reset();
  paint(next);
  return next;
}

/** 透明度拖动过程中的即时预览：只写 CSS 变量，不写库、不派发重绘事件 */
export function previewOpacity(opacity) {
  const next = T.normalize({ ...current, backdrop: { ...current.backdrop, opacity } });
  const r = T.resolve(next);
  const root = document.documentElement;
  root.style.setProperty('--surface-alpha', String(r.alpha));
  root.style.setProperty('--bd-image', r.url ? `url("${r.url}")` : 'none');
  const layer = document.getElementById('app-backdrop');
  if (layer) layer.hidden = !r.url;
  return r;
}
