'use strict';
/**
 * 视图渲染与交互（分组、任务、就地新增/编辑、拖拽排序、时间筛选、深色模式）。
 *
 * 新增/编辑任务采用“飞书式”就地交互：列表底部提供“添加任务”入口，点击后
 * 原地展开编辑器；“计划开始日期 / 计划完成日期”直接放在新增行主表单中填写。
 */
import { api, localToIso, isoToLocal, fmtDateTime, PRIORITY_TEXT } from './api.js';
import { state, loadGroups, loadTags, loadTasks, refreshAll, todayStr } from './store.js';
import { renderReports } from './reports.js';
import { openDetail, setDetailHandlers } from './detail.js';
import { renderSearch, setSearchHandlers } from './search.js';
import { openPromptModal } from './modal.js';
import { createAutoSave, SAVE_STATE_TEXT } from './autosave.js';

/** 即时持久化防抖延迟（毫秒）：输入停止这么久之后才写库 */
const AUTO_SAVE_DELAY = 700;
import {
  dateRangeFieldHtml, bindDateRangeFields, validateDateRange,
  DATE_RANGE_EVENT, DATE_RANGE_DEFAULTS, syncReminderWithPlanEnd, defaultDateRange,
  reminderHtml, bindReminder, computeReminder, reminderNeedsPlanEnd,
} from './controls.js';

// 新建任务时计划日期的默认范围：'none' = 留空（默认），'today' = 今天 ~ 今天
const NEW_TASK_RANGE_MODE = 'none';
// 计划日期是否必填（默认否：允许创建“无期限”任务）
const PLAN_DATE_REQUIRED = DATE_RANGE_DEFAULTS.required;

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const VIEW_META = {
  today: { title: '今天', desc: '今天或已逾期的进行中任务（按计划完成日期）' },
  upcoming: { title: '即将到期', desc: '计划完成日期在今天或之后的任务' },
  all: { title: '全部任务', desc: '所有进行中与已完成任务' },
  completed: { title: '已完成', desc: '已完成但未归档的任务' },
  archived: { title: '归档', desc: '已归档的完成任务' },
  stats: { title: '统计', desc: '任务完成情况概览' },
  reports: { title: 'AI 报告', desc: '基于本地数据自动生成日报 / 周报 / 月报' },
  search: { title: 'AI 检索', desc: '输入关键词检索任务，由 AI 生成总结' },
};

// 时间筛选输入框与状态键的映射
const TF_BINDINGS = [
  ['tf-plan-start-from', 'planStartFrom'],
  ['tf-plan-start-to', 'planStartTo'],
  ['tf-plan-end-from', 'planEndFrom'],
  ['tf-plan-end-to', 'planEndTo'],
  ['tf-completed-from', 'completedFrom'],
  ['tf-completed-to', 'completedTo'],
];

/* ---------------- 初始化 ---------------- */

export async function init() {
  setDetailHandlers({ refresh: () => { renderSidebar(); renderTasks(); }, toast });
  setSearchHandlers({ openDetail, toast });
  bindStaticEvents();
  await initTheme();
  await renderSidebar();
  await render();
}

function bindStaticEvents() {
  // 导航
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      state.currentGroup = 'all';
      state.editingTaskId = null;
      state.addingTask = false;
      renderSidebar();
      render();
    });
  });

  // 分组 / 标签新增
  document.getElementById('btn-add-group').addEventListener('click', promptAddGroup);
  document.getElementById('btn-add-tag').addEventListener('click', promptAddTag);

  // 数据导入 / 导出
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import').addEventListener('click', importData);

  // 搜索
  const searchInput = document.getElementById('search-input');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = searchInput.value.trim();
      renderTasks();
    }, 200);
  });

  // 优先级筛选
  document.querySelectorAll('.chip[data-priority]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.priorityFilter = chip.dataset.priority;
      document.querySelectorAll('.chip[data-priority]').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderTasks();
    });
  });

  // 排序方式（智能 / 优先级 / 截止日期 / 手动）
  const sortSel = document.getElementById('sort-select');
  if (sortSel) {
    sortSel.value = state.sortMode;
    sortSel.addEventListener('change', async () => {
      setSortMode(sortSel.value);
      await renderTasks();
      if (state.sortMode === 'manual') toast('手动排序：按住任务左侧的 ⠿ 手柄拖动即可调整顺序');
    });
  }

  // 时间筛选：切换面板 + 日期输入
  document.getElementById('btn-time-filter').addEventListener('click', () => {
    const tf = document.getElementById('time-filter');
    tf.hidden = !tf.hidden;
  });
  TF_BINDINGS.forEach(([id, key]) => {
    document.getElementById(id).addEventListener('change', (e) => {
      state.timeFilters[key] = e.target.value;
      renderTasks();
    });
  });
  document.getElementById('tf-clear').addEventListener('click', () => {
    TF_BINDINGS.forEach(([id, key]) => {
      state.timeFilters[key] = '';
      document.getElementById(id).value = '';
    });
    renderTasks();
  });

  // 新建（顶部按钮 → 展开列表底部编辑器） / 归档已完成
  document.getElementById('btn-new-task').addEventListener('click', () => {
    ensureTaskView();
    startAdd();
  });
  document.getElementById('btn-archive-done').addEventListener('click', archiveCompleted);

  // 主题
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // 主进程事件：托盘/快捷键“快速添加” → 展开底部编辑器
  api.on('ui:quick-add', () => {
    ensureTaskView();
    startAdd();
  });
  // 提醒点击 → 定位到任务并就地打开编辑
  api.on('ui:focus-task', (id) => {
    ensureTaskView();
    startEdit(id);
  });
}

/** 确保当前处于任务类视图（否则切到“全部任务”） */
function ensureTaskView() {
  const taskViews = ['today', 'upcoming', 'all', 'completed'];
  if (taskViews.includes(state.view)) return;
  state.view = 'all';
  state.currentGroup = 'all';
  renderSidebar();
  const meta = VIEW_META.all;
  document.getElementById('view-title').textContent = meta.title;
  document.getElementById('view-desc').textContent = meta.desc;
}

/* ---------------- 渲染入口 ---------------- */

async function render() {
  const meta = VIEW_META[state.view] || VIEW_META.all;
  document.getElementById('view-title').textContent = meta.title;
  document.getElementById('view-desc').textContent = meta.desc;

  if (state.view === 'stats') { await renderStats(); return; }
  if (state.view === 'reports') { await renderReports(); return; }
  if (state.view === 'search') { renderSearch(); return; }
  await renderTasks();
}

async function renderSidebar() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  await loadGroups();
  await loadTags();
  renderSidebarList();
}

/** 仅重绘分组 / 标签列表（使用 state 中已有数据，避免多余请求、避免重复拉取覆盖新增项） */
function renderSidebarList() {
  const groups = state.groups;
  const groupList = document.getElementById('group-list');
  if (!groupList) return; // 元素缺失时直接返回，避免整条链路抛出异常后按钮全部失效
  groupList.innerHTML = '';

  const allItem = document.createElement('li');
  allItem.className = 'group-item' + (state.currentGroup === 'all' ? ' active' : '');
  allItem.innerHTML = `<span class="group-dot" style="background:#c3cad6"></span>
    <span class="group-name">全部</span>`;
  allItem.addEventListener('click', () => {
    state.currentGroup = 'all';
    renderSidebarList();
    renderTasks();
  });
  groupList.appendChild(allItem);

  for (const g of groups) {
    const li = document.createElement('li');
    li.className = 'group-item' + (state.currentGroup === g.id ? ' active' : '');
    li.dataset.id = g.id;
    li.innerHTML = `
      <span class="group-dot" style="background:${esc(g.color)}"></span>
      <span class="group-name">${esc(g.name)}</span>
      <span class="group-count">${g.active_count || 0}</span>
      <span class="group-actions">
        <button class="g-edit" title="编辑">✎</button>
        <button class="g-del" title="删除">×</button>
      </span>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.g-edit')) return editGroup(g);
      if (e.target.closest('.g-del')) return deleteGroup(g);
      state.currentGroup = g.id;
      renderSidebarList();
      renderTasks();
    });
    li.querySelector('.g-edit').addEventListener('click', () => editGroup(g));
    li.querySelector('.g-del').addEventListener('click', () => deleteGroup(g));
    groupList.appendChild(li);
  }

  // 标签
  const tagList = document.getElementById('tag-list');
  if (!tagList) return;
  tagList.innerHTML = '';
  if (!state.tags.length) {
    tagList.innerHTML = '<li class="list-empty">暂无标签，点击 ＋ 新增</li>';
    return;
  }
  for (const t of state.tags) {
    const li = document.createElement('li');
    li.className = 'tag-item' + (state.currentTag === t.id ? ' active' : '');
    li.dataset.id = t.id;
    li.innerHTML = `
      <span class="tag-color" style="background:${esc(t.color)}"></span>
      <span class="tag-name">${esc(t.name)}</span>
      <span class="tag-count">${t.task_count || 0}</span>
      <button class="tag-del" title="删除">×</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.tag-del')) return;
      state.currentTag = state.currentTag === t.id ? null : t.id;
      renderSidebarList();
      renderTasks();
    });
    li.querySelector('.tag-del').addEventListener('click', () => deleteTag(t));
    tagList.appendChild(li);
  }
}

/* ---------------- 任务列表 ---------------- */

function hasTimeFilter() {
  const tf = state.timeFilters;
  return !!(tf.planStartFrom || tf.planStartTo || tf.planEndFrom || tf.planEndTo || tf.completedFrom || tf.completedTo);
}

async function renderTasks() {
  const tasks = await loadTasks();
  // 展开的子节点可能被当前视图 / 筛选条件过滤掉（例如「今天」视图要求 plan_end <= 今天，
  // 而子任务往往没有日期）。为保证"点得开、看得见"，显式补拉已展开任务的子任务。
  await withExpandedChildren(tasks);
  const viewEl = document.getElementById('view');
  const isArchived = state.view === 'archived';
  const hasFilters = state.currentGroup !== 'all' || !!state.search || state.priorityFilter !== 'all' || hasTimeFilter();

  let html = '';

  if (tasks.length === 0) {
    const emptyText = isArchived
      ? '还没有归档的任务'
      : '暂无符合条件的任务';
    html += `<div class="empty"><span class="big">🎉</span>${esc(emptyText)}</div>`;
  } else if (isArchived || hasFilters) {
    html += buildTaskList(flattenTree(tasks));
  } else {
    // 未筛选时按分组分组展示（组内父子任务树形展开）
    // 以"最顶层祖先"的分组归组：补拉进来的子任务即使 group_id 与父任务不同，也跟着父任务走
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const topGroup = (t) => {
      let cur = t;
      for (let i = 0; i < 20 && cur.parent_id && byId.has(cur.parent_id); i++) cur = byId.get(cur.parent_id);
      return cur.group_id || null;
    };
    const grouped = groupBy(tasks, topGroup);
    for (const [gid, items] of grouped) {
      const g = state.groups.find((x) => x.id === gid);
      const gName = g ? g.name : '未分组';
      const gColor = g ? g.color : '#c3cad6';
      html += `<div class="task-group-head"><span class="g-dot" style="background:${esc(gColor)}"></span>${esc(gName)}</div>`;
      html += buildTaskList(flattenTree(items));
    }
  }

  // 列表底部：就地新增入口（归档视图不提供新增）
  if (!isArchived) {
    html += state.addingTask ? newEditorHtml() : addRowHtml();
  }

  viewEl.innerHTML = html;
  bindTaskListEvents(viewEl);
  bindEditorEvents(viewEl);
  if (state.addingTask || state.editingTaskId != null) focusEditor();
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/**
 * 补齐已展开任务的子任务。
 * 视图筛选（今天 / 即将到期 / 优先级 / 分组 / 搜索）会把不满足条件的子任务过滤掉，
 * 导致父任务虽然显示"有子任务"的箭头，点开却什么都没有。这里对被标记为展开的任务
 * 单独拉取子任务并合并进列表（递归处理多层嵌套）。
 */
async function withExpandedChildren(tasks) {
  if (!state.expandedTasks.size) return tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const queue = [...state.expandedTasks].filter((id) => byId.has(id));
  const seen = new Set(queue);

  while (queue.length) {
    const parentId = queue.shift();
    const kids = await api.tasks.subtasks(parentId).catch((e) => {
      console.warn('[ui] 拉取子任务失败', e && e.message);
      return [];
    });
    for (const k of kids) {
      if (!byId.has(k.id)) {
        byId.set(k.id, k);
        tasks.push(k);
      }
      // 该子任务自身也处于展开状态 → 继续向下补
      if (state.expandedTasks.has(k.id) && !seen.has(k.id)) {
        seen.add(k.id);
        queue.push(k.id);
      }
    }
  }
  return tasks;
}

/** 任务排序：与主列表 SQL 一致（未完成 → 有截止日期 → 截止日期 → 优先级降序 → 手动排序 → id） */
function compareTasks(a, b) {
  // 手动排序：sort_order 优先，与 main/db.js 里 f.sort === 'manual' 的 ORDER BY 保持一致
  if (state.sortMode === 'manual') {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.id - b.id;
  }
  if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
  const aNull = a.plan_end == null;
  const bNull = b.plan_end == null;
  if (aNull !== bNull) return aNull ? 1 : -1; // 无截止日期的排后面
  if (!aNull && a.plan_end !== b.plan_end) return a.plan_end < b.plan_end ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority; // 优先级高的在前
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.id - b.id;
}

/** 将任务数组组织为树并按“父任务→子任务（缩进）”展平 */
function flattenTree(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map();
  const roots = [];
  for (const t of tasks) {
    if (t.parent_id && byId.has(t.parent_id)) {
      if (!children.has(t.parent_id)) children.set(t.parent_id, []);
      children.get(t.parent_id).push(t);
    } else {
      roots.push(t);
    }
  }
  const result = [];
  const walk = (t, depth) => {
    result.push({ task: t, depth });
    // 默认收缩：仅在展开时递归渲染子任务
    if (!state.expandedTasks.has(t.id)) return;
    const kids = (children.get(t.id) || []).sort(compareTasks);
    for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return result;
}

function buildTaskList(nodes) {
  const items = nodes
    .map(({ task: t, depth }) => (state.editingTaskId === t.id ? editEditorHtml(t) : taskItemHtml(t, depth)))
    .join('');
  return `<ul class="task-list">${items}</ul>`;
}

function taskItemHtml(t, depth = 0) {
  const done = t.completed ? ' done' : '';
  const isSub = depth > 0;
  const isOverdue = !t.completed && t.plan_end && t.plan_end < todayStr();
  const meta = [];
  if (isSub && t.parent_title) meta.push(`<span class="meta-item parent-tag">↳ ${esc(t.parent_title)}</span>`);
  meta.push(`<span class="pri-badge pri-${t.priority}">${PRIORITY_TEXT[t.priority]}</span>`);
  if (t.plan_start) meta.push(`<span class="meta-item">🗓 ${esc(t.plan_start)}</span>`);
  if (t.plan_end) meta.push(`<span class="meta-item due ${isOverdue ? 'overdue' : ''}">📅 ${esc(t.plan_end)}</span>`);
  if (t.subtask_count > 0) meta.push(`<span class="meta-item subtask-progress">☑ ${t.subtask_done}/${t.subtask_count}</span>`);
  if (t.completed && t.completed_at) meta.push(`<span class="meta-item done-at">✅ 完成于 ${fmtDateTime(t.completed_at)}</span>`);
  if (t.reminder_at) meta.push(`<span class="meta-item">🔔 ${fmtDateTime(t.reminder_at)}</span>`);
  for (const n of t.tag_names) meta.push(`<span class="tag-chip">${esc(n)}</span>`);
  const groupLabel = t.group_name ? `<span class="meta-item" style="color:${esc(t.group_color)}">● ${esc(t.group_name)}</span>` : '';

  return `
  <li class="task-item${done}${isSub ? ' is-subtask' : ''}" draggable="false" data-id="${t.id}" style="margin-left:${depth * 20}px">
    ${isSub ? '' : '<span class="drag-handle" data-act="drag" title="按住拖拽调整顺序">⠿</span>'}
    <button class="task-check" data-act="toggle" title="完成/取消">${t.completed ? '✓' : ''}</button>
    <div class="task-body">
      <div class="task-title">
        ${t.subtask_count > 0 ? `<button class="task-expand" data-act="toggle-expand" aria-expanded="${state.expandedTasks.has(t.id)}" title="${state.expandedTasks.has(t.id) ? '收起子任务' : '展开子任务'}">${state.expandedTasks.has(t.id) ? '▾' : '▸'}</button>` : ''}
        <span class="task-title-text">${esc(t.title)}</span>
      </div>
      <div class="task-meta">${groupLabel}${meta.join('')}</div>
    </div>
    <div class="task-actions">
      <button data-act="edit" title="编辑">✎ 编辑</button>
      ${state.view === 'archived'
        ? `<button data-act="unarchive" title="恢复">↩ 恢复</button>`
        : `<button data-act="archive" title="归档">🗂 归档</button>`}
      <button class="del" data-act="del" title="删除">🗑 删除</button>
    </div>
  </li>`;
}

function bindTaskListEvents(container) {
  container.querySelectorAll('.task-item:not(.editing)').forEach((item) => {
    item.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const id = Number(item.dataset.id);
      if (!btn) { openDetail(id); return; }
      const act = btn.dataset.act;
      if (act === 'drag') return; // 拖拽手柄：不触发打开详情
      if (act === 'toggle') toggleTask(id);
      else if (act === 'toggle-expand') {
        if (state.expandedTasks.has(id)) state.expandedTasks.delete(id);
        else state.expandedTasks.add(id);
        renderTasks();
      }
      else if (act === 'edit') startEdit(id);
      else if (act === 'del') deleteTaskConfirm(id);
      else if (act === 'archive') archiveTask(id);
      else if (act === 'unarchive') unarchiveTask(id);
    });
    bindDrag(item);
  });

  // 底部“添加任务”入口
  const addBtn = container.querySelector('[data-act="start-add"]');
  if (addBtn) addBtn.addEventListener('click', startAdd);
}

/* ---------------- 就地新增 / 编辑编辑器 ---------------- */

function groupOptionsHtml(selectedId) {
  const opts = ['<option value="">无分组</option>'];
  for (const g of state.groups) {
    opts.push(`<option value="${g.id}"${selectedId === g.id ? ' selected' : ''}>${esc(g.name)}</option>`);
  }
  return opts.join('');
}

function priorityOptionsHtml(selected) {
  const sel = selected == null ? 1 : selected;
  return [0, 1, 2, 3]
    .map((p) => `<option value="${p}"${p === sel ? ' selected' : ''}>${PRIORITY_TEXT[p]}</option>`)
    .join('');
}

/** 编辑器内部结构（新增与编辑共用）。计划开始/完成日期直接放在主行表单中 */
function taskEditorHtml(task) {
  const isEdit = !!task;
  const t = task || {};
  const detailsHidden = isEdit ? '' : ' hidden';
  const showCompletedAt = isEdit && t.completed;
  const defaultGroup = isEdit ? t.group_id : (state.currentGroup !== 'all' ? state.currentGroup : null);
  // 计划日期：开始 / 完成合并为单一范围控件，新建任务的默认值由 NEW_TASK_RANGE_MODE 决定
  const rangeOpts = { required: PLAN_DATE_REQUIRED, placeholder: '计划开始 ~ 完成' };
  const range = isEdit ? { start: t.plan_start, end: t.plan_end } : defaultDateRange(NEW_TASK_RANGE_MODE);
  return `
  <div class="task-editor" data-editor="${isEdit ? t.id : 'new'}">
    <div class="editor-row">
      <input class="editor-title" type="text" placeholder="任务标题（回车保存，Esc 取消）" value="${esc(t.title || '')}" />
      ${dateRangeFieldHtml(range.start, range.end, rangeOpts)}
      <button class="ghost-btn" data-act="editor-more" title="展开更多字段（分组 / 优先级 / 提醒 / 标签 / 备注）">⚙ 更多选项</button>
      ${isEdit ? '<button class="danger-btn" data-act="editor-delete" title="删除任务">删除</button>' : ''}
      <button class="ghost-btn" data-act="editor-cancel">取消</button>
      <button class="primary-btn" data-act="editor-save">${isEdit ? '保存' : '添加'}</button>
      ${isEdit ? '<span class="editor-save-state" hidden title="修改会自动保存"></span>' : ''}
    </div>
    <div class="editor-details"${detailsHidden}>
      <select class="editor-group" title="分组">${groupOptionsHtml(defaultGroup)}</select>
      <select class="editor-priority" title="优先级">${priorityOptionsHtml(t.priority)}</select>
      ${reminderHtml(t.reminder_at, t.plan_end)}
      <input class="editor-tags" type="text" placeholder="标签（逗号分隔）" value="${esc((t.tag_names || []).join(', '))}" />
      ${showCompletedAt ? `<input class="editor-completed-at" type="datetime-local" value="${isoToLocal(t.completed_at)}" title="实际完成时间" />` : ''}
      <textarea class="editor-notes" rows="2" placeholder="备注">${esc(t.notes || '')}</textarea>
    </div>
  </div>`;
}

/** 编辑已有任务：替换任务行 */
function editEditorHtml(t) {
  return `<li class="task-item editing" data-id="${t.id}">${taskEditorHtml(t)}</li>`;
}

/** 新增任务：列表底部编辑器 */
function newEditorHtml() {
  return `<div class="task-editor-wrap">${taskEditorHtml(null)}</div>`;
}

function addRowHtml() {
  return `<div class="add-row"><button class="add-row-btn" data-act="start-add"><span class="add-plus">＋</span> 添加任务</button></div>`;
}

function bindEditorEvents(container) {
  container.querySelectorAll('.task-editor').forEach((ed) => {
    bindDateRangeFields(ed);
    bindReminder(ed);
    // 范围变化（含清除）后同步提醒预设，避免出现“依赖完成日期却没有日期”的提醒
    ed.addEventListener(DATE_RANGE_EVENT, (e) => syncReminderWithPlanEnd(ed, e.detail.planEnd));
    // 编辑既有任务 → 开启即时持久化（新建任务在“添加”时创建，无 id 可写）
    if (ed.dataset.editor !== 'new') ed.__autoSave = bindEditorAutoSave(ed);
    const title = ed.querySelector('.editor-title');
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveEditor(ed); }
      else if (e.key === 'Escape') cancelEditor();
    });
    ed.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancelEditor();
    });
    ed.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'editor-save') saveEditor(ed);
      else if (act === 'editor-cancel') cancelEditor();
      else if (act === 'editor-delete') deleteEditingTask(ed);
      else if (act === 'editor-more') {
        const d = ed.querySelector('.editor-details');
        d.hidden = !d.hidden;
      }
    });
  });
}

function startAdd() {
  state.addingTask = true;
  state.editingTaskId = null;
  renderTasks();
}

function startEdit(id) {
  state.editingTaskId = id;
  state.addingTask = false;
  renderTasks();
}

function cancelEditor() {
  // 取消只丢弃"尚未写入"的改动；已经自动保存的内容按即时持久化的语义保留
  const ed = document.querySelector('.task-editor');
  if (ed && ed.__autoSave) ed.__autoSave.cancel();
  state.addingTask = false;
  state.editingTaskId = null;
  renderTasks();
}

function focusEditor() {
  requestAnimationFrame(() => {
    const el = document.querySelector('.task-editor .editor-title');
    if (el) {
      el.focus();
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
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

/**
 * 从编辑器 DOM 收集待保存的字段。返回 null 表示当前值不合法（标题为空 / 日期未通过校验）。
 * 供「保存按钮」与「自动保存」共用，保证两条路径写入的数据完全一致。
 */
function collectEditorPayload(ed, { quiet = false } = {}) {
  const title = ed.querySelector('.editor-title').value.trim();
  if (!title) {
    if (!quiet) {
      toast('请输入任务标题');
      ed.querySelector('.editor-title').focus();
    }
    return null;
  }
  const range = validateDateRange(ed);
  if (!range.ok) {
    if (!quiet) {
      toast(range.message); // validateDateRange 已给控件加上 .invalid 态
      ed.querySelector('.date-range-trigger').focus();
    }
    return null;
  }
  const { planStart, planEnd } = range;
  if (reminderNeedsPlanEnd(ed) && !planEnd) {
    if (!quiet) toast('请先设置完成日期，再选择提醒时间');
    return null;
  }
  const payload = {
    title,
    notes: ed.querySelector('.editor-notes').value,
    priority: Number(ed.querySelector('.editor-priority').value),
    groupId: ed.querySelector('.editor-group').value ? Number(ed.querySelector('.editor-group').value) : null,
    planStart,
    planEnd,
    reminderAt: computeReminder(ed, planEnd),
  };
  // 实际完成时间（仅编辑已完成任务时显示该字段）
  const catEl = ed.querySelector('.editor-completed-at');
  if (catEl) payload.completedAt = localToIso(catEl.value);
  return payload;
}

/** 编辑器内的保存状态提示（已保存 / 保存中… / 保存失败） */
function setEditorSaveState(ed, status, message) {
  const el = ed.querySelector('.editor-save-state');
  if (!el) return;
  el.hidden = status === 'idle';
  el.textContent = message || SAVE_STATE_TEXT[status] || '';
  el.className = `editor-save-state s-${status}`;
  el.title = status === 'error' ? (message || '保存失败，点击重试') : '';
}

/** 编辑已有任务时的即时持久化：输入停止 AUTO_SAVE_DELAY 毫秒后自动写库 */
function bindEditorAutoSave(ed) {
  const id = Number(ed.dataset.editor);
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return null;

  const read = () => {
    const p = collectEditorPayload(ed, { quiet: true });
    if (!p) return null;
    return { ...p, tagIds: (task.tag_ids || []).map(Number) };
  };

  const saver = createAutoSave({
    delay: AUTO_SAVE_DELAY,
    read,
    save: async (payload) => {
      const tagIds = await resolveTagIds(ed.querySelector('.editor-tags').value);
      return api.tasks.update(id, { ...payload, tagIds });
    },
    onStatus: (status, info) => {
      setEditorSaveState(ed, status, status === 'error' ? (info === 'conflict' ? '任务已不存在' : '保存失败，点击重试') : '');
    },
    onError: (e) => {
      toast(`自动保存失败：${(e && e.message) || '未知错误'}`);
      // 保留用户输入，点击状态标签即可重试
    },
    onConflict: () => {
      toast('该任务已被删除，未保存的修改已放弃');
      state.editingTaskId = null;
      refreshAll().then(() => { renderSidebarList(); renderTasks(); });
    },
    onSaved: (updated) => {
      // 只更新内存状态，不重绘列表（重绘会销毁编辑器、打断输入）
      const i = state.tasks.findIndex((t) => t.id === id);
      if (i > -1 && updated) state.tasks[i] = { ...state.tasks[i], ...updated };
      renderSidebarList();
    },
  });

  // 基线 = 打开编辑器时的服务端数据，避免"没改也写库"
  saver.setBaseline({
    title: task.title,
    notes: task.notes || '',
    priority: task.priority,
    groupId: task.group_id ?? null,
    planStart: task.plan_start,
    planEnd: task.plan_end,
    reminderAt: task.reminder_at,
    tagIds: (task.tag_ids || []).map(Number),
  });

  ed.addEventListener('input', () => saver.schedule());
  ed.addEventListener('change', () => saver.schedule());
  // 日期范围控件是自定义事件，单独监听
  ed.addEventListener(DATE_RANGE_EVENT, () => saver.schedule());
  // 点击状态标签 → 立即重试
  const stateEl = ed.querySelector('.editor-save-state');
  if (stateEl) stateEl.addEventListener('click', () => saver.flush());

  return saver;
}

async function saveEditor(ed) {
  const isEdit = ed.dataset.editor !== 'new';
  const payload = collectEditorPayload(ed);
  if (!payload) return;

  // 已进入自动保存的编辑器：立即 flush 并关闭；否则（新建）走创建流程
  const saver = ed.__autoSave;
  if (isEdit && saver) {
    await saver.flush();
    const ok = ed.querySelector('.editor-save-state').className.indexOf('s-error') === -1;
    if (!ok) return; // 保存失败时保持编辑器打开
    state.editingTaskId = null;
    await refreshAll();
    renderSidebarList();
    renderTasks();
    return;
  }

  const ok = await guardAction(async () => {
    const tagIds = await resolveTagIds(ed.querySelector('.editor-tags').value);
    if (isEdit) {
      await api.tasks.update(Number(ed.dataset.editor), { ...payload, tagIds });
    } else {
      await api.tasks.create({ ...payload, tagIds });
    }
  }, isEdit ? '更新任务失败' : '创建任务失败');
  if (!ok) return; // 失败时保留编辑器内容，用户可直接重试
  toast(isEdit ? '任务已更新' : '任务已创建');

  state.addingTask = false;
  state.editingTaskId = null;
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

async function deleteEditingTask(ed) {
  const id = Number(ed.dataset.editor);
  if (!confirm('确定删除该任务吗？此操作不可恢复。')) return;
  const ok = await guardAction(() => api.tasks.remove(id), '删除任务失败');
  if (!ok) return;
  state.editingTaskId = null;
  toast('任务已删除');
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

/* ---------------- 拖拽排序 ---------------- */

/**
 * 切换排序方式（同步部分）：同步 state 与工具栏下拉框，不触发重绘。
 */
function setSortMode(mode) {
  state.sortMode = mode;
  const sel = document.getElementById('sort-select');
  if (sel) sel.value = mode;
}

/**
 * 绑定一行的拖拽排序。
 *
 * 原先整行 draggable="true"，问题有两个：
 *  1) 行内的输入框 / 按钮会抢走 mousedown，多数时候根本拖不起来；
 *  2) 列表顺序由 SQL 的「完成状态 → 截止日期 → 优先级 → sort_order」决定，
 *     sort_order 只是很靠后的兜底键，拖拽写进去后列表又按别的键排回去，看起来"没反应"。
 * 现在：只有按住左侧手柄才允许拖拽；拖完自动切到「手动」排序，让 sort_order 真正生效。
 */
function bindDrag(item) {
  const handle = item.querySelector('.drag-handle');
  if (!handle) return; // 子任务行不参与主列表排序

  const enable = () => { item.draggable = true; };
  const disable = () => { item.draggable = false; };
  handle.addEventListener('pointerdown', enable);
  handle.addEventListener('pointerup', disable);

  item.addEventListener('dragstart', (e) => {
    if (!item.draggable) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(item.dataset.id));
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    disable();
    item.classList.remove('dragging');
    document.querySelectorAll('.task-item.drag-over').forEach((x) => x.classList.remove('drag-over'));
  });
  item.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    item.classList.remove('drag-over');
    await dropReorder(item, e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
  });
}

/** 把 fromId 移动到当前行所在的位置，并按新的顺序写回 sort_order */
async function dropReorder(item, fromIdStr) {
  const fromId = Number(fromIdStr);
  const listEl = item.parentElement;
  if (!listEl) return;
  // 只取同一列表里的顶层任务：展开出来的子任务缩进显示，不参与主列表排序
  const rows = Array.from(listEl.querySelectorAll(':scope > .task-item:not(.is-subtask)'));
  const ids = rows.map((c) => Number(c.dataset.id));
  const fromIdx = ids.indexOf(fromId);
  const toIdx = ids.indexOf(Number(item.dataset.id));
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;

  ids.splice(toIdx, 0, ...ids.splice(fromIdx, 1));
  const ok = await guardAction(() => api.tasks.reorder(ids), '排序失败');
  if (!ok) return;
  // 手动排序下顺序才由 sort_order 决定：拖拽时自动切过去，避免"拖完又弹回原样"
  if (state.sortMode !== 'manual') {
    setSortMode('manual');
    toast('已切换为手动排序，可直接拖拽调整顺序');
  }
  await loadTasks();
  renderTasks();
}

/* ---------------- 任务操作 ---------------- */

async function toggleTask(id) {
  await api.tasks.toggle(id);
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

async function archiveTask(id) {
  await api.tasks.archive(id);
  await refreshAll();
  renderSidebarList();
  renderTasks();
  toast('任务已归档');
}

async function archiveCompleted() {
  const n = await api.tasks.archiveCompleted(state.currentGroup === 'all' ? null : state.currentGroup);
  toast(`已归档 ${n} 个已完成任务`);
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

async function unarchiveTask(id) {
  await api.tasks.unarchive(id);
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

async function deleteTaskConfirm(id) {
  if (!confirm('确定删除该任务吗？此操作不可恢复。')) return;
  await api.tasks.remove(id);
  toast('任务已删除');
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

/* ---------------- 数据导入 / 导出 ---------------- */

async function exportData() {
  const r = await api.data.export();
  if (r.ok) toast(`已导出 ${r.counts.tasks} 个任务、${r.counts.groups} 个分组`);
  else if (!r.canceled) toast('导出失败');
}

async function importData() {
  if (!confirm('导入将覆盖当前所有任务、分组和标签数据，是否继续？')) return;
  const r = await api.data.import();
  if (r.ok) {
    toast(`已导入 ${r.counts.tasks} 个任务、${r.counts.groups} 个分组、${r.counts.tags} 个标签`);
    state.currentGroup = 'all';
    state.currentTag = null;
    await refreshAll();
    renderSidebarList();
    renderTasks();
  } else if (!r.canceled) {
    toast(r.message || '导入失败');
  }
}

/* ---------------- 分组 / 标签编辑 ---------------- */

const GROUP_COLORS = [
  { value: 'auto', label: '自动', color: '#4f7cff' },
  { value: '#4f7cff', label: '蓝', color: '#4f7cff' },
  { value: '#23b07e', label: '绿', color: '#23b07e' },
  { value: '#f59e0b', label: '橙', color: '#f59e0b' },
  { value: '#e5484d', label: '红', color: '#e5484d' },
  { value: '#8b5cf6', label: '紫', color: '#8b5cf6' },
  { value: '#06b6d4', label: '青', color: '#06b6d4' },
];

/**
 * 新增分组：就地弹窗 → 校验 → 创建 → 立即插入列表并选中。
 * 任何失败（重名 / 数据库只读 / IPC 异常）都会在弹窗内展示具体原因，不再静默。
 */
async function promptAddGroup() {
  await openPromptModal({
    title: '新增分组',
    label: '分组名称',
    placeholder: '例如：工作 / 学习 / 健身',
    choices: GROUP_COLORS,
    choicesLabel: '颜色',
    okText: '创建',
    onSubmit: async (raw, color) => {
      const name = raw.trim();
      if (!name) return '请输入分组名称';
      if (state.groups.some((g) => g.name === name)) return `分组「${name}」已存在，请换一个名称`;
      const group = await api.groups.create({ name, color: color === 'auto' ? pickColor() : color });
      await afterGroupCreated(group);
      return undefined;
    },
  });
}

async function afterGroupCreated(group) {
  // 用接口返回的数据补一条计数，列表立刻可见，不必等整表刷新
  state.groups = [...state.groups, { active_count: 0, ...group }];
  renderSidebarList();
  highlightSidebarItem('group', group.id);
  toast(`已创建分组「${group.name}」`);
}

/** 新增/修改后给对应条目一个短暂高亮，用户能立刻看到"确实加进去了" */
function highlightSidebarItem(kind, id) {
  const sel = kind === 'group' ? '.group-item' : '.tag-item';
  const items = [...document.querySelectorAll(`${sel}`)];
  const target = items.find((el) => Number(el.dataset.id) === id);
  if (!target) return;
  target.classList.add('just-added');
  setTimeout(() => target.classList.remove('just-added'), 1200);
}

async function promptAddTag() {
  await openPromptModal({
    title: '新增标签',
    label: '标签名称',
    placeholder: '例如：项目A / 紧急',
    okText: '创建',
    onSubmit: async (raw) => {
      const name = raw.trim();
      if (!name) return '请输入标签名称';
      if (state.tags.some((t) => t.name === name)) return `标签「${name}」已存在，请换一个名称`;
      const created = await api.tags.create(name);
      if (!created || !created.id) return '创建失败：接口未返回标签数据';
      state.tags = [...state.tags, { task_count: 0, ...created }];
      renderSidebarList();
      highlightSidebarItem('tag', created.id);
      toast(`已创建标签「${created.name}」`);
      return undefined;
    },
  });
}

async function editGroup(g) {
  await openPromptModal({
    title: '编辑分组',
    label: '分组名称',
    value: g.name,
    okText: '保存',
    onSubmit: async (raw) => {
      const name = raw.trim() || g.name;
      const dup = state.groups.find((x) => x.name === name && x.id !== g.id);
      if (dup) return `分组「${name}」已存在，请换一个名称`;
      await api.groups.update(g.id, { name, color: g.color });
      state.groups = state.groups.map((x) => (x.id === g.id ? { ...x, name } : x));
      renderSidebarList();
      renderTasks();
      toast('分组已更新');
      return undefined;
    },
  });
}

async function deleteGroup(g) {
  if (!confirm(`删除分组「${g.name}」？组内任务将变为“未分组”。`)) return;
  guardAction(async () => {
    await api.groups.remove(g.id);
    if (state.currentGroup === g.id) state.currentGroup = 'all';
    await refreshAll();
    renderSidebarList();
    renderTasks();
  }, '删除分组失败');
}

async function deleteTag(t) {
  if (!confirm(`删除标签「${t.name}」？`)) return;
  guardAction(async () => {
    await api.tags.remove(t.id);
    if (state.currentTag === t.id) state.currentTag = null;
    await refreshAll();
    renderSidebarList();
    renderTasks();
  }, '删除标签失败');
}

/* ---------------- 统计 ---------------- */

async function renderStats() {
  const viewEl = document.getElementById('view');
  viewEl.innerHTML = '<div class="empty">加载中…</div>';
  const [ov, trend] = await Promise.all([api.stats.overview(), api.stats.trend(7)]);

  const maxGroup = Math.max(1, ...ov.byGroup.map((g) => g.active + g.done));
  const groupBars = ov.byGroup
    .map((g) => {
      const total = g.active + g.done;
      const pct = Math.round((total / maxGroup) * 100);
      return `<div class="bar-row">
        <span class="bar-label">${esc(g.name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${esc(g.color)}"></div></div>
        <span class="bar-val">${total}</span>
      </div>`;
    })
    .join('');

  const maxTrend = Math.max(1, ...trend.map((d) => d.count));
  const trendCols = trend
    .map((d) => {
      const h = Math.max(3, Math.round((d.count / maxTrend) * 100));
      return `<div class="trend-col">
        <span class="trend-count">${d.count}</span>
        <div class="trend-bar" style="height:${h}px"></div>
        <span class="trend-date">${d.date.slice(5)}</span>
      </div>`;
    })
    .join('');

  const priOrder = [3, 2, 1, 0];
  const priCount = { 0: 0, 1: 0, 2: 0, 3: 0 };
  ov.byPriority.forEach((p) => { priCount[p.priority] = p.count; });
  const priBars = priOrder
    .map((p) => {
      const c = priCount[p];
      const pct = ov.active > 0 ? Math.round((c / ov.active) * 100) : 0;
      return `<div class="bar-row">
        <span class="bar-label">${PRIORITY_TEXT[p]}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="bar-val">${c}</span>
      </div>`;
    })
    .join('');

  viewEl.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="num">${ov.total}</div><div class="label">总任务</div></div>
      <div class="stat-card primary"><div class="num">${ov.active}</div><div class="label">进行中</div></div>
      <div class="stat-card green"><div class="num">${ov.completed}</div><div class="label">已完成</div></div>
      <div class="stat-card danger"><div class="num">${ov.overdue}</div><div class="label">已逾期</div></div>
      <div class="stat-card"><div class="num">${ov.rate}%</div><div class="label">完成率</div></div>
      <div class="stat-card"><div class="num">${ov.archived}</div><div class="label">已归档</div></div>
    </div>
    <div class="panel"><h3>近 7 天完成趋势</h3><div class="trend-chart">${trendCols}</div></div>
    <div class="panel"><h3>分组任务量</h3>${groupBars || '<span class="meta-item">暂无分组</span>'}</div>
    <div class="panel"><h3>优先级分布（进行中）</h3>${priBars}</div>`;
}

/* ---------------- 主题 ---------------- */

async function initTheme() {
  state.theme = await api.theme.get();
  applyTheme();
}

function applyTheme() {
  let effective = state.theme;
  if (effective === 'system') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', effective);
}

async function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  state.theme = current === 'dark' ? 'light' : 'dark';
  await api.theme.set(state.theme);
  applyTheme();
  toast(state.theme === 'dark' ? '已切换深色模式' : '已切换浅色模式');
}

/* ---------------- 工具 ---------------- */

function pickColor() {
  const colors = ['#4f7cff', '#23b07e', '#f59e0b', '#e5484d', '#8b5cf6', '#06b6d4', '#ec4899'];
  return colors[Math.floor(Math.random() * colors.length)];
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/**
 * 统一错误捕获：异步操作失败时把原因提示给用户，避免"点了没反应"。
 * 失败文案统一带上兜底前缀，便于区分是校验失败还是接口失败。
 */
async function guardAction(fn, prefix = '操作失败') {
  try {
    await fn();
    return true;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error(`[${prefix}]`, e);
    toast(`${prefix}：${msg}`);
    return false;
  }
}

export { render, renderSidebar, renderTasks, toast };
