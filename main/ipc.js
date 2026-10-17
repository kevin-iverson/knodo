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

function registerIpc() {
  /* ---------- 分组 ---------- */
  ipcMain.handle('groups:list', () => db.listGroups());
  ipcMain.handle('groups:create', (_e, p) => db.createGroup(p));
  ipcMain.handle('groups:update', (_e, id, p) => db.updateGroup(id, p));
  ipcMain.handle('groups:delete', (_e, id) => db.deleteGroup(id));
  ipcMain.handle('groups:reorder', (_e, ids) => db.reorderGroups(ids));

  /* ---------- 任务 ---------- */
  ipcMain.handle('tasks:list', (_e, f) => db.listTasks(f));
  ipcMain.handle('tasks:get', (_e, id) => db.getTask(id));
  ipcMain.handle('tasks:create', (_e, p) => db.createTask(p));
  ipcMain.handle('tasks:update', (_e, id, p) => db.updateTask(id, p));
  ipcMain.handle('tasks:delete', (_e, id) => db.deleteTask(id));
  ipcMain.handle('tasks:toggle', (_e, id) => db.toggleTask(id));
  ipcMain.handle('tasks:reorder', (_e, ids) => db.reorderTasks(ids));
  ipcMain.handle('tasks:archiveCompleted', (_e, groupId) => db.archiveCompleted(groupId));
  ipcMain.handle('tasks:archive', (_e, id) => db.archiveTask(id));
  ipcMain.handle('tasks:unarchive', (_e, id) => db.unarchiveTask(id));
  ipcMain.handle('tasks:subtasks', (_e, parentId) => db.listSubtasks(parentId));

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
  ipcMain.handle('tags:list', () => db.listTags());
  ipcMain.handle('tags:create', (_e, name, color) => db.createTag(name, color));
  ipcMain.handle('tags:delete', (_e, id) => db.deleteTag(id));

  /* ---------- 统计 ---------- */
  ipcMain.handle('stats:overview', () => db.overview());
  ipcMain.handle('stats:trend', (_e, days) => db.dailyTrend(days));

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
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:getVersion', () => app.getVersion());
}

module.exports = { registerIpc };
