'use strict';
/**
 * 工时插件在渲染层的唯一入口：mount() / unmount()。
 *
 * 入口「🕒 工时」是**常驻**的（index.html 的 .tb-nav 里，统计右侧），不在这里插 / 摘 ——
 * 功能关闭时点进来由 ui.js#renderWorklogOff 给「未启用」引导页。
 * 关闭状态下这个文件不会被 import，所以关闭态渲染层没有任何工时 DOM / CSS / handler。
 *
 * 计时入口只在任务行内（▶ 计时 / ☯ 禅模式 / ■ 结束），详情抽屉里不再有工时块。
 */
import { api } from '../api.js';
import { navigateTo, toast, renderTasks } from '../ui.js';
import { EXT } from '../ext.js';
import { live, setSnap, onSnap, elapsedMs, isActive } from './shared.js';
import * as view from './view.js';
import * as bar from './timer-bar.js';
import * as zen from './zen.js';

const CSS_ID = 'wl-css';
let mounted = false;
let offSnap = null;
let featureBound = false;
let changedBound = false;
let tickTimer = null;

/** 主进程计时状态 → 本地快照（底部计时条 / 禅模式 / 行内按钮 / 视图都吃这一份） */
function bindChanged() {
  if (changedBound) return;
  changedBound = true;
  api.on('worklog:changed', (snap) => {
    if (mounted && snap) setSnap(snap);
  });
}

/** 设置里改配置项（zenDefaultSec）时同步，不重挂模块 */
function bindFeature() {
  if (featureBound) return;
  featureBound = true;
  api.on('feature:changed', (p) => { if (mounted) applyPref(p); });
}

/* ------------------------------ 外壳 ------------------------------ */

function injectCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.id = CSS_ID;
  link.rel = 'stylesheet';
  link.href = 'css/worklog.css';
  document.head.appendChild(link);
}

function removeCss() {
  const link = document.getElementById(CSS_ID);
  if (link) link.remove();
}

/* ------------------------------ 任务行内计时 ------------------------------ */

/** 行内时钟：<1h 用 mm:ss，≥1h 用 h:mm:ss —— 行内只有几十像素，不显示小时的前导零 */
function rowClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h
    ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
    : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** 行内按钮：▶（计时 / 暂停）· ☯（禅模式）· ■（结束，仅计时中可见） */
function renderRowExtra({ task, el }) {
  if (!task || !el || !task.id) return;
  const actions = el.querySelector('.task-actions');
  if (!actions) return;

  // 已完成的任务不再往上面开计时（补录走工时视图的那个入口）；
  // 但「它自己正在计时」这一条要留着，否则勾掉完成就再也点不到「结束」。
  const mine0 = isActive(live.snap) && Number(live.snap.taskId) === Number(task.id);
  if (task.completed && !mine0) return;

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'wl-row-ico wl-run';
  run.dataset.wlRowRun = '';
  run.dataset.taskId = String(task.id);

  const zenBtn = document.createElement('button');
  zenBtn.type = 'button';
  zenBtn.className = 'wl-row-ico';
  zenBtn.dataset.wlRowZen = '';
  zenBtn.dataset.taskId = String(task.id);
  zenBtn.textContent = '☯';
  zenBtn.title = '禅模式：全屏静默计时（通知静默、不统计离开）';

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'wl-row-ico wl-row-stop';
  stopBtn.dataset.wlRowStop = '';
  stopBtn.dataset.taskId = String(task.id);
  stopBtn.textContent = '■';
  stopBtn.title = '结束并记录工时';

  run.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const snap = live.snap;
    const mine = isActive(snap) && Number(snap.taskId) === Number(task.id);
    try {
      if (!mine) await api.worklog.start({ taskId: task.id, source: 'timer' });
      else if (snap.mode === 'running') await api.worklog.pause();
      else await api.worklog.resume();
    } catch (err) {
      toast((err && err.message) || '操作失败');
    }
  });

  zenBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const mine = isActive(live.snap) && Number(live.snap.taskId) === Number(task.id);
      if (!mine) await api.worklog.start({ taskId: task.id, source: 'zen' });
      zen.show();
    } catch (err) {
      toast((err && err.message) || '进入禅模式失败');
    }
  });

  stopBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await bar.stop();
  });

  actions.insertBefore(run, actions.firstChild);
  actions.insertBefore(zenBtn, run.nextSibling);
  actions.insertBefore(stopBtn, zenBtn.nextSibling);

  paintRow(run, stopBtn);
}

/** 单个行内按钮组按当前快照上色（不重绘列表，避免丢滚动 / 丢 hover） */
function paintRow(run, stopBtn) {
  if (!run) return;
  const snap = live.snap;
  const mine = isActive(snap) && Number(snap.taskId) === Number(run.dataset.taskId);
  const paused = mine && snap.mode === 'paused';

  run.classList.toggle('is-run', mine);
  run.classList.toggle('is-paused', paused);
  run.title = mine
    ? (paused ? '已暂停，点击继续' : '正在计时，点击暂停')
    : '开始工时计时';

  if (mine) {
    let t = run.querySelector('[data-wl-row-time]');
    if (!t) {
      run.textContent = '';
      t = document.createElement('span');
      t.className = 'wl-row-time num';
      t.dataset.wlRowTime = '';
      run.appendChild(t);
    }
    t.textContent = rowClock(elapsedMs(snap));
  } else {
    // 直接赋值会清掉时间 span 子节点
    run.textContent = '▶';
  }

  if (stopBtn) stopBtn.classList.toggle('is-off', !mine);
}

/** 遍历列表里所有行内按钮组，按当前快照统一上色 */
function paintRows() {
  document.querySelectorAll('[data-wl-row-run]').forEach((run) => {
    paintRow(run, run.parentElement && run.parentElement.querySelector('[data-wl-row-stop]'));
  });
}

/** 每秒只改时间文本与按钮态，不动 DOM 结构 */
function tickRows() {
  if (!isActive(live.snap)) return;
  const txt = rowClock(elapsedMs(live.snap));
  document.querySelectorAll('[data-wl-row-time]').forEach((n) => { n.textContent = txt; });
}

/* ------------------------------ 生命周期 ------------------------------ */

export async function mount() {
  if (mounted) return;
  mounted = true;
  injectCss();
  bindFeature();
  bindChanged();

  // 扩展点：视图路由 + 任务行内计时按钮（详情抽屉里不再有工时块）
  EXT.views.worklog = {
    title: '工时',
    desc: '子任务向上累积 · 可按分组导出报工表',
    long: '按时间范围统计任务工时；父任务合计 = 自身 + 全部后代，绝不重复计入',
    render: view.render,
  };
  EXT.taskRowExtra.push(renderRowExtra);

  bar.mount();
  zen.mount();
  tickTimer = setInterval(tickRows, 1000);

  offSnap = onSnap(() => {
    bar.paint();
    zen.paint();
    paintRows();
    view.refresh();
  });

  try {
    const pref = await api.features.pref();
    if (pref) live.pref = pref;
  } catch (e) { /* 读不到偏好就按默认值 */ }

  try {
    const snap = await api.worklog.state();
    if (snap) setSnap(snap);
  } catch (e) { /* 数据库未就绪：计时条保持隐藏 */ }

  try {
    const notices = await api.worklog.notices();
    for (const n of notices || []) toast(n);
  } catch (e) { /* 忽略 */ }

  // 用户可能正停在「未启用」引导页上就把开关打开了：重绘一次，换成真视图
  const navBtn = document.querySelector('.nav-item[data-view="worklog"]');
  if (navBtn && navBtn.classList.contains('active')) navigateTo('worklog');
}

export function unmount() {
  if (!mounted) return;
  mounted = false;

  // 先在视图还带着插件 DOM 时判断「用户此刻正停在工时页」：入口是常驻的，
  // 卸载后不能把人踢回任务列表，而应重绘成「未启用」引导页（ui.js#renderWorklogOff）。
  const onWorklogView = !!(document.querySelector('.nav-item[data-view="worklog"]')
    && document.querySelector('.nav-item[data-view="worklog"]').classList.contains('active'));

  delete EXT.views.worklog;
  EXT.taskRowExtra = EXT.taskRowExtra.filter((f) => f !== renderRowExtra);

  bar.unmount();
  zen.unmount();
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  removeCss();
  if (offSnap) { offSnap(); offSnap = null; }
  if (onWorklogView) navigateTo('worklog');
  else renderTasks();
}

/**
 * 设置里改了「禅模式默认时长」：不重挂模块，只同步差异。
 * （开关本身由 app.js 负责 mount / unmount。）
 */
export function applyPref(pref) {
  if (!pref) return;
  live.pref = pref;
  zen.paint();
}

export { applyPref as onPrefChanged };
