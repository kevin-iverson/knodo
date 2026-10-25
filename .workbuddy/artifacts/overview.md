# 实用工具：代码格式化 / 文本对比（交付说明）

## 做了什么

在顶部菜单「**实用工具**」下新增两个子菜单，都以**非模态浮窗**打开（无遮罩、不抢焦点，主界面照常可用）：

| 菜单项 | 快捷键 | 能力 |
| --- | --- | --- |
| 代码格式化 | `Ctrl/Cmd+Shift+F` | 12 种语言格式化：JSON / JS / TS / HTML / CSS / SCSS / Less / Markdown / YAML（Prettier）、XML（xml-formatter）、SQL（sql-formatter，9 种方言 + 关键字大小写）、Java（prettier-plugin-java） |
| 文本对比 | `Ctrl/Cmd+Shift+D` | 并排 / 内联双视图、行级增删与词级高亮、忽略空白 / 空行 / 大小写，可一键「格式化双方」后再比 |

浮窗支持最小化（收成标题条）、最大化（铺满窗口）、还原、右下角拖拽缩放、双击标题栏切换最大化；位置 / 尺寸 / 状态按 key 记在 localStorage，多个工具窗可同时开并错开摆放。语言与选项存 settings（`tool.formatter` / `tool.diff`），下次打开自动回填。

## 关键实现

- **第三方库**：prettier 3（standalone + 插件）、prettier-plugin-java、sql-formatter、xml-formatter、diff。
  用 esbuild 打成 ESM 落在 `renderer/vendor/tools/{format-core,format-java,diff}.mjs`（`npm run build:tools`），
  渲染层动态 `import()` 懒加载 —— 打包产物里不含 node_modules，vendor 必须随仓库提交。Java 插件单独成包（433KB），只在选 Java 时才拉。
- **新文件**：`renderer/js/tool-window.js`（浮窗组件）、`renderer/js/code-format.js`、`renderer/js/text-diff.js`、
  `scripts/build-tools.js`、`scripts/vendor/*.mjs`（打包入口）。
- **接线**：`main/main.js` 菜单项 → `ui:code-format` / `ui:text-diff` → `renderer/js/ui.js` 注册；
  `preload` 白名单 + `main/ipc.js` 的 `ui:getToolPref` / `ui:setToolPref`（键白名单）；样式追加在 `renderer/css/styles.css`。
- **z-index**：浮窗 210~248，刻意低于 `.modal-mask`(300)，模态弹窗仍然盖在它上面；Toast 更高。

## 两个踩过的坑（已修）

1. `formatText` 里 `let out = src` 让 `if (out == null)` 永远不成立 —— **除 JSON/XML/SQL 外所有 Prettier 语言静默原样返回**，
   界面还显示「已格式化」。改为 `let out = null`（`null` 才是「交给 Prettier」的信号），并在冒烟里补了 JS/TS/HTML/CSS/SCSS/Markdown/YAML 的逐个守门。
2. JSON 走 `JSON.stringify(JSON.parse(...))` 而不是 Prettier：Prettier 的「对象换不换行」取决于原文第一个换行在哪，
   同一份数据的两种排版格式化后仍然不同，文本对比就比不出真正改动（收敛前 1 处差异 → 收敛后 0 处）。解析失败才退回 Prettier（兼容 JSON5/JSONC）。

## 验证

`npm run smoke`（main.js 内 `--smoke-test`，第 18 轮为本次新增）**全部通过，输出 `SMOKE_OK`**：

```
实用工具·格式化 = 开窗=是（无遮罩=是）JSON=✓ XML=✓ SQL=✓ Java=✓ 自动识别=✓；其它语言全通过=✓；语法错误提示=有
实用工具·浮窗 = 最小化=✓ 还原=✓；最大化=✓ 还原=✓；开着仍能操作主界面=是；两窗共存=是
实用工具·对比 = 行 3（增 1 / 删 1）；内联=4 行 / 2 个符号；忽略大小写生效=是；格式化后收敛=是（前 1 → 后 0）；关闭=✓
```

另用 CDP 驱动真实界面做过定向复核（Java 输出 6 行缩进正确；8 种语言结果均非原文）。

## 已知限制

- Java 依赖 `prettier-plugin-java@2.6.6`（锁死）：2.11+ 依赖 `web-tree-sitter`（WASM），浏览器端初始化不了。
- 文本超过 4000 行时截断渲染（差异计算仍完整），词级高亮上限同为 4000 行。
- 菜单快捷键只在应用窗口有焦点时生效（原生加速键的正常行为）。
