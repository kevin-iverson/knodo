'use strict';
/**
 * 渲染进程入口。
 */
import { init, toast, getEncouragerStats } from './ui.js';
import { api } from './api.js';

// 供冒烟测试检测渲染进程是否成功初始化
window.__appReady = false;
window.addEventListener('error', (e) => console.error('[renderer error]', e.message, e.filename, e.lineno, e.colno));

/**
 * 功能插件挂载（方案 §四 第二层）。
 *
 * index.html 里没有工时 / 搭子的模块与样式（搭子入口按钮常驻 DOM 但默认 hidden）：
 * 这里按开关结果动态 import，关闭态只有一次轻量 IPC + 一次 if 判断 ——
 * 没有 DOM、没有 CSS、没有监听。
 */
let buddyMountToken = 0;
let buddyState = false;

async function syncWorklog(pref) {
  const on = !!(pref && pref.enabled);
  if (on) {
    if (window.KnodoWorklog) return;
    try {
      const m = await import('./worklog/index.js');
      await m.mount();
      window.KnodoWorklog = m;
    } catch (e) {
      console.error('[worklog] 挂载失败', e);
    }
    return;
  }
  if (window.KnodoWorklog) {
    try { window.KnodoWorklog.unmount(); } catch (e) { console.warn('[worklog] 卸载异常', e); }
    window.KnodoWorklog = null;
  }
}

/** 工位搭子：标题栏入口 + 浮窗模块 + 发币 / 菜单监听一起开关 */
async function syncBuddy(pref) {
  const on = !!(pref && pref.enabled);
  const btn = document.getElementById('btn-buddy');
  // 「只有开启才显示」：入口是显隐的唯一出口，CSS 里另有 [hidden] 兜底
  if (btn) btn.hidden = !on;

  const mountedNow = !!window.KnodoEncourager;
  // 稳态直接返回：注意 on=true 但模块还没挂好 = 上一次 import 仍在进行，别重复 import
  if (on === buddyState && (mountedNow === on || (on && !mountedNow))) return;
  buddyState = on;
  const token = ++buddyMountToken;

  if (on) {
    try {
      const m = await import('./encourager.js');
      // 动态 import 期间用户又关掉了：别把模块挂回一个已经隐藏的入口上
      if (token !== buddyMountToken || (btn && btn.hidden)) return;
      m.setEncouragerHandlers({ toast, getStats: getEncouragerStats });
      m.mount();
      window.KnodoEncourager = m;
    } catch (e) {
      console.error('[buddy] 挂载失败', e);
    }
    return;
  }

  if (window.KnodoEncourager) {
    try { window.KnodoEncourager.unmount(); } catch (e) { console.warn('[buddy] 卸载异常', e); }
    window.KnodoEncourager = null;
  }
}

/** 四象日记：视图 + 样式 + 快捷键 + 顶栏入口高亮，全在 journal/index.js 内开关 */
async function syncJournal(pref) {
  const on = !!(pref && pref.enabled);
  if (on) {
    if (window.KnodoJournal) {
      // 已挂载时同步四格改名（不重挂）
      try { window.KnodoJournal.applyPref(pref); } catch (e) { console.warn('[journal] 偏好同步失败', e); }
      return;
    }
    try {
      const m = await import('./journal/index.js');
      await m.mount(pref);
      window.KnodoJournal = m;
    } catch (e) {
      console.error('[journal] 挂载失败', e);
    }
    return;
  }
  if (window.KnodoJournal) {
    try { window.KnodoJournal.unmount(); } catch (e) { console.warn('[journal] 卸载异常', e); }
    window.KnodoJournal = null;
  }
}

/**
 * 新广播带 { worklog, buddy, plugins:{ journal } }；老广播顶层就是工时开关，仍可识别。
 * 日记偏好在 plugins.journal（方案 §4.3 的兼容形态），启动时单独 pref('journal') 拉。
 */
async function syncFeatures(payload) {
  const p = payload || {};
  await syncWorklog(p.worklog || p);
  await syncBuddy(p.buddy || { enabled: false });
  await syncJournal((p.plugins && p.plugins.journal) || p.journal || null);
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await init();
    window.__appReady = true;
  } catch (e) {
    console.error('[renderer init failed]', e);
  }
  // 插件在界面就绪之后再挂，避免和首屏抢 DOM
  try {
    const [worklog, buddy, journal] = await Promise.all([
      api.features.pref(),
      api.features.pref('buddy').catch(() => ({ enabled: false })),
      api.features.pref('journal').catch(() => null),
    ]);
    await syncFeatures({ worklog, buddy, journal });
  } catch (e) {
    console.warn('[features] 读取开关键失败', e);
  }
  // 设置中心里拨开关 → 这里动态 mount / unmount，不重启应用
  api.on('feature:changed', (payload) => { syncFeatures(payload); });
});
