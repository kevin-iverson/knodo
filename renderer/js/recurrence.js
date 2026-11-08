'use strict';
/**
 * 重复事项 / 习惯（渲染层）。
 *
 * 三个宿主共用同一套配置片段：
 *  1. 任务列表就地编辑器的「🔁 设为重复」；
 *  2. 任务详情抽屉的「重复与提醒」区；
 *  3. File 菜单「重复事项与习惯…」打开的管理面板（调整 / 停止 / 打卡记录）。
 *
 * 一条重复事项只有一条任务；规则只是它的属性，每次完成按发生日单独记一次打卡。
 * 规则语义与日期展开只在主进程 recurrence-rules.js 里有一份，这里只收集表单值、
 * 展示摘要 / 预览 / 统计，不判断「哪些天该发生」。
 */
import { api } from './api.js';
import { openPanelModal } from './modal.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FREQS = ['daily', 'workday', 'weekly', 'monthly'];
const HOLIDAY_MODES = ['none', 'skip', 'cn'];
const WEEKDAYS = [
  { v: 1, l: '一' }, { v: 2, l: '二' }, { v: 3, l: '三' }, { v: 4, l: '四' },
  { v: 5, l: '五' }, { v: 6, l: '六' }, { v: 0, l: '日' },
];

let handlers = { onChanged: null, toast: null };
/** ui.js 注入刷新与提示能力，避免这里反向 import ui.js */
export function setRecurrenceHandlers(h = {}) {
  handlers = { ...handlers, ...h };
}
function toast(msg) { if (typeof handlers.toast === 'function') handlers.toast(msg); }
function changed() { if (typeof handlers.onChanged === 'function') return handlers.onChanged(); }

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------------- 派生时间的展示（只读） ---------------- */

const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DD' → 本地 Date（不走 Date 解析，避免时区把它挪到前一天） */
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** 11-09 */
function shortDay(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s).slice(5) : '';
}

/** 11-09（周一） */
function dayText(s) {
  const d = parseDay(s);
  return d ? `${shortDay(s)}（${WEEKDAY_TEXT[d.getDay()]}）` : '';
}

/** UTC ISO → 本地 「11-08 09:00」 */
function timeText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 重复事项的当前状态（列表徽标 / 详情只读区 / 「今天」说明区共用一份判断）。
 *
 * `occurrence_date` 表示「当前这一次发生」：规则启用且今天就是发生日 → 等于今天；
 * 今天不发生 → 是**下一次**发生日（未来）；规则暂停 / 已过结束日 → null。
 *
 * @returns {{state:'today'|'next'|'paused'|'ended'|'idle', label:string, nextDate:string}}
 */
export function recurState(task, rule) {
  const today = todayStr();
  const enabled = !rule || rule.enabled !== false;
  const end = (rule && rule.end_date) || '';
  const occ = (task && task.occurrence_date) || '';
  if (!enabled) return { state: 'paused', label: '已暂停', nextDate: '' };
  if (end && today > end) return { state: 'ended', label: `已结束（${shortDay(end)}）`, nextDate: '' };
  if (!occ) return { state: 'idle', label: '暂无排期', nextDate: '' };
  if (occ === today) return { state: 'today', label: '今天', nextDate: occ };
  return { state: 'next', label: `下次 ${dayText(occ)}`, nextDate: occ };
}

/** 规则里的「截止日偏移」天数（0 = 发生当天） */
function dueOffsetOf(rule) {
  const n = Number(rule && rule.rule && rule.rule.dueOffsetDays);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * 重复事项的「本次时间」只读展示。
 *
 * 为什么不做成可编辑控件：计划开始 = 发生日、截止 = 发生日 + 偏移、提醒 = 发生日 - 提前天数，
 * 三者全是规则派生值。做成输入框既会和日切抢写（P-02），又会让「计划时间 11-08~11-10」
 * 与「有效期 11/08」「结束日 11/10」三处日期互相看起来像 bug（P-01 / P-05）。
 */
export function derivedScheduleHtml(task, rule) {
  const st = recurState(task, rule);
  const due = dueOffsetOf(rule);
  const chips = [];
  if (st.state === 'paused' || st.state === 'ended' || st.state === 'idle') {
    chips.push(`<span class="rpt-derived-chip is-weak">🔁 ${esc(st.label)}</span>`);
  } else {
    const head = st.state === 'today'
      ? `🔁 本次 ${dayText(task.occurrence_date)}`
      : `⏳ 今天不发生 · 下次 ${dayText(task.occurrence_date)}`;
    chips.push(`<span class="rpt-derived-chip is-strong">${esc(head)}</span>`);
    if (due) chips.push(`<span class="rpt-derived-chip">⏰ 截止 ${dayText(task.plan_end)} · 发生日 + ${due} 天</span>`);
    else if (task.plan_end) chips.push('<span class="rpt-derived-chip">⏰ 当天完成</span>');
    chips.push(task.reminder_at
      ? `<span class="rpt-derived-chip">🔔 提醒 ${esc(timeText(task.reminder_at))}</span>`
      : '<span class="rpt-derived-chip is-weak">🔔 不提醒</span>');
  }
  return `<div class="rpt-derived" data-rpt-derived="1" title="由下面的重复规则派生，改规则才会变">
    ${chips.join('')}
    <span class="rpt-derived-hint">由重复规则派生，改规则才会变</span>
  </div>`;
}

/** 任务行里的重复事项状态角标（「今天不发生 · 下次 …」/「已暂停」/「已结束」） */
export function recurStateBadgeHtml(task, rule) {
  const st = recurState(task, rule);
  if (st.state === 'today') return '';
  const cls = ['recur-state', `is-${st.state}`].join(' ');
  const text = st.state === 'next'
    ? `今天不发生 · 下次 ${dayText(task.occurrence_date)}`
    : st.label;
  return `<span class="${cls}" title="按重复规则：${esc(rule && rule.summary ? rule.summary : text)}">${esc(text)}</span>`;
}


/** 只用于回填表单；服务端还会再归一化一次，脏值不会入库 */
function clientRule(rule) {
  const r = rule && typeof rule === 'object' ? rule : {};
  const num = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
  };
  const freq = FREQS.includes(r.freq) ? r.freq : 'daily';
  return {
    freq,
    interval: num(r.interval, 1, 365, 1),
    weekdays: Array.isArray(r.weekdays) && r.weekdays.length ? r.weekdays.map(Number) : [1, 2, 3, 4, 5],
    monthDays: Array.isArray(r.monthDays) && r.monthDays.length ? r.monthDays.map(Number) : [1],
    // 「法定工作日」在主进程是强制 cn 口径，回填也保持一致，避免下拉显示「不处理」却按 cn 生成
    holidayMode: freq === 'workday' ? 'cn' : (HOLIDAY_MODES.includes(r.holidayMode) ? r.holidayMode : 'none'),
    reminderTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.reminderTime || '')) ? r.reminderTime : '',
    reminderOffsetDays: num(r.reminderOffsetDays, 0, 30, 0),
    dueOffsetDays: num(r.dueOffsetDays, 0, 30, 0),
  };
}

/* ---------------- 配置片段（编辑器 / 管理面板共用） ---------------- */

function monthDaysText(list) {
  return (list || []).map((d) => (d === -1 ? '末' : String(d))).join(',');
}

function parseMonthDays(text) {
  const out = [];
  for (const part of String(text || '').split(/[,，、\s]+/)) {
    const s = part.trim();
    if (!s) continue;
    if (/^(末|last|L|-1)$/i.test(s)) { if (!out.includes(-1)) out.push(-1); continue; }
    const n = Number(s);
    if (Number.isInteger(n) && n >= 1 && n <= 31 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b).slice(0, 12);
}

function optionHtml(value, label, selected) {
  return `<option value="${value}"${String(selected) === String(value) ? ' selected' : ''}>${label}</option>`;
}

/**
 * 规则字段表单（不含「是否开启」开关）。
 * 单日用原生 <input type="date">：平台控件自带日历/键盘/校验，
 * 不自己实现弹层；项目里的 flatpickr 只管「计划开始~完成」那个范围控件。
 */
export function repeatFieldsHtml(ctx = {}) {
  const r = clientRule(ctx.rule);
  const start = ctx.startDate || todayStr();
  const end = ctx.endDate || '';
  const isWeekly = r.freq === 'weekly';
  const isMonthly = r.freq === 'monthly';
  const unit = r.freq === 'weekly' ? '周' : (r.freq === 'monthly' ? '个月' : '天');
  const dueOptions = [0, 1, 2, 3, 5, 7, 14]
    .map((n) => optionHtml(n, n === 0 ? '发生当天完成' : `发生日 + ${n} 天`, r.dueOffsetDays));
  return `
  <div class="rpt-fields" data-rpt-fields="1">
    <div class="rpt-quick">
      <span class="rpt-quick-label">常用</span>
      <button type="button" class="rpt-chip" data-rpt-quick="daily">每天</button>
      <button type="button" class="rpt-chip" data-rpt-quick="workday">每个法定工作日</button>
      <button type="button" class="rpt-chip" data-rpt-quick="weekdays">每周一~五</button>
      <button type="button" class="rpt-chip" data-rpt-quick="monthly">每月 1 日</button>
    </div>
    <div class="rpt-grid">
      <label class="rpt-field"><span>重复频率</span>
        <select class="rpt-freq">
          ${optionHtml('daily', '每天 / 每 N 天', r.freq)}
          ${optionHtml('workday', '每个法定工作日（含调休）', r.freq)}
          ${optionHtml('weekly', '每周指定星期几', r.freq)}
          ${optionHtml('monthly', '每月指定日期', r.freq)}
        </select>
      </label>
      <label class="rpt-field rpt-interval-wrap"><span>间隔</span>
        <span class="rpt-inline">每 <input type="number" class="rpt-interval" min="1" max="365" value="${r.interval}" /> <em class="rpt-unit">${unit}</em></span>
      </label>
      <label class="rpt-field"><span>节假日口径</span>
        <select class="rpt-holiday">
          ${optionHtml('none', '不处理（按星期照常生成）', r.holidayMode)}
          ${optionHtml('skip', '跳过法定假期', r.holidayMode)}
          ${optionHtml('cn', '只按法定工作日（含调休补班）', r.holidayMode)}
        </select>
      </label>
    </div>
    <div class="rpt-conditional rpt-weekdays"${isWeekly ? '' : ' hidden'}>
      <span class="rpt-field-label">星期几</span>
      <div class="rpt-checks">
        ${WEEKDAYS.map((w) => `<label class="rpt-check"><input type="checkbox" class="rpt-weekday" value="${w.v}"${r.weekdays.includes(w.v) ? ' checked' : ''} /><span>周${w.l}</span></label>`).join('')}
      </div>
    </div>
    <div class="rpt-conditional rpt-monthdays"${isMonthly ? '' : ' hidden'}>
      <label class="rpt-field"><span>每月哪几天</span>
        <input type="text" class="rpt-monthdays-input" value="${esc(monthDaysText(r.monthDays))}" placeholder="如 1,15,末" />
      </label>
      <span class="rpt-tip">用逗号分隔 1~31；「末」表示当月最后一天。短月没有的日期自动跳过。</span>
    </div>
    <div class="rpt-grid">
      <label class="rpt-field"><span>提醒时间</span>
        <input type="time" class="rpt-remind-time" value="${esc(r.reminderTime)}" title="留空 = 不提醒" />
      </label>
      <label class="rpt-field"><span>提前提醒</span>
        <span class="rpt-inline"><input type="number" class="rpt-remind-offset" min="0" max="30" value="${r.reminderOffsetDays}" /> 天</span>
      </label>
      <label class="rpt-field"><span>截止日（到期日）</span>
        <select class="rpt-due-offset">${dueOptions}</select>
      </label>
      <label class="rpt-field"><span>生效日</span>
        <input type="date" class="rpt-start" value="${esc(start)}" />
      </label>
      <label class="rpt-field"><span>结束日（留空 = 一直重复）</span>
        <input type="date" class="rpt-end" value="${esc(end)}" />
      </label>
      <label class="rpt-check rpt-habit-field"><input type="checkbox" class="rpt-habit"${ctx.habit ? ' checked' : ''} /><span>作为习惯，记录每次完成</span></label>
    </div>
    <div class="rpt-preview" hidden></div>
    <div class="rpt-note">开启后只保留<strong>一条任务</strong>：按规则在「今天」等视图里出现并按时提醒，不会为每一天各生成一条。计划时间与提醒由规则派生（本次 = 发生日，截止 = 发生日 + 截止日偏移，提醒 = 发生日 - 提前天数），界面上只读展示，不再手填。每次勾选完成记一次打卡，跨天自动重置；改规则只改这一条，历史打卡一律保留。</div>
  </div>`;
}

/** 从 .rpt-fields 读回规则配置 */
export function readRepeatFields(root) {
  const el = root && root.querySelector ? root : null;
  const q = (sel) => (el ? el.querySelector(sel) : null);
  const num = (sel, def) => {
    const n = Number(q(sel) && q(sel).value);
    return Number.isFinite(n) ? n : def;
  };
  const freq = (q('.rpt-freq') && q('.rpt-freq').value) || 'daily';
  const weekdays = [...(el ? el.querySelectorAll('.rpt-weekday:checked') : [])].map((x) => Number(x.value));
  return {
    rule: {
      freq,
      interval: num('.rpt-interval', 1),
      weekdays,
      monthDays: parseMonthDays(q('.rpt-monthdays-input') && q('.rpt-monthdays-input').value),
      holidayMode: (q('.rpt-holiday') && q('.rpt-holiday').value) || 'none',
      reminderTime: (q('.rpt-remind-time') && q('.rpt-remind-time').value) || '',
      reminderOffsetDays: num('.rpt-remind-offset', 0),
      dueOffsetDays: num('.rpt-due-offset', 0),
    },
    startDate: (q('.rpt-start') && q('.rpt-start').value) || todayStr(),
    endDate: (q('.rpt-end') && q('.rpt-end').value) || null,
    habit: !!(q('.rpt-habit') && q('.rpt-habit').checked),
  };
}

export function validateRepeatFields(root) {
  const c = readRepeatFields(root);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.startDate)) return { ok: false, message: '请选择生效日期' };
  if (c.endDate && c.endDate < c.startDate) return { ok: false, message: '结束日期不能早于生效日期' };
  if (c.rule.freq === 'weekly' && !c.rule.weekdays.length) return { ok: false, message: '请至少选择一个星期几' };
  if (c.rule.freq === 'monthly' && !c.rule.monthDays.length) return { ok: false, message: '请填写每月的日期，如 1,15,末' };
  if (c.rule.reminderOffsetDays > 0 && !c.rule.reminderTime) return { ok: false, message: '提前提醒需要填写提醒时间' };
  return { ok: true, message: '', ...c };
}

/* ---------------- 就地编辑器里的「设为重复」 ---------------- */

/** 新建重复事项的默认值：与用户示例「每个法定工作日提醒」一致，开箱即有提醒 */
export const DEFAULT_REPEAT_RULE = Object.freeze({ freq: 'workday', reminderTime: '09:00' });

export function repeatEditorHtml(task, rule) {
  if (task && task.recurring_id != null) {
    return `<div class="rpt-instance-note">
      <span class="rpt-instance-ico">🔁</span>
      <span>重复事项：始终只有这一条任务，按规则出现在「今天」；勾选完成记一次打卡。</span>
      <button type="button" class="link-btn" data-act="open-recur-inline" data-rule-id="${Number(task.recurring_id)}" title="修改规则 / 查看打卡记录">编辑规则与打卡 →</button>
    </div>
    ${derivedScheduleHtml(task, rule)}`;
  }
  return `<div class="rpt-block" data-on="0">
    <button type="button" class="rpt-toggle" data-act="editor-repeat" aria-pressed="false"
            title="一条任务按规则每天出现在「今天」并按时提醒，也可作为习惯打卡">🔁 设为重复</button>
    <div class="rpt-panel" hidden>
      <div class="rpt-takeover-note">开启后按规则生成发生日：上方「计划时间」与「提醒」由重复规则接管（保存后显示为只读的派生信息），无需再手动填写。</div>
      ${repeatFieldsHtml({ rule: DEFAULT_REPEAT_RULE, today: todayStr() })}
    </div>
  </div>`;
}

/** 编辑器是否开启了重复 */
export function isRepeatOn(ed) {
  const b = ed.querySelector('.rpt-block');
  return !!b && b.dataset.on === '1';
}

/** 供 saveEditor 读取：未开启返回 { enabled:false } */
export function readRepeatConfig(ed) {
  if (!isRepeatOn(ed)) return { enabled: false };
  const v = validateRepeatFields(ed.querySelector('.rpt-fields'));
  if (!v.ok) return { enabled: true, invalid: v.message };
  return { enabled: true, rule: v.rule, startDate: v.startDate, endDate: v.endDate, habit: v.habit };
}

function updatePreview(fieldsEl) {
  if (!fieldsEl) return;
  const box = fieldsEl.querySelector('.rpt-preview');
  if (!box) return;
  const c = readRepeatFields(fieldsEl);
  // 序号挂在各自的预览框上：管理面板与列表编辑器同时存在时不会互相取消
  const seq = Number(box.dataset.rptSeq || 0) + 1;
  box.dataset.rptSeq = String(seq);
  // 结束日必须一起传：只传规则的话后端只能按 today+400 截断，于是「结束日 11/10」的规则
  // 也会在预览里一路排到 11/18（P-03）。起点也一并交给后端按 max(今天, 生效日) 收敛。
  const fire = () => api.recurrences.preview({ rule: c.rule, startDate: c.startDate, endDate: c.endDate })
    .then((days) => {
      if (Number(box.dataset.rptSeq) !== seq || !box.isConnected) return;
      box.hidden = false;
      // 标题标出预览区间：否则「接下来 N 次」从哪天起算、到哪天为止全靠猜（P-11）
      const from = c.startDate > todayStr() ? shortDay(c.startDate) : '今天';
      const span = c.endDate ? `${from} ~ ${shortDay(c.endDate)}` : `${from} 起`;
      box.innerHTML = days && days.length
        ? `<span class="rpt-preview-label">接下来 ${days.length} 次 · ${esc(span)}</span>${days.slice(0, 8).map((d) => `<span class="rpt-preview-day">${esc(d.slice(5))}</span>`).join('')}${days.length > 8 ? '<span class="rpt-preview-more">…</span>' : ''}`
        : `<span class="rpt-preview-empty">${c.endDate && c.endDate < todayStr() ? '结束日已过，没有发生日' : '当前设置下近期没有发生日，请检查频率 / 结束日期'}</span>`;
    })
    .catch(() => { if (box) box.hidden = true; });
  // 打字 / 拖数字时防抖，避免每次按键都发一次 IPC
  clearTimeout(box.__rptTimer);
  box.__rptTimer = setTimeout(fire, 220);
}

/** 绑定编辑器 / 管理面板内所有重复字段的联动；同一 DOM 只绑一次 */
export function bindRepeatEditor(root, { onInput } = {}) {
  if (!root || root.dataset.rptBound === '1') return;
  root.dataset.rptBound = '1';
  const block = root.querySelector('.rpt-block');
  const toggle = root.querySelector('.rpt-toggle');
  if (block && toggle) {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const on = block.dataset.on !== '1';
      block.dataset.on = on ? '1' : '0';
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      toggle.classList.toggle('is-on', on);
      toggle.textContent = on ? '🔁 重复：已开启' : '🔁 设为重复';
      const panel = block.querySelector('.rpt-panel');
      if (panel) panel.hidden = !on;
      if (on) updatePreview(panel.querySelector('.rpt-fields'));
      if (typeof onInput === 'function') onInput();
    });
  }

  root.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-rpt-quick]');
    if (!chip || !root.contains(chip)) return;
    e.preventDefault();
    applyQuick(root, chip.dataset.rptQuick);
    if (typeof onInput === 'function') onInput();
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.closest('.rpt-fields')) return;
    if (t.classList.contains('rpt-freq')) syncConditionals(root, t.value);
    updatePreview(root.querySelector('.rpt-fields'));
    if (typeof onInput === 'function') onInput();
  });
  root.addEventListener('input', (e) => {
    if (!e.target || !e.target.closest('.rpt-fields')) return;
    updatePreview(root.querySelector('.rpt-fields'));
    if (typeof onInput === 'function') onInput();
  });
  // 初始态也要按当前频率收敛（否则「每个法定工作日」下仍显示间隔与周几）
  const initialFields = root.querySelector('.rpt-fields');
  const freqSel = initialFields && initialFields.querySelector('.rpt-freq');
  if (freqSel) syncConditionals(root, freqSel.value);
}

function syncConditionals(root, freq) {
  const fields = root.querySelector('.rpt-fields');
  if (!fields) return;
  const week = fields.querySelector('.rpt-weekdays');
  const month = fields.querySelector('.rpt-monthdays');
  const intervalWrap = fields.querySelector('.rpt-interval-wrap');
  const unit = fields.querySelector('.rpt-unit');
  const holiday = fields.querySelector('.rpt-holiday');
  if (week) week.hidden = freq !== 'weekly';
  if (month) month.hidden = freq !== 'monthly';
  if (intervalWrap) intervalWrap.hidden = freq === 'workday';
  if (unit) unit.textContent = freq === 'weekly' ? '周' : (freq === 'monthly' ? '个月' : '天');
  // 「法定工作日」= 每天 + 只保留 cn 工作日，口径由主进程强制；下拉锁住免得看起来可选
  if (holiday) {
    if (freq === 'workday') { holiday.value = 'cn'; holiday.disabled = true; }
    else holiday.disabled = false;
  }
}

function applyQuick(root, key) {
  const fields = root.querySelector('.rpt-fields');
  if (!fields) return;
  const hol = fields.querySelector('.rpt-holiday');
  if (hol) hol.disabled = false; // 从「法定工作日」切回来时先解锁再赋值
  const set = (sel, value) => { const el = fields.querySelector(sel); if (el) el.value = value; };
  if (key === 'daily') {
    set('.rpt-freq', 'daily'); set('.rpt-interval', 1); set('.rpt-holiday', 'none');
  } else if (key === 'workday') {
    set('.rpt-freq', 'workday'); set('.rpt-interval', 1); set('.rpt-holiday', 'cn');
  } else if (key === 'weekdays') {
    set('.rpt-freq', 'weekly'); set('.rpt-interval', 1); set('.rpt-holiday', 'none');
    fields.querySelectorAll('.rpt-weekday').forEach((c) => { c.checked = [1, 2, 3, 4, 5].includes(Number(c.value)); });
  } else if (key === 'monthly') {
    set('.rpt-freq', 'monthly'); set('.rpt-interval', 1); set('.rpt-holiday', 'none');
    set('.rpt-monthdays-input', '1');
  }
  syncConditionals(root, fields.querySelector('.rpt-freq').value);
  updatePreview(fields);
}

/* ---------------- 管理面板 ---------------- */

export function openRecurrenceManager(opts = {}) {
  return openPanelModal({
    title: '🔁 重复事项与习惯',
    className: 'modal-recurrence',
    okText: '关闭',
    showClose: true,
    html: `<div class="rc-wrap">
      <div class="rc-head">
        <div class="rc-head-text">一条任务按规则反复出现在「今天」并按时提醒；勾选完成记一次打卡，改规则不会重建任务。</div>
        <button type="button" class="primary-btn" data-rc-act="new">＋ 新建重复事项</button>
      </div>
      <div class="rc-meta" id="rc-meta">加载中…</div>
      <div class="rc-editor" id="rc-editor" hidden></div>
      <div class="rc-list" id="rc-list"><div class="rc-loading">加载中…</div></div>
    </div>`,
    onMount: (mask) => mountManager(mask, opts),
    onClose: () => { changed(); },
  });
}

async function mountManager(mask, opts) {
  const listEl = mask.querySelector('#rc-list');
  const metaEl = mask.querySelector('#rc-meta');
  const editorEl = mask.querySelector('#rc-editor');
  let editingId = null;

  try {
    const meta = await api.recurrences.meta();
    const cov = meta.coverage || {};
    metaEl.innerHTML = `<span class="rc-meta-badge">📅 法定节假日数据：${esc((cov.years || []).join(' / ') || '无')}</span>
      <span>按国务院放假与调休安排生成；其它年份自动降级为周一至周五。</span>`;
  } catch (e) {
    metaEl.textContent = '节假日覆盖范围读取失败，规则仍可正常使用';
  }

  const reload = async (focusId) => {
    let rules = [];
    try { rules = await api.recurrences.list(); } catch (e) { toast(`读取重复事项失败：${e.message}`); }
    listEl.innerHTML = rules.length
      ? rules.map(ruleCardHtml).join('')
      : '<div class="rc-empty">还没有重复事项。可以在新建任务时点「🔁 设为重复」，或点右上角新建。</div>';
    loadStats(rules);
    if (focusId) {
      const card = listEl.querySelector(`[data-rc-id="${Number(focusId)}"]`);
      if (card) {
        card.classList.add('is-focused');
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  };

  // 每次重绘都重新拉统计：勾选完成可能发生在面板外面，缓存会让「关掉再打开」显示旧数据
  const loadStats = (rules) => {
    for (const r of rules) {
      const host = listEl.querySelector(`[data-rc-id="${r.id}"] .rc-habit`);
      if (!host) continue;
      api.recurrences.stats(r.id).then((s) => paintHabit(host, s)).catch(() => {});
    }
  };

  const closeEditor = () => { editorEl.hidden = true; editorEl.innerHTML = ''; editingId = null; };

  const showEditor = (rule) => {
    editingId = rule ? rule.id : null;
    editorEl.hidden = false;
    editorEl.innerHTML = `
      <div class="rc-editor-head">${rule ? `编辑「${esc(rule.title)}」` : '新建重复事项'}
        <button type="button" class="ghost-btn" data-rc-act="editor-cancel">取消</button>
      </div>
      <div class="rc-editor-body">
        <label class="rc-title-field"><span>标题</span>
          <input type="text" class="rc-title-input" value="${esc(rule ? rule.title : '')}" placeholder="例如：抽盘仓库 / 每天阅读 20 分钟" />
        </label>
        ${repeatFieldsHtml({
    rule: rule ? rule.rule : DEFAULT_REPEAT_RULE,
    startDate: rule ? rule.start_date : todayStr(),
    endDate: rule ? rule.end_date : '',
    habit: rule ? rule.habit : true,
  })}
        <div class="rc-editor-foot">
          <span class="rc-editor-err" hidden></span>
          <button type="button" class="primary-btn" data-rc-act="editor-save">${rule ? '保存规则' : '创建'}</button>
        </div>
      </div>`;
    const fields = editorEl.querySelector('.rpt-fields');
    // showEditor 会整块替换 innerHTML，之前挂在 editorEl 上的绑定标记要清掉，
    // 否则第二次「编辑」时 bindRepeatEditor 会误判为已绑定、控件全部失灵
    editorEl.removeAttribute('data-rpt-bound');
    bindRepeatEditor(editorEl);
    syncConditionals(editorEl, fields.querySelector('.rpt-freq').value);
    updatePreview(fields);
    editorEl.querySelector('.rc-title-input').focus();
  };

  mask.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-rc-act]');
    if (!btn || !mask.contains(btn)) return;
    const act = btn.dataset.rcAct;
    const card = btn.closest('[data-rc-id]');
    const id = card ? Number(card.dataset.rcId) : null;
    try {
      if (act === 'new') { showEditor(null); return; }
      if (act === 'editor-cancel') { closeEditor(); return; }
      if (act === 'editor-save') {
        const title = editorEl.querySelector('.rc-title-input').value.trim();
        const errEl = editorEl.querySelector('.rc-editor-err');
        const checked = validateRepeatFields(editorEl);
        const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };
        if (!title) return fail('请输入标题');
        if (!checked.ok) return fail(checked.message);
        errEl.hidden = true;
        const p = {
          title, rule: checked.rule, startDate: checked.startDate,
          endDate: checked.endDate, habit: checked.habit,
        };
        if (editingId) await api.recurrences.update(editingId, p);
        else await api.recurrences.create(p);
        closeEditor();
        toast(editingId ? '重复规则已更新，下一次发生日已重算' : '重复事项已创建，今天起按规则出现');
        await reload();
        await changed();
        return;
      }
      if (act === 'edit') {
        const r = await api.recurrences.get(id);
        if (r) { showEditor(r); editorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        return;
      }
      if (act === 'toggle') {
        const on = btn.dataset.rcOn === '1';
        await api.recurrences.setEnabled(id, !on);
        toast(on ? '已停止：不再出现在「今天」，打卡历史保留' : '已重新启用：按规则继续出现');
        await reload(id);
        await changed();
        return;
      }
      if (act === 'skip-today') {
        await api.recurrences.skipDay(id, todayStr());
        toast('已跳过这一次，下个发生日照常出现');
        await reload(id);
        await changed();
        return;
      }
      if (act === 'cell') {
        await api.recurrences.setCompletion(id, btn.dataset.rcDate, btn.dataset.rcDone !== '1');
        await reload(id);
        await changed();
        return;
      }
      if (act === 'clear-skips') {
        await api.recurrences.clearSkips(id);
        toast('已恢复被跳过的发生日');
        await reload(id);
        await changed();
        return;
      }
      if (act === 'remove') {
        if (!window.confirm('删除这条重复规则？该任务会变成普通待办保留，打卡历史将一并清除。')) return;
        await api.recurrences.remove(id);
        toast('重复规则已删除，任务已转为普通待办');
        await reload();
        await changed();
        return;
      }
    } catch (err) {
      toast(`操作失败：${(err && err.message) || err}`);
    }
  });

  await reload(opts.focusRuleId);
}

function paintHabit(host, s) {
  if (!host || !s) return;
  const cells = (s.recent || []).map((x) => `<button type="button" class="rc-cell${x.done ? ' is-done' : ''}" data-rc-act="cell" data-rc-date="${esc(x.date)}" data-rc-done="${x.done ? '1' : '0'}" title="${esc(x.date)}${x.done ? ' 已完成（点击撤销）' : ' 未完成（点击补打卡）'}"></button>`).join('');
  host.innerHTML = `<div class="rc-habit-top">
      <span class="rc-habit-stat"><b>${s.streak}</b> 天连续</span>
      <span class="rc-habit-stat"><b>${s.rate}%</b> 完成率</span>
      <span class="rc-habit-stat">累计完成 <b>${s.doneInstances}</b> 次 · 至今应发生 ${s.expected} 次</span>
    </div>
    <div class="rc-cells">${cells || '<span class="rc-cell-empty">还没有打卡记录</span>'}</div>`;
}

function ruleCardHtml(r) {
  const state = r.enabled ? '进行中' : '已停止';
  const cls = ['rc-card', r.enabled ? '' : 'is-stopped', r.habit ? 'is-habit' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}" data-rc-id="${r.id}">
    <div class="rc-card-main">
      <div class="rc-card-title">
        <span class="rc-title-text">${esc(r.title)}</span>
        <span class="rc-state">${state}</span>
        ${r.habit ? '<span class="rc-habit-tag">💪 习惯</span>' : ''}
      </div>
      <div class="rc-card-summary">${esc(r.summary || '')}</div>
      <div class="rc-card-meta">
        <span>📅 生效 ${esc(r.start_date)}${r.end_date ? ` ~ ${esc(r.end_date)}` : ' 起，不设结束'}</span>
        <span>⏭ ${r.enabled && r.nextDate ? `下次 ${esc(r.nextDate)}` : '无下一次'}</span>
        <span>✅ 累计打卡 ${r.done_count} 次${r.todayDone ? ' · 今日已完成' : ''}</span>
        ${r.skip_count ? `<span>⏩ 已跳过 ${r.skip_count} 次</span>` : ''}
      </div>
      <div class="rc-habit"><span class="rc-cell-empty">统计加载中…</span></div>
    </div>
    <div class="rc-card-actions">
      <button type="button" class="ghost-btn" data-rc-act="edit">✎ 编辑规则</button>
      <button type="button" class="ghost-btn" data-rc-act="toggle" data-rc-on="${r.enabled ? '1' : '0'}">${r.enabled ? '⏸ 停止' : '▶ 启用'}</button>
      ${r.enabled ? '<button type="button" class="ghost-btn" data-rc-act="skip-today">⏩ 跳过本次</button>' : ''}
      ${r.skip_count ? '<button type="button" class="ghost-btn" data-rc-act="clear-skips">↩ 恢复跳过</button>' : ''}
      <button type="button" class="ghost-btn rc-danger" data-rc-act="remove">🗑 删除</button>
    </div>
  </div>`;
}

/* ---------------- 主进程事件 ---------------- */

export function listenRecurrenceMenu() {
  api.on('ui:recurrence-manager', () => openRecurrenceManager());
  // 后台定时 / 跨天推进了重复任务：不在用户正在输入或开着弹窗时整表重绘
  api.on('ui:recurrence-generated', () => {
    if (document.querySelector('.task-editor') || document.querySelector('.modal-mask')) return;
    changed();
  });
}

/** 任务行徽标点击：打开管理面板并定位到该规则 */
export function openRuleFromTask(ruleId) {
  if (!ruleId) return;
  openRecurrenceManager({ focusRuleId: Number(ruleId) });
}


/* ---------------- 任务详情抽屉：重复与提醒 ---------------- */

/**
 * 详情里的「重复与提醒」区：一条重复任务就地改规则，不用再跳管理面板。
 * 提醒时间、完成日偏移都在复用过来的规则字段里，所以「详情里能设重复时间 + 提醒」是同一块表单。
 */
export function detailRepeatHtml(task, rule) {
  const on = !!rule;
  const r = rule || { rule: DEFAULT_REPEAT_RULE, start_date: todayStr(), end_date: '', habit: false };
  const ico = r.habit ? '💪' : '🔁';
  return `<div class="detail-section detail-repeat" data-detail-repeat="1">
    <div class="detail-section-head"><span>重复与提醒</span>
      <span class="np-head-ops">
        ${on ? `<button type="button" class="ghost-btn tiny" data-detail-repeat-act="manage" data-rule-id="${Number(task.recurring_id)}" title="打开管理面板看全部规则与打卡">全部规则 →</button>` : ''}
      </span>
    </div>
    <div class="rpt-block" data-on="${on ? '1' : '0'}">
      <button type="button" class="rpt-toggle${on ? ' is-on' : ''}" data-act="editor-repeat" aria-pressed="${on ? 'true' : 'false'}">${on ? `${ico} 重复：已开启` : '🔁 设为重复'}</button>
      <div class="rpt-panel"${on ? '' : ' hidden'}>${repeatFieldsHtml({
    rule: r.rule, startDate: r.start_date, endDate: r.end_date, habit: r.habit,
  })}</div>
    </div>
    ${on ? `<div class="rpt-detail-summary">${esc(r.summary || '')}${r.todayDone ? ' · 今日已完成' : ''}${r.doneCount ? ` · 累计打卡 ${r.doneCount} 次` : ''}</div>` : ''}
    <div class="rpt-detail-foot">
      <span class="rpt-detail-hint">改完点保存；始终只有这一条任务，不会生成多余待办。</span>
      <button type="button" class="primary-btn" data-detail-repeat-act="save">保存重复设置</button>
    </div>
  </div>`;
}

/** 绑定详情里的重复配置；signal 由抽屉的 renderAbort 提供，重绘时自动解绑 */
export function bindDetailRepeat(drawer, task, rule, { signal, onSaved } = {}) {
  const host = drawer.querySelector('[data-detail-repeat]');
  if (!host) return;
  host.removeAttribute('data-rpt-bound');
  bindRepeatEditor(host, {
    onInput: () => {
      const on = isRepeatOn(host);
      drawer.querySelectorAll('.date-range-field, .reminder-field').forEach((el) => {
        if (el.closest('.subtask-item, .subtask-add')) return;
        el.classList.toggle('is-rpt-muted', on);
      });
    },
  });
  const freqSel = host.querySelector('.rpt-freq');
  if (freqSel) syncConditionals(host, freqSel.value);
  updatePreview(host.querySelector('.rpt-fields'));

  host.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-detail-repeat-act]');
    if (!btn) return;
    const act = btn.dataset.detailRepeatAct;
    try {
      if (act === 'manage') { openRuleFromTask(Number(btn.dataset.ruleId)); return; }
      if (act !== 'save') return;
      if (!isRepeatOn(host)) {
        if (rule) {
          if (!window.confirm('取消重复？这条任务会变成普通待办，打卡历史保留。')) return;
          await api.recurrences.setEnabled(rule.id, false);
          toast('已取消重复');
        } else {
          toast('当前未开启重复，无需保存');
          return;
        }
      } else {
        const checked = validateRepeatFields(host);
        if (!checked.ok) { toast(checked.message); return; }
        const title = drawer.querySelector('.detail-title').value.trim() || task.title;
        const p = {
          title, rule: checked.rule, startDate: checked.startDate,
          endDate: checked.endDate, habit: checked.habit, notes: task.notes || '',
        };
        if (rule) await api.recurrences.update(rule.id, p);
        else await api.recurrences.create({ ...p, originTaskId: task.id });
        toast(rule ? '重复规则已更新' : '已设为重复事项');
      }
      if (typeof onSaved === 'function') onSaved();
      else await changed();
    } catch (err) {
      toast(`保存重复设置失败：${(err && err.message) || err}`);
    }
  }, { signal });
}
