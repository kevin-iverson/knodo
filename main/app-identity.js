'use strict';
/**
 * Windows 应用身份（AppUserModelID）与通知显示名。
 *
 * 通知中心里「任务提醒」上方那行小字是**发送者名称**，不是 Notification 的 title。
 * Windows 拿通知携带的 AUMID 去查
 *   HKCU\Software\Classes\AppUserModelId\<AUMID>\DisplayName
 * 查不到就回落到宿主 exe 的文件描述 —— 开发期是 electron.exe，于是显示「Electron」；
 * 便携版没有安装器写注册表，同样会回落。
 *
 * 这里做两件事：
 *  1. AUMID 统一取 build.appId，与 electron-builder 写进快捷方式的 ID 保持一致；
 *     两处硬编码不同会让任务栏分组、跳转列表和通知名同时对不上。
 *  2. 启动即把 productName 写进 HKCU 的 DisplayName（幂等、无需管理员权限），
 *     覆盖安装版 / 便携版 / 开发版三种形态。
 *  3. 顺带把 IconUri 指向「用户数据目录下的一份 knodo.png」——shell 按 AUMID 取图标
 *     （开始菜单、通知、任务栏分组）时会先看这个值，没有才回落 exe 自带的图标。
 *     exe 图标是**打包时嵌入**的，升级后 Explorer 的图标缓存经常还留着上一版的图，
 *     表现为「换了 logo，任务栏还是旧的」；显式给一个路径可控、内容随包更新的图标，
 *     至少让 AUMID 这条链路拿到的一定是本版图形。
 *     注意 asar 里的图标 shell 读不到（Explorer 不走 Electron 的 fs patch），所以必须先
 *     复制到用户数据目录再写路径。
 *
 * 写注册表走 koffi 调 advapi32!RegSetKeyValueW，不 spawn reg.exe：
 * 没有控制台闪窗，也不受外部命令是否被策略放行影响。该函数自带建键，
 * 省掉 RegCreateKeyExW 的输出句柄参数。项目已有 koffi 依赖并已 asarUnpack。
 *
 * 任何一步失败都只警告，绝不阻断启动。
 *
 * ⚠️ 打包后 `build` 段不存在：electron-builder 写进 app.asar 的 package.json
 * 只保留 name / version / description / main / author / license / repository /
 * dependencies —— `build`（连同 devDependencies）会被整段剔掉。
 * 所以在模块顶层直接 `pkg.build.appId` 在开发期正常、打包后必抛
 * `TypeError: Cannot read properties of undefined (reading 'appId')`，
 * 而这是 require 阶段就炸，主进程连窗口都来不及建（v2.2.0 安装版/便携版即此故障）。
 * 结论：取值一律走下面的 BUILD 兜底，常量只是打包形态的备份来源。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const BUILD = (pkg && pkg.build) || {}; // 打包后为 {}，字段回落到下面的常量
const APP_USER_MODEL_ID = BUILD.appId || 'com.workbuddy.todo-desktop';
const DISPLAY_NAME = BUILD.productName || 'Knodo';
const REG_SUBKEY = `Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`;
const REG_KEY = `HKCU\\${REG_SUBKEY}`;

/** 打包内的图标源（asar 内可读，但 Explorer 读不到）—— 用 PNG 而不是 ICO：
 *  IconUri 这条链路按图片解析（通知中心就这么用），.ico 在部分 shell 面会解析失败变空白 */
const ICON_SRC = path.join(__dirname, '..', 'assets', 'icon.png');
/** 导出到用户数据目录的副本：路径稳定、不被 asar 包着、随包更新（文件名由内容哈希决定） */
const ICON_DIR = 'brand';

const HKEY_CURRENT_USER = 0x80000001;
const REG_SZ = 1;
const ERROR_SUCCESS = 0;

function messageOf(e) { return e && e.message ? e.message : String(e); }

/**
 * 把 assets/icon.png 复制到 <userData>/brand/knodo-<hash>.png，返回路径（失败返回 ''）。
 *
 * 文件名带**内容哈希**是有意的：Explorer / 通知中心的图标缓存按路径命中，
 * 路径不变时会一直用旧图（「换了 logo，任务栏还是旧的」的常见成因）。
 * 图标一变哈希就变、路径就变，缓存必然落空。旧的那份不删 —— 几 KB，
 * 换一次版本才多一个，比在启动路径上做删除安全。
 */
function syncIconFile() {
  try {
    const buf = fs.readFileSync(ICON_SRC);
    // eslint-disable-next-line global-require
    const hash = require('crypto').createHash('md5').update(buf).digest('hex').slice(0, 8);
    const dir = path.join(app.getPath('userData'), ICON_DIR);
    const dest = path.join(dir, `knodo-${hash}.png`);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    return dest;
  } catch (e) {
    console.warn('[identity] 导出图标文件失败（不影响启动）：', messageOf(e));
    return '';
  }
}

/** 写一个 REG_SZ 值；失败抛错，由调用方降级处理 */
function writeRegSz(RegSetKeyValueW, name, value) {
  // REG_SZ 的数据是带结尾 NUL 的 UTF-16LE 串，cbData 按字节数给
  const data = Buffer.from(`${value}\0`, 'utf16le');
  const status = RegSetKeyValueW(HKEY_CURRENT_USER, REG_SUBKEY, name, REG_SZ, data, data.length);
  if (status !== ERROR_SUCCESS) throw new Error(`RegSetKeyValueW(${name}) 返回 ${status}`);
}

/**
 * 临时数据目录（`--user-data-dir=...` / `--smoke-test`，验证脚本与冒烟常用）不写 IconUri：
 * 那套目录跑完就删（或被下一次冒烟清空），把 shell 指过去只会留下指向空路径的图标。
 * DisplayName 照写 —— 它不受路径影响。
 */
const isThrowawayProfile = process.argv.some((a) => a.startsWith('--user-data-dir'))
  || process.argv.includes('--smoke-test');

/** 写入 DisplayName（必需）与 IconUri（可选，失败只警告） */
function writeIdentity() {
  // eslint-disable-next-line global-require
  const koffi = require('koffi');
  const advapi32 = koffi.load('advapi32.dll');
  const RegSetKeyValueW = advapi32.func(
    'long __stdcall RegSetKeyValueW(intptr_t hKey, str16 lpSubKey, str16 lpValueName,'
    + ' uint32_t dwType, const void *lpData, uint32_t cbData)',
  );
  writeRegSz(RegSetKeyValueW, 'DisplayName', DISPLAY_NAME);
  if (isThrowawayProfile) return;
  // IconUri 是附赠：拿不到图标文件就不写，宁可回落 exe 图标，也不能让 shell 指到空路径
  const iconPath = syncIconFile();
  if (!iconPath) return;
  try {
    writeRegSz(RegSetKeyValueW, 'IconUri', iconPath);
  } catch (e) {
    console.warn('[identity] 写 IconUri 失败（不影响启动）：', messageOf(e));
  }
}

function registerWindowsIdentity() {
  if (process.platform !== 'win32') return false;
  try {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  } catch (e) {
    console.warn('[identity] 设置 AUMID 失败（不影响启动）：', messageOf(e));
    return false;
  }
  try {
    writeIdentity();
    return true;
  } catch (e) {
    console.warn('[identity] 注册通知显示名失败（不影响启动）：', messageOf(e));
    return false;
  }
}

module.exports = {
  registerWindowsIdentity, syncIconFile, APP_USER_MODEL_ID, DISPLAY_NAME, REG_KEY,
};
