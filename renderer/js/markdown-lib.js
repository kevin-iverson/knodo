'use strict';
/**
 * Markdown 渲染（笔记预览 / 摘要 / AI 片段展示统一入口）。
 *
 * 用成熟库 markdown-it（vendor/markdown-it/markdown-it.min.js，UMD 挂到 window.markdownit），
 * 而不是自己扩展项目里那个简易渲染器——表格、嵌套列表、转义、引用块这些语义由上游保证，
 * 手写实现会在边界用例上反复出 bug（这也是本项目一贯的取舍：优先引成熟库）。
 *
 * 安全：html:false 关闭原始 HTML 透传，链接统一加 target=_blank + rel=noopener，防 XSS / 反向 tabnabbing。
 *
 * 颜色扩展（==文字=={c:#e5484d;bg:#fff3a3}）：
 * 为什么要自己定义语法而不是直接写 <span style> —— 因为 html:false 是本项目的安全底线
 * （AI 返回的答案也走同一个渲染器），放开原始 HTML 等于给笔记内容开一个注入口子。
 * 所以颜色走「内联标记 + markdown-it 插件」：标记在 content_md 里持久化（导入导出、全文检索、
 * 知识库分块天然生效），渲染时才翻译成 <mark>/<span>；色值只接受 #hex，杜绝 style 注入。
 */
import { renderMarkdown } from './markdown.js';

let mdIt = null;

/** 只认 #rgb / #rrggbb / #rrggbbaa：色值直接进 style 属性，必须白名单校验 */
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** `==文字=={c:#e5484d;bg:#fff3a3}` —— 属性段可选 */
const STYLE_RE = /==([^=\n]+)==(?:\{([^{}\n]*)\})?/g;

/** 字体颜色预设（浅色 / 深色主题下都够用的一组强调色） */
export const TEXT_COLORS = [
  { v: '#e5484d', label: '红' },
  { v: '#f59e0b', label: '橙' },
  { v: '#d9a300', label: '黄' },
  { v: '#46a758', label: '绿' },
  { v: '#12a594', label: '青' },
  { v: '#4f7cff', label: '蓝' },
  { v: '#8e4ec6', label: '紫' },
  { v: '#e1428d', label: '粉' },
  { v: '#8896ab', label: '灰' },
  { v: '#1f2328', label: '墨' },
];

/** 背景高亮预设（默认高亮 = 列表第一项的暖黄） */
export const BG_COLORS = [
  { v: '#fff3a3', label: '黄' },
  { v: '#c9f0d4', label: '绿' },
  { v: '#cfe3ff', label: '蓝' },
  { v: '#ffd6d6', label: '红' },
  { v: '#e8dcff', label: '紫' },
  { v: '#ffe0b8', label: '橙' },
  { v: '#d9f2f0', label: '青' },
  { v: '#e3e6ea', label: '灰' },
];

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 解析属性段：`c:#e5484d;bg:#fff3a3`。
 * 键只认 c / color（字体色）与 bg / background（背景色）；值不是合法 #hex 的一律丢弃——
 * 这是防 style 注入的唯一一道闸，不能放宽成「原样拼进 style」。
 */
function parseStyleAttrs(raw) {
  const out = { color: '', bg: '' };
  String(raw || '').split(';').forEach((part) => {
    const [k, v] = String(part || '').split(':').map((s) => String(s || '').trim());
    if (!k || !v) return;
    const val = v.startsWith('#') ? v : `#${v}`;
    if (!HEX_RE.test(val)) return;
    if (k === 'c' || k === 'color') out.color = val;
    else if (k === 'bg' || k === 'background') out.bg = val;
  });
  return out;
}

function attrString(attrs) {
  const parts = [];
  if (attrs && attrs.color) parts.push(`c:${attrs.color}`);
  if (attrs && attrs.bg) parts.push(`bg:${attrs.bg}`);
  return parts.join(';');
}

/**
 * 拆出选中文本里的样式包裹：`==文字=={...}` → { inner, attrs, wrapped }。
 * 未包裹时原样返回（wrapped=false），便于工具栏「先加色再加背景」时保留已有设置。
 */
export function styleAttrsOf(text) {
  const src = String(text == null ? '' : text);
  const m = /^==([\s\S]*)==(?:\{([^{}\n]*)\})?$/.exec(src.trim());
  if (m) return { inner: m[1], attrs: parseStyleAttrs(m[2]), wrapped: true };
  return { inner: src, attrs: { color: '', bg: '' }, wrapped: false };
}

/** 去掉样式包裹（保留纯文字） */
export function unwrapStyledText(text) {
  return styleAttrsOf(text).inner;
}

/**
 * 给一段文本套上 / 去掉颜色或高亮。
 * @param {string} text 选中的原始文本（可能已被包裹）
 * @param {'color'|'bg'} kind
 * @param {string} value #hex；空值表示清除这一类样式
 * @returns {string} 写回 Markdown 的文本
 */
export function wrapStyledText(text, kind, value) {
  const { inner, attrs } = styleAttrsOf(text);
  const next = { ...attrs };
  if (kind === 'color') next.color = value || '';
  else next.bg = value || '';
  const s = attrString(next);
  // 两类样式都被清掉 → 直接还原成纯文字，不留空壳标记
  return s ? `==${inner}=={${s}}` : inner;
}

/** 样式标记 → HTML 标签（供渲染与列表卡片共用） */
function styledTagHtml(inner, rawAttrs) {
  const st = parseStyleAttrs(rawAttrs);
  // 没写属性段 = 默认高亮（黄底）；只给了字体色则用 span，避免语义上变成「标记」
  const isMark = !!st.bg || !String(rawAttrs || '').trim();
  const style = [];
  if (st.color) style.push(`color:${st.color}`);
  if (st.bg) style.push(`background:${st.bg}`);
  const cls = isMark ? 'md-mark' : 'md-color';
  const attrStyle = style.length ? ` style="${style.join(';')}"` : '';
  const body = isMark ? inner : inner;
  return `<${isMark ? 'mark' : 'span'} class="${cls}"${attrStyle}>${body}</${isMark ? 'mark' : 'span'}>`;
}

/**
 * markdown-it 插件：识别 `==文字=={c:#hex;bg:#hex}`。
 * 注册在 emphasis 之前；`=` 本身是 markdown-it 的终止符，text 规则会在 `==` 处停下把控制权交回来。
 */
function styledTextPlugin(md) {
  md.inline.ruler.before('emphasis', 'styled_text', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    const max = state.posMax;
    if (src.charCodeAt(start) !== 0x3d /* = */ || src.charCodeAt(start + 1) !== 0x3d) return false;
    const openEnd = start + 2;
    const closeAt = src.indexOf('==', openEnd);
    if (closeAt < 0 || closeAt >= max || closeAt === openEnd) return false;
    const inner = src.slice(openEnd, closeAt);
    if (/[=\n]/.test(inner)) return false; // 内容里再出现 = 就不是我们的标记

    let pos = closeAt + 2;
    let rawAttrs = '';
    if (src.charCodeAt(pos) === 0x7b /* { */) {
      const closeBrace = src.indexOf('}', pos);
      if (closeBrace < 0 || closeBrace >= max) return false;
      rawAttrs = src.slice(pos + 1, closeBrace);
      pos = closeBrace + 1;
    }
    const st = parseStyleAttrs(rawAttrs);
    // 写了属性段却一个色值都不合法 → 不当作标记处理，原样输出（避免用户看到奇怪的空标签）
    if (rawAttrs && !st.color && !st.bg) return false;

    if (!silent) {
      const isMark = !!st.bg || !rawAttrs;
      const tag = isMark ? 'mark' : 'span';
      const open = state.push('styled_open', tag, 1);
      open.markup = '==';
      open.attrSet('class', isMark ? 'md-mark' : 'md-color');
      const style = [];
      if (st.color) style.push(`color:${st.color}`);
      if (st.bg) style.push(`background:${st.bg}`);
      if (style.length) open.attrSet('style', style.join(';'));
      // 内部继续走内联解析：**加粗**、`代码`、链接在色块里照常生效
      state.md.inline.parse(inner, state.md, state.env, state.tokens);
      const close = state.push('styled_close', tag, -1);
      close.markup = '==';
    }
    state.pos = pos;
    return true;
  });
}

function getRenderer() {
  if (mdIt) return mdIt;
  if (typeof window === 'undefined' || !window.markdownit) return null;
  mdIt = window.markdownit({
    html: false,      // 关键：不渲染原始 HTML，避免笔记内容注入脚本
    linkify: true,    // 裸 URL 自动成链接
    breaks: false,
    typographer: false,
  });
  const origin = mdIt.renderer.rules.link_open
    || ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  mdIt.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    tokens[idx].attrPush(['target', '_blank']);
    tokens[idx].attrPush(['rel', 'noopener']);
    return origin(tokens, idx, opts, env, self);
  };
  mdIt.use(styledTextPlugin);
  return mdIt;
}

/**
 * 渲染 Markdown → HTML（库缺失时回退到项目自带渲染器，保证界面不会白屏）。
 * @param {string} text
 */
export function renderSafeMarkdown(text) {
  const r = getRenderer();
  if (r) return r.render(String(text || ''));
  return renderMarkdown(text);
}

/** 纯文本预览（列表摘要用；取渲染结果的前 N 字） */
export function markdownToPlain(text, len = 120) {
  const html = renderSafeMarkdown(String(text || '').slice(0, len * 3));
  const div = document.createElement('div');
  div.innerHTML = html;
  const plain = (div.textContent || '').replace(/\s+/g, ' ').trim();
  return plain.length > len ? `${plain.slice(0, len)}…` : plain;
}

/**
 * 列表卡片用的「安全内联渲染」。
 * 卡片只展示一两行摘要，跑完整 Markdown 会渲染出半截的标题 / 列表 / 未闭合标签，
 * 因此这里只做两件事：转义 + 把颜色 / 高亮标记翻成 <mark>/<span>。
 * @param {string} text
 * @param {number} [len] 纯文本长度上限（超出补省略号）
 */
export function renderStyledInline(text, len = 200) {
  const src = String(text == null ? '' : text).slice(0, Math.max(len, 60) * 3);
  let out = '';
  let last = 0;
  let plain = 0;
  let m;
  const re = new RegExp(STYLE_RE.source, 'g');
  while ((m = re.exec(src))) {
    const before = src.slice(last, m.index);
    out += escHtml(before);
    plain += before.length + m[1].length;
    out += styledTagHtml(escHtml(m[1]), m[2]);
    last = re.lastIndex;
  }
  out += escHtml(src.slice(last));
  return plain > len ? `${out}…` : out;
}

/**
 * 关键词高亮（搜索结果用）：先转义再包 <mark>，绝不让关键词本身参与 HTML 解析。
 * @param {string} text
 * @param {string} kw
 */
export function highlightKeyword(text, kw) {
  const src = String(text == null ? '' : text);
  const k = String(kw || '').trim();
  if (!k) return escHtml(src);
  const lower = src.toLowerCase();
  const target = k.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const p = lower.indexOf(target, i);
    if (p < 0) break;
    out += escHtml(src.slice(i, p));
    out += `<mark class="kw-hit">${escHtml(src.slice(p, p + k.length))}</mark>`;
    i = p + k.length;
  }
  return out + escHtml(src.slice(i));
}

/**
 * 在已渲染的 DOM 里给关键词加高亮（预览面板 / 片段溯源用）。
 * 只遍历文本节点并原地替换，不动已渲染的标签结构。
 * @param {HTMLElement} root
 * @param {string} kw
 */
export function markKeywordIn(root, kw) {
  const k = String(kw || '').trim();
  if (!root || !k || typeof document === 'undefined') return;
  const lower = k.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(lower)) return NodeFilter.FILTER_SKIP;
      const p = node.parentElement;
      if (p && (p.closest('.kw-hit') || p.closest('code, pre, script, style'))) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const lt = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let pos = 0;
    let idx = lt.indexOf(lower);
    while (idx >= 0) {
      frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mk = document.createElement('mark');
      mk.className = 'kw-hit';
      mk.textContent = text.slice(idx, idx + k.length);
      frag.appendChild(mk);
      pos = idx + k.length;
      idx = lt.indexOf(lower, pos);
    }
    frag.appendChild(document.createTextNode(text.slice(pos)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
  }
}
