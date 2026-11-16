'use strict';
/**
 * 代码块内粘贴的端到端验证（真实 Electron 窗口 + CDP，独立临时 userData）。
 *
 * 用法：node scripts/verify-code-paste.js [port]        或   npm run verify:code-paste
 *
 * 守的是 v2.x 的 bug：任务描述 / 笔记里往代码块粘贴，内容会被
 * normaliseInsertionPoint() 挪到代码块外面变成段落 —— 表现为「代码复制粘贴不进去」。
 *
 * 覆盖：
 *  1. 笔记编辑态：光标在代码块内粘贴多行代码 → 进块、保换行、块外不多段落、pre 里没有 <p>；
 *  2. 粘贴带 ``` 的代码片段不弹「检测到 Markdown」浮层（代码块里不该问），
 *     且序列化时围栏自动加长，不出现围栏自我截断；
 *  3. 退出编辑后落库的 Markdown 代码完整、没被压成一行；
 *  4. 任务描述（mode:'html' 常驻编辑态）同样成立，落库 HTML 里代码没被拆成 <p>；
 *  5. 工具条新建空代码块后直接粘贴：占位 <br> 被清掉、三行代码原样落库；
 *  6. 代码块内选中一段再粘贴 → 替换选区而不是追加。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9591';
const profile = path.join(os.tmpdir(), `knodo-repro-paste-${Date.now()}`);
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

function killChild() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* 已退出 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

async function findPage() {
  for (let i = 0; i < 60; i += 1) {
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
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      events.push('EXCEPTION: ' + (d && d.text) + ' ' + JSON.stringify((d && d.exception && d.exception.description) || '').slice(0, 500));
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params && msg.params.entry;
      if (e && (e.level === 'error' || e.level === 'warning')) events.push('LOG: ' + String(e.text).slice(0, 400));
    }
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
    events,
    send,
    evaluate: (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    close: () => ws.close(),
  };
}

/* eslint-disable no-undef */
function probe() {
  return (async () => {
    const out = { checks: [], notes: [] };
    const ok = (name, cond, extra) => {
      out.checks.push({ name, pass: !!cond, extra: extra == null ? '' : String(extra).slice(0, 400) });
    };
    const note = (s) => out.notes.push(String(s).slice(0, 1200));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const BQ = String.fromCharCode(96);
    const FENCE = BQ.repeat(3);

    const info = await window.api.env.getStorageInfo();
    out.dataDir = info && info.dir;
    if (!/knodo-repro-paste-/.test(String(out.dataDir || ''))) throw new Error('数据目录未隔离：' + JSON.stringify(info));

    const md = ['开场段落', '', FENCE + 'js', 'const a = 1;', FENCE, '', '结尾段落'].join('\n');
    const created = await window.api.notes.create({ title: '代码块粘贴复现 ' + Date.now(), contentMd: md });
    out.noteId = created.id;

    document.querySelector('.nav-item[data-view="notes"]').click();
    await wait(1400);
    const item = document.querySelector('.nt-item[data-id="' + created.id + '"]');
    ok('笔记出现在列表', !!item);
    if (!item) return out;
    item.click();
    await wait(900);
    const pane = document.querySelector('.nt-dp');
    const doc = document.querySelector('#nt-preview');
    if (!pane || !doc) return out;
    pane.querySelector('[data-nt-act="mode"]').click();  // 进编辑
    await wait(400);
    ok('笔记进入编辑态', doc.getAttribute('contenteditable') === 'true', doc.getAttribute('contenteditable'));

    const shell = doc.querySelector('.md-code');
    const codeEl = shell && shell.querySelector('pre code');
    ok('找到代码块', !!shell && !!codeEl);

    /* --- 场景 1：光标落在代码块里，粘贴两行纯代码（不含 Markdown 特征） --- */
    const caretToCodeEnd = () => {
      doc.focus();
      const r = document.createRange();
      r.selectNodeContents(codeEl);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    };
    const firePaste = (text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      codeEl.dispatchEvent(ev);
      return ev;
    };
    caretToCodeEnd();
    const ev1 = firePaste('const b = 2;\nconst c = 3;');
    await wait(400);
    out.scene1 = {
      prevented: ev1.defaultPrevented,
      codeText: codeEl.textContent,
      shellHtml: shell.outerHTML,
      afterShell: shell.nextElementSibling ? shell.nextElementSibling.outerHTML.slice(0, 300) : '(无)',
      pInsidePre: !!shell.querySelector('pre p'),
      overlay: !!document.querySelector('.nt-overlay'),
    };
    ok('【笔记】代码块内粘贴：内容进了代码块', /const b = 2;/.test(codeEl.textContent), codeEl.textContent);
    ok('【笔记】代码块内粘贴：代码块外没多出段落', !shell.nextElementSibling, shell.nextElementSibling && shell.nextElementSibling.outerHTML.slice(0, 160));
    ok('【笔记】代码块内粘贴：pre 里没有 <p>', !shell.querySelector('pre p'), shell.querySelector('pre p') && shell.querySelector('pre p').outerHTML);
    note('scene1 shell=' + shell.outerHTML);

    /* --- 场景 2：粘贴「看起来像 Markdown」的代码（用户复制一段带 ``` 的片段） --- */
    caretToCodeEnd();
    const ev2 = firePaste(FENCE + 'python\nprint(1)\n' + FENCE);
    await wait(400);
    const overlay2 = document.querySelector('.nt-overlay');
    out.scene2 = { overlayTitle: overlay2 ? overlay2.textContent.trim().slice(0, 80) : '(无浮层)', codeText: codeEl.textContent };
    ok('【笔记】代码块内粘贴带围栏的代码不弹 Markdown 提示', !overlay2, out.scene2.overlayTitle);
    if (overlay2) {
      // 关掉浮层，别影响后续
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await wait(300);
    }

    /* --- 场景 3：粘贴后退出编辑，看落库的 Markdown 是否把代码写坏 --- */
    const stateBefore = { code: codeEl.textContent };
    pane.querySelector('[data-nt-act="mode"]').click();
    await wait(1600);
    const saved = await window.api.notes.get(created.id);
    out.savedMd = saved.content_md;
    ok('【笔记】落库 Markdown 里代码块内容完整', /const b = 2;/.test(saved.content_md) && /const a = 1;/.test(saved.content_md), saved.content_md);
    ok('【笔记】落库后代码块仍是围栏代码块', (saved.content_md.match(/```/g) || []).length >= 2, out.savedMd);
    ok('【笔记】代码没被压成一行', !/const a = 1; const b = 2;/.test(saved.content_md), out.savedMd);
    // 场景 2 把 ``` 围栏本身粘进了代码块：序列化必须自动加长围栏，
    // 否则重新打开这篇笔记时代码块会被自己的围栏截断
    ok('【笔记】代码含 ``` 时围栏自动加长', /^````js$/m.test(saved.content_md), out.savedMd);
    note('落库前 code=' + stateBefore.code);
    note('落库后 md=\n' + out.savedMd);

    /* --- 场景 4：任务描述（html 模式，常驻编辑态） --- */
    const today = (() => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    })();
    const legacy = '<p>描述开场</p><pre><code class="language-js">const a = 1;</code></pre><p>描述结尾</p>';
    const task = await window.api.tasks.create({ title: '代码块粘贴复现任务 ' + Date.now(), notes: legacy, planStart: today, planEnd: today });
    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(900);
    const taskItem = document.querySelector('.task-item[data-id="' + task.id + '"]');
    ok('任务出现在列表', !!taskItem);
    if (taskItem) taskItem.click();
    await wait(900);
    const drawer = document.getElementById('detail-drawer');
    const editor = drawer && drawer.querySelector('.detail-notes-editor');
    ok('描述编辑器存在且可写', !!editor && editor.getAttribute('contenteditable') === 'true');
    if (editor) {
      const dShell = editor.querySelector('.md-code');
      const dCode = dShell && dShell.querySelector('pre code');
      ok('描述里代码块有外壳', !!dShell && !!dCode, dShell && dShell.outerHTML.slice(0, 200));
      out.descHighlightSpans = dCode ? dCode.querySelectorAll('span').length : -1;
      const put = () => {
        editor.focus();
        const r = document.createRange();
        r.selectNodeContents(dCode);
        r.collapse(false);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      };
      const pasteInto = (text) => {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        dCode.dispatchEvent(ev);
        return ev;
      };
      put();
      const ev3 = pasteInto('const b = 2;\nconst c = 3;');
      await wait(400);
      out.scene4 = {
        prevented: ev3.defaultPrevented,
        codeText: dCode.textContent,
        shellHtml: dShell.outerHTML,
        afterShell: dShell.nextElementSibling ? dShell.nextElementSibling.outerHTML.slice(0, 300) : '(无)',
        pInsidePre: !!dShell.querySelector('pre p'),
        spans: dCode.querySelectorAll('span').length,
      };
      ok('【描述】代码块内粘贴：内容进了代码块', /const b = 2;/.test(dCode.textContent), dCode.textContent);
      ok('【描述】代码块内粘贴：粘贴内容没掉到代码块外', !/const b = 2/.test(dShell.nextElementSibling?.textContent || ''), out.scene4.afterShell);
      ok('【描述】代码块里没有 highlight span 残留', dCode.querySelectorAll('span').length === 0, out.scene4.spans);
      note('scene4 shell=' + dShell.outerHTML);

      // 直接键盘输入（不是粘贴）也要能连续写进代码块
      put();
      document.execCommand('insertText', false, 'let x = 9;');
      await wait(200);
      ok('【描述】代码块内可直接输入', /let x = 9;/.test(dCode.textContent), dCode.textContent);

      await wait(1600);
      const savedTask = await window.api.tasks.get(task.id);
      out.savedNotes = (savedTask.notes || '').slice(0, 800);
      ok('【描述】落库 HTML 里代码完整', /const b = 2;/.test(savedTask.notes || ''), out.savedNotes);
      ok('【描述】落库 HTML 没有把代码拆成 <p>', !/<pre[^>]*><code[^>]*><p/i.test(savedTask.notes || ''), out.savedNotes);
      ok('【描述】落库 HTML 没有 highlight span', !/hljs-/.test(savedTask.notes || ''), out.savedNotes);
    }
    /* --- 场景 5：新建代码块后立刻粘贴（最常见的入口：工具条插块 → Ctrl+V） --- */
    const created2 = await window.api.notes.create({ title: '空代码块粘贴 ' + Date.now(), contentMd: '普通段落' });
    document.querySelector('.nav-item[data-view="notes"]').click();
    await wait(1200);
    const item2 = document.querySelector('.nt-item[data-id="' + created2.id + '"]');
    if (item2) item2.click();
    await wait(800);
    const pane2 = document.querySelector('.nt-dp');
    const doc2 = document.querySelector('#nt-preview');
    pane2.querySelector('[data-nt-act="mode"]').click();
    await wait(400);
    // 工具条：插入代码块 → 选 js（光标自动落进空代码区）
    document.querySelector('[data-nt-cmd="code"]').click();
    await wait(250);
    document.querySelector('.nt-overlay [data-ov-lang="js"]')?.click();
    await wait(350);
    const emptyShell = doc2.querySelector('.md-code');
    const emptyCode = emptyShell && emptyShell.querySelector('pre code');
    ok('新建空代码块存在且带占位 <br>', !!emptyCode && !emptyCode.textContent, emptyCode && emptyCode.innerHTML);
    const dt5 = new DataTransfer();
    dt5.setData('text/plain', 'function f() {\n  return 1;\n}');
    emptyCode?.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt5 }));
    await wait(400);
    ok('【笔记】空代码块粘贴：内容进块且占位符已清', !!emptyCode && /return 1;/.test(emptyCode.textContent), emptyCode && emptyCode.textContent);
    ok('【笔记】空代码块粘贴：没有残留占位 br',
      !!emptyCode && !(emptyCode.children.length === 1 && emptyCode.firstElementChild.tagName === 'BR'),
      emptyCode && emptyCode.innerHTML);
    ok('【笔记】空代码块粘贴：换行保留', !!emptyCode && emptyCode.textContent.split('\n').length === 3, emptyCode && JSON.stringify(emptyCode.textContent));

    // 代码块内选中一段再粘贴 → 应替换选区，而不是追加
    const selectInCode = (el, needle) => {
      const t = el.firstChild;
      if (!t) return false;
      const i = String(t.nodeValue).indexOf(needle);
      if (i < 0) return false;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + needle.length);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return true;
    };
    ok('代码块内可选中片段', selectInCode(emptyCode, 'return 1;'));
    const dt6 = new DataTransfer();
    dt6.setData('text/plain', 'return 42;');
    emptyCode.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt6 }));
    await wait(300);
    ok('【笔记】选中替换：旧片段被替换', !!emptyCode && !/return 1;/.test(emptyCode.textContent) && /return 42;/.test(emptyCode.textContent), emptyCode && emptyCode.textContent);

    pane2.querySelector('[data-nt-act="mode"]').click();
    await wait(1500);
    const saved2 = await window.api.notes.get(created2.id);
    out.savedMd2 = saved2.content_md;
    ok('【笔记】空代码块粘贴后落库为围栏代码块', /```js/.test(saved2.content_md || ''), out.savedMd2);
    ok('【笔记】落库保留三行代码', (String(saved2.content_md || '').match(/\n/g) || []).length >= 4, JSON.stringify(out.savedMd2));

    return out;
  })();
}
/* eslint-enable no-undef */

(async () => {
  let ws;
  try {
    const wsUrl = await findPage();
    ws = await connect(wsUrl);
    await ws.send('Runtime.enable');
    await ws.send('Log.enable');
    await ws.send('Page.enable');
    await ws.send('Page.reload', { ignoreCache: true });
    await sleep(3200);
    const res = await ws.evaluate(`(${probe.toString()})()`);
    if (ws.events.length) console.log('页面异常：\n' + ws.events.slice(0, 12).join('\n'));
    if (res.exceptionDetails) {
      console.error('探针异常：', JSON.stringify(res.exceptionDetails, null, 2));
      process.exitCode = 1;
      return;
    }
    const out = res.result && res.result.value;
    if (!out) { console.error('探针没有返回数据：', JSON.stringify(res)); process.exitCode = 1; return; }
    const checks = out.checks || [];
    checks.forEach((c) => console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.extra ? '  → ' + c.extra : ''}`));
    console.log('\n---- 现场 ----');
    console.log('scene1 = ' + JSON.stringify(out.scene1, null, 1));
    console.log('scene2 = ' + JSON.stringify(out.scene2, null, 1));
    console.log('scene4 = ' + JSON.stringify(out.scene4, null, 1));
    console.log('descHighlightSpans = ' + out.descHighlightSpans);
    (out.notes || []).forEach((n) => console.log('\n' + n));
    const failed = checks.filter((c) => !c.pass);
    console.log(`\n结果：${checks.length - failed.length} 通过 / ${failed.length} 失败`);
    if (failed.length) process.exitCode = 1;
  } catch (e) {
    console.error('复现脚本失败：', e && e.stack ? e.stack : e);
    console.error('Electron 日志（尾部）：\n' + childLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    if (ws) ws.close();
    killChild();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
