// Captura real de la ruleta en Chrome headless: node test/roulette-shot.js
// Abre una mesa de ruleta, gira y guarda PNG en test/shots/.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const wait = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname, 'shots');

async function main() {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-rl-prof-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-rl-data-'));
  process.env.USERS_FILE = path.join(dataDir, 'users.json');
  const { server } = require('../server.js');
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run',
    // Headless estrangula rAF/timers en segundo plano: sin esto no hay animacion.
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=900,1000',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  fs.mkdirSync(OUT, { recursive: true });
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
    let seq = 0; const pending = new Map(); const errors = [];
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
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
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
      console.log('  guardado', name);
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url });
    for (let i = 0; i < 120; i++) { if (await js('typeof RouletteWheel !== "undefined" && typeof Net !== "undefined"')) break; await wait(100); }
    console.log('ruleta cargada:', await js('typeof RouletteWheel'));

    // Sala de ruleta real contra el servidor
    await js(`Net.quickStart('roulette')`);
    for (let i = 0; i < 150; i++) {
      if (await js(`!document.getElementById('screen-room').classList.contains('hidden') && Net.state && Net.state.game==='roulette' && RouletteWheel.mounted`)) break;
      await wait(100);
    }
    await wait(600);
    console.log('estado:', await js('JSON.stringify({game:Net.state&&Net.state.game, mounted:RouletteWheel.mounted, sectores:document.querySelectorAll("#net-rl-wheel .rlw-num").length})'));
    await shot('1-reposo.png');

    // Apuesta y giro por boton: capturamos la frenada y el resultado
    await js(`Net.rlBet('red')`);
    await wait(300);
    await js(`Net.rlSpin()`);
    await wait(900);  await shot('2-acelerando.png');
    await wait(2600); await shot('3-frenando.png');
    for (let i = 0; i < 120; i++) { if (!(await js('RouletteWheel.isSpinning()'))) break; await wait(100); }
    await wait(400);
    console.log('ganador servidor:', await js('Net.state.lastNumber'),
                '| sector bajo el indicador:', await js('RouletteWheel.currentNumber()'));
    await shot('4-resultado.png');

    console.log('errores de consola:', errors.length ? errors : 'ninguno');
  } finally {
    try { ws && ws.close(); } catch (e) { /* ignorar */ }
    child.kill();
    server.close();
  }
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
