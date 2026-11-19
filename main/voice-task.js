'use strict';
/**
 * 快速语音录入任务（全局快捷键按一下开始 / 再按一下停止）。
 *
 * 三条不变量，改代码前先读：
 * 1. **音频识别后即删**：录音只在内存与系统临时目录里过一遍，ASR 完成后立刻 unlink。
 *    不进 recordings/、不进附件系统、不进备份包 —— 用户要的是"说一句变一条任务"，不是又一份会议录音。
 * 2. **识别与落库分离**：submit() 只做 ASR + AI 提取、只返回草稿，一个字节都不写库；
 *    commit() 只吃用户勾完的数组。中间那段是"用户可能全不选"的地带，不能有副作用。
 * 3. **这个模块不 require ipc.js**（会成环）：配置读取在这里自己实现，settings 键与
 *    ipc.js#getAsrConfig / getAiConfig 保持同一套；渲染层拿到的是信封，错误码靠 __code 还原。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const { ipcMain } = require('electron');
const db = require('./db');
const crypto = require('./crypto');
const asr = require('./asr');
const ai = require('./ai');
const dateU = require('./date-utils');

/** 20MB webm(opus) 约十几分钟，再长就该用「会议录音」而不是快速录入了 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** 口语转写很长时截断送模型，避免超上下文；转写原文仍完整回给卡片 */
const MAX_TRANSCRIPT_CHARS = 12000;
/** 任务描述里回带的转写原文上限（纯文本，不是音频） */
const MAX_NOTE_TRANSCRIPT = 2000;

let onDataChange = () => {};

/* ------------------------------ 小工具 ------------------------------ */

function userError(msg, code) {
  const e = new Error(msg);
  e.userFacing = true;
  if (code) e.code = code;
  return e;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ------------------------------ 配置 ------------------------------ */

/** 与 ipc.js#getAsrConfig 同键：语音转写单独一组 Key，和对话模型互不干扰 */
function readAsrConfig() {
  const baseUrl = db.getSetting('ai.asrBaseUrl', asr.DEFAULT_ASR_CONFIG.baseUrl);
  const model = db.getSetting('ai.asrModel', asr.DEFAULT_ASR_CONFIG.model);
  const { value: apiKey } = crypto.decryptApiKey(db.getSetting('ai.asrKey', ''));
  return { baseUrl, model, apiKey };
}

/** 与 ipc.js#getAiConfig 同键：AI 提取待办走对话模型 */
function readChatConfig() {
  const baseUrl = db.getSetting('ai.baseUrl', ai.DEFAULT_CONFIG.baseUrl);
  const model = db.getSetting('ai.model', ai.DEFAULT_CONFIG.model);
  const { value: apiKey } = crypto.decryptApiKey(db.getSetting('ai.apiKey', ''));
  return { baseUrl, model, apiKey };
}

/** 给卡片看的配置快照：只报"有没有 Key"，绝不下发 Key 本身 */
function status() {
  const a = readAsrConfig();
  const c = readChatConfig();
  return {
    asr: { model: a.model, baseUrl: a.baseUrl, hasKey: !!a.apiKey },
    ai: { model: c.model, hasKey: !!c.apiKey },
  };
}

/* ------------------------------ 提取待办 ------------------------------ */

/**
 * 口语转写 → 待办草稿的系统提示。
 * 输出格式刻意与截图识别（ai.js#SHOT_SYSTEM_PROMPT）一致，直接复用 parseShotReply 解析；
 * 差别只在输入是口语：先滤掉语气词与寒暄，只留"要动手做的事"。
 * 日期与截图卡同规则：明确的日历词（明天 / 本周五 / 11月25日）换算，模糊说法留空。
 */
const VOICE_SYSTEM_PROMPT = [
  '你在把一段中文语音转写稿变成待办清单。说话人是口语表达，会有语气词、重复、跑题。',
  '硬性要求：',
  '1. 只提取「需要有人动手去做」的事项；寒暄、复述、已经做完的事都不要；',
  '2. 最多 8 条，按说话人强调的程度从高到低排序；一件都没有就返回空数组；',
  '3. title 是一句可执行的动宾短语，不超过 30 字，去掉「嗯」「那个」「记得哦」这类口头前缀；',
  '4. note 只补转写里明确说出的关键信息（时间、人名、地点、金额、编号），没有就留空字符串，不要自己编；',
  '5. priority 只能是 0（低）/ 1（中）/ 2（高）/ 3（紧急）；说话人没强调就给 1，不要瞎猜；',
  '6. due 是计划完成日期，格式 YYYY-MM-DD：说了「明天」「后天」「本周五」「下周一上午」这类明确的日子，',
  '   按末尾给出的今天换算；说了具体日期就照写；「尽快」「这几天」这种说不准的填 null —— 绝不编一个日子凑数；',
  '7. summary 一句话概括这段话说了什么（不超过 40 字）；',
  '8. 只输出 JSON，不要 Markdown 代码块，不要任何解释文字。',
  '输出格式：{"summary":"...","tasks":[{"title":"...","note":"...","priority":1,"due":null}]}',
].join('\n');

/**
 * 提交录音：ASR 转写 → AI 提取待办草稿，不写库。
 * @param {object} payload { data:base64, mime:string }
 * @returns {Promise<object>} { summary, transcript, tasks, fallback?, asrModel, aiModel }
 */
async function submit(payload = {}) {
  const raw = String(payload.data || '').trim();
  const mime = String(payload.mime || 'audio/webm');
  if (!raw) throw userError('没有录到声音', 'EMPTY_AUDIO');

  let buf;
  try { buf = Buffer.from(raw, 'base64'); } catch (e) { throw userError('音频数据无效', 'BAD_AUDIO'); }
  if (!buf.length) throw userError('没有录到声音', 'EMPTY_AUDIO');
  if (buf.length > MAX_AUDIO_BYTES) {
    throw userError('录音太长（超过 20MB），用「会议录音」更合适', 'TOO_LONG');
  }

  const a = readAsrConfig();
  if (!a.apiKey) throw userError('还没有配置语音转写 Key：设置 → AI 与语音 → 语音转写', 'NO_ASR_KEY');
  const c = readChatConfig();
  if (!c.apiKey) throw userError('还没有配置 AI Key：设置 → AI 与语音', 'NO_API_KEY');

  const ext = /ogg/i.test(mime) ? 'ogg' : 'webm';
  const tmp = path.join(os.tmpdir(), `knodo-voice-${nodeCrypto.randomBytes(8).toString('hex')}.${ext}`);
  fs.writeFileSync(tmp, buf);

  try {
    // ---- ASR：语音 → 文字 ----
    let transcript = '';
    try {
      transcript = await asr.transcribe({
        ...a, filePath: tmp, language: 'zh', timeoutMs: 120000,
      });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (msg === 'NO_ASR_KEY') throw userError('还没有配置语音转写 Key', 'NO_ASR_KEY');
      if (/超时|timeout|aborted/i.test(msg)) throw userError('语音转写超时，说短一点再试', 'TIMEOUT');
      throw userError(msg, 'ASR_FAILED');
    }
    transcript = String(transcript || '').replace(/\s+/g, ' ').trim();
    if (!transcript) throw userError('没听清说了什么（可能只有静音），再说一次试试', 'EMPTY_TRANSCRIPT');

    // ---- AI：文字 → 待办草稿（与截图卡同结构） ----
    const input = transcript.length > MAX_TRANSCRIPT_CHARS
      ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript;
    let rawReply;
    try {
      rawReply = await ai.callLLM({
        ...c,
        messages: [
          // 今天日期必须给：口语里「明天 / 周五」要换算成具体日期，模型自己不知道今天是哪天
          { role: 'system', content: `${VOICE_SYSTEM_PROMPT}\n${dateU.todaySentence()}` },
          { role: 'user', content: `【语音转写】\n${input}` },
        ],
        temperature: 0.2,
        timeoutMs: 60000,
      });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/超时|timeout|aborted/i.test(msg)) throw userError('AI 整理超时，请重试', 'TIMEOUT');
      if (/NO_API_KEY/.test(msg)) throw userError('还没有配置 AI Key：设置 → AI 与语音', 'NO_API_KEY');
      throw userError(msg, 'RECOGNIZE_FAILED');
    }

    let parsed = null;
    try { parsed = ai.parseShotReply(rawReply); } catch (e) { parsed = null; }

    // 兜底：AI 没拆出待办，也别让用户空手 —— 转写稿截一条草稿进卡，标题随便改，不直接落库
    if (!parsed || !parsed.tasks.length) {
      const title = transcript.replace(/^[\s，。,.!！?？]+/, '').slice(0, 30) || '语音录入';
      return {
        summary: '',
        transcript,
        tasks: [{ title, note: transcript.slice(0, 200), priority: 1, due: '' }],
        fallback: 'text',
        asrModel: a.model,
        aiModel: c.model,
      };
    }
    return {
      summary: parsed.summary,
      transcript,
      tasks: parsed.tasks,
      asrModel: a.model,
      aiModel: c.model,
    };
  } finally {
    // 识别后丢弃：成功失败都不留音频（用户明确选的方案）
    try { fs.unlinkSync(tmp); } catch (e) { /* 已删或路径不存在 */ }
  }
}

/* ------------------------------ 落库 ------------------------------ */

/** 清单落点：与截图建任务、捕捉条、行内新建同口径（ui.lastAddGroupId → 第一个清单） */
function resolveGroup() {
  const last = Number(db.getSetting('ui.lastAddGroupId', '') || 0);
  if (Number.isFinite(last) && last > 0) {
    const g = db.getGroup(last);
    if (g) return { id: g.id, name: g.name };
  }
  const groups = db.listGroups();
  if (!groups.length) return null;
  return { id: groups[0].id, name: groups[0].name };
}

/**
 * 用户确认后建任务。
 * 音频已丢，只在描述里回带一段转写原文（纯文本，便于回看当时说了什么）；
 * 没有附件、没有 recordings 目录、不进备份包。
 */
function commit(payload = {}) {
  const today = dateU.todayLocal();
  const list = (Array.isArray(payload.tasks) ? payload.tasks : [])
    .map((t) => ({
      title: String((t && t.title) || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      note: String((t && t.note) || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      priority: clamp(Math.round(Number(t && t.priority) || 0), 0, 3),
      // 与截图卡同口径：模型只在话里**明说**日期时给 due，用户在卡上还能改；
      // 这里再校验一次，认不出就按今天算
      due: dateU.toDay(t && t.due) || today,
    }))
    .filter((t) => t.title);
  if (!list.length) throw userError('至少要留一条任务', 'EMPTY');

  const group = resolveGroup();
  if (!group) throw userError('还没有清单，先在主窗口建一个', 'NO_GROUP');

  const transcript = String(payload.transcript || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_TRANSCRIPT);
  const taskIds = [];
  list.forEach((t) => {
    const task = db.createTask({
      title: t.title,
      groupId: group.id,
      planStart: t.due,
      planEnd: t.due,
      priority: t.priority,
    });
    taskIds.push(task.id);
    const parts = [];
    if (t.note && t.note !== transcript) parts.push(`<p>${escHtml(t.note)}</p>`);
    if (transcript) parts.push(`<p>语音原文：${escHtml(transcript)}</p>`);
    if (parts.length) {
      try { db.updateTask(task.id, { notes: parts.join('') }); } catch (e) { /* 描述写不进去不影响建任务 */ }
    }
  });

  try { db.setSetting('ui.lastAddGroupId', String(group.id)); } catch (e) { /* 非关键 */ }
  try { onDataChange({ created: taskIds.length }); } catch (e) { /* 刷新失败不影响已保存 */ }

  return {
    ok: true,
    created: taskIds.length,
    taskIds,
    group,
    // 卡片据此提示「有几条不在今天」（与截图卡同构）
    days: [...new Set(list.map((t) => t.due))],
    today,
  };
}

/* ------------------------------ IPC ------------------------------ */

function wrap(fn) {
  return async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (!(e && e.userFacing)) console.error('[voice]', e && e.message ? e.message : e);
      // __code 在 preload 的 envelope() 里还原成 { ok:false, code, message }，
      // 卡片靠它区分「去配置」(NO_ASR_KEY / NO_API_KEY) 与「重试」
      return { __error: (e && e.message) || String(e), __code: (e && e.code) || '' };
    }
  };
}

function registerIpc() {
  const on = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch (e) { /* 没注册过 */ }
    ipcMain.handle(channel, wrap(fn));
  };
  on('voice:status', () => status());
  on('voice:submit', (p) => submit(p || {}));
  on('voice:commit', (p) => commit(p || {}));
}

/**
 * @param {object} opts
 * @param {(payload:object) => void} [opts.onDataChange]
 */
function init(opts = {}) {
  onDataChange = opts.onDataChange || (() => {});
  registerIpc();
}

function destroy() { /* 无定时器、无暂存；临时文件在 submit 的 finally 里自清 */ }

module.exports = {
  init, destroy,
  // 快捷键 / IPC / 验收脚本直接调
  submit, commit, status,
  VOICE_SYSTEM_PROMPT,
};
