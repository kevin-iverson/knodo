'use strict';
/**
 * 日报 / 周报 / 月报 生成模块。
 * - 无 API Key 或调用失败时，退化为基于本地数据的规则生成（本地报告），并附带降级提示。
 * - 配置了 API Key 时，将本地任务数据组装为 Prompt 交给大模型生成更自然的报告。
 */
const db = require('./db');
const { callLLM } = require('./ai');

const PRIORITY_TEXT = ['低', '中', '高', '紧急'];
const PRIORITY_LABEL = { 0: '低', 1: '中', 2: '高', 3: '紧急' };

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDateShort(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/**
 * 依据报告类型解析时间范围。
 * @param {'day'|'week'|'month'|'custom'} type
 * @param {string} customStart 自定义开始（ISO，type=custom 时必填）
 * @param {string} customEnd   自定义结束（ISO，type=custom 时必填）
 */
function resolveRange(type, customStart, customEnd) {
  const now = new Date();
  let start;
  let end = new Date(now);

  if (type === 'day') {
    start = new Date(now); start.setHours(0, 0, 0, 0);
  } else if (type === 'week') {
    start = new Date(now);
    const day = (start.getDay() + 6) % 7; // 周一为 0
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
  } else if (type === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    start = new Date(customStart);
    end = new Date(customEnd);
  }
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

const TYPE_TEXT = { day: '日报', week: '周报', month: '月报', custom: '报告' };

function buildLocalReport(type, start, end, groupId) {
  const s = start.toISOString();
  const e = end.toISOString();
  const { completedTasks, createdTasks, activeNow, overdue } = db.rangeStats(s, e, groupId);

  const groupName = groupId != null ? (db.getGroup(groupId)?.name || '全部') : '全部';
  const header = `# ${TYPE_TEXT[type] || '工作报告'}（${fmtDateShort(s)} ~ ${fmtDateShort(e)}）`;
  const range = `- 统计范围：${fmtDate(start.toISOString())} 至 ${fmtDate(end.toISOString())}`;

  const totalDone = completedTasks.length;
  const totalCreated = createdTasks.length;
  const rate = totalCreated > 0 ? Math.round((totalDone / totalCreated) * 100) : 100;

  // 按分组汇总完成情况
  const byGroup = {};
  for (const t of completedTasks) {
    const g = t.group_id ? (db.getGroup(t.group_id)?.name || '未分组') : '未分组';
    byGroup[g] = (byGroup[g] || 0) + 1;
  }

  const lines = [];
  lines.push(header);
  lines.push('');
  lines.push(range);
  lines.push(`- 分组：${groupName}`);
  lines.push(`- 本周期完成任务：**${totalDone}** 项`);
  lines.push(`- 本周期新建任务：**${totalCreated}** 项`);
  lines.push(`- 完成率：**${rate}%**`);
  lines.push('');

  lines.push('## 一、完成情况');
  if (completedTasks.length === 0) {
    lines.push('本周期暂无已完成任务。');
  } else {
    for (const [g, c] of Object.entries(byGroup)) {
      lines.push(`- ${g}：${c} 项`);
    }
    lines.push('');
    lines.push('### 已完成清单');
    for (const t of completedTasks) {
      const tag = t.priority >= 2 ? `【${PRIORITY_LABEL[t.priority]}优先】` : '';
      lines.push(`- [x] ${tag}${t.title}${t.completed_at ? `（${fmtDate(t.completed_at)}）` : ''}`);
    }
  }
  lines.push('');

  lines.push('## 二、进行中 / 未完成');
  if (activeNow.length === 0) {
    lines.push('当前没有进行中的任务。');
  } else {
    for (const t of activeNow) {
      const due = t.plan_end ? ` 截止 ${t.plan_end}` : '';
      lines.push(`- [ ] ${t.title}（${PRIORITY_LABEL[t.priority]}）${due}`);
    }
  }
  lines.push('');

  lines.push('## 三、逾期提醒');
  if (overdue.length === 0) {
    lines.push('暂无逾期任务。');
  } else {
    for (const t of overdue) {
      lines.push(`- ⚠ ${t.title}（应于 ${t.plan_end} 前完成）`);
    }
  }
  lines.push('');

  lines.push('## 四、小结');
  const summary = rate >= 80
    ? '本周期任务完成情况良好，请保持当前节奏。'
    : rate >= 50
      ? '本周期任务完成情况一般，建议关注进行中与逾期任务，合理排期。'
      : '本周期完成率偏低，建议优先处理逾期与高优先级任务，必要时精简任务范围。';
  lines.push(summary);
  lines.push('');

  return lines.join('\n');
}

function buildPrompt({ type, start, end, groupId, data }) {
  const { completedTasks, createdTasks, activeNow, overdue } = data;
  const completedTitles = completedTasks.map((t) => ({
    title: t.title,
    priority: PRIORITY_LABEL[t.priority],
    completedAt: fmtDate(t.completed_at),
  }));
  const activeTitles = activeNow.map((t) => ({
    title: t.title,
    priority: PRIORITY_LABEL[t.priority],
    due: t.plan_end || '',
  }));
  const overdueTitles = overdue.map((t) => ({ title: t.title, due: t.plan_end }));

  const userMsg = [
    `请基于以下本地待办数据生成一份中文${TYPE_TEXT[type] || '工作报告'}。`,
    `时间范围：${fmtDate(start.toISOString())} 至 ${fmtDate(end.toISOString())}`,
    `分组：${groupId != null ? db.getGroup(groupId)?.name || '全部' : '全部'}`,
    '',
    `【本周期已完成任务】${JSON.stringify(completedTitles)}`,
    `【本周期新建任务数量】${createdTasks.length}`,
    `【当前进行中任务】${JSON.stringify(activeTitles)}`,
    `【逾期任务】${JSON.stringify(overdueTitles)}`,
    '',
    '要求：使用 Markdown 格式；包含「完成情况」「进行中」「问题与风险」「下一步计划」四部分；',
    '语言简洁专业，基于真实数据，不要编造不存在的内容；结尾给出 2-3 条可执行的下一步建议。',
  ].join('\n');

  return [
    { role: 'system', content: '你是一名专业的工作助理，擅长根据待办数据撰写简洁、专业、有洞察力的中文工作报告。' },
    { role: 'user', content: userMsg },
  ];
}

/**
 * 生成报告。
 * @param {object} params { type, customStart, customEnd, groupId }
 * @param {object} aiConfig { baseUrl, apiKey, model }
 * @returns {Promise<{ markdown, degraded, reason }>}
 */
async function generateReport(params, aiConfig) {
  const { type, customStart, customEnd, groupId } = params;
  const { start, end } = resolveRange(type, customStart, customEnd);
  const s = start.toISOString();
  const e = end.toISOString();
  const data = db.rangeStats(s, e, groupId);

  if (!aiConfig || !aiConfig.apiKey) {
    return {
      markdown: buildLocalReport(type, start, end, groupId),
      degraded: true,
      reason: '未配置 AI API Key，已生成本地模板报告。前往「AI 报告」页配置 API Key 后即可获得更自然的智能报告。',
    };
  }

  try {
    const markdown = await callLLM({
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      model: aiConfig.model,
      messages: buildPrompt({ type, start, end, groupId, data }),
    });
    return { markdown, degraded: false, reason: '' };
  } catch (err) {
    return {
      markdown: buildLocalReport(type, start, end, groupId),
      degraded: true,
      reason: `AI 调用失败：${err.message}。已降级为本地模板报告。`,
    };
  }
}

module.exports = { generateReport, buildLocalReport, resolveRange, TYPE_TEXT };
