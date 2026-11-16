'use strict';
/**
 * 任务详情抽屉里的工时区块（EXT.detailSection 插件）。
 *
 * 落点：detail.js#renderDetail 拼完 innerHTML 后调用 ext('detailSection', {drawer, task, signal})，
 * 往 [data-detail-slot="worklog"] 填内容。这个 slot 在「重复与设置」下方、子任务上方。
 *
 * 三条铁律：
 * 1. 详情每次 renderDetail 都整块重建 innerHTML → 本函数每次都会被重新调用，不要指望单次注入。
 * 2. 抽屉是常驻节点、监听器会累积 → 所有 addEventListener 都带 { signal }，由 detail 的
 *    renderAbort.abort() 统一回收。
 * 3. 不放任何 <input> 进区块 —— 抽屉级 autosave 会捕获 input/change 写库，只读信息 +
 *    补录弹窗（openFormModal 挂在 body）才不会「没改任务却写库」。
 * 4. 异步拉数据回来必须校验 drawer.dataset.taskId 仍是本任务（A/B 任务快速切换防串）。
 */
import { api } from '../api.js';
import { hm, fmtDay, fmtClock, esc, SOURCE_TEXT } from './shared.js';
import { manualAddFor } from './row.js';

/** 详情工时块渲染：同步建骨架，异步填数据 */
export function renderDetailSection({ drawer, task, signal }) {
  if (!drawer || !task || !task.id) return;
  const slot = drawer.querySelector('[data-detail-slot="worklog"]');
  if (!slot) return;
  const id = Number(task.id);

  // 骨架：标题行（累计 + 补录按钮）+ 明细容器。全只读，无 input。
  slot.innerHTML = `
    <div class="wl-ds">
      <div class="wl-ds-head">
        <span class="wl-ds-title">工时记录</span>
        <span class="wl-ds-sum" data-wl-ds-sum></span>
        <button type="button" class="wl-ds-add" data-wl-ds-add title="为这条任务补录工时">＋补录</button>
      </div>
      <div class="wl-ds-body" data-wl-ds-body><div class="wl-ds-loading">读取中…</div></div>
    </div>`;

  const sumEl = slot.querySelector('[data-wl-ds-sum]');
  const bodyEl = slot.querySelector('[data-wl-ds-body]');
  const addBtn = slot.querySelector('[data-wl-ds-add]');
  const opts = { signal };

  addBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await manualAddFor(id);
    if (ok && bodyEl.isConnected && Number(drawer.dataset.taskId) === id) load(id, drawer, sumEl, bodyEl);
  }, opts);

  load(id, drawer, sumEl, bodyEl);
}

/** 明细行：日期 / 起止 / 时长 / 来源 / 备注（与工时视图同口径文案） */
function entryRow(e) {
  const clock = e.startedAt && e.endedAt
    ? `${fmtClock(e.startedAt)}–${fmtClock(e.endedAt)}`
    : fmtClock(e.startedAt);
  return `<div class="wl-ds-row">
    <span class="wl-ds-day">${esc(fmtDay(e.startedAt))}</span>
    <span class="wl-ds-clock num">${esc(clock)}</span>
    <span class="wl-ds-sec num">${hm(e.sec)}</span>
    <span class="wl-ds-src">${esc(SOURCE_TEXT[e.source] || e.source || '')}</span>
    <span class="wl-ds-note" title="${esc(e.note)}">${esc(e.note)}</span>
  </div>`;
}

async function load(id, drawer, sumEl, bodyEl) {
  try {
    const data = await api.worklog.task(id);
    // 身份校验：抽屉已切到别的任务 / 区块已脱离文档 → 放弃，别把 B 的数据写进 A 的抽屉
    if (!bodyEl.isConnected || Number(drawer.dataset.taskId) !== id) return;
    const entries = (data && data.entries) || [];
    sumEl.textContent = entries.length ? `累计 ${hm(data.ownSec)} · ${entries.length} 条` : '';
    if (!entries.length) {
      bodyEl.innerHTML = '<div class="wl-ds-empty">还没有工时记录。点右上「＋补录」添加，或在任务行点 ▶ 开始计时。</div>';
      return;
    }
    const sorted = entries.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    bodyEl.innerHTML = `<div class="wl-ds-list">${sorted.map(entryRow).join('')}</div>`;
  } catch (e) {
    if (!bodyEl.isConnected || Number(drawer.dataset.taskId) !== id) return;
    bodyEl.innerHTML = `<div class="wl-ds-empty">读取失败：${esc((e && e.message) || e)}</div>`;
  }
}
