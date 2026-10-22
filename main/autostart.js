'use strict';
/**
 * 开机自启动（Windows / macOS 登录时拉起）。
 *
 * 实现方式：Electron 的 `app.setLoginItemSettings()`（Windows 走注册表 Run 项、
 * macOS 走 SMAppService），不自己拼注册表 / 写计划任务 —— 卸载时系统会一并清理。
 *
 * 三个容易踩的点，都在这里处理好：
 *  1. **开关以系统状态为准**：用户可能在「任务管理器 → 启动」或系统设置里把它关掉，
 *     settings 表里的值会与系统不一致。读取一律以 `app.getLoginItemSettings()`
 *     的结果为准，settings 只作为「想让它是开还是关」的意图记录。
 *  2. **便携版 / 开发模式**：便携版 exe 每次运行会被解压到临时目录，路径不稳定；
 *     开发模式（electron.exe + 项目路径）需要额外带上 args。这两种情况都直接禁用，
 *     并在界面上说明原因，避免写进一条永远指向旧路径的启动项。
 *  3. **静默启动**：开机拉起时带上 `--autostart`，主进程据此只驻留托盘、不弹主窗口，
 *     不会开机就糊一脸窗口。
 */

const path = require('path');
const { app } = require('electron');

/** 开机拉起时附加的命令行参数，主进程据此判断「这次是被自启动唤起的」 */
const AUTOSTART_FLAG = '--autostart';

/** 便携版：electron-builder 会把单文件包解压到临时目录运行，路径不固定 */
function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

/**
 * 当前环境是否支持开机自启动。
 * @returns {{supported:boolean, reason:string}}
 */
function availability() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return { supported: false, reason: `当前系统（${process.platform}）暂不支持该功能` };
  }
  if (isPortable()) {
    return { supported: false, reason: '便携版每次运行都会解压到临时目录，无法登记稳定的启动项；安装版可用' };
  }
  if (!app.isPackaged) {
    return { supported: false, reason: '开发调试模式下不写系统启动项；打包安装后可用' };
  }
  return { supported: true, reason: '' };
}

/** setLoginItemSettings 需要的参数（打包版 path 就是自身 exe，不用传） */
function loginItemOptions(openAtLogin) {
  const opts = { openAtLogin: !!openAtLogin };
  if (process.platform === 'win32') {
    // Windows 会把 name 作为注册表项名，显式给一个稳定名字，
    // 否则升级 / 改 productName 后旧项不会被覆盖，会出现两条启动项。
    opts.name = 'TODO待办';
    opts.path = process.execPath;
    opts.args = openAtLogin ? [AUTOSTART_FLAG] : [];
  } else {
    // macOS：隐藏 Dock 图标、以「登录项」方式打开，参数同样透传
    opts.openAsHidden = true;
    if (openAtLogin) opts.args = [AUTOSTART_FLAG];
  }
  return opts;
}

/**
 * 读取当前状态。
 * @returns {{supported:boolean, enabled:boolean, reason:string}}
 */
function getState() {
  const avail = availability();
  if (!avail.supported) return { supported: false, enabled: false, reason: avail.reason };
  let enabled = false;
  try {
    const s = app.getLoginItemSettings({ path: process.execPath, args: [AUTOSTART_FLAG] });
    // Windows 下 openAtLogin 反映的是注册表项是否存在且未被系统禁用
    enabled = !!(s && s.openAtLogin);
  } catch (e) {
    return { supported: true, enabled: false, reason: `读取系统设置失败：${e && e.message}` };
  }
  return { supported: true, enabled, reason: '' };
}

/**
 * 写入开机自启动开关。
 * @param {boolean} enabled
 * @returns {{ok:boolean, supported:boolean, enabled:boolean, reason:string}}
 */
function setEnabled(enabled) {
  const avail = availability();
  if (!avail.supported) {
    return { ok: false, supported: false, enabled: false, reason: avail.reason };
  }
  try {
    app.setLoginItemSettings(loginItemOptions(enabled));
  } catch (e) {
    return { ok: false, supported: true, enabled: false, reason: `写入系统设置失败：${e && e.message}` };
  }
  const st = getState();
  // 写完之后回读一次：被组策略 / 安全软件拦下时，避免界面显示"已开启"其实没生效
  if (enabled && !st.enabled) {
    return { ok: false, supported: true, enabled: false, reason: '系统未接受该启动项（可能被安全软件或组策略拦截）' };
  }
  return { ok: true, supported: true, enabled: st.enabled, reason: '' };
}

/** 本次是否由开机自启动唤起 */
function isAutoStarted() {
  return process.argv.includes(AUTOSTART_FLAG);
}

module.exports = { AUTOSTART_FLAG, getState, setEnabled, isAutoStarted, availability };
