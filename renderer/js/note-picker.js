'use strict';
/**
 * 笔记选择器：任务详情里「关联笔记」用的多选面板。
 *
 * 与任务模块的交互保持一致：搜索框防抖、列表可滚动、已选项打勾、底部一次提交（覆盖式写入）。
 * 面板里也能顺手新建一篇笔记并直接勾上——不必为了引用先绕去笔记视图。
 */
import { api, fmtDateTime } from './api.js';
import { openPanelModal } from './modal.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * @param {object} opts
 * @param {number} opts.taskId 当前任务（用于预读已关联项）
 * @returns {Promise<{ok:boolean, noteIds:number[]}>} 取消时 ok=false
 */
export async function openNotePicker({ taskId } = {}) {
  let picked = new Set();
  try {
    const linked = await api.taskNotes.list(taskId);
    picked = new Set(linked.map((n) => n.id));
  } catch (e) { /* 读不到就当没有已选项 */ }

  let result = { ok: false, noteIds: [] };
  await openPanelModal({
    title: '关联笔记',
    className: 'modal-note-picker',
    html: `
      <div class="np-picker-form">
        <input class="modal-input" data-np="q" placeholder="搜索笔记标题 / 正文（留空显示全部）" />
        <button class="ghost-btn" data-np="create">＋ 新建并关联</button>
      </div>
      <div class="np-picker-count" data-np="count"></div>
      <ul class="np-picker-list" data-np="list"><li class="np-picker-empty">加载中…</li></ul>`,
    okText: '保存关联',
    onSubmit: async () => {
      await api.taskNotes.set(taskId, [...picked]);
      result = { ok: true, noteIds: [...picked] };
      return undefined;
    },
    onMount: (mask) => {
      const listEl = mask.querySelector('[data-np="list"]');
      const countEl = mask.querySelector('[data-np="count"]');
      const qEl = mask.querySelector('[data-np="q"]');
      let timer = null;

      const paint = async (keyword = '') => {
        const rows = keyword
          ? await api.notes.search(keyword, { limit: 60 }).catch(() => [])
          : await api.notes.list({ limit: 200, archived: 'exclude' }).catch(() => []);
        countEl.textContent = `已选 ${picked.size} 篇 · 可选 ${rows.length} 篇`;
        if (!rows.length) {
          listEl.innerHTML = '<li class="np-picker-empty">没有匹配的笔记</li>';
          return;
        }
        listEl.innerHTML = rows.map((n) => `
          <li class="np-picker-item${picked.has(n.id) ? ' checked' : ''}" data-np-id="${n.id}">
            <button class="np-pick-check" data-np-act="toggle" data-id="${n.id}" aria-pressed="${picked.has(n.id)}"
                    title="${picked.has(n.id) ? '取消关联' : '关联这篇笔记'}">${picked.has(n.id) ? '✓' : ''}</button>
            <div class="np-pick-main">
              <div class="np-pick-title">${esc(n.title || '未命名笔记')}</div>
              <div class="np-pick-sub">${esc((n.tags || []).map((t) => t.name).join(' / ')) || '无标签'} · ${fmtDateTime(n.updated_at)} · ${n.word_count || 0} 字</div>
            </div>
          </li>`).join('');
      };

      listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-np-act="toggle"]');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        if (picked.has(id)) picked.delete(id); else picked.add(id);
        const li = btn.closest('.np-picker-item');
        if (li) li.classList.toggle('checked', picked.has(id));
        btn.textContent = picked.has(id) ? '✓' : '';
        btn.setAttribute('aria-pressed', String(picked.has(id)));
        countEl.textContent = countEl.textContent.replace(/已选 \d+ 篇/, `已选 ${picked.size} 篇`);
      });

      qEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => paint(qEl.value.trim()), 250);
      });

      mask.querySelector('[data-np="create"]').addEventListener('click', async () => {
        const title = (qEl.value || '').trim() || '未命名笔记';
        const note = await api.notes.create({ title });
        picked.add(note.id);
        qEl.value = '';
        await paint('');
      });

      paint('');
    },
  });
  return result;
}
