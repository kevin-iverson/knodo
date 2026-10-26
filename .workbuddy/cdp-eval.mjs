import fs from 'fs';
const url = process.argv[2];
const expr = process.argv[3];
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
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    console.log('EVAL:', JSON.stringify(r.result.value ?? r.result, null, 1).slice(0, 2000));
    if (r.exceptionDetails) console.log('EXC:', JSON.stringify(r.exceptionDetails).slice(0,500));
  } catch (e) { console.error('ERR', e.message); }
  ws.close(); process.exit(0);
});
setTimeout(() => { console.error('timeout'); process.exit(1); }, 10000);
