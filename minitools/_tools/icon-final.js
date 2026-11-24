const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

const OUT = 'D:/WorkBuddyWorkSpace/todo-app/minitools/promo/icon';

// 定稿：墨绿底 + 奶白六扇环 + 陶土红「选中」扇区（向外探出）
function drawFinal(size) {
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  var k = size / 1024;
  ctx.scale(k, k);

  var g = ctx.createRadialGradient(700, 190, 0, 700, 190, 920);
  g.addColorStop(0, '#39705f');
  g.addColorStop(1, '#22473d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);

  // 视觉重心补偿：红扇区偏右上，整体略向左下
  var ox = -7;
  var oy = 5;
  var cx = 512 + ox;
  var cy = 512 + oy;

  var rOut = 352;
  var rIn = 134;
  var gapDeg = 5.8;
  var cream = '#f7f0e4';
  var accent = '#e2694f';

  function slice(a0, a1, ro, ri, color) {
    ctx.beginPath();
    ctx.arc(cx, cy, ro, a0, a1, false);
    ctx.arc(cx, cy, ri, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  for (var i = 1; i < 6; i++) {
    var b0 = (-90 + i * 60 + gapDeg / 2) * Math.PI / 180;
    var b1 = (-90 + (i + 1) * 60 - gapDeg / 2) * Math.PI / 180;
    slice(b0, b1, rOut, rIn, cream);
  }

  var a0 = (-90 + gapDeg / 2) * Math.PI / 180;
  var a1 = (-90 + 60 - gapDeg / 2) * Math.PI / 180;
  slice(a0, a1, rOut + 26, rIn, accent);

  // 中心深孔，让环读成「罗盘/转盘」而不是饼图
  ctx.beginPath();
  ctx.arc(cx, cy, 46, 0, Math.PI * 2);
  ctx.fillStyle = '#1c3d34';
  ctx.fill();

  return canvas.toDataURL('image/png');
}

function drawSheet(urls) {
  var canvas = document.createElement('canvas');
  canvas.width = 1300;
  canvas.height = 1120;
  var ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1300, 560);
  ctx.fillStyle = '#14161d';
  ctx.fillRect(0, 560, 1300, 560);

  function rr(x, y, w, h, r) {
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

  return new Promise(function (resolve) {
    var img = new Image();
    img.onload = function () {
      var big = 300;
      var small = [132, 72, 44];
      for (var row = 0; row < 2; row++) {
        var baseY = row * 560;
        // 大图带圆角
        ctx.save();
        rr(60, baseY + 40, big, big, 68);
        ctx.clip();
        ctx.drawImage(img, 60, baseY + 40, big, big);
        ctx.restore();

        // 小尺寸直接方裁（平台会自己切圆角）
        var sx = 60 + big + 44;
        for (var s = 0; s < small.length; s++) {
          ctx.save();
          rr(sx, baseY + 60, small[s], small[s], Math.max(8, small[s] * 0.23));
          ctx.clip();
          ctx.drawImage(img, sx, baseY + 60, small[s], small[s]);
          ctx.restore();
          sx += small[s] + 34;
        }

        // 应用列表模拟
        ctx.fillStyle = row === 0 ? 'rgba(33,26,19,0.10)' : 'rgba(255,255,255,0.10)';
        rr(sx + 20, baseY + 52, 160, 56, 14);
        ctx.fill();
        ctx.save();
        rr(sx + 30, baseY + 60, 40, 40, 10);
        ctx.clip();
        ctx.drawImage(img, sx + 30, baseY + 60, 40, 40);
        ctx.restore();
        ctx.fillStyle = row === 0 ? 'rgba(33,26,19,0.72)' : 'rgba(255,255,255,0.78)';
        ctx.font = '600 21px "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillText('岗位测评', sx + 82, baseY + 86);
      }
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = urls[0];
  });
}

app.whenReady().then(async function () {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 400,
    height: 400,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  await win.loadURL('data:text/html,<html><body style="margin:0"></body></html>');

  const targets = [
    { size: 1024, file: 'icon-1024.png' },
    { size: 512, file: 'icon-512.png' },
    { size: 180, file: 'icon-180.png' }
  ];

  let data512 = null;
  for (const t of targets) {
    const dataUrl = await win.webContents.executeJavaScript('(' + drawFinal.toString() + ')(' + t.size + ')');
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, t.file), buf);
    if (t.size === 512) data512 = dataUrl;
    console.log('wrote', t.file, buf.length + ' bytes');
  }

  const sheet = await win.webContents.executeJavaScript(
    '(' + drawSheet.toString() + ')(' + JSON.stringify([data512]) + ')'
  );
  fs.writeFileSync(path.join(OUT, 'icon-preview.png'), Buffer.from(sheet.split(',')[1], 'base64'));
  console.log('wrote icon-preview.png');

  app.quit();
}).catch(function (error) {
  console.error('ICON_ERROR', error && error.stack ? error.stack : error);
  app.exit(1);
});
