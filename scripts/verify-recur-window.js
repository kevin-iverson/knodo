'use strict';
/**
 * 最小复现：重复任务的「发生日 + N 天完成窗口」跨天是否持续出现在「今天」。
 * 用法：node scripts/repro-recur-window.js
 *
 * 场景（2026-11-16 是周一）：
 *   规则 = 每周一，dueOffsetDays = 5 → 本次窗口 11-16(周一) ~ 11-21(周六)
 *   期望：周一没完成 → 周二 / 周三 / 周六都还在「今天」；完成后或窗口过了才推进。
 * 本脚本先断言正确行为，bug 存在时应报红。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const db = require('../main/db');

const MON = '2026-11-16';      // 发生日（周一）
const TUE = '2026-11-17';
const WED = '2026-11-18';
const SAT = '2026-11-21';      // 周一 + 5 = 完成窗口最后一天
const SUN = '2026-11-22';
const NEXT_MON = '2026-11-23';

let failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}${extra ? ` → ${JSON.stringify(extra)}` : ''}`); }
}
// 与 renderer/js/store.js#buildFilter 的 today 视图完全同参
function todayView(day) {
  return db.listTasks({ status: 'active', planEndTo: day, todayRecurring: day });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-recur-window-'));
db.init(tmpDir);

const RULE = {
  freq: 'weekly', weekdays: [1], interval: 1, holidayMode: 'none',
  dueOffsetDays: 5, reminderTime: '',
};

/* ---------- 场景 A：周一没完成，窗口内每天都要在「今天」 ---------- */
const rule = db.createRecurringRule({ title: '跨天任务A', rule: RULE, startDate: MON, today: MON });
const taskId = rule.task_id;

let t = db.getTask(taskId);
check('周一：窗口 = 11-16 ~ 11-21', t.plan_start === MON && t.plan_end === SAT,
  { plan_start: t.plan_start, plan_end: t.plan_end });
check('周一：今天视图可见', todayView(MON).some((x) => x.id === taskId));

db.syncRecurrences({ today: TUE });
t = db.getTask(taskId);
check('周二：仍守着周一这一次（未完成）', t.occurrence_date === MON, { actual: t.occurrence_date });
check('周二：今天视图仍可见', todayView(TUE).some((x) => x.id === taskId));

db.syncRecurrences({ today: WED });
check('周三：今天视图仍可见', todayView(WED).some((x) => x.id === taskId));

db.syncRecurrences({ today: SAT });
check('周六（窗口最后一天）：今天视图仍可见', todayView(SAT).some((x) => x.id === taskId));

db.syncRecurrences({ today: SUN });
t = db.getTask(taskId);
check('周日（窗口已过）：推进到下周一', t.occurrence_date === NEXT_MON, { actual: t.occurrence_date });

/* ---------- 场景 B：周一已完成 → 周二不该再占「今天」 ---------- */
const ruleB = db.createRecurringRule({ title: '跨天任务B', rule: RULE, startDate: MON, today: MON });
db.setCompletion(ruleB.id, MON, true, { today: MON });
db.syncRecurrences({ today: TUE });
const tb = db.getTask(ruleB.task_id);
check('周一完成后：推进到下周一', tb.occurrence_date === NEXT_MON, { actual: tb.occurrence_date });
check('周一完成后：周二今天视图不含它', !todayView(TUE).some((x) => x.id === ruleB.task_id));

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
console.log(failed ? `\n结果：${failed} 项断言失败（bug 复现成功）` : '\n结果：全部通过');
process.exit(failed ? 1 : 0);
