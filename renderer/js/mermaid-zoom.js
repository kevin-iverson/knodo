'use strict';
/**
 * Mermaid 图放大预览（全屏画布 + 缩放 / 平移）。
 *
 * 为什么不复用图片那套「按 max-width 放大」（image-zoom.js）：流程图通常又宽又扁，
 * 等比塞进窗口后节点小到看不清 —— 用户真正要的是「凑近看某一块」。
 * 所以这里做成一张画布：滚轮以光标为中心缩放、按住拖动平移、一键回到「适应窗口 / 1:1」。
 *
 * 缩放用 transform 层做 translate + scale，而不是改 SVG 的 width / height：
 * 后者每动一帧都要重新排版 SVG 里上百个 <g>/<text>，图稍大就明显掉帧；
 * transform 只走合成层，图本身还是矢量，放大到数倍也不会糊。
 *
 * 层级 420：高于笔记全屏面板（320）与弹窗遮罩（300），低于 Toast。
 */

const MIN_SCALE = 0.05;
const MAX_SCALE = 10;
/** 「适应窗口」时留的最小边距：给画布四周一点呼吸，也避免图被贴边裁掉 */
const FIT_PAD = 32;

let maskEl = null;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function onKey(e) {
  if (e.key === 'Escape' && maskEl) {
    e.stopPropagation(); // 别让 Esc 顺带把底下的笔记面板 / 弹窗也关了
    closeZoom();
  }
}

export function closeZoom() {
  if (!maskEl) return;
  document.removeEventListener('keydown', onKey, true);
  if (typeof maskEl.__onResize === 'function') window.removeEventListener('resize', maskEl.__onResize);
  maskEl.remove();
  maskEl = null;
}

/**
 * SVG 的自然尺寸：优先看 viewBox（mermaid 渲染出来就是 viewBox + width=100%），
 * 退化情形再看 width / height 属性，最后按实际盒子兜底。
 * @param {SVGElement} svg
 * @returns {{w:number, h:number}}
 */
function naturalSize(svg) {
  const vb = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  const w = parseFloat(svg.getAttribute('width'));
  const h = parseFloat(svg.getAttribute('height'));
  if (w > 0 && h > 0) return { w, h };
  const r = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
  return {
    w: Math.max(1, (r && Math.round(r.width)) || 600),
    h: Math.max(1, (r && Math.round(r.height)) || 400),
  };
}

/**
 * 打开一张图的全屏预览。
 * @param {object} opts
 * @param {SVGElement} [opts.source] 已渲染好的 SVG 节点（会被克隆，不动正文里的图）
 * @param {string} [opts.svgText] SVG 源码文本（拿不到节点时的兜底）
 * @param {string} [opts.title] 标题里显示的图表类型（流程图 / 时序图…）
 * @returns {boolean} 是否打开成功
 */
export function openMermaidZoom({ source = null, svgText = '', title = '' } = {}) {
  let svg = null;
  if (source && typeof source.cloneNode === 'function') svg = source.cloneNode(true);
  else if (svgText) {
    const holder = document.createElement('div');
    // 这里塞进 innerHTML 的是 mermaid 自己的渲染结果（不是原文），没有用户的注入面
    holder.innerHTML = svgText;
    svg = holder.querySelector('svg');
  }
  if (!svg) return false;
  closeZoom(); // 同一时刻只保留一层预览

  const size = naturalSize(svg);
  // 定死原始尺寸：缩放全交给 transform，否则「预览里的 max-width:100%」会二次拉伸，越缩放越窄
  svg.removeAttribute('style');
  svg.setAttribute('width', String(size.w));
  svg.setAttribute('height', String(size.h));
  svg.style.width = `${size.w}px`;
  svg.style.height = `${size.h}px`;
  svg.style.maxWidth = 'none';
  svg.style.display = 'block';

  const mask = document.createElement('div');
  mask.className = 'mm-zoom-mask';
  mask.innerHTML = `
    <div class="mm-zoom-bar">
      <span class="mm-zoom-title"></span>
      <span class="mm-zoom-ops">
        <button type="button" class="mm-zoom-btn" data-mmz="out" title="缩小">−</button>
        <span class="mm-zoom-val">100%</span>
        <button type="button" class="mm-zoom-btn" data-mmz="in" title="放大">＋</button>
        <button type="button" class="mm-zoom-btn is-wide" data-mmz="fit" title="缩放到适应窗口">适应</button>
        <button type="button" class="mm-zoom-btn is-wide" data-mmz="one" title="按图表原始尺寸显示">1:1</button>
        <button type="button" class="mm-zoom-btn mm-zoom-close" data-mmz="close" title="关闭（Esc）">✕</button>
      </span>
    </div>
    <div class="mm-zoom-canvas"><div class="mm-zoom-stage"></div></div>
    <div class="mm-zoom-tip">滚轮以光标为中心缩放 · 按住拖动平移 · 双击复位 · 点空白或按 Esc 关闭</div>`;
  const canvas = mask.querySelector('.mm-zoom-canvas');
  const stage = mask.querySelector('.mm-zoom-stage');
  const valEl = mask.querySelector('.mm-zoom-val');
  // 标题用 textContent：即便将来把「图表类型」换成用户可控文案，也不会变成注入口
  mask.querySelector('.mm-zoom-title').textContent = `${title || '图表'} · 放大预览`;
  stage.appendChild(svg);
  document.body.appendChild(mask);
  maskEl = mask;
  document.addEventListener('keydown', onKey, true);

  let scale = 1;
  let tx = 0;
  let ty = 0;

  const paint = () => {
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    valEl.textContent = `${Math.round(scale * 100)}%`;
  };
  /** 居中放置（适应窗口 / 1:1 都复用） */
  const center = () => {
    tx = (canvas.clientWidth - size.w * scale) / 2;
    ty = (canvas.clientHeight - size.h * scale) / 2;
  };
  const fit = () => {
    const cw = Math.max(80, canvas.clientWidth - FIT_PAD * 2);
    const ch = Math.max(80, canvas.clientHeight - FIT_PAD * 2);
    const k = Math.min(cw / size.w, ch / size.h);
    scale = clamp(isFinite(k) && k > 0 ? k : 1, MIN_SCALE, MAX_SCALE);
    center();
    paint();
  };
  /** 以画布内坐标 (cx, cy) 为锚点缩放：该点在窗口里的位置保持不动 */
  const zoomAt = (factor, cx, cy) => {
    const next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
    if (next === scale) return;
    const k = next / scale;
    tx = cx - k * (cx - tx);
    ty = cy - k * (cy - ty);
    scale = next;
    paint();
  };
  const zoomCenter = (factor) => zoomAt(factor, canvas.clientWidth / 2, canvas.clientHeight / 2);

  mask.querySelector('.mm-zoom-bar').addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('[data-mmz]') : null;
    if (!btn) return;
    const act = btn.dataset.mmz;
    if (act === 'close') closeZoom();
    else if (act === 'in') zoomCenter(1.25);
    else if (act === 'out') zoomCenter(1 / 1.25);
    else if (act === 'fit') fit();
    else if (act === 'one') { scale = 1; center(); paint(); }
  });

  // passive:false 才能 preventDefault —— 否则页面会跟着一起滚
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // deltaMode：0=像素 / 1=行 / 2=页，不同设备给的量级差几十倍，先归一到像素
    const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? canvas.clientHeight : 1);
    const r = canvas.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * unit * 0.0022), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty };
    canvas.classList.add('is-dragging');
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败不影响平移本身 */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    tx = drag.tx + (e.clientX - drag.x);
    ty = drag.ty + (e.clientY - drag.y);
    paint();
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    canvas.classList.remove('is-dragging');
    if (e && e.pointerId != null) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', () => fit());
  canvas.addEventListener('click', (e) => { if (e.target === canvas) closeZoom(); });

  // 窗口尺寸变了要重算「适应窗口」的比例，否则图会偏到一边
  mask.__onResize = () => fit();
  window.addEventListener('resize', mask.__onResize);

  fit();
  return true;
}
