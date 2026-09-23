// Test end-to-end de la API del servidor (HTTP real)
// Ejecutar con: node test/e2e.js
const assert = require('assert');
const { server, rooms } = require('../server.js');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name);
  if (!cond) failures++;
}

async function main() {

const PORT = await new Promise(res => server.listen(0, () => res(server.address().port)));
const base = 'http://127.0.0.1:' + PORT;

async function post(path, body) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, data: await r.json() };
}
async function get(path) {
  const r = await fetch(base + path);
  return { status: r.status, data: await r.json() };
}

// Crear sala y unirse
const created = await post('/api/rooms', { name: 'Ana' });
check('api: crear sala devuelve código y playerId',
  created.status === 200 && /^[A-Z0-9]{4}$/.test(created.data.code) && !!created.data.playerId);
const code = created.data.code;
const A = created.data.playerId;

const joined = await post(`/api/rooms/${code}/join`, { name: 'Bob' });
check('api: segundo jugador se une', joined.status === 200 && !!joined.data.playerId);
const B = joined.data.playerId;

const badJoin = await post('/api/rooms/XXXX/join', { name: 'Zoe' });
check('api: código incorrecto da 404', badJoin.status === 404);

// Estado inicial
const st0 = await get(`/api/rooms/${code}/state?player=${A}&v=0`);
check('api: estado inicial lobby con 2 jugadores',
  st0.data.phase === 'lobby' && st0.data.players.length === 2);

// Flujo de ronda: start → apuestas → confirmar → jugar → resolver
await post(`/api/rooms/${code}/action`, { playerId: A, type: 'start' });
await post(`/api/rooms/${code}/action`, { playerId: A, type: 'bet', amount: 100 });
await post(`/api/rooms/${code}/action`, { playerId: B, type: 'bet', amount: 50 });
await post(`/api/rooms/${code}/action`, { playerId: A, type: 'confirm' });

const midBet = await get(`/api/rooms/${code}/state?player=${B}&v=0`);
check('api: sin confirmar B, sigue en apuestas', midBet.data.phase === 'betting');

// Baraja determinista para evitar blackjacks aleatorios en esta prueba de turnos.
rooms.get(code).deck = Array.from({ length: 52 }, () => ({ rank: '5', suit: '♠' }));
const dealt = await post(`/api/rooms/${code}/action`, { playerId: B, type: 'confirm' });
check('api: al confirmar todos se reparte', dealt.data.phase === 'playing');
check('api: las cartas de todos son visibles',
  dealt.data.players[1].cards.length === 2 && dealt.data.players[0].cards.length === 2);

// Acciones de juego respetando turnos (derecha → izquierda)
check('api: el servidor designa el turno', [A, B].includes(dealt.data.turnId));
if (dealt.data.turnId === B) {
  const outOfTurn = await post(`/api/rooms/${code}/action`, { playerId: A, type: 'stand' });
  check('api: fuera de turno se rechaza', outOfTurn.status === 400);
}
let finished = null;
let turn = dealt.data.turnId;
for (let guard = 0; guard < 4 && !finished; guard++) {
  const r = await post(`/api/rooms/${code}/action`, { playerId: turn, type: 'stand' });
  if (r.status === 200 && r.data.phase === 'finished') { finished = r; break; }
  const st = await get(`/api/rooms/${code}/state?player=${A}&v=0`);
  if (st.data.phase === 'finished') { finished = { data: st.data }; break; }
  turn = (turn === A) ? B : A;
}
check('api: ronda terminada', finished && finished.data.phase === 'finished');

const a = finished.data.players.find(p => p.id === A);
const b = finished.data.players.find(p => p.id === B);
const okA = a.chips === 1100 || a.chips === 900 || a.chips === 1000 || a.chips === 1150;
const okB = b.chips === 1050 || b.chips === 950 || b.chips === 1000 || b.chips === 1075;
check('api: fichas de A coherentes tras liquidar (' + a.chips + ')', okA);
check('api: fichas de B coherentes tras liquidar (' + b.chips + ')', okB);

// Long-polling: pedir estado con versión antigua debe devolver la actual
const stale = await get(`/api/rooms/${code}/state?player=${A}&v=1`);
check('api: long-poll devuelve versión actualizada', stale.data.version > 1);

// Salir
await post(`/api/rooms/${code}/leave`, { playerId: B });
const afterLeave = await get(`/api/rooms/${code}/state?player=${A}&v=999999`);
check('api: B deja la sala', afterLeave.data.players.length === 1);

// Acción split por HTTP: validación y estado público de ambas manos.
await post(`/api/rooms/${code}/action`, { playerId: A, type: 'start' });
await post(`/api/rooms/${code}/action`, { playerId: A, type: 'bet', amount: 50 });
rooms.get(code).deck = ['3', '2', '8', '10', '8', '8'].map(rank => ({ rank, suit: '♠' }));
await post(`/api/rooms/${code}/action`, { playerId: A, type: 'confirm' });
const split = await post(`/api/rooms/${code}/action`, { playerId: A, type: 'split' });
check('api: split crea dos manos visibles', split.status === 200 && split.data.players[0].splitHands.length === 2);
const repeat = await post(`/api/rooms/${code}/action`, { playerId: A, type: 'split' });
check('api: no permite volver a dividir', repeat.status === 400);
const second = await post(`/api/rooms/${code}/action`, { playerId: A, type: 'stand' });
check('api: turno continúa en mano 2', second.data.turnId === A && second.data.players[0].activeHand === 1);
await post(`/api/rooms/${code}/action`, { playerId: A, type: 'stand' });
await post(`/api/rooms/${code}/leave`, { playerId: A });
// Póker por HTTP, usando reloj adelantado solo dentro del motor de pruebas.
const pk = await post('/api/rooms', { name: 'Ana', game: 'poker', blindMinutes: 5 });
const pkCode = pk.data.code;
const pkA = pk.data.playerId;
const pkJoin = await post(`/api/rooms/${pkCode}/join`, { name: 'Bob' });
const pkB = pkJoin.data.playerId;
const pkRoom = rooms.get(pkCode);
check('api poker: crear y unirse con intervalo de ciegas', pk.status === 200 && pkJoin.status === 200 && pkRoom.blindMinutes === 5);
const pkStart = await post(`/api/rooms/${pkCode}/action`, { playerId: pkA, type: 'start' });
check('api poker: reparto privado y ciegas', pkStart.data.game === 'poker' && pkStart.data.players[1].cards.every(c => c === null) && pkStart.data.bigBlind === 20);
const tooEarly = await post(`/api/rooms/${pkCode}/action`, { playerId: pkA, type: 'call' });
check('api poker: bloquea acciones durante reparto', tooEarly.status === 400);
pkRoom.visualUntil = 0;
const wrongTurn = await post(`/api/rooms/${pkCode}/action`, { playerId: pkB, type: 'check' });
check('api poker: rechaza fuera de turno', wrongTurn.status === 400);
let pkState = pkRoom.stateFor(pkA);
for (let guard = 0; pkState.phase !== 'finished' && guard < 12; guard++) {
  pkRoom.visualUntil = 0;
  const view = pkRoom.stateFor(pkRoom.turnId);
  const action = await post(`/api/rooms/${pkCode}/action`, {
    playerId: pkRoom.turnId, type: view.toCall ? 'call' : 'check'
  });
  assert.equal(action.status, 200);
  pkState = action.data;
}
check('api poker: mano completa y conservación de fichas', pkState.phase === 'finished' && pkState.board.length === 5 && pkState.players.reduce((sum,p) => sum+p.chips,0) === 2000);
check('api poker: showdown revela manos', pkState.players.every(p => p.cards.every(c => c && c.rank)));
rooms.delete(pkCode);
server.close();
console.log(failures === 0 ? '\n🎉 Todos los tests e2e pasan' : `\n💥 ${failures} test(s) fallidos`);
process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
