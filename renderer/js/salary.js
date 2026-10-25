'use strict';
/**
 * 实用工具 →「实时薪资」弹窗。
 *
 * 入口在应用菜单「实用工具 → 实时薪资」（主进程发 ui:salary 事件），这里负责弹窗与计算。
 * 依赖注入 toast 而不是 import ui.js：ui.js 会绑定本模块，反向 import 会形成循环依赖
 * （与 ai-settings.js / meetings.js 同一套做法）。
 *
 * 配置（月薪 + 上下班时间）存 settings 的 `tool.salary`，下次打开直接回填，不用重填。
 *
 * 计算口径（都是硬性约定，改动前先确认业务含义）：
 * - 只算工作日：周一~周五，周末整段跳过；
 * - 只算「上班时间 ~ 下班时间」这段区间内的时长，区间外的时间不计（早到 / 加班都不算钱）；
 * - 今日 = 今天这段区间里已经过去的部分（上班前为 0，下班后封顶为全天工时）；
 * - 本月 = 本月 1 号到今天，同样的口径逐日累加（工作日 × 全天 + 今天已过部分）。
 *   今天是周末、或本月 1 号起都是周末时，累计就是 0，这是口径的自然结果而不是 bug。
 * - 时薪由「月薪 ÷ 当月工作日数 ÷ 每日工时」得出 —— 用当月工作日数而不是固定的 21.75，
 *   这样「整月全勤」正好等于月薪，不会出现「干满一个月拿不满工资」的困惑。
 * 界面只展示「今日已获得」「本月累计」，不展示总月薪（薪资是隐私，弹窗可能被旁人看到）。
 */
import { api } from './api.js';
import { openPanelModal } from './modal.js';

let notify = () => {};
export function setSalaryHandlers({ toast } = {}) {
  if (toast) notify = toast;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 默认值：朝九晚六（用户第一次打开就有个合理起点，改完即记住） */
const DEFAULTS = { monthly: 0, start: '09:00', end: '18:00' };

/* ---------------- 时间工具 ---------------- */

/** 'HH:MM' → 当天的分钟数；格式不合法返回 null */
function parseHM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分钟数 → 'HH:MM'（补零） */
function fmtHM(mins) {
  const m = Math.max(0, Math.round(mins));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 本地自然日的 0 点（用本地时间构造，不能 toISOString 再切片——那是 UTC 日期） */
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isWeekend(d) {
  const w = d.getDay();
  return w === 0 || w === 6;
}

/** 某月的第 n 天（n 从 0 起）；越界自动滚到下个月，这里是按月按天走，不会越界 */
function dayOfMonth(base, n) {
  const d = new Date(base.getFullYear(), base.getMonth(), 1);
  d.setDate(1 + n);
  return d;
}

/** 统计 [from, to] 闭区间内的工作日天数 */
function workdaysBetween(from, to) {
  let n = 0;
  const cur = startOfDay(from);
  const end = startOfDay(to);
  for (let i = 0; cur.getTime() + i * 86400000 <= end.getTime(); i += 1) {
    const d = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + i);
    if (!isWeekend(d)) n += 1;
  }
  return n;
}

/** 金额格式化：固定两位小数 + 千分位 */
function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 核心计算（纯函数，便于单测 / 复核）。
 * @param {{monthly:number, start:string, end:string}} cfg
 * @param {Date} now 当前时间
 * @param {{thisMonth?:boolean}} [o] thisMonth=true 时算「本月 1 号至今」累计
 * @returns {{today:number, month:number, hourly:number, dayHours:number, workdays:number,
 *            elapsedMin:number, isWorkday:boolean, usedNow:Date}}
 */
function computeSalary(cfg, now, o = {}) {
  const monthly = Number(cfg.monthly) || 0;
  const s = parseHM(cfg.start);
  const e = parseHM(cfg.end);
  const empty = {
    today: 0, month: 0, hourly: 0, dayHours: 0, workdays: 0,
    elapsedMin: 0, isWorkday: false, usedNow: now,
  };
  if (!(monthly > 0) || s == null || e == null || e <= s) return empty;

  const dayMin = e - s;
  const dayHours = dayMin / 60;
  // 当月（含今天所在月）的工作日总数：决定时薪，让「整月全勤 = 月薪」
  const monthFirst = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthWorkdays = workdaysBetween(monthFirst, new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const hourly = monthWorkdays > 0 ? monthly / monthWorkdays / dayHours : 0;

  // 今天在区间内已经过掉的分钟数（上班前 0，下班后封顶）
  const todayIsWorkday = !isWeekend(now);
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const elapsedMin = !todayIsWorkday ? 0 : Math.max(0, Math.min(nowMin, e) - s);
  const today = (elapsedMin / 60) * hourly;

  if (!o.thisMonth) {
    return { today, month: 0, hourly, dayHours, workdays: monthWorkdays, elapsedMin, isWorkday: todayIsWorkday, usedNow: now };
  }

  // 本月累计：1 号 ~ 今天，逐日累加 —— 今天之前的工作日算满，今天只算已过部分
  let money = 0;
  const days = now.getDate();
  for (let i = 0; i < days; i += 1) {
    const d = dayOfMonth(now, i);
    if (isWeekend(d)) continue;
    const isToday = i === days - 1;
    money += ((isToday ? elapsedMin : dayMin) / 60) * hourly;
  }
  return { today, month: money, hourly, dayHours, workdays: monthWorkdays, elapsedMin, isWorkday: todayIsWorkday, usedNow: now };
}

/* ---------------- 弹窗 ---------------- */

/** 正在显示的弹窗：重复点菜单不叠加第二层（只把已有窗口抢到焦点） */
let openMask = null;

/** 菜单「实用工具 → 实时薪资」→ 打开弹窗 */
export async function openSalaryModal() {
  if (openMask && openMask.isConnected) {
    openMask.querySelector('.modal-input')?.focus();
    return;
  }
  const saved = await api.ui.getSalary().catch(() => null);
  const cfg = { ...DEFAULTS, ...(saved || {}) };
  if (saved == null) cfg.monthly = 0;

  await openPanelModal({
    title: '实时薪资',
    className: 'modal-salary',
    html: salaryHtml(cfg),
    okText: '保存',
    showClose: true,
    extraButtons: [
      { label: '刷新', handler: async (root) => refreshView(root) },
    ],
    // 保存：先校验，通过才落库并刷新展示（错误由弹窗自带的错误条呈现）
    onSubmit: async (root) => {
      const err = readAndPaint(root, { persist: true });
      if (err) return err;
      notify('薪资设置已保存');
      return undefined;
    },
    onMount: (mask) => {
      openMask = mask;
      bindSalaryEvents(mask);
      paint(mask, cfg, Date.now());
    },
    onClose: () => { openMask = null; },
  });
}

function salaryHtml(cfg) {
  const v = (x) => esc(x == null ? '' : String(x));
  return `
    <div class="sal-wrap">
      <div class="sal-form">
        <label class="sal-field sal-field-money">
          <span class="field-label">月薪（元）</span>
          <input class="modal-input sal-monthly" type="number" min="0" step="0.01" inputmode="decimal"
                 placeholder="例如 15000" value="${cfg.monthly > 0 ? v(cfg.monthly) : ''}" />
        </label>
        <label class="sal-field">
          <span class="field-label">上班时间</span>
          <input class="modal-input sal-start" type="time" step="60" value="${v(cfg.start || DEFAULTS.start)}" />
        </label>
        <label class="sal-field">
          <span class="field-label">下班时间</span>
          <input class="modal-input sal-end" type="time" step="60" value="${v(cfg.end || DEFAULTS.end)}" />
        </label>
      </div>
      <div class="sal-cards">
        <div class="sal-card sal-card-today">
          <div class="sal-card-label">今日已获得</div>
          <div class="sal-card-value"><span class="sal-currency">¥</span><span class="sal-today">0.00</span></div>
          <div class="sal-card-sub sal-today-sub">—</div>
        </div>
        <div class="sal-card sal-card-month">
          <div class="sal-card-label">本月累计</div>
          <div class="sal-card-value"><span class="sal-currency">¥</span><span class="sal-month">0.00</span></div>
          <div class="sal-card-sub sal-month-sub">月初至今</div>
        </div>
      </div>
      <div class="sal-hint sal-meta">仅按工作日（周一至周五）计算，且只计入上下班时间区间内的时长。</div>
    </div>`;
}

/** 从表单读出配置（不校验） */
function readForm(root) {
  const monthly = Number(String(root.querySelector('.sal-monthly')?.value || '').trim());
  const start = String(root.querySelector('.sal-start')?.value || '').trim();
  const end = String(root.querySelector('.sal-end')?.value || '').trim();
  return { monthly, start, end };
}

/** 表单校验：返回错误文案，通过则返回 '' */
function validate(cfg) {
  if (!Number.isFinite(cfg.monthly) || cfg.monthly <= 0) return '请输入大于 0 的月薪';
  if (cfg.monthly > 100000000) return '月薪数值过大，请检查';
  const s = parseHM(cfg.start);
  if (s == null) return '上班时间格式不正确，请选择 HH:MM';
  const e = parseHM(cfg.end);
  if (e == null) return '下班时间格式不正确，请选择 HH:MM';
  if (e <= s) return '下班时间必须晚于上班时间（暂不支持跨天班次）';
  return '';
}

/** 把算出来的数字画到卡片上 */
function paint(root, cfg, atMs) {
  const res = computeSalary(cfg, new Date(atMs), { thisMonth: true });
  const setText = (sel, txt) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = txt;
  };
  setText('.sal-today', fmtMoney(res.today));
  setText('.sal-month', fmtMoney(res.month));

  const used = res.usedNow;
  const time = fmtHM(used.getHours() * 60 + used.getMinutes());
  if (!(cfg.monthly > 0)) {
    setText('.sal-today-sub', '填好月薪与时间后自动计算');
    setText('.sal-month-sub', '月初至今');
  } else if (!res.isWorkday) {
    setText('.sal-today-sub', `今天是周末（${time}），不计薪`);
    setText('.sal-month-sub', `月初至今 · ${res.workdays} 个工作日`);
  } else if (res.elapsedMin <= 0) {
    // 这里都是 textContent 赋值，不能包 esc()，否则会把 & < 当成实体
    setText('.sal-today-sub', `${cfg.start} 上班，${time} 尚未开始计薪`);
    setText('.sal-month-sub', `月初至今 · ${res.workdays} 个工作日`);
  } else {
    const done = parseHM(cfg.start) + res.elapsedMin >= parseHM(cfg.end);
    setText('.sal-today-sub', done
      ? `今日工时已满（${cfg.start}–${cfg.end}，${res.dayHours.toFixed(1)} 小时）`
      : `${cfg.start} 起已计 ${(res.elapsedMin / 60).toFixed(2)} 小时 · ${time} 刷新`);
    setText('.sal-month-sub', `月初至今 · ${res.workdays} 个工作日`);
  }
}

/**
 * 校验 + 计算 +（可选）落库。
 * @returns {string} 校验错误文案，'' 表示通过
 */
function readAndPaint(root, { persist = false } = {}) {
  const cfg = readForm(root);
  const err = validate(cfg);
  if (err) return err;
  paint(root, cfg, Date.now());
  if (persist) {
    api.ui.setSalary(cfg).catch((e) => notify(`薪资设置保存失败：${(e && e.message) || e}`));
  }
  return '';
}

/** 「刷新」按钮：按当前时间重算（表单没填好就提示，而不是把卡片清成 0） */
async function refreshView(root) {
  const cfg = readForm(root);
  const err = validate(cfg);
  if (err) {
    paint(root, { monthly: 0, start: cfg.start, end: cfg.end }, Date.now());
    return err;
  }
  paint(root, cfg, Date.now());
  notify('已按当前时间刷新');
  return undefined;
}

function bindSalaryEvents(mask) {
  // 输入变化即预览：改完月薪 / 时间马上能看到数字（不落库，点「保存」才记）
  mask.addEventListener('input', (e) => {
    if (!e.target.closest('.sal-form')) return;
    const cfg = readForm(mask);
    if (validate(cfg)) return; // 半截输入（如只输了月薪还没填时间）不报错，也不乱算
    paint(mask, cfg, Date.now());
  });
  mask.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (!t || !t.closest || !t.closest('.sal-form')) return;
    // 回车即时保存配置（但不关窗 —— 用户多半还想看一眼刷新后的数字）。
    // 校验统一交给「保存」按钮同一条路径：读表单 + 校验 + 落库，错误就地展示。
    e.preventDefault();
    e.stopPropagation();
    const err = readAndPaint(mask, { persist: true });
    const errEl = mask.querySelector('.modal-error');
    if (errEl) {
      errEl.textContent = err || '';
      errEl.hidden = !err;
      mask.querySelector('.modal').classList.toggle('has-error', !!err);
    }
    if (!err) notify('薪资设置已保存');
  });
}
