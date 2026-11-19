'use strict';
/**
 * 主进程国际化。
 *
 * 只覆盖**主进程自己产出、用户直接看得见**的文案：托盘菜单、macOS 应用菜单、
 * 系统通知、原生对话框按钮。窗口里的界面文案全在渲染层（renderer/js/i18n.js），
 * 两边用同一套约定：中文原文作 key，查不到就原样返回。
 *
 * 为什么不共享一份字典：渲染层是 ES module（`export`），主进程是 CommonJS（`require`），
 * 同一文件无法两种解析；而主进程侧只有几十条文案，重复一份的维护成本远低于
 * 造一层 UMD / 构建期打包的复杂度。若将来文案量涨起来再抽公共文件。
 */
const db = require('./db');

const LOCALES = ['zh-CN', 'en'];
const DEFAULT_LOCALE = 'zh-CN';

let locale = DEFAULT_LOCALE;
/** 语言切换后的重建回调（菜单 / 托盘），由 main.js 注册 */
let onChange = null;

const EN = {
  /* 托盘 */
  '显示主界面': 'Show Knodo',
  '快速添加任务': 'Quick add task',
  '快速捕捉…': 'Quick capture…',
  '设置…': 'Settings…',
  '退出': 'Quit',
  /* macOS 应用菜单 */
  '存储位置': 'Storage location',
  '备份与恢复…': 'Backup & restore…',
  '归档已完成任务': 'Archive completed tasks',
  '导入 Markdown 笔记…': 'Import Markdown notes…',
  '重复事项与习惯…': 'Recurring items & habits…',
  '检查更新': 'Check for updates',
  '正在检查更新…': 'Checking for updates…',
  '有新版本 {v}': 'Version {v} available',
  '开机自启动': 'Launch at login',
  'AI 设置': 'AI settings',
  '桌面浮窗': 'Desktop widgets',
  '趣味功能': 'Fun',
  '上班鼓励器…': 'Work encourager…',
  '今日牛马卡…': 'Today’s grind card…',
  '工位搭子设置…': 'Desk buddy settings…',
  /* 原生对话框 */
  '确定': 'OK',
  '取消': 'Cancel',
  '是': 'Yes',
  '否': 'No',
  /* 开机自启动不可用原因（给设置中心直接显示） */
  '当前系统（{os}）暂不支持该功能': 'Not supported on this platform ({os})',
  '这个便携版每次运行都会解压到临时目录，无法登记稳定的启动项；安装版或 7z 便携包可用':
    'This portable build unpacks to a temp folder on every run, so a stable startup entry cannot be registered. Use the installer or the 7z portable package instead.',
  '开发调试模式下不写系统启动项；打包安装后可用':
    'Startup entries are not written in development; available once packaged and installed',
  '读取系统设置失败：{msg}': 'Failed to read the system setting: {msg}',
  '写入系统设置失败：{msg}': 'Failed to write the system setting: {msg}',
  '系统未接受该启动项（可能被安全软件或组策略拦截）':
    'The system rejected the startup entry (blocked by security software or group policy)',
};

function normalize(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return DEFAULT_LOCALE;
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('zh')) return 'zh-CN';
  return DEFAULT_LOCALE;
}

function interpolate(s, vars) {
  const str = String(s == null ? '' : s);
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/** 取词条；中文原样 + 插值，英文查表回退 */
function t(key, vars) {
  const k = String(key == null ? '' : key);
  if (locale === 'zh-CN') return interpolate(k, vars);
  const hit = EN[k];
  return interpolate(hit == null ? k : hit, vars);
}

function getLocale() {
  return locale;
}

function isEnglish() {
  return locale === 'en';
}

/** 从数据库读一次（数据库未就绪时保持默认，绝不因为读不到语言就启动失败） */
function load() {
  try {
    locale = normalize(db.getSetting('locale', DEFAULT_LOCALE));
  } catch (e) {
    locale = DEFAULT_LOCALE;
  }
  return locale;
}

/** 注册语言变化后的重建动作（重建托盘 / 应用菜单 + 通知渲染层重载） */
function setOnChange(fn) {
  onChange = typeof fn === 'function' ? fn : null;
}

/**
 * 切换语言：写库 → 重建主进程自身的菜单 → 广播 `locale:changed`。
 * 渲染层收到广播后各自 reload（界面是整块重写架构，热替换不可靠）。
 */
function setLocale(next) {
  const v = normalize(next);
  locale = v;
  try { db.setSetting('locale', v); } catch (e) { /* 库没就绪也要让本次会话生效 */ }
  if (onChange) {
    try { onChange(v); } catch (e) { /* 重建失败不影响切换本身 */ }
  }
  return v;
}

module.exports = {
  LOCALES, DEFAULT_LOCALE, normalize, t, getLocale, isEnglish, load, setLocale, setOnChange,
};
