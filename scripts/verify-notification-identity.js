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
fs.rmSync(profile, { recursive: true, force: true });
app.setPath('userData', profile);

const identity = require('../main/app-identity');
const withToast = process.argv.includes('--toast');
const ok = identity.registerWindowsIdentity();

console.log('[identity] AUMID       :', identity.APP_USER_MODEL_ID);
console.log('[identity] 注册表键    :', identity.REG_KEY);
console.log('[identity] DisplayName :', identity.DISPLAY_NAME);
console.log('[identity] 写入结果    :', ok ? '成功 (ERROR_SUCCESS)' : '失败');
console.log(ok ? '[identity] 通过' : '[identity] 失败');

app.whenReady().then(() => {
  if (withToast && Notification.isSupported()) {
    new Notification({
      title: 'Knodo 通知身份自检',
      body: '通知中心上方若显示 Knodo 即修复成功',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    }).show();
    setTimeout(() => app.exit(ok ? 0 : 1), 2500);
  } else {
    app.exit(ok ? 0 : 1);
  }
});
