'use strict';
/**
 * 笔记全屏（右栏 / 弹窗两种宿主）的端到端验证：
 *  - 全屏面板顶边让出标题栏（自绘三键那 50px），不再压住窗口按钮；
 *  - 「退出全屏」与笔记自身的 × 在真实鼠标点击下可点（elementFromPoint 命中的是笔记按钮而非 .tb-win）；
 *  - 真点退出全屏能退回非全屏；Esc 也能退；三键区本身仍归 .tb-win 可点。
 * 用法：node scripts/verify-note-fs.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9476';
const profile = path.join(os.tmpdir(), `knodo-note-fs-${Date.now()}`);
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
    click: async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    shot: async (file) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    close: () => ws.close(),
  };
}

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

    // 造一篇笔记并在右栏打开
    await page.evaluate(`(async () => {
      await window.api.notes.create({ title: '全屏回归笔记', content_md: '# 标题\\n\\n正文段落' });
      const notes = await window.api.notes.list();
      const id = notes[0] && notes[0].id;
      document.querySelector('[data-view="notes"]').click();
      return id;
    })()`);
    await sleep(1000);
    await page.evaluate(`(() => {
      const b = document.querySelector('#nt-list [data-act="open"]') || document.querySelector('#nt-list li[data-id]');
      if (b) b.click();
      return true;
    })()`);
    await sleep(800);

    // 进入全屏
    await page.evaluate(`document.querySelector('.nt-dp [data-nt-act="fs-toggle"]').click()`);
    await sleep(500);

    const probe = `(() => {
      const pane = document.querySelector('.nt-dp.is-fs');
      if (!pane) return { noFsPane: true };
      const qr = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; };
      const hit = (el) => { const r = qr(el); const top = document.elementFromPoint(r.cx, r.cy); return { rect: r, topIsWin: !!(top && top.closest && top.closest('.tb-win')), topAct: top && top.closest && top.closest('[data-nt-act]') && top.closest('[data-nt-act]').dataset.ntAct, topCls: top && String(top.className).slice(0,50) }; };
      const win = document.querySelector('.tb-win');
      const fsBtn = pane.querySelector('[data-nt-act="fs-toggle"]');
      const closeBtn = pane.querySelector('[data-nt-act="dp-close"]');
      const tbh = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h').trim();
      return { paneTop: Math.round(pane.getBoundingClientRect().top), titlebarH: parseFloat(tbh) || 50, fsBtn: hit(fsBtn), closeBtn: hit(closeBtn), win: qr(win), innerH: innerHeight };
    })()`;
    const before = await page.evaluate(probe);
    ok('全屏面板铺满但顶边让出标题栏', before && !before.noFsPane && Math.abs(before.paneTop - before.titlebarH) <= 2, JSON.stringify(before));
    ok('退出全屏按钮不被三键遮挡', before && before.fsBtn && !before.fsBtn.topIsWin && before.fsBtn.topAct === 'fs-toggle', JSON.stringify(before && before.fsBtn));
    ok('笔记 × 关闭不被系统关窗键遮挡', before && before.closeBtn && !before.closeBtn.topIsWin && before.closeBtn.topAct === 'dp-close', JSON.stringify(before && before.closeBtn));
    await page.shot(path.join(shotDir, 'note-fs-1.png'));

    // 真点「退出全屏」（CDP 鼠标事件，走真实命中测试）
    await page.click(before.fsBtn.rect.cx, before.fsBtn.rect.cy);
    await sleep(400);
    const afterClick = await page.evaluate(`(() => ({ fs: !!document.querySelector('.nt-dp.is-fs'), bodyFs: document.body.classList.contains('nt-fs-open'), label: document.querySelector('.nt-dp [data-nt-act="fs-toggle"]') && document.querySelector('.nt-dp [data-nt-act="fs-toggle"]').textContent.trim() }))()`);
    ok('真点退出全屏 → 离开全屏', afterClick && !afterClick.fs && !afterClick.bodyFs, JSON.stringify(afterClick));

    // 再进全屏 → Esc 退出
    await page.evaluate(`document.querySelector('.nt-dp [data-nt-act="fs-toggle"]').click()`);
    await sleep(400);
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(400);
    const afterEsc = await page.evaluate(`({ fs: !!document.querySelector('.nt-dp.is-fs'), bodyFs: document.body.classList.contains('nt-fs-open') })`);
    ok('Esc 退出全屏', afterEsc && !afterEsc.fs && !afterEsc.bodyFs, JSON.stringify(afterEsc));

    // 三键区仍归 .tb-win（没有被笔记面板抢走）
    const winHit = await page.evaluate(`(() => {
      const win = document.querySelector('.tb-win');
      const r = win.getBoundingClientRect();
      const x = Math.round(r.left + r.width - 20), y = Math.round(r.top + r.height / 2);
      const top = document.elementFromPoint(x, y);
      return { topIsWin: !!(top && top.closest && top.closest('.tb-win')), cls: top && String(top.className).slice(0,50) };
    })()`);
    ok('系统三键区仍可命中（未被笔记面板盖住）', winHit && winHit.topIsWin, JSON.stringify(winHit));

    // ---- 弹窗宿主：动态 import notes.js 调 openNoteModal（与详情抽屉引用笔记同一条路径）----
    // 先退出右栏面板，免得 openNoteModal 内部为它做静默收尾
    await page.evaluate(`document.querySelector('.nt-dp [data-nt-act="dp-close"]')?.click()`);
    await sleep(300);
    await page.evaluate(`(async () => {
      const mod = await import('./js/notes.js');
      const notes = await window.api.notes.list();
      const id = notes[0] && notes[0].id;
      // openNoteModal 返回的 Promise 在弹窗关闭时才 resolve —— 不能 await，否则脚本卡死
      mod.openNoteModal(id).catch(() => {});
      return true;
    })()`);
    await sleep(1200);
    const inModal = await page.evaluate(`(() => ({
      modal: !!document.querySelector('.modal-note-editor .nt-dp'),
      fs: !!document.querySelector('.modal-note-editor .nt-dp.is-fs')
    }))()`);
    ok('弹窗宿主打开笔记', inModal && inModal.modal, JSON.stringify(inModal));

    await page.evaluate(`document.querySelector('.modal-note-editor .nt-dp [data-nt-act="fs-toggle"]').click()`);
    await sleep(500);
    const modalProbe = await page.evaluate(`(() => {
      const pane = document.querySelector('.modal-note-editor .nt-dp.is-fs');
      if (!pane) return { noFs: true };
      const fsBtn = pane.querySelector('[data-nt-act="fs-toggle"]');
      const r = fsBtn.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
      return {
        paneTop: Math.round(pane.getBoundingClientRect().top),
        fsTopIsWin: !!(top && top.closest && top.closest('.tb-win')),
        fsTopAct: top && top.closest && top.closest('[data-nt-act]') && top.closest('[data-nt-act]').dataset.ntAct,
      };
    })()`);
    // 弹窗宿主的 fixed 包含块是弹窗本身（其顶边已在标题栏下），所以 paneTop 会 > 50；
    // 关键判据是「不低于标题栏下沿」，而不是恰好等于 50。
    ok('弹窗宿主全屏不压标题栏', modalProbe && !modalProbe.noFs && modalProbe.paneTop >= before.titlebarH - 2, JSON.stringify(modalProbe));
    ok('弹窗宿主退出全屏按钮不被三键遮挡', modalProbe && !modalProbe.fsTopIsWin && modalProbe.fsTopAct === 'fs-toggle', JSON.stringify(modalProbe));
    await page.shot(path.join(shotDir, 'note-fs-2-modal.png'));

    // 弹窗内真点退出全屏
    const modalBtnPos = await page.evaluate(`(() => {
      const r = document.querySelector('.modal-note-editor .nt-dp.is-fs [data-nt-act="fs-toggle"]').getBoundingClientRect();
      return { cx: Math.round(r.left+r.width/2), cy: Math.round(r.top+r.height/2) };
    })()`);
    await page.click(modalBtnPos.cx, modalBtnPos.cy);
    await sleep(400);
    ok('弹窗宿主真点退出全屏生效', !(await page.evaluate(`!!document.querySelector('.modal-note-editor .nt-dp.is-fs')`)));

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
