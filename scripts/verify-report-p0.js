'use strict';
/**
 * P0 报告增强的针对性验证（不依赖 Electron / 不入网，可直接用 Node 运行）。
 * 用法：node scripts/verify-report-p0.js
 *
 * 覆盖 smoke-db.js 未触及的本次新增行为：
 *  - 数据面扩展：任务描述 / 标签进入 Prompt
 *  - 生成元数据：model / tokens / duration_ms / degraded_reason 落库与回读
 *  - 降级模板智能化：可识别的自定义要求生成对应章节
 *  - 流式调用：SSE 解析、delta 累积、usage 统计、参数降级
 *  - 重试与进度：瞬时失败重试、进度事件序列、取消错误语义
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const db = require('../main/db');
const report = require('../main/report');
const ai = require('../main/ai');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-report-p0-'));
console.log('临时数据库目录:', tmpDir);
db.init(tmpDir);

(async () => {
  /* ---------- 1. 数据面扩展 ---------- */
  console.log('\n[1] 数据面扩展：描述 / 标签进入 Prompt');
  const g = db.listGroups().find((x) => x.name === '工作' && x.parent_id == null);
  const tag = db.createTag('P0验证标签', '#4f7cff');
  const t1 = db.createTask({
    title: 'P0-带描述的完成项',
    groupId: g.id,
    notes: '<p>这是任务描述里的关键信息 <b>包含HTML标签</b></p>',
    priority: 2,
  });
  // setTaskTags 未对外导出，直接写关联表，保证验证贴合数据层真实契约
  db.getDb().prepare('INSERT OR REPLACE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(t1.id, tag.id);
  db.toggleTask(t1.id); // 完成，进入已完成任务清单

  const from = new Date(Date.now() - 3600e3);
  const to = new Date(Date.now() + 3600e3);
  const data = db.rangeStats(from.toISOString(), to.toISOString(), []);
  const msg = report.buildPrompt({
    type: 'day', start: from, end: to, groupIds: [], data, extraPrompt: '',
  })[1].content;
  check('prompt 含字段说明（note / tags）', msg.includes('note 是任务描述摘要') && msg.includes('tags 是任务标签'));
  check('任务描述清洗 HTML 后进入 prompt', msg.includes('这是任务描述里的关键信息') && !msg.includes('<b>'));
  check('任务标签进入 prompt', msg.includes('P0验证标签'));
  check('批量标签查询对空 id 安全', db.tagNamesByTaskIds([]).size === 0);

  /* ---------- 2. 降级模板智能化 ---------- */
  console.log('\n[2] 降级模板智能化：可识别要求生成章节');
  const smartMd = report.buildLocalReport('week', from, to, [], '请用表格列出风险，并给出下一步计划');
  check('风险表格章节生成', smartMd.includes('## 五、问题与风险（表格）') && smartMd.includes('| 类型 | 任务 | 截止 |'));
  check('下一步计划章节生成', smartMd.includes('## 六、下一步计划'));
  check('已应用要求被明确标注', smartMd.includes('已应用自定义要求'));
  // 完全由可识别关键词组成的要求，剔除后应为零残留，不能同时说「已应用」又说「未应用」
  const fullyMatched = report.buildLocalReport('week', from, to, [], '表格列出风险，给出下一步计划');
  check('完全识别的要求不出现「未能应用」', !fullyMatched.includes('未能应用自定义要求'));
  const plainMd = report.buildLocalReport('week', from, to, [], '');
  check('无要求时不追加增强章节', !plainMd.includes('已应用自定义要求') && !plainMd.includes('问题与风险（表格）'));
  check('智能小结含完成率数字', plainMd.includes('完成率'));

  /* ---------- 3. 生成元数据落库与回读 ---------- */
  console.log('\n[3] 生成元数据：落库 / 回读 / 白名单');
  const degraded = await report.generateReport(
    { type: 'day', customStart: from.toISOString(), customEnd: to.toISOString(), groupIds: [], extraPrompt: '' },
    { baseUrl: '', apiKey: '', model: '' },
  );
  check('降级结果带 meta', !!degraded.meta && typeof degraded.meta.duration_ms === 'number');
  check('降级原因写入 meta 与 reason', degraded.meta.degraded_reason === degraded.reason && !!degraded.reason);
  const rec = db.createReport({
    title: 'P0元数据报告', type: 'day', content: degraded.markdown, degraded: true,
    model: 'deepseek-chat', temperature: 0.4, prompt_version: degraded.meta.prompt_version,
    tokens: 123, duration_ms: 456, degraded_reason: degraded.reason,
  });
  const got = db.getReport(rec.id);
  check('model 落库回读', got.model === 'deepseek-chat');
  check('tokens / duration_ms 为数字', got.tokens === 123 && got.duration_ms === 456);
  check('提示词版本落库回读', got.prompt_version === report.PROMPT_VERSION);
  check('列表也带元数据', (() => {
    const row = db.listReports(10).find((r) => r.id === rec.id);
    return row && row.model === 'deepseek-chat' && row.tokens === 123;
  })());
  db.updateReport(rec.id, { tokens: 999, model: 'gpt-4o-mini' });
  const updated = db.getReport(rec.id);
  check('数值字段局部更新正确', updated.tokens === 999 && updated.model === 'gpt-4o-mini');
  check('非法字段仍被白名单拦截', db.updateReport(rec.id, { evil: 'x' }).evil === undefined);

  /* ---------- 4. 流式调用：SSE 解析 / usage / 参数降级 ---------- */
  console.log('\n[4] 流式调用：SSE 解析 / usage / 参数降级');
  const realFetch = global.fetch;
  try {
    // mock：带 stream_options 的第一次请求返回 400（模拟网关不认该参数），去掉后返回 SSE 流
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.stream_options) {
        return {
          ok: false, status: 400,
          text: async () => 'Unknown parameter: stream_options',
        };
      }
      const sse = [
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '第一' } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '段' } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '内容' } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const chunks = [sse.slice(0, 40), sse.slice(40, 90), sse.slice(90)];
      let i = 0;
      return {
        ok: true, status: 200,
        body: {
          getReader() {
            return {
              async read() {
                if (i >= chunks.length) return { done: true, value: undefined };
                return { done: false, value: new TextEncoder().encode(chunks[i++]) };
              },
            };
          },
        },
      };
    };
    const deltas = [];
    const streamed = await ai.callLLMStream({
      baseUrl: 'https://mock.local/v1', apiKey: 'test', model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (c) => deltas.push(c),
      timeoutMs: 5000,
    });
    check('流式内容正确拼接', streamed.content === '第一段内容');
    check('delta 事件逐段推送', deltas.filter((d) => d.type === 'delta').length === 3);
    check('usage 统计解析', streamed.usage && streamed.usage.totalTokens === 15);
    check('参数降级后仍成功（mock 第二次请求无 stream_options）', deltas.some((d) => d.type === 'done'));
  } finally {
    global.fetch = realFetch;
  }

  /* ---------- 5. 重试与进度事件 ---------- */
  console.log('\n[5] 重试与进度：瞬时失败重试 / 事件序列');
  const realFetch2 = global.fetch;
  try {
    let attempt = 0;
    global.fetch = async () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error('network timeout');
        err.name = 'AbortError';
        throw err;
      }
      const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '重试成功' } }] }) + '\n\ndata: [DONE]\n\n';
      return {
        ok: true, status: 200,
        body: { getReader() { let done = false; return { async read() {
          if (done) return { done: true, value: undefined };
          done = true; return { done: false, value: new TextEncoder().encode(sse) };
        } }; } },
      };
    };
    const events = [];
    const retried = await report.generateReport(
      { type: 'day', customStart: from.toISOString(), customEnd: to.toISOString(), groupIds: [], extraPrompt: '' },
      { baseUrl: 'https://mock.local/v1', apiKey: 'test', model: 'mock-model' },
      { onProgress: (e) => events.push(e) },
    );
    check('瞬时失败后重试成功', !retried.degraded && retried.markdown === '重试成功');
    check('进度事件含 attempt / retry', events.some((e) => e.phase === 'attempt') && events.some((e) => e.phase === 'retry'));
    check('成功结果 tokens 统计（mock 无 usage 时为 0）', retried.meta.tokens === 0);
  } finally {
    global.fetch = realFetch2;
  }

  console.log('\n====================');
  console.log(`结果：${passed} 通过，${failed} 失败`);
  db.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('验证脚本异常:', e);
  try { db.close(); } catch (err) { /* 忽略 */ }
  process.exit(1);
});
