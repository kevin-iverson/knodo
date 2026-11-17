'use strict';
/**
 * 用 Git Data API 把本地提交的内容推到 GitHub —— 只在 `git push` 走不通时用。
 *
 * 什么时候需要它：本机到 github.com 的 git 传输常常被代理挡住（`CONNECT tunnel failed 502`、
 * schannel 握手失败），但 `api.github.com` 是通的。这时 `git push` 永远失败，而代码又必须上远端，
 * 只能改成「读本地 tree → 上传差异 blob → 建 tree / commit → 快进 ref」。
 *
 * 先跑一次内容核对，确认远端父提交与本地内容一致（否则会把差异一起推上去、或删掉别人加的文件）：
 *   node scripts/gh-api-diff.js <远端commit> <本地ref>
 * 输出「只在远端 0 / 只在本地 0 / 内容不同 0」再往下走。
 *
 * 用法：
 *   GH_TOKEN=<pat> node scripts/push-github-api.js --base <远端父提交sha> --msg-file <提交信息文件>
 *   GH_TOKEN=<pat> node scripts/push-github-api.js --base <sha> --msg-file m.txt --from <本地ref> [--dry]
 *
 *   --base     远端当前 main 的 sha（这一次提交的父提交）。**必须是真的远端 sha**，不是本地 HEAD。
 *   --from     用哪个本地 ref 的 tree（默认 HEAD）。分批推多个本地提交时，逐个指定。
 *   --msg-file 提交信息（多行写文件，别用 shell here-string）。
 *   --dry      只打印将要上传 / 删除的文件，不调写入接口。
 *
 * 行为与保证：
 *   1. blob 是内容寻址的，上传后会逐项核对返回的 sha 与本地 `git ls-tree` 的 sha 一致 —— 不一致立刻失败；
 *   2. 新 tree 以远端父提交的 tree 为 base_tree：没改的文件原样继承，本地缺的文件显式删除；
 *   3. 建完 commit 用 `force:false` 快进 ref，远端若在这期间前进过会直接报错（不会覆盖别人的提交）。
 *
 * ⚠ 用它会得到**与本地不同的提交 sha**（作者 / 时间 / 父提交都按 API 这一次生成）。
 *   因此发布时要把远端 sha 传给 release 脚本：`npm run release:github -- --sha <远端sha>`，
 *   否则 tag 会指向一个远端不存在的对象。
 *
 * 令牌只从环境变量 / 参数读取，绝不写进任何文件。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';

// ---- 参数与令牌 ----
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : ''; };
const token = argOf('--token') || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!token) {
  console.error('缺少 GitHub 令牌：请设置环境变量 GH_TOKEN，或用 --token <token> 传入。');
  process.exit(1);
}
const baseSha = argOf('--base');
const msgFile = argOf('--msg-file');
const fromRef = argOf('--from') || 'HEAD';
const dry = argv.includes('--dry');
if (!baseSha || !msgFile) {
  console.error('用法：node scripts/push-github-api.js --base <远端父提交sha> --msg-file <文件> [--from <ref>] [--dry]');
  process.exit(1);
}
const message = fs.readFileSync(path.resolve(REPO_ROOT, msgFile), 'utf8').trim();
if (!message) {
  console.error(`提交信息为空：${msgFile}`);
  process.exit(1);
}

// ---- 从 remote.github（回退 origin）解析仓库 ----
const remoteUrl = (name) => {
  try {
    return execSync(`git config --get remote.${name}.url`, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return ''; }
};
const REMOTE_NAME = remoteUrl('github') ? 'github' : 'origin';
const remote = remoteUrl(REMOTE_NAME);
const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
if (!m) {
  console.error(`无法从 remote.${REMOTE_NAME} 解析 GitHub 仓库：${remote || '(空)'}`);
  process.exit(1);
}
const [owner, repo] = [m[1], m[2].replace(/\.git$/, '')];
const slug = `${owner}/${repo}`;
const BRANCH_REF = 'heads/main';

const api = async (method, url, body) => {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `${path.basename(process.argv[1])}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

const local = (cmd, opts = {}) => execSync(cmd, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024, ...opts });

/** 本地 ref 的 tree：path → { sha, mode }（中文路径不能被 quotepath 转义，否则与远端 path 对不上） */
function localTree() {
  const out = local(`git -c core.quotepath=false ls-tree -r ${fromRef}`).toString();
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const hit = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
    if (hit && hit[2] === 'blob') map.set(hit[4], { sha: hit[3], mode: hit[1] });
  }
  return map;
}

async function main() {
  const baseCommit = await api('GET', `/repos/${slug}/git/commits/${baseSha}`);
  const remoteTree = await api('GET', `/repos/${slug}/git/trees/${baseCommit.tree.sha}?recursive=1`);
  if (remoteTree.truncated) throw new Error('远端 tree 被截断（文件过多），拒绝按增量推送');
  const rmap = new Map();
  for (const e of remoteTree.tree) if (e.type === 'blob') rmap.set(e.path, e.sha);
  const lmap = localTree();

  const upserts = [...lmap.entries()].filter(([p, v]) => rmap.get(p) !== v.sha);
  const deletes = [...rmap.keys()].filter((p) => !lmap.has(p));
  console.log(`父提交 ${baseSha.slice(0, 8)} · 远端 ${rmap.size} 文件 / 本地 ${fromRef} ${lmap.size} 文件`);
  console.log(`待上传 ${upserts.length} 个文件${deletes.length ? `；待删除 ${deletes.length} 个` : ''}`);
  for (const [p] of upserts) console.log(`  + ${p}`);
  for (const p of deletes) console.log(`  - ${p}`);
  if (dry) {
    console.log('\n--dry：到此为止，没有调用写入接口');
    return;
  }
  if (!upserts.length && !deletes.length) {
    console.log('\n内容与远端一致，不需要新建提交');
    return;
  }

  // 上传 blob：内容寻址，返回的 sha 必然等于本地 sha —— 逐项核对，避免把编码问题悄悄推上去
  const entries = [];
  let done = 0;
  const queue = upserts.slice();
  const CONCURRENCY = 5;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const [p, v] = item;
      const buf = local(`git cat-file blob ${v.sha}`, { encoding: 'buffer' });
      const blob = await api('POST', `/repos/${slug}/git/blobs`, {
        content: buf.toString('base64'), encoding: 'base64',
      });
      if (blob.sha !== v.sha) throw new Error(`${p} 的 blob sha 不一致：本地 ${v.sha} / 远端 ${blob.sha}`);
      entries.push({ path: p, mode: v.mode, type: 'blob', sha: blob.sha });
      done += 1;
      if (done % 10 === 0) console.log(`  … 已上传 ${done}/${upserts.length}`);
    }
  });
  await Promise.all(workers);
  // 删除项：tree 里给 sha:null 即可（mode / type 仅为形式）
  for (const p of deletes) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });

  const tree = await api('POST', `/repos/${slug}/git/trees`, { base_tree: baseCommit.tree.sha, tree: entries });
  console.log(`② 新 tree ${tree.sha.slice(0, 8)}（${entries.length} 项改动）`);

  const identity = {
    name: local('git config user.name').toString().trim() || 'knodo',
    email: local('git config user.email').toString().trim() || 'knodo@localhost',
    date: new Date().toISOString(),
  };
  const commit = await api('POST', `/repos/${slug}/git/commits`, {
    message, tree: tree.sha, parents: [baseSha], author: identity, committer: identity,
  });
  console.log(`③ 新 commit ${commit.sha}`);
  console.log(`   https://github.com/${slug}/commit/${commit.sha}`);

  const patched = await api('PATCH', `/repos/${slug}/git/refs/${BRANCH_REF}`, { sha: commit.sha, force: false });
  console.log(`④ refs/${BRANCH_REF} → ${patched.object.sha.slice(0, 8)}`);
  console.log(`\n完成。远端 sha：${commit.sha}（发布时传给 --sha）`);
}

main().catch((e) => {
  console.error(`\n推送失败：${e.message}`);
  process.exit(1);
});
