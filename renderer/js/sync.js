'use strict';
/**
 * 笔记导出面板：笔记视图工具栏「📤 导出」拉起的筛选面板。
 * 产出图片 base64 内嵌的自包含 .md（单篇）/ 每篇一个 .md 的压缩包（多篇）。
 * 打开的单篇笔记右栏「⬇ 导出」不经过这里，notes.js 直接调 api.sync.exportNotes({ noteId })。
 *
 * 「File → 同步到腾讯文档 / ima…」与任务 CSV / Markdown 表格导出已撤掉，本模块不再有同步面板。
 * 依赖注入 toast，不反向 import ui.js（ui.js 会绑定本模块，import 会成环）。
 */
import { api } from './api.js';
import { openPanelModal } from './modal.js';

let notify = () => {};
export function setNoteExportHandlers({ toast } = {}) {
  if (toast) notify = toast;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 只显示一次的弹窗：重复点击不叠第二层 */
let openMask = null;

/**
 * 独立入口：只导出笔记（笔记视图顶部工具栏的「导出」，与「导入」并列）。
 * 目录 / 标签按调用方当前筛选预置 —— 正在看「工作」目录就默认导「工作」，不必再选一遍。
 * @param {{folderId?:number|null, tagId?:number|null}} [preset]
 */
export async function openNoteExportModal(preset = {}) {
  if (openMask && openMask.isConnected) return;
  const [folders, tags] = await Promise.all([
    api.noteFolders.list().catch(() => []),
    api.noteTags.list().catch(() => []),
  ]);
  await openPanelModal({
    title: '批量导出笔记',
    className: 'modal-note-export',
    html: `<div class="sync-wrap">${noteSectionHtml({ folders, tags, preset })}
      <p class="sync-foot">导出的 .md 保留正文与格式，图片以 base64 直接嵌在 Markdown 里（不额外附带图片文件），
      换台电脑或直接发给别人打开都能正常显示。</p>
    </div>`,
    okText: '关闭',
    showClose: true,
    onMount: (mask) => { openMask = mask; bindNoteExport(mask); },
    onClose: () => { openMask = null; },
  });
}

/** 笔记导出的筛选表单（目录是两层以内的树，按 parent 缩进即可） */
function noteSectionHtml({ folders, tags, preset = {} } = { folders: [], tags: [] }) {
  const curFolder = preset.folderId == null ? '' : String(preset.folderId);
  const curTag = preset.tagId == null ? '' : String(preset.tagId);
  const folderOpts = [`<option value=""${curFolder ? '' : ' selected'}>全部目录</option>`]
    .concat(treeFolders(folders).map(({ f, depth }) =>
      `<option value="${f.id}"${curFolder === String(f.id) ? ' selected' : ''}>${esc(`${depth ? `${'　'.repeat(depth)}└ ` : ''}${f.name}`)}</option>`));
  const tagOpts = [`<option value=""${curTag ? '' : ' selected'}>全部标签</option>`]
    .concat(tags.map((t) => `<option value="${t.id}"${curTag === String(t.id) ? ' selected' : ''}>${esc(t.name)}</option>`));

  return `
      <section class="sync-sec">
        <h4 class="sync-sec-title">笔记导出</h4>
        <div class="sync-grid">
          <label class="sync-field">
            <span class="sync-label">打包方式</span>
            <select class="modal-input sync-note-pack">
              <option value="single" selected>单个 Markdown（.md，图片内嵌）</option>
              <option value="zip">每篇一个 .md（压缩包）</option>
            </select>
          </label>
          <label class="sync-field">
            <span class="sync-label">目录</span>
            <select class="modal-input sync-note-folder">${folderOpts.join('')}</select>
          </label>
          <label class="sync-field">
            <span class="sync-label">标签</span>
            <select class="modal-input sync-note-tag">${tagOpts.join('')}</select>
          </label>
        </div>
        <label class="sync-check">
          <input type="checkbox" class="sync-note-archived" /> 包含已归档笔记
        </label>
        <div class="sync-actions">
          <button type="button" class="primary-btn sync-btn-notes">导出笔记</button>
          <span class="sync-hint">只筛到一篇时直接导出为这篇的 .md；图片以 base64 内嵌，单个文件即可分享。</span>
        </div>
      </section>`;
}

/** 扁平目录 → 树形顺序（父在前、子紧随） */
function treeFolders(folders) {
  const out = [];
  const walk = (pid, depth) => {
    folders
      .filter((f) => (f.parent_id == null ? null : f.parent_id) === pid)
      .forEach((f) => {
        out.push({ f, depth });
        walk(f.id, depth + 1);
      });
  };
  walk(null, 0);
  return out;
}

/** 导出按钮：与主进程 sync:exportNotes 对齐，保存对话框由主进程弹出 */
function bindNoteExport(mask) {
  mask.querySelector('.sync-btn-notes')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const folderId = mask.querySelector('.sync-note-folder')?.value || '';
      const tagId = mask.querySelector('.sync-note-tag')?.value || '';
      const opts = {
        pack: mask.querySelector('.sync-note-pack')?.value || 'zip',
        includeArchived: !!mask.querySelector('.sync-note-archived')?.checked,
      };
      if (folderId) opts.folderId = Number(folderId);
      if (tagId) opts.tagId = Number(tagId);
      const r = await api.sync.exportNotes(opts);
      if (r.canceled) return;
      if (!r.ok) {
        if (r.empty) notify('没有符合条件的笔记');
        else notify('笔记导出失败');
        return;
      }
      notify(`已导出 ${r.count} 篇笔记：${r.filePath}`);
    } catch (err) {
      notify(`笔记导出失败：${(err && err.message) || err}`);
    } finally {
      btn.disabled = false;
    }
  });
}
