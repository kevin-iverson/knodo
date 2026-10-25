'use strict';
/**
 * 第三方格式化库打包入口（由 esbuild 打进 renderer/vendor/tools/format-core.mjs）。
 *
 * 只做「薄适配层」：把各库的调用统一成几个纯函数，语言映射 / 参数校验都放在渲染层
 * （renderer/js/code-format.js），这样 vendor 产物可以独立升级、不必跟着改业务代码。
 */
import * as prettier from 'prettier/standalone';
import babel from 'prettier/plugins/babel';
import estree from 'prettier/plugins/estree';
import typescript from 'prettier/plugins/typescript';
import postcss from 'prettier/plugins/postcss';
import html from 'prettier/plugins/html';
import markdown from 'prettier/plugins/markdown';
import yaml from 'prettier/plugins/yaml';
import { format as sqlFormat } from 'sql-formatter';
import xmlFormatter from 'xml-formatter';

/** 默认插件集（Java 插件体积大，单独一个 bundle 按需加载） */
export const PLUGINS = [babel, estree, typescript, postcss, html, markdown, yaml];

export const prettierVersion = prettier.version;

/** @param {{plugins?:Array, parser:string, [k:string]:any}} options */
export function prettierFormat(code, options = {}) {
  const { plugins, ...rest } = options || {};
  return prettier.format(code, { ...rest, plugins: plugins && plugins.length ? plugins : PLUGINS });
}

export { sqlFormat };

export function xmlFormat(code, options = {}) {
  return xmlFormatter(code, options);
}
