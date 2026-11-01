<div align="center">

<img src="assets/knodo.svg" width="104" alt="Knodo"/>

# Knodo

**Knowledge + Todo** —— 把「待办清单」和「知识沉淀」放进同一个应用。

任务、笔记、会议纪要共用一个本地数据库，AI 报告与检索都建立在你自己的记录之上。<br/>
不注册、不联网同步、不上传，数据始终是本地一个 SQLite 文件。

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![Electron](https://img.shields.io/badge/Electron-44-47848F)
![SQLite](https://img.shields.io/badge/storage-SQLite%20%28local%29-003B57)
![License](https://img.shields.io/badge/license-MIT-green)

[为什么是 Knodo](#为什么是-knodo) · [功能亮点](#功能亮点) · [快速开始](#快速开始) · [文档](docs/README.md)

</div>

![Knodo 任务视图](docs/screenshots/tasks.png)

---

## 为什么是 Knodo

**做完的事不会凭空消失。** 大多数待办应用勾完就把任务藏起来，让你怀疑自己点错了。
Knodo 把它留在原地：打勾、置灰、加删除线，底部告诉你「今天完成了 3 件」，跨天自动归档。

**任务和知识长在一起。** 一条任务可以关联多篇笔记，一篇笔记能看到被哪些任务引用；
任务描述、会议纪要、笔记共用同一套 Markdown 渲染，写下来的东西可以被检索、被 AI 引用，而不是躺在文件夹里。

**AI 是加法，不是前提。** 没配置 API Key 也能用全部功能：报告降级成本地模板，
检索降级成本地分层召回，笔记照常全文搜索。配了 Key 才多出总结、语义重排与问答。

**数据是你的。** 本地 SQLite，无账号体系；数据库就是一个 `.db` 文件，备份是一个 JSON 文件，随时能带走。

---

## 功能亮点

### 任务：按「今天」工作，其余交给分组

多级分组（父组 ⇄ 子组无限层）、子任务进度、优先级、计划时间范围、标签、提醒、拖拽排序。
「今天」列表里做完的任务会保留，切标签页、重启应用都还在。

### 详情：改一个字，不用开两个页面

点任务行展开右侧抽屉：描述所见即所得编辑、图片直接插入光标处、附件与关联笔记都在手边。
所有字段停止输入约 0.7 秒自动保存，保存失败保留输入并可重试 —— 没有「保存」按钮要按。

![任务详情](docs/screenshots/task-detail.png)

### 笔记：写得进去，也找得回来

Markdown 编辑器（编辑 / 分栏 / 预览）、代码块高亮、Mermaid 图表、截图直接粘贴、
无限层级目录与标签、FTS5 中文全文检索、回收站。写下的内容会自动切块进知识库，
可以就着自己的笔记提问并跳回出处。

![笔记视图](docs/screenshots/notes.png)

### 会议：录完就有纪要和待办

一键录制（麦克风 + 系统声，Windows 走 WASAPI 回环，无需虚拟声卡），按 5/10/15/30 分钟自动切片，
顺序上传转写，AI 输出「议题 / 决议 / 待办 / 风险」结构化纪要，勾选行动项即可批量写进任务列表。

![会议纪要](docs/screenshots/meetings.png)

### AI 报告：周报不用再回忆这周干了什么

日报 / 周报 / 月报基于本地完成记录生成，按 Word 文档版式呈现、可直接编辑、自动保存，
支持追加自定义要求（「按计划完成时间排下个月的工作计划」），导出 Word 或 Markdown，历史记录可回看。

![AI 报告](docs/screenshots/ai-report.png)

### AI 检索：模糊记得也能找到

关键词没精确命中时不直接说「没找到」，而是分层召回：精确 → 字面 → 联想（同义词 / 缩写 / 近似拼写 /
状态与时间语义）→ 语义重排，并明确告诉你「由哪个关键词经哪条联想命中」。

![AI 检索](docs/screenshots/ai-search.png)

### 统计：数字可以点进去

总任务 / 进行中 / 已完成 / 逾期 / 归档，点卡片直接下钻到任务明细；口径可在「仅主任务 / 含子任务」间切换，
趋势看近 7 天到近一年。

![统计](docs/screenshots/stats.png)

### 顺手能用的小工具

代码格式化、文本对比、JSON 查看器、实时薪资 —— 都是非模态浮窗，开着也不挡主界面。
另外可把任务导出成 CSV 直接导入腾讯文档表格，把笔记打包成 `.md` 批量上传到知识库。

![实用工具](docs/screenshots/tools.png)

### 界面：浅色 / 深色，托盘常驻

<div align="center">
<img src="docs/screenshots/dark-mode.png" width="900" alt="深色模式"/>
</div>

关闭窗口默认最小化到托盘；可设开机自启（安装版）、可把数据目录换到任意磁盘。

---

## 快速开始

### 直接使用

到 [Gitee 发行版](https://gitee.com/kiverson/todo-task/releases) 下载最新版本：

| 形态 | 说明 |
|---|---|
| `Knodo-<版本>-安装版.exe` | NSIS 安装程序，自动建快捷方式，数据在 `%APPDATA%\todo-desktop` |
| `Knodo-<版本>-便携版.exe` | 单文件绿色版，数据在 exe 同级 `data/`，整个文件夹拷走即可换机 |

> 发行版里的附件常以瘦身 `.7z` 包提供（Gitee 单个附件上限 100MB）；
> 便携版超过上限时会分成 `.001` / `.002` 两卷，**两卷都要下齐**，只解压 `.001` 即可。

### 从源码运行

```bash
npm install     # 首次会下载 Electron 二进制
npm start
```

要求 **Node.js ≥ 18**、**Windows 10/11**。`better-sqlite3` 使用 N-API 预编译二进制，
不需要 Visual Studio 构建工具，也不需要 electron-rebuild。

> 在自带 `ELECTRON_RUN_AS_NODE=1` 的终端里启动会「一闪而过」，
> 用 `env -u ELECTRON_RUN_AS_NODE npm start`。详见[开发指南](docs/开发指南.md)。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 运行环境 | Electron 44（主进程 + preload 收口，渲染层不碰文件系统与明文密钥） |
| 存储 | SQLite（`better-sqlite3`）+ FTS5 trigram 全文索引，WAL 模式 |
| 前端 | 原生 JS + CSS 变量主题，无框架；第三方库 vendor 进仓库、离线可用 |
| AI | OpenAI 兼容 `/chat/completions` 与 `/audio/transcriptions`，可换 DeepSeek / 通义 / Kimi / Ollama |
| 打包 | electron-builder（NSIS 安装版 + 便携版），发布走 Gitee 发行版 |

---

## 文档

| 文档 | 你会在这里找到 |
|---|---|
| [功能详解 · 任务与视图](docs/功能详解-任务与视图.md) | 分组、子任务、日期范围、筛选排序、详情抽屉、统计下钻 |
| [功能详解 · 笔记与知识库](docs/功能详解-笔记与知识库.md) | 编辑器、Mermaid、图片、导入导出、检索、知识库问答 |
| [功能详解 · 会议纪要](docs/功能详解-会议纪要.md) | 录制、切片、转写、AI 纪要、待办入库 |
| [功能详解 · AI 能力](docs/功能详解-AI能力.md) | AI 设置、报告、检索联想逻辑、接口配置表 |
| [功能详解 · 效率工具与数据](docs/功能详解-效率工具.md) | 浮窗工具、导出到腾讯文档 / ima、JSON 备份、托盘与自启 |
| [常见问题](docs/常见问题.md) | 数据在哪、关闭没退出、无 Key 的表现、便携版限制 |
| [开发指南](docs/开发指南.md) | 目录结构、依赖策略、冒烟测试、调试 |
| [数据库设计](docs/数据库设计.md) | 表结构、迁移、FTS、附件协议、备份格式 |
| [打包与发布](docs/打包与发布.md) | 品牌标识、打包产物、7z 瘦身与 Gitee 发版 |

完整索引见 [docs/README.md](docs/README.md)。

---

## 许可

MIT License。第三方库的许可与来源版本登记在 `package.json` 中。
