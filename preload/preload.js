'use strict';
/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露安全的最小 API 面。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 分组
  groups: {
    list: () => ipcRenderer.invoke('groups:list'),
    create: (p) => ipcRenderer.invoke('groups:create', p),
    update: (id, p) => ipcRenderer.invoke('groups:update', id, p),
    remove: (id) => ipcRenderer.invoke('groups:delete', id),
    reorder: (ids) => ipcRenderer.invoke('groups:reorder', ids),
  },
  // 任务
  tasks: {
    list: (f) => ipcRenderer.invoke('tasks:list', f),
    get: (id) => ipcRenderer.invoke('tasks:get', id),
    create: (p) => ipcRenderer.invoke('tasks:create', p),
    update: (id, p) => ipcRenderer.invoke('tasks:update', id, p),
    remove: (id) => ipcRenderer.invoke('tasks:delete', id),
    toggle: (id) => ipcRenderer.invoke('tasks:toggle', id),
    reorder: (ids) => ipcRenderer.invoke('tasks:reorder', ids),
    archiveCompleted: (groupId) => ipcRenderer.invoke('tasks:archiveCompleted', groupId),
    archive: (id) => ipcRenderer.invoke('tasks:archive', id),
    unarchive: (id) => ipcRenderer.invoke('tasks:unarchive', id),
    subtasks: (parentId) => ipcRenderer.invoke('tasks:subtasks', parentId),
  },
  // 标签
  tags: {
    list: () => ipcRenderer.invoke('tags:list'),
    create: (name, color) => ipcRenderer.invoke('tags:create', name, color),
    remove: (id) => ipcRenderer.invoke('tags:delete', id),
  },
  // 统计
  stats: {
    overview: () => ipcRenderer.invoke('stats:overview'),
    trend: (days) => ipcRenderer.invoke('stats:trend', days),
  },
  // AI 配置
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:getConfig'),
    saveConfig: (p) => ipcRenderer.invoke('ai:saveConfig', p),
    clearKey: () => ipcRenderer.invoke('ai:clearKey'),
    test: (p) => ipcRenderer.invoke('ai:test', p),
  },
  // 报告
  report: {
    generate: (p) => ipcRenderer.invoke('report:generate', p),
    export: (p) => ipcRenderer.invoke('report:export', p),
  },
  // 数据导入 / 导出
  data: {
    export: () => ipcRenderer.invoke('data:export'),
    import: () => ipcRenderer.invoke('data:import'),
  },
  // AI 检索
  search: {
    ai: (keyword) => ipcRenderer.invoke('search:ai', keyword),
  },
  // 主题 / 应用
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (mode) => ipcRenderer.invoke('theme:set', mode),
  },
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },
  // 主进程事件
  on: (channel, cb) => {
    const allowed = ['ui:quick-add', 'ui:focus-task'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => cb(...args));
    }
  },
});
