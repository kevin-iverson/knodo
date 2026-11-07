'use strict';
/**
 * 薪资计算内核（纯函数，零依赖、零副作用）。
 *
 * 鼓励器主浮窗与设置面板共用一份口径：月薪、上下班时间只存 tool.salary，
 * 所有金额都在这里算，避免多处各写一份 hourly 实现导致数值漂移。
 * 这里只放口径，不放 DOM / IPC / 存储。
 *
 * 计算口径（硬性约定，改动前先确认业务含义）：
 * - 只算工作日：周一~周五，周末整段跳过（法定假期识别未实现）；
 * - 只算「上班时间 ~ 下班时间」区间内的时长，早到 / 加班都不计；
 * - 今日 = 今天这段区间里已经过去的部分（上班前 0，下班后封顶为全天工时）；
 * - 本月 = 本月 1 号到今天，同样口径逐日累加；
 * - 时薪 = 月薪 ÷ 当月工作日数 ÷ 每日工时（用当月工作日数而非固定 21.75，
 *   这样「整月全勤」正好等于月薪）。
 */

/** 默认值：朝九晚六（用户第一次打开就有个合理起点，改完即记住） */
export const DEFAULTS = { monthly: 0, start: '09:00', end: '18:00' };

/** 'HH:MM' → 当天的分钟数；格式不合法返回 null */
export function parseHM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分钟数 → 'HH:MM'（补零） */
export function fmtHM(mins) {
  const m = Math.max(0, Math.round(mins));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 本地自然日的 0 点（用本地时间构造，不能 toISOString 再切片——那是 UTC 日期） */
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function isWeekend(d) {
  const w = d.getDay();
  return w === 0 || w === 6;
}

/** 本地自然日 'YYYY-MM-DD'（禁止 toISOString 切片，UTC 会错一天） */
export function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 某月的第 n 天（n 从 0 起）；越界自动滚到下个月 */
export function dayOfMonth(base, n) {
  const d = new Date(base.getFullYear(), base.getMonth(), 1);
  d.setDate(1 + n);
  return d;
}

/** 统计 [from, to] 闭区间内的工作日天数 */
export function workdaysBetween(from, to) {
  let n = 0;
  const cur = startOfDay(from);
  const end = startOfDay(to);
  for (let i = 0; cur.getTime() + i * 86400000 <= end.getTime(); i += 1) {
    const d = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + i);
    if (!isWeekend(d)) n += 1;
  }
  return n;
}

/**
 * 核心计算（纯函数）。
 * @param {{monthly:number, start:string, end:string}} cfg
 * @param {Date} now 当前时间
 * @param {{thisMonth?:boolean}} [o] thisMonth=true 时算「本月 1 号至今」累计
 * @returns {{today:number, month:number, hourly:number, dayHours:number, workdays:number,
 *            elapsedMin:number, isWorkday:boolean, usedNow:Date}}
 */
export function computeSalary(cfg, now, o = {}) {
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
  const monthFirst = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthWorkdays = workdaysBetween(monthFirst, new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const hourly = monthWorkdays > 0 ? monthly / monthWorkdays / dayHours : 0;

  const todayIsWorkday = !isWeekend(now);
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const elapsedMin = !todayIsWorkday ? 0 : Math.max(0, Math.min(nowMin, e) - s);
  const today = (elapsedMin / 60) * hourly;

  if (!o.thisMonth) {
    return { today, month: 0, hourly, dayHours, workdays: monthWorkdays, elapsedMin, isWorkday: todayIsWorkday, usedNow: now };
  }

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
