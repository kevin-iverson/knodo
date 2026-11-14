'use strict';
/**
 * 工时视图（FR-06）。
 *
 * 界面严格按 docs/features/worklog-prototype.html 还原：
 *   工具栏（分组 / 标签 / 范围 / 口径 / 导出）→ 四张汇总卡 → 按任务表 → 每日分布。
 *
 * 数字全部来自主进程 store.aggregate 一个出口（RK-02）：
 * 父行「含子任务」= 自身 + 全部后代，子行不参与顶部合计（防重复计数）。
 */
import { api } from '../api.js';
import { toast } from '../ui.js';
import { openDetail } from '../detail.js';
import { flattenGroupTree } from '../group-tree.js';
import { openFormModal } from '../modal.js';
import { DATE_RANGE_EVENT, dateRangeFieldHtml, bindDateRangeFields } from '../controls.js';
import { live, hm, esc, dateKey, fmtDay } from './shared.js';

/* ------------------------------ 视图状态 ------------------------------ */

const V = {
  range: 'week',     // week | lastweek | month | custom
  scope: 'top',      // top = 含子任务 | all = 仅主任务
  groupId: '',       // '' = 全部分组
  tagId: '',         // '' = 全部标签
  customFrom: '',
  customTo: '',
};

const expanded = new Set();
let groups = [];
let tags = [];
let lastRows = [];
let lastRoots = [];

/* ------------------------------ 时间范围 ------------------------------ */

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function mondayOf(d) {
  const x = startOfDay(d);
  const offset = (x.getDay() + 6) % 7; // 周一 = 0
  x.setDate(x.getDate() - offset);
  return x;
}

function bounds() {
  const now = new Date();
  if (V.range === 'lastweek') {
    const thisMon = mondayOf(now);
    const from = new Date(thisMon); from.setDate(from.getDate() - 7);
    return { from, to: thisMon, label: '上周' };
  }
  if (V.range === 'month') {
    const from = startOfDay(now); from.setDate(1);
    const to = new Date(now.getTime() + 60 * 1000);
    return { from, to, label: '本月' };
  }
  if (V.range === 'custom') {
    const from = V.customFrom ? startOfDay(new Date(`${V.customFrom}T00:00:00`)) : startOfDay(now);
    const toBase = V.customTo ? new Date(`${V.customTo}T00:00:00`) : now;
    const to = startOfDay(toBase); to.setDate(to.getDate() + 1);
    return { from, to, label: `${V.customFrom || '—'} ~ ${V.customTo || '—'}` };
  }
  const from = mondayOf(now);
  const to = new Date(now.getTime() + 60 * 1000);
  return { from, to, label: '本周' };
}

/** 范围内的工作日数（周一到周五，已过去的 + 今天），用于「日均」 */
function workdays(from, to) {
  const end = startOfDay(new Date(Math.min(Date.now(), to.getTime())));
  let n = 0;
  const cur = startOfDay(from);
  while (cur <= end) {
    const w = cur.getDay();
    if (w !== 0 && w !== 6) n += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return Math.max(1, n);
}

/* ------------------------------ 树 ------------------------------ */

function buildTree(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentId != null ? byId.get(node.parentId) : null;
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const sort = (list) => {
    list.sort((a, b) => (b.aggSec - a.aggSec) || a.id - b.id);
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

function groupSetOf(id) {
  if (!id) return null;
  const set = new Set([Number(id)]);
  // 选中父分组 = 包含它的全部子分组
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of groups) {
      if (g.parent_id != null && set.has(Number(g.parent_id)) && !set.has(Number(g.id))) {
        set.add(Number(g.id));
        changed = true;
      }
    }
  }
  return set;
}

function nodeMatches(node, gset, tagName) {
  const okGroup = !gset || (node.groupId != null && gset.has(Number(node.groupId)));
  const okTag = !tagName || (node.tags || []).includes(tagName);
  return okGroup && okTag;
}

/** 自己命中，或任一后代命中 —— 否则父任务被筛掉，子任务的工时在报表里就消失了 */
function subtreeMatches(node, gset, tagName) {
  if (nodeMatches(node, gset, tagName)) return true;
  return node.children.some((c) => subtreeMatches(c, gset, tagName));
}

function filterTree(roots, gset, tagName) {
  const keep = (node) => {
    if (!subtreeMatches(node, gset, tagName)) return false;
    node.children = node.children.filter(keep);
    return true;
  };
  return roots.filter(keep);
}

function collectIds(node, out) {
  out.add(node.id);
  node.children.forEach((c) => collectIds(c, out));
  return out;
}

/* ------------------------------ 渲染 ------------------------------ */

function chipGroup(name, items, current) {
  return `<div class="wl-chips">${items.map(([v, label]) => `<button type="button"
    class="wl-chip${String(v) === String(current) ? ' is-active' : ''}" data-wl-chips="${name}" data-v="${esc(v)}">${esc(label)}</button>`).join('')}</div>`;
}

function toolbarHtml() {
  const groupOpts = flattenGroupTree(groups)
    .map(({ g, depth }) => `<option value="${g.id}"${String(V.groupId) === String(g.id) ? ' selected' : ''}>${'\u00a0\u00a0'.repeat(depth)}${esc(g.name)}</option>`)
    .join('');
  const tagOpts = tags
    .map((t) => `<option value="${esc(t.name)}"${V.tagId === t.name ? ' selected' : ''}>${esc(t.name)}</option>`)
    .join('');
  return `
  <div class="wl-toolbar">
    <span class="wl-tb-label">分组</span>
    <select class="wl-select" data-wl="group" aria-label="按分组筛选" title="按分组筛选">
      <option value="">全部分组</option>${groupOpts}
    </select>
    <span class="wl-tb-label">标签</span>
    <select class="wl-select" data-wl="tag" aria-label="按标签筛选" title="按标签筛选">
      <option value="">全部标签</option>${tagOpts}
    </select>
    <span class="wl-tb-label">范围</span>
    ${chipGroup('range', [['week', '本周'], ['lastweek', '上周'], ['month', '本月'], ['custom', '自定义']], V.range)}
    <span class="wl-tb-label">口径</span>
    ${chipGroup('scope', [['top', '含子任务'], ['all', '仅主任务']], V.scope)}
    <div class="wl-spacer"></div>
    <button type="button" class="wl-btn" data-wl="manual" title="补录一段没有计时的工时">＋ 补录</button>
    <button type="button" class="wl-btn" data-wl="export" title="导出当前范围与筛选的报工表（CSV）">导出</button>
  </div>
  ${V.range === 'custom' ? `<div class="wl-custom-range">
    ${dateRangeFieldHtml(V.customFrom, V.customTo, { placeholder: '选择自定义范围' })}
  </div>` : ''}`;
}

function rowHtml(node, depth, displaySec, total, maxSec) {
  const hasChild = node.children.length > 0;
  const open = expanded.has(node.id);
  const pct = total > 0 ? Math.round((displaySec / total) * 100) : 0;
  const barPct = maxSec > 0 ? Math.max(1, Math.round((node.aggSec / maxSec) * 100)) : 0;
  const indent = depth * 22;
  const running = live.snap.mode !== 'idle' && Number(live.snap.taskId) === Number(node.id);
  const active = live.snap.mode !== 'idle' && Number(live.snap.taskId) === Number(node.id);
  const runLabel = active ? (live.snap.mode === 'paused' ? '已暂停' : '计时中') : '开始';
  return `<tr class="wl-row${depth ? ' is-child' : ''}" data-wl-row="${node.id}">
    <td>
      <div class="wl-task-cell" style="padding-left:${indent}px">
        <button type="button" class="wl-twist${hasChild ? '' : ' is-ph'}" data-wl-twist="${node.id}" aria-label="${open ? '收起' : '展开'}子任务">${open ? '▾' : '▸'}</button>
        <span class="wl-t-title${depth ? ' is-sub' : ''}">${esc(node.title)}</span>
        ${depth ? '<span class="wl-t-group">· 子任务</span>' : (node.groupName ? `<span class="wl-t-group">· ${esc(node.groupName)}</span>` : '')}
      </div>
    </td>
    <td class="wl-r wl-mono${depth ? ' is-muted' : ' is-own'}">${hm(node.ownSec)}</td>
    <td class="wl-r wl-mono${depth ? ' is-muted' : ' is-agg'}">${hm(node.aggSec)}</td>
    <td>
      <div class="wl-bar-cell">
        <div class="wl-bar-track"><div class="wl-bar-fill${depth ? ' is-sub' : ''}" style="width:${barPct}%"></div></div>
        ${depth ? '' : `<span class="wl-mono is-muted wl-pct">${pct}%</span>`}
      </div>
    </td>
    <td class="wl-r"><button type="button" class="wl-mini-act${running ? ' is-run' : ''}" data-wl-run="${node.id}">${runLabel}</button></td>
  </tr>`;
}

function treeHtml(roots, total, maxSec) {
  const out = [];
  const walk = (node, depth) => {
    const display = V.scope === 'all' ? node.ownSec : node.aggSec;
    out.push(rowHtml(node, depth, display, total, maxSec));
    if (node.children.length && expanded.has(node.id)) {
      node.children.forEach((c) => walk(c, depth + 1));
    }
  };
  roots.forEach((r) => walk(r, 0));
  return out.join('');
}

function chartHtml(entries, ids, from, to) {
  // 逐日分桶（本地日期）：范围多长就画多少根，柱子自适应用 flex:1
  const days = [];
  const cur = startOfDay(from);
  const endDay = startOfDay(new Date(to.getTime() - 1));
  while (cur <= endDay) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  const sums = new Map(days.map((d) => [dateKey(d), 0]));
  for (const e of entries) {
    if (ids && !ids.has(Number(e.taskId))) continue;
    const key = dateKey(new Date(e.startedAt));
    if (sums.has(key)) sums.set(key, sums.get(key) + Number(e.sec || 0));
  }
  const values = days.map((d) => sums.get(dateKey(d)) || 0);
  const max = Math.max(1, ...values);
  const todayKey = dateKey(new Date());
  const stride = Math.max(1, Math.ceil(days.length / 8));
  const labels = days.map((d, i) => {
    const isToday = dateKey(d) === todayKey;
    if (days.length <= 7) {
      return { text: `周${'日一二三四五六'[d.getDay()]}`, isToday };
    }
    const show = i === 0 || i === days.length - 1 || i % stride === 0;
    return { text: show ? fmtDay(d.toISOString()) : '', isToday };
  });
  return `
  <div class="wl-chart">
    ${days.map((d, i) => `<div class="wl-chart-col">
      <div class="wl-chart-bar${dateKey(d) === todayKey ? ' is-today' : ''}"
           style="height:${Math.max(3, Math.round((values[i] / max) * 84))}%"
           title="${fmtDay(d.toISOString())} · ${hm(values[i])}">
        <span>${values[i] ? hm(values[i]) : ''}</span>
      </div>
    </div>`).join('')}
  </div>
  <div class="wl-chart-x">
    ${labels.map((l, i) => `<div class="${l.isToday ? 'is-today' : ''}">${l.text}</div>`).join('')}
  </div>`;
}

export async function render(root) {
  if (!root) return;
  try {
    const [g, t] = await Promise.all([
      api.groups.list().catch(() => []),
      api.tags.list().catch(() => []),
    ]);
    groups = g || [];
    tags = t || [];
  } catch (e) { /* 拉不到分组/标签时用空列表，视图仍然可用 */ }

  const { from, to, label } = bounds();
  const payload = {
    from: from.toISOString(),
    to: to.toISOString(),
  };

  let rows = [];
  let entries = [];
  try {
    rows = await api.worklog.range(payload);
    entries = await api.worklog.rangeEntries(payload);
  } catch (e) {
    toast(`加载工时失败：${(e && e.message) || e}`);
  }
  lastRows = rows || [];

  const tree = buildTree(lastRows);
  const gset = groupSetOf(V.groupId);
  const tagName = V.tagId || '';
  const roots = filterTree(tree, gset, tagName).filter((r) => r.aggSec > 0 || r.children.some((c) => c.aggSec > 0));
  lastRoots = roots;

  const valueOf = (n) => (V.scope === 'all' ? n.ownSec : n.aggSec);
  const total = roots.reduce((s, r) => s + valueOf(r), 0);
  const maxSec = Math.max(1, ...roots.map((r) => r.aggSec));
  const days = workdays(from, to);
  const avg = total / days;

  let ownTasks = 0;
  let subTasks = 0;
  const ids = new Set();
  for (const r of roots) {
    ownTasks += 1;
    collectIds(r, ids);
  }
  subTasks = Math.max(0, ids.size - ownTasks);

  const longest = roots.reduce((best, r) => (!best || valueOf(r) > valueOf(best) ? r : best), null);

  /**
   * 柱状图按**整段自然周期**画，而不是「到今天为止」：
   * 原型里「本周」始终是周一到周日 7 根柱子，周六周日没有记录也是空柱。
   */
  const chartTo = (() => {
    if (V.range === 'week' || V.range === 'lastweek') {
      const d = new Date(from); d.setDate(d.getDate() + 7); return d;
    }
    if (V.range === 'month') {
      const d = new Date(from); d.setMonth(d.getMonth() + 1); return d;
    }
    return to;
  })();

  root.innerHTML = `
    ${toolbarHtml()}
    <div class="wl-sum-grid">
      <div class="wl-sum-card is-accent">
        <div class="wl-k">总工时</div>
        <div class="wl-v num">${hm(total)}</div>
        <div class="wl-s">${V.range === 'week' ? '周一 00:00 至今'
    : V.range === 'month' ? '本月 1 日至今'
      : V.range === 'lastweek' ? '上周一 ~ 本周一'
        : esc(label)}</div>
      </div>
      <div class="wl-sum-card">
        <div class="wl-k">日均</div>
        <div class="wl-v num">${hm(avg)}</div>
        <div class="wl-s">按 ${days} 个工作日</div>
      </div>
      <div class="wl-sum-card">
        <div class="wl-k">涉及任务</div>
        <div class="wl-v num">${ownTasks + subTasks}<small>项</small></div>
        <div class="wl-s">主任务 ${ownTasks} · 子任务 ${subTasks}</div>
      </div>
      <div class="wl-sum-card">
        <div class="wl-k">最长单项</div>
        <div class="wl-v num">${longest ? hm(valueOf(longest)) : '0m'}</div>
        <div class="wl-s">${longest ? esc(longest.title) : '—'}</div>
      </div>
    </div>

    <div class="wl-panel">
      <div class="wl-panel-head">
        <h3>按任务</h3>
        <span class="wl-sub">父任务合计 = 自身 + 全部后代，不重复计入</span>
        <div class="wl-spacer"></div>
        <span class="wl-sub wl-mono">${hm(total)}</span>
      </div>
      <table class="wl-table">
        <thead><tr>
          <th>任务</th>
          <th class="wl-r" style="width:88px">自身</th>
          <th class="wl-r" style="width:100px">含子任务</th>
          <th style="width:154px">占比</th>
          <th class="wl-r" style="width:76px"></th>
        </tr></thead>
        <tbody>${roots.length
    ? treeHtml(roots, total, maxSec)
    : '<tr><td colspan="5"><div class="wl-empty-view">本期还没有工时记录。把鼠标移到任意任务上，点「▶」开始计时，或点工具栏右侧的「＋ 补录」。</div></td></tr>'}</tbody>
      </table>
    </div>

    <div class="wl-panel">
      <div class="wl-panel-head"><h3>每日分布</h3><div class="wl-spacer"></div><span class="wl-sub">${esc(label)}</span></div>
      ${chartHtml(entries || [], ids, from, chartTo)}
    </div>`;

  bind(root);
}

function bind(root) {
  if (root.dataset.wlViewBound !== '1') {
    root.dataset.wlViewBound = '1';
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener(DATE_RANGE_EVENT, onRangeChange);
  }
  bindDateRangeFields(root);
}

function onRangeChange(e) {
  if (!e.target.closest('.wl-custom-range')) return;
  V.customFrom = e.detail.planStart || '';
  V.customTo = e.detail.planEnd || '';
  render(document.getElementById('view'));
}

async function onChange(e) {
  if (e.target.matches('[data-wl="group"]')) {
    V.groupId = e.target.value;
    render(document.getElementById('view'));
  } else if (e.target.matches('[data-wl="tag"]')) {
    V.tagId = e.target.value;
    render(document.getElementById('view'));
  }
}

async function onClick(e) {
  const chip = e.target.closest('[data-wl-chips]');
  if (chip) {
    const kind = chip.dataset.wlChips;
    const v = chip.dataset.v;
    if (kind === 'range') {
      V.range = v;
      if (v === 'custom' && !V.customFrom) {
        const now = new Date();
        const from = new Date(now); from.setDate(1);
        V.customFrom = dateKey(from);
        V.customTo = dateKey(now);
      }
    } else if (kind === 'scope') {
      V.scope = v;
      toast(v === 'all' ? '口径：仅主任务自身工时（不累积子任务）' : '口径：父任务含全部后代工时');
    }
    render(document.getElementById('view'));
    return;
  }

  const twist = e.target.closest('[data-wl-twist]');
  if (twist) {
    e.stopPropagation();
    const id = Number(twist.dataset.wlTwist);
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    render(document.getElementById('view'));
    return;
  }

  const run = e.target.closest('[data-wl-run]');
  if (run) {
    e.stopPropagation();
    const id = Number(run.dataset.wlRun);
    try {
      if (live.snap.mode !== 'idle' && Number(live.snap.taskId) === id) {
        if (live.snap.mode === 'running') await api.worklog.pause();
        else await api.worklog.resume();
      } else {
        await api.worklog.start({ taskId: id, source: 'timer' });
      }
    } catch (err) {
      toast((err && err.message) || '操作失败');
    }
    return;
  }

  if (e.target.closest('[data-wl="manual"]')) {
    manualAdd();
    return;
  }

  if (e.target.closest('[data-wl="export"]')) {
    try {
      const { from, to } = bounds();
      const r = await api.worklog.exportCsv({ from: from.toISOString(), to: to.toISOString() });
      if (r && r.ok) toast(`已导出 ${r.count} 条记录`);
      else if (r && r.reason && r.reason !== '已取消') toast(r.reason);
    } catch (err) {
      toast(`导出失败：${(err && err.message) || err}`);
    }
    return;
  }

  const row = e.target.closest('[data-wl-row]');
  if (row) openDetail(Number(row.dataset.wlRow));
}

/**
 * 补录（FR-04）：详情抽屉里不再有工时块，补录入口收在这里。
 * 任务用下拉选（全部未完成 + 不限分组），其余字段与原型一致的「日期 / 开始 / 结束 / 备注」。
 */
async function manualAdd() {
  let tasks = [];
  try {
    tasks = await api.tasks.list({ status: 'active', sort: 'due' });
  } catch (err) {
    toast(`读取任务列表失败：${(err && err.message) || err}`);
    return;
  }
  if (!tasks || !tasks.length) {
    toast('还没有任务，先建一条再补录');
    return;
  }
  const opts = tasks.map((t) => ({
    value: t.id,
    label: t.parent_id ? `　↳ ${t.title}` : t.title,
  }));
  const ok = await openFormModal({
    title: '补录工时',
    okText: '补录',
    grid: true,
    fields: [
      {
        name: 'taskId', label: '任务', type: 'select', options: opts, span: 2, value: tasks[0].id,
      },
      {
        name: 'date', label: '日期', value: dateKey(new Date()), placeholder: 'YYYY-MM-DD', span: 2, hint: '跨天按开始日归属',
      },
      { name: 'start', label: '开始', placeholder: '09:00' },
      { name: 'end', label: '结束', placeholder: '10:30' },
      {
        name: 'note', label: '备注', placeholder: '这段时间做了什么', span: 2,
      },
    ],
    onSubmit: async (v) => {
      try {
        await api.worklog.manualAdd({
          taskId: Number(v.taskId),
          date: v.date,
          start: v.start,
          end: v.end,
          note: v.note,
        });
        toast('已补录');
        return undefined;
      } catch (err) {
        return (err && err.message) || '补录失败';
      }
    },
  });
  if (ok) refresh();
}

/** 计时状态变化时重画。只认「当前 #view 里真的有工时工具栏」，避免误刷别的视图 */
export function refresh() {  const root = document.getElementById('view');
  if (!root || !root.querySelector('.wl-toolbar')) return;
  render(root);
}
