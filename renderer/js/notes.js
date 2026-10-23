'use strict';
/**
 * 笔记视图：目录 / 标签组织 → 笔记列表 → Markdown 编辑器（EasyMDE）+ 实时预览。
 *
 * 交互与既有「会议纪要」视图保持一致：三栏布局（目录 / 列表 / 详情），事件委托只绑一次，
 * 数据变化只做局部重绘——整段 innerHTML 重建会丢滚动位置与输入焦点。
 *
 * 依赖注入（toast / refresh / switchView）而不是直接 import ui.js：ui.js 会 import 本模块的
 * renderNotes，反向依赖会形成环。项目里 meetings.js / recorder.js 已是同一套做法。
 *
 * 编辑器选型说明：EasyMDE（CodeMirror 5 内核）提供工具栏、快捷键、列表续行、撤销栈等编辑语义，
 * 预览交给 markdown-it（见 markdown-lib.js）——两者都是成熟库，vendor 进仓库后可离线运行。
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
let selectedId = null;
let folderId = 'all';      // 'all' | UNFILED | 目录 id
let tagId = null;
let keyword = '';
let showTrash = false;     // 回收站模式
let showArchived = false;  // 归档模式
let mode = 'split';        // edit | split | preview
let lastList = [];
let folderList = [];
let tagList = [];
let boundRoot = null;
/** 已绑过事件委托的容器（#view 常驻，重绘内容不清监听器，必须避免重复绑定） */
const boundContainers = new WeakSet();
let editor = null;         // EasyMDE 实例
let editorNoteId = null;
let saver = null;
let currentTagIds = [];
let currentNote = null;

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
    disposeEditor(); // 旧编辑器实例随 DOM 一起消失，先回收它的自动保存器
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

/** 供「任务详情 → 跳转查看笔记」调用：切到笔记视图并选中该笔记 */
export async function focusNote(id) {
  selectedId = Number(id) || null;
  showTrash = false;
  showArchived = false;
  await onSwitchView();
}

function shellHtml() {
  return `
    <div class="nt-wrap">
      <div class="nt-toolbar">
        <button class="primary-btn" data-nt="new">＋ 新建笔记</button>
        <input class="nt-search" id="nt-search" type="text" placeholder="搜索笔记（标题 / 正文全文）" />
        <button class="chip" data-nt="toggle-archived">🗄 归档</button>
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
        <section class="nt-editor" id="nt-editor"></section>
      </div>
    </div>`;
}

async function refresh(root = boundRoot) {
  if (!root) return;
  await loadSide(root);
  await loadList(root);
  await loadEditor(root);
  syncToolbar(root);
}

function syncToolbar(root) {
  const count = root.querySelector('.nt-count');
  if (count) {
    count.textContent = showTrash ? `回收站 ${lastList.length} 篇` : `共 ${lastList.length} 篇`;
  }
  root.querySelector('[data-nt="toggle-trash"]')?.classList.toggle('active', showTrash);
  root.querySelector('[data-nt="toggle-archived"]')?.classList.toggle('active', showArchived);
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
  if (selectedId && !list.some((n) => n.id === selectedId)) {
    // 允许「选中项不在当前筛选结果里」时保持选中（例如刚被归档），只要笔记还在库里
    const alive = await api.notes.get(selectedId).catch(() => null);
    if (!alive) selectedId = null;
  }
  if (!selectedId && list.length && !showTrash) selectedId = list[0].id;

  ul.innerHTML = list.length
    ? list.map(noteItemHtml).join('')
    : `<li class="nt-empty">${showTrash ? '回收站是空的' : '还没有笔记，点「＋ 新建笔记」开始沉淀'}</li>`;
}

function noteItemHtml(n) {
  const tags = (n.tags || []).map((t) => `<span class="nt-chip" style="--c:${esc(t.color || '#8896ab')}">${esc(t.name)}</span>`).join('');
  return `
    <li class="nt-item${selectedId === n.id ? ' active' : ''}" data-nt-act="open" data-id="${n.id}">
      <div class="nt-item-head">
        <span class="nt-item-title">${n.pinned ? '📌 ' : ''}${esc(n.title || '未命名笔记')}</span>
        ${n.archived ? '<span class="nt-chip">已归档</span>' : ''}
        ${n.deleted_at ? '<span class="nt-chip nt-chip-danger">回收站</span>' : ''}
      </div>
      <div class="nt-item-excerpt">${esc(n.excerpt || '（空笔记）')}</div>
      <div class="nt-item-meta">
        <span>${fmtDateTime(n.updated_at)}</span>
        <span>${n.word_count || 0} 字</span>
        ${n.ref_count ? `<span class="nt-ref-badge" title="被 ${n.ref_count} 个任务引用">🔗 ${n.ref_count}</span>` : ''}
        ${tags}
      </div>
      ${showTrash ? `
        <div class="nt-item-ops">
          <button class="mini-btn" data-nt-act="restore" data-id="${n.id}">恢复</button>
          <button class="mini-btn" data-nt-act="purge" data-id="${n.id}">彻底删除</button>
        </div>` : ''}
    </li>`;
}

/* ---------------- 编辑器 ---------------- */

async function loadEditor(root) {
  const pane = root.querySelector('#nt-editor');
  if (!pane) return;
  if (!selectedId) {
    disposeEditor();
    pane.innerHTML = '<div class="nt-empty-pane">选择左侧笔记开始编辑，或点「＋ 新建笔记」</div>';
    return;
  }
  const note = await api.notes.get(selectedId).catch(() => null);
  if (!note) { selectedId = null; await loadEditor(root); return; }
  currentNote = note;
  currentTagIds = (note.tags || []).map((t) => t.id);

  if (editorNoteId === note.id && editor) {
    updateEditorMeta(pane, note); // 同一篇笔记：只刷新元信息，不动编辑器（保焦点与光标）
    return;
  }
  disposeEditor();
  pane.innerHTML = editorHtml(note);
  mountEditor(pane, note);
}

function editorHtml(note) {
  return `
    <div class="nt-ed-head">
      <input class="nt-title" id="nt-title" type="text" placeholder="笔记标题" value="${esc(note.title || '')}" />
      <div class="nt-ed-actions">
        <span class="nt-save" id="nt-save"></span>
        <button class="chip" data-nt-act="mode" data-mode="edit">编辑</button>
        <button class="chip" data-nt-act="mode" data-mode="split">分栏</button>
        <button class="chip" data-nt-act="mode" data-mode="preview">预览</button>
        <button class="chip" data-nt-act="pin">${note.pinned ? '取消置顶' : '📌 置顶'}</button>
        <button class="chip" data-nt-act="archive">${note.archived ? '取消归档' : '🗄 归档'}</button>
        <button class="chip chip-danger" data-nt-act="delete">🗑 删除</button>
      </div>
    </div>
    <div class="nt-ed-meta">
      <select class="nt-folder-select" id="nt-folder-select">
        ${folderOptionsHtml(note.folder_id)}
      </select>
      <input class="nt-tag-input" id="nt-tag-input" type="text" placeholder="标签，逗号分隔" value="${esc((note.tags || []).map((t) => t.name).join('，'))}" />
      <span class="nt-meta-info" id="nt-meta-info"></span>
    </div>
    <textarea id="nt-md"></textarea>
    <div class="nt-refs" id="nt-refs"></div>`;
}

function folderOptionsHtml(sel) {
  const rows = flattenFolders(folderList);
  const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  return [
    opt(UNFILED, '未分类', sel == null),
    ...rows.map((f) => opt(f.id, `${'　'.repeat(f.depth || 0)}${f.name}`, Number(sel) === Number(f.id))),
  ].join('');
}

function updateEditorMeta(pane, note) {
  const info = pane.querySelector('#nt-meta-info');
  if (info) {
    info.textContent = `${note.word_count || 0} 字 · 更新于 ${fmtDateTime(note.updated_at)}`;
  }
  const title = pane.querySelector('#nt-title');
  if (title && document.activeElement !== title && title.value !== (note.title || '')) title.value = note.title || '';
  renderRefs(pane, note);
}

function mountEditor(pane, note) {
  const ta = pane.querySelector('#nt-md');
  if (!ta) return;
  const MDE = window.EasyMDE;
  if (!MDE) {
    // 库缺失时降级为纯 textarea + 只读预览，不让编辑器整个打不开
    ta.value = note.content_md || '';
    ta.className = 'nt-md-fallback';
    ta.addEventListener('input', () => saver && saver.schedule());
    bindEditorFields(pane, note);
    return;
  }
  editor = new MDE({
    element: ta,
    initialValue: note.content_md || '',
    autoDownloadFontAwesome: false, // 离线运行：图标由 CSS ::after 提供文字/符号
    spellChecker: false,
    status: false,
    minHeight: '320px',
    placeholder: '支持 Markdown：# 标题、- 列表、```代码块```、[链接](url)、![图片](url)、| 表格 |',
    previewRender: (plain) => renderSafeMarkdown(plain),
    toolbar: toolbarConfig(MDE),
  });
  editorNoteId = note.id;
  // 正文变化：防抖落库 + 刷新预览。
  // 必须自己刷：EasyMDE 只在「分栏」模式下监听 update 自动重渲，全屏预览模式下改了字不会跟着变。
  editor.codemirror.on('change', () => {
    if (saver) saver.schedule();
    schedulePreviewRefresh();
  });
  applyMode(mode);
  bindEditorFields(pane, note);
}

function toolbarConfig(MDE) {
  const t = (name, action, cls, title) => ({ name, action, className: cls, title });
  return [
    t('bold', MDE.toggleBold, 'nt-ico-bold', '加粗 (Ctrl+B)'),
    t('italic', MDE.toggleItalic, 'nt-ico-italic', '斜体 (Ctrl+I)'),
    t('strikethrough', MDE.toggleStrikethrough, 'nt-ico-strike', '删除线'),
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
    t('image', MDE.drawImage, 'nt-ico-image', '图片'),
    t('table', MDE.drawTable, 'nt-ico-table', '表格'),
    t('horizontal-rule', MDE.drawHorizontalRule, 'nt-ico-hr', '分隔线'),
    '|',
    t('preview', MDE.togglePreview, 'nt-ico-preview', '预览'),
    t('side-by-side', MDE.toggleSideBySide, 'nt-ico-split', '分栏预览'),
    t('fullscreen', MDE.toggleFullScreen, 'nt-ico-full', '全屏'),
    t('guide', () => showGuide(), 'nt-ico-help', 'Markdown 语法帮助'),
  ];
}

function applyMode(m) {
  if (!editor) return;
  if (m === 'edit') {
    if (editor.isSideBySideActive()) editor.toggleSideBySide();
    if (editor.isPreviewActive()) editor.togglePreview();
  } else if (m === 'preview') {
    if (editor.isSideBySideActive()) editor.toggleSideBySide();
    if (!editor.isPreviewActive()) editor.togglePreview();
  } else {
    if (editor.isPreviewActive()) editor.togglePreview();
    if (!editor.isSideBySideActive()) editor.toggleSideBySide();
  }
  // 面板的 active 类是异步加的（EasyMDE 内部用 setTimeout），稍后一拍再刷内容
  setTimeout(refreshPreview, 30);
}

let previewTimer = null;

/** 预览刷新防抖（打字时不逐字符重渲 markdown） */
function schedulePreviewRefresh() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 250);
}

/**
 * 把当前正文渲染进处于激活态的预览面板。
 * 全屏预览模式下 EasyMDE 不会自动重渲，改了正文必须自己刷，否则预览停在旧内容上。
 */
function refreshPreview() {
  if (!editor) return;
  const pane = boundRoot ? boundRoot.querySelector('#nt-editor') : null;
  if (!pane) return;
  const html = renderSafeMarkdown(editor.value());
  const full = pane.querySelector('.editor-preview-full');
  if (full && full.classList.contains('editor-preview-active')) full.innerHTML = html;
  const side = pane.querySelector('.editor-preview-side');
  if (side && side.classList.contains('editor-preview-active-side')) side.innerHTML = html;
}

/** 标题 / 目录 / 标签的即时保存（与任务详情同一套防抖保存器） */
function bindEditorFields(pane, note) {
  const setStatus = (st, msg) => {
    const el = pane.querySelector('#nt-save');
    if (!el) return;
    el.textContent = st === 'error' ? `${SAVE_STATE_TEXT.error}：${msg || ''}` : (SAVE_STATE_TEXT[st] || '');
    el.className = `nt-save is-${st}`;
  };
  disposeSaver();
  saver = createAutoSave({
    delay: 700,
    read: () => {
      if (!currentNote) return null;
      const title = (pane.querySelector('#nt-title')?.value || '').trim();
      if (!title) return null; // 标题为空不落库：避免刷出一堆「未命名笔记」
      return {
        title,
        content_md: editor ? editor.value() : (pane.querySelector('#nt-md')?.value || ''),
        folder_id: Number(pane.querySelector('#nt-folder-select')?.value) || null,
        tagIds: currentTagIds,
      };
    },
    save: async (payload) => {
      const updated = await api.notes.update(note.id, payload);
      currentNote = updated;
      const info = pane.querySelector('#nt-meta-info');
      if (info) info.textContent = `${updated.word_count || 0} 字 · 更新于 ${fmtDateTime(updated.updated_at)}`;
      return updated;
    },
    onStatus: setStatus,
    onError: (e) => notify((e && e.message) || '保存失败'),
  });

  pane.querySelector('#nt-title')?.addEventListener('input', () => saver.schedule());
  pane.querySelector('#nt-folder-select')?.addEventListener('change', () => saver.flush());
  pane.querySelector('#nt-tag-input')?.addEventListener('change', async (e) => {
    await syncTagIds(e.target.value);
    saver.schedule();
  });
  updateEditorMeta(pane, note);
  renderRefs(pane, note);
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
async function renderRefs(pane, note) {
  const box = pane.querySelector('#nt-refs');
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
}

function disposeSaver() {
  if (saver) { saver.dispose(); saver = null; }
}

function disposeEditor() {
  disposeSaver();
  clearTimeout(previewTimer);
  previewTimer = null;
  try {
    if (editor && typeof editor.toTextArea === 'function') editor.toTextArea();
  } catch (e) { /* 编辑器已随 DOM 移除，忽略 */ }
  editor = null;
  editorNoteId = null;
}

/** 视图被切走时调用（避免已销毁的自动保存器继续写库） */
export function disposeNotes() {
  disposeEditor();
  currentNote = null;
}

/* ---------------- 事件绑定 ---------------- */

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
    else if (act === 'open') { await flushThen(() => { selectedId = id; refresh(root); }); }
    else if (act === 'restore') { await api.notes.restore(id); notify('笔记已恢复'); await refresh(root); }
    else if (act === 'purge') { await purgeNote(id); }
    else if (act === 'mode') { mode = el.dataset.mode; applyMode(mode); }
    else if (act === 'pin') { await api.notes.pin(currentNote.id, !currentNote.pinned); await refresh(root); }
    else if (act === 'archive') { await api.notes.archive(currentNote.id, !currentNote.archived); notify(currentNote.archived ? '已取消归档' : '已归档（仍可被检索与引用）'); await refresh(root); }
    else if (act === 'delete') { await confirmDelete(currentNote); }
    else if (act === 'open-task') { openDetail(id); }
    else if (act === 'unlink-task') {
      await api.taskNotes.unlink(id, Number(el.dataset.note));
      notify('已取消任务关联');
      await refresh(root);
      onChanged();
    }
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

/** 切换笔记前先把未落库的改动写掉 */
async function flushThen(fn) {
  if (saver) await saver.flush();
  fn();
}

async function onToolbar(act) {
  const root = boundRoot;
  if (act === 'new') await createNote();
  else if (act === 'new-folder') await createFolder();
  else if (act === 'new-tag') await createTag();
  else if (act === 'toggle-trash') { showTrash = !showTrash; if (showTrash) showArchived = false; selectedId = null; await refresh(root); }
  else if (act === 'toggle-archived') { showArchived = !showArchived; if (showArchived) showTrash = false; selectedId = null; await refresh(root); }
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
  selectedId = note.id;
  showTrash = false;
  await refresh(boundRoot);
  // 新笔记默认标题是占位文案，直接让用户改标题
  const titleEl = boundRoot?.querySelector('#nt-title');
  if (titleEl) { titleEl.focus(); titleEl.select(); }
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

/* ---------------- 删除策略 ---------------- */

/**
 * 删除笔记：先告知影响面，再让用户选「移入回收站」还是「彻底删除」。
 * - 移入回收站：正文与任务引用都保留，恢复后引用自动复原；笔记从知识库索引里摘除。
 * - 彻底删除：先摘掉所有任务引用（task_notes），再删正文，不可恢复。
 */
async function confirmDelete(note) {
  if (!note) return;
  const tasks = await api.taskNotes.byNote(note.id).catch(() => []);
  const listHtml = tasks.length
    ? `<div class="nt-del-warn">⚠️ 这篇笔记被 ${tasks.length} 个任务引用：</div>
       <ul class="nt-del-list">${tasks.map((t) => `<li>${t.completed ? '✅' : '⏳'} ${esc(t.title)}</li>`).join('')}</ul>`
    : '<div class="nt-del-warn">这篇笔记没有被任务引用，可直接删除。</div>';
  const purgeText = tasks.length ? `彻底删除（解除 ${tasks.length} 个任务引用）` : '彻底删除';
  // 两个动作都放在弹窗内容里（而不是底部 extraButtons）：extraButtons 的 handler 拿不到
  // 关闭回调，会让「彻底删除」之后的 await 永远等下去。
  await openPanelModal({
    title: `删除《${note.title || '未命名笔记'}》`,
    className: 'modal-note-delete',
    html: `${listHtml}
      <div class="nt-del-hint">移入回收站后仍可恢复，任务里的引用也会保留；彻底删除不可恢复。</div>
      <div class="nt-del-ops">
        <button class="ghost-btn" data-del="trash">移入回收站</button>
        <button class="ghost-btn chip-danger" data-del="purge">${esc(purgeText)}</button>
      </div>`,
    okText: '取消',
    onMount: (mask, close) => {
      mask.querySelector('[data-del="trash"]')?.addEventListener('click', async () => {
        close(false);
        await flushThen(() => {});
        await api.notes.trash(note.id);
        notify('笔记已移入回收站');
        selectedId = null;
        await refresh(boundRoot);
      });
      mask.querySelector('[data-del="purge"]')?.addEventListener('click', async () => {
        close(false);
        await purgeNote(note.id);
      });
    },
  });
}

async function purgeNote(id) {
  const res = await api.notes.purge(id).catch((e) => { notify((e && e.message) || '删除失败'); return null; });
  if (!res) return;
  notify(res.unlinkedTasks?.length
    ? `已彻底删除，并解除 ${res.unlinkedTasks.length} 个任务的引用`
    : '已彻底删除');
  if (selectedId === Number(id)) selectedId = null;
  await refresh(boundRoot);
  onChanged();
}

/* ---------------- 知识库问答 ---------------- */

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

      askBtn.addEventListener('click', async () => {
        const q = (qEl.value || '').trim();
        if (!q) return;
        askBtn.disabled = true;
        resultEl.innerHTML = '<div class="kb-loading">检索中…</div>';
        const res = await api.kb.ask({ question: q, topK: 8 }).catch((e) => ({ __err: e.message }));
        askBtn.disabled = false;
        resultEl.innerHTML = kbResultHtml(q, res);
        resultEl.querySelectorAll('[data-kb-act="open"]').forEach((b) => {
          b.addEventListener('click', async () => {
            // 关闭弹窗 → 跳到笔记视图并打开对应笔记
            mask.querySelector('[data-modal="ok"]')?.click();
            await focusNote(Number(b.dataset.id));
          });
        });
      });
    },
  });
}

function kbResultHtml(q, res) {
  if (!res || res.__err) return `<div class="kb-error">检索失败：${esc((res && res.__err) || '未知错误')}</div>`;
  if (res.degraded && res.reason === 'no-hit') return '<div class="kb-empty">知识库里没有命中相关内容。</div>';
  if (res.degraded && res.reason === 'no-ai') {
    return `${kbHitsHtml(res.hits)}<div class="kb-degraded">未配置 AI 接口，以上为本地召回结果（可在菜单栏「AI 设置」里配置后获得总结）。</div>`;
  }
  if (res.degraded) {
    return `${kbHitsHtml(res.hits)}<div class="kb-degraded">AI 调用失败（${esc(res.reason || '')}），以上为本地召回结果。</div>`;
  }
  return `<div class="kb-answer">${renderSafeMarkdown(res.answer || '')}</div>${kbHitsHtml(res.hits)}`;
}

function kbHitsHtml(hits = []) {
  if (!hits.length) return '';
  return `<div class="kb-hits-title">引用来源</div><ul class="kb-hits">${hits.map((h, i) => `
    <li>
      <div class="kb-hit-head">
        <span class="kb-idx">[${i + 1}]</span>
        <button class="kb-hit-title" data-kb-act="open" data-id="${h.noteId ?? ''}">${esc(h.title || '未命名笔记')}</button>
        ${h.headingPath ? `<span class="kb-hit-path">${esc(h.headingPath)}</span>` : ''}
      </div>
      <div class="kb-hit-body">${esc(String(h.content || '').slice(0, 220))}</div>
    </li>`).join('')}</ul>`;
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
      '![图片](https://example.com/a.png)',
      '',
      '| 列 A | 列 B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'))}</div>`,
  });
}
