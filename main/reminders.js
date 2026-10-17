'use strict';
/**
 * 提醒调度：定时检查到期提醒，触发系统通知，并将任务窗口前置。
 */
const { Notification } = require('electron');
const db = require('./db');
const { showTrayNotification } = require('./tray');

const INTERVAL_MS = 30 * 1000; // 每 30 秒检查一次

let timer = null;

function startReminderScheduler({ onFocusTask } = {}) {
  if (timer) return;
  timer = setInterval(() => checkReminders(onFocusTask), INTERVAL_MS);
  // 启动后立即检查一次（补齐离线/睡眠期间错过的提醒）
  setTimeout(() => checkReminders(onFocusTask), 3000);
}

function stopReminderScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

function checkReminders({ onFocusTask } = {}) {
  try {
    const due = db.dueReminders();
    for (const task of due) {
      db.markReminderFired(task.id);
      const title = '任务提醒';
      const body = task.title;
      showTrayNotification({ title, body });

      if (Notification.isSupported()) {
        const n = new Notification({ title, body: task.title });
        n.on('click', () => onFocusTask && onFocusTask(task.id));
        n.show();
      }
    }
  } catch (e) {
    // 忽略调度异常，避免后台定时器崩溃
    console.error('[reminders]', e);
  }
}

module.exports = { startReminderScheduler, stopReminderScheduler };
