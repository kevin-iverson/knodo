'use strict';
/**
 * 笔记浮窗（kind: 'note'）的端到端验证：钉到桌面 → 渲染正文 → 就地编辑 → 落库 → 删除收窗。
 * 用法：npm run verify:note
 *
 * 为什么必须真跑 Electron：浮窗是独立 BrowserWindow，正文要懒加载 4 个 UMD 依赖 +
 * wysiwyg 模块，序列化回 Markdown 又依赖 window.turndown —— 这些在 Node 里都验不到。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9472';
const profile = path.join(os.tmpdir(), `knodo-note-desktop-${Date.now()}`);
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
          const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
          throw new Error('页面异常：' + (d || r.exceptionDetails.text));
        }
        return r.result && r.result.value;
      }),
    close: () => ws.close(),
  };
}

async function pageOf(pred, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const list = await pages();
    const t = list.find((x) => x.type === 'page' && pred(x.url));
    if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    await sleep(250);
  }
  return null;
}

(async () => {
  const results = [];
  const ok = (name, pass, extra) => {
    results.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra).slice(0, 240) });
    console.log(`${pass ? '✓' : '✗'} ${name}${extra == null ? '' : `  ${String(extra).slice(0, 240)}`}`);
  };
  try {
    const main = await connect(await pageOf((u) => /index\.html/.test(u)));
    await sleep(1200);

    /* ---- 1) 造一篇笔记并钉到桌面 ---- */
    const created = await main.evaluate(`(async () => {
      const n = await window.api.notes.create({
        title: '浮窗笔记验证',
        contentMd: '## 二级标题\\n\\n第一段正文，用来验证浮窗里的排版。\\n\\n- 列表项 A\\n- 列表项 B',
      });
      const r = await window.api.desktop.pin('note', n.id, {});
      const d = await window.api.desktop.diagnostics();
      const w = d.windows.find((x) => x.id === r.projection.id);
      return { noteId: n.id, pid: r.projection.id, geom: w && w.content, kind: r.projection.kind };
    })()`);
    ok('钉出笔记浮窗', created && created.pid && created.kind === 'note', JSON.stringify(created));
    ok('笔记浮窗默认更宽（≥360）', created && created.geom && created.geom.width >= 360,
      created && created.geom && `w=${created.geom.width}`);

    /* ---- 2) 浮窗渲染：标题 / 正文 / 底栏 ---- */
    await sleep(1500);
    const ws = await pageOf((u) => /desktop\.html/.test(u) && u.includes(created.pid));
    if (!ws) throw new Error('找不到笔记浮窗页面');
    const nw = await connect(ws);

    const painted = await nw.evaluate(`(async () => {
      for (let i = 0; i < 40; i += 1) {
        const body = document.getElementById('dw-note-body');
        if (body && body.textContent.trim()) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const root = document.getElementById('dw');
      const body = document.getElementById('dw-note-body');
      const head = document.getElementById('dw-head');
      const note = document.getElementById('dw-note');
      return {
        isNote: root.classList.contains('is-note'),
        title: document.getElementById('dw-title').textContent,
        bodyText: body.textContent.replace(/\\s+/g, ' ').trim(),
        hasH2: !!body.querySelector('h2'),
        hasList: !!body.querySelector('ul li'),
        countHidden: document.getElementById('dw-count').hidden,
        addHidden: document.getElementById('dw-add').hidden,
        noteBarHidden: document.getElementById('dw-note-bar').hidden,
        editText: document.getElementById('dw-edit').textContent.trim(),
        meta: document.getElementById('dw-note-meta').textContent,
        titleInputHidden: document.getElementById('dw-note-title').hidden,
        headOverflow: head.scrollWidth - head.clientWidth,
        noteOverflowX: note.scrollWidth - note.clientWidth,
      };
    })()`);
    ok('浮窗进入笔记形态', painted && painted.isNote, JSON.stringify(painted));
    ok('标题栏显示笔记标题', painted && painted.title === '浮窗笔记验证', painted && painted.title);
    ok('正文按 Markdown 渲染（标题 + 列表）',
      painted && painted.hasH2 && painted.hasList && /第一段正文/.test(painted.bodyText),
      painted && painted.bodyText.slice(0, 60));
    ok('不显示完成进度徽标', painted && painted.countHidden === true, painted && `hidden=${painted.countHidden}`);
    ok('不显示「新增待办」', painted && painted.addHidden === true, painted && `hidden=${painted.addHidden}`);
    ok('底栏换成笔记条', painted && painted.noteBarHidden === false
      && /字/.test(String(painted.meta || '')) && /编辑/.test(String(painted.editText || '')),
      painted && `${painted.editText} | ${painted.meta}`);
    ok('读态不出现标题输入框', painted && painted.titleInputHidden === true, painted && `hidden=${painted.titleInputHidden}`);
    ok('标题栏不溢出 / 正文无横向滚动',
      painted && painted.headOverflow <= 0 && painted.noteOverflowX <= 0,
      painted && `head=${painted.headOverflow} noteX=${painted.noteOverflowX}`);

    const geom = await main.evaluate(`(async () => {
      const d = await window.api.desktop.diagnostics();
      const w = d.windows.find((x) => x.id === '${created.pid}');
      return w && w.content;
    })()`);
    ok('窗口高度按正文自适应（≥320 且 ≤520）',
      geom && geom.height >= 320 && geom.height <= 520, geom && `h=${geom.height}`);

    /* ---- 3) 进编辑态：标题输入出现、正文可写 ---- */
    const editing = await nw.evaluate(`(async () => {
      document.getElementById('dw-edit').click();
      await new Promise(r => setTimeout(r, 500));
      const body = document.getElementById('dw-note-body');
      const note = document.getElementById('dw-note');
      return {
        editable: body.getAttribute('contenteditable') === 'true',
        mode: note.dataset.mode,
        titleInputHidden: document.getElementById('dw-note-title').hidden,
        editText: document.getElementById('dw-edit').textContent.trim(),
        bodyText: body.textContent.replace(/\\s+/g, ' ').trim(),
      };
    })()`);
    ok('点「编辑」进入编辑态', editing && editing.editable && editing.mode === 'edit', JSON.stringify(editing));
    ok('编辑态出现标题输入框', editing && editing.titleInputHidden === false, editing && `hidden=${editing.titleInputHidden}`);
    ok('按钮变「✓ 完成」', editing && /完成/.test(String(editing.editText || '')), editing && editing.editText);
    ok('进编辑后正文没被清空', editing && /第一段正文/.test(String(editing.bodyText || '')),
      editing && String(editing.bodyText).slice(0, 60));

    /* ---- 4) 在浮窗里打字 → 防抖落库 ---- */
    const typed = await nw.evaluate(`(async () => {
      const body = document.getElementById('dw-note-body');
      body.focus();
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, '浮窗里补的一句话');
      const title = document.getElementById('dw-note-title');
      title.value = '浮窗笔记验证（改）';
      title.dispatchEvent(new Event('input', { bubbles: true }));
      const states = [];
      for (let i = 0; i < 10; i += 1) {
        await new Promise(r => setTimeout(r, 200));
        states.push(document.getElementById('dw-note-state').textContent || '-');
      }
      return {
        state: document.getElementById('dw-note-state').textContent,
        states,
        headTitle: document.getElementById('dw-title').textContent,
        bodyText: body.textContent.replace(/\\s+/g, ' ').trim(),
      };
    })()`);
    const saved = await main.evaluate(`window.api.notes.get(${created.noteId})`);
    ok('浮窗里输入的正文已落库', saved && /浮窗里补的一句话/.test(saved.content_md || ''),
      saved && String(saved.content_md || '').slice(-40));
    // 只有「被改动的块」会重新序列化（turndown 的列表标记是 "-   "），未改动的块必须字节级不变
    ok('未改动的块保持原样（标题没被规范化）', saved && /## 二级标题/.test(saved.content_md || ''),
      saved && String(saved.content_md || '').slice(0, 40));
    ok('标题改动已落库', saved && saved.title === '浮窗笔记验证（改）', saved && saved.title);
    ok('保存状态显示已保存', typed && /已保存/.test(String(typed.state || '')),
      typed && JSON.stringify(typed.states));
    ok('编辑态标题栏只报「编辑中…」（避免和正文标题重复）',
      typed && /编辑中/.test(String(typed.headTitle || '')), typed && typed.headTitle);
    ok('字数目检（word_count > 0）', saved && Number(saved.word_count) > 0, saved && `word=${saved.word_count}`);

    /* ---- 5) 退出编辑：重新渲染成读态，内容仍在 ---- */
    const done = await nw.evaluate(`(async () => {
      document.getElementById('dw-edit').click();
      await new Promise(r => setTimeout(r, 600));
      const body = document.getElementById('dw-note-body');
      return {
        editable: body.getAttribute('contenteditable') === 'true',
        titleInputHidden: document.getElementById('dw-note-title').hidden,
        bodyText: body.textContent.replace(/\\s+/g, ' ').trim(),
        hasH2: !!body.querySelector('h2'),
        headTitle: document.getElementById('dw-title').textContent,
      };
    })()`);
    ok('点「完成」退出编辑', done && done.editable === false && done.titleInputHidden === true, JSON.stringify(done));
    ok('退出后正文与排版都在', done && /浮窗里补的一句话/.test(String(done.bodyText || '')) && done.hasH2,
      done && String(done.bodyText).slice(-40));
    ok('退出编辑后标题栏回到笔记标题', done && done.headTitle === '浮窗笔记验证（改）', done && done.headTitle);

    /* ---- 6) 折叠：只剩标题条，正文不丢 ---- */
    const folded = await nw.evaluate(`(async () => {
      await window.api.desktop.update('${created.pid}', { collapsed: true });
      await new Promise(r => setTimeout(r, 700));
      const note = document.getElementById('dw-note');
      return {
        collapsed: document.getElementById('dw').classList.contains('is-collapsed'),
        noteH: note.getBoundingClientRect().height,
      };
    })()`);
    const foldedGeom = await main.evaluate(`(async () => {
      const d = await window.api.desktop.diagnostics();
      const w = d.windows.find((x) => x.id === '${created.pid}');
      return w && w.content;
    })()`);
    ok('折叠后正文区收起、窗口回到标题栏高度',
      folded && folded.collapsed && folded.noteH === 0 && foldedGeom && foldedGeom.height <= 46,
      JSON.stringify({ folded, h: foldedGeom && foldedGeom.height }));
    const expanded = await nw.evaluate(`(async () => {
      await window.api.desktop.update('${created.pid}', { collapsed: false });
      await new Promise(r => setTimeout(r, 800));
      const body = document.getElementById('dw-note-body');
      return { bodyText: body.textContent.replace(/\\s+/g, ' ').trim(), display: getComputedStyle(document.getElementById('dw-note')).display };
    })()`);
    ok('展开后正文还在（没被折叠清空）',
      expanded && /浮窗里补的一句话/.test(String(expanded.bodyText || '')), expanded && String(expanded.bodyText).slice(-30));

    /* ---- 7) 主窗口改了同一篇：浮窗刷新后跟着变（不在编辑态） ---- */
    const external = await main.evaluate(`(async () => {
      await window.api.notes.update(${created.noteId}, { content_md: '## 主窗口改的\\n\\n外部更新内容。' });
      return true;
    })()`).catch(() => false);
    if (external !== false) {
      await sleep(1500);
      const after = await nw.evaluate(`(async () => {
        await new Promise(r => setTimeout(r, 400));
        const body = document.getElementById('dw-note-body');
        return body.textContent.replace(/\\s+/g, ' ').trim();
      })()`);
      ok('外部改动会同步到浮窗', /外部更新内容/.test(String(after || '')), String(after || '').slice(0, 40));
    }

    /* ---- 8) 把笔记删掉：浮窗提示后自动收窗 ---- */
    const trashed = await main.evaluate(`(async () => {
      await window.api.notes.trash(${created.noteId});
      const d = await window.api.desktop.diagnostics();
      return { windows: d.windows.length };
    })()`).catch((e) => ({ err: String(e && e.message) }));
    await sleep(800);
    const missing = await nw.evaluate(`({
      state: document.getElementById('dw').dataset.state,
      hint: document.getElementById('dw-hint').textContent,
    })`).catch(() => null);
    if (missing) {
      ok('笔记进回收站 → 浮窗进入「已删除」提示态',
        missing.state === 'missing' && /已删除/.test(String(missing.hint || '')), JSON.stringify(missing));
    }
    await sleep(3600);
    const after = await main.evaluate(`(async () => {
      const list = await window.api.desktop.list();
      return { count: list.filter(p => p.kind === 'note').length };
    })()`);
    ok('提示 3 秒后自动取消钉住', after && after.count === 0, JSON.stringify({ trashed, after }));

    nw.close();
    main.close();
  } catch (e) {
    ok('脚本执行', false, (e && e.message) || e);
    console.log(log.slice(-1500));
  } finally {
    cleanup();
  }

  const fail = results.filter((r) => !r.pass);
  console.log(`\n===== 笔记浮窗：${results.length - fail.length}/${results.length} 通过 =====`);
  if (fail.length) {
    console.log('失败项：');
    fail.forEach((r) => console.log(` - ${r.name}  ${r.extra}`));
    process.exit(1);
  }
})();
