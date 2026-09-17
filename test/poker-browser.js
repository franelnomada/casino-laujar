// Prueba visual opcional: node test/poker-browser.js (Node >=22 y Chrome local).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { PokerRoom } = require('../js/poker-engine');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-poker-test-'));
  const child = spawn(chrome, ['--headless=new','--disable-gpu','--no-first-run',
    '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:'ignore'});
  const server = require('node:http').createServer((req, res) => {
    const file = path.join(__dirname, '..', req.url === '/' ? 'index.html' : req.url);
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port;
    for(let i=0;i<100&&!port;i++) {
      try { port = fs.readFileSync(portFile,'utf8').split('\n')[0]; }
      catch(error) { if(!['ENOENT','EBUSY'].includes(error.code)) throw error; }
      if(!port) await wait(100);
    }
    assert.ok(port, 'Chrome no publicó su puerto de depuración');
    const pages = await (await fetch('http://127.0.0.1:'+port+'/json')).json();
    const page = pages.find(page => page.type === 'page' && page.url === 'about:blank');
    assert.ok(page, 'Chrome debe ofrecer la pestaña de prueba about:blank');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let seq=0;const pending=new Map();const errors=[];
    ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,m=>m.error?reject(m.error):resolve(m.result));ws.send(JSON.stringify({id,method,params}));});
    const js=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;};
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url});
    for(let i=0;i<100;i++){if(await js('typeof Poker !== "undefined" && typeof Net !== "undefined"'))break;await wait(100);}
    assert.equal(await js('typeof Net'), 'object', JSON.stringify(await js('({url:location.href,ready:document.readyState,scripts:[...document.scripts].map(s=>s.src),body:document.body.innerText.slice(0,1500)})')) + JSON.stringify(errors));
    assert.equal(await js(`Net.openCreate('poker'); document.getElementById('net-game').value`),'poker');
    assert.equal(await js(`getComputedStyle(document.getElementById('net-poker-options')).display !== 'none'`),true);
    const room=new PokerRoom('VIEW');for(let i=0;i<6;i++)room.addPlayer('p'+i,'Colega '+i);
    room.start('p0');
    const render=()=>js(`App.show('room'); Net.playerId='p3';Net.state=${JSON.stringify(room.stateFor('p3'))};Net.render();`);
    await render();
    assert.equal(await js('Poker.nodes.size'),12);
    assert.equal(await js(`document.querySelectorAll('#pk-seats .face-down').length`),12);
    assert.equal(await js(`Math.round(document.getElementById('pk-shoe').getBoundingClientRect().height)>40`),true);
    await js('window.firstCard = document.querySelector("#pk-seats .pk-card")');
    await render();
    assert.equal(await js('firstCard === document.querySelector("#pk-seats .pk-card")'),true);
    await wait(11000);
    assert.equal(await js(`document.querySelectorAll('#pk-seats .face-down').length`),10);
    assert.equal(await js('Poker.animations.size'),0);
    await render();
    assert.equal(await js('Poker.animations.size'),0);
    for(const width of [320,390,768,1100]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<760});
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true,'Desbordamiento a '+width);
      const overlap=await js(`(()=>{const r=[...document.querySelectorAll('.pk-seat')].map(n=>n.getBoundingClientRect());return r.some((a,i)=>r.some((b,j)=>j>i&&a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom));})()`);
      assert.equal(overlap,false,'Asientos superpuestos a '+width+' '+JSON.stringify(await js(`[...document.querySelectorAll('.pk-seat')].map(n=>({class:n.className,x:n.offsetLeft,y:n.offsetTop,w:n.offsetWidth,h:n.offsetHeight}))`)));
    }
    assert.deepEqual(errors,[]);
    await js('Poker.reset()');
    console.log('✅ Chrome: selector, 6 asientos a 320/390/768/1100 px, privacidad, reparto y nodos persistentes');
  } finally {
    // Cerrar Chrome antes de borrar su perfil: Windows bloquea archivos en uso.
    const exited = new Promise(resolve => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({id:999999,method:'Browser.close'}));
      ws.onmessage = () => {};
    } else child.kill();
    await Promise.race([exited, wait(3000)]);
    if (child.exitCode === null) { child.kill(); await Promise.race([exited, wait(1000)]); }
    if(ws)ws.close();
    server.closeAllConnections(); server.close();
    await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
