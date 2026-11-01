'use strict';
/**
 * 极简 ZIP 读 / 写（零第三方依赖）。
 *
 * 用途：
 *  - docx 导出（docx 本质就是 ZIP 包）；
 *  - 笔记打包导出；
 *  - **完整备份包**：db.json + 附件 + 录音可能上百 MB，所以除了内存版 `zip()` 还提供
 *    流式的 `writeZipFile()`（逐条写盘，内存峰值 = 单个文件）。
 *
 * 实现范围：只做 ZIP 的最小可用子集——deflate(8) / store(0)，不支持 zip64、加密、多卷。
 * 备份包单文件上限由附件层 200MB 兜住，不会逼近 4GB，够用。
 */
const fs = require('fs');
const zlib = require('zlib');

/** 通用标志位：bit 11 = 文件名为 UTF-8（不置位时 Windows 解压中文名会乱码） */
const FLAG_UTF8 = 0x0800;

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 把条目按 ZIP 结构依次交给 sink，避免一次性拼出整个包。
 * @param {Array<{name:string, data:string|Buffer, store?:boolean, level?:number}>} entries
 * @param {(chunk:Buffer)=>void} sink
 */
function writeEntries(entries, sink) {
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    // store：图片 / 音频 / 视频本身已压缩，再 deflate 只会白烧 CPU
    const store = !!e.store;
    const comp = store ? raw : zlib.deflateRawSync(raw, { level: e.level || 9 });
    const method = store ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed to extract
    local.writeUInt16LE(FLAG_UTF8, 6);  // general purpose bit flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);         // last mod time
    local.writeUInt16LE(0, 12);         // last mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);         // extra field length
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);    // relative offset of local header
    nameBuf.copy(central, 46);

    sink(local);
    sink(comp);
    centrals.push(central);
    offset += local.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  sink(centralBuf);
  sink(end);
}

/**
 * 打包成内存 Buffer。
 * @param {Array<{name:string, data:string|Buffer, store?:boolean}>} entries
 * @returns {Buffer}
 */
function zip(entries) {
  const parts = [];
  writeEntries(entries, (b) => parts.push(b));
  return Buffer.concat(parts);
}

/**
 * 直接写成 .zip 文件：逐条写盘，内存峰值只有一个条目。
 * 备份包（附件 + 录音）必须走这条路径，否则几百 MB 的包会同时驻留两份在内存里。
 */
function writeZipFile(entries, destPath) {
  const fd = fs.openSync(destPath, 'w');
  try {
    writeEntries(entries, (b) => fs.writeSync(fd, b));
  } finally {
    fs.closeSync(fd);
  }
  return destPath;
}

/**
 * 读取 ZIP 的条目表（只读中央目录，不解析全部内容）。
 * @param {Buffer} buf
 * @returns {Array<{name:string, method:number, compSize:number, size:number, offset:number, dataOffset:number}>}
 */
function listEntries(buf) {
  // EOCD 在尾部，最多带 65535 字节注释
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('ZIP 中央目录已损坏，无法读取');
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // 本地头的额外字段长度可能和中央目录不同，必须按本地头自己读
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    out.push({ name, method, compSize, size, offset, dataOffset: offset + 30 + localNameLen + localExtraLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 解出单个条目的原始内容 */
function readEntry(buf, entry) {
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`);
}

/** 解包成 { 条目名: Buffer }（备份包只用 db.json / manifest.json，其余按需取） */
function unzip(buf) {
  const out = {};
  for (const e of listEntries(buf)) {
    if (e.name.endsWith('/')) continue; // 目录条目
    out[e.name] = readEntry(buf, e);
  }
  return out;
}

module.exports = { crc32, zip, writeZipFile, listEntries, readEntry, unzip };
