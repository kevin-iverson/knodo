'use strict';
/**
 * 实用工具 →「JSON 查看器」浮窗（菜单：实用工具 → JSON 查看器）。
 *
 * 形态与其它工具一致：非模态浮窗（js/tool-window.js），开着也能继续操作主界面。
 *
 * 三件事（都交给成熟库，不自己造轮子）：
 *  - 树形展示 / 按类型着色 / 折叠展开 → @alenaksu/json-viewer（Lit 写的 Web Component，
 *    自带 filter / expand / search，正好是「对象搜索查询」需要的那套能力）；
 *  - 格式化 → 复用 code-format.js 的 formatText（JSON 走 JSON.stringify，输出只由数据决定）；
 *  - 路径查询 → jsonpath-plus（$.a.b[0] / $..name 这类表达式）。
 * 产物都在 renderer/vendor/tools/ 下，首次打开才动态 import。
 *
 * 配置（缩进 / 展开层级）存 settings 的 `tool.json`。
 */
import { api } from './api.js';
import { openToolWindow } from './tool-window.js';
import { formatText, copyText, paintHighlight } from './code-format.js';

let notify = () => {};
export function setJsonViewHandlers({ toast } = {}) {
  if (toast) notify = toast;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const DEFAULTS = { indent: 2, expand: '**', highlight: true };

/** 展开层级选项：值直接是 json-viewer 的 expand() 路径表达式 */
const EXPANDS = [
  { id: '**', label: '全部展开' },
  { id: '*', label: '仅第一层' },
  { id: '*.*', label: '展开两层' },
  { id: '', label: '全部收起' },
];

const SAMPLE = '{"name":"Knodo","version":1.8,"features":["任务","笔记","知识库"],'
  + '"meta":{"stars":128,"ok":true,"owner":null},'
  + '"tasks":[{"id":1,"title":"写周报","done":false,"tags":["工作"]},'
  + '{"id":2,"title":"读书","done":true,"tags":["生活","长期"]}]}';

/** 窗口内共享的运行时状态（每个窗口一份，靠闭包隔离） */
function createState(cfg) {
  return { ...cfg, data: null, hits: 0, iter: null, pathErr: '' };
}

export async function openJsonViewWindow({ text = '' } = {}) {
  const saved = await api.ui.getToolPref('json').catch(() => null);
  const cfg = { ...DEFAULTS, ...(saved || {}) };

  return openToolWindow({
    key: 'json-view',
    title: 'JSON 查看器',
    size: { width: 1060, height: 700 },
    minWidth: 680,
    minHeight: 420,
    html: jsonViewHtml(cfg),
    onMount: (root, win) => bindJsonView(root, win, cfg, text),
  });
}

function jsonViewHtml(cfg) {
  return `
    <div class="jv-wrap">
      <div class="jv-bar">
        <label class="jv-field"><span class="jv-label">缩进</span>
          <select class="jv-ctl jv-indent">
            ${[2, 4].map((n) => `<option value="${n}"${Number(cfg.indent) === n ? ' selected' : ''}>${n} 空格</option>`).join('')}
          </select>
        </label>
        <button type="button" class="ghost-btn jv-format" title="按上面的缩进重新排版">格式化</button>
        <button type="button" class="ghost-btn jv-minify" title="压成一行（去掉所有多余空白）">压缩</button>
        <span class="jv-sep"></span>
        <label class="jv-field"><span class="jv-label">展开</span>
          <select class="jv-ctl jv-expand">
            ${EXPANDS.map((e) => `<option value="${esc(e.id)}"${String(cfg.expand) === String(e.id) ? ' selected' : ''}>${esc(e.label)}</option>`).join('')}
          </select>
        </label>
        <!-- 类名必须是 jv-hl-toggle：.jv-hl 是高亮层 <pre> 的样式，复用会把复选框拉成全窗巨大图标 -->
        <label class="jv-check" title="给输入框与查询结果上色">
          <input type="checkbox" class="jv-ctl jv-hl-toggle"${cfg.highlight !== false ? ' checked' : ''} /><span>语法高亮</span>
        </label>
        <span class="jv-spacer"></span>
        <button type="button" class="ghost-btn jv-sample">示例</button>
        <button type="button" class="ghost-btn jv-clear">清空</button>
        <button type="button" class="primary-btn jv-copy">复制</button>
      </div>

      <div class="jv-body">
        <section class="jv-pane jv-left">
          <div class="jv-pane-head">
            <span class="jv-pane-title">JSON 文本</span>
            <span class="jv-count jv-in-count">0 字符</span>
          </div>
          <div class="jv-editor">
            <pre class="jv-hl" aria-hidden="true"><code class="jv-hl-code"></code></pre>
            <textarea class="jv-area" spellcheck="false" wrap="off"
                      placeholder='把 JSON 粘贴进来，例如 {"a":1,"b":[2,3]}'></textarea>
          </div>
        </section>

        <section class="jv-pane jv-right">
          <div class="jv-pane-head">
            <span class="jv-pane-title">树形视图</span>
            <span class="jv-spacer"></span>
            <input type="search" class="jv-input jv-search" placeholder="搜索键名 / 值（回车跳下一个）" />
            <span class="jv-hits">—</span>
            <button type="button" class="mini-btn jv-next" title="跳到下一个命中">下一个</button>
            <button type="button" class="mini-btn jv-reset" title="清除过滤">重置</button>
          </div>
          <div class="jv-tree-scroll"><json-viewer class="jv-tree"></json-viewer></div>
          <div class="jv-query">
            <input type="text" class="jv-input jv-path" placeholder="JSONPath 查询，如 $.tasks[0].title 或 $..title" />
            <button type="button" class="ghost-btn jv-run-path">查询</button>
          </div>
          <div class="jv-result"><span class="jv-result-tip">查询结果会显示在这里。</span></div>
        </section>
      </div>

      <div class="jv-status" data-state="idle">粘贴 JSON 后自动解析；支持 JSONPath 查询与键名 / 值搜索。</div>
    </div>`;
}

function bindJsonView(root, win, cfg, initialText) {
  const $ = (s) => root.querySelector(s);
  const areaEl = $('.jv-area');
  const codeEl = $('.jv-hl-code');
  const viewerEl = $('.jv-tree');
  const statusEl = $('.jv-status');
  const resultEl = $('.jv-result');
  const state = createState(cfg);

  let viewerReady = false;
  let timer = null;
  let hlSeq = 0;

  const setStatus = (msg, kind = 'idle') => {
    statusEl.textContent = msg;
    statusEl.dataset.state = kind;
  };

  /** 高亮层刷新（异步库 + 连续输入，用序号丢弃过期结果） */
  const paintHl = async () => {
    const seq = ++hlSeq;
    await paintHighlight(codeEl, areaEl.value, 'json', state.highlight !== false);
    if (seq !== hlSeq) return;
    const pre = codeEl && codeEl.parentElement;
    if (pre) {
      pre.scrollTop = areaEl.scrollTop;
      pre.scrollLeft = areaEl.scrollLeft;
    }
  };

  /** 载入组件（副作用 import 会注册 <json-viewer>），加载完才能用 filter / search */
  const ensureViewer = async () => {
    if (viewerReady) return true;
    try {
      await import('../vendor/tools/json-viewer.mjs');
      // 自定义元素可能在本窗口 HTML 插入后才完成注册，手动 upgrade 一次
      if (window.customElements && !customElements.get('json-viewer')) return false;
      if (window.customElements && viewerEl && customElements.upgrade) customElements.upgrade(viewerEl);
      viewerReady = true;
      return true;
    } catch (e) {
      setStatus(`JSON 组件加载失败：${String((e && e.message) || e)}`, 'err');
      return false;
    }
  };

  const applyExpand = (level) => {
    if (!viewerReady || !viewerEl || !viewerEl.collapseAll) return;
    viewerEl.collapseAll();
    if (level === '**') viewerEl.expandAll();
    else if (level) viewerEl.expand(level);
  };

  /** 解析 → 灌进树；失败时保留上一次的树，只在状态条报错 */
  const parseAndRender = async () => {
    const src = areaEl.value;
    $('.jv-in-count').textContent = `${src.length} 字符`;
    if (!src.trim()) {
      if (viewerReady && viewerEl) viewerEl.data = {};
      state.data = null;
      setStatus('粘贴一段 JSON 开始查看。', 'idle');
      return;
    }
    let data = null;
    try {
      data = JSON.parse(src);
    } catch (e) {
      setStatus(`JSON 解析失败：${String((e && e.message) || e)}`, 'err');
      return;
    }
    state.data = data;
    const ok = await ensureViewer();
    if (!ok) return;
    viewerEl.data = data;
    applyExpand(state.expand);
    const count = countNodes(data);
    setStatus(`解析成功 · ${count.nodes} 个节点（最深 ${count.depth} 层）`, 'ok');
    resetSearch();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(parseAndRender, 260);
  };

  /* ---------------- 搜索（键名 / 值过滤 + 逐个跳转） ---------------- */

  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const resetSearch = () => {
    state.iter = null;
    state.hits = 0;
    const hitsEl = $('.jv-hits');
    if (hitsEl) hitsEl.textContent = '—';
    if (!viewerReady || !viewerEl || !viewerEl.resetFilter) return;
    try { viewerEl.resetFilter(); } catch (e) { /* 组件未就绪 */ }
  };

  /** 关键词过滤：只保留命中的节点，并把命中数显示出来 */
  const runFilter = () => {
    const kw = String($('.jv-search').value || '').trim();
    if (!viewerReady || !viewerEl || !viewerEl.filter) return;
    if (!kw) { resetSearch(); return; }
    let re;
    try {
      re = new RegExp(escapeRegExp(kw), 'i');
    } catch (e) {
      setStatus('搜索词无法作为正则匹配，请换个词。', 'err');
      return;
    }
    try {
      viewerEl.filter(re);
      // 计数：另起一个 search 迭代器走一遍（组件不直接给数量）
      let n = 0;
      if (viewerEl.search) {
        const it = viewerEl.search(re);
        if (it && typeof it.next === 'function') {
          for (let r = it.next(); !r.done; r = it.next()) n += 1;
        }
      }
      state.hits = n;
      state.iter = null;
      $('.jv-hits').textContent = n ? `${n} 个命中` : '无命中';
      setStatus(n ? `已过滤出 ${n} 个命中节点（「下一个」可逐个跳转）` : '没有匹配的节点。', n ? 'ok' : 'idle');
    } catch (e) {
      setStatus(`搜索失败：${String((e && e.message) || e)}`, 'err');
    }
  };

  /** 「下一个」：用组件的 search 迭代器逐个滚动并高亮（还没过滤过就先过滤一次） */
  const gotoNext = async () => {
    const kw = String($('.jv-search').value || '').trim();
    if (!kw) { setStatus('先输入搜索词。', 'idle'); return; }
    if (!viewerReady || !viewerEl || !viewerEl.search) return;
    if (!state.iter && !state.hits) await runFilter();
    try {
      if (!state.iter) {
        state.iter = viewerEl.search(new RegExp(escapeRegExp(kw), 'i'));
        state.idx = 0;
      }
      const r = state.iter.next();
      if (r.done) {
        state.iter = viewerEl.search(new RegExp(escapeRegExp(kw), 'i')); // 回到第一个
        state.idx = 0;
        const again = state.iter.next();
        if (again.done) { setStatus('没有匹配的节点。', 'idle'); return; }
        state.idx = 1;
        setStatus(`第 ${state.idx} / ${state.hits || '?'} 个命中（已到末尾，回到第一个）`, 'ok');
        return;
      }
      state.idx = (state.idx || 0) + 1;
      setStatus(`第 ${state.idx} / ${state.hits || '?'} 个命中`, 'ok');
    } catch (e) {
      setStatus(`跳转失败：${String((e && e.message) || e)}`, 'err');
    }
  };

  /* ---------------- JSONPath 查询 ---------------- */

  const runPath = async () => {
    const expr = String($('.jv-path').value || '').trim();
    if (!expr) { setStatus('输入 JSONPath 表达式，例如 $.tasks[0].title。', 'idle'); return; }
    if (!state.data) { setStatus('先粘贴一段能解析的 JSON。', 'err'); return; }
    try {
      const mod = await import('../vendor/tools/jsonpath.mjs');
      const out = mod.JSONPath({ path: expr, json: state.data, wrap: false });
      const n = Array.isArray(out) ? out.length : (out === undefined ? 0 : 1);
      if (!n) {
        resultEl.innerHTML = '<span class="jv-result-tip">没有匹配到任何节点。</span>';
        setStatus(`JSONPath「${expr}」没有匹配结果。`, 'idle');
        return;
      }
      const shown = Array.isArray(out) ? out : [out];
      const text = JSON.stringify(shown.length === 1 ? shown[0] : shown, null, 2);
      const html = await (async () => {
        try {
          const hl = await import('../vendor/tools/highlight.mjs');
          return hl.highlightCode(text, 'json');
        } catch (e) {
          return esc(text);
        }
      })();
      resultEl.innerHTML = `<div class="jv-result-head">${n} 个匹配</div><pre class="jv-result-code"><code>${html}</code></pre>`;
      setStatus(`JSONPath「${expr}」命中 ${n} 个。`, 'ok');
    } catch (e) {
      resultEl.innerHTML = `<span class="jv-result-tip err">查询失败：${esc(String((e && e.message) || e))}</span>`;
      setStatus(`JSONPath 查询失败：${String((e && e.message) || e)}`, 'err');
    }
  };

  /* ---------------- 交互 ---------------- */

  const persist = () => {
    api.ui.setToolPref('json', {
      indent: Number($('.jv-indent').value) || 2,
      expand: $('.jv-expand').value,
      highlight: $('.jv-hl-toggle').checked,
    }).catch(() => {});
  };

  const setText = (text) => {
    areaEl.value = String(text || '');
    paintHl();
    parseAndRender();
  };

  let searchTimer = null;
  root.addEventListener('input', (e) => {
    if (e.target === areaEl) {
      $('.jv-in-count').textContent = `${areaEl.value.length} 字符`;
      paintHl();
      schedule();
      return;
    }
    // 搜索框：边输边过滤（防抖，避免每敲一个字都重画整棵树）
    if (e.target === $('.jv-search')) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.iter = null;
        runFilter();
      }, 300);
    }
  });

  root.addEventListener('scroll', () => {
    const pre = codeEl && codeEl.parentElement;
    if (!pre) return;
    pre.scrollTop = areaEl.scrollTop;
    pre.scrollLeft = areaEl.scrollLeft;
  }, true);

  root.addEventListener('change', (e) => {
    if (!e.target.classList.contains('jv-ctl')) return;
    if (e.target.classList.contains('jv-hl-toggle')) {
      state.highlight = e.target.checked;
      paintHl();
    } else if (e.target.classList.contains('jv-expand')) {
      state.expand = e.target.value;
      applyExpand(state.expand);
    } else if (e.target.classList.contains('jv-indent')) {
      state.indent = Number(e.target.value) || 2;
    }
    persist();
  });

  root.addEventListener('keydown', (e) => {
    if (e.target === $('.jv-search') && e.key === 'Enter') {
      e.preventDefault();
      if (state.iter) gotoNext();
      else runFilter();
      return;
    }
    if (e.target === $('.jv-path') && e.key === 'Enter') {
      e.preventDefault();
      runPath();
      return;
    }
    if (e.key === 'Tab' && e.target === areaEl) {
      e.preventDefault();
      areaEl.setRangeText('  ', areaEl.selectionStart, areaEl.selectionEnd, 'end');
    }
  });

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('jv-format')) {
      if (!areaEl.value.trim()) { setStatus('没有可格式化的内容。', 'idle'); return; }
      try {
        const { text } = await formatText(areaEl.value, {
          lang: 'json', indent: Number($('.jv-indent').value) || 2,
        });
        setText(text);
        notify('已格式化');
      } catch (err) {
        setStatus(`格式化失败：${String((err && err.message) || err).split('\n')[0]}`, 'err');
      }
    } else if (t.classList.contains('jv-minify')) {
      if (!areaEl.value.trim()) return;
      try {
        setText(JSON.stringify(JSON.parse(areaEl.value)));
        notify('已压缩成一行');
      } catch (err) {
        setStatus(`压缩失败：${String((err && err.message) || err).split('\n')[0]}`, 'err');
      }
    } else if (t.classList.contains('jv-sample')) {
      setText(SAMPLE);
    } else if (t.classList.contains('jv-clear')) {
      areaEl.value = '';
      $('.jv-in-count').textContent = '0 字符';
      resultEl.innerHTML = '<span class="jv-result-tip">查询结果会显示在这里。</span>';
      paintHl();
      parseAndRender();
      areaEl.focus();
    } else if (t.classList.contains('jv-copy')) {
      if (!areaEl.value) { notify('还没有可复制的内容'); return; }
      const ok = await copyText(areaEl.value);
      notify(ok ? '已复制 JSON' : '复制失败，请手动选中复制');
    } else if (t.classList.contains('jv-next')) {
      gotoNext();
    } else if (t.classList.contains('jv-reset')) {
      $('.jv-search').value = '';
      resetSearch();
      setStatus('已清除过滤。', 'idle');
    } else if (t.classList.contains('jv-run-path')) {
      await runPath();
    }
  });

  if (initialText) {
    areaEl.value = String(initialText);
    $('.jv-in-count').textContent = `${areaEl.value.length} 字符`;
  }
  paintHl();
  parseAndRender();
  areaEl.focus();
}

/** 统计节点数与最大深度（给状态条一个"这份数据多大"的直观感受） */
function countNodes(data) {
  let nodes = 0;
  const walk = (v, depth) => {
    nodes += 1;
    let maxDepth = depth;
    if (Array.isArray(v)) {
      for (const item of v) maxDepth = Math.max(maxDepth, walk(item, depth + 1));
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) maxDepth = Math.max(maxDepth, walk(v[k], depth + 1));
    }
    return maxDepth;
  };
  const depth = data && typeof data === 'object' ? walk(data, 1) : 1;
  return { nodes, depth };
}
