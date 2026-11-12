'use strict';
/**
 * 详情抽屉「不压暗主界面」的回归验证（真实 Electron 窗口 + CDP + 截图像素比对）。
 *
 * 为什么需要它：v2.4.1 外观改造把 --bg-elevated 铺给了 .detail-drawer（position:fixed; inset:0 的
 * 全屏定位容器），于是打开详情时整块视口被刷成面板色、再叠一层 35% 黑遮罩 —— 主界面整体变灰，
 * 侧栏与任务列表完全看不见。这类问题 DOM 断言抓不到「看起来灰了」，所以这里直接截像素。
 *
 * 断言：
 *  1. #detail-drawer 自身没有底色（alpha = 0），否则整屏被盖住；
 *  2. .detail-mask 不再压暗（alpha = 0），但仍能点它关闭抽屉；
 *  3. 面板（.detail-panel）本身仍是近实心底色（可读性不能跟着一起丢）；
 *  4. 截图像素：抽屉打开前后，左侧侧栏区域的亮度基本不变（±4），且面板区域确实被覆盖。
 *
 * 用法：node scripts/verify-detail-mask.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9488';
const profile = path.join(os.tmpdir(), `knodo-drawer-${Date.now()}`);
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

async function findPage() {
  for (let i = 0; i < 80; i += 1) {
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
    /** 直接拿表达式返回值（CDP 的 result.result.value），异常当场抛出 */
    evaluate: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || '渲染层表达式异常');
      }
      return r && r.result ? r.result.value : undefined;
    },
    screenshot: async () => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(r.data, 'base64');
    },
    close: () => ws.close(),
  };
}

/* ---------------- 最小 PNG 解码：只求「某个坐标的 RGB」，不引第三方依赖 ---------------- */
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels || bitDepth !== 8) throw new Error(`不支持的 PNG 格式：colorType=${colorType} bitDepth=${bitDepth}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const src = raw.subarray(p, p + stride);
    p += stride;
    const base = y * stride;
    const prevBase = base - stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[base + i - channels] : 0;
      const b = y > 0 ? out[prevBase + i] : 0;
      const c = i >= channels && y > 0 ? out[prevBase + i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[base + i] = v & 0xff;
    }
  }
  return {
    width,
    height,
    channels,
    lum: (x, y) => {
      const i = y * stride + x * channels;
      return 0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2];
    },
  };
}

const OPEN_AND_MEASURE = `(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // 数据隔离：只往临时 userData 里造数，绝不碰真实库
    const info = await window.api.env.getStorageInfo();
    out.dataDir = info && info.dir;
    if (!/knodo-drawer-/.test(JSON.stringify(info || {}))) {
      throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
    }
    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(500);
    const t = await window.api.tasks.create({ title: 'CDP 抽屉灰度用例' });
    out.taskId = t && t.id;
    // 刷出列表 → 打开详情
    await import('./js/ui.js');
    document.querySelector('.nav-item[data-view="today"]').click();
    await wait(400);
    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(900);
    const d = await import('./js/detail.js');
    d.openDetail(out.taskId);
    await wait(900);
    const drawer = document.getElementById('detail-drawer');
    const mask = drawer && drawer.querySelector('.detail-mask');
    const panel = drawer && drawer.querySelector('.detail-panel');
    const cs = (el) => (el ? getComputedStyle(el).backgroundColor : '');
    const alpha = (s) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(s || '');
      if (!m) return null;
      const parts = m[1].split(',').map((x) => x.trim());
      return parts.length < 4 ? 1 : Number(parts[3]);
    };
    out.drawerBg = cs(drawer);
    out.drawerAlpha = alpha(out.drawerBg);
    out.maskBg = cs(mask);
    out.maskAlpha = alpha(out.maskBg);
    out.panelBg = cs(panel);
    out.panelAlpha = alpha(out.panelBg);
    out.drawerRect = drawer ? { w: drawer.getBoundingClientRect().width, h: drawer.getBoundingClientRect().height } : null;
    const prect = panel ? panel.getBoundingClientRect() : null;
    out.panelLeft = prect ? Math.round(prect.left) : null;
    out.panelOnTop = false;
    if (prect) {
      const inPanel = document.elementFromPoint(Math.round(prect.left + prect.width / 2), Math.round(prect.top + 60));
      out.panelOnTop = !!(inPanel && panel.contains(inPanel));
    }
    out.panelControls = panel ? panel.querySelectorAll('input,select,textarea,button').length : 0;
    out.panelTitle = (() => {
      const el = panel && panel.querySelector('input,textarea');
      return el ? String(el.value || '').trim().slice(0, 24) : '';
    })();
    // 侧栏上的命中原色：应该只有透明的点击层，没有不透明覆盖块
    const hit = document.elementFromPoint(80, 300);
    out.hitClass = hit ? hit.className.toString().slice(0, 60) : '';
    out.hitIsMask = !!(hit && hit.classList && hit.classList.contains('detail-mask'));
    return out;
  } catch (e) {
    out.__err = String((e && e.message) || e);
    return out;
  }
})()`;

const CLOSE_AND_CHECK = `(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const drawer = document.getElementById('detail-drawer');
  const mask = drawer && drawer.querySelector('.detail-mask');
  if (mask) mask.click();
  await wait(500);
  out.closedByMask = !!drawer && drawer.hidden;
  return out;
})()`;

(async () => {
  const fail = (msg, extra) => {
    console.log(`[DRAWER] FAIL：${msg}`);
    if (extra) console.log(`[DRAWER] ${JSON.stringify(extra, null, 2)}`);
    killChild();
    process.exit(1);
  };

  try {
    const wsUrl = await findPage();
    const page = await connect(wsUrl);
    await page.evaluate('new Promise(r => (document.readyState === "complete" ? r(1) : window.addEventListener("load", () => r(1))))');
    await sleep(1500);

    const before = decodePng(await page.screenshot());
    const res = await page.evaluate(OPEN_AND_MEASURE);
    if (!res || res.__err) fail(`渲染层执行失败：${res && res.__err}`, res);
    await sleep(400);
    const afterShot = await page.screenshot();
    const after = decodePng(afterShot);
    const closeRes = await page.evaluate(CLOSE_AND_CHECK);

    // 采样点：窗口左侧（侧栏 / 侧栏与面板之间的内容区）—— 这些点必须完全不变
    const drawerH = after.height;
    const sampleX = [30, 80, 140, 200];
    const sampleY = [Math.round(drawerH * 0.3), Math.round(drawerH * 0.55), Math.round(drawerH * 0.75)];
    const diffs = [];
    sampleX.forEach((x) => {
      sampleY.forEach((y) => {
        if (x >= before.width || y >= before.height) return;
        diffs.push(Math.abs(before.lum(x, y) - after.lum(x, y)));
      });
    });
    const maxDiff = diffs.length ? Math.max(...diffs) : 999;
    const avgDiff = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 999;

    console.log(`[DRAWER] 抽屉容器底色=${res.drawerBg}（alpha=${res.drawerAlpha}）；遮罩底色=${res.maskBg}（alpha=${res.maskAlpha}）；面板底色=${res.panelBg}（alpha=${res.panelAlpha}）`);
    console.log(`[DRAWER] 像素比对（窗口左侧 ${sampleX.length}×${sampleY.length} 点）：平均差 ${avgDiff.toFixed(2)}、最大差 ${maxDiff.toFixed(2)}`);
    console.log(`[DRAWER] 左侧命中元素=${res.hitClass || '(none)'}（透明点击层=${res.hitIsMask ? '是' : '否'}）；面板在最上层=${res.panelOnTop ? '是' : '否'}；面板标题「${res.panelTitle || '-'}」/ 控件 ${res.panelControls} 个；点遮罩关闭=${closeRes.closedByMask ? '✓' : '✗'}`);

    const problems = [];
    if (res.drawerAlpha !== 0) problems.push(`detail-drawer 自身有不透明底色（alpha=${res.drawerAlpha}）→ 会整屏刷色`);
    if (res.maskAlpha !== 0) problems.push(`detail-mask 仍在压暗（alpha=${res.maskAlpha}）`);
    if (!(res.panelAlpha > 0.9)) problems.push(`detail-panel 底色不够实（alpha=${res.panelAlpha}）→ 文字会压在半透明底上`);
    if (maxDiff > 4) problems.push(`左侧主界面亮度变化过大（最大 ${maxDiff.toFixed(2)} > 4）→ 打开详情时被压暗/盖住`);
    if (!res.panelOnTop) problems.push('面板没有盖在最上层（被遮罩或其它层压住）');
    if (!(res.panelControls >= 5) || !res.panelTitle) problems.push(`面板内容不全（控件 ${res.panelControls} 个、标题「${res.panelTitle}」）`);
    if (!closeRes.closedByMask) problems.push('点空白处关不掉抽屉（透明点击层失效）');

    page.close();
    if (problems.length) fail(problems.join('；'), { res, closeRes, avgDiff, maxDiff });

    console.log('[DRAWER] DRAWER_OK');
    killChild();
    process.exit(0);
  } catch (e) {
    console.log('[DRAWER] 检测失败：', (e && e.message) || e);
    if (childLog) console.log('[DRAWER] 窗口日志：', childLog.split('\n').slice(-8).join(' | '));
    killChild();
    process.exit(1);
  }
})();

process.on('exit', killChild);
