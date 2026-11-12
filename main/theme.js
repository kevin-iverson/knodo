'use strict';
/**
 * 外观主题（模式 × 风格 × 背景图）。
 *
 * 存的是「一份对象」而不是一个字符串：
 *   { mode, style, backdrop: { type, image, opacity, blur, fit, scrim, glass, luma } }
 * 老版本存的是 'light' / 'dark' / 'system'，read() 时包成新结构（写回也统一成新结构），
 * 所以不需要 DB 迁移 —— 这个键本来就在 settings 表里，只是值从字符串变成 JSON。
 *
 * 背景图落盘在 `<数据目录>/attachments/theme/bg-<ts>.<ext>`，config 里只存相对路径
 * （`theme/bg-xxx.jpg`），整目录搬家 / 备份后仍然有效，渲染层用 todo-media:/// 引用。
 *
 * 图片处理只用 Electron 自带的 nativeImage（不引入 sharp / jimp）：
 * 长边压到 2560，JPEG(q82) 与 PNG 各编一次取更小的那个 —— 照片走 JPEG（8MB → 约 400KB），
 * 线稿 / 插画保留 PNG 免得糊。顺带用 toBitmap() 采样算平均亮度（scrim 自动档要用）。
 */
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

/** 六套风格：只定义色相与饱和度，圆角 / 间距 / 字号沿用现值（切风格零布局抖动） */
const STYLES = ['mist', 'graphite', 'moss', 'sepia', 'sakura', 'contrast'];

/** 每套风格的底色（窗口背景 / 启动防白闪只需 bg 这一个值，其余 token 在渲染层） */
const BG_HEX = {
  mist: { light: '#f5f6f8', dark: '#15181f' },
  graphite: { light: '#e9ecf1', dark: '#0f1216' },
  moss: { light: '#eef2e9', dark: '#131a14' },
  sepia: { light: '#f6f0e4', dark: '#1b1610' },
  sakura: { light: '#fbf1f3', dark: '#1a1417' },
  contrast: { light: '#ffffff', dark: '#000000' },
};

/**
 * 出厂默认 = 宣纸（sepia），不是雾灰。
 * 理由：雾灰浅色的面板是纯白（#ffffff），第一眼就是「又一个白底效率工具」；
 * 宣纸的暖米色才是这个产品的气质（品牌暖墨底 + 象牙 + 朱砂）。
 * 注意：只有「从来没设置过」才走这里 —— 用户存过 style（哪怕只是切过明暗，
 * write() 会把当时的 style 一起写回）就一律尊重他的值，绝不强行改色。
 */
const DEFAULT_THEME = {
  mode: 'system',
  style: 'sepia',
  backdrop: {
    type: 'none',
    image: '',
    opacity: 60,
    blur: 0,
    fit: 'cover',
    scrim: 'auto',
    glass: true,
    luma: 0.5,
    missing: false,
  },
  /** 桌面浮窗材质：不透明度百分比（55–100），默认 95 */
  desktop: { opacity: 95 },
};

/** 单张背景图原图上限（20MB）：再大就是「把整个相册拖进来了」，压缩也会卡住主线程 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;/** 长边上限：2560 足够 2K 屏满铺，再大只是白占内存 */
const MAX_EDGE = 2560;
const JPEG_QUALITY = 82;

let attachmentsRef = null;
/** 注入附件模块（由 ipc.js 在注册前调用），用于拿 attachments 根目录 */
function init(deps = {}) {
  attachmentsRef = deps.attachments || null;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const oneOf = (v, list, fb) => (list.includes(v) ? v : fb);

function themeDir() {
  const root = attachmentsRef && attachmentsRef.getRoot();
  if (!root) return '';
  return path.join(root, 'theme');
}

function absOf(rel) {
  const clean = String(rel || '').replace(/^\/+/, '');
  if (!clean || !attachmentsRef) return '';
  return attachmentsRef.resolveMedia(clean) || '';
}

/**
 * 规范化任意历史值 → 新结构。
 * @param {string|object} raw settings 里存的值（旧版是 'system' / 'light' / 'dark'）
 */
function normalize(raw) {
  let src = raw;
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch (e) { src = src; }
  }
  if (typeof src === 'string') {
    // 老版本：纯模式字符串
    return { ...DEFAULT_THEME, backdrop: { ...DEFAULT_THEME.backdrop }, desktop: { ...DEFAULT_THEME.desktop }, mode: normalizeMode(src) };
  }
  if (!src || typeof src !== 'object') {
    return { ...DEFAULT_THEME, backdrop: { ...DEFAULT_THEME.backdrop }, desktop: { ...DEFAULT_THEME.desktop } };
  }
  const bd = src.backdrop && typeof src.backdrop === 'object' ? src.backdrop : {};
  const dk = src.desktop && typeof src.desktop === 'object' ? src.desktop : {};
  const image = String(bd.image || '');
  const theme = {
    mode: normalizeMode(src.mode),
    style: oneOf(src.style, STYLES, DEFAULT_THEME.style),
    desktop: {
      opacity: clamp(Math.round(Number(dk.opacity != null ? dk.opacity : DEFAULT_THEME.desktop.opacity) / 5) * 5, 55, 100),
    },
    backdrop: {
      type: image ? oneOf(bd.type, ['image', 'none'], 'image') : 'none',
      image,
      opacity: clamp(Math.round(Number(bd.opacity != null ? bd.opacity : 60) / 5) * 5, 0, 100),
      blur: oneOf(Number(bd.blur) || 0, [0, 8, 16], 0),
      fit: oneOf(bd.fit, ['cover', 'contain', 'repeat'], 'cover'),
      scrim: oneOf(bd.scrim, ['auto', 'none', 'weak', 'mid', 'strong'], 'auto'),
      glass: bd.glass !== false,
      luma: clamp(Number(bd.luma) || 0.5, 0, 1),
      missing: false,
    },
  };
  if (theme.backdrop.image) {
    const abs = absOf(theme.backdrop.image);
    // 附件目录尚未初始化（启动早期 applyTheme 就在读）时不能判定「丢失」，
    // 否则每次启动都会把背景图当成不存在而退回纯色。
    if (abs && !fs.existsSync(abs)) {
      // 文件被手动删了：不阻塞启动，标出来让界面退回纯色并提示重选
      theme.backdrop.missing = true;
      theme.backdrop.type = 'none';
    }
  }
  return theme;
}

function normalizeMode(v) {
  return oneOf(v, ['system', 'light', 'dark'], 'system');
}

/** 当前实际生效的明暗（跟随系统时读 nativeTheme） */
function effectiveMode(theme, nativeTheme) {
  const t = theme || DEFAULT_THEME;
  if (t.mode === 'light' || t.mode === 'dark') return t.mode;
  try {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

/** 窗口底色（创建 / 切主题时给 BrowserWindow.backgroundColor，避免先闪一下白底） */
function bgColor(theme, nativeTheme) {
  const t = theme || DEFAULT_THEME;
  const mode = effectiveMode(t, nativeTheme);
  const row = BG_HEX[t.style] || BG_HEX[DEFAULT_THEME.style];
  return row[mode] || row.light;
}

/**
 * 自绘标题栏高度（DIP）。渲染层 styles.css 的 --titlebar-h 必须写同一个值，
 * 否则标题栏内容会错行（三键也是按这个高度画的）。
 */
const TITLEBAR_HEIGHT = 40;

/**
 * 合并写入（局部更新）：只传要改的字段，背景对象做浅合并。
 * @param {object} db
 * @param {object|string} patch 旧版传字符串时按 mode 处理（兼容老调用方）
 */
function write(db, patch) {
  const cur = normalize(db.getSetting('theme', 'system'));
  const p = typeof patch === 'string' ? { mode: patch } : (patch || {});
  const next = normalize({
    mode: p.mode != null ? p.mode : cur.mode,
    style: p.style != null ? p.style : cur.style,
    desktop: { ...cur.desktop, ...(p.desktop && typeof p.desktop === 'object' ? p.desktop : {}) },
    backdrop: { ...cur.backdrop, ...(p.backdrop && typeof p.backdrop === 'object' ? p.backdrop : {}) },
  });
  db.setSetting('theme', JSON.stringify(next));
  return next;
}

/** 图片解码 + 压缩 + 采样亮度，返回 { buffer, ext, width, height, luma } */
function encodeImage(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_IMAGE_BYTES) {
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    throw new Error(`图片 ${mb}MB 超过 20MB 上限，请换一张`);
  }
  const src = nativeImage.createFromPath(file);
  if (src.isEmpty()) throw new Error('这个文件不是可识别的图片（支持 jpg / png / webp / bmp）');
  const size = src.getSize();
  const longEdge = Math.max(size.width, size.height);
  const out = longEdge > MAX_EDGE
    ? src.resize({
      width: Math.round(size.width * (MAX_EDGE / longEdge)),
      height: Math.round(size.height * (MAX_EDGE / longEdge)),
      quality: 'good',
    })
    : src;

  const jpeg = out.toJPEG(JPEG_QUALITY);
  const png = out.toPNG();
  const usePng = png.length < jpeg.length;
  const buffer = usePng ? png : jpeg;
  const dim = out.getSize();
  return {
    buffer,
    ext: usePng ? 'png' : 'jpg',
    width: dim.width,
    height: dim.height,
    luma: averageLuma(out, dim),
  };
}

/**
 * 平均亮度（0–1，sRGB 感知加权）。
 * 用来给 scrim 自动档定强度：浅色主题配暗图要提亮、深色主题配亮图要压暗。
 */
function averageLuma(img, size) {
  try {
    const bmp = img.toBitmap(); // BGRA
    const { width, height } = size;
    const total = width * height;
    if (!total || !bmp || !bmp.length) return 0.5;
    // 采样约 4000 个点就够稳定，逐像素扫 2560×1440 会让选图卡住
    const step = Math.max(1, Math.floor(Math.sqrt(total / 4000)));
    let sum = 0;
    let n = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        if (i + 2 >= bmp.length) continue;
        const a = bmp[i + 3];
        if (a === 0) continue; // 全透明像素不参与
        const l = 0.0722 * bmp[i] + 0.7152 * bmp[i + 1] + 0.2126 * bmp[i + 2];
        sum += l;
        n++;
      }
    }
    if (!n) return 0.5;
    return clamp(sum / n / 255, 0, 1);
  } catch (e) {
    return 0.5;
  }
}

function removeImageFile(rel) {
  if (!rel) return;
  const abs = absOf(rel);
  if (!abs) return;
  try { fs.unlinkSync(abs); } catch (e) { /* 已经不在了就算了 */ }
}

/**
 * 选图 → 压缩 → 落盘 → 写库。
 * @returns {{ok:boolean, theme?:object, reason?:string, info?:object}}
 */
function pickImage(db, dialog, parent) {
  const r = dialog.showOpenDialogSync(parent, {
    title: '选择背景图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
  });
  if (!r || !r.length) return { ok: false, reason: 'cancel' };
  const file = r[0];
  const dir = themeDir();
  if (!dir) return { ok: false, reason: '附件目录尚未初始化，无法保存背景图' };
  try {
    const enc = encodeImage(file);
    fs.mkdirSync(dir, { recursive: true });
    const name = `bg-${Date.now()}.${enc.ext}`;
    fs.writeFileSync(path.join(dir, name), enc.buffer);
    const rel = `theme/${name}`;
    const cur = normalize(db.getSetting('theme', 'system'));
    // 新图写成功后再删旧图：中途失败不会把用户的旧背景弄丢
    if (cur.backdrop.image) removeImageFile(cur.backdrop.image);
    const next = write(db, {
      backdrop: {
        type: 'image',
        image: rel,
        luma: Math.round(enc.luma * 1000) / 1000,
        // 第一次设背景图时给默认 60；用户已调过就沿用他的手感
        opacity: cur.backdrop.type === 'image' ? cur.backdrop.opacity : 60,
        missing: false,
      },
    });
    return {
      ok: true,
      theme: next,
      info: {
        name: path.basename(file),
        srcKB: Math.round(fs.statSync(file).size / 1024),
        outKB: Math.round(enc.buffer.length / 1024),
        width: enc.width,
        height: enc.height,
      },
    };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || '背景图处理失败' };
  }
}

/** 移除背景图（保留透明度 / 填充等偏好，下次换图直接沿用） */
function clearImage(db) {
  const cur = normalize(db.getSetting('theme', 'system'));
  if (cur.backdrop.image) removeImageFile(cur.backdrop.image);
  const next = write(db, {
    backdrop: { type: 'none', image: '', luma: 0.5, missing: false },
  });
  return next;
}

/** 恢复默认：模式 / 风格 / 背景一起回到出厂值，并删掉图片文件 */
function reset(db) {
  const cur = normalize(db.getSetting('theme', 'system'));
  if (cur.backdrop.image) removeImageFile(cur.backdrop.image);
  const next = normalize(DEFAULT_THEME);
  db.setSetting('theme', JSON.stringify(next));
  return next;
}

module.exports = {
  STYLES,
  DEFAULT_THEME,
  MAX_IMAGE_BYTES,
  init,
  normalize,
  read: (db) => normalize(db.getSetting('theme', 'system')),
  write,
  pickImage,
  clearImage,
  reset,
  effectiveMode,
  bgColor,
  TITLEBAR_HEIGHT,
  // 供冒烟脚本直接测压缩/亮度
  _encodeImage: encodeImage,
};
