'use strict';
/**
 * 两项新功能的端到端验证（开发辅助脚本，非应用运行时依赖）：
 *  1) 知识库问答界面与 AI 检索同构：两栏骨架、860 宽、遮罩/Esc 不关、可缩放配置、
 *     空态示例 chips、历史栏、引用结果可点开原文。
 *  2) 日历右栏就地新增 / 编辑：顶栏工具区收起；选中日期后右栏有「＋ 新增任务」
 *     与各行的「✎」按钮；点击就地出编辑器（不弹窗），日期预填选中日，
 *     建 / 改都能写库并落到该日期；双击格子不再弹窗。
 * 用法：node scripts/verify-kb-calendar-panel.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const port = '9479';
const profile = path.join(os.tmpdir(), `knodo-kbcal-${Date.now()}`);
const shotDir = path.join(root, '.tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = require('electron');

if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [
  root,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

let log = '';
child.stdout.on('data', (b) => { log += b.toString(); });
child.stderr.on('data', (b) => { log += b.toString(); });

function cleanup() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}

async function pages() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) return list;
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('CDP 连接超时');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`WS 失败：${e && e.message}`));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    evaluate: (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      .then((r) => {
        if (r.exceptionDetails) {
          throw new Error('页面异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
        }
        return r.result && r.result.value;
      }),
    shot: async (file) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    close: () => ws.close(),
  };
}

(async () => {
  const results = [];
  const ok = (name, pass, extra) => {
    results.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra).slice(0, 240) });
  };
  try {
    const list = await pages();
    const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    const page = await connect(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await sleep(1400);

    /* ---------- 1. 知识库问答界面 ---------- */
    await page.evaluate(`document.querySelector('.sidebar [data-view="notes"]').click()`);
    await sleep(700);
    await page.evaluate(`document.querySelector('[data-nt="kb"]').click()`);
    await sleep(900);
    await page.shot(path.join(shotDir, 'kbcal-1-kb-empty.png'));

    const kb = await page.evaluate(`(() => {
      const modal = document.querySelector('.modal-mask .modal-kb');
      if (!modal) return { missing: true };
      const body = modal.querySelector('.modal-body');
      const panel = modal.querySelector('.search-panel');
      const side = modal.querySelector('.search-side');
      const stage = modal.querySelector('.search-stage');
      const hero = modal.querySelector('.search-field');
      const empty = modal.querySelector('#kb-empty');
      const mr = modal.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      const hr = hero.getBoundingClientRect();
      const er = empty.getBoundingClientRect();
      const cs = getComputedStyle(body);
      return {
        modalW: Math.round(mr.width),
        innerW: Math.round(body.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
        panelW: Math.round(pr.width),
        heroW: Math.round(hr.width),
        sideW: Math.round(side.getBoundingClientRect().width),
        stageW: Math.round(stage.getBoundingClientRect().width),
        emptyH: Math.round(er.height),
        stageFill: Math.round(stage.getBoundingClientRect().height - er.height),
        chips: modal.querySelectorAll('.se-chip').length,
        historyHead: (modal.querySelector('.sh-title') || {}).textContent || '',
        resizeHandle: !!modal.querySelector('.modal-resize'),
        footHint: (modal.querySelector('.search-foot-hint') || {}).textContent || '',
      };
    })()`);
    ok('知识库弹窗存在', kb && !kb.missing, JSON.stringify(kb));
    ok('知识库弹窗宽度 ~860（与 AI 检索一致）', kb && Math.abs(kb.modalW - 860) <= 2, JSON.stringify(kb));
    ok('知识库骨架铺满（不再缩成一条）', kb && kb.panelW >= kb.innerW - 2 && kb.heroW > 400, JSON.stringify(kb));
    ok('知识库两栏：历史 210 + 结果区自适应', kb && kb.sideW >= 200 && kb.stageW > 400, JSON.stringify(kb));
    ok('知识库空态填满右栏', kb && kb.emptyH > 300 && kb.stageFill <= 2, JSON.stringify(kb));
    ok('知识库空态有示例问题 chips', kb && kb.chips >= 3, JSON.stringify(kb));
    ok('知识库左栏是提问历史', kb && /历史/.test(kb.historyHead), JSON.stringify(kb));
    ok('知识库可缩放（尺寸记忆手柄）', kb && kb.resizeHandle, JSON.stringify(kb));
    ok('知识库底部有关闭说明', kb && /关闭/.test(kb.footHint), JSON.stringify(kb));

    await page.evaluate(`document.querySelector('.modal-mask').click()`);
    await sleep(300);
    ok('知识库点遮罩不关窗', await page.evaluate(`!!document.querySelector('.modal-mask .modal-kb')`));
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    ok('知识库按 Esc 不关窗', await page.evaluate(`!!document.querySelector('.modal-mask .modal-kb')`));

    await page.evaluate(`document.querySelector('.modal-mask .modal-kb [data-modal="close"]').click()`);
    await sleep(400);
    ok('知识库 ✕ 能关窗', !(await page.evaluate(`!!document.querySelector('.modal-mask .modal-kb')`)));

    /* ---------- 2. 日历顶栏收起 + 双击不再弹窗 ---------- */
    await page.evaluate(`document.querySelector('.tb-nav [data-view="calendar"]').click()`);
    await sleep(1000);
    const before = await page.evaluate(`(async () => (await window.api.tasks.list({ status: 'any' })).length)()`);
    const top = await page.evaluate(`(() => ({
      hidden: !!document.querySelector('.topbar-right').hidden,
      addBtn: !!document.querySelector('.cal-panel-add-btn'),
      editBtns: document.querySelectorAll('.cal-panel-row [data-cal-act="edit"]').length,
      rows: document.querySelectorAll('.cal-panel-row').length,
      selected: (document.querySelector('.cal-cell.is-selected') || {}).dataset?.date || '',
    }))()`);
    ok('日历隐藏顶栏工具区', top.hidden, JSON.stringify(top));
    ok('右栏有「＋ 新增任务」按钮', top.addBtn, JSON.stringify(top));
    ok('空日右栏无任务行属正常', top.editBtns === top.rows, JSON.stringify(top));

    // 双击格子空区域：不再弹窗
    const dbl = await page.evaluate(`(() => {
      const cell = document.querySelector('.cal-cell.is-today') || document.querySelector('.cal-cell');
      if (!cell) return { missing: true };
      const r = (cell.querySelector('.cal-daynum') || cell).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), date: cell.dataset.date };
    })()`);
    ok('日历格子可定位', dbl && !dbl.missing, JSON.stringify(dbl));
    if (dbl && !dbl.missing) {
      await page.evaluate(`(() => {
        const el = document.elementFromPoint(${dbl.x}, ${dbl.y});
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, clientX: ${dbl.x}, clientY: ${dbl.y} }));
      })()`);
      await sleep(600);
      ok('双击格子不再弹窗', await page.evaluate(`!document.querySelector('.modal-mask')`));
    }

    /* ---------- 3. 右栏就地新增 ---------- */
    await page.evaluate(`document.querySelector('.cal-panel-add-btn').click()`);
    await sleep(500);
    const edNew = await page.evaluate(`(() => {
      const box = document.querySelector('.cal-right .cal-editor');
      if (!box) return { missing: true };
      const sel = (document.querySelector('.cal-cell.is-selected') || {}).dataset?.date || '';
      const end = box.querySelector('[data-cal-ed="planEnd"]');
      return {
        inPanel: true,
        noModal: !document.querySelector('.modal-mask'),
        head: (box.querySelector('.cal-editor-head') || {}).textContent || '',
        prefilled: end ? end.value : '',
        selected: sel,
      };
    })()`);
    ok('点「＋ 新增任务」右栏就地出现编辑器', edNew && !edNew.missing && edNew.inPanel, JSON.stringify(edNew));
    ok('就地新增不弹窗', edNew && edNew.noModal, JSON.stringify(edNew));
    ok('编辑器标题为「新增任务」', edNew && /新增任务/.test(edNew.head), JSON.stringify(edNew));
    ok('新增日期预填选中日', edNew && edNew.prefilled === edNew.selected, JSON.stringify(edNew));

    if (edNew && !edNew.missing) {
      await page.evaluate(`(() => {
        const box = document.querySelector('.cal-right .cal-editor');
        box.querySelector('[data-cal-ed="title"]').value = '右栏新建验证任务';
        box.querySelector('[data-cal-act="editor-save"]').click();
      })()`);
      await sleep(1000);
      const after = await page.evaluate(`(async () => {
        const all = await window.api.tasks.list({ status: 'any' });
        const t = all.find((x) => x.title === '右栏新建验证任务');
        return { count: all.length, found: !!t, end: t && t.plan_end, editorGone: !document.querySelector('.cal-editor') };
      })()`);
      ok('右栏新建：任务写库成功', after && after.found && after.count === before + 1, JSON.stringify({ before, after }));
      ok('右栏新建：任务落在选中日', after && after.end === edNew.selected, JSON.stringify(after));
      ok('建完编辑器自动收起', after && after.editorGone, JSON.stringify(after));
    }

    /* ---------- 4. 右栏行内编辑 ---------- */
    const editTarget = await page.evaluate(`(() => {
      const row = document.querySelector('.cal-panel-row [data-cal-act="edit"]');
      if (!row) return { missing: true };
      const rowEl = row.closest('.cal-panel-row');
      return { id: Number(row.dataset.taskId), title: (rowEl.querySelector('.cal-panel-title') || {}).textContent || '' };
    })()`);
    ok('有任务时右栏每行都有 ✎ 编辑按钮', editTarget && !editTarget.missing, JSON.stringify(editTarget));
    if (editTarget && !editTarget.missing) {
      await page.evaluate(`document.querySelector('.cal-panel-row [data-cal-act="edit"]').click()`);
      await sleep(500);
      const formEdit = await page.evaluate(`(() => {
        const box = document.querySelector('.cal-right .cal-editor');
        if (!box) return { missing: true };
        return {
          head: (box.querySelector('.cal-editor-head') || {}).textContent || '',
          titleVal: (box.querySelector('[data-cal-ed="title"]') || {}).value || '',
          noModal: !document.querySelector('.modal-mask'),
        };
      })()`);
      ok('点 ✎ 右栏就地出现编辑表单', formEdit && !formEdit.missing && /编辑任务/.test(formEdit.head), JSON.stringify(formEdit));
      ok('编辑不弹窗', formEdit && formEdit.noModal, JSON.stringify(formEdit));
      ok('编辑器回填原标题', formEdit && formEdit.titleVal.length > 0, JSON.stringify(formEdit));

      if (formEdit && !formEdit.missing) {
        await page.evaluate(`(() => {
          const box = document.querySelector('.cal-right .cal-editor');
          const el = box.querySelector('[data-cal-ed="title"]');
          el.value = el.value + '（已编辑）';
          box.querySelector('[data-cal-act="editor-save"]').click();
        })()`);
        await sleep(1000);
        const renamed = await page.evaluate(`(async () => {
          const all = await window.api.tasks.list({ status: 'any' });
          return all.some((x) => /（已编辑）$/.test(x.title));
        })()`);
        ok('右栏编辑：标题写库成功', renamed, JSON.stringify({ renamed }));
        // 清理本次新建的任务
        await page.evaluate(`(async () => {
          const all = await window.api.tasks.list({ status: 'any' });
          const t = all.find((x) => x.title === '右栏新建验证任务');
          if (t) await window.api.tasks.remove(t.id);
        })()`);
      }
    }

    // 关闭抽屉（若有）后确认无未捕获异常
    const errs = (log.match(/Uncaught|TypeError|ReferenceError/g) || []).length;
    ok('运行期没有未捕获异常', errs === 0, `异常计数=${errs}`);

    page.close();
  } catch (e) {
    ok('脚本执行', false, (e && e.message) || String(e));
  } finally {
    const pass = results.filter((r) => r.pass).length;
    results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? `  ·  ${r.extra}` : ''}`));
    console.log(`\n${pass}/${results.length} 通过`);
    if (process.env.SHOW_LOG) console.log(log.slice(-3000));
    cleanup();
    process.exit(pass === results.length ? 0 : 1);
  }
})();
