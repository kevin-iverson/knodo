'use strict';
/**
 * IPC 处理器注册：将渲染进程的请求映射到数据库 / AI / 报告等模块。
 */
const { ipcMain, dialog, shell, app, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const attachments = require('./attachments');
const crypto = require('./crypto');
const ai = require('./ai');
const asr = require('./asr');
const meeting = require('./meeting');
const recording = require('./recording');
const report = require('./report');
const { markdownToDocx } = require('./docx');
const shortcuts = require('./shortcuts');

function getAsrConfig() {
  const baseUrl = db.getSetting('ai.asrBaseUrl', asr.DEFAULT_ASR_CONFIG.baseUrl);
  const model = db.getSetting('ai.asrModel', asr.DEFAULT_ASR_CONFIG.model);
  const stored = db.getSetting('ai.asrKey', '');
  const { value: apiKey, degraded } = crypto.decryptApiKey(stored);
  return { baseUrl, model, apiKey, hasKey: !!apiKey, encryptionDegraded: degraded };
}

function getAiConfig() {
  const baseUrl = db.getSetting('ai.baseUrl', ai.DEFAULT_CONFIG.baseUrl);
  const model = db.getSetting('ai.model', ai.DEFAULT_CONFIG.model);
  const stored = db.getSetting('ai.apiKey', '');
  const { value: apiKey, degraded } = crypto.decryptApiKey(stored);
  return { baseUrl, model, apiKey, hasKey: !!apiKey, encryptionDegraded: degraded };
}

/** 取出对话模型调用参数（baseUrl / key / model） */
function chatConfig(cfg = getAiConfig()) {
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model };
}

/**
 * 润色配置：上次使用的提示词（ai.polishInstruction）与用户自建预设（ai.polishPresets）。
 * 内置预设由 ai.POLISH_PRESETS 下发，两者在界面上合并成一个下拉，但只持久化用户自己的那份。
 */
function getPolishConfig() {
  let custom = [];
  try {
    const raw = db.getSetting('ai.polishPresets', '[]');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) custom = parsed.filter((p) => p && p.label);
  } catch (e) {
    custom = []; // 数据损坏就当没有自建预设，不能因此让设置读不出来
  }
  return {
    instruction: db.getSetting('ai.polishInstruction', ''),
    presets: ai.POLISH_PRESETS,
    customPresets: custom.map((p) => ({ id: `custom:${p.label}`, label: p.label, instruction: p.instruction || '' })),
  };
}

/**
 * 把底层异常翻译成用户能理解的提示（保留原文便于排查）。
 */
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
  if (/UNIQUE constraint failed/i.test(raw)) {
    return `数据重复：${raw}`;
  }
  if (/NOT NULL constraint failed/i.test(raw)) {
    return `缺少必填字段：${raw}`;
  }
  return raw;
}

/**
 * 包装 IPC 处理器：把同步异常（数据库只读 / 磁盘满 / 约束冲突等）转成可预期的返回值，
 * 而不是让 invoke 的 Promise 被静默拒绝——渲染进程若没 catch，用户点了按钮会毫无反应。
 */
function guard(fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      console.error('[ipc]', e && e.message);
      return { __error: friendlyError(e) };
    }
  };
}

/** 取数据库连接，初始化失败时给出可读原因 */
function withDb(fn) {
  return guard(async (_e, ...args) => {
    if (!db.isReady()) {
      throw new Error(`数据库未就绪${db.getInitError() ? '：' + db.getInitError() : ''}`);
    }
    return fn(...args);
  });
}

function registerIpc() {
  // 录制文件目录（userData/recordings）：handler 里一律通过 recording 模块访问
  recording.init(app.getPath('userData'));

  /* ---------- 全局快捷键（可自定义） ---------- */
  ipcMain.handle('shortcuts:get', () => ({
    shortcuts: shortcuts.getConfig(),
    actions: shortcuts.ACTIONS,
    conflicts: shortcuts.KNOWN_CONFLICTS,
  }));
  ipcMain.handle('shortcuts:set', (_e, patch) => shortcuts.applyConfig(patch || {}));
  ipcMain.handle('shortcuts:reset', () => shortcuts.resetConfig());

  /* ---------- 分组 ---------- */
  ipcMain.handle('groups:list', withDb(() => db.listGroups()));
  ipcMain.handle('groups:create', withDb((p) => db.createGroup(p)));
  ipcMain.handle('groups:update', withDb((id, p) => db.updateGroup(id, p)));
  ipcMain.handle('groups:delete', withDb((id) => db.deleteGroup(id)));
  ipcMain.handle('groups:reorder', withDb((ids) => db.reorderGroups(ids)));

  /* ---------- 任务 ---------- */
  ipcMain.handle('tasks:list', withDb((f) => db.listTasks(f)));
  ipcMain.handle('tasks:get', withDb((id) => db.getTask(id)));
  ipcMain.handle('tasks:create', withDb((p) => db.createTask(p)));
  ipcMain.handle('tasks:update', withDb((id, p) => db.updateTask(id, p)));
  ipcMain.handle('tasks:delete', withDb((id) => {
    // 删除任务会连带删除子任务：先收集整棵子树，删库成功后一并清掉它们的附件文件
    const ids = db.subtreeTaskIds(id);
    const ok = db.deleteTask(id);
    ids.forEach((tid) => attachments.removeTaskDir(tid));
    return ok;
  }));
  ipcMain.handle('tasks:toggle', withDb((id) => db.toggleTask(id)));
  ipcMain.handle('tasks:reorder', withDb((ids) => db.reorderTasks(ids)));
  ipcMain.handle('tasks:archiveCompleted', withDb((groupId) => db.archiveCompleted(groupId)));
  ipcMain.handle('tasks:archive', withDb((id) => db.archiveTask(id)));
  ipcMain.handle('tasks:unarchive', withDb((id) => db.unarchiveTask(id)));
  ipcMain.handle('tasks:subtasks', withDb((parentId) => db.listSubtasks(parentId)));

  /* ---------- 任务附件 ---------- */
  /** 取任务的附件数组（任务不存在时抛出可读错误） */
  const taskAttachments = (taskId) => {
    const task = db.getTask(taskId);
    if (!task) throw new Error('任务不存在或已被删除');
    return Array.isArray(task.attachments) ? task.attachments : [];
  };
  const findAttachment = (taskId, attId) => {
    const entry = taskAttachments(taskId).find((a) => String(a.id) === String(attId));
    if (!entry) throw new Error('附件不存在（可能已被删除）');
    return entry;
  };
  /** 复制进附件目录并写回元数据；单个文件失败不影响其它文件 */
  const appendAttachments = (taskId, paths) => {
    const cur = taskAttachments(taskId);
    const added = [];
    const failed = [];
    for (const p of paths) {
      try {
        added.push(attachments.importFile(taskId, p));
      } catch (e) {
        failed.push(e && e.message ? e.message : String(e));
      }
    }
    if (!added.length) throw new Error(failed[0] || '没有可添加的附件');
    const next = db.setAttachments(taskId, [...cur, ...added]);
    return { attachments: next.attachments, added: added.length, failed };
  };

  // 选择本地文件添加（支持多选）
  ipcMain.handle('attachments:pick', withDb(async (taskId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '添加附件',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    return { ok: true, ...appendAttachments(taskId, filePaths) };
  }));

  // 拖拽添加：渲染层把 File 转成绝对路径后传进来
  ipcMain.handle('attachments:addPaths', withDb((taskId, paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
    if (!list.length) return { ok: false, message: '没有可添加的文件' };
    return { ok: true, ...appendAttachments(taskId, list) };
  }));

  // 用系统默认程序打开附件
  ipcMain.handle('attachments:open', withDb(async (taskId, attId) => {
    const entry = findAttachment(taskId, attId);
    if (!attachments.exists(entry)) throw new Error(`附件文件已丢失：${entry.name}`);
    const err = await shell.openPath(attachments.absPath(entry));
    if (err) throw new Error(`打开失败：${err}`);
    return { ok: true };
  }));

  // 在资源管理器中定位
  ipcMain.handle('attachments:reveal', withDb((taskId, attId) => {
    const entry = findAttachment(taskId, attId);
    if (!attachments.exists(entry)) throw new Error(`附件文件已丢失：${entry.name}`);
    shell.showItemInFolder(attachments.absPath(entry));
    return { ok: true };
  }));

  // 另存为（下载到用户指定位置）
  ipcMain.handle('attachments:saveAs', withDb(async (taskId, attId) => {
    const entry = findAttachment(taskId, attId);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存附件',
      defaultPath: entry.name,
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    attachments.saveAs(entry, filePath);
    return { ok: true, filePath };
  }));

  // 删除附件：先删文件再改元数据（文件缺失也允许删除记录）
  ipcMain.handle('attachments:remove', withDb((taskId, attId) => {
    const cur = taskAttachments(taskId);
    const entry = cur.find((a) => String(a.id) === String(attId));
    if (!entry) throw new Error('附件不存在（可能已被删除）');
    attachments.removeFile(entry);
    const next = db.setAttachments(taskId, cur.filter((a) => String(a.id) !== String(attId)));
    return { ok: true, attachments: next.attachments };
  }));

  /* ---------- AI 检索 ---------- */
  ipcMain.handle('search:ai', async (_e, keyword) => {
    const kw = (keyword || '').trim();
    if (!kw) return { ok: false, message: '请输入检索关键词' };
    const tasks = db.searchTasks(kw, 30);
    const cfg = getAiConfig();
    let summary = '';
    let degraded = !cfg.hasKey;
    if (cfg.hasKey) {
      try {
        summary = await ai.summarizeSearch(kw, tasks, cfg);
      } catch (e) {
        degraded = true;
        summary = `AI 总结失败：${e.message}`;
      }
    }
    // 持久化：每次检索都留一份记录（关键词 + 总结 + 命中任务快照），可在检索页回看
    let savedId = null;
    try {
      const rec = db.createSearch({
        keyword: kw, summary, task_count: tasks.length, tasks, degraded,
      });
      savedId = rec ? rec.id : null;
    } catch (e) {
      console.warn('[ipc] 保存检索历史失败', e && e.message);
    }
    return { ok: true, keyword: kw, tasks, summary, degraded, hasKey: cfg.hasKey, id: savedId };
  });

  /* ---------- AI 检索历史 ---------- */
  ipcMain.handle('search:history', withDb((limit) => db.listSearches(Number(limit) || 100)));
  ipcMain.handle('search:get', withDb((id) => db.getSearch(id)));
  ipcMain.handle('search:remove', withDb((id) => !!db.deleteSearch(id)));

  /* ---------- 标签 ---------- */
  ipcMain.handle('tags:list', withDb(() => db.listTags()));
  ipcMain.handle('tags:create', withDb((name, color) => db.createTag(name, color)));
  ipcMain.handle('tags:delete', withDb((id) => db.deleteTag(id)));

  /* ---------- 统计 ---------- */
  ipcMain.handle('stats:overview', withDb((p) => db.overview(p || {})));
  // 入参统一为 { range: '7d' | '1m' | '6m' | '1y' }（旧的数字天数仍兼容）
  ipcMain.handle('stats:trend', withDb((p) => db.dailyTrend(p)));

  /* ---------- AI 配置（对话 + 语音） ---------- */
  ipcMain.handle('ai:getConfig', () => {
    const c = getAiConfig();
    const a = getAsrConfig();
    // 不下发明文 Key 给渲染进程
    return {
      baseUrl: c.baseUrl, model: c.model, hasKey: c.hasKey,
      encryptionDegraded: c.encryptionDegraded, presets: ai.PRESETS,
      polish: getPolishConfig(),
      asr: {
        baseUrl: a.baseUrl, model: a.model, hasKey: a.hasKey,
        encryptionDegraded: a.encryptionDegraded, presets: asr.ASR_PRESETS,
      },
    };
  });
  ipcMain.handle('ai:saveConfig', (_e, p = {}) => {
    // 界面上合并展示的「设为默认」会连提示词一起带过来，这里顺手落库
    if (typeof p.polishInstruction === 'string') db.setSetting('ai.polishInstruction', p.polishInstruction);
    if (p.baseUrl !== undefined) db.setSetting('ai.baseUrl', p.baseUrl);
    if (p.model !== undefined) db.setSetting('ai.model', p.model);
    // 仅在用户输入了新 Key 时更新；留空表示保持原 Key 不变
    if (p.apiKey !== undefined && p.apiKey !== null && p.apiKey !== '') {
      db.setSetting('ai.apiKey', crypto.encryptApiKey(p.apiKey));
    }
    // ASR 独立一组配置：传了才更新，避免旧调用把它们清掉
    if (p.asrBaseUrl !== undefined) db.setSetting('ai.asrBaseUrl', p.asrBaseUrl);
    if (p.asrModel !== undefined) db.setSetting('ai.asrModel', p.asrModel);
    if (p.asrKey !== undefined && p.asrKey !== null && p.asrKey !== '') {
      db.setSetting('ai.asrKey', crypto.encryptApiKey(p.asrKey));
    }
    const c = getAiConfig();
    const a = getAsrConfig();
    return {
      baseUrl: c.baseUrl, model: c.model, hasKey: c.hasKey,
      encryptionDegraded: c.encryptionDegraded, presets: ai.PRESETS,
      polish: getPolishConfig(),
      asr: {
        baseUrl: a.baseUrl, model: a.model, hasKey: a.hasKey,
        encryptionDegraded: a.encryptionDegraded, presets: asr.ASR_PRESETS,
      },
    };
  });
  ipcMain.handle('ai:clearKey', () => {
    db.setSetting('ai.apiKey', '');
    return getAiConfig();
  });
  ipcMain.handle('ai:clearAsrKey', () => {
    db.setSetting('ai.asrKey', '');
    return getAsrConfig();
  });
  ipcMain.handle('ai:test', async (_e, { baseUrl, model, apiKey }) => {
    // 测试时允许使用临时 Key，优先使用传入值，否则用已保存值
    let key = apiKey;
    if (!key) key = getAiConfig().apiKey;
    if (!key) return { ok: false, message: '未配置 API Key' };
    try {
      await ai.testConnection({ baseUrl, apiKey: key, model });
      return { ok: true, message: '连接成功，模型响应正常' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  // 语音接口自检：拉取模型列表确认 Key 可用且模型存在（不产生音频计费）
  ipcMain.handle('ai:testAsr', async (_e, { baseUrl, model, apiKey } = {}) => {
    const saved = getAsrConfig();
    const key = apiKey || saved.apiKey;
    if (!key) return { ok: false, message: '未配置语音 API Key' };
    try {
      const message = await asr.testAsr({ baseUrl: baseUrl || saved.baseUrl, model: model || saved.model, apiKey: key });
      return { ok: true, message };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // 任务描述 AI 润色：返回纯文本，渲染层预览后再决定是否采纳
  ipcMain.handle('ai:polish', async (_e, { text, instruction } = {}) => {
    const src = String(text || '').trim();
    if (!src) return { ok: false, message: '没有可润色的内容' };
    if (src.length > 4000) return { ok: false, message: '描述过长（超过 4000 字），请先精简再润色' };
    const cfg = getAiConfig();
    if (!cfg.hasKey) return { ok: false, message: '未配置 AI 接口 Key，请到顶部菜单栏「AI 设置」中填写' };
    try {
      const polished = await ai.polishText(src, chatConfig(cfg), instruction);
      return { ok: true, text: polished };
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : '润色失败' };
    }
  });

  /**
   * 保存润色提示词配置。
   * - instruction：写入默认提示词（下次打开润色弹窗自动带出）
   * - savePreset：{ label, instruction } 时把当前提示词另存为自建预设（同名覆盖）
   * - deletePreset：按 label 删除一条自建预设（内置预设不可删）
   * 无论哪种操作都回传最新配置，界面直接用返回值重绘下拉，避免自己拼状态。
   */
  ipcMain.handle('ai:savePolish', (_e, p = {}) => {
    if (typeof p.instruction === 'string') db.setSetting('ai.polishInstruction', p.instruction);
    if (p.savePreset && p.savePreset.label) {
      const raw = db.getSetting('ai.polishPresets', '[]');
      let list = [];
      try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) list = parsed; } catch (e) { list = []; }
      const idx = list.findIndex((x) => x.label === p.savePreset.label);
      const item = { label: p.savePreset.label, instruction: p.savePreset.instruction || '' };
      if (idx >= 0) list[idx] = item; else list.push(item);
      db.setSetting('ai.polishPresets', JSON.stringify(list));
    }
    if (p.deletePreset) {
      const raw = db.getSetting('ai.polishPresets', '[]');
      let list = [];
      try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) list = parsed; } catch (e) { list = []; }
      db.setSetting('ai.polishPresets', JSON.stringify(list.filter((x) => x.label !== p.deletePreset)));
    }
    return getPolishConfig();
  });

  /* ---------- 报告 ---------- */
  ipcMain.handle('report:generate', withDb(async (params) => {
    const cfg = getAiConfig();
    return report.generateReport(params, cfg);
  }));
  // 导出格式表：Word 走 docx（OOXML），其余按纯文本写入
  const EXPORT_FORMATS = {
    txt: { ext: 'txt', label: '文本文件' },
    md: { ext: 'md', label: 'Markdown' },
    doc: { ext: 'docx', label: 'Word 文档' },
    docx: { ext: 'docx', label: 'Word 文档' },
  };
  /* ---------- 报告历史（持久化） ---------- */
  ipcMain.handle('report:save', withDb((p) => db.createReport(p || {})));
  ipcMain.handle('report:list', withDb((limit) => db.listReports(Number(limit) || 100)));
  ipcMain.handle('report:get', withDb((id) => db.getReport(id)));
  ipcMain.handle('report:update', withDb(({ id, patch }) => db.updateReport(id, patch || {})));
  ipcMain.handle('report:remove', withDb((id) => !!db.deleteReport(id)));

  ipcMain.handle('report:export', guard(async (_e, { content, defaultName, format }) => {
    const f = EXPORT_FORMATS[format] || EXPORT_FORMATS.md;
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出报告',
      defaultPath: `${defaultName}.${f.ext}`,
      filters: [
        { name: f.label, extensions: [f.ext] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    if (f.ext === 'docx') {
      fs.writeFileSync(filePath, markdownToDocx(content, { title: defaultName }));
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
    }
    return { ok: true, filePath };
  }));

  /* ---------- 会议录制 ---------- */
  // 可选录制源（屏幕 / 窗口），缩略图转 dataURL 给渲染层直接显示
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
  // 录制结束：把分片路径归档成一条会议记录
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
  // 导入已有录音 / 视频文件，跳过录制直接进转写流程
  ipcMain.handle('rec:importMedia', guard(async () => {
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
    // 顺带清理录制文件：会话目录名 = media_paths[0] 的父目录名
    const dirName = m && m.media_paths && m.media_paths[0] ? path.basename(path.dirname(m.media_paths[0])) : '';
    if (dirName) recording.deleteSession(dirName);
    return { ok: db.deleteMeeting(id) > 0 };
  }));

  // 语音转写：按分片顺序逐段上传，拼接成完整转写稿
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
        prompt: i > 0 ? parts[parts.length - 1].slice(-120) : '', // 用上一片结尾做上下文，减少断句错乱
      });
      parts.push(text);
    }
    const transcript = parts.join('\n').trim();
    if (!transcript) throw new Error('转写结果为空，可能整段都是静音');
    return db.updateMeeting(id, { transcript, status: missing.length ? 'transcribed-partial' : 'transcribed' });
  }));

  // 生成纪要 + 待办（依赖已转写文本）
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

  // 勾选的待办 → 写入任务表（可并入一个父任务下）
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

  /* ---------- 数据导入 / 导出 ---------- */
  ipcMain.handle('data:export', async () => {
    const data = db.exportData();
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出任务数据',
      defaultPath: `todo-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return {
      ok: true,
      filePath,
      counts: { groups: data.groups.length, tags: data.tags.length, tasks: data.tasks.length },
    };
  });
  ipcMain.handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入任务数据',
      properties: ['openFile'],
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || filePaths.length === 0) return { ok: false, canceled: true };
    try {
      const raw = fs.readFileSync(filePaths[0], 'utf8');
      const data = JSON.parse(raw);
      const counts = db.importData(data);
      return { ok: true, filePath: filePaths[0], counts };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  /* ---------- 应用 / 主题 ---------- */
  ipcMain.handle('theme:get', () => db.getSetting('theme', 'system'));
  ipcMain.handle('theme:set', (_e, mode) => {
    db.setSetting('theme', mode);
    return mode;
  });
  // 强调色（用于区分分组 / 标签的主色，仅影响新渲染的日历高亮等元素）
  ipcMain.handle('accent:get', () => db.getSetting('accent', ''));
  ipcMain.handle('accent:set', (_e, hex) => {
    db.setSetting('accent', hex || '');
    return db.getSetting('accent', '');
  });
  // 详情侧边栏宽度（px），0 表示使用默认宽度
  ipcMain.handle('ui:getDetailWidth', () => Number(db.getSetting('ui.detailWidth', '0')) || 0);
  ipcMain.handle('ui:setDetailWidth', (_e, width) => {
    const w = Math.max(0, Math.round(Number(width) || 0));
    db.setSetting('ui.detailWidth', String(w));
    return w;
  });
  // 侧边栏宽度（px），0 表示使用默认宽度
  ipcMain.handle('ui:getSidebarWidth', () => Number(db.getSetting('ui.sidebarWidth', '0')) || 0);
  ipcMain.handle('ui:setSidebarWidth', (_e, width) => {
    const w = Math.max(0, Math.round(Number(width) || 0));
    db.setSetting('ui.sidebarWidth', String(w));
    return w;
  });
  // 标签筛选：存到 settings，重启后仍保留（null 表示不筛选）
  ipcMain.handle('ui:getTagFilter', () => {
    const raw = db.getSetting('ui.tagFilter', '');
    const n = Number(raw);
    return raw === '' ? null : (Number.isFinite(n) ? n : null);
  });
  ipcMain.handle('ui:setTagFilter', (_e, id) => {
    const v = id == null || id === '' ? '' : String(Number(id));
    db.setSetting('ui.tagFilter', Number.isFinite(Number(id)) && v !== '' ? v : '');
    return true;
  });
  // 「今天」里刚完成、仍留在列表中的任务：连自然日一起存，跨天自动失效（不靠内存，切视图/重启都不丢）
  ipcMain.handle('ui:getTodayDone', () => {
    const raw = db.getSetting('ui.todayDone', '');
    if (!raw) return { day: '', ids: [] };
    try {
      const v = JSON.parse(raw);
      const ids = Array.isArray(v && v.ids) ? v.ids.map(Number).filter(Number.isFinite) : [];
      return { day: String((v && v.day) || ''), ids };
    } catch (e) {
      return { day: '', ids: [] };
    }
  });
  ipcMain.handle('ui:setTodayDone', (_e, { day, ids } = {}) => {
    const list = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
    if (!day || !list.length) db.setSetting('ui.todayDone', '');
    else db.setSetting('ui.todayDone', JSON.stringify({ day: String(day), ids: list }));
    return true;
  });
  // 任务列表里被折叠的分组（键为分组 id 字符串，未分组用 '__none'）：存 settings，重启后仍保持
  ipcMain.handle('ui:getCollapsedGroups', () => {
    const raw = db.getSetting('ui.collapsedGroups', '');
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  });
  ipcMain.handle('ui:setCollapsedGroups', (_e, keys) => {
    const list = Array.isArray(keys) ? keys.map(String).filter(Boolean) : [];
    db.setSetting('ui.collapsedGroups', list.length ? JSON.stringify(list) : '');
    return true;
  });
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:getVersion', () => app.getVersion());
}

module.exports = { registerIpc };
