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

/**
 * 生成预设联动：选中预设后把它的接口地址与模型写进对应输入框。
 * 按 id 匹配（不是 baseUrl）——同一个厂商地址下可能有多个模型。
 */
function presetBinder(list, urlField, modelField) {
  return (id, root) => {
    const p = list.find((x) => x.id === id);
    if (!p || !root) return;
    const bu = root.querySelector(`[data-field="${urlField}"]`);
    const md = root.querySelector(`[data-field="${modelField}"]`);
    if (bu) bu.value = p.baseUrl;
    if (md) md.value = p.model;
  };
}

/** 当前配置命中哪个预设：先按 (地址 + 模型) 精确匹配，再退化到只按地址匹配 */
function presetIdOf(list, url, model) {
  if (!url) return '';
  const exact = list.find((p) => p.baseUrl === url && p.model === model);
  if (exact) return exact.id;
  const loose = list.find((p) => p.baseUrl === url);
  return loose ? loose.id : '';
}

/** 打开 AI 设置弹窗（工具栏按钮 / 报告页入口共用） */
export async function openAiSettingsModal() {
  const cfg = await api.ai.getConfig();
  const presets = cfg.presets || [];
  const currentUrl = cfg.baseUrl || '';
  const asr = cfg.asr || {};
  const asrPresets = asr.presets || [];
  const currentAsrUrl = asr.baseUrl || '';

  const keyHint = cfg.hasKey
    ? (cfg.encryptionDegraded ? '已保存（非加密降级）' : '已保存（本地加密）')
    : '未配置，报告将降级为本地模板';
  const asrKeyHint = asr.hasKey
    ? '已保存（本地加密）'
    : '未配置，会议无法转写';

  await openFormModal({
    title: 'AI 设置',
    width: 780,
    okText: '保存配置',
    // 两栏栅格 + 两张分区卡片：字段从 8 行压到 4 行左右，不再顶出窗口
    fields: [
      {
        section: '对话模型（报告 / 检索 / 纪要）',
        name: 'preset',
        label: '接口预设',
        type: 'select',
        value: presetIdOf(presets, currentUrl, cfg.model || ''),
        options: [{ value: '', label: '自定义' }].concat(
          presets.map((p) => ({ value: p.id, label: p.label })),
        ),
        onChange: presetBinder(presets, 'baseUrl', 'model'),
      },
      {
        section: '对话模型（报告 / 检索 / 纪要）',
        name: 'model',
        label: '模型',
        value: cfg.model || '',
        placeholder: 'deepseek-chat',
      },
      {
        section: '对话模型（报告 / 检索 / 纪要）',
        name: 'baseUrl',
        span: 2,
        label: '接口地址 (Base URL)',
        value: currentUrl,
        placeholder: 'https://api.deepseek.com',
      },
      {
        section: '对话模型（报告 / 检索 / 纪要）',
        name: 'apiKey',
        span: 2,
        label: 'API Key',
        type: 'password',
        placeholder: cfg.hasKey ? '留空则保持原 Key 不变' : '输入 API Key',
        hint: keyHint,
      },

      {
        section: '语音转写（会议纪要）',
        name: 'asrPreset',
        label: '语音接口预设',
        type: 'select',
        value: presetIdOf(asrPresets, currentAsrUrl, asr.model || ''),
        options: [{ value: '', label: '自定义' }].concat(
          asrPresets.map((p) => ({ value: p.id, label: p.label })),
        ),
        onChange: presetBinder(asrPresets, 'asrBaseUrl', 'asrModel'),
      },
      {
        section: '语音转写（会议纪要）',
        name: 'asrModel',
        label: '语音模型',
        value: asr.model || '',
        placeholder: 'whisper-1',
      },
      {
        section: '语音转写（会议纪要）',
        name: 'asrBaseUrl',
        label: '语音接口地址',
        value: currentAsrUrl,
        placeholder: 'https://api.openai.com/v1',
      },
      {
        section: '语音转写（会议纪要）',
        name: 'asrKey',
        span: 2,
        label: '语音 API Key',
        type: 'password',
        placeholder: asr.hasKey ? '留空则保持原 Key 不变' : '输入语音接口的 API Key',
        hint: `${asrKeyHint}；国内可选「硅基流动 SenseVoice（免费）」「阿里云百炼 Qwen3-ASR-Flash」`,
      },
    ],
    extraButtons: [
      {
        label: '测试对话模型',
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
        label: '测试语音接口',
        handler: async (v) => {
          const r = await api.ai.testAsr({
            baseUrl: v.asrBaseUrl.trim(),
            model: v.asrModel.trim(),
            apiKey: v.asrKey.trim(),
          });
          notify(r.message);
          return undefined;
        },
      },
      {
        label: '清除对话 Key',
        handler: async () => {
          await api.ai.clearKey();
          notify('对话模型 API Key 已清除');
          notifyChanged();
          return undefined;
        },
      },
      {
        label: '清除语音 Key',
        handler: async () => {
          await api.ai.clearAsrKey();
          notify('语音接口 API Key 已清除');
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
      await api.ai.saveConfig({
        baseUrl,
        model,
        apiKey,
        asrBaseUrl: v.asrBaseUrl.trim(),
        asrModel: v.asrModel.trim(),
        asrKey: v.asrKey.trim(),
      });
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
