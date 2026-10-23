'use strict';
/**
 * Markdown 渲染（笔记预览 / 摘要 / AI 片段展示统一入口）。
 *
 * 用成熟库 markdown-it（vendor/markdown-it/markdown-it.min.js，UMD 挂到 window.markdownit），
 * 而不是自己扩展项目里那个简易渲染器——表格、嵌套列表、转义、引用块这些语义由上游保证，
 * 手写实现会在边界用例上反复出 bug（这也是本项目一贯的取舍：优先引成熟库）。
 *
 * 安全：html:false 关闭原始 HTML 透传，链接统一加 target=_blank + rel=noopener，防 XSS / 反向 tabnabbing。
 */
import { renderMarkdown } from './markdown.js';

let mdIt = null;

function getRenderer() {
  if (mdIt) return mdIt;
  if (typeof window === 'undefined' || !window.markdownit) return null;
  mdIt = window.markdownit({
    html: false,      // 关键：不渲染原始 HTML，避免笔记内容注入脚本
    linkify: true,    // 裸 URL 自动成链接
    breaks: false,
    typographer: false,
  });
  const origin = mdIt.renderer.rules.link_open
    || ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  mdIt.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    tokens[idx].attrPush(['target', '_blank']);
    tokens[idx].attrPush(['rel', 'noopener']);
    return origin(tokens, idx, opts, env, self);
  };
  return mdIt;
}

/**
 * 渲染 Markdown → HTML（库缺失时回退到项目自带渲染器，保证界面不会白屏）。
 * @param {string} text
 */
export function renderSafeMarkdown(text) {
  const r = getRenderer();
  if (r) return r.render(String(text || ''));
  return renderMarkdown(text);
}

/** 纯文本预览（列表摘要用；取渲染结果的前 N 字） */
export function markdownToPlain(text, len = 120) {
  const html = renderSafeMarkdown(String(text || '').slice(0, len * 3));
  const div = document.createElement('div');
  div.innerHTML = html;
  const plain = (div.textContent || '').replace(/\s+/g, ' ').trim();
  return plain.length > len ? `${plain.slice(0, len)}…` : plain;
}
