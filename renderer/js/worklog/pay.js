'use strict';
/**
 * 工时记薪 · 时间价值（FR-01 / FR-05 / FR-06）。
 *
 * 边界（方案 §一）：回答「我的时间值多少钱」，不回答「我该拿多少工资」。
 * 全模块只用「估算」措辞，不出现「薪酬 / 应发 / 实发」，也绝不在计时器旁跳钱。
 *
 * 本文件只做两件事：金额格式化 + 费率设置弹窗。价值视图的排版在 view.js，
 * 这样金额口径只有 store.payRows 一个出口，格式化只有这里一个出口。
 *
 * 为什么费率弹窗不用 openFormModal：它的 hint 是纯文本（esc 后不可交互），
 * 做不出「历史费率倒序列表 + 每行删除 + 删最后一条二次确认 + 点击回填修改」。
 * 于是用一段专用 DOM，但完整复用 modal 的 class，视觉与系统弹窗一致。
 */
import { api } from '../api.js';
import { t as tr } from '../i18n.js';
import { esc, dateKey } from './shared.js';

/** 分 → ¥1,234.50（整数分，展示时才除 100，避免浮点尾巴） */
export function money(cents) {
  const neg = Number(cents) < 0;
  const c = Math.abs(Math.round(Number(cents) || 0));
  const int = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const dec = String(c % 100).padStart(2, '0');
  return `${neg ? '-' : ''}¥${int}.${dec}`;
}

/** 费率分 → 元文本（去掉无意义的 .00，如 ¥80/h） */
export function rateText(cents) {
  const c = Math.round(Number(cents) || 0);
  const yuan = Math.floor(c / 100);
  const frac = c % 100;
  return `¥${frac ? `${yuan}.${String(frac).padStart(2, '0')}` : yuan}/h`;
}

/**
 * 打开「时薪设置」弹窗。返回 true = 费率有变动（调用方据此刷新价值视图）。
 * @param {() => void} [onChanged] 费率增删改成功后的回调
 */
export async function openRateModal(onChanged) {
  let rates = [];
  try {
    rates = (await api.worklog.rates()) || [];
  } catch (e) {
    rates = [];
  }

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal modal-form pay-rate-modal" role="dialog" aria-modal="true" aria-label="${tr('时薪设置')}" style="width:460px">
      <div class="modal-head">${tr('时薪设置')}</div>
      <div class="modal-body pay-body">
        <p class="pay-tip">${tr('给时间估个值，不是工资条。按生效日计价，改价不会改写历史记录。')}</p>
        <div class="form-grid">
          <div class="modal-field span-1">
            <label>${tr('时薪（元 / 小时）')}</label>
            <input class="modal-input" type="text" inputmode="decimal" data-f="yuan" placeholder="80.00" autocomplete="off" />
          </div>
          <div class="modal-field span-1">
            <label>${tr('生效日')}</label>
            <input class="modal-input" type="date" data-f="date" value="${dateKey(new Date())}" />
          </div>
          <div class="modal-field span-2">
            <label>${tr('备注')} <span class="pay-optional">${tr('可选')}</span></label>
            <input class="modal-input" type="text" data-f="note" placeholder="${tr('例如：涨薪后 / A 客户报价')}" autocomplete="off" />
          </div>
        </div>
        <div class="pay-history" data-pay-history></div>
        <div class="modal-error" hidden></div>
      </div>
      <div class="modal-foot">
        <div class="foot-main">
          <button type="button" class="ghost-btn" data-pay-cancel>${tr('取消')}</button>
          <button type="button" class="primary-btn" data-pay-ok>${tr('保存')}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const errEl = mask.querySelector('.modal-error');
  const listEl = mask.querySelector('[data-pay-history]');
  const yuanEl = mask.querySelector('[data-f="yuan"]');
  const dateEl = mask.querySelector('[data-f="date"]');
  const noteEl = mask.querySelector('[data-f="note"]');
  const okBtn = mask.querySelector('[data-pay-ok]');
  let changed = false;
  let busy = false;

  const showError = (msg) => {
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  };
  const setBusy = (on) => {
    busy = on;
    okBtn.disabled = on;
    mask.querySelectorAll('button').forEach((b) => { if (b !== okBtn) b.disabled = on; });
  };

  const paintHistory = () => {
    if (!rates.length) {
      listEl.innerHTML = `<div class="pay-hist-empty">${tr('还没有费率。填好上面的时薪并保存，就能开始估算。')}</div>`;
      return;
    }
    const total = (r) => Math.round(Number(r.rate_cents) || 0);
    listEl.innerHTML = `
      <div class="pay-hist-head">${tr('历史费率')} <span>${tr('按生效日倒序 · 点击回填修改')}</span></div>
      <div class="pay-hist-list">
        ${rates.map((r) => `<div class="pay-hist-row" data-day="${esc(r.effective_from)}">
          <button type="button" class="pay-hist-edit" data-act="edit">
            <span class="pay-hist-day">${esc(r.effective_from)}</span>
            <span class="pay-hist-rate">${rateText(total(r))}</span>
            <span class="pay-hist-note">${r.note ? esc(r.note) : '—'}</span>
          </button>
          <button type="button" class="pay-hist-del" data-act="del" title="${tr('删除这条费率')}">✕</button>
        </div>`).join('')}
      </div>`;
  };

  const reload = async () => {
    try {
      rates = (await api.worklog.rates()) || [];
    } catch (e) { /* 保留上次读数 */ }
    paintHistory();
  };

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    mask.remove();
    if (changed && typeof onChanged === 'function') onChanged();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); save(); }
  };

  const save = async () => {
    if (busy) return;
    showError('');
    const raw = String(yuanEl.value || '').trim();
    const yuan = Number(raw);
    if (!raw || !Number.isFinite(yuan) || yuan <= 0) { showError(tr('时薪必须大于 0，且为数字')); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEl.value || '')) { showError(tr('请选择生效日')); return; }
    setBusy(true);
    try {
      await api.worklog.rateSet({
        rateCents: Math.round(yuan * 100),
        effectiveFrom: dateEl.value,
        note: String(noteEl.value || '').trim(),
      });
      changed = true;
      yuanEl.value = '';
      noteEl.value = '';
      await reload();
      showError('');
    } catch (e) {
      showError((e && e.message) || tr('保存失败，请重试'));
    } finally {
      setBusy(false);
    }
  };

  // 事件委托：回填 / 删除（删最后一条走「再点一次」内联二次确认，不叠第二个弹窗）
  listEl.addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-act="edit"]');
    if (edit && !busy) {
      const r = rates.find((x) => x.effective_from === edit.closest('[data-day]').dataset.day);
      if (!r) return;
      const c = Math.round(Number(r.rate_cents) || 0);
      yuanEl.value = String(c / 100);
      dateEl.value = r.effective_from;
      noteEl.value = r.note || '';
      yuanEl.focus();
      yuanEl.select();
      return;
    }
    const del = e.target.closest('[data-act="del"]');
    if (del && !busy) {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = rates.length <= 1 ? tr('最后的费率？') : tr('再点删除');
        del.classList.add('is-confirm');
        setTimeout(() => {
          if (del.isConnected) { delete del.dataset.confirm; del.textContent = '✕'; del.classList.remove('is-confirm'); }
        }, 3000);
        return;
      }
      const day = del.closest('[data-day]').dataset.day;
      setBusy(true);
      try {
        const r = rates.find((x) => x.effective_from === day);
        if (r) await api.worklog.rateDelete(r.id);
        changed = true;
        await reload();
      } catch (err) {
        showError((err && err.message) || tr('删除失败'));
      } finally {
        setBusy(false);
      }
    }
  });

  mask.querySelector('[data-pay-ok]').addEventListener('click', save);
  mask.querySelector('[data-pay-cancel]').addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', onKey, true);

  paintHistory();
  yuanEl.focus();
}
