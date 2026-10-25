'use strict';
/**
 * 生成 Knodo 品牌图标（纯 Node 实现，无外部依赖）。
 * 产物：assets/icon.png (256) / assets/tray.png (32) / assets/icon.ico (16~256) / assets/knodo.svg
 *
 * ── 标识释义（改图形前先看这里，别把语义破坏了）────────────────────────
 * 名字 Knodo = Knowledge + Todo，所以标识要同时说清「待办」和「知识网络」两件事：
 *   · 圆环（O）：知识回路 / 大脑环路，也是 Knodo 里的 O；
 *   · 竖条 + 两条斜臂（K）：Knodo 里的 K。竖条被做成「清单勾选竖条」的形状（胶囊竖条），
 *     两端正好与圆环内切 —— 待办清单被包在知识环路之中；
 *   · 两条斜臂从竖条中点（拐点 / 转折处）射出，各自顶到圆环上的一个节点；
 *   · 第三条细线水平连到圆环右侧的节点 —— 共 3 个连接点，代表「一条待办能牵出多条知识关联」。
 * 于是这个图形既是 K，又是一张「节点从清单里长出去」的网络。
 *
 * ── 为什么不直接用图片 ────────────────────────────────────────────────
 * 手写光栅器 + 4× 超采样，改一个数字就能重出全部尺寸，且 16px 这种小尺寸有单独的
 * 「简化几何」（加粗笔画、去掉细连线），不会糊成一团。外链工具 / AI 生图都做不到这点。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码（保持原实现） ---------------- */

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

/** 圆角方块的圆角半径 */
const TILE_RADIUS = 0.235;
/** 渐变三色停靠点（左上 → 右下）：科技蓝 → 亮青 */
const GRAD = [
  [0.0, [46, 91, 255]],   // #2E5BFF
  [0.5, [36, 80, 232]],   // #2450E8
  [1.0, [22, 200, 232]],  // #16C8E8
];
/** 前景：白色主体 + 略透的节点细线 */
const FG = [255, 255, 255];

/** 按输出尺寸选几何档位：16px 一档、24~47 一档、48+ 完整档 */
function modeFor(size) {
  if (size >= 48) return 'full';
  if (size >= 24) return 'simple';
  return 'tiny';
}

/**
 * 三档几何（改数字前先想清楚 16px 长什么样）：
 *  · full  ：圆环上 3 个节点 + 两条细连线，完整表达「知识关联」；
 *  · simple：去掉细连线、笔画加粗、节点放大，24~32px（任务栏 / 托盘）用；
 *  · tiny  ：去掉节点，竖条右移拉开与圆环左弧的距离 —— 16px 下贴太近会糊成一条白带。
 * @param {'full'|'simple'|'tiny'} mode
 */
function geometry(mode) {
  const tiny = mode === 'tiny';
  const full = mode === 'full';
  const ring = {
    cx: 0.5,
    cy: 0.5,
    r: tiny ? 0.375 : full ? 0.395 : 0.386,
    hw: tiny ? 0.042 : full ? 0.027 : 0.034,
  };
  // 竖条（清单勾选竖条）：上下两端顶到圆环内缘附近，成为圆环的一条弦
  const barHW = tiny ? 0.052 : full ? 0.046 : 0.05;
  const barX = tiny ? 0.325 : full ? 0.285 : 0.305;
  const bar = { x1: barX, y1: tiny ? 0.255 : full ? 0.235 : 0.25, x2: barX, y2: tiny ? 0.745 : full ? 0.765 : 0.75, hw: barHW };
  // 两条斜臂：从竖条中点（拐点）射出。角度别太小，否则会和细连线连成一把扇子、读成星形
  const armHW = tiny ? 0.06 : full ? 0.048 : 0.056;
  const armAng = ((tiny ? 36 : 38) * Math.PI) / 180;
  const armLen = tiny ? 0.395 : full ? 0.42 : 0.405;
  const vx = bar.x1;
  const vy = 0.5;
  const arm = (sign) => ({
    x1: vx,
    y1: vy,
    x2: vx + armLen * Math.cos(armAng),
    y2: vy + sign * armLen * Math.sin(armAng),
    hw: armHW,
  });
  // 节点：圆环上 ±38°（与两条斜臂同向）与正右，共 3 个连接点；tiny 不要节点
  const beadR = full ? 0.055 : 0.064;
  const onRing = (rad) => ({
    cx: ring.cx + ring.r * Math.cos(rad),
    cy: ring.cy + ring.r * Math.sin(rad),
    r: beadR,
  });
  const beads = tiny ? [] : [onRing(-armAng), onRing(0), onRing(armAng)];
  // 细连线：斜臂末端 → 圆环上对应的节点。必须与斜臂共线，否则会变成一段横着浮空的短线
  const connHW = 0.014;
  const conn = (sign) => {
    const a = sign < 0 ? arm(-1) : arm(1);
    const b = sign < 0 ? beads[0] : beads[2];
    return { x1: a.x2, y1: a.y2, x2: b.cx, y2: b.cy, hw: connHW };
  };
  return {
    ring,
    bar,
    arms: [arm(-1), arm(1)],
    conns: full ? [conn(-1), conn(1)] : [],
    beads,
  };
}

/* ---------------- 形状命中判定 ---------------- */

function inTile(u, v) {
  const r = TILE_RADIUS;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
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

function inRing(px, py, ring) {
  const dx = px - ring.cx;
  const dy = py - ring.cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  return Math.abs(d - ring.r) <= ring.hw;
}

function inDisc(px, py, b) {
  const dx = px - b.cx;
  const dy = py - b.cy;
  return dx * dx + dy * dy <= b.r * b.r;
}

function gradientAt(u, v) {
  const t = Math.min(1, Math.max(0, (u + v) / 2));
  for (let i = 0; i < GRAD.length - 1; i++) {
    const [t0, c0] = GRAD[i];
    const [t1, c1] = GRAD[i + 1];
    if (t <= t1 || i === GRAD.length - 2) {
      const k = (t - t0) / (t1 - t0);
      const kk = k < 0 ? 0 : k > 1 ? 1 : k;
      return [
        c0[0] + (c1[0] - c0[0]) * kk,
        c0[1] + (c1[1] - c0[1]) * kk,
        c0[2] + (c1[2] - c0[2]) * kk,
      ];
    }
  }
  return GRAD[GRAD.length - 1][1];
}

/* ---------------- 光栅化（4× 超采样 + 预乘平均） ---------------- */

const SS = 4;

/** 把几何展开成有类型的绘制列表（顺序即叠放顺序：圆环 → 竖条 → 斜臂 → 细连线 → 节点） */
function shapesOf(g) {
  const list = [{ kind: 'ring', ...g.ring }];
  list.push({ kind: 'capsule', ...g.bar });
  for (const a of g.arms) list.push({ kind: 'capsule', ...a });
  for (const c of g.conns) list.push({ kind: 'capsule', op: 0.85, ...c });
  for (const b of g.beads) list.push({ kind: 'disc', ...b });
  return list;
}

function hitShape(s, u, v) {
  if (s.kind === 'ring') return inRing(u, v, s);
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
      if (inTile(u, v)) {
        const c = gradientAt(u, v);
        r = c[0]; gg = c[1]; b = c[2]; a = 1;
      }
      for (const s of list) {
        if (!hitShape(s, u, v)) continue;
        const op = s.op == null ? 1 : s.op;
        const na = op + a * (1 - op);
        if (na > 0) {
          r = (FG[0] * op + r * a * (1 - op)) / na;
          gg = (FG[1] * op + gg * a * (1 - op)) / na;
          b = (FG[2] * op + b * a * (1 - op)) / na;
          a = na;
        }
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
  const g = geometry('full');
  const P = 256;
  const p = (x) => (x * P).toFixed(2);
  const body = shapesOf(g)
    .map((s) => {
      const op = s.op == null ? '' : ` opacity="${s.op}"`;
      if (s.kind === 'ring') {
        return `    <circle cx="${p(s.cx)}" cy="${p(s.cy)}" r="${p(s.r)}" fill="none" stroke-width="${p(s.hw * 2)}"/>`;
      }
      if (s.kind === 'disc') {
        return `    <circle cx="${p(s.cx)}" cy="${p(s.cy)}" r="${p(s.r)}" stroke="none"/>`;
      }
      return `    <line x1="${p(s.x1)}" y1="${p(s.y1)}" x2="${p(s.x2)}" y2="${p(s.y2)}" stroke-width="${p(s.hw * 2)}"${op}/>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${P} ${P}" width="${P}" height="${P}" role="img" aria-label="Knodo">
  <!-- Knodo 标识：O = 知识回路；K = 清单竖条 + 两条斜臂；圆环上 3 个节点 = 知识关联 -->
  <defs>
    <linearGradient id="kg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2E5BFF"/>
      <stop offset="0.5" stop-color="#2450E8"/>
      <stop offset="1" stop-color="#16C8E8"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${P}" height="${P}" rx="${p(TILE_RADIUS)}" fill="url(#kg)"/>
  <g fill="#fff" stroke="#fff" stroke-linecap="round">
${body}
  </g>
</svg>
`;
}

/* ---------------- 预览图（供人眼检查，不进 assets） ---------------- */

function previewPNG() {
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const pad = 12;
  const gap = 10;
  const W = pad * 2 + sizes.reduce((a, s) => a + s + gap, -gap);
  const H = pad * 2 + 256;
  const px = Buffer.alloc(W * H * 4);
  // 中性灰底（模拟任务栏/文件夹的浅色环境）
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
