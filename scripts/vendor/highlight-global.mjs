'use strict';
/**
 * highlight.js 打包入口（renderer/vendor/highlight/highlight.min.js）。
 *
 * 为什么是 IIFE + 全局变量，而不是像其它工具库那样打成 ESM 按需 import：
 * markdown-it 的 highlight 钩子是**同步**的，笔记正文渲染（预览 / 列表摘要 / AI 答案）
 * 一进来就要着色，等动态 import 回来再渲染会出现「先白后彩」的闪烁，
 * 而且每个用到渲染器的地方都得改成异步。所以走经典 <script> 引入，
 * 与 vendor/markdown-it 保持同一套加载方式。
 *
 * 语言集：core + 按需注册「笔记里常见」的语言，不引全量包（全量约 190 种，体积大一个数量级）。
 * 配色不在这里 —— 写在 renderer/css/styles.css 的 .hljs-* 规则里，跟着应用主题走。
 */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import less from 'highlight.js/lib/languages/less';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import scala from 'highlight.js/lib/languages/scala';
import dart from 'highlight.js/lib/languages/dart';
import lua from 'highlight.js/lib/languages/lua';
import perl from 'highlight.js/lib/languages/perl';
import r from 'highlight.js/lib/languages/r';
import powershell from 'highlight.js/lib/languages/powershell';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import graphql from 'highlight.js/lib/languages/graphql';
import nginx from 'highlight.js/lib/languages/nginx';
import makefile from 'highlight.js/lib/languages/makefile';
import plaintext from 'highlight.js/lib/languages/plaintext';

const LANGS = {
  javascript,
  typescript,
  json,
  xml,
  css,
  scss,
  less,
  markdown,
  yaml,
  sql,
  java,
  python,
  bash,
  shell,
  go,
  rust,
  c,
  cpp,
  csharp,
  php,
  ruby,
  kotlin,
  swift,
  scala,
  dart,
  lua,
  perl,
  r,
  powershell,
  dockerfile,
  diff,
  ini,
  properties,
  protobuf,
  graphql,
  nginx,
  makefile,
  plaintext,
};

Object.entries(LANGS).forEach(([name, def]) => hljs.registerLanguage(name, def));

/**
 * 代码块上常见但 highlight.js 没内置的写法 → 已注册语言（registerAliases 一次只能
 * 把一批别名绑到同一门语言，所以这里按「别名 → 目标语言」逐条注册）。
 * 拿不到匹配的语言时调用方会降级为「只转义、不着色」，不会报错。
 */
const ALIAS_MAP = {
  html: 'xml', vue: 'xml', svg: 'xml', jsx: 'javascript',
  yml: 'yaml',
  sh: 'bash', zsh: 'bash', console: 'shell',
  py: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  md: 'markdown', mdx: 'markdown',
  golang: 'go',
  rs: 'rust',
  'c++': 'cpp', cc: 'cpp', h: 'cpp', hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  kt: 'kotlin',
  ps1: 'powershell',
  docker: 'dockerfile',
  conf: 'ini', toml: 'ini',
  gql: 'graphql',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext',
};
Object.entries(ALIAS_MAP).forEach(([alias, target]) => {
  if (hljs.getLanguage(target)) hljs.registerAliases([alias], { languageName: target });
});

// 不确定语言时 hljs 会往控制台刷 deprecated 告警，这里统一关掉
hljs.configure({ ignoreUnescapedHTML: true, throwUnescapedHTML: false });

globalThis.hljs = hljs;
export default hljs;
