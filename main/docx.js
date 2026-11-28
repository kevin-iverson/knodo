'use strict';
/**
 * Markdown → Word（.docx）导出，零第三方依赖。
 *
 * 实现思路：
 *  - docx 本质是一个 ZIP 包（OOXML），打包用 main/zip.js 里的极简 ZIP 写入器（deflate + CRC32）；
 *  - Markdown 只覆盖报告用到的语法：标题、无序 / 有序列表、任务清单（- [x]）、引用、
 *    代码块、分隔线，以及行内 粗体 / 斜体 / 删除线 / 行内代码；
 *  - 中文字体统一指定微软雅黑，避免 Word 里出现方块或回退成等宽字体。
 */
const { zip } = require('./zip');

/* ------------------------------ Markdown 解析 ------------------------------ */

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 行内语法切分：粗体 **x** / __x__、斜体 *x* / _x_、行内代码 `x`、删除线 ~~x~~。
 * @returns {Array<{text:string, b?:boolean, i?:boolean, code?:boolean, strike?:boolean}>}
 */
function parseInline(text) {
  const segs = [];
  const re = /(\*\*|__)([\s\S]+?)\1|(\*|_)([\s\S]+?)\3|`([^`]+)`|~~([\s\S]+?)~~/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    if (m[2] != null) segs.push({ text: m[2], b: true });
    else if (m[4] != null) segs.push({ text: m[4], i: true });
    else if (m[5] != null) segs.push({ text: m[5], code: true });
    else if (m[6] != null) segs.push({ text: m[6], strike: true });
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs.length ? segs : [{ text: '' }];
}

function runsXml(text, extraPr = '') {
  return parseInline(text)
    .map((seg) => {
      if (!seg.text) return '';
      let pr = '';
      if (seg.b) pr += '<w:b/>';
      if (seg.i) pr += '<w:i/>';
      if (seg.strike) pr += '<w:strike/>';
      if (seg.code) pr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/>';
      pr += extraPr;
      const rPr = pr ? `<w:rPr>${pr}</w:rPr>` : '';
      return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(seg.text)}</w:t></w:r>`;
    })
    .join('');
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function imageRelId(i) { return `rId${4 + Number(i)}`; }

function dataUrlToPng(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 24 || buf.subarray(1, 4).toString() !== 'PNG') return null;
  return buf;
}

function pngSize(buf) {
  return { w: Math.max(1, buf.readUInt32BE(16)), h: Math.max(1, buf.readUInt32BE(20)) };
}

function codeXml(block) {
  const text = block.text || '';
  return `<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>${
    text.split('\n').map((l, i) => (i ? '<w:r><w:br/><w:t xml:space="preserve"></w:t></w:r>' : '') +
      `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">${escapeXml(l)}</w:t></w:r>`).join('')
  }</w:p>`;
}

/** 图片块 → OOXML 内嵌 PNG；没有对应图片数据时由调用方回退成代码块 */
function imageXml(block, imageIndex, imageBuffers) {
  const buf = imageBuffers && imageBuffers[imageIndex];
  if (!buf) return '';
  const { w, h } = pngSize(buf);
  const MAX_W = 5303520; // 5.8 inch，小于 A4 正文宽度
  const MAX_H = 4114800; // 4.5 inch
  let cx = MAX_W;
  let cy = Math.round(MAX_W * h / w);
  if (cy > MAX_H) { cy = MAX_H; cx = Math.round(MAX_H * w / h); }
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>`
    + `<wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${imageIndex + 1}" name="图表${imageIndex + 1}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="chart${imageIndex + 1}.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${imageRelId(imageIndex)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/**
 * Markdown 文本 → 块级结构数组。
 * 块类型：h1 / h2 / h3 / p / li / quote / code / hr / table
 */
function parseBlocks(md, opts = {}) {
  const lines = String(md == null ? '' : md).split(/\r?\n/);
  const blocks = [];
  let inCode = false;
  let codeBuf = [];
  let codeLang = '';
  let imageIndex = 0;
  const hasImages = Array.isArray(opts.images) && opts.images.length > 0;
  let tbl = null; // 正在收集的表格行（原始文本行）

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    const fence = line.match(/^\s*```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeBuf = [];
        codeLang = (fence[1] || '').toLowerCase();
      } else {
        inCode = false;
        const text = codeBuf.join('\n');
        if (codeLang === 'mermaid' && hasImages) {
          blocks.push({ type: 'image', imageIndex: imageIndex++, text });
        } else {
          blocks.push({ type: 'code', text });
        }
        codeBuf = [];
        codeLang = '';
      }
      tbl = null;
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    // 表格：连续的 |..| 行收成一个 table 块；| --- | 是分隔行，不产出数据
    if (TABLE_ROW.test(line)) {
      if (!tbl) { tbl = { type: 'table', rows: [] }; blocks.push(tbl); }
      if (!TABLE_SEP.test(line)) tbl.rows.push(splitRow(line));
      continue;
    }
    tbl = null;

    if (!line.trim()) continue;

    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = Math.min(h[1].length, 3);
      blocks.push({ type: `h${lv}`, text: h[2].trim() });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'hr' }); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { blocks.push({ type: 'li', text: ul[1] }); continue; }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { blocks.push({ type: 'li', text: ol[1] }); continue; }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { blocks.push({ type: 'quote', text: q[1] }); continue; }

    blocks.push({ type: 'p', text: line.trim() });
  }
  if (inCode && codeBuf.length) {
    const text = codeBuf.join('\n');
    if (codeLang === 'mermaid' && hasImages) blocks.push({ type: 'image', imageIndex: imageIndex++, text });
    else blocks.push({ type: 'code', text });
  }
  // 只有分隔行、没有数据行的"伪表格"直接丢掉
  return blocks.filter((b) => b.type !== 'table' || (b.rows && b.rows.length));
}

/** 任务清单符号：- [x] → ☑，- [ ] → ☐ */
const TASK_PREFIX = /^\[( |x|X)\]\s*/;

/** 表格块 → 真正的 w:tbl（此前被压成 ｜ 分隔的段落，导出后不再是表格） */
const TABLE_WIDTH = 9000;
const CELL_BORDERS = ['top', 'left', 'bottom', 'right']
  .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
  .join('');

function tableXml(block) {
  const rows = block.rows || [];
  if (!rows.length) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const colW = Math.floor(TABLE_WIDTH / colCount);
  const trs = rows
    .map((cells, ri) => {
      const isHead = ri === 0;
      const tcs = [];
      for (let i = 0; i < colCount; i++) {
        const text = String(cells[i] == null ? '' : cells[i]);
        const shd = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF2FB"/>' : '';
        tcs.push(
          `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${shd}<w:tcBorders>${CELL_BORDERS}</w:tcBorders></w:tcPr>`
          + `<w:p>${runsXml(text, isHead ? '<w:b/>' : '')}</w:p></w:tc>`,
        );
      }
      // 表头重复出现在每页顶部，长表格跨页时仍能看清列名
      const trPr = isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${trPr}${tcs.join('')}</w:tr>`;
    })
    .join('');
  return `<w:tbl>`
    + `<w:tblPr><w:tblW w:w="${TABLE_WIDTH}" w:type="dxa"/>`
    + `<w:tblBorders>${CELL_BORDERS}</w:tblBorders></w:tblPr>`
    + `${trs}</w:tbl>`
    // 表格后必须跟一个段落：OOXML 不允许表格作为 body 的最后一个元素
    + '<w:p/>';
}

function blockXml(block, imageBuffers = []) {
  if (block.type === 'table') return tableXml(block);
  if (block.type === 'hr') {
    return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>';
  }
  if (block.type === 'code') return codeXml(block);
  if (block.type === 'image') {
    // 图片数据缺失时退回源码，不能让图表凭空消失
    return imageXml(block, block.imageIndex, imageBuffers) || codeXml(block);
  }

  let text = block.text || '';
  let prefix = '';
  if (block.type === 'li') {
    const m = text.match(TASK_PREFIX);
    if (m) {
      prefix = /x|X/.test(m[1]) ? '☑ ' : '☐ ';
      text = text.replace(TASK_PREFIX, '');
    } else {
      prefix = '• ';
    }
  }

  const pPr = (() => {
    if (block.type === 'h1') return '<w:pStyle w:val="Heading1"/>';
    if (block.type === 'h2') return '<w:pStyle w:val="Heading2"/>';
    if (block.type === 'h3') return '<w:pStyle w:val="Heading3"/>';
    if (block.type === 'li') return '<w:pStyle w:val="ListParagraph"/>';
    if (block.type === 'quote') return '<w:pStyle w:val="Quote"/>';
    return '';
  })();

  const content = runsXml(prefix + text, block.type === 'quote' ? '<w:color w:val="666666"/>' : '');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
}

/* ------------------------------ OOXML 组装 ------------------------------ */

const FONT = 'Microsoft YaHei';

function contentTypesXml(hasImages = false) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${hasImages ? '<Default Extension="png" ContentType="image/png"/>' : ''}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function documentRelsXml(imageBuffers = []) {
  const imagesXml = imageBuffers.map((buf, i) => (buf
    ? `<Relationship Id="${imageRelId(i)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`
    : '')).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${imagesXml}
</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1F3864"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="2E5496"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="360"/><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="360"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:i/><w:color w:val="666666"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="360"/><w:spacing w:after="120"/><w:shd w:val="clear" w:fill="F4F5F7"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>
</w:styles>`;
}

function documentXml(markdown, opts = {}) {
  const imageBuffers = opts.imageBuffers
    || (Array.isArray(opts.images) ? opts.images.map(dataUrlToPng) : []);
  const body = parseBlocks(markdown, opts).map((b) => blockXml(b, imageBuffers)).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${body || '<w:p><w:r><w:t xml:space="preserve">（空文档）</w:t></w:r></w:p>'}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`;
}

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>Knodo</dc:creator>
<cp:lastModifiedBy>Knodo</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>TODO Desktop</Application>
</Properties>`;
}

/**
 * 把 Markdown 转成 .docx 文件的二进制内容。
 * @param {string} markdown
 * @param {{title?:string}} [opts]
 * @returns {Buffer}
 */
function markdownToDocx(markdown, opts = {}) {
  const title = opts.title || '报告';
  const imageData = Array.isArray(opts.images) ? opts.images : [];
  const imageBuffers = imageData.map(dataUrlToPng);
  const mediaEntries = [];
  imageBuffers.forEach((buf, i) => {
    if (buf) mediaEntries.push({ name: `word/media/image${i + 1}.png`, data: buf, store: true });
  });
  return zip([
    { name: '[Content_Types].xml', data: contentTypesXml(mediaEntries.length > 0) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'word/document.xml', data: documentXml(markdown, { images: imageData, imageBuffers }) },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/_rels/document.xml.rels', data: documentRelsXml(imageBuffers) },
    { name: 'docProps/core.xml', data: coreXml(title) },
    { name: 'docProps/app.xml', data: appXml() },
    ...mediaEntries,
  ]);
}

// documentXml 一并导出：冒烟测试需要直接断言表格/标题的 OOXML，而不必解 zip
module.exports = { markdownToDocx, parseBlocks, documentXml, zip };
