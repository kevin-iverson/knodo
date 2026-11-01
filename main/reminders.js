'use strict';
/**
 * 提醒调度：定时检查到期提醒，触发系统通知，并将任务窗口前置。
 *
 * 两条容易踩的坑（评审 P2-1 / P2-2）：
 *  1. **只发一条通知**。以前先调 tray 的 showTrayNotification()、再自己 new 一个 Notification，
 *     同一条提醒会弹两次。现在统一走 notify()，托盘模块只负责图标。
 *  2. **先弹再标记**。以前把 markReminderFired 放在弹窗之前，通知系统当前不可用（专注助手 /
 *     通知被关闭）就等于这条提醒永久消失。现在只有真正 show() 成功才标记，失败留到下一轮重试。
 *     另外，关机一周后开机会一次性补查所有过期提醒，逐条弹是灾难——超过 24h 的合并成一条摘要。
 */
const { Notification } = require('electron');
const db = require('./db');
const { NOTIFICATION_ICON } = require('./tray');

const INTERVAL_MS = 30 * 1000; // 每 30 秒检查一次
/** 超过这个时长的提醒不再逐条弹，合并成摘要 */
const STALE_MS = 24 * 60 * 60 * 1000;

let timer = null;

function startReminderScheduler({ onFocusTask } = {}) {
  if (timer) return;
  timer = setInterval(() => checkReminders({ onFocusTask }), INTERVAL_MS);
  // 启动后立即检查一次（补齐离线/睡眠期间错过的提醒）
  setTimeout(() => checkReminders({ onFocusTask }), 3000);
}

function stopReminderScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * 发一条系统通知。
 * @returns {boolean} 是否真的弹出来了（弹不出来就别标记已提醒，留给下一轮）
 */
function notify({ title, body, onClick }) {
  if (!Notification.isSupported()) return false;
  try {
    const n = new Notification({ title, body, icon: NOTIFICATION_ICON });
    if (typeof onClick === 'function') n.on('click', onClick);
    n.show();
    return true;
  } catch (e) {
    console.error('[reminders] 通知发送失败：', e && e.message ? e.message : e);
    return false;
  }
}

function checkReminders({ onFocusTask } = {}) {
  try {
    const due = db.dueReminders();
    if (!due.length) return;

    const now = Date.now();
    const fresh = [];
    const stale = [];
    for (const task of due) {
      const at = Date.parse(task.reminder_at);
      if (Number.isFinite(at) && now - at > STALE_MS) stale.push(task);
      else fresh.push(task);
    }

    for (const task of fresh) {
      const ok = notify({
        title: '任务提醒',
        body: task.title,
        onClick: () => onFocusTask && onFocusTask(task.id),
      });
      if (ok) db.markReminderFired(task.id); // 弹成功才标记；失败下轮重试
    }

    if (stale.length) {
      const body = stale.length === 1
        ? stale[0].title
        : `你有 ${stale.length} 条过期提醒，最早一条：${stale[0].title}`;
      const ok = notify({
        title: '过期提醒',
        body,
        onClick: () => onFocusTask && onFocusTask(stale[0].id),
      });
      if (ok) stale.forEach((t) => db.markReminderFired(t.id));
    }
  } catch (e) {
    // 忽略调度异常，避免后台定时器崩溃
    console.error('[reminders]', e);
  }
}

module.exports = { startReminderScheduler, stopReminderScheduler, checkReminders };
