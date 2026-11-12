'use strict';
/**
 * 轻量模态框：用于替代原生 prompt()，支持输入校验、错误提示、Enter 提交 / Esc 关闭。
 *
 * 为什么不直接用 prompt()：Electron 的 window.prompt 在部分版本不弹窗而直接返回 null，
 * 且无法就地展示"重名""保存失败"等原因——用户看到的就是"点了 ＋ 没反应"。
 *
 * 两种形态：
 *  - openPromptModal：单输入框（+ 可选的单选组），用于「新增标签」这类简单场景；
 *  - openFormModal  ：多字段表单（text / password / select / choices），用于「分组编辑」
 *                     「AI 设置」这类需要一次填多个值的场景。两者共用同一套 CSS。
 */

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 打开模态框。
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {string} [opts.label] 输入框标签
 * @param {string} [opts.value] 初始值
 * @param {string} [opts.placeholder] 占位文案
 * @param {Array<{value:string,label:string,color?:string}>} [opts.choices] 可选的颜色/属性选项
 * @param {string} [opts.choicesLabel] 选项组标签
 * @param {string} [opts.okText] 确认按钮文案
 * @param {(value:string, choice:string) => Promise<string|void>} opts.onSubmit
 *        返回字符串表示校验/保存失败（内容作为错误提示展示），返回 undefined 表示成功并关闭
 * @returns {Promise<boolean>} 是否提交成功
 */
export function openPromptModal(opts) {
  const {
    title, label = '', value = '', placeholder = '',
    choices = null, choicesLabel = '', okText = '确定', onSubmit,
  } = opts;

  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const choicesHtml = choices
      ? `<div class="field-label">${esc(choicesLabel || '颜色')}</div>
         <div class="choice-row">${choices.map((c, i) => `
           <label class="choice" style="--c:${esc(c.color || '#c3cad6')}">
             <input type="radio" name="prompt-choice" value="${esc(c.value)}"${i === 0 ? ' checked' : ''} />
             <span class="choice-dot"></span><span>${esc(c.label)}</span>
           </label>`).join('')}</div>`
      : '';
    mask.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">${esc(title)}</div>
        <div class="modal-body">
          <label class="field-label" for="modal-input">${esc(label)}</label>
          <input class="modal-input" id="modal-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="30" />
          ${choicesHtml}
          <div class="modal-error" hidden></div>
        </div>
        <div class="modal-foot">
          <button type="button" class="ghost-btn" data-modal="cancel">取消</button>
          <button type="button" class="primary-btn" data-modal="ok">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    // 立即聚焦（无入场动画，避免闪一下）
    const input = mask.querySelector('.modal-input');
    const errEl = mask.querySelector('.modal-error');
    const okBtn = mask.querySelector('[data-modal="ok"]');
    input.focus();
    input.select();

    let busy = false;
    const showError = (msg) => {
      errEl.textContent = msg;
      errEl.hidden = !msg;
      mask.querySelector('.modal').classList.toggle('has-error', !!msg);
    };
    const close = (ok) => {
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      resolve(ok);
    };
    const submit = async () => {
      if (busy) return;
      const choice = (mask.querySelector('input[name="prompt-choice"]:checked') || {}).value || '';
      busy = true;
      okBtn.disabled = true;
      showError('');
      try {
        const msg = await onSubmit(input.value, choice);
        if (msg) { showError(msg); busy = false; okBtn.disabled = false; input.focus(); return; }
        close(true);
      } catch (e) {
        // 兜底：任何异常都就地展示原因，绝不静默失败
        showError((e && e.message) || '保存失败，请重试');
        busy = false;
        okBtn.disabled = false;
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); submit(); }
    };

    document.addEventListener('keydown', onKey, true);
    okBtn.addEventListener('click', submit);
    mask.querySelector('[data-modal="cancel"]').addEventListener('click', () => close(false));
    mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });
    // 支持在弹窗内提交表单语义
    mask.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'radio') { e.preventDefault(); submit(); } });
  });
}

/**
 * 自定义内容弹窗：用于「统计下钻」这类需要展示表格/列表、而不是收集表单输入的场景。
 * 主体 HTML 由调用方给出，事件也在 onMount 里自行挂载（调用方最清楚行数据）。
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.html] 弹窗主体 HTML
 * @param {string} [opts.className] 附加到 .modal 的类名（用于定制宽度/内边距）
 * @param {(root:HTMLElement, close:()=>void)=>void} [opts.onMount]
 * @param {string} [opts.okText] 底部关闭按钮文案
 * @param {Array<{label:string,handler:(root:HTMLElement)=>Promise<string|void>}>} [opts.extraButtons]
 *        底部左侧的附加操作（如「恢复默认」）；handler 返回字符串表示失败原因
 * @param {(root:HTMLElement) => Promise<string|void>} [opts.onSubmit]
 *        提供时底部按钮变为“确认”语义：返回字符串 = 校验失败并就地展示，否则关闭。
 *        不提供时保持原有的“关闭”语义（历史调用不受影响）。
 * @param {() => void} [opts.onClose]
 *        关闭钩子：Esc / 点遮罩 / 点按钮都会走这里。带自动保存的弹窗（如笔记编辑器）
 *        用它做最后一次 flush —— 否则用户改完直接按 Esc 会丢最后一次输入。
 * @param {boolean} [opts.showClose] 头部右侧显示 ✕ 关闭按钮（大弹窗建议开）
 * @param {string} [opts.headHtml] 头部右侧的额外按钮（调用方自备的可信 HTML）
 * @param {boolean} [opts.resizable] 右下角显示缩放手柄，可拖动改大小（双击手柄恢复默认）
 * @param {string} [opts.resizeKey] 尺寸记忆键：同一键的弹窗下次打开沿用上次大小
 * @param {number} [opts.minWidth] 缩放最小宽度（默认 520）
 * @param {number} [opts.minHeight] 缩放最小高度（默认 380）
 * @param {boolean} [opts.closeOnMask=true] 点遮罩是否关闭
 * @param {boolean} [opts.closeOnEsc=true] 按 Esc 是否关闭。
 *        与 closeOnMask 一起设成 false，就是「只有显式点按钮/✕ 才关」——
 *        用于检索这类「关掉就丢结果、还有 AI 成本」的弹窗
 * @param {(mask:HTMLElement) => boolean} [opts.escGuard]
 *        返回 true 时把这次 Esc 让给弹窗内部处理（如笔记搜索框「Esc 清空关键词」），不关窗
 * @returns {Promise<boolean>} 是否以“确认”关闭
 */
export function openPanelModal({
  title, html = '', className = '', onMount, okText = '关闭',
  extraButtons = [], onSubmit, onClose, showClose = false, headHtml = '',
  resizable = false, resizeKey = '', minWidth = 520, minHeight = 380,
  closeOnMask = true, closeOnEsc = true, escGuard = null,
}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal modal-panel${className ? ` ${esc(className)}` : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">
          <span class="modal-head-text">${esc(title)}</span>
          ${headHtml}
          ${showClose ? `<button type="button" class="modal-icon-btn" data-modal="close" title="${closeOnEsc ? '关闭（Esc）' : '关闭'}" aria-label="关闭">✕</button>` : ''}
        </div>
        <div class="modal-body">${html}</div>
        <div class="modal-error" hidden></div>
        <div class="modal-foot">
          ${extraButtons.length
    ? `<div class="foot-extra">${extraButtons.map((b) => `<button type="button" class="ghost-btn" data-extra="${esc(b.label)}">${esc(b.label)}</button>`).join('')}</div>`
    : ''}
          <div class="foot-main">
            <button type="button" class="primary-btn" data-modal="ok">${esc(okText)}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const errEl = mask.querySelector('.modal-error');
    const showError = (msg) => {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
      mask.querySelector('.modal').classList.toggle('has-error', !!msg);
    };
    let disposeResize = null;
    const close = (ok) => {
      document.removeEventListener('keydown', onKey, true);
      if (typeof disposeResize === 'function') {
        try { disposeResize(); } catch (e) { /* 清理失败不拦住关闭 */ }
        disposeResize = null;
      }
      if (typeof onClose === 'function') {
        try { onClose(); } catch (e) { /* 关闭钩子失败不能拦住关闭 */ }
      }
      mask.remove();
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 面板内的浮层（如笔记查找浮条）自带 data-esc-stop：Esc 先关最上面那一层，
      // 不然在笔记弹窗里关搜索会连整个弹窗一起关掉
      if (mask.querySelector('[data-esc-stop]')) return;
      // 宿主自带「Esc 先做点别的」的语义（笔记搜索框清空关键词）：这一下让给它，
      // 事件照常继续传播，内部处理器会把关键词清掉；下一次 Esc 才关窗
      if (typeof escGuard === 'function') {
        try { if (escGuard(mask)) return; } catch (e) { /* 判定失败按「关窗」处理 */ }
      }
      // 只允许显式按钮关闭（检索弹窗）：Esc 直接吞掉、不做任何事
      if (!closeOnEsc) return;
      e.stopPropagation();
      close(false);
    };
    document.addEventListener('keydown', onKey, true);
    mask.querySelector('[data-modal="ok"]').addEventListener('click', async () => {
      if (typeof onSubmit !== 'function') { close(true); return; }
      showError('');
      try {
        const msg = await onSubmit(mask);
        if (msg) { showError(msg); return; }
        close(true);
      } catch (e) {
        showError((e && e.message) || '操作失败，请重试');
      }
    });
    // 点遮罩关闭是可选项：问答弹窗这类「误点一下就丢整个提问结果」的场景要关掉，
    // 只允许 ✕ / 底部按钮 / Esc 显式关闭
    if (closeOnMask) mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });
    mask.querySelector('[data-modal="close"]')?.addEventListener('click', () => close(false));
    if (resizable) {
      disposeResize = mountResize(mask.querySelector('.modal'), { key: resizeKey, minWidth, minHeight });
    }

    extraButtons.forEach((b) => {
      const el = mask.querySelector(`[data-extra="${b.label}"]`);
      if (!el) return;
      el.addEventListener('click', async () => {
        showError('');
        try {
          // 第二个参数给 handler 一个「关掉自己」的口子：比如笔记编辑器里的「删除」，
          // 删完就该连窗口一起关，否则会停在一篇已不存在的笔记上。
          const msg = await b.handler(mask, () => close(false));
          if (msg) showError(msg);
        } catch (e) {
          showError((e && e.message) || '操作失败，请重试');
        }
      });
    });

    if (typeof onMount === 'function') onMount(mask, () => close(false));
  });
}

/**
 * 给面板弹窗装一个右下角缩放手柄。
 *
 * 为什么不用 CSS 的 `resize: both`：它要求元素 overflow 非 visible（会和 `.modal` 的
 * `overflow: hidden` + 内部滚动打架），而且手柄样式不可控、拖拽时不会触发子元素重排回调。
 * 这里用 pointer 事件自己算尺寸，同时：
 *  - 尺寸按 key 存 localStorage，下次打开沿用（用户把笔记窗口拉大一次就够了）；
 *  - 双击手柄清除记忆、回到 CSS 默认尺寸；
 *  - 窗口变小时自动收缩，避免弹窗被顶出可视区。
 * @returns {() => void} 清理函数（关闭弹窗时调用）
 */
function mountResize(modal, { key = '', minWidth = 520, minHeight = 380 } = {}) {
  if (!modal) return null;
  const storeKey = `modal-size:${key || 'default'}`;
  const defaultStyle = { width: modal.style.width, height: modal.style.height };
  let maximized = false;

  // 遮罩从自绘标题栏下沿开始（见 styles.css 的 .modal-mask），可用的垂直空间要扣掉那 40px，
  // 否则拖到最大时底部会被标题栏挤到看不见。
  const titlebarH = () => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h'));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };

  const clamp = (w, h) => {
    const maxW = Math.max(minWidth, window.innerWidth - 32);
    const maxH = Math.max(minHeight, window.innerHeight - titlebarH() - 32);
    return {
      w: Math.max(minWidth, Math.min(Math.round(w), maxW)),
      h: Math.max(minHeight, Math.min(Math.round(h), maxH)),
    };
  };
  const apply = (w, h) => {
    const { w: W, h: H } = clamp(w, h);
    modal.style.maxWidth = `${window.innerWidth - 32}px`;
    modal.style.maxHeight = `${window.innerHeight - titlebarH() - 32}px`;
    modal.style.width = `${W}px`;
    modal.style.height = `${H}px`;
    return { W, H };
  };
  const remember = () => {
    try {
      const r = modal.getBoundingClientRect();
      localStorage.setItem(storeKey, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
    } catch (e) { /* 隐私模式 / 存储配额不可用时静默降级为「只本次有效」 */ }
  };
  const restore = () => {
    try {
      const raw = localStorage.getItem(storeKey);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && s.w > 0 && s.h > 0) apply(s.w, s.h);
    } catch (e) { /* 记忆值损坏就按默认尺寸打开 */ }
  };
  const notifyResize = () => modal.dispatchEvent(new CustomEvent('modal:resize'));

  restore();

  const grip = document.createElement('div');
  grip.className = 'modal-resize';
  grip.title = '拖动调整窗口大小（双击恢复默认）';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-label', '调整弹窗大小');
  modal.appendChild(grip);

  const onGripDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = modal.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    maximized = false;
    modal.classList.add('is-resizing');
    grip.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      apply(start.w + (ev.clientX - start.x), start.h + (ev.clientY - start.y));
      notifyResize();
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      modal.classList.remove('is-resizing');
      remember();
      notifyResize();
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  };
  grip.addEventListener('pointerdown', onGripDown);
  grip.addEventListener('dblclick', () => {
    try { localStorage.removeItem(storeKey); } catch (e) { /* 忽略 */ }
    modal.style.width = defaultStyle.width;
    modal.style.height = defaultStyle.height;
    maximized = false;
    notifyResize();
  });

  // 最大化 / 还原：由头部按钮触发（弹窗管理器把口子挂在元素上，调用方不必持有内部变量）
  let savedSize = null;
  modal.__toggleMax = () => {
    if (maximized) {
      maximized = false;
      if (savedSize) apply(savedSize.w, savedSize.h);
      else { modal.style.width = defaultStyle.width; modal.style.height = defaultStyle.height; }
    } else {
      const r = modal.getBoundingClientRect();
      savedSize = { w: r.width, h: r.height };
      maximized = true;
      apply(window.innerWidth - 32, window.innerHeight - 32);
    }
    notifyResize();
    return maximized;
  };

  const onWinResize = () => {
    const r = modal.getBoundingClientRect();
    apply(r.width, r.height);
    notifyResize();
  };
  window.addEventListener('resize', onWinResize);

  return () => {
    window.removeEventListener('resize', onWinResize);
    try { delete modal.__toggleMax; } catch (e) { /* 忽略 */ }
  };
}

/** 归一化颜色值：#abc → #aabbcc，非法值返回 '' */
function normalizeHex(v) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim());
  if (!m) return '';
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`;
}

/**
 * 绑定取色字段：预设色 / 系统取色器 / 十六进制输入框三向同步。
 * 选中「自动」时值为 'auto'（由业务侧自行分配），取色器仍显示上次的实色便于微调。
 */
function bindColorField(root, f) {
  const wrap = root.querySelector(`.color-picker[data-color-field="${f.name}"]`);
  if (!wrap) return;
  const hidden = wrap.querySelector('[data-field]');
  const native = wrap.querySelector('.color-native');
  const hex = wrap.querySelector('.color-hex');
  const preview = wrap.querySelector('.color-preview');
  const swatches = [...wrap.querySelectorAll('.color-swatch')];

  let mode = hidden.value === 'auto' ? 'auto' : 'hex';
  let cur = normalizeHex(hidden.value) || normalizeHex(native.value) || '#4f7cff';

  const paint = () => {
    hidden.value = mode === 'auto' ? 'auto' : cur;
    if (native.value !== cur) native.value = cur;
    if (document.activeElement !== hex) hex.value = cur;
    preview.style.background = cur;
    swatches.forEach((s) => {
      const on = s.dataset.val === 'auto' ? mode === 'auto' : (mode === 'hex' && normalizeHex(s.dataset.val) === cur);
      s.classList.toggle('active', on);
      s.setAttribute('aria-pressed', String(on));
    });
  };

  swatches.forEach((s) => s.addEventListener('click', () => {
    if (s.dataset.val === 'auto') { mode = 'auto'; } else { mode = 'hex'; cur = normalizeHex(s.dataset.val) || cur; }
    paint();
  }));
  native.addEventListener('input', () => {
    const v = normalizeHex(native.value);
    if (!v) return;
    mode = 'hex'; cur = v; paint();
  });
  hex.addEventListener('input', () => {
    const v = normalizeHex(hex.value);
    if (!v) return; // 输入到一半（如 "#4f7"）先不动值，失焦时再回退
    mode = 'hex'; cur = v; paint();
  });
  hex.addEventListener('blur', paint); // 非法输入 → 还原为上一个有效色

  paint();
}

/** 字段类型 → HTML 片段 */
function fieldHtml(f) {
  const label = `<label class="field-label" for="mf-${esc(f.name)}">${esc(f.label)}</label>`;
  const attr = `class="modal-input" id="mf-${esc(f.name)}" data-field="${esc(f.name)}"`;
  const span = f.span === 2 ? ' span-2' : ' span-1';
  switch (f.type) {
    case 'password':
      return `${label}<input ${attr} type="password" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" />`;
    case 'select': {
      const opts = (f.options || [])
        .map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(f.value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`)
        .join('');
      return `${label}<select ${attr}>${opts}</select>`;
    }
    case 'choices': {
      const rows = (f.options || []).map((o, i) => `
        <label class="choice" style="--c:${esc(o.color || '#c3cad6')}">
          <input type="radio" name="mf-${esc(f.name)}" value="${esc(o.value)}"${String(o.value) === String(f.value ?? '') || (!f.value && i === 0) ? ' checked' : ''} />
          <span class="choice-dot"></span><span>${esc(o.label)}</span>
        </label>`).join('');
      return `${label}<div class="choice-row">${rows}</div>`;
    }
    case 'color': {
      // 预设色只是快捷入口：真正的取色靠原生 <input type="color">（系统取色器，支持任意颜色
      // 与屏幕吸管）+ 十六进制输入框，两者与预设色三向同步，最终值写进隐藏 input 供 readFields 读取
      const raw = String(f.value ?? '');
      const init = normalizeHex(raw) || normalizeHex(f.fallback) || '#4f7cff';
      const isAuto = raw === 'auto' || (!raw && (f.options || []).some((o) => o.value === 'auto'));
      const swatches = (f.options || []).map((o) => {
        const auto = o.value === 'auto';
        const on = auto ? isAuto : (!isAuto && normalizeHex(o.value) === init.toLowerCase());
        return auto
          ? `<button type="button" class="color-swatch is-auto${on ? ' active' : ''}" data-val="auto" title="由系统自动分配颜色">自动</button>`
          : `<button type="button" class="color-swatch${on ? ' active' : ''}" data-val="${esc(o.value)}"
               style="--c:${esc(o.color || o.value)}" title="${esc(o.label || o.value)}" aria-pressed="${on}"><span></span></button>`;
      }).join('');
      return `${label}
        <div class="color-picker" data-color-field="${esc(f.name)}">
          <div class="color-swatches">${swatches}</div>
          <div class="color-custom">
            <input type="color" class="color-native" value="${esc(init)}" title="打开系统取色器自由取色" aria-label="自由取色" />
            <input type="text" class="color-hex" maxlength="7" spellcheck="false"
                   placeholder="#4f7cff" value="${esc(init)}" aria-label="十六进制颜色值" />
            <span class="color-preview" style="background:${esc(init)}"></span>
          </div>
          <input type="hidden" data-field="${esc(f.name)}" value="${isAuto ? 'auto' : esc(init)}" />
        </div>`;
    }
    default:
      return `${label}<input ${attr} type="text" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" />`;
  }
}

/** 单个字段区块（含跨列与提示） */
function fieldBlock(f) {
  const span = f.span === 2 ? ' span-2' : ' span-1';
  return `<div class="modal-field${span}">${fieldHtml(f)}${f.hint ? `<div class="modal-hint">${esc(f.hint)}</div>` : ''}</div>`;
}

/**
 * 字段 → 栅格 HTML。
 * 带 section 的字段会被收进 <fieldset> 分组卡片；section 名变化即开新卡。
 * 注意：必须先收集好卡片内字段再包容器，不能边遍历边写闭合标签。
 * @param {Array} fields
 * @param {boolean} grid 是否套两栏栅格
 */
function fieldsToHtml(fields, grid) {
  const out = [];
  let loose = ''; // 未归属分区的字段
  let secName = '';
  let secBody = [];

  const flushSection = () => {
    if (!secName) return;
    out.push(
      `<fieldset class="form-section"><legend>${esc(secName)}</legend>`
      + `<div class="form-section-body">${secBody.join('')}</div></fieldset>`,
    );
    secName = '';
    secBody = [];
  };

  for (const f of fields) {
    const sec = f.section || '';
    if (!sec) {
      flushSection();
      loose += fieldBlock(f);
      continue;
    }
    if (sec !== secName) {
      flushSection();
      secName = sec;
    }
    secBody.push(fieldBlock(f));
  }
  flushSection();

  const inner = out.join('') + loose;
  return grid ? `<div class="form-grid">${inner}</div>` : inner;
}

/** 读取表单当前值（choices 取选中的 radio） */
function readFields(root, fields) {
  const values = {};
  for (const f of fields) {
    if (f.type === 'choices') {
      const picked = root.querySelector(`input[name="mf-${f.name}"]:checked`);
      values[f.name] = picked ? picked.value : '';
    } else {
      const el = root.querySelector(`[data-field="${f.name}"]`);
      values[f.name] = el ? el.value : '';
    }
  }
  return values;
}

/**
 * 多字段表单弹窗（分组编辑 / AI 设置等需要一次填多个值的场景）。
 * @param {object} opts
 * @param {string} opts.title
 * @param {Array<{name:string,label:string,type?:'text'|'password'|'select'|'choices'|'color',
 *                value?:any,placeholder?:string,hint?:string,span?:1|2,section?:string,fallback?:string,
 *                options?:Array<{value:string,label:string,color?:string}>}>} opts.fields
 *        type='color'：预设色 + 原生取色器 + 十六进制输入，值为 '#rrggbb' 或 'auto'
 *        span=2 占满整行；section 相同则收进同一张分组卡片
 * @param {boolean} [opts.grid=true] 是否使用两栏栅格（单字段小表单可传 false）
 * @param {string} [opts.okText]
 * @param {number} [opts.width] 弹窗宽度（px），宽度超过视口时会自动收缩
 * @param {Array<{label:string,handler:(values:object)=>Promise<string|void>}>} [opts.extraButtons]
 *        底部左侧的附加操作（如「测试连接」「清除 Key」）；handler 返回字符串表示失败原因
 * @param {(values:object) => Promise<string|void>} opts.onSubmit 返回字符串 = 校验/保存失败
 * @returns {Promise<boolean>} 是否提交成功
 */
export function openFormModal(opts) {
  const {
    title, fields = [], okText = '保存', extraButtons = [], onSubmit, width, grid = true,
  } = opts;

  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal modal-form${grid ? ' is-grid' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"${width ? ` style="width:${esc(String(width))}px"` : ''}>
        <div class="modal-head">${esc(title)}</div>
        <div class="modal-body">
          ${fieldsToHtml(fields, grid)}
          <div class="modal-error" hidden></div>
        </div>
        <div class="modal-foot">
          ${extraButtons.length
    ? `<div class="foot-extra">${extraButtons.map((b) => `<button type="button" class="ghost-btn" data-extra="${esc(b.label)}">${esc(b.label)}</button>`).join('')}</div>`
    : ''}
          <div class="foot-main">
            <button type="button" class="ghost-btn" data-modal="cancel">取消</button>
            <button type="button" class="primary-btn" data-modal="ok">${esc(okText)}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(mask);

    // 字段联动（如选预设后自动填接口地址/模型）：value 变化后回调，回调内部自行改写其它字段
    fields.forEach((f) => {
      if (f.type === 'color') { bindColorField(mask, f); return; }
      if (typeof f.onChange !== 'function') return;
      const el = mask.querySelector(`[data-field="${f.name}"]`);
      if (el) el.addEventListener('change', () => f.onChange(el.value, mask));
    });

    const errEl = mask.querySelector('.modal-error');
    const okBtn = mask.querySelector('[data-modal="ok"]');
    // 只聚焦可输入的文本框：下拉/单选若自动聚焦，Esc 前的误触会改动配置
    const firstInput = mask.querySelector('input.modal-input');
    if (firstInput) { firstInput.focus(); if (firstInput.select && firstInput.type !== 'password') firstInput.select(); }

    let busy = false;
    const showError = (msg) => {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
      mask.querySelector('.modal').classList.toggle('has-error', !!msg);
    };
    const setBusy = (on) => {
      busy = on;
      okBtn.disabled = on;
      mask.querySelectorAll('[data-extra]').forEach((b) => { b.disabled = on; });
    };
    const close = (ok) => {
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      resolve(ok);
    };
    const submit = async () => {
      if (busy) return;
      showError('');
      setBusy(true);
      try {
        const msg = await onSubmit(readFields(mask, fields));
        if (msg) { showError(msg); setBusy(false); return; }
        close(true);
      } catch (e) {
        showError((e && e.message) || '保存失败，请重试');
        setBusy(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); submit(); }
    };

    document.addEventListener('keydown', onKey, true);
    okBtn.addEventListener('click', submit);
    mask.querySelector('[data-modal="cancel"]').addEventListener('click', () => close(false));
    mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });

    extraButtons.forEach((b) => {
      const el = mask.querySelector(`[data-extra="${b.label}"]`);
      if (!el) return;
      el.addEventListener('click', async () => {
        if (busy) return;
        showError('');
        setBusy(true);
        const label = el.textContent;
        el.textContent = '处理中…';
        try {
          const msg = await b.handler(readFields(mask, fields));
          if (msg) showError(msg);
        } catch (e) {
          showError((e && e.message) || '操作失败，请重试');
        }
        el.textContent = label;
        setBusy(false);
      });
    });
  });
}
