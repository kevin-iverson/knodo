'use strict';
/**
 * 生成应用图标与托盘图标（纯 Node 实现，无外部依赖）。
 * 生成 assets/icon.png (256x256) 与 assets/tray.png (32x32)。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
  // 每行前加 filter byte 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 画布绘制：圆形角矩形 + 白色对勾
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const radius = size * 0.22;
  const inRoundRect = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
  // 背景圆角矩形（品牌蓝渐变）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRoundRect(x, y)) { set(x, y, 0, 0, 0, 0); continue; }
      const t = (x + y) / (2 * size);
      const r = Math.round(64 + (36 - 64) * t);
      const g = Math.round(132 + (99 - 132) * t);
      const b = Math.round(255 + (255 - 255) * t);
      set(x, y, r, g, b, 255);
    }
  }
  // 对勾：三条粗线段，用点到线段距离判断
  const segDist = (px0, py0, x, y, x1, y1, x2, y2) => {
    const vx = x2 - x1, vy = y2 - y1;
    const wx = px0 - x1, wy = py0 - y1;
    const c1 = vx * wx + vy * wy;
    const c2 = vx * vx + vy * vy;
    let t = c2 === 0 ? 0 : c1 / c2;
    t = Math.max(0, Math.min(1, t));
    const dx = px0 - (x1 + t * vx);
    const dy = py0 - (y1 + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  };
  const strokeW = size * 0.09;
  const segs = [
    [size * 0.26, size * 0.52, size * 0.44, size * 0.70],
    [size * 0.44, size * 0.70, size * 0.76, size * 0.32],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = false;
      for (const [x1, y1, x2, y2] of segs) {
        if (segDist(x, y, 0, 0, x1, y1, x2, y2) <= strokeW / 2 + 0.5) { hit = true; break; }
      }
      if (hit) set(x, y, 255, 255, 255, 255);
    }
  }
  return px;
}

/**
 * 组装 .ico 文件（Windows 窗口与 exe 图标）。
 * 结构：ICONDIR(6) + 每项 ICONDIRENTRY(16) + 依次排列的图像数据。
 * Vista 及以上支持在 ICO 中直接内嵌 PNG，因此这里逐尺寸嵌入 PNG 字节。
 */
function encodeICO(sizes) {
  const images = sizes.map((size) => ({ size, data: encodePNG(size, drawIcon(size)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size; // 宽（256 用 0 表示）
    e[1] = img.size >= 256 ? 0 : img.size; // 高
    e[2] = 0; // 调色板色数
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // 每像素位数
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(256, drawIcon(256)));
fs.writeFileSync(path.join(outDir, 'tray.png'), encodePNG(32, drawIcon(32)));
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO([16, 24, 32, 48, 64, 128, 256]));
console.log(
  '图标已生成: assets/icon.png (256x256), assets/tray.png (32x32), assets/icon.ico (16~256 多尺寸)'
);
