# 项目长期约定

## 数据模型
- **分组名唯一性作用域 = 同一 parent_id**（顶级自成一级）；不同层级允许同名。
  校验在 `main/db.js` 的 `assertGroupName()`，`createGroup` / `updateGroup` 都必须走它。
  **不要给 groups 加数据库唯一索引**：旧备份导入可能带同级重名，加索引会让导入 / 启动直接失败。
- **附件**：文件本体在 `<数据目录>/attachments/task-<任务id>/<附件id>_<文件名>`，
  `tasks.attachments` 只存元数据 JSON（含**相对**路径）。相对路径是硬约束——数据目录整体搬家后必须还能解析。
  删除任务时用 `db.subtreeTaskIds()` 收集子树再 `attachments.removeTaskDir()` 清盘。
- **数据目录**：`<userData>/config.json` 的 `dataDir` 决定库与附件位置；`main/storage.js` 负责解析 / 探测 / 迁移。
  配置目录不可用时必须回退默认目录并提示，绝不能因此启动失败。录音（`recordings/`）不随数据目录迁移：
  会议表里存的是绝对路径。

## Electron / 渲染层
- 对话框（`showMessageBox` / `showOpenDialog`）第一个参数是父窗口，**不能传 `undefined`**：
  统一走 `main/main.js` 的 `msgBox()` / `dirDialog()`。
- 拖拽文件取绝对路径必须用 preload 里的 `api.pathForFile(file)`（Electron 32+ 的 `File` 没有 `.path`）。
- 详情抽屉、子任务树等「局部刷新」优先只替换局部 DOM：整页 `innerHTML` 重建会丢焦点 / 滚动位置，
  还会让旧自动保存器拿着已销毁的 DOM 继续写库（保存前必须 `flush` + `dispose`）。

## 验证方式
- 数据层：`npm run test:db`（`scripts/smoke-db.js`，不依赖 Electron）。
- UI：`npm run smoke`；若在无桌面环境里卡住，可用
  `electron . --user-data-dir=<临时目录> --remote-debugging-port=9335` + CDP（参考 `scripts/check-packaged.js`）
  直接驱动 DOM 验证，注意**不要**指向真实用户数据目录。

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
