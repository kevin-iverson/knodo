'use strict';
/**
 * 故宫主题 · 檐角脊兽（渲染层，经典脚本）
 *
 * 只在 data-style="palace" 时出现；13 尊形象由本文件注入 .pr-row：
 *   左石狮 · 骑凤仙人 · 龙 · 凤 · 狮子 · 天马 · 海马 · 狻猊 · 押鱼 · 獬豸 · 斗牛 · 行什 · 右石狮
 *
 * 为什么不是 ES module：要和 theme-core.js 一样「首帧就在」，且不依赖 app.js 的启动顺序；
 * 本文件只读 DOM + 监听 app:theme-changed，不碰应用状态。
 */
(function () {
  const DATA = [
    {
      id: 'xianren', cn: '骑凤仙人', py: 'Qí fèng xiān rén', num: '引', group: 'roof', role: '檐角领队',
      tags: ['绝处逢生', '逢凶化吉'],
      origin: '传说战国时齐湣王兵败被追，走投无路之际，一只凤凰自天边飞来，把他驮离险境。工匠把这故事安在檐角最前端。',
      meaning: '领队的第一位。仙人端坐檐角，寓意遇难呈祥、绝处逢生，也像一枚「止步」的记号——再往前便是虚空。'
    },
    {
      id: 'long', cn: '龙', py: 'Lóng', num: '壹', group: 'roof', role: '走兽 一 / 十',
      tags: ['呼风唤雨', '皇权祥瑞'],
      origin: '远古氏族的图腾，后来成为帝王独有的象征。龙能兴云布雨、利泽万物，太和殿内外号称有万条龙。',
      meaning: '皇权至高无上的化身，寓意风调雨顺、国运昌隆。殿顶之上，它排在走兽第一位。'
    },
    {
      id: 'feng', cn: '凤', py: 'Fèng', num: '贰', group: 'roof', role: '走兽 二 / 十',
      tags: ['百鸟之王', '天下太平'],
      origin: '凤是百鸟之王，雄为凤、雌为凰。凤凰齐飞，是吉祥和谐的征兆，也常与龙并称「龙凤呈祥」。',
      meaning: '象征圣德与祥瑞，寓意天下太平、风调雨顺、帝后和美。'
    },
    {
      id: 'shizi', cn: '狮子', py: 'Shī zi', num: '叁', group: 'roof', role: '走兽 三 / 十',
      tags: ['百兽之王', '镇守辟邪'],
      origin: '狮子自汉代由西域传入，魏晋以后逐渐被神化，成为佛教的护法神兽，也被视为百兽之王。',
      meaning: '以勇猛威严镇守宫殿、辟除邪祟，寓意威震八方、护佑平安。'
    },
    {
      id: 'tianma', cn: '天马', py: 'Tiān mǎ', num: '肆', group: 'roof', role: '走兽 四 / 十',
      tags: ['追风逐日', '威德通天'],
      origin: '汉武帝得到大宛宝马，欢喜之下作《天马之歌》。脊兽里的天马生着一对翅膀，可日行千里、追风逐日。',
      meaning: '寓意威德通天、开疆拓土，也寄托着「马到成功」的祝愿。'
    },
    {
      id: 'haima', cn: '海马', py: 'Hǎi mǎ', num: '伍', group: 'roof', role: '走兽 五 / 十',
      tags: ['入海临渊', '逢凶化吉'],
      origin: '「海马」并非海洋里的海马，本义是来自海外的良马。传说它能入海临渊，与天马一上一下、一空一海。',
      meaning: '寓意通达四海、忠勇无畏，遇险也能逢凶化吉。'
    },
    {
      id: 'suanni', cn: '狻猊', py: 'Suān ní', num: '陆', group: 'roof', role: '走兽 六 / 十',
      tags: ['龙子喜烟', '护佑平安'],
      origin: '龙生九子之一，形似狮、披长鬃，性情凶猛，传说能吃虎豹；它又喜烟火、好静坐，所以常蹲在香炉上。',
      meaning: '寓意护佑平安、镇宅纳福，也带着一缕人间香火的静气。'
    },
    {
      id: 'yayu', cn: '押鱼', py: 'Yā yú', num: '柒', group: 'roof', role: '走兽 七 / 十',
      tags: ['水族统领', '灭火防灾'],
      origin: '海中瑞兽，遍身鳞甲、身后拖着鱼尾，能兴云作雨。「押」是执掌之意，它是水族鱼类的统领。',
      meaning: '木构宫殿最怕火，押鱼蹲在屋脊上，寓意灭火防灾、祈雨丰年。'
    },
    {
      id: 'xiezhi', cn: '獬豸', py: 'Xiè zhì', num: '捌', group: 'roof', role: '走兽 八 / 十',
      tags: ['独角辨曲直', '司法象征'],
      origin: '传说中的独角神兽，能辨是非曲直。见人相争，它会用角去顶那个理亏的人，是古代司法的象征。',
      meaning: '寓意公正廉明、忠诚正义。旧时御史的补服上，绣的就是獬豸。'
    },
    {
      id: 'douniu', cn: '斗牛', py: 'Dòu niú', num: '玖', group: 'roof', role: '走兽 九 / 十',
      tags: ['牛头龙身', '吞云吐雾'],
      origin: '传说中一种虬龙，牛头龙身、遍体鳞甲，擅长吞云吐雾、兴云作雨。',
      meaning: '与押鱼同守水事：寓意镇水防火、祈雨灭灾，护住这座木构巨殿。'
    },
    {
      id: 'xingshi', cn: '行什', py: 'Xíng shí', num: '拾', group: 'roof', role: '走兽 十 / 十',
      tags: ['雷神化身', '太和殿独有'],
      origin: '猴面、双翼，手执金刚宝杵，因排行第十而得名「行什」。相传它是雷震子的化身，专司防雷镇火。',
      meaning: '全国只有太和殿的檐角上出现了它，是「十全十美」的独一份，寓意消灾免祸、天下无双。'
    }
  ];

  const rail = document.getElementById('palace-rail');
  const row = document.getElementById('pr-row');
  if (!rail || !row) return;

  const ICON = 'img/palace/';
  const byId = {};
  DATA.forEach(function (d) { byId[d.id] = d; });

  let tip = null;
  let pinned = null;

  function isPalace() {
    return document.documentElement.getAttribute('data-style') === 'palace';
  }

  function beastBtn(item) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pr-beast';
    b.dataset.id = item.id;
    b.setAttribute('aria-label', item.cn + '：' + item.tags.join('，'));
    b.title = '';
    b.innerHTML = '<img src="' + ICON + item.id + '.svg" alt="' + item.cn + '" draggable="false">';
    return b;
  }

  function build() {
    DATA.forEach(function (d) { row.appendChild(beastBtn(d)); });
  }

  function content(item) {
    return '<div class="pr-tip-head">' +
        '<span class="pr-tip-ico"><img src="' + ICON + item.id + '.svg" alt=""></span>' +
        '<span>' +
          '<span class="pr-tip-role">' + item.role + '</span>' +
          '<strong class="pr-tip-name">' + item.cn + '</strong>' +
          '<span class="pr-tip-py">' + item.py + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="pr-tip-chips">' + item.tags.map(function (t) { return '<span>' + t + '</span>'; }).join('') + '</div>' +
      '<p class="pr-tip-origin">' + item.origin + '</p>' +
      '<p class="pr-tip-meaning"><b>寓意</b>' + item.meaning + '</p>' +
      '<span class="pr-tip-seal">太<br>和</span>';
  }

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'pr-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    return tip;
  }

  function place(btn) {
    const r = btn.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(10, Math.min(x, window.innerWidth - tw - 10));
    let y = r.top - th - 12;
    let below = false;
    if (y < 8) { y = r.bottom + 12; below = true; }
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
    tip.style.setProperty('--pr-caret', Math.round(r.left + r.width / 2 - x) + 'px');
    tip.classList.toggle('is-below', below);
  }

  function show(btn) {
    if (!isPalace() || !rail.offsetParent) return;
    const item = byId[btn.dataset.id];
    if (!item) return;
    ensureTip();
    tip.innerHTML = content(item);
    tip.classList.add('is-show');
    place(btn);
  }

  function hide() {
    if (pinned) { show(pinned); return; }
    if (tip) tip.classList.remove('is-show');
  }

  function unpin() {
    if (pinned) pinned.classList.remove('is-pinned');
    pinned = null;
    if (tip) tip.classList.remove('is-show');
  }

  function sync() {
    if (!isPalace()) {
      unpin();
      if (tip) tip.classList.remove('is-show');
    }
  }

  build();

  row.addEventListener('pointerover', function (e) {
    const b = e.target.closest && e.target.closest('.pr-beast');
    if (b) show(b);
  });
  row.addEventListener('pointerout', function (e) {
    const b = e.target.closest && e.target.closest('.pr-beast');
    if (!b) return;
    if (e.relatedTarget && b.contains(e.relatedTarget)) return;
    if (e.relatedTarget && row.contains(e.relatedTarget)) return;
    hide();
  });
  row.addEventListener('focusin', function (e) {
    const b = e.target.closest && e.target.closest('.pr-beast');
    if (b) show(b);
  });
  row.addEventListener('focusout', function (e) {
    if (e.target.closest && e.target.closest('.pr-beast')) hide();
  });
  row.addEventListener('click', function (e) {
    const b = e.target.closest && e.target.closest('.pr-beast');
    if (!b) return;
    if (pinned === b) { unpin(); return; }
    if (pinned) pinned.classList.remove('is-pinned');
    pinned = b;
    b.classList.add('is-pinned');
    show(b);
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.pr-beast')) unpin();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') unpin();
  });
  document.addEventListener('app:theme-changed', sync);
  try {
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-style'] });
  } catch (err) { /* 老内核 */ }
  window.addEventListener('resize', function () {
    if (pinned) place(pinned);
  });
})();
