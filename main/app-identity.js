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

const pkg = require('../package.json');
const BUILD = (pkg && pkg.build) || {}; // 打包后为 {}，字段回落到下面的常量
const APP_USER_MODEL_ID = BUILD.appId || 'com.workbuddy.todo-desktop';
const DISPLAY_NAME = BUILD.productName || 'Knodo';
const REG_SUBKEY = `Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`;
const REG_KEY = `HKCU\\${REG_SUBKEY}`;

const HKEY_CURRENT_USER = 0x80000001;
const REG_SZ = 1;
const ERROR_SUCCESS = 0;

function messageOf(e) { return e && e.message ? e.message : String(e); }

/** 写入 DisplayName；失败抛错，由调用方降级处理 */
function writeDisplayName() {
  // eslint-disable-next-line global-require
  const koffi = require('koffi');
  const advapi32 = koffi.load('advapi32.dll');
  const RegSetKeyValueW = advapi32.func(
    'long __stdcall RegSetKeyValueW(intptr_t hKey, str16 lpSubKey, str16 lpValueName,'
    + ' uint32_t dwType, const void *lpData, uint32_t cbData)',
  );
  // REG_SZ 的数据是带结尾 NUL 的 UTF-16LE 串，cbData 按字节数给
  const data = Buffer.from(`${DISPLAY_NAME}\0`, 'utf16le');
  const status = RegSetKeyValueW(
    HKEY_CURRENT_USER, REG_SUBKEY, 'DisplayName', REG_SZ, data, data.length,
  );
  if (status !== ERROR_SUCCESS) throw new Error(`RegSetKeyValueW 返回 ${status}`);
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
    writeDisplayName();
    return true;
  } catch (e) {
    console.warn('[identity] 注册通知显示名失败（不影响启动）：', messageOf(e));
    return false;
  }
}

module.exports = { registerWindowsIdentity, APP_USER_MODEL_ID, DISPLAY_NAME, REG_KEY };
