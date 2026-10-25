'use strict';
/**
 * 对外同步 / 导出：把任务与笔记整理成第三方产品能直接吃下的通用格式。
 *
 *  - 任务 → Markdown 表格 / CSV：CSV 可直接导入腾讯文档（智能表格 / 在线表格），
 *    Markdown 可贴进腾讯文档或作为文本素材喂给 ima。
 *  - 笔记 → 单文件 Markdown 合集 / 按篇拆分的 .md 压缩包（zip）：
 *    散文件形式可直接批量上传到 ima 知识库。
 *
 * 这里只做「读数据 + 拼装文本」，落盘（保存对话框 + 写文件）在 ipc.js 里做，
 * 好处是这些拼装函数不依赖 Electron，可以直接在 npm run test:db 下断言。
 */
const fs = require('fs');
const path = require('path');
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
 * @param {{folderId?:number|null, tagId?:number|null, includeArchived?:boolean}} opts
 * @returns {Array<{title:string, folderPath:string, tags:string[], createdAt:string, updatedAt:string, md:string, attachments:Array}>}
 */
function collectNotes(opts = {}) {
  const pathOf = folderIndex();
  const filter = { limit: EXPORT_LIMIT, archived: opts.includeArchived ? 'include' : 'exclude' };
  if (opts.folderId != null) { filter.folderId = opts.folderId; filter.includeSubfolders = true; }
  if (opts.tagId != null) filter.tagId = opts.tagId;
  const list = db.listNotes(filter);
  return list.map((n) => {
    const full = db.getNote(n.id) || n;
    const md = db.stripStyleMarks(full.content_md || '');
    return {
      title: n.title || '未命名笔记',
      folderPath: n.folder_id != null ? pathOf(n.folder_id) : '',
      tags: (n.tags || []).map((t) => t.name),
      createdAt: (n.created_at || '').slice(0, 10),
      updatedAt: (n.updated_at || '').slice(0, 10),
      md,
      attachments: Array.isArray(n.attachments) ? n.attachments : [],
    };
  });
}

/** 笔记 → 单个 Markdown 文件（多篇顺序拼接，每篇带标题与元信息） */
function notesToSingleMarkdown(entries, opts = {}) {
  const head = [
    '# 笔记导出',
    '',
    `> 共 ${entries.length} 篇 · ${opts.scopeText || '全部笔记'} · 导出时间：${humanNow()}`,
    '',
  ];
  if (!entries.length) return `${head.join('\n')}（没有符合条件的笔记）\n`;
  const body = entries.map((e) => {
    const meta = [
      e.folderPath ? `目录：${e.folderPath}` : '',
      e.tags.length ? `标签：${e.tags.join('、')}` : '',
      `更新：${e.updatedAt}`,
    ].filter(Boolean).join(' · ');
    return `## ${e.title}\n\n> ${meta}\n\n${e.md || '（空笔记）'}\n\n---\n`;
  });
  return `${head.join('\n')}\n${body.join('\n')}`;
}

/**
 * 笔记 → zip：每篇一个 .md（放在对应目录层级下），图片附件一起打包，
 * 正文里的 todo-media:/// 链接改写成压缩包内的相对路径，解压后能正常预览。
 */
function notesToZip(entries, opts = {}) {
  const used = new Set();
  const files = [];
  entries.forEach((e) => {
    const dir = e.folderPath ? e.folderPath.split(' / ').map((s) => safeFileName(s)).join('/') : '';
    let base = `${dir ? `${dir}/` : ''}${safeFileName(e.title)}.md`;
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) name = base.replace(/\.md$/, `-${n++}.md`);
    used.add(name.toLowerCase());

    // 图片链接改写：todo-media:///attachments/note-3/x_y.png → attachments/x_y.png
    let md = e.md || '';
    (e.attachments || []).forEach((att) => {
      const rel = String((att && att.path) || '').replace(/^\/+/, '');
      if (!rel) return;
      const target = safeFileName(path.basename(rel));
      const url = `todo-media:///${rel.split('/').map(encodeURIComponent).join('/')}`;
      md = md.split(url).join(`attachments/${target}`);
      try {
        const abs = attachments.absPath(att);
        if (abs && fs.existsSync(abs)) {
          files.push({ name: `attachments/${target}`, data: fs.readFileSync(abs) });
        }
      } catch (err) { /* 附件缺失不阻断导出 */ }
    });

    const meta = [
      e.folderPath ? `目录：${e.folderPath}` : '',
      e.tags.length ? `标签：${e.tags.join('、')}` : '',
      `创建：${e.createdAt} · 更新：${e.updatedAt}`,
    ].filter(Boolean).join(' · ');
    files.push({ name, data: `# ${e.title}\n\n> ${meta}\n\n${md || '（空笔记）'}\n` });
  });

  const readme = `# 笔记导出\n\n共 ${entries.length} 篇 · ${opts.scopeText || '全部笔记'} · 导出时间：${humanNow()}\n`
    + '\n每个 .md 对应一篇笔记，按原目录层级放置；图片在 attachments/ 下。\n'
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
  notesToSingleMarkdown,
  notesToZip,
  defaultName,
};
