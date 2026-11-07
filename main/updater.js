'use strict';
/**
 * 检查更新：查询 Gitee Release（与 scripts/release-gitee.js 的发布目标一致）。
 *
 * 为什么不用 electron-updater 自动升级：
 *  - 发版脚本只上传安装版 / 便携版 / 7z，没有生成 latest.yml 等更新元数据；
 *  - 便携版是单文件、安装版是 NSIS，两种形态的替换动作不同，不能共用一套自动安装；
 *  - 引入自动更新要改发版流程并新增运行时依赖，会顶到「dependencies 只留两个」的体积铁律。
 * 这里只做「查 + 比对 + 给出下载入口」，下载与替换永远由用户决定。
 *
 * 本模块刻意不 require('electron')：纯 Node 就能跑，方便离线单测版本比对逻辑。
 */
const pkg = require('../package.json');

const API_ROOT = 'https://gitee.com/api/v5';
const SITE_ROOT = 'https://gitee.com';
const REQUEST_TIMEOUT_MS = 8000;

/** 仓库地址以 package.json 的 repository 为唯一来源（打包后没有 .git 可解析）。 */
function repoInfo() {
  const raw = typeof pkg.repository === 'string'
    ? pkg.repository
    : (pkg.repository && pkg.repository.url) || '';
  const m = String(raw).match(/gitee\.com[:/](.+)$/i);
  if (!m) throw new Error('package.json 缺少 Gitee 仓库地址（repository）');
  const slug = m[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error('repository 里的 Gitee 仓库地址不合法');
  return {
    slug,
    api: `${API_ROOT}/repos/${slug}/releases`,
    releasePage: `${SITE_ROOT}/${slug}/releases`,
  };
}

/** 外部数据一律先校验再交给 shell.openExternal，避免 API 返回什么就打开什么。 */
function isGiteeUrl(url) {
  return /^https:\/\/gitee\.com\/[\w.\-/%?=&+]+$/i.test(String(url || ''));
}

/** 'v1.13.0' / '2.0.0-beta.1' → [1,13,0]；非语义化 tag 直接忽略。 */
function parseVersion(tag) {
  const m = String(tag || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+.][0-9A-Za-z.-]+)?$/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

async function getJson(url) {
  if (typeof fetch !== 'function') throw new Error('当前运行环境不支持网络请求');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': `Knodo/${pkg.version}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 把 API 的原始 release 收敛成内部形状，顺手过滤掉不合法字段。 */
function normalizeRelease(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tag = String(raw.tag_name || '').trim();
  const parsed = parseVersion(tag);
  if (!parsed || !/^[A-Za-z0-9._-]+$/.test(tag)) return null;
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  const portable = assets.find((a) => a && /便携版.*\.exe$/i.test(String(a.name || ''))
    && isGiteeUrl(a.browser_download_url));
  return {
    tag,
    parsed,
    prerelease: !!raw.prerelease,
    name: String(raw.name || tag).slice(0, 120),
    publishedAt: String(raw.created_at || '').slice(0, 10),
    body: String(raw.body || ''),
    downloadUrl: portable ? portable.browser_download_url : '',
  };
}

/** Release 说明是长 Markdown：去掉标记后只取前几行，避免原生对话框撑爆。 */
function summarize(md, maxChars = 360) {
  const lines = String(md || '').split(/\r?\n/)
    .map((l) => l.replace(/^#{1,6}\s*/, '').replace(/^\s*[-*>]\s*/, '')
      .replace(/[`*_]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').trim())
    .filter((l) => l && !/^https?:\/\//i.test(l));
  const text = lines.slice(0, 8).join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function fail(reason, urls) {
  return { ok: false, reason, releaseUrl: urls ? urls.releasePage : '' };
}

/**
 * 检查是否有新版本。
 * latest 端点与 releases 列表并行请求：任一失败仍可用另一个结果；
 * 取「正式版里版本号最大」的一条，避免 latest 指向被复用的旧 release 时漏报。
 *
 * @param {string} currentVersion 本机版本（app.getVersion()）
 * @returns {Promise<object>} { ok, current, latest, tag, hasUpdate, name, publishedAt,
 *                             summary, releaseUrl, downloadUrl } 或 { ok:false, reason, releaseUrl }
 */
async function checkUpdate(currentVersion) {
  let urls;
  try {
    urls = repoInfo();
  } catch (e) {
    return fail(e.message, null);
  }
  const current = String(currentVersion || '').trim();
  const curParsed = parseVersion(current);
  if (!curParsed) return fail(`无法识别当前版本号：${current || '(空)'}`, urls);

  const results = await Promise.allSettled([
    getJson(`${urls.api}/latest`),
    getJson(`${urls.api}?per_page=100&page=1`),
  ]);
  const candidates = [];
  if (results[0].status === 'fulfilled') {
    const one = normalizeRelease(results[0].value);
    if (one) candidates.push(one);
  }
  if (results[1].status === 'fulfilled' && Array.isArray(results[1].value)) {
    results[1].value.forEach((r) => {
      const one = normalizeRelease(r);
      if (one) candidates.push(one);
    });
  }
  const stable = candidates.filter((c) => !c.prerelease);
  const pool = stable.length ? stable : candidates;
  if (!pool.length) {
    return fail('未能获取版本信息（网络不可达、接口限流或请求超时），请稍后重试', urls);
  }
  const best = pool.sort((a, b) => compareVersion(b.parsed, a.parsed))[0];
  return {
    ok: true,
    current,
    latest: best.tag.replace(/^v/i, ''),
    tag: best.tag,
    hasUpdate: compareVersion(best.parsed, curParsed) > 0,
    name: best.name,
    publishedAt: best.publishedAt,
    summary: summarize(best.body),
    releaseUrl: urls.releasePage,
    downloadUrl: best.downloadUrl,
  };
}

function releasePageUrl() {
  try { return repoInfo().releasePage; } catch { return ''; }
}

module.exports = {
  checkUpdate,
  releasePageUrl,
  // 导出给单测用
  _internal: { repoInfo, parseVersion, compareVersion, normalizeRelease, summarize, isGiteeUrl },
};
