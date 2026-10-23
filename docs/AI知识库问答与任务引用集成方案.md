# TODO 待办 →「AI 知识库问答」平台 + 任务多知识库引用升级方案

> 面向当前 Electron + better-sqlite3 + 本地 OpenAI 兼容 AI 网关的桌面应用，**增量扩展**，不推倒重来。
> 复用现有能力：数据层迁移机制（`main/db.js` 的 `MIGRATIONS` + `user_version`）、IPC/preload 通道与 `guard`/`withDb` 包装、
> `main/crypto.js` 的 Key 加密、`openFormModal` / `openPanelModal` 弹窗、Tom Select 多选、Markdown 渲染、
> `autosave.js` 即时持久化、`docx.js` 导出。
>
> 与已有文档的关系：`docs/问题汇总与AI检索问答平台方案.md` 定义的是**问题（issues）**这条线的采集与结构化，
> 本方案把它降级为知识库的一种「内置数据源」（`type='builtin', source. builtin='issues'`），
> 并补齐「知识库作为一等实体 + 任务可多选引用 + 问答作用域」这三件事。**两份文档并行有效，本方案为准。**

---

## 0. 目标与边界

| 目标 | 落地形态 |
|---|---|
| 用户问题汇总管理 | 侧栏「🧩 问题库」：统一的 issue 列表/筛选/详情（沿用上一份方案的 `issues` 表） |
| 基于 AI 知识库的智能问答 | 侧栏「💬 问答」：作用域限定在所选知识库，答案强制带引用溯源 |
| 任务可引用知识库（**可多选**） | 任务详情新增「🔗 引用知识库」多选区；列表行显示引用徽章；问答随任务自动限定作用域 |
| 管理知识库 | 侧栏「🧠 知识库」：卡片列表 + 接入向导 + 索引进度 + 停用/删除 |

三条实体关系：

```
问题 issues ──┐
              ├──> 知识库 KB ──> 文档 docs ──> 分块 chunks ──> 索引 FTS/向量
本地文件夹 ───┤
上传文件   ───┤
外部平台API ──┘        任务 tasks ──< task_kb_refs >── 知识库 KB
                        │
                        └── qa_session(scope='task') ──> 只在被引用的 KB 里检索
```

一句话：**知识库是能力层（可被挂载），任务是使用端（可多选挂载），问答是消费端（作用域继承任务的挂载）。**

---

## 1. 总体架构

```
┌─ 渲染层 renderer/js ────────────────────────────────────────────┐
│ kb-manage.js（知识库卡片/向导）  qa.js（问答页/会话）  issues.js  │
│ kb-ref-picker.js（多选引用组件，Tom Select）  detail.js（抽屉区） │
│ ui.js 侧栏导航 + render() 视图分发                               │
└────────────── api(preload) ── ipcMain ──────────────────────────┘
┌─ 主进程 main ───────────────────────────────────────────────────┐
│ kb-registry.js  知识库注册表 CRUD / 启用停用 / 健康检查          │
│ kb-sources/*.js 数据源适配器（folder / upload / api / builtin）  │
│ kb-ingest.js    文档发现 → 解析 → 分块 → 入队（可取消的队列）    │
│ kb-parsers/*.js 解析器（md/txt/html/pdf/docx/xlsx/csv）          │
│ kb-index.js     增量索引管线（content_hash 去重 + 批次 + 重试）  │
│ embed.js        embedding 客户端（本地 Ollama / OpenAI 兼容）    │
│ kb-retrieve.js  跨库混合检索：FTS5(trigram) + 向量 → RRF 融合    │
│ qa.js           会话 / 上下文装配 / 流式生成 / 引用解析 / 反馈   │
│ db.js           迁移 v9(issues) v10(kb_*/task_kb_refs/qa_*)      │
└─────────────────────────────────────────────────────────────────┘
```

关键取舍：**知识库对上层只暴露一个检索接口**。不管底层是本地 SQLite 索引还是远端 RAG 服务，
上层拿到的都是统一的 `Hit { kbId, docId, chunkId, title, snippet, url/path, score }`，
跨库融合与引用展示因此不需要区分来源。

---

## 2. 功能模块划分

| # | 模块 | 职责 | 主进程 | 渲染层 | IPC 通道 |
|---|---|---|---|---|---|
| M1 | **知识库注册与管理** | 知识库 CRUD、类型参数、启用/停用、健康检查、引用计数、默认库设置 | `main/kb-registry.js` | `renderer/js/kb-manage.js` | `kb:list` `kb:create` `kb:update` `kb:remove` `kb:test` `kb:setDefault` |
| M2 | **数据源适配** | 四种数据源的参数校验、连接测试、同步对外统一接口 | `main/kb-sources/{folder,upload,api,builtin}.js` | — | — |
| M3 | **接入与解析** | 文件发现/上传复制、格式解析、增量判定（指纹）、失败留痕 | `main/kb-ingest.js` + `main/kb-parsers/*.js` | 向导页内的文件选择（走 `dialog.showOpenDialog`） | `kb:pickFiles` `kb:sync` `kb:cancelSync` |
| M4 | **索引管线** | 分块、embedding 批量调用、哈希去重、进度上报、模型切换全量重建 | `main/kb-index.js` `main/embed.js` | 卡片上的进度条/重建按钮 | `kb:index` `kb:indexState` `kb:cancelIndex` |
| M5 | **混合检索** | 跨多库检索、FTS5 + 向量双路、RRF 融合、可选 LLM 重排、结果去重 | `main/kb-retrieve.js` | — | `kb:retrieve` |
| M6 | **问答引擎** | 会话/消息落库、上下文装配、流式生成、引用解析、反馈回写、导出 | `main/qa.js`（生成复用 `ai.callLLM`） | `renderer/js/qa.js` | `qa:ask` `qa:sessions` `qa:messages` `qa:remove` `qa:feedback` `qa:toTask` `qa:toIssue` |
| M7 | **任务引用集成** | 任务↔知识库多对多、父任务继承、分组默认、批量读取、级联清理 | `db.setTaskKbRefs()` 等 | `renderer/js/kb-ref-picker.js` + `detail.js` + `ui.js` | `tasks:kbRefs` `tasks:setKbRefs` `kb:refsForTasks` |

**横切基础设施（不新增模块，扩展现有文件）**

- `main/db.js` → `MIGRATIONS` 追加 v9 / v10
- `main/ipc.js` → 用现成的 `withDb`/`guard` 注册新通道
- `preload/preload.js` → 暴露 `kb` / `qa` 两组 API；**流式推送需要把 `qa:stream` 加进 `on()` 的白名单数组**
- `main/crypto.js` → 外部知识库凭据复用 `encryptApiKey/decryptApiKey`，**永不下发渲染层**（界面只读到 `hasKey`）
- `renderer/index.html` → 侧栏新增 `data-view="kb" | "qa" | "issues"` 三个 `nav-item`
- `renderer/js/ui.js` → `render()` 增加三个分支；非任务视图的 `TASK_VIEWS` 判定照旧（隐藏工具区）

---

## 3. 数据模型（迁移 v9 / v10）

现有库已跑到 `v8`；`foreign_keys = ON` 已开启，可直接依赖级联删除。

### v9：问题库（沿用已有文档，此处只固化与本方案的接口）

`issues` / `issue_tags` / `issue_links` / `issue_attachments` 四张表按
`docs/问题汇总与AI检索问答平台方案.md` 的定义建立。本方案额外要求一行：

```sql
-- issues 需要一个可被 kb_chunks 引用的稳定锚点（v9 表里的 id 即可，不额外加字段）
CREATE INDEX IF NOT EXISTS idx_issues_status_group ON issues(status, group_id);
```

### v10：知识库 + 引用 + 问答

```sql
-- ① 知识库注册表（不含凭据；凭据放 settings 并走 crypto 加密）
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  type         TEXT    NOT NULL,            -- folder | upload | api | builtin
  icon         TEXT    NOT NULL DEFAULT '📚',
  color        TEXT    NOT NULL DEFAULT '#4f7cff',
  source_json  TEXT    NOT NULL DEFAULT '{}', -- 类型相关参数，见 §4.2
  enabled      INTEGER NOT NULL DEFAULT 1,    -- 停用后不参与任何检索
  status       TEXT    NOT NULL DEFAULT 'idle', -- idle|syncing|indexing|ready|error|empty
  last_error   TEXT    NOT NULL DEFAULT '',
  doc_count    INTEGER NOT NULL DEFAULT 0,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  embed_model  TEXT    NOT NULL DEFAULT '',   -- 空 = 未启用向量
  embed_dim    INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- ② 文档（本地文件指纹增量、远端文档的远端 id）
CREATE TABLE IF NOT EXISTS kb_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id        INTEGER NOT NULL,
  source_key   TEXT    NOT NULL,            -- 本地=绝对路径；远端=远端文档 id
  title        TEXT    NOT NULL DEFAULT '',
  kind         TEXT    NOT NULL DEFAULT 'txt', -- md|txt|html|pdf|docx|xlsx|csv|json
  size         INTEGER NOT NULL DEFAULT 0,
  fingerprint  TEXT    NOT NULL DEFAULT '',  -- size+mtime 组合指纹（快速判断是否变了）
  content_hash TEXT    NOT NULL DEFAULT '',  -- 内容 sha256（权威判定）
  status       TEXT    NOT NULL DEFAULT 'pending', -- pending|indexed|failed|missing
  error        TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_kb_doc ON kb_documents(kb_id, source_key);
CREATE INDEX IF NOT EXISTS idx_kb_doc_status ON kb_documents(kb_id, status);

-- ③ 分块
CREATE TABLE IF NOT EXISTS kb_chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id        INTEGER NOT NULL,
  doc_id       INTEGER NOT NULL,
  ord          INTEGER NOT NULL DEFAULT 0,
  kind         TEXT    NOT NULL DEFAULT 'body', -- heading|body|solution|summary|table
  heading_path TEXT    NOT NULL DEFAULT '',     -- 拼到块首提升召回（如 "安装 › 常见问题"）
  content      TEXT    NOT NULL,
  content_hash TEXT    NOT NULL,
  token_est    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  FOREIGN KEY (kb_id)  REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  FOREIGN KEY (doc_id) REFERENCES kb_documents(id)    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);

-- ④ 关键词索引：external content + trigram（中文子串可命中，无需外部分词器）
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  content,
  content='kb_chunks', content_rowid='id', tokenize='trigram'
);

-- ⑤ 向量（可选；一期可完全不写）
CREATE TABLE IF NOT EXISTS kb_vectors (
  chunk_id INTEGER PRIMARY KEY,
  dim      INTEGER NOT NULL,
  model    TEXT    NOT NULL,
  vec      BLOB    NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS kb_index_state (
  kb_id        INTEGER PRIMARY KEY,
  state        TEXT    NOT NULL DEFAULT 'idle', -- idle|running|canceled|error
  total        INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT, finished_at TEXT,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);

-- ⑥ 任务 ↔ 知识库（多选引用，核心新增）
CREATE TABLE IF NOT EXISTS task_kb_refs (
  task_id    INTEGER NOT NULL,
  kb_id      INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,   -- 引用顺序 = 人工可控的融合优先级
  created_at TEXT    NOT NULL,
  PRIMARY KEY (task_id, kb_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (kb_id)   REFERENCES knowledge_bases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_kb_refs_kb ON task_kb_refs(kb_id);

-- ⑦ 分组默认知识库（新建任务自动带上）
CREATE TABLE IF NOT EXISTS group_kb_defaults (
  group_id INTEGER NOT NULL,
  kb_id    INTEGER NOT NULL,
  PRIMARY KEY (group_id, kb_id)
);

-- ⑧ 问答会话与消息
CREATE TABLE IF NOT EXISTS qa_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT    NOT NULL DEFAULT 'global', -- global | task | issue
  ref_id      INTEGER,                            -- scope=task 时是 task_id
  title       TEXT    NOT NULL DEFAULT '',
  kb_ids      TEXT    NOT NULL DEFAULT '[]',      -- 提问当时的引用快照（答案可解释）
  kb_labels   TEXT    NOT NULL DEFAULT '[]',
  msg_count   INTEGER NOT NULL DEFAULT 0,
  last_at     TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_sessions_scope ON qa_sessions(scope, ref_id, last_at DESC);

CREATE TABLE IF NOT EXISTS qa_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  role        TEXT    NOT NULL,            -- user | assistant | system
  content     TEXT    NOT NULL DEFAULT '',
  hits        TEXT    NOT NULL DEFAULT '[]', -- 召回快照：{kbId,docId,chunkId,title,snippet,path,score}
  feedback    INTEGER NOT NULL DEFAULT 0,   -- 1 有用 / -1 没用 / 0 未评价
  degraded    INTEGER NOT NULL DEFAULT 0,
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  FOREIGN KEY (session_id) REFERENCES qa_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qa_messages_session ON qa_messages(session_id, id);
```

**约定**

- 时间统一 UTC ISO（与现有 `created_at/updated_at` 一致）。
- `settings` 新增键：`kb.embedBaseUrl` / `kb.embedModel` / `kb.embedKey`（加密）/ `kb.enableCloudEmbedding`（默认 0）/
  `kb.inheritSubtaskRefs`（默认 1）/ `kb.defaultKbIds`（全局默认引用，JSON 数组）/ `kb.topK`（默认 8）/
  `kb.chunkSize`(默认 800) / `kb.chunkOverlap`(默认 120) / 每个外部 KB 的凭据 `kb.cred.<id>`（加密）。
- **导入导出**：`schemaVersion` 提到 9，导出 `knowledge_bases`(去凭据) / `task_kb_refs` / `issues` / `qa_sessions` / `qa_messages`；
  **不导出 `kb_documents/kb_chunks/kb_vectors`**（可从原文件/远端重建），与现有「备份不含 API Key」同思路。

---

## 4. 知识库的接入与管理方式

### 4.1 四种数据源（统一适配器接口）

```js
// main/kb-sources/base.js —— 所有数据源都要实现这五个方法
module.exports = {
  describe(cfg),                        // → 展示态：来源文案、图标、是否支持增量
  validate(cfg),                        // → { ok, error } 参数合法性
  async health(cfg, secrets),           // → { ok, detail } 「测试连接」按钮走它
  async enumerate(cfg, secrets),        // → [{ sourceKey, title, kind, size, fingerprint }]  文档清单
  async fetchContent(cfg, secrets, doc) // → { text, meta }  取正文（同步阶段用）
  async retrieve(cfg, secrets, query, topK, filter), // → Hit[]  api 类型必须实现；本地类型走本地索引
};
```

| 类型 | 典型场景 | `source_json` 参数 | 存储策略 |
|---|---|---|---|
| `folder` 本地目录 | 项目文档、规范 wiki、本地笔记 | `{ root, includeGlobs, excludeGlobs, followLinks, maxFileSizeMb }` | **不复制**：只存绝对路径清单 + 指纹。目录迁移后在管理页提供「重新定位」入口 |
| `upload` 上传文件 | 零散 PDF/Word/Excel | `{ relDir }` | **复制**进 `<数据目录>/kb/<kbId>/`，库里存**相对路径**（与现有附件规范一致，整体搬家仍可解析） |
| `api` 外部知识库 | RAGFlow / Dify / 腾讯云知识引擎 / Coze / 自建 OpenAI 兼容检索接口 | `{ provider, endpoint, datasetId, extraJson, timeoutMs, syncMode:'remote' }` | 远端托管，本地只存文档 id 与标题；召回与 updated 由远端负责 |
| `builtin` 内置库 | 把 App 自己的问题库/任务/会议纪要当作知识源 | `{ builtin:'issues' \| 'tasks' \| 'meetings' }` | 直接读 SQLite，随写随查，无需同步远端 |

> `api` 类型刻意做成**适配器表**（`provider → 请求/响应映射函数`），而不是让用户填通用 URL 自己拼协议：
> 主流平台的检索 API 字段名各不相同（dataset vs knowledge_id vs collection），写死在适配器里体验才稳。
> 一期建议内置：`openai_compat`（自定义兜底）、`dify`、`ragflow`；其余由用户用 `openai_compat` 自行适配。

### 4.2 解析能力（按「不造轮子」原则，全部用成熟库）

| 格式 | 依赖 | 备注 |
|---|---|---|
| `.md` `.txt` `.json` | 无（内置） | 直接读文本 |
| `.html` `.htm` | `node-html-parser` | 去掉 script/style 后取正文文本 |
| `.pdf` | `pdf-parse`（首选）或 `unpdf` | 纯 JS/无 native，避开 electron-rebuild；扫描版 PDF（图片）不支持 OCR，记为 `failed` 并给出可读原因 |
| `.docx` | `mammoth`（`extractRawText`） | 保留段落结构便于按标题分块 |
| `.xlsx` `.csv` | `exceljs` / `csv-parse` | 逐行拼成「表头：值」文本，表格类知识很好用 |
| `.pptx` | 二期再评估 | 优先度最低 |

> 打包注意：这些都是纯 JS 包，`build.files` 无需改动（依赖会被 electron-builder 正常收集、打进 asar）；
> 但体积会增加数 MB，落地时要量一下便携版 7z 是否仍 ≤100MB（Gitee 附件上限）。

### 4.3 索引管线（增量、可取消、可重入）

```
enumerate → 指纹比对(size+mtime) → 变化的文件才 fetchContent → content_hash 权威比对
  → 按标题层级/段落滑窗分块(chunkSize 800 / overlap 120，保留 heading_path 前缀)
  → 删旧块 + 写新块 + 同步 kb_chunks_fts
  → [可选] 批量 embedding(16~32/批，失败整批重试 2 次，仍失败标 pending 等下次补偿)
  → 更新 knowledge_bases 计数 / status / last_sync_at
```

- **幂等**：`content_hash` 未变的块不重新 embed，省钱省时（这是复用上一份方案里已验证的思路）。
- **切 embedding 模型 ⇒ 全量重建**：不同模型的向量空间不可混用，检测到 `embed_model` 变化先清空 `kb_vectors` 并提示。
- **可取消**：每批检查一次 `kb_index_state.state === 'canceled'`；界面能随时点停。
- **失败可解释**：单个文件的解析失败写进 `kb_documents.error`，管理面板可「查看失败明细」，不牵连其它文件。
- 触发时机：手动「同步/重建」、应用启动后空闲 10s 补偿（`api` 类型默认不做自动同步）。

### 4.4 管理面板（M1 + M3 的 UI）

侧栏「🧠 知识库」页，卡片形式：

```
┌───────────────────────────────────────────┐
│ 📁 产品手册        [已就绪]   ●启用  ⋯菜单  │
│ 本地目录 · D:\docs\product                │
│ 128 篇文档 · 1,432 块 · 最后同步 2 小时前  │
│ 被 7 个任务引用            [同步] [重建]  │
└───────────────────────────────────────────┘
```

- **新增向导**（`openFormModal` 的 `section` 分区能力足够表达，四步压缩成两屏）：
  1. 选类型（四个大按钮，复用 `type:'choices'` 字段）
  2. 填参数（目录走 `dirDialog`；API 走 Base URL / 数据集 ID / Key，Key 用 `type:'password'`）
  3. 底部 `extraButtons` 里挂「**测试连接**」（走 `health()`，返回字符串即失败原因，与现有 AI 设置完全一致的模式）
  4. 保存前先做一次「试检索」验证召回通不通，通过后再落库并异步建索引
- **卡片操作**：同步 / 重建索引 / 停用启用 / 重命名改色 / 删除（见 §5.5 的引用确认）/ 查看失败明细
- **批量与状态**：索引过程通过 `qa:stream` 同类的事件推送（`kb:progress`）更新进度，不上轮询。

---

## 5. 引用选择交互流程

### 5.1 三个入口（共用同一个组件 `kb-ref-picker.js`）

| 入口 | 触发 | 行为 |
|---|---|---|
| **任务详情抽屉**（主） | 抽屉内「🔗 引用知识库」区（放在「标签」行下方，独立 section） | Tom Select 多选；改动立即落库（走现有 autosave 的 0.7s 节流 + 失败重试条） |
| **新建任务行** | `add-row` 上新增「🔗」小按钮 | 弹出 `openPanelModal` 多选面板；新建任务落库时一起写 `task_kb_refs` |
| **抽屉内的问答区** | 「💬 就此提问」按钮旁的知识库下拉 | 默认继承任务已选引用，允许本次问答临时增减（只影响本次，`qa_sessions.kb_ids` 存本次实际使用的快照） |

组件级细节：

- 底层的 Tom Select 配置**照抄 `reports.js` 里分组多选的写法**：`plugins: ['remove_button','clear_button']`、`dropdownParent:'body'`（避免被抽屉/滚动容器裁掉）。
- 选项渲染：`名称 · 类型徽标 · 文档数`，右侧用色点表示启用状态；**未就绪/已停用的库置灰**并给 `title` 说明原因（避免选了却召回不到，这正是过去踩过的坑）。
- 列表每行只显示一个 `🔗N` 徽章；hover/out-focus 时用 **批量接口 `kb:refsForTasks(ids)`** 一次性取回，禁止逐行 invoke（N+1）。

### 5.2 选择流程

```
① 打开任务详情
② 「引用知识库」区：已选项以 chips 展示（× 移除）
③ 点击输入 → 下拉列出全部启用且 ready 的库（搜索：名称/路径/类型）
④ 选中即 chips 追加 + 右上角「已保存 HH:MM」状态条（复用现有 autosave 视觉语言）
⑤ 引用顺序即融合优先级：chips 支持拖拽（Tom Select `drag_drop` 插件），写进 sort_order
⑥ 关闭抽屉 → disposeSavers() 先 flush 再 dispose（现有纪律，不得跳过）
```

### 5.3 继承与默认值（避免每个任务都手动选一遍）

优先级：**任务显式选择 > 继承自父任务 > 分组默认 `group_kb_defaults` > 全局默认 `kb.defaultKbIds`**。

- 子任务默认继承父任务引用（开关 `kb.inheritSubtaskRefs`，默认开）；一旦子任务被手动改过，就不再被覆盖。
- 分组默认在「编辑分组」弹窗里加一个 `reference` 多选区（同一套 picker）。
- 移动分组 / 复制任务 / 从会议纪要批量入库时，引用一并携带。

### 5.4 多库融合策略（这就是"可同时引用多个"的技术含义）

```
对每个被引用 KB：各自召回 Top(2×k)   ← api 类型走远端 retrieve()，本地类型走 FTS5(+可选向量)
  ↓
跨库 RRF 融合 score = Σ 1/(60 + rank_i)（rank 天然免疫各库分数尺度不一致）
  ↓
叠加轻量加权：ln(1+引用顺序倒数)、文档新鲜度、该库的命中/采纳历史（正反馈）
  ↓
去重（同一 KB 内重叠片段合并、跨 KB 近乎重复取分高者）
  ↓
Top-K（默认 8）进入上下文装配；每个片段携带 kbId/docId/chunkId/标题/路径
```

- **任一被引用库出错不影响整体**：该库降级为「本次未参与」，答案顶部明示哪几个库没召回到（避免"好像少查了但不知道"）。
- **引用顺序不是白做的**：它就是用户对各库可信度的排序表达，RRF 之外用很小的权重参与，不至于让用户排序失效也不至于压过相关性。

### 5.5 边界与保护

- **删除知识库**：先算引用数 → 二次确认显示「被 N 个任务引用，删除后这些任务的🔗徽章会移除」；确认才删，级联清 `task_kb_refs`。推荐默认动作为「**停用**」（保留定义与索引，随时恢复）。
- **挂了 / 路径不存在**：`status='error'` + `last_error`，卡片红字，参与检索时自动跳过并在答案里声明。
- **云端出网**：涉及外部 KB 或云端 embedding 的召回，首次使用时在界面明确提示「该知识库检索会把问题文本发送到外部服务」，开关 `kb.enableCloudEmbedding` 默认关闭。
- **数据目录迁移**：本地目录库记录的是绝对路径，迁移后标记「需重新定位」，管理页一键指向新路径并重跑增量同步（沿用现有 `main/storage.js` 的目录迁移流程）。

---

## 6. 问答与任务系统的集成关系

### 6.1 三种问答作用域

| 入口 | scope | 可用知识库 | 额外上下文 |
|---|---|---|---|
| 侧栏「💬 问答」 | `global` | 用户勾选（默认全部启用 + 内置库） | 无 |
| 任务详情「💬 就此提问」 | `task` | **该任务引用的知识库**（±本次临时调整） | 任务标题/描述/子任务列表/所属分组名 |
| 问题详情「就该问题提问」 | `issue` | 同上逻辑（默认全局） | 问题的现象/环境/根因 |

**任务级问答是主线**：用户不用记住"这个任务该查哪个库"，引用关系已经替他决定好了。

### 6.2 问答主流程（M6）

```
提问（可选：自动带上任务上下文作为查询前缀）
 → ① 查询理解（短查询跳过）：LLM 抽取关键词/同义改写（复用 ai.js 现有风格，失败不影响后续）
 → ② 跨库混合召回（§5.4）
 → ③ 可选重排（LLM 对候选打分；沿用 ai.rankSearchCandidates「只重排不新增」的铁律，默认关）
 → ④ 上下文装配：按 Top-K 顺序截断到模型窗口，片段带 [kbId#chunkId] 锚点
 → ⑤ 流式生成（ai.callLLMStream 新增 SSE 解析，通过 webContents.send('qa:stream') 推给渲染层）
 → ⑥ 渲染：答案 + 引用卡片（库名/文档标题/片段高亮/相似度），点击跳原文
      - 本地文件：shell.openPath（复用现有附件的打开方式）
      - 远端：app.openExternal(url)（现有 app.openExternal 通道已暴露）
 → ⑦ 落库：qa_messages（含 hits 快照）、qa_sessions.kb_ids 快照、更新 last_at
 → ⑧ 反馈：👍/👎 → 回写 kb 命中/采纳计数，作为后续排序权重
```

**降级矩阵（必须做，否则"点了没反应"会重演）**

| 情况 | 表现 |
|---|---|
| 完全没有知识库 | 引导到「🧠 知识库」去接一个，附「新建」按钮 |
| 任务没引用任何库 | 提示「未引用知识库」，提供「立即选择」按钮 + 「用全局库提问」 |
| 库在索引中 | 明确显示「3 个库中有 1 个仍在索引」，其余照样检索 |
| 无 Key | **不调 LLM**，直接返回关键词命中的片段列表（与现有 AI 检索降级一致），并指向「AI 设置」 |
| 有 Key 无 embedding | 走 FTS5 召回，答案顶部标注「未启用向量检索」 |
| 召回为空 | 明说"知识库里没有相关内容"，给出两个出口：「录入为问题」「用全文任务搜索」 |
| 相似度整体偏低 | 仍在答案前置一句「知识库匹配度较低，以下含通用经验」 |
| 超时/失败 | 页面原地显示错误 + 重试按钮（现有润色功能已固化的模式） |

状态可见性：输入框下方常驻**「召回中… → 已找到 N 条 → 生成中… → 完成」**四段进度，
任何一步都不留白屏；长答案用流式输出。

### 6.3 四条闭环链路（这是"集成"的价值所在）

```
① 任务 → 问答     任务上下文自动喂给检索与生成，提问不用复述背景
② 问答 → 任务     选中答案块 → 「派生成子任务」/「追加到描述」
                  - 派生：写入父任务的子任务（复用现有 todos 批量入库逻辑）
                  - 追加：以引用格式追加到 notes（走 autosave，可撤销）
③ 问答 → 沉淀     选中答案 → 「存为问题」（写入 issues 表，status=resolved，
                  solution=答案，source='qa'，links 指回 session），
                  之后它被 issues 内置知识源自动索引，下次别人问同一件事就能命中
④ 反馈 → 排序     👍 提高该 KB/chunk 的采纳计数，👎 记负样本；命中/采纳比参与 §5.4 的加权
```

任务完成时的反向提醒：任务下有 qa 会话且已完成时，任务详情给出「把这次的解法沉淀到问题库」的一次性入口——
**沉淀率是这个产品能不能越用越聪明的关键指标**。

### 6.4 UI 集成点清单

- 任务列表行：🔗N 徽章（hover 显示库名列表，点击打开详情的引用区）
- 任务详情抽屉：新增两个 section ——「🔗 引用知识库」（picker）与「💬 知识问答」
  （最近 3 条问答摘要 + 「打开完整会话」按钮；**局部刷新**该区，禁止整抽屉 `innerHTML` 重建，遵循现有约定）
- 侧栏：🧠 知识库 / 💬 问答 / 🧩 问题库 三项（`ui.js` 的 `render()` 分发 + `TASK_VIEWS` 判定）
- 导出：问答结果支持导出 Markdown / Word（复用 `docx.js`），与报告导出一致的手感

---

## 7. 落地路线

| 期 | 内容 | 复杂度 | 交付物 / 验证 |
|---|---|---|---|
| **P1 骨架 + 本地接入** | v10 建表、知识库 CRUD、`folder`/`upload` 适配器、解析器、FTS5、管理面板 | 中 | 能接入一个本地目录并搜到内容；`npm run test:db` 断言表结构/FTS/增量哈希 |
| **P2 任务多选引用** | `task_kb_refs`、picker 组件、抽屉区与列表徽章、继承与分组默认、批量接口、级联 | 低 | 任务可选多个库、徽章正确、删除库有引用确认；`npm run smoke` UI 回归 |
| **P3 问答引擎** | `qa.js`、三种作用域、跨库 RRF、流式（SSE + 事件白名单）、引用卡片、降级矩阵、会话持久化 | 高 | 任务级问答可用且必带引用；无 Key / 空库 / 单库失败三条降级路径全部可复现验证 |
| **P4 语义增强 + 外部库** | embedding 配置与本地/云端开关、`api` 类型适配器（openai_compat/dify/ragflow）、全量重建策略 | 中 | 向量召回可用；切模型触发重建；`api` 库能"测试连接 + 试检索"通过 |
| **P5 闭环与优化** | 答案→子任务/描述/问题条目的三条落地动作、反馈回写权重、索引评估面板、失败重试看板 | 中 | 沉淀链路完整；导出带走 qa 会话；smoke 覆盖三条动作 |

纪律：**每期都要同时过 `npm run test:db` 与 `npm run smoke`**，与现有保持一致。

---

## 8. 主要风险与权衡

| 风险 | 应对 |
|---|---|
| 引入 native 插件（sqlite-vec）会破坏 `package.json` 里 `npmRebuild:false` 的前提，需要 electron-rebuild + VS 工具 | **一期明确不用**：本地检索用 FTS5(trigram)，向量用 BLOB + 内存余弦；块数 > 5000 再评估，且把切换封装在 `kb-index.js` 内部，上层接口不变 |
| better-sqlite3 是否启用 FTS5/trigram 需实测 | 冒烟脚本里加一条探针：创建临时 fts5 虚表并 trigram 分词，失败则自动降级为 `LIKE` 检索并在 UI 标注 |
| 中文分词与短查询质量 | trigram 对子串友好；向量路为主要召回通道；关键词路兜底精确词（报错码/类名/命令） |
| 外部知识库凭据泄露 | 一律走 `crypto.js` 加密入 `settings`，渲染层只拿 `hasKey`；导出备份不含凭据 |
| 解析依赖体积膨胀，可能撞 Gitee 附件 100MB 上限 | 只引纯 JS 包；每期打包后量一次便携版 7z 体积，超了就砍 `.pptx`/`.xlsx` 这类低优先级格式 |
| 隐私出网（云端 embedding / 外部 KB） | 默认本地优先、云端开关默认关；首次出网 UI 明示 |
| 抽屉里的 Tom Select 实例泄漏 / 自动保存器写错任务 | 抽屉重绘前 `picker.destroy()`；`disposeSavers()` 时序严格遵守现有约定（记忆里已固化的那条） |
| 本地目录库依赖绝对路径，换机即失效 | 管理页「重新定位」入口 + `status='error'` 明确提示，不做静默失效 |

---

## 9. 待确认决策点

1. **embedding 优先本地还是云端**（决定 P4 的隐私模型、性能与成本口径）。
2. **外部知识库先支持哪几家**（建议 `openai_compat` 打底 + Dify + RAGFlow 两家，其余走自定义兜底）。
3. **问题库是否复用现有分组树**，还是独立一套「知识分类」（影响 issues 表与侧栏结构）。
4. **问答历史保留策略**：全留存、按会话数上限、还是按天数滚动清理。
5. **PDF 是否需要 OCR**（扫描件场景），需要就得引入额外依赖与体积，建议一期不支持。
6. **`task_kb_refs` 的读写是否并入 `db.updateTask()` 的 patch 体系**：
   推荐**独立接口** `tasks:setKbRefs(taskId, kbIds)`，不要把 `updateTask` 的字段白名单越加越长。
