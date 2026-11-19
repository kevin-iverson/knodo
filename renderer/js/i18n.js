'use strict';
/**
 * 国际化（i18n）。
 *
 * 设计要点：
 *   1) **中文原文就是 key** —— `t('今天')`，字典里查不到时原样返回中文。
 *      这样新增文案不改核心、漏翻的句子最多是「这句还是中文」，绝不会变成空白或 key 泄漏。
 *   2) 变量用 `{name}` 占位：`t('已恢复 {n} 项', { n: 3 })`。中文侧同样走插值，
 *      所以含变量的句子也能安全调用。
 *   3) 静态 HTML 不写 JS：元素上挂 `data-i18n` / `data-i18n-title` / `data-i18n-aria` /
 *      `data-i18n-ph`，启动时 applyStaticI18n() 一次性替换。
 *      元素里若已经包了子节点（如 `.nav-item > .nav-ico`），只替换**最后一个文本节点**，
 *      不动结构 —— 免得好好的图标被 textContent 抹掉。
 *   4) 切换语言不试图热替换整棵树（界面是「整块重写」架构，热替换必然漏），
 *      改为主进程写设置 → 广播 `locale:changed` → 各窗口 reload，最可靠。
 */
import { EN } from './locale-en.js';

/** 支持的语言（顺序 = 设置中心下拉的顺序） */
export const LOCALES = ['zh-CN', 'en'];
/** 语言在设置中心里的显示名（语言名一律用「本体语言」写，方便看不懂当前语言的人找回来） */
export const LOCALE_LABELS = { 'zh-CN': '简体中文', en: 'English' };
export const DEFAULT_LOCALE = 'zh-CN';

/** 语言缓存在 localStorage：只为「启动首帧就按正确语言渲染」，权威值仍在主进程 settings 表 */
const CACHE_KEY = 'knodo.locale';

/**
 * 模块加载时就把 locale 定下来（而不是等 primeLocale）。
 *
 * 原因：很多模块在**顶层**求值常量（`const WEEKDAYS = [t('周日'), …]`、默认标签、默认占位文案）。
 * import 发生在 DOMContentLoaded 之前，那时若 locale 还是默认的中文，
 * 这些常量会被永久钉死成中文 —— 切英文后 reload 也一样错。
 * 读 localStorage 是同步的，代价只有一次字符串读取。
 */
let locale = (() => {
  try { return normalizeLocale(localStorage.getItem(CACHE_KEY) || DEFAULT_LOCALE); } catch (e) { return DEFAULT_LOCALE; }
})();

export function normalizeLocale(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return DEFAULT_LOCALE;
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('zh')) return 'zh-CN';
  return DEFAULT_LOCALE;
}

export function getLocale() {
  return locale;
}

/** 当前是否为英文（某些地方需要按语言切换排版 / 日期格式，而不只是换字） */
export function isEnglish() {
  return locale === 'en';
}

/**
 * 只改内存里的语言，不碰设置（用于启动时用缓存值先把首屏画对）。
 * 需要持久化走 api.i18n.set()。
 */
export function setLocaleSync(v) {
  locale = normalizeLocale(v);
  try { localStorage.setItem(CACHE_KEY, locale); } catch (e) { /* 隐私模式忽略 */ }
  const el = document.documentElement;
  if (el) el.lang = locale === 'en' ? 'en' : 'zh-CN';
}

/** 启动时读缓存值（同步、不发起 IPC），保证第一帧的静态文案方向正确 */
export function primeLocale() {
  let cached = '';
  try { cached = localStorage.getItem(CACHE_KEY) || ''; } catch (e) { cached = ''; }
  locale = normalizeLocale(cached || DEFAULT_LOCALE);
  const el = document.documentElement;
  if (el) el.lang = locale === 'en' ? 'en' : 'zh-CN';
  return locale;
}

function interpolate(s, vars) {
  const str = String(s == null ? '' : s);
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/**
 * 取词条。`key` 可以带插值占位（`'共 {n} 项'`）。
 * vars 也可以直接传单个值（`t('已完成 {n} 项', 3)`），等价于 `{ n: 3 }`。
 */
export function t(key, vars) {
  const k = String(key == null ? '' : key);
  if (locale === 'zh-CN') return interpolate(k, vars);
  const hit = EN[k];
  return interpolate(hit == null ? k : hit, vars);
}

/** 有英文词条就返回英文，没有返回 null（用于「只翻确实翻过的句子」这类判断） */
export function hasEn(key) {
  return Object.prototype.hasOwnProperty.call(EN, key);
}

/**
 * 静态文案：把 index.html / 模板里的 data-i18n* 属性刷成当前语言。
 * 可以在任意新插入的 DOM 上重复调用（只认 data-i18n*，幂等）。
 */
export function applyStaticI18n(root) {
  const scope = root || document;
  if (!scope || !scope.querySelectorAll) return;

  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    const val = t(key);
    // 有子元素时只替换最后一个文本节点，保住图标等结构
    if (el.children && el.children.length) {
      let node = null;
      for (let i = el.childNodes.length - 1; i >= 0; i -= 1) {
        const n = el.childNodes[i];
        if (n.nodeType === 3 && n.nodeValue.trim()) { node = n; break; }
      }
      if (node) {
        const lead = /^\s*/.exec(node.nodeValue)[0];
        node.nodeValue = lead + val;
      } else {
        el.appendChild(document.createTextNode(val));
      }
    } else {
      el.textContent = val;
    }
  });

  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.title = t(key);
  });

  scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key));
  });

  scope.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const key = el.getAttribute('data-i18n-ph');
    if (key) el.setAttribute('placeholder', t(key));
  });
}
