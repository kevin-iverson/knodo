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
 * @param {string} customStart 自定义开始（ISO）
 * @param {string} customEnd   自定义结束（ISO）
 *
 * 界面日期优先：只要开始/结束都有效就按传入区间算（报告类型只是预置方案，
 * 真正的口径以界面上显示并允许修改的日期为准）；缺省时才按类型回退预置。
 */
function resolveRange(type, customStart, customEnd) {
  const valid = (v) => v && !Number.isNaN(Date.parse(v));
  if (valid(customStart) && valid(customEnd)) {
    let start = new Date(customStart);
    let end = new Date(customEnd);
    if (start > end) [start, end] = [end, start]; // 容错：反了就交换
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

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
    start = new Date(now); start.setHours(0, 0, 0, 0);
  }
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

const TYPE_TEXT = { day: '日报', week: '周报', month: '月报', custom: '报告' };

/** 归一化分组筛选：单个 id / id 数组 / null → id 数组（空数组代表全部分组） */
function normalizeGroupIds(param) {
  const raw = param && Array.isArray(param.groupIds)
    ? param.groupIds
    : (param != null && param.groupId != null ? [param.groupId] : []);
  return raw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

/** 分组 id 数组 → 展示用名称（空数组 = 全部） */
function groupNamesText(ids) {
  if (!ids.length) return '全部';
  const names = ids.map((id) => (db.getGroup(id) && db.getGroup(id).name) || '').filter(Boolean);
  return names.length ? names.join('、') : '全部';
}

function buildLocalReport(type, start, end, groupIds) {
  const s = start.toISOString();
  const e = end.toISOString();
  const { completedTasks, createdTasks, activeNow, overdue } = db.rangeStats(s, e, groupIds);

  const groupName = groupNamesText(groupIds);
  const header = `# ${TYPE_TEXT[type] || '工作报告'}（${fmtDateShort(s)} ~ ${fmtDateShort(e)}）`;
  const range = `- 统计范围：${fmtDate(start.toISOString())} 至 ${fmtDate(end.toISOString())}`;

  const totalDone = completedTasks.length;
  const totalCreated = createdTasks.length;
  const subDone = completedTasks.filter((t) => t.parent_id != null).length;
  const subCreated = createdTasks.filter((t) => t.parent_id != null).length;
  // 子任务可能来自更早的周期（父任务早已创建），比例只作参考，封顶 100%
  const rate = totalCreated > 0 ? Math.min(100, Math.round((totalDone / totalCreated) * 100)) : 100;

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
  lines.push(`- 本周期完成任务：**${totalDone}** 项（含子任务 ${subDone} 项）`);
  lines.push(`- 本周期新建任务：**${totalCreated}** 项（含子任务 ${subCreated} 项）`);
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
    // 主任务 + 其子任务嵌套列出；父任务不在本周期清单里的子任务，标注归属单独列
    const printed = new Set();
    for (const t of completedTasks) {
      if (t.parent_id != null) continue;
      printed.add(t.id);
      const tag = t.priority >= 2 ? `【${PRIORITY_LABEL[t.priority]}优先】` : '';
      lines.push(`- [x] ${tag}${t.title}${t.completed_at ? `（${fmtDate(t.completed_at)}）` : ''}`);
      for (const c of completedTasks) {
        if (c.parent_id !== t.id) continue;
        printed.add(c.id);
        lines.push(`  - [x] ${c.title}${c.completed_at ? `（${fmtDate(c.completed_at)}）` : ''}`);
      }
    }
    for (const t of completedTasks) {
      if (printed.has(t.id)) continue;
      const pt = parentTitleOf(t);
      lines.push(`- [x] ${t.title}${pt ? `（属父任务：${pt}）` : ''}${t.completed_at ? `（${fmtDate(t.completed_at)}）` : ''}`);
    }
  }
  lines.push('');

  lines.push('## 二、进行中 / 未完成');
  const activeTop = activeNow.filter((t) => t.parent_id == null);
  if (activeTop.length === 0) {
    lines.push('当前没有进行中的任务。');
  } else {
    for (const t of activeTop) {
      const due = t.plan_end ? ` 截止 ${t.plan_end}` : '';
      lines.push(`- [ ] ${t.title}（${PRIORITY_LABEL[t.priority]}）${due}`);
      for (const c of activeNow) {
        if (c.parent_id !== t.id) continue;
        const cdue = c.plan_end ? ` 截止 ${c.plan_end}` : '';
        lines.push(`  - [ ] ${c.title}${cdue}`);
      }
    }
  }
  lines.push('');

  lines.push('## 三、逾期提醒');
  if (overdue.length === 0) {
    lines.push('暂无逾期任务。');
  } else {
    for (const t of overdue) {
      const pt = parentTitleOf(t);
      lines.push(`- ⚠ ${t.title}${pt ? `（属父任务：${pt}）` : ''}（应于 ${t.plan_end} 前完成）`);
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

/** 父任务标题（子任务归属说明用）；无父任务 / 父任务已删时返回空 */
function parentTitleOf(t) {
  if (t.parent_id == null) return '';
  const p = db.getTask(t.parent_id);
  return p ? p.title : '';
}

function buildPrompt({ type, start, end, groupIds, data, extraPrompt }) {
  const { completedTasks, createdTasks, activeNow, overdue } = data;

  // 子任务挂到父任务下：清单带层级，模型才能数对条目、写出真实的工作明细
  const childrenOf = (list, parentId) => list.filter((t) => t.parent_id === parentId);

  const completedTitles = [];
  for (const t of completedTasks) {
    if (t.parent_id != null) continue; // 子任务跟随父任务输出，孤儿在下面兜底
    completedTitles.push({
      title: t.title,
      priority: PRIORITY_LABEL[t.priority],
      completedAt: fmtDate(t.completed_at),
      // 计划完成时间一并给出：用户常要求「按计划完成时间推演下月计划」
      planStart: t.plan_start || '',
      planEnd: t.plan_end || '',
      subtasks: childrenOf(completedTasks, t.id).map((c) => ({
        title: c.title,
        completedAt: fmtDate(c.completed_at),
      })),
    });
  }
  // 孤儿子任务：父任务不在本周期完成清单里（更早完成），单独带上归属说明，数量才对得上
  for (const c of completedTasks) {
    if (c.parent_id == null) continue;
    if (completedTasks.some((p) => p.id === c.parent_id)) continue;
    completedTitles.push({
      title: c.title,
      priority: PRIORITY_LABEL[c.priority],
      completedAt: fmtDate(c.completed_at),
      planStart: '',
      planEnd: '',
      subtasks: [],
      parentTitle: parentTitleOf(c),
    });
  }

  const activeTitles = activeNow
    .filter((t) => t.parent_id == null)
    .map((t) => ({
      title: t.title,
      priority: PRIORITY_LABEL[t.priority],
      planStart: t.plan_start || '',
      due: t.plan_end || '',
      subtasks: childrenOf(activeNow, t.id).map((c) => ({
        title: c.title,
        due: c.plan_end || '',
      })),
    }));

  const overdueTitles = overdue.map((t) => ({
    title: t.title,
    due: t.plan_end,
    parentTitle: parentTitleOf(t),
  }));

  // 用户自定义要求（原样追加，不做改写，避免曲解）
  const extra = String(extraPrompt || '').trim().slice(0, 600);
  const createdSubs = createdTasks.filter((t) => t.parent_id != null).length;

  const userMsg = [
    `请基于以下本地待办数据生成一份中文${TYPE_TEXT[type] || '工作报告'}。`,
    `时间范围：${fmtDate(start.toISOString())} 至 ${fmtDate(end.toISOString())}`,
    `分组：${groupNamesText(groupIds)}`,
    '',
    `【本周期已完成任务】${JSON.stringify(completedTitles)}`,
    `【本周期新建任务数量】${createdTasks.length}${createdSubs ? `（其中子任务 ${createdSubs} 个）` : ''}`,
    `【当前进行中任务】${JSON.stringify(activeTitles)}`,
    `【逾期任务】${JSON.stringify(overdueTitles)}`,
    '',
    '要求：使用 Markdown 格式；包含「完成情况」「进行中」「问题与风险」「下一步计划」四部分；',
    '条目数量必须与数据一致：已完成条目按主任务 + 其 subtasks 逐条列出，不要合并或省略；',
    '语言简洁专业，基于真实数据，不要编造不存在的内容；结尾给出 2-3 条可执行的下一步建议。',
  ];

  if (extra) {
    userMsg.push('');
    userMsg.push('【用户额外要求（务必满足）】');
    userMsg.push(extra);
    userMsg.push('请在不违背真实数据的前提下满足上述额外要求；如需新增章节（例如「下月计划」），'
      + '直接追加对应 Markdown 章节并用列表或表格呈现，不要省略。');
  }

  return [
    { role: 'system', content: '你是一名专业的工作助理，擅长根据待办数据撰写简洁、专业、有洞察力的中文工作报告。' },
    { role: 'user', content: userMsg.join('\n') },
  ];
}

/**
 * 生成报告。
 * @param {object} params { type, customStart, customEnd, groupId }
 * @param {object} aiConfig { baseUrl, apiKey, model }
 * @returns {Promise<{ markdown, degraded, reason }>}
 */
async function generateReport(params, aiConfig) {
  const { type, customStart, customEnd } = params;
  const extraPrompt = String(params.extraPrompt || '').trim();
  const groupIds = normalizeGroupIds(params);
  const { start, end } = resolveRange(type, customStart, customEnd);
  const s = start.toISOString();
  const e = end.toISOString();
  const data = db.rangeStats(s, e, groupIds);

  if (!aiConfig || !aiConfig.apiKey) {
    let markdown = buildLocalReport(type, start, end, groupIds);
    if (extraPrompt) {
      // 本地模板是规则生成，无法理解自由文本要求 —— 明确说明，避免用户以为已生效
      markdown += `\n> 说明：本次为本地模板报告，未能应用自定义要求「${extraPrompt}」。`
        + '在顶部菜单栏「AI 设置」中配置 API Key 后，该要求会随请求一起发送给 AI。\n';
    }
    return {
      markdown,
      degraded: true,
      reason: '未配置 AI API Key，已生成本地模板报告。前往「AI 报告」页配置 API Key 后即可获得更自然的智能报告。',
    };
  }

  try {
    const markdown = await callLLM({
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      model: aiConfig.model,
      messages: buildPrompt({ type, start, end, groupIds, data, extraPrompt }),
    });
    return { markdown, degraded: false, reason: '' };
  } catch (err) {
    return {
      markdown: buildLocalReport(type, start, end, groupIds),
      degraded: true,
      reason: `AI 调用失败：${err.message}。已降级为本地模板报告。`,
    };
  }
}

module.exports = { generateReport, buildLocalReport, buildPrompt, resolveRange, TYPE_TEXT };
