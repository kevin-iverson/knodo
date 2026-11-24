'use strict';
/**
 * 标题栏「有新版本」角标的端到端验证：
 *  - 角标常驻 DOM、默认隐藏，紧跟在版本号 #sb-ver 右侧；
 *  - 收到 { hasUpdate:true } 后显示，文案 / title 带版本号，no-drag 可点击；
 *  - 收到 { hasUpdate:false } 后重新隐藏（已是最新时不能一直亮着）；
 *  - 点击事件已绑定（CDP 读监听器，不真触发，避免弹出原生对话框阻塞脚本）；
 *  - app:getUpdateState IPC 返回结构化快照。
 * 用法：node scripts/verify-update-badge.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9483';
const profile = path.join(os.tmpdir(), `knodo-update-badge-${Date.now()}`);
const shotDir = path.join(root, '.tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

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
          throw new Error('页面异常：' + JSON.stringify((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
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

const BADGE = `(() => {
  const q = (s) => document.querySelector(s);
  const badge = q('#sb-update-badge');
  const ver = q('#sb-ver');
  if (!badge || !ver) return { missing: true, badge: !!badge, ver: !!ver };
    const cs = getComputedStyle(badge);
    const region = cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion || '';
  const barBg = getComputedStyle(q('.titlebar')).backgroundImage;
    const br = badge.getBoundingClientRect();
    const vr = ver.getBoundingClientRect();
    const gr = (q('.tb-set') || {}).getBoundingClientRect ? q('.tb-set').getBoundingClientRect() : null;
    return {
    gear: gr ? { left: Math.round(gr.left), right: Math.round(gr.right) } : null,
    badgeRect: { left: Math.round(br.left), right: Math.round(br.right) },
    overlapsGear: !!(gr && br.width > 0 && br.left < gr.right && gr.left < br.right),
    hidden: badge.hidden,
    display: cs.display,
    region,
    color: cs.color,
    borderColor: cs.borderTopColor,
    barBg: String(barBg).slice(0, 60),
    cursor: cs.cursor,
    text: badge.textContent.trim(),
    title: badge.title,
    nextToVer: badge.previousElementSibling === ver,
    rightOfVer: Math.round(br.left) >= Math.round(vr.right) - 1,
    inTitlebar: !!badge.closest('.titlebar'),
    width: Math.round(br.width),
  };
})()`;

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
    await page.send('Runtime.enable');
    await sleep(1800);

    // 初始：角标在 DOM 里、隐藏、紧贴版本号、在标题栏内
    const init = await page.evaluate(BADGE);
    ok('角标与版本号节点都在', init && !init.missing, JSON.stringify(init));
    ok('默认隐藏（无新版本不打扰）', init && init.hidden === true && init.display === 'none', JSON.stringify(init));
    // 隐藏时宽度为 0，没有可比的几何位置；这里只验 DOM 顺序（紧跟版本号）与所在容器
    ok('紧跟版本号且位于标题栏内', init && init.nextToVer && init.inTitlebar, JSON.stringify(init));

    // IPC 快照结构
    const snap = await page.evaluate(`window.api.app.getUpdateState()`);
    ok('app:getUpdateState 返回结构化快照', snap && typeof snap.hasUpdate === 'boolean' && typeof snap.tag === 'string', JSON.stringify(snap));

    // 推送「有新版本」→ 显示
    await page.evaluate(`window.__setUpdateBadgeForTest({ hasUpdate: true, tag: 'v9.9.9', latest: '9.9.9' })`);
    const on = await page.evaluate(BADGE);
    ok('有新版本时角标显示', on && on.hidden === false && on.display !== 'none', JSON.stringify(on));
    ok('显示时几何上落在版本号右侧', on && on.rightOfVer && on.width > 0, JSON.stringify({ badgeRect: on && on.badgeRect, verSide: on && on.rightOfVer }));
    ok('展开后不压住设置齿轮', on && on.overlapsGear === false, JSON.stringify({ badgeRect: on && on.badgeRect, gear: on && on.gear }));
    ok('角标文案带「有新版本」', on && /有新版本/.test(on.text), on && on.text);
    ok('title 带版本号（v9.9.9）', on && /v9\.9\.9/.test(on.title), on && on.title);
    ok('no-drag 且鼠标可点（不被拖窗吃掉）', on && on.region === 'no-drag' && on.cursor === 'pointer', JSON.stringify({ region: on && on.region, cursor: on && on.cursor }));
    // 红墙标题栏是深红渐变：角标文字必须是浅色米字，否则 --primary 酒红会糊在墙里看不见
    ok('红墙标题栏上角标文字为浅色（可见）', on && /rgb\(2[0-9]{2}/.test(on.color) && /rgba?\(2[0-9]{2}/.test(on.borderColor), JSON.stringify({ color: on && on.color, borderColor: on && on.borderColor, barBg: on && on.barBg }));
    await sleep(300);
    await page.shot(path.join(shotDir, 'update-badge-on.png'));

    // 点击监听器已绑定（不真触发，避免原生对话框阻塞 CDP）
    let clickBound = false;
    try {
      await page.evaluate(`window.__badgeNode = document.getElementById('sb-update-badge')`);
      const expr = await page.send('Runtime.evaluate', { expression: 'window.__badgeNode', returnByValue: false });
      const listeners = await page.send('DOMDebugger.getEventListeners', { objectId: expr.result.objectId });
      clickBound = (listeners.listeners || []).some((l) => l.type === 'click');
    } catch (e) {
      clickBound = false;
    }
    ok('点击事件已绑定（点击查看更新 / 下载）', clickBound, clickBound ? '' : '未读到 click 监听器');

    // 主题矩阵：九套风格 × 明暗都要看得见。浅风格标题栏是浅色 → 文字应偏深；
    // 深风格标题栏是深色 → 文字应偏浅。只比亮度方向，避免把具体色值写死进测试。
    const lum = (rgb) => {
      const m = String(rgb || '').match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (!m) return null;
      return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
    };
    const styles = ['mist', 'graphite', 'moss', 'matcha', 'sepia', 'sakura', 'lilac', 'palace', 'contrast'];
    const themes = [].concat(...styles.map((style) => [
      { style, mode: 'light' }, { style, mode: 'dark' },
    ]));
    const contrastFails = [];
    for (const t of themes) {
      const sample = await page.evaluate(`(() => {
        window.KnodoTheme.paint({ mode: '${t.mode}', style: '${t.style}', backdrop: 'none' });
        const badge = document.getElementById('sb-update-badge');
        const bar = document.querySelector('.titlebar');
        const cs = getComputedStyle(badge);
        return { text: cs.color, bg: getComputedStyle(bar).backgroundColor, img: getComputedStyle(bar).backgroundImage };
      })()`);
      const textL = lum(sample && sample.text);
      const bgL = lum(sample && (String(sample.img || '').includes('gradient') ? 'rgb(124, 38, 32)' : sample.bg));
      // 红墙渐变用近似底色；其余用标题栏实色。差 ≥ 60 视为可读。
      if (textL == null || bgL == null || Math.abs(textL - bgL) < 60) {
        contrastFails.push(`${t.style}/${t.mode}: ${JSON.stringify(sample)}`);
      }
    }
    ok('九套风格 × 明暗角标文字均可读', contrastFails.length === 0, contrastFails.join(' | ').slice(0, 240));

    // 推送「已是最新」→ 重新隐藏
    await page.evaluate(`window.__setUpdateBadgeForTest({ hasUpdate: false })`);
    const off = await page.evaluate(BADGE);
    ok('已是最新时角标重新隐藏', off && off.hidden === true && off.display === 'none', JSON.stringify(off));

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
