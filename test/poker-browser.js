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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-poker-data-'));
  process.env.USERS_FILE = path.join(dataDir, 'users.json'); // antes de cargar el servidor
  const { server } = require('../server.js'); // servidor real: estáticos + API (cuentas y salas)
  const child = spawn(chrome, ['--headless=new','--disable-gpu','--no-first-run',
    '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:'ignore'});
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
    // Cuentas de jugador: tarjeta de acceso, pestañas, modal y sesión simulada
    await js(`App.show('welcome')`); // la tarjeta de acceso vive en el welcome
    assert.equal(await js(`document.querySelectorAll('.auth-card').length`),1);
    assert.equal(await js(`document.getElementById('screen-welcome').classList.contains('hidden')`),false,'El welcome debe verse al arrancar');
    assert.equal(await js(`document.getElementById('auth-tab-login').classList.contains('active')`),true,'Entrar activo por defecto');
    assert.equal(await js(`document.getElementById('auth-password2').classList.contains('hidden')`),true,'La repetición solo sale al crear cuenta');
    await js(`Auth.showForm('register')`);
    assert.equal(await js(`document.getElementById('auth-tab-register').classList.contains('active')`),true);
    assert.equal(await js(`document.getElementById('auth-password2').classList.contains('hidden')`),false);
    assert.match(await js(`document.getElementById('auth-submit').textContent`),/Crear cuenta/);
    // Contraseñas distintas: se avisa sin llamar al servidor
    await js(`document.getElementById('auth-name').value='Ana';document.getElementById('auth-password').value='secreta1';document.getElementById('auth-password2').value='secreta2';`);
    await js(`Auth.submit(null)`);
    assert.equal(await js(`document.getElementById('auth-message').textContent`),'Las contraseñas no coinciden.');
    assert.equal(await js(`document.getElementById('auth-message').classList.contains('error')`),true);
    assert.equal(await js(`Auth.user===null`),true,'Sin cuenta: sigue como invitado');
    await js(`Auth.showForm('login')`);
    assert.equal(await js(`document.getElementById('auth-submit').textContent`),'Entrar');
    assert.equal(await js(`document.getElementById('auth-password2').classList.contains('hidden')`),true);
    // Topbar y modal de invitado
    assert.match(await js(`document.getElementById('auth-topbar').textContent`),/Invitado/);
    await js(`Auth.openPanel()`);
    assert.equal(await js(`document.getElementById('account-modal').classList.contains('hidden')`),false,'El modal de cuenta debe abrirse');
    assert.equal(await js(`document.getElementById('account-guest').classList.contains('hidden')`),false);
    assert.equal(await js(`document.getElementById('account-user').classList.contains('hidden')`),true);
    await js(`Auth.closePanel()`);
    assert.equal(await js(`document.getElementById('account-modal').classList.contains('hidden')`),true);
    // Registro real contra la API: cuenta creada, token guardado y fichas en el servidor
    const user = 'E2E' + Date.now().toString().slice(-6);
    await js(`Auth.showForm('register');document.getElementById('auth-name').value='${user}';document.getElementById('auth-password').value='secreta1';document.getElementById('auth-password2').value='secreta1'`);
    await js(`Auth.submit(null)`);
    assert.equal(await js(`Auth.user && Auth.user.name`),user,'La cuenta debe crearse en el servidor');
    assert.equal(await js(`Auth.token.length > 20`),true);
    assert.equal(await js(`localStorage.getItem(Auth.KEY) === Auth.token`),true,'El token se guarda en el móvil');
    const chipCount = await js(`Auth.user.chips`);
    assert.equal(await js(`Number(document.getElementById('chips-amount').textContent.replace(/[^0-9]/g,''))`),chipCount,'Las fichas mostradas son las de la cuenta');
    assert.match(await js(`document.getElementById('auth-message').textContent`),/Cuenta creada/);
    const me = await (await fetch(url+'/api/auth/me',{headers:{Authorization:'Bearer '+await js('Auth.token')}})).json();
    assert.equal(me.user.name,user,'El servidor reconoce el token del navegador');
    // Recargar: la sesión se recupera sola y las fichas siguen ahí
    await send('Page.navigate',{url});
    for(let i=0;i<100;i++){ if(await js('window.Auth && !!Auth.user')) break; await wait(100); }
    assert.equal(await js(`Auth.user && Auth.user.name`),user,'La sesión debe recuperarse al recargar');
    assert.equal(await js(`Number(document.getElementById('chips-amount').textContent.replace(/[^0-9]/g,''))`),chipCount);
    assert.equal(await js(`document.getElementById('net-name').value`),user,'El nombre de la cuenta rellena la sala');
    // Cerrar sesión: vuelve a invitado y borra el token del móvil
    await js(`Auth.logout()`);
    assert.equal(await js(`Auth.user === null && localStorage.getItem(Auth.KEY) === null`),true,'Cerrar sesión limpia el token');
    assert.match(await js(`document.getElementById('auth-topbar').textContent`),/Invitado/);
    assert.equal(await js(`Number(document.getElementById('chips-amount').textContent.replace(/[^0-9]/g,''))`),chipCount,'Al salir se conservan las fichas del móvil');
    // Sesión simulada: nombre y fichas de la cuenta en toda la interfaz
    await js(`Auth.applyUser({name:'Ana',chips:2500});Auth.openPanel()`);
    assert.equal(await js(`document.getElementById('auth-topbar').textContent`),'👤 Ana');
    assert.equal(await js(`Number(document.getElementById('chips-amount').textContent.replace(/[^0-9]/g,''))`),2500);
    assert.equal(await js(`document.getElementById('account-guest').classList.contains('hidden')`),true);
    assert.equal(await js(`document.getElementById('account-user').classList.contains('hidden')`),false);
    assert.equal(await js(`document.getElementById('account-name').textContent`),'Ana');
    await js(`document.getElementById('net-name').value='';document.getElementById('bj-name-input').value='';Auth.prefillNames('Bea')`);
    assert.equal(await js(`document.getElementById('net-name').value+'/'+document.getElementById('bj-name-input').value`),'Bea/Bea','El nombre de la cuenta se reutiliza en las mesas');
    // Salir de la cuenta: vuelve a invitado y conserva las fichas del móvil
    await js(`Auth.forget()`);
    assert.match(await js(`document.getElementById('auth-topbar').textContent`),/Invitado/);
    assert.equal(await js(`Number(document.getElementById('chips-amount').textContent.replace(/[^0-9]/g,''))`),2500);
    assert.equal(await js(`document.getElementById('account-guest').classList.contains('hidden')`),false);
    await js(`Auth.closePanel();App.chips=1000;App.updateChips();App.show('lobby')`);
    // El botón de cuenta no puede desbordar el topbar en móviles pequeños
    for (const width of [320,390,768]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<760});
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true,'Topbar sin desbordamiento a '+width);
      assert.equal(await js(`document.getElementById('auth-topbar').getBoundingClientRect().right <= innerWidth`),true,'Botón de cuenta dentro de pantalla a '+width);
    }
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    // Ranking del lobby: nombres y fichas, fila propia resaltada, botón de recarga y sin desbordes
    await js(`App.show('lobby')`);
    for(let i=0;i<100;i++){ if(await js(`document.querySelectorAll('#rank-list .rank-row').length > 0`)) break; await wait(100); }
    assert.ok(await js(`document.querySelectorAll('#rank-list .rank-row').length > 0`),'El ranking debe listar las cuentas');
    assert.ok(await js(`[...document.querySelectorAll('#rank-list .rank-name')].some(n=>n.textContent==='${user}')`),'La cuenta creada aparece en el ranking');
    assert.equal(await js(`document.querySelectorAll('#rank-list .rank-row.me').length`),0,'Sin sesión no se resalta a nadie');
    await js(`Auth.applyUser({name:'${user}',chips:${chipCount}});Auth.highlightBoard()`);
    assert.equal(await js(`document.querySelectorAll('#rank-list .rank-row.me').length`),1,'La fila propia se resalta con la cuenta');
    assert.match(await js(`document.querySelector('#rank-list .rank-row.me .rank-you').textContent`),/tú/);
    await js(`Auth.forget();Auth.highlightBoard()`);
    assert.equal(await js(`document.querySelectorAll('#rank-list .rank-row.me').length`),0,'Al salir se quita el resaltado');
    await js(`Auth.loadLeaderboard(true)`);
    for(let i=0;i<100;i++){ if(await js(`document.querySelectorAll('#rank-list .rank-row').length > 0`)) break; await wait(100); }
    assert.ok(await js(`document.querySelectorAll('#rank-list .rank-row').length > 0`),'El botón Actualizar recarga el ranking');
    for (const width of [320,390,768]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<760});
      await js(`App.show('lobby')`);
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true,'Ranking sin desbordamiento a '+width);
    }
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    console.log('✅ Chrome: ranking — nombres, fichas, fila propia y recarga sin desbordes');
    console.log('✅ Chrome: cuentas — tarjeta de acceso, pestañas, modal, invitado y sesión simulada');
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
    assert.match(await js(`document.getElementById('pk-private-hand').textContent`), /^Tu mano: (Pareja|Carta alta) · Solo tú$/);
    for(const width of [320,390,768,1100]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<760});
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true,'Desbordamiento a '+width);
      const overlap=await js(`(()=>{const r=[...document.querySelectorAll('.pk-seat')].map(n=>n.getBoundingClientRect());return r.some((a,i)=>r.some((b,j)=>j>i&&a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom));})()`);
      assert.equal(overlap,false,'Asientos superpuestos a '+width+' '+JSON.stringify(await js(`[...document.querySelectorAll('.pk-seat')].map(n=>({class:n.className,x:n.offsetLeft,y:n.offsetTop,w:n.offsetWidth,h:n.offsetHeight}))`)));
      const covers=await js(`(()=>{const c=document.querySelector('.pk-controls').getBoundingClientRect();return [...document.querySelectorAll('.pk-seat')].some(n=>{const b=n.getBoundingClientRect();return b.left<c.right&&c.left<b.right&&b.top<c.bottom&&c.top<b.bottom;});})()`);
      assert.equal(covers,false,'Los controles tapan asientos a '+width);
    }
    const hintRoom = new PokerRoom('HINT');
    hintRoom.addPlayer('a','Ana'); hintRoom.addPlayer('b','Bob');
    const cards = text => text.split(' ').map(x => ({rank:x.slice(0,-1),suit:x.slice(-1)}));
    hintRoom.phase='flop'; hintRoom.handNo=1;
    hintRoom.players.forEach(p=>p.inHand=true);
    hintRoom.find('a').hand=cards('A♠ K♠'); hintRoom.find('b').hand=cards('2♥ 2♦');
    hintRoom.board=cards('Q♠ J♠ 10♠');
    const future=Date.now()+60000;
    hintRoom.events=hintRoom.board.map((c,index)=>({type:'board',target:'board',index,at:future+index*1000,duration:1000}));
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await js(`Poker.reset();Net.playerId='a';Net.state=${JSON.stringify(hintRoom.stateFor('a'))};Net.render();`);
    assert.equal(await js(`Poker.el('private-hand').textContent`),'Tu mano: Carta alta · Solo tú');
    await js(`Poker.offset+=65000;Poker.update()`);
    assert.equal(await js(`Poker.el('private-hand').textContent`),'Tu mano: Escalera de color · Solo tú');
    hintRoom.events=[];
    await js(`Poker.reset();Net.playerId='b';Net.state=${JSON.stringify(hintRoom.stateFor('b'))};Net.render();`);
    assert.equal(await js(`Poker.el('private-hand').textContent`),'Tu mano: Pareja · Solo tú');
    assert.equal(await js(`document.querySelector('#pk-phase').nextElementSibling.id`),'pk-private-hand');
    assert.deepEqual(errors,[]);
    await js('Poker.reset()');
    assert.equal(await js(`Poker.el('private-hand').textContent`),'');
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
    await fs.promises.rm(dataDir,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
