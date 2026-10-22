'use strict';
/**
 * 检索联想引擎（本地召回 + 打分排序，不依赖 AI Key）。
 *
 * 解决的问题：原来的检索只做 SQL LIKE 子串匹配，关键词只要没在标题/描述/标签里原样出现，
 * 就返回空结果。真实场景里用户常常输入的是缩写（ui）、同义说法（缺陷 vs bug）、
 * 错字（wrok）、状态或时间描述（待办 / 本周），这些都命中不了。
 *
 * 这里的做法是「多层召回 + 加权打分 + 置信度分级」：
 *   1. 精确层：标题完全一致 / 标题完整包含关键词 → 直接高置信命中，跳过联想；
 *   2. 字面层：关键词分词后逐词比对标题、标签、描述、分组名；
 *   3. 联想层：同义词 / 缩写还原 / 近似拼写（编辑距离）/ 状态语义 / 时间语义；
 *   4. 分级：高置信唯一匹配 unique / 多个候选 candidates / 确实无关联 none。
 *
 * 每一条候选都带 reasons（命中依据 + 由哪个关键词推导而来），界面上直接展示，
 * 用户能看出"为什么这条被找出来"，而不是面对一个黑盒排序。
 *
 * 全部计算在本地完成，因此没配 AI Key 也能用；配了 Key 时由 ai.rankSearchCandidates
 * 再做一次语义重排（只重排、不新增，避免编造）。
 */

/* ------------------------------ 文本工具 ------------------------------ */

/** 标点 / 空白：归一化时一律剔除，避免「前端, 优化」和「前端 优化」被当成两个词 */
const PUNCT_RE = /[\s\u3000,.;:!?'"“”‘’()[\]{}<>《》·、，。；：！？（）【】\-_/\\|+*=&%$#@~^`]+/g;

/** 归一化：全角转半角 + 转小写 + 去标点空白 */
function normalize(s) {
  return String(s == null ? '' : s)
    // 全角 ASCII（！-～）→ 半角
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(PUNCT_RE, '')
    .trim();
}

/** 描述字段是所见即所得编辑器的 HTML，取纯文本再参与匹配 */
function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** 中文里没信息量的字：参与匹配只会制造噪音 */
const STOP_CHARS = new Set(
  ('的了和与我是在有你他她它们这那个们到为以就都而或被把给对从向吧呢吗啊哦嗯上下中大小多少好做去来要会能可'
    + '我你他之于及其并且但是因为所以如果然后还有没有一下一个一些什么怎么这样那样').split('')
);

/**
 * 分词：英文/数字按词切；中文按段取「整段 + bigram」（单字只在关键词本身就是单字时用）。
 * 单字权重很低（W_SINGLE），因此「优化」不会因为「化」而误命中一堆无关任务。
 */
function tokenize(raw) {
  const s = normalize(raw);
  if (!s) return [];
  const out = new Set();
  for (const w of s.match(/[a-z0-9]+/g) || []) out.add(w);
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length === 1) { if (!STOP_CHARS.has(seg)) out.add(seg); continue; }
    out.add(seg);
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out].filter(Boolean);
}

const W_SINGLE = 0.4; // 单字 token 的权重折扣

/**
 * 编辑距离（Damerau-Levenshtein）：在 Levenshtein 基础上把"相邻字符交换"算 1 次编辑。
 * 这一条对中文/英文错字很关键 —— wrok 与 work 只是 o 和 r 打反，
 * 普通 Levenshtein 记 2 次替换会被 4 字词的容差（1）挡掉，而它才是典型的笔误。
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return Math.max(la, lb);
  if (Math.abs(la - lb) > 3) return 99;
  let prev2 = null;
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i += 1) {
    const cur = [i];
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // 相邻字符交换：a[i-1]==b[j-2] 且 a[i-2]==b[j-1]
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[lb];
}

/** 允许的最大编辑距离：词越短越严格，避免 3 个字的词随便近似 */
function fuzzyTolerance(len) {
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

/** 两个词是否算"近似拼写" */
function isNear(a, b) {
  if (a === b) return false; // 完全相等走精确/字面通道，不算近似
  const tol = fuzzyTolerance(Math.max(a.length, b.length));
  if (tol === 0) return false;
  return levenshtein(a, b) <= tol;
}

/* ------------------------------ 同义词 / 缩写词典 ------------------------------ */

/**
 * 同义词组：组内互为近义。构建时自动生成双向索引，
 * 因此查「bug」能联想出「缺陷」，查「缺陷」也能联想回「bug」。
 */
const SYNONYM_GROUPS = [
  ['bug', '缺陷', '故障', '问题', '异常', '报错', '错误', 'issue', 'fix', '修复', '排查', '复现', '崩溃', 'crash'],
  ['ui', '界面', '前端', '页面', '样式', 'css', '视觉', '交互', '布局', '网页', 'web', 'h5'],
  ['api', '接口', '后端', '服务端', 'server', '服务', '数据库', 'db', 'sql', '缓存', 'redis'],
  ['会议', '开会', 'meeting', '纪要', '评审', '讨论', '同步', '对齐', '站会', '周会', '复盘', '例会'],
  ['文档', 'doc', '说明', '手册', '资料', 'wiki', '知识库', '方案', 'prd', '沉淀', '笔记'],
  ['需求', 'requirement', 'prd', 'feature', '功能', '特性', '诉求', '新功能'],
  ['上线', '发布', 'deploy', 'release', '交付', '投产', '灰度', '发版', '提测'],
  ['测试', 'test', 'qa', '验证', '联调', '自测', '用例', '回归', '验收'],
  ['数据', '报表', '统计', '分析', '指标', '度量', '看板', 'dashboard', '图表', 'kpi'],
  ['报销', '发票', '费用', '财务', '预算', '付款', '结算', '成本'],
  ['招聘', '面试', '简历', 'hr', '人力', '入职', '离职', '试用期', '候选人'],
  ['周报', '汇报', '总结', '月报', '日报', 'report', '述职', '复盘'],
  ['学习', '培训', '课程', '教程', '调研', '研究', '分享', '技术调研', '看书'],
  ['优化', '重构', '性能', '提速', 'refactor', '清理', '整理', '精简', '提效'],
  ['客户', '甲方', '对接', '沟通', '拜访', '反馈', '售后', '商务'],
  ['紧急', 'urgent', 'asap', '加急', '尽快', '马上', '优先', '高优'],
  ['逾期', '超期', '过期', '延期', 'delay', '推迟', '拖欠'],
  ['完成', '已完成', 'done', '做完', '搞定', '完结', 'finished', '收尾', '结束'],
  ['待办', 'todo', '未完成', '待处理', 'pending', '遗留', '待跟进', '进行中'],
  ['归档', 'archive', '存档', '历史', '旧'],
  ['登录', '注册', '账号', '权限', 'auth', '认证', '密码', 'token', 'sso', '鉴权'],
  ['支付', '付款', '订单', '交易', '退款', 'pay', '收银', '结算'],
  ['app', '移动端', '安卓', 'android', 'ios', '苹果', '手机', '客户端', '小程序'],
  ['服务器', '运维', '部署', '监控', '告警', '扩容', '迁移', '域名', '证书', '备份'],
  ['安全', '漏洞', '加密', '风控', '审计', '合规', '隐私', '渗透'],
  ['设计', 'design', '设计稿', '原型', '交互稿', '视觉稿', '切图'],
  ['培训', '分享会', '宣讲', '内部分享'],
  ['合同', '协议', '法务', '盖章', '签署', '续签'],
];

/**
 * 缩写 → 全称：与同义词分开记录，因为联想依据要如实写「缩写还原」，
 * 让用户知道系统是把 ui 当成"界面/前端"来找的，而不是凭空关联。
 */
const ABBREV_MAP = {
  ui: ['界面', '前端', '样式'],
  ux: ['交互', '体验'],
  api: ['接口', '后端'],
  db: ['数据库'],
  sql: ['数据库', '查询'],
  qa: ['测试', '质量'],
  prd: ['需求', '需求文档'],
  asap: ['紧急', '尽快'],
  hr: ['招聘', '人力'],
  kpi: ['指标', '考核'],
  okr: ['目标', '考核'],
  h5: ['网页', '页面', '前端'],
  sdk: ['工具包', '接入'],
  ci: ['构建', '集成'],
  cd: ['发布', '部署'],
  cr: ['评审', '代码评审'],
  pr: ['合并请求', '代码提交'],
  mr: ['合并请求'],
  pc: ['电脑端', '桌面端'],
  bk: ['备份'],
  ops: ['运维'],
};

/** 词 → 关联词集合（同义词组 + 缩写表合并后的双向索引） */
const RELATED = (() => {
  const map = new Map();
  const add = (a, b) => {
    if (a === b) return;
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(b);
  };
  for (const group of SYNONYM_GROUPS) {
    for (const a of group) for (const b of group) add(a, b);
  }
  for (const [abbr, fulls] of Object.entries(ABBREV_MAP)) {
    for (const f of fulls) { add(abbr, f); add(f, abbr); }
  }
  return map;
})();

/**
 * 由关键词推导联想词。
 * @returns {Array<{from:string,to:string,kind:'synonym'|'abbrev'}>}
 */
function expandTerms(tokens, kwNorm) {
  const seen = new Set();
  const out = [];
  const push = (from, to, kind) => {
    const key = `${from}->${to}`;
    if (seen.has(key) || from === to) return;
    seen.add(key);
    out.push({ from, to, kind });
  };
  const sources = new Set([...tokens, kwNorm].filter(Boolean));
  for (const src of sources) {
    // 缩写先于同义词：ui→界面 应如实标注为「缩写还原」，
    // 否则会被同义词组抢先登记（ui 与"界面"同在 UI 组），依据文案就不准确了
    for (const to of ABBREV_MAP[src] || []) push(src, to, 'abbrev');
    for (const to of RELATED.get(src) || []) push(src, to, 'synonym');
  }
  return out;
}

/* ------------------------------ 状态 / 时间语义 ------------------------------ */

const p2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** 本周（周一为起点）与本月区间 */
function weekRange(now) {
  const day = (now.getDay() + 6) % 7; // 周一 = 0
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { from: isoDate(start), to: isoDate(end) };
}
function monthRange(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: isoDate(start), to: isoDate(end) };
}

/**
 * 状态语义：把「待办 / 已完成 / 逾期 / 紧急」这类词映射到任务的实际字段。
 * hit(t) 为真 → 该任务符合这个语义。
 */
function statusHints(today) {
  return [
    { label: '已完成', keys: ['完成', '已完成', '做完', 'done', '搞定', '完结', 'finished', '结束'], hit: (t) => !!t.completed },
    { label: '未完成（待办）', keys: ['待办', 'todo', '未完成', '待处理', 'pending', '遗留', '进行中', '未做'], hit: (t) => !t.completed && !t.archived },
    { label: '已归档', keys: ['归档', 'archive', '存档', '历史'], hit: (t) => !!t.archived },
    { label: '已逾期', keys: ['逾期', '超期', '过期', '延期', 'delay', '推迟', '拖欠'], hit: (t) => !t.completed && !!t.plan_end && t.plan_end < today },
    { label: '高优先级', keys: ['紧急', 'urgent', 'asap', '加急', '尽快', '马上', '优先', '高优'], hit: (t) => Number(t.priority) >= 3 },
  ];
}

/** 时间语义：把「今天 / 本周 / 本月」映射到 plan_end 区间 */
function timeHints(now) {
  const today = isoDate(now);
  const week = weekRange(now);
  const nextWeek = (() => {
    const s = new Date(`${week.from}T00:00:00`);
    s.setDate(s.getDate() + 7);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    return { from: isoDate(s), to: isoDate(e) };
  })();
  const month = monthRange(now);
  const inRange = (t, from, to) => !!t.plan_end && t.plan_end >= from && t.plan_end <= to;
  return [
    { label: '今天到期', keys: ['今天', '今日', 'today'], hit: (t) => t.plan_end === today },
    { label: '明天到期', keys: ['明天', '明日', 'tomorrow'], hit: (t) => t.plan_end === isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) },
    { label: `本周到期（${week.from} ~ ${week.to}）`, keys: ['本周', '这周', 'week'], hit: (t) => inRange(t, week.from, week.to) },
    {
      label: `下周到期（${nextWeek.from} ~ ${nextWeek.to}）`,
      keys: ['下周', 'nextweek'],
      hit: (t) => inRange(t, nextWeek.from, nextWeek.to),
    },
    { label: `本月到期（${month.from} ~ ${month.to}）`, keys: ['本月', '这月', 'month'], hit: (t) => inRange(t, month.from, month.to) },
    { label: '近期（7 天内）', keys: ['近期', '最近', 'recent', '即将'], hit: (t) => inRange(t, today, isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7))) },
  ];
}

/* ------------------------------ 打分 ------------------------------ */

/** 各通道分值：精确层远高于联想层，保证"精确命中优先" */
const PTS = {
  titleEqual: 100,
  titleContains: 55,
  titleToken: 16,
  titleRelated: 12,
  titleNear: 9,
  tagToken: 14,
  tagRelated: 7,
  groupToken: 10,
  groupRelated: 5,
  notesToken: 5,
  notesRelated: 4,
  notesContains: 6,
  status: 13,
  time: 12,
  bonusActive: 2,
  bonusPriorityHigh: 1.5,
  bonusPriorityMid: 1,
  bonusRecent: 1,
};

/** 低于此分视为"确实无关联"：仅描述命中(4)+加成(≈3) 不足以构成候选 */
const MIN_SCORE = 8;
/** 达到此分即认为强命中（精确或完整包含），可判为唯一匹配 */
const STRONG_SCORE = 55;
/**
 * 只有一个候选时的判"唯一匹配"门槛。
 * 只召回 1 条本身就说明没有歧义；若还要求它达到 STRONG_SCORE，
 * 那「已完成」这类状态语义查询（13 分）明明找到了唯一答案却要显示"待确认"，反而是误导。
 */
const SOLO_SCORE = 10;
/** 第一名领先第二名倍数：拉不开差距就列为"待确认" */
const UNIQUE_RATIO = 1.8;
/** 每条候选最多展示几条依据：列太长反而看不出主因 */
const MAX_REASONS = 3;

/**
 * 对单个任务打分。
 * @returns {{id:number, score:number, reasons:Array<{text:string, pts:number}>}|null}
 */
function scoreTask(task, ctx) {
  const t = task;
  const title = normalize(t.title);
  const notes = normalize(stripHtml(t.notes));
  const tags = (t.tag_names || []).map(normalize).filter(Boolean);
  const group = normalize(t.group_name);

  if (!title && !notes) return null;

  const reasons = [];
  let score = 0;
  const add = (pts, text) => {
    score += pts;
    reasons.push({ text, pts: Math.round(pts * 10) / 10 });
  };
  const has = (hay, needle) => !!hay && !!needle && hay.indexOf(needle) >= 0;

  /* --- 1) 精确层：完全一致 / 完整包含 --- */
  if (title && title === ctx.kwNorm) {
    add(PTS.titleEqual, `标题与关键词完全一致「${t.title}」`);
  } else if (has(title, ctx.kwNorm)) {
    add(PTS.titleContains, `标题完整包含「${ctx.kw}」`);
  }

  /* --- 2) 字面层：分词逐词比对 ---
   * 贪心覆盖：长 token 先匹配并"占掉"这段文字，短 token 不再重复计分。
   * 不做覆盖的话「登录页样式」会同时命中 登录页样式/登录页/录页样/页样式/登录/录页/页样/样式
   * 8 个 token，分数虚高、依据也列一长串，看着像凑数。 */
  const coverHit = (fieldText, fieldName, pts) => {
    if (!fieldText) return false;
    let rest = fieldText;
    let hitAny = false;
    const sorted = [...ctx.tokens].sort((a, b) => b.length - a.length);
    for (const tk of sorted) {
      const idx = rest.indexOf(tk);
      if (idx < 0) continue;
      const w = tk.length === 1 ? W_SINGLE : 1;
      add(pts * w, `关键词「${tk}」命中${fieldName}`);
      rest = rest.slice(0, idx) + ' '.repeat(tk.length) + rest.slice(idx + tk.length);
      hitAny = true;
    }
    return hitAny;
  };
  coverHit(title, '标题', PTS.titleToken);
  if (tags.some((tg) => ctx.tokens.some((tk) => has(tg, tk)))) {
    const hitTag = tags.find((tg) => ctx.tokens.some((tk) => has(tg, tk)));
    add(PTS.tagToken, `关键词命中标签「${hitTag}」`);
  }
  if (group) {
    for (const tk of ctx.tokens) {
      if (has(group, tk)) { add(PTS.groupToken, `关键词「${tk}」命中分组「${t.group_name}」`); break; }
    }
  }
  if (has(notes, ctx.kwNorm)) {
    add(PTS.notesContains, '描述中包含完整关键词');
  } else {
    coverHit(notes, '描述', PTS.notesToken);
  }

  /* --- 3) 联想层：同义词 / 缩写 --- */
  for (const rel of ctx.expanded) {
    const kindText = rel.kind === 'abbrev' ? '缩写还原' : '同义词';
    if (has(title, normalize(rel.to))) {
      add(PTS.titleRelated, `「${rel.from}」${kindText}为「${rel.to}」命中标题`);
    } else if (tags.some((tg) => has(tg, normalize(rel.to)))) {
      add(PTS.tagRelated, `「${rel.from}」${kindText}为「${rel.to}」命中标签`);
    } else if (group && has(group, normalize(rel.to))) {
      add(PTS.groupRelated, `「${rel.from}」${kindText}为「${rel.to}」命中分组`);
    } else if (has(notes, normalize(rel.to))) {
      add(PTS.notesRelated, `「${rel.from}」${kindText}为「${rel.to}」命中描述`);
    }
  }

  /* --- 4) 联想层：近似拼写（编辑距离） ---
   * 标题分词惰性化：只有关键词里存在 >=4 字的 token 时才做，
   * 否则"报销""ui"这类短词也要给几千条任务各分一次词，白白浪费时间。 */
  let titleTokens = null;
  for (const tk of ctx.tokens) {
    if (tk.length < 4) continue; // 短词不做近似，误伤太大
    if (!titleTokens) titleTokens = tokenize(t.title);
    const near = titleTokens.find((tt) => isNear(tk, tt));
    if (near) add(PTS.titleNear, `「${tk}」与标题中的「${near}」近似（可能是笔误）`);
  }

  /* --- 5) 语义层：状态 / 时间 --- */
  for (const sh of ctx.statusHints) {
    if (!sh.keys.some((k) => has(ctx.kwNorm, k))) continue;
    if (sh.hit(t)) add(PTS.status, `状态联想：「${ctx.kw}」→ ${sh.label}`);
  }
  for (const th of ctx.timeHints) {
    if (!th.keys.some((k) => has(ctx.kwNorm, k))) continue;
    if (th.hit(t)) add(PTS.time, `时间联想：「${ctx.kw}」→ ${th.label}`);
  }

  /* --- 6) 排序加成：只在已有实质命中时生效，避免把"新鲜任务"硬凑成候选 --- */
  if (reasons.length) {
    if (!t.completed && !t.archived) add(PTS.bonusActive, '未完成（优先展示）');
    if (Number(t.priority) >= 3) add(PTS.bonusPriorityHigh, '高优先级');
    else if (Number(t.priority) === 2) add(PTS.bonusPriorityMid, '中优先级');
    if (t.updated_at && t.updated_at.slice(0, 10) >= ctx.recentFrom) add(PTS.bonusRecent, '近期有更新');
  }

  if (score < MIN_SCORE) return null;
  // 依据按贡献排序后只留前几条：界面一行放不下，且主因应该排在最前面
  const topReasons = reasons
    .slice()
    .sort((a, b) => b.pts - a.pts)
    .slice(0, MAX_REASONS);
  return { id: t.id, score: Math.round(score * 10) / 10, reasons: topReasons };
}

/* ------------------------------ 主流程 ------------------------------ */

/**
 * 联想检索。
 * @param {Array} pool 候选任务池（db.listTasks({status:'any'})）
 * @param {string} keyword 用户输入的关键词
 * @param {object} [opts] { topN = 5, now = new Date() }
 * @returns {{
 *   keyword: string,
 *   type: 'unique'|'candidates'|'none',
 *   tasks: Array<object>,      // Top N，带 match:{score,reasons,confidence}
 *   tried: string[],           // 已尝试的联想方向（无关联时用于向用户说明）
 * }}
 */
function suggest(pool, keyword, opts = {}) {
  const topN = opts.topN || 5;
  const poolMax = opts.poolMax || 5000;
  const now = opts.now || new Date();
  const kw = String(keyword || '').trim();
  const kwNorm = normalize(kw);
  const tokens = tokenize(kw);
  const expanded = expandTerms(tokens, kwNorm);
  const recentFrom = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));

  const ctx = {
    kw, kwNorm, tokens, expanded, recentFrom,
    statusHints: statusHints(isoDate(now)),
    timeHints: timeHints(now),
  };

  /*
   * 打分：按分数降序，同分用"未完成优先 + 更新时间新"打破平局。
   * 池子过大时只取最近更新的一批（poolMax）：联想是交互式操作，
   * 与其让用户在几千条里等几秒，不如守住响应速度 —— 真要翻旧账，精确检索那条路依然在。
   */
  const candidates = pool.length > poolMax
    ? pool.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, poolMax)
    : pool;
  const scored = [];
  for (const t of candidates) {
    const s = scoreTask(t, ctx);
    if (!s) continue;
    scored.push({ t, ...s });
  }
  scored.sort((a, b) => (
    b.score - a.score
    || Number(!!a.t.completed) - Number(!!b.t.completed)
    || String(b.t.updated_at || '').localeCompare(String(a.t.updated_at || ''))
  ));

  const top = scored.slice(0, topN);
  const first = top[0];
  const second = top[1];

  /*
   * 置信度分级：
   *   unique     —— 强命中（精确/完整包含）且明显领先，或只召回 1 条且分数够（无歧义）
   *   candidates —— 有候选但拉不开差距，需要用户确认
   *   none       —— 连弱联想都没有，明确告知无关联
   */
  let type = 'none';
  if (first) {
    const strong = first.score >= STRONG_SCORE;
    const leading = !second || first.score >= second.score * UNIQUE_RATIO;
    const solo = !second && first.score >= SOLO_SCORE;
    type = (strong && leading) || solo ? 'unique' : 'candidates';
  }

  const tasks = top.map((s, i) => ({
    ...s.t,
    match: {
      score: s.score,
      reasons: s.reasons.map((r) => r.text),
      // 相对分：以第一名为 100，界面上画相关度条
      relevance: first ? Math.round((s.score / first.score) * 100) : 0,
      confidence: type === 'unique' && i === 0 ? 'high' : (s.score >= STRONG_SCORE ? 'high' : (s.score >= 20 ? 'mid' : 'low')),
    },
  }));

  return { keyword: kw, type, tasks, tried: triedDirections(ctx, scored) };
}

/**
 * 已尝试的联想方向。只记录"这次真的做了"的方向，
 * 因此无关联提示里不会出现"我们试了缩写联想"但其实压根没缩写可扩展的情况。
 */
function triedDirections(ctx, scored) {
  const out = [];
  out.push('全字段扫描：标题、描述、标签、分组名（含已归档任务）');
  if (ctx.tokens.length > 1) out.push(`分词比对：拆为 ${ctx.tokens.map((t) => `「${t}」`).join('、')}`);
  const syn = ctx.expanded.filter((e) => e.kind === 'synonym');
  const abbr = ctx.expanded.filter((e) => e.kind === 'abbrev');
  if (syn.length) {
    out.push(`同义联想：${syn.slice(0, 6).map((e) => `${e.from}→${e.to}`).join('、')}${syn.length > 6 ? ' 等' : ''}`);
  }
  if (abbr.length) {
    out.push(`缩写还原：${abbr.slice(0, 6).map((e) => `${e.from}→${e.to}`).join('、')}${abbr.length > 6 ? ' 等' : ''}`);
  }
  const near = scored.some((s) => s.reasons.some((r) => r.text.indexOf('近似') >= 0));
  if (near || ctx.tokens.some((t) => t.length >= 4)) out.push('近似拼写：按编辑距离容差比对标题用词');
  const st = ctx.statusHints.filter((h) => h.keys.some((k) => ctx.kwNorm.indexOf(k) >= 0));
  if (st.length) out.push(`状态语义：理解为 ${st.map((h) => h.label).join(' / ')}`);
  const tm = ctx.timeHints.filter((h) => h.keys.some((k) => ctx.kwNorm.indexOf(k) >= 0));
  if (tm.length) out.push(`时间语义：${tm.map((h) => h.label).join(' / ')}`);
  return out;
}

module.exports = {
  normalize,
  tokenize,
  stripHtml,
  levenshtein,
  suggest,
  MIN_SCORE,
  STRONG_SCORE,
};
