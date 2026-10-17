'use strict';
/**
 * 分组树的纯工具函数（不依赖 store / DOM，可被侧边栏、任务详情页、AI 报告页共用）。
 *
 * 数据模型：groups 表中每行带 parent_id（自引用），任务是扁平的 { id, parent_id } 列表。
 * 这里负责把它变成「树形顺序」以及路径 / 子孙集合等派生数据。
 */

/**
 * 扁平分组列表 → 前序展开的树形顺序（父在前、子紧随其后，同级保持原 sort_order）。
 * @param {Array} groups 扁平分组数组
 * @param {object} [opts]
 * @param {Set<number>} [opts.expanded] 已展开的分组 id 集合；传入后未展开的分支会被跳过
 * @param {boolean} [opts.respectExpansion] 是否按 expanded 过滤（下拉列表传 false 取全树）
 * @returns {Array<{g:object, depth:number}>}
 */
function flattenGroupTree(groups, opts = {}) {
  const {
    expanded = null,
    respectExpansion = true,
    parentId = null,
    depth = 0,
    out = [],
    guard = new Set(),
  } = opts;
  groups
    .filter((g) => (g.parent_id ?? null) === (parentId ?? null))
    .forEach((g) => {
      // 历史脏数据可能成环，这里兜底防止无限递归把界面卡死
      if (guard.has(g.id)) return;
      guard.add(g.id);
      out.push({ g, depth });
      const kidsExpanded = !respectExpansion || !expanded || expanded.has(g.id);
      if (kidsExpanded) {
        flattenGroupTree(groups, {
          expanded, respectExpansion, parentId: g.id, depth: depth + 1, out, guard,
        });
      }
    });
  return out;
}

/** 某分组的直接子分组 */
function childGroups(groups, id) {
  return groups.filter((g) => (g.parent_id ?? null) === (id ?? null));
}

/** 某分组的全部子孙 id（不含自身） */
function descendantGroupIds(groups, id) {
  const out = [];
  const walk = (pid) => {
    childGroups(groups, pid).forEach((c) => {
      out.push(c.id);
      walk(c.id);
    });
  };
  walk(id);
  return out;
}

/** 分组完整路径："父 / 子 / 孙" */
function groupPath(g, groups = []) {
  const names = [];
  const guard = new Set();
  let cur = g;
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parent_id != null ? groups.find((x) => x.id === cur.parent_id) : null;
  }
  return names.join(' / ');
}

/**
 * 分组下拉 <option> 列表（树形缩进）。
 * @param {Array} groups 扁平分组数组
 * @param {number|null} selectedId 选中项
 * @param {number[]} [excludeIds] 排除项（编辑分组时用来排除自己及其子孙，防止成环）
 */
function groupOptionsHtml(groups, selectedId, excludeIds = []) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const opts = ['<option value="">无分组</option>'];
  flattenGroupTree(groups, { respectExpansion: false }).forEach(({ g, depth }) => {
    if (excludeIds.includes(g.id)) return;
    const pad = depth ? `${'　'.repeat(depth)}└ ` : '';
    opts.push(`<option value="${g.id}"${selectedId === g.id ? ' selected' : ''}>${esc(pad + g.name)}</option>`);
  });
  return opts.join('');
}

export {
  flattenGroupTree, childGroups, descendantGroupIds, groupPath, groupOptionsHtml,
};
