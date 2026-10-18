'use strict';
/**
 * 录制文件管理：会话目录、分片落盘、导入外部音频、清理。
 *
 * 约定：每次录制开一个会话目录 userData/recordings/<sessionId>/，
 * 目录里按 chunk-001.webm / chunk-002.webm … 递增存放，方便按分片单独送 ASR。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let rootDir = '';

function init(userDataDir) {
  rootDir = path.join(userDataDir, 'recordings');
  fs.mkdirSync(rootDir, { recursive: true });
  return rootDir;
}

function ensureRoot() {
  if (!rootDir) throw new Error('录制模块未初始化');
  fs.mkdirSync(rootDir, { recursive: true });
  return rootDir;
}

/** 会话 id：时间戳 + 随机串，保证同一秒内多次录制不冲突 */
function newSessionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function sessionDir(sessionId) {
  return path.join(ensureRoot(), String(sessionId));
}

function createSession() {
  const sessionId = newSessionId();
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return { sessionId, dir };
}

function sessionFiles(sessionId) {
  const dir = sessionDir(sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^chunk-\d+/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * 写入一个分片。
 * @param {string} sessionId
 * @param {number} seq 从 1 开始
 * @param {Uint8Array|ArrayBuffer|Buffer} data
 * @param {string} [ext] 扩展名，默认 webm
 * @returns {{filePath:string,size:number}}
 */
function saveChunk(sessionId, seq, data, ext = 'webm') {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const safeExt = String(ext || 'webm').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'webm';
  const num = String(Math.max(1, Number(seq) || 1)).padStart(3, '0');
  const filePath = path.join(dir, `chunk-${num}.${safeExt}`);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeFileSync(filePath, buf);
  return { filePath, size: buf.length };
}

/** 删除整个会话目录（连同分片文件） */
function deleteSession(sessionId) {
  const dir = sessionDir(sessionId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 导入已有音视频文件（绕过录制直接转写）。
 * @param {string} srcPath
 * @returns {{sessionId:string, filePath:string, ext:string, size:number}}
 */
function importMedia(srcPath) {
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error('文件不存在，无法导入');
  const { sessionId, dir } = createSession();
  const ext = path.extname(srcPath).replace('.', '').toLowerCase() || 'webm';
  const dest = path.join(dir, `chunk-001.${ext}`);
  fs.copyFileSync(srcPath, dest);
  return { sessionId, filePath: dest, ext, size: fs.statSync(dest).size };
}

module.exports = {
  init,
  createSession,
  sessionDir,
  sessionFiles,
  saveChunk,
  deleteSession,
  importMedia,
  newSessionId,
  getRoot: () => rootDir,
};
