'use strict';
/**
 * 笔记标签端到端验证（右栏宿主）：
 *  - 编辑态输入标签后**不点别处**（只靠 900ms 自动保存）也必须落库；
 *  - 关掉详情、重新打开，标签仍在（以前会静默丢：自动保存写的是缓存的旧 id）；
 *  - 失焦（点标题）立即落库；
 *  - 切换笔记互不串味；
 *  - 「取消」能回滚到上次保存的标签；
 *  - 预览态（默认）标签框只读，必须点「编辑」才能改。
 *
 * 用法：node scripts/verify-note-tags.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9479';
const profile = path.join(os.tmpdir(), `knodo-note-tags-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [
  root,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
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
          const why = JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text);
          throw new Error(`页面异常：${why}\n  表达式：${String(expression).replace(/\s+/g, ' ').slice(0, 160)}`);
        }
        return r.result && r.result.value;
      }),
    click: async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    type: (text) => send('Input.insertText', { text }),
    close: () => ws.close(),
  };
}

const box = (page, sel) => page.evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);

/**
 * 按钮用 DOM click 驱动：页脚贴着窗口底边，坐标点击会被宫墙装饰条（80px）吃掉，
 * 那不是本用例要验的东西（按钮命中另有 verify:palace-rail 负责）。
 */
const clickEl = (page, sel) => page.evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  el.click();
  return true;
})()`);

/** 库里这篇笔记的标签名（按名称排序后返回） */
const dbTags = (page, id) => page.evaluate(`(async () => {
  const n = await window.api.notes.get(${id});
  return (n.tags || []).map((t) => t.name);
})()`);

async function openNote(page, id, { edit = false } = {}) {
  // 首次进视图会做一轮数据加载，列表可能晚几百毫秒才出来 —— 等不到就补点一次入口，
  // 仍然等不到就明确报错（以前直接 .click() 一个 null，堆栈里看不出是哪一步）。
  let found = false;
  for (let i = 0; i < 60; i += 1) {
    found = await page.evaluate(`!!document.querySelector('#nt-list .nt-item[data-id="${id}"]')`);
    if (found) break;
    if (i === 20) await page.evaluate(`document.querySelector('[data-view="notes"]') && document.querySelector('[data-view="notes"]').click()`);
    await sleep(250);
  }
  if (!found) throw new Error(`列表里等不到笔记 ${id}（笔记视图未就绪）`);
  await page.evaluate(`document.querySelector('#nt-list .nt-item[data-id="${id}"]').click()`);
  let pane = false;
  for (let i = 0; i < 40; i += 1) {
    pane = await page.evaluate(`!!document.querySelector('.nt-dp[data-id="${id}"] .nt-tag-input')`);
    if (pane) break;
    await sleep(250);
  }
  if (!pane) throw new Error(`笔记 ${id} 的详情面板没打开`);
  await sleep(400);
  if (edit) {
    await clickEl(page, '[data-nt-act="mode"]');
    await sleep(400);
  }
}

/** 聚焦标签框、光标放末尾、输入文本（真实 IME 通道） */
async function typeTags(page, text) {
  const ti = await box(page, '.nt-tag-input');
  await page.click(ti.x, ti.y);
  await sleep(80);
  await page.evaluate(`(() => {
    const el = document.querySelector('.nt-tag-input');
    el.setSelectionRange(el.value.length, el.value.length);
  })()`);
  await page.type(text);
  await sleep(150);
  return page.evaluate("document.querySelector('.nt-tag-input').value");
}

(async () => {
  const results = [];
  const ok = (name, pass, extra) => {
    results.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra).slice(0, 240) });
  };
  try {
    const list = await pages();
    const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    const page = await connect(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await sleep(1500);

    const ids = await page.evaluate(`(async () => {
      const a = await window.api.notes.create({ title: '标签验收甲', content_md: '甲正文' });
      const b = await window.api.notes.create({ title: '标签验收乙', content_md: '乙正文' });
      document.querySelector('[data-view="notes"]').click();
      return [a.id, b.id];
    })()`);
    const [idA, idB] = ids;

    // 1) 默认（预览）态：标签框只读，必须点「编辑」
    await openNote(page, idA);
    ok('预览态标签框只读（需先点编辑）', await page.evaluate("document.querySelector('.nt-tag-input').readOnly === true"));

    // 2) 编辑态只打字、不点别处 → 900ms 自动保存必须带上标签
    await clickEl(page, '[data-nt-act="mode"]');
    await sleep(400);
    ok('已进入编辑态（标签框可写）', await page.evaluate("document.querySelector('.nt-tag-input').readOnly === false"));
    await typeTags(page, '验收标签甲');
    await sleep(1800);
    const afterIdle = await dbTags(page, idA);
    ok('只打字不点别处也会落库', afterIdle.includes('验收标签甲'), JSON.stringify(afterIdle));
    ok('保存状态为已保存', /已保存/.test(await page.evaluate("(document.querySelector('.nt-dp-state') || {}).textContent || ''")));

    // 侧栏「标签」列表读的是缓存 tagList，以前只有切视图（重新挂载）才刷新 ——
    // 现敲的新标签打完了、库里也有了，左边却一直空着。这里必须**不切视图**就能看到。
    const sideRows = await page.evaluate(
      "Array.from(document.querySelectorAll('#nt-tags .nt-tag')).map((li) => [(li.querySelector('.nt-tag-name') || {}).textContent || '', Number((li.querySelector('.nt-tag-count') || {}).textContent) || 0])"
    );
    const side = (sideRows || []).map(([name, count]) => ({ name: (name || '').trim(), count }));
    const sideHit = side.find((t) => t.name === '验收标签甲');
    ok('侧栏标签列表立即出现新标签（不切视图）', !!sideHit, JSON.stringify(side));
    ok('侧栏标签挂载数为 1', !!sideHit && sideHit.count === 1, JSON.stringify(sideHit));


    // 3) 关闭详情再打开，标签还在
    await clickEl(page, '.nt-dp-close');
    await sleep(1200);
    await openNote(page, idA);
    ok('关闭后重开标签仍在', (await dbTags(page, idA)).includes('验收标签甲'));
    ok('重开后输入框回显', (await page.evaluate("document.querySelector('.nt-tag-input').value")).includes('验收标签甲'));

    // 4) 失焦后（防抖）落库：不点正文也不丢，只是走 900ms 防抖
    await clickEl(page, '[data-nt-act="mode"]');
    await sleep(400);
    ok('重开后直接编辑（标签框可写）', await page.evaluate("document.querySelector('.nt-tag-input').readOnly === false"));
    await typeTags(page, '，验收标签乙');
    const tb = await box(page, '.nt-dp-title');
    await page.click(tb.x, tb.y);
    await sleep(1600);
    const afterBlur = await dbTags(page, idA);
    ok('失焦后（防抖）落库', afterBlur.includes('验收标签乙'), JSON.stringify(afterBlur));

    // 5) 切到另一篇笔记：甲不丢、乙独立
    await openNote(page, idB);
    await sleep(800);
    ok('切走后甲标签不丢', (await dbTags(page, idA)).includes('验收标签乙'));
    ok('乙笔记没有被写入甲的标签', (await dbTags(page, idB)).length === 0);

    // 6) 取消能回滚标签
    await clickEl(page, '[data-nt-act="mode"]');
    await sleep(400);
    await typeTags(page, '乙临时标签');
    await sleep(1800);
    ok('乙标签已落库（回滚前）', (await dbTags(page, idB)).includes('乙临时标签'));
    // 再改一次标签但不保存，然后点「取消」
    const ti = await box(page, '.nt-tag-input');
    await page.click(ti.x, ti.y);
    await sleep(80);
    await page.evaluate(`(() => {
      const el = document.querySelector('.nt-tag-input');
      el.setSelectionRange(el.value.length, el.value.length);
    })()`);
    await page.type('，乙取消标签');
    await sleep(120);
    await clickEl(page, '[data-nt-act="dp-cancel"]');
    await sleep(1200);
    const afterCancel = await dbTags(page, idB);
    ok('取消回滚掉未保存的标签', !afterCancel.includes('乙取消标签') && afterCancel.includes('乙临时标签'), JSON.stringify(afterCancel));

    // 7) 列表行 chips 与库里一致
    const chips = await page.evaluate(`Array.from(document.querySelectorAll('#nt-list .nt-item[data-id="${idA}"] .nt-chip')).map((e) => e.textContent.trim())`);
    ok('列表行 chip 与库一致', chips.includes('验收标签甲') && chips.includes('验收标签乙'), JSON.stringify(chips));

    const failed = results.filter((r) => !r.pass);
    for (const r of results) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? `  ·  ${r.extra}` : ''}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
      if (log) console.log('\n--- 主进程日志尾部 ---\n' + log.slice(-1200));
      process.exitCode = 1;
    }
  } catch (e) {
    console.log('验收脚本异常：', e && e.message);
    console.log(log.slice(-2000));
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
