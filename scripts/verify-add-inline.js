'use strict';
/**
 * 「新建编辑行长在列表末尾」的回归验证。
 *
 * 位置需求（用户拍板）：点「＋ 新建任务」，编辑行出现在**最后一条任务下面**，
 * 而不是像 v2.5 那样挂在滚动容器外的固定底栏（那样看着像另一个面板，与列表断开）。
 *
 * 放回列表里要守住两条底线，这个脚本就是钉它们的：
 *  1. **文档不许被撑高 / 不许整体滚动**（window.scrollY 必须为 0）——
 *     Tom Select 藏起来的原生 select 曾经逃到初始包含块，把 document 顶高，
 *     结果任何一次 focus 都把标题栏顶出视口；
 *  2. **编辑行必须完整可见**：列表内部可以滚（这正是"接着最后一条写"的自然结果），
 *     但要一次滚到位，不能停在半屏外。
 *
 * 其余断言：新建时列表末尾的「＋ 添加任务」入口让位给编辑行；Esc 后编辑行消失、
 * 入口回来；切到笔记视图不留残影。
 *
 * 用法：node scripts/verify-add-inline.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9499';
const profile = path.join(os.tmpdir(), `knodo-add-inline-${Date.now()}`);
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
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
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
    evaluate: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || '渲染层表达式异常');
      }
      return r && r.result ? r.result.value : undefined;
    },
    close: () => ws.close(),
  };
}

(async () => {
  const fail = (msg, extra) => {
    console.log(`[ADD-INLINE] FAIL：${msg}`);
    if (extra) console.log(`[ADD-INLINE] ${JSON.stringify(extra)}`);
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
      if (!/knodo-add-inline-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
      const d = new Date();
      const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const g = await window.api.groups.create({ name: '内联新增用例组' });
      for (let i = 1; i <= 22; i += 1) {
        await window.api.tasks.create({ title: '内联新增用例 ' + i, planEnd: day, groupId: g.id });
      }
      document.querySelector('.nav-item[data-view="all"]').click();
      await wait(900);

      const v = document.getElementById('view');
      const snap = () => {
        const ed = document.querySelector('.task-editor[data-editor="new"]');
        const eb = ed ? ed.getBoundingClientRect() : null;
        const vb = v.getBoundingClientRect();
        return {
          scrollTop: Math.round(v.scrollTop),
          windowScrollY: Math.round(window.scrollY),
          editorInList: !!ed && ed.closest('#view') === v,
          // 编辑行外面还裹着 .task-editor-wrap（它才是 #view 的直接子元素）
          editorIsLastChild: (() => {
            const wrap = document.querySelector('#view > .is-new-editor');
            return !!wrap && v.lastElementChild === wrap;
          })(),
          editorVisible: eb ? eb.top >= vb.top - 1 && eb.bottom <= vb.bottom + 1 : null,
          editorBottom: eb ? Math.round(eb.bottom) : null,
          viewBottom: Math.round(vb.bottom),
          addRowShown: !!document.querySelector('.add-row'),
          legacyComposer: !!document.getElementById('composer'),
          docScrollH: document.scrollingElement.scrollHeight,
          vh: window.innerHeight,
          focused: document.activeElement ? document.activeElement.className : '',
        };
      };

      // 先滚到中间：这时编辑行离可视区最远，最容易复现「整屏上跳」
      v.scrollTop = 420;
      await wait(200);
      const before = snap();
      document.getElementById('btn-new-task').click();
      await wait(900);
      const after = snap();

      // Esc 取消
      const title = document.querySelector('.task-editor[data-editor="new"] .editor-title');
      if (title) title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(600);
      const afterEsc = snap();

      // 切到笔记：编辑行跟着消失（它已经在 #view 里，重绘即带走）
      document.getElementById('btn-new-task').click();
      await wait(500);
      document.querySelector('.nav-item[data-view="notes"]').click();
      await wait(900);
      const inNotes = snap();
      document.querySelector('.nav-item[data-view="all"]').click();
      await wait(700);
      return { before, after, afterEsc, inNotes, back: snap() };
    })()`);

    console.log(`[ADD-INLINE] 点新建前 ${JSON.stringify(out.before)}`);
    console.log(`[ADD-INLINE] 点新建后 ${JSON.stringify(out.after)}`);
    console.log(`[ADD-INLINE] Esc 取消后 ${JSON.stringify(out.afterEsc)}`);
    console.log(`[ADD-INLINE] 切到笔记 ${JSON.stringify(out.inNotes)}`);

    const problems = [];
    if (out.after.legacyComposer) problems.push('旧的 #composer 固定底栏还在 DOM 里');
    if (!out.after.editorInList) problems.push('编辑行不在 #view 里（应该长在列表末尾）');
    if (!out.after.editorIsLastChild) problems.push('编辑行不是列表的最后一项');
    if (!out.after.editorVisible) problems.push(`编辑行没有完整可见（底 ${out.after.editorBottom} / 视口底 ${out.after.viewBottom}）`);
    if (out.after.windowScrollY !== 0) problems.push(`窗口被整体滚动了：scrollY=${out.after.windowScrollY}`);
    if (out.after.docScrollH > out.after.vh + 1) problems.push(`document 被撑高：${out.after.docScrollH} > 视口 ${out.after.vh}（Tom Select 的隐藏 select 逃出了 #view）`);
    if (!/editor-title/.test(out.after.focused)) problems.push('光标没有落在标题输入框');
    if (out.after.addRowShown) problems.push('新建时列表末尾的「添加任务」入口没有让位');
    if (out.afterEsc.editorInList) problems.push('Esc 之后编辑行没有消失');
    if (!out.afterEsc.addRowShown) problems.push('Esc 之后「添加任务」入口没有回来');
    if (out.inNotes.editorInList) problems.push('切到笔记视图后编辑行还留在页面里');

    main.close();
    if (problems.length) fail(problems.join('；'), out);
    console.log('[ADD-INLINE] ADD_INLINE_OK');
    killChild();
    process.exit(0);
  } catch (e) {
    console.log('[ADD-INLINE] 检测失败：', (e && e.message) || e);
    if (childLog) console.log('[ADD-INLINE] 窗口日志：', childLog.split('\n').slice(-8).join(' | '));
    killChild();
    process.exit(1);
  }
})();

process.on('exit', killChild);
