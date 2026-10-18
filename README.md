# TODO 待办 — Windows 桌面端个人待办应用

基于 **Electron + better-sqlite3** 的桌面端 TODO 应用。界面简洁、操作高效、**数据全部本地存储**（SQLite 文件位于用户数据目录，不联网、不上传）。

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
- 按计划开始/完成日期、实际完成时间的时间筛选
- 数据导入 / 导出（JSON 文件备份与恢复）
- 排序方式可切换（智能 / 优先级 / 截止日期 / **手动**），手动模式下按住任务左侧 ⠿ 手柄即可拖拽排序
- 已完成任务归档与统计
- 系统托盘 + 全局快捷键
- 深色模式
- 窗口关闭后最小化到托盘

**进阶功能**
- 任务详情页：点击任务查看/编辑，描述支持**所见即所得编辑**（Markdown 快捷键，图片直接插入光标处）
- 详情侧边栏可**拖拽左侧边缘调整宽度**（360 ~ 860px，双击手柄恢复默认），宽度自动记忆、下次打开复用
- **编辑即时持久化**：列表行内编辑与详情抽屉中修改任意字段，停止输入约 0.7s 后自动写入，无需点"保存"；失败时保留输入并可点击状态重试，任务已被删除等冲突会提示并回滚
- 分组 / 标签通过弹窗新增，支持重名校验与失败原因提示（如数据库只读），新增后列表即时可见并高亮
- 子任务与主任务同级：具备**优先级、计划开始 / 完成日期**，可就地编辑（自动保存），参与列表排序与筛选；列表默认收缩、可展开（筛选视图下也能正常展开），显示所属父任务；详情页树形层级；所有子任务完成时父任务自动完成；支持拖拽排序（行首 ⠿ 手柄）；添加/勾选时仅局部刷新，不闪烁
- AI 检索：输入关键词检索所有任务并生成总结，结果可点击跳转详情
- 集成 AI，基于本地任务与完成记录自动生成**日报 / 周报 / 月报**
- **AI 配置集中在顶部工具栏「⚙ AI 设置」**（接口预设 / Base URL / 模型 / API Key / 测试连接 / 清除 Key），AI 报告页只负责生成与导出
- 生成结果可编辑，并导出为 **Word（.docx）**、Markdown 或纯文本；分组筛选支持**多选**（树形层级，勾选父分组覆盖其子分组）
- API Key 本地加密保存（safeStorage / Windows DPAPI），无 Key 时降级为本地模板报告并提示

**会议纪要（录制 → 转写 → AI 纪要 → 待办入库）**
- **录制**：工具栏「⏺ 录制」一键采集。默认**仅音频**（麦克风 + 系统声混音）；Windows 下系统声走 WASAPI 回环，会议里对方的声音直接进来，无需虚拟声卡。也可选择「画面 + 音频」，从屏幕 / 窗口缩略图里挑要录的目标
- **自动切片**：按 5 / 10 / 15 / 30 分钟切成独立的完整 WebM 文件，绕开云端常见的单文件 25MB 限制；录制中可暂停，底部浮动条实时显示时长与已存片数
- **语音转写**：对接 OpenAI 兼容的 `/audio/transcriptions`（Whisper 类），分片顺序上传，用上一片结尾做上下文提示减少断句错乱；也可直接**导入已有录音 / 录像文件**
- **AI 纪要**：输出「会议主题 / 关键议题与结论 / 决议事项 / 待办事项 / 风险与遗留问题」结构化 Markdown；长会议走分段提炼再合并，避免上下文溢出
- **待办入库**：从纪要里提取行动项（负责人 / 截止日期 / 优先级），**勾选后批量写入任务列表**，可选各自独立或挂在同一个父任务下；纪要可导出 Word / Markdown
- 配置项独立：语音接口与对话模型分开填（DeepSeek 等纯文本服务不提供语音接口），详见《AI 接口配置》

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
│   ├── main.js             # 入口：窗口生命周期、单实例、托盘/快捷键/提醒装配
│   ├── db.js               # SQLite 数据访问层（建表、迁移、CRUD、统计）
│   ├── ipc.js              # IPC 处理器注册（渲染进程 ↔ 主进程）
│   ├── tray.js             # 系统托盘（显示/隐藏、快速添加、退出）
│   ├── shortcuts.js        # 全局快捷键
│   ├── reminders.js        # 提醒调度器
│   ├── crypto.js           # API Key 本地加密（safeStorage，降级 Base64）
│   ├── ai.js               # AI 接口调用（OpenAI 兼容 /chat/completions）
│   ├── asr.js              # 语音转写（OpenAI 兼容 /audio/transcriptions，multipart 直传）
│   ├── meeting.js          # 会议纪要生成 + 待办结构化提取（含长会分段提炼）
│   ├── recording.js        # 录制文件管理（会话目录 / 分片落盘 / 导入外部音频）
│   ├── report.js           # 日报/周报/月报 生成（LLM + 本地降级）
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
│       ├── reports.js      # AI 报告视图
│       ├── group-tree.js   # 分组树工具（层序展开 / 路径 / 下拉选项 / 子孙 id）
│       ├── recorder.js     # 录制内核（源选择 / 混音 / 分片 / 浮动控制条）
│       ├── meetings.js     # 会议纪要视图（转写 / 生成 / 待办勾选入库 / 导出）
│       ├── ai-settings.js  # AI 设置弹窗（挂载在顶部工具栏，含语音接口配置）
│       ├── markdown.js     # Markdown 渲染
│       ├── autosave.js     # 编辑即时持久化（防抖 + 冲突回滚）
│       ├── search.js       # AI 检索视图
│       ├── controls.js     # flatpickr 日期范围控件封装
│       ├── detail.js       # 任务详情抽屉
│       ├── modal.js        # 轻量模态框（表单弹窗，替代原生 prompt）
│       ├── app.js          # 入口
│   └── vendor/             # 前端第三方库（离线内置）
│       └── flatpickr/      # flatpickr 4.6 + 官方 CSS + 中文语言包
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
| attachments | TEXT | 图片附件（JSON 数组，base64，缩略图展示） |
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
| key | TEXT PK | 键（`ai.baseUrl` / `ai.model` / `ai.apiKey` / `ai.asrBaseUrl` / `ai.asrModel` / `ai.asrKey` / `theme`） |
| value | TEXT | 值（API Key / 语音 Key 为加密后内容） |

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

## AI 接口配置

采用 **OpenAI 兼容 `/chat/completions` 协议**，可无缝切换以下服务：

| 服务 | Base URL | 模型示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5` |

**配置方式**：顶部工具栏「⚙ AI 设置」→ 填写 Base URL / 模型 / API Key → 保存。Key 通过 `safeStorage`（Windows 基于 DPAPI）加密后存入 `settings` 表，不以明文落盘，也**不下发到渲染进程**。

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
- **文件格式**：JSON，包含 `groups` / `tags` / `tasks` / `task_tags` / `meetings` / `settings` 数组（`schemaVersion` 现为 6），字段与数据模型一致；导入时兼容旧版 `due_at` 字段（自动映射为计划完成日期）。
- 备份**不含** AI / 语音 Key；会议目录里的音频文件不随 JSON 导出，需要单独保留 `recordings/` 目录。

## 全局快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl/Cmd + Shift + T` | 显示 / 隐藏主窗口 |
| `Ctrl/Cmd + Shift + N` | 快速添加任务 |

## 说明

- 删除已完成任务会同时移除其统计记录；归档会保留统计（`completed_at` 仍在）。
- 计划开始/完成日期仅保留年月日（无时分秒）；提醒时间精确到分钟。
- 会议录制过程中**不要**把窗口最小化到托盘：系统会把画面 / 采集轨挂起（仅音频模式不受影响）。录制时可正常使用其它窗口，采集在后台继续。
- macOS 上系统声采集需要第三方虚拟声卡（BlackHole 等）；本应用的链路以 Windows 为准。
- 窗口「关闭」按钮默认最小化到托盘，通过托盘菜单「退出」或应用内退出才真正结束进程。
- 本项目未打包安装程序；如需分发，可额外接入 `electron-builder` / `electron-forge`。
