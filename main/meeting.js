'use strict';
/**
 * 会议纪要生成：把 ASR 转写稿整理成结构化纪要，并提取可执行的待办清单。
 *
 * 设计要点：
 * 1) 分两步而不是一步到位——先出「纪要正文」，再基于纪要（而非原始转写稿）提取待办。
 *    原始稿动辄上万字，两步都喂全文会让 token 翻倍；基于已提炼的纪要提取待办既省钱也更准。
 * 2) 长会议走 map-reduce：按顺序切成若干段 → 每段提炼要点 → 合并成最终纪要，
 *    避免单次请求超出模型上下文，也避免「只记得开头」的截断问题。
 * 3) 模型输出的 JSON 不做天真 JSON.parse：先剥掉 ```json 代码块，再截取首尾括号做兜底。
 */

const ai = require('./ai');

/** 单次送入模型的转写正文上限（字符）。超出则分段处理 */
const CHUNK_LIMIT = 12000;
/** 分段摘要后合并时再触发一次总结的最大正文上限 */
const REDUCE_LIMIT = 24000;
/** 提取待办时送入的纪要上限（纪要通常远小于此，保险用） */
const TODO_INPUT_LIMIT = 12000;

const SUMMARY_SYSTEM = [
  '你是一位资深的会议记录员，擅长把口语化的会议转写稿整理成结构清晰、可直接存档的中文会议纪要。',
  '严格遵守以下要求：',
  '- 只依据给定内容作答，绝不编造未出现的事实、人名或数字；信息不足时明确写「未提及」。',
  '- 使用中文，语气客观精炼，避免空话套话。',
  '- 直接输出 Markdown，**不要**把整篇包在代码块里。',
].join('\n');

function para(text) {
  return String(text || '').trim();
}

/** 把转写稿切成不超过 CHUNK_LIMIT 的若干段，优先在句子/换行边界处断开 */
function splitTranscript(text, limit = CHUNK_LIMIT) {
  const src = para(text);
  if (src.length <= limit) return [src];
  const chunks = [];
  let buf = '';
  const pieces = src.split(/(?<=[。！？!?\n])/);
  for (const piece of pieces) {
    if (buf.length + piece.length > limit && buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
    buf += piece;
  }
  if (buf.trim()) chunks.push(buf);
  return chunks.length ? chunks : [src.slice(0, limit)];
}

function meetingHeader(meta = {}) {
  const mins = Math.max(0, Math.round((Number(meta.durationMs) || 0) / 60000));
  const timeText = meta.startedAt ? String(meta.startedAt).replace('T', ' ').slice(0, 16) : '未知';
  return [
    `会议标题：${meta.title || '未命名会议'}`,
    `开始时间：${timeText}`,
    `时长：${mins} 分钟`,
    `采集方式：${meta.mode === 'screen' ? '屏幕 + 音频' : '仅音频'}${meta.sourceLabel ? `（${meta.sourceLabel}）` : ''}`,
  ].join('\n');
}

function summaryPrompt({ transcript, meta, part }) {
  const partNote = part ? `\n本次送入的是整场会议的第 ${part.index}/${part.total} 段。**只提炼该段落的要点**，不要尝试总结全局。` : '';
  return [
    '请基于下面的会议转写稿，输出结构化中文纪要。',
    '',
    '【元信息】',
    meetingHeader(meta),
    partNote,
    '',
    '【格式要求】',
    '## 会议主题',
    '一句话说明这场会议讨论什么。',
    '',
    '## 关键议题与结论',
    '按议题分点列出，每个议题一行「议题名 → 结论/进展」。没有结论的标注「待定」。',
    '',
    '## 决议事项',
    '已明确拍板的事项，附决策依据。没有则写「无」。',
    '',
    '## 待办事项',
    '每条一行：事项 — 负责人 — 截止时间（原文没提就写「未指定」）。',
    '',
    '## 风险与遗留问题',
    '尚未解决或需要跟进的阻碍。没有则写「无」。',
    '',
    '【转写稿】',
    transcript,
  ].join('\n');
}

const REDUCE_INSTRUCTION = [
  '下面是同一场会议的分段纪要，请把它们合并为**一份**完整纪要，去重、消除「第 x 段」这类分段痕迹，',
  '严格按下述结构输出（不要包裹代码块）：',
  '',
  '## 会议主题',
  '## 关键议题与结论',
  '## 决议事项',
  '## 待办事项（每行：事项 — 负责人 — 截止时间）',
  '## 风险与遗留问题',
  '',
  '【分段纪要】',
].join('\n');

const TODO_SCHEMA = [
  '{"todos":[{"title":"动词开头的短句，不超过 30 字","assignee":"负责人，未知填 未指定","due":"YYYY-MM-DD，未知填空字符串","priority":0,"detail":"一两句说明验收标准或上下文","evidence":"依据原文的原话摘要，20 字内"}]}',
].join('');

const TODO_SYSTEM = [
  '你是项目经理，负责把会议纪要里的行动项拆成可执行的任务卡。',
  '输出**严格合法**的 JSON（UTF-8，无任何 Markdown 标记、无注释、无尾随逗号），结构如下：',
  TODO_SCHEMA,
  'priority 取值：0=低，1=中，2=高，3=紧急；无法判断时给 1。',
  '规则：',
  '- 只提取确实需要有人动手去做的事项，纯讨论/背景信息不要提取；',
  '- 不要把已经完成的事当作待办；',
  '- 没有待办就返回 {"todos":[]}；',
  '- due 必须是 YYYY-MM-DD 格式，无法确定日期请填空字符串，不要猜测。',
].join('\n');

/** 从模型输出里稳健地取出 JSON（支持 ```json 代码块与前后口水话） */
function extractJson(raw) {
  let s = para(raw);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    // 兜底：截到第一个 { 与最后一个 } 之间
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start > -1 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) { /* 落到下一步 */ }
    }
    const bs = s.indexOf('[');
    const be = s.lastIndexOf(']');
    if (bs > -1 && be > bs) {
      try { return JSON.parse(s.slice(bs, be + 1)); } catch (e3) { /* 放弃 */ }
    }
    return null;
  }
}

/** 清洗单条待办：字段缺失补默认值，日期格式非法丢弃 */
function normalizeTodo(t, index) {
  const title = para(t && t.title);
  if (!title) return null;
  const due = para(t.due);
  const validDue = /^\d{4}-\d{2}-\d{2}$/.test(due) && !Number.isNaN(Date.parse(due)) ? due : '';
  const rawPri = Number(t.priority);
  return {
    id: `t${index + 1}`,
    title: title.slice(0, 80),
    assignee: para(t.assignee) || '未指定',
    due: validDue,
    priority: Number.isFinite(rawPri) && rawPri >= 0 && rawPri <= 3 ? Math.round(rawPri) : 1,
    detail: para(t.detail).slice(0, 300),
    evidence: para(t.evidence).slice(0, 120),
  };
}

/**
 * 生成会议纪要 markdown。
 * @param {object} opts { transcript, meta, config }
 * @returns {Promise<string>}
 */
async function summarize({ transcript, meta = {}, config }) {
  const text = para(transcript);
  if (!text) throw new Error('转写文本为空，无法生成纪要');
  if (!config || !config.apiKey) throw new Error('NO_API_KEY');

  if (text.length <= CHUNK_LIMIT) {
    return ai.callLLM({
      ...config,
      temperature: 0.3,
      timeoutMs: 180000,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: summaryPrompt({ transcript: text, meta }) },
      ],
    });
  }

  // map-reduce：长会议分段提炼后合并
  const chunks = splitTranscript(text);
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    /* eslint-disable no-await-in-loop */
    const part = await ai.callLLM({
      ...config,
      temperature: 0.3,
      timeoutMs: 180000,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: summaryPrompt({ transcript: chunks[i], meta, part: { index: i + 1, total: chunks.length } }) },
      ],
    });
    partials.push(`--- 第 ${i + 1}/${chunks.length} 段 ---\n${part}`);
  }
  const merged = para(partials.join('\n\n'));
  const input = merged.length > REDUCE_LIMIT ? merged.slice(0, REDUCE_LIMIT) : merged;
  return ai.callLLM({
    ...config,
    temperature: 0.3,
    timeoutMs: 180000,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `${REDUCE_INSTRUCTION}\n${input}` },
    ],
  });
}

/**
 * 基于纪要提取可执行待办。
 * @returns {Promise<Array<object>>}
 */
async function extractTodos({ summary, config }) {
  const doc = para(summary);
  if (!doc) return [];
  if (!config || !config.apiKey) throw new Error('NO_API_KEY');
  const input = doc.length > TODO_INPUT_LIMIT ? doc.slice(0, TODO_INPUT_LIMIT) : doc;
  const raw = await ai.callLLM({
    ...config,
    temperature: 0,
    timeoutMs: 120000,
    messages: [
      { role: 'system', content: TODO_SYSTEM },
      { role: 'user', content: `【会议纪要】\n${input}` },
    ],
  });
  const data = extractJson(raw);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.todos) ? data.todos : []);
  const out = [];
  list.forEach((t, i) => {
    const n = normalizeTodo(t, i);
    if (n) out.push(n);
  });
  // 去重：标题相同只保留第一条
  const seen = new Set();
  return out.filter((t) => {
    const k = t.title.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 一步到位：生成纪要 + 待办。
 * @returns {Promise<{summary:string, todos:Array<object>}>}
 */
async function processMeeting({ transcript, meta, config }) {
  const summary = await summarize({ transcript, meta, config });
  let todos = [];
  try {
    todos = await extractTodos({ summary, config });
  } catch (e) {
    // 待办抽取失败不应让整份纪要作废
    console.error('[meeting] 待办提取失败：', e && e.message);
  }
  return { summary, todos };
}

module.exports = {
  CHUNK_LIMIT,
  summarize,
  extractTodos,
  processMeeting,
  extractJson,
  splitTranscript,
  normalizeTodo,
};
