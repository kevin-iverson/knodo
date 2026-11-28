'use strict';
/**
 * 日报 / 周报 / 月报 生成模块。
 * - 无 API Key 或调用失败时，退化为基于本地数据的规则生成（本地报告），并附带降级提示。
 * - 配置了 API Key 时，将本地任务数据组装为 Prompt 交给大模型生成更自然的报告。
 */
const db = require('./db');
const { callLLM, callLLMStream } = require('./ai');

const PRIORITY_TEXT = ['低', '中', '高', '紧急'];
const PRIORITY_LABEL = { 0: '低', 1: '中', 2: '高', 3: '紧急' };

/** 提示词版本号：随 prompt 结构变更手动递增，写入报告元数据，便于事后按版本归因质量 */
const PROMPT_VERSION = '2.0-data-enriched';
/** 描述进入 prompt 的最大长度：单条 160 字，防止描述过长把上下文撑爆 / 抬高成本 */
const NOTE_MAX = 160;
/** 流式调用失败后的重试次数（不含首次）：只对网络抖动 / 超时这类瞬时错误重试 */
const LLM_MAX_ATTEMPTS = 2;

/**
 * 内置输出模板：每个模板只描述「章节结构 + 给模型的写法要求」，不绑定具体任务数据。
 * 自定义模板走同一份契约（{id,name,description,sections,instruction}），由渲染层传来后
 * 经 normalizeOutputTemplate 校验，因此新增模板不需要改数据库或 IPC。
 */
const OUTPUT_TEMPLATES = [
  {
    id: 'standard', name: '标准四段式', builtin: true,
    description: '完成情况 / 进行中 / 问题与风险 / 下一步计划',
    sections: ['完成情况', '进行中', '问题与风险', '下一步计划'],
    instruction: '使用 Markdown；包含「完成情况」「进行中」「问题与风险」「下一步计划」四部分；'
      + '结尾给出 2-3 条可执行的下一步建议。',
  },
  {
    id: 'brief', name: '极简日报', builtin: true,
    description: '今日完成 / 进行中 / 阻碍 / 明日计划，每部分不超过 5 条',
    sections: ['今日完成', '进行中', '阻碍', '明日计划'],
    instruction: '使用 Markdown；只保留「今日完成」「进行中」「阻碍」「明日计划」四部分；'
      + '每部分最多 5 条，每条一句话，语气精炼，不要写空话。',
  },
  {
    id: 'okr', name: 'OKR 进展', builtin: true,
    description: '目标进展 / 关键结果 / 风险与阻塞 / 下一步行动',
    sections: ['目标进展', '关键结果', '风险与阻塞', '下一步行动'],
    instruction: '使用 Markdown；按「目标进展」「关键结果」「风险与阻塞」「下一步行动」组织；'
      + '每个目标先写结论再列证据，风险要写清影响与需要的支持。',
  },
  {
    id: 'review', name: '复盘分析', builtin: true,
    description: '数据概览 / 做得好的 / 待改进 / 行动计划',
    sections: ['数据概览', '做得好的', '待改进', '行动计划'],
    instruction: '使用 Markdown；按「数据概览」「做得好的」「待改进」「行动计划」组织；'
      + '数据概览先给完成数/新建数/完成率/逾期数，分析要基于任务数据而非空泛评价。',
  },
  {
    id: 'upward', name: '向上汇报', builtin: true,
    description: '核心结论 / 关键进展 / 风险与资源需求 / 下阶段计划',
    sections: ['核心结论', '关键进展', '风险与资源需求', '下阶段计划'],
    instruction: '使用 Markdown；按「核心结论」「关键进展」「风险与资源需求」「下阶段计划」组织；'
      + '开篇先给 1-2 句结论，风险与资源需求要具体到任务与截止时间。',
  },
  {
    id: 'charts', name: '多图表分析', builtin: true,
    description: '数据概览 + 至少 3 张 Mermaid 图 + 图表解读 + 风险建议',
    sections: ['数据概览', '分组完成占比图', '优先级分布图', '任务时间线图', '图表解读', '风险与建议'],
    instruction: '使用 Markdown；按上述章节组织；必须插入至少 3 个 mermaid 代码块：'
      + '①pie 展示分组完成占比；②pie 展示任务优先级分布；③gantt 展示逾期与进行中任务时间线（dateFormat YYYY-MM-DD）。'
      + '每块前写一句数据来源说明，块后用 1-2 句解读；数值必须与统计一致，不要编造。',
  },
];

/** 内置模板列表（返回副本，调用方改动不会污染注册表） */
function listOutputTemplates() {
  return OUTPUT_TEMPLATES.map((t) => JSON.parse(JSON.stringify(t)));
}

/** 校验渲染层传来的模板；自定义模板走同一份字段契约，非法内容直接回落默认模板 */
function normalizeOutputTemplate(t) {
  if (!t || typeof t !== 'object') return null;
  const name = String(t.name || '').trim().slice(0, 40);
  const instruction = String(t.instruction || '').trim().slice(0, 600);
  if (!name || !instruction) return null;
  const sections = Array.isArray(t.sections)
    ? t.sections.map((s) => String(s == null ? '' : s).trim().slice(0, 30)).filter(Boolean).slice(0, 8)
    : [];
  return {
    id: String(t.id || `custom-${Date.now()}`).slice(0, 60),
    name,
    description: String(t.description || '').trim().slice(0, 120),
    sections,
    instruction,
    builtin: !!t.builtin,
  };
}

/** 解析本次生成使用的模板：id 命中内置优先，否则按自定义模板校验 */
function resolveOutputTemplate(t) {
  if (!t || typeof t !== 'object') return OUTPUT_TEMPLATES[0];
  const built = OUTPUT_TEMPLATES.find((x) => x.id === t.id);
  return built || normalizeOutputTemplate(t) || OUTPUT_TEMPLATES[0];
}

/**
 * 任务描述 → 可进 prompt 的纯文本摘要。
 * 描述来自富文本编辑器，可能带 HTML 标签；去标签、压空白、截断，避免脏数据挤占上下文。
 */
function noteSummary(notes) {
  return String(notes == null ? '' : notes)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_MAX);
}

/**
 * 报告调用产出的元数据（写入 reports 表，供历史详情展示 / 质量归因 / 成本核算）。
 * 字段与 db.js REPORT_FIELDS 的元数据列一一对应。
 */
function emptyMeta(aiConfig) {
  return {
    model: aiConfig && aiConfig.model ? String(aiConfig.model) : '',
    temperature: 0.4,
    prompt_version: PROMPT_VERSION,
    tokens: 0,
    duration_ms: 0,
    degraded_reason: '',
  };
}

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

/** 分组 id 数组 → 展示用完整路径（空数组 = 全部）；同名分组靠「父 / 子」路径区分 */
function groupNamesText(ids) {
  if (!ids.length) return '全部';
  const { pathOf } = buildGroupPaths();
  const names = ids.map((id) => groupLabelOf(Number(id), pathOf));
  return names.length ? names.join('、') : '全部';
}

/**
 * 历史记录里存的分组标签（"项目管理 / 问题项、数据管理 / 问题项"）。
 * 只存 id 数组看不出当时筛了什么，只存叶子名又会把同名分组写成一模一样的两个词，
 * 所以统一在主进程按 id + 完整路径生成，界面不再自己拼。
 */
function groupLabelForHistory(ids) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (!list.length) return '全部分组';
  const { pathOf } = buildGroupPaths();
  return list.map((id) => groupLabelOf(id, pathOf)).join('、');
}

/**
 * 分组 id → 完整路径（"项目管理 / 问题项"）。
 *
 * 为什么必须按 id + 路径：分组名的唯一性只在**同一父级**内生效（db.groupNameTaken 的作用域），
 * 「项目管理 / 问题项」与「数据管理 / 问题项」是两个不同 id 的合法分组。任何按名字聚合
 * 或只写叶子名的展示，都会把跨模块的同名分组悄悄合并成一条。
 * 一次取全表建 Map，避免每个任务都查一次库。
 */
function buildGroupPaths() {
  const nodes = new Map(db.listGroups().map((g) => [Number(g.id), g]));
  const pathOf = (id) => {
    if (id == null) return '';
    const parts = [];
    let cur = nodes.get(Number(id));
    let guard = 0;
    while (cur && guard++ < 32) { // 防御历史脏数据成环
      parts.unshift(cur.name);
      cur = cur.parent_id == null ? null : nodes.get(Number(cur.parent_id));
    }
    return parts.join(' / ');
  };
  return { pathOf };
}

/** 展示用分组文案：null → 未分组；id 已失效（历史脏数据）→ 标出来，别静默并进其它分组 */
function groupLabelOf(gid, pathOf) {
  if (gid == null) return '未分组';
  return pathOf(gid) || `已删除分组#${gid}`;
}

/** 任务的实际归属分组：自身 group_id 优先；子任务为空时继承父任务（历史数据/手动改过父分组会留 NULL） */
function taskGroupId(t) {
  if (!t) return null;
  if (t.group_id != null) return Number(t.group_id);
  if (t.parent_id != null) {
    const p = db.getTask(t.parent_id);
    if (p && p.group_id != null) return Number(p.group_id);
  }
  return null;
}

/**
 * 降级模板的「智能小结」：按完成率 + 逾期 + 高优先级三个维度动态生成建议，
 * 取代原来只有三档的固定话术，让没配 Key 的用户也拿到有信息量的结论。
 */
function smartLocalSummary({ rate, overdueCount, highActiveCount, totalDone }) {
  const parts = [];
  if (rate >= 80) parts.push(`本周期完成率 ${rate}%，节奏良好。`);
  else if (rate >= 50) parts.push(`本周期完成率 ${rate}%，整体尚可但仍有提升空间。`);
  else parts.push(`本周期完成率 ${rate}%，完成节奏偏慢。`);
  if (overdueCount > 0) parts.push(`有 ${overdueCount} 项任务已逾期，建议优先清理风险项。`);
  if (highActiveCount > 0) parts.push(`进行中还有 ${highActiveCount} 项高优先级任务，建议集中资源推进。`);
  if (totalDone === 0) parts.push('本周期暂无完成任务，建议先拆解出可快速完成的小任务启动节奏。');
  if (parts.length === 1) parts.push('请保持当前节奏，持续跟进进行中任务。');
  return parts.join('');
}

/**
 * 解析本地模板能「看懂」的自定义要求关键词，返回可执行的增强项。
 * 本地模板是规则生成，不可能像 LLM 那样理解自由文本；这里只承诺能可靠兑现的几类要求，
 * 剩余部分在报告末尾诚实说明，避免用户误以为都生效了。
 * @param {string} extraPrompt
 * @param {object} ctx { overdue, activeNow, completedTasks, groupIds }
 * @returns {{ sections: string[], applied: string[], unmatched: string }}
 */
function applyLocalExtras(extraPrompt, ctx) {
  const text = String(extraPrompt || '').trim();
  if (!text) return { sections: [], applied: [], unmatched: '' };
  const sections = [];
  const applied = [];
  const { overdue, activeNow, completedTasks } = ctx;

  // 意图 1：风险 / 问题用表格 —— 规则生成完全能兑现，把逾期 + 高优先级未完成列成表
  if (/风险|问题|逾期/.test(text) && /表格|表$|列/.test(text)) {
    const rows = [
      ...overdue.map((t) => ['逾期', t.title, t.plan_end || '-']),
      ...activeNow.filter((t) => t.priority >= 2 && t.parent_id == null)
        .map((t) => ['高优先级进行中', t.title, t.plan_end || '-']),
    ];
    // 用户点名要「表格」：即使没有风险项也保留表头，用一行占位说明，不能偷偷退化成一句话
    sections.push('## 五、问题与风险（表格）\n'
      + '| 类型 | 任务 | 截止 |\n| --- | --- | --- |\n'
      + (rows.length
        ? rows.map(([k, title, due]) => `| ${k} | ${String(title).replace(/\|/g, '\\|')} | ${due} |`).join('\n')
        : '| 无 | 本周期无逾期或高优先级风险项 | - |'));
    applied.push('用表格列出问题与风险');
  }

  // 意图 2：下一步 / 下月计划 —— 基于进行中与逾期任务生成可执行的待办建议
  if (/下一步|下月|下个?月|计划|建议/.test(text)) {
    const picks = [
      ...overdue.slice(0, 3).map((t) => `优先处理逾期任务「${t.title}」`),
      ...activeNow.filter((t) => t.parent_id == null && t.priority >= 2).slice(0, 3)
        .map((t) => `推进高优先级任务「${t.title}」${t.plan_end ? `（计划 ${t.plan_end} 前完成）` : ''}`),
    ];
    if (!picks.length && completedTasks.length) {
      picks.push('延续本周期节奏，为下周期拆解新的可执行任务');
    }
    sections.push('## 六、下一步计划\n'
      + (picks.length ? picks.map((p, i) => `${i + 1}. ${p}`).join('\n') : '当前没有需要推进的任务，请补充新的工作计划。'));
    applied.push('生成下一步计划');
  }

  // 意图 3：强调优先级 —— 在已完成清单里按优先级重排展示
  if (/优先级|按重要|重要程度/.test(text)) {
    const highDone = completedTasks.filter((t) => t.priority >= 2);
    if (highDone.length) {
      sections.push('## 七、高优先级完成项\n'
        + highDone.map((t) => `- 【${PRIORITY_LABEL[t.priority]}】${t.title}`).join('\n'));
      applied.push('突出高优先级完成项');
    }
  }

  // 判断是否有「没能理解」的内容：
  // 规则只覆盖三类意图（风险表格 / 下一步计划 / 高优先级）。若一个意图都没命中，
  // 整句都算未应用；若命中了，就只把「时间推演、对比、分析」这类明确不支持的语义词
  // 挑出来提示，其余一律认为已被覆盖。这样避免复杂的中文分词，也避免误报
  // （用户要表格，我们给了表格，就不该再说"未能应用"）。
  const UNSUPPORTED = /(完成)?时间|推演|对比|同比|环比|趋势|分析|复盘|总结|原因是|为什么|估算|预测|同比/;
  let unmatched = '';
  if (!applied.length) {
    unmatched = text; // 一个意图都没命中：整句如实告知未应用
  } else {
    const m = text.match(UNSUPPORTED);
    if (m) unmatched = m[0];
  }
  return { sections, applied, unmatched };
}

/** Mermaid 标签清洗：pie / gantt 对引号、冒号、括号敏感，脏标题会让整张图画不出来 */
function mermaidLabel(v) {
  return String(v == null ? '未命名' : v)
    .replace(/["':\[\]{}()<>|\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24) || '未命名';
}

/**
 * 多图表模板的本地降级数据：不依赖 LLM，按真实任务统计生成 Mermaid 饼图 / 甘特图。
 * AI 可用时由 prompt 让模型按同一结构输出；没配 Key 时这里保证仍有图可看。
 */
function localChartBlocks({ byGroup, completedTasks, activeNow, overdue, endIso }) {
  const lines = [];
  const groups = Array.from(byGroup.values()).filter((g) => g.count > 0).slice(0, 8);
  if (groups.length) {
    lines.push('### 分组完成占比图');
    lines.push('```mermaid');
    lines.push('pie title 分组完成占比');
    for (const g of groups) lines.push(`    "${mermaidLabel(g.label)}" : ${g.count}`);
    lines.push('```');
    lines.push('');
  }

  const priorityCounts = [0, 0, 0, 0];
  for (const t of [...completedTasks, ...activeNow]) {
    const p = Math.max(0, Math.min(3, Number(t.priority) || 0));
    priorityCounts[p] += 1;
  }
  if (priorityCounts.some((n) => n > 0)) {
    lines.push('### 优先级分布图');
    lines.push('```mermaid');
    lines.push('pie title 任务优先级分布');
    priorityCounts.forEach((n, i) => {
      if (n > 0) lines.push(`    "${PRIORITY_LABEL[i]}" : ${n}`);
    });
    lines.push('```');
    lines.push('');
  }

  const timelineMap = new Map();
  for (const t of [...overdue, ...activeNow.filter((x) => x.parent_id == null)]) {
    if (timelineMap.has(t.id)) continue;
    const raw = String(t.plan_end || '');
    const date = /^\d{4}-\d{2}-\d{2}/.test(raw)
      ? raw.slice(0, 10)
      : String(endIso || '').slice(0, 10);
    timelineMap.set(t.id, {
      label: `${overdue.some((o) => o.id === t.id) ? '逾期·' : ''}${mermaidLabel(t.title)}`,
      state: overdue.some((o) => o.id === t.id) ? 'crit' : 'active',
      date,
    });
  }
  const timeline = Array.from(timelineMap.values()).slice(0, 8);
  if (timeline.length) {
    lines.push('### 逾期与进行中任务时间线');
    lines.push('```mermaid');
    lines.push('gantt');
    lines.push('    title 逾期与进行中任务时间线');
    lines.push('    dateFormat YYYY-MM-DD');
    for (const t of timeline) lines.push(`    ${t.label} :${t.state}, ${t.date}, 3d`);
    lines.push('```');
    lines.push('');
  }
  return lines;
}

function buildLocalReport(type, start, end, groupIds, extraPrompt = '', outputTemplate = null) {
  const template = resolveOutputTemplate(outputTemplate);
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

  // 按分组汇总完成情况：键必须是分组 id。
  // 名称只在同一父级内唯一（跨级可同名），用名称当键会把「项目管理 / 问题项」和
  // 「数据管理 / 问题项」合成一行；展示一律用「父 / 子」完整路径区分同名分组。
  const { pathOf } = buildGroupPaths();
  const byGroup = new Map(); // key = group_id 字符串（未分组用 'none'），保持首次出现顺序
  for (const t of completedTasks) {
    const gid = taskGroupId(t);
    const key = gid == null ? 'none' : String(gid);
    const cur = byGroup.get(key) || { id: gid, label: groupLabelOf(gid, pathOf), count: 0 };
    cur.count += 1;
    byGroup.set(key, cur);
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
    for (const { label, count } of byGroup.values()) {
      lines.push(`- ${label}：${count} 项`);
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
  const highActiveCount = activeNow.filter((t) => t.priority >= 2 && t.parent_id == null).length;
  lines.push(smartLocalSummary({
    rate, overdueCount: overdue.length, highActiveCount, totalDone,
  }));
  lines.push('');

  // 降级模板的自定义要求：能可靠兑现的意图直接追加章节，剩余部分诚实说明未应用
  const extraText = String(extraPrompt || '').trim();
  if (extraText) {
    const { sections, applied, unmatched } = applyLocalExtras(extraText, {
      overdue, activeNow, completedTasks, groupIds,
    });
    for (const section of sections) { lines.push(section); lines.push(''); }
    if (applied.length) {
      lines.push(`> 已应用自定义要求：${applied.join('、')}。`);
    }
    if (unmatched) {
      lines.push(`> 说明：本次为本地模板报告，未能应用自定义要求「${unmatched}」。`
        + '在顶部菜单栏「AI 设置」中配置 API Key 后，完整要求会随请求一起发送给 AI。');
    }
    lines.push('');
  }

  // 输出模板：本地降级无法像 AI 那样自由重组章节，但至少把模板章节结构写清楚，
  // 用户能看到「这次用的是哪套模板 / AI 会按什么结构输出」。
  if (template.id !== 'standard') {
    if (template.id === 'charts') {
      lines.push('## 附：可视化图表（本地自动生成）');
      lines.push(...localChartBlocks({ byGroup, completedTasks, activeNow, overdue, endIso: e }));
      lines.push('> 以上图表由本地模板按真实任务数据生成；配置 API Key 后，AI 会按同一结构补充图表解读。');
      lines.push('');
    }
    lines.push('## 附：本次输出模板');
    lines.push(`- 模板：${template.name}`);
    lines.push(`- 目标章节：${template.sections.map((s, i) => `${i + 1}. ${s}`).join('；')}`);
    lines.push('> 当前为本地模板报告；配置 API Key 后，AI 会严格按上述章节结构生成。');
    lines.push('');
  }

  return lines.join('\n');
}

/** 父任务标题（子任务归属说明用）；无父任务 / 父任务已删时返回空 */
function parentTitleOf(t) {
  if (t.parent_id == null) return '';
  const p = db.getTask(t.parent_id);
  return p ? p.title : '';
}

function buildPrompt({ type, start, end, groupIds, data, extraPrompt, outputTemplate }) {
  const { completedTasks, createdTasks, activeNow, overdue } = data;
  const template = resolveOutputTemplate(outputTemplate);

  // 分组归属必须逐条给到模型：报告里可能同时出现两个同名分组（如「项目管理 / 问题项」与
  // 「数据管理 / 问题项」），只给表头一串分组名，模型只能按标题猜 —— 跨模块错归就是这么来的。
  const { pathOf } = buildGroupPaths();
  const groupOf = (t) => groupLabelOf(taskGroupId(t), pathOf);

  // 数据面扩展：把任务描述与标签一并喂给模型，报告才有「做了什么细节 / 属于哪类工作」的依据。
  // 一次批量取全部相关任务的标签，避免逐条查库；描述只做摘要，控制长度与成本。
  const allTasks = [...completedTasks, ...createdTasks, ...activeNow, ...overdue];
  const tagsOfTask = db.tagNamesByTaskIds(allTasks.map((t) => t.id));
  const extrasOf = (t) => {
    const note = noteSummary(t.notes);
    const tags = tagsOfTask.get(Number(t.id)) || [];
    return {
      ...(note ? { note } : {}),
      ...(tags.length ? { tags } : {}),
    };
  };

  // 子任务挂到父任务下：清单带层级，模型才能数对条目、写出真实的工作明细
  const childrenOf = (list, parentId) => list.filter((t) => t.parent_id === parentId);

  const completedTitles = [];
  for (const t of completedTasks) {
    if (t.parent_id != null) continue; // 子任务跟随父任务输出，孤儿在下面兜底
    completedTitles.push({
      title: t.title,
      group: groupOf(t),
      priority: PRIORITY_LABEL[t.priority],
      completedAt: fmtDate(t.completed_at),
      // 计划完成时间一并给出：用户常要求「按计划完成时间推演下月计划」
      planStart: t.plan_start || '',
      planEnd: t.plan_end || '',
      ...extrasOf(t),
      subtasks: childrenOf(completedTasks, t.id).map((c) => ({
        title: c.title,
        group: groupOf(c),
        completedAt: fmtDate(c.completed_at),
        ...extrasOf(c),
      })),
    });
  }
  // 孤儿子任务：父任务不在本周期完成清单里（更早完成），单独带上归属说明，数量才对得上
  for (const c of completedTasks) {
    if (c.parent_id == null) continue;
    if (completedTasks.some((p) => p.id === c.parent_id)) continue;
    completedTitles.push({
      title: c.title,
      group: groupOf(c),
      priority: PRIORITY_LABEL[c.priority],
      completedAt: fmtDate(c.completed_at),
      planStart: '',
      planEnd: '',
      ...extrasOf(c),
      subtasks: [],
      parentTitle: parentTitleOf(c),
    });
  }

  const activeTitles = activeNow
    .filter((t) => t.parent_id == null)
    .map((t) => ({
      title: t.title,
      group: groupOf(t),
      priority: PRIORITY_LABEL[t.priority],
      planStart: t.plan_start || '',
      due: t.plan_end || '',
      ...extrasOf(t),
      subtasks: childrenOf(activeNow, t.id).map((c) => ({
        title: c.title,
        group: groupOf(c),
        due: c.plan_end || '',
        ...extrasOf(c),
      })),
    }));

  const overdueTitles = overdue.map((t) => ({
    title: t.title,
    group: groupOf(t),
    due: t.plan_end,
    ...extrasOf(t),
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
    '数据字段说明：note 是任务描述摘要、tags 是任务标签，可在报告中用来补充每条任务的背景与归类；'
      + '字段不存在时表示任务没有填写，不要编造。',
    `【输出模板：${template.name}】${template.instruction}`,
    `章节结构：${template.sections.map((s, i) => `${i + 1}. ${s}`).join('；')}。`,
    '条目数量必须与数据一致：已完成条目按主任务 + 其 subtasks 逐条列出，不要合并或省略；',
    '分组归属只看每个条目的 group 字段（「上级 / 下级」完整路径）：数据里可能存在同名分组，'
      + '必须靠完整路径区分，不得把条目挪到别的分组，也不得把不同分组下的同名条目合并成一条；',
    '语言简洁专业，基于真实数据，不要编造不存在的内容；严格按上面的输出模板组织章节。',
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
 * @param {object} params { type, customStart, customEnd, groupId, extraPrompt, outputTemplate }
 * @param {object} aiConfig { baseUrl, apiKey, model }
 * @param {object} [hooks] { onProgress?(evt) } 进度回调：流式片段 / 重试 / 耗时，由 IPC 推给渲染层
 * @returns {Promise<{ markdown, degraded, reason, meta }>}
 */
async function generateReport(params, aiConfig, hooks = {}) {
  const startedAt = Date.now();
  const { type, customStart, customEnd } = params;
  const extraPrompt = String(params.extraPrompt || '').trim();
  // 输出模板：UI 已取消自定义要求输入框，但保留 extraPrompt 兼容历史脚本 / 旧缓存
  const outputTemplate = params.outputTemplate || null;
  const groupIds = normalizeGroupIds(params);
  const { start, end } = resolveRange(type, customStart, customEnd);
  const s = start.toISOString();
  const e = end.toISOString();
  const data = db.rangeStats(s, e, groupIds);
  const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
  const meta = emptyMeta(aiConfig);

  // 生成一个对进度的本地包装：所有事件带阶段，渲染层据此决定「追加文字 / 显示提示 / 收尾」
  const emit = (phase, payload = {}) => {
    onProgress({ phase, ...payload });
  };

  if (!aiConfig || !aiConfig.apiKey) {
    let markdown = buildLocalReport(type, start, end, groupIds, extraPrompt, outputTemplate);
    const reason = '未配置 AI API Key，已生成本地模板报告。前往「AI 报告」页配置 API Key 后即可获得更自然的智能报告。';
    meta.degraded_reason = reason;
    meta.duration_ms = Date.now() - startedAt;
    emit('degraded', { reason });
    return { markdown, degraded: true, reason, meta };
  }

  const messages = buildPrompt({ type, start, end, groupIds, data, extraPrompt, outputTemplate });
  // 流式请求 - 重试循环：只有「瞬时错误」才重试，重试前清空已推给界面的半截内容。
  // 取消（CANCELED）是用户主动行为，不重试、不降级，直接抛出让上层收尾。
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    let partial = '';
    try {
      emit('attempt', { attempt, max: LLM_MAX_ATTEMPTS });
      const result = await callLLMStream({
        baseUrl: aiConfig.baseUrl,
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        messages,
        onChunk: (chunk) => {
          if (chunk.type === 'delta') {
            partial += chunk.text;
            emit('delta', { text: chunk.text });
          }
        },
        signal: hooks.signal || null,
      });
      meta.tokens = result.usage ? result.usage.totalTokens : 0;
      meta.duration_ms = Date.now() - startedAt;
      emit('done', { tokens: meta.tokens, durationMs: meta.duration_ms });
      return { markdown: result.content, degraded: false, reason: '', meta };
    } catch (err) {
      if (err && err.code === 'CANCELED') throw err;
      const retryable = err && (err.code === 'TIMEOUT' || /timeout|超时|fetch failed|ECONNRESET|ETIMEDOUT|502|503|504/i.test(err.message || ''));
      if (retryable && attempt < LLM_MAX_ATTEMPTS) {
        emit('retry', { attempt, reason: err.message });
        partial = '';
        continue;
      }
      // 不可重试 / 重试耗尽：降级本地模板，但把错误原因和元数据一并带回，事后可追溯
      const reason = `AI 调用失败${attempt > 1 ? `（已重试 ${attempt - 1} 次）` : ''}：${err.message}。已降级为本地模板报告。`;
      const markdown = buildLocalReport(type, start, end, groupIds, extraPrompt, outputTemplate);
      meta.degraded_reason = reason;
      meta.duration_ms = Date.now() - startedAt;
      emit('degraded', { reason });
      return { markdown, degraded: true, reason, meta };
    }
  }
  // 理论上不会走到这里（循环内必定 return 或 throw），保底降级
  const reason = 'AI 调用失败，已降级为本地模板报告。';
  const markdown = buildLocalReport(type, start, end, groupIds, extraPrompt, outputTemplate);
  meta.degraded_reason = reason;
  meta.duration_ms = Date.now() - startedAt;
  emit('degraded', { reason });
  return { markdown, degraded: true, reason, meta };
}

module.exports = {
  generateReport, buildLocalReport, buildPrompt, resolveRange, TYPE_TEXT, groupLabelForHistory,
  PROMPT_VERSION, noteSummary,
  OUTPUT_TEMPLATES, listOutputTemplates, normalizeOutputTemplate,
};
