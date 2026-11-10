'use strict';
/**
 * AI 检索弹窗的端到端验证（开发辅助脚本，非应用运行时依赖）。
 * 覆盖两件事：
 *  1) 视觉：内容铺满弹窗（两栏：历史 + 结果），空态不塌成中间一条；
 *  2) 行为：点遮罩 / 按 Esc **不**关窗，只有 ✕ 与底部「关闭」才关；点结果不丢结果。
 * 用法：node scripts/verify-search-modal.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9471';
const profile = path.join(os.tmpdir(), `knodo-search-${Date.now()}`);
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
  for (let i = 0; i < 60; i += 1) {
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
    await sleep(1400);

    // 造几条可被检索到的任务（无 Key 走本地联想，也能出结果）
    await page.evaluate(`(async () => {
      await window.api.tasks.create({ title: '供应商合同到期复核' });
      await window.api.tasks.create({ title: '合同模板归档' });
      await window.api.tasks.create({ title: '周会纪要整理' });
      return true;
    })()`);

    // 1) 打开弹窗
    await page.evaluate(`document.getElementById('btn-ai-search').click()`);
    await sleep(900);
    await page.shot(path.join(shotDir, 'search-1-empty.png'));

    const layout = await page.evaluate(`(() => {
      const modal = document.querySelector('.modal-mask .modal-search');
      const body = modal.querySelector('.modal-body');
      const panel = modal.querySelector('.search-panel');
      const hero = modal.querySelector('.search-field');
      const side = modal.querySelector('.search-side');
      const stage = modal.querySelector('.search-stage');
      const empty = modal.querySelector('#ai-search-empty');
      const mr = modal.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      const hr = hero.getBoundingClientRect();
      const er = empty.getBoundingClientRect();
      const cs = getComputedStyle(body);
      const innerW = br.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return {
        innerW: Math.round(innerW),
        modalW: Math.round(mr.width), modalH: Math.round(mr.height),
        bodyW: Math.round(br.width), panelW: Math.round(pr.width),
        heroW: Math.round(hr.width),
        sideW: Math.round(side.getBoundingClientRect().width),
        stageW: Math.round(stage.getBoundingClientRect().width),
        emptyH: Math.round(er.height),
        stageScroll: stage.scrollHeight - stage.clientHeight,
        // 右半边空白 = 结果区高度 - 内容高度（空态应当撑满，不该留白）
        stageFill: Math.round(stage.getBoundingClientRect().height - er.height),
      };
    })()`);
    ok('弹窗宽度 ~860', layout && Math.abs(layout.modalW - 860) <= 2, JSON.stringify(layout));
    ok('检索栏铺满内容区（不再缩成中间一条）',
      layout && layout.panelW >= layout.innerW - 2 && layout.heroW > 400,
      JSON.stringify({ panelW: layout.panelW, innerW: layout.innerW, heroW: layout.heroW }));
    ok('两栏：历史 210 + 结果区自适应', layout && layout.sideW >= 200 && layout.stageW > 400, JSON.stringify(layout));
    ok('空态填满右栏（无大片空白）', layout && layout.emptyH > 300 && layout.stageFill <= 2, JSON.stringify(layout));

    // 2) 点遮罩：不许关
    await page.evaluate(`document.querySelector('.modal-mask').click()`);
    await sleep(400);
    ok('点遮罩不关窗',
      await page.evaluate(`!!document.querySelector('.modal-mask .modal-search')`));

    // 3) 按 Esc：不许关
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(400);
    ok('按 Esc 不关窗',
      await page.evaluate(`!!document.querySelector('.modal-mask .modal-search')`));

    // 4) 检索一次 → 有结果 + 截图
    await page.evaluate(`(() => {
      const input = document.getElementById('ai-search-input');
      input.value = '合同';
      document.getElementById('ai-search-btn').click();
      return true;
    })()`);
    await sleep(2200);
    await page.shot(path.join(shotDir, 'search-2-results.png'));
    const res = await page.evaluate(`(() => {
      const modal = document.querySelector('.modal-mask .modal-search');
      return {
        items: modal.querySelectorAll('.search-result-item').length,
        emptyHidden: modal.querySelector('#ai-search-empty').hidden,
        history: modal.querySelectorAll('.sh-item').length,
        note: (modal.querySelector('#ai-search-note').textContent || '').slice(0, 60),
      };
    })()`);
    ok('检索出结果并替换空态', res && res.items >= 1 && res.emptyHidden, JSON.stringify(res));
    ok('检索写入历史栏', res && res.history >= 1, JSON.stringify(res));

    // 5) 点第一条结果：弹窗还在，抽屉抬到遮罩之上
    await page.evaluate(`document.querySelector('.search-result-item').click()`);
    await sleep(900);
    const over = await page.evaluate(`(() => {
      const drawer = document.getElementById('detail-drawer');
      return {
        modal: !!document.querySelector('.modal-mask .modal-search'),
        z: drawer ? getComputedStyle(drawer).zIndex : null,
        items: document.querySelectorAll('.search-result-item').length,
      };
    })()`);
    ok('点结果不关弹窗（结果还在）', over && over.modal && over.items >= 1, JSON.stringify(over));
    ok('详情抽屉被抬到遮罩之上', over && Number(over.z) > 300, JSON.stringify(over));
    await page.shot(path.join(shotDir, 'search-3-detail.png'));

    // 关掉抽屉（Esc 由抽屉自己处理），确认弹窗仍在
    await page.evaluate(`document.getElementById('detail-drawer').querySelector('.detail-mask').click()`);
    await sleep(600);
    const back = await page.evaluate(`(() => ({
      drawerZ: getComputedStyle(document.getElementById('detail-drawer')).zIndex,
      drawerHidden: document.getElementById('detail-drawer').hidden,
      modal: !!document.querySelector('.modal-mask .modal-search'),
    }))()`);
    ok('关抽屉后层级还原、弹窗仍在',
      back && back.modal && (!back.drawerHidden || back.drawerZ === '150'), JSON.stringify(back));

    // 6) 深色主题下截图
    await page.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
    await sleep(400);
    await page.shot(path.join(shotDir, 'search-4-dark.png'));
    await page.evaluate(`document.documentElement.removeAttribute('data-theme')`);

    // 7) ✕ 关闭
    await page.evaluate(`document.querySelector('.modal-mask .modal-search [data-modal="close"]').click()`);
    await sleep(500);
    ok('✕ 能关窗', !(await page.evaluate(`!!document.querySelector('.modal-mask .modal-search')`)));

    // 8) 底部「关闭」也能关
    await page.evaluate(`document.getElementById('btn-ai-search').click()`);
    await sleep(700);
    await page.evaluate(`document.querySelector('.modal-mask .modal-search [data-modal="ok"]').click()`);
    await sleep(500);
    ok('底部「关闭」能关窗', !(await page.evaluate(`!!document.querySelector('.modal-mask .modal-search')`)));

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
