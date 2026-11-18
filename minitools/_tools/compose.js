const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

const SHOTS = 'D:/WorkBuddyWorkSpace/todo-app/minitools/promo/shots';
const OUT = 'D:/WorkBuddyWorkSpace/todo-app/minitools/promo';

function readShot(name) {
  const p = path.join(SHOTS, name + '.png');
  return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
}

function drawCard(kind, imgs) {
  var W = 1080;
  var H = 1440;
  var canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  var ctx = canvas.getContext('2d');
  var SERIF = '700 96px Georgia, "Songti SC", SimSun, serif';
  var SERIF_S = '700 64px Georgia, "Songti SC", SimSun, serif';
  var SANS = '400 30px "PingFang SC", "Microsoft YaHei", sans-serif';
  var SANS_S = '400 26px "PingFang SC", "Microsoft YaHei", sans-serif';
  var INK = '#211a13';
  var MUTED = '#6f6457';
  var ACCENT = '#c8553d';

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function spaced(text, x, y, spacing) {
    var cursor = x;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      ctx.fillText(ch, cursor, y);
      cursor += ctx.measureText(ch).width + spacing;
    }
  }

  function wrap(text, x, y, maxWidth, lineHeight) {
    var line = '';
    var lines = [];
    for (var i = 0; i < text.length; i++) {
      var test = line + text.charAt(i);
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = text.charAt(i);
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    for (var j = 0; j < lines.length; j++) {
      ctx.fillText(lines[j], x, y + j * lineHeight);
    }
    return lines.length * lineHeight;
  }

  function drawPhone(img, x, y, w, h, rot, radius) {
    if (!img) return;
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    if (rot) ctx.rotate(rot);
    ctx.shadowColor = 'rgba(60, 42, 28, 0.22)';
    ctx.shadowBlur = 46;
    ctx.shadowOffsetY = 20;
    ctx.fillStyle = '#fffdf8';
    roundRect(-w / 2 - 10, -h / 2 - 10, w + 20, h + 20, radius + 10);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    roundRect(-w / 2, -h / 2, w, h, radius);
    ctx.save();
    ctx.clip();
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
    ctx.restore();
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  ctx.fillStyle = '#f2ece2';
  ctx.fillRect(0, 0, W, H);

  var g1 = ctx.createRadialGradient(980, 110, 0, 980, 110, 560);
  g1.addColorStop(0, 'rgba(200, 85, 61, 0.16)');
  g1.addColorStop(1, 'rgba(200, 85, 61, 0)');
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, W, 700);

  var g2 = ctx.createRadialGradient(60, 1360, 0, 60, 1360, 520);
  g2.addColorStop(0, 'rgba(47, 93, 80, 0.14)');
  g2.addColorStop(1, 'rgba(47, 93, 80, 0)');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 800, W, H - 800);

  ctx.fillStyle = MUTED;
  ctx.font = '600 25px "PingFang SC", "Microsoft YaHei", sans-serif';
  spaced('KNODO · 岗位测评', 84, 108, 5);

  var indexes = { cover: '01', start: '02', quiz: '03', result: '04' };
  ctx.fillStyle = 'rgba(33, 26, 19, 0.12)';
  ctx.font = '700 120px Georgia, "Songti SC", SimSun, serif';
  ctx.textAlign = 'right';
  ctx.fillText(indexes[kind], 996, 150);
  ctx.textAlign = 'left';

  return loadImage(imgs[kind]).then(function (img) {
    if (kind === 'cover') {
      ctx.fillStyle = ACCENT;
      ctx.font = '600 24px "PingFang SC", "Microsoft YaHei", sans-serif';
      spaced('CAREER ARCHETYPE TEST', 84, 268, 6);

      ctx.fillStyle = INK;
      ctx.font = SERIF;
      ctx.fillText('你适合', 84, 400);
      ctx.fillText('什么岗位？', 84, 512);

      ctx.fillStyle = MUTED;
      ctx.font = SANS;
      wrap('10 道情境题，看看你的工作性格更像哪一种人，以及哪些岗位更容易让你发挥。', 84, 600, 430, 50);

      ctx.fillStyle = ACCENT;
      ctx.fillRect(84, 780, 84, 8);

      ctx.fillStyle = INK;
      ctx.font = '700 30px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText('10 道题 · 1 分钟 · 6 种原型', 84, 840);

      drawPhone(img, 560, 720, 520, 690, -0.07, 34);
    } else if (kind === 'start') {
      ctx.fillStyle = ACCENT;
      ctx.font = '600 24px "PingFang SC", "Microsoft YaHei", sans-serif';
      spaced('START', 84, 300, 7);

      ctx.fillStyle = INK;
      ctx.font = SERIF_S;
      ctx.fillText('先看看你的', 84, 420);
      ctx.fillText('工作性格', 84, 500);

      ctx.fillStyle = MUTED;
      ctx.font = SANS;
      wrap('没有标准答案，选最像你的那个。10 道题，大约 1 分钟。', 84, 580, 360, 50);

      drawPhone(img, 470, 640, 470, 620, 0.04, 34);
    } else if (kind === 'quiz') {
      ctx.fillStyle = ACCENT;
      ctx.font = '600 24px "PingFang SC", "Microsoft YaHei", sans-serif';
      spaced('QUESTIONS', 556, 300, 7);

      ctx.fillStyle = INK;
      ctx.font = SERIF_S;
      wrap('6 种岗位原型', 556, 410, 440, 78);

      ctx.fillStyle = MUTED;
      ctx.font = SANS_S;
      wrap('洞察者 · 造梦者 · 连接者 · 推动者 · 影响者 · 探索者', 556, 500, 420, 46);

      ctx.fillStyle = MUTED;
      ctx.font = SANS;
      wrap('按你的选择计分，给出最接近的原型和适合方向。', 556, 640, 420, 50);

      drawPhone(img, 84, 420, 430, 660, -0.05, 34);
    } else {
      ctx.fillStyle = ACCENT;
      ctx.font = '600 24px "PingFang SC", "Microsoft YaHei", sans-serif';
      spaced('RESULT', 84, 300, 7);

      ctx.fillStyle = INK;
      ctx.font = SERIF_S;
      ctx.fillText('结果直接给方向', 84, 410);

      ctx.fillStyle = MUTED;
      ctx.font = SANS;
      wrap('除了原型，还会给出适合的岗位方向、你的优势和可以留意的地方。', 84, 500, 380, 50);

      ctx.fillStyle = ACCENT;
      ctx.fillRect(84, 660, 64, 7);

      drawPhone(img, 520, 420, 470, 620, 0.04, 34);
    }

    ctx.fillStyle = 'rgba(33, 26, 19, 0.42)';
    ctx.font = '400 22px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('基于 10 道情境题 · 仅供职业探索参考', 84, 1372);

    return canvas.toDataURL('image/png');
  });
}

app.whenReady().then(async function () {
  const win = new BrowserWindow({
    width: 400,
    height: 400,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const imgs = {
    cover: readShot('result'),
    start: readShot('start'),
    quiz: readShot('quiz'),
    result: readShot('result')
  };

  const kinds = [
    { kind: 'cover', file: '01-cover.png' },
    { kind: 'start', file: '02-start.png' },
    { kind: 'quiz', file: '03-quiz.png' },
    { kind: 'result', file: '04-result.png' }
  ];

  for (const item of kinds) {
    const dataUrl = await win.webContents.executeJavaScript(
      '(' + drawCard.toString() + ')(' + JSON.stringify(item.kind) + ',' + JSON.stringify(imgs) + ')'
    );
    const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, item.file), buffer);
    console.log('wrote', item.file, buffer.length + ' bytes');
  }

  app.quit();
}).catch(function (error) {
  console.error('COMPOSE_ERROR', error && error.stack ? error.stack : error);
  app.exit(1);
});
