'use strict';
/**
 * 最小复现：给已有「分组内任务」加重复规则后，任务的 group_id / priority 是否被错误覆盖。
 * 用法：node scripts/repro-recur-group.js
 *
 * 模拟真实入口：详情抽屉「重复与提醒 → 保存重复设置」，
 * 走 api.recurrences.create({ ...p, originTaskId })，且 p 不含 groupId / priority。
 * 本脚本先断言「正确行为」，bug 存在时应报红；修好后应全绿，故可留作回归测试。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const db = require('../main/db');

const TODAY = '2026-11-18';
let failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}${extra ? ` → ${JSON.stringify(extra)}` : ''}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-recur-group-'));
db.init(tmpDir);

// 1. 造一个正常分组下的任务，priority=2 用来观察是否被一并重置成默认值
const group = db.createGroup({ name: '复现用分组' });
const tag = db.createTag('复现标签');
const task = db.createTask({
  title: '写周报', groupId: group.id, priority: 2,
  planStart: TODAY, planEnd: TODAY, tagIds: [tag.id],
});
check('前置：任务在分组内', db.getTask(task.id).group_id === group.id);
check('前置：任务优先级为 2', db.getTask(task.id).priority === 2);
check('前置：任务带标签', (db.getTask(task.id).tag_ids || []).includes(tag.id));

// 2. 模拟「设为重复 → 保存重复设置」：只传标题 / 规则 / 日期，不传 groupId 与 priority
const rule = db.createRecurringRule({
  title: '写周报',
  rule: { freq: 'daily', interval: 1, holidayMode: 'none' },
  startDate: TODAY,
  habit: false,
  notes: '',
  originTaskId: task.id,
  today: TODAY,
});

// 3. 断言：加重复不应改变任务原有的分组与优先级
const after = db.getTask(task.id);
check('加重复后任务仍在原分组', after.group_id === group.id,
  { expected: group.id, actual: after.group_id });
check('加重复后优先级未被重置', after.priority === 2,
  { expected: 2, actual: after.priority });
check('加重复后标签仍在', (after.tag_ids || []).includes(tag.id),
  { expected: [tag.id], actual: after.tag_ids });
check('规则确实挂在这条任务上', after.recurring_id === rule.id,
  { expected: rule.id, actual: after.recurring_id });

// 4. 边界：调用方显式传 groupId 时仍以显式值为准（列表就地编辑路径靠 ...payload 传 groupId）
const target = db.createGroup({ name: '显式目标分组' });
const task2 = db.createTask({ title: '换分组任务', groupId: group.id, priority: 3 });
db.createRecurringRule({
  title: '换分组任务',
  rule: { freq: 'daily' },
  startDate: TODAY,
  groupId: target.id,
  originTaskId: task2.id,
  today: TODAY,
});
const after2 = db.getTask(task2.id);
check('显式传 groupId 时以显式值为准', after2.group_id === target.id,
  { expected: target.id, actual: after2.group_id });

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
console.log(failed ? `\n结果：${failed} 项断言失败（bug 复现成功）` : '\n结果：全部通过');
process.exit(failed ? 1 : 0);
