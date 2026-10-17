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
import {
  dateRangeFieldHtml, bindDateRangeFields, getDateRange,
  reminderHtml, bindReminder, computeReminder, reminderNeedsPlanEnd,
} from './controls.js';

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

  // 分组
  const groups = await loadGroups();
  const groupList = document.getElementById('group-list');
  groupList.innerHTML = '';

  const allItem = document.createElement('li');
  allItem.className = 'group-item' + (state.currentGroup === 'all' ? ' active' : '');
  allItem.innerHTML = `<span class="group-dot" style="background:#c3cad6"></span>
    <span class="group-name">全部</span>`;
  allItem.addEventListener('click', () => {
    state.currentGroup = 'all';
    renderSidebar();
    renderTasks();
  });
  groupList.appendChild(allItem);

  for (const g of groups) {
    const li = document.createElement('li');
    li.className = 'group-item' + (state.currentGroup === g.id ? ' active' : '');
    li.innerHTML = `
      <span class="group-dot" style="background:${esc(g.color)}"></span>
      <span class="group-name">${esc(g.name)}</span>
      <span class="group-count">${g.active_count}</span>
      <span class="group-actions">
        <button class="g-edit" title="编辑">✎</button>
        <button class="g-del" title="删除">×</button>
      </span>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.g-edit')) return editGroup(g);
      if (e.target.closest('.g-del')) return deleteGroup(g);
      state.currentGroup = g.id;
      renderSidebar();
      renderTasks();
    });
    li.querySelector('.g-edit').addEventListener('click', () => editGroup(g));
    li.querySelector('.g-del').addEventListener('click', () => deleteGroup(g));
    groupList.appendChild(li);
  }

  // 标签
  const tags = await loadTags();
  const tagList = document.getElementById('tag-list');
  tagList.innerHTML = '';
  for (const t of tags) {
    const li = document.createElement('li');
    li.className = 'tag-item' + (state.currentTag === t.id ? ' active' : '');
    li.innerHTML = `
      <span class="tag-color" style="background:${esc(t.color)}"></span>
      <span>${esc(t.name)}</span>
      <button class="tag-del" title="删除">×</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.tag-del')) return;
      state.currentTag = state.currentTag === t.id ? null : t.id;
      renderSidebar();
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
    const grouped = groupBy(tasks, (t) => t.group_id || null);
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
    const kids = (children.get(t.id) || []).sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
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
  <li class="task-item${done}${isSub ? ' is-subtask' : ''}" draggable="${isSub ? 'false' : 'true'}" data-id="${t.id}" style="margin-left:${depth * 20}px">
    <button class="task-check" data-act="toggle" title="完成/取消">${t.completed ? '✓' : ''}</button>
    <div class="task-body">
      <div class="task-title">
        ${t.subtask_count > 0 ? `<button class="task-expand" data-act="toggle-expand" title="展开/收起子任务">${state.expandedTasks.has(t.id) ? '▾' : '▸'}</button>` : ''}
        <span class="task-title-text">${esc(t.title)}</span>
      </div>
      <div class="task-meta">${groupLabel}${meta.join('')}</div>
    </div>
    <div class="task-actions">
      <button data-act="edit" title="编辑">✎</button>
      ${state.view === 'archived'
        ? `<button data-act="unarchive" title="恢复">↩</button>`
        : `<button data-act="archive" title="归档">🗂</button>`}
      <button class="del" data-act="del" title="删除">🗑</button>
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
  return `
  <div class="task-editor" data-editor="${isEdit ? t.id : 'new'}">
    <div class="editor-row">
      <input class="editor-title" type="text" placeholder="任务标题（回车保存，Esc 取消）" value="${esc(t.title || '')}" />
      ${dateRangeFieldHtml(t.plan_start, t.plan_end)}
      <button class="ghost-btn" data-act="editor-more" title="更多选项">⚙</button>
      ${isEdit ? '<button class="danger-btn" data-act="editor-delete" title="删除任务">删除</button>' : ''}
      <button class="ghost-btn" data-act="editor-cancel">取消</button>
      <button class="primary-btn" data-act="editor-save">${isEdit ? '保存' : '添加'}</button>
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

async function saveEditor(ed) {
  const title = ed.querySelector('.editor-title').value.trim();
  if (!title) {
    toast('请输入任务标题');
    ed.querySelector('.editor-title').focus();
    return;
  }
  const isEdit = ed.dataset.editor !== 'new';
  const { planStart, planEnd } = getDateRange(ed);
  if (reminderNeedsPlanEnd(ed) && !planEnd) {
    toast('请先设置完成日期，再选择提醒时间');
    return;
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

  const tagIds = await resolveTagIds(ed.querySelector('.editor-tags').value);

  if (isEdit) {
    await api.tasks.update(Number(ed.dataset.editor), { ...payload, tagIds });
    toast('任务已更新');
  } else {
    await api.tasks.create({ ...payload, tagIds });
    toast('任务已创建');
  }

  state.addingTask = false;
  state.editingTaskId = null;
  await refreshAll();
  renderSidebar();
  renderTasks();
}

async function deleteEditingTask(ed) {
  const id = Number(ed.dataset.editor);
  if (!confirm('确定删除该任务吗？此操作不可恢复。')) return;
  await api.tasks.remove(id);
  state.editingTaskId = null;
  toast('任务已删除');
  await refreshAll();
  renderSidebar();
  renderTasks();
}

/* ---------------- 拖拽排序 ---------------- */

function bindDrag(item) {
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.dataset.id);
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    document.querySelectorAll('.task-item.drag-over').forEach((x) => x.classList.remove('drag-over'));
  });
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    const fromId = Number(e.dataTransfer.getData('text/plain'));
    const listEl = item.parentElement;
    const children = Array.from(listEl.children);
    const targetId = Number(item.dataset.id);
    const ids = children.map((c) => Number(c.dataset.id));
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx > -1 && toIdx > -1 && fromIdx !== toIdx) {
      ids.splice(toIdx, 0, ...ids.splice(fromIdx, 1));
      await api.tasks.reorder(ids);
      await loadTasks();
      renderTasks();
    }
  });
}

/* ---------------- 任务操作 ---------------- */

async function toggleTask(id) {
  await api.tasks.toggle(id);
  await refreshAll();
  renderSidebar();
  renderTasks();
}

async function archiveTask(id) {
  await api.tasks.archive(id);
  await refreshAll();
  renderSidebar();
  renderTasks();
  toast('任务已归档');
}

async function archiveCompleted() {
  const n = await api.tasks.archiveCompleted(state.currentGroup === 'all' ? null : state.currentGroup);
  toast(`已归档 ${n} 个已完成任务`);
  await refreshAll();
  renderSidebar();
  renderTasks();
}

async function unarchiveTask(id) {
  await api.tasks.unarchive(id);
  await refreshAll();
  renderSidebar();
  renderTasks();
}

async function deleteTaskConfirm(id) {
  if (!confirm('确定删除该任务吗？此操作不可恢复。')) return;
  await api.tasks.remove(id);
  toast('任务已删除');
  await refreshAll();
  renderSidebar();
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
    renderSidebar();
    renderTasks();
  } else if (!r.canceled) {
    toast(r.message || '导入失败');
  }
}

/* ---------------- 分组 / 标签编辑 ---------------- */

async function promptAddGroup() {
  const name = prompt('请输入分组名称：');
  if (!name || !name.trim()) return;
  await api.groups.create({ name: name.trim(), color: pickColor() });
  await refreshAll();
  renderSidebar();
}

async function editGroup(g) {
  const name = prompt('修改分组名称：', g.name);
  if (name == null) return;
  await api.groups.update(g.id, { name: name.trim() || g.name, color: g.color });
  await refreshAll();
  renderSidebar();
}

async function deleteGroup(g) {
  if (!confirm(`删除分组「${g.name}」？组内任务将变为“未分组”。`)) return;
  await api.groups.remove(g.id);
  if (state.currentGroup === g.id) state.currentGroup = 'all';
  await refreshAll();
  renderSidebar();
  renderTasks();
}

async function promptAddTag() {
  const name = prompt('请输入标签名称：');
  if (!name || !name.trim()) return;
  await api.tags.create(name.trim());
  await refreshAll();
  renderSidebar();
}

async function deleteTag(t) {
  if (!confirm(`删除标签「${t.name}」？`)) return;
  await api.tags.remove(t.id);
  if (state.currentTag === t.id) state.currentTag = null;
  await refreshAll();
  renderSidebar();
  renderTasks();
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

export { render, renderSidebar, renderTasks, toast };
