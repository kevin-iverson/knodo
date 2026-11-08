'use strict';
/**
 * 笔记所见即所得两态的端到端验证（真实 Electron 窗口 + CDP，独立临时 userData）。
 *
 * 用法：node scripts/verify-wysiwyg.js [port]
 *
 * 覆盖：
 *  1. 默认只读态：工具条隐藏、contenteditable=false、元数据只读、输入/删除/粘贴全被拦；
 *  2. 读态 / 编辑态都不出现 Markdown 原始标记（** / # / == / ``` / | --- |）；
 *  3. 「点编辑」后工具条出现、可写；切态不重渲（innerHTML 完全一致）；
 *  4. 工具条与快捷键插入加粗 / 标题 / 列表 / 链接 / 表格 / 代码块；
 *  5. 退出编辑自动隐藏工具条恢复只读、立即落库；
 *  6. 已有内容与自定义格式（颜色高亮 / 代码块 / 表格 / 链接）往返零丢失。
 *
 * 探针函数用 toString() 注入页面，避免 CDP 表达式里的反引号 / ${} 转义地狱。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9463';
const profile = path.join(os.tmpdir(), `knodo-wys-${Date.now()}`);
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
      out.checks.push({ name, pass: !!cond, extra: extra == null ? '' : String(extra).slice(0, 220) });
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const BQ = String.fromCharCode(96);
    const FENCE = BQ.repeat(3);

    const info = await window.api.env.getStorageInfo();
    out.dataDir = info && info.dir;
    if (!/knodo-wys-/.test(String(out.dataDir || '') + JSON.stringify(info || {}))) {
      throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
    }

    // 模拟一篇「已有笔记」：标准 Markdown + 项目自定义颜色语法 + 代码块 + 表格
    const md = [
      '# 标题一',
      '',
      '这是一段 **加粗** 与 *斜体*，还有 ==红字=={c:#e5484d} 和 [外链](https://example.com)。',
      '',
      '## 二级标题',
      '',
      '- 列表项 A',
      '- 列表项 B',
      '',
      '| 列A | 列B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      FENCE + 'js',
      'const a = 1;',
      FENCE,
    ].join('\n');
    const note = await window.api.notes.create({ title: 'WYS 探针 ' + Date.now(), contentMd: md });
    out.noteId = note && note.id;
    out.createdNote = JSON.stringify(note).slice(0, 300);

    document.querySelector('.nav-item[data-view="notes"]').click();
    await wait(1400);
    out.diag = {
      viewTitle: document.querySelector('#view-title') && document.querySelector('#view-title').textContent,
      viewHead: document.querySelector('#view') && document.querySelector('#view').innerHTML.slice(0, 400),
      itemCount: document.querySelectorAll('.nt-item').length,
      listRoot: !!document.querySelector('#nt-list'),
      apiList: JSON.stringify(await window.api.notes.list({})).slice(0, 300),
    };
    const item = document.querySelector('.nt-item[data-id="' + note.id + '"]');
    ok('列表出现新笔记', !!item);
    if (item) item.click();
    await wait(800);

    const pane = document.querySelector('.nt-dp');
    const doc = document.querySelector('#nt-preview');
    const bar = document.querySelector('[data-nt-toolbar]');
    ok('详情面板存在', !!pane);
    ok('正文容器存在', !!doc);
    ok('工具条节点存在', !!bar);
    if (!pane || !doc || !bar) return out;
    const title = pane.querySelector('.nt-dp-title');

    /* ---- 1. 默认只读展示态 ---- */
    ok('默认 contenteditable=false', doc.getAttribute('contenteditable') === 'false', doc.getAttribute('contenteditable'));
    ok('默认工具条隐藏', bar.hidden === true);
    ok('默认标题只读', title.readOnly === true);
    ok('默认目录禁用', pane.querySelector('.nt-folder-select').disabled === true);
    ok('默认标签只读', pane.querySelector('.nt-tag-input').readOnly === true);
    ok('默认 data-mode=preview', pane.dataset.mode === 'preview', pane.dataset.mode);
    ok('默认按钮写「编辑」', /编辑/.test(pane.querySelector('[data-nt-act="mode"]').textContent));

    /* ---- 2. 渲染结果：不暴露 Markdown 标记 ---- */
    const text0 = doc.innerText;
    out.readText = text0.slice(0, 300);
    ok('渲染出 h1', !!doc.querySelector('h1'));
    ok('渲染出 h2', !!doc.querySelector('h2'));
    ok('渲染出 strong', !!doc.querySelector('strong'));
    ok('渲染出 em', !!doc.querySelector('em'));
    ok('渲染出 ul/li', !!doc.querySelector('ul li'));
    ok('渲染出 a[href]', !!doc.querySelector('a[href]'));
    ok('渲染出 table', !!doc.querySelector('table'));
    ok('渲染出 .md-code', !!doc.querySelector('.md-code'));
    ok('渲染出自定义颜色 .md-color', !!doc.querySelector('.md-color'));
    ok('读态不暴露 ** 标记', !text0.includes('**'));
    ok('读态不暴露 # 标题标记', !/(^|\n)#\s/m.test(text0));
    ok('读态不暴露 == 样式标记', !text0.includes('=='), text0.slice(0, 120));
    ok('读态不暴露 {c: 属性', !text0.includes('{c:'));
    ok('读态不暴露 ``` 围栏', !text0.includes(FENCE));
    ok('读态不暴露表格分隔行', !text0.includes('| --- |'));
    ok('读态不暴露图片语法', !text0.includes('!['));

    const styleOf = () => {
      const h1 = doc.querySelector('h1');
      const p = doc.querySelector('.nt-blk > p');
      const a = h1 && getComputedStyle(h1);
      const b = p && getComputedStyle(p);
      const c = getComputedStyle(doc);
      return [
        a && a.fontSize, a && a.fontWeight, a && a.lineHeight,
        b && b.fontSize, b && b.lineHeight, b && b.marginTop,
        c.fontSize, c.lineHeight, c.paddingLeft, c.paddingTop, c.backgroundColor,
      ].join('|');
    };
    const style0 = styleOf();

    /* ---- 3. 只读态硬拦截 ---- */
    const before = doc.innerText;
    const evDel = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    doc.dispatchEvent(evDel);
    ok('只读态 Backspace 被拦', evDel.defaultPrevented);
    const evType = new KeyboardEvent('keydown', { key: 'X', bubbles: true, cancelable: true });
    doc.dispatchEvent(evType);
    ok('只读态字符输入被拦', evType.defaultPrevented);
    const evIn = new InputEvent('beforeinput', { inputType: 'insertText', data: 'X', bubbles: true, cancelable: true });
    doc.dispatchEvent(evIn);
    ok('只读态 beforeinput 被拦', evIn.defaultPrevented);
    const evPaste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    doc.dispatchEvent(evPaste);
    ok('只读态 paste 被拦', evPaste.defaultPrevented);
    const evCut = new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    doc.dispatchEvent(evCut);
    ok('只读态 cut 被拦', evCut.defaultPrevented);
    ok('只读态内容未被改', doc.innerText === before);

    /* ---- 3.5 空切换：进编辑立刻用 Esc 退出，内容必须字节级不变 ---- */
    pane.querySelector('[data-nt-act="mode"]').click();
    await wait(200);
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(1300);
    ok('Esc 退出编辑回到只读', doc.getAttribute('contenteditable') === 'false' && bar.hidden === true);
    const untouched = await window.api.notes.get(note.id);
    ok('空切换后 content_md 字节级一致', untouched.content_md === md,
      untouched.content_md === md ? '' : 'diffLen=' + (untouched.content_md.length - md.length));
    ok('空切换后文本零变化', doc.innerText === before);
    ok('空切换后代码块高亮已恢复', !!doc.querySelector('.md-code pre code span[class^="hljs-"]'));

    /* ---- 4. 点「编辑」进入可编辑态 ---- */
    pane.querySelector('[data-nt-act="mode"]').click();
    await wait(300);
    ok('编辑态 contenteditable=true', doc.getAttribute('contenteditable') === 'true', doc.getAttribute('contenteditable'));
    ok('编辑态工具条显示', bar.hidden === false);
    ok('编辑态标题可写', title.readOnly === false);
    ok('编辑态目录可写', pane.querySelector('.nt-folder-select').disabled === false);
    ok('编辑态 data-mode=edit', pane.dataset.mode === 'edit');
    ok('编辑态按钮写「完成」', /完成/.test(pane.querySelector('[data-nt-act="mode"]').textContent));
    ok('进编辑态只摊平代码高亮、文本零变化', doc.innerText === text0);
    ok('两态计算样式完全一致（排版 / 字号 / 行高 / 内边距 / 背景）', styleOf() === style0,
      styleOf() === style0 ? '' : 'read=' + style0 + ' edit=' + styleOf());
    const text1 = doc.innerText;
    ok('编辑态不暴露 ** 标记', !text1.includes('**'));
    ok('编辑态不暴露 == 标记', !text1.includes('=='));
    ok('编辑态不暴露 ``` 围栏', !text1.includes(FENCE));
    ok('编辑态不暴露 {c: 属性', !text1.includes('{c:'));

    /* ---- 5. 工具条 + 快捷键 ---- */
    const selectNode = (el) => {
      if (!el) return false;
      doc.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return true;
    };

    // 加粗（工具条）
    const liA = [...doc.querySelectorAll('ul li')].find((x) => x.textContent.includes('列表项 A'));
    ok('找到列表项 A', !!liA);
    selectNode(liA);
    document.querySelector('[data-nt-cmd="bold"]').click();
    await wait(120);
    ok('工具条加粗生效', !!(liA && liA.querySelector('b, strong')), liA && liA.innerHTML);

    // 斜体（快捷键 Ctrl+I）作用在另一段纯文本上
    const liB = [...doc.querySelectorAll('ul li')].find((x) => x.textContent.includes('列表项 B'));
    selectNode(liB);
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(120);
    ok('Ctrl+I 斜体快捷键生效', !!(liB && liB.querySelector('i, em')), liB && liB.innerHTML);

    // 标题（工具条 H3）：作用在第一个普通段落
    const para = [...doc.querySelectorAll('.nt-blk > p')].find((x) => x.textContent.includes('这是一段'));
    ok('找到普通段落', !!para);
    selectNode(para);
    document.querySelector('[data-nt-cmd="h3"]').click();
    await wait(150);
    ok('工具条插入三级标题生效', !!doc.querySelector('h3'));

    // 表格（工具条插入）：先把光标折到正文末尾，避免替换掉上一步的标题选区
    const tableBefore = doc.querySelectorAll('table').length;
    doc.focus();
    {
      const r = document.createRange();
      r.selectNodeContents(doc);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
    document.querySelector('[data-nt-cmd="table"]').click();
    await wait(120);
    ok('工具条插入表格生效', doc.querySelectorAll('table').length > tableBefore);

    // 代码块：工具条先选语言再插入；插完点左上角语言标签可以换语言
    const codeBefore = doc.querySelectorAll('.md-code').length;
    document.querySelector('[data-nt-cmd="code"]').click();
    await wait(160);
    const langBox = document.querySelector('.nt-overlay .nt-lang-grid');
    ok('代码块语言浮层出现', !!langBox);
    ok('语言列表含 JS / Python', !!langBox
      && !!langBox.querySelector('[data-ov-lang="js"]')
      && !!langBox.querySelector('[data-ov-lang="python"]'));
    if (langBox) langBox.querySelector('[data-ov-lang="js"]').click();
    await wait(220);
    const shells = [...doc.querySelectorAll('.md-code')];
    ok('工具条插入代码块生效', shells.length > codeBefore);
    const newShell = shells[shells.length - 1];
    ok('新代码块语言标签为 js', (newShell.querySelector('.md-code-lang') || {}).textContent === 'js',
      (newShell.querySelector('.md-code-lang') || {}).textContent);
    ok('新代码块带 language-js', /language-js/.test((newShell.querySelector('pre code') || {}).className || ''));

    // 往代码块里真实输入一行代码
    const codeEl = newShell.querySelector('pre code');
    const rCaret = document.createRange();
    rCaret.setStart(codeEl, 0);
    rCaret.collapse(true);
    const sCaret = window.getSelection();
    sCaret.removeAllRanges();
    sCaret.addRange(rCaret);
    document.execCommand('insertText', false, 'print("hi")');
    await wait(140);
    ok('代码块可输入', /print\("hi"\)/.test(codeEl.textContent || ''), codeEl.textContent);

    // 点语言标签换语言（语雀同款交互）
    newShell.querySelector('.md-code-lang').click();
    await wait(160);
    const langBox2 = document.querySelector('.nt-overlay .nt-lang-grid');
    ok('点语言标签弹出语言浮层', !!langBox2);
    if (langBox2) {
      ok('当前语言被标记为选中', !!langBox2.querySelector('.nt-lang-item.active[data-ov-lang="js"]'));
      langBox2.querySelector('[data-ov-lang="python"]').click();
      await wait(220);
    }
    ok('语言已切换为 python', (newShell.querySelector('.md-code-lang') || {}).textContent === 'python',
      (newShell.querySelector('.md-code-lang') || {}).textContent);
    ok('换语言后代码内容保留', /print\("hi"\)/.test(newShell.querySelector('pre code').textContent || ''));
    ok('换语言后浮层已关闭', !document.querySelector('.nt-overlay'));

    // 快捷键 Ctrl+Alt+C 同样唤起语言面板（工具条功能都要有键位）
    doc.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'c', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    }));
    await wait(180);
    ok('Ctrl+Alt+C 弹出语言面板', !!document.querySelector('.nt-overlay .nt-lang-grid'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(140);
    ok('Esc 关掉语言面板且不退出编辑', !document.querySelector('.nt-overlay')
      && doc.getAttribute('contenteditable') === 'true');

    // 链接（工具条 + 浮层）放最后，避免后续插入命令把刚生成的 <a> 替换掉
    const head2 = doc.querySelector('h2');
    selectNode(head2);
    document.querySelector('[data-nt-cmd="link"]').click();
    await wait(120);
    const ov = document.querySelector('.nt-overlay');
    ok('链接浮层出现', !!ov);
    if (ov) {
      ov.querySelector('.nt-overlay-input').value = 'https://example.org';
      ov.querySelector('[data-ov-act="ok"]').click();
      await wait(150);
      ok('插入链接生效', !!doc.querySelector('a[href="https://example.org"]'));
      ok('浮层已关闭', !document.querySelector('.nt-overlay'));
      ok('链接文字未丢失', (doc.querySelector('h2') || {}).innerText !== ''
        && /二级标题/.test((doc.querySelector('h2') || {}).textContent || ''));
    }

    // 背景高亮（工具条 + 色板）：验证项目自定义 ==文字=={bg:...} 语法仍可用
    selectNode(doc.querySelector('h1'));
    document.querySelector('[data-nt-cmd="bg"]').click();
    await wait(120);
    const pal = document.querySelector('.nt-palette');
    ok('背景高亮色板出现', !!pal);
    if (pal) {
      const sw = pal.querySelector('.nt-swatch');
      if (sw) sw.click();
      await wait(150);
      ok('背景高亮生效', !!doc.querySelector('mark.md-mark'));
      ok('色板已关闭', !document.querySelector('.nt-palette'));
    }

    // 编辑后仍不暴露 Markdown 标记
    const text2 = doc.innerText;
    out.editTables = doc.querySelectorAll('table').length;
    out.editBlocks = doc.children.length;
    out.editHtmlTail = doc.innerHTML.slice(-1400);
    out.tableInfo = [...doc.querySelectorAll('table')].map((t) => {
      const blk = t.closest('.nt-blk');
      return {
        blk: blk && blk.dataset.ntBlk,
        clean: !!(blk && blk.hasAttribute('data-nt-clean')),
        parent: t.parentElement && t.parentElement.tagName + '.' + t.parentElement.className,
      };
    });
    out.blockTail = [...doc.children].slice(-3).map((x) => x.className + '|' + x.outerHTML.slice(0, 220)).join('\n');
    ok('编辑后不暴露 ** 标记', !text2.includes('**'));
    ok('编辑后不暴露 == 标记', !text2.includes('=='));
    ok('编辑后不暴露 ``` 围栏', !text2.includes(FENCE));

    /* ---- 6. 退出编辑 ---- */
    // 代码块工具条（语言标签 + 复制按钮）不参与内容比对：编辑态新插入的块没有
    // 「复制」按钮，退出重渲后才有 —— 那是渲染态的装饰，不是正文。
    const textOf = (el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll('.md-code-bar').forEach((x) => x.remove());
      return String(c.innerText || c.textContent || '').replace(/[\s\u00A0]+/g, ' ').trim();
    };
    const htmlBeforeExit = doc.innerHTML;
    const textBeforeExit = textOf(doc);
    pane.querySelector('[data-nt-act="mode"]').click();
    await wait(300);
    ok('退出后 contenteditable=false', doc.getAttribute('contenteditable') === 'false');
    ok('退出后工具条隐藏', bar.hidden === true);
    ok('退出后标题只读', title.readOnly === true);
    ok('退出后 data-mode=preview', pane.dataset.mode === 'preview');
    // 退出时按最新 Markdown 重渲一次（代码高亮 / Mermaid 回到渲染态），
    // 所以比对的是「内容」而不是字节：空白段落会被规范化掉。
    // 表格单元 / 空段落回写后会被规范化掉若干空白，字符集合必须完全一致
    const squash = (s) => String(s || '').replace(/[\s\u00A0]+/g, '');
    ok('退出后代码块高亮已恢复', !!doc.querySelector('.md-code pre code span[class^="hljs-"]'));
    ok('退出不丢内容：字符一致', squash(textOf(doc)) === squash(textBeforeExit),
      'exit=' + textOf(doc).slice(-90) + ' || before=' + textBeforeExit.slice(-90));

    /* ---- 7. 落库 + 往返保真 ---- */
    await wait(1600);
    const saved = await window.api.notes.get(note.id);
    const savedMd = saved && saved.content_md || '';
    out.savedMd = savedMd.slice(0, 700);
    ok('保存后颜色高亮语法零丢失', savedMd.includes('==红字=={c:#e5484d}'));
    ok('保存后代码块零丢失', savedMd.includes(FENCE + 'js') && savedMd.includes('const a = 1;'));
    ok('保存后表格零丢失', savedMd.includes('| --- |'));
    ok('保存后原有链接零丢失', savedMd.includes('https://example.com'));
    ok('保存后加粗生效（工具条）', /\*\*列表项 A\*\*|__列表项 A__/.test(savedMd), savedMd.slice(0, 200));
    ok('保存后斜体生效（快捷键）', /[*_]列表项 B[*_]/.test(savedMd), savedMd.slice(0, 200));
    ok('保存后新链接生效', savedMd.includes('https://example.org'));
    ok('保存后新插入表格生效', savedMd.includes('列 A') && savedMd.includes('列 C'), savedMd.slice(-260));
    ok('保存后代码块语言生效', savedMd.includes(FENCE + 'python') && savedMd.includes('print("hi")'),
      savedMd.slice(-260));
    ok('保存后新背景高亮生效', /==标题一==\{bg:/.test(savedMd), savedMd.slice(0, 120));
    ok('保存后不残留 Markdown 标签文本', !savedMd.includes('&lt;h3'));

    // 重新打开：格式仍在、读态仍然不暴露标记
    const closeBtn = pane.querySelector('[data-nt-act="dp-close"]');
    if (closeBtn) closeBtn.click();
    await wait(400);
    const item2 = document.querySelector('.nt-item[data-id="' + note.id + '"]');
    if (item2) item2.click();
    await wait(800);
    const doc2 = document.querySelector('#nt-preview');
    const bar2 = document.querySelector('[data-nt-toolbar]');
    ok('重开仍是只读态', !!doc2 && doc2.getAttribute('contenteditable') === 'false');
    ok('重开工具条仍隐藏', !!bar2 && bar2.hidden === true);
    if (doc2) {
      ok('重开仍渲染出表格', !!doc2.querySelector('table'));
      ok('重开仍渲染出 .md-code', !!doc2.querySelector('.md-code'));
      const reopened = [...doc2.querySelectorAll('.md-code-lang')].map((x) => x.textContent.trim());
      ok('重开保留代码块语言', reopened.includes('python'), reopened.join(','));
      ok('重开仍渲染出 .md-color', !!doc2.querySelector('.md-color'));
      ok('重开读态不暴露 ** 标记', !doc2.innerText.includes('**'));
      ok('重开读态不暴露 == 标记', !doc2.innerText.includes('=='));
      ok('重开读态不暴露 ``` 围栏', !doc2.innerText.includes(FENCE));
    }

    /* ---- 8. 固定标题行：正文滚到任何位置，工具条都吸在滚动区顶部 ---- */
    const longLines = [];
    for (let i = 0; i < 40; i++) {
      longLines.push('## 第 ' + (i + 1) + ' 节');
      longLines.push('这是第 ' + (i + 1) + ' 段正文，用来把内容撑长以测试滚动。');
    }
    const longNote = await window.api.notes.create({
      title: 'WYS 长文 ' + Date.now(), contentMd: longLines.join('\n\n'),
    });
    out.longNoteId = longNote && longNote.id;
    await wait(400);
    document.querySelector('.nav-item[data-view="notes"]').click();
    await wait(700);
    const longItem = document.querySelector('.nt-item[data-id="' + longNote.id + '"]');
    ok('长文笔记出现在列表', !!longItem);
    if (longItem) longItem.click();
    await wait(700);
    const lp = document.querySelector('.nt-dp');
    lp.querySelector('[data-nt-act="mode"]').click();
    await wait(500);
    const lBar = document.querySelector('.nt-wys-bar');
    const lScroll = document.querySelector('.nt-dp-scroll');
    const barTop0 = lBar.getBoundingClientRect().top;
    ok('长文已产生滚动', lScroll.scrollHeight > lScroll.clientHeight + 200,
      lScroll.scrollHeight + '>' + lScroll.clientHeight);
    lScroll.scrollTop = 500;
    await wait(250);
    const midTop = lBar.getBoundingClientRect().top;
    ok('滚动 500px 后工具条仍在原位', Math.abs(midTop - barTop0) <= 1,
      'top0=' + barTop0 + ' mid=' + midTop + ' scrollTop=' + lScroll.scrollTop);
    lScroll.scrollTop = lScroll.scrollHeight;
    await wait(300);
    const botRect = lBar.getBoundingClientRect();
    ok('滚到底部工具条仍固定', Math.abs(botRect.top - barTop0) <= 1,
      'top0=' + barTop0 + ' bottom=' + botRect.top);
    ok('固定后工具条高度未塌', botRect.height > 24, String(botRect.height));
    const hit = document.elementFromPoint(botRect.left + 40, botRect.top + botRect.height / 2);
    ok('工具条压在正文之上（未被遮挡）', !!hit && !!hit.closest('.nt-wys-bar'),
      hit ? (hit.tagName + '.' + (hit.className || '')) : 'null');

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
    await sleep(3000);
    const alive = await ws.evaluate('1+1');
    if (!alive || alive.result?.value !== 2) throw new Error('渲染进程无响应');
    out0: {
      const boot = await ws.evaluate('({ api: !!window.api, nav: !!document.querySelector(".nav-item"), title: document.querySelector("#view-title") && document.querySelector("#view-title").textContent })');
      console.log('启动检查：' + JSON.stringify(boot.result && boot.result.value));
    }
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
    console.log(`创建结果：${out.createdNote || ''}`);
    console.log(`诊断：${JSON.stringify(out.diag || {}, null, 2)}`);
    console.log(`编辑诊断：tables=${out.editTables} blocks=${out.editBlocks} tableInfo=${JSON.stringify(out.tableInfo)}`);
    console.log(`HTML 末尾：${(out.editHtmlTail || '').slice(-900)}`);
    console.log(`末尾块：${out.blockTail || ''}`);
    console.log(`读态正文：${out.readText || ''}`);
    console.log(`落库 Markdown：\n${out.savedMd || ''}`);
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
        const item = document.querySelector('.nt-item');
        if (item) item.click();
        await wait(700);
        const p = document.querySelector('.nt-dp');
        if (p && p.dataset.mode !== 'edit') p.querySelector('[data-nt-act="mode"]').click();
        await wait(400);
        return true;
      })()`);
      const shot = await ws.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const shotPath = path.join(os.tmpdir(), 'knodo-wys-edit.png');
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      console.log('编辑态截图：' + shotPath);

      // 语言选择浮层（确认 3 列网格不溢出、当前语言高亮）
      await ws.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[data-nt-cmd="code"]').click();
        await wait(320);
        return !!document.querySelector('.nt-lang-grid');
      })()`);
      const shot2 = await ws.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const shot2Path = path.join(os.tmpdir(), 'knodo-wys-lang.png');
      fs.writeFileSync(shot2Path, Buffer.from(shot2.data, 'base64'));
      console.log('语言浮层截图：' + shot2Path);

      // 长文滚动中的吸顶效果
      await ws.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const esc = document.querySelector('.nt-overlay');
        if (esc) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(120);
        const item = document.querySelector('.nt-item[data-id="${out.longNoteId}"]');
        if (item) item.click();
        await wait(600);
        const p = document.querySelector('.nt-dp');
        if (p && p.dataset.mode !== 'edit') p.querySelector('[data-nt-act="mode"]').click();
        await wait(400);
        const s = document.querySelector('.nt-dp-scroll');
        if (s) s.scrollTop = 620;
        await wait(300);
        return true;
      })()`);
      const shot3 = await ws.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const shot3Path = path.join(os.tmpdir(), 'knodo-wys-sticky.png');
      fs.writeFileSync(shot3Path, Buffer.from(shot3.data, 'base64'));
      console.log('吸顶截图：' + shot3Path);
    }
  } catch (e) {
    console.error('验证失败：', e && e.stack ? e.stack : e);
    console.error('Electron 日志（尾部）：\n' + childLog.slice(-2500));
    process.exitCode = 1;
  } finally {
    if (ws) ws.close();
    killChild();
    // 脚本结尾必须显式退出，否则 Electron 的子进程句柄会把 Node 挂住
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
