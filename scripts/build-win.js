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
 *   - Knodo-<version>-便携版.7z    （解压一次即用，数据存 exe 同级 data/）
 *
 * 便携版为什么是 7z 而不是单文件 exe（2026-11 改）：
 *   electron-builder 的 portable target 是「自解压 exe」——portable.nsi 里
 *   `RMDir /r $INSTDIR` + `File /r` 无条件全量解压 337MiB / 118 个文件，退出再删；
 *   且 NsisTarget 默认把目录名生成成随机 KSUID，连系统缓存都命中不了。
 *   实测双击到窗口出现 15.6s / 14.8s，而同样内容解压后只要 1.3~1.7s。
 *   改成压缩包后「解压一次 → 之后每次都是 1.5s」，代价是用户要先解压。
 *   体积上 zip 做不到：deflate 压出 139.9MiB 顶穿 Gitee 100MiB 单附件上限，
 *   只有 LZMA2 的 94.7MiB 达标，所以用 7z。
 *   想临时回到单文件 exe：`npm run dist -- --win portable`。
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

/** LZMA2 压缩器：复用 devDependencies 里的 7zip-bin，不要求构建机预装 7-Zip */
const SEVEN_ZIP = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
/**
 * 便携包解压后留在 exe 同级的标记文件。
 * 打包时写入、压完立即删除 —— 安装版与 win-unpacked 都不会带它，
 * 只有 7z 包里有；main.js 见到它才把 userData 指到 exe 同级 data/。
 */
const PORTABLE_MARKER = 'portable.marker';

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

/* ---- 可选 Authenticode 代码签名（默认不启用，凭据一律走环境变量，不落盘） ----
 * electron-builder 26 只在「找到证书或自定义签名钩子」时才签，否则整趟跳过；
 * 因此下面这段不会改变没有证书时的打包行为（产物名、体积、压缩级别都不变）。
 *
 * A. PFX 文件：WIN_CSC_LINK=<pfx 路径 | base64 | https URL> + WIN_CSC_KEY_PASSWORD=<密码>
 *    这两个变量由 electron-builder 自己读取，无需在此注入。
 * B. Windows 证书库（UKey / 云签名客户端装好后证书可见，私钥不可导出）：
 *    KNODO_CERT_SUBJECT="<证书主题片段>" 或 KNODO_CERT_SHA1=<SHA1 指纹>
 * C. 自定义签名钩子（对接云签名 CLI）：KNODO_SIGN_HOOK=scripts/xxx.js
 *    钩子导出 async function sign(configuration)，configuration.path 是待签文件；
 *    每个签名算法调用一次，上面 signingHashAlgorithms 只留 sha256 保证只调一次。
 * 注意：win.azureSignOptions 与 win.signtoolOptions 互斥，将来接 Azure 签名时
 *       需要把 signtoolOptions 去掉，改用 azureSignOptions。
 */
const signOptions = { ...(buildConfig.win.signtoolOptions || {}) };
if (process.env.KNODO_CERT_SUBJECT) signOptions.certificateSubjectName = process.env.KNODO_CERT_SUBJECT;
if (process.env.KNODO_CERT_SHA1) signOptions.certificateSha1 = process.env.KNODO_CERT_SHA1;
if (process.env.KNODO_SIGN_HOOK) signOptions.sign = process.env.KNODO_SIGN_HOOK;
buildConfig.win = { ...buildConfig.win, signtoolOptions: signOptions };

let signMode = '未配置 → 产物不签名';
if (process.env.KNODO_SIGN_HOOK) signMode = `自定义钩子 ${process.env.KNODO_SIGN_HOOK}`;
else if (process.env.WIN_CSC_LINK || process.env.CSC_LINK) signMode = 'PFX（WIN_CSC_LINK / CSC_LINK）';
else if (process.env.KNODO_CERT_SUBJECT || process.env.KNODO_CERT_SHA1) signMode = 'Windows 证书库（主题 / 指纹）';
console.log(`[build] 代码签名：${signMode}`);

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

/**
 * 把 win-unpacked 压成 7z 便携包。
 *
 * 必须等 electron-builder 全部跑完再压：此时 win-unpacked 已经过 afterPack 的语言包裁剪
 * （55 → 2 个 .pak），若在裁剪前就压，包会白白大 15MiB 并顶穿 100MiB 上限。
 * 标记文件只在压缩期间存在，`finally` 里删掉，避免污染 win-unpacked（安装版从它取文件）。
 */
async function packPortable7z() {
  const unpacked = path.join(root, 'dist', 'win-unpacked');
  const exePath = path.join(unpacked, `${pkg.build.productName}.exe`);
  if (!fs.existsSync(exePath)) throw new Error('未找到 dist/win-unpacked 里的可执行文件，无法打便携包');
  if (!fs.existsSync(SEVEN_ZIP)) throw new Error(`未找到 7za：${SEVEN_ZIP}（npm i 的 devDependencies 缺失？）`);

  const out = path.join(root, 'dist', `${pkg.build.productName}-${pkg.version}-便携版.7z`);
  // 7za 的 `a` 对已存在的包是「追加/更新」，不是覆盖 —— 不先删会混进旧版本的文件
  try { fs.unlinkSync(out); } catch { /* 本来就没有 */ }

  const marker = path.join(unpacked, PORTABLE_MARKER);
  fs.writeFileSync(marker, `${pkg.build.productName} ${pkg.version}\n`
    + '本文件让程序把数据写在同级的 data/ 目录（便携版）。删除它会退化成安装版行为（数据写 %APPDATA%）。\n');

  try {
    console.log('\n[build] 压便携包（LZMA2 solid，约 2 分钟）…');
    await new Promise((resolve, reject) => {
      const p = spawn(SEVEN_ZIP, ['a', '-t7z', '-mx9', '-ms=on', out, '*'], {
        cwd: unpacked,
        stdio: 'inherit',
      });
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`7za 退出码 ${c}`))));
    });
  } finally {
    try { fs.unlinkSync(marker); } catch { /* 已被清掉 */ }
  }

  const size = fs.statSync(out).size;
  if (size > 100 * 1024 * 1024) {
    throw new Error(`便携包 ${(size / 1048576).toFixed(1)} MiB 超过 Gitee 单附件 100MiB 上限`);
  }
}

/** dist 下最终产物的大小报告（超过 100MiB 直接点名，免得发布时才炸） */
function report() {
  const distDir = path.join(root, 'dist');
  const prefix = `${pkg.build.productName}-${pkg.version}-`;
  const files = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).filter((f) => f.startsWith(prefix) && /\.(exe|7z)$/i.test(f))
    : [];
  console.log('\n[build] 产物');
  for (const f of files) {
    const size = fs.statSync(path.join(distDir, f)).size;
    const over = size > 100 * 1024 * 1024 ? '  ✗ 超 Gitee 单附件 100MiB' : '  ✓';
    console.log(`  ${f.padEnd(34)} ${(size / 1048576).toFixed(1).padStart(6)} MiB${over}`);
  }
}

/* `--no-portable` 只给 dist:installer 用：跳过 7z 打包，省 2 分钟。
   它是本脚本自造的开关，不能透传给 electron-builder（那边会报未知参数）。 */
const rawArgs = process.argv.slice(2);
const skipPortable = rawArgs.includes('--no-portable');
const cliArgs = rawArgs.filter((a) => a !== '--no-portable');

const args = [cli, '--win', '--x64', ...cliArgs, '--config', tmpConfig];

console.log('[build] electron-builder ' + args.slice(1).join(' '));
const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
child.on('exit', async (code) => {
  try { fs.unlinkSync(tmpConfig); } catch { /* 已清理 */ }
  if (code !== 0) process.exit(code == null ? 1 : code);

  if (skipPortable) {
    console.log('\n[build] 已跳过便携包（--no-portable），本次只出安装版');
  } else {
    try {
      await packPortable7z();
    } catch (e) {
      console.error(`\n[build] ✗ 便携包生成失败：${e && e.message ? e.message : e}`);
      process.exit(1);
    }
  }

  report();
  /* 出包后必须再对 win-unpacked 跑一次**产物**冒烟。
     `npm run smoke` 是 electron .（源码目录），读仓库 package.json；
     而 asar 里的 package.json 被 electron-builder 剔掉了 build / devDependencies，
     于是「源码能跑、装完就崩」的问题只有产物冒烟能拦住
     —— v2.2.0（pkg.build.appId 崩溃）就是这样漏出去的。
     想跳过（仅限调试打包参数时）：KNODO_SKIP_PACKAGED_SMOKE=1 */
  if (process.env.KNODO_SKIP_PACKAGED_SMOKE === '1') {
    console.log('\n[build] 已跳过产物冒烟（KNODO_SKIP_PACKAGED_SMOKE=1）——发布前务必手动补跑');
    process.exit(0);
  }
  console.log('\n[build] 对打包产物跑冒烟（scripts/smoke-packaged.js）');
  const smoke = spawn(process.execPath, [path.join(__dirname, 'smoke-packaged.js')], {
    cwd: root,
    stdio: 'inherit',
  });
  smoke.on('exit', (c) => {
    if (c !== 0) console.error('\n[build] ✗ 产物冒烟失败，本次构建不可发布');
    process.exit(c == null ? 1 : c);
  });
});
