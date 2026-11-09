'use strict';
/**
 * 任务详情「描述」所见即所得 + Markdown 粘贴转换的端到端验证（真实 Electron 窗口 + CDP）。
 *
 * 用法：node scripts/verify-detail-notes.js [port] [--shot]
 *
 * 覆盖：
 *  1. 描述区带工具条、常驻编辑态（contenteditable=true）、样式与笔记一致；
 *  2. 工具条加粗 / 标题真的生效，且自动保存把格式化后的 HTML 写进 tasks.notes；
 *  3. 只改标题不会把描述清空（老回归点）；
 *  4. 代码块语言标签可点换语言，换完落库保留 language-xxx；
 *  5. 粘贴 Markdown → 弹「是否转换」提示 → 转换后渲染成富文本（不暴露 ** / ## 标记）；
 *  6. 提示浮层被 Esc 关掉时按「保持原文」落文本，内容不会丢；
 *  7. Esc 仍能关闭详情抽屉（不被编辑器的快捷键吞掉）；
 *  8. 笔记编辑器同样支持粘贴 Markdown 转换（沿用同一份识别逻辑）。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9464';
const profile = path.join(os.tmpdir(), `knodo-dnotes-${Date.now()}`);
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
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
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
      events.push('EXCEPTION: ' + (d && d.text) + ' ' + JSON.stringify(d && d.exception && d.exception.description || '').slice(0, 500));
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params && msg.params.entry;
      if (e && (e.level === 'error' || e.level === 'warning')) events.push('LOG: ' + String(e.text).slice(0, 400));
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const a = msg.params;
      if (a && a.type === 'error') events.push('CONSOLE: ' + (a.args || []).map((x) => x.value || x.description || '').join(' ').slice(0, 400));
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
    evaluate: (expression) => send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }),
    close: () => ws.close(),
  };
}

/* eslint-disable no-undef */
function probe() {
  return (async () => {
    const out = { checks: [] };
    const ok = (name, cond, extra) => {
      out.checks.push({ name, pass: !!cond, extra: extra == null ? '' : String(extra).slice(0, 240) });
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const info = await window.api.env.getStorageInfo();
    out.dataDir = info && info.dir;
    if (!/knodo-dnotes-/.test(String(out.dataDir || '') + JSON.stringify(info || {}))) {
      throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
    }

    const today = (() => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    })();

    const legacyNotes = '<p>原始描述内容</p>'
      + '<pre><code class="language-js">const a = 1;</code></pre>';
    const task = await window.api.tasks.create({
      title: '描述工具条验证 ' + Date.now(), notes: legacyNotes, planStart: today, planEnd: today,
    });
    out.taskId = task && task.id;

    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(700);
    const item = document.querySelector('.task-item[data-id="' + task.id + '"]');
    ok('任务出现在列表', !!item);
    if (item) item.click();
    await wait(800);

    const drawer = document.getElementById('detail-drawer');
    const wrap = drawer && drawer.querySelector('.detail-notes-wrap');
    const bar = drawer && drawer.querySelector('.detail-notes-wrap [data-nt-toolbar]');
    const editor = drawer && drawer.querySelector('.detail-notes-editor');

    /* ---- 1. 工具条 + 常驻编辑态 ---- */
    ok('描述区有工具条容器', !!wrap);
    ok('工具条节点存在', !!bar);
    ok('工具条可见（无需点编辑）', !!bar && bar.hidden === false);
    ok('工具条按钮数量 > 10', !!bar && bar.querySelectorAll('[data-nt-cmd]').length > 10,
      bar && bar.querySelectorAll('[data-nt-cmd]').length);
    ok('描述是常驻编辑态', !!editor && editor.getAttribute('contenteditable') === 'true',
      editor && editor.getAttribute('contenteditable'));
    ok('描述回填了原内容', !!editor && editor.textContent.indexOf('原始描述内容') > -1);
    ok('代码块被包成 .md-code 外壳', !!editor && !!editor.querySelector('.md-code .md-code-lang'));
    ok('代码块外壳带 js 标签', !!editor && (editor.querySelector('.md-code-lang') || {}).textContent === 'js',
      editor && (editor.querySelector('.md-code-lang') || {}).textContent);
    ok('工具条在编辑区上方（同一包裹内）', !!wrap && wrap.firstElementChild === bar);

    const styleOf = () => {
      const ed = document.querySelector('.detail-notes-editor');
      const p = ed && ed.querySelector('p');
      const c = ed && getComputedStyle(ed);
      const d = p && getComputedStyle(p);
      return [c && c.fontSize, c && c.borderRadius, d && d.fontSize, d && d.marginTop].join('|');
    };
    const style0 = styleOf();

    /* ---- 2. 工具条加粗 + 自动保存 ---- */
    const para = editor.querySelector('p');
    const selectNode = (el) => {
      if (!el) return false;
      editor.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return true;
    };
    ok('找到普通段落', !!para);
    selectNode(para);
    bar.querySelector('[data-nt-cmd="bold"]').click();
    await wait(150);
    ok('工具条加粗生效', !!editor.querySelector('strong, b'), editor.innerHTML.slice(0, 200));

    // 标题：工具栏 H2 作用在代码块前的段落上
    selectNode(editor.querySelector('p'));
    bar.querySelector('[data-nt-cmd="h2"]').click();
    await wait(150);
    ok('工具条 H2 生效', !!editor.querySelector('h2'), editor.innerHTML.slice(0, 200));

    await wait(1400);
    const saved1 = await window.api.tasks.get(task.id);
    out.saved1 = (saved1.notes || '').slice(0, 400);
    ok('自动保存写入加粗', /<(strong|b)>/i.test(saved1.notes || ''), out.saved1);
    ok('自动保存写入标题', /<h2/i.test(saved1.notes || ''), out.saved1);
    ok('自动保存未丢原内容', (saved1.notes || '').indexOf('原始描述内容') > -1);
    ok('自动保存未残留 contenteditable', (saved1.notes || '').indexOf('contenteditable') === -1, out.saved1);

    /* ---- 3. 只改标题不清空描述 ---- */
    const titleEl = drawer.querySelector('.detail-title');
    titleEl.value = '描述工具条验证（改过标题）';
    titleEl.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(1500);
    const saved2 = await window.api.tasks.get(task.id);
    ok('改标题后描述仍在', (saved2.notes || '').indexOf('原始描述内容') > -1, (saved2.notes || '').slice(0, 160));
    ok('标题已保存', saved2.title.indexOf('改过标题') > -1);

    /* ---- 4. 代码块换语言 ---- */
    const langChip = editor.querySelector('.md-code-lang');
    langChip.click();
    await wait(200);
    const langBox = document.querySelector('.nt-overlay .nt-lang-grid');
    ok('点语言标签弹出语言浮层', !!langBox);
    if (langBox) {
      ok('浮层覆盖描述区（挂在 body 上）', document.querySelector('.nt-overlay').parentElement === document.body);
      langBox.querySelector('[data-ov-lang="python"]').click();
      await wait(250);
    }
    ok('代码块语言已改成 python', (editor.querySelector('.md-code-lang') || {}).textContent === 'python',
      (editor.querySelector('.md-code-lang') || {}).textContent);
    await wait(1200);
    const saved3 = await window.api.tasks.get(task.id);
    ok('换语言后落库保留 language-python', /language-python/.test(saved3.notes || ''), (saved3.notes || '').slice(0, 300));

    /* ---- 5. 粘贴 Markdown → 提示 → 转换 ---- */
    const putCaretAtEnd = (el) => {
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    };
    const pasteText = (el, text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));
    };

    const md = ['## 小标题', '', '这是 **加粗** 与 `行内代码`。', '', '- 列表 A', '- 列表 B'].join('\n');
    putCaretAtEnd(editor);
    pasteText(editor, md);
    await wait(250);
    const ask = document.querySelector('.nt-overlay');
    ok('粘贴 Markdown 弹出转换提示', !!ask && /Markdown/.test(ask.textContent || ''), ask && ask.textContent.slice(0, 80));
    ok('提示有两个选项', !!ask && !!ask.querySelector('[data-ov-act="md"]') && !!ask.querySelector('[data-ov-act="raw"]'));
    ok('未确认前不写入内容', editor.innerText.indexOf('小标题') === -1);
    if (ask) ask.querySelector('[data-ov-act="md"]').click();
    await wait(300);
    ok('转换后提示关闭', !document.querySelector('.nt-overlay'));
    const plain1 = editor.innerText;
    out.converted = editor.innerHTML.slice(-600);
    ok('转换出二级标题', !!editor.querySelector('h2'));
    ok('转换出加粗', !!editor.querySelector('strong, b'));
    ok('转换出无序列表', !!editor.querySelector('ul li'));
    ok('转换后不暴露 ** 标记', plain1.indexOf('**') === -1, plain1.slice(-120));
    ok('转换后不暴露 ## 标记', !/^##\s/m.test(plain1));
    await wait(1400);
    const saved4 = await window.api.tasks.get(task.id);
    out.saved4 = (saved4.notes || '').slice(-420);
    ok('转换结果自动落库（含 <h2>）', /<h2/i.test(saved4.notes || ''), out.saved4);
    ok('转换结果自动落库（含列表）', /<ul|<li/i.test(saved4.notes || ''), out.saved4);

    /* ---- 6. 提示被 Esc 关掉 → 保持原文，不丢内容 ---- */
    const md2 = '# 只保留原文\n\n- 一条\n- 两条';
    putCaretAtEnd(editor);
    pasteText(editor, md2);
    await wait(220);
    ok('第二次粘贴同样弹提示', !!document.querySelector('.nt-overlay'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(320);
    ok('Esc 关掉提示浮层', !document.querySelector('.nt-overlay'));
    ok('Esc 后原文已落进正文（不丢内容）', editor.innerText.indexOf('只保留原文') > -1,
      editor.innerText.slice(-120));
    ok('详情抽屉未被这次 Esc 关掉', drawer.hidden === false);
    await wait(1300);
    const saved5 = await window.api.tasks.get(task.id);
    ok('保持原文也自动落库', (saved5.notes || '').indexOf('只保留原文') > -1);

    /* ---- 7. Esc 关闭抽屉仍可用 ---- */
    editor.focus();
    const escEv = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    editor.dispatchEvent(escEv);
    await wait(400);
    ok('编辑器内按 Esc 关闭抽屉', drawer.hidden === true, 'hidden=' + drawer.hidden);

    /* ---- 8. 重开任务：工具条与格式都在 ---- */
    document.querySelector('.nav-item[data-view="all"]').click();
    await wait(600);
    const item2 = document.querySelector('.task-item[data-id="' + task.id + '"]');
    if (item2) item2.click();
    await wait(800);
    const bar2 = document.querySelector('.detail-notes-wrap [data-nt-toolbar]');
    const editor2 = document.querySelector('.detail-notes-editor');
    ok('重开仍有工具条且可见', !!bar2 && bar2.hidden === false);
    ok('重开仍是编辑态', !!editor2 && editor2.getAttribute('contenteditable') === 'true');
    ok('重开保留标题格式', !!editor2 && !!editor2.querySelector('h2'));
    ok('重开保留代码块语言标签', !!editor2 && /python/.test((editor2.querySelector('.md-code-lang') || {}).textContent || ''));
    ok('重开描述样式未变', styleOf() === style0, 'now=' + styleOf() + ' before=' + style0);
    const closeBtn = document.querySelector('.detail-close');
    if (closeBtn) closeBtn.click();
    await wait(300);

    /* ---- 9. 笔记：粘贴 Markdown 也能提示转换 ---- */
    const note = await window.api.notes.create({ title: 'MD 粘贴验证 ' + Date.now(), contentMd: '开头一段。' });
    out.noteId = note && note.id;
    document.querySelector('.nav-item[data-view="notes"]').click();
    await wait(1200);
    const ntItem = document.querySelector('.nt-item[data-id="' + note.id + '"]');
    ok('笔记出现在列表', !!ntItem);
    if (ntItem) ntItem.click();
    await wait(700);
    const pane = document.querySelector('.nt-dp');
    if (pane) pane.querySelector('[data-nt-act="mode"]').click();
    await wait(400);
    const ntDoc = document.querySelector('#nt-preview');
    ok('笔记进入编辑态', !!ntDoc && ntDoc.getAttribute('contenteditable') === 'true');
    if (ntDoc) {
      putCaretAtEnd(ntDoc);
      pasteText(ntDoc, '## 笔记内标题\n\n- 甲\n- 乙');
      await wait(260);
      const ask2 = document.querySelector('.nt-overlay');
      ok('笔记粘贴 Markdown 也弹提示', !!ask2 && /Markdown/.test(ask2.textContent || ''),
        ask2 && ask2.textContent.slice(0, 60));
      if (ask2) ask2.querySelector('[data-ov-act="md"]').click();
      await wait(320);
      ok('笔记转换出 h2', !!ntDoc.querySelector('h2'));
      ok('笔记转换不暴露 ## 标记', !/^##\s/m.test(ntDoc.innerText));
      // 退出编辑 → 序列化回 Markdown 并落库
      const p2 = document.querySelector('.nt-dp');
      if (p2) p2.querySelector('[data-nt-act="mode"]').click();
      await wait(1600);
      const savedNote = await window.api.notes.get(note.id);
      out.savedNote = (savedNote.content_md || '').slice(0, 300);
      ok('笔记落库为 Markdown 标题', /^##\s/m.test(savedNote.content_md || ''), out.savedNote);
      ok('笔记落库含列表', /^-\s/m.test(savedNote.content_md || ''), out.savedNote);
    }

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
    const alive = await ws.evaluate('1+1');
    if (!alive || alive.result?.value !== 2) throw new Error('渲染进程无响应');

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
    const failed = checks.filter((c) => !c.pass);
    checks.forEach((c) => console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.extra ? '  → ' + c.extra : ''}`));
    console.log(`\n数据目录：${out.dataDir}`);
    console.log(`落库（加粗/标题）：${out.saved1 || ''}`);
    console.log(`转换后 DOM：${out.converted || ''}`);
    console.log(`落库（转换后）：${out.saved4 || ''}`);
    console.log(`笔记落库：${out.savedNote || ''}`);
    console.log(`\n结果：${checks.length - failed.length} 通过 / ${failed.length} 失败`);
    if (failed.length) {
      console.log('未通过项：' + failed.map((c) => c.name).join('、'));
      process.exitCode = 1;
    }

    if (process.argv.includes('--shot')) {
      await ws.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      await ws.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('.nav-item[data-view="all"]').click();
        await wait(700);
        const it = document.querySelector('.task-item[data-id="${out.taskId}"]');
        if (it) it.click();
        await wait(800);
        return true;
      })()`);
      const shot = await ws.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const shotPath = path.join(os.tmpdir(), 'knodo-detail-notes.png');
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      console.log('详情描述截图：' + shotPath);
    }
  } catch (e) {
    console.error('验证失败：', e && e.stack ? e.stack : e);
    console.error('Electron 日志（尾部）：\n' + childLog.slice(-2500));
    process.exitCode = 1;
  } finally {
    if (ws) ws.close();
    killChild();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
