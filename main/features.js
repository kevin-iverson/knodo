'use strict';
/**
 * 特性注册中心（方案 §四 第一层）。
 *
 * 常驻的只有这一个文件：读开关、注册 / 注销、广播。
 * 关闭状态下 `main/worklog/**` 一个字节都不 require —— 没有 IPC、没有定时器、没有内存驻留。
 *
 * 开关存在 settings 表，键 `feature.worklog`：
 *   { enabled, zenDefaultSec, dayAttr: 'start' }
 *
 * 注意：`worklog:pref/*` 这两条通道**永远注册**，它就是开关本身；
 * 关闭时必须保留，否则用户再也没有入口把它打开。
 */
const { ipcMain, BrowserWindow } = require('electron');
const db = require('./db');

const SETTING_KEY = 'feature.worklog';

const DEFAULTS = {
  enabled: false,
  zenDefaultSec: 5400,
  dayAttr: 'start',      // 只支持按开始时间归属（FR-04）
};

/** 子模块懒加载：关闭态不 require，物理边界看得见 */
let mods = null;
function M() {
  if (!mods) {
    mods = {
      ipc: require('./worklog/ipc'),
      service: require('./worklog/service'),
    };
  }
  return mods;
}

let pref = { ...DEFAULTS };

function normalize(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch (e) { o = {}; }
  }
  o = o && typeof o === 'object' ? o : {};
  const zen = Number(o.zenDefaultSec);
  return {
    enabled: !!o.enabled,
    // 原型只给了 0 / 60 / 90 / 120 分钟四档；异常值一律回落 90 分钟
    zenDefaultSec: Number.isFinite(zen) && zen >= 0 && zen <= 8 * 3600 ? zen : DEFAULTS.zenDefaultSec,
    dayAttr: 'start',
  };
}

function readPref() {
  try {
    return normalize(db.isReady() ? db.getSetting(SETTING_KEY) : null);
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function broadcast() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send('feature:changed', pref);
      // 关闭态 mods 为空：这条广播只带开关变化，不为了取一份快照把模块 require 进来
      if (mods) w.webContents.send('worklog:changed', mods.service.getState());
    } catch (e) { /* 某个窗口正在关闭，忽略 */ }
  }
}

function activate() {
  const { ipc, service } = M();
  ipc.register();
  // 残留 running 行的对账放在这里：只有开启时才需要为历史记录负责
  ipc.setNotices(service.reconcileOnStartup());
  service.init({
    onChanged: () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        try { w.webContents.send('worklog:changed', M().service.getState()); } catch (e) { /* 忽略 */ }
      }
    },
  });
}

function deactivate() {
  const { ipc, service } = M();
  service.shutdown();   // 进行中的计时先结算
  ipc.unregister();
}

function getPref() {
  return { ...pref };
}

function setPref(patch) {
  const wasOn = pref.enabled;
  pref = normalize({ ...pref, ...(patch || {}) });
  try {
    db.setSetting(SETTING_KEY, JSON.stringify(pref));
  } catch (e) {
    console.error('[features] 写入开关失败：', e && e.message);
    return { ok: false, reason: '写入设置失败' };
  }

  if (pref.enabled !== wasOn) {
    try {
      if (pref.enabled) activate();
      // 关闭前先把界面依赖的东西停掉，再广播；顺序反了会出现「入口没了但计时还在跑」
      else deactivate();
    } catch (e) {
      console.error('[features] 切换工时插件失败：', e && e.message);
      pref.enabled = wasOn;
      try { db.setSetting(SETTING_KEY, JSON.stringify(pref)); } catch (e2) { /* 忽略 */ }
      return { ok: false, reason: (e && e.message) || '切换失败' };
    }
  }

  broadcast();
  return { ok: true, pref: { ...pref } };
}

function ensurePrefIpc() {
  for (const ch of ['worklog:pref/get', 'worklog:pref/set']) {
    try { ipcMain.removeHandler(ch); } catch (e) { /* 没注册过 */ }
  }
  ipcMain.handle('worklog:pref/get', () => getPref());
  ipcMain.handle('worklog:pref/set', (_e, patch) => setPref(patch));
}

/** 启动时调用一次：读开关，开启则把整条链路接上 */
function init() {
  ensurePrefIpc();
  pref = readPref();
  if (pref.enabled && db.isReady()) {
    try { activate(); } catch (e) { console.error('[features] 启用工时插件失败：', e && e.message); }
  }
}

/** registerIpc() 末尾调用：只负责把 `worklog:*` 挂上（开关已开的场合） */
function registerAll() {
  if (!pref.enabled) return;
  try { M().ipc.register(); } catch (e) { console.error('[features] 注册工时 IPC 失败：', e && e.message); }
}

/** 退出前：把进行中的计时结算掉 */
function handleWillQuit() {
  if (!pref.enabled) return;
  try { M().service.handleWillQuit(); } catch (e) { /* 退出路径别抛 */ }
}

module.exports = {
  SETTING_KEY,
  DEFAULTS,
  init,
  registerAll,
  handleWillQuit,
  getPref,
  setPref,
  normalize,
};
