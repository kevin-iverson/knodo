'use strict';
/**
 * 「导入」入口位置验证：
 *  - 顶栏不再有「📥 导入」（低频恢复动作不该和天天点的「📤 备份」并排占行宽）；
 *  - 设置中心「数据与备份」里能找到「从备份包恢复（导入）」；
 *  - 点它会先收起设置面板，再进 ui.js#importData（用 confirm 探针判定，不真的弹文件选择框）；
 *  - 「导入 Markdown 笔记」等原有迁移入口没被挤掉。
 *
 * 用法：node scripts/verify-import-entry.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9485';
const profile = path.join(os.tmpdir(), `knodo-import-entry-${Date.now()}`);
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
    close: () => ws.close(),
  };
}

/** 打开设置中心并切到「数据与备份」分区 */
async function gotoDataPane(page) {
  await page.evaluate(`document.querySelector('.tb-set').click()`);
  for (let i = 0; i < 40; i += 1) {
    if (await page.evaluate(`!!document.querySelector('.st-nav-item[data-nav="data"]')`)) break;
    await sleep(200);
  }
  await page.evaluate(`document.querySelector('.st-nav-item[data-nav="data"]').click()`);
  await sleep(500);
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
    await sleep(1800);

    // 1) 顶栏：导入下线、备份仍在（导出是附件/录音的唯一出口，不能跟着走）
    const top = await page.evaluate(`(() => ({
      hasImport: !!document.getElementById('btn-import'),
      hasExport: !!document.getElementById('btn-export'),
      hasNew: !!document.getElementById('btn-new-task'),
    }))()`);
    ok('顶栏不再有「📥 导入」', top && top.hasImport === false, JSON.stringify(top));
    ok('顶栏「📤 备份」「＋新建任务」仍在', top && top.hasExport && top.hasNew, JSON.stringify(top));

    // 2) 设置 → 数据与备份：能搜到那一行，且真的可见（不是 hidden 的占位）
    await gotoDataPane(page);
    const row = await page.evaluate(`(() => {
      const el = document.querySelector('[data-item="import-data"]');
      if (!el) return { found: false };
      const btn = el.querySelector('[data-act]');
      const r = btn ? btn.getBoundingClientRect() : null;
      return {
        found: true,
        title: (el.querySelector('.st-row-title') || {}).textContent || '',
        btnText: btn ? btn.textContent.trim() : '',
        act: btn ? btn.dataset.act : '',
        visible: !!r && r.height > 0 && r.width > 0,
      };
    })()`);
    ok('设置里有「从备份包恢复（导入）」一行', row && row.found && /导入/.test(row.title), JSON.stringify(row));
    ok('该行按钮可见且动作为 import-data', row && row.visible && row.act === 'import-data', JSON.stringify(row));

    // 3) 点它：先收起设置（不叠两个弹窗），再进 importData
    //    contextBridge 暴露的 api 只读、改不了，所以用 importData 第一句 confirm 当探针；
    //    返回 false 直接取消，避免真的弹系统文件选择框。
    const chain = await page.evaluate(`(async () => {
      let confirmed = false;
      const orig = window.confirm;
      window.confirm = () => { confirmed = true; return false; };
      document.querySelector('[data-item="import-data"] [data-act]').click();
      await new Promise((r) => setTimeout(r, 700));
      window.confirm = orig;
      return { confirmed, settingsOpen: !!document.querySelector('.modal-settings') };
    })()`);
    ok('点击后进到 importData（会先问覆盖确认）', chain && chain.confirmed === true, JSON.stringify(chain));
    ok('点击后设置面板已收起（不叠弹窗）', chain && chain.settingsOpen === false, JSON.stringify(chain));

    // 4) 原有迁移入口没被挤掉
    await gotoDataPane(page);
    const mdRow = await page.evaluate(`!!document.querySelector('[data-item="import-md"] [data-act]')`);
    ok('「导入 Markdown 笔记」入口仍在', mdRow === true);
  } catch (e) {
    ok('脚本执行', false, (e && e.message) || String(e));
  } finally {
    cleanup();
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? `  · ${r.extra}` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log(log.slice(-800));
    process.exitCode = 1;
  }
})();
