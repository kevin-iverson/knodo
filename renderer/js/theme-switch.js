'use strict';
/**
 * 标题栏「日 / 月 盘」：一枚两态的明暗开关（用户在标定空位要求加的那个滑块）。
 *
 * 视觉完全不在这里 —— 轨道 / 盘 / 字形两态全由 :root[data-theme] 驱动（见 styles.css
 * 的 .tb-mode 段）。好处是首帧就对：theme-core.js 在 <head> 里同步写 data-theme，
 * 不需要等本模块（defer）跑起来才把盘摆到正确的一侧，否则深色用户每次启动
 * 都会看见月亮「从左边跳到右边」。
 *
 * 本模块只做三件事：
 *   1. 点击 / ←→ 把 mode 写成明确的 light / dark（走 js/theme.js 的 setTheme，主进程是权威）
 *   2. 把当前态回显到 aria-checked 与 title（告诉用户现在是哪一态、点下去变哪一态）
 *   3. 反过来跟随外部改动：设置中心「外观」里点分段、系统深浅色变化，
 *      都通过 app:theme-changed 事件回来校准
 *
 * 注意 mode 有三种可能（system / light / dark），而开关只有两态：
 * 开关永远显示「实际看到的」那一态（system 时按系统解析），点一下即固定为显式态。
 * 「跟随系统」仍可在设置中心选，这里不抢它的位置。
 */
import { getTheme, setTheme } from './theme.js';

const T = window.KnodoTheme;

/** 当前实际生效的明暗（system 时按系统偏好解析） */
function effectiveDark() {
  return T && T.resolveMode(getTheme()) === 'dark';
}

export function initThemeSwitch() {
  const btn = document.getElementById('btn-theme-mode');
  if (!btn || !T) return;

  /** 一次只处理一个切换：连点两下不会把两次 IPC 叠成来回翻滚 */
  let busy = false;

  const paint = () => {
    const theme = getTheme();
    const dark = effectiveDark();
    btn.setAttribute('aria-checked', String(dark));
    const now = dark ? '深色' : '浅色';
    const next = dark ? '浅色' : '深色';
    // 跟随系统时补一句，否则用户会以为开关自己「记住了」手动选择
    const auto = theme.mode === 'system' ? '跟随系统' : '手动';
    btn.title = `${now}主题（${auto}）· 点击切换到${next}`;
  };

  const apply = async (to) => {
    if (busy) return;
    busy = true;
    try {
      await setTheme({ mode: to });
    } catch (e) {
      // theme.js 内部已回滚到切换前的一份，这里只负责让按钮回到真实态
      console.warn('[theme-switch] 切换失败', e && e.message);
    } finally {
      busy = false;
      paint();
    }
  };

  btn.addEventListener('click', () => {
    apply(effectiveDark() ? 'light' : 'dark');
  });

  // ← → 直接指定方向：键盘用户不必先推理「现在是哪一态」
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      apply('light');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      apply('dark');
    }
  });

  // 外部改动（设置中心 / 系统深浅色）走同一条事件回来对齐
  document.addEventListener('app:theme-changed', paint);
  paint();
}
