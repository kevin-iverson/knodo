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
const g1 = db.createGroup({ name: '工作', color: '#4f7cff' });
const g2 = db.createGroup({ name: '生活', color: '#23b07e' });
check('默认分组 + 新建分组', db.listGroups().length >= 4);
db.updateGroup(g2.id, { name: '家庭', color: '#f59e0b' });
check('更新分组', db.getGroup(g2.id).name === '家庭');

// 子分组层级
const child = db.createGroup({ name: '前端', color: '#8b5cf6', parentId: g1.id });
const grand = db.createGroup({ name: '组件库', color: '#06b6d4', parentId: child.id });
check('创建子分组', child.parent_id === g1.id && grand.parent_id === child.id);
check('子孙集合（多层）', db.descendantGroupIds(g1.id).sort().join(',') === [child.id, grand.id].sort().join(','));
check('分组展开含自身', db.expandGroupIds([g1.id]).length === 3);

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
check('导出含 meetings 且 schema 升级到 8',
  exportSnap.schemaVersion === 8 && Array.isArray(exportSnap.meetings) && exportSnap.meetings.length === 3
  && Array.isArray(exportSnap.reports) && Array.isArray(exportSnap.ai_searches));
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

  console.log('\n====================');
  console.log(`结果：${passed} 通过，${failed} 失败`);
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
})();
