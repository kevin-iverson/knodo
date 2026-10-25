# 项目长期约定

## 品牌与标识（Knodo）
- **对外名称 = `build.productName`（Knodo）**；`package.json` 的 `name`（`todo-desktop`）与
  `build.appId` 是**内部标识，绝不能跟着改**：Electron 用 `name` 决定用户数据目录，
  真实安装版的数据就在 `%APPDATA%\todo-desktop`（历史上 productName 是「TODO待办」，
  该目录并不存在 → 证明数据目录只认 `name`）。改品牌只动
  `productName` / `nsis.shortcutName` / 界面文案 / 图标。
- 发布脚本用 `BRAND` 常量（取自 `pkg.build.productName`）拼 Release 标题与附件名，不要用 `pkg.name`。
- **图标由 `scripts/gen-icon.js` 手写光栅器生成，不要换成图片素材**：矢量几何 + 4× 超采样
  （预乘平均），改一个数字就能重出全部尺寸，16px 还有单独的简化几何。
  三档：`full`(≥48) / `simple`(24~47) / `tiny`(16，去节点且竖条右移)。
  脚本可被 `require`（只导出函数、不写文件），检查脚本靠这个复用 `rasterize`。
- 标识语义：圆环 = 知识回路（O）；竖条 = 清单勾选竖条（K 的竖线），两端顶到圆环内缘成一条弦；
  两条斜臂从竖条中点射出，经**与斜臂共线**的细连线接到圆环节点（共 3 个节点）。
  改图形时别破坏这几条：竖条别悬空、竖条与圆环左弧别贴太近（会挤出一条像渲染瑕疵的细缝）、
  细连线别横着浮空。
- **任务栏图标**：`app.setAppUserModelId('com.workbuddy.knodo')` 必须设，否则任务栏沿用宿主
  electron.exe 的身份与图标缓存。打包版 exe 的图标是打包时嵌入的（`build.win.icon` → `assets/icon.ico`），
  改图标后**必须重新打包**才在安装版里生效。
- **改启动项名字要迁移**：`main/autostart.js` 的 `LOGIN_ITEM_NAME` 改名时，把旧名加进
  `LEGACY_LOGIN_ITEM_NAMES`，`getState()` 会在启动时带着原开关状态迁移并删掉旧项；
  不迁移的话任务管理器里会同时躺着两条启动项，或者用户的自启动被静默关掉。

## 数据模型
- **分组名唯一性作用域 = 同一 parent_id**（顶级自成一级）；不同层级允许同名。
  校验在 `main/db.js` 的 `assertGroupName()`，`createGroup` / `updateGroup` 都必须走它。
  **不要给 groups 加数据库唯一索引**：旧备份导入可能带同级重名，加索引会让导入 / 启动直接失败。
- **附件**：宿主目录为 `<数据目录>/attachments/<kind>-<宿主id>/<附件id>_<文件名>`，kind 目前有
  `task` / `note` 两种（`main/attachments.js` 的 `ownerDir/importInto/importDataUrl/removeOwnerDir`）。
  库里（tasks.attachments / notes.attachments）只存元数据 JSON（含**相对**路径）。相对路径是硬约束——
  数据目录整体搬家后必须还能解析。删除任务时用 `db.subtreeTaskIds()` 收集子树再 `removeTaskDir()` 清盘；
  彻底删除笔记时 `removeOwnerDir('note', id)`。
- **本地图片（`todo-media://`）**：笔记正文里的本地图片写 `todo-media:///<相对路径>`，
  由 `main/main.js` 注册的自定义协议映射回附件文件（只认 attachments 目录内，越界返回 -6）。
  不要用 `file://`（CSP 限制 + 等于放开整盘）。CSP 的 `img-src` 已含 `'self' data: https: todo-media:`。
- **笔记颜色 / 高亮不占新列**：以 `==文字=={c:#e5484d;bg:#fff3a3}` 内联标记写进 `notes.content_md`。
  导入导出、FTS 触发器、知识库分块天然生效。`word_count / content_hash / notes_fts / kb_chunks`
  一律先过 `db.stripStyleMarks()`；`excerpt` **保留**标记（`plainTextOf(md, keepStyle=true)`）供卡片渲染。
  渲染靠 `renderer/js/markdown-lib.js` 的 markdown-it 内联插件 `styledTextPlugin`（`html:false`，色值只放行 `#hex`）。
- **数据目录**：`<userData>/config.json` 的 `dataDir` 决定库与附件位置；`main/storage.js` 负责解析 / 探测 / 迁移。
  配置目录不可用时必须回退默认目录并提示，绝不能因此启动失败。录音（`recordings/`）不随数据目录迁移：
  会议表里存的是绝对路径。

## SQLite / 全文检索
- FTS5 统一用 **external content + `tokenize='trigram'`**（中文免外部分词器）；靠触发器同步。
- 两个已踩的坑：
  1. external content 表上调用 `snippet()` / `highlight()` 会直接报 `SQL logic error`，还会把整条
     `bm25()` 查询一起废掉（只能静默降级 LIKE）→ 命中片段一律在应用层截取（见 `highlightOf()`）。
  2. trigram 要求查询词 **≥ 3 字符**，短词必须回退 `LIKE`（`searchNotes` / `searchKbChunks` 已处理）。
- 派生数据（分块、向量）**不进导入导出**，导入后由正文重建。

## Electron / 渲染层
- 对话框（`showMessageBox` / `showOpenDialog`）第一个参数是父窗口，**不能传 `undefined`**：
  统一走 `main/main.js` 的 `msgBox()` / `dirDialog()`。
- 拖拽文件取绝对路径必须用 preload 里的 `api.pathForFile(file)`（Electron 32+ 的 `File` 没有 `.path`）。
- 详情抽屉、子任务树等「局部刷新」优先只替换局部 DOM：整页 `innerHTML` 重建会丢焦点 / 滚动位置，
  还会让旧自动保存器拿着已销毁的 DOM 继续写库（保存前必须 `flush` + `dispose`）。
- **`#view` 是共享容器**：任务列表 `renderTasks()` 会整块重写它。任何非任务视图（笔记 / 会议 / 报告）
  重进时必须检测自己的骨架还在不在（如 `!container.querySelector('.nt-wrap')`）再决定是否重建；
  视图的 refresh 回调要调 `render()` 而不是 `renderTasks()`。
- **事件委托挂在常驻容器上时只能用一次**：容器不随 innerHTML 重绘而换新，重复 `addEventListener`
  会让一次点击触发 N 个处理器（弹窗开 N 个、删 N 次）→ 用 `WeakSet` 记已绑容器。
- **委托与「逐个元素的直接绑定」不能混用**（已踩两次：见第 40~41 行与这里的组合）。骨架会被重建的
  视图（笔记 / 会议等）里，`bindEvents` 首次执行时顺手给某个具体 input/text 挂的监听器，
  在骨架重建后就永久失联 —— 因为容器已在 WeakSet 里、`bindEvents` 不会再跑，而那个元素是全新的。
  **凡是会随骨架重建的控件，一律走容器级委托**（`#nt-search` 的 input/keydown 就是这么修的）；
  重建后记得把视图状态（关键词、选中项）回填进新节点。
- 模块间要互相跳转时（任务详情 ↔ 笔记视图）用 `await import()` 动态导入，避免静态循环依赖。
- **弹窗（`openPanelModal`）里放编辑器 / 做二选一确认时的三个约定**（都是踩过的坑）：
  1. 需要「关闭前保存」就传 `onClose`（Esc / 点遮罩也会走）；
  2. `extraButtons` 的 handler 第二个参数是 `close`，用它可以自己关窗；
  3. 弹窗内二选一（如「回收站 / 彻底删除」）用 Promise 收集结果时，必须 **先 resolve 再 close**——
     `onClose` 里若也有 `resolve(null)`，反序会让第一次决议抢先，操作静默失效。
- **EasyMDE 的「分栏 / 预览 / 全屏」三件套别用在弹窗里**：`toggleSideBySide()` 默认
  `sideBySideFullscreen: true`，一分栏就把 `.CodeMirror` 变成 `position:fixed; top:50px` 盖住整个应用。
  笔记编辑器已改成自己实现（`data-mode` + grid + 自己把 markdown-it 结果渲染进 `#nt-preview`），
  需要预览语义时照这套来。图片插入**不要**用 `uploadImage + imageUploadFunction`（内部 P()/G() 在部分
  光标状态会把整行替换成自身，表现为「图片存了但没插进正文」）——自己监听 `cm.on('paste'|'drop')`
  再 `replaceSelection` 更可控。
- **弹窗尺寸类的选择器必须是 `.modal.modal-xxx`（双类）**：`className` 是加在 `.modal` 自身上的，
  写成 `.modal-note-editor .modal`（后代）永远不命中 → 弹窗退化成 380px 默认宽、内容挤压变形。
  已踩：modal-note-editor / modal-kb / modal-note-delete / modal-note-picker。
- **`openPanelModal` 的能力**（`renderer/js/modal.js`）：`showClose`（抬头 ✕）、`headHtml`（抬头额外按钮）、
  `resizable + resizeKey + minWidth/minHeight`（右下角拖拽缩放，尺寸记 localStorage `modal-size:<key>`，
  双击手柄恢复默认）。`.modal` 上会挂 `__toggleMax()`，尺寸变化派发 `modal:resize` 事件
  （容器内的 CodeMirror / 图表要监听它重新测量）。
- **切换主题必须同步主进程 `nativeTheme.themeSource`**：`theme:set` 里只写库不设 nativeTheme 的话，
  运行时切主题后标题栏 / 原生控件仍是旧主题，要重启才变（用户会报「主题样式异常」）。
  Windows 的原生菜单条由系统绘制、不跟应用主题，要彻底一致只能改自绘标题栏。
- 第三方前端库一律 vendor 进 `renderer/vendor/`（离线运行），并在 `package.json` 登记来源；
  EasyMDE 需 `autoDownloadFontAwesome:false`，图标用 CSS `::after` 兜底。

- **「取消」的基线 = 最后一次保存成功的状态**，不是「打开时的快照」：每次 save 回调成功后都要让
  `baseline` 前移，否则自动保存已落库再点取消会把已保存内容一起撤掉（用户看到「已保存 14:53」
  却回到更早版本，语义自相矛盾）。取消 = 撤销自上次保存以来的改动。
- **笔记详情面板的两种宿主**：右栏（#view 内）与弹窗（`openNoteModal`，任务详情点关联笔记时用）
  共用同一套 detailHtml/mountEditor/bindSaver；`editor`/`saver` 是模块级单例，**换宿主前必须
  dispose 旧的**；`detailPane()` 等查询要优先命中 `modalRoot`（弹窗挂 body，#view 的事件委托
  够不到它，弹窗要自己绑一份委托）。底部操作条不能被 max-height 裁：滚动区用 `.nt-dp-scroll`
  包住正文/附件/引用，foot 放外面。色板色块只能用 `background:` 预览（空元素设 `color:` 看不见）。
- **CDP 临时脚本的三个坑**：① WebSocket 开着会吊住 node 事件循环，结尾必须 `process.exit(0)`，
  否则看着像「卡住」；② `document.querySelector('.nt-empty')` 会命中**侧栏标签列表**的
  「暂无标签」，断言必须限定作用域（`.nt-col .nt-list .nt-empty`）；
  ③ **`Runtime.evaluate` 带 `awaitPromise: true` 去求值动态 `import()` 会永久挂住**（表现为脚本
  「Runtime.evaluate 超时」，且之后同一连接上的求值也可能被拖死）。异步操作一律写成
  `(async () => { try { … } catch (e) { window.__err = e.message } })(); 1` 这种发后不管的形式，
  只求同步返回值，再用轮询读结果变量。
- **CDP 合成的按键进不了 Electron 的原生加速键链路**：`Input.dispatchKeyEvent` 打不出菜单快捷键
  （`document.hasFocus()` 为 true、`Page.bringToFront`、鼠标点击激活、`Emulation.setFocusEmulationEnabled`
  全都无效；同一个按键在页内被 DOM 收到、`Escape` 也能关弹窗，但 `Ctrl+Shift+X` 不会触发主进程菜单项）。
  **菜单 / 加速键只能在主进程侧验证**：写一个外层探针包装 `Menu.setApplicationMenu` 后 `require`
  真实 `main.js`，把 `Menu.getApplicationMenu()` 的运行时结构 dump 成 JSON 再断言
  （临时文件放项目外，不改源码）。
- **`renderer/js/note-find.js`：笔记正文查找 / 替换（Ctrl+F / Ctrl+H）**。
  匹配复用 EasyMDE dist 里已打包的 `cm.getSearchCursor(q, {line:0,ch:0}, {caseFold, multiline:true})`
  （dist 只带了 searchcursor，没有 addon/search 的面板），浮条 UI 自己画。三个要点：
  ① 全部替换必须**倒序**（先改后面的，前面的 {line,ch} 才不会错位）；
  ② 快捷键要在**捕获阶段**拦 —— CodeMirror pcDefault 里已绑 `"Ctrl-F": "find"`；
  ③ Esc 要在宿主层（`handleFindShortcut`）兜住，因为焦点常常还在正文里、浮条自身收不到。

## 实用工具浮窗（`renderer/js/tool-window.js`）与第三方库 vendor
- 菜单「实用工具」下的工具（实时薪资、代码格式化、文本对比）统一用**非模态浮窗**：无遮罩、不抢焦点，
  主界面照常操作；`openToolWindow({key, title, html, onMount, ...})` 同 key 单实例（重复调用置顶）。
  z-index 210~248，刻意低于 `.modal-mask`(300)。几何 / 最小化最大化状态记 `localStorage['tool-win:'+key]`。
- **浏览器端三方库一律走 esbuild 打包**：入口放 `scripts/vendor/*.mjs`，`npm run build:tools` 产出
  `renderer/vendor/tools/*.mjs`（ESM + minify + 内联 NODE_ENV），渲染层动态 `import('../vendor/tools/x.mjs')` 懒加载。
  打包产物不带 node_modules，vendor 必须随仓库提交；大的（如 prettier 的 java 插件）单独成包按需拉。
- 配置存 settings `tool.<key>`，走 `api.ui.getToolPref/setToolPref`（`main/ipc.js` 有键白名单），
  新增工具要把 key 加进白名单 + preload 的 `api.on` 事件白名单。

## 实用工具：实时薪资（`renderer/js/salary.js`）
- 入口：顶层菜单「实用工具 → 实时薪资」（`main/main.js` 的 `buildAppMenu`，`CmdOrCtrl+Shift+S`），
  click 发 `ui:salary` → 渲染层 `openSalaryModal()`。弹窗不占视图，重复点只把已有窗口抢焦点。
- 配置存 settings `tool.salary`（`{monthly,start,end}`），`ui:getSalary` / `ui:setSalary` 只做 JSON 搬运；
  **计算与校验都在渲染层**（要按当前时间实时刷新）。
- 口径（模块头注释里也有，改动前先确认业务含义）：只算周一~周五、只算上下班区间内时长；
  **时薪 = 月薪 ÷ 当月工作日数 ÷ 每日工时**（不用固定 21.75），保证「整月全勤 = 正好一个月薪」。
  今日 = 区间内已过分钟 × 时薪；本月 = 1 号至今逐日累加（今天只算已过部分）。
- 只展示「今日已获得 / 本月累计」，**不展示总月薪**（隐私，弹窗可能被旁人看到）。
- 计算逻辑可脱离 UI 单独复核：从模块里抽「时间工具」到「弹窗」两段注释之间的代码，
  写进临时 `.mjs` 直接 import（依赖 `api.js` / `modal.js` 的只有弹窗段，纯计算段无副作用）。

## 「今天 / 今日已完成」的口径- `state.recentlyDone`（`renderer/js/store.js`）是「今天完成的任务就地保留」标记，存 settings 带自然日，
  跨天自动作废、点「隐藏已完成」清空。**记录不分视图、只有「今天」列表负责展示**：
  `noteCompletionChange(id, completed, parentId)` 在任何视图的勾选入口都要调。
- 子任务全部勾完时 `db.toggleTask` 会递归把父任务标记完成，这类「连带完成」的祖先由
  `rememberCompletedAncestors()` 补记，否则父任务会从今天列表里凭空消失、只剩一排子任务。

## 验证方式
- 数据层：`npm run test:db`（`scripts/smoke-db.js`，不依赖 Electron）。
- UI：`npm run smoke`；若在无桌面环境里卡住，可用
  `electron . --user-data-dir=<临时目录> --remote-debugging-port=9335` + CDP（参考 `scripts/check-packaged.js`）
  直接驱动 DOM 验证，注意**不要**指向真实用户数据目录。
- **跑 `npm run smoke` 的三个环境坑**（整套现在约 2分50秒，比默认 2 分钟超时还长）：
  ① 每条 PowerShell 命令都是新会话，`Remove-Item Env:\ELECTRON_RUN_AS_NODE` 必须写在同一条命令里，
     否则 electron 退化成 node（报 `Cannot read properties of undefined (reading 'setPath')`）；
  ② 同条命令里加 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，否则中文日志变 GBK 乱码；
  ③ 调用工具要显式给 `timeout: 600000`，不然跑到一半被掐断（日志停在某一轮且没有 SMOKE_OK / SMOKE_FAIL）。
  `--smoke-test` 自己会把 userData 切到 `os.tmpdir()/todo-smoke-profile` 并清空，**不要再传 `--user-data-dir`**。
- **CDP 长脚本会被后台节流**：窗口不可见时渲染进程的 `setTimeout` 被限速，脚本表现为「卡住不返回」
  （实际已执行完）。启动调试实例时加 `--disable-background-timer-throttling --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows`；验证结果时把中间状态挂到 `window.__out` 再轮询，
  别用 `awaitPromise` 一次性等（求值动态 `import()` 会永久挂住）。
- **本机启动 electron 必须先清掉环境变量**：`env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .`
  （该变量会让 electron.exe 退化成 node 直接跑 main.js，报 `app.requestSingleInstanceLock is not a function`）。
  临时目录要每次新建，`rm -rf` 会撞上宿主的批量删除守卫。
  CDP 脚本里的两个易错点：任务列表**点 `.task-title-text` 是就地重命名**，打开详情要点整行；
  笔记选择器要点 `.np-pick-check`（点 `li` 无效）；用例创建实体时用带时间戳的名字，避免多轮运行互相污染。

## 发版流程（Gitee）
1. 提交改动 → 改 `package.json` 版本 + `scripts/release-gitee.js` 里的发行说明（追加一段 `### vX.Y.Z 更新`）
   → 单独一个 `chore(release)` 提交 → `git push origin main`。
2. `KEEP_ELECTRON_LOCALES=1 npm run dist`（见下）。产物：`dist/TODO待办-<ver>-安装版.exe`、
   `TODO待办-<ver>-便携版.exe`。
3. 压缩便携版：`mv` 走多余的 `locales/*.pak` 只留 `en-US` + `zh-CN`，再用
   `node_modules/7zip-bin/win/x64/7za.exe a -t7z -m0=lzma2 -mx=9 -md=128m` 打到 `dist/release/`。
   **Gitee 单附件上限 100MB**，压完必须核对体积。
4. `npm run release -- --token <Gitee 私人令牌>`：自动打 tag + 建 Release + 传 `dist/release/` 下附件。
   令牌只走参数 / 环境变量，**绝不写进任何文件**；发布前确认 `dist/release/` 里没有上一版的残留附件。

**本机打包的两个坑**：宿主有批量删除守卫（约 50 文件/轮），electron-builder 清空 `dist/win-unpacked`
和裁剪 locales 都会撞上，`rm -rf` 也一样被拦——**用 `mv` 代替删除**；跳过裁剪用
`KEEP_ELECTRON_LOCALES=1`（`scripts/build-win.js`）。打包后的 exe 不接受命令行参数（`bad option`），
无法跑 `--smoke-test`，产物只能靠源码冒烟 + 查 `app.asar` 内容间接验证。
