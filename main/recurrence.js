'use strict';
/**
 * 重复待办「日切」调度。
 *
 * v17 起一条重复事项只有一条 tasks 行，规则是这条任务的属性。这里不再批量生成实例，
 * 只在启动 / 定时 / 跨自然日时调 db.syncRecurrences() 把这一行推进到下一次应发生日：
 * 刷新计划日期、提醒时间与「今天是否已完成」。提醒本身仍由 reminders.js 轮询触发。
 *
 * 三个触发时机：
 *  1. 启动立即推进（补齐离线期间跨过的天数）；
 *  2. 每 30 分钟一次（覆盖应用长期不关机的情况）；
 *  3. 每分钟检查一次自然日变化 —— 跨天要立刻重置打卡态与提醒标记，
 *     不能等最多 30 分钟，否则「每天 09:00 提醒」当天可能刚好错过。
 */
const db = require('./db');
const dateU = require('./date-utils');

const TICK_MS = 30 * 60 * 1000;
const DAY_CHECK_MS = 60 * 1000;

let tickTimer = null;
let dayTimer = null;
let lastDay = '';
let onDataChange = null;

function syncNow(reason = 'tick') {
  if (!db.isReady()) return null;
  const today = dateU.todayLocal();
  let result;
  try {
    result = db.syncRecurrences({ today });
  } catch (e) {
    console.error('[recurrence] 日切失败：', (e && e.message) || e);
    return null;
  }
  lastDay = today;
  if (result && result.updated && typeof onDataChange === 'function') {
    try { onDataChange({ ...result, reason, today }); } catch (e) { /* 广播失败不能影响日切 */ }
  }
  return result;
}

function startRecurrenceScheduler(opts = {}) {
  onDataChange = typeof opts.onDataChange === 'function' ? opts.onDataChange : null;
  if (tickTimer) return;
  // 启动日切放在 createWindow 之前：窗口第一次拉列表时，今天该出现的事项已经就位
  syncNow('startup');
  tickTimer = setInterval(() => syncNow('tick'), TICK_MS);
  dayTimer = setInterval(() => {
    if (dateU.todayLocal() !== lastDay) syncNow('day-change');
  }, DAY_CHECK_MS);
}

function stopRecurrenceScheduler() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (dayTimer) { clearInterval(dayTimer); dayTimer = null; }
  onDataChange = null;
}

module.exports = { startRecurrenceScheduler, stopRecurrenceScheduler, syncNow };
