'use strict';
/**
 * 「贴桌面」的 Windows 落地层：把浮窗挂进桌面层（Progman / WorkerW），成为它的一层。
 *
 * 为什么必须有原生调用：
 * Electron 的 setAlwaysOnTop 只有「最前」一档，没有「最底 / 贴桌面」。
 * 原来的 desktop 档只做了 setAlwaysOnTop(false)，语义等于「不置前」—— 窗口仍是普通 Z 序里
 * 的一员，行为跟 hover 档没区别，用户看到的就是「选了贴桌面，什么也没变」。这就是它一直被
 * 标成「实验性」的根因。
 *
 * 为什么不是 SetWindowPos(hwnd, HWND_BOTTOM)：
 * 实测（Win10/11 + Win+D）压到最底的窗口会被「显示桌面」抬起的桌面层整块盖住 ——
 * 贴桌面反而在你看桌面时消失，方向正好相反。
 *
 * 现在的做法：SetParent 到桌面图标宿主（有 SHELLDLL_DefView 子窗的 Progman / WorkerW），
 * 再在父层内抬到最上（压过图标视图），于是同时得到三件事：
 *   - 显示桌面（Win+D / 任务栏最右下角）时随桌面一起露出来 ✔
 *   - 任何应用窗口都盖在它上面 ✔（它在桌面层，不在普通窗口层）
 *   - 鼠标点击、标题栏拖拽、右键菜单照常落到它身上 ✔（同级里它在图标视图之上）
 * 这三条都是实测过的，见 docs/桌面浮窗-设计方案.md「贴桌面」一节。
 *
 * 兜底：Explorer 重启会把桌面层重建，子窗会被摘成顶层窗 —— 守护每 2s 检查一次
 * （是否还是桌面层的子窗、是否还在图标视图之上），不满足就重新挂一次。
 * 拿不到原生能力时所有接口退化为 no-op，调用方回落到「不置前」，不影响启动。
 */

const GW_HWNDPREV = 3;
const GW_HWNDNEXT = 2;

/** Z 序常量 */
const HWND_TOP = 0;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const SWP_NOSENDCHANGING = 0x0400;

const GA_ROOT = 2;
/** GetWindowLongPtr 索引 / 扩展样式位 */
const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;

/** 桌面层窗口类名：Progman（经典桌面）、WorkerW（Win10+ 把壁纸/图标拆出来的宿主） */
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW']);
const ICON_VIEW_CLASS = 'SHELLDLL_DefView';

/** 守护间隔：Explorer 重启 / 桌面重建之后 2s 内回到桌面层 */
const GUARD_MS = 2000;

let ffi = null;
let loadError = null;

function loadUser32() {
  if (ffi || loadError) return ffi;
  if (process.platform !== 'win32') {
    loadError = '非 Windows 平台';
    return null;
  }
  try {
    // eslint-disable-next-line global-require
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const RECT = koffi.struct('RECT', {
      left: 'int', top: 'int', right: 'int', bottom: 'int',
    });
    ffi = {
      // HWND 一律走 intptr_t：Electron 的 getNativeWindowHandle() 给的是「装着句柄数值的 Buffer」，
      // 当 void* 传会把 Buffer 的数据地址当句柄（GetWindow/SetWindowPos 全废，且不报错）。
      SetParent: user32.func('intptr_t __stdcall SetParent(intptr_t hWndChild, intptr_t hWndNewParent)'),
      SetWindowPos: user32.func(
        'bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter,'
        + ' int X, int Y, int cx, int cy, uint32_t uFlags)',
      ),
      GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32_t uCmd)'),
      GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t hWnd, uint32_t gaFlags)'),
      GetTopWindow: user32.func('intptr_t __stdcall GetTopWindow(intptr_t hWnd)'),
      FindWindowW: user32.func('intptr_t __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)'),
      FindWindowExW: user32.func(
        'intptr_t __stdcall FindWindowExW(intptr_t hWndParent, intptr_t hWndChildAfter,'
        + ' str16 lpszClass, str16 lpszWindow)',
      ),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hWnd, void *lpClassName, int nMaxCount)'),
      IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hWnd)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)'),
      SetWindowRgn: user32.func('int __stdcall SetWindowRgn(intptr_t hWnd, intptr_t hRgn, bool bRedraw)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ RECT *r)'),
      CreateRoundRectRgn: gdi32.func('intptr_t __stdcall CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h)'),
      DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr_t h)'),
    };
    return ffi;
  } catch (e) {
    loadError = (e && e.message) || String(e);
    console.error('[desktop-level] 原生桌面层能力加载失败，贴桌面退回「不置前」：', loadError);
    return null;
  }
}

function available() {
  return !!loadUser32();
}

/* ------------------------------ 句柄工具 ------------------------------ */

/** Electron 窗口 → HWND（整数）。取不到返回 0 */
function handleOf(win) {
  if (!win || win.isDestroyed()) return 0;
  try {
    const buf = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(buf) || !buf.length) return 0;
    return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch (e) {
    return 0;
  }
}

function classOf(hWnd) {
  const api = loadUser32();
  if (!api || !hWnd) return '';
  const buf = Buffer.alloc(128 * 2);
  const n = api.GetClassNameW(hWnd, buf, 128);
  return n ? buf.toString('utf16le', 0, n * 2) : '';
}

/**
 * 找桌面图标宿主窗口。
 * 优先「有 SHELLDLL_DefView 子窗」的那一个 —— 桌面图标画在它里面，只有挂在它里面
 * 再抬到图标之上，点击才会落到浮窗（挂到壁纸宿主 WorkerW 里会被图标视图整块挡住点击）。
 */
function findHost() {
  const api = loadUser32();
  if (!api) return 0;
  let fallback = 0;
  let h = api.GetTopWindow(0);
  for (let i = 0; h && i < 200; i += 1) {
    const cls = classOf(h);
    if (DESKTOP_CLASSES.has(cls) && api.IsWindowVisible(h)) {
      if (api.FindWindowExW(h, 0, ICON_VIEW_CLASS, null)) return h;
      if (!fallback) fallback = h;
    }
    h = api.GetWindow(h, GW_HWNDNEXT);
  }
  return fallback || api.FindWindowW('Progman', null);
}

/** 是否已经挂在桌面层里（父窗被 Explorer 销毁时会自动摘成顶层窗，这里能看出来） */
function parentOf(win) {
  const api = loadUser32();
  const h = handleOf(win);
  if (!api || !h) return 0;
  const root = api.GetAncestor(h, GA_ROOT);
  return root && root !== h ? root : 0;
}

function isAttached(win) {
  const root = parentOf(win);
  return !!root && DESKTOP_CLASSES.has(classOf(root));
}

/**
 * 是否在图标视图之上（同级里比它靠前）。
 * 在父层里 Z 序一旦落到 SHELLDLL_DefView 后面，浮窗会被图标盖住且吃不到点击。
 */
function aboveIconView(win) {
  const api = loadUser32();
  const h = handleOf(win);
  if (!api || !h) return false;
  let sib = api.GetWindow(h, GW_HWNDPREV);
  for (let i = 0; sib && i < 12; i += 1) {
    if (classOf(sib) === ICON_VIEW_CLASS) return false;
    sib = api.GetWindow(sib, GW_HWNDPREV);
  }
  return true;
}

/** 在父层内抬到最上（不动位置与尺寸，不抢焦点） */
function raiseInParent(win) {
  const api = loadUser32();
  const h = handleOf(win);
  if (!api || !h) return false;
  try {
    return !!api.SetWindowPos(
      h, HWND_TOP, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING,
    );
  } catch (e) {
    return false;
  }
}

/* ------------------------------ 圆角裁剪 ------------------------------ */

/**
 * 给窗口裁一块圆角区域 —— 贴桌面档的「圆角」靠它，不靠透明通道。
 *
 * 为什么必须裁：窗口一旦 SetParent 到桌面层，DWM 不再为它做带 alpha 的合成，
 * 圆角以外本该透明的地方会被画成**纯黑**（浅色卡片上就是四个黑尖角；深色卡片看不见是
 * 因为黑压黑）。SetWindowRgn 能真正把这块挖掉，让壁纸从圆角外露出来。
 * 代价：区域边缘没有抗锯齿（1px 阶梯），远好过黑尖角；顶层窗口（始终置顶 / 仅悬停）
 * 不做裁剪，保持原生透明与平滑圆角。
 */
function clipRounded(win, radiusPx, force = false) {
  const api = loadUser32();
  const h = handleOf(win);
  if (!api || !h) return false;
  const r = {};
  if (!api.GetWindowRect(h, r)) return false;
  const w = r.right - r.left;
  const hh = r.bottom - r.top;
  if (w <= 0 || hh <= 0) return false;
  const radius = Math.max(1, Math.round(radiusPx));
  // 尺寸与半径都没变就别重复建区域（每次 SetWindowRgn 都要新的 GDI 区域）
  const key = `${w}x${hh}x${radius}`;
  if (!force && win.__dwClipKey === key) return true;
  const rgn = api.CreateRoundRectRgn(0, 0, w + 1, hh + 1, radius * 2, radius * 2);
  if (!rgn) return false;
  // 成功后区域归系统所有，不能再 DeleteObject；失败才自己回收，避免 GDI 句柄泄漏
  if (api.SetWindowRgn(h, rgn, true)) {
    win.__dwClipKey = key;
    return true;
  }
  api.DeleteObject(rgn);
  return false;
}

/** 撤掉圆角裁剪（回到普通窗口，交还给透明通道） */
function clearClip(win) {
  const api = loadUser32();
  const h = handleOf(win);
  if (!api || !h) return false;
  return !!api.SetWindowRgn(h, 0, true);
}

/* ------------------------------ 对外 ------------------------------ */

const attached = new Set();
let timer = null;

function doAttach(win, hostHint) {
  const api = loadUser32();
  const h = handleOf(win);
  if (!api || !h || !api.IsWindow(h)) return false;
  // 桌面图标宿主会变：普通状态挂在 Progman，按「显示桌面」（Win+D）之后 Explorer 会把
  // SHELLDLL_DefView 挪到一个被抬起来的 WorkerW 里 —— 认错宿主就会被整块盖住（看起来"没生效"）。
  // 所以每次都以「当前持有 SHELLDLL_DefView 的那个窗口」为准。
  const host = hostHint || findHost();
  if (!host) return false;
  // 已经挂在同一个宿主上：只确认它还在图标视图之上。
  // 这里按「宿主是否变过」而不是「父窗是否等于宿主」判断 —— Explorer 有时会把子窗再嵌一层
  // （WorkerW 套 WorkerW），拿父窗硬比对会每 2s 白重挂一次。
  if (win.__dwHost === host && isAttached(win)) {
    return aboveIconView(win) ? true : raiseInParent(win);
  }
  const prev = api.SetParent(h, host);
  if (!prev && parentOf(win) !== host) return false; // SetParent 失败
  win.__dwHost = host;
  // 换宿主后窗口区域可能被重置，重新裁一次圆角（否则黑尖角会回来）
  if (win.__dwClipR) clipRounded(win, win.__dwClipR, true);
  return aboveIconView(win) ? true : raiseInParent(win);
}

function guardTick() {
  const host = findHost();
  if (!host) return; // 桌面层暂时不可见（Explorer 重启中）：下一轮再看，别乱动窗口
  for (const win of attached) {
    if (!win || win.isDestroyed()) { attached.delete(win); continue; }
    try {
      if (win.__dwHost !== host || !isAttached(win)) {
        console.warn('[desktop-level] 桌面层变了（显示桌面 / Explorer 重启），重新挂载贴桌面浮窗');
        doAttach(win, host);
      } else if (!aboveIconView(win)) {
        raiseInParent(win);
      }
    } catch (e) { /* 单窗失败不影响其它窗 */ }
  }
  if (!attached.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 进入「贴桌面」：挂进桌面层并交给守护保持。
 * @param {object} [opts]
 * @param {number} [opts.radiusPx] 圆角半径（物理像素）：挂成子窗后透明通道失效，
 *   圆角外的透明区会被画成纯黑，必须用窗口区域把圆角裁出来。
 */
function attach(win, opts = {}) {
  if (!win || win.isDestroyed()) return false;
  if (Number.isFinite(opts.radiusPx) && opts.radiusPx > 0) win.__dwClipR = opts.radiusPx;
  const ok = doAttach(win);
  if (!ok) return false;
  attached.add(win);
  if (!timer) {
    timer = setInterval(guardTick, GUARD_MS);
    if (timer.unref) timer.unref();
  }
  return true;
}

/**
 * 退出「贴桌面」：从桌面层摘出来交还给普通 Z 序。
 * 只做 SetParent(0)，置前 / 置顶由调用方按新的 pinMode 决定 —— 这里改层级会让
 * 「切到 hover 档」的窗口凭空跳到最前。
 */
function detach(win) {
  const api = loadUser32();
  attached.delete(win);
  if (win) {
    win.__dwHost = 0;
    win.__dwClipR = 0;
    win.__dwClipKey = '';
  }
  if (win) clearClip(win); // 回到普通窗口：撤掉裁剪，交还给透明通道（平滑圆角）
  if (!attached.size && timer) {
    clearInterval(timer);
    timer = null;
  }
  const h = handleOf(win);
  if (!api || !h || !isAttached(win)) return false;
  try {
    return !!api.SetParent(h, 0);
  } catch (e) {
    return false;
  }
}

function detachAll() {
  for (const win of [...attached]) detach(win);
  attached.clear();
  if (timer) { clearInterval(timer); timer = null; }
}

/** 诊断：贴桌面到底挂上了没有（用户报「没效果」时先看这里） */
function status() {
  loadUser32();
  const host = ffi ? findHost() : 0;
  return {
    supported: !!ffi,
    reason: ffi ? null : loadError,
    platform: process.platform,
    attached: attached.size,
    host: host ? `0x${host.toString(16)}` : null,
    hostClass: host ? classOf(host) : null,
  };
}

/** 单窗诊断 */
function inspect(win) {
  const api = loadUser32();
  const h = handleOf(win);
  if (!h) return { attached: false, hwnd: null };
  const root = parentOf(win);
  const ex = api ? Number(api.GetWindowLongPtrW(h, GWL_EXSTYLE)) : 0;
  return {
    hwnd: `0x${h.toString(16)}`,
    attached: !!root && DESKTOP_CLASSES.has(classOf(root)),
    parent: root ? `0x${root.toString(16)}` : null,
    parentClass: root ? classOf(root) : null,
    aboveIcons: !!root && aboveIconView(win),
    // 置顶标记：切到 always 档后必须为 true，切走贴桌面后必须能回到普通层
    topmost: (ex & WS_EX_TOPMOST) !== 0,
  };
}

module.exports = {
  available, status, inspect, attach, detach, detachAll, handleOf, isAttached,
  clipRounded, clearClip,
};
