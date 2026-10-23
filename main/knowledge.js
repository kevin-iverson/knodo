'use strict';
/**
 * 知识库：把笔记沉淀成可检索的分块，并提供「AI 提问」的召回 + 组装能力。
 *
 * 分层（与 docs/AI知识库问答与任务引用集成方案.md §3 的 v10 表结构一致）：
 *   笔记 notes  ──► 知识库文档 kb_documents(source_key='note:<id>')  ──► 分块 kb_chunks ──► FTS5
 * 分块与向量都是派生数据，可随时由 notes 重建，因此不进导入导出。
 *
 * 本模块不依赖 Electron（只依赖 db / ai），可在 Node 下直接跑冒烟测试。
 */
const db = require('./db');
const ai = require('./ai');

/** 内置笔记知识库 id（迁移 v10 里固定为 1） */
const NOTES_KB_ID = 1;
/** 分块目标大小 / 重叠（字符数；中文按字算，1 字≈1 token 的量级足够做粗切） */
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;
/** 默认召回条数与上下文总字符上限（防止把提示词撑爆） */
const DEFAULT_TOP_K = 8;
const MAX_CONTEXT_CHARS = 6000;

/**
 * Markdown → 分块。
 * 策略：先按 ATX 标题切「章节」，章节过长再按段落滑窗切分（带重叠）；
 * 每个块带上 heading_path（如「安装 › 常见问题」）——召回时拼到块首能显著提升命中率。
 * @param {string} md 正文
 * @param {string} [title] 笔记标题（作为路径根节点）
 * @returns {Array<{ord:number, kind:'heading'|'body'|'table'|'code', headingPath:string, content:string}>}
 */
function chunkMarkdown(md, title = '') {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let headingStack = [];
  let buf = [];
  let inCode = false;

  const pushSection = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    sections.push({ headingPath: headingStack.join(' › '), text });
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      buf.push(line);
      continue;
    }
    if (inCode) { buf.push(line); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      pushSection();
      const level = h[1].length;
      headingStack = headingStack.slice(0, level - 1);
      headingStack[level - 1] = h[2].trim();
      buf.push(line); // 标题本身留在块首，语义更完整
      continue;
    }
    buf.push(line);
  }
  pushSection();

  const chunks = [];
  const root = String(title || '').trim();
  const fullPath = (p) => (root ? (p ? `${root} › ${p}` : root) : p || '');

  sections.forEach((sec, si) => {
    const path = fullPath(sec.headingPath);
    const isTable = /^\s*\|.*\|\s*$/.test(sec.text.split('\n')[0] || '');
    const isCode = /^\s*```/.test(sec.text.trim());
    const kind = isTable ? 'table' : isCode ? 'code' : sec.headingPath ? 'heading' : 'body';
    const text = sec.text;

    if (text.length <= CHUNK_SIZE) {
      chunks.push({ ord: chunks.length, kind, headingPath: path, content: text });
      return;
    }
    // 长章节：按段落滑窗（空行视为段落边界），相邻块保留重叠，避免关键词被切断
    const paras = text.split(/\n{2,}/);
    let cur = '';
    for (const p of paras) {
      if (cur && (cur.length + p.length + 2) > CHUNK_SIZE) {
        chunks.push({ ord: chunks.length, kind, headingPath: path, content: cur.trim() });
        const tail = cur.slice(-CHUNK_OVERLAP);
        cur = `${tail}\n\n${p}`;
      } else {
        cur = cur ? `${cur}\n\n${p}` : p;
      }
    }
    if (cur.trim()) chunks.push({ ord: chunks.length, kind, headingPath: path, content: cur.trim() });
    void si;
  });

  return chunks;
}

/**
 * 索引单篇笔记（保存 / 恢复 / 重建时调用）。
 * @param {number} noteId
 * @returns {{indexed:boolean, docId?:number, chunkCount?:number, reason?:string}}
 */
function indexNote(noteId) {
  const note = db.getNote(noteId);
  if (!note) return { indexed: false, reason: 'missing' };
  // 回收站里的笔记不参与检索：内容还在，但索引必须摘掉
  if (note.deleted_at) {
    db.deleteKbDocBySourceKey(`note:${noteId}`);
    return { indexed: false, reason: 'trashed' };
  }
  db.ensureNotesKb();
  const doc = db.upsertKbDocument({
    kbId: NOTES_KB_ID,
    sourceKey: `note:${noteId}`,
    title: note.title,
    kind: 'md',
    size: Buffer.byteLength(String(note.content_md || '')),
    contentHash: note.content_hash,
    status: 'indexed',
  });
  const chunkCount = db.replaceKbChunks(doc.id, chunkMarkdown(note.content_md, note.title));
  return { indexed: true, docId: doc.id, chunkCount };
}

/**
 * 全量重建笔记知识库（导入备份后 / 手动「重建索引」）。
 * @returns {{total:number, done:number, chunks:number}}
 */
function indexAll() {
  db.ensureNotesKb();
  const all = db.listNotes({ deleted: 'exclude', archived: 'include', limit: 100000 });
  let done = 0;
  let chunks = 0;
  for (const n of all) {
    const r = indexNote(n.id);
    if (r.indexed) { done += 1; chunks += r.chunkCount || 0; }
  }
  db.syncKbCounts(NOTES_KB_ID);
  return { total: all.length, done, chunks };
}

/** 从索引里移除一篇笔记（进回收站 / 彻底删除时调用） */
function removeNote(noteId) {
  return db.deleteKbDocBySourceKey(`note:${noteId}`);
}

/* ------------------------------ 查询理解 ------------------------------ */

/** 取 query 的二元组集合（中文没有空格分词，二元组是最划算的字面重叠特征） */
function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/[\s，。、；：！？,.:;!?()（）「」【】]/g, '');
  const out = new Set();
  if (!t) return out;
  if (t.length === 1) { out.add(t); return out; }
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/** 字面覆盖率：query 的二元组有多少出现在文本里（0~1），用于给「同一路召回内部」排优先级 */
function coverageOf(query, text) {
  const bg = bigrams(query);
  if (!bg.size) return 0;
  const lower = String(text || '').toLowerCase();
  let hit = 0;
  bg.forEach((g) => { if (lower.includes(g)) hit += 1; });
  return hit / bg.size;
}

const EXPAND_SYSTEM_PROMPT = [
  '你是检索助手。用户会给一个问题，请把它改写成更适合关键词检索的查询词。',
  '要求：',
  '1. 输出 3-5 个查询词，覆盖原问题的同义说法、核心实体、以及拆分后的子问题；',
  '2. 每个查询词 2-12 个字，不要带解释、不要带序号；',
  '3. 只输出 JSON 数组，例如 ["灰度发布", "放量策略", "回滚方案"]；',
  '4. 无法确定时至少原样返回原问题。',
].join('\n');

/** 从模型回复里取出字符串数组（容忍 Markdown 代码围栏 / 逐行输出 / 带序号） */
function parseListReply(raw) {
  const text = String(raw || '').trim();
  const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = block ? block[1] : text;
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter(Boolean);
  } catch (e) { /* 不是 JSON，走逐行兜底 */ }
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•\d]+[.、)]?\s*/, '').replace(/^["'「]|["'」]$/g, '').trim())
    .filter(Boolean);
}

/**
 * 查询改写 / 关键词扩展：配了 AI 就让它给出同义与拆分后的查询词，多路召回能显著捞回
 * 「说法不同但语义相同」的笔记；没配 AI 或调用失败就原样单路召回（降级不影响可用性）。
 * @returns {Promise<string[]>} 查询词列表（首个永远是原始问题）
 */
async function expandQuery(query, cfg = {}) {
  const q = String(query || '').trim();
  const base = q ? [q] : [];
  if (!q || !cfg || !cfg.apiKey) return base;
  try {
    const raw = await ai.callLLM({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages: [
        { role: 'system', content: EXPAND_SYSTEM_PROMPT },
        { role: 'user', content: `问题：${q}` },
      ],
      temperature: 0.2,
      timeoutMs: 12000,
    });
    const list = parseListReply(raw).filter((x) => x.length >= 2 && x.length <= 40);
    const merged = [];
    for (const x of [q, ...list]) {
      if (!merged.some((m) => m === x)) merged.push(x);
    }
    return merged.slice(0, 5);
  } catch (e) {
    return base;
  }
}

/* ------------------------------ 召回 ------------------------------ */

/** RRF（Reciprocal Rank Fusion）常数：名次越靠前收益越大，且不受各路分数量纲影响 */
const RRF_K = 60;

/** 笔记级召回：先命中「哪篇笔记相关」，再取它的前几个分块 —— 补 FTS5 逐块匹配的视野盲区 */
function noteLevelChunks(keyword, kbId, limit = 2) {
  const notes = db.searchNotes(keyword, { limit: 8, deleted: 'exclude', archived: 'include' });
  const out = [];
  for (const n of notes) {
    const rows = db.listKbChunksBySourceKey(`note:${n.id}`, limit);
    rows.forEach((r) => out.push(r));
  }
  return out;
}

function toHit(r) {
  return {
    chunkId: r.chunkId,
    noteId: parseNoteId(r.sourceKey),
    title: r.title || '',
    headingPath: r.headingPath || '',
    content: String(r.content || ''),
    score: 0,
  };
}

/**
 * 智能召回：查询改写 → 多路召回（分块 FTS / 笔记级 / LIKE 兜底）→ RRF 融合 → AI 重排。
 *
 * 为什么要多路：FTS5 trigram 只认字面连续片段，「上次那个回滚方案」这类口语化提问命中率很差；
 * 先让模型改写成若干查询词，再分别从「分块」与「笔记」两个粒度召回，最后用 RRF 融合名次
 * （避免直接相加不同量纲的分数），配了 AI 时再让模型对候选做一次语义重排。
 *
 * @param {object} opts { query, topK, kbId, noteIds, cfg }
 * @returns {Promise<Array>} hits（含 score / matchedBy / coverage 便于界面展示命中原因）
 */
async function retrieve({ query, topK = DEFAULT_TOP_K, kbId = NOTES_KB_ID, noteIds = null, cfg = {} } = {}) {
  const k = Number(topK) > 0 ? Number(topK) : DEFAULT_TOP_K;
  const q = String(query || '').trim();
  if (!q) return [];
  const variants = await expandQuery(q, cfg);
  const allowed = Array.isArray(noteIds) && noteIds.length ? new Set(noteIds.map(Number)) : null;

  const pool = new Map(); // chunkId → { hit, rrf, routes:Set }
  const pushRoute = (rows, name, weight) => {
    rows.forEach((r, idx) => {
      const noteId = parseNoteId(r.sourceKey);
      if (allowed && (noteId == null || !allowed.has(noteId))) return;
      const hit = toHit(r);
      const cur = pool.get(hit.chunkId);
      if (cur) {
        cur.rrf += weight / (RRF_K + idx + 1);
        cur.routes.add(name);
        return;
      }
      pool.set(hit.chunkId, { hit, rrf: weight / (RRF_K + idx + 1), routes: new Set([name]) });
    });
  };

  const wide = Math.max(k * 4, 16);
  for (const v of variants) {
    pushRoute(db.searchKbChunks({ query: v, kbId, topK: wide }), v.length >= 3 ? 'fts' : 'like', 1);
    pushRoute(noteLevelChunks(v, kbId, 2), 'note', 0.8);
  }

  // 融合分 = RRF 名次分 + 字面覆盖 + 标题/路径命中 + 同笔记多块的递减
  let ranked = [...pool.values()].map((e) => {
    const cov = coverageOf(q, `${e.hit.title}\n${e.hit.headingPath}\n${e.hit.content}`);
    const titleHit = e.hit.title && q && String(e.hit.title).toLowerCase().includes(q.toLowerCase()) ? 0.08 : 0;
    const pathHit = e.hit.headingPath && coverageOf(q, e.hit.headingPath) > 0.5 ? 0.04 : 0;
    const score = e.rrf + cov * 0.35 + titleHit + pathHit;
    return { ...e.hit, score, coverage: cov, matchedBy: [...e.routes].join('+') };
  }).sort((a, b) => b.score - a.score);

  // AI 语义重排：只在候选足够多时做，失败/超时就沿用融合分（降级不影响可用性）
  const order = await rerankWithAI(q, ranked.slice(0, Math.min(ranked.length, 12)), cfg);
  if (order && order.length) {
    const picked = [];
    const rest = ranked.slice();
    for (const idx of order) {
      const h = ranked[idx];
      if (!h) continue;
      picked.push({ ...h, score: h.score + 0.25, reranked: true });
      const pos = rest.findIndex((x) => x.chunkId === h.chunkId);
      if (pos >= 0) rest.splice(pos, 1);
    }
    ranked = [...picked, ...rest];
  }

  // 同一篇笔记最多保留 2 个块：既保证多样性，又不让长笔记刷屏
  const perNote = new Map();
  const out = [];
  for (const h of ranked) {
    const key = h.noteId == null ? `chunk-${h.chunkId}` : `note-${h.noteId}`;
    const c = perNote.get(key) || 0;
    if (c >= 2) continue;
    perNote.set(key, c + 1);
    out.push({ ...h, score: c === 0 ? h.score : h.score * 0.7 });
    if (out.length >= k) break;
  }
  return out;
}

const RERANK_SYSTEM_PROMPT = [
  '你是检索重排器。根据用户问题给候选片段按相关度从高到低排序。',
  '只输出编号序列（JSON 数组），例如 [3,1,2]；不要输出其它内容。',
  '只保留确实相关的编号，完全无关的可以省略。',
].join('\n');

/** 解析模型给出的编号序列（容忍 [1,2] / 1,2,3 / 逐行输出） */
function parseIndexReply(raw, max) {
  const text = String(raw || '').trim();
  const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = block ? block[1] : text;
  let nums = [];
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) nums = parsed.map((x) => Number(x));
  } catch (e) {
    nums = (body.match(/\d+/g) || []).map(Number);
  }
  return nums
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= max)
    .map((n) => n - 1)
    .filter((n, i, arr) => arr.indexOf(n) === i);
}

/**
 * AI 重排：让模型对候选片段做一次语义排序（关键词召回捞得全，但排序不一定贴合语义）。
 * @returns {Promise<number[]|null>} 候选下标顺序；不可用 / 失败时返回 null
 */
async function rerankWithAI(query, cands, cfg = {}) {
  if (!cfg || !cfg.apiKey || !cands.length || cands.length < 3) return null;
  const list = cands.map((h, i) => {
    const head = `[${i + 1}] ${h.title}${h.headingPath ? ` › ${h.headingPath}` : ''}`;
    const body = String(h.content || '').replace(/\s+/g, ' ').slice(0, 140);
    return `${head}\n${body}`;
  }).join('\n');
  try {
    const raw = await ai.callLLM({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages: [
        { role: 'system', content: RERANK_SYSTEM_PROMPT },
        { role: 'user', content: `问题：${query}\n\n候选：\n${list}` },
      ],
      temperature: 0,
      timeoutMs: 20000,
    });
    const order = parseIndexReply(raw, cands.length);
    return order.length ? order : null;
  } catch (e) {
    return null;
  }
}

function parseNoteId(sourceKey) {
  const m = /^note:(\d+)$/.exec(String(sourceKey || ''));
  return m ? Number(m[1]) : null;
}

/**
 * 把召回片段拼成给模型的上下文（带 [n] 编号，模型据此引用）。
 * @param {Array} hits
 * @param {number} maxChars
 * @returns {string}
 */
function buildContext(hits, maxChars = MAX_CONTEXT_CHARS) {
  const parts = [];
  let used = 0;
  hits.forEach((h, i) => {
    const head = `[${i + 1}] ${h.title}${h.headingPath ? ` › ${h.headingPath}` : ''}`;
    const body = h.content.length > 1200 ? `${h.content.slice(0, 1200)}…` : h.content;
    const block = `${head}\n${body}`;
    if (used + block.length > maxChars) return;
    used += block.length;
    parts.push(block);
  });
  return parts.join('\n\n');
}

const QA_SYSTEM_PROMPT = [
  '你是本地知识库问答助手，只能依据「资料」回答用户问题。',
  '硬性要求：',
  '1. 答案里的每个结论都要用 [编号] 标注依据来源，编号对应资料条目；',
  '2. 资料里没有的内容直接说"知识库里没有相关信息"，绝不编造；',
  '3. 用简洁中文作答，优先给结论，再给 2-4 条要点；',
  '4. 不要复述问题，不要输出"根据资料"这类套话。',
].join('\n');

/**
 * 知识库问答（AI 检索的接入入口）。
 * 无 AI 配置时降级为「只返回召回片段」，界面照常展示出处——不让功能整个不可用。
 * @param {object} opts { question, cfg:{baseUrl,apiKey,model}, topK, noteIds }
 * @returns {Promise<{answer:string, hits:Array, degraded:boolean, reason?:string}>}
 */
async function answer({ question, cfg = {}, topK = DEFAULT_TOP_K, noteIds = null } = {}) {
  const q = String(question || '').trim();
  if (!q) return { answer: '', hits: [], degraded: true, reason: 'empty' };
  const hasAi = !!(cfg && cfg.apiKey);
  const hits = await retrieve({ query: q, topK, noteIds, cfg });
  const meta = { reranked: hits.some((h) => h.reranked) };
  if (!hits.length) return { answer: '', hits: [], degraded: true, reason: 'no-hit', meta };
  if (!hasAi) {
    return { answer: '', hits, degraded: true, reason: 'no-ai', meta };
  }
  const context = buildContext(hits);
  try {
    const text = await ai.callLLM({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages: [
        { role: 'system', content: QA_SYSTEM_PROMPT },
        { role: 'user', content: `资料：\n${context}\n\n问题：${q}` },
      ],
      temperature: 0.2,
      timeoutMs: 60000,
    });
    return { answer: text, hits, degraded: false, meta };
  } catch (e) {
    return { answer: '', hits, degraded: true, reason: (e && e.message) || 'AI 调用失败', meta };
  }
}

module.exports = {
  NOTES_KB_ID,
  DEFAULT_TOP_K,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  chunkMarkdown,
  indexNote,
  indexAll,
  removeNote,
  expandQuery,
  rerankWithAI,
  retrieve,
  buildContext,
  answer,
};
