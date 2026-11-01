'use strict';
/**
 * Windows 打包入口（electron-builder 的薄封装）。
 *
 * 作用：
 * 1. 内置国内镜像地址，避免打包时从 GitHub 下载 electron / winCodeSign / nsis 资源超时；
 * 2. 统一 arch（x64）与平台（win），用户只需 `npm run dist`；
 * 3. 额外参数透传，例如 `npm run dist -- --win portable` 只出免安装版。
 *
 * 产物默认输出到 dist/：
 *   - Knodo-<version>-安装版.exe   （NSIS 安装程序，可选安装目录、建快捷方式）
 *   - Knodo-<version>-便携版.exe   （portable 单文件，双击即用，数据存自身目录同级）
 *
 * 语言包裁剪（2026-11 起）走 `scripts/after-pack.js`：
 * 解包完成后、出安装包之前把 55 个 locales 裁到 2 个，一次构建两个产物都受益
 * （安装版 109.8 → 约 92MiB，便携版 109.6 → 约 91.5MiB，双双落回 Gitee 单附件
 * 100MiB 上限内，不必再分卷发布）。裁剪用目录 rename，不触发批量删除守卫。
 * 想在本地留全量语言包：`KEEP_ELECTRON_LOCALES=1 npm run dist`。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const pkg = require(path.join(root, 'package.json'));

/* 临时配置：语言包裁剪交给 afterPack 钩子自己做。
   不能让 electron-builder 用 config.electronLanguages 去删 —— 它在解包后批量删除
   locales/*.pak，受限环境（沙箱 / 严格 CI）会被批量删除守卫直接中断。
   配置文件里的相对路径以文件自身位置为基准，所以临时配置必须放在项目根。 */
const tmpConfig = path.join(root, '.builder-config.json');
const buildConfig = {
  ...pkg.build,
  afterPack: 'scripts/after-pack.js',
  /* 压缩级别必须显式给 maximum：
     旧流程里便携版单独走 `--prepackaged` 出包，那条路径默认就是最高压缩
     （LZMA2 字典 64MB + Solid），安装版走一趟整体构建是普通压缩（字典 1MB、非 Solid）。
     现在两个包在同一趟里出，不显式指定的话便携版会退化成普通压缩，
     91.5MiB → 101.4MiB，直接顶穿 Gitee 单附件 100MiB。 */
  compression: 'maximum',
};
delete buildConfig.electronLanguages;
fs.writeFileSync(tmpConfig, `${JSON.stringify(buildConfig, null, 2)}\n`);

const env = {
  ...process.env,
  // electron 二进制镜像
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  // winCodeSign / nsis / nsis-resources 镜像（electron-builder 专用）
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

/** dist 下最终产物的大小报告（超过 100MiB 直接点名，免得发布时才炸） */
function report() {
  const distDir = path.join(root, 'dist');
  const prefix = `${pkg.build.productName}-${pkg.version}-`;
  const files = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).filter((f) => f.startsWith(prefix) && f.endsWith('.exe'))
    : [];
  console.log('\n[build] 产物');
  for (const f of files) {
    const size = fs.statSync(path.join(distDir, f)).size;
    const over = size > 100 * 1024 * 1024 ? '  ✗ 超 Gitee 单附件 100MiB' : '  ✓';
    console.log(`  ${f.padEnd(34)} ${(size / 1048576).toFixed(1).padStart(6)} MiB${over}`);
  }
}

const args = [cli, '--win', '--x64', ...process.argv.slice(2), '--config', tmpConfig];

console.log('[build] electron-builder ' + args.slice(1).join(' '));
const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => {
  try { fs.unlinkSync(tmpConfig); } catch { /* 已清理 */ }
  if (code === 0) report();
  process.exit(code == null ? 1 : code);
});
