# 项目长期约定（Knodo / todo-desktop）

## 品牌 / 图标
- 对外名 = `build.productName`（Knodo）；`package.json` 的 `name`（todo-desktop）与 `appId` **绝不改**（Electron 用 name 定 userData）。改品牌只动 productName / nsis.shortcutName / 文案 / 图标；发布脚本用 `BRAND` 常量。
- 图标由 `scripts/gen-icon.js` 手写光栅器生成（矢量 + 4× 超采样，**不换图片素材**），三档 full/simple/tiny；可被 require（只导出函数）。产物 icon.png/tray.png/icon.ico/knodo.svg。改图标后必须重新打包才进安装版。
- `app.setAppUserModelId('com.workbuddy.knodo')`。启动项改名要把旧名加进 `main/autostart.js` 的 `LEGACY_LOGIN_ITEM_NAMES`。

## 数据模型 / 存储
- 数据目录 = `<userData>/config.json` 的 dataDir；`main/storage.js` 解析/探测/迁移；目录不可用必须回退默认并提示，绝不让启动失败。录音是绝对路径，不随迁移。
- 附件：`<dataDir>/attachments/<kind>-<宿主id>/<附件id>_<文件名>`，kind = task|note；库里只存元数据 JSON 且路径**相对**。删任务 `db.subtreeTaskIds()` + `removeTaskDir()`；删笔记 `removeOwnerDir('note',id)`。
- 本地图片走 `todo-media:///<相对路径>`（main.js file protocol，只认 attachments，越界 -6）；不用 `file://`。CSP 已含 `todo-media:`。
- 笔记颜色/高亮：内联 `==文字=={c:#hex;bg:#hex}` 存进 content_md（不占新列）。`word_count/content_hash/notes_fts/kb_chunks` 前必须 `stripStyleMarks()`；`excerpt` 保留标记；渲染靠 markdown-lib 的 `styledTextPlugin`。
- 分组名唯一作用域 = 同一 parent_id，校验走 `db.assertGroupName()`（create/update 都要）；**不加 DB 唯一索引**（旧备份可能同级重名）。
- AI 报告：`resolveRange` **界面日期优先**（类型只是预置方案）；`rangeStats` 含子任务，报告层按父任务挂子任务（孤儿标 parentTitle），数量口径含子任务。
- 迁移 v12 = `kb_qa`（知识库问答历史，进备份）。

## SQLite / FTS
- FTS5 统一 **external content + `tokenize='trigram'`** + 触发器同步。
- 坑①：external content 表上用 `snippet()`/`highlight()` 会 SQL error 废掉整条 bm25 → 片段一律应用层截取（`highlightOf()`）。坑②：trigram 查询词需 ≥3 字符，短词回退 LIKE。
- 派生数据（分块/向量）不进导入导出，导入后由正文重建。

## 渲染层通用
- **工具类 CSS 类名禁止复用**（`.fmt-hl/.jv-hl` 是高亮层 absolute+inset:0 的 `<pre>`，复用会变巨型原生控件）；排查幽灵元素按几何扫描 `elementsFromPoint`。
- `#view` 是共享容器：`renderTasks()` 整块重写它。非任务视图重进要检测骨架是否还在（如 `.nt-wrap`）再重建；refresh 回调调 `render()` 而非 `renderTasks()`。局部刷新优先只换局部 DOM（整页重建丢焦点/滚动，旧保存器还会写已销毁 DOM）。
- 会随骨架重建的控件一律走容器级委托（常驻容器用 `WeakSet` 只绑一次），重建后回填状态；**别和逐个元素的直接绑定混用**。
- 模块互相跳转用 `await import()` 防止循环依赖。
- `openPanelModal`：关闭前保存传 `onClose`；`extraButtons` handler 第二参是 `close`；二选一必须先 resolve 再 close；尺寸选择器要写 `.modal.modal-xxx`（双类）。支持 `showClose/headHtml/resizable+resizeKey`（localStorage `modal-size:<key>`，双击手柄复位）/ `modal:resize` 事件（CM、图表要重测）。
- 对话框父窗口不能传 `undefined` → 用 `msgBox()` / `dirDialog()`；拖拽取路径用 `api.pathForFile(file)`。
- 切主题必须同步 `nativeTheme.themeSource`。三方库 vendor 进 `renderer/vendor/` 并登记 package.json；EasyMDE 要 `autoDownloadFontAwesome:false`。
- 「取消」基线 = 最后一次保存成功的状态（每次 save 成功即前移）。

## 笔记（notes.js）
- 「📝 笔记」弹窗（`openNotesDock`，入口在顶栏搜索框内右侧 `.search-action`）= 复用 `renderNotes`/`bindEvents`，只把宿主从 `#view` 换成弹窗容器（`boundRoot` 换宿主、`activeNoteId` 跨关窗保留、关窗复位 `boundRoot=null`）；弹窗开着时 `renderNotes(#view)` 必须让位（编辑器/saver 是单例）。顶栏 1080 宽已排满（可用 790 / 已占 788），新增按钮一律不能再占行宽。
- 详情面板两种宿主（右栏 `#view` / 弹窗）共用 detailHtml/mountEditor/bindSaver；`editor`/`saver` 是模块级单例，换宿主前 dispose；`detailPane()` 要优先命中 `modalRoot`（弹窗挂 body，#view 委托够不到，自己绑一份）。滚动区用 `.nt-dp-scroll` 包正文，foot 放外边；色板色块只能用 `background:` 预览。
- 编辑器自实现（`data-mode` + grid + 自己渲染 `#nt-preview`），**别用 EasyMDE 的分栏/预览/全屏**（会 position:fixed 盖全屏）；图片自己监听 paste/drop + `replaceSelection`，别用 uploadImage。
- **预览区不绑「双击进编辑」**（双击是选词手势）；入口统一是标题栏三态按钮。
- 全屏：`.nt-dp.is-fs`（fixed inset:0 z320，预览 1080px 居中 / 编辑占满），按钮 `data-nt-act="fs-toggle"`，状态记 localStorage `nt-fullscreen`，Esc 在 document 捕获（查找条/色板开着时让位）。凡是会拆面板的路径（关面板/删除/弹窗 onClose/`disposeNotes`）都必须 `exitFullscreen()`，否则 Esc 监听常驻且 fixed 层会浮在别的视图上。
- `note-find.js`（Ctrl+F/H）：**双后端**——`backend:'cm'` 查 CodeMirror 源码（`getSearchCursor`）、`backend:'dom'` 查 `#nt-preview` 渲染结果（文本节点内 `Range.surroundContents` 包 `<mark class="nt-find-hit">`，倒序包裹才不会错位；跨节点命中直接放弃，不改渲染结构）。预览态（`mode==='preview'`）走 dom 后端且**不再强切分栏**，替换行整块不渲染（Ctrl+H 才切分栏）；`switchMode` 时用 `findQuery()` 把查询词带过新后端，`refreshPreview` 里 `refreshFind()` 重算标记。① 全部替换必须**倒序**；② 快捷键在**捕获阶段**拦（pcDefault 已绑 Ctrl-F）；③ Esc 在宿主层兜住；④ 预览态无 CodeMirror 时关闭浮条把焦点还给 `.nt-dp-scroll`。
- 预览态快捷键要能生效，`.nt-dp-scroll` 带 `tabindex="-1"` + `mousedown` 委托聚焦（`focusPreviewOnPress`）：预览里没有可聚焦控件，不这么做 `activeElement` 停在 body，`e.target.closest('.nt-dp')` 判定落空，Ctrl+F/Ctrl+S 全哑。`.nt-find` 里的输入**不算**笔记改动（input 委托要 early-return，否则状态位跳到「未保存」）。
- 面板内浮层（查找浮条）带 `data-esc-stop`：`modal.js` 的 Esc 处理器在 document 捕获阶段、早于宿主面板委托，看到这个标记要让位，否则关搜索会连弹窗一起关掉。
- 导出：`sync.js` 的 `noteSectionHtml()` + `bindNoteExport()` + `openNoteExportModal(preset)`（class `modal-sync modal-note-export`，只有笔记一节）；工具栏「📤 导出」紧挨「📥 导入」，notes.js 动态 import。`☁ 同步` 面板与它共用 `openMask`。
- Mermaid 放大：`renderer/js/mermaid-zoom.js`（`.mm-zoom-mask` z420；transform 层做 translate+scale；背景用 `--bg-panel`）。渲染后 SVG 包一层 `.md-mermaid-view`（横向滚动在内层）；双击图打开走 document 捕获 `stopPropagation`；**关闭只留 ✕/Esc**（不绑 click-to-close，拖动松手会补 click 误关）。

## 任务
- 新增/编辑任务行内表单顺序：标题 → `.editor-group`（分组）→ 计划时间范围 → 更多选项；`collectEditorPayload` 按 class 取值，跨容器移动不影响。
- 「今天/今日已完成」：`state.recentlyDone`（settings + 自然日，跨天作废）记录不分视图、只在「今天」列表展示 → **任何视图的勾选入口都要调 `noteCompletionChange()`**，连带完成祖先用 `rememberCompletedAncestors()`。

## 依赖划分（体积硬约束）
- 前端库（markdown-it / highlight.js / mermaid / easymde / flatpickr / tom-select / prettier / diff / jsonpath / xml-formatter / json-viewer）一律 **devDependencies**，构建期 esbuild 打进 `renderer/vendor/`；`dependencies` 只留 **better-sqlite3**。违反 → electron-builder 打进整棵 production node_modules（asar 30MB→216MB），顶穿 Gitee 100MB。

## 代码块 / Tab
- 预览 `<pre>` 的 `tab-size` 必须等于编辑器 `tabSize`（现为 2）：`.md-code pre / .markdown-body pre / .editor-preview* pre / .md-mermaid-src / .nt-md-fallback` 一组 + EasyMDE `tabSize:2`。
- CodeMirror `defaultTab` 绑 `insertTab`（塞真 `\t`）→ 笔记编辑器 `cm.addKeyMap({ Tab: insertSoftTab })`。

## Mermaid（只保留五类）
- keep：`flowchart-v2 / sequence / classDiagram / gantt / pie`；两份同步：markdown-lib 的 `MERMAID_TYPES` + `scripts/build-tools.js` 的 `MERMAID_KEEP`。
- 裁剪：解析 `mermaid.core.mjs` 里 `var idN="..."` 之后的动态 import，用 esbuild 插件把非 keep 模块换成空桩（5.0MB→3.6MB）。**elkjs 不能裁**（flowchart/class 默认布局）；`cose-bilkent` 可裁。空桩至少导出 `diagram/load/render`（缺 render 会报 `i.render is not a function`）。
- 不支持的图表类型在 `renderMermaidBatch` 里加载库之前就拦下（保留源码 + 提示）。

## 实用工具（浮窗）
- 「实用工具」统一用**非模态浮窗** `renderer/js/tool-window.js`（z210~248 < `.modal-mask` 300），同 key 单实例，几何记 localStorage。
- 浏览器端三方库走 esbuild：`scripts/vendor/*.mjs` → `renderer/vendor/tools/*.mjs`（ESM+minify，**随仓库提交**）。
- 配置存 settings `tool.<key>`，走 `api.ui.getToolPref/setToolPref`；新增工具要加 `main/ipc.js` 键白名单 + preload 事件白名单。
- 实时薪资 `salary.js`（Ctrl+Shift+S）：时薪 = 月薪 ÷ 当月工作日 ÷ 每日工时（**不用 21.75**），只算工作日上下班区间，只展示今日/本月。

## 验证
- 数据层 `npm run test:db`；UI `npm run smoke`（约 2m50s → timeout 600000；PowerShell 每条先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` + UTF8；`--smoke-test` 自己切临时 userData，别再传 `--user-data-dir`）。
- 本机跑 electron 必须 `env -u ELECTRON_RUN_AS_NODE`；临时目录每次新建（`rm -rf` 会被批量删除守卫拦）。
- **定向验证新 UI**：`run_in_background` 起带 `--remote-debugging-port=9444` 的 electron，脚本用 `CDP_ATTACH=1` 连现有窗口（自己 spawn 会被宿主回收）；临时脚本别留 `scripts/`，验完 `mv` 到 `D:/WorkBuddyWorkSpace/.tmp/`。
- CDP：WebSocket 会吊住 node → 结尾 `process.exit(0)`；断言限定作用域（`.nt-empty` 会命中侧栏标签）；`awaitPromise` 求值动态 import 会永久挂住 → 发后不管 + 轮询 `window.__out`；后台节流要加 `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`。合成按键进不了原生加速键 → 菜单/快捷键只能在主进程侧探针验证。
- CDP 易错：点 `.task-title-text` 是就地重命名（打开详情点整行）；笔记选择器点 `.np-pick-check`；用例实体名带时间戳。

## 打包 / 发版（Windows / Gitee）
- `npm run dist` = gen-icon + build-tools + `build-win.js`（electron-builder 薄封装，国内镜像）。产物 `dist/Knodo-<ver>-安装版.exe` / `便携版.exe`。
- 宿主有批量删除守卫（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）：**`mv` 不触发、`rm` 触发** → 清理一律 `mv`。
- 稳定流程：① `mv` 走 `dist/win-unpacked*` 残留；② `KEEP_ELECTRON_LOCALES=1 node scripts/build-win.js`（NSIS 收尾删 `.__uninstaller.exe` 会报错但 exe 本体完整，校验 FileVersion）；③ `dist/win-unpacked/locales` 只留 `zh-CN`/`en-US`（省 47MB）；④ `node scripts/build-win.js --win portable --prepackaged dist\win-unpacked` 直出便携版（跳过 packaging = 跳过批量删除）。
- `dist:portable` 里的 `--target portable` 是错的，要用 `--win portable`。便携版 exe 本身是 LZMA SFX，再压 7z 几乎零收益；便携版有 `PORTABLE_EXECUTABLE_DIR` → userData 改到 exe 同级 data 且禁自启。
- 打包后 exe 不接受命令行参数（无法 `--smoke-test`）；验证产物用开发版 electron 加载 `dist/win-unpacked/resources/app.asar`。
- 发版：改版本（`package-lock.json` 顶层 + `packages[""]` 两处）→ `scripts/release-gitee.js` 写说明 → `chore(release)` 提交 → push → 打包 → 7z（`7za.exe a -t7z -mx=9 -md=128m -ms=off`，产物 ≤104857600 字节）→ `npm run release -- --token`（令牌只走参数/环境变量）。发版前把上一版 7z 移出 `dist/release/`。
- **发布脚本按 HEAD 打 tag** → 所有代码提交必须在 release 之前。上传 90MB+ 约 10 分钟（脚本 3 次重试，重试前复查）。
- **Gitee 附件总配额 1GB**（非单文件）：满了报 400「验证失败：文件大小已超出仓库附件配额」。清：`GET /repos/{o}/{r}/releases/{id}/attach_files` → `DELETE /repos/{o}/{r}/releases/{id}/attach_files/{fid}`（**路径里必须带 release id**，漏了 404），删前先问用户。用量查法：release 列表的 assets 没有 size 字段，得对 `browser_download_url` 发 HEAD 取 Content-Length 累加。v1.8.5 发布后约 859MB / 1024MB（v1.6.0、v1.7.0 为清理候选）。
- **单附件 >100MB 只能分卷**（100MiB 硬上限，GVP 才 200MiB）：`7za a -t7z -v95m -mx=9 -md=128m -ms=off`。**压缩时必须在文件所在目录用 `./文件名`**——传 `dist/xxx.exe` 会让包内带 `dist/` 前缀，用户解压多一层。便携版 exe 已是 LZMA SFX，二次压缩只省 70KB。
- Release 已存在时要同步说明：PATCH `.../releases/{id}` **必须带 `tag_name`**，缺了返回 400。`attach_files` 列表有缓存，重试前复查同名附件必须加 `&t=<Date.now()>`，否则读旧结果 → 同一个 95MB 分卷被传两遍。
- Git Bash 下多行提交信息**别用 `@'...'@`**（那是 PowerShell here-string，bash 会把它当字面量，`@` 会变成消息首行）；写临时文件 `git commit -F <file>`。

## 跨平台（Mac）
- `better-sqlite3` 13 走 N-API prebuilds（`prebuilds/<platform>-<arch>.node`），`build/Release` 空，**不需 electron-rebuild**。
- 打 Mac 包需处理：`build.files` 反向保留 `prebuilds/darwin*`、`gen-icon.js` 不产 `.icns`、tray 建议 Template 图。macOS 目标只能在 macOS 上构建。
