'use strict';
/**
 * 输出模板契约验证（Node 直接跑）：node scripts/verify-report-templates.js
 * 覆盖：内置模板清单 / prompt 注入 / 自定义模板校验 / 本地降级模板提示。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const db = require('../main/db');
const report = require('../main/report');

let passed = 0; let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-tpl-')));

(async () => {
  console.log('\n[1] 内置模板');
  const list = report.listOutputTemplates();
  check('内置 6 套模板', list.length === 6);
  check('含标准 / 极简 / OKR / 复盘 / 向上汇报 / 多图表分析',
    ['standard', 'brief', 'okr', 'review', 'upward', 'charts'].every((id) => list.some((t) => t.id === id)));
  check('每套都有章节与输出要求', list.every((t) => t.sections.length > 0 && t.instruction.length > 0));
  check('返回的是副本，外部改动不污染注册表', (() => {
    list[0].name = '改坏了';
    return report.listOutputTemplates()[0].name !== '改坏了';
  })());

  console.log('\n[2] Prompt 按模板注入');
  const from = new Date(Date.now() - 3600e3);
  const to = new Date(Date.now() + 3600e3);
  const data = db.rangeStats(from.toISOString(), to.toISOString(), []);
  const base = { type: 'week', start: from, end: to, groupIds: [], data, extraPrompt: '' };
  const std = report.buildPrompt({ ...base, outputTemplate: { id: 'standard' } })[1].content;
  const brief = report.buildPrompt({ ...base, outputTemplate: { id: 'brief' } })[1].content;
  check('默认模板仍含标准四段要求', std.includes('完成情况') && std.includes('下一步计划'));
  check('极简日报模板注入自己的要求', brief.includes('【输出模板：极简日报】') && brief.includes('明日计划'));
  const charts = report.buildPrompt({ ...base, outputTemplate: { id: 'charts' } })[1].content;
  check('多图表模板要求至少 3 张 Mermaid 图', charts.includes('【输出模板：多图表分析】')
    && charts.includes('pie') && charts.includes('gantt') && charts.includes('至少 3 个 mermaid 代码块'));
  check('多图表模板章节含图表解读', charts.includes('图表解读') && charts.includes('风险与建议'));
  check('不同模板 prompt 不同', std !== brief && std !== charts);
  check('prompt 明确列出章节结构', brief.includes('章节结构：1. 今日完成'));

  console.log('\n[3] 自定义模板校验');
  const custom = report.normalizeOutputTemplate({
    id: 'custom-test', name: '  我的模板  ', description: ' 测试 ',
    sections: ['概览', '  ', '风险', '计划', '计划'],
    instruction: '  使用 Markdown；先结论后证据。  ',
  });
  check('名称与要求被 trim', custom.name === '我的模板' && custom.instruction.startsWith('使用 Markdown'));
  check('章节去空且保留顺序', JSON.stringify(custom.sections) === '["概览","风险","计划","计划"]');
  check('缺名称的模板被拒绝', report.normalizeOutputTemplate({ instruction: 'x' }) === null);
  check('缺要求的模板被拒绝', report.normalizeOutputTemplate({ name: 'x' }) === null);
  const customPrompt = report.buildPrompt({ ...base, outputTemplate: custom })[1].content;
  check('自定义模板注入 prompt', customPrompt.includes('【输出模板：我的模板】') && customPrompt.includes('先结论后证据'));
  const fallback = report.buildPrompt({ ...base, outputTemplate: { id: 'not-exist', name: 'x' } })[1].content;
  check('非法模板回落默认', fallback.includes('【输出模板：标准四段式】'));

  console.log('\n[4] 本地降级报告标注模板');
  // 造一完成 + 一逾期，保证多图表模板能生成饼图 / 甘特图
  const done = db.createTask({ title: '图表完成项', priority: 2, completedAt: to.toISOString() });
  db.toggleTask(done.id);
  db.createTask({
    title: '图表逾期项', priority: 3,
    planEnd: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
  });
  const withTpl = report.buildLocalReport('week', from, to, [], '', custom);
  check('非默认模板追加模板说明', withTpl.includes('## 附：本次输出模板') && withTpl.includes('我的模板'));
  check('模板章节写入报告', withTpl.includes('目标章节：1. 概览'));
  const plain = report.buildLocalReport('week', from, to, [], '');
  check('默认模板不追加说明，保持原报告结构', !plain.includes('## 附：本次输出模板'));

  const chartsLocal = report.buildLocalReport('week', from, to, [], '', { id: 'charts' });
  check('多图表模板本地报告含图表章节', chartsLocal.includes('## 附：可视化图表（本地自动生成）'));
  check('本地生成分组饼图', chartsLocal.includes('pie title 分组完成占比'));
  check('本地生成优先级饼图', chartsLocal.includes('pie title 任务优先级分布'));
  check('本地生成任务时间线甘特图', chartsLocal.includes('gantt') && chartsLocal.includes('dateFormat YYYY-MM-DD'));
  check('图表标签来自真实任务且无脏值', chartsLocal.includes('图表逾期项') && !chartsLocal.includes('undefined'));

  const gen = await report.generateReport(
    { type: 'week', customStart: from.toISOString(), customEnd: to.toISOString(), groupIds: [], outputTemplate: custom },
    null,
  );
  check('generateReport 接收 outputTemplate 并在降级报告生效', gen.markdown.includes('我的模板'));

  console.log('\n====================');
  console.log(`结果：${passed} 通过，${failed} 失败`);
  db.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('验证脚本异常:', e);
  try { db.close(); } catch (err) { /* 忽略 */ }
  process.exit(1);
});
