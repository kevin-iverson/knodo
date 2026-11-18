(function () {
  'use strict';

  var STORAGE_KEY = 'knodo_career_result_v1';

  var TYPES = {
    analyst: {
      name: '洞察者',
      en: 'ANALYST',
      color: '#2f5d50',
      tag: '你习惯先把问题拆开，再决定往哪里用力。',
      strengths: [
        '能从杂乱信息里找到真正影响结果的那几个变量',
        '做判断前习惯找依据，不容易被情绪带着走',
        '擅长把复杂的事讲成别人听得懂的结构'
      ],
      jobs: ['数据分析师', '策略产品经理', '经营/财务分析', '用户研究', '投资分析'],
      watch: ['别等到数据齐全才肯行动，先跑一个小验证', '把结论翻译成人话，别让专业术语挡住沟通']
    },
    creator: {
      name: '造梦者',
      en: 'CREATOR',
      color: '#b3472f',
      tag: '你对表达和审美敏感，讨厌千篇一律的答案。',
      strengths: [
        '容易冒出别人想不到的角度和表达',
        '对画面、文字、节奏的细微差别很敏感',
        '愿意为一个细节反复打磨到自己满意'
      ],
      jobs: ['内容策划', '视觉/UI 设计', '品牌创意', '编导/剪辑', '文案'],
      watch: ['灵感型选手更需要交付节点，给自己设死线', '先确认需求边界，别把时间花在无人买单的完美上']
    },
    connector: {
      name: '连接者',
      en: 'CONNECTOR',
      color: '#3d6b7a',
      tag: '你天生会读空气，也愿意花时间理解别人。',
      strengths: [
        '能快速感知对方的情绪和真实诉求',
        '擅长把不同的人拉到同一张桌子上',
        '别人愿意向你求助，也愿意听你劝'
      ],
      jobs: ['用户运营', '招聘/HR', '客户成功', '社群运营', '教师/培训'],
      watch: ['别把所有情绪劳动都接下来，学会划边界', '做决定时别过度顾及所有人，先保住目标']
    },
    driver: {
      name: '推动者',
      en: 'DRIVER',
      color: '#8a5a2b',
      tag: '你关心事情有没有真的往前走。',
      strengths: [
        '目标感强，能把模糊的事拆成可执行的步骤',
        '遇到卡点会主动找人、找资源，而不是等',
        '对进度和结果敏感，习惯闭环'
      ],
      jobs: ['项目经理', '电商运营', '供应链/履约', '活动执行', '运营管理'],
      watch: ['别为了推进度忽略人的状态，后劲会反噬', '方向没对齐时，先停一下比硬推更省成本']
    },
    influencer: {
      name: '影响者',
      en: 'INFLUENCER',
      color: '#a33b52',
      tag: '你相信一件事能不能成，很大程度看谁愿意跟着做。',
      strengths: [
        '表达有感染力，能把一件事讲得让人想参与',
        '不怕被拒绝，能从一次次沟通里找机会',
        '对人心和场域敏感，知道什么时候该推一把'
      ],
      jobs: ['销售/BD', '市场增长', '公关传播', '主播/达人', '培训讲师'],
      watch: ['别把热度当成结果，落地环节要有人兜住', '承诺前先算清交付能力，信誉比单子贵']
    },
    explorer: {
      name: '探索者',
      en: 'EXPLORER',
      color: '#5a4a7a',
      tag: '你对“为什么”的兴趣，往往大过“怎么做”。',
      strengths: [
        '好奇心强，愿意钻进一个陌生领域刨根问底',
        '能从看似无关的信息里连出新的线索',
        '不轻易接受现成结论，习惯自己验证'
      ],
      jobs: ['咨询顾问', '行业研究', '战略规划', '产品创新', '科研/学术'],
      watch: ['研究容易无限展开，给自己设一个“够用”的截止点', '把发现落成一页可执行的建议，别只停在洞察']
    }
  };

  var TYPE_ORDER = ['analyst', 'creator', 'connector', 'driver', 'influencer', 'explorer'];

  var QUESTIONS = [
    {
      q: '接手一个全新项目，你最想先做的是？',
      opts: [
        { t: 'analyst', s: 'driver', text: '拆目标、定指标，先把口径对齐' },
        { t: 'explorer', s: 'connector', text: '搞清楚它到底解决谁的什么问题' },
        { t: 'creator', s: 'explorer', text: '先画一版概念图，找找感觉' },
        { t: 'influencer', s: 'driver', text: '拉群找人，把资源先凑齐' }
      ]
    },
    {
      q: '你更享受哪种工作节奏？',
      opts: [
        { t: 'explorer', s: 'analyst', text: '有大块安静时间，深入啃一个难题' },
        { t: 'influencer', s: 'connector', text: '每天和不同的人打交道，事情推着走' },
        { t: 'driver', s: 'analyst', text: '项目制，有明确的开始和交付' },
        { t: 'creator', s: 'explorer', text: '灵感来了就集中爆发，平时自由安排' }
      ]
    },
    {
      q: '别人来找你帮忙，通常是因为？',
      opts: [
        { t: 'analyst', s: 'creator', text: '帮他把复杂的事讲清楚' },
        { t: 'creator', s: 'influencer', text: '帮他想出不一样的点子' },
        { t: 'driver', s: 'connector', text: '帮他协调人、把进度推起来' },
        { t: 'connector', s: 'explorer', text: '听他吐槽，给他情绪支持' }
      ]
    },
    {
      q: '一份方案被否了，你的第一反应是？',
      opts: [
        { t: 'analyst', s: 'explorer', text: '找数据，看哪个假设不成立' },
        { t: 'creator', s: 'analyst', text: '换三个角度，重写一版' },
        { t: 'influencer', s: 'connector', text: '问清楚决策人真正在意什么' },
        { t: 'connector', s: 'driver', text: '先稳住团队，再定下一步' }
      ]
    },
    {
      q: '你理想中的团队角色是？',
      opts: [
        { t: 'analyst', s: 'driver', text: '定标准、把质量的人' },
        { t: 'creator', s: 'influencer', text: '出创意、定调性的人' },
        { t: 'driver', s: 'analyst', text: '拿结果、扛指标的人' },
        { t: 'influencer', s: 'connector', text: '连接内外、找机会的人' }
      ]
    },
    {
      q: '看到一个没见过的新工具，你会？',
      opts: [
        { t: 'explorer', s: 'analyst', text: '研究它背后的机制和边界' },
        { t: 'creator', s: 'influencer', text: '想它能怎么做出好玩的内容' },
        { t: 'driver', s: 'analyst', text: '算它能帮谁省多少时间' },
        { t: 'influencer', s: 'connector', text: '立刻推荐给可能用得上的人' }
      ]
    },
    {
      q: '你最受不了哪种工作状态？',
      opts: [
        { t: 'analyst', s: 'creator', text: '反复做没有沉淀的杂事' },
        { t: 'connector', s: 'influencer', text: '一个人闷头干、长期没有反馈' },
        { t: 'driver', s: 'explorer', text: '方向天天变、没人拍板' },
        { t: 'explorer', s: 'creator', text: '规则死板、不能试新东西' }
      ]
    },
    {
      q: '如果收入一样，你更想选？',
      opts: [
        { t: 'analyst', s: 'driver', text: '把一个复杂系统跑顺' },
        { t: 'influencer', s: 'creator', text: '做一个很多人看的内容' },
        { t: 'driver', s: 'connector', text: '带一支队伍打硬仗' },
        { t: 'explorer', s: 'analyst', text: '研究一个没人研究过的问题' }
      ]
    },
    {
      q: '你的成就感主要来自？',
      opts: [
        { t: 'explorer', s: 'analyst', text: '想明白了别人没想明白的' },
        { t: 'connector', s: 'creator', text: '做出来的东西被人喜欢' },
        { t: 'driver', s: 'analyst', text: '事情被我推动着落地了' },
        { t: 'connector', s: 'influencer', text: '有人因为我变得更好' }
      ]
    },
    {
      q: '朋友形容你，最可能说的是？',
      opts: [
        { t: 'analyst', s: 'driver', text: '靠谱、有条理' },
        { t: 'creator', s: 'influencer', text: '有意思、脑洞大' },
        { t: 'connector', s: 'creator', text: '会聊、让人舒服' },
        { t: 'influencer', s: 'driver', text: '有冲劲、能扛事' }
      ]
    }
  ];

  var state = {
    index: 0,
    answers: [],
    result: null
  };

  var els = {};
  var miniTool = null;
  var storageReady = false;
  var toastTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function getMiniTool() {
    if (window.xhs && window.xhs.miniTool) return window.xhs.miniTool;
    return null;
  }

  function tapFeedback() {
    if (miniTool && typeof miniTool.vibrateShort === 'function') {
      try {
        miniTool.vibrateShort({ type: 'light' });
      } catch (error) {
        /* 无马达或版本不支持时静默降级 */
      }
    }
  }

  function showToast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      els.toast.hidden = true;
    }, 1800);
  }

  function showScreen(name) {
    els.screenStart.className = name === 'start' ? 'screen is-active' : 'screen';
    els.screenQuiz.className = name === 'quiz' ? 'screen is-active' : 'screen';
    els.screenResult.className = name === 'result' ? 'screen is-active' : 'screen';
    els.stepLabel.textContent = name === 'quiz' ? '进行中' : (name === 'result' ? '测评结果' : '10 道题');
    els.stage.scrollTop = 0;
  }

  function checkStorage() {
    if (!miniTool || typeof miniTool.getLaunchOptions !== 'function') {
      disableStorage();
      return;
    }
    miniTool.getLaunchOptions().then(function (options) {
      var env = options && options.miniToolEnv;
      var buildVersion = Number(env && env.buildVersion) || 0;
      var version = Math.floor(buildVersion / 1000);
      storageReady = version >= 9460 &&
        typeof miniTool.setStorage === 'function' &&
        typeof miniTool.getStorage === 'function';
      if (!storageReady) {
        disableStorage();
        return;
      }
      return loadSaved();
    }).catch(function () {
      disableStorage();
    });
  }

  function disableStorage() {
    storageReady = false;
    els.storageHint.hidden = false;
    els.btnResume.hidden = true;
  }

  function loadSaved() {
    return miniTool.getStorage({ key: STORAGE_KEY }).then(function (res) {
      if (!res || !res.data) return;
      var data = JSON.parse(res.data);
      if (!data || !data.type || !TYPES[data.type]) return;
      state.result = data;
      els.btnResume.hidden = false;
      els.btnResume.textContent = '查看上次结果（' + TYPES[data.type].name + '）';
    }).catch(function () {
      /* 读取失败不阻塞使用，按无历史结果处理 */
    });
  }

  function saveResult(result) {
    if (!storageReady) return;
    try {
      miniTool.setStorage({
        key: STORAGE_KEY,
        data: JSON.stringify(result)
      }).catch(function () {
        /* 写入失败不影响本次查看 */
      });
    } catch (error) {
      /* 同步异常同样静默 */
    }
  }

  function startTest() {
    state.index = 0;
    state.answers = [];
    state.result = null;
    renderQuestion();
    showScreen('quiz');
  }

  function renderQuestion() {
    var item = QUESTIONS[state.index];
    els.questionText.textContent = item.q;
    els.qIndex.textContent = '第 ' + (state.index + 1) + ' 题';
    var percent = Math.round(((state.index + 1) / QUESTIONS.length) * 100);
    els.qPercent.textContent = percent + '%';
    els.progressFill.style.width = percent + '%';
    els.btnBack.hidden = state.index === 0;

    while (els.options.firstChild) {
      els.options.removeChild(els.options.firstChild);
    }

    for (var i = 0; i < item.opts.length; i++) {
      els.options.appendChild(buildOption(item.opts[i], i));
    }
  }

  function buildOption(option, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'option';
    button.setAttribute('data-index', String(index));

    var badge = document.createElement('span');
    badge.className = 'opt-idx';
    badge.textContent = String.fromCharCode(65 + index);

    var text = document.createElement('span');
    text.className = 'opt-text';
    text.textContent = option.text;

    button.appendChild(badge);
    button.appendChild(text);
    return button;
  }

  function chooseOption(index) {
    var item = QUESTIONS[state.index];
    var option = item.opts[index];
    if (!option) return;
    tapFeedback();

    state.answers[state.index] = { t: option.t, s: option.s };

    if (state.index >= QUESTIONS.length - 1) {
      finishTest();
      return;
    }
    state.index += 1;
    renderQuestion();
    els.stage.scrollTop = 0;
  }

  function goBack() {
    if (state.index === 0) return;
    state.index -= 1;
    state.answers[state.index] = null;
    renderQuestion();
    els.stage.scrollTop = 0;
  }

  function finishTest() {
    var scores = {};
    var i;
    for (i = 0; i < TYPE_ORDER.length; i++) {
      scores[TYPE_ORDER[i]] = 0;
    }
    for (i = 0; i < state.answers.length; i++) {
      var answer = state.answers[i];
      if (!answer) continue;
      if (scores[answer.t] !== undefined) scores[answer.t] += 2;
      if (scores[answer.s] !== undefined) scores[answer.s] += 1;
    }

    var ranking = TYPE_ORDER.slice().sort(function (a, b) {
      return scores[b] - scores[a];
    });
    var first = ranking[0];
    var second = ranking[1];
    var isBlend = scores[first] - scores[second] <= 1 && scores[second] > 0;

    state.result = {
      type: first,
      second: isBlend ? second : null,
      scores: scores,
      at: Date.now()
    };

    saveResult(state.result);
    renderResult(state.result);
    showScreen('result');
  }

  function renderResult(result) {
    var main = TYPES[result.type];
    var secondType = result.second ? TYPES[result.second] : null;

    els.resultEyebrow.textContent = result.second
      ? 'YOUR ARCHETYPE · ' + main.en + ' × ' + secondType.en
      : 'YOUR ARCHETYPE · ' + main.en;
    els.resultName.textContent = result.second
      ? main.name + ' × ' + secondType.name
      : main.name;
    els.resultTag.textContent = result.second
      ? main.tag + ' 同时，你也带着' + secondType.name + '的视角。'
      : main.tag;

    renderDims(result);

    var strengths = main.strengths.slice();
    if (secondType) strengths.push(secondType.strengths[0]);
    fillList(els.strengths, strengths.slice(0, 4));

    var jobs = main.jobs.slice(0, 4);
    if (secondType) {
      for (var i = 0; i < secondType.jobs.length && jobs.length < 6; i++) {
        if (jobs.indexOf(secondType.jobs[i]) === -1) jobs.push(secondType.jobs[i]);
      }
    }
    fillChips(els.jobs, jobs);

    fillList(els.watch, main.watch.slice(0, 2));
  }

  function renderDims(result) {
    var max = 1;
    var key;
    for (key in result.scores) {
      if (result.scores.hasOwnProperty(key) && result.scores[key] > max) {
        max = result.scores[key];
      }
    }

    while (els.dims.firstChild) {
      els.dims.removeChild(els.dims.firstChild);
    }

    for (var i = 0; i < TYPE_ORDER.length; i++) {
      var typeKey = TYPE_ORDER[i];
      var score = result.scores[typeKey] || 0;
      var percent = Math.round((score / max) * 100);

      var row = document.createElement('div');
      row.className = 'dim' + (typeKey === result.type ? ' is-top' : '');

      var name = document.createElement('span');
      name.className = 'dim-name' + (typeKey === result.type ? ' dim-top' : '');
      name.textContent = TYPES[typeKey].name;

      var track = document.createElement('span');
      track.className = 'dim-track';
      var fill = document.createElement('span');
      fill.className = 'dim-fill';
      fill.style.width = percent + '%';
      track.appendChild(fill);

      var value = document.createElement('span');
      value.className = 'dim-val';
      value.textContent = percent + '%';

      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(value);
      els.dims.appendChild(row);
    }
  }

  function fillList(host, items) {
    while (host.firstChild) {
      host.removeChild(host.firstChild);
    }
    for (var i = 0; i < items.length; i++) {
      var li = document.createElement('li');
      li.textContent = items[i];
      host.appendChild(li);
    }
  }

  function fillChips(host, items) {
    while (host.firstChild) {
      host.removeChild(host.firstChild);
    }
    for (var i = 0; i < items.length; i++) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = items[i];
      host.appendChild(chip);
    }
  }

  function saveCard() {
    var result = state.result;
    if (!result) return;

    if (!miniTool || typeof miniTool.saveImageToPhotosAlbum !== 'function') {
      showToast('当前版本不支持保存到相册');
      return;
    }

    var dataUrl;
    try {
      dataUrl = renderCard(result);
    } catch (error) {
      showToast('卡片生成失败，请重试');
      return;
    }

    var task;
    if (typeof miniTool.writeTempFile === 'function') {
      task = miniTool.writeTempFile({ data: dataUrl }).then(function (res) {
        return res.filePath;
      });
    } else {
      task = Promise.resolve(dataUrl);
    }

    task.then(function (filePath) {
      return miniTool.saveImageToPhotosAlbum({ filePath: filePath });
    }).then(function () {
      showToast('已保存到相册');
      tapFeedback();
    }).catch(function () {
      showToast('保存失败，请确认相册权限');
    });
  }

  function renderCard(result) {
    var width = 1080;
    var height = 1440;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var main = TYPES[result.type];
    var secondType = result.second ? TYPES[result.second] : null;

    ctx.fillStyle = '#f2ece2';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = 'rgba(200, 85, 61, 0.10)';
    ctx.beginPath();
    ctx.arc(960, 120, 230, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(47, 93, 80, 0.09)';
    ctx.beginPath();
    ctx.arc(90, 1320, 260, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#7b6f61';
    ctx.font = '600 26px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('KNODO · 岗位测评', 90, 110);

    ctx.fillStyle = '#211a13';
    ctx.font = '700 54px Georgia, "Songti SC", "SimSun", serif';
    ctx.fillText('你的岗位原型', 90, 190);

    ctx.fillStyle = main.color;
    ctx.font = '700 116px Georgia, "Songti SC", "SimSun", serif';
    ctx.fillText(main.name, 90, 340);

    if (secondType) {
      ctx.fillStyle = '#7b6f61';
      ctx.font = '600 46px Georgia, "Songti SC", "SimSun", serif';
      ctx.fillText('× ' + secondType.name, 92, 410);
    }

    ctx.fillStyle = '#c8553d';
    ctx.fillRect(90, 372, 96, 8);

    ctx.fillStyle = '#4a3f34';
    ctx.font = '400 32px "PingFang SC", "Microsoft YaHei", sans-serif';
    drawWrapped(ctx, main.tag, 90, 480, 900, 48, 2);

    ctx.fillStyle = '#211a13';
    ctx.font = '700 34px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('适合方向', 90, 640);

    var jobs = main.jobs.slice(0, 4);
    var row;
    for (row = 0; row < jobs.length; row++) {
      var y = 700 + row * 82;
      ctx.fillStyle = '#dfe9e4';
      ctx.fillRect(90, y - 42, 900, 64);
      ctx.fillStyle = '#2f5d50';
      ctx.font = '600 30px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText(String(row + 1) + '  ' + jobs[row], 116, y);
    }

    ctx.fillStyle = '#211a13';
    ctx.font = '700 34px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('你的优势', 90, 1090);

    ctx.fillStyle = '#4a3f34';
    ctx.font = '400 29px "PingFang SC", "Microsoft YaHei", sans-serif';
    var strengths = main.strengths.slice(0, 3);
    for (var i = 0; i < strengths.length; i++) {
      drawWrapped(ctx, '· ' + strengths[i], 90, 1148 + i * 62, 900, 40, 1);
    }

    ctx.fillStyle = '#8a7d6d';
    ctx.font = '400 24px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('基于 10 道情境题 · 仅供职业探索参考', 90, 1360);

    return canvas.toDataURL('image/png');
  }

  function drawWrapped(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    var line = '';
    var lines = [];
    var i;
    for (i = 0; i < text.length; i++) {
      var test = line + text.charAt(i);
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = text.charAt(i);
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    var limit = maxLines || lines.length;
    for (i = 0; i < lines.length && i < limit; i++) {
      ctx.fillText(lines[i], x, y + i * lineHeight);
    }
  }

  function bind() {
    els.btnStart.addEventListener('click', function () {
      tapFeedback();
      startTest();
    });

    els.btnResume.addEventListener('click', function () {
      if (!state.result) return;
      renderResult(state.result);
      showScreen('result');
    });

    els.options.addEventListener('click', function (event) {
      var target = event.target;
      while (target && target !== els.options) {
        if (target.getAttribute && target.getAttribute('data-index') !== null) {
          chooseOption(Number(target.getAttribute('data-index')));
          return;
        }
        target = target.parentNode;
      }
    });

    els.btnBack.addEventListener('click', goBack);

    els.btnRestart.addEventListener('click', function () {
      state.result = null;
      showScreen('start');
      els.btnResume.hidden = !storageReady;
      if (storageReady) {
        els.btnResume.textContent = '查看上次结果';
      }
    });

    els.btnSave.addEventListener('click', saveCard);
  }

  function init() {
    els = {
      stage: byId('stage'),
      stepLabel: byId('stepLabel'),
      screenStart: byId('screenStart'),
      screenQuiz: byId('screenQuiz'),
      screenResult: byId('screenResult'),
      btnStart: byId('btnStart'),
      btnResume: byId('btnResume'),
      storageHint: byId('storageHint'),
      qIndex: byId('qIndex'),
      qPercent: byId('qPercent'),
      progressFill: byId('progressFill'),
      questionText: byId('questionText'),
      options: byId('options'),
      btnBack: byId('btnBack'),
      resultEyebrow: byId('resultEyebrow'),
      resultName: byId('resultName'),
      resultTag: byId('resultTag'),
      dims: byId('dims'),
      strengths: byId('strengths'),
      jobs: byId('jobs'),
      watch: byId('watch'),
      btnSave: byId('btnSave'),
      btnRestart: byId('btnRestart'),
      toast: byId('toast')
    };

    miniTool = getMiniTool();
    bind();
    checkStorage();
  }

  init();
})();
