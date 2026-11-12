'use strict';
/**
 * 演示数据播种（开发辅助脚本，非应用运行时依赖）。
 *
 * 用途：给 README 截图 / 手工演示准备一份「看起来像真的在用」的数据 ——
 * 四个分组、一批带优先级 / 标签 / 计划日期的任务、几篇笔记、一场会议纪要、
 * 一份 AI 周报、若干番茄记录，以及日历需要的跨月排期。
 *
 * 为什么直接调 `main/db.js`：它是纯 Node 模块（不依赖 Electron），
 * 建数据走的是与线上完全相同的表结构与迁移，不会造出一份「截图能看、点开就崩」的假库。
 * 少量 `db.js` 没暴露的字段（历史完成时间、番茄段的起止时刻）用第二条 SQLite 连接补，
 * WAL 下多连接并发读没问题。
 *
 * 用法：
 *   node scripts/demo-data.js <数据目录>
 * 数据目录就是 Electron 的 userData（`--user-data-dir` 指向它时，todo.db 落在根上）。
 */
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../main/db');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 相对今天偏移 n 天的日期（YYYY-MM-DD） */
function day(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** 相对今天偏移 n 天、指定时刻的 ISO 时间串 */
function at(n, hh = 10, mm = 0) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

function seed(dir) {
  const handle = db.init(dir);
  if (!handle) throw new Error(`数据库初始化失败：${db.getInitError()}`);

  // 清掉 seedDefaults 建的两个空分组，换成演示用分组树
  for (const g of db.listGroups()) {
    try { db.deleteGroup(g.id); } catch (_) { /* 有任务时跳过 */ }
  }

  const G = {};
  G.product = db.createGroup({ name: '产品迭代', color: '#4f7cff' });
  G.needs = db.createGroup({ name: '需求梳理', color: '#4f7cff', parentId: G.product.id });
  G.release = db.createGroup({ name: '版本发布', color: '#7b6cf6', parentId: G.product.id });
  G.support = db.createGroup({ name: '客户支持', color: '#e08a3c' });
  G.team = db.createGroup({ name: '团队协作', color: '#2f9e8f' });
  G.growth = db.createGroup({ name: '个人成长', color: '#5f9e52' });

  const T = {};
  T.fe = db.createTag('前端', '#4f7cff');
  T.be = db.createTag('后端', '#7b6cf6');
  T.design = db.createTag('设计', '#d4677f');
  T.doc = db.createTag('文档', '#a08a6a');
  T.urgent = db.createTag('紧急', '#d9472e');
  T.perf = db.createTag('性能', '#2f9e8f');

  const tasks = [];
  /** 建一条任务；tags 传 tag 对象数组 */
  function mk(title, o = {}) {
    const t = db.createTask({
      title,
      groupId: o.group || null,
      parentId: o.parent || null,
      notes: o.notes || '',
      priority: o.pri == null ? 1 : o.pri,
      planStart: o.from || null,
      planEnd: o.to || null,
      reminderAt: o.remind || null,
      tagIds: (o.tags || []).map((x) => x.id),
      createdAt: o.createdAt || null,
    });
    tasks.push(t);
    return t;
  }

  /* ---------- 「今天」列表：14 条，覆盖逾期 / 今天 / 子任务 / 备注摘要 ---------- */
  const tFeedback = mk('回复企业版试用反馈（3 家）', {
    group: G.support.id, pri: 2, from: day(-4), to: day(0), tags: [T.urgent],
    notes: '三家分别是仓储、连锁零售、医疗器械。重点是权限模型和导入模板的差异，回复时附上 1.12 的排期。',
    createdAt: at(-6, 9, 20),
  });
  const tGarbled = mk('复盘用户反馈的导入乱码问题', {
    group: G.support.id, pri: 3, from: day(-2), to: day(0), tags: [T.be, T.urgent],
    notes: 'GB18030 的 CSV 在选择文件时按 UTF-8 解了一次，落库前没有回退检测。',
    createdAt: at(-3, 14, 5),
  });
  const tScroll = mk('详情面板滚动条槽位对齐', {
    group: G.needs.id, pri: 1, from: day(-3), to: day(0), tags: [T.fe, T.design],
    createdAt: at(-5, 11, 0),
  });
  const tPerf = mk('重构任务列表渲染性能', {
    group: G.product.id, pri: 3, from: day(0), to: day(0), tags: [T.fe, T.perf],
    notes: [
      '2000 条任务时整表重绘要 380ms，滚动手感发涩。目标：只重绘变更行，滚动维持 60fps。',
      '',
      '## 现状',
      '',
      '- 每次 `renderTasks()` 都重建整个列表容器，没变的行也跟着重新解析模板。',
      '- 滚动没有节流，滚轮一快就掉到 30fps。',
      '- 还没有基准脚本，改完只能靠手感判断。',
      '',
      '> 先做「今天」视图的虚拟列表，分组视图这一版保留整表重绘。',
    ].join('\n'),
    createdAt: at(-1, 10, 30),
  });
  const tPlan = mk('整理 1.12 版本迭代计划', {
    group: G.needs.id, pri: 2, from: day(-6), to: day(0), tags: [T.doc],
    notes: '把需求池里 18 条按「必须有 / 应该有 / 可以有」分三档，周会上定取舍。',
    createdAt: at(-8, 9, 0),
  });
  const tReview = mk('评审笔记模块交互稿', {
    group: G.team.id, pri: 2, from: day(-2), to: day(0), tags: [T.design],
    notes: '重点看编辑态与只读态的切换成本，以及工具条吸顶后正文的可视高度。',
    createdAt: at(-4, 15, 0),
  });
  const tWeek = mk('周会：下周排期与风险', {
    group: G.team.id, pri: 0, from: day(0), to: day(0),
    createdAt: at(-1, 16, 0),
  });
  const tBook = mk('读完《卡片笔记写作法》第 3 章', {
    group: G.growth.id, pri: 0, from: day(-5), to: day(0),
    createdAt: at(-7, 21, 0),
  });
  const retire = [];
  retire.push(mk('归档 10 月销售数据', {
    group: G.support.id, pri: 1, from: day(-24), to: day(-16), tags: [T.doc],
    createdAt: at(-26, 10, 0),
  }));
  retire.push(mk('补写 1.11 的发布说明', {
    group: G.release.id, pri: 1, from: day(-13), to: day(-9), tags: [T.doc],
    createdAt: at(-15, 11, 0),
  }));
  // 待安排池：日历左边那一栏，拖进格子才排期
  mk('看竞品的周报模板', { group: G.product.id, pri: 0, tags: [T.doc], createdAt: at(-2, 9, 10) });
  mk('给「专注」加一个快捷键', { group: G.product.id, pri: 1, tags: [T.fe], createdAt: at(-2, 9, 20) });
  mk('整理 10 月工单高频问题', { group: G.support.id, pri: 1, tags: [T.doc], createdAt: at(-3, 9, 30) });
  mk('和 HR 对一下招聘节奏', { group: G.team.id, pri: 1, createdAt: at(-3, 9, 40) });
  mk('备份盘的更换计划', { group: G.growth.id, pri: 0, createdAt: at(-4, 9, 50) });
  mk('给「导入」加上格式校验提示', {
    group: G.product.id, pri: 1, from: day(1), to: day(3), tags: [T.fe],
    createdAt: at(-2, 10, 0),
  });
  mk('客户走访：仓库盘点流程', {
    group: G.support.id, pri: 1, from: day(2), to: day(5), tags: [T.urgent],
    createdAt: at(-2, 17, 0),
  });
  mk('与设计对齐空状态插画', {
    group: G.team.id, pri: 1, from: day(1), to: day(1), tags: [T.design],
    createdAt: at(-1, 14, 0),
  });
  mk('回归测试：安装版 / 便携版', {
    group: G.release.id, pri: 2, from: day(3), to: day(4), tags: [T.fe],
    createdAt: at(-1, 18, 0),
  });

  /* 子任务：父任务行显示 2/3 进度 */
  mk('抽出单行的 memo 比较', { parent: tPerf.id, group: G.product.id, pri: 2, from: day(0), to: day(0), tags: [T.perf] });
  mk('虚拟列表先只做今天视图', { parent: tPerf.id, group: G.product.id, pri: 2, from: day(0), to: day(0), tags: [T.perf] });
  mk('补一组 2000 条的基准数据', { parent: tPerf.id, group: G.product.id, pri: 1, from: day(0), to: day(0) });

  /* ---------- 日历：11 月铺开，含跨天、超载、已完成 ---------- */
  const cal = [
    ['梳理 1.12 需求池取舍', G.needs.id, 2, -9, -7, [T.doc]],
    ['写 1.12 排期草案', G.needs.id, 1, -8, -6, []],
    ['详情面板视觉走查', G.needs.id, 1, -7, -6, [T.design]],
    ['导入乱码的最小复现', G.support.id, 3, -6, -6, [T.be]],
    ['把复现步骤发给后端', G.support.id, 1, -6, -5, []],
    ['周会材料：负载视图', G.team.id, 1, -5, -5, []],
    ['评审笔记交互稿', G.team.id, 2, -4, -4, [T.design]],
    ['改工具条吸顶的偏移', G.product.id, 1, -4, -3, [T.fe]],
    ['1.11 发版回归', G.release.id, 2, -3, -3, [T.fe]],
    ['盯 Gitee 附件配额', G.release.id, 2, -3, -3, []],
    ['客户走访前的资料', G.support.id, 1, -2, -1, [T.doc]],
    ['修空状态插画的边距', G.team.id, 0, -2, -1, [T.design]],
    ['整理 1.12 迭代计划', G.needs.id, 2, -1, 1, [T.doc]],
    ['重构列表渲染（第一天）', G.product.id, 3, 0, 0, [T.perf]],
    ['写性能基准脚本', G.product.id, 2, 1, 1, [T.perf]],
    ['重构列表渲染（第二天）', G.product.id, 3, 1, 2, [T.perf]],
    ['导入校验提示文案', G.product.id, 1, 2, 3, [T.fe]],
    ['客户走访：仓库盘点', G.support.id, 2, 3, 4, [T.urgent]],
    ['空状态插画落地', G.team.id, 1, 3, 3, [T.design]],
    ['版本说明初稿', G.release.id, 1, 4, 4, [T.doc]],
    ['安装版安装包回归', G.release.id, 2, 5, 5, [T.fe]],
    ['便携版冷启动实测', G.release.id, 1, 5, 5, []],
    ['下周排期会', G.team.id, 1, 6, 6, []],
    ['数据备份方案复核', G.product.id, 2, 8, 8, [T.be]],
    ['分组颜色规范', G.growth.id, 0, 9, 11, []],
    ['读《卡片笔记写作法》', G.growth.id, 0, 9, 12, []],
    ['季度复盘材料', G.team.id, 2, 10, 12, [T.doc]],
    ['客户 A 私有化部署', G.support.id, 3, 11, 12, [T.urgent]],
  ];
  for (const [title, gid, pri, from, to, tags] of cal) {
    mk(title, { group: gid, pri, from: day(from), to: day(to), tags });
  }

  /* ---------- 历史已完成任务（统计趋势 / 已完成视图 / 归档） ---------- */
  const doneTitles = [
    '修掉浮窗勾选后主窗丢任务', '自绘标题栏三键接入', '侧栏顶栏改版', '外观系统：六套风格',
    '背景图压缩管线', '启动画面', 'AI 检索弹窗重做', '会议纪要导出待办',
    '分组拖拽排序', '重复事项打卡日历', '日历月 / 周缩放', '统计下钻明细',
    '快捷键冲突提示', '托盘菜单整理', '备份包瘦身', '笔记 Mermaid 导出',
    '详情抽屉自动保存', '导入 Markdown 目录', '标签筛选多选', '优先级的色点',
    '空状态文案梳理', '提醒的富文本', '任务行备注摘要', '专注时间线展示',
    '打包含 7z 瘦身', '安装版签名流程', 'Release 脚本重试', '日志脱敏',
  ];
  const doneIds = [];
  doneTitles.forEach((title, i) => {
    const offset = -Math.round((i * 2.6)) - 1; // -1 ~ -70 天
    const gid = [G.product.id, G.needs.id, G.release.id, G.support.id, G.team.id][i % 5];
    const t = mk(title, {
      group: gid, pri: i % 4, from: day(offset - 2), to: day(offset),
      createdAt: at(offset - 3, 9, 30),
    });
    doneIds.push({ id: t.id, offset });
  });
  // 归档一批（归档视图 / 统计里的「归档」计数）
  for (const d of doneIds.slice(-6)) db.archiveTask(d.id);

  /* ---------- 用第二条连接补历史完成时间 ---------- */
  const raw = new Database(path.join(dir, 'todo.db'));
  const setDone = raw.prepare('UPDATE tasks SET completed = 1, completed_at = ? WHERE id = ?');
  for (const d of doneIds) setDone.run(at(d.offset, 17, 40), d.id);
  // 两条更早的遗留任务：标成已完成，免得「今天」列表一上来全是逾期红字
  for (const t of retire) setDone.run(at(-16, 16, 20), t.id);

  // 今天完成的那条（留在「今天」列表里，并在顶部出现「今日已完成」条）
  setDone.run(at(0, 11, 12), tReview.id);
  // tBook：昨天做完的重复阅读任务不参与今天视图，保持未完成即可

  /* ---------- 笔记 ---------- */
  const fDesign = db.createNoteFolder({ name: '产品设计', color: '#4f7cff' });
  const fMeet = db.createNoteFolder({ name: '会议记录', color: '#2f9e8f' });
  const ntag = [db.createNoteTag('架构', '#7b6cf6'), db.createNoteTag('交互', '#d4677f')];

  const noteMain = db.createNote({
    title: 'Knodo 信息架构梳理',
    folderId: fDesign.id,
    tagIds: [ntag[0].id, ntag[1].id],
    contentMd: [
      '## 一句话',
      '',
      '**任务和笔记共用同一个本地数据库**，所以「做完的事」和「记下的东西」天然能互相找到 ——',
      '不需要在第二大脑里再维护一份索引。',
      '',
      '## 三个层级',
      '',
      '1. **今天** —— 只回答「现在做什么」，其余全交给分组。',
      '2. **分组 / 标签** —— 回答「这件事属于哪儿」，允许无限层级。',
      '3. **笔记与知识库** —— 回答「当时是怎么想的」，写下来就会被检索到。',
      '',
      '> 设计取舍：宁可少一个视图，也不要让用户在两个地方维护同一件事。',
      '',
      '## 入口与落点',
      '',
      '| 入口 | 落点 | 是否切视图 |',
      '| --- | --- | --- |',
      '| 顶栏「＋ 新建任务」 | 列表最后一行就地输入 | 否 |',
      '| 顶栏「🔍 AI 检索」 | 弹窗 | 否 |',
      '| 标题栏「🗓 日历」 | 日历视图 | 是 |',
      '| 标题栏「🐮 搭子」 | 工位搭子面板 | 否 |',
      '',
      '## 细节',
      '',
      '- 描述与笔记共用**同一套所见即所得编辑器**，两处看到的样子必须一致。',
      '- 列表行只显示备注的**纯文本摘要**（72 字），有图换成 `📷`。',
      '- 任何一个视图都不该出现「保存」按钮 —— 停手 0.7 秒就该落库。',
      '',
      '```js',
      '// 派生字段只读：重复事项的日期由规则算，不接受写入',
      "if (cur.recurring_id != null) throw new Error('derived field');",
      '```',
    ].join('\n'),
  });

  db.createNote({
    title: '详情面板设计稿说明',
    folderId: fDesign.id,
    contentMd: [
      '## 为什么抽屉不压暗',
      '',
      '抽屉是**并排阅读**，不是打断。压暗主界面等于宣布「你现在只能看这一条」，',
      '而真实的动作是「对照左边那条，改右边这条」。',
      '',
      '所以遮罩只当透明点击层，分离靠面板投影 + 一条发丝线。',
      '',
      '## 宽度',
      '',
      '- 默认 420，可拖到 720；记住上次的宽度。',
      '- 窄于 420 时附件列表换行，但标题不截断。',
    ].join('\n'),
  });

  db.createNote({
    title: '1.12 版本评审会',
    folderId: fMeet.id,
    contentMd: [
      '## 结论',
      '',
      '1.12 只做三件事：导入校验、列表渲染性能、详情面板视觉收口。',
      '其余需求一律进 1.13，不再插队。',
      '',
      '- 导入校验：先做 GB18030 回退检测，再补提示文案。',
      '- 渲染性能：只重绘变更行，目标是 2000 条任务下滚动不卡。',
      '- 视觉收口：滚动条槽位、空状态插画、卡片底色统一。',
    ].join('\n'),
  });

  /* ---------- 会议纪要 ---------- */
  const mtg = db.createMeeting({
    title: '1.12 版本评审会',
    source_label: '麦克风 + 系统声',
    mode: 'audio',
    started_at: at(-1, 14, 0),
    duration_ms: 42 * 60 * 1000,
    status: 'summarized',
  });
  db.updateMeeting(mtg.id, {
    transcript: [
      '主持人：今天只定 1.12 的范围，别的先记下来。',
      '产品：客户侧最痛的是导入乱码，三家试用里有两家卡在这一步。',
      '前端：列表在 2000 条任务时整表重绘要 380 毫秒，滚动会掉帧。',
      '设计：详情面板的滚动条槽位和主列表对不齐，视觉上像错位了一格。',
      '主持人：那就这三件，其余进 1.13。导入校验谁跟？',
      '后端：我出检测逻辑，文案让产品给。',
    ].join('\n'),
    summary: [
      '## 议题',
      '',
      '- 1.12 范围收敛：只做导入校验、列表渲染性能、详情面板视觉收口。',
      '',
      '## 决议',
      '',
      '1. 其余需求全部进 1.13，本版不再插队。',
      '2. 导入乱码先做编码回退检测，再做提示文案。',
      '3. 列表渲染只重绘变更行，2000 条任务为基准。',
      '',
      '## 待办',
      '',
      '- 后端：GB18030 回退检测（本周）',
      '- 产品：导入失败的提示文案（本周）',
      '- 前端：列表增量重绘（下周一）',
      '',
      '## 风险',
      '',
      '- 视觉收口可能牵动日历卡片的底色，需要一起回归。',
    ].join('\n'),
    todos: [
      { title: '后端：GB18030 回退检测', done: false },
      { title: '产品：导入失败的提示文案', done: false },
      { title: '前端：列表增量重绘', done: false },
    ],
  });

  /* ---------- AI 报告 ---------- */
  db.createReport({
    title: '本周周报 · 1.12 版本推进',
    type: 'week',
    range_start: day(-6),
    range_end: day(0),
    group_ids: [G.product.id],
    group_label: '产品迭代',
    content: [
      '## 本周进展',
      '',
      '1.12 的三件事都已进入实施：导入编码检测完成复现，列表增量重绘跑通第一版，',
      '详情面板的滚动条槽位已对齐。',
      '',
      '### 完成情况',
      '',
      '- 完成任务 12 条，其中紧急 3 条；新增 9 条，顺延 2 条。',
      '- 客户支持侧闭环 4 条试用反馈，剩余 3 条待客户确认。',
      '',
      '### 下周计划',
      '',
      '1. 完成列表增量重绘并补基准脚本。',
      '2. 发布 1.12 候选包，走安装版 / 便携版双回归。',
      '3. 把 1.13 的需求池按「必须有 / 应该有」分档。',
      '',
      '### 风险',
      '',
      '视觉收口牵动日历卡片底色，回归范围比预期大，需要预留半天。',
    ].join('\n'),
    degraded: 0,
  });
  db.createReport({
    title: '上周周报 · 外观系统上线',
    type: 'week',
    range_start: day(-13),
    range_end: day(-7),
    group_ids: [G.product.id],
    group_label: '产品迭代',
    content: '## 本周进展\n\n外观系统（明暗 × 六风格 × 背景图）随 2.4.1 发布，便携版改为 7z。',
  });

  // 报告按 created_at 倒序展示：两篇都取 nowIso 会分不出先后，补一个真实的时间差
  raw.prepare('UPDATE reports SET created_at = ?, updated_at = ? WHERE title LIKE ?')
    .run(at(-7, 18, 0), at(-7, 18, 0), '上周周报%');
  raw.prepare('UPDATE reports SET created_at = ?, updated_at = ? WHERE title LIKE ?')
    .run(at(0, 9, 30), at(0, 9, 30), '本周周报%');

  /* ---------- AI 检索历史 ---------- */
  db.createSearch({
    keyword: '导入 乱码',
    summary: '命中 3 条：导入乱码的复现与修复、CSV 编码检测、试用反馈里的同类问题。',
    task_count: 3,
    tasks: [tGarbled.id, tFeedback.id, tPlan.id],
    degraded: 0,
  });
  db.createSearch({
    keyword: '性能',
    summary: '命中 4 条：列表渲染、基准脚本、虚拟列表、滚动掉帧。',
    task_count: 4,
    tasks: [tPerf.id],
    degraded: 0,
  });

  /* ---------- 番茄钟记录（详情时间线 + 顶栏格数） ---------- */
  const plan = [
    { day: -6, sec: 1800, outcome: 'full', note: '先把渲染入口收敛到一个函数，再谈增量。' },
    { day: -4, sec: 1800, outcome: 'full', note: '基准脚本跑通，2000 条 380ms 复现。' },
    { day: -2, sec: 1200, outcome: 'partial', note: '被客户电话打断，先记一下当前进度。' },
    { day: 0, sec: 1800, outcome: 'full', note: 'memo 比较抽出来了，单行 diff 有效。' },
    { day: 0, sec: 1800, outcome: 'full', note: '今天视图走虚拟列表，滚动稳住了。' },
    { day: 0, sec: 1800, outcome: 'full', note: '补完基准用例，准备收尾。' },
  ];
  for (const p of plan) {
    const s = db.createFocusSession({ taskId: tPerf.id, groupId: G.product.id, plannedSec: p.sec });
    // 结算时**不传 note**：`settleFocusSession` 会把那句话按时间戳反写进任务备注，
    // 演示库要的是一段干净的描述 + 一份专注时间线，所以那句话只在下面的 SQL 里补回 focus_sessions
    db.settleFocusSession(s.id, { outcome: p.outcome, actualSec: p.sec });
    raw.prepare('UPDATE focus_sessions SET started_at = ?, ended_at = ?, note = ? WHERE id = ?')
      .run(at(p.day, 9, 40), at(p.day, 9, 40 + Math.round(p.sec / 60)), p.note, s.id);
  }

  // 任务 ↔ 笔记：详情抽屉底部会显示「关联笔记」
  db.linkTaskNote(tPerf.id, noteMain.id);

  /* ---------- 界面偏好 ---------- */
  // 「今天」列表保留刚完成的任务：靠这份 id 集合，不是靠放宽查询
  db.setSetting('ui.todayDone', JSON.stringify({ day: day(0), ids: [tReview.id] }));

  raw.close();

  return {
    groups: db.listGroups().length,
    tasks: tasks.length,
    notes: db.listNotes({}).length,
  };
}

module.exports = { seed };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法：node scripts/demo-data.js <数据目录>');
    process.exit(1);
  }
  const stat = seed(path.resolve(dir));
  console.log('[demo] 播种完成', JSON.stringify(stat));
}
