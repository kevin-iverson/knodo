'use strict';
/**
 * 任务详情页（右侧抽屉）：基础信息编辑、树形子任务层级（可拖拽排序）、
 * 所见即所得 Markdown 描述（支持快捷键与粘贴图片，图片直接插入光标处）。
 */
import { api, PRIORITY_TEXT } from './api.js';
import { state, loadGroups, loadTags, refreshAll, noteCompletionChange } from './store.js';
import { renderMarkdown } from './markdown.js';
import {
  dateRangeFieldHtml, bindDateRangeFields, validateDateRange,
  DATE_RANGE_EVENT, DATE_RANGE_DEFAULTS, syncReminderWithPlanEnd, isAnyRangeOpen,
  reminderHtml, bindReminder, computeReminder, reminderNeedsPlanEnd,
} from './controls.js';
import { createAutoSave, SAVE_STATE_TEXT } from './autosave.js';
import { groupOptionsHtml } from './group-tree.js';

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

/**
 * 统一错误处理：把失败原因提示给用户，避免"点了没反应"。
 * 返回 true 表示成功，false 表示已提示并应中止后续刷新。
 */
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
  window.addEventListener('resize', () => {
    if (detailWidth == null || resizing) return;
    const w = clampDetailWidth(detailWidth);
    if (w !== detailWidth) { detailWidth = w; }
    applyDetailWidth(panel);
  });
}

export function openDetail(id) {
  state.detailTaskId = id;
  renderDetail();
}

export function closeDetail() {
  state.detailTaskId = null;
  const drawer = document.getElementById('detail-drawer');
  if (drawer) {
    drawer.hidden = true;
    drawer.dataset.opened = ''; // 下次打开重新播放入场动画
  }
}

export function isDetailOpen() {
  return state.detailTaskId != null;
}

/** 描述内容 → HTML（兼容旧 Markdown 数据与新所见即所得 HTML） */
function notesToHtml(notes) {
  if (!notes) return '';
  if (/<\/?[a-z][^>]*>/i.test(notes)) return notes;
  return renderMarkdown(notes);
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

  const task = await api.tasks.get(id);
  if (!task) { drawer.hidden = true; state.detailTaskId = null; return; }
  await loadGroups();
  await loadTags();

  const subtreeHtml = await renderSubtreeHtml(id);
  // 期间若已切换到别的任务 / 被又一次渲染取代，直接放弃本次结果
  if (token !== renderToken) return;
  const parentInfo = task.parent_id
    ? `<div class="detail-parent" data-act="goto-parent" data-parent="${task.parent_id}">↳ 所属父任务：${esc(task.parent_title || '未知')}</div>`
    : '';

  // 只有「从关闭状态打开」才播入场动画；同一任务被重绘（保存、勾选子任务…）时不再滑入，
  // 否则每次重绘都会有 200ms 的位移 + 淡入，看着像界面在闪。
  const reopen = drawer.dataset.opened === '1';

  drawer.innerHTML = `
    <div class="detail-mask" data-act="close"></div>
    <div class="detail-panel${reopen ? ' no-anim' : ''}">
      <div class="detail-resizer" data-act="resize" title="拖拽调整宽度（双击恢复默认）" role="separator" aria-orientation="vertical"></div>
      <div class="detail-head">
        <button class="detail-check${task.completed ? ' done' : ''}" data-act="toggle" title="完成/取消">${task.completed ? '✓' : ''}</button>
        <input class="detail-title" placeholder="任务标题" value="${esc(task.title)}" />
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
          ${dateRangeFieldHtml(task.plan_start, task.plan_end, { required: PLAN_DATE_REQUIRED, placeholder: '计划开始 ~ 完成' })}
        </div>
        <div class="detail-row">
          ${reminderHtml(task.reminder_at, task.plan_end)}
          <label class="detail-field grow">标签（逗号分隔）
            <input class="detail-tags" placeholder="如：项目A, 紧急" value="${esc((task.tag_names || []).join(', '))}" />
          </label>
        </div>

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

        <div class="detail-section">
          <div class="detail-section-head"><span>描述</span></div>
          <div class="detail-notes-editor markdown-body" contenteditable="true"
               data-placeholder="支持 Markdown 快捷键（Ctrl+B 加粗 / Ctrl+I 斜体），可直接粘贴图片…"></div>
        </div>
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
  await ensureDetailWidth();
  bindResizer(drawer);
  bindDateRangeFields(drawer); // 主任务 + 子任务新增区 + 各行内的日期范围控件
  bindReminder(drawer);
  // 范围被清除/修改后同步提醒预设（依赖完成日期的预设会自动回到“不提醒”）
  drawer.addEventListener(DATE_RANGE_EVENT, (e) => syncReminderWithPlanEnd(drawer, e.detail.planEnd));
  bindDetailEvents(drawer, task);
  // 即时持久化：挂载在事件绑定之后，保证能监听到同一批事件
  drawer.__autoSave = bindDetailAutoSave(drawer, task);
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
    // 与列表勾选保持一致：今天视图里保留刚完成的任务
    noteCompletionChange(task.id, !!(next && next.completed));
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

  // 所见即所得描述：粘贴图片插入光标处
  const editor = drawer.querySelector('.detail-notes-editor');
  editor.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => insertImageAtCursor(reader.result);
        reader.readAsDataURL(file);
      }
    }
  });

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
}

/**
 * 重新拉取并只替换子树容器（不重建整个抽屉）。
 * ——以前每次添加/勾选子任务都 renderDetail() 整页重绘：侧栏会闪一下（旧内容被清空再重新填充），
 * 输入框失焦、滚动位置和被展开的日期面板都会丢。
 */
async function refreshSubtasks(drawer, parentId) {
  const container = drawer.querySelector('.subtask-container');
  if (!container) return;
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
      const ok = await guard('更新子任务失败', () => api.tasks.toggle(sid));
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

  const saver = createAutoSave({
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
  });

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

/** 图片插入到所见即所得编辑器光标处 */
function insertImageAtCursor(dataUrl) {
  const sel = window.getSelection();
  const editor = document.querySelector('.detail-notes-editor');
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    const img = document.createElement('img');
    img.src = dataUrl;
    img.className = 'notes-img';
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editor.focus();
    document.execCommand('insertImage', false, dataUrl);
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
  const range = validateDateRange(drawer);
  if (!range.ok) {
    if (!quiet) {
      handlers.toast(range.message);
      drawer.querySelector('.date-range-trigger').focus();
    }
    return null;
  }
  const { planStart, planEnd } = range;
  if (reminderNeedsPlanEnd(drawer) && !planEnd) {
    if (!quiet) handlers.toast('请先设置完成日期，再选择提醒时间');
    return null;
  }
  const editor = drawer.querySelector('.detail-notes-editor');
  const notes = (editor.textContent.trim() || editor.querySelector('img')) ? editor.innerHTML : '';
  return {
    title,
    priority: Number(drawer.querySelector('.detail-priority').value),
    groupId: drawer.querySelector('.detail-group').value ? Number(drawer.querySelector('.detail-group').value) : null,
    planStart,
    planEnd,
    reminderAt: computeReminder(drawer, planEnd),
    notes,
  };
}

/** 详情保存状态提示 */
function setDetailSaveState(drawer, status, message) {
  const el = drawer.querySelector('.detail-save-state');
  if (!el) return;
  el.textContent = message || SAVE_STATE_TEXT[status] || '';
  el.className = `detail-save-state s-${status}`;
  el.title = status === 'error' ? (message || '保存失败，点击重试') : '修改会自动保存';
}

/** 详情面板的即时持久化：任意字段改动 → 防抖后自动写库 */
function bindDetailAutoSave(drawer, task) {
  const read = () => collectDetailPayload(drawer, { quiet: true });

  const saver = createAutoSave({
    delay: DETAIL_AUTO_SAVE_DELAY,
    read,
    save: async (payload) => {
      const tagIds = await resolveTagIds(drawer.querySelector('.detail-tags').value);
      return api.tasks.update(task.id, { ...payload, tagIds });
    },
    onStatus: (status, info) => {
      setDetailSaveState(drawer, status, status === 'error' ? (info === 'conflict' ? '任务已不存在' : '保存失败，点击重试') : '');
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
  });

  saver.setBaseline({
    title: task.title,
    priority: task.priority,
    groupId: task.group_id ?? null,
    planStart: task.plan_start,
    planEnd: task.plan_end,
    reminderAt: task.reminder_at,
    notes: task.notes || '',
  });

  // 输入类字段
  drawer.addEventListener('input', () => saver.schedule());
  // 下拉 / 日期等（change 不冒泡到 input，两类都监听）
  drawer.addEventListener('change', () => saver.schedule());
  drawer.addEventListener(DATE_RANGE_EVENT, () => saver.schedule());
  // 富文本描述：粘贴图片不触发 input，需要单独监听
  const notesEl = drawer.querySelector('.detail-notes-editor');
  if (notesEl) {
    notesEl.addEventListener('input', () => saver.schedule());
    notesEl.addEventListener('paste', () => saver.schedule());
  }
  const stateEl = drawer.querySelector('.detail-save-state');
  if (stateEl) stateEl.addEventListener('click', () => saver.flush());

  return saver;
}

/** 「保存」按钮：立即写入（自动保存已覆盖日常改动，这里是手动 flush） */
async function saveDetail(drawer, task) {
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
