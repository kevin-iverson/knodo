'use strict';
/**
 * SQLite 数据访问层（Data Access Layer）。
 * 时间字段约定：
 * - plan_start / plan_end：计划开始/完成日期，存储 "YYYY-MM-DD"（仅年月日，无时分秒）。
 * - reminder_at：提醒时间，存储 UTC ISO 8601 字符串。
 * - completed_at：实际完成时间，存储 UTC ISO 8601 字符串（完成任务时自动记录）。
 * - created_at / updated_at：UTC ISO 8601。
 * 该模块不依赖 Electron，可独立在 Node 下做冒烟测试。
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#4f7cff',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id       INTEGER,
  parent_id      INTEGER,
  title          TEXT    NOT NULL,
  notes          TEXT    NOT NULL DEFAULT '',
  attachments    TEXT    NOT NULL DEFAULT '[]',
  priority       INTEGER NOT NULL DEFAULT 1,
  plan_start     TEXT,
  plan_end       TEXT,
  reminder_at    TEXT,
  reminder_fired INTEGER NOT NULL DEFAULT 0,
  completed      INTEGER NOT NULL DEFAULT 0,
  completed_at   TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT    NOT NULL UNIQUE,
  color TEXT    NOT NULL DEFAULT '#8896ab'
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id INTEGER NOT NULL,
  tag_id  INTEGER NOT NULL,
  PRIMARY KEY (task_id, tag_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)  REFERENCES tags(id)  ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(completed, archived);
CREATE INDEX IF NOT EXISTS idx_tasks_plan_end ON tasks(plan_end);
CREATE INDEX IF NOT EXISTS idx_tasks_plan_start ON tasks(plan_start);
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at);
`;

const MIGRATIONS = [
  // v1：初始建表
  (d) => { d.exec(SCHEMA); },
  // v2：计划日期字段（due_at → plan_end，新增 plan_start）
  (d) => {
    const cols = d.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!cols.includes('plan_start')) {
      d.exec('ALTER TABLE tasks ADD COLUMN plan_start TEXT');
    }
    if (cols.includes('due_at')) {
      d.exec('ALTER TABLE tasks RENAME COLUMN due_at TO plan_end');
      // 旧值为 datetime，截取前 10 位转为纯日期
      d.exec(`UPDATE tasks SET plan_end = substr(plan_end, 1, 10) WHERE plan_end IS NOT NULL AND length(plan_end) > 10`);
    } else if (!cols.includes('plan_end')) {
      d.exec('ALTER TABLE tasks ADD COLUMN plan_end TEXT');
    }
    d.exec('DROP INDEX IF EXISTS idx_tasks_due');
    d.exec('CREATE INDEX IF NOT EXISTS idx_tasks_plan_end ON tasks(plan_end)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_tasks_plan_start ON tasks(plan_start)');
  },
  // v3：子任务（parent_id 自引用，指向父任务 id）
  (d) => {
    const cols = d.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!cols.includes('parent_id')) {
      d.exec('ALTER TABLE tasks ADD COLUMN parent_id INTEGER');
    }
    d.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)');
  },
  // v4：图片附件（JSON 数组，base64）
  (d) => {
    const cols = d.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!cols.includes('attachments')) {
      d.exec("ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    }
  },
];

function init(dbDir, dbFileName = 'todo.db') {
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, dbFileName);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    const run = db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    });
    run();
  }
  seedDefaults();
  return db;
}

function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 init()');
  return db;
}

/** 关闭数据库连接 */
function close() {
  if (db) {
    try { db.close(); } catch (e) { /* ignore */ }
    db = null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function seedDefaults() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM groups').get().c;
  if (count === 0) {
    const insert = db.prepare(
      'INSERT INTO groups (name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    const t = nowIso();
    insert.run('工作', '#4f7cff', 0, t, t);
    insert.run('生活', '#23b07e', 1, t, t);
  }
}

/* ------------------------------ 通用工具 ------------------------------ */

function normalizeTask(row) {
  if (!row) return null;
  const t = { ...row };
  t.completed = !!t.completed;
  t.archived = !!t.archived;
  t.priority = Number(t.priority);
  t.tag_ids = t.tag_ids ? t.tag_ids.split(',').map(Number) : [];
  t.tag_names = t.tag_names ? t.tag_names.split(',') : [];
  t.subtask_count = Number(t.subtask_count || 0);
  t.subtask_done = Number(t.subtask_done || 0);
  try { t.attachments = JSON.parse(t.attachments || '[]'); } catch (e) { t.attachments = []; }
  return t;
}

const TASK_SELECT = `
SELECT t.*, g.name AS group_name, g.color AS group_color,
  p.title AS parent_title,
  (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS subtask_count,
  (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.completed = 1) AS subtask_done,
  (SELECT group_concat(tg.tag_id) FROM task_tags tg WHERE tg.task_id = t.id) AS tag_ids,
  (SELECT group_concat(tag.name) FROM tags tag JOIN task_tags tt ON tt.tag_id = tag.id WHERE tt.task_id = t.id) AS tag_names
FROM tasks t
LEFT JOIN groups g ON g.id = t.group_id
LEFT JOIN tasks p ON p.id = t.parent_id
`;

/* ------------------------------ 分组 ------------------------------ */

function listGroups(includeEmpty = true) {
  const rows = db
    .prepare('SELECT * FROM groups ORDER BY sort_order ASC, id ASC')
    .all();
  if (!includeEmpty) return rows;
  const counts = db
    .prepare(
      `SELECT group_id, COUNT(*) AS c FROM tasks WHERE completed = 0 AND archived = 0 GROUP BY group_id`
    )
    .all();
  const map = new Map(counts.map((r) => [r.group_id, r.c]));
  return rows.map((g) => ({ ...g, active_count: map.get(g.id) || 0 }));
}

function createGroup({ name, color = '#4f7cff' }) {
  const t = nowIso();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM groups').get().m;
  const info = db
    .prepare('INSERT INTO groups (name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, color, max + 1, t, t);
  return getGroup(info.lastInsertRowid);
}

function getGroup(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id) || null;
}

function updateGroup(id, { name, color }) {
  const cur = getGroup(id);
  if (!cur) return null;
  db.prepare('UPDATE groups SET name = ?, color = ?, updated_at = ? WHERE id = ?')
    .run(name ?? cur.name, color ?? cur.color, nowIso(), id);
  return getGroup(id);
}

function deleteGroup(id) {
  const info = db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  return info.changes > 0;
}

function reorderGroups(ids) {
  const stmt = db.prepare('UPDATE groups SET sort_order = ? WHERE id = ?');
  const tx = db.transaction((arr) => {
    arr.forEach((gid, i) => stmt.run(i, gid));
  });
  tx(ids);
}

/* ------------------------------ 任务 ------------------------------ */

/**
 * 查询任务。
 * @param {object} f 过滤条件：groupId / status(active|completed|archived|all) / tagId /
 *   priority / search / sort，以及时间筛选：
 *   planStartFrom / planStartTo（计划开始日期范围，YYYY-MM-DD）
 *   planEndFrom / planEndTo（计划完成日期范围，YYYY-MM-DD）
 *   completedFrom / completedTo（实际完成时间范围，UTC ISO）
 */
function listTasks(f = {}) {
  const where = [];
  const params = [];

  // 子任务过滤：默认返回所有任务（含子任务）；parentId 指定时仅返回该父任务的子任务
  if (f.parentId != null) {
    where.push('t.parent_id = ?');
    params.push(f.parentId);
  }

  if (f.groupId != null && f.groupId !== 'all') {
    where.push('t.group_id = ?');
    params.push(f.groupId);
  }
  switch (f.status) {
    case 'active':
      where.push('t.completed = 0 AND t.archived = 0');
      break;
    case 'completed':
      where.push('t.completed = 1 AND t.archived = 0');
      break;
    case 'archived':
      where.push('t.archived = 1');
      break;
    case 'all':
    default:
      where.push('t.archived = 0');
      break;
  }
  if (f.tagId != null) {
    where.push('EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag_id = ?)');
    params.push(f.tagId);
  }
  if (f.priority != null) {
    where.push('t.priority = ?');
    params.push(f.priority);
  }
  if (f.search) {
    const kw = `%${f.search}%`;
    where.push(
      `(t.title LIKE ? OR t.notes LIKE ? OR EXISTS (
         SELECT 1 FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
         WHERE tt.task_id = t.id AND tg.name LIKE ?
       ))`
    );
    params.push(kw, kw, kw);
  }
  // 时间筛选
  if (f.planStartFrom) { where.push('t.plan_start IS NOT NULL AND t.plan_start >= ?'); params.push(f.planStartFrom); }
  if (f.planStartTo) { where.push('t.plan_start IS NOT NULL AND t.plan_start <= ?'); params.push(f.planStartTo); }
  if (f.planEndFrom) { where.push('t.plan_end IS NOT NULL AND t.plan_end >= ?'); params.push(f.planEndFrom); }
  if (f.planEndTo) { where.push('t.plan_end IS NOT NULL AND t.plan_end <= ?'); params.push(f.planEndTo); }
  if (f.completedFrom) { where.push('t.completed_at IS NOT NULL AND t.completed_at >= ?'); params.push(f.completedFrom); }
  if (f.completedTo) { where.push('t.completed_at IS NOT NULL AND t.completed_at <= ?'); params.push(f.completedTo); }

  let order = 't.completed ASC, (t.plan_end IS NULL) ASC, t.plan_end ASC, t.priority DESC, t.sort_order ASC, t.id DESC';
  if (f.sort === 'priority') order = 't.completed ASC, t.priority DESC, (t.plan_end IS NULL) ASC, t.plan_end ASC, t.sort_order ASC';
  if (f.sort === 'due') order = 't.completed ASC, (t.plan_end IS NULL) ASC, t.plan_end ASC, t.priority DESC, t.sort_order ASC';

  const sql = `${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order}`;
  return db.prepare(sql).all(...params).map(normalizeTask);
}

function getTask(id) {
  return normalizeTask(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id));
}

function createTask({
  title,
  groupId = null,
  parentId = null,
  notes = '',
  attachments = [],
  priority = 1,
  planStart = null,
  planEnd = null,
  reminderAt = null,
  completedAt = null,
  tagIds = [],
  dueAt = null, // 兼容旧字段
}) {
  const t = nowIso();
  const pe = planEnd ?? dueAt ?? null;
  const create = db.transaction(() => {
    const max = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE group_id IS ? AND parent_id IS ?')
      .get(groupId, parentId).m;
    const info = db
      .prepare(
        `INSERT INTO tasks (group_id, parent_id, title, notes, attachments, priority, plan_start, plan_end, reminder_at,
           completed_at, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(groupId, parentId, title, notes, JSON.stringify(attachments || []), priority, planStart, pe, reminderAt, completedAt, max + 1, t, t);
    const taskId = info.lastInsertRowid;
    setTaskTags(taskId, tagIds);
    return taskId;
  });
  return getTask(create());
}

function updateTask(id, patch) {
  const cur = getTask(id);
  if (!cur) return null;
  const fields = {
    title: patch.title ?? cur.title,
    notes: patch.notes ?? cur.notes,
    attachments: patch.attachments !== undefined ? patch.attachments : cur.attachments,
    priority: patch.priority ?? cur.priority,
    groupId: patch.groupId !== undefined ? patch.groupId : cur.group_id,
    planStart: patch.planStart !== undefined ? patch.planStart : cur.plan_start,
    planEnd: patch.planEnd !== undefined ? patch.planEnd : cur.plan_end,
    reminderAt: patch.reminderAt !== undefined ? patch.reminderAt : cur.reminder_at,
    completedAt: patch.completedAt !== undefined ? patch.completedAt : cur.completed_at,
  };
  db.prepare(
    `UPDATE tasks SET title = ?, notes = ?, attachments = ?, priority = ?, group_id = ?, plan_start = ?, plan_end = ?,
       reminder_at = ?, reminder_fired = CASE WHEN ? <> reminder_at THEN 0 ELSE reminder_fired END,
       completed_at = ?, updated_at = ? WHERE id = ?`
  ).run(
    fields.title,
    fields.notes,
    JSON.stringify(fields.attachments || []),
    fields.priority,
    fields.groupId,
    fields.planStart,
    fields.planEnd,
    fields.reminderAt,
    fields.reminderAt,
    fields.completedAt,
    nowIso(),
    id
  );
  if (patch.tagIds) setTaskTags(id, patch.tagIds);
  return getTask(id);
}

function deleteTask(id) {
  // 级联删除子任务（迭代遍历所有后代）
  const run = db.transaction(() => {
    const stack = [id];
    while (stack.length) {
      const pid = stack.pop();
      const children = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(pid);
      for (const c of children) stack.push(c.id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(pid);
    }
  });
  run();
  return true;
}

/** 获取某任务的直接子任务（按拖拽排序） */
function listSubtasks(parentId) {
  return db
    .prepare(`${TASK_SELECT} WHERE t.parent_id = ? ORDER BY t.completed ASC, t.sort_order ASC, t.id ASC`)
    .all(parentId)
    .map(normalizeTask);
}

/** 按关键词检索任务（供 AI 检索使用，含子任务） */
function searchTasks(keyword, limit = 20) {
  const kw = `%${keyword}%`;
  return db
    .prepare(
      `SELECT t.*, g.name AS group_name, g.color AS group_color,
         p.title AS parent_title,
         (SELECT group_concat(tag.name) FROM tags tag JOIN task_tags tt ON tt.tag_id = tag.id WHERE tt.task_id = t.id) AS tag_names
       FROM tasks t LEFT JOIN groups g ON g.id = t.group_id
       LEFT JOIN tasks p ON p.id = t.parent_id
       WHERE t.title LIKE ? OR t.notes LIKE ? OR EXISTS (
         SELECT 1 FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
         WHERE tt.task_id = t.id AND tg.name LIKE ?
       )
       ORDER BY t.completed ASC, t.priority DESC, t.updated_at DESC
       LIMIT ?`
    )
    .all(kw, kw, kw, limit)
    .map(normalizeTask);
}

function toggleTask(id) {
  const cur = getTask(id);
  if (!cur) return null;
  if (cur.completed) {
    db.prepare('UPDATE tasks SET completed = 0, completed_at = NULL, updated_at = ? WHERE id = ?')
      .run(nowIso(), id);
  } else {
    // 完成任务时自动记录实际完成时间
    db.prepare('UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(nowIso(), nowIso(), id);
  }
  // 同步父任务完成状态（所有子任务完成 → 父任务自动完成），并向上递归
  if (cur.parent_id) syncParentCompletion(cur.parent_id);
  return getTask(id);
}

/** 当某父任务的所有子任务都完成时，自动标记父任务完成；否则取消完成，并递归向上 */
function syncParentCompletion(parentId) {
  if (!parentId) return;
  const subs = listSubtasks(parentId);
  if (subs.length === 0) return;
  const allDone = subs.every((s) => s.completed);
  const parent = getTask(parentId);
  if (!parent) return;
  if (allDone && !parent.completed) {
    db.prepare('UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(nowIso(), nowIso(), parentId);
  } else if (!allDone && parent.completed) {
    db.prepare('UPDATE tasks SET completed = 0, completed_at = NULL, updated_at = ? WHERE id = ?')
      .run(nowIso(), parentId);
  }
  if (parent.parent_id) syncParentCompletion(parent.parent_id);
}

function reorderTasks(ids) {
  const stmt = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
  const tx = db.transaction((arr) => {
    arr.forEach((tid, i) => stmt.run(i, tid));
  });
  tx(ids);
}

/** 将指定分组（或全部）已完成任务归档 */
function archiveCompleted(groupId = null) {
  const sql = groupId != null
    ? 'UPDATE tasks SET archived = 1, updated_at = ? WHERE completed = 1 AND archived = 0 AND group_id = ?'
    : 'UPDATE tasks SET archived = 1, updated_at = ? WHERE completed = 1 AND archived = 0';
  const params = groupId != null ? [nowIso(), groupId] : [nowIso()];
  const info = db.prepare(sql).run(...params);
  return info.changes;
}

function unarchiveTask(id) {
  db.prepare('UPDATE tasks SET archived = 0, updated_at = ? WHERE id = ?').run(nowIso(), id);
  return getTask(id);
}

/** 归档单个已完成任务 */
function archiveTask(id) {
  const info = db.prepare('UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
  return info.changes > 0;
}

/* ------------------------------ 标签 ------------------------------ */

function listTags() {
  const rows = db.prepare('SELECT * FROM tags ORDER BY id ASC').all();
  return rows.map((t) => {
    const c = db
      .prepare('SELECT COUNT(*) AS c FROM task_tags WHERE tag_id = ?')
      .get(t.id).c;
    return { ...t, task_count: c };
  });
}

function createTag(name, color = '#8896ab') {
  const exists = db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
  if (exists) return exists;
  const info = db
    .prepare('INSERT INTO tags (name, color) VALUES (?, ?)')
    .run(name, color);
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(info.lastInsertRowid);
}

function deleteTag(id) {
  const info = db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  return info.changes > 0;
}

function setTaskTags(taskId, tagIds) {
  db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
  if (!tagIds || tagIds.length === 0) return;
  const ins = db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)');
  const tx = db.transaction((ids) => ids.forEach((tagId) => ins.run(taskId, tagId)));
  tx(tagIds);
}

/* ------------------------------ 提醒 ------------------------------ */

/** 返回所有到期未提醒且未完成的任务 */
function dueReminders() {
  const t = nowIso();
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE reminder_at IS NOT NULL AND reminder_at <= ? AND reminder_fired = 0
         AND completed = 0 AND archived = 0`
    )
    .all(t);
}

function markReminderFired(id) {
  db.prepare('UPDATE tasks SET reminder_fired = 1, updated_at = ? WHERE id = ?')
    .run(nowIso(), id);
}

/* ------------------------------ 统计 ------------------------------ */

function overview() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE parent_id IS NULL').get().c;
  const active = db
    .prepare('SELECT COUNT(*) AS c FROM tasks WHERE completed = 0 AND archived = 0 AND parent_id IS NULL').get().c;
  const completed = db
    .prepare('SELECT COUNT(*) AS c FROM tasks WHERE completed = 1 AND archived = 0 AND parent_id IS NULL').get().c;
  const archived = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE archived = 1 AND parent_id IS NULL').get().c;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = db
    .prepare(
      'SELECT COUNT(*) AS c FROM tasks WHERE completed = 0 AND archived = 0 AND parent_id IS NULL AND plan_end IS NOT NULL AND plan_end < ?'
    )
    .get(today).c;

  const byGroup = db
    .prepare(
      `SELECT g.id, g.name, g.color,
         SUM(CASE WHEN t.completed = 0 AND t.archived = 0 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN t.completed = 1 THEN 1 ELSE 0 END) AS done
       FROM groups g LEFT JOIN tasks t ON t.group_id = g.id AND t.parent_id IS NULL
       GROUP BY g.id ORDER BY g.sort_order`
    )
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      active: r.active || 0,
      done: r.done || 0,
    }));

  const byPriority = db
    .prepare(
      `SELECT priority, COUNT(*) AS c FROM tasks WHERE completed = 0 AND archived = 0 AND parent_id IS NULL GROUP BY priority`
    )
    .all()
    .map((r) => ({ priority: r.priority, count: r.c }));

  const rate = completed + active > 0 ? Math.round((completed / (completed + active)) * 100) : 0;

  return { total, active, completed, archived, overdue, byGroup, byPriority, rate };
}

/** 最近 n 天的每日完成数量趋势 */
function dailyTrend(days = 7) {
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const start = d.toISOString();
    const end = new Date(d.getTime() + 24 * 3600 * 1000).toISOString();
    const c = db
      .prepare('SELECT COUNT(*) AS c FROM tasks WHERE completed = 1 AND parent_id IS NULL AND completed_at >= ? AND completed_at < ?')
      .get(start, end).c;
    rows.push({ date: start.slice(0, 10), count: c });
  }
  return rows;
}

/** 自定义范围内的统计数据（供日报/周报/月报使用） */
function rangeStats(startIso, endIso, groupId = null) {
  const gCond = groupId != null ? ' AND group_id = ?' : '';
  const gParams = groupId != null ? [groupId] : [];

  const completedTasks = db
    .prepare(
      `SELECT * FROM tasks WHERE completed = 1 AND parent_id IS NULL AND completed_at >= ? AND completed_at < ? ${gCond} ORDER BY completed_at ASC`
    )
    .all(startIso, endIso, ...gParams);

  const createdTasks = db
    .prepare(
      `SELECT * FROM tasks WHERE parent_id IS NULL AND created_at >= ? AND created_at < ? ${gCond} ORDER BY created_at ASC`
    )
    .all(startIso, endIso, ...gParams);

  const activeNow = db
    .prepare(
      `SELECT * FROM tasks WHERE completed = 0 AND archived = 0 AND parent_id IS NULL ${gCond} ORDER BY priority DESC, (plan_end IS NULL), plan_end`
    )
    .all(...gParams);

  const endDay = endIso.slice(0, 10);
  const overdue = activeNow.filter((t) => t.plan_end && t.plan_end < endDay);

  return { completedTasks, createdTasks, activeNow, overdue };
}

/* ------------------------------ 设置 ------------------------------ */

function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

/* ------------------------------ 数据导入导出 ------------------------------ */

/**
 * 导出全部业务数据为可序列化对象（供 JSON 文件保存）。
 * 注意：不导出 settings 中的 ai.apiKey（避免敏感信息随备份泄露）。
 */
function exportData() {
  return {
    app: 'todo-desktop',
    schemaVersion: 4,
    exportedAt: nowIso(),
    groups: db.prepare('SELECT * FROM groups ORDER BY id').all(),
    tags: db.prepare('SELECT * FROM tags ORDER BY id').all(),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    task_tags: db.prepare('SELECT * FROM task_tags ORDER BY task_id').all(),
    settings: db
      .prepare('SELECT * FROM settings WHERE key NOT LIKE ?')
      .all('ai.apiKey%'),
  };
}

/**
 * 导入数据（覆盖式恢复）：清空现有分组/标签/任务，再写入导入内容。
 * 保留本地 settings（主题、AI 配置）不被覆盖。
 * @returns {{ groups:number, tags:number, tasks:number }}
 */
function importData(data) {
  if (!data || typeof data !== 'object') throw new Error('导入文件内容无效');
  if (!Array.isArray(data.groups) || !Array.isArray(data.tasks)) {
    throw new Error('导入文件格式不正确（缺少 groups 或 tasks）');
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM task_tags').run();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM tags').run();
    db.prepare('DELETE FROM groups').run();

    const t0 = nowIso();
    const insGroup = db.prepare(
      'INSERT INTO groups (id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const g of data.groups) {
      insGroup.run(g.id, g.name, g.color || '#4f7cff', g.sort_order ?? 0, g.created_at || t0, g.updated_at || t0);
    }

    const insTag = db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)');
    for (const t of data.tags || []) {
      insTag.run(t.id, t.name, t.color || '#8896ab');
    }

    const insTask = db.prepare(
      `INSERT INTO tasks (id, group_id, parent_id, title, notes, attachments, priority, plan_start, plan_end, reminder_at,
         reminder_fired, completed, completed_at, archived, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of data.tasks) {
      // 兼容旧导出文件：优先 plan_end，回退到 due_at 的前 10 位
      const planEnd = t.plan_end ?? (t.due_at ? String(t.due_at).slice(0, 10) : null);
      const att = Array.isArray(t.attachments) ? JSON.stringify(t.attachments) : (t.attachments || '[]');
      insTask.run(
        t.id, t.group_id ?? null, t.parent_id ?? null, t.title, t.notes || '', att, t.priority ?? 1,
        t.plan_start ?? null, planEnd, t.reminder_at ?? null, t.reminder_fired ?? 0,
        t.completed ?? 0, t.completed_at ?? null, t.archived ?? 0, t.sort_order ?? 0,
        t.created_at || t0, t.updated_at || t0
      );
    }

    const insTT = db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)');
    for (const tt of data.task_tags || []) {
      insTT.run(tt.task_id, tt.tag_id);
    }
  });
  run();
  seedDefaults(); // 若文件不含分组，补默认分组

  return {
    groups: db.prepare('SELECT COUNT(*) c FROM groups').get().c,
    tags: db.prepare('SELECT COUNT(*) c FROM tags').get().c,
    tasks: db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
  };
}

module.exports = {
  init,
  getDb,
  close,
  nowIso,
  // groups
  listGroups,
  createGroup,
  getGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
  // tasks
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  toggleTask,
  listSubtasks,
  searchTasks,
  reorderTasks,
  archiveCompleted,
  archiveTask,
  unarchiveTask,
  // tags
  listTags,
  createTag,
  deleteTag,
  // reminders
  dueReminders,
  markReminderFired,
  // stats
  overview,
  dailyTrend,
  rangeStats,
  // settings
  getSetting,
  setSetting,
  // import / export
  exportData,
  importData,
};
