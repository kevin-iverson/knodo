'use strict';
/**
 * 桌面浮窗「任务归属小字」验收。
 *
 * 背景（用户拍板）：钉在桌面的跨清单浮窗把多个清单的任务混在一屏里，
 * 每条任务都该默认显示它属于哪个分组 —— 不只是撞名了才亮出来。
 *
 * 设计约束（断言就是这些约束）：
 *  1. **跨清单投影每行都多一行小字**（今天/即将/未完成）：唯一名、同清单同名也是两行；
 *  2. 归属取分组名，空分组写「未分组」，并带一个分组色圆点（未分组无色点）；
 *  3. 单清单浮窗（kind:'group'）标题已是清单名 → 不显示分组名（重复无意义）；
 *  4. 两行行高必须被内容撑开且不把标题挤没（标题行仍有可用宽度），列表不横向溢出；
 *  5. 归属只在数据真变了时才重绘（取消重名、改分组后仍显示新归属，不残留旧值）。
 *
 * 用法：node scripts/verify-dock-dup.js [port] [--shots]
 *   --shots 把两段结果各截一张到 %TEMP%/knodo-dock-dup-{1-mixed,2-group}.png
 *   （浮窗是透明窗，截图带 alpha —— 看效果时铺一层浅底更准）
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '9536';
const shots = process.argv.includes('--shots');
const profile = path.join(os.tmpdir(), `knodo-dock-dup-${Date.now()}`);
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
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
}
process.on('exit', killChild);
process.on('SIGINT', () => { killChild(); process.exit(130); });

/** #4f7cff → rgb(79, 124, 255)：computed style 里的颜色一律是 rgb() 形式 */
const hexToRgb = (h) => {
  const s = String(h || '').replace('#', '');
  const parts = s.length >= 6
    ? [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)]
    : [...s].map((c) => c + c);
  return `rgb(${parts.map((x) => parseInt(x, 16)).join(', ')})`;
};

async function listPages() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) {
        return list.filter((t) => t.type === 'page');
      }
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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
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
    send,
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

/**
 * 截一张浮窗：透明窗截图带 alpha，铺一层与主题同色的底才看得清层次。
 * 深浅两套都出 —— 10px 小字 + 分组色圆点在深色下的可读性是这次改动的真实风险点，
 * 只截浅色等于没验。
 */
async function shoot(page, name) {
  if (!shots) return;
  // 主题令牌是 theme-core.paint() 写进 :root 的内联变量，改 data-theme 属性盖不过它 ——
  // 必须走 paint() 本身才能真的换一套配色。
  let base = null;
  try { base = await page.evaluate('window.api.theme.get()'); } catch (_) { base = null; }
  const apply = (mode) => page.evaluate(`window.KnodoTheme.paint(${JSON.stringify({
    ...(base || {}),
    mode,
    backdrop: { type: 'none', image: '', missing: false },
  })})`);
  const themes = [
    ['light', { r: 253, g: 248, b: 238, a: 1 }],
    ['dark', { r: 36, g: 29, b: 21, a: 1 }],
  ];
  for (const [theme, bg] of themes) {
    try {
      await apply(theme);
      await page.send('Emulation.setDefaultBackgroundColorOverride', { color: bg });
      const img = await page.send('Page.captureScreenshot', { format: 'png' });
      const out = path.join(os.tmpdir(), `knodo-dock-dup-${name}-${theme}.png`);
      fs.writeFileSync(out, Buffer.from(img.data, 'base64'));
      console.log(`[DOCK-DUP] 截图：${out}`);
    } catch (e) {
      console.log('[DOCK-DUP] 截图失败：', (e && e.message) || e);
    }
  }
  if (base) { try { await apply(base.mode || 'light'); } catch (_) { /* 复原失败不影响断言 */ } }
}

/** 等浮窗页面出现（pin 之后要等窗口 + 页面就绪） */async function waitDockPage(skipUrls = []) {
  for (let i = 0; i < 40; i += 1) {
    const pages = await listPages();
    const hit = pages.find((t) => /desktop\.html/.test(t.url) && !skipUrls.includes(t.url));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

(async () => {
  const checks = [];
  const ck = (name, ok, extra) => checks.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
  const fail = (msg, extra) => {
    console.log(`[DOCK-DUP] FAIL：${msg}`);
    if (extra) console.log(`[DOCK-DUP] ${JSON.stringify(extra)}`);
    if (childLog) console.log('[DOCK-DUP] 窗口日志：', childLog.split('\n').slice(-10).join(' | '));
    killChild();
    process.exit(1);
  };

  try {
    await listPages();
    const pages = await listPages();
    const mainPage = pages.find((t) => /index\.html/.test(t.url));
    if (!mainPage) fail('没找到主窗口页面');
    const main = await connect(mainPage.webSocketDebuggerUrl);
    await sleep(1200);

    /* ---- 造数：两个清单各一条同名「周报」+ 一条唯一名 + 清单甲内两条同名 ---- */
    const setup = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const info = await window.api.env.getStorageInfo();
      if (!/knodo-dock-dup-/.test(JSON.stringify(info || {}))) throw new Error('数据目录未隔离，已中止：' + JSON.stringify(info));
      for (let i = 0; i < 80 && !window.__appReady; i += 1) await wait(100);
      const ga = await window.api.groups.create({ name: '项目甲', color: '#4f7cff' });
      const gb = await window.api.groups.create({ name: '项目乙', color: '#e5484d' });
      // 跨清单重名：这条是本功能的靶子
      const a1 = await window.api.tasks.create({ title: '周报', groupId: ga.id });
      const b1 = await window.api.tasks.create({ title: '周报', groupId: gb.id });
      // 唯一名：必须保持单行，用来对照行高
      const uniq = await window.api.tasks.create({ title: '唯一的周会纪要', groupId: ga.id });
      // 同清单重名：没有任何能区分它们的归属 → 一行字都不该加（混合视图里也是）
      const d1 = await window.api.tasks.create({ title: '周会准备', groupId: ga.id });
      const d2 = await window.api.tasks.create({ title: '周会准备', groupId: ga.id });
      // 一条有清单、一条没清单：归属仍能区分 → 空的那条写「未分组」
      const mix1 = await window.api.tasks.create({ title: '同步评审', groupId: ga.id });
      const mix2 = await window.api.tasks.create({ title: '同步评审' });
      // 钉「未完成」：跨清单混合视图，正是用户报的场景
      const pin = await window.api.desktop.pin('unfinished', null, {});
      await wait(1400);
      return {
        ga: ga.id, gb: gb.id, a1: a1.id, b1: b1.id, uniq: uniq.id, d1: d1.id, d2: d2.id,
        mix1: mix1.id, mix2: mix2.id,
        projections: await window.api.desktop.list(),
      };
    })()`);
    if (!setup || !setup.a1) fail('造数失败', setup);

    const dockPage = await waitDockPage();
    if (!dockPage) fail('浮窗页面没创建（desktop:pin 失败）');
    const dock = await connect(dockPage.webSocketDebuggerUrl);
    await sleep(1500);

    /* ---- A. 混合视图：两条同名行各带自己的分组名 + 色点 ---- */
    const a = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 20 && !document.querySelector('.dw-row[data-id="${setup.a1}"]'); i += 1) await wait(150);
      const row = (id) => document.querySelector('.dw-row[data-id="' + id + '"]');
      const sub = (el) => el && el.querySelector('.dw-sub');
      const probe = (el) => {
        if (!el) return null;
        const s = sub(el);
        const dot = el.querySelector('.dw-sub-dot');
        const t = el.querySelector('.dw-t');
        return {
          hasSub: el.classList.contains('has-sub'),
          name: s ? ((el.querySelector('.dw-sub-name') || {}).textContent || '').trim() : '',
          subTitle: s ? s.getAttribute('title') : '',
          dot: dot ? getComputedStyle(dot).backgroundColor : '',
          h: Math.round(el.getBoundingClientRect().height),
          titleText: t ? t.textContent.trim() : ((el.querySelector('.dw-text') || {}).textContent || '').trim(),
          titleW: (el.querySelector('.dw-text') || { clientWidth: 0 }).clientWidth,
        };
      };
      const listEl = document.getElementById('dw-list');
      return {
        a1: probe(row('${setup.a1}')),
        b1: probe(row('${setup.b1}')),
        uniq: probe(row('${setup.uniq}')),
        d1: probe(row('${setup.d1}')),
        d2: probe(row('${setup.d2}')),
        mix1: probe(row('${setup.mix1}')),
        mix2: probe(row('${setup.mix2}')),
        overflowX: listEl.scrollWidth - listEl.clientWidth,
        rowCount: document.querySelectorAll('.dw-row[data-id]').length,
      };
    })()`);

    ck('浮窗把两条同名任务都画出来了', a.rowCount >= 5, a.rowCount);
    ck('重名行标记 has-sub', a.a1 && a.a1.hasSub && a.b1 && a.b1.hasSub, JSON.stringify([a.a1 && a.a1.hasSub, a.b1 && a.b1.hasSub]));
    ck('重名行归属 = 各自清单名且互不相同',
      a.a1 && a.b1 && a.a1.name === '项目甲' && a.b1.name === '项目乙',
      `${a.a1 && a.a1.name} / ${a.b1 && a.b1.name}`);
    ck('归属行带「归属：」悬停提示',
      a.a1 && /归属：项目甲/.test(a.a1.subTitle), a.a1 && a.a1.subTitle);
    ck('色点 = 各自清单色',
      a.a1 && a.b1 && a.a1.dot === hexToRgb('#4f7cff') && a.b1.dot === hexToRgb('#e5484d'),
      `${a.a1 && a.a1.dot} / ${a.b1 && a.b1.dot}`);
    ck('唯一名行也显示分组名（默认展示而非撞名才亮）',
      a.uniq && a.uniq.hasSub && a.uniq.name === '项目甲', JSON.stringify(a.uniq));
    ck('唯一名行同样被撑成两行', a.uniq && a.uniq.h > 34 && a.uniq.h < 56, a.uniq && a.uniq.h);
    ck('重名行被两行内容撑高但仍矮于 56px',
      a.a1 && a.a1.h > 34 && a.a1.h < 56, a.a1 && a.a1.h);
    ck('两行行高一致（不因分组名长短跳动）',
      a.a1 && a.b1 && Math.abs(a.a1.h - a.b1.h) <= 1, `${a.a1 && a.a1.h}/${a.b1 && a.b1.h}`);
    ck('标题没被归属小字挤没（宽度 ≥60px）', a.a1 && a.a1.titleW >= 60, a.a1 && a.a1.titleW);
    ck('标题文本仍是原任务名', a.a1 && a.a1.titleText === '周报', a.a1 && a.a1.titleText);
    ck('列表无横向溢出（286px 窄窗）', a.overflowX <= 1, a.overflowX);
    // 默认展示：两条同清单同名任务也各写一遍「项目甲」——分组是固有属性，不再按区分力省略
    ck('同清单同名行也显示分组名',
      a.d1 && a.d2 && a.d1.hasSub && a.d2.hasSub
        && a.d1.name === '项目甲' && a.d2.name === '项目甲',
      JSON.stringify([a.d1 && a.d1.name, a.d2 && a.d2.name]));
    ck('有清单 / 无清单的同名行都加归属',
      a.mix1 && a.mix2 && a.mix1.hasSub && a.mix2.hasSub,
      JSON.stringify([a.mix1 && a.mix1.hasSub, a.mix2 && a.mix2.hasSub]));
    ck('无清单那条写「未分组」且不带清单色',
      a.mix2 && a.mix2.name === '未分组' && a.mix2.dot !== a.mix1.dot,
      `${a.mix2 && a.mix2.name} / ${a.mix2 && a.mix2.dot} vs ${a.mix1 && a.mix1.dot}`);

    await shoot(dock, '1-mixed');

    /* ---- B. 取消其中一个重名 → 剩下的那条仍显示归属（默认展示，不随重名状态变化） ---- */
    const b = await dock.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      // 走真实路径：在浮窗里勾掉「项目乙」的那条，浮窗只画未完成行 → 只剩一条「周报」
      const box = document.querySelector('.dw-row[data-id="${setup.b1}"] [data-act="toggle"]');
      if (!box) return { err: '没有复选框' };
      box.click();
      await wait(1400);
      const left = document.querySelector('.dw-row[data-id="${setup.a1}"]');
      return {
        leftHasSub: !!left && left.classList.contains('has-sub'),
        leftH: left ? Math.round(left.getBoundingClientRect().height) : 0,
        leftSubName: left && left.querySelector('.dw-sub-name')
          ? left.querySelector('.dw-sub-name').textContent.trim() : '',
      };
    })()`);
    ck('重名消失后归属仍在（默认展示不回退）',
      b.leftHasSub === true && b.leftH > 34 && b.leftSubName === '项目甲',
      `${b.leftHasSub}/${b.leftH}/${b.leftSubName}`);
    ck('归属小字保留正确分组名', b.leftSubName === '项目甲', b.leftSubName);

    // 还原：把勾掉的取消完成，便于下一段断言「周报」仍在清单甲里
    await main.evaluate(`window.api.tasks.toggle(${setup.b1})`);
    await sleep(600);

    /* ---- C. 单清单投影：同名不显示分组名（同清单的分组名没有区分力） ---- */
    const relink = await main.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      for (const p of await window.api.desktop.list()) await window.api.desktop.unpin(p.id);
      await wait(600);
      await window.api.desktop.pin('group', ${setup.ga}, {});
      await wait(1400);
      return { ok: true };
    })()`);
    if (!relink || !relink.ok) fail('切换单清单投影失败');

    const dockPage2 = await waitDockPage([dockPage.url]);
    if (!dockPage2) fail('单清单浮窗页面没出现');
    const dock2 = await connect(dockPage2.webSocketDebuggerUrl);
    await sleep(1500);

    const c = await dock2.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 20 && !document.querySelector('.dw-row[data-id="${setup.d1}"]'); i += 1) await wait(150);
      const row = (id) => document.querySelector('.dw-row[data-id="' + id + '"]');
      const names = [...document.querySelectorAll('.dw-sub-name')].map(e => e.textContent.trim());
      return {
        rows: [...document.querySelectorAll('.dw-row[data-id]')].map(e => e.dataset.id),
        d1HasSub: !!row('${setup.d1}') && row('${setup.d1}').classList.contains('has-sub'),
        d2HasSub: !!row('${setup.d2}') && row('${setup.d2}').classList.contains('has-sub'),
        subNames: names,
      };
    })()`);
    ck('单清单浮窗把两条同清单同名任务都画出来了',
      c.rows.includes(String(setup.d1)) && c.rows.includes(String(setup.d2)), JSON.stringify(c.rows));
    ck('单清单投影下不显示分组名（无区分力）',
      c.d1HasSub === false && c.d2HasSub === false && c.subNames.length === 0,
      JSON.stringify([c.d1HasSub, c.d2HasSub, c.subNames]));

    await shoot(dock2, '2-group');

    await main.close();
    await dock.close();
    await dock2.close();

    let failed = 0;
    for (const c2 of checks) {
      console.log(`  ${c2.ok ? '✓' : '✗'} ${c2.name}${c2.extra ? `  → ${c2.extra}` : ''}`);
      if (!c2.ok) failed += 1;
    }
    console.log(failed
      ? `\n[DOCK-DUP] DOCK_DUP_FAIL ${failed}/${checks.length}`
      : `\n[DOCK-DUP] DOCK_DUP_OK ${checks.length}/${checks.length}`);
    killChild();
    process.exit(failed ? 1 : 0);
  } catch (e) {
    fail('检测异常：' + ((e && e.message) || e));
  }
})();
