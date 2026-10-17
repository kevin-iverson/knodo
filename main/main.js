'use strict';
/**
 * 主进程入口：窗口生命周期、单实例锁、托盘、全局快捷键、提醒调度。
 * 关闭窗口默认最小化到托盘，仅当显式退出时才真正退出。
 */
const { app, BrowserWindow, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const db = require('./db');
const { registerIpc } = require('./ipc');
const { setupTray, destroyTray } = require('./tray');
const { registerShortcuts, unregisterShortcuts } = require('./shortcuts');
const { startReminderScheduler, stopReminderScheduler } = require('./reminders');

const isSmoke = process.argv.includes('--smoke-test');

let mainWindow = null;
let isQuitting = false;

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
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!isSmoke) mainWindow.show();
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

function toggleWindow() {
  if (!mainWindow) return showWindow();
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showWindow();
}

function quickAdd() {
  showWindow();
  mainWindow.webContents.send('ui:quick-add');
}

function focusTask(taskId) {
  showWindow();
  mainWindow.webContents.send('ui:focus-task', taskId);
}

function applyTheme() {
  const mode = db.getSetting('theme', 'system');
  nativeTheme.themeSource = mode; // 'system' | 'light' | 'dark'
}

app.whenReady().then(() => {
  db.init(app.getPath('userData'));
  applyTheme();
  registerIpc();

  createWindow();

  setupTray({
    getWindow: () => mainWindow,
    onShow: showWindow,
    onQuickAdd: quickAdd,
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  registerShortcuts({ onToggle: toggleWindow, onQuickAdd: quickAdd });
  startReminderScheduler({ onFocusTask: focusTask });

  ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });

  app.on('activate', () => showWindow());

  // 冒烟测试：验证主进程各模块 + 渲染进程能正常初始化后自动退出
  if (isSmoke) {
    mainWindow.webContents.on('console-message', (_e, ...args) => {
      const d = args[0];
      const message = d && typeof d === 'object' ? (d.message ?? JSON.stringify(d)) : String(d);
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
              out.addRowExists = !!document.querySelector('[data-act="start-add"]');
              out.noModal = !document.querySelector('.modal-mask');
              out.timeFilterBtn = !!document.querySelector('#btn-time-filter');
              out.timeFilterPanel = !!document.querySelector('#time-filter');
              const addBtn = document.querySelector('[data-act="start-add"]');
              if (addBtn) { addBtn.click(); await new Promise(r => setTimeout(r, 300)); }
              const ed = document.querySelector('.task-editor[data-editor="new"]');
              out.editorShown = !!ed;
              out.titleFocused = !!(ed && document.activeElement === ed.querySelector('.editor-title'));
              out.planFields = !!(ed && ed.querySelector('.date-range-field'));
              out.detailDrawer = !!document.querySelector('#detail-drawer');
              out.searchNav = !!document.querySelector('.nav-item[data-view="search"]');
              if (ed) {
                const cancel = ed.querySelector('[data-act="editor-cancel"]');
                if (cancel) cancel.click();
                await new Promise(r => setTimeout(r, 300));
              }
              out.editorClosed = !document.querySelector('.task-editor[data-editor="new"]');
              return out;
            })()
          `);
          console.log(`[SMOKE] 底部"添加任务"入口 = ${dom.addRowExists ? '存在' : '缺失'}`);
          console.log(`[SMOKE] 弹窗已移除 = ${dom.noModal ? '是' : '否'}`);
          console.log(`[SMOKE] 时间筛选面板 = ${dom.timeFilterBtn && dom.timeFilterPanel ? '存在' : '缺失'}`);
          console.log(`[SMOKE] 点击后编辑器展开 = ${dom.editorShown ? '成功' : '失败'}`);
          console.log(`[SMOKE] 编辑器含日期范围控件 = ${dom.planFields ? '是' : '否'}`);
          console.log(`[SMOKE] 详情抽屉容器 = ${dom.detailDrawer ? '存在' : '缺失'}`);
          console.log(`[SMOKE] AI 检索导航 = ${dom.searchNav ? '存在' : '缺失'}`);
          console.log(`[SMOKE] 标题输入框聚焦 = ${dom.titleFocused ? '成功' : '失败'}`);
          console.log(`[SMOKE] 取消后编辑器关闭 = ${dom.editorClosed ? '成功' : '失败'}`);

          const allOk = ready && dom.addRowExists && dom.noModal && dom.timeFilterBtn && dom.timeFilterPanel && dom.editorShown && dom.planFields && dom.detailDrawer && dom.searchNav && dom.titleFocused && dom.editorClosed;
          console.log(allOk ? '[SMOKE] SMOKE_OK' : '[SMOKE] SMOKE_FAIL');
          isQuitting = true;
          app.quit();
        } catch (e) {
          console.error('[SMOKE] 检测失败:', e.message);
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
  unregisterShortcuts();
  destroyTray();
});

app.on('window-all-closed', () => {
  // 不退出，保持托盘常驻
});
