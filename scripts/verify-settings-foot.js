'use strict';
/**
 * 设置中心底部页脚栏的端到端验证：
 *  - 页脚可见、带 border-top，与顶部头栏同高 / 同左右内边距（上下对称）；
 *  - 页脚左侧提示文字、右侧「关闭」按钮都在；
 *  - 点「关闭」能关窗且带确认回落（ok=true），再次打开仍有页脚（onMount 不重复插提示）。
 * 用法：node scripts/verify-settings-foot.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9478';
const profile = path.join(os.tmpdir(), `knodo-settings-foot-${Date.now()}`);
const shotDir = path.join(root, '.tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
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

const FOOT = `(() => {
  const q = (s) => document.querySelector(s);
  const modal = q('.modal-settings');
  if (!modal) return { noModal: true };
  const head = modal.querySelector('.modal-head');
  const foot = modal.querySelector('.modal-foot');
  const cs = (el) => { const c = getComputedStyle(el); return { display: c.display, padding: c.padding, bt: c.borderTopWidth, bb: c.borderBottomWidth }; };
  const hr = head.getBoundingClientRect();
  const fr = foot.getBoundingClientRect();
  return {
    head: cs(head), foot: cs(foot),
    headH: Math.round(hr.height), footH: Math.round(fr.height),
    hint: (foot.querySelector('.st-foot-hint') || {}).textContent || '',
    hintCount: foot.querySelectorAll('.st-foot-hint').length,
    okBtn: (foot.querySelector('[data-modal="ok"]') || {}).textContent || '',
    bodyBottom: Math.round(modal.querySelector('.modal-body').getBoundingClientRect().bottom),
    footTop: Math.round(fr.top),
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

    await page.evaluate(`document.querySelector('.tb-set').click()`);
    await sleep(800);
    const f = await page.evaluate(FOOT);
    ok('设置弹窗已打开', f && !f.noModal, JSON.stringify(f));
    ok('底部页脚栏可见（不再 display:none）', f && f.foot && f.foot.display === 'flex', JSON.stringify(f && f.foot));
    ok('页脚带 border-top、头栏带 border-bottom', f && parseFloat(f.foot.bt) >= 0.5 && parseFloat(f.head.bb) >= 0.5, JSON.stringify(f));
    ok('页脚与头栏等高、同左右内边距（上下对称）', f && f.headH === f.footH && f.head.padding === f.foot.padding, JSON.stringify({ headH: f && f.headH, footH: f && f.footH, headPad: f && f.head.padding, footPad: f && f.foot.padding }));
    ok('页脚左上角提示文字存在', f && /即时生效/.test(f.hint), JSON.stringify(f && f.hint));
    ok('页脚右下「关闭」按钮存在', f && /关闭/.test(f.okBtn), JSON.stringify(f && f.okBtn));
    ok('页脚紧贴内容区下沿（无缝）', f && Math.abs(f.bodyBottom - f.footTop) <= 1, JSON.stringify({ bodyBottom: f && f.bodyBottom, footTop: f && f.footTop }));
    await page.shot(path.join(shotDir, 'settings-foot.png'));

    // 点「关闭」→ 关窗
    await page.evaluate(`document.querySelector('.modal-settings .modal-foot [data-modal="ok"]').click()`);
    await sleep(500);
    ok('页脚「关闭」能关窗', !(await page.evaluate(`!!document.querySelector('.modal-settings')`)));

    // 再开一次：提示文字不重复插入
    await page.evaluate(`document.querySelector('.tb-set').click()`);
    await sleep(700);
    const again = await page.evaluate(FOOT);
    ok('重开后页脚仍在且提示不重复', again && !again.noModal && again.hintCount === 1, JSON.stringify({ hintCount: again && again.hintCount }));

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
