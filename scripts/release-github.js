'use strict';
/**
 * GitHub 发行版（Release）一键发布脚本 —— 与 release-gitee.js 并行使用。
 *
 * 用法：
 *   GH_TOKEN=<你的 PAT> npm run release:github              # 发布 dist/release/ 下所有附件
 *   GH_TOKEN=<pat> npm run release:github -- --tag v2.5.0   # 指定 tag（默认 v<package.json version>）
 *   GH_TOKEN=<pat> npm run release:github -- --draft        # 先建草稿，人工点发布
 *
 * 前置条件：
 *   1. 已执行 npm run dist，且 dist/release/ 下已放好要发布的附件；
 *   2. 令牌具备 repo 权限（经典令牌勾 repo；细粒度令牌给 Contents: Read and write）；
 *   3. 代码已经提交 —— 脚本按 HEAD 打 tag，**提交必须在发布之前**。
 *
 * 行为：
 *   1. 打 tag 并推送（远端已有同名 tag 则跳过）；
 *   2. 调 GitHub API 创建 Release（同 tag 已存在则复用并 PATCH 说明）；
 *   3. 逐个上传 dist/release/ 附件（同名已存在则跳过，并核对字节数）。
 * 令牌只从环境变量/参数读取，绝不写入任何文件。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(REPO_ROOT, 'dist', 'release');
const API = 'https://api.github.com';
const UPLOAD_API = 'https://uploads.github.com';

// ---- 参数与令牌 ----
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : '';
};
const token = argOf('--token') || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!token) {
  console.error('缺少 GitHub 令牌：请设置环境变量 GH_TOKEN，或用 --token <token> 传入。');
  console.error('生成入口：https://github.com/settings/tokens/new?scopes=repo （勾选 repo）。');
  process.exit(1);
}
const pkg = require(path.join(REPO_ROOT, 'package.json'));
const BRAND = (pkg.build && pkg.build.productName) || pkg.name;
const tag = argOf('--tag') || `v${pkg.version}`;
const draft = argv.includes('--draft');

// ---- 从 git remote 解析 owner/repo（优先 remote.github，回退 remote.origin）----
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
const sha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
const run = (cmd) => execSync(cmd, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// ---- HTTP ----
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': `${pkg.name}-release`,
};

async function api(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * GitHub 的附件名只接受 ASCII —— 实测上传 `测试-中文.txt` 会被存成 `-.txt`（非 ASCII 字符直接滤掉，
 * 不报错）。所以本地沿用 Gitee 的中文产物名，上传时映射成英文，两站的文件名因此不同但内容一致。
 */
const ASSET_ALIAS = [
  [/便携版/, 'portable'],
  [/安装版/, 'setup'],
  [/卸载/, 'uninstall'],
];

function assetName(local) {
  let out = local;
  for (const [re, to] of ASSET_ALIAS) out = out.replace(re, to);
  // 兜底：剩下的非 ASCII 一律去掉，避免静默改名
  if (!/^[\x20-\x7e]+$/.test(out)) {
    const cleaned = out.replace(/[^\x20-\x7e]/g, '').replace(/-+/g, '-').replace(/-\./g, '.');
    console.warn(`   ⚠ 附件名含非 ASCII 字符，已按 GitHub 规则改为：${cleaned}`);
    out = cleaned;
  }
  return out;
}

/** 发行说明。发新版本时改这一段（与 release-gitee.js 各自独立维护，措辞按站点受众微调）。 */
function releaseBody() {
  return [
    `## ${BRAND} ${tag}`,
    '',
    '> **只是想用它，不想看代码？** 滑到本页最底部「Assets」，点 '
      + `\`${assetName(`${BRAND}-${pkg.version}-便携版.7z`)}\`，解压一次后双击里面的 Knodo.exe 就能用（免安装、免注册）。`,
    '> 若被 Windows 拦下：点「更多信息 → 仍要运行」。国内访问慢可走 '
      + '[Gitee 镜像](https://gitee.com/kiverson/todo-task/releases/latest)，两边包完全一致（那边文件名带「便携版 / 安装版」）。',
    '',
    '### 下载',
    `- **${assetName(`${BRAND}-${pkg.version}-便携版.7z`)}**（推荐，Gitee 站内名为 \`${BRAND}-${pkg.version}-便携版.7z\`）：`
      + '**解压一次，之后双击即用**。数据写在 exe 同级的 `data/` 目录，不写系统 AppData，整个文件夹拷走即可换机。',
    `- **${assetName(`${BRAND}-${pkg.version}-安装版.exe`)}**（Gitee 站内名为 \`${BRAND}-${pkg.version}-安装版.exe\`）：`
      + '双击安装，可选安装目录、生成桌面与开始菜单快捷方式，可设开机自启。'
      + '数据在 `%APPDATA%\\todo-desktop`，适合长期在同一台电脑上使用。',
    '- GitHub 会把附件名里的中文滤掉，所以这里用英文名（portable / setup），包内容与 Gitee 上的中文名文件逐字节一致。',
    '- 两者功能完全一致，只是数据位置、安装方式不同；两者都未做代码签名，首次运行可能被 SmartScreen 拦一次。',
    '',
    '### 本版更新（v2.5.0）',
    '- **窗口外壳重做**：撤掉系统标题栏与 Electron 菜单栏，改由渲染层自绘 40px 标题栏 —— '
      + 'logo、版本号、设置齿轮、日历入口、窗口三键全部归位到一条上。三键是自绘的，'
      + '所以不会再盖住应用内部的弹窗；代价是 Win11 的 Snap Layouts 悬停菜单不再出现，'
      + '拖边吸附、`Win + ↑↓←→`、双击标题栏最大化照旧可用',
    '- **侧栏瘦身**：去掉与标题栏重复的品牌块，底部工具条整块移除，整列只留一个滚动区；'
      + '设置入口是标题栏上骑在分界线左侧的齿轮，日历入口在分界线右侧，两颗按钮等高对称',
    '- **菜单能力收进设置中心**：原来的 File / View 菜单项按功能分派到「工具」「数据与备份」「趣味功能」「关于」，'
      + '快捷键 `Ctrl+,` 与 `Ctrl+Shift+I` 保留，缩放与 `F12` 改走窗口级按键',
    '- **出厂默认配色改为宣纸**：从没手动设过主题的用户，第一次打开就是暖米色纸面，不再是一屏冷白；'
      + '首帧直接按最终配色绘制，不会先闪一下白再跳色',
    '- **卡片与日历统一到同一张纸**：任务行、日历格子不再用接近纯白的面板色压在地面上，'
      + '轮廓只靠描边与悬停阴影；日历整套配色换成主题 token，切风格不再出现蓝黑撞棕黑',
    '- **桌面浮窗跟随主题**：底色、文字、主色全部取自当前风格，浅色主题下不再是一块冷白纸片；'
      + '「设置 → 外观 → 桌面浮窗」新增不透明度滑块（55–100，默认 95），随时调实一点或透一点',
    '- **下线「实用工具」**（文本对比 / JSON 查看器 / 代码格式化）：入口、快捷键与依赖一并移除，'
      + '主界面更清爽；需要这类能力时用专门的工具更顺手',
    '- **修复详情抽屉打开后主界面变灰**：上一版把面板底色误挂到了全屏容器上，'
      + '现在颜色只给真正的浮起面板，遮罩退成纯点击层，打开详情时左侧列表照常清晰可见',
    '- **修复浮窗勾选后主窗「今天」把任务弄丢**：主窗口开着（有焦点）时在浮窗勾掉一条，'
      + '主窗刷新后那条会消失；现在记账与焦点解耦，浮窗勾选的完成态一定能被主窗接住',
    '- **浮窗里勾掉即时消失**：小窗只画未完成行，勾上后淡出移除、窗口自动变矮；'
      + '主窗口的「今日已完成」照旧保留，顶部 `1/5` 进度读数不受影响',
    '- **便签也能吸到屏幕左右边缘**：把「未完成」便签拖到左 / 右边缘松手即可侧吸，'
      + '不再只有顶部一条；侧吸宽度 232px，展开高度按内容量，'
      + '右吸位置按实测窗宽校正（透明无边框窗读回的宽度常比请求值多 1~2px，否则会露出屏幕外）',
    '- **修掉展开 / 收起时的抽搐**：便签展开时窗口自己变高变宽，会把鼠标「挤出」窗口触发 mouseleave，'
      + '于是刚展开就收起；现在收起前先看指针是否真的还在面板上',
    '- **日历里早于今天的完成态改为只读**：过去那几天的勾选框变灰、光标提示不可点，'
      + '避免误把历史任务的归属日挪走或抹掉重复事项那天的打卡；改历史请走列表 / 详情 / 打卡日历',
    '',
    '### 升级说明',
    '- 覆盖安装 / 解压覆盖即可，数据库自动迁移，设置与笔记不受影响；',
    '- 上一版若钉过桌面浮窗，位置与清单保留；浮窗外观会立刻跟当前主题，可在「设置 → 外观」里调不透明度。',
    '',
    '---',
    `完整改动：[\`${sha.slice(0, 8)}\`](https://github.com/${slug}/commit/${sha}) · `
      + '使用说明见 [README](https://github.com/' + slug + '#readme) 与 `docs/`。',
  ].join('\n');
}

async function ensureTag() {
  const ref = `refs/tags/${tag}`;
  // 本地 tag 先建（方便 release-gitee.js 与本地核对）
  try { run(`git tag -f ${tag} ${sha}`); } catch { /* 已存在或无权写 .git 时忽略 */ }
  try {
    // 注意：查询接口的 ref 不带 refs/ 前缀（/git/ref/tags/v1.0.0），创建接口才要 refs/tags/...
    await api('GET', `/repos/${slug}/git/ref/tags/${tag}`);
    console.log(`① 远端已有 tag ${tag}，跳过打标签`);
    return;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  await api('POST', `/repos/${slug}/git/refs`, { ref, sha });
  console.log(`① 已创建 tag ${tag} → ${sha.slice(0, 8)}（走 API，不依赖 git 传输）`);
}

async function ensureRelease() {
  try {
    const created = await api('POST', `/repos/${slug}/releases`, {
      tag_name: tag,
      name: `${BRAND} ${tag}`,
      body: releaseBody(),
      draft,
      prerelease: false,
    });
    console.log(`② 已创建 Release ${tag}（id ${created.id}）`);
    return created;
  } catch (e) {
    if (e.status !== 422) throw e;
    const exists = await api('GET', `/repos/${slug}/releases/tags/${tag}`);
    const patched = await api('PATCH', `/repos/${slug}/releases/${exists.id}`, {
      tag_name: tag,
      name: `${BRAND} ${tag}`,
      body: releaseBody(),
      draft,
    });
    console.log(`② Release ${tag} 已存在（id ${patched.id}），已更新发行说明`);
    return patched;
  }
}

async function listAssets(releaseId) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const chunk = await api('GET', `/repos/${slug}/releases/${releaseId}/assets?per_page=100&page=${page}`);
    all.push(...chunk);
    if (chunk.length < 100) break;
  }
  // 缓存规避：加个时间戳参数会让 URL 不同，但 assets 接口本身分页就够新
  return all;
}

async function uploadAssets(releaseId) {
  const files = fs.existsSync(RELEASE_DIR)
    ? fs.readdirSync(RELEASE_DIR).filter((f) => /\.(exe|7z|zip)$/i.test(f))
    : [];
  if (!files.length) {
    console.warn(`③ ${RELEASE_DIR} 下没有可上传的 .exe / .7z / .zip，跳过附件上传`);
    return;
  }
  const existing = await listAssets(releaseId);
  for (const local of files) {
    const name = assetName(local);
    const full = path.join(RELEASE_DIR, local);
    const size = fs.statSync(full).size;
    const hit = existing.find((a) => a.name === name);
    if (hit) {
      const same = hit.size === size;
      console.log(`③ 已存在 ${name}（${(size / 1048576).toFixed(1)} MiB）${same ? '· 字节一致，跳过' : `· ⚠ 大小不同：远端 ${hit.size} / 本地 ${size}`}`);
      continue;
    }
    const buf = fs.readFileSync(full);
    const url = `${UPLOAD_API}/repos/${slug}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    const started = Date.now();
    console.log(`③ 上传 ${local}${local === name ? '' : ` → ${name}`}（${(size / 1048576).toFixed(1)} MiB）…`);
    let json = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 4 && !json; attempt += 1) {
      if (attempt > 1) {
        // 上一次可能其实已经落盘（网络中断但传到服务端），先复查再重传，避免挂出重复附件
        const again = await listAssets(releaseId);
        const landed = again.find((a) => a.name === name && a.size === size);
        if (landed) {
          console.log(`   ↺ 复查发现已上传成功（${(landed.size / 1048576).toFixed(1)} MiB），不重传`);
          json = landed;
          break;
        }
        const wait = 5000 * attempt;
        console.log(`   ⚠ 第 ${attempt - 1} 次失败：${lastErr && lastErr.message}，${wait / 1000}s 后重试`);
        await new Promise((r) => { setTimeout(r, wait); });
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(buf.length),
          },
          body: buf,
        });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
        json = await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
    if (!json) throw new Error(`上传 ${name} 失败：${lastErr && lastErr.message}`);
    console.log(`   ✓ ${json.name} · ${(json.size / 1048576).toFixed(1)} MiB · ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`     下载地址：${json.browser_download_url}`);
  }
  // 收尾：同名多份会被用户下错包，明确提示
  const after = await listAssets(releaseId);
  const seen = new Map();
  for (const a of after) seen.set(a.name, (seen.get(a.name) || 0) + 1);
  for (const [name, count] of seen) {
    if (count > 1) console.warn(`   ⚠ 附件 ${name} 有 ${count} 份重名，手动删掉多余的（GET /releases/${releaseId}/assets 拿 id 后 DELETE）`);
  }
}

async function main() {
  console.log(`→ ${slug} · ${tag} · HEAD ${sha.slice(0, 8)}${draft ? ' · 草稿' : ''}`);
  await ensureTag();
  const release = await ensureRelease();
  await uploadAssets(release.id);
  console.log(`\n完成：${release.html_url || `https://github.com/${slug}/releases/tag/${tag}`}`);
}

main().catch((e) => {
  console.error(`\n发布失败：${e.message}`);
  if (e.status === 401) console.error('令牌无效或已过期，重新生成一个。');
  if (e.status === 403) console.error('令牌权限不足，或触发了 API 限流。');
  process.exit(1);
});
