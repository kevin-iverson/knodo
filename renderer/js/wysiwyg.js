'use strict';
/**
 * 语雀式所见即所得笔记编辑器（只读展示态 / 可编辑态）。
 *
 * 核心取舍：**只有一份 DOM**。展示态和编辑态用的是同一个 `#nt-preview` 容器、
 * 同一份 markdown-it 渲染结果、同一套 `.markdown-body` 样式；切态只是开关
 * `contenteditable` 和工具条显隐，不重建内容 —— 所以排版天然一致、Markdown
 * 标记天然不可见、切换过程中内容与光标不会「跳一下」或丢格式。
 *
 * 数据仍然存 Markdown（`notes.content_md`）：
 * - 读入用 markdown-lib 的 `renderMarkdownBlocks()`，按顶层块保留原始片段；
 * - 写回用 turndown（UMD，随仓库 vendor），未改动的块直接复用原始片段（字节级不变），
 *   只有真正编辑过的块才重新序列化；
 * - 项目自定义语法（颜色高亮 / Mermaid / 带语言标签的代码块）有专门的 turndown
 *   rule 原样还原，不会因为「打开 → 改一个字 → 保存」而整篇被规范化。
 *
 * 编辑语义交给 Chromium 原生的 contenteditable / execCommand（Electron 里稳定可用），
 * 自研部分只有薄薄的一层：两态状态机、工具条、快捷键、只读拦截、块级原文保真。
 */

import {
  renderMarkdownBlocks, enhanceMarkdown, renderSafeMarkdown, TEXT_COLORS, BG_COLORS,
} from './markdown-lib.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ---------------- Markdown 语法识别（粘贴时提示转换） ---------------- */

/**
 * 判定「粘贴进来的这段纯文本像不像 Markdown」。
 * 只在粘贴路径上用，所以宁可漏判也别错判：中文里偶尔一个 `*` 或行首 `-`
 * 不该弹出「要转换吗」。规则是：围栏代码 / 表格分隔行命中即算，
 * 其余语法至少命中两类不同特征才提示。
 */
const MD_SIGNALS = [
  { key: 'fence', re: /^```/m },
  { key: 'heading', re: /^#{1,6}\s+\S/m },
  { key: 'bold', re: /\*\*[^*\n]+\*\*|__[^_\n]+__/ },
  { key: 'italic', re: /(^|\s)\*[^*\n]+\*(\s|$)/ },
  { key: 'bullet', re: /^[ \t]*[-*+]\s+\S/m },
  { key: 'ordered', re: /^[ \t]*\d+[.)]\s+\S/m },
  { key: 'quote', re: /^[ \t]*>\s?\S/m },
  { key: 'link', re: /\[[^\]\n]+\]\([^)\s]+\)/ },
  { key: 'table', re: /^[ \t]*\|?[\s:-]*\|[\s:|-]*$/m },
  { key: 'hr', re: /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m },
];

/**
 * @param {string} text 粘贴进来的纯文本
 * @returns {boolean}
 */
export function looksLikeMarkdown(text) {
  const s = String(text == null ? '' : text);
  if (s.trim().length < 6) return false;
  if (!/[#*`>|_[\]]/.test(s)) return false;
  const hits = MD_SIGNALS.filter((x) => x.re.test(s));
  if (hits.some((x) => x.key === 'fence' || x.key === 'table')) return true;
  return hits.length >= 2;
}

/** 工具条：只读态整条 hidden，编辑态才出现。图标用文字符号，离线不依赖图标字体。 */
export const TOOLBAR_HTML = `
  <div class="nt-wys-bar" data-nt-toolbar hidden>
    <button type="button" class="nt-tb-btn nt-tb-block" data-nt-cmd="block"
            title="段落样式（Ctrl+Alt+0 ~ 3）">正文 <span class="nt-tb-caret">▾</span></button>
    <span class="nt-tb-sep"></span>
    <button type="button" class="nt-tb-btn" data-nt-cmd="bold" title="加粗 (Ctrl+B)"><b>B</b></button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="italic" title="斜体 (Ctrl+I)"><i>I</i></button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="underline" title="下划线 (Ctrl+U)"><u>U</u></button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="strike" title="删除线 (Ctrl+Shift+X)"><s>S</s></button>
    <span class="nt-tb-sep"></span>
    <button type="button" class="nt-tb-btn nt-tb-color" data-nt-cmd="color" title="字体颜色">A</button>
    <button type="button" class="nt-tb-btn nt-tb-bg" data-nt-cmd="bg" title="背景高亮">H</button>
    <span class="nt-tb-sep"></span>
    <button type="button" class="nt-tb-btn" data-nt-cmd="h1" title="一级标题 (Ctrl+Alt+1)">H1</button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="h2" title="二级标题 (Ctrl+Alt+2)">H2</button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="h3" title="三级标题 (Ctrl+Alt+3)">H3</button>
    <span class="nt-tb-sep"></span>
    <button type="button" class="nt-tb-btn" data-nt-cmd="ul" title="无序列表 (Ctrl+Shift+8)">•≡</button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="ol" title="有序列表 (Ctrl+Shift+7)">1≡</button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="quote" title="引用">❝</button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="code" title="代码块（可选语言）">&lt;/&gt;</button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="table" title="插入表格">▦</button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="hr" title="分割线">—</button>
    <span class="nt-tb-sep"></span>
    <button type="button" class="nt-tb-btn" data-nt-cmd="link" title="链接 (Ctrl+K)">🔗</button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="image" title="插入图片（本地文件）">🖼</button>
    <span class="nt-tb-sep"></span>
    <button type="button" class="nt-tb-btn" data-nt-cmd="undo" title="撤销 (Ctrl+Z)">↶</button>
    <button type="button" class="nt-tb-btn" data-nt-cmd="redo" title="重做 (Ctrl+Shift+Z)">↷</button>
    <span class="nt-tb-spacer"></span>
    <button type="button" class="nt-tb-btn nt-tb-help" data-nt-cmd="guide" title="快捷键速查">?</button>
  </div>`;

/**
 * 代码块可选语言白名单。
 * 值必须和 highlight.js 的 language id 对齐（`js`/`ts`/`bash` 这些短名 hljs 都认），
 * 白名单之外的语言不写进正文 —— 否则序列化后 ```xxx 可能被渲染侧当成未知语言。
 */
const CODE_LANGS = [
  { v: 'text', t: '纯文本' },
  { v: 'js', t: 'JavaScript' },
  { v: 'ts', t: 'TypeScript' },
  { v: 'python', t: 'Python' },
  { v: 'java', t: 'Java' },
  { v: 'go', t: 'Go' },
  { v: 'rust', t: 'Rust' },
  { v: 'c', t: 'C' },
  { v: 'cpp', t: 'C++' },
  { v: 'csharp', t: 'C#' },
  { v: 'php', t: 'PHP' },
  { v: 'html', t: 'HTML' },
  { v: 'css', t: 'CSS' },
  { v: 'scss', t: 'SCSS' },
  { v: 'json', t: 'JSON' },
  { v: 'yaml', t: 'YAML' },
  { v: 'xml', t: 'XML' },
  { v: 'sql', t: 'SQL' },
  { v: 'bash', t: 'Shell' },
  { v: 'dockerfile', t: 'Dockerfile' },
  { v: 'diff', t: 'Diff' },
  { v: 'markdown', t: 'Markdown' },
  { v: 'mermaid', t: 'Mermaid 图表' },
  { v: 'ini', t: 'INI' },
];
const codeLangLabel = (v) => {
  const hit = CODE_LANGS.find((x) => x.v === v);
  return hit ? hit.t : v;
};
const isCodeLang = (v) => CODE_LANGS.some((x) => x.v === v);

/* ---------------- turndown：DOM → Markdown ---------------- */

/** 把项目自定义渲染节点还原成项目自定义 Markdown 语法 */
function buildTurndown() {
  const TD = window.TurndownService;
  if (!TD) return null;
  const td = new TD({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    // markdown-it 开了 breaks:true（单换行即 <br>），turndown 的 br rule 是
    // `options.br + '\n'`，所以这里必须是空串才能回写成单个换行而不是空行。
    br: '',
  });
  if (window.turndownPluginGfm) td.use(window.turndownPluginGfm.gfm);

  // Mermaid：enhanceMarkdown() 会把占位里的源码 <pre> 换成 SVG，
  // 所以 setContent() 时先把源码备份到 data-nt-mmd，这里从属性还原。
  td.addRule('ntMermaid', {
    filter: (n) => n.nodeName === 'DIV' && n.classList && n.classList.contains('md-mermaid'),
    replacement: (_c, n) => {
      const src = (n.getAttribute('data-nt-mmd') || '').replace(/\n$/, '');
      return `\n\n\`\`\`mermaid\n${src}\n\`\`\`\n\n`;
    },
  });

  // 代码块：从 .md-code 外壳读语言标签与纯文本，忽略 highlight.js 的着色 span。
  // 外壳里若被浏览器塞进了别的节点（在文档末尾插入表格时，Chromium 会把新节点
  // 挂进最近的块容器 .md-code 里），必须一并序列化出来，否则新内容会被静默吞掉。
  td.addRule('ntCode', {
    filter: (n) => n.nodeName === 'DIV' && n.classList && n.classList.contains('md-code'),
    replacement: (_c, n) => {
      const lang = (n.querySelector('.md-code-lang')?.textContent || '').trim();
      const code = (n.querySelector('pre code')?.textContent || '').replace(/\n$/, '');
      const info = lang && lang !== 'text' ? lang : '';
      let out = `\n\n\`\`\`${info}\n${code}\n\`\`\`\n\n`;
      const rest = n.cloneNode(true);
      rest.querySelectorAll('pre, .md-code-bar').forEach((x) => x.remove());
      const extra = td.turndown(rest.innerHTML).trim();
      if (extra) out += `\n\n${extra}\n\n`;
      return out;
    },
  });

  // 颜色 / 高亮：==文字=={c:#hex;bg:#hex}
  td.addRule('ntStyled', {
    filter: (n) => !!n.classList && (
      (n.nodeName === 'MARK' && n.classList.contains('md-mark'))
      || (n.nodeName === 'SPAN' && n.classList.contains('md-color'))
    ),
    replacement: (content, n) => {
      const parts = String(n.getAttribute('style') || '').split(';').map((p) => p.trim());
      const pick = (key) => {
        const hit = parts.find((p) => p.startsWith(`${key}:`));
        return hit ? hit.slice(key.length + 1).trim() : '';
      };
      const c = pick('color');
      const bg = pick('background') || pick('background-color');
      const attrs = [];
      if (c) attrs.push(`c:${c}`);
      if (bg) attrs.push(`bg:${bg}`);
      return `==${content}==${attrs.length ? `{${attrs.join(';')}}` : ''}`;
    },
  });

  // 项目用 todo-media:/// 协议读附件，turndown 默认 image rule 原样输出 src，这里只
  // 保证 alt 不把方括号带进去。
  td.addRule('ntImage', {
    filter: (n) => n.nodeName === 'IMG',
    replacement: (_c, n) => {
      const src = n.getAttribute('src') || '';
      const alt = String(n.getAttribute('alt') || '').replace(/[[\]]/g, '');
      return `![${alt}](${src})`;
    },
  });
  return td;
}

let turndown = null;
function getTurndown() {
  if (!turndown) turndown = buildTurndown();
  return turndown;
}

/* ---------------- 浮层（标题菜单 / 链接输入） ---------------- */

let overlayEl = null;
let overlayKeyBound = false;
/** 浮层被「非选择」方式关掉时的兜底回调（例如粘贴转换提示被 Esc 关掉 → 仍要落原文） */
let overlayOnClose = null;

function closeOverlay(silent) {
  const cb = silent ? null : overlayOnClose;
  overlayOnClose = null;
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  document.removeEventListener('mousedown', onOverlayOutside, true);
  if (overlayKeyBound) {
    document.removeEventListener('keydown', onOverlayKey, true);
    overlayKeyBound = false;
  }
  if (cb) cb();
}
function onOverlayOutside(e) {
  if (!overlayEl) return;
  if (!overlayEl.contains(e.target) && !e.target.closest?.('.nt-wys-bar')) closeOverlay();
}
function onOverlayKey(e) {
  if (!overlayEl) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOverlay(); }
}

/* ---------------- 实例 ---------------- */

/**
 * @param {object} o
 * @param {HTMLElement} o.root    正文容器（#nt-preview）
 * @param {HTMLElement} o.pane    详情面板（.nt-dp）
 * @param {HTMLElement} o.toolbar 工具条（.nt-wys-bar）
 * @param {'markdown'|'html'} [o.mode] 数据形态：
 *        - `markdown`（默认）读 / 写 Markdown，供笔记用（两态：只读预览 ↔ 工具条编辑）；
 *        - `html` 读 / 写 HTML，供任务详情的描述用（常驻编辑态，工具条一直显示）。
 *        两种模式共用同一份 DOM / 同一套工具条与快捷键，只是序列化方式不同 ——
 *        描述存 HTML 是为了不改变既有数据语义（AI 报告、检索、备份都在按 HTML 处理它）。
 * @param {(msg:string)=>void} o.notify
 * @param {()=>void} o.onInput   正文有改动（触发自动保存）
 * @param {(editing:boolean)=>void} o.onEditingChange
 * @param {object} o.hooks       { pasteImage, pickImage, palette, guide, canExit, exitEdit, enterEdit }
 */
export function createWysiwyg(o) {
  const { root, pane, toolbar } = o;
  const htmlMode = o.mode === 'html';
  const notify = o.notify || (() => {});
  const hooks = o.hooks || {};
  let editing = false;
  let disposed = false;
  let originalMd = '';
  let sources = [];
  let blockCount = 0;
  let dirty = false;
  /** 进编辑时摊平过代码块高亮 → 退出时要重渲一次把高亮画回来 */
  let needRerender = false;
  let savedRange = null;

  /* ---- 选区 ---- */
  function saveSelection() {
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && root.contains(sel.anchorNode)) {
        savedRange = sel.getRangeAt(0).cloneRange();
      }
    } catch (e) { /* 选区不在正文里 */ }
  }
  function restoreSelection() {
    if (!savedRange) return;
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    } catch (e) { /* range 已失效（节点被重渲） */ }
  }
  function focusRoot(restore = false) {
    if (document.activeElement !== root && !root.contains(document.activeElement)) root.focus();
    // 只有「浮层输入抢过焦点」的场景才需要恢复选区。普通工具条命令在 mousedown
    // 阶段已阻止默认聚焦，选区还在正文里；这时再 restore 反而会把选区拽回上一次的位置，
    // 让加粗 / 标题作用到错误的块上。
    if (restore) restoreSelection();
  }

  /* ---- 渲染 ---- */

  /** 复杂块整体不可编辑：避免把 SVG / 高亮 span / 表格结构改坏，
   *  但允许整块选中删除，也允许在块间插入新段落。 */
  function lockComplexNodes() {
    root.querySelectorAll('.md-mermaid, .md-code-bar, .md-code-copy, img, hr').forEach((el) => {
      el.setAttribute('contenteditable', 'false');
    });
  }

  /**
   * 把「裸」的 `<pre><code>` 包成与笔记渲染一致的 `.md-code` 外壳（语言标签 + 代码区）。
   * 描述里的 HTML 可能来自老数据（markdown 渲染器直出的 pre / code），
   * 统一成外壳后才与工具条插入的代码块长得一样，也能点标签换语言。
   */
  function normalizeCodeShells(box) {
    box.querySelectorAll('pre').forEach((pre) => {
      if (pre.closest('.md-code') || pre.closest('.md-mermaid')) return;
      const code = pre.querySelector('code');
      if (!code) return;
      const lang = ((code.className || '').match(/language-([\w+#.-]+)/) || [])[1] || 'text';
      const shell = document.createElement('div');
      shell.className = 'md-code';
      const bar = document.createElement('div');
      bar.className = 'md-code-bar';
      bar.setAttribute('contenteditable', 'false');
      const label = document.createElement('span');
      label.className = 'md-code-lang';
      label.textContent = lang;
      bar.appendChild(label);
      shell.appendChild(bar);
      pre.replaceWith(shell);
      shell.appendChild(pre);
      code.className = lang === 'text' ? '' : `language-${lang}`;
    });
  }

  /** @param {string} input Markdown（默认模式）或 HTML（html 模式） */
  function setContent(input) {
    const text = String(input || '');
    originalMd = text;
    dirty = false;
    savedRange = null;
    root.classList.toggle('is-empty', !text.trim());
    if (htmlMode) {
      // 描述编辑器：内容本来就是 HTML，直接落进 DOM（空串交给 CSS 占位符）
      root.innerHTML = text.trim() ? text : '';
      normalizeCodeShells(root);
      lockComplexNodes();
      enhanceMarkdown(root);
      return;
    }
    const built = renderMarkdownBlocks(text);
    sources = built.sources || [];
    root.innerHTML = built.html
      || '<div class="nt-blk" data-nt-blk="0" data-nt-clean><p><br></p></div>';
    blockCount = root.children.length;
    // enhanceMarkdown 会清掉 mermaid 占位里的源码 <pre>，先把源码备份成属性
    root.querySelectorAll('.md-mermaid').forEach((el) => {
      const pre = el.querySelector('.md-mermaid-src');
      if (pre) el.setAttribute('data-nt-mmd', pre.textContent || '');
    });
    lockComplexNodes();
    enhanceMarkdown(root);
  }

  /* ---- 序列化 ---- */
  function value(md) {
    if (arguments.length) { setContent(md); return undefined; }
    if (htmlMode) {
      // 空内容统一成空串：库里存空串，而不是浏览器塞进来的 <br> / 空段落
      if (!root.textContent.trim() && !root.querySelector('img')) return '';
      // contenteditable 属性只是编辑态的实现细节，不进正文
      const clone = root.cloneNode(true);
      clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
      return clone.innerHTML;
    }
    if (!dirty) return originalMd;
    const td = getTurndown();
    const parts = [];
    for (const el of [...root.children]) {
      const idx = el.dataset ? el.dataset.ntBlk : null;
      if (idx != null && el.hasAttribute('data-nt-clean') && sources[idx] != null) {
        parts.push(sources[idx]);
      } else if (td) {
        // 新增 / 被 execCommand 改写过的块没有 .nt-blk 外壳，必须用 outerHTML，
        // 否则 <h2>、<ul> 这些标签本身会被丢掉，只剩纯文本。
        parts.push(td.turndown(el.outerHTML || el.innerHTML).trim());
      } else {
        parts.push(el.textContent || '');
      }
    }
    return parts.filter((p) => p !== '').join('\n\n');
  }

  /* ---- 变更 ---- */
  function markDirtyAround(targets) {
    let hit = false;
    const list = [...(targets || [])];
    try {
      const sel = window.getSelection();
      if (sel && root.contains(sel.anchorNode)) list.push(sel.anchorNode);
      if (sel && root.contains(sel.focusNode)) list.push(sel.focusNode);
    } catch (e) { /* 忽略 */ }
    for (const n of list) {
      const el = n && n.nodeType === 1 ? n : (n && n.parentElement);
      const blk = el && el.closest ? el.closest('.nt-blk') : null;
      if (blk && root.contains(blk)) { blk.removeAttribute('data-nt-clean'); hit = true; }
    }
    // 完全定位不到改动块时（例如 execCommand 把整个块替换掉了）才保守地全标脏。
    // 注意：块数变化本身不代表内容变了 —— 新增一个段落时其它块仍应复用原文。
    if (!hit) {
      root.querySelectorAll('.nt-blk[data-nt-clean]').forEach((b) => b.removeAttribute('data-nt-clean'));
    }
  }
  function afterChange() {
    dirty = true;
    markDirtyAround([]);
    syncToolbarState();
    if (o.onInput) o.onInput();
  }

  /* ---- 命令 ---- */
  function exec(cmd, val) {
    if (!editing) return;
    focusRoot();
    try { document.execCommand(cmd, false, val); } catch (e) { /* 忽略不支持的命令 */ }
    saveSelection();
    afterChange();
  }
  /**
   * 插入结构性内容（表格 / 代码块 / 图片 / 粘贴文本）前，先把折叠光标挪到
   * 「块级边界」。Chromium 把 insertHTML 落在文档末尾时，会把新节点塞进最近的
   * 块容器（例如 .md-code 外壳）内部，而不是新建一个顶层块 —— 视觉上像插在了
   * 代码块里面，序列化时又会被代码块规则吞掉。
   */
  function normaliseInsertionPoint() {
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
      const node = sel.anchorNode;
      const el = node && node.nodeType === 1 ? node : node && node.parentElement;
      const shell = el && el.closest ? el.closest('.md-code, .md-mermaid') : null;
      const atRootEnd = node === root || el === root;
      if (!shell && !atRootEnd) return;
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      if (shell && shell.parentElement) shell.parentElement.insertBefore(p, shell.nextSibling);
      else root.appendChild(p);
      const r = document.createRange();
      r.setStart(p, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { /* 位置无法规范化时交给浏览器默认行为 */ }
  }

  function insertHTML(html) {
    if (!editing) return;
    focusRoot();
    normaliseInsertionPoint();
    try { document.execCommand('insertHTML', false, html); } catch (e) { /* 忽略 */ }
    saveSelection();
    afterChange();
  }
  function formatBlock(tag) {
    // Chromium 的 formatBlock 接受 'h1' / '<h1>' 两种写法，带尖括号兼容性更好
    exec('formatBlock', `<${tag}>`);
  }

  function openBlockMenu(anchor) {
    const items = [
      { cmd: 'p', label: '正文', hint: 'Ctrl+Alt+0' },
      { cmd: 'h1', label: '标题 1', hint: 'Ctrl+Alt+1' },
      { cmd: 'h2', label: '标题 2', hint: 'Ctrl+Alt+2' },
      { cmd: 'h3', label: '标题 3', hint: 'Ctrl+Alt+3' },
      { cmd: 'blockquote', label: '引用', hint: '' },
    ];
    showOverlay(anchor, `<div class="nt-overlay-title">段落样式</div>${items.map((it) => `
      <button type="button" class="nt-overlay-item" data-ov-cmd="${it.cmd}">
        <span>${it.label}</span><small>${it.hint}</small>
      </button>`).join('')}`, (btn) => {
      const cmd = btn.dataset.ovCmd;
      formatBlock(cmd);
      closeOverlay();
    });
  }

  /**
   * 语言选择浮层：插入新代码块、改已有代码块的语言共用一份列表。
   * @param {HTMLElement} anchor 浮层贴着谁
   * @param {string} current 当前语言（高亮显示）
   * @param {(lang:string)=>void} apply 选中后的回调
   */
  function openCodeLangBox(anchor, current, apply) {
    const cur = String(current || 'text').toLowerCase();
    // 快捷键进来时没有按钮可贴，退化成贴正文左上角
    const ba = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor : root;
    showOverlay(ba, `
      <div class="nt-overlay-title">代码块语言</div>
      <div class="nt-lang-grid">${CODE_LANGS.map((x) => `
        <button type="button" class="nt-lang-item${x.v === cur ? ' active' : ''}"
                data-ov-lang="${x.v}" title="${esc(x.v)}">${esc(x.t)}</button>`).join('')}
      </div>`, null);
    overlayEl?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ov-lang]');
      if (!b) return;
      const lang = b.dataset.ovLang;
      closeOverlay();
      // 浮层按钮抢过焦点，先把正文选区恢复回来再动 DOM
      focusRoot(true);
      apply(lang);
    });
  }

  /** 插入一个空代码块，并把光标放进代码区（插完直接打字） */
  function insertCodeBlock(lang) {
    const l = isCodeLang(lang) ? lang : 'text';
    const before = new Set([...root.querySelectorAll('.md-code')]);
    const cls = l === 'text' ? '' : ` class="language-${esc(l)}"`;
    insertHTML('<div class="md-code"><div class="md-code-bar" contenteditable="false">'
      + `<span class="md-code-lang">${esc(l)}</span></div>`
      + `<pre><code${cls}><br></code></pre></div><p><br></p>`);
    const shell = [...root.querySelectorAll('.md-code')].find((x) => !before.has(x));
    if (!shell) return;
    const code = shell.querySelector('pre code');
    if (code) {
      const r = document.createRange();
      r.setStart(code, 0);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      saveSelection();
    }
    if (typeof shell.scrollIntoView === 'function') shell.scrollIntoView({ block: 'nearest' });
    if (l === 'mermaid') notify('Mermaid 图表在退出编辑后渲染成图');
  }

  /** 改已有代码块的语言：保留代码内容，序列化时按新语言写 fence */
  function setBlockLang(shell, lang) {
    const l = isCodeLang(lang) ? lang : 'text';
    const label = shell.querySelector('.md-code-lang');
    if (label) label.textContent = l;
    const code = shell.querySelector('pre code');
    if (code) {
      code.className = l === 'text' ? '' : `language-${l}`;
      if (!code.textContent) code.innerHTML = '<br>';
    }
    // 只标脏这一块：序列化时才会用新语言重写 ```lang，其余块仍复用原始片段
    const blk = shell.closest('.nt-blk');
    if (blk) blk.removeAttribute('data-nt-clean');
    dirty = true;
    if (o.onInput) o.onInput();
    if (l === 'mermaid') notify('Mermaid 图表在退出编辑后渲染成图');
  }

  /**
   * 进编辑态时把代码块里的高亮 span 摊平成纯文本。
   * 着色 span 在 contenteditable 里会被输入打断（新字符落进某个 span 继承颜色、
   * 整段删除后留下空壳），而回写只取 textContent —— 视觉和数据就对不上了。
   * 退出编辑会按最新 Markdown 重渲一次，高亮自然回来。
   * @returns {boolean} 是否真的改动过（决定退出时要不要重渲）
   */
  function flattenCodeBlocks() {
    let touched = false;
    root.querySelectorAll('.md-code pre > code').forEach((c) => {
      if (c.children.length) { c.textContent = c.textContent || ''; touched = true; }
      if (!c.textContent) { c.innerHTML = '<br>'; touched = true; }
    });
    return touched;
  }

  function openLinkBox(anchor) {
    const sel = window.getSelection();
    const selected = sel && root.contains(sel.anchorNode) ? String(sel.toString() || '') : '';
    const anchorNode = sel && sel.anchorNode;
    const anchorEl = anchorNode && (anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement);
    const linkEl = anchorEl && root.contains(anchorEl) ? anchorEl.closest('a[href]') : null;
    showOverlay(anchor, `
      <div class="nt-overlay-title">插入链接</div>
      <input class="nt-overlay-input" type="url" placeholder="https://example.com"
             value="${esc(linkEl ? linkEl.getAttribute('href') || '' : '')}" />
      <div class="nt-overlay-acts">
        ${linkEl ? '<button type="button" class="ghost-btn tiny" data-ov-act="unlink">移除链接</button>' : ''}
        <span class="nt-tb-spacer"></span>
        <button type="button" class="ghost-btn tiny" data-ov-act="cancel">取消</button>
        <button type="button" class="primary-btn tiny" data-ov-act="ok">确定</button>
      </div>`, null);
    const input = overlayEl?.querySelector('.nt-overlay-input');
    overlayEl?.addEventListener('click', (e) => {
      const act = e.target.closest('[data-ov-act]')?.dataset.ovAct;
      if (!act) return;
      if (act === 'cancel') { closeOverlay(); return; }
      if (act === 'unlink') { closeOverlay(); exec('unlink'); return; }
      const url = String(input?.value || '').trim();
      if (!url) { notify('请填写链接地址'); input?.focus(); return; }
      if (!/^(https?:|mailto:|todo-media:|#|\/)/i.test(url)) { notify('链接需以 https:// 等协议开头'); return; }
      closeOverlay();
      focusRoot(true);
      if (!selected.trim()) {
        insertHTML(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`);
      } else {
        exec('createLink', url);
        // createLink 生成的 <a> 补上与渲染态一致的属性
        const a = [...root.querySelectorAll('a[href]')]
          .find((x) => x.getAttribute('href') === url);
        if (a) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); }
      }
    });
    overlayEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); overlayEl.querySelector('[data-ov-act="ok"]')?.click(); }
    });
    input?.focus();
  }

  /**
   * @param {HTMLElement|{getBoundingClientRect:Function}} anchor 浮层贴着谁（也可传一个假的 rect 源）
   * @param {string} html
   * @param {(btn:HTMLElement)=>void} [onItem] data-ov-cmd 按钮回调
   * @param {()=>void} [onClose] 浮层以「点击外部 / Esc」方式关闭时的兜底回调
   */
  function showOverlay(anchor, html, onItem, onClose) {
    closeOverlay();
    saveSelection();
    overlayEl = document.createElement('div');
    overlayEl.className = 'nt-overlay';
    overlayEl.innerHTML = html;
    document.body.appendChild(overlayEl);
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - (overlayEl.offsetWidth || 200) - 8));
    overlayEl.style.left = `${left}px`;
    overlayEl.style.top = `${Math.min(r.bottom + 6, window.innerHeight - (overlayEl.offsetHeight || 160) - 8)}px`;
    if (onItem) {
      overlayEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ov-cmd]');
        if (btn) onItem(btn);
      });
    }
    overlayOnClose = typeof onClose === 'function' ? onClose : null;
    document.addEventListener('mousedown', onOverlayOutside, true);
    document.addEventListener('keydown', onOverlayKey, true);
    overlayKeyBound = true;
  }

  /* ---- 内置取色板（宿主没提供 hooks.palette 时用，例如任务详情描述） ---- */
  let paletteEl = null;
  function closePalette() {
    if (paletteEl) { paletteEl.remove(); paletteEl = null; }
    document.removeEventListener('mousedown', onPaletteOutside, true);
    document.removeEventListener('keydown', onPaletteKey, true);
  }
  function onPaletteOutside(e) {
    if (!paletteEl) return;
    const t = e.target;
    if (!paletteEl.contains(t) && !(t && t.closest && t.closest('.nt-wys-bar'))) closePalette();
  }
  function onPaletteKey(e) {
    if (paletteEl && e.key === 'Escape') { e.stopPropagation(); closePalette(); }
  }
  /**
   * @param {'color'|'bg'} kind
   * @param {HTMLElement} btn 贴哪个按钮（工具条上的 A / H）
   */
  function openPalette(kind, btn) {
    if (paletteEl) { closePalette(); return; }
    const list = kind === 'color' ? TEXT_COLORS : BG_COLORS;
    paletteEl = document.createElement('div');
    paletteEl.className = 'nt-palette';
    paletteEl.innerHTML = `
      <div class="nt-palette-title">${kind === 'color' ? '字体颜色' : '背景高亮'}</div>
      <div class="nt-palette-grid">
        ${list.map((c) => `
          <button type="button" class="nt-swatch" data-color="${esc(c.v)}" title="${esc(c.label)}">
            <i style="background:${esc(c.v)}"></i>
          </button>`).join('')}
      </div>
      <button type="button" class="nt-palette-clear" data-color="">清除${kind === 'color' ? '颜色' : '高亮'}</button>`;
    document.body.appendChild(paletteEl);
    // 贴按钮下方，贴边时向左 / 向上收，避免超出窗口
    const anchor = btn && typeof btn.getBoundingClientRect === 'function' ? btn : root;
    const r = anchor.getBoundingClientRect();
    const width = paletteEl.offsetWidth || 168;
    paletteEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    paletteEl.style.top = `${Math.min(r.bottom + 6, window.innerHeight - (paletteEl.offsetHeight || 140) - 8)}px`;
    paletteEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (!b) return;
      const v = b.dataset.color;
      closePalette();
      applyStyle(kind, v); // 内部 focusRoot(true) 把选区还原回来再上色
    });
    document.addEventListener('mousedown', onPaletteOutside, true);
    document.addEventListener('keydown', onPaletteKey, true);
  }

  const COMMANDS = {
    block: (btn) => openBlockMenu(btn),
    bold: () => exec('bold'),
    italic: () => exec('italic'),
    underline: () => exec('underline'),
    strike: () => exec('strikeThrough'),
    h1: () => formatBlock('h1'),
    h2: () => formatBlock('h2'),
    h3: () => formatBlock('h3'),
    p: () => formatBlock('p'),
    quote: () => formatBlock('blockquote'),
    ul: () => exec('insertUnorderedList'),
    ol: () => exec('insertOrderedList'),
    code: (btn) => openCodeLangBox(btn, 'text', (lang) => insertCodeBlock(lang)),
    table: () => insertHTML(
      '<table><thead><tr><th>列 A</th><th>列 B</th><th>列 C</th></tr></thead>'
      + '<tbody><tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>'
      + '<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br></p>',
    ),
    hr: () => insertHTML('<hr><p><br></p>'),
    link: (btn) => openLinkBox(btn),
    image: () => { if (hooks.pickImage) hooks.pickImage(); },
    undo: () => exec('undo'),
    redo: () => exec('redo'),
    color: (btn) => { saveSelection(); if (hooks.palette) hooks.palette('color'); else openPalette('color', btn); },
    bg: (btn) => { saveSelection(); if (hooks.palette) hooks.palette('bg'); else openPalette('bg', btn); },
    guide: () => { if (hooks.guide) hooks.guide(); },
    done: () => { if (hooks.exitEdit) hooks.exitEdit(); else setEditing(false); },
  };

  /** 供色板调用：给选区上色 / 清色，输出项目自定义的 ==文字=={...} 对应 DOM */
  function applyStyle(kind, color) {
    if (!editing) { notify('请先点「编辑」'); return; }
    focusRoot(true);
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { notify('请选中一段文字再设置颜色'); return; }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) { notify('请选中正文里的文字'); return; }
    if (!color) {
      // 清除：把选区相交的样式包裹层 unwrap（不误伤加粗 / 斜体）
      root.querySelectorAll(kind === 'color' ? 'span.md-color' : 'mark.md-mark').forEach((el) => {
        if (!range.intersectsNode(el)) return;
        const parent = el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        el.remove();
      });
    } else {
      const tag = kind === 'color' ? 'span' : 'mark';
      const wrap = document.createElement(tag);
      wrap.className = kind === 'color' ? 'md-color' : 'md-mark';
      wrap.setAttribute('style', kind === 'color' ? `color:${color}` : `background:${color}`);
      try {
        wrap.appendChild(range.extractContents());
        range.insertNode(wrap);
        sel.removeAllRanges();
        const r2 = document.createRange();
        r2.selectNodeContents(wrap);
        sel.addRange(r2);
      } catch (e) {
        notify('这段文字跨了多个块，请分开设置');
        return;
      }
    }
    saveSelection();
    afterChange();
  }

  /** 供图片上传完成后调用：在光标处插一张与渲染态完全一致的 <img> */
  function insertImage(url, name) {
    if (!editing) { if (hooks.enterEdit) hooks.enterEdit(); }
    insertHTML(`<p><img src="${esc(url)}" alt="${esc(name || '')}" /></p><p><br></p>`);
  }

  /* ---- 两态 ---- */
  function syncMetaReadonly() {
    if (!pane) return;
    const title = pane.querySelector('.nt-dp-title');
    const folder = pane.querySelector('.nt-folder-select');
    const tags = pane.querySelector('.nt-tag-input');
    if (title) title.readOnly = !editing;
    if (folder) folder.disabled = !editing;
    if (tags) tags.readOnly = !editing;
    const btn = pane.querySelector('[data-nt-act="mode"]');
    if (btn) {
      btn.textContent = editing ? '✓ 完成' : '✎ 编辑';
      btn.classList.toggle('is-editing', editing);
      btn.title = editing ? '保存并回到只读展示（Esc）' : '进入编辑（显示工具条，可用快捷键排版）';
    }
  }

  function setEditing(on, force = false) {
    // html 模式（任务描述）常驻编辑态：没有「预览 / 编辑」两态，工具条一直显示
    if (disposed || htmlMode || (!force && editing === !!on)) return;
    editing = !!on;
    root.contentEditable = editing ? 'true' : 'false';
    root.spellcheck = editing;
    root.classList.toggle('is-editing', editing);
    if (toolbar) toolbar.hidden = !editing;
    if (pane) pane.dataset.mode = editing ? 'edit' : 'preview';
    if (editing) {
      // 进编辑：代码块去高亮（见 flattenCodeBlocks 注释）
      if (flattenCodeBlocks()) needRerender = true;
    } else if (dirty || needRerender) {
      // 退出：用序列化结果重渲一次 —— 代码高亮 / Mermaid / 表格样式回到
      // 「打开这篇笔记时」的渲染态，所见即所得才算闭环。
      // 没改动且没摊平过代码块就跳过，切态零成本、DOM 一个字节都不动。
      const md = value();
      needRerender = false;
      setContent(md);
    }
    syncMetaReadonly();
    if (!editing) {
      closeOverlay();
      savedRange = null;
      root.blur?.();
      window.getSelection()?.removeAllRanges?.();
    } else {
      focusRoot();
    }
    syncToolbarState();
    if (o.onEditingChange) o.onEditingChange(editing);
  }

  /* ---- 工具条状态 ---- */
  const STATE_CMDS = {
    bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough',
    ul: 'insertUnorderedList', ol: 'insertOrderedList',
  };
  function syncToolbarState() {
    if (!toolbar || !editing) return;
    toolbar.querySelectorAll('[data-nt-cmd]').forEach((b) => {
      const cmd = STATE_CMDS[b.dataset.ntCmd];
      if (!cmd) return;
      let on = false;
      try { on = document.queryCommandState(cmd); } catch (e) { /* 忽略 */ }
      b.classList.toggle('active', !!on);
    });
    const label = toolbar.querySelector('.nt-tb-block');
    if (label) {
      const sel = window.getSelection();
      let node = sel && sel.anchorNode;
      node = node && node.nodeType === 1 ? node : node && node.parentElement;
      const head = node && root.contains(node) ? node.closest('h1,h2,h3,blockquote') : null;
      const names = { H1: '标题 1', H2: '标题 2', H3: '标题 3', BLOCKQUOTE: '引用' };
      label.innerHTML = `${head ? names[head.tagName] || '正文' : '正文'} <span class="nt-tb-caret">▾</span>`;
    }
  }
  function onSelectionChange() {
    if (editing && root.contains(document.activeElement)) { saveSelection(); syncToolbarState(); }
  }

  /* ---- 事件 ---- */
  function onToolbarClick(e) {
    const btn = e.target.closest('[data-nt-cmd]');
    if (!btn || !toolbar.contains(btn)) return;
    e.preventDefault();
    if (!editing) return;
    const fn = COMMANDS[btn.dataset.ntCmd];
    if (fn) fn(btn);
  }
  function onToolbarMouseDown(e) {
    // 按钮抢焦点会让正文选区消失：先存 range，再阻止默认聚焦。
    // 但不要让工具条整体无法点（浮层输入框还要能聚焦），只拦 button。
    if (e.target.closest('button')) { saveSelection(); e.preventDefault(); }
  }

  function onRootInput(e) {
    if (!editing) { e.preventDefault(); return; }
    dirty = true;
    markDirtyAround([e.target]);
    syncToolbarState();
    if (o.onInput) o.onInput();
  }

  /** 只读态的硬拦截：contenteditable=false 之外再堵住所有可能的写入路径 */
  function onGuard(e) {
    if (editing || !root.contains(e.target) && e.target !== root) return;
    const type = e.type;
    if (type === 'beforeinput' || type === 'paste' || type === 'cut' || type === 'drop' || type === 'input') {
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (type === 'keydown') {
      const k = e.key;
      const mod = e.ctrlKey || e.metaKey;
      const modify = k === 'Backspace' || k === 'Delete' || k === 'Enter' || k === 'Tab'
        || (k.length === 1 && !mod && !e.altKey)
        || (mod && /^[vxbz]$/i.test(k));
      if (modify) { e.preventDefault(); e.stopPropagation(); }
    }
  }

  /**
   * 纯文本按行落成段落。粘贴的默认行为（也是「保持原文」分支）：
   * 外部 HTML 一律不进来（脚本 / 内联样式 / 未知标签），Markdown 标记保持肉眼可见。
   */
  function insertPlainText(text) {
    const paras = String(text).split(/\r?\n/).map((line) => `<p>${esc(line) || '<br>'}</p>`).join('');
    insertHTML(paras);
  }

  /** 把粘贴进来的 Markdown 渲染成富文本再插入（Markdown → HTML 走渲染器，和笔记展示同一份逻辑） */
  function insertMarkdownText(text) {
    insertHTML(renderSafeMarkdown(String(text)));
  }

  /**
   * 粘贴内容像 Markdown 时先问一句，而不是默默按纯文本落进去
   * （用户从文档 / 对话窗口复制过来的 Markdown，多半希望看到排版后的效果）。
   *
   * 兜底很关键：浮层被 Esc / 点外部关掉时按「保持原文」处理 —— 绝不能出现
   * 「弹了一下提示，剪贴板内容却丢了」这种情况。
   */
  function askMarkdownConvert(text) {
    let settled = false;
    const rect = (() => {
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const r = sel.getRangeAt(0).getBoundingClientRect();
          if (r && (r.width || r.height || r.top)) return r;
        }
      } catch (e) { /* 取不到光标位置就退化到正文左上角 */ }
      return root.getBoundingClientRect();
    })();
    const finish = (convert) => {
      if (settled) return;
      settled = true;
      closeOverlay();
      focusRoot(true);
      if (convert) insertMarkdownText(text); else insertPlainText(text);
    };
    showOverlay(
      { getBoundingClientRect: () => rect },
      `<div class="nt-overlay-title">检测到 Markdown 语法</div>
       <div class="nt-overlay-desc">粘贴的内容像是 Markdown，要转换成富文本吗？</div>
       <div class="nt-overlay-acts">
         <button type="button" class="ghost-btn tiny" data-ov-act="raw">保持原文</button>
         <span class="nt-tb-spacer"></span>
         <button type="button" class="primary-btn tiny" data-ov-act="md">转换</button>
       </div>`,
      null,
      () => finish(false),
    );
    overlayEl?.addEventListener('click', (e) => {
      const act = e.target.closest('[data-ov-act]')?.dataset.ovAct;
      if (act === 'md') finish(true);
      else if (act === 'raw') finish(false);
    });
  }

  function onPaste(e) {
    if (!editing) return;
    const files = [...((e.clipboardData && e.clipboardData.files) || [])]
      .filter((f) => /^image\//i.test(f.type || ''));
    if (files.length) {
      e.preventDefault();
      if (hooks.pasteImage) hooks.pasteImage(files);
      return;
    }
    // 只保留纯文本：避免把外部 HTML（含脚本 / 内联样式 / 未知标签）粘进正文，
    // 也保证不会把 Markdown 标记当成可见内容暴露出来。
    const plain = e.clipboardData && e.clipboardData.getData('text/plain');
    if (plain == null) return;
    e.preventDefault();
    if (looksLikeMarkdown(plain)) { askMarkdownConvert(String(plain)); return; }
    insertPlainText(String(plain));
  }

  function onDrop(e) {
    if (!editing) return;
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])]
      .filter((f) => /^image\//i.test(f.type || ''));
    if (!files.length) return;
    e.preventDefault();
    if (hooks.pasteImage) hooks.pasteImage(files);
  }

  function onKeydown(e) {
    if (!editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = String(e.key || '').toLowerCase();
    // html 模式没有「退出编辑」这种状态：Esc 必须继续冒泡给抽屉（关面板），不能吞掉
    if (!htmlMode && k === 'escape' && !overlayEl && (!hooks.canExit || hooks.canExit())) {
      e.preventDefault(); e.stopPropagation();
      if (hooks.exitEdit) hooks.exitEdit(); else setEditing(false);
      return;
    }
    if (!mod) return;
    let cmd = null;
    if (e.altKey && /^[0-3]$/.test(e.key)) {
      cmd = { 0: 'p', 1: 'h1', 2: 'h2', 3: 'h3' }[e.key];
    } else if (e.altKey && k === 'c') cmd = 'code';
    else if (e.shiftKey && e.key === '7') cmd = 'ol';
    else if (e.shiftKey && e.key === '8') cmd = 'ul';
    else if (e.shiftKey && k === 'x') cmd = 'strike';
    // Ctrl+Shift+Z = 重做。必须单独判一次：写在下面的 !e.shiftKey 分支里永远走不到
    // （那里 e.shiftKey 已经为假），快捷键会在帮助面板里写着却不生效。
    else if (e.shiftKey && k === 'z') cmd = 'redo';
    else if (!e.altKey && !e.shiftKey) {
      cmd = { b: 'bold', i: 'italic', u: 'underline', k: 'link' }[k];
    }
    if (!cmd) return;
    e.preventDefault(); e.stopPropagation();
    if (cmd === 'link') COMMANDS.link(toolbar?.querySelector('[data-nt-cmd="link"]') || root);
    else if (COMMANDS[cmd]) COMMANDS[cmd]();
  }

  /**
   * 编辑态点代码块左上角的语言标签 → 就地换语言（只读态不可点，也不给指针样式）。
   * 标签在 `.md-code-bar[contenteditable=false]` 里，正常点击会把选区甩到代码块边上，
   * 所以 mousedown 阶段先拦掉默认聚焦，click 里再开浮层。
   */
  function onRootMouseDown(e) {
    if (editing && e.target.closest?.('.md-code-lang')) e.preventDefault();
  }
  function onRootClick(e) {
    if (!editing) return;
    const label = e.target.closest?.('.md-code-lang');
    if (!label || !root.contains(label)) return;
    e.preventDefault();
    e.stopPropagation();
    const shell = label.closest('.md-code');
    if (!shell) return;
    const cur = String(label.textContent || '').trim().toLowerCase();
    openCodeLangBox(label, cur, (lang) => setBlockLang(shell, lang));
  }

  const GUARD_EVENTS = ['beforeinput', 'paste', 'cut', 'drop', 'input', 'keydown'];
  root.addEventListener('input', onRootInput);
  root.addEventListener('paste', onPaste);
  root.addEventListener('drop', onDrop);
  root.addEventListener('keydown', onKeydown, true);
  root.addEventListener('mousedown', onRootMouseDown, true);
  root.addEventListener('click', onRootClick);
  GUARD_EVENTS.forEach((t) => root.addEventListener(t, onGuard, true));
  toolbar?.addEventListener('click', onToolbarClick);
  toolbar?.addEventListener('mousedown', onToolbarMouseDown);
  document.addEventListener('selectionchange', onSelectionChange);

  // 兼容旧调用点（notes.js 里读 editor.codemirror 的地方一律拿到 null）
  const api = {
    value,
    setContent,
    setEditing,
    isEditing: () => editing,
    focus: () => { if (editing) focusRoot(); },
    exec: (cmd, val) => { const fn = COMMANDS[cmd]; if (fn) fn(toolbar?.querySelector(`[data-nt-cmd="${cmd}"]`) || root); else if (val != null) exec(cmd, val); },
    applyStyle,
    insertImage,
    syncToolbarState,
    codemirror: null,
    toTextArea() {},
    dispose() {
      disposed = true;
      closeOverlay(true); // 销毁时不再触发「保持原文」兜底，正文 DOM 可能已被宿主丢弃
      closePalette();
      root.removeEventListener('input', onRootInput);
      root.removeEventListener('paste', onPaste);
      root.removeEventListener('drop', onDrop);
      root.removeEventListener('keydown', onKeydown, true);
      root.removeEventListener('mousedown', onRootMouseDown, true);
      root.removeEventListener('click', onRootClick);
      GUARD_EVENTS.forEach((t) => root.removeEventListener(t, onGuard, true));
      toolbar?.removeEventListener('click', onToolbarClick);
      toolbar?.removeEventListener('mousedown', onToolbarMouseDown);
      document.removeEventListener('selectionchange', onSelectionChange);
    },
  };
  if (htmlMode) {
    // 任务描述是常驻编辑态：没有「预览 ↔ 编辑」切换，工具条一进来就显示，
    // 也不抢焦点（抽屉刚打开时焦点应该留给标题 / 面板本身）。
    editing = true;
    root.contentEditable = 'true';
    root.spellcheck = true;
    root.classList.add('is-editing');
    if (toolbar) toolbar.hidden = false;
    syncToolbarState();
  }
  syncMetaReadonly();
  return api;
}
