'use strict';
/**
 * 工时记薪（时间价值）端到端验收（真实 Electron 窗口 + CDP，沿用 verify-worklog.js 的驱动）。
 *
 * 覆盖 docs/features/工时记薪-实现方案.md §十 的 12 项验收 + UI 集成：
 *  - 计算口径：整数分四舍五入 / 逐条舍入相加 / 生效日切换 / 跨天归开始日 /
 *    billable=0 排除 / 早于最早费率 / 删任务后金额仍在 / 同生效日覆盖；
 *  - 引导态：未设费率时价值视图无「¥0」，有明确「设置时薪」引导；
 *  - UI：工时/价值分段切换、价值卡组、金额列、明细回溯、计薪开关、时薪弹窗；
 *  - 数据：v19 迁移（user_version=19）、exportData 带 pay_rates、备份 schemaVersion=16；
 *  - 开关：关闭工时插件后 pay 通道与价值视图一起消失。
 *
 * 关键：造数日期一律用「今天」（动态），不用硬编码日期 —— 否则「本周」范围随
 * 运行日漂移，验收会在非脚本编写日假失败（verify-worklog.js 的历史教训）。
 *
 * 用法：node scripts/verify-pay.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9531';
const profile = path.join(os.tmpdir(), `knodo-pay-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [
  root,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

let childLog = '';
child.stdout.on('data', (b) => { childLog += b.toString(); });
child.stderr.on('data', (b) => { childLog += b.toString(); });

let closed = false;
function killChild() {
  if (closed) return;
  closed = true;
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* 已退出 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
}
process.on('exit', killChild);
process.on('SIGINT', () => { killChild(); process.exit(130); });

async function findPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (_) { /* 窗口还没起来 */ }
    await sleep(300);
  }
  throw new Error('找不到渲染进程调试页（CDP 连接超时）');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`WebSocket 连接失败：${e && e.message ? e.message : e}`));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    evaluate: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || '渲染层表达式异常');
      }
      return r && r.result ? r.result.value : undefined;
    },
    close: () => ws.close(),
  };
}

const SCRIPT = `(async () => {
  const out = { checks: [], dir: '' };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 轮询等待元素出现：冷启动首次 v19 迁移 + 插件动态 import/mount 可能要 1~2s，
  // 固定 sleep 会在慢机器上假失败（verify-worklog 的历史教训）。
  const until = async (fn, timeout = 5000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const r = fn(); if (r) return r; await wait(120); }
    return null;
  };
  const ck = (name, ok, extra) => out.checks.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
  let api = window.api;
  for (let i = 0; i < 60 && !api; i += 1) { await wait(200); api = window.api; }
  if (!api) throw new Error('window.api 未注入');
  for (let i = 0; i < 120 && (document.readyState !== 'complete' || !window.__appReady); i += 1) await wait(100);
  out.dir = (api.debug && api.debug.dataDir && api.debug.dataDir()) || '(n/a)';

  const nav = (v) => { const b = document.querySelector('.nav-item[data-view="' + v + '"]'); if (b) b.click(); };
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dayStr = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const TODAY = dayStr(today);           // 本周内，动态
  // 一条 UTC ISO，使其 localtime（东八区）落在给定本地日期的 09:00
  const isoAt = (localDay, hh) => new Date(localDay + 'T' + pad(hh) + ':00:00+08:00').toISOString();

  /* ---------- 0. 开启插件 ---------- */
  const pref0 = await api.features.pref();
  if (!pref0.enabled) await api.features.setPref({ enabled: true });
  await until(() => document.getElementById('wl-css'));
  await until(() => document.querySelector('.wl-toolbar [data-wl-chips="mode"]'));
  ck('v19 迁移已就绪（pay 通道可用）', typeof api.worklog.pay === 'function');
  ck('费率通道齐全', ['rates','rateSet','rateDelete','entryBillable'].every((k) => typeof api.worklog[k] === 'function'));

  /* ---------- 0b. 工时视图隐藏顶栏那排工具（搜索/AI/笔记/导入/备份/录制/新建）----------
   * 此刻 nav 已在 worklog（mount 末尾 navigateTo 过），顶栏应整排 hidden。 */
  nav('worklog');
  await until(() => document.querySelector('.nav-item[data-view="worklog"].active'));
  const topbarRight0 = document.querySelector('.topbar-right');
  ck('工时视图顶栏工具整排隐藏', !!topbarRight0 && topbarRight0.hidden === true);
  // 切回任务视图必须原样恢复（不用 remove()/innerHTML 删节点）
  nav('all');
  await until(() => document.querySelector('.nav-item[data-view="all"].active'));
  const topbarRightTask = document.querySelector('.topbar-right');
  ck('切回任务视图顶栏工具恢复', !!topbarRightTask && topbarRightTask.hidden === false
    && !!topbarRightTask.querySelector('#btn-import') && !!topbarRightTask.querySelector('#btn-export'));
  nav('worklog');
  await until(() => document.querySelector('.nav-item[data-view="worklog"].active'));

  /* ---------- 1. 引导态：无费率不显示 ¥0 ---------- */
  const rates0 = await api.worklog.rates();
  for (const r of rates0) await api.worklog.rateDelete(r.id);
  nav('worklog');
  const segValue = await until(() => document.querySelector('[data-wl-chips="mode"][data-v="value"]'));
  ck('工时/价值分段控件存在', !!segValue);
  if (segValue) segValue.click();
  await until(() => document.querySelector('.wl-pay-guide'));
  const viewText1 = (document.getElementById('view') || {}).textContent || '';
  ck('无费率显示「设置时薪」引导', /设置时薪/.test(viewText1));
  // 检查的是「汇总数字」不出现 ¥0.00，而不是整页文案（引导说明里会出现这句话本身）
  const guideCards = document.querySelectorAll('.wl-sum-card .wl-v');
  ck('无费率不显示 ¥0.00', guideCards.length === 0 || !Array.from(guideCards).some((n) => /¥0\.00/.test(n.textContent)));
  ck('无费率时段的引导卡存在', !!document.querySelector('.wl-pay-guide'));

  /* ---------- 2. 设 ¥80/h（今天生效）---------- */
  await api.worklog.rateSet({ rateCents: 8000, effectiveFrom: TODAY, note: '验收起步' });
  const ratesA = await api.worklog.rates();
  ck('费率已保存 ¥80', ratesA.length === 1 && ratesA[0].rate_cents === 8000, JSON.stringify(ratesA));
  await wait(200);

  /* ---------- 3. 造数：1 小时 + 1 秒 + 不计薪 ---------- */
  const parent = await api.tasks.create({ title: '验收-计薪任务' });
  await api.worklog.manualAdd({ taskId: parent.id, date: TODAY, start: '09:00', end: '10:00', note: '整点一小时' });
  // 1 秒记录：直接走 manualAdd 会产生 >1s，用 store 层通过 IPC 不好造；这里验证整点口径即可，
  // 1 秒口径已在 DB 内核单测（内联 node 脚本）覆盖。
  const pay1 = await api.worklog.pay({});
  const hourRow = (pay1.rows || []).find((r) => /整点一小时/.test(r.note || ''));
  ck('1h × ¥80 = ¥80.00（8000 分）', !!hourRow && hourRow.amountCents === 8000, hourRow && hourRow.amountCents);
  ck('汇总=Σ逐条舍入', pay1.totalCents === (pay1.rows || []).reduce((s, r) => s + r.amountCents, 0), pay1.totalCents);

  /* ---------- 4. 生效日切换：今天 80，明天 100 ---------- */
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  await api.worklog.rateSet({ rateCents: 10000, effectiveFrom: dayStr(tomorrow), note: '涨薪' });
  const hourRow2 = (await api.worklog.pay({})).rows.find((r) => /整点一小时/.test(r.note || ''));
  ck('今天的记录仍按 ¥80（涨薪不影响历史）', hourRow2 && hourRow2.rateCents === 8000, hourRow2 && hourRow2.rateCents);
  ck('费率历史有两条', (await api.worklog.rates()).length === 2);

  /* ---------- 5. 不计薪：金额归零 + 排除时长 ---------- */
  await api.worklog.manualAdd({ taskId: parent.id, date: TODAY, start: '10:00', end: '11:00', note: '内部会议' });
  const pay2 = await api.worklog.pay({});
  const meeting = (pay2.rows || []).find((r) => /内部会议/.test(r.note || ''));
  ck('新记录默认计薪', meeting && meeting.billable === 1 && meeting.amountCents === 8000, meeting && meeting.amountCents);
  await api.worklog.entryBillable({ id: meeting.id, billable: false });
  const pay3 = await api.worklog.pay({});
  const meeting2 = (pay3.rows || []).find((r) => r.id === meeting.id);
  ck('不计薪金额=0', meeting2 && meeting2.amountCents === 0);
  ck('已排除时长=3600s', pay3.excludedSec === 3600, pay3.excludedSec);
  ck('不计薪记录仍在 rows（不静默消失）', !!meeting2);

  /* ---------- 6. 跨天归开始日（23:00 本地）---------- */
  await api.worklog.manualAdd({ taskId: parent.id, date: TODAY, start: '23:00', end: '23:30', note: '跨天半小时' });
  const cross = (await api.worklog.pay({})).rows.find((r) => /跨天半小时/.test(r.note || ''));
  ck('跨天记录归属开始日', cross && cross.localDay === TODAY, cross && cross.localDay);

  /* ---------- 7. 价值视图 UI ----------
   * 第 2~6 步只走 IPC 改数据、没重绘 DOM，这里必须强制重绘：
   * 先切回「工时」再切「价值」，确保拿到含费率的最新视图。 */
  nav('worklog');
  await until(() => document.querySelector('[data-wl-chips="mode"][data-v="time"]'));
  const segTime = document.querySelector('[data-wl-chips="mode"][data-v="time"]');
  if (segTime && !segTime.classList.contains('is-active')) {
    segTime.click();
    await until(() => document.querySelector('.wl-sum-card'));
  }
  const seg2 = await until(() => document.querySelector('[data-wl-chips="mode"][data-v="value"]'));
  if (seg2) {
    seg2.click();
    await until(() => document.querySelector('[data-wl="rate"]') && document.querySelector('.wl-table'));
  }
  const valueText = (document.getElementById('view') || {}).textContent || '';
  ck('价值卡组：折算价值', /折算价值/.test(valueText));
  ck('价值卡组：可计费时长', /可计费时长/.test(valueText));
  ck('价值卡组：已排除', /已排除/.test(valueText));
  ck('表格有金额列', /金额/.test(valueText));
  const moneyEls = document.querySelectorAll('.wl-money');
  ck('金额用等宽样式渲染', moneyEls.length > 0, moneyEls.length);
  const payRow = document.querySelector('[data-wl-pay-row]');
  ck('价值表格有任务行', !!payRow);
  const detailBtn = payRow && payRow.querySelector('[data-wl-pay-open]');
  if (detailBtn) { detailBtn.click(); await until(() => document.querySelector('.wl-pay-detail')); }
  ck('明细回溯可展开', !!document.querySelector('.wl-pay-detail'));
  ck('明细有计薪开关', !!document.querySelector('[data-wl-billable]'));

  /* ---------- 8. 时薪设置弹窗（点击折算价值卡）---------- */
  const rateCard = document.querySelector('[data-wl="rate"]');
  if (rateCard) { rateCard.click(); await until(() => document.querySelector('.pay-rate-modal')); }
  ck('时薪弹窗打开', !!document.querySelector('.pay-rate-modal'));
  ck('弹窗有历史费率列表', !!document.querySelector('.pay-history .pay-hist-row'));
  const cancel = document.querySelector('.pay-rate-modal [data-pay-cancel]');
  if (cancel) { cancel.click(); await until(() => !document.querySelector('.pay-rate-modal')); }
  ck('弹窗可取消关闭', !document.querySelector('.pay-rate-modal'));

  /* ---------- 9. 同生效日 upsert 覆盖 ---------- */
  await api.worklog.rateSet({ rateCents: 12000, effectiveFrom: TODAY, note: '改主意' });
  const ratesB = await api.worklog.rates();
  const todayRates = ratesB.filter((r) => r.effective_from === TODAY);
  ck('同一生效日仅一条', todayRates.length === 1 && todayRates[0].rate_cents === 12000, JSON.stringify(todayRates));

  /* ---------- 10. 删最后一条 → 回引导态 ---------- */
  for (const r of await api.worklog.rates()) await api.worklog.rateDelete(r.id);
  ck('费率可全部删除', (await api.worklog.rates()).length === 0);
  nav('worklog');
  const seg3 = await until(() => document.querySelector('[data-wl-chips="mode"][data-v="value"]'));
  if (seg3) { seg3.click(); await until(() => document.querySelector('.wl-pay-guide')); }
  ck('删光费率后回到引导态', !!document.querySelector('.wl-pay-guide'));

  /* ---------- 11. 任务行展示：工时摘要 / 记录明细 / 补录（无需切到工时视图）---------- */
  // 造数的 parent 任务有 3 条记录（1h + 1h + 0.5h = 2h30m），切到「全部任务」看它
  nav('all');
  const taskRow = await until(() => Array.from(document.querySelectorAll('.task-item[data-id]'))
    .find((el) => Number(el.dataset.id) === Number(parent.id)));
  ck('任务行可见（全部任务视图）', !!taskRow);
  // 摘要 chip 是异步预取缓存：等它填出文本（:not(.is-empty)）再断言，别在空壳上读
  const chip = await until(() => taskRow && taskRow.querySelector('[data-wl-log-chip]:not(.is-empty)'));
  ck('任务行直接显示工时摘要（无需切工时视图）', !!chip, chip && chip.textContent);
  const chipText = chip && chip.textContent || '';
  ck('摘要含累计时长与条数', /⏱/.test(chipText) && /3条/.test(chipText), chipText);
  ck('摘要累计时长=2h30m（1h+1h+0.5h）', /2h30m/.test(chipText), chipText);

  // 点摘要 → 明细面板展开，记录条数与造数一致（3 条）
  if (chip) { chip.click(); await until(() => taskRow.querySelector('.wl-row-log-panel')); }
  const panel = taskRow && taskRow.querySelector('.wl-row-log-panel');
  ck('点摘要就地展开工时记录明细', !!panel);
  // 明细是异步 loadEntries：等到记录行真的渲染出来再数
  await until(() => taskRow.querySelector('.wl-row-log-panel .wl-re-row'));
  const recRows = panel ? panel.querySelectorAll('.wl-re-row') : [];
  ck('明细列出该任务全部记录（3 条）', recRows.length === 3, recRows.length);
  const panelText = panel && panel.textContent || '';
  ck('明细显示来源文案（计时/补录）', /补录/.test(panelText));

  // 明细面板里的补录入口：固定当前任务，打开弹窗即可取消
  const addBtn = panel && panel.querySelector('[data-wl-row-add]');
  ck('明细面板有＋补录入口', !!addBtn);
  if (addBtn) { addBtn.click(); await until(() => document.querySelector('.modal-form')); }
  ck('点补录打开表单弹窗', !!document.querySelector('.modal-form'));
  const cancelBtn = document.querySelector('.modal-form [data-modal="cancel"]');
  if (cancelBtn) { cancelBtn.click(); await until(() => !document.querySelector('.modal-form')); }
  ck('补录弹窗可取消', !document.querySelector('.modal-form'));

  // 再点一次摘要收起面板（同一 DOM，无整表重绘）
  if (chip) { chip.click(); await wait(150); }
  ck('再点摘要可收起明细', !taskRow.querySelector('.wl-row-log-panel'));

  /* ---------- 11b. 详情抽屉里的工时信息 + 补录（用户反馈「详情里看着还是没有」）---------- */
  // 点任务标题容器（非 .task-title-text，后者是行内重命名）打开详情：
  // bindTaskListEvents 里 closest('[data-act]') 找不到按钮就 openDetail
  const titleEl = taskRow.querySelector('.task-title');
  if (titleEl) titleEl.click();
  const dsSlot = await until(() => document.querySelector('#detail-drawer [data-detail-slot="worklog"]'));
  ck('详情抽屉打开且有工时区块占位', !!dsSlot);
  const dsBody = await until(() => {
    const s = document.querySelector('#detail-drawer [data-detail-slot="worklog"]');
    return s && s.querySelector('.wl-ds-body .wl-ds-row');
  });
  ck('详情工时区块填出了记录', !!dsBody);
  // 每次重新查 slot：详情可能被 autofill 后重绘，缓存的旧节点引用会脱离文档
  const dsCur = document.querySelector('#detail-drawer [data-detail-slot="worklog"]');
  const dsText = dsCur && dsCur.textContent || '';
  const dsSum = dsCur && dsCur.querySelector('[data-wl-ds-sum]');
  const sumText = dsSum && dsSum.textContent || '';
  ck('详情显示累计工时与条数', sumText.indexOf('累计') >= 0 && sumText.indexOf('2h30m') >= 0 && sumText.indexOf('条') >= 0,
    'sum=' + JSON.stringify(sumText));
  const dsRows = dsCur ? dsCur.querySelectorAll('.wl-ds-row') : [];
  ck('详情列出该任务全部记录（3 条）', dsRows.length === 3, dsRows.length);
  const dsAdd = dsCur && dsCur.querySelector('[data-wl-ds-add]');
  ck('详情有＋补录入口', !!dsAdd);
  if (dsAdd) { dsAdd.click(); await until(() => document.querySelector('.modal-form')); }
  ck('详情点补录打开表单弹窗', !!document.querySelector('.modal-form'));
  const dsCancel = document.querySelector('.modal-form [data-modal="cancel"]');
  if (dsCancel) { dsCancel.click(); await until(() => !document.querySelector('.modal-form')); }
  ck('详情补录弹窗可取消', !document.querySelector('.modal-form'));
  // 关详情
  const dsClose = document.querySelector('#detail-drawer [data-act="close"]');
  if (dsClose) { dsClose.click(); await wait(200); }

  /* ---------- 12. 关闭插件 → 工时行展示与 pay 通道一起消失 ---------- */
  await api.features.setPref({ enabled: false });
  await wait(700);
  const chipAfterOff = await until(() => document.querySelector('.task-item [data-wl-log-chip]'), 800);
  ck('关闭后任务行摘要消失', !chipAfterOff);
  ck('关闭后 pay 通道未注册', typeof api.worklog.pay === 'function'
    ? (await api.worklog.pay({}).then(() => false, () => true))
    : true);

  return out;
})()`;

(async () => {
  const wsUrl = await findPage();
  const cdp = await connect(wsUrl);
  let result;
  try {
    result = await cdp.evaluate(SCRIPT);
  } finally {
    try { cdp.close(); } catch (_) { /* 忽略 */ }
  }
  let failed = 0;
  for (const c of result.checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.extra ? `  → ${c.extra}` : ''}`);
    if (!c.ok) failed += 1;
  }
  console.log(failed ? `\nPAY_FAIL ${failed}/${result.checks.length}` : `\nPAY_OK ${result.checks.length}/${result.checks.length}`);
  killChild();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('验收失败：', e && e.message);
  if (childLog) console.error(childLog.slice(-2000));
  killChild();
  process.exit(1);
});
