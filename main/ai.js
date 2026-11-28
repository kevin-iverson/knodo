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

const dateU = require('./date-utils');

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

/**
 * 流式调用大模型（SSE）。供 AI 报告使用：每拿到一段 delta 就通过 onChunk 推送，
 * 并在结束时把服务商返回的 usage（若支持）一并返回，用于 token / 费用统计。
 *
 * 与 callLLM 的关系：callLLM 保持原样给检索总结、润色、识图等调用方用，
 * 避免这些功能被流式协议改造波及。这里只多开一条流式通道。
 *
 * @param {object} opts { baseUrl, apiKey, model, messages, temperature?, timeoutMs?, onChunk?, signal? }
 * @returns {Promise<{content:string, usage:{promptTokens:number,completionTokens:number,totalTokens:number}|null}>}
 */
async function callLLMStream({
  baseUrl, apiKey, model, messages, temperature = 0.4, timeoutMs = 60000,
  onChunk = null, signal = null,
}) {
  if (!apiKey) throw new Error('NO_API_KEY');
  if (!baseUrl) throw new Error('未配置 AI 接口地址');

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 外部取消（用户点「停止生成」）与内部超时共用同一个 AbortController
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const send = (chunk) => {
    if (typeof onChunk !== 'function') return;
    try { onChunk(chunk); } catch (e) { /* 推送失败不能中断生成本身 */ }
  };
  const post = (body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  try {
    // stream_options 让兼容 OpenAI 的服务商在末尾附带 usage；部分网关不认这个字段，
    // 收到明确的「未知参数」400 时去掉它再发一次，不能因为统计把生成本身弄失败。
    let res = await post({ model, messages, temperature, stream: true, stream_options: { include_usage: true } });
    if (res.status === 400) {
      const preview = await res.text().catch(() => '');
      if (/stream_options|unknown parameter|unrecognized|unsupported parameter/i.test(preview)) {
        res = await post({ model, messages, temperature, stream: true });
      } else {
        throw new Error(`AI 接口请求失败（HTTP ${res.status}）：${preview.slice(0, 300)}`);
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI 接口请求失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('AI 接口未返回流式内容');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let usage = null;

    const handleData = (payload) => {
      const line = String(payload).trim();
      if (!line || line === '[DONE]') return;
      let json;
      try { json = JSON.parse(line); } catch (e) { return; } // 心跳 / 注释行直接忽略
      if (json.usage) {
        usage = {
          promptTokens: Number(json.usage.prompt_tokens) || 0,
          completionTokens: Number(json.usage.completion_tokens) || 0,
          totalTokens: Number(json.usage.total_tokens) || 0,
        };
      }
      const delta = json.choices && json.choices[0] && json.choices[0].delta
        ? json.choices[0].delta.content : '';
      if (delta) {
        content += delta;
        send({ type: 'delta', text: delta });
      }
    };
    const drain = (text, final = false) => {
      let buf = text;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('data:')) handleData(line.slice(5));
        }
      }
      if (final && buf.trim()) {
        for (const line of buf.split(/\r?\n/)) {
          if (line.startsWith('data:')) handleData(line.slice(5));
        }
      }
      return buf;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = drain(buffer + decoder.decode(value, { stream: true }));
    }
    drain(buffer, true);
    if (!content.trim()) throw new Error('AI 接口返回内容为空');
    send({ type: 'done', usage });
    return { content: content.trim(), usage };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const canceled = !!(signal && signal.aborted);
      const err = new Error(canceled ? '生成已取消' : 'AI 接口请求超时');
      err.code = canceled ? 'CANCELED' : 'TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
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

/* ============================ 视觉模型（截图识别） ============================ */

/**
 * 视觉模型预设：只列**确定能看图**的模型。
 *
 * 与对话模型分成两份目录，是因为这两件事的选型标准完全不同：对话看语言质量与价格，
 * 识图只看"能不能吃 image_url"。混在一起就会出现"在视觉分区里选了个文本模型"，
 * 报错还发生在按了快捷键之后（那时用户已经截完图了）。
 *
 * models[].free 只是给用户看的额度提示，不参与任何逻辑判断。
 */
const VISION_PRESETS = [
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4v-flash', label: 'GLM-4V Flash', free: '免费额度大' },
      { id: 'glm-4v-plus', label: 'GLM-4V Plus', free: '' },
    ],
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-vl-max', label: 'Qwen-VL Max', free: '' },
      { id: 'qwen-vl-plus', label: 'Qwen-VL Plus', free: '' },
      // 原生多模态，名字里没有 vl / vision —— 放在目录里是为了下拉能选到，
      // 但能力判定不依赖它是否在目录里（见下面的 visionCapability）
      { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash（多模态）', free: '' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', free: '' },
      { id: 'gpt-4o', label: 'GPT-4o', free: '' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', free: '' },
      { id: 'gpt-4.1', label: 'GPT-4.1', free: '' },
    ],
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { id: 'Qwen/Qwen2.5-VL-72B-Instruct', label: 'Qwen2.5-VL-72B', free: '' },
      { id: 'Qwen/Qwen2-VL-7B-Instruct', label: 'Qwen2-VL-7B', free: '' },
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [{ id: 'moonshot-v1-8k-vision-preview', label: 'Moonshot 8k Vision', free: '' }],
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    models: [
      { id: 'qwen2.5vl:7b', label: 'Qwen2.5-VL 7B', free: '全程本机' },
      { id: 'llava', label: 'LLaVA', free: '全程本机' },
    ],
  },
];

/** 模型名 → 展示名 / 是否免费额度（回落与自定义模型名都要靠它给文案） */
const VISION_MODEL_MAP = new Map();
VISION_PRESETS.forEach((p) => {
  p.models.forEach((m) => {
    VISION_MODEL_MAP.set(m.id, { label: m.label, free: m.free || '', preset: p.id, presetLabel: p.label });
  });
});

/**
 * 命名习惯兜底：目录里没有的名字（厂商刚出的 / 自建中转 / 私有部署）按名字猜。
 *
 * 注意边界：`\bvl\b` 能命中 qwen-vl-max，但命中不了 qwen3.8-flash 这类名字里
 * 不带 vl / vision 的原生多模态模型。所以这个正则只用来**确认**能读图，
 * 绝不能反过来当"不认识 = 不支持"的证据。
 */
const VISION_NAME_RE = /(\bvl\b|vision|llava|omni|gemini|claude-[34]|gpt-4o|gpt-4\.1|gpt-4-turbo|glm-4v|minicpm-v|step-1v|qwen3\.8-flash)/i;

/**
 * 这个模型能不能吃图片：'yes' = 目录或命名能确认；'unknown' = 没结论。
 *
 * 刻意**没有 'no'**。能力只有服务端说了算：不认识的名字一律放行，让
 * 「测试读图」真发一张 256×256 图片去问 —— 服务端拒绝时再把错误翻译成人话。
 * 老版本把"不认识"当成"不支持"，qwen3.8-flash 因此在配置页就被拦下，
 * 连一次真实请求都没发出去。
 */
function visionCapability(model) {
  const m = String(model || '').trim();
  if (!m) return 'unknown';
  if (VISION_MODEL_MAP.has(m)) return 'yes';
  return VISION_NAME_RE.test(m) ? 'yes' : 'unknown';
}

function modelLabel(model) {
  const m = String(model || '').trim();
  const hit = VISION_MODEL_MAP.get(m);
  return hit ? hit.label : m || '未配置模型';
}

/** 截图识别的系统提示：强调"只提取要动手的事"，并给出日期换算的明确边界 */
const SHOT_SYSTEM_PROMPT = [
  '你是把截图变成待办清单的助手。用户截的可能是聊天记录、邮件、表格、会议白板或网页。',
  '只提取「需要有人动手去做」的事项；纯信息、结论、寒暄、已经完成的事都不要。',
  '硬性要求：',
  '1. 最多 8 条，按紧急 / 重要程度从高到低排序；一件要做的事都没有就返回空数组；',
  '2. title 是一句可执行的动宾短语，不超过 30 字，不要「需要」「记得」这类前缀；',
  '3. note 用一句话补上截图里明确写出的关键信息（时间、对方、金额、编号），没有就留空字符串；',
  '4. priority 只能是 0（低）/ 1（中）/ 2（高）/ 3（紧急）；看不出来就给 1，不要瞎猜；',
  '5. due 是计划完成日期，格式 YYYY-MM-DD：',
  '   截图里明写了日期（如「8月31日前」「2026-09-05 交」）就照写；',
  '   用了「明天」「后天」「本周五」「下周一上午」这类**相对今天**的说法，按末尾给出的今天换算成具体日期；',
  '   「尽快」「这几天」「月底前」这种说不准哪天的填 null —— 绝不自己编一个日子凑数；',
  '6. summary 一句话概括这张图是什么（不超过 40 字）；',
  '7. 只输出 JSON，不要 Markdown 代码块，不要任何解释文字。',
  '输出格式：{"summary":"...","tasks":[{"title":"...","note":"...","priority":1,"due":null}]}',
].join('\n');

/**
 * 兜底提示词：不要求拆出「要动手的事」，而是先把文字读出来，再提炼成一条草稿。
 * 宁可多给一条可编辑的任务，也不要让用户对着「没识别到待办」空手而归。
 */
const OCR_SYSTEM_PROMPT = [
  '你是把截图文字提取成任务的助手。用户截的可能是聊天记录、邮件、表格、会议白板或网页。',
  '请先逐字识别图中所有可见文字；不要编造，不要补全看不清的内容，看不清就写「（看不清）」。',
  '再把文字整理成一条可以执行的任务：',
  '1. title 是一句不超过 24 字的动宾短语；实在看不出动作时，用文字主题做标题；',
  '2. note 用 120 字以内概括关键信息（时间、对方、金额、编号）；',
  '3. text 保留识别到的原文要点，最多 400 字；',
  '4. 图片里一个字都没有时，返回 {"title":"","note":"","text":""}。',
  '5. 只输出 JSON，不要 Markdown 代码块，不要任何解释文字。',
  '输出格式：{"title":"...","note":"...","text":"..."}',
].join('\n');

/**
 * 服务端明确拒绝图片输入时的文案特征。各家不一样，常见的有：
 *   OpenAI / 兼容网关  "Invalid content type. image_url is only supported by certain models."
 *   DashScope          "The model does not support image input."
 *   智谱 / 其它        "model not support image"
 * 命中后翻译成可操作的中文提示；没命中就原样抛出，不掩盖真实的网络 / Key 错误。
 */
const IMAGE_UNSUPPORTED_RE = new RegExp([
  '(does\\s+not|doesn\'?t|not)\\s+support[^.\\n]{0,60}(image|vision|multimodal)',
  'image(_url)?[^.\\n]{0,40}(is\\s+)?not\\s+supported',
  'image(_url)?[^.\\n]{0,40}only\\s+supported',
  'only\\s+supports?\\s+text',
  // DashScope 兼容模式对纯文本 Qwen 传 image_url 时的原话
  'unexpected\\s+item\\s+type\\s+in\\s+content',
  '不支持(?:图片|图像|多模态)',
  '无法识别图片',
].join('|'), 'i');

/**
 * 识图 → 待办数组。
 *
 * 图片走 data URL 而非外链：CSP 与 file:// 都不适合给模型服务商访问本地文件，
 * 各家 OpenAI 兼容接口也都支持 `image_url: { url: 'data:image/jpeg;base64,...' }`。
 *
 * "这个模型吃不吃图"不在这里预判：只有真发出去才知道。服务端明确拒绝时转成
 * NO_VISION，让设置页和确认卡都能给出"去换一个视觉模型"这个唯一正确的下一步。
 * @param {string} dataUrl 'data:image/jpeg;base64,...'
 * @param {{baseUrl:string, apiKey:string, model:string}} cfg
 * @returns {Promise<string>} 模型原文（解析交给 parseShotReply）
 */
async function recognizeTasksFromImage(dataUrl, cfg) {
  if (!dataUrl) throw new Error('没有可识别的图片');
  try {
    return await callLLM({
      ...cfg,
      messages: [
        // 今天日期必须给：提示词要求把「明天 / 本周五」换算成具体日期，
        // 模型自己的"今天"是训练时的旧日期，不喂就会出现差好几年的 due
        { role: 'system', content: `${SHOT_SYSTEM_PROMPT}\n${dateU.todaySentence()}` },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这是我截的一张图，按约定输出 JSON。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.2,
      // 识图比纯文本慢得多：90 秒拿不到就按超时处理，别让用户对着骨架屏干等
      timeoutMs: 90000,
    });
  } catch (e) {
    const raw = String((e && e.message) || '');
    if (IMAGE_UNSUPPORTED_RE.test(raw)) {
      const err = new Error(`「${modelLabel(cfg.model)}」不支持图片输入，请到 设置 → AI 与语音 → 视觉模型 换一个能吃图的模型`);
      err.code = 'NO_VISION';
      err.detail = raw; // 原始报错留给日志 / 排查，不直接糊到卡片上
      throw err;
    }
    throw e;
  }
}

/**
 * 兜底：待办拆不出来时，至少把图里的文字读出来。
 *
 * 触发场景：模型正常回了一张图，但 tasks 是空数组，或者回复不是约定 JSON。
 * 这一步仍然走视觉模型，只是把提示词从「提取待办」换成「逐字识别 + 提炼一条」。
 * 输出一条可编辑的草稿，进确认卡让用户改；绝不直接落库。
 * @param {string} dataUrl
 * @param {{baseUrl:string, apiKey:string, model:string}} cfg
 * @returns {Promise<string>} 模型原文（解析交给 parseTextShotReply）
 */
async function recognizeTextFromImage(dataUrl, cfg) {
  if (!dataUrl) throw new Error('没有可识别的图片');
  try {
    return await callLLM({
      ...cfg,
      messages: [
        { role: 'system', content: OCR_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请识别这张图里的文字，并按约定输出 JSON。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.1,
      timeoutMs: 90000,
    });
  } catch (e) {
    const raw = String((e && e.message) || '');
    if (IMAGE_UNSUPPORTED_RE.test(raw)) {
      const err = new Error(`「${modelLabel(cfg.model)}」不支持图片输入，请到 设置 → AI 与语音 → 视觉模型 换一个能吃图的模型`);
      err.code = 'NO_VISION';
      err.detail = raw;
      throw err;
    }
    throw e;
  }
}

/**
 * 解析识图回复。容错到「从回复里抠出第一个 { ... }」，再把每一条清洗成可直接建任务的结构。
 * 标题为空的行直接丢弃 —— 空标题行提交时本来也要剔除，不如在这里就清掉。
 */
function parseShotReply(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 返回的内容看不懂，请重试');
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error('AI 返回的内容看不懂，请重试');
  }
  const arr = Array.isArray(obj && obj.tasks) ? obj.tasks : [];
  const tasks = arr
    .map((t) => {
      const title = String((t && t.title) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const note = String((t && t.note) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const p = Number(t && t.priority);
      const priority = Number.isFinite(p) ? Math.max(0, Math.min(3, Math.round(p))) : 1;
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String((t && t.due) || '')) ? String(t.due) : '';
      return { title, note, priority, due };
    })
    .filter((t) => t.title)
    .slice(0, 8);
  return {
    summary: String((obj && obj.summary) || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    tasks,
  };
}

/**
 * 解析兜底识别的回复：优先取 JSON；模型没按 JSON 回时，把原文当文字用。
 * 返回 null = 图里确实没字，或模型只回了一句拒绝/道歉，不要硬造任务。
 */
function parseTextShotReply(raw) {
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let obj = {};
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { obj = JSON.parse(text.slice(start, end + 1)); } catch (e) { /* 不是 JSON 就按纯文本处理 */ }
  }

  const body = clean(obj.text || obj.ocr || '').slice(0, 500);
  const note = clean(obj.note || '').slice(0, 200);
  let title = clean(obj.title || '').slice(0, 60);
  let source = body || note;
  if (!source && start < 0) source = clean(text).slice(0, 500);
  if (!source) {
    // 模型只给了标题也算有收获；标题为空才真的没东西可用
    if (title) return { title: title.slice(0, 30), note: '', text: '' };
    return null;
  }

  // 模型拒绝/道歉不当任务；图里只有一两个字的也不算识别成功
  if (/^(抱歉|对不起|无法|不能|sorry|i\s*(can'?t|cannot))/i.test(source)) return null;
  if (source.replace(/\s/g, '').length < 4) return null;

  if (!title) {
    const line = source.split(/[。\n；;]/).map((s) => s.trim()).find((s) => s.length >= 2) || source;
    title = line.replace(/^[\s•·\-–—\d.、)）]+/, '').slice(0, 30);
  }
  if (!title) return null;

  return {
    title: title.slice(0, 30),
    note: (body || note || (start < 0 ? source : '')).slice(0, 300),
    text: source.slice(0, 500),
  };
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
  VISION_PRESETS,
  visionCapability,
  modelLabel,
  recognizeTasksFromImage,
  recognizeTextFromImage,
  parseShotReply,
  parseTextShotReply,
  callLLM,
  callLLMStream,
  testConnection,
  summarizeSearch,
  rankSearchCandidates,
  polishText,
};
