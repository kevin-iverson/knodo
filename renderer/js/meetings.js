'use strict';
/**
 * 会议视图：录制完之后的所有动作都在这里完成——
 * 语音转写 → 生成纪要 → 勾选待办写进任务列表 → 导出 Word / Markdown。
 *
 * 依赖注入（toast / refresh）而不是直接 import ui.js：ui.js 会 import 本模块的 renderMeetings，
 * 反向依赖会形成环。项目里 recorder.js / ai-settings.js 已是同一套做法。
 */
import { api } from './api.js';
import { state } from './store.js';
import { renderMarkdown } from './markdown.js';
import { groupOptionsHtml } from './group-tree.js';
import { openRecorder } from './recorder.js';
import { openPanelModal } from './modal.js';

let notify = () => {};
let onChanged = () => {};

export function setMeetingsHandlers({ toast, refresh } = {}) {
  if (toast) notify = toast;
  if (refresh) onChanged = refresh;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const pad = (n) => String(n).padStart(2, '0');

const STATUS_TEXT = {
  recorded: { label: '已录制', cls: 'st-gray' },
  transcribed: { label: '已转写', cls: 'st-blue' },
  'transcribed-partial': { label: '转写不完整', cls: 'st-amber' },
  summarized: { label: '已出纪要', cls: 'st-green' },
};
const PRIORITY_TEXT = ['低', '中', '高', '紧急'];

// 视图内局部状态：当前选中会议、当前标签页、正在跑的任务
let selectedId = null;
let activeTab = 'summary';
const running = new Set();
let lastList = [];
// #view 是持久节点，事件只需委托一次；每次重绘都 addEventListener 会让一次点击触发多次
let boundRoot = null;

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m} 分 ${pad(s)} 秒`;
  return `${Math.floor(m / 60)} 时 ${pad(m % 60)} 分`;
}

function fileSizeText(paths) {
  const n = (paths || []).length;
  if (!n) return '无音频';
  return `${n} 个分片`;
}

/* ------------------------------ 渲染 ------------------------------ */

export async function renderMeetings(containerSelector = '#view') {
  const container = typeof containerSelector === 'string'
    ? document.querySelector(containerSelector)
    : containerSelector;
  if (!container) return;
  lastList = await api.meeting.list().catch(() => []);
  if (selectedId && !lastList.some((m) => m.id === selectedId)) selectedId = null;
  if (!selectedId && lastList.length) selectedId = lastList[0].id;
  const current = lastList.find((m) => m.id === selectedId) || null;

  container.innerHTML = `
    <div class="mt-wrap">
      <div class="mt-toolbar">
        <button class="primary-btn" data-mt="record">⏺ 新录制</button>
        <button class="ghost-btn" data-mt="import">📁 导入录音</button>
        <button class="ghost-btn" data-mt="refresh">🔄 刷新</button>
        <button class="ghost-btn" data-mt="history">🕘 历史记录</button>
        <span class="mt-count">共 ${lastList.length} 条会议记录</span>
      </div>
      <div class="mt-layout">
        <ul class="mt-list">
          ${lastList.length ? '' : '<li class="mt-empty">还没有会议记录，点「⏺ 新录制」开始，或直接导入一段录音。</li>'}
          ${lastList.map((m) => {
    const st = STATUS_TEXT[m.status] || STATUS_TEXT.recorded;
    return `
            <li class="mt-item${m.id === selectedId ? ' active' : ''}" data-mt="select" data-id="${m.id}">
              <div class="mt-item-head">
                <span class="mt-item-title">${esc(m.title)}</span>
                <span class="mt-badge ${st.cls}">${st.label}</span>
              </div>
              <div class="mt-item-meta">
                <span>${fmtTime(m.started_at)}</span>
                <span>${fmtDuration(m.duration_ms)}</span>
                <span>${m.mode === 'screen' ? '屏幕 + 音频' : '仅音频'}</span>
                <span>${fileSizeText(m.media_paths)}</span>
              </div>
            </li>`;
  }).join('')}
        </ul>
        <div class="mt-detail">${current ? renderDetail(current) : '<div class="mt-empty">左侧选择一条会议记录</div>'}</div>
      </div>
    </div>`;

  bindEvents(container);
}

function renderDetail(m) {
  const st = STATUS_TEXT[m.status] || STATUS_TEXT.recorded;
  const tabs = [
    ['summary', '纪要'],
    ['todos', `待办${(m.todos || []).length ? ` (${m.todos.length})` : ''}`],
    ['transcript', '转写原文'],
  ];
  const busy = (k) => running.has(`${m.id}:${k}`);

  return `
    <div class="mt-detail-head">
      <div>
        <div class="mt-detail-title">${esc(m.title)}</div>
        <div class="mt-detail-sub">${fmtTime(m.started_at)} · ${fmtDuration(m.duration_ms)} · ${m.mode === 'screen' ? '屏幕 + 音频' : '仅音频'}${m.source_label ? ' · ' + esc(m.source_label) : ''}</div>
      </div>
      <div class="mt-actions">
        <button class="ghost-btn tiny" data-mt="rename" data-id="${m.id}">✎ 重命名</button>
        <button class="ghost-btn tiny" data-mt="open-file" data-id="${m.id}">📂 音频目录</button>
        <button class="ghost-btn tiny" data-mt="delete" data-id="${m.id}">🗑 删除</button>
      </div>
    </div>

    <div class="mt-pipeline">
      <button class="ghost-btn" data-mt="transcribe" data-id="${m.id}" ${busy('transcribe') ? 'disabled' : ''}>
        ${busy('transcribe') ? '转写中…' : (m.transcript ? '重新转写' : '① 语音转写')}
      </button>
      <span class="mt-arrow">→</span>
      <button class="primary-btn" data-mt="summarize" data-id="${m.id}" ${busy('summarize') || !m.transcript ? 'disabled' : ''}>
        ${busy('summarize') ? '生成中…' : (m.summary ? '重新生成纪要' : '② 生成纪要')}
      </button>
      <span class="mt-arrow">→</span>
      <button class="ghost-btn" data-mt="export" data-id="${m.id}" data-fmt="docx" ${!m.summary && !m.transcript ? 'disabled' : ''}>导出 Word</button>
      <button class="ghost-btn" data-mt="export" data-id="${m.id}" data-fmt="md" ${!m.summary && !m.transcript ? 'disabled' : ''}>导出 md</button>
      <span class="mt-status ${st.cls}">${st.label}</span>
    </div>

    <div class="mt-tabs">
      ${tabs.map(([k, label]) => `<button class="mt-tab${activeTab === k ? ' active' : ''}" data-mt="tab" data-tab="${k}">${label}</button>`).join('')}
    </div>

    <div class="mt-panel">
      ${activeTab === 'summary' ? renderSummaryTab(m)
      : activeTab === 'todos' ? renderTodosTab(m)
        : renderTranscriptTab(m)}
    </div>`;
}

function renderSummaryTab(m) {
  if (running.has(`${m.id}:summarize`)) return '<div class="mt-placeholder">正在生成纪要，请稍候…</div>';
  if (!m.summary) {
    return `<div class="mt-placeholder">${
      m.transcript ? '点击上方「生成纪要」把转写稿整理成结构化文档。' : '先做语音转写，再生成纪要。'
    }</div>`;
  }
  return `<div class="mt-markdown">${renderMarkdown(m.summary)}</div>`;
}

function renderTranscriptTab(m) {
  if (running.has(`${m.id}:transcribe`)) return '<div class="mt-placeholder">正在上传音频并转写，请稍候…</div>';
  if (!m.transcript) return '<div class="mt-placeholder">还没有转写文本。</div>';
  return `<div class="mt-transcript">${esc(m.transcript)}</div>`;
}

function renderTodosTab(m) {
  const todos = m.todos || [];
  if (running.has(`${m.id}:summarize`)) return '<div class="mt-placeholder">正在提取待办…</div>';
  if (!todos.length) {
    return `<div class="mt-placeholder">${m.summary ? '这轮纪要没有提取到明确的行动项。' : '生成纪要后，这里会列出可勾选的待办。'}</div>`;
  }
  const rows = todos.map((t) => `
    <li class="mt-todo">
      <label class="mt-todo-pick"><input type="checkbox" data-todo="${esc(t.id)}" checked /></label>
      <div class="mt-todo-body">
        <div class="mt-todo-title">${esc(t.title)}</div>
        <div class="mt-todo-meta">
          <span class="mt-tag">${esc(t.assignee || '未指定')}</span>
          <span class="mt-tag">${esc(t.due || '无截止日期')}</span>
          <span class="mt-tag pri-${Number(t.priority) || 1}">${PRIORITY_TEXT[Number(t.priority) || 1]}</span>
          ${t.detail ? `<span class="mt-todo-detail">${esc(t.detail)}</span>` : ''}
        </div>
      </div>
    </li>`).join('');
  return `
    <div class="mt-todo-bar">
      <label class="mt-checkall"><input type="checkbox" id="mt-checkall" checked /> 全选</label>
      <span class="mt-label">并入分组</span>
      <select class="sort-select" id="mt-group">${groupOptionsHtml(state.groups || [], null, [])}</select>
      <span class="mt-label">形态</span>
      <select class="sort-select" id="mt-shape">
        <option value="tasks">各自独立任务</option>
        <option value="subtasks">挂在一个父任务下</option>
      </select>
      <button class="primary-btn" data-mt="import-todos" data-id="${m.id}">导入到任务列表</button>
    </div>
    <ul class="mt-todo-list">${rows}</ul>`;
}

/* ------------------------------ 历史记录弹窗 ------------------------------ */

/** 摘要预览：去掉 Markdown 标记，取前若干字符，避免弹窗里塞进大段标记文本 */
function excerptOf(text, max = 140) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

function historyRowHtml(m) {
  const st = STATUS_TEXT[m.status] || STATUS_TEXT.recorded;
  const bits = [
    fmtTime(m.started_at),
    fmtDuration(m.duration_ms),
    m.mode === 'screen' ? '屏幕 + 音频' : '仅音频',
    (m.todos || []).length ? `${m.todos.length} 条待办` : '',
  ].filter(Boolean);
  const excerpt = m.summary ? excerptOf(m.summary) : excerptOf(m.transcript);
  return `<div class="mth-row" data-id="${m.id}">
    <div class="mth-main">
      <div class="mth-title">${esc(m.title)} <span class="mt-badge ${st.cls}">${st.label}</span></div>
      <div class="mth-sub">${bits.map((b) => `<span>${esc(b)}</span>`).join('')}</div>
      ${excerpt ? `<div class="mth-excerpt">${esc(excerpt)}</div>` : '<div class="mth-excerpt">（暂无内容）</div>'}
    </div>
    <div class="mth-ops">
      <button type="button" class="ghost-btn" data-act="view">查看</button>
      <button type="button" class="danger-btn" data-act="del">删除</button>
    </div>
  </div>`;
}

/**
 * 会议纪要历史列表。
 * 用宽弹窗（.modal-xl）而不是左侧窄列表：左侧列表只有 300px，标题/摘要会被截断，
 * 且高度受视口挤压、条目一多就变成内部滚动的小窗口，回看很费劲。
 */
async function openHistoryModal(root) {
  let list = await api.meeting.list().catch(() => []);
  if (!list.length) { notify('还没有会议记录'); return; }

  await openPanelModal({
    title: `会议纪要历史（${list.length} 条）`,
    className: 'modal-xl',
    okText: '关闭',
    html: '<div class="mth-list" id="mth-list"></div>',
    onMount(mask, close) {
      const box = mask.querySelector('#mth-list');
      const paint = (rows) => {
        box.innerHTML = rows.length
          ? rows.map(historyRowHtml).join('')
          : '<div class="mth-empty">暂无记录</div>';
      };
      paint(list);

      box.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const row = btn.closest('.mth-row');
        if (!row) return;
        const id = Number(row.dataset.id);
        if (btn.dataset.act === 'del') {
          if (!window.confirm('删除这条会议记录？对应的录音分片也会一并清除。')) return;
          await api.meeting.remove(id).catch(() => {});
          list = await api.meeting.list().catch(() => []);
          paint(list);
          onChanged();
          notify('已删除该会议记录');
          return;
        }
        selectedId = id;
        activeTab = 'summary';
        await renderMeetings(root);
        close();
      });
    },
  });
}

/* ------------------------------ 交互 ------------------------------ */

function bindEvents(root) {
  if (boundRoot === root) return; // 委托只挂一次，避免重绘后重复触发
  boundRoot = root;
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-mt]');
    if (!el || !root.contains(el)) return;
    const act = el.dataset.mt;
    const id = Number(el.dataset.id);

    if (act === 'select') {
      selectedId = id;
      activeTab = 'summary';
      await renderMeetings(root);
      return;
    }
    if (act === 'tab') { activeTab = el.dataset.tab; await renderMeetings(root); return; }
    if (act === 'record') { openRecorder(); return; }
    if (act === 'refresh') { await renderMeetings(root); return; }
    if (act === 'history') { await openHistoryModal(root); return; }
    if (act === 'import') {
      try {
        const r = await api.rec.importMedia();
        if (r && r.canceled) return;
        if (r && r.meeting) { selectedId = r.meeting.id; activeTab = 'summary'; notify('已导入，可以开始转写'); }
        await renderMeetings(root);
      } catch (err) { notify(`${err && err.message ? err.message : '导入失败'}`); }
      return;
    }
    if (act === 'rename') {
      const cur = lastList.find((x) => x.id === id);
      const name = window.prompt('会议名称', cur ? cur.title : '');
      if (name === null) return;
      try {
        await api.meeting.update(id, { title: name.trim() || '未命名会议' });
        await renderMeetings(root);
      } catch (err) { notify(`${err && err.message ? err.message : '重命名失败'}`); }
      return;
    }
    if (act === 'open-file') {
      const cur = lastList.find((x) => x.id === id);
      await api.rec.openFolder((cur && cur.media_paths && cur.media_paths[0]) || '').catch(() => {});
      return;
    }
    if (act === 'delete') {
      if (!window.confirm('删除这条会议记录？对应的录音分片也会一并清除。')) return;
      try {
        await api.meeting.remove(id);
        notify('已删除');
        await renderMeetings(root);
        onChanged();
      } catch (err) { notify(`${err && err.message ? err.message : '删除失败'}`); }
      return;
    }
    if (act === 'transcribe') { await runTranscribe(id, root); return; }
    if (act === 'summarize') { await runSummarize(id, root); return; }
    if (act === 'export') { await exportMeeting(id, el.dataset.fmt); return; }
    if (act === 'import-todos') { await importTodos(id, root); }
  });

  // 全选联动
  const all = root.querySelector('#mt-checkall');
  if (all) {
    all.addEventListener('change', () => {
      root.querySelectorAll('input[data-todo]').forEach((b) => { b.checked = all.checked; });
    });
  }
}

async function runTranscribe(id, root) {
  const m = lastList.find((x) => x.id === id);
  const key = `${id}:transcribe`;
  if (running.has(key)) return;
  if (m && !m.media_paths.length) { notify('这条会议没有音频文件'); return; }
  running.add(key);
  await renderMeetings(root);
  try {
    const updated = await api.meeting.transcribe(id, 'zh');
    const chars = (updated.transcript || '').length;
    notify(`转写完成，共 ${chars} 字`);
    selectedId = id;
    activeTab = 'summary';
  } catch (e) {
    notify(`${e && e.message ? e.message : '转写失败'}`);
  } finally {
    running.delete(key);
    await renderMeetings(root);
  }
}

/**
 * 录制/导入归档后自动向前推进：已配语音接口就自动转写，已配对话模型就自动出纪要。
 * 任何一步失败都不影响手动重跑——按钮仍在，只是提示原因。
 */
export async function autoProcessMeeting(m) {
  if (!m || !m.id) return;
  selectedId = m.id;
  activeTab = 'summary';
  await renderMeetings();
  let cfg;
  try {
    cfg = await api.ai.getConfig();
  } catch (e) {
    return;
  }
  const asrOk = !!(cfg.asr && cfg.asr.hasKey);
  const llmOk = !!cfg.hasKey;
  if (!asrOk && !llmOk) {
    notify('录音已存档。想自动出纪要，请到「⚙ AI 设置」配置语音接口与对话模型');
    return;
  }
  if (!asrOk) { notify('录音已存档。未配置语音接口，暂不能自动转写'); return; }

  const key = `${m.id}:transcribe`;
  running.add(key);
  await renderMeetings();
  try {
    await api.meeting.transcribe(m.id, 'zh');
  } catch (e) {
    running.delete(key);
    notify(`转写失败：${e && e.message ? e.message : e}`);
    return;
  }
  running.delete(key);
  notify('转写完成');
  await renderMeetings();

  if (!llmOk) {
    notify('未配置对话模型，可稍后手动点「生成纪要」');
    return;
  }
  running.add(`${m.id}:summarize`);
  await renderMeetings();
  try {
    await api.meeting.summarize(m.id);
    notify('纪要已生成');
    onChanged();
  } catch (e) {
    notify(`纪要生成失败：${e && e.message ? e.message : e}`);
  } finally {
    running.delete(`${m.id}:summarize`);
    await renderMeetings();
  }
}

async function runSummarize(id, root) {
  const key = `${id}:summarize`;
  if (running.has(key)) return;
  running.add(key);
  await renderMeetings(root);
  try {
    await api.meeting.summarize(id);
    notify('纪要已生成');
    selectedId = id;
    activeTab = 'summary';
    onChanged();
  } catch (e) {
    notify(`${e && e.message ? e.message : '纪要生成失败'}`);
  } finally {
    running.delete(key);
    await renderMeetings(root);
  }
}

/** 导出内容：有纪要用纪要，否则退回转写稿，并补上元信息头 */
function buildExportContent(m) {
  const head = [
    `# ${m.title}`,
    '',
    `> 时间：${fmtTime(m.started_at)}　时长：${fmtDuration(m.duration_ms)}　采集：${m.mode === 'screen' ? '屏幕 + 音频' : '仅音频'}`,
    '',
  ].join('\n');
  if (m.summary) {
    return `${head}${m.summary}\n`;
  }
  return `${head}## 转写原文\n\n${m.transcript || '（无内容）'}\n`;
}

async function exportMeeting(id, fmt) {
  const m = lastList.find((x) => x.id === id);
  if (!m) return;
  try {
    const r = await api.report.export({
      content: buildExportContent(m),
      defaultName: `${m.title.replace(/[\\/:*?"<>|]/g, '_')}`,
      format: fmt || 'md',
    });
    if (r && r.ok) notify(`已导出到 ${r.filePath}`);
  } catch (e) {
    notify(`${e && e.message ? e.message : '导出失败'}`);
  }
}

async function importTodos(id, root) {
  const picked = [...root.querySelectorAll('input[data-todo]:checked')].map((b) => b.dataset.todo);
  if (!picked.length) { notify('请先勾选要导入的待办'); return; }
  const groupSel = root.querySelector('#mt-group');
  const shapeSel = root.querySelector('#mt-shape');
  const groupId = groupSel && groupSel.value ? Number(groupSel.value) : null;
  try {
    const r = await api.meeting.importTodos({
      id,
      todoIds: picked,
      groupId,
      asSubtasks: !!shapeSel && shapeSel.value === 'subtasks',
    });
    if (r && r.ok) {
      notify(`已写入 ${r.created} 个任务`);
      onChanged();
    } else {
      notify((r && r.message) || '导入失败');
    }
  } catch (e) {
    notify(`${e && e.message ? e.message : '导入失败'}`);
  }
}
