// Prueba visual opcional de la mesa de torneo en Chrome headless.
//   node test/tournament-browser.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { TournamentRoom } = require('../js/tournament-engine.js');
const { PokerRoom } = require('../js/poker-engine.js');
const wait = ms => new Promise(r => setTimeout(r, ms));

const PLAYERS = [
  ['a', 'Ana', 5], ['b', 'Beto', 5], ['c', 'Carla', 5], ['d', 'Dalo', 5],
  ['e', 'Elsa', 5], ['f', 'Fran', 5], ['g', 'Gabo', 5], ['h', 'Hilda', 5], ['i', 'Iker', 5],
];
const card = (rank, suit) => ({ rank, suit });

// Mano avanzada: turno, bote, board y un eliminado, como en la foto de referencia.
function buildRoom() {
  const room = new TournamentRoom('T1', {
    maxPlayers: 9, startChips: 10000, smallBlind: 100, bigBlind: 200, ante: 50,
    levelMinutes: 10, maxLevels: 20, buyIn: 500,
  });
  for (const [id, name, buyIn] of PLAYERS) room.addPlayer(id, name, { buyIn, accountKey: id });
  room.start(null, Date.now());
  room.board = [card('J', '♠'), card('7', '♥'), card('2', '♠')];
  // El bote lo calcula el servidor sumando las apuestas de cada jugador.
  room.turnId = 'b';
  room.turnDeadline = Date.now() + 30000;
  room.handNo = 19;
  room.find('a').hand = [card('Q', '♦'), card('9', '♣')];
  room.find('a').bet = 1000; room.find('a').total = 1000;
  room.find('b').hand = [card('A', '♠'), card('K', '♠')];
  room.find('b').bet = 1000; room.find('b').total = 1000;
  room.find('c').chips = 3000;
  room.find('d').folded = true;
  room.find('g').chips = 0;
  room.find('g').eliminated = true;
  room.find('g').left = true;
  room.registerPlacement(room.find('g'), 5, Date.now());
  return room;
}

async function main() {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-trn-test-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-trn-data-'));
  // Cada prueba arranca con cuentas y torneos limpios (nada de Firebase).
  process.env.USERS_FILE = path.join(dataDir, 'users.json');
  process.env.TOURNAMENTS_FILE = path.join(dataDir, 'tournaments.json');
  process.env.DATA_DIR = dataDir;
  const { server, tournamentStore } = require('../server.js');
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = fs.readFileSync(portFile, 'utf8').split('\n')[0]; } catch (e) { /* aún no existe */ }
      if (!port) await wait(100);
    }
    assert.ok(port, 'Chrome no publicó su puerto de depuración');
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
    const page = pages.find(p => p.type === 'page' && p.url === 'about:blank');
    assert.ok(page, 'Chrome debe ofrecer la pestaña de prueba about:blank');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = event => {
      const m = JSON.parse(event.data);
      if (m.id) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, m => m.error ? reject(m.error) : resolve(m.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const js = async expression => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails) + ' :: ' + expression);
      return r.result.value;
    };
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) { if (await js('typeof TournamentsAdmin !== "undefined"')) break; await wait(100); }
    assert.equal(await js('typeof TournamentsAdmin'), 'object', 'El cliente de torneos no cargó');

    // ---------- La sección del lobby existe y se abre ----------
    const portal = await js(`(() => {
      const card = [...document.querySelectorAll('.portal-card')].find(c => (c.getAttribute('onclick') || '').includes("openLobbySection('tournaments')"));
      if (!card) return { found: false };
      card.click();
      return { found: true, visible: !document.getElementById('lobby-section-tournaments').classList.contains('hidden') };
    })()`);
    assert.equal(portal.found && portal.visible, true, 'El portal tiene que llevar a la sección de torneos');
    // El listado se carga por fetch: se espera a que pinte el estado vacío.
    let empty = '';
    for (let i = 0; i < 40; i++) {
      empty = await js(`document.getElementById('tournament-list').textContent`);
      if (empty) break;
      await wait(100);
    }
    assert.equal(empty.includes('Todavía no hay torneos'), true, 'Sin torneos, el listado lo avisa: ' + empty);

    // ---------- El admin crea un torneo por la API ----------
    const created = await (await fetch(url + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'franelnomada', password: 'secreta1', chips: 9000 }),
    })).json();
    const adminPost = (p, b) => fetch(url + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + created.token },
      body: JSON.stringify(b || {}),
    }).then(r => r.json());
    const tournament = await adminPost('/api/admin/tournaments', {
      name: 'Visual', buyIn: 500, startChips: 10000, smallBlind: 100, ante: 50,
      maxPlayers: 9, minPlayers: 2, levelMinutes: 10, maxLevels: 20,
      prizes: [{ position: 1, format: 'porcentaje', value: 60, label: 'Campeón' }],
    });
    assert.ok(tournament.tournament && tournament.tournament.id, 'El admin debe poder crear un torneo');

    // ---------- El formulario ofrece programar por fecha y avisa del cambio ----------
    const formUi = await js(`(() => {
      TournamentsAdmin.setStartMode('jugadores');
      const hiddenAtStart = document.getElementById('trn-admin-startat-wrap').classList.contains('hidden');
      TournamentsAdmin.setStartMode('programado', Date.now() + 172800000);
      const wrap = document.getElementById('trn-admin-startat-wrap');
      return {
        hiddenAtStart,
        visibleNow: !wrap.classList.contains('hidden'),
        modes: [...document.querySelectorAll('#trn-admin-startmode option')].map(o => o.value),
        value: document.getElementById('trn-admin-startat').value,
      };
    })()`);
    assert.equal(formUi.hiddenAtStart, true, 'El campo de fecha se oculta si no se programa');
    assert.equal(formUi.visibleNow, true, 'Al elegir "programado" aparece el campo de fecha');
    assert.deepEqual(formUi.modes, ['jugadores', 'programado', 'manual'], 'Hay tres formas de arrancar');
    assert.equal(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(formUi.value), true, 'La fecha se rellena en formato local: ' + formUi.value);

    // ---------- Un torneo programado se ve en el listado con su fecha ----------
    const scheduled = await adminPost('/api/admin/tournaments', {
      name: 'Viernes nocturno', buyIn: 200, startChips: 5000, smallBlind: 50,
      maxPlayers: 9, minPlayers: 6, levelMinutes: 10, maxLevels: 15,
      startMode: 'programado', startsAt: Date.now() + 3 * 86400000,
      prizes: [{ position: 1, format: 'porcentaje', value: 100, label: 'Campeón' }],
    });
    assert.equal(scheduled.ok !== false && !!scheduled.tournament.id, true, 'Se crea un torneo programado');
    assert.equal(scheduled.tournament.startMode, 'programado', 'Queda guardado como programado');
    assert.equal(scheduled.tournament.minPlayers, 1, 'Programado ignora el mínimo de jugadores');
    await js('Tournaments.refresh(true)');
    await wait(400);
    const schedUi = await js(`(() => {
      const card = [...document.querySelectorAll('#tournament-list .tournament-card')]
        .find(c => /Viernes nocturno/.test(c.textContent));
      if (!card) return { found: false, html: document.getElementById('tournament-list').innerHTML.slice(0, 300) };
      return { found: true, text: card.textContent };
    })()`);
    assert.equal(schedUi.found, true, 'El torneo programado aparece en el listado');
    assert.equal(/Empieza/.test(schedUi.text) && /en 2 días|en 3 días/.test(schedUi.text), true,
      'La tarjeta avisa del día y la cuenta atrás: ' + schedUi.text);
    await adminPost('/api/admin/tournaments/' + scheduled.tournament.id + '/delete', {});

    // ---------- El listado público muestra las reglas del torneo ----------
    await js('Tournaments.refresh(true)');
    await wait(400);
    const cardUi = await js(`(() => {
      const node = document.querySelector('#tournament-list .tournament-card');
      if (!node) return { found: false, html: document.getElementById('tournament-list').innerHTML.slice(0, 300) };
      return { found: true, text: node.textContent, button: (node.querySelector('.tournament-actions button') || {}).textContent };
    })()`);
    assert.equal(cardUi.found, true, 'El torneo creado aparece en el listado');
    assert.equal(/Visual/.test(cardUi.text) && /500 fichas/.test(cardUi.text) && /100\/200/.test(cardUi.text) && /ante 50/.test(cardUi.text), true,
      'La tarjeta muestra cuota, reparto y ciegas: ' + cardUi.text);
    assert.equal(cardUi.button, 'Entra para apuntarte', 'Sin sesión, el botón pide entrar: ' + cardUi.button);

    // ---------- "Cómo inscribirse": WhatsApp con el mensaje ya escrito ----------
    const howTo = await js(`(() => {
      const node = document.querySelector('#tournament-list .tournament-card');
      const link = node.querySelector('.trn-howto');
      if (!link) return { found: false, html: node.innerHTML.slice(0, 400) };
      const after = link.previousElementSibling;
      return {
        found: true, text: link.textContent, href: link.href, target: link.target,
        label: link.getAttribute('aria-label'), belowJoin: /apuntarte|Pedir plaza/.test(after.textContent),
      };
    })()`);
    assert.equal(howTo.found, true, 'La tarjeta del torneo trae el botón de inscripción por WhatsApp');
    assert.equal(howTo.text.includes('Cómo inscribirse'), true, 'El botón dice "Cómo inscribirse"');
    assert.equal(howTo.belowJoin, true, 'El botón va debajo del de apuntarse');
    assert.equal(howTo.target, '_blank', 'El WhatsApp se abre en otra pestaña');
    const howToUrl = new URL(howTo.href);
    assert.equal(howToUrl.host, 'wa.me', 'Apunta al chat de WhatsApp: ' + howToUrl.href);
    assert.equal(howToUrl.pathname, '/34684753093', 'Va al número de Fran: ' + howToUrl.href);
    const howToText = howToUrl.searchParams.get('text');
    assert.equal(howToText,
      '¡Hola Fran! Estoy interesado en inscribirme en el torneo de poker ("Visual") y quisiera más información, gracias.',
      'El mensaje va redactado y con el título del torneo: ' + howToText);
    assert.equal(/inscribirse/i.test(howTo.label), true, 'El botón se anuncia al lector de pantalla');

    // ---------- La mesa se pinta con el estado real del servidor ----------
    const room = buildRoom();
    tournamentStore.live.set('T1', room);
    const state = room.stateFor('a', Date.now());
    // Se abre la mesa por el flujo real (openTable), que es quien activa el
    // modo "una sola pantalla"; luego se inyecta el estado ya calculado.
    await js(`Tournaments.openTable({ id: 'T1', playerId: 'a', name: 'Visual' })`);
    await js(`Tournaments.state = ${JSON.stringify(state)};Tournaments.render(${JSON.stringify(state)})`);
    await wait(700);
    const table = await js(`(() => {
      const seats = [...document.querySelectorAll('#trn-seats .pk-seat')];
      return {
        seatCount: seats.length,
        selfSeat: seats.filter(s => s.classList.contains('self')).length,
        activeSeat: seats.filter(s => s.classList.contains('active')).length,
        eliminated: seats.filter(s => s.classList.contains('eliminated')).length,
        blinds: document.getElementById('trn-blinds').textContent,
        pot: document.getElementById('trn-pot').textContent,
        board: document.querySelectorAll('#trn-board .playing-card').length,
        meName: document.getElementById('trn-me-name').textContent,
        meChips: document.getElementById('trn-me-chips').textContent,
        meCards: document.querySelectorAll('#trn-me-cards .playing-card').length,
        myHole: document.querySelector('#trn-me-cards .playing-card').textContent,
        rivalHidden: document.querySelector('#trn-seats .pk-seat:not(.self) .pk-hole .playing-card').className.includes('face-down'),
        call: document.getElementById('trn-call').textContent,
        raise: document.getElementById('trn-raise').textContent,
        tableRadius: getComputedStyle(document.getElementById('trn-table')).borderRadius,
        quick: [...document.querySelectorAll('#trn-actions .trn-quick-btn')].map(b => b.textContent),
      };
    })()`);
    assert.equal(table.seatCount, 9, 'Los nueve jugadores se sientan alrededor de la mesa');
    assert.equal(table.selfSeat, 1, 'El jugador se reconoce a sí mismo');
    assert.equal(table.activeSeat, 1, 'Se resalta el asiento del turno');
    assert.equal(table.eliminated, 1, 'El eliminado sigue en la mesa, apagado');
    assert.equal(table.blinds, '100/200(50) · nivel 1', 'Ciegas con el ante entre paréntesis: ' + table.blinds);
    assert.equal(table.pot, 'Bote: ' + state.pot.toLocaleString('es-ES'), 'El bote se muestra en el centro: ' + table.pot);
    assert.equal(table.board, 3, 'Se ven las tres cartas comunitarias');
    assert.equal(table.meCards, 2, 'El jugador ve sus dos cartas');
    assert.ok(table.myHole.includes('Q') && table.myHole.includes('♦'), 'Sus cartas se ven descubiertas: ' + table.myHole);
    assert.equal(table.rivalHidden, true, 'Las cartas del rival permanecen boca abajo');
    // Con la apuesta ya cubierta, el botón de igualar dice "Pasar"; se prueba
    // también el importe pendiente de igualar con un estado que lo requiera.
    assert.equal(table.call, 'Pasar', 'Quien ya igualó ve "Pasar": ' + table.call);
    const owing = JSON.parse(JSON.stringify(state));
    owing.toCall = 700;
    await js(`Tournaments.render(${JSON.stringify(owing)})`);
    assert.equal(await js(`document.getElementById('trn-call').textContent`), 'Igualar 700', 'Con deuda pendiente, el botón muestra el importe a igualar');
    await js(`Tournaments.render(${JSON.stringify(state)})`);
    assert.equal(table.quick.join('|'), 'Mín.|50 %|Bote|Máx.', 'Los cuatro atajos de importe: ' + table.quick);
    assert.ok(/4\d% \/ 4\d%/.test(table.tableRadius), 'La mesa es un óvalo, no un rectángulo: ' + table.tableRadius);

    // ---------- Ausentarse: botón, estado y aviso de las ciegas ----------
    const sitUi = await js(`(() => {
      const button = document.getElementById('trn-sitout');
      const note = document.getElementById('trn-sitout-note');
      const seatOf = id => document.querySelector('#trn-seats .pk-seat[data-player="' + id + '"]');
      const seat = seatOf(Tournaments.table.playerId);
      return {
        exists: !!button, text: button.textContent, pressed: button.getAttribute('aria-pressed'),
        note: note.textContent, hasSeat: !!seat, awayClass: !!(seat && seat.classList.contains('sitting-out')),
        badge: seat ? seat.querySelector('.pk-badges').textContent : '',
        disabled: button.disabled,
      };
    })()`);
    assert.equal(sitUi.exists, true, 'La mesa de torneo tiene el botón de ausentarse');
    assert.equal(sitUi.text, 'Ausentarse', 'El botón ofrece ausentarse: ' + sitUi.text);
    assert.match(sitUi.note, /ciegas/i, 'Se avisa de que las ciegas se cobran igual: ' + sitUi.note);
    assert.equal(sitUi.awayClass, false, 'Antes de pulsarlo no está marcado como ausente');

    // El estado marca al jugador como ausente: la mesa debe reflejarlo entero.
    const awayState = { ...state, players: state.players.map(p => ({ ...p, sittingOut: p.id === 'a' })) };
    await js(`Tournaments.render(${JSON.stringify(awayState)})`);
    const afterSit = await js(`(() => {
      const button = document.getElementById('trn-sitout');
      const seat = document.querySelector('#trn-seats .pk-seat[data-player="' + Tournaments.table.playerId + '"]');
      return {
        text: button.textContent, pressed: button.getAttribute('aria-pressed'),
        awayClass: !!(seat && seat.classList.contains('sitting-out')),
        badge: seat ? seat.querySelector('.pk-badges').textContent : '',
        note: document.getElementById('trn-sitout-note').textContent,
        disabled: button.disabled,
      };
    })()`);
    assert.equal(afterSit.text, 'Volver a la mesa', 'Al ausentarse, el botón ofrece volver: ' + afterSit.text);
    assert.equal(afterSit.pressed, 'true', 'El botón queda marcado como pulsado');
    assert.equal(afterSit.awayClass, true, 'El asiento se ve como ausente');
    assert.match(afterSit.badge, /AUSENTE/, 'Los rivales ven que está ausente: ' + afterSit.badge);
    assert.match(afterSit.note, /Estás ausente/, 'Se avisa de que su mano se retira sola');
    // Volver a la mesa devuelve el botón a su estado inicial.
    await js(`Tournaments.render(${JSON.stringify(state)})`);
    assert.equal(await js(`document.getElementById('trn-sitout').textContent`), 'Ausentarse',
      'Al volver, el botón vuelve a ofrecer ausentarse');
    // Las dos mesas comparten marcado: el torneo usa las clases del póker normal,
    // así que las cartas se ven exactamente igual en los dos juegos.
    // Para poder comparar, se pinta también una mesa de póker normal.
    const trnState = await js('JSON.stringify(Tournaments.state)');
    const pokerRoom = new PokerRoom('COMPAR');
    for (const id of ['p1', 'p2']) pokerRoom.addPlayer(id, id, 1000);
    pokerRoom.start('p1', Date.now());
    pokerRoom.board = [{ rank: 'A', suit: '♠' }, { rank: 'K', suit: '♥' }];
    await js(`App.show('room'); Net.playerId='p1'; Net.state=${JSON.stringify(pokerRoom.stateFor('p1'))}; Net.render()`);
    await wait(500);
    const sameTable = await js(`(() => {
      const trn = document.getElementById('trn-table'), pk = document.getElementById('pk-table');
      const cls = n => [...n.classList].sort().join(' ');
      const cardOf = (root, sel) => { const c = root.querySelector(sel); const s = getComputedStyle(c);
        return s.width + 'x' + s.height; };
      return {
        sameClasses: cls(trn) === cls(pk),
        seats: cls(document.getElementById('trn-seats')) === cls(document.getElementById('pk-seats')),
        seatOf: cls(document.querySelector('#trn-seats .pk-seat')) === cls(document.querySelector('#pk-seats .pk-seat')),
        hole: cls(document.querySelector('#trn-seats .pk-hole')) === cls(document.querySelector('#pk-seats .pk-hole')),
        board: cls(document.getElementById('trn-board')) === cls(document.getElementById('pk-board')),
        trnCard: cardOf(document.getElementById('trn-board'), '.playing-card'),
        pkCard: cardOf(document.getElementById('pk-board'), '.playing-card'),
        showdown: !!document.querySelector('#trn-table .pk-showdown'),
      };
    })()`);
    assert.equal(sameTable.sameClasses && sameTable.seats && sameTable.seatOf &&
      sameTable.hole && sameTable.board, true,
      'El torneo usa las mismas clases que el póker: ' + JSON.stringify(sameTable));
    assert.equal(sameTable.trnCard, sameTable.pkCard,
      'Las cartas se ven igual en los dos juegos: ' + JSON.stringify(sameTable));
    assert.equal(sameTable.showdown, true, 'El torneo también muestra el panel del showdown');
    // Vuelve a la mesa de torneo para seguir la prueba.
    await js(`App.show('tournament'); Tournaments.render(${trnState})`);

    if (process.env.MEASURE) {
      const m = await js(`(() => {
        const r = el => { const b = el.getBoundingClientRect(); return {t: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width)}; };
        return {
          bodyClass: document.body.className,
          overflow: [...document.querySelectorAll('body *')]
            .filter(el => el.getBoundingClientRect().right > innerWidth + 1)
            .slice(0, 6)
            .map(el => (el.id || el.className || el.tagName) + ':' + Math.round(el.getBoundingClientRect().right)),
          appDisplay: getComputedStyle(document.getElementById('app')).display,
          appFlex: getComputedStyle(document.getElementById('app')).flex,
          tableFlex: getComputedStyle(document.getElementById('trn-table')).flex,
          win: innerHeight,
          app: r(document.getElementById('app')),
          table: r(document.getElementById('trn-table')),
        };
      })()`);
      console.log('MEDIDAS ' + JSON.stringify(m, null, 1));
    }

    // ---------- El rótulo de mesa aparece con varias mesas ----------
    const multiState = JSON.parse(JSON.stringify(state));
    multiState.tableNumber = 2;
    multiState.tableCount = 3;
    multiState.tournament.tableCount = 3;
    await js(`Tournaments.render(${JSON.stringify(multiState)})`);
    await wait(200);
    const multiTitle = await js(`document.getElementById('trn-name').textContent`);
    assert.ok(/Mesa 2\/3/.test(multiTitle), 'Con varias mesas el título dice en cuál estás: ' + multiTitle);
    // Al volver a una sola mesa, el sufijo desaparece.
    await js(`Tournaments.render(${JSON.stringify(state)})`);
    await wait(200);
    const singleTitle = await js(`document.getElementById('trn-name').textContent`);
    assert.ok(!/Mesa \d/.test(singleTitle), 'Con una sola mesa el título vuelve a estar limpio: ' + singleTitle);

    // Captura de la mesa para revisarla a ojo (tournament-table.png).
    if (process.env.SHOT) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
      console.log('📸 Captura de la mesa guardada en ' + process.env.SHOT);
    }

    // ---------- Los atajos de importe funcionan ----------
    const minRaise = Math.min(state.minRaiseTo, state.maxRaiseTo);
    await js(`Tournaments.bet('max')`);
    assert.equal(await js(`Number(document.getElementById('trn-amount').value)`), state.maxRaiseTo, 'Máx. lleva al all-in');
    await js(`Tournaments.bet('min')`);
    assert.equal(await js(`Number(document.getElementById('trn-amount').value)`), minRaise, 'Mín. lleva a la subida mínima');
    await js(`Tournaments.bet('half')`);
    assert.equal(await js(`Number(document.getElementById('trn-amount').value)`), Math.floor((minRaise + state.maxRaiseTo) / 2), '50 % queda a mitad de camino');
    await js(`Tournaments.bet('pot')`);
    assert.equal(await js(`Number(document.getElementById('trn-amount').value)`), state.maxRaiseTo, 'Bote topea en el máximo del jugador');
    await js(`Tournaments.el('slider').value=100;Tournaments.syncSlider()`);
    assert.equal(await js(`Number(document.getElementById('trn-amount').value)`), state.maxRaiseTo, 'El slider llega hasta el máximo');
    await js(`Tournaments.stepAmount(-1)`);
    assert.ok(await js(`Number(document.getElementById('trn-amount').value)`) < state.maxRaiseTo, 'El botón "−" baja el importe');

    // ---------- Los nodos no se recrean en cada actualización ----------
    await js(`window.trnFirstSeat=document.querySelector('#trn-seats .pk-seat');Tournaments.render(${JSON.stringify(state)});Tournaments.render(${JSON.stringify(state)})`);
    assert.equal(await js(`trnFirstSeat===document.querySelector('#trn-seats .pk-seat')`), true,
      'Los asientos no se recrean en cada actualización');

    // ---------- El descanso y el final se explican en pantalla ----------
    const resting = JSON.parse(JSON.stringify(state));
    resting.tournament.phase = 'descanso';
    resting.tournament.breakTimeLeft = 240000;
    resting.turnId = null;
    await js(`Tournaments.render(${JSON.stringify(resting)})`);
    assert.ok(/Descanso/.test(await js(`document.getElementById('trn-status').textContent`)), 'El descanso se anuncia en la barra de estado');
    const over = JSON.parse(JSON.stringify(state));
    over.tournament.phase = 'finalizado';
    over.tournament.standings = [
      { playerId: 'a', name: 'Ana', place: 1 }, { playerId: 'b', name: 'Beto', place: 2 },
    ];
    await js(`Tournaments.render(${JSON.stringify(over)})`);
    assert.equal(await js(`document.getElementById('trn-final').classList.contains('hidden')`), false, 'Al terminar se ve la clasificación');
    assert.equal(await js(`document.querySelectorAll('#trn-final .trn-standings li').length`), 2, 'La clasificación lista los puestos');

    // ---------- La mesa no hace scroll en móvil ----------
    assert.equal(await js('document.documentElement.scrollHeight <= innerHeight + 4'), true, 'La mesa cabe en una pantalla de móvil');

    // ---------- El panel de admin ----------
    const admin = await js(`(() => {
      Auth.token = ${JSON.stringify(created.token)};
      Auth.user = { name: 'franelnomada', isAdmin: true, chips: 9000 };
      Admin.open();
      return { block: !!document.querySelector('#admin-tournament-form') };
    })()`);
    assert.equal(admin.block, true, 'El panel de admin tiene el formulario de torneos');
    await wait(900);
    const adminUi = await js(`(() => {
      const row = document.querySelector('#admin-tournament-list .admin-tournament');
      return {
        rows: document.querySelectorAll('#admin-tournament-list .admin-tournament').length,
        text: row ? row.textContent : '',
        edit: !!(row && [...row.querySelectorAll('button')].some(b => b.textContent.includes('Editar'))),
        del: !!(row && [...row.querySelectorAll('button')].some(b => b.textContent.includes('Borrar'))),
        prizes: document.querySelectorAll('#trn-admin-prize-list .trn-prize-row').length,
        fields: ['name','buyin','chips','sb','ante','max','min','level','levels','breakevery','breakmin','late']
          .every(id => !!document.getElementById('trn-admin-' + id)),
      };
    })()`);
    assert.equal(adminUi.rows, 1, 'El admin ve el torneo creado');
    assert.equal(adminUi.text.includes('500') && adminUi.text.includes('100/200(50)'), true, 'La fila resume las reglas: ' + adminUi.text);
    assert.equal(adminUi.edit && adminUi.del, true, 'Puede editar y borrar el torneo');
    assert.equal(adminUi.prizes, 3, 'El formulario trae la lista de premios por defecto');
    assert.equal(adminUi.fields, true, 'El formulario tiene todos los campos de configuración');

    // Editar rellena el formulario con lo que ya había.
    await js(`[...document.querySelectorAll('#admin-tournament-list button')].find(b => b.textContent.includes('Editar')).click()`);
    assert.equal(await js(`document.getElementById('trn-admin-name').value`), 'Visual', 'Editar carga el nombre del torneo');
    assert.equal(await js(`document.getElementById('trn-admin-sb').value`), '100', 'Editar carga la ciega pequeña');
    assert.equal(await js(`document.getElementById('trn-admin-max').value`), '9', 'Editar carga el aforo máximo');

    // ---------- Aceptar una solicitud real y sentarla en la mesa ----------
    const ana = await (await fetch(url + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ana', password: 'secreta1', chips: 5000 }),
    })).json();
    await fetch(url + '/api/tournaments/' + tournament.tournament.id + '/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ana.token }, body: '{}',
    });
    await js('TournamentsAdmin.load()');
    await wait(900);
    const waiting = await js(`(() => {
      const row = document.querySelector('#admin-tournament-list .trn-request');
      return {
        text: row ? row.textContent : '',
        accept: !!(row && [...row.querySelectorAll('button')].some(b => b.textContent === 'Aceptar')),
      };
    })()`);
    assert.ok(waiting.text.includes('Ana') && waiting.text.includes('esperando'), 'El admin ve la solicitud pendiente: ' + waiting.text);
    assert.equal(waiting.accept, true, 'El admin puede aceptar la solicitud');
    await js(`[...document.querySelectorAll('#admin-tournament-list .trn-request button')].find(b => b.textContent === 'Aceptar').click()`);
    await wait(1000);
    const say = await js(`document.getElementById('admin-tournament-form-status').textContent`);
    assert.equal(say.includes('cuota cobrada'), true, 'Al aceptar se confirma que la cuota se cobró: ' + say);

    // ---------- Partida real entre dos jugadores por HTTP ----------
    const duel = await adminPost('/api/admin/tournaments', {
      name: 'Duelo', buyIn: 200, startChips: 2000, smallBlind: 50,
      maxPlayers: 2, minPlayers: 2, levelMinutes: 10, maxLevels: 5, autoStart: true,
      prizes: [{ position: 1, format: 'porcentaje', value: 100 }],
    });
    const duelId = duel.tournament.id;
    const betoAcc = await (await fetch(url + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Beto', password: 'secreta1', chips: 2000 }),
    })).json();
    const ask = (token, id) => fetch(url + '/api/tournaments/' + id + '/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}',
    }).then(r => r.json());
    await ask(ana.token, duelId);
    await ask(betoAcc.token, duelId);
    const duelTournament = (await fetch(url + '/api/admin/tournaments', {
      headers: { Authorization: 'Bearer ' + created.token },
    }).then(r => r.json())).tournaments.find(t => t.id === duelId);
    for (const r of duelTournament.requests) await adminPost('/api/admin/tournaments/requests/' + r.id + '/accept', {});

    // El listado dice qué playerId tiene cada jugador.
    const seatOf2 = async (token) => {
      const list = await fetch(url + '/api/tournaments', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
      return list.tournaments.find(t => t.id === duelId).playerId;
    };
    const anaSeat = await seatOf2(ana.token);
    const betoSeat = await seatOf2(betoAcc.token);
    assert.ok(anaSeat && betoSeat, 'Cada jugador aceptado recibe su asiento');

    const stateOf = (token) => fetch(url + '/api/tournaments/' + duelId + '/state?v=0', {
      headers: { Authorization: 'Bearer ' + token },
    }).then(r => r.json());
    const duelState = await stateOf(ana.token);
    assert.equal(duelState.turnId != null, true, 'La mesa arranca sola al llegar al mínimo de jugadores');
    assert.equal(duelState.players.length, 2, 'Los dos jugadores están sentados');
    assert.equal(duelState.smallBlind, 50, 'Se usan las ciegas configuradas por el admin');
    // Quien tiene el turno actúa; fuera de turno el servidor lo rechaza.
    const outOfTurn = duelState.turnId === anaSeat ? betoSeat : anaSeat;
    const rejected = await fetch(url + '/api/tournaments/' + duelId + '/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: outOfTurn, type: 'check' }),
    });
    assert.equal(rejected.status, 400, 'No se puede jugar fuera de turno');
    for (let i = 0; i < 12; i++) {
      const s = await stateOf(ana.token);
      if (s.turnId == null) break;
      const type = s.toCall ? 'call' : 'check';
      const r = await fetch(url + '/api/tournaments/' + duelId + '/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: s.turnId === anaSeat ? anaSeat : betoSeat, type }),
      });
      if (r.status !== 200) break;
    }
    const after = await stateOf(ana.token);
    assert.equal(after.handNo >= 1, true, 'Se juega al menos una mano: ' + after.handNo);
    const paid = await adminPost('/api/admin/tournaments/' + duelId + '/finish', {});
    assert.equal(paid.tournament.status, 'finalizado', 'El admin puede finalizar el torneo');
    assert.equal(paid.paid, 400, 'El bote entero (2 × 200) se reparte: ' + paid.paid);

    // ---------- Mesas múltiples por HTTP: 4 jugadores en 2 mesas ----------
    const multi = await adminPost('/api/admin/tournaments', {
      name: 'Multimesa', buyIn: 100, startChips: 4000, smallBlind: 50,
      maxPlayers: 2, maxTables: 2, minPlayers: 2, levelMinutes: 10, maxLevels: 20,
      moveEveryLevels: 2,
      prizes: [{ position: 1, format: 'porcentaje', value: 100, label: 'Campeón' }],
    });
    assert.equal(multi.ok !== false && multi.tournament.maxTables === 2, true, 'Se crea un torneo de 2 mesas');
    assert.equal(multi.tournament.maxPlayers * multi.tournament.maxTables === 4, true, 'Aforo de 4 jugadores');
    const multiId = multi.tournament.id;
    const seats = [];
    for (const name of ['Luis', 'Lola', 'Leo', 'Lena']) {
      const acc = await (await fetch(url + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password: 'secreta1', chips: 3000 }),
      })).json();
      seats.push(Object.assign({ label: name }, acc));
      await fetch(url + '/api/tournaments/' + multiId + '/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acc.token }, body: '{}',
      });
    }
    const multiT = (await fetch(url + '/api/admin/tournaments', {
      headers: { Authorization: 'Bearer ' + created.token },
    }).then(r => r.json())).tournaments.find(t => t.id === multiId);
    for (const r of multiT.requests) await adminPost('/api/admin/tournaments/requests/' + r.id + '/accept', {});
    const multiView = (await fetch(url + '/api/tournaments', { headers: { Authorization: 'Bearer ' + created.token } })
      .then(r => r.json())).tournaments.find(t => t.id === multiId);
    assert.equal(multiView.seated, 4, 'Los 4 quedan sentados: ' + multiView.seated);
    assert.equal(multiView.tableCount, 2, 'Se abren 2 mesas: ' + multiView.tableCount);
    assert.deepEqual(multiView.tables.map(x => x.seated), [2, 2], 'Cada mesa con 2 jugadores');

    // Cada jugador ve solo su mesa, y todos en la misma hora.
    const playerIds = {};
    for (const acc of seats) {
      const list = await fetch(url + '/api/tournaments', { headers: { Authorization: 'Bearer ' + acc.token } }).then(r => r.json());
      playerIds[acc.label] = list.tournaments.find(t => t.id === multiId).playerId;
    }
    const tableNumbers = [];
    for (const acc of seats) {
      const st = await fetch(url + '/api/tournaments/' + multiId + '/state?v=0&player=' +
        encodeURIComponent(playerIds[acc.label]), {
        headers: { Authorization: 'Bearer ' + acc.token },
      }).then(r => r.json());
      assert.equal(st.tableCount, 2, 'El estado indica 2 mesas');
      tableNumbers.push(st.tableNumber);
      assert.equal(st.players.length, 2, 'Solo ve a los de su mesa: ' + st.players.map(p => p.name).join(','));
      assert.equal(st.tournament.smallBlind, 50, 'Las ciegas son las del torneo');
      assert.equal(st.tournament.maxPlayers, 4, 'El aforo total es de 4 jugadores');
      // El jugador aparece en su propia mesa.
      assert.equal(st.players.some(p => p.id === playerIds[acc.label]), true,
        'El jugador se ve a sí mismo en su mesa');
    }
    assert.equal(new Set(tableNumbers).size, 2, 'Los jugadores se reparten en 2 mesas: ' + tableNumbers.join(','));
    assert.equal(tableNumbers.filter(n => n === 1).length, 2, 'Dos en la mesa 1');
    assert.equal(tableNumbers.filter(n => n === 2).length, 2, 'Dos en la mesa 2');
    assert.equal(new Set(Object.values(playerIds)).size, 4, 'Cada jugador tiene su propio asiento');
    // No se puede jugar por otro: el servidor busca la mesa del jugador.
    const outsider = await fetch(url + '/api/tournaments/' + multiId + '/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'tp_noexiste', type: 'check' }),
    });
    assert.equal(outsider.status, 400, 'No se puede actuar sin estar sentado');
    await adminPost('/api/admin/tournaments/' + multiId + '/finish', {});

    assert.deepEqual(errors, []);
    console.log('✅ Chrome: mesa de torneo con asientos, atajos de importe, descanso, clasificación y panel admin');
  } finally {
    const exited = new Promise(resolve => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
      ws.onmessage = () => {};
    } else child.kill();
    await Promise.race([exited, wait(3000)]);
    if (child.exitCode === null) { child.kill(); await Promise.race([exited, wait(1000)]); }
    if (ws) ws.close();
    server.closeAllConnections(); server.close();
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
