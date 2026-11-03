'use strict';
/**
 * 对外同步 / 导出：把任务与笔记整理成第三方产品能直接吃下的通用格式。
 *
 *  - 任务 → Markdown 表格 / CSV：CSV 可直接导入腾讯文档（智能表格 / 在线表格），
 *    Markdown 可贴进腾讯文档或作为文本素材喂给 ima。
 *  - 笔记 → 单文件 Markdown（单篇就是一篇 .md）/ 按篇拆分的 .md 压缩包（zip）：
 *    散文件形式可直接批量上传到 ima 知识库。
 *
 * 图片一律**内嵌**：笔记里的 todo-media:/// 链接会被换成 data:image/...;base64，
 * 导出的 .md 是自包含的 —— 发给别人、换台机器打开都能看到图，不再附带 attachments/ 目录。
 *
 * 这里只做「读数据 + 拼装文本」，落盘（保存对话框 + 写文件）在 ipc.js 里做，
 * 好处是这些拼装函数不依赖 Electron，可以直接在 npm run test:db 下断言。
 */
const fs = require('fs');
const db = require('./db');
const attachments = require('./attachments');
const { zip } = require('./docx');

const PRIORITY_TEXT = ['低', '中', '高', '紧急'];
const EXPORT_LIMIT = 1000000; // 导出不做分页，listNotes 的默认 500 上限在这里被顶掉

/* ------------------------------ 通用小工具 ------------------------------ */

/** 文件名非法字符 → 下划线，Windows 与 macOS 通用 */
function safeFileName(name, fallback = '未命名') {
  const s = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return s || fallback;
}

/** 表格单元格里会破坏结构的字符：竖线转义、换行压成单行 */
function cellText(v) {
  return String(v == null ? '' : v)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n+/g, ' / ')
    .trim();
}

/** CSV 单元格：加引号 + 内部引号翻倍；前导 =+-@ 会被表格软件当公式，前缀 ' 规避 */
function csvCell(v) {
  let s = String(v == null ? '' : v).replace(/\r?\n+/g, ' / ');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function humanNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------ 任务导出 ------------------------------ */

/**
 * 分组树：导出按树形顺序排（父分组后紧跟它的子分组），路径写成「工作 / 前端」。
 * @returns {{order:Map<number,number>, pathOf:(id)=>string}}
 */
function groupIndex() {
  const groups = db.listGroups();
  const byParent = new Map();
  groups.forEach((g) => {
    const k = g.parent_id == null ? null : g.parent_id;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(g);
  });
  const order = new Map();
  const pathOf = new Map();
  let seq = 0;
  const walk = (pid, prefix) => {
    (byParent.get(pid) || []).forEach((g) => {
      if (order.has(g.id)) return; // 脏数据成环时兜底，避免无限递归
      order.set(g.id, seq++);
      const p = prefix ? `${prefix} / ${g.name}` : g.name;
      pathOf.set(g.id, p);
      walk(g.id, p);
    });
  };
  walk(null, '');
  groups.forEach((g) => {
    if (!order.has(g.id)) { order.set(g.id, seq++); pathOf.set(g.id, g.name); }
  });
  return { order, pathOf };
}

/**
 * 取待导出的任务（已按分组树顺序排好）。
 * @param {{status?:'active'|'completed'|'all'|'any', groupId?:number|null, includeSubtasks?:boolean}} opts
 */
function collectTasks(opts = {}) {
  const status = opts.status || 'all';
  const { order, pathOf } = groupIndex();
  const filter = { status, sort: opts.sort };
  if (opts.groupId != null && opts.groupId !== 'all') filter.groupId = opts.groupId;
  if (!opts.includeSubtasks) filter.topLevel = true;
  const tasks = db.listTasks(filter);
  const sorted = tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const oa = order.get(a.t.group_id) ?? Number.MAX_SAFE_INTEGER;
      const ob = order.get(b.t.group_id) ?? Number.MAX_SAFE_INTEGER;
      return oa - ob || a.i - b.i; // 同分组内保持列表原有排序
    })
    .map((x) => x.t);

  return sorted.map((t) => ({
    title: t.title || '',
    group: t.group_id != null ? (pathOf.get(t.group_id) || t.group_name || '') : '未分组',
    priority: PRIORITY_TEXT[Number(t.priority) || 0] || '中',
    status: t.archived ? '已归档' : t.completed ? '已完成' : '进行中',
    planStart: t.plan_start || '',
    planEnd: t.plan_end || '',
    completedAt: t.completed_at ? t.completed_at.slice(0, 10) : '',
    tags: (t.tag_names || []).join('、'),
    subtasks: t.subtask_count ? `${t.subtask_done}/${t.subtask_count}` : '',
    parent: t.parent_title || '',
    notes: t.notes || '',
  }));
}

function scopeText(scope = {}) {
  const s = { active: '进行中', completed: '已完成', all: '未归档（进行中 + 已完成）', any: '全部（含归档）' };
  return s[scope.status] || s.all;
}

/** 任务 → Markdown 表格 */
function tasksToMarkdown(rows, scope = {}) {
  const head = [
    '# 任务导出',
    '',
    `> 共 ${rows.length} 条 · 范围：${scopeText(scope)} · 导出时间：${humanNow()}`,
    '',
    '| 标题 | 分组 | 优先级 | 状态 | 计划开始 | 截止 | 完成日期 | 标签 | 子任务 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const body = rows.length
    ? rows.map((r) => `| ${cellText(r.title)} | ${cellText(r.group)} | ${cellText(r.priority)} | `
        + `${cellText(r.status)} | ${cellText(r.planStart)} | ${cellText(r.planEnd)} | `
        + `${cellText(r.completedAt)} | ${cellText(r.tags)} | ${cellText(r.subtasks)} | ${cellText(r.notes)} |`)
    : ['| （没有符合条件的任务） | | | | | | | | | |'];
  return `${head.join('\n')}\n${body.join('\n')}\n`;
}

/** 任务 → CSV（带 BOM，Excel / 腾讯文档直接打开不乱码） */
function tasksToCsv(rows, scope = {}) {
  const cols = ['标题', '分组', '优先级', '状态', '计划开始', '截止', '完成日期', '标签', '子任务', '上级任务', '备注'];
  const lines = [cols.map(csvCell).join(',')];
  rows.forEach((r) => {
    lines.push([
      r.title, r.group, r.priority, r.status, r.planStart, r.planEnd,
      r.completedAt, r.tags, r.subtasks, r.parent, r.notes,
    ].map(csvCell).join(','));
  });
  // 首行注释说明范围，导入在线表格时可手动删掉；放在数据前不影响列对齐
  const note = `# 范围：${scopeText(scope)} · 共 ${rows.length} 条 · 导出时间：${humanNow()}`;
  return `﻿${note}\n${lines.join('\n')}\n`;
}

/* ------------------------------ 笔记导出 ------------------------------ */

function folderIndex() {
  const folders = db.listNoteFolders();
  const map = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (id) => {
    const names = [];
    const seen = new Set();
    let cur = id;
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      const f = map.get(cur);
      if (!f) break;
      names.unshift(f.name);
      cur = f.parent_id == null ? null : f.parent_id;
    }
    return names.join(' / ');
  };
  return pathOf;
}

/**
 * 取待导出的笔记正文（去掉颜色 / 高亮标记，外部工具不认这种私有语法）。
 * @param {{noteId?:number|null, folderId?:number|null, tagId?:number|null, includeArchived?:boolean}} opts
 * @returns {Array<{id:number, title:string, fileName:string, folderPath:string, tags:string[], createdAt:string, updatedAt:string, md:string, attachments:Array}>}
 */
function collectNotes(opts = {}) {
  const pathOf = folderIndex();
  // 指定单篇：只看这一篇，目录 / 标签筛选不参与（「导出当前这篇」的唯一入口）
  if (opts.noteId != null) {
    const one = db.getNote(Number(opts.noteId));
    if (!one || one.deleted_at) return [];
    return [noteEntry(one, one, pathOf)];
  }
  const filter = { limit: EXPORT_LIMIT, archived: opts.includeArchived ? 'include' : 'exclude' };
  if (opts.folderId != null) { filter.folderId = opts.folderId; filter.includeSubfolders = true; }
  if (opts.tagId != null) filter.tagId = opts.tagId;
  const list = db.listNotes(filter);
  return list.map((n) => noteEntry(n, db.getNote(n.id) || n, pathOf));
}

/** 列表行 + 完整行 → 一条导出记录（附件优先取完整行） */
function noteEntry(n, full, pathOf) {
  const atts = Array.isArray(full.attachments) ? full.attachments : (Array.isArray(n.attachments) ? n.attachments : []);
  return {
    id: n.id,
    title: n.title || '未命名笔记',
    fileName: `${safeFileName(n.title || '未命名笔记')}.md`,
    folderPath: n.folder_id != null ? pathOf(n.folder_id) : '',
    tags: (n.tags || []).map((t) => t.name),
    createdAt: (n.created_at || '').slice(0, 10),
    updatedAt: (n.updated_at || '').slice(0, 10),
    md: db.stripStyleMarks(full.content_md || ''),
    attachments: atts,
  };
}

/* ------------------ 图片内嵌（导出为自包含 Markdown） ------------------ */

const MEDIA_PREFIX = 'todo-media:///';
/** 单张图内嵌上限：base64 再涨 1/3，太大会把 .md 撑到几百兆 */
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

/** 附件 → data: URL；非图片 / 文件缺失 / 超限返回空串（保持原链接不动） */
function inlineDataUrl(entry) {
  let mime = String((entry && entry.mime) || '');
  if (!mime) {
    try { mime = attachments.mimeOf(entry && entry.name); } catch (e) { mime = ''; }
  }
  if (!/^image\//i.test(mime)) return '';
  try {
    const abs = attachments.absPath(entry);
    if (!abs || !fs.existsSync(abs)) return '';
    const st = fs.statSync(abs);
    if (!st.isFile() || !st.size || st.size > MAX_INLINE_BYTES) return '';
    return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  } catch (e) {
    return ''; // 单个附件读失败不阻断整篇导出
  }
}

/** 正文里可能出现的两种写法：逐段编码的（现行）与裸路径（早期 / 手写） */
function mediaUrlVariants(entry) {
  const rel = String((entry && entry.path) || '').replace(/^\/+/, '');
  if (!rel) return [];
  return [
    `${MEDIA_PREFIX}${rel.split('/').map(encodeURIComponent).join('/')}`,
    `${MEDIA_PREFIX}${rel}`,
  ];
}

/** alt 文本里不能出现方括号，否则会把图片语法截断 */
function altText(name) {
  return String(name || 'image')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[[\]]/g, ' ')
    .trim() || 'image';
}

/**
 * 把正文里的 todo-media:/// 图片链接换成 data: URL —— 导出的 .md 不再依赖附件目录。
 * 正文没引用到的图片附件追加在文末，避免「传了却看不见」的内容被静默丢掉。
 * @param {string} md 已去掉样式标记的正文
 * @param {Array} atts 笔记附件元数据
 */
function inlineNoteImages(md, atts = []) {
  let out = String(md || '');
  const list = Array.isArray(atts) ? atts : [];
  const used = new Set();
  list.forEach((att) => {
    const data = inlineDataUrl(att);
    if (!data) return;
    let hit = false;
    mediaUrlVariants(att).forEach((url) => {
      if (!url || !out.includes(url)) return;
      out = out.split(url).join(data);
      hit = true;
    });
    if (hit) used.add(String(att.id));
  });

  const rest = list
    .filter((att) => !used.has(String(att.id)))
    .map((att) => ({ att, data: inlineDataUrl(att) }))
    .filter((x) => x.data);
  if (rest.length) {
    const block = rest.map(({ att, data }) => `![${altText(att.name)}](${data})`).join('\n\n');
    out = `${out.replace(/\s+$/, '')}\n\n${block}\n`;
  }
  return out;
}

/** 一篇笔记 → 自包含 Markdown（标题 + 元信息 + 正文） */
function noteToMarkdown(e) {
  const meta = [
    e.folderPath ? `目录：${e.folderPath}` : '',
    e.tags.length ? `标签：${e.tags.join('、')}` : '',
    `创建：${e.createdAt} · 更新：${e.updatedAt}`,
  ].filter(Boolean).join(' · ');
  const body = inlineNoteImages(e.md, e.attachments);
  return `# ${e.title}\n\n> ${meta}\n\n${body || '（空笔记）'}\n`;
}

/** 笔记 → 单个 Markdown 文件（单篇 = 这篇笔记本身；多篇顺序拼接，每篇带标题与元信息） */
function notesToSingleMarkdown(entries, opts = {}) {
  if (!entries.length) {
    return `# 笔记导出\n\n> 共 0 篇 · ${opts.scopeText || '全部笔记'} · 导出时间：${humanNow()}\n\n（没有符合条件的笔记）\n`;
  }
  // 只导一篇时不要「合集」外壳：用户拿到的就是这篇文档，标题即 H1
  if (entries.length === 1) return noteToMarkdown(entries[0]);

  const head = [
    '# 笔记导出',
    '',
    `> 共 ${entries.length} 篇 · ${opts.scopeText || '全部笔记'} · 导出时间：${humanNow()}`,
    '',
  ];
  const body = entries.map((e) => {
    const meta = [
      e.folderPath ? `目录：${e.folderPath}` : '',
      e.tags.length ? `标签：${e.tags.join('、')}` : '',
      `更新：${e.updatedAt}`,
    ].filter(Boolean).join(' · ');
    const md = inlineNoteImages(e.md, e.attachments);
    return `## ${e.title}\n\n> ${meta}\n\n${md || '（空笔记）'}\n\n---\n`;
  });
  return `${head.join('\n')}\n${body.join('\n')}`;
}

/**
 * 笔记 → zip：每篇一个 .md（放在对应目录层级下）。
 * 图片同样以 data: URL 内嵌，包里只有 .md —— 单篇解压出来也能看到图，不配 attachments/。
 */
function notesToZip(entries, opts = {}) {
  const used = new Set();
  const files = [];
  entries.forEach((e) => {
    const dir = e.folderPath ? e.folderPath.split(' / ').map((s) => safeFileName(s)).join('/') : '';
    const base = `${dir ? `${dir}/` : ''}${safeFileName(e.title)}.md`;
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) name = base.replace(/\.md$/, `-${n++}.md`);
    used.add(name.toLowerCase());
    files.push({ name, data: noteToMarkdown(e) });
  });

  const readme = `# 笔记导出\n\n共 ${entries.length} 篇 · ${opts.scopeText || '全部笔记'} · 导出时间：${humanNow()}\n`
    + '\n每个 .md 对应一篇笔记，按原目录层级放置；图片已以 base64 内嵌在各自的 .md 里，单独拷走也能正常显示。\n'
    + '可直接把 .md 批量上传到 ima 知识库，或导入其它支持 Markdown 的产品。\n';
  files.push({ name: 'README.md', data: readme });
  return zip(files);
}

/** 导出默认文件名：Knodo-任务-20261025-2330.csv */
function defaultName(kind, ext) {
  return `Knodo-${kind}-${stamp()}.${ext}`;
}

module.exports = {
  safeFileName,
  cellText,
  csvCell,
  collectTasks,
  tasksToMarkdown,
  tasksToCsv,
  collectNotes,
  noteToMarkdown,
  inlineNoteImages,
  notesToSingleMarkdown,
  notesToZip,
  defaultName,
};
