'use strict';
/**
 * 笔记正文的「查找 / 替换」浮条（Ctrl+F / Ctrl+H）。
 *
 * 同一根浮条服务两种正文载体（由调用方通过 backend 指定）：
 * - `cm`：编辑 / 分栏态的 CodeMirror 源码。匹配交给 CodeMirror 自带的 getSearchCursor ——
 *   EasyMDE 的 dist 里已经打包了 `codemirror/addon/search/searchcursor`（见 index.html 与
 *   package.json 的来源登记），大小写折叠、跨区块（代码块 / 表格行）匹配这些细节由它兜底；
 * - `dom`：预览（只读）态的渲染结果。正文已经是 HTML，没有「源码位置」可标，直接在
 *   `#nt-preview` 的文本节点里找、再用 `<mark class="nt-find-hit">` 包住命中处。
 *   预览态没有可写的源码，因此浮条自动收起「替换」入口（替换会跳回分栏，见 notes.js）。
 * 两种后端的浮条外观、计数、上下跳转、区分大小写、Esc 关闭完全一致，切换模式时查询词接着用。
 *
 * 没有直接套官方 addon/search 的对话式面板，与「色板 / 时间筛选 / 预览面板」是同一个取舍：
 * 官方面板是「两级弹窗 + 内置英文文案」的流程式交互（Replace 要点两次弹窗再 Yes/No/All），
 * 放进窗口内的受限面板里体验并不好；自己实现还能顺手补齐「N/M 计数」「上一个 / 下一个」
 * 「区分大小写」这些用户在这个界面里真正会找的东西。
 *
 * 模块是单例：同一时刻只有一条浮条、只服务一个宿主面板（右栏与弹窗共用 notes.js 的
 * editor 单例，本来也不会两处同时开）。浮条节点每次打开都重建，因此事件直接挂在它身上，
 * 不存在重复绑定的问题。
 */

/* ---------------- 运行时状态 ---------------- */

let bar = null;        // 浮条 DOM
let host = null;       // 宿主面板（.nt-dp）
let cm = null;         // CodeMirror 实例（backend === 'cm'）
let root = null;       // 预览容器 #nt-preview（backend === 'dom'）
let backend = 'cm';    // 'cm' 源码 | 'dom' 预览渲染结果
let onChange = () => {}; // 内容被改动后回调（保存 + 刷新预览）
let caseSensitive = false;
let matches = [];      // 源码态命中：[{ from:{line,ch}, to:{line,ch} }]
let domHits = [];      // 预览态命中：对应的 <mark> 元素，数组顺序 = 文档顺序
let index = -1;        // 当前命中在 matches / domHits 里的下标
let marks = [];        // TextMarker 列表（源码态）
let docTimer = null;   // 外部改动后重算位置的防抖

/** 浮条是否开着 */
export function isFindOpen() {
  return !!(bar && bar.isConnected);
}

/** 浮条里的查询词（切换模式后接着用；没开则空串） */
export function findQuery() {
  return bar ? (bar.querySelector('.nt-find-input')?.value || '') : '';
}

/**
 * 打开（或复用）查找浮条。
 *
 * @param {object} cfg
 * @param {HTMLElement} cfg.pane 宿主面板（浮条插在它的滚动区上方）
 * @param {() => object|null} [cfg.getCm] 取当前 CodeMirror 实例（源码态）
 * @param {() => HTMLElement|null} [cfg.getRoot] 取预览容器（预览态）
 * @param {'cm'|'dom'} [cfg.backend] 检索哪种正文；缺省按 getCm → getRoot 推断
 * @param {boolean} [cfg.replace] 是否同时展开「替换」行（仅源码态）
 * @param {string} [cfg.seed] 预填的查找词（一般是选区 / 切换模式前的查询词）
 * @param {() => void} [cfg.onChange] 正文被替换后的回调
 * @returns {boolean} 是否成功打开
 */
export function openFindBar(cfg = {}) {
  const nextCm = (cfg.getCm && cfg.getCm()) || null;
  const nextRoot = (cfg.getRoot && cfg.getRoot()) || null;
  const nextHost = cfg.pane || null;
  const nextBackend = cfg.backend === 'dom' ? 'dom' : (cfg.backend === 'cm' ? 'cm' : (nextCm ? 'cm' : 'dom'));
  if (!nextHost) return false;
  if (nextBackend === 'dom' ? !nextRoot : !nextCm) return false;
  if (cfg.onChange) onChange = cfg.onChange;

  // 同一面板 && 同一后端的同一目标：不重建，只补开替换行 / 抢焦点（连按 Ctrl+F 应当是即时响应）
  if (isFindOpen() && host === nextHost && backend === nextBackend
      && cm === (nextBackend === 'cm' ? nextCm : null)
      && root === (nextBackend === 'dom' ? nextRoot : null)) {
    setReplaceVisible(cfg.replace || isReplaceVisible());
    focusField(cfg.replace && nextBackend === 'cm' ? 'replace' : 'find');
    return true;
  }

  closeFindBar({ keepFocus: true });
  backend = nextBackend;
  cm = nextBackend === 'cm' ? nextCm : null;
  root = nextBackend === 'dom' ? nextRoot : null;
  host = nextHost;
  bar = buildBar({ replace: nextBackend === 'cm' });
  // 插在中段滚动区之前：预览 / 分栏怎么切，浮条都固定在正文上方，不会跟着某一栏走
  const anchor = nextHost.querySelector('.nt-dp-scroll');
  if (anchor) nextHost.insertBefore(bar, anchor);
  else nextHost.appendChild(bar);
  bindBarEvents();
  if (backend === 'cm') {
    try { cm.on('change', scheduleDocRefresh); } catch (e) { /* 编辑器不支持事件（理论上不会） */ }
  }

  const input = bar.querySelector('.nt-find-input');
  if (cfg.replace && backend === 'cm') setReplaceVisible(true);
  if (cfg.seed) { input.value = String(cfg.seed); runFind({ jump: true }); }
  else if (input.value) runFind({ jump: false });
  // 替换模式直接把光标送进「替换为」，少点一次（Ctrl+H 的意图就是替换）
  focusField(cfg.replace && backend === 'cm' ? 'replace' : 'find');
  return true;
}

/**
 * 关闭浮条并清理标记。
 * @param {{keepFocus?:boolean}} [o] keepFocus=true 时不把焦点还给编辑器（马上要重建浮条）
 */
export function closeFindBar(o = {}) {
  clearTimeout(docTimer);
  docTimer = null;
  clearTimeout(flashTimer);
  flashText = '';
  clearMarks();
  clearDomHits();
  if (cm) {
    try { cm.off('change', scheduleDocRefresh); } catch (e) { /* 已销毁 */ }
  }
  if (bar && bar.parentNode) bar.remove();
  bar = null;
  const oldCm = cm;
  const oldHost = host;
  const wasDom = backend === 'dom';
  cm = null;
  root = null;
  backend = 'cm';
  matches = [];
  domHits = [];
  index = -1;
  host = null;
  if (!o.keepFocus) {
    if (oldCm) {
      // Esc / 点关闭：焦点回到正文，继续打字（而不是留在已经消失的输入框上）
      try { oldCm.focus(); } catch (e) { /* 编辑器已销毁 */ }
    } else if (wasDom && oldHost) {
      // 预览态没有编辑器：焦点落到预览滚动区（tabindex="-1"），下一个 Ctrl+F 才接得上
      const scroll = oldHost.querySelector('.nt-dp-scroll');
      if (scroll && scroll.focus) {
        try { scroll.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
      }
    }
  }
}

/**
 * 正文被外部重渲（切模式 / 预览重新渲染 / 自动保存后的刷新）后调用：
 * 浮条开着就按当前查询词就地重算命中，不抢焦点、不打断输入。
 */
export function refreshFind() {
  if (!isFindOpen()) return;
  runFind({ jump: false, keepIndex: true });
}

/* ---------------- 浮条 DOM ---------------- */

function buildBar(opts = {}) {
  // 预览态没有可写的源码：替换入口整块不渲染（留下灰按钮比没有按钮更让人困惑）
  const canReplace = opts.replace !== false;
  const el = document.createElement('div');
  el.className = 'nt-find';
  el.id = 'nt-find-bar';
  // 约定：面板里的 Esc 先归浮条（关搜索），别一按就关掉整个弹窗 ——
  // modal.js 的 Esc 处理器在 document 捕获阶段，早于宿主面板的委托，只能靠这个标记让位
  el.dataset.escStop = '1';
  el.innerHTML = `
    <div class="nt-find-row">
      <input class="nt-find-input" type="text" placeholder="${canReplace ? '查找正文…' : '在预览中查找…'}" spellcheck="false" autocomplete="off" />
      <span class="nt-find-count" data-f="count">—</span>
      <button type="button" class="mini-btn" data-f="prev" title="上一个匹配 (Shift+Enter / Shift+F3)">↑</button>
      <button type="button" class="mini-btn" data-f="next" title="下一个匹配 (Enter / F3)">↓</button>
      <button type="button" class="mini-btn nt-find-toggle" data-f="case" title="区分大小写" aria-pressed="false">Aa</button>
      ${canReplace ? '<button type="button" class="mini-btn nt-find-toggle" data-f="replace-toggle" title="替换 (Ctrl+H)" aria-pressed="false">⇄</button>' : ''}
      <button type="button" class="mini-btn" data-f="close" title="关闭 (Esc)">✕</button>
    </div>
    ${canReplace ? `<div class="nt-find-row nt-find-replace">
      <input class="nt-find-replace-input" type="text" placeholder="替换为…" spellcheck="false" autocomplete="off" />
      <button type="button" class="ghost-btn tiny" data-f="replace">替换</button>
      <button type="button" class="ghost-btn tiny" data-f="replace-all">全部替换</button>
    </div>` : ''}`;
  return el;
}

function setReplaceVisible(on) {
  if (!bar) return;
  bar.classList.toggle('is-replace', !!on);
  const toggle = bar.querySelector('[data-f="replace-toggle"]');
  if (toggle) {
    toggle.classList.toggle('active', !!on);
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function isReplaceVisible() {
  return !!(bar && bar.classList.contains('is-replace'));
}

function setCaseSensitive(on) {
  caseSensitive = !!on;
  if (!bar) return;
  const toggle = bar.querySelector('[data-f="case"]');
  if (toggle) {
    toggle.classList.toggle('active', caseSensitive);
    toggle.setAttribute('aria-pressed', caseSensitive ? 'true' : 'false');
  }
}

function focusField(which) {
  if (!bar) return;
  const el = bar.querySelector(which === 'replace' ? '.nt-find-replace-input' : '.nt-find-input');
  if (!el) return;
  el.focus();
  el.select();
}

/* ---------------- 浮条事件 ---------------- */

function bindBarEvents() {
  const findInput = bar.querySelector('.nt-find-input');
  // 预览态没有替换行（buildBar 就没渲染），这里必须容忍它缺席
  const replaceInput = bar.querySelector('.nt-find-replace-input');

  // 边打边找：每敲一个字都重算命中并把光标移到「光标之后的第一个」，
  // 连续输入时这个词只会越收越窄，观感就是原地成长起来的高亮
  findInput.addEventListener('input', () => runFind({ jump: true }));
  // 替换框随便输入，不要连带触发查找
  if (replaceInput) replaceInput.addEventListener('input', () => {});

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-f]');
    if (!btn) return;
    switch (btn.dataset.f) {
      case 'prev': step(-1); break;
      case 'next': step(1); break;
      case 'case': setCaseSensitive(!caseSensitive); runFind({ jump: true }); break;
      case 'replace-toggle': {
        const on = !isReplaceVisible();
        setReplaceVisible(on);
        focusField(on ? 'replace' : 'find');
        break;
      }
      case 'replace': doReplaceOne(); break;
      case 'replace-all': doReplaceAll(); break;
      case 'close': closeFindBar(); break;
      default: break;
    }
  });

  bar.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      step(e.shiftKey ? -1 : 1);
      return;
    }
    if (k === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFindBar();
      return;
    }
    if (k === 'F3') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
      return;
    }
    // Ctrl+H：即便焦点在查找框里也要能直接展开替换行（宿主 notes.js 也绑了同一个组合键，
    // 但那里会尝试重建浮条，这里拦下来自己处理更顺手）；预览态没有替换行，直接放过去
    if ((e.ctrlKey || e.metaKey) && (k === 'h' || k === 'H') && backend === 'cm') {
      e.preventDefault();
      e.stopPropagation();
      setReplaceVisible(true);
      focusField('replace');
    }
  });
}

/* ---------------- 匹配与高亮 ---------------- */

/** 位置比较：先比行、再比列 */
function cmp(a, b) {
  if (a.line !== b.line) return a.line < b.line ? -1 : 1;
  return a.ch === b.ch ? 0 : (a.ch < b.ch ? -1 : 1);
}

function posOf(p) {
  return { line: p.line, ch: p.ch };
}

/**
 * 用 CodeMirror 的 searchcursor 收集全部命中：
 * 纯字符串查询时的大小写折叠（caseFold）与跨区块匹配都由它负责，这里不重复实现。
 */
function collectMatches(q) {
  matches = [];
  if (!q) return;
  try {
    const cursor = cm.getSearchCursor(q, { line: 0, ch: 0 }, { caseFold: !caseSensitive, multiline: true });
    while (cursor.findNext()) {
      matches.push({ from: posOf(cursor.from()), to: posOf(cursor.to()) });
    }
  } catch (e) {
    console.warn('[note-find] 检索失败', e && e.message);
    matches = [];
  }
}

function clearMarks() {
  for (const m of marks) {
    try { m.clear(); } catch (e) { /* 标记已随文本消失 */ }
  }
  marks = [];
}

function applyMarks() {
  clearMarks();
  try {
    matches.forEach((m, i) => {
      marks.push(cm.markText(m.from, m.to, {
        className: i === index ? 'cm-find-hit cm-find-current' : 'cm-find-hit',
      }));
    });
  } catch (e) {
    // 某一段已被删掉（并发改动）：清干净即可，下一轮 onChange 会重算
    marks = [];
  }
}

/** 命中总数（两种后端统一口径，计数 / 上下跳转都读它） */
function hitCount() {
  return backend === 'dom' ? domHits.length : matches.length;
}

/* ---------------- 预览态检索（DOM 后端） ---------------- */

/**
 * 收集预览正文里的命中，并就地包上 <mark>。
 *
 * 只在一个文本节点内部找、并用 Range.surroundContents 包裹：
 * 跨节点的命中（比如关键词被 **加粗** 切成两半）在这里不拼，宁可少算一个也不去改
 * 已经渲染好的标签结构 —— 拆 <strong> / <code> 出来的高亮会把原文语义搞乱。
 */
function collectDomMatches(q) {
  domHits = [];
  if (!root || !q) return;
  const needle = caseSensitive ? q : q.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      // 图表 / 样式 / 脚本里没有「正文」，SVG 里插 HTML 的 <mark> 还会把图形弄坏；
      // 空态提示（.nt-preview-empty）是界面文案，不该被当成正文命中
      if (p.closest('svg, style, script, textarea, .nt-find-hit, .nt-preview-empty')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n = walker.nextNode();
  while (n) { nodes.push(n); n = walker.nextNode(); }

  const spans = [];
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const hay = caseSensitive ? text : text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      spans.push({ node, start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  if (!spans.length) return;

  // 倒序包裹：先动靠后的命中，同一文本节点里靠前的偏移量才不会被前一次拆分打乱
  const made = [];
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const s = spans[i];
    const mark = document.createElement('mark');
    mark.className = 'nt-find-hit';
    try {
      const r = document.createRange();
      r.setStart(s.node, s.start);
      r.setEnd(s.node, s.end);
      r.surroundContents(mark);
      made.push(mark);
    } catch (e) { /* 节点已被别处改写：跳过这一个 */ }
  }
  made.reverse(); // 处理时是倒序，还原成文档顺序
  domHits = made;
}

/** 拆掉预览里的命中标记（文本原样保留），下次检索重新包 */
function clearDomHits() {
  if (!domHits.length) return;
  const parents = new Set();
  for (const el of domHits) {
    const parent = el.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(el.textContent || ''), el);
    parents.add(parent);
  }
  domHits = [];
  // 还原被拆碎的相邻文本节点，避免反复检索后节点越切越碎
  parents.forEach((p) => { try { p.normalize(); } catch (e) { /* 已脱离文档 */ } });
}

/** 高亮「当前命中」：其余命中保持淡黄 */
function paintCurrent() {
  domHits.forEach((el, i) => el.classList.toggle('is-current', i === index));
}

/** 当前视口里的第一个命中（对应源码态「从光标处往后找」的直觉） */
function firstVisibleHit() {
  if (!domHits.length) return 0;
  const scroller = host ? host.querySelector('.nt-dp-scroll') : null;
  if (!scroller) return 0;
  const top = scroller.getBoundingClientRect().top;
  for (let i = 0; i < domHits.length; i += 1) {
    if (domHits[i].getBoundingClientRect().top >= top - 4) return i;
  }
  return 0;
}

/** 把当前命中滚到可视区中间（滚动容器是 .nt-dp-scroll，scrollIntoView 只会滚它） */
function scrollToCurrent() {
  const el = domHits[index];
  if (!el || typeof el.scrollIntoView !== 'function') return;
  try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {
    try { el.scrollIntoView(); } catch (e2) { /* 已脱离文档 */ }
  }
}

/**
 * 预览态的「跑一次查找」。
 * @param {{jump?:boolean, keepIndex?:boolean}} [o] keepIndex 用于重渲后原地续上，不从第一个重来
 */
function runFindDom(o = {}) {
  const q = bar.querySelector('.nt-find-input').value || '';
  const prev = index;
  clearDomHits();
  setNoMatch(false);
  collectDomMatches(q);
  if (!domHits.length) {
    index = -1;
    renderCount();
    setNoMatch(!!q);
    return;
  }
  if (o.keepIndex && prev >= 0) index = Math.min(prev, domHits.length - 1);
  else index = firstVisibleHit();
  paintCurrent();
  renderCount();
  if (o.jump !== false) scrollToCurrent();
}

/** 光标所在的那个命中的下标；没有就从第一个起 */
function firstAfterCursor() {
  if (!matches.length) return -1;
  let cur;
  try { cur = cm.getCursor('from'); } catch (e) { return 0; }
  for (let i = 0; i < matches.length; i += 1) {
    if (cmp(matches[i].from, cur) >= 0) return i;
  }
  return 0;
}

function selectMatch(i) {
  const m = matches[i];
  if (!m) return;
  try {
    cm.setSelection(m.from, m.to);
    cm.scrollIntoView({ from: m.from, to: m.to }, 40);
  } catch (e) { /* 编辑器已销毁 */ }
}

function renderCount() {
  if (!bar) return;
  const el = bar.querySelector('[data-f="count"]');
  if (!el) return;
  // 提示优先（"已替换 2 处"）：替换会触发 CodeMirror 的 change → 260ms 后重算，
  // 不留这段时间的话提示会瞬间被 "无结果" 顶掉，像没发生过一样
  if (flashText && Date.now() - flashAt < 1800) {
    el.textContent = flashText;
    el.classList.remove('is-none');
    return;
  }
  flashText = '';
  const total = hitCount();
  if (!total) {
    el.textContent = bar.querySelector('.nt-find-input').value ? '无结果' : '—';
    el.classList.toggle('is-none', !!bar.querySelector('.nt-find-input').value);
    return;
  }
  el.textContent = `${index + 1}/${total}`;
  el.classList.remove('is-none');
}

function setNoMatch(on) {
  if (!bar) return;
  const input = bar.querySelector('.nt-find-input');
  if (input) input.classList.toggle('is-none', !!on);
}

/**
 * 跑一次查找。
 * @param {{jump?:boolean, anchor?:object, keepIndex?:boolean}} [o] anchor 用于替换后定位（默认从光标处起）；
 *        keepIndex 用于正文重渲后原地续上当前项（预览态）
 */
function runFind(o = {}) {
  if (!bar) return;
  if (backend === 'dom') { runFindDom(o); return; }
  if (!cm) return;
  const q = bar.querySelector('.nt-find-input').value || '';
  collectMatches(q);
  setNoMatch(false);
  if (!matches.length) {
    index = -1;
    clearMarks();
    renderCount();
    setNoMatch(!!q);
    return;
  }
  if (o.anchor) {
    // 停在锚点之后的第一个命中：替换当前项后不会跳回文档开头
    index = -1;
    for (let i = 0; i < matches.length; i += 1) {
      if (cmp(matches[i].from, o.anchor) >= 0) { index = i; break; }
    }
    if (index < 0) index = 0;
  } else {
    index = firstAfterCursor();
  }
  applyMarks();
  if (o.jump !== false || o.anchor) selectMatch(index);
  renderCount();
}

/** 上一个 / 下一个（到头再绕回来，不留「到底了」的死路） */
function step(delta) {
  const total = hitCount();
  if (!total) return;
  index = (index + delta + total) % total;
  if (backend === 'dom') {
    paintCurrent();
    scrollToCurrent();
    renderCount();
    return;
  }
  applyMarks();
  selectMatch(index);
  renderCount();
}

/** 正文被外部改动（自动保存、粘贴、撤销）后，位置可能失效 —— 重算一遍 */
function scheduleDocRefresh() {
  clearTimeout(docTimer);
  docTimer = setTimeout(() => {
    docTimer = null;
    if (bar && bar.isConnected) runFind({ jump: false });
  }, 260);
}

/* ---------------- 替换 ---------------- */

function doReplaceOne() {
  if (backend !== 'cm' || !cm) return; // 预览态没有可写的源码
  if (!matches.length) { notifyResult('没有匹配项'); return; }
  const text = bar ? bar.querySelector('.nt-find-replace-input').value : '';
  const i = index >= 0 ? index : 0;
  const target = matches[i];
  if (!target) return;
  const anchor = { ...target.from };
  clearMarks();
  try {
    cm.replaceRange(text, target.from, target.to);
  } catch (e) {
    notifyResult('替换失败，请重试');
    return;
  }
  onChange();
  runFind({ anchor });
  selectMatch(index);
  renderCount();
  notifyResult('已替换 1 处');
}

function doReplaceAll() {
  if (backend !== 'cm' || !cm) return; // 预览态没有可写的源码
  if (!matches.length) { notifyResult('没有匹配项'); return; }
  const text = bar ? bar.querySelector('.nt-find-replace-input').value : '';
  const list = matches.slice();
  clearMarks();
  try {
    cm.operation(() => {
      // 倒序替换：先改后面的，前面的 {line,ch} 才不会因为前面的文本变了而错位
      for (let i = list.length - 1; i >= 0; i -= 1) {
        cm.replaceRange(text, list[i].from, list[i].to);
      }
    });
  } catch (e) {
    notifyResult('替换失败，请重试');
    return;
  }
  onChange();
  runFind({ jump: false });
  notifyResult(`已替换 ${list.length} 处`);
}

/** 结果提示就地显示在计数位（比 toast 轻，也不打断输入节奏） */
let flashText = '';
let flashAt = 0;
let flashTimer = null;
function notifyResult(msg) {
  flashText = msg;
  flashAt = Date.now();
  renderCount();
  clearTimeout(flashTimer);
  // 到期后再渲染一次，把计数位还原成真正的 N/M
  flashTimer = setTimeout(() => { if (bar && bar.isConnected) renderCount(); }, 1900);
}
