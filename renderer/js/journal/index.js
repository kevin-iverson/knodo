'use strict';
/**
 * 四象日记 · 渲染层唯一入口：mount(pref) / unmount() / applyPref(pref)。
 *
 * 与工时插件同构：
 *  - 入口「📔 日记」常驻 index.html 的 .tb-nav，关闭时点进来是引导页（ui.js#renderJournalOff）；
 *  - 关闭态本文件不会被 import —— 没有日记 DOM、CSS、快捷键、监听；
 *  - 卸载时若用户正停在日记页，就地重绘成引导页，不踢回任务列表。
 */
import { api } from '../api.js';
import { EXT } from '../ext.js';
import { state } from '../store.js';
import { navigateTo } from '../ui.js';
import { renderJournal, applyLabels, unmount as unmountView } from './view.js';

const CSS_ID = 'jr-css';
let mounted = false;
let changedBound = false;
let prefCache = null;

function injectCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.id = CSS_ID;
  link.rel = 'stylesheet';
  link.href = 'css/journal.css';
  document.head.appendChild(link);
}

function removeCss() { const el = document.getElementById(CSS_ID); if (el) el.remove(); }

function bindChanged() {
  if (changedBound) return;
  changedBound = true;
  // 别的窗口改了日记：当前正停在日记页就重绘（不打断输入 —— 用 idle 判断由 view 内部处理）
  api.on('journal:changed', () => {
    if (!mounted || state.view !== 'journal') return;
    const root = document.getElementById('view');
    if (root && !root.querySelector('.jr-view')) return; // 引导页 / 正在重绘，忽略
    // 只重画碎碎念与统计，四格里正在输入的文字不动：整页重绘会丢光标
    import('./view.js').then((m) => m.refreshQuiet && m.refreshQuiet()).catch(() => {});
  });
}

export async function mount(pref) {
  if (mounted) return;
  mounted = true;
  prefCache = pref || { enabled: true, cellLabels: ['心智', '身体', '连结', '事业'] };
  injectCss();
  bindChanged();
  applyLabels(prefCache.cellLabels);

  EXT.views.journal = {
    title: '四象日记',
    desc: '按日记录 · 四格整理 + 随手碎碎念',
    long: '一天一页：心智 / 身体 / 连结 / 事业四格 + 随手碎碎念。只存本地，不进 AI 检索与报告。',
    render: (root) => renderJournal(root),
  };

  const nav = document.querySelector('.nav-item[data-view="journal"]');
  if (nav && nav.classList.contains('active')) {
    await navigateTo('journal');
  }
}

export function unmount() {
  if (!mounted) return;
  mounted = false;
  const onJournalView = !!(document.querySelector('.nav-item[data-view="journal"]')
    && document.querySelector('.nav-item[data-view="journal"]').classList.contains('active'));

  unmountView();
  delete EXT.views.journal;
  removeCss();

  // 卸载后不能把人踢回任务列表：就地重绘成「未启用」引导页（方案 §6.6）
  if (onJournalView) navigateTo('journal').catch((e) => console.warn('[journal] 卸载重绘失败', e));
}

/** 设置里改了四格名字 / 偏好：不重挂模块，只同步差异 */
export function applyPref(pref) {
  if (!pref) return;
  prefCache = pref;
  if (Array.isArray(pref.cellLabels)) applyLabels(pref.cellLabels);
}

/** 供验收脚本读取当前挂载状态与偏好（与 __appReady 同性质的小钩子） */
export function debugState() {
  return { mounted, pref: prefCache };
}
