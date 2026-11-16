'use strict';
/**
 * 桌面浮窗「父子任务展示 + 行内工时/禅 + 禅联动主窗口全屏」端对端验收。
 *
 * 覆盖两条需求（真实 Electron 窗口 + CDP，沿用 verify:* 既有写法）：
 *  A. 父子展示：子任务行挂「↳ 父任务名」并缩进，父任务行挂「☑ 完成数/总数」；
 *  B. 工时按钮：随插件开关显隐；▶ 开始/暂停/继续、■ 结束都在浮窗内完成；
 *  C. 禅联动：浮窗点 ☯ 以 source:'zen' 起计时，主窗口弹出全屏禅层 #wl-zen.is-open。
 *
 * 关键点：浮窗与主窗口共用 preload，但计时权威只有主进程一份；本脚本同时连两个
 * 渲染进程，验证「浮窗发起 → 主进程广播 → 主窗口亮禅层」这条跨窗口链路。
 *
 * 用法：node scripts/verify-dock-subtask-worklog.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9537';
const profile = path.join(os.tmpdir(), `knodo-dock-wl-${Date.now()}`);
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

async function listPages() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) {
        return list.filter((t) => t.type === 'page');
      }
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
  const checks = [];
  const ck = (name, ok, extra) => checks.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
  const fail = (msg, extra) => {
    console.log(`[DOCK-WL] FAIL：${msg}`);
    if (extra) console.log(`[DOCK-WL] ${JSON.stringify(extra)}`);
    if (childLog) console.log('[DOCK-WL] 窗口日志：', childLog.split('\n').slice(-10).join(' | '));
    killChild();
    process.exit(1);
  };

  try {
    await listPages();
    const pages = await listPages();
    const mainPage = pages.find((t) => /index\.html/.test(t.url));
    if (!mainPage) fail('没找到主窗口页面');
    const main = await connect(mainPage.webSocketDebuggerUrl);
    await sleep(1200);

    // 造数：父 + 2 子，钉「未完成」浮窗（该投影显示所有 active 任务）
    const setup = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const info = await window.api.env.getStorageInfo();
      if (!/knodo-dock-wl-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
      for (let i = 0; i < 80 && !window.__appReady; i += 1) await wait(100);
      const parent = await window.api.tasks.create({ title: '浮窗父子验收-父' });
      const kid1 = await window.api.tasks.create({ title: '浮窗父子验收-子1', parentId: parent.id });
      const kid2 = await window.api.tasks.create({ title: '浮窗父子验收-子2', parentId: parent.id });
      const parent2 = await window.api.tasks.create({ title: '浮窗父子验收-父2' });
      await window.api.desktop.pin('unfinished', null, {});
      await wait(1400);
      return { parentId: parent.id, kid1: kid1.id, kid2: kid2.id, parent2: parent2.id };
    })()`);
    if (!setup || !setup.parentId) fail('造数失败', setup);

    const pages2 = await listPages();
    const dockPage = pages2.find((t) => /desktop\.html/.test(t.url));
    if (!dockPage) fail('浮窗页面没创建（desktop:pin 失败）');
    const dock = await connect(dockPage.webSocketDebuggerUrl);
    await sleep(1400);

    /* ---- A. 父子树展示（此时插件仍关闭，正好一起验关闭态无按钮） ---- */
    const a0 = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      await wait(600);
      const pr = document.querySelector('.dw-row[data-id="${setup.parentId}"]');
      return {
        parentRow: !!pr,
        hasExpand: !!pr && !!pr.querySelector('[data-act="toggle-expand"]'),
        collapsedLabel: pr && pr.querySelector('[data-act="toggle-expand"]')
          ? pr.querySelector('[data-act="toggle-expand"]').textContent.trim() : '',
        kidHidden: !document.querySelector('.dw-row[data-id="${setup.kid1}"]'),
        parentCount: pr ? ((pr.querySelector('.dw-rel-count') || {}).textContent || '').trim() : '',
        arrowBox: (() => {
          const a = pr && pr.querySelector('[data-act="toggle-expand"]');
          if (!a) return null;
          const r = a.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), fs: getComputedStyle(a).fontSize };
        })(),
      };
    })()`);
    ck('父任务行存在', a0.parentRow);
    ck('父任务有展开箭头且默认收起', a0.hasExpand && a0.collapsedLabel === '▸', a0.collapsedLabel);
    ck('展开箭头热区加大到 ≥20×22 / 字号 ≥14px',
      a0.arrowBox && a0.arrowBox.w >= 20 && a0.arrowBox.h >= 22 && parseInt(a0.arrowBox.fs, 10) >= 14,
      JSON.stringify(a0.arrowBox));
    ck('默认收起时子任务不显示', a0.kidHidden);
    ck('父任务标注子任务进度 0/2', a0.parentCount.indexOf('0/2') >= 0, a0.parentCount);

    // 点父行箭头 → 展开子树，子任务紧跟父行、缩进、带父名标签
    const a = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const arrow = document.querySelector('.dw-row[data-id="${setup.parentId}"] [data-act="toggle-expand"]');
      if (!arrow) return { err: '无展开箭头' };
      arrow.click();
      await wait(400);
      const pr = document.querySelector('.dw-row[data-id="${setup.parentId}"]');
      const kr = document.querySelector('.dw-row[data-id="${setup.kid1}"]');
      const rows = [...document.querySelectorAll('.dw-row[data-id]')].map(e => e.dataset.id);
      const expandedLabel = pr.querySelector('[data-act="toggle-expand"]').textContent.trim();
      return {
        kidRow: !!kr,
        expandedLabel,
        adjacent: rows.indexOf('${setup.parentId}') >= 0
          && rows.indexOf('${setup.kid1}') === rows.indexOf('${setup.parentId}') + 1,
        kidParent: kr ? ((kr.querySelector('.dw-rel-parent') || {}).textContent || '').trim() : '',
        kidIndented: kr ? kr.classList.contains('is-child') && kr.dataset.depth === '1' : false,
        kidLead: kr ? !!kr.querySelector('.dw-expand.is-leaf') : false,
        kidTitleW: kr ? kr.querySelector('.dw-text').clientWidth : 0,
        closedNoRun: !document.querySelector('.dw-wl-run'),
      };
    })()`);
    ck('点箭头后箭头变 ▾', a.expandedLabel === '▾', a.expandedLabel);
    ck('展开后子任务行出现', a.kidRow);
    ck('子任务紧跟父任务行', a.adjacent);
    ck('父可见时子任务不塞父名（省标题宽度）', a.kidParent === '', a.kidParent);
    ck('子任务标题宽度充足（未被挤压）', a.kidTitleW >= 60, a.kidTitleW);
    ck('子任务按 depth=1 缩进', a.kidIndented);
    ck('子任务带 └ 引导线', a.kidLead);
    ck('关闭态：浮窗无工时按钮', a.closedNoRun);

    /* ---- A2. 点行主体不完成，点复选框才完成（先验证不完成，再取消） ---- */
    const a2 = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const row = document.querySelector('.dw-row[data-id="${setup.kid2}"]');
      if (!row) return { err: '无子任务2行' };
      // 点行主体（标题）：只选中，不完成
      row.querySelector('.dw-text').click();
      await wait(700);
      const stillThere = !!document.querySelector('.dw-row[data-id="${setup.kid2}"]:not(.is-done)');
      const selOk = !!document.querySelector('.dw-row[data-id="${setup.kid2}"].is-sel');
      return { stillThere, selOk };
    })()`);
    ck('点行主体不完成任务', a2.stillThere);
    ck('点行主体只选中作键盘锚点', a2.selOk);

    // 点复选框 → 真完成：浮窗行消失，主进程确认 completed；随后撤销，恢复现场
    const a3 = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const box = document.querySelector('.dw-row[data-id="${setup.kid2}"] [data-act="toggle"]');
      if (!box) return { err: '无复选框' };
      box.click();
      await wait(900);
      const gone = !document.querySelector('.dw-row[data-id="${setup.kid2}"]');
      const saved = await window.api.tasks.get(${setup.kid2});
      await window.api.tasks.toggle(${setup.kid2});
      await wait(500);
      return { gone, completed: saved && saved.completed };
    })()`);
    ck('点复选框才完成任务（浮窗行消失）', a3.gone);
    ck('点复选框主进程已落库完成', a3.completed === true);

    /* ---- B1. 开启插件 → 浮窗按钮动态出现 ---- */
    await main.evaluate('window.api.features.setPref({ enabled: true })');
    await sleep(1200);
    const b1 = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 30 && !document.querySelector('.dw-wl-run'); i += 1) await wait(150);
      return {
        run: !!document.querySelector('.dw-wl-run'),
        zen: !!document.querySelector('.dw-wl-zen'),
        stop: !!document.querySelector('.dw-wl-stop'),
        stopHidden: !document.querySelector('.dw-wl-stop:not(.is-off)'),
      };
    })()`);
    ck('开启后浮窗出现 ▶', b1.run);
    ck('开启后浮窗出现 ☯', b1.zen);
    ck('开启后浮窗出现 ■', b1.stop);
    ck('未计时时 ■ 收起', b1.stopHidden);

    /* ---- B2. 浮窗点 ▶ → 计时开始 + 行内时钟 + ■ 显示 ---- */
    const b2 = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = document.querySelector('.dw-row[data-id="${setup.parentId}"] [data-act="wl-run"]');
      if (!btn) return { err: '无 ▶ 按钮' };
      btn.click();
      await wait(1300);
      const st = await window.api.worklog.state();
      const row = document.querySelector('.dw-row[data-id="${setup.parentId}"]');
      return {
        mode: st && st.mode,
        taskId: st && st.taskId,
        timing: !!row && row.classList.contains('is-timing'),
        clock: !!row && !!row.querySelector('.dw-wl-time'),
        clockText: row && row.querySelector('.dw-wl-time') ? row.querySelector('.dw-wl-time').textContent : '',
        stopVisible: !!document.querySelector('.dw-row[data-id="${setup.parentId}"] [data-act="wl-stop"]:not(.is-off)'),
      };
    })()`);
    ck('浮窗 ▶ 启动计时', b2.mode === 'running' && Number(b2.taskId) === Number(setup.parentId), b2.mode + '/' + b2.taskId);
    ck('计时行加 is-timing', b2.timing);
    ck('▶ 变行内时钟', b2.clock, b2.clockText);
    ck('计时中 ■ 显示', b2.stopVisible);

    /* ---- B3. 浮窗点 ■ → 结束计时 ---- */
    const b3 = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = document.querySelector('.dw-row[data-id="${setup.parentId}"] [data-act="wl-stop"]');
      if (!btn) return { err: '无 ■ 按钮' };
      btn.click();
      await wait(900);
      const st = await window.api.worklog.state();
      const row = document.querySelector('.dw-row[data-id="${setup.parentId}"]');
      return { mode: st && st.mode, stillTiming: !!row && row.classList.contains('is-timing') };
    })()`);
    ck('浮窗 ■ 结束计时', b3.mode === 'idle', b3.mode);
    ck('结束后 is-timing 移除', !b3.stillTiming);

    /* ---- C. 浮窗点 ☯ → source:zen 计时 + 主窗口全屏禅层 ---- */
    const c = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = document.querySelector('.dw-row[data-id="${setup.parentId}"] [data-act="wl-zen"]');
      if (!btn) return { err: '无 ☯ 按钮' };
      btn.click();
      await wait(1300);
      const st = await window.api.worklog.state();
      return { mode: st && st.mode, source: st && st.source, taskId: st && st.taskId };
    })()`);
    ck('浮窗 ☯ 以 zen 来源起计时',
      c.mode === 'running' && c.source === 'zen' && Number(c.taskId) === Number(setup.parentId),
      [c.mode, c.source, c.taskId].join('/'));

    const zen = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 30 && !(document.getElementById('wl-zen') || {}).classList?.contains('is-open'); i += 1) await wait(150);
      const z = document.getElementById('wl-zen');
      return { mounted: !!z, open: !!z && z.classList.contains('is-open') };
    })()`);
    ck('主窗口已挂载禅层', zen.mounted);
    ck('浮窗 ☯ 联动主窗口全屏禅层', zen.open);

    // 收尾：停计时 + 关插件 → 浮窗按钮应随开关消失
    await main.evaluate('window.api.worklog.stop()');
    await sleep(500);
    await main.evaluate('window.api.features.setPref({ enabled: false })');
    await sleep(1000);
    const b4 = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 30 && document.querySelector('.dw-wl-run'); i += 1) await wait(150);
      return { noRun: !document.querySelector('.dw-wl-run'), noTiming: !document.querySelector('.dw-row.is-timing') };
    })()`);
    ck('关闭后浮窗按钮消失', b4.noRun);
    ck('关闭后计时态清空', b4.noTiming);

    /* ---- D. 父被过滤掉（完成）时，子任务作为 root 仍带「↳ 父任务名」 ---- */
    const d = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      // 走真实用户路径：点浮窗里父任务的复选框 → desktop:toggleTask 广播 desktop:invalidate → 浮窗自刷新
      const pbox = document.querySelector('.dw-row[data-id="${setup.parentId}"] [data-act="toggle"]');
      if (!pbox) return { err: '父行复选框不存在（可能已被收起）' };
      pbox.click();
      await wait(1200);
      const parentGone = !document.querySelector('.dw-row[data-id="${setup.parentId}"]');
      // kid1 之前在展开集合里、父没了它降级成 root（depth=0）
      const kr = document.querySelector('.dw-row[data-id="${setup.kid1}"]');
      return {
        parentGone,
        kidRoot: !!kr && !kr.classList.contains('is-child'),
        parentTag: kr ? ((kr.querySelector('.dw-rel-parent') || {}).textContent || '').trim() : '',
      };
    })()`);
    ck('父完成后浮窗移除父行', d.parentGone, d.err || '');
    ck('父被过滤后子任务降级为 root', d.kidRoot);
    ck('孤儿子任务仍标注父任务名', d.parentTag.indexOf('浮窗父子验收-父') >= 0, d.parentTag);

    /* ---- E. 拖拽改父级：子任务 → 另一个父 / 拖到空白变顶级 / 防环 ---- */
    // E3 的前置：先由**主窗口**建一条 parent2 的子任务。
    // 不能在浮窗里直接 api.tasks.create —— notifyChange 会跳过发起方窗口（避免自己刷新自己丢滚动位置），
    // 于是「浮窗自己建的」不会出现在浮窗列表里。真实路径是主窗口建 → 广播 → 浮窗重拉，
    // 这里走的正是这条；用浮窗自建会得到一个「行永远不出现」的假红。
    const gk = await main.evaluate(`(async () => await window.api.tasks.create({ title: '浮窗拖拽-防环子', parentId: ${setup.parent2} }))()`);
    const drag = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      // 工具：模拟一次 HTML5 拖拽。from/to 都是 .dw-row，to=null 表示落到列表空白
      const fire = (from, to) => {
        const dt = new DataTransfer();
        const text = from.querySelector('.dw-text');
        text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // 把手解锁 draggable
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const land = to || document.getElementById('dw-list');
        land.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        land.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      };
      const kid1Row = () => document.querySelector('.dw-row[data-id="${setup.kid1}"]');
      const p2Row = () => document.querySelector('.dw-row[data-id="${setup.parent2}"]');

      // E1: 把 kid1（此时是 root）拖到「父2」行 → 成为父2 的子任务
      if (!kid1Row() || !p2Row()) return { err: 'E1 缺行：kid1=' + !!kid1Row() + ' p2=' + !!p2Row() };
      fire(kid1Row(), p2Row());
      await wait(1200);
      const after1 = await window.api.tasks.get(${setup.kid1});

      // E2: 展开父2，把 kid1 拖到列表空白 → 提升为顶级
      const arrow = p2Row() && p2Row().querySelector('[data-act="toggle-expand"]');
      if (arrow) { arrow.click(); await wait(400); }
      const kidRow2 = document.querySelector('.dw-row[data-id="${setup.kid1}"]');
      if (!kidRow2) return { err: 'E2 缺 kid1 行', after1: after1 && after1.parent_id };
      fire(kidRow2, null);
      await wait(1200);
      const after2 = await window.api.tasks.get(${setup.kid1});

      // E3: 防环 —— 把「父2」拖到它自己的后代下（后代 gk 由主窗口建好，已在上面等广播刷新过）
      let p2r = null;
      let gkRow2 = null;
      for (let i = 0; i < 12; i += 1) {
        await wait(250);
        p2r = document.querySelector('.dw-row[data-id="${setup.parent2}"]');
        gkRow2 = document.querySelector('.dw-row[data-id="${gk.id}"]');
        if (gkRow2) break;
        const arrow = p2r && p2r.querySelector('[data-act="toggle-expand"]');
        if (arrow) arrow.click();
      }
      let forbiddenMark = false;
      if (p2r && gkRow2) {
        const dt = new DataTransfer();
        const text = p2r.querySelector('.dw-text');
        text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        p2r.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        gkRow2.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        forbiddenMark = gkRow2.classList.contains('drag-forbidden');
        gkRow2.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        p2r.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await wait(800);
      }
      const after3 = await window.api.tasks.get(${setup.parent2});
      return {
        after1Parent: after1 && after1.parent_id,
        after2Parent: after2 && after2.parent_id,
        hasRows: !!p2r && !!gkRow2,
        forbiddenMark,
        after3Parent: after3 && after3.parent_id,
      };
    })()`);
    ck('拖拽：子任务挂到另一个父任务下', Number(drag.after1Parent) === Number(setup.parent2), JSON.stringify(drag));
    ck('拖拽：拖到空白提升为顶级任务', drag.after2Parent == null, drag.after2Parent);
    ck('拖拽：拖到自己的后代显示禁止态', drag.hasRows === true && drag.forbiddenMark === true, JSON.stringify(drag));
    ck('拖拽：防环——父任务未被挂到后代下', drag.after3Parent == null, drag.after3Parent);

    await main.close();
    await dock.close();

    let failed = 0;
    for (const c2 of checks) {
      console.log(`  ${c2.ok ? '✓' : '✗'} ${c2.name}${c2.extra ? `  → ${c2.extra}` : ''}`);
      if (!c2.ok) failed += 1;
    }
    console.log(failed
      ? `\n[DOCK-WL] DOCK_SUBTASK_WORKLOG_FAIL ${failed}/${checks.length}`
      : `\n[DOCK-WL] DOCK_SUBTASK_WORKLOG_OK ${checks.length}/${checks.length}`);
    killChild();
    process.exit(failed ? 1 : 0);
  } catch (e) {
    fail('检测异常：' + ((e && e.message) || e));
  }
})();
