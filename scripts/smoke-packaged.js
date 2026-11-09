'use strict';
/**
 * 打包产物冒烟：直接在 dist/win-unpacked 里跑 `Knodo.exe --smoke-test`。
 *
 * 为什么单独需要它 —— `npm run smoke` 是 `electron .`，跑的是**源码目录**，
 * 读的是仓库里的 package.json（有 build、有 devDependencies）。而 electron-builder
 * 写进 app.asar 的 package.json 只保留
 *   name / version / description / main / author / license / repository / dependencies
 * 两段配置被整段剔掉。于是「源码能跑、装完就崩」的一类故障源码冒烟永远测不到：
 *   · v2.2.0：main/app-identity.js 顶层读 pkg.build.appId → undefined.appId → 启动即崩
 *   · koffi 漏进 build.asarUnpack → 打包后 require 失败，静默降级
 *   · 附件 / 预置数据目录漏打 → 运行期找不到文件
 * 这一步就是那另一半验证。
 *
 * 判定方式：等主进程打印 `[SMOKE] SMOKE_OK` / `[SMOKE] SMOKE_FAIL`。
 * 进程在打印前就退出，或超时仍未打印，都算失败（启动即崩会弹错误框并挂住，
 * 所以超时必须 kill，否则整个构建卡死）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const productName = (pkg.build && pkg.build.productName) || 'Knodo';
const exePath = path.join(root, 'dist', 'win-unpacked', `${productName}.exe`);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 240000);

if (!fs.existsSync(exePath)) {
  console.error(`[smoke:packaged] 找不到打包产物：${exePath}`);
  console.error('[smoke:packaged] 先跑 npm run dist');
  process.exit(1);
}

console.log(`[smoke:packaged] 运行 ${path.relative(root, exePath)} --smoke-test`);

/* 必须剔掉 ELECTRON_RUN_AS_NODE：某些宿主（CI、编辑器内置终端）会把它设为 1，
   那样 Electron 以纯 Node 模式启动，把 --smoke-test 当成非法 node 选项直接
   报 `bad option`，产物压根没进主进程 —— 冒烟会得出假结论。 */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(exePath, ['--smoke-test'], {
  cwd: path.dirname(exePath),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let settled = false;

/** 留尾部若干行做诊断，不要刷屏整个 DOM 断言日志 */
function tail(text, lines = 25) {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join('\n');
}

function finish(ok, reason) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (!ok) {
    console.error(`\n[smoke:packaged] ✗ ${reason}`);
    if (out.trim()) console.error(`---- 产物输出（末 25 行）----\n${tail(out)}\n----`);
  } else {
    console.log('[smoke:packaged] ✓ 打包产物冒烟通过');
  }
  // 打包版是 GUI 进程，正常退出也可能残留子进程，统一 taskkill 兜底
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 已退出 */ }
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
}

function scan(chunk) {
  out += chunk;
  if (out.includes('[SMOKE] SMOKE_OK')) finish(true);
  else if (out.includes('[SMOKE] SMOKE_FAIL')) finish(false, '产物内 DOM / 模块断言失败（SMOKE_FAIL）');
}

child.stdout.on('data', (b) => scan(b.toString()));
child.stderr.on('data', (b) => scan(b.toString()));

child.on('error', (e) => finish(false, `无法启动产物：${e.message}`));
/* 必须等 'close' 而不是 'exit'：'exit' 只表示进程结束，此时 stdio 管道里可能还有
   未读完的数据（产物日志将近 100 行，末尾的 SMOKE_OK 正好在最后）。用 'exit' 会在
   数据到齐之前就判定「未打印 SMOKE_OK 即退出」，把一次通过的冒烟报成失败 —— v2.3.0
   首次构建就踩到了（手动跑同一份产物，98 行、末行 SMOKE_OK、exit 0）。
   'close' 在所有 stdio 流关闭后才触发，数据一定已经进过 scan()。 */
child.on('close', (code, signal) => {
  // 正常路径由 SMOKE_OK 先行收尾；走到这里还没打印，就是启动期就挂了
  finish(false, `产物在打印 SMOKE_OK 之前退出（code=${code} signal=${signal || '-'}）`);
});

const timer = setTimeout(() => {
  finish(false, `超时 ${TIMEOUT_MS / 1000}s 仍未打印 SMOKE_OK`);
}, TIMEOUT_MS);
