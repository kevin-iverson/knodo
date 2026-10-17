'use strict';
/**
 * 任务详情页（右侧抽屉）：基础信息编辑、树形子任务层级（可拖拽排序）、
 * 所见即所得 Markdown 描述（支持快捷键与粘贴图片，图片直接插入光标处）。
 */
import { api, PRIORITY_TEXT } from './api.js';
import { state, loadGroups, loadTags, refreshAll } from './store.js';
import { renderMarkdown } from './markdown.js';
import {
  dateRangeFieldHtml, bindDateRangeFields, getDateRange,
  reminderHtml, bindReminder, computeReminder, reminderNeedsPlanEnd,
} from './controls.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let handlers = { refresh: () => {}, toast: () => {} };
export function setDetailHandlers(h) { handlers = { ...handlers, ...h }; }

export function openDetail(id) {
  state.detailTaskId = id;
  renderDetail();
}

export function closeDetail() {
  state.detailTaskId = null;
  const drawer = document.getElementById('detail-drawer');
  if (drawer) drawer.hidden = true;
}

export function isDetailOpen() {
  return state.detailTaskId != null;
}

/** 描述内容 → HTML（兼容旧 Markdown 数据与新所见即所得 HTML） */
function notesToHtml(notes) {
  if (!notes) return '';
  if (/<\/?[a-z][^>]*>/i.test(notes)) return notes;
  return renderMarkdown(notes);
}

async function resolveTagIds(namesStr) {
  const names = namesStr.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  const ids = [];
  for (const n of names) {
    const existing = state.tags.find((t) => t.name === n);
    if (existing) ids.push(existing.id);
    else {
      const created = await api.tags.create(n);
      ids.push(created.id);
    }
  }
  return ids;
}

function groupOptionsHtml(selectedId) {
  const opts = ['<option value="">无分组</option>'];
  for (const g of state.groups) {
    opts.push(`<option value="${g.id}"${selectedId === g.id ? ' selected' : ''}>${esc(g.name)}</option>`);
  }
  return opts.join('');
}

function priorityOptionsHtml(selected) {
  const sel = selected == null ? 1 : selected;
  return [0, 1, 2, 3]
    .map((p) => `<option value="${p}"${p === sel ? ' selected' : ''}>${PRIORITY_TEXT[p]}</option>`)
    .join('');
}

async function renderDetail() {
  const drawer = document.getElementById('detail-drawer');
  if (!drawer) return;
  const id = state.detailTaskId;
  if (id == null) { drawer.hidden = true; return; }

  const task = await api.tasks.get(id);
  if (!task) { drawer.hidden = true; state.detailTaskId = null; return; }
  await loadGroups();
  await loadTags();

  const subtreeHtml = await renderSubtreeHtml(id);
  const parentInfo = task.parent_id
    ? `<div class="detail-parent" data-act="goto-parent" data-parent="${task.parent_id}">↳ 所属父任务：${esc(task.parent_title || '未知')}</div>`
    : '';

  drawer.innerHTML = `
    <div class="detail-mask" data-act="close"></div>
    <div class="detail-panel">
      <div class="detail-head">
        <button class="detail-check${task.completed ? ' done' : ''}" data-act="toggle" title="完成/取消">${task.completed ? '✓' : ''}</button>
        <input class="detail-title" placeholder="任务标题" value="${esc(task.title)}" />
        <button class="detail-close" data-act="close" title="关闭">×</button>
      </div>
      <div class="detail-body">
        ${parentInfo}
        <div class="detail-row">
          <label class="detail-field">优先级
            <select class="detail-priority">${priorityOptionsHtml(task.priority)}</select>
          </label>
          <label class="detail-field">分组
            <select class="detail-group">${groupOptionsHtml(task.group_id)}</select>
          </label>
        </div>
        <div class="detail-row">
          ${dateRangeFieldHtml(task.plan_start, task.plan_end)}
        </div>
        <div class="detail-row">
          ${reminderHtml(task.reminder_at, task.plan_end)}
          <label class="detail-field grow">标签（逗号分隔）
            <input class="detail-tags" placeholder="如：项目A, 紧急" value="${esc((task.tag_names || []).join(', '))}" />
          </label>
        </div>

        <div class="detail-section">
          <div class="detail-section-head"><span>子任务</span></div>
          ${subtreeHtml || '<div class="subtask-empty">暂无子任务</div>'}
          <div class="subtask-add">
            <input class="subtask-input" placeholder="添加子任务，回车保存" />
          </div>
        </div>

        <div class="detail-section">
          <div class="detail-section-head"><span>描述</span></div>
          <div class="detail-notes-editor markdown-body" contenteditable="true"
               data-placeholder="支持 Markdown 快捷键（Ctrl+B 加粗 / Ctrl+I 斜体），可直接粘贴图片…"></div>
        </div>
      </div>
      <div class="detail-foot">
        <button class="danger-btn" data-act="delete">删除</button>
        <button class="ghost-btn" data-act="archive">${task.archived ? '取消归档' : '归档'}</button>
        <span class="spacer"></span>
        <button class="primary-btn" data-act="save">保存</button>
      </div>
    </div>`;

  drawer.hidden = false;
  bindDateRangeFields(drawer);
  bindReminder(drawer);
  bindDetailEvents(drawer, task);
}

/** 递归渲染子任务树（嵌套 <ul>，支持拖拽排序） */
async function renderSubtreeHtml(parentId) {
  const subs = await api.tasks.subtasks(parentId);
  if (!subs.length) return '';
  let html = '<ul class="subtree">';
  for (const s of subs) {
    html += `<li class="subtask-item${s.completed ? ' done' : ''}" data-id="${s.id}" draggable="true">
      <button class="subtask-check" data-act="subtask-toggle">${s.completed ? '✓' : ''}</button>
      <span class="subtask-title">${esc(s.title)}</span>
      ${s.subtask_count > 0 ? `<span class="subtask-badge">${s.subtask_done}/${s.subtask_count}</span>` : ''}
      <button class="subtask-del" data-act="subtask-del" title="删除">×</button>
    </li>`;
    html += await renderSubtreeHtml(s.id);
  }
  html += '</ul>';
  return html;
}

function bindDetailEvents(drawer, task) {
  drawer.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', closeDetail));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDetailOpen()) closeDetail();
  }, { once: true });

  const parentEl = drawer.querySelector('[data-act="goto-parent"]');
  if (parentEl) {
    parentEl.addEventListener('click', () => openDetail(Number(parentEl.dataset.parent)));
  }

  drawer.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
    await api.tasks.toggle(task.id);
    await refreshAll();
    handlers.refresh();
    renderDetail();
  });

  drawer.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    if (!confirm('确定删除该任务及其所有子任务吗？此操作不可恢复。')) return;
    await api.tasks.remove(task.id);
    closeDetail();
    handlers.toast('任务已删除');
    await refreshAll();
    handlers.refresh();
  });
  drawer.querySelector('[data-act="archive"]').addEventListener('click', async () => {
    if (task.archived) await api.tasks.unarchive(task.id);
    else await api.tasks.archive(task.id);
    handlers.toast(task.archived ? '已取消归档' : '已归档');
    await refreshAll();
    handlers.refresh();
    renderDetail();
  });

  drawer.querySelector('[data-act="save"]').addEventListener('click', () => saveDetail(drawer, task));

  // 所见即所得描述：粘贴图片插入光标处
  const editor = drawer.querySelector('.detail-notes-editor');
  editor.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => insertImageAtCursor(reader.result);
        reader.readAsDataURL(file);
      }
    }
  });

  // 子任务：添加
  const subtaskInput = drawer.querySelector('.subtask-input');
  subtaskInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && subtaskInput.value.trim()) {
      const title = subtaskInput.value.trim();
      subtaskInput.value = '';
      await api.tasks.create({ title, parentId: task.id, groupId: task.group_id });
      handlers.toast('已添加子任务');
      renderDetail();
    }
  });

  // 子任务：勾选 / 删除
  drawer.querySelectorAll('.subtask-item').forEach((li) => {
    const sid = Number(li.dataset.id);
    li.querySelector('[data-act="subtask-toggle"]').addEventListener('click', async () => {
      await api.tasks.toggle(sid);
      renderDetail();
    });
    li.querySelector('[data-act="subtask-del"]').addEventListener('click', async () => {
      await api.tasks.remove(sid);
      renderDetail();
    });
  });
  bindSubtaskDrag(drawer);
}

/** 图片插入到所见即所得编辑器光标处 */
function insertImageAtCursor(dataUrl) {
  const sel = window.getSelection();
  const editor = document.querySelector('.detail-notes-editor');
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    const img = document.createElement('img');
    img.src = dataUrl;
    img.className = 'notes-img';
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editor.focus();
    document.execCommand('insertImage', false, dataUrl);
  }
}

/** 子任务拖拽排序（同一父级内重排） */
function bindSubtaskDrag(container) {
  container.querySelectorAll('.subtree').forEach((ul) => {
    ul.querySelectorAll(':scope > li').forEach((li) => {
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', li.dataset.id);
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        ul.querySelectorAll(':scope > li.drag-over').forEach((x) => x.classList.remove('drag-over'));
      });
      li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
      li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
      li.addEventListener('drop', async (e) => {
        e.preventDefault();
        const fromId = Number(e.dataTransfer.getData('text/plain'));
        const items = Array.from(ul.querySelectorAll(':scope > li'));
        const ids = items.map((x) => Number(x.dataset.id));
        const fromIdx = ids.indexOf(fromId);
        const toIdx = ids.indexOf(Number(li.dataset.id));
        if (fromIdx > -1 && toIdx > -1 && fromIdx !== toIdx) {
          ids.splice(toIdx, 0, ...ids.splice(fromIdx, 1));
          await api.tasks.reorder(ids);
          renderDetail();
        }
      });
    });
  });
}

async function saveDetail(drawer, task) {
  const title = drawer.querySelector('.detail-title').value.trim();
  if (!title) { handlers.toast('请输入任务标题'); return; }

  const { planStart, planEnd } = getDateRange(drawer);
  if (reminderNeedsPlanEnd(drawer) && !planEnd) {
    handlers.toast('请先设置完成日期，再选择提醒时间');
    return;
  }

  const editor = drawer.querySelector('.detail-notes-editor');
  const notes = (editor.textContent.trim() || editor.querySelector('img')) ? editor.innerHTML : '';

  const payload = {
    title,
    priority: Number(drawer.querySelector('.detail-priority').value),
    groupId: drawer.querySelector('.detail-group').value ? Number(drawer.querySelector('.detail-group').value) : null,
    planStart,
    planEnd,
    reminderAt: computeReminder(drawer, planEnd),
    notes,
  };
  const tagIds = await resolveTagIds(drawer.querySelector('.detail-tags').value);
  await api.tasks.update(task.id, { ...payload, tagIds });
  handlers.toast('已保存');
  await refreshAll();
  handlers.refresh();
  renderDetail();
}
