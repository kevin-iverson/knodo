'use strict';
/**
 * 「会议纪要 · 重命名」回归验证。
 *
 * 曾经的故障：点「✎ 重命名」完全没反应——按钮事件进得去，但下一步用了
 * `window.prompt()`。Electron 的渲染层不实现 prompt（不弹窗、有的版本直接抛
 * "prompt() is and will not be supported"），异常又被异步事件吃掉，用户看到的
 * 就是"点了没反应"。
 *
 * 本脚本钉三件事：
 *  1. 点重命名必须真的弹出可输入的对话框（.modal-mask 内的输入框）；
 *  2. 确认后标题必须真正落库（meeting.list 里能找到新标题）；
 *  3. 界面（右栏大标题 + 左栏列表项）要跟着刷新，弹窗要关掉。
 *
 * 会话数据用 rec:startSession + rec:finalize 现造，不依赖录音硬件与真实音频。
 *
 * 用法：node scripts/verify-meeting-rename.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9521';
const profile = path.join(os.tmpdir(), `knodo-mt-rename-${Date.now()}`);
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
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 交给系统清理 */ }
}

async function listPages() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) return list.filter((t) => t.type === 'page');
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
  const consoleErrors = [];
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      consoleErrors.push((d && d.exception && d.exception.description) || (d && d.text) || '未知异常');
      return;
    }
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
  await send('Runtime.enable', {}).catch(() => {});
  return {
    evaluate: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || '渲染层表达式异常');
      }
      return r && r.result ? r.result.value : undefined;
    },
    consoleErrors,
    close: () => ws.close(),
  };
}

(async () => {
  const fail = (msg, extra) => {
    console.log(`[MT-RENAME] FAIL：${msg}`);
    if (extra) console.log(`[MT-RENAME] ${JSON.stringify(extra)}`);
    killChild();
    process.exit(1);
  };

  try {
    await listPages();
    const pages = await listPages();
    const mainPage = pages.find((t) => /index\.html/.test(t.url));
    if (!mainPage) throw new Error('没找到主窗口页面');
    const main = await connect(mainPage.webSocketDebuggerUrl);
    await sleep(1400);

    const out = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const info = await window.api.env.getStorageInfo();
      if (!/knodo-mt-rename-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));

      // 造一条会议记录：不需要真实音频，finalize 允许零分片
      const s = await window.api.rec.startSession();
      const mtg = await window.api.rec.finalize({ sessionId: s.sessionId, title: '重命名用例会议', mode: 'audio', durationMs: 123000 });
      if (!mtg || !mtg.id) throw new Error('造会议记录失败：' + JSON.stringify(mtg));

      // 取证：渲染层到底支不支持 prompt
      let promptProbe = '';
      try {
        const r = await Promise.resolve(window.prompt('probe', 'x'));
        promptProbe = 'returned:' + String(r);
      } catch (e) { promptProbe = 'threw:' + (e && e.message ? e.message : e); }

      document.querySelector('.nav-item[data-view="meetings"]').click();
      await wait(900);

      const btn = document.querySelector('[data-mt="rename"]');
      if (!btn) throw new Error('右栏没有渲染出「重命名」按钮');
      btn.click();
      await wait(600);

      const mask = document.querySelector('.modal-mask');
      const input = mask ? mask.querySelector('.modal-input') : null;
      const dialogShown = !!input;

      if (input) {
        input.value = '重命名后的会议';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const ok = mask.querySelector('[data-modal="ok"]');
        if (!ok) throw new Error('重命名弹窗没有确认按钮');
        ok.click();
        await wait(1000);
      }

      const list = await window.api.meeting.list();
      const saved = list.find((x) => x.id === mtg.id) || null;
      const detailTitle = document.querySelector('.mt-detail-title');
      const itemTitle = document.querySelector('.mt-item.active .mt-item-title');
      return {
        promptProbe,
        dialogShown,
        savedTitle: saved ? saved.title : null,
        detailTitle: detailTitle ? detailTitle.textContent.trim() : null,
        itemTitle: itemTitle ? itemTitle.textContent.trim() : null,
        maskGone: !document.querySelector('.modal-mask'),
        meetingId: mtg.id,
      };
    })()`);

    console.log(`[MT-RENAME] prompt 探测：${out.promptProbe}`);
    console.log(`[MT-RENAME] 点击后弹出对话框：${out.dialogShown}`);
    console.log(`[MT-RENAME] 落库标题：${JSON.stringify(out.savedTitle)}`);
    console.log(`[MT-RENAME] 右栏标题：${JSON.stringify(out.detailTitle)}`);

    const problems = [];
    if (!out.dialogShown) problems.push(`点「重命名」没有弹出输入对话框（prompt 探测 ${out.promptProbe}）`);
    if (out.savedTitle !== '重命名后的会议') problems.push(`标题没有真正保存，库里是 ${JSON.stringify(out.savedTitle)}`);
    if (out.detailTitle !== '重命名后的会议') problems.push(`右栏大标题没有刷新，仍是 ${JSON.stringify(out.detailTitle)}`);
    if (out.itemTitle !== '重命名后的会议') problems.push(`左栏列表项没有刷新，仍是 ${JSON.stringify(out.itemTitle)}`);
    if (!out.maskGone) problems.push('确认后弹窗没有关闭');
    if (main.consoleErrors.length) problems.push(`渲染层有未捕获异常：${main.consoleErrors.join(' | ')}`);

    main.close();
    if (problems.length) fail(problems.join('；'), out);
    console.log('[MT-RENAME] PASS：重命名可用，标题已落库并同步到左右栏');
    killChild();
    process.exit(0);
  } catch (e) {
    if (childLog) console.log(`[MT-RENAME] 主进程日志：\n${childLog.slice(-2000)}`);
    fail(`${e && e.message ? e.message : e}`);
  }
})();
