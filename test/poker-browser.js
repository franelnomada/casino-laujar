// Prueba visual opcional: node test/poker-browser.js (Node >=22 y Chrome local).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { PokerRoom } = require('../js/poker-engine');
const { BlackjackRoom } = require('../js/bj-engine');
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
    // Juegos: las tarjetas grandes abren mesa y el resto del lobby queda debajo.
    await js(`App.goLobby();[...document.querySelectorAll('.portal-card')].find(card => card.getAttribute('onclick').includes("openLobbySection('games')")).click()`);
    const gamesUi = await js(`(() => {
      const section = document.getElementById('lobby-section-games');
      const cards = [...section.querySelectorAll('.game-card')];
      const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {
        names: cards.map(card => card.querySelector('h2').textContent),
        calls: cards.map(card => card.getAttribute('onclick')),
        visible: cards.every(card => getComputedStyle(card).display !== 'none' && card.getBoundingClientRect().height >= 150),
        order: follows(section.querySelector('.games-grid'), section.querySelector('.join-code-box')) &&
          follows(section.querySelector('.join-code-box'), section.querySelector('.open-rooms-box')),
        noOldHeading: !section.textContent.includes('Multijugador online'),
        noGameSelect: !section.querySelector('select#net-game'),
        noOpenButton: ![...section.querySelectorAll('button')].some(button => button.textContent.includes('Abrir mesa')),
        nameInTopbar: !!document.querySelector('#topbar #net-name'),
        resumeInTopbar: !!document.querySelector('#topbar #net-resume')
      };
    })()`);
    assert.deepEqual(gamesUi.names,['Blackjack','Ruleta Europea','Póker online','Book of Fran']);
    assert.deepEqual(gamesUi.calls,["Net.quickStart('blackjack')","Net.quickStart('roulette')","Net.quickStart('poker')","Net.quickStart('book-of-fran')"]);
    assert.equal(gamesUi.visible,true,'Las cuatro tarjetas deben verse antes de las demás opciones');
    assert.equal(gamesUi.order,true,'Tarjetas, código y salas deben conservar ese orden');
    assert.equal(gamesUi.noOldHeading,true);
    assert.equal(gamesUi.noGameSelect,true);
    assert.equal(gamesUi.noOpenButton,true);
    assert.equal(gamesUi.nameInTopbar,true);
    assert.equal(gamesUi.resumeInTopbar,true);
    for (const [index, game] of ['blackjack','roulette','poker','book-of-fran'].entries()) {
      await js(`App.openLobbySection('games');document.querySelectorAll('.game-card')[${index}].click()`);
      for(let i=0;i<100;i++){if(await js(`!document.getElementById('screen-room').classList.contains('hidden') && Net.code`))break;await wait(100);}
      assert.equal(await js('document.getElementById(' + JSON.stringify('net-game') + ').value'),game,'La tarjeta debe abrir '+game);
      if (game === 'book-of-fran') {
        for(let i=0;i<100;i++){if(await js(`document.querySelectorAll('#bof-reels .bof-reel').length === 5`))break;await wait(100);}
        const slotUi = await js(`({reels:document.querySelectorAll('#bof-reels .bof-reel').length,symbols:document.querySelectorAll('#bof-reels .bof-symbol').length,lines:document.getElementById('bof-lines-select').options.length,pots:document.querySelectorAll('.bof-jackpot-pot').length,pool:Net.state.jackpot.jackpotPool,values:Net.state.jackpot.values})`);
        assert.equal(slotUi.reels,5,'Book de Fran muestra una rejilla 5x3');
        assert.equal(slotUi.symbols,15,'Book de Fran muestra 15 símbolos');
        assert.equal(slotUi.lines,10,'Book de Fran permite activar 10 líneas');
        assert.equal(slotUi.pots,3,'El marcador muestra Bronze, Silver y Gold');
        assert.deepEqual(slotUi.values,{BRONZE:Math.round(slotUi.pool*.10),SILVER:Math.round(slotUi.pool*.20),GOLD:Math.round(slotUi.pool*.70)},'Los tres montones muestran sus porcentajes del bote compartido');
        for (const viewport of [{width:1920,height:1080},{width:1366,height:768},{width:390,height:844}]) {
          await send('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<600});
          await wait(100);
          const fit = await js(`(()=>{const screen=document.getElementById('screen-room'),machine=document.getElementById('bof-machine'),chat=document.getElementById('net-chat'),spin=document.getElementById('bof-spin'),lines=document.getElementById('bof-lines-select');const rect=machine.getBoundingClientRect();return {innerHeight,docScroll:document.documentElement.scrollHeight,bodyScroll:document.body.scrollHeight,screenScroll:screen.scrollHeight,screenClient:screen.clientHeight,machineTop:Math.round(rect.top),machineBottom:Math.round(rect.bottom),chatDisplay:getComputedStyle(chat).display,controlsInside:machine.contains(spin)&&machine.contains(lines)};})()`);
          assert.ok(fit.docScroll<=viewport.height+1 && fit.bodyScroll<=viewport.height+1,`Book of Fran no genera scroll vertical en ${viewport.width}x${viewport.height}: ${JSON.stringify(fit)}`);
          assert.ok(fit.screenScroll<=fit.screenClient+1,`La sala no tiene overflow vertical en ${viewport.width}x${viewport.height}: ${JSON.stringify(fit)}`);
          assert.ok(fit.machineTop>=0 && fit.machineBottom<=viewport.height+1,`La máquina cabe completa en ${viewport.width}x${viewport.height}: ${JSON.stringify(fit)}`);
          assert.equal(fit.chatDisplay,'none','El chat no se muestra en Book of Fran');
          assert.equal(fit.controlsInside,true,'Los mandos están integrados dentro de la máquina');
        }
        await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
        const nearMiss = await js(`(async()=>{
          const originalAction=Net.action, originalRandom=Math.random, originalCounter=Net.slotSpinsSinceNearMiss;
          const source=Net.state, me=source.players.find(p=>p.id===Net.playerId);
          const realGrid=Array.from({length:5},()=>['9','J','Q']);
          const realResult={spinId:(me.lastResult?.spinId||0)+1,grid:realGrid,rawGrid:realGrid,expandedReels:[],lines:[],win:0,bookCount:2,awarded:0,expandedSymbol:null,mode:'normal',activeLines:1,betPerLine:5,totalBet:5,freeSpinsRemaining:0,bonusWinTotal:0,bonusStarted:false,bonusEnded:false,jackpotContribution:1,jackpotPick:false,bigWin:false};
          const chipsBefore=me.chips, fakeResponse={...source,version:source.version+1,players:[{...me,chips:chipsBefore-5,lastResult:realResult}]};
          Net.action=async()=>{Net.state=fakeResponse;Net.version=fakeResponse.version;return fakeResponse;};
          Math.random=()=>0;Net.slotSpinsSinceNearMiss=5;
          window.__nearMissSeen=false;
          const observer=new MutationObserver(()=>{if(document.querySelector('#bof-reels .is-near-miss-book'))window.__nearMissSeen=true;});
          observer.observe(document.getElementById('bof-reels'),{subtree:true,attributes:true,childList:true});
          const outcome=await Net.slotSpin();
          observer.disconnect();
          const shown=Array.from(document.querySelectorAll('#bof-reels .bof-reel')).map(reel=>[...reel.querySelectorAll('.bof-symbol')].map(symbol=>symbol.textContent));
          const realShown=realGrid.map((reel,reelIndex)=>reel.map((id,row)=>source.symbols.find(symbol=>symbol.id===id)?.glyph||'·')).flat();
          const finalShown=shown.flat();
          const bonusDecision=(Net.slotSpinsSinceNearMiss=5,Net.slotShouldUseNearMiss({...realResult,bookCount:3,awarded:10,bonusStarted:true}));
          const winDecision=(Net.slotSpinsSinceNearMiss=5,Net.slotShouldUseNearMiss({...realResult,win:1}));
          const cooldownDecision=(Net.slotSpinsSinceNearMiss=0,Net.slotShouldUseNearMiss(realResult));
          Net.action=originalAction;Math.random=originalRandom;Net.slotSpinsSinceNearMiss=originalCounter;Net.state=source;Net.render();
          return {nearMiss:outcome.nearMiss,fakeSeen:window.__nearMissSeen,finalReal:JSON.stringify(finalShown)===JSON.stringify(realShown),economicUnchanged:outcome.result.win===0&&fakeResponse.players[0].lastResult.win===0&&fakeResponse.players[0].chips===chipsBefore-5,bonusDecision,winDecision,cooldownDecision};
        })()`);
        assert.equal(nearMiss.nearMiss,true,'El near-miss se activa con resultado perdedor sin bonus');
        assert.equal(nearMiss.fakeSeen,true,'Los reels muestran temporalmente el libro visual');
        assert.equal(nearMiss.finalReal,true,'Al terminar se muestra exclusivamente el grid real del servidor');
        assert.equal(nearMiss.economicUnchanged,true,'El near-miss no modifica premio ni resultado económico');
        assert.equal(nearMiss.bonusDecision,false,'Un resultado real con 3 libros nunca activa near-miss');
        assert.equal(nearMiss.winDecision,false,'Una tirada ganadora no activa near-miss');
        assert.equal(nearMiss.cooldownDecision,false,'El cooldown evita near-miss consecutivos');
        await js('Net.slotLines=10;Net.slotChip=5;Net.slotBetChanged();Net.slotSpin()');
        for(let i=0;i<150;i++){if(await js('!Net.slotAnimating'))break;await wait(100);}
        const slotAfter = await js(`({busy:Net.slotAnimating,disabled:document.getElementById('bof-spin').disabled,cost:document.getElementById('bof-total-cost').textContent,result:Net.state.players.find(p=>p.id===Net.playerId).lastResult})`);
        assert.equal(slotAfter.busy,false,'La animación del giro debe terminar');
        assert.equal(slotAfter.disabled,false,'El botón debe reactivarse con saldo suficiente');
        assert.equal(slotAfter.cost,'50 fichas');
        assert.equal(slotAfter.result.activeLines,10);
        assert.equal(slotAfter.result.betPerLine,5);
        const insufficientUi = await js(`Net.state.players.find(p=>p.id===Net.playerId).chips=10;Net.slotBetChanged();({disabled:document.getElementById('bof-spin').disabled,warning:document.getElementById('bof-bet-warning').textContent})`);
        assert.equal(insufficientUi.disabled,true,'El botón se bloquea cuando líneas × apuesta supera el saldo');
        assert.match(insufficientUi.warning,/Saldo insuficiente/);
        const chestUi = await js(`(async()=>{
          window.__jackpotRealFetch=window.fetch;Auth.token='browser-jackpot-token';Auth.user={name:'Fran',chips:500};
          window.fetch=async(url,options)=>{window.__jackpotRequest=JSON.parse(options.body);return {ok:true,json:async()=>({ok:true,box:3,tier:'GOLD',value:700,boxes:[{box:1,tier:'SILVER',value:200},{box:2,tier:'BRONZE',value:100},{box:3,tier:'GOLD',value:700}],playerChips:1200,jackpot:{jackpotPool:100,seed:100,values:{BRONZE:10,SILVER:20,GOLD:70}},user:{name:'Fran',chips:1200}})};};
          Net.slotJackpotOpen();await Net.slotJackpotPick(3);
          const result={request:window.__jackpotRequest,open:document.querySelectorAll('.bof-chest.is-open').length,winner:document.querySelectorAll('.bof-chest.is-winner').length,labels:[...document.querySelectorAll('.bof-chest b')].map(x=>x.textContent),continue:!document.getElementById('bof-chest-continue').classList.contains('hidden'),pool:document.getElementById('bof-jackpot-pool').textContent};
          window.fetch=window.__jackpotRealFetch;Auth.token=null;Auth.user=null;return result;
        })()`);
        assert.deepEqual(chestUi.request,{token:'browser-jackpot-token',box:3},'El cliente solo envía token y caja al pick');
        assert.equal(chestUi.open,3,'El minijuego revela las tres cajas');
        assert.equal(chestUi.winner,1,'Solo la caja elegida se muestra como ganadora');
        assert.match(chestUi.labels.join(' '),/SILVER · 200.*BRONZE · 100.*GOLD · 700/);
        assert.equal(chestUi.continue,true,'El modal ofrece continuar con los giros gratis');
        assert.equal(chestUi.pool,'100','El marcador se refresca al bote semilla');
        await js('Net.slotJackpotContinue()');
      }
      await js('(async () => { await Net.leave(); })()');
    }
    // Unirse por código y botón de Salas abiertas.
    const hosted = await (await fetch(url + '/api/rooms', {method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:'Anfitriona',game:'blackjack',blindMinutes:10,chips:1000})})).json();
    await js(`(async () => { App.openLobbySection('games');document.getElementById('net-code').value=${JSON.stringify(hosted.code)};await Net.joinRoom(); })()`);
    for(let i=0;i<100;i++){if(await js(`!document.getElementById('screen-room').classList.contains('hidden') && Net.code === ${JSON.stringify(hosted.code)}`))break;await wait(100);}
    const joinState = await js(`({code:Net.code,message:document.getElementById('net-lobby-message').textContent,roomVisible:!document.getElementById('screen-room').classList.contains('hidden')})`);
    assert.equal(joinState.code,hosted.code,'El código debe permitir entrar a una mesa: '+JSON.stringify(joinState));
    await js(`(async () => { await Net.leave();App.openLobbySection('games');await Net.loadOpenRooms(true); })()`);
    for(let i=0;i<100;i++){if(await js(`[...document.querySelectorAll('.open-room-code')].some(code => code.textContent === ${JSON.stringify(hosted.code)})`))break;await wait(100);}
    const openRoomCode = await js(`[...document.querySelectorAll('.open-room-row')].find(row => row.querySelector('.open-room-code').textContent === ${JSON.stringify(hosted.code)})?.querySelector('button')?.textContent`);
    assert.equal(openRoomCode,'Unirse','La sala abierta debe conservar su botón Unirse');
    await js(`[...document.querySelectorAll('.open-room-row')].find(row => row.querySelector('.open-room-code').textContent === ${JSON.stringify(hosted.code)}).querySelector('button').click()`);
    for(let i=0;i<100;i++){if(await js(`!document.getElementById('screen-room').classList.contains('hidden') && Net.code === ${JSON.stringify(hosted.code)}`))break;await wait(100);}
    const openJoinState = await js(`({code:Net.code,message:document.getElementById('net-lobby-message').textContent,roomVisible:!document.getElementById('screen-room').classList.contains('hidden')})`);
    assert.equal(openJoinState.code,hosted.code,'El botón de Salas abiertas debe entrar a la sala: '+JSON.stringify(openJoinState));
    await js('(async () => { await Net.leave(); })()');
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
    await js(`document.getElementById('net-name').value='';Auth.prefillNames('Bea')`);
    assert.equal(await js(`document.getElementById('net-name').value`),'Bea','El nombre de la cuenta se reutiliza en las salas');
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
    // Ranking del lobby: visible en home, top 5 ampliable, datos reales y refresco sin desbordes
    await js(`App.show('lobby')`);
    assert.equal(await js(`document.querySelectorAll('.portal-grid [onclick*="ranking"]').length`),0,'El ranking no debe ser una tarjeta del portal');
    assert.equal(await js(`document.getElementById('lobby-section-ranking')`),null,'La antigua sección de ranking debe desaparecer');
    assert.equal(await js(`document.getElementById('rank-list').closest('#lobby-home') !== null`),true,'El ranking debe estar dentro de la home');
    assert.equal(await js(`!!(document.querySelector('.portal-grid').compareDocumentPosition(document.querySelector('.rank-box')) & Node.DOCUMENT_POSITION_FOLLOWING)`),true,'El ranking debe ir debajo del grid');
    for(let i=0;i<100;i++){ if(await js(`document.querySelectorAll('#rank-list .rank-row').length > 0`)) break; await wait(100); }
    assert.ok(await js(`document.querySelectorAll('#rank-list .rank-row').length > 0`),'El ranking debe listar las cuentas');
    assert.ok(await js(`[...document.querySelectorAll('#rank-list .rank-name')].some(n=>n.textContent==='${user}')`),'La cuenta creada aparece en el ranking');
    // Simula diez filas ordenadas para comprobar el corte visual sin alterar la lógica de datos.
    await js(`Auth.board=Array.from({length:10},(_,i)=>({name:'Top '+(10-i),chips:(10-i)*100}));Auth.renderBoard();document.querySelector('.rank-box').classList.remove('rank-show-all')`);
    assert.equal(await js(`[...document.querySelectorAll('#rank-list .rank-row')].filter(n=>getComputedStyle(n).display!=='none').length`),5,'El ranking compacto muestra el top 5');
    assert.deepEqual(await js(`[...document.querySelectorAll('#rank-list .rank-row')].slice(0,5).map(n=>n.querySelector('.rank-name').textContent)`),['Top 10','Top 9','Top 8','Top 7','Top 6'],'El top 5 conserva el orden del ranking');
    await js(`document.querySelector('.rank-more').click()`);
    assert.equal(await js(`[...document.querySelectorAll('#rank-list .rank-row')].filter(n=>getComputedStyle(n).display!=='none').length`),10,'El enlace muestra el ranking completo');
    assert.equal(await js(`document.querySelector('.rank-box').classList.contains('rank-show-all') && document.querySelector('.rank-more').getAttribute('aria-expanded')==='true'`),true,'El ranking completo queda accesible');
    await js(`document.querySelector('.rank-more').click();Auth.loadLeaderboard(true)`);
    for(let i=0;i<100;i++){ if(await js(`[...document.querySelectorAll('#rank-list .rank-name')].some(n=>n.textContent==='${user}')`)) break; await wait(100); }
    assert.ok(await js(`[...document.querySelectorAll('#rank-list .rank-name')].some(n=>n.textContent==='${user}')`),'Actualizar recupera el ranking real');
    assert.equal(await js(`document.querySelectorAll('#rank-list .rank-row.me').length`),0,'Sin sesión no se resalta a nadie');
    await js(`Auth.applyUser({name:'${user}',chips:${chipCount}});Auth.highlightBoard()`);
    assert.ok(await js(`[...document.querySelectorAll('#rank-list .rank-name')].some(n=>n.textContent==='${user}')`),'La cuenta aparece tras entrar y derecha propia');
    assert.equal(await js(`document.querySelectorAll('#rank-list .rank-row.me').length`),1,'La fila propia se resalta con la cuenta');
    assert.match(await js(`document.querySelector('#rank-list .rank-row.me .rank-you').textContent`),/tú/);
    await js(`Auth.forget();Auth.highlightBoard()`);
    assert.equal(await js(`document.querySelectorAll('#rank-list .rank-row.me').length`),0,'Al salir se quita el resaltado');
    for (const width of [320,390,768,1280]) {
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
    assert.equal(await js(`Math.round(document.getElementById('pk-shoe').getBoundingClientRect().height)>30`),true);
    await js('window.firstCard = document.querySelector("#pk-seats .pk-card")');
    await render();
    assert.equal(await js('firstCard === document.querySelector("#pk-seats .pk-card")'),true);
    await wait(11000);
    assert.equal(await js(`document.querySelectorAll('#pk-seats .face-down').length`),10);
    assert.equal(await js('Poker.animations.size'),0);
    await render();
    assert.equal(await js('Poker.animations.size'),0);
    assert.match(await js(`document.getElementById('pk-private-hand').textContent`), /^Tu mano: (Pareja|Carta alta) · Solo tú$/);
    await js(`Net.renderChat([{id:'chat-1',playerId:'p0',name:'Ana',text:'Hola mesa',ts:Date.now()},{id:'chat-2',playerId:'p0',name:'Luis',text:'¿Qué tal?',ts:Date.now()}])`);
    assert.equal(await js(`document.getElementById('net-chat').classList.contains('is-open')`),false,'El chat empieza cerrado');
    assert.equal(await js(`getComputedStyle(document.getElementById('net-chat-messages')).display`),'none','El historial está oculto al inicio');
    assert.equal(await js(`document.querySelectorAll('#net-chat-preview .chat-preview-message').length`),2,'La previsualización muestra los mensajes iniciales');
    await js(`Net.renderChat([{id:'chat-3',playerId:'p0',name:'Ana',text:'Tercer mensaje',ts:Date.now()},{id:'chat-4',playerId:'p0',name:'Luis',text:'Cuarto mensaje',ts:Date.now()}])`);
    const chatActivity=await js(`({preview:document.querySelectorAll('#net-chat-preview .chat-preview-message').length,last:document.getElementById('net-chat-preview').textContent,unread:!document.getElementById('net-chat-unread').classList.contains('hidden')})`);
    assert.equal(chatActivity.preview===3&&/Cuarto mensaje/.test(chatActivity.last)&&chatActivity.unread,true,'La previsualización muestra 3 mensajes y avisa de nuevos mensajes');
    await js('Net.openChat()');
    assert.equal(await js(`document.getElementById('net-chat-unread').classList.contains('hidden')`),true,'Abrir el chat limpia el indicador de no leídos');
    await js('Net.closeChat()');
    await js('Net.openChat()');
    const chatBox=await js(`(()=>{const r=document.getElementById('net-chat').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,messages:document.querySelectorAll('#net-chat-messages .chat-message').length,closeVisible:getComputedStyle(document.getElementById('net-chat-close')).display!=='none'};})()`);
    assert.equal(chatBox.left===0&&chatBox.top===0&&chatBox.right===chatBox.width&&chatBox.bottom===chatBox.height,true,'El chat abierto ocupa toda la pantalla '+JSON.stringify(chatBox));
    assert.equal(chatBox.messages===4&&chatBox.closeVisible,true,'El historial y la cruz se ven al abrir');
    await js(`document.getElementById('net-chat-close').click()`);
    assert.equal(await js(`Net.chatVisible===false&&!document.getElementById('net-chat').classList.contains('is-open')`),true,'La cruz cierra el chat');
    await js(`Net.openChat();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await js(`Net.chatVisible===false&&document.querySelectorAll('#net-chat-messages .chat-message').length===4`),true,'Escape cierra el chat conservando el historial');
    for(const [width,height] of [[320,568],[390,844],[768,600],[1100,700],[1440,900]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<760});
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true,'Desbordamiento a '+width);
      assert.equal(await js('document.documentElement.scrollHeight <= innerHeight'),true,'Scroll vertical a '+width+'x'+height);
      const overlap=await js(`(()=>{const r=[...document.querySelectorAll('.pk-seat')].map(n=>n.getBoundingClientRect());return r.some((a,i)=>r.some((b,j)=>j>i&&a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom));})()`);
      assert.equal(overlap,false,'Asientos superpuestos a '+width+' '+JSON.stringify(await js(`[...document.querySelectorAll('.pk-seat')].map(n=>({class:n.className,x:n.offsetLeft,y:n.offsetTop,w:n.offsetWidth,h:n.offsetHeight}))`)));
      const layout=await js(`(()=>{const c=document.querySelector('.pk-controls').getBoundingClientRect();const a=[...document.querySelectorAll('#pk-actions button')].map(n=>n.getBoundingClientRect());return {c:{top:c.top,bottom:c.bottom},a:a.map(r=>({top:r.top,bottom:r.bottom})),height:innerHeight};})()`);
      assert.equal(layout.c.bottom <= layout.height && layout.c.top >= 0,true,'Controles fuera de pantalla a '+width+'x'+height+' '+JSON.stringify(layout));
      assert.equal(layout.a.every(r=>r.top>=0&&r.bottom<=layout.height),true,'Acciones fuera de pantalla a '+width+'x'+height+' '+JSON.stringify(layout));
    }
    const blackjackRoom=new BlackjackRoom('BJVIEW');
    blackjackRoom.addPlayer('a','Ana');blackjackRoom.addPlayer('b','Bruno');blackjackRoom.start();
    blackjackRoom.bet('a',50);blackjackRoom.bet('b',50);blackjackRoom.confirm('a');blackjackRoom.confirm('b');
    const blackjackState=blackjackRoom.stateFor('a');
    await js(`App.show('room');Net.playerId='a';Net.state=${JSON.stringify(blackjackState)};Net.render()`);
    const bjAnimation=await js(`getComputedStyle(document.querySelector('#net-seats .fly-in')).animationDuration`);
    assert.equal(bjAnimation,'0.8s','Las cartas de Blackjack animan durante 0,8 segundos');
    for(const [width,height] of [[320,568],[390,844],[768,600],[1100,700]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<760});
      const bjLayout=await js(`(()=>{const t=document.getElementById('net-blackjack-table').getBoundingClientRect();const c=document.getElementById('net-blackjack-controls').getBoundingClientRect();return {mode:document.body.classList.contains('in-blackjack-room'),meta:getComputedStyle(document.getElementById('net-blackjack-meta')).display,table:t.height,controls:c.bottom,viewport:innerHeight};})()`);
      assert.equal(bjLayout.mode&&bjLayout.meta!=='none'&&bjLayout.table>180&&bjLayout.controls<=bjLayout.viewport,true,'Blackjack compacto en '+width+'x'+height+' '+JSON.stringify(bjLayout));
      assert.equal(await js('document.documentElement.scrollHeight <= innerHeight'),true,'Blackjack sin scroll a '+width+'x'+height);
    }
    await js(`Net.state=${JSON.stringify({...blackjackState,phase:'finished',message:'Dealer: 20 — Ana gana 50 fichas'})};Net.render()`);
    assert.match(await js(`document.getElementById('net-blackjack-result').textContent`),/Ana gana 50 fichas/,'Blackjack muestra el importe ganado al terminar');
    const cards = text => text.split(' ').map(x => ({rank:x.slice(0,-1),suit:x.slice(-1)}));
    const showRoom=new PokerRoom('WIN');showRoom.addPlayer('a','Ana');showRoom.addPlayer('b','Bruno');
    showRoom.board=cards('Q♠ J♠ 10♠ 2♥ 7♦');showRoom.dealerId='a';
    showRoom.players.forEach((p,i)=>Object.assign(p,{inHand:true,total:100,chips:900,hand:cards(i?'2♣ 8♥':'A♠ K♠')}));
    showRoom.finish(true,0);showRoom.events=[];
    await js(`Poker.reset();App.show('room');Net.playerId='b';Net.state=${JSON.stringify(showRoom.stateFor('b',5200))};Net.render()`);
    const winnerUi=await js(`({title:document.getElementById('pk-winner-title').textContent,cards:document.querySelectorAll('#pk-winning-hands .playing-card').length,winners:document.querySelectorAll('.pk-seat.winner').length,shown:!document.getElementById('pk-showdown').classList.contains('hidden')})`);
    assert.equal(winnerUi.shown&&winnerUi.winners===1&&winnerUi.cards===5&&/Ana gana con/.test(winnerUi.title),true,'Showdown con ganador, resaltado y cinco cartas '+JSON.stringify(winnerUi));
    await js(`window.firstWinningCard=document.querySelector('#pk-winning-hands .playing-card');Poker.update();Poker.update()`);
    assert.equal(await js(`firstWinningCard===document.querySelector('#pk-winning-hands .playing-card')`),true,'Las cartas ganadoras no se recrean en cada actualización');
    await send('Emulation.setDeviceMetricsOverride',{width:320,height:568,deviceScaleFactor:1,mobile:true});
    assert.equal(await js('document.documentElement.scrollHeight <= innerHeight'),true,'El resultado del showdown no añade scroll');
    const hintRoom = new PokerRoom('HINT');
    hintRoom.addPlayer('a','Ana'); hintRoom.addPlayer('b','Bob');
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
    console.log('✅ Chrome: chat modal, showdown ganador y Poker sin scroll en móvil y escritorio');
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
