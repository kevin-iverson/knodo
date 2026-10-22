'use strict';
/**
 * Windows 打包入口（electron-builder 的薄封装）。
 *
 * 作用：
 * 1. 内置国内镜像地址，避免打包时从 GitHub 下载 electron / winCodeSign / nsis 资源超时；
 * 2. 统一 arch（x64）与平台（win），用户只需 `npm run dist`；
 * 3. 额外参数透传，例如 `npm run dist -- --target portable` 只出免安装版。
 *
 * 产物默认输出到 dist/：
 *   - TODO待办-<version>-安装版.exe   （NSIS 安装程序，可选安装目录、建快捷方式）
 *   - TODO待办-<version>-便携版.exe   （portable 单文件，双击即用，数据存自身目录同级）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');

/**
 * KEEP_ELECTRON_LOCALES=1：跳过 Electron 语言包裁剪。
 *
 * 默认配置 `build.electronLanguages: ['zh-CN','en-US']` 会让 electron-builder 在解包后
 * 一次性删除 40+ 个 locales/*.pak。部分受限环境（沙箱 / 严格 CI）禁止这种批量删除，
 * 会直接中断打包。开启本开关后保留全部语言包，代价只是产物体积多几 MB。
 */
const keepLocales = process.env.KEEP_ELECTRON_LOCALES === '1';
let tmpConfig = null;
if (keepLocales) {
  const pkg = require(path.join(root, 'package.json'));
  const build = { ...pkg.build };
  delete build.electronLanguages;
  // 配置文件里的相对路径以文件自身位置为基准，所以必须放在项目根
  tmpConfig = path.join(root, '.builder-config.json');
  fs.writeFileSync(tmpConfig, `${JSON.stringify(build, null, 2)}\n`);
  console.log('[build] 已跳过 Electron 语言包裁剪（KEEP_ELECTRON_LOCALES=1）');
}

const env = {
  ...process.env,
  // electron 二进制镜像
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  // winCodeSign / nsis / nsis-resources 镜像（electron-builder 专用）
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

const extraArgs = process.argv.slice(2);
const args = [cli, '--win', '--x64', ...(tmpConfig ? ['--config', tmpConfig] : []), ...extraArgs];

console.log('[build] electron-builder ' + args.slice(1).join(' '));
const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => {
  if (tmpConfig) { try { fs.unlinkSync(tmpConfig); } catch { /* 已清理 */ } }
  process.exit(code == null ? 1 : code);
});
