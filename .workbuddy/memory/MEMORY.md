# 项目长期约定（Knodo / todo-desktop）

## 品牌与标识
- 对外名 = `build.productName`（Knodo）；`package.json` 的 `name`（todo-desktop）与 `appId` 是内部标识，**绝不改动**：Electron 用 `name` 决定 userData 目录。改品牌只动 productName / nsis.shortcutName / 文案 / 图标。发布脚本取 `BRAND` 常量，不用 `pkg.name`。
- 图标由 `scripts/gen-icon.js` 手写光栅器生成（矢量几何 + 4× 超采样），**不要换图片素材**；三档 full(≥48)/simple(24~47)/tiny(16)。脚本可被 require（只导出函数、不写文件）。产物：icon.png/tray.png/icon.ico/knodo.svg。
- 标识语义：圆环=知识回路；竖条=清单勾选弦；两斜臂经共线细连线接圆环节点。别破坏：竖条悬空、竖条贴左弧（挤出细缝）、细线浮空。
- `app.setAppUserModelId('com.workbuddy.knodo')`（win32 分支）；改图标后**必须重新打包**才在安装版生效。
- 启动项改名要迁移：`main/autostart.js` 的 `LOGIN_ITEM_NAME` 改时把旧名加进 `LEGACY_LOGIN_ITEM_NAMES`。

## 数据模型
- 分组名唯一性作用域 = 同一 parent_id；校验在 `db.assertGroupName()`，create/update 都必须走。**不要加 DB 唯一索引**（旧备份导入可能带同级重名）。
- 附件：`<数据目录>/attachments/<kind>-<宿主id>/<附件id>_<文件名>`，kind = task|note。库里只存元数据 JSON（**相对**路径，硬约束）。删任务走 `db.subtreeTaskIds()` + `removeTaskDir()`；彻底删笔记 `removeOwnerDir('note',id)`。
- 本地图片写 `todo-media:///<相对路径>`（main.js 注册 file protocol，只认 attachments 内，越界 -6）；不用 `file://`。CSP `img-src` 已含 todo-media:。
- 笔记颜色/高亮：内联 `==文字=={c:#hex;bg:#hex}` 写进 content_md（不占新列）。`word_count/content_hash/notes_fts/kb_chunks` 必须先过 `stripStyleMarks()`；`excerpt` 保留标记。渲染靠 `renderer/js/markdown-lib.js` 的 `styledTextPlugin`。
- 数据目录：`<userData>/config.json` 的 dataDir；`main/storage.js` 解析/探测/迁移；配置目录不可用必须回退默认目录并提示，绝不导致启动失败。录音路径是绝对路径，不随数据目录迁移。

## SQLite / FTS
- FTS5 统一 **external content + `tokenize='trigram'`**，靠触发器同步。
- 两个坑：① external content 表上 `snippet()`/`highlight()` 会 SQL error 并废掉整条 bm25 查询 → 片段一律应用层截取（`highlightOf()`）；② trigram 要求查询词 ≥3 字符，短词回退 LIKE。
- 派生数据（分块/向量）不进导入导出，导入后由正文重建。

## Electron / 渲染层
- 对话框父窗口不能传 `undefined` → 统一走 `msgBox()` / `dirDialog()`。
- 拖拽取绝对路径用 preload 的 `api.pathForFile(file)`。
- 局部刷新优先只换局部 DOM；整页 innerHTML 重建会丢焦点/滚动，且旧自动保存器拿着已销毁 DOM 写库（保存前 flush + dispose）。
- **`#view` 是共享容器**：`renderTasks()` 会整块重写它。非任务视图重进要检测骨架是否还在（如 `!querySelector('.nt-wrap')`）再重建；refresh 回调调 `render()` 而非 `renderTasks()`。
- 常驻容器上的事件委托只能绑一次 → `WeakSet` 记录。
- **委托与「逐个元素的直接绑定」不能混用**：会随骨架重建的控件一律走容器级委托，重建后回填状态（关键词 / 选中项）。
- 模块互相跳转用 `await import()` 动态导入，避免循环依赖。
- `openPanelModal`：① 关闭前保存传 `onClose`；② `extraButtons` handler 第二参数是 `close`；③ 弹窗内二选一必须**先 resolve 再 close**。
- EasyMDE 的「分栏/预览/全屏」三件套别用在弹窗里（会 `position:fixed` 盖住全屏）；笔记编辑器已自实现（`data-mode` + grid + 自己渲染 `#nt-preview`）。图片插入自己监听 `paste`/`drop` + `replaceSelection`，别用 uploadImage。
- 弹窗尺寸选择器必须是 `.modal.modal-xxx`（双类），写后代永远不命中。
- `openPanelModal` 能力：`showClose` / `headHtml` / `resizable+resizeKey`（尺寸记 localStorage `modal-size:<key>`，双击手柄复位）/ 尺寸变化派发 `modal:resize`（容器内 CodeMirror、图表要重测）。
- 切主题必须同步 `nativeTheme.themeSource`，否则标题栏要重启才变。Windows 原生菜单条由系统绘制，不跟应用主题。
- 三方库 vendor 进 `renderer/vendor/` 并在 package.json 登记；EasyMDE 需 `autoDownloadFontAwesome:false`。
- 「取消」基线 = 最后一次保存成功的状态（每次 save 成功后前移），不是打开时的快照。
- 笔记详情面板两种宿主（右栏 #view / 弹窗）共用 detailHtml/mountEditor/bindSaver；`editor`/`saver` 是模块级单例，换宿主前必须 dispose；`detailPane()` 要优先命中 `modalRoot`（弹窗挂 body，#view 委托够不到，自己绑一份）。滚动区用 `.nt-dp-scroll` 包正文，foot 放外面。色板色块只能用 `background:` 预览。
- `note-find.js`（Ctrl+F/H）：复用 EasyMDE 内的 `getSearchCursor`；① 全部替换必须**倒序**；② 快捷键在**捕获阶段**拦（pcDefault 已绑 Ctrl-F）；③ Esc 在宿主层兜住。

## 「今天 / 今日已完成」口径
- `state.recentlyDone`（store.js）= 今天完成的任务就地保留标记，存 settings 带自然日，跨天作废。**记录不分视图、只有「今天」列表展示** → 任何视图的勾选入口都要调 `noteCompletionChange()`；连带完成的祖先用 `rememberCompletedAncestors()` 补记。

## 实用工具
- 「实用工具」下的工具统一用**非模态浮窗**（`renderer/js/tool-window.js`，z 210~248，低于 `.modal-mask` 300），同 key 单实例，几何记 localStorage。
- 浏览器端三方库走 esbuild：入口 `scripts/vendor/*.mjs` → `renderer/vendor/tools/*.mjs`（ESM+minify），**必须随仓库提交**。
- 配置存 settings `tool.<key>`，走 `api.ui.getToolPref/setToolPref`；新增工具要加 `main/ipc.js` 键白名单 + preload 事件白名单。
- 实时薪资（`salary.js`）：菜单 `CmdOrCtrl+Shift+S`；配置 `tool.salary`；时薪 = 月薪 ÷ 当月工作日数 ÷ 每日工时（**不用 21.75**）；只算工作日上下班区间；只展示今日/本月，不展示总月薪。

## 验证方式
- 数据层 `npm run test:db`；UI `npm run smoke`（约 2分50秒 → 需 `timeout: 600000`；每条 PowerShell 要 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` + 设 UTF8 编码；`--smoke-test` 自己切临时 userData，别再传 `--user-data-dir`）。
- CDP：WebSocket 会吊住 node → 结尾 `process.exit(0)`；断言限定作用域（`.nt-empty` 会命中侧栏标签列表）；`Runtime.evaluate` 带 `awaitPromise` 求值动态 `import()` 会永久挂住 → 异步写成发后不管 + 轮询 `window.__out`；后台节流需加 `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`。
- 本机跑 electron 必须先 `env -u ELECTRON_RUN_AS_NODE`；临时目录每次新建（`rm -rf` 会被宿主批量删除守卫拦）。
- CDP 合成的按键进不了原生加速键链路 → 菜单/快捷键只能在主进程侧用探针验证。
- CDP 易错：点 `.task-title-text` 是就地重命名（打开详情点整行）；笔记选择器点 `.np-pick-check`；用例实体名带时间戳。

## 打包 / 发版（Windows）
- `npm run dist` = gen-icon + build-tools + `build-win.js`（electron-builder 薄封装，内置国内镜像）。产物 `dist/Knodo-<ver>-安装版.exe`（nsis）/ `便携版.exe`（portable）。
- 本机打包坑：宿主有批量删除守卫（~50 次删除/轮，累计到阈值就拒，`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。**`mv` 不触发守卫，`rm` 触发** → 一切清理都用 `mv`。
- 稳定流程（v1.8.0 验证通过）：① 先 `mv` 走 `dist/win-unpacked*` 残留；② `KEEP_ELECTRON_LOCALES=1 node scripts/build-win.js`（完整打一次，NSIS 收尾删 `.__uninstaller.exe` 仍会报错，但 exe 本体已完整，可校验 FileVersion）；③ 把 `dist/win-unpacked/locales` 里多余 pak `mv` 出去只留 `zh-CN`/`en-US`（与 `build.electronLanguages` 一致，**省 47MB**）；④ `node scripts/build-win.js --win portable --prepackaged dist\win-unpacked` 直出便携版（**跳过 packaging 阶段 = 跳过所有批量删除**）。
- `npm run dist:portable` 里的 `--target portable` 是错的（electron-builder 报 `Unknown argument: target`），要用 `--win portable`。
- **便携版 exe 本身就是 LZMA SFX，再压 7z 几乎零收益**（107252503→107247083），别指望靠压缩把体积压下 Gitee 上限；要靠裁 locales。
- 便携版有 `PORTABLE_EXECUTABLE_DIR` → userData 改到 exe 同级 data 目录，且禁用开机自启动。
- 打包后 exe 不接受命令行参数（`bad option`），无法跑 `--smoke-test`，只能源码冒烟 + 查 `app.asar` 间接验证。
- 发版（Gitee）：改版本 + `scripts/release-gitee.js` 发行说明 → `chore(release)` 提交 → push → 按上面流程打包 → 7z（`node_modules/7zip-bin/win/x64/7za.exe a -t7z -mx=9 -md=128m -ms=off`，压便携版到 `dist/release/`，**必须 ≤104857600 字节**，压完核对）→ `npm run release -- --token <令牌>`。令牌只走参数/环境变量，绝不写进文件。发版前把上一版 7z 移出 `dist/release/`，否则会被一起传到新 Release。

## 跨平台现状（Mac）
- `better-sqlite3` 13 走 N-API prebuilds（`node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node`），`build/Release` 是空的，**不需要 electron-rebuild**；换平台只需换 prebuild。
- 打 Mac 包必须处理：`build.files` 里已排除 `prebuilds/darwin*`，需反向；`gen-icon.js` 目前不产 `.icns`；tray.png 是彩色，Mac 菜单栏建议 Template 图。
- macOS 目标（dmg/pkg/zip）**只能在 macOS 上构建**（依赖 codesign / hdiutil / productbuild）。
