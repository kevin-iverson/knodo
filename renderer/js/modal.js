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
 * @returns {Promise<boolean>} 是否以“确认”关闭
 */
export function openPanelModal({
  title, html = '', className = '', onMount, okText = '关闭',
  extraButtons = [], onSubmit,
}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal modal-panel${className ? ` ${esc(className)}` : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">${esc(title)}</div>
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
    const close = (ok) => {
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
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
    mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });

    extraButtons.forEach((b) => {
      const el = mask.querySelector(`[data-extra="${b.label}"]`);
      if (!el) return;
      el.addEventListener('click', async () => {
        showError('');
        try {
          const msg = await b.handler(mask);
          if (msg) showError(msg);
        } catch (e) {
          showError((e && e.message) || '操作失败，请重试');
        }
      });
    });

    if (typeof onMount === 'function') onMount(mask, () => close(false));
  });
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
 * @param {Array<{name:string,label:string,type?:'text'|'password'|'select'|'choices',
 *                value?:any,placeholder?:string,hint?:string,span?:1|2,section?:string,
 *                options?:Array<{value:string,label:string,color?:string}>}>} opts.fields
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
