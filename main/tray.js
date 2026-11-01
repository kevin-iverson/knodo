'use strict';
/**
 * 系统托盘：显示/隐藏主窗口、快速添加任务、退出。
 */
const { Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');

let tray = null;
/** 动态菜单项（桌面浮窗列表）：每次弹出前重建，保证「已钉清单」永远是最新的 */
let extraItems = () => [];
/** 菜单回调（refreshTrayMenu 重建时要用同一组） */
let handlers = {};

function buildMenu() {
  const { onShow, onQuickAdd, onQuit } = handlers;
  const template = [
    { label: '显示主界面', click: onShow },
    { label: '快速添加任务', click: onQuickAdd },
    { type: 'separator' },
  ];
  let extra = [];
  try {
    extra = extraItems() || [];
  } catch (e) {
    extra = [];
  }
  if (extra.length) template.push(...extra, { type: 'separator' });
  template.push({ label: '退出', click: onQuit });
  return Menu.buildFromTemplate(template);
}

function setupTray({ getWindow, onShow, onQuickAdd, onQuit, desktopItems }) {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  const image = nativeImage.createFromPath(iconPath);
  handlers = { onShow, onQuickAdd, onQuit };
  if (typeof desktopItems === 'function') extraItems = desktopItems;
  tray = new Tray(image);
  tray.setToolTip('Knodo');

  tray.setContextMenu(buildMenu());
  // 右键即重建：新钉 / 取消钉住之后不用等下一次状态变化才更新菜单
  tray.on('right-click', () => {
    if (!tray) return;
    tray.popUpContextMenu(buildMenu());
  });
  // 单击托盘图标切换显示/隐藏
  tray.on('click', () => {
    const win = getWindow();
    if (!win) return onShow();
    if (win.isVisible() && win.isFocused()) win.hide();
    else onShow();
  });
  return tray;
}

/** 投影列表变化后刷新托盘菜单（托盘不可用时静默跳过） */
function refreshTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(buildMenu());
  } catch (e) { /* 菜单构建失败不影响托盘本身 */ }
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
  handlers = {};
  extraItems = () => [];
}

/**
 * 通知统一用托盘图标：以前托盘气泡与提醒调度各写一份 new Notification()，
 * 同一条提醒会弹两次、图标还可能不一致。现在只在这里定义一份图标，调度侧直接引用。
 */
const NOTIFICATION_ICON = path.join(__dirname, '..', 'assets', 'tray.png');

/** 托盘气泡提醒 */
function showTrayNotification({ title, body }) {
  if (!Notification.isSupported()) return false;
  try {
    const n = new Notification({ title, body, icon: NOTIFICATION_ICON });
    n.show();
    return true;
  } catch (e) {
    console.error('[tray] 通知发送失败：', e && e.message ? e.message : e);
    return false;
  }
}

module.exports = {
  setupTray, destroyTray, refreshTrayMenu, showTrayNotification, NOTIFICATION_ICON,
};
