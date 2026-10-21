'use strict';
/**
 * 图片双击放大预览。
 *
 * 适用范围：Markdown 渲染出来的图片（任务描述、AI 报告、会议纪要）以及详情描述编辑器里
 * 粘贴的图片。用事件委托挂在 document 上——这些图片都是动态重绘出来的，逐个绑定会漏。
 *
 * 交互：双击图片打开；再次双击图片、点击遮罩空白、按 Esc 关闭。
 * 缩放只用 max-width / max-height 约束，宽高交给浏览器按原始比例推导，绝不拉伸变形。
 */
let maskEl = null;

const SELECTOR = 'img.md-image, .markdown-body img, .detail-notes-editor img, .mt-markdown img';

function closeZoom() {
  if (!maskEl) return;
  document.removeEventListener('keydown', onKey, true);
  maskEl.remove();
  maskEl = null;
}

function onKey(e) {
  if (e.key === 'Escape' && maskEl) {
    e.stopPropagation(); // 别让 Esc 顺带把详情抽屉 / 弹窗也关了
    closeZoom();
  }
}

function openZoom(img) {
  closeZoom(); // 同一时刻只允许一个预览层

  const mask = document.createElement('div');
  mask.className = 'img-zoom-mask';
  mask.innerHTML = '<img class="img-zoom-img" alt="预览" />';
  const big = mask.querySelector('.img-zoom-img');
  big.src = img.currentSrc || img.src;
  // 原图还没解码完时先按原始比例留白，避免瞬间闪一个扁的占位框
  if (img.naturalWidth && img.naturalHeight) {
    big.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
  }
  document.body.appendChild(mask);
  maskEl = mask;

  document.addEventListener('keydown', onKey, true);
  // 点遮罩关闭（点图片本身不关，避免"想再看一眼"却被误关）
  mask.addEventListener('click', (e) => { if (e.target === mask) closeZoom(); });
  // 再次双击图片关闭
  big.addEventListener('dblclick', (e) => { e.preventDefault(); closeZoom(); });
}

/** 绑定全局双击放大（只需调一次，重绘出来的图片自动生效） */
export function bindImageZoom() {
  document.addEventListener('dblclick', (e) => {
    const img = e.target.closest ? e.target.closest(SELECTOR) : null;
    if (!img || !img.src) return;
    e.preventDefault();
    openZoom(img);
  });
}
