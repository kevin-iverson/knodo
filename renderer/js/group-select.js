'use strict';
/**
 * 分组下拉的统一外观（Tom Select）：AI 报告的多选筛选、任务就地编辑器的单选归属共用。
 *
 * 之所以抽出来：AI 报告页里的色块 + 层级缩进 + 圆角搜索面板是项目里分组选择的标准样式，
 * 任务表单里原来是浏览器原生 <select>（白色直角、用全角空格拼缩进），两者观感割裂。
 * 组件本体已 vendor 在 renderer/vendor/tom-select，主题样式在 css/styles.css 的 .ts-* 段。
 *
 * 注意：Tom Select 会把原始 <select> 藏起来但保留并同步它的 value，
 * 所以现有的 collectEditorPayload / 自动保存（监听原生 input / change）逻辑都不用改。
 */
import { flattenGroupTree } from './group-tree.js';

const DEFAULT_COLOR = '#c3cad6';
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 生成带层级 / 颜色元信息的 <option>：文字保持纯分组名，缩进与色块交给 render 函数。
 * @param {Array} groups 扁平分组数组
 * @param {number|string|null} selectedId 选中项
 * @param {{empty?: boolean}} opts empty=false 时不生成「无分组」（AI 报告多选不需要）
 */
function groupPickerOptionsHtml(groups, selectedId = null, opts = {}) {
  const { empty = true } = opts;
  const rows = [];
  if (empty) {
    rows.push(`<option value="" data-depth="0" data-color="${DEFAULT_COLOR}"${selectedId == null || selectedId === '' ? ' selected' : ''}>无分组</option>`);
  }
  flattenGroupTree(Array.isArray(groups) ? groups : [], { respectExpansion: false })
    .forEach(({ g, depth }) => {
      rows.push(`<option value="${esc(g.id)}" data-depth="${depth}" data-color="${esc(g.color || DEFAULT_COLOR)}"${selectedId === g.id ? ' selected' : ''}>${esc(g.name)}</option>`);
    });
  return rows.join('');
}

function groupDot(data, escapeHtml) {
  return `<span class="ts-dot" style="background:${escapeHtml(data.color || DEFAULT_COLOR)}"></span>`;
}

/** 下拉选项：色块 + └ 层级；父分组已选中时子孙置灰并标「随父分组」 */
function renderGroupOption(data, escapeHtml) {
  const depth = Number(data.depth) || 0;
  const locked = !!data.disabled;
  return `<div class="ts-opt${locked ? ' is-locked' : ''}" style="padding-left:${6 + depth * 14}px">`
    + (depth ? '<span class="ts-tree">└</span>' : '')
    + groupDot(data, escapeHtml)
    + `<span class="ts-name">${escapeHtml(data.text)}</span>`
    + (locked ? '<span class="ts-lock">随父分组</span>' : '')
    + '</div>';
}

/** 已选条目（报告的 chip / 编辑器里显示的那一项）：色块 + 名称 */
function renderGroupItem(data, escapeHtml) {
  return `<span class="ts-item">${groupDot(data, escapeHtml)}${escapeHtml(data.text)}</span>`;
}

function renderNoResults() {
  return '<div class="no-results">没有匹配的分组</div>';
}

/** TomSelect 实例 -> 原始 <select>：视图整块重绘前要逐个 destroy，避免 body 上的下拉残留 */
const registry = new Map();

function destroyGroupSelect(ts) {
  if (!ts) return;
  registry.delete(ts);
  try { ts.destroy(); } catch (_e) { /* 已经销毁过 */ }
}

function destroyGroupSelectsIn(root) {
  if (!root) return;
  for (const [ts, input] of [...registry]) {
    if (input === root || root.contains(input)) destroyGroupSelect(ts);
  }
}

function destroyAllGroupSelects() {
  for (const ts of [...registry.keys()]) destroyGroupSelect(ts);
}

/**
 * 创建分组下拉。
 * @param {HTMLSelectElement} el 原始 select（option 由 groupPickerOptionsHtml 生成）
 * @param {object} options { multiple:boolean, ...TomSelect 配置覆盖项 }
 * @returns {TomSelect|null} 依赖缺失 / 初始化失败时返回 null，原生 select 仍可用
 */
function createGroupSelect(el, options = {}) {
  if (!el) return null;
  const { multiple = false, ...overrides } = options;
  if (typeof window.TomSelect !== 'function') {
    // 降级：把树形缩进补回原生 option 文本（Tom Select 在时缩进由 render 负责）
    el.querySelectorAll('option[data-depth]').forEach((op) => {
      const d = Number(op.dataset.depth) || 0;
      if (d && !op.dataset.nativeTree) {
        op.textContent = `${'　'.repeat(d)}└ ${op.textContent}`;
        op.dataset.nativeTree = '1';
      }
    });
    return null;
  }
  for (const [ts, input] of [...registry]) {
    if (input === el) destroyGroupSelect(ts);
  }

  const settings = {
    // 单选：搜索框放进下拉面板顶部，控件本身只显示「色块 + 当前分组 + 箭头」，
    // 不会出现「已选文字和搜索占位符并排显示」的重复；多选维持报告的 chips 形态。
    plugins: multiple ? ['remove_button', 'clear_button'] : ['dropdown_input'],
    // 挂到 body：报告区 / 任务列表都在可滚动容器里，挂在容器内会被下边缘裁掉
    dropdownParent: 'body',
    dropdownClass: 'ts-dropdown group-picker-dropdown',
    allowEmptyOption: !multiple, // 单选取「无分组」是空值选项，必须允许选
    create: false,
    maxItems: multiple ? null : 1,
    closeAfterSelect: !multiple,
    // 单选要始终能看到「无分组」，否则选中某个分组后再也切不回未分组
    hideSelected: !!multiple,
    maxOptions: 300,
    placeholder: multiple ? '全部分组（不选即全部）' : '搜索分组…',
    render: {
      option: renderGroupOption,
      item: renderGroupItem,
      no_results: renderNoResults,
    },
    ...overrides,
  };

  let ts;
  try { ts = new window.TomSelect(el, settings); } catch (_e) { return null; }
  registry.set(ts, el);
  return ts;
}

export {
  groupPickerOptionsHtml,
  createGroupSelect,
  destroyGroupSelect,
  destroyGroupSelectsIn,
  destroyAllGroupSelects,
};
