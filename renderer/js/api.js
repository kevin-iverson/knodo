'use strict';
/**
 * 渲染进程对主进程 API 的封装与数据格式转换。
 */

const api = window.api;
import { t } from './i18n.js';


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

/**
 * 优先级显示名。
 * 不能写成模块常量数组：语言是运行时才确定的（主进程 settings.locale），
 * 而本模块在语言就绪之前就求值了。用 Proxy 让每次下标读取都即时翻译 ——
 * 调用方 `PRIORITY_TEXT[p]`、`.map`、展开、`length` 全部照旧可用。
 */
const PRIORITY_TEXT = new Proxy(['低', '中', '高', '紧急'], {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver);
    return typeof v === 'string' ? t(v) : v;
  },
});
const PRIORITY_COLOR = ['#8896ab', '#4f7cff', '#f59e0b', '#e5484d'];

export { api, localToIso, isoToLocal, fmtDateTime, fmtDate, PRIORITY_TEXT, PRIORITY_COLOR };
