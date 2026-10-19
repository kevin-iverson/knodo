'use strict';
/**
 * 前端状态管理（轻量 store）。
 */
import { api } from './api.js';

const state = {
  groups: [],
  tags: [],
  tasks: [],
  // 当前视图
  view: 'today', // today | upcoming | all | completed | archived | stats | reports
  currentGroup: 'all', // 分组筛选（sidebar 分组点击）
  currentTag: null, // 标签筛选
  priorityFilter: 'all', // 'all' | 0..3
  search: '',
  // 列表排序方式：smart=智能（默认）/ priority=优先级 / due=截止日期 / manual=手动（可拖拽）
  sortMode: 'smart',
  // 时间筛选（YYYY-MM-DD，空串表示不限）
  timeFilters: {
    planStartFrom: '',
    planStartTo: '',
    planEndFrom: '',
    planEndTo: '',
    completedFrom: '',
    completedTo: '',
  },
  theme: 'system',
  editingTaskId: null, // 正在编辑的任务 id（null 表示无）
  addingTask: false,   // 是否展开列表底部的“新增任务”编辑器
  detailTaskId: null,  // 详情页打开的任务 id（null 表示关闭）
  // 「今天」视图里刚被勾选完成的任务 id：继续留在列表里（打勾 / 置灰 / 删除线），
  // 让用户直接看到今天做完了什么，不必再去「已完成」页按时间范围筛。
  // 存 settings（带自然日），所以切换视图 / 重启后回到「今天」仍看得到；
  // 只在跨天、或用户点「隐藏已完成」时清空 —— 只做“就地保留”，不改变视图本身的查询口径。
  recentlyDone: new Set(),
  recentlyDoneDay: '', // recentlyDone 对应的自然日，跨天自动作废
  // 列表中已展开子任务的任务 id 集合
  expandedTasks: new Set(),
  // 侧边栏中已展开子分组的分组 id 集合（默认折叠，点箭头展开）
  expandedGroups: new Set(),
};

/** 本地日期 YYYY-MM-DD */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地日期 → 当天起/止的 UTC ISO（用于“实际完成时间”范围筛选） */
function dateRangeIso(dateStr, endOfDay = false) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString();
}

async function loadGroups() {
  state.groups = await api.groups.list();
  return state.groups;
}

async function loadTags() {
  state.tags = await api.tags.list();
  return state.tags;
}

async function loadTasks() {
  const f = buildFilter();
  const list = await api.tasks.list(f);

  // 今天视图：刚勾选完成的任务要留在列表里。
  // 这里按 id 单独补拉（而不是放宽查询条件），避免把历史已完成任务一股脑捞回来；
  // 补拉不到（已删除 / 已归档 / 又被取消完成）的标记自动作废。
  if (state.view === 'today' && state.recentlyDone.size) {
    ensureRecentlyDoneDay();
    const have = new Set(list.map((t) => t.id));
    let dropped = false;
    for (const id of [...state.recentlyDone]) {
      if (have.has(id)) continue;
      let t = null;
      try { t = await api.tasks.get(id); } catch (_e) { t = null; }
      if (!t || t.archived || !t.completed) { state.recentlyDone.delete(id); dropped = true; continue; }
      list.push(t);
    }
    // 已删除 / 已归档 / 又被取消完成的任务不该一直留在标记里
    if (dropped) persistRecentlyDone();
  }

  state.tasks = list;
  return state.tasks;
}

/* ---------------- 今天视图「刚完成」保留 ---------------- */

/** 跨天后旧标记失效：昨天的“刚完成”不应出现在今天的列表里 */
function ensureRecentlyDoneDay() {
  const d = todayStr();
  if (state.recentlyDoneDay && state.recentlyDoneDay !== d) state.recentlyDone.clear();
  state.recentlyDoneDay = state.recentlyDone.size ? d : '';
}

/** 启动时把上次的“今日已完成”读回来（跨天则自然作废，不会把昨天的任务带进今天） */
async function initRecentlyDone() {
  try {
    const saved = await api.ui.getTodayDone();
    const ids = (saved && saved.ids) || [];
    if (saved && saved.day === todayStr() && ids.length) {
      state.recentlyDone = new Set(ids);
      state.recentlyDoneDay = saved.day;
    }
  } catch (e) {
    console.warn('[store] 读取今日已完成失败', e && e.message);
  }
}

/** 写回 settings：切换视图、重启后回到「今天」列表依然完整 */
function persistRecentlyDone() {
  ensureRecentlyDoneDay();
  api.ui.setTodayDone({ day: state.recentlyDoneDay, ids: [...state.recentlyDone] })
    .catch((e) => console.warn('[store] 保存今日已完成失败', e && e.message));
}

/**
 * 记录一次完成状态变化，供「今天」视图就地保留。
 * @param {number} id 任务 id
 * @param {boolean} completed 变化后的状态
 * @returns {boolean} 是否有变化（调用方据此决定是否重绘）
 */
function noteCompletionChange(id, completed) {
  if (state.view !== 'today') return false;
  ensureRecentlyDoneDay();
  if (completed) {
    if (state.recentlyDone.has(id)) return false;
    state.recentlyDone.add(id);
    state.recentlyDoneDay = todayStr();
    persistRecentlyDone();
    return true;
  }
  // 取消勾选 → 不再是“刚完成”
  const had = state.recentlyDone.delete(id);
  if (had) persistRecentlyDone();
  return had;
}

/** 清空保留（手动点「隐藏已完成」） */
function clearRecentlyDone() {
  state.recentlyDone.clear();
  state.recentlyDoneDay = '';
  persistRecentlyDone();
}

function buildFilter() {
  const f = {
    search: state.search || undefined,
    priority: state.priorityFilter === 'all' ? undefined : Number(state.priorityFilter),
  };
  if (state.currentTag != null) f.tagId = state.currentTag;

  const today = todayStr();
  switch (state.view) {
    case 'today':
      f.status = 'active';
      f.planEndTo = today;
      break;
    case 'upcoming':
      f.status = 'active';
      f.planEndFrom = today;
      f.sort = 'due';
      break;
    case 'completed':
      f.status = 'completed';
      break;
    case 'archived':
      f.status = 'archived';
      break;
    case 'all':
    default:
      f.status = 'all';
      break;
  }

  // 显式选择了排序方式时覆盖视图默认排序（smart 保持各视图自己的默认序）
  if (state.sortMode !== 'smart') f.sort = state.sortMode;

  // 分组筛选（sidebar 分组点击，作用于任务视图）
  if (state.currentGroup !== 'all') f.groupId = state.currentGroup;

  // 时间筛选（手动设置，优先级更高，可覆盖视图自动条件）
  const tf = state.timeFilters;
  if (tf.planStartFrom) f.planStartFrom = tf.planStartFrom;
  if (tf.planStartTo) f.planStartTo = tf.planStartTo;
  if (tf.planEndFrom) f.planEndFrom = tf.planEndFrom;
  if (tf.planEndTo) f.planEndTo = tf.planEndTo;
  if (tf.completedFrom) f.completedFrom = dateRangeIso(tf.completedFrom, false);
  if (tf.completedTo) f.completedTo = dateRangeIso(tf.completedTo, true);

  return f;
}

async function refreshAll() {
  await Promise.all([loadGroups(), loadTags(), loadTasks()]);
}

export {
  state, loadGroups, loadTags, loadTasks, buildFilter, refreshAll, todayStr,
  noteCompletionChange, clearRecentlyDone, initRecentlyDone,
};
