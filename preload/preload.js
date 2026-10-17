'use strict';
/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露安全的最小 API 面。
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 统一包装 invoke：
 * - 主进程返回 { __error } 时在这里抛出可读错误，渲染层用一个 try/catch 就能拿到 message；
 * - 主进程 handler 缺失 / 已崩溃时 Electron 抛的 "Error invoking remote method ..." 也转成简洁文案。
 * 背景：以前渲染层若忘记 catch，invoke 失败会被静默吞掉——按钮点了没任何反应。
 */
function call(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).then(
    (res) => {
      if (res && typeof res === 'object' && res.__error) {
        const err = new Error(res.__error);
        err.channel = channel;
        throw err;
      }
      return res;
    },
    (e) => {
      const raw = e && e.message ? e.message : String(e);
      const err = new Error(raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
      err.channel = channel;
      throw err;
    }
  );
}

contextBridge.exposeInMainWorld('api', {
  // 分组
  groups: {
    list: () => call('groups:list'),
    create: (p) => call('groups:create', p),
    update: (id, p) => call('groups:update', id, p),
    remove: (id) => call('groups:delete', id),
    reorder: (ids) => call('groups:reorder', ids),
  },
  // 任务
  tasks: {
    list: (f) => call('tasks:list', f),
    get: (id) => call('tasks:get', id),
    create: (p) => call('tasks:create', p),
    update: (id, p) => call('tasks:update', id, p),
    remove: (id) => call('tasks:delete', id),
    toggle: (id) => call('tasks:toggle', id),
    reorder: (ids) => call('tasks:reorder', ids),
    archiveCompleted: (groupId) => call('tasks:archiveCompleted', groupId),
    archive: (id) => call('tasks:archive', id),
    unarchive: (id) => call('tasks:unarchive', id),
    subtasks: (parentId) => call('tasks:subtasks', parentId),
  },
  // 标签
  tags: {
    list: () => call('tags:list'),
    create: (name, color) => call('tags:create', name, color),
    remove: (id) => call('tags:delete', id),
  },
  // 统计
  stats: {
    overview: () => call('stats:overview'),
    trend: (days) => call('stats:trend', days),
  },
  // AI 配置
  ai: {
    getConfig: () => call('ai:getConfig'),
    saveConfig: (p) => call('ai:saveConfig', p),
    clearKey: () => call('ai:clearKey'),
    test: (p) => call('ai:test', p),
  },
  // 报告
  report: {
    generate: (p) => call('report:generate', p),
    export: (p) => call('report:export', p),
  },
  // 数据导入 / 导出
  data: {
    export: () => call('data:export'),
    import: () => call('data:import'),
  },
  // AI 检索
  search: {
    ai: (keyword) => call('search:ai', keyword),
  },
  // 主题 / 强调色 / 界面偏好
  theme: {
    get: () => call('theme:get'),
    set: (mode) => call('theme:set', mode),
  },
  accent: {
    get: () => call('accent:get'),
    set: (hex) => call('accent:set', hex),
  },
  ui: {
    getDetailWidth: () => call('ui:getDetailWidth'),
    setDetailWidth: (w) => call('ui:setDetailWidth', w),
  },
  app: {
    quit: () => call('app:quit'),
    openExternal: (url) => call('app:openExternal', url),
    getVersion: () => call('app:getVersion'),
  },
  // 主进程事件
  on: (channel, cb) => {
    const allowed = ['ui:quick-add', 'ui:focus-task'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => cb(...args));
    }
  },
});
