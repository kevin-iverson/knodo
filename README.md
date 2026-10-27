<div align="center">

<img src="assets/knodo.svg" width="120" alt="Knodo"/>

# Knodo

**Knowledge + Todo** — 把「待办清单」和「知识沉淀」放进同一个应用。

基于 **Electron + better-sqlite3** 的 Windows 桌面应用，界面简洁、操作高效，**数据全部本地存储**（SQLite，不联网、不上传）。

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![Runtime](https://img.shields.io/badge/Electron-32-47848F)
![License](https://img.shields.io/badge/license-private-lightgrey)

</div>

---

> **品牌与内部标识的区别（改名前必读）**
> 对外名称统一为 **Knodo**，取自打包配置 `build.productName`；`package.json` 的 `name`（`todo-desktop`）与 `build.appId` 是**内部标识**，刻意保持不变 ——
> Electron 用 `name` 决定用户数据目录（`%APPDATA%\todo-desktop`），改了会让老用户升级后看到空数据；
> `appId` 则决定安装目录与卸载项。改品牌名时只动 `productName` / `shortcutName` / 界面文案 / 图标即可。

## 功能一览

**基础功能**
- 任务分组管理：**支持多级子分组**（父组 ⇄ 子组无限层），侧边栏树形展示，可折叠/展开；计数与筛选都按「父包含子」计算（点父分组 = 该分支下所有任务）；拖拽/表单里可选择归属到任意层级的分组；删除父分组会连带删除其子分组，任务自动上移一级，不丢数据
- 任务创建 / 编辑 / 删除 / 完成
- 优先级（低 / 中 / 高 / 紧急）
- 计划开始日期 / 计划完成日期（仅年月日）：合并为**一个日期范围控件**，点一次只弹出一个日历面板，日历内两次点选后自动关闭并回填（起点 → 开始日期，终点 → 完成日期）；支持今天 / 明天 / 本周末快捷选项并显示跨度天数，默认留空、非必填；面板挂到页面顶层并做视口避让，窄容器（子任务行、详情抽屉）内也不会被裁剪
  - 控件基于第三方 **flatpickr**（range 模式），已随项目落地到 `renderer/vendor/flatpickr/`（含中文语言包），不依赖外网运行时
- 完成任务自动记录实际完成时间（界面可见、可编辑）
- 提醒通知：快捷提醒（完成日期当天 09:00 / 前 1 天 18:00）+ 自定义时间
- 标签与关键词搜索筛选
- 按计划开始/完成日期、实际完成时间的时间筛选：**复用「添加任务」同一套 flatpickr 范围控件**（两次点选成范围、快捷选项、中文日历、面板定位完全一致），顶栏按钮显示当前生效的范围组数并高亮，可一键清除
- 数据导入 / 导出（JSON 文件备份与恢复）
- 排序方式可切换（智能 / 优先级 / 截止日期 / **手动**），手动模式下按住任务左侧 ⠿ 手柄即可拖拽排序
- 已完成任务归档与统计
- **「今天」列表就地保留已完成任务**：勾选完成后不消失，直接打勾 / 置灰 / 删除线，并显示「今日已完成 N 个」提示条；**切换标签页再回来、甚至重启应用，今天做过的任务依然在列表里**（标记连同自然日存进 settings，跨天自动作废）；可点「隐藏已完成」立即移除（不改变视图本身的查询口径）
- **点击任务标题即可行内改名**：不用再打开详情页，点一下标题就地变输入框，失焦或回车保存、Esc 放弃；只替换这一行节点，不整表重绘
- 系统托盘常驻，可一键呼出 / 快速添加
- 深色模式
- 窗口关闭后最小化到托盘

**进阶功能**
- 任务标题 16px、正文 12px，层级分明；**子任务进度（☑ 已完/总数）紧邻标题右侧**；点击标题行内改名，输入框宽度随输入实时自适应（不换行、不遮挡右侧元素）
- **描述里的图片双击可放大预览**：保持原始宽高比，再次双击图片 / 点击遮罩 / 按 Esc 关闭
- **侧边栏可拖拽调宽**（180 ~ 420px，双击把手恢复默认）：拖动时禁用文本选中，宽度写入 `ui.sidebarWidth` 持久化，主区自动跟随不错位
- **统计支持切换口径**：「仅主任务」/「含子任务」，卡片、分组、优先级、完成趋势与下钻明细实时按新口径刷新
- 任务详情页：点击任务查看/编辑，描述支持**所见即所得编辑**（Markdown 快捷键，图片直接插入光标处）
- 详情侧边栏可**拖拽左侧边缘调整宽度**（360 ~ 860px，双击手柄恢复默认），宽度自动记忆、下次打开复用；拖拽过程无闪烁：拖拽期间禁止重建面板（重绘推迟到松手）、内容区预留滚动条槽位（`scrollbar-gutter: stable`）、`contain: layout` 隔离重排、重绘不再重播入场动画、松手时按指针位置同步收尾（不依赖可能被节流的 rAF 最后一帧）
- **编辑即时持久化**：列表行内编辑与详情抽屉中修改任意字段，停止输入约 0.7s 后自动写入，无需点"保存"；失败时保留输入并可点击状态重试，任务已被删除等冲突会提示并回滚
- 分组 / 标签通过弹窗新增，支持重名校验与失败原因提示（如数据库只读），新增后列表即时可见并高亮；**分组支持自定义颜色**：预设色 + 系统取色器自由取色（也可直接填 `#RRGGBB`），颜色持久化并统一用于侧栏色点、列表分组头、任务行分组标签与统计图表
- 子任务与主任务同级：具备**优先级、计划开始 / 完成日期**，可就地编辑（自动保存），参与列表排序与筛选；列表默认收缩、可展开（筛选视图下也能正常展开），显示所属父任务；详情页树形层级；所有子任务完成时父任务自动完成；支持拖拽排序（行首 ⠿ 手柄）；添加/勾选时仅局部刷新，不闪烁
- AI 检索：输入关键词检索所有任务并生成总结，结果可点击跳转详情；**每次检索自动入库**，页面下方「检索历史」可回看（关键词回填 + 总结 + 命中任务）或单条删除
- **检索支持联想查询**：关键词没精确命中时不会直接返回"未找到"，而是走多层联想召回（详见「AI 检索的联想逻辑」一节）
- 集成 AI，基于本地任务与完成记录自动生成**日报 / 周报 / 月报**
- **AI 配置集中在顶部菜单栏「AI 设置」**（接口预设 / Base URL / 模型 / API Key / 测试连接 / 清除 Key），AI 报告页只负责生成与导出
- 报告结果按 **Word 文档版式**呈现（标题层级 / 段落 / 列表 / 表格），**默认始终可编辑**，停止输入约 0.7s 自动保存（状态条显示「未保存 → 已保存 HH:MM」），**不再有「编辑 / 保存修改」按钮**；导出 **Word（.docx）** 与 **Markdown**
- **报告持久化 + 历史记录**：每份报告生成时即写入 `reports` 表，结果框右上角「🕘 历史记录」按钮弹出列表（时间 / 类型 / 范围 / 分组 / 是否含自定义要求），可查看、删除；生成新报告只会新增记录，不会覆盖或清空旧记录
- 分组筛选改用第三方 **Tom Select**（可搜索、已选 chips 带 ×、一键清除、按层级缩进），已随项目落地到 `renderer/vendor/tom-select/`；面板挂到 body，不会被可滚动容器裁掉
- **报告支持自定义提示词**：生成前可补充「例如：根据任务的计划完成时间生成下个月的工作计划」，原样追加到给 AI 的 user 消息里（任务数据会带上计划开始 / 完成时间），模型按需追加对应章节；输入内容本地记忆，无 Key 的本地模板报告会明确提示"未应用该要求"
- **统计可下钻**：统计页的数字卡片（总任务 / 进行中 / 已完成 / 已逾期 / 已归档）点击即列出对应任务明细，支持按列排序、点行跳详情，关闭回到统计页
- **标签筛选有明确选中态**：底色 + 左侧色条 + 主色加粗文字三重区分，支持键盘（Tab 聚焦 / Enter 切换）、顶栏显示当前筛选并可一键清除，切换视图与重启后均保留
- API Key 本地加密保存（safeStorage / Windows DPAPI），无 Key 时降级为本地模板报告并提示

**会议纪要（录制 → 转写 → AI 纪要 → 待办入库）**
- **录制**：工具栏「⏺ 录制」一键采集。默认**仅音频**（麦克风 + 系统声混音）；Windows 下系统声走 WASAPI 回环，会议里对方的声音直接进来，无需虚拟声卡。也可选择「画面 + 音频」，从屏幕 / 窗口缩略图里挑要录的目标
- **自动切片**：按 5 / 10 / 15 / 30 分钟切成独立的完整 WebM 文件，绕开云端常见的单文件 25MB 限制；录制中可暂停，底部浮动条实时显示时长与已存片数
- **语音转写**：对接 OpenAI 兼容的 `/audio/transcriptions`（Whisper 类），分片顺序上传，用上一片结尾做上下文提示减少断句错乱；也可直接**导入已有录音 / 录像文件**
- **AI 纪要**：输出「会议主题 / 关键议题与结论 / 决议事项 / 待办事项 / 风险与遗留问题」结构化 Markdown；长会议走分段提炼再合并，避免上下文溢出
- **待办入库**：从纪要里提取行动项（负责人 / 截止日期 / 优先级），**勾选后批量写入任务列表**，可选各自独立或挂在同一个父任务下；纪要可导出 Word / Markdown
- 配置项独立：语音接口与对话模型分开填（DeepSeek 等纯文本服务不提供语音接口），详见《AI 接口配置》

**笔记（Markdown 编辑 → 知识库沉淀 → 任务关联）**
- **列表 + 弹窗编辑**：列表页负责浏览 / 组织 / 搜索（两栏：目录标签 + 笔记列表），**点任意笔记即弹出编辑窗口**，关掉回到原处，列表的筛选与滚动位置不会丢
- **Markdown 编辑器**：EasyMDE 工具栏（标题 / 列表 / 代码块 / 链接 / 图片 / 表格）+ **markdown-it 实时预览**，支持「编辑 / 分栏 / 预览」三种模式；标题、目录、标签、正文改完约 0.7s 自动落库（状态条：未保存 / 保存中 / 已保存），Esc / 点遮罩关闭前也会补存一次
- **代码块着色 + Mermaid 图表**：```语言名``` 的代码块由 highlight.js 按语言着色（内置 30+ 语言，不认识的自动识别），带语言标签与一键复制（Tab 缩进按 2 空格显示，与编辑器一致）；```mermaid``` 块渲染成**流程图 / 时序图 / 类图 / 甘特图 / 饼图**五种矢量图（mermaid 库按需懒加载，构建期只打进来这五种，其余图表类型会提示不支持），语法错误时就地显示源码
- **导入 Markdown**：工具栏「📥 导入」（或菜单栏 File → 导入 Markdown 笔记…）可选单个 / 多个 .md 文件，或整个文件夹递归扫描；标题可取自首个一级标题（没有则用文件名），front matter 里的 `title` / `tags` 会被识别，正文里相对路径的本地图片会一并搬进附件目录并改写成 `todo-media:///` 引用
- **图片直接粘贴**：截图粘贴 / 拖拽 / 工具栏选文件都能插入图片，落盘到 `attachments/note-<id>/`（复用任务附件同一套规则），正文只留 `todo-media://` 链接（不塞 base64）；编辑器下方有图片条，可打开 / 复制引用 / 删除
- **目录与标签组织**：目录支持无限层级（同级不允许重名，与分组同一套规则），标签逗号分隔、不存在的自动创建；支持置顶与**归档**（归档后折叠出主列表，但仍可被检索与引用）
- **搜索与回收站**：全文检索走 FTS5（中文 trigram，无需外部分词器），关键词不足 3 字自动回退模糊匹配；删除分「移入回收站（可恢复）」与「彻底删除」，回收站页可逐篇恢复 / 彻底删除 / 清空
- **知识库沉淀（智能检索）**：笔记保存即自动切块入索引（按 Markdown 标题切分，块内带标题路径）。「🧠 知识库问答」的检索链路为：**AI 查询改写 → 多路召回（分块 FTS + 笔记级 + 模糊）→ RRF 融合 → AI 语义重排 → 带 `[n]` 出处作答**，可点击跳回原笔记；未配置 AI 时整条链路自动降级为纯关键词召回，功能不中断
- **任务 ↔ 笔记（多对多）**：任务详情可一次关联多篇笔记（搜索 + 多选 + 顺手新建），列表项支持跳转查看与取消关联；任务列表行显示 `📝 N` 徽标；笔记侧也能看到被哪些任务引用
- 详细设计见《[笔记模块设计与AI知识库接入](docs/笔记模块设计与AI知识库接入.md)》

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 生成图标（仓库已内置，可跳过）
npm run gen-icon

# 3. 启动
npm start
```

> 需要 Node.js ≥ 18、Windows 10/11。首次 `npm install` 会下载 Electron 二进制。
>
> better-sqlite3 v13 已迁移到 **N-API**，内置各平台预编译二进制，**无需** electron-rebuild，跨 Node / Electron 版本通用；不依赖本机 Visual Studio 构建工具。
>
> 前端第三方库（flatpickr、tom-select、markdown-it、highlight.js、mermaid 等）的构建产物已 vendor 进 `renderer/vendor/`（并在 `package.json` 登记来源版本），运行时不联网、也不读 `node_modules`。升级时把新产物覆盖到对应目录并同步 `package.json` 版本号即可。
> 这些库一律登记在 `devDependencies`（构建期用），`dependencies` 里只留主进程运行时真的要用的 `better-sqlite3` —— 否则 electron-builder 会把整棵 node_modules 打进 app.asar，安装包白胖几十 MB。

## 运行验证

```bash
npm run test:db        # 数据层 + 报告生成 + 语音转写通道冒烟测试（纯 Node，不依赖 Electron、不入网）
npm run smoke          # 端到端冒烟测试（Electron 启动后自动退出，输出 SMOKE_OK）
```

> **冒烟测试使用独立的临时数据目录**（`os.tmpdir()/todo-smoke-profile`，每次启动前清空）：
> 既保证每轮都从干净状态开始（否则上一轮残留的「冒烟分组」会让下一轮撞上重名报错），
> 也避免污染用户真实的任务数据。失败时会打印「未通过项 · 分组：字段=值」，不必逐个核对几十个断言。
> UI 交互一律用轮询等待代替固定 `sleep`，规避冷启动时的偶发超时。

> 若在**其他 Electron 宿主**（如 WorkBuddy 等自带 `ELECTRON_RUN_AS_NODE=1` 的环境）内运行，需先清除该变量，否则 Electron 会以 Node 兼容模式启动、`require('electron')` 失效：
> ```bash
> # Linux/macOS
> env -u ELECTRON_RUN_AS_NODE npm start
> # Windows PowerShell
> $env:ELECTRON_RUN_AS_NODE=$null; npm start
> ```
> 在普通终端 / 命令行中启动不受影响，无需处理。

## 项目目录结构

```
todo-app/
├── package.json            # 依赖与脚本
├── assets/                 # 应用图标 / 托盘图标（由 scripts/gen-icon.js 生成）
├── main/                   # 主进程
│   ├── main.js             # 入口：窗口生命周期、单实例、托盘/提醒装配、应用菜单
│   ├── db.js               # SQLite 数据访问层（建表、迁移、CRUD、统计）
│   ├── ipc.js              # IPC 处理器注册（渲染进程 ↔ 主进程）
│   ├── tray.js             # 系统托盘（显示/隐藏、快速添加、退出）
│   ├── autostart.js        # 开机自启动（系统启动项读写）
│   ├── reminders.js        # 提醒调度器
│   ├── crypto.js           # API Key 本地加密（safeStorage，降级 Base64）
│   ├── ai.js               # AI 接口调用（OpenAI 兼容 /chat/completions）
│   ├── asr.js              # 语音转写（OpenAI 兼容 /audio/transcriptions，multipart 直传）
│   ├── meeting.js          # 会议纪要生成 + 待办结构化提取（含长会分段提炼）
│   ├── knowledge.js        # 知识库：笔记 → 文档 → 分块 → 智能检索（查询改写 / 多路召回 / RRF / AI 重排）→ 问答
│   ├── recording.js        # 录制文件管理（会话目录 / 分片落盘 / 导入外部音频）
│   ├── report.js           # 日报/周报/月报 生成（LLM + 本地降级）
│   ├── md-import.js        # Markdown 笔记导入（front matter / 图片搬运 / 目录结构映射）
│   ├── search-assist.js    # 检索联想引擎（同义词/缩写/近似拼写/状态与时间语义召回 + 打分）
│   └── docx.js             # 零依赖 OOXML Word 导出
├── preload/
│   └── preload.js          # contextBridge 暴露安全 API 面
├── renderer/               # 渲染进程
│   ├── index.html
│   ├── css/styles.css      # 主题（CSS 变量，浅色/深色）
│   └── js/
│       ├── api.js          # IPC 封装 + 时间格式转换
│       ├── store.js        # 前端状态管理
│       ├── ui.js           # 视图渲染与交互（分组/任务/拖拽/统计/主题）
│       ├── reports.js      # AI 报告视图（文档视图 / 源码视图 / 自动保存 / 历史记录 / 导出）
│       ├── report-doc.js   # 报告文档：Markdown ⇄ 类 Word 排版 HTML（含表格，双向可往返）
│       ├── group-tree.js   # 分组树工具（层序展开 / 路径 / 下拉选项 / 子孙 id）
│       ├── recorder.js     # 录制内核（源选择 / 混音 / 分片 / 浮动控制条）
│       ├── meetings.js     # 会议纪要视图（转写 / 生成 / 待办勾选入库 / 导出）
│       ├── notes.js        # 笔记视图（目录 / 列表 / 点笔记弹出 EasyMDE 编辑窗口 / 图片粘贴 / 回收站 / 知识库问答）
│       ├── note-picker.js  # 笔记选择器（任务详情「关联笔记」多选面板）
│       ├── markdown-lib.js # markdown-it 渲染封装（安全选项 + 降级回退）
│       ├── ai-settings.js  # AI 设置弹窗（挂载在顶部工具栏，含语音接口配置）
│       ├── markdown.js     # Markdown 渲染
│       ├── autosave.js     # 编辑即时持久化（防抖 + 冲突回滚）
│       ├── search.js       # AI 检索视图（三态渲染 + 历史记录回看）
│       ├── controls.js     # flatpickr 日期范围控件封装
│       ├── detail.js       # 任务详情抽屉
│       ├── modal.js        # 轻量模态框（表单弹窗 / 自定义内容面板弹窗）
│       ├── app.js          # 入口
│   └── vendor/             # 前端第三方库（离线内置）
│       ├── flatpickr/      # flatpickr 4.6 + 官方 CSS + 中文语言包
│       ├── tom-select/     # Tom Select 2.4（分组多选：搜索 / chips / 清除）+ 官方基础 CSS
│       ├── markdown-it/    # markdown-it 14（Markdown → HTML，表格 / 代码块 / 链接 / 图片）
│       ├── easymde/        # EasyMDE 2（Markdown 编辑器：工具栏 / 快捷键 / 分栏预览）
│       ├── highlight/      # highlight.js 11（代码块着色，随页面同步加载）
│       ├── mermaid/        # mermaid 12（```mermaid → SVG，运行时动态 import）
│       └── tools/          # 实用工具按需加载的打包产物（prettier / diff / json-viewer …）
├── scripts/
    ├── gen-icon.js         # 图标生成
    └── smoke-db.js         # 数据层冒烟测试
```

## SQLite 数据模型

数据库文件：`<用户数据目录>/todo.db`（Windows 通常为 `%APPDATA%/todo-desktop/todo.db`）。时间字段约定：`plan_start` / `plan_end` 存 `YYYY-MM-DD`（仅年月日）；`reminder_at` / `completed_at` / `created_at` / `updated_at` 存 UTC ISO 8601。

### groups — 任务分组
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增主键 |
| name | TEXT | 分组名称 |
| color | TEXT | 分组颜色（hex） |
| sort_order | INTEGER | 排序（同级内递增） |
| parent_id | INTEGER | 上级分组（自引用，NULL = 顶级分组；迁移 v5 起支持多级子分组） |
| created_at / updated_at | TEXT | 时间戳 |

### tasks — 任务
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增主键 |
| group_id | INTEGER FK | 所属分组（`ON DELETE SET NULL`） |
| parent_id | INTEGER | 父任务 id（子任务，可空，删除父任务时级联删除） |
| title | TEXT | 标题 |
| notes | TEXT | 描述（Markdown） |
| attachments | TEXT | 附件元数据（JSON 数组；文件本体在 `<数据目录>/attachments/task-<id>/`，库里只存相对路径） |
| priority | INTEGER | 优先级 0 低 / 1 中 / 2 高 / 3 紧急 |
| plan_start | TEXT | 计划开始日期（YYYY-MM-DD，可空） |
| plan_end | TEXT | 计划完成日期（YYYY-MM-DD，可空） |
| reminder_at | TEXT | 提醒时间（UTC ISO，可空） |
| reminder_fired | INTEGER | 提醒是否已触发 |
| completed | INTEGER | 是否完成 |
| completed_at | TEXT | 实际完成时间（UTC ISO，完成时自动记录，可空） |
| archived | INTEGER | 是否归档 |
| sort_order | INTEGER | 拖拽排序 |
| created_at / updated_at | TEXT | 时间戳 |

### tags — 标签
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增主键 |
| name | TEXT UNIQUE | 标签名 |
| color | TEXT | 颜色 |

### task_tags — 任务-标签多对多
| 字段 | 类型 | 说明 |
|---|---|---|
| task_id | INTEGER FK | 任务（`ON DELETE CASCADE`） |
| tag_id | INTEGER FK | 标签（`ON DELETE CASCADE`） |

### settings — 键值设置
| 字段 | 类型 | 说明 |
|---|---|---|
| key | TEXT PK | 键（`ai.baseUrl` / `ai.model` / `ai.apiKey` / `ai.asrBaseUrl` / `ai.asrModel` / `ai.asrKey` / `theme` / `ui.detailWidth` / `ui.tagFilter` / `ui.todayDone`） |
| value | TEXT | 值（API Key / 语音 Key 为加密后内容；`ui.todayDone` 为 `{day, ids}` JSON，记录「今天」里刚完成的任务） |

### reports — AI 报告历史（迁移 v7）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增主键 |
| title | TEXT | 报告标题（如「月报 2026-10-01 ~ 2026-10-31」） |
| type | TEXT | `day` / `week` / `month` / `custom` |
| range_start / range_end | TEXT | 统计区间（YYYY-MM-DD） |
| group_ids | TEXT | 筛选的分组 id JSON 数组（空数组 = 全部） |
| group_label | TEXT | 分组文案（回看时知道当时筛了什么） |
| extra_prompt | TEXT | 用户追加的自定义要求 |
| content | TEXT | 报告正文（Markdown，编辑后自动回写） |
| degraded | INTEGER | 1 = 本地模板报告（未配置 Key / AI 失败） |

### ai_searches — AI 检索历史（迁移 v7）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增主键 |
| keyword | TEXT | 检索关键词 |
| summary | TEXT | AI 总结（未配置 Key 时为空） |
| task_count | INTEGER | 命中任务数 |
| tasks | TEXT | 命中任务快照 JSON 数组（回看时无需重新检索） |
| degraded | INTEGER | 1 = AI 总结失败已降级 |

### meetings — 会议记录（迁移 v6）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增主键 |
| title | TEXT | 会议名称 |
| source_label | TEXT | 采集说明（如「麦克风 + 系统声」/「窗口名」/「外部导入」） |
| mode | TEXT | `audio` 仅音频 / `screen` 画面+音频 |
| started_at | TEXT | 会议开始时间（UTC ISO） |
| duration_ms | INTEGER | 录制时长（毫秒） |
| media_paths | TEXT | 分片文件路径 JSON 数组 |
| transcript | TEXT | 语音转写全文 |
| summary | TEXT | AI 生成的纪要（Markdown） |
| todos | TEXT | 提取出的待办 JSON 数组（title / assignee / due / priority / detail） |
| status | TEXT | `recorded` 已录制 → `transcribed` 已转写 → `summarized` 已出纪要 |

### note_folders / notes / note_tags / note_tag_map — 笔记（迁移 v9）

| 表 | 关键字段 | 说明 |
|---|---|---|
| note_folders | `parent_id`（自引用）、`color`、`sort_order` | 笔记目录，与分组同构，支持无限层级 |
| notes | `folder_id`、`title`、`content_md`、`excerpt`、`pinned`、`archived`、`deleted_at`、`word_count`、`content_hash`、`source`、**`attachments`**（迁移 v11） | 正文为唯一权威来源，摘要 / 字数 / 哈希派生；`deleted_at` 非空 = 回收站；`attachments` 存图片元数据（相对路径） |
| note_tags / note_tag_map | `name` UNIQUE / 多对多 | 与任务 `tags` 分开，避免互相污染筛选 |
| notes_fts | FTS5 external content（trigram） | 全文检索，正文不重复存储 |

### task_notes — 任务 ↔ 笔记（迁移 v9）

| 字段 | 类型 | 说明 |
|---|---|---|
| task_id | INTEGER FK | 任务（`ON DELETE CASCADE`：删任务即摘引用） |
| note_id | INTEGER FK | 笔记（`ON DELETE CASCADE`） |
| created_at | TEXT | 关联时间 |

### knowledge_bases / kb_documents / kb_chunks — 知识库（迁移 v10）

| 表 | 说明 |
|---|---|
| knowledge_bases | 知识库注册表；内置「笔记知识库」固定 `id = 1`、`type = 'notes'` |
| kb_documents | 文档；笔记对应 `source_key = 'note:<笔记id>'`，含 `content_hash` 用于增量判定 |
| kb_chunks | 分块（按 Markdown 标题切分，带 `heading_path`），配 `kb_chunks_fts` 供检索召回 |
| kb_vectors | 向量预留（一期不写入：智能检索走「查询改写 + 多路召回 + RRF + AI 重排」） |

### 迁移 v11：笔记附件（图片）

笔记图片与任务附件共用 `main/attachments.js`，只是宿主目录换成 `note-<id>`：

- 文件：`<数据目录>/attachments/note-<笔记id>/<附件id>_<文件名>`
- 库里：`notes.attachments` 只存元数据 JSON（含**相对**路径），与 `tasks.attachments` 同构
- 正文引用：`![](todo-media:///note-<id>/<附件id>_<文件名>)`，由主进程注册的自定义协议映射回本地文件
  （只解析 attachments 目录内的路径，越界拒绝）

> 分块属派生数据，**不进导入导出**（可由笔记正文重建）；备份 `schemaVersion` 已升到 **11**，
> 新增导出 `note_folders / notes / note_tags / note_tag_map / task_notes / knowledge_bases`
> （附件元数据随 `notes` 一起走），导入后自动全量重建索引。

## AI 检索的联想逻辑

关键词没精确命中时，检索不再直接返回"未找到"，而是分层召回并按相关度排序：

| 层级 | 做法 | 说明 |
|---|---|---|
| 精确层 | SQL LIKE 匹配标题 / 描述 / 标签 | 改造前的原有能力，**命中即优先返回**，不走联想 |
| 字面层 | 关键词分词后逐词比对标题、标签、描述、分组名 | 长词优先并"占掉"已匹配片段，避免 bigram 重复计分 |
| 联想层 | 同义词扩展、缩写还原、近似拼写（Damerau 编辑距离）、状态语义、时间语义 | 例如 `bug→缺陷/修复`、`ui→界面`、`wrok≈work`、`待办→未完成`、`本周→本周区间` |
| 语义层 | 配了 AI Key 时由模型在候选池内重排并给出理由 | **只重排不新增**，杜绝编造；本地零召回时用它做纯语义兜底 |

**三种结果**（界面顶部提示条会明确区分）：

- **唯一匹配** —— 强命中（精确 / 完整包含）且明显领先第二名，或只召回 1 条且分数足够，可直接打开；
- **多个候选** —— 有候选但拉不开差距，按相关度排序请用户确认，**最多 5 条**；
- **确实无关联** —— 明确提示未找到，并列出**已尝试的联想方向**（只列这次真的做过的，不虚报）。

每条候选都展示**命中依据**（由哪个关键词、经哪条联想推导而来）与相关度条，例如
「`ui` 缩写还原为 `界面` 命中标题」。

相关代码：`main/search-assist.js`（本地召回打分）、`main/ipc.js` 的 `search:ai`（分层编排）、
`main/ai.js` 的 `rankSearchCandidates`（可选的语义重排）、`renderer/js/search.js`（三态渲染）。

## AI 接口配置

采用 **OpenAI 兼容 `/chat/completions` 协议**，可无缝切换以下服务：

| 服务 | Base URL | 模型示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5` |

**配置方式**：顶部菜单栏「AI 设置」→ 填写 Base URL / 模型 / API Key → 保存。Key 通过 `safeStorage`（Windows 基于 DPAPI）加密后存入 `settings` 表，不以明文落盘，也**不下发到渲染进程**。

**无 Key 降级**：未配置 Key 或调用失败时，自动基于本地数据生成结构化模板报告（完成情况 / 进行中 / 逾期 / 小结），并在界面给出明确提示。

### 语音转写（ASR）配置

会议录制需要**单独的一组语音配置**（同一个弹窗的下半部分）：DeepSeek、Moonshot 这类纯文本服务不提供语音接口，所以语音不能复用对话模型的 Key。

采用 OpenAI 兼容的 **multipart `POST /audio/transcriptions`** 协议：

| 服务 | Base URL | 模型 | 备注 |
|---|---|---|---|
| **硅基流动 SenseVoice** | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` | 国内直连、中文优化，官方价位为**免费档**（需实名，限流固定） |
| **阿里云百炼 Qwen3-ASR-Flash** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` | 国内直连，¥0.00024/秒量级，中文方言覆盖广 |
| 硅基流动 Qwen3-ASR-1.7B | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-ASR-1.7B` | 官方标价约 ¥0.00022/秒（时有限免，以官网价格页为准） |
| OpenAI Whisper | `https://api.openai.com/v1` | `whisper-1` | 需外网 |
| Groq Whisper | `https://api.groq.com/openai/v1` | `whisper-large-v3` | 需外网，速度快 |
| 本地 Whisper 服务 | `http://localhost:8000/v1` | `whisper-1` | 完全离线，须自建服务 |

**兼容性兜底**：百炼各版本兼容层对 `/audio/transcriptions` 的支持并不一致，官方主推的是「chat/completions + `input_audio` base64」方式。
因此转写遇到 **HTTP 404 / 405** 时会自动改走 `/chat/completions` 通道再试一次，用户不需要为换厂商手改地址。

> 注意：同一个厂商地址下可能挂多个 ASR 模型，预设下拉按 **id** 定位，不会串模型。

- 「测试语音接口」校验的是模型列表可达性（不产生音频计费）；若厂商的 `/models` 只列大语言模型（百炼常见），会返回"连通但未见该模型"的提示而非判失败
- 单个文件超过 24MB 会直接拒绝并提示缩短切片时长
- 音频文件落在 `<用户数据目录>/recordings/<会话id>/chunk-NNN.webm`；删除会议记录会一并清理

## 数据导入 / 导出

- **导出**：侧边栏「数据 → 导出数据」将分组、标签、任务、关联关系导出为 **JSON 文件**（不包含 AI API Key）。
- **导入**：「数据 → 导入数据」从 JSON 文件恢复数据（覆盖当前任务/分组/标签，保留主题与 AI 配置）。
- **文件格式**：JSON，包含 `groups` / `tags` / `tasks` / `task_tags` / `meetings` / `reports` / `ai_searches` / `settings` 数组（`schemaVersion` 现为 7），字段与数据模型一致；导入时兼容旧版 `due_at` 字段（自动映射为计划完成日期）。导入为覆盖式，历史报告与检索记录也会一并覆盖。
- 备份**不含** AI / 语音 Key；会议目录里的音频文件不随 JSON 导出，需要单独保留 `recordings/` 目录。

## 开机自启动

菜单 **File → 开机自启动**（勾选项）可开启 / 关闭；登录系统后自动在后台启动，只驻留托盘、不弹主窗口。
勾选状态以系统实际登记的启动项为准（在「任务管理器 → 启动」里关闭也会同步反映）。
便携版与开发调试模式下不可用（无法登记稳定的启动路径），菜单项会置灰。

## 说明

- 删除已完成任务会同时移除其统计记录；归档会保留统计（`completed_at` 仍在）。
- 计划开始/完成日期仅保留年月日（无时分秒）；提醒时间精确到分钟。
- 会议录制过程中**不要**把窗口最小化到托盘：系统会把画面 / 采集轨挂起（仅音频模式不受影响）。录制时可正常使用其它窗口，采集在后台继续。
- macOS 上系统声采集需要第三方虚拟声卡（BlackHole 等）；本应用的链路以 Windows 为准。
- 窗口「关闭」按钮默认最小化到托盘，通过托盘菜单「退出」或应用内退出才真正结束进程。
## 打包为 Windows exe

项目已接入 `electron-builder`，一条命令产出两种分发形态：

```bash
npm run dist            # 同时产出安装版 + 便携版
npm run dist:installer  # 只产出 NSIS 安装版
npm run dist:portable   # 只产出便携版（免安装）
```

产物输出到 `dist/`：

| 文件 | 说明 |
|---|---|
| `Knodo-<版本>-安装版.exe` | NSIS 安装程序，可选安装目录、自动建桌面/开始菜单快捷方式，安装界面为中文 |
| `Knodo-<版本>-便携版.exe` | 单文件绿色版，双击即用；数据写在 exe 同级的 `data/` 目录，整个文件夹拷走即可换机 |
| `dist/win-unpacked/` | 未压缩的可直接运行副本（调试用） |

要点：

- 打包配置写在 `package.json` 的 `build` 字段；`scripts/build-win.js` 负责注入国内镜像（electron / NSIS / winCodeSign 资源从 npmmirror 下载，避免 GitHub 超时）。
- `better-sqlite3` 使用官方预编译二进制（`prebuilds/`），**不需要** VS 生成工具，因此打包配置里 `npmRebuild: false`；其 `.node` 文件会通过 `asarUnpack` 解包到 `app.asar.unpacked` 才能被加载。
- 安装版数据存 `%APPDATA%\todo-desktop\`；便携版数据存 exe 同级 `data\`（由 `PORTABLE_EXECUTABLE_DIR` 判定）。
- **数据目录可配置**：菜单「File → 存储位置」可选任意目录（例如换到 D 盘），配置写在 `<用户数据目录>/config.json` 的 `dataDir` 字段，
  下次启动生效；可勾选把现有数据（`todo.db` + `attachments`）复制到新目录。配置目录不可用（盘未插入 / 被删 / 无写权限）时会自动回退默认目录并弹窗提示。
  录音文件（`recordings/`）仍留在用户数据目录：会议记录里存的是绝对路径，迁移会造成两份数据。
- 首次打包需下载约 100MB 的 Electron 与 NSIS 资源，之后有缓存，单个 exe 产物约 116MB（Electron 运行时体积，非本项目代码大小；本项目代码仅约 6MB）。
- 版本升级改 `package.json` 里的 `version` 即可，文件名与卸载条目会随之变化。

打包后自检（可选）：带调试端口启动 `dist\win-unpacked\Knodo.exe --remote-debugging-port=9333`，再执行 `node scripts/check-packaged.js 9333`，会输出标题、DOM 渲染结果与渲染层异常。

## 发布 Gitee 发行版（供他人直接下载）

仓库页面「发行版」标签下的附件可供直接下载，无需 clone 代码。流程：

```bash
# 1. 打包
npm run dist

# 2. 生成发布包（401MB 运行目录 → 94.9MB 的 7z）：
#    - 只保留 zh-CN / zh-TW / en-US 语言包
#    - 移除 dxcompiler.dll（WebGPU 编译器，本应用未用到）
#    - 7z -mx=9 极限压缩（7za 位于 electron-builder 缓存目录）
# 产物放入 dist/release/Knodo-<版本>-win64.7z
```

```bash
# 3. 一键发布（tag → Release → 逐个上传 dist/release/ 附件）
GITEE_TOKEN=<私人令牌> npm run release
```

要点：

- **Gitee 附件硬限制**：发行版/仓库附件单个 ≤100MB（GVP 200MB），每仓库总附件 ≤1GB。exe 直传（116MB）会失败——NSIS 内部已 LZMA 压实，再压无收益，所以发布形态是「瘦身运行目录的 7z 包」。
- `scripts/release-gitee.js` 具备幂等性：已存在的 tag / Release / 同名附件自动跳过，大附件上传带 3 次重试；令牌只从 `GITEE_TOKEN` 或 `--token` 读取，不写入任何文件。
- 私人令牌生成：Gitee 头像 → 设置 → 安全设置 → 私人令牌（勾选 projects 权限）。
- **私有仓库的附件匿名访问返回 403**，只有有权限的登录用户可下载；要公开分发需在「仓库管理 → 基本信息 → 是否开源」设为公开。

> 注意：若命令行环境存在 `ELECTRON_RUN_AS_NODE=1`，Electron 会以纯 Node 模式运行并立即退出，看起来像"打包失败"。双击 exe 不受影响；命令行验证时请先 `unset ELECTRON_RUN_AS_NODE`。
