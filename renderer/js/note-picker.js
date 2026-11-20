'use strict';
/**
 * 笔记选择器：任务详情里「关联笔记」用的多选面板。
 *
 * 与任务模块的交互保持一致：搜索框防抖、列表可滚动、已选项打勾、底部一次提交（覆盖式写入）。
 * 面板里也能顺手新建一篇笔记并直接勾上——不必为了引用先绕去笔记视图。
 * 支持按「目录」筛选（含目录树层级），筛选与搜索可组合；已勾选项跨筛选始终保留。
 */
import { api, fmtDateTime } from './api.js';
import { openPanelModal } from './modal.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 目录扁平化（带层级缩进），与笔记视图同一套 parent_id 排序逻辑 */
function flattenFolders(list) {
  const byParent = new Map();
  for (const f of list || []) {
    const p = f.parent_id == null ? null : f.parent_id;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(f);
  }
  const out = [];
  const walk = (parent, depth) => {
    const children = (byParent.get(parent) || []).slice()
      .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
    for (const c of children) {
      out.push({ ...c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

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
        <select class="modal-select" data-np="folder" title="按目录筛选笔记">
          <option value="all">全部目录</option>
          <option value="0">未分类</option>
        </select>
        <button class="np-create-btn" data-np="create">＋ 新建并关联</button>
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
      const folderEl = mask.querySelector('[data-np="folder"]');
      let timer = null;

      // 目录下拉：异步填一次（选项来自 noteFolders:list，与笔记视图同源）
      (async () => {
        const folders = await api.noteFolders.list().catch(() => []);
        if (!folderEl.isConnected) return;
        folderEl.insertAdjacentHTML('beforeend', flattenFolders(folders)
          .map((f) => `<option value="${f.id}">${'　'.repeat(f.depth || 0)}${esc(f.name)}</option>`)
          .join(''));
      })();

      const paint = async (keyword = '') => {
        const folderVal = folderEl.value || 'all';
        const kw = keyword.trim().toLowerCase();
        let rows;
        if (folderVal === 'all') {
          // 无目录筛选：保持原行为（有词走全文检索，无词列全部）
          rows = kw
            ? await api.notes.search(keyword, { limit: 60 }).catch(() => [])
            : await api.notes.list({ limit: 200, archived: 'exclude' }).catch(() => []);
        } else {
          // 有目录筛选：按目录（含子目录 / 未分类=0）取，再按关键词在前端过滤。
          // searchNotes 不支持 folderId，跨桥改 DB 风险大；目录内笔记量有限，前端过滤足够。
          const folderId = folderVal === '0' ? 0 : Number(folderVal);
          rows = await api.notes.list({
            folderId, includeSubfolders: true, limit: 200, archived: 'exclude',
          }).catch(() => []);
          if (kw) {
            rows = rows.filter((n) => String(n.title || '').toLowerCase().includes(kw)
              || String(n.excerpt || '').toLowerCase().includes(kw));
          }
        }
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

      folderEl.addEventListener('change', () => { paint(qEl.value.trim()); });

      mask.querySelector('[data-np="create"]').addEventListener('click', async () => {
        const title = (qEl.value || '').trim() || '未命名笔记';
        const note = await api.notes.create({ title });
        picked.add(note.id);
        qEl.value = '';
        // 新建的笔记落在「未分类」；若当前正按某目录筛选，就给它归到该目录，
        // 否则新建完会从筛选结果里消失，用户以为没建成。
        const folderVal = folderEl.value || 'all';
        if (folderVal !== 'all' && folderVal !== '0' && note && note.id) {
          await api.notes.update(note.id, { folder_id: Number(folderVal) }).catch(() => {});
        }
        await paint('');
      });

      paint('');
    },
  });
  return result;
}
