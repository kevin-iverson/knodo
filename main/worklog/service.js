'use strict';
/**
 * 计时引擎（方案 §六「计时引擎」）。
 *
 * 三条原则：
 *  - **wall clock**：时长永远由「当前时间 - 段起点」算出，不靠 tick 累加；
 *  - **单调累加**：暂停只结算段，不把暂停时长搬进累计值（否则会重复扣减）；
 *  - **单活跃会话**：同一时刻只有一条 running 记录。
 */
const { powerMonitor, dialog } = require('electron');
const db = require('../db');
const store = require('./store');

const BEAT_MS = 60 * 1000;            // 心跳：崩溃后误差 ≤ 1 分钟
const MAX_RECOVER_MS = 12 * 3600_000; // 崩溃恢复上限：超过 12h 按 12h 记并标异常
const MIN_KEEP_SEC = 60;              // < 1 分钟视为误触，丢弃
const SLEEP_GAP_MS = 15 * 60 * 1000;  // 休眠超过 15 分钟才提示是否扣除

const state = {
  id: null,
  taskId: null,
  mode: 'idle',   // idle | running | paused
  accMs: 0,       // 已结算累计毫秒（不含当前段）
  segStart: 0,    // 当前段起点（epoch ms）
  startedAt: 0,   // 本次计时首次开始（epoch ms，仅展示用）
  source: 'timer',
};

let beatTimer = null;
let onChanged = null;   // (snap) => void，由 features 注入
let suspendedAt = 0;
let powerBound = false; // 关→开会再走一次 init，powerMonitor 监听只能挂一遍

/* ------------------------------ 内部工具 ------------------------------ */

function notify() {
  if (!onChanged) return;
  try { onChanged(snapshot()); } catch (e) { /* 推送失败不影响计时 */ }
}

function taskTitleOf(taskId) {
  const t = db.getTask(taskId);
  return t ? t.title : '';
}

function snapshot() {
  return {
    mode: state.mode,
    id: state.id,
    taskId: state.taskId,
    taskTitle: state.taskId == null ? '' : taskTitleOf(state.taskId),
    startedAt: state.startedAt,
    accMs: state.accMs,
    segStart: state.segStart,
    source: state.source,
  };
}

/** 当前累计毫秒（running 时含未结算的当前段） */
function elapsedMs() {
  if (state.mode === 'running') return state.accMs + Math.max(0, Date.now() - state.segStart);
  return state.accMs;
}

/** 把当前段结算进累计值并重置段起点 */
function settleSegment() {
  const now = Date.now();
  if (state.mode === 'running') state.accMs += Math.max(0, now - state.segStart);
  state.segStart = now;
}

function clearState() {
  state.id = null;
  state.taskId = null;
  state.mode = 'idle';
  state.accMs = 0;
  state.segStart = 0;
  state.startedAt = 0;
  state.source = 'timer';
}

function startBeat() {
  if (beatTimer) return;
  beatTimer = setInterval(() => {
    if (state.mode === 'running' && state.id != null) store.beat(state.id);
  }, BEAT_MS);
}

function stopBeat() {
  if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
}

/** 同任务时间区间重叠检测（RK-03）：相交超过 1 分钟才提示，避免误报 */
function overlapWarning(taskId, fromIso, toIso) {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return '';
  let worst = 0;
  for (const e of store.listEntries(taskId)) {
    if (!e.ended_at) continue;
    const a = new Date(e.started_at).getTime();
    const b = new Date(e.ended_at).getTime();
    const inter = Math.min(to, b) - Math.max(from, a);
    if (inter > worst) worst = inter;
  }
  if (worst > 60 * 1000) return `这段时间与已有记录重叠约 ${Math.round(worst / 60000)} 分钟，请核对`;
  return '';
}

/* ------------------------------ 对外动作 ------------------------------ */

function init(opts = {}) {
  onChanged = opts.onChanged || null;
  startBeat();
  if (!powerBound) {
    powerBound = true;
    // 休眠：先把当前段结算掉（唤醒后不会把睡眠时间算进工时）
    powerMonitor.on('suspend', () => {
      if (state.mode === 'running') {
        settleSegment();
        suspendedAt = Date.now();
        notify();
      }
    });
    powerMonitor.on('resume', () => {
      if (!suspendedAt) return;
      const gap = Date.now() - suspendedAt;
      suspendedAt = 0;
      if (state.mode === 'idle' || gap < SLEEP_GAP_MS) return;
      // 默认扣除：段已在 suspend 时结算，这里什么都不补；
      // 用户坚持「睡眠期间也在干活」才把睡眠时长补回累计值。
      const minutes = Math.round(gap / 60000);
      dialog.showMessageBox({
        type: 'question',
        title: '工时计时',
        message: `系统休眠了约 ${minutes} 分钟`,
        detail: '默认从本次工时里扣除这段睡眠时间。如果你在睡眠期间仍在工作，可以选择「计入」。',
        buttons: ['扣除（推荐）', '计入'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 1 && state.mode !== 'idle') {
          state.accMs += gap;
          state.segStart = Date.now();
          notify();
        }
      }).catch(() => {});
    });
  }
}

/** 开始计时；已有会话先结算（上层已阻止时这里只是兜底） */
function start({ taskId, source = 'timer' } = {}) {
  const id = Number(taskId);
  const task = Number.isFinite(id) ? db.getTask(id) : null;
  if (!task) throw new Error('任务不存在，无法开始计时');
  if (state.mode !== 'idle') stop({ silent: true });

  const now = Date.now();
  const row = store.createEntry({
    taskId: task.id,
    groupId: task.group_id,
    startedAt: new Date(now).toISOString(),
    status: 'running',
    source: source === 'zen' ? 'zen' : 'timer',
    lastBeatAt: new Date(now).toISOString(),
  });
  state.id = row.id;
  state.taskId = task.id;
  state.mode = 'running';
  state.accMs = 0;
  state.segStart = now;
  state.startedAt = now;
  state.source = row.source;
  startBeat();
  notify();
  return snapshot();
}

function pause() {
  if (state.mode !== 'running') return snapshot();
  settleSegment();
  state.mode = 'paused';
  if (state.id != null) store.beat(state.id);
  notify();
  return snapshot();
}

function resume() {
  if (state.mode !== 'paused') return snapshot();
  state.segStart = Date.now();
  state.mode = 'running';
  notify();
  return snapshot();
}

/**
 * 结束并入库。不足 1 分钟按误触丢弃（FR-02）。
 * @returns {{discarded:boolean, sec:number, entry:object|null, warning:string}}
 */
function stop({ silent = false } = {}) {
  if (state.mode === 'idle') return { discarded: false, sec: 0, entry: null, warning: '' };
  settleSegment();
  const sec = Math.floor(state.accMs / 1000);
  const endedAt = new Date().toISOString();
  const startedAt = new Date(state.startedAt).toISOString();
  const id = state.id;
  const taskId = state.taskId;
  const warning = overlapWarning(taskId, startedAt, endedAt);

  let entry = null;
  if (sec < MIN_KEEP_SEC) {
    entry = store.settleEntry(id, { endedAt, durationSec: sec, status: 'discarded' });
  } else {
    entry = store.settleEntry(id, { endedAt, durationSec: sec, status: 'done' });
  }
  clearState();
  stopBeat();
  if (!silent) notify();
  return { discarded: sec < MIN_KEEP_SEC, sec, entry, warning };
}

/**
 * 退出前结算：有进行中的计时就落库（不足 1 分钟丢弃）。
 * 不走 notify —— 渲染层此刻正在关闭。
 */
function handleWillQuit() {
  if (state.mode === 'idle') return;
  settleSegment();
  const sec = Math.floor(state.accMs / 1000);
  const endedAt = new Date().toISOString();
  if (sec < MIN_KEEP_SEC) {
    store.settleEntry(state.id, { endedAt, durationSec: sec, status: 'discarded' });
  } else {
    store.settleEntry(state.id, { endedAt, durationSec: sec, status: 'done' });
  }
  clearState();
  stopBeat();
}

/**
 * 启动对账：崩溃 / 强杀残留的 running 行，按**最后一次心跳**结算（FR-10）。
 * 超过 12h 仍无心跳 → 按 12h 记并标「疑似异常」。
 */
function reconcileOnStartup() {
  if (!db.isReady()) return [];
  const notices = [];
  for (const row of store.listRunning()) {
    const beatIso = row.last_beat_at || row.started_at;
    const beatMs = new Date(beatIso).getTime();
    let ms = Number.isFinite(beatMs) ? Date.now() - beatMs : 0;
    let abnormal = false;
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    if (ms > MAX_RECOVER_MS) { ms = MAX_RECOVER_MS; abnormal = true; }
    const sec = Math.floor(ms / 1000);
    const endedAt = new Date().toISOString();
    if (sec < MIN_KEEP_SEC) {
      store.settleEntry(row.id, { endedAt, durationSec: sec, status: 'discarded' });
      continue;
    }
    const note = abnormal ? '疑似异常：超过 12 小时无心跳，按 12 小时结算' : '疑似异常：按最后心跳结算';
    store.settleEntry(row.id, { endedAt, durationSec: sec, status: 'done', note });
    notices.push(`上次有一个 ${Math.round(sec / 60)} 分钟的工时尚在计时，已按最后心跳结算`);
  }
  return notices;
}

/** 补录（FR-04）：时长 = 结束 - 开始；跨天按开始日归属 */
function addManual({ taskId, date, start, end, note = '', billable = 1 } = {}) {
  const id = Number(taskId);
  const task = Number.isFinite(id) ? db.getTask(id) : null;
  if (!task) throw new Error('任务不存在，无法补录');
  const day = String(date || '').trim();
  const from = String(start || '').trim();
  const to = String(end || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式应为 YYYY-MM-DD');
  if (!/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) throw new Error('时间格式应为 HH:mm');

  const started = new Date(`${day}T${from.padStart(5, '0')}:00`);
  const ended = new Date(`${day}T${to.padStart(5, '0')}:00`);
  if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime())) throw new Error('日期或时间无法识别');
  // 结束早于开始 = 跨天（例：23:30 → 00:40），仍归属开始日
  if (ended.getTime() <= started.getTime()) ended.setDate(ended.getDate() + 1);
  const sec = Math.round((ended.getTime() - started.getTime()) / 1000);
  if (sec < MIN_KEEP_SEC) throw new Error('时长不足 1 分钟，已丢弃');
  if (sec > 24 * 3600) throw new Error('单条补录不能超过 24 小时');

  return store.createEntry({
    taskId: task.id,
    groupId: task.group_id,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationSec: sec,
    source: 'manual',
    status: 'done',
    billable,
    note,
    lastBeatAt: ended.toISOString(),
  });
}

/** 关闭插件前：进行中的计时先结算，别把用户正在跑的时段丢掉 */
function shutdown() {
  handleWillQuit();
  stopBeat();
  onChanged = null;
}

function getState() {
  return snapshot();
}

module.exports = {
  init,
  start,
  pause,
  resume,
  stop,
  handleWillQuit,
  reconcileOnStartup,
  addManual,
  shutdown,
  getState,
  elapsedMs,
};
