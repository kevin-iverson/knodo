'use strict';
/**
 * 四象日记 · v20 建表（由 db.js 的 MIGRATIONS 调用）。
 *
 * 与 worklog/schema.js 同一约定：DDL 集中在本文件，迁移期一次性建表，
 * 与插件开关无关（否则 backup 的 user_version 会分叉）。
 *
 * 两张表而不是一张：
 *  - journal_cells  一天四格，反复编辑 → UPSERT，主键就是「哪天 + 哪一格」
 *  - journal_notes  一天多条，追加为主 → 自增 id + 时间戳
 * 合成一张表要么让格子出现多行，要么让碎碎念只能用一行（丢时间戳）。
 *
 * 隐私铁律：这里**不建任何 FTS 触发器**，日记不进 AI 检索 / 报告的候选集。
 * 日期由主进程格式化成本地 'YYYY-MM-DD' 再写入，绝不用 date('now')（UTC 会跳日）。
 */
function migrate(d) {
  d.exec(`
CREATE TABLE IF NOT EXISTS journal_cells (
  day        TEXT    NOT NULL,
  cell       INTEGER NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (day, cell)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS journal_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  cell       INTEGER,
  task_id    INTEGER,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_notes_day ON journal_notes(day, created_at);
`);

  // 「转任务」把条目指向真实任务：不存 task_id 的话「→ 已加入今天」只活在内存里，
  // 重进视图标记就没了，用户会以为没建成、再点一次 → 重复任务（已踩）。
  // 表可能已经按旧版建过（开发库 / 早一天的 v20），这里补列，幂等。
  const cols = d.prepare('PRAGMA table_info(journal_notes)').all().map((c) => c.name);
  if (!cols.includes('task_id')) d.exec('ALTER TABLE journal_notes ADD COLUMN task_id INTEGER');
}

module.exports = { migrate };
