'use strict';
/**
 * 重复规则：归一化 / 校验 / 日期展开 / 实例字段计算。
 *
 * 纯函数，不碰数据库也不依赖 Electron —— 规则语义全部在这里，方便独立单测。
 * 「发生日」= 规则命中的日期；完成日与提醒时间都相对发生日计算。
 *
 * rule = {
 *   freq: 'daily' | 'weekly' | 'monthly' | 'workday',
 *   interval: 1..,                  // 每 N 天 / 周 / 月
 *   weekdays: number[],             // weekly：0=周日 … 6=周六
 *   monthDays: number[],            // monthly：1..31，-1 = 当月最后一天
 *   holidayMode: 'none'|'skip'|'cn',// 不处理 / 跳过法定假期 / 只按中国法定工作日（含调休补班）
 *   reminderTime: '' | 'HH:mm',     // 空 = 不提醒
 *   reminderOffsetDays: 0..,        // 提前 N 天提醒
 *   dueOffsetDays: 0..,             // 完成日 = 发生日 + N 天
 * }
 */
const {
  toDay, toMs, addDays, addMonths, dayOfWeek, monthLength, eachDay, localTimeToIso,
} = require('./date-utils');
const holidays = require('./holidays-cn');

const FREQS = ['daily', 'weekly', 'monthly', 'workday'];
const HOLIDAY_MODES = ['none', 'skip', 'cn'];
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

const DEFAULT_RULE = Object.freeze({
  freq: 'daily',
  interval: 1,
  weekdays: [1, 2, 3, 4, 5],
  monthDays: [1],
  holidayMode: 'none',
  reminderTime: '09:00',
  reminderOffsetDays: 0,
  dueOffsetDays: 0,
});

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function cleanIntList(v, { min, max, fallback, allowLast = false, maxLen = 7 }) {
  const arr = Array.isArray(v) ? v : [];
  const out = [];
  for (const raw of arr) {
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (allowLast && n === -1) { if (!out.includes(-1)) out.push(-1); continue; }
    const i = Math.trunc(n);
    if (i < min || i > max || out.includes(i)) continue;
    out.push(i);
  }
  return out.length ? out.sort((a, b) => a - b).slice(0, maxLen) : [...fallback];
}

/** 任意输入 → 合法规则（未知值一律回退默认，绝不把脏数据写进库） */
function normalizeRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const freq = FREQS.includes(r.freq) ? r.freq : DEFAULT_RULE.freq;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.reminderTime || ''))
    ? String(r.reminderTime) : (r.reminderTime === '' || r.reminderTime == null ? '' : DEFAULT_RULE.reminderTime);
  const out = {
    freq,
    interval: clampInt(r.interval, 1, 365, DEFAULT_RULE.interval),
    weekdays: cleanIntList(r.weekdays, { min: 0, max: 6, fallback: DEFAULT_RULE.weekdays }),
    monthDays: cleanIntList(r.monthDays, { min: 1, max: 31, fallback: DEFAULT_RULE.monthDays, allowLast: true }),
    holidayMode: HOLIDAY_MODES.includes(r.holidayMode) ? r.holidayMode : DEFAULT_RULE.holidayMode,
    reminderTime: time,
    reminderOffsetDays: clampInt(r.reminderOffsetDays, 0, 30, 0),
    dueOffsetDays: clampInt(r.dueOffsetDays, 0, 30, 0),
  };
  // 「法定工作日」是独立频率：等价于每天 + 只保留法定工作日，避免两处开关打架
  if (out.freq === 'workday') out.holidayMode = 'cn';
  return out;
}

function validateRule(raw) {
  const r = normalizeRule(raw);
  if (r.freq === 'weekly' && !r.weekdays.length) return { ok: false, message: '请至少选择一个星期几', rule: r };
  if (r.freq === 'monthly' && !r.monthDays.length) return { ok: false, message: '请至少选择一个日期', rule: r };
  if (r.reminderOffsetDays > r.dueOffsetDays + 30) return { ok: false, message: '提前提醒的天数过大', rule: r };
  return { ok: true, message: '', rule: r };
}

/** 以周一为一周起点的周序号（只用于取模，绝对值无意义） */
function weekIndex(dateStr) {
  const w = dayOfWeek(dateStr);
  const monday = addDays(dateStr, -((w + 6) % 7));
  return Math.floor(toMs(monday) / (7 * 86400000));
}

function monthIndex(dateStr) {
  const s = toDay(dateStr);
  if (!s) return 0;
  const [y, m] = s.split('-').map(Number);
  return y * 12 + (m - 1);
}

/** 某一天是否被规则的基础频率命中（不含节假日过滤） */
function matchesBase(rule, dateStr, anchor) {
  const d = toDay(dateStr);
  if (!d) return false;
  const a = toDay(anchor) || d;
  if (d < a) return false; // 生效日之前不生成
  switch (rule.freq) {
    case 'daily':
    case 'workday': {
      const diff = Math.round((toMs(d) - toMs(a)) / 86400000);
      return diff >= 0 && diff % rule.interval === 0;
    }
    case 'weekly': {
      if (!rule.weekdays.includes(dayOfWeek(d))) return false;
      return (weekIndex(d) - weekIndex(a)) % rule.interval === 0;
    }
    case 'monthly': {
      const [y, m, day] = d.split('-').map(Number);
      const hit = rule.monthDays.some((md) => md === day || (md === -1 && day === monthLength(y, m)));
      return hit && (monthIndex(d) - monthIndex(a)) % rule.interval === 0;
    }
    default:
      return false;
  }
}

function passesHoliday(rule, dateStr) {
  if (rule.holidayMode === 'cn') return holidays.isCnWorkday(dateStr);
  if (rule.holidayMode === 'skip') return !holidays.isCnHoliday(dateStr);
  return true;
}

/**
 * 展开 [from, to] 闭区间内的所有发生日。
 * @param {object} rule 已归一化的规则
 * @param {string} anchor 规则生效日（间隔计算的锚点）
 */
function occurrences(rule, from, to, anchor) {
  const r = normalizeRule(rule);
  const a = toDay(anchor) || toDay(from) || '';
  if (!a) return [];
  return eachDay(from, to).filter((d) => matchesBase(r, d, a) && passesHoliday(r, d));
}

/** 从 anchor 开始往后找下一个发生日（最多找 800 天，找不到返回 ''） */
function nextOccurrence(rule, from, anchor) {
  const r = normalizeRule(rule);
  const start = toDay(from) || '';
  if (!start) return '';
  return occurrences(r, start, addDays(start, 800), toDay(anchor) || start)[0] || '';
}

/** 单条实例的派生字段：完成日、提醒时间 */
function instanceFields(rule, occurrenceDate) {
  const r = normalizeRule(rule);
  const day = toDay(occurrenceDate);
  const planStart = day;
  const planEnd = addDays(day, r.dueOffsetDays);
  const reminderAt = r.reminderTime
    ? localTimeToIso(addDays(day, -r.reminderOffsetDays), r.reminderTime)
    : null;
  return { planStart, planEnd, reminderAt };
}

/** 人类可读的规则摘要（列表 / 管理面板 / 通知里都用这一份） */
function describeRule(raw) {
  const r = normalizeRule(raw);
  let base = '';
  if (r.freq === 'daily' || r.freq === 'workday') {
    base = r.freq === 'workday' ? '每个法定工作日' : (r.interval === 1 ? '每天' : `每 ${r.interval} 天`);
  } else if (r.freq === 'weekly') {
    const days = r.weekdays.map((w) => `周${WEEKDAY_LABELS[w]}`).join('、');
    base = r.interval === 1 ? `每周 ${days}` : `每 ${r.interval} 周 ${days}`;
  } else {
    const days = r.monthDays.map((m) => (m === -1 ? '月末' : `${m} 日`)).join('、');
    base = r.interval === 1 ? `每月 ${days}` : `每 ${r.interval} 月 ${days}`;
  }
  if (r.holidayMode === 'cn' && r.freq !== 'workday') base += '（法定工作日）';
  else if (r.holidayMode === 'skip') base += '（跳过法定假期）';
  const bits = [base];
  if (r.reminderTime) {
    bits.push(r.reminderOffsetDays ? `提前 ${r.reminderOffsetDays} 天 ${r.reminderTime} 提醒` : `${r.reminderTime} 提醒`);
  } else bits.push('不提醒');
  bits.push(r.dueOffsetDays ? `${r.dueOffsetDays} 天内完成` : '当天完成');
  return bits.join(' · ');
}

module.exports = {
  FREQS, HOLIDAY_MODES, WEEKDAY_LABELS, DEFAULT_RULE,
  normalizeRule, validateRule, occurrences, nextOccurrence,
  matchesBase, passesHoliday, instanceFields, describeRule,
};
