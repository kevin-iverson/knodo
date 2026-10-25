'use strict';
/**
 * 打包产物体检脚本（开发辅助，非应用运行时依赖）。
 *
 * 用法：先给已打包的应用开远程调试端口，例如
 *   dist\win-unpacked\Knodo.exe --remote-debugging-port=9333
 * 然后：
 *   node scripts/check-packaged.js [port]
 *
 * 通过 CDP 检查：渲染进程有无 JS 异常、界面是否渲染出数据、
 * 以及主进程（SQLite / IPC）能否返回任务数据。
 */
const port = process.argv[2] || '9333';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到渲染进程页面，应用可能未正常启动');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const errors = [];
  let nextId = 1;

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(method + ' 超时')), 15000);
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  await send('Runtime.enable');
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.text + ' ' + (d.exception && d.exception.description || ''));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  await sleep(2500); // 给渲染进程一点时间跑首屏

  const expr = `JSON.stringify({
    标题: document.getElementById('view-title').textContent,
    分组数: document.querySelectorAll('#group-list li').length,
    标签数: document.querySelectorAll('#tag-list li').length,
    列表节点数: document.querySelector('#view').children.length,
    任务行: document.querySelectorAll('.task-row, .task-item').length
  })`;
  const dom = await send('Runtime.evaluate', { expression: expr, returnByValue: true });

  console.log('页面标题:', page.title);
  console.log('页面地址:', page.url);
  console.log('DOM 快照:', dom.result.value);
  console.log('渲染层异常:', errors.length ? errors : '无');

  // 主进程数据链路：preload 通过 contextBridge 暴露 window.api，这里抽检一个真实的 IPC 调用
  const apiExpr = `(async () => {
     const api = window.api;
     if (!api) return 'NO_API：preload 未注入';
     const names = Object.keys(api);
     if (typeof api.listTasks !== 'function') return '接口清单: ' + names.slice(0, 12).join(', ');
     try {
       const r = await api.listTasks({});
       const n = Array.isArray(r) ? r.length : (r && r.tasks && r.tasks.length);
       return '接口数 ' + names.length + '；listTasks 返回 ' + n + ' 条';
     } catch (e) { return 'ERR:' + e.message; }
   })()`;
  const apiRes = await send('Runtime.evaluate', {
    expression: apiExpr,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('数据链路:', apiRes.result.value || apiRes.exceptionDetails?.text || '(未暴露 window.api)');

  ws.close();
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error('体检失败:', e.message);
  process.exit(1);
});
