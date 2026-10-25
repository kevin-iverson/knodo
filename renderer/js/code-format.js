'use strict';
/**
 * 实用工具 →「代码格式化」浮窗（菜单：实用工具 → 代码格式化）。
 *
 * 形态：非模态浮窗（js/tool-window.js），无遮罩，开着它照样能操作主界面。
 *
 * 格式化能力全部来自第三方库（打包在 renderer/vendor/tools/，首次用到才动态 import）：
 *  - JSON / JavaScript / TypeScript / HTML / CSS / SCSS / Less / Markdown / YAML / Java → prettier 3（standalone + 插件）
 *  - SQL → sql-formatter（可选方言与关键字大小写）
 *  - XML → xml-formatter（尊重 xml:space）
 * 语言映射与参数校验在这里，vendor 只做薄适配，升级依赖不用动业务代码。
 *
 * 配置（语言 / 缩进 / 方言…）存 settings 的 `tool.formatter`，下次打开直接回填。
 */
import { api } from './api.js';
import { openToolWindow } from './tool-window.js';

let notify = () => {};
export function setFormatterHandlers({ toast } = {}) {
  if (toast) notify = toast;
}

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

const LANGS = [
  { id: 'auto', label: '自动识别' },
  { id: 'json', label: 'JSON', engine: 'prettier', parser: 'json', indent: 2 },
  { id: 'javascript', label: 'JavaScript', engine: 'prettier', parser: 'babel', indent: 2 },
  { id: 'typescript', label: 'TypeScript', engine: 'prettier', parser: 'typescript', indent: 2 },
  { id: 'html', label: 'HTML', engine: 'prettier', parser: 'html', indent: 2 },
  { id: 'css', label: 'CSS', engine: 'prettier', parser: 'css', indent: 2 },
  { id: 'scss', label: 'SCSS', engine: 'prettier', parser: 'scss', indent: 2 },
  { id: 'less', label: 'Less', engine: 'prettier', parser: 'less', indent: 2 },
  { id: 'markdown', label: 'Markdown', engine: 'prettier', parser: 'markdown', indent: 2 },
  { id: 'yaml', label: 'YAML', engine: 'prettier', parser: 'yaml', indent: 2 },
  { id: 'xml', label: 'XML', engine: 'xml', indent: 4 },
  { id: 'sql', label: 'SQL', engine: 'sql', indent: 2 },
  { id: 'java', label: 'Java', engine: 'prettier', parser: 'java', indent: 4 },
];

const SQL_DIALECTS = [
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

const KEYWORD_CASE = [
  { id: 'preserve', label: '保持原样' },
  { id: 'upper', label: '关键字大写' },
  { id: 'lower', label: '关键字小写' },
];

const DEFAULTS = {
  lang: 'auto', indent: 2, useTabs: false, printWidth: 100,
  sqlDialect: 'sql', keywordCase: 'preserve',
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
const loadCore = () => (corePromise || (corePromise = import('../vendor/tools/format-core.mjs')));
const loadJava = () => (javaPromise || (javaPromise = import('../vendor/tools/format-java.mjs')));

/**
 * 格式化文本（纯逻辑，UI 与文本对比都走这里）。
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

/* ---------------- 示例 ---------------- */

const SAMPLES = {
  json: '{"name":"knodo","version":1.6,"tags":["todo","note"],"meta":{"stars":128,"ok":true}}',
  javascript: 'function greet(name){const msg=`hi, ${name}`;return {msg,at:Date.now()}}',
  typescript: 'interface Item{id:number;title:string}const list:Item[]=[{id:1,title:"a"}]',
  html: '<div class="box"><ul><li>one</li><li>two</li></ul></div>',
  css: '.box{display:flex;gap:8px}.box>li{list-style:none;color:#333}',
  scss: '.box{display:flex;&>li{list-style:none;color:#333}}',
  less: '.box{display:flex;.item{color:#333}}',
  markdown: '# 标题\n\n- 第一项\n- 第二项\n\n**加粗**与`代码`',
  yaml: 'name: knodo\nversion: 1.6\nfeatures:\n  - todo\n  - note',
  xml: '<root><item id="1" type="a">苹果</item><item id="2" type="b">香蕉</item></root>',
  sql: 'select id,title,created_at from tasks where status=1 and group_id in (1,2,3) order by created_at desc limit 20',
  java: 'public class Demo{private String name;public Demo(String name){this.name=name;}public String hello(){return "hi, "+name;}}',
};

/* ---------------- 窗口 ---------------- */

/** 菜单「实用工具 → 代码格式化」→ 打开（或置顶）浮窗 */
export async function openFormatterWindow({ text = '' } = {}) {
  const saved = await api.ui.getToolPref('formatter').catch(() => null);
  const cfg = { ...DEFAULTS, ...(saved || {}) };

  const win = openToolWindow({
    key: 'code-format',
    title: '代码格式化',
    size: { width: 980, height: 640 },
    minWidth: 620,
    minHeight: 400,
    html: formatterHtml(cfg),
    onMount: (root, w) => {
      bindFormatter(root, w, cfg, text);
    },
  });
  return win;
}

function formatterHtml(cfg) {
  const opt = (list, cur) => list.map((o) => `<option value="${esc(o.id)}"${String(o.id) === String(cur) ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `
    <div class="fmt-wrap">
      <div class="fmt-bar">
        <label class="fmt-field"><span class="fmt-label">语言</span>
          <select class="fmt-ctl fmt-lang">${LANGS.map((l) => `<option value="${esc(l.id)}"${l.id === cfg.lang ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select>
        </label>
        <label class="fmt-field"><span class="fmt-label">缩进</span>
          <select class="fmt-ctl fmt-indent">${[2, 4, 8].map((n) => `<option value="${n}"${Number(cfg.indent) === n ? ' selected' : ''}>${n} 空格</option>`).join('')}</select>
        </label>
        <label class="fmt-check" title="用制表符缩进（忽略上面的空格数）">
          <input type="checkbox" class="fmt-tabs"${cfg.useTabs ? ' checked' : ''} /><span>用 Tab</span>
        </label>
        <label class="fmt-field fmt-for-prettier"><span class="fmt-label">行宽</span>
          <select class="fmt-ctl fmt-width">${[80, 100, 120].map((n) => `<option value="${n}"${Number(cfg.printWidth) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <label class="fmt-field fmt-for-sql"><span class="fmt-label">SQL 方言</span>
          <select class="fmt-ctl fmt-dialect">${opt(SQL_DIALECTS, cfg.sqlDialect)}</select>
        </label>
        <label class="fmt-field fmt-for-sql"><span class="fmt-label">关键字</span>
          <select class="fmt-ctl fmt-kw">${opt(KEYWORD_CASE, cfg.keywordCase)}</select>
        </label>
        <span class="fmt-spacer"></span>
        <button type="button" class="primary-btn fmt-run">格式化</button>
      </div>
      <div class="fmt-panes">
        <section class="fmt-pane">
          <div class="fmt-pane-head">
            <span class="fmt-pane-title">输入</span>
            <span class="fmt-count fmt-in-count">0 行</span>
            <button type="button" class="mini-btn fmt-clear" title="清空输入">清空</button>
          </div>
          <textarea class="fmt-area fmt-in" spellcheck="false" wrap="off"
                    placeholder="把代码粘贴进来（Ctrl+Enter 格式化，Tab 缩进）"></textarea>
        </section>
        <section class="fmt-pane">
          <div class="fmt-pane-head">
            <span class="fmt-pane-title">结果</span>
            <span class="fmt-count fmt-out-count">—</span>
            <button type="button" class="mini-btn fmt-copy" title="复制结果">复制</button>
          </div>
          <textarea class="fmt-area fmt-out" readonly spellcheck="false" wrap="off"
                    placeholder="格式化结果（只读）"></textarea>
        </section>
      </div>
      <div class="fmt-status" data-state="idle">选好语言后点「格式化」，或按 Ctrl+Enter。</div>
      <div class="fmt-foot">
        <button type="button" class="ghost-btn fmt-sample">填示例</button>
        <button type="button" class="ghost-btn fmt-back">结果写回输入</button>
        <span class="fmt-spacer"></span>
        <span class="fmt-hint">Ctrl+Enter 格式化</span>
        <button type="button" class="primary-btn fmt-copy2">复制结果</button>
      </div>
    </div>`;
}

function bindFormatter(root, win, cfg, initialText) {
  const $ = (s) => root.querySelector(s);
  const inEl = $('.fmt-in');
  const outEl = $('.fmt-out');
  const statusEl = $('.fmt-status');
  const state = { ...cfg };

  const setStatus = (msg, kind = 'idle') => {
    statusEl.textContent = msg;
    statusEl.dataset.state = kind;
  };
  const countText = (t) => `${t ? t.split('\n').length : 0} 行 / ${t.length} 字符`;
  const syncCounts = () => {
    $('.fmt-in-count').textContent = countText(inEl.value);
    $('.fmt-out-count').textContent = outEl.value ? countText(outEl.value) : '—';
  };
  /** 语言相关选项的显隐：SQL 才显示方言 / 关键字，prettier 系才显示行宽 */
  const syncOptionVisibility = () => {
    const lang = resolveLang(state.lang, inEl.value);
    const isSql = lang.engine === 'sql';
    const isPrettier = lang.engine === 'prettier';
    root.querySelectorAll('.fmt-for-sql').forEach((el) => { el.hidden = !isSql; });
    root.querySelectorAll('.fmt-for-prettier').forEach((el) => { el.hidden = !isPrettier; });
  };

  const readOpts = () => ({
    lang: state.lang,
    indent: Number($('.fmt-indent').value) || 2,
    useTabs: $('.fmt-tabs').checked,
    printWidth: Number($('.fmt-width').value) || 100,
    sqlDialect: $('.fmt-dialect').value,
    keywordCase: $('.fmt-kw').value,
  });
  const persist = () => {
    Object.assign(state, readOpts());
    api.ui.setToolPref('formatter', state).catch(() => {});
  };

  const run = async () => {
    const src = inEl.value;
    if (!src.trim()) {
      setStatus('先把要格式化的内容粘贴到左边。', 'idle');
      return;
    }
    const opts = readOpts();
    persist();
    setStatus('格式化中…', 'idle');
    try {
      const { text, lang } = await formatText(src, opts);
      outEl.value = text;
      syncCounts();
      const auto = opts.lang === 'auto' ? `自动识别 → ${lang.label} · ` : '';
      setStatus(`${auto}已格式化 · ${text.split('\n').length} 行 · ${lang.label}`, 'ok');
    } catch (e) {
      const msg = String((e && e.message) || e || '格式化失败');
      // prettier 的语法错误带一大段代码框，只留第一行（后面几行是出错位置的上下文）
      setStatus(`格式化失败：${msg.split('\n')[0]}`, 'err');
    }
  };

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('fmt-run')) await run();
    else if (t.classList.contains('fmt-sample')) {
      const lang = resolveLang(state.lang, inEl.value);
      inEl.value = SAMPLES[lang.id] || SAMPLES.json;
      syncCounts();
      syncOptionVisibility();
      await run();
    } else if (t.classList.contains('fmt-clear')) {
      inEl.value = '';
      outEl.value = '';
      syncCounts();
      setStatus('已清空。', 'idle');
      inEl.focus();
    } else if (t.classList.contains('fmt-copy') || t.classList.contains('fmt-copy2')) {
      if (!outEl.value) { setStatus('还没有可复制的结果。', 'idle'); return; }
      const ok = await copyText(outEl.value);
      notify(ok ? '结果已复制' : '复制失败，请手动选中复制');
    } else if (t.classList.contains('fmt-back')) {
      if (!outEl.value) return;
      inEl.value = outEl.value;
      syncCounts();
      notify('已把结果写回输入');
    }
  });

  root.addEventListener('change', (e) => {
    if (!e.target.classList.contains('fmt-ctl') && !e.target.classList.contains('fmt-tabs')) return;
    if (e.target.classList.contains('fmt-lang')) {
      state.lang = e.target.value;
      // 切语言时把缩进切成该语言的常见值（Java / XML 用 4）
      const preset = langOf(state.lang).indent;
      if (preset && state.lang !== 'auto') $('.fmt-indent').value = String(preset);
    }
    syncOptionVisibility();
    persist();
  });

  root.addEventListener('input', (e) => {
    if (e.target === inEl) {
      syncCounts();
      if (state.lang === 'auto') syncOptionVisibility();
    }
  });

  // Tab 缩进（否则 Tab 会把焦点移出文本域）、Ctrl+Enter 格式化
  root.addEventListener('keydown', (e) => {
    if (e.target !== inEl) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const pad = $('.fmt-tabs').checked ? '\t' : ' '.repeat(Number($('.fmt-indent').value) || 2);
      const s = inEl.selectionStart;
      const en = inEl.selectionEnd;
      inEl.setRangeText(pad, s, en, 'end');
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    }
  });

  if (initialText) {
    inEl.value = String(initialText);
    syncCounts();
  }
  syncOptionVisibility();
  syncCounts();
  inEl.focus();
}
