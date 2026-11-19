'use strict';
/**
 * 四象日记 · 视图与交互（原型 docs/features/journal-prototype.html 的落地版）。
 *
 * 唯一状态来源是主进程 SQLite：这里只缓存当前日的快照，任何写都走 api.journal.*，
 * 失败给 toast 而不是静默吞。四格 800ms 防抖落库 + 三态；碎碎念 Enter 提交、Shift+Enter 换行。
 * 纯文本，没有工具条、不进 FTS / AI —— 日记是「时间」不是「资料」。
 */
import { api } from '../api.js';
import { toast } from '../ui.js';
import { t as tr } from '../i18n.js';

// 中文原文单独留一份：主进程把「没改过」的四格名存成中文，英文态下要按位置换成英文
const LABEL_ZH = ['心智', '身体', '连结', '事业'];
const LABEL_DEFAULT = LABEL_ZH.map((s) => tr(s));
const PLACEHOLDERS = [
  '今天想明白了什么？读到 / 想到的一句是什么？',
  '睡够了吗？身体哪里有感觉？动了没有？',
  '和谁说了什么话？哪句让你停了一下？',
  '哪件事推进了？卡在哪儿？明天第一步是什么？',
].map((s) => tr(s));
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((s) => tr(s));

let labels = LABEL_DEFAULT.slice();
let current = null;       // { day, cells:[4], notes:[] }
let saveTimer = null;
let saveState = 'idle';   // idle | saving | saved
let rootEl = null;
let axMenu = null;
let destroyed = false;
let statsCache = { days: 0, thisMonth: 0 };

const $ = (id) => (rootEl ? rootEl.querySelector(`#${id}`) : null);
const pad = (n) => String(n).padStart(2, '0');

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekdayOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

function dayLabel(day) {
  const [, m, d] = day.split('-').map(Number);
  const base = tr('{m} 月 {d} 日', { m, d });
  return { main: day === localDay() ? `${base} ${tr('今天')}` : base, week: weekdayOf(day) };
}

function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + delta));
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function unwrap(res, fallback) {
  // preload 的 call() 已把 __error 转成异常；这里再兜一层防跨桥差异
  if (res && typeof res === 'object' && res.__error) throw new Error(res.__error);
  return res == null ? fallback : res;
}

/* ------------------------------ 数据 ------------------------------ */

async function refreshStats() {
  try { statsCache = unwrap(await api.journal.stats(), statsCache); } catch (e) { /* 保留上次 */ }
  const el = $('jr-streak-n');
  if (el) el.textContent = String(statsCache.days);
}

async function loadDay(day) {
  try {
    const data = unwrap(await api.journal.day(day), null);
    if (!data) throw new Error(tr('数据库未就绪'));
    current = {
      day: data.day,
      cells: Array.isArray(data.cells) ? data.cells.slice(0, 4).concat(['', '', '', '']).slice(0, 4) : ['', '', '', ''],
      notes: Array.isArray(data.notes) ? data.notes : [],
    };
    return true;
  } catch (e) {
    current = { day: localDay(day), cells: ['', '', '', ''], notes: [] };
    toast(tr('读取日记失败：{msg}', { msg: (e && e.message) || e }));
    return false;
  }
}

/* ------------------------------ 保存态 ------------------------------ */

function paintSave() {
  const el = $('jr-save');
  if (!el) return;
  el.className = `jr-save${saveState === 'idle' ? '' : ` is-${saveState}`}`;
  el.innerHTML = saveState === 'idle' ? ''
    : `<span class="sdot"></span>${saveState === 'saving' ? tr('保存中') : tr('已保存')}`;
}

/** 800ms 防抖落库。flush=true 时立即写（unmount / 切日期前调用，防丢改动） */
let pendingCell = -1;
let fadeTimer = null;

async function commitCell() {
  saveTimer = null;
  if (!current || destroyed || pendingCell < 0) return;
  const i = pendingCell;
  const day = current.day;
  const body = current.cells[i];
  pendingCell = -1;
  try {
    unwrap(await api.journal.setCell({ day, cell: i, body }), null);
    if (destroyed || !current || current.day !== day) return;
    saveState = 'saved';
    paintSave();
    refreshStats();
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (saveState === 'saved') { saveState = 'idle'; paintSave(); }
    }, 2000);
  } catch (e) {
    saveState = 'idle'; paintSave();
    toast(tr('保存失败：{msg}', { msg: (e && e.message) || e }));
  }
}

/** cell 变了就重新计时 800ms；flush=true 立即落库（切日期 / 卸载前） */
function markSaving(cell, flush) {
  // 只有 0..3 才是「改的是哪一格」；切日期 / 卸载传 -1 = 沿用待写的格子，
  // 不能把 pendingCell 覆盖成 -1（否则下面的 return 会让 flush 变成空操作，改动直接丢）
  if (Number.isInteger(cell) && cell >= 0) pendingCell = cell;
  if (pendingCell < 0) return;
  saveState = 'saving';
  paintSave();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (flush) commitCell();
  else saveTimer = setTimeout(commitCell, 800);
}

function clearTimers() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  saveState = 'idle';
}

/* ------------------------------ 渲染 ------------------------------ */

function quadsHtml() {
  return labels.map((label, i) => {
    const body = current.cells[i] || '';
    return `<section class="quad" style="--ax:var(--ax${i})">
      <div class="quad-head">
        <span class="quad-dot"></span>
        <span class="quad-label">${escapeHtml(label)}</span>
        <span class="quad-count">${body.trim() ? tr('{n} 字', { n: body.trim().length }) : ''}</span>
      </div>
      <textarea data-cell="${i}" placeholder="${escapeHtml(PLACEHOLDERS[i])}" spellcheck="false">${escapeHtml(body)}</textarea>
    </section>`;
  }).join('');
}

function noteHtml(n) {
  const hasCell = n.cell != null && n.cell >= 0 && n.cell <= 3;
  const ax = hasCell ? `<span class="note-tag" style="--ax:var(--ax${n.cell})">${escapeHtml(labels[n.cell])}</span>` : '';
  // taskId 是持久化标记（库里 task_id），task 只是本轮的乐观标记 —— 两者任一为真都算已转任务
  const linked = !!(n.taskId || n.task);
  const done = linked ? ' is-done' : '';
  const time = n.createdAt ? `${pad(new Date(n.createdAt).getHours())}:${pad(new Date(n.createdAt).getMinutes())}` : '';
  const trace = linked ? `<div class="note-trace">→ ${tr('已加入今天')}</div>` : '';
  return `<div class="jr-note${done}" data-note="${n.id}">
    <div class="note-top"><span class="note-time">${time}</span>${ax}</div>
    <div class="note-body">${escapeHtml(n.body)}</div>
    ${trace}
    <div class="note-acts">
      <button type="button" class="note-act" data-act="fold" data-note="${n.id}" title="${tr('归入某一象')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M17 7H9M17 7v8"/></svg>
      </button>
      <button type="button" class="note-act" data-act="task" data-note="${n.id}" title="${tr('转为今天的任务')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button type="button" class="note-act" data-act="del" data-note="${n.id}" title="${tr('删除')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>
      </button>
    </div>
  </div>`;
}

function paintNotes() {
  const list = $('notes-list');
  if (!list) return;
  const alive = current.notes.filter((n) => !n.gone);
  const cnt = rootEl.querySelector('.nh-count');
  if (cnt) cnt.textContent = tr('{n} 条', { n: alive.length });
  if (!alive.length) {
    list.innerHTML = `<div class="notes-empty">${tr('今天还没有碎碎念')}<br><span class="ne-sub">${tr('想到什么就丢一句，晚上再挑重要的归到四格里')}</span></div>`;
    return;
  }
  list.innerHTML = alive.map(noteHtml).join('');
}

function paintDaybar() {
  const lb = dayLabel(current.day);
  const today = localDay();
  const el = $('jr-day');
  if (el) el.innerHTML = `${escapeHtml(lb.main)}<span class="jr-week">${lb.week}</span>`;
  const next = $('day-next');
  if (next) next.disabled = current.day >= today;
  const btnBack = $('day-today');
  if (btnBack) btnBack.hidden = current.day === today;
}

function autoGrow(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.max(ta.scrollHeight, 24)}px`;
}

/**
 * 四格 textarea 回填。reload / 撤销 / 切日之后必须走这里 —— 只 paintNotes 的话
 * DOM 里还是上一屏的文字，用户会以为「撤销没生效」（实测踩过）。
 * 正在输入的那一格跳过，避免抢光标。
 */
function paintCells() {
  if (!rootEl) return;
  rootEl.querySelectorAll('[data-cell]').forEach((ta) => {
    const i = Number(ta.dataset.cell);
    const body = (current && current.cells && current.cells[i]) || '';
    if (document.activeElement !== ta && ta.value !== body) {
      ta.value = body;
      autoGrow(ta);
    }
    const count = ta.closest('.quad').querySelector('.quad-count');
    if (count) count.textContent = ta.value.trim() ? tr('{n} 字', { n: ta.value.trim().length }) : '';
  });
}

function paint() {
  if (!rootEl || destroyed || !current) return;
  paintDaybar();
  paintSave();
  paintCells();
  paintNotes();
  rootEl.querySelectorAll('[data-cell]').forEach(autoGrow);
  const input = $('note-input');
  if (input) autoGrow(input);
}

/* ------------------------------ 交互 ------------------------------ */

function showToast(msg, undo) {
  // ui.js 的 toast 不带撤销按钮；日记的归入 / 删除要有 5 秒撤销，这里用内联条
  let bar = rootEl.querySelector('.jr-undo-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'jr-undo-bar';
    rootEl.appendChild(bar);
  }
  bar.innerHTML = `<span>${escapeHtml(msg)}</span><button type="button" id="jr-undo-btn">${tr('撤销')}</button>`;
  const btn = bar.querySelector('#jr-undo-btn');
  btn.addEventListener('click', async () => {
    try { await undo(); bar.remove(); await reload(); } catch (e) { toast(tr('撤销失败：{msg}', { msg: (e && e.message) || e })); }
  });
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => bar.remove(), 5200);
}

async function reload() {
  const day = current ? current.day : localDay();
  await loadDay(day);
  paint();
}

async function addNote() {
  const input = $('note-input');
  if (!input) return;
  const body = input.value.trim();
  if (!body) return;
  try {
    const r = unwrap(await api.journal.noteAdd({ day: current.day, body }), null);
    if (r && r.note) current.notes.push(r.note);
    input.value = ''; autoGrow(input);
    paintNotes();
    refreshStats();
    const list = $('notes-list');
    if (list) list.scrollTop = list.scrollHeight;
    input.focus();
  } catch (e) {
    toast(tr('记下失败：{msg}', { msg: (e && e.message) || e }));
  }
}

async function removeNote(id) {
  const idx = current.notes.findIndex((n) => Number(n.id) === Number(id));
  if (idx < 0) return;
  const snapshot = current.notes[idx];
  try {
    unwrap(await api.journal.noteRemove(Number(id)), null);
    current.notes.splice(idx, 1);
    paintNotes(); refreshStats();
    showToast(tr('已删除'), async () => {
      // 撤销：物理删除后只能重建一条同 id 的记录（insert 带 id）
      unwrap(await api.journal.noteAdd({ day: snapshot.day, body: snapshot.body, cell: snapshot.cell }), null);
    });
  } catch (e) { toast(tr('删除失败：{msg}', { msg: (e && e.message) || e })); }
}

async function foldInto(id, cell) {
  const idx = current.notes.findIndex((n) => Number(n.id) === Number(id));
  if (idx < 0) return;
  const note = current.notes[idx];
  const prevCell = current.cells[cell];
  try {
    unwrap(await api.journal.noteFold({ id: Number(id), cell }), null);
    current.cells[cell] = prevCell.trim() ? `${prevCell.replace(/\s*$/, '')}\n${note.body}` : note.body;
    current.notes.splice(idx, 1);
    rootEl.querySelectorAll('[data-cell]').forEach((ta) => {
      if (Number(ta.dataset.cell) === cell) ta.value = current.cells[cell];
    });
    paint(); refreshStats();
    showToast(tr('已归入「{label}」', { label: labels[cell] }), async () => {
      // 撤销：格子还原 + 重建碎碎念（内容回到原料区）
      unwrap(await api.journal.setCell({ day: current.day, cell, body: prevCell }), null);
      unwrap(await api.journal.noteAdd({ day: note.day, body: note.body, cell: note.cell }), null);
    });
  } catch (e) { toast(tr('归入失败：{msg}', { msg: (e && e.message) || e })); }
}

/** 转任务：只做视觉留痕（P0），不写 tasks 表 —— 方案 §9 边界 9 */
async function convertTask(id) {
  const idx = current.notes.findIndex((n) => Number(n.id) === Number(id));
  if (idx < 0 || current.notes[idx].taskId) return;
  try {
    // 真落库到今天的任务：标题取正文前 60 字；条目置灰并回写 task_id 留痕
    const title = current.notes[idx].body.slice(0, 60);
    const task = await api.tasks.create({ title, plan_end: localDay() });
    // 回写是为了「重进视图仍然显示已加入」——只留内存标记会诱导用户二次点击、重复建任务
    if (task && task.id != null) {
      try { unwrap(await api.journal.noteUpdate({ id: Number(id), patch: { taskId: Number(task.id) } }), null); } catch (e) {
        console.warn('[journal] 回写 task_id 失败', e && e.message);
      }
      current.notes[idx].taskId = Number(task.id);
    }
    current.notes[idx].task = true;
    paintNotes();
    toast(tr('已加入今天：{title}', { title: title.length > 14 ? `${title.slice(0, 14)}…` : title }));
  } catch (e) { toast(tr('转任务失败：{msg}', { msg: (e && e.message) || e })); }
}

function closeAxMenu() {
  if (axMenu) { axMenu.remove(); axMenu = null; }
}

function openAxMenu(anchor, id) {
  closeAxMenu();
  const r = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'ax-menu';
  menu.innerHTML = labels.map((label, i) =>
    `<button type="button" data-ax="${i}"><span class="ax-dot" style="background:var(--ax${i})"></span>${tr('归入 {label}', { label: escapeHtml(label) })}</button>`
  ).join('') + `<div class="sep"></div><button type="button" data-ax="-1" style="color:var(--text-3)">${tr('取消')}</button>`;
  menu.style.left = `${Math.min(r.left - 100, window.innerWidth - 160)}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 200)}px`;
  document.body.appendChild(menu);
  axMenu = menu;
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ax]');
    if (!b) return;
    const i = Number(b.dataset.ax);
    closeAxMenu();
    if (i >= 0) foldInto(id, i);
  });
}

function onDocMouseDown(e) {
  if (axMenu && !e.target.closest('.ax-menu') && !e.target.closest('[data-act="fold"]')) closeAxMenu();
}
function onDocKey(e) { if (e.key === 'Escape') closeAxMenu(); }

function bind() {
  rootEl.querySelectorAll('[data-cell]').forEach((ta) => {
    autoGrow(ta);
    ta.addEventListener('input', () => {
      const i = Number(ta.dataset.cell);
      current.cells[i] = ta.value;
      autoGrow(ta);
      const count = ta.closest('.quad').querySelector('.quad-count');
      if (count) count.textContent = ta.value.trim() ? tr('{n} 字', { n: ta.value.trim().length }) : '';
      markSaving(i, false);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        const next = ta.closest('.quad').nextElementSibling;
        if (next) { e.preventDefault(); next.querySelector('textarea').focus(); }
      }
    });
  });

  const input = $('note-input');
  if (input) {
    autoGrow(input);
    input.addEventListener('input', () => autoGrow(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); }
    });
  }
  const send = $('note-send');
  if (send) send.addEventListener('click', addNote);

  const prev = $('day-prev');
  if (prev) prev.addEventListener('click', async () => {
    if (saveState === 'saving') markSaving(-1, true);
    await loadDay(shiftDay(current.day, -1)); paint();
  });
  const next = $('day-next');
  if (next) next.addEventListener('click', async () => {
    if (current.day >= localDay()) return;
    if (saveState === 'saving') markSaving(-1, true);
    await loadDay(shiftDay(current.day, 1)); paint();
  });
  const today = $('day-today');
  if (today) today.addEventListener('click', async () => {
    if (saveState === 'saving') markSaving(-1, true);
    await loadDay(localDay()); paint();
  });

  const list = $('notes-list');
  if (list) list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.note;
    if (b.dataset.act === 'fold') openAxMenu(b, id);
    else if (b.dataset.act === 'task') convertTask(id);
    else if (b.dataset.act === 'del') removeNote(id);
  });

  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onDocKey);
}

/** 挂载到 #view（由 index.js 调用） */
export async function renderJournal(root) {
  rootEl = root;
  destroyed = false;
  clearTimers();
  const ok = await loadDay(localDay());
  root.innerHTML = `
    <div class="jr-view">
      <div class="jr-daybar">
        <div class="jr-daynav">
          <button type="button" class="jr-arrow" id="day-prev" title="${tr('前一天')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>
          </button>
          <div class="jr-day" id="jr-day"></div>
          <button type="button" class="jr-arrow" id="day-next" title="${tr('后一天')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>
        <span class="jr-streak">${tr('已记录 {n} 天', { n: '<b id="jr-streak-n">0</b>' })}</span>
        <div class="jr-daybar-right">
          <span class="jr-save" id="jr-save"></span>
          <button type="button" class="jr-ghost" id="day-today" hidden>${tr('回到今天')}</button>
        </div>
      </div>
      ${ok ? `
      <div class="jr-body">
        <div class="jr-quads">${quadsHtml()}</div>
        <div class="jr-notes">
          <div class="notes-head"><span class="nh-title">${tr('碎碎念')}</span><span class="nh-count">${tr('{n} 条', { n: 0 })}</span></div>
          <div class="notes-list" id="notes-list"></div>
          <div class="notes-input">
            <textarea id="note-input" rows="1" placeholder="${tr('随手记一句…')}"></textarea>
            <button type="button" class="ni-send" id="note-send" title="${tr('记下（Enter）')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
            </button>
          </div>
          <div class="ni-hint">${tr('Enter 记下 · Shift+Enter 换行 · 悬停可归入 / 转任务 / 删除')}</div>
        </div>
      </div>` : `<div class="jr-unready">${tr('数据未就绪，请稍后重试')}</div>`}
    </div>`;
  bind();
  paint();
  refreshStats();
}

/** 设置里改了四格名字：不重挂，只更新标签（历史数据不受影响） */
export function applyLabels(next) {
  if (!Array.isArray(next) || next.length !== 4) return;
  labels = next.map((s, i) => {
    const v = String(s == null ? '' : s).trim();
    if (!v) return LABEL_DEFAULT[i];
    // 还是出厂名（用户没改过）→ 跟着界面语言走；自己改过的名字原样保留
    return v === LABEL_ZH[i] ? LABEL_DEFAULT[i] : v;
  });
  // 只存数组不刷 DOM 的话，用户在设置里改完名字回来看还是旧的（已踩）→ 就地更新文本
  if (!rootEl || destroyed) return;
  rootEl.querySelectorAll('[data-cell]').forEach((ta) => {
    const i = Number(ta.dataset.cell);
    const lb = ta.closest('.quad') && ta.closest('.quad').querySelector('.quad-label');
    if (lb) lb.textContent = labels[i];
  });
}

/** 卸载前 flush 未落库的防抖改动（方案 §9 边界 7） */
export function unmount() {
  destroyed = true;
  if (saveState === 'saving') markSaving(-1, true);
  clearTimers();
  closeAxMenu();
  document.removeEventListener('mousedown', onDocMouseDown);
  document.removeEventListener('keydown', onDocKey);
  rootEl = null;
  current = null;
}

/** 别的窗口改了库：只补碎碎念与统计，不碰四格 textarea（保住正在输入的文字与光标） */
export function refreshQuiet() {
  if (!rootEl || destroyed || !current) return;
  const day = current.day;
  api.journal.day(day).then((data) => {
    const r = unwrap(data, null);
    if (!r || destroyed || !current || current.day !== day) return;
    current.notes = Array.isArray(r.notes) ? r.notes : [];
    paintNotes();
    refreshStats();
  }).catch(() => {});
}

export function setLabelsForTest(v) { labels = v.slice(); }
