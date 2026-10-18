'use strict';
/**
 * 语音转文字（ASR）模块。
 *
 * 为什么单独一个模块、不和 ai.js 合并：
 * 1) 端点不同：对话是 POST /chat/completions，语音是 multipart POST /audio/transcriptions；
 * 2) Key 通常不同：DeepSeek / Moonshot 这类主力对话模型大多不提供语音接口，
 *    而 Whisper 类服务又不一定适合用来写纪要。因此 ASR 单独一组配置，互不影响。
 *
 * 依赖：Node 18+ 内置的 fetch / FormData / Blob（Electron 主进程可用），零第三方包。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ASR_CONFIG = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
};

/**
 * 主流 OpenAI 兼容语音服务预设。
 *
 * 注意用 id 而不是 baseUrl 做主键：硅基流动一个 baseUrl 下挂着多个 ASR 模型
 * （SenseVoice / Qwen3-ASR-1.7B），若按 baseUrl 反查，选第二个预设会错填成第一个的模型名。
 *
 * 国内可用（无需代理、中文识别更好）：硅基流动 SenseVoice 免费档、阿里云百炼 Qwen3-ASR-Flash。
 */
const ASR_PRESETS = [
  {
    id: 'sf-sensevoice',
    label: '硅基流动 SenseVoice（中文，免费）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
  },
  {
    id: 'bailian-qwen3-asr-flash',
    label: '阿里云百炼 Qwen3-ASR-Flash',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-asr-flash',
  },
  {
    id: 'sf-qwen3-asr',
    label: '硅基流动 Qwen3-ASR-1.7B',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-ASR-1.7B',
  },
  {
    id: 'openai-whisper',
    label: 'OpenAI Whisper',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
  },
  {
    id: 'groq-whisper',
    label: 'Groq Whisper Large v3',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
  },
  {
    id: 'local-whisper',
    label: '本地 Whisper 服务',
    baseUrl: 'http://localhost:8000/v1',
    model: 'whisper-1',
  },
];

/** 多数云端 ASR 对单个文件的上限（OpenAI Whisper 为 25MB），留 1MB 余量 */
const MAX_CHUNK_BYTES = 24 * 1024 * 1024;

const MIME_BY_EXT = {
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

function mimeOf(filePath) {
  return MIME_BY_EXT[path.extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

/** HTTP 错误码 → 用户能看懂的原因 */
function describeHttpError(status, body) {
  const tip = String(body || '').replace(/\s+/g, ' ').slice(0, 200);
  if (status === 401 || status === 403) return `语音接口鉴权失败（HTTP ${status}）：请检查 ASR 的 API Key${tip ? ' — ' + tip : ''}`;
  if (status === 404) return `语音接口地址不存在（HTTP 404）：请确认接口支持 /audio/transcriptions${tip ? ' — ' + tip : ''}`;
  if (status === 413) return `音频文件超过该服务上限（HTTP 413）：请缩短单次录制时长${tip ? ' — ' + tip : ''}`;
  if (status === 415) return `不支持的音频格式（HTTP 415）${tip ? ' — ' + tip : ''}`;
  if (status === 429) return `请求过于频繁或额度不足（HTTP 429）${tip ? ' — ' + tip : ''}`;
  return `语音接口请求失败（HTTP ${status}）${tip ? '：' + tip : ''}`;
}

/**
 * 兜底通道：走 /chat/completions + input_audio(base64) 转写。
 *
 * 为什么需要：阿里云百炼的 Qwen3-ASR 官方文档主推的是 chat/completions 传音频的方式，
 * 各版本兼容层对 /audio/transcriptions 的支持并不一致。遇到 404/405 时自动改走这条通道，
 * 用户不必为了换一家厂商去手改地址。
 */
async function transcribeViaChat({
  baseUrl, apiKey, model, filePath, language = '', prompt = '', timeoutMs = 300000,
}) {
  const buf = fs.readFileSync(filePath);
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model,
      messages: [
        ...(prompt ? [{ role: 'system', content: prompt }] : []),
        {
          role: 'user',
          content: [{
            type: 'input_audio',
            input_audio: { data: `data:${mimeOf(filePath)};base64,${buf.toString('base64')}` },
          }],
        },
      ],
      stream: false,
    };
    if (language) body.asr_options = { language };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(describeHttpError(res.status, raw));

    let text = raw;
    try {
      const data = JSON.parse(raw);
      if (data && data.choices && data.choices[0] && data.choices[0].message) {
        text = String(data.choices[0].message.content || '');
      }
    } catch (e) { /* 允许纯文本返回 */ }
    text = String(text || '').trim();
    if (!text) throw new Error('语音接口返回内容为空（可能是纯静音或格式不受支持）');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('语音转写超时，请缩短单次录制时长后重试');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 兼容各家返回：{text} / {segments:[{text}]} / 纯文本 */
function extractText(data, raw) {
  if (data && typeof data === 'object') {
    if (typeof data.text === 'string' && data.text) return data.text.trim();
    if (Array.isArray(data.segments) && data.segments.length) {
      return data.segments.map((s) => (s && s.text) || '').join('').trim();
    }
    if (Array.isArray(data.results) && data.results.length) {
      return data.results.map((s) => (s && s.text) || '').join('').trim();
    }
  }
  return String(raw || '').trim();
}

/**
 * 转写单个音频文件。
 * @param {object} opts { baseUrl, apiKey, model, filePath, language, prompt, timeoutMs }
 * @returns {Promise<string>} 转写文本
 */
async function transcribe({
  baseUrl, apiKey, model, filePath, language = 'zh', prompt = '', timeoutMs = 300000,
}) {
  if (!filePath) throw new Error('缺少音频文件路径');
  if (!fs.existsSync(filePath)) throw new Error(`音频文件不存在：${filePath}`);
  if (!apiKey) throw new Error('NO_ASR_KEY');
  if (!baseUrl) throw new Error('未配置语音接口地址');
  if (!model) throw new Error('未配置语音模型名称');

  const stat = fs.statSync(filePath);
  if (stat.size === 0) throw new Error('音频文件内容为空');
  if (stat.size > MAX_CHUNK_BYTES) {
    throw new Error(`音频分片 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过上限 ${MAX_CHUNK_BYTES / 1024 / 1024}MB，请缩短切片时长`);
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const buf = fs.readFileSync(filePath);
    const blob = new Blob([buf], { type: mimeOf(filePath) });
    const form = new FormData();
    form.append('file', blob, path.basename(filePath));
    form.append('model', model);
    if (language) form.append('language', language);
    if (prompt) form.append('prompt', prompt);
    form.append('response_format', 'json');

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      // 端点不存在或方法不允许 → 换 chat/completions 通道再试一次（百炼系常见）
      if (res.status === 404 || res.status === 405) {
        return await transcribeViaChat({ baseUrl, apiKey, model, filePath, language, prompt, timeoutMs });
      }
      throw new Error(describeHttpError(res.status, raw));
    }

    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* 允许纯文本返回 */ }
    const text = extractText(data, raw);
    if (!text) throw new Error('语音接口返回内容为空（可能是纯静音或格式不受支持）');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('语音转写超时，请缩短单次录制时长后重试');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 连通性自检：拉取模型列表并确认目标模型可用。
 * 之所以不真的传一段音频：需要一个合法的音频样本，平白增加一次无效计费。
 */
async function testAsr({ baseUrl, apiKey, model }) {
  if (!apiKey) throw new Error('NO_ASR_KEY');
  if (!baseUrl) throw new Error('未配置语音接口地址');
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(describeHttpError(res.status, raw));
    let listed = [];
    try {
      const data = JSON.parse(raw);
      listed = Array.isArray(data && data.data) ? data.data.map((m) => m.id || '') : [];
    } catch (e) {
      listed = []; // 返回非 JSON 时不强行判定
    }
    // 这里刻意「只警告不报错」：部分厂商（如百炼兼容模式）的 /models 只列大语言模型，
    // 不会把 ASR 模型列出来，据此判定失败会误伤正确配置。
    if (listed.length && !listed.some((id) => id === model || id.includes(String(model).split('/').pop()))) {
      return `语音接口连通（注意：模型列表中未见「${model}」，请核对模型名）`;
    }
    return '语音接口连通，模型可用';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('语音接口连接超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_ASR_CONFIG,
  ASR_PRESETS,
  MAX_CHUNK_BYTES,
  mimeOf,
  transcribe,
  testAsr,
};
