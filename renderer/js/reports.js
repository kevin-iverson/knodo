'use strict';
/**
 * AI 报告视图：生成日报/周报/月报、就地编辑（改完自动保存）、历史记录、导出。
 * 注：AI 接口配置已抽到顶部工具栏「⚙ AI 设置」（renderer/js/ai-settings.js），这里只保留生成与导出。
 *
 * 编辑模型：取消「编辑 / 保存修改」按钮 —— 报告区始终可编辑，改动防抖后自动落库。
 * 历史：每份报告都写进 reports 表，右上角「🕘 历史记录」按钮可回看、删除，生成新报告不会覆盖旧记录。
 */
import { api } from './api.js';
import { loadGroups } from './store.js';
import { toast } from './ui.js';
import { openAiSettingsModal } from './ai-settings.js';
import { flattenGroupTree } from './group-tree.js';
import { openPanelModal } from './modal.js';
import { mdToDocHtml, docHtmlToMd } from './report-doc.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const DRAFT_KEY = 'todo.report.draft';
const EXTRA_KEY = 'todo.report.extraPrompt';
/** 防抖保存延迟：停止输入这么久之后才写库 */
const AUTOSAVE_MS = 700;

const TYPE_TEXT = { day: '日报', week: '周报', month: '月报', custom: '自定义范围' };

let reportContent = '';
/** 用户追加的自定义提示词（随请求传给 AI，留空则用默认提示） */
let extraPrompt = '';
/** 视图模式：doc = 类 Word 排版；source = Markdown 源码 */
let docMode = 'doc';
/** 当前编辑的报告在库中的 id（null = 尚未入库，例如手工草稿） */
let currentReportId = null;
/** 上次勾选的分组（跨重绘保留，Tom Select 重建后回填） */
let selectedGroups = [];
/** Tom Select 实例（视图重绘时要先销毁，避免重复实例与内存泄漏） */
let groupSelect = null;
/** 自动保存防抖定时器 */
let saveTimer = null;

function loadDraft() {
  try { return localStorage.getItem(DRAFT_KEY) || ''; } catch (e) { return ''; }
}

function saveDraft(text) {
  try { localStorage.setItem(DRAFT_KEY, text); } catch (e) { /* 隐私模式下忽略 */ }
}

/** 自定义提示词跟着视图切换一起保留（只存本地，不发网络） */
function loadExtraPrompt() {
  try { return localStorage.getItem(EXTRA_KEY) || ''; } catch (e) { return ''; }
}

function saveExtraPrompt(text) {
  try {
    if (text) localStorage.setItem(EXTRA_KEY, text);
    else localStorage.removeItem(EXTRA_KEY);
  } catch (e) { /* 忽略 */ }
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function renderReports() {
  const viewEl = document.getElementById('view');
  // 重启后仍能看到上次编辑过的报告（草稿存 localStorage，正式记录在 reports 表）
  if (!reportContent) reportContent = loadDraft();
  if (!extraPrompt) extraPrompt = loadExtraPrompt();
  const groups = await loadGroups();
  const aiConfig = await api.ai.getConfig();

  const keyHint = aiConfig.hasKey
    ? '已配置 API Key'
    : '未配置 API Key（将生成本地模板报告）';

  viewEl.innerHTML = `
    <div class="panel">
      <h3>生成报告</h3>
      <div class="report-controls">
        <label>报告类型
          <select id="rp-type">
            <option value="day">日报</option>
            <option value="week" selected>周报</option>
            <option value="month">月报</option>
            <option value="custom">自定义范围</option>
          </select>
        </label>
        <label>开始日期
          <input type="date" id="rp-start" />
        </label>
        <label>结束日期
          <input type="date" id="rp-end" />
        </label>
        <label class="rp-group-label">分组筛选（可多选）
          <select id="rp-group" multiple placeholder="全部分组（不选即全部）" aria-label="分组筛选">
            ${groupOptionsHtml(groups)}
          </select>
        </label>
        <button class="primary-btn" id="rp-generate">🤖 生成报告</button>
      </div>
      <div class="rp-extra">
        <label class="rp-extra-label" for="rp-extra">自定义要求（可选）</label>
        <textarea id="rp-extra" rows="2" maxlength="600"
          placeholder="例如：根据任务的计划完成时间生成下个月的工作计划；风险用表格列出">${esc(extraPrompt)}</textarea>
        <div class="rp-extra-foot">
          <span class="rp-extra-hint">会原样追加到给 AI 的提示里，留空则使用默认提示；本地模板报告（未配置 Key）不消耗此项。</span>
          <span class="rp-extra-count" id="rp-extra-count">${(extraPrompt || '').length}/600</span>
        </div>
      </div>
      <div class="notice" id="ai-status">
        <span>🔑 ${esc(keyHint)}。</span>
        <button class="link-btn" id="rp-open-ai-settings">⚙ AI 设置…</button>
      </div>
    </div>

    <div class="panel report-output">
      <h3>报告结果</h3>
      <div class="report-toolbar rp-mode-bar">
        <button class="ghost-btn rp-mode" data-mode="doc">📄 文档视图</button>
        <button class="ghost-btn rp-mode" data-mode="source">⌨ Markdown 源码</button>
        <span class="rp-save-state" id="rp-save-state"></span>
        <span class="rp-spacer"></span>
        <button class="ghost-btn" id="rp-history" title="查看历史报告">🕘 历史记录</button>
      </div>
      <div class="rp-doc-page" id="rp-page">
        <div class="rp-doc is-editing" id="rp-doc" contenteditable="true" spellcheck="false"></div>
        <textarea id="rp-output" hidden placeholder="点击「生成报告」后在此显示内容，可直接编辑…"></textarea>
      </div>
      <div class="report-toolbar">
        <button class="primary-btn" id="rp-export-docx">📄 导出 Word</button>
        <button class="ghost-btn" id="rp-export-md">导出 Markdown</button>
      </div>
    </div>`;

  bindReportEvents();
  initGroupSelect();
  applyDocMode();
}

/** 渲染文档 / 源码两种视图（文档始终可编辑，改动防抖自动保存） */
function applyDocMode() {
  const docEl = document.getElementById('rp-doc');
  const out = document.getElementById('rp-output');
  if (!docEl || !out) return;

  document.querySelectorAll('.rp-mode').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === docMode);
  });

  if (docMode === 'source') {
    docEl.hidden = true;
    out.hidden = false;
    out.value = reportContent;
    return;
  }
  out.hidden = true;
  docEl.hidden = false;
  docEl.innerHTML = reportContent
    ? mdToDocHtml(reportContent)
    : '<p class="rp-placeholder">点击「生成报告」后在此显示内容，可直接编辑…</p>';
  // 始终可编辑：不再需要「编辑」开关
  docEl.contentEditable = 'true';
  docEl.classList.add('is-editing');
  // 回车默认产出 <div>，统一改成 <p>，反向序列化时才不会丢段落结构
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* 老版本忽略 */ }
}

/* ---------------- 自动保存 ---------------- */

function setSaveState(text, kind) {
  const el = document.getElementById('rp-save-state');
  if (!el) return;
  el.textContent = text;
  el.className = `rp-save-state${kind ? ` ${kind}` : ''}`;
}

/** 内容变动 → 防抖后写库（有 id 时）+ 写本地草稿 */
function scheduleSave() {
  setSaveState('● 未保存', 'dirty');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, AUTOSAVE_MS);
}

/** 立即保存（导出前、查看历史前、切换视图前调用） */
async function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const text = collectContent();
  saveDraft(text);
  const p = nowLabel();
  if (currentReportId == null) { setSaveState(`✓ 已保存到草稿 ${p}`, 'saved'); return text; }
  try {
    await api.report.update(currentReportId, { content: text });
    setSaveState(`✓ 已保存 ${p}`, 'saved');
  } catch (e) {
    setSaveState('保存失败（内容仍在界面上）', 'error');
  }
  return text;
}

function nowLabel() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把当前界面上的内容（文档 DOM 或源码框）同步回 reportContent */
function collectContent() {
  if (docMode === 'source') {
    const out = document.getElementById('rp-output');
    reportContent = out ? out.value : reportContent;
  } else {
    const docEl = document.getElementById('rp-doc');
    if (docEl) reportContent = docHtmlToMd(docEl);
  }
  return reportContent;
}

/* ---------------- 分组多选（Tom Select） ---------------- */

function groupOptionsHtml(groups) {
  return flattenGroupTree(groups, { respectExpansion: false })
    .map(({ g, depth }) => `<option value="${g.id}" data-depth="${depth}" data-color="${esc(g.color || '#c3cad6')}">${esc(g.name)}</option>`)
    .join('');
}

/**
 * 分组多选：第三方组件 Tom Select（可搜索 + 已选 chips + 一键清除）。
 * 层级信息放在 data-depth 上，渲染时按层级缩进，搜索仍然按纯分组名匹配。
 */
function initGroupSelect() {
  const el = document.getElementById('rp-group');
  if (!el) return;
  if (groupSelect) { try { groupSelect.destroy(); } catch (e) { /* 已销毁 */ } groupSelect = null; }
  if (typeof window.TomSelect !== 'function') return; // 依赖缺失时退回原生多选，不至于整页失效

  const dot = (data, escapeHtml) =>
    `<span class="ts-dot" style="background:${escapeHtml(data.color || '#c3cad6')}"></span>`;

  groupSelect = new window.TomSelect(el, {
    plugins: ['remove_button', 'clear_button'],
    // 面板挂到 body：报告区在可滚动容器里，挂在本容器内会被下边缘裁掉
    dropdownParent: 'body',
    hideSelected: true,
    placeholder: '全部分组（不选即全部）',
    maxOptions: 300,
    render: {
      option: (data, escapeHtml) => {
        const d = Number(data.depth) || 0;
        return `<div class="ts-opt" style="padding-left:${6 + d * 14}px">`
          + (d ? '<span class="ts-tree">└</span>' : '')
          + dot(data, escapeHtml)
          + `<span class="ts-name">${escapeHtml(data.text)}</span></div>`;
      },
      item: (data, escapeHtml) =>
        `<span class="ts-item">${dot(data, escapeHtml)}${escapeHtml(data.text)}</span>`,
      no_results: () => '<div class="no-results">没有匹配的分组</div>',
    },
  });

  if (selectedGroups.length) groupSelect.setValue(selectedGroups, true);
  groupSelect.on('change', () => { selectedGroups = selectedGroupIds(); });
}

/** 读取当前勾选的分组 id（空数组 = 全部） */
function selectedGroupIds() {
  if (!groupSelect) return [];
  const v = groupSelect.getValue();
  return String(v || '').split(',').filter(Boolean).map(Number).filter(Number.isFinite);
}

/** 分组文案（存进历史记录，回看时知道当时筛了什么） */
function groupLabelText() {
  const ids = selectedGroupIds();
  if (!ids.length) return '全部分组';
  return `已选 ${ids.length} 个分组`;
}

/* ---------------- 历史记录 ---------------- */

function historyRowHtml(r) {
  const range = r.range_start || r.range_end
    ? `${(r.range_start || '').slice(0, 10)} ~ ${(r.range_end || '').slice(0, 10)}`
    : '';
  const bits = [fmtTime(r.created_at), TYPE_TEXT[r.type] || r.type, range, r.group_label || '全部分组'];
  if (r.extra_prompt) bits.push('含自定义要求');
  if (r.degraded) bits.push('本地模板');
  return `<div class="rpt-row" data-id="${r.id}">
    <div class="rpt-main">
      <div class="rpt-title">${esc(r.title)}</div>
      <div class="rpt-sub">${esc(bits.filter(Boolean).join(' · '))}</div>
    </div>
    <div class="rpt-ops">
      <button type="button" class="ghost-btn" data-act="view">查看</button>
      <button type="button" class="danger-btn" data-act="del">删除</button>
    </div>
  </div>`;
}

async function openHistoryModal() {
  await flushSave(); // 先看存后看历史，避免当前改动丢在半路
  const list = await api.report.list(100).catch((e) => {
    toast(`读取历史失败：${e && e.message ? e.message : e}`);
    return [];
  });
  if (!list.length) { toast('还没有历史报告，生成一份后会自动保存'); return; }

  await openPanelModal({
    title: `历史报告（${list.length} 份）`,
    // 宽弹窗：标题 + 时间 + 范围 + 分组 + 自定义要求都要在一行里铺开，720px 会挤成内部滚动
    className: 'modal-xl',
    okText: '关闭',
    html: '<div class="rpt-history" id="rpt-history"></div>',
    onMount(mask, close) {
      const box = mask.querySelector('#rpt-history');
      const paint = (rows) => {
        box.innerHTML = rows.length ? rows.map(historyRowHtml).join('') : '<div class="rpt-empty">暂无记录</div>';
      };
      paint(list);

      box.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const row = btn.closest('.rpt-row');
        if (!row) return;
        const id = Number(row.dataset.id);
        if (btn.dataset.act === 'del') {
          await api.report.remove(id).catch(() => {});
          if (currentReportId === id) currentReportId = null;
          const left = await api.report.list(100).catch(() => []);
          paint(left);
          toast('已删除该历史报告');
          return;
        }
        const rec = await api.report.get(id).catch(() => null);
        if (!rec) { toast('读取该报告失败'); return; }
        reportContent = rec.content || '';
        currentReportId = rec.id;
        saveDraft(reportContent);
        applyDocMode();
        setSaveState(`已载入 ${fmtTime(rec.created_at)}`, 'saved');
        close(false);
        toast('已载入历史报告');
      });
    },
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindReportEvents() {
  // 自定义要求：输入即记忆（切换视图 / 重启后仍在，不随报告内容一起清空）
  const extraEl = document.getElementById('rp-extra');
  if (extraEl) {
    const counter = document.getElementById('rp-extra-count');
    extraEl.addEventListener('input', () => {
      extraPrompt = extraEl.value;
      saveExtraPrompt(extraPrompt);
      if (counter) counter.textContent = `${extraPrompt.length}/600`;
    });
  }

  // 视图切换：文档（类 Word 排版）/ Markdown 源码
  document.querySelectorAll('.rp-mode').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await flushSave();
      docMode = btn.dataset.mode;
      applyDocMode();
    });
  });

  // 历史记录
  const historyBtn = document.getElementById('rp-history');
  if (historyBtn) historyBtn.addEventListener('click', () => openHistoryModal().catch(() => {}));

  // 文档就地编辑 / 源码输入 → 防抖自动保存
  const docElNow = document.getElementById('rp-doc');
  if (docElNow) {
    docElNow.addEventListener('input', scheduleSave);
    // 粘贴一律转纯文本，避免把外部 HTML 结构带进文档后无法还原成 Markdown
    docElNow.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      document.execCommand('insertText', false, text);
    });
  }
  const outNow = document.getElementById('rp-output');
  if (outNow) outNow.addEventListener('input', scheduleSave);

  // AI 配置入口（配置本体已在顶部工具栏）
  const aiBtn = document.getElementById('rp-open-ai-settings');
  if (aiBtn) aiBtn.addEventListener('click', () => openAiSettingsModal().then(renderReports));

  // 初始化日期范围（默认本周），并建立日期联动
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const startEl = document.getElementById('rp-start');
  const endEl = document.getElementById('rp-end');
  startEl.value = fmt(monday);
  endEl.value = fmt(now);
  endEl.min = startEl.value;

  /**
   * 报告类型 → 预置日期区间（与主进程 resolveRange 的口径一致）：
   * 日报=今天、周报=本周一至今、月报=本月 1 日至今。切换类型即回填，
   * 回填后仍可手动微调（自定义范围则不动日期）。
   */
  const applyTypePreset = (type) => {
    if (type === 'custom') return;
    const base = new Date();
    const startDate = new Date(base);
    if (type === 'week') startDate.setDate(base.getDate() - ((base.getDay() + 6) % 7));
    else if (type === 'month') startDate.setDate(1);
    startEl.value = fmt(startDate);
    endEl.value = fmt(base);
    endEl.min = startEl.value;
  };
  document.getElementById('rp-type').addEventListener('change', (e) => applyTypePreset(e.target.value));
  // 结束日期不能早于开始日期：改开始时把下限带上，已填的结束早于开始就吸附
  startEl.addEventListener('change', () => {
    endEl.min = startEl.value;
    if (endEl.value && endEl.value < startEl.value) endEl.value = startEl.value;
  });

  // 生成报告
  document.getElementById('rp-generate').addEventListener('click', async () => {
    const type = document.getElementById('rp-type').value;
    const start = document.getElementById('rp-start').value;
    const end = document.getElementById('rp-end').value;
    const groupIds = selectedGroupIds();
    const groupLabel = groupLabelText();
    // 自定义要求：原样传给主进程，由 buildPrompt 追加到 user 消息里
    const extraEl = document.getElementById('rp-extra');
    const extra = extraEl ? extraEl.value.trim().slice(0, 600) : '';
    extraPrompt = extra;

    const params = {
      type,
      customStart: start ? new Date(start + 'T00:00:00').toISOString() : null,
      customEnd: end ? new Date(end + 'T23:59:59').toISOString() : null,
      groupIds, // 空数组 = 全部分组
      extraPrompt: extra, // 空串 = 不追加
    };

    const out = document.getElementById('rp-output');
    const btn = document.getElementById('rp-generate');
    btn.textContent = '生成中…';
    const docEl = document.getElementById('rp-doc');
    if (docEl) docEl.innerHTML = '<p class="rp-placeholder">生成中，请稍候…</p>';
    if (out) out.value = '生成中，请稍候…';

    let r;
    try {
      r = await api.report.generate(params);
    } catch (e) {
      if (out) out.value = '';
      btn.textContent = '🤖 生成报告';
      toast(`生成失败：${e && e.message ? e.message : e}`);
      return;
    }
    reportContent = r.markdown;
    saveDraft(reportContent);
    applyDocMode();
    btn.textContent = '🤖 生成报告';

    // 持久化：每份报告独立一条记录，生成新报告不会覆盖旧的
    const title = `${TYPE_TEXT[type] || '报告'} ${start || ''}${start && end ? ' ~ ' : ''}${end || ''}`;
    try {
      const rec = await api.report.save({
        title: title.trim() || '未命名报告',
        type,
        range_start: start || null,
        range_end: end || null,
        group_ids: groupIds,
        group_label: groupLabel,
        extra_prompt: extra,
        content: reportContent,
        degraded: !!r.degraded,
      });
      currentReportId = rec ? rec.id : null;
      setSaveState(currentReportId ? `✓ 已保存到历史 ${nowLabel()}` : '已生成（未入库）', 'saved');
    } catch (e) {
      currentReportId = null;
      setSaveState('已生成，但保存失败', 'error');
    }

    const statusEl = document.getElementById('ai-status');
    if (statusEl) {
      statusEl.innerHTML = r.degraded
        ? `<span>⚠ ${esc(r.reason)}</span><button class="link-btn" id="rp-open-ai-settings">⚙ AI 设置…</button>`
        : '<span>✅ 已由 AI 生成。</span>';
      const again = document.getElementById('rp-open-ai-settings');
      if (again) again.addEventListener('click', () => openAiSettingsModal().then(renderReports));
    }
  });

  // 导出
  document.getElementById('rp-export-docx').addEventListener('click', () => exportReport('docx'));
  document.getElementById('rp-export-md').addEventListener('click', () => exportReport('md'));
}

async function exportReport(format) {
  // 导出前先落一次库并收集最新内容：正在编辑但还没到防抖时间也能导出到最新
  const content = await flushSave();
  if (!String(content).trim()) { toast('没有可导出的内容'); return; }
  const type = document.getElementById('rp-type').value;
  const name = `报告_${type}_${new Date().toISOString().slice(0, 10)}`;
  try {
    const r = await api.report.export({ content, defaultName: name, format });
    if (r && r.ok) toast('已导出：' + r.filePath);
    else if (r && !r.canceled) toast('导出失败：' + (r.message || '未知错误'));
  } catch (e) {
    toast(`导出失败：${e && e.message ? e.message : e}`);
  }
}
