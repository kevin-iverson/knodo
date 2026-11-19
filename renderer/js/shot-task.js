'use strict';
/**
 * 截图建任务 · 确认卡
 *
 * 为什么一定要有这张卡：识图有 5–10 秒的延迟、识别结果永远不可能 100% 准，
 * 而建任务是**有副作用**的（列表、浮窗、日历、报告全都会跟着走）。
 * 所以这里的设计原则是「挡在最前面」：模型先给一份草稿，勾选、改名、调优先级、
 * **改计划日期**都在卡里做完，用户点确认之前，一个字节都不进库。
 *
 * 计划日期：模型只在截图里明写日期时给 due（见 ai.js#SHOT_SYSTEM_PROMPT），
 * 没写就是今天 —— 但用户能逐行改，也能一次把整批改到同一天（底部「全部设为」）。
 * 日期说辞与切换逻辑在 due-chip.js，与语音卡共用一份。
 *
 * 状态机：loading → ready / empty / error → submitting → 关闭
 *   - 只有显式关闭（按钮 / ✕）：识别花了时间也花了 token，误点遮罩就全丢了（closeOnMask:false）
 *   - 卡片**不重绘整块**：只有阶段切换才 paint()；勾选 / 改标题 / 改优先级只改 DOM 与 model，
 *     否则用户正在输入框里打字，一重绘光标就飞了
 */
import { api, PRIORITY_TEXT, PRIORITY_COLOR } from './api.js';
import { openPanelModal } from './modal.js';
import { openSettings } from './settings.js';
// 日期胶囊（今天/明天的说法、非法日期回落、胶囊 ↔ 原生日期输入）与语音卡共用一份
import { todayStr, dueText, dueTitle, safeDay, bindDueChip } from './due-chip.js';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 宿主注入的 toast（避免 shot-task → ui.js 的反向依赖） */
let toast = () => {};
/**
 * 宿主注入的「已经建好了，去把列表刷出来」回调。
 * 为什么不由主进程广播解决：commit() 之后主进程确实推了 ui:data-changed，但那一刻
 * 卡片的遮罩还在（宿主的 busy 判定会跳过）而且窗口有焦点（非浮窗来源也会跳过），
 * 所以列表不会自己更新。这里在卡片**关闭之后**把结果交给宿主，由它决定刷哪个视图。
 */
let onAdded = () => {};
export function setShotHandlers({ toast: t, onAdded: a } = {}) {
  if (typeof t === 'function') toast = t;
  if (typeof a === 'function') onAdded = a;
}

/**
 * api.shot.* 回的是**信封**（{ ok, data } / { ok:false, code, message }），不是抛异常。
 * 原因：contextBridge 跨世界复制 Error 时只保留 message / stack，业务码（NO_API_KEY /
 * NO_VISION / STALE）会被丢掉，卡片就没法区分"去配置"和"重试"。这里统一还原成
 * "正常返回 / 抛错"，下面的调用点仍然按 try/catch 写。
 */
async function shotApi(promise) {
  const r = await promise;
  if (r && r.ok === false) {
    const err = new Error(r.message || '操作失败');
    if (r.code) err.code = r.code;
    throw err;
  }
  return r ? r.data : r;
}

/** 当前打开的卡片（同一时刻只允许一张：快捷键再按一次不应该叠出第二个遮罩） */
let current = null;

/** 关闭当前卡片（主进程又送了一张新图时，由 openShotCard 调用） */
export function closeShotCard() {
  if (current && typeof current.close === 'function') {
    try { current.close(); } catch (e) { /* 已经关了 */ }
  }
  current = null;
}

const SOURCE_TEXT = { region: '框选截图', clipboard: '剪贴板图片' };

/**
 * 打开确认卡。
 * @param {object} [initialStatus] 主进程推来的 shot:status（含缩略图与视觉模型状态）
 * @returns {Promise<boolean>} 是否以「已添加」结束
 */
export function openShotCard(initialStatus) {
  closeShotCard();

  const S = {
    phase: 'loading',
    status: initialStatus || null,
    tasks: [],
    summary: '',
    modelLabel: '',
    errorCode: '',
    errorText: '',
    slow: false,
    busy: false,
    ocrFallback: false,
    /** 视觉模型不可用、已自动改用对话模型时的一句话原因（空 = 没降级） */
    degraded: '',
    imgW: 0,
    imgH: 0,
    source: '',
    /** 提交成功的回执（created / group / imageErrors），关闭后交给宿主的 onAdded */
    added: null,
  };

  if (S.status) {
    S.imgW = S.status.width || 0;
    S.imgH = S.status.height || 0;
    S.source = S.status.source || '';
  }

  let closeFn = () => {};
  let body = null;
  let okBtn = null;
  let slowTimer = null;

  /* ------------------------------ 渲染 ------------------------------ */

  const thumbHtml = () => {
    const src = S.status && S.status.preview ? S.status.preview : '';
    return `<button type="button" class="shot-thumb" id="shot-thumb" title="点击查看原图"${src ? '' : ' disabled'}>
      ${src ? `<img src="${esc(src)}" alt="待识别截图" />` : '<span class="shot-thumb-empty">无图</span>'}
      <span class="shot-thumb-zoom">放大</span>
    </button>`;
  };

  const headHtml = () => {
    const vision = (S.status && S.status.vision) || null;
    const count = S.tasks.length;
    let kicker;
    if (S.phase === 'loading') kicker = '正在识别…';
    else if (S.phase === 'empty') kicker = '没识别到待办';
    else if (S.phase === 'error') kicker = '识别失败';
    else if (S.ocrFallback) kicker = '没拆出待办 · 已识别文字';
    else kicker = `识别到 ${count} 项`;

    const model = S.modelLabel ? ` · ${esc(S.modelLabel)}` : '';
    const meta = [`来自 ${SOURCE_TEXT[S.source] || '截图'}`, S.imgW ? `${S.imgW}×${S.imgH}` : '']
      .filter(Boolean).join(' · ');
    const fallback = vision && vision.source === 'fallback'
      ? `<div class="shot-warn">未单独配置视觉模型，回落到对话模型${vision.imageCapability === 'yes' ? '' : '（是否支持图片未确认）'}</div>`
      : '';
    // 库里配了视觉模型，但这次请求失败后自动改走对话模型：必须说清楚这张结果是谁识别的，
    // 否则用户会以为设置里的视觉模型生效了
    const degraded = S.degraded
      ? `<div class="shot-warn">视觉模型不可用（${esc(S.degraded)}），这次已改用对话模型${S.modelLabel ? ` ${esc(S.modelLabel)}` : ''}</div>`
      : '';

    return `<div class="shot-head">
      ${thumbHtml()}
      <div class="shot-meta">
        <div class="shot-kicker">${esc(kicker)}${model}</div>
        <div class="shot-sub">${esc(meta)}</div>
        ${S.summary ? `<div class="shot-summary">${esc(S.summary)}</div>` : ''}
        ${S.ocrFallback ? '<div class="shot-warn">这张图没拆出明确待办，先把文字识别成一条草稿；标题可以自己改，不要就关掉。</div>' : ''}
        ${fallback}
        ${degraded}
      </div>
    </div>`;
  };

  const skeletonHtml = () => `
    <div class="shot-skel" aria-hidden="true">
      ${[0, 1, 2].map(() => '<div class="shot-skel-row"><span class="shot-skel-box"></span><span class="shot-skel-line"></span></div>').join('')}
    </div>
    <div class="shot-loading-note">${S.slow ? '模型在读取图片，通常 5–10 秒' : '正在读取图片里的待办…'}</div>`;

  const rowHtml = (t, i) => `
    <div class="shot-row${t.checked ? '' : ' is-off'}${S.ocrFallback ? ' is-ocr' : ''}" data-i="${i}">
      <label class="shot-check">
        <input type="checkbox" data-role="check"${t.checked ? ' checked' : ''} aria-label="选择这条" />
        <span class="shot-check-box"></span>
      </label>
      <div class="shot-row-main">
        <div class="shot-title" contenteditable="true" spellcheck="false"
             data-role="title" role="textbox" aria-label="任务标题">${esc(t.title)}</div>
        ${t.note ? `<div class="shot-note">${esc(t.note)}</div>` : ''}
      </div>
      <!-- 计划日期胶囊：识别到就显示具体日期（高亮），没识别到显示「今天」。
           点一下换成原生日期输入，改完自动复原 —— 比自绘日历可靠，也支持键盘输入。 -->
      <button type="button" class="shot-due${t.due ? ' is-set' : ''}" data-role="due"
              title="${esc(dueTitle(t.due))}">${esc(dueText(t.due))}</button>
      <input type="date" class="shot-due-input" data-role="due-input"
             value="${esc(t.due || '')}" tabindex="-1" aria-label="计划日期" hidden />
      <button type="button" class="shot-pri" data-role="pri" data-p="${t.priority}"
              title="点击切换优先级：低 → 中 → 高 → 紧急"
              style="--p:${PRIORITY_COLOR[t.priority] || PRIORITY_COLOR[1]}">${PRIORITY_TEXT[t.priority] || '中'}</button>
      <button type="button" class="shot-del" data-role="del" title="从这次添加里去掉" aria-label="去掉这一条">✕</button>
    </div>`;

  /** 批量日期：只在 2 条以上出现；点一下把所有条目改到同一天 */
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
      <div class="shot-state-title">这张图里没找到需要动手的事</div>
      <div class="shot-state-desc">可能是一张纯截图、或者内容已经完成。可以换一张，也可以直接手写一条。</div>
      <div class="shot-state-act">
        <button type="button" class="ghost-btn" data-act="rewrite">我来手写</button>
        <button type="button" class="primary-btn" data-act="another">换一张</button>
      </div>
    </div>`;

  const errorHtml = () => {
    const needSetup = S.errorCode === 'NO_API_KEY' || S.errorCode === 'NO_VISION' || S.errorCode === 'VISION_KEY_MISSING';
    return `
    <div class="shot-state is-error">
      <div class="shot-state-title">没能识别这张图</div>
      <div class="shot-state-desc">${esc(S.errorText || '未知原因')}</div>
      <div class="shot-state-act">
        ${needSetup ? '<button type="button" class="primary-btn" data-act="settings">去配置视觉模型</button>' : ''}
        <button type="button" class="${needSetup ? 'ghost-btn' : 'primary-btn'}" data-act="retry">重试</button>
        <button type="button" class="ghost-btn" data-act="another">换一张</button>
      </div>
    </div>`;
  };

  const bodyHtml = () => {
    if (S.phase === 'loading') return `${headHtml()}${skeletonHtml()}`;
    if (S.phase === 'empty') return `${headHtml()}${emptyHtml()}`;
    if (S.phase === 'error') return `${headHtml()}${errorHtml()}`;
    return `${headHtml()}${listHtml()}`;
  };

  function paint() {
    if (!body) return;
    body.innerHTML = bodyHtml();
    body.classList.toggle('is-loading', S.phase === 'loading');
    syncSubmitState();
    bindBody();
  }

  /**
   * 只刷新主按钮（文案 + 可用性），不重绘列表：勾选 / 改日期时把滚动位置和
   * 输入焦点搞丢是很讨厌的事。
   */
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
    // 有条目落在别的日期时按钮直接说条数：「添加到今天」会变成一句假话
    okBtn.textContent = picked.length && !allToday ? `添加 ${picked.length} 条` : '添加到今天';
  }

  /* ------------------------------ 行内交互 ------------------------------ */

  function bindBody() {
    const thumb = body.querySelector('#shot-thumb');
    if (thumb) thumb.addEventListener('click', showBigImage);

    body.querySelectorAll('.shot-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const t = S.tasks[i];
      if (!t) return;

      row.querySelector('[data-role="check"]')?.addEventListener('change', (e) => {
        t.checked = e.target.checked;
        row.classList.toggle('is-off', !t.checked);
        syncSubmitState();
      });

      // 标题：contenteditable 就地编辑，回车收工、Esc 还原。不做输入即重绘 —— 光标会飞
      const titleEl = row.querySelector('[data-role="title"]');
      if (titleEl) {
        let before = t.title;
        titleEl.addEventListener('input', () => { t.title = titleEl.textContent || ''; syncSubmitState(); });
        titleEl.addEventListener('focus', () => { before = t.title; });
        titleEl.addEventListener('blur', () => {
          const clean = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
          t.title = clean;
          if (titleEl.textContent !== clean) titleEl.textContent = clean;
          // 清空标题 = 这条不要了（不弹错，按"删除"处理）
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
            e.preventDefault();
            e.stopPropagation();
            titleEl.textContent = before;
            t.title = before;
            titleEl.blur();
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

    // 批量日期：所有条目改成同一天。改完重绘（此刻没有输入焦点，安全）
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
        else if (act === 'another') recapture();
        else if (act === 'settings') { openSettings('ai'); closeFn(); }
        else if (act === 'rewrite') startManual();
      });
    });
  }

  /** 删掉一行 / 标题被清空后重排：这时没有输入焦点，重绘是安全的 */
  function repaintList() {
    if (!body) return;
    body.innerHTML = `${headHtml()}${listHtml()}`;
    bindBody();
    syncSubmitState();
  }

  /* ------------------------------ 大图 ------------------------------ */

  async function showBigImage() {
    if (!body) return;
    const modal = body.closest('.modal');
    if (!modal || modal.querySelector('.shot-zoom')) return;
    let info;
    try {
      info = await shotApi(api.shot.image());
    } catch (e) {
      toast(`图片已过期：${(e && e.message) || e}`);
      return;
    }
    const layer = document.createElement('div');
    layer.className = 'shot-zoom';
    // data-esc-stop：Esc 先把放大层关掉，而不是连整张卡一起关
    layer.setAttribute('data-esc-stop', '1');
    layer.innerHTML = `<img src="${esc(info.dataUrl)}" alt="截图原图" />
      <div class="shot-zoom-hint">${info.width} × ${info.height} · 点击任意处关闭</div>`;
    const kill = () => {
      document.removeEventListener('keydown', onEsc, true);
      layer.remove();
    };
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); kill(); } };
    layer.addEventListener('click', kill);
    document.addEventListener('keydown', onEsc, true);
    modal.appendChild(layer);
  }

  /* ------------------------------ 流程 ------------------------------ */

  async function runRecognize() {
    S.phase = 'loading';
    S.slow = false;
    S.ocrFallback = false;
    S.degraded = '';
    S.errorText = '';
    S.errorCode = '';
    paint();
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      if (S.phase !== 'loading') return;
      S.slow = true;
      const note = body && body.querySelector('.shot-loading-note');
      if (note) note.textContent = '模型在读取图片，通常 5–10 秒';
    }, 1500);
    try {
      const r = await shotApi(api.shot.recognize());
      clearTimeout(slowTimer);
      S.modelLabel = r.modelLabel || '';
      S.summary = r.summary || '';
      S.ocrFallback = r.fallback === 'text';
      S.degraded = r.degraded ? String(r.degradedReason || '配置不可用') : '';
      if (r.width) S.imgW = r.width;
      if (r.height) S.imgH = r.height;
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

  /**
   * 换一张：先试剪贴板（不闪屏、不隐藏主窗口），没有图就顺势转框选 ——
   * 用户点「换一张」时想的是"再给我一张"，不该被一句"剪贴板里没有图片"顶回来。
   */
  async function recapture() {
    if (S.busy) return '';
    S.busy = true;
    let clipErr = '';
    try {
      const st = await shotApi(api.shot.clipboard());
      if (st && st.hasImage) {
        applyStatus(st);
        return '';
      }
      clipErr = '剪贴板里没有图片';
    } catch (e) {
      clipErr = (e && e.message) || '读不到剪贴板';
    }
    try {
      const st = await shotApi(api.shot.screen());
      if (st && !st.canceled && st.hasImage) {
        applyStatus(st);
        return '';
      }
      // 用户主动取消框选：不算错误，卡片保持原样
      S.busy = false;
      return '';
    } catch (e) {
      S.busy = false;
      return (e && e.message) || clipErr || '换图失败';
    }
  }

  function applyStatus(st) {
    S.status = st;
    S.imgW = st.width || 0;
    S.imgH = st.height || 0;
    S.source = st.source || '';
    S.tasks = [];
    S.summary = '';
    S.modelLabel = '';
    S.ocrFallback = false;
    S.degraded = '';
    S.busy = false;
    runRecognize();
  }

  /** 空态里的「我来手写」：给一条空行，光标直接落进去 */
  function startManual() {
    S.tasks = [{ title: '', note: '', priority: 1, due: '', checked: true }];
    S.ocrFallback = false;
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

  /* ------------------------------ 启动 ------------------------------ */

  const promise = openPanelModal({
    title: '截图建任务',
    className: 'modal-shot',
    okText: '添加到今天',
    // 识别花了 5–10 秒和 token，误点遮罩不该把结果丢掉
    closeOnMask: false,
    showClose: true,
    // 正在改标题时 Esc 只退出编辑、不关卡片（否则改一半按 Esc 整张卡就没了）
    escGuard: (mask) => !!(document.activeElement && document.activeElement.closest
      && document.activeElement.closest('.shot-title') && mask.contains(document.activeElement)),
    extraButtons: [
      { label: '全不选', handler: () => { toast('这次没有添加任何任务'); closeFn(); } },
    ],
    html: '<div class="shot-body"></div>',
    onMount: (mask, close) => {
      closeFn = close;
      body = mask.querySelector('.shot-body');
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
        const r = await shotApi(api.shot.commit({ tasks: chosen }));
        S.added = r;
        const away = (r.days || []).filter((d) => d && d !== todayStr()).length;
        if (r.imageErrors && r.imageErrors.length) {
          toast(`已添加 ${r.created} 条，但截图保存失败：${r.imageErrors[0]}`);
        } else if (away) {
          // 落在别的日期的任务不会出现在「今天」里，不说清楚会以为没保存上
          toast(`已添加 ${r.created} 条，其中 ${away} 条不在今天（在对应日期或「即将到期」里查看）`);
        } else {
          toast(`已添加 ${r.created} 条到 ${r.group ? r.group.name : '今天'}`);
        }
        // 成功后由 modal 自己关闭；return undefined = 提交成功
        return undefined;
      } catch (e) {
        S.phase = 'ready';
        paint();
        return (e && e.message) || '添加失败，请重试';
      }
    },
    onClose: () => {
      clearTimeout(slowTimer);
      current = null;
      // 关卡片 = 丢掉这张图（原图本来就没落盘，不留任何痕迹）
      shotApi(api.shot.discard()).catch(() => {});
    },
  });

  // 第一次打开：没有 status（极端情况）就自己去问一次
  if (!initialStatus) {
    shotApi(api.shot.status()).then((st) => {
      if (!current) return;
      if (st && st.hasImage) applyStatus(st);
      else {
        S.phase = 'error';
        S.errorText = '这张截图过期了，请重新截一次';
        paint();
      }
    }).catch(() => {
      if (!current) return;
      S.phase = 'error';
      S.errorText = '读不到截图状态，请重新截一次';
      paint();
    });
  }

  return promise.then((ok) => {
    // 只有「确认提交成功」这一条路径需要补刷。放在这里而不是 onSubmit 里：
    // 这一步遮罩已经移除，宿主的刷新不会被 busy 判定挡掉，也不拖慢关卡片
    if (!ok || !S.added) return ok;
    const r = S.added;
    S.added = null;
    try {
      const p = onAdded(r);
      if (p && typeof p.catch === 'function') p.catch(() => { /* 刷新失败不影响已经入库的任务 */ });
    } catch (e) { /* 同上 */ }
    return ok;
  });
}
