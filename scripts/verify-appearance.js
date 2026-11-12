'use strict';
/**
 * 外观（模式 × 风格 × 背景图）端到端验证。
 * 用法：npm run verify:appearance
 *
 * 为什么必须真跑 Electron：配色是 CSS 变量 + getComputedStyle 的联动，
 * 透明度补偿 / 护栏 / scrim 又是「主进程存 → 渲染层算 → CSS 生效」三段链路，
 * 在 Node 里验不到任何一段。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9481';
const profile = path.join(os.tmpdir(), `knodo-appearance-${Date.now()}`);
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

(async () => {
  const results = [];
  const ok = (name, pass, extra) => {
    results.push({ name, pass: !!pass });
    console.log(`${pass ? '✓' : '✗'} ${name}${extra == null ? '' : `  ${String(extra).slice(0, 220)}`}`);
  };

  try {
    const list = await pages();
    const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    const page = await connect(target.webSocketDebuggerUrl);
    await sleep(1200);

    /* ---- 0) 基础：theme-core 已加载、背景层存在 ---- */
    const boot = await page.evaluate(`(() => ({
      ready: !!window.__appReady,
      hasCore: !!window.KnodoTheme,
      hasLayer: !!document.getElementById('app-backdrop'),
      styles: window.KnodoTheme ? window.KnodoTheme.ORDER.length : 0,
      theme: document.documentElement.getAttribute('data-theme'),
      style: document.documentElement.getAttribute('data-style'),
    }))()`);
    ok('渲染层就绪', boot.ready);
    ok('theme-core 已加载且 6 套风格', boot.hasCore && boot.styles === 6, JSON.stringify(boot.styles));
    ok('背景层 DOM 存在', boot.hasLayer);
    ok('启动即有 data-theme / data-style', !!boot.theme && !!boot.style, `${boot.theme} / ${boot.style}`);

    /* ---- 1) 12 组 token：每组都真的改到了 CSS ---- */
    const tokens = await page.evaluate(`(() => {
      const KT = window.KnodoTheme;
      const out = [];
      for (const id of KT.ORDER) {
        for (const mode of ['light', 'dark']) {
          KT.paint({ mode, style: id, backdrop: { type: 'none' } });
          const cs = getComputedStyle(document.documentElement);
          out.push({
            id, mode,
            attr: document.documentElement.getAttribute('data-style') + '/' + document.documentElement.getAttribute('data-theme'),
            bg: cs.getPropertyValue('--bg-rgb').trim(),
            panel: cs.getPropertyValue('--panel-rgb').trim(),
            primary: cs.getPropertyValue('--primary-rgb').trim(),
            text: cs.getPropertyValue('--text-rgb').trim(),
            expectBg: KT.triple(KT.STYLES[id][mode].bg),
            expectPrimary: KT.triple(KT.STYLES[id][mode].primary),
          });
        }
      }
      return out;
    })()`);
    const bad = tokens.filter((t) => t.bg !== t.expectBg || t.primary !== t.expectPrimary);
    ok('12 组风格×明暗 token 全部生效', bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 3)) : `${tokens.length} 组`);

    /* ---- 2) 透明度补偿公式 ---- */
    const alpha = await page.evaluate(`(() => {
      const KT = window.KnodoTheme;
      const mk = (op) => KT.resolve({ mode: 'light', style: 'mist', backdrop: { type: 'image', image: 'theme/x.jpg', opacity: op, luma: 0.5, glass: true } });
      const a0 = mk(0), a60 = mk(60), a100 = mk(100);
      return {
        a0: a0.alpha, a60: a60.alpha, a100: a100.alpha,
        showAt0: !!a0.url, showAt60: !!a60.url,
        glass: a60.glass,
      };
    })()`);
    ok('透明度 0 → alpha 1.00 且不渲染图片层', alpha.a0 === 1 && alpha.showAt0 === false, JSON.stringify(alpha));
    ok('透明度 60 → alpha 0.83（雾灰 .72）', Math.abs(alpha.a60 - 0.832) < 0.01, alpha.a60);
    ok('透明度 100 → alpha 0.72', Math.abs(alpha.a100 - 0.72) < 0.01, alpha.a100);

    /* ---- 3) scrim 自动档 + 可读性护栏 ---- */
    const scrim = await page.evaluate(`(() => {
      const KT = window.KnodoTheme;
      const dark = KT.resolve({ mode: 'light', style: 'mist', backdrop: { type: 'image', image: 't.jpg', opacity: 60, luma: 0.3, scrim: 'auto' } });
      const bright = KT.resolve({ mode: 'dark', style: 'mist', backdrop: { type: 'image', image: 't.jpg', opacity: 60, luma: 0.82, scrim: 'auto' } });
      const guard = KT.resolve({ mode: 'dark', style: 'mist', backdrop: { type: 'image', image: 't.jpg', opacity: 100, luma: 0.9, scrim: 'none' } });
      const manual = KT.resolve({ mode: 'light', style: 'mist', backdrop: { type: 'image', image: 't.jpg', opacity: 60, luma: 0.5, scrim: 'strong' } });
      return { darkScrim: dark.scrim, brightScrim: bright.scrim, guardPct: guard.guardPct, manualScrim: manual.scrim };
    })()`);
    ok('scrim 自动档：暗图在浅色下提亮', scrim.darkScrim > 0.15 && scrim.darkScrim < 0.25, scrim.darkScrim);
    ok('scrim 自动档：亮图在深色下压暗', scrim.brightScrim > 0.2 && scrim.brightScrim <= 0.35, scrim.brightScrim);
    ok('护栏：极限组合会自动加深面板', scrim.guardPct > 0, `${scrim.guardPct}%`);
    ok('scrim 手动档生效', scrim.manualScrim === 0.34, scrim.manualScrim);

    /* ---- 4) 高对比锁 30% + 毛玻璃强制关 ---- */
    const contrast = await page.evaluate(`(() => {
      const KT = window.KnodoTheme;
      const r = KT.resolve({ mode: 'light', style: 'contrast', backdrop: { type: 'image', image: 't.jpg', opacity: 100, luma: 0.5, glass: true } });
      return { opacity: r.opacity, glass: r.glass, guard: r.guardPct };
    })()`);
    ok('高对比风格锁定透明度 30%', contrast.opacity === 30, JSON.stringify(contrast));
    ok('高对比风格强制关毛玻璃', contrast.glass === false);

    /* ---- 5) 落库 → 主进程 → 渲染层闭环 ---- */
    const persisted = await page.evaluate(`(async () => {
      const t1 = await window.api.theme.set({ mode: 'dark', style: 'sepia' });
      const t2 = await window.api.theme.get();
      return { t1: { mode: t1.mode, style: t1.style }, t2: { mode: t2.mode, style: t2.style },
        attr: document.documentElement.getAttribute('data-theme') + '/' + document.documentElement.getAttribute('data-style') };
    })()`);
    ok('theme.set 局部合并并落库', persisted.t2.mode === 'dark' && persisted.t2.style === 'sepia', JSON.stringify(persisted));
    ok('主进程推送后渲染层属性同步', persisted.attr === 'dark/sepia', persisted.attr);

    /* ---- 6) 设置中心「外观」分区 ---- */
    const pane = await page.evaluate(`(async () => {
      window.__openSettings('appearance');
      for (let i = 0; i < 60; i += 1) {
        const nav = [...document.querySelectorAll('.st-nav-item')];
        if (nav.length) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const nav = [...document.querySelectorAll('.st-nav-item')].map(b => b.textContent.trim());
      const navNew = document.querySelector('.st-nav-item[data-nav="appearance"]');
      const active = document.querySelector('.st-pane[data-pane="appearance"]');
      return {
        nav, first: nav[0], isActive: active && !active.hidden,
        cards: document.querySelectorAll('.ap-card').length,
        selected: document.querySelector('.ap-card.is-on')?.dataset.style || '',
        thumbBg: (() => { const c = document.querySelector('.ap-card .ap-thumb'); return c ? getComputedStyle(c).backgroundColor : ''; })(),
        generalHasTheme: !!document.querySelector('#st-theme'),
        modeOn: document.querySelector('[data-seg="mode"] .is-on')?.dataset.mode || '',
        slider: (() => { const s = document.querySelector('#ap-opacity'); return s ? { v: s.value, disabled: s.disabled } : null; })(),
        alphaNote: document.querySelector('[data-role="alphanote"]')?.textContent.trim() || '',
      };
    })()`);
    ok('设置中心第一个分区是「外观」', pane.first === '外观', JSON.stringify(pane.nav));
    ok('外观分区默认选中', pane.isActive);
    ok('6 张风格卡', pane.cards === 6, pane.cards);
    ok('当前风格高亮到 sepia', pane.selected === 'sepia', pane.selected);
    ok('风格卡缩略图按真实 token 上色', !!pane.thumbBg && pane.thumbBg !== 'rgba(0, 0, 0, 0)', pane.thumbBg);
    ok('「通用」里不再有界面主题下拉', pane.generalHasTheme === false);
    ok('模式分段回显 dark', pane.modeOn === 'dark', pane.modeOn);
    ok('无背景图时透明度滑块禁用', pane.slider && pane.slider.disabled === true, JSON.stringify(pane.slider));

    /* ---- 7) 点卡即生效（不点保存） ---- */
    const clicked = await page.evaluate(`(async () => {
      const card = document.querySelector('.ap-card[data-style="moss"]');
      card.click();
      await new Promise(r => setTimeout(r, 500));
      const saved = await window.api.theme.get();
      return {
        style: saved.style,
        attr: document.documentElement.getAttribute('data-style'),
        on: document.querySelector('.ap-card.is-on')?.dataset.style || '',
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg-rgb').trim(),
      };
    })()`);
    ok('点风格卡立即生效并落库', clicked.style === 'moss' && clicked.attr === 'moss', JSON.stringify(clicked));
    ok('选中态跟着走（✓ 只在一个卡上）', clicked.on === 'moss', clicked.on);
    ok('token 同步成苔绿（深色 #131a14）', clicked.bg === '19 26 20', clicked.bg);

    /* ---- 8) 模式切换 ---- */
    const modeSw = await page.evaluate(`(async () => {
      document.querySelector('[data-seg="mode"] button[data-mode="light"]').click();
      await new Promise(r => setTimeout(r, 500));
      const saved = await window.api.theme.get();
      return { mode: saved.mode, attr: document.documentElement.getAttribute('data-theme') };
    })()`);
    ok('模式分段切换生效', modeSw.mode === 'light' && modeSw.attr === 'light', JSON.stringify(modeSw));

    /* ---- 9) 恢复默认 ---- */
    const reset = await page.evaluate(`(async () => {
      document.querySelector('[data-act="reset"]').click();
      await new Promise(r => setTimeout(r, 600));
      const saved = await window.api.theme.get();
      return { mode: saved.mode, style: saved.style, type: saved.backdrop.type, attr: document.documentElement.getAttribute('data-style') };
    })()`);
    ok('恢复默认回到宣纸 / 跟随系统 / 无背景', reset.style === 'sepia' && reset.mode === 'system' && reset.type === 'none', JSON.stringify(reset));

    /* ---- 10) 分区内搜索：外壳的过滤不用为外观做特殊处理 ---- */
    const search = await page.evaluate(`(async () => {
      const s = document.querySelector('#st-search');
      s.value = '透明度';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 260));
      const secs = [...document.querySelectorAll('.st-pane[data-pane="appearance"] .st-sec')];
      const visible = secs.filter((x) => !x.hidden).length;
      s.value = '';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 260));
      return { visible, total: secs.length, after: secs.filter((x) => !x.hidden).length };
    })()`);
    ok('搜索「透明度」命中背景图 + 桌面浮窗两节', search.visible === 2 && search.total === 4, JSON.stringify(search));
    ok('清空搜索后四节全部回来', search.after === 4, search.after);

    /* ---- 11) 布局：设置面板没有溢出、风格卡不被压扁 ---- */
    const layout = await page.evaluate(`(() => {
      const content = document.querySelector('.st-content');
      const grid = document.querySelector('.ap-styles');
      const first = document.querySelector('.ap-card');
      const gs = getComputedStyle(grid);
      return {
        cols: gs.gridTemplateColumns.split(' ').length,
        cardW: Math.round(first.getBoundingClientRect().width),
        overflowX: content.scrollWidth > content.clientWidth + 1,
        guardHidden: document.querySelector('[data-role="guard"]').hidden,
      };
    })()`);
    ok('风格卡 3 列且宽度正常', layout.cols === 3 && layout.cardW > 120, JSON.stringify(layout));
    ok('外观分区无横向溢出', layout.overflowX === false);
    ok('无背景图时护栏提示隐藏', layout.guardHidden === true);

    /* ---- 12) 桌面浮窗材质：不透明度是主题对象的一部分，且夹在安全区间 ---- */
    const dw = await page.evaluate(`(() => {
      const KT = window.KnodoTheme;
      const plain = KT.resolve({ mode: 'light', style: 'sepia' });
      const tuned = KT.resolve({ mode: 'light', style: 'sepia', desktop: { opacity: 70 } });
      return {
        def: plain.desktopAlpha,
        norm: KT.normalize({}).desktop.opacity,
        tuned: tuned.desktopAlpha,
        low: KT.normalize({ desktop: { opacity: 10 } }).desktop.opacity,
        high: KT.normalize({ desktop: { opacity: 500 } }).desktop.opacity,
        varAlpha: getComputedStyle(document.documentElement).getPropertyValue('--dw-alpha').trim(),
        panel: KT.triple(KT.STYLES.sepia.light['bg-panel']),
      };
    })()`);
    ok('浮窗默认不透明度 95%', dw.def === 0.95 && dw.norm === 95, JSON.stringify(dw));
    ok('浮窗不透明度可调且夹在 55–100', dw.tuned === 0.7 && dw.low === 55 && dw.high === 100, JSON.stringify(dw));
    ok('--dw-alpha 已写到根上（浮窗读同一个变量）', dw.varAlpha === '0.95', dw.varAlpha);
    ok('浮窗底色取当前风格的 panel（宣纸 #fdf8ee）', dw.panel === '253 248 238', dw.panel);

    /* ---- 结局 ---- */
    const failed = results.filter((r) => !r.pass);
    if (failed.length) {
      console.log(`\n✗ 失败 ${failed.length} 项：${failed.map((f) => f.name).join('；')}`);
      console.log(log.split('\n').filter((l) => /error|Error|失败/.test(l)).slice(-12).join('\n'));
      page.close();
      cleanup();
      process.exit(1);
    }
    console.log(`\n✓ 外观验证全部通过（${results.length} 项）`);
    page.close();
    cleanup();
    process.exit(0);
  } catch (e) {
    console.log('✗ 异常：', (e && e.message) || e);
    console.log(log.split('\n').slice(-20).join('\n'));
    cleanup();
    process.exit(1);
  }
})();
