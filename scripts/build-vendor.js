'use strict';
/**
 * 把笔记正文渲染要用的第三方库打包进 renderer/vendor/。
 *
 * 现在只剩两个产物：
 *   · renderer/vendor/highlight/highlight.min.js —— highlight.js 裁到 11 种语言，打成 IIFE 挂 globalThis.hljs；
 *   · renderer/vendor/mermaid/mermaid.mjs       —— mermaid 裁到 5 类图表，ESM 供动态 import。
 *
 * 为什么不是直接拷 UMD 文件：上游只发 ESM + CJS（还带若干子包），而打包后的应用只带
 * renderer/**（不含 node_modules），所以必须在构建期压成自包含文件。
 *
 * 产物随仓库提交（离线可运行）。
 * 原「实用工具」（代码格式化 / 文本对比 / JSON 查看器）已整体下线，对应的
 * format-core / format-java / diff / highlight(tools) / json-viewer / jsonpath 六个 target 一并删除。
 *
 * 用法：npm run build:vendor
 */
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

/** renderer/vendor/ 下的子目录（按需懒加载的库） */
const HL_DIR = path.join(ROOT, 'renderer', 'vendor', 'highlight');
const MERMAID_DIR = path.join(ROOT, 'renderer', 'vendor', 'mermaid');

/* ---------------- mermaid 裁剪：只保留常用图表 ---------------- */

/**
 * 保留的图表类型（mermaid 内部的 detector id）。
 * 必须与渲染层的 MERMAID_TYPES 白名单（renderer/js/markdown-lib.js）保持一致。
 */
const MERMAID_KEEP = ['flowchart-v2', 'sequence', 'classDiagram', 'gantt', 'pie'];

/**
 * 额外置空的布局插件：cose-bilkent（约 0.5MB，里面是 cytoscape）。
 * 它只在 flowchart 显式写了 `defaultRenderer: 'cose-bilkent'` 时才用得到，
 * 默认布局是 ELK —— **elkjs 不能裁**（1.5MB，但流程图 / 类图的默认布局就是它，
 * 裁掉之后图会画成一堆重叠的方块，实测过）。
 */
const MERMAID_DROP_LAYOUT = /^cose-bilkent-.*\.mjs$/;

/**
 * 空桩：mermaid 的 loader 拿到 `{ diagram }` 就返回；布局 loader 那边会直接调
 * `module.render(...)`，所以必须给一个空实现 —— 少这个导出会抛
 * 「render is not a function」，连带着把整张图废掉。
 */
const MERMAID_STUB = 'export const diagram = {}; export default {}; export const load = async () => ({}); '
  + 'export const render = async () => ({});\n';

/**
 * mermaid 12 把每种图表都做成「detector + 动态 import 的 loader」，但**打包成单文件**时
 * esbuild 会把那些动态 import 全部内联进来 —— 于是 30 多种图表 + ELK 布局（共 5MB）
 * 一股脑塞进 renderer/vendor/mermaid/mermaid.mjs，而笔记里其实只用得到五种图。
 *
 * 做法：从 mermaid.core.mjs 里解析出「detector id → 懒加载模块」，把 keep 列表之外的模块
 * 换成空桩。esbuild 解析时就不再去读那些模块，产物体积随之掉下来（5.0MB → 约 3.6MB；
 * 剩下的 1.5MB 是流程图 / 类图默认布局用的 elkjs，裁不掉）。
 * 上游改版导致解析不到时**直接报错**，不静默降级成「悄悄打回 5MB」。
 */
function mermaidStubPlugin() {
  const corePath = path.join(ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.core.mjs');
  const lines = fs.readFileSync(corePath, 'utf8').split(/\r?\n/);
  const modOfId = new Map();
  let curId = null;
  for (const ln of lines) {
    const idHit = /^var id\d* = "([^"]+)";/.exec(ln);
    if (idHit) { curId = idHit[1]; continue; }
    if (!curId) continue;
    const impHit = /import\("(\.\/chunks\/mermaid\.core\/[^"]+)"\)/.exec(ln);
    if (impHit) { modOfId.set(curId, path.basename(impHit[1])); curId = null; }
  }
  const keepMods = new Set();
  MERMAID_KEEP.forEach((id) => {
    const m = modOfId.get(id);
    if (m) keepMods.add(m);
  });
  if (modOfId.size < MERMAID_KEEP.length || keepMods.size !== MERMAID_KEEP.length) {
    throw new Error(
      `mermaid 裁剪失败：在 mermaid.core.mjs 里没找到这些图表（${MERMAID_KEEP.join(', ')}）。`
      + '上游打包结构可能变了，请检查 build-vendor.js 的解析逻辑。',
    );
  }
  const stubMods = new Set();
  for (const [id, mod] of modOfId) {
    if (!MERMAID_KEEP.includes(id) && !keepMods.has(mod)) stubMods.add(mod);
  }
  const layoutDir = path.join(ROOT, 'node_modules', 'mermaid', 'dist', 'chunks', 'mermaid.core');
  fs.readdirSync(layoutDir).forEach((f) => { if (MERMAID_DROP_LAYOUT.test(f)) stubMods.add(f); });

  console.log(`  mermaid 裁剪：保留 ${keepMods.size} 类图表，置空 ${stubMods.size} 个模块`);
  return {
    name: 'mermaid-diagram-prune',
    setup(build) {
      build.onResolve({ filter: /\.mjs$/ }, (args) => (
        stubMods.has(path.basename(args.path))
          ? { path: `mermaid-stub:${path.basename(args.path)}`, namespace: 'mermaid-stub' }
          : null
      ));
      build.onLoad({ filter: /.*/, namespace: 'mermaid-stub' }, () => ({ contents: MERMAID_STUB, loader: 'js' }));
    },
  };
}

const TARGETS = [
  // 笔记正文渲染用：highlight.js 打成 IIFE 挂 globalThis.hljs（markdown-it 的
  // highlight 钩子是同步的，必须随页面一起就绪，不能动态 import）
  { entry: 'highlight-global.mjs', out: 'highlight.min.js', dir: HL_DIR, format: 'iife' },
  // mermaid 打成 ESM，由渲染层检测到 ```mermaid 时动态 import 进来；
  // 只带流程图 / 时序图 / 类图 / 甘特图 / 饼图（其余图表在插件里被置空）
  { entry: 'mermaid.mjs', out: 'mermaid.mjs', dir: MERMAID_DIR, plugins: () => [mermaidStubPlugin()] },
];

async function build() {
  const jobs = TARGETS.map((t) =>
    esbuild.build({
      entryPoints: [path.join(__dirname, 'vendor', t.entry)],
      outfile: path.join(t.dir, t.out),
      bundle: true,
      format: t.format || 'esm',
      platform: 'browser',
      target: 'es2020',
      minify: true,
      legalComments: 'none',
      // 个别库会读 process.env.NODE_ENV；浏览器里没有 process，构建期直接内联掉
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: t.plugins ? t.plugins() : [],
      logLevel: 'warning',
    })
  );
  const results = await Promise.all(jobs);
  [HL_DIR, MERMAID_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  TARGETS.forEach((t) => {
    const file = path.join(t.dir, t.out);
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`  ${t.out.padEnd(18)} ${kb.padStart(6)} KB`);
  });
  return results.length;
}


build().then(
  (n) => console.log(`✓ vendor 工具库打包完成（${n} 个文件 → renderer/vendor/{highlight,mermaid}）`),
  (e) => {
    console.error('✗ vendor 工具库打包失败：', (e && e.message) || e);
    process.exit(1);
  }
);
