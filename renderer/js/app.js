'use strict';
/**
 * 渲染进程入口。
 */
import { init } from './ui.js';
import { api } from './api.js';

// 供冒烟测试检测渲染进程是否成功初始化
window.__appReady = false;
window.addEventListener('error', (e) => console.error('[renderer error]', e.message, e.filename, e.lineno, e.colno));

/**
 * 功能插件挂载（方案 §四 第二层）。
 *
 * index.html 里不出现任何工时 DOM / script：这里按开关结果动态 import，
 * 关闭态的成本只有一次轻量 IPC + 一次 if 判断 —— 没有 DOM、没有 CSS、没有监听。
 */
async function syncFeatures(pref) {
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

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await init();
    window.__appReady = true;
  } catch (e) {
    console.error('[renderer init failed]', e);
  }
  // 插件在界面就绪之后再挂，避免和首屏抢 DOM
  try {
    const pref = await api.features.pref();
    await syncFeatures(pref);
  } catch (e) {
    console.warn('[features] 读取开关键失败', e);
  }
  // 设置中心里拨开关 → 这里动态 mount / unmount，不重启应用
  api.on('feature:changed', (pref) => { syncFeatures(pref); });
});
