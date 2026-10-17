'use strict';
/**
 * 全局快捷键：Ctrl/Cmd+Shift+T 显示/隐藏，Ctrl/Cmd+Shift+N 快速添加。
 */
const { globalShortcut } = require('electron');

const SHORTCUTS = [
  { accel: 'CommandOrControl+Shift+T', name: 'toggle-window' },
  { accel: 'CommandOrControl+Shift+N', name: 'quick-add' },
];

function registerShortcuts({ onToggle, onQuickAdd }) {
  unregisterShortcuts();
  globalShortcut.register(SHORTCUTS[0].accel, onToggle);
  globalShortcut.register(SHORTCUTS[1].accel, onQuickAdd);
}

function unregisterShortcuts() {
  globalShortcut.unregisterAll();
}

module.exports = { registerShortcuts, unregisterShortcuts };
