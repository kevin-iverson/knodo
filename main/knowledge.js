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

/**
 * 召回：关键词（FTS5 trigram）→ 分块 → 按笔记聚合并裁剪到 TopK。
 * @param {object} opts { query, topK, kbId, noteIds }
 * @returns {Array<{noteId:number|null, title:string, headingPath:string, content:string, score:number, chunkId:number}>}
 */
function retrieve({ query, topK = DEFAULT_TOP_K, kbId = NOTES_KB_ID, noteIds = null } = {}) {
  const k = Number(topK) > 0 ? Number(topK) : DEFAULT_TOP_K;
  // 多召回一些再按笔记聚合，避免同一篇笔记占满名额导致答案视角单一
  const raw = db.searchKbChunks({ query, kbId, topK: Math.max(k * 3, 12) });
  const allowed = Array.isArray(noteIds) && noteIds.length ? new Set(noteIds.map(Number)) : null;
  const hits = [];
  for (const r of raw) {
    const noteId = parseNoteId(r.sourceKey);
    if (allowed && (noteId == null || !allowed.has(noteId))) continue;
    hits.push({
      chunkId: r.chunkId,
      noteId,
      title: r.title || '',
      headingPath: r.headingPath || '',
      content: String(r.content || ''),
      score: Number(r.score) || 0,
    });
  }
  // 同一篇笔记最多保留 2 个块：既保证多样性，又不让长笔记刷屏
  const perNote = new Map();
  const picked = [];
  for (const h of hits) {
    const key = h.noteId == null ? `chunk-${h.chunkId}` : `note-${h.noteId}`;
    const c = perNote.get(key) || 0;
    if (c >= 2) continue;
    perNote.set(key, c + 1);
    picked.push(h);
    if (picked.length >= k) break;
  }
  return picked;
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
  const hits = retrieve({ query: q, topK, noteIds });
  if (!hits.length) return { answer: '', hits: [], degraded: true, reason: 'no-hit' };
  if (!cfg || !cfg.apiKey) {
    return { answer: '', hits, degraded: true, reason: 'no-ai' };
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
    return { answer: text, hits, degraded: false };
  } catch (e) {
    return { answer: '', hits, degraded: true, reason: (e && e.message) || 'AI 调用失败' };
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
  retrieve,
  buildContext,
  answer,
};
