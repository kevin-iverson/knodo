'use strict';
/**
 * highlight.js 打包入口（renderer/vendor/tools/highlight.mjs）。
 *
 * 只注册「实用工具」真正会用到的语言（JSON / JS / TS / HTML-XML / CSS 系 / Markdown / YAML / SQL / Java），
 * 走 core + 按需注册而不是全量包，体积能小一个数量级。
 *
 * 输出是 highlight.js 的 token HTML（已做 HTML 转义），调用方直接塞进 <code> 即可；
 * 配色不在这里——写在 renderer/css/styles.css 的 .hljs-* 规则里，跟着应用主题走。
 */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import less from 'highlight.js/lib/languages/less';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('less', less);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('java', java);

/** 业务语言 id → highlight.js 语言名（拿不到就当没有高亮） */
const ALIAS = {
  html: 'xml',
  jsonc: 'json',
};

/**
 * 高亮一段代码。
 * @param {string} code
 * @param {string} langId 业务语言 id（json / javascript / xml / sql …）
 * @returns {string} HTML；无匹配语言或出错时返回转义后的纯文本
 */
export function highlightCode(code, langId) {
  const src = String(code == null ? '' : code);
  if (!src) return '';
  const name = ALIAS[String(langId || '')] || String(langId || '');
  if (!name || !hljs.getLanguage(name)) {
    return hljs.highlight(src, { language: 'plaintext' }).value;
  }
  try {
    return hljs.highlight(src, { language: name, ignoreIllegals: true }).value;
  } catch (e) {
    return hljs.highlight(src, { language: 'plaintext' }).value;
  }
}

/** 只做 HTML 转义（不认识的语言 / 关掉高亮时用） */
export function escapeCode(code) {
  return String(code == null ? '' : code)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const LANGUAGES = hljs.listLanguages();
export { hljs };
