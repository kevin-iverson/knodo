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
 * 润色一段任务描述。
 * 约束写死在提示里：保持原意、不编造信息、只输出正文（不带 Markdown 标记），
 * 这样渲染层可以把结果直接回填进所见即所得编辑器。
 */
async function polishText(text, { baseUrl, apiKey, model }, instruction = '') {
  const userMsg = [
    '请润色下面这段任务描述：',
    '要求：',
    '1. 保持原意与既有事实不变，不新增原文里没有的信息；',
    '2. 语句通顺、条理清晰、用词简洁；',
    '3. 保留原有条目结构（有分点就继续分点，用「1. 2. 3.」而不是 Markdown 符号）；',
    '4. 只输出润色后的正文，不要标题、不要前后说明、不要 Markdown 标记。',
    instruction ? `5. 补充要求：${instruction}` : '',
    '',
    '---',
    text,
  ].filter((x) => x !== null).join('\n');
  return callLLM({
    baseUrl,
    apiKey,
    model,
    messages: [
      { role: 'system', content: '你是中文写作助手，擅长在严格保持原意的前提下润色任务描述。' },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.4,
    timeoutMs: 60000,
  });
}

module.exports = { DEFAULT_CONFIG, PRESETS, callLLM, testConnection, summarizeSearch, polishText };
