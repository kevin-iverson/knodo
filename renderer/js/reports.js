'use strict';
/**
 * AI 报告视图：配置 API、生成日报/周报/月报、编辑并导出。
 */
import { api } from './api.js';
import { state, loadGroups } from './store.js';
import { toast } from './ui.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let reportContent = '';

export async function renderReports() {
  const viewEl = document.getElementById('view');
  const groups = await loadGroups();
  const aiConfig = await api.ai.getConfig();

  // 分组筛选：多选（勾选若干分组，一个都不勾 = 全部分组）
  const groupChecks = groups.length
    ? groups.map((g) => `<label class="ms-opt"><input type="checkbox" data-group="${g.id}" /> <span>${esc(g.name)}</span></label>`).join('')
    : '<div class="ms-empty">暂无分组</div>';

  const presetOpts = (aiConfig.presets || [])
    .map((p) => `<option value="${esc(p.baseUrl)}" data-model="${esc(p.model)}">${esc(p.label)}</option>`)
    .join('');

  const keyHint = aiConfig.hasKey
    ? (aiConfig.encryptionDegraded ? '已保存 Key（非加密降级）' : '已保存 Key（本地加密）')
    : '未配置 Key（将生成本地模板报告）';

  viewEl.innerHTML = `
    <div class="panel">
      <h3>AI 配置</h3>
      <div class="ai-config">
        <div class="field">接口预设
          <select id="ai-preset">${presetOpts}</select>
        </div>
        <div class="field">接口地址 (Base URL)
          <input id="ai-baseurl" value="${esc(aiConfig.baseUrl)}" placeholder="https://api.deepseek.com" />
        </div>
        <div class="field">模型
          <input id="ai-model" value="${esc(aiConfig.model)}" placeholder="deepseek-chat" />
        </div>
        <div class="field">API Key
          <input id="ai-key" type="password" placeholder="留空则保持原 Key 不变" />
        </div>
        <button class="primary-btn" id="ai-save">保存配置</button>
        <button class="ghost-btn" id="ai-test">测试连接</button>
        <button class="ghost-btn" id="ai-clear" ${aiConfig.hasKey ? '' : 'hidden'}>清除 Key</button>
      </div>
      <div class="notice" id="ai-status">🔑 ${esc(keyHint)}。支持 OpenAI 兼容接口（DeepSeek / OpenAI / 通义千问 / Moonshot / Ollama）。</div>
    </div>

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
        <label>分组筛选（可多选）
          <div class="multi-select" id="rp-group">
            <button type="button" class="ms-trigger" id="rp-group-trigger" aria-expanded="false" title="点击选择分组，可多选">全部分组</button>
            <div class="ms-panel" id="rp-group-panel" hidden>
              <label class="ms-opt ms-all"><input type="checkbox" data-group="__all__" checked /> <span>全部分组</span></label>
              <div class="ms-list">${groupChecks}</div>
              <div class="ms-foot">
                <button type="button" class="ms-btn" id="rp-group-clear">清空选择</button>
              </div>
            </div>
          </div>
        </label>
        <button class="primary-btn" id="rp-generate">🤖 生成报告</button>
      </div>
    </div>

    <div class="panel report-output">
      <h3>报告结果（可编辑）</h3>
      <textarea id="rp-output" placeholder="点击「生成报告」后在此显示内容，可直接编辑…">${esc(reportContent)}</textarea>
      <div class="report-toolbar">
        <button class="primary-btn" id="rp-export-docx">📄 导出 Word</button>
        <button class="ghost-btn" id="rp-export-md">导出 Markdown</button>
        <button class="ghost-btn" id="rp-export-txt">导出纯文本</button>
      </div>
    </div>`;

  bindReportEvents(aiConfig);
}

/** 跨重绘保留的面板定位函数；document 级监听只注册一次 */
let placePanelRef = null;
let globalGroupHandlersBound = false;

/** 读取分组多选当前勾选的分组 id（空数组 = 全部） */
function selectedGroupIds() {
  const panel = document.getElementById('rp-group-panel');
  if (!panel) return [];
  return Array.from(panel.querySelectorAll('[data-group]'))
    .filter((b) => b.dataset.group !== '__all__' && b.checked)
    .map((b) => Number(b.dataset.group))
    .filter((n) => Number.isFinite(n));
}

/** 分组多选下拉：触发按钮 + 勾选面板，点击外部收起 */
function bindGroupMultiSelect() {
  const trigger = document.getElementById('rp-group-trigger');
  const panel = document.getElementById('rp-group-panel');
  if (!trigger || !panel) return;
  const allBox = panel.querySelector('[data-group="__all__"]');
  const boxes = Array.from(panel.querySelectorAll('[data-group]')).filter((b) => b.dataset.group !== '__all__');

  const sync = () => {
    const checked = boxes.filter((b) => b.checked);
    if (!checked.length) {
      allBox.checked = true;
      trigger.textContent = '全部分组';
    } else {
      allBox.checked = false;
      trigger.textContent = checked.length === boxes.length
        ? `全部 ${boxes.length} 个分组`
        : `已选 ${checked.length} 个分组`;
    }
  };

  /**
   * 面板用 fixed 定位并按视口收敛：.view 有 overflow-y:auto，
   * absolute 定位的面板会被容器下边缘裁掉。
   */
  const placePanel = () => {
    panel.classList.add('is-floating');
    panel.style.left = '0px';
    panel.style.top = '0px';
    const r = trigger.getBoundingClientRect();
    const margin = 8;
    const w = panel.offsetWidth || 190;
    const h = panel.offsetHeight || 200;
    let left = r.left;
    if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w;
    if (left < margin) left = margin;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - margin) {
      const above = r.top - h - 6;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - h);
    }
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  };

  const setOpen = (open) => {
    if (open) {
      panel.hidden = false;
      placePanel();
    } else {
      panel.hidden = true;
    }
    trigger.setAttribute('aria-expanded', String(open));
  };
  // 视图会反复重绘，把需要跨渲染保留的引用挂到模块级，避免监听器无限堆积
  placePanelRef = placePanel;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.hidden);
  });
  panel.addEventListener('click', (e) => e.stopPropagation());

  // 点击面板外部收起（只注册一次，否则每次重绘都会多挂一个监听）
  if (!globalGroupHandlersBound) {
    globalGroupHandlersBound = true;
    document.addEventListener('click', () => {
      const p = document.getElementById('rp-group-panel');
      const t = document.getElementById('rp-group-trigger');
      if (!p || p.hidden) return;
      p.hidden = true;
      if (t) t.setAttribute('aria-expanded', 'false');
    });
    window.addEventListener('resize', () => {
      const p = document.getElementById('rp-group-panel');
      if (p && !p.hidden && placePanelRef) placePanelRef();
    });
  }

  if (allBox) {
    allBox.addEventListener('change', () => {
      if (allBox.checked) boxes.forEach((b) => { b.checked = false; });
      sync();
    });
  }
  boxes.forEach((b) => b.addEventListener('change', () => {
    if (b.checked && allBox) allBox.checked = false;
    sync();
  }));
  const clearBtn = document.getElementById('rp-group-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      boxes.forEach((b) => { b.checked = false; });
      sync();
    });
  }
  sync();
}

function bindReportEvents(aiConfig) {
  bindGroupMultiSelect();

  // 预设切换
  document.getElementById('ai-preset').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (!opt) return;
    document.getElementById('ai-baseurl').value = opt.value;
    document.getElementById('ai-model').value = opt.dataset.model || '';
  });

  // 初始化日期范围（默认本周）
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  document.getElementById('rp-start').value = fmt(monday);
  document.getElementById('rp-end').value = fmt(now);

  // 保存配置
  document.getElementById('ai-save').addEventListener('click', async () => {
    const baseUrl = document.getElementById('ai-baseurl').value.trim();
    const model = document.getElementById('ai-model').value.trim();
    const apiKey = document.getElementById('ai-key').value.trim();
    if (!baseUrl) { toast('请填写接口地址'); return; }
    await api.ai.saveConfig({ baseUrl, model, apiKey });
    document.getElementById('ai-key').value = '';
    toast('AI 配置已保存');
    renderReports();
  });

  // 测试连接
  document.getElementById('ai-test').addEventListener('click', async () => {
    const baseUrl = document.getElementById('ai-baseurl').value.trim();
    const model = document.getElementById('ai-model').value.trim();
    const apiKey = document.getElementById('ai-key').value.trim();
    const btn = document.getElementById('ai-test');
    btn.textContent = '测试中…';
    const r = await api.ai.test({ baseUrl, model, apiKey });
    btn.textContent = '测试连接';
    toast(r.message);
  });

  // 清除 Key
  const clearBtn = document.getElementById('ai-clear');
  clearBtn.addEventListener('click', async () => {
    await api.ai.clearKey();
    toast('API Key 已清除');
    renderReports();
  });

  // 生成报告
  document.getElementById('rp-generate').addEventListener('click', async () => {
    const type = document.getElementById('rp-type').value;
    const start = document.getElementById('rp-start').value;
    const end = document.getElementById('rp-end').value;
    const groupIds = selectedGroupIds();

    const params = {
      type,
      customStart: start ? new Date(start + 'T00:00:00').toISOString() : null,
      customEnd: end ? new Date(end + 'T23:59:59').toISOString() : null,
      groupIds, // 空数组 = 全部分组
    };

    const out = document.getElementById('rp-output');
    out.value = '生成中，请稍候…';
    const btn = document.getElementById('rp-generate');
    btn.textContent = '生成中…';

    let r;
    try {
      r = await api.report.generate(params);
    } catch (e) {
      out.value = '';
      btn.textContent = '🤖 生成报告';
      toast(`生成失败：${e && e.message ? e.message : e}`);
      return;
    }
    reportContent = r.markdown;
    out.value = r.markdown;
    btn.textContent = '🤖 生成报告';

    const statusEl = document.getElementById('ai-status');
    if (r.degraded) {
      statusEl.innerHTML = `⚠ ${esc(r.reason)}`;
    } else {
      statusEl.innerHTML = '✅ 已由 AI 生成。';
    }
  });

  // 导出
  document.getElementById('rp-export-docx').addEventListener('click', () => exportReport('docx'));
  document.getElementById('rp-export-md').addEventListener('click', () => exportReport('md'));
  document.getElementById('rp-export-txt').addEventListener('click', () => exportReport('txt'));
}

async function exportReport(format) {
  const out = document.getElementById('rp-output');
  reportContent = out.value;
  if (!reportContent.trim()) { toast('没有可导出的内容'); return; }
  const type = document.getElementById('rp-type').value;
  const name = `报告_${type}_${new Date().toISOString().slice(0, 10)}`;
  try {
    const r = await api.report.export({ content: reportContent, defaultName: name, format });
    if (r && r.ok) toast('已导出：' + r.filePath);
    else if (r && !r.canceled) toast('导出失败：' + (r.message || '未知错误'));
  } catch (e) {
    toast(`导出失败：${e && e.message ? e.message : e}`);
  }
}
