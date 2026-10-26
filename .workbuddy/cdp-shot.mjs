import fs from 'fs';
const url = process.argv[2];
const out = process.argv[3] || '.workbuddy/tmp-shot.png';
const expr = process.argv[4] || '';
const ws = new WebSocket(url);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
ws.addEventListener('open', async () => {
  try {
    if (expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: false, returnByValue: true });
      console.log('EVAL:', JSON.stringify(r.result.value ?? r.result));
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('saved', out);
  } catch (e) { console.error('ERR', e.message); }
  ws.close(); process.exit(0);
});
setTimeout(() => { console.error('timeout'); process.exit(1); }, 8000);
