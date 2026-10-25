'use strict';
/**
 * @alenaksu/json-viewer 打包入口（renderer/vendor/tools/json-viewer.mjs）。
 *
 * 该组件基于 Lit，包主入口是「副作用导入即注册 <json-viewer>」，没有导出；
 * 类本体在子路径 JsonViewer.js 上，这里一并导出，方便上层按需判断元素是否已注册。
 * 能力正好覆盖「JSON 查看器」要的三件事：树形展示、按类型着色、filter / expand / search 检索。
 * 外观靠 CSS 自定义属性与 ::part 调整（写在 renderer/css/styles.css），不改动组件本体。
 */
import '@alenaksu/json-viewer';
export { JsonViewer } from '@alenaksu/json-viewer/JsonViewer.js';
