'use strict';
/**
 * 渲染进程入口。
 */
import { init } from './ui.js';

// 供冒烟测试检测渲染进程是否成功初始化
window.__appReady = false;
window.addEventListener('error', (e) => console.error('[renderer error]', e.message));

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await init();
    window.__appReady = true;
  } catch (e) {
    console.error('[renderer init failed]', e);
  }
});
