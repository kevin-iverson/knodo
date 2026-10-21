'use strict';
/**
 * 任务附件落盘层。
 *
 * 设计要点：
 * - 文件本体存在 `<数据目录>/attachments/task-<id>/<附件id>_<原文件名>`，数据库 tasks.attachments
 *   只保存元数据（含**相对**路径），这样「数据目录」整体搬家 / 备份后附件仍然有效；
 * - 附件 id 独立于任务 id，重名文件不会互相覆盖；
 * - 该模块不依赖 Electron，可单独用 Node 做冒烟测试（dialog / shell 在 ipc 层）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 单个附件体积上限：超大文件直接拒绝，避免一次拖入几个 G 把盘写满 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** 常见扩展名 → MIME，仅用于详情页图标与「图片/音频」等分类，不追求完备 */
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.json': 'application/json', '.csv': 'text/csv',
};

let root = '';

/** 初始化附件根目录（数据目录确定后由主进程调用） */
function init(dir) {
  root = dir ? path.resolve(dir) : '';
  if (!root) return;
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    // 目录暂时建不出来（盘未挂载 / 无权限）不要在启动阶段抛错，等真正附件操作时再报
    console.warn('[attachments] 附件根目录创建失败：', e && e.message);
  }
}

function getRoot() {
  return root;
}

function ensureRoot() {
  if (!root) throw new Error('附件目录尚未初始化');
  fs.mkdirSync(root, { recursive: true });
}

function taskDir(taskId) {
  return path.join(root, `task-${Number(taskId)}`);
}

/** 文件名清洗：保留中文，替换 Windows 非法字符与路径分隔符，防止写到目录外 */
function safeBaseName(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'file').slice(0, 120);
}

function mimeOf(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

/** 元数据 → 绝对路径；越界的相对路径（手改库 / 旧数据）一律拒绝 */
function absPath(entry) {
  ensureRoot();
  const rel = String((entry && entry.path) || '');
  if (!rel) throw new Error('附件记录缺少存储路径');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('附件路径非法');
  return abs;
}

/**
 * 把一个磁盘文件复制进任务附件目录。
 * @param {number} taskId 任务 id
 * @param {string} srcPath 源文件绝对路径
 * @returns {{id:string,name:string,size:number,mime:string,path:string,added_at:string}}
 */
function importFile(taskId, srcPath) {
  ensureRoot();
  const src = path.resolve(String(srcPath || ''));
  let st;
  try {
    st = fs.statSync(src);
  } catch (e) {
    throw new Error(`附件「${path.basename(src)}」不存在或无法读取`);
  }
  if (!st.isFile()) throw new Error(`「${path.basename(src)}」不是文件`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`附件「${path.basename(src)}」为 ${(st.size / 1024 / 1024).toFixed(1)}MB，超过单文件 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`);
  }
  const id = newId();
  const name = safeBaseName(src);
  const stored = `${id}_${name}`;
  const dir = taskDir(taskId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, stored));
  } catch (e) {
    throw new Error(`保存附件「${name}」失败：${e && e.message ? e.message : e}`);
  }
  return {
    id,
    name,
    size: st.size,
    mime: mimeOf(name),
    path: `task-${Number(taskId)}/${stored}`,
    added_at: new Date().toISOString(),
  };
}

/** 附件文件是否还在（用户手工删掉过、或换机恢复备份时可能缺失） */
function exists(entry) {
  try {
    return fs.existsSync(absPath(entry));
  } catch (e) {
    return false;
  }
}

/**
 * 把附件写到目标路径（「另存为」用）。
 * 兼容历史版本：老数据里可能存的是 base64 的 data URL（attachments JSON 里带 data 字段）。
 */
function saveAs(entry, destPath) {
  const dest = path.resolve(String(destPath || ''));
  if (entry && typeof entry.data === 'string' && entry.data.startsWith('data:')) {
    const base64 = entry.data.slice(entry.data.indexOf(',') + 1);
    fs.writeFileSync(dest, Buffer.from(base64, 'base64'));
    return dest;
  }
  const src = absPath(entry);
  if (!fs.existsSync(src)) throw new Error(`附件文件已丢失：${entry && entry.name ? entry.name : ''}`);
  fs.copyFileSync(src, dest);
  return dest;
}

/** 删除单个附件文件（文件不存在时静默通过，保证「删除记录」永远能成功） */
function removeFile(entry) {
  try {
    const abs = absPath(entry);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    // 目录空了顺手清掉，避免留下大量空 task-* 目录
    const dir = path.dirname(abs);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (e) {
    console.warn('[attachments] 删除附件文件失败：', e && e.message);
  }
}

/** 删除某个任务的全部附件文件（任务 / 子任务被删除时调用） */
function removeTaskDir(taskId) {
  if (!root) return;
  try {
    fs.rmSync(taskDir(taskId), { recursive: true, force: true });
  } catch (e) {
    console.warn('[attachments] 清理任务附件目录失败：', e && e.message);
  }
}

module.exports = {
  MAX_FILE_BYTES,
  init,
  getRoot,
  taskDir,
  importFile,
  absPath,
  exists,
  saveAs,
  removeFile,
  removeTaskDir,
};
