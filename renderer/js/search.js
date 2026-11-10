'use strict';
/**
 * AI 检索（弹窗）：输入关键词检索所有任务，AI 生成总结，结果以可点击链接展示。
 * 每次检索都会写进 ai_searches 表（关键词 + 总结 + 命中任务快照），
 * 左侧「检索历史」可回看、删除；关窗再开、重启都不丢。
 *
 * 为什么是弹窗而不是独立视图：检索是「随手查一下」的动作，
 * 不该把主列表（含筛选、选中任务）整页换掉。弹窗关掉就回到原视图，上下文零丢失。
 *
 * 约束：
 *  - 同一时刻只允许一个检索弹窗：两层 openPanelModal 会让一次 Esc 连关两层；
 *  - **只有显式点「关闭」/ ✕ 才关窗**（closeOnMask / closeOnEsc 都关掉）：检索要花 AI 额度、
 *    误点一下遮罩或按 Esc 就把结果弄丢，是用户明确反馈过的问题；
 *  - 所以点结果也不关窗 —— 详情抽屉的 z-index 低于弹窗遮罩，这里给它临时抬到遮罩之上
 *    （`is-over-modal`，closeDetail 会摘掉），看完一条还能接着看下一条；
 *  - 所有查询都走 rootEl 而不是 document，避免与页面里同名 id 撞车。
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

/** 当前弹窗根节点（关闭后置空，异步回来时不会往已销毁的 DOM 里写） */
let rootEl = null;
const q = (id) => (rootEl ? rootEl.querySelector(`#${id}`) : null);

/** 示例关键词：空态时的一键入口，比干等一个空白框更像「能用」 */
const SAMPLES = ['这周还没做完的', '和合同有关的', '下周要交的', '会议纪要'];

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 侧栏只有 210px：去掉年份，避免「2026-11-10 19:29 · 2 个任务」被截成省略号 */
function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function panelHtml(initialKeyword) {
  return `
    <div class="search-panel">
      <div class="search-hero">
        <div class="search-field">
          <span class="sf-ico" aria-hidden="true">🔍</span>
          <input id="ai-search-input" type="text" spellcheck="false" autocomplete="off"
                 placeholder="输入关键词，检索全部任务并由 AI 生成总结…"
                 value="${esc(initialKeyword)}" />
        </div>
        <button id="ai-search-btn" class="primary-btn">检索</button>
      </div>
      <div class="search-note" id="ai-search-note"></div>
      <div class="search-main">
        <aside class="search-side">
          <div class="sh-head">
            <span class="sh-title">检索历史</span>
            <span class="sh-count" id="ai-search-history-count"></span>
          </div>
          <ul class="sh-list" id="ai-search-history"><li class="sh-empty">加载中…</li></ul>
        </aside>
        <section class="search-stage">
          <div class="search-empty" id="ai-search-empty">
            <div class="se-ico" aria-hidden="true">✨</div>
            <div class="se-title">说说你要找什么</div>
            <div class="se-sub">任务标题、备注内容、分组都能命中；配置了 AI Key 还会给出语义总结与相关度排序</div>
            <div class="se-chips">
              ${SAMPLES.map((k) => `<button type="button" class="se-chip">${esc(k)}</button>`).join('')}
            </div>
          </div>
          <div class="search-summary markdown-body" id="ai-search-summary" hidden></div>
          <ul class="search-results" id="ai-search-results"></ul>
        </section>
      </div>
    </div>`;
}

/** 空态占位：一开始填满右半边，出结果后让位（否则弹窗里会是一大片白） */
function setPlaceholder(on) {
  const el = q('ai-search-empty');
  if (el) el.hidden = !on;
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
    title: 'AI 检索',
    className: 'modal-search',
    showClose: true,
    okText: '关闭',
    resizable: true,
    resizeKey: 'ai-search',
    minWidth: 620,
    minHeight: 420,
    // 只有显式按钮才关：遮罩误点 / Esc 都不许把检索结果弄丢
    closeOnMask: false,
    closeOnEsc: false,
    html: panelHtml(initialKeyword),
    onMount: (root) => {
      rootEl = root;
      const input = q('ai-search-input');
      const btn = q('ai-search-btn');
      const run = () => doSearch(input.value.trim());
      btn.addEventListener('click', run);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); run(); }
      });
      root.querySelectorAll('.se-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          input.value = chip.textContent.trim();
          run();
        });
      });
      // 底部左侧说明：「不关就是能关」这件事得写出来，否则用户按 Esc 会以为卡住了
      const foot = root.querySelector('.modal-foot');
      if (foot) {
        const hint = document.createElement('span');
        hint.className = 'search-foot-hint';
        hint.textContent = '结果会存进检索历史 · 只有点「关闭」或 ✕ 才退出';
        foot.prepend(hint);
      }
      input.focus();
      // 关键词从顶栏带过来时把光标放到末尾，直接回车即可检索
      if (initialKeyword) input.setSelectionRange(input.value.length, input.value.length);
      bindHistoryEvents();
      loadHistory();
    },
    onClose: () => { rootEl = null; },
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
  setPlaceholder(false);
  note.textContent = '检索中…';
  summary.hidden = true;
  summary.innerHTML = '';
  results.innerHTML = '<li class="sr-loading"><i></i>正在检索并生成总结…</li>';
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
  if (!r.ok) {
    note.textContent = r.message || '检索失败';
    results.innerHTML = '';
    return;
  }

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
  setPlaceholder(false);
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
  // 「精确命中」和「未精确命中」别自相矛盾：上方提示语说的是 exactHit，这里也得跟着走
  const bannerCls = isUnique || r.exactHit ? 'unique' : 'multi';
  const bannerText = isUnique
    ? '🎯 <b>唯一匹配</b>：置信度最高，可直接打开'
    : (r.exactHit
      ? `🎯 <b>${n} 条精确命中</b>：关键词直接命中标题或备注，按相关度排序`
      : `🤔 <b>${n} 个候选</b>：未精确命中，按相关度排序，请确认哪一条才是你要找的`);
  const banner = `<li class="sr-banner sr-banner-${bannerCls}">${bannerText}</li>`;

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
        ${(t.group_name || t.plan_end)
          ? `<span class="sr-meta">${t.group_name ? esc(t.group_name) : ''}${t.plan_end ? (t.group_name ? ' · ' : '') + esc(t.plan_end) : ''}</span>`
          : ''}
        <span class="sr-arrow">›</span>
      </div>
      ${whyHtml}
    </li>`;
  }).join('');
  results.querySelectorAll('.search-result-item').forEach((li) => {
    li.addEventListener('click', () => {
      const id = Number(li.dataset.id);
      // 不关弹窗（用户明确要求只有点「关闭」才退出）。详情抽屉的 z-index(150) 低于
      // 弹窗遮罩(300)，这里临时抬到遮罩之上；closeDetail() 会把这个类摘掉。
      const drawer = document.getElementById('detail-drawer');
      if (drawer) drawer.classList.add('is-over-modal');
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
    box.innerHTML = '<li class="sh-empty">还没有检索记录<br>搜过的关键词会留在这里，方便回看</li>';
    return;
  }
  box.innerHTML = list
    .map((s) => `<li class="sh-item" data-id="${s.id}" title="${esc(s.keyword)}">
      <div class="sh-main">
        <div class="sh-kw">${esc(s.keyword)}</div>
        <div class="sh-sub">${esc(shortTime(s.created_at))} · ${s.task_count} 个任务${s.degraded ? ' · 降级' : ''}</div>
      </div>
      <button type="button" class="sh-del" data-act="del" title="删除这条记录">✕</button>
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
