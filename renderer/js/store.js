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
  expandedTasks: new Set(), // 列表中已展开子任务的任务 id 集合
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
  state.tasks = await api.tasks.list(f);
  return state.tasks;
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

export { state, loadGroups, loadTags, loadTasks, buildFilter, refreshAll, todayStr };
