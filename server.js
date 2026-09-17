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

const rooms = new Map(); // code -> BlackjackRoom

// ---- Persistencia ligera: sobrevive a reinicios del proceso en la misma instancia ----
// (un redespliegue de Render crea instancia nueva con disco efímero: ahí las salas se pierden)
const PERSIST_PATH = path.join(os.tmpdir(), 'casino-laujar-rooms.json');
let persistTimer = null;

function persistRooms() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const data = {};
      for (const [code, room] of rooms) data[code] = room;
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(data));
    } catch (e) { /* sin disco disponible: seguimos solo en memoria */ }
  }, 500);
}

(function restoreRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
    for (const [code, data] of Object.entries(raw)) {
      const room = data.game === 'poker' ? new PokerRoom(code) : new BlackjackRoom(code);
      Object.assign(room, data);
      rooms.set(code, room);
    }
  } catch (e) { /* primera ejecución: no hay copia */ }
})();

// Guardar la sala cada vez que cambie su estado
for (const Room of [BlackjackRoom, PokerRoom]) {
  const touch = Room.prototype.touch;
  Room.prototype.touch = function () { touch.call(this); persistRooms(); };
}
setInterval(() => {
  for (const room of rooms.values()) if (room.game === 'poker') room.tick();
}, 1000).unref();

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function gcRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > IDLE_MS) rooms.delete(code);
  }
}
setInterval(gcRooms, 10 * 60 * 1000).unref();

function roomByPath(pathname) {
  const m = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4})/);
  if (!m) return null;
  const code = m[1].toUpperCase();
  return { code, room: rooms.get(code) || null };
}

async function handleApi(req, res, pathname, query) {
  // Crear sala
  if (req.method === 'POST' && pathname === '/api/rooms') {
    const body = await readBody(req);
    let code = genCode();
    while (rooms.has(code)) code = genCode(); // por si colisiona
    if (body.game && !['blackjack', 'poker'].includes(body.game)) return json(res, 400, { error: 'Juego no disponible.' });
    const room = body.game === 'poker' ? new PokerRoom(code, body) : new BlackjackRoom(code);
    rooms.set(code, room);
    const playerId = randomId();
    room.addPlayer(playerId, body.name);
    return json(res, 200, { code, playerId });
  }

  const { code, room } = roomByPath(pathname) || {};

  // Unirse
  if (req.method === 'POST' && pathname.endsWith('/join')) {
    if (!room) return json(res, 404, { error: 'Sala no encontrada. ¿Código correcto?' });
    const body = await readBody(req);
    const playerId = randomId();
    const added = room.addPlayer(playerId, body.name);
    if (!added.ok) return json(res, 400, { error: added.error });
    return json(res, 200, { code, playerId });
  }

  // Estado (long-polling: espera hasta que cambie la versión o 20 s)
  if (req.method === 'GET' && pathname.endsWith('/state')) {
    if (!room) return json(res, 404, { error: 'Sala no encontrada.' });
    const playerId = query.get('player') || '';
    const since = parseInt(query.get('v') || '0', 10);
    const send = () => json(res, 200, room.stateFor(playerId));
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

  // Acciones de juego
  if (req.method === 'POST' && pathname.endsWith('/action')) {
    if (!room) return json(res, 404, { error: 'Sala no encontrada.' });
    const body = await readBody(req);
    const playerId = body.playerId || '';
    let result = { ok: false, error: 'Acción desconocida.' };
    if (room.game === 'poker') result = room.action(playerId, body.type, body.amount);
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

  // Salir
  if (req.method === 'POST' && pathname.endsWith('/leave')) {
    if (room) {
      const body = await readBody(req);
      room.removePlayer(body.playerId || '');
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
        return json(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() });
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

module.exports = { server, rooms, BlackjackRoom };
