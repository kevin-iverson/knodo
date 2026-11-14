'use strict';
/**
 * 底部工时计时条（FR-03）。
 *
 * 形态与「会议录制」的 #rec-dock 完全一致：fixed 底部居中、胶囊外壳、
 * 脉冲点 + 等宽时间 + 操作按钮。两条计时（录制 / 工时）会同时出现在底部，
 * 所以最前面必须有一个身份标记「🕒 工时计时」—— 只靠颜色区分不够。
 *
 * 挂 document.body：切视图、重绘 #view 都不影响它；点击条身回到该任务详情。
 */
import { api } from '../api.js';
import { toast } from '../ui.js';
import { openDetail } from '../detail.js';
import { live, elapsedMs, hms, isActive } from './shared.js';
import * as zen from './zen.js';

let el = null;
let timer = null;
let bound = false;

function html() {
  return `<span class="wl-dock-tag">🕒 工时计时</span>
    <span class="wl-dot"></span>
    <span class="wl-dock-time num" data-wl-time>00:00:00</span>
    <span class="wl-dock-task" data-wl-task></span>
    <button type="button" class="wl-dock-btn" data-wl="zen" title="进入禅模式（全屏静默计时）">禅</button>
    <button type="button" class="wl-dock-btn" data-wl="pause" title="暂停 / 继续计时">⏸ 暂停</button>
    <button type="button" class="wl-dock-btn is-solid" data-wl="stop" title="结束并记录">■ 结束</button>`;
}

export function mount() {
  if (el) return;
  el = document.createElement('div');
  el.className = 'wl-dock';
  el.id = 'wl-dock';
  el.hidden = true;
  el.innerHTML = html();
  document.body.appendChild(el);

  if (!bound) {
    bound = true;
    el.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-wl]');
      if (act) {
        if (act.dataset.wl === 'zen') { zen.show(); return; }
        if (act.dataset.wl === 'pause') { await togglePause(); return; }
        if (act.dataset.wl === 'stop') { await stop(); return; }
      }
      if (live.snap.taskId != null) openDetail(live.snap.taskId);
    });
    timer = setInterval(paint, 1000);
  }
  paint();
}

export function unmount() {
  if (timer) { clearInterval(timer); timer = null; }
  if (el) { el.remove(); el = null; }
  bound = false;
}

async function togglePause() {
  try {
    if (live.snap.mode === 'paused') await api.worklog.resume();
    else await api.worklog.pause();
  } catch (e) {
    toast(`切换暂停失败：${(e && e.message) || e}`);
  }
}

export async function stop() {
  try {
    const r = await api.worklog.stop();
    if (!r) return;
    if (r.discarded) {
      toast(`太短（${r.sec} 秒），已丢弃`);
    } else {
      const title = live.snap.taskTitle || '任务';
      toast(`已记录 ${Math.floor(r.sec / 60)} 分钟到「${title}」`);
    }
    if (r.warning) toast(r.warning);
    zen.hide();
  } catch (e) {
    toast(`结束计时失败：${(e && e.message) || e}`);
  }
}

/** 只用快照 + wall clock 重算显示，不做累加 */
export function paint() {
  if (!el) return;
  const snap = live.snap;
  const show = isActive(snap);
  el.hidden = !show;
  if (!show) return;
  const paused = snap.mode === 'paused';
  el.classList.toggle('is-paused', paused);
  const t = el.querySelector('[data-wl-time]');
  const name = el.querySelector('[data-wl-task]');
  const pz = el.querySelector('[data-wl="pause"]');
  if (t) t.textContent = hms(Math.floor(elapsedMs(snap) / 1000));
  if (name) {
    name.textContent = snap.taskTitle || '任务';
    name.title = snap.taskTitle || '';
  }
  if (pz) {
    pz.textContent = paused ? '▶ 继续' : '⏸ 暂停';
    pz.title = paused ? '继续计时' : '暂停计时';
  }
}

export function refresh() {
  paint();
}
