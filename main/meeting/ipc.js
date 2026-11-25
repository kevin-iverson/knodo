'use strict';
/**
 * `rec:*` 与 `meeting:*` IPC 注册 / 注销（会议纪要插件，默认开启）。
 *
 * 铁律与 worklog / journal 一致：register() 前先 unregister()，
 * 关掉再开启时残留 handler 会抛 "Attempted to register a second handler"。
 * 开关通道 `meeting:pref/*` 不在这里，由 features.js 永远注册。
 *
 * 数据层（meetings 表、recording 文件）常驻；插件关闭只是没有 IPC、没有渲染层模块。
 */
const { ipcMain, app, dialog, shell, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const crypto = require('../crypto');
const ai = require('../ai');
const asr = require('../asr');
const meeting = require('../meeting');
const recording = require('../recording');

const CHANNELS = [
  'rec:listSources',
  'rec:startSession',
  'rec:saveChunk',
  'rec:discard',
  'rec:openFolder',
  'rec:finalize',
  'rec:importMedia',
  'meeting:list',
  'meeting:get',
  'meeting:update',
  'meeting:remove',
  'meeting:transcribe',
  'meeting:summarize',
  'meeting:importTodos',
];

function friendlyError(e) {
  const raw = e && e.message ? e.message : String(e);
  const code = e && e.code ? e.code : '';
  if (/readonly|read-only/i.test(raw) || code === 'SQLITE_READONLY') {
    return `数据库当前为只读，无法写入（${raw}）。请检查 todo.db 所在文件夹的权限，或是否被同步盘/杀毒软件锁定。`;
  }
  if (/SQLITE_BUSY|database is locked/i.test(raw) || code === 'SQLITE_BUSY') {
    return `数据库被占用，请稍后重试（${raw}）。`;
  }
  if (/SQLITE_FULL|disk I\/O error|no space left/i.test(raw)) {
    return `写入失败：磁盘空间不足或存储异常（${raw}）。`;
  }
  if (/UNIQUE constraint failed/i.test(raw)) return `数据重复：${raw}`;
  if (/NOT NULL constraint failed/i.test(raw)) return `缺少必填字段：${raw}`;
  return raw;
}

/** 与 ipc.js#guard 同构：把同步异常转成可预期的返回值，不让 invoke 静默拒绝 */
function guard(fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      console.error('[meeting:ipc]', e && e.message);
      return { __error: friendlyError(e) };
    }
  };
}

/** 与 ipc.js#withDb 同构：数据库未就绪时返回可读错误 */
function withDb(fn) {
  return guard(async (event, ...args) => {
    if (!db.isReady()) {
      throw new Error(`数据库未就绪${db.getInitError() ? '：' + db.getInitError() : ''}`);
    }
    return fn(...args);
  });
}

function getAsrConfig() {
  const baseUrl = db.getSetting('ai.asrBaseUrl', asr.DEFAULT_ASR_CONFIG.baseUrl);
  const model = db.getSetting('ai.asrModel', asr.DEFAULT_ASR_CONFIG.model);
  const { value: apiKey, degraded } = crypto.decryptApiKey(db.getSetting('ai.asrKey', ''));
  return { baseUrl, model, apiKey, hasKey: !!apiKey, encryptionDegraded: degraded };
}

function getAiConfig() {
  const baseUrl = db.getSetting('ai.baseUrl', ai.DEFAULT_CONFIG.baseUrl);
  const model = db.getSetting('ai.model', ai.DEFAULT_CONFIG.model);
  const { value: apiKey, degraded } = crypto.decryptApiKey(db.getSetting('ai.apiKey', ''));
  return { baseUrl, model, apiKey, hasKey: !!apiKey, encryptionDegraded: degraded };
}

function chatConfig(cfg = getAiConfig()) {
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model };
}

function register() {
  unregister();
  // registerIpc() 也会调用；重复调用是幂等的，这里保证插件单独挂载时也能工作
  recording.init(app.getPath('userData'));

  /* ---------- 录制（会议纪要插件的入口） ---------- */
  ipcMain.handle('rec:listSources', guard(async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 240, height: 140 },
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      displayId: s.display_id || '',
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
    }));
  }));
  ipcMain.handle('rec:startSession', guard(() => recording.createSession()));
  ipcMain.handle('rec:saveChunk', guard((_e, { sessionId, seq, data, ext }) => recording.saveChunk(sessionId, seq, data, ext)));
  ipcMain.handle('rec:discard', guard((_e, sessionId) => ({ ok: recording.deleteSession(sessionId) })));
  ipcMain.handle('rec:openFolder', guard((_e, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    else shell.openPath(recording.getRoot());
    return { ok: true };
  }));
  ipcMain.handle('rec:finalize', withDb((p = {}) => {
    const files = recording.sessionFiles(p.sessionId);
    return db.createMeeting({
      title: (p.title || '').trim() || '未命名会议',
      source_label: p.sourceLabel || '',
      mode: p.mode || 'audio',
      started_at: p.startedAt || undefined,
      duration_ms: Number(p.durationMs) || 0,
      media_paths: files,
      status: files.length ? 'recorded' : 'recorded',
    });
  }));
  ipcMain.handle('rec:importMedia', withDb(async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入会议录音 / 录像',
      properties: ['openFile'],
      filters: [
        { name: '音视频文件', extensions: ['webm', 'mp3', 'm4a', 'mp4', 'wav', 'ogg', 'flac', 'aac'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    const media = recording.importMedia(filePaths[0]);
    if (media.size > asr.MAX_CHUNK_BYTES) {
      recording.deleteSession(media.sessionId);
      throw new Error(
        `文件 ${(media.size / 1024 / 1024).toFixed(1)}MB 超过单次上传上限 ${asr.MAX_CHUNK_BYTES / 1024 / 1024}MB，`
        + '请先切成小段再导入'
      );
    }
    const m = db.createMeeting({
      title: path.basename(filePaths[0], path.extname(filePaths[0])) || '导入的会议',
      source_label: '外部导入',
      mode: 'audio',
      media_paths: [media.filePath],
    });
    return { ok: true, meeting: m };
  }));

  /* ---------- 会议纪要 ---------- */
  ipcMain.handle('meeting:list', withDb(() => db.listMeetings()));
  ipcMain.handle('meeting:get', withDb((id) => db.getMeeting(id)));
  ipcMain.handle('meeting:update', withDb((id, patch) => db.updateMeeting(id, patch)));
  ipcMain.handle('meeting:remove', withDb((id) => {
    const m = db.getMeeting(id);
    const dirName = m && m.media_paths && m.media_paths[0] ? path.basename(path.dirname(m.media_paths[0])) : '';
    if (dirName) recording.deleteSession(dirName);
    return { ok: db.deleteMeeting(id) > 0 };
  }));

  ipcMain.handle('meeting:transcribe', withDb(async ({ id, language }) => {
    const m = db.getMeeting(id);
    if (!m) throw new Error('会议记录不存在');
    const missing = (m.media_paths || []).filter((f) => !fs.existsSync(f));
    if (!m.media_paths || !m.media_paths.length) throw new Error('这条会议没有可转写的音频（可能已被清理）');
    if (missing.length === m.media_paths.length) throw new Error(`音频文件已丢失：${missing[0]}`);
    const cfg = getAsrConfig();
    if (!cfg.hasKey) throw new Error('未配置语音 API Key，请到顶部菜单栏「AI 设置」中填写语音接口');
    const parts = [];
    for (let i = 0; i < m.media_paths.length; i++) {
      const f = m.media_paths[i];
      if (!fs.existsSync(f)) continue;
      /* eslint-disable no-await-in-loop */
      const text = await asr.transcribe({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        filePath: f,
        language: language || 'zh',
        prompt: i > 0 ? parts[parts.length - 1].slice(-120) : '',
      });
      parts.push(text);
    }
    const transcript = parts.join('\n').trim();
    if (!transcript) throw new Error('转写结果为空，可能整段都是静音');
    return db.updateMeeting(id, { transcript, status: missing.length ? 'transcribed-partial' : 'transcribed' });
  }));

  ipcMain.handle('meeting:summarize', withDb(async (id) => {
    const m = db.getMeeting(id);
    if (!m) throw new Error('会议记录不存在');
    if (!m.transcript || !m.transcript.trim()) throw new Error('还没有转写文本，请先执行语音转写');
    const cfg = getAiConfig();
    if (!cfg.hasKey) throw new Error('未配置 AI 接口 Key，请到顶部菜单栏「AI 设置」中填写');
    const { summary, todos } = await meeting.processMeeting({
      transcript: m.transcript,
      meta: { title: m.title, startedAt: m.started_at, durationMs: m.duration_ms, mode: m.mode, sourceLabel: m.source_label },
      config: chatConfig(cfg),
    });
    return db.updateMeeting(id, { summary, todos, status: 'summarized' });
  }));

  ipcMain.handle('meeting:importTodos', withDb(({ id, todoIds, groupId, asSubtasks }) => {
    const m = db.getMeeting(id);
    if (!m) throw new Error('会议记录不存在');
    const picked = (m.todos || []).filter((t) => (todoIds || []).includes(t.id));
    if (!picked.length) return { ok: false, message: '没有勾选任何待办', created: 0 };

    let parentId = null;
    if (asSubtasks) {
      const parent = db.createTask({
        title: `${m.title} 的待办`,
        groupId: groupId || null,
        notes: `来源：会议纪要《${m.title}》`,
      });
      parentId = parent.id;
    }
    const created = picked.map((t) => {
      const lines = [];
      if (t.detail) lines.push(t.detail);
      if (t.assignee && t.assignee !== '未指定') lines.push(`负责人：${t.assignee}`);
      if (t.evidence) lines.push(`依据：${t.evidence}`);
      return db.createTask({
        title: t.title,
        groupId: groupId || null,
        parentId,
        notes: lines.join('\n'),
        priority: Number(t.priority) || 1,
        planEnd: t.due || null,
      });
    });
    return { ok: true, created: created.length, tasks: created };
  }));
}

function unregister() {
  for (const ch of CHANNELS) {
    try { ipcMain.removeHandler(ch); } catch (e) { /* 没注册过就算了 */ }
  }
}

module.exports = { register, unregister, CHANNELS };
