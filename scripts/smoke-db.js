'use strict';
/**
 * 数据层 + 报告生成的独立冒烟测试（不依赖 Electron，可直接用 Node 运行）。
 * 用法：node scripts/smoke-db.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const db = require('../main/db');
const report = require('../main/report');
const knowledge = require('../main/knowledge');
const attachments = require('../main/attachments');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-smoke-'));
console.log('临时数据库目录:', tmpDir);

db.init(tmpDir);

console.log('\n[1] 分组 CRUD');
// seedDefaults 已经建了「工作 / 生活」，同名再建会撞上「同一上级不允许重名」的校验，
// 所以这里直接复用种子分组（这也正是新校验要保护的行为）
const seededGroups = db.listGroups();
const g1 = seededGroups.find((g) => g.name === '工作' && g.parent_id == null);
const g2 = seededGroups.find((g) => g.name === '生活' && g.parent_id == null);
check('默认分组 + 新建分组', db.listGroups().length >= 2 && !!g1 && !!g2);
check('顶级分组重名被拒绝', (() => {
  try { db.createGroup({ name: '工作' }); return false; } catch (e) { return /已存在同名分组/.test(e.message); }
})());
db.updateGroup(g2.id, { name: '家庭', color: '#f59e0b' });
check('更新分组', db.getGroup(g2.id).name === '家庭');

// 子分组层级
const child = db.createGroup({ name: '前端', color: '#8b5cf6', parentId: g1.id });
const grand = db.createGroup({ name: '组件库', color: '#06b6d4', parentId: child.id });
check('创建子分组', child.parent_id === g1.id && grand.parent_id === child.id);
check('子孙集合（多层）', db.descendantGroupIds(g1.id).sort().join(',') === [child.id, grand.id].sort().join(','));
check('分组展开含自身', db.expandGroupIds([g1.id]).length === 3);

console.log('\n[1.5] 分组重名的作用域（同级唯一，跨级可同名）');
const dupA = db.createGroup({ name: '11', color: '#4f7cff', parentId: g1.id });   // 工作 / 11
const dupB = db.createGroup({ name: '11', color: '#23b07e', parentId: g2.id });   // 家庭 / 11
check('不同父级下可同名', dupA.id !== dupB.id
  && db.getGroup(dupA.id).parent_id === g1.id && db.getGroup(dupB.id).parent_id === g2.id);
const dupRoot = db.createGroup({ name: '11', color: '#f59e0b' });                 // 顶级 / 11
check('子分组与顶级分组可同名', dupRoot.parent_id == null && dupRoot.name === '11');
check('同一父级下重名被拒绝', (() => {
  try { db.createGroup({ name: '11', parentId: g1.id }); return false; } catch (e) { return /已存在同名分组/.test(e.message); }
})());
check('重名比较忽略大小写与首尾空格', (() => {
  db.createGroup({ name: 'Backend', parentId: g1.id });
  try { db.createGroup({ name: '  backend  ', parentId: g1.id }); return false; } catch (e) { return /已存在同名分组/.test(e.message); }
})());
check('只改颜色不触发重名校验', (() => {
  const r = db.updateGroup(dupA.id, { name: '11', parentId: g1.id, color: '#123456' });
  return r.color === '#123456' && r.name === '11';
})());
check('重命名成同级已存在的名字被拒绝', (() => {
  try { db.updateGroup(dupA.id, { name: 'Backend' }); return false; } catch (e) { return /已存在同名分组/.test(e.message); }
})());
check('重命名成别的层级的名字允许', (() => {
  const r = db.updateGroup(dupB.id, { name: '办公' }); // 家庭 / 11 → 家庭 / 办公
  return r.name === '办公' && r.parent_id === g2.id;
})());
check('移动到已有同名子分组的父级被拒绝', (() => {
  // 家庭 / 办公 挪到 工作 下不冲突；再造一个「家庭 / Backend」挪到「工作」下就该撞车
  const src = db.createGroup({ name: 'Backend', parentId: g2.id });
  try { db.updateGroup(src.id, { parentId: g1.id }); return false; } catch (e) { return /已存在同名分组/.test(e.message); }
})());
check('移动 + 改名后不撞车则允许（独立用例）', (() => {
  const src = db.createGroup({ name: 'Ops', parentId: g2.id });
  const r = db.updateGroup(src.id, { parentId: g1.id, name: 'Ops2' });
  return r.parent_id === g1.id && r.name === 'Ops2';
})());
check('移到顶级时与顶级同名分组冲突被拒绝', (() => {
  try { db.updateGroup(dupA.id, { parentId: null }); return false; } catch (e) { return /已存在同名分组/.test(e.message); }
})());
check('移到顶级 + 改名后允许', (() => {
  const r = db.updateGroup(dupA.id, { parentId: null, name: '11-顶层' });
  return r.parent_id == null && r.name === '11-顶层';
})());
check('空名被拒绝', (() => {
  try { db.createGroup({ name: '   ' }); return false; } catch (e) { return /不能为空/.test(e.message); }
})());

console.log('\n[1.6] 任务附件元数据');
const attTask = db.createTask({ title: '带附件的任务', groupId: g1.id });
const att1 = { id: 'a1', name: '需求说明.docx', size: 1024, mime: 'application/msword', path: `task-${attTask.id}/a1_需求说明.docx`, added_at: new Date().toISOString() };
const att2 = { id: 'a2', name: '截图.png', size: 2048, mime: 'image/png', path: `task-${attTask.id}/a2_截图.png`, added_at: new Date().toISOString() };
const afterAdd = db.setAttachments(attTask.id, [att1, att2]);
check('写入附件元数据', Array.isArray(afterAdd.attachments) && afterAdd.attachments.length === 2);
check('附件元数据随任务读出（normalizeTask 解析 JSON）', db.getTask(attTask.id).attachments[0].name === '需求说明.docx');
const afterRemove = db.setAttachments(attTask.id, [att2]);
check('删除单个附件', afterRemove.attachments.length === 1 && afterRemove.attachments[0].id === 'a2');
check('附件不影响其它字段更新', (() => {
  const t = db.updateTask(attTask.id, { title: '带附件的任务2', notes: '备注' });
  return t.title === '带附件的任务2' && t.attachments.length === 1;
})());
check('子树 id 收集（删除任务时清附件用）', (() => {
  const kid = db.createTask({ title: '子任务', parentId: attTask.id });
  const ids = db.subtreeTaskIds(attTask.id);
  return ids.includes(attTask.id) && ids.includes(kid.id);
})());
check('清空附件', db.setAttachments(attTask.id, []).attachments.length === 0);
// 清理临时任务（含上面建的子任务）：后面的用例按任务数量做断言
db.deleteTask(attTask.id);

// 自定义颜色：不再局限于预设色板，任意 hex 都要原样持久化/归一化
const gCustom = db.createGroup({ name: '自定义色分组', color: '#ff00aa' });
check('自定义颜色原样保存', db.getGroup(gCustom.id).color === '#ff00aa');
db.updateGroup(gCustom.id, { color: '#123ABC' });
check('自定义颜色可改（大写归一化为小写）', db.getGroup(gCustom.id).color === '#123abc');
const gAbbrev = db.createGroup({ name: '缩写色分组', color: '#abc' });
check('三位缩写展开为六位', db.getGroup(gAbbrev.id).color === '#aabbcc');
const gBad = db.createGroup({ name: '非法色分组', color: 'not-a-color' });
check('非法颜色回退默认蓝', /^#[0-9a-f]{6}$/.test(db.getGroup(gBad.id).color || ''));
db.updateGroup(gCustom.id, { name: '自定义色分组' });
check('未传 color 时保留原色', db.getGroup(gCustom.id).color === '#123abc');
check('挂载到自己的子孙被拒绝', (() => {
  try { db.updateGroup(g1.id, { parentId: grand.id }); return false; } catch (e) { return true; }
})());
check('挂到自己被拒绝', (() => {
  try { db.updateGroup(g1.id, { parentId: g1.id }); return false; } catch (e) { return true; }
})());

console.log('\n[2] 标签');
const t1 = db.createTag('紧急');
const t2 = db.createTag('项目A');
check('创建标签', t1.id && t2.id);
check('标签去重', db.createTag('紧急').id === t1.id);

console.log('\n[3] 任务 CRUD（计划日期）');
const task1 = db.createTask({
  title: '写周报', groupId: g1.id, priority: 2,
  planStart: '2026-01-01', planEnd: '2026-10-15', tagIds: [t1.id, t2.id],
});
const task2 = db.createTask({
  title: '买菜', groupId: g2.id, priority: 1, planEnd: '2026-10-20',
});
check('创建任务1（含计划日期）', task1.id && task1.plan_start === '2026-01-01' && task1.plan_end === '2026-10-15' && task1.tag_names.length === 2);
check('创建任务2', task2.id && task2.group_name === '家庭' && task2.plan_end === '2026-10-20');
check('列表查询', db.listTasks({ status: 'all' }).length === 2);
check('搜索命中', db.listTasks({ search: '周报' }).length === 1);
check('按标签筛选', db.listTasks({ tagId: t2.id }).length === 1);
check('按分组筛选', db.listTasks({ groupId: g2.id }).length === 1);

// 父分组筛选要带上所有子分组的任务
const kidTask = db.createTask({ title: '组件文档', groupId: grand.id });
check('按父分组筛选包含子分组任务', db.listTasks({ groupId: g1.id, status: 'all' }).length === 2);
check('按中间层分组筛选包含孙分组任务', db.listTasks({ groupId: child.id, status: 'all' }).length === 1);
check('父分组计数含子孙任务', db.listGroups().find((g) => g.id === g1.id).total_count === 2);

// 层级验证完成，清掉这批临时任务，避免干扰后续按数量断言的用例
db.deleteTask(kidTask.id);

console.log('\n[4] 时间筛选');
check('按计划完成日期上限', db.listTasks({ planEndTo: '2026-10-15' }).length === 1);
check('按计划完成日期下限', db.listTasks({ planEndFrom: '2026-10-16' }).length === 1);
check('按计划开始日期', db.listTasks({ planStartFrom: '2026-01-01', planStartTo: '2026-01-02' }).length === 1);

const updated = db.updateTask(task1.id, { title: '写周报（改）', planEnd: '2026-10-18', planStart: '2026-01-02' });
check('更新任务', updated.title === '写周报（改）' && updated.plan_end === '2026-10-18');

console.log('\n[5] 完成 / 完成时间 / 归档 / 统计');
db.toggleTask(task1.id);
check('标记完成并记录实际完成时间', db.getTask(task1.id).completed === true && !!db.getTask(task1.id).completed_at);
const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
const tomorrowStart = new Date(todayStart.getTime() + 24 * 3600 * 1000);
check('按实际完成时间筛选', db.listTasks({ completedFrom: todayStart.toISOString(), completedTo: tomorrowStart.toISOString() }).length === 1);
db.toggleTask(task1.id);
check('取消完成（清空完成时间）', db.getTask(task1.id).completed === false && db.getTask(task1.id).completed_at === null);
db.toggleTask(task1.id);
db.archiveTask(task1.id);
check('单任务归档', db.getTask(task1.id).archived === true);
db.unarchiveTask(task1.id);
check('取消归档', db.getTask(task1.id).archived === false);

const ov = db.overview();
check('统计概览', ov.total === 2 && ov.completed === 1);
check('趋势天数', db.dailyTrend(7).points.length === 7);

// 统计口径：默认只算主任务；includeSubtasks=true 要把子任务一起算进来
const scopeParent = db.createTask({ title: '口径父任务' });
db.createTask({ title: '口径子任务A', parentId: scopeParent.id });
const scopeSubB = db.createTask({ title: '口径子任务B', parentId: scopeParent.id });
db.toggleTask(scopeSubB.id); // 完成一个子任务：趋势口径也要能算到它
const ovTop = db.overview();
const ovAll = db.overview({ includeSubtasks: true });
check('默认口径不含子任务', ovTop.total === 3 && ovTop.includeSubtasks === false);
check('含子任务口径把子任务计入', ovAll.total === 5 && ovAll.includeSubtasks === true);
check('含子任务口径的完成数包含已完成子任务', ovAll.completed === ovTop.completed + 1);
check('默认口径的完成数不含已完成子任务', ovTop.completed === 1);
check(
  '趋势口径：默认不含子任务 / 开启后计入',
  db.dailyTrend({ range: '7d' }).total < db.dailyTrend({ range: '7d', includeSubtasks: true }).total
);

console.log('\n[6] 数据导入 / 导出');
const exported = db.exportData();
check('导出结构', exported.app === 'todo-desktop' && exported.tasks.length >= 2 && Array.isArray(exported.groups) && Array.isArray(exported.tags));
check('导出不含 apiKey', JSON.stringify(exported.settings).indexOf('apiKey') === -1);
const imp = db.importData(exported);
check('导入恢复数量', imp.tasks === exported.tasks.length && imp.groups === exported.groups.length);
check('导入后可查询', db.listTasks({ status: 'all' }).length === exported.tasks.length);

console.log('\n[7] 子任务');
// 确保父任务初始未完成
if (db.getTask(task1.id).completed) db.toggleTask(task1.id);
const sub1 = db.createTask({ title: '写周报-收集数据', parentId: task1.id });
const sub2 = db.createTask({ title: '写周报-整理数据', parentId: task1.id, attachments: ['data:image/png;base64,AAA'] });
check('创建子任务', sub1.parent_id === task1.id && sub2.parent_id === task1.id);
check('子任务附件存取', Array.isArray(db.getTask(sub2.id).attachments) && db.getTask(sub2.id).attachments.length === 1);
check('主列表包含子任务', db.listTasks({ status: 'all' }).some((t) => t.id === sub1.id));
check('子任务含父任务信息', db.listTasks({ parentId: task1.id }).every((t) => t.parent_title === '写周报（改）'));
check('查询子任务', db.listSubtasks(task1.id).length === 2);
db.toggleTask(sub1.id);
db.toggleTask(sub2.id);
check('所有子任务完成 → 父任务自动完成', db.getTask(task1.id).completed === true);
db.toggleTask(sub1.id);
check('子任务取消完成 → 父任务自动取消完成', db.getTask(task1.id).completed === false);
db.deleteTask(task1.id);
check('删除父任务级联删除子任务', db.getTask(sub1.id) === null && db.getTask(sub2.id) === null);

console.log('\n[7.5] 删除分组的级联行为');
const tParent = db.createGroup({ name: '待删父组', color: '#4f7cff' });
const tChild = db.createGroup({ name: '待删子组', color: '#8b5cf6', parentId: tParent.id });
const tGrandTask = db.createTask({ title: '顶层任务', groupId: tParent.id });
const tChildTask = db.createTask({ title: '子组任务', groupId: tChild.id });
const rm1 = db.deleteGroup(tParent.id);
check('删除父分组连带删除子分组', rm1.deletedGroups === 2 && db.getGroup(tChild.id) === null);
check('组内任务不会被删除（无上级 → 未分组）',
  db.getTask(tGrandTask.id).group_id === null && db.getTask(tChildTask.id).group_id === null);

// 有上级时任务上移一级，而不是变成未分组
const tSub = db.createGroup({ name: '挂 Existing', color: '#06b6d4', parentId: g1.id });
const tSubTask = db.createTask({ title: '上移任务', groupId: tSub.id });
db.deleteGroup(tSub.id);
check('有上级时任务上移到上级分组', db.getTask(tSubTask.id).group_id === g1.id);

console.log('\n[7.6] 会议记录（meetings）');
const m1 = db.createMeeting({ title: '周会', mode: 'audio', source_label: '系统声 + 麦克风', duration_ms: 1800000 });
check('新建会议记录', !!m1 && m1.status === 'recorded' && Array.isArray(m1.media_paths) && m1.media_paths.length === 0);
check('默认标题兜底', db.createMeeting({}).title === '未命名会议');

const m1b = db.updateMeeting(m1.id, { transcript: '甲：本周进度…', status: 'transcribed' });
check('局部更新（转写文本 + 状态）',
  m1b.transcript === '甲：本周进度…' && m1b.status === 'transcribed' && m1b.title === '周会');

const m1c = db.updateMeeting(m1.id, {
  summary: '## 纪要\n- 议题一',
  todos: [{ title: '整理接口文档', assignee: '甲', due: '2026-10-20', priority: 2 }],
  media_paths: ['C:/rec/1.webm', 'C:/rec/2.webm'],
});
check('数组字段序列化/反序列化',
  Array.isArray(m1c.todos) && m1c.todos.length === 1 && m1c.todos[0].title === '整理接口文档'
  && m1c.media_paths.length === 2 && m1c.media_paths[0] === 'C:/rec/1.webm');

// 字段名白名单：注入字段必须被忽略，且不影响其它字段
db.updateMeeting(m1.id, { 'title_x": " hacked': 'x', title: '周会(改)' });
check('非法字段被白名单拦截', db.getMeeting(m1.id).title === '周会(改)' && db.listMeetings().length > 0);

const m2 = db.createMeeting({ title: '评审会', mode: 'screen' });
const list = db.listMeetings();
check('列表按创建时间倒序', list[0].title === '评审会' && list.some((m) => m.id === m1.id));
check('数量正确', list.length === 3); // 含上面那个「未命名会议」

const exportSnap = db.exportData();
check('导出含 meetings 且 schema 升级到 12',
  exportSnap.schemaVersion === 12 && Array.isArray(exportSnap.meetings) && exportSnap.meetings.length === 3
  && Array.isArray(exportSnap.reports) && Array.isArray(exportSnap.ai_searches)
  && Array.isArray(exportSnap.kb_qa)
  && Array.isArray(exportSnap.notes) && Array.isArray(exportSnap.note_folders)
  && Array.isArray(exportSnap.task_notes) && Array.isArray(exportSnap.knowledge_bases));
check('导出保留 todos 与 media_paths', (() => {
  const row = exportSnap.meetings.find((m) => m.id === m1.id);
  return !!row && row.title === '周会(改)' && typeof row.todos === 'string'
    && JSON.parse(row.todos)[0].title === '整理接口文档';
})());

check('删除会议记录', db.deleteMeeting(m2.id) === 1 && db.getMeeting(m2.id) === null);

/**
 * 本地 mock 一个「OpenAI 兼容」的语音服务，用来离线验证转写链路：
 * - transcriptions 正常时走主通道；
 * - transcriptions 返回 404 时（百炼兼容层的常见形态）应自动回退到 chat/completions + base64。
 */
function startMockAsr({ transcriptionsStatus = 200 } = {}) {
  const http = require('http');
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url.split('?')[0];
      hits.push({ url, method: req.method, auth: req.headers.authorization || '' });

      if (url.endsWith('/audio/transcriptions')) {
        if (transcriptionsStatus === 404) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'unknown endpoint' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: `主通道转写结果/${req.method}/${/multipart|form-data/.test(req.headers['content-type'] || '')}` }));
        return;
      }
      if (url.endsWith('/chat/completions')) {
        let payload = null;
        try { payload = JSON.parse(body); } catch (e) { payload = null; }
        const lastMsg = payload && payload.messages && payload.messages.length
          ? payload.messages[payload.messages.length - 1]
          : null;
        const part = lastMsg && Array.isArray(lastMsg.content) ? lastMsg.content[0] : null;
        const head = part && part.input_audio ? String(part.input_audio.data).split(',')[0] : '空';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: `兜底通道收到 ${head}｜model=${payload ? payload.model : '?'}` } }],
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function runAsrChannelTests() {
  const asr = require('../main/asr');
  const wav = path.join(tmpDir, 'asr-sample.wav');
  fs.writeFileSync(wav, Buffer.alloc(2048, 1));

  const ids = asr.ASR_PRESETS.map((p) => p.id);
  check('ASR 预设 id 唯一且非空', new Set(ids).size === ids.length && ids.every(Boolean));
  const domestic = asr.ASR_PRESETS.filter((p) => /siliconflow\.cn|dashscope/.test(p.baseUrl));
  check('内置国内语音服务', domestic.length >= 3 && domestic.every((p) => !!p.model));

  // A. 主通道：multipart /audio/transcriptions
  const a = await startMockAsr();
  const textA = await asr.transcribe({
    baseUrl: `http://127.0.0.1:${a.port}/v1`,
    apiKey: 'sk-test', model: 'whisper-1', filePath: wav, language: 'zh',
  });
  check('主通道 multipart 转写', textA === '主通道转写结果/POST/true');
  check('主通道带 Bearer 鉴权', a.hits[0].auth === 'Bearer sk-test');
  check('主通道不触发回退', a.hits.length === 1);
  await a.close();

  // B. 404 → 自动回退到 chat/completions + base64
  const b = await startMockAsr({ transcriptionsStatus: 404 });
  const textB = await asr.transcribe({
    baseUrl: `http://127.0.0.1:${b.port}/v1`,
    apiKey: 'sk-test', model: 'qwen3-asr-flash', filePath: wav, language: 'zh',
  });
  check('transcriptions 404 时自动回退', b.hits.length === 2
    && b.hits[0].url.endsWith('/audio/transcriptions')
    && b.hits[1].url.endsWith('/chat/completions'));
  check('兜底以 base64 传音频', textB === '兜底通道收到 data:audio/wav;base64｜model=qwen3-asr-flash');
  await b.close();

  // C. 缺 Key / 空文件：必须给出可读报错而不是崩溃
  let msgNoKey = '';
  try {
    await asr.transcribe({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'x', filePath: wav });
  } catch (e) { msgNoKey = e.message; }
  check('缺 Key 抛 NO_ASR_KEY', msgNoKey === 'NO_ASR_KEY');
}

/**
 * 报告文档视图：Markdown → 文档 HTML 的结构断言。
 * 反向（DOM → Markdown）需要真实 DOM，放在 Electron 冒烟里做往返校验。
 */
async function runReportDocTests() {
  const url = require('url').pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'report-doc.js')).href;
  const { mdToDocHtml } = await import(url);
  const docx = require('../main/docx');

  const md = [
    '# 周报标题',
    '',
    '这是**第一段**，含 `代码`。',
    '',
    '## 进展',
    '',
    '- 完成登录模块',
    '- 修复导出问题',
    '',
    '## 明细',
    '',
    '| 任务 | 负责人 | 状态 |',
    '| --- | --- | --- |',
    '| 登录模块 | 张三 | 已完成 |',
    '| 导出功能 | 李四 | 进行中 |',
    '',
    '> 下周重点：稳定性',
    '',
    '1. 先做压测',
    '2. 再做灰度',
  ].join('\n');

  const html = mdToDocHtml(md);
  check('标题渲染为 h1/h2', html.includes('<h1>周报标题</h1>') && html.includes('<h2>进展</h2>'));
  check('段落含强调与行内代码', html.includes('<p>这是<strong>第一段</strong>，含 <code>代码</code>。</p>'));
  check('无序列表保留原始符号', html.includes('<ul data-ul-mark="-"><li>完成登录模块</li><li>修复导出问题</li></ul>'));
  check('有序列表渲染为 ol', html.includes('<ol><li>先做压测</li><li>再做灰度</li></ol>'));
  check('表格渲染为真实 table（含 thead）', html.includes('<table class="rp-table"><thead>')
    && html.includes('<th>任务</th>') && html.includes('<td>已完成</td>'));
  check('表格不含分隔行数据', !html.includes('<td>---</td>') && !html.includes('｜'));
  check('引用渲染为 blockquote', html.includes('<blockquote>下周重点：稳定性</blockquote>'));

  // Word 导出：表格必须是真正的 w:tbl（此前被压成 ｜ 分隔的段落）
  const xml = docx.documentXml(md);
  check('Word 导出含真表格', xml.includes('<w:tbl>') && xml.includes('<w:tblHeader/>'));
  check('Word 表格含单元格文本', xml.includes('已完成') && xml.includes('<w:tcBorders>'));
  check('Word 表格后补了空段落', /<\/w:tbl><w:p\/>/.test(xml));
}

console.log('\n[8] 报告本地生成（无 Key 降级）');
const now = new Date();
const start = new Date(now); start.setHours(0, 0, 0, 0);

(async () => {
  const r = await report.generateReport(
    { type: 'day', customStart: start.toISOString(), customEnd: now.toISOString(), groupId: null },
    { baseUrl: '', apiKey: '', model: '' }
  );
  check('降级报告生成', r.degraded === true && r.markdown.includes('日报'));
  check('报告含完成清单', r.markdown.includes('完成情况'));

  console.log('\n[9] 语音转写通道（本地 mock，不入网）');
  await runAsrChannelTests();

  console.log('\n[10] 报告文档视图（Markdown → 文档 HTML）');
  await runReportDocTests();

  console.log('\n[11] AI 报告自定义提示词');
  const fakeData = {
    completedTasks: [{
      title: '写方案', priority: 2, completed_at: now.toISOString(),
      plan_start: '2026-10-01', plan_end: '2026-10-10',
    }],
    createdTasks: [{ title: '写方案' }],
    activeNow: [{ title: '下月规划', priority: 1, plan_start: '2026-10-20', plan_end: '2026-11-15' }],
    overdue: [],
  };
  const baseArgs = {
    type: 'month',
    start: new Date('2026-10-01T00:00:00'),
    end: new Date('2026-10-31T23:59:59'),
    groupIds: [],
    data: fakeData,
  };
  const extraText = '根据任务的计划完成时间生成下个月的计划';
  const withExtra = report.buildPrompt({ ...baseArgs, extraPrompt: extraText });
  const msgExtra = withExtra[1].content;
  check('自定义要求注入到 prompt', msgExtra.includes('【用户额外要求（务必满足）】') && msgExtra.includes(extraText));
  check('告知模型需新增对应章节', msgExtra.includes('下月计划'));
  check('任务带上计划完成时间（供推演下月）', msgExtra.includes('"planEnd"') && msgExtra.includes('2026-11-15'));
  check('请求仍保持 system + user 两条消息', withExtra.length === 2 && withExtra[0].role === 'system');

  const noExtra = report.buildPrompt(baseArgs);
  check('未填自定义要求时不注入该段', !noExtra[1].content.includes('用户额外要求'));
  const blankExtra = report.buildPrompt({ ...baseArgs, extraPrompt: '   ' });
  check('全空白自定义要求视为未填', !blankExtra[1].content.includes('用户额外要求'));

  const degradedExtra = await report.generateReport(
    { type: 'month', customStart: baseArgs.start.toISOString(), customEnd: baseArgs.end.toISOString(), groupIds: [], extraPrompt: extraText },
    { baseUrl: '', apiKey: '', model: '' }
  );
  check('降级报告明确说明未应用自定义要求',
    degradedExtra.degraded === true && degradedExtra.markdown.includes('未能应用自定义要求'));

  const degradedPlain = await report.generateReport(
    { type: 'month', customStart: baseArgs.start.toISOString(), customEnd: baseArgs.end.toISOString(), groupIds: [], extraPrompt: '' },
    { baseUrl: '', apiKey: '', model: '' }
  );
  check('未填要求时降级报告不出现该说明', !degradedPlain.markdown.includes('未能应用自定义要求'));

  console.log('\n[12] AI 报告 / AI 检索历史持久化');
  const rpt1 = db.createReport({
    title: '月报 2026-10-01 ~ 2026-10-31', type: 'month',
    range_start: '2026-10-01', range_end: '2026-10-31',
    group_ids: [1, 2], group_label: '已选 2 个分组',
    extra_prompt: '生成下月计划', content: '# 月报\n\n正文 A', degraded: true,
  });
  check('报告创建成功并回读', !!rpt1 && rpt1.id > 0 && rpt1.title.includes('月报'));
  check('分组 id 反序列化为数组', Array.isArray(rpt1.group_ids) && rpt1.group_ids.length === 2);
  check('降级标记正确', rpt1.degraded === true);

  const rpt2 = db.createReport({ title: '周报', type: 'week', content: '正文 B' });
  const list2 = db.listReports(50);
  check('列表按创建时间倒序', list2[0].id === rpt2.id && list2.length === 2);
  check('列表不带正文（只给摘要长度）', list2[0].content_len > 0 && list2[0].content === undefined);

  const updated = db.updateReport(rpt2.id, { content: '正文 B（已编辑）' });
  check('编辑后正文更新', updated.content === '正文 B（已编辑）');
  check('编辑不影响另一份报告', db.getReport(rpt1.id).content === '# 月报\n\n正文 A');
  check('非法字段被白名单拦截', (() => {
    const before = db.getReport(rpt2.id).title;
    db.updateReport(rpt2.id, { title: '周报', evil: 'x' });
    return db.getReport(rpt2.id).title === before;
  })());

  const s1 = db.createSearch({
    keyword: '导出', summary: '共 2 个相关任务', task_count: 2,
    tasks: [{ id: 1, title: '导出功能' }, { id: 2, title: '导出报表' }], degraded: false,
  });
  check('检索记录创建成功', !!s1 && s1.id > 0 && s1.keyword === '导出');
  check('任务快照反序列化为数组', Array.isArray(s1.tasks) && s1.tasks.length === 2);
  const sList = db.listSearches(50);
  check('检索历史列表', sList.length === 1 && sList[0].task_count === 2);
  check('列表摘要被截断', (sList[0].summary_excerpt || '').length <= 120);
  check('完整记录可取回全部任务', db.getSearch(s1.id).tasks.length === 2);

  const snap2 = db.exportData();
  check('导出含 reports 与 ai_searches', snap2.reports.length === 2 && snap2.ai_searches.length === 1);

  check('删除报告生效', db.deleteReport(rpt1.id) === 1 && db.getReport(rpt1.id) === null);
  check('删除检索记录生效', db.deleteSearch(s1.id) === 1 && db.getSearch(s1.id) === null);

  console.log('\n[12b] 知识库问答历史（kb_qa）');
  const qa1 = db.createKbQa({
    question: '灰度发布的回滚方案是什么？',
    answer: '回滚分三步 [1]。',
    hits: [{ noteId: 1, title: '发布手册', headingPath: '发布 › 回滚', matchTerm: '回滚', snippet: '回滚步骤…', relevance: 88 }],
    degraded: false,
  });
  check('问答记录创建成功', !!qa1 && qa1.id > 0 && qa1.question.includes('灰度'));
  check('引用片段反序列化为数组', Array.isArray(qa1.hits) && qa1.hits.length === 1 && qa1.hits[0].title === '发布手册');
  check('降级问答也能落库', !!db.createKbQa({ question: '没有命中的问题', answer: '', hits: [], degraded: true, reason: 'no-hit' }));
  const qaList = db.listKbQa(10);
  check('问答历史列表（倒序 + 摘要）', qaList.length === 2 && qaList[0].question.includes('没有命中') && qaList[0].answer === undefined);
  check('完整问答可回看', db.getKbQa(qa1.id).answer.includes('回滚'));
  const qaSnap = db.exportData();
  check('导出含 kb_qa', Array.isArray(qaSnap.kb_qa) && qaSnap.kb_qa.length === 2);
  check('删除问答记录生效', db.deleteKbQa(qa1.id) === 1 && db.getKbQa(qa1.id) === null);

  console.log('\n[12c] 报告统计含子任务（rangeStats）');
  const pg = db.createTask({ title: 'RPT父任务', groupId: null });
  db.createTask({ title: 'RPT子任务A', parentId: pg.id });
  const ps = db.createTask({ title: 'RPT子任务B', parentId: pg.id });
  db.toggleTask(ps.id); // 子任务B标记完成
  const rs = db.rangeStats(new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 3600e3).toISOString(), []);
  check('子任务进入完成清单', rs.completedTasks.some((t) => t.title === 'RPT子任务B'));
  check('进行中统计含未完成子任务', rs.activeNow.some((t) => t.title === 'RPT子任务A'));
  const localMd = report.buildLocalReport('day', new Date(Date.now() - 3600e3), new Date(Date.now() + 3600e3), []);
  check('本地模板列出子任务', localMd.includes('RPT子任务B'));
  check('数量标注含子任务口径', localMd.includes('含子任务'));
  const promptData = db.rangeStats(new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 3600e3).toISOString(), []);
  const promptMsg = report.buildPrompt({
    type: 'day', start: new Date(Date.now() - 3600e3), end: new Date(Date.now() + 3600e3),
    groupIds: [], data: promptData,
  })[1].content;
  check('提示词携带子任务明细', promptMsg.includes('"subtasks"') && promptMsg.includes('RPT子任务B'));

  console.log('\n[13] 任务创建时间（created_at）');
  const ct = db.createTask({ title: '创建时间用例' });
  check('新建任务自动写入创建时间', !!ct.created_at && !Number.isNaN(Date.parse(ct.created_at)));
  const ctFixed = db.createTask({ title: '指定创建时间', createdAt: '2026-01-02T03:04:05.000Z' });
  check('可指定创建时间（导入历史数据保留原值）', db.getTask(ctFixed.id).created_at === '2026-01-02T03:04:05.000Z');
  check('更新任务不改变创建时间', (() => {
    const before = db.getTask(ct.id).created_at;
    db.updateTask(ct.id, { title: '创建时间用例（改）' });
    return db.getTask(ct.id).created_at === before;
  })());
  check('导出保留创建时间', (() => {
    const snap = db.exportData();
    const row = snap.tasks.find((t) => t.id === ctFixed.id);
    return !!row && row.created_at === '2026-01-02T03:04:05.000Z';
  })());
  check('空值走兜底（读路径）', (() => {
    db.getDb().prepare("UPDATE tasks SET created_at = '' WHERE id = ?").run(ct.id);
    const v = db.getTask(ct.id).created_at;
    db.getDb().prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(ct.created_at, ct.id);
    return !!v;
  })());
  // 迁移 v8：老库缺列 / 留空时补列并回填（用独立的临时库模拟，避免污染主用例库）
  check('老库补列 + 回填创建时间（迁移 v8）', (() => {
    const Database = require('better-sqlite3');
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-legacy-'));
    const legacy = new Database(path.join(legacyDir, 'todo.db'));
    legacy.exec(`CREATE TABLE groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#4f7cff', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    // 刻意不建 created_at 列，模拟早期版本 / 手工改过的库
    legacy.exec(`CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER, parent_id INTEGER,
      title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', attachments TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 1, plan_start TEXT, plan_end TEXT,
      reminder_at TEXT, reminder_fired INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL)`);
    // TASK_SELECT 会 JOIN 这两张表，一起建出来
    legacy.exec(`CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#8896ab')`);
    legacy.exec(`CREATE TABLE task_tags (task_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
      PRIMARY KEY (task_id, tag_id))`);
    legacy.pragma('user_version = 7');
    const stamp = '2026-05-06T07:08:09.000Z';
    legacy.prepare('INSERT INTO tasks (title, updated_at) VALUES (?, ?)').run('老任务', stamp);
    legacy.prepare("INSERT INTO tasks (title, updated_at) VALUES ('空更新时间', '')").run();
    legacy.close();

    db.close();
    db.init(legacyDir);
    const r1 = db.getTask(1);
    const r2 = db.getTask(2);
    const ok = !!r1 && r1.created_at === stamp && !!r2 && !!r2.created_at && !Number.isNaN(Date.parse(r2.created_at));
    db.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
    db.init(tmpDir); // 回到主用例库
    return ok;
  })());

  console.log('\n[14] 完成趋势时间范围');
  const TREND_SPEC = { '7d': [7, 'day'], '1m': [30, 'day'], '6m': [26, 'week'], '1y': [12, 'month'] };
  for (const key of Object.keys(TREND_SPEC)) {
    const [n, g] = TREND_SPEC[key];
    const t = db.dailyTrend({ range: key });
    check(`范围 ${key}：${n} 个桶 / 粒度 ${g}`,
      t.range === key && t.granularity === g && t.points.length === n);
  }
  check('未知范围回退到近 7 天', db.dailyTrend({ range: 'zz' }).range === '7d');
  check('旧调用（数字天数）仍兼容',
    db.dailyTrend(7).points.length === 7 && db.dailyTrend(7).granularity === 'day');
  check('返回结构统一（含 total / 边界 / 每个点的 label 与区间）', (() => {
    const t = db.dailyTrend({ range: '1m' });
    return typeof t.total === 'number' && !!t.start && !!t.end && !!t.label
      && t.points.every((p) => typeof p.label === 'string' && typeof p.count === 'number' && !!p.start && !!p.end);
  })());
  check('完成时间计入对应桶', (() => {
    const tk = db.createTask({ title: '趋势用例', completedAt: new Date().toISOString() });
    db.getDb().prepare('UPDATE tasks SET completed = 1 WHERE id = ?').run(tk.id);
    const t = db.dailyTrend({ range: '7d' });
    const last = t.points[t.points.length - 1];
    const ok = last.count >= 1 && t.total >= 1;
    db.deleteTask(tk.id);
    return ok;
  })());
  check('无数据时返回空桶而不是报错', (() => {
    const t = db.dailyTrend({ range: '1y' });
    return Array.isArray(t.points) && t.points.length === 12;
  })());

  console.log('\n[15] 笔记模块：目录 / 标签 / 检索');
  const fRoot = db.createNoteFolder({ name: '技术方案' });
  const fChild = db.createNoteFolder({ name: '前端', parentId: fRoot.id });
  check('创建笔记目录（含层级）', !!fRoot.id && fChild.parent_id === fRoot.id);
  check('同级目录重名被拒绝', (() => {
    try { db.createNoteFolder({ name: '技术方案' }); return false; } catch (e) { return /同名/.test(e.message); }
  })());
  check('不同层级允许同名', db.createNoteFolder({ name: '前端', parentId: fChild.id }).parent_id === fChild.id);
  const md = '# 灰度发布方案\n\n分两批放量，第一批 10%，观察 24 小时。\n\n| 批次 | 比例 |\n| --- | --- |\n| 1 | 10% |\n';
  const n1 = db.createNote({
    title: '灰度发布方案', contentMd: md, folderId: fChild.id, tagIds: [db.createNoteTag('方案').id],
  });
  check('摘要 / 字数 / 内容哈希自动生成',
    n1.word_count > 0 && n1.excerpt.includes('灰度发布') && /^[0-9a-f]{40}$/.test(n1.content_hash));
  const n2 = db.createNote({ title: '复盘：发布事故', contentMd: '事故原因：配置未同步。' });
  check('标签挂在笔记上', (db.getNote(n1.id).tags || []).length === 1);
  const nUpd = db.updateNote(n1.id, { content_md: `${md}\n补充：回滚策略。` });
  check('改正文重算摘要 / 字数 / 哈希',
    nUpd.content_hash !== n1.content_hash && nUpd.word_count > n1.word_count);
  check('只改标题不重算内容哈希', db.updateNote(n1.id, { title: '灰度发布方案 v2' }).content_hash === nUpd.content_hash);
  check('全文检索命中正文（≥3 字走 FTS）', db.searchNotes('灰度发布').some((n) => n.id === n1.id));
  check('短关键词（<3 字）回退 LIKE', db.searchNotes('复盘').some((n) => n.id === n2.id));
  check('归档后不出现在主列表', (() => {
    db.setNoteArchived(n2.id, true);
    return !db.listNotes({ archived: 'exclude' }).some((n) => n.id === n2.id);
  })());
  check('归档笔记仍可被检索', db.searchNotes('配置未同步').some((n) => n.id === n2.id));
  db.setNoteArchived(n2.id, false);
  check('检索结果带匹配次数 / 标题命中 / 命中片段', (() => {
    const hit = db.searchNotes('灰度').find((n) => n.id === n1.id);
    return !!hit && hit.matchCount >= 2 && hit.titleHit === true
      && hit.snippet.includes('灰度') && !('content_md' in hit); // 正文不下发给渲染层
  })());
  check('标题命中的笔记排在最前', (() => {
    const rows = db.searchNotes('灰度');
    return rows.length > 0 && rows[0].id === n1.id;
  })());
  check('多词 / 带空格的查询有模糊兜底（FTS 短语扑空时不返回空）', (() => {
    const rows = db.searchNotes('灰度 方案');
    return rows.some((n) => n.id === n1.id);
  })());
  check('模糊检索返回词元覆盖率', (() => {
    const rows = db.fuzzySearchNotes('灰度 发布策略');
    const hit = rows.find((n) => n.id === n1.id);
    return !!hit && hit.fuzzyScore > 0 && hit.fuzzyScore <= 1;
  })());
  check('颜色 / 高亮标记：不进字数，但保留在摘要里供卡片渲染', (() => {
    const n = db.createNote({ title: '样式用例', contentMd: '这是==重点=={c:#e5484d}内容' });
    const ok = n.excerpt.includes('==重点=={c:#e5484d}') && n.word_count === 6;
    db.purgeNote(n.id);
    return ok;
  })());
  check('目录筛选含子目录', db.listNotes({ folderId: fRoot.id, includeSubfolders: true }).some((n) => n.id === n1.id));
  check('删除目录：笔记移到上级而不是被删', (() => {
    db.deleteNoteFolder(fChild.id);
    return db.getNote(n1.id).folder_id === fRoot.id;
  })());

  console.log('\n[16] 任务 ↔ 笔记（多对多）');
  const tk = db.createTask({ title: '笔记关联用例' });
  db.linkTaskNote(tk.id, n1.id);
  db.linkTaskNote(tk.id, n2.id);
  check('一个任务可引用多篇笔记', db.listTaskNotes(tk.id).length === 2);
  check('重复关联幂等', (() => { db.linkTaskNote(tk.id, n1.id); return db.listTaskNotes(tk.id).length === 2; })());
  check('批量取关联数量（列表徽标用）', db.noteCountsForTasks([tk.id])[tk.id] === 2);
  db.unlinkTaskNote(tk.id, n2.id);
  check('取消关联', db.listTaskNotes(tk.id).length === 1);
  db.setTaskNotes(tk.id, [n1.id, n2.id]);
  check('覆盖式设置引用', db.listTaskNotes(tk.id).length === 2);
  check('按笔记反查引用它的任务', db.listNoteTasks(n1.id).some((t) => t.id === tk.id));
  check('一篇笔记可被多个任务引用', (() => {
    const tk2 = db.createTask({ title: '另一个任务' });
    db.linkTaskNote(tk2.id, n1.id);
    return db.listNoteTasks(n1.id).length === 2;
  })());

  console.log('\n[17] 知识库沉淀与删除策略');
  knowledge.indexNote(n1.id);
  knowledge.indexNote(n2.id);
  check('笔记沉淀为分块并可召回', db.searchKbChunks({ query: '灰度发布' }).some((c) => c.sourceKey === `note:${n1.id}`));
  check('召回结果带笔记 id 与出处', await (async () => {
    const hits = await knowledge.retrieve({ query: '配置未同步', topK: 5 });
    return hits.length > 0 && hits[0].noteId === n2.id && !!hits[0].title;
  })());
  check('召回结果带命中片段与相关度（便于溯源）', await (async () => {
    const hits = await knowledge.retrieve({ query: '灰度发布', topK: 5 });
    return hits.length > 0 && !!hits[0].snippet
      && hits[0].relevance >= 50 && hits[0].relevance <= 100;
  })());
  check('模糊路由参与召回（换序 / 拆分的问法）', await (async () => {
    const hits = await knowledge.retrieve({ query: '灰度 放量策略', topK: 5 });
    return hits.some((h) => String(h.matchedBy || '').includes('fuzzy'));
  })());
  check('知识库统计可读', db.kbStats(1).chunk_count > 0 && db.kbStats(1).indexed_note_count >= 2);
  const trashed = db.trashNote(n1.id);
  check('软删除保留任务引用', !!trashed.deleted_at && db.listNoteTasks(n1.id).length >= 1);
  check('回收站里的笔记不参与检索', !db.searchNotes('灰度发布', { deleted: 'exclude' }).length);
  check('回收站里的笔记不参与知识库召回', (() => {
    knowledge.removeNote(n1.id);
    return !db.searchKbChunks({ query: '灰度发布' }).some((c) => c.sourceKey === `note:${n1.id}`);
  })());
  db.restoreNote(n1.id);
  knowledge.indexNote(n1.id);
  check('恢复后引用与召回都回来',
    db.listNoteTasks(n1.id).length >= 1 && db.searchKbChunks({ query: '灰度发布' }).some((c) => c.sourceKey === `note:${n1.id}`));
  const purged = db.purgeNote(n1.id);
  check('彻底删除：先解除所有任务引用',
    purged.unlinkedTasks.includes(tk.id) && db.getNote(n1.id) === null && db.listTaskNotes(tk.id).length === 1);

  console.log('\n[18] 备份往返（笔记 + 引用 + 索引重建）');
  const backup = db.exportData();
  check('备份含笔记与关联，不含派生分块',
    Array.isArray(backup.notes) && Array.isArray(backup.task_notes)
    && !('kb_chunks' in backup) && !('kb_documents' in backup));
  const before = {
    notes: db.listNotes({ limit: 1000, archived: 'include' }).length,
    links: db.listTaskNotes(tk.id).length,
  };
  db.importData(JSON.parse(JSON.stringify(backup)));
  check('导入后笔记与引用完整保留',
    db.listNotes({ limit: 1000, archived: 'include' }).length === before.notes
    && db.listTaskNotes(tk.id).length === before.links);
  const rebuilt = knowledge.indexAll();
  check('导入后可按正文重建知识库索引', rebuilt.done >= 1 && db.kbStats(1).chunk_count > 0);

  console.log('\n[19] 笔记图片附件（复用 attachments 落盘规则）');
  attachments.init(path.join(tmpDir, 'attachments'));
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const noteForImg = db.createNote({ title: '带图笔记', contentMd: '# 标题\n\n正文' });
  const imgEntry = attachments.importDataUrl('note', noteForImg.id, png1x1, '截图.png');
  check('图片落盘到 note-<id> 目录',
    imgEntry.path.startsWith(`note-${noteForImg.id}/`) && fs.existsSync(path.join(tmpDir, 'attachments', imgEntry.path)));
  db.setNoteAttachments(noteForImg.id, [imgEntry]);
  check('附件元数据进出库一致',
    db.getNoteAttachments(noteForImg.id).length === 1
    && db.getNote(noteForImg.id).attachments.length === 1);
  check('todo-media 只解析附件目录内的相对路径',
    attachments.resolveMedia(imgEntry.path) !== null
    && attachments.resolveMedia('../../evil.png') === null
    && attachments.resolveMedia('task-1/../../x.png') === null);
  check('非图片 / 空数据被拒绝', (() => {
    try { attachments.importDataUrl('note', noteForImg.id, 'data:text/plain;base64,aaaa', 'a.txt'); return false; } catch (e) { /* 预期 */ }
    try { attachments.importDataUrl('note', noteForImg.id, 'not-a-data-url'); return false; } catch (e) { return true; }
  })());
  attachments.removeOwnerDir('note', noteForImg.id);
  check('彻底删除笔记时图片目录一并清掉', !fs.existsSync(path.join(tmpDir, 'attachments', `note-${noteForImg.id}`)));
  check('任务附件目录仍是 task-<id>', (() => {
    const e = attachments.importInto('task', 999, path.join(tmpDir, 'todo.db'));
    const ok = e.path.startsWith('task-999/');
    attachments.removeOwnerDir('task', 999);
    return ok;
  })());

  console.log('\n[20] 智能检索（无 AI 时的降级路径）');
  const qNote = db.createNote({ title: '灰度发布方案', contentMd: '## 放量节奏\n\n第一批放量 10%，观察 24 小时。' });
  knowledge.indexNote(qNote.id);
  const noAiHits = await knowledge.retrieve({ query: '放量节奏', topK: 5 });
  check('无 AI 配置也能多路召回', noAiHits.length > 0 && noAiHits.some((h) => h.noteId === qNote.id));
  check('召回结果带命中来源标记', noAiHits.every((h) => typeof h.matchedBy === 'string' && h.matchedBy.length > 0));
  check('未配置 AI 时查询改写原样返回', (await knowledge.expandQuery('放量节奏', {})).join('|') === '放量节奏');
  check('重排在候选不足时不调用模型', (await knowledge.rerankWithAI('x', [], {})) === null);
  const shortQ = await knowledge.retrieve({ query: '灰度', topK: 5 });
  check('短查询（<3 字）走 LIKE 兜底也能命中', shortQ.length > 0);

  console.log('\n[21] 对外同步导出（任务 CSV/MD、笔记 MD/ZIP）');
  const sync = require('../main/sync');
  const syncRoot = db.createGroup({ name: '同步-父分组' });
  const syncKid = db.createGroup({ name: '同步-子分组', parentId: syncRoot.id });
  db.createGroup({ name: '同步-另一个' });
  db.createTask({ title: '父组任务A', groupId: syncRoot.id, priority: 3, tagIds: [] });
  db.createTask({ title: '子组任务B', groupId: syncKid.id, priority: 1 });
  const syncOther = db.listGroups().find((g) => g.name === '同步-另一个');
  db.createTask({ title: '另一组任务C', groupId: syncOther.id });
  const doneTask = db.createTask({ title: '已完成D', groupId: syncRoot.id });
  db.toggleTask(doneTask.id); // 走与界面一致的完成入口，completed / completed_at 一起落库

  const tRows = sync.collectTasks({ status: 'all' });
  const mine = tRows.filter((r) => String(r.group).startsWith('同步'));
  const seq = mine.map((r) => r.group);
  const kidAt = seq.indexOf('同步-父分组 / 同步-子分组');
  const otherAt = seq.indexOf('同步-另一个');
  check('任务按分组树顺序导出（父组整块排完才到它的子组）',
    mine.length === 4 && seq[0] === '同步-父分组' && kidAt > 0
    && seq.slice(0, kidAt).every((g) => g === '同步-父分组')
    && otherAt > kidAt);
  check('任务字段落到导出行里（优先级 / 状态 / 分组）',
    mine.some((r) => r.title === '父组任务A' && r.priority === '紧急')
    && mine.some((r) => r.title === '已完成D' && r.status === '已完成'));
  check('只导出进行中时不带已完成任务',
    sync.collectTasks({ status: 'active' }).every((r) => r.status !== '已完成'));
  const mdOut = sync.tasksToMarkdown(tRows, { status: 'all' });
  check('Markdown 导出是表格且带标题',
    mdOut.startsWith('# 任务导出') && mdOut.includes('| 标题 | 分组 | 优先级 |') && mdOut.split('\n').length > 5);
  const csvOut = sync.tasksToCsv(tRows, { status: 'all' });
  check('CSV 带 BOM 且表头完整（可直接导入在线表格）',
    csvOut.charCodeAt(0) === 0xfeff && csvOut.includes('"标题","分组","优先级"'));
  check('CSV 单元格里的逗号 / 引号被正确转义', (() => {
    const one = sync.tasksToCsv([{ title: 'a,b "x"', group: 'g', priority: '中', status: '进行中',
      planStart: '', planEnd: '', completedAt: '', tags: '', subtasks: '', parent: '', notes: '' }]);
    return one.includes('"a,b ""x"""');
  })());

  const syncFolder = db.createNoteFolder({ name: '同步-目录' });
  db.createNote({
    title: '同步笔记/含斜杠',
    contentMd: '# 标题\n\n带==高亮=={c:#e5484d;bg:#fff} 的正文',
    folderId: syncFolder.id,
  });
  db.createNote({ title: '另一篇', contentMd: '普通正文', folderId: syncFolder.id });
  const nEntries = sync.collectNotes({ folderId: syncFolder.id });
  check('笔记导出带上目录层级并去掉高亮标记',
    nEntries.length === 2
    && nEntries.every((e) => e.folderPath === '同步-目录')
    && !nEntries.some((e) => e.md.includes('{c:#e5484d')));
  const singleMd = sync.notesToSingleMarkdown(nEntries);
  check('单文件笔记导出含每篇标题', singleMd.includes('## 同步笔记/含斜杠') && singleMd.includes('## 另一篇'));
  const zipBuf = sync.notesToZip(nEntries);
  // 文件名在 ZIP 头里是明文（UTF-8），直接按字节找，别用 latin1 比中文
  const hasName = zipBuf.indexOf(Buffer.from('同步笔记_含斜杠.md', 'utf8')) > 0;
  check('笔记压缩包是合法 ZIP 且文件名已清洗',
    zipBuf.slice(0, 2).toString('latin1') === 'PK' && hasName && zipBuf.length > 200);
  check('导出文件名带时间戳', /^Knodo-任务-\d{8}-\d{4}\.csv$/.test(sync.defaultName('任务', 'csv')));

  console.log('\n====================');
  console.log(`结果：${passed} 通过，${failed} 失败`);
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
})();
