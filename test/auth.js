// Test de cuentas de jugador (UserStore + API HTTP)
// Ejecutar con: node test/auth.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-auth-test-'));
process.env.USERS_FILE = path.join(dir, 'server-users.json'); // antes de cargar el servidor
const { UserStore, MAX_FAILS } = require('../js/users.js');
const { server, rooms } = require('../server.js');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name);
  if (!cond) failures++;
}

async function main() {

// ---------- Cuentas: reglas y validaciones ----------
const file = path.join(dir, 'unit-users.json');
const store = new UserStore(file);
const created = store.register('Ana', 'secreta1');
check('cuentas: el registro devuelve token y usuario',
  created.ok && typeof created.token === 'string' && created.token.length > 20 && created.user.name === 'Ana');
check('cuentas: la cuenta nueva empieza con 1.000 fichas', created.user.chips === 1000);
check('cuentas: el registro no expone hash ni sal', !('hash' in created.user) && !('salt' in created.user));
check('cuentas: nombre repetido (otro tamaño) rechazado', store.register('aNa', 'secreta1').status === 409);
check('cuentas: nombre demasiado corto rechazado', store.register('A', 'secreta1').status === 400);
check('cuentas: nombre demasiado largo rechazado', store.register('Abcdefghijklmno', 'secreta1').status === 400);
check('cuentas: nombre con símbolos rechazado', store.register('Pepe@casa', 'secreta1').status === 400);
check('cuentas: contraseña corta rechazada', store.register('Beto', '12345').status === 400);
check('cuentas: contraseña larguísima rechazada', store.register('Beto', 'x'.repeat(65)).status === 400);
check('cuentas: el nombre se recorta y se normaliza', store.register('  Cris   Pérez  ', 'secreta1').user.name === 'Cris Pérez');
check('cuentas: fichas iniciales respetadas', store.register('Dani', 'secreta1', 2500).user.chips === 2500);
check('cuentas: fichas iniciales inválidas caen a 1.000', store.register('Eva', 'secreta1', 'no-numero').user.chips === 1000);

// ---------- Entrar y salir ----------
const ana = store.login('ANA', 'secreta1');
check('cuentas: entrar funciona sin distinguir mayúsculas', ana.ok && ana.user.name === 'Ana' && ana.user.chips === 1000);
check('cuentas: el token identifica al jugador', store.userByToken(ana.token).name === 'Ana');
check('cuentas: un token inventado no vale', store.userByToken('token-falso') === null);
check('cuentas: contraseña incorrecta rechazada', store.login('Ana', 'equivocada').status === 401);
check('cuentas: jugador inexistente rechazado', store.login('Nadie', 'secreta1').status === 401);
store.logout(ana.token);
check('cuentas: cerrar sesión invalida el token', store.userByToken(ana.token) === null);
const ana2 = store.login('Ana', 'secreta1');
check('cuentas: se puede volver a entrar tras salir', ana2.ok && ana2.token !== ana.token);

// ---------- Fuerza bruta ----------
const brute = new UserStore(path.join(dir, 'brute-users.json'));
brute.register('Fuerza', 'secreta1');
for (let i = 0; i < MAX_FAILS; i++) brute.login('Fuerza', 'malísima');
const locked = brute.login('Fuerza', 'secreta1');
check('cuentas: bloqueo temporal tras ' + MAX_FAILS + ' fallos', locked.status === 429 && brute.isLocked('fuerza'));

// ---------- Contraseñas guardadas ----------
const raw = fs.readFileSync(file, 'utf8');
check('cuentas: la contraseña no se guarda en claro', !raw.includes('secreta1'));
check('cuentas: cada cuenta tiene su propia sal y hash',
  store.users.get('ana').salt !== store.users.get('cris pérez').salt &&
  store.users.get('ana').hash !== store.users.get('cris pérez').hash);

// ---------- Fichas ----------
check('cuentas: guardar fichas actualiza el saldo', store.setChips(ana2.token, 4321).user.chips === 4321);
check('cuentas: fichas negativas rechazadas', store.setChips(ana2.token, -5).status === 400);
check('cuentas: fichas sin sesión rechazadas', store.setChips('token-falso', 10).status === 401);

// ---------- Clasificación pública ----------
store.setChips(ana2.token, 4321);
const board = store.leaderboard();
check('cuentas: la clasificación ordena por fichas de más a menos',
  board.length >= 2 && board[0].name === 'Ana' && board[0].chips === 4321);
check('cuentas: la clasificación solo expone nombre y fichas',
  board.every(p => Object.keys(p).sort().join(',') === 'chips,name'));
check('cuentas: el límite de la clasificación se respeta y se topa',
  store.leaderboard(2).length === 2 && store.leaderboard(9999).length === store.count());
check('cuentas: un límite raro cae al valor por defecto', store.leaderboard('no-numero').length === store.count());

// ---------- Persistencia en disco ----------
const reloaded = new UserStore(file);
check('cuentas: la cuenta sobrevive al reinicio', reloaded.login('Ana', 'secreta1').ok);
check('cuentas: la sesión sobrevive al reinicio', reloaded.userByToken(ana2.token).name === 'Ana');
check('cuentas: las fichas sobreviven al reinicio', reloaded.userByToken(ana2.token).chips === 4321);

// ---------- API HTTP ----------
const PORT = await new Promise(res => server.listen(0, () => res(server.address().port)));
const base = 'http://127.0.0.1:' + PORT;
async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: r.status, data: await r.json() };
}
async function get(path, token) {
  const r = await fetch(base + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: r.status, data: await r.json() };
}

const reg = await post('/api/auth/register', { name: 'Luisa', password: 'caballo7', chips: 700 });
check('api auth: registro devuelve token y fichas',
  reg.status === 200 && !!reg.data.token && reg.data.user.name === 'Luisa' && reg.data.user.chips === 700);
const token = reg.data.token;

const reg2 = await post('/api/auth/register', { name: 'Marta', password: 'caballo7' });
check('api auth: segunda cuenta registrada con 1.000 fichas', reg2.status === 200 && reg2.data.user.chips === 1000);
check('api auth: nombre repetido da 409', (await post('/api/auth/register', { name: 'LUISA', password: 'caballo7' })).status === 409);
check('api auth: contraseña corta da 400', (await post('/api/auth/register', { name: 'Otro', password: '123' })).status === 400);

const login = await post('/api/auth/login', { name: 'luisa', password: 'caballo7' });
check('api auth: entrar devuelve un token nuevo', login.status === 200 && !!login.data.token && login.data.token !== token);
check('api auth: contraseña incorrecta da 401', (await post('/api/auth/login', { name: 'Luisa', password: 'mal' })).status === 401);

check('api auth: me identifica al jugador', (await get('/api/auth/me', token)).data.user.name === 'Luisa');
check('api auth: me sin token da 401', (await get('/api/auth/me')).status === 401);
check('api auth: me con token inventado da 401', (await get('/api/auth/me?token=falso')).status === 401);

const chips = await post('/api/auth/chips', { chips: 1234 }, token);
check('api auth: las fichas se guardan en la cuenta', chips.status === 200 && chips.data.user.chips === 1234);
check('api auth: me devuelve las fichas nuevas', (await get('/api/auth/me', token)).data.user.chips === 1234);
check('api auth: fichas sin sesión dan 401', (await post('/api/auth/chips', { chips: 10 }, 'falso')).status === 401);
check('api auth: la clasificación es pública y ordena por fichas',
  await (async () => {
    const r = await get('/api/auth/leaderboard?limit=10');
    const players = r.data.players || [];
    return r.status === 200 && players.length >= 2 &&
      players[0].chips >= players[1].chips &&
      players.every(p => Object.keys(p).sort().join(',') === 'chips,name') &&
      players.some(p => p.name === 'Luisa' && p.chips === 1234);
  })());
check('api auth: la clasificación acepta límite y se topa', await (async () => {
  const one = await get('/api/auth/leaderboard?limit=1');
  const huge = await get('/api/auth/leaderboard?limit=9999');
  return one.data.players.length === 1 && huge.data.players.length >= 2 && huge.data.players.length <= 25;
})());
check('api auth: ruta de cuentas desconocida da 404', (await post('/api/auth/otra', {})).status === 404);
check('api auth: un cuerpo enorme no tumba el servidor',
  (await post('/api/auth/register', { name: 'Z'.repeat(100000), password: 'caballo7' })).status === 400);

// ---------- Persistencia remota (Firebase RTDB por REST, con stub de fetch) ----------
{
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), method: (options && options.method) || 'GET', body: options && options.body });
    return { ok: true, status: 200, json: async () => ({ users: [], sessions: {} }) };
  };
  try {
    const fakeEnv = {
      FIREBASE_DB_URL: 'https://casino-demo-default-rtdb.firebaseio.com/',
      FIREBASE_DB_SECRET: 'secreto-demo',
      FIREBASE_DB_PATH: '/mi/sitio/',
    };
    const cfg = UserStore.remoteConfigFromEnv(fakeEnv);
    check('firebase: la config normaliza URL y ruta',
      cfg && cfg.baseUrl === 'https://casino-demo-default-rtdb.firebaseio.com' && cfg.path === 'mi/sitio');
    const store = new UserStore(path.join(dir, 'remote-users.json'));
    store.remote = cfg; // inyectamos la config de prueba
    store._ready = store._initRemote();
    check('firebase: la carga inicial pide el documento con auth', await (async () => {
      const ok = await store.ready();
      return ok && calls.length === 1 && calls[0].url ===
        'https://casino-demo-default-rtdb.firebaseio.com/mi/sitio.json?auth=secreto-demo';
    })());
    store.register('Remoto', 'secreta1', 777);
    check('firebase: guardar programa una réplica remota (PUT)', await (async () => {
      const ok = await store.pushRemote();
      const last = calls[calls.length - 1];
      const doc = JSON.parse(last.body);
      return ok && last.method === 'PUT' && last.url.endsWith('/mi/sitio.json?auth=secreto-demo') &&
        doc.users.length === 1 && doc.users[0].name === 'Remoto' && doc.users[0].chips === 777;
    })());
    check('firebase: la fusión no pisa lo más nuevo con lo viejo', (() => {
      const before = store.users.get('remoto').chips;
      store.restoreSnapshot({ users: [{ key: 'remoto', name: 'Remoto', hash: 'x', salt: 'y', chips: 1, updatedAt: 0 }], sessions: {} });
      return store.users.get('remoto').chips === before;
    })());
    check('firebase: el ping informa del backend', store.storageInfo().backend === 'firebase' && store.storageInfo().remoteOk === true);
    const failing = new UserStore(path.join(dir, 'remote-fail.json'));
    failing.remote = { baseUrl: 'https://invalido.invalid', path: 'x', secret: '', serviceAccount: null };
    global.fetch = async () => { throw new Error('sin red'); };
    check('firebase: sin red el registro sigue funcionando en local', failing.register('Local', 'secreta1').ok && failing.users.has('local'));
    check('firebase: el error remoto queda registrado', await (async () => {
      await failing.pushRemote();
      return failing.remoteOk === false && failing.storageInfo().backend === 'firebase';
    })());
  } finally {
    global.fetch = realFetch;
  }

  // Seguridad: si la carga inicial falla, el push NO machaca lo remoto
  {
    const calls = []; // { method, body }
    const realFetch = global.fetch;
    let failGet = true;
    global.fetch = async (url, options) => {
      const method = (options && options.method) || 'GET';
      calls.push({ method, body: options && options.body });
      if (method === 'GET' && failGet) throw new Error('primera carga caída');
      return { ok: true, status: 200, json: async () => ({
        users: [{ key: 'vieja', name: 'Vieja', salt: 's', hash: 'h', chips: 500, updatedAt: 1 }],
        sessions: {},
      }) };
    };
    try {
      const unsafe = new UserStore(path.join(dir, 'unsafe-users.json'));
      unsafe.remote = UserStore.remoteConfigFromEnv({ FIREBASE_DB_URL: 'https://demo.firebaseio.com', FIREBASE_DB_SECRET: 'x' });
      unsafe.register('Nueva', 'secreta1'); // cambio local con la carga inicial aún fallida
      check('firebase: con la carga caída el push reintenta la carga y no escribe', await (async () => {
        const ok = await unsafe.pushRemote();
        return ok === false && calls.every(c => c.method === 'GET');
      })());
      failGet = false; // "vuelve" la red
      check('firebase: cuando la carga funciona, el push fusiona y ya escribe', await (async () => {
        const ok = await unsafe.pushRemote();
        const put = calls.find(c => c.method === 'PUT');
        const doc = put ? JSON.parse(put.body) : null;
        return ok === true && !!doc &&
          doc.users.some(u => u.key === 'vieja') && doc.users.some(u => u.key === 'nueva');
      })());
      check('firebase: lo remoto antiguo no se pierde al fusionar',
        unsafe.users.has('vieja') && unsafe.users.has('nueva'));
    } finally {
      global.fetch = realFetch;
    }
  }
}

const ping = await get('/api/ping');
check('api auth: el ping cuenta las cuentas', ping.status === 200 && ping.data.accounts >= 2 && typeof ping.data.rooms === 'number');

check('api auth: cerrar sesión responde ok', (await post('/api/auth/logout', {}, token)).status === 200);
check('api auth: el token deja de valer tras salir', (await get('/api/auth/me', token)).status === 401);

// Las salas siguen funcionando con el servidor de cuentas
const room = await post('/api/rooms', { name: 'Luisa' });
check('api auth: crear sala sigue funcionando', room.status === 200 && /^[A-Z0-9]{4}$/.test(room.data.code));
rooms.delete(room.data.code);

server.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows puede bloquear: da igual */ }
console.log(failures === 0 ? '\n🎉 Todos los tests de cuentas pasan' : `\n💥 ${failures} test(s) fallidos`);
process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });

