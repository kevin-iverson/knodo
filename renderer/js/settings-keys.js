'use strict';
/**
 * 设置 · 快捷键分区。
 *
 * 与壳层（settings.js）分开：录制是一套独立的状态机（document 捕获 keydown、8 秒超时、
 * 三层冲突回滚、重绘时保留提示），塞进壳层会让「加一个设置项」这种小改动也碰到它。
 *
 * 对外只暴露三个东西：keysPaneHtml() / mountKeysPane() / disposeKeysPane()。
 */
import { api } from './api.js';

let toast = (msg) => console.warn('[settings:keys]', msg);
/** 列表重绘后通知壳层重跑搜索过滤（重绘会丢掉 hidden 状态） */
let notifyChange = () => {};

let actions = [];
let inApp = [];

/** 正在录制的动作 id */
let recording = null;
let recordTimer = null;
/** 录制期间按下的修饰键（实时预览用） */
let liveMods = [];
/** 行内提示：actionId → { text, kind: 'ok'|'warn'|'err' }，跨重绘保留 */
const msgs = new Map();

const KIND_OF = { ok: 'is-ok', warn: 'is-warn', err: 'is-err' };

/* ------------------------------ 工具 ------------------------------ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 面板宿主：录制态判断要用「整个弹窗」，不能只看分区容器 */
const host = () => document.querySelector('.modal-settings');
/**
 * 取快捷键分区容器。
 * 同时接受「整个弹窗」和「分区元素本身」两种入参 —— 挂载时给的是分区，录制回调给的是弹窗，
 * 只按一种写就会在另一种上找不到自己（表现是列表永远停在「载入中」）。
 */
function paneOf(root) {
  if (root && root.matches && root.matches('[data-pane="keys"]')) return root;
  const box = (root && root.querySelector) ? root : host();
  return box ? box.querySelector('[data-pane="keys"]') : null;
}

/* ------------------------------ 键名 / 显示 ------------------------------ */

/** 修饰键（只有它们时不算"录到"） */
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight',
  'MetaLeft', 'MetaRight', 'CapsLock', 'OSLeft', 'OSRight',
]);

/**
 * 从键盘事件取主键名（Electron accelerator 键名）。
 * 优先用 e.code：Alt / Ctrl 组合下 e.key 会被输入法或键盘布局改写，
 * 而 code 是物理键位，录制结果才稳定。
 */
function keyName(e) {
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  const map = {
    Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter',
    Backspace: 'Backspace', Escape: 'Esc',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'Insert', Delete: 'Delete',
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
  };
  if (map[code]) return map[code];
  // 兜底：e.key 的单字符（一些输入法会给出不可预期的 code）
  const k = e.key || '';
  if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase();
  if (/^[0-9]$/.test(k)) return k;
  if (k.length === 1) return k;
  return '';
}

/** 事件 → accelerator 字符串（与主进程同一套写法：Control+Alt+B） */
function accelOf(e, key) {
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  if (key) parts.push(key);
  return parts.join('+');
}

function liveText() {
  return liveMods.length ? `${liveMods.join(' + ')} + …` : '按下新组合键…';
}

/** `Control+Alt+B` → `Ctrl + Alt + B` */
function textOf(accel) {
  const a = actions.find((x) => x.accel === accel);
  if (a) return a.text;
  return String(accel || '')
    .split('+')
    .map((p) => (p === 'Control' ? 'Ctrl' : p === 'Super' ? 'Win' : p))
    .join(' + ');
}

/* ------------------------------ 渲染 ------------------------------ */

function rowHtml(a) {
  const isRec = recording === a.id;
  const capText = isRec ? liveText() : (a.text || '未设置');
  const msg = msgs.get(a.id);
  // 启动时就没注册上的键（多半被别的软件抢了）要主动说一声，否则用户按了没反应找不到原因
  const autoWarn = !msg && !isRec && a.accel && !a.registered
    ? { text: '该组合已被系统或其他程序占用，未能注册', kind: 'err' }
    : null;
  const shown = msg || autoWarn;
  const search = `${a.label} ${a.hint || ''} ${a.text || ''}`.toLowerCase();
  return `
    <div class="st-row st-krow${isRec ? ' is-recording' : ''}" data-key="${esc(a.id)}" data-search="${esc(search)}">
      <div class="st-row-main">
        <div class="st-row-title">${esc(a.label)}</div>
        ${a.hint ? `<div class="st-row-desc">${esc(a.hint)}</div>` : ''}
      </div>
      <div class="st-row-ctl">
        <button type="button" class="st-cap${a.accel ? '' : ' is-empty'}" data-role="cap"
                title="点击后按下新的组合键">${esc(capText)}</button>
        ${a.accel && !isRec ? '<button type="button" class="st-cap-clear" data-role="clear" title="清除这个键">✕</button>' : ''}
      </div>
      <div class="st-kmsg ${shown ? KIND_OF[shown.kind] : ''}">${shown ? esc(shown.text) : ''}</div>
    </div>`;
}

function inAppHtml() {
  if (!inApp.length) return '';
  const items = inApp
    .map((k) => `<div class="st-inapp-row"><span class="st-inapp-key">${esc(k.key)}</span><span>${esc(k.label)}</span></div>`)
    .join('');
  return `
    <details class="st-inapp">
      <summary>应用内快捷键<span class="st-tag">只读</span></summary>
      <div class="st-inapp-list">${items}</div>
    </details>`;
}

/** 分区 HTML（壳层在打开设置时一次性拼进来） */
export function keysPaneHtml() {
  return `
    <section class="st-sec">
      <div class="st-sec-title">全局快捷键</div>
      <div class="st-sec-desc">在任意应用中都能使用，修改后立即生效。点一下右侧的组合键，再按下你想用的键。</div>
      <div class="st-card" id="st-keys-list"><div class="st-loading">载入中…</div></div>
    </section>
    <section class="st-sec">
      <div class="st-sec-title">键位管理</div>
      <div class="st-card">
        <div class="st-row" data-search="恢复默认快捷键 出厂设置">
          <div class="st-row-main">
            <div class="st-row-title">恢复默认</div>
            <div class="st-row-desc">把全部动作改回出厂键位（自定义与手动清除都会被覆盖）</div>
          </div>
          <div class="st-row-ctl"><button type="button" class="st-btn" data-keys-act="reset">恢复默认</button></div>
        </div>
        <div class="st-row" data-search="全部清除 关闭全局快捷键">
          <div class="st-row-main">
            <div class="st-row-title">全部清除</div>
            <div class="st-row-desc">所有全局键都不再响应，之后可用「恢复默认」找回</div>
          </div>
          <div class="st-row-ctl"><button type="button" class="st-btn" data-keys-act="clearAll">全部清除</button></div>
        </div>
      </div>
    </section>
    <div id="st-keys-inapp">${inAppHtml()}</div>
    <div class="st-foot-note">
      提示：当前台窗口以管理员权限运行时（任务管理器、管理员终端等），Windows 会拦下普通权限进程注册的
      全局热键——这是系统限制，此时请从托盘菜单操作。
    </div>`;
}

function repaint(root) {
  const pane = paneOf(root);
  if (!pane) return;
  const box = pane.querySelector('#st-keys-list');
  if (box) {
    box.innerHTML = actions.length
      ? actions.map(rowHtml).join('')
      : '<div class="st-loading">没有可配置的快捷键</div>';
    const recEl = recording ? box.querySelector(`.st-krow[data-key="${recording}"] .st-cap`) : null;
    // 让 Esc 先给录制态，别把整个设置面板关掉（modal.js 的 Esc 在 document 捕获）
    if (recEl) recEl.setAttribute('data-esc-stop', '');
  }
  const inAppBox = pane.querySelector('#st-keys-inapp');
  if (inAppBox) inAppBox.innerHTML = inAppHtml();
  notifyChange();
}

/* ------------------------------ 录制 ------------------------------ */

function setMsg(actionId, text, kind = 'ok') {
  if (!text) msgs.delete(actionId);
  else msgs.set(actionId, { text, kind });
}

function stopRecording(root) {
  recording = null;
  liveMods = [];
  clearTimeout(recordTimer);
  recordTimer = null;
  document.removeEventListener('keydown', onRecordKey, true);
  if (root) repaint(root);
}

function startRecording(root, actionId) {
  if (recording === actionId) { stopRecording(root); return; }
  stopRecording(root);
  recording = actionId;
  liveMods = [];
  // 不清掉上一轮的提示：L2 注册失败会直接回到录制态让用户重按，
  // 那条红字（"已被系统或其他程序占用"）必须一直看得见，否则用户不知道自己为什么还在录。
  // 但上一轮的成功提示要收掉 —— 正在录一个新键时还挂着"已更新为 …"只会让人困惑。
  const prev = msgs.get(actionId);
  if (prev && prev.kind === 'ok') msgs.delete(actionId);
  repaint(root);
  document.addEventListener('keydown', onRecordKey, true);
  // 8 秒没有任何输入：自动退出，恢复原值
  recordTimer = setTimeout(() => {
    if (recording) toast('录制超时，键位未修改');
    stopRecording(root);
  }, 8000);
}

function onRecordKey(e) {
  if (!recording) return;
  const mask = host();
  if (!mask) { stopRecording(null); return; }
  const actionId = recording;

  // 单按修饰键：只更新预览（"Ctrl +" → "Ctrl + Alt +"），等主键
  if (MODIFIER_CODES.has(e.code) || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Win');
    liveMods = mods;
    repaint(mask);
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  // Esc：取消录制，键位不变
  if (e.key === 'Escape') {
    setMsg(actionId, '已取消，键位未修改', 'warn');
    stopRecording(mask);
    return;
  }
  // 裸 Backspace：清除该条绑定（等同点 ✕）
  if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    applyClear(mask, actionId);
    return;
  }

  const key = keyName(e);
  if (!key) return;
  const accel = accelOf(e, key);
  const hasStrong = e.ctrlKey || e.altKey || e.metaKey;
  if (!hasStrong) {
    setMsg(actionId, e.shiftKey
      ? 'Shift + 字母只能打出大写，抢不到；请再加上 Ctrl 或 Alt'
      : '全局键必须包含 Ctrl 或 Alt（否则会抢走所有应用的输入）', 'err');
    stopRecording(mask);
    return;
  }

  commit(mask, actionId, accel);
}

async function commit(root, actionId, accel) {
  try {
    const r = await api.keys.apply(actionId, accel);
    stopRecording(null);
    msgs.clear();
    if (!r || !r.ok) {
      // L2：被系统 / 其它程序占用 → 旧键仍然可用，就地让用户重按
      setMsg(actionId, (r && r.message) || '该组合无法注册，请换一个', 'err');
      await load();
      repaint(root);
      startRecording(root, actionId);
      return;
    }
    if (r.takenFrom) {
      // L1：本来属于别的动作 → 已从那里摘除（两处同时更新）
      setMsg(actionId, `该组合原属「${r.takenFrom}」，已从那里摘除`, 'warn');
    } else {
      setMsg(actionId, `已更新为 ${textOf(accel)}`, 'ok');
    }
    await load();
    repaint(root);
  } catch (e) {
    stopRecording(null);
    setMsg(actionId, (e && e.message) || '设置失败', 'err');
    await load();
    repaint(root);
  }
}

async function applyClear(root, actionId) {
  stopRecording(null);
  try {
    await api.keys.clear(actionId);
    msgs.clear();
    setMsg(actionId, '已清除（重启后仍然是未设置）', 'ok');
    await load();
    repaint(root);
  } catch (e) {
    setMsg(actionId, (e && e.message) || '清除失败', 'err');
    await load();
    repaint(root);
  }
}

/* ------------------------------ 数据 / 入口 ------------------------------ */

async function load() {
  const r = await api.keys.list();
  actions = Array.isArray(r && r.actions) ? r.actions : [];
  inApp = Array.isArray(r && r.inApp) ? r.inApp : [];
}

function onClick(root, e) {
  const cap = e.target.closest('[data-role="cap"]');
  const clr = e.target.closest('[data-role="clear"]');
  const act = e.target.closest('[data-keys-act]');
  if (act) {
    e.preventDefault();
    const which = act.dataset.keysAct;
    if (which === 'reset') {
      stopRecording(root);
      api.keys.reset().then(async (r) => {
        msgs.clear();
        await load();
        repaint(root);
        if (r && r.failed && r.failed.length) {
          toast(`已恢复默认，但 ${r.failed.join('、')} 被其它程序占用，未能注册`);
        } else {
          toast('已恢复默认快捷键');
        }
      }).catch((err) => toast(`恢复默认失败：${(err && err.message) || err}`));
    } else if (which === 'clearAll') {
      if (!confirm('清除全部全局快捷键？清除后所有全局键都不再响应（可用「恢复默认」找回）。')) return;
      stopRecording(root);
      api.keys.clearAll().then(async () => {
        msgs.clear();
        await load();
        repaint(root);
        toast('已清除全部全局快捷键');
      }).catch((err) => toast(`清除失败：${(err && err.message) || err}`));
    }
    return;
  }
  const row = e.target.closest('.st-krow');
  if (!row) return;
  const actionId = row.dataset.key;
  if (clr) { e.preventDefault(); applyClear(root, actionId); return; }
  if (cap) { e.preventDefault(); startRecording(root, actionId); }
}

/**
 * 挂载：绑定事件 + 拉一次数据。
 * @param {HTMLElement} paneEl 分区容器
 * @param {{toast?:Function, onChange?:Function}} opts
 */
export function mountKeysPane(paneEl, { toast: t, onChange } = {}) {
  if (typeof t === 'function') toast = t;
  if (typeof onChange === 'function') notifyChange = onChange;
  if (!paneEl) return;
  paneEl.addEventListener('click', (e) => onClick(paneEl, e));
  load()
    .then(() => repaint(paneEl))
    .catch((e) => {
      const box = paneEl.querySelector('#st-keys-list');
      if (box) box.innerHTML = `<div class="st-error">读取快捷键失败：${esc((e && e.message) || e)}</div>`;
    });
}

/** 关面板时收尾：不停监听的话，keydown 会继续被吃掉 */
export function disposeKeysPane() {
  clearTimeout(recordTimer);
  recordTimer = null;
  document.removeEventListener('keydown', onRecordKey, true);
  recording = null;
  liveMods = [];
  msgs.clear();
}
