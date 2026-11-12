'use strict';
/**
 * 全局快捷键（Global Shortcut）。
 *
 * 这一层只解决「应用不在前台也能按键响应」，与渲染层的应用内键（Space / ↑↓ / Esc 等）
 * 完全分开：注册机制、冲突范围、可自定义程度都不同，混在一张表里迟早出错。
 *
 * 三条不变量：
 *  1. 动作表只在这里定义一份（渲染层通过 list() 拿，不在两处各写一遍）；
 *  2. 存的是 Electron accelerator 原格式（`Control+Alt+B`），显示层自己转 `Ctrl + Alt + B`；
 *  3. 换键必须原子：先注册新键，成功才摘旧键；失败原样回滚 —— 否则新键被占用时
 *     用户连旧键都没了，功能静默失效。
 */
const { app, globalShortcut, powerMonitor, ipcMain, BrowserWindow } = require('electron');
const db = require('./db');

/** 设置键：{ version, map: { actionId: accelerator | null } } */
const KEY = 'tool.keybindings';
const VERSION = 1;

/**
 * 动作清单。
 * 筛选标准是「每天至少用 10 次」——键位泛滥等于没有键位，所以这里只留少量高频动作。
 */
const ACTIONS = [
  { id: 'app.show', label: '显示 / 隐藏主窗口', hint: '按一次唤起，再按一次收起', def: 'Control+Alt+B' },
  { id: 'app.notes', label: '显示 / 隐藏笔记', hint: '按一次唤起并打开笔记，再按一次收起', def: 'Control+Shift+H' },
  { id: 'app.quickAdd', label: '快速添加任务', hint: '在当前清单里就地新建一条，不切视图', def: 'Control+Alt+N' },
  { id: 'app.capture', label: '快速捕捉', hint: '屏幕顶部弹一条输入条，回车即存', def: 'Control+Alt+C' },
  // 桌面浮窗用 D（Desktop）而不是原来的 H：H 与「显示 / 隐藏笔记」的 Ctrl+Shift+H
  // 只差一个修饰键，实机上很容易按混、也会被输入法/键盘宏串到一起
  { id: 'app.toggleDesktop', label: '显示 / 隐藏桌面浮窗', hint: '演示 / 共享屏幕前一键收起', def: 'Control+Alt+D' },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    id: `desktop.focus.${n}`,
    label: `唤起第 ${n} 个桌面浮窗`,
    hint: '置顶 2 秒便于定位',
    def: `Control+Alt+${n}`,
  })),
  { id: 'app.calendar', label: '日历视图', hint: '打开日历视图（再按一次回列表）', def: 'Control+Alt+M' },
  // 趣味功能：E（Encourager）打开主浮窗。
  // 菜单加速键另用 CmdOrCtrl+Shift+* 前缀，不与全局键重复注册。
  { id: 'util.encourager', label: '上班鼓励器', hint: '打开 / 聚焦主浮窗（薪资进账主界面）', def: 'Control+Alt+E' },
];

const ACTION_IDS = ACTIONS.map((a) => a.id);
const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

/**
 * 应用内键：固定，不开放自定义（冲突范围只在应用内、可控）。
 * 只用于设置面板里的只读展示 —— 真正生效逻辑在 renderer/js/ui.js。
 */
const IN_APP = [
  ['Ctrl+N', '新建任务'],
  ['Ctrl+Shift+N', '新建笔记'],
  ['Ctrl+F', '搜索'],
  ['Ctrl+,', '打开设置'],
  // 以下三条原先是应用菜单的加速键，菜单栏撤掉后在 renderer/js/ui.js 里重绑
  ['Ctrl+Shift+I', '导入 Markdown 笔记'],
  ['Ctrl+= / - / 0', '界面缩放（原 View 菜单）'],
  ['F12', '开发者工具'],
  ['Ctrl+Z', '撤销（删除任务后 5 秒内）'],
  ['Space', '勾选当前选中项'],
  ['↑ / ↓', '列表上下移动'],
  ['Enter', '打开当前项详情'],
  ['Esc', '取消编辑 / 关闭浮层'],
  ['Delete', '删除当前项（可撤销）'],
];

/**
 * 系统保留 / 抢不到的组合：直接拒绝，不进注册。
 * 其中 Ctrl+Alt+Del 走的是系统安全序列，register() 必然 false，拦在这里只是为了给出可读文案。
 */
const BLACKLIST = new Set([
  'Control+Alt+Delete', 'Control+Alt+Esc', 'Control+Escape', 'Control+Shift+Escape',
  'Super+L', 'Super+D', 'Super+E', 'Super+R', 'Super+S', 'Super+A', 'Super+Tab',
  'Super+Space', 'Super+Shift+S', 'Super+Left', 'Super+Right', 'Super+Up', 'Super+Down',
  'Alt+F4', 'Alt+Tab', 'Control+Alt+Tab',
]);

/** 已注册的 { actionId: accelerator } */
const registered = new Map();
let onAction = () => {};
let ready = false;

/* ------------------------------ 键位解析 ------------------------------ */

/** 校验类错误：文案是给用户看的，日志里不必当异常打 */
function userError(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

/** 主键归一：把渲染层 / 用户输入的各种写法收成 Electron 认识的键名 */
const KEY_ALIAS = {
  ' ': 'Space', space: 'Space', spacebar: 'Space',
  esc: 'Esc', escape: 'Esc',
  enter: 'Enter', return: 'Enter',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down',
  left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
  del: 'Delete', delete: 'Delete', backspace: 'Backspace', tab: 'Tab',
  plus: 'Plus',
};

/**
 * 规范化 + 校验。通过返回 `Control+Alt+B` 这样的标准串，不通过抛错（文案直接给用户看）。
 * @param {string} raw
 * @returns {string}
 */
function normalizeAccel(raw) {
  const s = String(raw || '').trim();
  if (!s) throw userError('组合键不能为空');
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  const mods = new Set();
  let key = '';
  for (const p of parts) {
    const v = p.toLowerCase();
    if (v === 'ctrl' || v === 'control') mods.add('Control');
    else if (v === 'alt' || v === 'option') mods.add('Alt');
    else if (v === 'shift') mods.add('Shift');
    else if (v === 'super' || v === 'win' || v === 'meta' || v === 'cmd' || v === 'command') mods.add('Super');
    else {
      if (key) throw userError('只能包含一个主键');
      key = normalizeKey(p);
    }
  }
  if (!key) throw userError('必须再按一个主键（字母 / 数字 / 功能键）');

  // 纯 Shift + 字母等价于打大写，抢不到输入法之前的键盘事件，注册了也不会触发
  const strong = mods.has('Control') || mods.has('Alt') || mods.has('Super');
  if (!strong) {
    if (mods.has('Shift')) throw userError('Shift + 字母只能打出大写，抢不到；请再加上 Ctrl 或 Alt');
    throw userError('全局键必须包含 Ctrl 或 Alt（否则会抢走所有应用的正常输入）');
  }

  const accel = [...['Control', 'Alt', 'Shift', 'Super'].filter((m) => mods.has(m)), key].join('+');
  if (BLACKLIST.has(accel)) throw userError('这个是系统保留组合，无法使用');
  return accel;
}

function normalizeKey(p) {
  const v = String(p).trim();
  const low = v.toLowerCase();
  if (KEY_ALIAS[low]) return KEY_ALIAS[low];
  if (/^f([1-9]|1\d|2[0-4])$/.test(low)) return low.toUpperCase();
  if (/^[a-z]$/.test(low)) return low.toUpperCase();
  if (/^[0-9]$/.test(low)) return low;
  // 标点（, . / ; [ ] \ - 等）：Electron 直接按字符识别，原样保留
  if (v.length === 1) return v;
  throw userError(`不认识的按键：${v}`);
}

/** 显示用：`Control+Alt+B` → `Ctrl + Alt + B` */
function displayAccel(accel) {
  if (!accel) return '';
  return String(accel)
    .split('+')
    .map((p) => (p === 'Control' ? 'Ctrl' : p === 'Super' ? (process.platform === 'darwin' ? 'Cmd' : 'Win') : p))
    .join(' + ');
}

/* ------------------------------ 持久化 ------------------------------ */

function readRaw() {
  try {
    const v = JSON.parse(db.getSetting(KEY, '') || '{}');
    if (!v || typeof v !== 'object') return { version: VERSION, map: {} };
    return { version: Number(v.version) || VERSION, map: v.map && typeof v.map === 'object' ? v.map : {} };
  } catch (e) {
    return { version: VERSION, map: {} };
  }
}

function readMap() {
  return readRaw().map;
}

function writeMap(map) {
  try {
    db.setSetting(KEY, JSON.stringify({ version: VERSION, map }));
  } catch (e) {
    console.error('[shortcuts] 保存键位失败', e && e.message);
  }
}

/**
 * 生效值：缺失 = 没配置过 → 用默认值；null = 用户主动清除 → 不回填默认。
 * 这两者语义必须分开，否则用户清掉一个键，重启后又回来了。
 */
function effective(actionId, map = readMap()) {
  if (Object.prototype.hasOwnProperty.call(map, actionId)) {
    const v = map[actionId];
    return v == null ? '' : String(v);
  }
  const a = ACTION_BY_ID.get(actionId);
  return a ? a.def : '';
}

/* ------------------------------ 注册 / 注销 ------------------------------ */

function fire(actionId) {
  try {
    onAction(actionId);
  } catch (e) {
    console.error('[shortcuts] 动作执行失败', actionId, e && e.message ? e.message : e);
  }
}

function unregisterFor(actionId) {
  const accel = registered.get(actionId);
  if (!accel) return;
  try { globalShortcut.unregister(accel); } catch (e) { /* 已失效就当没注册过 */ }
  registered.delete(actionId);
}

/**
 * 注册单个动作。若该键正被本应用注册着（理论上只在回滚时出现），先摘掉再注册。
 *
 * 关键：若同一个组合已经被**本应用另一个动作**占着（默认值撞车，或用户手动把两个动作
 * 设成同一个键），这里必须放弃，不能像以前那样先 unregister 再抢注 —— 那会让两个动作
 * 轮流把对方摘掉，而且 `registered` 里旧 id 的记录不会清，`list()` 里两边都显示"已注册"，
 * 表现就是「按 A 的键却触发了 B 的动作」这种极难排查的串台。
 * @returns {boolean}
 */
function registerOne(actionId) {
  const accel = effective(actionId);
  unregisterFor(actionId);
  if (!accel) return false;
  const holder = ACTION_IDS.find((id) => id !== actionId && registered.get(id) === accel);
  if (holder) {
    console.warn(`[shortcuts] ${actionId} 与 ${holder} 撞键（${accel}），后者保持生效，请在设置里改键`);
    return false;
  }
  try {
    if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
    const ok = globalShortcut.register(accel, () => fire(actionId));
    if (ok) registered.set(actionId, accel);
    return ok;
  } catch (e) {
    console.error('[shortcuts] 注册失败', accel, e && e.message ? e.message : e);
    return false;
  }
}

function registerAll() {
  ACTION_IDS.forEach((id) => { registerOne(id); });
}

/* ------------------------------ 对外操作 ------------------------------ */

/** 给渲染层的动作表（含当前值、是否已注册、是否被用户清空） */
function list() {
  const map = readMap();
  return {
    actions: ACTIONS.map((a) => {
      const accel = effective(a.id, map);
      const cleared = Object.prototype.hasOwnProperty.call(map, a.id) && map[a.id] == null;
      return {
        id: a.id,
        label: a.label,
        hint: a.hint,
        def: a.def,
        defText: displayAccel(a.def),
        accel,
        text: displayAccel(accel),
        cleared,
        custom: !cleared && accel !== a.def,
        registered: !!accel && registered.get(a.id) === accel,
      };
    }),
    inApp: IN_APP.map(([key, label]) => ({ key, label })),
    platform: process.platform,
  };
}

/**
 * 换键（原子）。
 * 顺序不能反：先摘旧键再试新键，一旦新键被系统占用，用户的旧键也没了。
 * @param {string} actionId
 * @param {string} rawAccel
 * @returns {{ok:boolean, message?:string, takenFrom?:string|null, reason?:string}}
 */
function apply(actionId, rawAccel) {
  if (!ACTION_BY_ID.has(actionId)) throw userError('未知的快捷键动作');
  const accel = normalizeAccel(rawAccel); // 校验失败直接抛，文案即用户可见文案
  const map = readMap();
  const cur = effective(actionId, map);
  // 1) 目标值没变 → 成功返回（顺便补注册一次，键可能因休眠丢了）
  if (cur === accel) {
    if (!registered.has(actionId) || registered.get(actionId) !== accel) registerOne(actionId);
    return { ok: true };
  }

  // 2) L1：该组合被本应用另一个动作占着 → 先摘掉它，记下来备回滚
  const owner = ACTION_IDS.find((id) => id !== actionId && effective(id, map) === accel) || null;
  if (owner) {
    unregisterFor(owner);
    map[owner] = null;
    writeMap(map);
  }

  // 3) 试注册新键
  if (globalShortcut.isRegistered(accel)) {
    // 同一个键被本应用注册着，但映射表里没人认领（历史脏数据）：先摘掉，失败再补回
    try { globalShortcut.unregister(accel); } catch (e) { /* 忽略 */ }
  }
  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => fire(actionId));
  } catch (e) {
    ok = false;
  }

  if (!ok) {
    // 失败：把第 2 步摘掉的绑定原样补回去，旧键保持不动
    if (owner) {
      map[owner] = accel;
      writeMap(map);
      registerOne(owner);
    }
    return {
      ok: false,
      reason: 'occupied',
      message: '该组合已被系统或其他程序占用，请换一个',
    };
  }

  // 4) 成功：摘旧键 → 落盘
  if (cur) unregisterFor(actionId);
  registered.set(actionId, accel);
  const next = readMap();
  next[actionId] = accel;
  writeMap(next);

  return {
    ok: true,
    takenFrom: owner ? (ACTION_BY_ID.get(owner) || {}).label || owner : null,
  };
}

/** 清除绑定（用户删掉这个键，不是恢复默认） */
function clear(actionId) {
  if (!ACTION_BY_ID.has(actionId)) throw userError('未知的快捷键动作');
  unregisterFor(actionId);
  const map = readMap();
  map[actionId] = null;
  writeMap(map);
  return { ok: true };
}

/** 恢复出厂：清掉全部自定义（含显式清除），按默认值重注册 */
function resetAll() {
  ACTION_IDS.forEach((id) => unregisterFor(id));
  writeMap({});
  const failed = [];
  ACTION_IDS.forEach((id) => { if (!registerOne(id)) failed.push((ACTION_BY_ID.get(id) || {}).label || id); });
  return { ok: true, failed };
}

/** 全部清除：所有全局键都变成「未设置」 */
function clearAll() {
  ACTION_IDS.forEach((id) => unregisterFor(id));
  const map = readMap();
  ACTION_IDS.forEach((id) => { map[id] = null; });
  writeMap(map);
  return { ok: true };
}

/**
 * 体检：休眠 / 唤醒、锁屏解锁后系统可能把热键丢掉，而 register() 只在启动时跑过一次。
 * 对每个映射做一次 isRegistered 检查，缺的补注册。
 */
function healthCheck() {
  if (!ready || !db.isReady()) return { restored: 0 };
  let restored = 0;
  ACTION_IDS.forEach((id) => {
    const accel = effective(id);
    if (!accel) return;
    if (globalShortcut.isRegistered(accel) && registered.get(id) === accel) return;
    if (registerOne(id)) restored += 1;
  });
  if (restored) console.log(`[shortcuts] 体检补注册 ${restored} 个热键`);
  return { restored };
}

/* ------------------------------ IPC ------------------------------ */

/** 键位变了 → 所有窗口（主窗口 / 捕捉条）的展示同步刷新 */
function notifyChanged() {
  const payload = list();
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w.isDestroyed()) return;
    try { w.webContents.send('keys:changed', payload); } catch (e) { /* 窗口正关闭 */ }
  });
}

function wrap(fn) {
  return async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (!(e && e.userFacing)) console.error('[shortcuts]', e && e.message ? e.message : e);
      return { __error: (e && e.message) || String(e) };
    }
  };
}

function registerIpc() {
  ipcMain.handle('keys:list', wrap(() => list()));
  ipcMain.handle('keys:apply', wrap((actionId, accel) => {
    const r = apply(actionId, accel);
    if (r.ok) notifyChanged();
    return r;
  }));
  ipcMain.handle('keys:clear', wrap((actionId) => {
    const r = clear(actionId);
    notifyChanged();
    return r;
  }));
  ipcMain.handle('keys:reset', wrap(() => {
    const r = resetAll();
    notifyChanged();
    return r;
  }));
  ipcMain.handle('keys:clearAll', wrap(() => {
    const r = clearAll();
    notifyChanged();
    return r;
  }));
  ipcMain.handle('keys:health', wrap(() => healthCheck()));
}

/* ------------------------------ 生命周期 ------------------------------ */

/**
 * @param {object} opts
 * @param {(actionId:string) => void} opts.onAction 动作分发（showWindow / quickAdd / capture.toggle …）
 */
function init(opts = {}) {
  onAction = opts.onAction || (() => {});
  // register() 必须在 app.whenReady() 之后：早于此时机静默失败
  ready = true;
  registerIpc();
  registerAll();

  // 休眠唤醒 / 锁屏解锁：注册可能被系统丢掉
  try {
    powerMonitor.on('resume', () => setTimeout(healthCheck, 1500));
    powerMonitor.on('unlock-screen', () => setTimeout(healthCheck, 800));
  } catch (e) {
    console.error('[shortcuts] powerMonitor 订阅失败', e && e.message ? e.message : e);
  }
  const missing = ACTION_IDS.filter((id) => effective(id) && !registered.has(id));
  if (missing.length) console.log(`[shortcuts] 启动时有 ${missing.length} 个热键未注册成功（可能被占用）`);
}

/** 退出前必须注销，否则系统里残留热键，下次启动可能注册失败 */
function destroy() {
  ready = false;
  try { globalShortcut.unregisterAll(); } catch (e) { /* 退出阶段不抛错 */ }
  registered.clear();
}

module.exports = {
  init, destroy, list, apply, clear, resetAll, clearAll, healthCheck,
  // 暴露触发入口：与 globalShortcut 注册时走的是同一个 fire()，
  // 便于自动化验证（真实按键注入在部分环境里不可用）与故障排查时手动触发一次动作。
  fire,
  displayAccel, normalizeAccel, ACTIONS,
};
