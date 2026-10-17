'use strict';
/**
 * 表单控件（日期选择、快捷提醒），供编辑器与详情页复用。
 */
import { localToIso, isoToLocal } from './api.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** "YYYY-MM-DD" + "HH:mm" → UTC ISO */
function dateAtTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T${timeStr}:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** "YYYY-MM-DD" 加减天数 */
function addDays(dateStr, delta) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + delta);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------------- 日期选择控件（标签 + 点击弹出选择框） ---------------- */

function dateFieldHtml(field, label, value) {
  const v = value || '';
  return `
  <div class="date-field" data-field="${esc(field)}" data-label="${esc(label)}">
    <button type="button" class="date-field-btn">
      <span class="date-field-icon">📅</span>
      <span class="date-field-text">${esc(v || label)}</span>
    </button>
    <input type="date" class="date-field-input" value="${esc(v)}" />
  </div>`;
}

function bindDateFields(container) {
  container.querySelectorAll('.date-field').forEach((df) => {
    const label = df.dataset.label || '日期';
    const btn = df.querySelector('.date-field-btn');
    const input = df.querySelector('.date-field-input');
    const text = df.querySelector('.date-field-text');
    const update = () => { text.textContent = input.value || label; };
    btn.addEventListener('click', () => {
      try {
        input.showPicker();
      } catch (_e) {
        input.focus();
      }
    });
    input.addEventListener('change', update);
    update();
  });
}

function getDateField(container, field) {
  const input = container.querySelector(`[data-field="${field}"] .date-field-input`);
  return input && input.value ? input.value : null;
}

/* ---------------- 日期范围选择控件（日历点选起止） ---------------- */

function pad2(n) { return String(n).padStart(2, '0'); }

function todayStrLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 单月网格 HTML */
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

function dateRangeFieldHtml(startValue, endValue) {
  return `
  <div class="date-range-field">
    <button type="button" class="date-range-btn dr-start-btn" data-value="${esc(startValue || '')}">
      <span class="date-range-icon">📅</span>
      <span class="date-range-text">${esc(startValue || '开始日期')}</span>
    </button>
    <span class="dr-sep">~</span>
    <button type="button" class="date-range-btn dr-end-btn" data-value="${esc(endValue || '')}">
      <span class="date-range-icon">🏁</span>
      <span class="date-range-text">${esc(endValue || '完成日期')}</span>
    </button>
    <div class="date-range-pop" hidden></div>
  </div>`;
}

function bindDateRangeFields(container) {
  container.querySelectorAll('.date-range-field').forEach((dr) => {
    const startBtn = dr.querySelector('.dr-start-btn');
    const endBtn = dr.querySelector('.dr-end-btn');
    const pop = dr.querySelector('.date-range-pop');
    const startText = startBtn.querySelector('.date-range-text');
    const endText = endBtn.querySelector('.date-range-text');
    let start = startBtn.dataset.value || '';
    let end = endBtn.dataset.value || '';
    let viewYear;
    let viewMonth;
    const today = todayStrLocal();

    const initView = () => {
      const base = start ? new Date(`${start}T00:00:00`) : new Date();
      viewYear = base.getFullYear();
      viewMonth = base.getMonth();
    };
    const updateBtns = () => {
      startBtn.dataset.value = start;
      endBtn.dataset.value = end;
      startText.textContent = start || '开始日期';
      endText.textContent = end || '完成日期';
    };
    const render = () => {
      pop.innerHTML = `
        <div class="cal-head">
          <button type="button" class="cal-nav" data-cal="-1">‹</button>
          <span class="cal-title">${viewYear}年${viewMonth + 1}月</span>
          <button type="button" class="cal-nav" data-cal="1">›</button>
        </div>
        <div class="cal-weekdays">${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="cal-grid">${calGridHtml(viewYear, viewMonth, start, end, today)}</div>
        <div class="cal-foot"><button type="button" class="dr-clear">清除</button></div>`;
      pop.querySelectorAll('.cal-cell[data-date]').forEach((cell) => {
        cell.addEventListener('click', () => {
          const d = cell.dataset.date;
          if (!start || end) { start = d; end = ''; }
          else if (d >= start) { end = d; updateBtns(); pop.hidden = true; return; }
          else { start = d; end = ''; }
          updateBtns();
          render();
        });
      });
      pop.querySelectorAll('.cal-nav').forEach((n) => {
        n.addEventListener('click', () => {
          viewMonth += Number(n.dataset.cal);
          if (viewMonth < 0) { viewMonth = 11; viewYear--; }
          if (viewMonth > 11) { viewMonth = 0; viewYear++; }
          render();
        });
      });
      pop.querySelector('.dr-clear').addEventListener('click', () => {
        start = ''; end = '';
        updateBtns();
        render();
      });
    };

    const open = () => { initView(); render(); pop.hidden = false; };
    startBtn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    endBtn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    document.addEventListener('click', (e) => {
      if (!dr.contains(e.target)) pop.hidden = true;
    });
    updateBtns();
  });
}

/** 读取日期范围，返回 { planStart, planEnd } */
function getDateRange(container) {
  const dr = container.querySelector('.date-range-field');
  if (!dr) return { planStart: null, planEnd: null };
  return {
    planStart: dr.querySelector('.dr-start-btn').dataset.value || null,
    planEnd: dr.querySelector('.dr-end-btn').dataset.value || null,
  };
}

/* ---------------- 快捷提醒（预设 + 自定义） ---------------- */

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
  dateFieldHtml, bindDateFields, getDateField,
  dateRangeFieldHtml, bindDateRangeFields, getDateRange,
  reminderHtml, bindReminder, computeReminder, reminderNeedsPlanEnd,
};
