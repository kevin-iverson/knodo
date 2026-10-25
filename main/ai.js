'use strict';
/**
 * AI 接口调用模块。默认对接 OpenAI 兼容的 /chat/completions 协议，
 * 因此可无缝切换 OpenAI / DeepSeek / 通义千问 / Moonshot / Ollama 等。
 *
 * 配置（存于 settings 表，API Key 经 crypto.js 加密）：
 *   ai.baseUrl  接口地址，如 https://api.deepseek.com 或 https://api.openai.com/v1
 *   ai.apiKey   加密后的 API Key
 *   ai.model    模型名，如 deepseek-chat / gpt-4o-mini
 */

const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
};

/** 预设同样用 id 做主键，避免同一 baseUrl 下挂多个模型时联动写错 */
const PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'qwen', label: '通义千问 (兼容)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'ollama', label: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' },
];

/**
 * 调用大模型。
 * @param {object} opts { baseUrl, apiKey, model, messages, temperature }
 * @returns {Promise<string>} 模型回复文本
 */
async function callLLM({ baseUrl, apiKey, model, messages, temperature = 0.4, timeoutMs = 60000 }) {
  if (!apiKey) throw new Error('NO_API_KEY');
  if (!baseUrl) throw new Error('未配置 AI 接口地址');

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI 接口请求失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    if (!content) throw new Error('AI 接口返回内容为空');
    return content.trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI 接口请求超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 简单连通性测试 */
async function testConnection({ baseUrl, apiKey, model }) {
  return callLLM({
    baseUrl,
    apiKey,
    model,
    messages: [
      { role: 'user', content: '请只回复两个字：正常' },
    ],
    temperature: 0,
    timeoutMs: 15000,
  });
}

/** 根据关键词与匹配任务生成检索总结 */
async function summarizeSearch(keyword, tasks, { baseUrl, apiKey, model }) {
  const PRI = ['低', '中', '高', '紧急'];
  const taskList = tasks.map((t) => ({
    title: t.title,
    status: t.completed ? '已完成' : '进行中',
    priority: PRI[t.priority] || '中',
    planEnd: t.plan_end || '',
    tags: t.tag_names || [],
  }));
  const userMsg = [
    `用户检索关键词："${keyword}"，共匹配到 ${tasks.length} 个任务。`,
    '任务列表：',
    JSON.stringify(taskList),
    '',
    '请用简洁的中文总结这些任务的核心内容与关联，给出 3-5 条要点，不要编造任务里不存在的信息。',
  ].join('\n');
  return callLLM({
    baseUrl,
    apiKey,
    model,
    messages: [
      { role: 'system', content: '你是任务检索助手，擅长根据关键词和任务列表生成简洁、准确的检索总结。' },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.3,
  });
}

/**
 * 检索联想的语义重排（可选增强）。
 *
 * 本地引擎（search-assist.js）已经能召回候选，但对"意思相关、字面无关"的查询
 * （例如搜「那个要请客户吃饭的事」，本地一条都命不中）无能为力。这里让模型在
 * **已召回的候选池**里做语义判断 —— 只重排、只剔除，**绝不新增任务**，
 * 从而保证结果不会凭空冒出任务库里不存在的条目。
 *
 * @param {string} keyword 用户关键词
 * @param {Array} candidates 候选池（本地召回的 Top N，或兜底的最近更新任务）
 * @param {object} cfg { baseUrl, apiKey, model }
 * @returns {Promise<Array<{id:number, relevant:boolean, reason:string}>>}
 */
async function rankSearchCandidates(keyword, candidates, { baseUrl, apiKey, model }) {
  if (!candidates.length) return [];
  const list = candidates.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.completed ? '已完成' : (t.archived ? '已归档' : '进行中'),
    group: t.group_name || '',
    planEnd: t.plan_end || '',
    tags: t.tag_names || [],
    desc: (String(t.notes || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 120),
  }));
  const userMsg = [
    `用户想找的关键词："${keyword}"。`,
    '下面是任务库里的候选任务（JSON 数组）：',
    JSON.stringify(list),
    '',
    '请判断每条与用户意图的语义相关程度，按相关性从高到低排序。',
    '硬性要求：',
    '1. 只能评价上面给出的任务，不得新增、不得改写标题；',
    '2. 明显无关的条目直接不输出（不要为了凑数保留）；',
    '3. reason 用一句话说清"为什么认为相关"，指出是从哪个词/语义推出来的；',
    '4. 只输出 JSON 数组，每项形如 {"id":123,"relevant":true,"reason":"..."}，不要任何额外文字。',
  ].join('\n');
  const raw = await callLLM({
    baseUrl,
    apiKey,
    model,
    messages: [
      { role: 'system', content: '你是任务检索的语义匹配助手，只做相关性判断与排序，绝不编造任务。' },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.2,
    // 重排是"锦上添花"，不能让它拖慢检索：20 秒拿不到结果就退回本地排序
    timeoutMs: 20000,
  });
  return parseRankReply(raw, candidates.map((c) => c.id));
}

/** 解析模型返回的 JSON 数组：容错到「从回复里抠出第一个 [ ... ]」，并过滤掉不在候选池里的 id */
function parseRankReply(raw, allowedIds) {
  const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('AI 返回的排序结果格式不可解析');
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`AI 返回的排序结果不是合法 JSON：${e.message}`);
  }
  const allowed = new Set(allowedIds.map(Number));
  return arr
    .filter((x) => x && allowed.has(Number(x.id)))
    .map((x) => ({ id: Number(x.id), relevant: x.relevant !== false, reason: String(x.reason || '').trim() }));
}

/**
 * 润色预设：内置几种常见改写取向，界面上直接下拉选，选中后填进「自定义提示词」可再改。
 * instruction 会作为补充要求拼进用户提示，因此每条都写成一句明确的动作指令。
 */
const POLISH_PRESETS = [
  {
    id: 'default',
    label: '润色优化（推荐）',
    instruction: '在保持原意的前提下重写：理清逻辑顺序，让目标、产出与约束一目了然，去掉口语化赘词。',
  },
  {
    id: 'concise',
    label: '精简压缩',
    instruction: '大幅精简：保留全部事实与结论，删掉重复与修饰，字数尽量压到原文的 60% 以内。',
  },
  {
    id: 'expand',
    label: '扩写细化',
    instruction: '在原文事实基础上适度扩写：补充合理的执行步骤与验收要点，但不要编造原文没有的人名、日期、数字。',
  },
  {
    id: 'checklist',
    label: '转结构化清单',
    instruction: '改写成结构化清单：先一句总述，再用「1. 2. 3.」列出可执行条目，每条一句话、以动词开头。',
  },
  {
    id: 'formal',
    label: '正式汇报口吻',
    instruction: '改写为正式的工作汇报口吻：用词书面、语气客观，适合直接贴进周报或项目文档。',
  },
  {
    id: 'todo',
    label: '拆成待办事项',
    instruction: '拆成可勾选的待办事项：每条一个动作、可独立完成、以动词开头，按执行顺序排列。',
  },
  { id: 'custom', label: '自定义', instruction: '' },
];

/** 润色的系统提示：强调"改写能力"，而不是只做语法校对 */
const POLISH_SYSTEM_PROMPT = [
  '你是资深的任务管理与商务写作助手，擅长把潦草的任务描述改写成可直接执行、可直接汇报的成稿。',
  '工作方式：先理解这段描述要达成的目标、交付物与约束，再动笔重写——必要时重组顺序、合并重复、',
  '拆分长句、补上缺失的上下文衔接，而不是只在原句上改几个词。',
  '硬性约束：',
  '1. 不新增原文没有的事实（人名、日期、数字、结论一律不得编造）；确实缺失时保持原样或概括表述；',
  '2. 保留原文的全部关键信息，删减只针对冗余与口语化表达；',
  '3. 用词准确、句式干脆，避免"应该/可能/大概"这类模糊措辞，除非原文本就是不确定的；',
  '4. 只输出改写后的正文：不要标题、不要"润色如下"之类的前后说明、不要 Markdown 标记；',
  '5. 有序列表用「1. 2. 3.」这样的纯文本序号，不要用 Markdown 的 #、-、* 等符号。',
].join('\n');

/**
 * 润色 / 改写一段任务描述。
 *
 * 与"语法校对"的区别：这里要求模型理解任务意图后重写（结构、条理、可执行性一起优化），
 * 而不是把原句修通顺就算完。默认输出纯文本正文，渲染层可直接回填进所见即所得编辑器。
 * @param {string} text 原文
 * @param {object} cfg { baseUrl, apiKey, model }
 * @param {string} [instruction] 额外的改写要求（预设或用户自定义提示词）
 */
async function polishText(text, cfg, instruction = '') {
  const userMsg = [
    '请改写下面这段任务描述：',
    '',
    '---',
    text,
    '---',
    '',
    instruction ? `本次改写的额外要求（优先级最高，与上述约束冲突时以此为准）：\n${instruction}` : '',
    '输出改写后的正文。',
  ].filter(Boolean).join('\n');
  return callLLM({
    ...cfg,
    messages: [
      { role: 'system', content: POLISH_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.5,
    timeoutMs: 60000,
  });
}

module.exports = {
  DEFAULT_CONFIG,
  PRESETS,
  POLISH_PRESETS,
  callLLM,
  testConnection,
  summarizeSearch,
  rankSearchCandidates,
  polishText,
};
