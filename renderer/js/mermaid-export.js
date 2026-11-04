'use strict';
/**
 * Mermaid 图 → PNG。
 *
 * 为什么不用 html2canvas 之类截 DOM：图本身就是矢量 SVG，直接「SVG → <img> → canvas」
 * 画出来是原生分辨率，放大不虚，也不用为了一次导出再 vendor 一个几百 KB 的截图库。
 *
 * 三个必须自己处理的坑：
 * 1) 样式外链：mermaid 把主题写成 SVG 内的 <style>，但字体、以及应用层
 *    `.md-mermaid svg { max-width:100% }` 这类规则来自外部 CSS —— 塞进 <img> 就全丢了。
 *    所以先把「计算后的样式」快照成内联 style，按源/克隆节点一一对应地搬过去。
 * 2) 图片加载：SVG 走 blob URL + new Image()，必须等 load 完成才能 drawImage。
 * 3) 透明背景：深色主题的图是浅色字，存成透明 PNG 贴到白底文档里就看不见了 ——
 *    默认用图块自身的背景色铺底，做到「所见即所得」。
 */

/** 需要固化到内联样式的属性：排版 + 描边填充 + 文字锚点。白名单而非全量，
 *  否则一个流程图几百个节点会把 style 属性撑成几十 KB。 */
const STYLE_PROPS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'letter-spacing', 'word-spacing', 'line-height',
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin',
  'color', 'opacity', 'visibility',
  'text-anchor', 'dominant-baseline', 'text-decoration', 'paint-order',
  'stop-color', 'stop-opacity',
];

/** SVG 的自然尺寸：viewBox 优先（mermaid 输出就是 viewBox + width:100%），再看属性，最后量盒子 */
function svgSize(svg) {
  const vb = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  const w = parseFloat(svg.getAttribute('width'));
  const h = parseFloat(svg.getAttribute('height'));
  if (w > 0 && h > 0) return { w, h };
  const r = svg.getBoundingClientRect();
  return { w: Math.max(1, Math.round(r.width) || 800), h: Math.max(1, Math.round(r.height) || 600) };
}

/** 从图块往上找第一个不透明的背景色：导出图要和屏幕上看到的一致 */
function backdropOf(el) {
  let node = el;
  while (node && node.nodeType === 1) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
    node = node.parentElement;
  }
  return '#ffffff';
}

/** 把源树的计算样式快照到克隆树上（两棵树结构完全一致，同步遍历即可） */
function inlineComputedStyles(srcRoot, cloneRoot) {
  const srcAll = [srcRoot, ...srcRoot.querySelectorAll('*')];
  const cloneAll = [cloneRoot, ...cloneRoot.querySelectorAll('*')];
  const n = Math.min(srcAll.length, cloneAll.length);
  for (let i = 0; i < n; i++) {
    const target = cloneAll[i];
    // <style> / <script> 之类没有渲染样式，跳过（往它们身上写 style 也没意义）
    if (!(target instanceof Element)) continue;
    const cs = getComputedStyle(srcAll[i]);
    let style = '';
    for (const prop of STYLE_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v) style += `${prop}:${v};`;
    }
    if (style) target.setAttribute('style', style);
  }
}

/** 把 SVG 文本转成 data URL：不能用 blob: —— 页面 CSP 的 img-src 只放行
 *  'self' / data: / https: / todo-media:，blob 会被拦下，<img> 直接 onerror。 */
function svgToDataUrl(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000; // 分段转，避免一次性 apply 太多参数爆栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

/** SVG 节点 → PNG dataURL（失败时抛错，由调用方决定怎么提示） */
export async function svgToPngDataUrl(svg, { scale = 2, background = '' } = {}) {
  if (!svg || typeof svg.cloneNode !== 'function') throw new Error('没有可导出的图表');
  const { w, h } = svgSize(svg);
  const clone = svg.cloneNode(true);

  inlineComputedStyles(svg, clone);
  // 尺寸写死成自然尺寸：源节点上的 width:100% / max-width:100% 会让 <img> 量不到像素
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.style.width = `${w}px`;
  clone.style.height = `${h}px`;
  clone.style.maxWidth = 'none';

  const text = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('图表转图片失败（SVG 无法解码）'));
    img.src = svgToDataUrl(text);
  });
  const k = Math.min(Math.max(Number(scale) || 2, 1), 4);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background || '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(k, k);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

/** 文件名里不能出现的字符统一换掉（Windows 最严），并去掉过长尾巴 */
export function safeFileName(name, fallback = '图表') {
  const s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  return (s || fallback).slice(0, 80);
}

/**
 * 导出某个 .md-mermaid 图块为 PNG。
 * @param {HTMLElement} box 图块容器
 * @param {object} [opts]
 * @param {string} [opts.name] 默认文件名（不含扩展名）
 * @returns {Promise<{ok:boolean, canceled?:boolean, filePath?:string}>}
 */
export async function exportMermaidPng(box, { name = '' } = {}) {
  const svg = box && box.querySelector ? box.querySelector('svg') : null;
  if (!svg) throw new Error('图表还没渲染完，稍后再试');
  const dataUrl = await svgToPngDataUrl(svg, { scale: 2, background: backdropOf(box) });
  if (!window.api || !window.api.app || typeof window.api.app.saveImage !== 'function') {
    throw new Error('当前环境不支持保存图片');
  }
  return window.api.app.saveImage({ dataUrl, name: safeFileName(name, '图表') });
}
