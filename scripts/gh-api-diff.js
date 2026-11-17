'use strict';
/**
 * 核对「GitHub 远端某个提交」与「本地某个 ref」的内容是否完全一致（按 blob sha 比，不比 commit）。
 *
 * 用途：`git push` 走不通、改用 scripts/push-github-api.js 之前先跑一次 ——
 * 增量推送以远端父提交的 tree 为 base_tree，若两边内容本来就不同，
 * 这次提交会把差异一起带上（本地缺的文件还会被删掉）。**必须先看到三个 0 再推。**
 *
 * 用法：GH_TOKEN=<pat> node scripts/gh-api-diff.js <远端commit> [本地ref=HEAD]
 * 退出码：0 一致 / 1 有差异 / 2 调用失败。
 */
const { execSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!token) {
  console.error('缺少 GitHub 令牌：请设置环境变量 GH_TOKEN。');
  process.exit(1);
}
const remoteRef = process.argv[2];
const localRef = process.argv[3] || 'HEAD';
if (!remoteRef) {
  console.error('用法：GH_TOKEN=<pat> node scripts/gh-api-diff.js <远端commit> [本地ref]');
  process.exit(1);
}

const remoteUrl = (name) => {
  try {
    return execSync(`git config --get remote.${name}.url`, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return ''; }
};
const REMOTE_NAME = remoteUrl('github') ? 'github' : 'origin';
const m = remoteUrl(REMOTE_NAME).match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
if (!m) {
  console.error(`无法从 remote.${REMOTE_NAME} 解析 GitHub 仓库`);
  process.exit(2);
}
const slug = `${m[1]}/${m[2].replace(/\.git$/, '')}`;

async function api(url) {
  const res = await fetch(`${API}${url}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'knodo-gh-api-diff',
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function localTree(ref) {
  const out = execSync(`git -c core.quotepath=false ls-tree -r ${ref}`, { cwd: REPO_ROOT }).toString();
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const hit = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
    if (hit && hit[2] === 'blob') map.set(hit[4], hit[3]);
  }
  return map;
}

(async () => {
  const commit = await api(`/repos/${slug}/git/commits/${remoteRef}`);
  const tree = await api(`/repos/${slug}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) console.warn('⚠ 远端 tree 被截断（仓库文件过多），结果可能不全');
  const rmap = new Map();
  for (const e of tree.tree) if (e.type === 'blob') rmap.set(e.path, e.sha);
  const lmap = localTree(localRef);

  const localSha = execSync(`git rev-parse ${localRef}`, { cwd: REPO_ROOT }).toString().trim();
  console.log(`远端 ${remoteRef.slice(0, 8)} → commit ${commit.sha.slice(0, 8)} · tree ${commit.tree.sha.slice(0, 8)} · ${rmap.size} 个文件`);
  console.log(`本地 ${localRef} → ${localSha.slice(0, 8)} · ${lmap.size} 个文件`);

  const onlyRemote = [...rmap.keys()].filter((p) => !lmap.has(p));
  const onlyLocal = [...lmap.keys()].filter((p) => !rmap.has(p));
  const differ = [...lmap.keys()].filter((p) => rmap.has(p) && rmap.get(p) !== lmap.get(p));
  const show = (label, list) => {
    console.log(`${label}：${list.length}${list.length ? '\n  ' + list.slice(0, 20).join('\n  ') : ''}`);
  };
  show('只在远端（本地缺，推送时会被删）', onlyRemote);
  show('只在本地（远端缺，推送时会新增）', onlyLocal);
  show('内容不同', differ);
  process.exit(onlyRemote.length || onlyLocal.length || differ.length ? 1 : 0);
})().catch((e) => {
  console.error(`对比失败：${e.message}`);
  process.exit(2);
});
