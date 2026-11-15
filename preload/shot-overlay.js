'use strict';
/**
 * 框选覆盖层的预加载脚本（独立于主窗口的 preload）。
 *
 * 故意**不**复用 preload/preload.js：那个文件把整个 api 面（任务 / 笔记 / 设置 / 密钥相关）
 * 全暴露给了渲染进程，而覆盖层只需要三件事。少给一个命名空间，就少一条被页面脚本误用的路。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  /** 拉背景图与画布尺寸（此时窗口还没显示） */
  ready: () => ipcRenderer.invoke('shot:overlay-ready'),
  /** 背景已经画好 → 让主进程 show：先显示后画会闪一帧黑 */
  shown: () => ipcRenderer.invoke('shot:overlay-shown'),
  /** 交选区（相对窗口左上角的 CSS 像素）+ 画布尺寸；重复调用无副作用 */
  done: (rect) => ipcRenderer.invoke('shot:overlay-done', { rect, reason: 'done' }),
  /** 放弃（Esc / 右键 / ✕ 按钮） */
  cancel: (reason) => ipcRenderer.invoke('shot:overlay-done', { rect: null, reason: reason || 'cancel' }),
  /** 有操作 → 重置主进程那 60 秒的超时（渲染层节流到 2 秒一次） */
  touch: () => ipcRenderer.invoke('shot:overlay-touch'),
});
