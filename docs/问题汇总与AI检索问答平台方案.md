# Knodo → 「问题汇总 + AI 检索问答」平台升级方案

面向当前 Electron + SQLite + 本地 AI 网关的桌面应用，给出可增量落地的实现方案。
不推倒重来：复用现有的**数据层迁移机制、IPC/preload 通道、AI 配置、弹窗与 Markdown 渲染**，
在现有「任务」体系旁并行长出「问题 / 知识库 / 问答」三条线。

---

## 0. 定位与边界

| | 任务（现有） | 问题（新增） |
|---|---|---|
| 语义 | 要做的**执行项**，有截止与状态流转 | 遇到过的**问题与其解法**，沉淀为知识 |
| 生命周期 | 待办 → 完成 → 归档 | 录入 → 待解决 → 已解决 → 沉淀进知识库 → 可被引用 |
| 主要动作 | 勾选、排期、分组 | 检索、问答、溯源、派生任务 |
| 关系 | 问题可派生任务（"按这个解法去做"） | 完成任务时回写问题状态 |

一句话：**任务是 to-do，问题是 knowledge；问题库是 AI 问答的语料，问答结果又能反向生成任务。**

---

## 1. 问题采集与结构化存储

### 1.1 采集渠道（按优先级）

1. **手动录入**：顶部工具栏「＋ 新问题」→ 表单（标题 / 现象 / 环境 / 根因 / 解法 / 标签 / 关联分组 / 附件）。
2. **从任务转化**：任务详情「存为问题」——把标题+描述+子任务结论灌进问题模板（最高性价比，用户已在用的路径）。
3. **会议纪要抽取**：现有 `meetings` 已能转写+总结，新增一步「抽取待办问题」→ 生成草稿问题，人工确认后入库。
4. **批量导入**：JSON / CSV / Markdown 目录（复用 `data:import` 的导入管线），用于迁移历史 FAQ、工单导出。
5. **API / Webhook（二期）**：本地 HTTP 端点或 CLI 写入，供外部系统（工单、IM）推送。

### 1.2 结构化字段（采集即结构化，避免事后补）

录单时只要求「标题 + 现象」，其余字段允许空、由 AI 补全（补全结果标 `ai_generated=1`，可人工订正）：

- **现象 symptom**：出问题的表现（必填）
- **环境 context**：系统 / 版本 / 分支 / 设备
- **根因 root_cause**：定位结论
- **解法 solution**：可执行的解决步骤（问答时最常被引用）
- **结论 conclusion**：一句话沉淀（用于列表展示与向量化加权）
- **状态 status**：`open` / `investigating` / `resolved` / `deprecated`
- **置信度**：解法被验证的次数（"已解决 N 次"），作为排序权重
- **元信息**：`source`（manual/task/meeting/import/api）、`source_ref`（原始 id）、`created_at` / `resolved_at`

### 1.3 表设计（沿用现有迁移机制，schemaVersion → 9）

项目已有 `main/db.js` 的 `migrations` 数组（v8 补 `created_at`），新增迁移按同样写法追加即可，
老库自动升级、无需重建：

```sql
-- 问题主表
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  symptom TEXT NOT NULL DEFAULT '',      -- 现象
  context TEXT NOT NULL DEFAULT '',      -- 环境
  root_cause TEXT NOT NULL DEFAULT '',   -- 根因
  solution TEXT NOT NULL DEFAULT '',     -- 解法
  conclusion TEXT NOT NULL DEFAULT '',   -- 一句话结论
  status TEXT NOT NULL DEFAULT 'open',   -- open/investigating/resolved/deprecated
  severity INTEGER NOT NULL DEFAULT 1,   -- 0 低 ~ 3 紧急
  group_id INTEGER,                      -- 复用现有分组（颜色/层级直接继承）
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,  -- 被检索命中次数
  verify_count INTEGER NOT NULL DEFAULT 0, -- 解法被验证次数（排序权重）
  ai_generated INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_group ON issues(group_id);

-- 问题标签（复用 tags + 多对多，与任务标签同一套）
CREATE TABLE IF NOT EXISTS issue_tags (
  issue_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
  PRIMARY KEY (issue_id, tag_id)
);

-- 问题 ↔ 任务 / 会议纪要 关联（双向溯源）
CREATE TABLE IF NOT EXISTS issue_links (
  issue_id INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- task | meeting | report | search
  ref_id INTEGER NOT NULL,
  PRIMARY KEY (issue_id, kind, ref_id)
);

-- 附件（截图 / 日志，落磁盘、库里存相对路径）
CREATE TABLE IF NOT EXISTS issue_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  rel_path TEXT NOT NULL, mime TEXT, size INTEGER,
  created_at TEXT NOT NULL
);
```

**为什么不用 JSON 字段一把梭**：问题会被检索、聚合、排序、按状态统计，且要 JOIN 分组与标签；
结构化列 + 索引是必需的，只有附件清单、AI 补全痕迹这类"读多写少、不参与查询"的信息才用 JSON 列。

---

## 2. 知识库构建（RAG）

### 2.1 分块（Chunking）

问题本身是**短文本结构化条目**，不需要像长文档那样碎切。推荐**按语义字段分块**：

| 块类型 | 内容 | 权重 |
|---|---|---|
| `summary` | 标题 + 结论 + 状态 | 1.2（召回优先） |
| `solution` | 解法步骤 | 1.0 |
| `symptom` | 现象 + 环境 | 0.9（用户提问往往描述现象） |
| `detail` | 根因 + 长描述，超 800 字再按段落滑窗（overlap 100） | 0.7 |

每块记录 `char_start / char_end`，回答时能高亮回原文片段。

```sql
CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- summary | solution | symptom | detail
  ord INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  token_est INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,    -- 内容指纹：用于判断是否真变了，避免无意义重建
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_issue ON kb_chunks(issue_id);

-- 向量表：embedding 以 BLOB 存 float32，维度统一由配置决定
CREATE TABLE IF NOT EXISTS kb_vectors (
  chunk_id INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);
```

### 2.2 向量化与存储选型

- **优先方案：SQLite 内联向量**。用 `sqlite-vec`（或 `sqlite-vss`，二者都提供预编译 native 模块）
  在本机库里直接做 ANN 检索 — 量级在几千到几万块时完全够用，且**不引入独立服务、不额外占端口、随库备份**。
  Electron 里加载 native 模块需要 `electron-rebuild`，这是唯一成本。
- **兜底方案（零依赖）**：块数 < 5000 时，把向量存 BLOB，检索时全量拉取做内存余弦相似度。
  规模小、实现简单、无 native 依赖，先跑通链路；达到阈值后再切到 sqlite-vec，接口不变。
- **不推荐**：外挂 Chroma / Qdrant 服务进程 —— 桌面单机应用里运维成本远大于收益。

### 2.3 嵌入模型

复用现有 AI 配置（Base URL / Model / Key），新增一段 `embedding` 配置：

| 方案 | 说明 |
|---|---|
| 本地 Ollama `nomic-embed-text` / `bge-m3` | 完全离线、无隐私外泄，768 维；本机 CPU 可跑，建索引慢一点但可接受 |
| 云端 OpenAI 兼容 `/embeddings` | 快、质量稳，但**问题内容会出网**，需要在设置里明确开关并默认关闭 |
| 无 embedding 时 | 自动降级为**关键词检索（FTS5）**，不阻断功能 |

### 2.4 索引管线（增量、可重入）

1. 触发：问题保存 / 状态变更 / 手动「重建索引」/ 启动时空闲补偿。
2. 生成块 → 逐块算 `content_hash` → **与库中哈希相同则跳过**（只有真改动才调 embedding，省钱省时）。
3. 批量 embed（建议 16~32 条一批，失败整批重试 2 次，仍失败标记 `pending` 由下次补偿）。
4. 写入 `kb_vectors`，更新 `kb_index_state`（最后成功时间、模型名、待处理数量）。
5. **切模型要重建全量**：`model` 变化则清空 `kb_vectors` 重来（向量空间不一致，混用会召回错乱）。

### 2.5 检索：向量 + 关键词混合

- **关键词**：SQLite **FTS5**（`better-sqlite3` 内置支持；可选 `jieba` 分词或 `unicode61` + 简易中文切分），
  对"报错码、类名、命令"这类精确词命中率远高于向量。
- **融合**：两路各取 Top-K，用 **RRF（Reciprocal Rank Fusion）** 合并，再做一次**结构化过滤**
  （分组 / 标签 / 状态 / 时间范围），最后按 `verify_count`、`hit_count`、时间新鲜度做轻量加权。
- **无 embedding**：只走 FTS5，结果标注"关键词匹配"，UI 明示降级状态。

---

## 3. AI 检索与回答交互流程

### 3.1 主流程

```
用户提问
  → ① 查询理解（可选，短查询跳过）：LLM 抽取关键词 / 同义改写 / 过滤条件
  → ② 混合召回（向量 Top20 + 关键词 Top20，RRF 融合 → Top8）
  → ③ 重排（可选：cross-encoder 或让 LLM 对候选打分，成本敏感时默认关闭）
  → ④ 组装上下文：块原文 + 标题 + 状态 + 来源链接（截断到模型窗口内，按权重取舍）
  → ⑤ 生成回答（流式输出），强制"每条结论必须带 [问题#id] 引用"
  → ⑥ 渲染：答案 + 引用卡片（标题 / 状态 / 分组色点 / 片段高亮），点击跳问题详情
  → ⑦ 反馈闭环：「有用 / 没用」→ 有用则 verify_count++，没用则记录负样本便于调权重
```

### 3.2 降级与兜底（必须做，否则"点了没反应"会重演）

| 情况 | 表现 |
|---|---|
| 无 Key / 接口不通 | 直接展示**关键词检索命中的问题列表**（不调 LLM），并提示去「AI 设置」配置 |
| 有 Key 但 embedding 缺失 | 走 FTS5 召回 + LLM 生成，标注"未启用向量检索" |
| 召回为空 | 明确说"知识库里没有相关问题"，并给出「录入这个问题」「用全文任务搜索」两个出口 |
| 相似度全部低于阈值 | 仍然回答，但前置一句"知识库匹配度较低，以下基于通用经验"——避免幻觉被当成事实 |
| 请求超时 / 失败 | 弹窗或页面内**原地显示错误 + 重试按钮**（现有润色功能已固化的模式，直接复用） |

交互上建议：**输入框下方实时显示"召回中… → 已找到 N 条相关问题 → 生成中… → 完成"**，
保证任何一步都有可见状态；生成用流式（SSE / 分块）避免长时间白屏。

### 3.3 会话（一期可省，二期补）

`qa_sessions` + `qa_messages` 存多轮上下文（近 3 轮 + 当前召回块即可，不必全量），
支持「把这次问答存为问题」「把解法派生成任务」。

---

## 4. 功能模块与代码组织

沿用现有目录约定（main = 数据/IPC，renderer/js = 视图模块，scripts = 冒烟）：

```
main/
  db.js             +issues/issue_tags/issue_links/issue_attachments/kb_* 表 + 迁移 v9
  kb.js             新增：分块、embedding 调度、混合检索（RRF）、索引状态
  embed.js          新增：embedding 客户端（Ollama / OpenAI 兼容）+ 批量 + 重试 + 降级
  ipc.js            +issues:* / kb:* / qa:* 通道（一律参数化 SQL，禁止字符串拼 WHERE）
  report.js 等      不变；问答结果可复用 markdownToDocx 导出
preload/preload.js  同步暴露 issues / kb / qa 三组 API
renderer/js/
  issues.js         新增：问题列表（分组/标签/状态筛选）+ 详情（复用 openFormModal）
  qa.js             新增：问答页（输入框 / 召回状态 / 流式答案 / 引用卡片 / 反馈）
  kb-settings.js    新增：知识库面板（索引进度、模型、重建、降级状态）
  modal.js          +'color' 等字段类型复用（已完成）
scripts/smoke-db.js + 问题 CRUD / 分块哈希跳过 / 混合检索 / 降级 的断言
```

**导航**：侧边栏加「🧩 问题库」「💬 AI 问答」两项；非任务视图沿用刚做的"隐藏顶部工具区"逻辑。

**UI 复用点**：分组色点（本轮已支持任意颜色）、Tom Select 多选、Markdown 渲染、
`openFormModal` 表单弹窗、`toast` 提示与自动保存器（`autosave.js`）都不必重写。

---

## 5. 落地路线（建议分四期，每期可独立交付）

| 期 | 内容 | 产出 |
|---|---|---|
| **P1 采集与结构化** | issues 表 + 列表/详情/筛选 + 从任务与会议纪要转化 + 导入导出 | 不依赖 AI，问题库先能用起来 |
| **P2 检索（无向量）** | FTS5 关键词检索 + 结果高亮 + 命中统计 | 搜索体验立即可用，验证需求 |
| **P3 RAG 问答** | embedding 配置 + 分块/索引管线 + 混合检索 + 流式回答 + 引用溯源 + 降级 | 平台形态成立 |
| **P4 闭环与优化** | 反馈信号、重排、把答案派生成任务、多轮会话、索引评估面板 | 精度与留存提升 |

每期都要补 `scripts/smoke-db.js` 断言与 `npm run smoke` 的一轮 UI 回归，
保持现有"改完必须跑通两套测试"的纪律。

---

## 6. 风险与权衡

| 风险 | 应对 |
|---|---|
| `sqlite-vec` 是 native 模块，Electron 需 rebuild | P3 先用内存余弦兜底版本跑通；native 化封装在 `kb.js` 内部，切换不改上层接口 |
| 中文分词质量影响关键词召回 | 默认 `unicode61` + 二元组切分，或可选 `jieba`；向量路为主、关键词为辅 |
| 本地 embedding 慢（CPU） | 建索引放空闲时段、分批、哈希去重避免重复计算；界面显示进度且可后台 |
| 隐私：云端 embedding / 生成会把问题内容出网 | 设置里默认本地优先 + 云端开关，出网前在 UI 明确提示 |
| 幻觉与错误答案被采信 | 强制引用溯源 + 低相似度前置声明 + 反馈按钮回写 `verify_count` |
| 库体积增长 | 向量 BLOB 是主要增量（768 维 float32 ≈ 3KB/块，1 万块 ≈ 30MB），可接受；提供清理/重建入口 |

---

## 7. 需要确认的决策点

1. **embedding 走本地还是云端**（影响 P3 的隐私模型与依赖体积）。
2. **向量方案**：sqlite-vec（native，需 rebuild）vs 内存余弦（零依赖，规模受限）——建议先后者再前者。
3. **问题是否需要独立于分组的"知识分类"**，还是直接复用现有分组树。
4. **问答结果是否默认入库存证**（可回看、可评估），以及保留多久。
