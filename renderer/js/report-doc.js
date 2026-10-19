'use strict';
/**
 * 报告文档视图：Markdown ⇄ 类 Word 排版的 HTML。
 *
 * 为什么不用现成的 markdown.js：
 * 1) 报告要按 Word 的版式呈现（标题层级、段落缩进、表格线），markdown.js 只输出裸标签；
 * 2) 表格必须真渲染成 <table>——markdown.js 目前不解析表格；
 * 3) 需要反向序列化：contenteditable 编辑过 DOM 之后，要能把结构原样还原成 Markdown，
 *    否则「在线编辑」改的内容导出会丢。
 *
 * 双向都要保证：mdToDocHtml → 编辑 → docHtmlToMd 的往返不丢结构（标题/列表/表格/强调）。
 */

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
const UL_MARKS = new Set(['-', '*', '+']);

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内标记：代码 → 粗体 → 删除线 → 斜体（与 markdown.js 同序，避免互相破坏） */
function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 表格行 → HTML（首行若是表头则生成 thead；分隔行不产出数据） */
function tableHtml(rows) {
  const parsed = rows.map(splitRow);
  const hasHead = parsed.length > 1 && TABLE_SEP.test(rows[1]);
  const head = hasHead ? parsed[0] : null;
  const body = hasHead ? parsed.slice(2) : parsed;
  const thead = head
    ? `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
    : '';
  const tbody = `<tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<table class="rp-table">${thead}${tbody}</table>`;
}

/**
 * Markdown → 文档 HTML。
 * @param {string} md
 * @returns {string} 片段 HTML（不含最外层容器）
 */
export function mdToDocHtml(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let list = null; // { tag:'ul'|'ol', mark:string, items:string[] }
  let tbl = [];
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join('\n'))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((t) => `<li>${inline(t)}</li>`).join('');
    out.push(list.tag === 'ol'
      ? `<ol>${items}</ol>`
      : `<ul data-ul-mark="${escapeHtml(list.mark)}">${items}</ul>`);
    list = null;
  };
  const flushTable = () => {
    if (!tbl.length) return;
    out.push(tableHtml(tbl));
    tbl = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushAll();
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (TABLE_ROW.test(line)) {
      flushPara();
      flushList();
      tbl.push(line);
      continue;
    }
    flushTable();

    if (!line.trim()) { flushPara(); flushList(); continue; }

    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      const lvl = Math.min(h[1].length, 4);
      out.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushAll(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*([-*+])\s+(.*)$/);
    if (ul) {
      flushPara();
      flushTable();
      const mark = ul[1];
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', mark, items: [ul[2]] }; }
      else list.items.push(ul[2]);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      flushTable();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', mark: '', items: [ol[1]] }; }
      else list.items.push(ol[1]);
      continue;
    }

    flushList();
    para.push(line);
  }
  flushAll();
  if (inCode) out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  return out.join('');
}

/** DOM 子树 → Markdown 行内片段（b/i/del/code/br 还原成标记） */
function inlineToMd(node) {
  let out = '';
  Array.from(node.childNodes).forEach((child) => {
    if (child.nodeType === 3) { out += child.nodeValue; return; }
    if (child.nodeType !== 1) return;
    const tag = child.tagName.toLowerCase();
    const inner = inlineToMd(child);
    if (tag === 'br') { out += '\n'; return; }
    if (tag === 'strong' || tag === 'b') { out += inner.trim() ? `**${inner.trim()}**` : inner; return; }
    if (tag === 'em' || tag === 'i') { out += inner.trim() ? `*${inner.trim()}*` : inner; return; }
    if (tag === 'del' || tag === 's' || tag === 'strike') { out += inner.trim() ? `~~${inner.trim()}~~` : inner; return; }
    if (tag === 'code') { out += `\`${inner}\``; return; }
    out += inner;
  });
  return out;
}

/** <table> → Markdown 表格（表头行后补分隔行） */
function tableToMd(table) {
  const trs = Array.from(table.querySelectorAll('tr'));
  if (!trs.length) return '';
  const rows = trs.map((tr) => Array.from(tr.children)
    .map((c) => inlineToMd(c).trim().replace(/\|/g, '\\|')));
  const colCount = Math.max(...rows.map((r) => r.length));
  const pad = (r) => {
    const cells = r.slice();
    while (cells.length < colCount) cells.push('');
    return `| ${cells.join(' | ')} |`;
  };
  const hasHead = !!table.querySelector('thead tr');
  const lines = [];
  rows.forEach((r, i) => {
    lines.push(pad(r));
    if (hasHead && i === 0) lines.push(`| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`);
  });
  return lines.join('\n');
}

/**
 * 文档 DOM → Markdown（contenteditable 编辑后回写用）。
 * contenteditable 在 Chromium 里回车常产出 <div>，因此 div/p 一并按段落处理。
 * @param {HTMLElement} root
 * @returns {string}
 */
export function docHtmlToMd(root) {
  if (!root) return '';
  const out = [];

  const walk = (container) => {
    Array.from(container.children).forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
        const lvl = Number(tag.slice(1));
        out.push(`${'#'.repeat(lvl)} ${inlineToMd(el).trim()}`);
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        Array.from(el.children).forEach((li, i) => {
          if (li.tagName.toLowerCase() !== 'li') return;
          // 无序列表保留原始符号（- / * / +），有序列表按序号重排
          const mark = tag === 'ol'
            ? `${i + 1}. `
            : `${UL_MARKS.has(el.dataset.ulMark) ? el.dataset.ulMark : '-'} `;
          out.push(mark + inlineToMd(li).trim());
        });
        return;
      }
      if (tag === 'blockquote') { out.push(`> ${inlineToMd(el).trim()}`); return; }
      if (tag === 'pre') {
        out.push('```');
        out.push(String(el.textContent || '').replace(/\n+$/, ''));
        out.push('```');
        return;
      }
      if (tag === 'table') { const t = tableToMd(el); if (t) out.push(t); return; }
      if (tag === 'hr') { out.push('---'); return; }
      if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
        const text = inlineToMd(el).trim();
        // 空壳（contenteditable 常包一层无文字的 div）继续下钻，避免把内容吞掉
        if (text) out.push(text);
        else if (el.children.length) walk(el);
        return;
      }
      if (el.children.length) { walk(el); return; }
      const text = inlineToMd(el).trim();
      if (text) out.push(text);
    });
  };

  walk(root);
  return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
