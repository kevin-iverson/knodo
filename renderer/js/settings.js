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
// t 别名成 tr：本文件多处用 `const t` 表示主题对象，直接叫 t 会被局部变量遮蔽
import { t as tr, getLocale as getLocaleNow, LOCALE_LABELS } from './i18n.js';
import {
  getTheme, setTheme, pickBackdrop, clearBackdrop, resetTheme, previewOpacity,
} from './theme.js';

/** 外观的配色表与算法（theme-core.js 暴露在 window 上，是经典脚本） */
const KT = window.KnodoTheme;

let toast = (msg) => console.warn('[settings]', msg);
/** 需要壳层配合的外部动作（日历偏好改动要重绘日历视图 / 日期形态切换要重绘编辑器） */
const ext = { onCalendarPrefs: null, onAction: null, onPlanDateModeChange: null };

export function setSettingsHandlers({ toast: t, onCalendarPrefs, onAction, onPlanDateModeChange } = {}) {
  if (typeof t === 'function') toast = t;
  if (typeof onCalendarPrefs === 'function') ext.onCalendarPrefs = onCalendarPrefs;
  if (typeof onAction === 'function') ext.onAction = onAction;
  if (typeof onPlanDateModeChange === 'function') ext.onPlanDateModeChange = onPlanDateModeChange;
}

/**
 * 设置中心里「打开某个浮窗 / 执行某个维护动作」的统一出口。
 * 这些动作原本只挂在应用菜单上（文本对比、JSON 查看器、重复事项、鼓励器、归档、
 * 导入 Markdown），菜单栏撤掉后由 ui.js 的 runMenuAction() 承接，具体实现仍留在各模块。
 * 没有注入实现时明确提示，不静默失败。
 */
function runAction(name, payload) {
  if (!ext.onAction) {
    toast(tr('该功能暂时不可用（动作入口未注册）'));
    return;
  }
  try {
    ext.onAction(name, payload);
  } catch (e) {
    toast(tr('操作失败：{msg}', { msg: (e && e.message) || e }));
  }
}

/* ------------------------------ 状态 ------------------------------ */

/** 打开面板时一次性读齐，分区渲染只读内存（不再各自发 IPC，避免一开面板十几个请求） */
const S = {
  /** 外观：整份主题对象 { mode, style, backdrop }（主进程是唯一权威，这里只是本次面板的快照） */
  theme: null,
  /** 刚选完图时的文件信息（名称 / 压缩前后体积），只在本次面板里显示 */
  bgInfo: null,
  autoStart: { enabled: false, supported: true, reason: '' },
  /** 计划模式：{ rangeMode:boolean }，默认 true = 起止日期段（见 tool.taskDate） */
  taskDate: null,
  /** 界面语言（主进程 settings.locale，值域 zh-CN / en） */
  locale: 'zh-CN',
  version: '',
  storage: null,
  backup: null,
  salary: null,
  ai: null,
  calendar: null,
  encourager: null,
  /** 功能插件：工时开关（{ enabled, zenDefaultSec, dayAttr }） */
  worklog: null,
  /** 功能插件：工位搭子开关（{ enabled }），默认关闭 */
  buddy: null,
  /** 功能插件：四象日记开关（{ enabled, cellLabels:[4] }），默认关闭 */
  journal: null,
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
  tools: svg('<path d="M9.6 2.6 6.2 6l1.8 1.8 3.4-3.4a2 2 0 0 0-2.8-2.8z"/><path d="M6.2 6 3 9.2a1.6 1.6 0 0 0 0 2.3l1.5 1.5a1.6 1.6 0 0 0 2.3 0L10 9.8"/><path d="M2.6 13.4l1.6-1.6"/>'),
  data: svg('<ellipse cx="8" cy="4" rx="4.6" ry="1.9"/><path d="M3.4 4v8c0 1 2 1.9 4.6 1.9s4.6-.9 4.6-1.9V4"/><path d="M3.4 8c0 1 2 1.9 4.6 1.9S12.6 9 12.6 8"/>'),
  about: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7.4v3.8M8 5.4h.01"/>'),
  plugins: svg('<circle cx="8" cy="8.8" r="4.6"/><path d="M8 6.6v2.4l1.6 1"/><path d="M6.4 1.8h3.2M12.4 2.6l.9-.9"/>'),
  // 摊开的书：两条书页 + 中缝，16px 下能认出「文档」
  docs: svg('<path d="M2.4 3.4h4a1.6 1.6 0 0 1 1.6 1.6v7.6a1.6 1.6 0 0 0-1.6-1.6H2.4z"/><path d="M13.6 3.4h-4A1.6 1.6 0 0 0 8 5v7.6a1.6 1.6 0 0 1 1.6-1.6h4z"/>'),
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
    // 风格名是产品名（雾灰 / 故宫…），英文态从词典取；en 副标题与译名常常撞车（Mist / MIST），撞了就不重复显示
    const name = tr(s.name);
    const en = String(name).toLowerCase() === String(s.en).toLowerCase() ? '' : `<span class="ap-card-en">${esc(s.en)}</span>`;
    return `<button type="button" class="ap-card${id === cur ? ' is-on' : ''}" data-style="${id}"
      role="radio" aria-checked="${id === cur}" title="${esc(name)} · ${esc(s.en)}">
      <span class="ap-thumb" style="${vars}">
        <span class="ap-thumb-side"><i class="is-on"></i><i></i><i></i><i></i></span>
        <span class="ap-thumb-main">
          <span class="ap-thumb-row"><b></b><i></i></span>
          <span class="ap-thumb-row"><b></b><i></i></span>
          <span class="ap-thumb-cta"></span>
        </span>
      </span>
      <span class="ap-card-name">${esc(name)}${en}</span>
      <span class="ap-card-check" aria-hidden="true">✓</span>
    </button>`;
  }).join('');
}

function bgThumbHtml(r) {
  if (!r.url) {
    return `<div class="ap-bg-empty"><span class="ap-bg-plus">＋</span><span>${tr('未设置背景图')}</span></div>`;
  }
  return `<div class="ap-bg-pic" style="background-image:url(&quot;${esc(r.url)}&quot;)"></div>`;
}

function appearanceHtml() {
  const t = KT.normalize(S.theme);
  const r = KT.resolve(t);
  const bd = t.backdrop;
  const locked = r.style === 'contrast';
  const dwOp = t.desktop.opacity;
  return `
  <div class="ap-top">
    <div class="ap-top-text">${tr("配色只换色相与质感，圆角、间距、字号不动；背景与面板透明度互不影响文字")}</div>
    <button type="button" class="ap-reset" data-act="reset">${tr("恢复默认")}</button>
  </div>

  <section class="st-sec" data-search="${APPEARANCE_SEARCH} 明暗 模式 深色 浅色 暗色 跟随系统 mode 夜间 白天">
    <div class="st-sec-title">${tr("明暗模式")}<span class="ap-hint">${tr("与系统同步，窗口标题栏一起变")}</span></div>
    <div class="st-card ap-card-body">
      <div class="ap-seg" data-seg="mode" role="radiogroup" aria-label="${tr("明暗模式")}">
        ${[['system', tr('跟随系统')], ['light', tr('浅色')], ['dark', tr('深色')]].map(([v, label]) =>
    `<button type="button" data-mode="${v}" role="radio" aria-checked="${t.mode === v}"
            class="${t.mode === v ? 'is-on' : ''}">${label}</button>`).join('')}
      </div>
    </div>
  </section>

  <section class="st-sec" data-search="${APPEARANCE_SEARCH} 风格 雾灰 石墨 苔绿 宣纸 樱粉 故宫 宫殿 脊兽 高对比 style 夜间盯屏 护眼 笔记">
    <div class="st-sec-title">${tr("风格")}<span class="ap-hint">${tr("七套气质，随时可换")}</span></div>
    <div class="st-card ap-card-body">
      <div class="ap-styles" data-grid="styles" data-mode="${r.mode}" role="radiogroup" aria-label="${tr("风格")}">${styleCardsHtml(r.mode)}</div>
      ${r.style === 'palace' ? `<div class="ap-palace-note">${tr('故宫风格会在窗口底部陈列太和殿的十一尊脊兽：悬停或点击任意一尊，可查看来历与寓意。切到其他风格时檐口会自动收起。')}</div>` : ''}
    </div>
  </section>

  <section class="st-sec" data-search="${APPEARANCE_SEARCH} 背景图 壁纸 上传 更换 移除 透明度 填充 模糊 毛玻璃 backdrop image">
    <div class="st-sec-title">${tr("背景图")}<span class="ap-hint">${tr("JPG / PNG / WebP，自动压缩至长边 2560")}</span></div>
    <div class="st-card ap-card-body">

    <div class="ap-bg">
      <div class="ap-bg-thumb" data-role="thumb">${bgThumbHtml(r)}</div>
      <div class="ap-bg-actions">
        <button type="button" class="st-btn is-accent" data-act="pick">${bd.image ? tr('更换图片') : tr('选择图片')}</button>
        <button type="button" class="st-btn" data-act="clear"${bd.image ? '' : ' disabled'}>${tr('移除')}</button>
        <div class="ap-bg-note" data-role="bgnote">${bgNoteText(r)}</div>
      </div>
    </div>

    <div class="ap-slider-row${locked ? ' is-locked' : ''}">
      <span class="ap-slider-lab">${tr("背景透明度")}</span>
      <input type="range" id="ap-opacity" min="0" max="100" step="5" value="${r.opacity}"
             aria-label="${tr("背景透明度")}"${locked || !r.hasImage ? ' disabled' : ''}>
      <span class="ap-slider-val" data-role="opval">${r.opacity}%</span>
    </div>
    <div class="ap-scale"><span>${tr("0 隐藏")}</span><span>${tr("60 默认")}</span><span>${tr("100 完全呈现")}</span></div>
    <div class="ap-note" data-role="alphanote">${alphaNote(r)}</div>
    <div class="ap-guard" data-role="guard"${r.guardPct > 0 ? '' : ' hidden'}>
      <span>ⓘ</span>
      <span>${tr('当前组合下正文对比度接近下限，已自动把面板加深 {pct}%；调低透明度即可恢复。', { pct: `<b>${r.guardPct}%</b>` })}</span>
    </div>

    <div class="ap-adv-row">
      <span class="ap-adv-lab">${tr("填充方式")}</span>
      <div class="ap-seg ap-seg-sm" data-seg="fit">
        ${[['cover', tr('铺满')], ['contain', tr('完整')], ['repeat', tr('平铺')]].map(([v, label]) =>
    `<button type="button" data-fit="${v}" class="${bd.fit === v ? 'is-on' : ''}">${label}</button>`).join('')}
      </div>
      <span class="ap-adv-hint">${tr("铺满会裁掉边缘，完整保留整张图")}</span>
    </div>

    <div class="ap-adv">
      <div class="ap-adv-title">${tr("高级")}</div>
      <div class="ap-adv-row">
        <span class="ap-adv-lab">${tr("图片模糊")}</span>
        <div class="ap-seg ap-seg-sm" data-seg="blur">
          ${[0, 8, 16].map((v) =>
    `<button type="button" data-blur="${v}" class="${Number(bd.blur) === v ? 'is-on' : ''}">${v === 0 ? tr('关') : v + 'px'}</button>`).join('')}
        </div>
        <span class="ap-adv-hint">${tr("模糊只作用在背景层，大图建议 8px")}</span>
      </div>
      <div class="ap-adv-row">
        <span class="ap-adv-lab">${tr("面板毛玻璃")}</span>
        ${ctlSwitch('ap-glass', bd.glass !== false && r.style !== 'contrast', r.style === 'contrast')}
        <span class="ap-adv-hint">${r.style === 'contrast' ? tr('高对比风格强制关闭') : tr('关闭后滚动更省 GPU')}</span>
      </div>
      <div class="ap-adv-row">
        <span class="ap-adv-lab">${tr("面板浓度")}</span>
        <span class="ap-adv-hint">${tr("跟随风格自动补偿（单滑块模式，不单独暴露）")}</span>
      </div>
    </div>
    </div>
  </section>

  <section class="st-sec" data-search="${APPEARANCE_SEARCH} 桌面浮窗 贴纸 便签 钉图 不透明度 透明 浓度 dock desktop sticky">
    <div class="st-sec-title">${tr("桌面浮窗")}<span class="ap-hint">${tr("钉到桌面的清单 / 便签（贴图纸）")}</span></div>
    <div class="st-card ap-card-body">
      <div class="ap-slider-row">
        <span class="ap-slider-lab">${tr("不透明度")}</span>
        <input type="range" id="ap-dw-opacity" min="55" max="100" step="5" value="${dwOp}"
               aria-label="${tr("桌面浮窗不透明度")}">
        <span class="ap-slider-val" data-role="dwval">${dwOp}%</span>
      </div>
      <div class="ap-scale"><span>${tr("55 通透")}</span><span>${tr("100 实心")}</span></div>
      <div class="ap-note">${tr('浮窗底色跟随当前风格（现在是 {style}），只有材质浓淡可调；已钉的浮窗改完立即生效。', { style: `<b>${esc(tr(KT.STYLES[t.style].name))}</b>` })}</div>
    </div>
  </section>`;
}

function bgNoteText(r) {
  if (!r.hasImage && !r.missing) return tr('未设置背景图：面板保持不透明');
  if (r.missing) return tr('⚠ 原文件已丢失，请重新选择');
  // 只显示文件尾段，太长会把这一行撑爆
  const name = String(S.bgInfo && S.bgInfo.name ? S.bgInfo.name : r.url.split('/').pop() || '');
  return tr('当前：{name}', { name: esc(name) });
}

function alphaNote(r) {
  if (!r.hasImage) return tr('设置背景图后，面板不透明度会随透明度自动补偿，保证正文可读。');
  return tr('面板不透明度自动补偿为 <b>{alpha}</b> —— 图片越明显，面板同步变实，保证正文可读。', { alpha: r.alpha.toFixed(2) });
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
  if (pickBtn) pickBtn.textContent = bd.image ? tr('更换图片') : tr('选择图片');
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

  // 桌面浮窗不透明度：只在本分区重绘时校准，浮动窗口由主进程广播更新
  const dw = pane.querySelector('#ap-dw-opacity');
  if (dw) dw.value = String(t.desktop.opacity);
  const dwval = pane.querySelector('[data-role="dwval"]');
  if (dwval) dwval.textContent = `${t.desktop.opacity}%`;
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
      toast(tr('外观设置保存失败：{msg}', { msg: (e && e.message) || e }));
      return null;
    }
  };

  // 标题栏的「日 / 月 盘」与系统深浅色变化也能改 mode：面板开着时必须跟着回显，
  // 否则会出现「面板上写着浅色、界面已经是深色」。事件从 document 派发，所以挂 document；
  // 面板关掉后自己摘掉，避免每开一次面板就留一个闭包。
  const onThemeChanged = () => {
    if (!pane.isConnected) {
      document.removeEventListener('app:theme-changed', onThemeChanged);
      return;
    }
    S.theme = getTheme();
    refreshAppearance(pane);
  };
  document.addEventListener('app:theme-changed', onThemeChanged);

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
        toast(tr('已恢复默认外观'));
      } catch (err) {
        toast(tr('恢复默认失败：{msg}', { msg: (err && err.message) || err }));
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
          toast(r.info ? tr('背景图已更新（{kb}）', { kb }) : tr('背景图已更新'));
        } else if (r && r.reason && r.reason !== 'cancel') {
          toast(r.reason);
        }
      } catch (err) {
        toast(tr('选择背景图失败：{msg}', { msg: (err && err.message) || err }));
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
        toast(tr('已移除背景图'));
      } catch (err) {
        toast(tr('移除失败：{msg}', { msg: (err && err.message) || err }));
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

  // 浮窗不透明度：拖动只改读数，松手才落库（落库后主进程会广播，已钉的浮窗立即变）
  const dwSlider = pane.querySelector('#ap-dw-opacity');
  dwSlider?.addEventListener('input', () => {
    const val = pane.querySelector('[data-role="dwval"]');
    if (val) val.textContent = `${dwSlider.value}%`;
  });
  dwSlider?.addEventListener('change', () => {
    commit({ desktop: { opacity: Number(dwSlider.value) } });
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
      title: tr('界面语言'),
      rows: [
        rowHtml({
          title: tr('界面语言'),
          desc: tr('切换后界面会重新加载一次；任务 / 笔记等内容数据不受影响'),
          ctl: ctlSelect('st-locale', S.locale || 'zh-CN', [
            ['zh-CN', LOCALE_LABELS['zh-CN']],
            ['en', LOCALE_LABELS.en],
          ]),
          search: '语言 英文 English language i18n locale 中文',
          id: 'locale',
        }),
      ],
    }),
    sectionHtml({
      title: tr('计划模式'),
      rows: [
        rowHtml({
          title: tr('启用计划模式'),
          desc: tr('开启时新建 / 编辑任务可选起止日期段，适合做年度 / 季度计划（默认开启）；关闭后只需选一个截止日期。仅改变日期控件形态，不影响已有任务的数据。'),
          ctl: ctlSwitch('st-plan-range-mode', (S.taskDate || {}).rangeMode !== false),
          search: '计划模式 日期段 起止日期 年度计划 季度计划 截止日期 range plan date',
          id: 'plan-date-mode',
        }),
      ],
    }),
    sectionHtml({
      title: tr('启动'),
      rows: [
        rowHtml({
          title: tr('开机自启动'),
          desc: supported ? tr('登录系统后在后台驻留托盘，不弹主窗口') : (auto.reason || tr('当前环境不支持开机自启动')),
          ctl: ctlSwitch('st-autostart', !!auto.enabled, !supported),
          search: '启动项 登录时启动 自启 startup',
          id: 'autostart',
        }),
      ],
    }),
  ].join('');
}

function mountGeneral(pane) {
  // 「计划模式」：写 tool.taskDate，切换后通知壳层即时换控件形态（无需重载）。
  // 已有任务的 plan_start / plan_end 原样保留，只有用户重新选日期时才会被改成新形态的值。
  const rangeSw = pane.querySelector('#st-plan-range-mode');
  rangeSw?.addEventListener('change', async (e) => {
    const want = e.target.checked;
    e.target.disabled = true;
    try {
      const next = { ...(S.taskDate || {}), rangeMode: want };
      await api.ui.setToolPref('taskDate', next);
      S.taskDate = next;
      if (typeof ext.onPlanDateModeChange === 'function') ext.onPlanDateModeChange(want);
      toast(want ? tr('已开启计划模式，新建任务可选起止日期') : tr('已关闭计划模式，新建任务只需选截止日期'));
    } catch (err) {
      e.target.checked = !want;
      toast(tr('保存失败：{msg}', { msg: (err && err.message) || err }));
    } finally {
      e.target.disabled = false;
    }
  });

  // 界面语言：写库 → 主进程广播 locale:changed → 所有窗口 reload（含当前窗口）。
  // 因此这里不需要自己重绘，只把失败态回滚；成功时给一句过渡提示。
  const locSel = pane.querySelector('#st-locale');
  locSel?.addEventListener('change', async (e) => {
    const want = e.target.value;
    const cur = S.locale || getLocaleNow();
    if (want === cur) return;
    e.target.disabled = true;
    toast(tr('正在切换界面语言…'));
    try {
      const next = await api.i18n.set(want);
      S.locale = next || want;
    } catch (err) {
      e.target.value = cur;
      e.target.disabled = false;
      toast(tr('设置失败：{msg}', { msg: (err && err.message) || err }));
    }
  });

  const autoSw = pane.querySelector('#st-autostart');
  autoSw?.addEventListener('change', async (e) => {
    const want = e.target.checked;
    e.target.disabled = true;
    try {
      const r = await api.app.setAutoStart(want);
      if (!r || !r.ok) {
        e.target.checked = !want;
        toast((r && r.reason) || tr('开机自启动设置失败'));
        return;
      }
      S.autoStart = { ...S.autoStart, enabled: !!r.enabled, supported: true };
      e.target.checked = !!r.enabled;
      toast(r.enabled ? tr('已开启开机自启动') : tr('已关闭开机自启动'));
    } catch (err) {
      e.target.checked = !want;
      toast(tr('保存失败：{msg}', { msg: (err && err.message) || err }));
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
  ? (o.encryptionDegraded ? tr('Key 已保存（非加密降级）') : tr('Key 已保存（本地加密）'))
  : tr('Key 未配置'));

/**
 * 视觉模型的「生效状态」文案。
 * 这一行是这组配置的全部意义所在：用户必须一眼看出**这次识图到底会打给谁**，
 * 否则回落到对话模型（通常是 deepseek-chat，根本不支持图片）时，
 * 报错会出现在按快捷键之后，那时用户已经截完图了。
 */
function visionStateText(v) {
  if (!v || !v.effective) return tr('未读取到配置');
  const e = v.effective;
  if (!e.hasKey) {
    return e.source === 'fallback'
      ? tr('还没有可用的 Key：识别会提示先配置（当前会回落到对话模型 {model}）', { model: e.label })
      : tr('视觉模型还没有可用的 Key：识别会提示先配置');
  }
  if (e.source === 'fallback') {
    return e.imageCapability === 'yes'
      ? tr('未单独配置，回落到对话模型 {model}（能读图）', { model: e.label })
      : tr('未单独配置，回落到对话模型 {model}（是否支持图片未确认，识别失败就换一个视觉模型）', { model: e.label });
  }
  const unconfirmed = e.imageCapability === 'yes' ? '' : tr('（未收录，点「测试读图」可验证）');
  return e.keyReused
    ? tr('使用视觉模型 {model}，Key 复用对话模型（同一服务商）{extra}', { model: e.label, extra: unconfirmed })
    : tr('使用视觉模型 {model}（独立 Key）{extra}', { model: e.label, extra: unconfirmed });
}

/**
 * 视觉模型下拉：当前预设的模型 + 「自定义…」；手填过的名字回显为「自定义…」+ 输入框。
 *
 * 第一项必须是「不使用」：这一组配置默认就该是空的（对话模型能读图就够了）。
 * 没有这一项时，用户只能改不能清 —— 清掉模型再打开面板还会被自动填成预设里的第一个，
 * 于是永远退不出「一直走视觉模型」。空值统一用 __none 表示，别用空字符串当 option value。
 */
const VISION_NONE = '__none';
function visionModelCtl(presets, baseUrl, model) {
  const preset = (presets || []).find((p) => p.baseUrl === baseUrl) || null;
  const models = preset ? preset.models : [];
  const known = models.some((m) => m.id === model);
  const opts = [[VISION_NONE, tr('不使用（用对话模型）')]]
    .concat(models.map((m) => [m.id, m.free ? `${m.label} · ${m.free}` : m.label]));
  opts.push(['__custom', tr('自定义…')]);
  const value = !model ? VISION_NONE : (known ? model : '__custom');
  return ctlSelect('st-vision-model', value, opts)
    + `<input class="st-input" id="st-vision-model-custom" type="text" spellcheck="false"
         placeholder="${tr("填模型名，如 qwen3.8-flash 或 glm-4v-flash")}" value="${esc(known ? '' : (model || ''))}"
         style="max-width:210px;${value === '__custom' ? '' : 'display:none'}" />`;
}

function aiHtml() {
  const c = S.ai || {};
  const asr = c.asr || {};
  const vision = c.vision || {};
  const presets = c.presets || [];
  const asrPresets = asr.presets || [];
  const visionPresets = vision.presets || [];
  const vPresetId = (() => {
    const hit = visionPresets.find((p) => p.baseUrl === vision.baseUrl);
    return hit ? hit.id : '';
  })();

  return [
    sectionHtml({
      title: tr('对话模型'),
      desc: tr('用于 AI 日报 / 周报、笔记问答与会议纪要；不配置时报告降级为本地模板。'),
      rows: [
        rowHtml({
          title: tr('接口预设'),
          desc: tr('选中后自动填好地址与模型，也可以手动改'),
          ctl: ctlSelect('st-ai-preset', presetValueOf(presets, c.baseUrl, c.model),
            [['', tr('自定义')]].concat(presets.map((p) => [p.id, tr(p.label)]))),
          search: 'deepseek openai 接口 服务商 preset',
        }),
        rowHtml({
          title: tr('模型'),
          ctl: ctlInput('st-ai-model', c.model || '', { placeholder: 'deepseek-chat', wide: true }),
          search: 'model',
        }),
        rowHtml({
          title: tr('接口地址'),
          ctl: ctlInput('st-ai-baseurl', c.baseUrl || '', { placeholder: 'https://api.deepseek.com', wide: true }),
          search: 'base url 端点 地址',
        }),
        rowHtml({
          title: 'API Key',
          desc: keyStateText(c),
          ctl: ctlInput('st-ai-key', '', { type: 'password', placeholder: c.hasKey ? tr('已保存，留空则不变') : tr('输入 API Key'), wide: true }),
          search: '密钥 token 秘钥 key',
        }),
        rowHtml({
          title: tr('连接测试'),
          desc: tr('用当前配置发一次最小请求，确认地址 / 模型 / Key 都可用'),
          ctl: ctlButton('test-ai', tr('测试连接')),
          search: '连通 检测 ping 测试 test',
        }),
      ],
    }),
    sectionHtml({
      title: tr('视觉模型'),
      desc: tr('截图建任务专用：只负责「看图」，与对话模型分开配置。不配也能用 —— 会回落到对话模型，前提是那个模型能读图。'),
      rows: [
        rowHtml({
          id: 'vision-state',
          title: tr('当前生效'),
          desc: visionStateText(vision),
          search: '识图 vision 视觉模型 生效 回落',
        }),
        rowHtml({
          title: tr('接口预设'),
          desc: tr('选中后自动填好地址与默认模型，也可以手动改'),
          ctl: ctlSelect('st-vision-preset', vPresetId,
            [['', tr('自定义')]].concat(visionPresets.map((p) => [p.id, tr(p.label)]))),
          search: '智谱 glm 通义 qwen openai ollama 硅基流动',
        }),
        rowHtml({
          title: tr('视觉模型'),
          desc: tr('选「不使用」就整组回落（截图识别走上面的对话模型）；自建中转 / 私有部署选「自定义…」填名字'),
          ctl: visionModelCtl(visionPresets, vision.baseUrl, vision.model),
          search: 'model 4v vl vision llava 自定义',
        }),
        rowHtml({
          title: tr('视觉接口地址'),
          ctl: ctlInput('st-vision-baseurl', vision.baseUrl || '', { placeholder: tr('留空 = 用对话模型的地址'), wide: true }),
          search: 'base url 端点',
        }),
        rowHtml({
          title: tr('视觉 API Key'),
          desc: vision.hasKey
            ? tr('{state}；留空则保持不变', { state: keyStateText(vision) })
            : tr('与对话模型同一服务商时可留空（自动复用）；不同服务商必须单独填'),
          ctl: ctlInput('st-vision-key', '', { type: 'password', placeholder: vision.hasKey ? tr('已保存，留空则不变') : tr('输入 API Key'), wide: true }),
          search: '密钥 token key',
        }),
        rowHtml({
          title: tr('连接测试'),
          desc: tr('会真发一张 256×256 白图，验的是「这个模型能读图」，不是「地址能通」'),
          ctl: ctlButton('test-vision', tr('测试读图')),
          search: '连通 检测 测试 vision ping',
        }),
      ],
    }),
    sectionHtml({
      title: tr('语音转写'),
      desc: tr('用于会议纪要与录音转写；不配置时录音仍可保存，但不会自动转文字。'),
      rows: [
        rowHtml({
          title: tr('语音接口预设'),
          ctl: ctlSelect('st-asr-preset', presetValueOf(asrPresets, asr.baseUrl, asr.model),
            [['', tr('自定义')]].concat(asrPresets.map((p) => [p.id, tr(p.label)]))),
          search: 'whisper asr 语音',
        }),
        rowHtml({ title: tr('语音模型'), ctl: ctlInput('st-asr-model', asr.model || '', { placeholder: 'whisper-1', wide: true }), search: 'model' }),
        rowHtml({
          title: tr('语音接口地址'),
          ctl: ctlInput('st-asr-baseurl', asr.baseUrl || '', { placeholder: 'https://api.openai.com/v1', wide: true }),
          search: 'base url',
        }),
        rowHtml({
          title: tr('语音 API Key'),
          desc: keyStateText(asr),
          ctl: ctlInput('st-asr-key', '', { type: 'password', placeholder: asr.hasKey ? tr('已保存，留空则不变') : tr('输入 API Key'), wide: true }),
          search: '密钥 token',
        }),
      ],
    }),
    sectionHtml({
      title: tr('截图建任务'),
      desc: tr('把截图里的待办直接建成任务：识别结果先落一张可编辑的卡片，勾选后才进库。没拆出明确待办时，会把图里的文字识别成一条草稿，别让你空手而归。'),
      rows: [
        rowHtml({
          title: tr('读取剪贴板'),
          desc: tr('默认主入口：先用 Win + Shift + S 截好，再按这个键。不会隐藏窗口，也更快'),
          ctl: ctlInfo('Ctrl + Alt + V'),
          search: '截图 快捷键 剪贴板 screenshot paste',
        }),
        rowHtml({
          title: tr('框选屏幕区域'),
          desc: tr('直接在屏幕上拖一块，松手后还能拖动边角改大小、拖内部挪位置，回车确认'),
          ctl: ctlInfo('Ctrl + Alt + S'),
          search: '框选 区域 截屏 screenshot region',
        }),
        rowHtml({
          title: tr('图片去哪了'),
          desc: tr('截图只在你按键时截取，本地不保留原图；确认添加后才作为附件存进数据目录。识别时图片会发给你配置的视觉模型服务商。'),
          search: '隐私 安全 外发 附件',
        }),
        rowHtml({
          title: tr('改键 / 关闭'),
          desc: tr('两个键都在「快捷键」分区里，可以改键，也可以清空 —— 清空后这个功能对你就不存在了'),
          search: '自定义 快捷键 keybinding',
        }),
      ],
    }),
    `<div class="st-foot-note">${tr("Key 只在保存时写进本地数据库（加密存储），不会随导出 / 同步带出去。")}</div>`,
  ].join('');
}

async function saveAi(pane) {
  const val = (sel) => (pane.querySelector(sel)?.value || '').trim();
  // 视觉模型是「下拉 + 自定义」二态：选到「自定义…」时真值在旁边的输入框里；
  // 选到「不使用」时清空 —— 不能把 __none 当模型名写进库
  const vSel = pane.querySelector('#st-vision-model');
  const vCustom = pane.querySelector('#st-vision-model-custom');
  const visionModel = !vSel || vSel.value === VISION_NONE
    ? ''
    : (vSel.value === '__custom' ? (vCustom?.value || '').trim() : (vSel.value || '').trim());

  const payload = {
    baseUrl: val('#st-ai-baseurl'),
    model: val('#st-ai-model'),
    asrBaseUrl: val('#st-asr-baseurl'),
    asrModel: val('#st-asr-model'),
    // 地址 / 模型允许清空：清空 = 回落（主进程侧按"留空即回落"解释）
    visionBaseUrl: val('#st-vision-baseurl'),
    visionModel,
  };
  const key = val('#st-ai-key');
  const asrKey = val('#st-asr-key');
  const visionKey = val('#st-vision-key');
  if (key) payload.apiKey = key;       // 留空 = 保持原 Key 不变（主进程侧语义）
  if (asrKey) payload.asrKey = asrKey;
  if (visionKey) payload.visionKey = visionKey;

  const r = await api.ai.saveConfig(payload);
  S.ai = r;
  const keyInput = pane.querySelector('#st-ai-key');
  if (keyInput) {
    keyInput.value = '';
    keyInput.placeholder = r.hasKey ? tr('已保存，留空则不变') : tr('输入 API Key');
  }
  const asrKeyInput = pane.querySelector('#st-asr-key');
  if (asrKeyInput) {
    asrKeyInput.value = '';
    asrKeyInput.placeholder = (r.asr && r.asr.hasKey) ? tr('已保存，留空则不变') : tr('输入 API Key');
  }
  const vKeyInput = pane.querySelector('#st-vision-key');
  if (vKeyInput) {
    vKeyInput.value = '';
    vKeyInput.placeholder = (r.vision && r.vision.hasKey) ? tr('已保存，留空则不变') : tr('输入 API Key');
  }
  // 「当前生效」这一行必须跟着变：它决定用户下一次按快捷键时请求打给谁
  const vState = pane.querySelector('[data-item="vision-state"] .st-row-desc');
  if (vState) vState.textContent = visionStateText(r.vision);
  // 状态文案就地更新，不整体重绘（重绘会丢焦点，用户可能正往里打字）
  pane.querySelectorAll('.st-row').forEach((row) => {
    const title = row.querySelector('.st-row-title')?.textContent || '';
    const desc = row.querySelector('.st-row-desc');
    if (!desc) return;
    if (title === 'API Key') desc.textContent = keyStateText(r);
    if (title === tr('语音 API Key')) desc.textContent = keyStateText(r.asr);
  });
  toast(tr('AI 配置已保存'));
}

/**
 * 取消视觉模型的独立配置 = 改回「用对话模型」。
 * 三步：地址清空 → 保存（模型也跟着写空）→ 清掉残留的视觉 Key。
 * 顺序不能反：Key 先清而模型还没清时，库里会短暂存在"有模型没 Key"的坏组合。
 */
async function clearVisionConfig(pane) {
  const urlInput = pane.querySelector('#st-vision-baseurl');
  if (urlInput) urlInput.value = '';
  const pSel = pane.querySelector('#st-vision-preset');
  if (pSel) pSel.value = ''; // 地址清了，预设下拉也得退回「自定义」，否则界面自相矛盾
  await saveAi(pane);
  const v = await api.ai.clearVisionKey();
  if (v) S.ai = { ...(S.ai || {}), vision: v };
  const keyInput = pane.querySelector('#st-vision-key');
  if (keyInput) {
    keyInput.value = '';
    keyInput.placeholder = tr('输入 API Key');
  }
  const keyDesc = keyInput?.closest('.st-row')?.querySelector('.st-row-desc');
  if (keyDesc) keyDesc.textContent = tr('与对话模型同一服务商时可留空（自动复用）；不同服务商必须单独填');
  const state = pane.querySelector('[data-item="vision-state"] .st-row-desc');
  if (state) state.textContent = visionStateText(v || (S.ai && S.ai.vision));
  toast(tr('已改为使用对话模型'));
}

function mountAi(pane) {
  const bindPreset = (sel, urlId, modelId, presets) => {
    pane.querySelector(sel)?.addEventListener('change', (e) => {
      const p = (presets || []).find((x) => x.id === e.target.value);
      if (!p) return;
      pane.querySelector(urlId).value = p.baseUrl;
      pane.querySelector(modelId).value = p.model;
      saveAi(pane).catch((err) => toast(tr('保存失败：{msg}', { msg: (err && err.message) || err })));
    });
  };
  bindPreset('#st-ai-preset', '#st-ai-baseurl', '#st-ai-model', (S.ai || {}).presets);
  bindPreset('#st-asr-preset', '#st-asr-baseurl', '#st-asr-model', ((S.ai || {}).asr || {}).presets);

  /* ---- 视觉模型：预设换一组时，地址与「模型下拉」一起重建 ---- */
  const vPresets = (S.ai && S.ai.vision && S.ai.vision.presets) || [];
  const rebuildVisionModels = (models, selected) => {
    const sel = pane.querySelector('#st-vision-model');
    if (!sel) return;
    sel.innerHTML = `<option value="${VISION_NONE}">${tr('不使用（用对话模型）')}</option>`
      + (models || []).map((m) => `<option value="${esc(m.id)}">${esc(m.free ? `${m.label} · ${m.free}` : m.label)}</option>`).join('')
      + `<option value="__custom">${tr('自定义…')}</option>`;
    // 换预设 = 明确要用视觉模型，默认挑该预设的第一个（想取消再选回「不使用」）
    sel.value = selected && (models || []).some((m) => m.id === selected)
      ? selected
      : ((models && models[0] && models[0].id) || '__custom');
    const custom = pane.querySelector('#st-vision-model-custom');
    if (custom) {
      custom.value = '';
      custom.style.display = sel.value === '__custom' ? '' : 'none';
    }
  };
  pane.querySelector('#st-vision-preset')?.addEventListener('change', (e) => {
    const p = vPresets.find((x) => x.id === e.target.value);
    if (!p) return; // 选「自定义」：地址与模型都留给用户自己写，不清空已有内容
    const urlInput = pane.querySelector('#st-vision-baseurl');
    if (urlInput) urlInput.value = p.baseUrl;
    rebuildVisionModels(p.models, null);
    saveAi(pane).catch((err) => toast(tr('保存失败：{msg}', { msg: (err && err.message) || err })));
  });
  pane.querySelector('#st-vision-model')?.addEventListener('change', (e) => {
    const custom = pane.querySelector('#st-vision-model-custom');
    const isCustom = e.target.value === '__custom';
    if (custom) {
      custom.style.display = isCustom ? '' : 'none';
      if (isCustom) { custom.focus(); return; } // 等用户把名字填完再落库
    }
    // 「不使用」= 把这一组彻底清掉：模型、地址、Key 三样一起清。
    // 只清模型也能回落（主进程按整组判定），但残留的地址 / 过期 Key 留在库里，
    // 用户下次打开设置会以为"还在用视觉模型"，所以顺手擦干净。
    if (e.target.value === VISION_NONE) {
      clearVisionConfig(pane).catch((err) => toast(tr('保存失败：{msg}', { msg: (err && err.message) || err })));
      return;
    }
    saveAi(pane).catch((err) => toast(tr('保存失败：{msg}', { msg: (err && err.message) || err })));
  });

  // 文本类字段失焦 / 回车提交：WorkBuddy 的设置项没有「保存」按钮，改完即生效
  ['#st-ai-model', '#st-ai-baseurl', '#st-ai-key', '#st-asr-model', '#st-asr-baseurl', '#st-asr-key',
    '#st-vision-baseurl', '#st-vision-model-custom', '#st-vision-key']
    .forEach((sel) => {
      const el = pane.querySelector(sel);
      if (!el) return;
      el.addEventListener('change', () => {
        saveAi(pane).catch((err) => toast(tr('保存失败：{msg}', { msg: (err && err.message) || err })));
      });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    });

  // 连接测试：结果就地写在说明行里，不弹窗打断（失败原因通常是「Key 错了 / 地址多了斜杠」这种短句）
  pane.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="test-ai"]');
    if (btn) {
      const desc = btn.closest('.st-row')?.querySelector('.st-row-desc');
      btn.disabled = true;
      if (desc) desc.textContent = tr('正在测试…');
      try {
        const r = await api.ai.test({
          baseUrl: (pane.querySelector('#st-ai-baseurl')?.value || '').trim(),
          model: (pane.querySelector('#st-ai-model')?.value || '').trim(),
        });
        if (desc) desc.textContent = r && r.ok
          ? tr('连接成功：{msg}', { msg: r.message || tr('模型响应正常') })
          : tr('连接失败：{msg}', { msg: (r && r.message) || tr('未知错误') });
      } catch (err) {
        if (desc) desc.textContent = tr('连接失败：{msg}', { msg: (err && err.message) || err });
      } finally {
        btn.disabled = false;
      }
      return;
    }
    // 视觉模型自检：真发一张 256×256 白图，验"这个模型能吃图"
    const vBtn = e.target.closest('[data-act="test-vision"]');
    if (vBtn) {
      const desc = vBtn.closest('.st-row')?.querySelector('.st-row-desc');
      const vSel = pane.querySelector('#st-vision-model');
      const vCustom = pane.querySelector('#st-vision-model-custom');
      const model = vSel && vSel.value === '__custom'
        ? (vCustom?.value || '').trim()
        : (vSel?.value || '').trim();
      vBtn.disabled = true;
      if (desc) desc.textContent = tr('正在发一张测试图…');
      try {
        const r = await api.ai.testVision({
          baseUrl: (pane.querySelector('#st-vision-baseurl')?.value || '').trim(),
          model,
          apiKey: (pane.querySelector('#st-vision-key')?.value || '').trim(),
        });
        if (desc) desc.textContent = r && r.ok
          ? (r.message || tr('读图正常'))
          : tr('失败：{msg}', { msg: (r && r.message) || tr('未知错误') });
      } catch (err) {
        if (desc) desc.textContent = tr('失败：{msg}', { msg: (err && err.message) || err });
      } finally {
        vBtn.disabled = false;
      }
    }
  });
}

/* ------------------------------ 分区：日历 ------------------------------ */

function calendarHtml() {
  const cal = S.calendar || {};
  return [
    sectionHtml({
      title: tr('日历视图'),
      desc: tr('格子显示的是「负载」：按优先级加权，默认容量 6 相当于一天能扛 6 个中等任务。'),
      rows: [
        rowHtml({
          title: tr('每日容量'),
          desc: tr('4 – 10 之间可调，超载只在 ≥100% 变色'),
          ctl: ctlInput('st-cal-capacity', String(cal.capacity ?? 6), { type: 'number', placeholder: '6' }),
          search: '负载 容量 权重 calendar',
        }),
        rowHtml({
          title: tr('每周起始日'),
          ctl: ctlSelect('st-cal-weekstart', String(cal.weekStart ?? 1), [['1', tr('周一')], ['0', tr('周日')]]),
          search: '周视图 星期 calendar',
        }),
        rowHtml({
          title: tr('隐藏已完成任务'),
          desc: tr('默认显示：完成的任务留在当天格子里，只是不计入负载'),
          ctl: ctlSwitch('st-cal-hidedone', !!cal.hideCompleted),
          search: '完成态 calendar',
        }),
      ],
    }),
    `<div class="st-foot-note">${tr("点侧栏「今天」下面的「🗓 日历」，或按 Ctrl + Alt + M 打开日历；月 / 周在日历里切换。这里的改动会立刻重绘当前日历。")}</div>`,
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
      toast(tr('日历设置已保存'));
    } catch (e) {
      toast(tr('保存失败：{msg}', { msg: (e && e.message) || e }));
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
        if (!silent) toast(tr('薪资设置已保存'));
      } catch (e) {
        toast(tr('保存失败：{msg}', { msg: (e && e.message) || e }));
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
  const buddyOn = !!(S.buddy && S.buddy.enabled);
  return [
    `<div class="st-foot-note" id="fun-plugin-off"${buddyOn ? ' hidden' : ''}>${tr('工位搭子是插件，当前未启用 —— 标题栏入口、快捷键与浮窗都隐藏。先到「功能插件 → 工位搭子」打开开关，这里的内容才会出现。')}</div>`,
    `<div id="fun-plugin-body"${buddyOn ? '' : ' hidden'}>`,
    // 原来在「趣味功能」菜单里的两个浮窗入口：菜单栏撤掉后落到这里
    sectionHtml({
      title: tr('浮窗入口'),
      desc: tr('上班鼓励器与今日牛马卡都是独立浮窗，随时可开；全局键 Ctrl+Alt+E 也能直接唤起鼓励器。'),
      rows: [
        rowHtml({
          title: tr('上班鼓励器'),
          desc: tr('今日进账 / 牛马币 / 工位搭子，边干活边冒话。'),
          ctl: ctlButton('open-encourager', tr('打开')),
          search: '鼓励器 上班 进账 摸鱼 牛马币 encourager',
          id: 'open-encourager',
        }),
        rowHtml({
          title: tr('今日牛马卡'),
          desc: tr('把今天的工作量做成一张可保存的卡片。'),
          ctl: ctlButton('open-card', tr('打开')),
          search: '牛马卡 卡片 分享 海报 card',
          id: 'open-card',
        }),
      ],
    }),
    sectionHtml({
      title: tr('薪资与班次'),
      desc: tr('按「月薪 ÷ 当月工作日 ÷ 每日工时」换算，只统计上班到下班区间内的在岗时间。填一次，进账数字立刻生效；上班鼓励器浮窗右上角的 ⚙ 或「设置」页签改的也是这三项。'),
      rows: [
        rowHtml({
          title: tr('月薪'),
          ctl: `${ctlInput('st-salary-monthly', s.monthly ? String(s.monthly) : '', { type: 'number', placeholder: '0' })}<span class="st-unit">${tr("元")}</span>`,
          search: '工资 收入 salary 月薪',
        }),
        rowHtml({
          title: tr('上班时间'),
          ctl: ctlInput('st-salary-start', s.start || '', { type: 'time' }),
          search: '考勤 打卡 开始 班次',
        }),
        rowHtml({
          title: tr('下班时间'),
          ctl: ctlInput('st-salary-end', s.end || '', { type: 'time' }),
          search: '考勤 打卡 结束 班次',
        }),
      ],
    }),
    sectionHtml({
      title: tr('工位搭子'),
      desc: tr('搭子说话的方式；完成一个任务时会按这个语气冒一句。'),
      rows: [
        rowHtml({
          title: tr('默认语气'),
          ctl: ctlSelect('st-enc-tone', c.buddy.tone, [['warm', tr('暖心')], ['salty', tr('阴阳')], ['sharp', tr('毒舌')]]),
          search: '语气 搭子 台词 暖心 阴阳 毒舌',
        }),
      ],
    }),
    sectionHtml({
      title: tr('牛马币与隐私'),
      desc: tr('牛马币只换皮肤、不换钱，与真实金额在刷新节奏、数值形态、颜色与区块上完全分离。'),
      rows: [
        rowHtml({
          title: tr('显示牛马币'),
          desc: tr('关闭后隐藏 HUD 格子与发币提示，不清空已有币值'),
          ctl: ctlSwitch('st-enc-coins', c.coinsEnabled),
          search: '牛马币 玩法货币 coins',
        }),
        rowHtml({
          title: tr('分享卡默认显示真实金额'),
          desc: tr('默认关闭；即使在卡片页临时开启，导出前仍会二次确认'),
          ctl: ctlSwitch('st-enc-share-amount', c.privacy.shareAmount),
          search: '分享卡 金额 隐私',
        }),
        rowHtml({
          title: tr('分享卡默认包含任务标题'),
          desc: tr('默认关闭；开启后仍需逐条勾选，导出前二次确认'),
          ctl: ctlSwitch('st-enc-share-titles', c.share.includeTaskTitles),
          search: '分享卡 任务标题 隐私',
        }),
      ],
    }),
    sectionHtml({
      title: tr('购买力换算'),
      desc: tr('把「今日已赚」换算成生活里的东西。单价是虚构演示值，不是真实物价。'),
      rows: buys.map(([name, price], i) => rowHtml({
        title: tr(name),
        ctl: `${ctlInput(`st-enc-buy-${i}`, String(price), { type: 'number' })}<span class="st-unit">${tr("元")}</span>`,
        search: `购买力 单价 ${name}`,
        id: `enc-buy-${i}`,
      })),
    }),
    `<div class="st-foot-note">${tr("主浮窗：Ctrl + Alt + E 或菜单「趣味功能 → 上班鼓励器」；月薪与班次也能直接在主浮窗的「设置」页签里改。")}<br>${tr("主题跟随应用明暗，唯一入口在「通用 → 界面主题」，这里不另设开关。")}<br>${tr("牛马币与连续打卡是情绪数据，会被整体备份 / 恢复回滚，不参与导入校验，请不要当成资产；解锁项仅存本机，换设备或重装不继承。")}</div>`,
    `</div>`,
  ].join('');
}

/** 插件开关在「功能插件」里拨动时，就地收起 / 展开趣味功能内容，不重建整个设置面板 */
function applyFunGate(root) {
  const scope = root || document;
  const on = !!(S.buddy && S.buddy.enabled);
  const off = scope.querySelector('#fun-plugin-off');
  const body = scope.querySelector('#fun-plugin-body');
  if (off) off.hidden = on;
  if (body) body.hidden = !on;
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
      toast(tr('趣味功能设置已保存'));
    } catch (e) {
      toast(tr('保存失败：{msg}', { msg: (e && e.message) || e }));
    }
  };
  const bindChange = (sel, mutate) => {
    const el = pane.querySelector(sel);
    if (el) el.addEventListener('change', () => saveEnc((c) => mutate(c, pane)));
  };
  // 浮窗入口（原「趣味功能」菜单里的两项）
  pane.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'open-encourager') runAction('encourager');
    else if (btn.dataset.act === 'open-card') runAction('encourager-card');
  });
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

/* ------------------------------ 分区：工具 ------------------------------ */

/**
 * 工具分区：接管原来「实用工具」菜单里的东西。
 * 菜单栏撤掉之后这里是唯一入口 —— 重复事项管理与桌面浮窗。
 * （文本对比 / JSON 查看器 两个独立小工具已整体下线，见 v2.5.0 变更）
 * 桌面浮窗是异步数据（api.desktop.list()），HTML 先出骨架，mountTools 再填。
 */
function toolsHtml() {
  return [
    sectionHtml({
      title: tr('重复事项与习惯'),
      desc: tr('统一管理所有重复规则：改周期、暂停、看打卡记录。'),
      rows: [
        rowHtml({
          title: tr('重复事项与习惯'),
          desc: tr('统一管理所有重复规则：改周期、暂停、看打卡记录。'),
          ctl: ctlButton('open-recurrence', tr('管理…')),
          search: '重复 习惯 规则 周期 打卡 recurring repeat habit',
          id: 'tool-recurrence',
        }),
      ],
    }),
    sectionHtml({
      title: tr('桌面浮窗'),
      desc: tr('钉在桌面上的清单 / 视图。隐藏不等于删除，随时可以再显示；位置跑偏了点「复位」回到默认角。'),
      html: `<div id="st-desk-list"><span class="st-sub">${tr("读取中…")}</span></div>`,
    }),
  ].join('');
}

async function paintDeskList(pane) {
  const box = pane.querySelector('#st-desk-list');
  if (!box) return;
  let items = [];
  try {
    items = await api.desktop.list();
  } catch (e) {
    box.innerHTML = `<span class="st-sub">${tr('读取桌面浮窗失败：{msg}', { msg: esc((e && e.message) || e) })}</span>`;
    return;
  }
  if (!Array.isArray(items) || !items.length) {
    box.innerHTML = `<span class="st-sub">${tr('还没有钉到桌面的清单。在侧栏分组 / 「今天」/ 「即将到期」上右键 →「钉到桌面」即可。')}</span>`;
    return;
  }
  box.innerHTML = items.map((p) => {
    const title = esc(p.title || tr('未命名'));
    const kindText = p.kind === 'note' ? tr('笔记') : `${p.done || 0}/${p.total || 0}`;
    const missing = p.missing ? tr(' · 源已删除') : '';
    const search = esc(`浮窗 ${p.title || ''} ${kindText}`.toLowerCase());
    return `<div class="st-row" data-search="${search}" data-item="desk-${p.id}">
      <div class="st-row-main">
        <div class="st-row-title">${title}</div>
        <div class="st-row-desc"><span class="st-sub">${kindText}${missing}${p.visible ? '' : tr(' · 已隐藏')}</span></div>
      </div>
      <div class="st-row-ctl">
        <button type="button" class="st-btn" data-act="${p.visible ? 'desk-hide' : 'desk-show'}" data-id="${p.id}">${p.visible ? tr('隐藏') : tr('显示')}</button>
        <button type="button" class="st-btn" data-act="desk-reset" data-id="${p.id}">${tr('复位')}</button>
      </div>
    </div>`;
  }).join('');
  // 异步填进来的行没有经过 build 时的搜索索引：补一次过滤，否则搜索状态下会一直显示
  const root = pane.closest('.st-shell');
  if (root) applyFilter(root);
}

function mountTools(pane) {
  paintDeskList(pane);
  pane.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'open-recurrence') { runAction('recurrence'); return; }
      const id = Number(btn.dataset.id);
      if (act === 'desk-show') await api.desktop.show(id);
      else if (act === 'desk-hide') await api.desktop.hide(id);
      else if (act === 'desk-reset') await api.desktop.resetPosition(id);
      else return;
      paintDeskList(pane);
    } catch (err) {
      toast(tr('操作失败：{msg}', { msg: (err && err.message) || err }));
    }
  });
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

/** 只到日（全量备份按天命名的，显示 00:00 只会让人误以为「半夜自动跑」） */
function fmtDay(ms) {
  const t = Number(ms);
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 长路径单独占一行（右侧放按钮行得通，但路径会被挤成两行说明，看着很乱） */
const pathLine = (text) => `<span class="st-path" title="${esc(text || '')}">${esc(text || tr('未知'))}</span>`;

/** 全量备份行的说明文字（dataHtml 与「立即备份」完成后的局部刷新共用） */
function fullBackupDesc(bk) {
  const full = (bk && bk.full) || {};
  const text = full.latest
    ? tr('最近一次 {time} · 共 {n} 份 · {size}', { time: fmtDay(full.latest.time), n: full.count, size: fmtBytes(full.totalBytes) })
    : tr('还没有全量备份（启动 6 分钟后自动检查）');
  const next = full.nextDueTime
    ? tr('每 {n} 天一份，下一份约 {time}；只保留最近 {m} 个月', { n: full.intervalDays || 15, time: fmtDay(full.nextDueTime), m: full.keepMonths || 2 })
    : tr('每 {n} 天一份，只保留最近 {m} 个月', { n: full.intervalDays || 15, m: full.keepMonths || 2 });
  return `<span class="st-sub">${esc(text)}</span><span class="st-sub">${esc(next)}</span>${pathLine(full.dir || bk.dir)}`;
}

function dataHtml() {
  const st = S.storage || {};
  const bk = S.backup || {};
  const lastText = bk.latest
    ? tr('最近一次 {time} · 共 {n} 份 · {size}', { time: fmtTime(bk.latest.time), n: bk.count, size: fmtBytes(bk.totalBytes) })
    : tr('还没有自动备份（应用启动 5 分钟后会做第一次）');
  const srcText = st.source === 'fallback'
    ? tr('配置的目录当前不可用，本次临时使用默认目录')
    : st.isCustom ? tr('自定义目录') : tr('默认目录（在系统用户数据目录下）');

  return [
    sectionHtml({
      title: tr('存储位置'),
      rows: [
        rowHtml({
          title: tr('数据目录'),
          desc: `<span class="st-sub">${esc(srcText)}</span>${pathLine(st.dir)}`,
          ctl: `${ctlButton('open-data', tr('打开'))}${ctlButton('change-dir', tr('更改…'))}`,
          search: '路径 数据库 todo.db 附件 位置 path',
          id: 'data-dir',
        }),
      ],
    }),
    sectionHtml({
      title: tr('维护'),
      desc: tr('低频但需要能找得到的动作：归档是「从列表里收起来」，不是删除；导入 Markdown 用于从别的笔记工具迁移（换机 / 恢复整库见下方「备份」组）。'),
      rows: [
        rowHtml({
          title: tr('归档已完成任务'),
          desc: tr('把已完成的任务收进「归档」视图，任务列表里不再占行。随时可从侧栏「归档」取回。'),
          ctl: ctlButton('archive-done', tr('立即归档')),
          search: '归档 archive 收起来 清理已完成',
          id: 'archive-done',
        }),
        rowHtml({
          title: tr('导入 Markdown 笔记'),
          desc: tr('从外部笔记工具迁移：正文原样入库，文中的本地图片一起搬进附件目录。'),
          ctl: ctlButton('import-md', tr('选择文件…')),
          search: 'markdown md 导入 迁移 import 笔记',
          id: 'import-md',
        }),
      ],
    }),
    sectionHtml({
      title: tr('备份'),
      rows: [
        // 顶栏那个「📥 导入」的正式归宿：换机 / 恢复是低频动作，和天天点的「📤 备份」摆一起会被当成一对
        // 日常按钮，还白占搜索框的行宽。功能一条没少 —— 底下仍走 ui.js#importData（含二次确认）。
        rowHtml({
          title: tr('从备份包恢复（导入）'),
          desc: `<span class="st-sub">${tr("读取「📤 备份」导出的 .zip 完整包（任务 / 笔记 / 附件 / 录音）或旧版 JSON。会")}<b>${tr("覆盖")}</b>${tr("当前的任务、分组、标签、笔记与会议纪要，附件合并到数据目录；选完文件还会再确认一次。")}</span>`,
          ctl: ctlButton('import-data', tr('选择文件…')),
          search: '导入 恢复 还原 restore import zip json 换机 迁移 覆盖 backup',
          id: 'import-data',
        }),
        rowHtml({
          title: tr('日快照（仅数据库）'),
          desc: `<span class="st-sub">${esc(lastText)}</span><span class="st-sub">${tr('每天 1 份，只保留最近 {m} 个月；总量上限 500MB', { m: bk.keepMonths || 2 })}</span>${pathLine(bk.dir)}`,
          ctl: `${ctlButton('open-backup', tr('打开'))}${ctlButton('backup-dialog', tr('备份与恢复…'))}`,
          search: '快照 snapshot 恢复 还原 backup 每日',
          id: 'backup',
        }),
        rowHtml({
          title: tr('全量备份（含附件与录音）'),
          desc: fullBackupDesc(bk),
          ctl: `${ctlButton('open-full', tr('打开'))}${ctlButton('full-backup-now', tr('立即备份'))}`,
          search: '全量 完整 zip 附件 录音 换机 迁移 半个月 两个月 full',
          id: 'backup-full',
        }),
      ],
    }),
    `<div class="st-foot-note">${tr('日快照只保数据库（任务 / 笔记 / 会议记录 / 设置），每天启动 5 分钟后做一份；全量备份与主界面「📤 备份」导出同构，含附件与录音，每 {n} 天自动一份、只留最近 {m} 个月，可在上方「从备份包恢复（导入）」里用它恢复。恢复会用备份覆盖当前库，操作前会二次确认。', { n: (bk.full && bk.full.intervalDays) || 15, m: (bk.full && bk.full.keepMonths) || 2 })}</div>`,
  ].join('');
}

function mountData(pane) {
  pane.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'open-data' || act === 'open-backup' || act === 'open-full') {
        const kind = act === 'open-data' ? 'data' : act === 'open-full' ? 'backup-full' : 'backup';
        const r = await api.env.openPath(kind);
        if (r && !r.ok) toast(r.reason || tr('无法打开目录'));
      } else if (act === 'change-dir') {
        await api.app.openStorageDialog();
      } else if (act === 'backup-dialog') {
        await api.app.openBackupDialog();
      } else if (act === 'archive-done') {
        // 原 File 菜单项：只发动作，真正的归档仍由 ui.js 的 archiveCompleted() 执行
        runAction('archive-done');
      } else if (act === 'import-data') {
        // 设置面板会先收起（runMenuAction 的默认行为），再弹选文件 + 覆盖确认
        runAction('import-data');
      } else if (act === 'import-md') {
        runAction('import-md');
      } else if (act === 'full-backup-now') {
        // 打包大包时主进程同步写盘，按钮先锁住并换文案，避免用户以为没反应连点
        if (btn.disabled) return;
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = tr('备份中…');
        try {
          const r = await api.env.runFullBackup();
          if (r && r.ok) {
            toast(tr('全量备份完成 · {size}', { size: fmtBytes(r.size) }));
            S.backup = await api.env.getBackupInfo().catch(() => S.backup);
            const descEl = pane.querySelector('[data-item="backup-full"] .st-row-desc');
            if (descEl) descEl.innerHTML = fullBackupDesc(S.backup || {});
          } else {
            toast((r && r.reason) || tr('全量备份失败'));
          }
        } finally {
          btn.disabled = false;
          btn.textContent = label;
        }
      }
    } catch (err) {
      toast(tr('操作失败：{msg}', { msg: (err && err.message) || err }));
    }
  });
}

/* ------------------------------ 分区：学习文档 ------------------------------ */

/**
 * 学习文档：把 Gitee 上的文档拆成可单独打开的条目。
 *
 * 换仓库 / 换分支只改这两个常量；文件路径全部集中在 DOC_ITEMS 里，
 * 行的文案与搜索词也挂在那里 —— 加一篇文档就是往数组里加一项，不用碰模板。
 *
 * 为什么不在应用内渲染 Markdown：文档里全是相对路径图片与互相跳转的链接，
 * 在应用内打开等于要重新实现一套解析 + 资源代理；而改完文档只想立刻看到效果的是
 * 维护者，用系统浏览器性价比最高（也顺手能把链接发给别人）。
 */
const DOC_REPO = 'https://gitee.com/kiverson/todo-task';
const DOC_BRANCH = 'main';
/** 镜像：同一份内容在 GitHub。Gitee 打不开（企业网 / 杀软拦截）时给用户第二条路 */
const DOC_REPO_MIRROR = 'https://github.com/kevin-iverson/knodo';

/** 把仓库内路径拼成可打开的 blob 链接。中文文件名必须 encodeURI，否则会被当成本地路径 */
function docUrl(path) {
  return `${DOC_REPO}/blob/${DOC_BRANCH}/${encodeURI(path)}`;
}

/**
 * 条目：只放**线上确实存在**的页面。
 * docs/ 下目前只有 docs/README.md 与仓库根 README 提交过（其余分篇文档还在本地），
 * 直接按文件名拼链接就是一堆 404 —— 所以这里宁少不假，等那些文档推上去再往里加。
 * 每项二选一：path（仓库内文件，按分支拼 blob 链接）或 url（仓库外绝对地址）。
 */
const DOC_ITEMS = [
  {
    id: 'start',
    title: tr('开始读'),
    rows: [
      {
        key: 'index', path: 'docs/README.md',
        title: tr('文档目录'),
        desc: tr('按「安装 / 使用 / 开发维护」分好主题的目录页（分篇文档还在陆续补到仓库，个别条目暂时打不开）'),
        search: 'docs 文档 目录 首页 索引 手册 教程 学习 guide',
      },
      {
        key: 'home', path: 'README.md',
        title: tr('功能总览（项目主页）'),
        desc: tr('为什么这么设计，以及任务 / 日历 / 笔记 / 会议 / AI / 工时 / 快捷键每一块怎么用，含快速开始与源码运行'),
        search: 'readme 功能 总览 亮点 介绍 快速开始 上手 入门 源码 运行',
      },
    ],
  },
  {
    id: 'get',
    title: tr('安装与更新'),
    rows: [
      {
        key: 'download', url: `${DOC_REPO}/releases/latest`,
        title: tr('下载最新版'),
        desc: tr('安装版 exe 与便携版 7z 都在这里；被 Windows 拦下时点「更多信息 → 仍要运行」'),
        search: '下载 安装 便携版 最新版 发行版 release download 拦截 未知发布者',
      },
      {
        key: 'releases', url: `${DOC_REPO}/releases`,
        title: tr('历史版本与更新记录'),
        desc: tr('每个版本改了什么；想回退旧版也从这里取'),
        search: '历史 版本 记录 更新日志 changelog 回退 releases',
      },
    ],
  },
  {
    id: 'mirror',
    title: tr('打不开的时候'),
    rows: [
      {
        key: 'mirror', url: DOC_REPO_MIRROR,
        title: tr('GitHub 镜像'),
        desc: tr('同一份代码与文档，两站同版本。Gitee 被企业网或杀软拦掉时用这条'),
        search: '镜像 github 打不开 备用 备用地址 mirror',
      },
    ],
  },
];

const docBtn = (key, label = tr('打开')) =>
  `<button type="button" class="st-btn" data-act="open-doc" data-doc="${esc(key)}">${label}</button>`;

function docsHtml() {
  const sections = DOC_ITEMS.map((g) => sectionHtml({
    title: g.title,
    rows: g.rows.map((r) => rowHtml({
      title: r.title, desc: r.desc, ctl: docBtn(r.key), search: r.search,
    })),
  }));
  return [
    ...sections,
    `<div class="st-foot-note">${tr('文档都在浏览器里打开，需要联网；读到的始终是仓库里的最新版本，不用等应用升级。顺手可以把链接分享给别人。')}</div>`,
  ].join('');
}

function mountDocs(pane) {
  pane.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="open-doc"]');
    if (!btn) return;
    const item = DOC_ITEMS.flatMap((g) => g.rows).find((r) => r.key === btn.dataset.doc);
    if (!item) return;
    const url = item.url || docUrl(item.path);
    btn.disabled = true;
    try {
      const r = await api.app.openExternal(url);
      if (r && r.ok === false) throw new Error(r.reason || tr('系统没有默认浏览器'));
    } catch (err) {
      // 打不开就把地址复制走：toast 只是一行字，长链接塞不进去，用户也没法选中复制
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch (e) { /* 剪贴板不可用：下面照样给出原因 */ }
      toast(copied
        ? tr('打不开：{msg}。链接已复制，可以粘到浏览器里', { msg: (err && err.message) || err })
        : tr('打不开：{msg}', { msg: (err && err.message) || err }));
    } finally {
      btn.disabled = false;
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
      title: tr('爱发电'),
      desc: tr('按月或单次赞助都可以。捐赠只用于覆盖 Windows 代码签名证书——不签的话，安装时会弹“未知发布者”警告。'),
      ctl: ctlButton('sponsor', tr('去支持')),
      search: '捐赠 赞助 打赏 支持 donate sponsor 爱发电 afdian',
    }));
  }
  sponsorRows.push(rowHtml({
    title: tr('微信赞赏码'),
    desc: tr('扫码金额随意。不捐也完全不影响使用。'),
    ctl: ctlButton('qr', tr('扫码支持'), 'is-accent'),
    search: '捐赠 赞助 打赏 支持 donate sponsor 微信 赞赏 收款码 二维码 qr',
  }));
  const sponsor = sectionHtml({ title: tr('支持 Knodo'), rows: sponsorRows });
  return [
    sectionHtml({
      rows: [
        rowHtml({ title: tr('版本'), ctl: ctlInfo(S.version ? `Knodo ${S.version}` : tr('未知'), { mono: false }), search: 'version 版本号' }),
        rowHtml({
          title: tr('检查更新'),
          desc: tr('从 Gitee 发布页查询最新版本；只提示，不自动下载或改动本机数据。'),
          ctl: ctlButton('check-update', tr('检查更新…')),
          search: 'update 更新 升级 版本 检查更新 新版本',
        }),
        rowHtml({
          title: tr('学习文档'),
          desc: tr('功能怎么用、快捷键、出问题怎么办 —— 都在 Gitee 上的文档里，按主题分好'),
          ctl: ctlButton('open-docs', tr('去看看')),
          search: '文档 教程 学习 帮助 手册 说明 docs help guide',
        }),
        rowHtml({ title: tr('开源许可'), ctl: ctlInfo('MIT', { mono: false }), search: 'license 协议' }),
        rowHtml({
          title: tr('退出 Knodo'),
          desc: tr('窗口右上角 ✕ 只是最小化到托盘（后台继续提醒）；要连托盘一起退掉用这里。'),
          ctl: ctlButton('quit', tr('退出')),
          search: '退出 关闭 托盘 quit exit',
          id: 'quit-app',
        }),
        rowHtml({ title: tr('数据目录'), desc: pathLine(st.dir), search: '路径' }),
        rowHtml({ title: tr('备份目录'), desc: pathLine(bk.dir), search: '路径 snapshot' }),
      ],
    }),
    sponsor,
    `<div class="st-foot-note">${tr("所有任务、笔记与附件都保存在本机数据目录，不上传服务器；AI 功能只在你主动触发时把必要内容发给你配置的接口。")}</div>`,
  ].join('');
}

function mountAbout(pane) {
  pane.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    try {
      if (btn.dataset.act === 'sponsor' && SPONSOR_URL) {
        const r = await api.app.openExternal(SPONSOR_URL);
        if (r && !r.ok) toast(r.reason || tr('无法打开链接'));
      } else if (btn.dataset.act === 'check-update') {
        await api.app.checkUpdate();
      } else if (btn.dataset.act === 'open-docs') {
        // 面板内跳转：切分区而不是重开设置，否则搜索词与滚动位置都丢了
        const shell = pane.closest('.st-shell');
        if (shell) paintActive(shell, 'docs');
      } else if (btn.dataset.act === 'quit') {
        // 原 File 菜单的 Exit：退出前主进程会走 isQuitting，托盘与定时器一起收
        await api.app.quit();
      } else if (btn.dataset.act === 'qr') {
        openSponsorQr();
      }
    } catch (err) {
      toast(tr('操作失败：{msg}', { msg: (err && err.message) || err }));
    }
  });
}

/* ------------------------------ 分区注册表 ------------------------------ */

const GROUPS = [
  { id: 'base', label: tr('设置') },
  { id: 'feature', label: tr('功能') },
  { id: 'data', label: tr('数据与安全') },
  // 帮助单列一组：学习文档与「关于」都属于「先看说明 / 看版本」，不该混进数据与备份
  { id: 'help', label: tr('帮助') },
];

/**
 * 分区清单。新增一个分区只加一条：
 *   { id, group, label, icon, build: () => html, mount?: (paneEl) => void }
 * build 在打开面板时同步执行（只读内存里的 S），mount 在 DOM 插入后调用。
 */
/* ------------------------------ 分区：功能插件 ------------------------------ */

/**
 * 功能插件分区（原型 ① 开关）。
 *
 * 这里是「关闭态唯一常驻的工时 UI」：卡片本身必须在插件未启用时也能看到，
 * 否则用户永远找不到入口。卡片内的可选项只在启用后展开（与原型一致）。
 */
const WL_DEFAULTS = {
  enabled: false, zenDefaultSec: 5400, dayAttr: 'start',
};
const BUDDY_DEFAULTS = { enabled: false };

function wlChips(key, items, current) {
  return `<div class="wl-chips">${items.map(([v, label]) => `<button type="button"
    class="wl-chip${String(v) === String(current) ? ' is-active' : ''}"
    data-wl-pref="${esc(key)}" data-v="${esc(v)}">${label}</button>`).join('')}</div>`;
}

function pluginsCardHtml() {
  const p = { ...WL_DEFAULTS, ...(S.worklog || {}) };
  const on = !!p.enabled;
  return `<div class="st-card wl-set-card${on ? ' is-on' : ''}">
    <div class="wl-set-head">
      <div class="wl-set-ico">🕒</div>
      <div class="wl-set-main">
        <div class="wl-set-title">${tr('工时记录')} <span class="wl-badge">${tr('插件')}</span></div>
        <div class="wl-set-desc">${tr('给任务加上「开始 / 暂停 / 结束」计时，结果挂回任务；子任务时长自动向上累积成父任务合计，可按分组导出报工表。')}</div>
      </div>
      <label class="st-switch" title="${on ? tr('关闭工时插件') : tr('启用工时插件')}">
        <input type="checkbox" id="wl-enabled"${on ? ' checked' : ''} aria-label="${tr('启用工时记录')}">
        <span class="st-switch-track"><span class="st-switch-dot"></span></span>
      </label>
    </div>
    <div class="wl-set-body"${on ? '' : ' hidden'}>
      <div class="wl-field">
        <span class="wl-field-label">${tr('计时入口')}</span>
        <span class="wl-chip is-active is-static">${tr('任务行内 ▶ / ☯')}</span>
        <span class="wl-field-hint">${tr('鼠标移到任务上即可看到两个按钮：▶ 计时、☯ 禅模式')}</span>
      </div>
      <div class="wl-field">
        <span class="wl-field-label">${tr('禅模式默认')}</span>
        ${wlChips('zenDefaultSec', [[3600, tr('60 分钟')], [5400, tr('90 分钟')], [7200, tr('120 分钟')], [0, tr('不限时')]], p.zenDefaultSec)}
      </div>
      <div class="wl-field">
        <span class="wl-field-label">${tr('日期归属')}</span>
        <span class="wl-chip is-active is-static">${tr('按开始时间')}</span>
        <span class="wl-field-hint">${tr('跨天记录归属开始日，不切分')}</span>
      </div>
      <div class="wl-set-note">${on
    ? tr('已启用：任务行内出现 ▶ 计时与 ☯ 禅模式，计时中底部浮出「🕒 工时计时」条（与录制条同一形态），标题栏（「统计」右侧）的「工时」入口可看报工表。<br>关闭后计时与视图立即卸载、入口保留（点进去变成开启引导），历史记录留在数据库里，随时可再开启。')
    : tr('当前为关闭状态 —— 主进程未注册工时 IPC，未启动计时器，渲染层没有加载任何工时模块；标题栏入口保留，点进去是开启引导。')}</div>
    </div>
  </div>`;
}

function buddyCardHtml() {
  const p = { ...BUDDY_DEFAULTS, ...(S.buddy || {}) };
  const on = !!p.enabled;
  return `<div class="st-card wl-set-card${on ? ' is-on' : ''}">
    <div class="wl-set-head">
      <div class="wl-set-ico">🐮</div>
      <div class="wl-set-main">
        <div class="wl-set-title">${tr('工位搭子')} <span class="wl-badge">${tr('插件')}</span></div>
        <div class="wl-set-desc">${tr('今日进账 / 抽签 / 抱团 / 牛马卡，完成任务时搭子会冒一句。默认关闭，开启后才显示标题栏入口。')}</div>
      </div>
      <label class="st-switch" title="${on ? tr('关闭工位搭子插件') : tr('启用工位搭子插件')}">
        <input type="checkbox" id="buddy-enabled"${on ? ' checked' : ''} aria-label="${tr('启用工位搭子')}">
        <span class="st-switch-track"><span class="st-switch-dot"></span></span>
      </label>
    </div>
    <div class="wl-set-body"${on ? '' : ' hidden'}>
      <div class="wl-field">
        <span class="wl-field-label">${tr('标题栏入口')}</span>
        <span class="wl-chip is-active is-static">🐮 ${tr('搭子')}</span>
        <span class="wl-field-hint">${tr('紧跟在「🕒 工时」右侧，点开默认落在「搭子」页')}</span>
      </div>
      <div class="wl-field">
        <span class="wl-field-label">${tr('快捷唤起')}</span>
        <span class="wl-chip is-active is-static">Ctrl + Alt + E</span>
        <span class="wl-field-hint">${tr('插件关闭时该快捷键与菜单入口同样不生效')}</span>
      </div>
      <div class="wl-set-note">${on
    ? tr('已启用：标题栏出现「🐮 搭子」，趣味功能设置与浮窗已加载；关闭后入口、浮窗、样式与发币监听一起卸载，配置留在数据库里，随时可再开启。')
    : tr('当前为关闭状态 —— 标题栏入口隐藏，浮窗模块与样式未加载，不监听任务完成事件；只有这里能打开它。')}</div>
    </div>
  </div>`;
}

const JR_DEFAULTS = { enabled: false, cellLabels: [tr('心智'), tr('身体'), tr('连结'), tr('事业')].map((s) => tr(s)) };

function journalCardHtml() {
  const p = { ...JR_DEFAULTS, ...(S.journal || {}) };
  const on = !!p.enabled;
  // 库里存的出厂名是中文：英文态下列表要按位置换成英文，否则输入框里冒出中文默认值
  const zh = [tr('心智'), tr('身体'), tr('连结'), tr('事业')];
  const labels = (Array.isArray(p.cellLabels) && p.cellLabels.length === 4 ? p.cellLabels : zh)
    .map((s, i) => (String(s == null ? '' : s).trim() === zh[i] ? JR_DEFAULTS.cellLabels[i] : s));
  return `<div class="st-card wl-set-card jr-set-card${on ? ' is-on' : ''}" data-journal-card>
    <div class="wl-set-head">
      <div class="wl-set-ico">📔</div>
      <div class="wl-set-main">
        <div class="wl-set-title">${tr('四象日记')} <span class="wl-badge">${tr('插件')}</span></div>
        <div class="wl-set-desc">${tr('一天一页：心智 / 身体 / 连结 / 事业四格整理，白天随手丢碎碎念，晚上归到四格。按日回看，不打卡、不提醒。')}</div>
      </div>
      <label class="st-switch" title="${on ? tr('关闭日记插件') : tr('启用日记插件')}">
        <input type="checkbox" id="jr-enabled"${on ? ' checked' : ''} aria-label="${tr('启用四象日记')}">
        <span class="st-switch-track"><span class="st-switch-dot"></span></span>
      </label>
    </div>
    <div class="wl-set-body"${on ? '' : ' hidden'}>
      <div class="wl-field">
        <span class="wl-field-label">${tr('四格名称')}</span>
        <div class="jr-label-grid">
          ${labels.map((label, i) => `<label class="jr-label-row"><span class="jr-label-ix jr-ix-${i}">${i + 1}</span><input type="text" data-jr-label="${i}" value="${esc(label)}" maxlength="8" aria-label="${tr('第 {n} 格名称', { n: i + 1 })}"></label>`).join('')}
        </div>
        <span class="wl-field-hint">${tr('格子位置固定，只改名（如「工作 / 生活 / 学习 / 情绪」）；改名不影响历史内容。')}</span>
      </div>
      <div class="wl-set-note">${tr('日记只存在本地数据库，')}<b>${tr('不参与 AI 检索与报告')}</b>${tr('，也不进笔记的目录 / 标签。关闭后入口保留，历史记录全部留在库里；JSON 备份会带上日记。')}</div>
    </div>
  </div>`;
}

function pluginsHtml() {
  return `<section class="st-sec"
    data-search="功能插件 插件 工时 worklog 计时 报工 子任务 禅模式 行内计时 补录 搭子 鼓励器 牛马币 抽签 抱团 日记 journal 四格 碎碎念">
    <div class="st-sec-title">${tr('功能插件')}</div>
    <div class="st-sec-desc">${tr('默认全部关闭。关闭状态的插件不加载任何模块 —— 没有计时器、不监听事件、不注入样式；搭子入口随开关隐藏（工时 / 日记入口保留为开启引导），这里始终能看到开关。')}</div>
    <div class="wl-set-host">${pluginsCardHtml()}${buddyCardHtml()}${journalCardHtml()}</div>
  </section>`;
}

function repaintPlugins(paneEl) {
  const host = paneEl.querySelector('.wl-set-host');
  if (host) host.innerHTML = pluginsCardHtml() + buddyCardHtml() + journalCardHtml();
}

function mountPlugins(paneEl) {
  if (paneEl.dataset.wlPluginBound === '1') return;
  paneEl.dataset.wlPluginBound = '1';

  // 开关：主进程负责注册 / 注销，渲染层由 app.js 动态 mount / unmount
  paneEl.addEventListener('change', async (e) => {
    const sw = e.target.closest('#wl-enabled, #buddy-enabled, #jr-enabled');
    if (!sw) return;
    const isBuddy = sw.id === 'buddy-enabled';
    const isJournal = sw.id === 'jr-enabled';
    const name = isBuddy ? 'buddy' : (isJournal ? 'journal' : 'worklog');
    const want = sw.checked;
    sw.disabled = true;
    try {
      const r = await api.features.setPref(name, { enabled: want });
      if (!r || r.ok === false) throw new Error((r && r.reason) || tr('切换失败'));
      if (isBuddy) {
        S.buddy = r.pref;
        applyFunGate(document);
      } else if (isJournal) {
        S.journal = r.pref;
      } else {
        S.worklog = r.pref;
      }
      repaintPlugins(paneEl);
      toast(isBuddy
        ? (want
          ? tr('工位搭子插件已启用 · 标题栏出现「🐮 搭子」')
          : tr('工位搭子插件已关闭 · 入口与浮窗已卸载，配置保留'))
        : isJournal
          ? (want
            ? tr('四象日记已启用 · 标题栏出现「📔 日记」')
            : tr('日记插件已关闭 · 视图与样式已卸载，历史记录保留'))
          : (want
            ? tr('工时插件已启用 · 任务行内出现 ▶ 计时 / ☯ 禅模式')
            : tr('工时插件已关闭 · 计时与视图已卸载，历史记录保留')));
    } catch (err) {
      sw.checked = !want;
      sw.disabled = false;
      toast(tr('切换失败：{msg}', { msg: (err && err.message) || err }));
    }
  });

  // 配置项：改一项存一项（不需要「保存」按钮）
  paneEl.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-wl-pref]');
    if (!chip) return;
    const key = chip.dataset.wlPref;
    let value = chip.dataset.v;
    if (key === 'zenDefaultSec') value = Number(value);
    try {
      const r = await api.features.setPref({ [key]: value });
      if (!r || r.ok === false) throw new Error((r && r.reason) || tr('保存失败'));
      S.worklog = r.pref;
      repaintPlugins(paneEl);
    } catch (err) {
      toast(tr('保存失败：{msg}', { msg: (err && err.message) || err }));
    }
  });

  // 日记四格改名：改一项存一项，不重绘整个面板（重绘会丢其它输入框的焦点）
  paneEl.addEventListener('change', async (e) => {
    const inp = e.target.closest('[data-jr-label]');
    if (!inp) return;
    const i = Number(inp.dataset.jrLabel);
    const labels = (S.journal && S.journal.cellLabels ? S.journal.cellLabels.slice() : JR_DEFAULTS.cellLabels.slice());
    const v = inp.value.trim().slice(0, 8);
    if (v) labels[i] = v;
    else inp.value = labels[i];
    try {
      const r = await api.features.setPref('journal', { cellLabels: labels });
      if (!r || r.ok === false) throw new Error((r && r.reason) || tr('保存失败'));
      S.journal = r.pref;
      inp.value = labels[i];
      toast(tr('第 {n} 格已改为「{label}」', { n: i + 1, label: labels[i] }));
    } catch (err) {
      toast(tr('保存失败：{msg}', { msg: (err && err.message) || err }));
    }
  });
}

const PANES = [
  // 外观置顶：换主题是最常做、也最容易找不到的一件事（原来藏在「通用」里一个下拉框）
  { id: 'appearance', group: 'base', label: tr('外观'), icon: ICON.appearance, build: appearanceHtml, mount: mountAppearance },
  { id: 'general', group: 'base', label: tr('通用'), icon: ICON.general, build: generalHtml, mount: mountGeneral },
  { id: 'keys', group: 'base', label: tr('快捷键'), icon: ICON.keys, build: keysPaneHtml, mount: null },
  // 功能插件常驻第一位：默认全关，用户需要一个能找到开关的地方
  { id: 'plugins', group: 'feature', label: tr('功能插件'), icon: ICON.plugins, build: pluginsHtml, mount: mountPlugins },
  { id: 'ai', group: 'feature', label: tr('AI 与语音'), icon: ICON.ai, build: aiHtml, mount: mountAi },
  { id: 'calendar', group: 'feature', label: tr('日历'), icon: ICON.calendar, build: calendarHtml, mount: mountCalendar },
  { id: 'tools', group: 'feature', label: tr('工具'), icon: ICON.tools, build: toolsHtml, mount: mountTools },
  { id: 'fun', group: 'feature', label: tr('趣味功能'), icon: ICON.fun, build: funHtml, mount: mountFun },
  { id: 'data', group: 'data', label: tr('数据与备份'), icon: ICON.data, build: dataHtml, mount: mountData },
  // 帮助组：学习文档在「关于」之前 —— 找说明的人比看版本号的人多
  { id: 'docs', group: 'help', label: tr('学习文档'), icon: ICON.docs, build: docsHtml, mount: mountDocs },
  { id: 'about', group: 'help', label: tr('关于'), icon: ICON.about, build: aboutHtml, mount: mountAbout },
];

const PANE_IDS = PANES.map((p) => p.id);

/* ------------------------------ 壳层 ------------------------------ */

function navHtml() {
  return GROUPS.map((g) => {
    const items = PANES.filter((p) => p.group === g.id);
    if (!items.length) return '';
    return `<div class="st-group">
      <div class="st-group-label">${esc(tr(g.label))}</div>
      ${items.map((p) => `<button type="button" class="st-nav-item" data-nav="${p.id}">
        ${p.icon}<span class="st-nav-text">${esc(tr(p.label))}</span>
      </button>`).join('')}
    </div>`;
  }).join('');
}

function shellHtml() {
  return `<div class="st-shell">
    <aside class="st-nav">
      <label class="st-search">
        ${svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.4 13.4"/>')}
        <input id="st-search" type="search" placeholder="${esc(tr('搜索设置项'))}" autocomplete="off" spellcheck="false">
      </label>
      <div class="st-nav-scroll">${navHtml()}</div>
    </aside>
    <section class="st-content" id="st-content">
      ${PANES.map((p) => `<div class="st-pane" data-pane="${p.id}"${p.id === active ? '' : ' hidden'}>
        <div class="st-page-title">${esc(tr(p.label))}</div>
        ${p.build()}
      </div>`).join('')}
      <div class="st-empty" hidden>${esc(tr('没有找到匹配的设置项'))}</div>
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
      // data-search 是手写的中文关键词表（给中文态用）；英文态靠行内可见文案匹配，
      // 否则切成英文后搜 "salary" 什么都搜不到
      const hit = !needle || el.dataset.search.includes(needle)
        || el.textContent.toLowerCase().includes(needle);
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
  const [themeRaw, autoStart, taskDate, version, storage, backup, salary, ai, calendar, encourager, worklog, buddy, journal, locale] = await Promise.all([
    soft(api.theme.get(), null),
    soft(api.app.getAutoStart(), { enabled: false, supported: false, reason: tr('读取开机自启动状态失败') }),
    soft(api.ui.getToolPref('taskDate'), null),
    soft(api.app.getVersion(), ''),
    soft(api.env.getStorageInfo(), null),
    soft(api.env.getBackupInfo(), null),
    soft(api.ui.getSalary(), null),
    soft(api.ai.getConfig(), null),
    soft(api.ui.getToolPref('calendar'), null),
    soft(api.ui.getToolPref('encourager'), null),
    soft(api.features.pref(), null),
    soft(api.features.pref('buddy'), null),
    soft(api.features.pref('journal'), null),
    soft(api.i18n.get(), getLocaleNow()),
  ]);
  Object.assign(S, {
    // 老库 / 读取失败时回落出厂值，界面永远有东西可渲染
    theme: KT.normalize(themeRaw),
    autoStart, version, storage, backup, salary, ai, calendar, encourager,
    taskDate: taskDate && typeof taskDate === 'object' ? taskDate : null,
    locale: locale || getLocaleNow(),
    worklog: worklog || null,
    buddy: buddy || null,
    journal: journal || null,
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
    toast(tr('读取设置失败：{msg}', { msg: (e && e.message) || e }));
    return;
  }

  const remembered = (() => {
    try { return localStorage.getItem('settings-pane') || ''; } catch (e) { return ''; }
  })();
  active = PANE_IDS.includes(paneId) ? paneId
    : PANE_IDS.includes(remembered) ? remembered : 'general';
  query = '';

  // 返回弹窗的关闭 Promise：调用方（标题栏齿轮）靠它点亮 / 熄灭激活态
  return openPanelModal({
    title: tr('设置'),
    className: 'modal-settings',
    html: shellHtml(),
    showClose: true,
    // 设置是一张大表单：点外面就关掉，正在改的输入框、滚动位置、当前分区全没了，
    // 而且遮罩面积远大于面板，误触概率很高。只认 ✕（Esc 仍在，见 escGuard）。
    closeOnMask: false,
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

      // 页脚提示：与顶部标题栏呼应的底部栏左侧文字（样式见 styles.css 的 .st-foot-hint）
      const foot = mask.querySelector('.modal-foot');
      if (foot && !foot.querySelector('.st-foot-hint')) {
        const hint = document.createElement('span');
        hint.className = 'st-foot-hint';
        hint.textContent = tr('所有更改即时生效，无需保存');
        foot.insertBefore(hint, foot.firstChild);
      }

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
          try { p.mount(paneEl); } catch (e) { console.error(tr('[settings] 分区事件绑定失败：'), p.id, e); }
        }
      });

      applyFilter(root);
    },
    onClose: () => {
      disposeKeysPane();
    },
  });
}
