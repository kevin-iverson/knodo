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

let toast = (msg) => console.warn('[settings]', msg);
/** 需要壳层配合的外部动作（主题切换要同步 ui.js 里的 state.theme，否则顶栏按钮会打架） */
const ext = { onTheme: null, onCalendarPrefs: null };

export function setSettingsHandlers({ toast: t, onTheme, onCalendarPrefs } = {}) {
  if (typeof t === 'function') toast = t;
  if (typeof onTheme === 'function') ext.onTheme = onTheme;
  if (typeof onCalendarPrefs === 'function') ext.onCalendarPrefs = onCalendarPrefs;
}

/* ------------------------------ 状态 ------------------------------ */

/** 打开面板时一次性读齐，分区渲染只读内存（不再各自发 IPC，避免一开面板十几个请求） */
const S = {
  theme: 'system',
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

/* ------------------------------ 分区：通用 ------------------------------ */

function generalHtml() {
  const auto = S.autoStart || {};
  const supported = auto.supported !== false;
  return [
    sectionHtml({
      rows: [
        rowHtml({
          title: '界面主题',
          desc: '「跟随系统」会随 Windows 深浅色自动切换，修改后立即生效；也可用 Ctrl + , 打开设置',
          ctl: ctlSelect('st-theme', S.theme, [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]),
          search: '深色 浅色 暗色 外观 配色 theme',
          id: 'theme',
        }),
      ],
    }),
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
  const themeSel = pane.querySelector('#st-theme');
  themeSel?.addEventListener('change', async (e) => {
    const mode = e.target.value;
    try {
      await api.theme.set(mode);
      S.theme = mode;
      // 必须回传给 ui.js：主界面配色读的是它自己的 state.theme，
      // 只改这里会让「界面配色」和「设置里的选择」各说各话
      if (ext.onTheme) ext.onTheme(mode);
      toast('主题已切换');
    } catch (err) {
      e.target.value = S.theme;
      toast(`切换主题失败：${(err && err.message) || err}`);
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
          title: '显示已完成任务',
          desc: '显示时降为 40% 透明度，且不计入负载',
          ctl: ctlSwitch('st-cal-showdone', !!cal.showCompleted),
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
      showCompleted: !!pane.querySelector('#st-cal-showdone')?.checked,
    };
    try {
      await api.ui.setToolPref('calendar', next);
      S.calendar = next;
      if (ext.onCalendarPrefs) ext.onCalendarPrefs(next);
      toast('日历设置已保存');
    } catch (e) {
      toast(`保存失败：${(e && e.message) || e}`);
    }
  };
  ['#st-cal-capacity', '#st-cal-weekstart', '#st-cal-showdone'].forEach((sel) => {
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
  const [theme, autoStart, version, storage, backup, salary, ai, calendar, encourager] = await Promise.all([
    soft(api.theme.get(), 'system'),
    soft(api.app.getAutoStart(), { enabled: false, supported: false, reason: '读取开机自启动状态失败' }),
    soft(api.app.getVersion(), ''),
    soft(api.env.getStorageInfo(), null),
    soft(api.env.getBackupInfo(), null),
    soft(api.ui.getSalary(), null),
    soft(api.ai.getConfig(), null),
    soft(api.ui.getToolPref('calendar'), null),
    soft(api.ui.getToolPref('encourager'), null),
  ]);
  Object.assign(S, { theme, autoStart, version, storage, backup, salary, ai, calendar, encourager });
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
