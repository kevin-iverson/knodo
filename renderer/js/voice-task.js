'use strict';
/**
 * 快速语音录入任务 · 录音内核 + 确认卡。
 *
 * 交互（全局快捷键按一下切换）：
 *   第一次 → 只开麦克风，页面底部挂一条录音条（复用 #rec-dock 形态）；
 *   第二次 → 停录、把 webm 一次性送主进程 ASR + AI 提取 → 出确认卡（跟截图建任务同一套 UI）。
 *
 * 三条设计约束：
 * 1. **音频只在渲染层内存里**，不落盘、不进附件；停录后 base64 一次性过 IPC，
 *    主进程转写完立刻删临时文件（用户拍板的「识别后丢弃」）。
 * 2. **只有一张卡 / 一条录音**：快捷键再按一次是「停止」，不是叠第二个遮罩；
 *    卡片打开时再按快捷键直接忽略（当前录音已经结束，正在识别或等人确认）。
 * 3. **提交后必须显式回调宿主刷新**：与 shot-task.js 同因 —— ui:data-changed 会被
 *    卡片的 busy/focus 两条守则拦掉，见 refreshAfterShotAdd 的注释。
 *
 * 计划日期与截图卡同口径：口语里的「周五 / 下周」按提示词要求**不推算**（落今天），
 * 用户可以在卡上逐行改，或底部一次改整批；逻辑在 due-chip.js。
 */
import { api, PRIORITY_TEXT, PRIORITY_COLOR } from './api.js';
import { isRecording as isMeetingRecording } from './recorder.js';
import { openPanelModal } from './modal.js';
import { openSettings } from './settings.js';
// 日期胶囊与截图卡共用一份实现（说辞、回落、切换逻辑完全一致）
import { todayStr, dueText, dueTitle, safeDay, bindDueChip } from './due-chip.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const pad = (n) => String(n).padStart(2, '0');

/** 宿主注入（避免反向 import ui.js） */
let toast = () => {};
let onAdded = () => {};
export function setVoiceHandlers({ toast: t, onAdded: a } = {}) {
  if (typeof t === 'function') toast = t;
  if (typeof a === 'function') onAdded = a;
}

/** 与 shotApi 同构：api.voiceTask.* 回信封，这里还原成异常让调用点能按 code 分流 */
async function voiceApi(promise) {
  const r = await promise;
  if (r && r.ok === false) {
    const err = new Error(r.message || '操作失败');
    if (r.code) err.code = r.code;
    throw err;
  }
  return r ? r.data : r;
}

/* ============================== 录音内核 ============================== */

/** 当前录音会话（同一时刻只有一条） */
let rec = null;

export function isVoiceRecording() {
  return !!(rec && rec.active);
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad(m)}:${pad(s)}`;
}

/** 录音条：复用会议录制的 .rec-dock 外壳与 rec-* 类名，只换 id 免得两套逻辑互相清掉 */
function ensureDock() {
  let dock = document.getElementById('voice-rec-dock');
  if (dock) return dock;
  dock = document.createElement('div');
  dock.id = 'voice-rec-dock';
  dock.className = 'rec-dock voice-rec-dock is-live';
  dock.innerHTML = `
    <span class="rec-pulse"></span>
    <span class="rec-label">语音录入</span>
    <span class="rec-time" data-role="time">00:00</span>
    <button type="button" class="ghost-btn tiny" data-role="cancel" title="丢弃这段录音">取消</button>
    <button type="button" class="danger-btn" data-role="stop" title="停止并转成任务（再按一次快捷键也一样）">■ 停止并识别</button>`;
  dock.querySelector('[data-role="stop"]').addEventListener('click', () => {
    stopVoiceRecord().catch((e) => toast((e && e.message) || '停止录音失败'));
  });
  dock.querySelector('[data-role="cancel"]').addEventListener('click', () => {
    cancelVoiceRecord();
  });
  document.body.appendChild(dock);
  return dock;
}

function removeDock() {
  document.getElementById('voice-rec-dock')?.remove();
}

function tickDock() {
  const dock = document.getElementById('voice-rec-dock');
  if (!dock || !rec || !rec.active) return;
  const t = dock.querySelector('[data-role="time"]');
  if (t) t.textContent = fmtElapsed(Date.now() - rec.startedAt);
}

/** 开始录音。快捷键与页面上的入口共用这一个函数 */
export async function startVoiceRecord() {
  if (isVoiceRecording()) return null;
  if (isMeetingRecording()) {
    toast('会议录音正在进行，先结束会议录音再用语音录入');
    return null;
  }
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    toast('当前环境不支持录音（需要安全上下文与麦克风权限）');
    return null;
  }
  const mimeType = pickMimeType();
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    toast(`打不开麦克风：${(e && e.message) || e}`);
    return null;
  }
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    toast('没有可用的麦克风');
    return null;
  }

  const parts = [];
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    toast(`无法开始录音：${(e && e.message) || e}`);
    return null;
  }

  rec = { active: true, stream, recorder, parts, mimeType, startedAt: Date.now(), stopping: false };
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  recorder.onerror = (e) => {
    const msg = (e && e.error && e.error.message) || '录音出错';
    console.error('[voice] MediaRecorder', msg);
    cancelVoiceRecord();
    toast(`录音出错：${msg}`);
  };
  recorder.start();
  ensureDock();
  tickDock();
  rec.timer = setInterval(tickDock, 500);
  return rec;
}

/** 停录 → base64 → 主进程识别 → 开确认卡。返回卡片 Promise（是否以「已添加」结束） */
export async function stopVoiceRecord() {
  if (!rec || !rec.active || rec.stopping) return null;
  rec.stopping = true;
  clearInterval(rec.timer);
  const session = rec;
  const elapsed = Date.now() - session.startedAt;
  rec = null; // 立刻释放"正在录音"状态：快捷键再按一次不会重复 stop

  const blob = await new Promise((resolve) => {
    session.recorder.onstop = () => resolve(new Blob(session.parts, { type: session.mimeType || 'audio/webm' }));
    try { session.recorder.stop(); } catch (e) { resolve(null); }
  });
  session.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* 已停 */ } });
  removeDock();

  if (!blob || !blob.size || elapsed < 800) {
    toast('录音太短，没听到内容（按住说完整一句话再停）');
    return null;
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  // 分块拼字节串：20MB 音频直接 String.fromCharCode(...buf) 会把参数栈撑爆。
  // 分块只是喂给 fromCharCode.apply 的参数，最后整串一次 btoa，没有块间补位问题。
  const CHUNK = 8190;
  let bin = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  const data = btoa(bin);
  return openVoiceCard({ data, mime: session.mimeType || 'audio/webm', durationMs: elapsed });
}

/** 丢弃当前录音（不识别、不弹卡） */
export function cancelVoiceRecord() {
  if (!rec) return;
  clearInterval(rec.timer);
  rec.active = false;
  try { if (rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch (e) { /* 忽略 */ }
  rec.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* 忽略 */ } });
  rec = null;
  removeDock();
}

/** 全局快捷键 / 页面入口的唯一切换点：第一次开录，第二次停录 */
export async function toggleVoiceRecord() {
  if (isVoiceRecording()) return stopVoiceRecord();
  // 确认卡已开时快捷键不做事：此时音频已送走，再按 neither 开录 nor stop 都说不通
  if (document.querySelector('.modal-voice')) {
    toast('正在整理刚才的语音，先确认或关掉这张卡');
    return null;
  }
  return startVoiceRecord();
}

/* ============================== 确认卡 ============================== */

/** 当前打开的卡片（快捷键/新识别都会先关掉旧的，避免叠遮罩） */
let current = null;
export function closeVoiceCard() {
  if (current && typeof current.close === 'function') {
    try { current.close(); } catch (e) { /* 已经关了 */ }
  }
  current = null;
}

/**
 * 打开确认卡。样式与交互直接复用 shot.css 的 .shot-*（只换头部为语音信息），
 * 这样两张卡看起来是同一套东西，也省下几百行重复 CSS。
 * @returns {Promise<boolean>} 是否以「已添加」结束
 */
export function openVoiceCard(audio) {
  closeVoiceCard();

  const S = {
    phase: 'loading',
    tasks: [],
    summary: '',
    transcript: '',
    asrModel: '',
    aiModel: '',
    durationMs: 0,
    fallback: false,
    errorCode: '',
    errorText: '',
    slow: false,
    busy: false,
    /** 提交成功的回执，关闭后交给宿主 onAdded（见 shot-task.js 同款说明） */
    added: null,
  };

  let closeFn = () => {};
  let body = null;
  let okBtn = null;
  let slowTimer = null;

  /* ------------------------------ 渲染 ------------------------------ */

  const headHtml = () => {
    let kicker;
    if (S.phase === 'loading') kicker = '正在转写并整理…';
    else if (S.phase === 'empty') kicker = '没找到要做的事';
    else if (S.phase === 'error') kicker = '没能识别这段话';
    else if (S.fallback) kicker = '没拆出待办 · 已先整理成一条';
    else kicker = `识别到 ${S.tasks.length} 项`;

    const models = [S.asrModel && `转写 ${S.asrModel}`, S.aiModel && `整理 ${S.aiModel}`]
      .filter(Boolean).join(' · ');
    const meta = [`录音 ${fmtElapsed(S.durationMs || 0)}`, models].filter(Boolean).join(' · ');
    return `<div class="shot-head voice-head">
      <div class="voice-mic" aria-hidden="true">🎤</div>
      <div class="shot-meta">
        <div class="shot-kicker">${esc(kicker)}</div>
        <div class="shot-sub">${esc(meta)}</div>
        ${S.summary ? `<div class="shot-summary">${esc(S.summary)}</div>` : ''}
        ${S.fallback ? '<div class="shot-warn">这段话没拆出明确待办，先整理成一条草稿；标题随便改，不要就关掉。</div>' : ''}
      </div>
    </div>`;
  };

  /** 转写原文：折叠在条目下方，可展开核对 AI 有没有听错 */
  const transcriptHtml = () => {
    if (!S.transcript) return '';
    return `<details class="voice-transcript">
      <summary>查看语音原文</summary>
      <div class="voice-transcript-text">${esc(S.transcript)}</div>
    </details>`;
  };

  const skeletonHtml = () => `
    <div class="shot-skel" aria-hidden="true">
      ${[0, 1, 2].map(() => '<div class="shot-skel-row"><span class="shot-skel-box"></span><span class="shot-skel-line"></span></div>').join('')}
    </div>
    <div class="shot-loading-note">${S.slow ? '转写 + 整理都在云端，通常 5–15 秒' : '正在听你说了什么…'}</div>`;

  // 与 shot-task.js#rowHtml 完全同构：勾选 / 就地改标题 / 日期 / 优先级 / 删除
  const rowHtml = (t, i) => `
    <div class="shot-row${t.checked ? '' : ' is-off'}${S.fallback ? ' is-ocr' : ''}" data-i="${i}">
      <label class="shot-check">
        <input type="checkbox" data-role="check"${t.checked ? ' checked' : ''} aria-label="选择这条" />
        <span class="shot-check-box"></span>
      </label>
      <div class="shot-row-main">
        <div class="shot-title" contenteditable="true" spellcheck="false"
             data-role="title" role="textbox" aria-label="任务标题">${esc(t.title)}</div>
        ${t.note ? `<div class="shot-note">${esc(t.note)}</div>` : ''}
      </div>
      <button type="button" class="shot-due${t.due ? ' is-set' : ''}" data-role="due"
              title="${esc(dueTitle(t.due))}">${esc(dueText(t.due))}</button>
      <input type="date" class="shot-due-input" data-role="due-input"
             value="${esc(t.due || '')}" tabindex="-1" aria-label="计划日期" hidden />
      <button type="button" class="shot-pri" data-role="pri" data-p="${t.priority}"
              title="点击切换优先级：低 → 中 → 高 → 紧急"
              style="--p:${PRIORITY_COLOR[t.priority] || PRIORITY_COLOR[1]}">${PRIORITY_TEXT[t.priority] || '中'}</button>
      <button type="button" class="shot-del" data-role="del" title="从这次添加里去掉" aria-label="去掉这一条">✕</button>
    </div>`;

  /** 批量日期：2 条以上才出现，点一下把所有条目改到同一天 */
  const batchHtml = () => {
    if (S.tasks.length < 2) return '';
    const first = S.tasks[0] ? (S.tasks[0].due || '') : '';
    const same = S.tasks.every((t) => (t.due || '') === first);
    return `<div class="shot-batch">
      <span class="shot-batch-label">${same ? '这批全部在' : '这批日期不同，全部设为'}</span>
      <button type="button" class="shot-due${first ? ' is-set' : ''}" data-role="batch-due"
              title="把所有条目改到同一天">${same ? esc(dueText(first)) : '同一天'}</button>
      <input type="date" class="shot-due-input" data-role="batch-input" tabindex="-1"
             aria-label="把所有条目设为同一天" hidden />
    </div>`;
  };

  const listHtml = () => (S.tasks.length
    ? `<div class="shot-list">${S.tasks.map(rowHtml).join('')}</div>${batchHtml()}`
    : '<div class="shot-empty-hint">没有可添加的条目</div>');

  const emptyHtml = () => `
    <div class="shot-state">
      <div class="shot-state-title">这段话里没什么要动手的事</div>
      <div class="shot-state-desc">可能只是随口说了一句，也可能没听清。可以自己手写一条，或者重录一次。</div>
      <div class="shot-state-act">
        <button type="button" class="ghost-btn" data-act="rewrite">我来手写</button>
        <button type="button" class="primary-btn" data-act="re-record">重新录音</button>
      </div>
    </div>`;

  const errorHtml = () => {
    const needSetup = S.errorCode === 'NO_ASR_KEY' || S.errorCode === 'NO_API_KEY';
    return `
    <div class="shot-state is-error">
      <div class="shot-state-title">没能识别这段话</div>
      <div class="shot-state-desc">${esc(S.errorText || '未知原因')}</div>
      <div class="shot-state-act">
        ${needSetup ? '<button type="button" class="primary-btn" data-act="settings">去配置 AI 与语音</button>' : ''}
        <button type="button" class="${needSetup ? 'ghost-btn' : 'primary-btn'}" data-act="retry">重试</button>
        <button type="button" class="ghost-btn" data-act="re-record">重新录音</button>
      </div>
    </div>`;
  };

  const bodyHtml = () => {
    if (S.phase === 'loading') return `${headHtml()}${skeletonHtml()}`;
    if (S.phase === 'empty') return `${headHtml()}${emptyHtml()}`;
    if (S.phase === 'error') return `${headHtml()}${errorHtml()}`;
    return `${headHtml()}${transcriptHtml()}${listHtml()}`;
  };

  function paint() {
    if (!body) return;
    body.innerHTML = bodyHtml();
    body.classList.toggle('is-loading', S.phase === 'loading');
    syncSubmitState();
    bindBody();
  }

  /** 只刷新主按钮（文案 + 可用性），不重绘列表：勾选 / 改日期时别把焦点搞丢 */
  function syncSubmitState() {
    if (!okBtn) return;
    const picked = S.tasks.filter((t) => t.checked && String(t.title || '').trim());
    okBtn.disabled = S.phase !== 'ready' || !picked.length;
    if (S.phase === 'submitting') {
      okBtn.textContent = '添加中…';
      return;
    }
    const today = todayStr();
    const allToday = picked.every((t) => !t.due || t.due === today);
    okBtn.textContent = picked.length && !allToday ? `添加 ${picked.length} 条` : '添加到今天';
  }

  /* ------------------------------ 行内交互 ------------------------------ */

  function bindBody() {
    body.querySelectorAll('.shot-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const t = S.tasks[i];
      if (!t) return;

      row.querySelector('[data-role="check"]')?.addEventListener('change', (e) => {
        t.checked = e.target.checked;
        row.classList.toggle('is-off', !t.checked);
        syncSubmitState();
      });

      const titleEl = row.querySelector('[data-role="title"]');
      if (titleEl) {
        let before = t.title;
        titleEl.addEventListener('input', () => { t.title = titleEl.textContent || ''; syncSubmitState(); });
        titleEl.addEventListener('focus', () => { before = t.title; });
        titleEl.addEventListener('blur', () => {
          const clean = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
          t.title = clean;
          if (titleEl.textContent !== clean) titleEl.textContent = clean;
          if (!clean) {
            row.remove();
            S.tasks.splice(i, 1);
            repaintList();
          }
          syncSubmitState();
        });
        titleEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); titleEl.blur(); }
          if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation();
            titleEl.textContent = before; t.title = before; titleEl.blur();
          }
        });
      }

      row.querySelector('[data-role="pri"]')?.addEventListener('click', (e) => {
        t.priority = (t.priority + 1) % 4;
        const btn = e.currentTarget;
        btn.dataset.p = String(t.priority);
        btn.textContent = PRIORITY_TEXT[t.priority];
        btn.style.setProperty('--p', PRIORITY_COLOR[t.priority]);
      });

      bindDueChip(row.querySelector('[data-role="due"]'), row.querySelector('[data-role="due-input"]'), {
        read: () => t.due || '',
        write: (v) => { t.due = v; },
      }, syncSubmitState);

      row.querySelector('[data-role="del"]')?.addEventListener('click', () => {
        S.tasks.splice(i, 1);
        repaintList();
      });
    });

    // 批量日期：所有条目改成同一天，改完重绘（此刻没有输入焦点，安全）
    const batchChip = body.querySelector('[data-role="batch-due"]');
    const batchInput = body.querySelector('[data-role="batch-input"]');
    if (batchChip && batchInput) {
      bindDueChip(batchChip, batchInput, {
        read: () => (S.tasks[0] ? S.tasks[0].due || '' : ''),
        write: (v) => {
          if (!v) return;
          S.tasks.forEach((x) => { x.due = v; });
          repaintList();
        },
      }, syncSubmitState);
    }

    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'retry') runRecognize();
        else if (act === 'settings') { openSettings('ai'); closeFn(); }
        else if (act === 're-record') {
          closeFn();
          startVoiceRecord().catch((e) => toast((e && e.message) || '打不开麦克风'));
        } else if (act === 'rewrite') startManual();
      });
    });
  }

  function repaintList() {
    if (!body) return;
    body.innerHTML = `${headHtml()}${transcriptHtml()}${listHtml()}`;
    bindBody();
    syncSubmitState();
  }

  function startManual() {
    S.tasks = [{ title: '', note: '', priority: 1, due: '', checked: true }];
    S.fallback = false;
    S.phase = 'ready';
    paint();
    const first = body.querySelector('.shot-title');
    if (first) {
      first.focus();
      const range = document.createRange();
      range.selectNodeContents(first);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /* ------------------------------ 流程 ------------------------------ */

  async function runRecognize() {
    S.phase = 'loading';
    S.slow = false;
    S.fallback = false;
    S.errorText = '';
    S.errorCode = '';
    paint();
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      if (S.phase !== 'loading') return;
      S.slow = true;
      const note = body && body.querySelector('.shot-loading-note');
      if (note) note.textContent = '转写 + 整理都在云端，通常 5–15 秒';
    }, 1500);
    try {
      const r = await voiceApi(api.voiceTask.submit({ data: audio.data, mime: audio.mime }));
      clearTimeout(slowTimer);
      S.summary = r.summary || '';
      S.transcript = r.transcript || '';
      S.asrModel = r.asrModel || '';
      S.aiModel = r.aiModel || '';
      S.durationMs = audio.durationMs || 0;
      S.fallback = r.fallback === 'text';
      S.tasks = (r.tasks || []).map((t) => ({
        ...t,
        checked: true,
        due: safeDay(t && t.due),
      }));
      S.phase = S.tasks.length ? 'ready' : 'empty';
    } catch (e) {
      clearTimeout(slowTimer);
      S.phase = 'error';
      S.errorCode = (e && e.code) || '';
      S.errorText = (e && e.message) || '识别失败';
    }
    paint();
  }

  /* ------------------------------ 启动 ------------------------------ */

  const promise = openPanelModal({
    title: '语音录入任务',
    className: 'modal-shot modal-voice',
    okText: '添加到今天',
    closeOnMask: false, // 音频已录、识别花了 token，误点遮罩不该把结果丢掉
    showClose: true,
    escGuard: (mask) => !!(document.activeElement && document.activeElement.closest
      && document.activeElement.closest('.shot-title') && mask.contains(document.activeElement)),
    extraButtons: [
      { label: '全不选', handler: () => { toast('这次没有添加任何任务'); closeFn(); } },
    ],
    html: '<div class="shot-body voice-body"></div>',
    onMount: (mask, close) => {
      closeFn = close;
      body = mask.querySelector('.voice-body');
      okBtn = mask.querySelector('[data-modal="ok"]');
      current = { close };
      paint();
      runRecognize();
    },
    onSubmit: async () => {
      if (S.phase !== 'ready') return '识别还没结束，稍等一下';
      const chosen = S.tasks
        .filter((t) => t.checked && String(t.title || '').trim())
        .map((t) => ({
          title: t.title.trim(), note: t.note, priority: t.priority, due: t.due || '',
        }));
      if (!chosen.length) return '至少勾选一条；都不想建就点左下角「全不选」';
      S.phase = 'submitting';
      paint();
      try {
        const r = await voiceApi(api.voiceTask.commit({ tasks: chosen, transcript: S.transcript }));
        S.added = r;
        const away = (r.days || []).filter((d) => d && d !== todayStr()).length;
        if (away) {
          // 落在别的日期的任务不会出现在「今天」里，不说清楚会以为没保存上
          toast(`已添加 ${r.created} 条，其中 ${away} 条不在今天（在对应日期或「即将到期」里查看）`);
        } else {
          toast(`已添加 ${r.created} 条到 ${r.group ? r.group.name : '今天'}`);
        }
        return undefined; // 成功 → modal close(true)
      } catch (e) {
        S.phase = 'ready';
        paint();
        return (e && e.message) || '添加失败，请重试';
      }
    },
    onClose: () => {
      clearTimeout(slowTimer);
      current = null;
      // 没有音频要丢：主进程 submit 的 finally 已经删掉临时文件了
    },
  });

  return promise.then((ok) => {
    if (!ok || !S.added) return ok;
    const r = S.added;
    S.added = null;
    try {
      const p = onAdded(r);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* 刷新失败不影响已入库的任务 */ }
    return ok;
  });
}
