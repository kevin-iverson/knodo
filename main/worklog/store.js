'use strict';
/**
 * 工时数据访问层 —— **唯一的汇总出口**（方案 §五 / RK-02）。
 *
 * 铁律（方案 §六「防重复的三条铁律」）：
 *  1. 一条 entry 只挂一个 task_id，不做分摊；
 *  2. 汇总只在查询时做，绝不写回 tasks；
 *  3. 顶层总计 = Σ 顶级任务的 subtree_sec，子任务行不参与求和（由界面层遵守）。
 *
 * 父任务合计用递归 CTE 现场算：父子关系一变，数字自动跟着变，没有一致性风险。
 */
const db = require('../db');

/** 全时间范围的边界：started_at 是 UTC ISO，字典序比较即可 */
const ALL_FROM = '';
const ALL_TO = '9999-12-31T23:59:59.999Z';

function nowIso() {
  return new Date().toISOString();
}

function getEntry(id) {
  return db.getDb().prepare('SELECT * FROM worklog_entries WHERE id = ?').get(id) || null;
}

function createEntry({
  taskId,
  groupId = null,
  startedAt = nowIso(),
  endedAt = null,
  durationSec = 0,
  source = 'timer',
  status = 'running',
  billable = 1,
  note = '',
  lastBeatAt = startedAt,
} = {}) {
  const info = db.getDb().prepare(`
    INSERT INTO worklog_entries
      (task_id, group_id, started_at, ended_at, duration_sec, source, status, billable, note, last_beat_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    groupId,
    startedAt,
    endedAt,
    Math.max(0, Math.round(durationSec)),
    source,
    status,
    billable ? 1 : 0,
    note || '',
    lastBeatAt,
    nowIso(),
  );
  return getEntry(info.lastInsertRowid);
}

/** 结算一条记录（结束 / 崩溃对账都走这里） */
function settleEntry(id, { endedAt = nowIso(), durationSec = 0, status = 'done', note = null } = {}) {
  const d = db.getDb();
  if (note == null) {
    d.prepare('UPDATE worklog_entries SET ended_at = ?, duration_sec = ?, status = ? WHERE id = ?')
      .run(endedAt, Math.max(0, Math.round(durationSec)), status, id);
  } else {
    d.prepare('UPDATE worklog_entries SET ended_at = ?, duration_sec = ?, status = ?, note = ? WHERE id = ?')
      .run(endedAt, Math.max(0, Math.round(durationSec)), status, note, id);
  }
  return getEntry(id);
}

/** 心跳：崩溃后按最后一次心跳结算，误差 ≤ 1 分钟 */
function beat(id, iso = nowIso()) {
  db.getDb().prepare('UPDATE worklog_entries SET last_beat_at = ? WHERE id = ? AND status = ?')
    .run(iso, id, 'running');
}

function listRunning() {
  return db.getDb().prepare("SELECT * FROM worklog_entries WHERE status = 'running' ORDER BY id").all();
}

function deleteEntry(id) {
  return db.getDb().prepare('DELETE FROM worklog_entries WHERE id = ?').run(id).changes > 0;
}

/** 某任务的记录列表（按开始时间倒序；范围省略 = 全部） */
function listEntries(taskId, { from = ALL_FROM, to = ALL_TO } = {}) {
  return db.getDb().prepare(`
    SELECT * FROM worklog_entries
    WHERE task_id = @taskId AND status = 'done' AND started_at >= @from AND started_at < @to
    ORDER BY started_at DESC, id DESC
  `).all({ taskId, from, to });
}

/**
 * 本期每个任务的「自身」与「子树合计」—— 一次查询给整棵树，避免 N+1。
 *
 * tree：每个任务作为 root，向下展开全部后代（UNION ALL，层数不限）。
 *   ⚠ 成环时 UNION ALL 会无限递归，必须在写入侧挡住（本插件不改 parent_id，
 *     任务层级的写入口在 db.moveTask，风险沿用既有实现）。
 * own_sec：只算挂在任务自己身上的记录。
 * subtree_sec：root 自己 + 全部后代的记录之和。
 */
function aggregate({ from = ALL_FROM, to = ALL_TO } = {}) {
  return db.getDb().prepare(`
    WITH RECURSIVE tree(root_id, id) AS (
      SELECT id, id FROM tasks
      UNION ALL
      SELECT tree.root_id, t.id FROM tasks t JOIN tree ON t.parent_id = tree.id
    )
    SELECT
      t.id,
      t.parent_id,
      t.title,
      t.completed,
      t.group_id,
      g.name  AS group_name,
      g.color AS group_color,
      COALESCE(o.own_sec, 0) AS own_sec,
      COALESCE(o.own_cnt, 0) AS own_cnt,
      COALESCE(SUM(se.duration_sec), 0) AS subtree_sec,
      (SELECT group_concat(tag.name)
         FROM tags tag JOIN task_tags tt ON tt.tag_id = tag.id
        WHERE tt.task_id = t.id) AS tag_names
    FROM tasks t
    LEFT JOIN groups g ON g.id = t.group_id
    LEFT JOIN (
      SELECT task_id, SUM(duration_sec) AS own_sec, COUNT(*) AS own_cnt
      FROM worklog_entries
      WHERE status = 'done' AND started_at >= @from AND started_at < @to
      GROUP BY task_id
    ) o ON o.task_id = t.id
    LEFT JOIN tree st ON st.root_id = t.id
    LEFT JOIN worklog_entries se
      ON se.task_id = st.id
     AND se.status = 'done' AND se.started_at >= @from AND se.started_at < @to
    GROUP BY t.id
  `).all({ from, to });
}

/** 单个任务的双口径合计：与视图页同一个 SQL 出口，只是取其中一行 */
function taskSummary(taskId, { from = ALL_FROM, to = ALL_TO } = {}) {
  const rows = aggregate({ from, to });
  const row = rows.find((r) => Number(r.id) === Number(taskId)) || null;
  return { row, all: rows };
}

/** 本期记录的最小字段集：每日分布柱状图按本地日期分桶用 */
function rangeEntries({ from = ALL_FROM, to = ALL_TO } = {}) {
  return db.getDb().prepare(`
    SELECT task_id, started_at, duration_sec
    FROM worklog_entries
    WHERE status = 'done' AND started_at >= @from AND started_at < @to
  `).all({ from, to });
}

/**
 * 报工明细（CSV 用）：连已删除任务的记录也带上 —— 历史工时不能因为删任务而蒸发。
 */function exportRows({ from = ALL_FROM, to = ALL_TO } = {}) {
  return db.getDb().prepare(`
    SELECT e.*,
           t.title       AS task_title,
           p.title       AS parent_title,
           g.name        AS group_name
    FROM worklog_entries e
    LEFT JOIN tasks  t ON t.id = e.task_id
    LEFT JOIN tasks  p ON p.id = t.parent_id
    LEFT JOIN groups g ON g.id = COALESCE(t.group_id, e.group_id)
    WHERE e.status = 'done' AND e.started_at >= @from AND e.started_at < @to
    ORDER BY e.started_at ASC, e.id ASC
  `).all({ from, to });
}

/* ============================ 工时记薪 · 时间价值 ============================ */
/**
 * 以下是「估算」口径，不是工资条：只把已结算工时按用户自设时薪折算成金额，
 * 不碰应发/实发/个税/社保，界面一律用「估算」措辞（方案 §一）。
 */

/** 费率历史，按生效日倒序（最新在前） */
function listRates() {
  return db.getDb().prepare('SELECT * FROM pay_rates ORDER BY effective_from DESC, id DESC').all();
}

/**
 * 新增或更新一条费率。UNIQUE(effective_from)：同一天覆盖，不产生第二条
 * （用户改主意不该留下两条打架的历史）。返回该生效日的最终行。
 */
function upsertRate({ rateCents, effectiveFrom, currency = 'CNY', note = '' } = {}) {
  const cents = Math.round(Number(rateCents));
  const day = effectiveFrom ? String(effectiveFrom).slice(0, 10) : '';
  if (!Number.isFinite(cents) || cents <= 0) throw new Error('时薪必须大于 0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('生效日格式应为 YYYY-MM-DD');
  const d = db.getDb();
  d.prepare(`
    INSERT INTO pay_rates (rate_cents, effective_from, currency, note, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(effective_from) DO UPDATE SET
      rate_cents = excluded.rate_cents,
      currency   = excluded.currency,
      note       = excluded.note
  `).run(cents, day, currency || 'CNY', note || '', nowIso());
  return d.prepare('SELECT * FROM pay_rates WHERE effective_from = ?').get(day);
}

function deleteRate(id) {
  return db.getDb().prepare('DELETE FROM pay_rates WHERE id = ?').run(Number(id)).changes > 0;
}

/** 记录级「计薪 / 不计薪」开关（billable 字段 v18 就埋好了，本期才接上） */
function setEntryBillable(id, billable) {
  return db.getDb().prepare('UPDATE worklog_entries SET billable = ? WHERE id = ?')
    .run(billable ? 1 : 0, Number(id)).changes > 0;
}

/**
 * 逐条金额计算 —— 记薪内核，单一出口。
 *
 * 三条不可动摇的口径（方案 §三，改动前先读）：
 *  1. 金额以「分」为整数，四舍五入全程整数运算：CAST((sec*cents+1800)/3600 AS INTEGER)。
 *     绝不用 duration*rate/3600.0 —— 月级数据会出现 799.9999999 的尾巴，展示出错。
 *  2. 汇总 = Σ 逐条舍入后的分（SUM(amount_cents)，整数相加，不二次舍入）。
 *     数学上「先加后舍」更精确，但用户对账是把明细加一遍；差 1 分他就认为算错。
 *     「账要能加得上」比多一位精度重要，别去「优化」掉。
 *  3. 费率按记录开始日取：date(started_at,'localtime') 之前最近一条生效费率。
 *     started_at 是 UTC ISO，漏了 'localtime' 会让晚 8 点后的记录被算到第二天（东八区跨日）。
 *     早于所有费率 → 回落最早那条并标 useEarliest；一条费率都没有 → hasRates=false，
 *     界面显示引导而不是 ¥0.00。
 *
 * billable=0 的记录金额记 0，但保留在 rows 里并计入 excludedSec，
 * 界面要显示「已排除 12.5 小时」并可点开看是哪几条 —— 不能静默消失。
 */
function payRows({ from = ALL_FROM, to = ALL_TO } = {}) {
  const d = db.getDb();
  const rates = listRates();
  const hasRates = rates.length > 0;
  const rows = d.prepare(`
    WITH priced AS (
      SELECT e.id, e.task_id, e.group_id, e.started_at, e.ended_at, e.source,
             e.duration_sec, e.billable, e.note,
             date(e.started_at, 'localtime') AS local_day,
             (SELECT r.rate_cents FROM pay_rates r
               WHERE r.effective_from <= date(e.started_at, 'localtime')
               ORDER BY r.effective_from DESC LIMIT 1) AS exact_rate,
             (SELECT r.rate_cents FROM pay_rates r
               ORDER BY r.effective_from ASC LIMIT 1) AS earliest_rate
      FROM worklog_entries e
      WHERE e.status = 'done' AND e.started_at >= @from AND e.started_at < @to
    )
    SELECT
      p.id, p.task_id           AS taskId,
      COALESCE(t.title, '已删除任务') AS taskTitle,
      pt.title                  AS parentTitle,
      p.group_id                AS groupId,
      g.name                    AS groupName,
      g.color                   AS groupColor,
      p.started_at              AS startedAt,
      p.ended_at                AS endedAt,
      p.source                  AS source,
      p.local_day               AS localDay,
      p.duration_sec            AS durationSec,
      p.billable                AS billable,
      p.note                    AS note,
      COALESCE(p.exact_rate, p.earliest_rate) AS rateCents,
      CASE WHEN p.exact_rate IS NULL AND p.earliest_rate IS NOT NULL THEN 1 ELSE 0 END AS useEarliest,
      CASE WHEN p.billable = 0 THEN 0
           ELSE CAST((p.duration_sec * COALESCE(p.exact_rate, p.earliest_rate, 0) + 1800) / 3600 AS INTEGER)
      END AS amountCents
    FROM priced p
    LEFT JOIN tasks  t ON t.id = p.task_id
    LEFT JOIN tasks  pt ON pt.id = t.parent_id
    LEFT JOIN groups g ON g.id = COALESCE(t.group_id, p.group_id)
    ORDER BY p.started_at DESC, p.id DESC
  `).all({ from, to });

  let totalCents = 0;
  let billableSec = 0;
  let excludedSec = 0;
  for (const r of rows) {
    totalCents += r.amountCents;
    if (r.billable) billableSec += r.durationSec;
    else excludedSec += r.durationSec;
  }
  // 平均时薪 = 总额 / 可计费小时（按分算再round，展示层转成元），无计费时长时为 0
  const avgRateCents = billableSec > 0 ? Math.round((totalCents * 3600) / billableSec) : 0;
  return { hasRates, rows, totalCents, billableSec, excludedSec, avgRateCents };
}

module.exports = {
  ALL_FROM,
  ALL_TO,
  nowIso,
  getEntry,
  createEntry,
  settleEntry,
  beat,
  listRunning,
  listEntries,
  deleteEntry,
  aggregate,
  taskSummary,
  rangeEntries,
  exportRows,
  // 工时记薪
  listRates,
  upsertRate,
  deleteRate,
  setEntryBillable,
  payRows,
};
