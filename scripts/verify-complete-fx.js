'use strict';
/**
 * 「任务完成反馈 + 效果期闸门」的回归验证。
 *
 * 规则（renderer/js/like-fx.js + ui.js#toggleTask）：
 *  1. 勾上 → 立刻播点赞效果，并先把「已完成」画在这一行（不先画会被误读成没勾上）；
 *  2. 效果完全结束前不许重绘/排序：行节点必须还是原来那个（同引用），重绘次数为 0；
 *  3. 效果期内重复点击同一行 = 被吞掉：不翻状态、不叠第二层粒子；
 *  4. 效果结束后只刷一次（连勾多个任务合并成一批），刷新后完成态与库里一致；
 *  5. 用户开了「减少动效」时不播粒子，但刷新照样在效果「立即结束」后发生。
 *
 * 用法：node scripts/verify-complete-fx.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9501';
const profile = path.join(os.tmpdir(), `knodo-fx-${Date.now()}`);
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
    send,
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
    console.log(`[COMPLETE-FX] FAIL：${msg}`);
    if (extra) console.log(`[COMPLETE-FX] ${JSON.stringify(extra)}`);
    killChild();
    process.exit(1);
  };

  try {
    await listPages();
    const pages = await listPages();
    const mainPage = pages.find((t) => /index\.html/.test(t.url));
    if (!mainPage) throw new Error('没找到主窗口页面');
    const main = await connect(mainPage.webSocketDebuggerUrl);
    // 前两组用例断言「粒子真的在飞」，所以必须显式声明「不减少动效」——
    // 否则这台机器若在系统里关了动画（Windows「显示动画」关掉 → prefers-reduced-motion: reduce），
    // playLikeFx 会按设计直接跳到结束，整组用例全红，看上去像功能没实现。
    // 减少动效这条路径由第 3 组自己 setEmulatedMedia 单独覆盖。
    await main.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    await sleep(1200);

    const setup = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const info = await window.api.env.getStorageInfo();
      if (!/knodo-fx-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const ids = {};
      for (const [key, title] of [['A', '完成反馈用例A'], ['B', '完成反馈用例B'], ['C', '完成反馈用例C'], ['D', '完成反馈用例D'], ['E', '完成反馈用例E'], ['F', '完成反馈用例F']]) {
        const t = await window.api.tasks.create({ title, planStart: day, planEnd: day });
        ids[key] = t.id;
      }
      document.querySelector('.nav-item[data-view="today"]').click();
      await wait(1000);
      return {
        ids,
        rows: [...document.querySelectorAll('#view .task-item')].length,
        hasAll: ['A', 'B', 'C', 'D', 'E', 'F'].every((k) => !!document.querySelector('#view .task-item[data-id="' + ids[k] + '"]')),
      };
    })()`);
    if (!setup || !setup.ids) fail('造数失败', setup);
    if (!setup.hasAll) fail('四条用例没都出现在「今天」列表里', setup);

    /* ---------- 1. 主体：效果期不刷、连点被吞、结束后只刷一次 ---------- */
    const main1 = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const view = document.getElementById('view');
      const A = ${setup.ids.A};
      const row = () => view.querySelector('.task-item[data-id="' + A + '"]');
      let renders = 0, last = 0;
      const mo = new MutationObserver(() => {
        const now = performance.now();
        if (now - last > 60) { renders += 1; last = now; }
      });
      mo.observe(view, { childList: true });

      const rowA = row();
      if (!rowA) return { error: '列表里找不到用例 A 的行' };
      const box = rowA.querySelector('.task-check');
      if (!box) return { error: '任务行没有完成按钮' };
      box.click();
      await wait(140);

      const playing = {
        layers: document.querySelectorAll('.like-fx').length,
        rowDone: rowA.classList.contains('done'),
        rowFlash: rowA.classList.contains('is-like-fx'),
        checkText: (box.textContent || '').trim(),
        sameNode: row() === rowA,
        renders,
        db: (await window.api.tasks.get(A)).completed,
      };

      // 效果期内连点三下：全部应被吞掉（既不翻状态，也不叠粒子、不触发重绘）
      box.click();
      await wait(150);
      box.click();
      await wait(120);
      box.click();
      await wait(200);

      const spammed = {
        layers: document.querySelectorAll('.like-fx').length,
        sameNode: row() === rowA,
        renders,
        db: (await window.api.tasks.get(A)).completed,
        rowDone: rowA.classList.contains('done'),
      };

      await wait(1500);
      const done = {
        layers: document.querySelectorAll('.like-fx').length,
        sameNode: row() === rowA,
        renders,
        db: (await window.api.tasks.get(A)).completed,
        rowDone: !!(row() || {classList:{contains:() => false}}).classList.contains('done'),
        flashLeft: rowA.classList.contains('is-like-fx'),
        popLeft: box.classList.contains('is-fx-pop'),
      };
      mo.disconnect();
      return { playing, spammed, done };
    })()`);
    if (!main1 || main1.error) fail(`勾选用例失败：${main1 && main1.error}`, main1);

    const problems = [];
    const p = main1.playing;
    const s = main1.spammed;
    const d = main1.done;
    console.log(`[COMPLETE-FX] 点击后140ms → ${JSON.stringify(p)}`);
    console.log(`[COMPLETE-FX] 连点三下后 → ${JSON.stringify(s)}`);
    console.log(`[COMPLETE-FX] 效果结束后 → ${JSON.stringify(d)}`);

    if (p.layers < 1) problems.push('点完没有出现点赞粒子层（效果根本没播）');
    if (!p.rowDone) problems.push('效果开始时行没有先画成已完成态（会看成“没勾上”）');
    if (!p.rowFlash) problems.push('效果开始时行上没有高亮类 is-like-fx');
    if (p.checkText !== '✓') problems.push('效果开始时勾选圈里没有对勾');
    if (!p.db) problems.push('点击后库里不是已完成');
    if (!p.sameNode) problems.push('效果播放期间行被重绘了（渲染抢跑了）');
    if (p.renders !== 0) problems.push(`效果播放期间发生了 ${p.renders} 次列表重绘`);
    if (s.layers > 1) problems.push(`连点叠出了 ${s.layers} 层粒子（重复触发没挡住）`);
    if (!s.sameNode) problems.push('连点过程中行被重绘（状态会闪）');
    if (s.renders !== 0) problems.push(`连点过程中发生了 ${s.renders} 次列表重绘`);
    if (!s.db) problems.push('连点把完成状态又翻回去了（数据错乱）');
    if (d.layers !== 0) problems.push('效果结束后粒子层没清理干净');
    if (d.sameNode) problems.push('效果结束后列表没有刷新（勾完一直不排序）');
    if (d.flashLeft || d.popLeft) problems.push('效果结束后行高亮/勾选动画类没摘除');
    if (!d.db) problems.push('刷新后库里不是已完成');
    if (d.renders !== 1) problems.push(`整段只该刷一次，实际 ${d.renders} 次`);

    /* ---------- 2. 连勾两条：效果并行，刷新合并成一次 ---------- */
    const main2 = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const view = document.getElementById('view');
      const B = ${setup.ids.B}, C = ${setup.ids.C};
      const rowOf = (id) => view.querySelector('.task-item[data-id="' + id + '"]');
      const rowB = rowOf(B), rowC = rowOf(C);
      if (!rowB || !rowC) return { error: '列表里找不到用例 B/C 的行' };
      let renders = 0, last = 0;
      const mo = new MutationObserver(() => {
        const now = performance.now();
        if (now - last > 60) { renders += 1; last = now; }
      });
      mo.observe(view, { childList: true });

      rowB.querySelector('.task-check').click();
      await wait(120);
      const midOne = { layers: document.querySelectorAll('.like-fx').length, renders };
      rowC.querySelector('.task-check').click();
      await wait(180);
      const both = {
        layers: document.querySelectorAll('.like-fx').length,
        flashB: rowB.classList.contains('is-like-fx'),
        flashC: rowC.classList.contains('is-like-fx'),
        renders,
        dbB: (await window.api.tasks.get(B)).completed,
        dbC: (await window.api.tasks.get(C)).completed,
      };
      await wait(2200);
      const after = {
        layers: document.querySelectorAll('.like-fx').length,
        renders,
        dbB: (await window.api.tasks.get(B)).completed,
        dbC: (await window.api.tasks.get(C)).completed,
        doneB: !!(rowOf(B) || {classList:{contains:()=>false}}).classList.contains('done'),
        doneC: !!(rowOf(C) || {classList:{contains:()=>false}}).classList.contains('done'),
      };
      mo.disconnect();
      return { midOne, both, after };
    })()`);
    if (!main2 || main2.error) fail(`连勾两条失败：${main2 && main2.error}`, main2);
    console.log(`[COMPLETE-FX] 连勾两条 → ${JSON.stringify(main2.both)} / 结束 ${JSON.stringify(main2.after)}`);
    if (main2.midOne.renders !== 0) problems.push('第一条还在播效果时就重绘了');
    if (main2.both.layers < 2) problems.push('两条任务的效果没有同时播（后一条被前一条的刷新打断了）');
    if (!main2.both.flashB || !main2.both.flashC) problems.push('连勾时某一行没有高亮，效果被掐了');
    if (main2.both.renders !== 0) problems.push('效果播放期间仍然发生了重绘');
    if (!main2.both.dbB || !main2.both.dbC) problems.push('连勾后库里状态不对');
    if (main2.after.layers !== 0) problems.push('连勾后粒子层残留');
    if (main2.after.renders !== 1) problems.push(`连勾两条应合并成 1 次刷新，实际 ${main2.after.renders} 次`);
    if (!main2.after.doneB || !main2.after.doneC) problems.push('连勾后列表里没显示为已完成');

    /* ---------- 3. 减少动效：不播粒子，但流程照走 ---------- */
    await main.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const main3 = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const view = document.getElementById('view');
      const D = ${setup.ids.D};
      const rowD = view.querySelector('.task-item[data-id="' + D + '"]');
      if (!rowD) return { error: '列表里找不到用例 D 的行' };
      rowD.querySelector('.task-check').click();
      await wait(160);
      const early = {
        layers: document.querySelectorAll('.like-fx').length,
        db: (await window.api.tasks.get(D)).completed,
      };
      await wait(900);
      const after = {
        layers: document.querySelectorAll('.like-fx').length,
        sameNode: view.querySelector('.task-item[data-id="' + D + '"]') === rowD,
        done: !!(view.querySelector('.task-item[data-id="' + D + '"]') || {classList:{contains:()=>false}}).classList.contains('done'),
        db: (await window.api.tasks.get(D)).completed,
      };
      return { early, after };
    })()`);
    // 复位成「不减少动效」而不是清空：清空会回落到这台机器的系统设置，
    // 若系统关着动画，第 4 组（详情抽屉里要看到粒子）又会全红。
    await main.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    }).catch(() => {});
    if (!main3 || main3.error) fail(`减少动效路径失败：${main3 && main3.error}`, main3);
    console.log(`[COMPLETE-FX] 减少动效 → ${JSON.stringify(main3)}`);
    if (main3.early.layers !== 0) problems.push('减少动效下仍然播了粒子');
    if (!main3.early.db) problems.push('减少动效下没有完成');
    if (main3.after.layers !== 0) problems.push('减少动效下残留粒子层');
    if (main3.after.sameNode) problems.push('减少动效下没有刷新（流程被卡住）');
    if (!main3.after.done) problems.push('减少动效下刷新后没显示已完成');

    /* ---------- 4. 详情抽屉：同一条链路（效果期间不重建抽屉） ---------- */
    const main4 = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const view = document.getElementById('view');
      const E = ${setup.ids.E};
      const rowE = view.querySelector('.task-item[data-id="' + E + '"]');
      if (!rowE) return { error: '列表里找不到用例 E 的行' };
      (rowE.querySelector('.task-body') || rowE).click();
      await wait(600);
      const drawer = document.querySelector('.detail-drawer');
      const head = drawer && drawer.querySelector('.detail-head');
      const btn = drawer && drawer.querySelector('[data-act="toggle"]');
      if (!btn) return { error: '详情抽屉没打开或没有完成按钮' };
      btn.click();
      await wait(140);
      const playing = {
        layers: document.querySelectorAll('.like-fx').length,
        sameBtn: drawer.querySelector('[data-act=\\"toggle\\"]') === btn,
        btnDone: btn.classList.contains('done'),
        checkText: (btn.textContent || '').trim(),
        db: (await window.api.tasks.get(E)).completed,
      };
      // 效果期内再点：应被吞掉，抽屉也不能重建
      btn.click();
      await wait(200);
      const spammed = {
        layers: document.querySelectorAll('.like-fx').length,
        sameBtn: drawer.querySelector('[data-act=\\"toggle\\"]') === btn,
        db: (await window.api.tasks.get(E)).completed,
      };
      await wait(1500);
      const afterBtn = document.querySelector('.detail-drawer [data-act="toggle"]');
      const after = {
        layers: document.querySelectorAll('.like-fx').length,
        rebuilt: !!afterBtn && afterBtn !== btn,
        drawerDone: !!afterBtn && afterBtn.classList.contains('done'),
        db: (await window.api.tasks.get(E)).completed,
      };
      return { playing, spammed, after };
    })()`);
    if (!main4 || main4.error) fail(`详情抽屉用例失败：${main4 && main4.error}`, main4);
    console.log(`[COMPLETE-FX] 详情抽屉 → ${JSON.stringify(main4)}`);
    if (main4.playing.layers < 1) problems.push('详情抽屉里勾完成没有播效果');
    if (!main4.playing.sameBtn) problems.push('效果播放期间详情抽屉被重建了（效果会被掐断）');
    if (!main4.playing.btnDone || main4.playing.checkText !== '✓') problems.push('详情抽屉按钮没先画成已完成');
    if (!main4.playing.db) problems.push('详情抽屉勾完后库里不是已完成');
    if (main4.spammed.layers > 1) problems.push('详情抽屉连点叠出了第二层粒子');
    if (!main4.spammed.sameBtn) problems.push('详情抽屉连点期间被重建（状态会闪）');
    if (!main4.spammed.db) problems.push('详情抽屉连点把状态翻回去了');
    if (main4.after.layers !== 0) problems.push('详情抽屉效果结束后粒子残留');
    if (!main4.after.rebuilt) problems.push('详情抽屉效果结束后没有重建（完成态不回显）');
    if (!main4.after.drawerDone) problems.push('详情抽屉重建后按钮不是已完成态');

    /* ---------- 5. 效果期间切视图：点了就得走，不能被闸门挡住 ---------- */
    const main5 = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const view = document.getElementById('view');
      // 关掉上一个用例留下的抽屉
      const closeBtn = document.querySelector('.detail-drawer [data-act="close"]');
      if (closeBtn) closeBtn.click();
      await wait(300);
      document.querySelector('.nav-item[data-view="today"]').click();
      await wait(700);
      const F = ${setup.ids.F};
      const rowF = view.querySelector('.task-item[data-id="' + F + '"]');
      if (!rowF) return { error: '列表里找不到用例 F 的行' };
      rowF.querySelector('.task-check').click();
      await wait(160);
      const playing = { layers: document.querySelectorAll('.like-fx').length };
      document.querySelector('.nav-item[data-view="all"]').click();
      await wait(320);
      const switched = {
        activeAll: document.querySelector('.nav-item[data-view="all"]').classList.contains('active'),
        activeToday: document.querySelector('.nav-item[data-view="today"]').classList.contains('active'),
        layers: document.querySelectorAll('.like-fx').length,
        rows: document.querySelectorAll('#view .task-item').length,
      };
      document.querySelector('.nav-item[data-view="today"]').click();
      await wait(1600);
      const after = {
        layers: document.querySelectorAll('.like-fx').length,
        activeToday: document.querySelector('.nav-item[data-view="today"]').classList.contains('active'),
        done: !!(view.querySelector('.task-item[data-id="' + F + '"]') || {classList:{contains:()=>false}}).classList.contains('done'),
        db: (await window.api.tasks.get(F)).completed,
      };
      return { playing, switched, after };
    })()`);
    if (!main5 || main5.error) fail(`效果期切视图失败：${main5 && main5.error}`, main5);
    console.log(`[COMPLETE-FX] 效果期切视图 → ${JSON.stringify(main5)}`);
    if (main5.playing.layers < 1) problems.push('切视图用例前置失败：效果没在播');
    if (!main5.switched.activeAll || main5.switched.activeToday) problems.push('效果播放期间点侧栏没有立刻切走（导航被闸门挡住了）');
    if (main5.switched.rows < 1) problems.push('切到「全部」后列表没渲染');
    if (main5.after.layers !== 0) problems.push('切视图后粒子层残留');
    if (!main5.after.activeToday) problems.push('切回「今天」失败');
    if (!main5.after.done || !main5.after.db) problems.push('切视图来回后完成态丢了');

    main.close();
    if (problems.length) fail(problems.join('；'), { main1, main2: main2.both, main3 });
    console.log('[COMPLETE-FX] COMPLETE_FX_OK');
    killChild();
    process.exit(0);
  } catch (e) {
    console.log('[COMPLETE-FX] 检测失败：', (e && e.message) || e);
    if (childLog) console.log('[COMPLETE-FX] 窗口日志：', childLog.split('\n').slice(-8).join(' | '));
    killChild();
    process.exit(1);
  }
})();

process.on('exit', killChild);
