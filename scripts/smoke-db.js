'use strict';
/**
 * 数据层 + 报告生成的独立冒烟测试（不依赖 Electron，可直接用 Node 运行）。
 * 用法：node scripts/smoke-db.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const db = require('../main/db');
const report = require('../main/report');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-smoke-'));
console.log('临时数据库目录:', tmpDir);

db.init(tmpDir);

console.log('\n[1] 分组 CRUD');
const g1 = db.createGroup({ name: '工作', color: '#4f7cff' });
const g2 = db.createGroup({ name: '生活', color: '#23b07e' });
check('默认分组 + 新建分组', db.listGroups().length >= 4);
db.updateGroup(g2.id, { name: '家庭', color: '#f59e0b' });
check('更新分组', db.getGroup(g2.id).name === '家庭');

// 子分组层级
const child = db.createGroup({ name: '前端', color: '#8b5cf6', parentId: g1.id });
const grand = db.createGroup({ name: '组件库', color: '#06b6d4', parentId: child.id });
check('创建子分组', child.parent_id === g1.id && grand.parent_id === child.id);
check('子孙集合（多层）', db.descendantGroupIds(g1.id).sort().join(',') === [child.id, grand.id].sort().join(','));
check('分组展开含自身', db.expandGroupIds([g1.id]).length === 3);
check('挂载到自己的子孙被拒绝', (() => {
  try { db.updateGroup(g1.id, { parentId: grand.id }); return false; } catch (e) { return true; }
})());
check('挂到自己被拒绝', (() => {
  try { db.updateGroup(g1.id, { parentId: g1.id }); return false; } catch (e) { return true; }
})());

console.log('\n[2] 标签');
const t1 = db.createTag('紧急');
const t2 = db.createTag('项目A');
check('创建标签', t1.id && t2.id);
check('标签去重', db.createTag('紧急').id === t1.id);

console.log('\n[3] 任务 CRUD（计划日期）');
const task1 = db.createTask({
  title: '写周报', groupId: g1.id, priority: 2,
  planStart: '2026-01-01', planEnd: '2026-10-15', tagIds: [t1.id, t2.id],
});
const task2 = db.createTask({
  title: '买菜', groupId: g2.id, priority: 1, planEnd: '2026-10-20',
});
check('创建任务1（含计划日期）', task1.id && task1.plan_start === '2026-01-01' && task1.plan_end === '2026-10-15' && task1.tag_names.length === 2);
check('创建任务2', task2.id && task2.group_name === '家庭' && task2.plan_end === '2026-10-20');
check('列表查询', db.listTasks({ status: 'all' }).length === 2);
check('搜索命中', db.listTasks({ search: '周报' }).length === 1);
check('按标签筛选', db.listTasks({ tagId: t2.id }).length === 1);
check('按分组筛选', db.listTasks({ groupId: g2.id }).length === 1);

// 父分组筛选要带上所有子分组的任务
const kidTask = db.createTask({ title: '组件文档', groupId: grand.id });
check('按父分组筛选包含子分组任务', db.listTasks({ groupId: g1.id, status: 'all' }).length === 2);
check('按中间层分组筛选包含孙分组任务', db.listTasks({ groupId: child.id, status: 'all' }).length === 1);
check('父分组计数含子孙任务', db.listGroups().find((g) => g.id === g1.id).total_count === 2);

// 层级验证完成，清掉这批临时任务，避免干扰后续按数量断言的用例
db.deleteTask(kidTask.id);

console.log('\n[4] 时间筛选');
check('按计划完成日期上限', db.listTasks({ planEndTo: '2026-10-15' }).length === 1);
check('按计划完成日期下限', db.listTasks({ planEndFrom: '2026-10-16' }).length === 1);
check('按计划开始日期', db.listTasks({ planStartFrom: '2026-01-01', planStartTo: '2026-01-02' }).length === 1);

const updated = db.updateTask(task1.id, { title: '写周报（改）', planEnd: '2026-10-18', planStart: '2026-01-02' });
check('更新任务', updated.title === '写周报（改）' && updated.plan_end === '2026-10-18');

console.log('\n[5] 完成 / 完成时间 / 归档 / 统计');
db.toggleTask(task1.id);
check('标记完成并记录实际完成时间', db.getTask(task1.id).completed === true && !!db.getTask(task1.id).completed_at);
const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
const tomorrowStart = new Date(todayStart.getTime() + 24 * 3600 * 1000);
check('按实际完成时间筛选', db.listTasks({ completedFrom: todayStart.toISOString(), completedTo: tomorrowStart.toISOString() }).length === 1);
db.toggleTask(task1.id);
check('取消完成（清空完成时间）', db.getTask(task1.id).completed === false && db.getTask(task1.id).completed_at === null);
db.toggleTask(task1.id);
db.archiveTask(task1.id);
check('单任务归档', db.getTask(task1.id).archived === true);
db.unarchiveTask(task1.id);
check('取消归档', db.getTask(task1.id).archived === false);

const ov = db.overview();
check('统计概览', ov.total === 2 && ov.completed === 1);
check('趋势天数', db.dailyTrend(7).length === 7);

console.log('\n[6] 数据导入 / 导出');
const exported = db.exportData();
check('导出结构', exported.app === 'todo-desktop' && exported.tasks.length >= 2 && Array.isArray(exported.groups) && Array.isArray(exported.tags));
check('导出不含 apiKey', JSON.stringify(exported.settings).indexOf('apiKey') === -1);
const imp = db.importData(exported);
check('导入恢复数量', imp.tasks === exported.tasks.length && imp.groups === exported.groups.length);
check('导入后可查询', db.listTasks({ status: 'all' }).length === exported.tasks.length);

console.log('\n[7] 子任务');
// 确保父任务初始未完成
if (db.getTask(task1.id).completed) db.toggleTask(task1.id);
const sub1 = db.createTask({ title: '写周报-收集数据', parentId: task1.id });
const sub2 = db.createTask({ title: '写周报-整理数据', parentId: task1.id, attachments: ['data:image/png;base64,AAA'] });
check('创建子任务', sub1.parent_id === task1.id && sub2.parent_id === task1.id);
check('子任务附件存取', Array.isArray(db.getTask(sub2.id).attachments) && db.getTask(sub2.id).attachments.length === 1);
check('主列表包含子任务', db.listTasks({ status: 'all' }).some((t) => t.id === sub1.id));
check('子任务含父任务信息', db.listTasks({ parentId: task1.id }).every((t) => t.parent_title === '写周报（改）'));
check('查询子任务', db.listSubtasks(task1.id).length === 2);
db.toggleTask(sub1.id);
db.toggleTask(sub2.id);
check('所有子任务完成 → 父任务自动完成', db.getTask(task1.id).completed === true);
db.toggleTask(sub1.id);
check('子任务取消完成 → 父任务自动取消完成', db.getTask(task1.id).completed === false);
db.deleteTask(task1.id);
check('删除父任务级联删除子任务', db.getTask(sub1.id) === null && db.getTask(sub2.id) === null);

console.log('\n[7.5] 删除分组的级联行为');
const tParent = db.createGroup({ name: '待删父组', color: '#4f7cff' });
const tChild = db.createGroup({ name: '待删子组', color: '#8b5cf6', parentId: tParent.id });
const tGrandTask = db.createTask({ title: '顶层任务', groupId: tParent.id });
const tChildTask = db.createTask({ title: '子组任务', groupId: tChild.id });
const rm1 = db.deleteGroup(tParent.id);
check('删除父分组连带删除子分组', rm1.deletedGroups === 2 && db.getGroup(tChild.id) === null);
check('组内任务不会被删除（无上级 → 未分组）',
  db.getTask(tGrandTask.id).group_id === null && db.getTask(tChildTask.id).group_id === null);

// 有上级时任务上移一级，而不是变成未分组
const tSub = db.createGroup({ name: '挂 Existing', color: '#06b6d4', parentId: g1.id });
const tSubTask = db.createTask({ title: '上移任务', groupId: tSub.id });
db.deleteGroup(tSub.id);
check('有上级时任务上移到上级分组', db.getTask(tSubTask.id).group_id === g1.id);

console.log('\n[8] 报告本地生成（无 Key 降级）');
const now = new Date();
const start = new Date(now); start.setHours(0, 0, 0, 0);
report.generateReport(
  { type: 'day', customStart: start.toISOString(), customEnd: now.toISOString(), groupId: null },
  { baseUrl: '', apiKey: '', model: '' }
).then((r) => {
  check('降级报告生成', r.degraded === true && r.markdown.includes('日报'));
  check('报告含完成清单', r.markdown.includes('完成情况'));

  console.log('\n====================');
  console.log(`结果：${passed} 通过，${failed} 失败`);
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
});
