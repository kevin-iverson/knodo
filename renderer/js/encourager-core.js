'use strict';
/**
 * 上班鼓励器 · 数据内核（纯逻辑，零 DOM / 零 IPC，主浮窗与贴桌面小窗共用）。
 *
 * 只做四件事：配置规范化、每日打卡与发币、实时数值口径、分享卡色板。
 * 配置落在 settings 的 `tool.encourager`（零 SQLite 迁移），月薪一律读 `tool.salary`。
 */

import { computeSalary, parseHM, isWeekend, localDateStr } from './salary-core.js';
import { PURCHASE_DEFAULTS, phaseOf } from './encdata/buddy-lines.js';

export const ENC_DEFAULTS = {
  version: 3,
  budgetFrom: 'tool.salary',
  purchases: { ...PURCHASE_DEFAULTS },
  privacy: { pinMasked: true, shareAmount: false },
  buddy: { tone: 'warm', skin: 'moo.default' },
  fortune: { date: '', id: '', noteIndex: 0 },
  coins: 0,
  coinsEnabled: true,
  coinHintShown: false,
  streak: 0,
  streakRewards: [],
  lastActiveDate: '',
  rewardedTasks: [],
  unlocked: [],
  share: { includeTaskTitles: false },
  shape: 'full', // 早期贴桌面小窗遗留字段，只保留读取兼容，当前 UI 不消费
};

const TONES = ['warm', 'salty', 'sharp'];
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * 配置规范化：损坏 / 老版本 / 手改过的 JSON 一律安全归零，绝不阻断启动。
 * 只保留白名单字段（主进程 ui:setToolPref 只做搬运，真正的字段校验在这里）。
 */
export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const purchases = r.purchases && typeof r.purchases === 'object' ? r.purchases : {};
  const cleanPurchases = {};
  Object.entries(purchases).forEach(([k, v]) => {
    const name = String(k).trim().slice(0, 12);
    const price = num(v, 0);
    if (name && price > 0 && price < 1000000) cleanPurchases[name] = price;
  });
  if (!Object.keys(cleanPurchases).length) Object.assign(cleanPurchases, PURCHASE_DEFAULTS);

  const privacy = r.privacy && typeof r.privacy === 'object' ? r.privacy : {};
  const buddy = r.buddy && typeof r.buddy === 'object' ? r.buddy : {};
  const fortune = r.fortune && typeof r.fortune === 'object' ? r.fortune : {};
  const share = r.share && typeof r.share === 'object' ? r.share : {};

  return {
    version: 3,
    budgetFrom: 'tool.salary',
    purchases: cleanPurchases,
    privacy: {
      pinMasked: privacy.pinMasked !== false, // 用户拍板：贴桌面默认打码
      shareAmount: !!privacy.shareAmount,
    },
    buddy: {
      tone: TONES.includes(buddy.tone) ? buddy.tone : 'warm',
      skin: String(buddy.skin || 'moo.default').slice(0, 40),
    },
    fortune: {
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(fortune.date || '')) ? String(fortune.date) : '',
      id: String(fortune.id || '').slice(0, 20),
      noteIndex: Math.max(0, Math.min(9, Math.round(num(fortune.noteIndex, 0)))),
    },
    coins: Math.max(0, Math.round(num(r.coins, 0))),
    coinsEnabled: r.coinsEnabled !== false, // 默认显示
    coinHintShown: !!r.coinHintShown,
    streak: Math.max(0, Math.round(num(r.streak, 0))),
    streakRewards: Array.isArray(r.streakRewards)
      ? [...new Set(r.streakRewards.map((x) => Math.round(num(x, 0))).filter((x) => [3, 7, 15].includes(x)))]
      : [],
    lastActiveDate: /^\d{4}-\d{2}-\d{2}$/.test(String(r.lastActiveDate || '')) ? String(r.lastActiveDate) : '',
    rewardedTasks: Array.isArray(r.rewardedTasks)
      ? [...new Set(r.rewardedTasks.map(String).filter(Boolean))]
      : [],
    unlocked: Array.isArray(r.unlocked) ? [...new Set(r.unlocked.map(String).filter(Boolean))] : [],
    share: { includeTaskTitles: !!share.includeTaskTitles },
    // shape 是早期贴桌面小窗的遗留字段，只保留读取兼容，当前 UI 不再消费
    shape: r.shape === 'mini' ? 'mini' : 'full',
  };
}

/** 两个本地自然日之间相差几天（不用 toISOString，避免 UTC 错一天） */
export function daysBetween(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b || '')) return Infinity;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/**
 * 每日首次打开：打卡 + 发币 + 跨天重抽签判定。
 * 周末只更新「来过」的日期，不抽签、不发币、不涨连续天数（异常处理清单）。
 * @returns {{cfg:object, changed:boolean, gained:number, newDay:boolean}}
 */
export function applyDailyCheck(cfg0, now = new Date()) {
  const cfg = normalizeConfig(cfg0);
  const today = localDateStr(now);
  if (cfg.lastActiveDate === today) {
    return { cfg, changed: false, gained: 0, newDay: false };
  }
  const weekend = isWeekend(now);
  const gap = daysBetween(cfg.lastActiveDate, today);
  let gained = 0;
  let changed = false;

  if (cfg.lastActiveDate !== today) {
    cfg.lastActiveDate = today;
    changed = true;
  }
  if (!weekend) {
    cfg.streak = gap === 1 ? cfg.streak + 1 : 1;
    gained += 5; // 当日首次打开
    cfg.coins += gained;
    [3, 7, 15].forEach((mark, i) => {
      const bonus = [20, 50, 100][i];
      if (cfg.streak >= mark && !cfg.streakRewards.includes(mark)) {
        cfg.streakRewards.push(mark);
        cfg.coins += bonus;
        gained += bonus;
      }
    });
    // 跨自然日：fortune.date 与今天不等时由 UI 重抽（这里只清标记，确定性种子在签库里）
    if (cfg.fortune.date !== today) {
      cfg.fortune.date = '';
      cfg.fortune.id = '';
      cfg.fortune.noteIndex = 0;
    }
  }
  return { cfg, changed, gained, newDay: true };
}

/**
 * 任务完成发币：每任务一次，取消勾选 / 删除任务都不回退。
 * @returns {{cfg:object, changed:boolean, gained:number}}
 */
export function awardTask(cfg0, taskId) {
  const cfg = normalizeConfig(cfg0);
  const id = String(taskId == null ? '' : taskId);
  if (!id || cfg.rewardedTasks.includes(id)) return { cfg, changed: false, gained: 0 };
  cfg.rewardedTasks.push(id);
  cfg.coins += 10;
  return { cfg, changed: true, gained: 10 };
}

/** 距下一个非工作日（周六 00:00）的拆分时间；周末当天返回 isToday */
export function nextRest(now = new Date()) {
  const d = now.getDay();
  if (d === 0 || d === 6) return { days: 0, h: 0, m: 0, s: 0, isToday: true, totalMs: 0 };
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (6 - d), 0, 0, 0, 0);
  const total = Math.max(0, target.getTime() - now.getTime());
  const sec = Math.floor(total / 1000);
  return {
    days: Math.floor(sec / 86400),
    h: Math.floor((sec % 86400) / 3600),
    m: Math.floor((sec % 3600) / 60),
    s: sec % 60,
    isToday: false,
    totalMs: total,
  };
}

/**
 * 六组实时数字（FR-13）。全部由 wall-clock 重算，不累加快照。
 * 薪资口径统一由 computeSalary() 提供，主浮窗不另算一笔钱。
 */
export function computeNumbers(cfg, salaryCfg, now = new Date()) {
  const s = parseHM(salaryCfg && salaryCfg.start);
  const e = parseHM(salaryCfg && salaryCfg.end);
  const hasSalary = Number(salaryCfg && salaryCfg.monthly) > 0 && s != null && e != null && e > s;
  const r = computeSalary(salaryCfg || { monthly: 0, start: '09:00', end: '18:00' }, now);
  const weekend = isWeekend(now);
  const dayMin = s != null && e != null ? e - s : 0;
  const elapsedMin = weekend ? 0 : Math.max(0, Math.min(now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60, e ?? 0) - (s ?? 0));
  const progress = dayMin > 0 ? Math.max(0, Math.min(100, (elapsedMin / dayMin) * 100)) : 0;

  let status = 'working';
  if (weekend) status = 'weekend';
  else if (elapsedMin <= 0) status = 'before';
  else if (elapsedMin >= dayMin) status = 'after';

  const purchase = Object.entries(normalizeConfig(cfg).purchases).map(([name, price]) => {
    const count = Math.floor(r.today / price);
    return { name, price, count, rest: Math.max(0, r.today - count * price) };
  });

  return {
    hasSalary,
    perSec: r.hourly / 3600,       // 1 每秒进账（5 位）
    today: r.today,                // 2 今日已赚（3 位，红色大字）
    expected: r.dayHours * r.hourly, // 3 今日预计（2 位）
    hourly: r.hourly,              // 4 每小时（2 位）
    purchase,                      // 5 购买力换算（整数 + 余数）
    rest: nextRest(now),           // 6 下一个休息
    progress,
    status,
    phase: phaseOf(now, salaryCfg),
    dayHours: r.dayHours,
    elapsedMin,
    isWorkday: r.isWorkday,
    workdays: r.workdays,
  };
}

/** 分享卡 / canvas 用的双主题色板（与 encourager.css 的 --enc-* 一一对应） */
export const CARD_THEMES = {
  light: {
    bg: '#F5F6F8', panel: '#FFFFFF', panel2: '#EEF1F5', text: '#1F2430', text2: '#6B7280',
    green: '#0F8A5C', red: '#D93A3D', yellow: '#8A6100', purple: '#6D4BC7', line: '#E2E6EC',
  },
  dark: {
    bg: '#0B1714', panel: '#16241F', panel2: '#1E322A', text: '#F2F5F3', text2: '#8A9A93',
    green: '#3EE08F', red: '#FF4D4F', yellow: '#F5B301', purple: '#A78BFA', line: '#2A3C34',
  },
};

export function currentThemeKey() {
  const v = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : '';
  return v === 'dark' ? 'dark' : 'light';
}
