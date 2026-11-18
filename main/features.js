'use strict';
/**
 * 特性注册中心（方案 §四 第一层）。
 *
 * 常驻的只有这一个文件：读开关、注册 / 注销、广播。
 * 关闭状态下 `main/worklog/**` 一个字节都不 require —— 没有 IPC、没有定时器、没有内存驻留。
 * 工位搭子（buddy）同样默认关闭：它不占主进程常驻资源，开关只负责菜单 / 快捷键 / 广播，
 * 渲染层按广播动态 import 浮窗模块与样式。
 *
 * 开关存在 settings 表：
 *   feature.worklog → { enabled, zenDefaultSec, dayAttr: 'start' }
 *   feature.buddy   → { enabled }
 *   feature.journal → { enabled, cellLabels }        // 四象日记（并行插件）
 *
 * 兼容：老的 `worklog:pref/get|set` 与无参 `getPref()/setPref(patch)` 继续只操作工时，
 * 现有验收脚本不用改；新代码走 `features:get/set` + 显式插件名。
 * 注意：`*:pref/*` 这两条通道永远注册，它就是开关本身；关闭时必须保留，
 * 否则用户再也没有入口把它打开。
 */
const { ipcMain, BrowserWindow } = require('electron');
const db = require('./db');

const SETTING_KEY = 'feature.worklog';
const BUDDY_SETTING_KEY = 'feature.buddy';
const JOURNAL_SETTING_KEY = 'feature.journal';

const DEFAULTS = {
  enabled: false,
  zenDefaultSec: 5400,
  dayAttr: 'start',      // 只支持按开始时间归属（FR-04）
};
const BUDDY_DEFAULTS = { enabled: false };
const JOURNAL_DEFAULTS = { enabled: false, cellLabels: ['心智', '身体', '连结', '事业'] };

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

let pref = { ...DEFAULTS };              // 工时（保留旧变量名，减少历史代码改动面）
let buddyPref = { ...BUDDY_DEFAULTS };   // 工位搭子
let journalPref = { ...JOURNAL_DEFAULTS, cellLabels: JOURNAL_DEFAULTS.cellLabels.slice() }; // 四象日记
let onChange = null;                     // 主进程菜单重等副作用，由 main.js 注入
let journalMods = null;                  // 四象日记子模块：关闭态不 require main/journal/**

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

function normalizeBuddy(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch (e) { o = {}; }
  }
  o = o && typeof o === 'object' ? o : {};
  return { enabled: !!o.enabled };
}

/** 四格标签：固定长度 4，逐项裁剪到 8 字；空 / 非法回落出厂名，绝不出现空白格 */
function normalizeJournal(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch (e) { o = {}; }
  }
  o = o && typeof o === 'object' ? o : {};
  const labels = Array.isArray(o.cellLabels) ? o.cellLabels : [];
  const cellLabels = JOURNAL_DEFAULTS.cellLabels.map((fb, i) => {
    const v = typeof labels[i] === 'string' ? labels[i].trim().slice(0, 8) : '';
    return v || fb;
  });
  return { enabled: !!o.enabled, cellLabels };
}

function MJ() {
  if (!journalMods) journalMods = { ipc: require('./journal/ipc') };
  return journalMods;
}

function readPref() {
  try {
    return normalize(db.isReady() ? db.getSetting(SETTING_KEY) : null);
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function readBuddyPref() {
  try {
    return normalizeBuddy(db.isReady() ? db.getSetting(BUDDY_SETTING_KEY) : null);
  } catch (e) {
    return { ...BUDDY_DEFAULTS };
  }
}

function broadcast() {
  const payload = {
    // 顶层字段继续是工时：老监听者（desktop.js / worklog/index.js）零改动
    ...pref,
    worklog: { ...pref },
    buddy: { ...buddyPref },
    // 新插件挂 plugins.*（方案 §4.3），顶层一份也不动
    plugins: {
      journal: { ...journalPref, cellLabels: journalPref.cellLabels.slice() },
    },
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send('feature:changed', payload);
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

/** 无参 = 工时（兼容旧调用）；显式插件名 = 对应配置；'all' = 三份快照 */
function getPref(name) {
  if (name === 'buddy') return { ...buddyPref };
  if (name === 'journal') return { ...journalPref, cellLabels: journalPref.cellLabels.slice() };
  if (name === 'all') {
    return {
      worklog: { ...pref }, buddy: { ...buddyPref },
      journal: { ...journalPref, cellLabels: journalPref.cellLabels.slice() },
    };
  }
  return { ...pref };
}

function setWorklogPref(patch) {
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

/** 工位搭子没有主进程模块：只写开关 + 广播，渲染层据此 mount / unmount */
function setBuddyPref(patch) {
  const wasOn = buddyPref.enabled;
  buddyPref = normalizeBuddy({ ...buddyPref, ...(patch || {}) });
  try {
    db.setSetting(BUDDY_SETTING_KEY, JSON.stringify(buddyPref));
  } catch (e) {
    console.error('[features] 写入搭子开关失败：', e && e.message);
    buddyPref.enabled = wasOn;
    return { ok: false, reason: '写入设置失败' };
  }

  broadcast();
  if (buddyPref.enabled !== wasOn && typeof onChange === 'function') {
    try { onChange(); } catch (e) { console.error('[features] 搭子开关回调失败：', e && e.message); }
  }
  return { ok: true, pref: { ...buddyPref } };
}

/** 四象日记：开关翻转才注册 / 注销 journal:*；标签改名只写偏好 + 广播，不重挂 */
function setJournalPref(patch) {
  const wasOn = journalPref.enabled;
  journalPref = normalizeJournal({ ...journalPref, ...(patch || {}) });
  try {
    db.setSetting(JOURNAL_SETTING_KEY, JSON.stringify(journalPref));
  } catch (e) {
    console.error('[features] 写入日记开关失败：', e && e.message);
    journalPref.enabled = wasOn;
    return { ok: false, reason: '写入设置失败' };
  }

  if (journalPref.enabled !== wasOn) {
    try {
      if (journalPref.enabled) MJ().ipc.register();
      else MJ().ipc.unregister();
    } catch (e) {
      console.error('[features] 切换日记插件失败：', e && e.message);
      journalPref.enabled = wasOn;
      try { db.setSetting(JOURNAL_SETTING_KEY, JSON.stringify(journalPref)); } catch (e2) { /* 忽略 */ }
      return { ok: false, reason: (e && e.message) || '切换失败' };
    }
  }

  broadcast();
  return { ok: true, pref: { ...journalPref, cellLabels: journalPref.cellLabels.slice() } };
}

/** 兼容旧签名 setPref(patch)；新签名 setPref('worklog'|'buddy'|'journal', patch) */
function setPref(nameOrPatch, patch) {
  if (typeof nameOrPatch === 'string') {
    if (nameOrPatch === 'buddy') return setBuddyPref(patch);
    if (nameOrPatch === 'journal') return setJournalPref(patch);
    if (nameOrPatch === 'worklog') return setWorklogPref(patch);
    return { ok: false, reason: `未知插件：${nameOrPatch}` };
  }
  return setWorklogPref(nameOrPatch);
}

function isEnabled(name) {
  if (name === 'buddy') return !!buddyPref.enabled;
  if (name === 'journal') return !!journalPref.enabled;
  return !!pref.enabled;
}

function setOnChange(fn) {
  onChange = typeof fn === 'function' ? fn : null;
}

function ensurePrefIpc() {
  for (const ch of [
    'worklog:pref/get', 'worklog:pref/set',
    'journal:pref/get', 'journal:pref/set',
    'features:get', 'features:set',
  ]) {
    try { ipcMain.removeHandler(ch); } catch (e) { /* 没注册过 */ }
  }
  ipcMain.handle('worklog:pref/get', () => getPref());
  ipcMain.handle('worklog:pref/set', (_e, patch) => setPref(patch));
  // 日记的开关通道永远注册：关闭态用户靠它把插件打开（方案 §4.1）
  ipcMain.handle('journal:pref/get', () => getPref('journal'));
  ipcMain.handle('journal:pref/set', (_e, patch) => setJournalPref(patch));
  ipcMain.handle('features:get', (_e, name) => getPref(name));
  ipcMain.handle('features:set', (_e, name, patch) => setPref(name, patch));
}

/** 启动时调用一次：读开关，开启则把整条链路接上 */
function init() {
  ensurePrefIpc();
  pref = readPref();
  buddyPref = readBuddyPref();
  try {
    journalPref = normalizeJournal(db.isReady() ? db.getSetting(JOURNAL_SETTING_KEY) : null);
  } catch (e) {
    journalPref = { ...JOURNAL_DEFAULTS, cellLabels: JOURNAL_DEFAULTS.cellLabels.slice() };
  }
  if (pref.enabled && db.isReady()) {
    try { activate(); } catch (e) { console.error('[features] 启用工时插件失败：', e && e.message); }
  }
  if (journalPref.enabled && db.isReady()) {
    try { MJ().ipc.register(); } catch (e) { console.error('[features] 启用日记插件失败：', e && e.message); }
  }
}

/** registerIpc() 末尾调用：只负责把 `worklog:*` 挂上（开关已开的场合） */
function registerAll() {
  if (pref.enabled) {
    try { M().ipc.register(); } catch (e) { console.error('[features] 注册工时 IPC 失败：', e && e.message); }
  }
  if (journalPref.enabled) {
    try { MJ().ipc.register(); } catch (e) { console.error('[features] 注册日记 IPC 失败：', e && e.message); }
  }
}

/** 退出前：把进行中的计时结算掉 */
function handleWillQuit() {
  if (!pref.enabled) return;
  try { M().service.handleWillQuit(); } catch (e) { /* 退出路径别抛 */ }
}

module.exports = {
  SETTING_KEY,
  BUDDY_SETTING_KEY,
  JOURNAL_SETTING_KEY,
  DEFAULTS,
  JOURNAL_DEFAULTS,
  BUDDY_DEFAULTS,
  init,
  registerAll,
  handleWillQuit,
  getPref,
  setPref,
  normalize,
  isEnabled,
  setOnChange,
};
