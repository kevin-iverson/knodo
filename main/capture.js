'use strict';
/**
 * 快速捕捉条（Ctrl+Alt+C）。
 *
 * 它解决的是第三种意图：**不打算切换上下文，只把一闪念存下来**。
 * 所以它和 `Ctrl+Alt+B`（看）/ `Ctrl+Alt+N`（做）共享同一个「保存任务」的落库路径，
 * 但绝不允许调 showWindow() —— 主窗口一旦跳前台，"不打断"这件事就作废了。
 *
 * 关键约束：
 *  - 窗口单例 + hide 复用：每次新建会冷启动 200ms 白屏，手感全毁；
 *  - 必须抢焦点（要打字），靠 Esc 立刻归还来补偿；
 *  - 层级 screen-saver：浮窗是 floating，不压住就会把自己的捕捉条盖住；
 *  - 落在鼠标所在屏，不能写死主屏。
 */
const {
  BrowserWindow, ipcMain, screen,
} = require('electron');
const path = require('path');
const db = require('./db');
const attachments = require('./attachments');

/** settings['tool.capture']：与键位解耦，键改了不影响行为 */
const KEY = 'tool.capture';
/** 520×52：420 太窄（中文 18 字就换行），520 能容 24 字左右 */
const W = 520;
const H = 52;
/** 距工作区顶部 96px：避开 Windows 顶部搜索框，视觉上"浮着"而非"卡着" */
const TOP = 96;
/** 最近用过的清单候选个数（Tab 循环） */
const RECENT_MAX = 3;
/** 撤销窗口（与主窗口共用同一套 5 秒语义） */
const UNDO_MS = 5000;
/**
 * 下拉面板几何：必须和 capture.css 里的 .cap-picker / .cap-pick 完全对齐，
 * 否则窗口高度不够，最后一项会被裁掉（滚动条又是全局隐藏的，用户根本不知道还能滚）。
 */
const PICK_TOP = 56; // .cap-picker 的 top
const PICK_ROW = 30; // .cap-pick 的 height
const PICK_PAD = 12; // 面板上下 padding 5*2 + 边框 1*2
const PICK_SHADOW = 8; // 底部留白给投影
const PICK_MAX = 8; // 最多展开 8 行，再多就滚动

let win = null;
let getMainWindow = () => null;
let onDataChange = () => {};
let ready = false;

/** 当前目标清单（id），以及本次会话已记录条数（"已添加到 今天 · 1" 的那个 1） */
let targetId = null;
let sessionCount = 0;
/** 上一次保存，供 Ctrl+Z 撤销 */
let lastSaved = null;

/** 主窗口当前选中的清单（由渲染层同步过来，用于"从主窗口按 C"的落点判断） */
let contextGroupId = null;

/* ------------------------------ 配置 ------------------------------ */

function readCfg() {
  try {
    const v = JSON.parse(db.getSetting(KEY, '') || '{}');
    if (!v || typeof v !== 'object') return { lastGroupId: null, draft: '', recents: [] };
    return {
      lastGroupId: Number.isFinite(Number(v.lastGroupId)) && v.lastGroupId ? Number(v.lastGroupId) : null,
      draft: String(v.draft || ''),
      recents: Array.isArray(v.recents) ? v.recents.map(Number).filter(Number.isFinite) : [],
    };
  } catch (e) {
    return { lastGroupId: null, draft: '', recents: [] };
  }
}

function writeCfg(patch) {
  try {
    const cur = readCfg();
    const next = { ...cur, ...patch };
    next.recents = (next.recents || []).slice(0, RECENT_MAX);
    db.setSetting(KEY, JSON.stringify(next));
    return next;
  } catch (e) {
    console.error('[capture] 保存捕捉条配置失败', e && e.message);
    return readCfg();
  }
}

/* ------------------------------ 目标清单 ------------------------------ */

/** 分组是否存在（空清单也要能记，所以只看存在性，不看有没有任务） */
function groupName(id) {
  const g = id == null ? null : db.getGroup(id);
  return g ? g.name : '';
}

function lastAddGroupId() {
  const n = Number(db.getSetting('ui.lastAddGroupId', '') || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Tab 循环的候选：当前上下文 → 最近用过（3 个）→ 上次添加任务用的清单 → 其余分组。
 * 前四档全部来自「用户显式选择过的清单」，不含任何意图猜测；末尾补上其余分组，
 * 是为了让只有一两个清单的用户按 Tab 也能切（否则候选只有一个，Tab 看起来像没反应）。
 */
function candidates() {
  const out = [];
  const push = (id) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0 || out.includes(n)) return;
    if (!db.getGroup(n)) return; // 清单被删了就别留在候选里
    out.push(n);
  };
  push(contextGroupId);
  readCfg().recents.forEach(push);
  push(lastAddGroupId());
  db.listGroups().forEach((g) => push(g.id));
  // 上限 20：Tab 是"快速切"，不追求全集（全集在下拉里），但也不能比常见的分组数还少
  return out.slice(0, 20);
}

/**
 * 下拉里的全部清单：树形扁平化（子分组紧跟父分组），带 depth 用于缩进、
 * 带完整 path（「父 / 子」）用于跨级同名时区分 —— 分组名只在同一 parent 下唯一。
 * Tab 候选只有 12 个，下拉必须是全集，否则分组一多就"选不全"。
 */
function groupList() {
  const rows = db.listGroups();
  const byParent = new Map();
  rows.forEach((g) => {
    const key = g.parent_id == null ? 'root' : Number(g.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(g);
  });
  const out = [];
  const seen = new Set();
  const walk = (key, depth, path) => {
    (byParent.get(key) || []).forEach((g) => {
      if (seen.has(g.id)) return; // 数据异常（父子成环）时兜底，绝不让递归炸掉
      seen.add(g.id);
      const full = path ? `${path} / ${g.name}` : g.name;
      out.push({ id: g.id, name: g.name, parentId: g.parent_id == null ? null : Number(g.parent_id), depth, path: full });
      walk(g.id, depth + 1, full);
    });
  };
  walk('root', 0, '');
  // 环里的孤儿（父级已不存在）兜底追加，避免清单"消失"
  rows.forEach((g) => {
    if (!seen.has(g.id)) out.push({ id: g.id, name: g.name, parentId: g.parent_id == null ? null : Number(g.parent_id), depth: 0, path: g.name });
  });
  return out;
}

/** 本地日期 YYYY-MM-DD（plan_start / plan_end 就是这个格式，不能用 toISOString） */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 决定本次打开的目标：优先沿用上次落点，其次候选第一个 */
function resolveTarget() {
  const list = candidates();
  if (!list.length) return { id: null, name: '', groups: [] };
  const cfg = readCfg();
  const keep = list.includes(cfg.lastGroupId) ? cfg.lastGroupId : list[0];
  return { id: keep, name: groupName(keep), groups: list.map((id) => ({ id, name: groupName(id) })) };
}

function snapshot() {
  const t = resolveTarget();
  targetId = t.id;
  return {
    target: { id: t.id, name: t.name },
    targets: t.groups,
    groups: groupList(),
    hasGroups: t.groups.length > 0,
    count: sessionCount,
    theme: db.getSetting('theme', 'system'),
  };
}

/* ------------------------------ 窗口 ------------------------------ */

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    title: 'Knodo',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 隐藏时也要能接收事件，不做后台节流
      backgroundThrottling: false,
    },
  });
  // 浮窗是 floating 级：捕捉条必须再高一级，否则会被自己的浮窗压住
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'capture.html'));

  // 点到别处 = 收起（与"记一条就走"的语义一致），草稿留在渲染层内存里
  win.on('blur', () => { if (win && !win.isDestroyed() && win.isVisible()) win.hide(); });
  win.on('closed', () => { win = null; });
  return win;
}

/** 鼠标所在屏：写死主屏会让副屏用户永远看不到条 */
function placeWindow() {
  if (!win || win.isDestroyed()) return;
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt);
  const wa = d.workArea;
  const x = Math.round(wa.x + (wa.width - W) / 2);
  const y = Math.round(wa.y + Math.min(TOP, Math.max(0, wa.height - H - 8)));
  win.setPosition(x, y);
}

function sendState() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('capture:show', snapshot());
  } catch (e) {
    // 渲染层还没就绪是常态（只吞掉），但快照算不出来是 bug：不记日志就只剩"条弹出来是空的"
    if (!win.webContents.isLoading()) console.error('[capture] 状态推送失败', e && e.message ? e.message : e);
  }
}

/**
 * 开 / 关（幂等）。
 * @param {object} [opts]
 * @param {number|null} [opts.contextGroupId] 本次上下文清单（桌面浮窗对应的清单 / 主窗口选中项）
 */
function toggle(opts = {}) {
  if (!db.isReady()) return { ok: false, reason: 'db' };
  const w = ensureWindow();
  if (w.isVisible()) {
    w.hide();
    return { ok: true, visible: false };
  }
  if (opts.contextGroupId !== undefined) contextGroupId = opts.contextGroupId;
  const state = snapshot();
  applyContentHeight(H); // 上次可能停在下拉展开的高度，先收回 52px
  placeWindow();
  w.show();
  // 隐藏态量到的 contentSize 有 1~2px 偏差，显示后按真实尺寸再收敛一次
  applyContentHeight(H);
  w.focus();
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', sendState);
  else sendState();
  return { ok: true, visible: true, state };
}

function hide() {
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide();
    return true;
  }
  return false;
}

function isVisible() {
  return !!(win && !win.isDestroyed() && win.isVisible());
}

/* ------------------------------ 下拉面板 ------------------------------ */

/**
 * 清单下拉要临时加高窗口：条本身只有 52px，列表放不下。
 * 顶部位置固定（placeWindow 用 workArea.y + TOP），所以只改高度，不用重定位。
 * @param {{open?:boolean, count?:number}} opts
 */
function picker(opts = {}) {
  if (!win || win.isDestroyed()) return { ok: false };
  const rows = Math.max(1, Math.min(Number(opts.count) || 1, PICK_MAX));
  const h = opts.open ? PICK_TOP + rows * PICK_ROW + PICK_PAD + PICK_SHADOW : H;
  applyContentHeight(h);
  return { ok: true, height: h };
}

/**
 * 透明无边框窗在 Windows 上的内容尺寸和请求值有常量偏差（desktop-window 踩过同样的坑），
 * 所以设完量一次、按差值补一次。
 */
function applyContentHeight(h) {
  if (!win || win.isDestroyed()) return;
  const target = Math.max(H, Math.min(420, Math.round(h)));
  const [, cur] = win.getContentSize();
  if (cur === target) return;
  win.setContentSize(W, target);
  const [, got] = win.getContentSize();
  if (got !== target) win.setContentSize(W, target - (got - target));
}

/** 下拉里点选清单：写盘并同步最近清单，Tab 的候选顺序随之更新 */
function setTarget(id) {
  const n = Number(id);
  const g = db.getGroup(n);
  if (!g) throw userError('这个清单已经被删除了');
  targetId = n;
  writeCfg({ lastGroupId: n, recents: [n, ...readCfg().recents.filter((x) => x !== n)] });
  return {
    target: { id: n, name: g.name },
    targets: candidates().map((cid) => ({ id: cid, name: groupName(cid) })),
  };
}

/* ------------------------------ 保存 / 撤销 ------------------------------ */

/** 保存一条：落库 → 记住落点与最近清单 → 通知其它窗口刷新 */
function save(rawTitle) {
  if (!db.isReady()) throw new Error('数据库未就绪');
  const title = String(rawTitle == null ? '' : rawTitle).trim();
  // 校验类错误：文案直接展示给用户，日志里不当异常
  if (!title) throw userError('先写点什么再存');
  if (title.length > 200) throw userError('太长了一点（最多 200 字）');

  const t = resolveTarget();
  if (!t.id) {
    const e = userError('还没有清单，先在主窗口建一个');
    e.code = 'NO_GROUP';
    throw e;
  }
  // 捕捉条记的都是「当下要处理的事」：默认计划今天，加完立刻出现在「今天」视图，
  // 不会出现"记了却找不到"。要改期去主窗口改，这里不弹任何选择框。
  const today = todayStr();
  const task = db.createTask({ title, groupId: t.id, planStart: today, planEnd: today });
  sessionCount += 1;
  lastSaved = { id: task.id, title: task.title, at: Date.now() };
  const cfg = writeCfg({
    lastGroupId: t.id,
    draft: '',
    recents: [t.id, ...readCfg().recents.filter((x) => x !== t.id)],
  });
  // 与主窗口同一口径：下次在别处按 C 也落到这个清单
  try { db.setSetting('ui.lastAddGroupId', String(t.id)); } catch (e) { /* 非关键 */ }
  try { onDataChange({ taskId: task.id, created: true }); } catch (e) { /* 刷新失败不影响已保存 */ }
  return {
    ok: true,
    task: { id: task.id, title: task.title },
    target: { id: t.id, name: t.name || groupName(t.id) },
    count: sessionCount,
    recents: cfg.recents,
  };
}

/** 撤销上一条（5 秒内有效，与主窗口同一套语义） */
function undo() {
  if (!lastSaved || Date.now() - lastSaved.at > UNDO_MS) {
    return { ok: false, reason: 'expired' };
  }
  const { id, title } = lastSaved;
  lastSaved = null;
  const ok = db.deleteTask(id);
  try { attachments.removeTaskDir(id); } catch (e) { /* 清理失败不影响删库结果 */ }
  if (ok) {
    sessionCount = Math.max(0, sessionCount - 1);
    try { onDataChange({ taskId: id, removed: true }); } catch (e) { /* 忽略 */ }
  }
  return { ok: !!ok, title };
}

/** Tab：切到下一个候选清单 */
function cycle() {
  const list = candidates();
  if (list.length <= 1) return snapshot();
  const i = list.indexOf(targetId);
  targetId = list[(i + 1 + list.length) % list.length];
  writeCfg({ lastGroupId: targetId, recents: [targetId, ...readCfg().recents.filter((x) => x !== targetId)] });
  return {
    target: { id: targetId, name: groupName(targetId) },
    targets: list.map((id) => ({ id, name: groupName(id) })),
    hasGroups: true,
    count: sessionCount,
  };
}

/** 主窗口选中项变化 → 记住它，等下次按 C 时作为上下文 */
function setContext(groupId) {
  const n = Number(groupId);
  contextGroupId = Number.isFinite(n) && n > 0 ? n : null;
  return true;
}

function openMain() {
  const mw = getMainWindow();
  if (!mw || mw.isDestroyed()) return false;
  if (mw.isMinimized()) mw.restore();
  mw.show();
  mw.focus();
  mw.webContents.send('ui:quick-add');
  return true;
}

/* ------------------------------ IPC ------------------------------ */

function userError(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

function wrap(fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      if (!(e && e.userFacing)) console.error('[capture]', e && e.message ? e.message : e);
      return { __error: (e && e.message) || String(e) };
    }
  };
}

function registerIpc() {
  ipcMain.handle('capture:toggle', wrap((_e, opts) => toggle(opts || {})));
  ipcMain.handle('capture:hide', wrap(() => ({ ok: hide() })));
  ipcMain.handle('capture:state', wrap(() => snapshot()));
  ipcMain.handle('capture:save', wrap((_e, title) => save(title)));
  ipcMain.handle('capture:undo', wrap(() => undo()));
  ipcMain.handle('capture:cycle', wrap(() => cycle()));
  ipcMain.handle('capture:setContext', wrap((_e, groupId) => setContext(groupId)));
  ipcMain.handle('capture:setTarget', wrap((_e, id) => setTarget(id)));
  ipcMain.handle('capture:picker', wrap((_e, opts) => picker(opts || {})));
  ipcMain.handle('capture:openMain', wrap(() => ({ ok: openMain() })));
}

/**
 * @param {object} opts
 * @param {() => BrowserWindow|null} opts.getMainWindow
 * @param {(payload:object) => void} [opts.onDataChange] 数据变化（浮窗 / 主窗口刷新）
 */
function init(opts = {}) {
  getMainWindow = opts.getMainWindow || (() => null);
  onDataChange = opts.onDataChange || (() => {});
  registerIpc();
  ready = true;
  // 启动时预创建隐藏窗口：第一次按 C 才不会有 200ms 冷启动白屏
  if (!db.isReady()) return;
  try { ensureWindow(); } catch (e) { console.error('[capture] 预创建失败', e && e.message); }
}

function destroy() {
  ready = false;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = {
  init, destroy, toggle, hide, isVisible, save, undo, cycle, setContext, openMain,
  setTarget, picker, candidates, groupList, KEY,
};
