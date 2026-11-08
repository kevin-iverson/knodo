'use strict';
/**
 * IPC 处理器注册：将渲染进程的请求映射到数据库 / AI / 报告等模块。
 */
const { ipcMain, dialog, shell, app, desktopCapturer, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const attachments = require('./attachments');
const crypto = require('./crypto');
const ai = require('./ai');
const asr = require('./asr');
const meeting = require('./meeting');
const recording = require('./recording');
const report = require('./report');
const { markdownToDocx } = require('./docx');
const autostart = require('./autostart');
const searchAssist = require('./search-assist');
const knowledge = require('./knowledge');
const sync = require('./sync');
const mdImport = require('./md-import');
const backup = require('./backup');
const storage = require('./storage');
const desktopWindow = require('./desktop-window');
const focus = require('./focus');
const recurRules = require('./recurrence-rules');
const holidays = require('./holidays-cn');
const dateU = require('./date-utils');

/**
 * 附件相对路径 → 笔记正文里可引用的 todo-media:// URL。
 * 逐段 encodeURIComponent：中文 / 空格文件名也能正常显示（主进程侧解码回原路径）。
 */
function mediaUrlOf(entry) {
  const rel = String((entry && entry.path) || '').replace(/^\/+/, '');
  return `todo-media:///${rel.split('/').map(encodeURIComponent).join('/')}`;
}

function getAsrConfig() {
  const baseUrl = db.getSetting('ai.asrBaseUrl', asr.DEFAULT_ASR_CONFIG.baseUrl);
  const model = db.getSetting('ai.asrModel', asr.DEFAULT_ASR_CONFIG.model);
  const stored = db.getSetting('ai.asrKey', '');
  const { value: apiKey, degraded } = crypto.decryptApiKey(stored);
  return { baseUrl, model, apiKey, hasKey: !!apiKey, encryptionDegraded: degraded };
}

function getAiConfig() {
  const baseUrl = db.getSetting('ai.baseUrl', ai.DEFAULT_CONFIG.baseUrl);
  const model = db.getSetting('ai.model', ai.DEFAULT_CONFIG.model);
  const stored = db.getSetting('ai.apiKey', '');
  const { value: apiKey, degraded } = crypto.decryptApiKey(stored);
  return { baseUrl, model, apiKey, hasKey: !!apiKey, encryptionDegraded: degraded };
}

/** 取出对话模型调用参数（baseUrl / key / model） */
function chatConfig(cfg = getAiConfig()) {
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model };
}

/** 问答历史的「检索范围」标签：目录 id → 目录名（0 = 未分类），空 = 全部笔记 */
function kbScopeLabel(folderIds) {
  const ids = Array.isArray(folderIds)
    ? folderIds.map(Number).filter((n) => Number.isFinite(n))
    : [];
  if (!ids.length) return '全部笔记';
  return ids.map((id) => {
    if (id === 0) return '未分类';
    const f = db.getNoteFolder(id);
    return f ? f.name : `目录${id}`;
  }).join('、');
}

/**
 * 润色配置：上次使用的提示词（ai.polishInstruction）与用户自建预设（ai.polishPresets）。
 * 内置预设由 ai.POLISH_PRESETS 下发，两者在界面上合并成一个下拉，但只持久化用户自己的那份。
 */
function getPolishConfig() {
  let custom = [];
  try {
    const raw = db.getSetting('ai.polishPresets', '[]');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) custom = parsed.filter((p) => p && p.label);
  } catch (e) {
    custom = []; // 数据损坏就当没有自建预设，不能因此让设置读不出来
  }
  return {
    instruction: db.getSetting('ai.polishInstruction', ''),
    presets: ai.POLISH_PRESETS,
    customPresets: custom.map((p) => ({ id: `custom:${p.label}`, label: p.label, instruction: p.instruction || '' })),
  };
}

/**
 * 把底层异常翻译成用户能理解的提示（保留原文便于排查）。
 */
function friendlyError(e) {
  const raw = e && e.message ? e.message : String(e);
  const code = e && e.code ? e.code : '';
  if (/readonly|read-only/i.test(raw) || code === 'SQLITE_READONLY') {
    return `数据库当前为只读，无法写入（${raw}）。请检查 todo.db 所在文件夹的权限，或是否被同步盘/杀毒软件锁定。`;
  }
  if (/SQLITE_BUSY|database is locked/i.test(raw) || code === 'SQLITE_BUSY') {
    return `数据库被占用，请稍后重试（${raw}）。`;
  }
  if (/SQLITE_FULL|disk I\/O error|no space left/i.test(raw)) {
    return `写入失败：磁盘空间不足或存储异常（${raw}）。`;
  }
  if (/UNIQUE constraint failed/i.test(raw)) {
    return `数据重复：${raw}`;
  }
  if (/NOT NULL constraint failed/i.test(raw)) {
    return `缺少必填字段：${raw}`;
  }
  return raw;
}

/**
 * 包装 IPC 处理器：把同步异常（数据库只读 / 磁盘满 / 约束冲突等）转成可预期的返回值，
 * 而不是让 invoke 的 Promise 被静默拒绝——渲染进程若没 catch，用户点了按钮会毫无反应。
 */
function guard(fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      console.error('[ipc]', e && e.message);
      return { __error: friendlyError(e) };
    }
  };
}

/**
 * 取数据库连接，初始化失败时给出可读原因。
 * @param {Function} fn 业务实现（参数为 IPC 实参，不含 event）
 * @param {object} [opts]
 * @param {boolean} [opts.notify] 写库成功后广播给桌面浮窗（浮窗只投射数据，必须知道数据变了）；
 *   渲染层来源是浮窗自己时还会回灌主窗口一次，见 desktop-window.js 的 notifyChange。
 */
function withDb(fn, opts = {}) {
  const notify = !!opts.notify;
  return guard(async (event, ...args) => {
    if (!db.isReady()) {
      throw new Error(`数据库未就绪${db.getInitError() ? '：' + db.getInitError() : ''}`);
    }
    const result = await fn(...args);
    if (notify) {
      try { desktopWindow.notifyChange(event && event.sender); } catch (e) { /* 广播失败不能让写操作失败 */ }
    }
    return result;
  });
}

function registerIpc() {
  // 录制文件目录（userData/recordings）：handler 里一律通过 recording 模块访问
  recording.init(app.getPath('userData'));

  /* ---------- 分组 ---------- */
  ipcMain.handle('groups:list', withDb(() => db.listGroups()));
  ipcMain.handle('groups:create', withDb((p) => db.createGroup(p), { notify: true }));
  ipcMain.handle('groups:update', withDb((id, p) => db.updateGroup(id, p), { notify: true }));
  ipcMain.handle('groups:delete', withDb((id) => {
    const ok = db.deleteGroup(id);
    // 钉在桌面上的那个清单没了 → 浮窗显示「该清单已删除」并自动关窗（E-01）
    if (ok) {
      try { desktopWindow.dropByGroup(id); } catch (e) { /* 通知失败不影响删除结果 */ }
    }
    return ok;
  }, { notify: true }));
  ipcMain.handle('groups:reorder', withDb((ids) => db.reorderGroups(ids)));
  // 移动分组：换父级 / 调同级顺序。桌面浮窗按分组取数，位置变了要广播让它们重排
  ipcMain.handle('groups:move', withDb((id, p) => db.moveGroup(id, p), { notify: true }));

  /* ---------- 任务 ---------- */
  ipcMain.handle('tasks:list', withDb((f) => db.listTasks(f)));
  ipcMain.handle('tasks:get', withDb((id) => db.getTask(id)));
  ipcMain.handle('tasks:create', withDb((p) => {
    const t = db.createTask(p);
    // 记住「上次添加任务用的清单」：捕捉条在第三方应用里按 Ctrl+Alt+C 时，
    // 没有别的上下文可依，就落在这个清单（用户上一次的显式选择，不是猜测）。
    try {
      if (t && t.group_id != null) db.setSetting('ui.lastAddGroupId', String(t.group_id));
    } catch (e) { /* 记忆失败不影响创建结果 */ }
    return t;
  }, { notify: true }));
  ipcMain.handle('tasks:update', withDb((id, p) => db.updateTask(id, p), { notify: true }));
  ipcMain.handle('tasks:delete', withDb((id) => {
    // 删除任务会连带删除子任务：先收集整棵子树，删库成功后一并清掉它们的附件文件
    const ids = db.subtreeTaskIds(id);
    const ok = db.deleteTask(id);
    ids.forEach((tid) => attachments.removeTaskDir(tid));
    return ok;
  }, { notify: true }));
  ipcMain.handle('tasks:toggle', withDb((id) => db.toggleTask(id), { notify: true }));
  ipcMain.handle('tasks:reorder', withDb((ids) => db.reorderTasks(ids)));
  ipcMain.handle('tasks:archiveCompleted', withDb((groupId) => db.archiveCompleted(groupId), { notify: true }));
  ipcMain.handle('tasks:archive', withDb((id) => db.archiveTask(id), { notify: true }));
  ipcMain.handle('tasks:unarchive', withDb((id) => db.unarchiveTask(id), { notify: true }));
  ipcMain.handle('tasks:subtasks', withDb((parentId) => db.listSubtasks(parentId)));

  /* ---------- 重复事项 / 习惯 ---------- */
  // 规则摘要与「下一次发生日」在主进程算：文案口径只有 recurrence-rules.js 一份，
  // 渲染层不重复实现一遍（否则改规则含义时两边必然对不上）。
  const decorateRule = (r) => (r ? {
    ...r,
    summary: recurRules.describeRule(r.rule),
    nextDate: r.enabled ? (recurRules.nextOccurrence(r.rule, dateU.todayLocal(), r.start_date) || '') : '',
    taskId: r.task_id == null ? null : Number(r.task_id),
    todayDone: !!r.today_done,
    doneCount: Number(r.done_count || 0),
  } : null);
  ipcMain.handle('recur:list', withDb(() => db.listRecurringRules().map(decorateRule)));
  ipcMain.handle('recur:get', withDb((id) => decorateRule(db.getRecurringRule(id))));
  ipcMain.handle('recur:create', withDb((p) => decorateRule(db.createRecurringRule(p || {})), { notify: true }));
  ipcMain.handle('recur:update', withDb((id, p) => decorateRule(db.updateRecurringRule(id, p || {})), { notify: true }));
  ipcMain.handle('recur:setEnabled', withDb((id, on) => decorateRule(db.setRecurringEnabled(id, !!on)), { notify: true }));
  ipcMain.handle('recur:remove', withDb((id) => db.deleteRecurringRule(id), { notify: true }));
  ipcMain.handle('recur:skips', withDb((id) => db.listSkips(id)));
  ipcMain.handle('recur:clearSkips', withDb((id) => decorateRule(db.clearSkips(id)), { notify: true }));
  // 详情抽屉 / 习惯面板用：按任务查规则、读打卡历史、补打卡、跳过某一天
  ipcMain.handle('recur:forTask', withDb((taskId) => {
    const t = db.getTask(taskId);
    if (!t || t.recurring_id == null) return null;
    return decorateRule(db.getRecurringRule(t.recurring_id));
  }));
  ipcMain.handle('recur:completions', withDb((id) => db.listCompletions(id)));
  ipcMain.handle('recur:setCompletion', withDb((id, date, done) => db.setCompletion(id, date, !!done), { notify: true }));
  ipcMain.handle('recur:skipDay', withDb((id, date) => decorateRule(db.skipOccurrence(id, date)), { notify: true }));
  ipcMain.handle('recur:stats', withDb((id) => db.habitStats(id)));
  ipcMain.handle('recur:sync', withDb(() => db.syncRecurrences(), { notify: true }));
  ipcMain.handle('recur:meta', withDb(() => ({
    coverage: holidays.coverage(),
    weekdayLabels: recurRules.WEEKDAY_LABELS,
    today: dateU.todayLocal(),
  })));
  // 配置表单里的「接下来 12 次」预览：只算日期，不写库。
  // 起止都要收敛：起点取 max(今天, 生效日)，终点取 min(起点+400, 结束日) ——
  // 之前不传结束日、后端按 today+400 截断，于是「结束日 11/10」的规则也能一路排到 11/18。
  ipcMain.handle('recur:preview', withDb((p = {}) => {
    const rule = recurRules.normalizeRule(p.rule || {});
    const today = dateU.todayLocal();
    const start = dateU.toDay(p.startDate) || today;
    const from = start > today ? start : today;
    const end = dateU.toDay(p.endDate) || '';
    const cap = dateU.addDays(from, 400);
    const to = end && end < cap ? end : cap;
    if (to < from) return [];
    return recurRules.occurrences(rule, from, to, start).slice(0, 12);
  }));

  /* ---------- 任务附件 ---------- */
  /** 取任务的附件数组（任务不存在时抛出可读错误） */
  const taskAttachments = (taskId) => {
    const task = db.getTask(taskId);
    if (!task) throw new Error('任务不存在或已被删除');
    return Array.isArray(task.attachments) ? task.attachments : [];
  };
  const findAttachment = (taskId, attId) => {
    const entry = taskAttachments(taskId).find((a) => String(a.id) === String(attId));
    if (!entry) throw new Error('附件不存在（可能已被删除）');
    return entry;
  };
  /** 复制进附件目录并写回元数据；单个文件失败不影响其它文件 */
  const appendAttachments = (taskId, paths) => {
    const cur = taskAttachments(taskId);
    const added = [];
    const failed = [];
    for (const p of paths) {
      try {
        added.push(attachments.importFile(taskId, p));
      } catch (e) {
        failed.push(e && e.message ? e.message : String(e));
      }
    }
    if (!added.length) throw new Error(failed[0] || '没有可添加的附件');
    const next = db.setAttachments(taskId, [...cur, ...added]);
    return { attachments: next.attachments, added: added.length, failed };
  };

  // 选择本地文件添加（支持多选）
  ipcMain.handle('attachments:pick', withDb(async (taskId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '添加附件',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    return { ok: true, ...appendAttachments(taskId, filePaths) };
  }));

  // 拖拽添加：渲染层把 File 转成绝对路径后传进来
  ipcMain.handle('attachments:addPaths', withDb((taskId, paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
    if (!list.length) return { ok: false, message: '没有可添加的文件' };
    return { ok: true, ...appendAttachments(taskId, list) };
  }));

  // 用系统默认程序打开附件
  ipcMain.handle('attachments:open', withDb(async (taskId, attId) => {
    const entry = findAttachment(taskId, attId);
    if (!attachments.exists(entry)) throw new Error(`附件文件已丢失：${entry.name}`);
    const err = await shell.openPath(attachments.absPath(entry));
    if (err) throw new Error(`打开失败：${err}`);
    return { ok: true };
  }));

  // 在资源管理器中定位
  ipcMain.handle('attachments:reveal', withDb((taskId, attId) => {
    const entry = findAttachment(taskId, attId);
    if (!attachments.exists(entry)) throw new Error(`附件文件已丢失：${entry.name}`);
    shell.showItemInFolder(attachments.absPath(entry));
    return { ok: true };
  }));

  // 另存为（下载到用户指定位置）
  ipcMain.handle('attachments:saveAs', withDb(async (taskId, attId) => {
    const entry = findAttachment(taskId, attId);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存附件',
      defaultPath: entry.name,
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    attachments.saveAs(entry, filePath);
    return { ok: true, filePath };
  }));

  // 删除附件：先删文件再改元数据（文件缺失也允许删除记录）
  ipcMain.handle('attachments:remove', withDb((taskId, attId) => {
    const cur = taskAttachments(taskId);
    const entry = cur.find((a) => String(a.id) === String(attId));
    if (!entry) throw new Error('附件不存在（可能已被删除）');
    attachments.removeFile(entry);
    const next = db.setAttachments(taskId, cur.filter((a) => String(a.id) !== String(attId)));
    return { ok: true, attachments: next.attachments };
  }));

  /* ---------- AI 检索（含联想召回） ---------- */
  ipcMain.handle('search:ai', async (_e, keyword) => {
    const kw = (keyword || '').trim();
    if (!kw) return { ok: false, message: '请输入检索关键词' };

    /*
     * 检索分三步：
     *   1) 精确层：先走原 SQL LIKE（标题/描述/标签原样命中）。命中即优先返回，
     *      完全保留改造前的精确匹配能力；
     *   2) 联想层：无精确命中时，用 search-assist 在本地做同义词/缩写/近似拼写/
     *      状态/时间语义召回并打分，输出 Top 5 候选 + 命中依据；
     *   3) 语义重排：配了 Key 且本地置信度不足（非唯一匹配）时，让模型在候选池内
     *      重排并给出理由；失败不影响结果，降级到本地排序。
     */
    const exact = db.searchTasks(kw, 30);
    let result;
    if (exact.length) {
      result = {
        keyword: kw,
        // 精确命中：第一条视为高置信唯一匹配；多条并列则待确认
        type: exact.length === 1 ? 'unique' : 'candidates',
        tasks: exact.slice(0, 5).map((t, i) => ({
          ...t,
          match: {
            score: 100 - i,
            reasons: [`精确匹配「${kw}」`],
            relevance: i === 0 ? 100 : Math.max(40, 100 - i * 15),
            confidence: i === 0 ? 'high' : 'mid',
          },
        })),
        tried: [],
      };
      result.exactHit = true;
    } else {
      const pool = db.listTasks({ status: 'any' });
      result = searchAssist.suggest(pool, kw, { topN: 5 });
      result.exactHit = false;
    }

    const cfg = getAiConfig();
    let summary = '';
    let degraded = !cfg.hasKey;
    let reranked = false;

    /*
     * 语义重排（可选，仅在配了 Key 时）：
     *   - 唯一匹配跳过：答案已经确定，再问模型只是浪费时间；
     *   - 候选 >= 2 条：让模型在这些候选里挑出真正相关的并给出理由；
     *   - 本地零召回：给模型看最近更新的 20 条，让它在"字面完全无关"时做纯语义兜底。
     * 无论哪种情况，模型都只能在给定池里选 —— 不会凭空造出库里没有的任务。
     * 重排失败归入 degraded，不影响本地结果返回。
     */
    const tryRerank = async () => {
      if (result.type === 'unique') return;
      const poolForAi = result.tasks.length >= 2
        ? result.tasks
        : db.listTasks({ status: 'any' })
          .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
          .slice(0, 20)
          .map((t) => ({
            ...t,
            match: t.match || { score: 0, reasons: ['AI 语义召回'], relevance: 50, confidence: 'low' },
          }));
      if (!poolForAi.length) return;

      const ranked = await ai.rankSearchCandidates(kw, poolForAi, cfg);
      const keep = ranked.filter((x) => x.relevant);
      if (!keep.length) return; // 模型认为都不相关 → 保留本地判断（可能是 none）

      const byId = new Map(poolForAi.map((t) => [Number(t.id), t]));
      const reasonsById = new Map(keep.map((x) => [Number(x.id), x.reason]));
      const ordered = [];
      for (const x of keep) {
        const t = byId.get(Number(x.id));
        if (!t) continue;
        ordered.push({
          ...t,
          match: { ...(t.match || {}), aiReason: reasonsById.get(Number(x.id)) || '', aiRanked: true },
        });
      }
      // 本地候选里模型没提到的仍排在后面：AI 只做"提权"，不替我们做"否决"
      for (const t of poolForAi) {
        if (ordered.length >= 5) break;
        if (keep.some((x) => Number(x.id) === Number(t.id))) continue;
        ordered.push(t);
      }
      if (!ordered.length) return;
      result.tasks = ordered.slice(0, 5);
      reranked = true;
      if (result.type === 'none') result.type = 'candidates'; // 纯语义兜底救回了结果
      // 顺序已由模型重排，相关度条要跟着新顺序走，否则"排第一但条最短"会自相矛盾
      result.tasks.forEach((t, i) => {
        t.match = {
          ...(t.match || {}),
          relevance: i === 0 ? 100 : Math.max(35, 100 - i * 16),
          confidence: i === 0 ? 'mid' : (t.match || {}).confidence || 'low',
        };
      });
    };

    if (cfg.hasKey) {
      // 重排与总结各自 try：重排失败不能把总结也一并拖成失败
      try {
        await tryRerank();
      } catch (e) {
        console.warn('[ipc] AI 语义重排失败，沿用本地排序', e && e.message);
      }
      try {
        summary = await ai.summarizeSearch(kw, result.tasks, cfg);
      } catch (e) {
        degraded = true;
        summary = `AI 总结失败：${e.message}`;
      }
    }

    // 持久化：每次检索都留一份记录（关键词 + 总结 + 命中任务快照），可在检索页回看
    let savedId = null;
    try {
      const rec = db.createSearch({
        keyword: kw,
        summary,
        task_count: result.tasks.length,
        tasks: result.tasks,
        degraded,
      });
      savedId = rec ? rec.id : null;
    } catch (e) {
      console.warn('[ipc] 保存检索历史失败', e && e.message);
    }
    return {
      ok: true,
      keyword: kw,
      tasks: result.tasks,
      type: result.type,
      exactHit: !!result.exactHit,
      tried: result.tried || [],
      summary,
      degraded,
      reranked,
      hasKey: cfg.hasKey,
      id: savedId,
    };
  });

  /* ---------- AI 检索历史 ---------- */
  ipcMain.handle('search:history', withDb((limit) => db.listSearches(Number(limit) || 100)));
  ipcMain.handle('search:get', withDb((id) => db.getSearch(id)));
  ipcMain.handle('search:remove', withDb((id) => !!db.deleteSearch(id)));

  /* ---------- 标签 ---------- */
  ipcMain.handle('tags:list', withDb(() => db.listTags()));
  ipcMain.handle('tags:create', withDb((name, color) => db.createTag(name, color)));
  ipcMain.handle('tags:delete', withDb((id) => db.deleteTag(id)));

  /* ---------- 统计 ---------- */
  ipcMain.handle('stats:overview', withDb((p) => db.overview(p || {})));
  // 入参统一为 { range: '7d' | '1m' | '6m' | '1y' }（旧的数字天数仍兼容）
  ipcMain.handle('stats:trend', withDb((p) => db.dailyTrend(p)));

  /* ---------- AI 配置（对话 + 语音） ---------- */
  ipcMain.handle('ai:getConfig', () => {
    const c = getAiConfig();
    const a = getAsrConfig();
    // 不下发明文 Key 给渲染进程
    return {
      baseUrl: c.baseUrl, model: c.model, hasKey: c.hasKey,
      encryptionDegraded: c.encryptionDegraded, presets: ai.PRESETS,
      polish: getPolishConfig(),
      asr: {
        baseUrl: a.baseUrl, model: a.model, hasKey: a.hasKey,
        encryptionDegraded: a.encryptionDegraded, presets: asr.ASR_PRESETS,
      },
    };
  });
  ipcMain.handle('ai:saveConfig', (_e, p = {}) => {
    // 界面上合并展示的「设为默认」会连提示词一起带过来，这里顺手落库
    if (typeof p.polishInstruction === 'string') db.setSetting('ai.polishInstruction', p.polishInstruction);
    if (p.baseUrl !== undefined) db.setSetting('ai.baseUrl', p.baseUrl);
    if (p.model !== undefined) db.setSetting('ai.model', p.model);
    // 仅在用户输入了新 Key 时更新；留空表示保持原 Key 不变
    if (p.apiKey !== undefined && p.apiKey !== null && p.apiKey !== '') {
      db.setSetting('ai.apiKey', crypto.encryptApiKey(p.apiKey));
    }
    // ASR 独立一组配置：传了才更新，避免旧调用把它们清掉
    if (p.asrBaseUrl !== undefined) db.setSetting('ai.asrBaseUrl', p.asrBaseUrl);
    if (p.asrModel !== undefined) db.setSetting('ai.asrModel', p.asrModel);
    if (p.asrKey !== undefined && p.asrKey !== null && p.asrKey !== '') {
      db.setSetting('ai.asrKey', crypto.encryptApiKey(p.asrKey));
    }
    const c = getAiConfig();
    const a = getAsrConfig();
    return {
      baseUrl: c.baseUrl, model: c.model, hasKey: c.hasKey,
      encryptionDegraded: c.encryptionDegraded, presets: ai.PRESETS,
      polish: getPolishConfig(),
      asr: {
        baseUrl: a.baseUrl, model: a.model, hasKey: a.hasKey,
        encryptionDegraded: a.encryptionDegraded, presets: asr.ASR_PRESETS,
      },
    };
  });
  ipcMain.handle('ai:clearKey', () => {
    db.setSetting('ai.apiKey', '');
    return getAiConfig();
  });
  ipcMain.handle('ai:clearAsrKey', () => {
    db.setSetting('ai.asrKey', '');
    return getAsrConfig();
  });
  ipcMain.handle('ai:test', async (_e, { baseUrl, model, apiKey }) => {
    // 测试时允许使用临时 Key，优先使用传入值，否则用已保存值
    let key = apiKey;
    if (!key) key = getAiConfig().apiKey;
    if (!key) return { ok: false, message: '未配置 API Key' };
    try {
      await ai.testConnection({ baseUrl, apiKey: key, model });
      return { ok: true, message: '连接成功，模型响应正常' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  // 语音接口自检：拉取模型列表确认 Key 可用且模型存在（不产生音频计费）
  ipcMain.handle('ai:testAsr', async (_e, { baseUrl, model, apiKey } = {}) => {
    const saved = getAsrConfig();
    const key = apiKey || saved.apiKey;
    if (!key) return { ok: false, message: '未配置语音 API Key' };
    try {
      const message = await asr.testAsr({ baseUrl: baseUrl || saved.baseUrl, model: model || saved.model, apiKey: key });
      return { ok: true, message };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // 任务描述 AI 润色：返回纯文本，渲染层预览后再决定是否采纳
  ipcMain.handle('ai:polish', async (_e, { text, instruction } = {}) => {
    const src = String(text || '').trim();
    if (!src) return { ok: false, message: '没有可润色的内容' };
    if (src.length > 4000) return { ok: false, message: '描述过长（超过 4000 字），请先精简再润色' };
    const cfg = getAiConfig();
    if (!cfg.hasKey) return { ok: false, message: '未配置 AI 接口 Key，请到顶部菜单栏「AI 设置」中填写' };
    try {
      const polished = await ai.polishText(src, chatConfig(cfg), instruction);
      return { ok: true, text: polished };
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : '润色失败' };
    }
  });

  /**
   * 保存润色提示词配置。
   * - instruction：写入默认提示词（下次打开润色弹窗自动带出）
   * - savePreset：{ label, instruction } 时把当前提示词另存为自建预设（同名覆盖）
   * - deletePreset：按 label 删除一条自建预设（内置预设不可删）
   * 无论哪种操作都回传最新配置，界面直接用返回值重绘下拉，避免自己拼状态。
   */
  ipcMain.handle('ai:savePolish', (_e, p = {}) => {
    if (typeof p.instruction === 'string') db.setSetting('ai.polishInstruction', p.instruction);
    if (p.savePreset && p.savePreset.label) {
      const raw = db.getSetting('ai.polishPresets', '[]');
      let list = [];
      try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) list = parsed; } catch (e) { list = []; }
      const idx = list.findIndex((x) => x.label === p.savePreset.label);
      const item = { label: p.savePreset.label, instruction: p.savePreset.instruction || '' };
      if (idx >= 0) list[idx] = item; else list.push(item);
      db.setSetting('ai.polishPresets', JSON.stringify(list));
    }
    if (p.deletePreset) {
      const raw = db.getSetting('ai.polishPresets', '[]');
      let list = [];
      try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) list = parsed; } catch (e) { list = []; }
      db.setSetting('ai.polishPresets', JSON.stringify(list.filter((x) => x.label !== p.deletePreset)));
    }
    return getPolishConfig();
  });

  /* ---------- 报告 ---------- */
  ipcMain.handle('report:generate', withDb(async (params) => {
    const cfg = getAiConfig();
    return report.generateReport(params, cfg);
  }));
  // 导出格式表：Word 走 docx（OOXML），其余按纯文本写入
  const EXPORT_FORMATS = {
    txt: { ext: 'txt', label: '文本文件' },
    md: { ext: 'md', label: 'Markdown' },
    doc: { ext: 'docx', label: 'Word 文档' },
    docx: { ext: 'docx', label: 'Word 文档' },
  };
  /* ---------- 报告历史（持久化） ---------- */
  // 分组标签由主进程按 group_ids 现算（id → 「父 / 子」完整路径）：
  // 界面只传 id，既不重复拼串，也不会因为同名分组写出两个一模一样的词。
  ipcMain.handle('report:save', withDb((p) => {
    const payload = p || {};
    return db.createReport({ ...payload, group_label: report.groupLabelForHistory(payload.group_ids) });
  }));
  ipcMain.handle('report:list', withDb((limit) => db.listReports(Number(limit) || 100)));
  ipcMain.handle('report:get', withDb((id) => db.getReport(id)));
  ipcMain.handle('report:update', withDb(({ id, patch }) => db.updateReport(id, patch || {})));
  ipcMain.handle('report:remove', withDb((id) => !!db.deleteReport(id)));

  ipcMain.handle('report:export', guard(async (_e, { content, defaultName, format }) => {
    const f = EXPORT_FORMATS[format] || EXPORT_FORMATS.md;
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出报告',
      defaultPath: `${defaultName}.${f.ext}`,
      filters: [
        { name: f.label, extensions: [f.ext] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    if (f.ext === 'docx') {
      fs.writeFileSync(filePath, markdownToDocx(content, { title: defaultName }));
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
    }
    return { ok: true, filePath };
  }));

  /* ---------- 会议录制 ---------- */
  // 可选录制源（屏幕 / 窗口），缩略图转 dataURL 给渲染层直接显示
  ipcMain.handle('rec:listSources', guard(async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 240, height: 140 },
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      displayId: s.display_id || '',
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
    }));
  }));
  ipcMain.handle('rec:startSession', guard(() => recording.createSession()));
  ipcMain.handle('rec:saveChunk', guard((_e, { sessionId, seq, data, ext }) => recording.saveChunk(sessionId, seq, data, ext)));
  ipcMain.handle('rec:discard', guard((_e, sessionId) => ({ ok: recording.deleteSession(sessionId) })));
  ipcMain.handle('rec:openFolder', guard((_e, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    else shell.openPath(recording.getRoot());
    return { ok: true };
  }));
  // 录制结束：把分片路径归档成一条会议记录
  ipcMain.handle('rec:finalize', withDb((p = {}) => {
    const files = recording.sessionFiles(p.sessionId);
    return db.createMeeting({
      title: (p.title || '').trim() || '未命名会议',
      source_label: p.sourceLabel || '',
      mode: p.mode || 'audio',
      started_at: p.startedAt || undefined,
      duration_ms: Number(p.durationMs) || 0,
      media_paths: files,
      status: files.length ? 'recorded' : 'recorded',
    });
  }));
  // 导入已有录音 / 视频文件，跳过录制直接进转写流程
  ipcMain.handle('rec:importMedia', guard(async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入会议录音 / 录像',
      properties: ['openFile'],
      filters: [
        { name: '音视频文件', extensions: ['webm', 'mp3', 'm4a', 'mp4', 'wav', 'ogg', 'flac', 'aac'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    const media = recording.importMedia(filePaths[0]);
    if (media.size > asr.MAX_CHUNK_BYTES) {
      recording.deleteSession(media.sessionId);
      throw new Error(
        `文件 ${(media.size / 1024 / 1024).toFixed(1)}MB 超过单次上传上限 ${asr.MAX_CHUNK_BYTES / 1024 / 1024}MB，`
        + '请先切成小段再导入'
      );
    }
    const m = db.createMeeting({
      title: path.basename(filePaths[0], path.extname(filePaths[0])) || '导入的会议',
      source_label: '外部导入',
      mode: 'audio',
      media_paths: [media.filePath],
    });
    return { ok: true, meeting: m };
  }));

  /* ---------- 会议纪要 ---------- */
  ipcMain.handle('meeting:list', withDb(() => db.listMeetings()));
  ipcMain.handle('meeting:get', withDb((id) => db.getMeeting(id)));
  ipcMain.handle('meeting:update', withDb((id, patch) => db.updateMeeting(id, patch)));
  ipcMain.handle('meeting:remove', withDb((id) => {
    const m = db.getMeeting(id);
    // 顺带清理录制文件：会话目录名 = media_paths[0] 的父目录名
    const dirName = m && m.media_paths && m.media_paths[0] ? path.basename(path.dirname(m.media_paths[0])) : '';
    if (dirName) recording.deleteSession(dirName);
    return { ok: db.deleteMeeting(id) > 0 };
  }));

  // 语音转写：按分片顺序逐段上传，拼接成完整转写稿
  ipcMain.handle('meeting:transcribe', withDb(async ({ id, language }) => {
    const m = db.getMeeting(id);
    if (!m) throw new Error('会议记录不存在');
    const missing = (m.media_paths || []).filter((f) => !fs.existsSync(f));
    if (!m.media_paths || !m.media_paths.length) throw new Error('这条会议没有可转写的音频（可能已被清理）');
    if (missing.length === m.media_paths.length) throw new Error(`音频文件已丢失：${missing[0]}`);
    const cfg = getAsrConfig();
    if (!cfg.hasKey) throw new Error('未配置语音 API Key，请到顶部菜单栏「AI 设置」中填写语音接口');
    const parts = [];
    for (let i = 0; i < m.media_paths.length; i++) {
      const f = m.media_paths[i];
      if (!fs.existsSync(f)) continue;
      /* eslint-disable no-await-in-loop */
      const text = await asr.transcribe({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        filePath: f,
        language: language || 'zh',
        prompt: i > 0 ? parts[parts.length - 1].slice(-120) : '', // 用上一片结尾做上下文，减少断句错乱
      });
      parts.push(text);
    }
    const transcript = parts.join('\n').trim();
    if (!transcript) throw new Error('转写结果为空，可能整段都是静音');
    return db.updateMeeting(id, { transcript, status: missing.length ? 'transcribed-partial' : 'transcribed' });
  }));

  // 生成纪要 + 待办（依赖已转写文本）
  ipcMain.handle('meeting:summarize', withDb(async (id) => {
    const m = db.getMeeting(id);
    if (!m) throw new Error('会议记录不存在');
    if (!m.transcript || !m.transcript.trim()) throw new Error('还没有转写文本，请先执行语音转写');
    const cfg = getAiConfig();
    if (!cfg.hasKey) throw new Error('未配置 AI 接口 Key，请到顶部菜单栏「AI 设置」中填写');
    const { summary, todos } = await meeting.processMeeting({
      transcript: m.transcript,
      meta: { title: m.title, startedAt: m.started_at, durationMs: m.duration_ms, mode: m.mode, sourceLabel: m.source_label },
      config: chatConfig(cfg),
    });
    return db.updateMeeting(id, { summary, todos, status: 'summarized' });
  }));

  // 勾选的待办 → 写入任务表（可并入一个父任务下）
  ipcMain.handle('meeting:importTodos', withDb(({ id, todoIds, groupId, asSubtasks }) => {
    const m = db.getMeeting(id);
    if (!m) throw new Error('会议记录不存在');
    const picked = (m.todos || []).filter((t) => (todoIds || []).includes(t.id));
    if (!picked.length) return { ok: false, message: '没有勾选任何待办', created: 0 };

    let parentId = null;
    if (asSubtasks) {
      const parent = db.createTask({
        title: `${m.title} 的待办`,
        groupId: groupId || null,
        notes: `来源：会议纪要《${m.title}》`,
      });
      parentId = parent.id;
    }
    const created = picked.map((t) => {
      const lines = [];
      if (t.detail) lines.push(t.detail);
      if (t.assignee && t.assignee !== '未指定') lines.push(`负责人：${t.assignee}`);
      if (t.evidence) lines.push(`依据：${t.evidence}`);
      return db.createTask({
        title: t.title,
        groupId: groupId || null,
        parentId,
        notes: lines.join('\n'),
        priority: Number(t.priority) || 1,
        planEnd: t.due || null,
      });
    });
    return { ok: true, created: created.length, tasks: created };
  }));

  /* ---------- 笔记（Markdown 编辑 / 目录 / 标签） ---------- */
  ipcMain.handle('notes:list', withDb((f) => db.listNotes(f || {})));
  ipcMain.handle('notes:get', withDb((id) => db.getNote(id)));
  // 新建 / 更新后同步重建知识库索引：笔记保存即沉淀，不需要用户再点一次“同步”
  ipcMain.handle('notes:create', withDb((p) => {
    const note = db.createNote(p || {});
    if (note) knowledge.indexNote(note.id);
    return note;
  }));
  ipcMain.handle('notes:update', withDb((id, patch) => {
    const note = db.updateNote(id, patch || {});
    if (note) knowledge.indexNote(note.id);
    return note;
  }));
  ipcMain.handle('notes:archive', withDb((id, archived) => db.setNoteArchived(id, !!archived)));
  ipcMain.handle('notes:pin', withDb((id, pinned) => db.setNotePinned(id, !!pinned)));
  // 软删除：保留任务引用，返回被引用次数供界面提示影响面
  ipcMain.handle('notes:trash', withDb((id) => {
    const refs = db.listNoteTasks(id).length;
    const note = db.trashNote(id);
    if (note) knowledge.removeNote(note.id);
    return { note, refs };
  }));
  ipcMain.handle('notes:restore', withDb((id) => {
    const note = db.restoreNote(id);
    if (note) knowledge.indexNote(note.id);
    return note;
  }));
  // 彻底删除：先摘引用再删正文，返回被解除引用的任务 id
  ipcMain.handle('notes:purge', withDb((id) => {
    const res = db.purgeNote(id);
    knowledge.removeNote(id);
    // 文件本体随笔记一起清掉（库记录已删，不清理会留下孤儿文件）
    attachments.removeOwnerDir('note', id);
    return res;
  }));
  ipcMain.handle('notes:trashList', withDb(() => db.listTrash()));
  ipcMain.handle('notes:emptyTrash', withDb(() => ({ removed: db.emptyTrash() })));
  ipcMain.handle('notes:search', withDb((keyword, opts) => db.searchNotes(keyword, opts || {})));

  /**
   * 导入 Markdown 笔记：选文件（可多选）或整个目录（递归，按子目录结构建笔记目录）。
   * 为什么放在主进程：只有这里能弹系统文件框、能读磁盘、能往附件目录落盘。
   * @param {'files'|'dir'} kind
   * @param {{folderId?:number|null, tags?:string[], titleFrom?:'file'|'h1', importImages?:boolean}} opts
   */
  ipcMain.handle('notes:importMd', async (_e, kind = 'files', opts = {}) => {
    const isDir = kind === 'dir';
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: isDir ? '导入文件夹里的 Markdown 笔记' : '导入 Markdown 笔记',
      buttonLabel: '导入',
      properties: isDir ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: isDir ? [] : [
        { name: 'Markdown', extensions: mdImport.MD_EXT.map((e) => e.replace(/^\./, '')) },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    try {
      const entries = isDir
        ? filePaths.flatMap((dir) => mdImport.walkDir(dir))
        : filePaths.map((p) => ({ file: p, relDir: '' }));
      const res = mdImport.importFiles({ files: entries, ...opts });
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  /* ---------- 笔记附件（图片粘贴 / 插入） ---------- */
  // 复用任务附件同一套落盘规则（main/attachments.js），只是宿主目录换成 note-<id>：
  // 正文里存 `todo-media:///<相对路径>`，不把 base64 塞进 Markdown。
  const noteAttachmentsOf = (noteId) => {
    const note = db.getNote(noteId);
    if (!note) throw new Error('笔记不存在或已被删除');
    return db.getNoteAttachments(noteId);
  };
  const findNoteAttachment = (noteId, attId) => {
    const entry = noteAttachmentsOf(noteId).find((a) => String(a.id) === String(attId));
    if (!entry) throw new Error('附件不存在（可能已被删除）');
    return entry;
  };

  ipcMain.handle('noteAttachments:list', withDb((noteId) => db.getNoteAttachments(noteId)));

  /** 选择本地图片插入（支持多选） */
  ipcMain.handle('noteAttachments:pick', withDb(async (noteId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '插入图片',
      buttonLabel: '插入',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true, entries: [] };
    const cur = noteAttachmentsOf(noteId);
    const entries = [];
    const failed = [];
    for (const p of filePaths) {
      try { entries.push(attachments.importInto('note', noteId, p)); }
      catch (e) { failed.push(e && e.message ? e.message : String(e)); }
    }
    if (!entries.length) throw new Error(failed[0] || '没有可插入的图片');
    const list = db.setNoteAttachments(noteId, [...cur, ...entries]);
    return { ok: true, entries, attachments: list, failed };
  }));

  /** 拖拽 / 文件管理器拖入：渲染层把 File 转成绝对路径后传进来 */
  ipcMain.handle('noteAttachments:addPaths', withDb((noteId, paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
    if (!list.length) return { ok: false, message: '没有可插入的文件', entries: [] };
    const cur = noteAttachmentsOf(noteId);
    const entries = [];
    const failed = [];
    for (const p of list) {
      try { entries.push(attachments.importInto('note', noteId, p)); }
      catch (e) { failed.push(e && e.message ? e.message : String(e)); }
    }
    if (!entries.length) throw new Error(failed[0] || '没有可插入的文件');
    const next = db.setNoteAttachments(noteId, [...cur, ...entries]);
    return { ok: true, entries, attachments: next, failed };
  }));

  /**
   * 粘贴截图：渲染层没有 fs 权限，把剪贴板图片的 data URL 传过来由主进程落盘。
   * @returns {{ok:boolean, entry:object, attachments:Array, url:string}} url 可直接写进 Markdown
   */
  ipcMain.handle('noteAttachments:pasteImage', withDb((noteId, dataUrl, name = '') => {
    const cur = noteAttachmentsOf(noteId);
    const entry = attachments.importDataUrl('note', noteId, dataUrl, name);
    const list = db.setNoteAttachments(noteId, [...cur, entry]);
    return { ok: true, entry, attachments: list, url: mediaUrlOf(entry) };
  }));

  ipcMain.handle('noteAttachments:remove', withDb((noteId, attId) => {
    const cur = noteAttachmentsOf(noteId);
    const entry = cur.find((a) => String(a.id) === String(attId));
    if (!entry) throw new Error('附件不存在（可能已被删除）');
    attachments.removeFile(entry);
    const list = db.setNoteAttachments(noteId, cur.filter((a) => String(a.id) !== String(attId)));
    return { ok: true, attachments: list };
  }));

  ipcMain.handle('noteAttachments:open', withDb(async (noteId, attId) => {
    const entry = findNoteAttachment(noteId, attId);
    if (!attachments.exists(entry)) throw new Error(`文件已丢失：${entry.name}`);
    const err = await shell.openPath(attachments.absPath(entry));
    if (err) throw new Error(`打开失败：${err}`);
    return { ok: true };
  }));

  ipcMain.handle('noteAttachments:reveal', withDb((noteId, attId) => {
    const entry = findNoteAttachment(noteId, attId);
    if (!attachments.exists(entry)) throw new Error(`文件已丢失：${entry.name}`);
    shell.showItemInFolder(attachments.absPath(entry));
    return { ok: true };
  }));

  ipcMain.handle('noteAttachments:saveAs', withDb(async (noteId, attId) => {
    const entry = findNoteAttachment(noteId, attId);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存图片',
      defaultPath: entry.name,
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    attachments.saveAs(entry, filePath);
    return { ok: true, filePath };
  }));

  /**
   * 渲染层生成的图片（Mermaid 图导出 PNG）另存到用户指定位置。
   * 只收 data:image/png 的 base64：别的类型（SVG 源码、任意 data URL）一律拒绝，
   * 避免渲染层把「写任意字节到任意路径」当通用文件写口子用。
   */
  ipcMain.handle('app:saveImage', async (_e, payload = {}) => {
    const dataUrl = String(payload.dataUrl || '');
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) throw new Error('图片数据无效');
    const buf = Buffer.from(m[1], 'base64');
    if (!buf.length) throw new Error('图片数据为空');
    const base = String(payload.name || '图表').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80) || '图表';
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存图片',
      defaultPath: `${base}.png`,
      filters: [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, buf);
    return { ok: true, filePath, size: buf.length };
  });

  ipcMain.handle('noteFolders:list', withDb(() => db.listNoteFolders()));
  ipcMain.handle('noteFolders:create', withDb((p) => db.createNoteFolder(p || {})));
  ipcMain.handle('noteFolders:update', withDb((id, p) => db.updateNoteFolder(id, p || {})));
  ipcMain.handle('noteFolders:delete', withDb((id) => ({ ok: !!db.deleteNoteFolder(id) })));

  ipcMain.handle('noteTags:list', withDb(() => db.listNoteTags()));
  ipcMain.handle('noteTags:create', withDb((name, color) => db.createNoteTag(name, color)));
  ipcMain.handle('noteTags:update', withDb((id, p) => db.updateNoteTag(id, p || {})));
  ipcMain.handle('noteTags:delete', withDb((id) => ({ ok: !!db.deleteNoteTag(id) })));

  /* ---------- 任务 ↔ 笔记（多对多） ---------- */
  ipcMain.handle('taskNotes:list', withDb((taskId) => db.listTaskNotes(taskId)));
  ipcMain.handle('taskNotes:set', withDb(({ taskId, noteIds }) => db.setTaskNotes(taskId, noteIds || [])));
  ipcMain.handle('taskNotes:link', withDb(({ taskId, noteId }) => db.linkTaskNote(taskId, noteId)));
  ipcMain.handle('taskNotes:unlink', withDb(({ taskId, noteId }) => db.unlinkTaskNote(taskId, noteId)));
  /** 引用了某笔记的任务（删除前的影响面提示） */
  ipcMain.handle('taskNotes:byNote', withDb((noteId) => db.listNoteTasks(noteId)));
  /** 一批任务的笔记数（列表页徽标，一次查询避免 N+1） */
  ipcMain.handle('taskNotes:counts', withDb((taskIds) => db.noteCountsForTasks(taskIds || [])));

  /* ---------- 知识库（笔记沉淀 / AI 检索接入） ---------- */
  ipcMain.handle('kb:list', withDb(() => db.listKnowledgeBases()));
  ipcMain.handle('kb:stats', withDb((id) => db.kbStats(id || knowledge.NOTES_KB_ID)));
  ipcMain.handle('kb:reindex', withDb(() => knowledge.indexAll()));
  ipcMain.handle('kb:indexNote', withDb((id) => knowledge.indexNote(id)));
  /** AI 提问：召回笔记片段 → 交给对话模型作答（无 AI 配置时降级为纯召回）。
   *  每次提问都落库（含降级 / 无命中），供问答弹窗回看与删除。
   *  folderIds：限定检索范围的笔记目录（分类），可多选，空/缺省 = 全部笔记。 */
  ipcMain.handle('kb:ask', guard(async (_e, { question, topK, noteIds, folderIds } = {}) => {
    if (!db.isReady()) throw new Error('数据库未就绪');
    const res = await knowledge.answer({ question, cfg: chatConfig(), topK, noteIds, folderIds });
    try {
      const rec = db.createKbQa({
        question,
        answer: res.answer,
        hits: res.hits,
        degraded: res.degraded,
        reason: res.reason || '',
        scope: kbScopeLabel(folderIds),
      });
      return { ...res, qaId: rec ? rec.id : null };
    } catch (e) {
      return res; // 历史落库失败不影响本次问答
    }
  }));
  /** 只做召回不调模型（界面「检索笔记」按钮用） */
  ipcMain.handle('kb:retrieve', withDb(({ query, topK, noteIds, folderIds } = {}) =>
    knowledge.retrieve({ query, topK, noteIds, folderIds })));
  /** 问答历史 */
  ipcMain.handle('kb:qaList', withDb((limit) => db.listKbQa(Number(limit) || 50)));
  ipcMain.handle('kb:qaGet', withDb((id) => db.getKbQa(id)));
  ipcMain.handle('kb:qaRemove', withDb((id) => ({ ok: !!db.deleteKbQa(id) })));

  /* ---------- 笔记导出（笔记视图「📤 导出」/ 单篇「⬇ 导出」） ---------- */
  // 笔记 → 单个 Markdown（单篇就是一篇 .md）/ 每篇一个 .md 的压缩包
  // 图片一律以 base64 内嵌在正文里，不再单独导出附件：.md 自包含，发给别人也能看到图。
  ipcMain.handle('sync:exportNotes', withDb(async (opts = {}) => {
    const entries = sync.collectNotes(opts);
    if (!entries.length) return { ok: false, empty: true };
    // 只匹配到一篇 = 单文档导出：强制 .md，不再打压缩包（压缩包里放一个 .md 对用户毫无意义）
    const single = entries.length === 1;
    const pack = single || opts.pack === 'single' ? 'single' : 'zip';
    const ext = pack === 'single' ? 'md' : 'zip';
    const payload = pack === 'single'
      ? Buffer.from(sync.notesToSingleMarkdown(entries, opts), 'utf8')
      : sync.notesToZip(entries, opts);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出笔记',
      defaultPath: single ? entries[0].fileName : sync.defaultName('笔记', ext),
      filters: [
        { name: pack === 'single' ? 'Markdown' : 'ZIP 压缩包', extensions: [ext] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, payload);
    return { ok: true, filePath, count: entries.length, pack };
  }));

  /* ---------- 数据导入 / 导出 ---------- */
  // 导出 = 完整备份包（db.json + attachments/ + recordings/）。
  // 以前只写一个 JSON，恢复后图片全破、附件点不开、录音没声音——用户却以为已经备份过了。
  ipcMain.handle('data:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出完整备份',
      defaultPath: `knodo-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [
        { name: 'Knodo 备份包（含附件与录音）', extensions: ['zip'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const r = backup.writeArchive(filePath);
      return { ok: true, filePath, manifest: r.manifest, size: r.size };
    } catch (e) {
      return { ok: false, message: `导出失败：${e && e.message ? e.message : e}` };
    }
  });
  ipcMain.handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入备份',
      properties: ['openFile'],
      filters: [
        { name: 'Knodo 备份（.zip / .json）', extensions: ['zip', 'json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || filePaths.length === 0) return { ok: false, canceled: true };
    const src = filePaths[0];
    try {
      // ZIP 与旧 JSON 用文件头区分：PK\x03\x04 就是备份包，其余按老格式处理
      let head = Buffer.alloc(2);
      try {
        const fd = fs.openSync(src, 'r');
        fs.readSync(fd, head, 0, 2, 0);
        fs.closeSync(fd);
      } catch (e) { /* 读不到就交给下面的解析报错 */ }
      const isZip = head[0] === 0x50 && head[1] === 0x4b;

      let counts;
      let restored = null;
      let missing = [];
      let manifest = null;
      if (isZip) {
        const r = backup.importArchive(src);
        counts = r.counts; restored = r.restored; missing = r.missing; manifest = r.manifest;
      } else {
        const data = JSON.parse(fs.readFileSync(src, 'utf8'));
        counts = db.importData(data);
        // 旧 JSON 备份天然不含附件：把它们也报出来，别让用户以为图片能一起回来
        missing = backup.findMissingAttachments();
      }

      // 分块是派生数据，不随备份走：导入后立刻按正文重建笔记知识库索引
      let reindexed = null;
      try {
        reindexed = knowledge.indexAll();
      } catch (e) {
        console.error('[ipc] 导入后重建知识库索引失败', e && e.message);
      }
      // 导入会整体换库：桌面浮窗里投射的清单 id 可能已经不存在了，让它们各自重拉一次
      try { desktopWindow.notifyChange(null); } catch (e) { /* 广播失败不影响导入结果 */ }
      return { ok: true, filePath: src, counts, restored, missing, manifest, reindexed, legacy: !isZip };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  /* ---------- 开机自启动（只读） ---------- */
  // 写入入口只有应用菜单「File → 开机自启动」（见 main.js 的 toggleAutoStart），
  // 这里只暴露状态读取，供界面核对系统里实际登记的启动项。
  ipcMain.handle('app:getAutoStart', () => autostart.getState());

  /* ---------- 设置中心 · 环境信息 ---------- */
  // 只读快照：数据目录在哪、备份有几份。写入型操作（换目录 / 恢复备份）走各自的对话框，
  // 因为它们需要二次确认与进度提示，不适合做成「点一下就好了」的 IPC。
  ipcMain.handle('app:getStorageInfo', () => storage.getInfo());
  ipcMain.handle('app:getBackupInfo', () => backup.getInfo());
  /**
   * 在文件管理器里打开数据目录 / 备份目录。
   * 只认这两个枚举值，不接受任意路径 —— 否则渲染层就拿到了一个万能 shell.openPath。
   */
  ipcMain.handle('app:openPath', async (_e, kind) => {
    const which = String(kind || '');
    const dir = which === 'data' ? storage.getInfo().dir
      : which === 'backup' ? backup.getInfo().dir
        : '';
    if (!dir) return { ok: false, reason: '未知的目录' };
    const msg = await shell.openPath(dir);
    return msg ? { ok: false, reason: msg } : { ok: true };
  });

  /* ---------- 应用 / 主题 ---------- */
  ipcMain.handle('theme:get', () => db.getSetting('theme', 'system'));
  ipcMain.handle('theme:set', (_e, mode) => {
    // 只存库不生效是这里以前的 bug：切换主题后窗口标题栏 / 原生菜单 / 滚动条
    // 仍停在旧主题，直到下次启动才变 —— 表现为「主题样式异常」。
    const m = ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
    db.setSetting('theme', m);
    nativeTheme.themeSource = m;
    return m;
  });
  // 强调色（用于区分分组 / 标签的主色，仅影响新渲染的日历高亮等元素）
  ipcMain.handle('accent:get', () => db.getSetting('accent', ''));
  ipcMain.handle('accent:set', (_e, hex) => {
    db.setSetting('accent', hex || '');
    return db.getSetting('accent', '');
  });
  // 详情侧边栏宽度（px），0 表示使用默认宽度
  ipcMain.handle('ui:getDetailWidth', () => Number(db.getSetting('ui.detailWidth', '0')) || 0);
  ipcMain.handle('ui:setDetailWidth', (_e, width) => {
    const w = Math.max(0, Math.round(Number(width) || 0));
    db.setSetting('ui.detailWidth', String(w));
    return w;
  });
  // 侧边栏宽度（px），0 表示使用默认宽度
  ipcMain.handle('ui:getSidebarWidth', () => Number(db.getSetting('ui.sidebarWidth', '0')) || 0);
  ipcMain.handle('ui:setSidebarWidth', (_e, width) => {
    const w = Math.max(0, Math.round(Number(width) || 0));
    db.setSetting('ui.sidebarWidth', String(w));
    return w;
  });
  // 标签筛选：存到 settings，重启后仍保留（null 表示不筛选）
  ipcMain.handle('ui:getTagFilter', () => {
    const raw = db.getSetting('ui.tagFilter', '');
    const n = Number(raw);
    return raw === '' ? null : (Number.isFinite(n) ? n : null);
  });
  ipcMain.handle('ui:setTagFilter', (_e, id) => {
    const v = id == null || id === '' ? '' : String(Number(id));
    db.setSetting('ui.tagFilter', Number.isFinite(Number(id)) && v !== '' ? v : '');
    return true;
  });
  // 「今天」里刚完成、仍留在列表中的任务：连自然日一起存，跨天自动失效（不靠内存，切视图/重启都不丢）
  ipcMain.handle('ui:getTodayDone', () => {
    const raw = db.getSetting('ui.todayDone', '');
    if (!raw) return { day: '', ids: [] };
    try {
      const v = JSON.parse(raw);
      const ids = Array.isArray(v && v.ids) ? v.ids.map(Number).filter(Number.isFinite) : [];
      return { day: String((v && v.day) || ''), ids };
    } catch (e) {
      return { day: '', ids: [] };
    }
  });
  ipcMain.handle('ui:setTodayDone', (_e, { day, ids } = {}) => {
    const list = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
    if (!day || !list.length) db.setSetting('ui.todayDone', '');
    else db.setSetting('ui.todayDone', JSON.stringify({ day: String(day), ids: list }));
    return true;
  });
  // 任务列表里被折叠的分组（键为分组 id 字符串，未分组用 '__none'）：存 settings，重启后仍保持
  ipcMain.handle('ui:getCollapsedGroups', () => {
    const raw = db.getSetting('ui.collapsedGroups', '');
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  });
  ipcMain.handle('ui:setCollapsedGroups', (_e, keys) => {
    const list = Array.isArray(keys) ? keys.map(String).filter(Boolean) : [];
    db.setSetting('ui.collapsedGroups', list.length ? JSON.stringify(list) : '');
    return true;
  });
  // 上班鼓励器的薪资配置：月薪（元）+ 上班 / 下班时间（HH:MM），入口在「设置 → 趣味功能」。
  // 只做「读得到 / 写回去了」的搬运，计算与校验都在渲染层（要按当前时间实时刷新，没必要过主进程）。
  ipcMain.handle('ui:getSalary', () => {
    const raw = db.getSetting('tool.salary', '');
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      return {
        monthly: Number(v.monthly) || 0,
        start: String(v.start || ''),
        end: String(v.end || ''),
      };
    } catch (e) {
      return null;
    }
  });
  ipcMain.handle('ui:setSalary', (_e, p = {}) => {
    const cfg = {
      monthly: Math.max(0, Number(p.monthly) || 0),
      start: String(p.start || ''),
      end: String(p.end || ''),
    };
    db.setSetting('tool.salary', JSON.stringify(cfg));
    return cfg;
  });
  // 实用工具（文本对比 / JSON 查看器）的选项：语言 / 对比模式 / 缩进等。
  // 同样是纯搬运——格式化与对比都在渲染层做（要按需加载第三方库、实时响应输入，没必要过主进程）。
  // key 白名单：避免渲染层拿它当任意键值存储使用。
  // calendar：日历视图的容量 / 周起始 / 显示已完成 / 上次视图 / 首启提示（见设计方案 6.3）
  // encourager：上班鼓励器的玩法与隐私配置（不存月薪，月薪一律读 tool.salary）。零 DB 迁移。
  const TOOL_PREF_KEYS = ['diff', 'json', 'calendar', 'encourager'];
  ipcMain.handle('ui:getToolPref', (_e, key) => {
    const k = TOOL_PREF_KEYS.includes(String(key || '')) ? String(key) : '';
    if (!k) return null;
    const raw = db.getSetting(`tool.${k}`, '');
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch (e) {
      return null;
    }
  });
  ipcMain.handle('ui:setToolPref', (_e, key, p) => {
    const k = TOOL_PREF_KEYS.includes(String(key || '')) ? String(key) : '';
    if (!k) return false;
    const v = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    db.setSetting(`tool.${k}`, JSON.stringify(v));
    return true;
  });
  // 外链是通用通道：只放行 http/https。放开 file:// / ms-settings: / UNC（\\host\share 在 Windows
  // 上会外发 NTLM 凭据）等于给渲染层留一把万能钥匙，将来任何一处逻辑把它当「打开链接」用都会中招。
  ipcMain.handle('app:openExternal', async (_e, url) => {
    const s = String(url || '').trim();
    if (!/^https?:\/\//i.test(s)) return { ok: false, reason: '仅支持 http/https 链接' };
    try {
      await shell.openExternal(s);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : String(e) };
    }
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  /**
   * 「用了 N 天了」的提示阈值（天）。
   * 本地想立刻看效果：把它临时改成 0，然后在「今天」把任务全部勾完即可。
   */
  const SPONSOR_ASK_MIN_DAYS = 15;

  /**
   * 「用了 N 天了」的一次性提示。
   *
   * 天数与「是否已经问过」都只在主进程判定，渲染层只负责汇报
   * 「今天是不是真的全部做完了」——那是渲染层唯一知道的事。
   *
   * 首次启动时间缺失时用最早任务的创建时间兜底，否则老用户升级后
   * 要从今天重新起算 15 天，等于永远看不到。
   */
  ipcMain.handle('app:sponsorPrompt', () => {
    try {
      if (db.getSetting('sponsorPrompted')) return { show: false };
      const first = db.getSetting('firstLaunchAt') || db.earliestTaskAt();
      if (!first) return { show: false };
      const ms = Date.now() - new Date(first).getTime();
      if (!Number.isFinite(ms)) return { show: false };
      const days = Math.floor(ms / 86400000);
      if (days < SPONSOR_ASK_MIN_DAYS) return { show: false };
      // 先记账再返回：这次没弹出来也认了，宁可少问一次，也不要天天问
      db.setSetting('sponsorPrompted', new Date().toISOString());
      return { show: true, days };
    } catch (e) {
      return { show: false };
    }
  });

  /* ---------- 番茄钟（专注计时） ---------- */
  ipcMain.handle('focus:state', () => focus.getState());
  ipcMain.handle('focus:start', withDb((p) => focus.start(p || {})));
  ipcMain.handle('focus:togglePause', withDb(() => focus.togglePause()));
  ipcMain.handle('focus:settle', withDb((outcome, note) => focus.settle(outcome, note || '')));
  ipcMain.handle('focus:cancel', withDb(() => focus.cancel()));
  ipcMain.handle('focus:manualEnd', withDb(() => focus.manualEnd()));
  ipcMain.handle('focus:counts', withDb((taskIds) => db.focusCountsForTasks(Array.isArray(taskIds) ? taskIds : [])));
  ipcMain.handle('focus:today', withDb(() => db.todayFocusCount()));
  ipcMain.handle('focus:timeline', withDb((taskId) => db.listFocusSessions(taskId)));
}

module.exports = { registerIpc };
