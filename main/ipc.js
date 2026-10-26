'use strict';
/**
 * IPC 处理器注册：将渲染进程的请求映射到数据库 / AI / 报告等模块。
 */
const { ipcMain, dialog, shell, app, desktopCapturer, nativeTheme } = require('electron');
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
const autostart = require('./autostart');
const searchAssist = require('./search-assist');
const knowledge = require('./knowledge');
const sync = require('./sync');

/**
 * 附件相对路径 → 笔记正文里可引用的 todo-media:// URL。
 * 逐段 encodeURIComponent：中文 / 空格文件名也能正常显示（主进程侧解码回原路径）。
 */
function mediaUrlOf(entry) {
  const rel = String((entry && entry.path) || '').replace(/^\/+/, '');
  return `todo-media:///${rel.split('/').map(encodeURIComponent).join('/')}`;
}

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

/** 问答历史的「检索范围」标签：目录 id → 目录名（0 = 未分类），空 = 全部笔记 */
function kbScopeLabel(folderIds) {
  const ids = Array.isArray(folderIds)
    ? folderIds.map(Number).filter((n) => Number.isFinite(n))
    : [];
  if (!ids.length) return '全部笔记';
  return ids.map((id) => {
    if (id === 0) return '未分类';
    const f = db.getNoteFolder(id);
    return f ? f.name : `目录${id}`;
  }).join('、');
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

  /* ---------- AI 检索（含联想召回） ---------- */
  ipcMain.handle('search:ai', async (_e, keyword) => {
    const kw = (keyword || '').trim();
    if (!kw) return { ok: false, message: '请输入检索关键词' };

    /*
     * 检索分三步：
     *   1) 精确层：先走原 SQL LIKE（标题/描述/标签原样命中）。命中即优先返回，
     *      完全保留改造前的精确匹配能力；
     *   2) 联想层：无精确命中时，用 search-assist 在本地做同义词/缩写/近似拼写/
     *      状态/时间语义召回并打分，输出 Top 5 候选 + 命中依据；
     *   3) 语义重排：配了 Key 且本地置信度不足（非唯一匹配）时，让模型在候选池内
     *      重排并给出理由；失败不影响结果，降级到本地排序。
     */
    const exact = db.searchTasks(kw, 30);
    let result;
    if (exact.length) {
      result = {
        keyword: kw,
        // 精确命中：第一条视为高置信唯一匹配；多条并列则待确认
        type: exact.length === 1 ? 'unique' : 'candidates',
        tasks: exact.slice(0, 5).map((t, i) => ({
          ...t,
          match: {
            score: 100 - i,
            reasons: [`精确匹配「${kw}」`],
            relevance: i === 0 ? 100 : Math.max(40, 100 - i * 15),
            confidence: i === 0 ? 'high' : 'mid',
          },
        })),
        tried: [],
      };
      result.exactHit = true;
    } else {
      const pool = db.listTasks({ status: 'any' });
      result = searchAssist.suggest(pool, kw, { topN: 5 });
      result.exactHit = false;
    }

    const cfg = getAiConfig();
    let summary = '';
    let degraded = !cfg.hasKey;
    let reranked = false;

    /*
     * 语义重排（可选，仅在配了 Key 时）：
     *   - 唯一匹配跳过：答案已经确定，再问模型只是浪费时间；
     *   - 候选 >= 2 条：让模型在这些候选里挑出真正相关的并给出理由；
     *   - 本地零召回：给模型看最近更新的 20 条，让它在"字面完全无关"时做纯语义兜底。
     * 无论哪种情况，模型都只能在给定池里选 —— 不会凭空造出库里没有的任务。
     * 重排失败归入 degraded，不影响本地结果返回。
     */
    const tryRerank = async () => {
      if (result.type === 'unique') return;
      const poolForAi = result.tasks.length >= 2
        ? result.tasks
        : db.listTasks({ status: 'any' })
          .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
          .slice(0, 20)
          .map((t) => ({
            ...t,
            match: t.match || { score: 0, reasons: ['AI 语义召回'], relevance: 50, confidence: 'low' },
          }));
      if (!poolForAi.length) return;

      const ranked = await ai.rankSearchCandidates(kw, poolForAi, cfg);
      const keep = ranked.filter((x) => x.relevant);
      if (!keep.length) return; // 模型认为都不相关 → 保留本地判断（可能是 none）

      const byId = new Map(poolForAi.map((t) => [Number(t.id), t]));
      const reasonsById = new Map(keep.map((x) => [Number(x.id), x.reason]));
      const ordered = [];
      for (const x of keep) {
        const t = byId.get(Number(x.id));
        if (!t) continue;
        ordered.push({
          ...t,
          match: { ...(t.match || {}), aiReason: reasonsById.get(Number(x.id)) || '', aiRanked: true },
        });
      }
      // 本地候选里模型没提到的仍排在后面：AI 只做"提权"，不替我们做"否决"
      for (const t of poolForAi) {
        if (ordered.length >= 5) break;
        if (keep.some((x) => Number(x.id) === Number(t.id))) continue;
        ordered.push(t);
      }
      if (!ordered.length) return;
      result.tasks = ordered.slice(0, 5);
      reranked = true;
      if (result.type === 'none') result.type = 'candidates'; // 纯语义兜底救回了结果
      // 顺序已由模型重排，相关度条要跟着新顺序走，否则"排第一但条最短"会自相矛盾
      result.tasks.forEach((t, i) => {
        t.match = {
          ...(t.match || {}),
          relevance: i === 0 ? 100 : Math.max(35, 100 - i * 16),
          confidence: i === 0 ? 'mid' : (t.match || {}).confidence || 'low',
        };
      });
    };

    if (cfg.hasKey) {
      // 重排与总结各自 try：重排失败不能把总结也一并拖成失败
      try {
        await tryRerank();
      } catch (e) {
        console.warn('[ipc] AI 语义重排失败，沿用本地排序', e && e.message);
      }
      try {
        summary = await ai.summarizeSearch(kw, result.tasks, cfg);
      } catch (e) {
        degraded = true;
        summary = `AI 总结失败：${e.message}`;
      }
    }

    // 持久化：每次检索都留一份记录（关键词 + 总结 + 命中任务快照），可在检索页回看
    let savedId = null;
    try {
      const rec = db.createSearch({
        keyword: kw,
        summary,
        task_count: result.tasks.length,
        tasks: result.tasks,
        degraded,
      });
      savedId = rec ? rec.id : null;
    } catch (e) {
      console.warn('[ipc] 保存检索历史失败', e && e.message);
    }
    return {
      ok: true,
      keyword: kw,
      tasks: result.tasks,
      type: result.type,
      exactHit: !!result.exactHit,
      tried: result.tried || [],
      summary,
      degraded,
      reranked,
      hasKey: cfg.hasKey,
      id: savedId,
    };
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

  /* ---------- 笔记（Markdown 编辑 / 目录 / 标签） ---------- */
  ipcMain.handle('notes:list', withDb((f) => db.listNotes(f || {})));
  ipcMain.handle('notes:get', withDb((id) => db.getNote(id)));
  // 新建 / 更新后同步重建知识库索引：笔记保存即沉淀，不需要用户再点一次“同步”
  ipcMain.handle('notes:create', withDb((p) => {
    const note = db.createNote(p || {});
    if (note) knowledge.indexNote(note.id);
    return note;
  }));
  ipcMain.handle('notes:update', withDb((id, patch) => {
    const note = db.updateNote(id, patch || {});
    if (note) knowledge.indexNote(note.id);
    return note;
  }));
  ipcMain.handle('notes:archive', withDb((id, archived) => db.setNoteArchived(id, !!archived)));
  ipcMain.handle('notes:pin', withDb((id, pinned) => db.setNotePinned(id, !!pinned)));
  // 软删除：保留任务引用，返回被引用次数供界面提示影响面
  ipcMain.handle('notes:trash', withDb((id) => {
    const refs = db.listNoteTasks(id).length;
    const note = db.trashNote(id);
    if (note) knowledge.removeNote(note.id);
    return { note, refs };
  }));
  ipcMain.handle('notes:restore', withDb((id) => {
    const note = db.restoreNote(id);
    if (note) knowledge.indexNote(note.id);
    return note;
  }));
  // 彻底删除：先摘引用再删正文，返回被解除引用的任务 id
  ipcMain.handle('notes:purge', withDb((id) => {
    const res = db.purgeNote(id);
    knowledge.removeNote(id);
    // 文件本体随笔记一起清掉（库记录已删，不清理会留下孤儿文件）
    attachments.removeOwnerDir('note', id);
    return res;
  }));
  ipcMain.handle('notes:trashList', withDb(() => db.listTrash()));
  ipcMain.handle('notes:emptyTrash', withDb(() => ({ removed: db.emptyTrash() })));
  ipcMain.handle('notes:search', withDb((keyword, opts) => db.searchNotes(keyword, opts || {})));

  /* ---------- 笔记附件（图片粘贴 / 插入） ---------- */
  // 复用任务附件同一套落盘规则（main/attachments.js），只是宿主目录换成 note-<id>：
  // 正文里存 `todo-media:///<相对路径>`，不把 base64 塞进 Markdown。
  const noteAttachmentsOf = (noteId) => {
    const note = db.getNote(noteId);
    if (!note) throw new Error('笔记不存在或已被删除');
    return db.getNoteAttachments(noteId);
  };
  const findNoteAttachment = (noteId, attId) => {
    const entry = noteAttachmentsOf(noteId).find((a) => String(a.id) === String(attId));
    if (!entry) throw new Error('附件不存在（可能已被删除）');
    return entry;
  };

  ipcMain.handle('noteAttachments:list', withDb((noteId) => db.getNoteAttachments(noteId)));

  /** 选择本地图片插入（支持多选） */
  ipcMain.handle('noteAttachments:pick', withDb(async (noteId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '插入图片',
      buttonLabel: '插入',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true, entries: [] };
    const cur = noteAttachmentsOf(noteId);
    const entries = [];
    const failed = [];
    for (const p of filePaths) {
      try { entries.push(attachments.importInto('note', noteId, p)); }
      catch (e) { failed.push(e && e.message ? e.message : String(e)); }
    }
    if (!entries.length) throw new Error(failed[0] || '没有可插入的图片');
    const list = db.setNoteAttachments(noteId, [...cur, ...entries]);
    return { ok: true, entries, attachments: list, failed };
  }));

  /** 拖拽 / 文件管理器拖入：渲染层把 File 转成绝对路径后传进来 */
  ipcMain.handle('noteAttachments:addPaths', withDb((noteId, paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
    if (!list.length) return { ok: false, message: '没有可插入的文件', entries: [] };
    const cur = noteAttachmentsOf(noteId);
    const entries = [];
    const failed = [];
    for (const p of list) {
      try { entries.push(attachments.importInto('note', noteId, p)); }
      catch (e) { failed.push(e && e.message ? e.message : String(e)); }
    }
    if (!entries.length) throw new Error(failed[0] || '没有可插入的文件');
    const next = db.setNoteAttachments(noteId, [...cur, ...entries]);
    return { ok: true, entries, attachments: next, failed };
  }));

  /**
   * 粘贴截图：渲染层没有 fs 权限，把剪贴板图片的 data URL 传过来由主进程落盘。
   * @returns {{ok:boolean, entry:object, attachments:Array, url:string}} url 可直接写进 Markdown
   */
  ipcMain.handle('noteAttachments:pasteImage', withDb((noteId, dataUrl, name = '') => {
    const cur = noteAttachmentsOf(noteId);
    const entry = attachments.importDataUrl('note', noteId, dataUrl, name);
    const list = db.setNoteAttachments(noteId, [...cur, entry]);
    return { ok: true, entry, attachments: list, url: mediaUrlOf(entry) };
  }));

  ipcMain.handle('noteAttachments:remove', withDb((noteId, attId) => {
    const cur = noteAttachmentsOf(noteId);
    const entry = cur.find((a) => String(a.id) === String(attId));
    if (!entry) throw new Error('附件不存在（可能已被删除）');
    attachments.removeFile(entry);
    const list = db.setNoteAttachments(noteId, cur.filter((a) => String(a.id) !== String(attId)));
    return { ok: true, attachments: list };
  }));

  ipcMain.handle('noteAttachments:open', withDb(async (noteId, attId) => {
    const entry = findNoteAttachment(noteId, attId);
    if (!attachments.exists(entry)) throw new Error(`文件已丢失：${entry.name}`);
    const err = await shell.openPath(attachments.absPath(entry));
    if (err) throw new Error(`打开失败：${err}`);
    return { ok: true };
  }));

  ipcMain.handle('noteAttachments:reveal', withDb((noteId, attId) => {
    const entry = findNoteAttachment(noteId, attId);
    if (!attachments.exists(entry)) throw new Error(`文件已丢失：${entry.name}`);
    shell.showItemInFolder(attachments.absPath(entry));
    return { ok: true };
  }));

  ipcMain.handle('noteAttachments:saveAs', withDb(async (noteId, attId) => {
    const entry = findNoteAttachment(noteId, attId);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存图片',
      defaultPath: entry.name,
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    attachments.saveAs(entry, filePath);
    return { ok: true, filePath };
  }));

  ipcMain.handle('noteFolders:list', withDb(() => db.listNoteFolders()));
  ipcMain.handle('noteFolders:create', withDb((p) => db.createNoteFolder(p || {})));
  ipcMain.handle('noteFolders:update', withDb((id, p) => db.updateNoteFolder(id, p || {})));
  ipcMain.handle('noteFolders:delete', withDb((id) => ({ ok: !!db.deleteNoteFolder(id) })));

  ipcMain.handle('noteTags:list', withDb(() => db.listNoteTags()));
  ipcMain.handle('noteTags:create', withDb((name, color) => db.createNoteTag(name, color)));
  ipcMain.handle('noteTags:update', withDb((id, p) => db.updateNoteTag(id, p || {})));
  ipcMain.handle('noteTags:delete', withDb((id) => ({ ok: !!db.deleteNoteTag(id) })));

  /* ---------- 任务 ↔ 笔记（多对多） ---------- */
  ipcMain.handle('taskNotes:list', withDb((taskId) => db.listTaskNotes(taskId)));
  ipcMain.handle('taskNotes:set', withDb(({ taskId, noteIds }) => db.setTaskNotes(taskId, noteIds || [])));
  ipcMain.handle('taskNotes:link', withDb(({ taskId, noteId }) => db.linkTaskNote(taskId, noteId)));
  ipcMain.handle('taskNotes:unlink', withDb(({ taskId, noteId }) => db.unlinkTaskNote(taskId, noteId)));
  /** 引用了某笔记的任务（删除前的影响面提示） */
  ipcMain.handle('taskNotes:byNote', withDb((noteId) => db.listNoteTasks(noteId)));
  /** 一批任务的笔记数（列表页徽标，一次查询避免 N+1） */
  ipcMain.handle('taskNotes:counts', withDb((taskIds) => db.noteCountsForTasks(taskIds || [])));

  /* ---------- 知识库（笔记沉淀 / AI 检索接入） ---------- */
  ipcMain.handle('kb:list', withDb(() => db.listKnowledgeBases()));
  ipcMain.handle('kb:stats', withDb((id) => db.kbStats(id || knowledge.NOTES_KB_ID)));
  ipcMain.handle('kb:reindex', withDb(() => knowledge.indexAll()));
  ipcMain.handle('kb:indexNote', withDb((id) => knowledge.indexNote(id)));
  /** AI 提问：召回笔记片段 → 交给对话模型作答（无 AI 配置时降级为纯召回）。
   *  每次提问都落库（含降级 / 无命中），供问答弹窗回看与删除。
   *  folderIds：限定检索范围的笔记目录（分类），可多选，空/缺省 = 全部笔记。 */
  ipcMain.handle('kb:ask', guard(async (_e, { question, topK, noteIds, folderIds } = {}) => {
    if (!db.isReady()) throw new Error('数据库未就绪');
    const res = await knowledge.answer({ question, cfg: chatConfig(), topK, noteIds, folderIds });
    try {
      const rec = db.createKbQa({
        question,
        answer: res.answer,
        hits: res.hits,
        degraded: res.degraded,
        reason: res.reason || '',
        scope: kbScopeLabel(folderIds),
      });
      return { ...res, qaId: rec ? rec.id : null };
    } catch (e) {
      return res; // 历史落库失败不影响本次问答
    }
  }));
  /** 只做召回不调模型（界面「检索笔记」按钮用） */
  ipcMain.handle('kb:retrieve', withDb(({ query, topK, noteIds, folderIds } = {}) =>
    knowledge.retrieve({ query, topK, noteIds, folderIds })));
  /** 问答历史 */
  ipcMain.handle('kb:qaList', withDb((limit) => db.listKbQa(Number(limit) || 50)));
  ipcMain.handle('kb:qaGet', withDb((id) => db.getKbQa(id)));
  ipcMain.handle('kb:qaRemove', withDb((id) => ({ ok: !!db.deleteKbQa(id) })));

  /* ---------- 对外同步（导出给腾讯文档 / ima 等第三方） ---------- */
  // 任务 → Markdown 表格 / CSV（CSV 可直接导入腾讯文档表格）
  ipcMain.handle('sync:exportTasks', withDb(async (opts = {}) => {
    const format = opts.format === 'csv' ? 'csv' : 'md';
    const rows = sync.collectTasks(opts);
    if (!rows.length) return { ok: false, empty: true };
    const content = format === 'csv' ? sync.tasksToCsv(rows, opts) : sync.tasksToMarkdown(rows, opts);
    const ext = format === 'csv' ? 'csv' : 'md';
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出任务',
      defaultPath: sync.defaultName('任务', ext),
      filters: [
        { name: format === 'csv' ? 'CSV 表格' : 'Markdown', extensions: [ext] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath, count: rows.length };
  }));
  // 笔记 → 单个 Markdown 合集 / 每篇一个 .md 的压缩包（可直接上传 ima 知识库）
  ipcMain.handle('sync:exportNotes', withDb(async (opts = {}) => {
    const entries = sync.collectNotes(opts);
    if (!entries.length) return { ok: false, empty: true };
    const pack = opts.pack === 'single' ? 'single' : 'zip';
    const ext = pack === 'single' ? 'md' : 'zip';
    const payload = pack === 'single'
      ? Buffer.from(sync.notesToSingleMarkdown(entries, opts), 'utf8')
      : sync.notesToZip(entries, opts);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出笔记',
      defaultPath: sync.defaultName('笔记', ext),
      filters: [
        { name: pack === 'single' ? 'Markdown' : 'ZIP 压缩包', extensions: [ext] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, payload);
    return { ok: true, filePath, count: entries.length };
  }));

  /* ---------- 数据导入 / 导出 ---------- */
  ipcMain.handle('data:export', async () => {
    const data = db.exportData();
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出任务数据',
      defaultPath: `knodo-backup-${new Date().toISOString().slice(0, 10)}.json`,
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
      counts: {
        groups: data.groups.length,
        tags: data.tags.length,
        tasks: data.tasks.length,
        notes: (data.notes || []).length,
      },
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
      // 分块是派生数据，不随备份走：导入后立刻按正文重建笔记知识库索引
      let reindexed = null;
      try {
        reindexed = knowledge.indexAll();
      } catch (e) {
        console.error('[ipc] 导入后重建知识库索引失败', e && e.message);
      }
      return { ok: true, filePath: filePaths[0], counts, reindexed };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  /* ---------- 开机自启动（只读） ---------- */
  // 写入入口只有应用菜单「File → 开机自启动」（见 main.js 的 toggleAutoStart），
  // 这里只暴露状态读取，供界面核对系统里实际登记的启动项。
  ipcMain.handle('app:getAutoStart', () => autostart.getState());

  /* ---------- 应用 / 主题 ---------- */
  ipcMain.handle('theme:get', () => db.getSetting('theme', 'system'));
  ipcMain.handle('theme:set', (_e, mode) => {
    // 只存库不生效是这里以前的 bug：切换主题后窗口标题栏 / 原生菜单 / 滚动条
    // 仍停在旧主题，直到下次启动才变 —— 表现为「主题样式异常」。
    const m = ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
    db.setSetting('theme', m);
    nativeTheme.themeSource = m;
    return m;
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
  // 实用工具「实时薪资」的配置：月薪（元）+ 上班 / 下班时间（HH:MM）。
  // 只做「读得到 / 写回去了」的搬运，计算与校验都在渲染层（要按当前时间实时刷新，没必要过主进程）。
  ipcMain.handle('ui:getSalary', () => {
    const raw = db.getSetting('tool.salary', '');
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      return {
        monthly: Number(v.monthly) || 0,
        start: String(v.start || ''),
        end: String(v.end || ''),
      };
    } catch (e) {
      return null;
    }
  });
  ipcMain.handle('ui:setSalary', (_e, p = {}) => {
    const cfg = {
      monthly: Math.max(0, Number(p.monthly) || 0),
      start: String(p.start || ''),
      end: String(p.end || ''),
    };
    db.setSetting('tool.salary', JSON.stringify(cfg));
    return cfg;
  });
  // 实用工具（代码格式化 / 文本对比）的选项：语言 / 缩进 / 对比模式等。
  // 同样是纯搬运——格式化与对比都在渲染层做（要按需加载第三方库、实时响应输入，没必要过主进程）。
  // key 白名单：避免渲染层拿它当任意键值存储使用。
  const TOOL_PREF_KEYS = ['formatter', 'diff', 'json'];
  ipcMain.handle('ui:getToolPref', (_e, key) => {
    const k = TOOL_PREF_KEYS.includes(String(key || '')) ? String(key) : '';
    if (!k) return null;
    const raw = db.getSetting(`tool.${k}`, '');
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch (e) {
      return null;
    }
  });
  ipcMain.handle('ui:setToolPref', (_e, key, p) => {
    const k = TOOL_PREF_KEYS.includes(String(key || '')) ? String(key) : '';
    if (!k) return false;
    const v = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    db.setSetting(`tool.${k}`, JSON.stringify(v));
    return true;
  });
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:getVersion', () => app.getVersion());
}

module.exports = { registerIpc };
