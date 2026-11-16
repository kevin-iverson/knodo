'use strict';
/**
 * `worklog:*` IPC 注册 / 注销。
 *
 * 铁律（RK-01）：register() 前必须先 removeHandler —— 关闭再开启时，
 * 残留的 handler 会让 register 抛 "Attempted to register a second handler"。
 * 这也是「关→开→关→开」验收脚本存在的理由。
 */
const { ipcMain, BrowserWindow } = require('electron');
const db = require('../db');
const store = require('./store');
const service = require('./service');
const exporter = require('./export');

const CHANNELS = [
  'worklog:state',
  'worklog:start',
  'worklog:pause',
  'worklog:resume',
  'worklog:stop',
  'worklog:task',
  'worklog:range',
  'worklog:rangeEntries',
  'worklog:manualAdd',
  'worklog:entryDelete',
  'worklog:export',
  'worklog:notices',
  'worklog:openZen',
  // 工时记薪（时间价值）
  'worklog:rates',
  'worklog:rateSet',
  'worklog:rateDelete',
  'worklog:pay',
  'worklog:entryBillable',
];

let notices = [];

function wrap(fn) {
  return async (_e, ...args) => {
    try {
      if (!db.isReady()) throw new Error(`数据库未就绪${db.getInitError() ? '：' + db.getInitError() : ''}`);
      return await fn(...args);
    } catch (e) {
      console.error('[worklog:ipc]', e && e.message);
      return { __error: (e && e.message) || String(e) };
    }
  };
}

function register() {
  unregister();

  ipcMain.handle('worklog:state', wrap(() => service.getState()));

  ipcMain.handle('worklog:start', wrap((p) => service.start(p || {})));

  ipcMain.handle('worklog:pause', wrap(() => service.pause()));
  ipcMain.handle('worklog:resume', wrap(() => service.resume()));
  ipcMain.handle('worklog:stop', wrap(() => service.stop()));

  /** 详情工时块：双口径 + 记录 + 直接子任务贡献（与视图同一个 aggregate 出口） */
  ipcMain.handle('worklog:task', wrap((taskId) => {
    const id = Number(taskId);
    if (!Number.isFinite(id)) throw new Error('任务 id 无效');
    const rows = store.aggregate();
    const row = rows.find((r) => Number(r.id) === id) || null;
    return {
      ownSec: row ? Number(row.own_sec) || 0 : 0,
      aggSec: row ? Number(row.subtree_sec) || 0 : 0,
      ownCnt: row ? Number(row.own_cnt) || 0 : 0,
      children: rows
        .filter((r) => Number(r.parent_id) === id)
        .map((r) => ({
          id: Number(r.id),
          title: r.title,
          ownSec: Number(r.own_sec) || 0,
          aggSec: Number(r.subtree_sec) || 0,
          color: r.group_color || '',
        })),
      entries: store.listEntries(id).map((e) => ({
        id: e.id,
        startedAt: e.started_at,
        endedAt: e.ended_at,
        sec: e.duration_sec,
        source: e.source,
        note: e.note || '',
      })),
    };
  }));

  /** 视图页：一次拿全树（own + subtree），界面只管排版，不再自己求和 */
  ipcMain.handle('worklog:range', wrap((p) => {
    const { from, to } = p || {};
    return store.aggregate({
      from: from || store.ALL_FROM,
      to: to || store.ALL_TO,
    }).map((r) => ({
      id: Number(r.id),
      parentId: r.parent_id == null ? null : Number(r.parent_id),
      title: r.title,
      completed: !!r.completed,
      groupId: r.group_id == null ? null : Number(r.group_id),
      groupName: r.group_name || '',
      groupColor: r.group_color || '',
      ownSec: Number(r.own_sec) || 0,
      ownCnt: Number(r.own_cnt) || 0,
      aggSec: Number(r.subtree_sec) || 0,
      tags: r.tag_names ? String(r.tag_names).split(',') : [],
    }));
  }));

  /** 每日分布只需要最小字段集，别把整表搬给渲染层 */
  ipcMain.handle('worklog:rangeEntries', wrap((p) => {
    const { from, to } = p || {};
    return store.rangeEntries({
      from: from || store.ALL_FROM,
      to: to || store.ALL_TO,
    }).map((e) => ({
      taskId: Number(e.task_id),
      startedAt: e.started_at,
      sec: Number(e.duration_sec) || 0,
    }));
  }));

  ipcMain.handle('worklog:manualAdd', wrap((p) => service.addManual(p || {})));  ipcMain.handle('worklog:entryDelete', wrap((id) => store.deleteEntry(Number(id))));
  ipcMain.handle('worklog:export', wrap((p) => exporter.exportCsv(p || {})));

  /* ---------- 工时记薪（时间价值）：全部是派生计算，不写回任何工时记录 ---------- */
  ipcMain.handle('worklog:rates', wrap(() => store.listRates()));
  ipcMain.handle('worklog:rateSet', wrap((p) => store.upsertRate(p || {})));
  ipcMain.handle('worklog:rateDelete', wrap((id) => store.deleteRate(id)));
  /** 逐条金额：区间与视图页同一口径（from/to 为 UTC ISO，缺省全时段） */
  ipcMain.handle('worklog:pay', wrap((p) => {
    const { from, to } = p || {};
    return store.payRows({
      from: from || store.ALL_FROM,
      to: to || store.ALL_TO,
    });
  }));
  /** 记录级计薪开关，改完由渲染层触发刷新 */
  ipcMain.handle('worklog:entryBillable', wrap((p) => {
    const id = Number(p && p.id);
    if (!Number.isFinite(id)) throw new Error('记录 id 无效');
    return store.setEntryBillable(id, !!(p && p.billable));
  }));
  ipcMain.handle('worklog:notices', wrap(() => {
    const out = notices.slice();
    notices = [];
    return out;
  }));

  /**
   * 浮窗（或任意窗口）请求主窗口弹出全屏禅层。
   * 浮窗是 286px 透明窗，放不下 zen.js 的全屏覆盖层，只发这条指令；
   * 计时本身已经由调用方先 worklog:start({source:'zen'}) 起好，这里只管“把禅画面亮出来”。
   * 广播给所有窗口，渲染层 worklog/index.js 监听后只有主窗口真的有 zen DOM（其它窗口无监听）。
   */
  ipcMain.handle('worklog:openZen', wrap(() => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      try { w.webContents.send('ui:zen-open'); } catch (e) { /* 窗口正在关闭 */ }
    }
    return { ok: true };
  }));
}

function unregister() {
  for (const ch of CHANNELS) {
    try { ipcMain.removeHandler(ch); } catch (e) { /* 没注册过就算了 */ }
  }
}

function setNotices(list) {
  notices = Array.isArray(list) ? list.slice() : [];
}

module.exports = { register, unregister, setNotices, CHANNELS };
