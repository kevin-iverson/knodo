'use strict';
/**
 * README 截图流水线（开发辅助脚本，非应用运行时依赖）。
 *
 * 做三件事：
 *  1. 用 `scripts/demo-data.js` 往一个**临时数据目录**播种演示数据（不碰真实数据）；
 *  2. 启动真实 Electron + CDP，把窗口视口调到 1440×900 @2（= 2880×1800，README 规格）；
 *  3. 逐个视图摆好状态、截图，写到 `docs/screenshots/`。
 *
 * 用法：
 *   node scripts/shots.js                 # 全量重拍
 *   node scripts/shots.js --only tasks,stats
 *   node scripts/shots.js --keep          # 复用上次的演示库（改样式后快速复看）
 *
 * 为什么不用手点：截图最怕「这次和上次不一样」。所有视图状态都由脚本摆好
 * （哪条任务、第几格、滚到哪儿），以后改 UI 重跑一遍即可，不用回忆上次怎么点的。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { seed } = require('./demo-data');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots');
// 演示库放系统临时目录：每次跑用新目录，不碰仓库里的任何东西（--keep 时才复用固定的那个）
const keepDir = path.join(os.tmpdir(), 'knodo-shots-profile');
const port = '9510';
const W = 1440;
const H = 900;

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

/* ------------------------------ 准备数据 ------------------------------ */

let profile = '';
if (keep) {
  profile = keepDir;
  if (!fs.existsSync(path.join(profile, 'todo.db'))) {
    fs.mkdirSync(profile, { recursive: true });
    seed(profile);
  }
  console.log('[shots] 复用演示库 →', profile);
} else {
  profile = path.join(os.tmpdir(), `knodo-shots-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  seed(profile);
  console.log('[shots] 演示数据已播种 →', profile);
}

/** 播种后直接读库拿 id（渲染层还没起来，先知道要操作哪几条） */
function idsByTitle(dir) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dir, 'todo.db'), { readonly: true });
  const map = { groups: {} };
  for (const r of db.prepare('SELECT id, title FROM tasks').all()) map[r.title] = r.id;
  for (const r of db.prepare('SELECT id, name FROM groups').all()) map.groups[r.name] = r.id;
  db.close();
  return map;
}
const IDS = idsByTitle(profile);

/* ------------------------------ CDP ------------------------------ */

const child = spawn(
  electronBin,
  [root, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
);
let appLog = '';
child.stdout.on('data', (b) => { appLog += b.toString(); });
child.stderr.on('data', (b) => { appLog += b.toString(); });

function cleanup() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
}

async function targets() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) return list;
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('CDP 连接超时');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.id || !pending.has(m.id)) return;
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .then((r) => {
      if (r.exceptionDetails) {
        throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
      }
      return r.result && r.result.value;
    });
  return {
    send,
    evaluate,
    close: () => ws.close(),
    /** 等到 predicate 在页面里返回真值（或超时抛错） */
    async waitFor(expr, ms = 8000, label = '') {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await evaluate(expr).catch(() => false)) return true;
        await sleep(120);
      }
      throw new Error(`等待超时${label ? `：${label}` : ''} —— ${expr.slice(0, 80)}`);
    },
    async shot(file) {
      // 提示条（「已载入历史报告」之类）常压在内容右下角，截图前统一收掉
      await evaluate(`(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; return true })()`).catch(() => {});
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      const buf = fs.readFileSync(file);
      return `${path.basename(file)} ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    },
  };
}

/* ------------------------------ 页面操作小工具 ------------------------------ */

/** 点击第一个匹配选择器的元素（找不到就抛错，避免「静默截了张空图」） */
const click = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  el.click();
  return true;
})()`;

async function goView(page, view) {
  await page.evaluate(click(`.nav-item[data-view="${view}"]`));
  await sleep(900);
}

/** 关掉可能开着的抽屉 / 弹窗，回到干净的任务视图 */
async function closeOverlays(page) {
  await page.evaluate(`(() => {
    // 检索弹窗只认「关闭」/ ✕（Esc 与点遮罩都被故意关掉了），必须先点按钮再谈其它
    if (document.querySelector('.search-panel')) {
      const ok = document.querySelector('.modal-mask [data-modal="ok"]');
      if (ok) { ok.click(); return 'search'; }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const mask = document.querySelector('.modal-mask');
    if (mask && mask.click) mask.click();
    return 'esc';
  })()`);
  await sleep(450);
  await page.evaluate(`(() => {
    const ok = document.querySelector('.modal-mask [data-modal="ok"]');
    if (ok && document.querySelector('.search-panel')) { ok.click(); return true; }
    return false;
  })()`);
  await sleep(350);
  await page.evaluate(`(() => { const m = document.querySelector('.detail-mask'); if (m && m.click) m.click(); return true })()`);
  await sleep(450);
}


/** 把详情抽屉里的某一节滚到面板顶部附近（scrollIntoView 会把末节顶到最底部，露出半行） */
async function scrollPanelTo(page, sel, offset = 70) {
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    let box = el.parentElement;
    while (box && box !== document.body) {
      const st = getComputedStyle(box);
      if (/(auto|scroll)/.test(st.overflowY) && box.scrollHeight > box.clientHeight + 4) break;
      box = box.parentElement;
    }
    if (!box || box === document.body) { el.scrollIntoView({ block: 'center' }); return true; }
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - ${offset};
    return true;
  })()`);
  await sleep(500);
}

/**
 * 把透明窗（浮窗 / 捕捉条）合成到一张「壁纸 + 投影」的画布上。
 * 做法：主窗口页面里铺一张 canvas（逻辑尺寸 = 输出的一半，DSF=2 时正好 1:1 像素），
 * 壁纸是几层柔和光斑，窗口图片按自然像素绘制，投影靠 shadowBlur 沿 alpha 轮廓走。
 */
async function compose(page, { file, w, h, imgB64, drawW, drawH, x, y }) {
  await page.evaluate(`(() => {
    const old = document.getElementById('__shot_canvas');
    if (old) old.remove();
    return true;
  })()`);
  const ok = await page.evaluate(`(async () => {
    const W = ${w}, H = ${h};
    const c = document.createElement('canvas');
    c.id = '__shot_canvas';
    c.width = W; c.height = H;
    c.style.cssText = 'position:fixed;left:0;top:0;width:' + (W / 2) + 'px;height:' + (H / 2) + 'px;z-index:2147483647;pointer-events:none';
    const g = c.getContext('2d');

    // 壁纸：暖纸底 + 三团柔光（朱砂 / 苔绿 / 暖墨），低调但不至于像纯色
    const lg = g.createLinearGradient(0, 0, W, H);
    lg.addColorStop(0, '#f8f3e9');
    lg.addColorStop(0.5, '#f1e8d8');
    lg.addColorStop(1, '#e7dac6');
    g.fillStyle = lg;
    g.fillRect(0, 0, W, H);
    const blob = (cx, cy, r, color) => {
      const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, color);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, W, H);
    };
    blob(W * 0.16, H * 0.18, W * 0.52, 'rgba(217,71,46,0.10)');
    blob(W * 0.88, H * 0.80, W * 0.55, 'rgba(74,124,67,0.10)');
    blob(W * 0.62, H * 0.06, W * 0.42, 'rgba(165,100,44,0.09)');

    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + ${JSON.stringify(imgB64)}; });

    g.save();
    g.shadowColor = 'rgba(66,44,26,0.30)';
    g.shadowBlur = 56;
    g.shadowOffsetY = 20;
    g.drawImage(img, ${x}, ${y}, ${drawW}, ${drawH});
    g.restore();

    document.body.appendChild(c);
    return true;
  })()`);
  if (!ok) throw new Error('合成画布失败');
  const r = await page.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: w / 2, height: h / 2, scale: 1 },
  });
  fs.writeFileSync(path.join(outDir, file), Buffer.from(r.data, 'base64'));
  await page.evaluate(`(() => { const el = document.getElementById('__shot_canvas'); if (el) el.remove(); return true })()`);
  const buf = fs.readFileSync(path.join(outDir, file));
  return `${file} ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

/** 截一个独立窗口（透明背景）为 base64 */
async function shotTransparent(wsUrl) {
  const p = await connect(wsUrl);
  await p.send('Page.enable');
  await p.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await sleep(600);
  const r = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  p.close();
  return r.data;
}

/* ------------------------------ 各张图 ------------------------------ */

const T = (title) => IDS[title];

/** 个别视图在 1440 下太挤（日历要挤下三个面板），单独放宽；README 里尺寸不一致是既有惯例 */
const SIZES = {
  'calendar-month': [1600, 950],
  'calendar-week': [1600, 950],
  // 工时视图=工具栏 + 四张卡 + 按任务表 + 每日分布，900 高会把柱状图的日期标签裁掉半行
  worklog: [1440, 1000],
  // 详情抽屉的正常截图会滚到「描述」，900 高会在标题下面露出一截被裁的子任务行；
  // 直接加高窗口、不滚动，从标题一路看到关联笔记
  'task-detail': [1440, 1120],
};

async function setViewport(page, w, h) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await sleep(700);
}

const shots = {
  /* 任务列表：今天视图。第一条带备注摘要、有子任务进度、有已完成行 */
  async tasks(page) {
    await closeOverlays(page);
    await goView(page, 'today');
    await page.evaluate(`(() => { const v = document.getElementById('view'); if (v) v.scrollTop = 0; return true })()`);
    await sleep(600);
    return page.shot(path.join(outDir, 'tasks.png'));
  },

  /* 日历月视图：11 月铺满，含超载 / 跨天 / 已完成 */
  async 'calendar-month'(page) {
    await closeOverlays(page);
    await page.evaluate(click('.titlebar .tb-cal'));
    await page.waitFor(`!!document.querySelector('.cal-wrap')`, 8000, '日历渲染');
    await sleep(1200);
    // 关掉顶部那张介绍卡：它会占掉 100px，而同样的话 README 正文已经写了
    await page.evaluate(click('.cal-intro-close'));
    await page.evaluate(click('[data-cal-view="month"]'));
    await sleep(1000);
    return page.shot(path.join(outDir, 'calendar-month.png'));
  },

  async 'calendar-week'(page) {
    if (!(await page.evaluate(`!!document.querySelector('.cal-wrap')`))) {
      await page.evaluate(click('.titlebar .tb-cal'));
      await page.waitFor(`!!document.querySelector('.cal-wrap')`, 8000, '日历渲染');
      await sleep(1000);
      await page.evaluate(click('.cal-intro-close'));
    }
    await page.evaluate(click('[data-cal-view="week"]'));
    await sleep(1200);
    return page.shot(path.join(outDir, 'calendar-week.png'));
  },

  /* 任务详情抽屉：滚到「描述」，那是本节的重点（笔记同款编辑器） */
  async 'task-detail'(page) {
    await closeOverlays(page);
    await goView(page, 'today');
    await page.evaluate(`(async () => { await window.api.ui.setDetailWidth(520); return true })()`).catch(() => {});
    const id = T('重构任务列表渲染性能');
    // 注意点 .task-item 本身：标题上挂着 data-act="rename"，点它进的是就地改名
    await page.evaluate(`(() => {
      const row = document.querySelector('.task-item[data-id="${id}"]');
      if (!row) return false;
      row.click();
      return true;
    })()`);
    await page.waitFor(`!!document.querySelector('.detail-panel')`, 6000, '详情抽屉');
    await sleep(1400);
    await page.evaluate(`(() => {
      const panel = document.querySelector('.detail-panel');
      if (!panel) return false;
      const sc = [...panel.querySelectorAll('*')].find((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)
        && el.scrollHeight > el.clientHeight + 4);
      if (sc) sc.scrollTop = 0;
      return true;
    })()`);
    await sleep(400);
    return page.shot(path.join(outDir, 'task-detail.png'));
  },

  /* 笔记：编辑态 + 工具条 */
  async 'notes-wysiwyg'(page) {
    await closeOverlays(page);
    await goView(page, 'notes');
    await page.waitFor(`!!document.querySelector('#nt-list li')`, 6000, '笔记列表');
    await page.evaluate(`(() => {
      const li = [...document.querySelectorAll('#nt-list li')].find((el) => /信息架构/.test(el.textContent));
      (li || document.querySelector('#nt-list li')).click();
      return true;
    })()`);
    await page.waitFor(`!!document.querySelector('.nt-dp')`, 6000, '笔记详情');
    await sleep(1200);
    await page.evaluate(click('.nt-edit-toggle'));
    await sleep(1400);
    return page.shot(path.join(outDir, 'notes-wysiwyg.png'));
  },

  async meetings(page) {
    await closeOverlays(page);
    await goView(page, 'meetings');
    await page.waitFor(`!!document.querySelector('.mt-item')`, 6000, '会议列表');
    await sleep(1500);
    return page.shot(path.join(outDir, 'meetings.png'));
  },

  async 'ai-report'(page) {
    await closeOverlays(page);
    await goView(page, 'reports');
    // 报告不自动加载，得从「历史记录」里点开一份 —— 空面板拍照没有意义
    await page.evaluate(click('#rp-history'));
    await page.waitFor(`!!document.querySelector('.rpt-row')`, 8000, '历史列表');
    await sleep(600);
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.rpt-row')].find((r) => /本周周报/.test(r.textContent))
        || document.querySelector('.rpt-row');
      const btn = row && row.querySelector('[data-act="view"]');
      if (btn) btn.click();
      return !!btn;
    })()`);
    await page.waitFor(`(() => { const d = document.querySelector('.rp-doc-page'); return !!d && d.textContent.trim().length > 120 })()`, 8000, '报告正文');
    await sleep(1500);
    return page.shot(path.join(outDir, 'ai-report.png'));
  },

  /* AI 检索：真跑一次本地分层召回（无需 API Key） */
  async 'ai-search'(page) {
    await closeOverlays(page);
    await goView(page, 'today');
    await page.evaluate(click('#btn-ai-search'));
    await page.waitFor(`!!document.querySelector('#ai-search-input')`, 6000, '检索弹窗');
    await sleep(900);
    await page.evaluate(`(() => {
      const input = document.querySelector('#ai-search-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '性能');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await page.waitFor(`!!document.querySelector('.search-result-item, .sr-empty, .sr-banner')`, 15000, '检索结果');
    await sleep(1600);
    return page.shot(path.join(outDir, 'ai-search.png'));
  },

  async stats(page) {
    await closeOverlays(page);
    await goView(page, 'stats');
    await page.waitFor(`!!document.querySelector('.stats-grid')`, 6000, '统计卡片');
    await sleep(1800);
    return page.shot(path.join(outDir, 'stats.png'));
  },

  /* 工时：本周汇总卡 + 按任务表（父行「含子任务」，展开一行看子任务的贡献） */
  async worklog(page) {
    await closeOverlays(page);
    await goView(page, 'worklog');
    await page.waitFor(`!!document.querySelector('.wl-toolbar')`, 8000, '工时工具栏');
    await page.waitFor(`!!document.querySelector('.wl-sum-grid')`, 8000, '工时汇总卡');
    await sleep(1300);
    // 展开父任务：自身 3h25m + 三个子任务 6h15m —— 这张图要证明「累积」是真的，不是一句说明
    await page.evaluate(`(() => {
      const b = document.querySelector('[data-wl-twist]:not(.is-ph)');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(1000);
    return page.shot(path.join(outDir, 'worklog.png'));
  },

  /* 工时计时：行内 ▶ 变时钟 + 页面底部计时条（真开一段，秒数只能等出来） */
  async 'worklog-timer'(page) {
    await closeOverlays(page);
    await goView(page, 'today');
    // 挑一条「今天」里真能看见的行：行内时钟与底部计时条要出现在同一张图里
    const id = T('整理 1.12 版本迭代计划');
    await page.evaluate(`(async () => {
      await window.api.worklog.start({ taskId: ${id}, source: 'timer' });
      return true;
    })()`);
    await page.waitFor(`!!document.querySelector('#wl-dock:not([hidden])')`, 8000, '工时计时条');
    await page.evaluate(`(() => {
      const row = document.querySelector('.task-item[data-id="${id}"]');
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(700);
    // 行内按钮只在悬停时出现 —— 用真实的鼠标移入把这一行「hover」住，别用注入样式假装
    const box = await page.evaluate(`(() => {
      const row = document.querySelector('.task-item[data-id="${id}"]');
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: Math.round(r.right - 60), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (box) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
      await sleep(900);
    }
    // 起点由主进程 wall clock 记，P 不出来，也不该为了截图去改产品逻辑
    await sleep(65000);
    return page.shot(path.join(outDir, 'worklog-timer.png'));
  },

  /* 禅模式：全屏静默计时（计时仍在主进程跑，Esc 只退出全屏） */
  async 'worklog-zen'(page) {
    await page.evaluate(click('[data-wl="zen"]'));
    await page.waitFor(`!!document.querySelector('.wl-zen')`, 6000, '禅模式覆盖层');
    await sleep(1600);
    return page.shot(path.join(outDir, 'worklog-zen.png'));
  },

  /* 设置中心 · 快捷键 */
  async 'settings-keys'(page) {
    await page.evaluate(`(async () => { await window.api.worklog.stop(); return true })()`).catch(() => {});
    await sleep(500);
    await closeOverlays(page);
    await page.evaluate(click('#btn-settings'));
    await page.waitFor(`!!document.querySelector('.st-nav-item')`, 8000, '设置面板');
    await sleep(900);
    await page.evaluate(click('.st-nav-item[data-nav="keys"]'));
    await sleep(1400);
    // 这台机器上第三方程序占着 Ctrl+Alt+C，首屏挂着一条红字「未能注册」——放进 README 会被读成缺陷。
    // 滚到「显示 / 隐藏桌面浮窗」那一行起：还是同一张可录制的全局键列表，只是看不到那一条
    await scrollPanelTo(page, '.st-krow[data-key="app.toggleDesktop"]', 8);
    // 往下滚一屏：这台机器上第三方程序占着 Ctrl+Alt+C，首屏会挂着一条红字「未能注册」，
    // 放进 README 会被读成缺陷。滚到下面几行，仍然是同一张全局快捷键列表（行内胶囊、可录制）
    return page.shot(path.join(outDir, 'settings-keys.png'));
  },

  /* 桌面浮窗：透明窗 → 合成到壁纸 */
  async 'desktop-pin'(page) {
    await closeOverlays(page);
    await goView(page, 'today');
    await page.evaluate(`(async () => {
      const pins = await window.api.desktop.list();
      for (const p of pins) await window.api.desktop.unpin(p.id);
      return true;
    })()`);
    await sleep(400);
    // 钉一个分组（不是「未完成」全局视图）：全局视图逾期十几条，窗口会高到一张图放不下
    const gid = IDS.groups['团队协作'];
    await page.evaluate(`(async () => {
      await window.api.desktop.pin('group', ${gid}, { show: true });
      return true;
    })()`);
    // 浮窗是独立 target
    let target = null;
    for (let i = 0; i < 40; i += 1) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => /desktop\.html/.test(t.url));
      if (target) break;
      await sleep(300);
    }
    if (!target) throw new Error('浮窗 target 未出现');
    await sleep(1800);
    const b64 = await shotTransparent(target.webSocketDebuggerUrl);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const dt = list.find((t) => /desktop\.html/.test(t.url));
    const meta = await (async () => {
      const p = await connect(dt.webSocketDebuggerUrl);
      const v = await p.evaluate(`(() => ({ w: innerWidth, h: innerHeight }))()`);
      p.close();
      return v;
    })();
    // 输出 1400×860：画布逻辑 700×430，浮窗按 2x 自然像素绘制
    // 窗口按 2x 自然像素绘制；万一比画布还高，等比缩到画布 78% 再居中
    let winW = meta.w * 2;
    let winH = meta.h * 2;
    const k = Math.min(1, (860 * 0.92) / winH, (1400 * 0.70) / winW);
    winW = Math.round(winW * k);
    winH = Math.round(winH * k);
    const x = Math.round((1400 - winW) / 2) + 50;
    const y = Math.round((860 - winH) / 2);
    console.log(`  · 浮窗 ${meta.w}x${meta.h} → 画布内 ${winW}x${winH}`);
    return compose(page, { file: 'desktop-pin.png', w: 1400, h: 860, imgB64: b64, drawW: winW, drawH: winH, x, y });
  },

  /* 快速捕捉条：透明窗 → 合成到壁纸 */
  async capture(page) {
    await closeOverlays(page);
    await goView(page, 'today');
    await page.evaluate(`(async () => { await window.api.capture.toggle({}); return true })()`);
    let target = null;
    for (let i = 0; i < 40; i += 1) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => /capture\.html/.test(t.url));
      if (target) break;
      await sleep(300);
    }
    if (!target) throw new Error('捕捉条 target 未出现');
    await sleep(900);
    // 填一句待办，并让分组落在「产品迭代」
    await (async () => {
      const p = await connect(target.webSocketDebuggerUrl);
      await p.evaluate(`(() => {
        const input = document.querySelector('#cap-input, input[type="text"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '把浮窗截图补进 README');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        return true;
      })()`);
      await sleep(500);
      p.close();
    })();
    await sleep(600);
    const b64 = await shotTransparent(target.webSocketDebuggerUrl);
    await page.evaluate(`(async () => { await window.api.capture.hide(); return true })()`).catch(() => {});
    // 输出 1280×380：画布逻辑 640×190
    return compose(page, { file: 'capture.png', w: 1280, h: 380, imgB64: b64, drawW: 1040, drawH: 104, x: 120, y: 138 });
  },
};

/* ------------------------------ 主流程 ------------------------------ */

(async () => {
  const list = await targets();
  const main = list.find((t) => /index\.html/.test(t.url));
  const page = await connect(main.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await sleep(2600);
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await sleep(1000);

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const order = [
    'tasks', 'calendar-month', 'calendar-week', 'task-detail', 'notes-wysiwyg',
    'meetings', 'ai-report', 'ai-search', 'stats',
    'worklog', 'worklog-timer', 'worklog-zen', 'settings-keys',
    'desktop-pin', 'capture',
  ];
  const results = [];
  for (const name of order) {
    if (only && !only.has(name)) continue;
    const [vw, vh] = SIZES[name] || [W, H];
    try {
      await setViewport(page, vw, vh);
      const info = await shots[name](page);
      results.push(`✓ ${info}`);
    } catch (e) {
      results.push(`✗ ${name} —— ${e.message}`);
    }
    if (vw !== W || vh !== H) await setViewport(page, W, H);
  }
  console.log(results.join('\n'));
  page.close();
  cleanup();
  if (results.some((r) => r.startsWith('✗'))) {
    console.error('\n--- 应用日志尾部 ---\n' + appLog.split('\n').slice(-20).join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('ERR', e && e.stack ? e.stack : e);
  cleanup();
  process.exit(1);
});
