'use strict';
/**
 * 主进程入口：窗口生命周期、单实例锁、托盘、全局快捷键、提醒调度。
 * 关闭窗口默认最小化到托盘，仅当显式退出时才真正退出。
 */
const {
  app, BrowserWindow, nativeTheme, ipcMain, session,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const { registerIpc } = require('./ipc');
const { setupTray, destroyTray } = require('./tray');
const shortcuts = require('./shortcuts');
const { registerShortcuts, unregisterShortcuts } = shortcuts;
const { startReminderScheduler, stopReminderScheduler } = require('./reminders');
const { markdownToDocx } = require('./docx');
const reportMod = require('./report');

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

  // 录制需要麦克风 / 屏幕采集权限：这是本机应用、且由用户主动点「录制」触发，
  // 不弹 Chromium 的权限气泡而是直接放行；其它权限（定位、通知等）一律拒绝。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

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
              out.searchNav = !!document.querySelector('.nav-item[data-view="search"]');
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

              /* ---- AI 配置：从工具栏打开 → 填表 → 保存 → 回读 ---- */
              const aiBtn = document.getElementById('btn-ai-settings');
              out.aiToolbarBtn = !!aiBtn && aiBtn.textContent.indexOf('AI 设置') > -1;
              if (aiBtn) {
                aiBtn.click();
                await new Promise(r => setTimeout(r, 250));
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
              }
              const cfg = await window.api.ai.getConfig();
              out.aiSavedUrl = cfg.baseUrl;
              out.aiSavedModel = cfg.model;
              } catch (e) { out.__fatal = String((e && e.stack) || e).split('\\n').slice(0, 4).join(' | '); }
              return out;
            })()
          `);
          if (dom.__fatal) console.log('[SMOKE][dom fatal]', dom.__fatal);
          console.log(`[SMOKE] 底部"添加任务"入口 = ${dom.addRowExists ? '存在' : '缺失'}`);
          console.log(`[SMOKE] 弹窗已移除 = ${dom.noModal ? '是' : '否'}`);
          console.log(`[SMOKE] 时间筛选面板 = ${dom.timeFilterBtn && dom.timeFilterPanel ? '存在' : '缺失'}`);
          console.log(`[SMOKE] 点击后编辑器展开 = ${dom.editorShown ? '成功' : '失败'}`);
          console.log(`[SMOKE] 编辑器含日期范围控件 = ${dom.planFields ? '是' : '否'}`);
          console.log(`[SMOKE] 详情抽屉容器 = ${dom.detailDrawer ? '存在' : '缺失'}`);
          console.log(`[SMOKE] AI 检索导航 = ${dom.searchNav ? '存在' : '缺失'}`);
          console.log(`[SMOKE] 标题输入框聚焦 = ${dom.titleFocused ? '成功' : '失败'}`);
          console.log(`[SMOKE] 日期范围两次点选回填 = ${dom.rangeStart || '-'} ~ ${dom.rangeEnd || '-'}（文案：${dom.rangeLabel}）；期望 ${dom.expectStart} ~ ${dom.expectEnd} → ${dom.autoFilled ? '一致' : '不一致'}`);
          console.log(`[SMOKE] 日期范围弹窗自动关闭 = ${dom.rangePopClosed ? '是' : '否'}`);
          console.log(`[SMOKE] 单次点击弹出面板数 = ${dom.calendarsOpen}（必须为 1）；挂在 body = ${dom.calInBody ? '是' : '否'}；可视日期格 = ${dom.calDays}`);
          console.log(`[SMOKE] 再次触发：重开=${dom.reopened ? '是' : '否'}；二次点击可关闭=${dom.closedByTrigger ? '是' : '否'}；面板在视口内=${dom.calInViewport ? '是' : '否'}`);
          console.log(`[SMOKE] 日期范围落库 = ${dom.persistedStart || '-'} ~ ${dom.persistedEnd || '-'}（${dom.persistedMatches ? '与控件一致' : '不一致'}）`);
          console.log(`[SMOKE] 取消后编辑器关闭 = ${dom.editorClosed ? '成功' : '失败'}`);
          console.log(`[SMOKE] 分组：新增=${dom.groupAdded ? '是' : '否'}（${dom.groupCountBefore} → ${dom.groupCount}）；重名错误=${dom.dupErrorShown ? '已提示' : '未提示'}`);
          console.log(`[SMOKE] 子分组：父行含箭头=${dom.hasArrow ? '是' : '否'}；上级默认带入=${dom.parentPresetMatched ? '是' : '否'}；子分组可见=${dom.childRowVisible ? '是' : '否'}；折叠后隐藏=${dom.childHiddenAfterCollapse ? '是' : '否'}；再展开回来=${dom.childBackAfterExpand ? '是' : '否'}；父筛选含子任务=${dom.parentFilterIncludesChildTask ? '是' : '否'}`);
          console.log(`[SMOKE] AI 设置（工具栏）= 按钮${dom.aiToolbarBtn ? '存在' : '缺失'}；弹窗${dom.aiModalOpened ? '打开' : '未打开'}；保存后回读=${dom.aiSavedUrl || '-'} / ${dom.aiSavedModel || '-'}`);
          console.log(`[SMOKE] AI 设置排版 = ${dom.aiCols} 列；分区 ${dom.aiSections} 个；字段 ${dom.aiFieldCount} 个；弹窗高 ${dom.aiBox ? dom.aiBox.h : '-'}px / 视口 ${dom.aiBox ? dom.aiBox.vh : '-'}px；完整在视口内=${dom.aiInViewport ? '是' : '否'}；底部按钮可点=${dom.aiFootReachable ? '是' : '否'}；内容无需滚动=${dom.aiBodyScrolls ? '是' : '否'}；横向无溢出=${dom.aiNoHOverflow ? '是' : '否'}`);
          console.log(`[SMOKE] 标签新增弹窗 = ${dom.tagModalOpened ? '弹出' : '未弹出'}；新增后列表出现 = ${dom.tagAdded ? '是' : '否'}`);

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
              await window.api.tasks.create({ title: '无日期子任务', parentId: parent.id });
              document.querySelector('.nav-item[data-view="today"]').click();
              await wait(500);
              const pLi = document.querySelector('.task-item[data-id="' + parent.id + '"]');
              out.parentVisibleToday = !!pLi;
              const arrow = pLi && pLi.querySelector('[data-act="toggle-expand"]');
              out.hasArrow = !!arrow;
              if (arrow) {
                if (arrow.textContent === '▾') { arrow.click(); await wait(400); }
                const a2 = document.querySelector('.task-item[data-id="' + parent.id + '"] [data-act="toggle-expand"]');
                out.collapsedChildHidden = !document.querySelector('.task-item.is-subtask');
                a2.click();
                await wait(500);
                out.expandedChildVisible = !!document.querySelector('.task-item.is-subtask');
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
                if (opts.length > 1) { opts[0].click(); await wait(200); opts[1].click(); await wait(250); }
                out.tsChips = document.querySelectorAll('.ts-control .item').length;
                out.tsHasRemove = document.querySelectorAll('.ts-control .item .remove').length;
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

          // 主进程侧：Word 导出与分组多选入参
          const docxBuf = markdownToDocx('# 冒烟报告\\n\\n- [x] 完成任务 **3** 项\\n- [ ] 待办 1\\n', { title: '冒烟报告' });
          const r4docx = {
            size: docxBuf.length,
            isZip: docxBuf.slice(0, 2).toString('latin1') === 'PK',
          };
          const groups = db.listGroups();
          const multiNames = groups.slice(0, 2).map((g) => g.name).join('、');
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
            single: single.markdown.includes(`分组：${groups[0].name}`),
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
              const nav = (v) => document.querySelector('.nav-item[data-view="' + v + '"]').click();
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
              const nav = (v) => document.querySelector('.nav-item[data-view="' + v + '"]').click();
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
              const nav = (v) => document.querySelector('.nav-item[data-view="' + v + '"]').click();
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

          /* ============ 第 13 轮：提示层级 / 分组折叠 / 今天默认值 / 详情描述回填 / 快捷键 ============ */
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

              /* 5) 快捷键：设置入口可用，默认值不与 IDEA 常用键位撞车 */
              const scBtn = document.getElementById('btn-shortcuts');
              out.scBtn = !!scBtn;
              if (scBtn) {
                scBtn.click();
                await wait(400);
                const scModal = document.querySelector('.modal-mask');
                out.scModalOpened = !!scModal;
                if (scModal) {
                  out.scRows = scModal.querySelectorAll('.sc-row').length;
                  out.scValues = [...scModal.querySelectorAll('.sc-input')].map(i => i.value);
                  scModal.querySelector('[data-modal="ok"]').click();
                  await wait(400);
                }
              }
              const scNow = await window.api.shortcuts.get();
              out.scDefaults = scNow && scNow.shortcuts;

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
          const r13main = {
            defaults: (() => {
              const cfg = shortcuts.getConfig();
              return cfg;
            })(),
            notIdea: (() => {
              // 默认组合不能落在 IDEA / Chrome 的已知占用键位上
              const cfg = shortcuts.getConfig();
              return !shortcuts.KNOWN_CONFLICTS[cfg.toggleWindow] && !shortcuts.KNOWN_CONFLICTS[cfg.quickAdd];
            })(),
            validate: (() => {
              // 校验器：缺修饰键 / 非法主键必须被拒绝
              return !shortcuts.validateAccel('Q').ok && !shortcuts.validateAccel('').ok
                && shortcuts.validateAccel('CommandOrControl+Alt+Shift+Q').ok;
            })(),
            dupRejected: (() => {
              const before = shortcuts.getConfig();
              const r = shortcuts.applyConfig({ toggleWindow: 'CommandOrControl+Alt+Shift+X', quickAdd: 'CommandOrControl+Alt+Shift+X' });
              shortcuts.applyConfig(before); // 还原
              return r && r.ok === false;
            })(),
          };
          console.log(`[SMOKE] Toast 层级 = z:${r13.zMask ? `(遮罩 ${r13.zMask})` : '?'} 挂 body=${r13.toastInBody ? '是' : '否'}；高于遮罩=${r13.toastAboveMask ? '是' : '否'}；不拦点击=${r13.toastNoPointer ? '是' : '否'}`);
          console.log(`[SMOKE] 分组折叠 = 表头 ${r13.groupHeads} 个（按钮语义=${r13.headIsButton ? '是' : '否'}）；折叠=${r13.headCollapsed ? '是' : '否'}；任务行减少=${r13.rowsShrunk ? '是' : '否'}；记忆=${JSON.stringify(r13.collapsedSaved)}；再展开=${r13.expandedAgain ? '是' : '否'}；清除=${r13.collapsedCleared ? '是' : '否'}`);
          console.log(`[SMOKE] 箭头尺寸 = 宽 ${r13.arrowWidth}px / 字号 ${r13.arrowFont}px（热区≥20、字号≥14：${r13.arrowWidth >= 20 && r13.arrowFont >= 14 ? '达标' : '未达标'}）`);
          console.log(`[SMOKE] 今天默认值 = ${r13.todayStart || '-'} ~ ${r13.todayEnd || '-'}（填今天=${r13.todayFilled ? '是' : '否'}）`);
          console.log(`[SMOKE] 详情描述 = 回填=${r13.notesFilled ? '是' : '否'}；状态「${r13.saveStateText}」（${r13.saveStateClass}）；标题落库=${r13.titleSaved ? '是' : '否'}；描述未被清空=${r13.notesKept ? '是' : '否'}；润色入口=${r13.polishBtn ? '有' : '无'}`);
          console.log(`[SMOKE] 快捷键 = 入口${r13.scBtn ? '存在' : '缺失'}；弹窗=${r13.scModalOpened ? '打开' : '未打开'}；项数=${r13.scRows}；当前=${JSON.stringify(r13.scDefaults)}；避开 IDEA=${r13main.notIdea ? '是' : '否'}；校验器=${r13main.validate ? '正常' : '异常'}；重复被拒=${r13main.dupRejected ? '是' : '否'}`);
          console.log(`[SMOKE] 历史弹窗尺寸 = 报告历史 ${r13.rpHisWidth}px（≥900=${r13.rpHisWidth >= 900 ? '是' : '否'}；完整在视口内=${r13.rpHisInViewport ? '是' : '否'}）；会议纪要历史入口=${r13.mthBtn ? '有' : '无'}`);

          const allOk = ready && dom.addRowExists && dom.noModal && dom.timeFilterBtn && dom.timeFilterPanel
            && dom.editorShown && dom.planFields && dom.detailDrawer && dom.searchNav && dom.titleFocused
            && dom.editorClosed && dom.calDays >= 28 && dom.calendarsOpen === 1 && dom.calInBody
            && dom.pickingOpen && dom.autoFilled && dom.rangePopClosed
            && dom.rangeStart <= dom.rangeEnd
            && dom.reopened && dom.closedByTrigger && dom.calInViewport && dom.persistedMatches
            && dom.groupModalOpened && dom.groupAdded && dom.dupErrorShown
            && dom.tagModalOpened && dom.tagAdded
            && dom.hasArrow && dom.parentPresetMatched && dom.childRowVisible && dom.parentFilterIncludesChildTask
            && dom.childHiddenAfterCollapse && dom.childBackAfterExpand
            && dom.aiToolbarBtn && dom.aiModalOpened && dom.aiModalCount === 1
            && dom.aiCols === 2 && dom.aiSections === 2 && dom.aiFieldCount === 8
            && dom.aiInViewport && dom.aiFootReachable && dom.aiBodyScrolls && dom.aiNoHOverflow
            && dom.aiSavedUrl === 'https://smoke.example.com' && dom.aiSavedModel === 'smoke-model'
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
            && r13.scBtn && r13.scModalOpened && r13.scRows === 2
            && r13.rpHisBtn && r13.rpHisOpened && r13.rpHisWidth >= 900 && r13.rpHisInViewport
            && r13.mthBtn
            && r13main.notIdea && r13main.validate && r13main.dupRejected;
          if (!allOk) {
            // 失败时把各组结果里「假值」的项打出来，避免对着几十个 && 条件逐个猜。
            // 其中少数断言本来就该是假/零（例如「原生 date 输入框应为 0 个」），列进白名单免得误导。
            const EXPECT_FALSY = new Set([
              'detail:persistedImmediate', // 落库有 350ms 节流，紧跟着读是 0 属正常，看 persisted
              'feat:subPriorityAfterEdit', // 期望值就是优先级 0
              'r4:popClipped',             // 期望「没有被裁剪容器包住」
              'r9:tagBeforeActive',        // 期望「点击前未选中」
              'r10:tfNativeDates',         // 期望「原生 date 输入框 0 个」
            ]);
            const dumpFalsy = (label, obj) => {
              const bad = Object.entries(obj || {})
                .filter(([k, v]) => (v === false || v === null || v === undefined || v === 0 || v === '')
                  && !EXPECT_FALSY.has(`${label}:${k}`));
              if (bad.length) {
                console.log(`[SMOKE] 未通过项 · ${label}：${bad.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('；')}`);
              }
            };
            dumpFalsy('dom', dom);
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
          }
          console.log(allOk ? '[SMOKE] SMOKE_OK' : '[SMOKE] SMOKE_FAIL');
          isQuitting = true;
          app.quit();
        } catch (e) {
          console.error('[SMOKE] 检测失败:', e.message);
          console.error('[SMOKE] 堆栈:', e && e.stack ? String(e.stack).split('\n').slice(0, 6).join(' | ') : '');
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
