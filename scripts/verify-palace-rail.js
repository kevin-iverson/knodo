'use strict';
/**
 * 故宫檐角脊兽（小神兽）的端到端验证：
 *  - 故宫风格下檐口默认显示（80px），非故宫风格收起；
 *  - 打开任务详情 → 檐口让位（display:none），关闭后**立即回来**；
 *    反复开合多次都要回来（守住「消失后不再复现」的回归）；
 *  - 打开弹窗 → 檐口让位，关闭后回来；
 *  - 从 AI 检索弹窗里打开详情（is-over-modal，遮罩 + 抽屉同时在）关闭后仍回来。
 * 用法：node scripts/verify-palace-rail.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9477';
const profile = path.join(os.tmpdir(), `knodo-palace-rail-${Date.now()}`);
const shotDir = path.join(root, '.tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [
  root,
  `--remote-debugging-port=${port}`,
  `--remote-allow-origins=*`,
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
          throw new Error('页面异常：' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
        }
        return r.result && r.result.value;
      }),
    shot: async (file) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    close: () => ws.close(),
  };
}

const RAIL = `(() => {
  const rail = document.getElementById('palace-rail');
  const drawer = document.getElementById('detail-drawer');
  return {
    style: document.documentElement.getAttribute('data-style'),
    display: getComputedStyle(rail).display,
    h: Math.round(rail.getBoundingClientRect().height),
    drawerHidden: drawer.hidden,
    maskEls: document.querySelectorAll('.detail-mask').length,
    modalMasks: document.querySelectorAll('.modal-mask').length,
  };
})()`;

(async () => {
  const results = [];
  const ok = (name, pass, extra) => {
    results.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra).slice(0, 220) });
  };
  try {
    const list = await pages();
    const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    const page = await connect(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await sleep(1500);

    // 默认故宫风格（出厂即 palace）
    const init = await page.evaluate(RAIL);
    ok('故宫风格默认显示小神兽檐口', init && init.style === 'palace' && init.display === 'block' && init.h >= 70, JSON.stringify(init));

    // 造一条任务供详情使用
    const taskId = await page.evaluate(`(async () => {
      await window.api.tasks.create({ title: '脊兽回归任务' });
      const ts = await window.api.tasks.list();
      return ts[0] && ts[0].id;
    })()`);
    ok('测试任务已创建', !!taskId, String(taskId));

    // 打开详情 → 檐口让位
    await page.evaluate(`(async () => { const m = await import('./js/detail.js'); m.openDetail(${taskId}); return true; })()`);
    await sleep(600);
    const opened = await page.evaluate(RAIL);
    ok('打开详情时檐口让位', opened && opened.display === 'none' && !opened.drawerHidden, JSON.stringify(opened));

    // 关闭详情 → 檐口必须回来（核心回归点：残留 .detail-mask 不该继续命中）
    await page.evaluate(`(async () => { const m = await import('./js/detail.js'); m.closeDetail(); return true; })()`);
    await sleep(500);
    const closed = await page.evaluate(RAIL);
    ok('关闭详情后檐口立即回来', closed && closed.display === 'block' && closed.h >= 70 && closed.drawerHidden, JSON.stringify(closed));
    ok('关闭后 .detail-mask 仍在 DOM（证明不靠删节点）', closed && closed.maskEls >= 1, JSON.stringify(closed));
    await page.shot(path.join(shotDir, 'palace-rail-1-after-detail.png'));

    // 反复开合 3 次，每次关闭后都要回来（守住「消失后不再复现」）
    let allBack = true;
    const cycle = [];
    for (let i = 0; i < 3; i += 1) {
      await page.evaluate(`(async () => { const m = await import('./js/detail.js'); m.openDetail(${taskId}); return true; })()`);
      await sleep(300);
      await page.evaluate(`(async () => { const m = await import('./js/detail.js'); m.closeDetail(); return true; })()`);
      await sleep(300);
      const r = await page.evaluate(RAIL);
      cycle.push(r);
      if (!(r.display === 'block' && r.h >= 70)) allBack = false;
    }
    ok('反复开合详情后檐口始终回来', allBack, JSON.stringify(cycle));

    // 弹窗打开 → 让位；关闭 → 回来（用 AI 检索弹窗，它必定生成 .modal-mask）
    await page.evaluate(`document.getElementById('btn-ai-search').click()`);
    await sleep(600);
    const modalOpen = await page.evaluate(RAIL);
    ok('打开弹窗时檐口让位', modalOpen.modalMasks >= 1 && modalOpen.display === 'none', JSON.stringify(modalOpen));
    await page.evaluate(`document.querySelector('.modal-mask .modal-search [data-modal="close"]').click()`);
    await sleep(500);
    const modalClosed = await page.evaluate(RAIL);
    ok('关闭弹窗后檐口回来', modalClosed.modalMasks === 0 && modalClosed.display === 'block' && modalClosed.h >= 70, JSON.stringify(modalClosed));

    // 切到非故宫风格 → 檐口收起；切回 → 恢复
    await page.evaluate(`(() => {
      const root = document.documentElement;
      root.setAttribute('data-style', 'mist');
      root.dispatchEvent(new CustomEvent('app:theme-changed', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const mist = await page.evaluate(RAIL);
    ok('非故宫风格檐口收起', mist.display === 'none', JSON.stringify(mist));
    await page.evaluate(`(() => {
      const root = document.documentElement;
      root.setAttribute('data-style', 'palace');
      root.dispatchEvent(new CustomEvent('app:theme-changed', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const back = await page.evaluate(RAIL);
    ok('切回故宫风格檐口恢复', back.display === 'block' && back.h >= 70, JSON.stringify(back));

    page.close();
  } catch (e) {
    ok('脚本执行', false, (e && e.message) || String(e));
  } finally {
    const pass = results.filter((r) => r.pass).length;
    results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? `  ·  ${r.extra}` : ''}`));
    console.log(`\n${pass}/${results.length} 通过`);
    if (process.env.SHOW_LOG) console.log(log.slice(-3000));
    cleanup();
    process.exit(pass === results.length ? 0 : 1);
  }
})();
