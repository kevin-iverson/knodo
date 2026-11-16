'use strict';
/**
 * 报工 CSV（FR-09）。
 *
 * 为什么必须回主进程写盘：CSP 里没有 `blob:`，渲染层的 URL.createObjectURL 会被拦；
 * 而且 BOM 不能省 —— Windows Excel 打开无 BOM 的 UTF-8 会乱码，这是报工场景的高频投诉。
 */
const { dialog, BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SOURCE_TEXT = { timer: '计时', zen: '禅模式', pomodoro: '番茄', manual: '补录' };

function pad(n) { return String(n).padStart(2, '0'); }

/** UTC ISO → 本地日期 / 时间（报工表按本地时区看） */
function localParts(iso) {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** RFC 4180：含引号 / 逗号 / 换行的字段加引号，内部引号翻倍 */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 整数分 → 元文本（CSV 里给出两位小数，不用浮点运算，避免 799.9999 尾巴） */
function yuan(cents) {
  const c = Math.round(Number(cents) || 0);
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

function buildCsv(rows, payById) {
  // FR-07：金额列。金额是派生值，走 payRows 同一口径（逐条整数分四舍五入），
  // 绝不在导出里另写一套浮点计算 —— 否则导出的钱和界面上的对不上。
  const withPay = !!payById;
  const head = ['日期', '任务', '父任务', '分组', '开始', '结束', '时长(h)', '来源',
    ...(withPay ? ['计薪', '费率(元/h)', '金额(元)·估算'] : []), '备注'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of rows) {
    const a = localParts(r.started_at);
    const b = localParts(r.ended_at);
    const p = withPay ? payById.get(r.id) : null;
    lines.push([
      a.date,
      r.task_title || '已删除任务',
      r.parent_title || '',
      r.group_name || '',
      a.time,
      b.time,
      (Number(r.duration_sec) / 3600).toFixed(2), // 保留 2 位，不做 0.5h 取整
      SOURCE_TEXT[r.source] || r.source,
      ...(withPay ? [
        p && p.billable ? '是' : '否',
        p && p.rateCents ? yuan(p.rateCents) : '',
        p ? yuan(p.amountCents) : '',
      ] : []),
      r.note || '',
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

/**
 * @returns {Promise<{ok:boolean, path?:string, count?:number, reason?:string}>}
 */
async function exportCsv({ from = store.ALL_FROM, to = store.ALL_TO } = {}) {
  const rows = store.exportRows({ from, to });
  if (!rows.length) return { ok: false, reason: '当前范围没有可导出的工时记录' };
  // 金额按 payRows 同一出口算，再按记录 id 合并 —— 导出与界面绝不出现两套数字
  let payById = null;
  try {
    const pay = store.payRows({ from, to });
    payById = new Map(pay.rows.map((r) => [r.id, r]));
  } catch (_) { /* 记薪异常时仍导出纯工时列，不让报工功能整体失败 */ }

  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const res = await dialog.showSaveDialog(win, {
    title: '导出工时（CSV）',
    defaultPath: path.join(app.getPath('documents'), `工时-${stamp}.csv`),
    filters: [{ name: 'CSV 表格', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, reason: '已取消' };

  fs.writeFileSync(res.filePath, `\uFEFF${buildCsv(rows, payById)}`, 'utf8');
  return { ok: true, path: res.filePath, count: rows.length };
}

module.exports = { exportCsv, buildCsv };
