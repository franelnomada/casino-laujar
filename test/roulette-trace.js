// Traza de la fisica: imprime rotacion, bola y estado cada 100 ms.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-rl-prof-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-rl-data-'));
  process.env.USERS_FILE = path.join(dataDir, 'users.json');
  const { server } = require('../server.js');
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run',
    // Sin esto headless estrangula rAF y timers: el giro no avanza a 60 fps.
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=900,1000',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = fs.readFileSync(portFile, 'utf8').split('\n')[0]; }
      catch (e) { if (!['ENOENT', 'EBUSY'].includes(e.code)) throw e; }
      if (!port) await wait(100);
    }
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
    const page = pages.find(p => p.type === 'page' && p.url === 'about:blank');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0; const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq; pending.set(id, m => m.error ? rej(m.error) : res(m.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const js = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    for (let i = 0; i < 120; i++) { if (await js('typeof RouletteWheel !== "undefined" && typeof Net !== "undefined"')) break; await wait(100); }
    await js(`Net.quickStart('roulette')`);
    for (let i = 0; i < 150; i++) {
      if (await js(`!document.getElementById('screen-room').classList.contains('hidden') && Net.state && Net.state.game==='roulette' && RouletteWheel.mounted`)) break;
      await wait(100);
    }
    await wait(400);

    // Instrumenta: marca el instante de la llamada y traza durante 8 s.
    await js(`window.__log=[]; window.__t0=performance.now(); window.__frames=0;
      (function tick(){ window.__frames++; requestAnimationFrame(tick); })();
      window.__iv=setInterval(()=>{ const s=RouletteWheel.spin;
        __log.push({t:Math.round(performance.now()-__t0),
          rot:+RouletteWheel.rotation.toFixed(1), ball:+RouletteWheel.ballAngle.toFixed(1),
          r:+RouletteWheel.ballRadius.toFixed(1), spin:!!s,
          dur:s&&s.dur, el:s&&Math.round(s.elapsed), srv:Net.state&&Net.state.lastNumber}); },100); true`);
    await js(`Net.rlBet('red')`);
    await wait(300);
    await js(`Net.rlSpin()`);
    for (let i = 0; i < 90; i++) { if (!(await js('RouletteWheel.isSpinning()'))) break; await wait(100); }
    await wait(200);
    const log = await js('JSON.stringify(window.__log)');
    const rows = JSON.parse(log);
    for (const r of rows) console.log(String(r.t).padStart(5), 'rot', String(r.rot).padStart(9), 'ball', String(r.ball).padStart(7), 'r', String(r.r).padStart(6), r.spin ? ('girando dur=' + r.dur + ' t=' + r.el) : 'parado', 'srv=' + r.srv);
    console.log('frames rAF:', await js('window.__frames'), '| servidor:', await js('Net.state.lastNumber'), '| sector:', await js('RouletteWheel.currentNumber()'));
  } finally {
    try { ws && ws.close(); } catch (e) { /* ignorar */ }
    child.kill();
    server.close();
  }
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });