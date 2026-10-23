'use strict';
/**
 * 笔记视图：目录 / 标签组织 → 笔记列表（点击弹出编辑器窗口）→ Markdown 编辑 + 实时预览。
 *
 * 交互取舍：
 * - 列表页只做「浏览 / 组织 / 搜索 / 回收站」，点任意笔记**弹出编辑器窗口**（而不是整页切换），
 *   这样从任务详情跳转过来、或连续翻阅多篇笔记时，列表的筛选与滚动位置都不会丢；
 * - 事件委托只绑一次（#view 是共享容器，重绘 innerHTML 不清监听器，重复绑定会让一次点击触发 N 个处理器）；
 * - 依赖注入（toast / refresh / switchView）而不是直接 import ui.js：ui.js 会 import 本模块的
 *   renderNotes，反向依赖会形成环。项目里 meetings.js / recorder.js 已是同一套做法。
 *
 * 编辑器选型：EasyMDE（CodeMirror 5 内核）提供工具栏、快捷键、列表续行、撤销栈等编辑语义，
 * 预览交给 markdown-it（见 markdown-lib.js）——两者都是成熟库，vendor 进仓库后可离线运行。
 * 图片粘贴走 EasyMDE 的 imageUploadFunction：粘贴 / 拖拽 / 工具栏选文件统一一条链路，
 * 字节由主进程落盘到 `attachments/note-<id>/`，正文里只留 `todo-media://` 链接（不塞 base64）。
 */
import { api, fmtDateTime } from './api.js';
import { openPanelModal, openFormModal, openPromptModal } from './modal.js';
import { createAutoSave, SAVE_STATE_TEXT } from './autosave.js';
import { renderSafeMarkdown } from './markdown-lib.js';
import { openDetail } from './detail.js';

let notify = () => {};
let onChanged = () => {};
let onSwitchView = () => {};

export function setNotesHandlers({ toast, refresh, switchView } = {}) {
  if (toast) notify = toast;
  if (refresh) onChanged = refresh;
  if (switchView) onSwitchView = switchView;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const UNFILED = 0; // 与列表筛选一致：0 表示「未分类」（folder_id IS NULL）

/* ---------------- 视图内局部状态 ---------------- */
let folderId = 'all';      // 'all' | UNFILED | 目录 id
let tagId = null;
let keyword = '';
let showTrash = false;     // 回收站模式
let showArchived = false;  // 归档模式
let mode = 'split';        // 编辑器模式：edit | split | preview
let lastList = [];
let folderList = [];
let tagList = [];
let boundRoot = null;
/** 已绑过事件委托的容器（#view 常驻，重绘内容不清监听器，必须避免重复绑定） */
const boundContainers = new WeakSet();

/* ---------------- 编辑器（弹窗内） ---------------- */
let editor = null;         // EasyMDE 实例
let editorNoteId = null;
let saver = null;
let currentTagIds = [];
let currentNote = null;
let previewTimer = null;
/** 监听编辑器区域尺寸变化（弹窗拖动缩放 / 最大化 / 分栏切换后要重新测量 CodeMirror） */
let editorObserver = null;
/** 笔记已被删除：关闭窗口时不要再 flush（否则会对着一条已删除的记录保存并报「保存失败」） */
let discardSave = false;

/* ---------------- 骨架与渲染 ---------------- */

export async function renderNotes(containerSelector = '#view') {
  const container = typeof containerSelector === 'string'
    ? document.querySelector(containerSelector)
    : containerSelector;
  if (!container) return;
  // 骨架被别的视图整块替换过（#view 是共享容器，任务列表会重写它的 innerHTML），
  // 所以不能只比对容器引用——必须确认骨架还在，否则重建
  const needShell = boundRoot !== container || !container.querySelector('.nt-wrap');
  if (needShell) {
    container.innerHTML = shellHtml();
    // 事件委托挂在容器自身上：容器是常驻节点（#view），重绘 innerHTML 不会清掉监听器，
    // 每次重建骨架都再挂一次会让一次点击触发 N 个处理器（弹窗开 N 个、删 N 次）。
    if (!boundContainers.has(container)) {
      bindEvents(container);
      boundContainers.add(container);
    }
    boundRoot = container;
  }
  await refresh(container);
}

/** 供「任务详情 → 跳转查看笔记」调用：切到笔记视图并弹出该笔记的编辑器 */
export async function focusNote(id) {
  const noteId = Number(id) || null;
  if (!noteId) return;
  showTrash = false;
  await onSwitchView();
  await openNoteEditor(noteId);
}

function shellHtml() {
  return `
    <div class="nt-wrap">
      <div class="nt-toolbar">
        <button class="primary-btn" data-nt="new">＋ 新建笔记</button>
        <input class="nt-search" id="nt-search" type="text" placeholder="搜索笔记（标题 / 正文全文）" />
        <button class="chip" data-nt="toggle-archived">🗄 归档夹</button>
        <button class="chip" data-nt="toggle-trash">🗑 回收站</button>
        <span class="nt-spacer"></span>
        <button class="ghost-btn" data-nt="kb" title="以笔记为知识库向 AI 提问">🧠 知识库问答</button>
        <span class="nt-count"></span>
      </div>
      <div class="nt-layout">
        <aside class="nt-side">
          <div class="nt-side-head">
            <span>目录</span>
            <button class="mini-btn" data-nt="new-folder" title="新增目录">＋</button>
          </div>
          <ul class="nt-folders" id="nt-folders"></ul>
          <div class="nt-side-head">
            <span>标签</span>
            <button class="mini-btn" data-nt="new-tag" title="新增标签">＋</button>
          </div>
          <ul class="nt-tags" id="nt-tags"></ul>
        </aside>
        <ul class="nt-list" id="nt-list"></ul>
      </div>
    </div>`;
}

async function refresh(root = boundRoot) {
  if (!root) return;
  await loadSide(root);
  await loadList(root);
  syncToolbar(root);
}

function syncToolbar(root) {
  const count = root.querySelector('.nt-count');
  if (count) {
    count.textContent = showTrash ? `回收站 ${lastList.length} 篇` : `共 ${lastList.length} 篇`;
  }
  root.querySelector('[data-nt="toggle-trash"]')?.classList.toggle('active', showTrash);
  root.querySelector('[data-nt="toggle-archived"]')?.classList.toggle('active', showArchived);
  const emptyBtn = root.querySelector('[data-nt="empty-trash"]');
  if (emptyBtn) emptyBtn.hidden = !(showTrash && lastList.length > 0);
}

/* ---------------- 数据加载 ---------------- */

async function loadSide(root) {
  folderList = await api.noteFolders.list().catch(() => []);
  tagList = await api.noteTags.list().catch(() => []);

  const folderUl = root.querySelector('#nt-folders');
  if (folderUl) {
    folderUl.innerHTML = [
      folderRowHtml({ id: 'all', name: '全部笔记', depth: 0, color: '#c3cad6', count: null }),
      folderRowHtml({ id: UNFILED, name: '未分类', depth: 0, color: '#9aa1ad', count: null }),
      ...flattenFolders(folderList).map((f) => folderRowHtml(f)),
    ].join('');
  }

  const tagUl = root.querySelector('#nt-tags');
  if (tagUl) {
    tagUl.innerHTML = tagList.length
      ? tagList.map((t) => `
          <li class="nt-tag${tagId === t.id ? ' active' : ''}" data-nt-act="tag" data-id="${t.id}">
            <span class="nt-dot" style="background:${esc(t.color || '#8896ab')}"></span>
            <span class="nt-tag-name">${esc(t.name)}</span>
            <span class="nt-tag-count">${Number(t.note_count) || 0}</span>
          </li>`).join('')
      : '<li class="nt-empty">暂无标签</li>';
  }
}

/** 目录扁平化（带缩进层级），与分组树同一套展开逻辑 */
function flattenFolders(list) {
  const byParent = new Map();
  for (const f of list) {
    const p = f.parent_id == null ? null : f.parent_id;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(f);
  }
  const out = [];
  const walk = (parent, depth) => {
    const children = (byParent.get(parent) || []).slice().sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
    for (const c of children) {
      out.push({ ...c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function folderRowHtml(f) {
  const active = String(folderId) === String(f.id);
  return `
    <li class="nt-folder${active ? ' active' : ''}" data-nt-act="folder" data-id="${esc(f.id)}"
        style="padding-left:${6 + (f.depth || 0) * 14}px">
      <span class="nt-dot" style="background:${esc(f.color || '#4f7cff')}"></span>
      <span class="nt-folder-name">${esc(f.name)}</span>
      <span class="nt-folder-ops">
        <button class="mini-btn" data-nt-act="folder-edit" data-id="${esc(f.id)}" title="重命名 / 移动">✎</button>
        <button class="mini-btn" data-nt-act="folder-del" data-id="${esc(f.id)}" title="删除目录">✕</button>
      </span>
    </li>`;
}

async function loadList(root) {
  const ul = root.querySelector('#nt-list');
  if (!ul) return;
  let list;
  if (showTrash) {
    list = await api.notes.trashList().catch(() => []);
  } else if (keyword) {
    list = await api.notes.search(keyword, { archived: showArchived ? 'only' : 'exclude' }).catch(() => []);
  } else {
    list = await api.notes.list({
      folderId: folderId === 'all' ? undefined : Number(folderId),
      includeSubfolders: true,
      archived: showArchived ? 'only' : 'exclude',
      tagId,
    }).catch(() => []);
  }
  lastList = list;
  const head = showTrash && list.length
    ? `<li class="nt-trash-bar">
         <span>回收站里的笔记可恢复；彻底删除不可恢复。</span>
         <button class="ghost-btn tiny chip-danger" data-nt="empty-trash">清空回收站（${list.length}）</button>
       </li>`
    : '';
  ul.innerHTML = head + (list.length
    ? list.map(noteItemHtml).join('')
    : (showTrash
      ? '<li class="nt-empty"><div class="nt-empty-ico">🗑</div><div>回收站是空的</div></li>'
      : `<li class="nt-empty">
           <div class="nt-empty-ico">📝</div>
           <div>${keyword ? '没有匹配的笔记' : '还没有笔记'}</div>
           <div class="nt-empty-sub">${keyword
    ? '换个关键词试试，或清空搜索框'
    : '把想法、会议记录、技术方案都沉淀成笔记，之后可关联任务、供 AI 检索'}</div>
           ${keyword ? '' : '<button class="primary-btn" data-nt="new">＋ 新建笔记</button>'}
         </li>`));
}

function noteItemHtml(n) {
  const tags = (n.tags || []).map((t) => `<span class="nt-chip" style="--c:${esc(t.color || '#8896ab')}">${esc(t.name)}</span>`).join('');
  return `
    <li class="nt-item" data-nt-act="open" data-id="${n.id}">
      <div class="nt-item-head">
        <span class="nt-item-title">${n.pinned ? '📌 ' : ''}${esc(n.title || '未命名笔记')}</span>
        ${n.archived ? '<span class="nt-chip">已归档</span>' : ''}
        ${n.deleted_at ? `<span class="nt-chip nt-chip-danger">回收站 ${esc(fmtDateTime(n.deleted_at))}</span>` : ''}
        <span class="nt-item-ops">
          ${showTrash ? `
            <button class="mini-btn" data-nt-act="restore" data-id="${n.id}">恢复</button>
            <button class="mini-btn" data-nt-act="purge" data-id="${n.id}">彻底删除</button>`
    : `
            <button class="mini-btn" data-nt-act="edit" data-id="${n.id}" title="打开编辑窗口">编辑</button>
            <button class="mini-btn" data-nt-act="archive" data-id="${n.id}">${n.archived ? '取消归档' : '归档'}</button>
            <button class="mini-btn" data-nt-act="delete" data-id="${n.id}">删除</button>`}
        </span>
      </div>
      <div class="nt-item-excerpt">${esc(n.excerpt || '（空笔记）')}</div>
      <div class="nt-item-meta">
        <span>${fmtDateTime(n.updated_at)}</span>
        <span>${n.word_count || 0} 字</span>
        ${n.attachments && n.attachments.length ? `<span title="${n.attachments.length} 张图片">🖼 ${n.attachments.length}</span>` : ''}
        ${n.ref_count ? `<span class="nt-ref-badge" title="被 ${n.ref_count} 个任务引用">🔗 ${n.ref_count}</span>` : ''}
        ${tags}
      </div>
    </li>`;
}

/* ---------------- 编辑器弹窗 ---------------- */

/**
 * 打开笔记编辑窗口（弹窗，不覆盖列表页）。
 * @param {number} id 笔记 id
 * @param {{focusTitle?:boolean}} [opts] 新建后自动聚焦标题
 */
export async function openNoteEditor(id, opts = {}) {
  const note = await api.notes.get(id).catch(() => null);
  if (!note) { notify('笔记不存在或已被删除'); return null; }
  currentNote = note;
  currentTagIds = (note.tags || []).map((t) => t.id);
  editorNoteId = note.id;
  discardSave = false;

  await openPanelModal({
    // 抬头只写「笔记」：正文第一行就是标题输入框，抬头再显示一遍标题会重复
    title: '笔记',
    className: 'modal-note-editor',
    html: editorHtml(note),
    okText: '完成',
    // 大弹窗：头部给「关闭 / 最大化」，右下角可拖拽缩放，尺寸会记住
    showClose: true,
    headHtml: '<button type="button" class="modal-icon-btn" data-nt-act="maximize" title="最大化 / 还原（双击缩放手柄也可恢复默认大小）">⤢</button>',
    resizable: true,
    resizeKey: 'note-editor',
    minWidth: 640,
    minHeight: 440,
    extraButtons: [
      { label: note.pinned ? '取消置顶' : '📌 置顶', handler: async () => togglePin() },
      { label: note.archived ? '取消归档' : '🗄 归档', handler: async () => toggleArchive() },
      { label: '🗑 删除', handler: async (mask, close) => { await deleteFromEditor(mask, close); } },
    ],
    onMount: (mask, close) => mountEditor(mask, note, close, opts),
    onSubmit: async () => { await flushEditor(); return undefined; },
    // Esc / 点遮罩关闭时也要把最后一次输入写掉
    onClose: () => { flushEditor(); disposeEditor(); },
  });

  // 弹窗关闭后：列表可能变了（标题 / 归档 / 删除），局部重绘即可
  await refresh(boundRoot);
  onChanged();
  return note;
}

/**
 * 编辑器骨架。
 * 分栏 / 预览都自己实现（不用 EasyMDE 的 toggleSideBySide）：EasyMDE 的分栏默认会
 * 把编辑器切成整屏 fixed 布局，弹窗会被整个盖住（用户反馈的「笔记整屏覆盖」）。
 * 自己渲染还有一个好处：预览与列表摘要用的是同一套 markdown-it 输出，样式完全一致。
 */
function editorHtml(note) {
  return `
    <div class="nt-ed" data-mode="edit">
      <div class="nt-ed-head">
        <input class="nt-title" id="nt-title" type="text" placeholder="未命名笔记" maxlength="120"
               value="${esc(note.title || '')}" />
        <span class="nt-save" id="nt-save"></span>
        <div class="nt-seg" role="group" aria-label="编辑器模式">
          <button type="button" class="nt-seg-btn active" data-nt-act="mode" data-mode="edit">编辑</button>
          <button type="button" class="nt-seg-btn" data-nt-act="mode" data-mode="split">分栏</button>
          <button type="button" class="nt-seg-btn" data-nt-act="mode" data-mode="preview">预览</button>
        </div>
      </div>
      <div class="nt-ed-meta">
        <label class="nt-field">
          <span class="nt-field-label">目录</span>
          <select class="nt-folder-select" id="nt-folder-select">${folderOptionsHtml(note.folder_id)}</select>
        </label>
        <label class="nt-field nt-field-tags">
          <span class="nt-field-label">标签</span>
          <input class="nt-tag-input" id="nt-tag-input" type="text" placeholder="逗号分隔，如：方案，复盘"
                 value="${esc((note.tags || []).map((t) => t.name).join('，'))}" />
        </label>
        <span class="nt-meta-info" id="nt-meta-info"></span>
      </div>
      <div class="nt-ed-body">
        <div class="nt-pane">
          <textarea id="nt-md"></textarea>
        </div>
        <div class="nt-preview markdown-body" id="nt-preview"></div>
      </div>
      <div class="nt-att" id="nt-att"></div>
      <div class="nt-refs" id="nt-refs"></div>
    </div>`;
}

function folderOptionsHtml(sel) {
  const rows = flattenFolders(folderList);
  const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  return [
    opt(UNFILED, '未分类', sel == null),
    ...rows.map((f) => opt(f.id, `${'　'.repeat(f.depth || 0)}${f.name}`, Number(sel) === Number(f.id))),
  ].join('');
}

function mountEditor(mask, note, close, opts = {}) {
  const pane = mask.querySelector('.nt-ed');
  const ta = mask.querySelector('#nt-md');
  if (!pane || !ta) return;
  // 每次打开都回到「编辑」：分栏/预览只是当前窗口的临时视图，不该被上一篇的记忆带过来
  mode = 'edit';
  const MDE = window.EasyMDE;

  if (!MDE) {
    // 库缺失时降级为纯 textarea，不让编辑器整个打不开
    ta.value = note.content_md || '';
    ta.className = 'nt-md-fallback';
    ta.addEventListener('input', () => {
      if (saver) saver.schedule();
      schedulePreviewRefresh(mask);
    });
  } else {
    editor = new MDE({
      element: ta,
      initialValue: note.content_md || '',
      autoDownloadFontAwesome: false, // 离线运行：图标由 CSS ::after 提供文字/符号
      spellChecker: false,
      status: false,
      // 关掉「分栏即全屏」的默认行为：EasyMDE 的分栏是给整页编辑器设计的，
      // 在弹窗里会把编辑器变成 position:fixed 盖住整个应用（本次修复的重点之一）。
      sideBySideFullscreen: false,
      placeholder: '支持 Markdown：# 标题、- 列表、```代码块```、[链接](url)、| 表格 |；截图可直接粘贴',
      previewRender: (plain) => renderSafeMarkdown(plain),
      toolbar: toolbarConfig(MDE, note.id),
    });
    // 图片粘贴 / 拖拽：自己接管插入。
    // 不走 EasyMDE 的 uploadImage / imageUploadFunction —— 它内部的插入分支（P()/G()）在
    // 某些光标状态下会把整行替换成自身，导致「图片存好了但正文没插入」；自己插更可控。
    bindImagePaste(editor.codemirror, note.id, mask);
    // 正文变化：防抖落库 + 刷新预览。
    // 必须自己刷：预览面板是我们自己的 DOM，EasyMDE 不会替我们更新。
    editor.codemirror.on('change', () => {
      if (saver) saver.schedule();
      schedulePreviewRefresh(mask);
    });
    // 弹窗被拖动缩放 / 最大化后，CodeMirror 需要重新测量，否则光标与滚动区域会错位
    const modal = mask.querySelector('.modal');
    if (modal) modal.addEventListener('modal:resize', () => refreshEditorLayout());
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => refreshEditorLayout());
      ro.observe(pane);
      editorObserver = ro;
    }
  }

  applyMode(mask, mode);
  bindEditorFields(mask, note, close);
  bindEditorHead(mask);
  renderAttachments(mask, note);
  renderRefs(mask, note);
  if (opts.focusTitle) {
    const titleEl = mask.querySelector('#nt-title');
    if (titleEl) { titleEl.focus(); titleEl.select(); }
  } else {
    // 编辑已有笔记：光标直接进正文，省一次点击
    try { editor && editor.codemirror && editor.codemirror.focus(); } catch (e) { /* 忽略 */ }
  }
}

/** CodeMirror 的尺寸变了（窗口缩放 / 分栏切换）后要重新测量一次 */
function refreshEditorLayout() {
  if (!editor) return;
  try { editor.codemirror.refresh(); } catch (e) { /* 编辑器已销毁 */ }
}

/** 头部：最大化按钮（标题本身由正文里的输入框表示，抬头不再重复一遍） */
function bindEditorHead(mask) {
  const modal = mask.querySelector('.modal');
  const maxBtn = mask.querySelector('[data-nt-act="maximize"]');
  if (maxBtn && modal && typeof modal.__toggleMax === 'function') {
    maxBtn.addEventListener('click', () => {
      const on = modal.__toggleMax();
      maxBtn.textContent = on ? '⤡' : '⤢';
      maxBtn.title = on ? '还原窗口' : '最大化';
      setTimeout(refreshEditorLayout, 30);
    });
  }
}

function toolbarConfig(MDE, noteId) {
  const t = (name, action, cls, title) => ({ name, action, className: cls, title });
  // 按钮数量控制在「分栏时也能一行放下」：分栏后的编辑区只有弹窗一半宽，
  // 多放两个图标就会横向滚动、右侧图标被切掉（视觉上像坏了）。
  return [
    t('bold', MDE.toggleBold, 'nt-ico-bold', '加粗 (Ctrl+B)'),
    t('italic', MDE.toggleItalic, 'nt-ico-italic', '斜体 (Ctrl+I)'),
    '|',
    t('heading-1', MDE.toggleHeading1, 'nt-ico-h1', '一级标题'),
    t('heading-2', MDE.toggleHeading2, 'nt-ico-h2', '二级标题'),
    t('heading-3', MDE.toggleHeading3, 'nt-ico-h3', '三级标题'),
    '|',
    t('code', MDE.toggleCodeBlock, 'nt-ico-code', '代码块'),
    t('quote', MDE.toggleBlockquote, 'nt-ico-quote', '引用'),
    t('unordered-list', MDE.toggleUnorderedList, 'nt-ico-ul', '无序列表'),
    t('ordered-list', MDE.toggleOrderedList, 'nt-ico-ol', '有序列表'),
    '|',
    t('link', MDE.drawLink, 'nt-ico-link', '链接'),
    t('upload-image', () => pickNoteImage(noteId), 'nt-ico-image', '插入图片（本地文件）'),
    t('table', MDE.drawTable, 'nt-ico-table', '表格'),
    '|',
    // 不提供全屏按钮：整屏会盖住弹窗与列表（用户明确要去掉的交互）
    t('guide', () => showGuide(), 'nt-ico-help', 'Markdown 语法帮助'),
  ];
}

/* ---------------- 图片（复用 attachments.js 落盘规则） ---------------- */

/**
 * 绑定「粘贴 / 拖拽图片」：落盘后把 Markdown 引用插到光标处。
 * 只处理 image/* 的条目，其它粘贴（文本、文件）交还给 CodeMirror 原样处理。
 */
function bindImagePaste(cm, noteId, mask) {
  const takeFiles = (files) => {
    const imgs = [...(files || [])].filter((f) => /^image\//i.test(f && f.type ? f.type : ''));
    if (!imgs.length) return false;
    imgs.forEach(async (f) => {
      try {
        const url = await uploadNoteImage(noteId, f);
        insertImageMarkdown(cm, f.name || '图片', url);
        schedulePreviewRefresh(mask);
        notify('图片已插入');
      } catch (e) {
        notify((e && e.message) || '图片保存失败');
      }
    });
    return true;
  };
  cm.on('paste', (_cm, e) => {
    if (e && e.clipboardData && takeFiles(e.clipboardData.files)) e.preventDefault();
  });
  cm.on('drop', (_cm, e) => {
    if (e && e.dataTransfer && takeFiles(e.dataTransfer.files)) e.preventDefault();
  });
}

/** 把 `![name](url)` 插到光标处：当前行有内容时先换行，避免把正文粘在行尾 */
function insertImageMarkdown(cm, name, url) {
  const cur = cm.getCursor();
  const line = cm.getLine(cur.line) || '';
  const prefix = cur.ch === 0 ? '' : (line.trim() ? '\n\n' : '\n');
  cm.replaceSelection(`${prefix}![${String(name || '图片').replace(/[[\]]/g, '')}](${url})\n`);
  if (saver) saver.schedule();
}

/**
 * 把剪贴板 / 拖入 / 选择的文件转成 dataURL 交给主进程落盘，返回可写进 Markdown 的 URL。
 * 渲染层没有 fs 权限，所以字节只能以 base64 过 IPC；主进程落盘后库里只留元数据。
 * @returns {Promise<string>} todo-media:// URL
 */
async function uploadNoteImage(noteId, file) {
  if (!file) throw new Error('没有拿到图片数据');
  if (file.size && file.size > 20 * 1024 * 1024) throw new Error('图片超过 20MB，请先压缩');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
  const res = await api.noteAttachments.pasteImage(noteId, dataUrl, file.name || '');
  if (!res || !res.url) throw new Error('图片保存失败');
  currentNote = { ...(currentNote || {}), attachments: res.attachments };
  renderAttachments(document.querySelector('.modal-note-editor'), currentNote);
  return res.url;
}

/** 工具栏「插入图片」：走系统文件选择框（主进程 dialog）后落盘插入 */
async function pickNoteImage(noteId) {
  try {
    const res = await api.noteAttachments.pick(noteId);
    if (!res || res.canceled || !res.entries) return;
    const md = res.entries.map((e) => `![${e.name}](${mediaUrl(e)})`).join('\n\n');
    insertAtCursor(`\n\n${md}\n\n`);
    currentNote = { ...(currentNote || {}), attachments: res.attachments };
    renderAttachments(document.querySelector('.modal-note-editor'), currentNote);
    notify(`已插入 ${res.entries.length} 张图片`);
  } catch (e) {
    notify((e && e.message) || '插入图片失败');
  }
}

function mediaUrl(entry) {
  const rel = String((entry && entry.path) || '').replace(/^\/+/, '');
  return `todo-media:///${rel.split('/').map(encodeURIComponent).join('/')}`;
}

function insertAtCursor(text) {
  if (editor && editor.codemirror) {
    editor.codemirror.replaceSelection(text);
    if (saver) saver.schedule();
    return;
  }
  const ta = document.querySelector('#nt-md');
  if (!ta) return;
  const pos = ta.selectionStart || 0;
  ta.value = `${ta.value.slice(0, pos)}${text}${ta.value.slice(pos)}`;
  if (saver) saver.schedule();
}

/** 编辑器下方的图片条：直接看到已插入的图片，可打开 / 删除 */
async function renderAttachments(mask, note) {
  const box = mask && mask.querySelector ? mask.querySelector('#nt-att') : null;
  if (!box) return;
  const list = (note && note.attachments) || [];
  box.innerHTML = list.length
    ? `<div class="nt-refs-title">图片 / 附件 ${list.length}</div>
       <ul class="nt-att-list">${list.map((a) => `
         <li data-att="${esc(a.id || '')}">
           <img class="nt-att-thumb" src="${esc(mediaUrl(a))}" alt="${esc(a.name || '')}"
                data-att-act="open" title="用系统默认程序打开" />
           <span class="nt-att-name">${esc(a.name || '')}</span>
           <span class="nt-link-ops">
             <button class="ghost-btn tiny" data-att-act="copy" title="把 Markdown 引用写到剪贴板">复制</button>
             <button class="ghost-btn tiny" data-att-act="del" title="删除图片文件">✕</button>
           </span>
         </li>`).join('')}</ul>`
    : '';
  if (!list.length) return;

  box.querySelectorAll('[data-att-act]').forEach((el) => {
    el.addEventListener('click', async () => {
      const li = el.closest('[data-att]');
      const attId = li ? li.dataset.att : '';
      const act = el.dataset.attAct;
      const noteId = currentNote && currentNote.id;
      if (!noteId) return;
      try {
        if (act === 'open') await api.noteAttachments.open(noteId, attId);
        else if (act === 'del') {
          const res = await api.noteAttachments.remove(noteId, attId);
          currentNote = { ...currentNote, attachments: res.attachments };
          renderAttachments(mask, currentNote);
          notify('图片已删除（正文里的链接需手动清理）');
        } else if (act === 'copy') {
          const entry = (currentNote.attachments || []).find((a) => String(a.id) === String(attId));
          if (entry) {
            await navigator.clipboard.writeText(`![${entry.name}](${mediaUrl(entry)})`);
            notify('已复制 Markdown 引用');
          }
        }
      } catch (e) {
        notify((e && e.message) || '操作失败');
      }
    });
  });
}

/* ---------------- 编辑器模式与保存 ---------------- */

function applyMode(mask, m) {
  const pane = mask && mask.querySelector ? mask.querySelector('.nt-ed') : null;
  if (!pane) return;
  mode = m || 'edit';
  pane.dataset.mode = mode;
  mask.querySelectorAll('[data-nt-act="mode"]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  if (mode !== 'edit') refreshPreview(mask);
  // 切换后编辑器宽度变了 → 重新测量（否则行号 / 光标的横向位置会错）
  if (mode !== 'preview') setTimeout(refreshEditorLayout, 20);
}

/** 预览刷新防抖（打字时不逐字符重渲 markdown） */
function schedulePreviewRefresh(mask) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => refreshPreview(mask), 220);
}

/**
 * 把当前正文渲染进右侧 / 整幅预览面板。
 * 预览面板是自己渲染的（不是 EasyMDE 的 .editor-preview），所以样式与列表摘要、
 * 知识库答案完全一致，也不受 EasyMDE 全屏/分栏那套 fixed 布局影响。
 */
function refreshPreview(mask) {
  const pane = mask || (boundRoot ? boundRoot.querySelector('.nt-ed') : null);
  if (!pane) return;
  const box = pane.querySelector('#nt-preview');
  if (!box) return;
  const text = editor ? editor.value() : (pane.querySelector('#nt-md')?.value || '');
  box.innerHTML = String(text || '').trim()
    ? renderSafeMarkdown(text)
    : '<div class="nt-preview-empty">正文为空。左侧输入内容后，这里会实时渲染 Markdown。</div>';
}

/** 标题 / 目录 / 标签的即时保存（与任务详情同一套防抖保存器） */
function bindEditorFields(mask, note, close) {
  const pane = mask.querySelector('.nt-ed');
  const setStatus = (st, msg) => {
    const el = mask.querySelector('#nt-save');
    if (!el) return;
    el.textContent = st === 'error' ? `${SAVE_STATE_TEXT.error}：${msg || ''}` : (SAVE_STATE_TEXT[st] || '');
    el.className = `nt-save is-${st}`;
  };
  disposeSaver();
  const readPayload = () => {
    if (!currentNote) return null;
    // 标题允许留空：新建笔记时用户可能先写正文（标题先被清空过），
    // 以前这里返回 null 会让整篇笔记（含正文）都保存不了 —— 表现就是「新建笔记没用」。
    // 空标题在列表里统一显示为「未命名笔记」。
    const title = (mask.querySelector('#nt-title')?.value || '').trim();
    return {
      title,
      content_md: editor ? editor.value() : (mask.querySelector('#nt-md')?.value || ''),
      folder_id: Number(mask.querySelector('#nt-folder-select')?.value) || null,
      tagIds: currentTagIds,
    };
  };
  saver = createAutoSave({
    delay: 700,
    read: readPayload,
    save: async (payload) => {
      const updated = await api.notes.update(note.id, payload);
      currentNote = updated;
      const info = mask.querySelector('#nt-meta-info');
      if (info) info.textContent = `${updated.word_count || 0} 字 · 更新于 ${fmtDateTime(updated.updated_at)}`;
      return updated;
    },
    onStatus: setStatus,
    onError: (e) => notify((e && e.message) || '保存失败'),
  });
  // 基线 = 打开时的内容：没改动就不写库（否则每次开关窗口都会白白刷新「更新于」）
  try { saver.setBaseline(readPayload()); } catch (e) { /* 读失败时退化为「首轮必写」 */ }

  mask.querySelector('#nt-title')?.addEventListener('input', () => saver.schedule());
  mask.querySelector('#nt-folder-select')?.addEventListener('change', () => saver.flush());
  mask.querySelector('#nt-tag-input')?.addEventListener('change', async (e) => {
    await syncTagIds(e.target.value);
    saver.schedule();
  });
  // 模式切换 / 预览：事件在弹窗内部，单独绑（不进共享容器那套委托）
  mask.querySelectorAll('[data-nt-act="mode"]').forEach((b) => {
    b.addEventListener('click', () => applyMode(mask, b.dataset.mode));
  });
  updateEditorMeta(mask, note);
  void pane;
  void close;
}

/** 关闭前把未落库的改动写掉（返回 promise，调用方按需 await） */
function flushEditor() {
  if (!saver || discardSave) return Promise.resolve();
  return saver.flush().catch((e) => { notify((e && e.message) || '保存失败'); });
}

function updateEditorMeta(mask, note) {
  const info = mask.querySelector('#nt-meta-info');
  if (info) info.textContent = `${note.word_count || 0} 字 · 更新于 ${fmtDateTime(note.updated_at)}`;
  const title = mask.querySelector('#nt-title');
  if (title && document.activeElement !== title && title.value !== (note.title || '')) title.value = note.title || '';
}

/** 标签输入（逗号分隔）→ 标签 id；不存在的标签自动创建（与任务标签行为一致） */
async function syncTagIds(raw) {
  const names = String(raw || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  try {
    const all = await api.noteTags.list();
    const ids = [];
    for (const n of names) {
      const hit = all.find((t) => String(t.name).toLowerCase() === n.toLowerCase());
      ids.push(hit ? hit.id : (await api.noteTags.create(n)).id);
    }
    currentTagIds = ids;
  } catch (e) {
    notify((e && e.message) || '标签解析失败');
  }
}

/** 底部「引用了这篇笔记的任务」 */
async function renderRefs(mask, note) {
  const box = mask.querySelector('#nt-refs');
  if (!box) return;
  const tasks = await api.taskNotes.byNote(note.id).catch(() => []);
  box.innerHTML = tasks.length
    ? `<div class="nt-refs-title">被 ${tasks.length} 个任务引用</div>
       <ul class="nt-ref-list">${tasks.map((t) => `
         <li data-id="${t.id}">
           <span class="nt-ref-name">${t.completed ? '✅ ' : ''}${esc(t.title)}</span>
           <button class="mini-btn" data-nt-act="open-task" data-id="${t.id}">打开</button>
           <button class="mini-btn" data-nt-act="unlink-task" data-id="${t.id}" data-note="${note.id}">取消关联</button>
         </li>`).join('')}</ul>`
    : '<div class="nt-refs-title nt-refs-none">尚未被任何任务引用（可在任务详情里关联）</div>';

  box.querySelectorAll('[data-nt-act="open-task"]').forEach((b) => {
    b.addEventListener('click', () => openDetail(Number(b.dataset.id)));
  });
  box.querySelectorAll('[data-nt-act="unlink-task"]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.taskNotes.unlink(Number(b.dataset.id), Number(b.dataset.note));
      notify('已取消任务关联');
      await renderRefs(mask, note);
      onChanged();
    });
  });
}

function disposeSaver() {
  if (saver) { saver.dispose(); saver = null; }
}

function disposeEditor() {
  disposeSaver();
  clearTimeout(previewTimer);
  previewTimer = null;
  if (editorObserver) {
    try { editorObserver.disconnect(); } catch (e) { /* 忽略 */ }
    editorObserver = null;
  }
  try {
    if (editor && typeof editor.toTextArea === 'function') editor.toTextArea();
  } catch (e) { /* 编辑器已随 DOM 移除，忽略 */ }
  editor = null;
  editorNoteId = null;
  mode = 'edit';
}

/** 视图被切走时调用（避免已销毁的自动保存器继续写库） */
export function disposeNotes() {
  disposeEditor();
  currentNote = null;
}

/* ---------------- 编辑器弹窗里的行内操作 ---------------- */

async function togglePin() {
  if (!currentNote) return;
  await flushEditor();
  currentNote = await api.notes.pin(currentNote.id, !currentNote.pinned);
  notify(currentNote.pinned ? '已置顶' : '已取消置顶');
}

async function toggleArchive() {
  if (!currentNote) return;
  await flushEditor();
  currentNote = await api.notes.archive(currentNote.id, !currentNote.archived);
  notify(currentNote.archived ? '已归档（仍可被检索与引用）' : '已取消归档');
}

/** 编辑器里的「删除」：说明影响面后让用户选回收站 / 彻底删除，选完直接关闭弹窗 */
async function deleteFromEditor(mask, close) {
  if (!currentNote) return;
  const note = currentNote;
  const tasks = await api.taskNotes.byNote(note.id).catch(() => []);
  const listHtml = tasks.length
    ? `<div class="nt-del-warn">⚠️ 这篇笔记被 ${tasks.length} 个任务引用：</div>
       <ul class="nt-del-list">${tasks.map((t) => `<li>${t.completed ? '✅' : '⏳'} ${esc(t.title)}</li>`).join('')}</ul>`
    : '<div class="nt-del-warn">这篇笔记没有被任务引用，可直接删除。</div>';
  const purgeText = tasks.length ? `彻底删除（解除 ${tasks.length} 个任务引用）` : '彻底删除';

  const choice = await new Promise((resolve) => {
    openPanelModal({
      title: `删除《${note.title || '未命名笔记'}》`,
      className: 'modal-note-delete',
      html: `${listHtml}
        <div class="nt-del-hint">移入回收站后仍可恢复，任务里的引用也会保留；彻底删除不可恢复（连图片一起删）。</div>
        <div class="nt-del-ops">
          <button class="ghost-btn" data-del="trash">移入回收站</button>
          <button class="ghost-btn chip-danger" data-del="purge">${esc(purgeText)}</button>
        </div>`,
      okText: '取消',
      onMount: (m, c) => {
        // 先 resolve 再 close：close() 会触发 onClose（那里也有一次 resolve(null)），
        // Promise 只认第一次决议，顺序反了会永远解析成 null —— 删不掉。
        m.querySelector('[data-del="trash"]')?.addEventListener('click', () => { resolve('trash'); c(false); });
        m.querySelector('[data-del="purge"]')?.addEventListener('click', () => { resolve('purge'); c(false); });
      },
      onClose: () => resolve(null),
    });
  });

  if (choice === 'trash') {
    await flushEditor();
    await api.notes.trash(note.id);
    discardSave = true;
    notify('笔记已移入回收站');
    if (typeof close === 'function') close(false);
  } else if (choice === 'purge') {
    await flushEditor();
    discardSave = true;
    const res = await api.notes.purge(note.id).catch((e) => { notify((e && e.message) || '删除失败'); return null; });
    if (res) {
      notify(res.unlinkedTasks?.length
        ? `已彻底删除，并解除 ${res.unlinkedTasks.length} 个任务的引用`
        : '已彻底删除');
      if (typeof close === 'function') close(false);
    }
  }
}

/* ---------------- 事件绑定（列表页） ---------------- */

function bindEvents(root) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-nt]');
    if (btn) { await onToolbar(btn.dataset.nt); return; }
    const el = e.target.closest('[data-nt-act]');
    if (!el) return;
    const act = el.dataset.ntAct;
    const id = Number(el.dataset.id);
    if (act === 'folder') { folderId = el.dataset.id === 'all' ? 'all' : Number(el.dataset.id); await refresh(root); }
    else if (act === 'folder-edit') { e.stopPropagation(); await editFolder(id); }
    else if (act === 'folder-del') { e.stopPropagation(); await removeFolder(id); }
    else if (act === 'tag') { tagId = tagId === id ? null : id; await refresh(root); }
    else if (act === 'open' || act === 'edit') { await openNoteEditor(id); }
    else if (act === 'restore') { await api.notes.restore(id); notify('笔记已恢复'); await refresh(root); }
    else if (act === 'purge') { await purgeNote(id); }
    else if (act === 'archive') { await toggleArchiveById(id); }
    else if (act === 'delete') { await confirmDeleteById(id); }
  });

  const search = root.querySelector('#nt-search');
  if (search) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        keyword = search.value.trim();
        await loadList(root);
        syncToolbar(root);
      }, 250);
    });
  }
}

async function onToolbar(act) {
  const root = boundRoot;
  if (act === 'new') await createNote();
  else if (act === 'new-folder') await createFolder();
  else if (act === 'new-tag') await createTag();
  else if (act === 'toggle-trash') { showTrash = !showTrash; if (showTrash) showArchived = false; await refresh(root); }
  else if (act === 'toggle-archived') { showArchived = !showArchived; if (showArchived) showTrash = false; await refresh(root); }
  else if (act === 'empty-trash') await emptyTrash();
  else if (act === 'kb') await openKbModal();
}

/* ---------------- 新建 / 目录 / 标签 ---------------- */

export async function createNote(preset = {}) {
  const note = await api.notes.create({
    title: preset.title || '未命名笔记',
    contentMd: preset.contentMd || '',
    folderId: preset.folderId ?? (folderId === 'all' || folderId === UNFILED ? null : Number(folderId)),
  }).catch((e) => { notify((e && e.message) || '新建失败'); return null; });
  if (!note) return null;
  showTrash = false;
  showArchived = false;
  // 搜索态下新建的笔记会被关键词过滤掉（看起来像「新建无效」），先退出搜索
  if (keyword) {
    keyword = '';
    const search = boundRoot && boundRoot.querySelector('#nt-search');
    if (search) search.value = '';
  }
  await refresh(boundRoot);
  notify('已新建笔记：输入标题与正文，会自动保存');
  // 新笔记的标题是占位文案，弹窗打开后直接选中，打字即可替换
  await openNoteEditor(note.id, { focusTitle: true });
  return note;
}

async function createFolder() {
  const ok = await openFormModal({
    title: '新增笔记目录',
    width: 460,
    fields: [
      { name: 'name', label: '目录名', placeholder: '如：技术方案 / 会议沉淀' },
      {
        name: 'parentId', label: '上级目录', type: 'select',
        options: [{ value: '', label: '（顶级目录）' }, ...flattenFolders(folderList).map((f) => ({
          value: String(f.id), label: `${'　'.repeat(f.depth || 0)}${f.name}`,
        }))],
      },
    ],
    onSubmit: async (v) => {
      if (!v.name.trim()) return '目录名不能为空';
      await api.noteFolders.create({ name: v.name.trim(), parentId: v.parentId ? Number(v.parentId) : null });
      await refresh(boundRoot);
      return undefined;
    },
  });
  if (ok) notify('目录已创建');
}

async function editFolder(id) {
  const f = folderList.find((x) => x.id === id);
  if (!f) return;
  await openFormModal({
    title: '编辑目录',
    width: 460,
    fields: [
      { name: 'name', label: '目录名', value: f.name },
      {
        name: 'parentId', label: '上级目录', type: 'select', value: f.parent_id == null ? '' : String(f.parent_id),
        options: [{ value: '', label: '（顶级目录）' }, ...flattenFolders(folderList)
          .filter((x) => x.id !== id)
          .map((x) => ({ value: String(x.id), label: `${'　'.repeat(x.depth || 0)}${x.name}` }))],
      },
    ],
    onSubmit: async (v) => {
      if (!v.name.trim()) return '目录名不能为空';
      await api.noteFolders.update(id, { name: v.name.trim(), parentId: v.parentId ? Number(v.parentId) : null });
      await refresh(boundRoot);
      return undefined;
    },
  });
}

async function removeFolder(id) {
  const f = folderList.find((x) => x.id === id);
  if (!f) return;
  const ok = await openPromptModal({
    title: '删除目录',
    label: `删除「${f.name}」？子目录会提升到上级，目录内的笔记移到上级（不会删除笔记）。输入目录名确认：`,
    placeholder: f.name,
    okText: '删除目录',
    onSubmit: async (v) => {
      if (String(v).trim() !== f.name) return '输入的目录名不一致';
      await api.noteFolders.remove(id);
      if (String(folderId) === String(id)) folderId = 'all';
      await refresh(boundRoot);
      return undefined;
    },
  });
  if (ok) notify('目录已删除');
}

async function createTag() {
  await openPromptModal({
    title: '新增笔记标签',
    label: '标签名',
    placeholder: '如：方案 / 复盘 / 规范',
    onSubmit: async (v) => {
      if (!String(v).trim()) return '标签名不能为空';
      await api.noteTags.create(String(v).trim());
      await refresh(boundRoot);
      return undefined;
    },
  });
}

/* ---------------- 归档 / 删除策略 ---------------- */

/** 列表行上的归档 / 取消归档（不必打开编辑窗口） */
async function toggleArchiveById(id) {
  const row = lastList.find((n) => n.id === id);
  const next = !(row && row.archived);
  await api.notes.archive(id, next);
  notify(next ? '已归档（仍可被检索与引用）' : '已取消归档');
  await refresh(boundRoot);
}

async function emptyTrash() {
  const ok = await openPromptModal({
    title: '清空回收站',
    label: `将彻底删除回收站里的 ${lastList.length} 篇笔记（不可恢复，图片一并删除）。输入「清空」确认：`,
    placeholder: '清空',
    okText: '清空回收站',
    onSubmit: async (v) => {
      if (String(v).trim() !== '清空') return '请输入「清空」确认';
      const res = await api.notes.emptyTrash();
      notify(`已彻底删除 ${res.removed || 0} 篇笔记`);
      await refresh(boundRoot);
      onChanged();
      return undefined;
    },
  });
  void ok;
}

/**
 * 删除笔记：先告知影响面，再让用户选「移入回收站」还是「彻底删除」。
 * - 移入回收站：正文与任务引用都保留，恢复后引用自动复原；笔记从知识库索引里摘除。
 * - 彻底删除：先摘掉所有任务引用（task_notes），再删正文与图片，不可恢复。
 */
async function confirmDeleteById(id) {
  const note = await api.notes.get(id).catch(() => null);
  if (!note) return;
  if (editorNoteId === Number(id)) await flushEditor();
  const tasks = await api.taskNotes.byNote(note.id).catch(() => []);
  const listHtml = tasks.length
    ? `<div class="nt-del-warn">⚠️ 这篇笔记被 ${tasks.length} 个任务引用：</div>
       <ul class="nt-del-list">${tasks.map((t) => `<li>${t.completed ? '✅' : '⏳'} ${esc(t.title)}</li>`).join('')}</ul>`
    : '<div class="nt-del-warn">这篇笔记没有被任务引用，可直接删除。</div>';
  const purgeText = tasks.length ? `彻底删除（解除 ${tasks.length} 个任务引用）` : '彻底删除';
  // 两个动作都放在弹窗内容里（而不是底部 extraButtons）：extraButtons 的 handler 拿不到
  // 关闭回调，会让「彻底删除」之后的 await 永远等下去。
  const choice = await new Promise((resolve) => {
    openPanelModal({
      title: `删除《${note.title || '未命名笔记'}》`,
      className: 'modal-note-delete',
      html: `${listHtml}
        <div class="nt-del-hint">移入回收站后仍可恢复，任务里的引用也会保留；彻底删除不可恢复（连图片一起删）。</div>
        <div class="nt-del-ops">
          <button class="ghost-btn" data-del="trash">移入回收站</button>
          <button class="ghost-btn chip-danger" data-del="purge">${esc(purgeText)}</button>
        </div>`,
      okText: '取消',
      onMount: (mask, close) => {
        mask.querySelector('[data-del="trash"]')?.addEventListener('click', () => { resolve('trash'); close(false); });
        mask.querySelector('[data-del="purge"]')?.addEventListener('click', () => { resolve('purge'); close(false); });
      },
      onClose: () => resolve(null),
    });
  });
  if (choice === 'trash') {
    await api.notes.trash(note.id);
    notify('笔记已移入回收站');
    await refresh(boundRoot);
    onChanged();
  } else if (choice === 'purge') {
    await purgeNote(note.id);
  }
}

async function purgeNote(id) {
  const res = await api.notes.purge(id).catch((e) => { notify((e && e.message) || '删除失败'); return null; });
  if (!res) return;
  notify(res.unlinkedTasks?.length
    ? `已彻底删除，并解除 ${res.unlinkedTasks.length} 个任务的引用`
    : '已彻底删除');
  await refresh(boundRoot);
  onChanged();
}

/* ---------------- 知识库问答（智能检索） ---------------- */

/** 以笔记库为检索来源向 AI 提问；无 AI 配置时降级为「只展示召回片段」 */
async function openKbModal() {
  await openPanelModal({
    title: '知识库问答（检索来源：笔记）',
    className: 'modal-kb',
    html: `
      <div class="kb-form">
        <input class="modal-input" data-kb="q" placeholder="例如：上次讨论的灰度发布方案是什么？" />
        <button class="primary-btn" data-kb="ask">提问</button>
      </div>
      <div class="kb-stat" data-kb="stat">加载中…</div>
      <div class="kb-result" data-kb="result"></div>`,
    okText: '关闭',
    onMount: async (mask) => {
      const statEl = mask.querySelector('[data-kb="stat"]');
      const resultEl = mask.querySelector('[data-kb="result"]');
      const qEl = mask.querySelector('[data-kb="q"]');
      const askBtn = mask.querySelector('[data-kb="ask"]');

      const paintStat = async () => {
        const s = await api.kb.stats(1).catch(() => null);
        if (!s) { statEl.textContent = '知识库状态读取失败'; return; }
        statEl.innerHTML = `已沉淀 <b>${s.note_count}</b> 篇笔记，索引 <b>${s.indexed_note_count}</b> 篇 / <b>${s.chunk_count}</b> 个分块`;
      };
      await paintStat();

      const ask = async () => {
        const q = (qEl.value || '').trim();
        if (!q) return;
        askBtn.disabled = true;
        resultEl.innerHTML = '<div class="kb-loading">检索中（改写查询 → 多路召回 → AI 重排）…</div>';
        const res = await api.kb.ask({ question: q, topK: 8 }).catch((e) => ({ __err: e.message }));
        askBtn.disabled = false;
        resultEl.innerHTML = kbResultHtml(q, res);
        resultEl.querySelectorAll('[data-kb-act="open"]').forEach((b) => {
          b.addEventListener('click', async () => {
            // 关闭弹窗 → 直接打开该笔记的编辑窗口
            mask.querySelector('[data-modal="ok"]')?.click();
            await openNoteEditor(Number(b.dataset.id));
          });
        });
      };
      askBtn.addEventListener('click', ask);
      qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
    },
  });
}

function kbResultHtml(q, res) {
  if (!res || res.__err) return `<div class="kb-error">检索失败：${esc((res && res.__err) || '未知错误')}</div>`;
  const meta = res.meta || {};
  const flag = meta.reranked ? '<span class="kb-flag">已 AI 重排</span>' : '';
  if (res.degraded && res.reason === 'no-hit') return '<div class="kb-empty">知识库里没有命中相关内容。</div>';
  if (res.degraded && res.reason === 'no-ai') {
    return `${kbHitsHtml(res.hits)}<div class="kb-degraded">未配置 AI 接口，以上为本地多路召回结果（可在菜单栏「AI 设置」里配置后获得总结与语义重排）。</div>`;
  }
  if (res.degraded) {
    return `${kbHitsHtml(res.hits)}<div class="kb-degraded">AI 调用失败（${esc(res.reason || '')}），以上为本地多路召回结果。</div>`;
  }
  return `<div class="kb-answer">${renderSafeMarkdown(res.answer || '')}</div>${flag}${kbHitsHtml(res.hits)}`;
}

function kbHitsHtml(hits = []) {
  if (!hits.length) return '';
  return `<div class="kb-hits-title">引用来源</div><ul class="kb-hits">${hits.map((h, i) => `
    <li>
      <div class="kb-hit-head">
        <span class="kb-idx">[${i + 1}]</span>
        <button class="kb-hit-title" data-kb-act="open" data-id="${h.noteId ?? ''}">${esc(h.title || '未命名笔记')}</button>
        ${h.headingPath ? `<span class="kb-hit-path">${esc(h.headingPath)}</span>` : ''}
        ${h.matchedBy ? `<span class="kb-hit-path">命中：${esc(matchLabel(h.matchedBy))}</span>` : ''}
      </div>
      <div class="kb-hit-body">${esc(String(h.content || '').slice(0, 220))}</div>
    </li>`).join('')}</ul>`;
}

function matchLabel(matchedBy) {
  const map = { fts: '全文', note: '笔记级', like: '模糊' };
  return String(matchedBy || '').split('+').map((k) => map[k] || k).join(' + ');
}

/* ---------------- Markdown 语法帮助 ---------------- */

function showGuide() {
  openPanelModal({
    title: 'Markdown 语法速查',
    html: `<div class="nt-guide">${renderSafeMarkdown([
      '# 一级标题 / ## 二级标题',
      '- 无序列表',
      '1. 有序列表',
      '**加粗** *斜体* ~~删除线~~',
      '> 引用',
      '`行内代码`',
      '```js',
      'console.log("代码块");',
      '```',
      '[链接](https://example.com)',
      '![图片](https://example.com/a.png) ← 本地图片直接粘贴 / 拖拽即可',
      '',
      '| 列 A | 列 B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'))}</div>`,
  });
}
