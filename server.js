// ============================================================
//  Casino Night — servidor (estático + API de salas)
//  Sin dependencias. Uso:  node server.js
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BlackjackRoom, genCode, randomId } = require('./js/bj-engine.js');
const { PokerRoom } = require('./js/poker-engine.js');
const { RouletteRoom } = require('./js/roulette-engine.js');
const { UserStore } = require('./js/users.js');
const { TransactionLog } = require('./js/transactions.js');
const { FirebaseRest } = require('./js/firebase-rest.js');
const { RoomReplica } = require('./js/rooms-remote.js');
const { addChatMessage } = require('./js/room-chat.js');


const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const IDLE_MS = 2 * 60 * 60 * 1000; // 2 h sin actividad → la sala se borra

const rooms = new Map(); // code -> BlackjackRoom | PokerRoom | RouletteRoom

// ---- Cuentas de jugador: registro, sesiones y fichas ----
// USERS_FILE (o DATA_DIR) permite mover el fichero de cuentas fuera del temporal.
const USERS_PATH = process.env.USERS_FILE ||
  path.join(process.env.DATA_DIR || os.tmpdir(), 'casino-laujar-users.json');
const userStore = new UserStore(USERS_PATH);

// ---- Consola de transacciones del lobby: últimas 200 entradas ----
// Mismo mecanismo de guardado que las cuentas: JSON local
// (TX_FILE o DATA_DIR mueven el fichero) + réplica opcional en Firebase.
const TX_PATH = process.env.TX_FILE ||
  path.join(process.env.DATA_DIR || os.tmpdir(), 'casino-laujar-transactions.json');
const txLog = new TransactionLog(TX_PATH);

// ---- Persistencia de salas: disco local + réplica opcional en Firebase ----
// La copia local (JSON) sobrevive a reinicios del proceso en la misma
// instancia. La réplica remota (RoomReplica) sobrevive además a los
// redespliegues de Render: se activa con las mismas variables que las
// cuentas (FIREBASE_DB_URL + FIREBASE_DB_SECRET o FIREBASE_SERVICE_ACCOUNT)
// y vive en el nodo FIREBASE_ROOMS_PATH (por defecto casino-laujar/rooms).
const PERSIST_PATH = process.env.ROOMS_FILE ||
  path.join(process.env.DATA_DIR || os.tmpdir(), 'casino-laujar-rooms.json');

const roomsReplica = new RoomReplica({
  config: FirebaseRest.configFromEnv(process.env, 'FIREBASE_ROOMS_PATH', 'casino-laujar/rooms'),
  persistPath: PERSIST_PATH,
  rooms,
  restoreRoom(code, data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.players)) return false;
    try {
      let room;
      if (data.game === 'poker') room = new PokerRoom(code);
      else if (data.game === 'roulette') room = new RouletteRoom(code);
      else room = new BlackjackRoom(code);
      Object.assign(room, data);
      room.chat = Array.isArray(room.chat) ? room.chat : [];
      room.chatLastSent = new Map();
      rooms.set(code, room);
      return true;
    } catch (e) { return false; }
  },
});
roomsReplica.init();

// Guardar la sala cada vez que cambie su estado
for (const Room of [BlackjackRoom, PokerRoom, RouletteRoom]) {
  const touch = Room.prototype.touch;
  Room.prototype.touch = function () { touch.call(this); roomsReplica.touch(); };
}
setInterval(() => {
  for (const room of rooms.values()) if (room.game === 'poker') room.tick();
}, 1000).unref();

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const MAX_BODY = 64 * 1024; // 64 KB: sobra para nombres, fichas y acciones

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      data += chunk;
      if (data.length > MAX_BODY) { overflow = true; data = ''; } // cuerpo abusivo: se ignora
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function gcRooms() {
  const now = Date.now();
  let deleted = 0;
  for (const [code, room] of rooms) {
    const active = room.players.filter(p => !p.left).length;
    if (active === 0 || now - room.lastActivity > IDLE_MS) { rooms.delete(code); deleted++; }
  }
  if (deleted) roomsReplica.touch(); // sincroniza también la copia local/remota
}
setInterval(gcRooms, 10 * 60 * 1000).unref();

function roomByPath(pathname) {
  const m = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4})/);
  if (!m) return null;
  const code = m[1].toUpperCase();
  return { code, room: rooms.get(code) || null };
}

// Token de sesión: cabecera Authorization, cuerpo o query
function tokenFrom(req, body, query) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return (body && body.token) || bearer || query.get('token') || '';
}

// Asocia un jugador de mesa a su cuenta (para poder liquidar/expulsar después)
// y recuerda el saldo que traía al sentarse: al salir se compara con el saldo
// final para registrar la transacción en la consola pública (win/loss).
function linkAccount(room, playerId, token) {
  const p = typeof room.find === 'function' ? room.find(playerId) : null;
  if (!p) return;
  const user = token ? userStore.userForToken(token) : null; // cuenta activa y no baneada
  if (user) p.accountKey = user.key;
  p.entryBalance = user ? user.chips : p.chips; // invitado: sus fichas de mesa
}

// Saca de todas las salas a los jugadores de una cuenta (uso: ban)
function kickAccountFromRooms(accountKey) {
  for (const room of rooms.values()) {
    for (const p of (room.players || []).slice()) {
      if (p.accountKey === accountKey && !p.left) {
        const result = room.removePlayer(p.id);
        if (result && result.chips != null) userStore.setChipsByKey(accountKey, result.chips);
      }
    }
  }
}

// Panel de administración: /api/admin/...
async function handleAdmin(req, res, pathname, query) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  const token = tokenFrom(req, body, query);
  if (!userStore.isAdmin(token)) return json(res, 403, { error: 'No tienes permisos de administrador.' });

  if (req.method === 'GET' && pathname === '/api/admin/users') {
    return json(res, 200, { users: userStore.listUsers() });
  }

  if (req.method === 'GET' && pathname === '/api/admin/rooms') {
    const list = [];
    for (const r of rooms.values()) {
      const players = (r.players || []).filter(p => !p.left);
      if (!players.length) continue;
      list.push({
        code: r.code,
        game: r.game || 'blackjack',
        phase: r.phase,
        players: players.map(p => ({ playerId: p.id, name: p.name, chips: p.chips, accountKey: p.accountKey || null })),
      });
    }
    return json(res, 200, { rooms: list });
  }

  let m;
  if (req.method === 'POST' && (m = pathname.match(/^\/api\/admin\/users\/([^\/]+)\/(ban|unban)$/))) {
    const key = decodeURIComponent(m[1]).toLowerCase();
    const result = m[2] === 'ban' ? userStore.ban(token, key) : userStore.unban(token, key);
    if (!result.ok) return json(res, result.status || 400, { error: result.error });
    if (m[2] === 'ban') kickAccountFromRooms(key); // baneado: fuera de las mesas ya mismo
    return json(res, 200, { ok: true, user: result.user });
  }

  if (req.method === 'POST' && (m = pathname.match(/^\/api\/admin\/users\/([^\/]+)\/chips$/))) {
    const key = decodeURIComponent(m[1]).toLowerCase();
    const result = userStore.adjustChips(token, key, body.delta);
    if (!result.ok) return json(res, result.status || 400, { error: result.error });
    // Consola pública: solo si el saldo aplicado cambió de verdad
    if (result.delta) {
      const admin = userStore.userByToken(token);
      txLog.add({
        type: result.delta > 0 ? 'admin_grant' : 'admin_revoke',
        username: admin ? admin.name : 'Admin',
        target: result.user.name, // a quién se le aplicó el ajuste
        amount: Math.abs(result.delta),
        balanceAfter: result.after,
      });
    }
    return json(res, 200, { ok: true, user: result.user, delta: result.delta, before: result.before, after: result.after });
  }

  if (req.method === 'POST' && (m = pathname.match(/^\/api\/admin\/rooms\/([A-Za-z0-9]{4})\/kick$/))) {
    const room = rooms.get(m[1].toUpperCase());
    if (!room) return json(res, 404, { error: 'Sala no encontrada.' });
    const playerId = body.playerId || '';
    const p = typeof room.find === 'function' ? room.find(playerId) : null;
    if (!p || p.left) return json(res, 404, { error: 'Ese jugador no está en la sala.' });
    const accountKey = p.accountKey || null;
    const result = room.removePlayer(playerId);
    if (result && result.chips != null && accountKey) userStore.setChipsByKey(accountKey, result.chips);
    room.touch(); // sube la versión: el expulsado lo ve en su siguiente sondeo
    return json(res, 200, { ok: true, chips: result ? result.chips : null });
  }

  return json(res, 404, { error: 'Ruta de administración desconocida.' });
}

// Cuentas de jugador: /api/auth/...
async function handleAuth(req, res, pathname, query) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  const token = tokenFrom(req, body, query);

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const result = userStore.register(body.name, body.password, body.chips);
    if (!result.ok) return json(res, result.status || 400, { error: result.error });
    return json(res, 200, { ok: true, token: result.token, user: result.user });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const result = userStore.login(body.name, body.password);
    if (!result.ok) return json(res, result.status || 401, { error: result.error });
    return json(res, 200, { ok: true, token: result.token, user: result.user });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    userStore.logout(token);
    return json(res, 200, { ok: true });
  }

  if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/auth/me') {
    const user = userStore.userByToken(token);
    if (!user) return json(res, 401, { error: 'Sesión no válida. Vuelve a entrar.' });
    return json(res, 200, { ok: true, user });
  }

  if (req.method === 'POST' && pathname === '/api/auth/chips') {
    const before = userStore.userByToken(token);
    const result = userStore.setChips(token, body.chips);
    if (!result.ok) return json(res, result.status || 401, { error: result.error });
    // Fijar saldo exacto (sin delta): se registra comparando antes/después.
    // Tras un leave el saldo ya está liquidado y este envío no duplica la entrada.
    if (before && result.user.chips !== before.chips) {
      txLog.add({
        type: result.user.chips > before.chips ? 'win' : 'loss',
        username: result.user.name,
        game: null, // no viene de una mesa concreta
        amount: Math.abs(result.user.chips - before.chips),
        balanceAfter: result.user.chips,
      });
    }
    return json(res, 200, { ok: true, user: result.user });
  }

  // Ranking público: no pide sesión, solo devuelve nombre + fichas
  if (req.method === 'GET' && pathname === '/api/auth/leaderboard') {
    return json(res, 200, { ok: true, players: userStore.leaderboard(query.get('limit')) });
  }

  return json(res, 404, { error: 'Ruta de cuentas desconocida.' });
}

async function handleApi(req, res, pathname, query) {
  // Consola de transacciones (pública): últimas entradas, de nueva a vieja
  if (req.method === 'GET' && pathname === '/api/transactions') {
    return json(res, 200, { ok: true, transactions: txLog.list(query.get('limit')) });
  }

  // Cuentas de jugador
  if (pathname.startsWith('/api/auth/')) return handleAuth(req, res, pathname, query);

  // Panel de administración (protegido con isAdmin)
  if (pathname.startsWith('/api/admin/')) return handleAdmin(req, res, pathname, query);

  // Crear sala
  if (req.method === 'POST' && pathname === '/api/rooms') {
    const body = await readBody(req);
    let code = genCode();
    while (rooms.has(code)) code = genCode(); // por si colisiona
    if (body.game && !['blackjack', 'poker', 'roulette'].includes(body.game)) return json(res, 400, { error: 'Juego no disponible.' });
    const chips = userStore.clampChips(body.chips);
    const room = body.game === 'poker' ? new PokerRoom(code, body)
      : body.game === 'roulette' ? new RouletteRoom(code)
      : new BlackjackRoom(code);
    rooms.set(code, room);
    const playerId = randomId();
    room.addPlayer(playerId, body.name, chips);
    linkAccount(room, playerId, tokenFrom(req, body, query));
    return json(res, 200, { code, playerId });
  }

  // Lista de salas abiertas (para el lobby)
  if (req.method === 'GET' && pathname === '/api/rooms') {
    gcRooms();
    const list = [];
    for (const r of rooms.values()) {
      const players = (r.players || []).filter(p => !p.left);
      if (!players.length) continue;
      list.push({
        code: r.code,
        game: r.game || 'blackjack',
        phase: r.phase,
        players: players.length,
        names: players.map(p => p.name).slice(0, 6),
      });
    }
    list.sort((a, b) => b.players - a.players);
    return json(res, 200, { rooms: list });
  }

  const { code, room } = roomByPath(pathname) || {};

  // Unirse
  if (req.method === 'POST' && pathname.endsWith('/join')) {
    if (!room) return json(res, 404, { error: 'Sala no encontrada. ¿Código correcto?' });
    const body = await readBody(req);
    const playerId = randomId();
    const chips = body.chips != null ? userStore.clampChips(body.chips) : null;
    const added = room.addPlayer(playerId, body.name, chips);
    if (!added.ok) return json(res, 400, { error: added.error });
    linkAccount(room, playerId, tokenFrom(req, body, query));
    return json(res, 200, { code, playerId });
  }

  // Estado (long-polling: espera hasta que cambie la versión o 20 s)
  if (req.method === 'GET' && pathname.endsWith('/state')) {
    if (!room) return json(res, 404, { error: 'Sala no encontrada.' });
    const playerId = query.get('player') || '';
    const since = parseInt(query.get('v') || '0', 10);
    const send = () => {
      // Jugador que pide estado pero ya no está en la sala: fue expulsado (o se fue)
      const p = typeof room.find === 'function' ? room.find(playerId) : null;
      if (playerId && (!p || p.left)) {
        return json(res, 200, { kicked: true, game: room.game || 'blackjack',
          message: 'Un admin te ha expulsado de la mesa.' });
      }
      return json(res, 200, room.stateFor(playerId));
    };
    if (room.version > since) return send();
    const started = Date.now();
    const timer = setInterval(() => {
      if (room.version > since || Date.now() - started > 20000) {
        clearInterval(timer);
        req.removeAllListeners('close');
        send();
      }
    }, 250);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // Chat: mismo canal de versión que el resto del estado; no hay conexión extra.
  if (req.method === 'POST' && pathname.endsWith('/chat')) {
    if (!room) return json(res, 404, { error: 'Sala no encontrada.' });
    const body = await readBody(req);
    const result = addChatMessage(room, body.playerId, body.text);
    if (!result.ok) return json(res, result.status, { error: result.error });
    return json(res, 200, { ok: true, message: result.message });
  }

  // Acciones de juego
  if (req.method === 'POST' && pathname.endsWith('/action')) {
    if (!room) return json(res, 404, { error: 'Sala no encontrada.' });
    const body = await readBody(req);
    const playerId = body.playerId || '';
    let result = { ok: false, error: 'Acción desconocida.' };
    if (room.game === 'poker') result = room.action(playerId, body.type, body.amount);
    else if (room.game === 'roulette') {
      switch (body.type) {
        case 'bet': result = room.bet(playerId, body.betId, body.amount); break;
        case 'clearBet': result = room.clearBet(playerId); break;
        case 'spin': result = room.spin(); break;
      }
    }
    else switch (body.type) {
      case 'start': result = room.start(); break;
      case 'bet': result = room.bet(playerId, body.amount); break;
      case 'clearBet': result = room.clearBet(playerId); break;
      case 'confirm': result = room.confirm(playerId); break;
      case 'unconfirm': result = room.unconfirm(playerId); break;
      case 'hit': result = room.hit(playerId); break;
      case 'stand': result = room.stand(playerId); break;
      case 'split': result = room.split(playerId); break;
      case 'double': result = room.double(playerId); break;
    }
    if (!result.ok) return json(res, 400, { error: result.error });
    return json(res, 200, room.stateFor(playerId));
  }

  // Salir: se liquida el saldo final de la mesa en la cuenta/cartera.
  // Si el saldo cambió respecto al de antes de sentarse, la consola pública
  // registra la transacción (win/loss); si no cambió, no se registra nada
  // para no llenar la consola de ruido.
  if (req.method === 'POST' && pathname.endsWith('/leave')) {
    if (room) {
      const body = await readBody(req);
      const seated = typeof room.find === 'function' ? room.find(body.playerId || '') : null;
      const entryBalance = seated && seated.entryBalance != null ? seated.entryBalance : null;
      const result = room.removePlayer(body.playerId || '');
      const token = tokenFrom(req, body, query);
      let settled = null;
      if (result && result.chips != null && token) {
        const user = userStore.userByToken(token);
        if (user) settled = userStore.setChips(token, result.chips).user || null;
      }
      if (result && result.chips != null && entryBalance != null) {
        // Con cuenta liquidada: saldo de la cuenta. Invitado: sus fichas de mesa.
        const after = settled ? settled.chips : (seated.accountKey ? null : result.chips);
        const username = settled ? settled.name : (seated.accountKey ? null : seated.name);
        if (username && after !== entryBalance) {
          txLog.add({
            type: after > entryBalance ? 'win' : 'loss',
            username,
            game: room.game || 'blackjack',
            amount: Math.abs(after - entryBalance),
            balanceAfter: after,
          });
        }
      }
      return json(res, 200, { ok: true, chips: result && result.chips != null ? result.chips : null });
    }
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Ruta API desconocida.' });
}

const server = http.createServer(async (req, res) => {
  const [rawPath, rawQuery] = req.url.split('?');
  const pathname = decodeURIComponent(rawPath.split('?')[0]);
  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/ping') {
        return json(res, 200, { ok: true, rooms: rooms.size, accounts: userStore.count(), storage: userStore.storageInfo(), roomsStorage: roomsReplica.info(), uptime: process.uptime() });
      }
      return await handleApi(req, res, pathname, new URLSearchParams(rawQuery || ''));
    } catch (err) {
      return json(res, 500, { error: 'Error interno del servidor.' });
    }
  }
  // Estáticos
  const filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    let lanIp = 'localhost';
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) lanIp = net.address;
      }
    }
    console.log('🎰 Casino Night abierto:');
    console.log('   Local:  http://localhost:' + PORT);
    console.log('   Móvil:  http://' + lanIp + ':' + PORT + '   (misma red WiFi)');
  });
}

module.exports = { server, rooms, BlackjackRoom, userStore, roomsReplica, txLog };
