'use strict';
/**
 * 禅模式（FR-07）：开放式计时，通知静默，不判「离开」。
 *
 * 这里是纯覆盖层：计时仍在主进程跑，Esc 只是退出全屏，不会结束计时
 * （原型提示语：通知已静默 · 不统计离开 · 按 Esc 退出）。
 */
import { api } from '../api.js';
import { toast } from '../ui.js';
import { live, elapsedMs, hms, esc, isActive } from './shared.js';

let root = null;
let timer = null;
let keyBound = false;

function html() {
  return `
    <div class="wl-zen-label">ZEN · 静默计时</div>
    <div class="wl-zen-time num" data-zen-time>00:00:00</div>
    <div class="wl-zen-task" data-zen-task></div>
    <div class="wl-zen-track" data-zen-track><div class="wl-zen-fill" data-zen-fill></div></div>
    <div class="wl-zen-hint">通知已静默 · 不统计离开 · 按 Esc 退出</div>
    <div class="wl-zen-actions">
      <button type="button" class="wl-zen-btn" data-zen="pause">暂停</button>
      <button type="button" class="wl-zen-btn is-main" data-zen="end">结束并记录</button>
    </div>`;
}

export function mount() {
  if (root) return;
  root = document.createElement('div');
  root.className = 'wl-zen';
  root.id = 'wl-zen';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = html();
  document.body.appendChild(root);

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-zen]');
    if (!b) return;
    if (b.dataset.zen === 'pause') await togglePause();
    else if (b.dataset.zen === 'end') await end();
  });

  if (!keyBound) {
    keyBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !isOpen()) return;
      // 禅模式在最上层：Esc 只退出全屏，不要顺手把抽屉也关了
      e.stopPropagation();
      hide();
    }, true);
  }
  timer = setInterval(paint, 1000);
}

export function unmount() {
  if (timer) { clearInterval(timer); timer = null; }
  if (root) { root.remove(); root = null; }
  keyBound = false;
}

export function isOpen() {
  return !!root && root.classList.contains('is-open');
}

export function show() {
  if (!root) return;
  if (!isActive(live.snap)) {
    toast('先在这个任务上开始计时，再进禅模式');
    return;
  }
  root.classList.add('is-open');
  paint();
}

export function hide() {
  if (root) root.classList.remove('is-open');
}

async function togglePause() {
  try {
    if (live.snap.mode === 'running') await api.worklog.pause();
    else if (live.snap.mode === 'paused') await api.worklog.resume();
  } catch (e) {
    toast(`操作失败：${(e && e.message) || e}`);
  }
}

async function end() {
  try {
    const r = await api.worklog.stop();
    hide();
    if (!r) return;
    if (r.discarded) toast(`太短（${r.sec} 秒），已丢弃`);
    else toast(`已记录 ${Math.floor(r.sec / 60)} 分钟`);
    if (r.warning) toast(r.warning);
  } catch (e) {
    toast(`结束计时失败：${(e && e.message) || e}`);
  }
}

export function paint() {
  if (!root || !isOpen()) return;
  const snap = live.snap;
  if (!isActive(snap)) { hide(); return; }
  const timeEl = root.querySelector('[data-zen-time]');
  const taskEl = root.querySelector('[data-zen-task]');
  const fill = root.querySelector('[data-zen-fill]');
  const track = root.querySelector('[data-zen-track]');
  const pauseBtn = root.querySelector('[data-zen="pause"]');
  const ms = elapsedMs(snap);
  if (timeEl) timeEl.textContent = hms(Math.floor(ms / 1000));
  if (taskEl) taskEl.textContent = snap.taskTitle || '任务';
  if (pauseBtn) pauseBtn.textContent = snap.mode === 'paused' ? '继续' : '暂停';
  const target = Number(live.pref && live.pref.zenDefaultSec) || 0;
  if (track && fill) {
    track.hidden = !target;
    fill.style.width = target ? `${Math.min(100, (ms / 1000 / target) * 100)}%` : '0%';
  }
}
