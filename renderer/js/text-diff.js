'use strict';
/**
 * 实用工具 →「文本对比」浮窗（菜单：实用工具 → 文本对比）。
 *
 * 形态：非模态浮窗（js/tool-window.js），无遮罩，开着它照样能操作主界面。
 *
 * 差异算法用 jsdiff（打包在 renderer/vendor/tools/diff.mjs，首次用到才加载）：
 *  - 按行 diff 出「增 / 删 / 相同」三类，再拼成并排（左旧右新）或内联两种视图；
 *  - 同一行内再做一次词级 diff，高亮到底改了哪几个词（行太长时跳过，避免卡顿）；
 *  - 「忽略空白 / 空行 / 大小写」是在**比较前**把每一行归一化，比较用的是归一化文本、
 *    显示的仍是原文，所以行号与内容不会错位。
 * 「格式化双方」直接复用 code-format.js 的 formatText —— 先各自格式化再比，
 * 排版差异就不会淹没真正的改动。
 */
import { api } from './api.js';
import { openToolWindow } from './tool-window.js';
import { formatText, LANG_OPTIONS, copyText } from './code-format.js';

let notify = () => {};
export function setDiffHandlers({ toast } = {}) {
  if (toast) notify = toast;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const DEFAULTS = { lang: 'auto', ignoreWs: false, ignoreBlank: false, ignoreCase: false, mode: 'split' };
/** 差异行渲染上限：超大文本只渲染前 N 行，避免一次插入几万行把界面卡死 */
const MAX_ROWS = 4000;
const WORD_DIFF_MAX = 4000;

/* ---------------- 差异计算 ---------------- */

/**
 * 归一化一行（只用于比较，不影响显示）。
 * 顺序有讲究：先折叠空白再转小写，否则 trim 的位置会受大小写影响（其实不影响，但保持单一路径）。
 */
function normalizeLine(line, o) {
  let s = line;
  if (o.ignoreWs) s = s.replace(/\s+/g, ' ').trim();
  if (o.ignoreCase) s = s.toLowerCase();
  return s;
}

/**
 * 按行 split，并为「忽略空行」保留原行号映射。
 * @returns {{kept:Array<{idx:number,text:string,cmp:string}>, text:string}}
 */
function prepareLines(text, o) {
  const lines = String(text == null ? '' : text).split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (o.ignoreBlank && !raw.trim()) continue;
    kept.push({ idx: i, text: raw, cmp: normalizeLine(raw, o) });
  }
  return { kept, text: kept.map((k) => k.cmp).join('\n') };
}

/** jsdiff 的一个 part → 若干行（去掉末尾空串） */
function partLines(value) {
  const arr = String(value || '').split('\n');
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

/**
 * 算出差异操作序列。
 * @returns {{ops:Array<{type:'common'|'del'|'add', idx:number, text:string}>,
 *            aKept:Array, bKept:Array}}
 *   del 的 idx 指向原文 A 的行号，add 指向 B，common 同时有两侧（idx = A 行号，idxB = B 行号）
 */
async function computeOps(aText, bText, o) {
  const { diffLines } = await import('../vendor/tools/diff.mjs');
  const A = prepareLines(aText, o);
  const B = prepareLines(bText, o);
  const parts = diffLines(A.text, B.text);
  const ops = [];
  let ca = 0;
  let cb = 0;
  for (const p of parts) {
    const lines = partLines(p.value);
    const type = p.removed ? 'del' : (p.added ? 'add' : 'common');
    for (let i = 0; i < lines.length; i += 1) {
      if (type === 'add') {
        const k = B.kept[cb++];
        if (k) ops.push({ type, idx: k.idx, text: k.text });
      } else if (type === 'del') {
        const k = A.kept[ca++];
        if (k) ops.push({ type, idx: k.idx, text: k.text });
      } else {
        const ka = A.kept[ca++];
        const kb = B.kept[cb++];
        if (ka && kb) ops.push({ type, idx: ka.idx, idxB: kb.idx, text: ka.text, textB: kb.text });
      }
    }
  }
  return { ops, aKept: A.kept, bKept: B.kept };
}

/* ---------------- 视图渲染 ---------------- */

/**
 * 并排视图：连续的删 / 增 组成一组，左删右增逐行对齐，不足的一侧留空行占位。
 */
function splitRows(ops, limit) {
  const rows = [];
  let pendDel = [];
  let pendAdd = [];
  const flush = () => {
    if (!pendDel.length && !pendAdd.length) return;
    const n = Math.max(pendDel.length, pendAdd.length);
    for (let i = 0; i < n; i += 1) {
      const d = pendDel[i];
      const a = pendAdd[i];
      rows.push({ kind: 'pair', del: d || null, add: a || null });
    }
    pendDel = [];
    pendAdd = [];
  };
  for (const op of ops) {
    if (op.type === 'common') {
      flush();
      rows.push({ kind: 'same', a: op, b: op });
    } else if (op.type === 'del') pendDel.push(op);
    else pendAdd.push(op);
    if (rows.length >= limit) break;
  }
  flush();
  return rows;
}

function renderSplit(container, rows, stats) {
  let html = '';
  for (const r of rows) {
    if (r.kind === 'same') {
      const a = r.a;
      html += '<div class="df-row same">'
        + `<span class="df-ln">${a.idx + 1}</span><span class="df-cell">${esc(a.text) || '&nbsp;'}</span>`
        + `<span class="df-ln">${(a.idxB == null ? a.idx : a.idxB) + 1}</span><span class="df-cell">${esc(a.textB || a.text) || '&nbsp;'}</span>`
        + '</div>';
      continue;
    }
    const d = r.del;
    const a = r.add;
    html += `<div class="df-row${d ? ' del' : ''}${a ? ' add' : ''}">`
      + `<span class="df-ln${d ? ' del' : ''}">${d ? d.idx + 1 : ''}</span>`
      + `<span class="df-cell${d ? ' del' : ' pad'}"${d ? ` data-wd="l"` : ''}>${d ? esc(d.text) || '&nbsp;' : ''}</span>`
      + `<span class="df-ln${a ? ' add' : ''}">${a ? a.idx + 1 : ''}</span>`
      + `<span class="df-cell${a ? ' add' : ' pad'}"${a ? ` data-wd="r"` : ''}>${a ? esc(a.text) || '&nbsp;' : ''}</span>`
      + `</div>`;
  }
  container.innerHTML = html || `<div class="df-empty">${esc(stats.emptyText || '两侧内容一致，没有差异。')}</div>`;
}

function renderInline(container, ops, limit) {
  let html = '';
  let n = 0;
  for (const op of ops) {
    if (n >= limit) break;
    n += 1;
    if (op.type === 'common') {
      html += `<div class="df-row same inline">`
        + `<span class="df-ln">${op.idx + 1}</span><span class="df-ln">${(op.idxB == null ? op.idx : op.idxB) + 1}</span>`
        + `<span class="df-sign"> </span><span class="df-cell">${esc(op.text) || '&nbsp;'}</span></div>`;
    } else if (op.type === 'del') {
      html += `<div class="df-row del inline">`
        + `<span class="df-ln del">${op.idx + 1}</span><span class="df-ln"></span>`
        + `<span class="df-sign del">-</span><span class="df-cell del" data-wd="l">${esc(op.text) || '&nbsp;'}</span></div>`;
    } else {
      html += `<div class="df-row add inline">`
        + `<span class="df-ln"></span><span class="df-ln add">${op.idx + 1}</span>`
        + `<span class="df-sign add">+</span><span class="df-cell add" data-wd="r">${esc(op.text) || '&nbsp;'}</span></div>`;
    }
  }
  container.innerHTML = html;
}

/* ---------------- 窗口 ---------------- */

export async function openDiffWindow({ a = '', b = '' } = {}) {
  const saved = await api.ui.getToolPref('diff').catch(() => null);
  const cfg = { ...DEFAULTS, ...(saved || {}) };

  return openToolWindow({
    key: 'text-diff',
    title: '文本对比',
    size: { width: 1020, height: 700 },
    minWidth: 680,
    minHeight: 420,
    html: diffHtml(cfg),
    onMount: (root, win) => bindDiff(root, win, cfg, a, b),
  });
}

function diffHtml(cfg) {
  const langs = [{ id: 'auto', label: '自动识别' }, ...LANG_OPTIONS.filter((l) => l.id !== 'auto')];
  return `
    <div class="df-wrap">
      <div class="df-bar">
        <label class="df-field"><span class="df-label">语言</span>
          <select class="df-ctl df-lang">${langs.map((l) => `<option value="${esc(l.id)}"${l.id === cfg.lang ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select>
        </label>
        <button type="button" class="ghost-btn df-format" title="按上面的语言先各自格式化，再对比">格式化双方</button>
        <span class="df-sep"></span>
        <label class="df-check" title="比较前折叠每行首尾与连续空白"><input type="checkbox" class="df-ctl df-ws"${cfg.ignoreWs ? ' checked' : ''} /><span>忽略空白</span></label>
        <label class="df-check" title="比较前跳过空行"><input type="checkbox" class="df-ctl df-blank"${cfg.ignoreBlank ? ' checked' : ''} /><span>忽略空行</span></label>
        <label class="df-check" title="比较前统一转小写"><input type="checkbox" class="df-ctl df-case"${cfg.ignoreCase ? ' checked' : ''} /><span>忽略大小写</span></label>
        <span class="df-spacer"></span>
        <span class="df-seg">
          <button type="button" class="df-mode${cfg.mode === 'split' ? ' active' : ''}" data-mode="split">并排</button>
          <button type="button" class="df-mode${cfg.mode === 'inline' ? ' active' : ''}" data-mode="inline">内联</button>
        </span>
        <button type="button" class="ghost-btn df-swap" title="交换左右两侧">交换</button>
        <button type="button" class="ghost-btn df-clear">清空</button>
      </div>
      <div class="df-panes">
        <section class="df-pane">
          <div class="df-pane-head"><span class="df-pane-title">原文 A</span><span class="df-count df-a-count">0 行</span></div>
          <textarea class="df-area df-a" spellcheck="false" wrap="off" placeholder="粘贴原始文本…"></textarea>
        </section>
        <section class="df-pane">
          <div class="df-pane-head"><span class="df-pane-title">原文 B</span><span class="df-count df-b-count">0 行</span></div>
          <textarea class="df-area df-b" spellcheck="false" wrap="off" placeholder="粘贴修改后的文本…"></textarea>
        </section>
      </div>
      <div class="df-result">
        <div class="df-result-head">
          <span class="df-stat">等待输入…</span>
          <span class="df-spacer"></span>
          <button type="button" class="mini-btn df-copy" title="以 +/- 前缀复制差异文本">复制差异</button>
        </div>
        <div class="df-view" data-mode="${esc(cfg.mode)}"></div>
      </div>
    </div>`;
}

function bindDiff(root, win, cfg, initialA, initialB) {
  const $ = (s) => root.querySelector(s);
  const aEl = $('.df-a');
  const bEl = $('.df-b');
  const viewEl = $('.df-view');
  const statEl = $('.df-stat');
  const state = { ...cfg };
  let timer = null;
  let lastOps = [];

  const countText = (t) => `${t ? t.split('\n').length : 0} 行`;

  const readOpts = () => ({
    lang: $('.df-lang').value,
    ignoreWs: $('.df-ws').checked,
    ignoreBlank: $('.df-blank').checked,
    ignoreCase: $('.df-case').checked,
    mode: state.mode,
  });

  const persist = () => {
    Object.assign(state, readOpts());
    api.ui.setToolPref('diff', state).catch(() => {});
  };

  /** 词级高亮补丁：渲染完骨架后，给成对出现的改动行补上 <span> */
  const paintWordDiff = async (rows) => {
    const pairs = [];
    for (const r of rows) {
      if (r.kind === 'pair' && r.del && r.add
        && r.del.text.length < WORD_DIFF_MAX && r.add.text.length < WORD_DIFF_MAX) {
        pairs.push(r);
      }
    }
    if (!pairs.length) return;
    const { diffWordsWithSpace } = await import('../vendor/tools/diff.mjs');
    const nodes = [...viewEl.querySelectorAll('.df-row.del.add')];
    pairs.forEach((r, i) => {
      const node = nodes[i];
      if (!node) return;
      const parts = diffWordsWithSpace(r.del.text, r.add.text);
      let left = '';
      let right = '';
      for (const p of parts) {
        const v = esc(p.value);
        if (p.added) { right += `<span class="df-w add">${v}</span>`; continue; }
        if (p.removed) { left += `<span class="df-w del">${v}</span>`; continue; }
        left += v;
        right += v;
      }
      const lc = node.querySelector('[data-wd="l"]');
      const rc = node.querySelector('[data-wd="r"]');
      if (lc) lc.innerHTML = left || '&nbsp;';
      if (rc) rc.innerHTML = right || '&nbsp;';
    });
  };

  const render = async () => {
    const opts = readOpts();
    const mode = state.mode;
    viewEl.dataset.mode = mode;
    const aText = aEl.value;
    const bText = bEl.value;
    $('.df-a-count').textContent = countText(aText);
    $('.df-b-count').textContent = countText(bText);
    if (!aText && !bText) {
      viewEl.innerHTML = '<div class="df-empty">在上方左右两侧各粘贴一段文本，这里会实时显示差异。</div>';
      statEl.textContent = '等待输入…';
      return;
    }
    try {
      const { ops } = await computeOps(aText, bText, opts);
      lastOps = ops;
      const del = ops.filter((o) => o.type === 'del').length;
      const add = ops.filter((o) => o.type === 'add').length;
      const same = ops.filter((o) => o.type === 'common').length;
      statEl.innerHTML = `差异 <b class="df-n-add">+${add}</b> <b class="df-n-del">-${del}</b> <span class="df-n-same">相同 ${same}</span>`;
      if (!del && !add) {
        viewEl.innerHTML = '<div class="df-empty">两侧内容一致，没有差异。</div>';
        return;
      }
      if (mode === 'inline') {
        renderInline(viewEl, ops, MAX_ROWS);
      } else {
        const rows = splitRows(ops, MAX_ROWS);
        renderSplit(viewEl, rows, {});
        await paintWordDiff(rows);
      }
    } catch (e) {
      viewEl.innerHTML = `<div class="df-empty err">对比失败：${esc(String((e && e.message) || e))}</div>`;
      statEl.textContent = '对比失败';
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(render, 220);
  };

  /* ---- 交互 ---- */
  root.addEventListener('input', (e) => {
    if (e.target === aEl || e.target === bEl) schedule();
  });
  root.addEventListener('change', (e) => {
    if (!e.target.classList.contains('df-ctl')) return;
    persist();
    render();
  });
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('df-mode')) {
      state.mode = t.dataset.mode;
      root.querySelectorAll('.df-mode').forEach((b) => b.classList.toggle('active', b === t));
      persist();
      render();
    } else if (t.classList.contains('df-swap')) {
      const tmp = aEl.value;
      aEl.value = bEl.value;
      bEl.value = tmp;
      render();
      notify('已交换两侧');
    } else if (t.classList.contains('df-clear')) {
      aEl.value = '';
      bEl.value = '';
      render();
      aEl.focus();
    } else if (t.classList.contains('df-format')) {
      const opts = readOpts();
      let changed = 0;
      for (const el of [aEl, bEl]) {
        if (!el.value.trim()) continue;
        try {
          const { text } = await formatText(el.value, opts);
          if (text !== el.value) { el.value = text; changed += 1; }
        } catch (err) {
          notify(`格式化失败：${String((err && err.message) || err).split('\n')[0]}`);
        }
      }
      persist();
      render();
      if (changed) notify('已格式化，再看看差异');
    } else if (t.classList.contains('df-copy')) {
      if (!lastOps.length) { notify('还没有可复制的差异'); return; }
      const text = lastOps.map((o) => {
        if (o.type === 'add') return `+ ${o.text}`;
        if (o.type === 'del') return `- ${o.text}`;
        return `  ${o.text}`;
      }).join('\n');
      const ok = await copyText(text);
      notify(ok ? '差异已复制' : '复制失败，请手动选中复制');
    }
  });

  // Tab 缩进（与格式化窗口保持一致的手感）
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || (e.target !== aEl && e.target !== bEl)) return;
    e.preventDefault();
    const pad = '  ';
    const el = e.target;
    el.setRangeText(pad, el.selectionStart, el.selectionEnd, 'end');
  });

  if (initialA) aEl.value = String(initialA);
  if (initialB) bEl.value = String(initialB);
  render();
  aEl.focus();
}
