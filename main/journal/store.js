'use strict';
/**
 * 四象日记 · 数据层（纯 SQLite，无 Electron 依赖，可离线单测）。
 *
 * 所有日期都是本地 'YYYY-MM-DD' 字符串：由本文件在写入前算好，库里不存时间戳的日期部分。
 * 绝不用 date('now') —— 那是 UTC，东八区晚上 8 点后就归到第二天（工时已踩过这个坑）。
 *
 * 隐私：不建 FTS 触发器、不进任何 AI 候选；日记是「时间」，不是「资料」。
 */
const db = require('../db');
const dateUtil = require('../date-utils');

const MAX_CELL = 50000;
const MAX_NOTE = 2000;

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地日期 → 'YYYY-MM-DD'（不用 toISOString，那是 UTC） */
function localDay(d = new Date()) {
  const x = d instanceof Date && !isNaN(d.getTime()) ? d : new Date();
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

/** 只接受合法 'YYYY-MM-DD'；非法 / 未来回落今天 */
function validDay(day) {
  const s = dateUtil.toDay(day);
  if (!s || s > localDay()) return localDay();
  return s;
}

function nowIso() { return db.nowIso(); }

/** 一天的四格 + 碎碎念；day 非法自动回落今天 */
function getDay(day) {
  const d = validDay(day);
  const rows = db.getDb().prepare('SELECT cell, body FROM journal_cells WHERE day = ?').all(d);
  const cells = ['', '', '', ''];
  for (const r of rows) {
    const i = Number(r.cell);
    if (i >= 0 && i <= 3) cells[i] = String(r.body || '');
  }
  const notes = db.getDb().prepare(
    `SELECT id, day, body, cell, task_id AS taskId, created_at AS createdAt, updated_at AS updatedAt
       FROM journal_notes WHERE day = ? ORDER BY created_at, id`
  ).all(d).map((n) => ({
    id: Number(n.id),
    day: n.day,
    body: String(n.body || ''),
    cell: n.cell == null ? null : Number(n.cell),
    taskId: n.taskId == null ? null : Number(n.taskId),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  }));
  return { day: d, cells, notes };
}

/** 单格 UPSERT；body 空串 = 删行（否则「已记录 N 天」会虚高） */
function setCell(day, cell, body) {
  const d = validDay(day);
  const i = Number(cell);
  if (!Number.isInteger(i) || i < 0 || i > 3) throw new Error('格子序号无效');
  let text = String(body == null ? '' : body);
  if (text.length > MAX_CELL) text = text.slice(0, MAX_CELL);
  const at = nowIso();
  if (!text.trim()) {
    db.getDb().prepare('DELETE FROM journal_cells WHERE day = ? AND cell = ?').run(d, i);
    return { ok: true, updatedAt: at, deleted: true };
  }
  db.getDb().prepare(
    `INSERT INTO journal_cells (day, cell, body, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, cell) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`
  ).run(d, i, text, at);
  return { ok: true, updatedAt: at, truncated: text.length < String(body || '').length };
}

function noteRow(r) {
  return {
    id: Number(r.id),
    day: r.day,
    body: String(r.body || ''),
    cell: r.cell == null ? null : Number(r.cell),
    taskId: r.task_id == null ? null : Number(r.task_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 追加碎碎念；cell 可空（NULL = 未归类），只允许 0..3 */
function addNote(day, body, cell) {
  const d = validDay(day);
  const text = String(body == null ? '' : body).trim();
  if (!text) throw new Error('碎碎念内容不能为空');
  if (text.length > MAX_NOTE) throw new Error(`单条上限 ${MAX_NOTE} 字`);
  let c = null;
  if (cell != null && cell !== '') {
    c = Number(cell);
    if (!Number.isInteger(c) || c < 0 || c > 3) throw new Error('格子序号无效');
  }
  const at = nowIso();
  const info = db.getDb().prepare(
    `INSERT INTO journal_notes (day, body, cell, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(d, text, c, at, at);
  return noteRow(db.getDb().prepare('SELECT * FROM journal_notes WHERE id = ?').get(info.lastInsertRowid));
}

/** patch 只允许 body / cell；body 空串同样拒绝 */
function updateNote(id, patch) {
  const nid = Number(id);
  if (!Number.isFinite(nid)) throw new Error('碎碎念 id 无效');
  const p = patch || {};
  const sets = [];
  const args = [];
  if (p.body != null) {
    const text = String(p.body).trim();
    if (!text) throw new Error('碎碎念内容不能为空');
    if (text.length > MAX_NOTE) throw new Error(`单条上限 ${MAX_NOTE} 字`);
    sets.push('body = ?'); args.push(text);
  }
  if ('cell' in p) {
    let c = null;
    if (p.cell != null && p.cell !== '') {
      c = Number(p.cell);
      if (!Number.isInteger(c) || c < 0 || c > 3) throw new Error('格子序号无效');
    }
    sets.push('cell = ?'); args.push(c);
  }
  // 转任务后回填真实任务 id：只做视觉标记会在重进视图时丢掉，导致重复建任务
  if ('taskId' in p) {
    let tid = null;
    if (p.taskId != null && p.taskId !== '') {
      tid = Number(p.taskId);
      if (!Number.isFinite(tid)) throw new Error('任务 id 无效');
    }
    sets.push('task_id = ?'); args.push(tid);
  }
  if (!sets.length) return { ok: true, changed: 0 };
  sets.push('updated_at = ?'); args.push(nowIso());
  args.push(nid);
  const r = db.getDb().prepare(`UPDATE journal_notes SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return { ok: true, changed: r.changes };
}

function removeNote(id) {
  const nid = Number(id);
  if (!Number.isFinite(nid)) throw new Error('碎碎念 id 无效');
  return { ok: db.getDb().prepare('DELETE FROM journal_notes WHERE id = ?').run(nid).changes > 0 };
}

/**
 * 已记录天数：有任一格正文，或任一条碎碎念的自然日都算。
 * 中性文案「已记录 N 天」，不做连续打卡施压。
 */
function stats() {
  const day = localDay();
  const monthPrefix = day.slice(0, 7);
  const rows = db.getDb().prepare(
    `SELECT day FROM journal_cells WHERE body <> ''
     UNION
     SELECT day FROM journal_notes`
  ).all();
  const days = new Set(rows.map((r) => r.day));
  return {
    days: days.size,
    thisMonth: [...days].filter((d) => d.startsWith(monthPrefix)).length,
  };
}

/** 归入：正文追加到该格末尾（不覆盖），碎碎念由调用方随后删除；两步在 ipc 层合并事务 */
function appendToCell(day, cell, text) {
  const d = validDay(day);
  const i = Number(cell);
  if (!Number.isInteger(i) || i < 0 || i > 3) throw new Error('格子序号无效');
  const prev = db.getDb().prepare('SELECT body FROM journal_cells WHERE day = ? AND cell = ?').get(d, i);
  const base = String((prev && prev.body) || '').replace(/\s*$/, '');
  const addition = String(text || '').slice(0, MAX_NOTE);
  const merged = (base ? `${base}\n${addition}` : addition).slice(0, MAX_CELL);
  return setCell(d, i, merged);
}

/** 归入：追加正文 + 删除碎碎念，一个事务里完成（中途失败不能留下半条） */
function foldNote(id, cell) {
  const nid = Number(id);
  const row = db.getDb().prepare('SELECT day, body FROM journal_notes WHERE id = ?').get(nid);
  if (!row) throw new Error('碎碎念不存在');
  const run = db.getDb().transaction(() => {
    appendToCell(row.day, cell, row.body);
    db.getDb().prepare('DELETE FROM journal_notes WHERE id = ?').run(nid);
  });
  run();
  return { ok: true };
}

module.exports = {
  MAX_CELL, MAX_NOTE,
  localDay, validDay,
  getDay, setCell, addNote, updateNote, removeNote, stats, appendToCell, foldNote,
  _internal: { noteRow },
};
