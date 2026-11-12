'use strict';
/**
 * 背景图管线冒烟：压缩（长边 2560 / JPEG 与 PNG 取小）、平均亮度、落盘路径、丢失判定。
 * 用法：node scripts/smoke-theme-image.js（内部用 electron 起主进程，nativeImage 只在 Electron 里可用）
 *
 * 为什么不放进 verify-appearance.js：那个脚本走 CDP 打渲染层，选图是原生对话框，自动化点不到；
 * 这一层是纯主进程能力，用临时目录 + 假 db 直接测更快也更准。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), `knodo-theme-img-${Date.now()}`);

const script = `
'use strict';
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const out = [];
const ok = (name, pass, extra) => { out.push({ name, pass: !!pass }); console.log((pass ? 'OK ' : 'BAD ') + name + (extra == null ? '' : '  ' + extra)); };

app.whenReady().then(() => {
  const tmp = ${JSON.stringify(tmp)};
  fs.mkdirSync(tmp, { recursive: true });
  const attachments = require(${JSON.stringify(path.join(root, 'main', 'attachments.js'))});
  const theme = require(${JSON.stringify(path.join(root, 'main', 'theme.js'))});
  attachments.init(tmp);
  theme.init({ attachments });

  // 造一张 3000×1200 的「照片」：随机噪点 + 上亮下暗，模拟真实壁纸
  const w = 3000, h = 1200;
  const buf = Buffer.alloc(w * h * 4);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < h; y++) {
    const v = 90 + Math.round((1 - y / h) * 120);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = Math.round(rnd() * 30);
      buf[i] = Math.max(0, v - n);       // B
      buf[i + 1] = Math.max(0, v - n + 6); // G
      buf[i + 2] = Math.max(0, v - n + 14); // R
      buf[i + 3] = 255;
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: w, height: h });
  const src = path.join(tmp, 'wall.png');
  fs.writeFileSync(src, img.toPNG());
  const srcKB = Math.round(fs.statSync(src).size / 1024);

  const enc = theme._encodeImage(src);
  ok('长边压到 2560 以内', Math.max(enc.width, enc.height) <= 2560, enc.width + 'x' + enc.height);
  ok('选择更小的编码（噪点大图应走 jpg 或高质量 png）', enc.buffer.length > 0 && enc.buffer.length < fs.statSync(src).size, enc.ext + ' ' + Math.round(enc.buffer.length / 1024) + 'KB ← ' + srcKB + 'KB');
  ok('平均亮度落在合理区间', enc.luma > 0.2 && enc.luma < 0.8, enc.luma.toFixed(3));

  // 落盘 + 读写
  const dir = path.join(tmp, 'theme');
  fs.mkdirSync(dir, { recursive: true });
  const name = 'bg-' + Date.now() + '.' + enc.ext;
  fs.writeFileSync(path.join(dir, name), enc.buffer);
  const store = { theme: 'system' };
  const db = { getSetting: (k, d) => (store[k] != null ? store[k] : d), setSetting: (k, v) => { store[k] = v; } };

  let t = theme.write(db, { backdrop: { type: 'image', image: 'theme/' + name, luma: 0.4, opacity: 65 } });
  ok('写库后读到图片路径', t.backdrop.image === 'theme/' + name, t.backdrop.image);
  ok('文件存在时不判丢失', t.backdrop.missing === false);
  ok('透明度按 5 取整', t.backdrop.opacity === 65, t.backdrop.opacity);

  // 换风格 / 换模式不该丢背景
  t = theme.write(db, { style: 'sakura' });
  ok('换风格保留背景图', t.backdrop.image === 'theme/' + name && t.style === 'sakura');

  // 旧值兼容
  store.theme = 'dark';
  const legacy = theme.read(db);
  ok('旧值 "dark" 迁移为对象（风格落出厂默认宣纸）', legacy.mode === 'dark' && legacy.style === 'sepia' && legacy.backdrop.type === 'none', JSON.stringify(legacy));

  // 丢失判定
  fs.unlinkSync(path.join(dir, name));
  t = theme.write(db, { backdrop: { type: 'image', image: 'theme/' + name } });
  const after = theme.read(db);
  ok('文件被删后回退纯色并标 missing', after.backdrop.missing === true && after.backdrop.type === 'none');

  // 恢复默认会删文件
  fs.writeFileSync(path.join(dir, name), enc.buffer);
  theme.write(db, { backdrop: { type: 'image', image: 'theme/' + name } });
  theme.reset(db);
  ok('恢复默认清空背景', theme.read(db).backdrop.image === '' && !fs.existsSync(path.join(dir, name)));

  const bad = out.filter((r) => !r.pass);
  console.log(bad.length ? 'IMAGE_FAIL ' + bad.map((b) => b.name).join(';') : 'IMAGE_OK');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(bad.length ? 1 : 0);
}).catch((e) => { console.log('IMAGE_FAIL ' + e.message); app.exit(1); });
`;

fs.mkdirSync(tmp, { recursive: true });
const file = path.join(tmp, 'run.js');
fs.writeFileSync(file, script);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electronBin = require('electron');
const child = spawn(electronBin, [file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (b) => { log += b.toString(); });
child.stderr.on('data', (b) => { log += b.toString(); });
child.on('close', (code) => {
  process.stdout.write(log);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (!/IMAGE_OK/.test(log)) {
    console.log(`\n✗ 背景图管线未通过（code=${code}）`);
    process.exit(1);
  }
  console.log('\n✓ 背景图管线通过');
  process.exit(0);
});
