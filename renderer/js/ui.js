'use strict';
/**
 * 视图渲染与交互（分组、任务、就地新增/编辑、拖拽排序、时间筛选、深色模式）。
 *
 * 新增/编辑任务采用“飞书式”就地交互：列表底部提供“添加任务”入口，点击后
 * 原地展开编辑器；“计划开始日期 / 计划完成日期”直接放在新增行主表单中填写。
 */
import { api, localToIso, isoToLocal, fmtDateTime, PRIORITY_TEXT, PRIORITY_COLOR } from './api.js';
import {
  state, loadGroups, loadTags, loadTasks, refreshAll, todayStr,
  noteCompletionChange, clearRecentlyDone, initRecentlyDone,
  taskGroupKey, initCollapsedTaskGroups, toggleTaskGroup,
} from './store.js';
import { renderReports } from './reports.js';
import { openDetail, setDetailHandlers, refreshDetailIfIdle } from './detail.js';
import { openSearchModal, setSearchHandlers } from './search.js';
import { openPromptModal, openFormModal, openPanelModal } from './modal.js';
import { createAutoSave, SAVE_STATE_TEXT } from './autosave.js';
import { flattenGroupTree, childGroups, descendantGroupIds, groupPath } from './group-tree.js';
import {
  groupPickerOptionsHtml, createGroupSelect, destroyGroupSelectsIn, destroyAllGroupSelects,
  priorityPickerOptionsHtml, createPrioritySelect,
} from './group-select.js';
import { listenAiSettingsMenu, setAiSettingsHandlers } from './ai-settings.js';
import { openSponsorAsk } from './sponsor.js';
import { renderMeetings, setMeetingsHandlers, autoProcessMeeting } from './meetings.js';
import {
  renderNotes, setNotesHandlers, createNote, disposeNotes, importNotesFromDisk, openNotesDock,
} from './notes.js';
import { bindRecordButton, setRecorderHandlers } from './recorder.js';
// 趣味功能 → 上班鼓励器（薪资进账主界面）；不反向 import ui.js，toast / 统计走依赖注入
import { listenEncouragerMenu, setEncouragerHandlers, openEncourager } from './encourager.js';
import { setNoteExportHandlers } from './sync.js';
import { bindImageZoom } from './image-zoom.js';
import { initSidebarResize } from './sidebar-resize.js';
// 标题栏右上角三颗自绘按钮（系统 overlay 已撤，见 main/main.js）
import { initWindowControls } from './win-controls.js';
import { openContextMenu, closeContextMenu } from './ctx-menu.js';
import { openSettings, setSettingsHandlers } from './settings.js';
// 外观：整份主题对象（模式 × 风格 × 背景）由主进程下发，渲染层不再自持副本
import { initTheme as initThemeState, getTheme, setThemeHook } from './theme.js';
import { renderCalendar, setCalendarHandlers, openCalendar, backToList, disposeCalendar } from './calendar.js';
import {
  repeatEditorHtml, bindRepeatEditor, readRepeatConfig, isRepeatOn,
  setRecurrenceHandlers, listenRecurrenceMenu, openRuleFromTask, openRecurrenceManager,
  derivedScheduleHtml, recurStateBadgeHtml, recurState,
} from './recurrence.js';

/** 即时持久化防抖延迟（毫秒）：输入停止这么久之后才写库 */
const AUTO_SAVE_DELAY = 700;
import {
  dateRangeFieldHtml, bindDateRangeFields, validateDateRange,
  DATE_RANGE_EVENT, DATE_RANGE_DEFAULTS, syncReminderWithPlanEnd, defaultDateRange,
  reminderHtml, bindReminder, computeReminder, reminderNeedsPlanEnd,
} from './controls.js';

// 新建任务时计划日期的默认范围：'none' = 留空（默认），'today' = 今天 ~ 今天
const NEW_TASK_RANGE_MODE = 'none';
// 计划日期是否必填（默认否：允许创建“无期限”任务）
const PLAN_DATE_REQUIRED = DATE_RANGE_DEFAULTS.required;

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const VIEW_META = {
  today: { title: '今天', desc: '今天 + 已逾期', long: '今天或已逾期的进行中任务（按计划完成日期）' },
  // 一级视图：侧栏「今天」下面的「日历」；描述由 calendar.js 按当月 / 当周统计动态写入
  calendar: { title: '日历', desc: '', long: '按日负载排布任务，月 / 周缩放，拖拽即可改期' },
  upcoming: { title: '即将到期', desc: '计划完成日期在今天或之后的任务' },
  // 「未完成」= 全部进行中任务，跨分组汇总，逾期也在里面（与「即将到期」互补：一个看将来，一个看欠账）
  unfinished: { title: '未完成', desc: '所有还没勾掉的任务（含逾期 / 未排期）' },
  all: { title: '全部任务', desc: '所有进行中与已完成任务' },
  completed: { title: '已完成', desc: '已完成但未归档的任务' },
  archived: { title: '归档', desc: '已归档的完成任务' },
  stats: { title: '统计', desc: '任务完成情况概览' },
  reports: { title: 'AI 报告', desc: '基于本地数据自动生成日报 / 周报 / 月报' },
  meetings: { title: '会议纪要', desc: '录制 / 导入会议音频 → 语音转写 → AI 纪要 → 待办入库' },
  notes: { title: '笔记', desc: 'Markdown 笔记 → 按目录 / 标签沉淀为知识库，可关联到任务并供 AI 检索' },
};

/** 会展示任务列表、因而消费分组/标签筛选的视图 */
const TASK_VIEWS = ['today', 'upcoming', 'unfinished', 'all', 'completed', 'archived'];

/** 重复规则缓存：任务行徽标要显示规则摘要 / 是否为习惯，renderTasks 每轮拉一次（规则表很小） */
let recurringRules = [];
let recurringRuleMap = new Map();
/** 「今天」视图里「今天不发生」清单的展开态（只在本会话内记忆，不影响主列表折叠） */
let pendingRecurringOpen = false;

/**
 * 可以钉到桌面的「视图投影」。
 * 共同点：不需要 refId（内容按视图口径实时算），与分组投影共用同一套窗口 chrome。
 */
const PINNABLE_VIEWS = ['today', 'upcoming', 'unfinished'];

/**
 * 时间筛选的三组日期范围。
 * 使用与「添加任务」完全相同的 flatpickr 范围控件（controls.js 的 dateRangeFieldHtml）：
 * 两次点选成范围、快捷按钮（今天/明天/本周末/清除）、中文日历、面板定位逻辑全部复用，
 * 视觉也沿用同一套 .date-range-* 样式 —— 不再用原生 input[type=date]（样式与交互都跟别处不一致）。
 */
const TF_RANGES = [
  { key: 'planStart', label: '计划开始日期', from: 'planStartFrom', to: 'planStartTo' },
  { key: 'planEnd', label: '计划完成日期', from: 'planEndFrom', to: 'planEndTo' },
  { key: 'completed', label: '实际完成时间', from: 'completedFrom', to: 'completedTo' },
];
/** 面板级监听只绑一次（面板内容会被重建，容器本身不换） */
let tfEventsBound = false;

/* ---------------- 应用内快捷键（固定键位，不开放自定义） ---------------- */
/**
 * 只在主窗口聚焦时生效，走渲染层 keydown，与主进程的全局键完全分开。
 * 这一组的核心是 ↑↓ / Space / Enter 必须一起上：只给 Space 不给 ↑↓，
 * 用户还得回去用鼠标选行，等于没做。
 */
/** 当前键盘选中的任务 id（null = 没有选中） */
let kbSelectedId = null;
/** 删除快照：Ctrl+Z 在 5 秒内可以原样恢复 */
let lastDeleted = null;
/** 上次同步给主进程（捕捉条）的当前清单，避免每次渲染都发一次 IPC */
let lastSentContext;

/* ---------------- 番茄钟（专注计时）渲染态 ---------------- */
// 主进程权威快照（active/mode/pendingOutcome/...），由 focus:changed 事件驱动 + 本地 500ms tick 重算显示
let focusSnap = { active: false, mode: 'idle', plannedSec: 1500, pendingOutcome: '', pendingReason: '' };
// 当前列表任务 → 格数 { full, partial }（renderTasks 批量拉取）
let focusCounts = {};
// 今日等效格数（顶栏「今天 N 格」）
let focusToday = 0;
// 收尾态下的连续专注格数（含当前这一格，用于软提示）
let focusConsecutive = 0;
// 时长选项（秒）：15 / 30 / 45 分钟，记住上次选择（默认 30 —— 用户拍板，个人事务+工作混合，25 分钟偏碎）
const FOCUS_DURATIONS = [900, 1800, 2700];
let focusDurationSec = Number(localStorage.getItem('knodo.focusDurationSec')) || 1800;

/* ---------------- 初始化 ---------------- */

export async function init() {
  setDetailHandlers({ refresh: () => { renderSidebar(); renderTasks(); }, toast });
  setSearchHandlers({ openDetail, toast });
  // 会议录制 / 纪要：录制归档后自动跳到会议视图查看。
  // refresh 只刷侧栏计数，绝不碰 #view —— 它是共享容器，会议里完成转写 / 出纪要 /
  // 删除记录 / 导入待办都会回调它，这里调 renderTasks() 会把整页换回任务列表
  // （「录制完跳任务列表」「删除录音记录也跳任务列表」都是这个原因）。
  setMeetingsHandlers({ toast, refresh: () => { renderSidebar().catch(() => {}); } });
  // 笔记视图：切走时销毁编辑器自动保存器（否则拿着已销毁的 DOM 继续写库）
  setNotesHandlers({
    toast,
    // 走 render() 而不是 renderTasks()：#view 是共享容器，直接渲染任务列表会把笔记视图整块冲掉
    refresh: () => { renderSidebar(); render(); },
    switchView: async () => { state.view = 'notes'; renderSidebar(); await render(); },
  });
  api.on('ui:new-note', () => { openNewNote(); });
  // 全局快捷键 Ctrl+Shift+H：主进程已把窗口唤起，这里打开「笔记」弹窗（不切视图）
  api.on('ui:notes-dock', () => {
    openNotesDock().catch((e) => toast(`打开笔记失败：${(e && e.message) || e}`));
  });
  // 「导入 Markdown 笔记…」：菜单栏已撤，入口在设置中心「数据与备份」；两处共用这一条
  api.on('ui:import-md', () => { importMarkdownNotes(); });
  setRecorderHandlers({
    toast,
    onMeetingSaved: async (m) => {
      state.view = 'meetings';
      renderSidebar();
      try {
        await render();
        if (m) await autoProcessMeeting(m);
      } catch (e) {
        console.error('[ui] 会议自动处理失败', e);
      }
    },
  });
  // 日历视图：把「切视图 / 重绘 / 提示 / 打开详情」作为回调注入，避免 calendar.js 反向 import ui.js
  setCalendarHandlers({
    toast,
    render: () => render(),
    renderSidebar: () => renderSidebar(),
    refresh: () => { renderSidebar(); render(); },
    openTaskDetail: (id) => openDetail(id),
  });
  bindStaticEvents();
  // 窗口三键：绑定点击 + 跟随主进程推来的最大化状态（图标在 最大化 / 还原 间切换）
  initWindowControls();
  // 番茄钟：订阅主进程计时状态 + 初始快照 + 500ms 本地重算（进度环/剩余时间）
  initFocus();
  // 图片双击放大：事件委托挂在 document 上，动态重绘出来的图片自动生效
  bindImageZoom();
  // 侧边栏宽度：读取上次保存值并绑定拖拽（不阻塞首屏渲染）
  initSidebarResize().catch((e) => console.warn('[ui] 侧边栏宽度初始化失败', e && e.message));
  await initTheme();
  // 恢复上次退出时的标签筛选（重启后仍保持选中态）
  state.currentTag = await api.ui.getTagFilter();
  // 恢复「今日已完成」：切走再回来、或重启应用，今天完成的那些任务仍然留在今天列表里
  await initRecentlyDone();
  // 恢复任务列表里被折叠的分组
  await initCollapsedTaskGroups();
  // 已钉到桌面上的清单 / 视图：右键菜单与侧边栏标记都要用
  await refreshDesktopPins(false);
  await renderSidebar();
  await render();
}

function bindStaticEvents() {
  // 导航
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      // 记住最近的任务列表视图：从「日历 / AI 检索」这类非列表视图返回时回到原来那一项
      const target = btn.dataset.view;
      if (TASK_VIEWS.includes(target)) lastListView = target;
      else if (TASK_VIEWS.includes(state.view)) lastListView = state.view;
      // 「今日已完成」是持久化的：切换视图不清除，回到「今天」时列表依然完整
      state.view = target;
      state.currentGroup = 'all';
      state.editingTaskId = null;
      state.addingTask = false;
      renderSidebar();
      render();
    });
  });

  // 标题栏品牌名右侧的「设置」齿轮（另两条：Ctrl+, / 托盘菜单）
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', () => {
      if (document.querySelector('.modal-settings')) return; // 已经开着，别闪一下
      // 面板开着时 openSettings 的 Promise 会在关闭时才 resolve，正好拿来点亮/熄灭
      btnSettings.classList.add('is-open');
      openSettings('')
        .catch((e) => toast(`打开设置失败：${(e && e.message) || e}`))
        .finally(() => btnSettings.classList.remove('is-open'));
    });
  }
  // 标题栏「搭子」：打开工位搭子面板的「搭子」页（Ctrl+Alt+E 走同一条链路，默认也是这页）。
  // 它不是视图，所以不碰 state.view —— 模态关掉后停在原来那个视图，符合「点一下看看就走」。
  const btnBuddy = document.getElementById('btn-buddy');
  if (btnBuddy) {
    btnBuddy.addEventListener('click', () => {
      // 面板已经开着（可能停在其他页签）：只切页，不叠第二个模态，按钮也别闪一下
      if (document.querySelector('.modal-encourager')) {
        openEncourager({ tab: 'buddy' }).catch(() => {});
        return;
      }
      // 与齿轮同款：Promise 在关闭时才 resolve，正好拿来点亮 / 熄灭
      btnBuddy.classList.add('is-open');
      openEncourager({ tab: 'buddy' })
        .catch((e) => toast(`打开工位搭子失败：${(e && e.message) || e}`))
        .finally(() => btnBuddy.classList.remove('is-open'));
    });
  }
  // 标题栏品牌名右侧的版本号：只做弱提示，取不到就空着，绝不影响布局
  Promise.resolve(api.app.getVersion())
    .then((v) => {
      const el = document.getElementById('sb-ver');
      if (el && v) el.textContent = `v${v}`;
    })
    .catch(() => {});

  // 分组 / 标签新增
  document.getElementById('btn-add-group').addEventListener('click', () => promptAddGroup());
  document.getElementById('btn-add-tag').addEventListener('click', promptAddTag);
  // AI 配置（原在「AI 报告」页内的配置面板；现统一从顶部菜单栏「AI 设置」打开）
  setAiSettingsHandlers({ toast, onChanged: () => { renderSidebarList(); } });
  listenAiSettingsMenu();
  // 趣味功能 → 上班鼓励器：注册菜单事件 / 任务完成发币 / 配置变更的监听。
  // 监听是全局的，主浮窗没打开时完成任务也会发币并用应用内 toast 回应。
  setEncouragerHandlers({
    toast,
    getStats: () => {
      const done = state.recentlyDone.size;
      const active = (state.tasks || []).filter((t) => !t.completed).length;
      const byId = new Map((state.tasks || []).map((t) => [String(t.id), t]));
      const titles = [...state.recentlyDone]
        .map((id) => byId.get(String(id)))
        .filter((t) => t && t.title)
        .slice(0, 20)
        .map((t) => ({ id: t.id, title: String(t.title).slice(0, 60) }));
      return { done, total: done + active, titles };
    },
  });
  listenEncouragerMenu();
  // 重复事项 / 习惯：菜单入口 + 后台跨天生成后的刷新；不反向 import ui.js，刷新能力走注入
  setRecurrenceHandlers({
    toast,
    onChanged: async () => {
      if (TASK_VIEWS.includes(state.view) || state.view === 'calendar') await render();
    },
  });
  listenRecurrenceMenu();
  // 后台跨天推进了重复事项：抽屉里那份「本次 / 截止 / 提醒」要跟着换；
  // 用户正在输入时不动（refreshDetailIfIdle 内部判断），避免丢光标
  api.on('ui:recurrence-generated', () => refreshDetailIfIdle());
  // 会议录制（工具栏按钮）
  bindRecordButton();

  // 笔记导出面板的 toast 注入（入口在笔记视图工具栏「📤 导出」，见 notes.js）
  setNoteExportHandlers({ toast });

  // 设置（Ctrl+, / 菜单 / 托盘三条入口都汇到这条事件）
  setSettingsHandlers({
    toast,
    // 设置中心的日历项与日历视图内的「调整每日容量」写同一个 tool.calendar 键
    onCalendarPrefs: () => { if (state.view === 'calendar') render(); },
    // 菜单栏撤掉后，原来那些「打开工具 / 维护动作」改由设置中心发起，实现仍在本模块
    onAction: runMenuAction,
  });
  api.on('ui:settings', (paneId) => {
    // 主进程可带分区 id（菜单「趣味功能 → 工位搭子设置…」直接落到 fun 分区）
    openSettings(paneId || '').catch((e) => toast(`打开设置失败：${(e && e.message) || e}`));
  });
  // 背景图丢失提示条上的「重新选择」：直接落到外观分区
  document.addEventListener('knodo:open-appearance', () => {
    openSettings('appearance').catch((e) => toast(`打开设置失败：${(e && e.message) || e}`));
  });
  // 供冒烟 / 验证脚本驱动：设置中心没有可点击的顶栏按钮（只有菜单与 Ctrl+,），
  // 自动化碰不到原生菜单，就留一个与 __appReady 同性质的小钩子。
  window.__openSettings = openSettings;
  // 启动后的静默检查：有新版只轻提示，不弹窗打断；详情从 File 菜单 / 设置「关于」打开
  api.on('ui:update-available', (info) => {
    toast(`发现新版本 ${(info && info.tag) || ''}：菜单 File → 检查更新 可查看详情`);
  });
  // 全局键 Ctrl+Alt+1~6 / H 在"还没钉浮窗"时的明确反馈：不静默失败
  api.on('ui:no-desktop-pins', () => {
    toast('还没有钉到桌面的清单：在侧边栏右键清单 /「今天」/「即将到期」→「钉到桌面」');
  });
  // 应用内快捷键（固定，不开放自定义）
  bindInAppKeys();

  // 数据导入 / 导出
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import').addEventListener('click', importData);

  // 搜索
  const searchInput = document.getElementById('search-input');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = searchInput.value.trim();
      // 搜索是「任务列表」的能力：在日历态输入就退回列表，别让日历静默失效
      if (state.view === 'calendar') {
        state.view = 'today';
        renderSidebar();
        render();
      } else renderTasks();
    }, 200);
  });

  // 顶栏「🔍 AI 检索」：以弹窗打开，不离开当前视图（筛选 / 选中任务都保留）。
  // 顶栏搜索框里已经敲过的关键词会带进检索框，省得重打一遍。
  document.getElementById('btn-ai-search')?.addEventListener('click', () => {
    openSearchModal(document.getElementById('search-input')?.value.trim() || '');
  });

  // 笔记弹窗：不离开当前任务视图就能看 / 改笔记（弹窗里是同一套笔记界面）
  document.getElementById('btn-notes-dock')?.addEventListener('click', () => {
    openNotesDock().catch((e) => toast(`打开笔记失败：${(e && e.message) || e}`));
  });

  // 贴顶便签：把「未完成」钉到屏幕顶边（再点取消）
  document.getElementById('btn-dock')?.addEventListener('click', () => { toggleDock(); });

  // 顶栏标签筛选指示：点击即清除筛选
  const tagChip = document.getElementById('tag-filter-chip');
  if (tagChip) tagChip.addEventListener('click', () => selectTag(null));

  // 优先级筛选
  document.querySelectorAll('.chip[data-priority]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.priorityFilter = chip.dataset.priority;
      document.querySelectorAll('.chip[data-priority]').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderTasks();
    });
  });

  // 排序方式（智能 / 优先级 / 截止日期 / 手动）
  const sortSel = document.getElementById('sort-select');
  if (sortSel) {
    sortSel.value = state.sortMode;
    sortSel.addEventListener('change', async () => {
      setSortMode(sortSel.value);
      await renderTasks();
      if (state.sortMode === 'manual') toast('手动排序：按住任务左侧的 ⠿ 手柄拖动即可调整顺序');
    });
  }

  // 时间筛选：切换面板 + 三组日期范围（与「添加任务」同一个 flatpickr 控件）
  document.getElementById('btn-time-filter').addEventListener('click', () => {
    const tf = document.getElementById('time-filter');
    tf.hidden = !tf.hidden;
  });
  buildTimeFilter();

  // 新建（顶部按钮 → 展开列表底部编辑器） / 归档已完成
  document.getElementById('btn-new-task').addEventListener('click', () => {
    ensureTaskView();
    startAdd();
  });
  // 「🗂 归档」已移入 File 菜单：元素不存在时不能抛错（可选链）
  document.getElementById('btn-archive-done')?.addEventListener('click', archiveCompleted);
  api.on('ui:archive-done', () => archiveCompleted());

  // 全局快捷键 Ctrl+Alt+M：与 Ctrl+Alt+B/N/C 同族，直接进侧栏「日历」（再按一次回列表）。
  // 不传模式 → calendar.js 恢复上次使用的月 / 周缩放级别。
  api.on('ui:calendar', () => {
    if (state.view === 'calendar') backToList(lastListView);
    else {
      if (TASK_VIEWS.includes(state.view)) lastListView = state.view;
      openCalendar();
    }
  });

  // 主题：唯一入口在设置中心（也可用 Ctrl+, 打开），菜单栏重复项已删除

  // 主进程事件：托盘菜单“快速添加” → 展开底部编辑器
  api.on('ui:quick-add', () => {
    ensureTaskView();
    startAdd();
  });
  // 提醒点击 → 定位到任务并就地打开编辑
  api.on('ui:focus-task', (id) => {
    ensureTaskView();
    startEdit(id);
  });

  // 桌面浮窗里改了数据（勾选 / 新增 / 删除）→ 主窗口跟上。
  // **记账（noteCompletionChange）必须与焦点无关**：浮窗勾掉的也是「今天完成」，
  // 漏了这一步，等主窗下一次刷新「今天」就会按 status:'active' 把它剔掉 ——
  // 用户看到的是「在小窗口勾完，任务界面里这条就没了」。
  // 重绘才看焦点 / 忙碌状态：主窗口自己发起的变更不需要回灌（会丢焦点、丢滚动位置），
  // 而用户正在主窗口里编辑（就地编辑器 / 详情抽屉 / 弹窗）时宁可先不刷，免得冲掉未保存的输入。
  api.on('ui:data-changed', async (payload) => {
    if (payload && payload.taskId && payload.completed) {
      noteCompletionChange(payload.taskId, true, payload.parentId);
    }
    const fromDock = !!(payload && payload.source === 'desktop');
    if (!fromDock && document.hasFocus()) return;
    const busy = !!document.querySelector('.modal-mask')
      || !!document.querySelector('.task-editor')
      || !!document.querySelector('.detail-drawer:not([hidden]) .detail-panel');
    if (busy) return;
    await refreshAll();
    renderSidebarList();
    if (TASK_VIEWS.includes(state.view)) await renderTasks();
    else if (state.view === 'calendar') await render();
    // 浮窗里编辑了笔记：列表摘要 / 字数要跟着变（正文在编辑器里的那份不会被顶掉，
    // 因为这条广播只在主窗口没有焦点时才处理）
    else if (state.view === 'notes') await renderNotes();
  });
  // 已钉清单变化（钉 / 取消钉住 / 主进程还原）：刷新侧边栏的 📌 标记
  api.on('desktop:projection-changed', () => { refreshDesktopPins(); });

  // 右键：分组项自己绑（见 renderSidebarList），这里管「今天 / 即将到期」导航项与它们的任务区
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('#group-list')) return;
    const nav = e.target.closest('.nav-item[data-view]');
    if (nav && PINNABLE_VIEWS.includes(nav.dataset.view)) {
      e.preventDefault();
      showViewContextMenu(nav.dataset.view, e);
      return;
    }
    // 视图的任务区：右键任意空白 / 行都能钉当前视图（行内的输入框除外）
    if (PINNABLE_VIEWS.includes(state.view) && e.target.closest('#view') && !e.target.closest('input, textarea')) {
      e.preventDefault();
      showViewContextMenu(state.view, e);
    }
  });
}

/* ---------------- 时间筛选面板（复用 flatpickr 范围控件） ---------------- */

/** 顶栏「时间筛选」按钮随生效范围数量变化（0 个 → 普通态，≥1 → 高亮 + 计数） */
function updateTimeFilterBadge() {
  const btn = document.getElementById('btn-time-filter');
  if (!btn) return;
  const n = TF_RANGES.filter((r) => state.timeFilters[r.from] || state.timeFilters[r.to]).length;
  btn.classList.toggle('active', n > 0);
  btn.textContent = n ? `⏱ 时间筛选 · ${n}` : '⏱ 时间筛选';
  btn.title = n ? `已启用 ${n} 组时间范围，点击查看或修改` : '按计划开始 / 计划完成 / 实际完成时间筛选';
}

/**
 * 重建时间筛选面板（首次挂载 + 清除后重建）。
 * 重建而不是逐个清空实例：flatpickr 的日历容器挂在 body 上，
 * 换掉 DOM 后由 bindDateRangeFields → sweepDetachedRanges 统一销毁，不会留下孤儿日历。
 */
function buildTimeFilter() {
  const box = document.getElementById('time-filter');
  if (!box) return;
  const tf = state.timeFilters;

  box.innerHTML = TF_RANGES.map((r) => `
    <div class="tf-group" data-tf="${r.key}">
      <span class="tf-label">${r.label}</span>
      ${dateRangeFieldHtml(tf[r.from], tf[r.to], { placeholder: '不限' })}
    </div>`).join('')
    + '<button class="ghost-btn" id="tf-clear" title="清空全部时间范围">清除</button>';

  bindDateRangeFields(box);

  if (!tfEventsBound) {
    tfEventsBound = true;
    // 控件内部已把「开始 / 结束」归一成有序的一对值，这里直接落到筛选项
    box.addEventListener(DATE_RANGE_EVENT, (e) => {
      const cell = e.target.closest('[data-tf]');
      if (!cell) return;
      const def = TF_RANGES.find((r) => r.key === cell.dataset.tf);
      if (!def) return;
      state.timeFilters[def.from] = e.detail.planStart || '';
      state.timeFilters[def.to] = e.detail.planEnd || '';
      updateTimeFilterBadge();
      renderTasks();
    });
  }

  box.querySelector('#tf-clear').addEventListener('click', () => {
    TF_RANGES.forEach((r) => { state.timeFilters[r.from] = ''; state.timeFilters[r.to] = ''; });
    buildTimeFilter();
    updateTimeFilterBadge();
    renderTasks();
  });

  updateTimeFilterBadge();
}

/** 确保当前处于任务类视图（否则切到“全部任务”） */
function ensureTaskView() {
  if (TASK_VIEWS.includes(state.view)) return;
  state.view = 'all';
  state.currentGroup = 'all';
  renderSidebar();
  const meta = VIEW_META.all;
  document.getElementById('view-title').textContent = meta.title;
  document.getElementById('view-desc').textContent = meta.desc;
}

/* ---------------- 渲染入口 ---------------- */

let lastView = null;
/** 最近停留的任务列表视图：从日历 / AI 检索返回时用它，而不是一律跳回「今天」 */
let lastListView = 'today';
/** 任务 id → 关联笔记数（renderTasks 批量拉取，列表徽标用） */
let noteCounts = {};

async function render() {
  // #view 是共享容器：整块重绘前先回收挂在 body 上的 Tom Select 下拉，避免残留浮层
  destroyAllGroupSelects();
  // 视图切换 / 重绘时先收起右键菜单：菜单里的操作带着旧上下文，留着容易点错
  closeContextMenu();
  // 离开笔记视图时销毁编辑器：整页 innerHTML 重建后，旧的自动保存器会继续写库
  if (lastView === 'notes' && state.view !== 'notes') disposeNotes();
  if (lastView === 'calendar' && state.view !== 'calendar') disposeCalendar();
  lastView = state.view;
  const meta = VIEW_META[state.view] || VIEW_META.all;
  document.getElementById('view-title').textContent = meta.title;
  const descEl = document.getElementById('view-desc');
  descEl.textContent = meta.desc;
  descEl.title = meta.long || meta.desc;
  // 统计 / AI 报告 / 会议纪要不是任务列表：顶栏工具整排隐藏。
  // 日历保留工具行但收起筛选栏（有自己的负载图例与控件）。
  const isTaskView = TASK_VIEWS.includes(state.view);
  const isCalendar = state.view === 'calendar';
  // 新建编辑行是列表的尾项（在 #view 内），离开任务视图时随重绘一起消失，
  // 不需要额外的收起动作 —— 这里只保留一句提示，免得后来人再去找那个面板。
  document.querySelector('.topbar-right').hidden = !(isTaskView || isCalendar);
  document.getElementById('filter-bar').hidden = !isTaskView;
  if (!isTaskView) document.getElementById('time-filter').hidden = true;
  // AI 检索已是弹窗：顶栏按钮只是入口，不再有「选中态」，也不占视图
  const aiBtn = document.getElementById('btn-ai-search');
  if (aiBtn) aiBtn.title = 'AI 检索：关键词检索全部任务并生成 AI 总结（弹窗，不离开当前视图）';
  syncNavHint();
  // 顶栏「贴顶便签」的选中态也跟着每次重绘校正一次（事件偶尔丢一拍时能自愈）
  paintDockBtn();
  renderTagFilterChip();
  if (state.view === 'stats') { await renderStats(); return; }
  if (state.view === 'reports') { await renderReports(); return; }
  if (state.view === 'meetings') { await renderMeetings(); return; }
  if (state.view === 'notes') { await renderNotes(); return; }
  if (isCalendar) { await renderCalendar(); return; }
  await renderTasks();
}

/** 侧栏「日历」首启提示：新功能不做成标题旁的小 chip，只在第一次进来时轻微脉冲一次 */
let navHintChecked = false;
function syncNavHint() {
  // 日历入口已搬到标题栏（见 index.html 的 .tb-cal），这里只认侧栏里那一项；
  // 搬走后查不到，静默跳过（以后若挪回侧栏，这段逻辑自动恢复）
  const nav = document.querySelector('.sidebar .nav-item[data-view="calendar"]');
  if (!nav || navHintChecked) return;
  navHintChecked = true;
  api.ui.getToolPref('calendar').then((p) => {
    if (p && p.seenHint) return;
    nav.classList.add('is-hint');
    setTimeout(() => nav.classList.remove('is-hint'), 2100);
    api.ui.setToolPref('calendar', { ...(p || {}), seenHint: true }).catch(() => {});
  }).catch(() => {});
}

async function renderSidebar() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  paintNavPins();
  await loadGroups();
  await loadTags();
  // 标签可能已被删除：持久化下来的 id 失效时要静默清掉，避免筛选结果为空却看不出原因
  if (state.currentTag != null && !state.tags.some((t) => t.id === state.currentTag)) {
    state.currentTag = null;
    await api.ui.setTagFilter(null);
  }
  renderSidebarList();
  renderTagFilterChip();
}

/** 仅重绘分组 / 标签列表（使用 state 中已有数据，避免多余请求、避免重复拉取覆盖新增项） */
function groupEmptyHint(groups, groupList) {
  if (groups.length) return;
  const empty = document.createElement('li');
  empty.className = 'list-empty';
  empty.textContent = '暂无分组，点击 ＋ 新增';
  groupList.appendChild(empty);
}

/* ---------------- 桌面浮窗（钉到桌面） ---------------- */

/**
 * 已钉清单的内存镜像：右键菜单的勾选状态、侧边栏的 📌 标记共用一份。
 * 真身在 settings（主进程），这里只是缓存；主进程推送 desktop:projection-changed 时刷新。
 */
let desktopPins = [];

async function refreshDesktopPins(rerender = true) {
  try {
    const list = await api.desktop.list();
    desktopPins = Array.isArray(list) ? list : [];
  } catch (e) {
    // 读失败**不要清空缓存**：主进程正好在写库时 IPC 会短暂失败，把磁盘上的 📌 抹掉
    // 会让用户以为「钉的窗丢了」，还会把顶栏「贴顶便签」按钮的错误地变成未开启态。
    if (!Array.isArray(desktopPins)) desktopPins = [];
  }
  if (rerender) {
    renderSidebarList();
    // 导航项（今天 / 即将到期 / 未完成）上的 📌 不随分组列表重绘，单独刷一次
    paintNavPins();
    paintDockBtn(true);
  }
}

/**
 * 顶栏「贴顶便签」按钮的选中态。
 * 这里**实时查一次**而不是只读 desktopPins 缓存：钉 / 取消钉是异步的，
 * 缓存刷新与按钮重绘容易错一拍，表现为「已经钉了但图标没亮」。
 */
let dockBtnToken = 0;
let dockBtnAt = 0;
async function paintDockBtn(force = false) {
  const btn = document.getElementById('btn-dock');
  if (!btn) return;
  // 每次重绘都会调一次，节流 400ms：视图切换足够即时，又不会变成 IPC 洪水
  if (!force && Date.now() - dockBtnAt < 400) return;
  dockBtnAt = Date.now();
  const token = ++dockBtnToken;
  let pins = desktopPins;
  try {
    const live = await api.desktop.list();
    if (Array.isArray(live)) pins = live;
  } catch (e) { /* 主进程忙时退回缓存，不闪成「未钉」 */ }
  if (token !== dockBtnToken) return; // 只应用最后一次，避免并发回填旧状态
  // 顶条与侧吸都算「便签开着」：同一个视图只该有一条便签，按钮不该因为换了条边就显示未开
  const pin = (pins || []).find((p) => p.kind === 'unfinished' && p.dock);
  btn.classList.toggle('is-on', !!pin);
  btn.title = pin
    ? '便签已打开：点击取消（也可以在便签上点 📌 / Esc 收起）'
    : '把「未完成」钉到屏幕顶边（悬停展开成列表）';
}

/**
 * 便签（吸边 dock，顶条或侧吸）的开关。
 * 它装的是「未完成」这一份口径 —— 用户要的是「我欠多少」而不是「现在做什么」，
 * 22 条对「今天」是噪音，对「未完成」才是答案。
 * 已经在侧吸的也算「已打开」：再点一次是取消，不是又钉一条顶条出来。
 */
async function toggleDock() {
  const pin = desktopPins.find((p) => p.kind === 'unfinished' && p.dock);
  // 之前拖离过顶边的那个浮窗：直接把它贴回去，而不是再造一个同源的第二个窗
  const loose = desktopPins.find((p) => p.kind === 'unfinished' && !p.dock);
  try {
    if (pin) {
      await api.desktop.unpin(pin.id);
      toast('已取消便签');
    } else if (loose) {
      await api.desktop.redock(loose.id);
      toast('已贴回屏幕顶边：未完成（鼠标碰一下展开）');
    } else {
      await api.desktop.pin('unfinished', null, { dock: 'top' });
      toast('已钉到屏幕顶边：未完成（鼠标碰一下展开）');
    }
  } catch (e) {
    toast(`${pin ? '取消' : '钉到顶边'}失败：${(e && e.message) || e}`);
  }
  await refreshDesktopPins();
}

/**
 * 导航项上的 📌 标记。
 * 侧边栏导航是静态 HTML，这里只增删那个小标记，不重建整个按钮
 * （重建会把上面绑好的点击事件冲掉）。
 */
function paintNavPins() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const view = b.dataset.view;
    const pin = PINNABLE_VIEWS.includes(view) ? pinnedOf(view, null) : null;
    const old = b.querySelector('.nav-pin');
    if (pin && !old) {
      const sp = document.createElement('span');
      sp.className = 'nav-pin';
      sp.title = '已钉在桌面上';
      sp.textContent = '📌';
      b.appendChild(sp);
    } else if (!pin && old) {
      old.remove();
    }
  });
}

/** 某个分组 / 视图（今天、即将到期）是否已钉在桌面 */
function pinnedOf(kind, refId) {
  return desktopPins.find(
    // 视图投影没有 refId（今天与即将到期都存 null），按 kind 认；分组投影按 refId 认
    (p) => p.kind === kind && (kind !== 'group' || Number(p.refId) === Number(refId)),
  ) || null;
}

async function pinToDesktop(kind, refId, label) {
  try {
    await api.desktop.pin(kind, refId);
    toast(`已钉到桌面：${label}`);
  } catch (e) {
    toast(`钉到桌面失败：${(e && e.message) || e}`);
  }
  await refreshDesktopPins();
}

async function unpinFromDesktop(pin, label) {
  try {
    await api.desktop.unpin(pin.id);
    toast(`已取消钉住：${label}`);
  } catch (e) {
    toast(`取消钉住失败：${(e && e.message) || e}`);
  }
  await refreshDesktopPins();
}

/** 「钉到桌面 / 取消钉住」这一组（分组与视图投影共用的那几项） */
function pinMenuItems(kind, refId, label) {
  const pin = pinnedOf(kind, refId);
  const items = [];
  if (pin) {
    items.push({ label: '取消钉住（从桌面移除）', icon: '📌', checked: true, onClick: () => unpinFromDesktop(pin, label) });
    if (!pin.visible) {
      items.push({ label: '在桌面显示这个窗口', icon: '👁', onClick: () => api.desktop.show(pin.id).catch(() => {}) });
    } else {
      items.push({ label: '暂时收起这个窗口', icon: '—', onClick: () => api.desktop.hide(pin.id).catch(() => {}) });
    }
    items.push({ label: '恢复默认位置', icon: '⌖', onClick: () => api.desktop.resetPosition(pin.id).catch(() => {}) });
  } else {
    const full = desktopPins.length >= 6;
    items.push({
      label: '钉到桌面',
      icon: '📌',
      disabled: full,
      hint: full ? '已钉满 6 个，请先在「桌面浮窗」菜单里收起一个' : '在桌面上单独开一个小窗，常驻显示',
      onClick: () => pinToDesktop(kind, refId, label),
    });
  }
  return items;
}

/** 分组右键菜单 */
function showGroupContextMenu(g, e) {
  const label = groupPath(g, state.groups);
  const sibs = siblingsOf(g.parent_id);
  const idx = sibs.findIndex((x) => x.id === g.id);
  const total = sibs.length + 1; // 含自己
  openContextMenu([
    ...pinMenuItems('group', g.id, label),
    { type: 'sep' },
    // 位置调整：上移/下移按同级序号走，首尾置灰（点了也不会有变化，不如直接不可用）
    { label: '上移', icon: '↑', disabled: idx <= 0, hint: '与上一个同级分组交换位置', onClick: () => moveGroupTo(g.id, g.parent_id, idx - 1) },
    { label: '下移', icon: '↓', disabled: idx < 0 || idx >= sibs.length - 1, hint: '与下一个同级分组交换位置', onClick: () => moveGroupTo(g.id, g.parent_id, idx + 1) },
    { label: '移到最前', icon: '⇤', disabled: idx === 0, onClick: () => moveGroupTo(g.id, g.parent_id, 0) },
    { label: '移到最后', icon: '⇥', disabled: idx >= sibs.length - 1, onClick: () => moveGroupTo(g.id, g.parent_id, sibs.length) },
    {
      label: '移动到分组…',
      icon: '↪',
      hint: `当前在第 ${idx + 1}/${total} 位`,
      onClick: () => promptMoveGroup(g),
    },
    ...(g.parent_id == null
      ? []
      : [{ label: '移到顶层', icon: '⤒', hint: '成为顶级分组，排在最后', onClick: () => moveGroupTo(g.id, null, siblingsOf(null).length) }]),
    { type: 'sep' },
    { label: '在此分组新增任务', icon: '＋', onClick: () => addTaskToGroup(g.id) },
    { label: '新增子分组', icon: '⊞', onClick: () => promptAddGroup(g.id) },
    { label: '编辑分组', icon: '✎', onClick: () => editGroup(g) },
    { type: 'sep' },
    { label: '删除分组', icon: '×', danger: true, onClick: () => deleteGroup(g) },
  ], { x: e.clientX, y: e.clientY });
}

/* ---------------- 分组位置移动（拖拽 / 右键 / 弹窗） ---------------- */

/** 当前正在拖拽的分组 id（dragover 阶段读不到 dataTransfer 里的数据，只能记在模块里） */
let dragGroupId = null;
/** 当前高亮的落点元素（配合 markGroupDrop 做增量清理） */
let dropMark = null;

/** 同一父级下的分组，按 sort_order 排好，可排除某个分组（拖拽时排除自己） */
function siblingsOf(parentId, exceptId = null) {
  const key = parentId == null ? null : Number(parentId);
  return state.groups
    .filter((g) => (g.parent_id == null ? null : Number(g.parent_id)) === key)
    .filter((g) => exceptId == null || g.id !== Number(exceptId))
    .sort((a, b) => ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || (a.id - b.id));
}

/** 清掉所有落点标记（拖动过程中反复切换目标，必须逐次清理） */
function clearGroupDropMarks() {
  if (dropMark) {
    dropMark.classList.remove('drop-before', 'drop-after', 'drop-inside');
    dropMark = null;
  }
  const list = document.getElementById('group-list');
  if (list) list.classList.remove('drop-end');
}

/** 给某一行打落点标记（同一行同一落点不重复改 DOM，dragover 触发频率很高） */
function markGroupDrop(li, zone) {
  if (dropMark === li && li.classList.contains(`drop-${zone}`)) return;
  clearGroupDropMarks();
  li.classList.add(`drop-${zone}`);
  dropMark = li;
}

/**
 * 拖到某一行的哪个位置：上 1/4 → 插到它前面，下 1/4 → 插到它后面，中间 → 变成它的子分组。
 * 返回 null 表示这个目标非法（自己、或自己的子孙 —— 否则树会成环）。
 */
function groupDropZone(li, e, g) {
  if (dragGroupId == null) return null;
  if (g.id === dragGroupId) return null;
  if (descendantGroupIds(state.groups, dragGroupId).includes(g.id)) return null;
  const rect = li.getBoundingClientRect();
  const h = rect.height || 1;
  const y = e.clientY - rect.top;
  if (y < h * 0.28) return 'before';
  if (y > h * 0.72) return 'after';
  return 'inside';
}

/**
 * 移动分组并刷新界面。
 * @param {number} id 分组 id
 * @param {number|null} parentId 目标上级（null = 顶级）
 * @param {number} index 目标层级里的位置（0 基；负数/超长由主进程钳制）
 * @param {{silent?: boolean}} [opts] silent = 不弹 toast（由调用方自己给更具体的提示）
 */
async function moveGroupTo(id, parentId, index, opts = {}) {
  const gid = Number(id);
  const g = state.groups.find((x) => x.id === gid);
  if (!g) return false;
  const pid = parentId == null ? null : Number(parentId);
  if (pid === gid) { toast('不能把分组移动到自己下面'); return false; }
  if (pid != null && descendantGroupIds(state.groups, gid).includes(pid)) {
    toast('不能把分组移动到它自己的子分组下');
    return false;
  }
  const ok = await guardAction(() => api.groups.move(gid, { parentId: pid, index }), '移动分组失败');
  if (!ok) return false;

  await refreshAll();
  // 目标父级展开：否则移过去的那个分组藏在折叠节点里，看着像"消失了"
  if (pid != null) state.expandedGroups.add(pid);
  if (g.parent_id != null) state.expandedGroups.add(g.parent_id);
  renderSidebarList();
  renderTasks();
  highlightSidebarItem('group', gid);
  if (!opts.silent) {
    const where = pid == null ? '顶层' : `「${state.groups.find((x) => x.id === pid)?.name || '目标分组'}」下`;
    toast(`「${g.name}」已移动到${where}`);
  }
  return true;
}

/** 拖拽落点 → 写库：before/after 插到目标前/后，inside 追加为目标组的最后一个子分组 */
async function dropGroupOn(dragId, target, zone) {
  if (zone === 'inside') {
    return moveGroupTo(dragId, target.id, siblingsOf(target.id).length);
  }
  const sibs = siblingsOf(target.parent_id, dragId);
  const at = sibs.findIndex((x) => x.id === target.id);
  if (at < 0) return false;
  return moveGroupTo(dragId, target.parent_id, zone === 'before' ? at : at + 1);
}

/**
 * 给一行分组绑定拖拽。整行即可拖（组内没有输入框，不像任务行那样必须靠左侧抓手）；
 * 普通的单击选中不会触发 dragstart，所以不影响原有交互。
 */
function bindGroupRowDrag(li, g) {
  li.draggable = true;

  li.addEventListener('dragstart', (e) => {
    dragGroupId = g.id;
    li.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // 带上 group: 前缀，避免和任务行的普通 id 混淆（任务拖进来时这里直接忽略）
      e.dataTransfer.setData('text/plain', `group:${g.id}`);
    }
  });

  li.addEventListener('dragend', () => {
    dragGroupId = null;
    li.classList.remove('dragging');
    clearGroupDropMarks();
  });

  li.addEventListener('dragover', (e) => {
    const zone = groupDropZone(li, e, g);
    if (!zone) return; // 自己 / 自己的子孙：不接受，光标显示禁止
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDrop(li, zone);
  });

  li.addEventListener('dragleave', (e) => {
    if (li.contains(e.relatedTarget)) return;
    if (dropMark === li) clearGroupDropMarks();
  });

  li.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = groupDropZone(li, e, g);
    const from = dragGroupId;
    dragGroupId = null;
    clearGroupDropMarks();
    if (from == null || !zone) return;
    await dropGroupOn(from, g, zone);
  });
}

/**
 * 列表空白处作为「移到顶级末尾」的落点（含「全部」那一行 = 顶级首位）。
 * #group-list 是常驻元素，只绑一次，否则每次 render 都会叠一层监听。
 */
function bindGroupListDrop() {
  const list = document.getElementById('group-list');
  if (!list || list.dataset.dropBound === '1') return;
  list.dataset.dropBound = '1';
  const isRow = (t) => !!(t && t.closest && t.closest('.group-item'));

  list.addEventListener('dragover', (e) => {
    if (dragGroupId == null || isRow(e.target)) return; // 行内落点由行自己处理
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearGroupDropMarks();
    list.classList.add('drop-end');
  });

  list.addEventListener('dragleave', (e) => {
    if (list.contains(e.relatedTarget)) return;
    list.classList.remove('drop-end');
  });

  list.addEventListener('drop', async (e) => {
    if (isRow(e.target)) return;
    e.preventDefault();
    const from = dragGroupId;
    dragGroupId = null;
    clearGroupDropMarks();
    if (from == null) return;
    await moveGroupTo(from, null, siblingsOf(null, from).length);
  });
}

/** 「移动到分组…」：显式指定目标上级 + 排到最前/最后 */
async function promptMoveGroup(g) {
  const exclude = [g.id, ...descendantGroupIds(state.groups, g.id)];
  const options = [
    { value: '', label: '（无，作为顶级分组）' },
    ...flattenGroupTree(state.groups, { respectExpansion: false })
      .filter(({ g: x }) => !exclude.includes(x.id))
      .map(({ g: x, depth }) => ({
        value: x.id,
        label: `${depth ? `${'　'.repeat(depth)}└ ` : ''}${x.name}`,
      })),
  ];
  await openFormModal({
    title: `移动分组「${g.name}」`,
    okText: '移动',
    grid: false,
    fields: [
      {
        name: 'parentId',
        label: '目标上级分组',
        type: 'select',
        value: g.parent_id ?? '',
        hint: '移到别的分组下面 = 变成它的子分组；自身与其子分组不在候选里',
        options,
      },
      {
        name: 'position',
        label: '在目标层的位置',
        type: 'select',
        value: 'last',
        options: [
          { value: 'last', label: '排到最后' },
          { value: 'first', label: '排到最前' },
        ],
      },
    ],
    onSubmit: async (v) => {
      const pid = v.parentId === '' ? null : Number(v.parentId);
      const index = v.position === 'first' ? 0 : siblingsOf(pid, g.id).length;
      const ok = await moveGroupTo(g.id, pid, index, { silent: true });
      return ok ? undefined : '移动失败，请稍后重试';
    },
  });
}

/** 「今天」/「即将到期」右键菜单（导航项与对应视图的任务区空白处共用） */
function showViewContextMenu(view, e) {
  const label = (VIEW_META[view] && VIEW_META[view].title) || view;
  const items = [];
  // 「未完成」多一个顶边便签入口：它装的正是这张清单
  if (view === 'unfinished') {
    const dockPin = desktopPins.find((p) => p.kind === 'unfinished' && p.dock);
    items.push({
      label: dockPin ? '取消便签' : '钉到屏幕顶边（悬停展开）',
      icon: '📌',
      checked: !!dockPin,
      hint: '贴在屏幕边缘，收起成一条，鼠标碰一下展开；拖到左/右边缘可改成侧吸',
      onClick: () => { toggleDock(); },
    });
    items.push({ type: 'sep' });
  }
  openContextMenu([
    ...items,
    ...pinMenuItems(view, null, label),
    { type: 'sep' },
    {
      label: `在「${label}」里新建任务`,
      icon: '＋',
      onClick: () => {
        state.view = view;
        state.currentGroup = 'all';
        renderSidebar();
        render();
        startAdd();
      },
    },
  ], { x: e.clientX, y: e.clientY });
}

function renderSidebarList() {
  const groups = state.groups;
  const groupList = document.getElementById('group-list');
  if (!groupList) return; // 元素缺失时直接返回，避免整条链路抛出异常后按钮全部失效
  groupList.innerHTML = '';

  const allItem = document.createElement('li');
  allItem.className = 'group-item' + (state.currentGroup === 'all' ? ' active' : '');
  allItem.innerHTML = `<span class="group-dot" style="background:#c3cad6"></span>
    <span class="group-name">全部</span>`;
  allItem.addEventListener('click', () => {
    state.currentGroup = 'all';
    renderSidebarList();
    renderTasks();
  });
  // 拖到「全部」上 = 放到顶级分组的第一位（它在列表最上面，落点位置和视觉一致）
  allItem.addEventListener('dragover', (e) => {
    if (dragGroupId == null) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDrop(allItem, 'after');
  });
  allItem.addEventListener('dragleave', (e) => {
    if (allItem.contains(e.relatedTarget)) return;
    if (dropMark === allItem) clearGroupDropMarks();
  });
  allItem.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const from = dragGroupId;
    dragGroupId = null;
    clearGroupDropMarks();
    if (from == null) return;
    await moveGroupTo(from, null, 0);
  });
  groupList.appendChild(allItem);
  bindGroupListDrop();

  for (const { g, depth } of flattenGroupTree(state.groups, { expanded: state.expandedGroups })) {
    const children = childGroups(state.groups, g.id);
    const expanded = state.expandedGroups.has(g.id);
    const li = document.createElement('li');
    li.className = 'group-item'
      + (state.currentGroup === g.id ? ' active' : '')
      + (depth ? ' is-child' : '');
    li.dataset.id = g.id;
    li.dataset.parent = g.parent_id ?? '';
    li.dataset.depth = String(depth);
    li.style.paddingLeft = `${10 + depth * 14}px`;
    li.title = `${groupPath(g, state.groups)}（含子分组）`;
    li.innerHTML = `
      ${children.length
    ? `<button class="group-arrow" data-act="toggle-group" aria-expanded="${expanded}" title="${expanded ? '收起子分组' : '展开子分组'}">${expanded ? '▾' : '▸'}</button>`
    : '<span class="group-arrow space"></span>'}
      <span class="group-dot" style="background:${esc(g.color)}"></span>
      <span class="group-name">${esc(g.name)}</span>
      ${pinnedOf('group', g.id) ? '<span class="group-pin" title="已钉在桌面上">📌</span>' : ''}
      <span class="group-count" title="含子分组的任务数">${g.total_count ?? g.active_count ?? 0}</span>
      <span class="group-actions">
        <button class="g-task-add" title="在此分组下新增任务" data-act="add-task">＋</button>
        <button class="g-add" title="新增子分组" data-act="add-sub">⊞</button>
        <button class="g-edit" title="编辑" data-act="edit">✎</button>
        <button class="g-del" title="删除" data-act="del">×</button>
      </span>`;
    // 有子分组且未展开 → 折叠时子项不渲染（由 flattenGroupTree 的可见性过滤保证）
    li.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'add-task') { e.stopPropagation(); return addTaskToGroup(g.id); }
      if (act === 'add-sub') { e.stopPropagation(); return promptAddGroup(g.id); }
      if (act === 'edit') { e.stopPropagation(); return editGroup(g); }
      if (act === 'del') { e.stopPropagation(); return deleteGroup(g); }
      if (act === 'toggle-group') {
        e.stopPropagation();
        if (state.expandedGroups.has(g.id)) state.expandedGroups.delete(g.id);
        else state.expandedGroups.add(g.id);
        renderSidebarList();
        return undefined;
      }
      state.currentGroup = g.id;
      renderSidebarList();
      renderTasks();
    });
    // 右键分组：主入口是「钉到桌面」，其余分组操作顺带放在同一个菜单里（低频但顺手）
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showGroupContextMenu(g, e);
    });
    bindGroupRowDrag(li, g);
    groupList.appendChild(li);
  }

  groupEmptyHint(groups, groupList);

  // 标签
  const tagList = document.getElementById('tag-list');
  if (!tagList) return;
  tagList.innerHTML = '';
  if (!state.tags.length) {
    tagList.innerHTML = '<li class="list-empty">暂无标签，点击 ＋ 新增</li>';
    return;
  }
  for (const t of state.tags) {
    const li = document.createElement('li');
    const active = state.currentTag === t.id;
    li.className = 'tag-item' + (active ? ' active' : '');
    li.dataset.id = t.id;
    // 可聚焦 + 语义化：键盘 Tab 可达，读屏能播报选中状态
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-pressed', String(active));
    li.title = active ? `已按标签「${esc(t.name)}」筛选，点击取消` : `点击按标签「${esc(t.name)}」筛选`;
    li.innerHTML = `
      <span class="tag-color" style="background:${esc(t.color)}"></span>
      <span class="tag-name">${esc(t.name)}</span>
      <span class="tag-count">${t.task_count || 0}</span>
      <button class="tag-del" title="删除">×</button>`;
    const toggle = () => selectTag(state.currentTag === t.id ? null : t.id);
    li.addEventListener('click', (e) => {
      if (e.target.closest('.tag-del')) return;
      toggle();
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggle(); }
    });
    li.querySelector('.tag-del').addEventListener('click', () => deleteTag(t));
    tagList.appendChild(li);
  }
}

/**
 * 切换标签筛选。
 * 关键：统计 / 报告 / 检索 / 会议这几个视图并不消费 tagId，若留在原视图会出现
 * 「点了标签、列表毫无变化」的假死感 —— 选中标签时自动切回任务视图。
 */
async function selectTag(id) {
  state.currentTag = id;
  if (id != null && !TASK_VIEWS.includes(state.view)) {
    state.view = 'all';
    state.currentGroup = 'all';
  }
  await api.ui.setTagFilter(id);
  renderSidebar();
  await render();
  renderTagFilterChip();
}

/** 顶栏筛选指示：侧边栏滚动/折叠时也能确认标签筛选仍在生效 */
function renderTagFilterChip() {
  const el = document.getElementById('tag-filter-chip');
  if (!el) return;
  const t = state.tags.find((x) => x.id === state.currentTag);
  if (!t) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span class="tag-color" style="background:${esc(t.color)}"></span>`
    + `<span>标签：${esc(t.name)}</span><span class="chip-x">×</span>`;
}

/* ---------------- 应用内键盘操作 ---------------- */

/** 当前是否在可输入控件里（在输入框里按 Space / 方向键必须是打字，不是勾选 / 选行） */
function isTypingTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return !!(t.closest && t.closest('[contenteditable="true"]'));
}

/** 列表里可选中的任务行（编辑中的行、子任务行都在内；编辑器行不允许被选中） */
function selectableRows() {
  const viewEl = document.getElementById('view');
  if (!viewEl) return [];
  return [...viewEl.querySelectorAll('.task-item[data-id]')].filter((el) => !el.classList.contains('editing'));
}

function paintKbSelection() {
  const rows = selectableRows();
  const exists = kbSelectedId != null && rows.some((r) => Number(r.dataset.id) === kbSelectedId);
  if (!exists) kbSelectedId = null;
  rows.forEach((r) => {
    r.classList.toggle('is-kb-selected', kbSelectedId != null && Number(r.dataset.id) === kbSelectedId);
  });
}

function moveKbSelection(delta) {
  const rows = selectableRows();
  if (!rows.length) return;
  const i = rows.findIndex((r) => Number(r.dataset.id) === kbSelectedId);
  let next;
  if (i < 0) next = delta > 0 ? 0 : rows.length - 1;
  else next = Math.max(0, Math.min(rows.length - 1, i + delta));
  kbSelectedId = Number(rows[next].dataset.id);
  paintKbSelection();
  rows[next].scrollIntoView({ block: 'nearest' });
}

/**
 * 应用内键总入口。
 * Ctrl+N / Ctrl+Shift+N 在输入框里也生效（它们不是文本编辑语义）；
 * Space / ↑↓ / Enter / Delete / Ctrl+Z 只在列表里生效 —— 否则打字会变成勾选。
 */
function bindInAppKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    // 弹窗里的事情交给弹窗自己（设置面板的录制态更是不能被打断）
    if (document.querySelector('.modal-mask')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const typing = isTypingTarget(e.target);

    // 原菜单加速键：菜单栏整条撤掉后这些组合没人注册了，在这里重绑（行为与原菜单一致）
    //   Ctrl+,         设置
    //   Ctrl+Shift+I   导入 Markdown
    if (mod && !e.altKey) {
      const k = key.toLowerCase();
      if (!e.shiftKey && k === ',') {
        e.preventDefault();
        openSettings('').catch((err) => toast(`打开设置失败：${(err && err.message) || err}`));
        return;
      }
      if (e.shiftKey && k === 'i') {
        e.preventDefault();
        runMenuAction('import-md');
        return;
      }
    }

    if (mod && !e.altKey && key.toLowerCase() === 'n') {
      if (e.shiftKey) {
        // 新建笔记：从任何位置都放行（它本身就是"换个地方做事"）
        e.preventDefault();
        openNewNote();
        return;
      }
      // 新建任务：输入框 / 笔记编辑器里不抢（那里 Ctrl+N 有别的含义，误触会丢上下文）
      if (typing) return;
      e.preventDefault();
      ensureTaskView();
      startAdd();
      return;
    }
    if (mod && !e.altKey && key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      undoDelete();
      return;
    }
    // 番茄钟：Ctrl+Enter 暂停 / 继续（专注进行中且不在收尾态时）
    if (mod && !e.altKey && key === 'Enter') {
      if (!focusSnap.active || focusSnap.mode === 'done') return;
      e.preventDefault();
      toggleFocusPause();
      return;
    }
    if (mod || e.altKey) return; // 其余组合留给系统 / 菜单加速键
    if (typing) return;

    if (key === 'ArrowDown') { e.preventDefault(); moveKbSelection(1); return; }
    if (key === 'ArrowUp') { e.preventDefault(); moveKbSelection(-1); return; }
    if (key === ' ' || key === 'Spacebar') {
      if (!kbSelectedId) return;
      e.preventDefault();
      toggleTask(kbSelectedId);
      return;
    }
    if (key === 'Enter') {
      // 焦点在按钮 / 链接上时，Enter 是"点它"，别抢
      const tag = e.target && e.target.tagName;
      if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return;
      if (!kbSelectedId) return;
      e.preventDefault();
      openDetail(kbSelectedId);
      return;
    }
    if (key === 'Delete') {
      if (!kbSelectedId) return;
      e.preventDefault();
      deleteTaskConfirm(kbSelectedId);
    }
  });
}

/** 切到笔记视图并新建一篇（菜单 / Ctrl+Shift+N 共用一条路径） */
async function openNewNote() {
  state.view = 'notes';
  renderSidebar();
  await render();
  await createNote();
}

/**
 * 切到笔记视图并走导入流程（设置中心「数据与备份 → 导入 Markdown 笔记」与
 * 主进程 ui:import-md 共用）。
 */
async function importMarkdownNotes() {
  state.view = 'notes';
  renderSidebar();
  await render();
  await importNotesFromDisk();
}

/**
 * 设置中心的动作分发 —— 原应用菜单（File / 实用工具 / 趣味功能）里的能力都从这里走。
 * 菜单栏已经整条撤掉（见 main.js buildAppMenu），实现不动，只换入口。
 * 'archive-done' 之外的动作为了避免两个 modal 叠在一起，会先把设置面板收起来。
 */
function runMenuAction(name) {
  const KEEP_SETTINGS_OPEN = new Set(['archive-done']);
  if (!KEEP_SETTINGS_OPEN.has(name)) {
    const closeBtn = document.querySelector('.modal-settings [data-modal="close"]');
    if (closeBtn) closeBtn.click();
  }
  switch (name) {
    case 'recurrence':
      openRecurrenceManager();
      return;
    case 'encourager':
      openEncourager({}).catch((e) => toast(`打开上班鼓励器失败：${(e && e.message) || e}`));
      return;
    case 'encourager-card':
      openEncourager({ tab: 'card' }).catch((e) => toast(`打开今日牛马卡失败：${(e && e.message) || e}`));
      return;
    case 'archive-done':
      archiveCompleted();
      return;
    case 'import-md':
      importMarkdownNotes().catch((e) => toast(`导入 Markdown 失败：${(e && e.message) || e}`));
      return;
    default:
      toast('未知动作');
  }
}

/**
 * 把主窗口当前选中的清单同步给主进程：
 * 从主窗口按 Ctrl+Alt+C 时，捕捉条要落到这个清单（设计里的落点规则 2）。
 */
function syncCaptureContext() {
  const raw = state.currentGroup;
  const gid = raw === 'all' || raw == null ? null : Number(raw);
  const val = Number.isFinite(gid) && gid > 0 ? gid : null;
  if (val === lastSentContext) return;
  lastSentContext = val;
  try { api.capture.setContext(val).catch(() => {}); } catch (e) { /* 捕捉条不可用时忽略 */ }
}

/* ---------------- 番茄钟（专注计时） ---------------- */

/** 当前视图是否会展示任务列表（消费分组/标签筛选） */
function isTaskView() {
  return TASK_VIEWS.includes(state.view);
}

/** 订阅主进程计时状态 + 初始快照 + 本地 500ms 重算（进度环/剩余时间） */
function initFocus() {
  api.on('focus:changed', (s) => {
    if (!s) return;
    if (s.notice) toast(s.notice);
    focusSnap = s;
    if (isTaskView()) renderTasks();
  });
  api.focus.state().then((s) => {
    if (!s) return;
    if (s.notice) toast(s.notice);
    focusSnap = s;
    if (isTaskView()) renderTasks();
  }).catch(() => {});
  // 本地 500ms：只重算进度环 / 剩余时间，不整表重绘（避免打断收尾条输入）
  setInterval(tickFocusDisplay, 500);
}

/** 剩余毫秒（按 wall clock：段起点 + 当前时间；running 永远推进，不因失焦冻结） */
function focusRemainMs() {
  if (!focusSnap.active) return 0;
  if (focusSnap.mode === 'running') {
    return Math.max(0, focusSnap.plannedSec * 1000 - focusSnap.focusedMs - (Date.now() - focusSnap.segStart));
  }
  return Math.max(0, focusSnap.plannedSec * 1000 - focusSnap.focusedMs);
}

/** mm:ss 显示 */
function fmtRemain(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 时长标签：25' / 15' / 45' */
function focusDurLabel() {
  return `${Math.round(focusDurationSec / 60)}'`;
}

/** 等效格数（full=1，partial=0.5），用于顶栏与行内「N 格」 */
function focusEquivalent(c) {
  if (!c) return 0;
  return c.full + 0.5 * (c.partial || 0);
}

/** 格数标记 ●●◐ +「+N」；无格数时返回空串 */
function focusDotsHtml(taskId) {
  const c = focusCounts[taskId];
  const total = c ? c.full + c.partial : 0;
  if (!total) return '';
  const eq = focusEquivalent(c);
  const marks = [];
  for (let i = 0; i < c.full; i++) marks.push('full');
  for (let i = 0; i < c.partial; i++) marks.push('half');
  const shown = marks.slice(0, 3);
  let html = `<span class="focus-dots" title="已推进 ${eq} 格（${c.full} 整格 + ${c.partial} 半格）">`;
  for (const m of shown) html += `<span class="dot-${m}">${m === 'full' ? '●' : '◐'}</span>`;
  if (total > 3) html += `<span class="dot-more">+${total - 3}</span>`;
  html += '</span>';
  return html;
}

/** 进度环（14px SVG）。点击暂停/继续 */
function focusRingHtml() {
  const C = 2 * Math.PI * 5; // r = 5
  const remain = focusRemainMs();
  const progress = focusSnap.plannedSec > 0
    ? Math.max(0, Math.min(1, (focusSnap.plannedSec * 1000 - remain) / (focusSnap.plannedSec * 1000)))
    : 0;
  return `<span class="focus-ring" data-act="focus-pause" title="暂停 / 继续（Ctrl+Enter）">
    <svg width="14" height="14" viewBox="0 0 14 14">
      <circle class="fr-bg" cx="7" cy="7" r="5"></circle>
      <circle class="fr-fg" cx="7" cy="7" r="5"
        stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - progress)}"></circle>
    </svg>
  </span>`;
}

/** 专注态右侧状态：剩余时间 + 结束按钮（常显） */
function focusStatusHtml() {
  return `<span class="focus-status">
    <span class="focus-remain">${fmtRemain(focusRemainMs())}</span>
    <button class="focus-end" data-act="focus-end" title="结束专注（不足 8 分钟不记录）">结束</button>
  </span>`;
}

/** 收尾条：内联展开在刚结束的番茄所属任务行下方 */
function focusWrapupHtml() {
  const isFull = focusSnap.pendingOutcome === 'full';
  const mark = isFull ? '●' : '◐';
  const cls = isFull ? 'fw-full' : 'fw-half';
  const mins = Math.round(focusSnap.plannedSec / 60);
  const title = isFull
    ? `这一格 ${mins} 分钟`
    : (focusSnap.pendingReason || '被打断');
  const hint = focusHintHtml();
  return `<li class="focus-wrapup" data-focus-wrapup>
    <div class="focus-wrapup-inner">
      <div class="fw-head"><span class="fw-mark ${cls}">${mark}</span><span>${esc(title)}</span></div>
      <input class="fw-input" type="text" placeholder="做到哪了？（回车 = 今天到这，Esc = 跳过）" maxlength="500" />
      ${hint}
      <div class="fw-actions">
        <button class="fw-again" data-act="fw-again">再来一格</button>
        <button data-act="fw-done">今天到这</button>
        <span class="fw-spacer"></span>
        <button class="fw-skip" data-act="fw-skip">跳过</button>
      </div>
    </div>
  </li>`;
}

/** 连续专注软提示（方案 §创意5）：3 格 = 90 分钟 / ≥4 格各一句 */
function focusHintHtml() {
  if (focusConsecutive === 3) return '<div class="fw-hint">已经连续 90 分钟了，起来走两步？</div>';
  if (focusConsecutive >= 4) return '<div class="fw-hint">连着 4 格了。要不要换个任务，让脑子转个方向？</div>';
  return '';
}

/** 本地 500ms 重算：只更新进度环 stroke 与剩余时间文本，不整表重绘 */
function tickFocusDisplay() {
  if (!focusSnap.active || focusSnap.mode === 'done' || !isTaskView()) return;
  const row = document.querySelector(`.task-item[data-id="${focusSnap.taskId}"]`);
  if (!row) return;
  const remainEl = row.querySelector('.focus-remain');
  if (remainEl) remainEl.textContent = fmtRemain(focusRemainMs());
  const fg = row.querySelector('.focus-ring .fr-fg');
  if (fg) {
    const C = 2 * Math.PI * 5;
    const remain = focusRemainMs();
    const progress = focusSnap.plannedSec > 0
      ? Math.max(0, Math.min(1, (focusSnap.plannedSec * 1000 - remain) / (focusSnap.plannedSec * 1000)))
      : 0;
    fg.setAttribute('stroke-dashoffset', String(C * (1 - progress)));
  }
}

/** 更新顶栏「今天 N 格」 */
function updateTopbarFocusCount() {
  const el = document.getElementById('topbar-focus-count');
  if (!el) return;
  const eq = focusToday;
  el.textContent = eq > 0 ? `今天 ${eq} 格` : '';
}

/** 开钟（▶）：用当前记忆的时长开始专注该任务 */
async function startFocus(taskId) {
  try {
    await api.focus.start({ taskId, plannedSec: focusDurationSec });
  } catch (e) {
    toast(`开始专注失败：${e && e.message ? e.message : e}`);
  }
}

/** 暂停 / 继续（点进度环或 Ctrl+Enter） */
async function toggleFocusPause() {
  try { await api.focus.togglePause(); } catch (e) {
    toast(`操作失败：${e && e.message ? e.message : e}`);
  }
}

/** 手动结束：≥8 分钟记半格，<8 分钟不记录 */
async function endFocus() {
  try {
    const r = await api.focus.manualEnd();
    if (r && r.outcome === 'cancel') toast('不足 8 分钟，未记录');
  } catch (e) {
    toast(`结束失败：${e && e.message ? e.message : e}`);
  }
}

/** 收尾条结算：again = 再来一格（结算后立即同任务重开）；skipNote = 跳过（不写那句） */
async function settleWrapup(again, skipNote = false) {
  const input = document.querySelector('.fw-input');
  const note = skipNote ? '' : ((input && input.value ? input.value : '').trim());
  const outcome = focusSnap.pendingOutcome || 'full';
  const taskId = focusSnap.taskId;
  try {
    await api.focus.settle(outcome, note);
    if (again && taskId != null) {
      await api.focus.start({ taskId, plannedSec: focusDurationSec });
    }
  } catch (e) {
    toast(`保存失败：${e && e.message ? e.message : e}`);
  }
}

/** 切换时长（15' → 25' → 45'），记住上次选择 */
function cycleFocusDuration() {
  const i = FOCUS_DURATIONS.indexOf(focusDurationSec);
  focusDurationSec = FOCUS_DURATIONS[(i + 1 + FOCUS_DURATIONS.length) % FOCUS_DURATIONS.length];
  localStorage.setItem('knodo.focusDurationSec', String(focusDurationSec));
  document.querySelectorAll('.focus-dur').forEach((el) => { el.textContent = focusDurLabel(); });
  document.querySelectorAll('[data-act="focus-start"]').forEach((b) => {
    b.title = `开始专注（${Math.round(focusDurationSec / 60)} 分钟）`;
  });
}

/* ---------------- 任务列表 ---------------- */

function hasTimeFilter() {
  const tf = state.timeFilters;
  return !!(tf.planStartFrom || tf.planStartTo || tf.planEndFrom || tf.planEndTo || tf.completedFrom || tf.completedTo);
}

async function renderTasks() {
  // #view 是共享容器：日历态下任何误调（应用内快捷键、外部刷新）都不能把日历整块冲成列表
  if (state.view === 'calendar') { await renderCalendar(); return; }
  // 统计 / AI 报告 / 检索 / 会议 / 笔记同样共用 #view：后台回调里的误调不能把当前视图
  // 整块换成任务列表。想展示任务列表的入口都必须先改 state.view（ensureTaskView 等）再刷。
  if (!TASK_VIEWS.includes(state.view)) return;
  const tasks = await loadTasks();
  // 重复规则摘要（任务行徽标的 title / 习惯图标）；一次批量查询，规则数量很小
  recurringRules = api.recurrences ? await api.recurrences.list().catch(() => []) : [];
  recurringRuleMap = new Map(recurringRules.map((r) => [Number(r.id), r]));
  // 展开的子节点可能被当前视图 / 筛选条件过滤掉（例如「今天」视图要求 plan_end <= 今天，
  // 而子任务往往没有日期）。为保证"点得开、看得见"，显式补拉已展开任务的子任务。
  await withExpandedChildren(tasks);
  // 关联笔记 / 番茄格数：一次批量查询（避免每行一次 IPC）。
  // 「今天不发生」那几条不在 tasks 里，也要一起查，否则它们的角标会缺。
  const allIds = tasks.map((t) => t.id).concat(state.recurringPending.map((t) => t.id));
  noteCounts = await api.taskNotes.counts(allIds).catch(() => ({}));
  // 番茄格数 + 今日格数：同样批量拉取
  focusCounts = await api.focus.counts(allIds).catch(() => ({}));
  focusToday = await api.focus.today().catch(() => 0);
  // 收尾态下的连续专注格数（含当前这一格）：软提示用，只在该任务的番茄刚结束时算
  focusConsecutive = 0;
  if (focusSnap.mode === 'done' && focusSnap.taskId != null) {
    const tl = await api.focus.timeline(focusSnap.taskId).catch(() => []);
    let c = 0;
    for (const s of tl) { if (s.outcome === 'full') c += 1; else break; }
    focusConsecutive = c + 1;
  }
  const viewEl = document.getElementById('view');
  const isArchived = state.view === 'archived';
  const hasFilters = state.currentGroup !== 'all' || !!state.search || state.priorityFilter !== 'all' || hasTimeFilter();
  // 「今天」里刚勾选完成、仍留在列表中的任务数量
  const keptCount = state.view === 'today' ? state.recentlyDone.size : 0;

  let html = '';

  if (keptCount) {
    html += `<div class="keep-done-bar">
      <span class="keep-done-text">✅ 今日已完成 <b>${keptCount}</b> 个任务，已保留在列表中（打勾 / 置灰 / 删除线）</span>
      <button class="link-btn" data-act="hide-done" title="立即移出列表（切换视图或重启后仍会保留，跨天自动清空）">隐藏已完成</button>
    </div>`;
  }

  if (tasks.length === 0) {
    const emptyText = isArchived
      ? '还没有归档的任务'
      : '暂无符合条件的任务';
    html += `<div class="empty"><span class="big">🎉</span>${esc(emptyText)}</div>`;
  } else if (isArchived || hasFilters) {
    html += buildTaskList(flattenTree(tasks));
  } else {
    // 未筛选时按分组分组展示（组内父子任务树形展开）
    // 以"最顶层祖先"的分组归组：补拉进来的子任务即使 group_id 与父任务不同，也跟着父任务走
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const topGroup = (t) => {
      let cur = t;
      for (let i = 0; i < 20 && cur.parent_id && byId.has(cur.parent_id); i++) cur = byId.get(cur.parent_id);
      return cur.group_id || null;
    };
    const grouped = groupBy(tasks, topGroup);
    for (const [gid, items] of grouped) {
      const g = state.groups.find((x) => x.id === gid);
      const gName = g ? g.name : '未分组';
      const gColor = g ? g.color : '#c3cad6';
      const key = taskGroupKey(gid);
      const collapsed = state.collapsedTaskGroups.has(key);
      // 分组头本身就是折叠开关：点一下展开 / 收起，状态按分组独立记忆
      html += `<button type="button" class="task-group-head${collapsed ? ' is-collapsed' : ''}" data-act="toggle-task-group"
        data-group="${esc(key)}" aria-expanded="${!collapsed}"
        title="${collapsed ? '展开' : '收起'}「${esc(gName)}」的 ${items.length} 个任务">
        <span class="group-toggle">${collapsed ? '▸' : '▾'}</span>
        <span class="g-dot" style="background:${esc(gColor)}"></span>
        <span class="tg-name">${esc(gName)}</span>
        <span class="tg-count">${items.length}</span>
      </button>`;
      if (!collapsed) html += buildTaskList(flattenTree(items));
    }
  }

  // 「今天」视图：今天不发生的重复事项单独收在可折叠区里（默认收起）。
  // 按「每个法定工作日」的规则一到周末就没有发生日，任务会同时从「今天」和「即将到期」消失，
  // 一句话都不说；这里给一条可展开的说明，顺带标出下次是几号（P-08 / P-09）。
  if (state.view === 'today' && state.recurringPending.length) {
    html += pendingRecurringHtml();
  }

  // 列表底部：就地新增入口 / 新建编辑行（归档视图不提供新增）。
  // 新建时编辑行**就长在最后一条任务下面**（不是固定的底部面板）：用户要的是
  // 「在列表末尾接着写」，滚动交给 focusEditor → revealEditor，视口不整体跳。
  if (!isArchived) {
    html += state.addingTask ? newEditorHtml() : addRowHtml();
  }

  // 编辑器被整块替换前先回收它的自动保存器：换 innerHTML 不会取消已排队的防抖计时器，
  // 旧保存器会拿着已销毁的 DOM 继续写库（可能把别的任务刚改过的值覆盖回去）。
  disposeEditorSavers(viewEl);
  // 直接调 renderTasks()（不经 render()）时也要回收编辑器里的 Tom Select 实例
  destroyGroupSelectsIn(viewEl);

  viewEl.innerHTML = html;
  const pendToggle = viewEl.querySelector('[data-act="toggle-recur-pending"]');
  if (pendToggle) {
    pendToggle.addEventListener('click', () => {
      pendingRecurringOpen = !pendingRecurringOpen;
      renderTasks();
    });
  }
  const hideDoneBtn = viewEl.querySelector('[data-act="hide-done"]');
  if (hideDoneBtn) {
    hideDoneBtn.addEventListener('click', () => {
      clearRecentlyDone();
      renderTasks();
    });
  }
  bindTaskListEvents(viewEl);
  bindEditorEvents(viewEl);
  if (state.addingTask || state.editingTaskId != null) focusEditor();
  // 收尾条输入框自动聚焦（RK-01：自动聚焦但可一键跳过）
  if (focusSnap.mode === 'done') {
    const wi = viewEl.querySelector('.fw-input');
    if (wi) wi.focus();
  }
  // 键盘选中的行在整表重绘后要接着亮着（否则按一下 ↓ 才有反馈，中间那一下看着像没反应）
  paintKbSelection();
  // 顶栏「今天 N 格」
  updateTopbarFocusCount();
  // 当前清单同步给主进程：捕捉条从主窗口按 C 时落到这里
  syncCaptureContext();
  // 「用了 N 天了」：只在今天真正清空时问一次，天数与去重都在主进程判定
  maybeAskSponsor(tasks);
}

/**
 * 「用了 N 天了」的一次性提示。
 *
 * 三个条件都满足才叫主进程：
 *   1. 在「今天」视图 —— 别的视图的"全部完成"不算数
 *   2. 今天确实勾过东西 —— 空列表不是"清空"
 *   3. 列表里没有未完成的 —— 真做完了
 *
 * 天数够不够、是不是已经问过，由 app:sponsorPrompt 判断。
 * 这里任何异常都吞掉：一个可选提示不值得打断任何一次渲染。
 */
let sponsorAsking = false;
async function maybeAskSponsor(tasks) {
  if (sponsorAsking || state.view !== 'today') return;
  if (!tasks.length || !state.recentlyDone.size) return;
  if (tasks.some((t) => !t.completed)) return;
  sponsorAsking = true;
  try {
    const r = await api.app.sponsorPrompt();
    if (r && r.show) openSponsorAsk(r.days);
  } catch (_e) {
    /* 静默 */
  } finally {
    sponsorAsking = false;
  }
}

/**
 * 回收视图内就地编辑器的自动保存器（先 flush 落库，再 dispose 取消计时器）。
 * 与详情抽屉同一套规则：只换 innerHTML 不等于保存器消失。
 */
function disposeEditorSavers(root) {
  root.querySelectorAll('.task-editor').forEach((ed) => {
    const saver = ed && ed.__autoSave;
    if (!saver) return;
    try {
      const p = saver.flush();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_e) { /* 回收阶段不抛错 */ }
    try { saver.dispose(); } catch (_e) { /* 同上 */ }
  });
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/**
 * 补齐已展开任务的子任务。
 * 视图筛选（今天 / 即将到期 / 优先级 / 分组 / 搜索）会把不满足条件的子任务过滤掉，
 * 导致父任务虽然显示"有子任务"的箭头，点开却什么都没有。这里对被标记为展开的任务
 * 单独拉取子任务并合并进列表（递归处理多层嵌套）。
 */
async function withExpandedChildren(tasks) {
  if (!state.expandedTasks.size) return tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const queue = [...state.expandedTasks].filter((id) => byId.has(id));
  const seen = new Set(queue);

  while (queue.length) {
    const parentId = queue.shift();
    const kids = await api.tasks.subtasks(parentId).catch((e) => {
      console.warn('[ui] 拉取子任务失败', e && e.message);
      return [];
    });
    for (const k of kids) {
      if (!byId.has(k.id)) {
        byId.set(k.id, k);
        tasks.push(k);
      }
      // 该子任务自身也处于展开状态 → 继续向下补
      if (state.expandedTasks.has(k.id) && !seen.has(k.id)) {
        seen.add(k.id);
        queue.push(k.id);
      }
    }
  }
  return tasks;
}

/**
 * 「今天不发生」的重复事项（暂停 / 已结束 / 下次在未来）：默认收起的一条说明区。
 * 行内用任务行同一套渲染，但完成按钮禁用 —— 今天不是发生日，勾了会记成下一次的打卡。
 */
function pendingRecurringHtml() {
  const items = state.recurringPending;
  const open = pendingRecurringOpen;
  // 这些行不在 state.tasks 里，buildTaskList 管不到；就地编辑要在这里单独接上，
  // 否则点「✎ 编辑」只会把 editingTaskId 设上却不出现编辑器（看着像没反应）
  const rows = items.map((t) => (state.editingTaskId === t.id
    ? editEditorHtml(t)
    : taskItemHtml(t, 0, true, { pending: true }))).join('');
  return `<div class="recur-pending">
    <button type="button" class="task-group-head recur-pending-head${open ? '' : ' is-collapsed'}"
      data-act="toggle-recur-pending" aria-expanded="${open}"
      title="${open ? '收起' : '展开'}这 ${items.length} 条今天不发生的重复事项">
      <span class="group-toggle">${open ? '▾' : '▸'}</span>
      <span class="tg-name">今天不发生</span>
      <span class="tg-count">${items.length}</span>
      <span class="recur-pending-hint">按重复规则今天没有发生 · 点开看下次是几号</span>
    </button>
    ${open ? `<ul class="task-list is-pending">${rows}</ul>` : ''}
  </div>`;
}

/** 任务排序：与主列表 SQL 一致（未完成 → 有截止日期 → 截止日期 → 优先级降序 → 手动排序 → id） */
function compareTasks(a, b) {
  // 手动排序：sort_order 优先，与 main/db.js 里 f.sort === 'manual' 的 ORDER BY 保持一致
  if (state.sortMode === 'manual') {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.id - b.id;
  }
  if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
  const aNull = a.plan_end == null;
  const bNull = b.plan_end == null;
  if (aNull !== bNull) return aNull ? 1 : -1; // 无截止日期的排后面
  if (!aNull && a.plan_end !== b.plan_end) return a.plan_end < b.plan_end ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority; // 优先级高的在前
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.id - b.id;
}

/**
 * 将任务数组组织为树并按“父任务→子任务（缩进）”展平。
 * 注意：父任务被筛选掉时子任务仍会作为一个 roots 渲染（只是缩进 0、没有父行），
 * 所以节点上额外带一个 parentVisible 标记，供行内决定父任务提示是"纯标识"还是"可点链接"。
 */
function flattenTree(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map();
  const roots = [];
  for (const t of tasks) {
    if (t.parent_id && byId.has(t.parent_id)) {
      if (!children.has(t.parent_id)) children.set(t.parent_id, []);
      children.get(t.parent_id).push(t);
    } else {
      roots.push(t);
    }
  }
  const result = [];
  const walk = (t, depth, parentVisible) => {
    result.push({ task: t, depth, parentVisible });
    // 默认收缩：仅在展开时递归渲染子任务
    if (!state.expandedTasks.has(t.id)) return;
    const kids = (children.get(t.id) || []).sort(compareTasks);
    for (const k of kids) walk(k, depth + 1, true);
  };
  // 没有父任务（或父任务不在本列表里）的节点：parentVisible 只对"有父 id 但父行缺失"的节点有意义
  for (const r of roots) walk(r, 0, !r.parent_id);
  return result;
}

function buildTaskList(nodes) {
  const items = [];
  for (const { task: t, depth, parentVisible } of nodes) {
    items.push(state.editingTaskId === t.id
      ? editEditorHtml(t)
      : taskItemHtml(t, depth, parentVisible));
    // 收尾条：内联展开在刚结束的番茄所属任务行下方
    if (focusSnap.mode === 'done' && focusSnap.taskId === t.id) {
      items.push(focusWrapupHtml());
    }
  }
  return `<ul class="task-list">${items.join('')}</ul>`;
}

/** 分组 id → 完整路径（"工作 / 前端"）；找不到时回退为空串 */
function groupPathAt(id) {
  const g = state.groups.find((x) => x.id === id);
  return g ? groupPath(g, state.groups) : '';
}

/**
 * 备注转纯文本：列表行与行内编辑器都只该看到「话」，不该看到标签和图片。
 * 图片（含 base64 data URI）会被整块吃掉并计数 —— 一串 `data:image/png;base64,iVBOR…`
 * 足以把整行撑爆，而它对读者没有任何信息量。
 */
function notesToPlain(raw) {
  const src = String(raw || '');
  if (!src.trim()) return { text: '', images: 0 };
  let images = 0;
  let s = src
    .replace(/<img\b[^>]*>/gi, () => { images += 1; return ' '; })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, () => { images += 1; return ' '; })
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  // 旧数据可能残留裸 data URI（没被 <img> 包住），同样不能漏到界面上
  if (s.includes('data:image/')) s = s.replace(/data:image\/[^\s"')]+/gi, ' ');
  return { text: s.replace(/\s+/g, ' ').trim(), images };
}

const NOTE_SUMMARY_MAX = 72;

/** 列表行备注摘要：单行、限长；只有图片时只说「图片」 */
function noteSummaryHtml(t) {
  const { text, images } = notesToPlain(t.notes);
  if (!text && !images) return '';
  const clipped = text.length > NOTE_SUMMARY_MAX ? `${text.slice(0, NOTE_SUMMARY_MAX)}…` : text;
  const img = images ? `<span class="note-img-badge" title="备注含 ${images} 张图片">📷${images > 1 ? images : ''}</span>` : '';
  const tip = text ? `${text.length > 400 ? `${text.slice(0, 400)}…` : text}` : '备注里只有图片';
  return `<div class="task-note" title="${esc(tip)}">${img}<span class="task-note-text">${esc(clipped || '图片备注')}</span></div>`;
}

/** 重复事项徽标：只有一条任务，点开可改规则 / 停止 / 看打卡；习惯模式用 💪 区分 */
function recurBadgeHtml(t) {
  if (t.recurring_id == null) return '';
  const r = recurringRuleMap.get(Number(t.recurring_id));
  const label = r ? `${r.title}｜${r.summary || ''}` : '重复事项';
  const ico = r && r.habit ? '💪' : '🔁';
  const cls = ['recur-badge', r && r.habit ? 'is-habit' : '', t.completed ? 'is-done' : ''].filter(Boolean).join(' ');
  const tip = `${label}｜累计打卡 ${r ? r.done_count : 0} 次${r && r.todayDone ? '（今日已完成）' : ''}｜点击改规则 / 看记录`;
  return `<button type="button" class="${cls}" data-act="open-recur"
    data-rule-id="${Number(t.recurring_id)}" title="${esc(tip)}"
    >${ico}</button>`;
}

function taskItemHtml(t, depth = 0, parentVisible = true, opts = {}) {
  const done = t.completed ? ' done' : '';
  // 注意：判断"是不是子任务"必须看 t.parent_id，不能看 depth。
  // 父任务被筛选掉时，子任务会作为 roots 渲染、depth = 0，但它依然是子任务。
  const isSub = t.parent_id != null;
  const isOverdue = !t.completed && t.plan_end && t.plan_end < todayStr();
  // 重复事项：日期是规则派生的「本次 / 截止」。pending = 「今天不发生」说明区里的行
  const recurRule = t.recurring_id != null ? recurringRuleMap.get(Number(t.recurring_id)) : null;
  const isRecur = t.recurring_id != null;
  const pendingRow = !!opts.pending;
  // 该任务是否正在专注（running / paused；done 态走收尾条）
  const isFocusing = focusSnap.active && focusSnap.taskId === t.id
    && (focusSnap.mode === 'running' || focusSnap.mode === 'paused');
  const isPaused = isFocusing && focusSnap.mode === 'paused';
  const meta = [];
  // 父任务提示：
  //  - 父任务就在上面（parentVisible）→ 缩进已说明层级，这里只给纯标识；
  //  - 父任务不在当前列表（被视图 / 筛选过滤掉了）→ 做成链接，标注"父任务："并可直接点开，
  //    否则只看到一个"↳ 某标题"，既点不动也不知道它在哪儿。
  if (isSub && t.parent_title) {
    meta.push(parentVisible
      ? `<span class="meta-item parent-tag" title="父任务：${esc(t.parent_title)}">↳ ${esc(t.parent_title)}</span>`
      : `<span class="meta-item parent-tag parent-link" role="link" tabindex="0"
           data-act="goto-parent" data-parent="${t.parent_id}"
           title="父任务不在当前列表，点击打开：${esc(t.parent_title)}">↳ 父任务：${esc(t.parent_title)}</span>`);
  }
  meta.push(`<span class="pri-badge pri-${t.priority}">${PRIORITY_TEXT[t.priority]}</span>`);
  if (isRecur) {
    // 重复事项：plan_start 是「本次发生日」、plan_end 是「截止日」，直接当普通计划时间展示
    // 会让人以为任务排到了未来几天。这里换成语义明确的写法（P-05）：
    // 今天就是发生日 → 「本次 + 截止」；今天不是 → 只留状态角标（下次是几号由它来说）。
    const st = recurState(t, recurRule);
    if (st.state === 'today') {
      meta.push(`<span class="meta-item recur-on">🔁 本次 ${esc(t.occurrence_date.slice(5))}</span>`);
      if (t.plan_end && t.plan_end !== t.occurrence_date) {
        meta.push(`<span class="meta-item due ${isOverdue ? 'overdue' : ''}">⏰ 截止 ${esc(t.plan_end.slice(5))}</span>`);
      }
    } else {
      const stateBadge = recurStateBadgeHtml(t, recurRule);
      if (stateBadge) meta.push(stateBadge);
    }
  } else {
    if (t.plan_start) meta.push(`<span class="meta-item">🗓 ${esc(t.plan_start)}</span>`);
    if (t.plan_end) meta.push(`<span class="meta-item due ${isOverdue ? 'overdue' : ''}">📅 ${esc(t.plan_end)}</span>`);
  }
  // 子任务进度不放 meta 行了：跟标题同一行、紧挨着标题右侧，扫一眼就知道这个任务拆了几条
  if (t.completed && t.completed_at) meta.push(`<span class="meta-item done-at">✅ 完成于 ${fmtDateTime(t.completed_at)}</span>`);
  if (t.reminder_at && !isRecur) meta.push(`<span class="meta-item">🔔 ${fmtDateTime(t.reminder_at)}</span>`);
  // 创建时间：行内只放日期（完整时间走 title），避免把 meta 行撑得太长
  if (t.created_at) meta.push(`<span class="meta-item created-at" title="创建于 ${esc(fmtDateTime(t.created_at))}">🕒 ${esc(t.created_at.slice(0, 10))}</span>`);
  for (const n of t.tag_names) meta.push(`<span class="tag-chip">${esc(n)}</span>`);
  // 附件角标：列表里就能看出这条任务带了文件，不用点进详情
  const attCount = Array.isArray(t.attachments) ? t.attachments.length : 0;
  if (attCount) meta.push(`<span class="meta-item att-badge" title="附件 ${attCount} 个">📎 ${attCount}</span>`);
  // 关联笔记角标：列表里就能看出这条任务引用了几篇笔记（数量由 renderTasks 一次批量拉取）
  const noteCount = Number(noteCounts[t.id]) || 0;
  if (noteCount) meta.push(`<span class="meta-item note-badge" title="关联笔记 ${noteCount} 篇">📝 ${noteCount}</span>`);
  // 分组标签显示完整路径（"工作 / 前端"），否则同名子分组看不出归属
  const groupLabel = t.group_name
    ? `<span class="meta-item group-tag" style="color:${esc(t.group_color)}" title="${esc(groupPathAt(t.group_id))}">● ${esc(groupPathAt(t.group_id))}</span>`
    : '';

  return `
  <li class="task-item${done}${isSub ? ' is-subtask' : ''}${isFocusing ? ' is-focus' : ''}${isPaused ? ' is-paused' : ''}${pendingRow ? ' is-recur-pending' : ''}" draggable="false" data-id="${t.id}" style="margin-left:${depth * 20}px">
    <span class="task-gutter">${isSub ? '' : '<span class="drag-handle" data-act="drag" title="按住拖拽调整顺序">⠿</span>'}</span>
    <!-- 展开箭头固定在完成按钮左侧，两者成组、间距固定；无子任务时槽位仍占同宽，
         这样每一行的完成按钮都落在同一条竖线上 -->
    <span class="task-leading">
      <span class="task-expand-slot">${!pendingRow && t.subtask_count > 0 ? `<button class="task-expand" data-act="toggle-expand" aria-expanded="${state.expandedTasks.has(t.id)}" title="${state.expandedTasks.has(t.id) ? '收起子任务' : '展开子任务'}">${state.expandedTasks.has(t.id) ? '▾' : '▸'}</button>` : ''}</span>
      ${isFocusing ? focusRingHtml() : ''}
      ${pendingRow
    ? `<button class="task-check" disabled title="今天不是发生日，不能打卡">${t.completed ? '✓' : ''}</button>`
    : `<button class="task-check" data-act="toggle" title="完成/取消">${t.completed ? '✓' : ''}</button>`}
    </span>
    <div class="task-body">
      <div class="task-title">
        <span class="task-title-text" data-act="rename" title="点击直接修改标题">${esc(t.title)}</span>
        ${t.subtask_count > 0
    ? `<span class="task-subtask-badge" title="子任务进度：已完成 ${t.subtask_done} / 共 ${t.subtask_count}"
         aria-label="子任务 ${t.subtask_done}/${t.subtask_count}">☑ ${t.subtask_done}/${t.subtask_count}</span>`
    : ''}
        ${focusDotsHtml(t.id)}
        ${recurBadgeHtml(t)}
      </div>
      <div class="task-meta">${groupLabel}${meta.join('')}</div>
      ${noteSummaryHtml(t)}
    </div>
    ${isFocusing ? focusStatusHtml() : ''}
    <div class="task-actions">
      ${isFocusing ? '' : `<span class="focus-start">
        <button class="focus-btn" data-act="focus-start" title="开始专注（${Math.round(focusDurationSec / 60)} 分钟）">▶</button>
        <button class="focus-dur" data-act="focus-duration" title="切换专注时长（15 / 30 / 45 分钟）">${focusDurLabel()}</button>
      </span>`}
      <button data-act="edit" title="编辑">✎ 编辑</button>
      ${state.view === 'archived'
        ? `<button data-act="unarchive" title="恢复">↩ 恢复</button>`
        : `<button data-act="archive" title="归档">🗂 归档</button>`}
      <button class="del" data-act="del" title="删除">🗑 删除</button>
    </div>
  </li>`;
}

/**
 * 打开父任务。
 * 列表里的父任务链接（.parent-link）用的是 span[role=link]：既能点，也能聚焦后回车/空格触发，
 * 键盘用户不至于"看得见点不动"。这里统一收口一次键盘处理。
 */
function openParentTask(parentId) {
  if (!Number.isFinite(parentId) || parentId <= 0) return;
  openDetail(parentId);
}

function bindTaskListEvents(container) {
  container.querySelectorAll('.task-item:not(.editing)').forEach((item) => {
    item.addEventListener('keydown', (e) => {
      const link = e.target.closest && e.target.closest('[data-act="goto-parent"]');
      if (!link) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      openParentTask(Number(link.dataset.parent));
    });
    item.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      // 子任务行嵌在父行 <li> 内部，点击会冒泡到父行；按「事件所属的那一行」取 id，
      // 否则在子任务的按钮上点击会作用到父任务（例如把父任务的展开态翻回去）。
      const owner = (btn && btn.closest('.task-item[data-id]')) || item;
      const id = Number(owner.dataset.id);
      if (!btn) { openDetail(id); return; }
      const act = btn.dataset.act;
      if (act === 'drag') return; // 拖拽手柄：不触发打开详情
      if (act === 'toggle') toggleTask(id);
      else if (act === 'toggle-expand') {
        if (state.expandedTasks.has(id)) state.expandedTasks.delete(id);
        else state.expandedTasks.add(id);
        renderTasks();
      }
      else if (act === 'rename') startInlineRename(btn, id);
      else if (act === 'goto-parent') openParentTask(Number(btn.dataset.parent));
      else if (act === 'edit') startEdit(id);
      else if (act === 'del') deleteTaskConfirm(id);
      else if (act === 'archive') archiveTask(id);
      else if (act === 'unarchive') unarchiveTask(id);
      else if (act === 'focus-start') startFocus(id);
      else if (act === 'focus-duration') cycleFocusDuration();
      else if (act === 'focus-pause') toggleFocusPause();
      else if (act === 'focus-end') endFocus();
      else if (act === 'open-recur') openRuleFromTask(Number(btn.dataset.ruleId));
    });
    bindDrag(item);
  });

  // 收尾条：按钮 + 输入框（回车 = 今天到这，Esc = 跳过）
  container.querySelectorAll('.focus-wrapup').forEach((wrap) => {
    wrap.querySelectorAll('[data-act="fw-again"]').forEach((b) => b.addEventListener('click', () => settleWrapup(true)));
    wrap.querySelectorAll('[data-act="fw-done"]').forEach((b) => b.addEventListener('click', () => settleWrapup(false)));
    wrap.querySelectorAll('[data-act="fw-skip"]').forEach((b) => b.addEventListener('click', () => settleWrapup(false, true)));
    const input = wrap.querySelector('.fw-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); settleWrapup(false); }
        else if (e.key === 'Escape') { e.preventDefault(); settleWrapup(false, true); }
      });
    }
  });

  // 底部“添加任务”入口
  const addBtn = container.querySelector('[data-act="start-add"]');
  if (addBtn) addBtn.addEventListener('click', startAdd);

  // 分组头：各自独立展开 / 收起（状态写回 settings，重启后保持）
  container.querySelectorAll('[data-act="toggle-task-group"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleTaskGroup(btn.dataset.group);
      renderTasks();
    });
  });
}

/* ---------------- 行内改标题 ---------------- */

/**
 * 点击任务标题就地改名：只替换这一行的标题节点，不整表重绘（避免焦点丢失与列表闪动）。
 * 失焦或回车保存，Esc 放弃。
 * @param {HTMLElement} span .task-title-text 节点
 * @param {number} id 任务 id
 */
function startInlineRename(span, id) {
  if (!span || span.querySelector('input')) return; // 已在编辑中
  const original = span.textContent;
  const input = document.createElement('input');
  input.className = 'task-title-input';
  input.type = 'text';
  input.maxLength = 200;
  input.value = original;
  span.textContent = '';
  span.appendChild(input);
  span.classList.add('is-renaming');
  input.focus();
  input.select();

  /**
   * 宽度跟着内容走：短标题不留一大片空白，长标题横向撑开。
   * 上限取「标题行剩余空间」（扣掉展开箭头与子任务计数），保证既不换行也不压到别的元素。
   */
  const row = span.parentElement;
  const measure = document.createElement('canvas').getContext('2d');
  const autoSize = () => {
    const cs = getComputedStyle(input);
    measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const textW = measure.measureText(input.value || ' ').width;
    const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    let max = 520;
    if (row) {
      const siblings = [...row.children]
        .filter((el) => el !== span)
        .reduce((a, el) => a + el.getBoundingClientRect().width, 0);
      max = Math.max(80, row.getBoundingClientRect().width - siblings - 12);
    }
    input.style.width = `${Math.min(max, Math.max(80, Math.ceil(textW + chrome + 2)))}px`;
  };
  autoSize();
  input.addEventListener('input', autoSize);

  let settled = false;
  /** 收尾：commit=false 表示放弃 */
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    input.removeEventListener('input', autoSize);
    input.removeEventListener('blur', onBlur);
    span.classList.remove('is-renaming');
    const next = input.value.trim();
    const put = (text) => { span.textContent = text; };
    if (!commit || !next || next === original) { put(original); return; }
    put(next); // 先落地到界面，保存失败再回滚
    try {
      await api.tasks.update(id, { title: next });
      // 按 id 精确替换（不可变更新），不直接改 state 里的对象：
      // 列表数据与任何编辑态都不共用引用，改一个任务不可能带动另一个。
      const i = state.tasks.findIndex((x) => x.id === id);
      if (i > -1) state.tasks[i] = { ...state.tasks[i], title: next };
      toast('标题已保存');
    } catch (e) {
      put(original);
      toast(`保存失败：${e && e.message ? e.message : e}`);
    }
  };
  const onBlur = () => finish(true);
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

/* ---------------- 就地新增 / 编辑编辑器 ---------------- */


/**
 * 分组下拉换成与 AI 报告同款的 Tom Select（单选）。
 * 组件隐藏原始 select 但会同步它的 value，并派发原生 input / change 事件，
 * 所以 collectEditorPayload 的读取与编辑态自动保存都不用改。
 */
function initEditorGroupSelect(ed) {
  const sel = ed.querySelector('.editor-group');
  if (!sel) return;
  createGroupSelect(sel, { multiple: false });
}

/**
 * 优先级下拉：与分组同一个 Tom Select 组件、同一套 CSS（色点 + 圆角面板 + 自绘箭头）。
 * 之前它是原生 <select>，紧挨着分组控件却长着系统箭头和直角，并排看着像两个产品。
 * 组件会同步原始 select 的 value，collectEditorPayload 与自动保存都不用改。
 */
function initEditorPrioritySelect(ed) {
  const sel = ed.querySelector('.editor-priority');
  if (!sel) return;
  createPrioritySelect(sel);
}

/**
 * 编辑器内部结构（新增与编辑共用）。
 *
 * 主行：标题 → 优先级 → 分组 → 计划时间 →（删除 / 取消 / 保存）。
 * 优先级原来和提醒 / 标签 / 备注一起藏在「⚙ 更多」里，新建时等于默认看不到 ——
 * 它其实是填任务时最常改的字段之一，所以提到主行、紧跟标题（分组之前）；
 * 「更多」这个折叠开关随之撤掉，详情区（提醒 / 标签 / 备注 / 重复）**恒展开**：
 * 折叠省下的那点高度，换来的是「每次新建都要多点一下」。
 */
function taskEditorHtml(task) {
  const isEdit = !!task;
  const t = task || {};
  const showCompletedAt = isEdit && t.completed;
  // 优先级：新建默认「中」（与 priorityPickerOptionsHtml 的兜底一致）
  const priority = t.priority == null ? 1 : Number(t.priority);
  const defaultGroup = isEdit ? t.group_id : (state.currentGroup !== 'all' ? state.currentGroup : null);
  // 重复事项：计划日期 / 提醒由规则派生，编辑器里给只读展示，不留可编辑入口（P-01/P-02）
  const recurRule = isEdit && t.recurring_id != null
    ? recurringRuleMap.get(Number(t.recurring_id))
    : null;
  const derived = isEdit && t.recurring_id != null;
  // 计划日期：开始 / 完成合并为单一范围控件；新建任务的默认值由 NEW_TASK_RANGE_MODE 决定，
  // 但「今天」视图下默认填今天（否则新建的任务 plan_end 为空，根本不会出现在今天列表里）
  const rangeOpts = { required: PLAN_DATE_REQUIRED, placeholder: '计划开始 ~ 完成' };
  const newRangeMode = state.view === 'today' ? 'today' : NEW_TASK_RANGE_MODE;
  const range = isEdit ? { start: t.plan_start, end: t.plan_end } : defaultDateRange(newRangeMode);
  return `
  <div class="task-editor" data-editor="${isEdit ? t.id : 'new'}"${derived ? ' data-derived="1"' : ''}>
    <div class="editor-row">
      <input class="editor-title" type="text" placeholder="任务标题（回车保存，Esc 取消）" value="${esc(t.title || '')}" />
      <select class="editor-priority" data-pri="${priority}" title="优先级" aria-label="优先级">${priorityPickerOptionsHtml(t.priority)}</select>
      <select class="editor-group" title="分组" aria-label="分组">${groupPickerOptionsHtml(state.groups, defaultGroup)}</select>
      ${derived
    ? '<span class="editor-derived" title="重复事项的计划时间与提醒由规则派生，下方有只读明细；要改请改重复规则">🔁 按规则排期</span>'
    : dateRangeFieldHtml(range.start, range.end, rangeOpts)}
      ${isEdit ? '<button class="danger-btn" data-act="editor-delete" title="删除任务">删除</button>' : ''}
    </div>
    <div class="editor-details">
      ${derived ? '' : reminderHtml(t.reminder_at, t.plan_end)}
      <input class="editor-tags" type="text" placeholder="标签（逗号分隔）" value="${esc((t.tag_names || []).join(', '))}" />
      ${showCompletedAt ? `<input class="editor-completed-at" type="datetime-local" value="${isoToLocal(t.completed_at)}" title="实际完成时间" />` : ''}
      <!-- 取消 / 保存跟在「标签」右端（同一行）：主行留给标题 + 优先级 + 分组 + 计划时间，
           1080 宽的老窗口下标题才不会被挤成 190px；也不额外占一行高度。 -->
      <div class="editor-actions">
        ${isEdit ? '<span class="editor-save-state" hidden title="修改会自动保存"></span>' : ''}
        <button class="ghost-btn" data-act="editor-cancel">取消</button>
        <button class="primary-btn" data-act="editor-save">${isEdit ? '保存' : '添加'}</button>
      </div>
      <textarea class="editor-notes" rows="2" placeholder="备注">${esc(notesToPlain(t.notes).text)}</textarea>
    </div>
    ${repeatEditorHtml(t, recurRule)}
  </div>`;
}

/** 编辑已有任务：替换任务行 */
function editEditorHtml(t) {
  return `<li class="task-item editing" data-id="${t.id}">${taskEditorHtml(t)}</li>`;
}

/** 新增任务：编辑行本体（拼在列表末尾，替换掉「＋ 添加任务」那一行） */
function newEditorHtml() {
  return `<div class="task-editor-wrap is-new-editor">${taskEditorHtml(null)}</div>`;
}

function addRowHtml() {
  return `<div class="add-row"><button class="add-row-btn" data-act="start-add"><span class="add-plus">＋</span> 添加任务</button></div>`;
}

function bindEditorEvents(container) {
  container.querySelectorAll('.task-editor').forEach((ed) => {
    bindDateRangeFields(ed);
    bindReminder(ed);
    initEditorGroupSelect(ed);
    initEditorPrioritySelect(ed);
    // 优先级下拉在主行（标题右边、分组左边）：改值后同步 data-pri（原生降级态用它画色条）；
    // Tom Select 会派发原生 change，所以这一条在两种形态下都成立
    const priSel = ed.querySelector('.editor-priority');
    if (priSel) priSel.addEventListener('change', () => { priSel.dataset.pri = priSel.value; });
    bindRepeatEditor(ed, {
      onInput: () => {
        // 开启重复后，完成日与提醒改由规则接管；一次性字段只置灰、不隐藏
        // （隐藏会让用户以为刚填的日期/提醒丢了，校验也还要能读到值）。
        // 说明统一写在 .rpt-panel 顶部，不要在字段上挂溢出到控件外的提示文字。
        const on = isRepeatOn(ed);
        ed.querySelectorAll('.date-range-field, .reminder-field')
          .forEach((el) => el.classList.toggle('is-rpt-muted', on));
      },
    });
    // 范围变化（含清除）后同步提醒预设，避免出现“依赖完成日期却没有日期”的提醒
    ed.addEventListener(DATE_RANGE_EVENT, (e) => syncReminderWithPlanEnd(ed, e.detail.planEnd));
    // 编辑既有任务 → 开启即时持久化（新建任务在“添加”时创建，无 id 可写）
    if (ed.dataset.editor !== 'new') ed.__autoSave = bindEditorAutoSave(ed);
    const title = ed.querySelector('.editor-title');
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveEditor(ed); }
      else if (e.key === 'Escape') cancelEditor();
    });
    ed.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // 下拉（优先级 / 分组）展开时 Esc 只收起下拉，不能连带把整个任务编辑器关掉。
      // 主行现在有两个 Tom Select，必须逐个查 —— 只取第一个会漏掉分组那一个。
      const anyOpen = [...ed.querySelectorAll('.ts-wrapper')]
        .some((w) => w.classList.contains('dropdown-active'));
      if (anyOpen) return;
      cancelEditor();
    });
    ed.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'editor-save') saveEditor(ed);
      else if (act === 'editor-cancel') cancelEditor();
      else if (act === 'editor-delete') deleteEditingTask(ed);
      else if (act === 'open-recur-inline') openRuleFromTask(Number(btn.dataset.ruleId));
    });
  });
}

function startAdd() {
  // 幂等：全局键 Ctrl+Alt+N 在主窗口已聚焦时也会触发（quickAdd → 这里），
  // 若已经有一条正在新建的行，只把光标还给它 —— 再 startAdd 一次会把用户刚打的字整块冲掉。
  if (state.addingTask) {
    const live = document.querySelector('.task-editor[data-editor="new"] .editor-title');
    if (live) {
      live.focus({ preventScroll: true });
      revealEditor(live);
      return;
    }
  }
  state.addingTask = true;
  state.editingTaskId = null;
  renderTasks();
}

/**
 * 在指定分组下新增任务（侧边栏分组行的 ＋）。
 * 做法：把当前分组切到它、打开底部新增编辑器 —— 编辑器的默认分组取 state.currentGroup，
 * 于是新任务直接落在点「＋」的那个分组里，添加后也能立刻在当前列表看到。
 * @param {number} groupId 目标分组 id
 */
async function addTaskToGroup(groupId) {
  const group = state.groups.find((x) => x.id === groupId);
  if (!group) return;
  // 归档视图没有新增入口，非任务视图（统计 / 报告 / 检索 / 会议）也没有列表，统一落到「全部任务」
  if (!TASK_VIEWS.includes(state.view) || state.view === 'archived') state.view = 'all';
  state.currentGroup = groupId;
  // 目标分组可能藏在折叠的父分组里：逐级展开，保证侧边栏里看得见它的选中态
  let cur = group;
  for (let i = 0; i < 20 && cur && cur.parent_id != null; i++) {
    state.expandedGroups.add(cur.parent_id);
    cur = state.groups.find((x) => x.id === cur.parent_id);
  }
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  renderSidebarList();
  state.addingTask = true;
  state.editingTaskId = null;
  await render(); // renderTasks 内部会 focusEditor()，光标直接落在标题输入框
}

function startEdit(id) {
  state.editingTaskId = id;
  state.addingTask = false;
  renderTasks();
}

function cancelEditor() {
  // 取消只丢弃"尚未写入"的改动；已经自动保存的内容按即时持久化的语义保留
  // 必须 dispose 而不只是 cancel：cancel 只清计时器，renderTasks 回收时会 flush 一次，
  // 结果把用户刚取消的内容又写回库里。dispose 之后 flush 直接空转。
  const ed = document.querySelector('.task-editor');
  if (ed && ed.__autoSave) { ed.__autoSave.cancel(); ed.__autoSave.dispose(); }
  state.addingTask = false;
  state.editingTaskId = null;
  renderTasks();
}

/**
 * 把编辑行滚进可视区，但**只滚刚好够用的那一点**。
 *
 * 以前这里是 scrollIntoView({block:'center'})：新建行永远排在列表最末尾，想把它居中就得
 * 滚过 maxScroll，浏览器 clamp 成「滚到最底」—— 点一下新建，整个列表唰地上移一大截；
 * 更糟的是 scrollIntoView 会连文档一起滚（页面里有个逃出滚动容器的绝对定位元素把
 * document 撑高了，见 styles.css 里 .ts-hidden-accessible 的注释），于是标题栏都被顶出视口。
 * 现在只在 #view 上补差值，已经完整可见就一格都不动。
 *
 * 新建行（`.is-new-editor`）就是列表的最后一项，和编辑行走同一条路径：它通常有一部分
 * 落在可视区外，补的那点差值正好等于「露出最后一行表单」所需，不会整屏上移。
 */
function revealEditor(input) {
  const scroller = document.getElementById('view');
  if (!scroller || !input || !input.isConnected) return;
  const card = input.closest('.task-editor') || input;
  const box = scroller.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  const pad = 12; // 别贴着边缘，留一点呼吸
  let delta = 0;
  if (r.bottom > box.bottom - pad) delta = r.bottom - (box.bottom - pad);
  else if (r.top < box.top + pad) delta = r.top - (box.top + pad);
  if (!delta) return;
  scroller.scrollBy({ top: delta, behavior: 'smooth' });
}

function focusEditor() {
  requestAnimationFrame(() => {
    const el = document.querySelector('.task-editor .editor-title');
    if (!el) return;
    // preventScroll：focus() 自己也会把元素滚进视野，那条路径同样会连文档一起滚
    el.focus({ preventScroll: true });
    revealEditor(el);
  });
}

async function resolveTagIds(namesStr) {
  const names = namesStr.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  const ids = [];
  for (const n of names) {
    const existing = state.tags.find((t) => t.name === n);
    if (existing) ids.push(existing.id);
    else {
      const created = await api.tags.create(n);
      ids.push(created.id);
    }
  }
  return ids;
}

/**
 * 从编辑器 DOM 收集待保存的字段。返回 null 表示当前值不合法（标题为空 / 日期未通过校验）。
 * 供「保存按钮」与「自动保存」共用，保证两条路径写入的数据完全一致。
 */
function collectNotesValue(ed) {
  const el = ed.querySelector('.editor-notes');
  if (!el) return '';
  const val = el.value;
  const id = Number(ed.dataset.editor);
  if (!Number.isFinite(id) || id <= 0) return val;      // 新建任务：输入即正文
  const task = state.tasks.find((x) => x.id === id);
  const raw = task && task.notes ? String(task.notes) : '';
  // 行内 textarea 显示的是纯文本（不带标签 / base64）。内容没动就把原始 HTML 原样写回，
  // 否则「改个标题触发自动保存」会把富文本与图片洗成纯文本。
  return raw && val === notesToPlain(raw).text ? raw : val;
}

function collectEditorPayload(ed, { quiet = false } = {}) {
  const title = ed.querySelector('.editor-title').value.trim();
  if (!title) {
    if (!quiet) {
      toast('请输入任务标题');
      ed.querySelector('.editor-title').focus();
    }
    return null;
  }
  const range = ed.dataset.derived === '1' ? null : validateDateRange(ed);
  if (range && !range.ok) {
    if (!quiet) {
      toast(range.message); // validateDateRange 已给控件加上 .invalid 态
      ed.querySelector('.date-range-trigger').focus();
    }
    return null;
  }
  const planStart = range ? range.planStart : null;
  const planEnd = range ? range.planEnd : null;
  if (range && reminderNeedsPlanEnd(ed) && !planEnd) {
    if (!quiet) toast('请先设置完成日期，再选择提醒时间');
    return null;
  }
  const payload = {
    title,
    notes: collectNotesValue(ed),
    priority: Number(ed.querySelector('.editor-priority').value),
    groupId: ed.querySelector('.editor-group').value ? Number(ed.querySelector('.editor-group').value) : null,
  };
  // 重复事项的计划时间 / 提醒由规则派生：不进 payload（库里也拒写），避免用"空控件"折成 null 写库
  if (range) Object.assign(payload, { planStart, planEnd, reminderAt: computeReminder(ed, planEnd) });
  // 实际完成时间（仅编辑已完成任务时显示该字段）
  const catEl = ed.querySelector('.editor-completed-at');
  if (catEl) payload.completedAt = localToIso(catEl.value);
  return payload;
}

/** 编辑器内的保存状态提示（已保存 / 保存中… / 保存失败） */
function setEditorSaveState(ed, status, message) {
  const el = ed.querySelector('.editor-save-state');
  if (!el) return;
  el.hidden = status === 'idle';
  el.textContent = message || SAVE_STATE_TEXT[status] || '';
  el.className = `editor-save-state s-${status}`;
  el.title = status === 'error' ? (message || '保存失败，点击重试') : '';
}

/** 编辑已有任务时的即时持久化：输入停止 AUTO_SAVE_DELAY 毫秒后自动写库 */
function bindEditorAutoSave(ed) {
  const id = Number(ed.dataset.editor);
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return null;

  const read = () => {
    const p = collectEditorPayload(ed, { quiet: true });
    if (!p) return null;
    return { ...p, tagIds: (task.tag_ids || []).map(Number) };
  };

  const saver = createAutoSave({
    delay: AUTO_SAVE_DELAY,
    read,
    save: async (payload) => {
      const tagIds = await resolveTagIds(ed.querySelector('.editor-tags').value);
      return api.tasks.update(id, { ...payload, tagIds });
    },
    onStatus: (status, info) => {
      setEditorSaveState(ed, status, status === 'error' ? (info === 'conflict' ? '任务已不存在' : '保存失败，点击重试') : '');
    },
    onError: (e) => {
      toast(`自动保存失败：${(e && e.message) || '未知错误'}`);
      // 保留用户输入，点击状态标签即可重试
    },
    onConflict: () => {
      toast('该任务已被删除，未保存的修改已放弃');
      state.editingTaskId = null;
      refreshAll().then(() => { renderSidebarList(); renderTasks(); });
    },
    onSaved: (updated) => {
      // 只更新内存状态，不重绘列表（重绘会销毁编辑器、打断输入）
      const i = state.tasks.findIndex((t) => t.id === id);
      if (i > -1 && updated) state.tasks[i] = { ...state.tasks[i], ...updated };
      renderSidebarList();
    },
  });

  // 基线 = 打开编辑器时的服务端数据，避免"没改也写库"；派生字段不进表单，也就不进基线
  const baseline = {
    title: task.title,
    notes: task.notes || '',
    priority: task.priority,
    groupId: task.group_id ?? null,
    tagIds: (task.tag_ids || []).map(Number),
  };
  if (ed.dataset.derived !== '1') {
    baseline.planStart = task.plan_start;
    baseline.planEnd = task.plan_end;
    baseline.reminderAt = task.reminder_at;
  }
  saver.setBaseline(baseline);

  ed.addEventListener('input', () => saver.schedule());
  ed.addEventListener('change', () => saver.schedule());
  // 日期范围控件是自定义事件，单独监听
  ed.addEventListener(DATE_RANGE_EVENT, () => saver.schedule());
  // 点击状态标签 → 立即重试
  const stateEl = ed.querySelector('.editor-save-state');
  if (stateEl) stateEl.addEventListener('click', () => saver.flush());

  return saver;
}

async function saveEditor(ed) {
  const isEdit = ed.dataset.editor !== 'new';
  const payload = collectEditorPayload(ed);
  if (!payload) return;
  // 重复配置与一次性字段一起收集：开启时走「建规则」，把这一条任务挂成重复事项。
  // 不再预生成 N 条实例；日期 / 提醒 / 完成态由规则按当天推进。
  const repeat = readRepeatConfig(ed);
  if (repeat.invalid) { toast(repeat.invalid); return; }
  const repeatPayload = (tagIds) => ({
    ...payload, tagIds,
    rule: repeat.rule, startDate: repeat.startDate, endDate: repeat.endDate, habit: repeat.habit,
  });

  // 已进入自动保存的编辑器：立即 flush 并关闭；否则（新建）走创建流程
  const saver = ed.__autoSave;
  if (isEdit && saver) {
    await saver.flush();
    const ok = ed.querySelector('.editor-save-state').className.indexOf('s-error') === -1;
    if (!ok) return; // 保存失败时保持编辑器打开
    if (repeat.enabled) {
      // 把这条已有任务「就地」挂成规则的首个实例，附件 / 笔记关联 / 完成状态都不丢
      const done = await guardAction(async () => {
        const tagIds = await resolveTagIds(ed.querySelector('.editor-tags').value);
        await api.recurrences.create({ ...repeatPayload(tagIds), originTaskId: Number(ed.dataset.editor) });
      }, '创建重复规则失败');
      if (!done) return;
      toast('已转为重复事项，今后按规则出现在「今天」');
    }
    state.editingTaskId = null;
    await refreshAll();
    renderSidebarList();
    renderTasks();
    return;
  }

  const ok = await guardAction(async () => {
    const tagIds = await resolveTagIds(ed.querySelector('.editor-tags').value);
    if (repeat.enabled) {
      if (isEdit) {
        await api.tasks.update(Number(ed.dataset.editor), { ...payload, tagIds });
        await api.recurrences.create({ ...repeatPayload(tagIds), originTaskId: Number(ed.dataset.editor) });
      } else {
        await api.recurrences.create(repeatPayload(tagIds));
      }
    } else if (isEdit) {
      await api.tasks.update(Number(ed.dataset.editor), { ...payload, tagIds });
    } else {
      await api.tasks.create({ ...payload, tagIds });
    }
  }, repeat.enabled ? '创建重复事项失败' : (isEdit ? '更新任务失败' : '创建任务失败'));
  if (!ok) return; // 失败时保留编辑器内容，用户可直接重试
  toast(repeat.enabled
    ? (isEdit ? '已转为重复事项，今后按规则出现在「今天」' : '重复事项已创建，仍只是一条任务')
    : (isEdit ? '任务已更新' : '任务已创建'));

  state.addingTask = false;
  state.editingTaskId = null;
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

async function deleteEditingTask(ed) {
  const id = Number(ed.dataset.editor);
  if (!confirm('确定删除该任务吗？此操作不可恢复。')) return;
  const ok = await guardAction(() => api.tasks.remove(id), '删除任务失败');
  if (!ok) return;
  state.editingTaskId = null;
  toast('任务已删除');
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

/* ---------------- 拖拽排序 ---------------- */

/**
 * 切换排序方式（同步部分）：同步 state 与工具栏下拉框，不触发重绘。
 */
function setSortMode(mode) {
  state.sortMode = mode;
  const sel = document.getElementById('sort-select');
  if (sel) sel.value = mode;
}

/**
 * 绑定一行的拖拽排序。
 *
 * 原先整行 draggable="true"，问题有两个：
 *  1) 行内的输入框 / 按钮会抢走 mousedown，多数时候根本拖不起来；
 *  2) 列表顺序由 SQL 的「完成状态 → 截止日期 → 优先级 → sort_order」决定，
 *     sort_order 只是很靠后的兜底键，拖拽写进去后列表又按别的键排回去，看起来"没反应"。
 * 现在：只有按住左侧手柄才允许拖拽；拖完自动切到「手动」排序，让 sort_order 真正生效。
 */
function bindDrag(item) {
  const handle = item.querySelector('.drag-handle');
  if (!handle) return; // 子任务行不参与主列表排序

  const enable = () => { item.draggable = true; };
  const disable = () => { item.draggable = false; };
  handle.addEventListener('pointerdown', enable);
  handle.addEventListener('pointerup', disable);

  item.addEventListener('dragstart', (e) => {
    if (!item.draggable) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(item.dataset.id));
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    disable();
    item.classList.remove('dragging');
    document.querySelectorAll('.task-item.drag-over').forEach((x) => x.classList.remove('drag-over'));
  });
  item.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    item.classList.remove('drag-over');
    await dropReorder(item, e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
  });
}

/** 把 fromId 移动到当前行所在的位置，并按新的顺序写回 sort_order */
async function dropReorder(item, fromIdStr) {
  const fromId = Number(fromIdStr);
  const listEl = item.parentElement;
  if (!listEl) return;
  // 只取同一列表里的顶层任务：展开出来的子任务缩进显示，不参与主列表排序
  const rows = Array.from(listEl.querySelectorAll(':scope > .task-item:not(.is-subtask)'));
  const ids = rows.map((c) => Number(c.dataset.id));
  const fromIdx = ids.indexOf(fromId);
  const toIdx = ids.indexOf(Number(item.dataset.id));
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;

  ids.splice(toIdx, 0, ...ids.splice(fromIdx, 1));
  const ok = await guardAction(() => api.tasks.reorder(ids), '排序失败');
  if (!ok) return;
  // 手动排序下顺序才由 sort_order 决定：拖拽时自动切过去，避免"拖完又弹回原样"
  if (state.sortMode !== 'manual') {
    setSortMode('manual');
    toast('已切换为手动排序，可直接拖拽调整顺序');
  }
  await loadTasks();
  renderTasks();
}

/* ---------------- 任务操作 ---------------- */

async function toggleTask(id) {
  const before = state.tasks.find((x) => x.id === id);
  const t = await api.tasks.toggle(id);
  // 今天完成的任务保留在「今天」列表里：任何视图里勾的都要记（这里是列表勾选入口）
  noteCompletionChange(id, !!(t && t.completed), t && t.parent_id);
  // 重复事项勾的是「这一天」的打卡：说明跨天会自动恢复，免得用户以为整条被勾完了
  if (before && before.recurring_id != null && t) {
    toast(t.completed ? '今日已打卡，下个发生日会自动恢复未完成' : '已撤销今日打卡');
  }
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

async function archiveTask(id) {
  await api.tasks.archive(id);
  await refreshAll();
  renderSidebarList();
  renderTasks();
  toast('任务已归档');
}

async function archiveCompleted() {
  const n = await api.tasks.archiveCompleted(state.currentGroup === 'all' ? null : state.currentGroup);
  toast(`已归档 ${n} 个已完成任务`);
  await refreshAll();
  renderSidebarList();
  if (state.view === 'calendar') render();
  else renderTasks();
}

async function unarchiveTask(id) {
  await api.tasks.unarchive(id);
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

async function deleteTaskConfirm(id) {
  if (!confirm('确定删除该任务吗？此操作不可恢复。')) return;
  // 删除前留一份快照：Ctrl+Z 5 秒内原样恢复（新 id，附件不随快照回来）
  const snap = await snapshotTaskTree(id);
  await api.tasks.remove(id);
  if (snap) lastDeleted = { snap, at: Date.now() };
  toast('任务已删除，5 秒内按 Ctrl+Z 可撤销');
  if (kbSelectedId === id) kbSelectedId = null;
  await refreshAll();
  renderSidebarList();
  renderTasks();
}

/** 取任务（含一层子任务）的可重建快照 */
async function snapshotTaskTree(id) {
  try {
    const t = await api.tasks.get(id);
    if (!t) return null;
    const subs = await api.tasks.subtasks(id).catch(() => []);
    return {
      title: t.title,
      notes: t.notes || '',
      groupId: t.group_id == null ? null : t.group_id,
      priority: t.priority,
      planStart: t.plan_start || null,
      planEnd: t.plan_end || null,
      tagIds: t.tag_ids || [],
      subtasks: (subs || []).map((s) => ({
        title: s.title,
        notes: s.notes || '',
        priority: s.priority,
        planStart: s.plan_start || null,
        planEnd: s.plan_end || null,
      })),
    };
  } catch (e) {
    return null;
  }
}

/** Ctrl+Z：撤销上一次删除（5 秒内有效） */
async function undoDelete() {
  if (!lastDeleted || Date.now() - lastDeleted.at > 5000) {
    lastDeleted = null;
    toast('没有可撤销的删除（只在删除后 5 秒内有效）');
    return;
  }
  const { snap } = lastDeleted;
  lastDeleted = null;
  try {
    const t = await api.tasks.create({
      title: snap.title,
      notes: snap.notes,
      groupId: snap.groupId,
      priority: snap.priority,
      planStart: snap.planStart,
      planEnd: snap.planEnd,
      tagIds: snap.tagIds,
    });
    for (const s of snap.subtasks) {
      await api.tasks.create({
        title: s.title,
        notes: s.notes,
        groupId: snap.groupId,
        parentId: t.id,
        priority: s.priority,
        planStart: s.planStart,
        planEnd: s.planEnd,
      });
    }
    toast(`已恢复「${snap.title}」${snap.subtasks.length ? `（含 ${snap.subtasks.length} 个子任务）` : ''}`);
    await refreshAll();
    renderSidebarList();
    renderTasks();
  } catch (e) {
    toast(`恢复失败：${(e && e.message) || e}`);
  }
}

/* ---------------- 数据导入 / 导出（完整备份包） ---------------- */

async function exportData() {
  const r = await api.data.export();
  if (!r.ok) {
    if (!r.canceled) toast(r.message || '导出失败');
    return;
  }
  const c = (r.manifest && r.manifest.counts) || {};
  const size = r.size ? `${(r.size / 1024 / 1024).toFixed(1)}MB` : '';
  toast(`已导出完整备份：${c.tasks || 0} 个任务、${c.notes || 0} 篇笔记、${c.attachments || 0} 个附件、${c.recordings || 0} 段录音 ${size}`);
  // 导出时就能发现「库里登记了、文件却不在了」的附件，别等换机恢复时才暴露
  const lost = (r.manifest && r.manifest.missingAttachments) || [];
  const lostRec = (r.manifest && r.manifest.missingRecordings) || [];
  if (lost.length || lostRec.length) showBackupMissing(lost, lostRec);
}

/** 缺失附件 / 录音清单：导入后与导出时各用一次 */
function showBackupMissing(list, recList = []) {
  const lines = list.slice(0, 50).map((m) => {
    const owner = m.kind === 'note' ? '笔记' : '任务';
    return `· [${owner}] ${m.title || ''} — ${m.name || m.path || '（无文件名）'}`;
  });
  const recLines = recList.slice(0, 20).map((p) => `· ${String(p).split(/[\\/]/).slice(-2).join('/')}`);
  const more = list.length > 50 ? `\n… 另有 ${list.length - 50} 条` : '';
  const recMore = recList.length > 20 ? `\n… 另有 ${recList.length - 20} 段录音` : '';
  const body = [
    `共 ${list.length} 个附件文件已丢失：`,
    lines.join('\n') + more,
    recList.length ? `\n共 ${recList.length} 段录音已丢失：` : '',
    recLines.join('\n') + recMore,
    '',
    '这些记录还留在任务 / 笔记里，但打不开原件。若手上有更早的完整备份包，重新导入一次即可补回。',
  ].filter(Boolean).join('\n');

  openPanelModal({
    title: recList.length ? '备份里缺少附件与录音' : '备份里缺少附件',
    className: 'modal-backup-missing',
    html: '<div class="backup-missing-body" style="white-space:pre-wrap;line-height:1.7;max-height:52vh;overflow:auto"></div>',
    okText: '知道了',
    onMount(mask) {
      const box = mask.querySelector('.backup-missing-body');
      if (box) box.textContent = body; // textContent：文件名可能含尖括号，不能拼 HTML
    },
  });
}

async function importData() {
  if (!confirm('导入会覆盖当前的任务、分组、标签、笔记与会议纪要（附件会被合并到数据目录），是否继续？')) return;
  const r = await api.data.import();
  if (r.ok) {
    const c = r.counts || {};
    toast(`已导入 ${c.tasks || 0} 个任务、${c.groups || 0} 个分组、${c.tags || 0} 个标签、${c.notes || 0} 篇笔记`);
    state.currentGroup = 'all';
    state.currentTag = null;
    await refreshAll();
    renderSidebarList();
    renderTasks();
    if (r.missing && r.missing.length) showBackupMissing(r.missing);
    else if (r.legacy) toast('这份是旧版 JSON 备份：只含数据，不含附件与录音');
  } else if (!r.canceled) {
    toast(r.message || '导入失败');
  }
}

/* ---------------- 分组 / 标签编辑 ---------------- */

const GROUP_COLORS = [
  { value: 'auto', label: '自动', color: '#4f7cff' },
  { value: '#4f7cff', label: '蓝', color: '#4f7cff' },
  { value: '#23b07e', label: '绿', color: '#23b07e' },
  { value: '#f59e0b', label: '橙', color: '#f59e0b' },
  { value: '#e5484d', label: '红', color: '#e5484d' },
  { value: '#8b5cf6', label: '紫', color: '#8b5cf6' },
  { value: '#06b6d4', label: '青', color: '#06b6d4' },
];

/** 顶部 ＋ / 分组行 ＋ 的统一入口（parentId 非空 = 新增子分组） */
async function promptAddGroup(parentId = null) {
  await promptGroupForm(null, parentId);
}

/**
 * 新增/编辑分组：统一走表单弹窗。
 * 「上级分组」下拉决定层级 —— 放在哪个分组下面就成为它的子分组，之后也能改。
 * @param {number|null} presetParentId 从某个分组的 ＋ 进来时默认挂到它下面
 */
async function promptGroupForm(g = null, presetParentId = null) {
  const isEdit = !!g;
  const exclude = isEdit ? [g.id, ...descendantGroupIds(state.groups, g.id)] : [];
  const parentId = isEdit ? (g.parent_id ?? '') : (presetParentId ?? '');

  await openFormModal({
    title: isEdit ? '编辑分组' : '新增分组',
    okText: isEdit ? '保存' : '创建',
    // 分组表单字段少、语义纵向，保持单列（不套两栏栅格、不自动聚焦，避免误改下拉）
    grid: false,
    fields: [
      {
        name: 'name',
        label: '分组名称',
        value: g ? g.name : '',
        placeholder: '例如：工作 / 学习 / 健身',
      },
      {
        name: 'color',
        label: '颜色',
        type: 'color',
        value: g ? g.color : 'auto',
        fallback: '#4f7cff',
        hint: '点色块选预设，或点取色器自由取色（也可直接填 #RRGGBB）',
        options: GROUP_COLORS,
      },
      {
        name: 'parentId',
        label: '上级分组',
        type: 'select',
        value: parentId,
        options: [
          { value: '', label: '（无，作为顶级分组）' },
          ...flattenGroupTree(state.groups, { respectExpansion: false })
            .filter(({ g: x }) => !exclude.includes(x.id))
            .map(({ g: x, depth }) => ({
              value: x.id,
              label: `${depth ? `${'　'.repeat(depth)}└ ` : ''}${x.name}`,
            })),
        ],
      },
    ],
    onSubmit: async (v) => {
      const name = v.name.trim();
      if (!name) return '请输入分组名称';
      // 重名校验的作用域是「同一个上级」：不同层级可以同名，顶级分组自成一级。
      // 这里先按表单里选的上级比较，给出即时反馈；落库时 db 层还会再校验一次（移动分组同理）。
      const pid = v.parentId === '' ? null : Number(v.parentId);
      const sameLevel = (x) => (x.parent_id == null ? null : Number(x.parent_id)) === pid;
      const dup = state.groups.find((x) => x.id !== (g ? g.id : -1)
        && sameLevel(x)
        && x.name.trim().toLowerCase() === name.toLowerCase());
      if (dup) {
        const where = pid == null
          ? '顶级分组'
          : `「${state.groups.find((x) => x.id === pid)?.name || '该分组'}」下`;
        return `${where}已存在同名分组「${name}」，请换一个名称`;
      }
      const picked = String(v.color || '').trim();
      if (picked !== 'auto' && !/^#[0-9a-f]{6}$/i.test(picked)) {
        return '颜色格式不正确，请用取色器选择或填写 #RRGGBB';
      }
      const color = picked === 'auto' ? pickColor() : picked.toLowerCase();
      if (isEdit) {
        const updated = await api.groups.update(g.id, { name, color, parentId: pid });
        await afterGroupSaved(updated, true);
      } else {
        const created = await api.groups.create({ name, color, parentId: pid });
        await afterGroupSaved(created, false);
      }
      return undefined;
    },
  });
}

/** 分组写库后：刷新侧边栏 + 选中/展开到它 + 提示 */
async function afterGroupSaved(group, isEdit) {
  await refreshAll();
  if (!isEdit) {
    // 新建：确保父分组展开，否则新分组藏在折叠的父节点里"看不见"
    if (group.parent_id != null) state.expandedGroups.add(group.parent_id);
    state.currentGroup = group.id;
  }
  renderSidebarList();
  renderTasks();
  highlightSidebarItem('group', group.id);
  toast(isEdit ? '分组已更新' : `已创建分组「${group.name}」`);
}

/** 新增/修改后给对应条目一个短暂高亮，用户能立刻看到"确实加进去了" */
function highlightSidebarItem(kind, id) {
  const sel = kind === 'group' ? '.group-item' : '.tag-item';
  const items = [...document.querySelectorAll(`${sel}`)];
  const target = items.find((el) => Number(el.dataset.id) === id);
  if (!target) return;
  target.classList.add('just-added');
  setTimeout(() => target.classList.remove('just-added'), 1200);
}

async function promptAddTag() {
  await openPromptModal({
    title: '新增标签',
    label: '标签名称',
    placeholder: '例如：项目A / 紧急',
    okText: '创建',
    onSubmit: async (raw) => {
      const name = raw.trim();
      if (!name) return '请输入标签名称';
      if (state.tags.some((t) => t.name === name)) return `标签「${name}」已存在，请换一个名称`;
      const created = await api.tags.create(name);
      if (!created || !created.id) return '创建失败：接口未返回标签数据';
      state.tags = [...state.tags, { task_count: 0, ...created }];
      renderSidebarList();
      highlightSidebarItem('tag', created.id);
      toast(`已创建标签「${created.name}」`);
      return undefined;
    },
  });
}

async function editGroup(g) {
  await promptGroupForm(g);
}

/**
 * 删除分组：子分组会一并删除，任务上移一级（不丢任务）。
 * 确认文案里把影响面说清楚，避免出现"点一下任务全没了"的意外。
 */
async function deleteGroup(g) {
  const kids = descendantGroupIds(state.groups, g.id);
  const target = g.parent_id != null
    ? `上级分组「${state.groups.find((x) => x.id === g.parent_id)?.name || '已删除'}」`
    : '未分组';
  const msg = kids.length
    ? `删除分组「${g.name}」会连带删除它的 ${kids.length} 个子分组，其中的任务将移到${target}。确定删除？`
    : `删除分组「${g.name}」？组内任务将移到${target}。`;
  if (!confirm(msg)) return;
  await guardAction(async () => {
    await api.groups.remove(g.id);
    if (state.currentGroup === g.id) state.currentGroup = 'all';
    state.expandedGroups.delete(g.id);
    await refreshAll();
    renderSidebarList();
    renderTasks();
    toast(`已删除分组「${g.name}」`);
  }, '删除分组失败');
}

async function deleteTag(t) {
  if (!confirm(`删除标签「${t.name}」？`)) return;
  guardAction(async () => {
    await api.tags.remove(t.id);
    if (state.currentTag === t.id) {
      state.currentTag = null;
      await api.ui.setTagFilter(null); // 持久化值同步清掉，否则重启后又筛到一个已删除的标签
    }
    await refreshAll();
    renderSidebarList();
    renderTagFilterChip();
    renderTasks();
  }, '删除标签失败');
}

/* ---------------- 统计 ---------------- */

/**
 * 完成趋势的可选范围（key 与 main/db.js 的 TREND_RANGES 一一对应）。
 * 跨度越大粒度越粗（天 → 周 → 月），坐标轴标签与标题文案随选择一起变。
 */
const TREND_RANGES = [
  { key: '7d', label: '近 7 天' },
  { key: '1m', label: '近一个月' },
  { key: '6m', label: '近半年' },
  { key: '1y', label: '近一年' },
];
/** 当前趋势范围：切换视图再回到统计页时保留用户上次的选择 */
let trendRange = '7d';
/** 统计口径：false = 只算主任务（默认，与历史行为一致），true = 主任务 + 全部子任务 */
let statsIncludeSubtasks = false;

async function renderStats() {
  const viewEl = document.getElementById('view');
  viewEl.innerHTML = '<div class="empty">加载中…</div>';
  const ov = await api.stats.overview({ includeSubtasks: statsIncludeSubtasks });

  // 按分组树的前序顺序排列（父分组后紧跟其子分组），与侧边栏层级一致；
  // 统计里出现但已不在分组树中的（异常数据）排到最后。
  const treeOrder = new Map(
    flattenGroupTree(state.groups, { respectExpansion: false }).map(({ g }, i) => [g.id, i]),
  );
  const sortedByGroup = [...ov.byGroup].sort(
    (a, b) => (treeOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (treeOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const maxGroup = Math.max(1, ...sortedByGroup.map((g) => g.active + g.done));
  // 分组名带上级路径（"工作 / 前端"）：顶层分组只有自己的名字，子分组把父分组名一起显示出来，
  // 否则不同父分组下的同名子分组在统计里完全无法区分。
  const groupLabelOf = (g) => (g.parent_name ? `${g.parent_name} / ${g.name}` : g.name);
  const groupBars = sortedByGroup
    .map((g) => {
      const total = g.active + g.done;
      const pct = Math.round((total / maxGroup) * 100);
      const label = groupLabelOf(g);
      return `<div class="bar-row" title="${esc(label)}（进行中 ${g.active} · 已完成 ${g.done}）">
        <span class="bar-label">${esc(label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${esc(g.color)}"></div></div>
        <span class="bar-val">${total}</span>
      </div>`;
    })
    .join('');

  const priOrder = [3, 2, 1, 0];
  const priCount = { 0: 0, 1: 0, 2: 0, 3: 0 };
  ov.byPriority.forEach((p) => { priCount[p.priority] = p.count; });
  const priBars = priOrder
    .map((p) => {
      const c = priCount[p];
      const pct = ov.active > 0 ? Math.round((c / ov.active) * 100) : 0;
      return `<div class="bar-row">
        <span class="bar-label">${PRIORITY_TEXT[p]}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${PRIORITY_COLOR[p]}"></div></div>
        <span class="bar-val">${c}</span>
      </div>`;
    })
    .join('');

  viewEl.innerHTML = `
    <div class="stats-scope" id="stats-scope" role="group" aria-label="统计范围">
      <span class="stats-scope-label">统计范围</span>
      <button type="button" class="chip scope-chip${statsIncludeSubtasks ? '' : ' active'}"
        data-scope="top" aria-pressed="${!statsIncludeSubtasks}">仅主任务</button>
      <button type="button" class="chip scope-chip${statsIncludeSubtasks ? ' active' : ''}"
        data-scope="all" aria-pressed="${statsIncludeSubtasks}">含子任务</button>
      <span class="stats-scope-hint">${statsIncludeSubtasks ? '主任务 + 全部子任务' : '不含子任务'}</span>
    </div>
    <div class="stats-grid">
      ${statCardHtml('total', ov.total, '总任务', '')}
      ${statCardHtml('active', ov.active, '进行中', 'primary')}
      ${statCardHtml('completed', ov.completed, '已完成', 'green')}
      ${statCardHtml('overdue', ov.overdue, '已逾期', 'danger')}
      <div class="stat-card is-static"><div class="num">${ov.rate}%</div><div class="label">完成率</div></div>
      ${statCardHtml('archived', ov.archived, '已归档', '')}
    </div>
    <div class="stats-tip">${statsTipHtml()}</div>
    <div class="panel">
      <div class="panel-head">
        <h3 id="trend-title">完成趋势</h3>
        <div class="trend-range" id="trend-range" role="group" aria-label="完成趋势时间范围">
          ${TREND_RANGES.map((r) => `<button type="button" class="chip trend-chip${r.key === trendRange ? ' active' : ''}"
            data-trend="${esc(r.key)}" aria-pressed="${r.key === trendRange}">${esc(r.label)}</button>`).join('')}
        </div>
      </div>
      <div class="trend-body" id="trend-body"><div class="trend-loading">加载中…</div></div>
    </div>
    <div class="panel"><h3>分组任务量</h3>${groupBars || '<span class="meta-item">暂无分组</span>'}</div>
    <div class="panel"><h3>优先级分布（进行中）</h3>${priBars}</div>`;

  viewEl.querySelectorAll('.stat-card[data-stat]').forEach((card) => {
    card.addEventListener('click', () => openStatDrilldown(card.dataset.stat, card));
  });
  bindStatsScope(viewEl);
  bindTrendRange(viewEl);
  await renderTrend();
}

/** 统计口径切换：卡片、分组、优先级、趋势全部按新口径重取，实时刷新 */
function bindStatsScope(viewEl) {
  const box = viewEl.querySelector('#stats-scope');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-scope]');
    if (!btn) return;
    const next = btn.dataset.scope === 'all';
    if (next === statsIncludeSubtasks) return;
    statsIncludeSubtasks = next;
    box.querySelectorAll('[data-scope]').forEach((b) => {
      const on = (b.dataset.scope === 'all') === statsIncludeSubtasks;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const hint = box.querySelector('.stats-scope-hint');
    if (hint) hint.textContent = statsIncludeSubtasks ? '主任务 + 全部子任务' : '不含子任务';
    await renderStats(); // 整页重取：卡片数字、分组、优先级、趋势都跟着变
  });
}

/** 范围切换：只重绘趋势这一块，概述数据不必重新拉取 */
function bindTrendRange(viewEl) {
  const box = viewEl.querySelector('#trend-range');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-trend]');
    if (!btn || btn.dataset.trend === trendRange) return;
    trendRange = btn.dataset.trend;
    box.querySelectorAll('[data-trend]').forEach((b) => {
      const on = b.dataset.trend === trendRange;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    await renderTrend();
  });
}

/**
 * 拉取并绘制趋势。三种状态都要有明确呈现：
 * 加载中、无数据（给出范围文案而不是空图）、加载失败（显示原因）。
 */
async function renderTrend() {
  const body = document.getElementById('trend-body');
  if (!body) return;
  const titleEl = document.getElementById('trend-title');
  body.innerHTML = '<div class="trend-loading">加载中…</div>';

  let t;
  try {
    t = await api.stats.trend({ range: trendRange, includeSubtasks: statsIncludeSubtasks });
  } catch (e) {
    body.innerHTML = `<div class="trend-empty">趋势加载失败：${esc((e && e.message) || '未知错误')}</div>`;
    return;
  }
  const label = (t && t.label) || '';
  if (titleEl) titleEl.textContent = `${label}完成趋势`;

  const pts = (t && t.points) || [];
  // 无数据：直接给一句人话，而不是画一排高度 0 的柱子
  if (!pts.length || !t.total) {
    body.innerHTML = `<div class="trend-empty">${esc(label || '所选范围')}内还没有已完成的任务</div>`;
    return;
  }

  const maxCount = Math.max(1, ...pts.map((p) => p.count));
  // 坐标轴文案随粒度变：天 = 当天，周 = 该周起始日，月 = 年月
  const unitText = t.granularity === 'week' ? ' 起一周' : t.granularity === 'month' ? '（整月）' : '';
  // 柱子多时每隔 N 个才显示一个坐标标签，否则标签会挤成一团
  const step = Math.ceil(pts.length / 15);
  const cols = pts
    .map((p, i) => {
      const h = Math.max(3, Math.round((p.count / maxCount) * 100));
      const showLabel = i === pts.length - 1 || i % step === 0;
      return `<div class="trend-col" title="${esc(`${p.label}${unitText}：${p.count} 个`)}">
        <span class="trend-count">${p.count ? p.count : ''}</span>
        <div class="trend-bar" style="height:${h}px"></div>
        <span class="trend-date"${showLabel ? '' : ' style="visibility:hidden"'}">${esc(p.label)}</span>
      </div>`;
    })
    .join('');

  body.innerHTML = `<div class="trend-chart">${cols}</div>
    <div class="trend-summary">${esc(label)}共完成 ${t.total} 个任务</div>`;
}

/**
 * 统计页提示。
 * 标签筛选开着时要点明「统计仍是全局口径」——否则用户看到顶栏还挂着标签、
 * 但数字没按标签过滤，会以为是选中态失效。
 */
function statsTipHtml() {
  const t = state.tags.find((x) => x.id === state.currentTag);
  const base = '点击卡片上的数字可查看对应任务明细';
  if (!t) return base;
  return `${base}　<span class="stats-warn">当前已按标签「${esc(t.name)}」筛选任务列表，统计仍按全部任务计算</span>`;
}

/** 统计卡片：数字与标题都可点（整卡点击区域更大，但只有数字带下划线提示） */
function statCardHtml(key, num, label, tone) {
  return `<button type="button" class="stat-card ${tone}" data-stat="${key}"
      title="查看「${esc(label)}」的任务明细" aria-label="${esc(label)} ${num} 个，点击查看明细">
      <div class="num">${num}</div><div class="label">${esc(label)}</div></button>`;
}

/** 各统计项 → 任务查询条件（与 overview 的 SQL 口径一一对应） */
function statFilterOf(key) {
  const today = todayStr();
  // 下钻明细跟随统计页当前的口径：切到「含子任务」后点卡片，看到的就该是同一批任务
  const base = { topLevel: !statsIncludeSubtasks };
  switch (key) {
    case 'total': return { ...base, status: 'any' };
    case 'active': return { ...base, status: 'active' };
    case 'completed': return { ...base, status: 'completed' };
    case 'archived': return { ...base, status: 'archived' };
    case 'overdue': {
      // overview 的逾期 = plan_end < 今天，等价于 plan_end <= 昨天
      const y = new Date(`${today}T00:00:00`);
      y.setDate(y.getDate() - 1);
      const p = (n) => String(n).padStart(2, '0');
      return { ...base, status: 'active', planEndTo: `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}` };
    }
    default: return null;
  }
}

const STAT_TITLES = {
  total: '总任务', active: '进行中', completed: '已完成', overdue: '已逾期', archived: '已归档',
};

const DRILL_SORTS = [
  { key: 'title', label: '任务名称' },
  { key: 'plan_end', label: '截止时间' },
  { key: 'status', label: '状态' },
  { key: 'priority', label: '优先级' },
];

/** 任务在列表里展示的状态文案（逾期是派生状态，库里只有 completed/archived 两个标记） */
function drillStatusOf(t) {
  if (t.archived) return { text: '已归档', cls: 'st-archived' };
  if (t.completed) return { text: '已完成', cls: 'st-done' };
  if (t.plan_end && t.plan_end < todayStr()) return { text: '已逾期', cls: 'st-overdue' };
  return { text: '进行中', cls: 'st-active' };
}

/**
 * 统计数字下钻：弹窗列出对应任务，支持按列排序，点击行跳到任务详情。
 * 关闭弹窗后统计页原样还在（弹窗是覆盖层，不销毁视图）。
 */
async function openStatDrilldown(key, cardEl) {
  const f = statFilterOf(key);
  if (!f) return;
  const title = `${STAT_TITLES[key] || '任务'}明细`;
  let tasks = [];
  let sortKey = 'plan_end';
  let sortDir = 1; // 1 升序 / -1 降序

  const sortTasks = () => {
    const val = (t) => {
      switch (sortKey) {
        case 'title': return String(t.title || '');
        case 'plan_end': return t.plan_end || '9999-99-99'; // 无截止日期的排在最后
        case 'status': return drillStatusOf(t).text;
        case 'priority': return Number(t.priority) || 0;
        default: return '';
      }
    };
    tasks.sort((a, b) => {
      const va = val(a); const vb = val(b);
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
  };

  const rowsHtml = () => {
    if (!tasks.length) return '<div class="drill-empty">没有符合条件的任务</div>';
    return tasks.map((t) => {
      const st = drillStatusOf(t);
      const pri = Number(t.priority) || 0;
      return `<tr class="drill-row" data-id="${t.id}" tabindex="0" title="点击查看任务详情">
        <td class="drill-title">${esc(t.title)}</td>
        <td>${t.plan_end ? esc(t.plan_end) : '<span class="drill-dim">—</span>'}</td>
        <td><span class="drill-status ${st.cls}">${st.text}</span></td>
        <td><span class="drill-pri" style="color:${PRIORITY_COLOR[pri]}">${PRIORITY_TEXT[pri]}</span></td>
        <td class="drill-group">${t.group_name ? esc(t.group_name) : '<span class="drill-dim">—</span>'}</td>
      </tr>`;
    }).join('');
  };

  const headHtml = () => DRILL_SORTS
    .map((s) => `<th class="drill-th${s.key === sortKey ? ' sorted' : ''}" data-sort="${s.key}" tabindex="0"
        role="button" aria-sort="${s.key === sortKey ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}">
        ${s.label}<span class="drill-arrow">${s.key === sortKey ? (sortDir === 1 ? '↑' : '↓') : ''}</span></th>`)
    .join('');

  const tableHtml = () => `
    <div class="drill-meta">共 ${tasks.length} 个任务 · 点击表头排序 · 点击行打开详情</div>
    <div class="drill-wrap"><table class="drill-table">
      <thead><tr>${headHtml()}</tr></thead>
      <tbody>${rowsHtml()}</tbody>
    </table></div>`;

  await openPanelModal({
    title,
    className: 'modal-drill',
    html: '<div class="drill-loading">加载中…</div>',
    onMount: async (root, close) => {
      const body = root.querySelector('.modal-body');
      try {
        tasks = await api.tasks.list(f);
      } catch (e) {
        body.innerHTML = `<div class="drill-empty">加载失败：${esc((e && e.message) || e)}</div>`;
        return;
      }
      // 与卡片数字对不上时明确提示，避免"看起来是 bug"的静默不一致
      const shown = cardEl ? Number(cardEl.querySelector('.num').textContent) : null;
      sortTasks();
      body.innerHTML = (Number.isFinite(shown) && shown !== tasks.length
        ? `<div class="drill-warn">统计值 ${shown} 与当前查询结果 ${tasks.length} 不一致，可能数据刚有变动</div>`
        : '') + tableHtml();

      const resort = (key) => {
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = 1; }
        sortTasks();
        body.innerHTML = tableHtml();
        bindTable();
      };
      const bindTable = () => {
        body.querySelectorAll('.drill-th').forEach((th) => {
          const go = () => resort(th.dataset.sort);
          th.addEventListener('click', go);
          th.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          });
        });
        body.querySelectorAll('.drill-row').forEach((tr) => {
          const go = () => { close(); openDetail(Number(tr.dataset.id)); };
          tr.addEventListener('click', go);
          tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          });
        });
      };
      bindTable();
    },
  });
}

/* ---------------- 主题 ---------------- */

/**
 * 主题的全部脏活都在 js/theme.js（取值 / 跟系统深浅色 / 背景图丢失兜底）。
 * 这里只做两件事：启动时拉一次、把「配色变了」转成 state 里那份对象，
 * 方便其他模块（报告预览等）读当前风格。
 */
async function initTheme() {
  await initThemeState();
  state.theme = getTheme();
  setThemeHook((t) => { state.theme = t; });
}

/* ---------------- 工具 ---------------- */

function pickColor() {
  const colors = ['#4f7cff', '#23b07e', '#f59e0b', '#e5484d', '#8b5cf6', '#06b6d4', '#ec4899'];
  return colors[Math.floor(Math.random() * colors.length)];
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  // 提示恒挂在 body 最外层：既不受任何父容器 overflow 裁切，也保证 z-index 生效在顶层栈里
  if (el.parentElement !== document.body) document.body.appendChild(el);
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/**
 * 统一错误捕获：异步操作失败时把原因提示给用户，避免"点了没反应"。
 * 失败文案统一带上兜底前缀，便于区分是校验失败还是接口失败。
 */
async function guardAction(fn, prefix = '操作失败') {
  try {
    await fn();
    return true;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error(`[${prefix}]`, e);
    toast(`${prefix}：${msg}`);
    return false;
  }
}

export { render, renderSidebar, renderTasks, toast };
