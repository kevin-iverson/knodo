'use strict';
/**
 * 系统托盘：显示/隐藏主窗口、快速添加任务、退出。
 */
const { Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');

let tray = null;

function setupTray({ getWindow, onShow, onQuickAdd, onQuit }) {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image);
  tray.setToolTip('Knodo');

  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: onShow },
    { label: '快速添加任务', click: onQuickAdd },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
  tray.setContextMenu(menu);
  // 单击托盘图标切换显示/隐藏
  tray.on('click', () => {
    const win = getWindow();
    if (!win) return onShow();
    if (win.isVisible() && win.isFocused()) win.hide();
    else onShow();
  });
  return tray;
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
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

module.exports = { setupTray, destroyTray, showTrayNotification, NOTIFICATION_ICON };
