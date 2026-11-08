'use strict';
/**
 * 纯日期工具（无 Electron / 无数据库依赖，可独立单测）。
 *
 * 约定：所有「日期」都是 'YYYY-MM-DD' 字符串，用 Date.UTC 构造，
 * 避免本地时区与夏令时把'加一天'算成 23 或 25 小时。
 */
const DAY_MS = 86400000;

function pad2(n) { return String(n).padStart(2, '0'); }

/** Date | 'YYYY-MM-DD' | ISO → 'YYYY-MM-DD'；非法输入返回 '' */
function toDay(v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`;
  }
  const m = String(v == null ? '' : v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d ? m[0] : '';
}

/** 'YYYY-MM-DD' → UTC 毫秒 */
function toMs(dateStr) {
  const s = toDay(dateStr);
  if (!s) return NaN;
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(dateStr, n) {
  const ms = toMs(dateStr);
  return Number.isFinite(ms) ? toDay(new Date(ms + Number(n || 0) * DAY_MS)) : '';
}

/** 某月天数（month 为 1~12） */
function monthLength(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 加月份：日超出目标月长度时收敛到月末 */
function addMonths(dateStr, n) {
  const s = toDay(dateStr);
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const total = y * 12 + (m - 1) + Number(n || 0);
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  return `${ny}-${pad2(nm)}-${pad2(Math.min(d, monthLength(ny, nm)))}`;
}

/** 星期：0=周日 … 6=周六 */
function dayOfWeek(dateStr) {
  const ms = toMs(dateStr);
  return Number.isFinite(ms) ? new Date(ms).getUTCDay() : -1;
}

/** 闭区间逐日，含首尾；区间非法时返回空数组 */
function eachDay(from, to) {
  const a = toDay(from); const b = toDay(to);
  if (!a || !b || a > b) return [];
  const out = [];
  const end = toMs(b);
  for (let ms = toMs(a); ms <= end; ms += DAY_MS) {
    out.push(toDay(new Date(ms)));
    if (out.length > 4000) break; // 防御性上限：调用方不该传超大区间
  }
  return out;
}

/** 'YYYY-MM-DD' + 'HH:mm'（本地时间）→ UTC ISO 字符串；非法返回 null */
function localTimeToIso(dateStr, timeStr) {
  const day = toDay(dateStr);
  if (!day || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(timeStr || ''))) return null;
  const [hh, mm] = String(timeStr).split(':').map(Number);
  const d = new Date(`${day}T${pad2(hh)}:${pad2(mm)}:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** 本地当前日期（主进程与渲染层各自按本机时区取，规则按本地日历展开） */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

module.exports = {
  DAY_MS, pad2, toDay, toMs, addDays, addMonths, monthLength,
  dayOfWeek, eachDay, localTimeToIso, todayLocal,
};
