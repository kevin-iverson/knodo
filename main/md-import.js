'use strict';
/**
 * Markdown 笔记导入：把本地 .md 文件变成一篇笔记。
 *
 * 取舍（与项目其它部分一致：优先用成熟库，自己只写「串起来」的那点逻辑）：
 * - **正文原样入库**。Markdown 就是本应用的存储格式，不需要做任何转换 / 清洗；
 *   导入后的笔记与手写的笔记完全同构（知识库索引、全文检索、导出都直接生效）。
 * - **YAML front matter 只认几个键**（title / tags / folder），手写正则解析而不是引 YAML 库：
 *   导入场景里 front matter 结构是平的，引一个解析器不值当；解析不出来的部分原样留在正文里，
 *   不会把内容吃掉。
 * - **相对路径的本地图片一起搬进来**（可选）。否则导入后图片全是死链 —— 图片落盘规则与
 *   笔记粘贴截图完全一致（attachments/note-<id>/），正文链接改写成 todo-media:///。
 *
 * 该模块不依赖 Electron 的 dialog / shell（文件选择交给 ipc 层），可单独测试。
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const attachments = require('./attachments');
const knowledge = require('./knowledge');

/** 可导入的扩展名（txt 也收：很多人随手记的东西是 .txt） */
const MD_EXT = ['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.txt'];
/** 单个 Markdown 文件上限：再大就不是笔记了，多半是误选 */
const MAX_MD_BYTES = 20 * 1024 * 1024;
/** 递归层数上限：防软链接成环 / 误选磁盘根目录 */
const MAX_DEPTH = 12;
/** 目录递归时跳过的目录名 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv']);
/** 单次导入的文件数上限：防止误选整个磁盘 */
const MAX_FILES = 2000;

/**
 * 拆 front matter。
 * @param {string} raw 文件全文
 * @returns {{attrs:Record<string,string>, body:string}}
 */
function parseFrontMatter(raw) {
  const src = String(raw || '');
  if (!/^---\r?\n/.test(src)) return { attrs: {}, body: src };
  const lines = src.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { attrs: {}, body: src };
  const attrs = {};
  for (let i = 1; i < end; i += 1) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = String(m[2] || '').trim();
    // 去掉引号与行尾注释式的括号（[a, b] 留给 tags 自己处理）
    if (/^\[.*\]$/.test(val)) val = val.slice(1, -1).trim();
    else val = val.replace(/^["']|["']$/g, '').trim();
    if (val) attrs[key] = val;
  }
  return { attrs, body: lines.slice(end + 1).join('\n').replace(/^\r?\n/, '') };
}

/** 标题文本 → 去掉 Markdown 行内标记后的纯文字 */
function plainOf(s) {
  return String(s || '')
    .replace(/==([^=\n]+)==(?:\{[^}\n]*\})?/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

/**
 * 取正文里第一个一级标题（跳过 ``` 代码块，避免把注释里的 # 当标题）。
 * @param {string} body
 * @returns {string}
 */
function firstHeading(body) {
  const lines = String(body || '').split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && plainOf(m[1])) return plainOf(m[1]);
  }
  return '';
}

/** 文件名 → 标题（去扩展名、去常见的日期前缀） */
function titleFromFileName(filePath) {
  const base = path.basename(String(filePath || ''), path.extname(String(filePath || '')));
  return base.replace(/^\d{4}[-_.]?\d{2}[-_.]?\d{2}[-_\s]*/, '').trim() || base;
}

/** 标签文本 → 标签名数组（兼容中英文逗号 / 分号 / 空格 / [a, b]） */
function tagNamesOf(text) {
  return String(text || '')
    .split(/[,，;；\n]+/)
    .map((s) => s.trim().replace(/^["'[\]]+|["'[\]]+$/g, '').trim())
    .filter(Boolean);
}

/** Markdown 里的图片引用：`![alt](url)` */
const IMG_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;

function isRemoteUrl(u) {
  return /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//');
}

/**
 * 把正文里的相对图片引用落盘，并改写成 todo-media:/// 链接。
 * @param {number} noteId
 * @param {string} body
 * @param {string} baseDir 相对路径的基准（md 文件所在目录）
 * @returns {{body:string, entries:Array}}
 */
function importLocalImages(noteId, body, baseDir) {
  const entries = [];
  const cache = new Map();
  const next = String(body || '').replace(IMG_RE, (all, alt, url) => {
    const raw = String(url || '').trim();
    if (!raw || isRemoteUrl(raw)) return all;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (e) { /* 不是合法百分号编码就按原样用 */ }
    const abs = path.resolve(baseDir, decoded);
    if (cache.has(abs)) return cache.get(abs);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return all;
      const entry = attachments.importInto('note', noteId, abs);
      entries.push(entry);
      const out = `![${alt}](${mediaUrl(entry)})`;
      cache.set(abs, out);
      return out;
    } catch (e) {
      return all; // 单个图片失败不影响整篇导入
    }
  });
  return { body: next, entries };
}

function mediaUrl(entry) {
  const rel = String((entry && entry.path) || '');
  return `todo-media:///${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 递归收集目录里的 Markdown 文件。
 * @param {string} dir 要扫描的目录
 * @param {number} [depth] 当前层数（内部递归用）
 * @param {Array<{file:string,relDir:string}>} [out] 结果累加器（内部递归用）
 * @param {string} [root] 顶层目录（内部递归用：relDir 必须相对它，否则每层都算成 ''）
 * @returns {Array<{file:string, relDir:string}>} relDir 是文件相对顶层目录的子目录
 */
function walkDir(dir, depth = 0, out = [], root = dir) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const it of items) {
    if (out.length >= MAX_FILES) break;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (it.name.startsWith('.') || SKIP_DIRS.has(it.name)) continue;
      walkDir(full, depth + 1, out, root);
      continue;
    }
    if (!it.isFile()) continue;
    if (!MD_EXT.includes(path.extname(it.name).toLowerCase())) continue;
    out.push({ file: full, relDir: path.relative(root, path.dirname(full)) });
  }
  return out;
}

/** 确保目录链存在（同名复用），返回最深层目录 id */
function ensureFolderChain(rootId, names) {
  let parent = rootId ?? null;
  const rows = db.listNoteFolders();
  const findChild = (pid, name) => rows.find((f) => (f.parent_id ?? null) === (pid ?? null) && f.name === name);
  for (const name of names) {
    const exist = findChild(parent, name);
    if (exist) { parent = exist.id; continue; }
    const created = db.createNoteFolder({ name, parentId: parent });
    parent = created.id;
  }
  return parent;
}

/**
 * 导入一批 Markdown 文件。
 * @param {object} p
 * @param {Array<string|{file:string,relDir:string}>} p.files 文件路径或「文件 + 相对子目录」
 * @param {number|null} [p.folderId] 目标笔记目录；null / 0 = 未分类
 * @param {string[]} [p.tags] 附加标签
 * @param {'file'|'h1'} [p.titleFrom] 标题取自文件名还是首个一级标题
 * @param {boolean} [p.importImages=true] 是否搬运相对路径的本地图片
 * @returns {{ok:boolean, imported:number, skipped:Array, notes:Array, images:number}}
 */
function importFiles({
  files = [], folderId = null, tags = [], titleFrom = 'file', importImages = true,
} = {}) {
  const rootId = folderId === 0 ? null : (folderId ?? null);
  const extraTags = tagNamesOf(Array.isArray(tags) ? tags.join(',') : tags);
  const notes = [];
  const skipped = [];
  let images = 0;

  for (const item of files) {
    const file = typeof item === 'string' ? item : (item && item.file);
    const relDir = typeof item === 'string' ? '' : ((item && item.relDir) || '');
    if (!file) continue;
    let raw = '';
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error('不是文件');
      if (st.size > MAX_MD_BYTES) throw new Error(`文件超过 ${MAX_MD_BYTES / 1024 / 1024}MB`);
      raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    } catch (e) {
      skipped.push({ file, reason: (e && e.message) || '读取失败' });
      continue;
    }
    const { attrs, body } = parseFrontMatter(raw);
    const head = titleFrom === 'h1' ? firstHeading(body) : '';
    const title = String(attrs.title || head || titleFromFileName(file)).trim() || '未命名笔记';

    // 目录导入：按子目录结构落到对应的笔记目录下
    let target = rootId;
    if (relDir && relDir !== '.') {
      const names = relDir.split(/[\\/]+/).filter(Boolean);
      if (names.length) {
        try { target = ensureFolderChain(rootId, names); }
        catch (e) { target = rootId; }
      }
    }

    const tagList = [...extraTags, ...tagNamesOf(attrs.tags || '')];
    try {
      const note = db.createNote({
        title,
        contentMd: body,
        folderId: target,
        tagIds: db.resolveNoteTagIds(tagList),
        source: 'import',
        sourceRef: path.basename(file),
      });
      if (importImages) {
        const res = importLocalImages(note.id, body, path.dirname(file));
        if (res.entries.length) {
          db.setNoteAttachments(note.id, res.entries);
          db.updateNote(note.id, { content_md: res.body });
          images += res.entries.length;
        }
      }
      knowledge.indexNote(note.id);
      notes.push({ id: note.id, title: note.title });
    } catch (e) {
      skipped.push({ file, reason: (e && e.message) || '写入失败' });
    }
  }

  return { ok: notes.length > 0, imported: notes.length, skipped, notes, images };
}

module.exports = {
  MD_EXT,
  MAX_FILES,
  importFiles,
  walkDir,
  parseFrontMatter,
  firstHeading,
};
