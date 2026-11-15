'use strict';
/**
 * 截图建任务（Ctrl+Alt+V 读剪贴板 / Ctrl+Alt+S 框选屏幕）。
 *
 * 三条设计约束，改代码前先读：
 *
 * 1. **图片字节永不双向传递**。主进程截完、压好、自己拿着；渲染层只拿 420px 缩略图，
 *    要点开看大图再单独要一次（shot:image）。否则 1080p 截图 base64 之后 400KB+，
 *    每开一次卡片就过一次 IPC，主窗口会明显卡一下。
 * 2. **识别与落库彻底分开**。recognize() 只调模型、只返回数据，一个字节都不写库；
 *    commit() 只吃用户确认后的数组。中间那段是"用户可能全部取消"的地带，不能有副作用。
 * 3. **这个模块不 require ipc.js**（会成环）。视觉配置的读取在这里自己实现，
 *    与 ipc.js#getAiConfig 保持同一套 settings 键。
 */

const {
  clipboard, desktopCapturer, screen, ipcMain, nativeImage,
} = require('electron');
const db = require('./db');
const attachments = require('./attachments');
const crypto = require('./crypto');
const ai = require('./ai');
const shotOverlay = require('./shot-overlay');

/** 长边压到 1280：1080p 截图约 180–280KB，视觉模型看得清，也不至于传半天 */
const MAX_EDGE = 1280;
const JPEG_Q = 80;
/** 覆盖层背景图的上限：只需"看得清"，压到 2560 是为了 4K 下别把 IPC 撑爆 */
const OVERLAY_MAX_EDGE = 2560;
const OVERLAY_Q = 92;
/** 缩略图宽度（卡片左侧那一块） */
const THUMB_W = 420;
/** 暂存有效期：用户截完图去泡了杯咖啡回来，这张图就该作废了 */
const PENDING_TTL = 10 * 60 * 1000;

/** 当前暂存的图：{ at, source, dataUrl, thumb, width, height, originW, originH } */
let pending = null;
let getMainWindow = () => null;
let onDataChange = () => {};

/* ------------------------------ 小工具 ------------------------------ */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function userError(msg, code) {
  const e = new Error(msg);
  e.userFacing = true;
  if (code) e.code = code;
  return e;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 附件相对路径 → todo-media:/// URL（与 ipc.js#mediaUrlOf 同一口径） */
function mediaUrlOf(entry) {
  const rel = String((entry && entry.path) || '').replace(/^\/+/, '');
  return `todo-media:///${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** nativeImage → JPEG data URL；超过 maxEdge 先等比缩小 */
function toJpeg(img, maxEdge, quality) {
  const size = img.getSize();
  let out = img;
  const long = Math.max(size.width, size.height);
  if (maxEdge && long > maxEdge) {
    const r = maxEdge / long;
    out = img.resize({
      width: Math.max(1, Math.round(size.width * r)),
      height: Math.max(1, Math.round(size.height * r)),
      quality: 'best',
    });
  }
  const buf = out.toJPEG(quality);
  const os = out.getSize();
  return {
    buf,
    dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
    width: os.width,
    height: os.height,
  };
}

/**
 * 把一张 nativeImage 存成待确认的截图。
 * 原图不保留（用户没确认就什么也不该留在磁盘上），压缩后的 JPEG 一直留在内存里。
 */
function setPending(img, source) {
  const origin = img.getSize();
  const full = toJpeg(img, MAX_EDGE, JPEG_Q);
  // 缩略图从压缩后的图上再缩一次：从原图缩会多算一遍大像素，慢且没必要
  const small = img.resize({
    width: Math.min(THUMB_W, origin.width),
    height: Math.max(1, Math.round(origin.height * (Math.min(THUMB_W, origin.width) / origin.width))),
    quality: 'good',
  });
  pending = {
    at: Date.now(),
    source: source || 'region',
    dataUrl: full.dataUrl,
    thumb: `data:image/jpeg;base64,${small.toJPEG(72).toString('base64')}`,
    width: full.width,
    height: full.height,
    originW: origin.width,
    originH: origin.height,
  };
  return pending;
}

/** 过期的暂存直接丢掉，免得用户看到一张十分钟前的图还以为刚截的 */
function alivePending() {
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_TTL) {
    pending = null;
    return null;
  }
  return pending;
}

/* ------------------------------ 视觉模型配置 ------------------------------ */

/** 去掉尾部斜杠 + 统一小写，用来判断"是不是同一个服务商"（决定 Key 能不能复用） */
function sameBase(a, b) {
  const n = (s) => String(s || '').trim().replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b) && !!n(a);
}

function readVisionConfig() {
  const mainBase = db.getSetting('ai.baseUrl', ai.DEFAULT_CONFIG.baseUrl);
  const mainModel = db.getSetting('ai.model', ai.DEFAULT_CONFIG.model);
  const mainKey = crypto.decryptApiKey(db.getSetting('ai.apiKey', '')).value;
  const vBase = String(db.getSetting('ai.visionBaseUrl', '') || '').trim();
  const vModel = String(db.getSetting('ai.visionModel', '') || '').trim();
  const vKey = crypto.decryptApiKey(db.getSetting('ai.visionKey', '')).value;

  const baseUrl = vBase || mainBase;
  const model = vModel || mainModel;
  const source = vModel ? 'vision' : 'fallback';
  // Key 复用有个坑：只有地址相同才能借主 Key，地址不同还复用必然 401
  const reuse = !vKey && sameBase(baseUrl, mainBase);
  const apiKey = vKey || (reuse ? mainKey : '');

  return {
    baseUrl, model, apiKey, source,
    mainBase, mainModel, vBase, vModel,
    hasKey: !!apiKey,
    capability: ai.visionCapability(model),
    label: ai.modelLabel(model),
  };
}

/** 给界面看的配置快照（绝不下发 Key 本身） */
function visionStatus() {
  const c = readVisionConfig();
  return {
    model: c.model,
    label: c.label,
    source: c.source,
    baseUrl: c.baseUrl,
    imageCapability: c.capability,
    hasKey: c.hasKey,
    keyReused: !c.vKey && !!c.apiKey,
  };
}

/**
 * 取真正可用的视觉配置。
 * 只判 Key —— 模型能不能吃图不在这里猜：名字白名单挡掉过 qwen3.8-flash 这类
 * 原生多模态模型，真正该做的是把图发出去，让服务端回答（错误在 recognize 里翻译）。
 */
function resolveVision() {
  const c = readVisionConfig();
  if (!c.apiKey) {
    if (c.vBase && !sameBase(c.vBase, c.mainBase)) {
      throw userError('视觉模型来自另一个服务商，需要单独的 API Key', 'VISION_KEY_MISSING');
    }
    throw userError('还没有配置 AI Key：设置 → AI 与语音', 'NO_API_KEY');
  }
  return { baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, source: c.source };
}

/* ------------------------------ 状态 / 取图 ------------------------------ */

function status() {
  const p = alivePending();
  return {
    hasImage: !!p,
    preview: p ? p.thumb : '',
    width: p ? p.width : 0,
    height: p ? p.height : 0,
    source: p ? p.source : '',
    vision: visionStatus(),
  };
}

/**
 * 从剪贴板取图。
 * Electron 44 的 clipboard 是**异步 W3C 风格**的（read() / getType()），
 * 老教程里的 clipboard.readImage() 已经不在了 —— 这里按 MIME 类型挑第一个图片块，
 * 用 nativeImage 复原。写回图片同理（write 是 Promise），但本项目不写剪贴板。
 */
async function readClipboardImage() {
  let items = [];
  try {
    items = await clipboard.read();
  } catch (e) {
    return null;
  }
  for (const item of items || []) {
    const types = (item && item.types) || [];
    // 优先 PNG：Win+Shift+S 给的就是它，无损、nativeImage 直接吃
    const type = types.find((t) => /^image\/png$/i.test(t))
      || types.find((t) => /^image\/(jpeg|jpg|bmp|webp)$/i.test(t));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      if (!blob || typeof blob.arrayBuffer !== 'function') continue;
      const img = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      if (img && !img.isEmpty()) return img;
    } catch (e) { /* 这一块读坏了就试下一块 */ }
  }
  return null;
}

/** 剪贴板路径（主入口）：不隐藏窗口、不建覆盖层、不涉及屏幕权限 */
async function captureClipboard() {
  const img = await readClipboardImage();
  if (!img) {
    throw userError('剪贴板里没有图片，先按 Win+Shift+S 截一下（或改用 Ctrl+Alt+S 框选）', 'NO_IMAGE');
  }
  setPending(img, 'clipboard');
  return status();
}

/**
 * 区域截图：隐藏主窗口 → 截当前鼠标所在屏 → 覆盖层框选 → 用**原图**裁剪。
 * 背景用压缩图（覆盖层只要看得清），裁剪必须作用在未压缩的 nativeImage 上 ——
 * 这一步做反了，附件会糊一圈。
 */
async function captureRegion() {
  if (shotOverlay.isOpen()) {
    shotOverlay.cancel('replaced');
    return { canceled: true, reason: 'replaced' };
  }
  const main = getMainWindow();
  const wasVisible = !!(main && !main.isDestroyed() && main.isVisible());
  if (wasVisible) {
    main.hide();
    // 等窗口真的从合成器上撤掉；不等的话截出来会带自己的残影
    await delay(220);
  }
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = display.scaleFactor || 1;
    // thumbnailSize 是**物理像素**：按逻辑像素传，高分屏会糊到看不清表格数字
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(1, Math.round(display.bounds.width * scale)),
        height: Math.max(1, Math.round(display.bounds.height * scale)),
      },
      fetchWindowIcons: false,
    });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) {
      throw userError('没有截到画面（可能被系统权限拦下），可以改用剪贴板方式', 'NO_IMAGE');
    }
    const full = src.thumbnail;
    const fullSize = full.getSize();
    const bg = toJpeg(full, OVERLAY_MAX_EDGE, OVERLAY_Q);

    const result = await shotOverlay.open({
      image: bg.dataUrl,
      width: display.bounds.width,
      height: display.bounds.height,
      bounds: display.bounds,
    });
    if (!result || !result.rect) {
      return { canceled: true, reason: (result && result.reason) || 'cancel' };
    }

    // 坐标换算用「原图物理宽 / 画布逻辑宽」，不信 scaleFactor：窗口内容尺寸和 display.bounds
    // 差哪怕 1px，用 scaleFactor 乘出来的结果就会整体偏一点
    const stage = result.stage && result.stage.w > 0 ? result.stage : display.bounds;
    const sx = fullSize.width / Math.max(1, stage.w);
    const sy = fullSize.height / Math.max(1, stage.h);
    const r = result.rect;
    // 换算链路里三个数只要有一个不对，附件就会整体偏 / 被拉伸，日志里必须留着它们
    console.log('[shot] crop 换算', JSON.stringify({
      display: display.bounds, scale, fullSize, stage, rect: r, sx, sy,
    }));
    const x = clamp(Math.round(r.x * sx), 0, fullSize.width - 1);
    const y = clamp(Math.round(r.y * sy), 0, fullSize.height - 1);
    const w = clamp(Math.round(r.w * sx), 1, fullSize.width - x);
    const h = clamp(Math.round(r.h * sy), 1, fullSize.height - y);
    const img = full.crop({ x, y, width: w, height: h });
    if (!img || img.isEmpty()) {
      throw userError('没有截到画面（可能被系统权限拦下），可以改用剪贴板方式', 'NO_IMAGE');
    }
    setPending(img, 'region');
    return { ...status(), crop: { x, y, w, h } };
  } finally {
    // 主窗口还原必须放 finally：取消 / 出错时窗口也不能一直藏着
    if (wasVisible && main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
  }
}

/* ------------------------------ 识别 ------------------------------ */

async function recognize() {
  const p = alivePending();
  if (!p) {
    throw userError('这张截图过期了，请重新截一次', 'STALE');
  }
  const cfg = resolveVision();
  let raw;
  try {
    raw = await ai.recognizeTasksFromImage(p.dataUrl, cfg);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // 服务端明确拒绝图片输入：换个视觉模型是唯一正确的下一步，保留 NO_VISION 让卡片显示「去配置」
    if (e && e.code === 'NO_VISION') throw userError(msg, 'NO_VISION');
    if (/超时|timeout|aborted/i.test(msg)) {
      throw userError('识别超时，可能是网络或模型太慢（可重试，或换一个更快的视觉模型）', 'TIMEOUT');
    }
    throw userError(msg, 'RECOGNIZE_FAILED');
  }
  let parsed = { summary: '', tasks: [] };
  let parseErr = null;
  try {
    parsed = ai.parseShotReply(raw);
  } catch (e) {
    parseErr = e;
  }

  // 待办拆不出来（空数组 / 不是约定 JSON）时，先别让用户空手而归：
  // 再问一次「至少把文字读出来」，提炼成一条草稿放进确认卡，仍然不直接落库。
  if (!parsed.tasks.length) {
    let ocr = null;
    try {
      ocr = ai.parseTextShotReply(await ai.recognizeTextFromImage(p.dataUrl, cfg));
    } catch (e) {
      ocr = null;
    }
    if (ocr && ocr.title) {
      return {
        summary: '',
        tasks: [{ title: ocr.title, note: ocr.note || '', priority: 1, due: '' }],
        fallback: 'text',
        model: cfg.model,
        modelLabel: ai.modelLabel(cfg.model),
        source: cfg.source,
        width: p.width,
        height: p.height,
      };
    }
    if (parseErr) throw userError(parseErr.message || 'AI 返回的内容看不懂，请重试', 'RECOGNIZE_FAILED');
  }

  return {
    summary: parsed.summary,
    tasks: parsed.tasks,
    model: cfg.model,
    modelLabel: ai.modelLabel(cfg.model),
    source: cfg.source,
    width: p.width,
    height: p.height,
  };
}
/* ------------------------------ 落库 ------------------------------ */

/** 清单落点：与捕捉条、行内新建同口径（ui.lastAddGroupId → 第一个清单） */
function resolveGroup() {
  const last = Number(db.getSetting('ui.lastAddGroupId', '') || 0);
  if (Number.isFinite(last) && last > 0) {
    const g = db.getGroup(last);
    if (g) return { id: g.id, name: g.name };
  }
  const groups = db.listGroups();
  if (!groups.length) return null;
  return { id: groups[0].id, name: groups[0].name };
}

/**
 * 建任务 + 存附件 + 写描述。
 * 顺序不能反：先建任务拿 id（附件目录名就是 task-<id>），再落图片。
 * 图片落盘失败不算致命（任务本身还有用），但要如实回报 imageErrors。
 */
function commit(payload = {}) {
  const p = alivePending();
  if (!p) throw userError('这张截图过期了，请重新截一次', 'STALE');

  const list = (Array.isArray(payload.tasks) ? payload.tasks : [])
    .map((t) => ({
      title: String((t && t.title) || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      note: String((t && t.note) || '').trim().slice(0, 500),
      priority: clamp(Math.round(Number(t && t.priority) || 0), 0, 3),
    }))
    .filter((t) => t.title);
  if (!list.length) throw userError('至少要留一条任务', 'EMPTY');

  const group = resolveGroup();
  if (!group) throw userError('还没有清单，先在主窗口建一个', 'NO_GROUP');

  const today = todayStr();
  const imageErrors = [];
  const taskIds = [];
  list.forEach((t) => {
    const task = db.createTask({
      title: t.title,
      groupId: group.id,
      planStart: today,
      planEnd: today,
      priority: t.priority,
    });
    taskIds.push(task.id);
    const head = t.note ? `<p>${escHtml(t.note)}</p>` : '';
    try {
      const entry = attachments.importDataUrl('task', task.id, p.dataUrl, `截图-${stamp()}`);
      db.setAttachments(task.id, [...(task.attachments || []), entry]);
      // 附件元数据走 setAttachments，正文走 updateTask：两者分开，谁也不会覆盖谁
      db.updateTask(task.id, { notes: `${head}<p><img src="${mediaUrlOf(entry)}"></p>` });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.warn('[shot] 截图落盘失败', msg);
      imageErrors.push(msg);
      if (head) {
        try { db.updateTask(task.id, { notes: head }); } catch (err) { /* 描述写不进去也不该让建任务失败 */ }
      }
    }
  });

  try { db.setSetting('ui.lastAddGroupId', String(group.id)); } catch (e) { /* 非关键 */ }
  pending = null;
  try { onDataChange({ created: taskIds.length }); } catch (e) { /* 刷新失败不影响已保存 */ }

  return {
    ok: true,
    created: taskIds.length,
    taskIds,
    group,
    imageErrors,
  };
}

function discard() {
  const had = !!pending;
  pending = null;
  return { ok: true, had };
}

/* ------------------------------ 主窗口联动 ------------------------------ */

/** 确认卡在主窗口里：用户可能是从别的应用按的键，此刻窗口还是隐藏的 */
function notifyCard() {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const send = () => {
    try { win.webContents.send('ui:screenshot', status()); } catch (e) { /* 窗口正在关 */ }
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

/** 快捷键入口：取图成功才建卡（取消 / 无图都不该弹窗） */
async function shortcutClipboard() {
  const st = await captureClipboard();
  notifyCard();
  return st;
}

async function shortcutRegion() {
  const st = await captureRegion();
  if (st && !st.canceled) notifyCard();
  else if (st && st.reason === 'timeout') {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.show();
      try { win.webContents.send('ui:shot-timeout'); } catch (e) { /* 忽略 */ }
    }
  }
  return st;
}

/* ------------------------------ IPC ------------------------------ */

function wrap(fn) {
  return async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (!(e && e.userFacing)) console.error('[shot]', e && e.message ? e.message : e);
      // __code 会在 preload 的 call() 里还原成 err.code：卡片靠它决定要不要显示「去配置」
      return { __error: (e && e.message) || String(e), __code: (e && e.code) || '' };
    }
  };
}

function registerIpc() {
  const on = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch (e) { /* 没注册过 */ }
    ipcMain.handle(channel, wrap(fn));
  };
  on('shot:status', () => status());
  on('shot:screen', () => captureRegion());
  on('shot:clipboard', () => captureClipboard());
  on('shot:recognize', () => recognize());
  on('shot:commit', (payload) => commit(payload || {}));
  on('shot:discard', () => discard());
  on('shot:image', () => {
    const p = alivePending();
    if (!p) throw userError('这张截图过期了，请重新截一次', 'STALE');
    return { dataUrl: p.dataUrl, width: p.width, height: p.height };
  });
}

/**
 * @param {object} opts
 * @param {() => (import('electron').BrowserWindow|null)} opts.getMainWindow
 * @param {(payload:object) => void} [opts.onDataChange]
 */
function init(opts = {}) {
  getMainWindow = opts.getMainWindow || (() => null);
  onDataChange = opts.onDataChange || (() => {});
  shotOverlay.registerIpc();
  registerIpc();
}

function destroy() {
  shotOverlay.cancel('quit');
  pending = null;
}

module.exports = {
  init,
  destroy,
  // 快捷键入口（带建卡通知）
  shortcutClipboard,
  shortcutRegion,
  // 供 IPC / 验收脚本直接调
  captureClipboard,
  captureRegion,
  recognize,
  commit,
  discard,
  status,
  resolveVision,
  setPending,
};

