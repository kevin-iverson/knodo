'use strict';
/**
 * 会议录制内核。
 *
 * 采集链路：
 *   系统声 ┐
 *           ├─→ AudioContext 混音 → MediaStreamDestination →┐
 *   麦克风 ┘                                                ├─→ MediaRecorder → 分片 → IPC 写盘
 *   屏幕/窗口画面 ─────────────────────────────────────────┘
 *
 * 几个关键点：
 * 1) Windows 上「系统声」用 chromeMediaSource:'desktop' 取 WASAPI 回环信号——
 *    会议里对方的声音就能直接录到，而不是靠麦克风去收喇叭。该约束要求必须同时申请 video，
 *    拿到后立刻停掉视频轨。
 * 2) 分片采用「到点 stop → 换新 recorder」的方式，而不是 timeslice：
 *    timeslice 产出的是增量数据，中间片段缺少 WebM 头无法独立播放/上传；
 *    换 recorder 出来的每个文件都是完整可解析的独立文件。
 * 3) 一次会议会产出多个文件，正好绕开云端 ASR 常见的单文件 25MB 限制。
 */
import { api } from './api.js';

let notify = () => {};
let onFinished = () => {};

export function setRecorderHandlers({ toast, onMeetingSaved } = {}) {
  if (toast) notify = toast;
  if (onMeetingSaved) onFinished = onMeetingSaved;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const pad = (n) => String(n).padStart(2, '0');

function stampNow(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 选一种浏览器实际支持的容器 */
function pickMimeType(withVideo) {
  const candidates = withVideo
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

/* ------------------------------ 采集 ------------------------------ */

/**
 * 组装录制所需的 MediaStream。
 * @returns {Promise<{stream:MediaStream, stopList:Array, audioCtx:AudioContext|null, report:object}>}
 */
async function acquireStreams({ mode, sourceId, wantMic, wantSystem }) {
  const report = { mic: false, system: false, video: false, mimeType: '' };
  let audioCtx = null;
  let dest = null;
  const stopList = [];

  if (wantMic || wantSystem) {
    audioCtx = new AudioContext();
    dest = audioCtx.createMediaStreamDestination();
    const addTrack = (track) => {
      audioCtx.createMediaStreamSource(new MediaStream([track])).connect(dest);
      stopList.push(track);
    };

    if (wantSystem) {
      try {
        // 桌面音频（Windows = WASAPI 回环）：必须同时申请 video 才能拿到音轨
        const sysStream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'desktop' } },
          video: { mandatory: { chromeMediaSource: 'desktop' } },
        });
        sysStream.getVideoTracks().forEach((t) => t.stop());
        const track = sysStream.getAudioTracks()[0];
        if (track) { addTrack(track); report.system = true; }
        else sysStream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        console.warn('[recorder] 系统声采集失败：', e && e.message);
      }
    }

    if (wantMic) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        micStream.getAudioTracks().forEach(addTrack);
        report.mic = micStream.getAudioTracks().length > 0;
      } catch (e) {
        console.warn('[recorder] 麦克风采集失败：', e && e.message);
      }
    }
  }

  const tracks = dest ? [...dest.stream.getAudioTracks()] : [];

  if (mode === 'screen' && sourceId) {
    try {
      const screenStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxFrameRate: 12,
            maxWidth: 1920,
            maxHeight: 1080,
          },
        },
      });
      const vt = screenStream.getVideoTracks();
      vt.forEach((t) => stopList.push(t));
      tracks.push(...vt);
      report.video = vt.length > 0;
    } catch (e) {
      console.warn('[recorder] 屏幕采集失败：', e && e.message);
    }
  }

  if (!tracks.length) {
    if (audioCtx) audioCtx.close().catch(() => {});
    const err = new Error('没有采集到任何音频或画面轨道，请检查麦克风/扬声器是否正常');
    err.recorderEmpty = true;
    throw err;
  }
  return { stream: new MediaStream(tracks), stopList, audioCtx, report };
}

/* ------------------------------ 会话状态 ------------------------------ */

const NO_SESSION = {
  active: false, sessionId: '', title: '', mode: 'audio', sourceLabel: '',
  startedAt: null, pausedAt: null, pausedMs: 0, seq: 0,
  stream: null, stopList: [], audioCtx: null, recorder: null, timer: null, saves: [],
};

let session = { ...NO_SESSION };
let dockTimer = null;

export function isRecording() {
  return session.active;
}

function elapsedMs() {
  if (!session.startedAt) return 0;
  const base = (session.pausedAt || Date.now()) - session.startedAt;
  return Math.max(0, base - session.pausedMs);
}

function fmtElapsed(ms = elapsedMs()) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/* ------------------------------ 悬浮控制条 ------------------------------ */

function ensureDock() {
  let dock = document.getElementById('rec-dock');
  if (dock) return dock;
  dock = document.createElement('div');
  dock.className = 'rec-dock';
  dock.id = 'rec-dock';
  dock.innerHTML = `
    <span class="rec-pulse"></span>
    <span class="rec-time" id="rec-time">00:00</span>
    <span class="rec-mode" id="rec-mode"></span>
    <span class="rec-size" id="rec-size"></span>
    <button class="ghost-btn tiny" data-rec="pause" id="rec-pause">⏸ 暂停</button>
    <button class="danger-btn" data-rec="stop">■ 结束录制</button>`;
  document.body.appendChild(dock);

  dock.querySelector('[data-rec="stop"]').addEventListener('click', () => { stopRecording(); });
  dock.querySelector('[data-rec="pause"]').addEventListener('click', togglePause);

  // 计时器是模块级单例：dock 反复创建/销毁时不能叠加 interval
  clearInterval(dockTimer);
  dockTimer = setInterval(() => {
    if (!session.active) return;
    const t = document.getElementById('rec-time');
    if (t) t.textContent = fmtElapsed();
  }, 500);
  return dock;
}

function updateDock() {
  const dock = ensureDock();
  dock.classList.add('is-live');
  const modeEl = dock.querySelector('#rec-mode');
  const pauseBtn = dock.querySelector('#rec-pause');
  if (modeEl) modeEl.textContent = session.mode === 'screen' ? '屏幕 + 音频' : '仅音频';
  if (pauseBtn) pauseBtn.textContent = session.pausedAt ? '▶ 继续' : '⏸ 暂停';
  const sizeEl = dock.querySelector('#rec-size');
  if (sizeEl) sizeEl.textContent = session.seq > 0 ? `已存 ${session.seq} 片` : '';
}

function removeDock() {
  clearInterval(dockTimer);
  dockTimer = null;
  const dock = document.getElementById('rec-dock');
  if (dock) dock.remove();
}

function togglePause() {
  if (!session.active || !session.recorder) return;
  if (session.pausedAt) {
    session.pausedMs += Date.now() - session.pausedAt;
    session.pausedAt = null;
    session.recorder.resume();
  } else {
    session.pausedAt = Date.now();
    session.recorder.pause();
  }
  updateDock();
}

/* ------------------------------ 分片录制 ------------------------------ */

async function saveCurrentChunk(parts) {
  const blob = new Blob(parts, { type: session.mimeType || 'audio/webm' });
  if (!blob.size) return;
  const data = new Uint8Array(await blob.arrayBuffer());
  session.seq += 1;
  try {
    await api.rec.saveChunk({ sessionId: session.sessionId, seq: session.seq, data, ext: 'webm' });
    updateDock();
  } catch (e) {
    notify(`分片 ${session.seq} 保存失败：${e && e.message ? e.message : e}`);
  }
}

/** 到点后停掉当前 recorder → onstop 里存盘 → 立刻开下一段 */
function startRecorder() {
  const mimeType = pickMimeType(session.mode === 'screen' && session.hasVideo);
  session.mimeType = mimeType;
  const rec = new MediaRecorder(session.stream, mimeType ? { mimeType } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onerror = (e) => notify(`录制出错：${(e && e.error && e.error.message) || '未知错误'}`);
  rec.onstop = () => {
    const task = saveCurrentChunk(parts);
    session.saves.push(task);
    // 最后一段不再续开（session.active 已置 false 或 sliceMs 已到）
    if (session.active) {
      task.finally(() => { if (session.active) startRecorder(); });
    }
  };
  rec.start();
  session.recorder = rec;

  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (session.active && rec.state !== 'inactive') rec.stop();
    else startRecorder(); // 暂停中：等 resume 后重新计时
  }, session.sliceMs);
}

/* ------------------------------ 对外：开始 / 结束 ------------------------------ */

/**
 * @param {object} opts { mode:'audio'|'screen', sourceId, sourceLabel, title, wantMic, wantSystem, sliceMs }
 */
export async function startRecording(opts) {
  if (session.active) { notify('正在录制中'); return; }
  if (typeof MediaRecorder === 'undefined') {
    notify('当前环境不支持 MediaRecorder，无法录制');
    return;
  }
  const started = new Date();
  let acquired;
  try {
    acquired = await acquireStreams({
      mode: opts.mode,
      sourceId: opts.sourceId,
      wantMic: opts.wantMic !== false,
      wantSystem: opts.wantSystem !== false,
    });
  } catch (e) {
    notify(e && e.message ? e.message : '采集失败');
    throw e;
  }

  let startedSessionId = '';
  try {
    const s = await api.rec.startSession();
    startedSessionId = s.sessionId;
  } catch (e) {
    acquired.stopList.forEach((t) => t.stop());
    if (acquired.audioCtx) acquired.audioCtx.close().catch(() => {});
    notify(`创建录制会话失败：${e && e.message ? e.message : e}`);
    throw e;
  }

  session = {
    ...NO_SESSION,
    active: true,
    sessionId: startedSessionId,
    title: opts.title,
    mode: opts.mode,
    sourceLabel: opts.sourceLabel || '',
    startedAt: started,
    sliceMs: opts.sliceMs || 10 * 60 * 1000,
    stream: acquired.stream,
    stopList: acquired.stopList,
    audioCtx: acquired.audioCtx,
    hasVideo: acquired.report.video,
    report: acquired.report,
  };

  const missing = [];
  if (opts.wantMic !== false && !acquired.report.mic) missing.push('麦克风');
  if (opts.wantSystem !== false && !acquired.report.system) missing.push('系统声');
  if (missing.length) notify(`⚠ 未能采集到${missing.join(' / ')}，仅录制已成功的轨道`);

  updateDock();
  startRecorder();
  return { sessionId: session.sessionId, report: acquired.report };
}

/** 停止录制并把分片归档成一条会议记录 */
export async function stopRecording() {
  if (!session.active) return null;
  const durationMs = elapsedMs();
  const { sessionId, title, mode, sourceLabel, startedAt, recorder } = session;
  session.active = false;
  clearTimeout(session.timer);

  if (recorder && recorder.state !== 'inactive') recorder.stop();
  // 等所有分片写完，避免最后一个文件还没落盘就去 finalize
  await Promise.allSettled(session.saves.concat([new Promise((r) => setTimeout(r, 60))]));

  session.stopList.forEach((t) => { try { t.stop(); } catch (e) { /* 已停止 */ } });
  if (session.audioCtx) session.audioCtx.close().catch(() => {});
  removeDock();
  session = { ...NO_SESSION };

  try {
    const meeting = await api.rec.finalize({
      sessionId, title, mode, sourceLabel,
      startedAt: startedAt ? startedAt.toISOString() : '',
      durationMs,
    });
    notify('录制已保存，可继续转写 / 生成纪要');
    onFinished(meeting);
    return meeting;
  } catch (e) {
    notify(`保存录制失败：${e && e.message ? e.message : e}`);
    return null;
  }
}

/* ------------------------------ 开始前的配置面板 ------------------------------ */

/**
 * 打开录制设置面板：选择「仅音频 / 屏幕+音频」、按需挑录制源，再开始录制。
 */
export async function openRecorder() {
  if (session.active) { notify('正在录制中，请先结束当前录制'); return; }

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal rec-setup" role="dialog" aria-modal="true" aria-label="开始录制">
      <div class="modal-head">开始会议录制</div>
      <div class="modal-body">
        <label class="field-label" for="rec-title">会议名称</label>
        <input class="modal-input" id="rec-title" data-field="title" type="text" maxlength="60" />

        <div class="field-label">采集方式</div>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="rec-mode" value="audio" checked /><span class="choice-dot"></span><span>仅音频（推荐）</span></label>
          <label class="choice"><input type="radio" name="rec-mode" value="screen" /><span class="choice-dot"></span><span>画面 + 音频</span></label>
        </div>

        <div class="field-label">声音来源</div>
        <div class="choice-row">
          <label class="choice"><input type="checkbox" name="rec-sys" checked /><span class="choice-dot"></span><span>系统声（会议里对方的声音）</span></label>
          <label class="choice"><input type="checkbox" name="rec-mic" checked /><span class="choice-dot"></span><span>麦克风（我自己的声音）</span></label>
        </div>

        <div id="rec-source-wrap" hidden>
          <div class="field-label">录制画面</div>
          <div class="rec-source-grid" id="rec-source-grid"><div class="rec-loading">正在读取可录制窗口…</div></div>
        </div>

        <label class="field-label" for="rec-slice">单片时长（自动切分，便于上传转写）</label>
        <select class="modal-input" id="rec-slice" data-field="slice">
          <option value="300000">5 分钟</option>
          <option value="600000" selected>10 分钟</option>
          <option value="900000">15 分钟</option>
          <option value="1800000">30 分钟</option>
        </select>
        <div class="modal-hint">录制中请勿把窗口最小化到托盘，否则画面轨会被系统暂停。</div>
        <div class="modal-error" hidden></div>
      </div>
      <div class="modal-foot">
        <div class="foot-extra"><button type="button" class="ghost-btn" data-extra="导入录音文件">导入录音文件</button></div>
        <div class="foot-main">
          <button type="button" class="ghost-btn" data-modal="cancel">取消</button>
          <button type="button" class="primary-btn" data-modal="ok">⏺ 开始录制</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const titleInput = mask.querySelector('#rec-title');
  titleInput.value = `会议 ${stampNow()}`;

  const grid = mask.querySelector('#rec-source-grid');
  const wrap = mask.querySelector('#rec-source-wrap');
  const errEl = mask.querySelector('.modal-error');
  const okBtn = mask.querySelector('[data-modal="ok"]');
  let sources = [];
  let pickedId = '';

  const loadSources = async () => {
    grid.innerHTML = '<div class="rec-loading">正在读取可录制窗口…</div>';
    try {
      sources = await api.rec.listSources();
    } catch (e) {
      sources = [];
      console.warn('[recorder] 读取录制源失败：', e && e.message);
    }
    if (!sources.length) {
      grid.innerHTML = '<div class="rec-loading">未获取到可录制的屏幕 / 窗口</div>';
      return;
    }
    pickedId = sources[0].id;
    grid.innerHTML = sources.map((s, i) => `
      <button type="button" class="rec-source${i === 0 ? ' picked' : ''}" data-id="${esc(s.id)}">
        ${s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="" />` : '<span class="rec-src-empty">无预览</span>'}
        <span class="rec-src-name">${esc(s.name)}</span>
      </button>`).join('');
    grid.querySelectorAll('.rec-source').forEach((btn) => {
      btn.addEventListener('click', () => {
        pickedId = btn.dataset.id;
        grid.querySelectorAll('.rec-source').forEach((b) => b.classList.toggle('picked', b === btn));
      });
    });
  };

  mask.querySelectorAll('input[name="rec-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      const need = r.value === 'screen';
      wrap.hidden = !need;
      if (need && !sources.length) loadSources();
    });
  });

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    mask.remove();
  };
  const showError = (msg) => {
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  };
  const submit = async () => {
    const mode = (mask.querySelector('input[name="rec-mode"]:checked') || {}).value || 'audio';
    const wantMic = mask.querySelector('input[name="rec-mic"]').checked;
    const wantSystem = mask.querySelector('input[name="rec-sys"]').checked;
    if (!wantMic && !wantSystem && mode === 'audio') { showError('至少要勾选一个声音来源'); return; }
    if (mode === 'screen' && !pickedId) { showError('请选择一个要录制的屏幕 / 窗口'); return; }
    const sourceObj = sources.find((s) => s.id === pickedId);
    okBtn.disabled = true;
    showError('');
    try {
      await startRecording({
        mode,
        sourceId: mode === 'screen' ? pickedId : '',
        sourceLabel: mode === 'screen' ? (sourceObj ? sourceObj.name : '') : (wantMic && wantSystem ? '麦克风 + 系统声' : (wantSystem ? '系统声' : '麦克风')),
        title: titleInput.value.trim() || `会议 ${stampNow()}`,
        wantMic,
        wantSystem,
        sliceMs: Number(mask.querySelector('#rec-slice').value) || 600000,
      });
      close();
    } catch (e) {
      showError((e && e.message) || '启动录制失败');
      okBtn.disabled = false;
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };

  document.addEventListener('keydown', onKey, true);
  mask.querySelector('[data-modal="cancel"]').addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  okBtn.addEventListener('click', submit);
  mask.querySelector('[data-extra="导入录音文件"]').addEventListener('click', async () => {
    try {
      const r = await api.rec.importMedia();
      if (r && r.canceled) return;
      close();
      if (r && r.meeting) onFinished(r.meeting);
    } catch (err) {
      showError((err && err.message) || '导入失败');
    }
  });
}

/** 绑定工具栏「⏺ 录制」按钮 */
export function bindRecordButton() {
  const btn = document.getElementById('btn-record');
  if (!btn) return false;
  btn.addEventListener('click', () => {
    openRecorder().catch((e) => notify(`打开录制失败：${e && e.message ? e.message : e}`));
  });
  return true;
}
