'use strict';
/**
 * AI 检索（弹窗）：输入关键词检索所有任务，AI 生成总结，结果以可点击链接展示。
 * 每次检索都会写进 ai_searches 表（关键词 + 总结 + 命中任务快照），
 * 下方「检索历史」可回看、删除；关窗再开、重启都不丢。
 *
 * 为什么是弹窗而不是独立视图：检索是「随手查一下」的动作，
 * 不该把主列表（含筛选、选中任务）整页换掉。弹窗关掉就回到原视图，上下文零丢失。
 *
 * 约束：
 *  - 同一时刻只允许一个检索弹窗：两层 openPanelModal 会让一次 Esc 连关两层；
 *  - 所有查询都走 rootEl 而不是 document，避免与页面里同名 id 撞车；
 *  - 点结果先关弹窗再开详情抽屉，否则抽屉被遮罩压住。
 */
import { api } from './api.js';
import { renderMarkdown } from './markdown.js';
import { openPanelModal } from './modal.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let handlers = { openDetail: () => {}, toast: () => {} };
export function setSearchHandlers(h) { handlers = { ...handlers, ...h }; }

/** 当前弹窗根节点 / 关闭函数（关闭后置空，异步回来时不会往已销毁的 DOM 里写） */
let rootEl = null;
let closeFn = null;
const q = (id) => (rootEl ? rootEl.querySelector(`#${id}`) : null);

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function panelHtml(initialKeyword) {
  return `
    <div class="search-panel">
      <div class="search-hero">
        <input id="ai-search-input" type="text" placeholder="输入关键词，检索任务并由 AI 生成总结…"
               value="${esc(initialKeyword)}" />
        <button id="ai-search-btn" class="primary-btn">🤖 AI 检索</button>
      </div>
      <div class="search-note" id="ai-search-note"></div>
      <div class="search-summary markdown-body" id="ai-search-summary" hidden></div>
      <ul class="search-results" id="ai-search-results"></ul>
      <div class="search-history" id="ai-search-history-box">
        <div class="sh-head"><span class="sh-title">检索历史</span><span class="sh-count" id="ai-search-history-count"></span></div>
        <ul class="sh-list" id="ai-search-history"><li class="subtask-empty">加载中…</li></ul>
      </div>
    </div>`;
}

/**
 * 打开检索弹窗。
 * @param {string} [initialKeyword] 顶栏搜索框已输入的关键词（只回填，不自动发起 —— AI 调用有成本）
 */
export function openSearchModal(initialKeyword = '') {
  const existing = document.querySelector('.modal-mask .modal-search');
  if (existing) {
    // 已经开着：不叠第二层，只把关键词带进去并聚焦
    const input = existing.querySelector('#ai-search-input');
    if (input) {
      const kw = String(initialKeyword || '').trim();
      if (kw) input.value = kw;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    return;
  }

  openPanelModal({
    title: '🤖 AI 检索',
    className: 'modal-search',
    showClose: true,
    okText: '关闭',
    resizable: true,
    resizeKey: 'ai-search',
    minWidth: 560,
    minHeight: 420,
    html: panelHtml(initialKeyword),
    onMount: (root, close) => {
      rootEl = root;
      closeFn = close;
      const input = q('ai-search-input');
      const btn = q('ai-search-btn');
      const run = () => doSearch(input.value.trim());
      btn.addEventListener('click', run);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); run(); }
      });
      input.focus();
      // 关键词从顶栏带过来时把光标放到末尾，直接回车即可检索
      if (initialKeyword) input.setSelectionRange(input.value.length, input.value.length);
      bindHistoryEvents();
      loadHistory();
    },
    onClose: () => { rootEl = null; closeFn = null; },
  });
}

/* ---------------- 检索 ---------------- */

async function doSearch(keyword) {
  if (!keyword) { handlers.toast('请输入检索关键词'); return; }
  const note = q('ai-search-note');
  const summary = q('ai-search-summary');
  const results = q('ai-search-results');
  const btn = q('ai-search-btn');
  if (!note || !results) return;
  note.textContent = '检索中…';
  summary.hidden = true;
  results.innerHTML = '';
  if (btn) btn.disabled = true;

  let r;
  try {
    r = await api.search.ai(keyword);
  } catch (e) {
    r = { ok: false, message: (e && e.message) || '检索失败' };
  } finally {
    if (btn) btn.disabled = false;
  }
  // 等待期间用户可能已经关窗：rootEl 置空后 q() 返回 null，这里直接放弃写 DOM
  if (!rootEl) return;
  if (!r.ok) { note.textContent = r.message || '检索失败'; return; }

  const n = r.tasks.length;
  if (!r.hasKey) note.textContent = `${resultHeadline(r, n)}（未配置 AI Key，仅做本地联想，请在「AI 报告」页配置以启用语义总结）`;
  else if (r.degraded) note.textContent = `${resultHeadline(r, n)}（AI 总结失败，已降级）`;
  else note.textContent = resultHeadline(r, n);

  paintResult(r, n);
  // 主进程已落库，这里刷新一下历史列表
  loadHistory();
}

/** 顶部提示语：按三种结果类型区分措辞，让用户一眼知道该"直接用"还是"挑一个" */
function resultHeadline(r, n) {
  if (!n) return '未找到相关任务';
  if (r.type === 'unique') return '已定位到最匹配的任务';
  if (r.exactHit) return `精确匹配到 ${n} 个任务`;
  return `未精确匹配，找到 ${n} 个可能相关的任务（请确认）`;
}

/** 回填一次检索结果（新检索与回看历史共用） */
function paintResult(r, n) {
  if (!rootEl) return;
  const summary = q('ai-search-summary');
  const results = q('ai-search-results');
  const input = q('ai-search-input');
  if (!summary || !results) return;
  if (input && r.keyword) input.value = r.keyword;
  if (r.summary) {
    summary.innerHTML = renderMarkdown(r.summary);
    summary.hidden = false;
  } else {
    summary.hidden = true;
    summary.innerHTML = '';
  }
  if (n === 0) {
    // 无关联：明确说明"确实没有"，并列出已尝试过的联想方向，避免用户以为系统没干活
    const tried = (r.tried || []).filter(Boolean);
    results.innerHTML = `<li class="sr-empty">
      <div class="sr-empty-title">没有找到与「${esc(r.keyword || '')}」相关的任务</div>
      ${tried.length
        ? `<div class="sr-empty-sub">已尝试的联想方向：</div>
           <ul class="sr-tried">${tried.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
        : ''}
    </li>`;
    return;
  }

  // 历史记录里存的是旧快照（没有 type 字段）：单条就按唯一匹配展示，避免"1 个候选"这种别扭措辞
  const isUnique = r.type === 'unique' || (!r.type && n === 1);
  const banner = `<li class="sr-banner sr-banner-${isUnique ? 'unique' : 'multi'}">
      ${isUnique
        ? '🎯 <b>唯一匹配</b>：置信度最高，可直接打开'
        : `🤔 <b>${n} 个候选</b>：未精确命中，按相关度排序，请确认哪一条才是你要找的`}
    </li>`;

  results.innerHTML = banner + r.tasks.map((t) => {
    const m = t.match || {};
    const reasons = (m.reasons || []).filter(Boolean);
    // AI 重排给的理由优先展示（更接近自然语言），本地依据作为补充
    const why = m.aiReason ? [m.aiReason, ...reasons.filter((x) => x !== m.aiReason)] : reasons;
    const conf = m.confidence || (m.score >= 55 ? 'high' : (m.score >= 20 ? 'mid' : 'low'));
    const confText = { high: '高相关', mid: '中等', low: '弱相关' }[conf] || '中等';
    const pct = Math.max(8, Math.min(100, Number(m.relevance) || 50));
    const whyHtml = why.length
      ? `<div class="sr-why">
          <span class="sr-conf sr-conf-${conf}">${confText}</span>
          <span class="sr-reasons">${esc(why.join('；'))}</span>
          <span class="sr-score" title="相关度 ${pct}%"><i style="width:${pct}%"></i></span>
        </div>`
      : '';
    return `<li class="search-result-item" data-id="${t.id}" title="点击查看详情">
      <div class="sr-row">
        <span class="sr-status">${t.completed ? '✅' : '⬜'}</span>
        <span class="sr-title">${esc(t.title)}</span>
        <span class="sr-meta">${t.group_name ? esc(t.group_name) : ''}${t.plan_end ? ' · ' + esc(t.plan_end) : ''}</span>
        <span class="sr-arrow">›</span>
      </div>
      ${whyHtml}
    </li>`;
  }).join('');
  results.querySelectorAll('.search-result-item').forEach((li) => {
    li.addEventListener('click', () => {
      const id = Number(li.dataset.id);
      // 先关弹窗再开详情：遮罩会压住抽屉，而且用户这时要看的是那一条任务
      if (closeFn) closeFn();
      handlers.openDetail(id);
    });
  });
}

/* ---------------- 历史记录 ---------------- */

async function loadHistory() {
  const box = q('ai-search-history');
  const count = q('ai-search-history-count');
  if (!box) return;
  const list = await api.search.history(50).catch(() => []);
  if (!rootEl || !box.isConnected) return; // 读历史期间窗已关
  if (count) count.textContent = list.length ? `${list.length} 条` : '';
  if (!list.length) {
    box.innerHTML = '<li class="subtask-empty">还没有检索记录</li>';
    return;
  }
  box.innerHTML = list
    .map((s) => `<li class="sh-item" data-id="${s.id}">
      <div class="sh-main">
        <div class="sh-kw">${esc(s.keyword)}</div>
        <div class="sh-sub">${esc(fmtTime(s.created_at))} · ${s.task_count} 个任务${s.degraded ? ' · 降级' : ''}</div>
      </div>
      <button type="button" class="sh-del" data-act="del" title="删除这条记录">🗑</button>
    </li>`)
    .join('');
}

function bindHistoryEvents() {
  const box = q('ai-search-history');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const item = e.target.closest('.sh-item');
    if (!item) return;
    const id = Number(item.dataset.id);
    if (e.target.closest('[data-act="del"]')) {
      await api.search.remove(id).catch(() => {});
      loadHistory();
      return;
    }
    const rec = await api.search.get(id).catch(() => null);
    if (!rec) { handlers.toast('读取这条记录失败'); return; }
    const note = q('ai-search-note');
    if (note) note.textContent = `回看历史：${fmtTime(rec.created_at)} · 找到 ${rec.tasks.length} 个相关任务`;
    paintResult(
      { keyword: rec.keyword, summary: rec.summary, tasks: rec.tasks || [] },
      (rec.tasks || []).length,
    );
  });
}
