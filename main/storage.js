'use strict';
/**
 * 数据目录解析 / 切换。
 *
 * 为什么配置文件不放在数据目录里：配置文件要回答的正是「数据在哪」，
 * 它必须有一个稳定的落点 —— 固定放在 Electron 的 userData（%APPDATA%\<app>）下，
 * 里面只记一个 dataDir 字段；真正的业务数据（todo.db、attachments）放在用户选定的目录里。
 *
 * 启动顺序：init() → resolve() → db.init(resolve 返回的 dir)。
 * resolve() 会把「配置目录不可用（盘没插 / 被删 / 无写权限）」降级成默认目录，并把原因带出去，
 * 由主进程弹窗告知用户 —— 应用永远要能启动，不能因为一个失效路径就白屏。
 */
const fs = require('fs');
const path = require('path');

const CONFIG_NAME = 'config.json';
const PROBE_NAME = '.todo-write-test';
const DB_NAME = 'todo.db';
const ATTACH_DIR = 'attachments';

let userDataDir = '';
let defaultDir = '';
let configPath = '';
let current = { dir: '', source: 'default', wanted: '', error: '' };

/** @param {{userDataDir:string, defaultDir?:string}} opts */
function init({ userDataDir: ud, defaultDir: dd } = {}) {
  userDataDir = path.resolve(String(ud || '.'));
  defaultDir = path.resolve(String(dd || ud || '.'));
  configPath = path.join(userDataDir, CONFIG_NAME);
}

/* ------------------------------ 配置读写 ------------------------------ */

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.warn('[storage] 读取配置失败：', e.message);
    return {};
  }
}

/** 原子写：先写 .tmp 再 rename，避免掉电 / 崩溃留下半截 JSON */
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, configPath);
}

/* ------------------------------ 目录探测 ------------------------------ */

/**
 * 探测目录是否可用：能创建、能写、能删。
 * 只判断 existsSync 是不够的：路径存在但只读（U 盘写保护 / 同步盘占位 / 权限收紧）照样写不进去。
 * @returns {{ok:boolean, dir?:string, error?:string}}
 */
function probe(dir) {
  const target = path.resolve(String(dir || '').trim());
  if (!target) return { ok: false, error: '路径为空' };
  try {
    fs.mkdirSync(target, { recursive: true });
    const f = path.join(target, PROBE_NAME);
    fs.writeFileSync(f, String(Date.now()), 'utf8');
    fs.unlinkSync(f);
    return { ok: true, dir: target };
  } catch (e) {
    const code = (e && e.code) || '';
    const msg = (e && e.message) || String(e);
    return { ok: false, error: `${code ? `${code}：` : ''}${msg}` };
  }
}

/* ------------------------------ 解析 / 切换 ------------------------------ */

/**
 * 解析本次启动要用的数据目录。
 * - 没有配置 → 默认目录（userData；绿色版已被主进程改成 exe 同级的 data）；
 * - 有配置且可写 → 用配置目录；
 * - 有配置但不可用 → 回退默认目录，并记录 wanted / error 供界面提示。
 */
function resolve() {
  const cfg = readConfig();
  const wanted = typeof cfg.dataDir === 'string' ? cfg.dataDir.trim() : '';
  if (!wanted) {
    current = { dir: defaultDir, source: 'default', wanted: '', error: '' };
    return { ...current, ok: true };
  }
  const p = probe(wanted);
  if (!p.ok) {
    current = { dir: defaultDir, source: 'fallback', wanted, error: p.error };
    console.error(`[storage] 配置的数据目录不可用（${wanted}）：${p.error}，已回退到 ${defaultDir}`);
    return { ...current, ok: false };
  }
  current = { dir: p.dir, source: 'custom', wanted: p.dir, error: '' };
  return { ...current, ok: true };
}

function getInfo() {
  return {
    dir: current.dir,
    defaultDir,
    configFile: configPath,
    source: current.source, // default | custom | fallback
    wanted: current.wanted,
    error: current.error,
    isCustom: current.source === 'custom',
  };
}

/** 记住自定义目录（下次启动生效；本次运行仍用已打开的库） */
function setDataDir(dir) {
  const target = path.resolve(String(dir || '').trim());
  if (!target) throw new Error('目录不能为空');
  const p = probe(target);
  if (!p.ok) throw new Error(`目录不可写：${p.error}`);
  writeConfig({ ...readConfig(), dataDir: target });
  return target;
}

/** 清掉自定义目录，回到默认目录 */
function clearDataDir() {
  const cfg = readConfig();
  delete cfg.dataDir;
  writeConfig(cfg);
}

/**
 * 把当前数据复制到新目录（切换前的迁移）。
 * - 数据库走 SQLite 在线备份（WAL 下直接 copy 文件可能拿到半截数据），调用期间程序可继续使用；
 * - 附件目录按相对路径存储，整目录复制即可；
 * - 录音文件（recordings）不迁移：会议记录里存的是绝对路径，复制反而会造成两份数据。
 * @param {string} targetDir 目标目录
 * @param {(destDbPath:string)=>Promise<void>} snapshotDb 由主进程注入的数据库快照函数
 * @param {string} [fromDir] 源目录，默认取本次运行实际使用的目录（主进程会显式传数据库文件所在目录，避免不一致）
 */
async function migrateTo(targetDir, snapshotDb, fromDir) {
  const target = path.resolve(String(targetDir || '').trim());
  const srcRaw = String(fromDir || current.dir || '');
  if (!srcRaw) throw new Error('数据目录尚未初始化');
  const src = path.resolve(srcRaw);
  if (!target) throw new Error('目标目录不能为空');
  if (target === src) return { copied: false, sameDir: true };
  const p = probe(target);
  if (!p.ok) throw new Error(`目标目录不可写：${p.error}`);

  const destDb = path.join(target, DB_NAME);
  if (fs.existsSync(destDb)) {
    throw new Error('目标目录里已经有 todo.db，为避免覆盖已有数据，请换一个空目录');
  }
  try {
    await snapshotDb(destDb);
    const srcAtt = path.join(src, ATTACH_DIR);
    if (fs.existsSync(srcAtt)) {
      fs.cpSync(srcAtt, path.join(target, ATTACH_DIR), { recursive: true });
    }
  } catch (e) {
    // 迁移失败时清掉半成品，避免下次切到该目录时被「已有 todo.db」挡住
    try { if (fs.existsSync(destDb)) fs.unlinkSync(destDb); } catch (_e) { /* ignore */ }
    throw new Error(`复制数据失败：${(e && e.message) || e}`);
  }
  return { copied: true, dir: target };
}

module.exports = {
  DB_NAME,
  ATTACH_DIR,
  init,
  resolve,
  getInfo,
  probe,
  setDataDir,
  clearDataDir,
  migrateTo,
  readConfig,
};
