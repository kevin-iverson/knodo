'use strict';
/**
 * 国际化（界面语言）端到端验证。
 * 用法：npm run verify:i18n          # 加 --shots 会额外截一张英文界面图
 *
 * 必须真跑 Electron 的理由：
 *   · 语言存在主进程 settings 表里，渲染层要经 IPC 才能拿到 —— Node 里验不到这段回环；
 *   · 切语言靠「广播 → 各窗口 reload」，reload 后首屏是否真的是英文，只有真窗口知道；
 *   · 静态文案走 data-i18n 属性，得看应用后的真实 DOM，而不是源码里有没有写属性。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9491';
const profile = path.join(os.tmpdir(), `knodo-i18n-${Date.now()}`);
const shotsDir = path.join(os.tmpdir(), 'knodo-i18n-shots');
const wantShots = process.argv.includes('--shots');
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

async function findPage() {
  for (let i = 0; i < 80; i += 1) {    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const hit = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (hit) return hit;
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

/** 首屏快照：把「静态骨架 + 视图标题」一起读出来，一次断言 */
const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  const txt = (s) => { const el = q(s); return el ? el.textContent.trim().replace(/\\s+/g, ' ') : null; };
  const nav = [...document.querySelectorAll('.sidebar .nav-item')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim());
  return {
    lang: document.documentElement.lang,
    viewTitle: txt('#view-title'),
    nav,
    newTask: txt('#btn-new-task'),
    ai: txt('#btn-ai-search'),
    searchPh: q('#search-input') ? q('#search-input').placeholder : null,
    sortOpts: [...document.querySelectorAll('#sort-select option')].map((o) => o.textContent.trim()),
    settingsTitle: q('#btn-settings') ? q('#btn-settings').title : null,
    groupHead: txt('.section-head span'),
    minWin: q('[data-win="min"]') ? q('[data-win="min"]').title : null,
    i18nKeys: document.querySelectorAll('[data-i18n]').length,
    leftover: (() => {
      // 英文态下还有多少「挂着 data-i18n 却没被换掉」的元素（说明词条缺失）
      return [...document.querySelectorAll('[data-i18n]')]
        .filter((el) => /[\\u4e00-\\u9fa5]/.test(el.textContent))
        .map((el) => el.getAttribute('data-i18n')).slice(0, 8);
    })(),
  };
})()`;

(async () => {
  const results = [];
  // 端口被上一个没退干净的实例占着时，连到的会是旧页面（语言还停在上次的值），
  // 结果看起来像「全部断言失败」。宁可直接报错也不要给出误导性报告。
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (probe.ok) {
      console.error(`端口 ${port} 已被占用（可能有未退出的调试实例），请先关闭后重试`);
      process.exit(2);
    }
  } catch (_) { /* 连不上 = 端口空闲，正常 */ }

  const ok = (name, pass, extra) => {
    results.push({ name, pass: !!pass });
    console.log(`${pass ? '✓' : '✗'} ${name}${extra == null ? '' : `  ${String(extra).slice(0, 220)}`}`);
  };

  const shot = async (page, name) => {
    if (!wantShots) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(shotsDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  ↳ ${file}`);
  };

  try {
    const target = await findPage();
    let page = await connect(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await sleep(1600);

    /* ---- 1) 默认中文 ---- */
    const zh = await page.evaluate(SNAP);
    ok('默认语言是简体中文', zh.lang === 'zh-CN' && zh.viewTitle === '今天', `${zh.lang} / ${zh.viewTitle}`);
    ok('侧栏 9 个导航项是中文', zh.nav.length === 9 && zh.nav[0].includes('今天'), zh.nav[0]);
    ok('顶栏按钮是中文', zh.newTask === '＋ 新建任务' && zh.ai === '🔍 AI 检索', `${zh.newTask} | ${zh.ai}`);
    ok('data-i18n 属性已铺开', zh.i18nKeys >= 35, zh.i18nKeys);

    /* ---- 2) 主进程语言值 ---- */
    const mainLoc = await page.evaluate('window.api.i18n.get()');
    ok('主进程返回 zh-CN', mainLoc === 'zh-CN', mainLoc);
    const list = await page.evaluate('window.api.i18n.list()');
    ok('语言清单含中文与英文', Array.isArray(list) && list.length === 2
      && list.some((x) => x.value === 'en'), JSON.stringify(list));

    /* ---- 3) 切英文 → 窗口 reload ---- */
    await page.evaluate('void window.api.i18n.set("en")');
    await sleep(3200);
    page.close();
    const target2 = await findPage();
    page = await connect(target2.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await sleep(1800);

    const en = await page.evaluate(SNAP);
    ok('reload 后 html lang=en', en.lang === 'en', en.lang);
    ok('视图标题变 Today', en.viewTitle === 'Today', en.viewTitle);
    ok('侧栏导航变英文', en.nav.length === 9 && en.nav.every((s) => /^[^A-Za-z]*[A-Za-z]/.test(s))
      && en.nav.some((s) => s.includes('Today')) && en.nav.some((s) => s.includes('Upcoming')), en.nav.join(' / '));
    ok('顶栏按钮变英文', en.newTask === '＋ New Task' && en.ai === '🔍 AI Search', `${en.newTask} | ${en.ai}`);
    ok('搜索框 placeholder 变英文', en.searchPh === 'Search tasks / tags…', en.searchPh);
    ok('排序下拉四项变英文', en.sortOpts.join(',') === 'Smart,Priority,Due date,Manual (drag)', en.sortOpts.join(','));
    ok('窗口按钮 tooltip 变英文', en.minWin === 'Minimize', en.minWin);
    ok('设置齿轮 tooltip 变英文', String(en.settingsTitle).startsWith('Settings'), en.settingsTitle);
    ok('英文态无残留中文（data-i18n 全覆盖）', !en.leftover || en.leftover.length === 0, JSON.stringify(en.leftover));
    await shot(page, 'en-main');

    /* ---- 4) 设置中心：语言下拉 + 导航 ---- */
    const st = await page.evaluate(`(async () => {
      document.getElementById('btn-settings').click();
      for (let i = 0; i < 40; i += 1) {
        if (document.querySelector('#st-locale')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const sel = document.querySelector('#st-locale');
      const nav = [...document.querySelectorAll('.st-nav-text')].map((b) => b.textContent.trim());
      const page1 = document.querySelector('.st-page-title');
      return {
        hasSelect: !!sel,
        value: sel ? sel.value : null,
        options: sel ? [...sel.options].map((o) => o.textContent.trim()) : [],
        nav, page1: page1 ? page1.textContent.trim() : null,
        groupLabels: [...document.querySelectorAll('.st-group-label')].map((b) => b.textContent.trim()),
        foot: (() => { const f = document.querySelector('.st-foot-hint'); return f ? f.textContent.trim() : null; })(),
      };
    })()`);
    ok('设置里「界面语言」下拉存在', st.hasSelect);
    ok('下拉当前值 = en', st.value === 'en', st.value);
    ok('下拉两项用本体语言写', st.options.join(',') === '简体中文,English', st.options.join(','));
    ok('设置导航已英文化', st.nav[0] === 'Appearance' && st.nav.includes('Plugins'), st.nav.join(' / '));
    ok('分区标题已英文化', st.page1 === 'Appearance', st.page1);
    ok('导航分组标题已英文化', st.groupLabels.includes('Data & security'), st.groupLabels.join(' / '));
    ok('页脚提示已英文化', st.foot === 'All changes apply immediately — nothing to save', st.foot);
    await shot(page, 'en-settings');

    /* ---- 4b) 逐个设置分区扫残留中文（含 AI / 快捷键 / 日历 / 工具 / 数据 / 文档 / 关于） ---- */
    const panes = await page.evaluate(`[...document.querySelectorAll('.st-nav-item')].map((x) => x.dataset.nav)`);
    ok('设置分区数 = 11', Array.isArray(panes) && panes.length === 11, (panes || []).join(' / '));
    const paneLeft = [];
    for (const pane of panes || []) {
      await page.evaluate(`(() => { const b = [...document.querySelectorAll('.st-nav-item')].find((x) => x.dataset.nav === ${JSON.stringify(pane)}); if (b) b.click(); })()`);
      await sleep(260);
      const r = await page.evaluate(`(() => {
        const scope = document.querySelector('.st-pane[data-pane=${JSON.stringify(pane)}]:not([hidden])');
        if (!scope) return ['no-pane'];
        const out = [];
        const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const s = n.nodeValue.trim();
          if (!s || !/[\\u4e00-\\u9fa5]/.test(s)) continue;
          // 「简体中文」是语言本体名（下拉里按本体语言写），不算漏翻
          if (s === '简体中文') continue;
          out.push(s.slice(0, 40));
        }
        return out;
      })()`);
      if (r && r.length) paneLeft.push(`${pane}: ${r.slice(0, 3).join(' | ')}`);
    }
    ok('设置各分区无残留中文', paneLeft.length === 0, paneLeft.join(' ; '));

    /* ---- 4c) 日历：7 列表头必须是缩写，否则英文周名会挤爆 ---- */
    const cal = await page.evaluate(`(async () => {
      const close = document.querySelector('.modal-settings [data-modal="close"]');
      if (close) close.click();
      for (let i = 0; i < 40; i += 1) {
        if (!document.querySelector('.modal-settings')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const nav = document.querySelector('.nav-item[data-view="calendar"]');
      if (nav) nav.click();
      for (let i = 0; i < 30; i += 1) {
        if (document.querySelector('.cal-weekdays span')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const days = [...document.querySelectorAll('.cal-weekdays span')].map((x) => x.textContent.trim());
      const todayBtn = document.querySelector('.cal-today');
      return { days, today: todayBtn ? todayBtn.textContent.trim() : null, todayH: todayBtn ? todayBtn.getBoundingClientRect().height : 0 };
    })()`);
    ok('日历周名是缩写', cal.days.length === 7 && cal.days.every((d) => d.length <= 4), cal.days.join(' '));
    ok('日历「Back to today」单行', cal.today === 'Back to today' && cal.todayH > 0 && cal.todayH < 30, `${cal.today} h=${cal.todayH}`);

    /* ---- 5) 切回中文 ---- */
    await page.evaluate('void window.api.i18n.set("zh-CN")');
    await sleep(3200);
    page.close();
    const target3 = await findPage();
    page = await connect(target3.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await sleep(1600);
    const back = await page.evaluate(SNAP);
    ok('切回中文后标题恢复', back.lang === 'zh-CN' && back.viewTitle === '今天', `${back.lang} / ${back.viewTitle}`);
    ok('切回中文后侧栏恢复', back.nav[0].includes('今天'), back.nav[0]);

    /* ---- 6) 主进程侧（托盘 / 菜单）也读到 zh-CN ---- */
    const backLoc = await page.evaluate('window.api.i18n.get()');
    ok('主进程语言回到 zh-CN', backLoc === 'zh-CN', backLoc);

    /* ---- 7) 渲染层未捕获异常 ---- */
    const errs = await page.evaluate('(window.__knodoI18nErrors || []).length');
    ok('切语言过程无渲染层异常', (errs || 0) === 0, errs);

    page.close();
  } catch (e) {
    console.error('验证中断：', e && e.message);
    if (log) console.error(log.slice(-1500));
    results.push({ name: '脚本执行', pass: false });
  } finally {
    cleanup();
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('失败项：' + bad.map((b) => b.name).join('、'));
    process.exitCode = 1;
  }
})();
