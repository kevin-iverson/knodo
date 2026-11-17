'use strict';
/**
 * 任务完成「点赞」视觉反馈 + 效果闸门。
 *
 * 为什么单独一个模块：反馈效果和「刷新/排序」是两条时间线 ——
 * 勾选后 UI 立刻要给出情绪反馈，而列表重排（sort_order / 完成态过滤）必须等效果播完，
 * 否则行会被整块换掉，动画当场被掐断，看到的是「点了一下，什么都没发生，行却跳走了」。
 * 所以这里提供三样东西：
 *   1. beginFx(id) / endFx(id)：按任务 id 的互斥锁，写库往返 + 动画全程占锁。
 *      效果播放期间同一任务的重复点击被吞掉 —— 两次 toggle 互相抵消会造成
 *      「勾上 → 弹回 → 又勾上」的状态闪烁；连着触发也只会播一次。
 *   2. playLikeFx(anchor, { row })：真正的动画，返回 Promise，**一定会 resolve**
 *      （正常结束 / 动画事件丢失 / 节点被移除 / 用户开了减少动效 / 异常抛错都算结束），
 *      调用方 await 它就能保证「效果完全结束后才继续」。
 *   3. whenFxIdle(grace)：等到所有占锁任务都结束（再加一小段静默窗口），
 *      让一批连续点击合并成一次刷新，不出现「刷一遍又刷一遍」的抖动。
 *
 * 依赖约定：本模块只碰 DOM，不 import 业务模块（ui.js / detail.js 都可复用）。
 * 粒子层挂在 document.body 且是 position:fixed：行被外部原因重绘后，粒子依然在飞，
 * 不会出现「半个心形悬在旧位置」。
 */

/** 粒子贴 body 的层级：高于任务列表与详情抽屉(150)，低于 toast */
const LAYER_Z = 400;

/** whenFxIdle 的兜底上限：真的有东西卡住（异常没走到 endFx）时，刷新也得发生 */
const MAX_WAIT = 4000;

const HEART = '\u2665';
const SPARK = '\u2726';
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/* ---------------- 闸门 ---------------- */

const busyIds = new Set();
let idleWaiters = [];

/** 是否有任务正处在「写库 + 播效果」的临界区里 */
export function isFxBusy() {
  return busyIds.size > 0;
}

/**
 * 占锁。返回 false 表示这条任务正在处理中，调用方应当直接 return（不翻状态、不叠效果）。
 * 占锁是同步的：快速双击的第二次点击会在第一次 await 之前就被挡下。
 */
export function beginFx(id) {
  const key = Number(id);
  if (!Number.isFinite(key) || busyIds.has(key)) return false;
  // 有新动作进来 → 正在计的静默窗口作废，把这次也并进同一批刷新
  for (const w of idleWaiters) {
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
  }
  busyIds.add(key);
  return true;
}

/** 释放锁；最后一个释放时唤醒所有等待者（它们各自再等自己的静默窗口） */
export function endFx(id) {
  const key = Number(id);
  if (!busyIds.delete(key)) return; // 重复释放安全
  if (!busyIds.size) idleWaiters.forEach(armIdleWaiter);
}

/**
 * 等到「没有任何任务在播效果 / 写库」为止，再额外静默 grace 毫秒。
 * @param {number} [grace] 静默窗口（毫秒）：窗口内又有新动作就重新等
 * @returns {Promise<void>} 一定会 resolve，最迟 MAX_WAIT
 */
export function whenFxIdle(grace = 0) {
  return new Promise((resolve) => {
    const waiter = {
      resolve,
      grace: Math.max(0, Number(grace) || 0),
      timer: null,
      cap: null,
      settled: false,
    };
    // 兜底：动画事件丢失 / begin 之后异常没走到 endFx，刷新也不能永远不执行
    waiter.cap = setTimeout(() => settleIdleWaiter(waiter), MAX_WAIT);
    idleWaiters.push(waiter);
    armIdleWaiter(waiter);
  });
}

function armIdleWaiter(waiter) {
  if (waiter.settled || waiter.timer) return;
  if (busyIds.size) return; // 还在忙：等最后一个 endFx 再来武装
  if (!waiter.grace) { settleIdleWaiter(waiter); return; }
  waiter.timer = setTimeout(() => settleIdleWaiter(waiter), waiter.grace);
}

function settleIdleWaiter(waiter) {
  if (waiter.settled) return;
  waiter.settled = true;
  if (waiter.timer) { clearTimeout(waiter.timer); waiter.timer = null; }
  if (waiter.cap) { clearTimeout(waiter.cap); waiter.cap = null; }
  const i = idleWaiters.indexOf(waiter);
  if (i >= 0) idleWaiters.splice(i, 1);
  waiter.resolve();
}

/* ---------------- 动画 ---------------- */

/** 用户开了「减少动效」或窗口在后台时不必真播：直接当效果已结束 */
function canAnimate() {
  if (typeof document === 'undefined' || document.hidden) return false;
  try {
    const mq = window.matchMedia && window.matchMedia(REDUCE_QUERY);
    return !(mq && mq.matches);
  } catch (e) {
    return true;
  }
}

/**
 * 播一次点赞反馈。
 * @param {HTMLElement} anchor 锚点（任务行的完成按钮最合适）
 * @param {{ row?: HTMLElement }} [opts] row：加行高亮的整行元素，结束时由本函数负责摘除
 * @returns {Promise<void>} 一定 resolve
 */
export function playLikeFx(anchor, opts = {}) {
  const row = opts.row && opts.row.isConnected ? opts.row : null;
  const canPlay = canAnimate();
  // 不播也要清理：上一次异常留下的高亮类不能挂死在行上
  if (!anchor || !anchor.isConnected || !canPlay) {
    if (row) row.classList.remove('is-like-fx');
    if (anchor && anchor.isConnected) anchor.classList.remove('is-fx-pop');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let layer = null;
    let guard = null;
    const live = [];

    const finish = () => {
      if (settled) return;
      settled = true;
      if (guard) { clearTimeout(guard); guard = null; }
      if (row) row.classList.remove('is-like-fx');
      if (anchor.isConnected) anchor.classList.remove('is-fx-pop');
      if (layer) {
        for (const a of live) {
          try { a.cancel(); } catch (e) { /* 已结束的动画 cancel 会抛，忽略 */ }
        }
        layer.remove();
        layer = null;
      }
      resolve();
    };

    try {
      const rect = anchor.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      layer = document.createElement('div');
      layer.className = 'like-fx';
      layer.setAttribute('aria-hidden', 'true');
      layer.style.zIndex = String(LAYER_Z);
      layer.style.left = `${cx}px`;
      layer.style.top = `${cy}px`;

      let total = 0;

      // 中心那颗大的：先把「完成」这件事在视觉上钉住
      const big = document.createElement('span');
      big.className = 'like-fx-p like-fx-big';
      big.textContent = HEART;
      big.style.color = 'var(--fx-heart, #ff5f7a)';
      layer.appendChild(big);
      live.push(big.animate([
        { transform: 'translate(-50%, -50%) scale(0.2)', opacity: 0 },
        { transform: 'translate(-50%, -60%) scale(1.4)', opacity: 1, offset: 0.34 },
        { transform: 'translate(-50%, -72%) scale(1.05)', opacity: 1, offset: 0.6 },
        { transform: 'translate(-50%, -96%) scale(0.9)', opacity: 0 },
      ], { duration: 640, easing: 'cubic-bezier(.24,.72,.3,1)', fill: 'both' }));
      total = Math.max(total, 640);

      // 扩散圆环：从勾选圈里荡开，指向「这条被勾上了」
      const ring = document.createElement('span');
      ring.className = 'like-fx-ring';
      layer.appendChild(ring);
      live.push(ring.animate([
        { transform: 'scale(0.42)', opacity: 0 },
        { transform: 'scale(0.72)', opacity: 0.7, offset: 0.22 },
        { transform: 'scale(2.05)', opacity: 0 },
      ], { duration: 620, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' }));
      total = Math.max(total, 620);

      // 上方扇形散开的小心心 / 星星：点赞的主体
      const N = 8;
      for (let i = 0; i < N; i += 1) {
        const t = i / (N - 1);
        const ang = (-152 + t * 124) * (Math.PI / 180); // -152° → -28°，向上散开
        const dist = 34 + ((i * 47) % 30);
        const p = document.createElement('span');
        p.className = 'like-fx-p like-fx-heart';
        p.textContent = HEART;
        p.style.fontSize = `${14 + ((i * 13) % 8)}px`;
        p.style.color = 'var(--fx-heart, #ff5f7a)';
        layer.appendChild(p);
        const dx = Math.cos(ang) * dist;
        const dy = Math.sin(ang) * dist;
        const rot = (i % 2 ? 1 : -1) * (14 + i * 4);
        const dur = 580 + ((i * 53) % 160);
        const delay = i * 18;
        live.push(p.animate([
          { transform: 'translate(-50%, -50%) scale(0.22) rotate(0deg)', opacity: 0 },
          {
            transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.62}px)) scale(1.12) rotate(${rot * 0.5}deg)`,
            opacity: 1,
            offset: 0.24,
          },
          {
            transform: `translate(calc(-50% + ${dx * 0.85}px), calc(-50% + ${dy * 0.88}px)) scale(1) rotate(${rot * 0.8}deg)`,
            opacity: 1,
            offset: 0.55,
          },
          {
            transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy - 18}px)) scale(0.85) rotate(${rot}deg)`,
            opacity: 0,
          },
        ], { duration: dur, delay, easing: 'cubic-bezier(.22,.68,.35,1)', fill: 'both' }));
        total = Math.max(total, delay + dur);
      }

      for (let i = 0; i < 3; i += 1) {
        const ang = (-120 + i * 46) * (Math.PI / 180);
        const dist = 46 + i * 8;
        const s = document.createElement('span');
        s.className = 'like-fx-p like-fx-spark';
        s.textContent = SPARK;
        s.style.fontSize = `${10 + i * 2}px`;
        s.style.color = 'var(--green, #23b07e)';
        layer.appendChild(s);
        const dx = Math.cos(ang) * dist;
        const dy = Math.sin(ang) * dist;
        const dur = 520 + i * 70;
        const delay = 50 + i * 40;
        live.push(s.animate([
          { transform: 'translate(-50%, -50%) scale(0.2)', opacity: 0 },
          { transform: `translate(calc(-50% + ${dx * 0.6}px), calc(-50% + ${dy * 0.6}px)) scale(1.05)`, opacity: 1, offset: 0.35 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.5)`, opacity: 0 },
        ], { duration: dur, delay, easing: 'ease-out', fill: 'both' }));
        total = Math.max(total, delay + dur);
      }

      document.body.appendChild(layer);

      // 行高亮 / 勾选圈弹一下：CSS 动画，类由 finish 统一摘除
      if (row) row.classList.add('is-like-fx');
      anchor.classList.add('is-fx-pop');

      // 硬兜底：WAAPI 的 finished 在极端情况下（节点被移除 / 渲染进程掉帧）不会到，
      // 到点无条件收尾，绝不让刷新被一个动画卡死。
      guard = setTimeout(finish, total + 450);

      Promise.allSettled(live.map((a) => a.finished)).then(finish, finish);
    } catch (e) {
      // 任何环境问题（不支持 WAAPI / 布局异常）都退化为「没有效果」，但流程照走
      console.warn('[like-fx] 完成反馈播放失败', e && e.message);
      finish();
    }
  });
}
