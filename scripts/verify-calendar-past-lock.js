'use strict';
/**
 * 日历「历史日期完成态只读」端到端验证。
 * 用法：npm run verify:calendar
 *
 * 为什么必须真跑 Electron：锁的实现分散在三处 ——
 *   ① 服务端渲染 HTML 时给勾选框打 is-locked / aria-disabled；
 *   ② 点击事件里的兜底守卫（挡键盘与旧 DOM）；
 *   ③ CSS 只负责「看起来是禁用的」。
 * 只测其中一层都会漏：比如 CSS 生效但点击仍然改库，用户照样能勾掉昨天的记录。
 *
 * 断言口径：
 *  - 过去的格子 / 过去的当日面板：勾选框带 is-locked，点下去**库里的完成态不变**；
 *  - 今天：勾选框不带 is-locked，点一下仍然能勾上、再点能取消 —— 锁不能顺手把正常流程也锁死。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9492';
const profile = path.join(os.tmpdir(), `knodo-cal-lock-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [
  root,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  '--disable-gpu',
], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

let log = '';
child.stdout.on('data', (b) => { log += b.toString(); });
child.stderr.on('data', (b) => { log += b.toString(); });

function cleanup() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}

async function pages() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) return list;
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('CDP 连接超时');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`WS 失败：${e && e.message}`));
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    evaluate: (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      .then((r) => {
        if (r.exceptionDetails) {
          const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
          throw new Error('页面异常：' + (d || r.exceptionDetails.text));
        }
        return r.result && r.result.value;
      }),
    close: () => ws.close(),
  };
}

(async () => {
  const results = [];
  const ok = (name, pass, extra) => {
    results.push({ name, pass: !!pass });
    console.log(`${pass ? '✓' : '✗'} ${name}${extra == null ? '' : `  ${String(extra).slice(0, 240)}`}`);
  };

  try {
    const list = await pages();
    const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    const page = await connect(target.webSocketDebuggerUrl);
    await sleep(1500);

    /* ---- 造数据：昨天已完成 / 昨天到今天跨天未完成 / 今天未完成 ---- */
    const seeded = await page.evaluate(`(async () => {
      const p2 = (n) => String(n).padStart(2, '0');
      const isoOf = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      const now = new Date();
      const today = isoOf(now);
      const prev = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const yest = isoOf(prev);
      const a0 = await window.api.tasks.create({
        title: '昨天就做完的事', priority: 1, planEnd: yest,
      });
      // completed 是独立列（不是由 completed_at 派生），必须走 toggle 才是真的已完成
      const a = await window.api.tasks.toggle(a0.id);
      const b = await window.api.tasks.create({
        title: '昨天到今天跨天的事', priority: 2, planStart: yest, planEnd: today,
      });
      const c = await window.api.tasks.create({
        title: '今天还没做的事', priority: 1, planEnd: today,
      });
      return { today, yest, a: a.id, b: b.id, c: c.id,
        aDone: !!a.completed, bDone: !!b.completed, cDone: !!c.completed };
    })()`);
    ok('造数据成功', seeded.a > 0 && seeded.c > 0, JSON.stringify(seeded));
    ok('昨天的任务处于已完成态', seeded.aDone === true, `a.completed=${seeded.aDone}`);

    /* ---- 切到日历（月视图）---- */
    await page.evaluate(`(() => {
      const nav = document.querySelector('.nav-item[data-view="calendar"]');
      if (nav) nav.click();
      return true;
    })()`);
    let painted = false;
    for (let i = 0; i < 30; i += 1) {
      painted = await page.evaluate(`!!document.querySelector('.cal-grid')`);
      if (painted) break;
      await sleep(200);
    }
    ok('日历视图已渲染（月网格）', painted);

    /* 过去日期可能落在上个月（今天就是 1 号时）：翻页直到能查到那一格 */
    const ensureCell = async (day) => {
      for (let i = 0; i < 3; i += 1) {
        const hit = await page.evaluate(`!!document.querySelector('.cal-cell[data-date="${day}"]')`);
        if (hit) return true;
        await page.evaluate(`(() => { const b = document.querySelector('.cal-arrow[data-cal-nav="prev"]'); if (b) b.click(); return true; })()`);
        await sleep(400);
      }
      return page.evaluate(`!!document.querySelector('.cal-cell[data-date="${day}"]')`);
    };
    const hasPastCell = await ensureCell(seeded.yest);
    ok(`过去的格子存在（${seeded.yest}）`, hasPastCell);

    /* ---- ① 过去的格子：勾选框被锁 ---- */
    const pastCheck = await page.evaluate(`(() => {
      const el = document.querySelector('.cal-cell[data-date="${seeded.yest}"] .cal-check[data-task-id="${seeded.a}"]');
      if (!el) return { found: false };
      return {
        found: true,
        locked: el.classList.contains('is-locked'),
        aria: el.getAttribute('aria-disabled'),
        title: el.title,
        checked: el.classList.contains('is-checked'),
        cursor: getComputedStyle(el).cursor,
      };
    })()`);
    ok('过去格子的勾选框已渲染', pastCheck.found, JSON.stringify(pastCheck));
    ok('带 is-locked + aria-disabled', pastCheck.locked && pastCheck.aria === 'true');
    ok('已完成的历史格子仍显示绿勾（历史事实保留）', pastCheck.checked === true);
    ok('悬停光标为禁用态', pastCheck.cursor === 'not-allowed', pastCheck.cursor);
    ok('提示文案说明只读', /历史日期只读/.test(pastCheck.title || ''), pastCheck.title);

    /* ---- ② 点它：库里的完成态不许变 ---- */
    const beforeA = await page.evaluate(`(async () => (await window.api.tasks.get(${seeded.a})).completed)()`);
    await page.evaluate(`(() => {
      const el = document.querySelector('.cal-cell[data-date="${seeded.yest}"] .cal-check[data-task-id="${seeded.a}"]');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const afterA = await page.evaluate(`(async () => (await window.api.tasks.get(${seeded.a})).completed)()`);
    ok('点历史格子的勾：完成态没有变化', beforeA === afterA && !!afterA, `${beforeA} → ${afterA}`);

    /* ---- ③ 右栏当日面板：选过去的日期同样锁 ---- */
    await page.evaluate(`(() => {
      const cell = document.querySelector('.cal-cell[data-date="${seeded.yest}"]');
      if (cell) { const num = cell.querySelector('.cal-daynum') || cell; num.click(); }
      return true;
    })()`);
    await sleep(400);
    const panelCheck = await page.evaluate(`(() => {
      const el = document.querySelector('.cal-right .cal-panel-row .cal-check[data-task-id="${seeded.a}"]');
      if (!el) return { found: false, rows: document.querySelectorAll('.cal-right .cal-panel-row').length };
      return { found: true, locked: el.classList.contains('is-locked'), day: document.querySelector('.cal-right .cal-panel-week') ? document.querySelector('.cal-right .cal-panel-week').textContent.trim() : '' };
    })()`);
    ok('右栏面板打开的是过去那天', panelCheck.found, JSON.stringify(panelCheck));
    ok('面板里的勾选框同样被锁', panelCheck.locked === true);
    await page.evaluate(`(() => {
      const el = document.querySelector('.cal-right .cal-panel-row .cal-check[data-task-id="${seeded.a}"]');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const afterPanel = await page.evaluate(`(async () => (await window.api.tasks.get(${seeded.a})).completed)()`);
    ok('点面板里的勾：完成态仍然没有变化', afterPanel === afterA, `${afterA} → ${afterPanel}`);

    /* ---- ④ 今天：锁不能误伤正常流程 ---- */
    const todayCell = await ensureCell(seeded.today) || (await page.evaluate(`(() => { const b = document.querySelector('.cal-arrow[data-cal-nav="next"]'); if (b) b.click(); return true; })()`), await sleep(400), await ensureCell(seeded.today));
    ok(`今天的格子可见（${seeded.today}）`, !!todayCell);
    const todayCheck = await page.evaluate(`(() => {
      const el = document.querySelector('.cal-cell[data-date="${seeded.today}"] .cal-check[data-task-id="${seeded.c}"]');
      if (!el) return { found: false };
      return { found: true, locked: el.classList.contains('is-locked'), title: el.title };
    })()`);
    ok('今天的勾选框没有被锁', todayCheck.found && todayCheck.locked === false, JSON.stringify(todayCheck));
    await page.evaluate(`(() => {
      const el = document.querySelector('.cal-cell[data-date="${seeded.today}"] .cal-check[data-task-id="${seeded.c}"]');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    await sleep(800);
    const cDone = await page.evaluate(`(async () => (await window.api.tasks.get(${seeded.c})).completed)()`);
    ok('今天点一下就能勾上（回归）', !!cDone, `c.completed=${cDone}`);

    /* ---- ⑤ 跨天任务：昨天的延续格子锁、今天的解锁 ---- */
    const spanChecks = await page.evaluate(`(() => {
      const q = (d) => document.querySelector('.cal-cell[data-date="' + d + '"] .cal-check[data-task-id="${seeded.b}"]');
      const y = q('${seeded.yest}');
      const t = q('${seeded.today}');
      return {
        yFound: !!y, tFound: !!t,
        yLocked: y ? y.classList.contains('is-locked') : null,
        tLocked: t ? t.classList.contains('is-locked') : null,
      };
    })()`);
    ok('跨天任务：昨天的格子锁、今天的格子不锁',
      spanChecks.yFound && spanChecks.tFound && spanChecks.yLocked === true && spanChecks.tLocked === false,
      JSON.stringify(spanChecks));

    /* ---- ⑥ 不回归：主进程没有异常 ---- */
    ok('运行期没有未捕获异常', !/Uncaught|TypeError:/.test(log), log.split('\n').filter((l) => /Error/.test(l))[0] || '');
  } catch (e) {
    ok(`脚本异常：${e && e.message}`, false);
  } finally {
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${failed ? '✗' : '✓'} ${results.length - failed}/${results.length} 通过`);
    cleanup();
    process.exit(failed ? 1 : 0);
  }
})();
