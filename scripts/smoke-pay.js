'use strict';
/**
 * 工时记薪计算内核冒烟（纯 node，直连临时 sqlite，秒级）。
 *
 * 覆盖 docs/features/工时记薪-实现方案.md §十 里「界面层不好造数」的口径用例：
 *  1 秒 × ¥80 = ¥0.02、逐条舍入相加 = 合计、生效日切换、跨天归开始日、
 *  billable=0 排除、早于最早费率、删任务后金额仍在、同生效日 upsert 覆盖、
 *  无费率不误算、v19 迁移与导出导入往返、CSV 金额列。
 *
 * UI 层验收（分段切换 / 弹窗 / 明细）在 verify-pay.js。
 * 用法：node scripts/smoke-pay.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
const ck = (name, ok, extra) => {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knodo-smoke-pay-'));
const db = require('../main/db');
if (!db.init(dir)) {
  console.error('数据库初始化失败：', db.getInitError());
  process.exit(1);
}
const store = require('../main/worklog/store');
const exporter = require('../main/worklog/export');
const D = db.getDb();

try {
  ck('v19 迁移（user_version=19）', D.pragma('user_version', { simple: true }) === 19,
    D.pragma('user_version', { simple: true }));

  // 造一个分组 + 任务（seedDefaults 已建 id=1 分组，用 100 避免冲突）
  const t0 = '2026-01-01T00:00:00.000Z';
  D.prepare('INSERT INTO groups (id,name,color,sort_order,created_at,updated_at) VALUES (100,\'计薪\',\'#fff\',0,?,?)').run(t0, t0);
  D.prepare('INSERT INTO tasks (id,group_id,title,priority,created_at,updated_at) VALUES (1,100,\'T\',1,?,?)').run(t0, t0);
  const add = (started, dur, billable = 1) => store.createEntry({
    taskId: 1, groupId: 100, startedAt: started, endedAt: started,
    durationSec: dur, status: 'done', billable,
  });
  const clear = () => D.prepare("DELETE FROM worklog_entries WHERE task_id = 1").run();

  /* 1. 无费率 */
  let p = store.payRows({});
  ck('无费率 hasRates=false', p.hasRates === false);
  ck('无费率金额记 0（不误算）', p.totalCents === 0);

  /* 2. 1 小时 × ¥80 */
  store.upsertRate({ rateCents: 8000, effectiveFrom: '2026-03-01', note: '起步' });
  clear(); add('2026-03-10T01:00:00.000Z', 3600);
  p = store.payRows({});
  ck('1h × ¥80 = ¥80.00', p.totalCents === 8000, p.totalCents);

  /* 3. 1 秒 × ¥80 = ¥0.02（整数分四舍五入） */
  clear(); add('2026-03-10T01:00:00.000Z', 1);
  p = store.payRows({});
  ck('1s × ¥80 = ¥0.02（无浮点尾巴）', p.totalCents === 2, p.totalCents);

  /* 4. 生效日切换：3 月 80 / 4 月 100 */
  store.upsertRate({ rateCents: 10000, effectiveFrom: '2026-04-01', note: '涨薪' });
  clear();
  add('2026-03-10T01:00:00.000Z', 3600);
  add('2026-04-10T01:00:00.000Z', 3600);
  p = store.payRows({});
  const byDay = {};
  p.rows.forEach((r) => { byDay[r.localDay] = r.rateCents; });
  ck('3 月记录按 ¥80', byDay['2026-03-10'] === 8000, byDay);
  ck('4 月记录按 ¥100', byDay['2026-04-10'] === 10000, byDay);
  ck('合计 ¥180.00', p.totalCents === 18000, p.totalCents);

  /* 5. 逐条舍入相加 = 合计 */
  clear();
  [1, 2, 3].forEach(() => add('2026-05-10T01:00:00.000Z', 1));
  p = store.payRows({ from: '2026-05-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' });
  const manual = p.rows.reduce((s, r) => s + r.amountCents, 0);
  ck('Σ逐条舍入 = 合计（账能加得上）', manual === p.totalCents, { manual, total: p.totalCents });

  /* 6. 跨天归开始日（本地 23:00 → 次日 01:00） */
  clear(); add('2026-03-09T15:00:00.000Z', 7200); // UTC 15:00 = local 23:00
  p = store.payRows({ from: '2026-03-09T00:00:00.000Z', to: '2026-03-10T00:00:00.000Z' });
  ck('跨天记录归开始日（本地 3-09）', p.rows.length === 1 && p.rows[0].localDay === '2026-03-09',
    p.rows.map((r) => r.localDay));

  /* 7. billable=0：金额 0 + 排除时长 + 仍在 rows */
  clear(); add('2026-03-11T01:00:00.000Z', 3600, 0);
  p = store.payRows({ from: '2026-03-11T00:00:00.000Z', to: '2026-03-12T00:00:00.000Z' });
  ck('不计薪金额=0', p.totalCents === 0 && p.rows.length === 1);
  ck('已排除时长=3600s', p.excludedSec === 3600, p.excludedSec);
  ck('不计薪记录不静默消失', p.rows.length === 1 && p.rows[0].billable === 0);

  /* 8. 早于最早费率 → 按最早 + useEarliest 标记 */
  clear(); add('2026-02-10T01:00:00.000Z', 3600);
  p = store.payRows({ from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
  ck('早于最早费率按最早（¥80）', p.totalCents === 8000 && p.rows[0].useEarliest === 1,
    { total: p.totalCents, useEarliest: p.rows[0] && p.rows[0].useEarliest });

  /* 9. 同生效日 upsert 覆盖 */
  store.upsertRate({ rateCents: 12000, effectiveFrom: '2026-04-01' });
  const apr = store.listRates().filter((r) => r.effective_from === '2026-04-01');
  ck('同生效日覆盖仅一条', apr.length === 1 && apr[0].rate_cents === 12000, apr);

  /* 10. 删任务后金额仍在，标题「已删除任务」 */
  clear(); add('2026-04-10T01:00:00.000Z', 3600);
  db.deleteTask(1);
  p = store.payRows({ from: '2026-04-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' });
  ck('删任务后标题=已删除任务', p.rows.length > 0 && p.rows[0].taskTitle === '已删除任务',
    p.rows.map((r) => r.taskTitle));

  /* 11. 导出导入往返 + schemaVersion */
  const exp = db.exportData();
  const beforeCount = store.listRates().length;
  ck('schemaVersion=16', exp.schemaVersion === 16, exp.schemaVersion);
  ck('导出含 pay_rates', Array.isArray(exp.pay_rates) && exp.pay_rates.length >= 2);
  db.importData(exp);
  ck('导入后费率条数一致', store.listRates().length === beforeCount,
    { before: beforeCount, after: store.listRates().length });
  ck('导入后生效费率不变', store.listRates().some((r) => r.effective_from === '2026-04-01' && r.rate_cents === 12000));

  /* 12. CSV 金额列 */
  const csv = exporter.buildCsv(
    [{ id: 999, started_at: '2026-04-10T01:00:00.000Z', ended_at: '2026-04-10T02:00:00.000Z',
      duration_sec: 3600, source: 'manual', task_title: 'T', note: '' }],
    new Map([[999, { id: 999, billable: 1, rateCents: 12000, amountCents: 12000 }]])
  );
  ck('CSV 表头含金额列', /金额\(元\)/.test(csv.split('\r\n')[0]));
  ck('CSV 数据行金额=120.00', /120\.00/.test(csv) && csv.split('\r\n')[1].split(',').length >= 11);
} finally {
  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 系统清理 */ }
}

console.log(`\nPAY_SMOKE_${fail ? 'FAIL' : 'OK'} ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
