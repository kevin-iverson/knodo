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
    '### 本版更新（v2.6.0）',
    '- **工时记录（新插件，默认关闭）**：**设置 → 功能插件** 里打开，标题栏「统计」右侧出现「🕒 工时」入口。'
      + '任务行内三个键：**▶** 计时 / 暂停、**☯** 禅模式（全屏、通知静默、不判「离开」）、**■** 结束并记录',
    '- **计时条在页面底部**：计时中浮出一条「🕒 工时计时」，与会议录制条同一形态、同一位置，'
      + '两条同时在场时工时条自动上移 88px；带任务名、暂停 / 继续、结束，一眼能分清是谁在计时',
    '- **报工表**：工具栏按分组 / 标签 / 范围（本周 · 上周 · 本月 · 自定义）/ 口径筛选，'
      + '四张卡给总工时、日均、涉及任务、最长单项，下面是按任务的行（自身 / 含子任务 / 占比）与每日分布；'
      + '「＋ 补录」补没计时的活儿，「导出」把当前范围与筛选存成 CSV，Excel 直接开',
    '- **父任务的工时含全部后代**：聚合靠一条递归 CTE 在查询时现算，`tasks` 表一个字段都不加 —— '
      + '子任务换个父级、父任务删掉，两侧数字当场重算，不会出现「缓存跟真实值对不上、又不知道哪一步算错」',
    '- **计时按 wall clock**：最小化、切程序、合盖再回来，秒数照走；每 60 秒落一次心跳，'
      + '断电或强杀后重启按最后一次心跳对账，超过 12 小时的行自动截断（忘关不会被记成一天）',
    '- **插件是三层卸载**：关闭时不注册任何 IPC、渲染层不加载工时模块、库里只留一张空表；'
      + '标题栏入口常驻，点进去是开启引导（不然关掉就再也找不到开关）。历史记录一律保留，随时可再打开',
    '- **番茄钟下线**：它和工时计时抢同一块位置，而两者的产物（一句话 / 一段时间）通常只想要一个。'
      + '入口、`Ctrl+Enter`、行内进度环与格数、顶栏「今天 N 格」、收尾条一并移除；'
      + '`focus_sessions` 表与历史行保留，只读、不再写入',
    '- **标题栏右侧多了一枚明暗滑块**：点一下在明暗之间切，`←` `→` 也能拨；'
      + '「跟随系统」仍然只放在 设置 → 外观。两态视觉由 `:root[data-theme]` 直接驱动，'
      + '首帧就是对的，不会先闪一下白再跳到深色',
    '- README 与 `docs/功能详解` 里的番茄钟章节换成工时记录，并标出「实用工具」已于 v2.5.0 下线；三张番茄截图一并移出仓库',
    '',
    '### v2.5.2 更新',
    '- **标题栏再高一档**（40 → 50px）：条里的标识、设置齿轮、快捷入口按比例放大（22 / 30 / 30px），'
      + '不然 50px 的空条里塞着 26px 的小按钮，看着是「飘」在上面的',
    '- **统计搬进标题栏**：现在是「🗓 日历 → 📊 统计 → 🐮 搭子」一字排开，都是随手要看的页面；'
      + '侧栏让出来给清单，同时把「未完成」加回侧栏（夹在「即将到期」与「全部任务」之间 —— '
      + '一个看将来，一个看欠账，再往下才是全量）',
    '- **顶栏的 📌 下线**：它紧挨「📝 笔记」，看着像笔记的附属按钮，而且是低频开关、常驻只是噪音。'
      + '便签入口收进侧栏「未完成」的右键菜单（「钉到屏幕顶边」/「取消便签」），三条边吸附、悬停展开都不变',
    '- **顶栏两个入口去掉常驻高亮**：「📝 笔记」和「🔍 AI 检索」原来带着主色描边 + 主色文字，'
      + '看起来像「一直处于选中状态」，和旁边的导入 / 备份 / 录制不是一套语言；'
      + '它们只是弹窗入口，现在回到普通按钮外观，悬停才亮',
    '- README 与入门文档按新入口重写，15 张截图随标题栏高度重拍',
    '',
    '### v2.5.1 更新',
    '- **标题栏自己画**：系统标题栏与菜单栏一起撤掉，顶上是自绘条 —— 左边标识 + 名称 + 版本号，'
      + '左端一组快捷入口（日历 / 统计 / 搭子），贴着侧栏分界线一颗齿轮开设置中心，右端三个窗口键。'
      + '代价是 Win11 的悬停分屏面板拿不到了，拖边吸附、`Win + 方向键`、双击标题栏最大化照旧',
    '- **侧栏腾出空间**：底部工具条与分割线撤掉，整列只留一条滚动区，版本号挪到标题栏',
    '- **便签可以吸到左右两边**（新）：除了贴顶，还能贴屏幕左 / 右边缘 —— 收起时是一条竖条、'
      + '标题竖排，悬停向内展开成面板；拖到任一条边线 6px 内松手就吸附，'
      + '也能走浮窗「⋯ → 吸边位置」。悬停探测放在主进程（拖拽区收不到网页的鼠标事件）',
    '- **新建任务就在列表最后一行**：原来贴着窗口底部的那条固定输入栏撤掉，'
      + '点「＋ 新建」直接把编辑器长在列表末尾，用完即收；优先级下拉换成与分组同一个下拉组件（带色点）',
    '- **新建表单少一次点击**：优先级挪进主行（标题右侧、分组左侧），「⚙ 更多」折叠开关撤掉，详情恒展开 —— '
      + '提醒、标签、备注一眼可见',
    '- **自动快照留得更久**：原来只留 7 天每日 1 份 + 4 周每周 1 份，现在与全量备份同一口径 —— '
      + '**最近两个自然月都留着**，最新一份永远不删，总量仍封顶 500MB',
    '- **修掉会议纪要「重命名」点了没反应**：渲染层调的是 `window.prompt()`，而 Electron 不实现它、'
      + '异常又被异步处理器吞掉，于是毫无反馈；改用应用自己的输入弹窗（标题预填、Enter 提交、Esc 取消、'
      + '出错就地提示），标题上限也从 30 放宽到 60 字',
    '- README 全部截图按新界面重拍（15 张），并补上「吸边便签」整节',
    '',
    '### 更早的版本',
    '- v2.5.0（自绘标题栏首版 / 侧栏瘦身 / 宣纸默认色 / 实用工具下线 / 日历历史只读）'
      + '与 v2.4.x 及以前，见 [GitHub Releases 列表](https://github.com/' + slug + '/releases)'
      + '或 [Gitee 发行版](https://gitee.com/kiverson/todo-task/releases)。',
    '',
    '### 升级说明',
    '- 覆盖安装 / 解压覆盖即可，数据库自动迁移到 **v18**（新增 `worklog_entries` 表，`tasks` 表不动），设置与笔记不受影响；',
    '- 工时插件**默认关闭**：想用就去 设置 → 功能插件 打开，历史工时记录（如果有）跟着开关一起回来；',
    '- 导出文件的 `schemaVersion` 从 14 升到 15（多了工时记录），旧版本导入新文件会被拒，新版本读旧文件没问题；',
    '- 番茄钟已下线：`focus_sessions` 里的历史记录不删不写，只是不再有入口；',
    '- 上一版若钉过桌面浮窗 / 便签，位置与清单保留；浮窗外观会跟当前主题，可在「设置 → 外观」里调不透明度。',
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
  /* 版本号护栏：dist/release/ 是**手工暂存目录**（构建脚本不往里拷），
     上一次发完忘了换，就会把旧版本的包当成新版本传上去 —— 2026-11-12 的 v2.5.1 差点这样发出去。 */
  const stale = files.filter((f) => !f.includes(pkg.version));
  if (stale.length) {
    console.error(`✗ dist/release/ 里的文件与 package.json 版本（${pkg.version}）不符：${stale.join('、')}`);
    console.error(`   先把 dist/release/ 清空，再拷入 dist/${BRAND}-${pkg.version}-*.7z 与 .exe。`);
    process.exit(1);
  }
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
