'use strict';
/**
 * 番茄钟（专注计时）—— 主进程单活跃会话的计时器。
 *
 * 为什么放主进程：渲染进程窗口隐藏 / 最小化时 Chromium 会把 setInterval 节流，
 * 倒计时会停摆（方案 RK-02）。这里用 wall clock 对账（不靠 tick 累加），
 * UI 每 500ms 只负责用「当前时间 - 段起点」重算显示。
 *
 * 结局（方案 §创意2）：
 *   full        跑满计划时长 → 1 格
 *   partial     中途手动结束且已跑 ≥ 8 分钟 → 0.5 格
 *   interrupted 暂停 / 真正离开（切走且系统无键鼠输入）超过 3 分钟 → 0.5 格（带原因）
 *   < 8 分钟结束 → 不记录（删除会话行，避免脏数据）
 *
 * 「离开」的判定（RK-03）：**不是**窗口失焦就算离开 —— 用户切到 IDE / 浏览器继续干活时，
 * 窗口是失焦的，但计时必须照常走。只有「没有任何 Knodo 窗口聚焦 **且** 系统连续 3 分钟
 * 无键盘鼠标输入」才判定为离开。计时本身永远按 wall clock 推进，不因失焦冻结。
 */
const { BrowserWindow, powerMonitor } = require('electron');
const db = require('./db');

const PAUSE_LIMIT_MS = 3 * 60 * 1000; // 暂停超 3 分钟自动按「被打断」结算
const IDLE_LIMIT_SEC = 3 * 60;        // 切走且系统无键鼠输入超 3 分钟 → 被打断
const MIN_PARTIAL_MS = 8 * 60 * 1000; // 8 分钟是「已经投入」的下限
const TICK_MS = 1000;

/** 单活跃会话状态 */
const state = {
  id: null,         // focus_sessions.id
  taskId: null,
  plannedSec: 1800, // 默认 30 分钟（用户拍板，可选 15/30/45）
  startedAt: 0,     // 会话开始（epoch ms）
  mode: 'idle',     // idle | running | paused | done
  focusedMs: 0,     // 累计专注毫秒（不含显式暂停）
  pausedMs: 0,      // 累计显式暂停毫秒
  focused: true,    // 当前是否有任一 Knodo 窗口持有系统焦点（仅用于「离开」判定，不影响计时推进）
  segStart: 0,      // 当前段起点（epoch ms）
  pendingOutcome: '', // done 态下待确认的结局
  pendingReason: '',  // done 态下的原因（被打断时）
};

let timer = null;
let onStateChange = null;   // (snapshot) => void，由 main.js 注入
let pendingNotice = '';     // 启动时「上次有一个 N 分钟的番茄已记上」的一次性提示

function active() {
  return state.mode !== 'idle';
}

function isRunning() {
  return state.mode === 'running';
}

/** 当前专注毫秒（含进行中段的未结算部分）。running 永远按 wall clock 前进，不因失焦冻结。 */
function focusedNow() {
  if (state.mode === 'running') {
    return state.focusedMs + (Date.now() - state.segStart);
  }
  return state.focusedMs;
}

function pausedNow() {
  if (state.mode === 'paused') return state.pausedMs + (Date.now() - state.segStart);
  return state.pausedMs;
}

/** 把当前段结算进累计值（模式切换 / 结算前调用），并重置段起点 */
function settleSegment() {
  const now = Date.now();
  const delta = Math.max(0, now - state.segStart);
  if (state.mode === 'running') state.focusedMs += delta;
  else if (state.mode === 'paused') state.pausedMs += delta;
  state.segStart = now;
}

function snapshot() {
  return {
    active: active(),
    id: state.id,
    taskId: state.taskId,
    plannedSec: state.plannedSec,
    startedAt: state.startedAt,
    mode: state.mode,
    focusedMs: state.focusedMs,
    pausedMs: state.pausedMs,
    focused: state.focused,
    segStart: state.segStart,
    pendingOutcome: state.pendingOutcome,
    pendingReason: state.pendingReason,
    notice: pendingNotice,
  };
}

function notify() {
  pendingNotice = ''; // 一次性提示只发一次
  if (onStateChange) {
    try { onStateChange(snapshot()); } catch (e) { /* 推送失败不影响计时 */ }
  }
}

function startTicker() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
}

function stopTicker() {
  if (timer) { clearInterval(timer); timer = null; }
}

function clearState() {
  state.id = null;
  state.taskId = null;
  state.plannedSec = 1800;
  state.startedAt = 0;
  state.mode = 'idle';
  state.focusedMs = 0;
  state.pausedMs = 0;
  state.focused = true;
  state.segStart = 0;
  state.pendingOutcome = '';
  state.pendingReason = '';
}

function toDone(outcome, reason) {
  settleSegment();
  state.mode = 'done';
  state.pendingOutcome = outcome;
  state.pendingReason = reason || '';
  notify();
}

function tick() {
  if (!active() || state.mode === 'done') return;
  // 只负责「到点 / 超限」判定；平滑显示由渲染层按 wall clock（segStart + 当前时间）自己重算，
  // 这里不做每 1s 推送，避免渲染层被高频事件逼着整表重绘。
  if (state.mode === 'running' && focusedNow() >= state.plannedSec * 1000) {
    toDone('full', '');
    return;
  }
  if (pausedNow() >= PAUSE_LIMIT_MS) {
    toDone('interrupted', '暂停超过 3 分钟');
    return;
  }
  // 真正离开：没有任何 Knodo 窗口聚焦 **且** 系统连续 3 分钟无键盘鼠标输入。
  // 切到别的应用继续操作时 idle 会被输入重置，不会触发；只有人真的走开了才算。
  if (state.mode === 'running' && !state.focused) {
    let idleSec = 0;
    try { idleSec = powerMonitor.getSystemIdleTime(); } catch (e) { idleSec = 0; }
    if (idleSec >= IDLE_LIMIT_SEC) toDone('interrupted', '离开超过 3 分钟');
  }
}

/* ---------------- 对外动作 ---------------- */

function init(opts = {}) {
  onStateChange = opts.onStateChange || null;
}

/**
 * 开钟。已有进行中的会话会先按 partial 结算（理论上层已阻止，兜底防脏数据）。
 * taskId 必填：番茄必须挂任务（不支持自由专注）。
 */
function start({ taskId = null, plannedSec = 1800 } = {}) {
  if (active()) settle('partial', '');
  const task = taskId != null ? db.getTask(taskId) : null;
  const row = db.createFocusSession({
    taskId,
    groupId: task ? task.group_id : null,
    plannedSec: Number(plannedSec) || 1800,
  });
  const now = Date.now();
  state.id = row.id;
  state.taskId = row.task_id;
  state.plannedSec = row.planned_sec;
  state.startedAt = now;
  state.mode = 'running';
  state.focusedMs = 0;
  state.pausedMs = 0;
  state.focused = true;
  state.segStart = now;
  state.pendingOutcome = '';
  state.pendingReason = '';
  startTicker();
  notify();
  return snapshot();
}

/** 暂停 / 恢复（应用内 Ctrl+Enter 或点击进度环） */
function togglePause() {
  if (state.mode === 'done' || state.mode === 'idle') return snapshot();
  settleSegment();
  state.mode = state.mode === 'running' ? 'paused' : 'running';
  notify();
  return snapshot();
}

/**
 * 结算会话。
 * @param {'full'|'partial'|'interrupted'} outcome
 * @param {string} note 收尾那句「做到哪了」
 * @returns 结算后的会话行（失败返回 null）
 */
function settle(outcome = 'full', note = '') {
  if (!active() || state.mode === 'idle') return null;
  settleSegment();
  const sec = Math.floor(state.focusedMs / 1000);
  const row = db.settleFocusSession(state.id, { outcome, actualSec: sec, note });
  clearState();
  stopTicker();
  notify();
  return row;
}

/** 误触结束（< 8 分钟）：删除会话行，不留记录 */
function cancel() {
  if (!active()) return;
  try { db.deleteFocusSession(state.id); } catch (e) { /* 忽略 */ }
  clearState();
  stopTicker();
  notify();
}

/** 手动结束入口：按已跑时长决定 partial（≥8min）还是 cancel（<8min），返回 { outcome, note } */
function manualEnd() {
  if (!active()) return { outcome: 'cancel' };
  const sec = Math.floor(focusedNow() / 1000);
  if (sec * 1000 < MIN_PARTIAL_MS) {
    cancel();
    return { outcome: 'cancel' };
  }
  settle('partial', '');
  return { outcome: 'partial' };
}

/**
 * 应用内窗口聚焦变化：只更新「是否有 Knodo 窗口聚焦」标记，**不再冻结计时**。
 * 计时本身始终按 wall clock 推进；这个标记只给 tick 的「真正离开」判定用。
 */
function onWindowFocusChanged() {
  if (!active()) return;
  const focused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
  state.focused = focused;
}

/**
 * 系统休眠前：把睡眠前的专注结算掉（segStart 停在挂起时刻，唤醒后按它排除睡眠时间）。
 * 不结算的话，唤醒时「now - segStart」会把整段睡眠也算进专注。
 */
function onPowerSuspend() {
  if (!active() || state.mode !== 'running') return;
  settleSegment();
}

/** 系统休眠唤醒：按 wall clock 对账（方案 §6.3） */
function onPowerResume() {
  if (!active() || state.mode === 'idle') return;
  const wall = Date.now() - state.startedAt;
  const plannedMs = state.plannedSec * 1000;
  if (wall >= plannedMs * 2) {
    // 睡过头：记半格并标「休眠中断」，不把睡眠时间算进专注
    db.settleFocusSession(state.id, { outcome: 'partial', actualSec: state.plannedSec, note: '休眠中断' });
    clearState();
    stopTicker();
    notify();
  } else if (wall >= plannedMs) {
    // 跨过结束点：按跑满记
    db.settleFocusSession(state.id, { outcome: 'full', actualSec: state.plannedSec, note: '' });
    clearState();
    stopTicker();
    notify();
  } else if (state.mode === 'running') {
    // 还没到：睡眠时间不计入专注（挂起时已结算过），重挂运行段
    state.segStart = Date.now();
    notify();
  }
}

/** 应用退出：进行中的番茄按已跑时长记 partial（≥8min），否则取消 */
function handleWillQuit() {
  if (!active()) return;
  const sec = Math.floor(focusedNow() / 1000);
  if (sec * 1000 < MIN_PARTIAL_MS) {
    try { db.deleteFocusSession(state.id); } catch (e) { /* 忽略 */ }
  } else {
    settleSegment();
    db.settleFocusSession(state.id, { outcome: 'partial', actualSec: sec, note: '' });
    pendingNotice = `上次有一个 ${Math.floor(sec / 60)} 分钟的番茄，已记上`;
  }
  clearState();
  stopTicker();
}

/**
 * 启动对账：崩溃 / 强杀残留的未结算会话（ended_at IS NULL）。
 * 按 started_at 到现在（cap 到 2 倍计划时长）记 partial；不足 8 分钟则删掉。
 * @returns {string} 有残留时返回一次性提示文案，否则空串
 */
function reconcileOnStartup() {
  if (!db.isReady()) return '';
  const stale = db.getActiveFocusSession();
  if (!stale) return '';
  const startedMs = new Date(stale.started_at).getTime();
  let actual = Math.floor((Date.now() - startedMs) / 1000);
  actual = Math.max(0, Math.min(actual, stale.planned_sec * 2));
  if (actual * 1000 < MIN_PARTIAL_MS) {
    db.deleteFocusSession(stale.id);
    return '';
  }
  db.settleFocusSession(stale.id, { outcome: 'partial', actualSec: actual, note: '' });
  pendingNotice = `上次有一个 ${Math.floor(actual / 60)} 分钟的番茄，已记上`;
  return pendingNotice;
}

function getState() {
  const s = snapshot();
  pendingNotice = ''; // 一次性提示只交付一次
  return s;
}

/** 只读快照（不清一次性提示）：桌面浮窗拉数据时用，避免抢走主窗口的启动提示 */
function peek() {
  return snapshot();
}

module.exports = {
  init,
  start,
  togglePause,
  settle,
  cancel,
  manualEnd,
  onWindowFocusChanged,
  onPowerSuspend,
  onPowerResume,
  handleWillQuit,
  reconcileOnStartup,
  getState,
  peek,
  isRunning,
};
