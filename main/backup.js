'use strict';
/**
 * 备份与恢复。
 *
 * 两条线，职责不同：
 *  1. **完整备份包**（手动导出，`.zip`）：`db.json` + `attachments/` + `recordings/`。
 *     这是「换机 / 重装」唯一可信的搬运方式——曾经的 JSON 备份只带元数据，
 *     恢复后图片全破、附件点不开、录音没声音，而用户以为自己备份过了。
 *  2. **自动快照**（每日一次，`.db`）：只保数据库（任务 / 笔记 / 会议记录 / 设置），
 *     走 SQLite 在线备份接口，体积小、可每天留。附件与录音本身就在数据目录里，
 *     磁盘故障要靠完整备份包搬到别处，这一点在界面上必须说清楚。
 *
 * 本模块不依赖 Electron，可单独跑（脚本 / 冒烟测试）。
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const attachments = require('./attachments');
const recording = require('./recording');
const { writeZipFile, listEntries, readEntry } = require('./zip');

/** 自动快照目录（相对数据目录） */
const BACKUP_DIR = 'backups';
/** 自动快照保留策略 */
const KEEP_DAILY_DAYS = 7;
const KEEP_WEEKLY_COUNT = 4;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
/** 启动后首次备份延迟 / 之后间隔 */
const FIRST_DELAY_MS = 5 * 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 导入包体积保护（整包读入内存，超过就别硬来） */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

/** 已压缩过的类型：直接 store，省 CPU 也不损失体积 */
const STORE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.zip', '.rar', '.7z', '.gz',
  '.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac',
  '.mp4', '.webm', '.mov', '.mkv', '.avi',
  '.docx', '.xlsx', '.pptx',
]);

function dataDir() {
  const p = db.getDbPath();
  return p ? path.dirname(p) : '';
}

function backupDir() {
  const d = dataDir();
  return d ? path.join(d, BACKUP_DIR) : '';
}

function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 递归列出目录下所有文件（跳过符号链接，避免备份时绕进环路） */
function walkFiles(dir, base = dir, out = []) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of list) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(abs, base, out);
    else if (ent.isFile()) out.push({ abs, rel: path.relative(base, abs) });
  }
  return out;
}

function isStoreExt(name) {
  return STORE_EXT.has(path.extname(String(name)).toLowerCase());
}

/** 会议录音只打包被引用到的文件（孤儿分片不进备份，避免包体积失控） */
function referencedRecordings(data) {
  const set = new Set();
  for (const m of data.meetings || []) {
    for (const p of m.media_paths || []) if (p) set.add(String(p));
  }
  return set;
}

/**
 * 库里登记了、但磁盘上找不到的附件（换机恢复后会集中暴露，必须汇总提示而不是静默破图）。
 * @returns {Array<{kind:string, owner_id:number, title:string, name:string, path:string}>}
 */
function findMissingAttachments() {
  const out = [];
  for (const meta of db.collectAttachmentMeta()) {
    if (!meta.path) continue;
    if (attachments.exists({ path: meta.path })) continue;
    out.push(meta);
  }
  return out;
}

/**
 * 构建完整备份包的条目列表。
 * @returns {{entries:Array, manifest:Object}}
 */
function buildEntries(onProgress) {
  const data = db.exportData();
  const entries = [];
  const missingAttachments = findMissingAttachments();
  const missingRecordings = [];

  // ---- 附件：目录里有什么就打包什么（含尚未被引用的，宁可多带也别让用户丢图） ----
  const attRoot = attachments.getRoot();
  const attFiles = attRoot ? walkFiles(attRoot) : [];
  for (const f of attFiles) {
    const rel = f.rel.split(path.sep).join('/');
    entries.push({ name: `attachments/${rel}`, data: fs.readFileSync(f.abs), store: isStoreExt(f.rel) });
  }
  if (onProgress) onProgress(`附件 ${attFiles.length} 个`);

  // ---- 录音：只带走被会议引用的分片 ----
  const recRoot = recording.getRoot();
  const wanted = referencedRecordings(data);
  let recCount = 0;
  if (recRoot && wanted.size) {
    const prefix = recRoot.replace(/[\\/]+$/, '') + path.sep;
    for (const abs of wanted) {
      if (!abs.startsWith(prefix)) continue; // 不在本机录音目录里的（外链文件）跳过
      const rel = path.relative(recRoot, abs);
      if (!fs.existsSync(abs)) { missingRecordings.push(abs); continue; }
      entries.push({ name: `recordings/${rel.split(path.sep).join('/')}`, data: fs.readFileSync(abs), store: true });
      recCount++;
    }
  }
  if (onProgress) onProgress(`录音 ${recCount} 个`);

  const manifest = {
    app: 'knodo',
    format: 1,
    schemaVersion: data.schemaVersion,
    exportedAt: data.exportedAt,
    counts: {
      groups: data.groups.length,
      tags: data.tags.length,
      tasks: data.tasks.length,
      notes: (data.notes || []).length,
      meetings: (data.meetings || []).length,
      attachments: attFiles.length,
      recordings: recCount,
    },
    missingAttachments,
    missingRecordings,
  };

  // db.json / manifest.json 放最前面：用户用解压软件打开时先看到它们
  return {
    manifest,
    entries: [
      { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
      { name: 'db.json', data: JSON.stringify(data, null, 2) },
      ...entries,
    ],
  };
}

/**
 * 导出完整备份包到指定路径（流式写盘，内存峰值 = 单个最大文件）。
 * @param {string} destPath
 * @param {(msg:string)=>void} [onProgress]
 */
function writeArchive(destPath, onProgress) {
  const { manifest, entries } = buildEntries(onProgress);
  writeZipFile(entries, destPath);
  return { filePath: destPath, manifest, size: fs.statSync(destPath).size };
}

/**
 * 读取完整备份包并**就地**落盘附件 / 录音（不保留解压结果，避免大包双份内存）。
 * @returns {{data:Object, manifest:Object|null, restored:{attachments:number, recordings:number}}}
 */
function readArchive(filePath) {
  const st = fs.statSync(filePath);
  if (st.size > MAX_IMPORT_BYTES) throw new Error('备份包超过 2GB，暂不支持导入');
  const buf = fs.readFileSync(filePath);
  const entries = listEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));

  const dbEntry = byName.get('db.json');
  if (!dbEntry) throw new Error('这不是 Knodo 完整备份包（缺少 db.json）');
  let manifest = null;
  if (byName.get('manifest.json')) {
    try { manifest = JSON.parse(readEntry(buf, byName.get('manifest.json')).toString('utf8')); } catch (e) { manifest = null; }
  }
  const data = JSON.parse(readEntry(buf, dbEntry).toString('utf8'));

  // 先落盘附件：目标就是当前数据目录的附件根，覆盖同名即可（附件 id 唯一，不会误伤别人的文件）
  const attRoot = attachments.getRoot();
  const recRoot = recording.getRoot();
  const recRels = new Set();
  let attCount = 0;
  let recCount = 0;

  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    if (e.name.startsWith('attachments/') && attRoot) {
      const rel = e.name.slice('attachments/'.length);
      const dest = path.resolve(attRoot, rel.split('/').join(path.sep));
      if (!dest.startsWith(path.resolve(attRoot) + path.sep)) continue; // 防 zip 路径穿越
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, readEntry(buf, e));
      attCount++;
    } else if (e.name.startsWith('recordings/') && recRoot) {
      const rel = e.name.slice('recordings/'.length);
      const dest = path.resolve(recRoot, rel.split('/').join(path.sep));
      if (!dest.startsWith(path.resolve(recRoot) + path.sep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, readEntry(buf, e));
      recRels.add(rel);
      recCount++;
    }
  }

  return { data, manifest, restored: { attachments: attCount, recordings: recCount }, recRels };
}

/**
 * 把备份包里的录音绝对路径改写成当前机器上的路径。
 * 备份里存的是「原机器」的绝对路径，直接导入到新机器必然失效——这里按
 * `recordings/` 之后的相对部分重新拼接，找不到对应文件的保持原值（导入后会进缺失清单）。
 */
function remapRecordingPaths(data, recRoot, recRels) {
  const norm = (p) => String(p || '').replace(/\\/g, '/');
  let changed = 0;
  for (const m of data.meetings || []) {
    if (!Array.isArray(m.media_paths)) continue;
    m.media_paths = m.media_paths.map((p) => {
      const n = norm(p);
      const i = n.lastIndexOf('recordings/');
      const tail = i >= 0 ? n.slice(i + 'recordings/'.length) : '';
      if (tail && recRels.has(tail)) {
        changed++;
        return path.join(recRoot, tail.split('/').join(path.sep));
      }
      return p;
    });
  }
  return changed;
}

/**
 * 导入完整备份包（覆盖式恢复）。
 * @param {string} filePath
 * @returns {{counts:Object, restored:Object, missing:Array, manifest:Object|null}}
 */
function importArchive(filePath) {
  const { data, manifest, restored, recRels } = readArchive(filePath);
  const recRoot = recording.getRoot();
  if (recRoot) remapRecordingPaths(data, recRoot, recRels);
  const counts = db.importData(data);
  // 分块 / 向量是派生数据，接口层会在导入后重建；这里只回缺失清单
  return { counts, restored, missing: findMissingAttachments(), manifest };
}

/* ------------------------------ 自动快照 ------------------------------ */

/** 备份文件名 → 时间（按文件名里的日期解析，拿不到退回 mtime） */
function backupTime(name, mtimeMs) {
  const m = /knodo-(\d{4})(\d{2})(\d{2})\.db$/.exec(name);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return mtimeMs;
}

/** 列出自动快照（按时间倒序） */
function listAutoBackups() {
  const dir = backupDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !/^knodo-\d{8}\.db$/.test(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    let st;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    out.push({ path: abs, name: ent.name, size: st.size, mtime: st.mtimeMs, time: backupTime(ent.name, st.mtimeMs) });
  }
  out.sort((a, b) => b.time - a.time);
  return out;
}

/** ISO 周键（用于「每周留一份」） */
function weekKey(ts) {
  const d = new Date(ts);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

/**
 * 清理旧快照：最近 7 天每日留 1 份 + 更早的每周留最新 1 份（最多 4 周），再压总量上限。
 * @returns {{removed:string[], totalBytes:number, count:number}}
 */
function pruneAutoBackups() {
  const files = listAutoBackups();
  if (!files.length) return { removed: [], totalBytes: 0, count: 0 };
  const now = Date.now();
  const keep = new Set();
  const older = [];
  for (const f of files) {
    if ((now - f.time) / 86400000 <= KEEP_DAILY_DAYS) keep.add(f.path);
    else older.push(f);
  }
  const weeks = new Map();
  for (const f of older) { // files 已按时间倒序，第一次遇到的就是该周最新的一份
    const k = weekKey(f.time);
    if (!weeks.has(k)) weeks.set(k, f.path);
  }
  [...weeks.values()].slice(0, KEEP_WEEKLY_COUNT).forEach((p) => keep.add(p.path));

  const removed = [];
  for (const f of files) {
    if (keep.has(f.path)) continue;
    try { fs.unlinkSync(f.path); removed.push(f.name); } catch (e) { /* 占用中 / 已删除，跳过 */ }
  }

  // 总量上限：从最旧删，至少保留最近 2 份
  let left = listAutoBackups();
  let total = left.reduce((s, f) => s + f.size, 0);
  while (total > MAX_TOTAL_BYTES && left.length > 2) {
    const oldest = left[left.length - 1];
    try {
      fs.unlinkSync(oldest.path);
      total -= oldest.size;
      removed.push(oldest.name);
      left = left.slice(0, -1);
    } catch (e) {
      break;
    }
  }
  return { removed, totalBytes: total, count: left.length };
}

/**
 * 立即做一次自动快照。
 * 备份前跑 quick_check：库本身已经损坏时不要再拿它去覆盖历史备份（那会把唯一的好副本毁掉）。
 */
async function runAutoBackup() {
  if (!db.isReady()) return { ok: false, reason: '数据库未就绪' };
  const dir = backupDir();
  if (!dir) return { ok: false, reason: '数据目录未知' };
  const check = db.quickCheck();
  if (!check.ok) return { ok: false, reason: `数据库自检未通过（${check.message}），已跳过本次备份` };
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `knodo-${dateStamp()}.db`);
  const tmp = `${dest}.tmp`;
  await db.backupTo(tmp);
  fs.renameSync(tmp, dest); // 先写临时文件再改名，避免留下半截备份
  const pruned = pruneAutoBackups();
  return { ok: true, filePath: dest, size: fs.statSync(dest).size, pruned };
}

let firstTimer = null;
let intervalTimer = null;

/** 启动自动快照：5 分钟后首次，之后每 24 小时 */
function startAutoBackup({ onError } = {}) {
  if (intervalTimer) return;
  const run = () => {
    runAutoBackup().catch((e) => {
      const msg = e && e.message ? e.message : String(e);
      console.error('[backup] 自动备份失败：', msg);
      if (onError) onError(msg);
    });
  };
  firstTimer = setTimeout(run, FIRST_DELAY_MS);
  if (firstTimer.unref) firstTimer.unref();
  intervalTimer = setInterval(run, INTERVAL_MS);
  if (intervalTimer.unref) intervalTimer.unref();
}

function stopAutoBackup() {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
}

/**
 * 用某个快照覆盖当前数据库（危险操作，调用方必须先确认）。
 * 当前库不直接删掉，改名成 `.broken-<时间戳>` 留证，万一恢复的不是想要的那份还能救回来。
 */
function restoreFromBackup(srcPath) {
  const dbPath = db.getDbPath();
  if (!dbPath) throw new Error('数据库路径未知');
  if (!fs.existsSync(srcPath)) throw new Error('备份文件不存在');
  db.close();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parked = `${dbPath}.broken-${stamp}`;
  try {
    if (fs.existsSync(dbPath)) fs.renameSync(dbPath, parked);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, parked + suffix);
    }
  } catch (e) {
    throw new Error(`无法备份当前数据库文件：${e && e.message ? e.message : e}`);
  }
  fs.copyFileSync(srcPath, dbPath);
  const ok = db.init(path.dirname(dbPath), path.basename(dbPath));
  if (!ok) throw new Error(`恢复失败：${db.getInitError() || '数据库无法打开'}`);
  return { ok: true, dbPath, parked };
}

/** 设置页 / 菜单展示用的汇总信息 */
function getInfo() {
  const list = listAutoBackups();
  return {
    dir: backupDir(),
    count: list.length,
    totalBytes: list.reduce((s, f) => s + f.size, 0),
    latest: list[0] ? { path: list[0].path, name: list[0].name, time: list[0].time, size: list[0].size } : null,
    dailyDays: KEEP_DAILY_DAYS,
    weeklyCount: KEEP_WEEKLY_COUNT,
  };
}

module.exports = {
  BACKUP_DIR,
  writeArchive,
  readArchive,
  importArchive,
  buildEntries,
  findMissingAttachments,
  listAutoBackups,
  pruneAutoBackups,
  runAutoBackup,
  startAutoBackup,
  stopAutoBackup,
  restoreFromBackup,
  getInfo,
};
