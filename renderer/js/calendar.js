'use strict';
/**
 * 日历视图（月 / 周）—— 格子回答的不是「有什么」，是「排得下吗」。
 *
 * 设计依据：《任务日历视图设计方案 v2》+ 设计稿「01 · LOAD, NOT LIST」。
 * 三条硬约束：plan_start / plan_end 只有年月日（不做时间轴）；priority 0–3 复用 PRIORITY_COLOR；
 * 没有预估时长（负载用优先级加权）。因此不做任何数据库迁移，只复用 tasks.plan_* 与 settings。
 *
 * 关键约定：
 *  - 日期一律字符串比较（YYYY-MM-DD）；日期运算走 Date.UTC，避免本地时区 / 夏令时错一天。
 *  - #view 是共享容器，事件委托只绑一次；重绘只换局部 DOM，点击格子不跳页、不滚动。
 *  - 视觉资源全部是 CSS 图形 + 字符图标（‹ › ↳ ⚠ ⚑），与设计方案的截图一致，不引入位图。
 */
import { api, PRIORITY_COLOR, PRIORITY_TEXT } from './api.js';
import { state, todayStr, noteCompletionChange } from './store.js';
import { openContextMenu, closeContextMenu } from './ctx-menu.js';
import { openPanelModal } from './modal.js';

/* ---------------- 常量与纯函数 ---------------- */

/** priority 0–3 的负载权重（低 0.5 / 中 1 / 高 2 / 紧急 3） */
const WEIGHT = [0.5, 1, 2, 3];
const DEFAULT_PREFS = {
  // hideCompleted 是 showCompleted 的反向语义：已完成任务**默认就要看得见**（用户明确要求
  // 「今天勾掉、第二天别消失」），老库里存的 showCompleted: false 因此自动失效，无需迁移。
  capacity: 6, weekStart: 1, hideCompleted: false, view: 'month', seenHint: false,
};
const WEEK_MON = ['一', '二', '三', '四', '五', '六', '日'];
const WEEK_SUN = ['日', '一', '二', '三', '四', '五', '六'];
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
/** 任务卡底色：与设计稿取样一致（淡灰 / 淡蓝 / 淡黄 / 淡粉） */
const PRIORITY_SOFT = ['#f7f7fa', '#f4f7ff', '#fdf6ec', '#fef7f7'];
const DAY_MS = 86400000;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const p2 = (n) => String(n).padStart(2, '0');
const fmtLoad = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? String(c) : '');

function parseDay(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}
function dateToStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
function addDays(s, n) { return dateToStr(parseDay(s) + n * DAY_MS); }
function diffDays(a, b) { return Math.round((parseDay(b) - parseDay(a)) / DAY_MS); }
function monthStart(s) { return `${s.slice(0, 7)}-01`; }
function addMonths(s, n) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7)) - 1 + n;
  return dateToStr(Date.UTC(y, m, 1));
}
function daysInMonth(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function monthDates(s) {
  const n = daysInMonth(s);
  const out = [];
  for (let i = 1; i <= n; i += 1) out.push(`${s.slice(0, 7)}-${p2(i)}`);
  return out;
}
function weekdayIndex(s, weekStart) {
  return (new Date(parseDay(s)).getUTCDay() - weekStart + 7) % 7;
}
function weekStartOf(s, weekStart) { return addDays(s, -weekdayIndex(s, weekStart)); }
function weekName(s) { return `周${WEEK_CN[new Date(parseDay(s)).getUTCDay()]}`; }
function monthLabel(s) { return `${Number(s.slice(0, 4))} 年 ${Number(s.slice(5, 7))} 月`; }
function dateLabel(s) { return `${Number(s.slice(5, 7))} 月 ${Number(s.slice(8))} 日`; }

/** 日期归属规则（方案 6.2）：两个日期都有 = 跨天；只有一个 = 当天；都没有 = 待安排池 */
function taskRange(t) {
  const s = t.plan_start || '';
  const e = t.plan_end || '';
  if (s && e) return e >= s ? [s, e] : [e, s];
  if (s) return [s, s];
  if (e) return [e, e];
  return null;
}
function taskSpan(t) {
  const r = taskRange(t);
  return r ? clamp(diffDays(r[0], r[1]) + 1, 1, 400) : 1;
}
const isOverdue = (t, today) => !!t.plan_end && t.plan_end < today && !t.completed && !t.archived;
/**
 * 历史日期（早于今天）→ 完成态只读。
 *
 * 日历回答的是「这天排得下吗」，不是「补勾昨天的卡」。在昨天的格子里点勾会真的改掉已发生的事：
 * 一次性任务被挪去「当天」再勾，跨天任务的收尾日被改成历史日；重复事项更直接——
 * 勾一下就是在 recurrence_completions 里删掉那天的打卡记录。这类改动用户在日历上看不出后果，
 * 却会污染负载曲线与习惯统计，所以过去的格子一律不给勾。
 * 要改历史请去任务列表 / 详情，或「重复事项」里的打卡日历（那里是本意上的编辑入口）。
 */
const isPastDay = (day) => !!day && day < todayStr();
const LOCK_HINT = '历史日期只读：完成状态请在「今天」或任务列表里改';
const priorityOf = (t) => clamp(Number(t.priority) || 0, 0, 3);
const weightOf = (t) => WEIGHT[priorityOf(t)];

/** 撤销条只有一行宽：长标题会把它撑爆，截到 12 字 */
function clipTitle(s) {
  const v = String(s || '未命名任务').trim();
  return v.length > 12 ? `${v.slice(0, 12)}…` : v;
}

/** 超载四形态（方案 3.3）：颜色 + 形态双编码，色弱也能分辨 */
function loadStateOf(load, cap) {
  const rate = cap > 0 ? load / cap : 0;
  if (rate <= 0) return { cls: 'is-empty', pct: 0, rate, label: '空闲' };
  if (rate < 0.6) return { cls: 'is-room', pct: rate * 100, rate, label: '有余量' };
  if (rate < 1) return { cls: 'is-near', pct: rate * 100, rate, label: '接近满' };
  if (rate <= 1.4) return { cls: 'is-over', pct: 100, rate, label: '超载' };
  return { cls: 'is-critical', pct: 100, rate, label: '严重超载' };
}

/* ---------------- 模块状态 ---------------- */

const ext = {
  toast: () => {}, render: () => {}, renderSidebar: () => {}, refresh: () => {}, openTaskDetail: () => {},
};
export function setCalendarHandlers(h = {}) {
  Object.keys(ext).forEach((k) => { if (typeof h[k] === 'function') ext[k] = h[k]; });
}

const cfg = {
  mode: 'month',              // month | week
  anchor: todayStr(),         // 当前月 / 周内的任一日期
  selected: todayStr(),       // 当日面板选中的日期
  showPanel: true,
  showBacklog: false,
  prefs: { ...DEFAULT_PREFS },
  serverPrefs: {},
  tasks: [],
  completions: [],           // 重复事项的历史打卡（rule_id / occurrence_date / 任务展示字段）
  byDate: new Map(),
  pool: [],
  overdue: [],
  drag: null,
  previewDate: '',
  previewHost: null,
  previewPredicted: null,
  edgeTimer: null,
  edgeDir: 0,
  undo: null,
  undoTimer: null,
  introHidden: false,
};
let boundRoot = null;

const cellData = (d) => cfg.byDate.get(d) || { load: 0, tasks: [] };

/* ---------------- 数据层 ---------------- */

async function loadData() {
  let prefs = null;
  try { prefs = await api.ui.getToolPref('calendar'); } catch (e) { /* 库未就绪时按默认值 */ }
  cfg.serverPrefs = prefs && typeof prefs === 'object' ? { ...prefs } : {};
  // 旧字段（showCompleted）已换成反向语义 hideCompleted：直接丢掉，老用户默认就是"显示"
  delete cfg.serverPrefs.showCompleted;
  cfg.prefs = { ...DEFAULT_PREFS, ...cfg.serverPrefs };
  cfg.prefs.capacity = clamp(Number(cfg.prefs.capacity) || 6, 4, 10);
  cfg.prefs.weekStart = Number(cfg.prefs.weekStart) === 0 ? 0 : 1;
  let tasks = [];
  try { tasks = await api.tasks.list({ status: 'any' }); } catch (e) {
    ext.toast(`读取任务失败：${(e && e.message) || e}`);
  }
  cfg.tasks = Array.isArray(tasks) ? tasks : [];
  // 重复事项的打卡历史：一条重复事项只有一行任务，跨天会被推到下一次发生日，
  // 历史「那天做完了」只留在 recurrence_completions 里，必须单独取回来回填日历。
  let comps = [];
  try { comps = await api.recurrences.completionsAll({}); } catch (e) { /* 无重复事项 / 旧库降级为空 */ }
  cfg.completions = Array.isArray(comps) ? comps : [];
  buildIndex();
}

async function savePrefs(patch) {
  cfg.prefs = { ...cfg.prefs, ...patch };
  const next = { ...cfg.serverPrefs, ...cfg.prefs, ...patch };
  cfg.serverPrefs = next;
  try { await api.ui.setToolPref('calendar', next); } catch (e) { /* 只读环境不阻断使用 */ }
}

/** 历史打卡 → 可渲染的实例（只用于日历展示，不写库；日期就是发生日） */
function occurrenceTask(c, day) {
  return {
    id: Number(c.task_id),
    title: c.title,
    priority: c.priority,
    group_name: c.group_name,
    group_color: c.group_color,
    completed: 1,
    completed_at: c.completed_at,
    recurring_id: Number(c.rule_id),
    occurrence_date: day,
    plan_start: day,
    plan_end: day,
    occ: day,                                  // 标记「历史打卡实例」，交互走 setCompletion
  };
}

/** 构建「日期 → 负载 / 任务」索引。超期任务不散落到过去日期，只汇总到今天的积压行 */
function buildIndex() {
  const today = todayStr();
  cfg.byDate = new Map();
  cfg.pool = [];
  cfg.overdue = [];
  const covered = new Set();                   // 任务行自己占住的「任务 + 发生日」，避免打卡再画一遍
  const ensure = (d) => {
    if (!cfg.byDate.has(d)) cfg.byDate.set(d, { load: 0, tasks: [] });
    return cfg.byDate.get(d);
  };
  for (const t of cfg.tasks) {
    if (t.archived) continue;                                  // 归档任务任何情况下都不出现
    if (t.parent_id != null) continue;                         // 子任务跟随父任务
    if (t.completed && cfg.prefs.hideCompleted) continue;      // 仅在用户主动勾了「隐藏」时才藏
    const range = taskRange(t);
    if (!range) {
      // 已完成且没有排期的任务无处落格；放待安排池只会污染排期区（它已经在「已完成」列表里）
      if (!t.completed) cfg.pool.push(t);
      continue;
    }
    if (isOverdue(t, today)) { cfg.overdue.push(t); continue; } // 欠账停在今天
    if (t.recurring_id != null && t.occurrence_date) covered.add(`${t.id}|${t.occurrence_date}`);
    const [start, end] = range;
    const span = clamp(diffDays(start, end) + 1, 1, 400);
    const perDay = weightOf(t) / span;                         // 跨天任务负载均摊
    let d = start;
    for (let i = 0; i < span && d <= end; i += 1) {            // 字符串比较，不转 Date
      const cell = ensure(d);
      if (!t.completed) cell.load += perDay;                   // 已完成不计入负载
      cell.tasks.push({ task: t, continuation: d !== start, perDay });
      d = addDays(d, 1);
    }
  }
  // 历史打卡回填：重复事项只有一行任务，跨天会被推到下一次发生日，那一天做过的记录
  // 只存在于 recurrence_completions —— 不回填就等于「昨天明明做完了，日历上却没痕迹」。
  if (!cfg.prefs.hideCompleted) {
    for (const c of cfg.completions) {
      if (c.archived) continue;
      const day = String(c.occurrence_date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (covered.has(`${c.task_id}|${day}`)) continue;        // 当前这一次已经画过了
      ensure(day).tasks.push({ task: occurrenceTask(c, day), continuation: false, perDay: 0, occ: day });
    }
  }
  const byPriority = (a, b) => priorityOf(b) - priorityOf(a)
    || String(a.plan_end || '').localeCompare(String(b.plan_end || ''))
    || String(a.title || '').localeCompare(String(b.title || ''));
  cfg.pool.sort(byPriority);
  cfg.overdue.sort((a, b) => String(a.plan_end).localeCompare(String(b.plan_end)) || byPriority(a, b));
  for (const cell of cfg.byDate.values()) {
    cell.tasks.sort(byPriorityEntry);
    cell.load = Math.round(cell.load * 100) / 100;
  }
}
function byPriorityEntry(a, b) {
  return priorityOf(b.task) - priorityOf(a.task)
    || Number(a.task.completed) - Number(b.task.completed)
    || String(a.task.title || '').localeCompare(String(b.task.title || ''));
}

/* ---------------- 渲染：骨架 ---------------- */

function shellHtml() {
  return `<div class="cal-wrap" data-mode="month">
    <div class="cal-intro" ${cfg.introHidden ? 'hidden' : ''}>
      <div class="cal-intro-tag">01 · LOAD, NOT LIST</div>
      <div class="cal-intro-title">格子回答的不是「有什么」，是「排得下吗」</div>
      <div class="cal-intro-sub">负载 = Σ 优先级权重（低 0.5 / 中 1 / 高 2 / 紧急 3），容量默认 6。一屏扫过去看到的是「周三爆了、周五空着」。</div>
      <button class="cal-intro-close" data-cal-act="intro-close" title="不再显示">✕</button>
    </div>
    <div class="cal-layout">
      <aside class="cal-left"></aside>
      <section class="cal-main">
        <div class="cal-card cal-board">
          <header class="cal-head">
            <div class="cal-nav">
              <button type="button" class="cal-arrow" data-cal-nav="prev" title="上一个月 / 上一周">‹</button>
              <span class="cal-month"></span>
              <button type="button" class="cal-arrow" data-cal-nav="next" title="下一个月 / 下一周">›</button>
            </div>
            <div class="cal-head-right">
              <button type="button" class="cal-today" data-cal-nav="today">回到今天</button>
              <div class="cal-seg">
                <button type="button" data-cal-view="month">月</button>
                <button type="button" data-cal-view="week">周</button>
              </div>
            </div>
          </header>
          <div class="cal-body"></div>
          <div class="cal-empty" hidden>
            <span class="cal-empty-arrow">↖</span>
            从待安排池拖一个进来
          </div>
        </div>
        <div class="cal-legend-slot"></div>
        <div class="cal-trend-slot"></div>
        <div class="cal-stats-slot"></div>
      </section>
      <div class="cal-right-slot"></div>
    </div>
    <div class="cal-undo" hidden></div>
  </div>`;
}

/* ---------------- 长标题浮层 ---------------- */

let tipEl = null;
let tipHost = null;

function tipNode() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'cal-hover-tip';
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function hideTitleTip() {
  if (tipEl) tipEl.hidden = true;
  tipHost = null;
}

let probeEl = null;
/** -webkit-line-clamp 下 scrollHeight 不反映被裁掉的行，必须用同宽离屏探子量全文高度 */
function isTitleElided(el) {
  if (el.scrollWidth > el.clientWidth + 1) return true;
  const cs = window.getComputedStyle(el);
  if (!probeEl) {
    probeEl = document.createElement('span');
    probeEl.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;'
      + 'box-sizing:border-box;display:block;padding:0;border:0;white-space:normal;overflow:visible;';
  }
  probeEl.style.width = `${el.clientWidth}px`;
  probeEl.style.font = cs.font;
  probeEl.style.fontSize = cs.fontSize;
  probeEl.style.fontFamily = cs.fontFamily;
  probeEl.style.fontWeight = cs.fontWeight;
  probeEl.style.lineHeight = cs.lineHeight;
  probeEl.style.letterSpacing = cs.letterSpacing;
  probeEl.style.wordBreak = cs.wordBreak;
  probeEl.style.overflowWrap = cs.overflowWrap;
  probeEl.textContent = el.textContent;
  document.body.appendChild(probeEl);
  const full = probeEl.getBoundingClientRect().height;
  probeEl.remove();
  return full > el.clientHeight + 2;
}

/**
 * 只在标题确实被裁掉时弹：短名字不打扰，长名字悬停即见全称。
 * 浮层挂 body 而非格内 —— .cal-cell / .cal-task 都是 overflow:hidden，
 * 绝对定位在里面的气泡会被直接裁掉。
 */
function onTitleHover(e) {
  if (!(e.target instanceof Element)) return;
  const label = e.target.closest('.cal-task-title, .cal-pool-title, .cal-panel-title, .cal-backlog-title');
  if (!label) return;
  const host = label.closest('[data-task-id]');
  if (!host) return;
  const tip = tipNode();
  if (tipHost === host) return;                 // 同一条不重复测量，也避免拖动时抖动
  tipHost = host;
  if (cfg.drag) { tip.hidden = true; return; }  // 拖拽中不弹
  const elided = isTitleElided(label);
  const occ = host.dataset.occ || '';
  const t = cfg.tasks.find((x) => x.id === Number(host.dataset.taskId));
  if (!elided || !t) { tip.hidden = true; return; }
  const pri = priorityOf(t);
  const range = taskRange(t);
  const when = range ? (range[0] === range[1] ? range[0] : `${range[0]} → ${range[1]}`) : '待安排';
  const priBit = `<span class="cal-tip-dot" style="background:${PRIORITY_COLOR[pri]}"></span>${PRIORITY_TEXT[pri]}`;
  // 历史打卡格子：日期说的是「那一天」，不是任务行现在被滚到的下一次
  const bits = occ
    ? [
      priBit,
      t.group_name ? esc(t.group_name) : '',
      `${esc(occ)} 已完成`,
      '重复事项打卡',
    ].filter(Boolean)
    : [
      priBit,
      t.group_name ? esc(t.group_name) : '',
      esc(when),
      Number(t.subtask_count) ? `${Number(t.subtask_count)} 个子任务` : '',
      host.classList.contains('is-cont') ? '跨天延续' : '',
      t.completed ? '已完成' : '',
      isOverdue(t, todayStr()) ? '<span class="cal-tip-bad">已超期</span>' : '',
    ].filter(Boolean);
  const canOpen = host.matches('.cal-task, .cal-pool-item');
  tip.innerHTML = `<div class="cal-tip-title">${esc(t.title || '未命名任务')}</div>
    <div class="cal-tip-meta">${bits.join('<i>·</i>')}</div>
    ${canOpen ? '<div class="cal-tip-hint">双击打开详情</div>' : ''}`;
  tip.hidden = false;
  const r = label.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = clamp(r.left, 8, Math.max(8, window.innerWidth - w - 8));
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function onTitleHoverOut(e) {
  if (!(e.target instanceof Element)) return;
  const label = e.target.closest('.cal-task-title, .cal-pool-title, .cal-panel-title, .cal-backlog-title');
  if (!label) return;
  if (e.relatedTarget instanceof Node && label.contains(e.relatedTarget)) return;
  hideTitleTip();
}

/* ---------------- 渲染：组件 ---------------- */

function loadBarHtml(load, cap) {
  const st = loadStateOf(load, cap);
  const num = st.rate >= 1 ? `<span class="cal-load-num">${fmtLoad(load)}/${cap}</span>` : '';
  const overflow = st.cls === 'is-over' ? '<span class="cal-load-overflow"></span>' : '';
  const bang = st.cls === 'is-critical' ? '<span class="cal-load-bang">!</span>' : '';
  return `<div class="cal-load ${st.cls}" title="负载 ${fmtLoad(load)} / ${cap} · ${st.label}">
    <span class="cal-load-fill" style="width:${st.pct.toFixed(1)}%"></span>
    ${overflow}${num}${bang}
  </div>`;
}

function taskCardHtml(entry, opts = {}) {
  const t = entry.task;
  const pri = priorityOf(t);
  const late = isOverdue(t, todayStr());
  const occ = entry.occ || '';
  const day = opts.day || '';
  const locked = isPastDay(day);
  const cls = [
    'cal-task', `p${pri}`,
    t.completed ? 'is-done' : '',
    occ ? 'is-occ' : '',
    entry.continuation ? 'is-cont' : '',
    late ? 'is-late' : '',
    opts.week ? 'is-wide' : '',
  ].filter(Boolean).join(' ');
  // 已完成条目不能再拖（拖了会改掉历史那天的排期，语义是错的）
  const check = `<button type="button" class="cal-check${t.completed ? ' is-checked' : ''}${locked ? ' is-locked' : ''}" data-cal-act="toggle"
    data-task-id="${t.id}"${occ ? ` data-occ="${occ}"` : ''}${day ? ` data-cal-day="${day}"` : ''}${locked ? ' aria-disabled="true"' : ''}
    title="${locked ? LOCK_HINT : (t.completed ? '取消完成' : '标记完成')}">${t.completed ? '✓' : ''}</button>`;
  const flag = pri === 3 ? '<span class="cal-flag" title="紧急">⚑</span>' : '';
  const dot = safeColor(t.group_color) ? `<span class="cal-gdot" style="background:${safeColor(t.group_color)}" title="${esc(t.group_name || '')}"></span>` : '';
  // 月视图格子只有 ~65px：长串「含 N 个子任务」会把标题挤到只剩一个字，只留 +N 角标。
  // 完整标题 / 子任务数交给悬停浮层与右栏面板承载。
  const kids = Number(t.subtask_count || 0)
    ? `<span class="cal-kids" aria-label="${Number(t.subtask_count)} 个子任务">+${Number(t.subtask_count)}</span>` : '';
  const lateDot = late ? '<span class="cal-late-dot" title="已超期"></span>' : '';
  // 跨天延续的格子里照样显示任务标题：只写「续」等于白占一个卡片位，看不出在做什么
  const title = esc(t.title || '未命名任务');
  return `<div class="${cls}" draggable="${t.completed ? 'false' : 'true'}" data-task-id="${t.id}" data-priority="${pri}"${occ ? ` data-occ="${occ}"` : ''}
    style="--cal-pri:${PRIORITY_COLOR[pri]};--cal-soft:${PRIORITY_SOFT[pri]}">
    <span class="cal-task-bar"></span>${check}
    ${entry.continuation ? '<span class="cal-cont-mark">↳</span>' : ''}
    <span class="cal-task-title">${title}</span>
    ${flag}${lateDot}${dot}${kids}
  </div>`;
}

function poolCardHtml() {
  const items = cfg.pool.slice(0, 20).map((t) => {
    const pri = priorityOf(t);
    return `<div class="cal-pool-item" draggable="true" data-task-id="${t.id}"
      style="--cal-pri:${PRIORITY_COLOR[pri]}">
      <span class="cal-pool-bar"></span>
      <span class="cal-pool-title">${esc(t.title || '未命名任务')}</span>
      ${isOverdue(t, todayStr()) ? '<span class="cal-late-dot" title="已超期"></span>' : ''}
    </div>`;
  }).join('');
  return `<section class="cal-card cal-pool" data-dropzone="pool">
    <div class="cal-card-head"><span class="cal-card-title">待安排</span><span class="cal-card-count">${cfg.pool.length}</span></div>
    <div class="cal-card-sub">拖到日历上排期</div>
    <div class="cal-pool-list">${items || '<div class="cal-pool-empty">暂无未排期任务</div>'}</div>
    ${cfg.pool.length > 20 ? `<div class="cal-pool-more">还有 ${cfg.pool.length - 20} 条…</div>` : ''}
  </section>`;
}

function howCardHtml() {
  const rows = [3, 2, 1, 0].map((p) => `<div class="cal-weight-row">
    <span class="cal-weight-sq" style="background:${PRIORITY_COLOR[p]}"></span>
    <span>${PRIORITY_TEXT[p]}</span><b>${WEIGHT[p]}</b>
  </div>`).join('');
  return `<section class="cal-card cal-how">
    <div class="cal-card-title">负载怎么算</div>
    <div class="cal-card-sub">按优先级权重累加，不用填工时</div>
    <div class="cal-weight-list">${rows}</div>
    <div class="cal-how-note">容量默认 ${cfg.prefs.capacity} —— 意思是这天能扛几个中等任务。界面上只说「6.5 / 6」，不出现「权重」二字。</div>
  </section>`;
}

function previewCardHtml() {
  return `<section class="cal-card cal-preview-card">
    <div class="cal-card-title">放下之前就看到后果</div>
    <div class="cal-card-sub">拖到已满的日子上，目标格负载条实时变化，并浮出提示。松手前就能改主意。</div>
    <div class="cal-preview-box">
      <div class="cal-preview-line">周四 <b>7 / 6</b> · <span class="is-bad">将超载 117%</span></div>
      <div class="cal-preview-track"><span style="width:100%"></span></div>
    </div>
  </section>`;
}

function weekdaysHtml() {
  const labels = cfg.prefs.weekStart === 1 ? WEEK_MON : WEEK_SUN;
  return `<div class="cal-weekdays">${labels.map((w) => `<span>${w}</span>`).join('')}</div>`;
}

function backlogRowHtml(n, earliest) {
  return `<button type="button" class="cal-backlog" data-cal-act="overdue">
    ⚠ 积压 ${n} 条${earliest ? `（最早 ${earliest.slice(5).replace('-', '-')}）` : ''}
  </button>`;
}

function monthGridHtml() {
  const first = monthStart(cfg.anchor);
  const offset = weekdayIndex(first, cfg.prefs.weekStart);
  const gridStart = addDays(first, -offset);
  const weeks = Math.ceil((offset + daysInMonth(first)) / 7);
  const today = todayStr();
  const earliest = cfg.overdue.length ? cfg.overdue[0].plan_end : '';
  let html = '';
  for (let i = 0; i < weeks * 7; i += 1) {
    const d = addDays(gridStart, i);
    const inMonth = d.slice(0, 7) === first.slice(0, 7);
    const cell = cellData(d);
    const st = loadStateOf(cell.load, cfg.prefs.capacity);
    const classes = [
      'cal-cell',
      inMonth ? '' : 'is-other',
      d === today ? 'is-today' : '',
      d < today ? 'is-past' : '',
      cfg.selected === d ? 'is-selected' : '',
      st.rate >= 1 ? 'is-alert' : '',
      st.cls === 'is-critical' ? 'is-critical' : '',
    ].filter(Boolean).join(' ');
    const cards = cell.tasks.slice(0, 2).map((e) => taskCardHtml(e, { day: d })).join('');
    const more = cell.tasks.length > 2
      ? `<button type="button" class="cal-more" data-cal-act="more" data-date="${d}">+${cell.tasks.length - 2}</button>` : '';
    const badge = d === today && cfg.overdue.length
      ? `<span class="cal-badge" title="超期积压 ${cfg.overdue.length} 条">${cfg.overdue.length}</span>` : '';
    const backlog = d === today && cfg.overdue.length ? backlogRowHtml(cfg.overdue.length, earliest) : '';
    html += `<div class="${classes}" data-date="${d}" data-load="${cell.load}">
      <div class="cal-cell-top">
        <span class="cal-daynum">${Number(d.slice(8))}</span>
        ${d === today ? '<span class="cal-today-txt">今天</span>' : ''}${badge}
      </div>
      ${loadBarHtml(cell.load, cfg.prefs.capacity)}
      <div class="cal-cards">${cards}${more}</div>
      ${backlog}
    </div>`;
  }
  return `<div class="cal-grid" style="--cal-rows:${weeks}">${html}</div>`;
}

function weekGridHtml() {
  const today = todayStr();
  const start = weekStartOf(cfg.anchor, cfg.prefs.weekStart);
  const labels = cfg.prefs.weekStart === 1 ? WEEK_MON : WEEK_SUN;
  const earliest = cfg.overdue.length ? cfg.overdue[0].plan_end : '';
  let html = '<div class="cal-week">';
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(start, i);
    const cell = cellData(d);
    const st = loadStateOf(cell.load, cfg.prefs.capacity);
    const cards = cell.tasks.map((e) => taskCardHtml(e, { week: true, day: d })).join('')
      || '<div class="cal-week-empty">—</div>';
    html += `<div class="cal-week-col ${d === today ? 'is-today' : ''} ${cfg.selected === d ? 'is-selected' : ''} ${st.rate >= 1 ? 'is-alert' : ''}"
      data-date="${d}" data-load="${cell.load}">
      <div class="cal-week-head">
        <span>周${labels[i]} · ${d.slice(5).replace('-', '/')}</span>
        <b>${fmtLoad(cell.load)} / ${cfg.prefs.capacity}</b>
      </div>
      ${loadBarHtml(cell.load, cfg.prefs.capacity)}
      <div class="cal-week-cards">${cards}</div>
      ${d === today && cfg.overdue.length ? backlogRowHtml(cfg.overdue.length, earliest) : ''}
    </div>`;
  }
  return `${html}</div>`;
}

function legendHtml() {
  return `<div class="cal-card cal-legend">
    <div class="cal-legend-items">
      <span><i class="cal-lg is-over"></i>超载 ≥100%</span>
      <span><i class="cal-lg is-near"></i>接近满</span>
      <span><i class="cal-lg is-room"></i>有余量</span>
      <span><i class="cal-lg is-empty"></i>空闲</span>
    </div>
    <span class="cal-legend-note">超载另有边框与溢出块 —— 不只靠颜色</span>
  </div>`;
}

function monthStats() {
  const days = monthDates(cfg.anchor);
  const cap = cfg.prefs.capacity;
  let active = 0; let over = 0; let sum = 0;
  days.forEach((d) => {
    const c = cellData(d);
    if (c.load > 0) active += 1;
    if (loadStateOf(c.load, cap).rate >= 1) over += 1;
    sum += c.load;
  });
  return { days, active, over, avg: Math.round((sum / days.length / cap) * 100) };
}

function trendHtml() {
  const { days } = monthStats();
  const cap = cfg.prefs.capacity;
  const bars = days.map((d) => {
    const load = cellData(d).load;
    const st = loadStateOf(load, cap);
    return `<span class="cal-trend-bar ${st.cls}" style="height:${Math.max(8, Math.min(100, st.rate * 100))}%"
      title="${d} · ${fmtLoad(load)} / ${cap}"></span>`;
  }).join('');
  return `<div class="cal-trend"><span class="cal-trend-label">整月负载趋势</span>
    <div class="cal-trend-bars">${bars}</div></div>`;
}

function statsHtml() {
  const { active, over, avg } = monthStats();
  return `<div class="cal-stats">
    <span>本月 ${active} 天有安排 · ${over} 天超载 · 平均负载 ${avg}%</span>
    <button type="button" data-cal-act="capacity">调整每日容量</button>
  </div>`;
}

function backlogListHtml() {
  const today = todayStr();
  const rows = cfg.overdue.slice(0, 30).map((t) => {
    const days = Math.max(1, diffDays(t.plan_end, today));
    return `<div class="cal-backlog-row" data-task-id="${t.id}">
      <span class="cal-backlog-dot" style="background:${PRIORITY_COLOR[priorityOf(t)]}"></span>
      <span class="cal-backlog-title">${esc(t.title || '未命名任务')}</span>
      <span class="cal-backlog-days" title="${t.plan_end}">已超期 ${days} 天</span>
      <button type="button" data-cal-act="backlog-one" data-task-id="${t.id}">改到今天</button>
    </div>`;
  }).join('');
  return `<div class="cal-panel-backlog">
    <div class="cal-panel-sec-title">超期积压（${cfg.overdue.length}）
      <button type="button" data-cal-act="backlog-all">全部改到今天</button>
    </div>
    ${rows}
    ${cfg.overdue.length > 30 ? '<div class="cal-backlog-more">只显示最早 30 条</div>' : ''}
  </div>`;
}

function panelRowHtml(entry, day) {
  const t = entry.task;
  const pri = priorityOf(t);
  const occ = entry.occ || '';
  const locked = isPastDay(day);
  const opts = [3, 2, 1, 0].map((p) => `<option value="${p}"${p === pri ? ' selected' : ''}>${PRIORITY_TEXT[p]}</option>`).join('');
  const metaTail = occ
    ? '<span class="cal-occ-tag" title="重复事项在这一天的打卡记录">已完成 · 重复打卡</span>'
    : (isOverdue(t, todayStr()) ? '<span class="is-bad">已超期</span>' : PRIORITY_TEXT[pri]);
  return `<div class="cal-panel-row ${t.completed ? 'is-done' : ''}" data-task-id="${t.id}"${occ ? ` data-occ="${occ}"` : ''}>
    <button type="button" class="cal-check${t.completed ? ' is-checked' : ''}${locked ? ' is-locked' : ''}" data-cal-act="toggle"
      data-task-id="${t.id}"${occ ? ` data-occ="${occ}"` : ''}${day ? ` data-cal-day="${day}"` : ''}${locked ? ' aria-disabled="true"' : ''}
      title="${locked ? LOCK_HINT : (t.completed ? '取消完成' : '标记完成')}">${t.completed ? '✓' : ''}</button>
    <div class="cal-panel-main">
      <div class="cal-panel-title">${entry.continuation ? '↳ ' : ''}${esc(t.title || '未命名任务')}</div>
      <div class="cal-panel-meta">
        ${t.group_name ? `<span class="cal-gdot" style="background:${safeColor(t.group_color) || PRIORITY_COLOR[pri]}"></span>${esc(t.group_name)} · ` : ''}
        ${metaTail}
      </div>
    </div>
    <select class="cal-panel-priority" data-cal-act="priority" data-task-id="${t.id}" title="改优先级">${opts}</select>
    <button type="button" class="cal-panel-act" data-cal-act="defer" data-task-id="${t.id}" title="延期一天"${occ ? ' disabled' : ''}>→</button>
  </div>`;
}

function panelHtml() {
  const d = cfg.selected || todayStr();
  const cell = cellData(d);
  const st = loadStateOf(cell.load, cfg.prefs.capacity);
  const groups = new Map();
  cell.tasks.forEach((e) => {
    const k = e.task.group_name || '未分组';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  });
  const list = [...groups.entries()].map(([name, entries]) => `<div class="cal-panel-group">
    <div class="cal-panel-group-name">${esc(name)}</div>
    ${entries.map((e) => panelRowHtml(e, d)).join('')}
  </div>`).join('') || '<div class="cal-panel-empty">这一天还没有安排</div>';
  return `<aside class="cal-right ${cfg.showPanel ? '' : 'is-collapsed'}">
    ${cfg.showPanel ? `<div class="cal-card cal-day-panel">
      <div class="cal-panel-head">
        <div><div class="cal-panel-date">${dateLabel(d)}</div>
          <div class="cal-panel-week">${weekName(d)} · ${d}</div></div>
        <button type="button" class="cal-panel-toggle" data-cal-act="panel-close" title="收起当日面板">›</button>
      </div>
      <div class="cal-panel-load">
        <div class="cal-panel-load-num">${fmtLoad(cell.load)} <span>/ ${cfg.prefs.capacity}</span></div>
        <div class="cal-panel-load-desc">${st.label} · ${Math.round(st.rate * 100)}% · ${cell.tasks.length} 项安排</div>
        ${loadBarHtml(cell.load, cfg.prefs.capacity)}
      </div>
      <div class="cal-panel-sec-title">任务清单（${cell.tasks.length}）</div>
      <div class="cal-panel-list">${list}</div>
      ${cfg.showBacklog ? backlogListHtml() : ''}
    </div>` : '<button type="button" class="cal-panel-reopen" data-cal-act="panel-open" title="展开当日面板">‹</button>'}
  </aside>`;
}

/**
 * 右栏内容 = 当日面板 (+ 周视图里的待安排池)。
 * 周视图必须把 7 列铺满宽度，否则每列只剩 34px，标题会被挤成一字一行；
 * 待安排池因此从左侧栏挪到右栏下方，拖动排期的能力不变。
 */
function rightSlotHtml() {
  const pool = cfg.mode === 'week' ? `<div class="cal-week-pool">${poolCardHtml()}</div>` : '';
  return panelHtml() + pool;
}

function updateDesc() {
  const el = document.getElementById('view-desc');
  if (!el) return;
  const { active, over } = monthStats();
  const prefix = cfg.mode === 'month' ? monthLabel(cfg.anchor) : `${monthLabel(cfg.anchor)} · 本周`;
  el.textContent = `${prefix} · ${active} 天有安排 · ${over} 天超载`;
  el.title = el.textContent;
}

function isEmptyMonth() {
  if (cfg.pool.length === 0 && cfg.overdue.length > 0) return false;
  return monthDates(cfg.anchor).every((d) => cellData(d).tasks.length === 0);
}

function paint() {
  hideTitleTip();
  const wrap = document.querySelector('.cal-wrap');
  if (!wrap) return;
  const isWeek = cfg.mode === 'week';
  wrap.dataset.mode = cfg.mode;
  const layout = wrap.querySelector('.cal-layout');
  if (layout) layout.classList.toggle('is-week', isWeek);
  wrap.querySelector('.cal-left').innerHTML = isWeek ? '' : poolCardHtml() + howCardHtml() + previewCardHtml();
  wrap.querySelector('.cal-month').textContent = monthLabel(cfg.anchor);
  wrap.querySelectorAll('[data-cal-view]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.calView === cfg.mode);
  });
  wrap.querySelector('.cal-body').innerHTML = cfg.mode === 'month'
    ? `${weekdaysHtml()}${monthGridHtml()}`
    : weekGridHtml();
  wrap.querySelector('.cal-legend-slot').innerHTML = legendHtml();
  wrap.querySelector('.cal-trend-slot').innerHTML = trendHtml();
  wrap.querySelector('.cal-stats-slot').innerHTML = statsHtml();
  wrap.querySelector('.cal-right-slot').innerHTML = rightSlotHtml();
  wrap.querySelector('.cal-empty').hidden = !isEmptyMonth();
  updateDesc();
  applyUndoBar();
}

/* ---------------- 对外入口 ---------------- */

/** 打开时显式指定的缩放级别（Ctrl+Alt+M 等）；null = 沿用上次保存的月 / 周 */
let pendingMode = null;

export async function renderCalendar() {
  const root = document.getElementById('view');
  if (!root) return;
  try { cfg.introHidden = localStorage.getItem('knodo.cal.introHidden') === '1'; } catch (e) { /* 忽略 */ }
  if (!root.querySelector('.cal-wrap')) root.innerHTML = shellHtml();
  bindDelegates(root);
  await loadData();
  // 月 / 周缩放由日历内部的分段控件决定：侧栏进入时恢复上次的级别，
  // 只有快捷键 / 外部显式指定时才覆盖。loadData 之后才读，避免拿到旧 prefs。
  if (pendingMode) {
    cfg.mode = pendingMode;
    pendingMode = null;
  } else if (cfg.prefs.view === 'week' || cfg.prefs.view === 'month') {
    cfg.mode = cfg.prefs.view;
  }
  // 记住上次使用的缩放级别；放在 loadData 之后写，避免覆盖首启提示等其它设置字段
  if (cfg.prefs.view !== cfg.mode) await savePrefs({ view: cfg.mode });
  paint();
}

export async function openCalendar(mode, date = '') {
  pendingMode = mode === 'week' || mode === 'month' ? mode : null;
  cfg.anchor = date || todayStr();
  cfg.selected = cfg.anchor;
  cfg.showPanel = true;
  cfg.showBacklog = false;
  state.view = 'calendar';
  state.editingTaskId = null;
  state.addingTask = false;
  ext.renderSidebar();
  await ext.render();
}

export function backToList(view = 'today') {
  // 回到进入日历之前那个任务列表（由 ui.js 记住），不是一律跳「今天」
  state.view = ['today', 'upcoming', 'all', 'completed', 'archived'].includes(view) ? view : 'today';
  ext.renderSidebar();
  ext.render();
}

export function disposeCalendar() {
  hideTitleTip();
  clearEdgeTimer();
  clearPreview();
  endDrag();
  if (cfg.undoTimer) { clearTimeout(cfg.undoTimer); cfg.undoTimer = null; }
  const bar = document.querySelector('.cal-undo');
  if (bar) bar.hidden = true;
}

/* ---------------- 数据写入 ---------------- */

async function reloadAndPaint() {
  await loadData();
  paint();
}

/**
 * 重复事项的日期由规则派生（本次 = 发生日，截止 = 发生日 + 偏移），日历里的拖拽 / 延期 / 取消排期
 * 一律不写库 —— 写了也会被日切改回去（db.updateTask 现在直接拒写这三个字段）。
 * 这里提前拦下来并给出可操作的指路，而不是"拖了一下没反应"。
 */
function blockRecurringSchedule(t) {
  if (!t || t.recurring_id == null) return false;
  ext.toast('这是重复事项：日期由规则派生，请在「重复规则」里改生效日 / 截止日偏移');
  return true;
}

async function writeSchedule(drag, date) {
  const t = drag.task;
  if (blockRecurringSchedule(t)) return;
  const span = drag.span;
  let planStart = null;
  let planEnd = null;
  if (span > 1) { planStart = date; planEnd = addDays(date, span - 1); }
  else if (t.plan_start && !t.plan_end) planStart = date;
  else planEnd = date;
  try {
    await api.tasks.update(t.id, { planStart, planEnd });
    cfg.undo = { id: t.id, prev: { planStart: t.plan_start || null, planEnd: t.plan_end || null }, label: `已移到 ${dateLabel(date)}` };
    await reloadAndPaint();
    showUndo();
  } catch (e) {
    ext.toast(`排期失败：${(e && e.message) || e}`);
  }
}

async function writeUnschedule(drag) {
  const t = drag.task;
  if (blockRecurringSchedule(t)) return;
  try {
    await api.tasks.update(t.id, { planStart: null, planEnd: null });
    cfg.undo = { id: t.id, prev: { planStart: t.plan_start || null, planEnd: t.plan_end || null }, label: '已移回待安排池' };
    await reloadAndPaint();
    showUndo();
  } catch (e) {
    ext.toast(`取消排期失败：${(e && e.message) || e}`);
  }
}

async function patchTask(id, patch, label) {
  const t = cfg.tasks.find((x) => x.id === id);
  if (!t) return;
  // 只改优先级等非派生字段时照常放行；一旦带计划日期就走上面的拦截
  if ((patch.planStart !== undefined || patch.planEnd !== undefined) && blockRecurringSchedule(t)) return;
  try {
    await api.tasks.update(id, patch);
    if (label) cfg.undo = {
      id,
      prev: { planStart: t.plan_start || null, planEnd: t.plan_end || null, priority: t.priority },
      label,
    };
    await reloadAndPaint();
    if (label) showUndo();
  } catch (e) {
    ext.toast(`操作失败：${(e && e.message) || e}`);
  }
}

/**
 * occ 非空 = 这是「重复事项某一天的打卡」格子，撤销时删那一天的打卡记录，
 * 而不能把任务行当前的完成态翻过来（那会误伤今天 / 下一次那一份）。
 */
async function toggleTask(id, occ = '') {
  const t = cfg.tasks.find((x) => x.id === id);
  if (!t) return;
  // 历史打卡（那一天早于今天）同样不给撤：删的是 recurrence_completions 里的历史记录，
  // 日历上看不出痕迹，却会让习惯统计凭空少一天。改历史去「重复事项」的打卡日历。
  if (occ && isPastDay(occ)) { ext.toast(LOCK_HINT); return; }
  if (occ && t.recurring_id != null && occ !== (t.occurrence_date || '')) {
    try {
      await api.recurrences.setCompletion(t.recurring_id, occ, false);
      // 撤销打卡后这一天会整条从日历上消失（没打卡的重复事项不回填格子），
      // 不留撤销入口用户就再也勾不回来了。
      cfg.undo = {
        kind: 'occ', ruleId: t.recurring_id, occ,
        label: `已撤销 ${occ} 的打卡`, ttl: 10000,
      };
      await reloadAndPaint();
      showUndo();
      ext.toast(`已撤销 ${occ} 的打卡`);
    } catch (e) {
      ext.toast(`撤销打卡失败：${(e && e.message) || e}`);
    }
    return;
  }
  const wasDone = !!t.completed;
  try {
    await api.tasks.toggle(id);
    // 与列表视图同口径：勾掉的任务今天仍要留在「今天」视图里
    noteCompletionChange(id, !wasDone, t.parent_id);
    // 历史格子里取消完成后，任务会按「已超期」归到今天的积压、从原格子消失 ——
    // 勾错了要能一键勾回来，否则用户会觉得「历史日期不让改了」。
    cfg.undo = {
      kind: 'complete', id,
      label: `${wasDone ? '已取消完成' : '已完成'}「${clipTitle(t.title)}」`, ttl: 10000,
    };
    await reloadAndPaint();
    showUndo();
  } catch (e) {
    ext.toast(`切换完成态失败：${(e && e.message) || e}`);
  }
}

function deferOneDay(id) {
  const t = cfg.tasks.find((x) => x.id === id);
  if (!t) return;
  const r = taskRange(t);
  if (!r) { return; }
  patchTask(id, { planStart: addDays(r[0], 1), planEnd: addDays(r[1], 1) }, `已延期到 ${dateLabel(addDays(r[1], 1))}`);
}

function unschedule(id) { patchTask(id, { planStart: null, planEnd: null }, '已移回待安排池'); }
function setPriority(id, p) { patchTask(id, { priority: p }, ''); }

async function batchToToday() {
  const today = todayStr();
  // 重复事项由规则排期，不参与「欠账改到今天」
  const targets = cfg.overdue.filter((t) => t.recurring_id == null);
  if (!targets.length) {
    ext.toast('没有需要改期的一次性任务');
    return;
  }
  try {
    for (const t of targets) {
      // 超期任务整段都在过去，直接改成今天单日
      await api.tasks.update(t.id, { planStart: null, planEnd: today });
    }
    ext.toast(`已把 ${targets.length} 条欠账改到今天`);
    await reloadAndPaint();
  } catch (e) {
    ext.toast(`批量改期失败：${(e && e.message) || e}`);
  }
}

/* ---------------- 撤销 ---------------- */

function showUndo() {
  const bar = document.querySelector('.cal-undo');
  if (!bar || !cfg.undo) return;
  bar.innerHTML = `<span>${esc(cfg.undo.label)}</span>
    <button type="button" data-cal-act="undo">撤销</button>
    <button type="button" class="cal-undo-x" data-cal-act="undo-close" title="关闭">✕</button>`;
  bar.hidden = false;
  if (cfg.undoTimer) clearTimeout(cfg.undoTimer);
  // 完成态 / 打卡类的撤销窗口给到 10 秒：它会改变任务在日历上的归属，用户需要时间反应
  const ttl = Number(cfg.undo.ttl) > 0 ? Number(cfg.undo.ttl) : 5000;
  cfg.undoTimer = setTimeout(() => { cfg.undo = null; bar.hidden = true; }, ttl);
}
function applyUndoBar() { if (cfg.undo) showUndo(); }
async function undoLast() {
  const u = cfg.undo;
  if (!u) return;
  try {
    if (u.kind === 'complete') {
      // 完成态撤销 = 再切一次；两个方向都成立
      await api.tasks.toggle(u.id);
    } else if (u.kind === 'occ') {
      await api.recurrences.setCompletion(u.ruleId, u.occ, true);
    } else {
      const patch = { planStart: u.prev.planStart, planEnd: u.prev.planEnd };
      if (u.prev.priority != null) patch.priority = u.prev.priority;
      await api.tasks.update(u.id, patch);
    }
    cfg.undo = null;
    const bar = document.querySelector('.cal-undo');
    if (bar) bar.hidden = true;
    await reloadAndPaint();
    ext.toast('已撤销');
  } catch (e) { ext.toast(`撤销失败：${(e && e.message) || e}`); }
}

/* ---------------- 设置弹窗 ---------------- */

function openCapacityDialog() {
  const p = cfg.prefs;
  openPanelModal({
    title: '调整每日容量',
    className: 'modal-cal-settings',
    okText: '完成',
    showClose: true,
    html: `<div class="cal-set">
      <div class="cal-set-row"><label>每日容量 <small>4 – 10</small></label>
        <input id="cal-set-cap" type="number" min="4" max="10" value="${p.capacity}"></div>
      <div class="cal-set-row"><label>每周起始日</label>
        <select id="cal-set-week">
          <option value="1"${p.weekStart === 1 ? ' selected' : ''}>周一</option>
          <option value="0"${p.weekStart === 0 ? ' selected' : ''}>周日</option>
        </select></div>
      <div class="cal-set-row"><label>隐藏已完成任务 <small>默认显示：勾掉的任务留在当天格子里，只是不计入负载</small></label>
        <input id="cal-set-done" type="checkbox"${p.hideCompleted ? ' checked' : ''}></div>
      <div class="cal-set-note">6 是这天能扛的量，超过就该挪 —— 容量是你自己的校准口。也可以在 设置 → 日历 里改。</div>
    </div>`,
    onSubmit: async (mask) => {
      const cap = clamp(Number(mask.querySelector('#cal-set-cap').value) || 6, 4, 10);
      await savePrefs({
        capacity: cap,
        weekStart: mask.querySelector('#cal-set-week').value === '0' ? 0 : 1,
        hideCompleted: !!mask.querySelector('#cal-set-done').checked,
      });
      await reloadAndPaint();
      return '';
    },
  });
}

function openOverloadChoice(drag, date, predicted) {
  const cap = cfg.prefs.capacity;
  openPanelModal({
    title: '这一天会超载',
    className: 'modal-cal-overload',
    okText: '仍然放入',
    showClose: true,
    html: `<div class="cal-overload">
      把「${esc(drag.task.title || '未命名任务')}」放到 <b>${dateLabel(date)}</b> 后，
      负载将达到 <b class="is-bad">${fmtLoad(predicted)} / ${cap}</b>（${Math.round((predicted / cap) * 100)}%）。
      <div class="cal-overload-tip">放到下一个空日推荐：一键挪到余量充足的那天，不用自己翻日历。</div>
    </div>`,
    extraButtons: [{
      label: '放到下一个空日',
      handler: async (_mask, close) => {
        await writeSchedule(drag, nextFreeDay(date, drag));
        close();
        return '';
      },
    }],
    onSubmit: async () => { await writeSchedule(drag, date); return ''; },
  });
}

function nextFreeDay(from, drag) {
  const cap = cfg.prefs.capacity;
  const added = weightOf(drag.task) / drag.span;
  let d = addDays(from, 1);
  for (let i = 0; i < 60; i += 1) {
    if (cellData(d).load + added <= cap * 0.6) return d;
    d = addDays(d, 1);
  }
  return addDays(from, 1);
}

/* ---------------- 事件委托 ---------------- */

function bindDelegates(root) {
  if (boundRoot === root) return;
  boundRoot = root;
  root.addEventListener('click', onClick);
  root.addEventListener('dblclick', onDblClick);
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('change', onChange);
  root.addEventListener('mousemove', onTitleHover);
  root.addEventListener('mouseout', onTitleHoverOut);
  root.addEventListener('scroll', hideTitleTip, true);
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('drop', onDrop);
  root.addEventListener('dragend', onDragEnd);
  // Esc 取消拖拽：原生 drag 在 Esc 时会自行 dragend，这里只置标志 + 收掉预览
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !cfg.drag) return;
    cfg.drag.esc = true;
    clearEdgeTimer();
    clearPreview();
  }, true);
  // 原生 drag 在跨月重绘后可能不再触发 dragend，用 mouseup 兜底收尾
  document.addEventListener('mouseup', () => {
    if (cfg.drag && !cfg.dropHandled) {
      clearEdgeTimer();
      setTimeout(() => { if (cfg.drag) endDrag(); }, 0);
    }
  });
}

function onClick(e) {
  const root = e.currentTarget;
  if (!root.querySelector('.cal-wrap')) return;
  const act = e.target.closest('[data-cal-act]');
  if (act) {
    const id = Number(act.dataset.taskId || 0);
    switch (act.dataset.calAct) {
      case 'toggle': {
        // 双保险：按钮本身带 is-locked，这里再挡一次（键盘 / 旧 DOM / 事件冒泡都不该改历史）
        if (isPastDay(act.dataset.calDay)) { ext.toast(LOCK_HINT); return; }
        toggleTask(id, act.dataset.occ || ''); return;
      }
      case 'capacity': openCapacityDialog(); return;
      case 'more': selectDate(act.dataset.date || todayStr()); return;
      case 'overdue': selectDate(todayStr(), true); return;
      case 'panel-close': cfg.showPanel = false; paintPanel(); return;
      case 'panel-open': cfg.showPanel = true; paintPanel(); return;
      case 'backlog-all': batchToToday(); return;
      case 'backlog-one': {
        const t = cfg.overdue.find((x) => x.id === id);
        if (t) patchTask(id, { planStart: null, planEnd: todayStr() }, '已改到今天');
        return;
      }
      case 'undo': undoLast(); return;
      case 'undo-close': {
        cfg.undo = null;
        const bar = document.querySelector('.cal-undo');
        if (bar) bar.hidden = true;
        return;
      }
      case 'intro-close': {
        cfg.introHidden = true;
        try { localStorage.setItem('knodo.cal.introHidden', '1'); } catch (err) { /* 忽略 */ }
        const intro = root.querySelector('.cal-intro');
        if (intro) intro.hidden = true;
        return;
      }
      default: break;
    }
  }
  const nav = e.target.closest('[data-cal-nav]');
  if (nav) {
    if (nav.dataset.calNav === 'today') { cfg.anchor = todayStr(); cfg.selected = todayStr(); }
    else {
      const dir = nav.dataset.calNav === 'next' ? 1 : -1;
      cfg.anchor = cfg.mode === 'month' ? addMonths(cfg.anchor, dir) : addDays(cfg.anchor, dir * 7);
    }
    paint();
    return;
  }
  const view = e.target.closest('[data-cal-view]');
  if (view) {
    cfg.mode = view.dataset.calView === 'week' ? 'week' : 'month';
    savePrefs({ view: cfg.mode });
    paint();
    return;
  }
  // 空白区域按下才是选择；点在任务卡 / 按钮上不抢焦点（RK-03）
  const cell = e.target.closest('.cal-cell, .cal-week-col');
  if (cell && !e.target.closest('.cal-task, button')) selectDate(cell.dataset.date);
}

function onDblClick(e) {
  const card = e.target.closest('.cal-task, .cal-pool-item');
  if (card && card.dataset.taskId) ext.openTaskDetail(Number(card.dataset.taskId));
}

function onContextMenu(e) {
  const card = e.target.closest('.cal-task, .cal-pool-item');
  if (!card || !e.currentTarget.querySelector('.cal-wrap')) return;
  e.preventDefault();
  const id = Number(card.dataset.taskId);
  const occ = card.dataset.occ || '';
  const t = cfg.tasks.find((x) => x.id === id);
  if (!t) return;
  // 过去格子里的完成态只读（与 cal-check 的 is-locked 同一条规则，见 isPastDay）
  const host = card.closest('[data-date]');
  const past = isPastDay(host ? host.dataset.date : '');
  // 历史打卡格子：排期 / 优先级 / 完成态都不属于"这一天"，只留详情与撤销
  if (occ) {
    openContextMenu([
      { label: '打开详情', icon: '↗', onClick: () => ext.openTaskDetail(id) },
      { type: 'sep' },
      { label: `撤销 ${occ} 的打卡`, icon: '↺', disabled: past, onClick: () => toggleTask(id, occ) },
    ], { x: e.clientX, y: e.clientY });
    return;
  }
  openContextMenu([
    { label: '打开详情', icon: '↗', onClick: () => ext.openTaskDetail(id) },
    { type: 'sep' },
    ...[3, 2, 1, 0].map((p) => ({
      label: `优先级：${PRIORITY_TEXT[p]}`,
      checked: priorityOf(t) === p,
      onClick: () => setPriority(id, p),
    })),
    { type: 'sep' },
    { label: '延期一天', icon: '→', disabled: !taskRange(t) || !!t.completed, onClick: () => deferOneDay(id) },
    { label: '移出排期', icon: '⌫', disabled: !taskRange(t), onClick: () => unschedule(id) },
    { label: past ? '完成状态（历史只读）' : (t.completed ? '取消完成' : '标记完成'), icon: '✓', disabled: past, onClick: () => toggleTask(id) },
  ], { x: e.clientX, y: e.clientY });
}

function onChange(e) {
  const sel = e.target.closest('.cal-panel-priority');
  if (sel) setPriority(Number(sel.dataset.taskId), Number(sel.value));
}

function selectDate(d, backlog = false) {
  if (!d) return;
  cfg.selected = d;
  cfg.showBacklog = !!backlog;
  cfg.showPanel = true;
  // 局部刷新：只换选中态与右侧面板，日历本身不滚动、不跳页（方案 5.3）
  document.querySelectorAll('.cal-cell.is-selected, .cal-week-col.is-selected').forEach((el) => {
    el.classList.remove('is-selected');
  });
  const cell = document.querySelector(`.cal-cell[data-date="${d}"], .cal-week-col[data-date="${d}"]`);
  if (cell) cell.classList.add('is-selected');
  paintPanel();
}

function paintPanel() {
  hideTitleTip();
  const slot = document.querySelector('.cal-right-slot');
  if (slot) slot.innerHTML = rightSlotHtml();
}

/* ---------------- 拖拽 ---------------- */

function onDragStart(e) {
  const card = e.target.closest('.cal-task[draggable], .cal-pool-item[draggable]');
  if (!card || !e.currentTarget.querySelector('.cal-wrap')) return;
  // draggable="false" 仍然算「有该属性」，必须按值判断：已完成任务不允许拖动改期
  if (card.getAttribute('draggable') === 'false') { e.preventDefault(); return; }
  hideTitleTip();
  const id = Number(card.dataset.taskId);
  const task = cfg.tasks.find((t) => t.id === id);
  if (!task) return;
  const host = card.closest('[data-date]');
  cfg.drag = {
    id, task,
    sourceDate: host ? host.dataset.date : '',
    from: host ? 'cell' : 'pool',
    span: taskSpan(task),
    esc: false,
  };
  cfg.dropHandled = false;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', `knodo-task:${id}`); } catch (err) { /* 某些环境不允许 */ }
  const ghost = document.createElement('div');
  ghost.className = 'cal-drag-ghost';
  ghost.innerHTML = `<span class="cal-drag-ghost-bar" style="background:${PRIORITY_COLOR[priorityOf(task)]}"></span>${esc(task.title || '未命名任务')}`;
  document.body.appendChild(ghost);
  try { e.dataTransfer.setDragImage(ghost, 12, 12); } catch (err) { /* 不支持就用默认拖影 */ }
  setTimeout(() => ghost.remove(), 0);
  card.classList.add('is-dragging');
}

function clearPreview() {
  document.querySelectorAll('.is-preview, .is-drop-pool').forEach((el) => {
    el.classList.remove('is-preview', 'is-drop-pool');
  });
  document.querySelectorAll('.cal-preview-fill, .cal-drop-tip').forEach((el) => el.remove());
  cfg.previewDate = '';
  cfg.previewHost = null;
  cfg.previewPredicted = null;
}

function previewKey(zone, date) { return date || (zone.classList.contains('cal-pool') ? 'pool' : ''); }

function onDragOver(e) {
  if (!cfg.drag) return;
  const grid = e.target.closest('.cal-grid');
  const zone = e.target.closest('.cal-cell, .cal-week-col, .cal-pool, .cal-grid');
  if (!zone) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const hit = e.target.closest('.cal-cell, .cal-week-col, .cal-pool');
  if (hit) {
    const dateEl = hit.matches('[data-date]') ? hit : null;
    const date = dateEl ? dateEl.dataset.date : '';
    const key = previewKey(hit, date);
    if (cfg.previewDate !== key || cfg.previewHost !== dateEl) {
      clearPreview();
      showPreview(dateEl, date, hit, key);
    }
  } else if (cfg.previewDate) {
    clearPreview();
  }
  handleEdge(grid || zone, e);
}

function showPreview(dateEl, date, zone, key) {
  const drag = cfg.drag;
  cfg.previewDate = key;
  cfg.previewHost = dateEl;
  if (!dateEl) {
    if (zone.classList.contains('cal-pool')) zone.classList.add('is-drop-pool');
    updatePreviewCard(null);
    return;
  }
  const cap = cfg.prefs.capacity;
  const added = weightOf(drag.task) / drag.span;
  const removed = drag.sourceDate === date ? added : 0;
  const predicted = Math.max(0, Math.round((cellData(date).load - removed + added) * 100) / 100);
  const st = loadStateOf(predicted, cap);
  cfg.previewPredicted = predicted;
  dateEl.classList.add('is-preview');
  const load = dateEl.querySelector('.cal-load');
  if (load) {
    const bar = document.createElement('span');
    bar.className = `cal-preview-fill ${st.cls}`;
    bar.style.width = `${st.pct.toFixed(1)}%`;
    load.appendChild(bar);
  }
  const tip = document.createElement('span');
  tip.className = `cal-drop-tip ${st.rate >= 1 ? 'is-bad' : ''}`;
  tip.textContent = st.rate >= 1
    ? `将超载 ${Math.round(st.rate * 100)}%`
    : `${fmtLoad(predicted)} / ${cap}`;
  dateEl.appendChild(tip);
  updatePreviewCard({ date, predicted, cap, st });
}

function updatePreviewCard(info) {
  const box = document.querySelector('.cal-preview-box');
  if (!box) return;
  if (!info) {
    box.innerHTML = `<div class="cal-preview-line">松手即取消排期</div>
      <div class="cal-preview-track"><span style="width:0%"></span></div>`;
    return;
  }
  const pct = Math.round(info.st.rate * 100);
  box.innerHTML = `<div class="cal-preview-line">${weekName(info.date)} <b>${fmtLoad(info.predicted)} / ${info.cap}</b>
      · <span class="${info.st.rate >= 1 ? 'is-bad' : ''}">${info.st.rate >= 1 ? `将超载 ${pct}%` : '排得下'}</span></div>
    <div class="cal-preview-track ${info.st.rate >= 1 ? 'is-bad' : ''}"><span style="width:${info.st.pct.toFixed(1)}%"></span></div>`;
}

function handleEdge(zone, e) {
  const grid = zone.closest('.cal-grid') || (zone.classList.contains('cal-grid') ? zone : null);
  if (!grid || cfg.mode !== 'month') { clearEdgeTimer(); return; }
  const r = grid.getBoundingClientRect();
  const dir = e.clientX < r.left + 28 ? -1 : (e.clientX > r.right - 28 ? 1 : 0);
  if (!dir) { clearEdgeTimer(); return; }
  if (cfg.edgeDir === dir && cfg.edgeTimer) return;
  clearEdgeTimer();
  cfg.edgeDir = dir;
  cfg.edgeTimer = setTimeout(() => {
    cfg.anchor = addMonths(cfg.anchor, dir);
    cfg.edgeTimer = null;
    cfg.edgeDir = 0;
    clearPreview();
    paint();  // 原生 drag 源节点可能被换掉，cfg.drag 保留，drop/dragend 仍由委托接管
  }, 800);
}
function clearEdgeTimer() {
  if (cfg.edgeTimer) { clearTimeout(cfg.edgeTimer); cfg.edgeTimer = null; }
  cfg.edgeDir = 0;
}

function onDrop(e) {
  if (!cfg.drag) return;
  e.preventDefault();
  const drag = { ...cfg.drag };
  const predicted = cfg.previewPredicted;
  const zone = e.target.closest('.cal-cell, .cal-week-col, .cal-pool, .cal-grid');
  const dateEl = zone && zone.matches('[data-date]') ? zone : null;
  const isPool = !!e.target.closest('.cal-pool') || (zone && zone.classList.contains('cal-pool'));
  cfg.dropHandled = true;
  clearEdgeTimer();
  clearPreview();
  if (!drag.esc) {
    if (isPool) writeUnschedule(drag);
    else if (dateEl) {
      const load = predicted == null
        ? cellData(dateEl.dataset.date).load + weightOf(drag.task) / drag.span
        : predicted;
      if (load > cfg.prefs.capacity) openOverloadChoice(drag, dateEl.dataset.date, load);
      else writeSchedule(drag, dateEl.dataset.date);
    }
  }
  endDrag();
}

function onDragEnd() {
  cfg.dropHandled = false;
  endDrag();
}

function endDrag() {
  document.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
  clearEdgeTimer();
  clearPreview();
  updatePreviewCard(null);
  const box = document.querySelector('.cal-preview-box');
  if (box) {
    box.innerHTML = `<div class="cal-preview-line">周四 <b>7 / 6</b> · <span class="is-bad">将超载 117%</span></div>
      <div class="cal-preview-track"><span style="width:100%"></span></div>`;
  }
  cfg.drag = null;
}
