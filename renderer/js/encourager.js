'use strict';
/**
 * 上班鼓励器 · 主浮窗（薪资进账主界面）。
 *
 * 形态：主窗口内的模态浮窗（openPanelModal），五页签「搭子 / 抽签 / 抱团 / 卡片 / 设置」。
 * 内容区是宽屏两栏排布（搭子 / 卡片）或两列网格（抱团），目的是在常见视口下
 * 五个页签全部一屏看全、不出现滚动条；只有用户展开长列表时才在局部小区域滚动。
 * 月薪与班次读 tool.salary：既可在浮窗内「设置」页签直接填（首次使用的主入口），
 * 也可在「设置 → 趣味功能 → 薪资与班次」里改，两处是同一份配置。
 * 数值统一由 salary-core.js 的 computeSalary() 计算，不在本模块另算一笔钱。
 *
 * 为什么薪资表单内嵌而不是点按钮跳设置中心：两个 openPanelModal 叠加时，Esc 会在
 * document 捕获阶段被两层同时接住，一次按键把两层都关掉；内嵌页签零叠加，且填完
 * 顶部 hero 立刻跳数字，反馈更直接。
 *
 * 依赖注入 toast / getStats，不反向 import ui.js（会形成循环依赖）。
 * 铁律： CSP 没有 blob: → 卡片只用 canvas.toDataURL()；计时用 wall-clock 重算，
 * 不累加快照；牛马币节点不参与每秒刷新（FR-18）。
 */
import { api } from './api.js';
import { openPanelModal } from './modal.js';
import {
  normalizeConfig, applyDailyCheck, awardTask, computeNumbers,
  CARD_THEMES, currentThemeKey,
} from './encourager-core.js';
import { FORTUNE_LEVELS, fortuneFor, hashStr } from './encdata/fortunes.js';
import { TONES, BUDDY_LINES, CROWD_LINES, phaseOf, pickLine } from './encdata/buddy-lines.js';
import { localDateStr, isWeekend, fmtHM } from './salary-core.js';

/* ---------------- 依赖注入 ---------------- */

let notify = () => {};
let getStats = () => ({ done: 0, total: 0, titles: [] });

export function setEncouragerHandlers({ toast, getStats: gs } = {}) {
  if (typeof toast === 'function') notify = toast;
  if (typeof gs === 'function') getStats = gs;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const TABS = [['buddy', '搭子'], ['fortune', '抽签'], ['crowd', '抱团'], ['card', '卡片'], ['settings', '设置']];
const MOOD = {
  before: 'sleep', morning: 'work', noon: 'eat', afternoon: 'sleepy',
  nearEnd: 'hype', after: 'wave', weekend: 'rest',
};

/* ---------------- 运行时状态 ---------------- */

let cfg = normalizeConfig(null);
let salaryCfg = { monthly: 0, start: '09:00', end: '18:00' };
let openMask = null;
let ticker = null;
let activeTab = 'buddy';
let purchaseIdx = 0;
let cardDataUrl = '';
let lastPhase = '';
let pendingDone = [];
let doneFlushTimer = null;
let speechTimer = null;
let pendingSpeech = '';
let salarySaveTimer = null;

/* ---------------- 小工具 ---------------- */

const money = (n, d) => (Number(n) || 0).toFixed(d);
const todayStr = () => localDateStr(new Date());

function setText(mask, key, value) {
  const el = mask && mask.querySelector(`[data-enc="${key}"]`);
  if (el && el.textContent !== String(value)) el.textContent = String(value);
}

function currentFortune() {
  return fortuneFor(todayStr());
}

function noteOf(f) {
  const list = (f && f.notes) || [''];
  return list[((cfg.fortune.noteIndex || 0) % list.length + list.length) % list.length];
}

function buddyLines() {
  return BUDDY_LINES[cfg.buddy.tone] || BUDDY_LINES.warm;
}

function buddySvg(phase) {
  const mood = MOOD[phase] || 'work';
  const eyes = {
    sleep: '<path d="M40 50 q7 6 14 0 M66 50 q7 6 14 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    work: '<circle cx="47" cy="49" r="3.6" fill="currentColor"/><circle cx="73" cy="49" r="3.6" fill="currentColor"/>',
    eat: '<path d="M40 50 q7 -6 14 0 M66 50 q7 -6 14 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    sleepy: '<path d="M40 50 h14 M66 50 h14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    hype: '<circle cx="47" cy="48" r="4.4" fill="currentColor"/><circle cx="73" cy="48" r="4.4" fill="currentColor"/>',
    wave: '<path d="M40 49 q7 6 14 0 M66 49 q7 6 14 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    rest: '<path d="M40 50 q7 6 14 0 M66 50 q7 6 14 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  };
  const mouths = {
    sleep: '<path d="M54 68 h12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    work: '<path d="M54 68 q6 5 12 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    eat: '<ellipse cx="60" cy="69" rx="6" ry="4" fill="currentColor" opacity=".8"/>',
    sleepy: '<path d="M54 69 h12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    hype: '<path d="M52 66 q8 10 16 0 z" fill="currentColor" opacity=".85"/>',
    wave: '<path d="M52 66 q8 9 16 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    rest: '<path d="M54 68 q6 4 12 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  };
  return `<svg class="enc-moo" viewBox="0 0 120 108" aria-hidden="true">
    <path d="M24 36 L16 18 L40 28 Z" fill="var(--enc-green)" opacity=".85"/>
    <path d="M96 36 L104 18 L80 28 Z" fill="var(--enc-green)" opacity=".85"/>
    <rect x="18" y="26" width="84" height="70" rx="26" fill="var(--enc-panel2)" stroke="var(--enc-green)" stroke-width="3"/>
    ${eyes[mood]}${mouths[mood]}
    <circle cx="32" cy="66" r="3.4" fill="var(--enc-green)" opacity=".45"/>
    <circle cx="88" cy="66" r="3.4" fill="var(--enc-green)" opacity=".45"/>
    <path d="M60 96 v8" stroke="var(--enc-green)" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
}

function crowdForToday() {
  const seed = todayStr();
  const picked = [];
  const used = new Set();
  for (let i = 0; i < 24 && picked.length < 6; i += 1) {
    const h = hashStr(`${seed}#${i}`);
    const line = CROWD_LINES[h % CROWD_LINES.length];
    if (used.has(line.who)) continue;
    used.add(line.who);
    picked.push(line);
  }
  return picked;
}

/* ---------------- 数据 ---------------- */

async function persist() {
  cfg = normalizeConfig(cfg);
  try { await api.ui.setToolPref('encourager', cfg); } catch (e) {
    notify(`鼓励器配置保存失败：${(e && e.message) || e}`);
  }
}

async function readSalary() {
  const sal = await api.ui.getSalary().catch(() => null);
  salaryCfg = {
    monthly: Math.max(0, Number(sal && sal.monthly) || 0),
    start: String((sal && sal.start) || '09:00'),
    end: String((sal && sal.end) || '18:00'),
  };
}

/** 打开时：读配置 → 每日打卡 +5 / 连续奖励 → 跨天重抽签 → 落库 */
async function loadAll() {
  const [raw] = await Promise.all([api.ui.getToolPref('encourager').catch(() => null), readSalary()]);
  const checked = applyDailyCheck(raw, new Date());
  cfg = checked.cfg;
  const now = new Date();
  if (!isWeekend(now)) {
    const f = fortuneFor(todayStr());
    if (cfg.fortune.date !== todayStr() || cfg.fortune.id !== f.id) {
      cfg.fortune = { date: todayStr(), id: f.id, noteIndex: 0 };
      checked.changed = true;
    }
  }
  if (checked.changed) await persist();
}

/** 设置面板改了配置：只重读，不重新打卡（避免把刚发的币覆盖掉） */
async function reloadConfig() {
  const raw = await api.ui.getToolPref('encourager').catch(() => null);
  cfg = normalizeConfig(raw);
  await readSalary();
  if (openMask && openMask.isConnected) {
    paintHud(openMask);
    paintLive(openMask, true);
    // 设置中心改了薪资 → 主浮窗「设置」页签的值要跟上（正在输入的那个框不覆盖）
    paintSalaryForm(openMask);
    if (activeTab === 'card') renderCardPreview(openMask, readCardOpts(openMask));
  }
}

/* ---------------- DOM 骨架 ---------------- */

function shellHtml() {
  const f = currentFortune();
  const lv = FORTUNE_LEVELS[f.level] || FORTUNE_LEVELS.mid;
  const weekend = isWeekend(new Date());
  const fortuneCard = weekend
    ? `<div class="enc-fortune-card is-rest">
        <div class="enc-fortune-level">休息日</div>
        <div class="enc-fortune-main">今天不用上班</div>
        <div class="enc-fortune-note">这条是自动发的：周末不抽签、不发币。</div>
        <div class="enc-fortune-id">${esc(todayStr())}</div>
      </div>`
    : `<div class="enc-fortune-card" data-enc="fortune-card">
        <div class="enc-fortune-level">${esc(lv.label)}</div>
        <div class="enc-fortune-main"><i>宜</i>${esc(f.yi)}</div>
        <div class="enc-fortune-main enc-ji"><i>忌</i>${esc(f.ji)}</div>
        <div class="enc-fortune-note" data-enc="fortune-note">${esc(noteOf(f))}</div>
        <div class="enc-fortune-id">${esc(f.id)} · ${esc(todayStr())}</div>
      </div>
      <button type="button" class="enc-btn" data-enc-act="reword">换个说法</button>`;
  return `
  <div class="enc">
    <section class="enc-hero">
      <div class="enc-hero-head">
        <span class="enc-badge" data-enc="badge">在岗</span>
        <span class="enc-date" data-enc="date"></span>
      </div>
      <div class="enc-amount-label">今日已赚</div>
      <div class="enc-amount" data-enc="amount"><span class="enc-cny">¥</span><span class="enc-today" data-enc="today">0.000</span></div>
      <div class="enc-hero-sub"><span data-enc="persec"></span><span class="enc-sep">·</span><span data-enc="expected"></span></div>
      <div class="enc-progress"><div class="enc-progress-fill" data-enc="progress"></div></div>
      <div class="enc-progress-meta"><span data-enc="phase"></span><span data-enc="left"></span></div>
      <div class="enc-guide" data-enc="guide" hidden>
        <div class="enc-guide-main">
          <div class="enc-guide-k">⚙ 第一次用？先填一下薪资</div>
          <div class="enc-guide-txt">填月薪和上下班时间，这里就会每秒进账；不填就一直是 0。</div>
        </div>
        <div class="enc-guide-actions">
          <button type="button" class="enc-btn enc-btn-primary" data-enc-act="salary-settings">去填薪资 →</button>
          <span class="enc-guide-path">也可到 设置 → 趣味功能 → 薪资与班次</span>
        </div>
      </div>
    </section>

    <section class="enc-hud">
      <div class="enc-hud-cell enc-hud-coin" data-enc="coin-cell">
        <span class="enc-hud-k">牛马币</span>
        <span class="enc-hud-v" data-enc="coins">0</span><span class="enc-hud-unit">币</span>
      </div>
      <div class="enc-hud-cell"><span class="enc-hud-k">连续打卡</span>
        <span class="enc-hud-v" data-enc="streak">0</span><span class="enc-hud-unit">天</span></div>
      <div class="enc-hud-cell"><span class="enc-hud-k">今日完成</span>
        <span class="enc-hud-v" data-enc="done">0</span><span class="enc-hud-unit">件</span></div>
    </section>
    <div class="enc-coin-note" data-enc="coin-note">牛马币 · 只换皮肤，不换钱</div>

    <nav class="enc-tabs" role="tablist">
      ${TABS.map(([k, label]) => `<button type="button" role="tab"
        class="${['enc-tab', k === activeTab ? 'is-active' : ''].filter(Boolean).join(' ')}"
        data-tab="${k}">${label}</button>`).join('')}
    </nav>

    <div class="enc-panes">
      <section class="enc-pane" data-pane="buddy">
        <div class="enc-buddy">
          <div class="enc-buddy-left">
            <button type="button" class="enc-moo-btn" data-enc-act="poke" title="戳一戳" aria-label="戳一戳搭子">
              <span data-enc="moo">${buddySvg('morning')}</span>
            </button>
            <div class="enc-speech" data-enc="speech">今天也从一个任务开始吧。</div>
            <div class="enc-tone-row">
              <span class="enc-mini-label">语气</span>
              ${TONES.map((t) => `<button type="button"
                class="${['enc-tone', t.id === cfg.buddy.tone ? 'is-active' : ''].filter(Boolean).join(' ')}"
                data-tone="${t.id}">${t.label}</button>`).join('')}
            </div>
          </div>
          <div class="enc-buddy-right">
            <div class="enc-facts">
              <div class="enc-fact"><span>每小时</span><b data-enc="hourly">¥0.00</b></div>
              <div class="enc-fact"><span>购买力</span>
                <button type="button" class="enc-fact-btn" data-enc="purchase" data-enc-act="next-purchase" title="点一下换物件">—</button></div>
              <div class="enc-fact"><span>下一个休息</span><b data-enc="rest">—</b></div>
            </div>
            <div class="enc-pane-note">戳一下小牛马它会回你一句；完成一个任务也会冒一句，不遮挡任务列表。</div>
          </div>
        </div>
      </section>

      <section class="enc-pane" data-pane="fortune" hidden>
        <div class="enc-fortune">
          ${fortuneCard}
          <div class="enc-pane-note">每天一支，按本地日期确定性生成；同一天重复打开不会重抽。「换个说法」只换短评。</div>
        </div>
      </section>

      <section class="enc-pane" data-pane="crowd" hidden>
        <div class="enc-crowd">
          <div class="enc-crowd-head">纯牛马抱团所 · 本地分部</div>
          <div class="enc-pane-note">这是纯本地应用：没有在线弹幕，也没有鱼友。下面是一批写死的虚构同事留言，按日期变化，营造「不是我一个人」。</div>
          <div class="enc-crowd-list">
            ${crowdForToday().map((x) => `<div class="enc-crowd-item">
              <span class="enc-crowd-who">${esc(x.who)}</span>
              <span class="enc-crowd-text">${esc(x.text)}</span>
            </div>`).join('')}
          </div>
        </div>
      </section>

      <section class="enc-pane" data-pane="card" hidden>
        <div class="enc-card">
          <div class="enc-card-preview"><img data-enc="card-img" alt="今日牛马卡预览" hidden /></div>
          <div class="enc-card-side">
            <div class="enc-card-theme" data-enc="card-theme"></div>
            <label class="enc-check"><input type="checkbox" data-enc="share-amount"${cfg.privacy.shareAmount ? ' checked' : ''} /> 卡片显示真实金额</label>
            <label class="enc-check"><input type="checkbox" data-enc="share-titles"${cfg.share.includeTaskTitles ? ' checked' : ''} /> 卡片显示任务标题</label>
            <div class="enc-title-picker" data-enc="title-picker"${cfg.share.includeTaskTitles ? '' : ' hidden'}></div>
            <div class="enc-card-confirm" data-enc="card-confirm" hidden></div>
            <div class="enc-card-actions">
              <button type="button" class="enc-btn enc-btn-primary" data-enc-act="save-card">保存卡片 PNG</button>
              <button type="button" class="enc-btn" data-enc-act="copy-card" hidden>复制文案</button>
            </div>
            <div class="enc-card-msg" data-enc="card-msg"></div>
            <div class="enc-pane-note">默认不含真实金额、不含任务标题。想晒具体成果需主动勾选并二次确认；卡片按生成瞬间的当前主题出图。</div>
          </div>
        </div>
      </section>

      <section class="enc-pane" data-pane="settings" hidden>
        <div class="enc-setup">
          <div class="enc-setup-head">薪资与班次</div>
          <div class="enc-setup-desc">月薪 ÷ 当月工作日 ÷ 每日工时 = 每秒进账；只统计上班到下班区间内的在岗时间。数据只存在本机。</div>
          <label class="enc-field">
            <span>月薪（元）</span>
            <input type="number" min="0" step="100" data-enc-salary="monthly" placeholder="例如 12000" />
          </label>
          <div class="enc-field-row">
            <label class="enc-field"><span>上班时间</span><input type="time" data-enc-salary="start" /></label>
            <label class="enc-field"><span>下班时间</span><input type="time" data-enc-salary="end" /></label>
          </div>
          <div class="enc-setup-state" data-enc="salary-msg"></div>
          <div class="enc-pane-note">改动即时保存，没有「保存」按钮；上方「今日已赚」会立刻重算。<br>同一份配置也可在「设置 → 趣味功能 → 薪资与班次」里修改，两处改的是同一个地方，不会各算一笔钱。<br>主题跟随应用明暗，唯一入口在「设置 → 通用 → 界面主题」。</div>
        </div>
      </section>
    </div>
  </div>`;
}

/* ---------------- 打开 / 关闭 ---------------- */

export async function openEncourager(opts = {}) {
  if (openMask && openMask.isConnected) {
    if (opts.tab) switchTab(openMask, opts.tab);
    const active = openMask.querySelector('.enc-tab.is-active');
    if (active) active.focus();
    return;
  }
  await loadAll();
  activeTab = TABS.some(([k]) => k === opts.tab) ? opts.tab : 'buddy';
  lastPhase = '';
  pendingSpeech = '';
  cardDataUrl = '';

  await openPanelModal({
    title: '工位搭子 · 上班鼓励器',
    className: 'modal-encourager',
    headHtml: `<button type="button" class="enc-head-btn enc-head-salary" data-enc-act="salary-settings" title="薪资设置：填写月薪与上下班时间" aria-label="薪资设置">⚙</button>`,
    html: shellHtml(),
    okText: '关闭',
    showClose: true,
    onMount: (mask) => {
      openMask = mask;
      bindEvents(mask);
      buildTitlePicker(mask);
      switchTab(mask, activeTab);
      paintHud(mask);
      paintLive(mask, true);
      paintSalaryForm(mask);
      startTicker();
      if (pendingSpeech) { showSpeech(mask, pendingSpeech); pendingSpeech = ''; }
      maybeCoinHint(mask);
    },
    onClose: () => {
      stopTicker();
      clearTimeout(salarySaveTimer);
      salarySaveTimer = null;
      openMask = null;
      cardDataUrl = '';
    },
  });
}

function maybeCoinHint(mask) {
  if (!cfg.coinsEnabled || cfg.coinHintShown) return;
  cfg.coinHintShown = true;
  persist();
  notify('牛马币 · 只换皮肤，不换钱；完成一个任务 +10 币');
  const note = mask.querySelector('[data-enc="coin-note"]');
  if (note) note.classList.add('is-hint');
}

/* ---------------- 事件 ---------------- */

export function listenEncouragerMenu() {
  api.on('ui:encourager', (payload) => {
    openEncourager(payload || {}).catch((e) => notify(`打开上班鼓励器失败：${(e && e.message) || e}`));
  });
  api.on('ui:encourager-card', () => {
    openEncourager({ tab: 'card' }).catch((e) => notify(`打开今日牛马卡失败：${(e && e.message) || e}`));
  });
  document.addEventListener('app:task-completed', onTaskCompleted);
  document.addEventListener('app:encourager-config', () => { reloadConfig().catch(() => {}); });
  document.addEventListener('app:theme-changed', () => {
    if (openMask && activeTab === 'card') renderCardPreview(openMask, readCardOpts(openMask));
  });
}

function bindEvents(mask) {
  mask.addEventListener('click', (e) => {
    const tab = e.target.closest('.enc-tab');
    if (tab) { switchTab(mask, tab.dataset.tab); return; }
    const tone = e.target.closest('[data-tone]');
    if (tone) { setTone(mask, tone.dataset.tone); return; }
    const act = e.target.closest('[data-enc-act]');
    if (!act) return;
    switch (act.dataset.encAct) {
      case 'salary-settings': openSalaryTab(mask); break;
      case 'poke': poke(mask); break;
      case 'next-purchase': cyclePurchase(mask); break;
      case 'reword': reword(mask); break;
      case 'save-card': onSaveCard(mask); break;
      case 'copy-card': onCopyCard(mask); break;
      case 'confirm-save': doSaveCard(mask); break;
      case 'cancel-save': hideConfirm(mask); break;
      default: break;
    }
  });
  // 薪资表单：边输入边自动保存（与设置中心一致，没有「保存」按钮）
  mask.addEventListener('input', (e) => {
    if (e.target.matches('[data-enc-salary]')) saveSalaryFromForm(mask, true);
  });
  mask.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-enc="share-amount"]') || t.matches('[data-enc="share-titles"]')) onCardOptionChange(mask);
    if (t.matches('[data-enc="title-check"]')) { hideConfirm(mask); renderCardPreview(mask, readCardOpts(mask)); }
    if (t.matches('[data-enc-salary]')) saveSalaryFromForm(mask, false);
  });
}

function switchTab(mask, tab) {
  if (!TABS.some(([k]) => k === tab)) tab = 'buddy';
  activeTab = tab;
  mask.querySelectorAll('.enc-tab').forEach((el) => el.classList.toggle('is-active', el.dataset.tab === tab));
  mask.querySelectorAll('.enc-pane').forEach((el) => { el.hidden = el.dataset.pane !== tab; });
  if (tab === 'card') renderCardPreview(mask, readCardOpts(mask));
  if (tab === 'settings') paintSalaryForm(mask);
}

function setTone(mask, tone) {
  if (!TONES.some((t) => t.id === tone)) return;
  cfg.buddy.tone = tone;
  persist();
  mask.querySelectorAll('.enc-tone').forEach((el) => el.classList.toggle('is-active', el.dataset.tone === tone));
  showSpeech(mask, pickLine(buddyLines().phases[phaseOf(new Date(), salaryCfg)] || [], `${todayStr()}#${tone}`) || '我在呢。');
}

function poke(mask) {
  const line = pickLine(buddyLines().poke, `${Date.now()}#poke`);
  showSpeech(mask, line);
  const fig = mask.querySelector('.enc-moo-btn');
  if (fig) {
    fig.classList.remove('is-poked');
    void fig.offsetWidth;
    fig.classList.add('is-poked');
  }
}

function showSpeech(mask, text, ms = 3200) {
  if (!mask || !mask.isConnected) {
    pendingSpeech = text;
    return;
  }
  clearTimeout(speechTimer);
  setText(mask, 'speech', text);
  const box = mask.querySelector('.enc-speech');
  if (box) box.classList.add('is-fresh');
  speechTimer = setTimeout(() => {
    const live = mask.isConnected ? mask : null;
    if (!live) return;
    const n = computeNumbers(cfg, salaryCfg, new Date());
    const line = pickLine(buddyLines().phases[n.phase] || [], `${todayStr()}#${n.phase}`) || '我在呢。';
    setText(live, 'speech', line);
    live.querySelector('.enc-speech')?.classList.remove('is-fresh');
  }, ms);
}

function cyclePurchase(mask) {
  const list = computeNumbers(cfg, salaryCfg, new Date()).purchase || [];
  if (!list.length) return;
  purchaseIdx = (purchaseIdx + 1) % list.length;
  paintPurchase(mask, list);
}

function reword(mask) {
  const f = currentFortune();
  cfg.fortune.noteIndex = ((cfg.fortune.noteIndex || 0) + 1) % Math.max(1, (f.notes || []).length);
  persist();
  setText(mask, 'fortune-note', noteOf(f));
  const card = mask.querySelector('[data-enc="fortune-card"]');
  if (card) {
    card.classList.remove('is-flip');
    void card.offsetWidth;
    card.classList.add('is-flip');
  }
}

/* ---------------- 薪资设置（浮窗内「设置」页签） ---------------- */

/** 引导卡 / 头部 ⚙ 的统一入口：切到浮窗内「设置」页签并聚焦第一个输入框 */
function openSalaryTab(mask) {
  switchTab(mask, 'settings');
  const first = mask.querySelector('[data-enc-salary="monthly"]');
  if (first) first.focus();
}

function setSalaryMsg(mask, text, ok = true) {
  const el = mask.querySelector('[data-enc="salary-msg"]');
  if (!el) return;
  el.textContent = text;
  el.dataset.state = ok ? 'ok' : 'warn';
}

/** 回填表单：正在输入的那个框不覆盖，否则光标会被打回开头 */
function paintSalaryForm(mask) {
  const fill = (k, v) => {
    const el = mask.querySelector(`[data-enc-salary="${k}"]`);
    if (el && document.activeElement !== el) el.value = v;
  };
  fill('monthly', salaryCfg.monthly ? String(salaryCfg.monthly) : '');
  fill('start', salaryCfg.start || '09:00');
  fill('end', salaryCfg.end || '18:00');
  const ok = computeNumbers(cfg, salaryCfg, new Date()).hasSalary;
  setSalaryMsg(mask, ok ? '已配置 · 上方数字正在实时更新' : '还没填月薪，填好后这里就开始进账', ok);
}

/** 读表单；time 控件被清空时补回默认班次，避免「框是空的却在算钱」 */
function readSalaryForm(mask) {
  const el = (k) => mask.querySelector(`[data-enc-salary="${k}"]`);
  const m = el('monthly');
  const s = el('start');
  const e = el('end');
  const start = (s && s.value) || '09:00';
  const end = (e && e.value) || '18:00';
  if (s && !s.value) s.value = start;
  if (e && !e.value) e.value = end;
  return { monthly: Math.max(0, Number(m && m.value) || 0), start, end };
}

/** 与设置中心共用 tool.salary；写完就地重算，不派发 app:encourager-config（避免回填打断输入） */
function saveSalaryFromForm(mask, silent) {
  clearTimeout(salarySaveTimer);
  salarySaveTimer = setTimeout(async () => {
    const next = readSalaryForm(mask);
    try {
      const saved = await api.ui.setSalary(next);
      salaryCfg = {
        monthly: Math.max(0, Number(saved && saved.monthly) || 0),
        start: String((saved && saved.start) || '09:00'),
        end: String((saved && saved.end) || '18:00'),
      };
      if (!mask.isConnected) return;
      paintLive(mask, true);       // 顶部数字 + 引导卡显隐立刻跟上
      if (activeTab === 'card') renderCardPreview(mask, readCardOpts(mask));
      const ok = computeNumbers(cfg, salaryCfg, new Date()).hasSalary;
      setSalaryMsg(mask, ok ? '已保存 · 上方数字正在实时更新' : '已保存 · 填好月薪与班次后开始进账', ok);
      if (!silent) notify('薪资与班次已保存');
    } catch (e) {
      if (mask.isConnected) setSalaryMsg(mask, `保存失败：${(e && e.message) || e}`, false);
    }
  }, 400);
}

/* ---------------- 任务完成 → 发币 + 回应 ---------------- */

function onTaskCompleted(e) {
  const id = e && e.detail ? e.detail.id : null;
  if (id == null) return;
  const r = awardTask(cfg, id);
  if (!r.changed) return;
  cfg = r.cfg;
  persist();
  pendingDone.push(id);
  clearTimeout(doneFlushTimer);
  doneFlushTimer = setTimeout(flushDone, 600); // 批量完成合并为一条，不刷屏
}

function flushDone() {
  const n = pendingDone.length;
  pendingDone = [];
  if (!n) return;
  const stats = getStats();
  const lines = buddyLines().done;
  const idx = Math.min(lines.length - 1, Math.floor(Math.max(0, (stats.done || 1) - 1) / 3));
  const text = `${lines[idx]}${n > 1 ? `（一口气完成 ${n} 件）` : ''} 牛马币 +${n * 10}`;
  if (openMask && openMask.isConnected) {
    paintHud(openMask);
    showSpeech(openMask, text);
    const cell = openMask.querySelector('[data-enc="coin-cell"]');
    if (cell) {
      cell.classList.remove('is-bump');
      void cell.offsetWidth;
      cell.classList.add('is-bump');
    }
  } else {
    notify(text); // 应用内 toast，不弹系统通知、不遮挡任务列表
  }
}

/* ---------------- 每秒刷新（只改文本节点） ---------------- */

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    if (!openMask || !openMask.isConnected) { stopTicker(); return; }
    if (document.hidden) return; // 隐藏停刷，恢复可见时按 Date.now() 重算
    paintLive(openMask);
  }, 1000);
  document.addEventListener('visibilitychange', onVisibility);
}

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
  document.removeEventListener('visibilitychange', onVisibility);
}

function onVisibility() {
  if (!document.hidden && openMask && openMask.isConnected) paintLive(openMask, true);
}

function paintHud(mask) {
  const stats = getStats();
  setText(mask, 'coins', cfg.coinsEnabled ? String(cfg.coins) : '—');
  setText(mask, 'streak', String(cfg.streak));
  setText(mask, 'done', String(stats.done));
  const cell = mask.querySelector('[data-enc="coin-cell"]');
  const note = mask.querySelector('[data-enc="coin-note"]');
  if (cell) cell.hidden = !cfg.coinsEnabled;
  if (note) note.hidden = !cfg.coinsEnabled;
}

function paintPurchase(mask, list) {
  if (!list || !list.length) { setText(mask, 'purchase', '—'); return; }
  const p = list[Math.min(purchaseIdx, list.length - 1)];
  setText(mask, 'purchase', `够买 ${p.count} ${p.name} · 余 ¥${money(p.rest, 3)}`);
}

function paintLive(mask, force = false) {
  if (!mask || !mask.isConnected) return;
  const n = computeNumbers(cfg, salaryCfg, new Date());
  const amount = mask.querySelector('[data-enc="amount"]');
  const guide = mask.querySelector('[data-enc="guide"]');
  if (amount) amount.hidden = !n.hasSalary;
  if (guide) guide.hidden = n.hasSalary;

  if (n.hasSalary) {
    setText(mask, 'today', money(n.today, 3));
    setText(mask, 'persec', `每秒进账 ¥${money(n.perSec, 5)}`);
    setText(mask, 'expected', `今日预计 ¥${money(n.expected, 2)}`);
    setText(mask, 'hourly', `¥${money(n.hourly, 2)}`);
    paintPurchase(mask, n.purchase);
  } else {
    setText(mask, 'persec', '');
    setText(mask, 'expected', '填好月薪后开始计算');
    setText(mask, 'hourly', '—');
    setText(mask, 'purchase', '—');
  }

  const rest = n.rest;
  setText(mask, 'rest', rest.isToday ? '就是今天' : `${rest.days}天${String(rest.h).padStart(2, '0')}:${String(rest.m).padStart(2, '0')}:${String(rest.s).padStart(2, '0')}`);

  const badge = mask.querySelector('[data-enc="badge"]');
  if (badge) {
    const label = n.status === 'weekend' ? '今天不用上班'
      : n.status === 'before' ? '还没到点'
        : n.status === 'after' ? '已下班' : '在岗';
    if (badge.textContent !== label) badge.textContent = label;
    badge.dataset.state = n.status;
  }
  setText(mask, 'date', `${todayStr()} · ${fmtHM(new Date().getHours() * 60 + new Date().getMinutes())}`);
  setText(mask, 'phase', n.status === 'weekend' ? '今天不用上班'
    : n.status === 'before' ? '距离上班还有一会儿'
      : n.status === 'after' ? '今日工时已满' : `下班进度 ${n.progress.toFixed(0)}%`);
  setText(mask, 'left', n.status === 'working' ? `已上班 ${Math.floor(n.elapsedMin / 60)} 小时 ${Math.floor(n.elapsedMin % 60)} 分` : '');

  const fill = mask.querySelector('[data-enc="progress"]');
  if (fill) fill.style.width = `${n.progress.toFixed(2)}%`;

  if (force || n.phase !== lastPhase) {
    lastPhase = n.phase;
    const moo = mask.querySelector('[data-enc="moo"]');
    if (moo) moo.innerHTML = buddySvg(n.phase);
    const line = pickLine(buddyLines().phases[n.phase] || [], `${todayStr()}#${n.phase}`) || '我在呢。';
    const speech = mask.querySelector('.enc-speech');
    if (speech && !speech.classList.contains('is-fresh')) setText(mask, 'speech', line);
  }
}

/* ---------------- 今日牛马卡（1080 × 1440 PNG） ---------------- */

async function buildTitlePicker(mask) {
  const box = mask.querySelector('[data-enc="title-picker"]');
  if (!box) return;
  // 直接查库里的「今天完成」：state.tasks 只覆盖当前视图，靠它取标题会漏
  let titles = [];
  try {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const list = await api.tasks.list({ status: 'completed', completedFrom: d.toISOString() });
    titles = (list || []).filter((t) => t && t.title).slice(0, 20)
      .map((t) => ({ id: t.id, title: String(t.title).slice(0, 60) }));
  } catch (e) {
    titles = getStats().titles || [];
  }
  if (!mask.isConnected) return;
  box.innerHTML = titles.length
    ? `<div class="enc-mini-label">选择要晒出来的成果（默认全不选）</div>${titles.map((t) => `<label class="enc-check"><input type="checkbox" data-enc="title-check" data-title="${esc(t.title)}" /> ${esc(t.title)}</label>`).join('')}`
    : '<div class="enc-pane-note">今天还没有已完成的任务标题可选。</div>';
}

function selectedTitles(mask) {
  if (!mask.querySelector('[data-enc="share-titles"]')?.checked) return [];
  return [...mask.querySelectorAll('[data-enc="title-check"]:checked')].map((el) => el.dataset.title || '');
}

function readCardOpts(mask) {
  return {
    amount: !!mask.querySelector('[data-enc="share-amount"]')?.checked,
    titles: selectedTitles(mask),
  };
}

function onCardOptionChange(mask) {
  const picker = mask.querySelector('[data-enc="title-picker"]');
  const on = !!mask.querySelector('[data-enc="share-titles"]')?.checked;
  if (picker) picker.hidden = !on;
  hideConfirm(mask);
  renderCardPreview(mask, readCardOpts(mask));
}

function showCardMsg(mask, text) {
  setText(mask, 'card-msg', text);
}

/** 生成 / 写文件失败时的降级入口。按钮是 data-enc-act，别按 data-enc 找；找不到也不能抛 */
function showCopyFallback(mask, on) {
  const btn = mask.querySelector('[data-enc-act="copy-card"]');
  if (btn) btn.hidden = !on;
}

function renderCardPreview(mask, opts) {
  const img = mask.querySelector('[data-enc="card-img"]');
  if (!img) return false;
  try {
    cardDataUrl = drawCard(opts);
    img.src = cardDataUrl; // data URL，CSP 已放行 img-src data:
    img.hidden = false;
    const theme = currentThemeKey();
    setText(mask, 'card-theme', `按当前主题出图：${theme === 'dark' ? '深色版' : '浅色版'}`);
    showCopyFallback(mask, false);
    return true;
  } catch (e) {
    showCardMsg(mask, `卡片生成失败：${(e && e.message) || e}。可点「复制文案」。`);
    showCopyFallback(mask, true);
    return false;
  }
}

function hideConfirm(mask) {
  const box = mask.querySelector('[data-enc="card-confirm"]');
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

function onSaveCard(mask) {
  const opts = readCardOpts(mask);
  if (opts.amount || opts.titles.length) {
    const box = mask.querySelector('[data-enc="card-confirm"]');
    if (box) {
      box.innerHTML = `<div class="enc-confirm-title">再确认一次</div>
        <div class="enc-confirm-body">${opts.amount ? '这张卡会包含真实金额。' : ''}${opts.titles.length ? `还会写入 ${opts.titles.length} 条任务标题：` : ''}</div>
        ${opts.titles.length ? `<ul class="enc-confirm-list">${opts.titles.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        <div class="enc-card-actions">
          <button type="button" class="enc-btn enc-btn-primary" data-enc-act="confirm-save">确认并保存</button>
          <button type="button" class="enc-btn" data-enc-act="cancel-save">返回</button>
        </div>`;
      box.hidden = false;
    }
    return;
  }
  doSaveCard(mask);
}

async function doSaveCard(mask) {
  hideConfirm(mask);
  if (!renderCardPreview(mask, readCardOpts(mask))) return;
  try {
    const r = await api.app.saveImage({ dataUrl: cardDataUrl, name: `今日牛马卡-${todayStr()}` });
    if (r && r.ok) {
      showCardMsg(mask, `已保存：${r.filePath}`);
      notify('今日牛马卡已保存');
    } else {
      showCardMsg(mask, '已取消保存');
    }
  } catch (e) {
    showCardMsg(mask, `保存失败：${(e && e.message) || e}。可重试或复制文案。`);
    showCopyFallback(mask, true);
  }
}

function cardText(opts) {
  const stats = getStats();
  const n = computeNumbers(cfg, salaryCfg, new Date());
  const f = currentFortune();
  const lv = FORTUNE_LEVELS[f.level] || FORTUNE_LEVELS.mid;
  const weekend = isWeekend(new Date());
  const lines = [
    `今日牛马卡 · ${todayStr()}`,
    `连续打卡 ${cfg.streak} 天`,
    `已上班 ${Math.floor(n.elapsedMin / 60)} 小时 ${Math.floor(n.elapsedMin % 60)} 分`,
    `今日完成 ${stats.done} 件`,
    `牛马币 ${cfg.coins} 币 · 只换皮肤，不换钱`,
    weekend ? '休息日：今天不用上班' : `${lv.label}：宜 ${f.yi} · 忌 ${f.ji}`,
    weekend ? '这条是自动发的，不抽签、不发币。' : noteOf(f),
  ];
  if (opts && opts.amount && n.hasSalary) lines.push(`今日已赚 ¥${money(n.today, 3)}`);
  if (opts && opts.titles && opts.titles.length) lines.push(...opts.titles.map((t) => `· ${t}`));
  lines.push('Knodo · 工位搭子');
  return lines.join('\n');
}

async function onCopyCard(mask) {
  try {
    await navigator.clipboard.writeText(cardText(readCardOpts(mask)));
    notify('卡片文案已复制');
  } catch (e) {
    showCardMsg(mask, `复制失败：${(e && e.message) || e}`);
  }
}

/* ---------------- canvas 绘制 ---------------- */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  let line = '';
  for (const ch of String(text || '')) {
    if (ctx.measureText(line + ch).width > maxWidth && line) { out.push(line); line = ch; }
    else line += ch;
  }
  if (line) out.push(line);
  return out;
}

/**
 * 按生成瞬间的当前主题出图（v1.3 D-01）：浅色出浅卡、深色出深卡，
 * 两套色板的关键文字都取压深/提亮后的值，均满足 WCAG ≥ 4.5:1。
 */
function drawCard(opts = {}) {
  const W = 1080;
  const H = 1440;
  const C = CARD_THEMES[currentThemeKey()];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境不支持 canvas');

  const font = (size, weight = '600') => `${weight} ${size}px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif`;
  const numFont = (size) => `600 ${size}px "Segoe UI", "Inter Tight", sans-serif`;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  roundRect(ctx, 56, 56, W - 112, H - 112, 40);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.stroke();

  let y = 140;
  ctx.font = font(30, '600');
  ctx.fillStyle = C.green;
  ctx.fillText('Knodo · 工位搭子', 110, y);
  ctx.font = font(26, '400');
  ctx.fillStyle = C.text2;
  ctx.textAlign = 'right';
  ctx.fillText(todayStr(), W - 110, y);
  ctx.textAlign = 'left';

  y = 250;
  ctx.font = font(76, '800');
  ctx.fillStyle = C.text;
  ctx.fillText('今日牛马卡', 110, y);
  y += 54;
  ctx.font = font(28, '400');
  ctx.fillStyle = C.text2;
  ctx.fillText('纯牛马抱团所 · 本地分部', 110, y);

  y += 70;
  roundRect(ctx, 110, y, W - 220, 250, 26);
  ctx.fillStyle = C.panel2;
  ctx.fill();

  const n = computeNumbers(cfg, salaryCfg, new Date());
  const stats = getStats();
  const cells = [
    ['连续打卡', `${cfg.streak} 天`, C.green],
    ['已上班', `${Math.floor(n.elapsedMin / 60)} 时 ${Math.floor(n.elapsedMin % 60)} 分`, C.text],
    ['今日完成', `${stats.done} 件`, C.text],
    ['牛马币', `${cfg.coins} 币`, C.purple],
  ];
  let cx = 150;
  cells.forEach(([k, v, color], i) => {
    const colX = cx + (i % 2) * 430;
    const colY = y + 70 + Math.floor(i / 2) * 120;
    ctx.font = font(26, '400');
    ctx.fillStyle = C.text2;
    ctx.fillText(k, colX, colY);
    ctx.font = numFont(54);
    ctx.fillStyle = color;
    ctx.fillText(v, colX, colY + 62);
  });

  y += 310;
  const f = currentFortune();
  const lv = FORTUNE_LEVELS[f.level] || FORTUNE_LEVELS.mid;
  const weekend = isWeekend(new Date());
  ctx.font = font(30, '600');
  ctx.fillStyle = C.yellow;
  ctx.fillText(weekend ? '今日一签 · 休息日' : `今日一签 · ${lv.label}`, 110, y);
  y += 62;
  ctx.font = font(42, '700');
  ctx.fillStyle = C.text;
  wrapLines(ctx, weekend ? '今天不用上班' : `宜 ${f.yi} · 忌 ${f.ji}`, W - 220).forEach((line) => { ctx.fillText(line, 110, y); y += 58; });
  y += 10;
  ctx.font = font(30, '400');
  ctx.fillStyle = C.text2;
  wrapLines(ctx, weekend ? '这条是自动发的，不抽签、不发币。' : `「${noteOf(f)}」`, W - 220).forEach((line) => { ctx.fillText(line, 110, y); y += 46; });

  y += 34;
  const speech = pickLine(buddyLines().phases[n.phase] || [], `${todayStr()}#${n.phase}`) || '我在呢。';
  ctx.font = font(30, '400');
  ctx.fillStyle = C.green;
  wrapLines(ctx, `搭子说：${speech}`, W - 220).forEach((line) => { ctx.fillText(line, 110, y); y += 46; });

  if (opts.amount && n.hasSalary) {
    y += 28;
    ctx.font = numFont(56);
    ctx.fillStyle = C.red;
    ctx.fillText(`今日已赚 ¥${money(n.today, 3)}`, 110, y);
    y += 46;
  }
  if (opts.titles && opts.titles.length) {
    y += 24;
    ctx.font = font(28, '400');
    ctx.fillStyle = C.text;
    opts.titles.slice(0, 3).forEach((t) => {
      if (y > 1260) return; // 留够右下角落款的位置，宁可少写一条也不压字
      wrapLines(ctx, `· ${t}`, W - 220).slice(0, 1).forEach((line) => { ctx.fillText(line, 110, y); y += 42; });
    });
  }

  // 右下角固定小落款：唯一的引流锚点，不做大水印
  ctx.font = font(26, '600');
  ctx.fillStyle = C.text2;
  ctx.textAlign = 'right';
  ctx.fillText('Knodo · 工位搭子', W - 110, H - 110);
  ctx.textAlign = 'left';

  return canvas.toDataURL('image/png');
}
