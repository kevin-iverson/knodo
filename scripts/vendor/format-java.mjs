'use strict';
/**
 * Java 格式化插件（prettier-plugin-java，底层是 chevrotain 解析器，体积明显大于其他语言，
 * 因此单独打成一个 bundle，只有选了 Java 时才动态 import）。
 */
import plugin from 'prettier-plugin-java';

export const javaPlugin = plugin && plugin.default ? plugin.default : plugin;
