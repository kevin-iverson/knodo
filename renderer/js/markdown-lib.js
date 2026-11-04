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
 *
 * 代码块 / Mermaid（fence 渲染规则被整体接管，见 getRenderer）：
 * - 着色用 vendor 里的 highlight.js（renderer/vendor/highlight），随页面同步加载，
 *   渲染一步到位；语言名对不上时降级为「只转义、不着色」，不报错；
 * - ```mermaid 换成占位 <div class="md-mermaid">，再由 enhanceMarkdown(root) 异步渲染成 SVG
 *   —— mermaid 包有数 MB，只在正文里真出现图时才动态 import 进来，不打开就不付解析成本；
 *   支持的图表类型只有流程图 / 时序图 / 类图 / 甘特图 / 饼图（构建期已裁掉其余图表代码，
 *   见 MERMAID_TYPES 与 scripts/build-tools.js）。
 */
import { renderMarkdown } from './markdown.js';

/** mermaid 块的占位 class（渲染层靠它找到待渲染的图） */
const MERMAID_BOX = 'md-mermaid';
/** 占位块里承载源码的元素：textContent 拿到的就是原始 Mermaid 文本 */
const MERMAID_SRC = 'md-mermaid-src';

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
      // 内部继续走内联解析：**加粗**、`代码`、链接在色块里照常生效。
      // 不能直接把外层 state.tokens 当输出数组：内层 parse 结束时会跑一遍内联后处理
      // （text_collapse 合并相邻 text、emphasis 收尾等），作用范围是**整个数组**，
      // 会把外层已经生成的 token 合并掉，外层 delimiters 里记录的下标随即失效，
      // 表现为「==高亮== 和 **加粗** 同时出现时整段渲染直接抛 TypeError」。
      // 所以先解析进临时数组，再原样追加到外层。
      const innerTokens = [];
      state.md.inline.parse(inner, state.md, state.env, innerTokens);
      innerTokens.forEach((t) => state.tokens.push(t));
      const close = state.push('styled_close', tag, -1);
      close.markup = '==';
    }
    state.pos = pos;
    return true;
  });
}

/* ---------------- 代码块：复制 ---------------- */

/** Electron 里 navigator.clipboard 在 https / file 下可用；老环境退回 execCommand */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 继续走兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) {
    return false;
  }
}

// 复制按钮走「document 级委托」：预览面板每次输入都会重建 innerHTML，
// 逐个按钮绑监听会随重绘丢失；CSP 也不允许内联 onclick。
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-md-copy]') : null;
    if (!btn) return;
    const box = btn.closest('.md-code');
    const code = box && box.querySelector('code');
    if (!code) return;
    const label = btn.textContent;
    copyToClipboard(code.textContent || '').then((ok) => {
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { btn.textContent = label; }, 1200);
    });
  });
}

/** 取全局 highlight.js（由 renderer/index.html 的经典 <script> 引入，见 scripts/vendor/highlight-global.mjs） */
function hljsInstance() {
  return typeof window === 'undefined' ? null : (window.hljs || null);
}

/**
 * markdown-it 的 highlight 钩子：同步返回着色后的 HTML。
 * 返回空串时 markdown-it 会退回「转义 + 无着色」，所以任何异常都不会让渲染失败。
 * @param {string} code 代码块原文（未转义）
 * @param {string} lang ``` 后面写的语言
 * @returns {string}
 */
function highlightHook(code, lang) {
  const hljs = hljsInstance();
  if (!hljs) return '';
  const name = String(lang || '').trim().toLowerCase();
  // mermaid 走单独的占位渲染（fence 规则里处理），这里不能输出成普通代码
  if (!name || name === 'mermaid') return '';
  try {
    if (hljs.getLanguage(name)) {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    }
    // 语言没打包进来：交给 hljs 的自动识别，识别不出就当纯文本
    return hljs.highlightAuto(code).value;
  } catch (e) {
    return '';
  }
}

function getRenderer() {
  if (mdIt) return mdIt;
  if (typeof window === 'undefined' || !window.markdownit) return null;
  mdIt = window.markdownit({
    html: false,      // 关键：不渲染原始 HTML，避免笔记内容注入脚本
    linkify: true,    // 裸 URL 自动成链接
    // breaks:true：单个换行符也渲染成 <br>（CommonMark 标准里单换行只是软换行，
    // 预览会把它折叠成空格 —— 用户「按一次回车预览没换行、要按两次才生效」就是这个原因）。
    // 编辑器里输入几个换行预览就显示几个换行，与保存后重新打开的渲染完全一致。
    breaks: true,
    typographer: false,
  });
  // 代码块整体接管：
  // - ```mermaid → 占位容器，等 enhanceMarkdown() 异步渲染成 SVG；
  //   占位块里保留源码，加载失败 / 语法错误时就地显示源码，不留空白；
  // - 其它代码 → highlight.js 着色 + 语言标签 + 复制按钮。
  //   之所以自己拼 HTML 而不是用 markdown-it 的 highlight 钩子，是为了能顺带包一层
  //   .md-code 外壳（放语言标签和复制按钮），钩子只能返回 <code> 里的内容。
  mdIt.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = String(token.info || '').trim().split(/\s+/)[0].toLowerCase();
    if (lang === 'mermaid') {
      return `<div class="${MERMAID_BOX}"><pre class="${MERMAID_SRC}">${escHtml(token.content)}</pre></div>`;
    }
    const body = highlightHook(token.content, lang) || escHtml(token.content);
    const label = lang || 'text';
    return `<div class="md-code">`
      + `<div class="md-code-bar"><span class="md-code-lang">${escHtml(label)}</span>`
      + `<button type="button" class="md-code-copy" data-md-copy>复制</button></div>`
      + `<pre><code${lang ? ` class="language-${escHtml(label)}"` : ''}>${body}</code></pre>`
      + `</div>`;
  };

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

/* ---------------- Mermaid 图（异步渲染） ---------------- */

/**
 * 支持的图表类型白名单：流程图 / 时序图 / 类图 / 甘特图 / 饼图。
 *
 * 为什么要有这份名单：mermaid 默认把 30 多种图（思维导图、看板、架构图、C4、ELK 布局…）
 * 都带上，整个库 5MB，而笔记里 99% 只用得到这五种。构建期（scripts/build-tools.js）会把
 * 其余图表模块替换成空桩，只打进来这五类 —— 所以这里的名单必须与构建期的 keep 列表一致，
 * 否则会出现「界面说支持、库却加载不出来」。
 *
 * 不支持的语法在**渲染前**就拦下来（见 renderMermaidBatch）：既不白等一次 2MB 的库加载，
 * 也不会让用户看到 mermaid 内部那句看不懂的 UnknownDiagramError。
 */
const MERMAID_TYPES = [
  { re: /^(?:graph|flowchart)\b/, label: '流程图' },
  { re: /^sequenceDiagram\b/, label: '时序图' },
  { re: /^classDiagram\b/, label: '类图' },
  { re: /^gantt\b/, label: '甘特图' },
  { re: /^pie\b/, label: '饼图' },
];

/** 报错 / 帮助文案里复用的「支持哪些图」 */
export const MERMAID_SUPPORTED =
  '流程图（graph / flowchart）、时序图（sequenceDiagram）、类图（classDiagram）、甘特图（gantt）、饼图（pie）';

/**
 * 取 Mermaid 源码的首个关键字判断图表类型，不支持时返回 null。
 * 需要跳过的行：YAML frontmatter（--- … ---）、注释 / 指令（%% 开头）、空行 ——
 * 这些都可能出现在真正的图表声明之前，不跳过就会把注释当成类型。
 * @param {string} src Mermaid 源码
 * @returns {{label: string}|null}
 */
export function detectMermaidType(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (lines.length && /^---\s*$/.test(lines[0])) {
    i = 1;
    while (i < lines.length && !/^(?:---|\.\.\.)\s*$/.test(lines[i])) i++;
    i++; // 跳过结尾的 ---
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('%%')) continue;
    return MERMAID_TYPES.find((x) => x.re.test(t)) || null;
  }
  return null;
}

/** 已加载的 mermaid 实例 / 正在进行的加载 promise（只会真正 import 一次） */
let mermaidApi = null;
let mermaidLoading = null;
/** mermaid.render 的 id 需要唯一（mermaid 内部会按 id 建临时节点） */
let mermaidSeq = 0;
/** 串行化所有渲染：mermaid 内部有共享状态并发渲染会互相踩 */
let mermaidChain = Promise.resolve();

function isDark() {
  try {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  } catch (e) {
    return false;
  }
}

const MERMAID_CONFIG = {
  startOnLoad: false,           // 由我们自己扫描并渲染（页面里没有 class="mermaid" 的元素）
  securityLevel: 'strict',      // DOMPurify 清洗：笔记内容里的脚本进不到 DOM
  suppressErrorRendering: true, // 语法错误时抛异常，由我们显示「源码 + 提示」而不是一张错误图
  fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  flowchart: { htmlLabels: false, curve: 'basis' },
};

/** 懒加载 mermaid 并按当前主题初始化（主题变了就重新 initialize） */
async function ensureMermaid() {
  const theme = isDark() ? 'dark' : 'default';
  if (mermaidApi) {
    if (mermaidApi.__theme !== theme) {
      mermaidApi.initialize({ ...MERMAID_CONFIG, theme });
      mermaidApi.__theme = theme;
    }
    return mermaidApi;
  }
  if (!mermaidLoading) {
    mermaidLoading = import('../vendor/mermaid/mermaid.mjs')
      .then((m) => {
        const api = m.mermaid || m.default;
        api.initialize({ ...MERMAID_CONFIG, theme });
        api.__theme = theme;
        mermaidApi = api;
        return api;
      })
      .catch((e) => {
        mermaidLoading = null; // 允许下次重试，而不是永久卡在失败态
        throw e;
      });
  }
  return mermaidLoading;
}

/** 渲染失败时的占位：保留源码 + 错误提示，用户至少能看到原文 */
function mermaidFail(el, src, msg, title) {
  el.classList.add('is-error');
  el.innerHTML = `<div class="md-mermaid-err">⚠ ${escHtml(title || 'Mermaid 渲染失败：')}${escHtml(msg || '未知错误')}</div>`
    + `<pre class="${MERMAID_SRC}">${escHtml(src)}</pre>`;
}

/**
 * 渲染好的图右上角挂「放大 / 下载图片」两个按钮（hover 才显形，不打扰阅读）。
 * 按钮本身不带数据，点击时由事件委托读同块的 SVG —— mermaid 是异步渲染的，
 * 绑定在按钮上的闭包会挂在「随时可能被重绘替换掉」的节点上，委托才不会失效。
 */
function addZoomButton(el) {
  if (!el || el.querySelector('.md-mermaid-ops')) return;
  const ops = document.createElement('div');
  ops.className = 'md-mermaid-ops';

  const zoom = document.createElement('button');
  zoom.type = 'button';
  zoom.className = 'md-mermaid-zoom';
  zoom.title = '放大查看（滚轮缩放 / 按住拖动平移；双击图也可以；✕ 或 Esc 关闭）';
  zoom.setAttribute('aria-label', '放大查看');
  zoom.textContent = '⤢';

  const dl = document.createElement('button');
  dl.type = 'button';
  dl.className = 'md-mermaid-dl';
  dl.title = '下载为图片（PNG，2 倍分辨率）';
  dl.setAttribute('aria-label', '下载为图片');
  dl.textContent = '⬇';

  ops.appendChild(zoom);
  ops.appendChild(dl);
  el.appendChild(ops);
}

/** 导出文件名：优先用笔记标题 / 区块邻近标题，退化成「图表-时间戳」 */
function exportNameOf(box) {
  const doc = box.ownerDocument || document;
  const noteTitle = doc.querySelector('.nt-dp-title');
  const base = (noteTitle && noteTitle.value) ? noteTitle.value.trim() : '';
  const stamp = new Date().toISOString().slice(0, 10);
  return base ? `${base}-${stamp}` : `图表-${stamp}`;
}

/** 取图所属的类型名（流程图 / 时序图…）用于放大层标题；认不出来就统称「图表」 */
function zoomTitleOf(el) {
  const src = (el && el.__mmSrc) || '';
  const hit = detectMermaidType(src);
  return (hit && hit.label) || '图表';
}

/** 打开某张图的放大层（库按需 import：没画过图就永远不加载这份代码） */
function openZoomFor(el) {
  const svg = el && el.querySelector ? el.querySelector('svg') : null;
  if (!svg) return;
  import('./mermaid-zoom.js')
    .then((m) => m.openMermaidZoom({ source: svg, title: zoomTitleOf(el) }))
    .catch(() => { /* 加载失败就不放大，正文里的图照常可看 */ });
}

if (typeof document !== 'undefined') {
  // 点「放大」按钮
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.md-mermaid-zoom') : null;
    if (!btn) return;
    const box = btn.closest('.md-mermaid');
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    openZoomFor(box);
  });
  // 点「下载图片」：导出成 PNG（原生「另存为」对话框，成功后提示落地路径）
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.md-mermaid-dl') : null;
    if (!btn) return;
    const box = btn.closest('.md-mermaid');
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.dataset.busy === '1') return; // 连点不叠对话框
    btn.dataset.busy = '1';
    const name = exportNameOf(box);
    import('./mermaid-export.js')
      .then((m) => m.exportMermaidPng(box, { name }))
      .then((res) => {
        if (!res || res.canceled) return;
        // ui.js 是笔记模块的上层，动态 import 拿已加载的实例，不构成循环依赖
        return import('./ui.js').then((ui) => {
          if (res.ok && res.filePath) ui.toast(`图片已保存：${res.filePath}`);
        }).catch(() => {});
      })
      .catch((err) => {
        import('./ui.js')
          .then((ui) => ui.toast(`导出失败：${(err && err.message) || err}`))
          .catch(() => {});
      })
      .finally(() => { btn.dataset.busy = ''; });
  });
  // 双击图也能放大。用捕获阶段 + stopPropagation：宿主（笔记预览 / 详情等）可能自己也监听双击，
  // 冒泡过去会出现「放大层开了、底下的界面也跟着跳」的叠加反应。
  document.addEventListener('dblclick', (e) => {
    const svg = e.target && e.target.closest ? e.target.closest('.md-mermaid svg') : null;
    if (!svg) return;
    const box = svg.closest('.md-mermaid');
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    openZoomFor(box);
  }, true);
}

async function renderMermaidBatch(nodes) {
  // 先做「类型白名单」筛选：不支持的图表类型就地报错，一个字节的库都不用加载。
  // 空块也在这里一次性处理掉，省得后面几处都判一遍。
  const supported = [];
  for (const el of nodes) {
    if (!el.isConnected) continue;
    const srcEl = el.querySelector(`.${MERMAID_SRC}`);
    const src = srcEl ? srcEl.textContent : (el.textContent || '');
    if (!String(src).trim()) {
      el.classList.add('is-error');
      el.innerHTML = '<div class="md-mermaid-err">⚠ 空的 Mermaid 代码块</div>';
      continue;
    }
    if (!detectMermaidType(src)) {
      mermaidFail(el, src, `仅支持${MERMAID_SUPPORTED}`, '不支持的图表类型：');
      continue;
    }
    supported.push(el);
  }
  if (!supported.length) return;

  let api = null;
  try {
    api = await ensureMermaid();
  } catch (e) {
    supported.forEach((el) => mermaidFail(el, el.textContent || '', `图形库加载失败（${(e && e.message) || e}）`));
    return;
  }
  for (const el of supported) {
    // 等 mermaid 期间正文可能又被改写过（打字 / 切笔记），节点已脱离文档就不用再插了
    if (!el.isConnected) continue;
    const srcEl = el.querySelector(`.${MERMAID_SRC}`);
    const src = srcEl ? srcEl.textContent : (el.textContent || '');
    if (!String(src).trim()) {
      el.classList.add('is-error');
      el.innerHTML = '<div class="md-mermaid-err">⚠ 空的 Mermaid 代码块</div>';
      continue;
    }
    try {
      el.__mmSrc = src; // 记住源码：主题切换时要按新主题重画
      const res = await api.render(`mmd-${Date.now().toString(36)}-${++mermaidSeq}`, src);
      if (!el.isConnected) continue;
      const svg = res && res.svg ? res.svg : '';
      // 包一层 .md-mermaid-view：横向滚动交给内层，外层留着定位「放大」按钮
      // （按钮若跟着横向滚动走，图一宽就被推出可视区了）
      el.innerHTML = svg ? `<div class="md-mermaid-view">${svg}</div>` : '';
      el.classList.add('is-ok');
      if (svg) addZoomButton(el);
      if (res && typeof res.bindFunctions === 'function') {
        try { res.bindFunctions(el); } catch (e) { /* 交互绑定失败不影响看图 */ }
      }
    } catch (e) {
      if (!el.isConnected) continue;
      mermaidFail(el, src, (e && e.message) || String(e));
    }
  }
}

/**
 * 渲染结果插入 DOM 后调用：把 ```mermaid 占位块换成真正的 SVG。
 * - 只对「可见」的块动手：隐藏容器里量不到宽度，图会画成 0 宽（等切回预览时会再调一次）；
 * - 已经渲染过的块有 data-mm-done 标记，重复调用不会重画；
 * - 全程不 await 也不会打断渲染流程（返回 promise 仅供需要时等待）。
 * @param {HTMLElement} root 渲染结果的容器
 * @returns {Promise<void>}
 */
export function enhanceMarkdown(root) {
  if (!root || typeof document === 'undefined') return Promise.resolve();
  if (typeof root.querySelectorAll !== 'function') return Promise.resolve();
  const pending = Array.from(root.querySelectorAll(`.${MERMAID_BOX}:not([data-mm-done])`))
    .filter((el) => el.getClientRects().length > 0);
  if (!pending.length) return Promise.resolve();
  pending.forEach((el) => { el.dataset.mmDone = '1'; });
  mermaidChain = mermaidChain.then(() => renderMermaidBatch(pending)).catch(() => {});
  return mermaidChain;
}

/**
 * 主题切换后重画：mermaid 的配色是 initialize 时定死的，不重画就会「深色背景配深字」。
 * 做法是把已渲染的块还原成源码占位、清掉标记，再让下一轮 enhance 重新画。
 */
function rerenderMermaidForTheme() {
  const nodes = Array.from(document.querySelectorAll(`.${MERMAID_BOX}[data-mm-done]`));
  nodes.forEach((el) => {
    const src = el.__mmSrc || '';
    el.innerHTML = `<pre class="${MERMAID_SRC}">${escHtml(src)}</pre>`;
    delete el.dataset.mmDone;
  });
  if (nodes.length) mermaidChain = mermaidChain.then(() => renderMermaidBatch(nodes)).catch(() => {});
}

if (typeof document !== 'undefined') {
  // 应用主题切换时由 ui.js 派发；没画过图就什么都不用做（下次渲染自然是新的主题）
  document.addEventListener('app:theme-changed', () => {
    if (mermaidApi) rerenderMermaidForTheme();
  });
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
