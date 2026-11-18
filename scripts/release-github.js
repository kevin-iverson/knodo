'use strict';
/**
 * GitHub 发行版（Release）一键发布脚本 —— 与 release-gitee.js 并行使用。
 *
 * 用法：
 *   GH_TOKEN=<你的 PAT> npm run release:github              # 发布 dist/release/ 下所有附件
 *   GH_TOKEN=<pat> npm run release:github -- --tag v2.5.0   # 指定 tag（默认 v<package.json version>）
 *   GH_TOKEN=<pat> npm run release:github -- --draft        # 先建草稿，人工点发布
 *   GH_TOKEN=<pat> npm run release:github -- --sha <sha>    # 指定 tag 指向的提交（默认 HEAD）
 *
 * ⚠ 什么时候需要 --sha：github.com 的 git 传输被挡（代理回 502）时，代码是用 Git Data API 推上去的，
 * 远端提交的 sha 与本地不同。这时必须把远端 sha 传进来，否则 tag 会指向一个远端不存在的对象。
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
const sha = argOf('--sha') || execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
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
      + '[Gitee 镜像](https://gitee.com/kiverson/todo-task/releases/latest)，两站内容一致（各自打包，字节数略有差别；那边文件名带「便携版 / 安装版」）。',
    '',
    '### 下载',
    `- **${assetName(`${BRAND}-${pkg.version}-便携版.7z`)}**（推荐，Gitee 站内名为 \`${BRAND}-${pkg.version}-便携版.7z\`）：`
      + '**解压一次，之后双击即用**。数据写在 exe 同级的 `data/` 目录，不写系统 AppData，整个文件夹拷走即可换机。',
    `- **${assetName(`${BRAND}-${pkg.version}-安装版.exe`)}**（Gitee 站内名为 \`${BRAND}-${pkg.version}-安装版.exe\`）：`
      + '双击安装，可选安装目录、生成桌面与开始菜单快捷方式，可设开机自启。'
      + '数据在 `%APPDATA%\\todo-desktop`，适合长期在同一台电脑上使用。',
    '- GitHub 会把附件名里的中文滤掉，所以这里用英文名（portable / setup），内容与 Gitee 上的中文名包一致（同一份代码、两站各自打包，字节数会有几十 KB 的差别）。',
    '- 两者功能完全一致，只是数据位置、安装方式不同；两者都未做代码签名，首次运行可能被 SmartScreen 拦一次。',
    '',
    '### 本版更新（v2.10.0）',
    '- **四象日记**（新插件，默认关闭）：`设置 → 功能插件 → 四象日记` 打开后，标题栏出现 `📔 日记`，'
      + '`Ctrl+Alt+J` 也能直达。**一天一页**：左边四格 —— 心智 / 身体 / 连结 / 事业（名字可改，如「工作 / 生活 / 学习 / 情绪」），'
      + '每格一句具体的起手式，不为难对着空白页的人；右边是**碎碎念**，白天脑子里冒出来的一句 Enter 就记下、Shift+Enter 换行，'
      + '晚上 hover 一条可「归入某一格」（正文并到那格末尾，可撤销）或「转任务」（前 60 字变今天的一条待办，条目上留痕，重进视图还在）',
    '- **日记有三条刻意的克制**：纯文本，没有工具条、不建全文索引、**不进 AI 检索与报告**；'
      + '不做打卡 —— 只写一格也算记录，只显示「已记录 N 天」这种中性计数，没有连续天数、没有提醒推送；'
      + '不做成长系统 —— 没有等级、没有精力打分、没有 AI 洞察。保存是 800ms 防抖 + 三态提示，切日期或离开视图前立刻落库',
    '- **工位搭子变成插件了**：以前它常驻 —— 不管用不用，浮窗模块、样式、完成任务时的发币监听全都在。'
      + '现在默认关闭，只有 `设置 → 功能插件 → 工位搭子` 打开后才挂载；关掉即整块卸载，'
      + '标题栏 `🐮 搭子`、`Ctrl+Alt+E`、趣味功能菜单一起消失。配置与牛马币留在库里，随时可再开',
    '- **标题栏多了「有新版本」角标**：静默检查查到新版时，版本号右侧亮一枚小角标，'
      + '点它走原来的检查更新（原生对话框给下载 / 发布页两个按钮）—— 不做自动更新、不偷偷重启。'
      + '七套风格 × 明暗都单独校过对比度（故宫红墙上换成米字 + 淡金描边，否则酒红糊在墙里看不见）；'
      + '一旦查到已是最新，角标会自己熄掉，不会一直亮着骗人',
    '- **顶栏入口放不下时自动收成图标**：标题栏左侧已经有五个入口，侧栏拖宽或窗口缩小时，'
      + '右边最后一枚会压住明暗滑块。现在按**展开后的真实宽度**判定，一旦要压住就整排只留图标（悬停有文字），拖回去自动展开；'
      + '判定同时盯着撑开宽度与实际宽度两个来源，不会在临界点上反复抖动',
    '- **修掉「给任务加重复，分组和优先级没了」**：在详情抽屉里给一条已分组的任务勾上重复，'
      + '任务会掉进「未分组」、优先级被重置成中、标签清空。原因是就地转换时规则字段用空 base 重算，'
      + '把原任务的分组 / 优先级 / 标签一起覆盖回默认值',
    '- **修掉「跨天就看不见了」**：每周一、允许 5 天内完成的重复事项，周一没做，周二就从「今天」里消失了 —— '
      + '其实还在完成窗口内。现在窗口内最近一次未完成会继续留在今天，完成之后或窗口过了才推进到下一轮；'
      + '不设完成窗口（当天截止）的事项行为不变',
    '- **修掉「重复任务取消不掉」**：以前取消重复只能关掉开关再保存，而那只是把规则记成暂停 —— '
      + '任务仍是重复事项，抽屉重开还显示「已开启」。现在详情抽屉、列表就地编辑、管理面板都有独立的「取消重复」，'
      + '点下去真的删规则、任务脱钩成普通待办并保留；暂停中的规则开关如实显示「已暂停」，重新打开保存即恢复排期',
    '- 数据库自动迁移到 **v20**（新增 `journal_cells` / `journal_notes` 两张表，任务与工时表都不动），'
      + '导出 `schemaVersion` 升到 17；日记**无论插件开没开都会进备份**，关一次插件再备份也不会静默丢',
    '',
    '### v2.9.0 更新',
    '- **语音建任务**（`Ctrl+Alt+R`）：按一下开始录音、再按一下停止，转写后交给 AI 拆成待办草稿，'
      + '摆在与截图建任务同一张确认卡上 —— 标题可改、优先级可选，点「创建」才落库。'
      + '录音只在内存里过一遍，转写完立刻从临时目录删掉，不进附件、不进会议记录、不进备份包；'
      + '转写原文以纯文本写进任务描述，事后能核对当时说了什么，但没有任何音频留下',
    '- **勾选完成有反馈了**：勾上时勾选框弹一下、散出一小簇粒子、整行淡扫一层绿，'
      + '等这半秒播完，行才从列表里移走或重新排序 —— 不再是「点了一下没动静，行却跳走了」。'
      + '效果期内重复点同一行会被吞掉（不会勾上又弹回），连勾几条合并成一次刷新；'
      + '系统开了「减少动效」就不播粒子，完成态与刷新照走',
    '- **日历页不用顶部工具栏了**：那一排搜索 / 新建 / 导入备份在日历里整排收起，宽度全给网格；'
      + '新增与编辑收进右栏当日面板 —— 点「＋ 新增任务」或任务行尾的 `✎`，就地长出一条编辑行'
      + '（标题 / 优先级 / 分组 / 日期），日期预填选中那天，存完即回落，不弹窗也不用双击格子',
    '- **录制拆成两个入口**：顶栏与会议纪要里都是「🎙 录音」「🖥 录屏」。'
      + '录音一键直启（麦克风 + 系统声，不弹任何配置窗），录屏才需要先挑屏幕 / 窗口；'
      + '分段时长从弹窗搬到会议纪要工具栏，两条入口共用同一份设置，改完即存',
    '- **知识库问答换了个壳**：与 AI 检索共用同一套两栏骨架 —— 左边提问历史、右边答案与引用来源，'
      + '窗口可拖角缩放且记住尺寸；遮罩误点与 Esc 不再关窗（结果一关就没），只有 ✕ 与「关闭」能退出',
    '- **修掉笔记全屏退不出来**：全屏时面板顶边压进了自绘标题栏那 50px，'
      + '「退出全屏」被最大化键截胡、`✕` 被关窗键截胡。现在全屏也让出那一条，'
      + '笔记自己的按钮回到可点区域，窗口三键照常可用',
    '- **修掉故宫脊兽永久消失**：开一次任务详情再关掉，底部那道檐口就再也回不来 —— '
      + '判据写成了「抽屉节点存在」而不是「抽屉真的打开」，而抽屉是常驻节点、关闭只是 hidden。'
      + '现在只在真正打开时让位，关掉立即复原，反复开合都正常',
    '- **设置中心多了一条页脚**：左边「所有更改即时生效，无需保存」，右边「关闭」，'
      + '与顶部头栏同高、同左右内边距；不用再滚到最底找按钮',
    '- **切视图不再被完成效果拖慢**：点侧栏立刻切走，粒子留在原地播完自己收尾',
    '',
    '### v2.8.0 更新',
    '- **工时记薪：给时间标个价**（工时插件内，开启后才有）：工时视图工具栏多了「工时 / 价值」分段，'
      + '在价值页填上自己的时薪，每条记录按实际时长折算成金额 —— 不是给谁看工资条，是回答「这个月的时间花在哪值不值」',
    '- **改时薪不会篡改历史**：费率按**生效日**存成时间序列，每条记录取自己那天生效的那一档；'
      + '今天把时薪从 ¥80 调到 ¥100，上个月的单子还是按 ¥80 算',
    '- **金额跟手工核账对得上**：全程整数分、逐条四舍五入后再相加（不是先汇总再取整），'
      + '所以明细加起来一定等于合计，不会差一分；时薪还没设时显示引导而不是 `¥0.00`',
    '- **可以单条排除**：某段记录是非计薪的（学习、内部事务），在明细里关掉它的计薪开关，'
      + '金额不计但时长仍算，卡上会写明「已排除 X 小时」',
    '- **任务行内直接看工时**：开着工时插件时，列表行尾就带这个任务的工时摘要（自身 / 含子任务 + 记录条数），'
      + '点开是逐条明细，行内「＋ 补录」不用切到工时视图；任务详情抽屉里也有同一块',
    '- **桌面浮窗显示父子结构**：子任务缩进在父任务下方（`▸ / ▾` 展开收起），父行带「完成数 / 总数」；'
      + '父任务被过滤掉（已完成的）才在子任务上补一行 `↳ 父任务名`',
    '- **浮窗里点行不再误完成**：只有点前面的复选框才算完成，点行主体只是选中；'
      + '浮窗行内也带上 **▶ / ☯ / ■**，☯ 会把禅模式拉到主窗口全屏',
    '- **拖拽改父子关系**（主窗口）：拖**标题** = 把这个任务挂到另一个任务下面，拖到列表空白处 = 脱离成顶级，'
      + '拖到自己的后代上会亮红虚线并拒绝（防成环）；拖行首的 **⠿** 手柄仍是排序，两种手势并存',
    '- **展开箭头加大到 26×26**：有子任务的行更好点，收起 / 展开不再需要瞄准',
    '- **修复代码块里粘贴不进去**：在本笔记或任务描述的代码块里按 `Ctrl+V`，内容会整段掉到代码块外面变成普通段落 —— '
      + '现在直接落在光标处、换行与缩进都保留，也不会再弹「检测到 Markdown 语法」；'
      + '粘贴自带 ``` 围栏的片段时，代码块的围栏会自动加长，不会自我截断',
    '- **修复 CSV 导出字段连成一坨**：导出的每一列现在由逗号正确分隔，Excel 打开即分列；'
      + '报工 CSV 另新增计薪 / 时薪 / 金额三列，金额与价值页同一口径',
    '- 工时页顶部那排（搜索 / AI 检索 / 笔记 / 导入备份 / 新建）自动收起，报工表占满整屏，切回任务视图即恢复',
    '',
    '### v2.7.0 更新',
    '- **故宫主题（第七套风格，现在是出厂默认）**：宫墙红做强调色、琉璃黄做高亮、宣纸压成暖底。'
      + '选它时窗口底部陈列一道 80px 的檐口 —— 骑凤仙人领头，后面龙、凤、狮子、天马、海马、狻猊、押鱼、獬豸、斗牛、行什十只走兽，'
      + '悬停浮起来历与寓意，点击可钉住；切到别的风格自动收起。它占文档流 80px，所以切到故宫时内容区会相应矮一点，这是设计的一部分',
    '- **截图建任务**：`Ctrl+Alt+V` 读剪贴板里的图片（先用 `Win+Shift+S` 截好），`Ctrl+Alt+S` 直接拖框选一块屏幕。'
      + '图片交给视觉模型拆成几条草稿，摆在确认卡上 —— 标题可改、优先级可选、不要的取消勾选，'
      + '点「创建」才真的落库（进今天、进上次用过的清单）；**没确认之前库里什么都没有**',
    '- **点「创建」就当场看到**：卡片关闭后宿主补刷一次列表，新建的几条立刻出现在「今天」；'
      + '要是当时正停在「已完成 / 归档 / 日历」这类装不下它们的页面，会被带到「今天」，'
      + '而只是原地能看见的情况不会把你从正在看的页面踢走',
    '- **截图不会丢**：建完的任务会把这张图存成附件并插在描述正文里，事后翻记录看得见当时截的是什么；'
      + '图过期了（中间又截了一张）会直说「这张截图过期了，请重新截一次」，不会建出一堆空任务',
    '- **视觉模型可以单独配**：设置 → AI 与语音 → 视觉模型，能跟对话模型用不同服务商（对话用 DeepSeek、识图用别家）；'
      + '不单独配也能跑，回落到对话模型，卡片顶上写明「未确认是否支持图片」，识别失败会提示换一个',
    '- 全局快捷键默认 15 个（新增 `Ctrl+Alt+V` / `Ctrl+Alt+S`）；启动日志里被占用的键会点名到具体是哪几个，不再只说数量',
    '- README 全部截图按故宫深色重拍（含工时三张），并新增「截图建任务」整节',
    '',
    '### v2.6.0 更新',
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
    '- 覆盖安装 / 解压覆盖即可，**数据库自动迁移到 v20**：新增 `journal_cells` / `journal_notes` 两张日记表，'
      + '任务、分组、标签、笔记与工时表都不动；迁移在一个事务里跑，失败会整体回滚，不会留下半个库；',
    '- 四象日记与工位搭子**都是默认关闭的插件**：去 设置 → 功能插件 打开即用；关掉只是卸载界面与入口，'
      + '日记内容、牛马币与配置都留在库里，再打开就回来；',
    '- 日记是**纯文本**，不建全文索引、不进 AI 检索与报告，也不做打卡与成长系统 —— 只记「已记录 N 天」；'
      + '正文随全量备份走，无论插件当时是开是关；',
    '- 导出文件的 `schemaVersion` 从 16 升到 17（多了日记两表）：旧版本导入这份新文件会被拒，'
      + '新版本读旧文件没问题，升级前做的备份照常能导回来；',
    '- 标题栏「有新版本」角标只是个提醒：点它走的是原来那个检查更新对话框（原生窗口给下载 / 发布页两个按钮），'
      + '**不做自动下载、不会偷偷重启**；查到已是最新会自动熄灭；',
    '- 新装默认仍是故宫风格；已选过的外观不会被覆盖，檐口也只出现在故宫风格下；',
    '- 上一版的语音建任务、截图建任务仍要先配好模型（设置 → AI 与语音）；工时记薪插件依旧默认关闭，'
      + '时薪是可选项，历史记录与费率都保留；',
    '- 番茄钟已下线：`focus_sessions` 里的历史记录不删不写，只是不再有入口；',
    '- 若钉过桌面浮窗 / 便签，位置与清单保留；浮窗外观会跟当前主题，可在「设置 → 外观」里调不透明度。',
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
    const hit = existing.find((a) => a.name === name && a.state === 'uploaded');
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
        // 注意必须要求 state === 'uploaded'：中断的上传会留下 state='starter' 的占位记录，
        // 只看名字+大小会误判成「已上传成功」，结果附件公开列表里始终不出现（v2.8.0 的便携版就是这样丢的）
        const again = await listAssets(releaseId);
        const landed = again.find((a) => a.name === name && a.size === size && a.state === 'uploaded');
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
