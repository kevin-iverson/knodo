'use strict';
/**
 * 捕捉条渲染层。
 *
 * 这个页面的全部复杂度都在一个地方：**Enter 到底是"上屏候选词"还是"提交"**。
 * 中文输入法激活时，Enter 会先被 IME 用来上屏 —— 不判断 isComposing 的话，
 * 打「写周报」三个字要按三次回车，每次都提交一条半截的脏数据。
 */
import { api } from './api.js';

const el = {
  root: document.getElementById('cap'),
  target: document.getElementById('cap-target'),
  targetName: document.getElementById('cap-target-name'),
  dot: document.getElementById('cap-dot'),
  input: document.getElementById('cap-input'),
  hint: document.getElementById('cap-hint'),
  draft: document.getElementById('cap-draft'),
  flash: document.getElementById('cap-flash'),
  empty: document.getElementById('cap-empty'),
  openMain: document.getElementById('cap-open-main'),
};

/** 目标清单候选（Tab 循环）：[{ id, name }] */
let targets = [];
let targetId = null;
/** 未提交草稿：Esc 收起后仍留在内存里，下次按 C 还在（零丢失、零弹窗） */
let draft = '';
/** IME 组合态：compositionstart/end 与 isComposing 双保险 */
let composing = false;
let flashTimer = null;
let busy = false;

/* ------------------------------ 外观 ------------------------------ */

function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'light' || theme === 'dark') html.setAttribute('data-theme', theme);
  else html.removeAttribute('data-theme');
}

function setTarget(name, color) {
  el.targetName.textContent = name || '未设置';
  if (color) el.dot.style.background = color;
}

function render(state = {}) {
  if (state.theme) applyTheme(state.theme);
  if (Array.isArray(state.targets)) targets = state.targets;
  if (state.target) {
    targetId = state.target.id == null ? null : Number(state.target.id);
    setTarget(state.target.name);
  }
  const has = state.hasGroups !== false && targets.length > 0;
  el.empty.hidden = has;
  el.input.hidden = !has;
  el.hint.hidden = !has;
  el.target.hidden = !has;
  if (!has) {
    el.draft.hidden = true;
    return;
  }
  // 草稿回填：光标停在末尾，不选中全文（通常是要接着写而不是重写）
  if (draft) {
    el.input.value = draft;
    el.draft.hidden = false;
    const n = el.input.value.length;
    el.input.setSelectionRange(n, n);
  } else {
    el.draft.hidden = true;
  }
  el.input.focus();
}

function flash(text, isError = false) {
  clearTimeout(flashTimer);
  el.flash.textContent = text;
  el.flash.classList.toggle('is-error', !!isError);
  el.flash.hidden = false;
  flashTimer = setTimeout(() => { el.flash.hidden = true; }, 1200);
}

/* ------------------------------ 交互 ------------------------------ */

async function save() {
  if (busy) return;
  const title = el.input.value;
  if (!title.trim()) return;
  busy = true;
  try {
    const r = await api.capture.save(title);
    draft = '';
    el.input.value = '';
    el.draft.hidden = true;
    // 「已添加到 今天 · 1」：条保持打开，继续记 —— 连着记两三件是常态
    flash(`已添加到 ${r.target.name} · ${r.count}`);
  } catch (e) {
    flash((e && e.message) || '保存失败', true);
  } finally {
    busy = false;
  }
}

async function undo() {
  try {
    const r = await api.capture.undo();
    if (r && r.ok) flash(`已撤销「${r.title}」`);
    else flash('没有可撤销的记录', true);
  } catch (e) {
    flash((e && e.message) || '撤销失败', true);
  }
}

async function cycle() {
  try {
    const s = await api.capture.cycle();
    if (!s) return;
    targets = s.targets || targets;
    targetId = s.target ? s.target.id : targetId;
    setTarget(s.target && s.target.name);
    el.input.focus();
  } catch (e) {
    /* 切清单失败不打断输入 */
  }
}

function hide() {
  // 收起前把当前内容留在内存：下次打开还在（带「未提交」标），不弹任何确认框
  draft = el.input.value;
  api.capture.hide().catch(() => {});
}

function onInput() {
  el.draft.hidden = !el.input.value || !draft;
  if (!el.input.value) draft = '';
  else draft = el.input.value;
}

function onKeydown(e) {
  // IME 组词中：Enter / 方向键都交给输入法，绝不提交
  if (composing || e.isComposing || e.keyCode === 229) return;

  if (e.key === 'Enter') {
    if (e.shiftKey) { e.preventDefault(); return; } // 单行待办：不做换行
    e.preventDefault();
    save();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    cycle();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hide();
    return;
  }
  // Ctrl+Z：撤销上一条已保存（5 秒内，与主窗口同一套语义）
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
    if (el.input.value) return; // 输入框里有内容时按系统撤销，别抢
    e.preventDefault();
    undo();
  }
}

/* ------------------------------ 启动 ------------------------------ */

el.input.addEventListener('input', onInput);
el.input.addEventListener('keydown', onKeydown);
el.target.addEventListener('click', (e) => { e.preventDefault(); cycle(); });
el.openMain.addEventListener('click', () => { api.capture.openMain().catch(() => {}); });
el.input.addEventListener('compositionstart', () => { composing = true; });
el.input.addEventListener('compositionend', () => { composing = false; });
// 点条上任何空白处都把焦点还给输入框（否则点一下标题就丢了光标）
el.root.addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  e.preventDefault();
  el.input.focus();
});

api.on('capture:show', (state) => render(state || {}));

// 主进程可能在我们 ready 之前就 show 过一次：主动拉一次当前状态，避免"打开是空白目标"
api.capture.state().then((s) => { if (s) render(s); }).catch(() => {});

document.addEventListener('keydown', (e) => {
  // window 级兜底：输入框失焦（极少见）时 Esc 仍能收起
  if (e.key === 'Escape' && document.activeElement !== el.input) {
    e.preventDefault();
    hide();
  }
});
