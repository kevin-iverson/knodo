'use strict';
/**
 * jsdiff 打包入口（renderer/vendor/tools/diff.mjs）。
 * 只导出文本对比真正用到的三个算法：
 *  - diffLines：按行对比（主体视图用它算差异块）
 *  - diffWordsWithSpace：词级对比（同一行内高亮到底改了哪几个词）
 *  - diffTrimmedLines：忽略首尾空白的按行对比（备用）
 */
export { diffLines, diffWordsWithSpace, diffTrimmedLines } from 'diff';
