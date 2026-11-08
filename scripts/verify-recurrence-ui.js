'use strict';
/**
 * 重复待办端到端验证（真实 Electron 窗口 + CDP，跑在独立临时 userData 里）。
 *
 * 用法：node scripts/verify-recurrence-ui.js [port]
 *
 * 覆盖的是数据层单测覆盖不到的那一半：
 *  1. 就地编辑器里的「🔁 设为重复」开关与快捷规则；
 *  2. 从 UI 保存后，规则 + 实例 + 提醒时间是否真的落库；
 *  3. 任务列表行上的重复徽标；
 *  4. File 菜单对应的管理面板能否打开、渲染规则卡与习惯统计。
 *
 * 不污染用户数据：进程用 --user-data-dir 指向临时目录，结束即删。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9457';
const profile = path.join(os.tmpdir(), `knodo-recur-ui-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 宿主是 Electron 时会带这个值，不清掉 electron.exe 会退化成纯 node

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
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 文件仍被占用，留给系统临时目录清理 */ }
}

async function findPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && /renderer[\\/]index\.html|index\.html/.test(t.url));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (_) { /* 窗口还没起来 */ }
    await sleep(300);
  }
  throw new Error('找不到渲染进程调试页（CDP 连接超时）');
}

/** 极简 CDP 客户端：一次连接、顺序发 Runtime.evaluate */
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
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    }),
    close: () => ws.close(),
  };
}

const EXPRESSION = `(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // 数据隔离前置检查：不对着用户真实数据库写任何东西
    const info = await window.api.env.getStorageInfo();
    out.dataDir = info && info.dir;
    if (!/knodo-recur-ui-/.test(String(out.dataDir || '') + JSON.stringify(info || {}))) {
      throw new Error('数据目录未隔离，已中止（避免污染真实数据）：' + JSON.stringify(info));
    }
    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(500);
    // 先放一条普通一次性任务：验证「重复能力不影响一次性待办」
    await window.api.tasks.create({ title: 'CDP 一次性任务' });
    const add = document.querySelector('[data-act="start-add"]');
    if (!add) throw new Error('找不到「添加任务」入口');
    add.click();
    await wait(400);
    const ed = document.querySelector('.task-editor[data-editor="new"]');
    if (!ed) throw new Error('就地编辑器未展开');
    out.repeatToggleExists = !!ed.querySelector('.rpt-toggle');
    ed.querySelector('.rpt-toggle').click();
    await wait(150);
    out.repeatOn = ed.querySelector('.rpt-block').dataset.on === '1';
    out.panelShown = !ed.querySelector('.rpt-panel').hidden;
    ed.querySelector('[data-rpt-quick="workday"]').click();
    await wait(600); // 预览有 220ms 防抖 + IPC，等它渲染完
    const fields = ed.querySelector('.rpt-fields');
    out.freq = fields.querySelector('.rpt-freq').value;
    out.holiday = fields.querySelector('.rpt-holiday').value;
    out.weekdaysHidden = fields.querySelector('.rpt-weekdays').hidden;
    out.previewFilled = !fields.querySelector('.rpt-preview').hidden;
    out.previewText = fields.querySelector('.rpt-preview').textContent.trim();
    out.mutedPlanFields = ed.querySelectorAll('.is-rpt-muted').length;
    // 作为习惯记录打卡
    const habit = fields.querySelector('.rpt-habit');
    habit.checked = true;
    habit.dispatchEvent(new Event('change', { bubbles: true }));

    const title = ed.querySelector('.editor-title');
    title.value = 'CDP 抽盘仓库';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(120);
    ed.querySelector('[data-act="editor-save"]').click();
    await wait(1400);

    const rules = await window.api.recurrences.list();
    const tasks = await window.api.tasks.list({ status: 'any' });
    const inst = tasks.filter((t) => t.recurring_id != null);
    out.ruleCount = rules.length;
    out.summary = rules[0] ? rules[0].summary : '';
    out.nextDate = rules[0] ? rules[0].nextDate : '';
    out.instanceCount = inst.length;
    out.withReminder = inst.filter((t) => !!t.reminder_at).length;
    out.withDueDate = inst.filter((t) => !!t.plan_end).length;
    out.oneOffKept = tasks.some((t) => t.title === 'CDP 一次性任务' && t.recurring_id == null);
    out.noDuplicateOneOff = !tasks.some((t) => t.title === 'CDP 抽盘仓库' && t.recurring_id == null);
    out.editorClosed = !document.querySelector('.task-editor[data-editor="new"]');
    out.badgeCount = document.querySelectorAll('.recur-badge').length;
    out.habitBadge = document.querySelectorAll('.recur-badge.is-habit').length;

    // 管理面板：直接动态导入渲染层模块（与 File 菜单走的是同一个 openRecurrenceManager）
    const mod = await import('./js/recurrence.js');
    mod.openRecurrenceManager({ focusRuleId: rules[0] && rules[0].id });
    await wait(900);
    out.panelOpened = !!document.querySelector('.modal-mask .modal-recurrence');
    out.cardCount = document.querySelectorAll('.rc-card').length;
    out.metaText = (document.querySelector('#rc-meta') || {}).textContent || '';
    out.habitShown = !!document.querySelector('.rc-habit .rc-habit-stat');
    out.statsText = (document.querySelector('.rc-habit-top') || {}).textContent || '';
    const closeBtn = document.querySelector('.modal-mask [data-modal="ok"]');
    if (closeBtn) closeBtn.click();
    await wait(400);

    // 勾选一次完成 → 习惯统计必须刷新（回归：面板曾缓存旧统计）
    await window.api.tasks.toggle(inst[0].id);
    await wait(400);
    out.doneInstances = (await window.api.recurrences.stats(rules[0].id)).doneInstances;
    mod.openRecurrenceManager();
    await wait(900);
    out.statsAfterToggle = (document.querySelector('.rc-habit-top') || {}).textContent || '';

    // 用户痛点：设了重复 10 天想改成 8 天。从管理面板改结束日，任务数与打卡数都不该变
    document.querySelector('.rc-card [data-rc-act="edit"]').click();
    await wait(400);
    const rcFields = document.querySelector('#rc-editor .rpt-fields');
    const d8 = new Date(); d8.setDate(d8.getDate() + 8);
    const iso8 = d8.getFullYear() + '-' + String(d8.getMonth() + 1).padStart(2, '0')
      + '-' + String(d8.getDate()).padStart(2, '0');
    const endInput = rcFields.querySelector('.rpt-end');
    endInput.value = iso8;
    endInput.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#rc-editor [data-rc-act="editor-save"]').click();
    await wait(900);
    const editedRule = (await window.api.recurrences.list())[0];
    out.endDateAfterEdit = editedRule.end_date;
    out.expectedEndDate = iso8;
    out.tasksAfterRuleEdit = (await window.api.tasks.list({ status: 'any' }))
      .filter((t) => t.recurring_id === rules[0].id).length;
    out.ledgerAfterRuleEdit = (await window.api.recurrences.completions(rules[0].id)).length;

    // 停止规则：不再排期，但任务与打卡历史都保留；再启用会重新排期
    document.querySelector('.rc-card [data-rc-act="toggle"]').click();
    await wait(900);
    const stopped = (await window.api.recurrences.list())[0];
    out.stopped = !!stopped && stopped.enabled === false;
    const afterStop = await window.api.tasks.list({ status: 'any' });
    const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();
    out.futureAfterStop = afterStop.filter((t) => t.recurring_id === rules[0].id
      && t.occurrence_date != null).length;
    out.stoppedNoSchedule = afterStop.some((t) => t.id === inst[0].id && t.occurrence_date == null);
    out.ledgerKeptOnStop = (await window.api.recurrences.completions(rules[0].id)).length === 1;
    document.querySelector('.rc-card [data-rc-act="toggle"]').click();
    await wait(900);
    out.enabledAgain = (await window.api.recurrences.list())[0].enabled === true;
    out.futureAfterRestart = (await window.api.tasks.list({ status: 'any' }))
      .filter((t) => t.recurring_id === rules[0].id && t.occurrence_date != null).length;
    const closeBtn2 = document.querySelector('.modal-mask [data-modal="ok"]');
    if (closeBtn2) closeBtn2.click();
    await wait(400);

    // 详情抽屉：用户明确要求「详情中也要支持设置重复时间和提醒」
    const detailMod = await import('./js/detail.js');
    detailMod.openDetail(inst[0].id);
    await wait(1100);
    const drawer = document.getElementById('detail-drawer');
    const rep = drawer && drawer.querySelector('[data-detail-repeat]');
    out.detailRepeatExists = !!rep;
    out.detailRemindField = !!(rep && rep.querySelector('.rpt-fields .rpt-remind-time'));
    out.detailHasSave = !!(rep && rep.querySelector('[data-detail-repeat-act="save"]'));
    out.detailRuleOn = !!(rep && rep.querySelector('.rpt-block').dataset.on === '1');
    if (rep) {
      const timeEl = rep.querySelector('.rpt-remind-time');
      out.detailRemindBefore = timeEl.value;
      timeEl.value = '10:45';
      timeEl.dispatchEvent(new Event('change', { bubbles: true }));
      rep.querySelector('[data-detail-repeat-act="save"]').click();
      await wait(1300);
    }
    const afterDetail = (await window.api.tasks.list({ status: 'any' }))
      .find((t) => t.id === inst[0].id);
    out.detailSavedReminder = !!afterDetail && !!afterDetail.reminder_at
      && new Date(afterDetail.reminder_at).getHours() === 10
      && new Date(afterDetail.reminder_at).getMinutes() === 45;
    out.detailStillOneTask = (await window.api.tasks.list({ status: 'any' }))
      .filter((t) => t.recurring_id === rules[0].id).length === 1;
    detailMod.closeDetail();
    await wait(400);

    // 编辑一条已有的一次性任务 → 就地转为重复（originTaskId，附件/关联不丢）
    const plain = await window.api.tasks.create({ title: 'CDP 待转重复' });
    document.querySelector('.nav-item[data-view="today"]').click();
    await wait(400);
    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(500);
    const row = [...document.querySelectorAll('.task-item')]
      .find((li) => (li.querySelector('.task-title-text') || {}).textContent === 'CDP 待转重复');
    out.plainRowFound = !!row;
    if (row) {
      row.querySelector('[data-act="edit"]').click();
      await wait(500);
      const ed2 = document.querySelector('.task-editor[data-editor="' + plain.id + '"]');
      out.editHasRepeatToggle = !!(ed2 && ed2.querySelector('.rpt-toggle'));
      ed2.querySelector('.rpt-toggle').click();
      await wait(200);
      ed2.querySelector('[data-rpt-quick="daily"]').click();
      await wait(300);
      ed2.querySelector('[data-act="editor-save"]').click();
      await wait(1400);
      const rules2 = await window.api.recurrences.list();
      const all2 = await window.api.tasks.list({ status: 'any' });
      out.convertedRule = rules2.some((x) => x.title === 'CDP 待转重复');
      out.originKept = all2.some((t) => t.id === plain.id && t.recurring_id != null);
      out.noExtraOneOff = !all2.some((t) => t.title === 'CDP 待转重复' && t.recurring_id == null);
    }

    /* ---- 本次修复的验收点：今天判据（P-06）、派生日期只读（P-01/P-02）、
           预览按结束日截断（P-03）、今天不发生有说明（P-08） ---- */
    const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
    const todayS = ymd(new Date());
    const plusD = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

    // 改成「每天 + 发生日 2 天后截止」：发生日就是今天，但 plan_end 在 2 天后
    await window.api.recurrences.update(rules[0].id, {
      rule: { freq: 'daily', dueOffsetDays: 2, reminderTime: '09:00' },
    });
    const t2d = (await window.api.tasks.list({ status: 'any' })).find((t) => t.id === inst[0].id);
    out.occurrenceIsToday = t2d.occurrence_date === todayS;
    out.planEndLater = t2d.plan_end > todayS;
    out.planEndValue = t2d.plan_end;

    // P-06：发生日当天就要在「今天」，不能等截止日
    document.querySelector('.nav-item[data-view="today"]').click();
    await wait(800);
    const todayLi = [...document.querySelectorAll('.task-item')]
      .find((x) => /CDP 抽盘仓库/.test((x.querySelector('.task-title-text') || {}).textContent || ''));
    out.todayHasRecur = !!todayLi;
    out.todayRecurMeta = todayLi ? todayLi.querySelector('.task-meta').textContent.replace(/\s+/g, ' ').trim() : '';
    // 已逾期判断不应因为「截止日还在未来」而漏掉；同上，row 里应带「本次」
    out.todayRecurShowsOccurrence = /本次/.test(out.todayRecurMeta || '');

    // P-01/P-02：详情里计划时间只读，改标题不会把日期写回旧值
    detailMod.openDetail(inst[0].id);
    await wait(1100);
    const dr2 = document.getElementById('detail-drawer');
    out.detailDerived = !!(dr2 && dr2.querySelector('[data-rpt-derived]'));
    // 子任务行 / 子任务新增区仍各自有日期控件，只判定主任务那一个
    out.detailPlanEditable = dr2
      ? [...dr2.querySelectorAll('.date-range-field')]
        .filter((el) => !el.closest('.subtask-item, .subtask-add')).length > 0
      : true;
    out.detailDerivedText = dr2
      ? (dr2.querySelector('[data-rpt-derived]').textContent || '').replace(/\s+/g, ' ').trim()
      : '';
    const title2 = dr2.querySelector('.detail-title');
    title2.value = 'CDP 抽盘仓库·改标题';
    title2.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(1500);
    const afterTitle = (await window.api.tasks.list({ status: 'any' })).find((t) => t.id === inst[0].id);
    out.planKeptAfterTitle = afterTitle.plan_start === t2d.plan_start && afterTitle.plan_end === t2d.plan_end;
    out.titleSaved = afterTitle.title === 'CDP 抽盘仓库·改标题';
    detailMod.closeDetail();
    await wait(400);

    // P-03/P-11：结束日参与预览截断，标题标出区间
    mod.openRecurrenceManager({ focusRuleId: rules[0].id });
    await wait(900);
    document.querySelector('.rc-card [data-rc-act="edit"]').click();
    // 编辑区渲染完成再动字段（预览有 220ms 防抖 + 一次 IPC，轮询到出结果为止）
    let pf = null;
    for (let i = 0; i < 15 && !pf; i += 1) {
      await wait(200);
      pf = document.querySelector('#rc-editor .rpt-fields');
    }
    const endIn = pf.querySelector('.rpt-end');
    endIn.value = plusD(2);
    endIn.dispatchEvent(new Event('change', { bubbles: true }));
    const previewBox = pf.querySelector('.rpt-preview');
    let previewDays = [];
    for (let i = 0; i < 15; i += 1) {
      await wait(200);
      previewDays = [...pf.querySelectorAll('.rpt-preview-day')].map((e) => e.textContent);
      if (previewDays.length) break;
    }
    out.previewDays = previewDays;
    out.previewEnd = plusD(2).slice(5);
    out.previewLabel = (pf.querySelector('.rpt-preview-label') || {}).textContent || '';
    out.previewStartInput = (pf.querySelector('.rpt-start') || {}).value || '';
    out.previewEndInput = endIn.value;
    out.previewDebug = (previewBox ? (previewBox.hidden ? 'hidden' : 'shown') : 'no-box')
      + ' | ' + (previewBox ? previewBox.textContent : '').slice(0, 60);
    const saveRuleBtn = document.querySelector('#rc-editor [data-rc-act="editor-save"]');
    if (saveRuleBtn) saveRuleBtn.click();
    await wait(1000);
    const closeBtn3 = document.querySelector('.modal-mask [data-modal="ok"]');
    if (closeBtn3) closeBtn3.click();
    await wait(400);

    // P-08：今天不发生的重复事项要有说明（而不是静默消失）
    const otherWd = (new Date().getDay() + 3) % 7; // 一定不是今天
    await window.api.recurrences.create({
      title: 'CDP 每周一次',
      rule: { freq: 'weekly', weekdays: [otherWd], reminderTime: '' },
      startDate: todayS,
    });
    document.querySelector('.nav-item[data-view="today"]').click();
    await wait(1000);
    out.pendingSection = !!document.querySelector('.recur-pending');
    out.pendingCount = (document.querySelector('.recur-pending .tg-count') || {}).textContent || '';
    const pendHead = document.querySelector('[data-act="toggle-recur-pending"]');
    if (pendHead) pendHead.click();
    await wait(800);
    out.pendingRows = document.querySelectorAll('.task-list.is-pending .task-item').length;
    out.pendingStates = [...document.querySelectorAll('.task-list.is-pending .recur-state')]
      .map((e) => e.textContent.trim());
    out.pendingCheckDisabled = [...document.querySelectorAll('.task-list.is-pending .task-check')]
      .every((b) => b.disabled === true);

    // 就地编辑：这些行不在主列表里，点「✎ 编辑」也得真的出现编辑器
    const pendRow = document.querySelector('.task-list.is-pending .task-item');
    if (pendRow && pendRow.querySelector('[data-act="edit"]')) {
      pendRow.querySelector('[data-act="edit"]').click();
      await wait(800);
    }
    const pendEd = document.querySelector('.task-list.is-pending .task-editor');
    out.pendingEditorOpened = !!pendEd;
    out.pendingEditorDerived = !!(pendEd && pendEd.dataset.derived === '1');
    out.pendingEditorNoDateField = !pendEd
      || (!pendEd.querySelector('.date-range-field') && !pendEd.querySelector('.reminder-field'));
    if (pendEd && pendEd.querySelector('[data-act="editor-cancel"]')) {
      pendEd.querySelector('[data-act="editor-cancel"]').click();
      await wait(600);
    }

    // P-09：「全部任务」里也能看出这条是「今天不发生 / 已暂停 / 已结束」，不是被删了
    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(900);
    const allLi = [...document.querySelectorAll('.task-item')]
      .find((x) => (x.querySelector('.task-title-text') || {}).textContent === 'CDP 每周一次');
    out.allViewStateBadge = !!(allLi && allLi.querySelector('.recur-state'));
    out.allViewStateText = allLi && allLi.querySelector('.recur-state')
      ? allLi.querySelector('.recur-state').textContent.trim() : '';
    await window.api.recurrences.list().then(async (rs) => {
      const weekly = rs.find((x) => x.title === 'CDP 每周一次');
      if (weekly) await window.api.recurrences.setEnabled(weekly.id, false);
    });
    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(900);
    const pausedLi = [...document.querySelectorAll('.task-item')]
      .find((x) => (x.querySelector('.task-title-text') || {}).textContent === 'CDP 每周一次');
    out.pausedBadgeText = pausedLi && pausedLi.querySelector('.recur-state')
      ? pausedLi.querySelector('.recur-state').textContent.trim() : '';
  } catch (e) {
    out.__error = (e && e.message) || String(e);
  }
  return out;
})()`;

(async () => {
  let cdp = null;
  try {
    const wsUrl = await findPage();
    cdp = await connect(wsUrl);
    // 等渲染层 init 完成
    for (let i = 0; i < 40; i += 1) {
      const ready = await cdp.evaluate('window.__appReady === true');
      if (ready && ready.result && ready.result.value === true) break;
      await sleep(300);
    }
    const res = await cdp.evaluate(EXPRESSION);
    const r = (res && res.result && res.result.value) || {};
    console.log('\n[重复待办 · UI 端到端]');
    console.log(JSON.stringify(r, null, 2));
    const checks = [
      ['编辑器有「设为重复」开关', r.repeatToggleExists === true],
      ['开关能展开配置面板', r.repeatOn === true && r.panelShown === true],
      ['「每个法定工作日」快捷生效', r.freq === 'workday' && r.holiday === 'cn'],
      ['条件字段按频率收敛', r.weekdaysHidden === true],
      ['接下来预览已渲染', r.previewFilled === true],
      ['一次性字段被弱化提示', r.mutedPlanFields === 2],
      ['保存后生成规则', r.ruleCount === 1],
      ['规则摘要含法定工作日与提醒', /法定工作日/.test(r.summary || '') && /提醒/.test(r.summary || '')],
      ['有下一次发生日', !!r.nextDate],
      ['重复事项只有一条任务（不再按天铺 N 条）', r.instanceCount === 1],
      ['这一条带提醒时间', r.withReminder === 1],
      ['这一条带完成日', r.withDueDate === 1],
      ['一次性任务仍可共存', r.oneOffKept === true],
      ['开启重复不会多出同名一次性任务', r.noDuplicateOneOff === true],
      ['保存后编辑器关闭', r.editorClosed === true],
      ['任务行出现重复徽标', (r.badgeCount || 0) > 0],
      ['习惯徽标可见', (r.habitBadge || 0) > 0],
      ['管理面板可打开', r.panelOpened === true],
      ['管理面板渲染规则卡', r.cardCount === 1],
      ['节假日覆盖提示可见', /2026/.test(r.metaText || '')],
      ['习惯统计可见', r.habitShown === true && /连续/.test(r.statsText || '')],
      ['勾选完成被记录', r.doneInstances === 1],
      ['面板重开后统计刷新', /累计完成\s*1\s*次/.test(r.statsAfterToggle || '')],
      ['可停止重复规则', r.stopped === true],
      ['改结束日（10天→8天）已生效', !!r.endDateAfterEdit && r.endDateAfterEdit === r.expectedEndDate],
      ['改规则不会重建任务', r.tasksAfterRuleEdit === 1],
      ['改规则不会清掉打卡历史', r.ledgerAfterRuleEdit === 1],
      ['停止后不再排期', r.futureAfterStop === 0 && r.stoppedNoSchedule === true],
      ['停止后打卡历史保留', r.ledgerKeptOnStop === true],
      ['可重新启用规则', r.enabledAgain === true],
      ['重启后这一条恢复排期', r.futureAfterRestart === 1],
      ['详情抽屉有「重复与提醒」区', r.detailRepeatExists === true],
      ['详情里能设置提醒时间', r.detailRemindField === true && !!r.detailRemindBefore],
      ['详情里规则默认已开启', r.detailRuleOn === true],
      ['详情里有保存重复设置按钮', r.detailHasSave === true],
      ['详情里改提醒时间能写回规则', r.detailSavedReminder === true],
      ['详情保存后仍只有一条任务', r.detailStillOneTask === true],
      ['已有一次性任务可在列表里找到', r.plainRowFound === true],
      ['编辑态也有「设为重复」开关', r.editHasRepeatToggle === true],
      ['编辑后转为重复规则', r.convertedRule === true],
      ['原任务就地变成重复事项（id 不变）', r.originKept === true],
      ['转重复后没有多出一条同名任务', r.noExtraOneOff === true],
      // 本次修复：今天判据 / 派生日期只读 / 预览截断 / 今天不发生有说明
      ['发生日就是今天', r.occurrenceIsToday === true],
      ['截止日仍在未来（正是旧判据出错的那个组合）', r.planEndLater === true],
      ['P-06 发生日当天就在「今天」', r.todayHasRecur === true],
      ['P-05 行内日期写成语义明确的「本次」', r.todayRecurShowsOccurrence === true],
      ['P-01 详情里计划时间是只读派生展示', r.detailDerived === true && r.detailPlanEditable === false],
      ['P-01 派生展示含本次 / 截止 / 提醒', /本次/.test(r.detailDerivedText || '') && /截止/.test(r.detailDerivedText || '')],
      ['P-02 改标题后发生日与截止日不倒退', r.planKeptAfterTitle === true],
      ['P-02 标题照常保存', r.titleSaved === true],
      ['P-03 预览不越过结束日', (r.previewDays || []).every((d) => d <= r.previewEnd)],
      ['P-03 预览至少排到今天', (r.previewDays || []).length > 0],
      ['P-11 预览标题标出区间', /接下来\s*\d+\s*次/.test(r.previewLabel || '') && /~/.test(r.previewLabel || '')],
      ['P-08 今天不发生有独立说明区', r.pendingSection === true && Number(r.pendingCount) >= 1],
      ['P-08 展开后能看到下次是几号', r.pendingRows >= 1 && (r.pendingStates || []).some((s) => /下次/.test(s))],
      ['P-08 非发生日不可打卡（避免记错日期）', r.pendingCheckDisabled === true],
      ['P-08 「今天不发生」行也能就地编辑', r.pendingEditorOpened === true && r.pendingEditorDerived === true],
      ['P-01 派生编辑器里没有日期 / 提醒输入控件', r.pendingEditorNoDateField === true],
      ['P-09 「全部任务」里有状态角标', r.allViewStateBadge === true && /下次/.test(r.allViewStateText || '')],
      ['P-09 暂停后角标变「已暂停」', /已暂停/.test(r.pausedBadgeText || '')],
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
