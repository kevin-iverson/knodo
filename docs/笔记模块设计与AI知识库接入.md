# 笔记模块设计（Markdown 编辑 / 知识库沉淀 / 任务关联）

> 适用版本：v1.5.0（数据库迁移 v9 + v10 + v11）
> 目标：在既有 TODO 桌面端里新增「笔记」能力——Markdown 编辑与实时预览、按目录 / 标签沉淀为知识库、
> 作为 AI 提问的检索来源，并与任务形成**多对多**关联。代码风格与交互沿用既有任务 / 会议纪要模块。

---

## 0. 一句话概览

| 层 | 落点 |
|---|---|
| 数据 | `main/db.js` 迁移 v9（笔记）/ v10（知识库）/ v11（笔记附件），SQLite + FTS5 |
| 索引 / 检索 | `main/knowledge.js`（分块、**查询改写 + 多路召回 + RRF 融合 + AI 重排**、AI 问答组装） |
| 接口 | `main/ipc.js` 的 `notes:*` / `noteAttachments:*` / `noteFolders:*` / `noteTags:*` / `taskNotes:*` / `kb:*` |
| 前端 | `renderer/js/notes.js`（列表视图 + 弹窗编辑器）、`note-picker.js`（任务侧选择器）、`markdown-lib.js`（渲染） |
| 编辑器 | EasyMDE（编辑语义）+ markdown-it（渲染），均 vendor 进仓库，离线可用 |
| 图片 | 复用 `main/attachments.js`，落盘到 `attachments/note-<id>/`，正文只存 `todo-media://` 链接 |

---

## 1. 页面交互流程

### 1.1 笔记视图（侧栏「📝 笔记」）

```
工具栏：＋ 新建笔记 | 搜索框 | 🗄 归档夹 | 🗑 回收站 | 🧠 知识库问答 | 📥 导入 | 计数
   ↓
两栏：目录 / 标签（左） → 笔记列表（右，点击任意行 → 弹出编辑窗口）
   ↓
编辑窗口（.modal-note-editor，不覆盖列表页）：
   标题输入 + 目录下拉 + 标签输入 + 模式（编辑 / 分栏 / 预览）
   EasyMDE 工具栏（标题、列表、代码块、链接、图片、表格…）+ markdown-it 实时预览
   （代码块按语言着色 + 语言标签 + 复制；```mermaid 渲染成矢量图）
   → 输入停止 700ms 自动落库（复用既有 autosave.js 的状态机：未保存 / 保存中 / 已保存）
   → 粘贴 / 拖拽 / 工具栏选文件 → 图片落盘并插入 ![](todo-media://…)
   → 窗口底部：图片条（打开 / 复制引用 / 删除）+ 被哪些任务引用（可跳转 / 取消关联）
   → 底部按钮：完成（保存并关闭）｜ 置顶 / 归档 / 删除
```

- **为什么改成弹窗**：笔记经常从任务详情跳转过来、或连续翻阅多篇。内嵌编辑会让列表的筛选条件与
  滚动位置在每次切换笔记时被冲掉；改成弹窗后「列表 = 浏览，弹窗 = 编辑」职责分离，关掉就回到原处。
  关闭（含 Esc / 点遮罩）前一定 `flush` 一次自动保存器，避免最后一次输入丢失。
- 目录与分组同构：支持无限层级，同级不允许重名（校验在应用层，**不加数据库唯一索引**，理由同 groups）。
- 标签在输入时按逗号分隔解析，不存在的自动创建（与任务标签行为一致）。
- 归档 = 折叠出主列表（「🗄 归档夹」切换查看），**归档笔记仍可被检索、可被引用**（已验证）。
- 删除走两级：移入回收站（可恢复）/ 彻底删除（不可恢复，见 §4）；回收站页提供「恢复 / 彻底删除 / 清空回收站」。

### 1.2 任务 ↔ 笔记

| 入口 | 交互 |
|---|---|
| 任务详情 → 「关联笔记 → ＋ 关联笔记」 | 打开 `note-picker.js` 弹窗：搜索 + 多选 + 「＋ 新建并关联」，保存时**覆盖式写入** |
| 任务详情 → 列表项「查看」 | 切到笔记视图并**弹出该笔记的编辑窗口**（`focusNote`） |
| 任务详情 → 列表项「✕」 | 取消关联（**只摘引用，不删笔记**） |
| 任务列表 | 行 meta 显示 `📝 N` 徽标（一次批量查询 `taskNotes:counts`，无 N+1） |
| 笔记编辑窗口底部 | 反向展示引用它的任务，可直接打开任务或取消关联 |

### 1.3 知识库问答（智能检索）

```
笔记视图 → 🧠 知识库问答 → 输入问题 → kb:ask
   → ① 查询改写：配了 AI 就让模型把口语问题改写成 3-5 个检索词（同义 / 拆分），失败则原样
   → ② 多路召回：每个查询词分别走「分块 FTS5(trigram)」+「笔记级命中 → 取它的块」，短词回退 LIKE
   → ③ RRF 融合：按名次融合（不受各路分数量纲影响）+ 字面覆盖率 + 标题 / 路径命中加权
   → ④ AI 重排：候选 ≥3 且配了 AI 时让模型给相关度排序；失败 / 超时沿用融合分
   → ⑤ 组装 [1][2] 编号上下文 → 对话模型作答，回答下方列出引用来源（带命中方式），点击打开该笔记
   → 未配置 AI：降级为「只展示本地多路召回片段」，功能不中断
```

### 1.4 图片粘贴（复用 attachments.js）

```
粘贴截图 / 拖拽图片 / 工具栏「🖼」选文件
   → 渲染层没有 fs 权限 → 把 File 读成 dataURL，走 noteAttachments:pasteImage / addPaths / pick
   → 主进程 attachments.importDataUrl / importInto('note', id) 落盘到 attachments/note-<id>/<id>_<name>
   → notes.attachments 只存元数据 JSON（相对路径），返回 todo-media:///note-<id>/<id>_<name>
   → 渲染层把 ![name](todo-media://…) 插到光标处，图片条实时显示；预览里直接渲染
```

- `todo-media` 是主进程注册的自定义协议（`protocol.registerFileProtocol`），只解析 attachments
  根目录下的相对路径，越界直接返回 not found —— 比放开 `file://` 安全，也绕开了 CSP 对 file 的限制。
- 彻底删除笔记时连同 `note-<id>` 目录一起清掉（移入回收站不清理，恢复后图片还在）。

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

### 2.3 迁移 v11：笔记附件（图片）

```sql
ALTER TABLE notes ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
-- 存 [{id, name, size, mime, path, added_at}]，path 是相对 attachments/ 的路径
--   形如 'note-12/5f3c1a9e2b_截图.png'
```

- 文件本体与任务附件共用一套落盘规则（`main/attachments.js`），只是宿主目录从 `task-<id>` 换成
  `note-<id>`；`importFile(taskId, src)` 的签名保持不变，新增 `importInto(kind, id, src)` /
  `importDataUrl(kind, id, dataUrl, name)` / `removeOwnerDir(kind, id)`。
- 备份：附件元数据随 `notes` 表一起导出（`SELECT *`），`schemaVersion` 升到 11，导入时按同一列回写；
  分块仍是派生数据不导出。
- 图片预览协议见 §5.2。

### 2.4 索引与检索的生命周期

| 事件 | 动作 |
|---|---|
| 新建 / 更新笔记 | 主进程 IPC 里同步 `knowledge.indexNote(id)`（保存即沉淀） |
| 移入回收站 | `knowledge.removeNote(id)` → 从索引摘除（内容还在，恢复即可重建） |
| 恢复 | `knowledge.indexNote(id)` 重建 |
| 彻底删除 | 先删 `task_notes` 再删笔记，分块随 `kb_documents` 外键级联清除，图片目录一并删除 |
| 导入备份 | `importData()` 后 `knowledge.indexAll()` 全量重建 |

### 2.5 智能检索管线（`main/knowledge.js`）

| 阶段 | 实现 | 失败降级 |
|---|---|---|
| ① 查询理解 | `expandQuery(q, cfg)`：让模型输出 3-5 个同义 / 拆分后的检索词（JSON 数组，12s 超时） | 只用原问题 |
| ② 多路召回 | 每个检索词分别跑 **分块 FTS5**（trigram，`<3` 字自动 LIKE）+ **笔记级**（`searchNotes` 命中笔记后取它的前 2 块） | 任一路失败不影响其它路 |
| ③ 融合 | RRF（Reciprocal Rank Fusion，`1/(60+rank)`）按名次融合 + 字面覆盖率（二元组）+ 标题 / 路径命中加权 | 纯 SQL 计算，无外部依赖 |
| ④ AI 重排 | `rerankWithAI`：候选 ≥3 且配了 AI 时让模型输出相关度排序（20s 超时） | 沿用融合分 |
| ⑤ 组装作答 | `buildContext` 给 `[n]` 编号上下文 → 模型按编号引用作答 | 无 Key / 调用失败 → 只返回召回片段 |

命中结果带 `matchedBy`（`fts` / `note` / `like`，多路命中用 `+` 连）与 `coverage`，界面在引用来源上
直接标出「命中：全文 + 笔记级」，便于判断为什么这篇被召回。

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
| `notes:importMd` | `(kind, {folderId, tags, titleFrom, importImages})` | `{imported, skipped, notes, images}` | 导入本地 .md；`kind='files'` 选文件（多选）/ `'dir'` 递归扫描目录 |
| `noteAttachments:list` | noteId | 附件数组 | 图片条用 |
| `noteAttachments:pasteImage` | `(noteId, dataUrl, name)` | `{entry, attachments, url}` | 粘贴截图落盘，`url` 可直接写进 Markdown |
| `noteAttachments:pick` | noteId | `{entries, attachments, failed}` | 系统文件选择框（图片优先） |
| `noteAttachments:addPaths` | `(noteId, paths)` | 同上 | 拖拽 / 文件管理器拖入 |
| `noteAttachments:remove` / `open` / `reveal` / `saveAs` | `(noteId, attId)` | `{attachments}` / `{ok}` | 与任务附件同构 |
| `noteFolders:list/create/update/delete` | — | 目录 | 同级重名 / 成环由应用层拒绝 |
| `noteTags:list/create/delete` | — | 标签 | |
| `taskNotes:list` | taskId | 笔记数组 | |
| `taskNotes:set` | `{taskId, noteIds}` | 笔记数组 | 覆盖式写入（选择器保存用） |
| `taskNotes:link` / `unlink` | `{taskId, noteId}` | 笔记数组 | |
| `taskNotes:byNote` | noteId | 任务数组 | 删除前的影响面提示 |
| `taskNotes:counts` | taskIds | `{taskId: count}` | 列表徽标批量取 |
| `kb:list` / `kb:stats` | — / id | 知识库 / 统计 | |
| `kb:reindex` / `kb:indexNote` | — / id | `{total, done, chunks}` | 重建索引 |
| `kb:ask` | `{question, topK, noteIds}` | `{answer, hits, degraded, reason, meta}` | AI 问答（无 Key 降级）；`meta.reranked` 表示走了 AI 重排 |
| `kb:retrieve` | `{query, topK, noteIds}` | 命中分块数组（含 `matchedBy` / `coverage`） | 只召回不调模型 |

> `knowledge.retrieve()` 现在是 **async**（查询改写可能要等模型），调用方必须 `await`。

渲染层统一通过 `preload/preload.js` 暴露的 `api.notes.*` / `api.noteAttachments.*` / `api.noteFolders.*`
/ `api.noteTags.*` / `api.taskNotes.*` / `api.kb.*` 调用；`preload` 的 `call()` 会把主进程返回的
`{__error}` 转成 throw，界面上一个 `try/catch` 即可拿到可读错误（沿用既有约定）。

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
| **彻底删除** | 先 `DELETE FROM task_notes`，再删正文与图片目录 | **解除**（返回被解除的任务 id 用于提示） | ❌ | 随文档级联清除 |

回收站页（工具栏「🗑 回收站」）可逐篇恢复 / 彻底删除，也可「清空回收站」（需输入「清空」确认）。

- 任务侧永远保留「取消关联」入口：只摘引用、不动笔记。
- 删除任务时 `task_notes` 随外键 `ON DELETE CASCADE` 清除，笔记本身不受影响。
- 删除目录：子目录提升到上级，目录内**笔记移到上级而不是被删**。

---

## 5. 依赖与打包

| 依赖 | 版本 | 用途 | 引入方式 |
|---|---|---|---|
| `markdown-it` | ^14.3.3 | Markdown → HTML（表格 / 代码块 / 链接 / 图片） | `dependencies` 登记 + `renderer/vendor/markdown-it/markdown-it.min.js` 随仓库 vendor |
| `easymde` | ^2.21.0 | 编辑器（工具栏、快捷键、列表续行、撤销栈、分栏预览） | 同上，`renderer/vendor/easymde/easymde.min.{js,css}` |
| `highlight.js` | ^11.12.0 | 代码块按语言着色（笔记预览 / AI 答案） | `npm run build:tools` 打成 IIFE → `renderer/vendor/highlight/highlight.min.js`，挂 `window.hljs`，随页面同步加载 |
| `mermaid` | ^12.2.0 | ```mermaid 代码块 → SVG 图表（仅流程图 / 时序图 / 类图 / 甘特图 / 饼图） | `npm run build:tools` 打成 ESM → `renderer/vendor/mermaid/mermaid.mjs`，渲染层按需 `import()`；构建期把其余图表模块置空（5.0MB → 3.6MB） |

> **为什么 highlight.js 和 mermaid 的加载方式不同**：markdown-it 的高亮钩子是**同步**的，
> 渲染正文时 hljs 必须已就绪，所以走经典 `<script>`；mermaid 包有数 MB 且多数笔记用不到，
> 等检测到正文里真出现 ```mermaid 时再动态 import，不为不需要的笔记付解析成本。
> 图表类型只保留流程图 / 时序图 / 类图 / 甘特图 / 饼图：mermaid 里其余 30 多种图（思维导图、看板、架构图、C4…）
> 在 `scripts/build-tools.js` 里被替换成空桩，渲染层有一份同样的白名单（`MERMAID_TYPES`），两边必须一起改。
> 注意 **elkjs 不能裁**：流程图 / 类图的默认布局就是它，裁掉后图会叠成一团。

约定（与 flatpickr / tom-select 一致）：**构建产物 vendor 进仓库，运行时不联网、不依赖 node_modules 路径**。

- 关闭 `autoDownloadFontAwesome`（离线运行），工具栏图标用 CSS `::after` 兜底文字/符号。
- `html: false` —— 关闭原始 HTML 透传，防 XSS；外链统一 `target="_blank" rel="noopener"`。
- CSP 放开 `img-src https:`（外链图片）与 `todo-media:`（本地图片），`script-src` 仍为 `'self'`。

### 5.2 `todo-media://` 自定义协议

```js
// main/main.js（app ready 前注册，ready 后挂实现）
protocol.registerSchemesAsPrivileged([{ scheme: 'todo-media', privileges: { standard: true, secure: true } }]);
protocol.registerFileProtocol('todo-media', (req, cb) => {
  const u = new URL(req.url);                                  // todo-media:///note-12/5f3c_截图.png
  const abs = attachments.resolveMedia(`${u.host}${u.pathname}`); // 越界返回 null
  if (!abs || !fs.existsSync(abs)) cb({ error: -6 }); else cb({ path: abs });
});
```

为什么不用 `file://`：受 CSP 与 `allowFileAccessFromFiles` 限制，且等于放开整盘；自定义协议只认
attachments 根目录下的相对路径，范围可控，也天然支持中文 / 空格文件名（逐段编码再解码）。

---

## 6. 数据迁移方案

1. **自动迁移**：`main/db.js` 的 `MIGRATIONS` 追加 v9、v10、v11；启动时按 `user_version` 顺序执行，
   每个迁移包在事务里跑（失败即回滚，不会留下半套表）。v11 只有一条 `ALTER TABLE notes ADD COLUMN
   attachments`（SQLite 的 ADD COLUMN 带默认值，对存量行零影响）。
2. **幂等**：建表全部 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`；
   内置知识库用 `INSERT OR IGNORE`（id=1），重复启动不会产生第二份。
3. **存量数据**：新表对旧库只是新增，不动 `tasks / groups` 任何列，老数据零影响。
4. **备份兼容**：`schemaVersion` 8 → **11**；导出新增 `note_folders / notes / note_tags /
   note_tag_map / task_notes / knowledge_bases`；**不导出** `kb_documents / kb_chunks / kb_vectors`
   （可由正文重建），与「备份不含 API Key」同一思路。
5. **导入**：事务内清空 → 逐个写入（目录两级写：先不带 `parent_id` 再回填，避免外键顺序问题）；
   父子缺失降级为顶层；`task_notes` 只写两端都存在的关联；结束后 `ensureNotesKb()` +
   `knowledge.indexAll()` 重建索引。
6. **回滚**：新功能独立成表，卸载（回到 v1.3.x）时旧版本会忽略这些表，不会报错。

---

## 7. 验证

- 数据层：`npm run test:db`（`scripts/smoke-db.js` 新增 [15]~[20] 六组用例：目录/标签/检索、
  任务关联、知识库与删除策略、备份往返、**笔记图片附件**、**智能检索降级路径**）。
  当前 **184 项全部通过**。
- 界面：CDP 驱动真实窗口验证 —— 列表页（两栏、行内操作）→ 点击笔记弹出编辑窗口（EasyMDE 挂载、
  列表不被覆盖）→ 防抖落库 → 预览（标题 / 表格）→ **真实粘贴事件插入图片并在预览里加载成功** →
  关闭回到列表（图片数徽标）→ 删除影响面 + 回收站 + 恢复 → 任务详情关联 / 徽标 / 跳转弹窗 →
  归档后仍可检索与引用 → 知识库问答降级召回。全程无 JS 异常。

---

## 8. 技术假设的确认结果（v1.5.0 已按此实现）

| # | 假设 | 结论 |
|---|---|---|
| 1 | 编辑器选型 | ✅ 用 EasyMDE（CodeMirror 5），vendor 进仓库离线可用 |
| 2 | 预览刷新兜底 | ✅ 应用层重渲（EasyMDE 只在分栏模式自动跟随） |
| 3 | 检索方式 | ✅ 升级为「查询改写 + 多路召回 + RRF 融合 + AI 重排」——**不引向量**，但智能度不再受限于字面匹配 |
| 4 | 知识库范围 | ✅ 一期只有内置笔记库（id=1），表结构已为外部数据源预留 |
| 5 | 归档语义 | ✅ **归档仍可被检索与引用**（已验证） |
| 6 | 彻底删除 | ✅ 硬删除（先解引用再删，不可恢复）；回收站提供恢复 / 清空 |
| 7 | 图片存储 | ✅ **改为复用 `main/attachments.js` 落盘**（`note-<id>/`），正文只存 `todo-media://` 链接，不再塞 base64 |
| 8 | 问答落库 | ✅ 仍不落库（`qa_sessions` 表设计已在方案文档里留位） |
| 9 | CSP | ✅ 放开 `img-src https: todo-media:` |
| 10 | 编辑入口 | ✅ **改为弹窗编辑**（点笔记即开），列表页不再被编辑器挤占 |

仍可调整的余地：
- 若希望「归档后退出知识库」：`knowledge.indexNote()` 里加一行 `if (note.archived) { removeNote(); return; }`。
- 若希望图片也随笔记导出成可迁移的独立备份：目前附件文件与数据目录同在一处，整体拷贝即完整；
  单独导出需要再做一个「打包 zip」入口。
- 若希望语义检索（纯语义也能召回）：在 `rerankWithAI` 之外加一路 embedding 检索，`kb_vectors` 已预留。
