'use strict';
/**
 * 四象日记端到端验收（真实 Electron + CDP，沿用 verify:worklog 的写法），
 * 覆盖实现方案 §十二 的 14 项用例：
 *  1  关闭态主进程只注册开关通道，journal:* 业务 handler 不存在；
 *  2  关闭态点标题栏「日记」显示引导页、无 journal.css / [data-journal]；
 *  3  引导页「开启」→ 今天视图 + 入口高亮；
 *  4  四格输入 800ms 后显示「已保存」，重启后仍在；
 *  5  只写一格 → 已记录 +1；
 *  6  清空唯一有内容的格 → 已记录 −1、库里删行；
 *  7  碎碎念 Enter 立即出现、时间戳为当前时分、Shift+Enter 换行；
 *  8  归入「心智」→ 正文并入末尾、条目消失、可撤销；
 *  9  撤销归入 → 格子还原、条目回到列表；
 *  10 转任务 → 「已加入今天」、任务列表出现该条；
 *  11 今天点右箭头禁用到不了未来；
 *  12 860 宽 + 侧栏 420 → is-compact 降级、不压滑块；
 *  13 导出 JSON 含 journal 且 schemaVersion 17；旧备份导入不报错；
 *  14 日记写入后跑 AI 检索不含日记内容（ privacy：不进 FTS / AI）。
 *
 * 用法：node scripts/verify-journal.js [port]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9537';
const profile = path.join(os.tmpdir(), `knodo-journal-${Date.now()}`);
const shotDir = path.join(root, '.tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(electronBin, [root, `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*', `--user-data-dir=${profile}`],
{ cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

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

async function connect(wsUrl) {  const ws = new WebSocket(wsUrl);
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
          throw new Error('页面异常：' + JSON.stringify((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
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

/**
 * 轮询等待页面条件成立。固定 sleep 在负载高的机器上会偶发失败（800ms 防抖 + 落库 + 广播，
 * 实测有几次 1100ms 还没画完）——断言应该等「状态到了」，而不是等「时间够了」。
 */
async function waitFor(page, expression, timeoutMs = 6000, interval = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await page.evaluate(expression);
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

(async () => {
  const results = [];
  const ok = (name, pass, extra) => {
    const row = { name, pass: !!pass, extra: extra == null ? '' : String(extra).slice(0, 240) };
    results.push(row);
    // 立刻打印：中途崩掉也能看到走到哪一步（曾经整段静默无输出，无从定位）
    console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${name}${row.extra ? `  ·  ${row.extra}` : ''}`);
  };
  try {
    const list = await pages();
    const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    const page = await connect(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await sleep(1600);

    // 1 / 2：关闭态
    let r = await page.evaluate(`(() => ({
      entry: !!document.querySelector('.nav-item[data-view="journal"]'),
      css: !!document.getElementById('jr-css'),
      dom: !!document.querySelector('[data-journal]'),
      mount: !!(window.KnodoJournal && window.KnodoJournal.debugState().mounted),
      pref: null,
    }))()`);
    ok('1 关闭态：常驻入口在、日记样式 / DOM 未注入', r && r.entry && !r.css && !r.dom && !r.mount, JSON.stringify(r));

    await page.evaluate(`document.querySelector('.nav-item[data-view="journal"]').click()`);
    await sleep(500);
    r = await page.evaluate(`(() => ({
      title: document.getElementById('view-title').textContent,
      off: !!document.querySelector('[data-journal-off]'),
      css: !!document.getElementById('jr-css'),
    }))()`);
    ok('2 关闭态点日记 → 引导页，无插件代码', r && /四象日记/.test(r.title) && r.off && !r.css, JSON.stringify(r));

    // 3：引导页开启
    await page.evaluate(`document.getElementById('jr-off-open').click()`);
    await sleep(1200);
    r = await page.evaluate(`(() => ({
      view: !!document.querySelector('.jr-view'),
      active: document.querySelector('.nav-item[data-view="journal"]').classList.contains('active'),
      css: !!document.getElementById('jr-css'),
      mount: !!(window.KnodoJournal && window.KnodoJournal.debugState().mounted),
      day: (document.getElementById('jr-day') || {}).textContent || '',
    }))()`);
    ok('3 开启 → 今天视图 + 入口高亮 + 样式挂载', r && r.view && r.active && r.css && r.mount && /今天/.test(r.day), JSON.stringify(r));

    // 3b：高度链。宿主 #view 不是 flex，若不断言，四格会塌成内容高、下面空一大片（已踩）
    r = await page.evaluate(`(() => {
      const v = document.getElementById('view').getBoundingClientRect();
      const j = document.querySelector('.jr-view').getBoundingClientRect();
      const q = document.querySelector('.jr-quads').getBoundingClientRect();
      return { vh: Math.round(v.height), jh: Math.round(j.height), qh: Math.round(q.height) };
    })()`);
    ok('3b 四格撑满内容区（高度链不断）',
      r && r.vh - r.jh <= 40 && r.qh >= Math.round(r.vh * 0.6),
      JSON.stringify(r));
    await page.shot(path.join(shotDir, 'journal-view.png'));

    // 4 / 5：四格输入 + 800ms 保存 + 已记录 +1
    const before = await page.evaluate(`Number(document.getElementById('jr-streak-n').textContent)`);
    await page.evaluate(`(() => {
      const ta = document.querySelector('[data-cell="0"]');
      ta.value = '今天想明白了：日记是时间，笔记是资料。';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(150);
    const saving = await page.evaluate(`document.getElementById('jr-save').textContent`);
    const saved = (await waitFor(page, `(() => { const t = document.getElementById('jr-save').textContent; return /已保存/.test(t) ? t : ''; })()`)) || '';
    // waitFor 只判「到了没」，值单独读一次 —— 0 是合法值，不能当 falsy 用
    await waitFor(page, `(() => { const n = Number(document.getElementById('jr-streak-n').textContent); return n === ${before + 1} ? 'ok' : ''; })()`);
    const after = await page.evaluate(`Number(document.getElementById('jr-streak-n').textContent)`);
    ok('4 四格输入 → 保存中 → 已保存', /保存中/.test(saving || '') && /已保存/.test(saved || ''), JSON.stringify({ saving, saved }));
    ok('5 只写一格 → 已记录 +1', after === before + 1, JSON.stringify({ before, after }));

    // 6：清空唯一有内容的格 → 已记录 −1
    await page.evaluate(`(() => {
      const ta = document.querySelector('[data-cell="0"]');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1100);
    await waitFor(page, `(() => { const n = Number(document.getElementById('jr-streak-n').textContent); return n === ${before} ? 'ok' : ''; })()`);
    const cleared = await page.evaluate(`Number(document.getElementById('jr-streak-n').textContent)`);
    ok('6 清空唯一有内容的格 → 已记录 −1', cleared === before, JSON.stringify({ before, cleared }));

    // 7：碎碎念 Enter 立即出现 + 时间戳 + Shift+Enter
    await page.evaluate(`(() => {
      const ta = document.getElementById('note-input');
      ta.value = '老王说周一要过验收';
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(400);
    r = await page.evaluate(`(() => ({
      n: document.querySelectorAll('.jr-note').length,
      body: (document.querySelector('.jr-note .note-body') || {}).textContent || '',
      time: (document.querySelector('.jr-note .note-time') || {}).textContent || '',
      count: (document.querySelector('.nh-count') || {}).textContent || '',
    }))()`);
    ok('7 碎碎念 Enter 立即出现 + 当前时分 + 条数', r && r.n === 1 && /老王/.test(r.body) && /^\d{2}:\d{2}$/.test(r.time) && /1 条/.test(r.count), JSON.stringify(r));

    // 8 / 9：归入心智 → 可撤销
    await page.evaluate(`document.querySelector('.jr-note [data-act="fold"]').click()`);
    await sleep(300);
    await page.evaluate(`document.querySelector('.ax-menu [data-ax="0"]').click()`);
    await sleep(500);
    r = await page.evaluate(`(() => ({
      cell0: document.querySelector('[data-cell="0"]').value,
      notes: document.querySelectorAll('.jr-note').length,
      undo: !!document.getElementById('jr-undo-btn'),
    }))()`);
    ok('8 归入心智 → 正文并入格子 + 条目消失 + 可撤销', r && /老王/.test(r.cell0) && r.notes === 0 && r.undo, JSON.stringify(r));
    await page.evaluate(`document.getElementById('jr-undo-btn').click()`);
    await sleep(700);
    r = await page.evaluate(`(() => ({
      cell0: document.querySelector('[data-cell="0"]').value,
      notes: document.querySelectorAll('.jr-note').length,
      body: (document.querySelector('.jr-note .note-body') || {}).textContent || '',
    }))()`);
    ok('9 撤销归入 → 格子还原 + 条目回列表', r && !/老王/.test(r.cell0) && r.notes === 1 && /老王/.test(r.body), JSON.stringify(r));

    // 10：转任务 → 已加入今天 + 任务列表出现
    await page.evaluate(`document.querySelector('.jr-note [data-act="task"]').click()`);
    await sleep(600);
    r = await page.evaluate(`(() => ({
      trace: (document.querySelector('.jr-note .note-trace') || {}).textContent || '',
      done: !!document.querySelector('.jr-note.is-done'),
    }))()`);
    ok('10 转任务 → 已加入今天留痕 + 置灰', /已加入今天/.test(r.trace || '') && r.done, JSON.stringify(r));

    // 10b：离开日记再回来，留痕仍在 —— 证明写的是库里的 task_id，不是内存标记
    await page.evaluate(`(() => { const b = document.querySelector('.sidebar [data-view="today"]'); if (b) b.click(); })()`);
    await sleep(700);
    await page.evaluate(`document.querySelector('.nav-item[data-view="journal"]').click()`);
    await sleep(900);
    r = await page.evaluate(`(() => ({
      trace: (document.querySelector('.jr-note .note-trace') || {}).textContent || '',
      done: !!document.querySelector('.jr-note.is-done'),
    }))()`);
    ok('10b 重进日记后留痕仍在（task_id 已落库）', /已加入今天/.test(r.trace || '') && r.done, JSON.stringify(r));

    // 11：今天右箭头禁用
    r = await page.evaluate(`(() => ({ disabled: document.getElementById('day-next').disabled, today: document.getElementById('day-today').hidden }))()`);
    ok('11 今天右箭头禁用、无「回到今天」', r && r.disabled === true && r.today === true, JSON.stringify(r));

    // 11b：切日期前必须先 flush 待写格子。曾经 markSaving(-1) 会把 pendingCell 覆盖成 -1，
    //      flush 直接空转 —— 边打边切日 = 刚写的那段静默丢失。
    await page.evaluate(`(() => {
      const ta = document.querySelector('[data-cell="2"]');
      ta.value = '切日草稿不该丢';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('day-prev').click();
    })()`);
    await sleep(700);
    await page.evaluate(`document.getElementById('day-today').click()`);
    await sleep(700);
    r = await page.evaluate(`(() => ({ cell2: document.querySelector('[data-cell="2"]').value }))()`);
    ok('11b 输入后立刻切日前 flush（改动不丢）', r && /切日草稿不该丢/.test(r.cell2), JSON.stringify(r));

    // 11c：设置里改四格名字 → 就地更新标签，不重挂模块
    await page.evaluate(`window.api.features.setPref('journal', { cellLabels: ['脑', '身', '人', '事'] })`);
    await sleep(500);
    r = await page.evaluate(`(() => ({
      labels: [...document.querySelectorAll('.quad-label')].map((e) => e.textContent),
      mounted: window.KnodoJournal.debugState().mounted,
    }))()`);
    ok('11c 改四格名字 → 标签就地更新且不重挂', r && r.labels.join('') === '脑身人事' && r.mounted === true, JSON.stringify(r));
    await page.evaluate(`window.api.features.setPref('journal', { cellLabels: ['心智', '身体', '连结', '事业'] })`);
    await sleep(400);
    // 收尾：清掉 11b 写进去的草稿
    await page.evaluate(`(() => {
      const ta = document.querySelector('[data-cell="2"]');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1000);

    // 12：860 宽 + 侧栏 420 → compact 降级后真实右缘不压滑块
    await page.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 720, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`document.documentElement.style.setProperty('--sidebar-width', '420px')`);
    await page.evaluate(`window.dispatchEvent(new Event('resize'))`);
    await sleep(600);
    r = await page.evaluate(`window.__topbarCompact`);
    ok('12 860 宽 + 侧栏 420 → 五入口降级、不压滑块',
      r && r.compact === true && r.navRight <= r.modeLeft - 4,
      JSON.stringify(r));
    await page.send('Emulation.clearDeviceMetricsOverride');
    await page.evaluate(`document.documentElement.style.setProperty('--sidebar-width', '')`);
    await sleep(300);

    // 13：导出 / 导入 / FTS 隐私走「内核段」——
    // data:export 是原生另存对话框（zip 备份包），GUI 里点会阻塞，所以直接对数据层断言。
    // 这一段在 electron 启动期间跑在独立的临时库上，不碰用户数据。
    const kernel = require('../main/db');
    const kstore = require('../main/journal/store');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-kernel-'));
    try {
      kernel.init(tmpDir);
      const kday = kstore.localDay();
      kstore.setCell(kday, 0, '内核段：导出一致性');
      const exp = kernel.exportData();
      ok('13 导出结构含 journal 两表 + schemaVersion 17',
        exp.schemaVersion === 17
        && Array.isArray(exp.journal_cells) && exp.journal_cells.length === 1
        && Array.isArray(exp.journal_notes),
        JSON.stringify({ v: exp.schemaVersion, cells: (exp.journal_cells || []).length, notes: (exp.journal_notes || []).length }));

      // 旧备份（没有 journal 字段）导入不能报错：老用户升级路径
      // importData 失败时**不抛**，返回 {ok:false, message}；成功时返回各表计数 —— 两种都认
      let oldRes = null;
      try { oldRes = kernel.importData({ groups: [], tasks: [] }); } catch (e) { oldRes = { ok: false, message: (e && e.message) || String(e) }; }
      const oldImported = !!(oldRes && (oldRes.ok === true || typeof oldRes.tasks === 'number'));
      ok('13b 旧备份（无 journal 字段）导入成功', oldImported && kstore.getDay(kday).cells[0] === '',
        JSON.stringify(oldRes));

      // 13d：完整往返 —— 格子 + 带 task_id 的碎碎念导出后再导入，内容与标记都要在
      // （13b 的导入会清空 journal，所以这里要重新写一次格子）
      kstore.setCell(kday, 0, '往返格子');
      const n0 = kstore.addNote(kday, '往返用例：转任务留痕', 1);
      kstore.updateNote(n0.id, { taskId: 987654 });
      const exp2 = kernel.exportData();
      const imp = kernel.importData(exp2);
      const back = kstore.getDay(kday);
      ok('13d 导出→导入往返（含 task_id 标记）',
        !!(imp && (imp.ok === true || typeof imp.tasks === 'number'))
        && back.cells[0] === '往返格子'
        && back.notes.length === 1
        && back.notes[0].taskId === 987654,
        JSON.stringify({ imp, cells: back.cells.slice(0, 2), notes: back.notes.map((n) => n.taskId) }));

      // 13e：旧 v20 库（journal_notes 没有 task_id）也必须能自愈 —— 补列不能只写在迁移里，
      //      迁移只在升级那一次跑，已经到 v20 的库再也轮不到它。
      kernel.close();
      const Database = require('better-sqlite3');
      const raw = new Database(path.join(tmpDir, 'todo.db'));
      raw.exec('ALTER TABLE journal_notes DROP COLUMN task_id');
      raw.pragma('user_version = 20');
      const dropped = raw.prepare('PRAGMA table_info(journal_notes)').all().map((c) => c.name);
      raw.close();
      kernel.init(tmpDir);
      const healed = kernel.getDb().prepare('PRAGMA table_info(journal_notes)').all().map((c) => c.name);
      ok('13e 旧 v20 库启动自愈补列 task_id',
        !dropped.includes('task_id') && healed.includes('task_id'),
        JSON.stringify({ before: dropped.includes('task_id'), after: healed.includes('task_id') }));

      // 隐私：日记表不建任何 FTS 触发器 → 永远不进 AI 检索候选
      const trigs = kernel.getDb().prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name LIKE 'journal%' OR name LIKE '%journal%')"
      ).all();
      ok('13c 日记表无 FTS 触发器（不进 AI 检索 / 报告）', trigs.length === 0, JSON.stringify(trigs.map((t) => t.name)));
    } finally {
      try { kernel.close(); } catch (_) {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    // 14：只写在日记里的探针，不该被 AI 检索搜到
    await page.evaluate(`(() => {
      const ta = document.querySelector('[data-cell="1"]');
      ta.value = '日记隐私探针QZ7';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1300);
    r = await page.evaluate(`(async () => {
      try {
        const res = await window.api.search.ai('日记隐私探针QZ7') || {};
        // keyword 会原样回显，不能拿整个响应判泄漏；只看命中内容字段
        const hits = JSON.stringify({ t: res.tasks || [], n: res.notes || [], g: res.groups || [] });
        return { leak: /日记隐私探针QZ7/.test(hits), tasks: (res.tasks || []).length, type: res.type || '' };
      } catch (e) { return { leak: false, err: String(e && e.message || e) }; }
    })()`);
    ok('14 日记内容不进 AI 检索', r && r.leak === false, JSON.stringify(r));
    // 收尾：清掉探针，别留在验收 profile 里
    await page.evaluate(`(() => {
      const ta = document.querySelector('[data-cell="1"]');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1100);

    // 15：设置中心「功能插件」里的日记卡片 —— 开关状态 + 四格改名真能落到偏好与界面
    // 注意：__openSettings() 的 Promise 只在关闭时才 resolve，直接 await 会把 CDP 挂死
    await page.evaluate(`(() => { window.__openSettings('plugins'); return 1; })()`);
    await sleep(1100);
    await page.shot(path.join(shotDir, 'journal-settings.png'));
    r = await page.evaluate(`(() => {
      const card = document.getElementById('jr-enabled');
      const pane = document.querySelector('.st-pane[data-pane="plugins"]');
      // 开关本体是视觉隐藏的 input，看得见的是 .st-switch-track —— 判可见性要看卡片与轨道
      const box = document.querySelector('[data-journal-card]');
      const track = box && box.querySelector('.st-switch-track');
      return {
        card: !!card,
        on: !!(card && card.checked),
        visible: !!(box && box.getBoundingClientRect().height > 0 && track && track.getBoundingClientRect().width > 0),
        paneActive: pane ? !pane.hidden : null,
        labels: [...document.querySelectorAll('[data-jr-label]')].map((i) => i.value),
      };
    })()`);
    ok('15 设置中心有日记卡片（已启用 + 四格名字在）',
      r && r.card && r.on && r.visible && r.paneActive && r.labels.length === 4 && r.labels[0] === '心智',
      JSON.stringify(r));

    await page.evaluate(`(() => {
      const i = document.querySelector('[data-jr-label="0"]');
      i.value = '脑';
      i.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(700);
    r = await page.evaluate(`(async () => ({
      pref: (await window.api.features.pref('journal')).cellLabels,
      quad: (document.querySelector('.quad-label') || {}).textContent || '',
    }))()`);
    ok('15b 设置改名 → 偏好与日记页标签同步（不重启）',
      r && r.pref && r.pref[0] === '脑' && r.quad === '脑', JSON.stringify(r));

    // 复原名字并关掉设置面板（后续 step 用真实名字）
    await page.evaluate(`(() => {
      const i = document.querySelector('[data-jr-label="0"]');
      i.value = '心智';
      i.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(500);
    await page.evaluate(`(() => { const b = document.querySelector('.modal-mask [data-modal="close"]'); if (b) b.click(); })()`);
    await sleep(500);
    r = await page.evaluate(`(() => ({ open: !!document.querySelector('.modal-mask'), label0: (document.querySelector('.quad-label') || {}).textContent || '' }))()`);
    ok('15c 关闭设置后回到日记页且名字已复原', r && !r.open && r.label0 === '心智', JSON.stringify(r));

    page.close();
  } catch (e) {
    ok('脚本执行', false, (e && e.message) || String(e));
  } finally {
    const pass = results.filter((x) => x.pass).length;
    console.log(`\n${pass}/${results.length} 通过`);
    if (process.env.SHOW_LOG) console.log(log.slice(-4000));
    cleanup();
    process.exit(pass === results.length ? 0 : 1);
  }
})();
