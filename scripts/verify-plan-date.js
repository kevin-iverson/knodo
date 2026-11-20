'use strict';
/**
 * 「计划模式默认开启 + 可关闭降级为单截止日期」的回归验证。
 *
 * 钉四件事：
 *  1. 出厂默认（无 tool.taskDate）下，新建编辑器的日期控件是计划模式（起止日期段）：
 *     data-single=0、占位为「计划开始 ~ 完成」、面板有起止两次点选提示与「本周末」；
 *  2. 计划模式点「今天」快捷写 plan_start === plan_end === 今天（range 模式选同一天）；
 *  3. 设置中心「通用 → 计划模式」开关初始为开，关掉后写入 rangeMode=false 并即时降级为单日期；
 *  4. 重新打开后回到计划模式。
 *
 * 用法：node scripts/verify-plan-date.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9513';
const profile = path.join(os.tmpdir(), `knodo-plan-date-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

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
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 交给系统清理 */ }
}

async function listPages() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) return list.filter((t) => t.type === 'page');
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
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
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

(async () => {
  const fail = (msg, extra) => {
    console.log(`[PLAN-DATE] FAIL：${msg}`);
    if (extra) console.log(`[PLAN-DATE] ${JSON.stringify(extra)}`);
    killChild();
    process.exit(1);
  };

  try {
    console.log('[PLAN-DATE] 启动隔离实例…');
    await listPages();
    const pages = await listPages();
    const mainPage = pages.find((t) => /index\.html/.test(t.url));
    if (!mainPage) throw new Error('没找到主窗口页面');
    const main = await connect(mainPage.webSocketDebuggerUrl);
    console.log('[PLAN-DATE] CDP 已连接，等待渲染层初始化…');
    await sleep(1500);

    const out = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const info = await window.api.env.getStorageInfo();
      if (!/knodo-plan-date-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
      const out = {};

      const ED = '.task-editor[data-editor="new"]';
      const snapshot = () => {
        const dr = document.querySelector(ED + ' .date-range-field');
        if (!dr) return { exists: false };
        return {
          exists: true,
          single: dr.dataset.single,
          text: dr.querySelector('.dr-text').textContent.trim(),
          daysHidden: dr.querySelector('.dr-days').hidden,
          start: dr.querySelector('.dr-start-input').value,
          end: dr.querySelector('.dr-end-input').value,
        };
      };
      const openEditor = async () => {
        document.getElementById('btn-new-task').click();
        await wait(850);
      };
      const closeEditor = async () => {
        const t = document.querySelector(ED + ' .editor-title');
        if (t) t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(500);
      };
      const panelInfo = () => {
        const cal = document.querySelector('.flatpickr-calendar.open');
        if (!cal) return { open: false };
        return {
          open: true,
          hint: (cal.querySelector('.dr-fp-hint') || {}).textContent || '',
          weekend: !!cal.querySelector('[data-quick="weekend"]'),
        };
      };
      // openSettings() 返回的是「面板关闭 Promise」，不能 await（面板没关就死锁）
      const toggleSwitch = async (want) => {
        window.__openSettings('general');
        await wait(1000);
        const sw = document.querySelector('#st-plan-range-mode');
        if (!sw) return { found: false };
        const initial = sw.checked;
        if (sw.checked !== want) {
          sw.checked = want;
          sw.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await wait(1000);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(700);
        return { found: true, initial };
      };

      out.pref0 = await window.api.ui.getToolPref('taskDate');

      // 切到「全部任务」：避开「今天」视图默认预填今天的内置逻辑，才能看到真实占位文案
      document.querySelector('.nav-item[data-view="all"]').click();
      await wait(700);

      // 默认形态应为计划模式（日期段）
      await openEditor();
      out.default = snapshot();
      document.querySelector(ED + ' .date-range-trigger').click();
      await wait(350);
      out.defaultPanel = panelInfo();

      // 计划模式点「今天」快捷：起止同为今天
      const todayQuick = document.querySelector('.flatpickr-calendar.open [data-quick="today"]');
      if (todayQuick) todayQuick.click();
      await wait(450);
      out.afterPick = snapshot();

      // 保存并复核落库两端一致
      const ed = document.querySelector(ED);
      ed.querySelector('.editor-title').value = '计划模式验证 ' + Date.now();
      ed.querySelector('[data-act="editor-save"]').click();
      await wait(1000);
      const tasks = await window.api.tasks.list({ status: 'any' });
      const created = (tasks || []).find((t) => /^计划模式验证 /.test(String(t.title || '')));
      out.saved = created ? { start: created.plan_start, end: created.plan_end } : null;

      // 关掉计划模式 → 降级单日期
      out.switchOff = await toggleSwitch(false);
      out.prefOff = await window.api.ui.getToolPref('taskDate');
      await openEditor();
      out.single = snapshot();
      document.querySelector(ED + ' .date-range-trigger').click();
      await wait(350);
      out.singlePanel = panelInfo();
      await closeEditor();

      // 再打开计划模式 → 回到日期段
      out.switchOn = await toggleSwitch(true);
      out.prefOn = await window.api.ui.getToolPref('taskDate');
      await openEditor();
      out.restored = snapshot();
      await closeEditor();

      return out;
    })()`);

    console.log(`[PLAN-DATE] ${JSON.stringify(out, null, 2)}`);

    const problems = [];
    if (!out.default || !out.default.exists) problems.push('新建编辑器里没有日期控件');
    if (out.default && out.default.single !== '0') problems.push('默认不是计划模式（data-single 应为 0）');
    if (out.default && !/计划开始/.test(out.default.text)) problems.push('默认占位不是「计划开始 ~ 完成」');
    if (out.defaultPanel && !out.defaultPanel.open) problems.push('点触发器没打开日历');
    if (out.defaultPanel && !/开始日期/.test(out.defaultPanel.hint)) problems.push('计划模式面板缺少起止两次点选提示');
    if (out.defaultPanel && out.defaultPanel.weekend !== true) problems.push('计划模式面板缺少「本周末」快捷');
    if (!out.afterPick || !out.afterPick.start || out.afterPick.start !== out.afterPick.end) {
      problems.push('计划模式点「今天」后 plan_start 与 plan_end 不是同一天');
    }
    if (!out.saved || !out.saved.start || out.saved.start !== out.saved.end) {
      problems.push('落库后 plan_start 与 plan_end 不一致');
    }
    if (!out.switchOff || !out.switchOff.found) problems.push('设置中心找不到「计划模式」开关');
    if (out.switchOff && out.switchOff.initial !== true) problems.push('「计划模式」开关初始不是开启');
    if (!out.prefOff || out.prefOff.rangeMode !== false) problems.push('关闭开关后没有写入 rangeMode=false');
    if (!out.single || out.single.single !== '1') problems.push('关闭计划模式后控件没降级为单日期');
    if (out.singlePanel && out.singlePanel.weekend) problems.push('单日期面板仍出现「本周末」');
    if (!out.prefOn || out.prefOn.rangeMode !== true) problems.push('重新开启后没有写回 rangeMode=true');
    if (!out.restored || out.restored.single !== '0') problems.push('重新开启后控件没回到计划模式');

    main.close();
    if (problems.length) fail(problems.join('；'), out);
    console.log('[PLAN-DATE] PLAN_DATE_OK');
    killChild();
    process.exit(0);
  } catch (e) {
    console.log('[PLAN-DATE] 检测失败：', (e && e.message) || e);
    if (childLog) console.log('[PLAN-DATE] 窗口日志：', childLog.split('\n').slice(-8).join(' | '));
    killChild();
    process.exit(1);
  }
})();

process.on('exit', killChild);
