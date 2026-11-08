'use strict';
/**
 * 中国内地法定节假日与调休补班（离线数据）。
 *
 * 数据来源：国务院办公厅「关于 XXXX 年部分节假日安排的通知」
 *  - 2026：国办发明电〔2025〕7 号（2025-11-04 发布）
 *  - 2027：2026-11-05 发布
 * 放假区间为「通知里的连休日期」，含落在周末的日子；补班日为通知明确要求上班的周末。
 *
 * 覆盖年份之外**不猜测**：isCnWorkday 降级为「周一至周五」，
 * isCnHoliday 恒为 false，并在 coverage() 里把范围暴露给 UI 提示用户。
 * 新增年份只需往 CALENDAR 加一条，无需改判断逻辑。
 */
const { toDay, dayOfWeek, eachDay } = require('./date-utils');

const CALENDAR = {
  2026: {
    notice: '国办发明电〔2025〕7 号',
    holidays: [
      ['2026-01-01', '2026-01-03'], // 元旦
      ['2026-02-15', '2026-02-23'], // 春节
      ['2026-04-04', '2026-04-06'], // 清明
      ['2026-05-01', '2026-05-05'], // 劳动节
      ['2026-06-19', '2026-06-21'], // 端午
      ['2026-09-25', '2026-09-27'], // 中秋
      ['2026-10-01', '2026-10-07'], // 国庆
    ],
    makeups: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
  },
  2027: {
    notice: '国务院办公厅 2026-11-05 通知',
    holidays: [
      ['2027-01-01', '2027-01-03'], // 元旦
      ['2027-02-05', '2027-02-13'], // 春节
      ['2027-04-03', '2027-04-05'], // 清明
      ['2027-05-01', '2027-05-05'], // 劳动节
      ['2027-06-09', '2027-06-09'], // 端午
      ['2027-09-15', '2027-09-15'], // 中秋
      ['2027-10-01', '2027-10-07'], // 国庆
    ],
    makeups: ['2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09'],
  },
};

/** 展开成 Set，避免每次判断都遍历区间 */
const HOLIDAY_SETS = {};
const MAKEUP_SETS = {};
for (const [year, cfg] of Object.entries(CALENDAR)) {
  const h = new Set();
  for (const [from, to] of cfg.holidays) for (const d of eachDay(from, to)) h.add(d);
  HOLIDAY_SETS[year] = h;
  MAKEUP_SETS[year] = new Set(cfg.makeups.map(toDay).filter(Boolean));
}

const COVERED_YEARS = Object.keys(CALENDAR).map(Number).sort((a, b) => a - b);

/** 数据覆盖范围（供设置/管理面板提示） */
function coverage() {
  return {
    years: [...COVERED_YEARS],
    from: COVERED_YEARS.length ? `${COVERED_YEARS[0]}-01-01` : '',
    to: COVERED_YEARS.length ? `${COVERED_YEARS[COVERED_YEARS.length - 1]}-12-31` : '',
  };
}

function isCovered(dateStr) {
  const y = Number(String(toDay(dateStr)).slice(0, 4));
  return COVERED_YEARS.includes(y);
}

/** 是否落在法定放假区间内（含周末本身） */
function isCnHoliday(dateStr) {
  const d = toDay(dateStr);
  if (!d) return false;
  const set = HOLIDAY_SETS[d.slice(0, 4)];
  return set ? set.has(d) : false;
}

/** 是否是通知里明确要求上班的调休补班日 */
function isMakeupWorkday(dateStr) {
  const d = toDay(dateStr);
  if (!d) return false;
  const set = MAKEUP_SETS[d.slice(0, 4)];
  return set ? set.has(d) : false;
}

/**
 * 是否中国法定工作日：补班日 > 放假日 > 普通周一至周五。
 * 覆盖年份之外降级为周一至周五（调用方可用 coverage() 提示）。
 */
function isCnWorkday(dateStr) {
  const d = toDay(dateStr);
  if (!d) return false;
  if (isMakeupWorkday(d)) return true;
  if (isCnHoliday(d)) return false;
  const w = dayOfWeek(d);
  return w >= 1 && w <= 5;
}

/**
 * 「跳过节假日」：只排除法定放假日，不把周末算成假期（周末是否命中由规则自身决定）。
 */
function isHolidayToSkip(dateStr) {
  return isCnHoliday(dateStr);
}

/** 给某日一个可读的日历标签，管理面板里解释「为什么这天有/没有任务」 */
function describeDay(dateStr) {
  const d = toDay(dateStr);
  if (!d) return '';
  if (!isCovered(d)) return '普通工作日口径（该年份暂无节假日数据）';
  if (isMakeupWorkday(d)) return '调休补班';
  if (isCnHoliday(d)) return '法定假期';
  return isCnWorkday(d) ? '工作日' : '周末';
}

/** 下一批即将到来的假期（管理面板提示用，最多 3 条） */
function upcomingHolidays(fromDay, limit = 3) {
  const start = toDay(fromDay);
  if (!start) return [];
  const out = [];
  for (const year of COVERED_YEARS) {
    for (const [from, to] of CALENDAR[year].holidays) {
      if (to >= start && out.length < limit) out.push({ from, to, days: eachDay(from, to).length });
    }
  }
  return out.sort((a, b) => a.from.localeCompare(b.from)).slice(0, limit);
}

module.exports = {
  CALENDAR, coverage, isCovered, isCnHoliday, isMakeupWorkday,
  isCnWorkday, isHolidayToSkip, describeDay, upcomingHolidays,
  // 供测试：把区间展开成逐日集合
  _holidaySet: (y) => HOLIDAY_SETS[y],
};
