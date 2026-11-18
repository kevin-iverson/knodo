'use strict';
/**
 * 「取消重复」端到端验证（真实 Electron 窗口 + CDP，独立临时 userData）。
 *
 * 用法：node scripts/verify-cancel-recur.js [port]
 *
 * 验收点（对应「设置重复任务后无法取消重复」的修复）：
 *  1. 详情抽屉里有独立的「取消重复」按钮，点它就真的把规则删掉、任务保留为普通待办；
 *  2. 详情里把开关关掉再保存，同样按「取消重复」处理（不再只是 setEnabled(false) 假暂停）；
 *  3. 抽屉重绘后开关状态跟 rule.enabled 一致：暂停的规则显示「已暂停」而不是「已开启」；
 *  4. 暂停的规则在详情里打开开关 + 保存能真正恢复排期（enabled 回 true）；
 *  5. 列表就地编辑器里有「取消重复」，点它同样能脱钩成普通待办；
 *  6. 管理面板的按钮改叫「取消重复」，行为不变。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9463';
const profile = path.join(os.tmpdir(), `knodo-cancel-recur-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 宿主是 Electron 时会带这个值，不清掉会退化成纯 node

const child = spawn(electronBin, [
  root,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

let childLog = '';
child.stdout.on('data', (b) => { childLog += b.toString(); });
child.stderr.on('data', (b) => { childLog += b.toString(); });

function killChild() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* 已退出 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 占用中，交给系统清理 */ }
}

async function findPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (_) { /* 窗口还没起来 */ }
    await sleep(300);
  }
  throw new Error('CDP 连接超时');
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
  return {
    evaluate: (expression) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    }),
    close: () => ws.close(),
  };
}

const EXPR = `(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();
  const rules = () => window.api.recurrences.list();
  const tasks = () => window.api.tasks.list({ status: 'any' });
  const reopenDrawer = async (id) => {
    const detail = await import('./js/detail.js');
    detail.openDetail(id);
    await wait(1200);
    return document.querySelector('#detail-drawer [data-detail-repeat]');
  };
  try {
    const info = await window.api.env.getStorageInfo();
    if (!/knodo-cancel-recur-/.test(String(info && info.dir))) throw new Error('数据目录未隔离：' + JSON.stringify(info));
    window.confirm = () => true; // 原生确认框在 CDP 里会阻塞，直接放行
    const detailMod = await import('./js/detail.js');

    /* ---------- 1. 详情：独立「取消重复」按钮 ---------- */
    await window.api.recurrences.create({ title: '取消A', rule: { freq: 'daily', reminderTime: '09:00' }, startDate: today });
    let ruleA = (await rules()).find((r) => r.title === '取消A');
    let taskA = (await tasks()).find((t) => t.recurring_id === ruleA.id);
    let rep = await reopenDrawer(taskA.id);
    out.detailCancelBtn = !!rep.querySelector('[data-detail-repeat-act="cancel"]');
    out.detailCancelText = (rep.querySelector('[data-detail-repeat-act="cancel"]') || {}).textContent || '';
    rep.querySelector('[data-detail-repeat-act="cancel"]').click();
    await wait(1600);
    out.aRuleGone = !(await rules()).some((r) => r.id === ruleA.id);
    const taskAAfter = (await tasks()).find((t) => t.id === taskA.id);
    out.aTaskKept = !!taskAAfter;
    out.aTaskDetached = !!taskAAfter && taskAAfter.recurring_id == null;
    const repA2 = document.querySelector('#detail-drawer [data-detail-repeat]');
    out.aDrawerSwitchedToPlain = !!repA2 && repA2.querySelector('.rpt-block').dataset.on === '0'
      && !repA2.querySelector('[data-detail-repeat-act="cancel"]');
    detailMod.closeDetail();
    await wait(400);

    /* ---------- 2. 详情：关掉开关 + 保存 = 取消重复 ---------- */
    const plainTask = await window.api.tasks.create({ title: '取消B' });
    rep = await reopenDrawer(plainTask.id);
    rep.querySelector('.rpt-toggle').click();
    await wait(200);
    rep.querySelector('[data-detail-repeat-act="save"]').click();
    await wait(1500);
    const ruleB = (await rules()).find((r) => r.title === '取消B');
    out.bRuleCreated = !!ruleB;
    rep = await reopenDrawer(plainTask.id);
    rep.querySelector('.rpt-toggle').click(); // 关掉
    await wait(200);
    rep.querySelector('[data-detail-repeat-act="save"]').click();
    await wait(1600);
    out.bRuleGone = !(await rules()).some((r) => r.title === '取消B');
    const taskBAfter = (await tasks()).find((t) => t.id === plainTask.id);
    out.bTaskKept = !!taskBAfter && taskBAfter.recurring_id == null;
    detailMod.closeDetail();
    await wait(400);

    /* ---------- 3. 暂停态：开关必须显示为关，且不再是「已开启」 ---------- */
    await window.api.recurrences.create({ title: '取消C', rule: { freq: 'daily' }, startDate: today });
    const ruleC = (await rules()).find((r) => r.title === '取消C');
    const taskC = (await tasks()).find((t) => t.recurring_id === ruleC.id);
    await window.api.recurrences.setEnabled(ruleC.id, false);
    rep = await reopenDrawer(taskC.id);
    out.cToggleOffWhenPaused = rep.querySelector('.rpt-block').dataset.on === '0';
    out.cToggleText = rep.querySelector('.rpt-toggle').textContent.trim();
    out.cSummaryPaused = /已暂停/.test((rep.querySelector('.rpt-detail-summary') || {}).textContent || '');
    /* ---------- 4. 暂停后重新打开开关 + 保存 = 恢复排期 ---------- */
    rep.querySelector('.rpt-toggle').click();
    await wait(200);
    rep.querySelector('[data-detail-repeat-act="save"]').click();
    await wait(1500);
    const ruleC2 = (await rules()).find((r) => r.id === ruleC.id);
    out.cResumed = !!ruleC2 && ruleC2.enabled === true;
    detailMod.closeDetail();
    await wait(400);

    /* ---------- 5. 列表就地编辑器里的「取消重复」 ---------- */
    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(900);
    const row = [...document.querySelectorAll('.task-item')]
      .find((li) => /取消C/.test((li.querySelector('.task-title-text') || {}).textContent || ''));
    out.inlineRowFound = !!row;
    if (row) {
      row.querySelector('[data-act="edit"]').click();
      await wait(700);
      const ed = document.querySelector('.task-editor[data-editor="' + taskC.id + '"]');
      const btn = ed && ed.querySelector('[data-act="detach-recur"]');
      out.inlineCancelBtn = !!btn;
      if (btn) btn.click();
      await wait(1800);
    }
    out.inlineRuleGone = !(await rules()).some((r) => r.id === ruleC.id);
    const taskCAfter = (await tasks()).find((t) => t.id === taskC.id);
    out.inlineTaskKept = !!taskCAfter && taskCAfter.recurring_id == null;
    out.inlineEditorClosed = !document.querySelector('.task-editor[data-editor="' + taskC.id + '"]');

    /* ---------- 6. 管理面板：按钮改叫「取消重复」，行为不变 ---------- */
    await window.api.recurrences.create({ title: '取消D', rule: { freq: 'daily' }, startDate: today });
    const ruleD = (await rules()).find((r) => r.title === '取消D');
    const taskD = (await tasks()).find((t) => t.recurring_id === ruleD.id);
    const mod = await import('./js/recurrence.js');
    mod.openRecurrenceManager({ focusRuleId: ruleD.id });
    await wait(1000);
    const card = document.querySelector('[data-rc-id="' + ruleD.id + '"]');
    const removeBtn = card && card.querySelector('[data-rc-act="remove"]');
    out.managerBtnText = removeBtn ? removeBtn.textContent.trim() : '';
    if (removeBtn) removeBtn.click();
    await wait(1400);
    out.managerRuleGone = !(await rules()).some((r) => r.id === ruleD.id);
    const taskDAfter = (await tasks()).find((t) => t.id === taskD.id);
    out.managerTaskKept = !!taskDAfter && taskDAfter.recurring_id == null;
    const okBtn = document.querySelector('.modal-mask [data-modal="ok"]');
    if (okBtn) okBtn.click();
    await wait(300);
  } catch (e) {
    out.__error = (e && e.stack) || String(e);
  }
  return out;
})()`;

(async () => {
  let cdp = null;
  try {
    const wsUrl = await findPage();
    cdp = await connect(wsUrl);
    for (let i = 0; i < 40; i += 1) {
      const ready = await cdp.evaluate('window.__appReady === true');
      if (ready && ready.result && ready.result.value === true) break;
      await sleep(300);
    }
    const res = await cdp.evaluate(EXPR);
    const r = (res && res.result && res.result.value) || {};
    console.log('\n[取消重复 · 端到端]');
    console.log(JSON.stringify(r, null, 2));
    const checks = [
      ['详情里有独立的「取消重复」按钮', r.detailCancelBtn === true && /取消重复/.test(r.detailCancelText || '')],
      ['点它真的删掉规则', r.aRuleGone === true],
      ['任务本身保留', r.aTaskKept === true],
      ['任务已脱钩（recurring_id 为空）', r.aTaskDetached === true],
      ['抽屉重绘后变回「设为重复」', r.aDrawerSwitchedToPlain === true],
      ['详情里能设重复（建立前置）', r.bRuleCreated === true],
      ['关掉开关 + 保存 = 取消重复', r.bRuleGone === true && r.bTaskKept === true],
      ['暂停的规则开关显示为关', r.cToggleOffWhenPaused === true],
      ['暂停态文案是「已暂停」而不是「已开启」', /已暂停/.test(r.cToggleText || '')],
      ['摘要标出已暂停', r.cSummaryPaused === true],
      ['暂停后重新打开 + 保存能恢复排期', r.cResumed === true],
      ['列表就地编辑器有「取消重复」', r.inlineCancelBtn === true],
      ['就地取消后规则消失', r.inlineRuleGone === true],
      ['就地取消后任务保留且脱钩', r.inlineTaskKept === true],
      ['就地取消后编辑器关闭', r.inlineEditorClosed === true],
      ['管理面板按钮是「取消重复」', /取消重复/.test(r.managerBtnText || '')],
      ['管理面板取消后规则消失、任务保留', r.managerRuleGone === true && r.managerTaskKept === true],
    ];
    let failed = 0;
    for (const [name, ok] of checks) {
      console.log(`  ${ok ? '✓' : '✗'} ${name}`);
      if (!ok) failed += 1;
    }
    if (r.__error) { console.error('  页面内异常：', r.__error); failed += 1; }
    console.log(`\n结果：${checks.length - failed} 通过 / ${failed} 失败`);
    if (failed) console.error('\n--- 应用日志（尾部）---\n' + childLog.slice(-2000));
    if (cdp) cdp.close();
    killChild();
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('验证失败：', (e && e.stack) || e);
    console.error('\n--- 应用日志（尾部）---\n' + childLog.slice(-3000));
    if (cdp) cdp.close();
    killChild();
    process.exit(1);
  }
})();
