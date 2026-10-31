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
/** 对外品牌名：以打包配置里的 productName 为唯一来源（package.json 的 name 是内部标识，不面向用户） */
const BRAND = (pkg.build && pkg.build.productName) || pkg.name;
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
    `## ${BRAND} ${tag}`,
    '',
    '### 下载',
    `- **${BRAND}-*.7z**：免安装版，解压后运行其中的 \`${BRAND}.exe\`（需 7-Zip / WinRAR / Win11 自带解压）。`,
    '  数据保存在 exe 同级的 `data/` 目录，整个文件夹拷走即可换机。',
    '',
    '### 安装说明',
    '1. 下载 .7z 文件并解压到任意目录；',
    `2. 双击 \`${BRAND}.exe\` 运行；首次运行如被 SmartScreen 拦截，点「更多信息 → 仍要运行」（未购买代码签名证书）。`, '',
    '### 本版功能',
    '- 任务管理（分组/标签/子任务/优先级/计划日期/提醒/归档/统计下钻）',
    '- AI 报告与 AI 检索（联想检索 + 自定义提示词，历史记录本地持久化）',
    '- 会议录制 → 语音转写 → AI 纪要（支持国内 ASR 预设）',
    '',
    '### v1.7.0 更新',
    '- 实用工具新增「代码格式化」：JSON / JavaScript / TypeScript / HTML / CSS / SCSS / Less / Markdown / YAML / XML / SQL（9 种方言）/ Java，可调缩进、行宽、Tab，语法错误明确提示',
    '- 实用工具新增「文本对比」：并排 / 内联双视图，行级增删 + 词级高亮，可忽略空白 / 空行 / 大小写，支持一键「格式化双方」再对比',
    '- 工具以非模态浮窗打开：不挡主界面、不抢焦点，可最小化 / 最大化 / 拖拽缩放，位置与尺寸自动记忆，多个工具窗可同时开',
    '- 菜单调整：「实时薪资」移到实用工具子菜单最下',
    '',
    '### v1.8.5 更新',
    '- 任务视图顶栏搜索框右侧新增「📝 笔记」入口：点开以弹窗形态呈现完整笔记界面（目录 / 标签 → 笔记列表 → 正文），不用离开当前任务列表就能查看和编辑笔记，关掉仍停在原来的视图',
    '- 弹窗复用侧栏笔记页同一份界面与逻辑：预览 / 分栏 / 编辑三态、大纲、全屏、查找替换、附件、关联任务、回收站、归档、自动保存，交互与侧栏完全一致',
    '- 弹窗可拖拽缩放并记住尺寸，右上角一键最大化；Esc 先关面板内的浮层（如查找条、取色板），再按一次才关窗',
    '- 导入按钮与笔记入口并存不拥挤：入口做成搜索框右缘的图标按钮，窄窗口下顶栏仍保持单行，原有按钮位置不变',
    '- 修复矮窗口（高度 < 660px）下笔记正文被压成 0 高、底部操作条被裁掉一半；现在正文保底高度并可整体滚动',
    '',
    '### v1.8.4 更新',
    '- 笔记预览不再「双击进编辑」：双击是选中词 / 段落的常用手势，误触率高；是否编辑统一由标题栏「预览 / 分栏 / 编辑」三态按钮显式控制',
    '- 新建任务的分组下拉从折叠的「更多选项」提到主行（标题与计划时间之间）：归属字段不再默认隐藏，建任务时一眼可选；窄窗口下自动收窄不挤压标题',
    '- 修复 Mermaid 放大预览被误关：拖动平移松手时会补一次点击事件，导致看清某块区域的同时就关掉了预览；现在关闭只保留右上角 ✕ 与 Esc，关闭按钮也加了视觉权重',
    '',
    '### v1.8.3 更新',
    '- 笔记详情支持全屏预览 / 编辑：面板铺满窗口，预览 / 分栏 / 编辑三种模式都能用，目录、标签、大纲、保存状态与底部操作条照常保留；预览态收 1080px 阅读宽度居中，编辑态占满给代码留够宽度。Esc 退出（查找条 / 取色板开着时先让给它们），开关状态跨笔记沿用',
    '- Mermaid 图表支持放大预览：图上悬停出放大按钮，双击图也能打开；全屏画布支持滚轮以光标为中心缩放、拖动平移、适应窗口 / 1:1 / 关闭。矢量放大不糊，底色跟随深浅主题',
    '- 笔记导出入口前移：「📤 导出」挪到笔记工具栏「📥 导入」旁边，面板按当前目录 / 标签筛选预置，顶栏「☁ 同步」里的完整版保持不变',
    '',
    '### v1.8.2 更新',
    '- 支持导入 Markdown 笔记：单个 / 多个 .md 文件，或整个文件夹递归扫描（按子目录结构自动建笔记目录）；标题取自首个一级标题或文件名，front matter 的 `title` / `tags` 会被识别，正文里相对路径的本地图片一并搬进附件目录并改写成应用内引用。菜单 File → 导入 Markdown 笔记…（Ctrl+Shift+I）',
    '- 笔记预览改用 markdown-it：表格、嵌套列表、引用、转义、裸链接等语义交给成熟库，渲染结果更接近标准 Markdown',
    '- 代码块支持语法高亮：highlight.js 按语言着色（30+ 语言，不认识的自动识别），带语言标签与一键复制',
    '- 支持 ```mermaid 图表：流程图 / 时序图 / 类图 / 甘特图 / 饼图，深浅主题自动配色；其它图表类型会就地提示「不支持」并保留源码（顺带把 mermaid 库从 5.0MB 裁到 3.6MB）',
    '- 修复代码块缩进显示过大：Tab 在预览里按浏览器默认的 8 格展开，而编辑器里是 2 格，同一段代码看着像「缩进多了一大截」；现在两处统一为 2 格，且 Tab 键直接插入空格（不再往正文里塞制表符）',
    '',
    '### v1.8.1 更新',
    '- 笔记编辑新增「大纲」目录（仿语雀）：按标题自动生成，点击跳转；显隐开关重新设计为与「预览 / 分栏 / 编辑」一致的主题色胶囊按钮',
    '- 修复任务标签无法保存：在任务详情里填写 / 修改标签后不会写库（自动保存误判「无变化」），现已正常保存并回显',
    '- 笔记预览换行修复：单个换行按 <br> 渲染，与编辑器所见一致',
    '- 知识库问答支持限定笔记目录（分类）范围，问答历史记录并回显当时的检索范围',
    '- 笔记标签支持重命名 / 改色 / 删除（侧栏标签悬停操作），删除时自动清理所有引用',
    '- 知识库问答弹窗点击遮罩不再误关闭，统一由 ✕ / 按钮 / Esc 关闭',
    '',
    '### v1.8.0 更新',
    '- 新增实用工具「JSON 查看器」（Ctrl+Shift+J）：树形展示 + 类型着色 + 折叠展开，支持键名 / 值搜索（过滤 + 逐个跳转）、JSONPath 路径查询（$.a.b[0] / $..name），并可一键格式化 / 压缩',
    '- 代码格式化与文本对比支持语法高亮：基于 highlight.js，随应用深浅主题配色，两个工具都能一键关掉',
    '- 新增「对外同步」（顶栏 ☁ 同步）：任务导出为 CSV（可直接导入腾讯文档）/ Markdown 表格，笔记导出为单文件 Markdown 或按目录层级打包的 .md 压缩包（含图片，可批量上传到 ima 知识库）',
    '- 统计页优化：「分组任务量」按分组树顺序排列（父分组整块排完再排它的子分组）；「优先级分布（进行中）」按紧急 / 高 / 中 / 低区分颜色',
    '',
    '### v1.6.0 更新',
    '- 品牌重塑：应用更名 Knodo（Knowledge + Todo），全新 Logo（K 竖条 × O 知识圆环）与应用图标',
    '- 新增实用工具「实时薪资」：按月薪与上下班时间实时累计今日 / 本月已获得薪资（不展示总月薪）',
    '- 侧栏导航调整：笔记入口移至归档下方，精简顶部菜单',
    '- 笔记正文查找替换（Ctrl+F / Ctrl+H），支持全部替换与大小写开关',
    '- 修复：其他视图勾选完成的任务也计入「今天」列表；修复顶部搜索框失联',
    '',    '### v1.5.0 更新',
    '- 笔记模块：新增 Markdown 笔记（目录 / 标签组织、搜索、置顶、归档、回收站），并作为内置知识库供 AI 检索',
    '- 笔记交互改为「列表 + 弹窗编辑」：点任意笔记弹出编辑器，列表的筛选与滚动位置不再被打断',
    '- 笔记编辑弹窗重做：默认约 88% 窗口大小（不再整屏覆盖），右下角可拖拽缩放并记住尺寸，抬头支持一键最大化；分栏 / 预览都在弹窗内完成，正文与预览各自滚动',
    '- 笔记支持图片：截图粘贴 / 拖拽 / 选文件统一落盘到 attachments/note-<id>/，正文只留本地链接（不塞 base64）',
    '- 知识库问答升级为智能检索：AI 查询改写 → 多路召回 → RRF 融合 → AI 语义重排；未配 AI 时自动降级为纯召回',
    '- 任务 ↔ 笔记多对多：任务详情可关联 / 取消关联 / 跳转查看，列表行显示笔记数徽标',
    '- 修复：清空标题后写的正文无法保存（新建笔记表现为「点了没反应」）；新建笔记自动退出搜索态，避免新笔记被关键词过滤隐藏',
    '- 修复主题切换：运行时切换主题后窗口标题栏 / 原生控件立即跟随，不再需要重启才变',
    '- 修复弹窗尺寸样式：知识库问答 / 关联笔记 / 删除确认等弹窗恢复设计宽度（此前被压成 380px）',
    '- 笔记界面细节：列表工具栏窄窗口可换行不再裁切、空状态给出引导、编辑器字号行距与预览对齐、Markdown 标题不再过度放大',
    '',
    '### v1.4.0 更新',
    '- 笔记模块首个版本（数据模型 v9/v10、知识库沉淀、任务关联）',
    '',
    '### v1.3.0 更新',
    '- AI 检索升级为「联想检索」：精确匹配无结果时不再直接返回空，改为按语义相关度给出候选',
    '- 匹配依据覆盖标题 / 描述 / 标签 / 分组 / 状态 / 时间，支持同义词与缩写联想（bug→缺陷、ui→界面）',
    '  与近似拼写容错（如 work ≈ wrok）',
    '- 结果区分三态：高置信度唯一匹配 / 多个候选待确认（Top 5）/ 确实无关联；',
    '  无关联时明确提示，并列出本次已尝试的联想方向',
    '- 每条候选展示命中依据（由哪个关键词推导而来）与相关度排序；精确命中时原样优先返回',
    '- 配置了 AI Key 时，模型只在候选池内重排并补充理由，绝不新增任务',
    '- 菜单整理：开机自启动并入 File 菜单，「存储位置…」去掉省略号；彻底移除全局快捷键功能',
    '- 修复：子任务展开箭头点击冒泡到父行；全量任务查询（无筛选条件）时 SQL 语法错误',
    '',
    '### v1.2.0 更新',
    '- AI 润色升级为 AI 改写：内置 6 种改写取向预设（精简压缩 / 扩写细化 / 结构化清单 / 正式汇报 / 待办拆解等）',
    '- 改写支持自定义提示词，可存为个人预设并随时管理；上次使用的提示词自动记住',
    '- 描述编辑器新增 Markdown 快捷键（Ctrl+B/I/U、Ctrl+1/2/3 标题、Ctrl+Shift+7/8 列表、Ctrl+\\ 清除样式）与「?」帮助弹窗',
    '- 描述编辑器设定最大高度（420px，内容多时编辑器内滚动）并关闭拼写检查红色波浪线',
    '- 「数据存放位置」更名为「存储位置」并移入 File 菜单',
    '- 新增附件管理、统计口径切换、侧边栏拖拽调宽与数据目录可配置',
    '',
    '### v1.1.0 更新',
    '- 修复多任务详情编辑数据串改：切换任务后自动保存只写入当前任务',
    '- 任务新增创建时间（老数据自动回填），列表与详情展示',
    '- AI 统计完成趋势支持近 7 天 / 一个月 / 半年 / 一年切换',
    '- 修复 AI 润色点击无响应：补齐加载态、失败原因与重试、防连点',
    '- 顶部菜单栏新增「AI 设置」入口；统计 / AI 报告 / AI 检索 / 会议纪要页隐藏无关的工具区',
    '- 分组支持自定义颜色：预设色 + 系统取色器自由取色，全站视觉标识同步',
    '- 新增第 14~16 轮冒烟回归（多任务隔离 / 趋势档位 / 润色反馈 / 取色器），数据库测试 118 项',
  ].join('\n');

  let releaseId = null;
  const findRes = await fetch(`${API}/repos/${owner}/${repo}/releases/tags/${tag}?access_token=${encodeURIComponent(token)}`);
  if (findRes.ok) {
    // 注意：Gitee 对「tag 存在但还没有 Release」返回 200 + null，不能当作已存在
    const rel = await findRes.json();
    if (rel && rel.id) {
      releaseId = rel.id;
      console.log(`② Release ${tag} 已存在（id=${releaseId}），直接复用`);
    }
  }
  if (releaseId == null) {
    const createRes = await fetch(`${API}/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        tag_name: tag,
        name: `${BRAND} ${tag}`,
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
    // 大附件上传偶发网络中断，重试 3 次；重跑本脚本会跳过已上传成功的同名附件
    let ok = false;
    let lastErr = '';
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      if (attempt > 1) {
        // 超时 ≠ 失败：服务端可能已经收下了文件，重试前先复查，避免传重
        const check = await fetch(`${API}/repos/${owner}/${repo}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(token)}`);
        if (check.ok && (await check.json()).some((a) => a.name === name)) {
          ok = true;
          console.log('复查发现已上传成功，跳过重试');
          break;
        }
        console.log(`  第 ${attempt} 次重试…`);
        await new Promise((r) => setTimeout(r, 3000));
      }
      try {
        const form = new FormData();
        form.append('access_token', token);
        form.append('file', new Blob([fs.readFileSync(filePath)]), name);
        const upRes = await fetch(`${API}/repos/${owner}/${repo}/releases/${releaseId}/attach_files`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(15 * 60 * 1000), // 90MB+ 上传可能较慢，给足 15 分钟
        });
        if (upRes.ok) {
          ok = true;
          console.log('完成');
        } else {
          lastErr = `${upRes.status} ${await upRes.text()}`;
        }
      } catch (e) {
        lastErr = e.message;
      }
    }
    if (!ok) console.log(`失败：${lastErr}（可重新运行本脚本续传）`);
  }
  console.log(`\n✅ 发布完成：https://gitee.com/${owner}/${repo}/releases/tag/${tag}`);
}

main().catch((e) => {
  console.error('发布失败：', e.message);
  process.exit(1);
});
