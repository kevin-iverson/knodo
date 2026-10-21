'use strict';
/**
 * 轻量安全的 Markdown 渲染器（无第三方依赖）。
 * 支持：标题、粗体、斜体、删除线、行内代码、代码块、无序/有序列表、引用、
 * 分隔线、链接、图片。输出已做 HTML 转义与 URL 白名单，防 XSS。
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** URL 白名单：仅允许 data:image 与 http(s)，其余拦截为 # */
function safeUrl(url) {
  if (/^data:image\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return '#';
}

function inline(text) {
  let s = escapeHtml(text);
  // 行内代码 `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 图片 ![alt](url)
  // md-image：图片双击放大预览的挂载点（见 image-zoom.js）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => `<img class="md-image" src="${safeUrl(url)}" alt="${alt}" loading="lazy">`);
  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${txt}</a>`);
  // 粗体 ** ** / __ __
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // 删除线 ~~ ~~
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // 斜体 * *
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

function renderMarkdown(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let inCode = false;
  let codeBuf = [];
  let listBuf = []; // { type: 'ul'|'ol', text }
  let para = [];

  const flushPara = () => {
    if (para.length) {
      html += `<p>${inline(para.join('\n'))}</p>`;
      para = [];
    }
  };
  const flushList = () => {
    if (listBuf.length) {
      const type = listBuf[0].type;
      html += `<${type}>${listBuf.map((b) => `<li>${inline(b.text)}</li>`).join('')}</${type}>`;
      listBuf = [];
    }
  };

  for (const line of lines) {
    // 代码块
    if (/^```/.test(line)) {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
        codeBuf = [];
        inCode = false;
      } else {
        flushPara(); flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // 空行
    if (!line.trim()) { flushPara(); flushList(); continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); const lvl = h[1].length; html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); html += '<hr>'; continue; }

    // 引用
    if (/^>\s?/.test(line)) { flushPara(); flushList(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }

    // 无序列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!listBuf.length || listBuf[0].type !== 'ul') { flushList(); listBuf = [{ type: 'ul', text: ul[1] }]; }
      else listBuf.push({ type: 'ul', text: ul[1] });
      continue;
    }
    // 有序列表
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!listBuf.length || listBuf[0].type !== 'ol') { flushList(); listBuf = [{ type: 'ol', text: ol[1] }]; }
      else listBuf.push({ type: 'ol', text: ol[1] });
      continue;
    }

    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  if (inCode) html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
  return html;
}

export { renderMarkdown };
