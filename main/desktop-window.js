'use strict';
/**
 * 桌面浮窗（把清单或视图钉到桌面）。
 *
 * 设计原则（见《桌面浮窗-设计方案》一节的三条判断）：
 *  1. 浮窗是「投影」不是「容器」—— 只记 { kind, refId }，内容每次从库里实时读，
 *     关掉浮窗 = 取消投射，任务一条不删；
 *  2. 一个分组一个窗、一个视图一个窗，上限 6 个；
 *  3. 浮窗只负责「看」和「勾」，结构操作（改分组 / 父子 / 排序）全部回主窗口。
 *
 * 存储：settings['tool.desktopWindows'] = Projection[]（不新增数据表），
 * 天然支持多窗、顺序、几何记忆；窗口层与内容层解耦，多接一种投影（today / upcoming /
 * 将来的 note / stats）只需要在 buildView() 里多一个分支，chrome（拖动 / 吸附 / 折叠 /
 * 置顶）一行不用改。
 */
const {
  BrowserWindow, ipcMain, screen, Menu, dialog,
} = require('electron');
const path = require('path');
const db = require('./db');
const attachments = require('./attachments');
const focus = require('./focus');
const desktopLevel = require('./desktop-level');

/** 设置键（projection 列表） */
const KEY = 'tool.desktopWindows';
/** 同时最多 6 个窗（内存与桌面可得性的平衡） */
const MAX_WINDOWS = 6;
/** 窗口规格（与设计稿一致） */
const DEF_W = 286;
const MIN_W = 240;
const MAX_W = 460;
const MAX_H = 520;
const HEAD_H = 42;
/** 圆角半径，必须与 renderer/css/desktop.css 的 --dw-r 一致（DIP） */
const WINDOW_RADIUS = 14;
/** 吸附：贴屏幕边 12px / 与其它浮窗左边界差 8px 对齐、垂直间距 8px 贴合 */
const SNAP_EDGE = 12;
const SNAP_ALIGN = 8;
const SNAP_GAP = 8;
const SNAP_INSET = 12;
/**
 * 支持的投影类型：group（单清单）/ today（今天）/ upcoming（即将到期）。
 * 后两者是「视图投影」，不带 refId —— 内容由视图口径实时算出，不需要指向任何分组。
 * 漏加 kind 会被 readAll() 的 KINDS.includes(p.kind) 过滤掉，表现为「贴了但重启就没了」。
 */
const KINDS = ['group', 'today', 'upcoming'];

let getMainWindow = () => null;
let onChanged = () => {};
const wins = new Map(); // projectionId → BrowserWindow
const persistTimers = new Map();
let snapping = false;

/* ------------------------------ 小工具 ------------------------------ */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 今天 00:00 的 UTC ISO（completed_at 是 UTC ISO） */
function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function newId() {
  return `dw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ------------------------------ 投影存储 ------------------------------ */

function normalizeProjection(raw) {
  const g = raw.geometry && typeof raw.geometry === 'object' ? raw.geometry : {};
  return {
    id: String(raw.id),
    kind: KINDS.includes(raw.kind) ? raw.kind : 'group',
    refId: raw.refId == null ? null : Number(raw.refId),
    // 几何：x/y 未知时交给默认位置计算（null 而不是 0，0 会被当成「贴左上角」）
    geometry: {
      x: Number.isFinite(g.x) ? Math.round(g.x) : null,
      y: Number.isFinite(g.y) ? Math.round(g.y) : null,
      w: clamp(Math.round(Number(g.w) || DEF_W), MIN_W, MAX_W),
      h: clamp(Math.round(Number(g.h) || 320), HEAD_H, MAX_H),
      displayId: Number.isFinite(g.displayId) ? Math.round(g.displayId) : null,
    },
    pinMode: ['always', 'hover', 'desktop'].includes(raw.pinMode) ? raw.pinMode : 'always',
    collapsed: !!raw.collapsed,
  };
}

function readAll() {
  if (!db.isReady()) return [];
  try {
    const arr = JSON.parse(db.getSetting(KEY, '[]'));
    if (!Array.isArray(arr)) return [];
    // 脏数据（手改过 settings / 老版本残留）一律丢掉，不能让一条坏记录拖垮所有浮窗
    return arr
      .filter((p) => p && typeof p === 'object' && p.id && KINDS.includes(p.kind))
      .map(normalizeProjection);
  } catch (e) {
    return [];
  }
}

function writeAll(list) {
  if (!db.isReady()) return;
  try {
    db.setSetting(KEY, JSON.stringify(list));
  } catch (e) {
    console.error('[desktop] 保存浮窗配置失败', e && e.message);
  }
}

function findProjection(id) {
  return readAll().find((p) => p.id === id) || null;
}

function patchProjection(id, patch) {
  const list = readAll();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const cur = list[i];
  const next = normalizeProjection({
    ...cur,
    ...patch,
    geometry: { ...cur.geometry, ...((patch && patch.geometry) || {}) },
  });
  list[i] = next;
  writeAll(list);
  return next;
}

/** 投影列表（带标题 / 计数，供主窗口菜单与托盘使用） */
function list() {
  return readAll().map((p) => {
    const view = safeView(p);
    return {
      id: p.id,
      kind: p.kind,
      refId: p.refId,
      title: view.title,
      done: view.counts.done,
      total: view.counts.total,
      collapsed: p.collapsed,
      pinMode: p.pinMode,
      missing: !!view.missing,
      visible: isShown(p.id),
    };
  });
}

/* ------------------------------ 内容投影 ------------------------------ */

/**
 * 排序：勾选前后行位置必须一致。
 * 数据库默认序把「已完成」排到最后，勾一条就整行跳走，下一条会落到手指底下变成误勾 ——
 * 所以这里忽略完成状态，只按 计划完成日期 → 优先级 → 手工顺序 排。
 */
function sortKeepPlace(list) {
  return list.slice().sort((a, b) => {
    const pa = a.plan_end || '9999-99-99';
    const pb = b.plan_end || '9999-99-99';
    if (pa !== pb) return pa < pb ? -1 : 1;
    const pr = (b.priority || 0) - (a.priority || 0);
    if (pr) return pr;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
}

/** 浮窗只显示「进行中 + 今天完成的」：历史已完成堆进 286px 的窗口只会变成噪音，
 *  而刚勾掉的那条要留在原位变灰（判断一：勾选不动位置）。 */
function keepInList(t) {
  const since = startOfTodayIso();
  return !t.completed || !t.completed_at || t.completed_at >= since;
}

/** 合并「进行中」与「今天完成」两组任务（同一 id 只留一条），按勾选不动位置的规则排序 */
function mergeVisible(active, doneToday) {
  const merged = new Map();
  active.forEach((t) => merged.set(t.id, t));
  doneToday.forEach((t) => { if (!merged.has(t.id)) merged.set(t.id, t); });
  return sortKeepPlace([...merged.values()].filter(keepInList));
}

function countsOf(tasks) {
  return { done: tasks.filter((t) => t.completed).length, total: tasks.length };
}

/** 取投影对应的数据：标题 + 任务 + 计数（不缓存，永远读实时的库） */
function safeView(p) {
  try {
    const v = buildView(p);
    // 番茄钟：浮窗同步显示「正在专注的那一格」的倒计时（只读展示，不提供入口）
    v.focus = focus.peek();
    return v;
  } catch (e) {
    return {
      title: '数据未就绪',
      error: e && e.message ? e.message : String(e),
      tasks: [],
      counts: { done: 0, total: 0 },
      focus: focus.peek(),
    };
  }
}

function buildView(p) {
  if (!db.isReady()) {
    return { title: '数据未就绪', error: db.getInitError() || '数据库未就绪', tasks: [], counts: { done: 0, total: 0 } };
  }
  const since = startOfTodayIso();

  if (p.kind === 'today') {
    const today = todayStr();
    const tasks = mergeVisible(
      db.listTasks({ status: 'active', planEndTo: today }),
      db.listTasks({ status: 'completed', completedFrom: since }),
    );
    return {
      title: '今天',
      kindLabel: '今日清单',
      tasks,
      counts: countsOf(tasks),
    };
  }

  if (p.kind === 'upcoming') {
    // 与主窗口「即将到期」同一口径：进行中 + 计划完成日期在今天或之后（没有日期的任务不在其中）。
    // 刚勾掉的那条按同一到期口径再取一次，让它留在原位变灰，而不是整行消失。
    const today = todayStr();
    const tasks = mergeVisible(
      db.listTasks({ status: 'active', planEndFrom: today, sort: 'due' }),
      db.listTasks({ status: 'completed', completedFrom: since, planEndFrom: today, sort: 'due' }),
    );
    return {
      title: '即将到期',
      kindLabel: '将来任务',
      tasks,
      counts: countsOf(tasks),
    };
  }

  const g = p.refId == null ? null : db.getGroup(p.refId);
  if (!g) {
    return { title: '该清单已删除', missing: true, tasks: [], counts: { done: 0, total: 0 } };
  }
  const tasks = mergeVisible(db.listTasks({ groupId: g.id, status: 'all' }), []);
  return {
    title: g.name,
    color: g.color,
    tasks,
    counts: countsOf(tasks),
  };
}

/* ------------------------------ 窗口 ------------------------------ */

function isShown(id) {
  const w = wins.get(id);
  return !!(w && !w.isDestroyed() && w.isVisible());
}

function windowOf(id) {
  const w = wins.get(id);
  return w && !w.isDestroyed() ? w : null;
}

/** 默认落点：主屏工作区右侧、距边 24px、垂直居中偏上；已有浮窗则向下错开 48px */
function defaultGeometry(height) {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  const w = DEF_W;
  const h = clamp(height || 320, HEAD_H, MAX_H);
  let x = wa.x + wa.width - w - 24;
  let y = wa.y + Math.round((wa.height - h) / 3);
  const others = readAll().filter((p) => p.geometry.y != null);
  for (const p of others) {
    // 与已有窗口重叠就往下让一格，避免新窗完全盖住旧窗
    if (Math.abs(p.geometry.y - y) < SNAP_GAP + 8 && Math.abs(p.geometry.x - x) < SNAP_GAP + 8) {
      y += 48;
    }
  }
  y = clamp(y, wa.y, wa.y + wa.height - h);
  return { x, y, w, h, displayId: d.id };
}

/**
 * 置顶三档（pinMode）：
 *  always  → 常在最前（默认）
 *  hover   → 平时随普通窗口，鼠标移入时临时置前（渲染层 desktop:hover）
 *  desktop → 贴桌面：把窗口挂进桌面层（Progman / WorkerW），显示桌面时可见、被应用窗口盖住；
 *            系统拿不到原生能力时退回「不置前」，菜单里会把可用性标出来。
 */
function applyPinMode(win, p) {
  if (!win || win.isDestroyed()) return;
  const mode = p.pinMode || 'always';
  // 渲染层与各处回调都靠它判断「这一窗是不是贴桌面档」，避免每次都去读一遍 settings
  win.__dwPinMode = mode;
  if (mode === 'desktop') {
    // topmost 必须先摘掉：带 WS_EX_TOPMOST 的子窗会浮到桌面层之上，等于没贴
    win.setAlwaysOnTop(false);
    // 挂成桌面层子窗后透明通道失效，圆角外的透明区会变成纯黑 —— 用窗口区域把圆角裁出来
    if (!desktopLevel.attach(win, { radiusPx: desktopClipRadius(win) })) {
      // 挂不上（非 Windows / FFI 不可用 / 找不到桌面层）：保持「不置前」，别把窗口弄丢
      console.warn('[desktop] 贴桌面不可用，窗口退回「不置前」');
    }
    return;
  }
  // 从贴桌面切走：先摘出桌面层，再由下面的分支决定置顶方式。
  // 摘出来后窗口在普通层里是最靠后的，setAlwaysOnTop 会把它重新摆回正确位置。
  desktopLevel.detach(win);
  if (mode === 'always') win.setAlwaysOnTop(true, 'floating');
  else win.setAlwaysOnTop(false);
}

/**
 * 贴桌面档的「再确认一次」。
 * show / 拖拽结束 / 失焦之后都调一下：窗口可能被桌面层重建摘成顶层窗，或落到图标视图后面。
 * attach() 自己会先判断「已经在桌面层且位于图标之上」，是幂等的，不产生多余的原生调用。
 */
function keepOnDesktop(win) {
  if (!win || win.isDestroyed()) return;
  if (win.__dwPinMode !== 'desktop') return;
  const radius = desktopClipRadius(win);
  if (!desktopLevel.attach(win, { radiusPx: radius })) return;
  // 换显示器（缩放不同）后半径要跟着变；clipRounded 内部按键值去重，尺寸没变不会重建区域
  if (desktopLevel.isAttached(win)) desktopLevel.clipRounded(win, radius);
}

/** 贴桌面档的圆角半径（物理像素）：CSS 是 DIP，要按当前显示器的缩放换算 */
function desktopClipRadius(win) {
  try {
    const d = screen.getDisplayMatching(win.getBounds());
    return Math.round(WINDOW_RADIUS * (d.scaleFactor || 1));
  } catch (e) {
    return WINDOW_RADIUS;
  }
}

/**
 * 贴桌面窗被系统销毁后的重建。
 * 桌面层是 Explorer 的窗口，重建时子窗会跟着没了；不重建就等于「贴桌面的浮窗会自己消失」。
 * 次数上限防止「一挂就死 → 重建 → 再死」的死循环拖住主进程。
 */
const REVIVE_MAX = 3;
const reviveCount = new Map();

function scheduleRevive(id) {
  const n = (reviveCount.get(id) || 0) + 1;
  reviveCount.set(id, n);
  if (n > REVIVE_MAX) {
    console.warn(`[desktop] 浮窗 ${id} 反复被系统销毁，停止重建（贴桌面可能不被当前环境支持）`);
    return;
  }
  setTimeout(() => {
    const cur = findProjection(id);
    if (!cur || cur.pinMode !== 'desktop') return;
    if (windowOf(id)) return;
    try {
      openWindow(cur);
      notifyProjections(); // 主窗口菜单 / 托盘里的「已钉清单」要跟着回来
    } catch (e) {
      console.error('[desktop] 重建贴桌面浮窗失败', e && e.message);
    }
  }, 800);
}

function openWindow(p) {
  if (windowOf(p.id)) {
    show(p.id);
    return wins.get(p.id);
  }
  const geo = p.geometry.x == null || p.geometry.y == null
    ? defaultGeometry(p.geometry.h)
    : p.geometry;
  // 位置来自记忆值时也要夹回可视区（副屏拔掉 / 分辨率变了）
  const d = screen.getDisplayMatching({
    x: geo.x, y: geo.y, width: geo.w, height: geo.h,
  });
  const wa = d.workArea;
  const w = clamp(geo.w, MIN_W, MAX_W);
  const h = clamp(p.collapsed ? HEAD_H : geo.h, HEAD_H, MAX_H);
  const x = clamp(geo.x, wa.x, wa.x + wa.width - w);
  const y = clamp(geo.y, wa.y, wa.y + wa.height - h);

  const win = new BrowserWindow({
    x, y, width: w, height: h,
    // 尺寸一律按「内容区」算：Windows 的无边框窗口仍有 3px 左右的隐形边框，
    // 按外框设 286 会得到 292 的内容宽，圆角与内描边就跟设计稿对不上。
    useContentSize: true,
    // min/max 留 8px 余量（这几个参数按外框算），真正的上下限在 JS 里夹
    minWidth: MIN_W - 8, minHeight: HEAD_H - 2,
    maxWidth: MAX_W + 8, maxHeight: MAX_H + 8,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: 'Knodo',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 浮窗常驻桌面，后台节流会让同步 / 计时明显滞后
      backgroundThrottling: false,
    },
  });
  wins.set(p.id, win);
  applyPinMode(win, p);
  applyContentSize(win, w, h);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'desktop.html'), { query: { id: p.id } });

  // 内容驱动的自适应高度：等渲染层报第一次 fit 再显示，避免先闪一个错误高度。
  // 兜底 1.2s：渲染层万一挂了也要让用户看见窗口（否则成了看不见也关不掉的幽灵进程）。
  let shown = false;
  const showOnce = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.showInactive(); // 不抢焦点：正在打字不被打断
    keepOnDesktop(win); // 贴桌面档：确认它还挂在桌面层里（窗口刚建出来时可能还没挂上）
  };
  win.__dwShow = showOnce;
  setTimeout(showOnce, 1200);

  // 拖动松手 → 吸附 + 落盘几何（hover 档要靠鼠标进出切换置顶）
  win.on('moved', () => {
    if (win.isDestroyed()) return;
    if (p.pinMode === 'hover') win.setAlwaysOnTop(true, 'floating');
    snapWindow(win, p);
    keepOnDesktop(win); // 拖拽后重新确认：位置变了，仍要留在桌面层
    schedulePersist(p.id, win);
  });
  win.on('resized', () => {
    if (win.isDestroyed()) return;
    // 窗口尺寸变了，圆角区域要跟着重算（否则边缘会露出直的窗口边界）
    if (win.__dwPinMode === 'desktop') desktopLevel.clipRounded(win, desktopClipRadius(win));
    schedulePersist(p.id, win);
  });
  // 贴桌面档：被点过之后随失焦回到底层（守护还会兜一次，这里只是让回位更即时）
  win.on('blur', () => keepOnDesktop(win));
  win.on('closed', () => {
    wins.delete(p.id);
    const t = persistTimers.get(p.id);
    if (t) { clearTimeout(t); persistTimers.delete(p.id); }
    notifyProjections();
    // 贴桌面档的窗口是桌面层的子窗：桌面层被重建（Explorer 重启）时它可能被系统带着销毁。
    // 那不是用户关掉的，按投影重建一次 —— 否则用户会看到「浮窗自己消失了」。
    // 用户主动取消钉住走 destroyWin()（先打 __dwClosing 标记），不在此列。
    const cur = findProjection(p.id);
    if (!win.__dwClosing && cur && cur.pinMode === 'desktop') scheduleRevive(p.id);
  });
  // 改透明度 / 置顶这类系统级调整后无需重建窗口，统一走 pinMode 即可
  win.webContents.on('did-finish-load', () => {
    if (p.pinMode === 'hover') win.setAlwaysOnTop(false);
  });
  return win;
}

/** 落盘几何：拖拽过程可能有几十次 moved，松手 400ms 后写一次就够 */
function schedulePersist(id, win) {
  const old = persistTimers.get(id);
  if (old) clearTimeout(old);
  persistTimers.set(id, setTimeout(() => {
    persistTimers.delete(id);
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const [cw, ch] = win.getContentSize();
    const d = screen.getDisplayMatching(b);
    patchProjection(id, {
      geometry: {
        x: b.x, y: b.y, w: cw, h: ch, displayId: d.id,
      },
    });
  }, 400));
}

/** 边缘吸附 + 窗间对齐（纯坐标计算，不需要系统级钩子） */
function snapWindow(win, p) {
  if (snapping || win.isDestroyed()) return;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  const wa = d.workArea;
  let { x, y } = b;
  let changed = false;

  // 1) 贴屏幕边：松手时距边 < 12px → 吸附留 8px 视觉边距
  if (Math.abs(x - wa.x) < SNAP_EDGE) { x = wa.x + SNAP_INSET; changed = true; }
  if (Math.abs((x + b.width) - (wa.x + wa.width)) < SNAP_EDGE) { x = wa.x + wa.width - b.width - SNAP_INSET; changed = true; }
  if (Math.abs(y - wa.y) < SNAP_EDGE) { y = wa.y + SNAP_INSET; changed = true; }
  if (Math.abs((y + b.height) - (wa.y + wa.height)) < SNAP_EDGE) { y = wa.y + wa.height - b.height - SNAP_INSET; changed = true; }

  // 2) 与其他浮窗对齐：左/右边界差 < 8px 时对齐，垂直间距 < 8px 时贴合
  for (const [oid, other] of wins) {
    if (oid === p.id || other.isDestroyed()) continue;
    const ob = other.getBounds();
    if (Math.abs(x - ob.x) < SNAP_ALIGN) { x = ob.x; changed = true; }
    else if (Math.abs((x + b.width) - (ob.x + ob.width)) < SNAP_ALIGN) { x = ob.x + ob.width - b.width; changed = true; }
    const gapBelow = y - (ob.y + ob.height);
    if (Math.abs(gapBelow - SNAP_GAP) < SNAP_ALIGN) { y = ob.y + ob.height + SNAP_GAP; changed = true; }
    const gapAbove = ob.y - (y + b.height);
    if (Math.abs(gapAbove - SNAP_GAP) < SNAP_ALIGN) { y = ob.y - b.height - SNAP_GAP; changed = true; }
  }

  if (changed) {
    snapping = true;
    win.setBounds({ x, y, width: b.width, height: b.height });
    // setBounds 会再触发一次 moved，等这一轮走完再放开锁
    setTimeout(() => { snapping = false; }, 120);
  }
}

/**
 * 让「内容区」精确等于 w×h。
 * 为什么不能只用 setContentSize：Windows 的透明无边框窗仍带一圈隐形边框，
 * setContentSize(286) 实测会得到 292 的内容宽 —— 迭代校正一次即可收敛。
 */
function applyContentSize(win, w, h) {
  if (!win || win.isDestroyed()) return;
  for (let i = 0; i < 3; i += 1) {
    const [cw, ch] = win.getContentSize();
    if (cw === w && ch === h) return;
    const b = win.getBounds();
    win.setBounds({
      x: b.x,
      y: b.y,
      width: Math.max(1, b.width + (w - cw)),
      height: Math.max(1, b.height + (h - ch)),
    });
  }
}

/** 窗口夹回可视区（拔掉副屏 / 分辨率变化 / 用户手动改显示设置） */function ensureVisible(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  const wa = d.workArea;
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  const x = clamp(b.x, wa.x, wa.x + wa.width - width);
  const y = clamp(b.y, wa.y, wa.y + wa.height - height);
  if (x !== b.x || y !== b.y || width !== b.width || height !== b.height) {
    win.setBounds({ x, y, width, height });
  }
}

function show(id) {
  const win = windowOf(id);
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.showInactive();
  keepOnDesktop(win);
  return true;
}

function hideWin(id) {
  const win = windowOf(id);
  if (!win) return false;
  win.hide();
  return true;
}

function destroyWin(id) {
  const win = windowOf(id);
  if (!win) return false;
  win.__dwClosing = true; // 我们自己关的，不算「被系统带走」
  wins.delete(id);
  desktopLevel.detach(win);
  win.destroy();
  return true;
}

/**
 * 当前聚焦的浮窗投影（给全局快捷键判断"这次操作是在哪个窗上按的"）。
 * 没有聚焦的浮窗返回 null —— 调用方据此退回主窗口上下文。
 */
function focusedProjection() {
  let focused = null;
  try { focused = BrowserWindow.getFocusedWindow(); } catch (e) { focused = null; }
  if (!focused) return null;
  for (const [id, w] of wins) {
    if (!w.isDestroyed() && w === focused) return findProjection(id);
  }
  return null;
}

/**
 * 一键显示 / 隐藏全部浮窗（Ctrl+Alt+H）。
 * 演示、截屏、共享屏幕时 6 个置顶窗全在屏幕上很尴尬，必须有一个总开关。
 * 隐藏的窗只是 hide，位置与折叠态都不动，再按一次原样回来。
 */
function toggleAllVisible() {
  const list0 = readAll();
  if (!list0.length) return { ok: false, total: 0, visible: false };
  const anyVisible = list0.some((p) => isShown(p.id));
  if (anyVisible) {
    list0.forEach((p) => hideWin(p.id));
    notifyProjections();
    return { ok: true, total: list0.length, visible: false };
  }
  let shown = 0;
  list0.forEach((p) => {
    try {
      if (windowOf(p.id)) show(p.id);
      else openWindow(p);
      shown += 1;
    } catch (e) {
      console.error('[desktop] 显示浮窗失败', e && e.message);
    }
  });
  notifyProjections();
  return { ok: true, total: list0.length, visible: true, shown };
}

/**
 * 唤起第 n 个浮窗（Ctrl+Alt+1~6）并置顶 2 秒。
 * 浮窗可能被别的窗口盖住，数字键比挨个点可靠；置顶 2 秒是"让你看见它在哪"，
 * 之后回落到它自己的置顶策略（always / hover），不改用户配置。
 */
function focusNth(n) {
  const list0 = readAll();
  const idx = Number(n) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= list0.length) {
    return { ok: false, reason: 'none', total: list0.length };
  }
  const p = list0[idx];
  let win = windowOf(p.id);
  if (!win) {
    try { win = openWindow(p); } catch (e) { return { ok: false, reason: 'error', total: list0.length }; }
  }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.show();
    win.focus();
    setTimeout(() => {
      if (win.isDestroyed()) return;
      const cur = findProjection(p.id);
      if (cur) applyPinMode(win, cur);
    }, 2000);
  }
  return { ok: true, total: list0.length, title: safeView(p).title };
}

/* ------------------------------ 对外操作 ------------------------------ */

function pin(kind, refId) {
  if (!KINDS.includes(kind)) throw new Error('不支持的浮窗类型');
  const rid = kind === 'group' ? Number(refId) : null;
  if (kind === 'group') {
    if (!Number.isFinite(rid)) throw new Error('缺少分组');
    if (!db.getGroup(rid)) throw new Error('分组不存在（可能已被删除）');
  }
  const list0 = readAll();
  // 非 group 的 kind 的 refId 恒为 null，这条判断天然就是单例约束：
  // 再点一次「钉到桌面」只会 focus 已有窗口，不会贴出好几个一模一样的视图投影。
  const exist = list0.find((p) => p.kind === kind && p.refId === rid);
  if (exist) {
    openWindow(exist);
    return { ok: true, projection: exist, existed: true };
  }
  if (list0.length >= MAX_WINDOWS) {
    throw new Error(`已钉满 ${MAX_WINDOWS} 个浮窗，请先收起一个再钉`);
  }
  const p = normalizeProjection({
    id: newId(), kind, refId: rid,
    pinMode: 'always',
    geometry: { w: DEF_W, h: 320 },
  });
  const geo = defaultGeometry(p.geometry.h);
  p.geometry.x = geo.x;
  p.geometry.y = geo.y;
  p.geometry.displayId = geo.displayId;
  writeAll([...list0, p]);
  reviveCount.delete(p.id);
  openWindow(p);
  notifyProjections();
  return { ok: true, projection: p, existed: false };
}

function unpin(id) {
  const list0 = readAll();
  const next = list0.filter((p) => p.id !== id);
  if (next.length === list0.length) return { ok: false, reason: '浮窗不存在' };
  writeAll(next);
  destroyWin(id);
  notifyProjections();
  return { ok: true };
}

function togglePin(kind, refId) {
  const rid = kind === 'group' ? Number(refId) : null;
  const exist = readAll().find((p) => p.kind === kind && p.refId === rid);
  if (exist) return unpin(exist.id);
  return pin(kind, refId);
}

/** 分组被删除 → 对应浮窗显示「该清单已删除」，由渲染层 3 秒后自行调用 unpin */
function dropByGroup(groupId) {
  const hit = readAll().filter((p) => p.kind === 'group' && p.refId === Number(groupId));
  hit.forEach((p) => {
    const win = windowOf(p.id);
    if (win) win.webContents.send('desktop:missing', p.id);
  });
  return hit.map((p) => p.id);
}

function update(id, patch = {}) {
  const cur = findProjection(id);
  if (!cur) throw new Error('浮窗不存在');
  const next = { ...cur };
  if (patch.pinMode && ['always', 'hover', 'desktop'].includes(patch.pinMode)) next.pinMode = patch.pinMode;
  if (patch.collapsed != null) next.collapsed = !!patch.collapsed;
  if (patch.geometry && typeof patch.geometry === 'object') {
    next.geometry = { ...cur.geometry, ...patch.geometry };
  }
  const saved = patchProjection(id, next);
  if (patch.pinMode) reviveCount.delete(id); // 用户重新选过档位，重建额度重置
  const win = windowOf(id);
  if (win && patch.pinMode) applyPinMode(win, saved);
  // 折叠状态被主进程侧改掉时（例如菜单里点「折叠」），要让渲染层跟着收 / 展，
  // 否则窗口高度变了、内容还停在上一个状态
  if (win && patch.collapsed != null && next.collapsed !== cur.collapsed) {
    win.webContents.send('desktop:collapsed', next.collapsed);
  }
  return saved;
}

/** 内容自适应高度：保持顶边不动，超出屏幕则整体上移 */
function fit(id, height) {
  const p = findProjection(id);
  if (!p) return false;
  const win = windowOf(id);
  const h = clamp(Math.round(Number(height) || HEAD_H), HEAD_H, MAX_H);
  if (!win) return false;
  const b = win.getBounds();
  const size = win.getContentSize();
  const wa = screen.getDisplayMatching(b).workArea;
  let y = b.y;
  if (y + h > wa.y + wa.height) y = Math.max(wa.y, wa.y + wa.height - h);
  if (b.y !== y) win.setPosition(b.x, y);
  const w = clamp(p.geometry.w, MIN_W, MAX_W);
  if (size[0] !== w || size[1] !== h) applyContentSize(win, w, h);
  if (typeof win.__dwShow === 'function') win.__dwShow();
  // 高度记进 projection：下次启动先按上次高度开窗，少一次跳动
  if (p.geometry.h !== h) {
    const t = persistTimers.get(id);
    if (t) clearTimeout(t);
    persistTimers.set(id, setTimeout(() => {
      persistTimers.delete(id);
      patchProjection(id, { geometry: { h } });
    }, 600));
  }
  return true;
}

/**
 * 右下角手柄手动改宽度（高度永远随内容，所以这里只调宽）。
 * 宽度会顺手记成该窗的默认宽，下次打开还是这个宽度。
 */
function resize(id, width) {
  const win = windowOf(id);
  if (!win) return false;
  const [cw, ch] = win.getContentSize();
  const w = clamp(Math.round(Number(width) || cw), MIN_W, MAX_W);
  applyContentSize(win, w, ch);
  schedulePersist(id, win);
  return true;
}

function resetPosition(id) {
  const win = windowOf(id);
  if (!win) return false;
  const ch = win.getContentSize()[1];
  const geo = defaultGeometry(ch);
  applyContentSize(win, DEF_W, ch);
  win.setPosition(geo.x, geo.y);
  schedulePersist(id, win);
  return true;
}

function printMenu(id) {
  const p = findProjection(id);
  const win = windowOf(id);
  if (!p || !win) return false;
  const mode = p.pinMode;
  // 贴桌面靠原生挂载（Windows SetParent 到桌面层）。拿不到能力就别给一个「选了但没效果」的选项，
  // 这是这一档原来被标成「实验性」的由来 —— 现在改成如实标注可用性。
  const canDesktop = desktopLevel.available();
  const template = [
    {
      label: '置顶方式',
      submenu: [
        { label: '始终置顶', type: 'radio', checked: mode === 'always', click: () => update(id, { pinMode: 'always' }) },
        { label: '仅悬停置顶', type: 'radio', checked: mode === 'hover', click: () => update(id, { pinMode: 'hover' }) },
        {
          label: canDesktop ? '贴桌面（随桌面一起显示）' : '贴桌面（当前系统不支持）',
          type: 'radio',
          enabled: canDesktop,
          checked: mode === 'desktop',
          click: () => update(id, { pinMode: 'desktop' }),
        },
      ],
    },
    { type: 'separator' },
    {
      label: p.collapsed ? '展开清单' : '折叠为标题条',
      // update() 里会自动把新状态推给渲染层，这里不用再发一遍
      click: () => update(id, { collapsed: !p.collapsed }),
    },
    { label: '恢复默认位置', click: () => resetPosition(id) },
    { type: 'separator' },
    {
      label: '取消钉住',
      click: () => unpin(id),
    },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
  return true;
}

/* ------------------------------ 广播 ------------------------------ */

function isDesktopSender(sender) {
  if (!sender) return false;
  for (const w of wins.values()) {
    if (!w.isDestroyed() && w.webContents === sender) return true;
  }
  return false;
}

function notifyProjections() {
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) mw.webContents.send('desktop:projection-changed', list());
  try { onChanged(); } catch (e) { /* 菜单重建失败不影响数据 */ }
}

/**
 * 数据变更广播。
 *  - 浮窗之间：各自重拉自己的投影（不做全量刷新，避免滚动位置丢失）；
 *  - 浮窗 → 主窗口：只有变化来自浮窗时才通知主窗口重绘，主窗口自己的操作不需要再回灌一遍
 *    （那会让正在编辑的行丢焦点、列表丢滚动位置）。
 */
function notifyChange(sender, payload) {
  const fromDesktop = isDesktopSender(sender);
  const src = fromDesktop ? sender : null;
  for (const [id, w] of wins) {
    if (w.isDestroyed()) continue;
    if (src && w.webContents === src) continue;
    w.webContents.send('desktop:invalidate', id);
  }
  if (fromDesktop) {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) mw.webContents.send('ui:data-changed', payload || {});
  }
}

/* ------------------------------ IPC ------------------------------ */

function wrap(fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      console.error('[desktop]', e && e.message ? e.message : e);
      return { __error: (e && e.message) || String(e) };
    }
  };
}

function registerIpc() {
  ipcMain.handle('desktop:list', wrap(() => list()));

  ipcMain.handle('desktop:pin', wrap((_e, kind, refId) => pin(kind, refId)));
  ipcMain.handle('desktop:unpin', wrap((_e, id) => unpin(id)));
  ipcMain.handle('desktop:togglePin', wrap((_e, kind, refId) => togglePin(kind, refId)));

  ipcMain.handle('desktop:get', wrap((_e, id) => {
    const p = findProjection(id);
    if (!p) throw new Error('浮窗已被移除');
    const view = buildView(p);
    // 番茄钟：浮窗同步显示「正在专注那一格」的倒计时（只读展示）
    return { ...view, projection: p, focus: focus.peek() };
  }));

  ipcMain.handle('desktop:toggleTask', wrap((event, taskId) => {
    if (!db.isReady()) throw new Error('数据库未就绪');
    const t = db.toggleTask(taskId);
    if (!t) throw new Error('任务不存在或已删除');
    notifyChange(event.sender, { taskId: t.id, completed: t.completed, parentId: t.parent_id || null });
    return t;
  }));

  ipcMain.handle('desktop:deleteTask', wrap(async (event, id, taskId) => {
    if (!db.isReady()) throw new Error('数据库未就绪');
    const t = db.getTask(taskId);
    if (!t) throw new Error('任务不存在或已删除');
    const win = windowOf(id);
    const opts = {
      type: 'warning',
      title: '删除任务',
      message: `确定删除「${t.title}」？`,
      detail: '删除后不可恢复（子任务会一起删除，附件文件也会清理）。',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    if (response !== 0) return { ok: false, canceled: true };
    const ids = db.subtreeTaskIds(taskId);
    const ok = db.deleteTask(taskId);
    ids.forEach((tid) => { try { attachments.removeTaskDir(tid); } catch (e) { /* 清理失败不影响删库结果 */ } });
    notifyChange(event.sender, { removed: true });
    return { ok: !!ok };
  }));

  ipcMain.handle('desktop:addTask', wrap((event, id, title) => {
    if (!db.isReady()) throw new Error('数据库未就绪');
    const p = findProjection(id);
    if (!p) throw new Error('浮窗已被移除');
    const text = String(title || '').trim();
    if (!text) throw new Error('任务标题不能为空');
    if (text.length > 200) throw new Error('任务标题过长（最多 200 字）');
    // 视图投影（今天 / 即将到期）里新增的任务默认挂在今天：
    // 与主窗口「今天」的计划完成日期口径一致，也让它在「即将到期」（今天或之后）里立刻看得见 ——
    // 留空日期的任务根本不会出现在「即将到期」里，加了等于没加。
    const t = db.createTask(p.kind === 'today' || p.kind === 'upcoming'
      ? { title: text, planEnd: todayStr() }
      : { title: text, groupId: p.refId });
    notifyChange(event.sender, { created: t.id });
    return t;
  }));

  ipcMain.handle('desktop:update', wrap((_e, id, patch) => update(id, patch)));
  ipcMain.handle('desktop:fit', wrap((_e, id, h) => fit(id, h)));
  ipcMain.handle('desktop:size', wrap((_e, id, w) => resize(id, w)));

  ipcMain.handle('desktop:hover', wrap((_e, id, on) => {
    const p = findProjection(id);
    const win = windowOf(id);
    if (!p || !win || p.pinMode !== 'hover') return false;
    win.setAlwaysOnTop(!!on, 'floating');
    return true;
  }));

  ipcMain.handle('desktop:menu', wrap((_e, id) => printMenu(id)));
  // 诊断：贴桌面到底挂上没有（用户报「没效果」时先看这里，不用远程连桌面）
  ipcMain.handle('desktop:diagnostics', wrap(() => ({
    level: desktopLevel.status(),
    windows: [...wins].map(([id, w]) => {
      const dead = w.isDestroyed();
      const info = dead ? { attached: false, hwnd: null, parent: null, parentClass: null, aboveIcons: false } : desktopLevel.inspect(w);
      return {
        id,
        pinMode: w.__dwPinMode || null,
        hwnd: info.hwnd,
        visible: dead ? false : w.isVisible(),
        focused: dead ? false : w.isFocused(),
        // 贴桌面档：attached=是否挂在桌面层，aboveIcons=是否压在图标视图之上（点击能否命中）
        attached: info.attached,
        parent: info.parent,
        parentClass: info.parentClass,
        aboveIcons: info.aboveIcons,
        topmost: info.topmost === true,
        bounds: dead ? null : w.getBounds(),
      };
    }),
  })));
  ipcMain.handle('desktop:show', wrap((_e, id) => show(id)));
  ipcMain.handle('desktop:hide', wrap((_e, id) => hideWin(id)));
  ipcMain.handle('desktop:resetPosition', wrap((_e, id) => resetPosition(id)));

  ipcMain.handle('desktop:openInMain', wrap((_e, taskId) => {
    const mw = getMainWindow();
    if (!mw || mw.isDestroyed()) return false;
    if (mw.isMinimized()) mw.restore();
    mw.show();
    mw.focus();
    mw.webContents.send('ui:focus-task', taskId);
    return true;
  }));

}

/* ------------------------------ 生命周期 ------------------------------ */

/**
 * @param {object} opts
 * @param {() => BrowserWindow|null} opts.getMainWindow
 * @param {() => void} [opts.onChanged] 投影列表变化（主窗口菜单 / 托盘菜单要重建）
 */
function init(opts = {}) {
  getMainWindow = opts.getMainWindow || (() => null);
  onChanged = opts.onChanged || (() => {});
  registerIpc();

  // 显示器拔插 / 分辨率变化：把窗口夹回可视区
  const onDisplayChange = () => {
    for (const w of wins.values()) {
      ensureVisible(w);
      // 换屏 / 改缩放后圆角半径的物理像素值会变，重新裁一次
      keepOnDesktop(w);
    }
  };
  screen.on('display-removed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-metrics-changed', onDisplayChange);
}

/** 启动时还原已钉的清单（不抢焦点） */
function restoreAll() {
  if (!db.isReady()) return 0;
  const list0 = readAll();
  if (!list0.length) return 0;
  // 分组已被删掉的投影：顺手清理，不要留一个永远显示「已删除」的窗口
  const alive = list0.filter((p) => p.kind !== 'group' || db.getGroup(p.refId));
  if (alive.length !== list0.length) writeAll(alive);
  alive.slice(0, MAX_WINDOWS).forEach((p) => {
    try { openWindow(p); } catch (e) { console.error('[desktop] 还原浮窗失败', e && e.message); }
  });
  // 开机自启时 Explorer / 桌面层可能比我们晚就绪，第一次挂不上；给一次延迟补挂
  setTimeout(() => {
    for (const p of alive) {
      const w = windowOf(p.id);
      if (w && w.__dwPinMode === 'desktop') keepOnDesktop(w);
    }
  }, 2500);
  return alive.length;
}

/** 退出前销毁（不再回写任何状态） */
function destroyAll() {
  desktopLevel.detachAll();
  for (const w of wins.values()) {
    w.__dwClosing = true;
    if (!w.isDestroyed()) w.destroy();
  }
  wins.clear();
  reviveCount.clear();
}

module.exports = {
  init, restoreAll, destroyAll,
  list, pin, unpin, togglePin, update, fit, resize, resetPosition,
  show, hide: hideWin, dropByGroup, notifyChange, isDesktopSender,
  toggleAllVisible, focusNth, focusedProjection,
  MAX_WINDOWS,
};
