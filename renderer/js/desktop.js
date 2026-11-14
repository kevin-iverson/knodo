'use strict';
/**
 * 桌面浮窗渲染层（renderer/desktop.html 的唯一脚本）。
 *
 * 一个页面服务所有投影类型：窗口通过 ?id=<projectionId> 区分，数据一律向主进程要，
 * 这里不缓存、不落盘 —— 浮窗只负责「看」和「勾」，任务的真身在库里。
 *
 * 关键约束（都是踩过的坑）：
 *  - 勾选后行必须留在原位（只变灰），否则连点两条会误勾；
 *  - 局部刷新优先：数据没变就不重建 DOM，滚动位置与选中项原地保留；
 *  - 不在透明窗上做骨架屏 / toast：286px 里任何闪动都比「什么都不显示」更干扰。
 */
import { api, fmtDateTime } from './api.js';

const query = new URLSearchParams(location.search);
const projectionId = query.get('id') || '';

const el = {
  root: document.getElementById('dw'),
  head: document.getElementById('dw-head'),
  dot: document.getElementById('dw-dot'),
  title: document.getElementById('dw-title'),
  count: document.getElementById('dw-count'),
  pend: document.getElementById('dw-pend'),
  collapse: document.getElementById('dw-collapse'),
  pin: document.getElementById('dw-pin'),
  more: document.getElementById('dw-more'),
  body: document.getElementById('dw-body'),
  list: document.getElementById('dw-list'),
  hint: document.getElementById('dw-hint'),
  foot: document.getElementById('dw-foot'),
  add: document.getElementById('dw-add'),
  addInput: document.getElementById('dw-add-input'),
  grip: document.getElementById('dw-grip'),
  // 笔记投影（kind: 'note'）：只在钉了笔记时出现，任务投影里一直 hidden
  note: document.getElementById('dw-note'),
  noteTitle: document.getElementById('dw-note-title'),
  noteBody: document.getElementById('dw-note-body'),
  noteBar: document.getElementById('dw-note-bar'),
  noteMeta: document.getElementById('dw-note-meta'),
  noteState: document.getElementById('dw-note-state'),
  edit: document.getElementById('dw-edit'),
};

/** 视觉常量：与 desktop.css / 主进程 desktop-window.js 保持一致 */
const HEAD_H = 42;
const FOOT_H = 36;
const MAX_H = 520;
const MIN_W = 240;
const MAX_W = 460;
const DEFAULT_W = 286;
/** 顶条 dock：收起高度 30（展开高度按内容自适应，宽度 420 由主进程锁死） */
const DOCK_HEAD_H = 30;
/** 侧吸 dock：收起宽度 30（展开 320、高度按内容自适应，尺寸全部由主进程锁） */
const SIDE_W = 320;
const SIDE_MIN_H = 200;
/** 笔记浮窗的最小高度：正文可能只有两行，但编辑要有个像样的画布 */
const NOTE_MIN_H = 320;
/** 悬停时序：进入 120ms 展开（手速划过顶边不闪），离开 400ms 收回（向下移动时不抽搐） */
const DOCK_OPEN_DELAY = 120;
const DOCK_CLOSE_DELAY = 400;

/** 优先级色点在 CSS 里按 .dw-pri.p0~p3 分档（深色主题要另一套更亮的色值，写死内联色就覆盖不了） */

/** 当前投影数据：{ projection, title, color, tasks, counts, missing, error } */
let view = null;
/** 插入后要高亮 400ms 的任务 id */
let highlightId = null;
/** 键盘选中行 */
let selId = null;
/** 上一次渲染的指纹，用来跳过无变化的重建 */
let lastSig = '';
/** 清单已被删除：进入只读提示态，3 秒后自动取消钉住 */
let missingTimer = null;

/* ---- 笔记投影（kind: 'note'）---- */
/** 懒加载出来的编辑器依赖：{ createWysiwyg, createAutoSave, SAVE_STATE_TEXT } */
let noteAssets = null;
/** 进行中的加载（并发调用共用一次）—— 别把 promise 塞进 noteAssets，
 *  否则别处读 noteAssets.SAVE_STATE_TEXT 会拿到 undefined，状态位永远是空的 */
let noteAssetsPromise = null;
/** wysiwyg 实例：读态 / 编辑态共用同一份 DOM，切态只开关 contenteditable */
let noteEditor = null;
/** 防抖落库（与笔记视图同一套 createAutoSave：没改动就不写库） */
let noteSaver = null;
/** 编辑器当前挂的笔记 id（换一篇 = 重建内容与基线） */
let noteForId = null;
/** 库里的正文指纹：判断「外部改过这篇笔记」，避免每次轮询都重渲（会丢光标） */
let noteHash = '';
let noteEditing = false;
let noteDirty = false;
/** 异步加载 / 渲染的竞态令牌：只有最后一次的结果能落地 */
let noteToken = 0;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ---------------- 主题 ---------------- */

/**
 * 浮窗只跟随「配色」，不渲染背景图。
 * 模式 × 风格都从主进程读（主窗口换风格这里立刻跟着换），但把 backdrop 清掉 ——
 * 浮窗是贴在别人窗口上的，透出壁纸会和下面的内容糊在一起（设计方案 · 协同规则）。
 */
const mq = window.matchMedia('(prefers-color-scheme: dark)');

function applySystemMode() {
  document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
}

async function syncTheme() {
  try {
    const t = await api.theme.get();
    if (!window.KnodoTheme || !t) { applySystemMode(); return; }
    window.KnodoTheme.paint({
      ...t,
      backdrop: { ...(t.backdrop || {}), type: 'none', image: '', missing: false },
    });
  } catch (e) {
    // 主进程读不到（极早期 / 库未就绪）就退回系统深浅色，浮窗不能因为主题而空着
    applySystemMode();
  }
}

syncTheme();
if (mq.addEventListener) mq.addEventListener('change', syncTheme);
api.on('ui:theme-changed', syncTheme);

/* ---------------- 数据 ---------------- */

async function load() {
  if (!projectionId) {
    renderFatal('这个窗口缺少参数，请收起后重新钉一次');
    return;
  }
  try {
    view = await api.desktop.get(projectionId);
  } catch (e) {
    view = { error: (e && e.message) || '读取失败', tasks: [], counts: { done: 0, total: 0 }, title: '数据未就绪' };
  }
  render();
  if (view && view.missing) enterMissing();
}

/** 静默重拉（数据没变时不动 DOM，滚动位置与选中项原地保留） */
async function refresh() {
  if (!projectionId || (view && view.missing)) return;
  let next = null;
  try {
    next = await api.desktop.get(projectionId);
  } catch (e) {
    // 读失败不要把已有内容清空（数据库短暂占用时，界面上保留旧数据比一片空白好）。
    // 笔记窗尤其不能退化成错误态：正文在编辑器里，顶掉视图等于把正在写的东西藏起来。
    if (!isNoteView() && (!view || !view.tasks || !view.tasks.length)) {
      view = { error: (e && e.message) || '读取失败', tasks: [], counts: { done: 0, total: 0 }, title: '数据未就绪' };
      render();
    }
    return;
  }
  view = next;
  render();
  if (view.missing) enterMissing();
}

/* ---------------- 渲染 ---------------- */

function isCollapsed() {
  return !!(view && view.projection && view.projection.collapsed);
}

/** 这个窗吸在哪条边上：'top' 顶条 / 'left' | 'right' 侧吸 / null 普通浮窗 */
function dockSide() {
  const d = view && view.projection ? view.projection.dock : null;
  return d === 'top' || d === 'left' || d === 'right' ? d : null;
}

/** 这个窗是不是吸边窗（顶条或侧吸） */
function isDock() {
  return !!dockSide();
}

/** 侧吸（贴左右边缘的竖条）：收起只有 30px 宽 */
function isSideDock() {
  const s = dockSide();
  return s === 'left' || s === 'right';
}

/** 标题栏高度：顶条压到 30px，侧吸与普通浮窗都是完整的 42px */
function headHeight() {
  return dockSide() === 'top' ? DOCK_HEAD_H : HEAD_H;
}

/** 这个窗是不是「一篇笔记」（任务列表的那套渲染整条不走） */
function isNoteView() {
  return !!(view && view.projection && view.projection.kind === 'note');
}

/** 收起成 30px 竖条时「未完成 N」只留数字：标题已经写着「未完成」，
    竖排再重复一遍是白占地方（左吸条只有 320px 高） */
function pendText(n) {
  return isSideDock() && isCollapsed() ? String(n) : `未完成 ${n}`;
}

/** 「保持展开」：dock 悬停展开后手动钉住，鼠标移开也不收回 */
function isDockPinned() {
  return !!(view && view.projection && view.projection.dockPinned);
}

/** 本地日期 YYYY-MM-DD（与主进程 todayStr 同口径，避免 new Date() 相减跨时区差一天） */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 优先级：0 低 / 1 中 / 2 高 / 3 紧急。
 * 缺失（null / undefined / 空串）或越界一律回落 1（中）—— 写 `t.priority || 0` 会把 null 变成「低」，
 * 把「没设过」误报成「低优先级」。Number(null) === 0，所以必须先显式判空。
 */
function priOf(t) {
  const raw = t ? t.priority : null;
  if (raw == null || raw === '') return 1;
  const p = Number(raw);
  return Number.isInteger(p) && p >= 0 && p <= 3 ? p : 1;
}

function signature() {
  if (!view) return 'none';
  const t = (view.tasks || []).map((x) => `${x.id}:${x.completed ? 1 : 0}:${x.title}:${x.parent_id || ''}:${x.plan_end || ''}:${priOf(x)}`).join('|');
  const p = view.projection || {};
  // 优先级必须进指纹：否则主列表改了优先级，浮窗不重绘 = 「色标永远不变」
  return `${view.title}|${view.counts ? view.counts.done : 0}/${view.counts ? view.counts.total : 0}|${view.error || ''}|${view.missing ? 1 : 0}|${isCollapsed() ? 1 : 0}|${p.kind || ''}|${p.dock || ''}|${view.pending == null ? '' : view.pending}/${view.overdue == null ? '' : view.overdue}|${t}|${highlightId || ''}`;
}

function render() {
  if (!view) return;
  const collapsed = isCollapsed();
  const dock = isDock();
  const side = dockSide();
  const note = isNoteView();
  el.root.classList.toggle('is-collapsed', collapsed);
  // 顶条：标题栏压到 30px、上边不画圆角、隐藏缩放手柄（宽度固定 420）
  el.root.classList.toggle('is-dock', side === 'top');
  // 侧吸：贴边那一侧不画圆角；收起的 30px 竖条另有一套「竖排标题」布局
  el.root.classList.toggle('is-dock-side', side === 'left' || side === 'right');
  el.root.classList.toggle('is-dock-left', side === 'left');
  el.root.classList.toggle('is-dock-right', side === 'right');
  // 笔记：底栏换成「字数 / 更新时间 + 编辑」，列表与新增待办都不出现
  el.root.classList.toggle('is-note', note);
  el.collapse.classList.toggle('is-rotated', collapsed);
  el.collapse.title = collapsed ? '展开清单' : '折叠为标题条';
  // 📌 只在 dock 上出现：把展开态钉住，鼠标移开也不收回
  el.pin.hidden = !dock;
  el.pin.classList.toggle('is-on', dock && isDockPinned());
  el.pin.title = dock && isDockPinned() ? '取消保持展开' : '保持展开';

  // 标题栏
  if (view.missing) {
    el.root.dataset.state = 'missing';
    el.title.textContent = view.title || '该清单已删除';
    el.dot.hidden = true;
    el.count.hidden = true;
    el.pend.hidden = true;
  } else if (view.error) {
    el.root.dataset.state = 'error';
    el.title.textContent = view.title || '数据未就绪';
    el.dot.hidden = true;
    el.count.hidden = true;
    el.pend.hidden = true;
  } else {
    el.root.dataset.state = 'ready';
    const p = view.projection || {};
    const isUnfinished = p.kind === 'unfinished';
    el.title.textContent = view.title || '清单';
    el.title.title = view.title || '';
    if (view.color) {
      el.dot.hidden = false;
      el.dot.style.background = view.color;
    } else {
      el.dot.hidden = true;
    }
    const c = view.counts || { done: 0, total: 0 };
    if (note) {
      // 笔记没有「完成进度」这回事：徽标一律不显示，标题就是全部读数
      el.count.hidden = true;
      el.pend.hidden = true;
    } else if (isUnfinished) {
      // 「未完成」的头条信息是「我还欠多少」：收起条尤其要一眼看到数字 + 逾期数。
      // 两个徽标并排 —— 左边红色报危机（逾期），右边品牌色报总量（未完成），标题只留名字。
      const pend = view.pending == null ? Math.max(0, c.total - c.done) : view.pending;
      const over = Number(view.overdue) || 0;
      el.count.hidden = !over;
      el.count.textContent = over ? `逾期 ${over}` : '';
      el.count.title = `逾期 ${over} 条（未勾掉）`;
      el.count.classList.toggle('is-overdue', over > 0);
      el.pend.hidden = false;
      el.pend.textContent = pendText(pend);
      el.pend.title = `还有 ${pend} 条没勾掉`;
    } else {
      el.count.hidden = false;
      el.count.classList.remove('is-overdue');
      el.count.textContent = `${c.done} / ${c.total}`;
      el.count.title = `已完成 ${c.done} / 共 ${c.total}`;
      el.pend.hidden = true;
    }
  }

  // 折叠时列表与新增行整体隐藏（窗口高度由 fit() 收回 42px）
  if (collapsed) {
    el.list.innerHTML = '';
    el.hint.hidden = true;
    // 清空 DOM 后必须让指纹失效：否则展开时数据没变就会「跳过重建」，列表停在空白
    lastSig = '';
    fit();
    return;
  }

  // 笔记投影：正文是编辑器自己的 DOM，不走列表那套「指纹 + 重建」
  if (note) {
    el.list.hidden = true;
    el.note.hidden = false;
    el.noteBar.hidden = false;
    el.add.hidden = true;
    el.addInput.hidden = true;
    paintNote().catch((e) => showQuickHint((e && e.message) || '笔记渲染失败'));
    return;
  }
  el.note.hidden = true;
  el.noteBar.hidden = true;
  el.list.hidden = false;

  const sig = signature();
  if (sig !== lastSig) {
    lastSig = sig;
    renderList();
    renderHint();
  }
  fit();
}

/**
 * 到期日小标签（「即将到期」投影专用）：
 * 这个视图里「什么时候到期」就是主要信息，只给标题等于看不出来；
 * 近三天用相对说法（今天 / 明天 / 后天），更远的用 M/D 省宽度。
 */
function dueLabel(planEnd) {
  if (!planEnd) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${planEnd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((d - today) / 86_400_000);
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days === 2) return '后天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 一行任务（不带分组） */
function rowHtml(t, opts = {}) {
  const done = !!t.completed;
  const pri = priOf(t);
  const cls = [
    'dw-row',
    done ? 'is-done' : '',
    t.parent_id ? 'is-child' : '',
    t.id === selId ? 'is-sel' : '',
    t.id === highlightId ? 'is-new' : '',
    // 紧急行额外强化：左侧竖条 + 标题加粗 + 淡红底（色点太弱，一眼扫不到）
    pri === 3 && !done ? 'is-urgent' : '',
  ].filter(Boolean).join(' ');
  const due = opts.due || '';
  const tail = opts.tail || '';
  return `<div class="${cls}" data-id="${t.id}"${opts.sec ? ` data-sec="${opts.sec}"` : ''} role="checkbox" aria-checked="${done}" title="${esc(t.title)}">
      <span class="dw-check${done ? ' on' : ''}"></span>
      <span class="dw-pri p${pri}" title="优先级：${['低', '中', '高', '紧急'][pri]}"></span>
      <span class="dw-text">${esc(t.title)}</span>
      <span class="dw-pri-tag p${pri}" title="优先级：${['低', '中', '高', '紧急'][pri]}">${['低', '中', '高', '紧急'][pri]}</span>
      ${due ? `<span class="dw-due${due === '今天' || due === '明天' ? ' is-soon' : ''}">${esc(due)}</span>` : ''}
      ${tail ? `<span class="dw-tail">${esc(tail)}</span>` : ''}
      <span class="dw-row-acts">
        <button type="button" class="dw-row-btn" data-act="open" title="在主窗口打开">↗</button>
        <button type="button" class="dw-row-btn" data-act="del" title="删除任务">✕</button>
      </span>
    </div>`;
}

/**
 * 「未完成」的四段分组：逾期 → 今天 → 之后 → 未安排。
 * 为什么不复用主列表的 smart 排序：它把逾期混进「最早截止」里，22 条时逾期会被埋在中间，
 * 而这张清单的第一诉求正是「我漏了什么」。
 * 段内保持后端给出的顺序（不按完成态重排）—— 勾掉一条要留在原位，否则连点会误勾。
 */
function groupSections(tasks) {
  const today = todayStr();
  const secs = [
    { key: 'overdue', label: '逾期', cls: 'is-overdue', rows: [] },
    { key: 'today', label: '今天', cls: '', rows: [] },
    { key: 'later', label: '之后', cls: '', rows: [] },
    { key: 'none', label: '未安排', cls: '', rows: [] },
  ];
  const byKey = new Map(secs.map((s) => [s.key, s]));
  for (const t of tasks) {
    const pe = t.plan_end || '';
    let k = 'none';
    if (pe && pe < today) k = 'overdue';
    else if (pe && pe === today) k = 'today';
    else if (pe && pe > today) k = 'later';
    byKey.get(k).rows.push(t);
  }
  return secs.filter((s) => s.rows.length);
}

/** 逾期天数（字符串日期相减，避免时区差一天） */
function overdueDays(planEnd) {
  if (!planEnd) return 0;
  const d = new Date(`${planEnd}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.round((today - d) / 86_400_000));
}

/**
 * 浮窗只画未完成的行：勾掉即从这张小卡片消失。
 * 已完成的数据仍由主进程下发（`1/5` 这个进度读数要算得对），只是不再渲染成行；
 * 主窗口「今天」的「今日已完成」是另一条链路（recentlyDone），不受这里影响。
 */
function visibleTasks() {
  return (Array.isArray(view && view.tasks) ? view.tasks : []).filter((t) => !t.completed);
}

function renderList() {
  const scrollTop = el.list.scrollTop;
  const tasks = visibleTasks();
  if (!tasks.length) {
    el.list.innerHTML = '';
    return;
  }
  const kind = (view.projection && view.projection.kind) || 'group';
  const opts = {};

  // 「未完成」全部做完了：整窗换成空态，不留一个只有灰行的空列表
  if (kind === 'unfinished' && !Number(view.pending)) {
    el.list.innerHTML = '';
    return;
  }

  if (kind === 'unfinished') {
    const html = groupSections(tasks).map((sec) => {
      const rows = sec.rows.map((t) => {
        const overdue = sec.key === 'overdue' && !t.completed ? `逾期 ${overdueDays(t.plan_end)} 天` : '';
        const due = sec.key === 'later' ? dueLabel(t.plan_end) : '';
        // 逾期段行尾给天数，之后段给短日期；今天 / 未安排不占宽度
        return rowHtml(t, {
          ...opts, due, tail: overdue, sec: sec.key,
        });
      }).join('');
      return `<div class="dw-sec ${sec.cls}" data-sec="${sec.key}">
        <span class="dw-sec-label">${sec.label}</span>
        <span class="dw-sec-count">${sec.rows.filter((t) => !t.completed).length}</span>
      </div>${rows}`;
    }).join('');
    el.list.innerHTML = html;
  } else {
    const showDue = kind === 'upcoming';
    el.list.innerHTML = tasks.map((t) => rowHtml(t, { ...opts, due: showDue ? dueLabel(t.plan_end) : '' })).join('');
  }
  el.list.scrollTop = scrollTop;
  if (highlightId) {
    setTimeout(() => {
      const row = el.list.querySelector(`.dw-row[data-id="${highlightId}"]`);
      if (row) row.classList.remove('is-new');
      highlightId = null;
    }, 420);
  }
}

function renderHint() {
  const all = Array.isArray(view.tasks) ? view.tasks : [];
  const open = all.filter((t) => !t.completed);
  if (view.missing) {
    el.hint.hidden = false;
    el.hint.className = 'dw-hint';
    el.hint.innerHTML = '该清单已删除<b>，窗口即将自动关闭</b>';
    return;
  }
  if (view.error) {
    el.hint.hidden = false;
    el.hint.className = 'dw-hint is-link';
    el.hint.innerHTML = '数据未就绪，<b>点击重试</b>';
    return;
  }
  if (!open.length || ((view.projection || {}).kind === 'unfinished' && !Number(view.pending))) {
    const kind = (view.projection && view.projection.kind) || 'group';
    el.hint.hidden = false;
    el.hint.className = 'dw-hint';
    if (kind === 'unfinished') {
      // 全部完成不是「暂无数据」，是一句收尾 + 今天的战果
      const doneToday = all.filter((t) => t.completed).length;
      el.hint.innerHTML = '都做完了<b> · 今天到此为止</b>'
        + (doneToday ? `<br>今日完成 ${doneToday} 条` : '<br>在下方输入框直接加一条');
      return;
    }
    // 空态直接告诉用户下一步，不写「暂无数据」。
    // 视图投影（今天 / 即将到期）用「这里」，分组投影用「这个清单」——文案跟着宿主走。
    const where = kind === 'group' ? '这个清单' : '这里';
    // 勾完最后一条也走到这里：说「都完成了」，别用「还没有待办」否认刚做完的事
    if (all.length) {
      el.hint.innerHTML = `${where}都完成了<br><b>已完成的在主窗口里还能看到</b>`;
      return;
    }
    const tip = kind === 'upcoming' ? '在下方输入框添加，默认排在今天' : '在下方输入框直接添加';
    el.hint.innerHTML = `${where}还没有待办<br><b>${tip}</b>`;
    return;
  }
  el.hint.hidden = true;
  el.hint.innerHTML = '';
}

/* ---------------- 笔记投影：读 + 就地编辑 ---------------- */

/**
 * 为什么复用 wysiwyg.js 而不是自己写个 contenteditable：
 * 写回必须是 Markdown，而且要「未改动的块字节级不变」——否则打开一篇长笔记、
 * 改一个字、保存，整篇会被规范化（表格 / 代码块 / 颜色标记全丢）。
 * 那套块级原文保真 + turndown 规则已经在主窗口的笔记里跑了很久，浮窗直接用同一份，
 * 两处渲染与序列化才可能完全一致。
 */

function loadNoteScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`编辑器依赖加载失败：${src}`));
    document.head.appendChild(s);
  });
}

/**
 * 懒加载笔记所需资源（样式 + 4 个 UMD 依赖 + 两个模块）。
 * 只钉了清单的窗口不该为这 3000 行 CSS / 500KB 解析付代价，所以一律等到真钉了笔记再加载。
 */
async function ensureNoteAssets() {
  if (noteAssets) return noteAssets;
  if (!noteAssetsPromise) {
    noteAssetsPromise = (async () => {
      // head 里的顺序已经排好（styles → wysiwyg → desktop），这里只负责让它们生效
      document.querySelectorAll('link[data-note-css]').forEach((l) => { l.media = 'all'; });
      // UMD 全局：markdown-lib 要 window.markdownit / hljs，wysiwyg 要 window.turndown（+ gfm 插件）
      await loadNoteScript('vendor/markdown-it/markdown-it.min.js');
      await loadNoteScript('vendor/highlight/highlight.min.js');
      await loadNoteScript('vendor/turndown/turndown.js');
      await loadNoteScript('vendor/turndown/turndown-plugin-gfm.js');
      const [wys, auto] = await Promise.all([import('./wysiwyg.js'), import('./autosave.js')]);
      return {
        createWysiwyg: wys.createWysiwyg,
        createAutoSave: auto.createAutoSave,
        SAVE_STATE_TEXT: auto.SAVE_STATE_TEXT,
      };
    })().catch((e) => {
      noteAssetsPromise = null; // 失败不缓存，下次刷新可重试
      throw e;
    });
  }
  noteAssets = await noteAssetsPromise;
  return noteAssets;
}

function paintSaveState(st, info) {
  if (!el.noteState) return;
  const text = noteAssets ? noteAssets.SAVE_STATE_TEXT : null;
  el.noteState.textContent = st === 'error'
    ? `${(text && text.error) || '保存失败'}${info && info.message ? `：${info.message}` : ''}`
    : ((text && text[st]) || '');
  el.noteState.classList.toggle('is-error', st === 'error');
  noteDirty = st === 'pending' || st === 'saving' || st === 'error';
}

function paintNoteMeta(n) {
  if (!el.noteMeta) return;
  const words = Number(n && n.word_count) || 0;
  const when = n && n.updated_at ? fmtDateTime(n.updated_at) : '';
  el.noteMeta.textContent = `${words} 字${when ? ` · ${when}` : ''}`;
  el.noteMeta.title = when ? `最近更新：${when}` : '';
}

/** 进入 / 退出编辑态（视图与编辑器都跟着切，工具条在浮窗里不出现 —— 靠快捷键） */
function setNoteEditing(on) {
  if (!isNoteView() || !noteEditor) return;
  if (noteEditing === !!on) return;
  noteEditor.setEditing(!!on);
}

function createNoteEditor(assets) {
  noteEditor = assets.createWysiwyg({
    root: el.noteBody,
    pane: el.note,
    toolbar: null, // 286~380px 排不下工具条：加粗 / 标题走 Ctrl+B、Ctrl+Alt+1~3
    notify: (msg) => showQuickHint(msg),
    onInput: () => {
      noteDirty = true;
      if (noteSaver) noteSaver.schedule();
      fit();
    },
    onEditingChange: (on) => {
      noteEditing = !!on;
      el.noteTitle.hidden = !on;
      el.edit.classList.toggle('is-on', !!on);
      el.edit.textContent = on ? '✓ 完成' : '✎ 编辑';
      el.edit.title = on ? '退出编辑（Esc）' : '编辑这篇笔记（Ctrl+E）';
      // 编辑态标题栏只报状态：正文上方已经有可编辑的标题输入框，
      // 两处显示同一个标题在 380px 的小窗里会像重复了一遍
      if (on) {
        el.title.textContent = '编辑中…';
        el.title.title = '';
      } else {
        const t = (view && view.note && view.note.title) || '';
        el.title.textContent = t || '无标题笔记';
        el.title.title = t || '无标题笔记';
      }
      // 退出编辑必须立刻落库：防抖窗口里关窗 / 收起 = 白改
      if (!on && noteSaver) noteSaver.flush().catch(() => {});
      fit();
    },
    hooks: {
      exitEdit: () => setNoteEditing(false),
      enterEdit: () => setNoteEditing(true),
    },
  });

  noteSaver = assets.createAutoSave({
    delay: 700,
    save: async (payload) => {
      const saved = await api.notes.update(noteForId, payload);
      if (!saved || saved.__error) throw new Error((saved && saved.__error) || '保存失败');
      noteHash = saved.content_hash || noteHash;
      noteDirty = false;
      // 主进程广播会跳过来源窗口（不打断输入），所以字数 / 时间在这里自己补。
      // content_md 也要一起补：否则 view 里还是打开时那份，下次重绘（折叠再展开）
      // 会拿旧内容和 noteHash 比出「不一致」，把刚写的内容顶回旧版本。
      if (view && view.note) {
        view.note.title = saved.title || '';
        view.note.word_count = saved.word_count || 0;
        view.note.updated_at = saved.updated_at || view.note.updated_at;
        view.note.content_hash = saved.content_hash || view.note.content_hash;
        if (payload && typeof payload.content_md === 'string') view.note.content_md = payload.content_md;
        paintNoteMeta(view.note);
        // 标题可能刚被改：标题栏与 input 都同步（input 正在输入时不要回写，会跳光标）
        if (document.activeElement !== el.noteTitle) el.noteTitle.value = view.note.title;
        if (!noteEditing) {
          el.title.textContent = view.note.title || '无标题笔记';
          el.title.title = view.note.title || '无标题笔记';
        }
      }
      fit();
      return saved;
    },
    read: () => {
      if (!view || !view.note || !noteEditor) return null;
      return { title: el.noteTitle.value.trim(), content_md: noteEditor.value() };
    },
    onStatus: (st, info) => paintSaveState(st, info),
    onError: (e) => showQuickHint((e && e.message) || '保存失败'),
  });
}

/** 换了一篇笔记：内容与保存基线一起重建 */
function resetNoteContent(n) {
  noteEditor.value(n.content_md || '');
  noteHash = n.content_hash || '';
  el.noteTitle.value = n.title || '';
  if (noteSaver) {
    noteSaver.setBaseline({ title: n.title || '', content_md: n.content_md || '' });
  }
  paintSaveState('idle');
}

/**
 * 画笔记（异步：首次要先把编辑器依赖拉起来）。
 * 编辑中 / 有未保存改动时**绝不覆盖正文** —— 60 秒轮询、主窗口保存触发的 invalidate
 * 都会走到这里，覆盖一次就是把用户刚打的字抹掉。
 */
async function paintNote() {
  if (!view || !view.note) return;
  const token = ++noteToken;
  const n = view.note;
  // 编辑态标题栏写的是「编辑中…」：轮询 / invalidate 回来时别把它改回标题
  if (!noteEditing) {
    el.title.textContent = n.title || '无标题笔记';
    el.title.title = n.title || '无标题笔记';
  }
  paintNoteMeta(n);

  let assets;
  try {
    assets = await ensureNoteAssets();
  } catch (e) {
    showQuickHint((e && e.message) || '笔记编辑器加载失败');
    return;
  }
  // 期间又刷新 / 切走 / 折叠了：这次结果作废（别把内容写进已经不在的视图）
  if (token !== noteToken || !view || !view.note || isCollapsed()) return;

  if (!noteEditor) createNoteEditor(assets);
  if (noteForId !== n.id) {
    noteForId = n.id;
    resetNoteContent(n);
  } else if (!noteEditing && !noteDirty && n.content_hash !== noteHash) {
    // 主窗口里改过同一篇，本地又没有未保存内容 → 采用库里的版本
    noteEditor.value(n.content_md || '');
    noteHash = n.content_hash || '';
    el.noteTitle.value = n.title || '';
    if (noteSaver) noteSaver.setBaseline({ title: n.title || '', content_md: n.content_md || '' });
  }
  fit();
}

/** 笔记高度：按正文自然高度算（offsetHeight 不受滚动容器影响，避免「只涨不缩」的棘轮） */
function fitNote() {
  if (isCollapsed()) {
    api.desktop.fit(projectionId, isSideDock() ? Math.max(window.innerHeight, SIDE_MIN_H) : headHeight())
      .catch(() => {});
    return;
  }
  if (isSideDock() && window.innerWidth < SIDE_W * 0.6) return; // 还没展开成 320 宽，量了也不准
  const headH = headHeight();
  const titleH = el.noteTitle.hidden ? 0 : el.noteTitle.offsetHeight + 8;
  const padTop = 6;
  const padBottom = 10;
  const h = Math.max(
    NOTE_MIN_H,
    Math.min(MAX_H, headH + padTop + titleH + el.noteBody.offsetHeight + padBottom + FOOT_H),
  );
  api.desktop.fit(projectionId, h).catch(() => {});
}

function renderFatal(msg) {
  el.root.dataset.state = 'error';
  el.title.textContent = '数据未就绪';
  el.hint.hidden = false;
  el.hint.className = 'dw-hint';
  el.hint.textContent = msg;
  fit();
}

/** 内容自适应高度：三段固定，只有列表区伸缩；超过 520 就在列表里滚动 */
function fit() {
  if (isNoteView()) { fitNote(); return; }
  const collapsed = isCollapsed();
  if (collapsed) {
    // 顶条收起成一条只有 30px；普通浮窗收起是完整标题栏 42px；
    // 侧吸收起只改宽度（30px 竖条），高度原样保留 —— 传当前高度让主进程照抄
    const h = isSideDock() ? Math.max(window.innerHeight, SIDE_MIN_H) : headHeight();
    api.desktop.fit(projectionId, h).catch(() => {});
    return;
  }
  // 侧吸刚展开：主进程还没把窗口加宽（此刻仍是 30px），这时量出来的高度是「文字挤成一列」的结果，
  // 等加宽后再量（setCollapsed 里 await 之后会再调一次 fit）
  if (isSideDock() && window.innerWidth < SIDE_W * 0.6) return;
  const listMax = MAX_H - HEAD_H - FOOT_H;
  // 提示区也要算进高度：空态/错误态不是 0 高度；底部新增行在「清单已删除」态是隐藏的
  const footH = el.foot.hidden ? 0 : FOOT_H;
  const hintH = el.hint.hidden ? 0 : el.hint.scrollHeight;
  const listH = Math.min(el.list.scrollHeight + hintH, listMax);
  const h = Math.max(HEAD_H, Math.min(MAX_H, HEAD_H + listH + footH));
  api.desktop.fit(projectionId, h).catch(() => {});
}

/* ---------------- 交互 ---------------- */

function findTask(id) {
  return (view && Array.isArray(view.tasks) ? view.tasks : []).find((t) => String(t.id) === String(id)) || null;
}

/** 只重绘一行（乐观更新 → 失败回滚），避免整列表重建导致滚动跳动 */
function paintRow(task) {
  const row = el.list.querySelector(`.dw-row[data-id="${task.id}"]`);
  if (!row) return;
  row.classList.toggle('is-done', !!task.completed);
  row.setAttribute('aria-checked', String(!!task.completed));
  const box = row.querySelector('.dw-check');
  if (box) box.classList.toggle('on', !!task.completed);
  // 色点用类名而不是内联色：深色主题要靠 CSS 覆盖换一套更亮的档位色
  const priEl = row.querySelector('.dw-pri');
  if (priEl) priEl.className = `dw-pri p${priOf(task)}`;
  // 紧急行的左侧竖条 / 淡红底只对未完成有意义
  row.classList.toggle('is-urgent', priOf(task) === 3 && !task.completed);
}

/** 段头的小计数（勾选后立即更新，不让用户等到下一次刷新） */
function paintSectionCounts() {
  el.list.querySelectorAll('.dw-sec').forEach((sec) => {
    const n = el.list.querySelectorAll(`.dw-row[data-sec="${sec.dataset.sec}"]:not(.is-done)`).length;
    const badge = sec.querySelector('.dw-sec-count');
    if (badge) badge.textContent = String(n);
  });
}

/** 勾掉的行先淡出 180ms 再整表重建：看得到「勾上了」，也不至于拖着不走 */
let leaveTimer = null;
let clickGuardUntil = 0;
function rebuildAfterLeave() {
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    leaveTimer = null;
    if (!view || isNoteView() || isCollapsed()) return;
    renderList();
    renderHint();
    fit();
  }, 180);
}

async function toggleTask(taskId) {
  const t = findTask(taskId);
  if (!t) return;
  const prev = !!t.completed;
  t.completed = !prev;
  recount(); // 计数从本地列表直接算（乐观显示，主进程回来后以它为准）
  paintRow(t);
  if (!prev) {
    // 勾上 → 淡出并从列表移除（主窗口的「今日已完成」照旧保留，两条链路互不影响）
    const row = el.list.querySelector(`.dw-row[data-id="${t.id}"]`);
    if (row) row.classList.add('is-leaving');
    // 行没了，键盘的选中锚点必须一起失效，否则空格会去动一条看不见的任务
    if (selId === t.id) selId = null;
    clickGuardUntil = Date.now() + 260;
    rebuildAfterLeave();
  }
  try {
    const saved = await api.desktop.toggleTask(t.id);
    if (saved) {
      t.completed = !!saved.completed;
      recount();
      if (!t.completed) {
        // 服务端没认这次勾选（例如重复事项被规则拒绝）：把行放回来
        clearTimeout(leaveTimer);
        leaveTimer = null;
        renderList();
        renderHint();
        fit();
      } else {
        paintRow(t);
      }
    }
  } catch (e) {
    t.completed = prev;
    recount();
    clearTimeout(leaveTimer);
    leaveTimer = null;
    renderList();
    renderHint();
    fit();
    showQuickHint((e && e.message) || '操作失败');
  }
}

function recount() {
  if (!view || !view.tasks) return;
  view.counts.total = view.tasks.length;
  view.counts.done = view.tasks.filter((x) => x.completed).length;
  const p = view.projection || {};
  if (p.kind === 'unfinished') {
    // 「未完成」的头条数字：未勾掉的条数 + 逾期条数（勾一条要立刻少一）
    const today = todayStr();
    const open = view.tasks.filter((x) => !x.completed);
    view.pending = open.length;
    view.overdue = open.filter((t) => t.plan_end && t.plan_end < today).length;
    el.count.hidden = !view.overdue;
    el.count.textContent = view.overdue ? `逾期 ${view.overdue}` : '';
    el.count.title = `逾期 ${view.overdue} 条（未勾掉）`;
    el.count.classList.toggle('is-overdue', view.overdue > 0);
    el.pend.hidden = false;
    el.pend.textContent = pendText(view.pending);
    el.pend.title = `还有 ${view.pending} 条没勾掉`;
    paintSectionCounts();
  } else {
    el.count.textContent = `${view.counts.done} / ${view.counts.total}`;
  }
  // 指纹里的计数变了，下次 refresh 才会真正重建（这里先同步，避免重复重绘）
  lastSig = signature();
}

/** 一行临时提示：换掉底部提示区两秒钟，不做 toast（弹层在 286px 里太吵） */
let quickTimer = null;
function showQuickHint(msg) {
  const keep = el.hint.hidden ? '' : el.hint.innerHTML;
  el.hint.hidden = false;
  el.hint.className = 'dw-hint';
  el.hint.textContent = msg;
  clearTimeout(quickTimer);
  quickTimer = setTimeout(() => {
    if (!view) return;
    if (keep) {
      el.hint.hidden = false;
      el.hint.innerHTML = keep;
    } else {
      el.hint.hidden = true;
      el.hint.innerHTML = '';
    }
    fit();
  }, 2000);
  fit();
}

/* ---- 新增 ---- */

function openAdd() {
  el.add.hidden = true;
  el.addInput.hidden = false;
  el.addInput.value = '';
  el.addInput.focus();
  fit();
}

function closeAdd() {
  el.addInput.hidden = true;
  el.add.hidden = false;
  el.addInput.value = '';
  fit();
}

async function submitAdd() {
  const title = el.addInput.value.trim();
  if (!title) return; // 空回车什么也不做（Esc 才是退出）
  if (el.addInput.disabled) return;
  el.addInput.disabled = true;
  try {
    const t = await api.desktop.addTask(projectionId, title);
    if (t && t.id) highlightId = t.id;
    el.addInput.value = '';
    await refresh();
  } catch (e) {
    showQuickHint((e && e.message) || '添加失败');
  } finally {
    el.addInput.disabled = false;
    // 保持输入态：连续加几条是常见用法，回车即建、停在原地。
    // 注意顺序 —— 输入框 disabled 时 focus() 是无效的，必须先恢复再聚焦。
    el.addInput.focus();
  }
}

/* ---- 折叠 ---- */

async function setCollapsed(next) {
  if (!view || !view.projection) return;
  if (!!view.projection.collapsed === !!next) return;
  view.projection.collapsed = !!next;
  if (isSideDock()) {
    // 侧吸：宽度由主进程在 30 ↔ 320 之间切换。**先切宽度再重排** ——
    // 反过来会拿 30px 宽的布局去量高度（文字挤成一列），算出来的高度完全不是那个意思。
    try {
      await api.desktop.update(projectionId, { collapsed: !!next });
    } catch (e) {
      view.projection.collapsed = !next;
    }
    render();
    fit();
    // 窗口宽度变化要等一拍才反映到 layout（window.innerWidth 此时可能还是 30），
    // 补量一次：展开态的高度必须按 320 宽的真实排版算
    setTimeout(fit, 60);
    return;
  }
  render();
  try {
    await api.desktop.update(projectionId, { collapsed: !!next });
  } catch (e) {
    view.projection.collapsed = !next;
    render();
  }
}

/** 「保持展开」：dock 手动钉住后，鼠标移开也不收回（只能再点一次或 Esc） */
async function setDockPinned(next) {
  if (!view || !view.projection) return;
  view.projection.dockPinned = !!next;
  try {
    await api.desktop.update(projectionId, { dockPinned: !!next });
  } catch (e) {
    view.projection.dockPinned = !next;
  }
}

/* ---- 清单已删除 ---- */

function enterMissing() {
  if (missingTimer) return;
  // 提示语按投影类型写死：view.title 此刻还是「删除前」的标题（主进程只是发了 missing 事件）
  const kind = (view && view.projection && view.projection.kind) || '';
  const gone = kind === 'note' ? '该笔记已删除' : '该清单已删除';
  // 一个 286px 的窗口任何状态下只允许「一个主信息」：清单 / 笔记没了就把旧内容清干净，
  // 否则用户会看到一份「已经不存在的东西」的残留
  if (view) {
    view.missing = true;
    view.tasks = [];
    view.note = null;
    view.counts = { done: 0, total: 0 };
  }
  el.root.dataset.state = 'missing';
  el.title.textContent = gone;
  el.count.hidden = true;
  el.dot.hidden = true;
  el.list.innerHTML = '';
  el.list.hidden = false;
  el.note.hidden = true;
  el.noteBar.hidden = true;
  noteToken += 1; // 作废进行中的 paintNote
  lastSig = '';
  el.foot.hidden = true;
  el.hint.hidden = false;
  el.hint.className = 'dw-hint';
  el.hint.innerHTML = `${esc(gone)}<b>，窗口即将自动关闭</b>`;
  fit();
  // 关闭前给 3 秒提示，不做静默消失
  missingTimer = setTimeout(() => {
    api.desktop.unpin(projectionId).catch(() => {});
  }, 3000);
}

/* ---------------- dock 悬停时序 ---------------- */

let dockOpenTimer = null;
let dockCloseTimer = null;

function clearDockTimers() {
  if (dockOpenTimer) { clearTimeout(dockOpenTimer); dockOpenTimer = null; }
  if (dockCloseTimer) { clearTimeout(dockCloseTimer); dockCloseTimer = null; }
}

/**
 * 四种情况不许收回：① 手动点了「保持展开」② 正在输入新待办
 * （③ 正在拖滚动条 / 勾选 —— 指针还在窗口内，本来就不会触发 mouseleave）。
 */
function dockShouldStayOpen() {
  if (isDockPinned()) return true;
  if (!el.addInput.hidden) return true;
  // 正在编辑笔记：鼠标一移开就收起，等于把窗口从眼前拿走
  if (isNoteView() && (noteEditing || noteDirty)) return true;
  return false;
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  el.list.addEventListener('click', (e) => {
    const row = e.target.closest('.dw-row');
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'open') {
        api.desktop.openInMain(Number(id)).catch(() => {});
        return;
      }
      if (act.dataset.act === 'del') {
        api.desktop.deleteTask(projectionId, Number(id))
          .then((r) => { if (r && r.ok) refresh(); })
          .catch((err) => showQuickHint((err && err.message) || '删除失败'));
        return;
      }
    }
    if (view && view.missing) return;
    // 刚勾掉一条时下面的行会上移，紧接着的第二下点击会落到邻居身上（连点误勾）——260ms 内不吃
    if (Date.now() < clickGuardUntil) return;
    selId = Number(id);
    toggleTask(Number(id));
  });

  el.collapse.addEventListener('click', (e) => {
    e.stopPropagation();
    // dock 上手动收起 = 取消「保持展开」，否则下次悬停前它又会被算作 pinned
    if (isDock() && !isCollapsed()) setDockPinned(false);
    setCollapsed(!isCollapsed());
  });

  // dock 收起条：📌 展开并「保持展开」（标题栏是拖动区，吞点击，所以只能挂在按钮上）
  el.pin.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isDock()) return;
    const on = !isDockPinned();
    setDockPinned(on);
    setCollapsed(!on);
  });

  // 更多：交给主进程弹原生菜单（透明小窗里放不下二级菜单，原生菜单不会被裁掉）
  el.more.addEventListener('click', (e) => {
    e.stopPropagation();
    api.desktop.menu(projectionId).catch(() => {});
  });

  el.add.addEventListener('click', (e) => { e.stopPropagation(); openAdd(); });

  /* ---- 笔记投影：编辑开关 / 标题输入 ---- */
  el.edit.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isNoteView() || !noteEditor) return;
    setNoteEditing(!noteEditing);
  });
  el.noteTitle.addEventListener('input', () => {
    if (!view || !view.note) return;
    view.note.title = el.noteTitle.value;
    // 编辑态标题栏写的是「编辑中…」，别把用户正在敲的标题同步上去（会一抖一抖地变）
    if (!noteEditing) el.title.textContent = el.noteTitle.value.trim() || '无标题笔记';
    noteDirty = true;
    if (noteSaver) noteSaver.schedule();
    fit();
  });
  el.noteTitle.addEventListener('keydown', (e) => {
    e.stopPropagation();
    // 回车 / 下箭头把光标交回正文：标题下面就是要写的东西
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      el.noteBody.focus();
    }
  });

  el.addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAdd(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeAdd(); }
    e.stopPropagation();
  });
  el.addInput.addEventListener('blur', () => {
    // 输入为空时失焦收起，避免悬空一个空输入框
    if (!el.addInput.value.trim()) closeAdd();
  });

  // 提示区可点击的两态：错误态重试 / 其他忽略
  el.hint.addEventListener('click', () => {
    if (view && view.error) refresh();
  });

  // 键盘：上下选中、空格勾选、Ctrl+N 新增（窗口聚焦时生效）
  document.addEventListener('keydown', (e) => {
    const inInput = e.target === el.addInput;
    // 笔记窗的键盘交给编辑器：Ctrl+E 切编辑态，Esc / 加粗 / 标题等由 wysiwyg 自己处理
    if (isNoteView()) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setNoteEditing(!noteEditing);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      openAdd();
      return;
    }
    if (inInput) return;
    // dock：Esc 收起（保持展开态时也一样，这是文档约定的「只能再点一次或 Esc 收起」）
    if (e.key === 'Escape' && isDock() && !isCollapsed()) {
      e.preventDefault();
      clearDockTimers();
      if (isDockPinned()) setDockPinned(false);
      setCollapsed(true);
      return;
    }
    // 只在「看得见的行」之间移动：已完成的不在列表里，选中它们等于让高亮消失
    const tasks = visibleTasks();
    if (!tasks.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = tasks.findIndex((t) => t.id === selId);
      const next = e.key === 'ArrowDown'
        ? Math.min(tasks.length - 1, i < 0 ? 0 : i + 1)
        : Math.max(0, i < 0 ? tasks.length - 1 : i - 1);
      selId = tasks[next].id;
      renderList();
      el.list.querySelector(`.dw-row[data-id="${selId}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      if (selId == null) return;
      e.preventDefault();
      toggleTask(selId);
    }
  });

  /* ---- 右下角缩放：只调宽（高度永远随内容）。
         用 screenX 累加：窗口自身在变宽，clientX 会跟着漂，screenX 不会 ---- */
  let drag = null;
  el.grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag = {
      sx: e.screenX, w: Math.round(el.root.getBoundingClientRect().width), raf: 0,
    };
    el.grip.setPointerCapture(e.pointerId);
  });
  el.grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = Math.min(MAX_W, Math.max(MIN_W, drag.w + (e.screenX - drag.sx)));
    if (drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      drag.raf = 0;
      api.desktop.size(projectionId, w).catch(() => {});
    });
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try { el.grip.releasePointerCapture(e.pointerId); } catch (err) { /* 指针已释放 */ }
  };
  el.grip.addEventListener('pointerup', endDrag);
  el.grip.addEventListener('pointercancel', endDrag);
  el.grip.addEventListener('dblclick', () => {
    // 双击手柄恢复默认宽度（高度仍随内容）
    api.desktop.size(projectionId, DEFAULT_W).catch(() => {});
  });

  // 悬停置顶档：鼠标进出时临时置顶（这一条只跟 pinMode 有关，普通浮窗与 dock 都适用）
  document.addEventListener('mouseenter', () => {
    api.desktop.hover(projectionId, true).catch(() => {});
  });
  document.addEventListener('mouseleave', () => {
    api.desktop.hover(projectionId, false).catch(() => {});
  });

  /* dock 的展开 / 收起由主进程驱动的指针位置决定（`desktop:pointer`），不用 DOM 事件：
     吸边窗的标题栏是 drag 区（要能拖着换位置），**drag 区不派发 DOM 鼠标事件** ——
     30px 宽的竖条整窗都是 drag，鼠标移上去连 mouseenter 都收不到，就是「悬停不展开」；
     反过来，展开态指针停在标题栏（也是 drag 区）时 DOM 会误报 mouseleave，变成「展开就收回」。
     主进程按系统指针是否落在窗口矩形里判断，两个方向都准。 */
  api.on('desktop:pointer', (inside) => {
    if (!isDock()) return;
    clearDockTimers();
    if (inside) {
      // 进入 120ms 后展开：正常手速划过约 80–150ms，没延迟每次路过都闪一下
      if (!isCollapsed()) return;
      dockOpenTimer = setTimeout(() => {
        dockOpenTimer = null;
        if (!isDock() || !isCollapsed()) return;
        setCollapsed(false);
      }, DOCK_OPEN_DELAY);
      return;
    }
    // 离开 400ms 后收回：窗口刚变宽 / 变高时指针可能一瞬间落在窗口外，
    // 太短就是「展开—收回—再展开」的抽搐
    if (isCollapsed() || dockShouldStayOpen()) return;
    dockCloseTimer = setTimeout(() => {
      dockCloseTimer = null;
      if (!isDock() || dockShouldStayOpen()) return;
      setCollapsed(true);
    }, DOCK_CLOSE_DELAY);
  });

  // 主进程事件
  api.on('desktop:invalidate', (id) => { if (id === projectionId) refresh(); });
  api.on('desktop:missing', (id) => { if (id === projectionId) enterMissing(); });
  api.on('desktop:collapsed', (v) => {
    if (!view || !view.projection) return;
    view.projection.collapsed = !!v;
    render();
    // 侧吸：宽度是主进程先改的，渲染层的 layout 可能还差一拍才跟上，补量一次高度
    if (isSideDock()) setTimeout(fit, 80);
  });
  // 吸边窗被拖离那条边：主进程已清掉 dock，这里跟着变回普通浮窗（重新量高度）
  api.on('desktop:undocked', (from) => {
    if (!view || !view.projection) return;
    view.projection.dock = null;
    view.projection.dockPinned = false;
    view.projection.collapsed = false;
    clearDockTimers();
    lastSig = '';
    // 回头路要写出来：拖离之后没有任何手势能吸回去，只能走 ⋯ 菜单。
    // 必须等 refresh 画完再提示，否则 renderHint 会把这条提示盖掉。
    const where = from === 'left' || from === 'right' ? '屏幕边缘' : '屏幕顶边';
    refresh().then(() => showQuickHint(`已拖离${where} · ⋯ 菜单可贴回`), () => {});
  });
  // 被吸回某条边（拖到边缘自动吸附 / ⋯ 菜单）：变回吸边形态并收起
  api.on('desktop:redocked', (side) => {
    if (!view || !view.projection) return;
    view.projection.dock = (side === 'left' || side === 'right') ? side : 'top';
    view.projection.dockPinned = false;
    view.projection.collapsed = true;
    clearDockTimers();
    lastSig = '';
    // 主进程已经把窗口改成 420×30（顶条）或 320×h / 30×h（侧条）并贴好边了，
    // 这里只负责把内容切成吸边形态。
    // 不给提示：收起的窄条上塞不进一行字，形态变化本身就是反馈（碰一下就会展开）。
    refresh();
  });

  // 窗口重新获得焦点 / 跨天：轻量刷新一次（浮窗开了整夜也能看到新的一天）
  window.addEventListener('focus', () => { refresh(); });
  // 失焦立刻落库：防抖窗口里切走 / 最小化不该丢掉刚打的字
  window.addEventListener('blur', () => {
    if (noteSaver) noteSaver.flush().catch(() => {});
  });
  setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
}

/* ---------------- 启动 ---------------- */

bind();
load();
