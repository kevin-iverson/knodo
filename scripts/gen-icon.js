'use strict';
/**
 * 生成 Knodo 品牌图标（纯 Node 实现，无外部依赖）。
 * 产物：assets/icon.png (256) / assets/tray.png (32) / assets/icon.ico (16~256) / assets/knodo.svg
 *
 * ── 标识释义（改图形前先看这里，别把语义破坏了）────────────────────────
 * 一笔两色：一个勾，两种读法。
 *   · 朱砂短臂 = 待办 / 行动，起笔是「今天要做什么」；
 *   · 象牙长臂 = 笔记 / 知识，落笔是「做完留下什么」；
 *   · 拐点圆点 = 节点（Knodo 的 node）：两条臂在这里相接，像任务和笔记
 *     共用同一个本地数据库 —— 一次完成，就是一个知识节点；
 *   · 暖墨底 + 纸白 + 朱砂 = 纸、墨、印章，不是蓝底白字的云工具徽章。
 *
 * ── 为什么不用图片 ────────────────────────────────────────────────────
 * 手写光栅器 + 4× 超采样，改一个数字就能重出全部尺寸，且 16px 这种小尺寸有单独的
 * 「简化几何」（去节点、加粗笔画），不会糊成一团。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 标识几何（归一化坐标，1 = 画布边长） ---------------- */

/** 设计稿画布边长（与提案 SVG 的 viewBox 一致） */
const P = 512;
/** 圆角方块的圆角半径 */
const TILE_RADIUS = 112 / P;
/** 勾的两个端点与拐点 */
const A = [144 / P, 276 / P];
const V = [220 / P, 350 / P];
const B = [368 / P, 162 / P];
/** 笔画宽度 / 拐点节点半径 */
const STROKE = 62 / P;
const BEAD_R = 34 / P;
/** 内描边：贴着方块边缘的一道 6% 白，只在大尺寸看得见 */
const BORDER_W = 3 / P;
const BORDER_OP = 0.06;
/** 暖墨底：左上 #1E1A16 → 右下 #0F0C0A */
const GRAD = [
  [0.0, [30, 26, 22]],
  [1.0, [15, 12, 10]],
];
/** 前景两色 */
const IVORY = [255, 251, 240]; // #FFFBF0
const VERM = [217, 71, 46]; // #D9472E

/** 按输出尺寸选几何档位：16px 一档、24~47 一档、48+ 完整档 */
function modeFor(size) {
  if (size >= 48) return 'full';
  if (size >= 24) return 'simple';
  return 'tiny';
}

/**
 * 三档几何（改数字前先想清楚 16px 长什么样）：
 *  · full  ：完整表达，带拐点节点；
 *  · simple：与 full 同一套比例，24~32px（任务栏 / 托盘）用；
 *  · tiny  ：去掉节点、笔画加粗到 70，16px 下不会糊成一团。
 * @param {'full'|'simple'|'tiny'} mode
 */
function geometry(mode) {
  const tiny = mode === 'tiny';
  const hw = (tiny ? 70 : 62) / P / 2;
  const beadR = tiny ? 0 : BEAD_R;
  return {
    hw,
    beadR,
    /** 长臂：拐点 → 右上 */
    longArm: { x1: V[0], y1: V[1], x2: B[0], y2: B[1], hw, color: IVORY },
    /** 短臂：左上 → 拐点，压在长臂上，拐点处露出朱砂圆点 */
    shortArm: { x1: A[0], y1: A[1], x2: V[0], y2: V[1], hw, color: VERM },
    bead: { cx: V[0], cy: V[1], r: beadR, color: VERM },
  };
}

/* ---------------- 形状命中判定 ---------------- */

/** 圆角矩形的有符号距离：< 0 在内部 */
function tileSDF(u, v) {
  const r = TILE_RADIUS;
  const qx = Math.abs(u - 0.5) - (0.5 - r);
  const qy = Math.abs(v - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function distSeg(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const c2 = vx * vx + vy * vy;
  let t = c2 === 0 ? 0 : (vx * wx + vy * wy) / c2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (x1 + t * vx);
  const dy = py - (y1 + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function inCapsule(px, py, s) {
  return distSeg(px, py, s.x1, s.y1, s.x2, s.y2) <= s.hw;
}

function inDisc(px, py, b) {
  const dx = px - b.cx;
  const dy = py - b.cy;
  return dx * dx + dy * dy <= b.r * b.r;
}

function gradientAt(u, v) {
  // 与 SVG 的 linearGradient x1=0 y1=0 x2=0.9 y2=1 对齐：投影到 (0.9, 1)
  const t = Math.min(1, Math.max(0, (0.9 * u + v) / (0.9 * 0.9 + 1)));
  const [t0, c0] = GRAD[0];
  const [t1, c1] = GRAD[1];
  const k = (t - t0) / (t1 - t0);
  const kk = k < 0 ? 0 : k > 1 ? 1 : k;
  return [
    c0[0] + (c1[0] - c0[0]) * kk,
    c0[1] + (c1[1] - c0[1]) * kk,
    c0[2] + (c1[2] - c0[2]) * kk,
  ];
}

/* ---------------- 光栅化（4× 超采样 + 预乘平均） ---------------- */

const SS = 4;

/** 把几何展开成有类型的绘制列表（顺序即叠放顺序：长臂 → 短臂 → 节点） */
function shapesOf(g) {
  const list = [
    { kind: 'capsule', ...g.longArm },
    { kind: 'capsule', ...g.shortArm },
  ];
  if (g.beadR > 0) list.push({ kind: 'disc', ...g.bead });
  return list;
}

function hitShape(s, u, v) {
  if (s.kind === 'disc') return inDisc(u, v, s);
  return inCapsule(u, v, s);
}

/**
 * @param {number} size 输出边长
 * @param {'full'|'simple'|'tiny'} [mode] 几何档位，默认按尺寸自动选
 * @returns {Buffer} RGBA
 */
function rasterize(size, mode = modeFor(size)) {
  const n = size * SS;
  const g = geometry(mode);
  const list = shapesOf(g);
  // 预乘累加器：先乘 alpha 再平均，避免边缘出现颜色光晕
  const acc = new Float64Array(size * size * 4);

  for (let sy = 0; sy < n; sy++) {
    const v = (sy + 0.5) / n;
    const oy = (sy / SS) | 0;
    for (let sx = 0; sx < n; sx++) {
      const u = (sx + 0.5) / n;
      let r = 0;
      let gg = 0;
      let b = 0;
      let a = 0;
      const d = tileSDF(u, v);
      if (d < 0) {
        const c = gradientAt(u, v);
        r = c[0];
        gg = c[1];
        b = c[2];
        a = 1;
        if (d > -BORDER_W) {
          r = r * (1 - BORDER_OP) + 255 * BORDER_OP;
          gg = gg * (1 - BORDER_OP) + 255 * BORDER_OP;
          b = b * (1 - BORDER_OP) + 255 * BORDER_OP;
        }
      }
      for (const s of list) {
        if (!hitShape(s, u, v)) continue;
        r = s.color[0];
        gg = s.color[1];
        b = s.color[2];
        a = 1;
      }
      const oi = (oy * size + ((sx / SS) | 0)) * 4;
      acc[oi] += r * a;
      acc[oi + 1] += gg * a;
      acc[oi + 2] += b * a;
      acc[oi + 3] += a;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const inv = 1 / (SS * SS);
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3] * inv;
    out[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
    if (a > 0) {
      out[i * 4] = Math.round(Math.min(255, (acc[i * 4] * inv) / a));
      out[i * 4 + 1] = Math.round(Math.min(255, (acc[i * 4 + 1] * inv) / a));
      out[i * 4 + 2] = Math.round(Math.min(255, (acc[i * 4 + 2] * inv) / a));
    }
  }
  return out;
}

/* ---------------- ICO 组装 ---------------- */

function encodeICO(sizes) {
  const images = sizes.map((size) => ({
    size,
    data: encodePNG(size, rasterize(size)),
  }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/* ---------------- SVG（与应用内的内联标识同一套几何） ---------------- */

function svgMark() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Knodo">
  <!-- Knodo 标识「一笔两色」：朱砂短臂 = 待办，象牙长臂 = 知识，拐点圆点 = 节点 -->
  <title>Knodo</title>
  <defs>
    <linearGradient id="knodoTile" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#1E1A16"/>
      <stop offset="1" stop-color="#0F0C0A"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#knodoTile)"/>
  <rect x="1.5" y="1.5" width="509" height="509" rx="110.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.06" stroke-width="3"/>
  <path d="M144 276 L220 350 L368 162" fill="none" stroke="#FFFBF0" stroke-width="62" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M144 276 L220 350" fill="none" stroke="#D9472E" stroke-width="62" stroke-linecap="round"/>
  <circle cx="220" cy="350" r="34" fill="#D9472E"/>
</svg>
`;
}

/* ---------------- 预览图（供人眼检查，不进 assets） ---------------- */

function previewPNG() {
  const sizes = [256, 96, 48, 32, 24, 16];
  const pad = 12;
  const gap = 12;
  const W = pad * 2 + sizes.reduce((a, s) => a + s + gap, -gap);
  const H = pad * 2 + 256;
  const px = Buffer.alloc(W * H * 4);
  // 中性灰底（模拟任务栏 / 文件夹的浅色环境）
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = 238; px[i * 4 + 1] = 239; px[i * 4 + 2] = 242; px[i * 4 + 3] = 255;
  }
  let x = pad;
  for (const s of sizes) {
    const img = rasterize(s);
    const oy = pad + ((256 - s) / 2) | 0;
    for (let y = 0; y < s; y++) {
      for (let xi = 0; xi < s; xi++) {
        const si = (y * s + xi) * 4;
        const di = ((oy + y) * W + (x + xi)) * 4;
        const a = img[si + 3] / 255;
        px[di] = Math.round(img[si] * a + px[di] * (1 - a));
        px[di + 1] = Math.round(img[si + 1] * a + px[di + 1] * (1 - a));
        px[di + 2] = Math.round(img[si + 2] * a + px[di + 2] * (1 - a));
      }
    }
    x += s + gap;
  }
  // encodePNG 只支持正方形，这里自己按任意尺寸编码
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 输出 ---------------- */

function main() {
  const outDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(256, rasterize(256)));
  fs.writeFileSync(path.join(outDir, 'tray.png'), encodePNG(32, rasterize(32)));
  fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO([16, 24, 32, 48, 64, 128, 256]));
  fs.writeFileSync(path.join(outDir, 'knodo.svg'), svgMark());
  if (process.env.ICON_PREVIEW) {
    fs.writeFileSync(process.env.ICON_PREVIEW, previewPNG());
    console.log('预览图已生成: ' + process.env.ICON_PREVIEW);
  }
  console.log(
    'Knodo 图标已生成: assets/icon.png (256), assets/tray.png (32), assets/icon.ico (16~256), assets/knodo.svg'
  );
}

// 作为模块被 require 时只导出函数（供检查脚本复用光栅器，不产生副作用）
if (require.main === module) main();

module.exports = { rasterize, geometry, shapesOf, encodePNG, encodeICO, previewPNG, gradientAt };
