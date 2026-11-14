'use strict';
/**
 * 工时插件内部共用：格式化、来源文案、以及一份「主进程快照」的订阅中心。
 *
 * 渲染层不持有计时状态：所有时长都由 snapshot 的 accMs + (now - segStart) 现算 ——
 * wall clock 口径（窗口隐藏时 setInterval 会被节流，累加式计时会停摆）。
 */

export const SOURCE_TEXT = { timer: '计时', zen: '禅模式', pomodoro: '番茄', manual: '补录' };

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 00:00:00（底部计时条 / 禅模式） */
export function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** 2h40m（列表 / 卡片 / 记录行） */
export function hm(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h && m) return `${h}h${String(m).padStart(2, '0')}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ------------------------------ 快照订阅 ------------------------------ */

const IDLE = { mode: 'idle', id: null, taskId: null, taskTitle: '', startedAt: 0, accMs: 0, segStart: 0, source: 'timer' };

export const live = {
  snap: { ...IDLE },
  subs: new Set(),
  /** 最近一次从主进程读到的偏好（zenDefaultSec / dayAttr） */
  pref: { enabled: false, zenDefaultSec: 5400, dayAttr: 'start' },
};

export function setSnap(snap) {
  live.snap = snap && typeof snap === 'object' ? snap : { ...IDLE };
  for (const fn of live.subs) {
    try { fn(live.snap); } catch (e) { console.warn('[worklog]', e); }
  }
}

export function onSnap(fn) {
  live.subs.add(fn);
  return () => live.subs.delete(fn);
}

/** 当前累计毫秒（running 时含未结算段） */
export function elapsedMs(snap = live.snap) {
  if (!snap || snap.mode !== 'running') return snap ? snap.accMs || 0 : 0;
  return (snap.accMs || 0) + Math.max(0, Date.now() - (snap.segStart || Date.now()));
}

export function isActive(snap = live.snap) {
  return !!snap && (snap.mode === 'running' || snap.mode === 'paused');
}
