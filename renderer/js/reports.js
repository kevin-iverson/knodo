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

  const groupOpts = ['<option value="">全部</option>']
    .concat(groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`))
    .join('');

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
        <label>分组筛选
          <select id="rp-group">${groupOpts}</select>
        </label>
        <button class="primary-btn" id="rp-generate">🤖 生成报告</button>
      </div>
    </div>

    <div class="panel report-output">
      <h3>报告结果（可编辑）</h3>
      <textarea id="rp-output" placeholder="点击「生成报告」后在此显示内容，可直接编辑…">${esc(reportContent)}</textarea>
      <div class="report-toolbar">
        <button class="primary-btn" id="rp-export-md">导出 Markdown</button>
        <button class="ghost-btn" id="rp-export-txt">导出纯文本</button>
      </div>
    </div>`;

  bindReportEvents(aiConfig);
}

function bindReportEvents(aiConfig) {
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
    const groupId = document.getElementById('rp-group').value
      ? Number(document.getElementById('rp-group').value)
      : null;

    const params = {
      type,
      customStart: start ? new Date(start + 'T00:00:00').toISOString() : null,
      customEnd: end ? new Date(end + 'T23:59:59').toISOString() : null,
      groupId,
    };

    const out = document.getElementById('rp-output');
    out.value = '生成中，请稍候…';
    const btn = document.getElementById('rp-generate');
    btn.textContent = '生成中…';

    const r = await api.report.generate(params);
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
  document.getElementById('rp-export-md').addEventListener('click', () => exportReport('md'));
  document.getElementById('rp-export-txt').addEventListener('click', () => exportReport('txt'));
}

async function exportReport(format) {
  const out = document.getElementById('rp-output');
  reportContent = out.value;
  if (!reportContent.trim()) { toast('没有可导出的内容'); return; }
  const type = document.getElementById('rp-type').value;
  const name = `报告_${type}_${new Date().toISOString().slice(0, 10)}`;
  const r = await api.report.export({ content: reportContent, defaultName: name, format });
  if (r.ok) toast('已导出：' + r.filePath);
}
