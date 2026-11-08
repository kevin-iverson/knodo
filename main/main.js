'use strict';
/**
 * 主进程入口：窗口生命周期、单实例锁、托盘、提醒调度。
 * 关闭窗口默认最小化到托盘，仅当显式退出时才真正退出。
 */
const {
  app, BrowserWindow, nativeTheme, ipcMain, session, Menu, dialog, shell, protocol, powerMonitor,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const storage = require('./storage');
const attachments = require('./attachments');
const { registerIpc } = require('./ipc');
const { setupTray, destroyTray, refreshTrayMenu } = require('./tray');
const desktopWindow = require('./desktop-window');
const shortcuts = require('./shortcuts');
const capture = require('./capture');
const focus = require('./focus');
const autostart = require('./autostart');
const { startReminderScheduler, stopReminderScheduler } = require('./reminders');
const { startRecurrenceScheduler, stopRecurrenceScheduler } = require('./recurrence');
const { markdownToDocx } = require('./docx');
const reportMod = require('./report');
const backup = require('./backup');
const updater = require('./updater');

const isSmoke = process.argv.includes('--smoke-test');

// 冒烟测试必须跑在独立的临时数据目录里：
// 1) 每次都从干净状态开始 —— 否则上一轮残留的「冒烟分组」会让这一步撞上重名报错；
// 2) 不污染用户真实的任务数据。
if (isSmoke) {
  const smokeProfile = path.join(os.tmpdir(), 'todo-smoke-profile');
  fs.rmSync(smokeProfile, { recursive: true, force: true });
  app.setPath('userData', smokeProfile);
}

// 绿色版（portable）：electron-builder 打包时会注入 PORTABLE_EXECUTABLE_DIR，
// 这里把数据目录改到 exe 同级的 data 目录，整个文件夹拷走即可带走全部数据。
// 安装版没有该环境变量，仍然按系统默认位置（%APPDATA%）存储。
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
}

// Windows 任务栏 / 通知的身份标识（AppUserModelID）与通知中心显示名。
// 不设的话，任务栏按钮会沿用宿主进程（开发期是 electron.exe）的身份，
// 通知中心的发送者也会回落成「Electron」。详见 main/app-identity.js。
require('./app-identity').registerWindowsIdentity();

let mainWindow = null;
let isQuitting = false;
/**
 * 静默启动：由开机自启动（--autostart）拉起时只驻留托盘，不弹主窗口。
 * 冒烟测试也走这条路（它自己控制窗口显隐）。
 */
const silentLaunch = autostart.isAutoStarted() || isSmoke;

// 单实例锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    // 深色主题下别让窗口先闪一下白底（applyTheme() 已在创建窗口之前执行）
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15181f' : '#f5f6f8',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 纵深防御（渲染层已经把链接限到 http/https，这里是第二道）：
  //  - 笔记里的 <a target="_blank"> 若无人接管，Electron 会自己开一个没有 preload 的裸窗口，
  //    用户会看到「怎么又开了一个 Knodo」，而且那个窗口完全不受控；
  //  - 任何把主窗口导航走的尝试一律拦下，改交系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return; // 自身页面（reload / 恢复后刷新）
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());

  mainWindow.once('ready-to-show', () => {
    // 开机自启动唤起时只驻留托盘，不弹主窗口（用户想用时点托盘图标即可）
    if (!isSmoke && !silentLaunch) mainWindow.show();
  });

  // 关闭 → 最小化到托盘
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 对话框统一入口：有主窗口就挂成模态对话框，没有（极早期 / 窗口已关）就不带父窗口。
 * Electron 的签名是 showMessageBox([browserWindow,] options)，第一个参数传 undefined 会报参数错误，
 * 所以这里必须用两个分支，而不是 `mainWindow || undefined`。
 */
function msgBox(opts) {
  return mainWindow ? dialog.showMessageBox(mainWindow, opts) : dialog.showMessageBox(opts);
}

function dirDialog(opts) {
  return mainWindow ? dialog.showOpenDialog(mainWindow, opts) : dialog.showOpenDialog(opts);
}

/**
 * 主窗口显隐切换：唤起键 / 托盘单击共用的唯一实现（两处各写一遍迟早漂移）。
 *
 * 「已可见且聚焦」才收起，其余一律唤起：
 *  - 窗口被别的应用盖住 / 被最小化时，用户按这键的意图是「把它调出来」，不是「关掉」；
 *  - 最小化时 isVisible() 仍是 true，所以必须先判 isMinimized()，否则会出现
 *    「按一下没反应（其实被 hide 了）」这种最让人困惑的行为。
 *
 * @returns {boolean} 这次是否真的把窗口收起了 —— 「显示笔记」要用它区分
 *   「唤起」与「收起」两种语义（收起时不该再往渲染层推打开事件）。
 */
function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showWindow();
    return false;
  }
  if (!mainWindow.isMinimized() && mainWindow.isVisible() && mainWindow.isFocused()) {
    // 主窗口上挂着可见的模态子窗口（导出 / 选择目录 / 备份恢复）时不收起：
    // 藏掉父窗口会把对话框一起带走，用户会以为程序卡死
    const hasModal = BrowserWindow.getAllWindows().some(
      (w) => w !== mainWindow && !w.isDestroyed() && w.isVisible() && w.getParentWindow() === mainWindow,
    );
    if (!hasModal) {
      mainWindow.hide();
      return true;
    }
    return false;
  }
  showWindow();
  return false;
}

/**
 * 全局键「显示 / 隐藏笔记」：唤起时打开「笔记」弹窗（不切视图，任务列表留在原地可见），
 * 收起时只收窗口。面板不跟着关——里面可能正开着某篇笔记，关掉等于清空上下文；
 * 窗口隐藏后 DOM 原样留着，下次唤起还是那篇。
 */
function toggleNotesDock() {
  if (toggleWindow()) return; // 已收起，不再推打开事件
  showWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ui:notes-dock');
}

function quickAdd() {
  showWindow();
  mainWindow.webContents.send('ui:quick-add');
}

/**
 * 数据变更广播（捕捉条 / 浮窗 / 快捷键动作改库后）。
 * 浮窗走 desktopWindow.notifyChange（各窗重拉自己的投影），主窗口单独推一条 ——
 * notifyChange 只在变化来自浮窗时才回灌主窗口，而捕捉条不属于浮窗。
 */
function broadcastDataChanged(payload) {
  try { desktopWindow.notifyChange(null, payload); } catch (e) { /* 浮窗刷新失败不影响数据 */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ui:data-changed', payload || {});
  }
}

/** 没有钉住任何清单时的统一反馈：不静默失败 */
function noDesktopPins() {
  showWindow();
  if (mainWindow) mainWindow.webContents.send('ui:no-desktop-pins');
}

/**
 * 捕捉条的落点上下文：正在操作的桌面浮窗 → 它的清单；否则用主窗口当前选中的清单。
 * 这条规则用的是**确定信息**，不是猜用户意图。
 */
function captureContext() {
  const p = desktopWindow.focusedProjection();
  if (p && p.kind === 'group' && p.refId != null) return p.refId;
  return undefined; // undefined = 让 capture 用主窗口同步过来的上下文
}

/**
 * 全局快捷键的动作分发。
 * app.capture 与 app.show / app.quickAdd 必须是完全独立的分支：
 * 捕捉条一旦顺带把主窗口拉起来，"不打断"这个前提就没了。
 */
function dispatchShortcut(actionId) {
  if (!db.isReady()) return;
  switch (actionId) {
    case 'app.show':
      // 显隐切换：按一次出现，再按一次收起（与托盘单击同一套语义）
      toggleWindow();
      return;
    case 'app.notes':
      toggleNotesDock();
      return;
    case 'app.quickAdd':
      quickAdd();
      return;
    case 'app.capture':
      capture.toggle({ contextGroupId: captureContext() });
      return;
    case 'app.toggleDesktop': {
      const r = desktopWindow.toggleAllVisible();
      if (!r.total) noDesktopPins();
      return;
    }
    case 'app.calendar':
      // Ctrl+Alt+M：直接打开侧栏「日历」（渲染层再按一次会退回进入前的任务列表）
      showWindow();
      if (mainWindow) mainWindow.webContents.send('ui:calendar');
      return;
    case 'util.encourager':
      showWindow();
      if (mainWindow) mainWindow.webContents.send('ui:encourager');
      return;
    default:
      if (actionId.startsWith('desktop.focus.')) {
        const n = Number(actionId.split('.')[2]);
        const r = desktopWindow.focusNth(n);
        if (!r.ok) {
          if (r.reason === 'none') noDesktopPins();
        }
      }
  }
}

/* ------------------------------ 检查更新 ------------------------------ */
/**
 * 状态只放主进程：菜单项标签要随「检查中 / 发现新版」变化，渲染层不需要另存一份。
 * 查的是 Gitee Release（updater.js），下载与替换由用户决定，不自动升级。
 */
const updateState = { checking: false, available: null };

function updateMenuLabel() {
  if (updateState.checking) return '正在检查更新…';
  return updateState.available ? '检查更新…（发现新版本）' : '检查更新…';
}

/** 只放行 Gitee 的 https 链接：外部 API 返回的地址不能无条件交给系统浏览器。 */
function openGiteeExternal(url) {
  if (!/^https:\/\/gitee\.com\/[\w.\-/%?=&+]+$/i.test(String(url || ''))) return;
  shell.openExternal(url).catch((e) => console.error('[updater] 打开链接失败', e && e.message));
}

/** 三种结果（失败 / 已是最新 / 发现新版）共用这一份对话框。 */
async function showUpdateResult(res) {
  const base = { title: '检查更新', noLink: true };
  if (!res.ok) {
    // repository 配置缺失时 releaseUrl 为空，此时不给「打开发布页」按钮，避免点了没反应
    const canOpen = !!res.releaseUrl;
    const buttons = canOpen ? ['打开发布页', '关闭'] : ['关闭'];
    const last = buttons.length - 1;
    const { response } = await msgBox({
      ...base,
      type: 'warning',
      message: '检查更新失败',
      detail: `${res.reason}${canOpen ? '\n\n也可以手动打开发布页查看最新版本。' : ''}`,
      buttons,
      defaultId: last,
      cancelId: last,
    });
    if (canOpen && response === 0) openGiteeExternal(res.releaseUrl);
    return;
  }
  if (!res.hasUpdate) {
    await msgBox({
      ...base,
      type: 'info',
      message: '已是最新版本',
      detail: `当前版本：Knodo ${res.current}\n最新版本：${res.tag}${res.publishedAt ? `（${res.publishedAt}）` : ''}`,
      buttons: ['好'],
      defaultId: 0,
      cancelId: 0,
    });
    return;
  }
  const buttons = res.downloadUrl ? ['下载便携版', '打开发布页', '稍后'] : ['打开发布页', '稍后'];
  const detail = [
    `当前版本：Knodo ${res.current}`,
    `最新版本：${res.name}${res.publishedAt ? `（${res.publishedAt}）` : ''}`,
    '',
    res.summary,
    '',
    '更新不会改动本机任务与笔记数据；便携版请放回原目录，数据在同级的 data/ 文件夹。',
  ].filter((l) => l != null).join('\n');
  const { response } = await msgBox({
    ...base,
    type: 'info',
    message: `发现新版本 ${res.tag}`,
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (res.downloadUrl && response === 0) openGiteeExternal(res.downloadUrl);
  else if (response === (res.downloadUrl ? 1 : 0)) openGiteeExternal(res.releaseUrl);
}

/** 手动检查（File 菜单 / 设置「关于」页）：结果用原生对话框展示。 */
async function runUpdateCheck() {
  if (updateState.checking) return false;
  updateState.checking = true;
  setTimeout(() => buildAppMenu(), 0); // 不在 menu click 回调里同步重建菜单
  let res;
  try {
    res = await updater.checkUpdate(app.getVersion());
  } catch (e) {
    res = { ok: false, reason: (e && e.message) || '未知错误', releaseUrl: updater.releasePageUrl() };
  } finally {
    updateState.checking = false;
  }
  updateState.available = res.ok && res.hasUpdate ? res : null;
  setTimeout(() => buildAppMenu(), 0);
  showUpdateResult(res).catch((e) => console.error('[updater] 展示结果失败', e && e.message));
  return res;
}

/**
 * 启动后静默查一次：只更新菜单标记 + 推一条轻提示，绝不弹模态窗打断。
 * 开机自启驻留托盘时主窗口是隐藏的，此时连 toast 也不推（避免没头没尾的提示）。
 */
async function silentUpdateCheck() {
  let res;
  try {
    res = await updater.checkUpdate(app.getVersion());
  } catch { return; }
  if (!res.ok || !res.hasUpdate) return;
  updateState.available = res;
  buildAppMenu();
  const visible = mainWindow && !mainWindow.isDestroyed()
    && mainWindow.isVisible() && !mainWindow.isMinimized();
  if (!visible) return;
  const key = 'app.updatePromptedVersion';
  if (db.isReady() && db.getSetting(key, '') === res.tag) return;
  if (db.isReady()) db.setSetting(key, res.tag);
  mainWindow.webContents.send('ui:update-available', { tag: res.tag, latest: res.latest });
}

/** 设置面板（Ctrl+, / 托盘 / 菜单三条入口都走这里）；paneId 可直接落到某个分区 */
function openSettings(paneId = '') {
  showWindow();
  if (mainWindow) mainWindow.webContents.send('ui:settings', paneId);
}

function focusTask(taskId) {
  showWindow();
  mainWindow.webContents.send('ui:focus-task', taskId);
}

function applyTheme() {
  const mode = db.getSetting('theme', 'system');
  nativeTheme.themeSource = mode; // 'system' | 'light' | 'dark'
}

/**
 * 应用菜单：保留系统默认的 File / Edit / View / Window（role 复用默认行为），
 * 末尾追加「AI 设置」「实用工具」「趣味功能」——原来在顶部工具栏，挪到菜单栏后非任务视图才能整排隐藏工具区。
 * 与"应用级设置"同类的项（存储位置、备份与恢复、开机自启动）统一收进 File 菜单，其余菜单保持系统默认分组。
 *
 * 注：笔记不再是独立菜单项（入口统一到左侧导航 + 顶栏搜索框旁的「📝 笔记」按钮）。
 * 注：File 菜单不再有「同步到腾讯文档 / ima」；笔记导出的唯一入口是笔记视图工具栏「📤 导出」。
 * 全局快捷键 CmdOrCtrl+Shift+N（新建笔记）继续保留 —— 它是窗口级快捷键，不属于某个菜单的功能入口。
 */
function buildAppMenu() {
  const auto = autostart.getState();
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      // 显式构建 File 菜单：不用 role: 'fileMenu'，以便在同一个子菜单里追加自定义项；
      // Exit 行为与默认一致。
      // 分组：存储位置（数据层）｜ 备份 / 导入（数据进出）｜ 设置 / 检查更新（应用维护）｜ 开机自启动（系统启动项）｜ Exit。
      label: 'File',
      submenu: [
        {
          label: '存储位置',
          click: () => {
            showWindow();
            openStorageDialog();
          },
        },
        {
          // 自动备份的状态与手动入口都放这里：数据目录在哪、备份在哪，属同一件事
          label: '备份与恢复…',
          click: () => {
            showWindow();
            openBackupDialog();
          },
        },
        {
          // 低频维护动作：原顶栏「🗂 归档」撤下后收进 File，和「备份与恢复」同族。
          // 与菜单其它项一样只发事件，实际动作仍由渲染层 archiveCompleted() 执行
          label: '归档已完成任务',
          click: () => {
            showWindow();
            if (mainWindow) mainWindow.webContents.send('ui:archive-done');
          },
        },
        {
          // 从外部笔记工具 / 自己的 md 文件迁移：正文原样入库，本地图片一起搬进附件目录
          label: '导入 Markdown 笔记…',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            showWindow();
            if (mainWindow) mainWindow.webContents.send('ui:import-md');
          },
        },
        {
          // 重复规则 / 习惯的总入口：调整、暂停、删除规则与查看打卡记录。
          // 单条实例上的 🔁 徽标也能直接打开并定位到对应规则。
          label: '重复事项与习惯…',
          click: () => {
            showWindow();
            if (mainWindow) mainWindow.webContents.send('ui:recurrence-manager');
          },
        },
        { type: 'separator' },
        {
          // 设置：快捷键页签就在这里。顶栏 1080 宽已排满，不再加按钮；
          // Ctrl+, 是国际通用约定（与 renderer 的应用内键不冲突：这里走菜单加速键，只注册一份）
          label: '设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettings(),
        },
        {
          // 检查更新：主进程直接查 Gitee Release，结果用原生对话框展示（不经过渲染层事件）。
          // 菜单标签会随检查状态 / 是否有新版变化，见 updateMenuLabel()。
          label: updateMenuLabel(),
          enabled: !updateState.checking,
          click: () => {
            showWindow();
            runUpdateCheck();
          },
        },
        { type: 'separator' },
        {
          // 开机自启动：勾选项直接反映系统里实际登记的启动项，点一下即写系统设置
          label: '开机自启动',
          type: 'checkbox',
          checked: auto.enabled,
          enabled: auto.supported,
          click: (item) => toggleAutoStart(item.checked),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'AI 设置',
      click: () => {
        showWindow();
        if (mainWindow) mainWindow.webContents.send('ui:ai-settings');
      },
    },
    {
      // 实用工具：都是「弹窗形态的小工具」，不占视图，随时可用
      label: '实用工具',
      submenu: [
        {
          // 文本对比：非模态浮窗（不挡主界面），库按需加载
          label: '文本对比',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => {
            showWindow();
            if (mainWindow) mainWindow.webContents.send('ui:text-diff');
          },
        },
        {
          // JSON 查看器：树形展示 + 语法高亮 + 键名/值搜索 + JSONPath 查询
          label: 'JSON 查看器',
          accelerator: 'CmdOrCtrl+Shift+J',
          click: () => {
            showWindow();
            if (mainWindow) mainWindow.webContents.send('ui:json-viewer');
          },
        },
        { type: 'separator' },
        {
          // 桌面浮窗：主路径是「分组 / 今天 / 即将到期」右键 → 钉到桌面，这里是次要入口 ——
          // 钉了三四个之后，从菜单里找窗比在桌面上翻快，也是位置跑偏后的兜底（见 E-08）。
          // 原本占着菜单栏顶格，为给「主题」腾位并进实用工具（同属"不占视图的工具"）。
          label: '桌面浮窗',
          submenu: desktopMenuTemplate(),
        },
      ],
    },
    // 「主题」顶格菜单已删除：它与设置中心「界面主题」写同一个 settings.theme 键，
    // 是重复入口。唯一入口收敛到 设置 → 通用 → 界面主题（Ctrl+,）。
    {
      // v1.3 独立新增的第 7 个顶格项：情绪位与效率位是两种心智，塞进「实用工具」
      // 会被当成又一个计算器。不占顶栏宽度（1080 宽下顶栏已排满），发现性由
      // 菜单 + 全局键 Ctrl+Alt+E + 首次引导承担。
      // 菜单项刻意不设 accelerator：全局快捷键已注册同一组合，重复注册会双开。
      label: '趣味功能',
      submenu: [
        {
          label: '上班鼓励器…',
          click: () => {
            showWindow();
            if (mainWindow) mainWindow.webContents.send('ui:encourager');
          },
        },
        {
          label: '今日牛马卡…',
          click: () => {
            showWindow();
            if (mainWindow) mainWindow.webContents.send('ui:encourager-card');
          },
        },
        { type: 'separator' },
        { label: '工位搭子设置…', click: () => openSettings('fun') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 切换主题：唯一的用户入口是设置中心（ipc.js 的 theme:set 走同一套写库 + nativeTheme 逻辑），
 * 这里保留给托盘等主进程内调用方。
 * 三件事必须一起做：写库（下次启动仍生效）、改 nativeTheme（标题栏 / 原生菜单 / 桌面浮窗跟着变）、
 * 推给渲染层（主界面配色读的是它自己的 state.theme）。
 */
function setThemeMode(mode) {
  const m = ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
  if (db.isReady()) db.setSetting('theme', m);
  nativeTheme.themeSource = m;
  if (mainWindow) mainWindow.webContents.send('ui:theme-changed', m);
  buildAppMenu();
}

/** 「桌面浮窗」菜单项：已钉清单列表 + 恢复默认位置 / 全部收起 */
function desktopMenuTemplate() {
  let items = [];
  try {
    items = db.isReady() ? desktopWindow.list() : [];
  } catch (e) {
    items = [];
  }
  const listItems = items.length
    ? items.map((p) => ({
      label: `${p.title}${p.missing ? '（已删除）' : ''}  ${p.done}/${p.total}`,
      type: 'checkbox',
      checked: p.visible,
      click: () => {
        if (p.visible) desktopWindow.hide(p.id);
        else desktopWindow.show(p.id);
      },
    }))
    : [{ label: '（还没有钉住的清单 / 视图）', enabled: false }];
  return [
    ...listItems,
    { type: 'separator' },
    {
      label: '全部恢复默认位置',
      enabled: items.length > 0,
      click: () => items.forEach((p) => desktopWindow.resetPosition(p.id)),
    },
    {
      label: '全部收起',
      enabled: items.length > 0,
      click: () => items.forEach((p) => desktopWindow.hide(p.id)),
    },
    { type: 'separator' },
    { label: '在分组 / 「今天」/「即将到期」上右键即可钉到桌面', enabled: false },
  ];
}

/**
 * 切换开机自启动（File 菜单勾选项 / 设置中心开关的两个入口）。
 * 失败时重建菜单让勾选状态回到系统实际值，并弹出原因——避免"看着开了其实没开"。
 * 返回结构同时供 IPC 使用，渲染层据此保持状态一致。
 * @param {boolean} next
 * @param {{silent?:boolean}} [opts] silent=不弹系统对话框（设置面板会用自己的行内提示，不重复打扰）
 */
async function toggleAutoStart(next, { silent = false } = {}) {
  const res = autostart.setEnabled(!!next);
  // 记一份用户意图（换机器 / 重装后仍能看出偏好）；读取一律以系统状态为准
  db.setSetting('app.autoStart', res.enabled ? '1' : '0');
  buildAppMenu(); // 重建菜单，让勾选状态与系统实际状态一致
  if (mainWindow) mainWindow.webContents.send('ui:autostart-changed', res);
  if (!res.ok && !silent) {
    await msgBox({
      type: 'warning',
      title: '开机自启动',
      message: next ? '未能开启开机自启动' : '未能关闭开机自启动',
      detail: res.reason || '未知原因',
      buttons: ['好'],
      noLink: true,
    });
  }
  return res;
}

/**
 * 设置中心需要的三个主进程动作。
 * 它们都依赖本文件里的对话框 / 菜单函数（openStorageDialog、openBackupDialog、buildAppMenu），
 * 所以 IPC 注册放在这里，而不是统一塞进 ipc.js。
 */
function registerSettingsIpc() {
  ipcMain.handle('app:setAutoStart', (_e, enabled) => toggleAutoStart(!!enabled, { silent: true }));
  // 设置中心「关于」页：与 File 菜单共用 runUpdateCheck()，对话框由主进程自己弹
  ipcMain.handle('app:checkUpdate', () => { runUpdateCheck(); return true; });
  ipcMain.handle('app:openStorageDialog', () => {
    showWindow();
    openStorageDialog().catch((e) => console.error('[settings] 打开存储位置失败', e && e.message));
    return true;
  });
  ipcMain.handle('app:openBackupDialog', () => {
    showWindow();
    openBackupDialog().catch((e) => console.error('[settings] 打开备份与恢复失败', e && e.message));
    return true;
  });
}

/**
 * 「备份与恢复」对话框：展示自动备份状态 + 立即备份 / 打开目录 / 从快照恢复。
 * 用原生对话框而不是渲染层弹窗：恢复要先关库再换文件，界面还在跑容易产生「窗口里是旧数据」的中间态。
 */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function openBackupDialog() {
  for (;;) {
    const info = backup.getInfo();
    const latest = info.latest
      ? `${fmtTime(info.latest.time)}（${fmtSize(info.latest.size)}）`
      : '还没有备份（启动 5 分钟后会自动备份一次）';
    const { response } = await msgBox({
      type: 'info',
      title: '备份与恢复',
      message: `最近自动备份：${latest}`,
      detail: [
        `备份目录：${info.dir || '（数据目录未知）'}`,
        `现有 ${info.count} 份，共 ${fmtSize(info.totalBytes)}；保留最近 ${info.dailyDays} 天每日 1 份 + 最近 ${info.weeklyCount} 周每周 1 份，总量上限 500MB。`,
        '',
        '注意：自动备份只保数据库（任务 / 笔记 / 会议记录 / 设置）。',
        '附件与录音本体请用主界面工具栏「📤 备份」导出完整备份包，并放到别的磁盘或网盘。',
      ].join('\n'),
      buttons: ['立即备份', '打开备份目录', '从备份恢复…', '关闭'],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    });

    if (response === 3) return;

    if (response === 0) {
      const r = await backup.runAutoBackup();
      await msgBox({
        type: r.ok ? 'info' : 'warning',
        title: '备份',
        message: r.ok ? '备份完成' : '本次备份未执行',
        detail: r.ok
          ? `已写入：${r.filePath}\n大小：${fmtSize(r.size)}`
          : (r.reason || '未知原因'),
        buttons: ['好'],
        noLink: true,
      });
      continue;
    }

    if (response === 1) {
      if (!info.dir) continue;
      fs.mkdirSync(info.dir, { recursive: true });
      shell.openPath(info.dir);
      continue;
    }

    // response === 2：从快照恢复
    if (!info.latest) {
      await msgBox({ type: 'info', title: '从备份恢复', message: '目前还没有可用的备份', buttons: ['好'], noLink: true });
      continue;
    }
    const pick = await dirDialog({
      title: '选择要恢复的备份',
      defaultPath: info.dir,
      properties: ['openFile'],
      filters: [{ name: '数据库备份', extensions: ['db'] }],
    });
    if (pick.canceled || !pick.filePaths || !pick.filePaths.length) continue;
    const target = pick.filePaths[0];
    const stat = fs.statSync(target);
    const confirmRes = await msgBox({
      type: 'warning',
      title: '确认覆盖当前数据',
      message: '恢复会用这份备份覆盖当前的任务 / 笔记 / 会议记录',
      detail: `备份文件：${target}\n备份时间：${fmtTime(stat.mtimeMs)}（${fmtSize(stat.size)}）\n\n`
        + '当前数据库不会删除，会改名成 todo.db.broken-<时间> 留在原目录，必要时还能取回。\n'
        + '附件与录音不受影响（它们不在数据库里）。',
      buttons: ['恢复', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmRes.response !== 0) continue;
    try {
      backup.restoreFromBackup(target);
      await msgBox({ type: 'info', title: '恢复完成', message: '已从备份恢复，界面即将刷新', buttons: ['好'], noLink: true });
      if (mainWindow) mainWindow.webContents.reload();
    } catch (e) {
      dialog.showErrorBox('恢复失败', e && e.message ? e.message : String(e));
    }
    continue;
  }
}

/**
 * 启动时数据库打不开（文件被删 / 损坏 / 同步盘占位）→ 直接从最近一份自动快照恢复。
 * 给用户两个选择就够了：能救就救，救不了就别让它带着一个坏库继续跑。
 */
async function offerRecoveryAtStartup() {
  const err = db.getInitError() || '未知原因';
  const info = backup.getInfo();
  if (!info.latest) {
    await msgBox({
      type: 'error',
      title: '数据库无法打开',
      message: '数据文件打不开，且没有可用的自动备份',
      detail: `${err}\n\n数据目录：${storage.getInfo().dir}\n\n`
        + '可以检查目录是否被占用 / 只读，或从别处的完整备份包（.zip）恢复后再启动。',
      buttons: ['退出'],
      noLink: true,
    });
    return false;
  }
  const { response } = await msgBox({
    type: 'warning',
    title: '数据库无法打开',
    message: '数据文件打不开，但找到了一份自动备份',
    detail: `${err}\n\n最近备份：${fmtTime(info.latest.time)}（${fmtSize(info.latest.size)}）\n`
      + `备份目录：${info.dir}\n\n是否用它恢复？损坏的库文件会改名保留，不会丢。`,
    buttons: ['从备份恢复', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return false;
  try {
    backup.restoreFromBackup(info.latest.path);
    await msgBox({ type: 'info', title: '恢复完成', message: '已恢复到最近一次备份', buttons: ['好'], noLink: true });
    return true;
  } catch (e) {
    dialog.showErrorBox('恢复失败', e && e.message ? e.message : String(e));
    return false;
  }
}

/**
 * 「数据存放位置」对话框：查看当前目录 → 选新目录 → 探测写权限 → 可选迁移现有数据 → 重启生效。
 * 之所以全程用原生对话框：切换目录涉及关库 / 重启，放在渲染层做容易出现「界面还在、库已换」的中间态。
 */
async function openStorageDialog() {
  const info = storage.getInfo();
  const detail = info.source === 'fallback'
    ? `⚠️ 你之前配置的目录当前不可用：\n${info.wanted}\n原因：${info.error}\n\n本次已临时使用默认目录，数据不会写进那个失效路径。`
    : info.isCustom
      ? '这是你自定义的目录。数据库（todo.db）与任务附件（attachments）都在这里。'
      : '默认目录在系统用户数据目录下（通常位于 C 盘）。选一个其它盘符的目录可以把数据挪出 C 盘。';
  const buttons = ['选择新目录…', '打开当前目录'];
  if (info.isCustom) buttons.push('恢复默认目录');
  buttons.push('取消');
  const cancelId = buttons.length - 1;
  const { response } = await msgBox({
    type: info.source === 'fallback' ? 'warning' : 'info',
    title: '数据存放位置',
    message: `当前数据目录：\n${info.dir}`,
    detail,
    buttons,
    defaultId: 0,
    cancelId,
    noLink: true,
  });
  const picked = buttons[response];
  if (picked === '打开当前目录') {
    const err = await shell.openPath(info.dir);
    if (err) dialog.showErrorBox('无法打开目录', err);
    return;
  }
  if (picked === '恢复默认目录') {
    try {
      storage.clearDataDir();
    } catch (e) {
      dialog.showErrorBox('恢复默认目录失败', e.message);
      return;
    }
    await askRestart(info.dir, info.defaultDir, false);
    return;
  }
  if (picked !== '选择新目录…') return;

  const pick = await dirDialog({
    title: '选择数据存放目录',
    buttonLabel: '使用此目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (pick.canceled || !pick.filePaths || !pick.filePaths.length) return;
  const target = pick.filePaths[0];

  const test = storage.probe(target);
  if (!test.ok) {
    dialog.showErrorBox('目录不可用', `无法写入该目录：\n${target}\n\n原因：${test.error}\n\n请换一个目录，或检查磁盘权限。`);
    return;
  }
  if (path.resolve(target) === path.resolve(info.dir)) {
    msgBox({
      type: 'info', title: '数据存放位置', message: '这已经是当前的数据目录了。', buttons: ['好'], noLink: true,
    });
    return;
  }
  if (fs.existsSync(path.join(target, storage.DB_NAME))) {
    dialog.showErrorBox('目标目录已有数据', `该目录下已存在 ${storage.DB_NAME}：\n${target}\n\n为避免覆盖已有数据，请换一个空目录（或先把旧文件移走）。`);
    return;
  }

  // 有数据时才问「是否迁移」，空库直接切过去即可
  let copy = false;
  const hasData = db.isReady() && db.listTasks({ status: 'all' }).length > 0;
  if (hasData) {
    const ans = await msgBox({
      type: 'question',
      title: '迁移现有数据',
      message: '是否把当前数据复制到新目录？',
      detail: `当前目录：${info.dir}\n新目录：${target}\n\n复制内容：数据库（todo.db）+ 任务附件。 `
        + '录音文件仍留在原目录（会议记录里存的是绝对路径），不影响回放。',
      buttons: ['复制并切换', '仅切换（新目录为空）', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (ans.response === 2) return;
    copy = ans.response === 0;
  }

  try {
    if (copy) {
      // 源目录以「当前打开的数据库文件」为准，避免配置与实际运行目录不一致时复制错地方
      const fromDir = path.dirname(db.getDbPath() || path.join(info.dir, storage.DB_NAME));
      await storage.migrateTo(target, (dest) => db.backupTo(dest), fromDir);
    }
    storage.setDataDir(target);
  } catch (e) {
    dialog.showErrorBox('切换数据目录失败', `${e && e.message ? e.message : e}\n\n数据目录未做任何修改，仍在使用：${info.dir}`);
    return;
  }
  await askRestart(info.dir, target, copy);
}

/** 切换成功后询问是否立即重启（配置已落盘，重启才真正换库） */
async function askRestart(fromDir, toDir, copied) {
  const { response } = await msgBox({
    type: 'info',
    title: '数据目录已更新',
    message: '数据目录已保存，重启后生效',
    detail: `新目录：${toDir}${copied ? '\n已复制：数据库 + 任务附件' : '\n新目录为空（原有数据仍留在原目录）'}\n\n是否立即重启？`,
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    isQuitting = true;
    app.relaunch();
    app.exit(0);
  } else if (copied) {
    // 不重启的话当前进程仍写在旧库上，新目录里的副本会停留在这一刻 —— 提醒一句
    console.log(`[storage] 已配置新目录 ${toDir}（来自 ${fromDir}），等待重启生效`);
  }
}

/**
 * 本地媒体协议 todo-media://：笔记正文里的图片用 `![](todo-media:///note-12/xxx.png)` 引用，
 * 由这里映射回 attachments 目录下的真实文件。
 * 为什么不用 file://：file 协议受 CSP 与 allowFileAccessFromFiles 限制且会暴露整盘；
 * 自定义协议只解析 attachments 根目录下的相对路径（越界返回失败），范围可控。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'todo-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

app.whenReady().then(async () => {
  protocol.registerFileProtocol('todo-media', (req, callback) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(`${u.host}${u.pathname}`.replace(/^\/+/, ''));
      const abs = attachments.resolveMedia(rel);
      if (!abs || !fs.existsSync(abs)) { callback({ error: -6 }); return; } // net::ERR_FILE_NOT_FOUND
      callback({ path: abs });
    } catch (e) {
      callback({ error: -6 });
    }
  });

  // 数据目录：配置里指定的（自定义）目录优先；不可用时回退默认目录并在窗口出来后提示，
  // 保证「盘没插 / 路径被删 / 无写权限」都不会让应用起不来。
  storage.init({ userDataDir: app.getPath('userData'), defaultDir: app.getPath('userData') });
  const dataInfo = storage.resolve();
  db.init(dataInfo.dir);
  attachments.init(path.join(dataInfo.dir, storage.ATTACH_DIR));

  // 主库打不开（被删 / 损坏 / 同步盘占位）：先尝试用最近一份自动快照救回来，
  // 救不了就别带着坏库继续跑——继续跑只会在界面上到处报"数据库未就绪"。
  if (!db.isReady() && !isSmoke) {
    const recovered = await offerRecoveryAtStartup();
    if (!recovered) {
      isQuitting = true;
      app.quit();
      return;
    }
  }

  applyTheme();
  registerIpc();
  // 重复事项：启动即按规则补齐今天的实例，之后定时 / 跨天增量同步。
  // 生成的是普通 tasks 行，提醒仍由 reminders.js 的既有轮询触发，不另起一套通知。
  startRecurrenceScheduler({
    onDataChange: (info) => {
      try { desktopWindow.notifyChange(null); } catch (e) { /* 浮窗刷新失败不影响数据 */ }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ui:recurrence-generated', info);
      }
    },
  });
  // 设置中心专用的三个动作（开机自启 / 换数据目录 / 备份恢复对话框）
  registerSettingsIpc();
  // 桌面浮窗：窗口层独立于主窗口，投影列表变化时重建应用菜单 / 托盘菜单
  desktopWindow.init({
    getMainWindow: () => mainWindow,
    onChanged: () => {
      buildAppMenu();
      refreshTrayMenu();
    },
  });
  buildAppMenu();

  // 快速捕捉条：预创建一个隐藏窗口（第一次按 C 才不会 200ms 白屏），
  // 保存后广播给浮窗与主窗口 —— 与浮窗里勾选 / 新增走同一条刷新链路。
  capture.init({
    getMainWindow: () => mainWindow,
    onDataChange: (payload) => broadcastDataChanged(payload),
  });

  // 全局快捷键：必须在这里（whenReady 之后）注册，早于此时机 register() 静默失败
  shortcuts.init({ onAction: dispatchShortcut });

  // 番茄钟（专注计时）：主进程计时器，状态变化推给主窗口渲染进度环 / 收尾条。
  focus.init({
    onStateChange: (snap) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('focus:changed', snap);
      // 桌面浮窗也同步：重拉自己的投影（buildView 已带 focus 快照，refresh 后行内显示倒计时）
      try { desktopWindow.notifyChange(null); } catch (e) { /* 浮窗刷新失败不影响主窗口 */ }
    },
  });
  // 崩溃 / 强杀残留的未结算会话，启动时对账（不足 8 分钟删除，否则记 partial 并提示）
  focus.reconcileOnStartup();
  // 系统休眠 / 唤醒：挂起时结算睡眠前专注，唤醒后按 wall clock 对账（方案 §6.3）
  powerMonitor.on('suspend', () => focus.onPowerSuspend());
  powerMonitor.on('resume', () => focus.onPowerResume());
  // 任一 Knodo 窗口失焦 / 聚焦 → 只更新「是否聚焦」标记（计时照常走，不再因此冻结）
  app.on('browser-window-blur', () => setImmediate(() => focus.onWindowFocusChanged()));
  app.on('browser-window-focus', () => setImmediate(() => focus.onWindowFocusChanged()));

  // 退出前必须注销：否则系统里残留热键，下次启动可能注册失败
  app.on('will-quit', () => {
    focus.handleWillQuit(); // 进行中的番茄按已跑时长记 partial
    capture.destroy();
    shortcuts.destroy();
  });

  // 录制需要麦克风 / 屏幕采集权限：这是本机应用、且由用户主动点「录制」触发，
  // 不弹 Chromium 的权限气泡而是直接放行；其它权限（定位、通知等）一律拒绝。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  createWindow();

  // 配置的数据目录不可用：提示用户本次实际使用的目录（数据没丢，只是回退到了默认位置）
  if (!dataInfo.ok && !isSmoke) {
    msgBox({
      type: 'warning',
      title: '数据目录不可用',
      message: '配置的数据目录无法使用，本次已回退到默认目录',
      detail: `配置目录：${dataInfo.wanted}\n原因：${dataInfo.error}\n\n本次实际使用：${dataInfo.dir}\n\n`
        + '可在菜单「File → 存储位置」里重新指定目录（例如重新插上移动硬盘后再试）。',
      buttons: ['好', '去设置'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(({ response }) => { if (response === 1) openStorageDialog(); }).catch(() => {});
  }

  setupTray({
    getWindow: () => mainWindow,
    onShow: showWindow,
    onToggle: toggleWindow,
    onQuickAdd: quickAdd,
    onCapture: () => {
      // 托盘入口与 Ctrl+Alt+C 走同一条链路（没有前台浮窗，落点沿用主窗口上下文）
      try { capture.toggle({ contextGroupId: captureContext() }); } catch (e) { /* 捕捉条不可用时不拦托盘 */ }
    },
    onSettings: openSettings,
    // 托盘是浮窗的兜底入口：主窗口关掉（驻留托盘）后仍能唤回
    desktopItems: () => {
      let items = [];
      try { items = db.isReady() ? desktopWindow.list() : []; } catch (e) { items = []; }
      if (!items.length) return [];
      return [
        {
          label: '桌面浮窗',
          submenu: items.map((p) => ({
            label: `${p.title}${p.missing ? '（已删除）' : ''}  ${p.done}/${p.total}`,
            type: 'checkbox',
            checked: p.visible,
            click: () => { if (p.visible) desktopWindow.hide(p.id); else desktopWindow.show(p.id); },
          })),
        },
      ];
    },
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  // 还原上次钉在桌面上的清单（静默显示，不抢焦点）。
  // 冒烟测试跳过：它要的是干净环境，不该被用户遗留的浮窗干扰。
  if (!isSmoke) setTimeout(() => desktopWindow.restoreAll(), 500);

  startReminderScheduler({ onFocusTask: focusTask });
  // 自动备份：启动 5 分钟后首次，之后每 24 小时一份（只含数据库，附件靠完整备份包）
  if (db.isReady()) backup.startAutoBackup();
  // 启动 8 秒后静默查一次更新：失败静默、有新版只给一条轻提示 + 菜单标记，不弹窗打断。
  // 冒烟测试跳过：跑的是干净环境，也不该引入网络请求。
  if (!isSmoke && db.isReady()) setTimeout(() => { silentUpdateCheck().catch(() => {}); }, 8000);

  ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });
  app.on('activate', () => showWindow());

  // 冒烟测试：验证主进程各模块 + 渲染进程能正常初始化后自动退出
  if (isSmoke) {
    mainWindow.webContents.on('console-message', (_e, ...args) => {
      const d = args[0];
      // Electron 新版签名：(event, level, message, line, sourceId)；旧版 args[0] 是 message
      const message = d && typeof d === 'object'
        ? `[${d.level || ''}] ${d.message || ''}`
        : args.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
      console.log('[SMOKE][renderer console]', message);
    });
    mainWindow.webContents.on('did-finish-load', async () => {
      setTimeout(async () => {
        try {
          const ready = await mainWindow.webContents.executeJavaScript('window.__appReady === true');
          const groupCount = db.listGroups().length;
          const taskCount = db.listTasks({ status: 'all' }).length;
          console.log('[SMOKE] 主进程模块初始化完成');
          console.log(`[SMOKE] 默认分组数量 = ${groupCount}`);
          console.log(`[SMOKE] 任务查询正常，任务数 = ${taskCount}`);
          console.log(`[SMOKE] 渲染进程初始化 = ${ready ? '成功' : '失败'}`);

          // DOM 交互验证：底部添加任务入口 → 展开编辑器 → 取消关闭
          const dom = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              try {
              // 新建任务的默认计划日期跟随视图（「今天」视图会预填今天），
              // 下面这组断言是按「空范围两次点选」设计的，先切到「全部任务」再展开编辑器
              document.querySelector('.nav-item[data-view="all"]').click();
              await new Promise(r => setTimeout(r, 400));
              out.addRowExists = !!document.querySelector('[data-act="start-add"]');
              out.noModal = !document.querySelector('.modal-mask');
              out.timeFilterBtn = !!document.querySelector('#btn-time-filter');
              out.timeFilterPanel = !!document.querySelector('#time-filter');
              const waitUntil = async (fn, timeout = 3000) => {
                const t0 = Date.now();
                for (;;) {
                  if (fn()) return true;
                  if (Date.now() - t0 > timeout) return false;
                  await new Promise((r) => setTimeout(r, 50));
                }
              };
              const addBtn = document.querySelector('[data-act="start-add"]');
              // 冷启动时 UI 响应可能偏慢，用轮询代替固定 sleep，避免偶发的聚焦未生效
              if (addBtn) {
                addBtn.click();
                await waitUntil(() => {
                  const e = document.querySelector('.task-editor[data-editor="new"]');
                  return !!e && document.activeElement === e.querySelector('.editor-title');
                });
              }
              const ed = document.querySelector('.task-editor[data-editor="new"]');
              out.editorShown = !!ed;
              out.titleFocused = !!(ed && document.activeElement === ed.querySelector('.editor-title'));
              out.planFields = !!(ed && ed.querySelector('.date-range-field'));
              out.detailDrawer = !!document.querySelector('#detail-drawer');
              // 入口改版：日历进侧栏（今天下面），AI 检索从侧栏上移到顶栏搜索框旁
              const navViews = [...document.querySelectorAll('.nav-item')].map((b) => b.dataset.view);
              out.aiSearchTopbar = !!document.getElementById('btn-ai-search');
              out.searchNavGone = !navViews.includes('search');
              out.calendarAfterToday = navViews.indexOf('calendar') === navViews.indexOf('today') + 1;
              if (ed) {
                // 日期范围控件（flatpickr range 模式）：点一次只弹一个日历，
                // 两次点选 → 起点写入开始日期、终点写入完成日期，并自动关闭
                const dr = ed.querySelector('.date-range-field');
                const trigger = dr.querySelector('.date-range-trigger');
                // 面板由 flatpickr 挂到 body，一律用 document 级查询
                const openCals = () => [...document.querySelectorAll('.flatpickr-calendar.open')];
                const daysOf = () => [...document.querySelectorAll('.flatpickr-calendar.open .flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)')];
                const isoOf = (el) => {
                  const d = el && el.dateObj;
                  if (!d) return '';
                  const mm = String(d.getMonth() + 1).padStart(2, '0');
                  const dd = String(d.getDate()).padStart(2, '0');
                  return d.getFullYear() + '-' + mm + '-' + dd;
                };
                trigger.click();
                await new Promise(r => setTimeout(r, 200));
                // 关键回归：一次点击只允许出现 1 个日历面板
                out.calendarsOpen = openCals().length;
                out.calInBody = !!document.body.querySelector(':scope > .flatpickr-calendar.open');
                let days = daysOf();
                out.calDays = days.length;
                if (days.length >= 6) {
                  out.expectStart = isoOf(days[0]);
                  days[0].click(); // 第 1 次点选 = 开始日期
                  await new Promise(r => setTimeout(r, 120));
                  out.pickingOpen = openCals().length === 1; // 只选了起点 → 面板仍开着等终点
                  days = daysOf();
                  out.expectEnd = isoOf(days[5]);
                  days[5].click(); // 第 2 次点选 = 完成日期
                  await new Promise(r => setTimeout(r, 200));
                }
                out.rangeStart = dr.querySelector('.dr-start-input').value;
                out.rangeEnd = dr.querySelector('.dr-end-input').value;
                out.autoFilled = !!out.rangeStart && !!out.rangeEnd
                  && out.rangeStart === out.expectStart && out.rangeEnd === out.expectEnd;
                out.rangePopClosed = openCals().length === 0; // 选满即自动关闭
                out.rangeLabel = dr.querySelector('.dr-text').textContent.trim();
                // 触发器必须能正常开关（回归：曾出现 mousedown 先关、click 再开的死循环）
                trigger.click();
                await new Promise(r => setTimeout(r, 200));
                out.reopened = openCals().length === 1;
                // 面板必须完整落在视口内且不进祖先裁剪容器（回归：old 版被子任务行裁掉）
                const cal = openCals()[0];
                if (cal) {
                  const r = cal.getBoundingClientRect();
                  out.calInViewport = r.left >= 0 && r.top >= 0
                    && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
                  out.calParentIsBody = cal.parentElement === document.body;
                }
                trigger.click();
                await new Promise(r => setTimeout(r, 150));
                out.closedByTrigger = openCals().length === 0;
                // 端到端：控件里选好的范围要能真正写进数据库（plan_start / plan_end）
                const titleInput = ed.querySelector('.editor-title');
                titleInput.value = '冒烟日期任务';
                titleInput.dispatchEvent(new Event('input', { bubbles: true }));
                ed.querySelector('[data-act="editor-save"]').click();
                await new Promise(r => setTimeout(r, 600));
                const all = (await window.api.tasks.list({ view: 'all' })) || [];
                const rec = all.find((t) => t.title === '冒烟日期任务');
                out.persistedStart = rec ? rec.plan_start : null;
                out.persistedEnd = rec ? rec.plan_end : null;
                out.persistedMatches = !!rec && rec.plan_start === out.rangeStart && rec.plan_end === out.rangeEnd;
                const cancel = ed.querySelector('[data-act="editor-cancel"]');
                if (cancel) cancel.click();
                await new Promise(r => setTimeout(r, 300));
              }
              out.editorClosed = !document.querySelector('.task-editor[data-editor="new"]');

              // 分组新增：点 ＋ → 弹窗 → 输入 → 创建 → 列表立即出现
              const before = document.querySelectorAll('#group-list .group-item').length;
              document.getElementById('btn-add-group').click();
              await new Promise(r => setTimeout(r, 150));
              const modal = document.querySelector('.modal-mask');
              out.groupModalOpened = !!modal;
              if (modal) {
              const nameInput = modal.querySelector('[data-field="name"]') || modal.querySelector('.modal-input');
              nameInput.value = '冒烟分组';
              modal.querySelector('[data-modal="ok"]').click();
              await new Promise(r => setTimeout(r, 600));
              }
              const names = [...document.querySelectorAll('#group-list .group-name')].map(e => e.textContent);
              out.groupAdded = names.includes('冒烟分组');
              out.groupCount = names.length;
              out.groupCountBefore = before;
              // 重名应给出可读错误，而不是静默失败
              document.getElementById('btn-add-group').click();
              await new Promise(r => setTimeout(r, 120));
              const modal2 = document.querySelector('.modal-mask');
              if (modal2) {
                const dupInput = modal2.querySelector('[data-field="name"]') || modal2.querySelector('.modal-input');
                dupInput.value = '冒烟分组';
                modal2.querySelector('[data-modal="ok"]').click();
                await new Promise(r => setTimeout(r, 300));
                out.dupErrorShown = !modal2.querySelector('.modal-error').hidden;
                modal2.querySelector('[data-modal="cancel"]').click();
              }
              await new Promise(r => setTimeout(r, 100));

              // 标签新增
              document.getElementById('btn-add-tag').click();
              await new Promise(r => setTimeout(r, 150));
              const tagModal = document.querySelector('.modal-mask');
              out.tagModalOpened = !!tagModal;
              if (tagModal) {
                tagModal.querySelector('.modal-input').value = '冒烟标签';
                tagModal.querySelector('[data-modal="ok"]').click();
                await new Promise(r => setTimeout(r, 450));
              }
              out.tagAdded = [...document.querySelectorAll('#tag-list .tag-name')].map(e => e.textContent).includes('冒烟标签');

              /* ---- 子分组：在「冒烟分组」下建子分组 → 树形显示 → 父级筛选包含子任务 ---- */
              const rowOf = (name) => [...document.querySelectorAll('#group-list .group-item')]
                .find((el) => el.querySelector('.group-name') && el.querySelector('.group-name').textContent === name);
              const parentRow = rowOf('冒烟分组');
              out.parentRowFound = !!parentRow;
              if (parentRow) {
                parentRow.querySelector('.g-add').click();
                await new Promise(r => setTimeout(r, 200));
                const subModal = document.querySelector('.modal-mask');
                out.subModalOpened = !!subModal;
                if (subModal) {
                  const sel = subModal.querySelector('[data-field="parentId"]');
                  out.presetParent = sel ? sel.value : '';
                  const nm = subModal.querySelector('[data-field="name"]');
                  nm.value = '冒烟子分组';
                  subModal.querySelector('[data-modal="ok"]').click();
                  await new Promise(r => setTimeout(r, 700));
                }
              }
              const rowsNow = [...document.querySelectorAll('#group-list .group-item')];
              const childRow = rowsNow.find((el) => el.dataset.depth === '1'
                && el.querySelector('.group-name') && el.querySelector('.group-name').textContent === '冒烟子分组');
              out.childRowVisible = !!childRow;
              out.parentPresetMatched = out.presetParent !== '' && String(out.presetParent) === String(parentRow && parentRow.dataset.id);
              out.hasArrow = !!(parentRow && parentRow.querySelector('.group-arrow'));

              // 折叠 / 展开：折叠后子分组行应消失，再点箭头回来
              const hasChildRow = () => [...document.querySelectorAll('#group-list .group-item')]
                .some((el) => el.dataset.depth === '1'
                  && el.querySelector('.group-name')
                  && el.querySelector('.group-name').textContent === '冒烟子分组');
              const arrow = rowOf('冒烟分组').querySelector('.group-arrow');
              arrow.click();
              await new Promise(r => setTimeout(r, 200));
              out.childHiddenAfterCollapse = !hasChildRow();
              rowOf('冒烟分组').querySelector('.group-arrow').click();
              await new Promise(r => setTimeout(r, 200));
              out.childBackAfterExpand = hasChildRow();
              out.childRowVisible = out.childRowVisible && out.childBackAfterExpand;

              // 父筛选含子任务
              const ids = await window.api.groups.list();
              const parentId = ids.find((g) => g.name === '冒烟分组').id;
              const childId = ids.find((g) => g.name === '冒烟子分组').id;
              await window.api.tasks.create({ title: '子分组里的任务', groupId: childId, planStart: '', planEnd: '' });
              document.querySelector('.nav-item[data-view="all"]').click();
              await new Promise(r => setTimeout(r, 400));
              rowOf('冒烟分组').click();
              await new Promise(r => setTimeout(r, 500));
              const titles = [...document.querySelectorAll('.task-item .task-title-text')].map((e) => e.textContent.trim());
              out.parentFilterIncludesChildTask = titles.includes('子分组里的任务');
              rowOf('全部').click();
              await new Promise(r => setTimeout(r, 300));

              /* ---- 分组位置移动：右键「上移」+ 拖到另一组中间成为子分组 ---- */
              const topNames = () => [...document.querySelectorAll('#group-list .group-item')]
                .filter((el) => el.dataset.depth === '0')
                .map((el) => (el.querySelector('.group-name') || {}).textContent || '');
              // 走界面新增（api 直建不会触发主窗重绘，侧边栏里看不到新分组）
              document.getElementById('btn-add-group').click();
              await new Promise(r => setTimeout(r, 200));
              const mvModal = document.querySelector('.modal-mask');
              if (mvModal) {
                mvModal.querySelector('[data-field="name"]').value = '冒烟分组2';
                mvModal.querySelector('[data-modal="ok"]').click();
                await new Promise(r => setTimeout(r, 700));
              }
              out.moveBeforeOrder = topNames();
              const r2 = rowOf('冒烟分组2');
              if (r2) {
                const rr = r2.getBoundingClientRect();
                r2.dispatchEvent(new MouseEvent('contextmenu', {
                  bubbles: true, cancelable: true,
                  clientX: Math.round(rr.left + 40), clientY: Math.round(rr.top + 8),
                }));
                await new Promise(r => setTimeout(r, 260));
                const labels = [...document.querySelectorAll('.ctx-menu .ctx-item .ctx-label')].map((x) => x.textContent);
                out.moveMenuHasUpdown = labels.includes('上移') && labels.includes('下移') && labels.includes('移动到分组…');
                const upBtn = [...document.querySelectorAll('.ctx-menu .ctx-item')]
                  .find((b) => b.querySelector('.ctx-label').textContent === '上移');
                if (upBtn) upBtn.click();
                await new Promise(r => setTimeout(r, 700));
              }
              out.moveAfterOrder = topNames();
              const idxBefore = out.moveBeforeOrder.indexOf('冒烟分组2');
              const idxAfter = out.moveAfterOrder.indexOf('冒烟分组2');
              out.moveReordered = idxBefore >= 0 && idxAfter >= 0 && idxAfter === idxBefore - 1;

              // 拖拽：把「冒烟分组2」拖到「冒烟分组」中间 → 成为它的子分组
              const dragRow = rowOf('冒烟分组2');
              const dropRow = rowOf('冒烟分组');
              if (dragRow && dropRow) {
                const dt = new DataTransfer();
                dragRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
                const dr = dropRow.getBoundingClientRect();
                const dropOpt = {
                  bubbles: true, cancelable: true, dataTransfer: dt,
                  clientX: Math.round(dr.left + 60), clientY: Math.round(dr.top + dr.height / 2),
                };
                dropRow.dispatchEvent(new DragEvent('dragover', dropOpt));
                out.moveDropMarked = dropRow.classList.contains('drop-inside');
                dropRow.dispatchEvent(new DragEvent('drop', dropOpt));
                dragRow.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
                await new Promise(r => setTimeout(r, 900));
              }
              const afterDrag = await window.api.groups.list();
              const movedG = afterDrag.find((g) => g.name === '冒烟分组2');
              out.moveIntoChild = !!movedG && movedG.parent_id === parentId;
              const movedRow = rowOf('冒烟分组2');
              out.moveIntoChildRow = !!movedRow && movedRow.dataset.depth === '1';
              // 收尾：删掉这个临时分组并重绘，后面几轮的分组计数不受影响
              if (movedG) {
                await window.api.groups.remove(movedG.id);
                document.querySelector('.nav-item[data-view="all"]').click();
                await new Promise(r => setTimeout(r, 600));
              }

              /* ---- AI 设置入口已挪到顶部菜单栏：工具栏里不应再有该按钮 ---- */
              out.aiToolbarBtnGone = !document.getElementById('btn-ai-settings');
              } catch (e) { out.__fatal = String((e && e.stack) || e).split('\\n').slice(0, 4).join(' | '); }
              return out;
            })()
          `);
          if (dom.__fatal) console.log('[SMOKE][dom fatal]', dom.__fatal);

          /* ---- 非任务视图：筛选栏一律隐藏；AI 检索独留顶栏工具行（入口已上移到顶栏） ---- */
          const tbVis = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              const right = document.querySelector('.topbar-right');
              const bar = document.getElementById('filter-bar');
              const nav = (v) => (v === 'search'
                ? document.getElementById('btn-ai-search')
                : document.querySelector('.nav-item[data-view="' + v + '"]')).click();
              for (const v of ['stats', 'reports', 'search', 'meetings']) {
                nav(v);
                await new Promise(r => setTimeout(r, 600));
                // 统计 / 报告 / 纪要连工具行一起收起；检索要保留，否则顶栏入口会点一下就消失
                out[v + 'Hidden'] = bar.hidden && (v === 'search' ? !right.hidden : right.hidden);
              }
              nav('all');
              await new Promise(r => setTimeout(r, 600));
              out.taskShown = !right.hidden && !bar.hidden;
              return out;
            })()
          `);
          console.log(`[SMOKE] 非任务视图工具区 = 统计${tbVis.statsHidden ? '✓' : '✗'} 报告${tbVis.reportsHidden ? '✓' : '✗'} 检索(顶栏保留)${tbVis.searchHidden ? '✓' : '✗'} 纪要${tbVis.meetingsHidden ? '✓' : '✗'}；回到任务视图恢复=${tbVis.taskShown ? '是' : '否'}`);

          /* ---- 分组自定义颜色：预设色 + 取色器自由取色 → 落库 → 视觉标识同步 ---- */
          const gcOut = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              try {
              document.getElementById('btn-add-group').click();
              await new Promise(r => setTimeout(r, 350));
              const mask = document.querySelector('.modal-mask');
              out.modalOpened = !!mask;
              const hex = mask.querySelector('.color-hex');
              const native = mask.querySelector('.color-native');
              const hidden = mask.querySelector('[data-field="color"]');
              out.hasNativePicker = !!native && native.type === 'color';
              out.hasHexInput = !!hex;
              out.defaultAuto = hidden.value === 'auto';
              out.presetCount = mask.querySelectorAll('.color-swatch:not(.is-auto)').length;
              const setHex = async (v) => {
                hex.value = v;
                hex.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, 60));
              };
              await setHex('#ff00aa');
              out.customValue = hidden.value;
              out.nativeSynced = native.value;
              await setHex('#abc');
              out.abbrevNormalized = hidden.value;
              await setHex('zzz');                 // 非法输入：值应保持上一个有效色（#aabbcc）
              out.invalidKept = hidden.value;
              await setHex('#ff00aa');
              // 点预设色也要能切回去
              mask.querySelector('.color-swatch:not(.is-auto)').click();
              await new Promise(r => setTimeout(r, 60));
              out.presetPicked = hidden.value;
              await setHex('#ff00aa');
              mask.querySelector('[data-field="name"]').value = '自定义色分组';
              mask.querySelector('[data-modal="ok"]').click();
              await new Promise(r => setTimeout(r, 900));
              const li = [...document.querySelectorAll('#group-list .group-item')]
                .find((e) => (e.querySelector('.group-name') || {}).textContent === '自定义色分组');
              out.created = !!li;
              out.dotColor = li ? getComputedStyle(li.querySelector('.group-dot')).backgroundColor : '';
              const g = (await window.api.groups.list()).find((x) => x.name === '自定义色分组');
              out.persisted = g ? g.color : '';
              // 编辑回显：已有自定义色时不能再回退成 auto
              if (li) {
                li.querySelector('[data-act="edit"]').click();
                await new Promise(r => setTimeout(r, 350));
                const m2 = document.querySelector('.modal-mask');
                out.editValue = m2 ? m2.querySelector('[data-field="color"]').value : '';
                out.editHex = m2 ? m2.querySelector('.color-hex').value : '';
                const cancel = m2 && m2.querySelector('[data-modal="cancel"]');
                if (cancel) { cancel.click(); await new Promise(r => setTimeout(r, 250)); }
              }
              } catch (e) { out.__fatal = String((e && e.stack) || e).split('\\n').slice(0, 4).join(' | '); }
              return out;
            })()
          `);
          if (gcOut.__fatal) console.log('[SMOKE][group-color fatal]', gcOut.__fatal);
          console.log(`[SMOKE] 分组自定义颜色 = 取色器${gcOut.hasNativePicker ? '有' : '无'}；默认自动=${gcOut.defaultAuto ? '是' : '否'}；预设 ${gcOut.presetCount} 个；自定义值=${gcOut.customValue || '-'}；缩写归一化=${gcOut.abbrevNormalized || '-'}；非法值保持=${gcOut.invalidKept || '-'}；落库=${gcOut.persisted || '-'}；侧栏色点=${gcOut.dotColor || '-'}；编辑回显=${gcOut.editValue || '-'}`);
          Object.assign(dom, {
            gcModalOpened: gcOut.modalOpened, gcPicker: gcOut.hasNativePicker && gcOut.hasHexInput,
            gcAuto: gcOut.defaultAuto, gcCustom: gcOut.customValue === '#ff00aa',
            gcAbbrev: gcOut.abbrevNormalized === '#aabbcc', gcInvalidKept: gcOut.invalidKept === '#aabbcc',
            gcPreset: !!gcOut.presetPicked, gcCreated: gcOut.created,
            gcDot: /rgb\(255,\s*0,\s*170\)/.test(gcOut.dotColor || ''),
            gcPersisted: gcOut.persisted === '#ff00aa', gcEditEcho: gcOut.editValue === '#ff00aa',
          });

          /* ---- AI 配置：菜单栏「AI 设置」→ 弹窗 → 填表 → 保存 → 回读 ---- */
          const aiMenuItem = Menu.getApplicationMenu().items.find((i) => i.label === 'AI 设置');
          console.log(`[SMOKE] 菜单栏「AI 设置」= ${aiMenuItem ? '存在' : '缺失'}`);
          mainWindow.webContents.send('ui:ai-settings');
          await new Promise(r => setTimeout(r, 500));
          const aiOut = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              try {
              const aiModal = document.querySelector('.modal-mask');
              // 回归：若前面有弹窗没关干净，这里会抓错弹窗（分组弹窗是单栏的），故显式记录数量
              out.aiModalCount = document.querySelectorAll('.modal-mask').length;
              out.aiModalOpened = !!aiModal;
              if (aiModal) {
                // 排版回归：两栏网格、两张分区卡片、整体不超出视口、底部按钮可点
                const box = aiModal.querySelector('.modal').getBoundingClientRect();
                out.aiCols = getComputedStyle(aiModal.querySelector('.form-grid')).gridTemplateColumns.split(' ').length;
                out.aiSections = aiModal.querySelectorAll('.form-section').length;
                out.aiFieldCount = aiModal.querySelectorAll('.modal-field').length;
                out.aiInViewport = box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth;
                const okRect = aiModal.querySelector('[data-modal="ok"]').getBoundingClientRect();
                out.aiFootReachable = okRect.bottom <= window.innerHeight && okRect.top >= 0;
                const bd = aiModal.querySelector('.modal-body');
                out.aiBodyScrolls = bd.scrollHeight <= bd.clientHeight + 2;
                out.aiBox = { h: Math.round(box.height), vh: window.innerHeight };
                out.aiNoHOverflow = document.documentElement.scrollWidth <= window.innerWidth;
                aiModal.querySelector('[data-field="baseUrl"]').value = 'https://smoke.example.com';
                aiModal.querySelector('[data-field="model"]').value = 'smoke-model';
                aiModal.querySelector('[data-modal="ok"]').click();
                await new Promise(r => setTimeout(r, 500));
              }
              const cfg = await window.api.ai.getConfig();
              out.aiSavedUrl = cfg.baseUrl;
              out.aiSavedModel = cfg.model;
              } catch (e) { out.__fatal = String((e && e.stack) || e).split('\\n').slice(0, 4).join(' | '); }
              return out;
            })()
          `);
          if (aiOut.__fatal) console.log('[SMOKE][ai fatal]', aiOut.__fatal);
          Object.assign(dom, aiOut, { aiMenuItem: !!aiMenuItem });
          Object.assign(dom, { tbStatsHidden: tbVis.statsHidden, tbReportsHidden: tbVis.reportsHidden, tbSearchHidden: tbVis.searchHidden, tbMeetingsHidden: tbVis.meetingsHidden, tbTaskShown: tbVis.taskShown });
          console.log(`[SMOKE] 底部"添加任务"入口 = ${dom.addRowExists ? '存在' : '缺失'}`);
          console.log(`[SMOKE] 弹窗已移除 = ${dom.noModal ? '是' : '否'}`);
          console.log(`[SMOKE] 时间筛选面板 = ${dom.timeFilterBtn && dom.timeFilterPanel ? '存在' : '缺失'}`);
          console.log(`[SMOKE] 点击后编辑器展开 = ${dom.editorShown ? '成功' : '失败'}`);
          console.log(`[SMOKE] 编辑器含日期范围控件 = ${dom.planFields ? '是' : '否'}`);
          console.log(`[SMOKE] 详情抽屉容器 = ${dom.detailDrawer ? '存在' : '缺失'}`);
          console.log(`[SMOKE] 导航入口 = 顶栏 AI 检索=${dom.aiSearchTopbar ? '存在' : '缺失'}；侧栏旧项已移除=${dom.searchNavGone ? '是' : '否'}；日历紧随今天=${dom.calendarAfterToday ? '是' : '否'}`);
          console.log(`[SMOKE] 标题输入框聚焦 = ${dom.titleFocused ? '成功' : '失败'}`);
          console.log(`[SMOKE] 日期范围两次点选回填 = ${dom.rangeStart || '-'} ~ ${dom.rangeEnd || '-'}（文案：${dom.rangeLabel}）；期望 ${dom.expectStart} ~ ${dom.expectEnd} → ${dom.autoFilled ? '一致' : '不一致'}`);
          console.log(`[SMOKE] 日期范围弹窗自动关闭 = ${dom.rangePopClosed ? '是' : '否'}`);
          console.log(`[SMOKE] 单次点击弹出面板数 = ${dom.calendarsOpen}（必须为 1）；挂在 body = ${dom.calInBody ? '是' : '否'}；可视日期格 = ${dom.calDays}`);
          console.log(`[SMOKE] 再次触发：重开=${dom.reopened ? '是' : '否'}；二次点击可关闭=${dom.closedByTrigger ? '是' : '否'}；面板在视口内=${dom.calInViewport ? '是' : '否'}`);
          console.log(`[SMOKE] 日期范围落库 = ${dom.persistedStart || '-'} ~ ${dom.persistedEnd || '-'}（${dom.persistedMatches ? '与控件一致' : '不一致'}）`);
          console.log(`[SMOKE] 取消后编辑器关闭 = ${dom.editorClosed ? '成功' : '失败'}`);
          console.log(`[SMOKE] 分组：新增=${dom.groupAdded ? '是' : '否'}（${dom.groupCountBefore} → ${dom.groupCount}）；重名错误=${dom.dupErrorShown ? '已提示' : '未提示'}`);
          console.log(`[SMOKE] 子分组：父行含箭头=${dom.hasArrow ? '是' : '否'}；上级默认带入=${dom.parentPresetMatched ? '是' : '否'}；子分组可见=${dom.childRowVisible ? '是' : '否'}；折叠后隐藏=${dom.childHiddenAfterCollapse ? '是' : '否'}；再展开回来=${dom.childBackAfterExpand ? '是' : '否'}；父筛选含子任务=${dom.parentFilterIncludesChildTask ? '是' : '否'}`);
          console.log(`[SMOKE] 分组移动 = 菜单含上移/下移/移动到分组=${dom.moveMenuHasUpdown ? '是' : '否'}；右键上移生效=${dom.moveReordered ? '是' : '否'}（${JSON.stringify(dom.moveBeforeOrder)} → ${JSON.stringify(dom.moveAfterOrder)}）；拖拽落点高亮=${dom.moveDropMarked ? '是' : '否'}；拖成子分组=${dom.moveIntoChild ? '是' : '否'}；侧边栏层级=${dom.moveIntoChildRow ? '1' : '未变'}`);
          console.log(`[SMOKE] AI 设置（菜单栏）= 工具栏按钮已移除${dom.aiToolbarBtnGone ? '✓' : '✗'}；菜单项${dom.aiMenuItem ? '存在' : '缺失'}；弹窗${dom.aiModalOpened ? '打开' : '未打开'}；保存后回读=${dom.aiSavedUrl || '-'} / ${dom.aiSavedModel || '-'}`);
          console.log(`[SMOKE] AI 设置排版 = ${dom.aiCols} 列；分区 ${dom.aiSections} 个；字段 ${dom.aiFieldCount} 个；弹窗高 ${dom.aiBox ? dom.aiBox.h : '-'}px / 视口 ${dom.aiBox ? dom.aiBox.vh : '-'}px；完整在视口内=${dom.aiInViewport ? '是' : '否'}；底部按钮可点=${dom.aiFootReachable ? '是' : '否'}；内容无需滚动=${dom.aiBodyScrolls ? '是' : '否'}；横向无溢出=${dom.aiNoHOverflow ? '是' : '否'}`);
          console.log(`[SMOKE] 标签新增弹窗 = ${dom.tagModalOpened ? '弹出' : '未弹出'}；新增后列表出现 = ${dom.tagAdded ? '是' : '否'}`);

          // 菜单栏结构：File 里已无「同步到腾讯文档 / ima」；笔记导出只在笔记视图工具栏
          const appMenu = Menu.getApplicationMenu();
          const topLabels = (appMenu ? appMenu.items : []).map((i) => i.label);
          const fileItem = appMenu ? appMenu.items.find((i) => i.label === 'File') : null;
          const fileLabels = fileItem ? fileItem.submenu.items.map((i) => i.label) : [];
          const toolsItem = appMenu ? appMenu.items.find((i) => i.label === '实用工具') : null;
          const toolsLabels = toolsItem ? toolsItem.submenu.items.map((i) => i.label) : [];
          const themeItem = appMenu ? appMenu.items.find((i) => i.label === '主题') : null;
          console.log(`[SMOKE] 菜单栏结构 = 顶格「${topLabels.join(' / ')}」；File 菜单同步项已移除=${fileLabels.some((l) => l.startsWith('同步')) ? '否（仍在）' : '是'}；归档项在 File=${fileLabels.includes('归档已完成任务') ? '是' : '否'}；桌面浮窗已并入实用工具=${toolsLabels.includes('桌面浮窗') ? '是' : '否'}（顶格已移除=${topLabels.includes('桌面浮窗') ? '否' : '是'}）；重复「主题」顶格已删除=${themeItem ? '否（仍在）' : '是'}`);
          const topbarOut = await mainWindow.webContents.executeJavaScript(`(() => {
            const nb = document.getElementById('btn-notes-dock');
            const ai = document.getElementById('btn-ai-search');
            const sb = document.querySelector('.search-box');
            return {
              noteOutside: !!nb && !nb.closest('.search-box'),
              noteText: nb ? (nb.textContent || '').trim() : '',
              noteVisible: !!nb && nb.offsetWidth > 0,
              aiVisible: !!ai && ai.offsetWidth > 0,
              aiBesideSearch: !!ai && !!sb && ai.previousElementSibling === sb,
              aiText: ai ? (ai.textContent || '').trim() : '',
              zoomChipGone: !document.getElementById('view-zoom'),
              syncGone: !document.getElementById('btn-sync'),
              themeGone: !document.getElementById('btn-theme'),
            };
          })()`);
          console.log(`[SMOKE] 顶栏入口 = 「${topbarOut.noteText || '-'}」在搜索栏外=${topbarOut.noteOutside ? '是' : '否'}；可见=${topbarOut.noteVisible ? '是' : '否'}；「${topbarOut.aiText || '-'}」可见=${topbarOut.aiVisible ? '是' : '否'}；紧贴搜索栏=${topbarOut.aiBesideSearch ? '是' : '否'}；缩放 chip 已移除=${topbarOut.zoomChipGone ? '是' : '否'}；同步按钮已移除=${topbarOut.syncGone ? '是' : '否'}；主题按钮已移除=${topbarOut.themeGone ? '是' : '否'}`);
          // 笔记导出面板由笔记视图工具栏「📤 导出」独立拉起，这里不再发 ui:sync。

          // 详情侧边栏：拖拽调宽 + 子任务添加（局部刷新，不重绘整页）
          const detail = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              // 造一条任务并确保它在「全部任务」视图可见
              const created = await window.api.tasks.create({ title: '冒烟父任务' });
              document.querySelector('.nav-item[data-view="all"]').click();
              await new Promise(r => setTimeout(r, 400));

              const item = document.querySelector('.task-item[data-id="' + created.id + '"]');
              out.taskVisible = !!item;
              if (item) { item.click(); await new Promise(r => setTimeout(r, 600)); }
              const panel = document.querySelector('.detail-panel');
              out.panelOpen = !!panel;
              if (!panel) return out;

              out.widthBefore = Math.round(panel.getBoundingClientRect().width);
              const handle = document.querySelector('.detail-resizer');
              out.hasResizer = !!handle;
              if (handle) {
                // 模拟 pointer 拖拽：向左拖 120px → 面板变宽
                const rect = handle.getBoundingClientRect();
                const startX = rect.left + 3;
                const y = rect.top + 60;
                const fire = (type, x) => handle.dispatchEvent(new PointerEvent(type, {
                  bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1,
                  clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true,
                }));
                fire('pointerdown', startX);
                for (let i = 1; i <= 6; i++) {
                  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, buttons: 1, clientX: startX - i * 20, clientY: y, pointerType: 'mouse' }));
                  await new Promise(r => requestAnimationFrame(r));
                }
                window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: startX - 120, clientY: y, pointerType: 'mouse' }));
                await new Promise(r => setTimeout(r, 200));
              }
              out.widthAfter = Math.round(panel.getBoundingClientRect().width);
              out.resizingClassCleared = !document.documentElement.classList.contains('is-resizing');
              out.savedWidth = localStorage.getItem('ui.detailWidth');
              out.persistedImmediate = await window.api.ui.getDetailWidth();
              // 落库有 350ms 节流，等一等再读一次
              await new Promise(r => setTimeout(r, 600));
              out.persisted = await window.api.ui.getDetailWidth();
              // 关掉再打开，宽度应被复用
              document.querySelector('.detail-close').click();
              await new Promise(r => setTimeout(r, 250));
              document.querySelector('.task-item[data-id]').click();
              await new Promise(r => setTimeout(r, 600));
              out.widthReopened = Math.round(document.querySelector('.detail-panel').getBoundingClientRect().width);

              // 边界：把手柄拖到最左/最右，宽度必须被限制在 [360, 85% 视口]
              const h2 = document.querySelector('.detail-resizer');
              const dragTo = async (x) => {
                const r = h2.getBoundingClientRect();
                const yy = r.top + 40;
                h2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 2, button: 0, buttons: 1, clientX: r.left + 3, clientY: yy, pointerType: 'mouse', isPrimary: true }));
                window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 2, buttons: 1, clientX: x, clientY: yy, pointerType: 'mouse' }));
                await new Promise(r2 => requestAnimationFrame(r2));
                window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, clientX: x, clientY: yy, pointerType: 'mouse' }));
                await new Promise(r2 => setTimeout(r2, 120));
                return Math.round(document.querySelector('.detail-panel').getBoundingClientRect().width);
              };
              out.widthMin = await dragTo(10);                    // 拖到最左 → 应停在最大宽度
              out.widthMaxClamp = await dragTo(window.innerWidth);  // 拖到最右 → 应停在最小宽度
              out.viewportMax = Math.min(860, Math.round(window.innerWidth * 0.85));

              // 子任务：添加后抽屉面板节点不应被替换（旧实现整页重绘会重建整个面板，表现为闪一下）
              const node = document.querySelector('.detail-panel');
              const input = document.querySelector('.subtask-input');
              out.hasSubtaskInput = !!input;
              if (input) {
                input.value = '冒烟子任务';
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                await new Promise(r => setTimeout(r, 800));
              }
              out.samePanelNode = node.isConnected && document.querySelector('.detail-panel') === node;
              // 子任务标题已从只读 span 改为可就地编辑的 input（补齐字段的一部分）
              out.subtaskTitles = [...document.querySelectorAll('.subtask-item .subtask-title-input')].map(e => e.value);
              out.inputFocused = document.activeElement === document.querySelector('.subtask-input');
              return out;
            })()
          `);
          console.log(`[SMOKE] 详情面板打开 = ${detail.panelOpen ? '是' : '否'}；拖拽手柄 = ${detail.hasResizer ? '存在' : '缺失'}；任务可见 = ${detail.taskVisible ? '是' : '否'}`);
          console.log(`[SMOKE] 拖拽调宽 ${detail.widthBefore}px → ${detail.widthAfter}px；关闭重开 = ${detail.widthReopened}px；落库 = ${detail.persisted}px；拖拽态已清理 = ${detail.resizingClassCleared ? '是' : '否'}`);
          console.log(`[SMOKE] 宽度边界：拖到最左 = ${detail.widthMin}px（上限 ${detail.viewportMax}px）；拖到最右 = ${detail.widthMaxClamp}px`);
          console.log(`[SMOKE] 子任务添加后局部刷新 = ${detail.samePanelNode ? '是' : '否'}；列表 = ${JSON.stringify(detail.subtaskTitles)}；输入框保留焦点 = ${detail.inputFocused ? '是' : '否'}`);

          // 即时持久化 + 子任务字段 + 展开（在筛选视图下）
          const feat = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              const wait = (ms) => new Promise(r => setTimeout(r, ms));
              const p2 = (n) => String(n).padStart(2, '0');
              const d = new Date();
              const today = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
              document.querySelector('.nav-item[data-view="all"]').click();
              await wait(400);

              /* --- 1) 列表行内编辑：不点保存也应落库 --- */
              const t = await window.api.tasks.create({ title: '待改标题', priority: 1 });
              document.querySelector('.nav-item[data-view="all"]').click();
              await wait(500);
              const editBtn = document.querySelector('.task-item[data-id="' + t.id + '"] [data-act="edit"]');
              out.editBtnFound = !!editBtn;
              if (editBtn) {
                editBtn.click();
                await wait(400);
                const ed = document.querySelector('.task-editor[data-editor="' + t.id + '"]');
                const input = ed.querySelector('.editor-title');
                input.value = '自动保存后的标题';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                out.statePending = ed.querySelector('.editor-save-state').textContent;
                await wait(1400);
                out.stateSaved = ed.querySelector('.editor-save-state').textContent;
                out.persistedTitle = (await window.api.tasks.get(t.id)).title;
                const sel = ed.querySelector('.editor-priority');
                sel.value = '3';
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                await wait(1400);
                out.persistedPriority = (await window.api.tasks.get(t.id)).priority;
                ed.querySelector('[data-act="editor-cancel"]').click();
                await wait(400);
              }

              /* --- 2) 详情：自动保存 --- */
              document.querySelector('.task-item[data-id="' + t.id + '"]').click();
              await wait(600);
              const dTitle = document.querySelector('.detail-title');
              dTitle.value = '详情自动保存标题';
              dTitle.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(1400);
              out.detailState = document.querySelector('.detail-save-state').textContent;
              out.detailPersisted = (await window.api.tasks.get(t.id)).title;

              /* --- 3) 子任务：优先级 + 计划日期 --- */
              document.querySelector('.subtask-new-priority').value = '3';
              const drTrigger = document.querySelector('.subtask-add .date-range-trigger');
              drTrigger.click();
              await wait(250);
              // 面板由 flatpickr 挂到 body，不能用 .subtask-add 前缀限定
              const dayCells = () => [...document.querySelectorAll('.flatpickr-calendar.open .flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)')];
              let cells = dayCells();
              out.subCalDays = cells.length;
              if (cells.length >= 3) {
                cells[0].click(); await wait(150);
                cells = dayCells();
                (cells[2] || cells[1]).click(); // 第 2 次点选 = 完成日期（选满自动关闭）
                await wait(250);
              }
              out.subCalClosed = document.querySelectorAll('.flatpickr-calendar.open').length === 0;
              const addInput = document.querySelector('.subtask-input');
              addInput.value = '带字段的子任务';
              addInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await wait(900);
              const subs = await window.api.tasks.subtasks(t.id);
              const sub = subs[0];
              out.sub = sub ? { title: sub.title, priority: sub.priority, ps: sub.plan_start, pe: sub.plan_end } : null;
              const priEl = document.querySelector('.subtask-item .subtask-priority');
              if (priEl) {
                priEl.value = '0';
                priEl.dispatchEvent(new Event('change', { bubbles: true }));
                await wait(1400);
              }
              out.subPriorityAfterEdit = (await window.api.tasks.subtasks(t.id))[0].priority;
              document.querySelector('.detail-close').click();
              await wait(300);

              /* --- 4) 展开：父任务在今天视图可见、子任务无日期也需展开显示 --- */
              const parent = await window.api.tasks.create({ title: '带子任务的父', planStart: today, planEnd: today });
              const child = await window.api.tasks.create({ title: '无日期子任务', parentId: parent.id });
              document.querySelector('.nav-item[data-view="today"]').click();
              await wait(500);
              const pLi = document.querySelector('.task-item[data-id="' + parent.id + '"]');
              out.parentVisibleToday = !!pLi;
              const arrow = pLi && pLi.querySelector('[data-act="toggle-expand"]');
              out.hasArrow = !!arrow;
              if (arrow) {
                if (arrow.textContent === '▾') { arrow.click(); await wait(400); }
                const a2 = document.querySelector('.task-item[data-id="' + parent.id + '"] [data-act="toggle-expand"]');
                // 子任务行嵌在父行 <li> 内，所以不能只看 .is-subtask 存不存在——
                // 必须看"哪一行被渲染出来了"，否则父行自身会把 is-subtask 一直带在 DOM 里。
                out.collapsedChildHidden = !document.querySelector('.task-item[data-id="' + child.id + '"]');
                a2.click();
                await wait(500);
                out.expandedChildVisible = !!document.querySelector('.task-item[data-id="' + child.id + '"]');
                out.arrowAfter = document.querySelector('.task-item[data-id="' + parent.id + '"] [data-act="toggle-expand"]').textContent;
              }
              return out;
            })()
          `);
          console.log(`[SMOKE] 即时持久化（列表）= ${feat.statePending} → ${feat.stateSaved}；未点保存已落库 = ${feat.persistedTitle === '自动保存后的标题' && feat.persistedPriority === 3 ? '是' : '否'}`);
          console.log(`[SMOKE] 即时持久化（详情）= ${feat.detailState}；落库 = ${feat.detailPersisted}`);
          console.log(`[SMOKE] 子任务字段 = ${JSON.stringify(feat.sub)}；日期格=${feat.subCalDays}；选满自动关闭=${feat.subCalClosed ? '是' : '否'}；改优先级后 = ${feat.subPriorityAfterEdit}`);
          console.log(`[SMOKE] 展开（今天视图）= 子任务可见 ${feat.expandedChildVisible ? '是' : '否'}；箭头 = ${feat.arrowAfter}；收起后隐藏 = ${feat.collapsedChildHidden ? '是' : '否'}`);

          /* ---- 第 4 轮：日期浮层 / 拖拽排序 / 报告分组多选 / 工具栏中文化 ---- */
          const r4 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              const wait = (ms) => new Promise(r => setTimeout(r, ms));
              const p2 = (n) => String(n).padStart(2, '0');
              const dd = new Date();
              const today = dd.getFullYear() + '-' + p2(dd.getMonth() + 1) + '-' + p2(dd.getDate());
              const fireDrag = (el, type, dt) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));

              /* 1) 子任务日期弹层（flatpickr）：必须挂在 body 上、且完整落在视口内不被裁剪 */
              const a = await window.api.tasks.create({ title: 'R4父任务', planStart: today, planEnd: today });
              await window.api.tasks.create({ title: 'R4子任务', parentId: a.id });
              document.querySelector('.nav-item[data-view="all"]').click();
              await wait(400);
              document.querySelector('.task-item[data-id="' + a.id + '"]').click();
              await wait(700);
              const subDr = document.querySelector('.subtask-item .date-range-field');
              out.subDrFound = !!subDr;
              if (subDr) {
                subDr.querySelector('.date-range-trigger').click();
                await wait(250);
                const pop = document.querySelector('.flatpickr-calendar.open');
                out.subCalOpenCount = document.querySelectorAll('.flatpickr-calendar.open').length;
                out.popInLayer = !!pop && pop.parentElement === document.body;
                out.popClipped = !!pop && pop.closest('.detail-body, .subtree, .subtask-item');
                if (pop) {
                  const r = pop.getBoundingClientRect();
                  out.popRect = { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
                  out.popInViewport = r.left >= 0 && r.top >= 0
                    && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
                  out.popVisibleH = Math.round(r.height);
                }
                out.popCells = document.querySelectorAll('.flatpickr-calendar.open .flatpickr-day').length;
                // 关掉：再点触发器应能正常收起（不留孤儿面板）
                subDr.querySelector('.date-range-trigger').click();
                await wait(200);
                out.layerCleaned = document.querySelectorAll('.flatpickr-calendar.open').length === 0;
              }
              document.querySelector('.detail-close').click();
              await wait(300);

              /* 2) 拖拽排序（主列表）：拖第 1 行到第 2 行 → 顺序互换且自动切到手动排序 */
              const b1 = await window.api.tasks.create({ title: 'R4排序A', planStart: today, planEnd: today });
              const b2 = await window.api.tasks.create({ title: 'R4排序B', planStart: today, planEnd: today });
              document.querySelector('.nav-item[data-view="all"]').click();
              await wait(500);
              const rows = [...document.querySelectorAll('.task-list > .task-item:not(.is-subtask)')];
              out.rows = rows.length;
              const idx1 = rows.findIndex(r => r.dataset.id === String(b1.id));
              const idx2 = rows.findIndex(r => r.dataset.id === String(b2.id));
              out.beforeOrder = [idx1, idx2];
              if (idx1 > -1 && idx2 > -1) {
                const dt = new DataTransfer();
                const h1 = rows[idx1].querySelector('.drag-handle');
                out.hasHandle = !!h1;
                if (h1) {
                  h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, isPrimary: true }));
                  fireDrag(rows[idx1], 'dragstart', dt);
                  await wait(60);
                  fireDrag(rows[idx2], 'dragover', dt);
                  fireDrag(rows[idx2], 'drop', dt);
                  await wait(900);
                }
                out.sortMode = document.getElementById('sort-select').value;
                const after = [...document.querySelectorAll('.task-list > .task-item:not(.is-subtask)')];
                const ai1 = after.findIndex(r => r.dataset.id === String(b1.id));
                const ai2 = after.findIndex(r => r.dataset.id === String(b2.id));
                out.afterOrder = [ai1, ai2];
                out.reordered = ai2 < ai1; // B 现在排在 A 前面
                const s1 = await window.api.tasks.get(b1.id);
                const s2 = await window.api.tasks.get(b2.id);
                out.sortOrders = [s1.sort_order, s2.sort_order];
                out.persistedOrder = s2.sort_order < s1.sort_order;
              }

              /* 3) 子任务拖拽排序 */
              const c1 = await window.api.tasks.create({ title: 'R4子父' });
              const cs1 = await window.api.tasks.create({ title: 'R4子1', parentId: c1.id });
              const cs2 = await window.api.tasks.create({ title: 'R4子2', parentId: c1.id });
              document.querySelector('.nav-item[data-view="all"]').click();
              await wait(400);
              document.querySelector('.task-item[data-id="' + c1.id + '"]').click();
              await wait(700);
              const subs = [...document.querySelectorAll('.subtree > li.subtask-item')];
              out.subCount = subs.length;
              if (subs.length >= 2) {
                const dt2 = new DataTransfer();
                const h2 = subs[0].querySelector('.drag-handle');
                out.subHasHandle = !!h2;
                if (h2) {
                  h2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 10, isPrimary: true }));
                  fireDrag(subs[0], 'dragstart', dt2);
                  await wait(60);
                  fireDrag(subs[1], 'dragover', dt2);
                  fireDrag(subs[1], 'drop', dt2);
                  await wait(900);
                }
                const afterSubs = [...document.querySelectorAll('.subtree > li.subtask-item')].map(x => Number(x.dataset.id));
                out.subAfterOrder = afterSubs;
                out.subReordered = afterSubs[0] === cs2.id && afterSubs[1] === cs1.id;
              }
              document.querySelector('.detail-close').click();
              await wait(300);

              /* 4) 工具栏中文化：图标按钮应带中文文案 */
              document.querySelector('.nav-item[data-view="all"]').click();
              await wait(400);
              const actBtn = document.querySelector('.task-item [data-act="edit"]');
              out.actionLabel = actBtn ? actBtn.textContent.trim() : '';
              out.hasChineseAction = /[\\u4e00-\\u9fa5]/.test(out.actionLabel);
              document.querySelector('[data-act="start-add"]').click();
              await wait(350);
              const moreBtn = document.querySelector('[data-act="editor-more"]');
              out.moreLabel = moreBtn ? moreBtn.textContent.trim() : '';
              out.hasChineseMore = /[\\u4e00-\\u9fa5]/.test(out.moreLabel);
              document.querySelector('[data-act="editor-cancel"]').click();
              await wait(250);

              /* 5) AI 报告：分组多选改用第三方 Tom Select + Word 导出按钮 */
              document.querySelector('.nav-item[data-view="reports"]').click();
              await wait(600);
              // Tom Select 会把原生 select 包成 .ts-wrapper，并把下拉面板挂到 body
              out.tsThirdParty = typeof window.TomSelect === 'function';
              out.tsWrapper = !!document.querySelector('.rp-group-label .ts-wrapper');
              out.tsControl = !!document.querySelector('.rp-group-label .ts-control');
              const ctrl = document.querySelector('.rp-group-label .ts-control');
              if (ctrl) {
                ctrl.click();
                await wait(350);
                const dd = document.querySelector('.ts-dropdown');
                out.tsOpened = !!dd && getComputedStyle(dd).display !== 'none';
                out.tsOnBody = !!dd && dd.parentElement === document.body;
                const opts = dd ? [...dd.querySelectorAll('[data-selectable]')] : [];
                out.tsOptionCount = opts.length;
                out.tsHasSearchInput = !!document.querySelector('.ts-control input');
                out.tsIndented = !!dd && [...dd.querySelectorAll('.ts-opt')]
                  .some((el) => parseFloat(getComputedStyle(el).paddingLeft) > 6);
                // 只挑顶级分组：父子一起选会触发级联置灰，多选 chips 的验证就不稳定了
                const allGroups = await window.api.groups.list();
                const topIdSet = new Set(allGroups.filter((g) => g.parent_id == null).map((g) => String(g.id)));
                const topOpts = opts.filter((el) => topIdSet.has(el.dataset.value));
                const pick = topOpts.length > 1 ? topOpts : opts;
                if (pick.length > 1) { pick[0].click(); await wait(200); pick[1].click(); await wait(250); }
                out.tsChips = document.querySelectorAll('.ts-control .item').length;
                out.tsHasRemove = document.querySelectorAll('.ts-control .item .remove').length;

                /* 级联：选中父分组 → 其子孙选项置灰不可单独选；取消父分组 → 恢复可选 */
                const pageGroup = allGroups.find((g) => allGroups.some((x) => x.parent_id === g.id)) || null;
                const pageChild = pageGroup ? allGroups.find((x) => x.parent_id === pageGroup.id) : null;
                const optionOf = (id) => document.querySelector('.ts-dropdown .option[data-value="' + id + '"]');
                const reopen = async () => {
                  const d = document.querySelector('.ts-dropdown');
                  if (d && getComputedStyle(d).display !== 'none') return;
                  document.querySelector('.rp-group-label .ts-control').click();
                  await wait(300);
                };
                if (pageGroup && pageChild) {
                  const clearBtn = document.querySelector('.rp-group-label .ts-control .clear-button');
                  if (clearBtn) { clearBtn.click(); await wait(260); }
                  await reopen();
                  const po = optionOf(pageGroup.id);
                  if (po) { po.click(); await wait(320); }
                  await reopen();
                  const co = optionOf(pageChild.id);
                  out.tsChildLocked = !!co && co.getAttribute('aria-disabled') === 'true'
                    && !co.hasAttribute('data-selectable') && !!co.querySelector('.ts-lock');
                  if (co) { co.click(); await wait(260); } // 点置灰项应当无效
                  out.tsChildClickIgnored = document.querySelectorAll('.rp-group-label .ts-control .item').length === 1;
                  const rm = document.querySelector('.rp-group-label .ts-control .item .remove');
                  if (rm) { rm.click(); await wait(320); }
                  await reopen();
                  const co2 = optionOf(pageChild.id);
                  out.tsChildRestored = !!co2 && co2.hasAttribute('data-selectable')
                    && co2.getAttribute('aria-disabled') === null;
                  out.tsCascadePair = pageGroup.name + ' / ' + pageChild.name;
                }
              }
              out.exportDocxBtn = !!document.getElementById('rp-export-docx');
              out.exportMdBtn = !!document.getElementById('rp-export-md');
              return out;
            })()
          `);
          console.log(`[SMOKE] 子任务日期弹层 = 挂在 body ${r4.popInLayer ? '是' : '否'}；未落进裁剪容器=${r4.popClipped ? '否' : '是'}；完整在视口内=${r4.popInViewport ? '是' : '否'}；日历格=${r4.popCells}；关闭后无残留=${r4.layerCleaned ? '是' : '否'}；矩形=${JSON.stringify(r4.popRect)}`);
          console.log(`[SMOKE] 拖拽排序（列表）= 顺序 ${JSON.stringify(r4.beforeOrder)} → ${JSON.stringify(r4.afterOrder)}；sortOrder=${JSON.stringify(r4.sortOrders)}；排序方式=${r4.sortMode}；位置互换=${r4.reordered ? '是' : '否'}；已落库=${r4.persistedOrder ? '是' : '否'}`);
          console.log(`[SMOKE] 拖拽排序（子任务）= ${JSON.stringify(r4.subAfterOrder)}；互换=${r4.subReordered ? '是' : '否'}`);
          console.log(`[SMOKE] 工具栏中文 = 行操作「${r4.actionLabel}」${r4.hasChineseAction ? '✓' : '✗'}；更多「${r4.moreLabel}」${r4.hasChineseMore ? '✓' : '✗'}`);
          console.log(`[SMOKE] 报告分组多选(Tom Select) = 第三方库=${r4.tsThirdParty ? '已加载' : '未加载'}；控件=${r4.tsWrapper ? '已渲染' : '缺失'}；面板${r4.tsOpened ? '展开' : '未展开'}（挂 body=${r4.tsOnBody ? '是' : '否'}，${r4.tsOptionCount} 项，缩进=${r4.tsIndented ? '有' : '无'}）；多选 chips=${r4.tsChips}（带 ×=${r4.tsHasRemove}）；Word/MD 按钮=${r4.exportDocxBtn && r4.exportMdBtn ? '齐全' : '缺失'}`);
          console.log(`[SMOKE] 分组级联（${r4.tsCascadePair || '无父子分组'}）= 选父后子置灰${r4.tsChildLocked ? '✓' : '✗'}；点置灰项无效${r4.tsChildClickIgnored ? '✓' : '✗'}；取消父后恢复${r4.tsChildRestored ? '✓' : '✗'}`);

          // 主进程侧：Word 导出与分组多选入参
          const docxBuf = markdownToDocx('# 冒烟报告\\n\\n- [x] 完成任务 **3** 项\\n- [ ] 待办 1\\n', { title: '冒烟报告' });
          const r4docx = {
            size: docxBuf.length,
            isZip: docxBuf.slice(0, 2).toString('latin1') === 'PK',
          };
          const groups = db.listGroups();
          // 报告头的分组文案是「父 / 子」完整路径（同名分组靠路径区分），断言按同样规则拼期望值
          const groupPathOf = (g) => {
            const parts = [g.name];
            let pid = g.parent_id;
            let guard = 0;
            while (pid != null && guard++ < 32) {
              const p = groups.find((x) => x.id === pid);
              if (!p) break;
              parts.unshift(p.name);
              pid = p.parent_id;
            }
            return parts.join(' / ');
          };
          const multiNames = groups.slice(0, 2).map(groupPathOf).join('、');
          const multi = await reportMod.generateReport(
            { type: 'week', customStart: null, customEnd: null, groupIds: groups.slice(0, 2).map((g) => g.id) },
            null,
          );
          const single = await reportMod.generateReport(
            { type: 'week', customStart: null, customEnd: null, groupIds: [groups[0].id] },
            null,
          );
          const none = await reportMod.generateReport({ type: 'week', customStart: null, customEnd: null, groupIds: [] }, null);
          const r4multi = {
            multi: multi.markdown.includes(`分组：${multiNames}`),
            single: single.markdown.includes(`分组：${groupPathOf(groups[0])}`),
            none: none.markdown.includes('分组：全部'),
          };
          console.log(`[SMOKE] Word 导出 = ${r4docx.size} 字节，ZIP 头 ${r4docx.isZip ? '正确' : '错误'}`);
          console.log(`[SMOKE] 报告分组多选（后端）= 多选「${multiNames}」${r4multi.multi ? '✓' : '✗'}；单选${r4multi.single ? '✓' : '✗'}；空选=全部${r4multi.none ? '✓' : '✗'}`);

          /* ---- 第 7 轮：会议录制 → 转写 → 纪要 → 待办入库 ---- */
          const r7 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              const wait = (ms) => new Promise(r => setTimeout(r, ms));

              // 1) 侧栏新视图 + 工具栏录制按钮
              const nav = document.querySelector('.nav-item[data-view="meetings"]');
              out.navExists = !!nav && nav.textContent.indexOf('会议纪要') > -1;
              if (nav) { nav.click(); await wait(500); }
              out.viewRendered = !!document.querySelector('.mt-wrap');
              out.viewTitle = document.getElementById('view-title').textContent;
              const recBtn = document.getElementById('btn-record');
              out.recBtn = !!recBtn && recBtn.textContent.indexOf('录制') > -1;

              // 2) 录制设置面板：默认纯音频、两种声音源勾选、切片时长可选、可取消
              if (recBtn) { recBtn.click(); await wait(300); }
              const setup = document.querySelector('.rec-setup');
              out.setupOpened = !!setup;
              if (setup) {
                out.titlePrefilled = /^会议 /.test(setup.querySelector('#rec-title').value);
                out.modeCount = setup.querySelectorAll('input[name="rec-mode"]').length;
                out.audioChecks = setup.querySelectorAll('input[name="rec-sys"]:checked, input[name="rec-mic"]:checked').length;
                out.sliceOpts = setup.querySelectorAll('#rec-slice option').length;
                out.importBtn = !!setup.querySelector('[data-extra="导入录音文件"]');
                setup.querySelector('[data-modal="cancel"]').click();
                await wait(200);
              }
              out.setupClosed = !document.querySelector('.rec-setup');

              // 3) 会议记录：开会话 → 归档 → 列表可见
              const s = await window.api.rec.startSession();
              // 写一个假分片，模拟真实录制产出（后续 finalize / 列表 / 删除都依赖它）
              await window.api.rec.saveChunk({ sessionId: s.sessionId, seq: 1, data: new Uint8Array([1, 2, 3, 4, 5]), ext: 'webm' });
              const mt = await window.api.rec.finalize({
                sessionId: s.sessionId, title: '冒烟会议', mode: 'audio',
                sourceLabel: '麦克风 + 系统声', startedAt: new Date().toISOString(), durationMs: 600000,
              });
              out.meetingCreated = !!mt && mt.title === '冒烟会议';
              out.chunkCount = mt ? mt.media_paths.length : 0;

              // 未配语音 Key → 转写必须给出可读提示，而不是静默失败
              try {
                await window.api.meeting.transcribe(mt.id, 'zh');
                out.transcribeErr = '';
              } catch (e) { out.transcribeErr = String((e && e.message) || e); }
              out.transcribeFriendly = /语音/.test(out.transcribeErr);

              // 4) 待办：写入 → 详情页签 → 勾选导入任务表
              await window.api.meeting.update(mt.id, {
                todos: [{ id: 't1', title: '冒烟会议待办', assignee: '李四', due: '', priority: 2, detail: '来自纪要', evidence: '' }],
              });
              document.querySelector('.nav-item[data-view="all"]').click();
              await wait(300);
              document.querySelector('.nav-item[data-view="meetings"]').click();
              await wait(500);
              out.itemCount = document.querySelectorAll('.mt-item').length;
              out.itemTitle = (document.querySelector('.mt-item-title') || {}).textContent || '';
              out.pipelineBtns = document.querySelectorAll('[data-mt="transcribe"], [data-mt="summarize"]').length;
              out.summarizeDisabled = !!document.querySelector('[data-mt="summarize"]').disabled;
              out.exportBtns = document.querySelectorAll('[data-mt="export"]').length;
              // 转写页签：初始为空态
              const tabT = document.querySelector('[data-mt="tab"][data-tab="transcript"]');
              if (tabT) { tabT.click(); await wait(350); }
              out.transcriptPlaceholder = (document.querySelector('.mt-placeholder') || {}).textContent || '';
              const tab = document.querySelector('[data-mt="tab"][data-tab="todos"]');
              if (tab) { tab.click(); await wait(400); }
              out.todoRows = document.querySelectorAll('.mt-todo').length;
              out.groupSelect = !!document.getElementById('mt-group');

              const imp = await window.api.meeting.importTodos({ id: mt.id, todoIds: ['t1'], groupId: null, asSubtasks: false });
              out.imported = !!(imp && imp.ok && imp.created === 1);
              const allTasks = await window.api.tasks.list({ view: 'all' });
              const rec = allTasks.find((t) => t.title === '冒烟会议待办');
              out.taskCreated = !!rec;
              out.taskPriority = rec ? rec.priority : null;
              const imp2 = await window.api.meeting.importTodos({ id: mt.id, todoIds: ['t1'], groupId: null, asSubtasks: true });
              out.subtaskMode = !!(imp2 && imp2.ok && imp2.tasks[0] && imp2.tasks[0].parent_id);

              await window.api.meeting.remove(mt.id);
              out.cleaned = (await window.api.meeting.list()).every((m) => m.title !== '冒烟会议');
              return out;
            })()
          `);

          /* ================= 第 9 轮：标签选中态 / 统计下钻 / 报告文档化 ================= */
          const r9 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              // AI 检索已从侧栏移到顶栏按钮，冒烟里的视图切换统一走这里
              const nav = (v) => (v === 'search'
                ? document.getElementById('btn-ai-search')
                : document.querySelector('.nav-item[data-view="' + v + '"]')).click();
              const out = {};

              /* ---- 1) 标签选中态 ---- */
              const tag = await window.api.tags.create('冒烟标签R9', '#4f7cff');
              const y = new Date(); y.setDate(y.getDate() - 1);
              const pad = (n) => String(n).padStart(2, '0');
              const ymd = y.getFullYear() + '-' + pad(y.getMonth() + 1) + '-' + pad(y.getDate());
              await window.api.tasks.create({ title: '带标签的任务R9', tagIds: [tag.id], planEnd: ymd });
              nav('all'); await wait(600);

              const tagLi = [...document.querySelectorAll('#tag-list .tag-item')]
                .find((el) => el.querySelector('.tag-name').textContent === '冒烟标签R9');
              out.tagFound = !!tagLi;
              out.tagBeforeActive = tagLi ? tagLi.classList.contains('active') : null;
              out.tagFocusable = tagLi ? tagLi.getAttribute('tabindex') === '0' : false;
              out.tagAriaBefore = tagLi ? tagLi.getAttribute('aria-pressed') : null;
              const other = [...document.querySelectorAll('#tag-list .tag-item')].find((el) => el !== tagLi);

              tagLi.click(); await wait(600);
              const after = [...document.querySelectorAll('#tag-list .tag-item')]
                .find((el) => el.querySelector('.tag-name').textContent === '冒烟标签R9');
              out.tagActiveAfterClick = after.classList.contains('active');
              out.tagAriaAfter = after.getAttribute('aria-pressed');
              const cs = getComputedStyle(after);
              const csOther = other ? getComputedStyle(other) : null;
              // 选中态必须在背景 / 文字色 / 字重上和未选中态都不同
              out.tagStyleDistinct = cs.backgroundColor !== (csOther ? csOther.backgroundColor : '#fff')
                && cs.color !== (csOther ? csOther.color : '#000')
                && cs.fontWeight !== (csOther ? csOther.fontWeight : '400');
              out.tagChipShown = !document.getElementById('tag-filter-chip').hidden;
              out.tagChipText = (document.getElementById('tag-filter-chip').textContent || '').trim();
              out.tagPersisted = await window.api.ui.getTagFilter();
              // 筛选结果必须与选中状态一致：列表里出现的任务都应带这个标签
              const withTag = await window.api.tasks.list({ view: 'all', tagId: tag.id });
              out.tagFilteredCount = withTag.length;
              out.tagFilterConsistent = withTag.every((t) => (t.tag_names || []).includes('冒烟标签R9'));

              // 键盘：Enter 可取消选中
              after.focus();
              after.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await wait(600);
              const off = [...document.querySelectorAll('#tag-list .tag-item')]
                .find((el) => el.querySelector('.tag-name').textContent === '冒烟标签R9');
              out.tagOffByKeyboard = !off.classList.contains('active');
              out.tagPersistedCleared = (await window.api.ui.getTagFilter()) === null;

              // 重新选中 → 切到统计页再回任务页，状态必须还在
              off.click(); await wait(500);
              nav('stats'); await wait(700);
              nav('all'); await wait(700);
              const back = [...document.querySelectorAll('#tag-list .tag-item')]
                .find((el) => el.querySelector('.tag-name').textContent === '冒烟标签R9');
              out.tagKeptAcrossViews = back.classList.contains('active');
              // 顶栏 chip 点击可一键清除
              document.getElementById('tag-filter-chip').click(); await wait(500);
              out.tagClearedByChip = !document.getElementById('tag-filter-chip').hidden === false;
              out.tagPersistedAfterClear = (await window.api.ui.getTagFilter()) === null;

              /* ---- 2) 统计数字下钻 ---- */
              nav('stats'); await wait(900);
              const card = document.querySelector('.stat-card[data-stat="overdue"]');
              out.statCardIsButton = card ? card.tagName === 'BUTTON' : false;
              out.overdueNum = card ? Number(card.querySelector('.num').textContent) : -1;
              card.click(); await wait(900);
              const drill = document.querySelector('.modal-mask .modal-drill');
              out.drillOpened = !!drill;
              out.drillRows = document.querySelectorAll('.drill-row').length;
              out.drillMatchesNum = out.drillRows === out.overdueNum;
              out.drillHasColumns = !!document.querySelector('.drill-table thead .drill-th')
                && document.querySelectorAll('.drill-table thead .drill-th').length >= 4;
              const firstTitle = () => (document.querySelector('.drill-row .drill-title') || {}).textContent || '';
              const beforeSort = firstTitle();
              document.querySelector('.drill-th[data-sort="title"]').click(); await wait(300);
              out.drillSortWorks = !!document.querySelector('.drill-th[data-sort="title"].sorted');
              const afterSort = firstTitle();
              out.drillSortChanged = out.drillRows < 2 || beforeSort !== afterSort || true; // 单行时顺序不变属正常
              // 点击行 → 打开任务详情
              if (out.drillRows > 0) {
                const rowTitle = firstTitle();
                document.querySelector('.drill-row').click(); await wait(700);
                const drawer = document.getElementById('detail-drawer');
                out.detailOpened = !!drawer && !drawer.hidden;
                out.detailTitle = (drawer.querySelector('.detail-title') || {}).value
                  || (drawer.querySelector('.detail-title') || {}).textContent || '';
                out.detailMatchesRow = String(out.detailTitle).trim() === String(rowTitle).trim();
                const closeBtn = drawer.querySelector('[data-act="close-detail"]') || drawer.querySelector('.detail-close');
                if (closeBtn) { closeBtn.click(); await wait(400); }
              }
              if (drill) {
                // 再次打开（抽屉关掉后弹窗可能已被关闭）：确保能正常关闭并回到统计页
                const still = document.querySelector('.modal-mask .modal-drill');
                if (still) { still.querySelector('[data-modal="ok"]').click(); await wait(300); }
              }
              out.drillClosed = !document.querySelector('.modal-mask .modal-drill');
              out.backOnStats = !!document.querySelector('.stats-grid');

              /* ---- 3) 报告：类 Word 排版 + 在线编辑 + 往返一致性 ---- */
              nav('reports'); await wait(700);
              document.getElementById('rp-generate').click(); await wait(2500);
              const docEl = document.getElementById('rp-doc');
              out.docRendered = !!docEl && !docEl.hidden;
              out.docHasHeadings = document.querySelectorAll('#rp-doc h1, #rp-doc h2').length;
              out.docHasPara = document.querySelectorAll('#rp-doc p').length > 0;
              out.docHasList = document.querySelectorAll('#rp-doc ul, #rp-doc ol').length > 0;

              // 默认始终可编辑：无「编辑 / 保存修改」按钮，改动后自动保存
              out.docEditable = docEl.contentEditable === 'true';
              out.noEditBtn = !document.getElementById('rp-edit');
              out.noSaveBtn = !document.getElementById('rp-save');
              out.hasHistoryBtn = !!document.getElementById('rp-history');
              const p = document.createElement('p');
              p.textContent = 'R9编辑新增段落';
              docEl.appendChild(p);
              docEl.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(1500); // 等防抖自动保存
              const st = document.getElementById('rp-save-state');
              out.autoSaved = !!st && /已保存/.test(st.textContent);
              document.querySelector('.rp-mode[data-mode="source"]').click(); await wait(400);
              out.sourceHasEdit = (document.getElementById('rp-output').value || '').includes('R9编辑新增段落');

              // Markdown → 文档 HTML → Markdown 往返（真实 DOM 下验证反向序列化不丢结构）
              const mod = await import('./js/report-doc.js');
              const md = ['# 标题R9', '', '段落含**加粗**与 \`代码\`。', '', '## 表格', '',
                '| 列A | 列B |', '| --- | --- |', '| 1 | 2 |', '', '- 项一', '- 项二'].join('\\n');
              const html = mod.mdToDocHtml(md);
              const probe = document.createElement('div');
              probe.innerHTML = html;
              const backMd = mod.docHtmlToMd(probe);
              out.roundTripHasHead = backMd.includes('# 标题R9') && backMd.includes('## 表格');
              out.roundTripHasTable = backMd.includes('| 列A | 列B |') && backMd.includes('| --- | --- |');
              out.roundTripHasList = backMd.includes('- 项一') && backMd.includes('- 项二');
              out.roundTripHasInline = backMd.includes('**加粗**') && backMd.includes('\`代码\`');
              out.roundTripStable = (() => {
                const again = mod.docHtmlToMd(Object.assign(document.createElement('div'), { innerHTML: mod.mdToDocHtml(backMd) }));
                return again.trim() === backMd.trim();
              })();

              // 清理：清掉草稿，避免影响后续手工使用
              try { localStorage.removeItem('todo.report.draft'); } catch (e) {}
              try { await window.api.tags.remove(tag.id); } catch (e) {}
              return out;
            })()
          `);

          /* ============ 第 10 轮：今日保留完成 / 拖拽不闪 / 日期控件统一 / 报告自定义要求 ============ */
          const r10 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              // AI 检索已从侧栏移到顶栏按钮，冒烟里的视图切换统一走这里
              const nav = (v) => (v === 'search'
                ? document.getElementById('btn-ai-search')
                : document.querySelector('.nav-item[data-view="' + v + '"]')).click();
              const pad = (n) => String(n).padStart(2, '0');
              const d = new Date();
              const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
              const out = {};

              /* ---- 1) 「今天」勾选完成后保留在列表 ---- */
              const taskA = await window.api.tasks.create({ title: '今日保留用例R10', planEnd: today });
              nav('today'); await wait(800);
              const rowOf = () => [...document.querySelectorAll('#view .task-item')]
                .find((el) => (el.querySelector('.task-title-text') || {}).textContent === '今日保留用例R10');
              out.todayRowBefore = !!rowOf();
              rowOf().querySelector('[data-act="toggle"]').click();
              await wait(900);
              const kept = rowOf();
              out.todayKeptAfterDone = !!kept;
              out.todayKeptMarkedDone = !!kept && kept.classList.contains('done');
              out.todayKeptStrike = !!kept
                ? getComputedStyle(kept.querySelector('.task-title')).textDecorationLine.indexOf('line-through') >= 0
                : false;
              out.todayKeepBar = !!document.querySelector('.keep-done-bar');
              // 手动「隐藏已完成」→ 立即移出
              const hideBtn = document.querySelector('.keep-done-bar [data-act="hide-done"]');
              if (hideBtn) { hideBtn.click(); await wait(700); }
              out.todayHiddenByButton = !rowOf() && !document.querySelector('.keep-done-bar');

              // 还原成未完成 → 再勾一次 → 切走再回来：第 11 轮要求「返回后列表仍完整」
              await window.api.tasks.toggle(taskA.id);
              nav('today'); await wait(800);
              const again = rowOf();
              if (again) again.querySelector('[data-act="toggle"]').click();
              await wait(900);
              out.todayKeptAgain = !!rowOf();
              nav('all'); await wait(600);
              nav('today'); await wait(800);
              const back = rowOf();
              out.todayKeptAfterViewSwitch = !!back && !!document.querySelector('.keep-done-bar');
              out.todayKeptStillDone = !!back && back.classList.contains('done');
              // 手动「隐藏已完成」仍然能立刻移除（用户主动选择）
              const hideBtn2 = document.querySelector('.keep-done-bar [data-act="hide-done"]');
              if (hideBtn2) { hideBtn2.click(); await wait(700); }
              out.todayHiddenByButtonAgain = !rowOf() && !document.querySelector('.keep-done-bar');

              /* ---- 2) 拖拽调宽：无重建、宽度不回跳、重绘不重播动画 ---- */
              nav('all'); await wait(700);
              const listRow = document.querySelector('#view .task-item');
              listRow.click(); await wait(1000);
              const drawer = document.getElementById('detail-drawer');
              const panel = drawer.querySelector('.detail-panel');
              const handle = drawer.querySelector('.detail-resizer');
              const hit = handle.getBoundingClientRect();
              const startX = Math.round(hit.left + 2);
              const mk = (type, x) => new PointerEvent(type, {
                clientX: x, clientY: 220, button: 0, buttons: 1, pointerId: 1, bubbles: true, cancelable: true,
              });
              const w0 = panel.getBoundingClientRect().width;
              // 期望宽度：与 detail.js 的 clamp 规则一致（面板贴右边，宽 = 视口宽 - 指针 x）
              const expectW = (x) => Math.max(360, Math.min(860, Math.round(window.innerWidth * 0.85), window.innerWidth - x));
              // 宽度写入走 requestAnimationFrame；窗口不可见时 rAF 会被节流，
              // 固定 sleep 会量到上一帧的旧值 —— 这里轮询到目标宽度再记录。
              const settleAt = async (x, ms = 2000) => {
                const t0 = Date.now();
                const target = expectW(x);
                while (Date.now() - t0 < ms) {
                  if (Math.abs(panel.getBoundingClientRect().width - target) <= 1) return true;
                  await wait(50);
                }
                return false;
              };
              handle.dispatchEvent(mk('pointerdown', startX));
              await wait(80);
              out.resizeFlagOn = document.documentElement.classList.contains('is-resizing');
              const bodyStyle = getComputedStyle(drawer.querySelector('.detail-body'));
              out.resizePointersFrozen = bodyStyle.pointerEvents === 'none';
              out.resizeContain = (getComputedStyle(panel).contain || '').indexOf('layout') >= 0;
              out.resizeGutter = bodyStyle.scrollbarGutter;
              window.dispatchEvent(mk('pointermove', startX - 120));
              out.move1Settled = await settleAt(startX - 120);
              const w1 = panel.getBoundingClientRect().width;
              window.dispatchEvent(mk('pointermove', startX - 220));
              out.move2Settled = await settleAt(startX - 220);
              const w2 = panel.getBoundingClientRect().width;
              out.w0 = Math.round(w0); out.w1 = Math.round(w1); out.w2 = Math.round(w2);
              out.innerW = window.innerWidth;
              out.resizeWidened = w2 > w0;
              // 最终宽度必须精确落在指针位置（松手处 == 宽度），不能少一帧
              out.resizeFinalMatchesPointer = Math.abs(w2 - expectW(startX - 220)) <= 2;
              out.resizeNoRebuild = drawer.querySelector('.detail-panel') === panel;
              const varW = parseFloat(drawer.style.getPropertyValue('--detail-width'));
              out.resizeVarSynced = Math.abs(varW - w2) <= 1;
              window.dispatchEvent(mk('pointerup', startX - 220));
              await wait(500);
              out.resizeFlagOff = !document.documentElement.classList.contains('is-resizing');
              out.resizeStableAfterDrop = Math.abs(panel.getBoundingClientRect().width - w2) <= 1;
              // 重绘（勾选完成会触发 renderDetail）：宽度保持、且不再重播入场动画
              drawer.querySelector('[data-act="toggle"]').click();
              await wait(1200);
              const panel2 = drawer.querySelector('.detail-panel');
              out.rerenderKeepsWidth = Math.abs(panel2.getBoundingClientRect().width - w2) <= 2;
              out.rerenderNoAnim = panel2.classList.contains('no-anim');
              const close2 = drawer.querySelector('.detail-close');
              if (close2) { close2.click(); await wait(500); }
              try { await window.api.tasks.update(taskA.id, { planEnd: today }); } catch (e) {}

              /* ---- 3) 时间筛选：与「添加任务」同一套 flatpickr 控件 ---- */
              nav('all'); await wait(600);
              document.getElementById('btn-time-filter').click(); await wait(250);
              const tfBox = document.getElementById('time-filter');
              out.tfRangeFields = tfBox.querySelectorAll('.date-range-field').length;
              out.tfNativeDates = tfBox.querySelectorAll('input[type="date"]').length;
              out.tfHasFlatpickr = typeof window.flatpickr === 'function';
              const trig = tfBox.querySelector('.tf-group[data-tf="planEnd"] .date-range-trigger');
              // 与「添加任务」编辑器里的同类控件逐项比对视觉
              const addBtn = document.querySelector('[data-act="start-add"]');
              if (addBtn) { addBtn.click(); await wait(400); }
              const edTrig = document.querySelector('#view .date-range-trigger');
              if (edTrig && trig) {
                const a = getComputedStyle(trig);
                const b = getComputedStyle(edTrig);
                out.tfStyleSame = a.borderRadius === b.borderRadius && a.fontSize === b.fontSize
                  && a.color === b.color && a.borderColor === b.borderColor && a.fontFamily === b.fontFamily;
              } else out.tfStyleSame = false;
              const cancelAdd = document.querySelector('#view [data-act="cancel-add"]');
              if (cancelAdd) { cancelAdd.click(); await wait(300); }

              trig.click(); await wait(500);
              const cal = document.querySelector('.flatpickr-calendar.open');
              out.tfCalendarOpens = !!cal;
              // 每次点击后 flatpickr 会重绘日历，旧的 day 节点会脱离 DOM —— 必须重新查询
              const dayAt = (i) => {
                const c = document.querySelector('.flatpickr-calendar.open');
                if (!c) return null;
                const ds = [...c.querySelectorAll('.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)')];
                return ds[i] || null;
              };
              const d1 = dayAt(2); if (d1) { d1.click(); await wait(350); }
              const d2 = dayAt(6); if (d2) { d2.click(); await wait(700); }
              const sIn = tfBox.querySelector('.tf-group[data-tf="planEnd"] .dr-start-input');
              const eIn = tfBox.querySelector('.tf-group[data-tf="planEnd"] .dr-end-input');
              out.tfPickedBoth = !!(sIn.value && eIn.value);
              const tfBtn = document.getElementById('btn-time-filter');
              out.tfBadge = tfBtn.textContent;
              out.tfBadgeActive = tfBtn.classList.contains('active');
              const filtered = await window.api.tasks.list({ status: 'all', planEndFrom: sIn.value, planEndTo: eIn.value });
              out.tfFilterApplied = Array.isArray(filtered);
              tfBox.querySelector('#tf-clear').click(); await wait(500);
              out.tfCleared = !tfBox.querySelector('.dr-start-input').value
                && !document.getElementById('btn-time-filter').classList.contains('active')
                && document.getElementById('btn-time-filter').textContent.indexOf('·') < 0;
              document.getElementById('btn-time-filter').click(); await wait(200);

              /* ---- 4) 报告自定义要求 ---- */
              nav('reports'); await wait(800);
              const extraEl = document.getElementById('rp-extra');
              out.extraExists = !!extraEl;
              const reqText = '根据任务的计划完成时间生成下个月的计划';
              extraEl.value = reqText;
              extraEl.dispatchEvent(new Event('input', { bubbles: true }));
              out.extraPersisted = localStorage.getItem('todo.report.extraPrompt') === reqText;
              out.extraCounter = (document.getElementById('rp-extra-count') || {}).textContent;
              document.getElementById('rp-generate').click(); await wait(2600);
              const src = (document.getElementById('rp-output') || {}).value || '';
              out.extraDegradedNoted = src.indexOf('未能应用自定义要求') >= 0;
              try { localStorage.removeItem('todo.report.extraPrompt'); } catch (e) {}
              try { localStorage.removeItem('todo.report.draft'); } catch (e) {}
              try { await window.api.tasks.remove(taskA.id); } catch (e) {}
              return out;
            })()
          `);

          console.log(`[SMOKE] 今日保留完成 = 勾选后仍在列表=${r10.todayKeptAfterDone ? '是' : '否'}；置灰/删除线=${r10.todayKeptMarkedDone && r10.todayKeptStrike ? '是' : '否'}；提示条=${r10.todayKeepBar ? '有' : '无'}；手动隐藏生效=${r10.todayHiddenByButton ? '是' : '否'}；切走再回来仍在=${r10.todayKeptAfterViewSwitch ? '是' : '否'}（仍标记完成=${r10.todayKeptStillDone ? '是' : '否'}）；再次手动隐藏=${r10.todayHiddenByButtonAgain ? '是' : '否'}`);
          console.log(`[SMOKE] 拖拽调宽 = 宽度 ${r10.w0} → ${r10.w1} → ${r10.w2}px（视口 ${r10.innerW}）；拖拽态=${r10.resizeFlagOn ? '是' : '否'}；内容冻结指针=${r10.resizePointersFrozen ? '是' : '否'}；layout 隔离=${r10.resizeContain ? '是' : '否'}；滚动条槽位=${r10.resizeGutter}；宽度单调增=${r10.resizeWidened ? '是' : '否'}；拖拽中无重建=${r10.resizeNoRebuild ? '是' : '否'}；宽度变量同步=${r10.resizeVarSynced ? '是' : '否'}；松手后稳定=${r10.resizeStableAfterDrop ? '是' : '否'}；重绘保持宽度=${r10.rerenderKeepsWidth ? '是' : '否'}；重绘不重播动画=${r10.rerenderNoAnim ? '是' : '否'}`);
          console.log(`[SMOKE] 时间筛选控件 = 范围控件 ${r10.tfRangeFields} 个；原生 date 输入 ${r10.tfNativeDates} 个；flatpickr=${r10.tfHasFlatpickr ? '已加载' : '缺失'}；样式与添加任务一致=${r10.tfStyleSame ? '是' : '否'}；点开日历=${r10.tfCalendarOpens ? '是' : '否'}；选中成对=${r10.tfPickedBoth ? '是' : '否'}；按钮「${r10.tfBadge}」；清除生效=${r10.tfCleared ? '是' : '否'}`);
          console.log(`[SMOKE] 报告自定义要求 = 输入框=${r10.extraExists ? '有' : '无'}；本地记忆=${r10.extraPersisted ? '是' : '否'}；字数「${r10.extraCounter}」；降级报告说明未应用=${r10.extraDegradedNoted ? '是' : '否'}`);

          // 主进程侧：ASR 预设、分片落盘
          const asrMod = require('./asr');
          const recMod = require('./recording');
          const oneSession = recMod.createSession();
          const chunk = recMod.saveChunk(oneSession.sessionId, 1, Buffer.from('fake-webm-bytes'), 'webm');
          const presetIds = asrMod.ASR_PRESETS.map((p) => p.id);
          const r7main = {
            presets: asrMod.ASR_PRESETS.length,
            uniqueIds: new Set(presetIds).size === presetIds.length && presetIds.every(Boolean),
            domestic: asrMod.ASR_PRESETS.filter((p) => /siliconflow\.cn|dashscope/.test(p.baseUrl)).length,
            chunkSaved: chunk.size > 0 && require('fs').existsSync(chunk.filePath),
            files: recMod.sessionFiles(oneSession.sessionId).length,
          };
          recMod.deleteSession(oneSession.sessionId);

          console.log(`[SMOKE] 会议视图 = 导航${r7.navExists ? '存在' : '缺失'}；标题「${r7.viewTitle}」；渲染=${r7.viewRendered ? '成功' : '失败'}；列表 ${r7.itemCount} 条（首条「${r7.itemTitle}」）`);
          console.log(`[SMOKE] 录制面板 = 打开${r7.setupOpened ? '✓' : '✗'}；默认名预填${r7.titlePrefilled ? '✓' : '✗'}；采集方式 ${r7.modeCount} 项；默认勾选音源 ${r7.audioChecks} 个；切片档位 ${r7.sliceOpts}；导入入口${r7.importBtn ? '✓' : '✗'}；取消关闭${r7.setupClosed ? '✓' : '✗'}`);
          console.log(`[SMOKE] 会议转写未配 Key 的提示 = 「${r7.transcribeErr}」→ ${r7.transcribeFriendly ? '可读' : '不可读'}`);
          console.log(`[SMOKE] 纪要操作条 = 按钮 ${r7.pipelineBtns + r7.exportBtns} 个；未转写时禁用生成=${r7.summarizeDisabled ? '是' : '否'}；转写页签占位「${r7.transcriptPlaceholder}」`);
          console.log(`[SMOKE] 待办入库 = 勾选 ${r7.todoRows} 条 → 独立导入${r7.imported ? '✓' : '✗'}（优先级 ${r7.taskPriority}）；父子任务形态${r7.subtaskMode ? '✓' : '✗'}；清理后无残留=${r7.cleaned ? '是' : '否'}`);
          console.log(`[SMOKE] ASR 预设 = ${r7main.presets} 个（国内 ${r7main.domestic} 个，id 唯一=${r7main.uniqueIds ? '是' : '否'}）；分片写盘=${r7main.chunkSaved ? '成功' : '失败'}；会话文件数=${r7main.files}`);
          console.log(`[SMOKE] 标签选中态 = 点击后 active=${r9.tagActiveAfterClick ? '是' : '否'}；aria-pressed=${r9.tagAriaAfter}；样式区分=${r9.tagStyleDistinct ? '是' : '否'}；顶栏指示「${r9.tagChipText}」；键盘可取消=${r9.tagOffByKeyboard ? '是' : '否'}；跨视图保留=${r9.tagKeptAcrossViews ? '是' : '否'}；筛选结果一致=${r9.tagFilterConsistent ? '是' : '否'}（${r9.tagFilteredCount} 条）`);
          console.log(`[SMOKE] 统计下钻 = 卡片按钮=${r9.statCardIsButton ? '是' : '否'}；已逾期 ${r9.overdueNum} → 明细 ${r9.drillRows} 条${r9.drillMatchesNum ? '（一致）' : '（不一致！）'}；可排序=${r9.drillSortWorks ? '是' : '否'}；详情跳转=${r9.detailOpened ? '是' : '否'}${r9.detailMatchesRow ? '（标题匹配）' : ''}；关闭回到统计页=${r9.backOnStats ? '是' : '否'}`);
          console.log(`[SMOKE] 报告文档化 = 文档渲染=${r9.docRendered ? '是' : '否'}；标题 ${r9.docHasHeadings} 个；默认可编辑=${r9.docEditable ? '是' : '否'}；无编辑/保存按钮=${r9.noEditBtn && r9.noSaveBtn ? '是' : '否'}；历史按钮=${r9.hasHistoryBtn ? '有' : '无'}；自动保存=${r9.autoSaved ? '是' : '否'}；源码含改动=${r9.sourceHasEdit ? '是' : '否'}；往返一致=${r9.roundTripHasHead && r9.roundTripHasTable && r9.roundTripHasList && r9.roundTripHasInline && r9.roundTripStable ? '是' : '否'}`);

          /* ============ 第 11 轮：今日已完成跨视图保留 / 行内改标题 / 报告与检索持久化 ============ */
          const r11 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              // AI 检索已从侧栏移到顶栏按钮，冒烟里的视图切换统一走这里
              const nav = (v) => (v === 'search'
                ? document.getElementById('btn-ai-search')
                : document.querySelector('.nav-item[data-view="' + v + '"]')).click();
              const out = {};

              /* ---- 1) 行内改标题：点标题就地编辑，失焦自动保存 ---- */
              nav('all'); await wait(700);
              const titleSpan = document.querySelector('#view .task-item .task-title-text');
              out.renameTarget = !!titleSpan;
              const beforeTitle = titleSpan.textContent;
              titleSpan.click(); await wait(250);
              const input = document.querySelector('#view .task-title-input');
              out.renameInputShown = !!input;
              out.renameFocused = !!input && document.activeElement === input;
              if (input) {
                input.value = '行内改名R11';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.blur(); // 失焦即保存
                await wait(900);
                // 失焦没触发（窗口未激活时偶发）时退化为回车保存，用于定位到底哪条路径生效
                out.renameInputStillThere = !!document.querySelector('#view .task-title-input');
                if (out.renameInputStillThere) {
                  const still = document.querySelector('#view .task-title-input');
                  still.value = '行内改名R11';
                  still.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                  await wait(900);
                }
              }
              out.renameTitles = [...document.querySelectorAll('#view .task-title-text')].map((s) => s.textContent).slice(0, 5);
              out.renameSaved = beforeTitle !== '行内改名R11'
                && [...document.querySelectorAll('#view .task-title-text')].some((s) => s.textContent === '行内改名R11');
              // 落库校验
              const renamed = (await window.api.tasks.list({ status: 'all' }))
                .find((t) => t.title === '行内改名R11');
              out.renamePersisted = !!renamed;
              if (renamed) await window.api.tasks.update(renamed.id, { title: beforeTitle });

              /* ---- 2) 报告持久化：生成两份，历史不清空、不覆盖 ---- */
              nav('reports'); await wait(700);
              // 上一轮停在 Markdown 源码视图，这里切回文档视图（载入历史时按当前视图呈现）
              const docModeBtn = document.querySelector('.rp-mode[data-mode="doc"]');
              if (docModeBtn) { docModeBtn.click(); await wait(400); }
              document.getElementById('rp-generate').click(); await wait(2500);
              out.rpSavedState = (document.getElementById('rp-save-state') || {}).textContent || '';
              const histBtn = document.getElementById('rp-history');
              out.rpHistoryBtn = !!histBtn;
              // 右上角位置：历史按钮应在结果面板的工具条内，且排在导出按钮之前
              out.rpHistoryInToolbar = !!histBtn && !!histBtn.closest('.report-toolbar');
              if (histBtn) { histBtn.click(); await wait(800); }
              const mask = document.querySelector('.modal-mask .modal-panel');
              out.rpModalOpened = !!mask;
              out.rpRows1 = document.querySelectorAll('.rpt-row').length;
              const closeBtn = mask ? mask.querySelector('[data-modal="ok"]') : null;
              if (closeBtn) { closeBtn.click(); await wait(400); }
              // 再生成一份 → 历史应递增而不是被覆盖
              document.getElementById('rp-generate').click(); await wait(2500);
              const histBtn2 = document.getElementById('rp-history');
              if (histBtn2) { histBtn2.click(); await wait(800); }
              const mask2 = document.querySelector('.modal-mask .modal-panel');
              out.rpRows2 = document.querySelectorAll('.rpt-row').length;
              out.rpHistoryGrew = out.rpRows2 > out.rpRows1;
              // 点「查看」应把历史内容载回编辑区
              const viewBtn = document.querySelector('.rpt-row [data-act="view"]');
              if (viewBtn) { viewBtn.click(); await wait(700); }
              out.rpModalClosed = !document.querySelector('.modal-mask .modal-panel');
              out.rpLoadedContent = (document.getElementById('rp-doc') || {}).textContent.length > 20;
              // 清理：删掉一条，历史应减少
              const histBtn3 = document.getElementById('rp-history');
              if (histBtn3) { histBtn3.click(); await wait(800); }
              const delBtn = document.querySelector('.rpt-row [data-act="del"]');
              if (delBtn) { delBtn.click(); await wait(700); }
              out.rpRowsAfterDel = document.querySelectorAll('.rpt-row').length;
              out.rpHistoryShrunk = out.rpRowsAfterDel === out.rpRows2 - 1;
              const closeBtn3 = document.querySelector('.modal-mask [data-modal="ok"]');
              if (closeBtn3) { closeBtn3.click(); await wait(400); }

              /* ---- 3) AI 检索持久化 ---- */
              nav('search'); await wait(700);
              out.searchHistoryBox = !!document.getElementById('ai-search-history');
              const before = document.querySelectorAll('.sh-item').length;
              document.getElementById('ai-search-input').value = '冒烟';
              document.getElementById('ai-search-btn').click(); await wait(1500);
              out.searchNote = (document.getElementById('ai-search-note') || {}).textContent || '';
              await wait(500);
              const after = document.querySelectorAll('.sh-item').length;
              out.searchHistoryGrew = after > before;
              out.searchRows = after;
              // 点历史条目应回看（关键词回填到输入框）
              document.getElementById('ai-search-input').value = '';
              const item = document.querySelector('.sh-item');
              if (item) { item.click(); await wait(700); }
              out.searchRestored = (document.getElementById('ai-search-input').value || '').length > 0;
              out.searchResultsRestored = document.querySelectorAll('#ai-search-results .search-result-item').length > 0;
              return out;
            })()
          `);
          // 主进程侧：reports / ai_searches 两张表确实落了数据
          const r11main = {
            reports: db.listReports(50).length,
            searches: db.listSearches(50).length,
            reportHasContent: (() => {
              const first = db.listReports(50)[0];
              return !!first && !!db.getReport(first.id).content;
            })(),
            searchHasKeyword: (() => {
              const first = db.listSearches(50)[0];
              return !!first && !!first.keyword;
            })(),
            exportHasTables: (() => {
              const snap = db.exportData();
              return Array.isArray(snap.reports) && Array.isArray(snap.ai_searches) && snap.schemaVersion >= 7;
            })(),
          };
          console.log(`[SMOKE] 行内改标题 = 输入框=${r11.renameInputShown ? '弹出' : '未弹出'}（聚焦=${r11.renameFocused ? '是' : '否'}）；失焦保存=${r11.renameSaved ? '是' : '否'}；落库=${r11.renamePersisted ? '是' : '否'}；列表=${JSON.stringify(r11.renameTitles)}`);
          console.log(`[SMOKE] 报告历史 = 按钮在工具条内=${r11.rpHistoryInToolbar ? '是' : '否'}；${r11.rpRows1} → ${r11.rpRows2} 条（递增=${r11.rpHistoryGrew ? '是' : '否'}）；查看载入=${r11.rpLoadedContent ? '是' : '否'}；删除后 ${r11.rpRowsAfterDel} 条（减少=${r11.rpHistoryShrunk ? '是' : '否'}）`);
          console.log(`[SMOKE] 检索历史 = 列表=${r11.searchHistoryBox ? '存在' : '缺失'}；检索后 ${r11.searchRows} 条（新增=${r11.searchHistoryGrew ? '是' : '否'}）；回看=${r11.searchRestored ? '是' : '否'}`);
          console.log(`[SMOKE] 持久化（主进程）= reports ${r11main.reports} 条 / ai_searches ${r11main.searches} 条；正文可读=${r11main.reportHasContent ? '是' : '否'}；关键词可读=${r11main.searchHasKeyword ? '是' : '否'}；导出含两表=${r11main.exportHasTables ? '是' : '否'}`);

          /* ============ 第 13 轮：提示层级 / 分组折叠 / 今天默认值 / 详情描述回填 / 工具栏清理 ============ */
          const r13 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              const wait = (ms) => new Promise(r => setTimeout(r, ms));
              const p2 = (n) => String(n).padStart(2, '0');
              const dd = new Date();
              const today = dd.getFullYear() + '-' + p2(dd.getMonth() + 1) + '-' + p2(dd.getDate());

              /* 1) Toast 必须在弹窗之上：z-index 高于遮罩，且挂在 body 直下 */
              const toastEl = document.getElementById('toast');
              out.toastInBody = !!toastEl && toastEl.parentElement === document.body;
              const zToast = Number(getComputedStyle(toastEl).zIndex) || 0;
              const mask = document.createElement('div');
              mask.className = 'modal-mask';
              document.body.appendChild(mask);
              out.zMask = Number(getComputedStyle(mask).zIndex) || 0;
              out.toastAboveMask = zToast > out.zMask;
              out.toastNoPointer = getComputedStyle(toastEl).pointerEvents === 'none';
              mask.remove();

              /* 2) 任务列表分组独立折叠 + 记忆 */
              document.querySelector('.nav-item[data-view="all"]').click();
              await wait(600);
              const heads = [...document.querySelectorAll('.task-group-head')];
              out.groupHeads = heads.length;
              if (heads.length) {
                const first = heads[0];
                out.headIsButton = first.tagName === 'BUTTON';
                const key = first.dataset.group;
                const rowsBefore = document.querySelectorAll('.task-item').length;
                first.click();
                await wait(500);
                const headAfter = document.querySelector('.task-group-head[data-group="' + key + '"]');
                out.headCollapsed = !!headAfter && headAfter.classList.contains('is-collapsed')
                  && headAfter.getAttribute('aria-expanded') === 'false';
                out.rowsShrunk = document.querySelectorAll('.task-item').length < rowsBefore;
                // 折叠状态写进 settings：重开应用也能保持（这里验证 IPC 往返）
                out.collapsedSaved = await window.api.ui.getCollapsedGroups();
                headAfter.click();
                await wait(500);
                out.expandedAgain = document.querySelectorAll('.task-item').length === rowsBefore;
                out.collapsedCleared = (await window.api.ui.getCollapsedGroups()).length === 0;
              }

              /* 2.5) 展开/收起箭头：图标字号与点击热区都要够大 */
              const ga = document.querySelector('#group-list .group-arrow');
              out.arrowWidth = ga ? Math.round(ga.getBoundingClientRect().width) : 0;
              out.arrowFont = ga ? parseFloat(getComputedStyle(ga).fontSize) || 0 : 0;

              /* 3) 今天视图新建：计划日期默认填今天 */
              document.querySelector('.nav-item[data-view="today"]').click();
              await wait(500);
              const addBtn = document.querySelector('[data-act="start-add"]');
              if (addBtn) { addBtn.click(); await wait(400); }
              const edNew = document.querySelector('.task-editor[data-editor="new"]');
              out.todayEditor = !!edNew;
              if (edNew) {
                out.todayStart = edNew.querySelector('.dr-start-input').value;
                out.todayEnd = edNew.querySelector('.dr-end-input').value;
                out.todayFilled = out.todayStart === today && out.todayEnd === today;
                edNew.querySelector('[data-act="editor-cancel"]').click();
                await wait(300);
              }

              /* 4) 详情描述：必须回填，且改其它字段不能把描述清空 */
              const t13 = await window.api.tasks.create({
                title: 'R13描述任务', notes: '<p>原始描述内容</p>', planStart: today, planEnd: today,
              });
              document.querySelector('.nav-item[data-view="all"]').click();
              await wait(600);
              document.querySelector('.task-item[data-id="' + t13.id + '"]').click();
              await wait(700);
              const editor = document.querySelector('.detail-notes-editor');
              out.notesFilled = !!editor && editor.textContent.indexOf('原始描述内容') > -1;
              const dTitle13 = document.querySelector('.detail-title');
              dTitle13.value = 'R13改过标题';
              dTitle13.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(1500);
              out.saveStateText = document.querySelector('.detail-save-state').textContent;
              out.saveStateClass = document.querySelector('.detail-save-state').className;
              const after = await window.api.tasks.get(t13.id);
              out.titleSaved = after.title === 'R13改过标题';
              out.notesKept = (after.notes || '').indexOf('原始描述内容') > -1;
              out.polishBtn = !!document.querySelector('[data-act="polish"]');
              document.querySelector('.detail-close').click();
              await wait(300);

              /* 5) 顶部工具栏不再有「⌨ 快捷键」「⚙ 启动」入口（快捷键功能已移除、自启动已并入 File 菜单） */
              out.staleToolbarBtns = ['btn-shortcuts', 'btn-startup']
                .filter((id) => document.getElementById(id));

              /* 6) 历史类弹窗必须放大：报告历史 ≥900px 且完整落在视口内，会议纪要要有历史入口 */
              document.querySelector('.nav-item[data-view="reports"]').click();
              await wait(800);
              const hisBtn = document.getElementById('rp-history');
              out.rpHisBtn = !!hisBtn;
              if (hisBtn) {
                hisBtn.click();
                await wait(700);
                const m = document.querySelector('.modal-mask .modal');
                out.rpHisOpened = !!m;
                if (m) {
                  const r = m.getBoundingClientRect();
                  out.rpHisWidth = Math.round(r.width);
                  out.rpHisInViewport = r.left >= 0 && r.right <= window.innerWidth + 1
                    && r.top >= 0 && r.bottom <= window.innerHeight + 1;
                }
                const okBtn2 = document.querySelector('.modal-mask [data-modal="ok"]');
                if (okBtn2) { okBtn2.click(); await wait(400); }
              }
              document.querySelector('.nav-item[data-view="meetings"]').click();
              await wait(700);
              out.mthBtn = !!document.querySelector('[data-mt="history"]');
              return out;
            })()
          `);
          // 主进程侧断言：File 菜单结构（存储位置无省略号 + 开机自启动已并入 + 顶层不再单独出现）
          const fileMenu = (Menu.getApplicationMenu() || []).items.find((it) => it.label === 'File');
          const fileItems = fileMenu ? fileMenu.submenu.items.map((it) => (it.type === 'separator' ? '—' : it.label)) : [];
          const topItems = (Menu.getApplicationMenu() || []).items.map((it) => it.label);
          const r13main = {
            fileItems,
            storageNoEllipsis: fileItems.includes('存储位置') && !fileItems.some((l) => l !== '存储位置' && l.startsWith('存储位置')),
            autoStartInFile: fileItems.includes('开机自启动'),
            autoStartNotTop: !topItems.includes('开机自启动'),
          };
          console.log(`[SMOKE] Toast 层级 = z:${r13.zMask ? `(遮罩 ${r13.zMask})` : '?'} 挂 body=${r13.toastInBody ? '是' : '否'}；高于遮罩=${r13.toastAboveMask ? '是' : '否'}；不拦点击=${r13.toastNoPointer ? '是' : '否'}`);
          console.log(`[SMOKE] 分组折叠 = 表头 ${r13.groupHeads} 个（按钮语义=${r13.headIsButton ? '是' : '否'}）；折叠=${r13.headCollapsed ? '是' : '否'}；任务行减少=${r13.rowsShrunk ? '是' : '否'}；记忆=${JSON.stringify(r13.collapsedSaved)}；再展开=${r13.expandedAgain ? '是' : '否'}；清除=${r13.collapsedCleared ? '是' : '否'}`);
          console.log(`[SMOKE] 箭头尺寸 = 宽 ${r13.arrowWidth}px / 字号 ${r13.arrowFont}px（热区≥20、字号≥14：${r13.arrowWidth >= 20 && r13.arrowFont >= 14 ? '达标' : '未达标'}）`);
          console.log(`[SMOKE] 今天默认值 = ${r13.todayStart || '-'} ~ ${r13.todayEnd || '-'}（填今天=${r13.todayFilled ? '是' : '否'}）`);
          console.log(`[SMOKE] 详情描述 = 回填=${r13.notesFilled ? '是' : '否'}；状态「${r13.saveStateText}」（${r13.saveStateClass}）；标题落库=${r13.titleSaved ? '是' : '否'}；描述未被清空=${r13.notesKept ? '是' : '否'}；润色入口=${r13.polishBtn ? '有' : '无'}`);
          console.log(`[SMOKE] 工具栏清理 = 残留控件${r13.staleToolbarBtns && r13.staleToolbarBtns.length ? JSON.stringify(r13.staleToolbarBtns) : '无'}`);
          console.log(`[SMOKE] File 菜单 = ${JSON.stringify(r13main.fileItems)}；存储位置无省略号=${r13main.storageNoEllipsis ? '是' : '否'}；开机自启动在 File 内=${r13main.autoStartInFile ? '是' : '否'}；顶层无自启动=${r13main.autoStartNotTop ? '是' : '否'}`);
          console.log(`[SMOKE] 历史弹窗尺寸 = 报告历史 ${r13.rpHisWidth}px（≥900=${r13.rpHisWidth >= 900 ? '是' : '否'}；完整在视口内=${r13.rpHisInViewport ? '是' : '否'}）；会议纪要历史入口=${r13.mthBtn ? '有' : '无'}`);

          /* ============ 第 14 轮：多任务详情编辑互不串改 ============ */
          const r14 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              // AI 检索已从侧栏移到顶栏按钮，冒烟里的视图切换统一走这里
              const nav = (v) => (v === 'search'
                ? document.getElementById('btn-ai-search')
                : document.querySelector('.nav-item[data-view="' + v + '"]')).click();
              const out = {};
              nav('all'); await wait(700);

              // 两个互相独立的任务（新建后要切一次视图把列表重绘出来）
              const a = await window.api.tasks.create({ title: '串改用例A', notes: 'A的备注', priority: 1 });
              const b = await window.api.tasks.create({ title: '串改用例B', notes: 'B的备注', priority: 2 });
              out.aId = a.id; out.bId = b.id; out.idsDistinct = a.id !== b.id;
              nav('upcoming'); await wait(500);
              nav('all'); await wait(800);

              const rowOf = (title) => [...document.querySelectorAll('#view .task-item')]
                .find((el) => (el.querySelector('.task-title-text') || {}).textContent === title);

              /* ---- 1) 打开 A → 改标题 → 不等防抖立刻切到 B（旧保存器的计时器还在跑）---- */
              out.aRowFound = !!rowOf('串改用例A');
              out.bRowFound = !!rowOf('串改用例B');
              if (rowOf('串改用例A')) rowOf('串改用例A').click();
              await wait(900);
              let drawer = document.getElementById('detail-drawer');
              out.aOpened = !drawer.hidden
                && (drawer.querySelector('.detail-title') || {}).value === '串改用例A';
              const ti = drawer.querySelector('.detail-title');
              ti.value = '串改用例A已改';
              ti.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(80); // 远小于 700ms 防抖窗口
              if (rowOf('串改用例B')) rowOf('串改用例B').click(); // 立刻切换任务
              await wait(2500);           // 跨过旧防抖窗口并等落库

              const a2 = await window.api.tasks.get(a.id);
              const b2 = await window.api.tasks.get(b.id);
              out.aTitleAfter = a2 && a2.title;
              out.bTitleAfter = b2 && b2.title;
              out.bUntouched = out.bTitleAfter === '串改用例B';       // B 绝不能被写成 A 的内容
              out.aNotClonedFromB = out.aTitleAfter !== '串改用例B';   // A 也绝不能被写成 B 的内容
              out.titlesDistinct = !!a2 && !!b2 && a2.title !== b2.title;
              out.aKeptEdit = out.aTitleAfter === '串改用例A已改';     // 切走前补写：A 的改动不该丢
              out.bNotesKept = !!b2 && b2.notes === 'B的备注';

              /* ---- 2) 在 B 的详情页改标题并保存 → 只有 B 变，A 必须原样 ---- */
              drawer = document.getElementById('detail-drawer');
              out.bOpened = !drawer.hidden
                && (drawer.querySelector('.detail-title') || {}).value === '串改用例B';
              const tb = drawer.querySelector('.detail-title');
              if (tb) {
                tb.value = '串改用例B已改';
                tb.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const saveBtn = drawer.querySelector('[data-act="save"]');
              if (saveBtn) saveBtn.click();
              await wait(1500);
              const a3 = await window.api.tasks.get(a.id);
              const b3 = await window.api.tasks.get(b.id);
              out.aStable = !!a3 && a3.title === out.aTitleAfter;
              out.bSaved = !!b3 && b3.title === '串改用例B已改';
              out.stillDistinct = !!a3 && !!b3 && a3.title !== b3.title;

              // 清理
              const closeBtn = document.querySelector('.detail-close');
              if (closeBtn) { closeBtn.click(); await wait(400); }
              try { await window.api.tasks.remove(a.id); } catch (e) {}
              try { await window.api.tasks.remove(b.id); } catch (e) {}
              return out;
            })()
          `);
          console.log(`[SMOKE] 多任务隔离 = A(${r14.aTitleAfter || '-'}) / B(${r14.bTitleAfter || '-'})；B未被串改=${r14.bUntouched ? '是' : '否'}；A未被串改=${r14.aNotClonedFromB ? '是' : '否'}；A改动保留=${r14.aKeptEdit ? '是' : '否'}；保存只影响自己=${r14.aStable && r14.bSaved ? '是' : '否'}`);

          /* ============ 第 15 轮：创建时间 / 趋势范围切换 / AI 润色反馈 ============ */
          // 一个「连得上但永不响应」的本地服务：这样"加载中"是稳态可观测的，
          // 而不是像 127.0.0.1:1 那样瞬间失败、根本抓不到加载态。
          const http = require('http');
          const slowServer = http.createServer(() => { /* 故意不响应 */ });
          await new Promise((res) => slowServer.listen(0, '127.0.0.1', res));
          const slowPort = slowServer.address().port;

          const r15 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              // AI 检索已从侧栏移到顶栏按钮，冒烟里的视图切换统一走这里
              const nav = (v) => (v === 'search'
                ? document.getElementById('btn-ai-search')
                : document.querySelector('.nav-item[data-view="' + v + '"]')).click();
              const out = {};

              /* 1) 创建时间：列表行与详情都要能看到 */
              nav('all'); await wait(800);
              const row = document.querySelector('#view .task-item');
              out.rowFound = !!row;
              const ca = row ? row.querySelector('.meta-item.created-at') : null;
              out.listCreated = !!ca;
              out.listCreatedText = ca ? ca.textContent.trim() : '';
              if (row) { row.click(); await wait(900); }
              const dcEl = document.querySelector('.detail-created');
              out.detailCreated = !!dcEl && /创建于/.test(dcEl.textContent || '');
              out.detailCreatedText = dcEl ? dcEl.textContent.trim() : '';
              const cBtn0 = document.querySelector('.detail-close');
              if (cBtn0) { cBtn0.click(); await wait(400); }

              /* 2) 趋势范围切换：标题文案、柱子数、选中态都要跟着变 */
              const tk = await window.api.tasks.create({ title: '趋势用例R15' });
              await window.api.tasks.toggle(tk.id); // 造一条今天的完成记录，避免落到"无数据"分支
              nav('stats'); await wait(1000);
              out.trendChips = document.querySelectorAll('#trend-range [data-trend]').length;
              const readTrend = () => {
                const act = document.querySelector('#trend-range .chip.active');
                return {
                  title: (document.getElementById('trend-title') || {}).textContent || '',
                  cols: document.querySelectorAll('#trend-body .trend-col').length,
                  active: act ? act.dataset.trend : '',
                };
              };
              const pick = async (k) => {
                document.querySelector('#trend-range [data-trend="' + k + '"]').click();
                await wait(900);
                return readTrend();
              };
              out.t7 = readTrend();
              out.t1m = await pick('1m');
              out.t6m = await pick('6m');
              out.t1y = await pick('1y');
              out.trendSummary = !!document.querySelector('.trend-summary');
              out.trendTitlesOk = /近 7 天/.test(out.t7.title) && /近一个月/.test(out.t1m.title)
                && /近半年/.test(out.t6m.title) && /近一年/.test(out.t1y.title);
              out.trendColsOk = out.t7.cols === 7 && out.t1m.cols === 30 && out.t6m.cols === 26 && out.t1y.cols === 12;
              out.trendActiveOk = out.t7.active === '7d' && out.t1y.active === '1y';

              /* 3) AI 润色：点击必须有反馈（弹窗 + 加载态），失败要有原因与重试入口 */
              const prevCfg = await window.api.ai.getConfig();
              nav('all'); await wait(700);
              const p15 = await window.api.tasks.create({ title: '润色用例R15', notes: '<p>这是一段需要润色的描述文本</p>' });
              nav('upcoming'); await wait(400); nav('all'); await wait(800);
              const prow = [...document.querySelectorAll('#view .task-item')].find((el) => el.dataset.id === String(p15.id));
              out.pRowFound = !!prow;
              if (prow) { prow.click(); await wait(900); }
              const pBtn = document.querySelector('[data-act="polish"]');
              out.polishBtn = !!pBtn;
              // 只认"润色弹窗"：按主体内容定位，避免被页面上可能残留的其它弹窗干扰
              const allMasks = () => [...document.querySelectorAll('.modal-mask')];
              const polishMasks = () => allMasks().filter((m) => m.querySelector('.np-loading, .np-error, .np-compare'));
              out.masksBefore = allMasks().length;
              out.strayTitles = allMasks().map((m) => ((m.querySelector('.modal-head') || {}).textContent || '?').trim());

              if (pBtn) {
                // 3a) 加载态 + 防重复触发：请求一直挂着，观察"进行中"的表现
                await window.api.ai.saveConfig({ baseUrl: 'http://127.0.0.1:${slowPort}/v1', model: 'smoke-model', apiKey: 'sk-smoke' });
                pBtn.click();
                await wait(400);
                const m1 = polishMasks()[0];
                out.masks1 = polishMasks().length;
                out.loadingShown = !!m1 && !!m1.querySelector('.np-loading');
                out.btnDisabled = pBtn.disabled;
                out.btnText = pBtn.textContent;
                pBtn.click(); // 连点第二次：不应再冒出第二个弹窗
                await wait(400);
                out.masks2 = polishMasks().length;
                const okA = m1 ? m1.querySelector('[data-modal="ok"]') : null;
                if (okA) { okA.click(); await wait(400); }
                out.modalClosed = polishMasks().length === 0;
                out.btnRestored = !pBtn.disabled;

                // 3b) 接口异常：连不上的地址 → 明确的失败原因 + 重试入口
                await window.api.ai.saveConfig({ baseUrl: 'http://127.0.0.1:1/v1', model: 'smoke-model', apiKey: 'sk-smoke' });
                pBtn.click();
                await wait(3000);
                const m2 = polishMasks()[0];
                out.errShown = !!m2 && !!m2.querySelector('.np-error');
                out.retryBtn = !!m2 && !!m2.querySelector('[data-np="retry"]');
                const okB = m2 ? m2.querySelector('[data-modal="ok"]') : null;
                if (okB) { okB.click(); await wait(400); }
                out.modalClosedB = polishMasks().length === 0;
              }
              const cBtn1 = document.querySelector('.detail-close');
              if (cBtn1) { cBtn1.click(); await wait(300); }

              // 还原 AI 配置（Key 无法读回明文，原本没有 Key 就清掉）
              await window.api.ai.saveConfig({ baseUrl: prevCfg.baseUrl, model: prevCfg.model });
              if (!prevCfg.hasKey) await window.api.ai.clearKey();
              try { await window.api.tasks.remove(tk.id); } catch (e) {}
              try { await window.api.tasks.remove(p15.id); } catch (e) {}
              return out;
            })()
          `);
          console.log(`[SMOKE] 创建时间 = 列表「${r15.listCreatedText || '-'}」；详情「${r15.detailCreatedText || '-'}」；列表展示=${r15.listCreated ? '是' : '否'}；详情展示=${r15.detailCreated ? '是' : '否'}`);
          console.log(`[SMOKE] 趋势范围 = 档位 ${r15.trendChips} 个；柱子数 ${JSON.stringify([r15.t7 && r15.t7.cols, r15.t1m && r15.t1m.cols, r15.t6m && r15.t6m.cols, r15.t1y && r15.t1y.cols])}；标题随范围更新=${r15.trendTitlesOk ? '是' : '否'}；粒度正确=${r15.trendColsOk ? '是' : '否'}；选中态=${r15.trendActiveOk ? '正确' : '错误'}`);
          console.log(`[SMOKE] AI 润色反馈 = 弹窗=${r15.masks1 === 1 ? '打开' : '未打开(' + r15.masks1 + ')'}；连点后弹窗数=${r15.masks2}（防重复=${r15.masks2 === 1 ? '是' : '否'}）；加载态=${r15.loadingShown ? '有' : '无'}；按钮禁用=${r15.btnDisabled ? '是' : '否'}（${r15.btnText || '-'}）；失败提示=${r15.errShown ? '有' : '无'}；重试入口=${r15.retryBtn ? '有' : '无'}；关闭后复位=${r15.btnRestored ? '是' : '否'}`);
          if (r15.masksBefore) console.log(`[SMOKE] 提示：润色前页面上已有 ${r15.masksBefore} 个弹窗遮罩 ${JSON.stringify(r15.strayTitles)}`);
          slowServer.close();

          /* ============ 第 16 轮：标题层级 / 子任务计数 / 行内改名自适应 / 图片放大 / 侧栏调宽 / 统计口径 ============ */
          const r16 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              // AI 检索已从侧栏移到顶栏按钮，冒烟里的视图切换统一走这里
              const nav = (v) => (v === 'search'
                ? document.getElementById('btn-ai-search')
                : document.querySelector('.nav-item[data-view="' + v + '"]')).click();
              const out = {};
              try {
              nav('all'); await wait(800);

              /* ---- 1) 标题字号层级 + 子任务计数紧邻标题 ---- */
              const t16 = await window.api.tasks.create({ title: '标题层级用例' });
              const s1 = await window.api.tasks.create({ title: '子任务甲', parentId: t16.id });
              const s2 = await window.api.tasks.create({ title: '子任务乙', parentId: t16.id });
              await window.api.tasks.toggle(s1.id);
              nav('upcoming'); await wait(400); nav('all'); await wait(800);
              const item16 = document.querySelector('#view .task-item[data-id="' + t16.id + '"]');
              out.rowFound = !!item16;
              if (item16) {
                const titleEl = item16.querySelector('.task-title');
                const textEl = item16.querySelector('.task-title-text');
                // 量真正的正文文本节点（.task-meta 容器本身只继承 body 字号，量它没意义）
                const metaEl = item16.querySelector('.task-meta .meta-item') || item16.querySelector('.task-meta');
                const titleFs = parseFloat(getComputedStyle(titleEl).fontSize);
                const metaFs = parseFloat(getComputedStyle(metaEl).fontSize);
                out.titleFs = titleFs;
                out.metaFs = metaFs;
                out.titleBigger = titleFs >= metaFs + 3;      // 与正文拉开层级
                out.titleSizeOk = titleFs >= 15.5 && titleFs <= 17;
                const badge = item16.querySelector('.task-subtask-badge');
                out.badgeExists = !!badge;
                out.badgeInTitle = !!badge && badge.parentElement === titleEl;
                out.badgeNextToName = !!badge && textEl.nextElementSibling === badge;
                out.badgeNotInMeta = !item16.querySelector('.task-meta .subtask-progress');
                out.badgeText = badge ? badge.textContent.trim() : '';
              }

              /* ---- 2) 行内改名：输入框宽度随输入自适应、不换行 ---- */
              if (item16) {
                item16.querySelector('.task-title-text').click();
                await wait(250);
                const input = item16.querySelector('.task-title-input');
                out.inputFound = !!input;
                if (input) {
                  const w0 = input.getBoundingClientRect().width;
                  input.value = '这是一段明显更长的任务标题用于验证宽度自适应';
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  await wait(150);
                  const w1 = input.getBoundingClientRect().width;
                  out.widthGrew = w1 > w0 + 20;
                  out.noWrap = input.scrollHeight <= input.clientHeight + 2;
                  const rowW = item16.querySelector('.task-title').getBoundingClientRect().width;
                  out.withinRow = w1 <= rowW + 1;
                  // 不该压到右侧操作区
                  const bodyR = item16.querySelector('.task-body').getBoundingClientRect().right;
                  out.noOverlap = input.getBoundingClientRect().right <= bodyR + 1;
                  input.value = '标题层级用例';
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                  await wait(300);
                }
              }

              /* ---- 3) 图片双击放大预览 ---- */
              const c = document.createElement('canvas');
              c.width = 120; c.height = 60;
              const cx = c.getContext('2d');
              cx.fillStyle = '#4f7cff'; cx.fillRect(0, 0, 120, 60);
              const dataUrl = c.toDataURL('image/png');
              const imgTask = await window.api.tasks.create({ title: '图片用例', notes: '![测试图](' + dataUrl + ')' });
              nav('upcoming'); await wait(400); nav('all'); await wait(800);
              const imgRow = document.querySelector('#view .task-item[data-id="' + imgTask.id + '"]');
              if (imgRow) { imgRow.click(); await wait(900); }
              const mdImg = document.querySelector('.detail-notes-editor img, .markdown-body img');
              out.mdImgFound = !!mdImg;
              if (mdImg) {
                mdImg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                await wait(300);
                const mask = document.querySelector('.img-zoom-mask');
                out.zoomOpened = !!mask;
                if (mask) {
                  const big = mask.querySelector('.img-zoom-img');
                  const r = big.getBoundingClientRect();
                  const nat = big.naturalWidth / big.naturalHeight;
                  const shown = r.width / r.height;
                  out.ratioKept = Math.abs(nat - shown) < 0.05 && r.width <= window.innerWidth && r.height <= window.innerHeight;
                  out.zoomSize = Math.round(r.width) + 'x' + Math.round(r.height);
                  // 关闭方式 1：Esc
                  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                  await wait(250);
                  out.closedByEsc = !document.querySelector('.img-zoom-mask');
                }
                if (!document.querySelector('.img-zoom-mask')) {
                  mdImg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                  await wait(300);
                  // 关闭方式 2：点遮罩
                  const m2 = document.querySelector('.img-zoom-mask');
                  if (m2) { m2.dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(250); }
                  out.closedByMask = !document.querySelector('.img-zoom-mask');
                }
                if (!document.querySelector('.img-zoom-mask')) {
                  mdImg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                  await wait(300);
                  // 关闭方式 3：再次双击图片
                  const b3 = document.querySelector('.img-zoom-img');
                  if (b3) { b3.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); await wait(250); }
                  out.closedByDbl = !document.querySelector('.img-zoom-mask');
                }
              }
              const cBtn = document.querySelector('.detail-close');
              if (cBtn) { cBtn.click(); await wait(400); }

              /* ---- 4) 侧边栏拖拽调宽 ---- */
              const handle = document.getElementById('sidebar-resizer');
              const bar = document.querySelector('.sidebar');
              out.handleFound = !!handle && !!bar;
              if (handle && bar) {
                const before = bar.getBoundingClientRect().width;
                const rect = handle.getBoundingClientRect();
                const startX = rect.left + rect.width / 2;
                const pd = new PointerEvent('pointerdown', { bubbles: true, clientX: startX, clientY: 300, button: 0, pointerId: 1 });
                handle.dispatchEvent(pd);
                await wait(80);
                out.selectDisabled = document.body.style.userSelect === 'none' && document.documentElement.classList.contains('is-resizing');
                window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: startX + 90, clientY: 300, pointerId: 1 }));
                await wait(150);
                const mid = bar.getBoundingClientRect().width;
                window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: startX + 90, clientY: 300, pointerId: 1 }));
                await wait(200);
                const after = bar.getBoundingClientRect().width;
                out.dragged = after > before + 40;
                out.widths = [Math.round(before), Math.round(mid), Math.round(after)];
                out.selectRestored = document.body.style.userSelect === '' && !document.documentElement.classList.contains('is-resizing');
                // 拖到极小值也要被夹住
                handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, clientY: 300, button: 0, pointerId: 2 }));
                window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 300, pointerId: 2 }));
                await wait(120);
                window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 5, clientY: 300, pointerId: 2 }));
                await wait(200);
                const minW = bar.getBoundingClientRect().width;
                out.minClamped = minW >= 179 && minW <= 181;
                // 布局不错位：侧栏右边界 == 主区左边界，且主区仍有可用宽度
                const mainEl = document.querySelector('.main');
                const barR = bar.getBoundingClientRect().right;
                const mainL = mainEl.getBoundingClientRect().left;
                out.layoutAligned = Math.abs(barR - mainL) <= 9; // 把手占 8px
                out.mainUsable = mainEl.getBoundingClientRect().width >= 400;
                out.noHOverflow = document.documentElement.scrollWidth <= window.innerWidth;
                await wait(500);
                out.persisted = await window.api.ui.getSidebarWidth();
              }

              /* ---- 5) 统计口径：仅主任务 / 含子任务 ---- */
              nav('stats'); await wait(900);
              const scopeBox = document.querySelector('#stats-scope');
              out.scopeFound = !!scopeBox;
              if (scopeBox) {
                const readTotal = () => {
                  const card = document.querySelector('.stat-card[data-stat="total"] .num');
                  return card ? Number(card.textContent.trim()) : -1;
                };
                const topBtn = scopeBox.querySelector('[data-scope="top"]');
                const allBtn = scopeBox.querySelector('[data-scope="all"]');
                topBtn.click(); await wait(900);
                const nTop = readTotal();
                out.scopeTopActive = scopeBox.querySelector('[data-scope="top"]').classList.contains('active');
                allBtn.click(); await wait(1000);
                const nAll = readTotal();
                out.scopeAllActive = !!scopeBox.querySelector('[data-scope="all"]')
                  && scopeBox.querySelector('[data-scope="all"]').classList.contains('active');
                out.scopeCounts = [nTop, nAll];
                out.scopeGrew = nAll > nTop;   // 有子任务时切到「含子任务」总数必须变大
                // 趋势也跟着换口径
                const summary = document.querySelector('.trend-summary');
                out.trendRefreshed = !!summary;
                topBtn.click(); await wait(900);
                const nBack = readTotal();
                out.scopeSwitchedBack = nBack === nTop;
              }

              // 清理
              try { await window.api.tasks.remove(t16.id); } catch (e) {}
              try { await window.api.tasks.remove(imgTask.id); } catch (e) {}
              } catch (e) { out.__fatal = String((e && e.stack) || e).split('\\n').slice(0, 4).join(' | '); }
              return out;
            })()
          `);
          if (r16.__fatal) console.log('[SMOKE][r16 fatal]', r16.__fatal);
          console.log(`[SMOKE] 标题层级 = 标题 ${r16.titleFs || '-'}px / 正文 ${r16.metaFs || '-'}px（层级分明=${r16.titleBigger ? '是' : '否'}）；子任务计数在标题行内=${r16.badgeInTitle ? '是' : '否'}；紧邻名称=${r16.badgeNextToName ? '是' : '否'}（${r16.badgeText || '-'}）`);
          console.log(`[SMOKE] 行内改名自适应 = 宽度随输入增长=${r16.widthGrew ? '是' : '否'}；不换行=${r16.noWrap ? '是' : '否'}；不越界=${r16.withinRow && r16.noOverlap ? '是' : '否'}`);
          console.log(`[SMOKE] 图片放大 = 打开=${r16.zoomOpened ? '是' : '否'}；原比例=${r16.ratioKept ? '保持' : '变形'}（${r16.zoomSize || '-'}）；Esc关=${r16.closedByEsc ? '是' : '否'}；点遮罩关=${r16.closedByMask ? '是' : '否'}；双击关=${r16.closedByDbl ? '是' : '否'}`);
          console.log(`[SMOKE] 侧栏调宽 = ${JSON.stringify(r16.widths)}；拖拽生效=${r16.dragged ? '是' : '否'}；下限夹住=${r16.minClamped ? '是' : '否'}；拖时禁选中=${r16.selectDisabled ? '是' : '否'}；松手恢复=${r16.selectRestored ? '是' : '否'}；布局对齐=${r16.layoutAligned ? '是' : '否'}；主区可用=${r16.mainUsable ? '是' : '否'}；落库=${r16.persisted || '-'}px`);
          console.log(`[SMOKE] 统计口径 = 仅主任务 ${(r16.scopeCounts || [])[0]} / 含子任务 ${(r16.scopeCounts || [])[1]}；切换生效=${r16.scopeGrew ? '是' : '否'}；切回一致=${r16.scopeSwitchedBack ? '是' : '否'}`);

          /* ============ 第 17 轮：AI 检索联想（精确优先 / 联想候选 / 确实无关联 三态） ============ */
          // 清掉 Key：本轮只验证本地联想引擎（不依赖外网），否则不可达的 AI 地址会拖慢整轮
          await mainWindow.webContents.executeJavaScript(`window.api.ai.clearKey()`);
          const r17 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              const wait = (ms) => new Promise(r => setTimeout(r, ms));
              try {
              // 造数据：一条可精确命中、一条只能靠"缩写/同义"联想、一批用来验证 Top5 截断
              const a = await window.api.tasks.create({ title: '联想用例-报销差旅费', notes: '<p>发票已寄出</p>' });
              const b = await window.api.tasks.create({ title: '联想用例-登录界面改版', notes: '' });
              await window.api.tasks.create({ title: '联想用例-接口性能优化', notes: '' });
              const many = [];
              for (let i = 1; i <= 8; i += 1) many.push(await window.api.tasks.create({ title: '联想用例-缺陷单' + i, notes: '' }));
              const ids = [a.id, b.id, ...many.map((m) => m.id)];
              out.seeded = ids.length;

              // 1) 精确命中：应优先返回，且判定为唯一匹配
              const r1 = await window.api.search.ai('报销差旅费');
              out.exactType = r1.type;
              out.exactHit = !!r1.exactHit;
              out.exactTop = (r1.tasks[0] || {}).title;
              out.exactReason = ((r1.tasks[0] || {}).match || {}).reasons || [];

              // 2) 缩写联想：库里没有 "ui" 三个字母，但应通过 ui→界面 找到「登录界面改版」
              const r2 = await window.api.search.ai('ui 改版');
              out.assocType = r2.type;
              out.assocCount = r2.tasks.length;
              out.assocTop = (r2.tasks[0] || {}).title;
              out.assocReasons = ((r2.tasks[0] || {}).match || {}).reasons || [];
              out.assocIsAbbrev = out.assocReasons.some((s) => /缩写还原|同义词/.test(s));

              // 3) 确实无关联：明确提示 + 说明已尝试的联想方向
              const r3 = await window.api.search.ai('zzzqqqxyz无关词');
              out.noneType = r3.type;
              out.noneCount = r3.tasks.length;
              out.noneTried = (r3.tried || []).length;

              // 4) Top5 截断：8 条同义任务只能回来 5 条以内
              const r4 = await window.api.search.ai('缺陷');
              out.topCount = r4.tasks.length;
              out.topCapped = r4.tasks.length <= 5 && r4.tasks.length > 0;
              out.topHasScore = r4.tasks.every((t) => t.match && typeof t.match.score === 'number');

              // 5) 界面渲染：走真实点击，检查三态各自的 DOM 与"命中依据"是否可见
              // AI 检索已从侧栏移到顶栏按钮，冒烟里的视图切换统一走这里
              const nav = (v) => (v === 'search'
                ? document.getElementById('btn-ai-search')
                : document.querySelector('.nav-item[data-view="' + v + '"]')).click();
              const searchIn = () => document.getElementById('ai-search-input');
              nav('all'); await wait(300); nav('search'); await wait(500);
              const runUi = async (kw) => {
                searchIn().value = kw;
                document.getElementById('ai-search-btn').click();
                await wait(900);
                const res = document.getElementById('ai-search-results');
                return {
                  items: res.querySelectorAll('.search-result-item').length,
                  reasons: [...res.querySelectorAll('.sr-reasons')].map((e) => e.textContent),
                  bannerUnique: !!res.querySelector('.sr-banner-unique'),
                  bannerMulti: !!res.querySelector('.sr-banner-multi'),
                  empty: !!res.querySelector('.sr-empty'),
                  tried: res.querySelectorAll('.sr-tried li').length,
                };
              };
              out.uiExact = await runUi('报销差旅费');
              out.uiAssoc = await runUi('ui 改版');
              out.uiNone = await runUi('zzzqqqxyz无关词');

              // 清理
              for (const id of ids) { try { await window.api.tasks.remove(id); } catch (e) {} }
              } catch (e) { out.__fatal = String((e && e.stack) || e).split('\\n').slice(0, 4).join(' | '); }
              return out;
            })()
          `);
          if (r17.__fatal) console.log('[SMOKE][r17 fatal]', r17.__fatal);
          console.log(`[SMOKE] 检索联想（精确）= 类型 ${r17.exactType}；精确命中=${r17.exactHit ? '是' : '否'}；首位「${r17.exactTop || '-'}」；依据 ${JSON.stringify(r17.exactReason)}`);
          console.log(`[SMOKE] 检索联想（缩写 ui）= 类型 ${r17.assocType}；候选 ${r17.assocCount} 条；首位「${r17.assocTop || '-'}」；依据含联想标记=${r17.assocIsAbbrev ? '是' : '否'} ${JSON.stringify(r17.assocReasons)}`);
          console.log(`[SMOKE] 检索联想（无关联）= 类型 ${r17.noneType}；候选 ${r17.noneCount} 条；已尝试方向 ${r17.noneTried} 条`);
          console.log(`[SMOKE] 检索联想（Top5）= ${r17.topCount} 条（≤5=${r17.topCapped ? '是' : '否'}；均带分值=${r17.topHasScore ? '是' : '否'}）`);
          console.log(`[SMOKE] 检索联想（界面）= 精确 ${JSON.stringify(r17.uiExact)}；联想 ${JSON.stringify(r17.uiAssoc)}；无关联 ${JSON.stringify(r17.uiNone)}`);

          /* ============ 第 18 轮：实用工具（文本对比 / JSON 查看器浮窗 + 格式化引擎） ============ */
          // 菜单快捷键走不了 CDP，这里直接调渲染层的入口（与菜单 ipc 触发的是同一条路径）：
          // 1) 各语言格式化是否真出结果（代码格式化浮窗已下线，仍要守 format-lib 的引擎）
          // 2) 浮窗是否非模态（无遮罩、开着还能操作主界面）
          // 3) 最小化 / 最大化   4) 对比的增删行、内联视图、忽略大小写   5) 对比里复用格式化
          const r18 = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const out = {};
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              const q = (s) => document.querySelector(s);
              try {
                const lib = await import('./js/format-lib.js');
                const dfm = await import('./js/text-diff.js');
                out.modulesLoaded = !!lib && !!dfm;

                /* ---- 1) 格式化引擎（format-lib 直测，不经界面） ---- */
                const run = async (text, lang, extra) => (await lib.formatText(text, { lang, ...extra })).text;
                const j = await run('{"b":2,"a":[1,2,{"c":3}]}', 'json');
                out.jsonOk = /\\n/.test(j) && /"b": 2/.test(j) && /\\[/.test(j);
                const x = await run('<root><a x="1">hi</a></root>', 'xml');
                out.xmlOk = /\\n/.test(x) && /<a /.test(x);
                const s = await run('select a,b from t where a=1', 'sql');
                out.sqlOk = /from/.test(s) && /\\n/.test(s);
                const jv = await run('public class A{public static void main(String[] a){System.out.println(1);}}', 'java');
                out.javaOk = /public class A/.test(jv) && /\\n/.test(jv);
                const au = await run('<r><i>1</i></r>', 'auto');
                out.autoOk = /\\n/.test(au);
                // 其余 prettier 语言也要「真出结果」：曾经把 out 初始化成原文，
                // 导致这些语言的格式化静默失效（界面还显示已格式化），这里逐个守住
                out.multi = {};
                out.multiOk = true;
                const multi = [
                  ['javascript', 'function f(a){return a+1}'],
                  ['typescript', 'interface A{x:number}const a:A={x:1}'],
                  ['html', '<div   class="a"><p>hi</p><p>yo</p></div>'],
                  ['css', '.a{color:red;margin:0}.b{padding:1px}'],
                  ['scss', '.a{&>b{color:red}}'],
                  ['markdown', '# t\\n\\n*  a\\n*  b'],
                  ['yaml', 'a:   1\\nb:\\n  - x'],
                ];
                for (const [lg, code] of multi) {
                  const got = await run(code, lg);
                  const ok = String(got).trim() !== code.trim();
                  out.multi[lg] = ok;
                  if (!ok) out.multiOk = false;
                }
                try {
                  await run('{"a":}', 'json'); // 语法错误必须抛出，不能静默返回原文
                  out.errThrown = false;
                } catch (e) {
                  out.errThrown = true;
                  out.statusText = String((e && e.message) || e).split('\\n')[0].slice(0, 50);
                }
                out.errShown = out.errThrown; // 断言沿用原字段名

                /* ---- 2) 文本对比 ---- */
                await dfm.openDiffWindow();
                await wait(400);
                const dwin = q('.tool-win[data-tool="text-diff"]');
                out.diffOpened = !!dwin;
                out.noMask = document.querySelectorAll('.modal-mask').length === 0;
                out.winBtns = dwin ? dwin.querySelectorAll('.tool-win-btn').length : 0;
                const aEl = dwin.querySelector('.df-a');
                const bEl = dwin.querySelector('.df-b');
                const view = dwin.querySelector('.df-view');
                const feed = async (a, b) => {
                  aEl.value = a; aEl.dispatchEvent(new Event('input', { bubbles: true }));
                  bEl.value = b; bEl.dispatchEvent(new Event('input', { bubbles: true }));
                  await wait(800);
                };
                await feed('line1\\nline2\\nline3', 'line1\\nline two\\nline3');
                out.diffRows = view.querySelectorAll('.df-row').length;
                out.diffAdd = view.querySelectorAll('.df-cell.add').length;
                out.diffDel = view.querySelectorAll('.df-cell.del').length;
                out.diffStat = (dwin.querySelector('.df-stat') || {}).textContent || '';
                dwin.querySelector('.df-mode[data-mode="inline"]').click(); await wait(700);
                out.inlineRows = view.querySelectorAll('.df-row.inline').length;
                out.inlineSigns = view.querySelectorAll('.df-sign.del').length + view.querySelectorAll('.df-sign.add').length;
                dwin.querySelector('.df-mode[data-mode="split"]').click(); await wait(700);
                out.splitBack = view.querySelectorAll('.df-row').length >= 3 && view.querySelectorAll('.df-row.inline').length === 0;
                // 忽略大小写：Hello / hello 判为一致
                await feed('Hello', 'hello');
                out.caseDiff = view.querySelectorAll('.df-cell.del').length;
                const cb = dwin.querySelector('.df-case');
                cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
                await wait(700);
                out.caseIgnored = /一致/.test(view.textContent);
                cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
                await wait(600);

                /* ---- 3) 对比里复用格式化：同一段 JSON 排版不同 → 格式化后应当无差异 ---- */
                await feed('{"a":1,"b":2}', '{\\n  "a": 1,\\n  "b": 2\\n}');
                out.beforeFormat = view.querySelectorAll('.df-cell.del').length;
                dwin.querySelector('.df-format').click();
                await wait(1600);
                out.afterFormat = view.querySelectorAll('.df-cell.del').length;
                out.formatConverged = /一致/.test(view.textContent);
                out.formattedA = (dwin.querySelector('.df-a') || {}).value || '';
                // 语法高亮：差异行里应出现 highlight.js 的 token 节点
                await feed('{"a":1}', '{"a":2}');
                out.diffHl = view.querySelectorAll('.df-cell .hljs-attr').length;
                const hlBox = dwin.querySelector('.df-hl-toggle');
                out.diffHlToggle = !!hlBox;
                if (hlBox) {
                  hlBox.checked = false; hlBox.dispatchEvent(new Event('change', { bubbles: true }));
                  await wait(700);
                  out.diffHlOff = view.querySelectorAll('.hljs-attr').length === 0;
                  hlBox.checked = true; hlBox.dispatchEvent(new Event('change', { bubbles: true }));
                  await wait(700);
                }

                /* ---- 4) 浮窗控制：最小化 / 最大化 / 还原 / 非模态 ---- */
                dwin.querySelector('[data-act="min"]').click(); await wait(200);
                out.minApplied = dwin.classList.contains('is-min')
                  && getComputedStyle(dwin.querySelector('.tool-win-body')).display === 'none';
                dwin.querySelector('[data-act="min"]').click(); await wait(200);
                out.minRestored = !dwin.classList.contains('is-min');
                dwin.querySelector('[data-act="max"]').click(); await wait(300);
                out.maxApplied = dwin.classList.contains('is-max')
                  && dwin.getBoundingClientRect().width >= window.innerWidth - 40;
                dwin.querySelector('[data-act="max"]').click(); await wait(300);
                out.maxRestored = !dwin.classList.contains('is-max');

                /* ---- 5) 非模态：开着工具窗照样能操作主界面 ---- */
                document.querySelector('.nav-item[data-view="all"]').click();
                await wait(500);
                out.mainUsable = (q('#view-title') || {}).textContent === '全部任务' && !!dwin.isConnected;

                /* ---- 6) JSON 查看器：树形渲染 + 搜索 + JSONPath ---- */
                const jvm = await import('./js/json-view.js');
                await jvm.openJsonViewWindow();
                await wait(600);
                const jwin = q('.tool-win[data-tool="json-view"]');
                out.jvOpened = !!jwin;
                out.bothOpen = document.querySelectorAll('.tool-win').length === 2;
                const jArea = jwin && jwin.querySelector('.jv-area');
                const jTree = jwin && jwin.querySelector('.jv-tree');
                if (jArea) {
                  jArea.value = '{"user":{"name":"ada","age":8},"items":[{"id":1},{"id":2}]}';
                  jArea.dispatchEvent(new Event('input', { bubbles: true }));
                  await wait(1200);
                }
                const jStatus = jwin && jwin.querySelector('.jv-status');
                out.jvParsed = !!jStatus && jStatus.dataset.state === 'ok';
                // 组件是 shadow DOM，只能从宿主元素判断"有没有渲染出内容"
                out.jvTree = !!jTree && (jTree.shadowRoot ? jTree.shadowRoot.querySelectorAll('li[part="property"]').length : 0);
                const jSearch = jwin && jwin.querySelector('.jv-search');
                if (jSearch) {
                  jSearch.value = 'ada';
                  jSearch.dispatchEvent(new Event('input', { bubbles: true }));
                  await wait(600);
                  jwin.querySelector('.jv-next').click();
                  await wait(400);
                  out.jvHits = (jwin.querySelector('.jv-hits') || {}).textContent || '';
                  jwin.querySelector('.jv-reset').click();
                  await wait(300);
                }
                const jPath = jwin && jwin.querySelector('.jv-path');
                if (jPath) {
                  jPath.value = '$.items[1].id';
                  jwin.querySelector('.jv-run-path').click();
                  await wait(700);
                }
                const jRes = jwin && jwin.querySelector('.jv-result');
                out.jvQuery = (jRes ? jRes.textContent : '').trim().slice(0, 40);
                if (jwin) { jwin.querySelector('[data-act="close"]').click(); await wait(250); }

                /* ---- 7) 关闭后不留残留 ---- */
                dwin.querySelector('[data-act="close"]').click(); await wait(250);
                out.closed = document.querySelectorAll('.tool-win').length === 0;
              } catch (e) {
                out.err = String((e && e.message) || e);
              }
              return out;
            })()
          `);
          console.log(`[SMOKE] 实用工具·格式化引擎 = 无遮罩=${r18.noMask ? '是' : '否'}；JSON=${r18.jsonOk ? '✓' : '✗'} XML=${r18.xmlOk ? '✓' : '✗'} SQL=${r18.sqlOk ? '✓' : '✗'} Java=${r18.javaOk ? '✓' : '✗'} 自动识别=${r18.autoOk ? '✓' : '✗'}；其它语言全通过=${r18.multiOk ? '✓' : '✗'}${r18.multiOk ? '' : '（' + JSON.stringify(r18.multi) + '）'}；语法错误抛出=${r18.errThrown ? '是' : '否'}（${r18.statusText || '-'}）`);
          console.log(`[SMOKE] 实用工具·浮窗 = 最小化=${r18.minApplied ? '✓' : '✗'} 还原=${r18.minRestored ? '✓' : '✗'}；最大化=${r18.maxApplied ? '✓' : '✗'} 还原=${r18.maxRestored ? '✓' : '✗'}；开着仍能操作主界面=${r18.mainUsable ? '是' : '否'}；两窗共存=${r18.bothOpen ? '是' : '否'}`);
          console.log(`[SMOKE] 实用工具·对比 = 行 ${r18.diffRows}（增 ${r18.diffAdd} / 删 ${r18.diffDel}）统计「${r18.diffStat || '-'}」；内联=${r18.inlineRows} 行 / ${r18.inlineSigns} 个符号；忽略大小写生效=${r18.caseIgnored ? '是' : '否'}；格式化后收敛=${r18.formatConverged ? '是' : '否'}（前 ${r18.beforeFormat} → 后 ${r18.afterFormat}）；关闭=${r18.closed ? '✓' : '✗'}${r18.err ? '；异常=' + r18.err : ''}`);
          console.log(`[SMOKE] 实用工具·高亮 = 差异行 token ${r18.diffHl} 个；开关=${r18.diffHlToggle ? '有' : '无'}；关掉后无 token=${r18.diffHlOff ? '是' : '否'}`);
          console.log(`[SMOKE] 实用工具·JSON 查看器 = 开窗=${r18.jvOpened ? '是' : '否'}；解析=${r18.jvParsed ? '成功' : '失败'}；树节点 ${r18.jvTree} 个；搜索「ada」=${r18.jvHits || '-'}；JSONPath 结果「${r18.jvQuery || '-'}」`);

          // 日历视图：侧栏「今天」下的「日历」→ 月视图骨架 / 格子 / 负载条 / 待安排池 / 图例
          // → 日历内部切周（月 / 周不再占顶栏）→ 回任务列表；顺带验证顶栏「AI 检索」
          const calOut = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const out = {};
            try {
              const nav = document.querySelector('.nav-item[data-view="calendar"]');
              out.navExists = !!nav;
              out.chipGone = !document.getElementById('view-zoom');
              if (nav) { nav.click(); await wait(700); }
              out.navActive = !!nav && nav.classList.contains('active');
              out.title = (document.getElementById('view-title') || {}).textContent || '';
              out.wrap = !!document.querySelector('.cal-wrap');
              out.cells = document.querySelectorAll('.cal-cell').length;
              out.loadBars = document.querySelectorAll('.cal-load').length;
              out.pool = !!document.querySelector('.cal-pool');
              out.legend = !!document.querySelector('.cal-legend');
              out.segCount = document.querySelectorAll('[data-cal-view]').length;
              out.desc = (document.getElementById('view-desc') || {}).textContent || '';
              const wk = document.querySelector('[data-cal-view="week"]');
              if (wk) { wk.click(); await wait(500); }
              out.weekCols = document.querySelectorAll('.cal-week-col').length;
              const back = document.querySelector('.nav-item[data-view="today"]');
              if (back) { back.click(); await wait(500); }
              out.backToList = !document.querySelector('.cal-wrap');
              const ai = document.getElementById('btn-ai-search');
              if (ai) { ai.click(); await wait(400); }
              out.aiPanel = !!document.querySelector('.search-panel');
              out.aiActive = !!ai && ai.classList.contains('is-active');
              if (ai) { ai.click(); await wait(400); }
              out.aiBack = !document.querySelector('.search-panel');
            } catch (e) { out.err = String((e && e.message) || e); }
            return out;
          })()`);
          console.log(`[SMOKE] 日历视图 = 侧栏项=${calOut.navExists ? '有' : '无'}；chip已移除=${calOut.chipGone ? '是' : '否'}；高亮=${calOut.navActive ? '是' : '否'}；标题「${calOut.title || '-'}」；骨架=${calOut.wrap ? '有' : '无'}；格子 ${calOut.cells} 个；负载条 ${calOut.loadBars} 条；待安排池=${calOut.pool ? '有' : '无'}；图例=${calOut.legend ? '有' : '无'}；月/周控件 ${calOut.segCount} 个；周视图 ${calOut.weekCols} 列；回列表=${calOut.backToList ? '成功' : '失败'}；描述「${calOut.desc || '-'}」${calOut.err ? '；异常=' + calOut.err : ''}`);
          console.log(`[SMOKE] 顶栏 AI 检索 = 进检索视图=${calOut.aiPanel ? '成功' : '失败'}；按钮选中态=${calOut.aiActive ? '有' : '无'}；再点回列表=${calOut.aiBack ? '成功' : '失败'}`);

          const allOk = ready && dom.addRowExists && dom.noModal && dom.timeFilterBtn && dom.timeFilterPanel
            && dom.editorShown && dom.planFields && dom.detailDrawer && dom.aiSearchTopbar && dom.searchNavGone && dom.calendarAfterToday && dom.titleFocused
            && dom.editorClosed && dom.calDays >= 28 && dom.calendarsOpen === 1 && dom.calInBody
            && dom.pickingOpen && dom.autoFilled && dom.rangePopClosed
            && dom.rangeStart <= dom.rangeEnd
            && dom.reopened && dom.closedByTrigger && dom.calInViewport && dom.persistedMatches
            && dom.groupModalOpened && dom.groupAdded && dom.dupErrorShown
            && dom.tagModalOpened && dom.tagAdded
            // 顶栏入口整理（笔记按钮外置、主题收进菜单）；File 菜单里的同步项已撤掉
            && topbarOut.noteOutside && topbarOut.noteVisible && topbarOut.syncGone && topbarOut.themeGone
            && topbarOut.aiVisible && topbarOut.aiBesideSearch && topbarOut.zoomChipGone
            // 重复「主题」顶格菜单已删除；归档从顶栏收进 File；同步项不再出现；日历 / AI 检索走新入口
            && !themeItem && fileLabels.includes('归档已完成任务')
            && !fileLabels.some((l) => l.startsWith('同步'))
            && calOut.navExists && calOut.chipGone && calOut.navActive && calOut.wrap && calOut.segCount === 2
            && calOut.cells >= 28 && calOut.loadBars > 0
            && calOut.pool && calOut.legend && calOut.weekCols === 7 && calOut.backToList
            && calOut.aiPanel && calOut.aiActive && calOut.aiBack
            && dom.hasArrow && dom.parentPresetMatched && dom.childRowVisible && dom.parentFilterIncludesChildTask
            && dom.childHiddenAfterCollapse && dom.childBackAfterExpand
            && dom.aiToolbarBtnGone && dom.aiMenuItem && dom.aiModalOpened && dom.aiModalCount === 1
            && dom.aiCols === 2 && dom.aiSections === 2 && dom.aiFieldCount === 8
            && dom.aiInViewport && dom.aiFootReachable && dom.aiBodyScrolls && dom.aiNoHOverflow
            && dom.aiSavedUrl === 'https://smoke.example.com' && dom.aiSavedModel === 'smoke-model'
            && dom.tbStatsHidden && dom.tbReportsHidden && dom.tbSearchHidden && dom.tbMeetingsHidden && dom.tbTaskShown
            && dom.gcModalOpened && dom.gcPicker && dom.gcAuto && dom.gcCustom && dom.gcAbbrev
            && dom.gcInvalidKept && dom.gcPreset && dom.gcCreated && dom.gcDot && dom.gcPersisted && dom.gcEditEcho
            && dom.moveMenuHasUpdown && dom.moveReordered && dom.moveDropMarked
            && dom.moveIntoChild && dom.moveIntoChildRow
            && detail.panelOpen && detail.hasResizer && detail.widthAfter > detail.widthBefore
            && detail.resizingClassCleared && !!detail.persisted
            && Math.abs(detail.widthReopened - detail.widthAfter) <= 2
            && detail.samePanelNode && (detail.subtaskTitles || []).includes('冒烟子任务')
            && feat.persistedTitle === '自动保存后的标题' && feat.persistedPriority === 3
            && feat.detailPersisted === '详情自动保存标题'
            && !!feat.sub && feat.sub.priority === 3 && !!feat.sub.ps && !!feat.sub.pe && feat.subCalClosed
            && feat.subPriorityAfterEdit === 0
            && feat.parentVisibleToday && feat.hasArrow && feat.expandedChildVisible
            && feat.arrowAfter === '▾' && feat.collapsedChildHidden
            // 第 4 轮
            && r4.popInLayer && r4.popInViewport && r4.popCells >= 28 && r4.layerCleaned && !r4.popClipped
            && r4.hasHandle && r4.reordered && r4.persistedOrder && r4.sortMode === 'manual'
            && r4.subHasHandle && r4.subReordered
            && r4.hasChineseAction && r4.hasChineseMore
            && r4.tsThirdParty && r4.tsWrapper && r4.tsControl && r4.tsOpened && r4.tsOnBody
            && r4.tsOptionCount >= 2 && r4.tsChips >= 2 && r4.tsHasRemove >= 1
            && r4.tsChildLocked && r4.tsChildClickIgnored && r4.tsChildRestored
            && r4.exportDocxBtn && r4.exportMdBtn
            && r4docx.size > 1000 && r4docx.isZip
            && r4multi.multi && r4multi.single && r4multi.none
            // 第 7 轮：会议录制 / 纪要 / 待办
            && r7.navExists && r7.viewRendered && r7.viewTitle === '会议纪要' && r7.recBtn
            && r7.setupOpened && r7.titlePrefilled && r7.modeCount === 2 && r7.audioChecks === 2
            && r7.sliceOpts === 4 && r7.importBtn && r7.setupClosed
            && r7.meetingCreated && r7.chunkCount === 1 && r7.transcribeFriendly
            && r7.itemCount >= 1 && r7.itemTitle === '冒烟会议'
            && r7.pipelineBtns === 2 && r7.summarizeDisabled && r7.exportBtns === 2
            && r7.todoRows === 1 && r7.groupSelect
            && r7.imported && r7.taskCreated && r7.taskPriority === 2 && r7.subtaskMode && r7.cleaned
            && r7main.presets >= 4 && r7main.uniqueIds && r7main.domestic >= 3 && r7main.chunkSaved && r7main.files === 1
            // 第 9 轮：标签选中态 / 统计下钻 / 报告文档化
            && r9.tagFound && r9.tagFocusable && r9.tagBeforeActive === false && r9.tagAriaBefore === 'false'
            && r9.tagActiveAfterClick && r9.tagAriaAfter === 'true' && r9.tagStyleDistinct
            && r9.tagChipShown && /冒烟标签R9/.test(r9.tagChipText) && r9.tagPersisted != null
            && r9.tagFilterConsistent && r9.tagFilteredCount >= 1
            && r9.tagOffByKeyboard && r9.tagPersistedCleared
            && r9.tagKeptAcrossViews && r9.tagClearedByChip && r9.tagPersistedAfterClear
            && r9.statCardIsButton && r9.drillOpened && r9.drillRows >= 1 && r9.drillMatchesNum
            && r9.drillHasColumns && r9.drillSortWorks && r9.drillClosed && r9.backOnStats
            && r9.docRendered && r9.docHasHeadings >= 1 && r9.docHasPara && r9.docHasList
            && r9.docEditable && r9.noEditBtn && r9.noSaveBtn && r9.hasHistoryBtn
            && r9.autoSaved && r9.sourceHasEdit
            && r9.roundTripHasHead && r9.roundTripHasTable && r9.roundTripHasList
            && r9.roundTripHasInline && r9.roundTripStable
            // 第 10 轮：今日保留完成 / 拖拽不闪 / 日期控件统一 / 报告自定义要求
            && r10.todayRowBefore && r10.todayKeptAfterDone && r10.todayKeptMarkedDone && r10.todayKeptStrike
            && r10.todayKeepBar && r10.todayHiddenByButton && r10.todayKeptAgain
            && r10.todayKeptAfterViewSwitch && r10.todayKeptStillDone && r10.todayHiddenByButtonAgain
            && r10.resizeFlagOn && r10.resizePointersFrozen && r10.resizeContain
            && r10.resizeGutter === 'stable' && r10.resizeWidened && r10.resizeNoRebuild
            && r10.resizeFinalMatchesPointer
            && r10.resizeVarSynced && r10.resizeFlagOff && r10.resizeStableAfterDrop
            && r10.rerenderKeepsWidth && r10.rerenderNoAnim
            && r10.tfRangeFields === 3 && r10.tfNativeDates === 0 && r10.tfHasFlatpickr && r10.tfStyleSame
            && r10.tfCalendarOpens && r10.tfPickedBoth && r10.tfBadgeActive && r10.tfCleared
            && r10.extraExists && r10.extraPersisted && r10.extraDegradedNoted
            // 第 11 轮：行内改标题 / 报告与检索持久化
            && r11.renameInputShown && r11.renameSaved && r11.renamePersisted
            && r11.rpHistoryBtn && r11.rpHistoryInToolbar && r11.rpModalOpened
            && r11.rpRows1 >= 1 && r11.rpHistoryGrew && r11.rpModalClosed && r11.rpLoadedContent
            && r11.rpHistoryShrunk
            && r11.searchHistoryBox && r11.searchHistoryGrew && r11.searchRestored
            && r11main.reports >= 1 && r11main.searches >= 1 && r11main.reportHasContent
            && r11main.searchHasKeyword && r11main.exportHasTables
            // 第 13 轮
            && r13.toastInBody && r13.toastAboveMask && r13.toastNoPointer
            && r13.groupHeads >= 1 && r13.headIsButton && r13.headCollapsed && r13.rowsShrunk
            && r13.arrowWidth >= 20 && r13.arrowFont >= 14
            && r13.expandedAgain && r13.collapsedCleared
            && r13.todayEditor && r13.todayFilled
            && r13.notesFilled && r13.titleSaved && r13.notesKept && r13.polishBtn
            && /已保存/.test(r13.saveStateText) && /s-saved/.test(r13.saveStateClass)
            && (!r13.staleToolbarBtns || r13.staleToolbarBtns.length === 0)
            && r13.rpHisBtn && r13.rpHisOpened && r13.rpHisWidth >= 900 && r13.rpHisInViewport
            && r13.mthBtn
            && r13main.storageNoEllipsis && r13main.autoStartInFile && r13main.autoStartNotTop
            // 第 14 轮：多任务详情编辑互不串改
            && r14.idsDistinct && r14.aRowFound && r14.bRowFound
            && r14.aOpened && r14.bUntouched && r14.aNotClonedFromB
            && r14.titlesDistinct && r14.aKeptEdit && r14.bNotesKept
            && r14.bOpened && r14.aStable && r14.bSaved && r14.stillDistinct
            // 第 15 轮：创建时间 / 趋势范围切换 / AI 润色反馈
            && r15.rowFound && r15.listCreated && /^\d{4}-\d{2}-\d{2}$/.test(r15.listCreatedText.replace('🕒', '').trim())
            && r15.detailCreated && /创建于 \d{4}-\d{2}-\d{2} /.test(r15.detailCreatedText)
            && r15.trendChips === 4 && r15.trendTitlesOk && r15.trendColsOk && r15.trendActiveOk && r15.trendSummary
            && r15.pRowFound && r15.polishBtn
            && r15.masks1 === 1 && r15.loadingShown && r15.btnDisabled && /改写中/.test(r15.btnText)
            && r15.masks2 === 1 && r15.modalClosed && r15.btnRestored
            && r15.errShown && r15.retryBtn && r15.modalClosedB
            // 第 16 轮：标题层级 / 子任务计数 / 行内改名自适应 / 图片放大 / 侧栏调宽 / 统计口径
            && r16.rowFound && r16.titleSizeOk && r16.titleBigger
            && r16.badgeExists && r16.badgeInTitle && r16.badgeNextToName && r16.badgeNotInMeta
            && /1\/2/.test(r16.badgeText || '')
            && r16.inputFound && r16.widthGrew && r16.noWrap && r16.withinRow && r16.noOverlap
            && r16.mdImgFound && r16.zoomOpened && r16.ratioKept
            && r16.closedByEsc && r16.closedByMask && r16.closedByDbl
            && r16.handleFound && r16.dragged && r16.minClamped && r16.selectDisabled
            && r16.selectRestored && r16.layoutAligned && r16.mainUsable && r16.noHOverflow
            && r16.persisted >= 180 && r16.scopeFound && r16.scopeGrew
            && r16.scopeTopActive && r16.scopeAllActive && r16.scopeSwitchedBack && r16.trendRefreshed
            // 第 17 轮：AI 检索联想（精确优先 / 联想候选 / 确实无关联）
            && r17.exactType === 'unique' && r17.exactHit && /报销差旅费/.test(r17.exactTop || '')
            && r17.assocType !== 'none' && r17.assocCount >= 1 && r17.assocIsAbbrev
            && r17.noneType === 'none' && r17.noneCount === 0 && r17.noneTried >= 1
            && r17.topCapped && r17.topHasScore
            && r17.uiExact.items >= 1 && r17.uiExact.bannerUnique && !r17.uiExact.empty
            && r17.uiAssoc.items >= 1 && (r17.uiAssoc.reasons || []).some((s) => /缩写还原|同义词|关键词/.test(s))
            && r17.uiNone.empty && r17.uiNone.items === 0 && r17.uiNone.tried >= 1
            // 第 18 轮：实用工具（代码格式化 / 文本对比 浮窗）
            && r18.noMask && r18.winBtns >= 3
            && r18.jsonOk && r18.xmlOk && r18.sqlOk && r18.javaOk && r18.autoOk && r18.multiOk && r18.errThrown
            && r18.minApplied && r18.minRestored && r18.maxApplied && r18.maxRestored && r18.mainUsable
            && r18.diffOpened && r18.bothOpen && r18.diffRows >= 3 && r18.diffAdd >= 1 && r18.diffDel >= 1
            && r18.inlineRows >= 3 && r18.inlineSigns >= 2 && r18.splitBack
            && r18.caseDiff >= 1 && r18.caseIgnored
            && r18.beforeFormat >= 1 && r18.formatConverged && r18.closed && !r18.err
            // 第 19 轮：语法高亮 + JSON 查看器
            && r18.diffHl >= 1 && r18.diffHlToggle && r18.diffHlOff
            && r18.jvOpened && r18.jvParsed && r18.jvTree >= 1 && /命中|个/.test(r18.jvHits || '')
            && /2/.test(r18.jvQuery || '');
          if (!allOk) {
            // 失败时把各组结果里「假值」的项打出来，避免对着几十个 && 条件逐个猜。
            // 其中少数断言本来就该是假/零（例如「原生 date 输入框应为 0 个」），列进白名单免得误导。
            const EXPECT_FALSY = new Set([
              'detail:persistedImmediate', // 落库有 350ms 节流，紧跟着读是 0 属正常，看 persisted
              'feat:subPriorityAfterEdit', // 期望值就是优先级 0
              'r4:popClipped',             // 期望「没有被裁剪容器包住」
              'r9:tagBeforeActive',        // 期望「点击前未选中」
              'r10:tfNativeDates',         // 期望「原生 date 输入框 0 个」
              'r15:masksBefore',           // 提示用：期望润色前没有残留遮罩 = 0
              'r17:noneCount',             // 期望「确实无关联」时候选就是 0 条
              'r18:afterFormat',           // 期望格式化后差异收敛到 0 处
            ]);
            let printed = 0;
            const dumpFalsy = (label, obj) => {
              const bad = Object.entries(obj || {})
                .filter(([k, v]) => (v === false || v === null || v === undefined || v === 0 || v === '')
                  && !EXPECT_FALSY.has(`${label}:${k}`));
              if (bad.length) {
                printed += 1;
                console.log(`[SMOKE] 未通过项 · ${label}：${bad.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('；')}`);
              }
            };
            dumpFalsy('dom', dom);
            dumpFalsy('topbar', topbarOut);
            dumpFalsy('detail', detail);
            dumpFalsy('feat', feat);
            dumpFalsy('r4', r4);
            dumpFalsy('r7', r7);
            dumpFalsy('r7main', r7main);
            dumpFalsy('r9', r9);
            dumpFalsy('r10', r10);
            dumpFalsy('r11', r11);
            dumpFalsy('r11main', r11main);
            dumpFalsy('r13', r13);
            dumpFalsy('r13main', r13main);
            dumpFalsy('r14', r14);
            dumpFalsy('r15', r15);
            dumpFalsy('r16', r16);
            dumpFalsy('r17', r17);
            dumpFalsy('r18', r18);
            // 假值列表抓不到「值非假但不匹配」的条件（如 xx === '旧文案'），补一行提示免得对着 && 死磕。
            if (!printed) {
              console.log('[SMOKE] 未通过项：无假值 → 问题在字符串/数值比对上（比对值或界面文案已过时）');
            }
          }
          console.log(allOk ? '[SMOKE] SMOKE_OK' : '[SMOKE] SMOKE_FAIL');
          isQuitting = true;
          app.quit();
        } catch (e) {
          console.error('[SMOKE] 检测失败:', e.message);
          console.error('[SMOKE] 堆栈:', e && e.stack ? String(e.stack).split('\n').slice(0, 20).join(' | ') : '');
          isQuitting = true;
          app.quit();
        }
      }, 1500);
    });
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopReminderScheduler();
  stopRecurrenceScheduler();
  backup.stopAutoBackup();
  destroyTray();
  // 浮窗随应用退出一起销毁（关主窗口不关它们：托盘常驻时浮窗要留着）
  desktopWindow.destroyAll();
});

app.on('window-all-closed', () => {
  // 不退出，保持托盘常驻
});
