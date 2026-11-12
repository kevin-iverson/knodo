'use strict';
/**
 * 标题栏右上角三颗自绘按钮（最小化 / 最大化·还原 / 关闭）。
 *
 * 主窗口是无边框窗口（main/main.js 的 titleBarStyle:"hidden" 且不挂 overlay），
 * 系统按钮不存在，动作全部走 preload 的 api.win（最小化 / 切换最大化 / 关闭到托盘）。
 *
 * 最大化状态只信主进程推来的 win:state：拖边吸附、Win+方向键、双击标题栏、
 * 任务栏右键最大化都会改变窗口状态，渲染层自己记一份必然对不上。
 */
import { api } from './api.js';

export function initWindowControls() {
  const bar = document.getElementById('tb-win');
  if (!bar || !api || !api.win) return;

  const maxBtn = bar.querySelector('[data-win="max"]');
  const setMax = (on) => {
    bar.dataset.max = on ? '1' : '0';
    if (maxBtn) {
      const label = on ? '还原' : '最大化';
      maxBtn.title = label;
      maxBtn.setAttribute('aria-label', label);
    }
  };
  setMax(false);

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tb-win-btn');
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.win;
    // 窗口可能正被关闭 / 销毁，invoke 失败不该冒到控制台最上层，静默即可
    try {
      if (act === 'min') api.win.minimize().catch(() => {});
      else if (act === 'max') api.win.toggleMaximize().catch(() => {});
      else if (act === 'close') api.win.close().catch(() => {});
    } catch (err) { /* preload 不可用 */ }
  });

  api.on('win:state', (s) => setMax(!!(s && s.maximized)));
  api.win.state().then((s) => setMax(!!(s && s.maximized))).catch(() => {});
}
