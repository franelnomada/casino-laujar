// Test de la réplica de salas en Firebase (RoomReplica + FirebaseRest)
// Ejecutar con: node test/rooms-remote.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BlackjackRoom } = require('../js/bj-engine.js');
const { FirebaseRest } = require('../js/firebase-rest.js');
const { RoomReplica } = require('../js/rooms-remote.js');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name);
  if (!cond) failures++;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// Stub de fetch global: graba las llamadas y sirve respuestas programadas
// (responder devuelve null → error de red, como en test/auth.js).
let calls = [];
let responder = null;
function installFetch() {
  calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { method: options.method || 'GET', url, body: options.body };
    calls.push(call);
    const r = responder ? responder(call, calls.length - 1) : null;
    if (!r) throw new Error('sin red');
    return { ok: r.ok, status: r.status, json: async () => r.data };
  };
}

const DB = 'https://demo.firebaseio.com';
const config = { baseUrl: DB, path: 'casino-laujar/rooms', secret: 'secreto', serviceAccount: null };

function makeReplica(opts = {}) {
  const rooms = new Map();
  const replica = new RoomReplica({
    config: 'config' in opts ? opts.config : config,
    persistPath: opts.persistPath,
    rooms,
    restoreRoom(code, data) {
      if (!data || typeof data !== 'object' || !Array.isArray(data.players)) return false;
      const room = new BlackjackRoom(code);
      Object.assign(room, data);
      rooms.set(code, room);
      return true;
    },
    saveMs: 10, pushMs: 10,
  });
  return { replica, rooms };
}

async function main() {

// ---------- Configuración ----------
check('config: sin FIREBASE_DB_URL no hay réplica',
  FirebaseRest.configFromEnv({}, 'FIREBASE_ROOMS_PATH', 'casino-laujar/rooms') === null);
const cfg = FirebaseRest.configFromEnv({ FIREBASE_DB_URL: DB + '///' }, 'FIREBASE_ROOMS_PATH', 'casino-laujar/rooms');
check('config: la URL se limpia de barras finales', cfg.baseUrl === DB);
const cfgPath = FirebaseRest.configFromEnv(
  { FIREBASE_DB_URL: DB, FIREBASE_ROOMS_PATH: '/otro/nodo/' }, 'FIREBASE_ROOMS_PATH', 'casino-laujar/rooms');
check('config: FIREBASE_ROOMS_PATH cambia la ruta y se recorta', cfgPath.path === 'otro/nodo');

// ---------- Solo local: sobrevive al reinicio del proceso ----------
const localPath = path.join(os.tmpdir(), 'casino-rooms-test-' + Date.now() + '.json');
const a = makeReplica({ config: null, persistPath: localPath });
check('réplica: sin Firebase el backend es local', a.replica.info().backend === 'local');
const room = new BlackjackRoom('ABCD');
room.addPlayer('p1', 'Ana');
a.rooms.set('ABCD', room);
a.replica.touch();
await wait(60);
check('réplica: la copia local se escribe tras tocar', fs.existsSync(localPath));
const b = makeReplica({ config: null, persistPath: localPath });
b.replica.init();
check('réplica: la sala sobrevive al reinicio (copia local)',
  !!b.rooms.get('ABCD') && b.rooms.get('ABCD').players.length === 1 && b.rooms.get('ABCD').players[0].name === 'Ana');

// ---------- Remota: push tras la carga inicial ----------
installFetch();
responder = () => ({ ok: true, status: 200, data: null });
const c = makeReplica({});
check('remoto: la carga inicial consulta Firebase', await c.replica.init() === true);
check('remoto: la primera llamada es un GET al nodo de salas',
  calls.length === 1 && calls[0].method === 'GET' && calls[0].url.startsWith(DB + '/casino-laujar/rooms.json?auth='));
c.rooms.set('ABCD', room);
c.replica.touch();
await wait(60);
const put = calls.find(x => x.method === 'PUT');
check('remoto: el cambio de sala se sube a Firebase', !!put && put.body.includes('ABCD') && put.body.includes('Ana'));

// ---------- Remota: no se escribe antes de la primera carga ----------
installFetch();
responder = () => null; // sin red
const d = makeReplica({});
check('remoto: carga inicial fallida se detecta', await d.replica.init() === false);
d.rooms.set('EFGH', new BlackjackRoom('EFGH'));
d.replica.touch();
await wait(60);
check('remoto: sin carga inicial no se machaca lo remoto (solo intentos de carga)',
  calls.length > 0 && calls.every(x => x.method === 'GET'));

// Vuelve la red: el push reintenta la carga, adopta lo remoto y escribe la unión
installFetch();
responder = (call) => call.method === 'GET'
  ? { ok: true, status: 200, data: { VIEJA: JSON.stringify({ code: 'VIEJA', game: 'poker', players: [{ id: 'z', hand: [] }], lastActivity: Date.now() + 99999, version: 99, message: 'desde remoto' }) } }
  : { ok: true, status: 200, data: null };
check('remoto: push reintenta la carga y escribe', await d.replica.pushRemote() === true);
check('remoto: lo remoto más nuevo se adopta en memoria',
  !!d.rooms.get('VIEJA') && d.rooms.get('VIEJA').message === 'desde remoto' && d.rooms.get('VIEJA').version === 99);
const put2 = calls.find(x => x.method === 'PUT');
check('remoto: el push sube la unión (remota + local)', !!put2 && put2.body.includes('VIEJA') && put2.body.includes('EFGH'));
check('remoto: cada sala viaja como cadena JSON (conserva arrays vacíos y nulls)',
  !!put2 && put2.body.includes('"VIEJA":"') && put2.body.includes('"EFGH":"'));

// ---------- Remota: la fusión no pisa lo local más nuevo ----------
// (formato objeto suelto: comprueba la compatibilidad con datos antiguos)
installFetch();
const localNewer = new BlackjackRoom('ABCD');
localNewer.version = 42;
localNewer.lastActivity = Date.now();
localNewer.players.push({ id: 'p1', name: 'Local' });
responder = (call) => call.method === 'GET'
  ? { ok: true, status: 200, data: { ABCD: { code: 'ABCD', players: [{ id: 'p2', name: 'Remota' }], lastActivity: Date.now() - 60000, version: 7 } } }
  : { ok: true, status: 200, data: null };
const e = makeReplica({});
e.rooms.set('ABCD', localNewer);
await e.replica.init();
check('remoto: una sala local más nueva no se pisa con la remota',
  e.rooms.get('ABCD').version === 42 && e.rooms.get('ABCD').players[0].name === 'Local');

// ---------- Remota: errores se reportan sin romper el juego ----------
installFetch();
responder = () => ({ ok: false, status: 500, data: null });
const f = makeReplica({});
await f.replica.init();
f.replica.touch();
await wait(60);
check('remoto: un error 500 queda registrado en remoteError',
  f.replica.info().remoteOk === false && f.replica.info().remoteError.includes('500'));

console.log(failures === 0 ? '\n🎉 Todos los tests de réplica de salas pasan' : `\n💥 ${failures} test(s) fallidos`);
process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });