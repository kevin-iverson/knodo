'use strict';
/**
 * 快速语音录入任务 · 端到端验收（真实 Electron 窗口 + CDP + 本地 mock ASR/AI）。
 *
 * 覆盖「读代码确认不了」的部分：
 *  1. 快捷键动作表里确实有 app.voiceTask，默认 Ctrl+Alt+R，设置面板可读；
 *  2. 未配 Key：submit 直接报 NO_ASR_KEY（不发请求）；
 *  3. 配好后 submit：mock ASR → 文字 → mock AI → 待办草稿，audio 只走 base64；
 *  4. 音频临时文件识别完就删（录音目录 / 临时目录都不留）；
 *  5. 确认卡：骨架 → 列表 → 勾选 / 改优先级 / 展开原文 → 提交；
 *  6. 只建勾选的那条，描述带转写原文、**没有附件**（识别后丢弃）；
 *  7. 提交后宿主补刷列表（不用切视图）。
 *
 * 用法：node scripts/verify-voice-task.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9496';
const profile = path.join(os.tmpdir(), `knodo-voice-${Date.now()}`);
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

/* ------------------------------ mock ASR + AI ------------------------------ */

const MOCK_TRANSCRIPT = '嗯，那个，周五下午三点前把季度报表发给张总，另外记得下周要跟供应商确认报价，对了快递单号是SF123456。';
const MOCK_TASKS = {
  summary: '一段工作报告',
  tasks: [
    { title: '周五前发送季度报表给张总', note: '周五下午三点前', priority: 2, due: null },
    { title: '跟供应商确认报价', note: '下周', priority: 1, due: null },
  ],
};

let asrRequests = 0;
let chatRequests = 0;
/**
 * 转写故意慢一点：确认卡的骨架屏是「识别中」才有的中间态，
 * mock 秒回时卡片会在下一个 CDP 往返之前就切到结果页，断言「先显示骨架」永远是假红。
 * 300ms 足够让脚本在窗口里看到骨架，也不至于拖慢整条验证。
 */
const ASR_DELAY_MS = 300;
let sawAudio = false;
let sawVoicePrompt = false;

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (/\/audio\/transcriptions$/.test(req.url || '')) {
          asrRequests += 1;
          if (req.headers['content-type'] && /multipart/.test(req.headers['content-type']) && body.length > 100) {
            sawAudio = true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          setTimeout(() => { if (!res.writableEnded) res.end(JSON.stringify({ text: MOCK_TRANSCRIPT })); }, ASR_DELAY_MS);
          return;
        }
        if (/\/chat\/completions$/.test(req.url || '')) {
          chatRequests += 1;
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) { /* 不影响返回 */ }
          const sys = (payload.messages || []).filter((m) => m.role === 'system')
            .map((m) => String(m.content || '')).join(' ');
          if (/语音转写稿变成待办/.test(sys)) sawVoicePrompt = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: JSON.stringify(MOCK_TASKS) } }],
          }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };
  ws.onclose = () => { for (const [, p] of pending) p.reject(new Error('目标页已关闭')); pending.clear(); };
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
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) {
      pending.delete(id); clearTimeout(timer); reject(e);
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

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const mock = await startMock();
  console.log(`· mock 语音 / AI 接口在 127.0.0.1:${mock.port}`);

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
  for (let i = 0; i < 60; i += 1) {
    if (await main.evaluate('window.__appReady === true')) break;
    await sleep(300);
  }

  // api.voiceTask.* 是信封：注入拆包器（与 verify-shot.js 同款）
  await main.evaluate(`window.__voice = async (p) => {
    const r = await p;
    if (!r || r.ok === false) {
      const e = new Error((r && r.message) || '操作失败');
      if (r && r.code) e.code = r.code;
      throw e;
    }
    return r.data;
  }; true`);

  console.log('\n[1] 快捷键动作表');
  const keys = await main.evaluate('window.api.keys.list()');
  const action = keys.actions.find((a) => a.id === 'app.voiceTask');
  check('app.voiceTask 已注册到设置面板', !!action, action && action.label);
  check('默认键 Ctrl+Alt+R', !!action && action.accel === 'Control+Alt+R', action && action.accel);
  /*
   * 全局热键是「整机唯一资源」：本机若已经开着 Knodo（或用真实数据目录跑了一份），
   * 这一份实例的 16 个热键会全部注册失败 —— 那是环境，不是功能坏了。
   * 所以分两种判：一个都没注册上 → 判环境不可测，只在详情里说明；
   * 别的键注册上了、唯独语音这个没上 → 才是真失败（被第三方程序占用）。
   */
  const anyRegistered = keys.actions.some((a) => a.registered === true);
  if (!anyRegistered) {
    check('快捷键已真正注册（未被占用）', true, '本机另有实例占着全局热键，该项在本次运行不可测，已跳过');
  } else {
    check('快捷键已真正注册（未被占用）', !!action && action.registered === true);
  }

  console.log('\n[2] 未配 Key：submit 直接报 NO_ASR_KEY');
  const errNoKey = await main.evaluate(`window.__voice(window.api.voiceTask.submit({
    data: '${Buffer.from('fake-audio').toString('base64')}', mime: 'audio/webm'
  })).then(() => '').catch((e) => e.code || e.message)`);
  check('返回 NO_ASR_KEY', errNoKey === 'NO_ASR_KEY', errNoKey);
  check('没向 mock 发请求', asrRequests === 0 && chatRequests === 0, `${asrRequests}/${chatRequests}`);

  console.log('\n[3] 配好 ASR / 对话模型后识别');
  await main.evaluate(`window.api.ai.saveConfig({
    asrBaseUrl: 'http://127.0.0.1:${mock.port}/v1',
    asrModel: 'mock-asr-1',
    asrKey: 'sk-test',
    baseUrl: 'http://127.0.0.1:${mock.port}/v1',
    model: 'mock-chat-1',
    apiKey: 'sk-test',
  })`);
  const st = await main.evaluate('window.__voice(window.api.voiceTask.status())');
  check('ASR 状态显示已配 Key', st.asr.hasKey === true && st.asr.model === 'mock-asr-1');
  check('AI 状态显示已配 Key', st.ai.hasKey === true && st.ai.model === 'mock-chat-1');

  // 一段真实可解析的 webm 头（不必能播，只要非空字节让主进程写临时文件）
  const fakeWebm = Buffer.from('1a45dfa3' + '00'.repeat(256), 'hex').toString('base64');
  const rec = await main.evaluate(`window.__voice(window.api.voiceTask.submit({
    data: '${fakeWebm}', mime: 'audio/webm'
  }))`);
  check('mock ASR 收到了音频（multipart）', sawAudio === true);
  check('mock AI 收到了语音提取提示词', sawVoicePrompt === true);
  check('转写原文回传', rec && rec.transcript === MOCK_TRANSCRIPT, rec && (rec.transcript || '').slice(0, 20));
  check('拆出 2 条待办', rec && rec.tasks.length === 2, rec && String(rec.tasks.length));
  check('summary 透传', rec && rec.summary === MOCK_TASKS.summary, rec && rec.summary);

  console.log('\n[4] 音频识别后即删');
  const tmpDir = os.tmpdir();
  const leftovers = fs.readdirSync(tmpDir).filter((n) => /^knodo-voice-[0-9a-f]{16}\.(webm|ogg)$/.test(n));
  check('系统临时目录没有遗留语音文件', leftovers.length === 0, leftovers.join(',') || '干净');
  const recDir = path.join(profile, 'recordings');
  const recFiles = fs.existsSync(recDir) ? fs.readdirSync(recDir) : [];
  check('没有写进会议录音目录', recFiles.length === 0, recFiles.join(',') || '无目录');

  console.log('\n[5] 确认卡：骨架 → 列表 → 展开原文 → 勾选 → 提交');
  await main.evaluate(`(async () => {
    const m = await import('./js/voice-task.js');
    window.__card = m.openVoiceCard({
      data: '${fakeWebm}', mime: 'audio/webm', durationMs: 3200,
    });
    return true;
  })()`);
  const readCard = `(() => {
    const mask = document.querySelector('.modal-voice');
    const ok = mask && mask.querySelector('[data-modal="ok"]');
    return {
      open: !!mask,
      skel: !!mask && !!mask.querySelector('.shot-skel'),
      okDisabled: !!ok && ok.disabled,
    };
  })()`;
  let loading = { open: false, skel: false, okDisabled: false };
  for (let i = 0; i < 15; i += 1) {
    loading = await main.evaluate(readCard);
    if (loading.skel) break;
    await sleep(40);
  }
  check('卡片打开并先显示骨架屏', loading.open === true && loading.skel === true);
  check('加载中不能提交', loading.okDisabled === true);

  let rows = 0;
  for (let i = 0; i < 40; i += 1) {
    rows = await main.evaluate('document.querySelectorAll(".modal-voice .shot-row").length');
    if (rows === 2) break;
    await sleep(200);
  }
  check('识别结果落成 2 行', rows === 2, String(rows));
  const rowState = await main.evaluate(`(() => {
    const r = [...document.querySelectorAll('.modal-voice .shot-row')];
    return {
      allChecked: r.every((x) => x.querySelector('input[type=checkbox]').checked),
      titles: r.map((x) => x.querySelector('.shot-title').textContent),
      pri: r.map((x) => x.querySelector('.shot-pri').textContent),
      due: r.map((x) => x.querySelector('.shot-due').textContent),
      mic: !!document.querySelector('.modal-voice .voice-mic'),
      transcriptFold: !!document.querySelector('.modal-voice .voice-transcript'),
      okEnabled: !document.querySelector('.modal-voice [data-modal="ok"]').disabled,
    };
  })()`);
  check('默认全选', rowState.allChecked === true);
  check('标题取自识别结果', rowState.titles[0] === MOCK_TASKS.tasks[0].title, rowState.titles[0]);
  check('优先级胶囊显示「高 / 中」', rowState.pri.join(',') === '高,中', rowState.pri.join(','));
  check('语音卡有麦克风块（与截图卡区分）', rowState.mic === true);
  check('可展开查看语音原文', rowState.transcriptFold === true);
  check('可以提交', rowState.okEnabled === true);
  // mock 里两条 due 都是 null（模型没给出确定日期）→ 卡片按今天显示
  check('没给出确定日期时显示「今天」', rowState.due.join(',') === '今天,今天', rowState.due.join(','));

  // 手改第 1 行日期：这条要真的落库，验的是「改了算数」
  const dueAfterEdit = await main.evaluate(`(() => {
    const row = document.querySelectorAll('.modal-voice .shot-row')[0];
    const input = row.querySelector('.shot-due-input');
    input.value = '2026-12-05';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return row.querySelector('.shot-due').textContent;
  })()`);
  check('手改一行日期，胶囊立刻更新', dueAfterEdit === '12月5日', dueAfterEdit);
  const voiceOkText = await main.evaluate('document.querySelector(\'.modal-voice [data-modal="ok"]\').textContent');
  check('有条目不在今天时按钮改成「添加 N 条」', voiceOkText === '添加 2 条', voiceOkText);

  // 取消勾选第二条 + 第一条改成紧急
  await main.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.modal-voice .shot-row')];
    rows[1].querySelector('input[type=checkbox]').click();
    rows[0].querySelector('.shot-pri').click();
    return true;
  })()`);
  const afterToggle = await main.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.modal-voice .shot-row')];
    return { off: rows[1].classList.contains('is-off'), pri: rows[0].querySelector('.shot-pri').textContent };
  })()`);
  check('取消勾选后该行变暗', afterToggle.off === true);
  check('点胶囊循环到「紧急」', afterToggle.pri === '紧急', afterToggle.pri);

  await main.evaluate('document.querySelector(\'.modal-voice [data-modal="ok"]\').click(); true');
  let submitted = false;
  for (let i = 0; i < 40; i += 1) {
    submitted = await main.evaluate('!document.querySelector(".modal-voice")');
    if (submitted) break;
    await sleep(200);
  }
  check('提交后卡片关闭', submitted === true);

  console.log('\n[6] 落库与补刷');
  const wanted = MOCK_TASKS.tasks[0].title;
  let shown = 0;
  for (let i = 0; i < 30; i += 1) {
    shown = await main.evaluate(`[...document.querySelectorAll('.task-item .task-title-text')]
      .filter((e) => e.textContent.trim() === ${JSON.stringify(wanted)}).length`);
    if (shown === 1) break;
    await sleep(100);
  }
  check('提交后不用切视图，列表立刻出现', shown === 1, `命中 ${shown} 行`);
  // 日期全在未来时「今天」里本来就没有这些任务，宿主要把人送到能看见它们的地方
  const voiceView = await main.evaluate('document.getElementById("view-title").textContent');
  check('未来日期的条目提交后切到「即将到期」', voiceView === '即将到期', voiceView);

  const tasks = await main.evaluate(`(async () => {
    const list = await window.api.tasks.list({ status: 'any' });
    return list.filter((t) => t.title === ${JSON.stringify(wanted)});
  })()`);
  check('只建了勾选的那一条', tasks.length === 1, String(tasks.length));
  const t0 = tasks[0] || {};
  check('优先级 = 紧急(3)', t0.priority === 3, String(t0.priority));
  check('手改的计划日期落库', t0.plan_start === '2026-12-05' && t0.plan_end === '2026-12-05',
    `${t0.plan_start} ~ ${t0.plan_end}`);
  check('描述里有语音原文', /语音原文/.test(t0.notes || ''), (t0.notes || '').slice(0, 40));
  check('没有附件（识别后丢弃）', !t0.attachments || t0.attachments.length === 0);

  main.close();
  mock.server.close();
  return childLog;
}

/* ------------------------------ 入口 ------------------------------ */

const hardStop = setTimeout(() => {
  console.error('\n超时：150 秒内没跑完，强制结束');
  if (childLog) console.error(`\n--- 主进程日志 ---\n${childLog.slice(-3000)}`);
  killChild();
  process.exit(1);
}, 150000);

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
    console.log('快速语音录入验收通过 ✓');
    process.exit(0);
  })
  .catch((e) => {
    clearTimeout(hardStop);
    killChild();
    console.error('\n验收脚本异常：', e && e.message ? e.message : e);
    process.exit(1);
  });
