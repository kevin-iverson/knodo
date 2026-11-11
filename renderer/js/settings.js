'use strict';
/**
 * 设置中心。
 *
 * 结构：左侧「分组 + 分区」导航，右侧分区内容 —— 对应 WorkBuddy 那种两栏设置窗口。
 *
 * 为什么要重做而不是在旧面板上加几行：旧面板是「一个模态 + 一张列表」，加第二类设置时
 * 只能往下堆，很快就会变成一条长长的滚动条，用户找一个选项得从头翻。分区的成本是一次性的，
 * 之后每加一个设置项只是往对应 pane 的 sections 里加一行。
 *
 * 扩展方式（加一个设置项）：
 *   1) 已有所属分区 → 直接在对应 xxxHtml() 里加 rowHtml({...})；
 *   2) 新分区 → 往 PANES 里加一条 { id, group, label, icon, build, mount }，
 *      build 返回 HTML，mount 里在这个分区容器内做事件委托。
 * 壳层（导航 / 搜索 / 分页切换）不需要任何改动。
 */
import { api } from './api.js';
import { openPanelModal } from './modal.js';
import { keysPaneHtml, mountKeysPane, disposeKeysPane } from './settings-keys.js';
import { openSponsorQr } from './sponsor.js';
import { normalizeConfig } from './encourager-core.js';
import {
  getTheme, setTheme, pickBackdrop, clearBackdrop, resetTheme, previewOpacity,
} from './theme.js';

/** 外观的配色表与算法（theme-core.js 暴露在 window 上，是经典脚本） */
const KT = window.KnodoTheme;

let toast = (msg) => console.warn('[settings]', msg);
/** 需要壳层配合的外部动作（日历偏好改动要重绘日历视图） */
const ext = { onCalendarPrefs: null };

export function setSettingsHandlers({ toast: t, onCalendarPrefs } = {}) {
  if (typeof t === 'function') toast = t;
  if (typeof onCalendarPrefs === 'function') ext.onCalendarPrefs = onCalendarPrefs;
}

/* ------------------------------ 状态 ------------------------------ */

/** 打开面板时一次性读齐，分区渲染只读内存（不再各自发 IPC，避免一开面板十几个请求） */
const S = {
  /** 外观：整份主题对象 { mode, style, backdrop }（主进程是唯一权威，这里只是本次面板的快照） */
  theme: null,
  /** 刚选完图时的文件信息（名称 / 压缩前后体积），只在本次面板里显示 */
  bgInfo: null,
  autoStart: { enabled: false, supported: true, reason: '' },
  version: '',
  storage: null,
  backup: null,
  salary: null,
  ai: null,
  calendar: null,
  encourager: null,
};

/** 当前搜索词（列表重绘后要重跑过滤，所以留在模块级） */
let query = '';
let active = 'general';

/* ------------------------------ 图标 ------------------------------ */

const svg = (d) => `<svg class="st-ico" viewBox="0 0 16 16" width="16" height="16" fill="none"
  stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const ICON = {
  appearance: svg('<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v2M8 11.6v2M2.4 8h2M11.6 8h2"/><circle cx="8" cy="8" r="1.9" fill="currentColor" stroke="none"/>'),
  general: svg('<path d="M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"/><circle cx="6" cy="4.6" r="1.5"/><circle cx="10.2" cy="8" r="1.5"/><circle cx="5.2" cy="11.4" r="1.5"/>'),
  keys: svg('<rect x="1.8" y="4.2" width="12.4" height="7.6" rx="1.6"/><path d="M4.2 6.6h.01M6.4 6.6h.01M8.6 6.6h.01M10.8 6.6h.01M4.6 9.2h6.8"/>'),
  ai: svg('<path d="M8 2.2 9.3 5.7 12.8 7 9.3 8.3 8 11.8 6.7 8.3 3.2 7 6.7 5.7z"/><path d="M12.2 10.8l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>'),
  calendar: svg('<rect x="1.8" y="3" width="12.4" height="11" rx="1.6"/><path d="M1.8 6.2h12.4M5 1.8v2.4M11 1.8v2.4"/>'),
  fun: svg('<circle cx="8" cy="8" r="6"/><path d="M5.6 7h.01M10.4 7h.01M5.8 10.2q2.2 1.6 4.4 0"/>'),
  data: svg('<ellipse cx="8" cy="4" rx="4.6" ry="1.9"/><path d="M3.4 4v8c0 1 2 1.9 4.6 1.9s4.6-.9 4.6-1.9V4"/><path d="M3.4 8c0 1 2 1.9 4.6 1.9S12.6 9 12.6 8"/>'),
  about: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7.4v3.8M8 5.4h.01"/>'),
};

/* ------------------------------ 行 / 控件构造器 ------------------------------ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 一行设置：左标题 + 副说明，右侧控件。
 * `search` 是额外的搜索同义词（如「深色」之于「界面主题」），标题与说明本身已自动入索引。
 */
function rowHtml({ title, desc = '', ctl = '', search = '', id = '' }) {
  const key = `${title} ${desc} ${search}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return `<div class="st-row" data-search="${esc(key)}"${id ? ` data-item="${esc(id)}"` : ''}>
    <div class="st-row-main">
      <div class="st-row-title">${title}</div>
      ${desc ? `<div class="st-row-desc">${desc}</div>` : ''}
    </div>
    <div class="st-row-ctl">${ctl}</div>
  </div>`;
}

/** 一个分区：标题 + 说明 + 卡片（没有 title 时就是裸卡片，与 WorkBuddy 首屏一致） */
function sectionHtml({ title = '', desc = '', rows = [], html = '' } = {}) {
  const body = html || rows.join('');
  if (!body) return '';
  return `<section class="st-sec">
    ${title ? `<div class="st-sec-title">${title}</div>` : ''}
    ${desc ? `<div class="st-sec-desc">${desc}</div>` : ''}
    <div class="st-card">${body}</div>
  </section>`;
}

const ctlSelect = (id, value, options) => `<span class="st-select"><select id="${esc(id)}">${
  options.map(([v, label]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(label)}</option>`).join('')
}</select></span>`;

const ctlSwitch = (id, on, disabled = false) => `<label class="st-switch${disabled ? ' is-disabled' : ''}">
  <input type="checkbox" id="${esc(id)}"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}>
  <span class="st-switch-track"><span class="st-switch-dot"></span></span>
</label>`;

const ctlInput = (id, value, { type = 'text', placeholder = '', wide = false } = {}) =>
  `<input class="st-input${wide ? ' is-wide' : ''}" id="${esc(id)}" type="${esc(type)}" value="${esc(value)}"
    placeholder="${esc(placeholder)}" spellcheck="false">`;

const ctlButton = (act, label, kind = '') =>
  `<button type="button" class="st-btn${kind ? ` ${kind}` : ''}" data-act="${esc(act)}">${label}</button>`;

const ctlInfo = (text, { mono = true } = {}) =>
  `<span class="st-info${mono ? ' is-mono' : ''}" title="${esc(text)}">${esc(text)}</span>`;

/* ------------------------------ 分区：外观 ------------------------------ */

/**
 * 外观 = 模式 × 风格 × 背景三层，三件事分开管（设计方案 · 三维模型）。
 *
 * 交互铁律：点卡即生效、没有「保存」按钮。每次改动都先落库再重绘，
 * 失败就把界面退回主进程那份真值 —— 不做「本地草稿 + 确认」，否则关掉设置面板
 * 会出现「面板里是樱粉、主界面还是雾灰」。
 *
 * 搜索：每个 section 自己带 data-search（applyFilter 认这个属性），
 * 这样外壳的搜索框不用为外观分区做任何特殊处理。
 */

// 注意：这个公共前缀会被拼进每一节，别往里放「背景 / 透明度」这种专属于某一节的关键词，
// 否则搜「透明度」三节都会亮（外壳的过滤是按 data-search 字面包含做的）
const APPEARANCE_SEARCH = '外观 主题 配色 皮肤 自定义 appearance';

function styleCardsHtml(mode) {
  const cur = KT.normalize(S.theme).style;
  return KT.ORDER.map((id) => {
    const s = KT.STYLES[id];
    const t = s[mode] || s.light;
    const vars = `--c-bg:${t.bg};--c-panel:${t['bg-panel']};--c-side:${t['bg-sidebar']};--c-text:${t.text};--c-border:${t.border};--c-primary:${t.primary}`;
    return `<button type="button" class="ap-card${id === cur ? ' is-on' : ''}" data-style="${id}"
      role="radio" aria-checked="${id === cur}" title="${esc(s.name)}（${esc(s.en)}）">
      <span class="ap-thumb" style="${vars}">
        <span class="ap-thumb-side"><i class="is-on"></i><i></i><i></i><i></i></span>
        <span class="ap-thumb-main">
          <span class="ap-thumb-row"><b></b><i></i></span>
          <span class="ap-thumb-row"><b></b><i></i></span>
          <span class="ap-thumb-cta"></span>
        </span>
      </span>
      <span class="ap-card-name">${esc(s.name)}<span class="ap-card-en">${esc(s.en)}</span></span>
      <span class="ap-card-check" aria-hidden="true">✓</span>
    </button>`;
  }).join('');
}

function bgThumbHtml(r) {
  if (!r.url) {
    return '<div class="ap-bg-empty"><span class="ap-bg-plus">＋</span><span>未设置背景图</span></div>';
  }
  return `<div class="ap-bg-pic" style="background-image:url(&quot;${esc(r.url)}&quot;)"></div>`;
}

function appearanceHtml() {
  const t = KT.normalize(S.theme);
  const r = KT.resolve(t);
  const bd = t.backdrop;
  const locked = r.style === 'contrast';
  return `
  <div class="ap-top">
    <div class="ap-top-text">配色只换色相与质感，圆角、间距、字号不动；背景与面板透明度互不影响文字</div>
    <button type="button" class="ap-reset" data-act="reset">恢复默认</button>
  </div>

  <section class="st-sec" data-search="${APPEARANCE_SEARCH} 明暗 模式 深色 浅色 暗色 跟随系统 mode 夜间 白天">
    <div class="st-sec-title">明暗模式<span class="ap-hint">与系统同步，窗口标题栏一起变</span></div>
    <div class="st-card ap-card-body">
      <div class="ap-seg" data-seg="mode" role="radiogroup" aria-label="明暗模式">
        ${[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, label]) =>
    `<button type="button" data-mode="${v}" role="radio" aria-checked="${t.mode === v}"
            class="${t.mode === v ? 'is-on' : ''}">${label}</button>`).join('')}
      </div>
    </div>
  </section>

  <section class="st-sec" data-search="${APPEARANCE_SEARCH} 风格 雾灰 石墨 苔绿 宣纸 樱粉 高对比 style 夜间盯屏 护眼 笔记">
    <div class="st-sec-title">风格<span class="ap-hint">六套气质，随时可换</span></div>
    <div class="st-card ap-card-body">
      <div class="ap-styles" data-grid="styles" data-mode="${r.mode}" role="radiogroup" aria-label="风格">${styleCardsHtml(r.mode)}</div>
    </div>
  </section>

  <section class="st-sec" data-search="${APPEARANCE_SEARCH} 背景图 壁纸 上传 更换 移除 透明度 填充 模糊 毛玻璃 backdrop image">
    <div class="st-sec-title">背景图<span class="ap-hint">JPG / PNG / WebP，自动压缩至长边 2560</span></div>
    <div class="st-card ap-card-body">

    <div class="ap-bg">
      <div class="ap-bg-thumb" data-role="thumb">${bgThumbHtml(r)}</div>
      <div class="ap-bg-actions">
        <button type="button" class="st-btn is-accent" data-act="pick">${bd.image ? '更换图片' : '选择图片'}</button>
        <button type="button" class="st-btn" data-act="clear"${bd.image ? '' : ' disabled'}>移除</button>
        <div class="ap-bg-note" data-role="bgnote">${bgNoteText(r)}</div>
      </div>
    </div>

    <div class="ap-slider-row${locked ? ' is-locked' : ''}">
      <span class="ap-slider-lab">背景透明度</span>
      <input type="range" id="ap-opacity" min="0" max="100" step="5" value="${r.opacity}"
             aria-label="背景透明度"${locked || !r.hasImage ? ' disabled' : ''}>
      <span class="ap-slider-val" data-role="opval">${r.opacity}%</span>
    </div>
    <div class="ap-scale"><span>0 隐藏</span><span>60 默认</span><span>100 完全呈现</span></div>
    <div class="ap-note" data-role="alphanote">${alphaNote(r)}</div>
    <div class="ap-guard" data-role="guard"${r.guardPct > 0 ? '' : ' hidden'}>
      <span>ⓘ</span>
      <span>当前组合下正文对比度接近下限，已自动把面板加深 <b>${r.guardPct}%</b>；调低透明度即可恢复。</span>
    </div>

    <div class="ap-adv-row">
      <span class="ap-adv-lab">填充方式</span>
      <div class="ap-seg ap-seg-sm" data-seg="fit">
        ${[['cover', '铺满'], ['contain', '完整'], ['repeat', '平铺']].map(([v, label]) =>
    `<button type="button" data-fit="${v}" class="${bd.fit === v ? 'is-on' : ''}">${label}</button>`).join('')}
      </div>
      <span class="ap-adv-hint">铺满会裁掉边缘，完整保留整张图</span>
    </div>

    <div class="ap-adv">
      <div class="ap-adv-title">高级</div>
      <div class="ap-adv-row">
        <span class="ap-adv-lab">图片模糊</span>
        <div class="ap-seg ap-seg-sm" data-seg="blur">
          ${[0, 8, 16].map((v) =>
    `<button type="button" data-blur="${v}" class="${Number(bd.blur) === v ? 'is-on' : ''}">${v === 0 ? '关' : v + 'px'}</button>`).join('')}
        </div>
        <span class="ap-adv-hint">模糊只作用在背景层，大图建议 8px</span>
      </div>
      <div class="ap-adv-row">
        <span class="ap-adv-lab">面板毛玻璃</span>
        ${ctlSwitch('ap-glass', bd.glass !== false && r.style !== 'contrast', r.style === 'contrast')}
        <span class="ap-adv-hint">${r.style === 'contrast' ? '高对比风格强制关闭' : '关闭后滚动更省 GPU'}</span>
      </div>
      <div class="ap-adv-row">
        <span class="ap-adv-lab">面板浓度</span>
        <span class="ap-adv-hint">跟随风格自动补偿（单滑块模式，不单独暴露）</span>
      </div>
    </div>
    </div>
  </section>`;
}

function bgNoteText(r) {
  if (!r.hasImage && !r.missing) return '未设置背景图：面板保持不透明';
  if (r.missing) return '⚠ 原文件已丢失，请重新选择';
  // 只显示文件尾段，太长会把这一行撑爆
  const name = String(S.bgInfo && S.bgInfo.name ? S.bgInfo.name : r.url.split('/').pop() || '');
  return `当前：${esc(name)}`;
}

function alphaNote(r) {
  if (!r.hasImage) return '设置背景图后，面板不透明度会随透明度自动补偿，保证正文可读。';
  return `面板不透明度自动补偿为 <b>${r.alpha.toFixed(2)}</b> —— 图片越明显，面板同步变实，保证正文可读。`;
}

/** 只刷新动态文案与选中态，不重建 DOM（拖滑块时重建会闪、还会丢焦点） */
function refreshAppearance(pane) {
  if (!pane) return;
  const t = KT.normalize(S.theme);
  const r = KT.resolve(t);
  const bd = t.backdrop;

  pane.querySelectorAll('[data-seg="mode"] button').forEach((b) => {
    const on = b.dataset.mode === t.mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  });
  const grid = pane.querySelector('[data-grid="styles"]');
  if (grid) {
    const mode = r.mode;
    if (grid.dataset.mode !== mode) {
      // 深浅色变了要换一套缩略图（浅版 / 深版），否则卡片和实际配色对不上
      grid.dataset.mode = mode;
      grid.innerHTML = styleCardsHtml(mode);
    } else {
      grid.querySelectorAll('.ap-card').forEach((c) => {
        const on = c.dataset.style === t.style;
        c.classList.toggle('is-on', on);
        c.setAttribute('aria-checked', String(on));
      });
    }
  }

  const thumb = pane.querySelector('[data-role="thumb"]');
  if (thumb) thumb.innerHTML = bgThumbHtml(r);
  const note = pane.querySelector('[data-role="bgnote"]');
  if (note) note.textContent = bgNoteText(r);
  const pickBtn = pane.querySelector('[data-act="pick"]');
  if (pickBtn) pickBtn.textContent = bd.image ? '更换图片' : '选择图片';
  const clearBtn = pane.querySelector('[data-act="clear"]');
  if (clearBtn) clearBtn.disabled = !bd.image;

  const slider = pane.querySelector('#ap-opacity');
  const locked = t.style === 'contrast';
  if (slider) {
    slider.value = String(r.opacity);
    slider.disabled = locked || !r.hasImage;
  }
  const row = pane.querySelector('.ap-slider-row');
  if (row) row.classList.toggle('is-locked', locked);
  const opval = pane.querySelector('[data-role="opval"]');
  if (opval) opval.textContent = `${r.opacity}%`;
  const an = pane.querySelector('[data-role="alphanote"]');
  if (an) an.innerHTML = alphaNote(r);
  const guard = pane.querySelector('[data-role="guard"]');
  if (guard) {
    guard.hidden = !(r.guardPct > 0);
    const b = guard.querySelector('b');
    if (b) b.textContent = `${r.guardPct}%`;
  }

  pane.querySelectorAll('[data-seg="fit"] button').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.fit === bd.fit);
  });
  pane.querySelectorAll('[data-seg="blur"] button').forEach((b) => {
    b.classList.toggle('is-on', Number(b.dataset.blur) === Number(bd.blur));
  });
  const glass = pane.querySelector('#ap-glass');
  if (glass) {
    glass.checked = bd.glass !== false && t.style !== 'contrast';
    glass.disabled = t.style === 'contrast';
  }
}

function mountAppearance(pane) {
  // 每次操作都走同一条路：乐观应用 → 落库 → 用主进程返回值校准界面
  const commit = async (patch) => {
    try {
      const next = await setTheme(patch);
      S.theme = next;
      refreshAppearance(pane);
      return next;
    } catch (e) {
      S.theme = getTheme();
      refreshAppearance(pane);
      toast(`外观设置保存失败：${(e && e.message) || e}`);
      return null;
    }
  };

  pane.addEventListener('click', async (e) => {
    const modeBtn = e.target.closest('[data-seg="mode"] button');
    if (modeBtn) { await commit({ mode: modeBtn.dataset.mode }); return; }

    const card = e.target.closest('.ap-card');
    if (card) { await commit({ style: card.dataset.style }); return; }

    const fitBtn = e.target.closest('[data-seg="fit"] button');
    if (fitBtn) { await commit({ backdrop: { fit: fitBtn.dataset.fit } }); return; }

    const blurBtn = e.target.closest('[data-seg="blur"] button');
    if (blurBtn) { await commit({ backdrop: { blur: Number(blurBtn.dataset.blur) } }); return; }

    const act = e.target.closest('[data-act]');
    if (!act) return;
    const name = act.dataset.act;
    if (name === 'reset') {
      try {
        S.theme = await resetTheme();
        S.bgInfo = null;
        refreshAppearance(pane);
        toast('已恢复默认外观');
      } catch (err) {
        toast(`恢复默认失败：${(err && err.message) || err}`);
      }
      return;
    }
    if (name === 'pick') {
      act.disabled = true;
      try {
        const r = await pickBackdrop();
        if (r && r.ok) {
          S.theme = getTheme();
          S.bgInfo = r.info || null;
          const kb = r.info ? `${r.info.outKB} KB` : '';
          toast(r.info ? `背景图已更新（${kb}）` : '背景图已更新');
        } else if (r && r.reason && r.reason !== 'cancel') {
          toast(r.reason);
        }
      } catch (err) {
        toast(`选择背景图失败：${(err && err.message) || err}`);
      } finally {
        act.disabled = false;
        refreshAppearance(pane);
      }
      return;
    }
    if (name === 'clear') {
      try {
        S.theme = await clearBackdrop();
        S.bgInfo = null;
        refreshAppearance(pane);
        toast('已移除背景图');
      } catch (err) {
        toast(`移除失败：${(err && err.message) || err}`);
      }
    }
  });

  // 键盘：方向键在风格卡之间移动并应用（3 列布局，← → 走一格、↑ ↓ 走一行），
  // Enter / Space 由 button 原生触发 click，不用再管
  pane.querySelector('[data-grid="styles"]')?.addEventListener('keydown', async (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    const cards = [...pane.querySelectorAll('.ap-card')];
    if (!cards.length) return;
    const cur = cards.findIndex((c) => c.classList.contains('is-on'));
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
    const next = Math.min(cards.length - 1, Math.max(0, (cur < 0 ? 0 : cur) + step));
    e.preventDefault();
    cards[next].focus();
    if (cards[next].classList.contains('is-on')) return;
    await commit({ style: cards[next].dataset.style });
    // commit 会重绘卡片（深浅色变了才重绘，一般只是换 class），焦点要补回来
    pane.querySelector(`.ap-card[data-style="${cards[next].dataset.style}"]`)?.focus();
  });

  // 滑块：拖动只改 CSS 变量（即时预览、不写库），松手才落库 —— 否则拖一下就写一次库
  const slider = pane.querySelector('#ap-opacity');
  slider?.addEventListener('input', () => {
    const v = Number(slider.value);
    const r = previewOpacity(v);
    const opval = pane.querySelector('[data-role="opval"]');
    if (opval) opval.textContent = `${v}%`;
    const an = pane.querySelector('[data-role="alphanote"]');
    if (an) an.innerHTML = alphaNote(r);
    const guard = pane.querySelector('[data-role="guard"]');
    if (guard) guard.hidden = !(r.guardPct > 0);
  });
  slider?.addEventListener('change', async () => {
    await commit({ backdrop: { opacity: Number(slider.value) } });
  });

  pane.querySelector('#ap-glass')?.addEventListener('change', (e) => {
    commit({ backdrop: { glass: e.target.checked } });
  });
}

/* ------------------------------ 分区：通用 ------------------------------ */

function generalHtml() {
  const auto = S.autoStart || {};
  const supported = auto.supported !== false;
  // 「界面主题」不在这里了：模式 × 风格 × 背景统一收进置顶的「外观」分区。
  // 两个入口写同一个 settings 键只会让用户以为改了一个还有另一个没改。
  return [
    sectionHtml({
      title: '启动',
      rows: [
        rowHtml({
          title: '开机自启动',
          desc: supported ? '登录系统后在后台驻留托盘，不弹主窗口' : (auto.reason || '当前环境不支持开机自启动'),
          ctl: ctlSwitch('st-autostart', !!auto.enabled, !supported),
          search: '启动项 登录时启动 自启 startup',
          id: 'autostart',
        }),
      ],
    }),
  ].join('');
}

function mountGeneral(pane) {
  const autoSw = pane.querySelector('#st-autostart');
  autoSw?.addEventListener('change', async (e) => {
    const want = e.target.checked;
    e.target.disabled = true;
    try {
      const r = await api.app.setAutoStart(want);
      if (!r || !r.ok) {
        e.target.checked = !want;
        toast((r && r.reason) || '开机自启动设置失败');
        return;
      }
      S.autoStart = { ...S.autoStart, enabled: !!r.enabled, supported: true };
      e.target.checked = !!r.enabled;
      toast(r.enabled ? '已开启开机自启动' : '已关闭开机自启动');
    } catch (err) {
      e.target.checked = !want;
      toast(`设置失败：${(err && err.message) || err}`);
    } finally {
      e.target.disabled = false;
    }
  });
}

/* ------------------------------ 分区：AI 与语音 ------------------------------ */

function presetValueOf(presets, url, model) {
  if (!url) return '';
  const exact = (presets || []).find((p) => p.baseUrl === url && p.model === model);
  if (exact) return exact.id;
  const loose = (presets || []).find((p) => p.baseUrl === url);
  return loose ? loose.id : '';
}

const keyStateText = (o) => (o && o.hasKey
  ? (o.encryptionDegraded ? 'Key 已保存（非加密降级）' : 'Key 已保存（本地加密）')
  : 'Key 未配置');

function aiHtml() {
  const c = S.ai || {};
  const asr = c.asr || {};
  const presets = c.presets || [];
  const asrPresets = asr.presets || [];

  return [
    sectionHtml({
      title: '对话模型',
      desc: '用于 AI 日报 / 周报、笔记问答与会议纪要；不配置时报告降级为本地模板。',
      rows: [
        rowHtml({
          title: '接口预设',
          desc: '选中后自动填好地址与模型，也可以手动改',
          ctl: ctlSelect('st-ai-preset', presetValueOf(presets, c.baseUrl, c.model),
            [['', '自定义']].concat(presets.map((p) => [p.id, p.label]))),
          search: 'deepseek openai 接口 服务商 preset',
        }),
        rowHtml({
          title: '模型',
          ctl: ctlInput('st-ai-model', c.model || '', { placeholder: 'deepseek-chat', wide: true }),
          search: 'model',
        }),
        rowHtml({
          title: '接口地址',
          ctl: ctlInput('st-ai-baseurl', c.baseUrl || '', { placeholder: 'https://api.deepseek.com', wide: true }),
          search: 'base url 端点 地址',
        }),
        rowHtml({
          title: 'API Key',
          desc: keyStateText(c),
          ctl: ctlInput('st-ai-key', '', { type: 'password', placeholder: c.hasKey ? '已保存，留空则不变' : '输入 API Key', wide: true }),
          search: '密钥 token 秘钥 key',
        }),
        rowHtml({
          title: '连接测试',
          desc: '用当前配置发一次最小请求，确认地址 / 模型 / Key 都可用',
          ctl: ctlButton('test-ai', '测试连接'),
          search: '连通 检测 ping 测试 test',
        }),
      ],
    }),
    sectionHtml({
      title: '语音转写',
      desc: '用于会议纪要与录音转写；不配置时录音仍可保存，但不会自动转文字。',
      rows: [
        rowHtml({
          title: '语音接口预设',
          ctl: ctlSelect('st-asr-preset', presetValueOf(asrPresets, asr.baseUrl, asr.model),
            [['', '自定义']].concat(asrPresets.map((p) => [p.id, p.label]))),
          search: 'whisper asr 语音',
        }),
        rowHtml({ title: '语音模型', ctl: ctlInput('st-asr-model', asr.model || '', { placeholder: 'whisper-1', wide: true }), search: 'model' }),
        rowHtml({
          title: '语音接口地址',
          ctl: ctlInput('st-asr-baseurl', asr.baseUrl || '', { placeholder: 'https://api.openai.com/v1', wide: true }),
          search: 'base url',
        }),
        rowHtml({
          title: '语音 API Key',
          desc: keyStateText(asr),
          ctl: ctlInput('st-asr-key', '', { type: 'password', placeholder: asr.hasKey ? '已保存，留空则不变' : '输入 API Key', wide: true }),
          search: '密钥 token',
        }),
      ],
    }),
    `<div class="st-foot-note">Key 只在保存时写进本地数据库（加密存储），不会随导出 / 同步带出去。</div>`,
  ].join('');
}

async function saveAi(pane) {
  const val = (sel) => (pane.querySelector(sel)?.value || '').trim();
  const payload = {
    baseUrl: val('#st-ai-baseurl'),
    model: val('#st-ai-model'),
    asrBaseUrl: val('#st-asr-baseurl'),
    asrModel: val('#st-asr-model'),
  };
  const key = val('#st-ai-key');
  const asrKey = val('#st-asr-key');
  if (key) payload.apiKey = key;       // 留空 = 保持原 Key 不变（主进程侧语义）
  if (asrKey) payload.asrKey = asrKey;

  const r = await api.ai.saveConfig(payload);
  S.ai = r;
  const keyInput = pane.querySelector('#st-ai-key');
  if (keyInput) {
    keyInput.value = '';
    keyInput.placeholder = r.hasKey ? '已保存，留空则不变' : '输入 API Key';
  }
  const asrKeyInput = pane.querySelector('#st-asr-key');
  if (asrKeyInput) {
    asrKeyInput.value = '';
    asrKeyInput.placeholder = (r.asr && r.asr.hasKey) ? '已保存，留空则不变' : '输入 API Key';
  }
  // 状态文案就地更新，不整体重绘（重绘会丢焦点，用户可能正往里打字）
  pane.querySelectorAll('.st-row').forEach((row) => {
    const title = row.querySelector('.st-row-title')?.textContent || '';
    const desc = row.querySelector('.st-row-desc');
    if (!desc) return;
    if (title === 'API Key') desc.textContent = keyStateText(r);
    if (title === '语音 API Key') desc.textContent = keyStateText(r.asr);
  });
  toast('AI 配置已保存');
}

function mountAi(pane) {
  const bindPreset = (sel, urlId, modelId, presets) => {
    pane.querySelector(sel)?.addEventListener('change', (e) => {
      const p = (presets || []).find((x) => x.id === e.target.value);
      if (!p) return;
      pane.querySelector(urlId).value = p.baseUrl;
      pane.querySelector(modelId).value = p.model;
      saveAi(pane).catch((err) => toast(`保存失败：${(err && err.message) || err}`));
    });
  };
  bindPreset('#st-ai-preset', '#st-ai-baseurl', '#st-ai-model', (S.ai || {}).presets);
  bindPreset('#st-asr-preset', '#st-asr-baseurl', '#st-asr-model', ((S.ai || {}).asr || {}).presets);

  // 文本类字段失焦 / 回车提交：WorkBuddy 的设置项没有「保存」按钮，改完即生效
  ['#st-ai-model', '#st-ai-baseurl', '#st-ai-key', '#st-asr-model', '#st-asr-baseurl', '#st-asr-key']
    .forEach((sel) => {
      const el = pane.querySelector(sel);
      if (!el) return;
      el.addEventListener('change', () => {
        saveAi(pane).catch((err) => toast(`保存失败：${(err && err.message) || err}`));
      });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    });

  // 连接测试：结果就地写在说明行里，不弹窗打断（失败原因通常是「Key 错了 / 地址多了斜杠」这种短句）
  pane.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="test-ai"]');
    if (!btn) return;
    const desc = btn.closest('.st-row')?.querySelector('.st-row-desc');
    btn.disabled = true;
    if (desc) desc.textContent = '正在测试…';
    try {
      const r = await api.ai.test({
        baseUrl: (pane.querySelector('#st-ai-baseurl')?.value || '').trim(),
        model: (pane.querySelector('#st-ai-model')?.value || '').trim(),
      });
      if (desc) desc.textContent = r && r.ok ? `连接成功：${r.message || '模型响应正常'}` : `连接失败：${(r && r.message) || '未知错误'}`;
    } catch (err) {
      if (desc) desc.textContent = `连接失败：${(err && err.message) || err}`;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ------------------------------ 分区：日历 ------------------------------ */

function calendarHtml() {
  const cal = S.calendar || {};
  return [
    sectionHtml({
      title: '日历视图',
      desc: '格子显示的是「负载」：按优先级加权，默认容量 6 相当于一天能扛 6 个中等任务。',
      rows: [
        rowHtml({
          title: '每日容量',
          desc: '4 – 10 之间可调，超载只在 ≥100% 变色',
          ctl: ctlInput('st-cal-capacity', String(cal.capacity ?? 6), { type: 'number', placeholder: '6' }),
          search: '负载 容量 权重 calendar',
        }),
        rowHtml({
          title: '每周起始日',
          ctl: ctlSelect('st-cal-weekstart', String(cal.weekStart ?? 1), [['1', '周一'], ['0', '周日']]),
          search: '周视图 星期 calendar',
        }),
        rowHtml({
          title: '隐藏已完成任务',
          desc: '默认显示：完成的任务留在当天格子里，只是不计入负载',
          ctl: ctlSwitch('st-cal-hidedone', !!cal.hideCompleted),
          search: '完成态 calendar',
        }),
      ],
    }),
    `<div class="st-foot-note">点侧栏「今天」下面的「🗓 日历」，或按 Ctrl + Alt + M 打开日历；月 / 周在日历里切换。这里的改动会立刻重绘当前日历。</div>`,
  ].join('');
}

function mountCalendar(pane) {
  // 与日历视图内的「调整每日容量」弹窗同源：都写 tool.calendar，改完立刻通知日历重绘
  const saveCal = async () => {
    const cap = Math.max(4, Math.min(10, Number(pane.querySelector('#st-cal-capacity')?.value) || 6));
    const next = {
      ...(S.calendar || {}),
      capacity: cap,
      weekStart: Number(pane.querySelector('#st-cal-weekstart')?.value ?? 1) ? 1 : 0,
      hideCompleted: !!pane.querySelector('#st-cal-hidedone')?.checked,
    };
    delete next.showCompleted;   // 旧反向字段，别让它继续留在配置里
    try {
      await api.ui.setToolPref('calendar', next);
      S.calendar = next;
      if (ext.onCalendarPrefs) ext.onCalendarPrefs(next);
      toast('日历设置已保存');
    } catch (e) {
      toast(`保存失败：${(e && e.message) || e}`);
    }
  };
  ['#st-cal-capacity', '#st-cal-weekstart', '#st-cal-hidedone'].forEach((sel) => {
    const el = pane.querySelector(sel);
    if (el) el.addEventListener('change', () => saveCal());
  });
}

/** 薪资输入（趣味功能分区）：写完 tool.salary 后让已打开的主浮窗重算，不动牛马币 */
function bindSalaryInputs(pane) {
  let timer = null;
  // silent：边打字边保存时不要每次弹提示（输入 5 位数字会弹 5 次），失焦那一次才给反馈
  const save = (silent) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const monthly = Number(pane.querySelector('#st-salary-monthly')?.value) || 0;
      const start = pane.querySelector('#st-salary-start')?.value || '';
      const end = pane.querySelector('#st-salary-end')?.value || '';
      try {
        S.salary = await api.ui.setSalary({ monthly, start, end });
        document.dispatchEvent(new CustomEvent('app:encourager-config'));
        if (!silent) toast('薪资设置已保存');
      } catch (e) {
        toast(`保存失败：${(e && e.message) || e}`);
      }
    }, 450);
  };
  ['#st-salary-monthly', '#st-salary-start', '#st-salary-end'].forEach((sel) => {
    const el = pane.querySelector(sel);
    if (!el) return;
    el.addEventListener('input', () => save(true));
    el.addEventListener('change', () => save(false));
  });
}

/* ------------------------------ 分区：趣味功能（上班鼓励器） ------------------------------ */

function funHtml() {
  const c = normalizeConfig(S.encourager);
  const s = S.salary || {};
  const buys = Object.entries(c.purchases).slice(0, 3);
  return [
    sectionHtml({
      title: '薪资与班次',
      desc: '按「月薪 ÷ 当月工作日 ÷ 每日工时」换算，只统计上班到下班区间内的在岗时间。填一次，进账数字立刻生效；上班鼓励器浮窗右上角的 ⚙ 或「设置」页签改的也是这三项。',
      rows: [
        rowHtml({
          title: '月薪',
          ctl: `${ctlInput('st-salary-monthly', s.monthly ? String(s.monthly) : '', { type: 'number', placeholder: '0' })}<span class="st-unit">元</span>`,
          search: '工资 收入 salary 月薪',
        }),
        rowHtml({
          title: '上班时间',
          ctl: ctlInput('st-salary-start', s.start || '', { type: 'time' }),
          search: '考勤 打卡 开始 班次',
        }),
        rowHtml({
          title: '下班时间',
          ctl: ctlInput('st-salary-end', s.end || '', { type: 'time' }),
          search: '考勤 打卡 结束 班次',
        }),
      ],
    }),
    sectionHtml({
      title: '工位搭子',
      desc: '搭子说话的方式；完成一个任务时会按这个语气冒一句。',
      rows: [
        rowHtml({
          title: '默认语气',
          ctl: ctlSelect('st-enc-tone', c.buddy.tone, [['warm', '暖心'], ['salty', '阴阳'], ['sharp', '毒舌']]),
          search: '语气 搭子 台词 暖心 阴阳 毒舌',
        }),
      ],
    }),
    sectionHtml({
      title: '牛马币与隐私',
      desc: '牛马币只换皮肤、不换钱，与真实金额在刷新节奏、数值形态、颜色与区块上完全分离。',
      rows: [
        rowHtml({
          title: '显示牛马币',
          desc: '关闭后隐藏 HUD 格子与发币提示，不清空已有币值',
          ctl: ctlSwitch('st-enc-coins', c.coinsEnabled),
          search: '牛马币 玩法货币 coins',
        }),
        rowHtml({
          title: '分享卡默认显示真实金额',
          desc: '默认关闭；即使在卡片页临时开启，导出前仍会二次确认',
          ctl: ctlSwitch('st-enc-share-amount', c.privacy.shareAmount),
          search: '分享卡 金额 隐私',
        }),
        rowHtml({
          title: '分享卡默认包含任务标题',
          desc: '默认关闭；开启后仍需逐条勾选，导出前二次确认',
          ctl: ctlSwitch('st-enc-share-titles', c.share.includeTaskTitles),
          search: '分享卡 任务标题 隐私',
        }),
      ],
    }),
    sectionHtml({
      title: '购买力换算',
      desc: '把「今日已赚」换算成生活里的东西。单价是虚构演示值，不是真实物价。',
      rows: buys.map(([name, price], i) => rowHtml({
        title: name,
        ctl: `${ctlInput(`st-enc-buy-${i}`, String(price), { type: 'number' })}<span class="st-unit">元</span>`,
        search: `购买力 单价 ${name}`,
        id: `enc-buy-${i}`,
      })),
    }),
    `<div class="st-foot-note">主浮窗：Ctrl + Alt + E 或菜单「趣味功能 → 上班鼓励器」；月薪与班次也能直接在主浮窗的「设置」页签里改。<br>主题跟随应用明暗，唯一入口在「通用 → 界面主题」，这里不另设开关。<br>牛马币与连续打卡是情绪数据，会被整体备份 / 恢复回滚，不参与导入校验，请不要当成资产；解锁项仅存本机，换设备或重装不继承。</div>`,
  ].join('');
}

function mountFun(pane) {
  // 每次保存前重读最新配置，只改自己负责的字段：
  // 否则会把主浮窗刚发的牛马币 / 打卡记录覆盖成打开面板时的旧快照。
  const saveEnc = async (mutate) => {
    try {
      const latest = normalizeConfig(await api.ui.getToolPref('encourager'));
      mutate(latest);
      await api.ui.setToolPref('encourager', latest);
      S.encourager = latest;
      document.dispatchEvent(new CustomEvent('app:encourager-config'));
      toast('趣味功能设置已保存');
    } catch (e) {
      toast(`保存失败：${(e && e.message) || e}`);
    }
  };
  const bindChange = (sel, mutate) => {
    const el = pane.querySelector(sel);
    if (el) el.addEventListener('change', () => saveEnc((c) => mutate(c, pane)));
  };
  bindChange('#st-enc-tone', (c, p) => { c.buddy.tone = p.querySelector('#st-enc-tone').value; });
  bindChange('#st-enc-coins', (c, p) => { c.coinsEnabled = !!p.querySelector('#st-enc-coins').checked; });
  bindChange('#st-enc-share-amount', (c, p) => { c.privacy.shareAmount = !!p.querySelector('#st-enc-share-amount').checked; });
  bindChange('#st-enc-share-titles', (c, p) => { c.share.includeTaskTitles = !!p.querySelector('#st-enc-share-titles').checked; });
  [0, 1, 2].forEach((i) => {
    bindChange(`#st-enc-buy-${i}`, (c, p) => {
      const key = Object.keys(c.purchases)[i];
      const v = Number(p.querySelector(`#st-enc-buy-${i}`).value);
      if (key && v > 0) c.purchases[key] = v;
    });
  });
  bindSalaryInputs(pane);
}

/* ------------------------------ 分区：数据与备份 ------------------------------ */

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ms) {
  const t = Number(ms);
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 长路径单独占一行（右侧放按钮行得通，但路径会被挤成两行说明，看着很乱） */
const pathLine = (text) => `<span class="st-path" title="${esc(text || '')}">${esc(text || '未知')}</span>`;

function dataHtml() {
  const st = S.storage || {};
  const bk = S.backup || {};
  const lastText = bk.latest
    ? `最近一次 ${fmtTime(bk.latest.time)} · 共 ${bk.count} 份 · ${fmtBytes(bk.totalBytes)}`
    : '还没有自动备份（应用启动 5 分钟后会做第一次）';
  const srcText = st.source === 'fallback'
    ? '配置的目录当前不可用，本次临时使用默认目录'
    : st.isCustom ? '自定义目录' : '默认目录（在系统用户数据目录下）';

  return [
    sectionHtml({
      title: '存储位置',
      rows: [
        rowHtml({
          title: '数据目录',
          desc: `<span class="st-sub">${esc(srcText)}</span>${pathLine(st.dir)}`,
          ctl: `${ctlButton('open-data', '打开')}${ctlButton('change-dir', '更改…')}`,
          search: '路径 数据库 todo.db 附件 位置 path',
          id: 'data-dir',
        }),
      ],
    }),
    sectionHtml({
      title: '备份',
      rows: [
        rowHtml({
          title: '自动备份',
          desc: `<span class="st-sub">${esc(lastText)}</span>${pathLine(bk.dir)}`,
          ctl: `${ctlButton('open-backup', '打开')}${ctlButton('backup-dialog', '备份与恢复…')}`,
          search: '快照 snapshot 恢复 还原 backup',
          id: 'backup',
        }),
      ],
    }),
    `<div class="st-foot-note">备份包含数据库与附件清单；保留策略为最近 ${bk.dailyDays || 7} 天每日一份、另有 ${bk.weeklyCount || 4} 份周度快照。恢复会用快照覆盖当前库，操作前会二次确认。</div>`,
  ].join('');
}

function mountData(pane) {
  pane.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'open-data' || act === 'open-backup') {
        const r = await api.env.openPath(act === 'open-data' ? 'data' : 'backup');
        if (r && !r.ok) toast(r.reason || '无法打开目录');
      } else if (act === 'change-dir') {
        await api.app.openStorageDialog();
      } else if (act === 'backup-dialog') {
        await api.app.openBackupDialog();
      }
    } catch (err) {
      toast(`操作失败：${(err && err.message) || err}`);
    }
  });
}

/* ------------------------------ 分区：关于 ------------------------------ */

/** 爱发电主页。留空时「支持」入口整块不渲染，避免出现点了没反应的死链接。 */
const SPONSOR_URL = '';

function aboutHtml() {
  const st = S.storage || {};
  const bk = S.backup || {};
  // 支持分区：赞赏码始终在；爱发电等 SPONSOR_URL 填了才多一行，避免出现打不开的按钮
  const sponsorRows = [];
  if (SPONSOR_URL) {
    sponsorRows.push(rowHtml({
      title: '爱发电',
      desc: '按月或单次赞助都可以。捐赠只用于覆盖 Windows 代码签名证书——不签的话，安装时会弹“未知发布者”警告。',
      ctl: ctlButton('sponsor', '去支持'),
      search: '捐赠 赞助 打赏 支持 donate sponsor 爱发电 afdian',
    }));
  }
  sponsorRows.push(rowHtml({
    title: '微信赞赏码',
    desc: '扫码金额随意。不捐也完全不影响使用。',
    ctl: ctlButton('qr', '扫码支持', 'is-accent'),
    search: '捐赠 赞助 打赏 支持 donate sponsor 微信 赞赏 收款码 二维码 qr',
  }));
  const sponsor = sectionHtml({ title: '支持 Knodo', rows: sponsorRows });
  return [
    sectionHtml({
      rows: [
        rowHtml({ title: '版本', ctl: ctlInfo(S.version ? `Knodo ${S.version}` : '未知', { mono: false }), search: 'version 版本号' }),
        rowHtml({
          title: '检查更新',
          desc: '从 Gitee 发布页查询最新版本；只提示，不自动下载或改动本机数据。',
          ctl: ctlButton('check-update', '检查更新…'),
          search: 'update 更新 升级 版本 检查更新 新版本',
        }),
        rowHtml({ title: '开源许可', ctl: ctlInfo('MIT', { mono: false }), search: 'license 协议' }),
        rowHtml({ title: '数据目录', desc: pathLine(st.dir), search: '路径' }),
        rowHtml({ title: '备份目录', desc: pathLine(bk.dir), search: '路径 snapshot' }),
      ],
    }),
    sponsor,
    `<div class="st-foot-note">所有任务、笔记与附件都保存在本机数据目录，不上传服务器；AI 功能只在你主动触发时把必要内容发给你配置的接口。</div>`,
  ].join('');
}

function mountAbout(pane) {
  pane.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    try {
      if (btn.dataset.act === 'sponsor' && SPONSOR_URL) {
        const r = await api.app.openExternal(SPONSOR_URL);
        if (r && !r.ok) toast(r.reason || '无法打开链接');
      } else if (btn.dataset.act === 'check-update') {
        await api.app.checkUpdate();
      } else if (btn.dataset.act === 'qr') {
        openSponsorQr();
      }
    } catch (err) {
      toast(`操作失败：${(err && err.message) || err}`);
    }
  });
}

/* ------------------------------ 分区注册表 ------------------------------ */

const GROUPS = [
  { id: 'base', label: '设置' },
  { id: 'feature', label: '功能' },
  { id: 'data', label: '数据与安全' },
];

/**
 * 分区清单。新增一个分区只加一条：
 *   { id, group, label, icon, build: () => html, mount?: (paneEl) => void }
 * build 在打开面板时同步执行（只读内存里的 S），mount 在 DOM 插入后调用。
 */
const PANES = [
  // 外观置顶：换主题是最常做、也最容易找不到的一件事（原来藏在「通用」里一个下拉框）
  { id: 'appearance', group: 'base', label: '外观', icon: ICON.appearance, build: appearanceHtml, mount: mountAppearance },
  { id: 'general', group: 'base', label: '通用', icon: ICON.general, build: generalHtml, mount: mountGeneral },
  { id: 'keys', group: 'base', label: '快捷键', icon: ICON.keys, build: keysPaneHtml, mount: null },
  { id: 'ai', group: 'feature', label: 'AI 与语音', icon: ICON.ai, build: aiHtml, mount: mountAi },
  { id: 'calendar', group: 'feature', label: '日历', icon: ICON.calendar, build: calendarHtml, mount: mountCalendar },
  { id: 'fun', group: 'feature', label: '趣味功能', icon: ICON.fun, build: funHtml, mount: mountFun },
  { id: 'data', group: 'data', label: '数据与备份', icon: ICON.data, build: dataHtml, mount: mountData },
  { id: 'about', group: 'data', label: '关于', icon: ICON.about, build: aboutHtml, mount: mountAbout },
];

const PANE_IDS = PANES.map((p) => p.id);

/* ------------------------------ 壳层 ------------------------------ */

function navHtml() {
  return GROUPS.map((g) => {
    const items = PANES.filter((p) => p.group === g.id);
    if (!items.length) return '';
    return `<div class="st-group">
      <div class="st-group-label">${g.label}</div>
      ${items.map((p) => `<button type="button" class="st-nav-item" data-nav="${p.id}">
        ${p.icon}<span class="st-nav-text">${p.label}</span>
      </button>`).join('')}
    </div>`;
  }).join('');
}

function shellHtml() {
  return `<div class="st-shell">
    <aside class="st-nav">
      <label class="st-search">
        ${svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.4 13.4"/>')}
        <input id="st-search" type="search" placeholder="搜索设置项" autocomplete="off" spellcheck="false">
      </label>
      <div class="st-nav-scroll">${navHtml()}</div>
    </aside>
    <section class="st-content" id="st-content">
      ${PANES.map((p) => `<div class="st-pane" data-pane="${p.id}"${p.id === active ? '' : ' hidden'}>
        <div class="st-page-title">${p.label}</div>
        ${p.build()}
      </div>`).join('')}
      <div class="st-empty" hidden>没有找到匹配的设置项</div>
    </section>
  </div>`;
}

function paintActive(root, id) {
  active = id;
  root.querySelectorAll('.st-pane').forEach((el) => { el.hidden = el.dataset.pane !== id; });
  root.querySelectorAll('.st-nav-item').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.nav === id);
  });
  const box = root.querySelector('#st-content');
  if (box) box.scrollTop = 0;
  try { localStorage.setItem('settings-pane', id); } catch (e) { /* 隐私模式：不记忆 */ }
}

/**
 * 搜索：直接按行过滤（不另建一份结果列表）。
 * 行是唯一的「设置项」载体，隐藏掉不匹配的即可；分区整节被滤空时连标题一起收起。
 */
function applyFilter(root) {
  if (!root) return;
  const needle = query.trim().toLowerCase();
  const hits = new Map();
  PANES.forEach((p) => {
    const paneEl = root.querySelector(`.st-pane[data-pane="${p.id}"]`);
    if (!paneEl) return;
    let visible = 0;
    paneEl.querySelectorAll('[data-search]').forEach((el) => {
      const hit = !needle || el.dataset.search.includes(needle);
      el.hidden = !hit;
      if (hit) visible++;
    });
    paneEl.querySelectorAll('.st-sec').forEach((sec) => {
      // 有些分区的整节就是一条「设置项」（外观：明暗 / 风格 / 背景），
      // data-search 挂在 .st-sec 自己身上 —— 这时它的显隐已由上一段决定，
      // 这里再按「节内没有行」重算会把刚藏起来的节又放出来。
      if (sec.hasAttribute('data-search')) return;
      const rows = sec.querySelectorAll('[data-search]');
      sec.hidden = !!needle && rows.length > 0 && [...rows].every((r) => r.hidden);
    });
    // 脚注跟着搜索走：搜索时收起，避免「明明没结果却还挂着一段说明」的错觉
    paneEl.querySelectorAll('.st-foot-note').forEach((el) => { el.hidden = !!needle; });
    hits.set(p.id, visible);
  });

  root.querySelectorAll('.st-nav-item').forEach((el) => {
    const n = hits.get(el.dataset.nav) || 0;
    el.classList.toggle('is-dim', !!needle && n === 0);
  });

  const total = [...hits.values()].reduce((a, b) => a + b, 0);
  const empty = root.querySelector('.st-empty');
  if (empty) empty.hidden = !needle || total > 0;

  // 当前分区被搜空 → 自动跳到第一个有结果的分区（否则用户会以为「没有结果」）
  if (needle && !(hits.get(active) > 0)) {
    const first = PANES.find((p) => (hits.get(p.id) || 0) > 0);
    if (first) paintActive(root, first.id);
  }
}

/* ------------------------------ 数据 ------------------------------ */

async function loadState() {
  const soft = async (p, fb) => { try { return await p; } catch (e) { return fb; } };
  const [themeRaw, autoStart, version, storage, backup, salary, ai, calendar, encourager] = await Promise.all([
    soft(api.theme.get(), null),
    soft(api.app.getAutoStart(), { enabled: false, supported: false, reason: '读取开机自启动状态失败' }),
    soft(api.app.getVersion(), ''),
    soft(api.env.getStorageInfo(), null),
    soft(api.env.getBackupInfo(), null),
    soft(api.ui.getSalary(), null),
    soft(api.ai.getConfig(), null),
    soft(api.ui.getToolPref('calendar'), null),
    soft(api.ui.getToolPref('encourager'), null),
  ]);
  Object.assign(S, {
    // 老库 / 读取失败时回落出厂值，界面永远有东西可渲染
    theme: KT.normalize(themeRaw),
    autoStart, version, storage, backup, salary, ai, calendar, encourager,
  });
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * 打开设置中心。
 * @param {string} [paneId] 直接落到某个分区（如 'ai'：菜单「AI 设置」改走这里）
 */
export async function openSettings(paneId = '') {
  if (document.querySelector('.modal-settings')) return;
  try {
    await loadState();
  } catch (e) {
    toast(`读取设置失败：${(e && e.message) || e}`);
    return;
  }

  const remembered = (() => {
    try { return localStorage.getItem('settings-pane') || ''; } catch (e) { return ''; }
  })();
  active = PANE_IDS.includes(paneId) ? paneId
    : PANE_IDS.includes(remembered) ? remembered : 'general';
  query = '';

  await openPanelModal({
    title: '设置',
    className: 'modal-settings',
    html: shellHtml(),
    showClose: true,
    resizable: true,
    resizeKey: 'settings-v2',
    minWidth: 760,
    minHeight: 520,
    escGuard: (mask) => {
      // 搜索框里按 Esc：先清关键词，一下就把窗口关掉太容易误触
      const input = mask.querySelector('#st-search');
      if (!input || document.activeElement !== input || !input.value) return false;
      input.value = '';
      query = '';
      applyFilter(mask.querySelector('.st-shell'));
      return true;
    },
    onMount: (mask) => {
      const root = mask.querySelector('.st-shell');
      paintActive(root, active);

      // 导航
      root.querySelector('.st-nav').addEventListener('click', (e) => {
        const item = e.target.closest('.st-nav-item');
        if (!item) return;
        paintActive(root, item.dataset.nav);
        if (query) {
          query = '';
          const s = root.querySelector('#st-search');
          if (s) s.value = '';
          applyFilter(root);
        }
      });

      // 搜索（80ms 防抖：边打边过滤，又不阻塞输入）
      const search = root.querySelector('#st-search');
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { query = search.value; applyFilter(root); }, 80);
      });

      // 各分区自己的事件
      PANES.forEach((p) => {
        const paneEl = root.querySelector(`.st-pane[data-pane="${p.id}"]`);
        if (!paneEl) return;
        if (p.id === 'keys') {
          // 快捷键列表异步载入，载入完要重跑一次过滤（重绘会丢掉 hidden 状态）
          mountKeysPane(paneEl, { toast, onChange: () => applyFilter(root) });
          return;
        }
        if (typeof p.mount === 'function') {
          try { p.mount(paneEl); } catch (e) { console.error('[settings] 分区事件绑定失败：', p.id, e); }
        }
      });

      applyFilter(root);
    },
    onClose: () => {
      disposeKeysPane();
    },
  });
}
