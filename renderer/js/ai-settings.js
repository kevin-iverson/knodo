'use strict';
/**
 * AI 配置入口：从「AI 报告」视图抽出来，统一放到顶部工具栏。
 *
 * 之所以用 setToast / setOnChanged 注入依赖而不是直接 import ui.js：
 * ui.js 会绑定这个模块（工具栏按钮），反过来再 import ui.js 会形成循环依赖，
 * ESM 下模块求值顺序不确定。项目里 detail.js / search.js 已是同样的做法。
 */
import { api } from './api.js';
import { openFormModal } from './modal.js';

let notify = () => {};
let notifyChanged = () => {};

export function setAiSettingsHandlers({ toast, onChanged } = {}) {
  if (toast) notify = toast;
  if (onChanged) notifyChanged = onChanged;
}

/** 打开 AI 设置弹窗（工具栏按钮 / 报告页入口共用） */
export async function openAiSettingsModal() {
  const cfg = await api.ai.getConfig();
  const presets = cfg.presets || [];
  const currentUrl = cfg.baseUrl || '';

  const keyHint = cfg.hasKey
    ? (cfg.encryptionDegraded ? '已保存 Key（非加密降级）' : '已保存 Key（本地加密）')
    : '未配置 Key（将生成本地模板报告）';

  await openFormModal({
    title: 'AI 设置',
    width: 460,
    okText: '保存配置',
    fields: [
      {
        name: 'preset',
        label: '接口预设',
        type: 'select',
        value: presets.find((p) => p.baseUrl === currentUrl)?.baseUrl || '',
        options: [{ value: '', label: '自定义' }].concat(
          presets.map((p) => ({ value: p.baseUrl, label: p.label })),
        ),
        hint: '选择预设会自动填入接口地址与模型',
      },
      { name: 'baseUrl', label: '接口地址 (Base URL)', value: currentUrl, placeholder: 'https://api.deepseek.com' },
      { name: 'model', label: '模型', value: cfg.model || '', placeholder: 'deepseek-chat' },
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        placeholder: cfg.hasKey ? '留空则保持原 Key 不变' : '输入 API Key',
        hint: keyHint + '。支持 OpenAI 兼容接口（DeepSeek / OpenAI / 通义千问 / Moonshot / Ollama）',
      },
    ],
    extraButtons: [
      {
        label: '测试连接',
        handler: async (v) => {
          const r = await api.ai.test({
            baseUrl: v.baseUrl.trim(),
            model: v.model.trim(),
            apiKey: v.apiKey.trim(),
          });
          notify(r.message);
          return undefined;
        },
      },
      {
        label: '清除 Key',
        handler: async () => {
          await api.ai.clearKey();
          notify('API Key 已清除');
          notifyChanged();
          return undefined;
        },
      },
    ],
    onSubmit: async (v) => {
      const baseUrl = v.baseUrl.trim();
      const model = v.model.trim();
      const apiKey = v.apiKey.trim();
      if (!baseUrl) return '请填写接口地址';
      await api.ai.saveConfig({ baseUrl, model, apiKey });
      notify('AI 配置已保存');
      notifyChanged();
      return undefined;
    },
  });
}

/** 绑定顶部工具栏的「⚙ AI 设置」按钮 */
export function bindAiSettingsButton() {
  const btn = document.getElementById('btn-ai-settings');
  if (!btn) return false;
  btn.addEventListener('click', () => {
    openAiSettingsModal().catch((e) => notify(`打开 AI 设置失败：${e && e.message ? e.message : e}`));
  });
  return true;
}
