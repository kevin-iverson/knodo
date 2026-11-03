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
  picker: document.getElementById('cap-picker'),
};

/** 目标清单候选（Tab 循环）：[{ id, name }] */
let targets = [];
/** 下拉里的全部清单（含子分组）：[{ id, name, depth, path }] */
let groups = [];
let targetId = null;
/** 下拉是否展开；pickIndex 是键盘高亮项（不是"已选中"） */
let pickerOpen = false;
let pickIndex = 0;
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
  if (Array.isArray(state.groups)) groups = state.groups;
  if (state.target) {
    targetId = state.target.id == null ? null : Number(state.target.id);
    setTarget(state.target.name);
  }
  // 每次显示都从收起态开始：主进程已经先把窗口高度还原成 52px，这里只清 DOM 状态
  resetPicker(true);
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

/* ------------------------------ 清单下拉 ------------------------------ */

const escHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function paintPicker() {
  if (!pickerOpen) return;
  el.picker.innerHTML = groups
    .map((g, i) => {
      const on = g.id === targetId;
      return `<div class="cap-pick${on ? ' is-on' : ''}${i === pickIndex ? ' is-focus' : ''}"
                   role="option" aria-selected="${on}" data-idx="${i}"
                   title="${escHtml(g.path || g.name)}"
                   style="padding-left:${8 + (g.depth || 0) * 14}px">
                <span class="cap-pick-dot"></span>
                <span class="cap-pick-name">${escHtml(g.name)}</span>
                ${on ? '<span class="cap-pick-check">✓</span>' : ''}
              </div>`;
    })
    .join('');
}

/**
 * @param {boolean} [silent] 窗口马上要隐藏时传 true：主进程的 toggle 已经把高度还原，不必再发 IPC
 */
function resetPicker(silent) {
  pickerOpen = false;
  el.picker.innerHTML = '';
  el.picker.hidden = true;
  if (!silent) api.capture.picker({ open: false }).catch(() => {});
}

async function openPicker() {
  // 打开前拉一次最新清单：条可能是十几分钟前就打开的，期间用户在主窗口建/删过分组，
  // 只用打开时那份快照就会出现"刚建的清单在这里看不到"
  try {
    const s = await api.capture.state();
    if (s && Array.isArray(s.groups)) groups = s.groups;
  } catch (e) {
    /* 拉不到就退回上一次的快照，至少还能选 */
  }
  if (!groups.length) return;
  pickerOpen = true;
  pickIndex = Math.max(0, groups.findIndex((g) => g.id === targetId));
  el.picker.hidden = false;
  paintPicker();
  // 先加高窗口再滚动高亮行：顺序反了会按旧的 52px 高度算裁剪范围
  try {
    await api.capture.picker({ open: true, count: Math.min(groups.length, 8) });
  } catch (e) {
    /* 加高失败也能选，只是列表被窗口裁掉下半截 */
  }
  scrollPickIntoView();
  el.input.focus(); // 焦点留在输入框：可以边看清单边继续打字
}

function scrollPickIntoView() {
  const on = el.picker.querySelector('.is-focus');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function movePick(d) {
  if (!groups.length) return;
  pickIndex = (pickIndex + d + groups.length) % groups.length;
  paintPicker();
  scrollPickIntoView();
}

async function commitPick() {
  const g = groups[pickIndex];
  resetPicker();
  el.input.focus();
  if (!g || g.id === targetId) return;
  try {
    const r = await api.capture.setTarget(g.id);
    targetId = r.target.id;
    setTarget(r.target.name);
    if (Array.isArray(r.targets)) targets = r.targets;
  } catch (e) {
    flash((e && e.message) || '切换清单失败', true);
  }
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
  resetPicker(true);
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

  // 下拉展开时，方向键/回车归下拉用（这是显式打开的状态，Enter = 选清单而不是存任务）
  if (pickerOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePick(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); movePick(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); commitPick(); return; }
    if (e.key === 'Escape') { e.preventDefault(); resetPicker(); el.input.focus(); return; }
    if (e.key === 'Tab') { e.preventDefault(); resetPicker(); cycle(); return; }
  }

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
// 点清单名 = 展开完整清单（Tab 仍保留"快速切下一个"的老手感）
el.target.addEventListener('click', (e) => {
  e.preventDefault();
  if (pickerOpen) resetPicker();
  else openPicker();
});
el.picker.addEventListener('click', (e) => {
  const row = e.target.closest('.cap-pick');
  if (!row) return;
  pickIndex = Number(row.dataset.idx) || 0;
  commitPick();
});
el.openMain.addEventListener('click', () => { api.capture.openMain().catch(() => {}); });
el.input.addEventListener('compositionstart', () => { composing = true; });
el.input.addEventListener('compositionend', () => { composing = false; });
// 点条上任何空白处都把焦点还给输入框（否则点一下标题就丢了光标）
el.root.addEventListener('mousedown', (e) => {
  if (e.target.closest('button') || e.target.closest('#cap-picker')) return;
  e.preventDefault();
  el.input.focus();
});
// 点到下拉外面就收起下拉（但不收起整条），键盘用户则靠 Esc
document.addEventListener('mousedown', (e) => {
  if (!pickerOpen) return;
  if (e.target.closest('#cap-picker') || e.target.closest('#cap-target')) return;
  resetPicker();
}, true);

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
