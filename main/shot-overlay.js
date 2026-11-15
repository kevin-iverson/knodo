'use strict';
/**
 * 区域截图的框选覆盖层（独立窗口）。
 *
 * 为什么必须是一个独立 BrowserWindow：
 *  - 覆盖层要盖住整块屏幕（含任务栏），层级得是 screen-saver；主窗口里做只会盖住自己；
 *  - 独立窗口有自己的 DOM，主界面的弹窗 / 抽屉 / z-index 一律与它无关，框选时不可能有东西漏在中间。
 *
 * 与主进程的契约只有三条（见 preload/shot-overlay.js）：
 *   ready() → 拿背景图与画布尺寸
 *   done(rect) → 交选区（CSS 像素，相对窗口左上角）
 *   cancel(reason) → 放弃
 *
 * 60 秒无操作自动取消是**必须有**的兜底：这扇窗全屏置顶，一旦卡住整个机器就用不了。
 * 计时不是从打开算起，而是每次指针 / 键盘动一下就重置（渲染层节流 2 秒报一次 touch）。
 */
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

/** 空闲多久自动取消：全屏置顶窗口的防锁机底线 */
const IDLE_MS = 60 * 1000;
/** 最小可确认选区（CSS px）：小于它说明用户只是在点一下，不是要截图 */
const MIN_SIDE = 8;

let win = null;
let payload = null;
let settle = null;
let idleTimer = null;
let handlersReady = false;

function isOpen() {
  return !!(win && !win.isDestroyed());
}

function clearIdle() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** 重新开始 60 秒倒计时 */
function armIdle() {
  clearIdle();
  idleTimer = setTimeout(() => {
    finish(null, 'timeout');
  }, IDLE_MS);
}

/**
 * 收尾：只结算一次。
 * 窗口的 closed 事件也会走到这里（resolve 已被置空，所以不会重复 resolve）。
 */
function finish(rect, reason, stage) {
  clearIdle();
  const done = settle;
  const size = stage || (payload ? { w: payload.width, h: payload.height } : null);
  settle = null;
  payload = null;
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) {
    try { w.destroy(); } catch (e) { /* 已销毁 */ }
  }
  if (done) {
    const r = rect && Number.isFinite(rect.w) && Number.isFinite(rect.h) ? rect : null;
    done({ rect: r, stage: size, reason: r ? 'done' : (reason || 'cancel') });
  }
}

function cancel(reason) {
  finish(null, reason || 'cancel');
}

/**
 * 打开覆盖层并等待用户框选。
 * @param {{image:string, width:number, height:number, bounds:{x:number,y:number,width:number,height:number}}} opts
 *        image 是 data:image/jpeg 背景图（长边已压过），width/height 是 display.bounds 的逻辑尺寸
 * @returns {Promise<{rect:null|{x:number,y:number,w:number,h:number}, reason:string}>}
 */
function open(opts = {}) {
  if (isOpen()) cancel('replaced');
  return new Promise((resolve) => {
    settle = resolve;
    payload = {
      image: opts.image || '',
      width: Math.max(1, Math.round(opts.width || 1)),
      height: Math.max(1, Math.round(opts.height || 1)),
    };
    const b = opts.bounds || { x: 0, y: 0, width: payload.width, height: payload.height };
    win = new BrowserWindow({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
      useContentSize: true,
      // 背景是一张图，不需要真透明：真透明在部分显卡驱动上会整块黑屏
      transparent: false,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // 先不显示：空窗口闪一下很难看，拿到图之后由渲染层调 ready() 再 show
      show: false,
      backgroundColor: '#000000',
      alwaysOnTop: true,
      title: 'Knodo 框选',
      webPreferences: {
        // 独立 preload：只暴露 overlay 三个方法，不给它主窗口那套 api
        preload: path.join(__dirname, '..', 'preload', 'shot-overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 覆盖层失去焦点也不能被节流（Esc 要立刻响应）
        backgroundThrottling: false,
      },
    });
    // 普通 top 挡不住任务栏：必须 screen-saver
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 构造参数里的 width/height 会被系统按工作区夹一次（实测 125% 缩放下 1536×864 变成 1540×827），
    // 窗口比屏幕矮一截时，背景图会被纵向拉伸，裁剪出来的附件就整体变形。
    // setContentSize 是**精确**的，所以建完再顶一次，并读回来核对。
    fitToScreen(win, payload.width, payload.height);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'shot-overlay.html'));
    win.on('closed', () => { finish(null, 'closed'); });
    armIdle();
  });
}

/**
 * 把窗口内容尺寸顶到屏幕尺寸。
 * 只调一次 setContentSize 就够（系统只在构造时夹），但读回来不等于目标时再试一次 ——
 * 覆盖层比屏幕小哪怕 10px，裁剪比例就会变成"宽 1.25 / 高 1.31"这种非等比，附件必然变形。
 */
function fitToScreen(w, bw, bh) {
  if (!w || w.isDestroyed()) return;
  for (let i = 0; i < 3; i += 1) {
    const [cw, ch] = w.getContentSize();
    if (cw === bw && ch === bh) return;
    w.setContentSize(bw, bh);
  }
  const [cw, ch] = w.getContentSize();
  if (cw !== bw || ch !== bh) {
    console.warn('[shot] 覆盖层没能铺满屏幕', `${cw}×${ch} vs ${bw}×${bh}`);
  }
}

/** 渲染层已画好背景 → 显示并抢焦点（不 focus 收不到 Esc） */
function showWhenReady() {
  if (!isOpen()) return false;
  if (!win.isVisible()) {
    win.show();
    win.focus();
  }
  return true;
}

function registerIpc() {
  if (handlersReady) return;
  handlersReady = true;
  const on = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch (e) { /* 没注册过 */ }
    ipcMain.handle(channel, fn);
  };
  // 覆盖层只回 4 个数字：图片字节主进程本来就有，绝不来回传
  on('shot:overlay-ready', () => {
    if (!payload) return null;
    return { image: payload.image, width: payload.width, height: payload.height, minSide: MIN_SIDE };
  });
  // 渲染层把背景图画完之后才调这个：先 show 再画会闪一帧黑
  on('shot:overlay-shown', () => ({ ok: showWhenReady() }));
  on('shot:overlay-done', (_e, msg = {}) => {
    const rect = msg && msg.rect;
    if (rect) {
      const x = Math.max(0, Math.round(Number(rect.x) || 0));
      const y = Math.max(0, Math.round(Number(rect.y) || 0));
      const w = Math.round(Number(rect.w) || 0);
      const h = Math.round(Number(rect.h) || 0);
      // 画布尺寸跟着 rect 一起来（渲染层只知道自己的 innerWidth/innerHeight）：
      // 拿不到时才回落 display.bounds，两者差 1px 就会让裁剪整体偏一点
      const raw = rect.stage || (msg && msg.stage);
      const stage = raw && Number(raw.w) > 0 && Number(raw.h) > 0
        ? { w: Number(raw.w), h: Number(raw.h) }
        : null;
      if (w >= MIN_SIDE && h >= MIN_SIDE) {
        // 同时带回画布尺寸：裁剪按「原图物理宽 / 画布逻辑宽」换算，比信 scaleFactor 稳
        finish({
          x, y, w: Math.min(w, stage ? stage.w - x : w), h: Math.min(h, stage ? stage.h - y : h),
        }, 'done', stage);
        return { ok: true };
      }
    }
    finish(null, (msg && msg.reason) || 'cancel');
    return { ok: true };
  });
  on('shot:overlay-touch', () => {
    if (payload) armIdle();
    return { ok: true };
  });
}

module.exports = {
  registerIpc,
  open,
  cancel,
  isOpen,
  MIN_SIDE,
  IDLE_MS,
  /** 当前鼠标所在屏（覆盖层只盖这一块，不做跨屏框选） */
  displayAtCursor() {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  },
};
