'use strict';
/**
 * 表单控件（计划日期范围、快捷提醒），供列表底部编辑器与任务详情抽屉复用。
 *
 * 计划日期范围控件的设计约定：
 *  1. 单一触发器：开始日期 / 完成日期合并为一个控件，点一次弹出日历，不再有两个日期框。
 *  2. 两次点选成范围：第 1 次点击写入「计划开始日期」plan_start，第 2 次点击写入
 *     「计划完成日期」plan_end，选完立即回填隐藏字段并关闭弹窗。
 *  3. 数据绑定：两个隐藏 input（.dr-start-input / .dr-end-input）是唯一数据源，
 *     宿主通过 getDateRange() 读取，或直接监听冒泡事件 'date-range:change'。
 *  4. 一致性：仅选了起点就关闭弹窗会被丢弃（不写入“半个范围”）；遇到 end < start
 *     会自动交换，因此落到后端的永远是成对且有序的值。
 */
import { localToIso, isoToLocal } from './api.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 范围变化后对外派发的事件名，detail = { planStart, planEnd } */
const DATE_RANGE_EVENT = 'date-range:change';

/** 日期范围控件的默认行为（宿主可用 opts 覆盖） */
const DATE_RANGE_DEFAULTS = {
  placeholder: '计划日期', // 未选择时的占位文案
  required: false,         // 计划开始 / 完成日期是否必填
};

function pad2(n) { return String(n).padStart(2, '0'); }

function todayStrLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 归一化外部日期：接受 null / '' / 'YYYY-MM-DD' / ISO，返回 'YYYY-MM-DD' 或 '' */
function normalizeDate(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}

/** "YYYY-MM-DD" 加减天数 */
function addDays(dateStr, delta) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 含首尾的天数；任一端缺失返回 0 */
function daysBetween(s, e) {
  if (!s || !e) return 0;
  const a = new Date(`${s}T00:00:00`);
  const b = new Date(`${e}T00:00:00`);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

/** 新建任务的默认范围：mode='today' → 今天 ~ 今天；其余留空 */
function defaultDateRange(mode) {
  if (mode === 'today') { const t = todayStrLocal(); return { start: t, end: t }; }
  return { start: '', end: '' };
}

/* ---------------- 日期范围控件（单点触发 + 日历两次点选） ---------------- */

function dateRangeFieldHtml(startValue, endValue, opts = {}) {
  const cfg = { ...DATE_RANGE_DEFAULTS, ...opts };
  let s = normalizeDate(startValue);
  let e = normalizeDate(endValue);
  if (s && e && e < s) { const t = s; s = e; e = t; } // 历史数据倒序时兜底纠正
  const days = daysBetween(s, e);
  const label = s && e ? `${s} ~ ${e}` : (s ? `${s} 起` : cfg.placeholder);
  return `
  <div class="date-range-field" data-required="${cfg.required ? '1' : '0'}" data-placeholder="${esc(cfg.placeholder)}">
    <button type="button" class="date-range-trigger${s ? '' : ' is-empty'}" aria-haspopup="dialog" aria-expanded="false" title="点击选择计划开始 / 完成日期">
      <span class="dr-icon">📅</span>
      <span class="dr-text">${esc(label)}</span>
      <span class="dr-days"${days ? '' : ' hidden'}>${days ? `${days} 天` : ''}</span>
      <span class="dr-caret">▾</span>
    </button>
    <input type="hidden" class="dr-start-input" data-field="planStart" value="${esc(s)}" />
    <input type="hidden" class="dr-end-input" data-field="planEnd" value="${esc(e)}" />
    <div class="date-range-pop" role="dialog" aria-label="选择计划日期范围" hidden></div>
  </div>`;
}

/** 已打开的弹窗 → 关闭函数；用于点击外部 / Esc 的统一收拢（避免每次渲染重复挂事件） */
const openPops = new Map();
let globalHandlersBound = false;

function sweepDetachedPops() {
  openPops.forEach((_close, pop) => { if (!pop.isConnected) openPops.delete(pop); });
}

function ensureGlobalHandlers() {
  if (globalHandlersBound) return;
  globalHandlersBound = true;
  // 点击控件外部 → 收起弹窗（未完成的选择会被丢弃）
  // 用捕获阶段的 pointerdown：日历内的点击会重建节点，若等到 click 阶段再判断，
  // 目标节点已被替换，会被误当成"点击外部"而导致点一次日期就关闭。
  document.addEventListener('pointerdown', (e) => {
    openPops.forEach((close, pop) => {
      const field = pop.closest('.date-range-field');
      if (field && field.contains(e.target)) return;
      close();
    });
  }, true);
}

/** 单月网格 HTML（周一为一周起始） */
function calGridHtml(year, month, start, end, today) {
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // 周一=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<span class="cal-cell empty"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${pad2(month + 1)}-${pad2(d)}`;
    let cls = 'cal-cell';
    if (ds === today) cls += ' today';
    if (ds === start || ds === end) cls += ' selected';
    else if (start && end && ds > start && ds < end) cls += ' in-range';
    cells += `<button type="button" class="${cls}" data-date="${ds}">${d}</button>`;
  }
  return cells;
}

function bindDateRangeFields(container) {
  ensureGlobalHandlers();
  sweepDetachedPops();

  container.querySelectorAll('.date-range-field').forEach((dr) => {
    if (dr.dataset.drBound === '1') return; // 同一 DOM 不重复绑定
    dr.dataset.drBound = '1';

    const trigger = dr.querySelector('.date-range-trigger');
    const pop = dr.querySelector('.date-range-pop');
    const sInput = dr.querySelector('.dr-start-input');
    const eInput = dr.querySelector('.dr-end-input');
    const textEl = dr.querySelector('.dr-text');
    const daysEl = dr.querySelector('.dr-days');
    const placeholder = dr.dataset.placeholder || '计划日期';
    const today = todayStrLocal();
    let viewYear = new Date().getFullYear();
    let viewMonth = new Date().getMonth();
    let tmpStart = ''; // 第 1 次点选后的待定起点

    const read = () => ({ s: sInput.value || '', e: eInput.value || '' });
    const labelOf = (s, e) => (s && e ? `${s} ~ ${e}` : (s ? `${s} 起` : placeholder));

    /** 把 hidden input 的值同步到触发器文案上（ picking 态优先展示待定起点） */
    const syncText = () => {
      const { s, e } = read();
      const start = tmpStart || s;
      const end = tmpStart ? '' : e;
      textEl.textContent = labelOf(start, end);
      trigger.classList.toggle('is-empty', !start);
      const d = daysBetween(start, end);
      daysEl.textContent = d ? `${d} 天` : '';
      daysEl.hidden = !d;
    };

    /** 唯一的写入口：保证 end >= start，并对外派发变更事件 */
    const commit = (s, e) => {
      let ns = normalizeDate(s);
      let ne = normalizeDate(e);
      if (ns && ne && ne < ns) { const t = ns; ns = ne; ne = t; }
      sInput.value = ns;
      eInput.value = ne;
      if (ns && ne) dr.classList.remove('invalid'); // 重新选成完整范围后清掉校验红框
      syncText();
      dr.dispatchEvent(new CustomEvent(DATE_RANGE_EVENT, {
        bubbles: true,
        detail: { planStart: ns || null, planEnd: ne || null },
      }));
    };

    const close = () => {
      pop.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      tmpStart = ''; // 未成对的半成品直接丢弃，避免写入“半个范围”
      syncText();
      openPops.delete(pop);
    };

    const open = () => {
      const { s } = read();
      const base = s ? new Date(`${s}T00:00:00`) : new Date();
      viewYear = base.getFullYear();
      viewMonth = base.getMonth();
      render();
      pop.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      openPops.set(pop, close);
    };

    /** 悬停预览：已选起点后，鼠标经过的日期与起点之间的区间高亮 */
    const previewTo = (to) => {
      pop.querySelectorAll('.cal-cell[data-date]').forEach((c) => {
        const ds = c.dataset.date;
        c.classList.toggle('preview', !!(tmpStart && to && ds > tmpStart && ds <= to));
      });
    };

    const render = () => {
      const { s, e } = read();
      const start = tmpStart || s;
      const end = tmpStart ? '' : e;
      pop.innerHTML = `
        <div class="cal-head">
          <button type="button" class="cal-nav" data-cal="-1" title="上一月">‹</button>
          <span class="cal-title">${viewYear}年${viewMonth + 1}月</span>
          <button type="button" class="cal-nav" data-cal="1" title="下一月">›</button>
        </div>
        <div class="cal-weekdays">${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="cal-grid">${calGridHtml(viewYear, viewMonth, start, end, today)}</div>
        <div class="cal-hint">${tmpStart ? `起点 ${esc(tmpStart)}，请再点选完成日期` : '点击选择开始日期，再点选完成日期'}</div>
        <div class="cal-quick">
          <button type="button" class="dr-quick" data-quick="today">今天</button>
          <button type="button" class="dr-quick" data-quick="tomorrow">明天</button>
          <button type="button" class="dr-quick" data-quick="weekend">本周末</button>
          ${tmpStart ? `<button type="button" class="dr-quick" data-quick="sameday">仅 ${esc(tmpStart.slice(5))} 当天</button>` : ''}
        </div>
        <div class="cal-foot">
          <span class="dr-selected">${tmpStart ? '选择中…' : (s && e ? `已选 ${esc(s)} ~ ${esc(e)}` : '未设置计划日期')}</span>
          <button type="button" class="dr-clear">清除</button>
        </div>`;

      pop.querySelectorAll('.cal-cell[data-date]').forEach((cell) => {
        const d = cell.dataset.date;
        cell.addEventListener('click', () => {
          if (!tmpStart) { tmpStart = d; syncText(); render(); return; }
          if (d < tmpStart) { tmpStart = d; syncText(); render(); return; } // 早于起点 → 改作新起点
          const startVal = tmpStart;
          tmpStart = '';
          commit(startVal, d); // 起点 → plan_start，本次点击 → plan_end
          close();
        });
        cell.addEventListener('mouseenter', () => previewTo(tmpStart ? d : ''));
      });
      pop.addEventListener('mouseleave', () => previewTo(''));

      pop.querySelectorAll('.cal-nav').forEach((n) => {
        n.addEventListener('click', () => {
          viewMonth += Number(n.dataset.cal);
          if (viewMonth < 0) { viewMonth = 11; viewYear--; }
          if (viewMonth > 11) { viewMonth = 0; viewYear++; }
          render();
        });
      });

      pop.querySelectorAll('[data-quick]').forEach((b) => {
        b.addEventListener('click', () => {
          const q = b.dataset.quick;
          if (q === 'today') { commit(today, today); close(); }
          else if (q === 'tomorrow') { const t = addDays(today, 1); commit(t, t); close(); }
          else if (q === 'weekend') {
            const idx = (new Date(`${today}T00:00:00`).getDay() + 6) % 7; // 周一=0，周六=5
            commit(addDays(today, 5 - idx), addDays(today, 6 - idx));
            close();
          } else if (q === 'sameday') { const v = tmpStart; tmpStart = ''; commit(v, v); close(); }
        });
      });

      pop.querySelector('.dr-clear').addEventListener('click', () => {
        tmpStart = '';
        commit('', '');
        render();
      });
    };

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop.hidden) open(); else close();
    });
    // Esc 关闭日历（阻止冒泡，避免同时关掉详情抽屉）
    dr.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || pop.hidden) return;
      e.stopPropagation();
      close();
      trigger.focus();
    });

    syncText();
  });
}

/** 读取日期范围 → { planStart, planEnd }（null 表示未设置） */
function getDateRange(container) {
  const dr = container.querySelector('.date-range-field');
  if (!dr) return { planStart: null, planEnd: null };
  const s = dr.querySelector('.dr-start-input');
  const e = dr.querySelector('.dr-end-input');
  return {
    planStart: (s && s.value) || null,
    planEnd: (e && e.value) || null,
  };
}

/**
 * 校验日期范围，返回 { ok, planStart, planEnd, message }。
 * required 未显式传入时取控件自身的 data-required（默认 0 → 计划日期非必填）。
 */
function validateDateRange(container, { required } = {}) {
  const { planStart, planEnd } = getDateRange(container);
  const dr = container.querySelector('.date-range-field');
  const need = required != null ? required : (dr && dr.dataset.required === '1');
  const fail = (message) => {
    if (dr) dr.classList.add('invalid');
    return { ok: false, planStart, planEnd, message };
  };
  if (need && (!planStart || !planEnd)) return fail('请先选择计划开始 / 完成日期');
  if (planStart && planEnd && planEnd < planStart) return fail('完成日期不能早于开始日期');
  if (dr) dr.classList.remove('invalid');
  return { ok: true, planStart, planEnd, message: '' };
}

/** 清除范围后同步提醒：依赖「计划完成日期」的预设自动回到「不提醒」 */
function syncReminderWithPlanEnd(container, planEnd) {
  const rf = container.querySelector('.reminder-field');
  if (!rf || planEnd) return;
  const preset = rf.querySelector('.reminder-preset');
  if (preset.value !== 'day9' && preset.value !== 'dayBefore18') return;
  preset.value = 'none';
  const custom = rf.querySelector('.reminder-custom');
  if (custom) custom.hidden = true;
}

/* ---------------- 快捷提醒（预设 + 自定义） ---------------- */

/** "YYYY-MM-DD" + "HH:mm" → UTC ISO */
function dateAtTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T${timeStr}:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function detectPreset(reminderAt, planEnd) {
  if (!reminderAt) return 'none';
  if (planEnd && reminderAt === dateAtTime(planEnd, '09:00')) return 'day9';
  if (planEnd && reminderAt === dateAtTime(addDays(planEnd, -1), '18:00')) return 'dayBefore18';
  return 'custom';
}

function reminderHtml(reminderAt, planEnd) {
  const preset = detectPreset(reminderAt, planEnd);
  return `
  <div class="reminder-field">
    <select class="reminder-preset">
      <option value="none"${preset === 'none' ? ' selected' : ''}>不提醒</option>
      <option value="day9"${preset === 'day9' ? ' selected' : ''}>完成日期当天 09:00</option>
      <option value="dayBefore18"${preset === 'dayBefore18' ? ' selected' : ''}>完成日期前 1 天 18:00</option>
      <option value="custom"${preset === 'custom' ? ' selected' : ''}>自定义时间</option>
    </select>
    <input type="datetime-local" class="reminder-custom" value="${esc(isoToLocal(reminderAt))}"${preset === 'custom' ? '' : ' hidden'} />
  </div>`;
}

function bindReminder(container) {
  container.querySelectorAll('.reminder-field').forEach((rf) => {
    const preset = rf.querySelector('.reminder-preset');
    const custom = rf.querySelector('.reminder-custom');
    preset.addEventListener('change', () => {
      custom.hidden = preset.value !== 'custom';
    });
  });
}

/** 根据预设与计划完成日期计算 reminder_at（UTC ISO 或 null） */
function computeReminder(container, planEnd) {
  const rf = container.querySelector('.reminder-field');
  if (!rf) return null;
  const preset = rf.querySelector('.reminder-preset').value;
  if (preset === 'day9') return dateAtTime(planEnd, '09:00');
  if (preset === 'dayBefore18') return dateAtTime(addDays(planEnd, -1), '18:00');
  if (preset === 'custom') return localToIso(rf.querySelector('.reminder-custom').value);
  return null;
}

/** 校验快捷提醒是否需要计划完成日期 */
function reminderNeedsPlanEnd(container) {
  const rf = container.querySelector('.reminder-field');
  if (!rf) return false;
  const preset = rf.querySelector('.reminder-preset').value;
  return preset === 'day9' || preset === 'dayBefore18';
}

export {
  DATE_RANGE_EVENT, DATE_RANGE_DEFAULTS,
  dateRangeFieldHtml, bindDateRangeFields, getDateRange, validateDateRange,
  defaultDateRange, todayStrLocal, addDays, normalizeDate,
  syncReminderWithPlanEnd,
  reminderHtml, bindReminder, computeReminder, reminderNeedsPlanEnd,
};
