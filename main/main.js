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
const { registerShortcuts, unregisterShortcuts } = require('./shortcuts');
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

              /* 5) AI 报告：分组下拉改为多选 + Word 导出按钮 */
              document.querySelector('.nav-item[data-view="reports"]').click();
              await wait(600);
              const trigger = document.getElementById('rp-group-trigger');
              out.msTrigger = !!trigger;
              out.msTriggerText0 = trigger ? trigger.textContent.trim() : '';
              if (trigger) {
                trigger.click();
                await wait(200);
                const panel = document.getElementById('rp-group-panel');
                out.msOpened = !!(panel && !panel.hidden);
                out.msFixed = panel ? getComputedStyle(panel).position === 'fixed' : false;
                const boxes = [...panel.querySelectorAll('[data-group]')].filter(b => b.dataset.group !== '__all__');
                out.msBoxCount = boxes.length;
                for (const bx of boxes.slice(0, 2)) {
                  bx.checked = true;
                  bx.dispatchEvent(new Event('change', { bubbles: true }));
                }
                await wait(150);
                out.msTriggerText1 = trigger.textContent.trim();
                out.msMulti = /已选|全部 \\d/.test(trigger.textContent);
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
          console.log(`[SMOKE] 报告分组多选 = 面板${r4.msOpened ? '已展开' : '未展开'}（fixed=${r4.msFixed ? '是' : '否'}，${r4.msBoxCount} 个分组）；文案「${r4.msTriggerText0}」→「${r4.msTriggerText1}」；Word 按钮=${r4.exportDocxBtn ? '存在' : '缺失'}`);

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
            && r4.msTrigger && r4.msOpened && r4.msFixed && r4.msBoxCount >= 2 && r4.msMulti
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
            && r7main.presets >= 4 && r7main.uniqueIds && r7main.domestic >= 3 && r7main.chunkSaved && r7main.files === 1;
          if (!allOk) {
            // 失败时把各组结果里「假值」的项打出来，避免对着几十个 && 条件逐个猜
            const dumpFalsy = (label, obj) => {
              const bad = Object.entries(obj || {})
                .filter(([, v]) => v === false || v === null || v === undefined || v === 0 || v === '');
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
          }
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
