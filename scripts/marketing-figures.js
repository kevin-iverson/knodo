'use strict';
/**
 * 公众号配图渲染器（开发辅助脚本）。
 *
 * 做一件事：把 `docs/marketing/figures/*.html` 按**固定画布尺寸**渲染成
 * `docs/marketing/images/*.png`，供公众号编辑器直接上传。
 *
 * 为什么用 HTML 而不是 AI 生图：这些图里全是中文标题、数字和真实截图裁切，
 * 生成式模型会把字写糊、把 UI 画歪；HTML 渲染是像素级的，改一个数字重跑一次就行。
 *
 * 用法：
 *   node scripts/marketing-figures.js              # 全量
 *   node scripts/marketing-figures.js cover fig1   # 只渲染指定几张
 *
 * 注意：画布尺寸即导出尺寸（公众号正文建议 1080 宽），内部用 2 倍超采样再缩回，
 * 所以小字不会发糊。截图类配图用 background-position 裁切，源图都是 2x 高清图。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const FIG_DIR = path.join(root, 'docs', 'marketing', 'figures');
const OUT_DIR = path.join(root, 'docs', 'marketing', 'images');

/** 画布尺寸 = 最终导出像素 */
const FIGS = [
  { key: 'cover', file: 'cover.html', w: 900, h: 383, out: '00-封面.png' },
  { key: 'fig1', file: 'fig1.html', w: 1080, h: 720, out: '01-三条底线.png' },
  { key: 'fig2', file: 'fig2.html', w: 1080, h: 720, out: '02-完成态不隐藏.png' },
  { key: 'fig3', file: 'fig3.html', w: 1080, h: 720, out: '03-任务与笔记同库.png' },
  { key: 'fig4', file: 'fig4.html', w: 1080, h: 720, out: '04-AI是加法.png' },
  { key: 'fig5', file: 'fig5.html', w: 1080, h: 540, out: '05-数据在你的硬盘.png' },
  { key: 'fig6', file: 'fig6.html', w: 1080, h: 720, out: '06-吸边与日历负载.png' },
  { key: 'fig7', file: 'fig7.html', w: 1080, h: 720, out: '07-收尾.png' },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = only.length ? FIGS.filter((f) => only.includes(f.key)) : FIGS;

app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.commandLine.appendSwitch('disable-lcd-text');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shared = null;

/** 复用一个窗口：每张图单独 new BrowserWindow 再 destroy，第二次起会 ERR_FAILED */
function getWin() {
  if (shared && !shared.isDestroyed()) return shared;
  shared = new BrowserWindow({
    width: 900,
    height: 600,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#FAF7F2',
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  return shared;
}

async function shot(fig) {
  const win = getWin();
  win.setContentSize(fig.w, fig.h);

  await win.loadFile(path.join(FIG_DIR, fig.file));
  await sleep(420); // 等字体与背景图落位

  const raw = await win.webContents.capturePage();
  const size = raw.getSize();
  const out = raw.resize({ width: fig.w, height: fig.h, quality: 'best' });

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = path.join(OUT_DIR, fig.out);
  fs.writeFileSync(dest, out.toPNG());

  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log(
    `[fig] ${fig.out.padEnd(26)} ${fig.w}x${fig.h}  (captured ${size.width}x${size.height})  ${kb}KB`
  );

  // 窗口复用，不 destroy
}

app.whenReady().then(async () => {
  let failed = 0;
  for (const fig of targets) {
    try {
      await shot(fig);
    } catch (e) {
      failed++;
      console.error(`[fig] 失败 ${fig.file}:`, e.message);
    }
  }
  console.log(failed ? `[fig] 完成，${failed} 张失败` : `[fig] 全部完成 → ${OUT_DIR}`);
  app.exit(failed ? 1 : 0);
});
