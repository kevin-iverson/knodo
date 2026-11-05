'use strict';
/**
 * 赞助相关弹窗。
 *
 * 设置页的「微信赞赏码」和任务视图的「用了 N 天了」一次性提示共用同一份内容，
 * 所以单独拆一个模块 —— 避免 settings.js 与 ui.js 互相 import。
 */

import { openPanelModal } from './modal.js';

const QR_IMG = 'img/sponsor-qr.jpg';

/** 与设置页「关于」里那段保持同一份措辞：改一处就都变。 */
const SPONSOR_NOTE =
  'Knodo 由一个人维护，开源、免费、没有订阅。'
  + '捐赠只用来覆盖 Windows 代码签名证书，其余地方不花钱——数据在你自己电脑上，不需要服务器。'
  + '<br>不捐完全不影响使用，提 issue 同样是支持。';

/** 打开赞赏码。设置页的按钮和「用了 N 天」弹窗的按钮都走这里。 */
export function openSponsorQr() {
  return openPanelModal({
    title: '微信赞赏码',
    className: 'modal-sponsor',
    showClose: true,
    okText: '知道了',
    minWidth: 420,
    html: `<div class="sponsor-box">
      <img src="${QR_IMG}" alt="微信赞赏码">
      <p class="sponsor-tip">微信扫一扫，金额随意。</p>
      <p class="sponsor-tip">${SPONSOR_NOTE}</p>
    </div>`,
  });
}

/**
 * 「用满 N 天 + 当天任务全部完成」时问一次。
 *
 * 只问一次由主进程的 settings 标记保证（app:sponsorPrompt 返回 show 时就已经写下了标记），
 * 所以这里可以被反复调用而不会重复打扰。
 *
 * @param {number} days 已使用天数，仅用于文案
 */
export function openSponsorAsk(days) {
  const d = Number(days) >= 1 ? Math.floor(Number(days)) : 15;
  let goQr = false;
  return openPanelModal({
    title: `用了 ${d} 天了`,
    className: 'modal-sponsor-ask',
    showClose: true,
    okText: '看看赞赏码',
    extraButtons: [{ label: '不用了' }],
    html: `<div class="sponsor-ask">
      <p class="sponsor-ask-lead">这 ${d} 天，任务和笔记都只在这台电脑里。</p>
      <p>${SPONSOR_NOTE}</p>
    </div>`,
    // 「看看赞赏码」：先记录意图，等这一层关掉再开下一层，避免两个弹窗叠在一起
    onSubmit: () => { goQr = true; return null; },
    onClose: () => { if (goQr) setTimeout(() => { openSponsorQr(); }, 0); },
  });
}
