'use strict';
/**
 * 主窗口内的右键菜单（轻量自绘，不新开窗口）。
 *
 * 为什么不用 Electron 的原生 Menu：原生菜单要绕一圈回主进程 popup，位置跟随后就得额外对齐；
 * 而这里需要的只是「在鼠标处弹一组带说明的项」，纯 DOM 更省事、样式也能跟应用一致。
 * 桌面浮窗里反而用的是原生菜单 —— 那里的窗口高度随内容变，自绘二级菜单会被裁掉。
 *
 * 约束：同一时刻只允许一个菜单；点外面 / Esc / 滚动 / 窗口失焦都要关掉，
 * 否则会留下一个飘在界面上的孤儿。
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let current = null; // { el, detach }

/**
 * 打开右键菜单。
 * @param {Array<object>} items 项数组：
 *   { label, icon?, hint?, disabled?, danger?, checked?, onClick } 或 { type: 'sep' }
 * @param {{x:number, y:number}} pos 视口坐标（通常是 e.clientX / e.clientY）
 * @returns {HTMLElement|null} 菜单根元素
 */
export function openContextMenu(items, pos) {
  closeContextMenu();
  if (!Array.isArray(items) || !items.length) return null;

  const box = document.createElement('div');
  box.className = 'ctx-menu';
  box.setAttribute('role', 'menu');
  box.innerHTML = items.map((it, i) => {
    if (it && it.type === 'sep') return '<div class="ctx-sep"></div>';
    const cls = [
      'ctx-item',
      it.disabled ? 'is-disabled' : '',
      it.danger ? 'is-danger' : '',
    ].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" role="menuitem" data-i="${i}"
      ${it.disabled ? 'disabled' : ''} title="${esc(it.hint || '')}">
      <span class="ctx-ico">${esc(it.icon || '')}</span>
      <span class="ctx-label">${esc(it.label || '')}</span>
      ${it.checked ? '<span class="ctx-check">✓</span>' : ''}
    </button>`;
  }).join('');
  document.body.appendChild(box);

  // 先量尺寸再定位：右下角弹出时向左上翻，保证不出视口
  const r = box.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.max(8, Math.min(pos && pos.x != null ? pos.x : 0, vw - r.width - 8));
  const y = Math.max(8, Math.min(pos && pos.y != null ? pos.y : 0, vh - r.height - 8));
  box.style.left = `${Math.round(x)}px`;
  box.style.top = `${Math.round(y)}px`;

  const onDown = (e) => { if (!box.contains(e.target)) closeContextMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeContextMenu(); }
  };
  const onBlur = () => closeContextMenu();
  // 捕获阶段：右键点别处也要先关掉旧菜单，否则会叠加两个
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('contextmenu', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  document.addEventListener('scroll', onBlur, true);

  const detach = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('contextmenu', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
    document.removeEventListener('scroll', onBlur, true);
  };

  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.ctx-item');
    if (!btn || btn.disabled) return;
    const it = items[Number(btn.dataset.i)];
    closeContextMenu();
    if (it && typeof it.onClick === 'function') {
      // 放到下一拍执行：先让菜单消失，再跑可能弹窗 / 重绘的逻辑
      setTimeout(() => { try { it.onClick(); } catch (err) { console.error('[ctx-menu] 菜单项执行失败', err); } }, 0);
    }
  });

  current = { el: box, detach };
  return box;
}

/** 关闭当前菜单（没有就什么都不做） */
export function closeContextMenu() {
  if (!current) return;
  const { el, detach } = current;
  current = null;
  detach();
  el.remove();
}
