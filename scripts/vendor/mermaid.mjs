'use strict';
/**
 * mermaid 打包入口（renderer/vendor/mermaid/mermaid.mjs）。
 *
 * 为什么单独打包成 ESM：mermaid 12 只发 ESM（还带一堆子依赖），而打包后的应用
 * 只带 renderer/**（不含 node_modules），构建期必须压成自包含文件；同时它体积不小
 * （约 2MB），大多数笔记用不到 —— 所以走**动态 import 懒加载**：
 * 只有正文里真出现 ```mermaid 代码块时才把它拉进来，不打开就不付解析成本。
 *
 * 安全：mermaid 默认 securityLevel:'strict'（DOMPurify 清洗 + htmlLabels 受限），
 * 配合渲染层的 html:false，笔记内容里的脚本进不到 DOM。
 */
export { default as mermaid } from 'mermaid';
export { default } from 'mermaid';
