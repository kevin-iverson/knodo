'use strict';
/**
 * Gitee 发行版（Release）一键发布脚本。
 *
 * 用法：
 *   GITEE_TOKEN=<你的私人令牌> npm run release            # 发布 dist/release/ 下所有附件
 *   GITEE_TOKEN=<token> npm run release -- --tag v1.0.1   # 指定 tag（默认 v<package.json version>）
 *
 * 前置条件：
 *   1. 已执行 npm run dist，且 dist/release/ 下已放好要发布的附件（单个 ≤100MB）；
 *   2. Gitee 私人令牌具有 projects 权限（生成入口：Gitee 头像 → 设置 → 安全设置 → 私人令牌）。
 *
 * 行为：
 *   1. 打 tag 并推送（若远端已有同名 tag 则跳过）；
 *   2. 调 Gitee API 创建 Release（已存在则复用）；
 *   3. 逐个上传 dist/release/ 附件（已存在的同名附件跳过）。
 * 令牌只从环境变量/参数读取，绝不写入任何文件。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(REPO_ROOT, 'dist', 'release');
const API = 'https://gitee.com/api/v5';

// ---- 参数与令牌 ----
const argTokenIdx = process.argv.indexOf('--token');
const token = (argTokenIdx > -1 && process.argv[argTokenIdx + 1]) || process.env.GITEE_TOKEN || '';
if (!token) {
  console.error('缺少 Gitee 私人令牌：请设置环境变量 GITEE_TOKEN，或用 --token <token> 传入。');
  console.error('生成入口：Gitee 头像 → 设置 → 安全设置 → 私人令牌 → 生成新令牌（勾选 projects）。');
  process.exit(1);
}
const tagIdx = process.argv.indexOf('--tag');
const pkg = require(path.join(REPO_ROOT, 'package.json'));
const tag = (tagIdx > -1 && process.argv[tagIdx + 1]) || `v${pkg.version}`;

// ---- 从 git remote 解析 owner/repo（兼容 https 与 ssh 地址）----
const remote = execSync('git config --get remote.origin.url', { cwd: REPO_ROOT })
  .toString().trim();
const m = remote.match(/gitee\.com[:/](.+?)(?:\.git)?$/i);
if (!m) {
  console.error(`无法从 remote 解析 Gitee 仓库：${remote}`);
  process.exit(1);
}
const [owner, repo] = m[1].split('/');
const sha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();

const run = (cmd) => execSync(cmd, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

async function main() {
  // 1. tag：本地打 + 推送（远端已存在则跳过）
  let tagExists = false;
  try {
    run(`git ls-remote --tags origin refs/tags/${tag} | grep -q ${tag}`);
    tagExists = true;
  } catch { /* 不存在 */ }
  if (tagExists) {
    console.log(`① 远端已有 tag ${tag}，跳过打标签`);
  } else {
    run(`git tag ${tag} ${sha}`);
    run(`git push origin ${tag}`);
    console.log(`① 已创建并推送 tag ${tag} → ${sha.slice(0, 8)}`);
  }

  // 2. 创建 Release（同名已存在则复用其 id）
  const desc = [
    `## ${pkg.name} ${tag}`,
    '',
    '### 下载',
    '- **TODO待办-*.7z**：免安装版，解压后运行其中的 `TODO待办.exe`（需 7-Zip / WinRAR / Win11 自带解压）。',
    '  数据保存在 exe 同级的 `data/` 目录，整个文件夹拷走即可换机。',
    '',
    '### 安装说明',
    '1. 下载 .7z 文件并解压到任意目录；',
    '2. 双击 `TODO待办.exe` 运行；首次运行如被 SmartScreen 拦截，点「更多信息 → 仍要运行」（未购买代码签名证书）。', '',
    '### 本版功能',
    '- 任务管理（分组/标签/子任务/优先级/计划日期/提醒/归档/统计）',
    '- AI 报告与 AI 检索（支持自定义提示词，历史记录本地持久化）',
    '- 会议录制 → 语音转写 → AI 纪要（支持国内 ASR 预设）',
  ].join('\n');

  let releaseId = null;
  const findRes = await fetch(`${API}/repos/${owner}/${repo}/releases/tags/${tag}?access_token=${encodeURIComponent(token)}`);
  if (findRes.ok) {
    const rel = await findRes.json();
    releaseId = rel.id;
    console.log(`② Release ${tag} 已存在（id=${releaseId}），直接复用`);
  } else {
    const createRes = await fetch(`${API}/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        tag_name: tag,
        name: `${pkg.name} ${tag}`,
        body: desc,
        target_commitish: sha,
        prerelease: false,
      }),
    });
    if (!createRes.ok) {
      console.error(`创建 Release 失败：${createRes.status} ${await createRes.text()}`);
      process.exit(1);
    }
    const rel = await createRes.json();
    releaseId = rel.id;
    console.log(`② 已创建 Release ${tag}（id=${releaseId}）`);
  }

  // 3. 上传 dist/release/ 下的附件
  const files = fs.readdirSync(RELEASE_DIR).filter((f) => fs.statSync(path.join(RELEASE_DIR, f)).isFile());
  if (!files.length) {
    console.error(`dist/release/ 下没有附件。先运行 npm run dist 并把要发布的文件放进去。`);
    process.exit(1);
  }
  const existRes = await fetch(`${API}/repos/${owner}/${repo}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(token)}`);
  const existed = new Set(existRes.ok ? (await existRes.json()).map((a) => a.name) : []);

  for (const name of files) {
    if (existed.has(name)) {
      console.log(`③ 附件 ${name} 已存在，跳过`);
      continue;
    }
    const filePath = path.join(RELEASE_DIR, name);
    const size = fs.statSync(filePath).size;
    if (size > 100 * 1024 * 1024) {
      console.error(`✗ ${name} 超过 Gitee 单附件 100MB 上限（${(size / 1048576).toFixed(1)}MB），请先压缩或瘦身。`);
      continue;
    }
    process.stdout.write(`③ 上传 ${name}（${(size / 1048576).toFixed(1)}MB）… `);
    const form = new FormData();
    form.append('access_token', token);
    form.append('file', new Blob([fs.readFileSync(filePath)]), name);
    const upRes = await fetch(`${API}/repos/${owner}/${repo}/releases/${releaseId}/attach_files`, {
      method: 'POST',
      body: form,
    });
    if (upRes.ok) {
      console.log('完成');
    } else {
      console.log(`失败：${upRes.status} ${await upRes.text()}`);
    }
  }
  console.log(`\n✅ 发布完成：https://gitee.com/${owner}/${repo}/releases/tag/${tag}`);
}

main().catch((e) => {
  console.error('发布失败：', e.message);
  process.exit(1);
});
