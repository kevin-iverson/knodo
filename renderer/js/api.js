'use strict';
/**
 * 渲染进程对主进程 API 的封装与数据格式转换。
 */

const api = window.api;

/** 本地 datetime-local 值 → UTC ISO 字符串（存储格式） */
function localToIso(localValue) {
  if (!localValue) return null;
  return new Date(localValue).toISOString();
}

/** UTC ISO 字符串 → datetime-local 显示值 */
function isoToLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** UTC ISO → 人类可读 */
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

const PRIORITY_TEXT = ['低', '中', '高', '紧急'];
const PRIORITY_COLOR = ['#8896ab', '#4f7cff', '#f59e0b', '#e5484d'];

export { api, localToIso, isoToLocal, fmtDateTime, fmtDate, PRIORITY_TEXT, PRIORITY_COLOR };
