'use strict';
/**
 * 视图渲染与交互（分组、任务、就地新增/编辑、拖拽排序、时间筛选、深色模式）。
 *
 * 新增/编辑任务采用“飞书式”就地交互：列表底部提供“添加任务”入口，点击后
 * 原地展开编辑器；“计划开始日期 / 计划完成日期”直接放在新增行主表单中填写。
 */
import { api, localToIso, isoToLocal, fmtDateTime, PRIORITY_TEXT, PRIORITY_COLOR } from './api.js';
import {
  state, loadGroups, loadTags, loadTasks, refreshAll, todayStr,
  noteCompletionChange, clearRecentlyDone, initRecentlyDone,
  taskGroupKey, initCollapsedTaskGroups, toggleTaskGroup,
} from './store.js';
import { renderReports } from './reports.js';
import { openDetail, setDetailHandlers } from './detail.js';
import { renderSearch, setSearchHandlers } from './search.js';
import { openPromptModal, openFormModal, openPanelModal } from './modal.js';
import { createAutoSave, SAVE_STATE_TEXT } from './autosave.js';
import { flattenGroupTree, childGroups, descendantGroupIds, groupPath, groupOptionsHtml } from './group-tree.js';
import { bindAiSettingsButton, setAiSettingsHandlers } from './ai-settings.js';
import { renderMeetings, setMeetingsHandlers, autoProcessMeeting } from './meetings.js';
import { bindRecordButton, setRecorderHandlers } from './recorder.js';
import { bindShortcutsButton } from './shortcuts.js';

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
  meetings: { title: '会议纪要', desc: '录制 / 导入会议音频 → 语音转写 → AI 纪要 → 待办入库' },
};

/** 会展示任务列表、因而消费分组/标签筛选的视图 */
const TASK_VIEWS = ['today', 'upcoming', 'all', 'completed', 'archived'];

/**
 * 时间筛选的三组日期范围。
 * 使用与「添加任务」完全相同的 flatpickr 范围控件（controls.js 的 dateRangeFieldHtml）：
 * 两次点选成范围、快捷按钮（今天/明天/本周末/清除）、中文日历、面板定位逻辑全部复用，
 * 视觉也沿用同一套 .date-range-* 样式 —— 不再用原生 input[type=date]（样式与交互都跟别处不一致）。
 */
const TF_RANGES = [
  { key: 'planStart', label: '计划开始日期', from: 'planStartFrom', to: 'planStartTo' },
  { key: 'planEnd', label: '计划完成日期', from: 'planEndFrom', to: 'planEndTo' },
  { key: 'completed', label: '实际完成时间', from: 'completedFrom', to: 'completedTo' },
];
/** 面板级监听只绑一次（面板内容会被重建，容器本身不换） */
let tfEventsBound = false;

/* ---------------- 初始化 ---------------- */

export async function init() {
  setDetailHandlers({ refresh: () => { renderSidebar(); renderTasks(); }, toast });
  setSearchHandlers({ openDetail, toast });
  // 会议录制 / 纪要：录制归档后自动跳到会议视图查看
  setMeetingsHandlers({ toast, refresh: () => { renderSidebar(); renderTasks(); } });
  setRecorderHandlers({
    toast,
    onMeetingSaved: async (m) => {
      state.view = 'meetings';
      renderSidebar();
      try {
        await render();
        if (m) await autoProcessMeeting(m);
      } catch (e) {
        console.error('[ui] 会议自动处理失败', e);
      }
    },
  });
  bindStaticEvents();
  await initTheme();
  // 恢复上次退出时的标签筛选（重启后仍保持选中态）
  state.currentTag = await api.ui.getTagFilter();
  // 恢复「今日已完成」：切走再回来、或重启应用，今天完成的那些任务仍然留在今天列表里
  await initRecentlyDone();
  // 恢复任务列表里被折叠的分组
  await initCollapsedTaskGroups();
  await renderSidebar();
  await render();
}

function bindStaticEvents() {
  // 导航
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      // 「今日已完成」是持久化的：切换视图不清除，回到「今天」时列表依然完整
      state.view = btn.dataset.view;
      state.currentGroup = 'all';
      state.editingTaskId = null;
      state.addingTask = false;
      renderSidebar();
      render();
    });
  });

  // 分组 / 标签新增
  document.getElementById('btn-add-group').addEventListener('click', () => promptAddGroup());
  document.getElementById('btn-add-tag').addEventListener('click', promptAddTag);
  // AI 配置（原在「AI 报告」页内的配置面板，提到工具栏统一管理）
  setAiSettingsHandlers({ toast, onChanged: () => { renderSidebarList(); } });
  bindAiSettingsButton();
  // 全局快捷键自定义（默认组合已避开 IDEA / Chrome 常用键位）
  bindShortcutsButton();
  // 会议录制（工具栏按钮）
  bindRecordButton();

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

  // 顶栏标签筛选指示：点击即清除筛选
  const tagChip = document.getElementById('tag-filter-chip');
  if (tagChip) tagChip.addEventListener('click', () => selectTag(null));

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

  // 时间筛选：切换面板 + 三组日期范围（与「添加任务」同一个 flatpickr 控件）
  document.getElementById('btn-time-filter').addEventListener('click', () => {
    const tf = document.getElementById('time-filter');
    tf.hidden = !tf.hidden;
  });
  buildTimeFilter();

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

/* ---------------- 时间筛选面板（复用 flatpickr 范围控件） ---------------- */

/** 顶栏「时间筛选」按钮随生效范围数量变化（0 个 → 普通态，≥1 → 高亮 + 计数） */
function updateTimeFilterBadge() {
  const btn = document.getElementById('btn-time-filter');
  if (!btn) return;
  const n = TF_RANGES.filter((r) => state.timeFilters[r.from] || state.timeFilters[r.to]).length;
  btn.classList.toggle('active', n > 0);
  btn.textContent = n ? `⏱ 时间筛选 · ${n}` : '⏱ 时间筛选';
  btn.title = n ? `已启用 ${n} 组时间范围，点击查看或修改` : '按计划开始 / 计划完成 / 实际完成时间筛选';
}

/**
 * 重建时间筛选面板（首次挂载 + 清除后重建）。
 * 重建而不是逐个清空实例：flatpickr 的日历容器挂在 body 上，
 * 换掉 DOM 后由 bindDateRangeFields → sweepDetachedRanges 统一销毁，不会留下孤儿日历。
 */
function buildTimeFilter() {
  const box = document.getElementById('time-filter');
  if (!box) return;
  const tf = state.timeFilters;

  box.innerHTML = TF_RANGES.map((r) => `
    <div class="tf-group" data-tf="${r.key}">
      <span class="tf-label">${r.label}</span>
      ${dateRangeFieldHtml(tf[r.from], tf[r.to], { placeholder: '不限' })}
    </div>`).join('')
    + '<button class="ghost-btn" id="tf-clear" title="清空全部时间范围">清除</button>';

  bindDateRangeFields(box);

  if (!tfEventsBound) {
    tfEventsBound = true;
    // 控件内部已把「开始 / 结束」归一成有序的一对值，这里直接落到筛选项
    box.addEventListener(DATE_RANGE_EVENT, (e) => {
      const cell = e.target.closest('[data-tf]');
      if (!cell) return;
      const def = TF_RANGES.find((r) => r.key === cell.dataset.tf);
      if (!def) return;
      state.timeFilters[def.from] = e.detail.planStart || '';
      state.timeFilters[def.to] = e.detail.planEnd || '';
      updateTimeFilterBadge();
      renderTasks();
    });
  }

  box.querySelector('#tf-clear').addEventListener('click', () => {
    TF_RANGES.forEach((r) => { state.timeFilters[r.from] = ''; state.timeFilters[r.to] = ''; });
    buildTimeFilter();
    updateTimeFilterBadge();
    renderTasks();
  });

  updateTimeFilterBadge();
}

/** 确保当前处于任务类视图（否则切到“全部任务”） */
function ensureTaskView() {
  if (TASK_VIEWS.includes(state.view)) return;
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
  renderTagFilterChip();
  if (state.view === 'stats') { await renderStats(); return; }
  if (state.view === 'reports') { await renderReports(); return; }
  if (state.view === 'search') { renderSearch(); return; }
  if (state.view === 'meetings') { await renderMeetings(); return; }
  await renderTasks();
}

async function renderSidebar() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  await loadGroups();
  await loadTags();
  // 标签可能已被删除：持久化下来的 id 失效时要静默清掉，避免筛选结果为空却看不出原因
  if (state.currentTag != null && !state.tags.some((t) => t.id === state.currentTag)) {
    state.currentTag = null;
    await api.ui.setTagFilter(null);
  }
  renderSidebarList();
  renderTagFilterChip();
}

/** 仅重绘分组 / 标签列表（使用 state 中已有数据，避免多余请求、避免重复拉取覆盖新增项） */
function groupEmptyHint(groups, groupList) {
  if (groups.length) return;
  const empty = document.createElement('li');
  empty.className = 'list-empty';
  empty.textContent = '暂无分组，点击 ＋ 新增';
  groupList.appendChild(empty);
}

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

  for (const { g, depth } of flattenGroupTree(state.groups, { expanded: state.expandedGroups })) {
    const children = childGroups(state.groups, g.id);
    const expanded = state.expandedGroups.has(g.id);
    const li = document.createElement('li');
    li.className = 'group-item'
      + (state.currentGroup === g.id ? ' active' : '')
      + (depth ? ' is-child' : '');
    li.dataset.id = g.id;
    li.dataset.parent = g.parent_id ?? '';
    li.dataset.depth = String(depth);
    li.style.paddingLeft = `${10 + depth * 14}px`;
    li.title = `${groupPath(g, state.groups)}（含子分组）`;
    li.innerHTML = `
      ${children.length
    ? `<button class="group-arrow" data-act="toggle-group" aria-expanded="${expanded}" title="${expanded ? '收起子分组' : '展开子分组'}">${expanded ? '▾' : '▸'}</button>`
    : '<span class="group-arrow space"></span>'}
      <span class="group-dot" style="background:${esc(g.color)}"></span>
      <span class="group-name">${esc(g.name)}</span>
      <span class="group-count" title="含子分组的任务数">${g.total_count ?? g.active_count ?? 0}</span>
      <span class="group-actions">
        <button class="g-add" title="新增子分组" data-act="add-sub">＋</button>
        <button class="g-edit" title="编辑" data-act="edit">✎</button>
        <button class="g-del" title="删除" data-act="del">×</button>
      </span>`;
    // 有子分组且未展开 → 折叠时子项不渲染（由 flattenGroupTree 的可见性过滤保证）
    li.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'add-sub') { e.stopPropagation(); return promptAddGroup(g.id); }
      if (act === 'edit') { e.stopPropagation(); return editGroup(g); }
      if (act === 'del') { e.stopPropagation(); return deleteGroup(g); }
      if (act === 'toggle-group') {
        e.stopPropagation();
        if (state.expandedGroups.has(g.id)) state.expandedGroups.delete(g.id);
        else state.expandedGroups.add(g.id);
        renderSidebarList();
        return undefined;
      }
      state.currentGroup = g.id;
      renderSidebarList();
      renderTasks();
    });
    groupList.appendChild(li);
  }

  groupEmptyHint(groups, groupList);

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
    const active = state.currentTag === t.id;
    li.className = 'tag-item' + (active ? ' active' : '');
    li.dataset.id = t.id;
    // 可聚焦 + 语义化：键盘 Tab 可达，读屏能播报选中状态
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-pressed', String(active));
    li.title = active ? `已按标签「${esc(t.name)}」筛选，点击取消` : `点击按标签「${esc(t.name)}」筛选`;
    li.innerHTML = `
      <span class="tag-color" style="background:${esc(t.color)}"></span>
      <span class="tag-name">${esc(t.name)}</span>
      <span class="tag-count">${t.task_count || 0}</span>
      <button class="tag-del" title="删除">×</button>`;
    const toggle = () => selectTag(state.currentTag === t.id ? null : t.id);
    li.addEventListener('click', (e) => {
      if (e.target.closest('.tag-del')) return;
      toggle();
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggle(); }
    });
    li.querySelector('.tag-del').addEventListener('click', () => deleteTag(t));
    tagList.appendChild(li);
  }
}

/**
 * 切换标签筛选。
 * 关键：统计 / 报告 / 检索 / 会议这几个视图并不消费 tagId，若留在原视图会出现
 * 「点了标签、列表毫无变化」的假死感 —— 选中标签时自动切回任务视图。
 */
async function selectTag(id) {
  state.currentTag = id;
  if (id != null && !TASK_VIEWS.includes(state.view)) {
    state.view = 'all';
    state.currentGroup = 'all';
  }
  await api.ui.setTagFilter(id);
  renderSidebar();
  await render();
  renderTagFilterChip();
}

/** 顶栏筛选指示：侧边栏滚动/折叠时也能确认标签筛选仍在生效 */
function renderTagFilterChip() {
  const el = document.getElementById('tag-filter-chip');
  if (!el) return;
  const t = state.tags.find((x) => x.id === state.currentTag);
  if (!t) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span class="tag-color" style="background:${esc(t.color)}"></span>`
    + `<span>标签：${esc(t.name)}</span><span class="chip-x">×</span>`;
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
  // 「今天」里刚勾选完成、仍留在列表中的任务数量
  const keptCount = state.view === 'today' ? state.recentlyDone.size : 0;

  let html = '';

  if (keptCount) {
    html += `<div class="keep-done-bar">
      <span class="keep-done-text">✅ 今日已完成 <b>${keptCount}</b> 个任务，已保留在列表中（打勾 / 置灰 / 删除线）</span>
      <button class="link-btn" data-act="hide-done" title="立即移出列表（切换视图或重启后仍会保留，跨天自动清空）">隐藏已完成</button>
    </div>`;
  }

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
      const key = taskGroupKey(gid);
      const collapsed = state.collapsedTaskGroups.has(key);
      // 分组头本身就是折叠开关：点一下展开 / 收起，状态按分组独立记忆
      html += `<button type="button" class="task-group-head${collapsed ? ' is-collapsed' : ''}" data-act="toggle-task-group"
        data-group="${esc(key)}" aria-expanded="${!collapsed}"
        title="${collapsed ? '展开' : '收起'}「${esc(gName)}」的 ${items.length} 个任务">
        <span class="group-toggle">${collapsed ? '▸' : '▾'}</span>
        <span class="g-dot" style="background:${esc(gColor)}"></span>
        <span class="tg-name">${esc(gName)}</span>
        <span class="tg-count">${items.length}</span>
      </button>`;
      if (!collapsed) html += buildTaskList(flattenTree(items));
    }
  }

  // 列表底部：就地新增入口（归档视图不提供新增）
  if (!isArchived) {
    html += state.addingTask ? newEditorHtml() : addRowHtml();
  }

  // 编辑器被整块替换前先回收它的自动保存器：换 innerHTML 不会取消已排队的防抖计时器，
  // 旧保存器会拿着已销毁的 DOM 继续写库（可能把别的任务刚改过的值覆盖回去）。
  disposeEditorSavers(viewEl);

  viewEl.innerHTML = html;
  const hideDoneBtn = viewEl.querySelector('[data-act="hide-done"]');
  if (hideDoneBtn) {
    hideDoneBtn.addEventListener('click', () => {
      clearRecentlyDone();
      renderTasks();
    });
  }
  bindTaskListEvents(viewEl);
  bindEditorEvents(viewEl);
  if (state.addingTask || state.editingTaskId != null) focusEditor();
}

/**
 * 回收视图内就地编辑器的自动保存器（先 flush 落库，再 dispose 取消计时器）。
 * 与详情抽屉同一套规则：只换 innerHTML 不等于保存器消失。
 */
function disposeEditorSavers(root) {
  root.querySelectorAll('.task-editor').forEach((ed) => {
    const saver = ed && ed.__autoSave;
    if (!saver) return;
    try {
      const p = saver.flush();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_e) { /* 回收阶段不抛错 */ }
    try { saver.dispose(); } catch (_e) { /* 同上 */ }
  });
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

/** 分组 id → 完整路径（"工作 / 前端"）；找不到时回退为空串 */
function groupPathAt(id) {
  const g = state.groups.find((x) => x.id === id);
  return g ? groupPath(g, state.groups) : '';
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
  // 创建时间：行内只放日期（完整时间走 title），避免把 meta 行撑得太长
  if (t.created_at) meta.push(`<span class="meta-item created-at" title="创建于 ${esc(fmtDateTime(t.created_at))}">🕒 ${esc(t.created_at.slice(0, 10))}</span>`);
  for (const n of t.tag_names) meta.push(`<span class="tag-chip">${esc(n)}</span>`);
  // 分组标签显示完整路径（"工作 / 前端"），否则同名子分组看不出归属
  const groupLabel = t.group_name
    ? `<span class="meta-item group-tag" style="color:${esc(t.group_color)}" title="${esc(groupPathAt(t.group_id))}">● ${esc(groupPathAt(t.group_id))}</span>`
    : '';

  return `
  <li class="task-item${done}${isSub ? ' is-subtask' : ''}" draggable="false" data-id="${t.id}" style="margin-left:${depth * 20}px">
    ${isSub ? '' : '<span class="drag-handle" data-act="drag" title="按住拖拽调整顺序">⠿</span>'}
    <button class="task-check" data-act="toggle" title="完成/取消">${t.completed ? '✓' : ''}</button>
    <div class="task-body">
      <div class="task-title">
        ${t.subtask_count > 0 ? `<button class="task-expand" data-act="toggle-expand" aria-expanded="${state.expandedTasks.has(t.id)}" title="${state.expandedTasks.has(t.id) ? '收起子任务' : '展开子任务'}">${state.expandedTasks.has(t.id) ? '▾' : '▸'}</button>` : ''}
        <span class="task-title-text" data-act="rename" title="点击直接修改标题">${esc(t.title)}</span>
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
      else if (act === 'rename') startInlineRename(btn, id);
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

  // 分组头：各自独立展开 / 收起（状态写回 settings，重启后保持）
  container.querySelectorAll('[data-act="toggle-task-group"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleTaskGroup(btn.dataset.group);
      renderTasks();
    });
  });
}

/* ---------------- 行内改标题 ---------------- */

/**
 * 点击任务标题就地改名：只替换这一行的标题节点，不整表重绘（避免焦点丢失与列表闪动）。
 * 失焦或回车保存，Esc 放弃。
 * @param {HTMLElement} span .task-title-text 节点
 * @param {number} id 任务 id
 */
function startInlineRename(span, id) {
  if (!span || span.querySelector('input')) return; // 已在编辑中
  const original = span.textContent;
  const input = document.createElement('input');
  input.className = 'task-title-input';
  input.type = 'text';
  input.maxLength = 200;
  input.value = original;
  span.textContent = '';
  span.appendChild(input);
  span.classList.add('is-renaming');
  input.focus();
  input.select();

  let settled = false;
  /** 收尾：commit=false 表示放弃 */
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    input.removeEventListener('blur', onBlur);
    span.classList.remove('is-renaming');
    const next = input.value.trim();
    const put = (text) => { span.textContent = text; };
    if (!commit || !next || next === original) { put(original); return; }
    put(next); // 先落地到界面，保存失败再回滚
    try {
      await api.tasks.update(id, { title: next });
      // 按 id 精确替换（不可变更新），不直接改 state 里的对象：
      // 列表数据与任何编辑态都不共用引用，改一个任务不可能带动另一个。
      const i = state.tasks.findIndex((x) => x.id === id);
      if (i > -1) state.tasks[i] = { ...state.tasks[i], title: next };
      toast('标题已保存');
    } catch (e) {
      put(original);
      toast(`保存失败：${e && e.message ? e.message : e}`);
    }
  };
  const onBlur = () => finish(true);
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

/* ---------------- 就地新增 / 编辑编辑器 ---------------- */

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
  // 计划日期：开始 / 完成合并为单一范围控件；新建任务的默认值由 NEW_TASK_RANGE_MODE 决定，
  // 但「今天」视图下默认填今天（否则新建的任务 plan_end 为空，根本不会出现在今天列表里）
  const rangeOpts = { required: PLAN_DATE_REQUIRED, placeholder: '计划开始 ~ 完成' };
  const newRangeMode = state.view === 'today' ? 'today' : NEW_TASK_RANGE_MODE;
  const range = isEdit ? { start: t.plan_start, end: t.plan_end } : defaultDateRange(newRangeMode);
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
      <select class="editor-group" title="分组">${groupOptionsHtml(state.groups, defaultGroup)}</select>
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
  // 必须 dispose 而不只是 cancel：cancel 只清计时器，renderTasks 回收时会 flush 一次，
  // 结果把用户刚取消的内容又写回库里。dispose 之后 flush 直接空转。
  const ed = document.querySelector('.task-editor');
  if (ed && ed.__autoSave) { ed.__autoSave.cancel(); ed.__autoSave.dispose(); }
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
  const t = await api.tasks.toggle(id);
  // 「今天」视图：勾选完成后不要立刻消失 —— 记下来，随后重绘时补拉回来
  noteCompletionChange(id, !!(t && t.completed));
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

/** 顶部 ＋ / 分组行 ＋ 的统一入口（parentId 非空 = 新增子分组） */
async function promptAddGroup(parentId = null) {
  await promptGroupForm(null, parentId);
}

/**
 * 新增/编辑分组：统一走表单弹窗。
 * 「上级分组」下拉决定层级 —— 放在哪个分组下面就成为它的子分组，之后也能改。
 * @param {number|null} presetParentId 从某个分组的 ＋ 进来时默认挂到它下面
 */
async function promptGroupForm(g = null, presetParentId = null) {
  const isEdit = !!g;
  const exclude = isEdit ? [g.id, ...descendantGroupIds(state.groups, g.id)] : [];
  const parentId = isEdit ? (g.parent_id ?? '') : (presetParentId ?? '');

  await openFormModal({
    title: isEdit ? '编辑分组' : '新增分组',
    okText: isEdit ? '保存' : '创建',
    // 分组表单字段少、语义纵向，保持单列（不套两栏栅格、不自动聚焦，避免误改下拉）
    grid: false,
    fields: [
      {
        name: 'name',
        label: '分组名称',
        value: g ? g.name : '',
        placeholder: '例如：工作 / 学习 / 健身',
      },
      {
        name: 'color',
        label: '颜色',
        type: 'choices',
        value: g ? g.color : 'auto',
        options: GROUP_COLORS,
      },
      {
        name: 'parentId',
        label: '上级分组',
        type: 'select',
        value: parentId,
        options: [
          { value: '', label: '（无，作为顶级分组）' },
          ...flattenGroupTree(state.groups, { respectExpansion: false })
            .filter(({ g: x }) => !exclude.includes(x.id))
            .map(({ g: x, depth }) => ({
              value: x.id,
              label: `${depth ? `${'　'.repeat(depth)}└ ` : ''}${x.name}`,
            })),
        ],
      },
    ],
    onSubmit: async (v) => {
      const name = v.name.trim();
      if (!name) return '请输入分组名称';
      const dup = state.groups.find((x) => x.name === name && x.id !== (g ? g.id : -1));
      if (dup) return `分组「${name}」已存在，请换一个名称`;
      const color = v.color === 'auto' ? pickColor() : v.color;
      const pid = v.parentId === '' ? null : Number(v.parentId);
      if (isEdit) {
        const updated = await api.groups.update(g.id, { name, color, parentId: pid });
        await afterGroupSaved(updated, true);
      } else {
        const created = await api.groups.create({ name, color, parentId: pid });
        await afterGroupSaved(created, false);
      }
      return undefined;
    },
  });
}

/** 分组写库后：刷新侧边栏 + 选中/展开到它 + 提示 */
async function afterGroupSaved(group, isEdit) {
  await refreshAll();
  if (!isEdit) {
    // 新建：确保父分组展开，否则新分组藏在折叠的父节点里"看不见"
    if (group.parent_id != null) state.expandedGroups.add(group.parent_id);
    state.currentGroup = group.id;
  }
  renderSidebarList();
  renderTasks();
  highlightSidebarItem('group', group.id);
  toast(isEdit ? '分组已更新' : `已创建分组「${group.name}」`);
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
  await promptGroupForm(g);
}

/**
 * 删除分组：子分组会一并删除，任务上移一级（不丢任务）。
 * 确认文案里把影响面说清楚，避免出现"点一下任务全没了"的意外。
 */
async function deleteGroup(g) {
  const kids = descendantGroupIds(state.groups, g.id);
  const target = g.parent_id != null
    ? `上级分组「${state.groups.find((x) => x.id === g.parent_id)?.name || '已删除'}」`
    : '未分组';
  const msg = kids.length
    ? `删除分组「${g.name}」会连带删除它的 ${kids.length} 个子分组，其中的任务将移到${target}。确定删除？`
    : `删除分组「${g.name}」？组内任务将移到${target}。`;
  if (!confirm(msg)) return;
  await guardAction(async () => {
    await api.groups.remove(g.id);
    if (state.currentGroup === g.id) state.currentGroup = 'all';
    state.expandedGroups.delete(g.id);
    await refreshAll();
    renderSidebarList();
    renderTasks();
    toast(`已删除分组「${g.name}」`);
  }, '删除分组失败');
}

async function deleteTag(t) {
  if (!confirm(`删除标签「${t.name}」？`)) return;
  guardAction(async () => {
    await api.tags.remove(t.id);
    if (state.currentTag === t.id) {
      state.currentTag = null;
      await api.ui.setTagFilter(null); // 持久化值同步清掉，否则重启后又筛到一个已删除的标签
    }
    await refreshAll();
    renderSidebarList();
    renderTagFilterChip();
    renderTasks();
  }, '删除标签失败');
}

/* ---------------- 统计 ---------------- */

/**
 * 完成趋势的可选范围（key 与 main/db.js 的 TREND_RANGES 一一对应）。
 * 跨度越大粒度越粗（天 → 周 → 月），坐标轴标签与标题文案随选择一起变。
 */
const TREND_RANGES = [
  { key: '7d', label: '近 7 天' },
  { key: '1m', label: '近一个月' },
  { key: '6m', label: '近半年' },
  { key: '1y', label: '近一年' },
];
/** 当前趋势范围：切换视图再回到统计页时保留用户上次的选择 */
let trendRange = '7d';

async function renderStats() {
  const viewEl = document.getElementById('view');
  viewEl.innerHTML = '<div class="empty">加载中…</div>';
  const ov = await api.stats.overview();

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
      ${statCardHtml('total', ov.total, '总任务', '')}
      ${statCardHtml('active', ov.active, '进行中', 'primary')}
      ${statCardHtml('completed', ov.completed, '已完成', 'green')}
      ${statCardHtml('overdue', ov.overdue, '已逾期', 'danger')}
      <div class="stat-card is-static"><div class="num">${ov.rate}%</div><div class="label">完成率</div></div>
      ${statCardHtml('archived', ov.archived, '已归档', '')}
    </div>
    <div class="stats-tip">${statsTipHtml()}</div>
    <div class="panel">
      <div class="panel-head">
        <h3 id="trend-title">完成趋势</h3>
        <div class="trend-range" id="trend-range" role="group" aria-label="完成趋势时间范围">
          ${TREND_RANGES.map((r) => `<button type="button" class="chip trend-chip${r.key === trendRange ? ' active' : ''}"
            data-trend="${esc(r.key)}" aria-pressed="${r.key === trendRange}">${esc(r.label)}</button>`).join('')}
        </div>
      </div>
      <div class="trend-body" id="trend-body"><div class="trend-loading">加载中…</div></div>
    </div>
    <div class="panel"><h3>分组任务量</h3>${groupBars || '<span class="meta-item">暂无分组</span>'}</div>
    <div class="panel"><h3>优先级分布（进行中）</h3>${priBars}</div>`;

  viewEl.querySelectorAll('.stat-card[data-stat]').forEach((card) => {
    card.addEventListener('click', () => openStatDrilldown(card.dataset.stat, card));
  });
  bindTrendRange(viewEl);
  await renderTrend();
}

/** 范围切换：只重绘趋势这一块，概述数据不必重新拉取 */
function bindTrendRange(viewEl) {
  const box = viewEl.querySelector('#trend-range');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-trend]');
    if (!btn || btn.dataset.trend === trendRange) return;
    trendRange = btn.dataset.trend;
    box.querySelectorAll('[data-trend]').forEach((b) => {
      const on = b.dataset.trend === trendRange;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    await renderTrend();
  });
}

/**
 * 拉取并绘制趋势。三种状态都要有明确呈现：
 * 加载中、无数据（给出范围文案而不是空图）、加载失败（显示原因）。
 */
async function renderTrend() {
  const body = document.getElementById('trend-body');
  if (!body) return;
  const titleEl = document.getElementById('trend-title');
  body.innerHTML = '<div class="trend-loading">加载中…</div>';

  let t;
  try {
    t = await api.stats.trend({ range: trendRange });
  } catch (e) {
    body.innerHTML = `<div class="trend-empty">趋势加载失败：${esc((e && e.message) || '未知错误')}</div>`;
    return;
  }
  const label = (t && t.label) || '';
  if (titleEl) titleEl.textContent = `${label}完成趋势`;

  const pts = (t && t.points) || [];
  // 无数据：直接给一句人话，而不是画一排高度 0 的柱子
  if (!pts.length || !t.total) {
    body.innerHTML = `<div class="trend-empty">${esc(label || '所选范围')}内还没有已完成的任务</div>`;
    return;
  }

  const maxCount = Math.max(1, ...pts.map((p) => p.count));
  // 坐标轴文案随粒度变：天 = 当天，周 = 该周起始日，月 = 年月
  const unitText = t.granularity === 'week' ? ' 起一周' : t.granularity === 'month' ? '（整月）' : '';
  // 柱子多时每隔 N 个才显示一个坐标标签，否则标签会挤成一团
  const step = Math.ceil(pts.length / 15);
  const cols = pts
    .map((p, i) => {
      const h = Math.max(3, Math.round((p.count / maxCount) * 100));
      const showLabel = i === pts.length - 1 || i % step === 0;
      return `<div class="trend-col" title="${esc(`${p.label}${unitText}：${p.count} 个`)}">
        <span class="trend-count">${p.count ? p.count : ''}</span>
        <div class="trend-bar" style="height:${h}px"></div>
        <span class="trend-date"${showLabel ? '' : ' style="visibility:hidden"'}">${esc(p.label)}</span>
      </div>`;
    })
    .join('');

  body.innerHTML = `<div class="trend-chart">${cols}</div>
    <div class="trend-summary">${esc(label)}共完成 ${t.total} 个任务</div>`;
}

/**
 * 统计页提示。
 * 标签筛选开着时要点明「统计仍是全局口径」——否则用户看到顶栏还挂着标签、
 * 但数字没按标签过滤，会以为是选中态失效。
 */
function statsTipHtml() {
  const t = state.tags.find((x) => x.id === state.currentTag);
  const base = '点击卡片上的数字可查看对应任务明细';
  if (!t) return base;
  return `${base}　<span class="stats-warn">当前已按标签「${esc(t.name)}」筛选任务列表，统计仍按全部任务计算</span>`;
}

/** 统计卡片：数字与标题都可点（整卡点击区域更大，但只有数字带下划线提示） */
function statCardHtml(key, num, label, tone) {
  return `<button type="button" class="stat-card ${tone}" data-stat="${key}"
      title="查看「${esc(label)}」的任务明细" aria-label="${esc(label)} ${num} 个，点击查看明细">
      <div class="num">${num}</div><div class="label">${esc(label)}</div></button>`;
}

/** 各统计项 → 任务查询条件（与 overview 的 SQL 口径一一对应） */
function statFilterOf(key) {
  const today = todayStr();
  const base = { topLevel: true };
  switch (key) {
    case 'total': return { ...base, status: 'any' };
    case 'active': return { ...base, status: 'active' };
    case 'completed': return { ...base, status: 'completed' };
    case 'archived': return { ...base, status: 'archived' };
    case 'overdue': {
      // overview 的逾期 = plan_end < 今天，等价于 plan_end <= 昨天
      const y = new Date(`${today}T00:00:00`);
      y.setDate(y.getDate() - 1);
      const p = (n) => String(n).padStart(2, '0');
      return { ...base, status: 'active', planEndTo: `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}` };
    }
    default: return null;
  }
}

const STAT_TITLES = {
  total: '总任务', active: '进行中', completed: '已完成', overdue: '已逾期', archived: '已归档',
};

const DRILL_SORTS = [
  { key: 'title', label: '任务名称' },
  { key: 'plan_end', label: '截止时间' },
  { key: 'status', label: '状态' },
  { key: 'priority', label: '优先级' },
];

/** 任务在列表里展示的状态文案（逾期是派生状态，库里只有 completed/archived 两个标记） */
function drillStatusOf(t) {
  if (t.archived) return { text: '已归档', cls: 'st-archived' };
  if (t.completed) return { text: '已完成', cls: 'st-done' };
  if (t.plan_end && t.plan_end < todayStr()) return { text: '已逾期', cls: 'st-overdue' };
  return { text: '进行中', cls: 'st-active' };
}

/**
 * 统计数字下钻：弹窗列出对应任务，支持按列排序，点击行跳到任务详情。
 * 关闭弹窗后统计页原样还在（弹窗是覆盖层，不销毁视图）。
 */
async function openStatDrilldown(key, cardEl) {
  const f = statFilterOf(key);
  if (!f) return;
  const title = `${STAT_TITLES[key] || '任务'}明细`;
  let tasks = [];
  let sortKey = 'plan_end';
  let sortDir = 1; // 1 升序 / -1 降序

  const sortTasks = () => {
    const val = (t) => {
      switch (sortKey) {
        case 'title': return String(t.title || '');
        case 'plan_end': return t.plan_end || '9999-99-99'; // 无截止日期的排在最后
        case 'status': return drillStatusOf(t).text;
        case 'priority': return Number(t.priority) || 0;
        default: return '';
      }
    };
    tasks.sort((a, b) => {
      const va = val(a); const vb = val(b);
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
  };

  const rowsHtml = () => {
    if (!tasks.length) return '<div class="drill-empty">没有符合条件的任务</div>';
    return tasks.map((t) => {
      const st = drillStatusOf(t);
      const pri = Number(t.priority) || 0;
      return `<tr class="drill-row" data-id="${t.id}" tabindex="0" title="点击查看任务详情">
        <td class="drill-title">${esc(t.title)}</td>
        <td>${t.plan_end ? esc(t.plan_end) : '<span class="drill-dim">—</span>'}</td>
        <td><span class="drill-status ${st.cls}">${st.text}</span></td>
        <td><span class="drill-pri" style="color:${PRIORITY_COLOR[pri]}">${PRIORITY_TEXT[pri]}</span></td>
        <td class="drill-group">${t.group_name ? esc(t.group_name) : '<span class="drill-dim">—</span>'}</td>
      </tr>`;
    }).join('');
  };

  const headHtml = () => DRILL_SORTS
    .map((s) => `<th class="drill-th${s.key === sortKey ? ' sorted' : ''}" data-sort="${s.key}" tabindex="0"
        role="button" aria-sort="${s.key === sortKey ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}">
        ${s.label}<span class="drill-arrow">${s.key === sortKey ? (sortDir === 1 ? '↑' : '↓') : ''}</span></th>`)
    .join('');

  const tableHtml = () => `
    <div class="drill-meta">共 ${tasks.length} 个任务 · 点击表头排序 · 点击行打开详情</div>
    <div class="drill-wrap"><table class="drill-table">
      <thead><tr>${headHtml()}</tr></thead>
      <tbody>${rowsHtml()}</tbody>
    </table></div>`;

  await openPanelModal({
    title,
    className: 'modal-drill',
    html: '<div class="drill-loading">加载中…</div>',
    onMount: async (root, close) => {
      const body = root.querySelector('.modal-body');
      try {
        tasks = await api.tasks.list(f);
      } catch (e) {
        body.innerHTML = `<div class="drill-empty">加载失败：${esc((e && e.message) || e)}</div>`;
        return;
      }
      // 与卡片数字对不上时明确提示，避免"看起来是 bug"的静默不一致
      const shown = cardEl ? Number(cardEl.querySelector('.num').textContent) : null;
      sortTasks();
      body.innerHTML = (Number.isFinite(shown) && shown !== tasks.length
        ? `<div class="drill-warn">统计值 ${shown} 与当前查询结果 ${tasks.length} 不一致，可能数据刚有变动</div>`
        : '') + tableHtml();

      const resort = (key) => {
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = 1; }
        sortTasks();
        body.innerHTML = tableHtml();
        bindTable();
      };
      const bindTable = () => {
        body.querySelectorAll('.drill-th').forEach((th) => {
          const go = () => resort(th.dataset.sort);
          th.addEventListener('click', go);
          th.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          });
        });
        body.querySelectorAll('.drill-row').forEach((tr) => {
          const go = () => { close(); openDetail(Number(tr.dataset.id)); };
          tr.addEventListener('click', go);
          tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          });
        });
      };
      bindTable();
    },
  });
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
  if (!el) return;
  // 提示恒挂在 body 最外层：既不受任何父容器 overflow 裁切，也保证 z-index 生效在顶层栈里
  if (el.parentElement !== document.body) document.body.appendChild(el);
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
