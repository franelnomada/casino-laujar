// Test end-to-end de la API del servidor (HTTP real)
// Ejecutar con: node test/e2e.js
const assert = require('assert');
const { server } = require('../server.js');

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

const dealt = await post(`/api/rooms/${code}/action`, { playerId: B, type: 'confirm' });
check('api: al confirmar todos se reparte', dealt.data.phase === 'playing');
check('api: las cartas de todos son visibles',
  dealt.data.players[1].cards.length === 2 && dealt.data.players[0].cards.length === 2);

// Acciones de juego hasta resolver
await post(`/api/rooms/${code}/action`, { playerId: A, type: 'stand' });
const finished = await post(`/api/rooms/${code}/action`, { playerId: B, type: 'stand' });
check('api: ronda terminada', finished.data.phase === 'finished');

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

server.close();
console.log(failures === 0 ? '\n🎉 Todos los tests e2e pasan' : `\n💥 ${failures} test(s) fallidos`);
process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
