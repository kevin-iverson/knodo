'use strict';
/**
 * 任务行内的工时摘要 / 记录明细 / 补录入口（feature.worklog 开启时才被 import）。
 *
 * 设计要点（务必先读）：
 * 1. ui.js#renderTasks 每次整块重写 #view.innerHTML，再遍历 EXT.taskRowExtra 回调。
 *    这个模块就是那个回调：只往已经渲染好的行里插 DOM + 就地绑事件，绝不碰 ui.js。
 * 2. 扩展点回调是**同步**的，不能 await。所以累计时长用一份预取缓存 rowAgg（来自
 *    api.worklog.range({}) 一次拿全树），明细才按需 await api.worklog.task(id)。
 * 3. 刷新一律走「改文本 / 改 class」的局部更新，绝不调 renderTasks()（会丢滚动和 hover）。
 *    数据变更后由 index.js 调本模块的 refreshAll() 重建缓存并重画已注入的行。
 * 4. 异步写入 DOM 前必须校验 el.isConnected && data-id 未变，防止重绘后写到别的行上。
 */
import { api } from '../api.js';
import { toast } from '../ui.js';
import { openFormModal } from '../modal.js';
import { t as tr } from '../i18n.js';
import { hm, fmtDay, fmtClock, esc, dateKey, SOURCE_TEXT } from './shared.js';

/** taskId -> { ownSec, ownCnt, aggSec, parentId, title }（全时段，与 worklog:task 口径一致） */
let rowAgg = new Map();
/** 展开明细的任务 id 集合；renderTasks 整块重绘后据此恢复展开态 */
const expanded = new Set();
/** taskId -> entries[]，明细按需缓存，数据变更后清空 */
const entriesCache = new Map();
let loading = false;
let dirty = false;

/** 拉全树聚合，一次 IPC 建缓存，不逐行请求（N 行调 N 次 worklog:task 会重复扫全表） */
async function loadAgg() {
  if (loading) { dirty = true; return; }
  loading = true;
  try {
    const rows = await api.worklog.range({});
    rowAgg = new Map((rows || []).map((r) => [Number(r.id), r]));
  } catch (e) {
    // 读不到就保持旧缓存；下次 refresh 再试
  } finally {
    loading = false;
  }
  if (dirty) { dirty = false; loadAgg(); return; }
  paintAll();
}

/** 数据变更后调用：重建缓存并重画所有已注入的摘要 */
export function refreshAll() {
  loadAgg();
}

/** 摘要 chip 文案：自身累计（含子任务时括号补显示），空数据不建 chip */
function chipText(taskId, snap) {
  const a = rowAgg.get(Number(taskId));
  if (!a || !a.ownCnt) return '';
  const mine = snap && (snap.mode === 'running' || snap.mode === 'paused')
    && Number(snap.taskId) === Number(taskId);
  // 正在计时：已结算的 ownSec 不含进行中的那一段，实时叠加，避免"点了计时数字不动"
  const liveSec = mine ? Math.floor(((snap.accMs || 0) + (snap.mode === 'running'
    ? Math.max(0, Date.now() - (snap.segStart || Date.now())) : 0)) / 1000) : 0;
  const own = a.ownSec + liveSec;
  const sub = a.aggSec - a.ownSec;
  const more = sub > 0 ? ` <span class="wl-row-log-sub">+${hm(sub)}${tr('子')}</span>` : '';
  return `⏱ ${hm(own)} · ${tr('{n} 条', { n: a.ownCnt })}${more}`;
}

/** 只改文本，不重建 DOM（沿用 index.js#paintRow 的范式） */
function paintChip(chip, snap) {
  const a = rowAgg.get(Number(chip.dataset.wlLogChip));
  const open = expanded.has(Number(chip.dataset.wlLogChip));
  chip.classList.toggle('is-open', open);
  if (!a || !a.ownCnt) {
    // 无记录时不占 meta 行空间
    chip.textContent = '';
    chip.classList.add('is-empty');
    return;
  }
  chip.classList.remove('is-empty');
  chip.innerHTML = chipText(chip.dataset.wlLogChip, snap);
}

function paintAll(snap = null) {
  document.querySelectorAll('[data-wl-log-chip]').forEach((chip) => paintChip(chip, snap));
}

/** 秒级只更新时间文本，不动结构（由 index.js#tickRows 驱动） */
export function tick(snap) {
  document.querySelectorAll('[data-wl-log-chip]:not(.is-empty)').forEach((chip) => paintChip(chip, snap));
}

/* ------------------------------ 明细面板 ------------------------------ */

function entryRow(e) {
  const clock = e.startedAt && e.endedAt
    ? `${fmtClock(e.startedAt)}–${fmtClock(e.endedAt)}`
    : fmtClock(e.startedAt);
  return `<div class="wl-re-row">
    <span class="wl-re-day">${esc(fmtDay(e.startedAt))}</span>
    <span class="wl-re-clock num">${esc(clock)}</span>
    <span class="wl-re-sec num">${hm(e.sec)}</span>
    <span class="wl-re-src">${esc(SOURCE_TEXT[e.source] || e.source || '')}</span>
    <span class="wl-re-note" title="${esc(e.note)}">${esc(e.note)}</span>
  </div>`;
}

function panelHtml(taskId) {
  const list = entriesCache.get(Number(taskId));
  if (!list) return `<div class="wl-re-loading">${tr('读取记录…')}</div>`;
  if (!list.length) return `<div class="wl-re-empty">${tr('还没有工时记录，点右上「＋补录」添加')}</div>`;
  const sorted = list.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const total = sorted.reduce((s, e) => s + (Number(e.sec) || 0), 0);
  return `<div class="wl-re-head">
      <span>${tr('{n} 条 · 共 {total}', { n: sorted.length, total: hm(total) })}</span>
      <button type="button" class="wl-re-add" data-wl-row-add="${taskId}">＋${tr('补录')}</button>
    </div>
    <div class="wl-re-list">${sorted.map(entryRow).join('')}</div>`;
}

/** 异步拉明细：回来时校验行仍在、仍是同一任务、面板仍展开 */
async function loadEntries(taskId, el) {
  try {
    const data = await api.worklog.task(taskId);
    if (!el.isConnected || Number(el.dataset.id) !== Number(taskId) || !expanded.has(Number(taskId))) return;
    entriesCache.set(Number(taskId), (data && data.entries) || []);
    const panel = el.querySelector(`[data-wl-row-log-panel="${taskId}"]`);
    if (panel && panel.isConnected) panel.innerHTML = panelHtml(taskId);
  } catch (e) {
    if (!el.isConnected) return;
    const panel = el.querySelector(`[data-wl-row-log-panel="${taskId}"]`);
    if (panel) panel.innerHTML = `<div class="wl-re-empty">${tr('读取失败：{msg}', { msg: esc((e && e.message) || e) })}</div>`;
  }
}

function togglePanel(taskId, el) {
  const id = Number(taskId);
  const body = el.querySelector('.task-body');
  if (!body) return;
  let panel = body.querySelector(`[data-wl-row-log-panel="${id}"]`);
  if (expanded.has(id)) {
    expanded.delete(id);
    if (panel) panel.remove();
  } else {
    expanded.add(id);
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'wl-row-log-panel';
      panel.dataset.wlRowLogPanel = String(id);
      panel.innerHTML = panelHtml(id);
      body.appendChild(panel);
    }
    if (!entriesCache.has(id)) loadEntries(id, el);
  }
  const chip = body.querySelector(`[data-wl-log-chip="${id}"]`);
  if (chip) paintChip(chip);
}

/* ------------------------------ 补录 ------------------------------ */

/** 指定任务的补录：任务固定为当前行/当前详情，不重复让用户选。返回是否成功 */
export async function manualAddFor(taskId) {
  try {
    const ok = await openFormModal({
      title: tr('补录工时'),
      okText: tr('补录'),
      grid: true,
      fields: [
        { name: 'date', label: tr('日期'), value: dateKey(new Date()), placeholder: 'YYYY-MM-DD', span: 2, hint: tr('跨天按开始日归属') },
        { name: 'start', label: tr('开始'), placeholder: '09:00' },
        { name: 'end', label: tr('结束'), placeholder: '10:30' },
        { name: 'note', label: tr('备注'), placeholder: tr('这段时间做了什么'), span: 2 },
      ],
      onSubmit: async (v) => {
        try {
          await api.worklog.manualAdd({
            taskId: Number(taskId), date: v.date, start: v.start, end: v.end, note: v.note,
          });
          return undefined;
        } catch (err) {
          return (err && err.message) || tr('补录失败');
        }
      },
    });
    if (ok) {
      toast(tr('已补录'));
      entriesCache.delete(Number(taskId));
      refreshAll();
      // 明展开时就地重拉，不整表重绘
      if (expanded.has(Number(taskId))) {
        const el = document.querySelector(`.task-item[data-id="${taskId}"]`);
        if (el) loadEntries(Number(taskId), el);
      }
      return true;
    }
    return false;
  } catch (e) {
    toast((e && e.message) || tr('补录失败'));
    return false;
  }
}

/* ------------------------------ 扩展点回调 ------------------------------ */

/**
 * 每个任务行渲染完成后调用：往 .task-meta 末尾插摘要 chip，点击展开明细。
 * 补录入口在明细面板里（点摘要才有），避免每行多挤一个常显按钮。
 */
export function renderRowLog({ task, el }) {
  if (!task || !el || !task.id) return;
  const id = Number(task.id);
  const meta = el.querySelector('.task-meta');
  if (!meta || meta.querySelector(`:scope > [data-wl-log-chip="${id}"]`)) return;

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'wl-row-log-chip';
  chip.dataset.wlLogChip = String(id);
  chip.title = tr('查看这条任务的工时记录 / 补录');
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePanel(id, el);
  });
  meta.appendChild(chip);
  paintChip(chip);

  // 补录 / 删除记录走的是 store 直写，不发 worklog:changed。所以任务列表渲染时
  // 若发现缓存还没建起来（首屏或刚开插件），主动拉一次；loadAgg 完成后 paintAll
  // 会把已插入的空 chip 填上。loading/dirty 会合并并发请求，不会无限循环。
  if (!rowAgg.size && !loading) refreshAll();

  // 明细面板里的补录按钮：事件委托绑在面板上（面板内容会被反复替换，绑内容上会丢）
  const body = el.querySelector('.task-body');
  if (body && !body.dataset.wlLogBound) {
    body.dataset.wlLogBound = '1';
    body.addEventListener('click', (e) => {
      const add = e.target.closest('[data-wl-row-add]');
      if (!add) return;
      e.preventDefault();
      e.stopPropagation();
      manualAddFor(add.dataset.wlRowAdd);
    });
  }

  // 展开态跨整表重绘恢复
  if (expanded.has(id)) {
    let panel = body.querySelector(`[data-wl-row-log-panel="${id}"]`);
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'wl-row-log-panel';
      panel.dataset.wlRowLogPanel = String(id);
      body.appendChild(panel);
    }
    panel.innerHTML = panelHtml(id);
    if (!entriesCache.has(id)) loadEntries(id, el);
  }
}

/** 卸载时清缓存与展开态（关插件后 DOM / CSS 都没了，状态不该留着） */
export function reset() {
  rowAgg = new Map();
  expanded.clear();
  entriesCache.clear();
  loading = false;
  dirty = false;
}
