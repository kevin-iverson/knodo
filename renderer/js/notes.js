'use strict';
/**
 * 笔记视图：目录 / 标签筛选 → 笔记列表（左栏）→ 笔记内容（右栏，就地查看与编辑）。
 *
 * 交互取舍（与任务详情页对齐）：
 * - **左右分栏**：点左栏条目，右栏直接展示该笔记（不再弹窗）——与「任务列表 → 任务详情抽屉」
 *   是同一套心智：列表保持筛选与滚动位置，内容在旁边看 / 改；
 * - **默认预览**：打开笔记先进「预览」，要看源码或改内容再切「分栏 / 编辑」（双击预览区也可直接进编辑）；
 * - 保存 / 取消：改动先落在界面上（防抖自动写库，与任务详情一致），「保存」立即落库，
 *   「取消」整体回滚到打开笔记时的快照；有未落库的改动时状态位显示「● 未保存」，
 *   切换笔记 / 关闭详情会先弹确认（保存 / 放弃 / 留在原处）；
 * - 事件委托只绑一次（#view 是共享容器，重绘 innerHTML 不清监听器，重复绑定会让一次点击触发 N 个处理器）；
 * - 依赖注入（toast / refresh / switchView）而不是直接 import ui.js：ui.js 会 import 本模块的
 *   renderNotes，反向依赖会形成环。项目里 meetings.js / recorder.js 已是同一套做法。
 *
 * 编辑器选型：EasyMDE（CodeMirror 5 内核）提供工具栏、快捷键、列表续行、撤销栈等编辑语义，
 * 预览交给 markdown-it（见 markdown-lib.js）——两者都是成熟库，vendor 进仓库后可离线运行。
 * 颜色 / 高亮用 `==文字=={c:#e5484d;bg:#fff3a3}` 内联标记持久化（不引入原始 HTML，
 * 避免给笔记内容开注入口子），在预览、列表卡片、摘要里由同一套渲染器翻译。
 */
import { api, fmtDateTime } from './api.js';
import { openPanelModal, openFormModal, openPromptModal } from './modal.js';
import { createAutoSave, SAVE_STATE_TEXT } from './autosave.js';
import {
  renderSafeMarkdown, renderStyledInline, highlightKeyword, markKeywordIn,
  wrapStyledText, TEXT_COLORS, BG_COLORS,
} from './markdown-lib.js';
import { openDetail } from './detail.js';
import { openFindBar, closeFindBar, isFindOpen } from './note-find.js';

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
let mode = 'preview';      // 右栏模式：preview（默认） | split | edit
let lastList = [];
let folderList = [];
let tagList = [];
let boundRoot = null;
/** 已绑过事件委托的容器（#view 常驻，重绘内容不清监听器，必须避免重复绑定） */
const boundContainers = new WeakSet();

/* ---------------- 右栏（详情）状态 ---------------- */
let activeNoteId = null;   // 右栏当前笔记
let editor = null;         // EasyMDE 实例
let saver = null;
let currentNote = null;
let currentTagIds = [];
let baseline = null;       // 最近一次「已保存」的快照：「取消」据此回滚
let dirty = false;         // 有未落库的改动
let previewTimer = null;
/** 监听编辑器区域尺寸变化（切换模式 / 窗口缩放后要重新测量 CodeMirror） */
let editorObserver = null;
/** 笔记已被删除：不要再 flush（否则会对着一条已删除的记录保存并报「保存失败」） */
let discardSave = false;
/** 打开笔记时要高亮 / 滚动到的词（搜索结果、知识库溯源） */
let focusTerm = '';

/* ---------------- 弹窗形态的编辑器（任务详情 → 关联笔记） ---------------- */
/** 弹窗容器：detailPane / 状态位 / 保存按钮都要优先命中它（右栏可能根本没开） */
let modalRoot = null;
/** 弹窗的编程式关闭入口（onMount 时取到，删除笔记后用来收窗） */
let modalClose = null;

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
    // 搜索框的监听是「委托在容器上」而不是绑在这个 input 上的（原因见 bindEvents 的注释），
    // 这里只需把关键词回填回去，避免看起来没搜、列表却还被过滤着
    const searchInput = container.querySelector('#nt-search');
    if (searchInput) searchInput.value = keyword;
    await refresh(container);
    // 骨架重建后右栏是空的：把上一篇重新打开，避免「切个视图回来内容没了」
    if (activeNoteId) {
      const keep = activeNoteId;
      activeNoteId = null;
      await openNote(keep);
      return;
    }
    return;
  }
  await refresh(container);
}

/** 供「任务详情 → 跳转查看笔记」调用：切到笔记视图并在右栏打开该笔记 */
export async function focusNote(id, opts = {}) {
  const noteId = Number(id) || null;
  if (!noteId) return;
  showTrash = false;
  await onSwitchView();
  await openNote(noteId, opts);
}

function shellHtml() {
  return `
    <div class="nt-wrap">
      <div class="nt-toolbar">
        <button class="primary-btn" data-nt="new">＋ 新建笔记</button>
        <!-- 搜索框的值由 renderNotes 在骨架重建后按 keyword 回填：
             否则「搜到一半切走再回来」会看到空输入框，却仍处在筛选态 -->
        <input class="nt-search" id="nt-search" type="text" autocomplete="off"
               placeholder="搜索笔记（标题 / 正文全文，实时匹配）" />
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
        <section class="nt-col">
          <div class="nt-list-head" id="nt-list-head"></div>
          <ul class="nt-list" id="nt-list"></ul>
        </section>
        <section class="nt-detail" id="nt-detail"></section>
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
  renderDetailPlaceholder(root);
}

/** 右栏空态：没有选中笔记时给个说明，而不是留一块空白 */
function renderDetailPlaceholder(root) {
  const box = root && root.querySelector ? root.querySelector('#nt-detail') : null;
  if (!box || activeNoteId) return;
  box.innerHTML = `
    <div class="nt-empty-pane">
      <div class="nt-empty-ico">📝</div>
      <div>从左侧选一篇笔记</div>
      <div class="nt-empty-sub">右侧会直接展示内容；默认预览，切「编辑」或双击正文即可修改。</div>
    </div>`;
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
  const head = root.querySelector('#nt-list-head');
  if (head) head.innerHTML = listHeadHtml();
  const bar = showTrash && list.length
    ? `<li class="nt-trash-bar">
         <span>回收站里的笔记可恢复；彻底删除不可恢复。</span>
         <button class="ghost-btn tiny chip-danger" data-nt="empty-trash">清空回收站（${list.length}）</button>
       </li>`
    : '';
  ul.innerHTML = bar + (list.length
    ? list.map(noteItemHtml).join('')
    : (showTrash
      ? '<li class="nt-empty"><div class="nt-empty-ico">🗑</div><div>回收站是空的</div></li>'
      : emptyListHtml()));
}

/** 左栏顶部统计：搜索态要能一眼看到「几篇 / 几处」，并给一个退出搜索的入口 */
function listHeadHtml() {
  if (keyword) {
    const hits = lastList.reduce((n, x) => n + (Number(x.matchCount) || 0), 0);
    return `<span class="nt-lh-kw">匹配 <b>${lastList.length}</b> 篇 · <b>${hits}</b> 处</span>
            <button class="mini-btn" data-nt="clear-search">清除搜索</button>`;
  }
  return `<span class="nt-lh-kw">${showTrash ? '回收站' : (showArchived ? '归档夹' : '全部笔记')} <b>${lastList.length}</b> 篇</span>`;
}

function emptyListHtml() {
  if (keyword) {
    return `<li class="nt-empty">
      <div class="nt-empty-ico">🔍</div>
      <div>没有匹配「${esc(keyword)}」的笔记</div>
      <div class="nt-empty-sub">已搜索标题与正文全文。可换个更短的词、检查是不是在归档夹 / 回收站里。</div>
      <button class="ghost-btn" data-nt="clear-search">清除搜索</button>
    </li>`;
  }
  return `<li class="nt-empty">
    <div class="nt-empty-ico">📝</div>
    <div>还没有笔记</div>
    <div class="nt-empty-sub">把想法、会议记录、技术方案都沉淀成笔记，之后可关联任务、供 AI 检索</div>
    <button class="primary-btn" data-nt="new">＋ 新建笔记</button>
  </li>`;
}

function noteItemHtml(n) {
  const tags = (n.tags || []).map((t) => `<span class="nt-chip" style="--c:${esc(t.color || '#8896ab')}">${esc(t.name)}</span>`).join('');
  const active = Number(activeNoteId) === Number(n.id);
  // 搜索态：标题与片段都做关键词高亮，并标出这篇命中了几处
  const titleHtml = keyword ? highlightKeyword(n.title || '未命名笔记', keyword) : esc(n.title || '未命名笔记');
  const excerptHtml = keyword && n.snippet
    ? highlightKeyword(n.snippet, keyword)
    : renderStyledInline(n.excerpt || '（空笔记）', 160);
  return `
    <li class="nt-item${active ? ' active' : ''}" data-nt-act="open" data-id="${n.id}">
      <div class="nt-item-head">
        <span class="nt-item-title">${n.pinned ? '📌 ' : ''}${titleHtml}</span>
        ${n.archived ? '<span class="nt-chip">已归档</span>' : ''}
        ${n.deleted_at ? `<span class="nt-chip nt-chip-danger">回收站 ${esc(fmtDateTime(n.deleted_at))}</span>` : ''}
        ${keyword && Number(n.matchCount) > 0 ? `<span class="nt-chip nt-chip-hit" title="标题与正文共命中 ${n.matchCount} 处">${n.matchCount} 处</span>` : ''}
        <span class="nt-item-ops">
          ${showTrash ? `
            <button class="mini-btn" data-nt-act="restore" data-id="${n.id}">恢复</button>
            <button class="mini-btn" data-nt-act="purge" data-id="${n.id}">彻底删除</button>`
    : `
            <button class="mini-btn" data-nt-act="archive" data-id="${n.id}">${n.archived ? '取消归档' : '归档'}</button>
            <button class="mini-btn" data-nt-act="delete" data-id="${n.id}">删除</button>`}
        </span>
      </div>
      <div class="nt-item-excerpt">${excerptHtml}</div>
      <div class="nt-item-meta">
        <span>${fmtDateTime(n.updated_at)}</span>
        <span>${n.word_count || 0} 字</span>
        ${n.attachments && n.attachments.length ? `<span title="${n.attachments.length} 张图片">🖼 ${n.attachments.length}</span>` : ''}
        ${n.ref_count ? `<span class="nt-ref-badge" title="被 ${n.ref_count} 个任务引用">🔗 ${n.ref_count}</span>` : ''}
        ${tags}
      </div>
    </li>`;
}

/** 保存后只换这一行：整表重绘会丢滚动位置与选中态 */
function updateListItem(note) {
  const ul = boundRoot && boundRoot.querySelector ? boundRoot.querySelector('#nt-list') : null;
  if (!ul || !note) return;
  const idx = lastList.findIndex((x) => Number(x.id) === Number(note.id));
  if (idx < 0) return;
  lastList[idx] = { ...lastList[idx], ...note };
  const li = ul.querySelector(`.nt-item[data-id="${note.id}"]`);
  if (li) li.outerHTML = noteItemHtml(lastList[idx]);
  const head = boundRoot.querySelector('#nt-list-head');
  if (head) head.innerHTML = listHeadHtml();
}

/* ---------------- 右栏：笔记详情（就地查看 / 编辑） ---------------- */

function detailHtml(note) {
  const segBtn = (m, label) =>
    `<button type="button" class="nt-seg-btn${mode === m ? ' active' : ''}" data-nt-act="mode" data-mode="${m}">${label}</button>`;
  return `
    <div class="nt-dp" data-id="${note.id}" data-mode="${mode}">
      <div class="nt-dp-head">
        <input class="nt-dp-title" type="text" maxlength="120" placeholder="未命名笔记"
               value="${esc(note.title || '')}" />
        <div class="nt-seg" role="group" aria-label="显示模式">
          ${segBtn('preview', '预览')}${segBtn('split', '分栏')}${segBtn('edit', '编辑')}
        </div>
        <button class="nt-dp-close" data-nt-act="dp-close" title="关闭（有未保存改动会先提示）">×</button>
      </div>
      <div class="nt-dp-meta">
        <label class="nt-field">
          <span class="nt-field-label">目录</span>
          <select class="nt-folder-select">${folderOptionsHtml(note.folder_id)}</select>
        </label>
        <label class="nt-field nt-field-tags">
          <span class="nt-field-label">标签</span>
          <input class="nt-tag-input" type="text" placeholder="逗号分隔，如：方案，复盘"
                 value="${esc((note.tags || []).map((t) => t.name).join('，'))}" />
        </label>
        <span class="nt-meta-info" id="nt-meta-info"></span>
      </div>
      <div class="nt-dp-scroll">
        <div class="nt-dp-body">
          <div class="nt-pane">
            <textarea id="nt-md"></textarea>
          </div>
          <div class="nt-preview markdown-body" id="nt-preview"></div>
        </div>
        <div class="nt-att" id="nt-att"></div>
        <div class="nt-refs" id="nt-refs"></div>
      </div>
      <div class="nt-dp-foot">
        <button class="ghost-btn" data-nt-act="dp-pin">${note.pinned ? '取消置顶' : '📌 置顶'}</button>
        <button class="ghost-btn" data-nt-act="dp-archive">${note.archived ? '取消归档' : '🗄 归档'}</button>
        <button class="danger-btn" data-nt-act="dp-delete">删除</button>
        <span class="nt-spacer"></span>
        <span class="nt-dp-state"></span>
        <button class="ghost-btn" data-nt-act="dp-cancel">取消</button>
        <button class="primary-btn" data-nt-act="dp-save">保存</button>
      </div>
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

/**
 * 打开一篇笔记到右栏。
 * @param {number} id
 * @param {{mode?:string, focusTitle?:boolean, focusTerm?:string}} [opts]
 */
export async function openNote(id, opts = {}) {
  const noteId = Number(id);
  if (!noteId) return null;
  // 切换到别的笔记前先处理未保存改动（保存 / 放弃 / 留在原处）
  if (activeNoteId && activeNoteId !== noteId && !(await guardUnsaved())) return null;

  const note = await api.notes.get(noteId).catch(() => null);
  if (!note) { notify('笔记不存在或已被删除'); return null; }

  activeNoteId = note.id;
  currentNote = note;
  currentTagIds = (note.tags || []).map((t) => t.id);
  baseline = { id: note.id, title: note.title || '', content_md: note.content_md || '', folder_id: note.folder_id ?? null, tagIds: [...currentTagIds] };
  discardSave = false;
  dirty = false;
  focusTerm = opts.focusTerm || (keyword && !showTrash ? keyword : '');
  mode = opts.mode || (opts.focusTitle ? 'edit' : 'preview'); // 默认预览可编辑

  const box = (() => {
    const scope = modalRoot || boundRoot;
    return scope && scope.querySelector ? scope.querySelector('#nt-detail') : null;
  })();
  if (!box) return null;
  // 先销毁上一篇的编辑器 / 保存器，再换 DOM：
  // 反过来的话 toTextArea() 要在已经脱离文档的 CodeMirror 上拆结构，容易抛错
  disposeEditor();
  box.innerHTML = detailHtml(note);
  const pane = box.querySelector('.nt-dp');

  mountEditor(pane, note);
  bindSaver(pane, note);
  switchMode(mode);
  renderAttachments(pane, note);
  renderRefs(pane, note);
  updateDetailMeta(pane, note);
  markListActive(note.id);

  if (opts.focusTitle) {
    const titleEl = pane.querySelector('.nt-dp-title');
    if (titleEl) { titleEl.focus(); titleEl.select(); }
  } else if (mode === 'edit') {
    try { editor && editor.codemirror && editor.codemirror.focus(); } catch (e) { /* 忽略 */ }
  }
  return note;
}

/** 左栏选中态跟随右栏（只切 class，不重绘列表） */
function markListActive(id) {
  if (!boundRoot) return;
  boundRoot.querySelectorAll('.nt-item').forEach((li) => {
    li.classList.toggle('active', Number(li.dataset.id) === Number(id));
  });
}

function updateDetailMeta(pane, note) {
  const info = pane.querySelector('#nt-meta-info');
  if (info) info.textContent = `${note.word_count || 0} 字 · 更新于 ${fmtDateTime(note.updated_at)}`;
}

function mountEditor(pane, note) {
  const ta = pane.querySelector('#nt-md');
  if (!ta) return;
  const MDE = window.EasyMDE;

  if (!MDE) {
    // 库缺失时降级为纯 textarea，不让编辑器整个打不开
    ta.value = note.content_md || '';
    ta.className = 'nt-md-fallback';
    ta.addEventListener('input', () => {
      if (saver) saver.schedule();
      schedulePreviewRefresh();
    });
    return;
  }

  editor = new MDE({
    element: ta,
    initialValue: note.content_md || '',
    autoDownloadFontAwesome: false, // 离线运行：图标由 CSS ::after 提供文字/符号
    spellChecker: false,
    status: false,
    // 关掉「分栏即全屏」的默认行为：EasyMDE 的分栏是给整页编辑器设计的，
    // 在受限容器里会把编辑器变成 position:fixed 盖住整个应用。
    sideBySideFullscreen: false,
    placeholder: '支持 Markdown：# 标题、- 列表、```代码块```、[链接](url)、| 表格 |；截图可直接粘贴',
    previewRender: (plain) => renderSafeMarkdown(plain),
    toolbar: toolbarConfig(MDE, note.id),
  });
  // 图片粘贴 / 拖拽：自己接管插入。
  // 不走 EasyMDE 的 uploadImage / imageUploadFunction —— 它内部的插入分支（P()/G()）在
  // 某些光标状态下会把整行替换成自身，导致「图片存好了但正文没插入」；自己插更可控。
  bindImagePaste(editor.codemirror, note.id);
  // 正文变化：防抖落库 + 刷新预览（预览面板是我们自己的 DOM，EasyMDE 不会替我们更新）
  editor.codemirror.on('change', () => {
    if (saver) saver.schedule();
    schedulePreviewRefresh();
  });
  if (typeof ResizeObserver === 'function') {
    // 回调里 refresh() 又会改布局，直接同步处理会报「ResizeObserver loop」告警，
    // 挪到下一帧再测量即可消除
    const ro = new ResizeObserver(() => requestAnimationFrame(() => refreshEditorLayout()));
    ro.observe(pane.querySelector('.nt-dp-body') || pane);
    editorObserver = ro;
  }
  // 双击预览区直接进编辑（比先找「编辑」按钮更快）
  const preview = pane.querySelector('#nt-preview');
  if (preview) preview.addEventListener('dblclick', () => switchMode('edit'));
}

/** CodeMirror 的尺寸变了（切换模式 / 窗口缩放）后要重新测量一次 */
function refreshEditorLayout() {
  if (!editor) return;
  try { editor.codemirror.refresh(); } catch (e) { /* 编辑器已销毁 */ }
}

function toolbarConfig(MDE, noteId) {
  const t = (name, action, cls, title) => ({ name, action, className: cls, title });
  // 按钮数量控制在「分栏时也能一行放下」：分栏后的编辑区只有一半宽，
  // 多放两个图标就会横向滚动、右侧图标被切掉（视觉上像坏了）。
  return [
    t('bold', MDE.toggleBold, 'nt-ico-bold', '加粗 (Ctrl+B)'),
    t('italic', MDE.toggleItalic, 'nt-ico-italic', '斜体 (Ctrl+I)'),
    '|',
    t('heading-1', MDE.toggleHeading1, 'nt-ico-h1', '一级标题'),
    t('heading-2', MDE.toggleHeading2, 'nt-ico-h2', '二级标题'),
    t('heading-3', MDE.toggleHeading3, 'nt-ico-h3', '三级标题'),
    '|',
    // 字体颜色 / 背景高亮：两种样式都写进 `==文字=={c:..;bg:..}` 标记，随正文一起持久化
    t('text-color', () => openPalette('color'), 'nt-ico-color', '字体颜色'),
    t('bg-color', () => openPalette('bg'), 'nt-ico-bg', '背景高亮（文字标记）'),
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
    t('guide', () => showGuide(), 'nt-ico-help', 'Markdown 语法帮助'),
  ];
}

/* ---------------- 颜色 / 高亮（工具栏） ---------------- */

let paletteEl = null;

/** 关掉色板（点外部 / Esc / 选完色都会走到这里） */
function closePalette() {
  if (paletteEl) { paletteEl.remove(); paletteEl = null; }
  document.removeEventListener('mousedown', onPaletteOutside, true);
  document.removeEventListener('keydown', onPaletteKey, true);
}

function onPaletteOutside(e) {
  if (!paletteEl) return;
  const t = e.target;
  const inBar = t && typeof t.closest === 'function' ? t.closest('.editor-toolbar') : null;
  if (!paletteEl.contains(t) && !inBar) closePalette();
}
function onPaletteKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closePalette(); }
}

/**
 * 打开取色板（挂在 body 上，避免被编辑区裁剪）。
 * @param {'color'|'bg'} kind
 */
function openPalette(kind) {
  if (paletteEl) { closePalette(); return; }
  const anchor = document.querySelector(`.nt-dp .editor-toolbar button.nt-ico-${kind === 'color' ? 'color' : 'bg'}`);
  const list = kind === 'color' ? TEXT_COLORS : BG_COLORS;
  paletteEl = document.createElement('div');
  paletteEl.className = 'nt-palette';
  paletteEl.innerHTML = `
    <div class="nt-palette-title">${kind === 'color' ? '字体颜色' : '背景高亮'}</div>
    <div class="nt-palette-grid">
      ${list.map((c) => `
        <button type="button" class="nt-swatch" data-color="${esc(c.v)}" title="${esc(c.label)}">
          <i style="background:${esc(c.v)}"></i>
        </button>`).join('')}
    </div>
    <button type="button" class="nt-palette-clear" data-color="">清除${kind === 'color' ? '颜色' : '高亮'}</button>`;
  document.body.appendChild(paletteEl);

  // 定位在按钮下方（贴边时向左收，避免超出窗口）
  const r = anchor ? anchor.getBoundingClientRect() : { left: 200, bottom: 120, width: 28 };
  const width = paletteEl.offsetWidth || 168;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  paletteEl.style.left = `${left}px`;
  paletteEl.style.top = `${Math.min(r.bottom + 6, window.innerHeight - (paletteEl.offsetHeight || 140) - 8)}px`;

  paletteEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    applyTextStyle(kind, b.dataset.color);
    closePalette();
  });
  document.addEventListener('mousedown', onPaletteOutside, true);
  document.addEventListener('keydown', onPaletteKey, true);
}

/**
 * 给选中的文字上色 / 高亮（没选就取光标所在词）。
 * @param {'color'|'bg'} kind
 * @param {string} value #hex；空串 = 清除这一类样式
 */
function applyTextStyle(kind, value) {
  const cm = editor && editor.codemirror;
  if (!cm) { notify('请先切到「编辑 / 分栏」模式'); return; }
  if (!cm.getSelection()) {
    // 没选内容就作用在光标所在的词上，省一步「先拖选」
    try {
      const w = cm.findWordAt(cm.getCursor());
      cm.setSelection(w.anchor, w.head);
    } catch (e) { /* 光标在空行：取不到词就算了 */ }
  }
  const sel = cm.getSelection();
  if (!sel.trim()) { notify('请选中一段文字再设置颜色'); return; }
  cm.replaceSelection(wrapStyledText(sel, kind, value));
  if (saver) saver.schedule();
  schedulePreviewRefresh();
  try { cm.focus(); } catch (e) { /* 忽略 */ }
}

/* ---------------- 图片（复用 attachments.js 落盘规则） ---------------- */

/**
 * 绑定「粘贴 / 拖拽图片」：落盘后把 Markdown 引用插到光标处。
 * 只处理 image/* 的条目，其它粘贴（文本、文件）交还给 CodeMirror 原样处理。
 */
function bindImagePaste(cm, noteId) {
  const takeFiles = (files) => {
    const imgs = [...(files || [])].filter((f) => /^image\//i.test(f && f.type ? f.type : ''));
    if (!imgs.length) return false;
    imgs.forEach(async (f) => {
      try {
        const url = await uploadNoteImage(noteId, f);
        insertImageMarkdown(cm, f.name || '图片', url);
        schedulePreviewRefresh();
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
  renderAttachments(detailPane(), currentNote);
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
    renderAttachments(detailPane(), currentNote);
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
async function renderAttachments(pane, note) {
  const box = pane && pane.querySelector ? pane.querySelector('#nt-att') : null;
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
          renderAttachments(pane, currentNote);
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

/* ---------------- 模式切换 / 保存 / 取消 ---------------- */

function detailPane() {
  const scope = modalRoot || boundRoot;
  return scope && scope.querySelector ? scope.querySelector('.nt-dp') : null;
}

function switchMode(m) {
  const pane = detailPane();
  if (!pane) return;
  mode = m || 'preview';
  pane.dataset.mode = mode;
  pane.querySelectorAll('[data-nt-act="mode"]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  if (mode !== 'edit') refreshPreview();
  // 切换后编辑器宽度变了 → 重新测量（否则行号 / 光标的横向位置会错）
  if (mode !== 'preview') {
    setTimeout(() => {
      refreshEditorLayout();
      // 查找 / 替换浮条开着时不要抢焦点（Ctrl+F 会自动切到分栏，这时焦点该留在查找框里）
      if (isFindOpen()) return;
      try { editor && editor.codemirror.focus(); } catch (e) { /* 忽略 */ }
    }, 20);
  }
}

/** 预览刷新防抖（打字时不逐字符重渲 markdown） */
function schedulePreviewRefresh() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => refreshPreview(), 220);
}

/**
 * 把当前正文渲染进预览面板。
 * 预览面板是自己渲染的（不是 EasyMDE 的 .editor-preview），所以样式与列表摘要、
 * 知识库答案完全一致，也不受 EasyMDE 全屏/分栏那套 fixed 布局影响。
 */
function refreshPreview() {
  const pane = detailPane();
  if (!pane) return;
  const box = pane.querySelector('#nt-preview');
  if (!box) return;
  const text = editor ? editor.value() : (pane.querySelector('#nt-md')?.value || '');
  box.innerHTML = String(text || '').trim()
    ? renderSafeMarkdown(text)
    : '<div class="nt-preview-empty">正文为空。切到「编辑」开始写，这里会实时渲染 Markdown。</div>';
  // 搜索词 / 知识库溯源词：渲染完再把命中处标出来（含滚动定位）
  if (focusTerm) {
    markKeywordIn(box, focusTerm);
    const first = box.querySelector('.kw-hit');
    if (first && typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'center' });
  }
}

/** 当前表单值（自动保存与「保存」按钮共用，保证两条路径写入一致） */
function readPayload() {
  const pane = detailPane();
  if (!pane || !currentNote) return null;
  // 标题允许留空：新建笔记时用户可能先写正文（标题先被清空过），
  // 以前这里返回 null 会让整篇笔记（含正文）都保存不了 —— 表现就是「新建笔记没用」。
  // 空标题在列表里统一显示为「未命名笔记」。
  return {
    title: (pane.querySelector('.nt-dp-title')?.value || '').trim(),
    content_md: editor ? editor.value() : (pane.querySelector('#nt-md')?.value || ''),
    folder_id: Number(pane.querySelector('.nt-folder-select')?.value) || null,
    tagIds: currentTagIds,
  };
}

function setSaveState(st, msg) {
  const pane = detailPane();
  const el = pane ? pane.querySelector('.nt-dp-state') : null;
  if (!el) return;
  dirty = st === 'pending' || st === 'error';
  el.textContent = st === 'error'
    ? `${SAVE_STATE_TEXT.error}：${msg || ''}`
    : (st === 'pending' ? `● ${SAVE_STATE_TEXT.pending}` : (st === 'saved' ? `${SAVE_STATE_TEXT.saved} ${nowLabel()}` : SAVE_STATE_TEXT[st] || ''));
  el.className = `nt-dp-state is-${st}`;
  el.title = st === 'error' ? '保存失败，点击重试' : '修改会自动保存，也可点「保存」立即写入';
}

/** 保存状态的时间戳（"已保存 14:03" 比干巴巴的"已保存"更有说服力） */
function nowLabel() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 标题 / 目录 / 标签 / 正文的即时保存（与任务详情同一套防抖保存器） */
function bindSaver(pane, note) {
  disposeSaver();
  saver = createAutoSave({
    delay: 900,
    read: readPayload,
    save: async (payload) => {
      const updated = await api.notes.update(note.id, payload);
      currentNote = updated;
      // 不重绘详情（会打断输入 / 丢失光标），只同步列表行与字数
      updateListItem(updated);
      updateDetailMeta(pane, updated);
      // 基线跟着「已保存」往前走：否则自动保存写库后再点「取消」会把已保存的内容一起撤掉，
      // 用户看到「已保存 14:53」却回到更早的版本，语义自相矛盾。取消 = 撤销自上次保存以来的改动。
      baseline = {
        id: note.id,
        title: payload.title || '',
        content_md: payload.content_md || '',
        folder_id: payload.folder_id ?? null,
        tagIds: [...(payload.tagIds || [])],
      };
      return updated;
    },
    onStatus: setSaveState,
    onError: (e) => notify((e && e.message) || '保存失败'),
  });
  // 基线 = 打开时的内容：没改动就不写库（否则每次开关都会白白刷新「更新于」）
  try { saver.setBaseline(readPayload()); } catch (e) { /* 读失败时退化为「首轮必写」 */ }
  setSaveState('idle');
}

/** 立即写入（点「保存」/ 切换笔记前） */
async function flushNow() {
  if (!saver || discardSave) return;
  await saver.flush().catch((e) => { notify((e && e.message) || '保存失败'); });
}

/**
 * 「取消」：回滚到「最后一次保存到库的状态」（每次保存成功后 baseline 都会前移）。
 * 已在编辑器里但还没落库的改动会被丢弃；自动保存过的内容不会被误撤。
 */
async function cancelEdit() {
  if (!baseline || !currentNote) return;
  const cur = readPayload();
  const same = cur && cur.title === baseline.title
    && cur.content_md === baseline.content_md
    && (cur.folder_id || null) === (baseline.folder_id || null)
    && (cur.tagIds || []).join(',') === (baseline.tagIds || []).join(',');
  if (same) { notify('没有需要放弃的改动'); return; }
  if (saver) saver.cancel();
  const updated = await api.notes.update(baseline.id, {
    title: baseline.title,
    content_md: baseline.content_md,
    folder_id: baseline.folder_id,
    tagIds: baseline.tagIds,
  }).catch(() => null);
  if (!updated) { notify('放弃改动失败，请重试'); return; }
  currentNote = updated;
  currentTagIds = [...baseline.tagIds];
  dirty = false;
  const pane = detailPane();
  if (pane) {
    pane.querySelector('.nt-dp-title').value = updated.title || '';
    pane.querySelector('.nt-tag-input').value = (updated.tags || []).map((t) => t.name).join('，');
    const sel = pane.querySelector('.nt-folder-select');
    if (sel) sel.value = String(updated.folder_id ?? UNFILED);
    if (editor) editor.value(updated.content_md || '');
    else {
      const ta = pane.querySelector('#nt-md');
      if (ta) ta.value = updated.content_md || '';
    }
    updateDetailMeta(pane, updated);
  }
  refreshPreview();
  updateListItem(updated);
  setSaveState('idle');
  notify('已放弃未保存的改动');
}

/**
 * 有未落库的改动时提示用户（切换笔记 / 关闭详情前调用）。
 * @returns {Promise<boolean>} true = 可以继续；false = 留在原处
 */
async function guardUnsaved() {
  if (!dirty) return true;
  const choice = await new Promise((resolve) => {
    openPanelModal({
      title: '有未保存的改动',
      className: 'modal-note-unsaved',
      html: `<div class="nt-del-hint">这篇笔记的改动还没保存到本地。要先保存吗？</div>
        <div class="nt-del-ops">
          <button class="primary-btn" data-us="save">保存</button>
          <button class="ghost-btn chip-danger" data-us="discard">放弃改动</button>
          <button class="ghost-btn" data-us="stay">留在原处</button>
        </div>`,
      okText: '留在原处',
      onMount: (mask, close) => {
        // 先 resolve 再 close：close() 会触发 onClose（那里也有一次 resolve('stay')），
        // Promise 只认第一次决议，顺序反了会让操作静默失效。
        mask.querySelector('[data-us="save"]')?.addEventListener('click', () => { resolve('save'); close(false); });
        mask.querySelector('[data-us="discard"]')?.addEventListener('click', () => { resolve('discard'); close(false); });
        mask.querySelector('[data-us="stay"]')?.addEventListener('click', () => { resolve('stay'); close(false); });
      },
      onClose: () => resolve('stay'),
    });
  });
  if (choice === 'save') { await flushNow(); return true; }
  if (choice === 'discard') { await cancelEdit(); return true; }
  return false;
}

/** 关闭右栏（空出宽度给列表） */
async function closeDetailPane() {
  if (!(await guardUnsaved())) return;
  closeDetailPaneSilent();
}

/** 静默收掉右栏（打开弹窗前用：editor / saver 是模块级单例，不能两处同时挂） */
function closeDetailPaneSilent() {
  disposeEditor();
  activeNoteId = null;
  currentNote = null;
  baseline = null;
  closePalette();
  const box = boundRoot && boundRoot.querySelector ? boundRoot.querySelector('#nt-detail') : null;
  if (box) box.innerHTML = '';
  markListActive(null);
  renderDetailPlaceholder(boundRoot);
}

/* ---------------- 弹窗编辑器（任务详情 → 关联笔记时弹出，不跳视图） ---------------- */

/**
 * 以弹窗打开笔记编辑器。
 * 与右栏共用同一套 detailHtml / mountEditor / bindSaver（modalRoot 让 detailPane 优先
 * 命中弹窗里的面板），事件委托单独绑在弹窗节点上——弹窗挂在 body 下，不在 #view 里。
 * @param {number} id 笔记 id
 */
export async function openNoteModal(id) {
  const noteId = Number(id);
  if (!noteId) return null;
  if (modalRoot) { if (modalClose) modalClose(); return null; } // 已开着：不叠第二层
  // 右栏若开着别的编辑器先收掉（静默收，有未落库改动直接兜底写掉）
  if (activeNoteId) {
    if (dirty && saver) await saver.flush().catch(() => {});
    closeDetailPaneSilent();
  }
  const note = await api.notes.get(noteId).catch(() => null);
  if (!note) { notify('笔记不存在或已被删除'); return null; }

  return openPanelModal({
    title: '笔记',
    className: 'modal-note-editor',
    html: '<div id="nt-detail"></div>',
    okText: '完成',
    showClose: true,
    resizable: true,
    resizeKey: 'note-editor',
    minWidth: 640,
    minHeight: 480,
    onMount: async (mask, close) => {
      modalRoot = mask;
      modalClose = close;
      bindModalEvents(mask);
      await openNote(noteId); // 默认预览：先看内容，要改再切「编辑 / 分栏」
    },
    // Esc / ✕ / 「完成」：把最后一次输入写掉再拆编辑器（discardSave 时跳过，笔记已删）
    onClose: () => {
      closePalette();
      if (!discardSave) flushNow().catch(() => {});
      disposeEditor();
      modalRoot = null;
      modalClose = null;
      // 列表摘要 / 引用徽章可能变了，笔记视图若在就局部重绘
      if (boundRoot) refresh(boundRoot).catch(() => {});
      onChanged();
    },
  });
}

/** 弹窗内的事件委托（与 bindEvents 的右栏分支同语义，但只服务弹窗面板） */
function bindModalEvents(mask) {
  mask.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-nt-act]');
    if (!el) return;
    const act = el.dataset.ntAct;
    if (act === 'mode') switchMode(el.dataset.mode);
    else if (act === 'dp-close') { if (modalClose) modalClose(); }
    else if (act === 'dp-save') { await flushNow(); notify('已保存'); }
    else if (act === 'dp-cancel') await cancelEdit();
    else if (act === 'dp-pin') await togglePin();
    else if (act === 'dp-archive') await toggleArchive();
    else if (act === 'dp-delete') await deleteFromDetail();
  });
  mask.addEventListener('input', (e) => {
    if (e.target.closest && e.target.closest('.nt-dp') && saver) saver.schedule();
  });
  mask.addEventListener('change', async (e) => {
    if (!e.target.closest || !e.target.closest('.nt-dp')) return;
    if (e.target.classList.contains('nt-tag-input')) {
      await syncTagIds(e.target.value);
      if (saver) saver.schedule();
    } else if (e.target.classList.contains('nt-folder-select')) {
      if (saver) await saver.flush();
    }
  });
  // 与右栏同一套快捷键（弹窗挂在 body 下，#view 的委托够不到它，得自己绑一份）
  mask.addEventListener('keydown', handleFindShortcut, true);
  mask.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && e.target.closest && e.target.closest('.nt-dp')) {
      e.preventDefault();
      flushNow().then(() => notify('已保存'));
    }
  });
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
    else if (act === 'open') { await openNote(id); }
    else if (act === 'restore') { await api.notes.restore(id); notify('笔记已恢复'); await refresh(root); }
    else if (act === 'purge') { await purgeNote(id); }
    else if (act === 'archive') { await toggleArchiveById(id); }
    else if (act === 'delete') { await confirmDeleteById(id); }
    // ---- 右栏 ----
    else if (act === 'mode') { switchMode(el.dataset.mode); }
    else if (act === 'dp-close') { await closeDetailPane(); }
    else if (act === 'dp-save') { await flushNow(); notify('已保存'); }
    else if (act === 'dp-cancel') { await cancelEdit(); }
    else if (act === 'dp-pin') { await togglePin(); }
    else if (act === 'dp-archive') { await toggleArchive(); }
    else if (act === 'dp-delete') { await deleteFromDetail(); }
  });

  // 输入框混用两种绑定方式会踩坑：
  // bindEvents 只在「骨架首次创建」时执行一次（容器进了 WeakSet 就不再重复绑），
  // 而切走再回来时骨架会重建、#nt-search 是全新节点 —— 直接挂在旧节点上的监听就永远失联了，
  // 表现为「顶部搜索框打不出结果」。所以搜索框与其他输入一样走容器级委托。
  root.addEventListener('input', (e) => {
    if (e.target.id === 'nt-search') { scheduleSearch(root, e.target.value); return; }
    if (e.target.closest('.nt-dp') && saver) saver.schedule();
  });
  root.addEventListener('change', async (e) => {
    if (!e.target.closest('.nt-dp')) return;
    if (e.target.classList.contains('nt-tag-input')) {
      await syncTagIds(e.target.value);
      if (saver) saver.schedule();
    } else if (e.target.classList.contains('nt-folder-select')) {
      if (saver) await saver.flush();
    }
  });
  // 点状态标签 → 立即重试
  root.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('nt-dp-state') && saver) saver.flush();
  });
  // 捕获阶段吃掉 Ctrl+F / Ctrl+H：CodeMirror 的默认键表里本身就绑了 Ctrl-F → find
  // （lib/codemirror.js 的 pcDefault）—— 虽然 search 插件没一起打包、实际不会执行，
  // 但在捕获阶段先拦最稳，避免以后补了插件再跟它抢按键
  root.addEventListener('keydown', handleFindShortcut, true);
  root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && e.target.closest('.nt-dp')) {
      e.preventDefault();
      flushNow().then(() => notify('已保存'));
      return;
    }
    // 搜索框：Enter 立即检索（不等防抖），Esc 退出搜索
    if (e.target.id === 'nt-search') {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(root, e.target.value); }
      else if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
    }
  });
}

/* ---------------- 顶部搜索（标题 / 正文全文） ---------------- */

/** 输入停顿 220ms 才检索；本地 FTS + LIKE 兜底，足够快 */
let searchTimer = null;
function scheduleSearch(root, value) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(root, value), 220);
}

/** 执行一次检索（防抖到期 / Enter 都会走到这里） */
async function runSearch(root = boundRoot, value = '') {
  const next = String(value == null ? '' : value).trim();
  if (next === keyword) return;
  keyword = next;
  if (keyword) showTrash = false; // 搜索优先：不用再手动退出回收站才看得到结果
  if (!root) return;
  await loadList(root);
  syncToolbar(root);
}

/* ---------------- 正文查找 / 替换（Ctrl+F / Ctrl+H） ---------------- */

/** 找 / 替换的目标：编辑器可能还没挂好，所以传 getter 而不是直接传实例 */
function findTarget() {
  return {
    pane: detailPane(),
    getCm: () => (editor && editor.codemirror) || null,
    onChange: () => { if (saver) saver.schedule(); schedulePreviewRefresh(); },
  };
}

/** 打开浮条：没编辑器要给出可用提示，而不是默默什么都不发生 */
function openNoteFind({ replace = false } = {}) {
  const pane = detailPane();
  if (!pane) return;
  const target = findTarget();
  if (!target.getCm()) { notify('先双击正文或切到「分栏 / 编辑」，再查找替换'); return; }
  // 预览模式下编辑区是 display:none 的，命中标记看不见 —— 自动切成「分栏」，
  // 左边看源码里的高亮、右边看渲染结果，不必再手动切一次
  if (mode === 'preview') switchMode('split');
  const seed = editor && editor.codemirror ? editor.codemirror.getSelection() : '';
  const ok = openFindBar({ ...target, replace, seed });
  if (!ok) notify('编辑器还没准备好，请稍后再试');
}

/**
 * 快捷键判定（右栏与弹窗共用）。
 * 只吃「焦点落在笔记详情面板内」的 Ctrl+F / Ctrl+H —— 列表搜索框等处的 Ctrl+F 不受影响。
 * @returns {boolean} 是否已消费该按键
 */
function handleFindShortcut(e) {
  if (!e || e.altKey) return false;
  const k = String(e.key || '');
  const t = e.target;
  const inPane = !!(t && typeof t.closest === 'function' && t.closest('.nt-dp'));
  if (!inPane) return false;

  // 浮条开着时 Esc 也能关（焦点可能仍在正文里，浮条自己的 keydown 收不到）
  if (k === 'Escape') {
    if (!isFindOpen()) return false;
    e.preventDefault();
    e.stopPropagation();
    closeFindBar();
    return true;
  }

  if (!(e.ctrlKey || e.metaKey)) return false;
  const lower = k.toLowerCase();
  if (lower !== 'f' && lower !== 'h') return false;
  e.preventDefault();
  e.stopPropagation();
  openNoteFind({ replace: lower === 'h' });
  return true;
}

async function onToolbar(act) {
  const root = boundRoot;
  if (act === 'new') await createNote();
  else if (act === 'new-folder') await createFolder();
  else if (act === 'new-tag') await createTag();
  else if (act === 'clear-search') await clearSearch();
  else if (act === 'toggle-trash') { showTrash = !showTrash; if (showTrash) showArchived = false; await refresh(root); }
  else if (act === 'toggle-archived') { showArchived = !showArchived; if (showArchived) showTrash = false; await refresh(root); }
  else if (act === 'empty-trash') await emptyTrash();
  else if (act === 'kb') await openKbModal();
}

async function clearSearch() {
  keyword = '';
  const search = boundRoot && boundRoot.querySelector('#nt-search');
  if (search) search.value = '';
  await refresh(boundRoot);
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
  // 新笔记直接进编辑态并选中标题占位文案，打字即可替换
  await openNote(note.id, { mode: 'edit', focusTitle: true });
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

/* ---------------- 右栏行内操作 ---------------- */

async function togglePin() {
  if (!currentNote) return;
  await flushNow();
  currentNote = await api.notes.pin(currentNote.id, !currentNote.pinned);
  const btn = (modalRoot || boundRoot)?.querySelector?.('[data-nt-act="dp-pin"]');
  if (btn) btn.textContent = currentNote.pinned ? '取消置顶' : '📌 置顶';
  updateListItem(currentNote);
  notify(currentNote.pinned ? '已置顶' : '已取消置顶');
}

async function toggleArchive() {
  if (!currentNote) return;
  await flushNow();
  currentNote = await api.notes.archive(currentNote.id, !currentNote.archived);
  const btn = (modalRoot || boundRoot)?.querySelector?.('[data-nt-act="dp-archive"]');
  if (btn) btn.textContent = currentNote.archived ? '取消归档' : '🗄 归档';
  updateListItem(currentNote);
  notify(currentNote.archived ? '已归档（仍可被检索与引用）' : '已取消归档');
  if (showArchived !== !!currentNote.archived) await loadList(boundRoot);
  onChanged();
}

/** 右栏的「删除」：说明影响面后让用户选回收站 / 彻底删除 */
async function deleteFromDetail() {
  if (!currentNote) return;
  const note = currentNote;
  if (!(await guardUnsaved())) return;
  const choice = await askDeleteChoice(note);
  if (choice === 'trash') {
    await api.notes.trash(note.id);
    discardSave = true;
    notify('笔记已移入回收站');
    await afterDelete(note.id);
  } else if (choice === 'purge') {
    discardSave = true;
    const res = await api.notes.purge(note.id).catch((e) => { notify((e && e.message) || '删除失败'); return null; });
    if (res) {
      notify(res.unlinkedTasks?.length
        ? `已彻底删除，并解除 ${res.unlinkedTasks.length} 个任务的引用`
        : '已彻底删除');
      await afterDelete(note.id);
    }
  }
}

async function afterDelete(id) {
  disposeEditor();
  activeNoteId = null;
  currentNote = null;
  baseline = null;
  const scope = modalRoot || boundRoot;
  const box = scope && scope.querySelector ? scope.querySelector('#nt-detail') : null;
  if (box) box.innerHTML = '';
  if (boundRoot) await refresh(boundRoot);
  onChanged();
  // 弹窗里删的：笔记已经没了，把弹窗一起收掉
  if (modalRoot && modalClose) modalClose();
  void id;
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

  box.querySelectorAll('[data-nt-act="open-task"]').forEach((b) => {
    b.addEventListener('click', () => openDetail(Number(b.dataset.id)));
  });
  box.querySelectorAll('[data-nt-act="unlink-task"]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.taskNotes.unlink(Number(b.dataset.id), Number(b.dataset.note));
      notify('已取消任务关联');
      await renderRefs(pane, note);
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
  // 查找 / 替换浮条挂在详情面板里：整个 innerHTML 重建前必须撤掉，
  // 否则它会拿着已销毁的 CodeMirror 继续打标记 / 调 replaceRange
  closeFindBar({ keepFocus: true });
  if (editorObserver) {
    try { editorObserver.disconnect(); } catch (e) { /* 忽略 */ }
    editorObserver = null;
  }
  try {
    if (editor && typeof editor.toTextArea === 'function') editor.toTextArea();
  } catch (e) { /* 编辑器已随 DOM 移除，忽略 */ }
  editor = null;
  dirty = false;
}

/** 视图被切走时调用（避免已销毁的自动保存器继续写库） */
export function disposeNotes() {
  // 切视图不再弹窗打断用户：有未落库的改动就直接兜底写掉，绝不丢内容
  if (dirty && saver) saver.flush().catch(() => {});
  closePalette();
  disposeEditor();
  currentNote = null;
  baseline = null;
  activeNoteId = null;
}

/* ---------------- 归档 / 删除策略 ---------------- */

/** 列表行上的归档 / 取消归档（不必打开详情） */
async function toggleArchiveById(id) {
  const row = lastList.find((n) => n.id === id);
  const next = !(row && row.archived);
  await api.notes.archive(id, next);
  notify(next ? '已归档（仍可被检索与引用）' : '已取消归档');
  await refresh(boundRoot);
  if (Number(activeNoteId) === Number(id)) {
    currentNote = await api.notes.get(id).catch(() => null);
    const btn = boundRoot && boundRoot.querySelector('[data-nt-act="dp-archive"]');
    if (btn && currentNote) btn.textContent = currentNote.archived ? '取消归档' : '🗄 归档';
  }
  onChanged();
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
      if (activeNoteId) await afterDelete(activeNoteId);
      else await refresh(boundRoot);
      onChanged();
      return undefined;
    },
  });
  void ok;
}

/**
 * 删除确认：先告知影响面，再让用户选「移入回收站」还是「彻底删除」。
 * - 移入回收站：正文与任务引用都保留，恢复后引用自动复原；笔记从知识库索引里摘除。
 * - 彻底删除：先摘掉所有任务引用（task_notes），再删正文与图片，不可恢复。
 */
async function askDeleteChoice(note) {
  const tasks = await api.taskNotes.byNote(note.id).catch(() => []);
  const listHtml = tasks.length
    ? `<div class="nt-del-warn">⚠️ 这篇笔记被 ${tasks.length} 个任务引用：</div>
       <ul class="nt-del-list">${tasks.map((t) => `<li>${t.completed ? '✅' : '⏳'} ${esc(t.title)}</li>`).join('')}</ul>`
    : '<div class="nt-del-warn">这篇笔记没有被任务引用，可直接删除。</div>';
  const purgeText = tasks.length ? `彻底删除（解除 ${tasks.length} 个任务引用）` : '彻底删除';
  // 两个动作都放在弹窗内容里（而不是底部 extraButtons）：extraButtons 的 handler 拿不到
  // 关闭回调，会让「彻底删除」之后的 await 永远等下去。
  return new Promise((resolve) => {
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
}

async function confirmDeleteById(id) {
  const note = await api.notes.get(id).catch(() => null);
  if (!note) return;
  if (Number(activeNoteId) === Number(id)) await flushNow();
  const choice = await askDeleteChoice(note);
  if (choice === 'trash') {
    await api.notes.trash(note.id);
    notify('笔记已移入回收站');
    if (Number(activeNoteId) === Number(id)) await afterDelete(id);
    else await refresh(boundRoot);
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
  if (Number(activeNoteId) === Number(id)) await afterDelete(id);
  else await refresh(boundRoot);
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
        resultEl.innerHTML = '<div class="kb-loading">检索中（改写查询 → 多路召回：全文 / 笔记级 / 模糊 → AI 重排）…</div>';
        const res = await api.kb.ask({ question: q, topK: 8 }).catch((e) => ({ __err: e.message }));
        askBtn.disabled = false;
        resultEl.innerHTML = kbResultHtml(q, res);
        resultEl.querySelectorAll('[data-kb-act="open"]').forEach((b) => {
          b.addEventListener('click', async () => {
            // 关闭弹窗 → 右栏打开该笔记，并把命中的词高亮 / 滚动定位过去（便于溯源）
            mask.querySelector('[data-modal="ok"]')?.click();
            await openNote(Number(b.dataset.id), { focusTerm: b.dataset.term || q });
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
  if (res.degraded && res.reason === 'no-hit') return '<div class="kb-empty">知识库里没有命中相关内容，换个说法试试。</div>';
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
  return `<div class="kb-hits-title">引用来源（按相关度排序，点标题可打开原文定位）</div><ul class="kb-hits">${hits.map((h, i) => `
    <li>
      <div class="kb-hit-head">
        <span class="kb-idx">[${i + 1}]</span>
        <button class="kb-hit-title" data-kb-act="open" data-id="${h.noteId ?? ''}"
                data-term="${esc(h.matchTerm || '')}">${esc(h.title || '未命名笔记')}</button>
        ${h.headingPath ? `<span class="kb-hit-path">${esc(h.headingPath)}</span>` : ''}
        ${h.matchedBy ? `<span class="kb-hit-path">命中：${esc(matchLabel(h.matchedBy))}</span>` : ''}
        <span class="kb-rel" title="融合相关度 ${Number(h.relevance) || 0}%">
          <i style="width:${Math.max(6, Math.min(100, Number(h.relevance) || 0))}%"></i>
        </span>
      </div>
      <div class="kb-hit-body">${highlightKeyword(h.snippet || String(h.content || '').slice(0, 220), h.matchTerm || '')}</div>
    </li>`).join('')}</ul>`;
}

function matchLabel(matchedBy) {
  const map = { fts: '全文', note: '笔记级', fuzzy: '模糊语义', like: '模糊', ai: 'AI 重排' };
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
      '',
      '## 颜色与高亮（本应用扩展）',
      '==默认高亮文字==',
      '==红字=={c:#e5484d}',
      '==蓝底=={bg:#cfe3ff}',
      '==红字蓝底=={c:#e5484d;bg:#fff3a3}',
      '',
      '> 选中文字后点工具栏「A」「🖍」即可上色；色值只支持 #hex，随正文一起保存。',
    ].join('\n'))}</div>`,
  });
}
