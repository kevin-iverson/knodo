'use strict';
/**
 * `journal:*` IPC 注册 / 注销（方案 §八 契约表）。
 *
 * 铁律（与 worklog/ipc.js 同一条）：register() 前先 removeHandler ——
 * 关闭再开启时残留 handler 会抛 "Attempted to register a second handler"。
 * `journal:pref/*` 不在这里：那是开关本身，由 features.js 永远注册。
 */
const { ipcMain, BrowserWindow } = require('electron');
const db = require('../db');
const store = require('./store');

const CHANNELS = [
  'journal:day/get',
  'journal:cell/set',
  'journal:note/add',
  'journal:note/update',
  'journal:note/remove',
  'journal:note/fold',
  'journal:stats',
];

/** 与 ipc.js#withDb 同构：数据库未就绪时返回可读错误而不是抛穿 IPC */
function wrap(fn) {
  return async (_e, ...args) => {
    try {
      if (!db.isReady()) throw new Error(`数据库未就绪${db.getInitError() ? '：' + db.getInitError() : ''}`);
      return await fn(...args);
    } catch (e) {
      console.error('[journal:ipc]', e && e.message);
      return { __error: (e && e.message) || String(e) };
    }
  };
}

/** 写操作广播给所有窗口（P0 桌面浮窗不消费，但多开主窗口要同步） */
function changed() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try { w.webContents.send('journal:changed'); } catch (e) { /* 窗口正在关闭 */ }
  }
}

function register() {
  unregister();

  ipcMain.handle('journal:day/get', wrap((p) => store.getDay(p && p.day)));
  ipcMain.handle('journal:stats', wrap(() => store.stats()));

  ipcMain.handle('journal:cell/set', wrap((p) => {
    const r = store.setCell(p && p.day, p && p.cell, p && p.body);
    changed();
    return r;
  }));

  ipcMain.handle('journal:note/add', wrap((p) => {
    const note = store.addNote(p && p.day, p && p.body, p && p.cell);
    changed();
    return { ok: true, note };
  }));

  ipcMain.handle('journal:note/update', wrap((p) => {
    const r = store.updateNote(p && p.id, p && p.patch);
    changed();
    return r;
  }));

  ipcMain.handle('journal:note/remove', wrap((id) => {
    const r = store.removeNote(id);
    changed();
    return r;
  }));

  /** 归入 = 追加到格子末尾 + 从碎碎念移除（一个事务） */
  ipcMain.handle('journal:note/fold', wrap((p) => {
    const r = store.foldNote(p && p.id, p && p.cell);
    changed();
    return r;
  }));
}

function unregister() {
  for (const ch of CHANNELS) {
    try { ipcMain.removeHandler(ch); } catch (e) { /* 没注册过就算了 */ }
  }
}

module.exports = { register, unregister, CHANNELS };
