'use strict';
/**
 * AI 检索视图：输入关键词检索所有任务，AI 生成总结，结果以可点击链接展示。
 */
import { api } from './api.js';
import { renderMarkdown } from './markdown.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let handlers = { openDetail: () => {}, toast: () => {} };
export function setSearchHandlers(h) { handlers = { ...handlers, ...h }; }

export function renderSearch() {
  const viewEl = document.getElementById('view');
  viewEl.innerHTML = `
    <div class="search-panel">
      <div class="search-hero">
        <input id="ai-search-input" type="text" placeholder="输入关键词，检索任务并由 AI 生成总结…" />
        <button id="ai-search-btn" class="primary-btn">🤖 AI 检索</button>
      </div>
      <div class="search-note" id="ai-search-note"></div>
      <div class="search-summary markdown-body" id="ai-search-summary" hidden></div>
      <ul class="search-results" id="ai-search-results"></ul>
    </div>`;

  const input = viewEl.querySelector('#ai-search-input');
  const btn = viewEl.querySelector('#ai-search-btn');
  const run = () => doSearch(input.value.trim());
  btn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  input.focus();
}

async function doSearch(keyword) {
  if (!keyword) { handlers.toast('请输入检索关键词'); return; }
  const note = document.getElementById('ai-search-note');
  const summary = document.getElementById('ai-search-summary');
  const results = document.getElementById('ai-search-results');
  note.textContent = '检索中…';
  summary.hidden = true;
  results.innerHTML = '';

  const r = await api.search.ai(keyword);
  if (!r.ok) { note.textContent = r.message || '检索失败'; return; }

  const n = r.tasks.length;
  if (!r.hasKey) note.textContent = `找到 ${n} 个相关任务（未配置 AI Key，无法生成总结，请在「AI 报告」页配置）`;
  else if (r.degraded) note.textContent = `找到 ${n} 个相关任务（AI 总结失败，已降级）`;
  else note.textContent = `找到 ${n} 个相关任务`;

  if (r.summary) {
    summary.innerHTML = renderMarkdown(r.summary);
    summary.hidden = false;
  }

  if (n === 0) {
    results.innerHTML = '<li class="subtask-empty">没有匹配的任务</li>';
    return;
  }
  results.innerHTML = r.tasks
    .map(
      (t) => `<li class="search-result-item" data-id="${t.id}" title="点击查看详情">
        <span class="sr-status">${t.completed ? '✅' : '⬜'}</span>
        <span class="sr-title">${esc(t.title)}</span>
        <span class="sr-meta">${t.group_name ? esc(t.group_name) : ''}${t.plan_end ? ' · ' + esc(t.plan_end) : ''}</span>
        <span class="sr-arrow">›</span>
      </li>`
    )
    .join('');
  results.querySelectorAll('.search-result-item').forEach((li) => {
    li.addEventListener('click', () => handlers.openDetail(Number(li.dataset.id)));
  });
}
