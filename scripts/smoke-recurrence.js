'use strict';
/**
 * 重复待办 / 习惯：独立冒烟测试（不依赖 Electron，可直接 node 运行）。
 * 用法：node scripts/smoke-recurrence.js
 *
 * 覆盖：日期工具、法定节假日与调休、规则展开、生成幂等、完成记录、
 *       规则调整 / 停止 / 重启 / 删除、跳过本次、导入导出、v17 迁移合并旧实例。
 * 模型：一条重复事项只有一条 tasks 行，完成记录按发生日存在 recurrence_completions。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const dateU = require('../main/date-utils');
const holidays = require('../main/holidays-cn');
const rules = require('../main/recurrence-rules');
const db = require('../main/db');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}${extra ? ` → ${JSON.stringify(extra)}` : ''}`); }
}

console.log('[1] 日期工具');
check('跨月加天', dateU.addDays('2026-10-31', 1) === '2026-11-01');
check('闰年 2 月', dateU.addDays('2028-02-28', 1) === '2028-02-29');
check('月末收敛（1/31 + 1 月）', dateU.addMonths('2026-01-31', 1) === '2026-02-28');
check('星期（UTC，不受时区影响）', dateU.dayOfWeek('2026-11-07') === 6);
check('本地 09:00 → ISO 回读仍是 9 点', (() => {
  const iso = dateU.localTimeToIso('2026-11-09', '09:00');
  return !!iso && new Date(iso).getHours() === 9 && new Date(iso).getMinutes() === 0;
})());
check('非法时间返回 null', dateU.localTimeToIso('2026-11-09', '25:99') === null);

console.log('\n[2] 中国法定节假日 / 调休');
check('数据覆盖 2026-2027', holidays.coverage().years.join(',') === '2026,2027');
check('国庆 10/1 是假期', holidays.isCnHoliday('2026-10-01') && !holidays.isCnWorkday('2026-10-01'));
check('10/10 调休补班要上班', holidays.isMakeupWorkday('2026-10-10') && holidays.isCnWorkday('2026-10-10'));
check('普通周一要上班', holidays.isCnWorkday('2026-10-12') && !holidays.isCnHoliday('2026-10-12'));
check('普通周末不上班', !holidays.isCnWorkday('2026-10-11'));
check('2027 春节 2/8 是假期', holidays.isCnHoliday('2027-02-08'));
check('2027 1/31 周日补班', holidays.isCnWorkday('2027-01-31'));
check('未覆盖年份降级为周一~周五', !holidays.isCovered('2028-01-03')
  && holidays.isCnWorkday('2028-01-03') && !holidays.isCnWorkday('2028-01-02'));

console.log('\n[3] 规则展开');
const daily = rules.normalizeRule({ freq: 'daily', interval: 3, holidayMode: 'none' });
check('每 3 天（锚点起算）', rules.occurrences(daily, '2026-11-01', '2026-11-10', '2026-11-01').join(',')
  === '2026-11-01,2026-11-04,2026-11-07,2026-11-10');
const weekly = rules.normalizeRule({ freq: 'weekly', weekdays: [1, 3, 5], interval: 2, holidayMode: 'none' });
check('每 2 周的周一/三/五', rules.occurrences(weekly, '2026-11-02', '2026-11-15', '2026-11-02').join(',')
  === '2026-11-02,2026-11-04,2026-11-06');
const monthly = rules.normalizeRule({ freq: 'monthly', monthDays: [1, -1], holidayMode: 'none' });
check('每月 1 日与月末', rules.occurrences(monthly, '2026-11-01', '2026-12-31', '2026-11-01').join(',')
  === '2026-11-01,2026-11-30,2026-12-01,2026-12-31');
const workday = rules.normalizeRule({ freq: 'workday' });
const oct = rules.occurrences(workday, '2026-10-01', '2026-10-12', '2026-09-01');
check('法定工作日：排除国庆连休、包含 10/10 调休补班',
  oct.join(',') === '2026-10-08,2026-10-09,2026-10-10,2026-10-12', oct);
check('workday 频率强制 cn 模式', rules.normalizeRule({ freq: 'workday', holidayMode: 'none' }).holidayMode === 'cn');
check('脏规则被归一化', (() => {
  const r = rules.normalizeRule({ freq: 'nonsense', interval: -9, weekdays: [99, 1, 1], reminderTime: '99:99' });
  return r.freq === 'daily' && r.interval === 1 && r.weekdays.join(',') === '1' && r.reminderTime === '09:00';
})());
check('实例字段：完成日偏移 + 提前 1 天提醒', (() => {
  const f = rules.instanceFields({ freq: 'daily', reminderTime: '08:30', reminderOffsetDays: 1, dueOffsetDays: 2 }, '2026-11-09');
  return f.planStart === '2026-11-09' && f.planEnd === '2026-11-11'
    && !!f.reminderAt && new Date(f.reminderAt).getDate() === 8 && new Date(f.reminderAt).getHours() === 8;
})());
check('规则摘要可读', /每个法定工作日/.test(rules.describeRule({ freq: 'workday' })));

console.log('\n[4] 数据层：一条任务 + 按日打卡');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-recur-'));
db.init(tmpDir);
check('迁移到 v17', db.getDb().pragma('user_version', { simple: true }) === 17);
check('新表就绪', (() => {
  const names = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  return names.includes('recurring_rules') && names.includes('recurrence_completions')
    && names.includes('recurrence_skips');
})());
check('rules 带 task_id 列', db.getDb().prepare('PRAGMA table_info(recurring_rules)')
  .all().some((c) => c.name === 'task_id'));
check('旧的「每规则每天唯一」索引已撤', !db.getDb().prepare(
  "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_recur_day'").get());

const TODAY = '2026-11-09'; // 周一，法定工作日
const oneOff = db.createTask({ title: '一次性待办', planStart: TODAY, planEnd: TODAY });
check('一次性任务 recurring_id 为空', oneOff.recurring_id == null && oneOff.occurrence_date == null);

const rule = db.createRecurringRule({
  title: '抽盘仓库', notes: '每日必做', priority: 2,
  startDate: '2026-11-02', endDate: '2026-11-18', habit: true,
  rule: { freq: 'workday', reminderTime: '09:00', dueOffsetDays: 0 },
  today: TODAY,
});
check('规则 1:1 绑定一条任务', rule.task_id != null && db.getTask(rule.task_id).recurring_id === rule.id);
const inst = db.listTasks({ recurringId: rule.id, status: 'any' });
check('只生成一条任务，不是按天铺 N 条', inst.length === 1, inst.length);
const t0 = inst[0];
check('任务行日期 = 下一次发生日', t0.occurrence_date === TODAY
  && t0.plan_start === TODAY && t0.plan_end === TODAY, t0);
check('提醒时间由规则给出', !!t0.reminder_at && new Date(t0.reminder_at).getHours() === 9);
check('「今天」过滤能查到这一条', db.listTasks({ status: 'active', planEndTo: TODAY })
  .some((t) => t.id === t0.id));
check('一次性任务与重复事项共存', db.listTasks({ status: 'any' }).some((t) => t.id === oneOff.id));

// 提醒链路仍是既有 dueReminders / markReminderFired，没有第二套通知系统
db.getDb().prepare('UPDATE tasks SET reminder_at = ?, reminder_fired = 0 WHERE id = ?')
  .run(new Date(Date.now() - 60000).toISOString(), t0.id);
check('到期进入提醒队列', db.dueReminders().some((t) => t.id === t0.id));
db.markReminderFired(t0.id);
check('标记后不再重复弹', !db.dueReminders().some((t) => t.id === t0.id));
db.rollRecurringTask(rule.id, { today: TODAY });
check('恢复规则提醒时间后允许新的提醒再弹', db.getTask(t0.id).reminder_fired === 0);
db.markReminderFired(t0.id);
db.rollRecurringTask(rule.id, { today: TODAY });
check('同一天再次日切不会重置已弹标记', db.getTask(t0.id).reminder_fired === 1);

const syncAgain = db.syncRule(rule.id, { today: TODAY });
check('重复同步幂等', syncAgain.created === 0 && syncAgain.removed === 0
  && syncAgain.updated === 0, syncAgain);

db.toggleTask(t0.id);
check('勾选完成写入打卡表', db.listCompletions(rule.id).some((c) => c.occurrence_date === TODAY));
check('行上完成态 = 今天这份打卡', !!db.getTask(t0.id).completed && !!db.getTask(t0.id).completed_at);
const s1 = db.habitStats(rule.id, { today: TODAY });
check('习惯统计记录本次完成', s1.completedExpected >= 1 && s1.doneInstances === 1 && s1.todayDone, s1);
check('习惯连续天数 >= 1', s1.streak >= 1);

const NEXT = '2026-11-10';
db.syncRecurrences({ today: NEXT });
const t1 = db.getTask(t0.id);
check('跨天仍是同一条任务（id 不变）', t1.id === t0.id
  && db.listTasks({ recurringId: rule.id, status: 'any' }).length === 1);
check('跨天推进到下一个发生日', t1.occurrence_date === NEXT && t1.plan_end === NEXT, t1);
check('跨天自动恢复未完成', !t1.completed && t1.completed_at == null);
check('历史打卡没有被跨天抹掉', db.listCompletions(rule.id).some((c) => c.occurrence_date === TODAY));

// 用户原话：设了重复 10 天，想改成 8 天怎么办 —— 现在只改一行规则，不重建任何任务
db.updateRecurringRule(rule.id, { endDate: '2026-11-16', today: NEXT });
check('改结束日（10天→8天）仍只有一条任务',
  db.listTasks({ recurringId: rule.id, status: 'any' }).length === 1);
check('改结束日不动打卡历史', db.listCompletions(rule.id).length === 1);
check('规则结束日已更新', db.getRecurringRule(rule.id).end_date === '2026-11-16');
db.updateRecurringRule(rule.id, {
  rule: { freq: 'daily', reminderTime: '10:30', dueOffsetDays: 0 }, today: NEXT,
});
const t2 = db.getTask(t0.id);
check('改频率/提醒时间只刷新这一行', new Date(t2.reminder_at).getHours() === 10
  && new Date(t2.reminder_at).getMinutes() === 30 && t2.occurrence_date === NEXT);
check('提醒时间变化后允许再弹', t2.reminder_fired === 0);

db.skipOccurrence(rule.id, NEXT, { today: NEXT });
check('跳过本次 → 日期推进到下一天',
  db.getTask(t0.id).occurrence_date === '2026-11-11', db.getTask(t0.id).occurrence_date);
db.clearSkips(rule.id, { today: NEXT });
check('清除跳过后回到本次', db.getTask(t0.id).occurrence_date === NEXT);

db.setRecurringEnabled(rule.id, false, { today: NEXT });
const stopped = db.getTask(t0.id);
check('停止规则 → 任务保留但不再排期', !!stopped
  && stopped.plan_start == null && stopped.occurrence_date == null);
check('停止后打卡历史保留', db.listCompletions(rule.id).length === 1);
check('停止后不再有下一次发生日', db.habitStats(rule.id, { today: NEXT }).nextDate === '');
db.setRecurringEnabled(rule.id, true, { today: NEXT });
check('重新启用 → 这一条恢复排期', db.getTask(t0.id).occurrence_date === NEXT);

const snapshot = db.exportData();
check('备份 schema 14 且含规则/打卡/跳过', snapshot.schemaVersion === 14
  && snapshot.recurring_rules.length === 1 && snapshot.recurrence_completions.length === 1
  && Array.isArray(snapshot.recurrence_skips));
check('备份里重复事项只有一条任务',
  snapshot.tasks.filter((t) => t.recurring_id === rule.id).length === 1);

const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-recur2-'));
db.close();
db.init(tmpDir2);
db.importData(snapshot);
check('导入还原规则', db.listRecurringRules().length === 1);
check('导入还原打卡记录', db.listCompletions(rule.id).length === 1);
check('导入后仍只有一条重复任务',
  db.listTasks({ status: 'any' }).filter((t) => t.recurring_id != null).length === 1);
check('导入还原一次性任务', db.listTasks({ status: 'any' })
  .some((t) => t.title === '一次性待办' && t.recurring_id == null));
const imported = db.listTasks({ recurringId: rule.id, status: 'any' })[0];
check('导入后按当天重算发生日', !!imported.occurrence_date, imported.occurrence_date);

db.deleteTask(imported.id);
check('列表删任务 → 规则与打卡一起删', db.listRecurringRules().length === 0
  && db.listCompletions(rule.id).length === 0);

const rule2 = db.createRecurringRule({
  title: '第二条', rule: { freq: 'daily', reminderTime: '09:00' },
  startDate: '2026-11-08', today: '2026-11-08',
});
const task2 = db.getTask(rule2.task_id);
db.deleteRecurringRule(rule2.id);
check('删规则 → 任务脱钩成普通待办保留', !!db.getTask(task2.id)
  && db.getTask(task2.id).recurring_id == null);
check('删规则后规则表清空', db.listRecurringRules().length === 0);

console.log('\n[5] v17 迁移：把旧库预生成的 N 条实例合并成一条');
const raw = db.getDb();
const rule3 = db.createRecurringRule({
  title: '旧数据', rule: { freq: 'daily', reminderTime: '09:00' },
  startDate: '2026-11-08', today: '2026-11-08',
});
const insOld = raw.prepare(
  `INSERT INTO tasks (group_id, parent_id, title, notes, attachments, priority,
     plan_start, plan_end, reminder_at, completed, completed_at, archived, sort_order,
     created_at, updated_at, recurring_id, occurrence_date)
   VALUES (NULL, NULL, '旧数据', '', '[]', 1, ?, ?, NULL, ?, ?, 0, 0,
     '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z', ?, ?)`
);
['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].forEach((d, i) => {
  const done = i < 2 ? 1 : 0;
  insOld.run(d, d, done, done ? '2026-11-08T09:00:00.000Z' : null, rule3.id, d);
});
check('旧形态构造完成：同规则 5 条任务',
  raw.prepare('SELECT COUNT(*) c FROM tasks WHERE recurring_id = ?').get(rule3.id).c === 5);
raw.exec('ALTER TABLE recurring_rules DROP COLUMN task_id');
raw.exec('DROP TABLE recurrence_completions');
raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_recur_day ON tasks(recurring_id, occurrence_date)');
raw.pragma('user_version = 16');
db.close();
db.init(tmpDir2);
check('重开后迁移到 v17', db.getDb().pragma('user_version', { simple: true }) === 17);
check('5 条旧实例合并成 1 条', db.getDb()
  .prepare('SELECT COUNT(*) c FROM tasks WHERE recurring_id = ?').get(rule3.id).c === 1);
check('2 条已完成实例转成打卡记录', db.listCompletions(rule3.id).length === 2,
  db.listCompletions(rule3.id));
check('打卡日期与原实例一致', db.listCompletions(rule3.id)
  .map((c) => c.occurrence_date).join(',') === '2026-11-09,2026-11-10');
const merged = db.listTasks({ recurringId: rule3.id, status: 'any' })[0];
check('规则 task_id 指回保留的主任务', db.getRecurringRule(rule3.id).task_id === merged.id);
db.syncRecurrences({ today: '2026-11-12' });
check('迁移后日切正常推进且历史完成不串到今天', (() => {
  const t = db.getTask(merged.id);
  return t.occurrence_date === '2026-11-12' && !t.completed;
})());

console.log('\n[6] 「今天」判据（P-06）与派生日期写入保护（P-01/P-02）');
const T6 = '2026-11-12'; // 周四，法定工作日
const r6 = db.createRecurringRule({
  title: '两天内完成', startDate: '2026-11-01',
  rule: { freq: 'workday', dueOffsetDays: 2, reminderTime: '09:00' }, today: T6,
});
const t6 = db.getTask(r6.task_id);
check('截止日 = 发生日 + 2 天', t6.occurrence_date === T6 && t6.plan_end === '2026-11-14', t6);
check('发生日当天就在「今天」，不再等到截止日',
  db.listTasks({ status: 'active', planEndTo: T6, todayRecurring: T6 }).some((t) => t.id === t6.id));
check('同一份不再重复出现在「即将到期」顶部',
  !db.listTasks({ status: 'active', planEndFrom: T6, excludeRecurringDue: T6, sort: 'due' })
    .some((t) => t.id === t6.id));
const laterOneOff = db.createTask({ title: '一次性·后天', planStart: '2026-11-14', planEnd: '2026-11-14' });
check('一次性任务口径不变：截止日在未来的不进「今天」',
  !db.listTasks({ status: 'active', planEndTo: T6, todayRecurring: T6 })
    .some((t) => t.id === laterOneOff.id));
check('一次性任务口径不变：仍按截止日进「即将到期」',
  db.listTasks({ status: 'active', planEndFrom: T6, excludeRecurringDue: T6 })
    .some((t) => t.id === laterOneOff.id));

// 详情面板跨过零点还开着：改个标题也会把打开时那天的旧日期一起提交上来
db.syncRecurrences({ today: '2026-11-13' });
const stalePlan = { planStart: T6, planEnd: '2026-11-14', reminderAt: null };
const saved = db.updateTask(t6.id, { title: '两天内完成（改过标题）', ...stalePlan });
check('改标题后发生日不倒退（派生日期被拒写）',
  saved.occurrence_date === '2026-11-13' && saved.plan_end === '2026-11-15', saved);
check('标题照常保存', saved.title === '两天内完成（改过标题）');
check('提醒时间仍由规则给出（未被 null 覆盖）', !!saved.reminder_at);

db.setRecurringEnabled(r6.id, false, { today: '2026-11-13' });
check('暂停的重复事项归入「今天不发生」清单',
  db.listTasks({ status: 'active', recurringPending: '2026-11-13' }).some((t) => t.id === t6.id));
check('暂停后任务仍在（不是被当成已删除）', !!db.getTask(t6.id));

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch (_) { /* ignore */ }

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
