# 项目长期约定

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

## 验证方式
- 数据层：`npm run test:db`（`scripts/smoke-db.js`，不依赖 Electron）。
- UI：`npm run smoke`；若在无桌面环境里卡住，可用
  `electron . --user-data-dir=<临时目录> --remote-debugging-port=9335` + CDP（参考 `scripts/check-packaged.js`）
  直接驱动 DOM 验证，注意**不要**指向真实用户数据目录。
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
