'use strict';
/**
 * 任务详情页（右侧抽屉）：基础信息编辑、树形子任务层级（可拖拽排序）、
 * 所见即所得 Markdown 描述（支持快捷键与粘贴图片，图片直接插入光标处）。
 */
import { api, PRIORITY_TEXT, fmtDateTime } from './api.js';
import { state, loadGroups, loadTags, refreshAll, noteCompletionChange } from './store.js';
import { renderMarkdown } from './markdown.js';
import { renderStyledInline } from './markdown-lib.js';
import { openPanelModal, openPromptModal } from './modal.js';
import { openNotePicker } from './note-picker.js';
import {
  dateRangeFieldHtml, bindDateRangeFields, validateDateRange,
  DATE_RANGE_EVENT, DATE_RANGE_DEFAULTS, syncReminderWithPlanEnd, isAnyRangeOpen,
  reminderHtml, bindReminder, computeReminder, reminderNeedsPlanEnd,
} from './controls.js';
import { createAutoSave, SAVE_STATE_TEXT } from './autosave.js';
import { groupOptionsHtml } from './group-tree.js';
import { detailRepeatHtml, bindDetailRepeat, derivedScheduleHtml } from './recurrence.js';
import { TOOLBAR_HTML, createWysiwyg } from './wysiwyg.js';

// 详情页的计划日期是否必填（默认否，保持可创建“无期限”任务）
const PLAN_DATE_REQUIRED = DATE_RANGE_DEFAULTS.required;
// 即时持久化防抖延迟（毫秒）
const DETAIL_AUTO_SAVE_DELAY = 700;

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let handlers = { refresh: () => {}, toast: () => {} };
export function setDetailHandlers(h) { handlers = { ...handlers, ...h }; }

/* ---------------- 附件 ---------------- */

/** 文件大小：B / KB / MB / GB，保留一位小数，0 字节也给出可读值 */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** 按 MIME / 扩展名给一个图标，扫一眼就知道是什么类型的附件 */
function attIcon(a) {
  const mime = String((a && a.mime) || '');
  const name = String((a && a.name) || '').toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) return '🖼';
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/.test(name)) return '🎬';
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac)$/.test(name)) return '🎵';
  if (mime === 'application/pdf' || /\.pdf$/.test(name)) return '📕';
  if (/\.(xls|xlsx|csv)$/.test(name)) return '📊';
  if (/\.(doc|docx)$/.test(name)) return '📄';
  if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return '🗜';
  return '📎';
}

/** 附件唯一键：新数据都有 id，老数据（base64 内联）可能只有 name，兜底用 name 定位 */
function attKey(a) {
  return String((a && (a.id || a.name)) || '');
}

/** 附件列表 HTML（空态也在这里，方便整体替换） */
function attachmentsInnerHtml(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) {
    return '<div class="att-empty">暂无附件：点右上「＋ 添加附件」，或把文件拖到这里</div>';
  }
  return arr.map((a) => `
    <div class="att-row" data-att="${esc(attKey(a))}" title="${esc(a.name)}">
      <span class="att-icon">${attIcon(a)}</span>
      <span class="att-main">
        <span class="att-name">${esc(a.name)}</span>
        <span class="att-meta">${fmtSize(a.size)}${a.added_at ? ` · ${esc(fmtDateTime(a.added_at))}` : ''}</span>
      </span>
      <span class="att-ops">
        <button data-att-act="open" title="用系统默认程序打开">打开</button>
        <button data-att-act="save" title="另存为…">下载</button>
        <button class="del" data-att-act="del" title="删除附件">删除</button>
      </span>
    </div>`).join('');
}

/**
 * 统一错误处理：把失败原因提示给用户，避免"点了没反应"。
 * 返回 true 表示成功，false 表示已提示并应中止后续刷新。
 */
/** 关联笔记区块：数量 + 列表 + 「关联 / 查看 / 取消关联」入口 */
function noteSectionHtml(notes) {
  const list = notes || [];
  const rows = list.map((n) => `
    <li class="nt-link-item" data-note="${n.id}">
      <span class="nt-link-main" title="${esc(n.title || '')}">
        <span class="nt-link-title" data-act="note-open" data-note="${n.id}">📝 ${esc(n.title || '未命名笔记')}</span>
        <span class="nt-link-excerpt">${renderStyledInline(n.excerpt || '', 64)}</span>
      </span>
      <span class="nt-link-ops">
        <button class="ghost-btn tiny" data-act="note-open" data-note="${n.id}">查看</button>
        <button class="ghost-btn tiny" data-act="note-unlink" data-note="${n.id}" title="取消与该笔记的关联（笔记本身保留）">✕</button>
      </span>
    </li>`).join('');
  return `
    <div class="detail-section" data-section="notes">
      <div class="detail-section-head">
        <span>关联笔记 <span class="att-count">${list.length}</span></span>
        <span class="np-head-ops">
          <button class="ghost-btn tiny" data-act="note-link" title="从笔记库里选择要关联的笔记（可多选）">＋ 关联笔记</button>
        </span>
      </div>
      <div class="nt-link-list">${rows || '<div class="subtask-empty">尚未关联笔记</div>'}</div>
    </div>`;
}

/** 只替换笔记区块：整页重建会丢描述编辑器的光标与滚动位置 */
async function refreshNoteSection(drawer, taskId) {
  const host = drawer.querySelector('[data-section="notes"]');
  if (!host) return;
  const notes = await api.taskNotes.list(taskId).catch(() => []);
  const holder = document.createElement('div');
  holder.innerHTML = noteSectionHtml(notes);
  const next = holder.firstElementChild;
  if (!next) return;
  host.replaceWith(next);
  bindNoteSectionEvents(drawer, Number(taskId));
}

/** 打开关联笔记：弹窗编辑器就地查看 / 编辑（不再跳转到笔记标签页） */
async function openNoteView(noteId) {
  const mod = await import('./notes.js');
  await mod.openNoteModal(Number(noteId));
}

function bindNoteSectionEvents(drawer, taskId) {
  const host = drawer.querySelector('[data-section="notes"]');
  if (!host) return;
  host.querySelector('[data-act="note-link"]')?.addEventListener('click', async () => {
    const res = await openNotePicker({ taskId });
    if (!res.ok) return;
    await refreshNoteSection(drawer, taskId);
    handlers.toast(`已关联 ${res.noteIds.length} 篇笔记`);
    handlers.refresh();
  });
  host.querySelectorAll('[data-act="note-open"]').forEach((b) => {
    b.addEventListener('click', () => openNoteView(Number(b.dataset.note)));
  });
  host.querySelectorAll('[data-act="note-unlink"]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.taskNotes.unlink(taskId, Number(b.dataset.note));
      await refreshNoteSection(drawer, taskId);
      handlers.toast('已取消关联（笔记本身保留）');
      handlers.refresh();
    });
  });
}

async function guard(prefix, fn) {
  try {
    await fn();
    return true;
  } catch (e) {
    console.error(`[detail][${prefix}]`, e);
    handlers.toast(`${prefix}：${(e && e.message) || '未知错误'}`);
    return false;
  }
}

/** 渲染令牌：异步任务结束得太晚时就丢弃结果，避免旧内容覆盖新内容（表现为闪一下再变回去） */
let renderToken = 0;

/**
 * 本轮渲染的监听器控制器。
 * #detail-drawer 是常驻节点（只换 innerHTML），之前每次 renderDetail 都往上再挂一批
 * input/change 监听，于是开着 A 再开 B 时，A 的自动保存器仍然活着并把 B 的内容写进 A。
 * 每次渲染前 abort 上一轮，保证同一时刻只有一个自动保存器。
 *
 * 注意：abort 只能摘掉监听器，**取消不了已经排队的防抖计时器**。计时器到期时旧保存器
 * 仍然会执行 read()（读的是"当前抽屉 DOM"，此时已经是另一个任务）再 save() 到
 * **旧任务的 id** —— 这才是"改 A 把 B 覆盖 / 两个任务互相串改"的根因。
 * 所以监听器之外还必须有一份保存器登记表，渲染前逐个「先 flush 再 dispose」。
 */
let renderAbort = null;

/**
 * 本轮渲染创建的自动保存器登记表。
 * - 'main'：主任务抽屉级保存器（bindDetailAutoSave）
 * - 'subtask'：每个子任务行一个（bindSubtaskAutoSave）
 * 渲染前按范围回收：flush 把还没落库的改动立刻写掉（此时 DOM 仍是旧任务的，写的一定是
 * 它自己的数据），dispose 再取消计时器并作废回调，旧保存器从此不可能再写库。
 */
let activeSavers = [];

/** 登记一个保存器，便于统一回收 */
function trackSaver(saver, scope) {
  if (saver) activeSavers.push({ saver, scope });
  return saver;
}

/**
 * 回收保存器。
 * @param {string} [scope] 只回收指定范围（'subtask' = 仅子任务行）；不传 = 全部回收
 */
function disposeSavers(scope) {
  const keep = [];
  for (const entry of activeSavers) {
    if (scope && entry.scope !== scope) { keep.push(entry); continue; }
    try {
      // flush 内部同步取值（read 在第一个 await 之前执行），所以这里拿到的必然是
      // 「回收那一刻」的 DOM 值 —— 也就是旧任务自己的内容，不会串到别的任务上。
      const p = entry.saver.flush();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_e) { /* 回收阶段不再抛错 */ }
    try { entry.saver.dispose(); } catch (_e) { /* 同上 */ }
  }
  activeSavers = keep;
}

/**
 * 抽屉当前展示的确实是 id 这个任务吗？
 * 双重校验：state 里的当前任务 id + 抽屉 DOM 上打的标记（DOM 可能是上一轮留下的）。
 * 任何一次写入前都要过这一关 —— 即使还有漏网的旧保存器，也只能"什么都不做"，
 * 绝不能把别的任务的内容写进自己。
 */
function isDrawerShowing(id) {
  const drawer = document.getElementById('detail-drawer');
  return !!drawer && state.detailTaskId === id && String(drawer.dataset.taskId) === String(id);
}

/** 描述被 AI 润色前的原文（用于「还原原文」） */
let polishBackup = '';
/** 润色是否正在进行：连点「AI 润色」只应弹一个窗、发一次请求 */
let polishBusy = false;

/* ---------------- 侧边栏宽度（拖拽调整 + 记忆） ---------------- */

const DETAIL_WIDTH = { min: 360, max: 860, def: 420, key: 'ui.detailWidth' };
let detailWidth = null; // 运行时宽度（null = 尚未读取）
let widthSaveTimer = null;
/** 是否正在拖拽调宽 */
let resizing = false;
/** 拖拽期间被推迟的重绘（结束后补一次） */
let pendingRender = false;

/** 面板宽度上限：不超过窗口宽度的 85%，也不低于最小值 */
function clampDetailWidth(w) {
  const maxByViewport = Math.round(window.innerWidth * 0.85);
  const max = Math.min(DETAIL_WIDTH.max, Math.max(DETAIL_WIDTH.min, maxByViewport));
  return Math.min(max, Math.max(DETAIL_WIDTH.min, Math.round(w)));
}

function applyDetailWidth(panel) {
  if (!panel || detailWidth == null) return;
  const w = clampDetailWidth(detailWidth);
  panel.style.setProperty('--detail-width', `${w}px`);
  panel.style.width = `${w}px`;
  // 抽屉级也留一份：面板被重建时新的 .detail-panel 直接继承，不会先跳回旧宽度再被纠正
  if (panel.parentElement) panel.parentElement.style.setProperty('--detail-width', `${w}px`);
}

/** 读取上次保存的宽度（本次会话只读一次，之后用内存值，避免重复 IPC） */
async function ensureDetailWidth() {
  if (detailWidth != null) return detailWidth;
  detailWidth = clampDetailWidth(Number(localStorage.getItem(DETAIL_WIDTH.key)) || DETAIL_WIDTH.def);
  try {
    const saved = await api.ui.getDetailWidth();
    if (saved) detailWidth = clampDetailWidth(saved);
  } catch (e) {
    // 读取失败不影响使用，沿用本地缓存 / 默认值
    console.warn('[detail] 读取侧边栏宽度失败', e && e.message);
  }
  return detailWidth;
}

/** 保存宽度：先写 localStorage（即时、下次打开瞬间生效），再异步落库（节流） */
function persistDetailWidth(w) {
  const val = clampDetailWidth(w);
  try { localStorage.setItem(DETAIL_WIDTH.key, String(val)); } catch (_e) { /* 忽略配额异常 */ }
  clearTimeout(widthSaveTimer);
  widthSaveTimer = setTimeout(() => {
    api.ui.setDetailWidth(val).catch((e) => console.warn('[detail] 保存侧边栏宽度失败', e && e.message));
  }, 350);
}

/**
 * 绑定拖拽手柄。
 * 用 Pointer Events + setPointerCapture：拖动中即使鼠标移出窗口也不会丢失事件；
 * 宽度只通过 requestAnimationFrame 合并更新，避免 mousemove 高频触发重排导致抖动。
 */
function bindResizer(drawer) {
  const panel = drawer.querySelector('.detail-panel');
  const handle = drawer.querySelector('.detail-resizer');
  if (!panel || !handle) return;
  if (detailWidth != null) applyDetailWidth(panel);

  let drag = null;
  let raf = 0;

  const onMove = (e) => {
    if (!drag) return;
    drag.next = e.clientX; // 面板贴右边，宽度 = 视口宽 - 指针 x
  };
  /** 唯一写宽度的入口：面板 inline width + 抽屉级变量（面板重建时可直接继承） */
  const applyWidth = (w) => {
    detailWidth = w;
    drawer.style.setProperty('--detail-width', `${w}px`);
    panel.style.width = `${w}px`;
  };
  const flush = () => {
    raf = 0;
    if (!drag || drag.next == null) return;
    const w = clampDetailWidth(window.innerWidth - drag.next);
    if (w === drag.last) return; // 宽度没变就不写样式，减少布局抖动
    drag.last = w;
    applyWidth(w);
  };
  const onPointerMove = (e) => {
    onMove(e);
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const endDrag = () => {
    if (!drag) return;
    const lastX = drag.next;
    drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    document.documentElement.classList.remove('is-resizing');
    document.body.style.removeProperty('user-select');
    try { handle.releasePointerCapture(handle.__pointerId); } catch (_e) { /* 已释放 */ }
    // 收尾同步补一次：窗口不可见 / 被遮挡时 rAF 会被节流，最后一帧可能还没落地，
    // 直接按最后一次指针位置写死，保证“松手处 == 最终宽度”。
    const w = lastX != null
      ? clampDetailWidth(window.innerWidth - lastX)
      : (detailWidth || DETAIL_WIDTH.def);
    applyWidth(w);
    resizing = false;
    // 拖拽期间被推迟的重绘，结束后补上（宽度已经是最新值，不会跳）
    if (pendingRender) {
      pendingRender = false;
      renderDetail();
    }
    persistDetailWidth(w);
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 阻止拖拽时选中文字
    drag = { next: e.clientX, last: null };
    resizing = true;
    handle.__pointerId = e.pointerId;
    try { handle.setPointerCapture(e.pointerId); } catch (_e) { /* 不支持则退回 window 监听 */ }
    document.documentElement.classList.add('is-resizing');
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  });

  // 双击恢复默认宽度
  handle.addEventListener('dblclick', () => {
    detailWidth = DETAIL_WIDTH.def;
    panel.style.width = `${DETAIL_WIDTH.def}px`;
    persistDetailWidth(DETAIL_WIDTH.def);
  });

  // 窗口变窄时收敛到上限内，避免面板超出视口
  // 挂在 window 上不会随 innerHTML 消失，必须跟着本轮渲染一起作废，否则越挂越多
  window.addEventListener('resize', () => {
    if (detailWidth == null || resizing) return;
    const w = clampDetailWidth(detailWidth);
    if (w !== detailWidth) { detailWidth = w; }
    applyDetailWidth(panel);
  }, { signal: renderAbort ? renderAbort.signal : undefined });
}

export function openDetail(id) {
  // 切换任务前先把上一个任务还没落库的改动写掉：此刻 state.detailTaskId 仍是旧值、
  // 抽屉 DOM 也还是旧任务的，flush 写到的一定是旧任务自己的数据，不会串到新任务上。
  // （顺序很关键：先落库再改 state，否则身份校验会把这次补写判成"越权"而丢掉改动。）
  disposeSavers();
  state.detailTaskId = id;
  renderDetail();
}

export function closeDetail() {
  // 关闭前把还在防抖队列里的改动落库（否则最后一下输入会被抽屉隐藏一起带走）
  disposeSavers(); // 主任务 + 所有子任务：flush 后 dispose，避免关掉后还有保存器在跑
  releaseNotesEditor(); // 编辑器同理：不销毁的话选区 / 色板监听会一直挂在 document 上
  const drawer = document.getElementById('detail-drawer');
  state.detailTaskId = null;
  if (drawer) {
    drawer.hidden = true;
    drawer.dataset.opened = '';  // 下次打开重新播放入场动画
    delete drawer.dataset.taskId; // 身份标记一并作废：此后任何保存器都不许再写
  }
}

export function isDetailOpen() {
  return state.detailTaskId != null;
}

/**
 * 日切 / 后台推进重复事项后刷新抽屉。
 *
 * 重复事项的计划时间与提醒是规则派生的只读展示，跨天会变；抽屉一直开着就会停在昨天那一份。
 * 这里只在「没在输入」时重绘：旧保存器会先 flush 再 dispose（不丢数据），
 * 但重绘会丢光标与撤销栈 —— 用户正在打字就留到下一次自然重绘。
 */
export function refreshDetailIfIdle() {
  const drawer = document.getElementById('detail-drawer');
  if (!drawer || drawer.hidden || state.detailTaskId == null) return;
  const act = document.activeElement;
  const editing = act && drawer.contains(act) && (
    act.tagName === 'INPUT' || act.tagName === 'TEXTAREA'
    || act.tagName === 'SELECT' || act.isContentEditable
  );
  if (editing) return;
  renderDetail();
}

/** 描述内容 → HTML（兼容旧 Markdown 数据与新所见即所得 HTML） */
function notesToHtml(notes) {
  if (!notes) return '';
  if (/<\/?[a-z][^>]*>/i.test(notes)) return notes;
  return renderMarkdown(notes);
}

/**
 * 番茄时间线（任务详情里的专注日志）。
 * 格式与方案 §创意1 一致：`11-03 10:25  ●  一句话`（● = 跑满 / ◐ = 半格）。
 * 无会话时返回空串（不渲染这一节）。
 */
function focusTimelineHtml(sessions) {
  const list = sessions || [];
  if (!list.length) return '';
  const rows = list.map((s) => {
    const d = new Date(s.started_at);
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const mark = s.outcome === 'full' ? '●' : '◐';
    const cls = s.outcome === 'full' ? 'ft-full' : 'ft-half';
    const note = s.note ? `<span class="ft-note">${esc(s.note)}</span>` : '';
    const dur = s.actual_sec >= 60 ? `<span class="ft-dur">${Math.round(s.actual_sec / 60)} 分钟</span>` : '';
    return `<div class="ft-row">
      <span class="ft-time">${stamp}</span>
      <span class="ft-mark ${cls}">${mark}</span>
      ${note}${dur}
    </div>`;
  }).join('');
  return `<div class="detail-section" data-section="focus">
    <div class="detail-section-head"><span>专注 🍅 <span class="att-count">${list.length}</span></span></div>
    <div class="focus-timeline">${rows}</div>
  </div>`;
}

async function resolveTagIds(namesStr) {
  const names = namesStr.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  const ids = [];
  for (const n of names) {
    const existing = state.tags.find((t) => t.name === n);
    if (existing) ids.push(existing.id);
    else {
      const created = await api.tags.create(n);
      ids.push(created.id);
    }
  }
  return ids;
}

function priorityOptionsHtml(selected) {
  const sel = selected == null ? 1 : selected;
  return [0, 1, 2, 3]
    .map((p) => `<option value="${p}"${p === sel ? ' selected' : ''}>${PRIORITY_TEXT[p]}</option>`)
    .join('');
}

async function renderDetail() {
  const drawer = document.getElementById('detail-drawer');
  if (!drawer) return;
  const id = state.detailTaskId;
  if (id == null) { drawer.hidden = true; return; }
  // 拖拽调宽期间不重建 DOM：innerHTML 一换，入场动画重播 + 宽度回到重建前的值，
  // 画面上就是“闪一下/抖一下”。推迟到指针抬起后再补一次重绘。
  if (resizing) { pendingRender = true; return; }
  const token = ++renderToken;
  // 作废上一轮挂在抽屉上的监听器（抽屉是常驻节点，不清理会越挂越多）
  if (renderAbort) renderAbort.abort();
  // 同时回收上一轮的保存器：此时抽屉还是上一个任务的 DOM，flush 写的是它自己的数据；
  // 之后旧保存器被 dispose，再也不会拿新任务的 DOM 去写旧任务的 id。
  disposeSavers();
  // 描述编辑器的 document 级监听（选区 / 色板 / 浮层）不随 innerHTML 消失，必须显式销毁
  releaseNotesEditor();
  renderAbort = new AbortController();

  const task = await api.tasks.get(id);
  if (!task) { drawer.hidden = true; state.detailTaskId = null; return; }
  await loadGroups();
  await loadTags();

  const subtreeHtml = await renderSubtreeHtml(id);
  const linkedNotes = await api.taskNotes.list(id).catch(() => []);
  // 番茄时间线（该任务的专注日志，按开始时间倒序）
  const focusTimeline = await api.focus.timeline(id).catch(() => []);
  // 重复规则：一条任务最多一条规则，详情里就地展示 / 修改「重复与提醒」
  const recurRule = task.recurring_id != null
    ? await api.recurrences.forTask(id).catch(() => null)
    : null;
  // 期间若已切换到别的任务 / 被又一次渲染取代，直接放弃本次结果
  if (token !== renderToken) return;
  // 描述必须回填：之前这里一直是空编辑器，用户看到的永远是「没有描述」，
  // 而且自动保存会把空内容当成最新值写库 —— 改一下标题，描述就被清空了。
  const notesHtml = notesToHtml(task.notes);
  polishBackup = '';
  polishBusy = false; // 换任务 = 上一轮润色作废，按钮与防重标记一起复位
  const parentInfo = task.parent_id
    ? `<div class="detail-parent" data-act="goto-parent" data-parent="${task.parent_id}">↳ 所属父任务：${esc(task.parent_title || '未知')}</div>`
    : '';

  // 只有「从关闭状态打开」才播入场动画；同一任务被重绘（保存、勾选子任务…）时不再滑入，
  // 否则每次重绘都会有 200ms 的位移 + 淡入，看着像界面在闪。
  const reopen = drawer.dataset.opened === '1';

  // 重复事项的计划时间 / 提醒是规则派生值（本次 = 发生日，截止 = 发生日 + 偏移）：
  // 不给可编辑入口，改为只读展示，避免「计划时间 11-08~11-10」与「有效期 / 结束日」互相打架（P-01）。
  const derived = !!recurRule;

  drawer.innerHTML = `
    <div class="detail-mask" data-act="close"></div>
    <div class="detail-panel${reopen ? ' no-anim' : ''}">
      <div class="detail-resizer" data-act="resize" title="拖拽调整宽度（双击恢复默认）" role="separator" aria-orientation="vertical"></div>
      <div class="detail-head">
        <button class="detail-check${task.completed ? ' done' : ''}" data-act="toggle" title="完成/取消">${task.completed ? '✓' : ''}</button>
        <input class="detail-title" placeholder="任务标题" value="${esc(task.title)}" spellcheck="false" />
        <button class="detail-close" data-act="close" title="关闭">×</button>
      </div>
      <div class="detail-body">
        ${parentInfo}
        <div class="detail-row">
          <label class="detail-field">优先级
            <select class="detail-priority">${priorityOptionsHtml(task.priority)}</select>
          </label>
          <label class="detail-field">分组
            <select class="detail-group">${groupOptionsHtml(state.groups, task.group_id)}</select>
          </label>
        </div>
        <div class="detail-row">
          ${derived
    ? derivedScheduleHtml(task, recurRule)
    : dateRangeFieldHtml(task.plan_start, task.plan_end, { required: PLAN_DATE_REQUIRED, placeholder: '计划开始 ~ 完成' })}
        </div>
        <div class="detail-row">
          ${derived ? '' : reminderHtml(task.reminder_at, task.plan_end)}
          <label class="detail-field grow">标签（逗号分隔）
            <input class="detail-tags" placeholder="如：项目A, 紧急" value="${esc((task.tag_names || []).join(', '))}" />
          </label>
        </div>

        ${detailRepeatHtml(task, recurRule)}

        <div class="detail-section">
          <div class="detail-section-head"><span>子任务</span></div>
          <div class="subtask-container">${subtreeHtml || '<div class="subtask-empty">暂无子任务</div>'}</div>
          <div class="subtask-add">
            <input class="subtask-input" placeholder="添加子任务，回车保存" />
            <select class="subtask-new-priority" title="新子任务优先级">${priorityOptionsHtml(task.priority)}</select>
            ${dateRangeFieldHtml('', '', { placeholder: '起 ~ 止' })}
            <button class="ghost-btn" data-act="subtask-add">＋ 添加</button>
          </div>
        </div>

        ${focusTimelineHtml(focusTimeline)}

        <div class="detail-section">
          <div class="detail-section-head">
            <span>描述</span>
            <span class="np-head-ops">
              <button class="ghost-btn tiny" data-act="polish" title="用 AI 改写这段描述（可选预设或自定义提示词），先预览再决定是否采纳">✨ AI 改写</button>
              <button class="ghost-btn tiny" data-act="polish-restore" title="放弃润色结果，恢复润色前的原文" hidden>↩ 还原原文</button>
            </span>
          </div>
          <div class="detail-notes-wrap">
            ${TOOLBAR_HTML}
            <div class="detail-notes-editor markdown-body" contenteditable="true" spellcheck="false"
                 data-placeholder="写点什么…支持工具条排版与 Markdown 快捷键，可直接粘贴 / 拖入图片">${notesHtml}</div>
          </div>
        </div>

        <div class="detail-section">
          <div class="detail-section-head">
            <span>附件 <span class="att-count">${(task.attachments || []).length}</span></span>
            <span class="np-head-ops">
              <button class="ghost-btn tiny" data-act="att-add" title="选择本地文件添加附件（支持多选，也可直接把文件拖进来）">＋ 添加附件</button>
            </span>
          </div>
          <div class="att-list">${attachmentsInnerHtml(task.attachments)}</div>
        </div>

        ${noteSectionHtml(linkedNotes)}

        <div class="detail-created" title="任务创建时间（不可修改）">🕒 创建于 ${esc(fmtDateTime(task.created_at))}</div>
      </div>
      <div class="detail-foot">
        <button class="danger-btn" data-act="delete">删除</button>
        <button class="ghost-btn" data-act="archive">${task.archived ? '取消归档' : '归档'}</button>
        <span class="spacer"></span>
        <span class="detail-save-state" title="修改会自动保存"></span>
        <button class="primary-btn" data-act="save">保存</button>
      </div>
    </div>`;

  drawer.hidden = false;
  drawer.dataset.opened = '1';
  // 打上"这块 DOM 属于哪个任务"的标记：保存器写库前据此校验身份
  drawer.dataset.taskId = String(task.id);
  await ensureDetailWidth();
  bindResizer(drawer);
  bindDateRangeFields(drawer); // 主任务 + 子任务新增区 + 各行内的日期范围控件
  bindReminder(drawer);
  // 范围被清除/修改后同步提醒预设（依赖完成日期的预设会自动回到“不提醒”）
  drawer.addEventListener(DATE_RANGE_EVENT, (e) => syncReminderWithPlanEnd(drawer, e.detail.planEnd), { signal: renderAbort.signal });
  // 重复与提醒：独立的「保存重复设置」按钮，改动不进抽屉级 autosave
  bindDetailRepeat(drawer, task, recurRule, {
    signal: renderAbort ? renderAbort.signal : undefined,
    onSaved: async () => { await refreshAll(); handlers.refresh(); renderDetail(); },
  });
  bindDetailEvents(drawer, task);
  // 即时持久化：挂载在事件绑定之后，保证能监听到同一批事件。
  // derived=true 时计划日期 / 提醒不在表单里，保存器只写内容字段（库里也会拒写那三个字段）。
  drawer.__autoSave = bindDetailAutoSave(drawer, task, notesHtml, { derived });
}

/**
 * 递归渲染子任务树（嵌套 <ul>，支持拖拽排序）。
 * 子任务与主任务同级：同样具备优先级、计划开始 / 完成日期，字段就地编辑并即时保存。
 */
async function renderSubtreeHtml(parentId) {
  const subs = await api.tasks.subtasks(parentId);
  if (!subs.length) return '';
  // data-parent：拖拽排序时据此知道该刷新哪一层
  let html = `<ul class="subtree" data-parent="${parentId}">`;
  for (const s of subs) {
    html += subtaskItemHtml(s);
    html += await renderSubtreeHtml(s.id);
  }
  html += '</ul>';
  return html;
}

/** 单个子任务行：勾选 + 标题（可编辑）+ 优先级 + 计划日期范围 + 删除 */
function subtaskItemHtml(s) {
  return `<li class="subtask-item${s.completed ? ' done' : ''}" data-id="${s.id}" draggable="false">
    <span class="drag-handle" title="按住拖拽调整顺序">⠿</span>
    <button class="subtask-check" data-act="subtask-toggle">${s.completed ? '✓' : ''}</button>
    <input class="subtask-title-input" value="${esc(s.title)}" placeholder="子任务标题" title="直接编辑，自动保存" />
    <select class="subtask-priority" title="优先级">${priorityOptionsHtml(s.priority)}</select>
    ${dateRangeFieldHtml(s.plan_start, s.plan_end, { placeholder: '起 ~ 止' })}
    ${s.subtask_count > 0 ? `<span class="subtask-badge">${s.subtask_done}/${s.subtask_count}</span>` : ''}
    <button class="subtask-del" data-act="subtask-del" title="删除">×</button>
  </li>`;
}

/* ---------------- 描述编辑器：与笔记同一套所见即所得 ---------------- */

/**
 * 快捷键清单（「?」帮助弹窗）。键位与 wysiwyg.js 的 onKeydown **必须逐条对齐** ——
 * 这里写错了不会报错，只会让人按了没反应。
 */
const MD_SHORTCUTS = [
  { keys: 'Ctrl+B', desc: '加粗' },
  { keys: 'Ctrl+I', desc: '斜体' },
  { keys: 'Ctrl+U', desc: '下划线' },
  { keys: 'Ctrl+Shift+X', desc: '删除线' },
  { keys: 'Ctrl+Alt+0 / 1 / 2 / 3', desc: '正文 / 一级 / 二级 / 三级标题' },
  { keys: 'Ctrl+Shift+7', desc: '有序列表' },
  { keys: 'Ctrl+Shift+8', desc: '无序列表' },
  { keys: 'Ctrl+K', desc: '插入链接' },
  { keys: 'Ctrl+Alt+C', desc: '插入代码块（可选语言）' },
  { keys: 'Ctrl+Z / Ctrl+Shift+Z', desc: '撤销 / 重做' },
];

/** 「?」帮助弹窗：展示常用快捷键 */
function showMdHelp() {
  const rows = MD_SHORTCUTS.map((s) => `
    <tr><td class="md-key">${esc(s.keys)}</td><td>${esc(s.desc)}</td></tr>`).join('');
  openPanelModal({
    title: '描述排版快捷键',
    className: 'modal-md-help',
    html: `
      <table class="md-help-table">
        <thead><tr><th>快捷键</th><th>功能</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="md-help-tip">
        工具条上的「▾ 正文」可切换段落样式；代码块插入后点左上角语言标签能就地换语言。
        也可以直接把截图 / 图片粘贴或拖进描述，图片会插到光标处。
      </div>`,
  });
}

/**
 * 本地图片 → dataURL → 插到描述光标处。
 * 描述随任务一起备份 / 导出，图片只能内联存储（与该功能历史行为一致）。
 */
function insertLocalImage(drawer, file) {
  if (!file) return;
  if (!/^image\//i.test(file.type || '')) { handlers.toast('只能插入图片文件'); return; }
  if (file.size && file.size > 8 * 1024 * 1024) { handlers.toast('图片超过 8MB，请先压缩再插入'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    if (!drawer.__notesEditor) return;
    drawer.__notesEditor.insertImage(String(reader.result || ''), file.name || '图片');
  };
  reader.onerror = () => handlers.toast('图片读取失败，请重试');
  reader.readAsDataURL(file);
}

/** 工具条「插入图片」：走系统文件选择框，可多选 */
function pickInlineImage(drawer) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  // cancel 事件（Chromium 支持）：用户放弃选择时把临时 input 收回，不留 DOM 垃圾
  input.addEventListener('cancel', () => input.remove());
  input.addEventListener('change', () => {
    [...(input.files || [])].forEach((f) => insertLocalImage(drawer, f));
    input.remove();
  });
  input.click();
}

/** 渲染前 / 关闭抽屉时回收编辑器：document 级监听（选区、色板）不随 innerHTML 消失 */
function releaseNotesEditor() {
  const drawer = document.getElementById('detail-drawer');
  const ed = drawer && drawer.__notesEditor;
  if (ed) { try { ed.dispose(); } catch (_e) { /* 已销毁 */ } }
  if (drawer) drawer.__notesEditor = null;
}

/**
 * Esc 关闭抽屉。用模块级单一监听（而不是每次开抽屉 add + once 到期失效）：
 * ① 面板打开时 Esc 只收起日期面板，不连带关掉抽屉；
 * ② 不会因为 once 被“吃掉”而导致后续 Esc 失灵。
 */
let escBound = false;
function ensureEscHandler() {
  if (escBound) return;
  escBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isDetailOpen() || isAnyRangeOpen()) return;
    closeDetail();
  });
}

function bindDetailEvents(drawer, task) {
  drawer.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', closeDetail));
  ensureEscHandler();

  const parentEl = drawer.querySelector('[data-act="goto-parent"]');
  if (parentEl) {
    parentEl.addEventListener('click', () => openDetail(Number(parentEl.dataset.parent)));
  }

  drawer.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
    const next = await api.tasks.toggle(task.id);
    // 与列表勾选保持一致：今天完成的任务保留在「今天」列表里（详情抽屉里勾的同样要记）
    noteCompletionChange(task.id, !!(next && next.completed), task.parent_id);
    await refreshAll();
    handlers.refresh();
    renderDetail();
  });

  drawer.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    if (!confirm('确定删除该任务及其所有子任务吗？此操作不可恢复。')) return;
    await api.tasks.remove(task.id);
    closeDetail();
    handlers.toast('任务已删除');
    await refreshAll();
    handlers.refresh();
  });
  drawer.querySelector('[data-act="archive"]').addEventListener('click', async () => {
    if (task.archived) await api.tasks.unarchive(task.id);
    else await api.tasks.archive(task.id);
    handlers.toast(task.archived ? '已取消归档' : '已归档');
    await refreshAll();
    handlers.refresh();
    renderDetail();
  });

  drawer.querySelector('[data-act="save"]').addEventListener('click', () => saveDetail(drawer, task));

  // 描述：与笔记完全同一套所见即所得编辑器（工具条 / 快捷键 / 色板 / 代码块），
  // 区别只在数据形态 —— 描述存 HTML，所以走 mode:'html' 的常驻编辑态。
  // 撤销、快捷键、只读拦截等都复用同一份实现，别再在这里手写一套 execCommand。
  const editor = drawer.querySelector('.detail-notes-editor');
  if (editor) {
    const rich = createWysiwyg({
      root: editor,
      toolbar: drawer.querySelector('.detail-notes-wrap [data-nt-toolbar]'),
      mode: 'html',
      notify: (msg) => handlers.toast(msg),
      onInput: () => { if (drawer.__autoSave) drawer.__autoSave.schedule(); },
      hooks: {
        // 粘贴 / 拖入图片：读成 dataURL 插到光标处
        pasteImage: (files) => files.forEach((f) => insertLocalImage(drawer, f)),
        pickImage: () => pickInlineImage(drawer),
        guide: () => showMdHelp(),
      },
    });
    // HTML 已经由模板渲染进 DOM，这里再走一遍 setContent：统一代码块外壳、
    // 给图片 / 代码块工具条打上 contenteditable=false（编辑态的原子块）
    rich.setContent(editor.innerHTML);
    drawer.__notesEditor = rich;
  }

  // 描述 AI 润色：结果先预览，采纳后可一键还原原文
  const polishBtn = drawer.querySelector('[data-act="polish"]');
  if (polishBtn) polishBtn.addEventListener('click', () => runPolish(drawer));
  const restoreBtn = drawer.querySelector('[data-act="polish-restore"]');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => {
      const editor = drawer.querySelector('.detail-notes-editor');
      if (!editor) return;
      editor.innerHTML = polishBackup;
      polishBackup = '';
      restoreBtn.hidden = true;
      if (drawer.__autoSave) drawer.__autoSave.schedule();
      handlers.toast('已还原润色前的原文');
    });
  }

  // 子任务：添加（只重绘子树，输入框保留焦点，避免整页重建造成的闪烁）
  const subtaskInput = drawer.querySelector('.subtask-input');
  const addSubtask = async () => {
    const title = subtaskInput.value.trim();
    if (!title) return;
    // 新的子任务继承主任务的分组，并带上这里选择的优先级与计划日期
    const range = validateDateRange(drawer.querySelector('.subtask-add'));
    const planStart = range.ok ? range.planStart : null;
    const planEnd = range.ok ? range.planEnd : null;
    const priority = Number(drawer.querySelector('.subtask-new-priority').value);
    const ok = await guard('添加子任务失败', async () => {
      await api.tasks.create({ title, parentId: task.id, groupId: task.group_id, priority, planStart, planEnd });
    });
    if (!ok) return; // 失败保留输入内容，便于重试
    subtaskInput.value = '';
    await refreshSubtasks(drawer, task.id);
    // 复位新增行的日期与优先级（便于连续添加）
    const addBox = drawer.querySelector('.subtask-add');
    if (addBox) {
      const s = addBox.querySelector('.dr-start-input');
      const en = addBox.querySelector('.dr-end-input');
      if (s) s.value = '';
      if (en) en.value = '';
      const t = addBox.querySelector('.dr-text');
      if (t) t.textContent = '起 ~ 止';
    }
    subtaskInput.focus();
    await syncDetailSideEffects(task.id);
    handlers.toast('已添加子任务');
  };
  subtaskInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { e.preventDefault(); await addSubtask(); }
  });
  const addBtn = drawer.querySelector('[data-act="subtask-add"]');
  if (addBtn) addBtn.addEventListener('click', addSubtask);

  // 子任务：勾选 / 删除（统一由 bindSubtaskRowEvents 绑定，只重绘子树）
  bindSubtaskRowEvents(drawer, task.id);
  bindSubtaskDrag(drawer);

  bindAttachmentEvents(drawer, task);
  bindNoteSectionEvents(drawer, task.id);
}

/**
 * 附件区块交互：添加（选择文件 / 拖拽拖入）、打开、下载（另存为）、删除。
 * 增删后只替换 .att-list 的内容，不整页重绘抽屉 —— 描述编辑器里的光标与滚动位置都要保住。
 */
function bindAttachmentEvents(drawer, task) {
  const listEl = drawer.querySelector('.att-list');
  if (!listEl) return;
  const signal = renderAbort ? renderAbort.signal : undefined;

  /** 用最新的任务数据刷新附件列表与计数 */
  const reload = async () => {
    const fresh = await api.tasks.get(task.id).catch(() => null);
    if (!fresh) return;
    task.attachments = fresh.attachments || [];
    listEl.innerHTML = attachmentsInnerHtml(task.attachments);
    const cnt = drawer.querySelector('.att-count');
    if (cnt) cnt.textContent = String(task.attachments.length);
    // 列表页的附件角标也要跟着变
    await refreshAll();
    handlers.refresh();
  };

  const addPaths = async (paths) => {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    const ok = await guard('添加附件失败', async () => {
      const res = await api.attachments.addPaths(task.id, list);
      if (res && res.failed && res.failed.length) {
        handlers.toast(`已添加 ${res.added} 个附件，${res.failed.length} 个失败：${res.failed[0]}`);
      } else if (res && res.added) {
        handlers.toast(`已添加 ${res.added} 个附件`);
      }
    });
    if (ok) await reload();
  };

  const addBtn = drawer.querySelector('[data-act="att-add"]');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const ok = await guard('添加附件失败', async () => {
        const res = await api.attachments.pick(task.id);
        if (res && res.canceled) return;
        if (res && res.failed && res.failed.length) {
          handlers.toast(`已添加 ${res.added} 个附件，${res.failed.length} 个失败：${res.failed[0]}`);
        } else if (res && res.added) {
          handlers.toast(`已添加 ${res.added} 个附件`);
        }
      });
      if (ok) await reload();
    });
  }

  // 行内操作：事件委托，列表重绘后不需要重新绑定
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-att-act]');
    if (!btn) return;
    const row = btn.closest('[data-att]');
    const key = row ? row.dataset.att : '';
    const name = row ? (row.title || '该附件') : '该附件';
    const act = btn.dataset.attAct;
    if (act === 'open') {
      await guard('打开附件失败', () => api.attachments.open(task.id, key));
    } else if (act === 'save') {
      const ok = await guard('保存附件失败', async () => {
        const res = await api.attachments.saveAs(task.id, key);
        if (res && res.ok) handlers.toast('附件已保存');
      });
      if (!ok) return;
    } else if (act === 'del') {
      if (!confirm(`删除附件「${name}」？文件会从数据目录中一并删除。`)) return;
      const ok = await guard('删除附件失败', () => api.attachments.remove(task.id, key));
      if (ok) { handlers.toast('附件已删除'); await reload(); }
    }
  }, { signal });

  // 拖拽添加：把文件直接拖到附件区
  listEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    listEl.classList.add('drag-over');
  }, { signal });
  listEl.addEventListener('dragleave', () => listEl.classList.remove('drag-over'), { signal });
  listEl.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault(); // 阻止 Electron 默认「把文件当页面打开」
    listEl.classList.remove('drag-over');
    // Electron 32+ 的 File 已没有 .path，必须通过 preload 的 webUtils 换绝对路径
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) {
      handlers.toast('无法读取拖入文件的路径，请改用「＋ 添加附件」');
      return;
    }
    await addPaths(paths);
  }, { signal });
}

/**
 * 重新拉取并只替换子树容器（不重建整个抽屉）。
 * ——以前每次添加/勾选子任务都 renderDetail() 整页重绘：侧栏会闪一下（旧内容被清空再重新填充），
 * 输入框失焦、滚动位置和被展开的日期面板都会丢。
 */
async function refreshSubtasks(drawer, parentId) {
  const container = drawer.querySelector('.subtask-container');
  if (!container) return;
  // 整块替换 innerHTML 前先回收子任务行的保存器：行被销毁后它们的计时器仍在跑，
  // 到期会用已脱离文档的旧 DOM 再写一遍库（拖拽/勾选后可能把刚改过的值覆盖回去）。
  disposeSavers('subtask');
  const html = await renderSubtreeHtml(parentId);
  container.innerHTML = html || '<div class="subtask-empty">暂无子任务</div>';
  bindDateRangeFields(container); // 子任务行内的日期范围控件
  bindSubtaskRowEvents(drawer, parentId);
  bindSubtaskDrag(drawer);
}

/** 为子树内的行绑定勾选 / 删除 / 字段自动保存（复用同一份逻辑，供初始渲染与局部刷新调用） */
function bindSubtaskRowEvents(drawer, parentId) {
  drawer.querySelectorAll('.subtask-item').forEach((li) => {
    if (li.dataset.bound === '1') return;
    li.dataset.bound = '1';
    const sid = Number(li.dataset.id);

    li.querySelector('[data-act="subtask-toggle"]').addEventListener('click', async () => {
      const ok = await guard('更新子任务失败', async () => {
        const next = await api.tasks.toggle(sid);
        // 子任务被勾完时父任务会被自动标记完成：这里要把「连带完成」的祖先也记进今日已完成，
        // 否则父任务会从「今天」列表里凭空消失、只剩下一排子任务
        noteCompletionChange(sid, !!(next && next.completed), next && next.parent_id);
      });
      if (!ok) return;
      await refreshSubtasks(drawer, parentId);
      await syncDetailSideEffects(parentId);
    });
    li.querySelector('[data-act="subtask-del"]').addEventListener('click', async () => {
      const ok = await guard('删除子任务失败', () => api.tasks.remove(sid));
      if (!ok) return;
      await refreshSubtasks(drawer, parentId);
      await syncDetailSideEffects(parentId);
    });

    // 标题 / 优先级 / 计划日期：与主任务一致，改动后防抖自动写入
    bindSubtaskAutoSave(li, sid, parentId, drawer);
  });
}

/** 子任务行的即时持久化（标题、优先级、计划开始 / 完成日期） */
function bindSubtaskAutoSave(li, sid, parentId, drawer) {
  const titleEl = li.querySelector('.subtask-title-input');
  const priEl = li.querySelector('.subtask-priority');
  if (!titleEl || !priEl) return;

  const read = () => {
    // 行已被重绘替换（脱离文档）→ 不再写库，避免用旧 DOM 覆盖服务端的新值
    if (!li.isConnected) return null;
    const title = titleEl.value.trim();
    if (!title) return null; // 标题为空时不写库，等用户继续输入
    const range = validateDateRange(li);
    if (!range.ok) return null;
    return {
      title,
      priority: Number(priEl.value),
      planStart: range.planStart,
      planEnd: range.planEnd,
    };
  };

  const saver = trackSaver(createAutoSave({
    delay: DETAIL_AUTO_SAVE_DELAY,
    read,
    save: (payload) => api.tasks.update(sid, payload),
    onStatus: (status) => {
      li.classList.toggle('saving', status === 'saving');
      li.classList.toggle('save-error', status === 'error');
    },
    onError: (e) => handlers.toast(`子任务保存失败：${(e && e.message) || '未知错误'}`),
    onConflict: () => {
      handlers.toast('该子任务已不存在，未保存的修改已放弃');
      refreshSubtasks(drawer, parentId);
    },
    onSaved: () => {
      // 不重绘子树（会打断输入），只刷新列表页与进度
      refreshAll().then(() => { handlers.refresh(); syncDetailSideEffects(parentId); });
    },
  }), 'subtask');

  saver.setBaseline({
    title: titleEl.value,
    priority: Number(priEl.value),
    planStart: li.querySelector('.dr-start-input') ? li.querySelector('.dr-start-input').value || null : null,
    planEnd: li.querySelector('.dr-end-input') ? li.querySelector('.dr-end-input').value || null : null,
  });

  titleEl.addEventListener('input', () => saver.schedule());
  priEl.addEventListener('change', () => saver.schedule());
  li.addEventListener(DATE_RANGE_EVENT, (e) => {
    e.stopPropagation(); // 子任务的日期变化不应触发父任务的自动保存
    saver.schedule();
  });
  // 行内回车 → 立即保存
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saver.flush(); } });
}

/* ---------------- 描述 AI 润色 ---------------- */

/** 纯文本 → 编辑器 HTML（按空行分段，段内换行转 <br>） */
function plainToEditorHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((block) => {
      const line = esc(block.trim()).replace(/\n/g, '<br>');
      return line ? `<p>${line}</p>` : '';
    })
    .filter(Boolean)
    .join('');
}

/**
 * 润色任务描述：预览 → 采纳 / 重新润色 / 取消；采纳后仍可「还原原文」。
 * 不直接改写编辑器：AI 结果不一定更好，先看再决定才不会把原文弄丢。
 *
 * 反馈三条铁律：点下去立刻有加载态；成功/失败都有明确文案；过程中按钮禁用防重复触发。
 * 早期这里整个函数是 async 且没有任何 catch —— 一旦内部抛错（例如漏 import），
 * 就变成一条无人处理的 rejected Promise，界面上完全看不出来，表现为"点了没反应"。
 */
async function runPolish(drawer) {
  if (polishBusy) return; // 防重复触发：已有一次润色在进行
  const editor = drawer.querySelector('.detail-notes-editor');
  const btn = drawer.querySelector('[data-act="polish"]');
  if (!editor) return;
  const source = editor.innerText.replace(/\u00a0/g, ' ').trim();
  if (!source) { handlers.toast('描述还是空的，先写点内容再润色'); return; }

  const btnLabel = btn ? btn.textContent : '';
  const setBtnBusy = (on) => {
    if (!btn) return;
    btn.disabled = on;
    btn.textContent = on ? '改写中…' : btnLabel;
  };

  // 防重标记必须在**第一个 await 之前**置位：否则连点两次会各自都通过这道判断，
  // 于是弹出两个一模一样的弹窗、发两次请求（冒烟第 15 轮就是这么抓出来的）。
  polishBusy = true;
  setBtnBusy(true);
  try {
    let cfg = null;
    try { cfg = await api.ai.getConfig(); } catch (e) { cfg = null; }
    if (!cfg || !cfg.hasKey) {
      handlers.toast('未配置 AI 接口 Key，请到顶部菜单栏「AI 设置」中填写');
      return;
    }
    await openPolishModal(drawer, editor, source, cfg.polish || null);
  } catch (e) {
    // 兜底：连弹窗都打不开（渲染异常等）也要让用户看到原因
    console.error('[detail][polish]', e);
    handlers.toast(`AI 润色失败：${(e && e.message) || '未知错误'}`);
  } finally {
    setBtnBusy(false);
    polishBusy = false;
  }
}

/**
 * 打开润色预览弹窗（改写取向 / 自定义提示词 + 原文与结果对照）。
 * 弹窗内部的请求一律自行兜错并就地渲染错误 + 重试入口：
 * openPanelModal 不 await onMount，里面的异常没人接，会变成静默失败。
 *
 * 上半区（.np-ctl）是常驻的提示词输入区，下半区（.np-out）是结果区——
 * 两者分开渲染，重跑时输入的内容不会因为结果区被替换而丢失。
 */
async function openPolishModal(drawer, editor, source, polishCfg) {
  const cfg = polishCfg || {};
  const builtIn = cfg.presets || DEFAULT_POLISH_PRESETS;
  const savedInstruction = cfg.instruction || '';

  /** 预设下拉：内置 + 用户自建 */
  const fillPresets = (list, customList) => {
    const all = [...(list || []), ...(customList || [])];
    polishPresets = all;
    const sel = mask && mask.querySelector('.np-preset');
    if (!sel) return;
    sel.innerHTML = all
      .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`)
      .join('') + '<option value="__manage__">管理自建预设…</option>';
    syncPresetSelection();
  };

  /** 让下拉选中项与当前提示词一致：命中某个预设就选它，否则落到「自定义」 */
  const syncPresetSelection = () => {
    const sel = mask && mask.querySelector('.np-preset');
    const ta = mask && mask.querySelector('.np-instruction');
    if (!sel || !ta) return;
    const hit = polishPresets.find((p) => p.instruction && p.instruction === ta.value.trim());
    if (hit) sel.value = hit.id;
    else sel.value = ta.value.trim() ? 'custom' : 'default';
  };

  let mask = null;
  let polishPresets = [...builtIn, ...(cfg.customPresets || [])];

  const presetOptionsHtml = polishPresets
    .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`)
    .join('') + '<option value="__manage__">管理自建预设…</option>';

  const html = `
    <div class="np-ctl">
      <div class="np-ctl-row">
        <label class="np-ctl-label" for="np-preset">改写取向</label>
        <select class="np-preset" id="np-preset">${presetOptionsHtml}</select>
      </div>
      <div class="np-ctl-row">
        <label class="np-ctl-label" for="np-instruction">自定义提示词</label>
        <textarea class="np-instruction" id="np-instruction" rows="2" spellcheck="false"
          placeholder="例：只保留三条要点 / 改成给客户看的口吻 / 输出英文">${esc(savedInstruction)}</textarea>
      </div>
      <div class="np-ctl-ops">
        <button type="button" class="ghost-btn" data-np="save-preset">💾 存为我的预设</button>
        <span class="np-spacer"></span>
        <button type="button" class="primary-btn" data-np="run">✨ 开始改写</button>
      </div>
    </div>
    <div class="np-out"><div class="np-loading">正在改写，请稍候…</div></div>`;

  await openPanelModal({
    title: 'AI 改写描述',
    className: 'modal-xl',
    okText: '关闭',
    html,
    onMount: async (m, close) => {
      mask = m;
      const body = mask.querySelector('.modal-body');
      const out = mask.querySelector('.np-out');
      const ta = mask.querySelector('.np-instruction');
      const sel = mask.querySelector('.np-preset');
      if (!body || !out) return;
      let polished = '';
      let busy = false;

      const showLoading = (text) => { out.innerHTML = `<div class="np-loading">${esc(text)}</div>`; };
      const showError = (msg) => {
        out.innerHTML = `
          <div class="np-error">${esc(msg)}</div>
          <div class="np-ops">
            <span class="np-spacer"></span>
            <button type="button" class="ghost-btn" data-np="retry">🔁 重新改写</button>
          </div>`;
      };
      const showCompare = (text) => {
        out.innerHTML = `
          <div class="np-compare">
            <div class="np-pane">
              <div class="np-pane-title">原文</div>
              <div class="np-box">${esc(source)}</div>
            </div>
            <div class="np-pane">
              <div class="np-pane-title">改写后</div>
              <div class="np-box polished">${esc(text)}</div>
            </div>
          </div>
          <div class="np-ops">
            <button type="button" class="ghost-btn" data-np="retry">🔁 重新改写</button>
            <span class="np-spacer"></span>
            <button type="button" class="ghost-btn" data-np="cancel">取消</button>
            <button type="button" class="primary-btn" data-np="accept">✅ 采纳</button>
          </div>`;
      };

      // 切换预设 → 把该预设的提示词填进输入框（选「自定义」时保留用户自己写的内容）
      if (sel) {
        sel.addEventListener('change', () => {
          if (sel.value === '__manage__') { openPresetManager(); return; }
          const p = polishPresets.find((x) => x.id === sel.value);
          if (p && p.id !== 'custom') ta.value = p.instruction || '';
        });
      }
      if (ta) ta.addEventListener('input', syncPresetSelection);
      // 记住这次用的提示词，下次打开自动带出（失败不影响改写结果，只吞掉）
      const remember = (instruction) => {
        api.ai.savePolish({ instruction }).catch(() => {});
      };

      const run = async (isRetry) => {
        if (busy) return;
        busy = true;
        showLoading(isRetry ? '正在重新改写，请稍候…' : '正在改写，请稍候…');
        try {
          const r = await api.ai.polish({ text: source, instruction: (ta && ta.value.trim()) || '' });
          if (!r || !r.ok) throw new Error((r && r.message) || '改写失败');
          polished = r.text || '';
        } catch (e) {
          busy = false;
          if (!mask.isConnected) return; // 请求期间用户已关窗，不再操作已卸载的 DOM
          // 超时 / 网络异常 / 接口报错统一在这里翻译成一句人话
          const raw = (e && e.message) ? e.message : '未知错误';
          const tip = /超时|timeout/i.test(raw) ? 'AI 改写超时' : 'AI 改写失败';
          showError(`${tip}：${raw}`);
          handlers.toast(`${tip}：${raw}`);
          return;
        }
        busy = false;
        if (!mask.isConnected) return;
        if (!polished) {
          showError('AI 没有返回有效内容，请稍后重试');
          return;
        }
        showCompare(polished);
      };

      /** 自建预设管理：列出已有预设，可删除；新增走「存为我的预设」 */
      const openPresetManager = async () => {
        const custom = polishPresets.filter((p) => p.id.startsWith('custom:'));
        const rows = custom.length
          ? custom.map((p) => `
              <tr>
                <td>${esc(p.label)}</td>
                <td class="np-preset-text">${esc(p.instruction || '')}</td>
                <td><button type="button" class="ghost-btn tiny" data-del="${esc(p.label)}">删除</button></td>
              </tr>`).join('')
          : '<tr><td colspan="3" class="np-empty">还没有自建预设，可在润色弹窗里点「存为我的预设」添加</td></tr>';
        await openPanelModal({
          title: '我的润色预设',
          html: `<table class="md-help-table np-preset-table">
              <thead><tr><th>名称</th><th>提示词</th><th></th></tr></thead>
              <tbody>${rows}</tbody></table>`,
          onMount: async (root, closeMgr) => {
            root.addEventListener('click', async (e) => {
              const del = e.target.closest('[data-del]');
              if (!del) return;
              try {
                const next = await api.ai.savePolish({ deletePreset: del.dataset.del });
                polishPresets = [...(next.presets || []), ...(next.customPresets || [])];
                handlers.toast('已删除预设');
                closeMgr();
              } catch (err) {
                handlers.toast(`删除预设失败：${(err && err.message) || '未知错误'}`);
              }
            });
          },
        });
        sel.value = ta && ta.value.trim() ? 'custom' : 'default';
      };

      // 事件委托挂在常驻的 .modal-body 上：主体内容会被反复替换，委托才不会失效
      body.addEventListener('click', async (e) => {
        const hit = e.target.closest('[data-np]');
        if (!hit) return;
        const act = hit.dataset.np;
        if (act === 'cancel') { close(); return; }
        if (act === 'retry') { await run(true); return; }
        if (act === 'run') { const ins = ta ? ta.value.trim() : ''; remember(ins); await run(false); return; }
        if (act === 'save-preset') {
          const instruction = ta ? ta.value.trim() : '';
          if (!instruction) { handlers.toast('先写点提示词，再存为预设'); return; }
          const label = await openPromptModal({
            title: '存为我的预设',
            label: '预设名称',
            placeholder: '如：给客户的周报口吻',
            okText: '保存',
            onSubmit: async (v) => {
              const name = (v || '').trim();
              if (!name) return '请填写预设名称';
              if (polishPresets.some((p) => !p.id.startsWith('custom:') && p.label === name)) {
                return '与内置预设重名，换一个名字';
              }
              try {
                const next = await api.ai.savePolish({ instruction, savePreset: { label: name, instruction } });
                polishPresets = [...(next.presets || []), ...(next.customPresets || [])];
                // 重绘下拉并把自建预设补进去
                fillPresets(next.presets, next.customPresets);
                const mine = polishPresets.find((p) => p.id === `custom:${name}`);
                if (mine && sel) sel.value = mine.id;
              } catch (err) {
                return (err && err.message) || '保存失败，请重试';
              }
              return undefined;
            },
          });
          if (label) handlers.toast('已保存为我的预设');
          return;
        }
        if (act === 'accept') {
          if (!polished) { close(); return; }
          polishBackup = editor.innerHTML;
          editor.innerHTML = plainToEditorHtml(polished);
          const restoreBtn = drawer.querySelector('[data-act="polish-restore"]');
          if (restoreBtn) restoreBtn.hidden = false;
          if (drawer.__autoSave) drawer.__autoSave.schedule();
          handlers.toast('已采纳改写结果');
          close();
        }
      });

      syncPresetSelection();
      await run(false);
    },
  });
}

/** 内置润色预设兜底：主进程配置没取到时界面也不至于空白 */
const DEFAULT_POLISH_PRESETS = [
  { id: 'default', label: '润色优化（推荐）', instruction: '在保持原意的前提下重写：理清逻辑顺序，让目标、产出与约束一目了然，去掉口语化赘词。' },
  { id: 'concise', label: '精简压缩', instruction: '大幅精简：保留全部事实与结论，删掉重复与修饰，字数尽量压到原文的 60% 以内。' },
  { id: 'checklist', label: '转结构化清单', instruction: '改写成结构化清单：先一句总述，再用「1. 2. 3.」列出可执行条目，每条一句话、以动词开头。' },
  { id: 'custom', label: '自定义', instruction: '' },
];

/**
 * 子任务变化后的“非视觉”副作用：刷新列表页数据与父任务勾选状态。
 * 父任务可能在「所有子任务完成」时被自动标记完成，这里只更新标题旁的勾选与页脚，不重绘整页。
 */
async function syncDetailSideEffects(parentId) {
  try {
    await refreshAll();
    handlers.refresh();
    const drawer = document.getElementById('detail-drawer');
    const parent = await api.tasks.get(parentId);
    if (drawer && parent) {
      const check = drawer.querySelector('.detail-check');
      if (check) {
        check.classList.toggle('done', !!parent.completed);
        check.textContent = parent.completed ? '✓' : '';
      }
      const archiveBtn = drawer.querySelector('[data-act="archive"]');
      if (archiveBtn && parent.archived) archiveBtn.textContent = '取消归档';
    }
  } catch (e) {
    console.warn('[detail] 同步子任务副作用失败', e && e.message);
  }
}

/**
 * 子任务拖拽排序（同一父级内重排）。
 * 与任务主列表同一套规则：只有按住行首手柄才允许拖拽（否则标题输入框会抢走 mousedown，
 * 看起来就是"拖不动"），落点决定新的 sort_order，刷新后由 SQL 的 sort_order 优先序生效。
 */
function bindSubtaskDrag(container) {
  container.querySelectorAll('.subtree').forEach((ul) => {
    ul.querySelectorAll(':scope > li.subtask-item').forEach((li) => {
      if (li.dataset.dragBound === '1') return;
      li.dataset.dragBound = '1';
      const handle = li.querySelector('.drag-handle');
      if (!handle) return;

      const enable = () => { li.draggable = true; };
      const disable = () => { li.draggable = false; };
      handle.addEventListener('pointerdown', enable);
      handle.addEventListener('pointerup', disable);

      li.addEventListener('dragstart', (e) => {
        if (!li.draggable) { e.preventDefault(); return; }
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(li.dataset.id));
        }
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => {
        disable();
        li.classList.remove('dragging');
        ul.querySelectorAll(':scope > li.drag-over').forEach((x) => x.classList.remove('drag-over'));
      });
      li.addEventListener('dragover', (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        li.classList.add('drag-over');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
      li.addEventListener('drop', async (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        const fromId = Number(e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
        const items = Array.from(ul.querySelectorAll(':scope > li.subtask-item'));
        const ids = items.map((x) => Number(x.dataset.id));
        const fromIdx = ids.indexOf(fromId);
        const toIdx = ids.indexOf(Number(li.dataset.id));
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;

        ids.splice(toIdx, 0, ...ids.splice(fromIdx, 1));
        const ok = await guard('保存子任务顺序失败', () => api.tasks.reorder(ids));
        if (!ok) return;
        const drawer = li.closest('.detail-drawer');
        const pid = Number(ul.dataset.parent) || 0;
        if (drawer && pid) await refreshSubtasks(drawer, pid);
        handlers.toast('子任务顺序已保存');
      });
    });
  });
}

/**
 * 从详情面板收集待保存字段。返回 null 表示当前值不合法（标题为空 / 日期未通过校验）。
 * 供「保存」按钮与即时持久化共用，保证两条路径写入的数据一致。
 */
function collectDetailPayload(drawer, { quiet = false } = {}) {
  const title = drawer.querySelector('.detail-title').value.trim();
  if (!title) {
    if (!quiet) handlers.toast('请输入任务标题');
    return null;
  }
  // 重复事项：计划日期 / 提醒由规则派生，表单里没有这两个控件（也绝不能凭"空控件"折成 null 写库）
  const derived = !!drawer.querySelector('[data-rpt-derived]');
  let planStart = null;
  let planEnd = null;
  let reminderAt = null;
  if (!derived) {
    const range = validateDateRange(drawer);
    if (!range.ok) {
      if (!quiet) {
        handlers.toast(range.message);
        drawer.querySelector('.date-range-trigger').focus();
      }
      return null;
    }
    planStart = range.planStart;
    planEnd = range.planEnd;
    if (reminderNeedsPlanEnd(drawer) && !planEnd) {
      if (!quiet) handlers.toast('请先设置完成日期，再选择提醒时间');
      return null;
    }
    reminderAt = computeReminder(drawer, planEnd);
  }
  // 描述由所见即所得编辑器统一序列化（html 模式 = 去掉 contenteditable 等编辑态痕迹的 innerHTML），
  // 保证「未改动不写库」的基线与这里取到的是同一份字符串
  const editor = drawer.querySelector('.detail-notes-editor');
  const notes = drawer.__notesEditor
    ? drawer.__notesEditor.value()
    : ((editor.textContent.trim() || editor.querySelector('img')) ? editor.innerHTML : '');
  const payload = {
    title,
    priority: Number(drawer.querySelector('.detail-priority').value),
    groupId: drawer.querySelector('.detail-group').value ? Number(drawer.querySelector('.detail-group').value) : null,
    notes,
    // 标签必须参与基线比对：否则只改标签时 autosave 会判定「无变化」直接跳过写库，
    // 标签永远保存不上。这里存原始输入串（tagIds 在 save() 里异步解析）。
    tags: drawer.querySelector('.detail-tags').value,
  };
  if (!derived) Object.assign(payload, { planStart, planEnd, reminderAt });
  return payload;
}

/** 保存状态的时间戳（"已保存 14:03" 比干巴巴的"已保存"更有说服力） */
function nowLabel() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 详情保存状态提示 */
function setDetailSaveState(drawer, status, message) {
  const el = drawer.querySelector('.detail-save-state');
  if (!el) return;
  el.textContent = message || SAVE_STATE_TEXT[status] || '';
  el.className = `detail-save-state s-${status}`;
  el.title = status === 'error' ? (message || '保存失败，点击重试') : '修改会自动保存';
}

/**
 * 详情面板的即时持久化：任意字段改动 → 防抖后自动写库。
 * 基线必须用「编辑器实际序列化出来的字符串」（而不是库里的原始值 / 渲染前的 HTML），
 * 否则浏览器的 DOM 归一化会让两边永远不相等，出现"没改也写库"。
 */
function bindDetailAutoSave(drawer, task, notesHtml, { derived = false } = {}) {
  // 身份校验是最后一道闸：抽屉已经切到别的任务（或已关闭）时，read 直接返回 null，
  // 本次保存整个作废 —— 宁可少写一次，也绝不能把 B 的内容写进 A。
  const read = () => (isDrawerShowing(task.id) ? collectDetailPayload(drawer, { quiet: true }) : null);
  const notesEl = drawer.querySelector('.detail-notes-editor');
  const baselineNotes = drawer.__notesEditor
    ? drawer.__notesEditor.value()
    : (notesHtml != null ? notesHtml : (task.notes || ''));

  const saver = trackSaver(createAutoSave({
    delay: DETAIL_AUTO_SAVE_DELAY,
    read,
    save: async (payload) => {
      if (!isDrawerShowing(task.id)) return null; // 二次校验：写入前再确认一次身份
      const tagIds = await resolveTagIds(drawer.querySelector('.detail-tags').value);
      return api.tasks.update(task.id, { ...payload, tagIds });
    },
    onStatus: (status, info) => {
      setDetailSaveState(
        drawer,
        status,
        status === 'error' ? (info === 'conflict' ? '任务已不存在' : '保存失败，点击重试')
          : status === 'saved' ? `已保存 ${nowLabel()}`
            : '',
      );
    },
    onError: (e) => {
      handlers.toast(`自动保存失败：${(e && e.message) || '未知错误'}`);
    },
    onConflict: () => {
      handlers.toast('该任务已被删除，未保存的修改已放弃');
      closeDetail();
      refreshAll().then(() => handlers.refresh());
    },
    onSaved: () => {
      // 不重绘抽屉（会打断输入 / 丢失光标），只同步列表页数据
      refreshAll().then(() => handlers.refresh());
    },
  }), 'main');

  const baseline = {
    title: task.title,
    priority: task.priority,
    groupId: task.group_id ?? null,
    notes: baselineNotes,
    // 与 collectDetailPayload 的 tags 字段同构：初始渲染用的就是 join(', ')
    tags: (task.tag_names || []).join(', '),
  };
  // 基线必须与 payload 同构（samePayload 比 key 数量）：派生字段不进表单，也就不进基线
  if (!derived) {
    baseline.planStart = task.plan_start;
    baseline.planEnd = task.plan_end;
    baseline.reminderAt = task.reminder_at;
  }
  saver.setBaseline(baseline);

  const signal = renderAbort ? renderAbort.signal : undefined;
  // 子任务区有自己的保存器（bindSubtaskAutoSave），这里的抽屉级监听要避开它，
  // 否则动一个子任务标题会连带把父任务整体再写一遍。
  // 重复配置区有自己的保存按钮，不能让抽屉级 autosave 抢着写库
  const fromSubtask = (e) => !!e.target.closest('.subtask-item, .subtask-add, .detail-repeat');
  // 输入类字段
  drawer.addEventListener('input', (e) => { if (!fromSubtask(e)) saver.schedule(); }, { signal });
  // 下拉 / 日期等（change 不冒泡到 input，两类都监听）
  drawer.addEventListener('change', (e) => { if (!fromSubtask(e)) saver.schedule(); }, { signal });
  drawer.addEventListener(DATE_RANGE_EVENT, () => saver.schedule(), { signal });
  // 富文本描述：粘贴图片不触发 input，需要单独监听
  if (notesEl) {
    notesEl.addEventListener('input', () => saver.schedule(), { signal });
    notesEl.addEventListener('paste', () => saver.schedule(), { signal });
  }
  // 点击状态标签 → 立即重试
  const stateEl = drawer.querySelector('.detail-save-state');
  if (stateEl) stateEl.addEventListener('click', () => saver.flush(), { signal });

  return saver;
}

/** 「保存」按钮：立即写入（自动保存已覆盖日常改动，这里是手动 flush） */
async function saveDetail(drawer, task) {
  // 抽屉里的 DOM 必须确实是这个任务的：否则宁可不保存，也不能把 A 的界面写成 B 的数据
  if (!isDrawerShowing(task.id)) return;
  const payload = collectDetailPayload(drawer);
  if (!payload) return;
  const saver = drawer.__autoSave;
  if (saver) {
    await saver.flush();
    const el = drawer.querySelector('.detail-save-state');
    if (el && el.className.indexOf('s-error') > -1) return; // 失败不关闭，便于重试
    handlers.toast('已保存');
    return;
  }
  // 兜底：自动保存未挂载时按老路径写入
  const ok = await guard('保存失败', async () => {
    const tagIds = await resolveTagIds(drawer.querySelector('.detail-tags').value);
    await api.tasks.update(task.id, { ...payload, tagIds });
  });
  if (!ok) return;
  handlers.toast('已保存');
  await refreshAll();
  handlers.refresh();
  renderDetail();
}
