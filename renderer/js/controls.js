'use strict';
/**
 * 表单控件（计划日期范围、快捷提醒），供列表底部编辑器与任务详情抽屉复用。
 *
 * 计划日期范围控件的设计约定：
 *  1. 单一触发器：开始日期 / 完成日期合并为一个控件，**点一次只弹一个日历**。
 *  2. 两次点选成范围：第 1 次点击 = 计划开始日期 plan_start，第 2 次点击 =
 *     计划完成日期 plan_end；选满两个日期后**自动关闭**并回填。
 *  3. 数据绑定：两个隐藏 input（.dr-start-input / .dr-end-input）是唯一数据源，
 *     宿主通过 getDateRange() 读取，或直接监听冒泡事件 'date-range:change'。
 *  4. 一致性：出现 end < start 会自动交换，因此落到后端的永远是成对且有序的值。
 *
 * 实现：不再手写日历，改用第三方库 **flatpickr**（v4，零依赖，已 vendor 到
 * renderer/vendor/flatpickr/）。理由：
 *  - range 模式本身就是「两次点选成范围 + 选满自动关闭」，弹层次数由上游保证；
 *  - 面板由 flatpickr 自己挂到 body 并计算位置，不受 .detail-body{overflow:auto} 裁剪；
 *  - 跨月、闰月、键盘操作、无障碍都在上游维护，我们只保留一层薄封装。
 *
 * 两种形态（由设置中心「通用 → 计划模式」切换，全局共享，计划模式默认开启）：
 *  - 日期段（计划模式，默认）：flatpickr mode='range'，两次点选起止日，适合年度 / 季度计划；
 *  - 单日期（关闭计划模式后）：flatpickr mode='single'，点一天即截止日，底层 plan_start=plan_end=该日，
 *    与「今天」视图默认值、截图 / 语音建任务的落库约定一致。
 */
import { localToIso, isoToLocal } from './api.js';
import { t as tr } from './i18n.js';

/** 控件形态：true=单截止日期，false=起止日期段（计划模式，默认）。所有宿主共享这一份。 */
let singleDateMode = false;
function setSingleDateMode(enabled) { singleDateMode = !!enabled; }
function isSingleDateMode() { return singleDateMode; }

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 范围变化后对外派发的事件名，detail = { planStart, planEnd } */
const DATE_RANGE_EVENT = 'date-range:change';

/** 日期范围控件的默认行为（宿主可用 opts 覆盖） */
const DATE_RANGE_DEFAULTS = {
  placeholder: '计划日期', // 未选择时的占位文案（单日期形态下改用「截止日期」）
  required: false,         // 计划开始 / 完成日期是否必填
  single: null,            // null=跟随全局形态；true=单日期；false=日期段
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

/* ---------------- 日期范围控件（flatpickr · range 模式） ---------------- */

/**
 * 自定义定位：默认放在触发器下方，下方空间不足则上翻，
 * 最后统一收敛进视口 —— flatpickr 自带的 auto 只在「上方也放得下」时才上翻，
 * 子任务行位于抽屉底部时会有一部分掉出屏幕，所以这里自己算。
 */
function positionRangeCalendar(instance, anchor) {
  const cal = instance.calendarContainer;
  if (!cal || !cal.offsetWidth) return;
  const b = anchor.getBoundingClientRect();
  const m = 8;
  const w = cal.offsetWidth;
  const h = cal.offsetHeight;
  let left = b.left;
  if (left + w > window.innerWidth - m) left = window.innerWidth - m - w;
  if (left < m) left = m;
  let top = b.bottom + 6;
  if (top + h > window.innerHeight - m) {
    const above = b.top - h - 6;
    top = above >= m ? above : Math.max(m, window.innerHeight - m - h);
  }
  cal.style.position = 'absolute';
  cal.style.left = `${Math.round(window.pageXOffset + left)}px`;
  cal.style.top = `${Math.round(window.pageYOffset + top)}px`;
}

/** 已绑定的控件登记表：宿主被重渲染移除后要 destroy，否则 body 里会留下孤儿日历 */
const boundRanges = new Set();

/** Date → 'YYYY-MM-DD'（本地时区，不走 ISO 以免跨天） */
function fmtDay(d) {
  if (!d || isNaN(new Date(d).getTime())) return '';
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** 中文语言包 + 周一作为每周第一天（官方 zh 包自身没设 firstDayOfWeek） */
function rangeLocale() {
  const l10ns = (typeof flatpickr !== 'undefined' && flatpickr.l10ns) || {};
  return { ...(l10ns.zh || {}), firstDayOfWeek: 1 };
}

/** 清理已被重渲染移除的实例 */
function sweepDetachedRanges() {
  boundRanges.forEach((entry) => {
    if (entry.field.isConnected) return;
    try { entry.instance.destroy(); } catch (_) { /* 宿主已销毁，忽略 */ }
    boundRanges.delete(entry);
  });
}

/**
 * 面板是 absolute 定位在 body 上的：抽屉 / 列表内部的滚动不会带上它，
 * 这里统一补一次位置跟随（只绑一遍 document 级监听，避免每个控件都挂一个）。
 */
let rangeViewHandlersBound = false;
function ensureRangeViewHandlers() {
  if (rangeViewHandlersBound) return;
  rangeViewHandlersBound = true;
  const reposition = () => {
    boundRanges.forEach((entry) => {
      if (entry.instance.isOpen) positionRangeCalendar(entry.instance, entry.anchor);
    });
  };
  document.addEventListener('scroll', reposition, { capture: true, passive: true });
  window.addEventListener('resize', reposition);
}

function dateRangeFieldHtml(startValue, endValue, opts = {}) {
  const cfg = { ...DATE_RANGE_DEFAULTS, ...opts };
  const single = cfg.single == null ? singleDateMode : !!cfg.single;
  const placeholder = single ? tr('截止日期') : cfg.placeholder;
  let s = normalizeDate(startValue);
  let e = normalizeDate(endValue);
  if (s && e && e < s) { const t = s; s = e; e = t; } // 历史数据倒序时兜底纠正
  const days = single ? 0 : daysBetween(s, e);
  const label = single
    ? (e ? tr('截止 {date}', { date: e }) : placeholder)
    : (s && e ? `${s} ~ ${e}` : (s ? `${s} 起` : placeholder));
  const title = single ? tr('点击选择截止日期') : tr('点击选择计划开始 / 完成日期（只需一次）');
  return `
  <div class="date-range-field${single ? ' is-single' : ''}" data-single="${single ? '1' : '0'}" data-required="${cfg.required ? '1' : '0'}" data-placeholder="${esc(placeholder)}">
    <button type="button" class="date-range-trigger${(single ? e : s) ? '' : ' is-empty'}" aria-haspopup="dialog" aria-expanded="false" title="${esc(title)}">
      <span class="dr-icon">📅</span>
      <span class="dr-text">${esc(label)}</span>
      <span class="dr-days"${days ? '' : ' hidden'}>${days ? `${days} 天` : ''}</span>
      <span class="dr-caret">▾</span>
    </button>
    <!-- flatpickr 的挂载锚点：铺满整个控件但不参与交互，日历按它的位置定位 -->
    <input type="text" class="dr-input" tabindex="-1" readonly aria-hidden="true" />
    <input type="hidden" class="dr-start-input" data-field="planStart" value="${esc(s)}" />
    <input type="hidden" class="dr-end-input" data-field="planEnd" value="${esc(e)}" />
  </div>`;
}

/**
 * 在 flatpickr 面板底部补一行快捷操作（今天 / 明天 / 本周末 / 清除）。
 * 面板 DOM 由 flatpickr 生成并复用，这里只追加一次。
 */
function buildRangeFooter(instance, onPick, single) {
  const cal = instance.calendarContainer;
  if (!cal || cal.querySelector('.dr-fp-foot')) return;
  const foot = document.createElement('div');
  foot.className = 'dr-fp-foot';
  foot.innerHTML = `
    <span class="dr-fp-hint">${single ? tr('选一天作为截止日期') : tr('点第 1 次 = 开始日期，点第 2 次 = 完成日期')}</span>
    <div class="dr-fp-quick">
      <button type="button" class="dr-quick" data-quick="today">${tr('今天')}</button>
      <button type="button" class="dr-quick" data-quick="tomorrow">${tr('明天')}</button>
      ${single ? '' : `<button type="button" class="dr-quick" data-quick="weekend">${tr('本周末')}</button>`}
      <span class="dr-fp-spacer"></span>
      <button type="button" class="dr-clear" data-quick="clear">${tr('清除')}</button>
    </div>`;
  // 阻止冒泡：避免脚部点击被 flatpickr 当成「点外部」而提前收起面板
  foot.addEventListener('mousedown', (e) => e.stopPropagation());
  foot.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const t = todayStrLocal();
    const q = btn.dataset.quick;
    if (q === 'today') onPick(single ? [t] : [t, t]);
    else if (q === 'tomorrow') { const d = addDays(t, 1); onPick(single ? [d] : [d, d]); }
    else if (q === 'weekend') {
      const idx = (new Date(`${t}T00:00:00`).getDay() + 6) % 7; // 周一=0，周六=5
      onPick([addDays(t, 5 - idx), addDays(t, 6 - idx)]);
    } else if (q === 'clear') onPick([]);
  });
  cal.appendChild(foot);
}

function bindDateRangeFields(container) {
  sweepDetachedRanges();
  // 依赖缺失时不阻塞页面：保留只读标签，只是不能选日期
  const flatpickrLib = typeof window !== 'undefined' ? window.flatpickr : null;
  if (!flatpickrLib) {
    console.warn('[controls] flatpickr 未加载，日期范围控件降级为只读');
    return;
  }

  container.querySelectorAll('.date-range-field').forEach((dr) => {
    if (dr.dataset.drBound === '1') return; // 同一 DOM 不重复绑定
    dr.dataset.drBound = '1';
    const single = dr.dataset.single === '1';

    const trigger = dr.querySelector('.date-range-trigger');
    const anchor = dr.querySelector('.dr-input');
    const sInput = dr.querySelector('.dr-start-input');
    const eInput = dr.querySelector('.dr-end-input');
    const textEl = dr.querySelector('.dr-text');
    const daysEl = dr.querySelector('.dr-days');
    const placeholder = dr.dataset.placeholder || '计划日期';

    const syncText = (s, e) => {
      if (single) {
        textEl.textContent = e ? tr('截止 {date}', { date: e }) : placeholder;
      } else {
        textEl.textContent = s && e ? `${s} ~ ${e}` : (s ? `${s} 起` : placeholder);
      }
      trigger.classList.toggle('is-empty', !(single ? e : s));
      const d = single ? 0 : daysBetween(s, e);
      daysEl.textContent = d ? `${d} 天` : '';
      daysEl.hidden = !d;
    };

    /** 唯一的写入口：写隐藏字段 → 刷新触发器文案 → 派发变更事件 */
    const apply = (dates) => {
      let s = fmtDay(dates[0]);
      let e = fmtDay(dates[1]);
      if (single) {
        // 单日期形态：点一天即截止日；起止写同一天，与 today 默认 / 截图语音建任务一致。
        // 注意 apply 只在用户真的选了日期后才触发，编辑旧的范围任务时不碰它就不会被压平。
        s = e || s;
        e = s;
      } else if (s && e && e < s) { const t = s; s = e; e = t; }
      sInput.value = s;
      eInput.value = e;
      if (s && e) dr.classList.remove('invalid'); // 重新选成完整范围后清掉校验红框
      syncText(s, e);
      dr.dispatchEvent(new CustomEvent(DATE_RANGE_EVENT, {
        bubbles: true,
        detail: { planStart: s || null, planEnd: e || null },
      }));
    };

    /** 快捷操作统一入口：写回面板 → 同步数据 → 收起面板 */
    const setRange = (values) => {
      instance.setDate(values, false);
      apply(instance.selectedDates);
      instance.close();
    };

    const initial = [];
    if (single) {
      // 单日期形态回显截止日；旧范围任务在关闭日期段模式后仍只显示 plan_end
      const day = normalizeDate(eInput.value) || normalizeDate(sInput.value);
      if (day) initial.push(day);
    } else {
      if (sInput.value) initial.push(sInput.value);
      if (eInput.value && eInput.value !== sInput.value) initial.push(eInput.value);
    }

    const instance = flatpickrLib(anchor, {
      mode: single ? 'single' : 'range',
      dateFormat: 'Y-m-d',
      locale: rangeLocale(),
      monthSelectorType: 'static',
      animate: false,         // 不做位移动画，避免呼出/收起时“跳一下”
      allowInput: false,
      clickOpens: false,      // 只由触发器开合：否则 focus 与 click 各开一次，会连弹两次
      defaultDate: initial,
      // 自己算位置（保证完整落在视口内），不走 flatpickr 自带的 auto 翻转
      position: (self, el) => positionRangeCalendar(self, el || anchor),
      // 触发器按钮不算「点击外部」：否则 mousedown 先关、click 再开，永远关不掉
      ignoredFocusElements: [trigger],
      onChange: (dates) => apply(dates), // 选满 2 个日期时 flatpickr 会自动 close（closeOnSelect 默认 true）
      onOpen: () => {
        trigger.setAttribute('aria-expanded', 'true');
        // 面板高度依赖内部渲染结果，下一帧再量一次更稳
        requestAnimationFrame(() => positionRangeCalendar(instance, anchor));
      },
      onClose: () => trigger.setAttribute('aria-expanded', 'false'),
      onReady: (_dates, _value, self) => buildRangeFooter(self, setRange, single),
    });

    boundRanges.add({ field: dr, instance, anchor });
    ensureRangeViewHandlers();

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (instance.isOpen) instance.close(); else instance.open();
    });

    syncText(sInput.value, eInput.value);
  });
}

/** 是否有日期面板正在打开（详情抽屉的 Esc 关闭需要据此让路） */
function isAnyRangeOpen() {
  return !!document.querySelector('.flatpickr-calendar.open');
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
  const single = !!(dr && dr.dataset.single === '1');
  const need = required != null ? required : (dr && dr.dataset.required === '1');
  const fail = (message) => {
    if (dr) dr.classList.add('invalid');
    return { ok: false, planStart, planEnd, message };
  };
  if (need && (single ? !planEnd : (!planStart || !planEnd))) {
    return fail(single ? tr('请先选择截止日期') : tr('请先选择计划开始 / 完成日期'));
  }
  if (!single && planStart && planEnd && planEnd < planStart) return fail('完成日期不能早于开始日期');
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
  defaultDateRange, todayStrLocal, addDays, normalizeDate, isAnyRangeOpen,
  setSingleDateMode, isSingleDateMode,
  syncReminderWithPlanEnd,
  reminderHtml, bindReminder, computeReminder, reminderNeedsPlanEnd,
};
