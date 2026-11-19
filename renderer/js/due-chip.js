'use strict';
/**
 * 「计划日期」胶囊 —— 截图确认卡与语音确认卡共用。
 *
 * 为什么独立成模块：两张卡的行内控件完全同构（勾选 / 标题 / 优先级 / 日期 / 删除），
 * 日期这块的逻辑（今天/明天的说法、非法日期回落、胶囊 ↔ 原生日期输入的切换）
 * 一旦各写一份，迟早会出现「截图卡认 2026-2-5、语音卡不认」这种分裂。
 *
 * 交互刻意用原生 <input type="date">：Chromium 自带日历面板，支持键盘直接输入，
 * 比自己画一个日历控件可靠得多。胶囊只是它的「显示态」。
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地今天（与主进程 date-utils#todayLocal 同口径） */
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const DAY_MS = 86400000;

/**
 * 胶囊文案：今天 / 明天 / 后天 / 昨天 / 8月31日 / 2027年1月5日。
 *
 * 不显示 '2026-08-31' 原文：一行只占 70px，而日期是给人扫一眼的，
 * 绝大多数就是「今天 / 明天」。只有跨年的才补年份，避免歧义。
 */
export function dueText(day) {
  const today = todayStr();
  if (!day || day === today) return '今天';
  const ms = new Date(`${day}T00:00:00`).getTime();
  if (!Number.isFinite(ms)) return '今天';
  const diff = Math.round((ms - new Date(`${today}T00:00:00`).getTime()) / DAY_MS);
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  const [y, m, d] = day.split('-').map(Number);
  return y === new Date().getFullYear() ? `${m}月${d}日` : `${y}年${m}月${d}日`;
}

/** 胶囊 tooltip：说清「这个日期是哪来的」，用户才知道要不要改 */
export function dueTitle(day) {
  if (!day) return '计划日期：今天（识别时没读到日期，点击可改）';
  if (day === todayStr()) return '计划日期：今天（点击可改）';
  return `计划日期 ${day}（点击可改）`;
}

/**
 * 把模型给的日期收成 '' 或合法的 YYYY-MM-DD。
 * 模型偶尔会写 2026-2-5 / 2026-02-31 这类值：前者补零，后者（不存在的日子）当没读到。
 * 主进程落库前还会用 date-utils#toDay 再校验一次，这里是为了别让胶囊显示假日期。
 */
export function safeDay(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` === s ? s : '';
}

/**
 * 把胶囊和它身后的日期输入绑在一起。
 *
 * @param {HTMLElement} chip 显示态（胶囊按钮）
 * @param {HTMLInputElement} input 隐藏的 <input type="date">
 * @param {{read: () => string, write: (v: string) => void}} io 读写这一行的日期
 * @param {() => void} [onChange] 日期落定后回调（主按钮文案要跟着变）
 */
export function bindDueChip(chip, input, io, onChange) {
  if (!chip || !input) return;

  chip.addEventListener('click', () => {
    input.value = io.read() || '';
    chip.hidden = true;
    input.hidden = false;
    input.focus();
    // showPicker 是锦上添花：个别环境会抛（老 Chromium / 非用户手势），
    // 抛了也不影响 —— input 已经露出来了，用户照样能手动填
    try { input.showPicker(); } catch (e) { /* 没有 picker 就手输 */ }
  });

  const apply = () => {
    io.write(input.value || '');
    // 批量写入会整块重绘：旧节点已脱离文档，别再往上写
    if (chip.isConnected) {
      const day = io.read();
      chip.textContent = dueText(day);
      chip.classList.toggle('is-set', !!day);
      chip.title = dueTitle(day);
      chip.hidden = false;
    }
    input.hidden = true;
    if (typeof onChange === 'function') onChange();
  };

  input.addEventListener('change', apply);
  // change 之后还会来一次 blur，apply 幂等，重复跑没有副作用
  input.addEventListener('blur', apply);
  // Esc 只收起日历，别冒泡到 modal 把整张卡关掉
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); apply(); }
  });
}
