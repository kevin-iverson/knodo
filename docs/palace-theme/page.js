(function () {
  'use strict';
  const DATA = window.BEASTS || [];
  const TIP = document.getElementById('tip');

  /* ── 构建一尊脊兽 ───────────────────────────────── */
  function beastEl(item) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'beast' + (item.group === 'lion' ? ' beast--lion' : '');
    b.dataset.id = item.id;
    b.dataset.label = item.cn;
    b.setAttribute('aria-label', item.cn + '：' + item.tagline);
    b.innerHTML = '<img src="svg/' + item.id + '.svg" alt="' + item.cn + '" draggable="false">';
    return b;
  }

  /* ── 檐角队列（左右各一尊石狮） ─────────────────── */
  const ridge = document.getElementById('ridge-row');
  const lions = DATA.filter(function (d) { return d.group === 'lion'; });
  const roof = DATA.filter(function (d) { return d.group === 'roof'; });
  lions[0] && ridge.appendChild(beastEl(lions[0]));
  roof.forEach(function (d) { ridge.appendChild(beastEl(d)); });
  lions[1] && ridge.appendChild(beastEl(lions[1]));

  /* ── 角色设定集 ─────────────────────────────────── */
  const sheet = document.getElementById('sheet-grid');
  DATA.forEach(function (d) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML =
      '<div class="card-art"><span class="num">' + d.num + '</span>' +
        '<img src="svg/' + d.id + '.svg" alt="' + d.cn + '">' +
      '</div>' +
      '<div class="card-body">' +
        '<h3 class="card-name">' + d.cn + '</h3>' +
        '<p class="card-py">' + d.py + '</p>' +
        '<p class="card-tag">' + d.tagline + '</p>' +
        '<p class="card-origin">' + d.origin + '</p>' +
        '<p class="card-meaning"><b>寓意</b>' + d.meaning + '</p>' +
      '</div>';
    sheet.appendChild(card);
  });
  const note = document.createElement('article');
  note.className = 'card card--note';
  note.innerHTML =
    '<h3 class="card-name">设定说明</h3>' +
    '<p class="card-py">Drawing notes</p>' +
    '<ul class="card-list">' +
      '<li><b>骨架</b>共用一套坐姿：头宽约 58、身高约 90，头顶留白给角、冠、翼。</li>' +
      '<li><b>线条</b>统一 2px 墨线，浅色填充；光源在左上，右下略压暗。</li>' +
      '<li><b>道具</b>金项圈与铜铃统一气质，再各给一件「身份物」：龙珠、绣球、幼狮、金刚杵。</li>' +
      '<li><b>尺寸</b>56px 能辨轮廓，120px 看细节；透明底，深浅背景都可直接放。</li>' +
    '</ul>';
  sheet.appendChild(note);

  /* ── 界面实景 ───────────────────────────────────── */
  function mockHTML(mode) {
    const tasks = [
      { t: '梳理 1.12 需求池取舍', g: '产品迭代 · 需求梳理', p: '高', d: '今天', hi: false, tag: '文档' },
      { t: '写 1.12 排期草案', g: '产品迭代 · 排期', p: '中', d: '11-15', hi: false, tag: '' },
      { t: '详情面板视觉走查', g: '设计 · 走查', p: '高', d: '11-16', hi: true, tag: '设计' },
      { t: '把复现步骤发给后端', g: '客户支持', p: '紧急', d: '今天', hi: true, tag: '后端' }
    ];
    const taskHTML = tasks.map(function (x) {
      return '<div class="mk-task">' +
        '<span class="mk-box"></span>' +
        '<div><b>' + x.t + '</b><div class="meta">' +
          '<span class="tag">' + x.g + '</span>' +
          '<span class="' + (x.p === '紧急' || x.p === '高' ? 'pri-high' : '') + '">' + x.p + '</span>' +
          '<span>截止 ' + x.d + '</span>' +
          (x.tag ? '<span class="tag">' + x.tag + '</span>' : '') +
        '</div></div>' +
        '<span class="mk-date">' + x.d + '</span>' +
      '</div>';
    }).join('');

    return '<div class="mock mock--' + mode + '">' +
      '<div class="mk-bar">' +
        '<div class="mk-logo"><span class="mark">✓</span>Knodo<span class="mk-ver">v2.6.0</span></div>' +
        '<div class="mk-tabs">' +
          '<span class="mk-tab on">日历</span><span class="mk-tab">统计</span>' +
          '<span class="mk-tab">工时</span><span class="mk-tab">搭子</span>' +
        '</div>' +
        '<div class="mk-right"><span class="mk-dot">◐</span>' +
          '<div class="mk-win"><span>─</span><span>□</span><span>✕</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="mk-body">' +
        '<aside class="mk-side">' +
          '<div class="mk-nav">' +
            '<a class="on" href="#" onclick="return false"><span class="ic"></span>今天</a>' +
            '<a href="#" onclick="return false"><span class="ic"></span>即将到期</a>' +
            '<a href="#" onclick="return false"><span class="ic"></span>未完成</a>' +
            '<a href="#" onclick="return false"><span class="ic"></span>全部任务</a>' +
            '<a href="#" onclick="return false"><span class="ic"></span>已完成</a>' +
            '<a href="#" onclick="return false"><span class="ic"></span>笔记</a>' +
          '</div>' +
          '<h4>分组</h4>' +
          '<div class="mk-group">' +
            '<a href="#" onclick="return false">产品迭代<i>25</i></a>' +
            '<a href="#" onclick="return false">客户支持<i>9</i></a>' +
            '<a href="#" onclick="return false">团队协作<i>9</i></a>' +
            '<a href="#" onclick="return false">个人成长<i>4</i></a>' +
          '</div>' +
        '</aside>' +
        '<main class="mk-main">' +
          '<div class="mk-head">' +
            '<div><h3>今天</h3><div class="sub">11 月 14 日 · 周五 · 已逾期 2 项</div></div>' +
            '<div class="mk-tools">' +
              '<span class="mk-search">搜索任务 / 标签…</span>' +
              '<span class="mk-btn">笔记</span>' +
              '<span class="mk-btn pri">+ 新建任务</span>' +
            '</div>' +
          '</div>' +
          '<div class="mk-chips">' +
            '<span class="mk-chip">优先级</span><span class="mk-chip on">全部</span>' +
            '<span class="mk-chip">低</span><span class="mk-chip">中</span>' +
            '<span class="mk-chip">高</span><span class="mk-chip">紧急</span>' +
          '</div>' +
          '<div class="mk-list">' + taskHTML + '</div>' +
        '</main>' +
      '</div>' +
      '<div class="mk-sill">' +
        '<div class="mk-seal">太和</div>' +
        '<div class="mk-caption">太和殿 · 十脊兽</div>' +
        '<div class="mk-row"></div>' +
      '</div>' +
    '</div>';
  }

  ['light', 'dark'].forEach(function (mode) {
    const host = document.getElementById('mock-' + mode);
    host.innerHTML = mockHTML(mode);
    const row = host.querySelector('.mk-row');
    const lions2 = DATA.filter(function (d) { return d.group === 'lion'; });
    const roof2 = DATA.filter(function (d) { return d.group === 'roof'; });
    lions2[0] && row.appendChild(beastEl(lions2[0]));
    roof2.forEach(function (d) { row.appendChild(beastEl(d)); });
    lions2[1] && row.appendChild(beastEl(lions2[1]));
  });

  /* ── 色板 ───────────────────────────────────────── */
  const colors = [
    ['宫墙红', '#8E2B23', '标题栏 / 主色'],
    ['朱砂', '#C0503C', '凤、印章'],
    ['琉璃黄', '#E7BC5E', '脊线 / 金饰'],
    ['赤金', '#C99A3C', '描边 / 小字'],
    ['石青', '#4A7BA6', '龙、天马'],
    ['石绿', '#5E8E7C', '凤尾、押鱼'],
    ['汉白玉', '#EFE3CE', '石狮 / 底座'],
    ['宣纸', '#F6EEDC', '浅色底'],
    ['墨', '#2B211A', '文字 / 线']
  ];
  document.getElementById('swatches').innerHTML = colors.map(function (c) {
    return '<div class="sw"><i style="background:' + c[1] + '"></i>' +
      '<span><b>' + c[0] + '</b>' + c[1] + ' · ' + c[2] + '</span></div>';
  }).join('');

  /* ── 介绍卡 ─────────────────────────────────────── */
  let pinned = null;

  function fill(item) {
    TIP.innerHTML =
      '<div class="tip-head">' +
        '<div class="tip-ico"><img src="svg/' + item.id + '.svg" alt="' + item.cn + '"></div>' +
        '<div>' +
          '<div class="tip-role">' + item.role + '</div>' +
          '<div class="tip-name">' + item.cn + '</div>' +
          '<div class="tip-py">' + item.py + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="tip-chips">' + item.tagline.split('·').map(function (s) {
        return '<span>' + s.trim() + '</span>';
      }).join('') + '</div>' +
      '<p class="tip-origin">' + item.origin + '</p>' +
      '<p class="tip-meaning"><b>寓意</b>' + item.meaning + '</p>' +
      '<div class="tip-seal">太<br>和</div>';
    TIP.setAttribute('aria-hidden', 'false');
  }

  function place(btn) {
    const r = btn.getBoundingClientRect();
    TIP.style.visibility = 'hidden';
    TIP.classList.add('show');
    const tw = TIP.offsetWidth, th = TIP.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(12, Math.min(x, window.innerWidth - tw - 12));
    let y = r.top - th - 16;
    let below = false;
    if (y < 12) { y = r.bottom + 16; below = true; }
    TIP.style.left = Math.round(x) + 'px';
    TIP.style.top = Math.round(y) + 'px';
    TIP.classList.toggle('below', below);
    TIP.style.setProperty('--caret', Math.round(r.left + r.width / 2 - x) + 'px');
    TIP.style.visibility = '';
  }

  function show(btn) {
    const item = DATA.find(function (d) { return d.id === btn.dataset.id; });
    if (!item) return;
    fill(item);
    TIP.classList.add('show');
    requestAnimationFrame(function () { place(btn); });
    place(btn);
  }

  function hide() {
    if (pinned) { show(pinned); return; }
    TIP.classList.remove('show');
    TIP.setAttribute('aria-hidden', 'true');
  }

  document.addEventListener('pointerover', function (e) {
    const btn = e.target.closest && e.target.closest('.beast');
    if (btn) show(btn);
  });
  document.addEventListener('pointerout', function (e) {
    const btn = e.target.closest && e.target.closest('.beast');
    if (!btn) return;
    const to = e.relatedTarget;
    if (to && to.closest && to.closest('.beast') === btn) return;
    hide();
  });
  document.addEventListener('focusin', function (e) {
    const btn = e.target.closest && e.target.closest('.beast');
    if (btn) show(btn);
  });
  document.addEventListener('focusout', function (e) {
    if (e.target.closest && e.target.closest('.beast')) hide();
  });

  document.addEventListener('click', function (e) {
    const btn = e.target.closest && e.target.closest('.beast');
    if (!btn) {
      if (pinned) {
        pinned.classList.remove('is-pinned');
        pinned = null;
        TIP.classList.remove('show');
      }
      return;
    }
    if (pinned === btn) {
      btn.classList.remove('is-pinned');
      pinned = null;
      TIP.classList.remove('show');
    } else {
      if (pinned) pinned.classList.remove('is-pinned');
      pinned = btn;
      btn.classList.add('is-pinned');
      show(btn);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && pinned) {
      pinned.classList.remove('is-pinned');
      pinned = null;
      TIP.classList.remove('show');
    }
  });

  window.addEventListener('scroll', function () { if (pinned) place(pinned); }, { passive: true });
  window.addEventListener('resize', function () { if (pinned) place(pinned); });

  /* 深链：?beast=tianma 直接钉住某一位，方便截图与分享 */
  const demo = new URLSearchParams(window.location.search).get('beast');
  if (demo) {
    const btn = document.querySelector('#ridge-row .beast[data-id="' + demo + '"]');
    if (btn) {
      pinned = btn;
      btn.classList.add('is-pinned');
      show(btn);
    }
  }
})();
