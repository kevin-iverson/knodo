'use strict';
/**
 * 工时插件 · v18 建表（由 db.js 的 MIGRATIONS 调用）。
 *
 * 只在迁移时被 require 一次：开关关闭的存量用户永远不会走到这里，
 * 所以「关闭态不加载模块」这条边界不会被这张空表破坏。
 *
 * 设计要点（方案 §六）：
 * - tasks 表不加任何字段，聚合全靠查询时递归 CTE；
 * - task_id 不加外键：任务删掉后记录要留着（报工需要历史），统计降级为「已删除任务」；
 * - group_id 是写入时的冗余快照，分组被删后报工仍能归集。
 */
function migrate(d) {
  d.exec(`
CREATE TABLE IF NOT EXISTS worklog_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL,
  group_id     INTEGER,
  started_at   TEXT    NOT NULL,
  ended_at     TEXT,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  source       TEXT    NOT NULL DEFAULT 'timer',
  status       TEXT    NOT NULL DEFAULT 'done',
  billable     INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  last_beat_at TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wl_task   ON worklog_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_wl_start  ON worklog_entries(started_at);
CREATE INDEX IF NOT EXISTS idx_wl_status ON worklog_entries(status);
`);
}

module.exports = { migrate };
