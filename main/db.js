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
const nodeCrypto = require('crypto');
const dateU = require('./date-utils');
const recurRules = require('./recurrence-rules');

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
  // v5：分组层级（groups.parent_id 自引用，支持无限层子分组）
  (d) => {
    const cols = d.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
    if (!cols.includes('parent_id')) {
      d.exec('ALTER TABLE groups ADD COLUMN parent_id INTEGER');
    }
    d.exec('CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent_id)');
  },
  // v6：会议录制与纪要（meetings 表）
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS meetings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      source_label TEXT    NOT NULL DEFAULT '',
      mode         TEXT    NOT NULL DEFAULT 'audio',
      started_at   TEXT,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      media_paths  TEXT    NOT NULL DEFAULT '[]',
      transcript   TEXT    NOT NULL DEFAULT '',
      summary      TEXT    NOT NULL DEFAULT '',
      todos        TEXT    NOT NULL DEFAULT '[]',
      status       TEXT    NOT NULL DEFAULT 'recorded',
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_meetings_created ON meetings(created_at DESC)');
  },
  // v7：AI 报告 / AI 检索历史（持久化，切换视图或重启都不丢）
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL DEFAULT '',
      type         TEXT    NOT NULL DEFAULT 'custom',
      range_start  TEXT,
      range_end    TEXT,
      group_ids    TEXT    NOT NULL DEFAULT '[]',
      group_label  TEXT    NOT NULL DEFAULT '',
      extra_prompt TEXT    NOT NULL DEFAULT '',
      content      TEXT    NOT NULL DEFAULT '',
      degraded     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC, id DESC)');

    d.exec(`CREATE TABLE IF NOT EXISTS ai_searches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword     TEXT    NOT NULL,
      summary     TEXT    NOT NULL DEFAULT '',
      task_count  INTEGER NOT NULL DEFAULT 0,
      tasks       TEXT    NOT NULL DEFAULT '[]',
      degraded    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_searches_created ON ai_searches(created_at DESC, id DESC)');
  },
  // v8：任务创建时间（created_at）兜底
  // 建表语句里本来就有这一列，但早期版本 / 手工改过的库可能缺失或留空。这里统一补列 + 回填，
  // 保证「创建时间」永远有值（回填优先级：updated_at → 当前时间），并加索引便于按创建时间筛选。
  (d) => {
    const cols = d.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!cols.includes('created_at')) {
      d.exec('ALTER TABLE tasks ADD COLUMN created_at TEXT');
    }
    const t = nowIso();
    d.prepare(
      `UPDATE tasks SET created_at = COALESCE(NULLIF(updated_at, ''), ?)
        WHERE created_at IS NULL OR TRIM(created_at) = ''`
    ).run(t);
    d.exec('CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)');
  },
  // v9：笔记模块（目录 / 笔记 / 笔记标签 / 任务 ↔ 笔记多对多 + 全文索引）
  // 设计要点：
  // - 目录与分组同构（自引用 parent_id），但**不加数据库唯一索引**：与 groups 一致，
  //   旧备份导入可能带同级重名，加索引会让导入直接失败；重名校验放在 assertFolderName()。
  // - notes.deleted_at 非空 = 已进入回收站（软删除）。软删除保留 task_notes 关联，
  //   这样「恢复笔记」后任务引用自动复原；只有彻底删除才会真的摘掉关联行。
  // - 全文检索用 FTS5 external content + trigram：中文无需外部分词器即可命中子串。
  //   trigram 要求查询词 ≥ 3 字符，不足时由 searchNotes() 回退到 LIKE。
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS note_folders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      parent_id  INTEGER,
      color      TEXT    NOT NULL DEFAULT '#4f7cff',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL,
      updated_at TEXT    NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES note_folders(id) ON DELETE SET NULL
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_note_folders_parent ON note_folders(parent_id)');

    d.exec(`CREATE TABLE IF NOT EXISTS notes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id    INTEGER,
      title        TEXT    NOT NULL DEFAULT '',
      content_md   TEXT    NOT NULL DEFAULT '',
      excerpt      TEXT    NOT NULL DEFAULT '',
      pinned       INTEGER NOT NULL DEFAULT 0,
      archived     INTEGER NOT NULL DEFAULT 0,
      deleted_at   TEXT,
      word_count   INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT    NOT NULL DEFAULT '',
      source       TEXT    NOT NULL DEFAULT 'manual',  -- manual | meeting | ai | import
      source_ref   TEXT    NOT NULL DEFAULT '',
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL,
      FOREIGN KEY (folder_id) REFERENCES note_folders(id) ON DELETE SET NULL
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(archived)');

    d.exec(`CREATE TABLE IF NOT EXISTS note_tags (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT    NOT NULL UNIQUE,
      color TEXT    NOT NULL DEFAULT '#8896ab'
    )`);
    d.exec(`CREATE TABLE IF NOT EXISTS note_tag_map (
      note_id INTEGER NOT NULL,
      tag_id  INTEGER NOT NULL,
      PRIMARY KEY (note_id, tag_id),
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id)  REFERENCES note_tags(id) ON DELETE CASCADE
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_note_tag_map_tag ON note_tag_map(tag_id)');

    d.exec(`CREATE TABLE IF NOT EXISTS task_notes (
      task_id    INTEGER NOT NULL,
      note_id    INTEGER NOT NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (task_id, note_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)  ON DELETE CASCADE,
      FOREIGN KEY (note_id) REFERENCES notes(id)  ON DELETE CASCADE
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_task_notes_note ON task_notes(note_id)');

    // 全文索引（external content：正文只存一份，靠触发器同步）
    d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title, content, content='notes', content_rowid='id', tokenize='trigram'
    )`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content_md);
    END`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content_md);
    END`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content_md);
      INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content_md);
    END`);
  },
  // v10：知识库沉淀（笔记作为内置知识库，供 AI 提问检索）
  // 表结构与 docs/AI知识库问答与任务引用集成方案.md §3 的 v10 对齐（同一套表名与字段），
  // 这里先落地「内置笔记库」所需的四张表；folder/upload/api 等外部数据源后续按同一结构扩展。
  // 分块/向量属于派生数据，导入导出不携带（可重建）。
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS knowledge_bases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      type        TEXT    NOT NULL DEFAULT 'notes',  -- notes | folder | upload | api
      icon        TEXT    NOT NULL DEFAULT '📚',
      color       TEXT    NOT NULL DEFAULT '#4f7cff',
      source_json TEXT    NOT NULL DEFAULT '{}',
      enabled     INTEGER NOT NULL DEFAULT 1,
      status      TEXT    NOT NULL DEFAULT 'idle',   -- idle|indexing|ready|error|empty
      last_error  TEXT    NOT NULL DEFAULT '',
      doc_count   INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embed_model TEXT    NOT NULL DEFAULT '',
      embed_dim   INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL
    )`);

    d.exec(`CREATE TABLE IF NOT EXISTS kb_documents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kb_id        INTEGER NOT NULL,
      source_key   TEXT    NOT NULL,   -- 笔记库：'note:<id>'
      title        TEXT    NOT NULL DEFAULT '',
      kind         TEXT    NOT NULL DEFAULT 'md',
      size         INTEGER NOT NULL DEFAULT 0,
      fingerprint  TEXT    NOT NULL DEFAULT '',
      content_hash TEXT    NOT NULL DEFAULT '',
      status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|indexed|failed|missing
      error        TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL,
      FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
    )`);
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS uk_kb_doc ON kb_documents(kb_id, source_key)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_kb_doc_status ON kb_documents(kb_id, status)');

    d.exec(`CREATE TABLE IF NOT EXISTS kb_chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kb_id        INTEGER NOT NULL,
      doc_id       INTEGER NOT NULL,
      ord          INTEGER NOT NULL DEFAULT 0,
      kind         TEXT    NOT NULL DEFAULT 'body',  -- heading|body|table|code
      heading_path TEXT    NOT NULL DEFAULT '',
      content      TEXT    NOT NULL,
      content_hash TEXT    NOT NULL DEFAULT '',
      token_est    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL,
      FOREIGN KEY (kb_id)  REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      FOREIGN KEY (doc_id) REFERENCES kb_documents(id)    ON DELETE CASCADE
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id)');
    d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      content, content='kb_chunks', content_rowid='id', tokenize='trigram'
    )`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.id, new.content);
    END`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ad AFTER DELETE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END`);
    // 分块内容变了必须同步索引：先删旧行再插新行
    d.exec(`CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_au AFTER UPDATE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.id, new.content);
    END`);

    // 向量表预留（一期只做关键词检索，不写入；列结构先对齐方案文档）
    d.exec(`CREATE TABLE IF NOT EXISTS kb_vectors (
      chunk_id INTEGER PRIMARY KEY,
      dim      INTEGER NOT NULL,
      model    TEXT    NOT NULL,
      vec      BLOB    NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
    )`);

    // 内置「笔记知识库」：固定 id=1，唯一入口，后续接入外部数据源时按 sort_order 排队
    const t = nowIso();
    d.prepare(
      `INSERT OR IGNORE INTO knowledge_bases (id, name, type, icon, color, source_json, enabled, status, created_at, updated_at)
       VALUES (1, '笔记知识库', 'notes', '📝', '#4f7cff', '{}', 1, 'ready', ?, ?)`
    ).run(t, t);
  },
  // v11：笔记图片 / 附件（复用任务附件同一套落盘规则，目录改为 note-<id>）
  // - notes.attachments 只存元数据 JSON（含**相对**路径），文件本体在
  //   `<数据目录>/attachments/note-<id>/<附件id>_<文件名>`；与 tasks.attachments 同构，
  //   因此备份/搬家后仍可解析。正文里引用图片用 `todo-media://` 协议（主进程注册），
  //   不落 base64，避免笔记正文被几 MB 的 DataURL 撑爆。
  (d) => {
    d.exec("ALTER TABLE notes ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
  },
  // v12：知识库问答历史。kb:ask 的每次提问都落库（含降级 / 无命中），
  // 供问答弹窗回看与删除；引用片段快照里 content 截断，避免历史表被大片段撑爆。
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS kb_qa (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      question   TEXT    NOT NULL,
      answer     TEXT    NOT NULL DEFAULT '',
      hits       TEXT    NOT NULL DEFAULT '[]',
      hit_count  INTEGER NOT NULL DEFAULT 0,
      degraded   INTEGER NOT NULL DEFAULT 0,
      reason     TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_kb_qa_created ON kb_qa(created_at DESC, id DESC)');
  },
  // v13：问答历史补充「检索范围」列。提问时可以限定笔记目录（分类），回看历史时
  // 要能知道当时限定了哪些范围；旧库补列，默认空串 = 「全部笔记」。
  (d) => {
    const cols = d.prepare('PRAGMA table_info(kb_qa)').all().map((c) => c.name);
    if (!cols.includes('scope')) {
      d.exec("ALTER TABLE kb_qa ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
    }
  },
  // v14：番茄钟（专注计时）。见《番茄钟创意功能方案》§7 —— tasks 表不加字段，
  // 格数通过 GROUP BY task_id 聚合得到。
  // task_id NOT NULL：番茄必须挂任务（用户拍板，不支持自由专注），删任务时记录仍保留——
  // 所以**不加** FOREIGN KEY ... ON DELETE SET NULL（记录要指向已不存在的 id，展示降级「已删除的任务」）。
  // outcome: full（跑满 1 格）| partial（主动收 0.5 格）| interrupted（被打断 0.5 格）。
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS focus_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL,
      group_id    INTEGER,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      planned_sec INTEGER NOT NULL,
      actual_sec  INTEGER NOT NULL DEFAULT 0,
      outcome     TEXT NOT NULL,
      note        TEXT,
      created_at  TEXT NOT NULL
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_focus_task  ON focus_sessions(task_id)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_focus_start ON focus_sessions(started_at)');
  },
  // v15：番茄钟「杂念暂存」落款——捕捉条在专注进行中存下的一闪念标记为 1，
  // 便于事后统计「专注时最容易想起什么」（方案 §创意4）。
  (d) => {
    const cols = d.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!cols.includes('capture_during_focus')) {
      d.exec('ALTER TABLE tasks ADD COLUMN capture_during_focus INTEGER NOT NULL DEFAULT 0');
    }
  },
  // v16：重复待办（模板 + 实例）。
  // 设计要点：**每个发生日就是一条普通 tasks 行**，因此列表 / 日历 / 统计 / 提醒 / 完成状态
  // 全部复用既有链路，一次性待办（recurring_id IS NULL）完全不受影响。
  //  - recurring_rules：规则模板（标题/分组/优先级/标签/规则 JSON/生效区间/习惯标记）
  //  - recurrence_skips：用户手动删掉的某次发生日，防止下一轮同步又把它生成回来
  //  - (recurring_id, occurrence_date) 唯一索引 = 生成幂等的最后一道保险；
  //    SQLite 唯一索引里 NULL 互不冲突，普通任务可以任意多行。
  (d) => {
    const cols = d.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!cols.includes('recurring_id')) {
      d.exec('ALTER TABLE tasks ADD COLUMN recurring_id INTEGER');
    }
    if (!cols.includes('occurrence_date')) {
      d.exec('ALTER TABLE tasks ADD COLUMN occurrence_date TEXT');
    }
    if (!cols.includes('recur_customized')) {
      d.exec('ALTER TABLE tasks ADD COLUMN recur_customized INTEGER NOT NULL DEFAULT 0');
    }
    d.exec(`CREATE TABLE IF NOT EXISTS recurring_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      notes       TEXT    NOT NULL DEFAULT '',
      group_id    INTEGER,
      priority    INTEGER NOT NULL DEFAULT 1,
      tag_ids     TEXT    NOT NULL DEFAULT '[]',
      rule        TEXT    NOT NULL,
      start_date  TEXT    NOT NULL,
      end_date    TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      habit       INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL
    )`);
    d.exec(`CREATE TABLE IF NOT EXISTS recurrence_skips (
      rule_id         INTEGER NOT NULL,
      occurrence_date TEXT    NOT NULL,
      PRIMARY KEY (rule_id, occurrence_date)
    )`);
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_recur_day ON tasks(recurring_id, occurrence_date)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_tasks_recur ON tasks(recurring_id)');
  },
  // v17：重复待办改版 —— 一条任务 + 按日打卡，不再为每个发生日预生成实例。
  // 旧库里同一规则下可能已有 N 条实例（预生成 45 天），这里合并成唯一一条主任务：
  //   已完成实例转成 recurrence_completions 打卡记录（历史不丢），其余实例删除；
  //   主任务的日期 / 提醒 / 完成态交给启动后的 rollRecurringTask() 重算。
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS recurrence_completions (
      rule_id         INTEGER NOT NULL,
      occurrence_date TEXT    NOT NULL,
      completed_at    TEXT    NOT NULL,
      PRIMARY KEY (rule_id, occurrence_date)
    )`);
    const rc = d.prepare('PRAGMA table_info(recurring_rules)').all().map((c) => c.name);
    if (!rc.includes('task_id')) d.exec('ALTER TABLE recurring_rules ADD COLUMN task_id INTEGER');
    d.exec('DROP INDEX IF EXISTS idx_tasks_recur_day');

    const t0 = nowIso();
    const rowsOf = d.prepare(
      'SELECT id, occurrence_date, completed, completed_at, created_at FROM tasks WHERE recurring_id = ? ORDER BY id'
    );
    const insCompletion = d.prepare(
      'INSERT OR IGNORE INTO recurrence_completions (rule_id, occurrence_date, completed_at) VALUES (?, ?, ?)'
    );
    const insTask = d.prepare(
      `INSERT INTO tasks (group_id, parent_id, title, notes, attachments, priority,
         plan_start, plan_end, reminder_at, completed, completed_at, archived,
         sort_order, created_at, updated_at, recurring_id, occurrence_date)
       VALUES (?, NULL, ?, ?, '[]', ?, NULL, NULL, NULL, 0, NULL, 0, 0, ?, ?, ?, NULL)`
    );
    for (const r of d.prepare('SELECT * FROM recurring_rules').all()) {
      const rows = rowsOf.all(r.id);
      let keep = rows.length ? rows[0].id : null;
      for (const row of rows) {
        if (row.completed && row.occurrence_date) {
          insCompletion.run(r.id, row.occurrence_date, row.completed_at || row.created_at || t0);
        }
      }
      if (keep == null) {
        keep = Number(insTask.run(
          r.group_id ?? null, r.title, r.notes || '', r.priority ?? 1, t0, t0, r.id
        ).lastInsertRowid);
      }
      // 被合并掉的实例若挂了子任务，改挂到保留的主任务上，不丢数据
      for (const row of rows) {
        if (row.id !== keep) {
          d.prepare('UPDATE tasks SET parent_id = ? WHERE parent_id = ?').run(keep, row.id);
        }
      }
      d.prepare('DELETE FROM tasks WHERE recurring_id = ? AND id <> ?').run(r.id, keep);
      d.prepare(
        `UPDATE tasks SET occurrence_date = NULL, completed = 0, completed_at = NULL,
           archived = 0, reminder_fired = 0, recur_customized = 0 WHERE id = ?`
      ).run(keep);
      d.prepare('UPDATE recurring_rules SET task_id = ? WHERE id = ?').run(keep, r.id);
    }
  },
];

// 初始化状态：失败时记录原因，供 IPC 层返回可读错误而不是抛异常
let initError = '';
// 当前数据库文件绝对路径（数据目录可配置后，界面/迁移逻辑需要知道真实落点）
let currentDbPath = '';

function init(dbDir, dbFileName = 'todo.db') {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, dbFileName);
    db = new Database(dbPath);
    currentDbPath = dbPath;
    // 立刻做一次写探测：数据库文件只读（权限 / 同步盘占位 / 被占用）时提前暴露，
    // 否则要等第一次写操作才报 "attempt to write a readonly database"，用户只看到"点了没反应"
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
    initError = '';
    return db;
  } catch (e) {
    initError = e && e.message ? e.message : String(e);
    console.error('[db] 初始化失败：', initError);
    return null;
  }
}

/** 数据库是否可用（初始化成功） */
function isReady() {
  return !!db;
}

/** 初始化失败原因（成功时为空串） */
function getInitError() {
  return initError;
}

function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 init()');
  return db;
}

/** 当前数据库文件绝对路径（未初始化时为空串） */
function getDbPath() {
  return currentDbPath;
}

/**
 * 生成一份一致性快照到目标文件（数据目录迁移用）。
 * WAL 模式下直接 copy .db 文件可能拿到「旧主库 + 未 checkpoint 的 WAL」，所以走 SQLite 的
 * 在线备份接口；调用期间数据库可以继续读写，不需要先断开。
 */
async function backupTo(destPath) {
  if (!db) throw new Error('数据库尚未初始化');
  await db.backup(destPath);
  return destPath;
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
  // 重复事项：NULL = 一次性待办；occurrence_date 是当前这一次的发生日（YYYY-MM-DD）
  t.recurring_id = t.recurring_id == null ? null : Number(t.recurring_id);
  t.occurrence_date = t.occurrence_date || null;
  t.recur_customized = !!t.recur_customized;
  // 创建时间兜底：v8 迁移已回填过一遍，这里再兜一层，避免 UI 出现空白
  t.created_at = t.created_at || t.updated_at || '';
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

/**
 * 取某分组的**所有子孙分组 id**（不含自身）。
 * 用递归 CTE 一次查完整条链，避免每層一次查询。
 */
function descendantGroupIds(id) {
  if (id == null) return [];
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM groups WHERE parent_id = ?
         UNION ALL
         SELECT g.id FROM groups g JOIN sub s ON g.parent_id = s.id
       )
       SELECT id FROM sub`
    )
    .all(id);
  return rows.map((r) => r.id);
}

/**
 * 分组集合 → 展开后的 id 集合（自身 + 全部子孙）。
 * 业务含义：选中父分组时，挂在它任意层级子分组下的任务都要算进去。
 */
function expandGroupIds(ids) {
  const seed = (Array.isArray(ids) ? ids : ids != null ? [ids] : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (!seed.length) return [];
  const ph = seed.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM groups WHERE id IN (${ph})
         UNION ALL
         SELECT g.id FROM groups g JOIN tree t ON g.parent_id = t.id
       )
       SELECT DISTINCT id FROM tree`
    )
    .all(...seed);
  return rows.map((r) => r.id);
}

function listGroups(includeEmpty = true) {
  const rows = db.prepare('SELECT * FROM groups ORDER BY sort_order ASC, id ASC').all();
  if (!includeEmpty) return rows;

  const counts = db
    .prepare(
      `SELECT group_id, COUNT(*) AS c FROM tasks WHERE completed = 0 AND archived = 0 GROUP BY group_id`
    )
    .all();
  const ownMap = new Map(counts.map((r) => [r.group_id, r.c]));

  // 由叶子向根累加：父分组的计数 = 自身任务 + 所有子分组任务
  const byParent = new Map();
  rows.forEach((g) => {
    const p = g.parent_id == null ? 0 : g.parent_id;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(g.id);
  });
  const total = new Map();
  const walk = (gid) => {
    if (total.has(gid)) return total.get(gid);
    total.set(gid, 0); // 防御：历史脏数据可能成环，这里保证不会无限递归
    const own = ownMap.get(gid) || 0;
    const kids = byParent.get(gid) || [];
    const sum = kids.reduce((acc, k) => acc + walk(k), own);
    total.set(gid, sum);
    return sum;
  };
  rows.forEach((g) => walk(g.id));

  return rows.map((g) => ({
    ...g,
    active_count: ownMap.get(g.id) || 0, // 仅直属任务
    total_count: total.get(g.id) || 0,   // 含所有子分组
  }));
}

/**
 * 分组颜色归一化：'#abc' → '#aabbcc'；非法值回退默认蓝。
 * 颜色现在支持自由取色，渲染层一律当合法 hex 用，这里兜底避免出现 '#' 开头的半截样式值。
 */
function normalizeColor(color, fallback = '#4f7cff') {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color == null ? '' : color).trim());
  if (!m) return fallback;
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`;
}

/**
 * 同一「上级」下是否已有同名分组。
 * 名称唯一性的作用域是**父级**，不是全集：不同层级下允许重名（如「工作 / 11」与「生活 / 11」），
 * 顶级分组（parent_id 为 NULL）自成一级。比较时去空格并忽略大小写，避免「Work / work」这种伪重名。
 * @param {string} name 待校验名称
 * @param {number|null} parentId 目标上级分组 id
 * @param {number|null} exceptId 排除自身（重命名 / 原地保存时用）
 */
function groupNameTaken(name, parentId, exceptId = null) {
  const key = String(name == null ? '' : name).trim().toLowerCase();
  if (!key) return false;
  const pid = parentId == null ? null : Number(parentId);
  const rows = db.prepare('SELECT id, name FROM groups WHERE parent_id IS ?').all(pid);
  return rows.some((r) => Number(r.id) !== Number(exceptId)
    && String(r.name || '').trim().toLowerCase() === key);
}

/** 校验并返回规范化后的分组名（空名 / 同级重名直接抛可读错误） */
function assertGroupName(name, parentId, exceptId = null) {
  const clean = String(name == null ? '' : name).trim();
  if (!clean) throw new Error('分组名称不能为空');
  if (groupNameTaken(clean, parentId, exceptId)) {
    const where = parentId == null ? '顶级分组' : `上级分组「${(getGroup(parentId) || {}).name || '已删除'}」下`;
    throw new Error(`${where}已存在同名分组「${clean}」，请换一个名称`);
  }
  return clean;
}

function createGroup({ name, color = '#4f7cff', parentId = null } = {}) {
  const t = nowIso();
  if (parentId != null && !getGroup(parentId)) throw new Error('上级分组不存在');
  const clean = assertGroupName(name, parentId);
  // sort_order 只在同级内部递增，保证新分组排在同层末尾
  const max = parentId == null
    ? db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM groups WHERE parent_id IS NULL').get().m
    : db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM groups WHERE parent_id = ?').get(parentId).m;
  const info = db
    .prepare('INSERT INTO groups (name, color, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(clean, normalizeColor(color), parentId, max + 1, t, t);
  return getGroup(info.lastInsertRowid);
}

function getGroup(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id) || null;
}

/**
 * 更新分组。改动 parentId 时做环检测：不能挂到自己或自己的子孙下面，
 * 否则树会出现闭环（侧边栏渲染死循环、计数无解）。
 */
function updateGroup(id, { name, color, parentId } = {}) {
  const cur = getGroup(id);
  if (!cur) return null;
  let nextParent = cur.parent_id;
  if (parentId !== undefined) {
    nextParent = parentId == null ? null : Number(parentId);
    if (nextParent === Number(id)) throw new Error('上级分组不能是它自己');
    if (nextParent != null) {
      if (!getGroup(nextParent)) throw new Error('上级分组不存在');
      if (descendantGroupIds(id).includes(nextParent)) {
        throw new Error('不能把分组移动到它自己的子分组下');
      }
    }
  }
  // 名称 + 上级：重命名、或「移动到别的父级」时，都要按**目标父级**重新校验同级重名
  // （移动 = 换了一个父级作用域，可能与该父级下已有的同名分组撞车）。
  // 只改颜色等其它字段时不校验，避免历史脏数据（例如旧备份导入的同级重名）把无关操作卡死。
  const sameParent = (nextParent == null ? null : Number(nextParent))
    === (cur.parent_id == null ? null : Number(cur.parent_id));
  const sameName = name == null || String(name).trim() === String(cur.name).trim();
  const nextName = (sameParent && sameName)
    ? cur.name
    : assertGroupName(name ?? cur.name, nextParent, id);
  db.prepare('UPDATE groups SET name = ?, color = ?, parent_id = ?, updated_at = ? WHERE id = ?')
    .run(nextName, color == null ? cur.color : normalizeColor(color, normalizeColor(cur.color)), nextParent, nowIso(), id);
  return getGroup(id);
}

/**
 * 删除分组：连同所有子孙分组一起删除；这些分组下的任务**上移一级**
 * （有上级则移到上级，没有就变成"未分组"），避免丢任务。
 */
function deleteGroup(id) {
  const cur = getGroup(id);
  if (!cur) return { ok: false, deletedGroups: 0, movedTasks: 0 };
  const ids = [Number(id), ...descendantGroupIds(id)];
  const ph = ids.map(() => '?').join(', ');
  const moveTo = cur.parent_id == null ? null : cur.parent_id;
  const run = db.transaction(() => {
    const moved = db
      .prepare(`UPDATE tasks SET group_id = ?, updated_at = ? WHERE group_id IN (${ph})`)
      .run(moveTo, nowIso(), ...ids).changes;
    const removed = db.prepare(`DELETE FROM groups WHERE id IN (${ph})`).run(...ids).changes;
    return { ok: true, deletedGroups: removed, movedTasks: moved, moveTo };
  });
  return run();
}

/** 同一父级下的分组 id（按 sort_order，id 兜底），可按 exceptId 排除某个分组 */
function siblingGroupIds(parentId = null, exceptId = null) {
  const rows = parentId == null
    ? db.prepare('SELECT id FROM groups WHERE parent_id IS NULL ORDER BY sort_order ASC, id ASC').all()
    : db.prepare('SELECT id FROM groups WHERE parent_id = ? ORDER BY sort_order ASC, id ASC').all(parentId);
  return rows.map((r) => r.id).filter((id) => id !== exceptId);
}

/** 把一组同级分组按给定顺序写成 0..n-1，避免移动后 sort_order 断档或重号 */
function renumberSiblings(ids) {
  const stmt = db.prepare('UPDATE groups SET sort_order = ? WHERE id = ?');
  ids.forEach((gid, i) => stmt.run(i, gid));
}

/**
 * 移动分组：换父级 + 落到目标同级的第 index 位（0 基，越界自动钳制到首/尾）。
 *
 * 边界与校验：
 *  - 不能挂到自己或自己的子孙下面（否则树成环，侧边栏渲染死循环）；
 *  - 换父级 = 换了「同级」作用域，要按目标父级重新校验重名；同级内挪位置不校验；
 *  - 原父级的序号会留下空档，所以两边都要按新顺序重排 0..n-1；
 *  - index 省略（null）= 排到目标层末尾；负数 / 超过长度都钳到合法区间。
 *
 * @returns {object|null} 移动后的分组（分组不存在时 null）
 */
function moveGroup(id, { parentId, index } = {}) {
  const gid = Number(id);
  const cur = getGroup(gid);
  if (!cur) return null;

  const curParent = cur.parent_id == null ? null : Number(cur.parent_id);
  const nextParent = parentId === undefined ? curParent : (parentId == null ? null : Number(parentId));
  if (nextParent === gid) throw new Error('上级分组不能是它自己');
  if (nextParent != null) {
    if (!getGroup(nextParent)) throw new Error('上级分组不存在');
    if (descendantGroupIds(gid).includes(nextParent)) {
      throw new Error('不能把分组移动到它自己的子分组下');
    }
  }
  // 同级重名：移动到新父级下可能与该父级已有的同名分组撞车
  if (nextParent !== curParent) assertGroupName(cur.name, nextParent, gid);

  const run = db.transaction(() => {
    const list = siblingGroupIds(nextParent, gid);
    let pos = list.length;
    if (index != null) {
      const n = Number(index);
      if (Number.isFinite(n)) pos = Math.max(0, Math.min(Math.trunc(n), list.length));
    }
    list.splice(pos, 0, gid);
    db.prepare('UPDATE groups SET parent_id = ?, updated_at = ? WHERE id = ?')
      .run(nextParent, nowIso(), gid);
    renumberSiblings(list);
    // 换父级后原层级少了这一项，序号要重排（留空档会让下一次插入的位置算歪）
    if (curParent !== nextParent) renumberSiblings(siblingGroupIds(curParent));
  });
  run();
  return getGroup(gid);
}

/**
 * 按给定的扁平 id 顺序重排（历史接口，界面已改用 moveGroup）。
 * 注意 sort_order 是「同级内」的序号：这里按父级分组分别编号，
 * 不能拿整棵树的顺序直接写全局序号，否则同层序号会被别层插进来打乱。
 */
function reorderGroups(ids) {
  const arr = (Array.isArray(ids) ? ids : []).map(Number).filter((x) => Number.isFinite(x));
  const run = db.transaction(() => {
    const byParent = new Map();
    for (const gid of arr) {
      const g = getGroup(gid);
      if (!g) continue;
      const key = g.parent_id == null ? 'root' : String(g.parent_id);
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(gid);
    }
    for (const [key, list] of byParent) renumberSiblings(list);
  });
  run();
}

/* ------------------------------ 任务 ------------------------------ */

/**
 * 查询任务。
 * @param {object} f 过滤条件：groupId / status(active|completed|archived|all) / tagId /
 *   priority / search / sort，以及时间筛选：
 *   planStartFrom / planStartTo（计划开始日期范围，YYYY-MM-DD）
 *   planEndFrom / planEndTo（计划完成日期范围，YYYY-MM-DD）
 *   completedFrom / completedTo（实际完成时间范围，UTC ISO）
 *
 * 重复事项的三个专用条件（都只在传值时生效，不影响任何既有调用）：
 *   todayRecurring    与 planEndTo 配合：重复事项改判「本次发生日已到」（见下方注释）
 *   excludeRecurringDue  排除「今天这一份」的重复事项（供「即将到期」用）
 *   recurringPending  只看「今天不发生」的重复事项（暂停 / 已结束 / 下次在未来）
 */
function listTasks(f = {}) {
  const where = [];
  const params = [];

  // 子任务过滤：默认返回所有任务（含子任务）；parentId 指定时仅返回该父任务的子任务
  if (f.parentId != null) {
    where.push('t.parent_id = ?');
    params.push(f.parentId);
  }

  // 分组筛选：选中父分组时，其所有子孙分组下的任务一并返回
  if (f.groupId != null && f.groupId !== 'all') {
    const ids = expandGroupIds(f.groupId);
    if (ids.length === 1) {
      where.push('t.group_id = ?');
      params.push(ids[0]);
    } else if (ids.length > 1) {
      where.push(`t.group_id IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    } else {
      where.push('0'); // 分组已不存在 → 结果为空，而不是退回“全部”
    }
  }
  // 仅顶层任务：overview 的每一项计数都排除了子任务，统计下钻列表必须同口径，
  // 否则「已逾期 20 个」点进去却列出 30 条，数字对不上。
  if (f.topLevel) where.push('t.parent_id IS NULL');

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
    case 'any':
      // 不过滤状态：对应 overview 的 total（含已完成与已归档）
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
  // 重复规则：只看某条规则对应的那一条任务（管理面板 / 习惯记录用）
  if (f.recurringId != null) {
    where.push('t.recurring_id = ?');
    params.push(f.recurringId);
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
  // 「今天」：一次性任务按截止日判定（截止 ≤ 今天，含已逾期）；
  // 重复事项的 plan_end 是「发生日 + 完成日偏移」的**截止日**，用它当判据会让「今天该做的事」
  // 一直等到截止日才进今天（本次发生日当天反而留在「即将到期」）。所以重复事项改判
  // 「本次发生日已到」（occurrence_date <= 今天）—— 两者是 OR 关系，必须包成一组。
  if (f.planEndTo) {
    if (f.todayRecurring) {
      where.push(
        `((t.plan_end IS NOT NULL AND t.plan_end <= ?)
          OR (t.recurring_id IS NOT NULL AND t.occurrence_date IS NOT NULL AND t.occurrence_date <= ?))`
      );
      params.push(f.planEndTo, f.todayRecurring);
    } else {
      where.push('t.plan_end IS NOT NULL AND t.plan_end <= ?');
      params.push(f.planEndTo);
    }
  }
  // 「即将到期」= 今天之后才要做：今天这一份已经在「今天」露面的重复事项不再重复出现在顶部
  if (f.excludeRecurringDue) {
    where.push('NOT (t.recurring_id IS NOT NULL AND t.occurrence_date IS NOT NULL AND t.occurrence_date <= ?)');
    params.push(f.excludeRecurringDue);
  }
  // 今天不发生但确实存在的重复事项（规则暂停 / 已过结束日 / 下次在未来）：
  // 给「今天」视图一个可展开的说明区，避免任务「凭空消失」（P-08 / P-09）
  if (f.recurringPending) {
    where.push('t.recurring_id IS NOT NULL AND (t.occurrence_date IS NULL OR t.occurrence_date > ?)');
    params.push(f.recurringPending);
  }
  if (f.completedFrom) { where.push('t.completed_at IS NOT NULL AND t.completed_at >= ?'); params.push(f.completedFrom); }
  if (f.completedTo) { where.push('t.completed_at IS NOT NULL AND t.completed_at <= ?'); params.push(f.completedTo); }

  let order = 't.completed ASC, (t.plan_end IS NULL) ASC, t.plan_end ASC, t.priority DESC, t.sort_order ASC, t.id DESC';
  if (f.sort === 'priority') order = 't.completed ASC, t.priority DESC, (t.plan_end IS NULL) ASC, t.plan_end ASC, t.sort_order ASC';
  if (f.sort === 'due') order = 't.completed ASC, (t.plan_end IS NULL) ASC, t.plan_end ASC, t.priority DESC, t.sort_order ASC';
  // 手动排序：优先按 sort_order，其余字段只作兜底。
  // sort_order 一旦被拖拽写入就是 0..n-1 的互不重复值，此时顺序完全由拖拽决定；
  // 从未拖拽过时大家都是默认值，退化成原来的智能排序，不会突然打乱列表。
  if (f.sort === 'manual') {
    order = 't.sort_order ASC, t.completed ASC, (t.plan_end IS NULL) ASC, t.plan_end ASC, t.priority DESC, t.id ASC';
  }

  // 没有任何筛选条件时（status:'any' 且不带其它过滤）不能拼出空 WHERE，否则 SQL 语法错误
  const sql = `${TASK_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`;
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
  captureDuringFocus = 0,
  createdAt = null, // 留空 = 取当前时间；导入历史数据时可指定以保留原始创建时间
  dueAt = null, // 兼容旧字段
}) {
  const t = nowIso();
  const pe = planEnd ?? dueAt ?? null;
  // 创建时间：不传则为当前时刻；updated_at 始终是「现在」
  const created = createdAt || t;
  const create = db.transaction(() => {
    const max = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE group_id IS ? AND parent_id IS ?')
      .get(groupId, parentId).m;
    const info = db
      .prepare(
        `INSERT INTO tasks (group_id, parent_id, title, notes, attachments, priority, plan_start, plan_end, reminder_at,
           completed_at, capture_during_focus, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(groupId, parentId, title, notes, JSON.stringify(attachments || []), priority, planStart, pe, reminderAt, completedAt, captureDuringFocus ? 1 : 0, max + 1, created, t);
    const taskId = info.lastInsertRowid;
    setTaskTags(taskId, tagIds);
    return taskId;
  });
  return getTask(create());
}

function updateTask(id, patch) {
  const cur = getTask(id);
  if (!cur) return null;
  // 重复事项：计划开始 / 截止 / 提醒都是规则按发生日派生的（recurrence-rules.js#instanceFields，
  // 日切由 rollRecurringTask 重算）。这里一律拒写这三个字段 —— 否则详情面板跨过零点还开着，
  // 改个标题就会把已经推进的发生日连同旧日期一起写回去（P-02）；面板里也不该出现可编辑入口（P-01）。
  // 规则是唯一权威：要改期就改规则（生效日 / 截止日偏移 / 提醒时间）。
  const derived = cur.recurring_id != null;
  const keep = (v, fallback) => (v !== undefined ? v : fallback);
  const fields = {
    title: patch.title ?? cur.title,
    notes: patch.notes ?? cur.notes,
    attachments: patch.attachments !== undefined ? patch.attachments : cur.attachments,
    priority: patch.priority ?? cur.priority,
    groupId: patch.groupId !== undefined ? patch.groupId : cur.group_id,
    planStart: derived ? cur.plan_start : keep(patch.planStart, cur.plan_start),
    planEnd: derived ? cur.plan_end : keep(patch.planEnd, cur.plan_end),
    reminderAt: derived ? cur.reminder_at : keep(patch.reminderAt, cur.reminder_at),
    completedAt: patch.completedAt !== undefined ? patch.completedAt : cur.completed_at,
  };
  // recur_customized 已废弃：字段保留只为兼容旧库 / 旧备份，不再写入（日切从不读它）
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
  // 重复事项：内容字段同步回规则表，保证「详情里改标题」与「规则面板改标题」是同一份数据。
  // 计划日期 / 提醒由规则按发生日推进，这里不回写。
  if (cur.recurring_id != null) {
    db.prepare(
      `UPDATE recurring_rules SET title = ?, notes = ?, priority = ?, group_id = ?, tag_ids = ?, updated_at = ?
       WHERE id = ?`
    ).run(fields.title, fields.notes, fields.priority, fields.groupId,
      JSON.stringify(getTask(id).tag_ids || []), nowIso(), cur.recurring_id);
  }
  return getTask(id);
}

function deleteTask(id) {
  // 删除重复事项 = 连规则 / 打卡历史一起删；「跳过某一天」走 skipOccurrence()
  const target = db.prepare('SELECT recurring_id, occurrence_date FROM tasks WHERE id = ?').get(id);
  // 级联删除子任务（迭代遍历所有后代）
  const run = db.transaction(() => {
    const stack = [id];
    while (stack.length) {
      const pid = stack.pop();
      const children = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(pid);
      for (const c of children) stack.push(c.id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(pid);
    }
    if (target && target.recurring_id != null) {
      db.prepare('UPDATE tasks SET recurring_id = NULL, occurrence_date = NULL WHERE recurring_id = ?')
        .run(target.recurring_id);
      db.prepare('DELETE FROM recurrence_completions WHERE rule_id = ?').run(target.recurring_id);
      db.prepare('DELETE FROM recurrence_skips WHERE rule_id = ?').run(target.recurring_id);
      db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(target.recurring_id);
    }
  });
  run();
  return true;
}

/** 任务自身 + 所有后代任务 id（删除任务前收集，用于连带清理附件文件） */
function subtreeTaskIds(id) {
  const ids = [];
  const stack = [Number(id)];
  while (stack.length) {
    const pid = stack.pop();
    if (!ids.includes(pid)) ids.push(pid);
    const children = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(pid);
    for (const c of children) stack.push(c.id);
  }
  return ids;
}

/**
 * 只更新附件元数据。
 * 文件本体由 main/attachments.js 落盘，这里只负责把元数据数组写回 tasks.attachments（JSON）。
 * 与 updateTask 分开是为了避免「附件列表」被编辑器的自动保存（notes/title）用旧值覆盖回去。
 */
function setAttachments(taskId, list) {
  const cur = getTask(taskId);
  if (!cur) return null;
  const arr = Array.isArray(list) ? list : [];
  db.prepare('UPDATE tasks SET attachments = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(arr), nowIso(), Number(taskId));
  return getTask(taskId);
}

/**
 * 获取某任务的直接子任务。
 * 手动排序（sort_order）优先，其余字段只作兜底 —— 同一父任务下的子任务是"步骤清单"，
 * 拖拽排序是它唯一的排序手段，必须让拖拽结果立刻生效；从未拖拽过 sort_order 全为默认值，
 * 顺序仍会退化为原来的智能排序（未完成 → 截止日期 → 优先级 → id），与历史表现一致。
 */
function listSubtasks(parentId) {
  return db
    .prepare(
      `${TASK_SELECT} WHERE t.parent_id = ?
       ORDER BY t.sort_order ASC, t.completed ASC, (t.plan_end IS NULL) ASC, t.plan_end ASC, t.priority DESC, t.id ASC`
    )
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
  const t = nowIso();
  if (cur.recurring_id != null && cur.occurrence_date) {
    // 重复事项：完成记录落在「按日打卡表」，行上的 completed 只是当前发生日的显示态。
    // 跨天由 rollRecurringTask() 换成新一天的状态，历史打卡不会被覆盖。
    const day = cur.occurrence_date || dateU.todayLocal();
    if (cur.completed) {
      db.prepare('DELETE FROM recurrence_completions WHERE rule_id = ? AND occurrence_date = ?')
        .run(cur.recurring_id, day);
      db.prepare('UPDATE tasks SET completed = 0, completed_at = NULL, updated_at = ? WHERE id = ?')
        .run(t, id);
    } else {
      db.prepare(
        'INSERT OR REPLACE INTO recurrence_completions (rule_id, occurrence_date, completed_at) VALUES (?, ?, ?)'
      ).run(cur.recurring_id, day, t);
      db.prepare('UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE id = ?')
        .run(t, t, id);
    }
  } else if (cur.completed) {
    db.prepare('UPDATE tasks SET completed = 0, completed_at = NULL, updated_at = ? WHERE id = ?')
      .run(t, id);
  } else {
    // 完成任务时自动记录实际完成时间
    db.prepare('UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(t, t, id);
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
  // 与列表筛选保持一致：在当前分组（含其子分组）范围内归档
  const ids = groupId != null ? expandGroupIds(groupId) : [];
  if (groupId != null && !ids.length) return 0;
  const sql = ids.length
    ? `UPDATE tasks SET archived = 1, updated_at = ? WHERE completed = 1 AND archived = 0 AND recurring_id IS NULL AND group_id IN (${ids.map(() => '?').join(', ')})`
    : 'UPDATE tasks SET archived = 1, updated_at = ? WHERE completed = 1 AND archived = 0 AND recurring_id IS NULL';
  const params = ids.length ? [nowIso(), ...ids] : [nowIso()];
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

/* ------------------------------ 重复待办 / 习惯 ------------------------------ */

/**
 * 模型（v17）：**一条重复事项 = 一条 tasks 行**，规则是这条任务的属性，不再按发生日预生成实例。
 *
 *  - tasks 行的 plan_start / plan_end / reminder_at / completed 始终表示「当前这一次发生」；
 *    调度器在启动 / 定时 / 跨自然日时调 rollRecurringTask() 把它推进到下一次应发生日。
 *    因此「今天 / 即将到期 / 全部任务 / 日历 / 统计 / 提醒」全部继续用原来的过滤条件，
 *    不需要为重复任务做第二套查询。
 *  - 每次完成单独记进 recurrence_completions(rule_id, occurrence_date)。跨天只是把行上的
 *    completed 换成新一天的打卡状态，历史记录不受影响；习惯统计从这里算。
 *  - 改规则只 UPDATE 一行 + 重算日期，不存在「重建 N 条实例」的问题，历史打卡也绝不改写。
 *  - 一次性任务 recurring_id IS NULL，行为完全不变。
 */
const RECUR_AHEAD_DAYS = 60; // 只用于「找下一次发生日」的搜索窗口（足够覆盖每月一次），不落库

function safeJson(raw, fallback) {
  try {
    const v = JSON.parse(raw == null ? '' : raw);
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}

function normalizeRuleRow(row) {
  if (!row) return null;
  const parsed = safeJson(row.rule, {});
  const tags = safeJson(row.tag_ids, []);
  return {
    ...row,
    rule: recurRules.normalizeRule(parsed && typeof parsed === 'object' ? parsed : {}),
    tag_ids: Array.isArray(tags) ? tags.map(Number).filter(Number.isFinite) : [],
    enabled: !!row.enabled,
    habit: !!row.habit,
    task_id: row.task_id == null ? null : Number(row.task_id),
    skip_count: Number(row.skip_count || 0),
    instance_count: Number(row.instance_count || 0), // 兼容旧字段：现为累计打卡次数
    done_count: Number(row.done_count || 0),
    today_done: !!row.today_done,
  };
}

const RULE_SELECT = `SELECT r.*,
  (SELECT COUNT(*) FROM recurrence_skips s WHERE s.rule_id = r.id) AS skip_count,
  (SELECT COUNT(*) FROM recurrence_completions c WHERE c.rule_id = r.id) AS instance_count,
  (SELECT COUNT(*) FROM recurrence_completions c WHERE c.rule_id = r.id) AS done_count,
  EXISTS (SELECT 1 FROM recurrence_completions c
          WHERE c.rule_id = r.id AND c.occurrence_date = ?) AS today_done
FROM recurring_rules r`;

function listRecurringRules(includeDisabled = true, today = dateU.todayLocal()) {
  const sql = `${RULE_SELECT}${includeDisabled ? '' : ' WHERE r.enabled = 1'} ORDER BY r.enabled DESC, r.id ASC`;
  return db.prepare(sql).all(today).map(normalizeRuleRow);
}

function getRecurringRule(id, today = dateU.todayLocal()) {
  return normalizeRuleRow(db.prepare(`${RULE_SELECT} WHERE r.id = ?`).get(today, id));
}

/** 规则字段清洗：标题必填、规则校验、日期有序 */
function ruleInput(p, base = {}) {
  const title = String(p.title ?? base.title ?? '').trim();
  if (!title) throw new Error('重复事项标题不能为空');
  const baseRule = typeof base.rule === 'string' ? safeJson(base.rule, {}) : (base.rule || {});
  const checked = recurRules.validateRule(p.rule !== undefined ? p.rule : baseRule);
  if (!checked.ok) throw new Error(checked.message);
  const baseTags = typeof base.tag_ids === 'string' ? safeJson(base.tag_ids, []) : (base.tag_ids || []);
  const startDate = dateU.toDay(p.startDate !== undefined ? p.startDate : base.start_date) || dateU.todayLocal();
  const endRaw = p.endDate !== undefined ? p.endDate : base.end_date;
  const endDate = endRaw ? dateU.toDay(endRaw) : null;
  if (endRaw && !endDate) throw new Error('结束日期格式不正确');
  if (endDate && endDate < startDate) throw new Error('结束日期不能早于生效日期');
  const tagIds = p.tagIds !== undefined
    ? (Array.isArray(p.tagIds) ? p.tagIds.map(Number).filter(Number.isFinite) : [])
    : (Array.isArray(baseTags) ? baseTags : []);
  const baseEnabled = base.enabled === undefined ? 1 : Number(base.enabled);
  const baseHabit = base.habit === undefined ? 0 : Number(base.habit);
  return {
    title,
    notes: String(p.notes ?? base.notes ?? ''),
    group_id: p.groupId !== undefined ? (p.groupId == null ? null : Number(p.groupId)) : (base.group_id ?? null),
    priority: Number.isFinite(Number(p.priority)) ? Math.min(3, Math.max(0, Number(p.priority))) : (base.priority ?? 1),
    tag_ids: JSON.stringify(tagIds),
    rule: JSON.stringify(checked.rule),
    start_date: startDate,
    end_date: endDate,
    enabled: p.enabled !== undefined ? (p.enabled ? 1 : 0) : (baseEnabled ? 1 : 0),
    habit: p.habit !== undefined ? (p.habit ? 1 : 0) : (baseHabit ? 1 : 0),
  };
}

/** 内容字段双向同步：规则改了就写回任务行，避免详情与规则面板各说各话 */
function syncRuleFieldsToTask(taskId, f) {
  if (taskId == null) return;
  db.prepare(
    'UPDATE tasks SET title = ?, notes = ?, priority = ?, group_id = ?, updated_at = ? WHERE id = ?'
  ).run(f.title, f.notes, f.priority, f.group_id, nowIso(), taskId);
  setTaskTags(taskId, safeJson(f.tag_ids, []));
}

/**
 * 创建重复事项：一条任务 + 一条规则，1:1。
 * originTaskId 存在时把已有的一次性任务就地转成重复事项（保留附件 / 关联笔记 / 子任务）。
 */
function createRecurringRule(p = {}) {
  const f = ruleInput(p);
  const t = nowIso();
  const originId = p.originTaskId != null ? Number(p.originTaskId) : null;
  const origin = originId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(originId) : null;
  const run = db.transaction(() => {
    let taskId;
    if (origin) {
      taskId = origin.id;
      db.prepare('UPDATE tasks SET recurring_id = NULL, archived = 0, updated_at = ? WHERE id = ?').run(t, taskId);
      syncRuleFieldsToTask(taskId, f);
    } else {
      const max = db.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE group_id IS ? AND parent_id IS NULL'
      ).get(f.group_id ?? null).m;
      taskId = Number(db.prepare(
        `INSERT INTO tasks (group_id, parent_id, title, notes, attachments, priority,
           plan_start, plan_end, reminder_at, completed, completed_at, archived,
           sort_order, created_at, updated_at)
         VALUES (?, NULL, ?, ?, '[]', ?, NULL, NULL, NULL, 0, NULL, 0, ?, ?, ?)`
      ).run(f.group_id ?? null, f.title, f.notes, f.priority, max + 1, t, t).lastInsertRowid);
      setTaskTags(taskId, safeJson(f.tag_ids, []));
    }
    const info = db.prepare(
      `INSERT INTO recurring_rules (title, notes, group_id, priority, tag_ids, rule, start_date, end_date,
         enabled, habit, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(f.title, f.notes, f.group_id, f.priority, f.tag_ids, f.rule, f.start_date, f.end_date,
      f.enabled, f.habit, taskId, t, t);
    const ruleId = Number(info.lastInsertRowid);
    db.prepare('UPDATE tasks SET recurring_id = ? WHERE id = ?').run(ruleId, taskId);
    // 原任务若已完成，把这次完成记成今天的打卡，状态不会凭空消失
    if (origin && origin.completed) {
      const day = dateU.toDay(p.today) || dateU.todayLocal();
      db.prepare(
        'INSERT OR IGNORE INTO recurrence_completions (rule_id, occurrence_date, completed_at) VALUES (?, ?, ?)'
      ).run(ruleId, day, origin.completed_at || t);
    }
    return ruleId;
  });
  const id = run();
  rollRecurringTask(id, { today: p.today });
  return getRecurringRule(id, dateU.toDay(p.today) || dateU.todayLocal());
}

/** 改规则：只动规则行 + 内容字段回写 + 重算这一条任务的下一次发生；历史打卡一律不动 */
function updateRecurringRule(id, p = {}) {
  const cur = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id);
  if (!cur) return null;
  const f = ruleInput(p, cur);
  db.transaction(() => {
    db.prepare(
      `UPDATE recurring_rules SET title = ?, notes = ?, group_id = ?, priority = ?, tag_ids = ?, rule = ?,
         start_date = ?, end_date = ?, enabled = ?, habit = ?, updated_at = ? WHERE id = ?`
    ).run(f.title, f.notes, f.group_id, f.priority, f.tag_ids, f.rule, f.start_date, f.end_date,
      f.enabled, f.habit, nowIso(), id);
    syncRuleFieldsToTask(cur.task_id, f);
  })();
  rollRecurringTask(id, { today: p.today });
  return getRecurringRule(id, dateU.toDay(p.today) || dateU.todayLocal());
}

function setRecurringEnabled(id, enabled, opts = {}) {
  const cur = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id);
  if (!cur) return null;
  db.prepare('UPDATE recurring_rules SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, nowIso(), id);
  rollRecurringTask(id, { today: opts.today });
  return getRecurringRule(id, dateU.toDay(opts.today) || dateU.todayLocal());
}

/**
 * 删除规则：任务脱钩成普通待办保留（不删用户数据），打卡历史与跳过记录一并清掉。
 * 从列表直接删除任务走 deleteTask()，那边是「整个事项都不要了」。
 */
function deleteRecurringRule(id) {
  const cur = db.prepare('SELECT task_id FROM recurring_rules WHERE id = ?').get(id);
  const run = db.transaction(() => {
    if (cur && cur.task_id != null) {
      db.prepare(
        `UPDATE tasks SET recurring_id = NULL, occurrence_date = NULL, recur_customized = 0,
           archived = 0, updated_at = ? WHERE id = ?`
      ).run(nowIso(), cur.task_id);
    }
    db.prepare('DELETE FROM recurrence_completions WHERE rule_id = ?').run(id);
    db.prepare('DELETE FROM recurrence_skips WHERE rule_id = ?').run(id);
    db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(id);
  });
  run();
  return true;
}

function listSkips(ruleId) {
  return db.prepare('SELECT occurrence_date FROM recurrence_skips WHERE rule_id = ? ORDER BY occurrence_date')
    .all(ruleId).map((r) => r.occurrence_date);
}

function clearSkips(ruleId, opts = {}) {
  db.prepare('DELETE FROM recurrence_skips WHERE rule_id = ?').run(ruleId);
  rollRecurringTask(ruleId, { today: opts.today });
  return getRecurringRule(ruleId, dateU.toDay(opts.today) || dateU.todayLocal());
}

/** 跳过某一次发生（不改变历史打卡，只是让这一天不再出现） */
function skipOccurrence(ruleId, date, opts = {}) {
  const day = dateU.toDay(date) || dateU.todayLocal();
  db.prepare('INSERT OR IGNORE INTO recurrence_skips (rule_id, occurrence_date) VALUES (?, ?)').run(ruleId, day);
  rollRecurringTask(ruleId, { today: opts.today });
  return getRecurringRule(ruleId, dateU.toDay(opts.today) || dateU.todayLocal());
}

function listCompletions(ruleId) {
  return db.prepare(
    'SELECT occurrence_date, completed_at FROM recurrence_completions WHERE rule_id = ? ORDER BY occurrence_date'
  ).all(ruleId);
}

/**
 * 日历用：一次性取出**全部**重复事项的打卡历史。
 * 重复事项只有一条任务行，跨天会被推到下一次发生日，历史完成记录只存在于
 * recurrence_completions —— 日历要回答「那天做完没有」，只能从这里回填。
 * 不做按规则 N 次 IPC（规则少量时也不值得多绕一圈）。
 */
function listCompletionsAll(f = {}) {
  const where = [];
  const params = [];
  const from = dateU.toDay(f.from);
  const to = dateU.toDay(f.to);
  if (from) { where.push('c.occurrence_date >= ?'); params.push(from); }
  if (to) { where.push('c.occurrence_date <= ?'); params.push(to); }
  const sql = `SELECT c.rule_id, c.occurrence_date, c.completed_at,
      t.id AS task_id, t.title, t.priority, t.parent_id, t.archived,
      g.name AS group_name, g.color AS group_color
    FROM recurrence_completions c
    JOIN recurring_rules r ON r.id = c.rule_id
    JOIN tasks t ON t.id = r.task_id
    LEFT JOIN groups g ON g.id = t.group_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.occurrence_date`;
  return db.prepare(sql).all(...params);
}

/** 习惯面板补打卡 / 撤销：指定发生日，不依赖当前任务行显示的是哪一天 */
function setCompletion(ruleId, date, done, opts = {}) {
  const rule = db.prepare('SELECT task_id FROM recurring_rules WHERE id = ?').get(ruleId);
  const day = dateU.toDay(date);
  if (!rule || !day) return { ok: false };
  if (done) {
    db.prepare(
      'INSERT OR REPLACE INTO recurrence_completions (rule_id, occurrence_date, completed_at) VALUES (?, ?, ?)'
    ).run(ruleId, day, nowIso());
  } else {
    db.prepare('DELETE FROM recurrence_completions WHERE rule_id = ? AND occurrence_date = ?').run(ruleId, day);
  }
  if (rule.task_id != null) rollRecurringTask(ruleId, { today: opts.today });
  return { ok: true, date: day, done: !!done };
}

/**
 * 日切推进（替代旧的「批量生成实例」）：把唯一那条任务行刷新到「下一次应发生日」。
 * 只有行的展示字段会变；标题/备注/分组/标签由用户编辑或规则面板双向同步，这里不覆盖。
 */
function rollRecurringTask(ruleId, opts = {}) {
  const today = dateU.toDay(opts.today) || dateU.todayLocal();
  const rule = normalizeRuleRow(db.prepare(`${RULE_SELECT} WHERE r.id = ?`).get(today, ruleId));
  if (!rule || rule.task_id == null) return { changed: false, date: '', taskId: null };
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(rule.task_id);
  if (!task) return { changed: false, date: '', taskId: null };

  const start = dateU.toDay(rule.start_date) || today;
  const end = dateU.toDay(rule.end_date) || '';
  const skips = new Set(listSkips(ruleId));
  let day = '';
  if (rule.enabled && (!end || today <= end)) {
    const from = today > start ? today : start;
    const list = recurRules.occurrences(rule.rule, from, dateU.addDays(from, RECUR_AHEAD_DAYS), start);
    day = list.find((d) => !skips.has(d)) || '';
  }
  const f = day
    ? recurRules.instanceFields(rule.rule, day)
    : { planStart: null, planEnd: null, reminderAt: null };
  const done = day
    ? db.prepare(
      'SELECT completed_at FROM recurrence_completions WHERE rule_id = ? AND occurrence_date = ?'
    ).get(ruleId, day)
    : null;

  const dayChanged = (task.occurrence_date || '') !== day;
  // 改了规则导致提醒时间变化，也要允许新的提醒再弹一次；否则 reminder_fired 会一直挡着
  const reminderChanged = (task.reminder_at || null) !== (f.reminderAt || null);
  const nextFired = (dayChanged || reminderChanged) ? 0 : Number(task.reminder_fired || 0);
  const before = [
    task.plan_start, task.plan_end, task.reminder_at, Number(task.completed), task.completed_at,
    Number(task.archived), task.occurrence_date, Number(task.reminder_fired || 0),
  ];
  const after = [
    f.planStart, f.planEnd, f.reminderAt, done ? 1 : 0, done ? done.completed_at : null,
    0, day || null, nextFired,
  ];
  const changed = before.some((v, i) => (v == null ? null : v) !== (after[i] == null ? null : after[i]));
  if (changed) {
    db.prepare(
      `UPDATE tasks SET plan_start = ?, plan_end = ?, reminder_at = ?, completed = ?, completed_at = ?,
         archived = 0, occurrence_date = ?, reminder_fired = ?, updated_at = ? WHERE id = ?`
    ).run(f.planStart, f.planEnd, f.reminderAt, done ? 1 : 0, done ? done.completed_at : null,
      day || null, nextFired, nowIso(), rule.task_id);
  }
  return { changed, date: day, taskId: rule.task_id };
}

/** 兼容旧调用名；调度器与测试都走这里 */
function syncRule(ruleId, opts = {}) {
  const r = rollRecurringTask(ruleId, opts);
  return { created: 0, updated: r.changed ? 1 : 0, removed: 0 };
}

/** 全量日切（启动 / 定时 / 跨自然日）；单条规则失败不拖垮其它规则 */
function syncRecurrences(opts = {}) {
  const ids = db.prepare('SELECT id FROM recurring_rules').all().map((r) => r.id);
  const out = { rules: ids.length, created: 0, updated: 0, removed: 0, errors: [] };
  for (const id of ids) {
    try {
      const r = rollRecurringTask(id, opts);
      if (r.changed) out.updated += 1;
    } catch (e) {
      out.errors.push(`规则 ${id}：${(e && e.message) || e}`);
      console.error('[db] 重复规则日切失败', id, e);
    }
  }
  return out;
}

/**
 * 习惯统计：应发生次数 / 累计完成 / 完成率 / 连续天数 / 近 30 次明细。
 * 「连续天数」按规则应发生日序列算（不是自然日），这样「每个法定工作日」跨周末也连续。
 */
function habitStats(ruleId, opts = {}) {
  const today = dateU.toDay(opts.today) || dateU.todayLocal();
  const rule = normalizeRuleRow(db.prepare(`${RULE_SELECT} WHERE r.id = ?`).get(today, ruleId));
  if (!rule) return null;
  const start = dateU.toDay(rule.start_date) || today;
  const floor = dateU.addDays(today, -400);
  const from = start > floor ? start : floor;
  const expected = recurRules.occurrences(rule.rule, from, today, start);
  const rows = listCompletions(ruleId);
  const byDay = new Map(rows.map((r) => [r.occurrence_date, r]));
  const isDone = (d) => byDay.has(d);
  const completedExpected = expected.filter(isDone).length;

  // 今天还没打卡不打断此前的连续记录：从最近一个「已过去的应发生日」往回数
  let i = expected.length - 1;
  if (i >= 0 && expected[i] === today && !isDone(today)) i -= 1;
  let streak = 0;
  for (; i >= 0; i -= 1) {
    if (isDone(expected[i])) streak += 1;
    else break;
  }
  const recent = expected.slice(-30).map((d) => ({
    date: d,
    expected: true,
    done: isDone(d),
    completedAt: (byDay.get(d) && byDay.get(d).completed_at) || null,
  }));

  return {
    ruleId,
    totalInstances: rows.length,
    doneInstances: rows.length,
    expected: expected.length,
    completedExpected,
    rate: expected.length ? Math.round((completedExpected * 100) / expected.length) : 0,
    streak,
    recent,
    todayDone: isDone(today),
    currentDate: rule.task_id == null
      ? ''
      : (db.prepare('SELECT occurrence_date FROM tasks WHERE id = ?').get(rule.task_id) || {}).occurrence_date || '',
    nextDate: rule.enabled ? (recurRules.nextOccurrence(rule.rule, today, start) || '') : '',
  };
}

/* ------------------------------ 提醒 ------------------------------ */

/** 返回所有到期未提醒且未完成的任务（按提醒时间升序：最早的一条先弹） */
function dueReminders() {
  const t = nowIso();
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE reminder_at IS NOT NULL AND reminder_at <= ? AND reminder_fired = 0
         AND completed = 0 AND archived = 0
       ORDER BY reminder_at ASC`
    )
    .all(t);
}

function markReminderFired(id) {
  db.prepare('UPDATE tasks SET reminder_fired = 1, updated_at = ? WHERE id = ?')
    .run(nowIso(), id);
}

/* ------------------------------ 统计 ------------------------------ */

/**
 * 概览统计。
 * @param {{includeSubtasks?:boolean}} [opts] 默认只统计主任务（parent_id IS NULL）；
 *        includeSubtasks=true 时把子任务一并算进来。
 */
function overview(opts = {}) {
  // 统计口径写进 SQL 条件里，不做"先全表捞出再应用层过滤"
  const top = opts && opts.includeSubtasks ? '' : 'AND parent_id IS NULL';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE 1 = 1 ${top}`).get().c;
  const active = db
    .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE completed = 0 AND archived = 0 ${top}`).get().c;
  const completed = db
    .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE completed = 1 AND archived = 0 ${top}`).get().c;
  const archived = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE archived = 1 ${top}`).get().c;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = db
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks WHERE completed = 0 AND archived = 0 ${top}
        AND plan_end IS NOT NULL AND plan_end < ?`
    )
    .get(today).c;

  // 分组统计：LEFT JOIN 的条件必须带口径，否则 JOIN 完再过滤会把"没有主任务"的分组整行丢掉
  const joinTop = opts && opts.includeSubtasks ? '' : 'AND t.parent_id IS NULL';
  const byGroup = db
    .prepare(
      `SELECT g.id, g.name, g.color, g.parent_id,
         pg.name AS parent_name, pg.color AS parent_color,
         SUM(CASE WHEN t.completed = 0 AND t.archived = 0 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN t.completed = 1 THEN 1 ELSE 0 END) AS done
       FROM groups g LEFT JOIN tasks t ON t.group_id = g.id ${joinTop}
       LEFT JOIN groups pg ON pg.id = g.parent_id
       GROUP BY g.id ORDER BY g.sort_order`
    )
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      // 同名子分组在不同父分组下看不出归属，把父分组名一并带上给界面拼 "父 / 子"
      parent_id: r.parent_id ?? null,
      parent_name: r.parent_name || '',
      parent_color: r.parent_color || '',
      active: r.active || 0,
      done: r.done || 0,
    }));

  const byPriority = db
    .prepare(
      `SELECT priority, COUNT(*) AS c FROM tasks WHERE completed = 0 AND archived = 0 ${top} GROUP BY priority`
    )
    .all()
    .map((r) => ({ priority: r.priority, count: r.c }));

  const rate = completed + active > 0 ? Math.round((completed / (completed + active)) * 100) : 0;

  return {
    total,
    active,
    completed,
    archived,
    overdue,
    byGroup,
    byPriority,
    rate,
    includeSubtasks: !!(opts && opts.includeSubtasks),
  };
}

/**
 * 完成趋势的可选时间范围。
 * 粒度随跨度变粗（天 → 周 → 月）：一年 365 根柱子既排不下也没法读，按月聚合才有意义。
 */
const TREND_RANGES = {
  '7d': { key: '7d', label: '近 7 天', granularity: 'day', buckets: 7 },
  '1m': { key: '1m', label: '近一个月', granularity: 'day', buckets: 30 },
  '6m': { key: '6m', label: '近半年', granularity: 'week', buckets: 26 },
  '1y': { key: '1y', label: '近一年', granularity: 'month', buckets: 12 },
};
const DEFAULT_TREND_RANGE = '7d';

/**
 * 归一化趋势入参。
 * 支持三种写法：{ range: '1m' }（推荐，渲染层统一用它）、'1m'、以及旧调用的数字天数。
 */
function normalizeTrendRange(arg) {
  const raw = arg && typeof arg === 'object' ? arg.range : arg;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const n = Math.round(raw);
    return { key: `${n}d`, label: `近 ${n} 天`, granularity: 'day', buckets: n };
  }
  return TREND_RANGES[String(raw || DEFAULT_TREND_RANGE)] || TREND_RANGES[DEFAULT_TREND_RANGE];
}

/**
 * 完成趋势（支持近 7 天 / 一个月 / 半年 / 一年）。
 *
 * 只查一次库（按完成时间范围取全部记录），再在内存里分桶：桶数最多 30 个，
 * 无论哪个范围都是一趟 SQL，不会像逐日查询那样放大成几十次往返。
 *
 * @param {string|number|{range:string, includeSubtasks?:boolean}} [arg] 范围；缺省 = 近 7 天。
 *        arg 为对象时可用 includeSubtasks=true 把子任务的完成记录也算进来。
 * @returns {{range:string, label:string, granularity:'day'|'week'|'month',
 *            start:string, end:string, total:number,
 *            points:Array<{key:string,label:string,count:number,start:string,end:string}>}}
 */
function dailyTrend(arg) {
  const cfg = normalizeTrendRange(arg);
  const top = arg && typeof arg === 'object' && arg.includeSubtasks ? '' : 'AND parent_id IS NULL';
  const buckets = [];

  if (cfg.granularity === 'month') {
    // 末桶 = 当月（1 号 ~ 次月 1 号），往前逐月递推
    const anchor = new Date();
    anchor.setDate(1);
    anchor.setHours(0, 0, 0, 0);
    for (let i = cfg.buckets - 1; i >= 0; i--) {
      const s = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
      const e = new Date(anchor.getFullYear(), anchor.getMonth() - i + 1, 1);
      buckets.push({ start: s, end: e, label: `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}` });
    }
  } else {
    // 天 / 周：末桶右边界对齐到「明天 0 点」，往前按 1 天或 7 天递推
    const perDay = cfg.granularity === 'week' ? 7 : 1;
    const lastEnd = new Date();
    lastEnd.setHours(24, 0, 0, 0);
    for (let i = cfg.buckets - 1; i >= 0; i--) {
      const e = new Date(lastEnd.getTime() - i * perDay * 86400000);
      const s = new Date(e.getTime() - perDay * 86400000);
      const p = (n) => String(n).padStart(2, '0');
      buckets.push({ start: s, end: e, label: `${p(s.getMonth() + 1)}-${p(s.getDate())}` });
    }
  }

  const startIso = buckets[0].start.toISOString();
  const endIso = buckets[buckets.length - 1].end.toISOString();
  const rows = db
    .prepare(
      `SELECT completed_at FROM tasks
        WHERE completed = 1 ${top} AND completed_at >= ? AND completed_at < ?`
    )
    .all(startIso, endIso);

  const counts = new Array(buckets.length).fill(0);
  for (const r of rows) {
    const ts = Date.parse(r.completed_at);
    if (!Number.isFinite(ts)) continue; // 脏数据（非法时间字符串）直接跳过
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (ts >= buckets[i].start.getTime() && ts < buckets[i].end.getTime()) { counts[i]++; break; }
    }
  }

  const points = buckets.map((b, i) => ({
    key: b.start.toISOString().slice(0, 10),
    label: b.label,
    count: counts[i],
    start: b.start.toISOString(),
    end: b.end.toISOString(),
  }));

  return {
    range: cfg.key,
    label: cfg.label,
    granularity: cfg.granularity,
    start: startIso,
    end: endIso,
    total: counts.reduce((a, b) => a + b, 0),
    points,
  };
}

/**
 * 自定义范围内的统计数据（供日报/周报/月报使用）。
 * 含子任务：不再按 parent_id 过滤，报告层自行把子任务挂到父任务下并汇总数量。
 * @param {number|number[]|null} groupId 单个分组 id、分组 id 数组（多选），null = 全部分组
 */
function rangeStats(startIso, endIso, groupId = null) {
  // 展开成 自身 + 子孙：勾选父分组即代表它下面的所有子分组
  const raw = (Array.isArray(groupId) ? groupId : groupId != null ? [groupId] : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  const ids = raw.length ? expandGroupIds(raw) : [];
  let gCond = '';
  const gParams = [];
  if (ids.length === 1) {
    gCond = ' AND group_id = ?';
    gParams.push(ids[0]);
  } else if (ids.length > 1) {
    gCond = ` AND group_id IN (${ids.map(() => '?').join(', ')})`;
    gParams.push(...ids);
  }

  // 分组兜底：子任务一般继承父任务的分组，但历史数据 / 手动改过父分组时可能带 NULL，
  // 这类子任务跟在父任务身边（父任务命中即带上），不能因为 group_id 不在筛选里就丢掉。
  const inScope = (t) => {
    if (!ids.length) return true;
    if (t.group_id != null && ids.includes(t.group_id)) return true;
    if (t.parent_id != null) {
      const parent = getTask(t.parent_id);
      if (parent) return inScope(parent);
    }
    return false;
  };

  const completedTasks = db
    .prepare(
      `SELECT * FROM tasks WHERE completed = 1 AND completed_at >= ? AND completed_at < ? ${gCond} ORDER BY completed_at ASC`
    )
    .all(startIso, endIso, ...gParams)
    .filter(inScope);

  const createdTasks = db
    .prepare(
      `SELECT * FROM tasks WHERE created_at >= ? AND created_at < ? ${gCond} ORDER BY created_at ASC`
    )
    .all(startIso, endIso, ...gParams)
    .filter(inScope);

  const activeNow = db
    .prepare(
      `SELECT * FROM tasks WHERE completed = 0 AND archived = 0 ${gCond} ORDER BY priority DESC, (plan_end IS NULL), plan_end`
    )
    .all(...gParams)
    .filter(inScope);

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

/**
 * 最早一条任务的创建时间（UTC ISO 8601）。没有任务时返回 null。
 * 用途：老的 settings 里没有首次启动时间，拿它兜底算「已经用了多少天」，
 * 免得老用户升级后要从今天重新起算。
 */
function earliestTaskAt() {
  const row = db.prepare('SELECT MIN(created_at) AS t FROM tasks').get();
  return row && row.t ? row.t : null;
}

/* ------------------------------ 会议录制 / 纪要 ------------------------------ */

/** meetings 表允许写入的字段白名单（防 SQL 拼接注入） */
const MEETING_FIELDS = [
  'title', 'source_label', 'mode', 'started_at', 'duration_ms',
  'media_paths', 'transcript', 'summary', 'todos', 'status',
];

/** JSON 字符串字段：统一做一次解析/兜底，避免上层反复判空 */
function parseJsonField(raw, fallback) {
  try {
    const v = JSON.parse(raw || '[]');
    return v;
  } catch (e) {
    return fallback;
  }
}

function rowToMeeting(row) {
  // 与 getTask 保持一致：查不到返回 null（渲染层统一用 null 判空）
  if (!row) return null;
  return {
    ...row,
    media_paths: parseJsonField(row.media_paths, []),
    todos: parseJsonField(row.todos, []),
  };
}

/**
 * 新建会议记录。
 * @param {{title?:string, source_label?:string, mode?:string, started_at?:string,
 *          duration_ms?:number, media_paths?:string[], status?:string}} p
 */
function createMeeting(p = {}) {
  const now = nowIso();
  const info = db.prepare(
    `INSERT INTO meetings (title, source_label, mode, started_at, duration_ms, media_paths, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    p.title || '未命名会议',
    p.source_label || '',
    p.mode || 'audio',
    p.started_at || now,
    Number(p.duration_ms) || 0,
    JSON.stringify(p.media_paths || []),
    p.status || 'recorded',
    now,
    now,
  );
  return getMeeting(info.lastInsertRowid);
}

/** 最近会议列表（倒序） */
function listMeetings(limit = 200) {
  const rows = db.prepare('SELECT * FROM meetings ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
  return rows.map(rowToMeeting);
}

function getMeeting(id) {
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  return rowToMeeting(row);
}

/** 局部更新会议记录（只更新传入字段） */
function updateMeeting(id, p = {}) {
  const keys = Object.keys(p).filter((k) => MEETING_FIELDS.includes(k));
  if (keys.length === 0) return getMeeting(id);
  const sets = keys.map((k) => `${k} = ?`);
  const values = keys.map((k) => {
    const v = p[k];
    // media_paths / todos 允许数组传入，统一序列化
    if (k === 'media_paths' || k === 'todos') return JSON.stringify(Array.isArray(v) ? v : (v || []));
    if (k === 'duration_ms') return Number(v) || 0;
    return v == null ? '' : String(v);
  });
  db.prepare(`UPDATE meetings SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
  return getMeeting(id);
}

function deleteMeeting(id) {
  return db.prepare('DELETE FROM meetings WHERE id = ?').run(id).changes;
}

/* ------------------------------ AI 报告历史 ------------------------------ */

/** reports 表允许写入的字段白名单 */
const REPORT_FIELDS = [
  'title', 'type', 'range_start', 'range_end', 'group_ids', 'group_label',
  'extra_prompt', 'content', 'degraded',
];

function rowToReport(row) {
  if (!row) return null;
  return { ...row, group_ids: parseJsonField(row.group_ids, []), degraded: !!row.degraded };
}

/**
 * 保存一份报告（生成时调用，返回带 id 的记录）。
 * @param {{title?:string,type?:string,range_start?:string,range_end?:string,
 *          group_ids?:number[],group_label?:string,extra_prompt?:string,
 *          content?:string,degraded?:boolean}} p
 */
function createReport(p = {}) {
  const now = nowIso();
  const info = db.prepare(
    `INSERT INTO reports (title, type, range_start, range_end, group_ids, group_label, extra_prompt, content, degraded, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    p.title || '未命名报告',
    p.type || 'custom',
    p.range_start || null,
    p.range_end || null,
    JSON.stringify(Array.isArray(p.group_ids) ? p.group_ids : []),
    p.group_label || '',
    p.extra_prompt || '',
    p.content || '',
    p.degraded ? 1 : 0,
    now,
    now,
  );
  return getReport(info.lastInsertRowid);
}

/** 报告历史（倒序，内容裁掉：列表只需要摘要，正文单独取） */
function listReports(limit = 100) {
  const rows = db.prepare(
    `SELECT id, title, type, range_start, range_end, group_label, extra_prompt,
            degraded, created_at, updated_at,
            length(content) AS content_len
       FROM reports ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(limit);
  return rows.map((r) => ({ ...r, degraded: !!r.degraded }));
}

function getReport(id) {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  return rowToReport(row);
}

/** 局部更新报告（编辑后自动保存用） */
function updateReport(id, p = {}) {
  const keys = Object.keys(p).filter((k) => REPORT_FIELDS.includes(k));
  if (keys.length === 0) return getReport(id);
  const sets = keys.map((k) => `${k} = ?`);
  const values = keys.map((k) => {
    const v = p[k];
    if (k === 'group_ids') return JSON.stringify(Array.isArray(v) ? v : []);
    if (k === 'degraded') return v ? 1 : 0;
    return v == null ? '' : String(v);
  });
  db.prepare(`UPDATE reports SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
  return getReport(id);
}

function deleteReport(id) {
  return db.prepare('DELETE FROM reports WHERE id = ?').run(id).changes;
}

/* ------------------------------ AI 检索历史 ------------------------------ */

function rowToSearch(row) {
  if (!row) return null;
  return { ...row, tasks: parseJsonField(row.tasks, []), degraded: !!row.degraded };
}

/**
 * 保存一次 AI 检索（关键词 + 总结 + 命中任务快照）。
 * @param {{keyword:string, summary?:string, task_count?:number, tasks?:object[], degraded?:boolean}} p
 */
function createSearch(p = {}) {
  const info = db.prepare(
    `INSERT INTO ai_searches (keyword, summary, task_count, tasks, degraded, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    String(p.keyword || ''),
    p.summary || '',
    Number(p.task_count) || 0,
    JSON.stringify(Array.isArray(p.tasks) ? p.tasks : []),
    p.degraded ? 1 : 0,
    nowIso(),
  );
  return getSearch(info.lastInsertRowid);
}

/** 检索历史（倒序；tasks 只回传摘要，点开时再取完整内容） */
function listSearches(limit = 100) {
  const rows = db.prepare(
    `SELECT id, keyword, task_count, degraded, created_at,
            substr(summary, 1, 120) AS summary_excerpt
       FROM ai_searches ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(limit);
  return rows.map((r) => ({ ...r, degraded: !!r.degraded }));
}

function getSearch(id) {
  const row = db.prepare('SELECT * FROM ai_searches WHERE id = ?').get(id);
  return rowToSearch(row);
}

function deleteSearch(id) {
  return db.prepare('DELETE FROM ai_searches WHERE id = ?').run(id).changes;
}

/* ------------------------------ 知识库问答历史 ------------------------------ */

function rowToKbQa(row) {
  if (!row) return null;
  return { ...row, hits: parseJsonField(row.hits, []), degraded: !!row.degraded };
}

/**
 * 保存一次知识库提问（问题 + 回答 + 引用片段快照）。
 * hits 只留溯源所需字段且 content 截断 —— 历史是回看用的，不必存整段原文。
 */
function createKbQa(p = {}) {
  const slimHits = (Array.isArray(p.hits) ? p.hits : []).map((h) => ({
    noteId: h.noteId ?? null,
    title: h.title || '',
    headingPath: h.headingPath || '',
    matchTerm: h.matchTerm || '',
    snippet: String(h.snippet || h.content || '').slice(0, 200),
    relevance: Number(h.relevance) || 0,
  }));
  const info = db.prepare(
    `INSERT INTO kb_qa (question, answer, hits, hit_count, degraded, reason, scope, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    String(p.question || ''),
    p.answer || '',
    JSON.stringify(slimHits),
    slimHits.length,
    p.degraded ? 1 : 0,
    p.reason || '',
    String(p.scope || ''),
    nowIso(),
  );
  return getKbQa(info.lastInsertRowid);
}

/** 问答历史（倒序；answer 只回传摘要，点开时再取完整内容） */
function listKbQa(limit = 50) {
  return db
    .prepare(
      `SELECT id, question, hit_count, degraded, reason, scope, created_at,
              substr(answer, 1, 80) AS answer_excerpt
         FROM kb_qa ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(limit)
    .map((r) => ({ ...r, degraded: !!r.degraded }));
}

function getKbQa(id) {
  return rowToKbQa(db.prepare('SELECT * FROM kb_qa WHERE id = ?').get(id));
}

function deleteKbQa(id) {
  return db.prepare('DELETE FROM kb_qa WHERE id = ?').run(id).changes;
}

/* ------------------------------ 笔记模块 ------------------------------ */

/** sha1 文本摘要：判定笔记内容是否变化（增量索引用） */
function hashText(s) {
  return nodeCrypto.createHash('sha1').update(String(s || '')).digest('hex');
}

/**
 * 去掉「字体颜色 / 背景高亮」标记：`==文字=={c:#e5484d;bg:#fff3a3}` → `文字`。
 * 标记只是给渲染层看的，摘要 / 字数 / 检索 / 知识库分块都按纯文本处理，
 * 否则用户搜「灰度」会因为正文里写着 `{c:#...}` 之类的字符而命中错位。
 * @param {string} md
 */
function stripStyleMarks(md) {
  return String(md || '')
    .replace(/==([^=\n]+)==(?:\{[^{}\n]*\})?/g, '$1')
    // 番茄时间线前缀（行首 ● / ◐）：只剥前缀，保留那句「做到哪了」的正文
    .replace(/^[●◐]\s*/gm, '');
}

/**
 * Markdown → 纯文本（摘要 / 字数 / 检索都用它）。
 * @param {string} md
 * @param {boolean} [keepStyle=false] 保留颜色 / 高亮标记。
 *   摘要要保留（列表卡片要按原色渲染），字数与检索不要（标记不该被当成正文去匹配）。
 */
function plainTextOf(md, keepStyle = false) {
  return (keepStyle ? String(md || '') : stripStyleMarks(md))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 中英混排字数：英文按词、中文按字 */
function wordCountOf(md) {
  const plain = plainTextOf(md);
  const en = (plain.match(/[A-Za-z0-9]+/g) || []).length;
  const zh = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
  return en + zh;
}

/**
 * 摘要：保留颜色 / 高亮标记（列表卡片要按原色渲染），
 * 字数 / 检索仍走 plainTextOf 的剥离版本。
 */
function excerptOf(md, len = 120) {
  const plain = plainTextOf(md, true);
  return plain.length > len ? `${plain.slice(0, len)}…` : plain;
}

/**
 * 命中片段（搜索结果高亮用）。
 * 不用 FTS 的 snippet()：external content 表上调用它会直接报 "SQL logic error"，
 * 因此在应用层按关键词定位截取——反正列表里本来就有纯文本摘要，开销可忽略。
 * @returns {{text:string, start:number, hit:boolean}} start 是片段在纯文本里的起始下标
 */
function snippetOf(text, keyword, len = 90) {
  const plain = plainTextOf(text);
  const kw = String(keyword || '');
  const i = kw ? plain.toLowerCase().indexOf(kw.toLowerCase()) : -1;
  if (i < 0) {
    return { text: plain.length > len ? `${plain.slice(0, len)}…` : plain, start: 0, hit: false };
  }
  const start = Math.max(0, i - Math.floor(len / 3));
  const seg = plain.slice(start, start + len);
  return {
    text: `${start > 0 ? '…' : ''}${seg}${start + len < plain.length ? '…' : ''}`,
    start,
    hit: true,
  };
}

/** 兼容旧调用：只要片段文本 */
function highlightOf(text, keyword, len = 90) {
  return snippetOf(text, keyword, len).text;
}

/** 关键词在文本里出现的次数（不重叠、大小写不敏感） */
function countMatches(text, keyword) {
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return 0;
  const s = String(text || '').toLowerCase();
  let n = 0;
  let i = s.indexOf(kw);
  while (i >= 0) { n += 1; i = s.indexOf(kw, i + kw.length); }
  return n;
}

/* ---------------- 笔记目录 ---------------- */

/** 目录名唯一性作用域 = 同一 parent_id（与分组同名规则一致，不加数据库唯一索引） */
function folderNameTaken(name, parentId, exceptId = null) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  const row = db
    .prepare(
      `SELECT id FROM note_folders
        WHERE TRIM(LOWER(name)) = ? AND parent_id IS ${parentId == null ? 'NULL' : '?'}
          AND id IS NOT ${exceptId == null ? 'NULL' : '?'} LIMIT 1`
    )
    .get(...[n, parentId, exceptId].filter((v) => v != null));
  return !!row;
}

function assertFolderName(name, parentId, exceptId = null) {
  const n = String(name || '').trim();
  if (!n) throw new Error('目录名不能为空');
  if (n.length > 60) throw new Error('目录名不能超过 60 个字符');
  if (folderNameTaken(n, parentId, exceptId)) throw new Error('同一层级下已存在同名目录');
  return n;
}

/** 目录自身 + 所有后代目录 id */
function descendantFolderIds(id) {
  const out = [];
  const stack = [Number(id)];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const c of db.prepare('SELECT id FROM note_folders WHERE parent_id = ?').all(cur)) stack.push(c.id);
  }
  return out;
}

function listNoteFolders() {
  return db.prepare('SELECT * FROM note_folders ORDER BY sort_order ASC, id ASC').all();
}

function getNoteFolder(id) {
  return db.prepare('SELECT * FROM note_folders WHERE id = ?').get(id) || null;
}

function createNoteFolder({ name, parentId = null, color = '#4f7cff' } = {}) {
  assertFolderName(name, parentId, null);
  if (parentId != null && !getNoteFolder(parentId)) throw new Error('父目录不存在');
  const now = nowIso();
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM note_folders WHERE parent_id IS ?')
    .get(parentId).m;
  const info = db
    .prepare(
      `INSERT INTO note_folders (name, parent_id, color, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(String(name).trim(), parentId ?? null, normalizeColor(color, '#4f7cff'), max + 1, now, now);
  return getNoteFolder(info.lastInsertRowid);
}

function updateNoteFolder(id, { name, color, parentId } = {}) {
  const cur = getNoteFolder(id);
  if (!cur) return null;
  const nextParent = parentId !== undefined ? parentId : cur.parent_id;
  // 不允许挂到自己或自己的子孙下（否则目录树成环）
  if (nextParent != null) {
    if (Number(nextParent) === Number(id)) throw new Error('目录不能挂在自己下面');
    if (descendantFolderIds(id).includes(Number(nextParent))) throw new Error('目录不能挂到自己的子目录下');
  }
  const nextName = name !== undefined ? assertFolderName(name, nextParent, id) : cur.name;
  db.prepare('UPDATE note_folders SET name = ?, color = ?, parent_id = ?, updated_at = ? WHERE id = ?')
    .run(nextName, normalizeColor(color !== undefined ? color : cur.color, cur.color), nextParent, nowIso(), id);
  return getNoteFolder(id);
}

/**
 * 删除目录：子目录提升到父级，目录内笔记移到父级（顶级目录内则落到「未分类」）。
 * 笔记本身不删除——删目录是整理结构，不该顺手删内容。
 */
function deleteNoteFolder(id) {
  const cur = getNoteFolder(id);
  if (!cur) return false;
  const run = db.transaction(() => {
    const parent = cur.parent_id ?? null;
    db.prepare('UPDATE note_folders SET parent_id = ?, updated_at = ? WHERE parent_id = ?')
      .run(parent, nowIso(), id);
    db.prepare('UPDATE notes SET folder_id = ?, updated_at = ? WHERE folder_id = ?')
      .run(parent, nowIso(), id);
    db.prepare('DELETE FROM note_folders WHERE id = ?').run(id);
  });
  run();
  return true;
}

/* ---------------- 笔记 ---------------- */

/** 可写字段白名单（防 SQL 拼接注入） */
const NOTE_FIELDS = ['folder_id', 'title', 'content_md', 'pinned', 'archived', 'sort_order', 'source', 'source_ref'];

/** 列表不回传正文：列表页只需要摘要，正文由 getNote() 单独取 */
const NOTE_LIST_COLUMNS = `n.id, n.folder_id, n.title, n.excerpt, n.pinned, n.archived, n.deleted_at,
  n.word_count, n.content_hash, n.source, n.source_ref, n.sort_order, n.created_at, n.updated_at,
  n.attachments,
  (SELECT COUNT(*) FROM task_notes tn WHERE tn.note_id = n.id) AS ref_count`;

/** 给一批笔记挂上 tags 数组与 ref_count（整数化） */
function attachNoteTags(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
  const placeholders = ids.map(() => '?').join(',');
  const tagRows = db
    .prepare(
      `SELECT m.note_id, t.id, t.name, t.color
         FROM note_tag_map m JOIN note_tags t ON t.id = m.tag_id
        WHERE m.note_id IN (${placeholders}) ORDER BY t.name`
    )
    .all(...ids);
  const map = new Map();
  for (const r of tagRows) {
    if (!map.has(r.note_id)) map.set(r.note_id, []);
    map.get(r.note_id).push({ id: r.id, name: r.name, color: r.color });
  }
  // attachments 是 JSON 字符串字段：列表页要用它显示「几张图」，这里统一解析一次
  return rows.map((r) => ({
    ...r,
    tags: map.get(r.id) || [],
    ref_count: Number(r.ref_count) || 0,
    attachments: (() => {
      const v = parseJsonField(r.attachments, []);
      return Array.isArray(v) ? v : [];
    })(),
  }));
}

/**
 * 笔记列表。
 * @param {object} f { folderId, includeSubfolders, archived:'exclude'|'only'|'include',
 *                     tagId, keyword, deleted:'exclude'|'only'|'include', limit, sort }
 */
function listNotes(f = {}) {
  const folderId = f.folderId === undefined || f.folderId === null ? undefined : Number(f.folderId);
  const deleted = f.deleted || 'exclude';
  const archived = f.archived || 'exclude';
  const where = [];
  const params = [];

  if (deleted === 'exclude') where.push('n.deleted_at IS NULL');
  else if (deleted === 'only') where.push('n.deleted_at IS NOT NULL');
  if (archived === 'exclude') where.push('n.archived = 0');
  else if (archived === 'only') where.push('n.archived = 1');

  // folderId = 0 表示「未分类」（folder_id IS NULL），与分组筛选里 '__none' 的语义一致
  if (folderId !== undefined && !Number.isNaN(folderId)) {
    if (folderId === 0) {
      where.push('n.folder_id IS NULL');
    } else if (f.includeSubfolders) {
      const ids = descendantFolderIds(folderId);
      where.push(`n.folder_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    } else {
      where.push('n.folder_id = ?');
      params.push(folderId);
    }
  }
  if (f.tagId != null) {
    where.push('EXISTS (SELECT 1 FROM note_tag_map m WHERE m.note_id = n.id AND m.tag_id = ?)');
    params.push(Number(f.tagId));
  }
  if (f.keyword) {
    where.push('(n.title LIKE ? OR n.content_md LIKE ?)');
    params.push(`%${f.keyword}%`, `%${f.keyword}%`);
  }

  const orderBy =
    f.sort === 'title' ? 'n.title ASC'
      : f.sort === 'created' ? 'n.created_at DESC'
        : 'n.pinned DESC, n.updated_at DESC';
  const limit = Number(f.limit) > 0 ? Number(f.limit) : 500;
  const sql = `SELECT ${NOTE_LIST_COLUMNS} FROM notes n
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderBy} LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit);
  return attachNoteTags(rows);
}

function getNote(id) {
  const row = db
    .prepare(
      `SELECT n.*, (SELECT COUNT(*) FROM task_notes tn WHERE tn.note_id = n.id) AS ref_count
         FROM notes n WHERE n.id = ?`
    )
    .get(id);
  return attachNoteTags(row ? [row] : [])[0] || null;
}

function createNote({ title = '', contentMd = '', folderId = null, tagIds = [], source = 'manual', sourceRef = '' } = {}) {
  const now = nowIso();
  const content = String(contentMd || '');
  const create = db.transaction(() => {
    const max = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM notes WHERE folder_id IS ?')
      .get(folderId ?? null).m;
    const info = db
      .prepare(
        `INSERT INTO notes (folder_id, title, content_md, excerpt, word_count, content_hash, source, source_ref, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        folderId ?? null,
        String(title || '未命名笔记'),
        content,
        excerptOf(content),
        wordCountOf(content),
        hashText(content),
        source || 'manual',
        sourceRef || '',
        max + 1,
        now,
        now
      );
    const noteId = info.lastInsertRowid;
    setNoteTags(noteId, tagIds);
    return noteId;
  });
  return getNote(create());
}

/** 局部更新笔记：改正文时同步重算摘要 / 字数 / 哈希（增量索引靠哈希判断是否要重建分块） */
function updateNote(id, patch = {}) {
  const cur = getNote(id);
  if (!cur) return null;
  const keys = Object.keys(patch).filter((k) => NOTE_FIELDS.includes(k));
  if (keys.length === 0 && !patch.tagIds) return cur;

  const run = db.transaction(() => {
    if (keys.length) {
      const sets = keys.map((k) => `${k} = ?`);
      const values = keys.map((k) => {
        const v = patch[k];
        if (k === 'pinned' || k === 'archived') return v ? 1 : 0;
        if (k === 'folder_id') return v === null || v === undefined || v === 0 ? null : Number(v);
        if (k === 'sort_order') return Number(v) || 0;
        return v == null ? '' : String(v);
      });
      // 正文变了才重算派生列；只改标题/目录时不动 content_hash，避免无谓重建索引
      if (patch.content_md !== undefined) {
        const content = String(patch.content_md || '');
        sets.push('excerpt = ?', 'word_count = ?', 'content_hash = ?');
        values.push(excerptOf(content), wordCountOf(content), hashText(content));
      }
      db.prepare(`UPDATE notes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, nowIso(), id);
    }
    if (patch.tagIds) setNoteTags(id, patch.tagIds);
  });
  run();
  return getNote(id);
}

/** 归档 / 取消归档（归档只是折叠出主列表，内容仍可被检索与引用） */
function setNoteArchived(id, archived = true) {
  db.prepare('UPDATE notes SET archived = ?, updated_at = ? WHERE id = ?')
    .run(archived ? 1 : 0, nowIso(), id);
  return getNote(id);
}

/** 置顶 / 取消置顶 */
function setNotePinned(id, pinned = true) {
  db.prepare('UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?')
    .run(pinned ? 1 : 0, nowIso(), id);
  return getNote(id);
}

/**
 * 软删除（进回收站）：内容与任务关联都保留，恢复后引用自动复原；
 * 同时从知识库索引里摘掉（回收站里的笔记不该被 AI 检索命中）。
 */
function trashNote(id) {
  const cur = getNote(id);
  if (!cur) return null;
  const run = db.transaction(() => {
    db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
    deleteKbDocBySourceKey(`note:${id}`);
  });
  run();
  return getNote(id);
}

/** 恢复回收站笔记（知识库索引由上层调用 knowledge.indexNote() 重建） */
function restoreNote(id) {
  db.prepare('UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
  return getNote(id);
}

/**
 * 彻底删除：先摘掉所有任务引用，再删笔记（分块随 kb_documents 级联清除）。
 * @returns {{noteId:number, unlinkedTasks:number[]}} 被解除引用的任务 id（提示用户用）
 */
function purgeNote(id) {
  const cur = getNote(id);
  if (!cur) return { noteId: Number(id), unlinkedTasks: [] };
  const run = db.transaction(() => {
    const tasks = db.prepare('SELECT task_id FROM task_notes WHERE note_id = ?').all(id).map((r) => r.task_id);
    db.prepare('DELETE FROM task_notes WHERE note_id = ?').run(id);
    deleteKbDocBySourceKey(`note:${id}`);
    db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    return tasks;
  });
  return { noteId: Number(id), unlinkedTasks: run() };
}

/**
 * 笔记附件（图片）元数据。
 * 与 tasks.attachments 同一套约定：库里只存 {id,name,size,mime,path,added_at}，
 * path 是相对 `attachments/` 的相对路径，文件本体由 main/attachments.js 落盘。
 */
function getNoteAttachments(noteId) {
  const row = db.prepare('SELECT attachments FROM notes WHERE id = ?').get(noteId);
  const list = parseJsonField(row ? row.attachments : '[]', []);
  return Array.isArray(list) ? list : [];
}

/** 覆盖式写回附件列表，返回最新列表 */
function setNoteAttachments(noteId, list = []) {
  const arr = Array.isArray(list) ? list : [];
  db.prepare('UPDATE notes SET attachments = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(arr), nowIso(), noteId);
  return arr;
}

/** 回收站列表（按删除时间倒序） */
function listTrash() {
  const rows = db
    .prepare(
      `SELECT ${NOTE_LIST_COLUMNS} FROM notes n WHERE n.deleted_at IS NOT NULL
        ORDER BY n.deleted_at DESC LIMIT 200`
    )
    .all();
  return attachNoteTags(rows);
}

/** 清空回收站（返回被彻底删除的笔记数） */
function emptyTrash() {
  const ids = db.prepare('SELECT id FROM notes WHERE deleted_at IS NOT NULL').all().map((r) => r.id);
  const run = db.transaction(() => {
    for (const id of ids) purgeNote(id);
  });
  run();
  return ids.length;
}

/** 检索列：比列表多取正文——命中片段与匹配次数都要基于正文算（返回前会把正文摘掉） */
const NOTE_SEARCH_COLUMNS = `${NOTE_LIST_COLUMNS}, n.content_md`;

/**
 * 全文检索（FTS5 trigram；关键词 < 3 字符时回退 LIKE——trigram 不支持更短的查询）。
 *
 * 除了 bm25，这里再补三个界面真正需要的量：
 * - matchCount：关键词在「标题 + 正文」里的总命中次数（展示「N 处匹配」）；
 * - titleHit：是否命中标题（找「那篇叫 X 的笔记」时标题命中应优先）；
 * - snippet / snippetStart：围绕首次命中的原文片段，供界面高亮与溯源；
 * 最终按「FTS 名次 + 命中次数 + 标题命中」的融合分排序——只用 bm25 时，
 * 标题完全命中但正文短的笔记会排在正文里关键词刷了一堆的长文后面。
 *
 * @returns 笔记列表（含 score / matchCount / titleHit / snippet / snippetStart）
 */
function searchNotes(keyword, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const limit = Number(opts.limit) || 50;
  const deleted = opts.deleted || 'exclude';
  const archived = opts.archived || 'include';

  const where = [];
  if (deleted === 'exclude') where.push('n.deleted_at IS NULL');
  else if (deleted === 'only') where.push('n.deleted_at IS NOT NULL');
  if (archived === 'exclude') where.push('n.archived = 0');
  const w = where.length ? ` AND ${where.join(' AND ')}` : '';

  // trigram 查询词至少 3 字符，且要做短语化处理（转义双引号后整体加引号）
  let rows = null;
  if (kw.length >= 3) {
    const phrase = `"${kw.replace(/"/g, '""')}"`;
    try {
      rows = db
        .prepare(
          `SELECT ${NOTE_SEARCH_COLUMNS}, bm25(notes_fts) AS score
             FROM notes_fts f JOIN notes n ON n.id = f.rowid
            WHERE notes_fts MATCH ?${w}
            ORDER BY score ASC LIMIT ?`
        )
        .all(phrase, limit);
    } catch (e) {
      // FTS 语句被判为非法（特殊字符等）时静默降级到 LIKE，不让搜索直接崩掉
      console.warn('[db] 笔记全文检索降级为 LIKE：', e && e.message);
      rows = null;
    }
  }
  if (!rows || !rows.length) {
    // trigram 只认连续片段：「灰度 方案」这种带空格 / 换序的输入会直接零命中。
    // 先退 LIKE（整串），再退模糊词元 —— 保证「实时搜索框里打到一半」也有东西可看。
    rows = db
      .prepare(
        `SELECT ${NOTE_SEARCH_COLUMNS}, 0 AS score FROM notes n
          WHERE (n.title LIKE ? OR n.content_md LIKE ?)${w}
          ORDER BY n.pinned DESC, n.updated_at DESC LIMIT ?`
      )
      .all(`%${kw}%`, `%${kw}%`, limit);
  }
  if (!rows.length) {
    // 模糊兜底要卡一道覆盖率：只留「至少命中一半词元」的笔记。
    // 不设门槛的话搜「灰度发布」会把只含「发布」的《发布事故》也捞出来，反而像搜错了。
    rows = fuzzyNoteRows(kw, { limit, deleted, archived })
      .filter((r) => (Number(r.fuzzy_hits) || 0) / Math.max(1, Number(r.fuzzy_total) || 1) >= 0.5);
  }

  const total = rows.length || 1;
  return attachNoteTags(rows)
    .map((r, idx) => {
      const titleHit = countMatches(r.title, kw) > 0;
      const matchCount = countMatches(r.title, kw) + countMatches(r.content_md, kw);
      const seg = snippetOf(r.content_md, kw, 110);
      // 正文没命中（只在标题里）时退化成摘要，避免片段和标题重复
      const snippet = seg.hit ? seg.text : snippetOf(r.excerpt || r.content_md, '', 110).text;
      const { content_md: _omit, ...rest } = r;
      void _omit;
      return {
        ...rest,
        score: ((total - idx) / total) * 0.6
          + (Math.min(matchCount, 20) / 20) * 0.25
          + (titleHit ? 0.15 : 0),
        matchCount,
        titleHit,
        snippet,
        snippetStart: seg.hit ? seg.start : 0,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * 查询 → 模糊检索词元：中文切二元组（没有空格分词，二元组是最划算的字面特征），
 * 英文 / 数字按词切，整体去重并截断（SQL 里每个词元要占两组 LIKE 参数）。
 */
function fuzzyTokens(keyword, max = 8) {
  const s = String(keyword || '').toLowerCase();
  const out = [];
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.push(w);
  // 中文不能用 \W 清洗（\W 在 JS 里匹配所有非 [A-Za-z0-9_] 的字符，汉字也会被当成标点删掉），
  // 这里只取 CJK 字符做二元组
  const cjk = (s.match(/[㐀-鿿぀-ヿ]/g) || []).join('');
  if (cjk.length === 1) out.push(cjk);
  else for (let i = 0; i < cjk.length - 1; i += 1) out.push(cjk.slice(i, i + 2));
  return [...new Set(out.filter((x) => x))].slice(0, max);
}

/**
 * 模糊检索底层查询：把查询切成词元后逐元 LIKE，按「命中不同词元的个数」打分。
 * 补 FTS trigram 只认连续片段的盲区 —— 用户搜「灰度 发布策略」，
 * 库里写的是「灰度发布」，FTS 直接扑空，但词元「灰度 / 发布」能命中。
 *
 * @returns 原始行（含 content_md 与 fuzzy_hits / fuzzy_total，供 searchNotes 继续算指标）
 */
function fuzzyNoteRows(kw, { limit = 20, deleted = 'exclude', archived = 'include' } = {}) {
  const tokens = fuzzyTokens(kw);
  if (!tokens.length) return [];
  const where = [];
  if (deleted === 'exclude') where.push('n.deleted_at IS NULL');
  else if (deleted === 'only') where.push('n.deleted_at IS NOT NULL');
  if (archived === 'exclude') where.push('n.archived = 0');

  // 每个词元两组参数：WHERE 里一组（命中任一即入选），SELECT 里一组（累加覆盖率）
  const likePair = '(n.title LIKE ? OR n.content_md LIKE ?)';
  const conds = tokens.map(() => likePair);
  const scoreExpr = tokens.map(() => `(CASE WHEN ${likePair} THEN 1 ELSE 0 END)`).join(' + ');
  const params = [];
  tokens.forEach((t) => params.push(`%${t}%`, `%${t}%`));

  return db
    .prepare(
      `SELECT ${NOTE_SEARCH_COLUMNS}, (${scoreExpr}) AS fuzzy_hits, ${tokens.length} AS fuzzy_total
         FROM notes n
        WHERE (${conds.join(' OR ')})${where.length ? ` AND ${where.join(' AND ')}` : ''}
        ORDER BY fuzzy_hits DESC, n.updated_at DESC LIMIT ?`
    )
    .all(...params, ...params, limit);
}

/**
 * 模糊检索（对外）。
 * @returns 笔记列表（含 fuzzyScore：0~1 的词元覆盖率）
 */
function fuzzySearchNotes(keyword, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const rows = fuzzyNoteRows(kw, {
    limit: Number(opts.limit) || 20,
    deleted: opts.deleted || 'exclude',
    archived: opts.archived || 'include',
  });
  return attachNoteTags(rows).map((r) => {
    const { content_md: _omit, ...rest } = r;
    void _omit;
    return { ...rest, fuzzyScore: (Number(r.fuzzy_hits) || 0) / Math.max(1, Number(r.fuzzy_total) || 1) };
  });
}

/* ---------------- 笔记标签 ---------------- */

function listNoteTags() {
  return db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM note_tag_map m WHERE m.tag_id = t.id) AS note_count
         FROM note_tags t ORDER BY t.name`
    )
    .all();
}

function createNoteTag(name, color = '#8896ab') {
  const n = String(name || '').trim();
  if (!n) throw new Error('标签名不能为空');
  const exist = db.prepare('SELECT * FROM note_tags WHERE name = ?').get(n);
  if (exist) return exist; // 与任务标签一致：同名即复用
  const info = db
    .prepare('INSERT INTO note_tags (name, color) VALUES (?, ?)')
    .run(n, normalizeColor(color, '#8896ab'));
  return db.prepare('SELECT * FROM note_tags WHERE id = ?').get(info.lastInsertRowid);
}

function deleteNoteTag(id) {
  // note_tag_map 对 tag_id 有 ON DELETE CASCADE（init 里 foreign_keys = ON），
  // 删标签时引用关系一并清掉，笔记正文不受影响
  return db.prepare('DELETE FROM note_tags WHERE id = ?').run(id).changes;
}

/**
 * 重命名 / 改色（标签此前只能建不能改）。同名冲突时报可读错误，
 * 因为 note_tags.name 有 UNIQUE 约束，直接撞库会抛出晦涩的 SQLITE_CONSTRAINT。
 */
function updateNoteTag(id, { name, color } = {}) {
  const cur = db.prepare('SELECT * FROM note_tags WHERE id = ?').get(id);
  if (!cur) return null;
  const nextName = name !== undefined ? String(name || '').trim() : cur.name;
  if (!nextName) throw new Error('标签名不能为空');
  if (nextName !== cur.name) {
    const dup = db.prepare('SELECT id FROM note_tags WHERE name = ? AND id != ?').get(nextName, id);
    if (dup) throw new Error(`标签「${nextName}」已存在`);
  }
  db.prepare('UPDATE note_tags SET name = ?, color = ? WHERE id = ?')
    .run(nextName, normalizeColor(color !== undefined ? color : cur.color, cur.color), id);
  return db.prepare('SELECT * FROM note_tags WHERE id = ?').get(id);
}

function setNoteTags(noteId, tagIds) {
  const ids = Array.isArray(tagIds) ? tagIds.map(Number).filter((n) => Number.isFinite(n)) : [];
  const run = db.transaction(() => {
    db.prepare('DELETE FROM note_tag_map WHERE note_id = ?').run(noteId);
    const ins = db.prepare('INSERT OR IGNORE INTO note_tag_map (note_id, tag_id) VALUES (?, ?)');
    for (const tid of ids) ins.run(noteId, tid);
  });
  run();
}

/** 按名字批量解析标签 id（不存在的自动创建），与任务标签的 resolveTagIds 行为一致 */
function resolveNoteTagIds(names) {
  const list = Array.isArray(names) ? names : String(names || '').split(/[,，\s]+/);
  const ids = [];
  for (const raw of list) {
    const n = String(raw || '').trim();
    if (!n) continue;
    ids.push(createNoteTag(n).id);
  }
  return ids;
}

/* ---------------- 任务 ↔ 笔记（多对多） ---------------- */

function listTaskNotes(taskId) {
  const rows = db
    .prepare(
      `SELECT ${NOTE_LIST_COLUMNS} FROM notes n
         JOIN task_notes tn ON tn.note_id = n.id
        WHERE tn.task_id = ?
        ORDER BY tn.created_at ASC, n.id ASC`
    )
    .all(taskId);
  return attachNoteTags(rows);
}

/** 引用了某篇笔记的任务（删除前给用户看影响面） */
function listNoteTasks(noteId) {
  return db
    .prepare(
      `SELECT t.id, t.title, t.completed, t.archived, t.group_id
         FROM task_notes tn JOIN tasks t ON t.id = tn.task_id
        WHERE tn.note_id = ? ORDER BY t.completed ASC, t.id DESC`
    )
    .all(noteId);
}

function linkTaskNote(taskId, noteId) {
  if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)) throw new Error('任务不存在');
  const note = getNote(noteId);
  if (!note) throw new Error('笔记不存在');
  if (note.deleted_at) throw new Error('笔记在回收站里，请先恢复再引用');
  db.prepare('INSERT OR IGNORE INTO task_notes (task_id, note_id, created_at) VALUES (?, ?, ?)')
    .run(Number(taskId), Number(noteId), nowIso());
  return listTaskNotes(taskId);
}

function unlinkTaskNote(taskId, noteId) {
  db.prepare('DELETE FROM task_notes WHERE task_id = ? AND note_id = ?').run(Number(taskId), Number(noteId));
  return listTaskNotes(taskId);
}

/** 全量覆盖式设置某任务引用的笔记（详情面板勾选后一次提交） */
function setTaskNotes(taskId, noteIds) {
  const ids = (Array.isArray(noteIds) ? noteIds : []).map(Number).filter((n) => Number.isFinite(n));
  const run = db.transaction(() => {
    db.prepare('DELETE FROM task_notes WHERE task_id = ?').run(Number(taskId));
    const ins = db.prepare('INSERT OR IGNORE INTO task_notes (task_id, note_id, created_at) VALUES (?, ?, ?)');
    const exists = db.prepare('SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL');
    for (const nid of ids) {
      if (exists.get(nid)) ins.run(Number(taskId), nid, nowIso());
    }
  });
  run();
  return listTaskNotes(taskId);
}

/** 一批任务的笔记引用数量（列表页徽标用，避免 N 次查询） */
function noteCountsForTasks(taskIds) {
  const ids = (Array.isArray(taskIds) ? taskIds : []).map(Number).filter((n) => Number.isFinite(n));
  const out = {};
  if (!ids.length) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT tn.task_id, COUNT(*) AS c FROM task_notes tn
         JOIN notes n ON n.id = tn.note_id AND n.deleted_at IS NULL
        WHERE tn.task_id IN (${placeholders}) GROUP BY tn.task_id`
    )
    .all(...ids);
  for (const r of rows) out[r.task_id] = Number(r.c) || 0;
  return out;
}

/* ---------------- 知识库沉淀（笔记 → 文档 → 分块） ---------------- */

function listKnowledgeBases() {
  return db.prepare('SELECT * FROM knowledge_bases ORDER BY sort_order ASC, id ASC').all();
}

function getKnowledgeBase(id) {
  return db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id) || null;
}

/** 内置笔记库（固定 id=1）；库缺失时（例如手工改库）自动补回 */
function ensureNotesKb() {
  const kb = getKnowledgeBase(1);
  if (kb) return kb;
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO knowledge_bases (id, name, type, icon, color, source_json, enabled, status, created_at, updated_at)
     VALUES (1, '笔记知识库', 'notes', '📝', '#4f7cff', '{}', 1, 'ready', ?, ?)`
  ).run(now, now);
  return getKnowledgeBase(1);
}

/**
 * 写入 / 更新一篇文档（笔记 → 知识库文档的映射入口）。
 * @returns 文档行
 */
function upsertKbDocument({ kbId = 1, sourceKey, title = '', kind = 'md', size = 0, contentHash = '', status = 'indexed' } = {}) {
  if (!sourceKey) throw new Error('sourceKey 不能为空');
  const now = nowIso();
  db.prepare(
    `INSERT INTO kb_documents (kb_id, source_key, title, kind, size, fingerprint, content_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kb_id, source_key) DO UPDATE SET
       title = excluded.title, kind = excluded.kind, size = excluded.size,
       fingerprint = excluded.fingerprint, content_hash = excluded.content_hash,
       status = excluded.status, error = '', updated_at = excluded.updated_at`
  ).run(kbId, String(sourceKey), title || '未命名', kind, Number(size) || 0, contentHash, contentHash, status, now, now);
  return db.prepare('SELECT * FROM kb_documents WHERE kb_id = ? AND source_key = ?').get(kbId, String(sourceKey));
}

/**
 * 全量替换某文档的分块（先删后插，FTS 由触发器同步）。
 * @param {number} docId
 * @param {Array<{ord:number,kind:string,headingPath:string,content:string}>} chunks
 */
function replaceKbChunks(docId, chunks = []) {
  const kbId = db.prepare('SELECT kb_id FROM kb_documents WHERE id = ?').get(docId)?.kb_id || 1;
  const run = db.transaction(() => {
    db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(docId);
    const ins = db.prepare(
      `INSERT INTO kb_chunks (kb_id, doc_id, ord, kind, heading_path, content, content_hash, token_est, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = nowIso();
    chunks.forEach((c, i) => {
      const content = String(c.content || '').trim();
      if (!content) return;
      ins.run(
        kbId, docId, Number.isFinite(c.ord) ? c.ord : i,
        c.kind || 'body', c.headingPath || '', content,
        hashText(content), Math.ceil(content.length / 2), now
      );
    });
  });
  run();
  syncKbCounts(kbId);
  return db.prepare('SELECT COUNT(*) c FROM kb_chunks WHERE doc_id = ?').get(docId).c;
}

/** 删除文档（分块随外键级联；笔记进回收站 / 彻底删除时调用） */
function deleteKbDocBySourceKey(sourceKey) {
  const row = db.prepare('SELECT id, kb_id FROM kb_documents WHERE source_key = ?').get(String(sourceKey));
  if (!row) return false;
  db.prepare('DELETE FROM kb_documents WHERE id = ?').run(row.id);
  syncKbCounts(row.kb_id);
  return true;
}

/** 回写知识库文档数 / 分块数（管理面板展示用） */
function syncKbCounts(kbId) {
  const doc = db.prepare('SELECT COUNT(*) c FROM kb_documents WHERE kb_id = ?').get(kbId).c;
  const chunk = db.prepare(
    `SELECT COUNT(*) c FROM kb_chunks WHERE kb_id = ?`
  ).get(kbId).c;
  db.prepare('UPDATE knowledge_bases SET doc_count = ?, chunk_count = ?, updated_at = ? WHERE id = ?')
    .run(doc, chunk, nowIso(), kbId);
  return { doc_count: doc, chunk_count: chunk };
}

/**
 * 知识库检索（AI 提问的召回入口）。
 * @param {{query:string, kbId?:number, topK?:number}} opts
 * @returns {Array<{chunkId:number, docId:number, kbId:number, sourceKey:string, noteId:number|null,
 *                  title:string, headingPath:string, content:string, snippet:string, score:number}>}
 */
function searchKbChunks({ query, kbId = 1, topK = 8 } = {}) {
  const kw = String(query || '').trim();
  if (!kw) return [];
  const k = Number(topK) > 0 ? Number(topK) : 8;
  if (kw.length >= 3) {
    try {
      return db
        .prepare(
          // 注意：external content 表上不能用 snippet()（会报 SQL logic error），摘要在应用层截取
          `SELECT c.id AS chunkId, c.doc_id AS docId, c.kb_id AS kbId, c.ord, c.heading_path AS headingPath,
                  c.content, d.source_key AS sourceKey, d.title,
                  bm25(kb_chunks_fts) AS score, '' AS snippet
             FROM kb_chunks_fts f
             JOIN kb_chunks c ON c.id = f.rowid
             JOIN kb_documents d ON d.id = c.doc_id
            WHERE kb_chunks_fts MATCH ? AND c.kb_id = ?
            ORDER BY score ASC LIMIT ?`
        )
        .all(`"${kw.replace(/"/g, '""')}"`, kbId, k);
    } catch (e) {
      console.warn('[db] 知识库检索降级为 LIKE：', e && e.message);
    }
  }
  return db
    .prepare(
      `SELECT c.id AS chunkId, c.doc_id AS docId, c.kb_id AS kbId, c.ord, c.heading_path AS headingPath,
              c.content, d.source_key AS sourceKey, d.title, 0 AS score, '' AS snippet
         FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id
        WHERE c.kb_id = ? AND c.content LIKE ?
        ORDER BY c.id DESC LIMIT ?`
    )
    .all(kbId, `%${kw}%`, k);
}

/**
 * 取某篇笔记（source_key='note:<id>'）的分块，供「笔记级命中 → 取它的块」这条召回路线用。
 * @param {string} sourceKey
 * @param {number} limit 每篇最多取几个块
 */
function listKbChunksBySourceKey(sourceKey, limit = 3) {
  const k = Number(limit) > 0 ? Number(limit) : 3;
  return db
    .prepare(
      `SELECT c.id AS chunkId, c.doc_id AS docId, c.kb_id AS kbId, c.ord, c.heading_path AS headingPath,
              c.content, d.source_key AS sourceKey, d.title, 0 AS score, '' AS snippet
         FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id
        WHERE d.source_key = ?
        ORDER BY c.ord ASC LIMIT ?`
    )
    .all(String(sourceKey || ''), k);
}

/** 知识库统计（管理面板 / 设置页展示） */
function kbStats(kbId = 1) {
  const kb = getKnowledgeBase(kbId);
  if (!kb) return null;
  const notes = db.prepare('SELECT COUNT(*) c FROM notes WHERE deleted_at IS NULL').get().c;
  const indexed = db.prepare('SELECT COUNT(*) c FROM kb_documents WHERE kb_id = ? AND status = ?').get(kbId, 'indexed')?.c || 0;
  return {
    ...kb,
    doc_count: Number(kb.doc_count) || 0,
    chunk_count: Number(kb.chunk_count) || 0,
    note_count: Number(notes) || 0,
    indexed_note_count: Number(indexed) || 0,
  };
}

/* ------------------------------ 数据导入导出 ------------------------------ */

/**
 * 导出全部业务数据为可序列化对象（供 JSON 文件保存）。
 * 注意：不导出 settings 中的 ai.apiKey（避免敏感信息随备份泄露）。
 */
function exportData() {
  return {
    app: 'todo-desktop',
    schemaVersion: 14,
    exportedAt: nowIso(),
    groups: db.prepare('SELECT * FROM groups ORDER BY id').all(),
    tags: db.prepare('SELECT * FROM tags ORDER BY id').all(),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    task_tags: db.prepare('SELECT * FROM task_tags ORDER BY task_id').all(),
    // 重复待办：规则 + 按日打卡 + 跳过的发生日；任务本体只有一条，就在 tasks 里
    recurring_rules: db.prepare('SELECT * FROM recurring_rules ORDER BY id').all(),
    recurrence_completions: db.prepare('SELECT * FROM recurrence_completions ORDER BY rule_id, occurrence_date').all(),
    recurrence_skips: db.prepare('SELECT * FROM recurrence_skips ORDER BY rule_id').all(),
    // 会议必须过 rowToMeeting：库里 media_paths / todos 是 JSON 文本，
    // 直接导出原始行会让导入时被当成"非数组"清洗成 []，录音路径整段丢掉。
    meetings: db.prepare('SELECT * FROM meetings ORDER BY id').all().map(rowToMeeting),
    reports: db.prepare('SELECT * FROM reports ORDER BY id').all(),
    ai_searches: db.prepare('SELECT * FROM ai_searches ORDER BY id').all(),
    kb_qa: db.prepare('SELECT * FROM kb_qa ORDER BY id').all(),
    // 笔记模块：正文随备份走；知识库分块（kb_documents / kb_chunks / kb_vectors）是派生数据，
    // 可由 notes 重建，因此不导出——与「备份不含 API Key」同一思路，避免备份体积翻倍。
    note_folders: db.prepare('SELECT * FROM note_folders ORDER BY id').all(),
    notes: db.prepare('SELECT * FROM notes ORDER BY id').all(),
    note_tags: db.prepare('SELECT * FROM note_tags ORDER BY id').all(),
    note_tag_map: db.prepare('SELECT * FROM note_tag_map ORDER BY note_id').all(),
    task_notes: db.prepare('SELECT * FROM task_notes ORDER BY task_id').all(),
    knowledge_bases: db.prepare('SELECT * FROM knowledge_bases ORDER BY id').all(),
    // 番茄钟：与任务一样是用户产生的第一手数据，随备份走（不含「进行中未结算」的残留行）
    focus_sessions: db.prepare('SELECT * FROM focus_sessions WHERE ended_at IS NOT NULL ORDER BY id').all(),
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
    db.prepare('DELETE FROM recurrence_completions').run();
    db.prepare('DELETE FROM recurrence_skips').run();
    db.prepare('DELETE FROM recurring_rules').run();
    db.prepare('DELETE FROM tags').run();
    db.prepare('DELETE FROM groups').run();
    db.prepare('DELETE FROM meetings').run();
    db.prepare('DELETE FROM reports').run();
    db.prepare('DELETE FROM ai_searches').run();
    db.prepare('DELETE FROM kb_qa').run();
    db.prepare('DELETE FROM task_notes').run();
    db.prepare('DELETE FROM focus_sessions').run();
    db.prepare('DELETE FROM note_tag_map').run();
    db.prepare('DELETE FROM notes').run();
    db.prepare('DELETE FROM note_tags').run();
    db.prepare('DELETE FROM note_folders').run();
    db.prepare('DELETE FROM kb_documents').run(); // 分块随外键级联清除，导入后由上层重建索引
    db.prepare('DELETE FROM knowledge_bases').run();

    const t0 = nowIso();
    // 分两步写分组：先不带 parent_id（外键约束下，父分组未必已先插入），再回填层级
    const insGroup = db.prepare(
      'INSERT INTO groups (id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const pendingParents = [];
    for (const g of data.groups) {
      insGroup.run(g.id, g.name, g.color || '#4f7cff', g.sort_order ?? 0, g.created_at || t0, g.updated_at || t0);
      if (g.parent_id != null) pendingParents.push([g.parent_id, g.id]);
    }
    const setParent = db.prepare('UPDATE groups SET parent_id = ? WHERE id = ?');
    for (const [pid, gid] of pendingParents) {
      // 父分组缺失时降级为顶层，避免整个导入失败
      setParent.run(getGroup(pid) ? pid : null, gid);
    }

    const insTag = db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)');
    for (const t of data.tags || []) {
      insTag.run(t.id, t.name, t.color || '#8896ab');
    }

    const insTask = db.prepare(
      `INSERT INTO tasks (id, group_id, parent_id, title, notes, attachments, priority, plan_start, plan_end, reminder_at,
         reminder_fired, completed, completed_at, archived, capture_during_focus, sort_order, created_at, updated_at,
         recurring_id, occurrence_date, recur_customized)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const seenRecur = new Set();
    for (const t of data.tasks) {
      // v16 备份里同一规则预生成了 N 条实例；新模型只认第一条，其余丢弃（完成态在下面转打卡）
      if (t.recurring_id != null) {
        const rid = Number(t.recurring_id);
        if (seenRecur.has(rid)) continue;
        seenRecur.add(rid);
      }
      // 兼容旧导出文件：优先 plan_end，回退到 due_at 的前 10 位
      const planEnd = t.plan_end ?? (t.due_at ? String(t.due_at).slice(0, 10) : null);
      const att = Array.isArray(t.attachments) ? JSON.stringify(t.attachments) : (t.attachments || '[]');
      insTask.run(
        t.id, t.group_id ?? null, t.parent_id ?? null, t.title, t.notes || '', att, t.priority ?? 1,
        t.plan_start ?? null, planEnd, t.reminder_at ?? null, t.reminder_fired ?? 0,
        t.completed ?? 0, t.completed_at ?? null, t.archived ?? 0, t.capture_during_focus ?? 0, t.sort_order ?? 0,
        t.created_at || t0, t.updated_at || t0,
        t.recurring_id ?? null, t.occurrence_date ?? null, t.recur_customized ?? 0
      );
    }

    // 重复规则：旧备份没有 task_id / completions 时按 tasks.recurring_id 回填
    const insRule = db.prepare(
      `INSERT INTO recurring_rules (id, title, notes, group_id, priority, tag_ids, rule, start_date, end_date,
         enabled, habit, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const ruleTaskOwner = new Map((data.tasks || [])
      .filter((t) => t.recurring_id != null)
      .map((t) => [Number(t.recurring_id), t.id]));
    for (const r of data.recurring_rules || []) {
      insRule.run(
        r.id, r.title, r.notes || '', r.group_id ?? null, r.priority ?? 1,
        r.tag_ids || '[]', r.rule || '{}', r.start_date || t0.slice(0, 10), r.end_date ?? null,
        r.enabled ?? 1, r.habit ?? 0, r.task_id ?? ruleTaskOwner.get(Number(r.id)) ?? null,
        r.created_at || t0, r.updated_at || t0
      );
    }
    const insCompletion = db.prepare(
      'INSERT OR IGNORE INTO recurrence_completions (rule_id, occurrence_date, completed_at) VALUES (?, ?, ?)'
    );
    for (const c of data.recurrence_completions || []) {
      if (c.rule_id != null && c.occurrence_date) {
        insCompletion.run(c.rule_id, c.occurrence_date, c.completed_at || t0);
      }
    }
    // 旧备份里「已完成的历史实例」转成打卡记录，合并后不再保留多余任务行
    for (const t of data.tasks || []) {
      if (t.recurring_id != null && t.completed && t.occurrence_date) {
        insCompletion.run(t.recurring_id, t.occurrence_date, t.completed_at || t0);
      }
    }
    const insSkip = db.prepare('INSERT OR IGNORE INTO recurrence_skips (rule_id, occurrence_date) VALUES (?, ?)');
    for (const s of data.recurrence_skips || []) {
      if (s.rule_id != null && s.occurrence_date) insSkip.run(s.rule_id, s.occurrence_date);
    }

    const insTT = db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)');
    for (const tt of data.task_tags || []) {
      insTT.run(tt.task_id, tt.tag_id);
    }

    const insMeeting = db.prepare(
      `INSERT INTO meetings (id, title, source_label, mode, started_at, duration_ms, media_paths,
         transcript, summary, todos, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // 兼容两种来源：新导出是数组，旧版 JSON 备份里是 JSON 文本（不兼容的话会被清成 []）
    const jsonOf = (v) => {
      if (typeof v === 'string') {
        try { return Array.isArray(JSON.parse(v)) ? v : '[]'; } catch (e) { return '[]'; }
      }
      return JSON.stringify(Array.isArray(v) || (v && typeof v === 'object') ? v : []);
    };
    for (const m of data.meetings || []) {
      insMeeting.run(
        m.id, m.title || '未命名会议', m.source_label || '', m.mode || 'audio',
        m.started_at || t0, Number(m.duration_ms) || 0, jsonOf(m.media_paths),
        m.transcript || '', m.summary || '', jsonOf(m.todos),
        m.status || 'recorded', m.created_at || t0, m.updated_at || t0
      );
    }

    const insReport = db.prepare(
      `INSERT INTO reports (id, title, type, range_start, range_end, group_ids, group_label,
         extra_prompt, content, degraded, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.reports || []) {
      insReport.run(
        r.id, r.title || '未命名报告', r.type || 'custom', r.range_start ?? null, r.range_end ?? null,
        jsonOf(r.group_ids), r.group_label || '', r.extra_prompt || '', r.content || '',
        r.degraded ? 1 : 0, r.created_at || t0, r.updated_at || t0
      );
    }

    const insSearch = db.prepare(
      'INSERT INTO ai_searches (id, keyword, summary, task_count, tasks, degraded, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const s of data.ai_searches || []) {
      insSearch.run(
        s.id, s.keyword || '', s.summary || '', Number(s.task_count) || 0,
        jsonOf(s.tasks), s.degraded ? 1 : 0, s.created_at || t0
      );
    }

    const insKbQa = db.prepare(
      `INSERT INTO kb_qa (id, question, answer, hits, hit_count, degraded, reason, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const q of data.kb_qa || []) {
      insKbQa.run(
        q.id, q.question || '', q.answer || '', jsonOf(q.hits),
        Number(q.hit_count) || 0, q.degraded ? 1 : 0, q.reason || '', q.scope || '', q.created_at || t0
      );
    }

    // 笔记目录：与分组同样的两步写法（先不带 parent_id，再回填），避免外键顺序问题
    const insFolder = db.prepare(
      'INSERT INTO note_folders (id, name, parent_id, color, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)'
    );
    const folderParents = [];
    for (const f of data.note_folders || []) {
      insFolder.run(f.id, f.name, f.color || '#4f7cff', f.sort_order ?? 0, f.created_at || t0, f.updated_at || t0);
      if (f.parent_id != null) folderParents.push([f.parent_id, f.id]);
    }
    const setFolderParent = db.prepare('UPDATE note_folders SET parent_id = ? WHERE id = ?');
    for (const [pid, fid] of folderParents) {
      setFolderParent.run(getNoteFolder(pid) ? pid : null, fid); // 父目录缺失 → 降级为顶层
    }

    const insNoteTag = db.prepare('INSERT INTO note_tags (id, name, color) VALUES (?, ?, ?)');
    for (const t of data.note_tags || []) {
      insNoteTag.run(t.id, t.name, t.color || '#8896ab');
    }

    const insNote = db.prepare(
      `INSERT INTO notes (id, folder_id, title, content_md, excerpt, pinned, archived, deleted_at,
         word_count, content_hash, source, source_ref, sort_order, attachments, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const n of data.notes || []) {
      const content = n.content_md || '';
      insNote.run(
        n.id, n.folder_id ?? null, n.title || '未命名笔记', content,
        n.excerpt || excerptOf(content), n.pinned ? 1 : 0, n.archived ? 1 : 0, n.deleted_at ?? null,
        Number(n.word_count) || wordCountOf(content), n.content_hash || hashText(content),
        n.source || 'manual', n.source_ref || '', n.sort_order ?? 0,
        n.attachments || '[]',
        n.created_at || t0, n.updated_at || t0
      );
    }

    const insNoteTagMap = db.prepare('INSERT OR IGNORE INTO note_tag_map (note_id, tag_id) VALUES (?, ?)');
    for (const m of data.note_tag_map || []) insNoteTagMap.run(m.note_id, m.tag_id);

    // 任务 ↔ 笔记：只写入两端都存在的关联（笔记/任务缺失时静默丢弃，不让整份备份导入失败）
    const insTaskNote = db.prepare('INSERT OR IGNORE INTO task_notes (task_id, note_id, created_at) VALUES (?, ?, ?)');
    const noteExists = db.prepare('SELECT id FROM notes WHERE id = ?');
    const taskExists = db.prepare('SELECT id FROM tasks WHERE id = ?');
    for (const tn of data.task_notes || []) {
      if (noteExists.get(tn.note_id) && taskExists.get(tn.task_id)) {
        insTaskNote.run(tn.task_id, tn.note_id, tn.created_at || t0);
      }
    }

    // 番茄钟：只回填已结算的会话。task_id 原样保留（NOT NULL）：即使指向已删除的任务也要留痕，
    // 不因「任务不存在」而置空（删任务时记录必须保留的决策）。缺失 task_id 的脏行跳过。
    const insFocus = db.prepare(
      `INSERT INTO focus_sessions (id, task_id, group_id, started_at, ended_at, planned_sec, actual_sec, outcome, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of data.focus_sessions || []) {
      if (s.task_id == null) continue;
      insFocus.run(
        s.id, s.task_id, s.group_id ?? null,
        s.started_at || t0, s.ended_at ?? null, Number(s.planned_sec) || 1800,
        Number(s.actual_sec) || 0, s.outcome || 'full', s.note || '', s.created_at || t0
      );
    }

    const insKb = db.prepare(
      `INSERT INTO knowledge_bases (id, name, type, icon, color, source_json, enabled, status, last_error,
         doc_count, chunk_count, embed_model, embed_dim, sort_order, last_sync_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`
    );
    for (const k of data.knowledge_bases || []) {
      insKb.run(
        k.id, k.name || '知识库', k.type || 'notes', k.icon || '📚', k.color || '#4f7cff',
        k.source_json || '{}', k.enabled == null ? 1 : (k.enabled ? 1 : 0), k.status || 'idle',
        k.last_error || '', k.embed_model || '', Number(k.embed_dim) || 0,
        Number(k.sort_order) || 0, k.last_sync_at ?? null, k.created_at || t0, k.updated_at || t0
      );
    }
  });
  run();
  seedDefaults(); // 若文件不含分组，补默认分组
  ensureNotesKb(); // 备份里没有知识库记录时补回内置「笔记知识库」
  // 导入的重复事项按今天的规则重算「下一次发生日」，旧备份里预生成的日期一概不认
  syncRecurrences();

  return {
    groups: db.prepare('SELECT COUNT(*) c FROM groups').get().c,
    tags: db.prepare('SELECT COUNT(*) c FROM tags').get().c,
    tasks: db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
    notes: db.prepare('SELECT COUNT(*) c FROM notes').get().c,
  };
}

/**
 * 数据库自检（备份前调用）：quick_check 比 integrity_check 快得多，
 * 足够发现页损坏 / 索引错乱这类会让备份变成垃圾的问题。
 */
function quickCheck() {
  if (!db) return { ok: false, message: '数据库未初始化' };
  try {
    const r = db.pragma('quick_check', { simple: true });
    return r === 'ok' ? { ok: true } : { ok: false, message: String(r) };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}

/**
 * 所有附件元数据（只读 attachments 列，不拉正文）。
 * 备份导出 / 导入后校验都靠它：库里登记了哪些附件、各自应该落在哪。
 * @returns {Array<{kind:'task'|'note', owner_id:number, title:string, name:string, path:string}>}
 */
function collectAttachmentMeta() {
  if (!db) return [];
  const out = [];
  const collect = (kind, sql) => {
    for (const row of db.prepare(sql).all()) {
      let list = [];
      try { list = JSON.parse(row.attachments || '[]'); } catch (e) { continue; }
      if (!Array.isArray(list)) continue;
      for (const a of list) {
        out.push({
          kind,
          owner_id: row.id,
          title: row.title || '',
          name: (a && a.name) || '',
          path: (a && a.path) || '',
        });
      }
    }
  };
  const where = "attachments IS NOT NULL AND attachments <> '' AND attachments <> '[]'";
  collect('task', `SELECT id, title, attachments FROM tasks WHERE ${where}`);
  collect('note', `SELECT id, title, attachments FROM notes WHERE ${where}`);
  return out;
}

/* ------------------------------ 番茄钟（专注计时） ------------------------------ */

/** 结局 → 行首标记：跑满 ●、主动收 / 被打断 ◐（半格） */
function focusMark(outcome) {
  return outcome === 'full' ? '●' : '◐';
}

/** 等效格数：full = 1 格，partial / interrupted = 0.5 格 */
function focusEquivalent(outcome) {
  return outcome === 'full' ? 1 : 0.5;
}

/**
 * 收尾那句「做到哪了」写回任务的 notes 时，追加一行带番茄前缀的时间线。
 * 格式：`● 11-03 10:25 一句话`（●=跑满 / ◐=半格）；行首 ●/◐ 前缀用于与用户自己写的备注区分，
 * stripStyleMarks() 会把它剥掉（只剥前缀，保留正文），避免污染字数 / content_hash。
 */
function focusTimelineLine(startedAtIso, outcome, note) {
  const d = new Date(startedAtIso);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${focusMark(outcome)} ${stamp} ${String(note || '').trim()}`;
}

/** 规范化 focus_sessions 行（outcome 兜底 / 数值字段转 number） */
function rowToFocus(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id ?? null,
    group_id: row.group_id ?? null,
    started_at: row.started_at,
    ended_at: row.ended_at ?? null,
    planned_sec: Number(row.planned_sec) || 0,
    actual_sec: Number(row.actual_sec) || 0,
    outcome: row.outcome || 'full',
    note: row.note || '',
    created_at: row.created_at,
  };
}

/** 开钟：插入一条进行中的会话（ended_at 为空 = 未结算），返回新行。taskId 必填（不支持自由专注）。 */
function createFocusSession({ taskId, groupId = null, plannedSec = 1800 } = {}) {
  if (taskId == null) throw new Error('番茄钟必须挂任务');
  const t = nowIso();
  const info = db.prepare(
    `INSERT INTO focus_sessions (task_id, group_id, started_at, planned_sec, actual_sec, outcome, note, created_at)
     VALUES (?, ?, ?, ?, 0, 'full', '', ?)`
  ).run(
    taskId, groupId ?? null, t, Number(plannedSec) || 1800, t
  );
  return getFocusSession(info.lastInsertRowid);
}

/**
 * 结算会话：写 ended_at / actual_sec / outcome / note，并把那句「做到哪了」追加到任务的备注末尾。
 * 任务已被删除时（task_id 指向不存在的 id）不写回 notes，但记录本身仍保留（供统计）。
 */
function settleFocusSession(id, { outcome = 'full', actualSec = 0, note = '', endedAt = null } = {}) {
  const cur = getFocusSession(id);
  if (!cur) return null;
  const ended = endedAt || nowIso();
  const text = String(note || '').trim();
  db.prepare(
    `UPDATE focus_sessions SET ended_at = ?, actual_sec = ?, outcome = ?, note = ? WHERE id = ?`
  ).run(ended, Number(actualSec) || 0, outcome, text, id);

  if (text && cur.task_id != null) {
    const task = getTask(cur.task_id);
    if (task) {
      const line = focusTimelineLine(cur.started_at, outcome, text);
      const prev = task.notes || '';
      const next = prev ? `${prev.replace(/\n+$/, '')}\n${line}` : line;
      db.prepare('UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?')
        .run(next, nowIso(), cur.task_id);
    }
  }
  return getFocusSession(id);
}

function getFocusSession(id) {
  return rowToFocus(db.prepare('SELECT * FROM focus_sessions WHERE id = ?').get(id));
}

/** 删除一条会话（误触结束 / <8 分钟，不留脏数据） */
function deleteFocusSession(id) {
  return db.prepare('DELETE FROM focus_sessions WHERE id = ?').run(id).changes > 0;
}

/** 未结算的会话（应用异常退出 / 崩溃后残留）：启动时用于对账补记。 */
function getActiveFocusSession() {
  return rowToFocus(db.prepare('SELECT * FROM focus_sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get());
}

/** 按任务聚合格数：task_id → { full, partial }（partial 含 partial + interrupted） */
function focusCountsForTasks(taskIds = []) {
  const out = {};
  if (!taskIds.length) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT task_id, outcome, COUNT(*) AS c FROM focus_sessions
     WHERE task_id IN (${placeholders}) AND ended_at IS NOT NULL
     GROUP BY task_id, outcome`
  ).all(...taskIds);
  for (const r of rows) {
    const e = out[r.task_id] || (out[r.task_id] = { full: 0, partial: 0 });
    if (r.outcome === 'full') e.full += r.c;
    else e.partial += r.c;
  }
  return out;
}

/** 今日等效格数（跨天番茄归入「开始那天」） */
function todayFocusCount() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const start = new Date(`${day}T00:00:00`).toISOString();
  const end = new Date(`${day}T23:59:59.999`).toISOString();
  const rows = db.prepare(
    `SELECT outcome FROM focus_sessions WHERE started_at >= ? AND started_at <= ? AND ended_at IS NOT NULL`
  ).all(start, end);
  return rows.reduce((sum, r) => sum + focusEquivalent(r.outcome), 0);
}

/** 某任务的时间线（详情页番茄日志，按开始时间倒序） */
function listFocusSessions(taskId, limit = 100) {
  return db.prepare(
    `SELECT * FROM focus_sessions WHERE task_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT ?`
  ).all(taskId, Number(limit) || 100).map(rowToFocus);
}

module.exports = {
  init,
  getDb,
  getDbPath,
  backupTo,
  isReady,
  getInitError,
  close,
  nowIso,
  quickCheck,
  collectAttachmentMeta,
  // groups
  listGroups,
  createGroup,
  getGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
  moveGroup,
  siblingGroupIds,
  descendantGroupIds,
  expandGroupIds,
  // tasks
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  subtreeTaskIds,
  setAttachments,
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
  // 重复待办 / 习惯
  RECUR_AHEAD_DAYS,
  listRecurringRules,
  listCompletionsAll,
  getRecurringRule,
  createRecurringRule,
  updateRecurringRule,
  setRecurringEnabled,
  deleteRecurringRule,
  listSkips,
  clearSkips,
  skipOccurrence,
  listCompletions,
  setCompletion,
  rollRecurringTask,
  syncRule,
  syncRecurrences,
  habitStats,
  // stats
  overview,
  dailyTrend,
  TREND_RANGES,
  DEFAULT_TREND_RANGE,
  normalizeTrendRange,
  rangeStats,
  // 番茄钟（专注计时）
  createFocusSession,
  settleFocusSession,
  getFocusSession,
  deleteFocusSession,
  getActiveFocusSession,
  focusCountsForTasks,
  todayFocusCount,
  listFocusSessions,
  focusMark,
  focusEquivalent,
  // settings
  getSetting,
  setSetting,
  earliestTaskAt,
  // 会议录制 / 纪要
  createMeeting,
  listMeetings,
  getMeeting,
  updateMeeting,
  deleteMeeting,
  // AI 报告历史
  createReport,
  listReports,
  getReport,
  updateReport,
  deleteReport,
  // AI 检索历史
  createSearch,
  listSearches,
  getSearch,
  deleteSearch,
  // 知识库问答历史
  createKbQa,
  listKbQa,
  getKbQa,
  deleteKbQa,
  // 笔记模块
  listNoteFolders,
  getNoteFolder,
  createNoteFolder,
  updateNoteFolder,
  deleteNoteFolder,
  descendantFolderIds,
  listNotes,
  getNote,
  createNote,
  updateNote,
  setNoteArchived,
  setNotePinned,
  trashNote,
  restoreNote,
  purgeNote,
  getNoteAttachments,
  setNoteAttachments,
  listTrash,
  emptyTrash,
  searchNotes,
  fuzzySearchNotes,
  fuzzyTokens,
  snippetOf,
  stripStyleMarks,
  countMatches,
  listNoteTags,
  createNoteTag,
  updateNoteTag,
  deleteNoteTag,
  setNoteTags,
  resolveNoteTagIds,
  // 任务 ↔ 笔记
  listTaskNotes,
  listNoteTasks,
  linkTaskNote,
  unlinkTaskNote,
  setTaskNotes,
  noteCountsForTasks,
  // 知识库沉淀
  listKnowledgeBases,
  getKnowledgeBase,
  ensureNotesKb,
  upsertKbDocument,
  replaceKbChunks,
  deleteKbDocBySourceKey,
  syncKbCounts,
  searchKbChunks,
  listKbChunksBySourceKey,
  kbStats,
  // 文本工具（分块 / 摘要复用）
  plainTextOf,
  wordCountOf,
  excerptOf,
  hashText,
  // import / export
  exportData,
  importData,
};
