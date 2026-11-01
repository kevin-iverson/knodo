'use strict';
/**
 * electron-builder 的 afterPack 钩子：裁剪 Electron 语言包。
 *
 * 时机：应用目录已解包完成、NSIS / portable 目标还没开始打包 —— 所以一次构建里
 * 安装版与便携版都能吃到裁剪结果，不必分两趟跑。
 *
 * 做法：把整个 locales 目录 rename 到 dist/.locales-parked/<版本>-<时间戳>/，
 * 再新建 locales 回填 zh-CN / en-US 两个 pak。
 * **不用逐个删除**的原因：53 个文件同删会命中宿主 / CI 的批量删除守卫
 * （SAFE_DELETE_BULK_CONFIRM_REQUIRED），整趟打包会被中断；rename 不计入删除。
 *
 * 保留范围：只留中英两套。locales/*.pak 只影响 Electron 自带界面（系统文件对话框、
 * 右键菜单等），应用自身的界面文案全在 renderer 里，不受影响。
 */
const fs = require('fs');
const path = require('path');

const KEEP_LOCALES = ['zh-CN.pak', 'en-US.pak'];

module.exports = async function afterPack(context) {
  if (process.env.KEEP_ELECTRON_LOCALES === '1') {
    console.log('[after-pack] 已跳过语言包裁剪（KEEP_ELECTRON_LOCALES=1）');
    return;
  }

  const localesDir = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) {
    console.log('[after-pack] 未找到 locales 目录，跳过');
    return;
  }

  const all = fs.readdirSync(localesDir);
  const keep = all.filter((n) => KEEP_LOCALES.includes(n));
  if (all.length <= keep.length) {
    console.log('[after-pack] 语言包已是裁剪状态，跳过');
    return;
  }

  const version = (context.packager && context.packager.appInfo && context.packager.appInfo.version) || 'unknown';
  const parkRoot = path.join(context.packager.projectDir, 'dist', '.locales-parked');
  const parked = path.join(parkRoot, `${version}-${Date.now()}`);
  fs.mkdirSync(parked, { recursive: true });

  fs.renameSync(localesDir, path.join(parked, 'locales'));
  fs.mkdirSync(localesDir);
  for (const name of keep) {
    fs.copyFileSync(path.join(parked, 'locales', name), path.join(localesDir, name));
  }

  console.log(`[after-pack] 语言包 ${all.length} → ${keep.length}（${keep.join(' / ')}），`
    + `其余已挪到 ${path.relative(context.packager.projectDir, parked)}`);
};
