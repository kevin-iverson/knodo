'use strict';
/**
 * 标题栏「日 / 月 盘」（明暗滑块）端到端验证。
 * 用法：npm run verify:mode      # 加 --shots 会把截图落到系统临时目录并打印路径
 *
 * 为什么必须真跑 Electron：
 *   · 位置是相对窗口右边界的绝对定位（窗口三键 138 + 37），只能在真实视口里量
 *   · 两态视觉全靠 :root[data-theme] 驱动，要确认「首帧就对」而不是 JS 补
 *   · 点击 → IPC → 主进程落库 → 渲染层 data-theme 的回环，Node 里验不到任何一段
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9488';
const profile = path.join(os.tmpdir(), `knodo-mode-${Date.now()}`);
const shotsDir = path.join(os.tmpdir(), 'knodo-mode-shots');
const wantShots = process.argv.includes('--shots');
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

  const shot = async (page, name, selector) => {
    if (!wantShots) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    const size = await page.evaluate('({ w: innerWidth, h: innerHeight })');
    let clip = { x: 0, y: 0, width: size.w, height: 56, scale: 2 };
    if (selector) {
      // 局部特写：按元素 rect 裁，放大 4 倍 —— 用来逐像素看盘边、光晕、图标居中没有
      const r = await page.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: b.left - 8, y: b.top - 6, width: b.width + 16, height: b.height + 12 }; })()`);
      clip = { ...r, scale: 4 };
    }
    const r = await page.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    const file = path.join(shotsDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  ↳ ${file}`);
  };

  try {
    const list = await pages();
    const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    const page = await connect(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await sleep(1500);

    /* ---- 0) DOM / 初始态 ---- */
    const boot = await page.evaluate(`(() => {
      const b = document.getElementById('btn-theme-mode');
      if (!b) return { exists: false };
      const t = window.KnodoTheme;
      const cs = getComputedStyle(b);
      const orb = b.querySelector('.tbm-orb');
      return {
        exists: true,
        role: b.getAttribute('role'),
        checked: b.getAttribute('aria-checked'),
        mode: document.documentElement.getAttribute('data-theme'),
        themeMode: (window.api && null) || '',
        w: b.getBoundingClientRect().width,
        h: b.getBoundingClientRect().height,
        rightGap: Math.round(innerWidth - b.getBoundingClientRect().right),
        noDrag: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
        orbX: getComputedStyle(orb).transform,
        sunOpacity: getComputedStyle(b.querySelector('.tbm-sun')).opacity,
        moonOpacity: getComputedStyle(b.querySelector('.tbm-moon')).opacity,
      };
    })()`);
    ok('标题栏存在明暗滑块', boot.exists);
    ok('role=switch 且带 aria-checked', boot.role === 'switch' && boot.checked !== null, `${boot.role} / ${boot.checked}`);
    ok('尺寸 56×26', Math.round(boot.w) === 56 && Math.round(boot.h) === 26, `${boot.w}×${boot.h}`);
    ok('右边缘距窗口 165px（用户 11-13 二次标定，再贴三键 10px）', boot.rightGap === 165, boot.rightGap);
    ok('不吞拖拽（no-drag）', String(boot.noDrag).includes('no-drag'), boot.noDrag);
    ok('字形随 data-theme 首帧即正确', boot.mode === 'light'
      ? boot.sunOpacity === '1' && boot.moonOpacity === '0'
      : boot.sunOpacity === '0' && boot.moonOpacity === '1', `${boot.mode} sun=${boot.sunOpacity} moon=${boot.moonOpacity}`);
    await shot(page, '1-light');
    await shot(page, '1-light-zoom', '#btn-theme-mode');

    /* ---- 1) 几何：盘在一侧、空槽在另一侧 ---- */
    const geo = await page.evaluate(`(() => {
      const b = document.getElementById('btn-theme-mode');
      const box = b.getBoundingClientRect();
      const orb = b.querySelector('.tbm-orb').getBoundingClientRect();
      const after = getComputedStyle(b.querySelector('.tbm-track'), '::after');
      return {
        orbLeft: Math.round(orb.left - box.left),
        slotLeft: Math.round(parseFloat(after.left)),
        slotOpacity: after.opacity,
      };
    })()`);
    const isDarkNow = await page.evaluate("document.documentElement.getAttribute('data-theme') === 'dark'");
    ok('盘贴在对应一侧（浅左 / 深右）', isDarkNow ? geo.orbLeft > 25 : geo.orbLeft <= 4, geo.orbLeft);
    ok('空槽落在盘对面的空位上', isDarkNow ? geo.slotLeft < 20 : geo.slotLeft > 30, geo.slotLeft);
    ok('空槽悬停前不显示', geo.slotOpacity === '0', geo.slotOpacity);

    /* ---- 2) 点一下 → 落库 → data-theme 跟随 ---- */
    const clicked = await page.evaluate(`(async () => {
      const b = document.getElementById('btn-theme-mode');
      const before = document.documentElement.getAttribute('data-theme');
      b.click();
      await new Promise((r) => setTimeout(r, 700));
      const saved = await window.api.theme.get();
      return {
        before,
        after: document.documentElement.getAttribute('data-theme'),
        saved: saved.mode,
        checked: b.getAttribute('aria-checked'),
        title: b.title,
        orb: getComputedStyle(b.querySelector('.tbm-orb')).transform,
      };
    })()`);
    const flipped = clicked.before === 'light' ? 'dark' : 'light';
    ok('点击后 data-theme 翻转', clicked.after === flipped, `${clicked.before} → ${clicked.after}`);
    ok('mode 落库为显式 light / dark', clicked.saved === flipped, clicked.saved);
    ok('aria-checked 跟随实际明暗', clicked.checked === String(flipped === 'dark'), clicked.checked);
    ok('title 说明当前态与下一态', /主题/.test(clicked.title) && /切换到/.test(clicked.title), clicked.title);
    await sleep(400);
    await shot(page, flipped === 'dark' ? '2-dark' : '2-light');
    await shot(page, `${flipped}-zoom`, '#btn-theme-mode');
    // 悬停态：空位上的空槽只在 hover / focus 时露出来，这里用真实鼠标移动触发。
    // 必须先移到别处再移进来 —— 若上一步鼠标已经停在按钮上，同点位的 mouseMoved
    // 不会让 Chromium 重新算 :hover，断言会假失败。
    const box = await page.evaluate(`(() => { const b = document.getElementById('btn-theme-mode').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 12, y: 320, button: 'none', buttons: 0 });
    await sleep(120);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 });
    await sleep(320);
    const slot = await page.evaluate(
      "getComputedStyle(document.querySelector('#btn-theme-mode .tbm-track'), '::after').opacity",
    );
    ok('悬停时空槽浮出（提示另一格存在）', slot === '1', slot);
    await shot(page, `${flipped}-hover`, '#btn-theme-mode');

    /* ---- 3) 再点一下回原态（不残留第三个状态） ---- */
    const back = await page.evaluate(`(async () => {
      document.getElementById('btn-theme-mode').click();
      await new Promise((r) => setTimeout(r, 700));
      const saved = await window.api.theme.get();
      return { mode: saved.mode, attr: document.documentElement.getAttribute('data-theme') };
    })()`);
    ok('再点一次回到反态并落库', back.mode === clicked.before && back.attr === clicked.before, JSON.stringify(back));

    /* ---- 4) 键盘：← → 直接指定方向 ---- */
    const keys = await page.evaluate(`(async () => {
      const b = document.getElementById('btn-theme-mode');
      b.focus();
      const fire = (key) => b.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      fire('ArrowRight');
      await new Promise((r) => setTimeout(r, 600));
      const dark = (await window.api.theme.get()).mode;
      fire('ArrowLeft');
      await new Promise((r) => setTimeout(r, 600));
      const light = (await window.api.theme.get()).mode;
      return { dark, light };
    })()`);
    ok('按 → 固定为深色、按 ← 固定为浅色', keys.dark === 'dark' && keys.light === 'light', JSON.stringify(keys));

    /* ---- 5) 与设置中心「外观」分区双向同步 ---- */
    const syncPane = await page.evaluate(`(async () => {
      window.__openSettings('appearance');
      for (let i = 0; i < 60; i += 1) {
        if (document.querySelector('.ap-card')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const seg = () => document.querySelector('[data-seg="mode"] .is-on')?.dataset.mode || '';
      const before = seg();
      // 点标题栏滑块：面板分段必须跟着变
      document.getElementById('btn-theme-mode').click();
      await new Promise((r) => setTimeout(r, 700));
      const afterSwitch = seg();
      // 反向：在面板里点「深色」，滑块 aria-checked 跟着变
      document.querySelector('[data-seg="mode"] button[data-mode="dark"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const btn = document.getElementById('btn-theme-mode');
      return { before, afterSwitch, checked: btn.getAttribute('aria-checked'), theme: document.documentElement.getAttribute('data-theme') };
    })()`);
    ok('滑块改了模式，面板分段同步回显', syncPane.before !== syncPane.afterSwitch && syncPane.afterSwitch !== '', JSON.stringify(syncPane));
    ok('面板改了模式，滑块同步回显', syncPane.checked === 'true' && syncPane.theme === 'dark', `${syncPane.checked}/${syncPane.theme}`);

    /* ---- 6) 恢复默认：跟随系统 ---- */
    const reset = await page.evaluate(`(async () => {
      document.querySelector('[data-act="reset"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const saved = await window.api.theme.get();
      const cs = getComputedStyle(document.getElementById('btn-theme-mode')).webkitAppRegion;
      return { mode: saved.mode, style: saved.style, title: document.getElementById('btn-theme-mode').title, cs };
    })()`);
    ok('恢复默认后回到跟随系统', reset.mode === 'system' && reset.style === 'sepia', JSON.stringify(reset));
    ok('跟随系统时 title 标注「跟随系统」', /跟随系统/.test(reset.title), reset.title);

    /* ---- 7) 极端风格抽查（只出图，不断言）：高对比浅色 / 樱粉深色 ----
       这套开关全部走 token，12 组配色里只要这两个极端不塌，其余都在中间地带 */
    if (wantShots) {
      // 先把手/焦点移开，否则拍到的都是 hover + focus-visible 的复合态
      await page.evaluate('document.activeElement && document.activeElement.blur()');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
      await sleep(260);
      for (const [style, mode, name] of [
        ['contrast', 'light', 'style-contrast-light'],
        ['sakura', 'dark', 'style-sakura-dark'],
      ]) {
        await page.evaluate(`window.api.theme.set({ style: '${style}', mode: '${mode}' })`);
        await sleep(520);
        await shot(page, name, '#btn-theme-mode');
      }
      await page.evaluate("window.api.theme.set({ style: 'sepia', mode: 'system' })");
      await sleep(320);
    }

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) console.log('失败：' + failed.map((f) => f.name).join(' / '));
    cleanup();
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('验证异常：', e && e.message);
    console.error(log.slice(-1500));
    cleanup();
    process.exit(1);
  }
})();
