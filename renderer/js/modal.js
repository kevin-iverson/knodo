'use strict';
/**
 * 轻量模态框：用于替代原生 prompt()，支持输入校验、错误提示、Enter 提交 / Esc 关闭。
 *
 * 为什么不直接用 prompt()：Electron 的 window.prompt 在部分版本不弹窗而直接返回 null，
 * 且无法就地展示"重名""保存失败"等原因——用户看到的就是"点了 ＋ 没反应"。
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
