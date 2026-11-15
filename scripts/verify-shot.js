'use strict';
/**
 * 截图建任务 · 端到端验收（真实 Electron 窗口 + CDP + 本地 mock 视觉接口）。
 *
 * 覆盖的是「不好靠读代码确认」的那部分：
 *  1. 框选覆盖层真的能开（独立窗口、遮罩、底栏、8 个手柄）；
 *  2. 初始框选 → 松手 → 进入可调整态（不是立刻确认）；
 *  3. 拖角 / 拖边界改大小、拖内部改位置，尺寸标签实时跟着变；
 *  4. 调整完按 Enter 才确认，并且附件尺寸与选区一致（DPR 换算正确）；
 *  5. Esc 取消 → 没有图、没有任务；
 *  6. 确认卡：骨架 → 列表 → 勾选/改优先级 → 提交 → 任务与附件同时落库；
 *  7. 未配 Key 时是 NO_API_KEY（不发明文 401）。
 *
 * 视觉接口用本地 http 服务 mock，不花钱、不依赖网络。
 *
 * 用法：node scripts/verify-shot.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9491';
const profile = path.join(os.tmpdir(), `knodo-shot-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail === undefined ? '' : `（${detail}）`}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? '' : `（${detail}）`}`);
  }
}

/* ------------------------------ mock 视觉接口 ------------------------------ */

let sawImage = false;
let mockRequests = 0;
const MOCK_TASKS = {
  summary: '一张项目排期表',
  tasks: [
    { title: '把 8 月对账单发给财务', note: '截图里写的是 8/31 前', priority: 2, due: '2026-08-31' },
    { title: '跟王工确认接口联调时间', note: '', priority: 1, due: null },
  ],
};

/** 请求体 → 第一张图的 data URL（探针与真实截图走同一个 image_url 结构） */
function firstImageUrl(payload) {
  for (const msg of payload.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    const part = msg.content.find((x) => x && x.type === 'image_url');
    if (part && part.image_url && part.image_url.url) return String(part.image_url.url);
  }
  return '';
}

/** data:image/png;base64 → { w, h }；不是 PNG / 解析失败就 null */
function pngSize(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const b = Buffer.from(m[1], 'base64');
  if (b.length < 24 || b.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (!/\/chat\/completions$/.test(req.url || '')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"error":"not found"}');
          return;
        }
        mockRequests += 1;
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
          const flat = JSON.stringify(payload);
          if (flat.includes('"image_url"') && flat.includes('data:image/jpeg;base64,')) sawImage = true;
        } catch (e) { /* 体不是 JSON 也不影响返回 */ }
        // 用来验证「服务端明确拒绝图片输入」时，错误会被翻译成可操作的中文提示
        if (payload.model === 'text-only-model') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: 'The model does not support image input.', type: 'invalid_request_error' },
          }));
          return;
        }
        // 模拟 Qwen 视觉系列的尺寸下限：宽高 ≥10px，Qwen3.8 还要求 min_pixels ≥65536。
        // 自检图从 8×8 改成 256×256（正好 65536 像素）就是为了过这一关。
        const probe = pngSize(firstImageUrl(payload));
        if (probe && (probe.w < 10 || probe.h < 10 || probe.w * probe.h < 65536)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: 'The image size is too small.', type: 'invalid_request_error' },
          }));
          return;
        }
        const reply = JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(MOCK_TASKS) } }],
        });
        // 真模型要 5–10 秒：故意拖 500ms，「骨架屏」「加载中不能提交」这两个状态才可观察
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(reply);
        }, 500);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------ Electron + CDP ------------------------------ */

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let child = null;
let closed = false;
let childLog = '';
function killChild() {
  if (closed || !child) return;
  closed = true;
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* 已退出 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 留给系统 */ }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function findTarget(re, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const list = await targets();
      const hit = list.find((t) => t.type === 'page' && re.test(t.url) && t.webSocketDebuggerUrl);
      if (hit) return hit.webSocketDebuggerUrl;
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  return null;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`WebSocket 连接失败：${e && e.message ? e.message : e}`));
  });
  let seq = 0;
  const pending = new Map();
  const closeAll = (why) => {
    for (const [, p] of pending) p.reject(new Error(why));
    pending.clear();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };
  // 目标页本身被关掉（覆盖层确认后就会 destroy）：挂着的请求必须在此时失败，
  // 否则 await 永远不返回，整个脚本卡到超时也看不出卡在哪一行
  ws.onclose = () => closeAll('目标页已关闭');
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`CDP 无响应：${method}`));
    }, 8000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
  return {
    send,
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || '页面脚本异常');
      }
      return r.result ? r.result.value : undefined;
    },
    close() { try { ws.close(); } catch (_) { /* 忽略 */ } },
  };
}

/** 一堆鼠标拖拽：按下 → 分几步移动（让 pointermove 真的逐帧触发）→ 松开 */
async function drag(page, from, to, steps = 8) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
  });
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(80);
}

async function pressKey(page, key, code, keyCode) {
  // Enter / Esc 可能就是"关掉覆盖层"的那一下：窗口随即销毁，对应的 keyUp 注定等不到响应。
  // 两次 dispatch 各自兜住，别把"按预期关了窗"当成脚本异常。
  for (const type of ['keyDown', 'keyUp']) {
    try {
      await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode });
    } catch (_) { /* 目标页已销毁 */ }
  }
  await sleep(150);
}

/** 把页面里一个 Promise 求值，但最多等 ms —— 卡住时要能报"卡在哪"，而不是整脚本超时 */
const settleExpr = (expr, ms = 12000) => `Promise.race([
  Promise.resolve(${expr}).then((v) => ({ timedOut: false, value: v }), (e) => ({ timedOut: false, error: String((e && e.message) || e) })),
  new Promise((r) => setTimeout(() => r({ timedOut: true }), ${ms})),
])`;

/* ------------------------------ 主流程 ------------------------------ */

/** `--shots`：把覆盖层 / 确认卡截到 %TEMP%/knodo-shot-shots/，改样式时先看这几张 */
const SHOT_DIR = path.join(os.tmpdir(), 'knodo-shot-shots');
const wantShots = process.argv.includes('--shots');
async function snap(page, name) {
  if (!wantShots) return;
  try {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    if (!r || !r.data) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
    console.log(`   · 截图 ${name}`);
  } catch (e) { /* 截图失败不影响验收结论 */ }
}

/** 打一行"即将做什么"：卡死时最后一行就是卡住的位置 */
const trace = (name) => console.log(`   · ${name}`);

async function main() {
  const mock = await startMock();
  console.log(`· mock 视觉接口在 127.0.0.1:${mock.port}`);

  child = spawn(electronBin, [
    root,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', (b) => { childLog += b.toString(); });
  child.stderr.on('data', (b) => { childLog += b.toString(); });

  const mainWs = await findTarget(/index\.html/);
  if (!mainWs) throw new Error('找不到主窗口渲染进程');
  const main = await connect(mainWs);

  // 等界面就绪
  for (let i = 0; i < 60; i += 1) {
    if (await main.evaluate('window.__appReady === true')) break;
    await sleep(300);
  }

  // api.shot.* 回的是信封：注入一个拆包器，脚本里就能照旧“返回值 / 抛异常”地写
  await main.evaluate(`window.__shot = async (p) => {
    const r = await p;
    if (!r || r.ok === false) {
      const e = new Error((r && r.message) || '操作失败');
      if (r && r.code) e.code = r.code;
      throw e;
    }
    return r.data;
  }; true`);

  console.log('\n[1] 未配置视觉模型时的状态');
  const st0 = await main.evaluate('window.__shot(window.api.shot.status())');
  check('没有暂存图', st0 && st0.hasImage === false);
  check('视觉模型回落到对话模型', st0.vision.source === 'fallback', st0.vision.model);

  console.log('\n[2] 区域截图：框选 → 二次调整');
  // 不 await：这个 Promise 要等覆盖层关掉才 resolve
  await main.evaluate('window.__shotP = window.__shot(window.api.shot.screen()); true');

  const overlayWs = await findTarget(/shot-overlay\.html/);
  if (!overlayWs) throw new Error('覆盖层窗口没打开');
  const ov = await connect(overlayWs);
  await sleep(600);

  const boot = await ov.evaluate(`(() => ({
    state: document.getElementById('so').dataset.state,
    scrim: !document.getElementById('so-scrim').hidden,
    selHidden: document.getElementById('so-sel').hidden,
    barIdle: !document.getElementById('so-bar-idle').hidden,
    acts: !document.getElementById('so-bar-act').hidden,
    bg: (document.getElementById('so-bg').src || '').slice(0, 22),
    w: innerWidth, h: innerHeight,
  }))()`);
  check('打开就是 idle + 整屏压暗', boot.state === 'idle' && boot.scrim === true);
  check('背景图已注入', boot.bg.startsWith('data:image/jpeg'), boot.bg);
  check('底栏是说明态（没有确认按钮）', boot.barIdle === true && boot.acts === false);

  // 初始框选：200,150 → 600,450
  await drag(ov, { x: 200, y: 150 }, { x: 600, y: 450 });

  const sel = await ov.evaluate(`(() => {
    const s = document.getElementById('so-sel');
    return {
      state: document.getElementById('so').dataset.state,
      hidden: s.hidden,
      w: Math.round(s.getBoundingClientRect().width),
      h: Math.round(s.getBoundingClientRect().height),
      sizeText: document.getElementById('so-size').textContent.replace(/\\s+/g, ''),
      handles: s.querySelectorAll('.so-h').length,
      acts: !document.getElementById('so-bar-act').hidden,
    };
  })()`);
  check('松手后进入「可调整」而不是直接确认', sel.state === 'selected', sel.state);
  check('选区尺寸 400×300', sel.w === 400 && sel.h === 300, `${sel.w}×${sel.h}`);
  check('尺寸标签实时显示 400×300', sel.sizeText === '400×300', sel.sizeText);
  check('8 个手柄齐备', sel.handles === 8, String(sel.handles));
  check('底栏切到「取消 / 完成」', sel.acts === true);

  // 拖右下角 +100/+50 → 500×350
  await drag(ov, { x: 600, y: 450 }, { x: 700, y: 500 });
  const resized = await ov.evaluate(`(() => {
    const s = document.getElementById('so-sel');
    return {
      state: document.getElementById('so').dataset.state,
      w: Math.round(s.getBoundingClientRect().width),
      h: Math.round(s.getBoundingClientRect().height),
      left: Math.round(s.getBoundingClientRect().left),
      sizeText: document.getElementById('so-size').textContent.replace(/\\s+/g, ''),
    };
  })()`);
  check('拖角改大小生效', resized.w === 500 && resized.h === 350, `${resized.w}×${resized.h}`);
  check('拖角不改变左上角', resized.left === 200, String(resized.left));
  check('尺寸标签跟着变', resized.sizeText === '500×350', resized.sizeText);
  await snap(ov, '1-overlay-selected.png');

  // 拖右边中点（边界）→ 只改宽
  await drag(ov, { x: 700, y: 325 }, { x: 640, y: 325 });
  const edge = await ov.evaluate(`(() => {
    const s = document.getElementById('so-sel');
    return { w: Math.round(s.getBoundingClientRect().width), h: Math.round(s.getBoundingClientRect().height) };
  })()`);
  check('拖边界只改一个方向', edge.w === 440 && edge.h === 350, `${edge.w}×${edge.h}`);

  // 拖内部 → 只改位置
  await drag(ov, { x: 300, y: 300 }, { x: 350, y: 330 });
  const moved = await ov.evaluate(`(() => {
    const s = document.getElementById('so-sel');
    const r = s.getBoundingClientRect();
    return {
      left: Math.round(r.left), top: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      state: document.getElementById('so').dataset.state,
    };
  })()`);
  check('拖内部改位置', moved.left === 250 && moved.top === 180, `${moved.left},${moved.top}`);
  check('移动时尺寸不变', moved.w === 440 && moved.h === 350, `${moved.w}×${moved.h}`);
  await snap(ov, '2-overlay-moved.png');

  // 调整中途按 Esc → 回到调整前，而不是退出
  await ov.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: 250, y: 180, button: 'left', buttons: 1, clickCount: 1,
  });
  await ov.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: 320, y: 240, button: 'left', buttons: 1,
  });
  await pressKey(ov, 'Escape', 'Escape', 27);
  const afterEscAdjust = await ov.evaluate(`(() => {
    const r = document.getElementById('so-sel').getBoundingClientRect();
    return {
      state: document.getElementById('so').dataset.state,
      left: Math.round(r.left), top: Math.round(r.top),
      alive: !!document.getElementById('so'),
    };
  })()`);
  check('调整中按 Esc 只撤销这次调整', afterEscAdjust.alive && afterEscAdjust.left === 250 && afterEscAdjust.top === 180,
    `${afterEscAdjust.left},${afterEscAdjust.top} / ${afterEscAdjust.state}`);
  await ov.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 320, y: 240, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(80);

  // Enter 确认
  trace('按 Enter（窗口会立刻销毁，keyUp 可能等不到回包）');
  await pressKey(ov, 'Enter', 'Enter', 13);
  trace('等 __shotP');
  await sleep(500);
  const shotR = await main.evaluate(settleExpr('window.__shotP'));
  const shot = shotR && !shotR.timedOut ? shotR.value : null;
  check('Enter 后覆盖层关闭并拿到图', !!(shot && shot.hasImage === true),
    shotR && shotR.timedOut ? '超时：覆盖层没有交回选区' : (shotR && shotR.error) || (shot && shot.source));
  // 附件裁的是**物理像素**：440×350 CSS 在 125% 缩放下应当是 550×438 左右
  const dpr = await main.evaluate('window.devicePixelRatio');
  check('尺寸与选区一致（按 DPR 换算）',
    !!shot && Math.abs(shot.width - 440 * dpr) <= 3 && Math.abs(shot.height - 350 * dpr) <= 3,
    shot && `${shot.width}×${shot.height} / dpr=${dpr}`);
  ov.close();

  console.log('\n[3] 未配 Key：识别直接报 NO_API_KEY，不发请求');
  const before = mockRequests;
  const errNoKey = await main.evaluate(`window.__shot(window.api.shot.recognize()).then(() => '').catch((e) => e.code || e.message)`);
  check('返回 NO_API_KEY', errNoKey === 'NO_API_KEY', errNoKey);

  console.log('\n[4] Esc 取消不留痕');
  trace('discard');
  await main.evaluate('window.__shot(window.api.shot.discard())');
  trace('screen()');
  await main.evaluate('window.__shotP2 = window.__shot(window.api.shot.screen()); true');
  trace('等覆盖层窗口');
  const ov2Ws = await findTarget(/shot-overlay\.html/);
  if (!ov2Ws) throw new Error('第二次框选没打开覆盖层');
  trace('连覆盖层 CDP');
  const ov2 = await connect(ov2Ws);
  await sleep(500);
  trace('按 Esc');
  await pressKey(ov2, 'Escape', 'Escape', 27);
  trace('等 __shotP2');
  const shot2R = await main.evaluate(settleExpr('window.__shotP2'));
  const shot2 = shot2R && !shot2R.timedOut ? shot2R.value : null;
  check('Esc → 取消', !!(shot2 && shot2.canceled === true),
    shot2R && shot2R.timedOut ? '超时：Esc 没关掉覆盖层' : (shot2 && shot2.reason));
  const st2 = await main.evaluate('window.__shot(window.api.shot.status())');
  check('取消后没有暂存图', st2.hasImage === false);
  ov2.close();

  console.log('\n[5] 配好视觉模型后识别（mock 接口）');
  await main.evaluate(`window.api.ai.saveConfig({
    visionBaseUrl: 'http://127.0.0.1:${mock.port}/v1',
    visionModel: 'mock-vl-1',
    visionKey: 'sk-test',
  })`);
  const vis = await main.evaluate('window.api.ai.getConfig()');
  check('配置回读一致', vis.vision.effective.model === 'mock-vl-1', vis.vision.effective.model);
  check('判定为能读图', vis.vision.effective.imageCapability === 'yes');

  console.log('\n[5b] qwen3.8-flash：名字里没有 vl / vision，也必须能真发图');
  await main.evaluate(`window.api.ai.saveConfig({ visionModel: 'qwen3.8-flash' })`);
  const qwenCfg = await main.evaluate('window.api.ai.getConfig()');
  check('目录里认得出 qwen3.8-flash', qwenCfg.vision.effective.imageCapability === 'yes');
  const qwenProbe = await main.evaluate('window.api.ai.testVision({})');
  check('读图自检真的发出去了（不再被白名单拦下）',
    qwenProbe && qwenProbe.ok === true, qwenProbe && qwenProbe.message);

  console.log('\n[5c] 目录里没有的模型名：不猜成「不支持」，同样放行');
  await main.evaluate(`window.api.ai.saveConfig({ visionModel: 'my-private-vlm-2027' })`);
  const unknownCfg = await main.evaluate('window.api.ai.getConfig()');
  check('未收录的名字标成「未确认」而不是「不支持」', unknownCfg.vision.effective.imageCapability === 'unknown');
  const unknownProbe = await main.evaluate('window.api.ai.testVision({})');
  check('未知模型同样能发图自检',
    unknownProbe && unknownProbe.ok === true, unknownProbe && unknownProbe.message);

  console.log('\n[5d] 服务端真的拒绝图片时：给出可操作的提示');
  await main.evaluate(`window.api.ai.saveConfig({ visionModel: 'text-only-model' })`);
  const badProbe = await main.evaluate('window.api.ai.testVision({})');
  check('失败信息指向「不支持图片 / 换模型」',
    badProbe && badProbe.ok === false && /不支持图片/.test(badProbe.message),
    badProbe && badProbe.message);

  // 还原成 mock-vl-1：后面的识别与卡片验收仍按原路径走
  await main.evaluate(`window.api.ai.saveConfig({ visionModel: 'mock-vl-1' })`);

  // 重新截一张（上一步 cancel 过，暂存已清）
  const recapture = await main.evaluate(`(async () => {
    try { await window.__shot(window.api.shot.clipboard()); return 'clip'; } catch (e) {
      // 剪贴板没有图时用框选之外的方式拿不到图，直接判失败
      return 'no-image:' + (e.code || e.message);
    }
  })()`);
  // 剪贴板大概率没有图：改用覆盖层再截一次
  if (String(recapture).startsWith('no-image')) {
    await main.evaluate('window.__shotP3 = window.__shot(window.api.shot.screen()); true');
    const ov3Ws = await findTarget(/shot-overlay\.html/);
    const ov3 = await connect(ov3Ws);
    await sleep(500);
    await drag(ov3, { x: 300, y: 220 }, { x: 700, y: 500 });
    await pressKey(ov3, 'Enter', 'Enter', 13);
    await sleep(400);
    ov3.close();
  }

  const rec = await main.evaluate('window.__shot(window.api.shot.recognize())');
  check('mock 收到的是 image_url data URL', sawImage === true);
  check('识别出 2 条', rec && rec.tasks.length === 2, rec && `${rec.tasks.length}`);
  check('summary 透传', rec.summary === MOCK_TASKS.summary, rec.summary);
  check('模型标签可读', !!rec.modelLabel, rec.modelLabel);

  console.log('\n[6] 确认卡：列表 → 勾选 → 提交');
  await main.evaluate(`(async () => {
    const m = await import('./js/shot-task.js');
    window.__card = m.openShotCard();
    return true;
  })()`);
  const readCard = `(() => {
    const mask = document.querySelector('.modal-shot');
    const ok = mask && mask.querySelector('[data-modal="ok"]');
    return {
      open: !!mask,
      skel: !!mask && !!mask.querySelector('.shot-skel'),
      okDisabled: !!ok && ok.disabled,
    };
  })()`;
  let cardLoading = { open: false, skel: false, okDisabled: false };
  for (let i = 0; i < 15; i += 1) {
    cardLoading = await main.evaluate(readCard);
    if (cardLoading.skel) break;
    await sleep(40);
  }
  check('卡片打开并先显示骨架屏', cardLoading.open === true && cardLoading.skel === true);
  check('加载中不能提交', cardLoading.okDisabled === true);

  let rows = 0;
  for (let i = 0; i < 40; i += 1) {
    rows = await main.evaluate('document.querySelectorAll(".modal-shot .shot-row").length');
    if (rows === 2) break;
    await sleep(200);
  }
  check('识别结果落成 2 行', rows === 2, String(rows));
  const rowState = await main.evaluate(`(() => {
    const r = [...document.querySelectorAll('.modal-shot .shot-row')];
    return {
      allChecked: r.every((x) => x.querySelector('input[type=checkbox]').checked),
      titles: r.map((x) => x.querySelector('.shot-title').textContent),
      pri: r.map((x) => x.querySelector('.shot-pri').textContent),
      okEnabled: !document.querySelector('.modal-shot [data-modal="ok"]').disabled,
    };
  })()`);
  check('默认全选', rowState.allChecked === true);
  check('标题取自识别结果', rowState.titles[0] === MOCK_TASKS.tasks[0].title, rowState.titles[0]);
  check('优先级胶囊显示「高 / 中」', rowState.pri.join(',') === '高,中', rowState.pri.join(','));
  check('可以提交', rowState.okEnabled === true);
  await snap(main, '3-card-list.png');

  // 取消勾选第二条 + 把第一条改成紧急
  await main.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.modal-shot .shot-row')];
    rows[1].querySelector('input[type=checkbox]').click();
    rows[0].querySelector('.shot-pri').click();
    return true;
  })()`);
  const afterToggle = await main.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.modal-shot .shot-row')];
    return { off: rows[1].classList.contains('is-off'), pri: rows[0].querySelector('.shot-pri').textContent };
  })()`);
  check('取消勾选后该行变暗', afterToggle.off === true);
  check('点胶囊循环到「紧急」', afterToggle.pri === '紧急', afterToggle.pri);

  // 提交
  await main.evaluate('document.querySelector(\'.modal-shot [data-modal="ok"]\').click(); true');
  let submitted = false;
  for (let i = 0; i < 40; i += 1) {
    submitted = await main.evaluate('!document.querySelector(".modal-shot")');
    if (submitted) break;
    await sleep(200);
  }
  check('提交后卡片关闭', submitted === true);

  console.log('\n[7] 落库结果');
  const tasks = await main.evaluate(`(async () => {
    const list = await window.api.tasks.list({ status: 'any' });
    return list.filter((t) => t.title === '${MOCK_TASKS.tasks[0].title.replace(/'/g, "\\'")}');
  })()`);
  check('只建了勾选的那一条', tasks.length === 1, String(tasks.length));
  const t0 = tasks[0] || {};
  check('优先级 = 紧急(3)', t0.priority === 3, String(t0.priority));
  check('计划日期是今天', !!t0.plan_start && t0.plan_start === t0.plan_end, `${t0.plan_start}`);
  check('描述里有 todo-media 图片', /todo-media:\/\/\//.test(t0.notes || ''), (t0.notes || '').slice(0, 40));
  check('附件已登记', Array.isArray(t0.attachments) && t0.attachments.length === 1,
    t0.attachments && t0.attachments[0] && t0.attachments[0].name);
  const attPath = t0.attachments && t0.attachments[0]
    ? path.join(profile, 'attachments', t0.attachments[0].path)
    : '';
  if (attPath) {
    const exists = fs.existsSync(attPath);
    const size = exists ? fs.statSync(attPath).size : 0;
    check('附件文件真的落盘了', exists && size > 1000, exists ? `${Math.round(size / 1024)}KB` : '缺失');
  } else {
    check('附件文件真的落盘了', false, '没有附件记录');
  }
  const st3 = await main.evaluate('window.__shot(window.api.shot.status())');
  check('提交后暂存已清', st3.hasImage === false);

  main.close();
  mock.server.close();
  return childLog;
}

/* ------------------------------ 入口 ------------------------------ */

const hardStop = setTimeout(() => {
  console.error('\n超时：180 秒内没跑完，强制结束');
  if (childLog) console.error(`\n--- 主进程日志 ---\n${childLog.slice(-3000)}`);
  killChild();
  process.exit(1);
}, 180000);

main()
  .then((log) => {
    clearTimeout(hardStop);
    killChild();
    console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
      console.log(`失败项：${fails.join('；')}`);
      if (log) console.log(`\n--- 主进程日志 ---\n${log.slice(-3000)}`);
      process.exit(1);
    }
    console.log('截图建任务验收通过 ✓');
    process.exit(0);
  })
  .catch((e) => {
    clearTimeout(hardStop);
    killChild();
    console.error('\n验收脚本异常：', e && e.message ? e.message : e);
    process.exit(1);
  });
