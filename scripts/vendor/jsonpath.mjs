'use strict';
/**
 * jsonpath-plus 打包入口（renderer/vendor/tools/jsonpath.mjs）。
 * 只导出 JSONPath：给「JSON 查看器」做路径查询（$.a.b[0] / $..name 这类表达式）。
 */
export { JSONPath } from 'jsonpath-plus';
