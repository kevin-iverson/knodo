'use strict';
/**
 * IPC 处理器注册：将渲染进程的请求映射到数据库 / AI / 报告等模块。
 */
const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs');
const db = require('./db');
const crypto = require('./crypto');
const ai = require('./ai');
const report = require('./report');

function getAiConfig() {
  const baseUrl = db.getSetting('ai.baseUrl', ai.DEFAULT_CONFIG.baseUrl);
  const model = db.getSetting('ai.model', ai.DEFAULT_CONFIG.model);
  const stored = db.getSetting('ai.apiKey', '');
  const { value: apiKey, degraded } = crypto.decryptApiKey(stored);
  return { baseUrl, model, apiKey, hasKey: !!apiKey, encryptionDegraded: degraded };
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
  ipcMain.handle('tasks:delete', withDb((id) => db.deleteTask(id)));
  ipcMain.handle('tasks:toggle', withDb((id) => db.toggleTask(id)));
  ipcMain.handle('tasks:reorder', withDb((ids) => db.reorderTasks(ids)));
  ipcMain.handle('tasks:archiveCompleted', withDb((groupId) => db.archiveCompleted(groupId)));
  ipcMain.handle('tasks:archive', withDb((id) => db.archiveTask(id)));
  ipcMain.handle('tasks:unarchive', withDb((id) => db.unarchiveTask(id)));
  ipcMain.handle('tasks:subtasks', withDb((parentId) => db.listSubtasks(parentId)));

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
    return { ok: true, keyword: kw, tasks, summary, degraded, hasKey: cfg.hasKey };
  });

  /* ---------- 标签 ---------- */
  ipcMain.handle('tags:list', withDb(() => db.listTags()));
  ipcMain.handle('tags:create', withDb((name, color) => db.createTag(name, color)));
  ipcMain.handle('tags:delete', withDb((id) => db.deleteTag(id)));

  /* ---------- 统计 ---------- */
  ipcMain.handle('stats:overview', withDb(() => db.overview()));
  ipcMain.handle('stats:trend', withDb((days) => db.dailyTrend(days)));

  /* ---------- AI 配置 ---------- */
  ipcMain.handle('ai:getConfig', () => {
    const c = getAiConfig();
    // 不下发明文 Key 给渲染进程
    return { baseUrl: c.baseUrl, model: c.model, hasKey: c.hasKey, encryptionDegraded: c.encryptionDegraded, presets: ai.PRESETS };
  });
  ipcMain.handle('ai:saveConfig', (_e, { baseUrl, model, apiKey }) => {
    db.setSetting('ai.baseUrl', baseUrl);
    db.setSetting('ai.model', model);
    // 仅在用户输入了新 Key 时更新；留空表示保持原 Key 不变
    if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
      db.setSetting('ai.apiKey', crypto.encryptApiKey(apiKey));
    }
    return getAiConfig();
  });
  ipcMain.handle('ai:clearKey', () => {
    db.setSetting('ai.apiKey', '');
    return getAiConfig();
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

  /* ---------- 报告 ---------- */
  ipcMain.handle('report:generate', async (_e, params) => {
    const cfg = getAiConfig();
    const r = await report.generateReport(params, cfg);
    return r;
  });
  ipcMain.handle('report:export', async (_e, { content, defaultName, format }) => {
    const ext = format === 'txt' ? 'txt' : 'md';
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出报告',
      defaultPath: `${defaultName}.${ext}`,
      filters: [
        { name: ext === 'txt' ? '文本文件' : 'Markdown', extensions: [ext] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  });

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
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:getVersion', () => app.getVersion());
}

module.exports = { registerIpc };
