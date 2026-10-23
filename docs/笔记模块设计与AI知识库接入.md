# 笔记模块设计（Markdown 编辑 / 知识库沉淀 / 任务关联）

> 适用版本：v1.4.0（数据库迁移 v9 + v10）
> 目标：在既有 TODO 桌面端里新增「笔记」能力——Markdown 编辑与实时预览、按目录 / 标签沉淀为知识库、
> 作为 AI 提问的检索来源，并与任务形成**多对多**关联。代码风格与交互沿用既有任务 / 会议纪要模块。

---

## 0. 一句话概览

| 层 | 落点 |
|---|---|
| 数据 | `main/db.js` 迁移 v9（笔记）/ v10（知识库），SQLite + FTS5 |
| 索引 / 检索 | `main/knowledge.js`（分块、召回、AI 问答组装） |
| 接口 | `main/ipc.js` 的 `notes:*` / `noteFolders:*` / `noteTags:*` / `taskNotes:*` / `kb:*` |
| 前端 | `renderer/js/notes.js`（视图）、`note-picker.js`（任务侧选择器）、`markdown-lib.js`（渲染） |
| 编辑器 | EasyMDE（编辑语义）+ markdown-it（渲染），均 vendor 进仓库，离线可用 |

---

## 1. 页面交互流程

### 1.1 笔记视图（侧栏「📝 笔记」）

```
工具栏：＋ 新建笔记 | 搜索框 | 🗄 归档 | 🗑 回收站 | 🧠 知识库问答 | 计数
   ↓
三栏：目录 / 标签（左） → 笔记列表（中） → 编辑器（右）
   ↓
编辑器：标题输入 + 目录下拉 + 标签输入 + 模式（编辑 / 分栏 / 预览）+ 置顶 / 归档 / 删除
        EasyMDE 工具栏（标题、列表、代码块、链接、图片、表格…）+ markdown-it 实时预览
        → 输入停止 700ms 自动落库（复用既有 autosave.js 的状态机：未保存 / 保存中 / 已保存）
   ↓
底部：被哪些任务引用（可跳转任务详情 / 取消关联）
```

- 目录与分组同构：支持无限层级，同级不允许重名（校验在应用层，**不加数据库唯一索引**，理由同 groups）。
- 标签在输入时按逗号分隔解析，不存在的自动创建（与任务标签行为一致）。
- 归档 = 折叠出主列表（「🗄 归档」切换查看），**归档笔记仍可被检索、可被引用**。
- 删除走两级：移入回收站（可恢复）/ 彻底删除（不可恢复，见 §4）。

### 1.2 任务 ↔ 笔记

| 入口 | 交互 |
|---|---|
| 任务详情 → 「关联笔记 → ＋ 关联笔记」 | 打开 `note-picker.js` 弹窗：搜索 + 多选 + 「＋ 新建并关联」，保存时**覆盖式写入** |
| 任务详情 → 列表项「查看」 | 切到笔记视图并选中该笔记（`focusNote`） |
| 任务详情 → 列表项「✕」 | 取消关联（**只摘引用，不删笔记**） |
| 任务列表 | 行 meta 显示 `📝 N` 徽标（一次批量查询 `taskNotes:counts`，无 N+1） |
| 笔记编辑器底部 | 反向展示引用它的任务，可直接打开任务或取消关联 |

### 1.3 知识库问答

```
笔记视图 → 🧠 知识库问答 → 输入问题 → kb:ask
   → 主进程：FTS5 召回 TopK 分块 → 组装 [1][2] 编号上下文 → 对话模型作答
   → 回答下方列出引用来源，点击跳转对应笔记
   → 未配置 AI：降级为「只展示召回片段」，功能不中断
```

---

## 2. 数据模型

### 2.1 迁移 v9：笔记模块

```sql
CREATE TABLE note_folders (          -- 笔记目录（自引用，与 groups 同构）
  id INTEGER PK, name TEXT NOT NULL, parent_id INTEGER, color TEXT DEFAULT '#4f7cff',
  sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT,
  FOREIGN KEY (parent_id) REFERENCES note_folders(id) ON DELETE SET NULL);

CREATE TABLE notes (
  id           INTEGER PK,
  folder_id    INTEGER,               -- 目录（NULL = 未分类）
  title        TEXT    DEFAULT '',
  content_md   TEXT    DEFAULT '',    -- Markdown 正文（唯一权威来源）
  excerpt      TEXT    DEFAULT '',    -- 派生：纯文本摘要（列表展示）
  pinned       INTEGER DEFAULT 0,     -- 置顶
  archived     INTEGER DEFAULT 0,     -- 归档（仍可检索 / 引用）
  deleted_at   TEXT,                  -- 软删除（回收站）；非空即不参与检索
  word_count   INTEGER DEFAULT 0,     -- 派生：中英混排字数
  content_hash TEXT    DEFAULT '',    -- 派生：sha1(content)，增量索引判定
  source       TEXT    DEFAULT 'manual', -- manual | meeting | ai | import（预留沉淀来源）
  source_ref   TEXT    DEFAULT '',
  sort_order   INTEGER DEFAULT 0,
  created_at / updated_at TEXT);

CREATE TABLE note_tags (id PK, name TEXT UNIQUE, color TEXT);
CREATE TABLE note_tag_map (note_id, tag_id, PRIMARY KEY(note_id, tag_id));

CREATE TABLE task_notes (             -- 任务 ↔ 笔记：多对多
  task_id INTEGER, note_id INTEGER, created_at TEXT,
  PRIMARY KEY (task_id, note_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE);

-- 全文索引：external content（正文只存一份）+ 触发器同步
CREATE VIRTUAL TABLE notes_fts USING fts5(title, content,
  content='notes', content_rowid='id', tokenize='trigram');
```

**字段设计要点**

- `content_md` 是唯一权威来源，`excerpt / word_count / content_hash` 全部派生，改正文时重算；
  只改标题 / 目录时**不重算** `content_hash`，避免无谓重建索引。
- `deleted_at` 而非布尔：回收站需要保留删除时间，且软删除时**保留 task_notes 关联**（恢复即自动复原）。
- `note_tags` 与任务 `tags` **分开**：两者语义与颜色体系不同，混用会让「标签筛选」互相污染。
- 全文检索用 `trigram` 分词：中文无需外部分词器即可命中子串；查询词 < 3 字符时应用层回退 `LIKE`。

### 2.2 迁移 v10：知识库沉淀

表结构与 `docs/AI知识库问答与任务引用集成方案.md` §3 的 v10 **完全对齐**（同名同字段），
本模块先落地「内置笔记库」所需的部分，后续接入 folder / upload / api 数据源时直接扩展：

```sql
knowledge_bases (id, name, type, icon, color, source_json, enabled, status,
                 doc_count, chunk_count, embed_model, embed_dim, sort_order, ...)
kb_documents    (id, kb_id, source_key, title, kind, size, fingerprint,
                 content_hash, status, error, ...)      -- 笔记：source_key = 'note:<id>'
kb_chunks       (id, kb_id, doc_id, ord, kind, heading_path, content,
                 content_hash, token_est, ...)          -- 按 Markdown 标题切块
kb_chunks_fts   (content) USING fts5(content='kb_chunks', tokenize='trigram')
kb_vectors      (chunk_id, dim, model, vec)             -- 预留（一期不写入）
```

内置库固定 `id = 1`（`type = 'notes'`，名称「笔记知识库」），迁移里 `INSERT OR IGNORE` 播种。

**分层关系**：`notes → kb_documents（1:1）→ kb_chunks（1:N）→ FTS5`
分块策略：按 ATX 标题切章节，超长章节按段落滑窗（800 字 / 重叠 120），每块带 `heading_path`（如「灰度发布 › 第一批」），召回时拼到上下文里提升命中率。

### 2.3 索引与检索的生命周期

| 事件 | 动作 |
|---|---|
| 新建 / 更新笔记 | 主进程 IPC 里同步 `knowledge.indexNote(id)`（保存即沉淀） |
| 移入回收站 | `knowledge.removeNote(id)` → 从索引摘除（内容还在，恢复即可重建） |
| 恢复 | `knowledge.indexNote(id)` 重建 |
| 彻底删除 | 先删 `task_notes` 再删笔记，分块随 `kb_documents` 外键级联清除 |
| 导入备份 | `importData()` 后 `knowledge.indexAll()` 全量重建 |

---

## 3. 核心接口定义

### 3.1 IPC 通道（`main/ipc.js`，全部经 `withDb` / `guard` 包装，异常转成可读文案）

| 通道 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `notes:list` | `{folderId, includeSubfolders, archived, tagId, keyword, limit, sort}` | 笔记数组（不含正文） | `folderId=0` 表示未分类 |
| `notes:get` | id | 笔记（含 `content_md` / `tags` / `ref_count`） | |
| `notes:create` | `{title, contentMd, folderId, tagIds, source, sourceRef}` | 笔记 | 写库后自动建索引 |
| `notes:update` | `(id, patch)` | 笔记 | 白名单字段；改正文重算派生列 + 重建索引 |
| `notes:archive` / `notes:pin` | `(id, bool)` | 笔记 | |
| `notes:trash` | id | `{note, refs}` | 软删除，`refs` = 被引用任务数 |
| `notes:restore` | id | 笔记 | 恢复 + 重建索引 |
| `notes:purge` | id | `{noteId, unlinkedTasks}` | 彻底删除，返回被解除引用的任务 id |
| `notes:trashList` / `notes:emptyTrash` | — | 列表 / `{removed}` | |
| `notes:search` | `(keyword, {limit, archived, deleted})` | 笔记数组 + `score` / `highlight` | |
| `noteFolders:list/create/update/delete` | — | 目录 | 同级重名 / 成环由应用层拒绝 |
| `noteTags:list/create/delete` | — | 标签 | |
| `taskNotes:list` | taskId | 笔记数组 | |
| `taskNotes:set` | `{taskId, noteIds}` | 笔记数组 | 覆盖式写入（选择器保存用） |
| `taskNotes:link` / `unlink` | `{taskId, noteId}` | 笔记数组 | |
| `taskNotes:byNote` | noteId | 任务数组 | 删除前的影响面提示 |
| `taskNotes:counts` | taskIds | `{taskId: count}` | 列表徽标批量取 |
| `kb:list` / `kb:stats` | — / id | 知识库 / 统计 | |
| `kb:reindex` / `kb:indexNote` | — / id | `{total, done, chunks}` | 重建索引 |
| `kb:ask` | `{question, topK, noteIds}` | `{answer, hits, degraded, reason}` | AI 问答（无 Key 降级） |
| `kb:retrieve` | `{query, topK, noteIds}` | 命中分块数组 | 只召回不调模型 |

渲染层统一通过 `preload/preload.js` 暴露的 `api.notes.*` / `api.noteFolders.*` / `api.noteTags.*`
/ `api.taskNotes.*` / `api.kb.*` 调用；`preload` 的 `call()` 会把主进程返回的 `{__error}` 转成 throw，
界面上一个 `try/catch` 即可拿到可读错误（沿用既有约定）。

### 3.2 供 AI 检索调用的接入方式

```js
// 主进程内（例如以后接进 search-assist / 报告生成）
const knowledge = require('./knowledge');
const { chatConfig } = require('./ai');   // 或按 ipc.js 里的 getAiConfig()

const { answer, hits, degraded } = await knowledge.answer({
  question: '灰度发布的第一批比例是多少？',
  cfg: chatConfig(),       // { baseUrl, apiKey, model }
  topK: 8,                 // 默认 8
  noteIds: null,           // 传数组可限定在某几篇笔记内检索（任务作用域问答）
});
// hits: [{ chunkId, noteId, title, headingPath, content, score }]
// degraded=true 时 reason ∈ {'no-hit','no-ai','AI 调用失败'}，界面按 reason 给不同提示
```

渲染层：`window.api.kb.ask({ question, topK })` / `window.api.kb.retrieve({ query, topK })`。
上下文拼装（`buildContext`）带 `[n]` 编号，系统提示要求模型**逐条标注出处**、**不得编造**，
因此答案里的 `[1]` 可直接映射到 `hits[0]`，界面点击即跳到对应笔记。

---

## 4. 删除笔记的影响与处理策略

删除前先展示影响面（引用它的任务列表），再让用户二选一：

| 选项 | 行为 | 任务引用 | 可恢复 | 知识库索引 |
|---|---|---|---|---|
| **移入回收站**（默认） | `deleted_at = now` | **保留**（恢复后自动复原） | ✅ | 立即摘除，不参与检索 |
| **彻底删除** | 先 `DELETE FROM task_notes`，再删正文 | **解除**（返回被解除的任务 id 用于提示） | ❌ | 随文档级联清除 |

- 任务侧永远保留「取消关联」入口：只摘引用、不动笔记。
- 删除任务时 `task_notes` 随外键 `ON DELETE CASCADE` 清除，笔记本身不受影响。
- 删除目录：子目录提升到上级，目录内**笔记移到上级而不是被删**。

---

## 5. 依赖与打包

| 依赖 | 版本 | 用途 | 引入方式 |
|---|---|---|---|
| `markdown-it` | ^14.3.3 | Markdown → HTML（表格 / 代码块 / 链接 / 图片） | `dependencies` 登记 + `renderer/vendor/markdown-it/markdown-it.min.js` 随仓库 vendor |
| `easymde` | ^2.21.0 | 编辑器（工具栏、快捷键、列表续行、撤销栈、分栏预览） | 同上，`renderer/vendor/easymde/easymde.min.{js,css}` |

约定（与 flatpickr / tom-select 一致）：**构建产物 vendor 进仓库，运行时不联网、不依赖 node_modules 路径**。

- 关闭 `autoDownloadFontAwesome`（离线运行），工具栏图标用 CSS `::after` 兜底文字/符号。
- `html: false` —— 关闭原始 HTML 透传，防 XSS；外链统一 `target="_blank" rel="noopener"`。
- CSP 放开 `img-src https:`（笔记里外链图片要能显示），`script-src` 仍为 `'self'`。

---

## 6. 数据迁移方案

1. **自动迁移**：`main/db.js` 的 `MIGRATIONS` 追加 v9、v10；启动时按 `user_version` 顺序执行，
   每个迁移包在事务里跑（失败即回滚，不会留下半套表）。
2. **幂等**：建表全部 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`；
   内置知识库用 `INSERT OR IGNORE`（id=1），重复启动不会产生第二份。
3. **存量数据**：新表对旧库只是新增，不动 `tasks / groups` 任何列，老数据零影响。
4. **备份兼容**：`schemaVersion` 8 → **10**；导出新增 `note_folders / notes / note_tags /
   note_tag_map / task_notes / knowledge_bases`；**不导出** `kb_documents / kb_chunks / kb_vectors`
   （可由正文重建），与「备份不含 API Key」同一思路。
5. **导入**：事务内清空 → 逐个写入（目录两级写：先不带 `parent_id` 再回填，避免外键顺序问题）；
   父子缺失降级为顶层；`task_notes` 只写两端都存在的关联；结束后 `ensureNotesKb()` +
   `knowledge.indexAll()` 重建索引。
6. **回滚**：新功能独立成表，卸载（回到 v1.3.x）时旧版本会忽略这些表，不会报错。

---

## 7. 验证

- 数据层：`npm run test:db`（`scripts/smoke-db.js` 新增 [15]~[18] 四组用例：目录/标签/检索、
  任务关联、知识库与删除策略、备份往返）。当前 **173 项全部通过**。
- 界面：CDP 驱动真实窗口验证（首屏依赖加载 → 笔记视图 → 新建 + EasyMDE 编辑 + 防抖落库 →
  实时预览（标题/表格）→ 全文检索 + 知识库召回 → 任务关联计数 / 列表徽标 / 详情区块 →
  删除弹窗影响面 → 知识库问答降级），无 JS 异常。

---

## 8. 待确认的技术假设（请逐条确认或纠正）

1. **编辑器选型**：用 EasyMDE（CodeMirror 5）而非自研 textarea。代价是 vendor 体积 +327KB（JS）
   +13KB（CSS）。若更在意体积，可换成「自研工具栏 + 原生 textarea + 右侧预览」，但会失去
   列表续行、撤销栈、快捷键等编辑语义。
2. **预览刷新由应用层兜底**：EasyMDE 只在「分栏」模式自动随输入重渲，全屏预览不会。
   因此 `applyMode()` 与 `change` 事件后会主动重渲预览面板（已实现，见 `notes.js` 的 `refreshPreview`）。
3. **检索只用关键词（FTS5 trigram），不引入向量/embedding**。好处：零外部依赖、离线可用、
   结果可解释；代价：对「意思相关但字面不同」的查询召回有限。若需要语义检索，
   `kb_vectors` 与 `knowledge_bases.embed_*` 字段已预留，二期接 embedding 即可。
4. **知识库一期只有「内置笔记库」一个**（id=1）。外部数据源（本地目录 / 上传文件 / API）
   按同一套 `kb_documents / kb_chunks` 扩展，接口不变。
5. **归档笔记仍参与检索与引用**（归档只是收起，不是封存）。若你希望归档后退出知识库，改一行即可。
6. **彻底删除是硬删除**（先解引用再删，不可恢复）。若需要「全站回收站统一保留 N 天」，
   可把 `notes.deleted_at` 的清理策略改成定时任务。
7. **笔记正文不存图片文件本体**，图片走 Markdown 外链或 data URI（与任务描述一致）。
   若需要「粘贴图片自动落盘到 attachments 并回写 `![](相对路径)`」，可复用 `main/attachments.js`。
8. **AI 问答不落库**：`kb:ask` 的问答暂不写 `qa_sessions / qa_messages`（方案文档里有表设计）。
   需要「问答历史」时再补，接口与存储都已留好位置。
9. **CSP 放开 `img-src https:`** 以便显示外链图片；若要求严格离线渲染，可收回该改动，
   笔记里的外链图片将不显示（正文与检索不受影响）。
