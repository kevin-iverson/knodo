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
import { api } from './api.js';

const query = new URLSearchParams(location.search);
const projectionId = query.get('id') || '';

const el = {
  root: document.getElementById('dw'),
  head: document.getElementById('dw-head'),
  dot: document.getElementById('dw-dot'),
  title: document.getElementById('dw-title'),
  count: document.getElementById('dw-count'),
  collapse: document.getElementById('dw-collapse'),
  more: document.getElementById('dw-more'),
  body: document.getElementById('dw-body'),
  list: document.getElementById('dw-list'),
  hint: document.getElementById('dw-hint'),
  foot: document.getElementById('dw-foot'),
  add: document.getElementById('dw-add'),
  addInput: document.getElementById('dw-add-input'),
  grip: document.getElementById('dw-grip'),
};

/** 视觉常量：与 desktop.css / 主进程 desktop-window.js 保持一致 */
const HEAD_H = 42;
const FOOT_H = 36;
const MAX_H = 520;
const MIN_W = 240;
const MAX_W = 460;
const DEFAULT_W = 286;

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

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ---------------- 主题 ---------------- */

/**
 * 只跟随系统 / 应用的 prefers-color-scheme：主进程设置 nativeTheme.themeSource 之后，
 * 这一层会自动跟着变（包括用户在主窗口点「主题」切换的情况），不需要额外的 IPC。
 */
const mq = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
}
applyTheme();
if (mq.addEventListener) mq.addEventListener('change', applyTheme);

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
    // 读失败不要把已有内容清空（数据库短暂占用时，界面上保留旧数据比一片空白好）
    if (!view || !view.tasks || !view.tasks.length) {
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

function signature() {
  if (!view) return 'none';
  const t = (view.tasks || []).map((x) => `${x.id}:${x.completed ? 1 : 0}:${x.title}:${x.parent_id || ''}:${x.plan_end || ''}`).join('|');
  // 番茄钟：只把「哪个任务 / 什么状态 / 计划时长」放进指纹（不要放 focusedMs/segStart，
  // 否则每 500ms 的本地 tick 都会触发整表重建）
  const f = view.focus;
  const fSig = f && f.active ? `${f.taskId}:${f.mode}:${f.plannedSec}` : '-';
  return `${view.title}|${view.counts ? view.counts.done : 0}/${view.counts ? view.counts.total : 0}|${view.error || ''}|${view.missing ? 1 : 0}|${isCollapsed() ? 1 : 0}|${t}|${highlightId || ''}|${fSig}`;
}

function render() {
  if (!view) return;
  const collapsed = isCollapsed();
  el.root.classList.toggle('is-collapsed', collapsed);
  el.collapse.classList.toggle('is-rotated', collapsed);
  el.collapse.title = collapsed ? '展开清单' : '折叠为标题条';

  // 标题栏
  if (view.missing) {
    el.root.dataset.state = 'missing';
    el.title.textContent = view.title || '该清单已删除';
    el.dot.hidden = true;
    el.count.hidden = true;
  } else if (view.error) {
    el.root.dataset.state = 'error';
    el.title.textContent = view.title || '数据未就绪';
    el.dot.hidden = true;
    el.count.hidden = true;
  } else {
    el.root.dataset.state = 'ready';
    el.title.textContent = view.title || '清单';
    el.title.title = view.title || '';
    if (view.color) {
      el.dot.hidden = false;
      el.dot.style.background = view.color;
    } else {
      el.dot.hidden = true;
    }
    const c = view.counts || { done: 0, total: 0 };
    el.count.hidden = false;
    el.count.textContent = `${c.done} / ${c.total}`;
    el.count.title = `已完成 ${c.done} / 共 ${c.total}`;
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

/* ---------------- 番茄钟（浮窗只做「看」：显示正在专注那一格的倒计时，不提供入口） ---------------- */

/** 当前正在专注（running/paused）的任务 id；未专注或已进入收尾态返回 null */
function focusedTaskId() {
  const f = view && view.focus;
  if (!f || !f.active) return null;
  if (f.mode !== 'running' && f.mode !== 'paused') return null;
  return f.taskId != null ? Number(f.taskId) : null;
}

/** 剩余毫秒（按 wall clock：段起点 + 当前时间；running 永远推进，不因失焦冻结） */
function focusRemainMs(f) {
  if (!f || !f.active) return 0;
  if (f.mode === 'running') {
    return Math.max(0, f.plannedSec * 1000 - f.focusedMs - (Date.now() - f.segStart));
  }
  return Math.max(0, f.plannedSec * 1000 - f.focusedMs);
}

function fmtRemain(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 进度环：14px、2px 描边，与主窗口同一套视觉 */
function focusRingHtml(f) {
  const C = 2 * Math.PI * 5;
  const remain = focusRemainMs(f);
  const progress = f.plannedSec > 0
    ? Math.max(0, Math.min(1, (f.plannedSec * 1000 - remain) / (f.plannedSec * 1000)))
    : 0;
  return `<span class="dw-focus-ring" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14">
    <circle class="dw-fr-bg" cx="7" cy="7" r="5"></circle>
    <circle class="dw-fr-fg" cx="7" cy="7" r="5" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - progress)}"></circle>
  </svg></span>`;
}

function renderList() {
  const scrollTop = el.list.scrollTop;
  const tasks = Array.isArray(view.tasks) ? view.tasks : [];
  if (!tasks.length) {
    el.list.innerHTML = '';
    return;
  }
  const kind = (view.projection && view.projection.kind) || 'group';
  const showDue = kind === 'upcoming';
  const f = view.focus;
  const fId = focusedTaskId();
  const fPaused = !!(f && f.mode === 'paused');
  el.list.innerHTML = tasks.map((t) => {
    const done = !!t.completed;
    const isFocus = fId != null && Number(t.id) === fId;
    const cls = [
      'dw-row',
      done ? 'is-done' : '',
      t.parent_id ? 'is-child' : '',
      t.id === selId ? 'is-sel' : '',
      t.id === highlightId ? 'is-new' : '',
      isFocus ? 'is-focus' : '',
      isFocus && fPaused ? 'is-paused' : '',
    ].filter(Boolean).join(' ');
    const due = showDue ? dueLabel(t.plan_end) : '';
    // 专注行：进度环 + 倒计时成组放在右侧（环在倒计时左边），不占左侧复选框的位置
    const focusGroup = isFocus
      ? `<span class="dw-focus">${focusRingHtml(f)}<span class="dw-focus-remain">${fmtRemain(focusRemainMs(f))}</span></span>`
      : '';
    return `<div class="${cls}" data-id="${t.id}" role="checkbox" aria-checked="${done}" title="${esc(t.title)}">
      <span class="dw-check${done ? ' on' : ''}"></span>
      <span class="dw-text">${esc(t.title)}</span>
      ${due ? `<span class="dw-due${due === '今天' || due === '明天' ? ' is-soon' : ''}">${esc(due)}</span>` : ''}
      ${focusGroup}
      <span class="dw-row-acts">
        <button type="button" class="dw-row-btn" data-act="open" title="在主窗口打开">↗</button>
        <button type="button" class="dw-row-btn" data-act="del" title="删除任务">✕</button>
      </span>
    </div>`;
  }).join('');
  el.list.scrollTop = scrollTop;
  if (highlightId) {
    setTimeout(() => {
      const row = el.list.querySelector(`.dw-row[data-id="${highlightId}"]`);
      if (row) row.classList.remove('is-new');
      highlightId = null;
    }, 420);
  }
}

/** 本地 500ms：只更新倒计时文本与环，不重建列表（不打断滚动 / 悬停） */
function tickFocus() {
  const f = view && view.focus;
  if (!f || !f.active || (f.mode !== 'running' && f.mode !== 'paused')) return;
  const row = el.list.querySelector(`.dw-row[data-id="${f.taskId}"]`);
  if (!row) return;
  const remainEl = row.querySelector('.dw-focus-remain');
  if (remainEl) remainEl.textContent = fmtRemain(focusRemainMs(f));
  const fg = row.querySelector('.dw-focus-ring .dw-fr-fg');
  if (fg) {
    const C = 2 * Math.PI * 5;
    const remain = focusRemainMs(f);
    const progress = f.plannedSec > 0
      ? Math.max(0, Math.min(1, (f.plannedSec * 1000 - remain) / (f.plannedSec * 1000)))
      : 0;
    fg.setAttribute('stroke-dashoffset', String(C * (1 - progress)));
  }
}

function renderHint() {
  const tasks = Array.isArray(view.tasks) ? view.tasks : [];
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
  if (!tasks.length) {
    // 空态直接告诉用户下一步，不写「暂无数据」。
    // 视图投影（今天 / 即将到期）用「这里」，分组投影用「这个清单」——文案跟着宿主走。
    const kind = (view.projection && view.projection.kind) || 'group';
    const where = kind === 'group' ? '这个清单' : '这里';
    const tip = kind === 'upcoming' ? '在下方输入框添加，默认排在今天' : '在下方输入框直接添加';
    el.hint.hidden = false;
    el.hint.className = 'dw-hint';
    el.hint.innerHTML = `${where}还没有待办<br><b>${tip}</b>`;
    return;
  }
  el.hint.hidden = true;
  el.hint.innerHTML = '';
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
  const collapsed = isCollapsed();
  if (collapsed) {
    api.desktop.fit(projectionId, HEAD_H).catch(() => {});
    return;
  }
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
  el.count.textContent = `${view.counts.done} / ${view.counts.total}`;
}

async function toggleTask(taskId) {
  const t = findTask(taskId);
  if (!t) return;
  const prev = !!t.completed;
  t.completed = !prev;
  recount(); // 计数从本地列表直接算（乐观显示，主进程回来后以它为准）
  paintRow(t);
  try {
    const saved = await api.desktop.toggleTask(t.id);
    if (saved) {
      t.completed = !!saved.completed;
      recount();
      paintRow(t);
    }
  } catch (e) {
    t.completed = prev;
    recount();
    paintRow(t);
    showQuickHint((e && e.message) || '操作失败');
  }
}

function recount() {
  if (!view || !view.tasks) return;
  view.counts.total = view.tasks.length;
  view.counts.done = view.tasks.filter((x) => x.completed).length;
  el.count.textContent = `${view.counts.done} / ${view.counts.total}`;
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
  render();
  try {
    await api.desktop.update(projectionId, { collapsed: !!next });
  } catch (e) {
    view.projection.collapsed = !next;
    render();
  }
}

/* ---- 清单已删除 ---- */

function enterMissing() {
  if (missingTimer) return;
  // 一个 286px 的窗口任何状态下只允许「一个主信息」：清单没了就把旧任务清干净，
  // 否则用户会看到一份「已经不存在的清单」的残留列表
  if (view) {
    view.missing = true;
    view.tasks = [];
    view.counts = { done: 0, total: 0 };
  }
  el.root.dataset.state = 'missing';
  el.title.textContent = '该清单已删除';
  el.count.hidden = true;
  el.dot.hidden = true;
  el.list.innerHTML = '';
  lastSig = '';
  el.foot.hidden = true;
  el.hint.hidden = false;
  el.hint.className = 'dw-hint';
  el.hint.innerHTML = '该清单已删除<b>，窗口即将自动关闭</b>';
  fit();
  // 关闭前给 3 秒提示，不做静默消失
  missingTimer = setTimeout(() => {
    api.desktop.unpin(projectionId).catch(() => {});
  }, 3000);
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
    selId = Number(id);
    toggleTask(Number(id));
  });

  el.collapse.addEventListener('click', (e) => {
    e.stopPropagation();
    setCollapsed(!isCollapsed());
  });

  // 更多：交给主进程弹原生菜单（透明小窗里放不下二级菜单，原生菜单不会被裁掉）
  el.more.addEventListener('click', (e) => {
    e.stopPropagation();
    api.desktop.menu(projectionId).catch(() => {});
  });

  el.add.addEventListener('click', (e) => { e.stopPropagation(); openAdd(); });

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
    if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      openAdd();
      return;
    }
    if (inInput) return;
    const tasks = (view && view.tasks) || [];
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

  // 悬停置顶档：鼠标进出时临时置顶
  document.addEventListener('mouseenter', () => { api.desktop.hover(projectionId, true).catch(() => {}); });
  document.addEventListener('mouseleave', () => { api.desktop.hover(projectionId, false).catch(() => {}); });

  // 主进程事件
  api.on('desktop:invalidate', (id) => { if (id === projectionId) refresh(); });
  api.on('desktop:missing', (id) => { if (id === projectionId) enterMissing(); });
  api.on('desktop:collapsed', (v) => {
    if (!view || !view.projection) return;
    view.projection.collapsed = !!v;
    render();
  });

  // 窗口重新获得焦点 / 跨天：轻量刷新一次（浮窗开了整夜也能看到新的一天）
  window.addEventListener('focus', () => { refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
  // 番茄钟倒计时：500ms 本地重算（不依赖主进程推送，浮窗隐藏时也不会停摆）
  setInterval(tickFocus, 500);
}

/* ---------------- 启动 ---------------- */

bind();
load();
