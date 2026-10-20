'use strict';
/**
 * 全局快捷键：显示/隐藏主窗口、快速添加任务。两项都可自定义（存 settings）。
 *
 * 为什么默认不是 Ctrl+Shift+T / Ctrl+Shift+N：
 *   这两个组合在 IntelliJ IDEA 与 Chrome 里都已经被占用（IDEA：Ctrl+Shift+T = Go to Test、
 *   Ctrl+Shift+N = Go to File；Chrome：Ctrl+Shift+T = 重开标签、Ctrl+Shift+N = 无痕窗口）。
 *   全局快捷键是 OS 级注册的，会先于应用被截获 —— 在 IDEA 里按它等于"按了没反应"。
 *   默认改为三键组合 Ctrl+Alt+Shift+Q / W（IDEA 官方默认键位表中未被占用），
 *   并在设置面板里对已知冲突做提示，用户仍可自行改成任何组合。
 */
const { globalShortcut } = require('electron');
const db = require('./db');

/** 动作定义：key = settings 后缀，label = 界面文案，def = 默认加速器 */
const ACTIONS = [
  { key: 'toggleWindow', label: '显示 / 隐藏主窗口', def: 'CommandOrControl+Alt+Shift+Q' },
  { key: 'quickAdd', label: '快速添加任务', def: 'CommandOrControl+Alt+Shift+W' },
];

const ACTION_KEYS = ACTIONS.map((a) => a.key);

/**
 * 已知冲突表（加速器 → 被谁占用）。录入时提示，不阻止保存——
 * 用户在别的环境里可能就是想要这个组合。
 */
const KNOWN_CONFLICTS = {
  'CommandOrControl+Shift+T': 'Chrome 重开标签 / IDEA 跳转到测试（Go to Test）',
  'CommandOrControl+Shift+N': 'Chrome 无痕窗口 / IDEA 查找文件（Go to File）',
  'CommandOrControl+Alt+Shift+N': 'IDEA 查找符号（Go to Symbol）',
  'CommandOrControl+Alt+Shift+T': 'IDEA 重构菜单（Refactor This）',
  'CommandOrControl+Shift+A': 'IDEA 查找动作（Find Action）',
  'CommandOrControl+Shift+F': 'IDEA / Chrome 全局搜索',
  'CommandOrControl+Alt+Shift+S': 'IDEA 项目结构（Project Structure）',
  'CommandOrControl+Alt+L': 'IDEA 格式化代码',
  'CommandOrControl+Alt+T': 'IDEA 环绕代码（Surround With）',
  'CommandOrControl+Shift+F12': 'IDEA 隐藏所有工具窗口',
  'CommandOrControl+T': 'IDEA 运行测试 / 多数编辑器搜索',
  'CommandOrControl+N': 'IDEA 查找类（Go to Class）',
  'CommandOrControl+Alt+Shift+I': 'IDEA 按名称运行检查',
};

/** 允许出现在加速器里的主键（其余一律拒绝，避免把普通字母设成全局热键） */
const ALLOWED_KEYS = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Space', 'Tab', 'Return', 'Enter', 'Escape',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  'Plus', 'Minus', 'Comma', 'Period', 'Slash', 'Backslash', 'Semicolon', 'Quote',
  'BracketLeft', 'BracketRight', 'Backquote',
]);

const MODIFIERS = new Set(['CommandOrControl', 'Command', 'Control', 'Ctrl', 'Alt', 'Option', 'Shift', 'Super', 'Meta']);

/**
 * 校验加速器字符串。返回 { ok, message }。
 * 规则：至少一个修饰键 + 一个合法主键；不允许残留的裸修饰键。
 */
function validateAccel(accel) {
  const raw = String(accel || '').trim();
  if (!raw) return { ok: false, message: '快捷键不能为空' };
  const parts = raw.split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return { ok: false, message: '必须带至少一个修饰键（如 Ctrl+Alt+Shift+Q）' };
  const mods = parts.filter((p) => MODIFIERS.has(p));
  const keys = parts.filter((p) => !MODIFIERS.has(p));
  if (!mods.length) return { ok: false, message: `${raw} 缺少 Ctrl / Alt / Shift 之类的修饰键` };
  if (keys.length !== 1) return { ok: false, message: `${raw} 只能有一个主键` };
  if (!ALLOWED_KEYS.has(keys[0])) return { ok: false, message: `不支持的主键「${keys[0]}」` };
  return { ok: true, message: '' };
}

/** 读取当前配置（缺失则返回默认值） */
function getConfig() {
  const out = {};
  for (const a of ACTIONS) {
    const v = db.getSetting(`shortcuts.${a.key}`, '');
    out[a.key] = (typeof v === 'string' && v.trim()) ? v.trim() : a.def;
  }
  return out;
}

/** 最近一次的回调（更新配置后要按它重新注册） */
let handlers = { onToggle: () => {}, onQuickAdd: () => {} };

/**
 * 注册快捷键。返回 { ok, shortcuts, errors }，errors 为 { key, accel, message } 数组。
 * 注册失败（被系统 / 其它程序占用）不会中断其它项。
 */
function registerShortcuts(next) {
  if (next) handlers = { ...handlers, ...next };
  unregisterShortcuts();

  const cfg = getConfig();
  const errors = [];
  for (const a of ACTIONS) {
    const accel = cfg[a.key];
    const check = validateAccel(accel);
    if (!check.ok) {
      errors.push({ key: a.key, accel, message: check.message });
      continue;
    }
    const cb = a.key === 'toggleWindow' ? handlers.onToggle : handlers.onQuickAdd;
    if (!globalShortcut.register(accel, cb)) {
      errors.push({ key: a.key, accel, message: '注册失败：可能已被系统或其它程序占用' });
    }
  }
  return { ok: errors.length === 0, shortcuts: cfg, errors };
}

function unregisterShortcuts() {
  globalShortcut.unregisterAll();
}

/**
 * 写入并重新注册。空字符串表示恢复该动作的默认值。
 * 同一个加速器不能给两个动作 —— 这是真正的硬冲突，直接拒绝。
 */
function applyConfig(patch = {}) {
  const next = { ...getConfig() };
  for (const k of ACTION_KEYS) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] || '').trim();
    next[k] = v || (ACTIONS.find((a) => a.key === k) || {}).def;
  }
  const dup = ACTION_KEYS.find((k, i) => ACTION_KEYS.some((o, j) => j > i && next[o] === next[k]));
  if (dup) {
    return { ok: false, shortcuts: getConfig(), errors: [{ key: dup, accel: next[dup], message: '两项快捷键不能相同' }] };
  }
  for (const k of ACTION_KEYS) {
    const def = (ACTIONS.find((a) => a.key === k) || {}).def;
    db.setSetting(`shortcuts.${k}`, next[k] === def ? '' : next[k]);
  }
  return registerShortcuts();
}

/** 全部恢复默认 */
function resetConfig() {
  for (const k of ACTION_KEYS) db.setSetting(`shortcuts.${k}`, '');
  return registerShortcuts();
}

module.exports = {
  ACTIONS, ACTION_KEYS, KNOWN_CONFLICTS,
  registerShortcuts, unregisterShortcuts, getConfig, applyConfig, resetConfig, validateAccel,
};
