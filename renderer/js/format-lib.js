'use strict';
/**
 * 格式化 / 语法高亮 / 复制的公共库（无 UI）。
 *
 * 「代码格式化」浮窗已下线，但格式化能力仍被两个工具复用：
 *  - js/text-diff.js  「格式化双方」→ 先各自格式化再比，排版差异不淹没真实改动
 *  - js/json-view.js  格式化结果预览 → JSON 走 JSON.stringify，输出只由数据决定
 *
 * 格式化能力全部来自第三方库（打包在 renderer/vendor/tools/，首次用到才动态 import）：
 *  - JSON / JavaScript / TypeScript / HTML / CSS / SCSS / Less / Markdown / YAML / Java → prettier 3（standalone + 插件）
 *  - SQL → sql-formatter（方言与关键字大小写）
 *  - XML → xml-formatter（尊重 xml:space）
 * 语言映射与参数校验在这里，vendor 只做薄适配，升级依赖不用动业务代码。
 */

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 复制到剪贴板：优先 clipboard API，失败回退到 execCommand（Electron 里两者都可用） */
export async function copyText(text) {
  const s = String(text || '');
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/* ---------------- 语言表 ---------------- */

/** hljs = 该语言在 highlight.js 里的名字（空 = 不高亮） */
const LANGS = [
  { id: 'auto', label: '自动识别' },
  { id: 'json', label: 'JSON', engine: 'prettier', parser: 'json', indent: 2, hljs: 'json' },
  { id: 'javascript', label: 'JavaScript', engine: 'prettier', parser: 'babel', indent: 2, hljs: 'javascript' },
  { id: 'typescript', label: 'TypeScript', engine: 'prettier', parser: 'typescript', indent: 2, hljs: 'typescript' },
  { id: 'html', label: 'HTML', engine: 'prettier', parser: 'html', indent: 2, hljs: 'xml' },
  { id: 'css', label: 'CSS', engine: 'prettier', parser: 'css', indent: 2, hljs: 'css' },
  { id: 'scss', label: 'SCSS', engine: 'prettier', parser: 'scss', indent: 2, hljs: 'scss' },
  { id: 'less', label: 'Less', engine: 'prettier', parser: 'less', indent: 2, hljs: 'less' },
  { id: 'markdown', label: 'Markdown', engine: 'prettier', parser: 'markdown', indent: 2, hljs: 'markdown' },
  { id: 'yaml', label: 'YAML', engine: 'prettier', parser: 'yaml', indent: 2, hljs: 'yaml' },
  { id: 'xml', label: 'XML', engine: 'xml', indent: 4, hljs: 'xml' },
  { id: 'sql', label: 'SQL', engine: 'sql', indent: 2, hljs: 'sql' },
  { id: 'java', label: 'Java', engine: 'prettier', parser: 'java', indent: 4, hljs: 'java' },
];

export const SQL_DIALECTS = [
  { id: 'sql', label: '标准 SQL' },
  { id: 'mysql', label: 'MySQL' },
  { id: 'mariadb', label: 'MariaDB' },
  { id: 'postgresql', label: 'PostgreSQL' },
  { id: 'sqlite', label: 'SQLite' },
  { id: 'sqlserver', label: 'SQL Server' },
  { id: 'plsql', label: 'Oracle / PL-SQL' },
  { id: 'bigquery', label: 'BigQuery' },
  { id: 'hive', label: 'Hive' },
];

export const KEYWORD_CASE = [
  { id: 'preserve', label: '保持原样' },
  { id: 'upper', label: '关键字大写' },
  { id: 'lower', label: '关键字小写' },
];

export const DEFAULTS = {
  lang: 'auto', indent: 2, useTabs: false, printWidth: 100,
  sqlDialect: 'sql', keywordCase: 'preserve',
  highlight: true, // 语法高亮（highlight.js）
};

const langOf = (id) => LANGS.find((l) => l.id === id) || LANGS[1];
export const LANG_OPTIONS = LANGS.map((l) => ({ id: l.id, label: l.label }));

/**
 * 自动识别语言：先看开头字符（JSON / XML 一眼可辨），再看 SQL 关键字，最后看 Java / JS 语法特征。
 * 识别不了时退回 JSON —— 它在工具里最常见，且解析失败会给出明确报错而不是默默猜错。
 * @returns {string} 语言 id
 */
function detectLang(text) {
  const t = String(text || '').trim();
  if (!t) return 'json';
  if (/^[[{]/.test(t)) return 'json';
  if (/^<(\?xml|!doctype)/i.test(t) || /^<[a-zA-Z][\w:.-]*(\s[^>]*?)?\/?>/.test(t)) return 'xml';
  if (/^(select|insert|update|delete|create|alter|drop|with|merge|truncate|grant|explain|show|describe)\b/i.test(t)) return 'sql';
  if (/^\s*package\s+[\w.]+\s*;/m.test(t)) return 'java';
  if (/\b(public|protected|private)\s+(static\s+|final\s+|abstract\s+)*[\w<>[\],.?\s]*\s+\w+\s*\(/.test(t)) return 'java';
  if (/\bSystem\.(out|err)\./.test(t)) return 'java';
  if (/\b(function|const|let|var|=>|module\.exports|require\()\b/.test(t)) return 'javascript';
  if (/^\s*[\w.-]+:\s*(\S|$)/m.test(t) && !/[{}]/.test(t)) return 'yaml';
  return 'json';
}

/** 语言 id → 语言配置；'auto' 走识别 */
export function resolveLang(langId, text) {
  const id = String(langId || 'auto');
  if (id !== 'auto') {
    const hit = LANGS.find((l) => l.id === id);
    if (hit) return hit;
  }
  return langOf(detectLang(text));
}

/* ---------------- vendor 懒加载 ---------------- */

let corePromise = null;
let javaPromise = null;
let hlPromise = null;
const loadCore = () => (corePromise || (corePromise = import('../vendor/tools/format-core.mjs')));
const loadJava = () => (javaPromise || (javaPromise = import('../vendor/tools/format-java.mjs')));

/**
 * 语言 id（或 'auto' + 文本）→ highlight.js 语言名；该语言没有高亮规则时返回 ''。
 * 文本对比窗口也用它，着色口径与 JSON 查看器保持一致。
 */
export function hljsLangOf(langId, text) {
  return resolveLang(langId, text).hljs || '';
}

/** 已加载的 highlight 模块（加载后 highlightSync 才能同步出结果） */
let hlMod = null;
const loadHl = () => (hlPromise || (hlPromise = import('../vendor/tools/highlight.mjs').then((m) => {
  hlMod = m;
  return m;
})));

/**
 * 同步版高亮：给「一次拼出整段 HTML」的场景用（文本对比的差异行就是这么渲染的）。
 * 调用前先 await loadHighlightModule()；模块没就绪或语言不支持时返回**转义后的纯文本**。
 */
export function highlightSync(text, langId, on = true) {
  const src = String(text == null ? '' : text);
  const name = on ? hljsLangOf(langId, src) : '';
  if (!name || !hlMod) return esc(src);
  try {
    return hlMod.highlightCode(src, name);
  } catch (e) {
    return esc(src);
  }
}

export const loadHighlightModule = () => loadHl();

/**
 * 把文本按语言高亮写进元素（关掉高亮 / 语言不支持时退化为转义后的纯文本）。
 * @param {HTMLElement} el <code> 之类的容器
 * @param {string} text
 * @param {string} langId 业务语言 id
 * @param {boolean} on 是否启用高亮
 */
export async function paintHighlight(el, text, langId, on = true) {
  if (!el) return;
  const src = String(text == null ? '' : text);
  const name = on ? hljsLangOf(langId, src) : '';
  if (!name) {
    el.textContent = src; // textContent 天然转义，不走 innerHTML
    return;
  }
  try {
    const mod = await loadHl();
    el.innerHTML = mod.highlightCode(src, name);
  } catch (e) {
    el.textContent = src;
  }
}

/**
 * 格式化文本（纯逻辑）。
 * @param {string} text
 * @param {{lang?:string, indent?:number, useTabs?:boolean, printWidth?:number,
 *          sqlDialect?:string, keywordCase?:string}} [opts]
 * @returns {Promise<{text:string, lang:object}>}
 */
export async function formatText(text, opts = {}) {
  const src = String(text == null ? '' : text);
  const lang = resolveLang(opts.lang, src);
  const indent = Math.max(1, Math.min(8, Number(opts.indent) || lang.indent || 2));
  const useTabs = !!opts.useTabs;
  const core = await loadCore();
  // out 必须是 null 起步：下面的 `out == null` 是「还没算出结果，交给 prettier」的信号。
  // 若初始化成 src，所有 prettier 语言（Java / HTML / CSS / JS…）都会跳过格式化原样返回，
  // 界面上还显示「已格式化」，表现为静默失效。
  let out = null;

  if (lang.engine === 'xml') {
    out = core.xmlFormat(src, {
      indentation: useTabs ? '\t' : ' '.repeat(indent),
      collapseContent: true, // 非空文本节点保持单行，别把 <a>hi</a> 拆成三行
      lineSeparator: '\n',
    });
  } else if (lang.engine === 'sql') {
    out = core.sqlFormat(src, {
      language: opts.sqlDialect || DEFAULTS.sqlDialect,
      tabWidth: indent,
      useTabs,
      keywordCase: opts.keywordCase || DEFAULTS.keywordCase,
      linesBetweenQueries: 1,
    });
  } else {
    // JSON 走 JSON.stringify 而不是 prettier：prettier 的「对象换不换行」取决于原文里
    // 第一个换行在哪，于是同一份数据的两种排版（一行 / 多行）格式化后仍然不一样，
    // 文本对比就比不出真正的改动。stringify 的输出只由数据决定，两侧必然收敛。
    // 解析失败（JSON5 / 带注释的 JSONC）时再退回 prettier，它认得这些扩展语法。
    if (lang.parser === 'json') {
      try {
        out = JSON.stringify(JSON.parse(src), null, useTabs ? '\t' : ' '.repeat(indent));
      } catch (e) {
        out = null;
      }
    }
    if (out == null) {
      let plugins = core.PLUGINS;
      if (lang.parser === 'java') {
        const jm = await loadJava();
        plugins = [...core.PLUGINS, jm.javaPlugin];
      }
      // prettier.format 返回 Promise（standalone 版要异步加载 parser），必须 await：
      // 漏了的话 out 会是个 Promise，String() 之后变成 "[object Promise]" 写进结果框
      out = await core.prettierFormat(src, {
        parser: lang.parser,
        plugins,
        tabWidth: indent,
        useTabs,
        printWidth: Math.max(40, Math.min(200, Number(opts.printWidth) || DEFAULTS.printWidth)),
      });
    }
  }
  return { text: String(out == null ? src : out).replace(/\s+$/, ''), lang };
}
