'use strict';
/**
 * 笔记正文的「查找 / 替换」浮条（Ctrl+F / Ctrl+H）。
 *
 * 匹配本身交给 CodeMirror 自带的 getSearchCursor —— EasyMDE 的 dist 里已经打包了
 * `codemirror/addon/search/searchcursor`（见 index.html 与 package.json 的来源登记），
 * 大小写折叠、跨区块（代码块 / 表格行）匹配这些细节由它兜底；这里只画一条贴合界面语言的浮条。
 *
 * 没有直接套官方 addon/search 的对话式面板，与「色板 / 时间筛选 / 预览面板」是同一个取舍：
 * 官方面板是「两级弹窗 + 内置英文文案」的流程式交互（Replace 要点两次弹窗再 Yes/No/All），
 * 放进窗口内的受限面板里体验并不好；自己实现还能顺手补齐「N/M 计数」「上一个 / 下一个」
 * 「区分大小写」这些用户在这个界面里真正会找的东西。
 *
 * 模块是单例：同一时刻只有一条浮条、只服务一个 CodeMirror 实例（右栏与弹窗共用 notes.js
 * 的 editor 单例，本来也不会两处同时开）。浮条节点每次打开都重建，因此事件直接挂在它身上，
 * 不存在重复绑定的问题。
 */

/* ---------------- 运行时状态 ---------------- */

let bar = null;        // 浮条 DOM
let host = null;       // 宿主面板（.nt-dp）
let cm = null;         // CodeMirror 实例
let onChange = () => {}; // 内容被改动后回调（保存 + 刷新预览）
let caseSensitive = false;
let matches = [];      // [{ from:{line,ch}, to:{line,ch} }]
let index = -1;        // 当前命中在 matches 里的下标
let marks = [];        // TextMarker 列表
let docTimer = null;   // 外部改动后重算位置的防抖

/** 浮条是否开着 */
export function isFindOpen() {
  return !!(bar && bar.isConnected);
}

/**
 * 打开（或复用）查找浮条。
 *
 * @param {object} cfg
 * @param {HTMLElement} cfg.pane 宿主面板（浮条插在它的滚动区上方）
 * @param {() => object|null} cfg.getCm 取当前 CodeMirror 实例（编辑器可能还没挂好）
 * @param {boolean} [cfg.replace] 是否同时展开「替换」行
 * @param {string} [cfg.seed] 预填的查找词（一般是编辑器里的选区）
 * @param {() => void} [cfg.onChange] 正文被替换后的回调
 * @returns {boolean} 是否成功打开
 */
export function openFindBar(cfg = {}) {
  const nextCm = (cfg.getCm && cfg.getCm()) || null;
  const nextHost = cfg.pane || null;
  if (!nextCm || !nextHost) return false;
  if (cfg.onChange) onChange = cfg.onChange;

  // 同一面板 && 同一编辑器：不重建，只补开替换行 / 抢焦点（连按 Ctrl+F 应当是即时响应）
  if (isFindOpen() && host === nextHost && cm === nextCm) {
    setReplaceVisible(cfg.replace || isReplaceVisible());
    focusField(cfg.replace ? 'replace' : 'find');
    return true;
  }

  closeFindBar({ keepFocus: true });
  cm = nextCm;
  host = nextHost;
  bar = buildBar();
  // 插在中段滚动区之前：预览 / 分栏怎么切，浮条都固定在正文上方，不会跟着某一栏走
  const anchor = nextHost.querySelector('.nt-dp-scroll');
  if (anchor) nextHost.insertBefore(bar, anchor);
  else nextHost.appendChild(bar);
  bindBarEvents();
  try { cm.on('change', scheduleDocRefresh); } catch (e) { /* 编辑器不支持事件（理论上不会） */ }

  const input = bar.querySelector('.nt-find-input');
  if (cfg.replace) setReplaceVisible(true);
  if (cfg.seed) { input.value = String(cfg.seed); runFind({ jump: true }); }
  else if (input.value) runFind({ jump: false });
  focusField('find');
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
  if (cm) {
    try { cm.off('change', scheduleDocRefresh); } catch (e) { /* 已销毁 */ }
  }
  if (bar && bar.parentNode) bar.remove();
  bar = null;
  const oldCm = cm;
  cm = null;
  matches = [];
  index = -1;
  host = null;
  if (!o.keepFocus && oldCm) {
    // Esc / 点关闭：焦点回到正文，继续打字（而不是留在已经消失的输入框上）
    try { oldCm.focus(); } catch (e) { /* 编辑器已销毁 */ }
  }
}

/* ---------------- 浮条 DOM ---------------- */

function buildBar() {
  const el = document.createElement('div');
  el.className = 'nt-find';
  el.id = 'nt-find-bar';
  el.innerHTML = `
    <div class="nt-find-row">
      <input class="nt-find-input" type="text" placeholder="查找正文…" spellcheck="false" autocomplete="off" />
      <span class="nt-find-count" data-f="count">—</span>
      <button type="button" class="mini-btn" data-f="prev" title="上一个匹配 (Shift+Enter / Shift+F3)">↑</button>
      <button type="button" class="mini-btn" data-f="next" title="下一个匹配 (Enter / F3)">↓</button>
      <button type="button" class="mini-btn nt-find-toggle" data-f="case" title="区分大小写" aria-pressed="false">Aa</button>
      <button type="button" class="mini-btn nt-find-toggle" data-f="replace-toggle" title="替换 (Ctrl+H)" aria-pressed="false">⇄</button>
      <button type="button" class="mini-btn" data-f="close" title="关闭 (Esc)">✕</button>
    </div>
    <div class="nt-find-row nt-find-replace">
      <input class="nt-find-replace-input" type="text" placeholder="替换为…" spellcheck="false" autocomplete="off" />
      <button type="button" class="ghost-btn tiny" data-f="replace">替换</button>
      <button type="button" class="ghost-btn tiny" data-f="replace-all">全部替换</button>
    </div>`;
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
  const replaceInput = bar.querySelector('.nt-find-replace-input');

  // 边打边找：每敲一个字都重算命中并把光标移到「光标之后的第一个」，
  // 连续输入时这个词只会越收越窄，观感就是原地成长起来的高亮
  findInput.addEventListener('input', () => runFind({ jump: true }));
  // 替换框随便输入，不要连带触发查找
  replaceInput.addEventListener('input', () => {});

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
    // 但那里会尝试重建浮条，这里拦下来自己处理更顺手）
    if ((e.ctrlKey || e.metaKey) && (k === 'h' || k === 'H')) {
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
  if (!matches.length) {
    el.textContent = bar.querySelector('.nt-find-input').value ? '无结果' : '—';
    el.classList.toggle('is-none', !!bar.querySelector('.nt-find-input').value);
    return;
  }
  el.textContent = `${index + 1}/${matches.length}`;
  el.classList.remove('is-none');
}

function setNoMatch(on) {
  if (!bar) return;
  const input = bar.querySelector('.nt-find-input');
  if (input) input.classList.toggle('is-none', !!on);
}

/**
 * 跑一次查找。
 * @param {{jump?:boolean, anchor?:object}} [o] anchor 用于替换后定位（默认从光标处起）
 */
function runFind(o = {}) {
  if (!bar || !cm) return;
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
  if (!matches.length) return;
  index = (index + delta + matches.length) % matches.length;
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
