const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.disableHardwareAcceleration();

const HTML = 'D:/WorkBuddyWorkSpace/todo-app/minitools/personality-job/index.html';
const OUT = 'D:/WorkBuddyWorkSpace/todo-app/minitools/promo/shots';

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function capture(win, name) {
  win.webContents.invalidate();
  await delay(600);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name + '.png'), image.toPNG());
  console.log('captured', name, image.getSize());
}

app.whenReady().then(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 390,
    height: 600,
    useContentSize: true,
    frame: false,
    show: false,
    backgroundColor: '#f2ece2',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.showInactive();
  win.setContentSize(390, 844);

  win.webContents.on('console-message', function (event, level, message) {
    if (level >= 2) console.log('PAGE_CONSOLE[' + level + ']', message.split('\n')[0]);
  });

  await win.loadFile(HTML);
  win.showInactive();
  await delay(800);

  await win.webContents.executeJavaScript(
    "var h=document.getElementById('storageHint'); if(h){h.hidden=true;}" +
    "var r=document.getElementById('btnResume'); if(r){r.hidden=true;}"
  );
  await delay(200);
  await capture(win, 'start');

  await win.webContents.executeJavaScript("document.getElementById('btnStart').click();");
  await delay(500);
  await capture(win, 'quiz');

  for (let i = 0; i < 10; i++) {
    const has = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#options .option').length"
    );
    if (!has) break;
    await win.webContents.executeJavaScript(
      "var o=document.querySelectorAll('#options .option'); if(o[2]){o[2].click();} else if(o[0]){o[0].click();}"
    );
    await delay(300);
  }

  await delay(700);
  await win.webContents.executeJavaScript(
    "document.getElementById('stage').scrollTop=0;" +
    "var a=document.querySelector('#screenResult .actions'); if(a){a.style.display='none';}" +
    "var f=document.querySelector('#screenResult .fineprint'); if(f){f.style.marginTop='26px';}"
  );
  await delay(300);
  await capture(win, 'result');

  const summary = await win.webContents.executeJavaScript(
    "JSON.stringify({name:document.getElementById('resultName').textContent," +
    "jobs:document.getElementById('jobs').textContent," +
    "dims:document.getElementById('dims').children.length," +
    "filled:[].map.call(document.querySelectorAll('.dim-fill'),function(e){return e.style.width;})," +
    "active:document.querySelector('.screen.is-active').id})"
  );
  console.log('RESULT_SUMMARY', summary);

  await delay(200);
  app.quit();
}).catch(function (error) {
  console.error('CAPTURE_ERROR', error && error.stack ? error.stack : error);
  app.exit(1);
});
