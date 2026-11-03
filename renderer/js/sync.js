'use strict';
/**
 * 对外同步 →「导出到其它产品」弹窗。
 *
 * 目标：把本地数据导成第三方产品能直接吃下的通用格式，不依赖任何外部 API / 授权。
 *  - 任务 → CSV：可直接导入腾讯文档（智能表格 / 在线表格）；Markdown：可贴进腾讯文档或喂给 ima。
 *  - 笔记 → 每篇一个 .md 的压缩包：可直接批量上传到 ima 知识库；单文件合集适合整篇粘贴。
 *
 * 依赖注入 toast，不反向 import ui.js（ui.js 会绑定本模块，import 会成环，
 * 与 salary.js / meetings.js 同一套做法）。
 */
import { api } from './api.js';
import { openPanelModal } from './modal.js';
import { flattenGroupTree } from './group-tree.js';

let notify = () => {};
export function setSyncHandlers({ toast } = {}) {
  if (toast) notify = toast;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 只显示一次的弹窗：重复点击不叠第二层（同步面板与笔记独立导出面板互斥，同一时刻只留一个） */
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
    className: 'modal-sync modal-note-export',
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

export async function openSyncModal() {
  if (openMask && openMask.isConnected) return;
  const [groups, folders, tags] = await Promise.all([
    api.groups.list().catch(() => []),
    api.noteFolders.list().catch(() => []),
    api.noteTags.list().catch(() => []),
  ]);

  await openPanelModal({
    title: '导出到其它产品',
    className: 'modal-sync',
    html: syncHtml({ groups, folders, tags }),
    okText: '关闭',
    showClose: true,
    onMount: (mask) => { openMask = mask; bindSyncEvents(mask); },
    onClose: () => { openMask = null; },
  });
}

function syncHtml({ groups, folders, tags }) {
  const groupOpts = ['<option value="all">全部分组</option>']
    .concat(flattenGroupTree(groups, { respectExpansion: false })
      .map(({ g, depth }) => `<option value="${g.id}">${esc(`${depth ? `${'　'.repeat(depth)}└ ` : ''}${g.name}`)}</option>`));

  return `
    <div class="sync-wrap">
      <section class="sync-sec">
        <h4 class="sync-sec-title">任务导出</h4>
        <div class="sync-grid">
          <label class="sync-field">
            <span class="sync-label">格式</span>
            <select class="modal-input sync-task-format">
              <option value="csv">CSV（可直接导入腾讯文档表格）</option>
              <option value="md">Markdown 表格</option>
            </select>
          </label>
          <label class="sync-field">
            <span class="sync-label">范围</span>
            <select class="modal-input sync-task-status">
              <option value="all">未归档（进行中 + 已完成）</option>
              <option value="active">仅进行中</option>
              <option value="completed">仅已完成</option>
              <option value="any">全部（含已归档）</option>
            </select>
          </label>
          <label class="sync-field">
            <span class="sync-label">分组</span>
            <select class="modal-input sync-task-group">${groupOpts.join('')}</select>
          </label>
        </div>
        <label class="sync-check">
          <input type="checkbox" class="sync-task-subs" checked /> 包含子任务
        </label>
        <div class="sync-actions">
          <button type="button" class="primary-btn sync-btn-tasks">导出任务</button>
          <span class="sync-hint">CSV 导入腾讯文档：新建在线表格 → 导入数据；Markdown 可直接粘贴或作为文本素材。</span>
        </div>
      </section>

      ${noteSectionHtml({ folders, tags })}

      <p class="sync-foot">
        导出是单向的：生成文件后由目标产品导入，不会改动本地数据。若目标产品开放了写入 API，
        后续可以直接在这里接上自动同步。
      </p>
    </div>`;
}

/**
 * 「笔记导出」这一段要出现在两个地方：「☁ 同步」面板里的一节，
 * 以及笔记视图「导出」按钮单独拉起的面板 —— 所以 HTML 与事件绑定都拆成可复用的两段。
 * @param {{folders:Array, tags:Array, preset?:{folderId?:number|null, tagId?:number|null}}} opts
 */
function noteSectionHtml({ folders, tags, preset = {} } = { folders: [], tags: [] }) {
  const curFolder = preset.folderId == null ? '' : String(preset.folderId);
  const curTag = preset.tagId == null ? '' : String(preset.tagId);
  // 笔记目录是两层以内的树，按 parent 缩进即可（没有通用树工具，这里自己排一次）
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

function bindSyncEvents(mask) {
  bindTaskExport(mask);
  bindNoteExport(mask);
}

/** 任务导出按钮 */
function bindTaskExport(mask) {
  mask.querySelector('.sync-btn-tasks')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const opts = {
        format: mask.querySelector('.sync-task-format')?.value || 'csv',
        status: mask.querySelector('.sync-task-status')?.value || 'all',
        groupId: mask.querySelector('.sync-task-group')?.value || 'all',
        includeSubtasks: !!mask.querySelector('.sync-task-subs')?.checked,
      };
      const r = await api.sync.exportTasks(opts);
      if (r.canceled) return;
      if (!r.ok) {
        if (r.empty) notify('没有符合条件的任务');
        else notify('任务导出失败');
        return;
      }
      notify(`已导出 ${r.count} 条任务：${r.filePath}`);
    } catch (err) {
      notify(`任务导出失败：${(err && err.message) || err}`);
    } finally {
      btn.disabled = false;
    }
  });
}

/** 笔记导出按钮（同步面板与独立导出面板共用） */
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
