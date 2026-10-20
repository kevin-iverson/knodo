'use strict';
/**
 * 全局快捷键设置：显示/隐藏主窗口、快速添加任务两项都可自定义。
 *
 * 交互约定：
 *  - 输入框是只读的，点一下进入「按键捕获」态，直接按下想要的组合即可（Esc 取消这次录入）；
 *  - 录入后立刻做冲突提示：与 IDEA / Chrome 等已知键位撞车的会就地给出警告，但不阻止保存
 *    （用户在自己的环境里可能就是要这个组合）；
 *  - 两项撞成同一个组合是硬冲突，交给主进程拒绝（它还要负责真正的注册）。
 */
import { api } from './api.js';
import { openPanelModal } from './modal.js';

/** keydown.key → Electron 加速器里的主键写法 */
const KEY_MAP = {
  ' ': 'Space', Spacebar: 'Space',
  Escape: 'Escape', Enter: 'Return', Tab: 'Tab',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  '+': 'Plus', '=': 'Plus', '-': 'Minus', _: 'Minus',
  ',': 'Comma', '<': 'Comma', '.': 'Period', '>': 'Period',
  '/': 'Slash', '?': 'Slash', '\\': 'Backslash', '|': 'Backslash',
  ';': 'Semicolon', ':': 'Semicolon', "'": 'Quote', '"': 'Quote',
  '[': 'BracketLeft', '{': 'BracketLeft', ']': 'BracketRight', '}': 'BracketRight',
  '`': 'Backquote', '~': 'Backquote',
};
/** 单独按下时还没构成组合，等主键 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'OS']);

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 组合 → 给人看的文案（Ctrl+Alt+Shift+Q） */
function pretty(accel) {
  return String(accel || '')
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/Command/g, 'Ctrl');
}

/** keydown 事件 → 加速器字符串；返回 null 表示这次按键不构成组合 */
function accelFromEvent(e) {
  const raw = e.key;
  if (MODIFIER_KEYS.has(raw)) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = KEY_MAP[raw] || (raw.length === 1 ? raw.toUpperCase() : raw);
  if (/^F\d{1,2}$/.test(key)) key = key; // F1~F12 原样
  if (!mods.length) return null; // 必须有修饰键，否则会把普通按键变成全局热键
  return `${mods.join('+')}+${key}`;
}

/** 打开快捷键设置 */
export async function openShortcutsModal() {
  let info;
  try {
    info = await api.shortcuts.get();
  } catch (e) {
    alert(`读取快捷键配置失败：${e && e.message ? e.message : e}`);
    return;
  }
  const actions = info.actions || [];
  const conflicts = info.conflicts || {};

  const rowsHtml = actions.map((a) => {
    const v = info.shortcuts[a.key] || a.def;
    return `<div class="sc-row" data-key="${esc(a.key)}">
      <div class="sc-label">
        ${esc(a.label)}
        <span class="sc-hint">点击右侧输入框，然后直接按下新的组合键（Backspace 清除）</span>
      </div>
      <input class="sc-input" type="text" readonly value="${esc(v)}" data-value="${esc(v)}"
             aria-label="${esc(a.label)}" title="点击后按下新的快捷键组合" />
      <button type="button" class="ghost-btn" data-sc="clear" title="清除，恢复默认组合">清除</button>
      <div style="flex-basis:100%"></div>
      <div class="sc-tip" data-sc="warn" hidden></div>
    </div>`;
  }).join('');

  await openPanelModal({
    title: '⌨ 全局快捷键',
    className: 'modal-wide',
    okText: '保存',
    extraButtons: [{ label: '恢复默认', handler: async (root) => resetDefaults(root) }],
    html: `
      <div class="sc-list" id="sc-list">${rowsHtml}</div>
      <div class="sc-tip" style="margin-top:12px">
        默认组合刻意避开了 IntelliJ IDEA / Chrome 的常用键位（Ctrl+Shift+N / Ctrl+Shift+T 等已被占用），
        因此在 IDEA 里不会被本应用抢走。保存后立即生效，无需重启。
      </div>`,
    onSubmit: async (root) => {
      const patch = {};
      root.querySelectorAll('.sc-row').forEach((row) => {
        patch[row.dataset.key] = row.querySelector('.sc-input').dataset.value || '';
      });
      const vals = Object.values(patch).filter(Boolean);
      if (new Set(vals).size !== vals.length) return '两项快捷键不能相同';
      const r = await api.shortcuts.set(patch);
      if (!r || !r.ok) {
        return (r && r.errors && r.errors.length)
          ? r.errors.map((x) => `${pretty(x.accel)}：${x.message}`).join('；')
          : '保存失败，请重试';
      }
      return undefined;
    },
    onMount(root) {
      bindCapture(root, conflicts);
    },
  });
}

/** 恢复默认：先把界面上的值改回默认，再由用户点「保存」落库 */
async function resetDefaults(root) {
  try {
    const r = await api.shortcuts.reset();
    if (!r || !r.ok) {
      const msg = r && r.errors && r.errors.length ? r.errors[0].message : '恢复失败';
      return msg;
    }
    root.querySelectorAll('.sc-row').forEach((row) => {
      const input = row.querySelector('.sc-input');
      const def = (r.shortcuts && r.shortcuts[row.dataset.key]) || '';
      input.value = def;
      input.dataset.value = def;
      paintWarn(row, {}, def);
    });
    return undefined;
  } catch (e) {
    return (e && e.message) || '恢复失败';
  }
}

/** 冲突提示（本地即时反馈，不阻断保存） */
function paintWarn(row, conflicts, value) {
  const el = row.querySelector('[data-sc="warn"]');
  if (!el) return;
  const hit = conflicts[value];
  el.hidden = !hit;
  el.className = hit ? 'sc-warn' : 'sc-tip';
  el.textContent = hit ? `⚠ 与已知快捷键冲突：${hit}（仍可保存，但按下时可能被对方抢走）` : '';
}

/** 给每个输入框挂按键捕获 */
function bindCapture(root, conflicts) {
  root.querySelectorAll('.sc-row').forEach((row) => {
    const input = row.querySelector('.sc-input');
    paintWarn(row, conflicts, input.dataset.value || '');

    input.addEventListener('focus', () => input.classList.add('capturing'));
    input.addEventListener('blur', () => input.classList.remove('capturing'));
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Backspace' || e.key === 'Delete') {
        input.value = '';
        input.dataset.value = '';
        paintWarn(row, conflicts, '');
        return;
      }
      if (e.key === 'Escape') { input.blur(); return; }
      const accel = accelFromEvent(e);
      if (!accel) return; // 只按了修饰键 / 没有修饰键 → 继续等
      input.value = accel;
      input.dataset.value = accel;
      paintWarn(row, conflicts, accel);
      input.blur();
    });
    row.querySelector('[data-sc="clear"]').addEventListener('click', () => {
      input.value = '';
      input.dataset.value = '';
      paintWarn(row, conflicts, '');
    });
  });
}

/** 绑定顶部工具栏的「⌨ 快捷键」按钮 */
export function bindShortcutsButton() {
  const btn = document.getElementById('btn-shortcuts');
  if (!btn) return false;
  btn.addEventListener('click', () => {
    openShortcutsModal().catch((e) => console.error('[shortcuts] 打开失败', e));
  });
  return true;
}
