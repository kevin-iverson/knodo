'use strict';
/**
 * 通知身份自检：node scripts/verify-notification-identity.js [--toast]
 *
 * 走一遍真实的启动路径：设置 AUMID + 写 HKCU DisplayName，并打印结果。
 * 加 --toast 会额外发一条测试通知，用来肉眼确认通知中心里的发送者
 * 从「Electron」变成「Knodo」。用独立 userData，不抢单实例锁、不碰真实数据。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* 两种启动形态都要能跑：
 * - `electron scripts/xxx.js`：Electron 主进程，require('electron') 是 API 对象；
 * - `node scripts/xxx.js`（npm script）或环境里带 ELECTRON_RUN_AS_NODE=1：
 *   require('electron') 只返回 exe 路径，需要清掉该变量后重新用 exe 拉起自己。 */
const electronModule = require('electron');
if (typeof electronModule === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const r = spawnSync(electronModule, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit', env, windowsHide: true,
  });
  process.exit(r.status == null ? 1 : r.status);
}
const { app, Notification } = electronModule;

const profile = path.join(os.tmpdir(), 'knodo-identity-check');
const realUserData = app.getPath('userData');   // 收尾要把 IconUri 指回这儿，别停在临时目录
fs.rmSync(profile, { recursive: true, force: true });
app.setPath('userData', profile);

const identity = require('../main/app-identity');
const withToast = process.argv.includes('--toast');
const ok = identity.registerWindowsIdentity();

/* 不 spawn reg.exe 读回：宿主把 reg.exe 列进了程序黑名单（安全策略，无法放行）。
   IconUri 是否真的落库由 writeIdentity 的返回值背书 —— RegSetKeyValueW 返回非 0 会抛错，
   抛错只警告且这里拿得到，所以「通过」= 写成功且副本存在。要肉眼核对就：
   PowerShell: Get-ItemProperty HKCU:\Software\Classes\AppUserModelId\<AUMID> */
/* 副本文件名带内容哈希（knodo-<hash8>.png），换图标就换路径，所以这里按目录找最新那份 */
function findIconCopy(root) {
  try {
    return fs.readdirSync(path.join(root, 'brand'))
      .filter((f) => /^knodo-[0-9a-f]{8}\.png$/.test(f))
      .map((f) => path.join(root, 'brand', f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
  } catch (e) {
    return '';
  }
}
const iconPath = findIconCopy(profile);
const iconOk = !!iconPath && fs.statSync(iconPath).size > 0;

console.log('[identity] AUMID       :', identity.APP_USER_MODEL_ID);
console.log('[identity] 注册表键    :', identity.REG_KEY);
console.log('[identity] DisplayName :', identity.DISPLAY_NAME);
console.log('[identity] 写入结果    :', ok ? '成功 (ERROR_SUCCESS)' : '失败');
console.log('[identity] 图标副本    :', iconOk ? `${iconPath} (${fs.statSync(iconPath).size} B)` : '未生成');
console.log('[identity] IconUri     :', iconOk ? '已指向上面这份副本' : '未写入');
console.log(ok && iconOk ? '[identity] 通过' : '[identity] 未完全通过');

/* 收尾：把 IconUri 指回真实用户数据目录。
   本脚本用临时 userData 跑，不还原的话开发机的 AUMID 会被指向一个随后被删掉的路径。 */
try {
  app.setPath('userData', realUserData);
  identity.registerWindowsIdentity();
  console.log('[identity] 已还原 IconUri →', findIconCopy(realUserData) || '(未生成)');
} catch (e) {
  console.log('[identity] 还原失败（不影响程序本身）：', e && e.message ? e.message : e);
}

const passed = ok && iconOk;

app.whenReady().then(() => {
  if (withToast && Notification.isSupported()) {
    new Notification({
      title: 'Knodo 通知身份自检',
      body: '通知中心上方若显示 Knodo 即修复成功',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    }).show();
    setTimeout(() => app.exit(passed ? 0 : 1), 2500);
  } else {
    app.exit(passed ? 0 : 1);
  }
});
