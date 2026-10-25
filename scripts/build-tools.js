'use strict';
/**
 * 把「实用工具」用到的第三方库打包进 renderer/vendor/tools/。
 *
 * 为什么不是直接拷 UMD 文件：prettier 3 / sql-formatter / xml-formatter / jsdiff 现在都只发
 * ESM + CJS（各自还依赖若干子包），没有可直接 <script> 引入的单文件；而打包后的应用只带
 * renderer/**（不含 node_modules），所以必须在构建期把它们压成自包含的 ESM 文件。
 *
 * 产物随仓库提交（离线可运行），渲染层用动态 import() 按需加载 —— 不打开工具就不付解析成本。
 *
 * 用法：npm run build:tools
 */
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'renderer', 'vendor', 'tools');

const TARGETS = [
  { entry: 'format-core.mjs', out: 'format-core.mjs' },
  { entry: 'format-java.mjs', out: 'format-java.mjs' },
  { entry: 'diff.mjs', out: 'diff.mjs' },
];

async function build() {
  const jobs = TARGETS.map((t) =>
    esbuild.build({
      entryPoints: [path.join(__dirname, 'vendor', t.entry)],
      outfile: path.join(OUT_DIR, t.out),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      minify: true,
      legalComments: 'none',
      // 个别库会读 process.env.NODE_ENV；浏览器里没有 process，构建期直接内联掉
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    })
  );
  const results = await Promise.all(jobs);
  const fs = require('fs');
  TARGETS.forEach((t, i) => {
    const file = path.join(OUT_DIR, t.out);
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`  ${t.out.padEnd(18)} ${kb.padStart(6)} KB`);
  });
  return results.length;
}

build().then(
  (n) => console.log(`✓ vendor 工具库打包完成（${n} 个文件 → renderer/vendor/tools）`),
  (e) => {
    console.error('✗ vendor 工具库打包失败：', (e && e.message) || e);
    process.exit(1);
  }
);
