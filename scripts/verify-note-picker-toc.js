'use strict';
/**
 * 两项回归的端到端验收（真实 Electron 窗口 + CDP，独立临时 userData）：
 *  A. 笔记大纲在编辑态可展示（此前被 CSS 硬隐藏，按钮形同虚设）；
 *  B. 关联笔记弹窗按「目录」筛选（含层级、未分类、与搜索组合、已选项跨筛选保留）。
 *
 * 用法：node scripts/verify-note-picker-toc.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9481';
const profile = path.join(os.tmpdir(), `knodo-np-toc-${Date.now()}`);
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

function killChild() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* 已退出 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
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
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      events.push('EXCEPTION: ' + (d && d.text) + ' ' + JSON.stringify((d && d.exception && d.exception.description) || '').slice(0, 500));
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const a = msg.params;
      if (a && a.type === 'error') events.push('CONSOLE: ' + (a.args || []).map((x) => x.value || x.description || '').join(' ').slice(0, 400));
    }
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
    events,
    send,
    evaluate: (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    close: () => ws.close(),
  };
}

(async () => {
  const results = [];
  const ok = (name, pass, extra) => {
    results.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra).slice(0, 220) });
  };
  try {
    const wsUrl = await findPage();
    const page = await connect(wsUrl);
    await page.send('Page.enable');
    await sleep(1500);

    const info = await page.evaluate(`(async () => window.api.env.getStorageInfo())()`);
    const dir = info.result && info.result.value && info.result.value.dir;
    if (!/knodo-np-toc-/.test(String(dir || ''))) {
      throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info.result && info.result.value));
    }

    // ============ A. 大纲在编辑态可展示 ============
    const tocProbe = () => `(async () => {
      const NL = String.fromCharCode(10);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const md = ['# 一级', '段落', '## 二级'].join(NL + NL);
      const made = await window.api.notes.create({ title: '大纲回归', contentMd: md });
      document.querySelector('[data-view="notes"]').click();
      await sleep(700);
      const mod = await import('./js/notes.js');
      await mod.openNote(made.id);
      await sleep(700);
      const snap = () => {
        const pane = document.querySelector('.nt-dp');
        const toc = pane && pane.querySelector('#nt-toc');
        const heads = pane && pane.querySelector('#nt-preview') && [...pane.querySelector('#nt-preview').querySelectorAll('h1,h2,h3,h4')];
        if (!toc) return { noToc: true };
        const cs = getComputedStyle(toc);
        return { hidden: !!toc.hidden, display: cs.display, w: Math.round(toc.getBoundingClientRect().width), heads: heads.length, items: toc.querySelectorAll('.nt-toc-item').length };
      };
      const out = {};
      out.preview = snap();
      document.querySelector('.nt-dp [data-nt-act="mode"]').click(); // → edit
      await sleep(400);
      out.edit = snap();
      document.querySelector('.nt-dp [data-nt-act="toc-toggle"]').click(); // 关
      await sleep(200);
      out.editOff = snap();
      document.querySelector('.nt-dp [data-nt-act="toc-toggle"]').click(); // 开
      await sleep(200);
      out.editOn = snap();
      document.querySelector('.nt-dp [data-nt-act="dp-close"]')?.click();
      await sleep(200);
      return out;
    })()`;

    const tocRes = await page.evaluate(tocProbe());
    const toc = tocRes.result && tocRes.result.value;
    ok('大纲：预览态抓到标题并展示', toc && toc.preview && toc.preview.heads >= 2 && !toc.preview.hidden && toc.preview.display === 'block' && toc.preview.w > 0, JSON.stringify(toc && toc.preview));
    ok('大纲：编辑态仍展示（回归点）', toc && toc.edit && toc.edit.heads >= 2 && !toc.edit.hidden && toc.edit.display !== 'none' && toc.edit.w > 0, JSON.stringify(toc && toc.edit));
    ok('大纲：编辑态按钮可关可开', toc && toc.editOff && toc.editOff.hidden && toc.editOn && !toc.editOn.hidden && toc.editOn.items >= 2, JSON.stringify({ off: toc && toc.editOff, on: toc && toc.editOn }));

    // ============ B. 关联笔记按目录筛选 ============
    const pickerProbe = () => `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const NL = String.fromCharCode(10);
      // 造数据：两个目录各一篇 + 未分类一篇 + 一篇无归属
      const fA = await window.api.noteFolders.create({ name: '验收目录A' });
      const fB = await window.api.noteFolders.create({ name: '验收目录B' });
      const child = await window.api.noteFolders.create({ name: '验收子目录', parentId: fA.id });
      const noteA = await window.api.notes.create({ title: '甲-专属词', contentMd: 'A' + NL + '正文' });
      const noteB = await window.api.notes.create({ title: '乙-专属词', contentMd: 'B' + NL + '正文' });
      const noteChild = await window.api.notes.create({ title: '丙-子目录', contentMd: 'C' });
      const noteNone = await window.api.notes.create({ title: '丁-未分类', contentMd: 'D' });
      await window.api.notes.update(noteA.id, { folder_id: fA.id });
      await window.api.notes.update(noteB.id, { folder_id: fB.id });
      await window.api.notes.update(noteChild.id, { folder_id: child.id });
      // 一台任务用于绑定关联笔记
      const task = await window.api.tasks.create({ title: '关联笔记筛选验收' });

      const mod = await import('./js/note-picker.js');
      // openNotePicker 的 Promise 在弹窗关闭时才 resolve，不能 await 住；用 onSubmit 前读 DOM。
      const pending = mod.openNotePicker({ taskId: task.id });
      await sleep(1200);

      const q = (s) => document.querySelector(s);
      const sel = q('.modal-note-picker [data-np="folder"]');
      const list = q('.modal-note-picker [data-np="list"]');
      const titles = () => [...list.querySelectorAll('.np-pick-title')].map((x) => x.textContent.trim());
      const out = {};
      out.hasSelect = !!sel;
      out.options = sel ? [...sel.options].map((o) => o.textContent.trim()) : [];
      out.allTitles = titles();

      // 选目录 A（应含子目录：甲 + 丙，不含乙）
      if (sel) { sel.value = String(fA.id); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      await sleep(500);
      out.folderA = titles();

      // 目录 A + 搜索「专属词」（甲命中，丙不命中）
      const qi = q('.modal-note-picker [data-np="q"]');
      if (qi) { qi.value = '专属词'; qi.dispatchEvent(new Event('input', { bubbles: true })); }
      await sleep(600);
      out.folderAQuery = titles();

      // 已勾选「甲」后切到目录 B，勾选应保留
      if (qi) { qi.value = ''; qi.dispatchEvent(new Event('input', { bubbles: true })); }
      await sleep(500);
      const checkA = list.querySelector('.np-picker-item[data-np-id="' + noteA.id + '"] [data-np-act="toggle"]');
      if (checkA) checkA.click();
      if (sel) { sel.value = String(fB.id); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      await sleep(500);
      out.countText = q('.modal-note-picker [data-np="count"]').textContent.trim();
      out.folderB = titles();
      // 切回 A 看勾选态是否还在
      if (sel) { sel.value = String(fA.id); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      await sleep(500);
      out.pickedPersisted = !!(list.querySelector('.np-picker-item[data-np-id="' + noteA.id + '"]') || {}).classList?.contains?.('checked');

      // 未分类筛选
      if (sel) { sel.value = '0'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      await sleep(500);
      out.unfiled = titles();

      // 关掉弹窗（点取消），避免悬挂
      const cancel = [...document.querySelectorAll('.modal-note-picker button')].find((b) => /取消/.test(b.textContent));
      if (cancel) cancel.click();
      await sleep(300);
      pending.catch(() => {});

      out.ids = { noteA: noteA.id, noteB: noteB.id, noteChild: noteChild.id, noteNone: noteNone.id, fA: fA.id, fB: fB.id };
      return out;
    })()`;

    const pickRes = await page.evaluate(pickerProbe());
    const p = pickRes.result && pickRes.result.value;
    const ex = p && p.exceptionDetails ? JSON.stringify(p.exceptionDetails).slice(0, 500) : '';
    ok('关联笔记：目录下拉已加载（全部/未分类/层级目录）', p && p.hasSelect && /全部目录/.test(p.options.join()) && /验收目录A/.test(p.options.join()) && /验收子目录/.test(p.options.join()), JSON.stringify(p && p.options) + ex);
    ok('关联笔记：选目录只显示该目录及子目录', p && p.folderA && p.folderA.some((t) => /甲/.test(t)) && p.folderA.some((t) => /丙/.test(t)) && !p.folderA.some((t) => /乙/.test(t)), JSON.stringify(p && p.folderA));
    ok('关联笔记：目录 + 搜索组合过滤', p && p.folderAQuery && p.folderAQuery.some((t) => /甲/.test(t)) && !p.folderAQuery.some((t) => /丙/.test(t)), JSON.stringify(p && p.folderAQuery));
    ok('关联笔记：已选项跨目录切换保留', p && p.pickedPersisted === true && /已选 1 篇/.test(p.countText || ''), JSON.stringify({ persisted: p && p.pickedPersisted, count: p && p.countText }));
    ok('关联笔记：未分类筛选可见未归档笔记', p && Array.isArray(p.unfiled), JSON.stringify(p && p.unfiled));

    const errs = page.events.filter((e) => /EXCEPTION|CONSOLE/.test(e));
    ok('无运行时异常', errs.length === 0, errs.slice(0, 3).join(' | '));
    page.close();
  } catch (e) {
    ok('脚本执行', false, (e && e.message) || String(e));
  } finally {
    const pass = results.filter((r) => r.pass).length;
    results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? `  ·  ${r.extra}` : ''}`));
    console.log(`\n${pass}/${results.length} 通过`);
    if (process.env.SHOW_LOG) console.log(childLog.slice(-3000));
    killChild();
    process.exit(pass === results.length ? 0 : 1);
  }
})();
