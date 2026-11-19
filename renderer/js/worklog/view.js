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
import { t as tr } from '../i18n.js';
import { openDetail } from '../detail.js';
import { flattenGroupTree } from '../group-tree.js';
import { openFormModal } from '../modal.js';
import { DATE_RANGE_EVENT, dateRangeFieldHtml, bindDateRangeFields } from '../controls.js';
import * as row from './row.js';
import { live, hm, esc, dateKey, fmtDay, fmtClock } from './shared.js';
import { money, rateText, openRateModal } from './pay.js';

/** 折线图的星期短名：中文「周一」对英文「Mon」，整句进词典（不要拿「周」+「一」拼） */
const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((s) => tr(s));

/* ------------------------------ 视图状态 ------------------------------ */

const V = {
  mode: 'time',      // time = 工时 | value = 价值（工时记薪）
  range: 'week',     // week | lastweek | month | custom
  scope: 'top',      // top = 含子任务 | all = 仅主任务
  groupId: '',       // '' = 全部分组
  tagId: '',         // '' = 全部标签
  customFrom: '',
  customTo: '',
};

const expanded = new Set();
const expandedPay = new Set(); // 价值视图里展开明细的任务 id
let groups = [];
let tags = [];
let lastRows = [];
let lastRoots = [];
let lastPay = null; // 最近一次 payRows 结果（金额列 / 明细回溯都吃这一份）
let lastBounds = null;

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
    return { from, to: thisMon, label: tr('上周') };
  }
  if (V.range === 'month') {
    const from = startOfDay(now); from.setDate(1);
    const to = new Date(now.getTime() + 60 * 1000);
    return { from, to, label: tr('本月') };
  }
  if (V.range === 'custom') {
    const from = V.customFrom ? startOfDay(new Date(`${V.customFrom}T00:00:00`)) : startOfDay(now);
    const toBase = V.customTo ? new Date(`${V.customTo}T00:00:00`) : now;
    const to = startOfDay(toBase); to.setDate(to.getDate() + 1);
    return { from, to, label: `${V.customFrom || '—'} ~ ${V.customTo || '—'}` };
  }
  const from = mondayOf(now);
  const to = new Date(now.getTime() + 60 * 1000);
  return { from, to, label: tr('本周') };
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
    ${chipGroup('mode', [['time', tr('工时')], ['value', tr('价值')]], V.mode)}
    <span class="wl-vmode-sep"></span>
    <span class="wl-tb-group"><span class="wl-tb-label">${tr('分组')}</span>
      <select class="wl-select" data-wl="group" aria-label="${tr('按分组筛选')}" title="${tr('按分组筛选')}">
        <option value="">${tr('全部分组')}</option>${groupOpts}
      </select>
    </span>
    <span class="wl-tb-group"><span class="wl-tb-label">${tr('标签')}</span>
      <select class="wl-select" data-wl="tag" aria-label="${tr('按标签筛选')}" title="${tr('按标签筛选')}">
        <option value="">${tr('全部标签')}</option>${tagOpts}
      </select>
    </span>
    <span class="wl-tb-group"><span class="wl-tb-label">${tr('范围')}</span>
      ${chipGroup('range', [['week', tr('本周')], ['lastweek', tr('上周')], ['month', tr('本月')], ['custom', tr('自定义')]], V.range)}
    </span>
    <span class="wl-tb-group"><span class="wl-tb-label">${tr('口径')}</span>
      ${chipGroup('scope', [['top', tr('含子任务')], ['all', tr('仅主任务')]], V.scope)}
    </span>
    <div class="wl-spacer"></div>
    <button type="button" class="wl-btn" data-wl="manual" title="${tr('补录一段没有计时的工时')}">＋ ${tr('补录')}</button>
    <button type="button" class="wl-btn" data-wl="export" title="${tr('导出当前范围与筛选的报工表（CSV）')}">${tr('导出')}</button>
  </div>
  ${V.range === 'custom' ? `<div class="wl-custom-range">
    ${dateRangeFieldHtml(V.customFrom, V.customTo, { placeholder: tr('选择自定义范围') })}
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
  const runLabel = active ? (live.snap.mode === 'paused' ? tr('已暂停') : tr('计时中')) : tr('开始');
  return `<tr class="wl-row${depth ? ' is-child' : ''}" data-wl-row="${node.id}">
    <td>
      <div class="wl-task-cell" style="padding-left:${indent}px">
        <button type="button" class="wl-twist${hasChild ? '' : ' is-ph'}" data-wl-twist="${node.id}" aria-label="${open ? tr('收起') : tr('展开')}${tr('子任务')}">${open ? '▾' : '▸'}</button>
        <span class="wl-t-title${depth ? ' is-sub' : ''}">${esc(node.title)}</span>
        ${depth ? `<span class="wl-t-group">· ${tr('子任务')}</span>` : (node.groupName ? `<span class="wl-t-group">· ${esc(node.groupName)}</span>` : '')}
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
      return { text: tr(WEEK_LABELS[d.getDay()]), isToday };
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

/* ------------------------------ 价值视图（工时记薪） ------------------------------ */

/** 金额一列靠右对齐时用的紧凑格式（¥8,420 / 带两位小数开关），统一走 pay.js 的 money */
function moneyCell(cents) {
  return `<span class="wl-money">${money(cents)}</span>`;
}

/**
 * 价值视图按任务聚合：金额是逐条记录的派生值，按 parent_id 成树后可以逐级上卷。
 * 顶层合计 = Σ 顶级子树金额（含子任务）；scope=all 时只用任务自身金额。
 * 与上层的工时视图同一范式：子任务行不参与顶部求和，避免重复计数。
 */
function buildPayTree(roots, pay) {
  const byTask = new Map();
  for (const r of pay.rows) {
    const id = Number(r.taskId);
    let agg = byTask.get(id);
    if (!agg) {
      agg = { amountCents: 0, ownSec: 0, ownCents: 0, cnt: 0, rows: [], children: [] };
      byTask.set(id, agg);
    }
    agg.amountCents += Number(r.amountCents) || 0;
    agg.ownSec += Number(r.durationSec) || 0;
    agg.cnt += 1;
    agg.rows.push(r);
  }
  // 把金额挂到已有的工时树上（树的形状仍以 aggregate 的 parent_id 为准）
  const decorate = (node) => {
    node.pay = byTask.get(Number(node.id)) || { amountCents: 0, ownSec: 0, ownCents: 0, cnt: 0, rows: [], children: [] };
    node.pay.ownCents = node.pay.amountCents; // 自身金额（子树尚未上卷前）
    node.children.forEach(decorate);
  };
  roots.forEach(decorate);
  // 子树上卷：从叶到根累加（后序遍历）
  const rollup = (node) => {
    let sub = node.pay ? node.pay.amountCents : 0;
    for (const c of node.children) sub += rollup(c);
    if (node.pay) node.pay.subtreeCents = sub;
    return sub;
  };
  roots.forEach(rollup);
  return byTask;
}

/** 价值视图汇总卡：折算价值 / 可计费时长 / 已排除时长 / 平均时薪 */
function valueCardsHtml(pay, label, days) {
  if (!pay.hasRates) {
    return `<div class="wl-pay-guide">
      <div class="wl-pay-guide-mark">¥</div>
      <div class="wl-pay-guide-body">
        <div class="wl-pay-guide-t">${tr('先设置你的时薪')}</div>
        <div class="wl-pay-guide-d">${tr('设置后，已记录的工时会按时薪估算成价值。这只是给自己看的估算，不是工资条；没有时薪前不会显示 ¥0.00。')}</div>
      </div>
      <button type="button" class="wl-btn is-accent" data-wl="rate">${tr('设置时薪')}</button>
    </div>`;
  }
  const excludedHm = hm(pay.excludedSec);
  return `<div class="wl-sum-grid">
    <div class="wl-sum-card is-accent" data-wl="rate" title="${tr('点击修改时薪')}">
      <div class="wl-k">${tr('折算价值 · 估算')}</div>
      <div class="wl-v num">${money(pay.totalCents)}</div>
      <div class="wl-s">${esc(label)} · ${tr('点击查看时薪')}</div>
    </div>
    <div class="wl-sum-card">
      <div class="wl-k">${tr('可计费时长')}</div>
      <div class="wl-v num">${hm(pay.billableSec)}</div>
      <div class="wl-s">${tr('按 {days} 个工作日 · {rows} 条记录', { days, rows: pay.rows.length })}</div>
    </div>
    <div class="wl-sum-card${pay.excludedSec > 0 ? ' is-excluded' : ''}"${pay.excludedSec > 0 ? ' data-wl="excluded"' : ''} title="${pay.excludedSec > 0 ? tr('点击查看被排除的记录') : ''}">
      <div class="wl-k">${tr('已排除')}</div>
      <div class="wl-v num">${excludedHm}</div>
      <div class="wl-s">${pay.excludedSec > 0 ? tr('标记为不计薪，金额记 0') : tr('没有不计薪的记录')}</div>
    </div>
    <div class="wl-sum-card" title="${tr('总价值 ÷ 可计费小时，按记录费率加权')}">
      <div class="wl-k">${tr('平均时薪')}</div>
      <div class="wl-v num">${pay.billableSec > 0 ? rateText(pay.avgRateCents) : '—'}</div>
      <div class="wl-s">${tr('按记录生效费率加权')}</div>
    </div>
  </div>`;
}

/** 单条明细记录行（明细回溯：日期 / 起止 / 时长 / 费率 / 金额 / 计薪开关） */
function payEntryRow(r) {
  const clock = r.startedAt && r.endedAt
    ? `${fmtClock(r.startedAt)}–${fmtClock(r.endedAt)}`
    : fmtClock(r.startedAt);
  const estimate = r.useEarliest ? `<span class="wl-pay-tag">${tr('按最早费率估算')}</span>` : '';
  return `<div class="wl-pay-entry${r.billable ? '' : ' is-excluded'}" data-pay-entry="${r.id}">
    <span class="wl-pe-day">${esc(r.localDay)}</span>
    <span class="wl-pe-clock">${esc(clock)}</span>
    <span class="wl-pe-sec num">${hm(r.durationSec)}</span>
    <span class="wl-pe-rate num">${r.rateCents ? rateText(r.rateCents) : '—'} ${estimate}</span>
    <span class="wl-pe-amt num">${money(r.amountCents)}</span>
    <button type="button" class="wl-pe-bill${r.billable ? ' is-on' : ''}" data-wl-billable="${r.id}"
      title="${r.billable ? tr('点击标为不计薪（金额归零，但时长仍显示）') : tr('点击恢复计薪')}">${r.billable ? tr('计薪') : tr('不计薪')}</button>
  </div>`;
}

/** 价值表格：任务 / 时长 / 金额 / 占比 / 明细。点金额行展开该任务（含子树）的记录 */
function valueRowHtml(node, depth, totalCents, maxCents) {
  const hasChild = node.children.length > 0;
  const open = expandedPay.has(node.id);
  const cents = V.scope === 'all' ? (node.pay ? node.pay.ownCents : 0) : (node.pay ? node.pay.subtreeCents : 0);
  const sec = V.scope === 'all' ? (node.pay ? node.pay.ownSec : 0) : 0;
  const pct = totalCents > 0 ? Math.round((cents / totalCents) * 100) : 0;
  const barPct = maxCents > 0 ? Math.max(1, Math.round((cents / maxCents) * 100)) : 0;
  const indent = depth * 22;

  // 收集该任务及其全部后代的记录用于明细回溯
  const collected = [];
  const collect = (n) => {
    if (n.pay && n.pay.rows) collected.push(...n.pay.rows);
    n.children.forEach(collect);
  };
  collect(node);
  collected.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  return `<tr class="wl-row${depth ? ' is-child' : ''}" data-wl-pay-row="${node.id}">
    <td>
      <div class="wl-task-cell" style="padding-left:${indent}px">
        <button type="button" class="wl-twist${hasChild ? '' : ' is-ph'}" data-wl-pay-twist="${node.id}" aria-label="${open ? tr('收起') : tr('展开')}${tr('子任务')}">${open ? '▾' : '▸'}</button>
        <span class="wl-t-title${depth ? ' is-sub' : ''}">${esc(node.title)}</span>
        ${depth ? `<span class="wl-t-group">· ${tr('子任务')}</span>` : (node.groupName ? `<span class="wl-t-group">· ${esc(node.groupName)}</span>` : '')}
      </div>
    </td>
    <td class="wl-r wl-mono is-muted">${V.scope === 'all' ? hm(sec) : '—'}</td>
    <td class="wl-r">${moneyCell(cents)}</td>
    <td>
      <div class="wl-bar-cell">
        <div class="wl-bar-track"><div class="wl-bar-fill${depth ? ' is-sub' : ''}" style="width:${barPct}%"></div></div>
        ${depth ? '' : `<span class="wl-mono is-muted wl-pct">${pct}%</span>`}
      </div>
    </td>
    <td class="wl-r"><button type="button" class="wl-mini-act${open ? ' is-open' : ''}" data-wl-pay-open="${node.id}" title="${tr('回溯到原始记录')}">${open ? tr('收起') : tr('明细')}</button></td>
  </tr>
  ${open && collected.length ? `<tr class="wl-pay-detail-row"><td colspan="5">
    <div class="wl-pay-detail">
      <div class="wl-pay-detail-head">${esc(node.title)} · ${tr('{n} 条记录 · 金额可逐级回溯到原始工时', { n: collected.length })}</div>
      ${collected.map(payEntryRow).join('')}
    </div>
  </td></tr>` : ''}`;
}

function valueTreeHtml(roots, totalCents, maxCents) {
  const out = [];
  const walk = (node, depth) => {
    out.push(valueRowHtml(node, depth, totalCents, maxCents));
    if (node.children.length && expandedPay.has(node.id)) {
      node.children.forEach((c) => walk(c, depth + 1));
    }
  };
  roots.forEach((r) => walk(r, 0));
  return out.join('');
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
  let pay = { hasRates: false, rows: [], totalCents: 0, billableSec: 0, excludedSec: 0, avgRateCents: 0 };
  // pay 单独容错：记薪是派生视图，它失败不能拖垮工时视图本身的 rows / 每日分布
  try {
    const [r, e] = await Promise.all([
      api.worklog.range(payload),
      api.worklog.rangeEntries(payload),
    ]);
    rows = r || [];
    entries = e || [];
  } catch (err) {
    toast(tr('加载工时失败：{msg}', { msg: (err && err.message) || err }));
  }
  try {
    pay = (await api.worklog.pay(payload)) || pay;
  } catch (err) {
    if (V.mode === 'value') toast(tr('加载价值估算失败：{msg}', { msg: (err && err.message) || err }));
  }
  lastRows = rows || [];
  lastPay = pay;
  lastBounds = { from, to, label, payload };

  const tree = buildTree(lastRows);
  const gset = groupSetOf(V.groupId);
  const tagName = V.tagId || '';
  const roots = filterTree(tree, gset, tagName).filter((r) => r.aggSec > 0 || r.children.some((c) => c.aggSec > 0));
  lastRoots = roots;

  // 价值视图：把逐条金额挂到同一棵工时树上，逐任务/分组上卷
  buildPayTree(roots, pay);
  const payTotalCents = pay.totalCents;
  const payMaxCents = Math.max(1, ...roots.map((r) => (r.pay ? r.pay.subtreeCents || 0 : 0)));

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

  const isValue = V.mode === 'value';
  const cardsHtml = isValue
    ? valueCardsHtml(pay, label, days)
    : `<div class="wl-sum-grid">
      <div class="wl-sum-card is-accent">
        <div class="wl-k">${tr('总工时')}</div>
        <div class="wl-v num">${hm(total)}</div>
        <div class="wl-s">${V.range === 'week' ? tr('周一 00:00 至今')
    : V.range === 'month' ? tr('本月 1 日至今')
      : V.range === 'lastweek' ? tr('上周一 ~ 本周一')
        : esc(label)}</div>
      </div>
      <div class="wl-sum-card">
        <div class="wl-k">${tr('日均')}</div>
        <div class="wl-v num">${hm(avg)}</div>
        <div class="wl-s">${tr('按 {days} 个工作日', { days })}</div>
      </div>
      <div class="wl-sum-card">
        <div class="wl-k">${tr('涉及任务')}</div>
        <div class="wl-v num">${ownTasks + subTasks}<small>${tr('项')}</small></div>
        <div class="wl-s">${tr('主任务 {own} · 子任务 {sub}', { own: ownTasks, sub: subTasks })}</div>
      </div>
      <div class="wl-sum-card">
        <div class="wl-k">${tr('最长单项')}</div>
        <div class="wl-v num">${longest ? hm(valueOf(longest)) : '0m'}</div>
        <div class="wl-s">${longest ? esc(longest.title) : '—'}</div>
      </div>
    </div>`;

  const tablePanel = isValue
    ? `<div class="wl-panel">
      <div class="wl-panel-head">
        <h3>${tr('按任务')}</h3>
        <span class="wl-sub">${tr('金额 = 逐条工时 × 生效费率，逐级相加可回溯')}</span>
        <div class="wl-spacer"></div>
        <span class="wl-sub wl-mono">${pay.hasRates ? money(payTotalCents) : '—'}</span>
      </div>
      <table class="wl-table">
        <thead><tr>
          <th>${tr('任务')}</th>
          <th class="wl-r" style="width:80px">${V.scope === 'all' ? tr('自身工时') : tr('工时')}</th>
          <th class="wl-r" style="width:112px">${tr('金额 · 估算')}</th>
          <th style="width:154px">${tr('占比')}</th>
          <th class="wl-r" style="width:70px"></th>
        </tr></thead>
        <tbody>${roots.length
    ? valueTreeHtml(roots, payTotalCents, payMaxCents)
    : `<tr><td colspan="5"><div class="wl-empty-view">${tr('本区间没有可计薪的工时。先给任务计时或补录，再回来看估算价值。')}</div></td></tr>`}</tbody>
      </table>
    </div>`
    : `<div class="wl-panel">
      <div class="wl-panel-head">
        <h3>${tr('按任务')}</h3>
        <span class="wl-sub">${tr('父任务合计 = 自身 + 全部后代，不重复计入')}</span>
        <div class="wl-spacer"></div>
        <span class="wl-sub wl-mono">${hm(total)}</span>
      </div>
      <table class="wl-table">
        <thead><tr>
          <th>${tr('任务')}</th>
          <th class="wl-r" style="width:88px">${tr('自身')}</th>
          <th class="wl-r" style="width:100px">${tr('含子任务')}</th>
          <th style="width:154px">${tr('占比')}</th>
          <th class="wl-r" style="width:76px"></th>
        </tr></thead>
        <tbody>${roots.length
    ? treeHtml(roots, total, maxSec)
    : `<tr><td colspan="5"><div class="wl-empty-view">${tr('本期还没有工时记录。把鼠标移到任意任务上，点「▶」开始计时，或点工具栏右侧的「＋ 补录」。')}</div></td></tr>`}</tbody>
      </table>
    </div>`;

  root.innerHTML = `
    ${toolbarHtml()}
    ${cardsHtml}
    ${tablePanel}
    <div class="wl-panel">
      <div class="wl-panel-head"><h3>${tr('每日分布')}</h3><div class="wl-spacer"></div><span class="wl-sub">${esc(label)}${isValue ? ` · ${tr('按工时')}` : ''}</span></div>
      ${chartHtml(entries || [], ids, from, chartTo)}
    </div>
    ${isValue ? `<div class="wl-pay-footnote">${tr('金额是按你设定的时薪做的估算，不代表实际收入；跨天工时按开始日归属，不计薪的记录金额记 0 但时长仍保留。')}</div>` : ''}`;

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
    if (kind === 'mode') {
      V.mode = v;
    } else if (kind === 'range') {
      V.range = v;
      if (v === 'custom' && !V.customFrom) {
        const now = new Date();
        const from = new Date(now); from.setDate(1);
        V.customFrom = dateKey(from);
        V.customTo = dateKey(now);
      }
    } else if (kind === 'scope') {
      V.scope = v;
      toast(v === 'all' ? tr('口径：仅主任务自身工时（不累积子任务）') : tr('口径：父任务含全部后代工时'));
    }
    render(document.getElementById('view'));
    return;
  }

  // 时薪设置（价值卡第一张 / 引导页按钮）
  if (e.target.closest('[data-wl="rate"]')) {
    await openRateModal(() => render(document.getElementById('view')));
    return;
  }
  // 「已排除」卡：展开全部含不计薪记录的任务明细
  if (e.target.closest('[data-wl="excluded"]')) {
    let shown = 0;
    for (const r of (lastPay && lastPay.rows) || []) {
      if (!r.billable) { expandedPay.add(Number(r.taskId)); shown += 1; }
    }
    toast(shown ? tr('已展开被排除的记录（{n} 条）', { n: shown }) : tr('没有不计薪的记录'));
    render(document.getElementById('view'));
    return;
  }

  // 价值视图：明细展开 / 子任务展开 / 计薪开关 —— 必须先于通用 row 点击处理
  const billBtn = e.target.closest('[data-wl-billable]');
  if (billBtn) {
    e.stopPropagation();
    const id = Number(billBtn.dataset.wlBillable);
    const rec = lastPay && lastPay.rows.find((r) => Number(r.id) === id);
    const next = rec ? !rec.billable : true;
    try {
      await api.worklog.entryBillable({ id, billable: next });
      // store 直写不发 worklog:changed：手动同步任务行摘要缓存，切回列表时才是最新
      row.refreshAll();
      toast(next ? tr('已恢复计薪') : tr('已标为不计薪：金额归零，时长仍保留'));
    } catch (err) {
      toast((err && err.message) || tr('操作失败'));
      return;
    }
    render(document.getElementById('view'));
    return;
  }

  const payOpen = e.target.closest('[data-wl-pay-open]');
  if (payOpen) {
    e.stopPropagation();
    const id = Number(payOpen.dataset.wlPayOpen);
    if (expandedPay.has(id)) expandedPay.delete(id); else expandedPay.add(id);
    render(document.getElementById('view'));
    return;
  }

  const payTwist = e.target.closest('[data-wl-pay-twist]');
  if (payTwist) {
    e.stopPropagation();
    const id = Number(payTwist.dataset.wlPayTwist);
    if (expandedPay.has(id)) expandedPay.delete(id); else expandedPay.add(id);
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
      toast((err && err.message) || tr('操作失败'));
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
      if (r && r.ok) toast(tr('已导出 {n} 条记录', { n: r.count }));
      else if (r && r.reason && r.reason !== '已取消') toast(r.reason);
    } catch (err) {
      toast(tr('导出失败：{msg}', { msg: (err && err.message) || err }));
    }
    return;
  }

  const row = e.target.closest('[data-wl-row]');
  if (row) { openDetail(Number(row.dataset.wlRow)); return; }
  const payRow = e.target.closest('[data-wl-pay-row]');
  if (payRow) openDetail(Number(payRow.dataset.wlPayRow));
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
    toast(tr('读取任务列表失败：{msg}', { msg: (err && err.message) || err }));
    return;
  }
  if (!tasks || !tasks.length) {
    toast(tr('还没有任务，先建一条再补录'));
    return;
  }
  const opts = tasks.map((t) => ({
    value: t.id,
    label: t.parent_id ? `　↳ ${t.title}` : t.title,
  }));
  const ok = await openFormModal({
    title: tr('补录工时'),
    okText: tr('补录'),
    grid: true,
    fields: [
      {
        name: 'taskId', label: tr('任务'), type: 'select', options: opts, span: 2, value: tasks[0].id,
      },
      {
        name: 'date', label: tr('日期'), value: dateKey(new Date()), placeholder: 'YYYY-MM-DD', span: 2, hint: tr('跨天按开始日归属'),
      },
      { name: 'start', label: tr('开始'), placeholder: '09:00' },
      { name: 'end', label: tr('结束'), placeholder: '10:30' },
      {
        name: 'note', label: tr('备注'), placeholder: tr('这段时间做了什么'), span: 2,
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
        toast(tr('已补录'));
        return undefined;
      } catch (err) {
        return (err && err.message) || tr('补录失败');
      }
    },
  });
  if (ok) { refresh(); row.refreshAll(); }
}

/** 计时状态变化时重画。只认「当前 #view 里真的有工时工具栏」，避免误刷别的视图 */
export function refresh() {  const root = document.getElementById('view');
  if (!root || !root.querySelector('.wl-toolbar')) return;
  render(root);
}
