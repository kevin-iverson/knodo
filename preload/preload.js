'use strict';
/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露安全的最小 API 面。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
    // 移动分组：{ parentId, index } —— 换父级 / 调整同级顺序（index 省略 = 排到末尾）
    move: (id, p) => call('groups:move', id, p),
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
  // 重复事项 / 习惯：规则模板 CRUD + 生成预览 + 打卡统计。
  // 一条重复事项 = 一条普通任务；规则只是这条任务的属性，完成记录按发生日单独存。
  recurrences: {
    list: () => call('recur:list'),
    get: (id) => call('recur:get', id),
    create: (p) => call('recur:create', p),
    update: (id, p) => call('recur:update', id, p),
    setEnabled: (id, on) => call('recur:setEnabled', id, on),
    remove: (id) => call('recur:remove', id),
    skips: (id) => call('recur:skips', id),
    clearSkips: (id) => call('recur:clearSkips', id),
    stats: (id) => call('recur:stats', id),
    sync: () => call('recur:sync'),
    meta: () => call('recur:meta'),
    preview: (p) => call('recur:preview', p),
    forTask: (taskId) => call('recur:forTask', taskId),
    completions: (id) => call('recur:completions', id),
    completionsAll: (f) => call('recur:completionsAll', f || {}),
    setCompletion: (id, date, done) => call('recur:setCompletion', id, date, done),
    skipDay: (id, date) => call('recur:skipDay', id, date),
  },
  // 标签
  tags: {
    list: () => call('tags:list'),
    create: (name, color) => call('tags:create', name, color),
    remove: (id) => call('tags:delete', id),
  },
  // 任务附件：文件本体存在主进程的数据目录里，渲染层只拿元数据
  attachments: {
    pick: (taskId) => call('attachments:pick', taskId),
    addPaths: (taskId, paths) => call('attachments:addPaths', taskId, paths),
    open: (taskId, attId) => call('attachments:open', taskId, attId),
    reveal: (taskId, attId) => call('attachments:reveal', taskId, attId),
    saveAs: (taskId, attId) => call('attachments:saveAs', taskId, attId),
    remove: (taskId, attId) => call('attachments:remove', taskId, attId),
  },
  // 统计
  stats: {
    overview: (p) => call('stats:overview', p),
    trend: (p) => call('stats:trend', p),
  },
  // AI 配置（对话 + 语音）
  ai: {
    getConfig: () => call('ai:getConfig'),
    saveConfig: (p) => call('ai:saveConfig', p),
    clearKey: () => call('ai:clearKey'),
    test: (p) => call('ai:test', p),
    clearAsrKey: () => call('ai:clearAsrKey'),
    testAsr: (p) => call('ai:testAsr', p),
    polish: (p) => call('ai:polish', p),
    savePolish: (p) => call('ai:savePolish', p),
  },
  // 报告（含历史记录持久化）
  report: {
    generate: (p) => call('report:generate', p),
    export: (p) => call('report:export', p),
    save: (p) => call('report:save', p),
    list: (limit) => call('report:list', limit),
    get: (id) => call('report:get', id),
    update: (id, patch) => call('report:update', { id, patch }),
    remove: (id) => call('report:remove', id),
  },
  // 笔记（Markdown 编辑 / 目录 / 标签）
  notes: {
    list: (f) => call('notes:list', f),
    get: (id) => call('notes:get', id),
    create: (p) => call('notes:create', p),
    update: (id, patch) => call('notes:update', id, patch),
    archive: (id, archived) => call('notes:archive', id, archived),
    pin: (id, pinned) => call('notes:pin', id, pinned),
    trash: (id) => call('notes:trash', id),
    restore: (id) => call('notes:restore', id),
    purge: (id) => call('notes:purge', id),
    trashList: () => call('notes:trashList'),
    emptyTrash: () => call('notes:emptyTrash'),
    search: (keyword, opts) => call('notes:search', keyword, opts),
    // 导入本地 Markdown 文件 / 文件夹（kind: 'files' | 'dir'）
    importMd: (kind, opts) => call('notes:importMd', kind, opts || {}),
  },
  // 笔记图片 / 附件（复用任务附件落盘规则，宿主目录 note-<id>）
  noteAttachments: {
    list: (noteId) => call('noteAttachments:list', noteId),
    pick: (noteId) => call('noteAttachments:pick', noteId),
    addPaths: (noteId, paths) => call('noteAttachments:addPaths', noteId, paths),
    pasteImage: (noteId, dataUrl, name) => call('noteAttachments:pasteImage', noteId, dataUrl, name),
    remove: (noteId, attId) => call('noteAttachments:remove', noteId, attId),
    open: (noteId, attId) => call('noteAttachments:open', noteId, attId),
    reveal: (noteId, attId) => call('noteAttachments:reveal', noteId, attId),
    saveAs: (noteId, attId) => call('noteAttachments:saveAs', noteId, attId),
  },
  noteFolders: {
    list: () => call('noteFolders:list'),
    create: (p) => call('noteFolders:create', p),
    update: (id, p) => call('noteFolders:update', id, p),
    remove: (id) => call('noteFolders:delete', id),
  },
  noteTags: {
    list: () => call('noteTags:list'),
    create: (name, color) => call('noteTags:create', name, color),
    update: (id, p) => call('noteTags:update', id, p),
    remove: (id) => call('noteTags:delete', id),
  },
  // 任务 ↔ 笔记（多对多）
  taskNotes: {
    list: (taskId) => call('taskNotes:list', taskId),
    set: (taskId, noteIds) => call('taskNotes:set', { taskId, noteIds }),
    link: (taskId, noteId) => call('taskNotes:link', { taskId, noteId }),
    unlink: (taskId, noteId) => call('taskNotes:unlink', { taskId, noteId }),
    byNote: (noteId) => call('taskNotes:byNote', noteId),
    counts: (taskIds) => call('taskNotes:counts', taskIds),
  },
  // 知识库（笔记沉淀 / AI 检索）
  kb: {
    list: () => call('kb:list'),
    stats: (id) => call('kb:stats', id),
    reindex: () => call('kb:reindex'),
    indexNote: (id) => call('kb:indexNote', id),
    ask: (p) => call('kb:ask', p),
    retrieve: (p) => call('kb:retrieve', p),
    qaList: (limit) => call('kb:qaList', limit),
    qaGet: (id) => call('kb:qaGet', id),
    qaRemove: (id) => call('kb:qaRemove', id),
  },
  // 会议录制
  rec: {
    listSources: () => call('rec:listSources'),
    startSession: () => call('rec:startSession'),
    saveChunk: (p) => call('rec:saveChunk', p),
    discard: (sessionId) => call('rec:discard', sessionId),
    finalize: (p) => call('rec:finalize', p),
    importMedia: () => call('rec:importMedia'),
    openFolder: (filePath) => call('rec:openFolder', filePath),
  },
  // 会议纪要
  meeting: {
    list: () => call('meeting:list'),
    get: (id) => call('meeting:get', id),
    update: (id, patch) => call('meeting:update', id, patch),
    remove: (id) => call('meeting:remove', id),
    transcribe: (id, language) => call('meeting:transcribe', { id, language }),
    summarize: (id) => call('meeting:summarize', id),
    importTodos: (p) => call('meeting:importTodos', p),
  },
  // 笔记导出：笔记视图工具栏「📤 导出」与单篇「⬇ 导出」共用，产出图片内嵌的自包含 .md / .md 压缩包
  sync: {
    exportNotes: (p) => call('sync:exportNotes', p),
  },
  // 数据导入 / 导出
  data: {
    export: () => call('data:export'),
    import: () => call('data:import'),
  },
  // AI 检索（含历史记录持久化）
  search: {
    ai: (keyword) => call('search:ai', keyword),
    history: (limit) => call('search:history', limit),
    get: (id) => call('search:get', id),
    remove: (id) => call('search:remove', id),
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
    getSidebarWidth: () => call('ui:getSidebarWidth'),
    setSidebarWidth: (w) => call('ui:setSidebarWidth', w),
    getTagFilter: () => call('ui:getTagFilter'),
    setTagFilter: (id) => call('ui:setTagFilter', id),
    getTodayDone: () => call('ui:getTodayDone'),
    setTodayDone: (p) => call('ui:setTodayDone', p),
    // 上班鼓励器的月薪 + 上下班时间（设置 → 趣味功能；存 settings，下次打开直接回填）
    getSalary: () => call('ui:getSalary'),
    setSalary: (p) => call('ui:setSalary', p),
    // 实用工具（代码格式化 / 文本对比）的选项：存 settings，下次打开直接回填
    getToolPref: (key) => call('ui:getToolPref', key),
    setToolPref: (key, p) => call('ui:setToolPref', key, p),
    getCollapsedGroups: () => call('ui:getCollapsedGroups'),
    setCollapsedGroups: (keys) => call('ui:setCollapsedGroups', keys),
  },
  app: {
    quit: () => call('app:quit'),
    openExternal: (url) => call('app:openExternal', url),
    getVersion: () => call('app:getVersion'),
    // 检查更新：结果由主进程用原生对话框展示，这里只负责把动作叫起来
    checkUpdate: () => call('app:checkUpdate'),
    // 「用了 N 天了」的一次性提示：天数与「是否已问过」都由主进程判定，
    // 渲染层只在「今天全部做完」时叫它一次
    sponsorPrompt: () => call('app:sponsorPrompt'),
    // 开机自启动：读的是系统里实际登记的启动项，写会走主进程同一套 setLoginItemSettings
    getAutoStart: () => call('app:getAutoStart'),
    setAutoStart: (enabled) => call('app:setAutoStart', enabled),
    // 换数据目录 / 备份恢复：都是带确认与进度的主进程对话框，这里只负责把它叫起来
    openStorageDialog: () => call('app:openStorageDialog'),
    openBackupDialog: () => call('app:openBackupDialog'),
    // 渲染层生成的图片（Mermaid 图导出）另存为：只接受 data:image/png
    saveImage: (p) => call('app:saveImage', p),
  },
  /**
   * 设置中心用的只读环境信息（数据目录在哪、备份有几份）。
   * openPath 只接受 'data' | 'backup'，主进程侧同样按枚举校验。
   */
  env: {
    getStorageInfo: () => call('app:getStorageInfo'),
    getBackupInfo: () => call('app:getBackupInfo'),
    openPath: (kind) => call('app:openPath', kind),
  },
  /**
   * 桌面浮窗（单清单钉到桌面）。
   * 主窗口用它查询 / 切换「已钉」状态，浮窗自身用它读写自己那份投影。
   * 浮窗不拥有数据：所有内容都从主进程按 projection 实时读库。
   */
  desktop: {
    list: () => call('desktop:list'),
    pin: (kind, refId, opts) => call('desktop:pin', kind, refId, opts),
    unpin: (id) => call('desktop:unpin', id),
    togglePin: (kind, refId, opts) => call('desktop:togglePin', kind, refId, opts),
    get: (id) => call('desktop:get', id),
    toggleTask: (taskId) => call('desktop:toggleTask', taskId),
    deleteTask: (id, taskId) => call('desktop:deleteTask', id, taskId),
    addTask: (id, title) => call('desktop:addTask', id, title),
    openInMain: (taskId) => call('desktop:openInMain', taskId),
    update: (id, patch) => call('desktop:update', id, patch),
    fit: (id, h) => call('desktop:fit', id, h),
    size: (id, w) => call('desktop:size', id, w),
    hover: (id, on) => call('desktop:hover', id, on),
    menu: (id) => call('desktop:menu', id),
    show: (id) => call('desktop:show', id),
    hide: (id) => call('desktop:hide', id),
    resetPosition: (id) => call('desktop:resetPosition', id),
    redock: (id) => call('desktop:redock', id),
    // 贴桌面诊断（是否真的挂进桌面层 / 是否压在图标之上 / 原生能力是否可用），只读不改状态
    diagnostics: () => call('desktop:diagnostics'),
  },
  /**
   * 拖拽进来的 File 对象在 Electron 32+ 已没有 .path，必须用 webUtils 换绝对路径。
   * 拿到路径后再交给 attachments.addPaths 复制进数据目录。
   */
  pathForFile: (file) => {
    try {
      return (webUtils && webUtils.getPathForFile && webUtils.getPathForFile(file)) || '';
    } catch (e) {
      return '';
    }
  },
  /**
   * 全局快捷键（主进程 globalShortcut）。
   * 动作表只存在于主进程（main/shortcuts.js）：渲染层拿 list() 展示、拿 apply() 改键，
   * 不在两处各写一份默认值 —— 否则改默认键时必然漏掉一边。
   * apply 的返回里带 takenFrom（该组合原来属于哪个动作）与 message（可读的失败原因）。
   */
  keys: {
    list: () => call('keys:list'),
    apply: (actionId, accel) => call('keys:apply', actionId, accel),
    clear: (actionId) => call('keys:clear', actionId),
    reset: () => call('keys:reset'),
    clearAll: () => call('keys:clearAll'),
    health: () => call('keys:health'),
  },
  /**
   * 快速捕捉条（Ctrl+Alt+C）。
   * 捕捉条是独立窗口：它自己调 save / cycle / undo，主窗口只负责把"当前选中的清单"
   * 同步过去（setContext），让「从主窗口按 C」落到对的地方。
   */
  capture: {
    state: () => call('capture:state'),
    save: (title) => call('capture:save', title),
    undo: () => call('capture:undo'),
    cycle: () => call('capture:cycle'),
    setTarget: (id) => call('capture:setTarget', id),
    picker: (opts) => call('capture:picker', opts || {}),
    hide: () => call('capture:hide'),
    toggle: (opts) => call('capture:toggle', opts || {}),
    setContext: (groupId) => call('capture:setContext', groupId),
    openMain: () => call('capture:openMain'),
  },
  /**
   * 番茄钟（专注计时）。计时器在主进程（wall clock 对账），渲染层只发指令、
   * 订阅 focus:changed 事件并按「当前时间 - 段起点」重算显示。
   */
  focus: {
    state: () => call('focus:state'),
    start: (p) => call('focus:start', p || {}),
    togglePause: () => call('focus:togglePause'),
    settle: (outcome, note) => call('focus:settle', outcome, note),
    cancel: () => call('focus:cancel'),
    manualEnd: () => call('focus:manualEnd'),
    counts: (taskIds) => call('focus:counts', taskIds || []),
    today: () => call('focus:today'),
    timeline: (taskId) => call('focus:timeline', taskId),
  },
  // 主进程事件
  on: (channel, cb) => {
    const allowed = [
      'ui:quick-add', 'ui:focus-task', 'ui:ai-settings', 'ui:new-note',
      'ui:text-diff', 'ui:json-viewer', 'ui:import-md',
      // 全局快捷键 Ctrl+Shift+H：唤起主窗口并打开「笔记」弹窗
      'ui:notes-dock',
      // 主题（主进程已改好 nativeTheme，推一份当前值让界面跟进）
      'ui:theme-changed',
      // 全局快捷键：设置面板入口 / 快捷键变更（多条浮窗时同步刷新）/ 没有钉住清单时的提示
      'ui:settings', 'keys:changed', 'ui:no-desktop-pins',
      // 捕捉条显示（主进程在 show 之后推一份目标清单 / 草稿状态）
      'capture:show',
      // 桌面浮窗：浮窗重拉自己的投影 / 主窗口重绘 / 菜单里的已钉列表变化 / 清单被删除
      'desktop:invalidate', 'desktop:missing', 'desktop:collapsed', 'desktop:projection-changed',
      // 贴顶 dock 被拖离顶边 → 变回普通浮窗，渲染层要重新量高度
      'desktop:undocked',
      // 普通浮窗被贴回顶边（拖到顶部自动贴边 / ⋯ 菜单）→ 变回 dock，渲染层要切 dock 形态并收起
      'desktop:redocked',
      'ui:data-changed',
      // 重复事项：File 菜单打开管理面板 / 后台跨天生成后让列表跟上
      'ui:recurrence-manager', 'ui:recurrence-generated',
      // 日历：全局键 Ctrl+Alt+M / File 菜单「归档已完成任务」
      'ui:calendar', 'ui:archive-done',
      // 启动时的静默检查更新：发现新版只推一条轻提示，详情由 File → 检查更新 打开
      'ui:update-available',
      // 番茄钟：计时状态变化（开钟 / 暂停 / 结算 / 被打断）
      'focus:changed',
      // 趣味功能 → 上班鼓励器：主浮窗 / 卡片页
      'ui:encourager', 'ui:encourager-card',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => cb(...args));
    }
  },
});
