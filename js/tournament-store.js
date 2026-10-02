// ============================================================
//  L&F Casino Club — torneos de póker.
//
//  Guarda la configuración de cada torneo (la edita el admin
//  desde el panel), las solicitudes de los jugadores y su
//  estado (pendiente / aceptada / rechazada / cancelada).
//
//  Persistencia en dos niveles, igual que las apuestas:
//   1) JSON local (sobrevive a reinicios del proceso).
//   2) Réplica opcional en Firebase RTDB por REST (sobrevive a
//      redespliegues) con FIREBASE_DB_URL + FIREBASE_DB_SECRET
//      o FIREBASE_SERVICE_ACCOUNT, en FIREBASE_TOURNAMENTS_PATH
//      (por defecto casino-laujar/tournaments).
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FirebaseRest } = require('./firebase-rest.js');
const { TournamentRoom, TournamentTables, MAX_SEATS, TOURNAMENT_PHASES, START_MODES, int } = require('./tournament-engine.js');

const DEFAULT_FILE = 'casino-laujar-tournaments.json';
const LIMITS = { name: 60, description: 400, prizes: 9, prizeLabel: 40 };
const REQUEST_STATUSES = ['pendiente', 'aceptada', 'rechazada', 'cancelada'];
const PRIZE_FORMATS = ['porcentaje', 'fichas'];

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').slice(0, max);
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function resultError(status, error) { return { ok: false, status, error }; }

class TournamentStore {
  constructor({ filePath, userStore, txLog } = {}) {
    this.filePath = filePath || path.join(process.env.DATA_DIR || os.tmpdir(), DEFAULT_FILE);
    this.userStore = userStore;
    this.txLog = txLog;
    this.tournaments = new Map(); // id → definición del torneo
    this.requests = [];           // solicitudes de participación
    this.live = new Map();        // id → TournamentRoom en marcha
    this.remote = FirebaseRest.configFromEnv(process.env, 'FIREBASE_TOURNAMENTS_PATH', 'casino-laujar/tournaments');
    this.remoteOk = false;
    this.remoteError = '';
    this._remoteLoaded = !this.remote;
    this._pushing = false;
    this.load();
    this._ready = this.remote ? this._initRemote() : Promise.resolve(false);
  }

  ready() { return this._ready || Promise.resolve(false); }
  storageInfo() {
    return {
      backend: this.remote ? 'firebase' : 'local',
      remoteOk: this.remoteOk,
      remoteError: this.remote ? this.remoteError : 'sin configurar',
    };
  }

  // ---------- Validación de la configuración ----------
  // strictInt rechaza en vez de recortar: si el admin escribe 40 jugadores,
  // debe ver el error y no un torneo truncado a 9 en silencio.
  // Un campo vacío (undefined o '') toma el valor por defecto; si no lo hay,
  // se avisa de que el campo es obligatorio.
  strictInt(value, min, max, label, fallback) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return fallback == null ? label + ' es obligatorio.' : fallback;
    if (!/^-?\d+$/.test(raw)) return label + ' debe ser un número entero.';
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      return label + ' debe estar entre ' + min + ' y ' + max + '.';
    }
    return n;
  }

  // Acepta la fecha del <input type="datetime-local"> ("2026-10-12T20:30"),
  // una fecha simple ("2026-10-12", que se interpreta a las 20:00) o un
  // timestamp en milisegundos. Devuelve el instante o el texto del error.
  parseStartsAt(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return 'Indica la fecha y hora del torneo.';
    if (/^\d{10,13}$/.test(raw)) return Number(raw.length === 10 ? raw + '000' : raw);
    // Si solo se elige el día (sin hora), se usa las 20:00 como hora por defecto.
    const text = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T20:00' : raw;
    const when = Date.parse(text);
    if (!Number.isFinite(when)) return 'La fecha del torneo no es válida.';
    if (when < Date.now() - 60000) return 'La fecha del torneo ya ha pasado.';
    return when;
  }

  validate(input) {
    const src = input || {};
    const name = cleanText(src.name, LIMITS.name);
    if (!name) return 'El torneo necesita un nombre.';
    const buyIn = this.strictInt(src.buyIn, 0, 10000000, 'La cuota de inscripción');
    if (typeof buyIn === 'string') return buyIn;
    const startChips = this.strictInt(src.startChips, 100, 10000000, 'Las fichas iniciales');
    if (typeof startChips === 'string') return startChips;
    const smallBlind = this.strictInt(src.smallBlind, 1, 1000000, 'La ciega pequeña');
    if (typeof smallBlind === 'string') return smallBlind;
    const maxPlayers = this.strictInt(src.maxPlayers, 2, MAX_SEATS, 'El número de jugadores');
    if (typeof maxPlayers === 'string') return maxPlayers;
    const maxLevels = this.strictInt(src.maxLevels, 1, 100, 'El número de niveles', 20);
    if (typeof maxLevels === 'string') return maxLevels;
    const levelMinutes = this.strictInt(src.levelMinutes, 1, 240, 'La duración de cada nivel', 10);
    if (typeof levelMinutes === 'string') return levelMinutes;
    let minPlayers = this.strictInt(src.minPlayers, 2, MAX_SEATS, 'El mínimo de jugadores', Math.min(2, maxPlayers));
    if (typeof minPlayers === 'string') return minPlayers;
    // (el mínimo se compara con el aforo total, más abajo, cuando se saben
    //  cuántas mesas hay)

    // Mesas múltiples: hasta maxTables mesas de maxPlayers asientos cada una.
    const maxTables = this.strictInt(src.maxTables, 1, 20, 'El número de mesas', 1);
    if (typeof maxTables === 'string') return maxTables;
    // El aforo total son todas las mesas juntas: el mínimo se compara con eso,
    // no con los asientos de una sola mesa.
    const capacity = maxTables * maxPlayers;
    if (minPlayers > capacity) {
      return 'El mínimo de jugadores (' + minPlayers + ') no cabe en ' + maxTables +
        (maxTables === 1 ? ' mesa de ' : ' mesas de ') + maxPlayers + ' (' + capacity + ' plazas).';
    }
    // Redistribuir jugadores cada X niveles (0 = solo cuando toca mesa final).
    const moveEveryLevels = this.strictInt(src.moveEveryLevels, 0, 100, 'Cada cuántas niveles se equilibran las mesas', 0);
    if (typeof moveEveryLevels === 'string') return moveEveryLevels;
    if (moveEveryLevels > 0 && moveEveryLevels >= maxLevels) {
      return 'Las mesas no se pueden equilibrar cada ' + moveEveryLevels + ' niveles si el torneo solo tiene ' + maxLevels + '.';
    }
    const ante = this.strictInt(src.ante, 0, 1000000, 'El ante', 0);
    if (typeof ante === 'string') return ante;

    // Cuándo arranca: a mano, al alcanzar el mínimo de jugadores o en una
    // fecha fija. Se acepta el checkbox antiguo (autoStart) por compat.
    let startMode = START_MODES.includes(src.startMode) ? src.startMode
      : (src.startMode ? '' : (src.autoStart === false ? 'manual' : 'jugadores'));
    if (!startMode) return 'Elige cómo arranca el torneo.';
    let startsAt = null;
    if (startMode === 'programado') {
      startsAt = this.parseStartsAt(src.startsAt);
      if (typeof startsAt === 'string') return startsAt;
      // Un torneo programado arranca a su hora aunque no haya llegado al
      // mínimo, así que el mínimo deja de ser una condición de arranque.
      minPlayers = 1;
    }
    const breakEvery = this.strictInt(src.breakEvery, 0, 50, 'El descanso cada', 0);
    if (typeof breakEvery === 'string') return breakEvery;
    const breakMinutes = this.strictInt(src.breakMinutes, 1, 60, 'La duración del descanso', 3);
    if (typeof breakMinutes === 'string') return breakMinutes;
    const lateLevels = this.strictInt(src.lateLevels, 0, 100, 'El registro tardío hasta el nivel', 0);
    if (typeof lateLevels === 'string') return lateLevels;

    const prizes = [];
    for (const item of (Array.isArray(src.prizes) ? src.prizes : [])) {
      const position = int(item && item.position, 1, MAX_SEATS, 0);
      const value = Number(item && item.value);
      const format = PRIZE_FORMATS.includes(item && item.format) ? item.format : 'porcentaje';
      const label = cleanText(item && item.label, LIMITS.prizeLabel);
      if (!position || !Number.isFinite(value) || value <= 0) continue;
      if (format === 'porcentaje' && value > 100) return 'Los premios en % no pueden pasar del 100.';
      if (format === 'fichas' && value > 10000000) return 'Ese premio en fichas es demasiado alto.';
      prizes.push({ position, format, value, label });
      if (prizes.length >= LIMITS.prizes) break;
    }
    prizes.sort((a, b) => a.position - b.position);
    const percentSum = prizes.filter(p => p.format === 'porcentaje').reduce((n, p) => n + p.value, 0);
    if (percentSum > 100) return 'Los premios en % suman ' + percentSum + '%. No pueden pasar del 100%.';

    return {
      name,
      description: cleanText(src.description, LIMITS.description),
      game: 'poker',
      buyIn, startChips, smallBlind,
      bigBlind: smallBlind * 2,
      ante,
      levelMinutes,
      maxLevels,
      maxPlayers,
      minPlayers,
      maxTables,
      moveEveryLevels,
      breakEvery,
      breakMinutes,
      lateRegistration: !!src.lateRegistration,
      lateLevels,
      startMode,
      startsAt,
      autoStart: src.autoStart !== false,   // compat: torneos antiguos sin startMode
      prizes,
      visibility: src.visibility === 'privado' ? 'privado' : 'publico',
      status: 'registro',
    };
  }

  // ---------- Persistencia ----------
  snapshot() {
    return {
      tournaments: [...this.tournaments.values()],
      requests: this.requests,
      live: [...this.live.values()].map(room => room.serialize ? room.serialize() : copy(room)),
    };
  }
  saveLocal() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot()));
    } catch (e) { /* seguimos solo en memoria */ }
  }
  save() { this.saveLocal(); this._pushRemote(); }
  _pushRemote() {
    if (!this.remote || this._pushing || !this._remoteLoaded) return;
    this._pushing = true;
    Promise.resolve(FirebaseRest.put(this.remote, this.snapshot()))
      .then(() => { this.remoteOk = true; this.remoteError = ''; })
      .catch(e => { this.remoteOk = false; this.remoteError = String((e && e.message) || e).slice(0, 160); })
      .finally(() => { this._pushing = false; });
  }
  mergeDocuments(a, b) {
    const byId = new Map();
    for (const t of [...((a && a.tournaments) || []), ...((b && b.tournaments) || [])]) {
      if (!t || !t.id) continue;
      const old = byId.get(t.id);
      if (!old || (t.updatedAt || 0) >= (old.updatedAt || 0)) byId.set(t.id, copy(t));
    }
    const reqById = new Map();
    for (const r of [...((a && a.requests) || []), ...((b && b.requests) || [])]) {
      if (!r || !r.id) continue;
      const old = reqById.get(r.id);
      if (!old || (r.updatedAt || 0) >= (old.updatedAt || 0)) reqById.set(r.id, copy(r));
    }
    const live = ((a && a.live) || []).concat((b && b.live) || []);
    return { tournaments: [...byId.values()], requests: [...reqById.values()], live };
  }
  load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) || {}; } catch (e) { return; }
    this.applyDocument(raw);
  }
  applyDocument(raw) {
    for (const t of (raw && raw.tournaments) || []) {
      if (t && t.id && t.name && !this.tournaments.has(t.id)) this.tournaments.set(t.id, copy(t));
    }
    for (const r of (raw && raw.requests) || []) {
      if (r && r.id && this.tournaments.has(r.tournamentId) && REQUEST_STATUSES.includes(r.status)) this.requests.push(copy(r));
    }
    // Las mesas en marcha se recuperan tal cual: si el servidor se reinicia
    // a mitad de torneo, la partida continúa con las mismas fichas.
    for (const data of (raw && raw.live) || []) {
      if (!data || !data.id || !this.tournaments.has(data.id)) continue;
      const tournament = this.tournaments.get(data.id);
      try {
        if (data.kind === 'tables' && Array.isArray(data.tables)) {
          this.live.set(data.id, TournamentTables.restore(data, tournament));
          continue;
        }
        // Formato antiguo: una sola mesa suelta.
        if (!Array.isArray(data.players)) continue;
        const room = new TournamentTables(tournament.id, tournament);
        const table = TournamentRoom.restore(data, Object.assign({}, tournament, {
          owner: room, tableNumber: data.tableNumber || 1,
        }));
        table.standings = room.standings;
        room.tables = [table];
        room.prizePool = data.prizePool || 0;
        room.tournamentPhase = data.tournamentPhase || 'registro';
        room.startedAt = data.startedAt == null ? null : data.startedAt;
        room.version = data.version || 1;
        this.live.set(tournament.id, room);
      } catch (e) { /* mesa corrupta: se ignora */ }
    }
  }
  async _initRemote() {
    try {
      const remote = await FirebaseRest.get(this.remote, '');
      this.applyDocument(this.mergeDocuments(this.snapshot(), remote || {}));
      this.remoteOk = true;
      this._remoteLoaded = true;
      this.saveLocal();
      return true;
    } catch (e) {
      this.remoteOk = false;
      this.remoteError = String((e && e.message) || e).slice(0, 160);
      return false;
    }
  }

  // ---------- Definiciones (admin) ----------
  newId() { return crypto.randomBytes(8).toString('hex'); }

  create(input) {
    const config = this.validate(input);
    if (typeof config === 'string') return resultError(400, config);
    const now = Date.now();
    const tournament = Object.assign({ id: this.newId(), createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, winner: null, results: [] }, config);
    this.tournaments.set(tournament.id, tournament);
    this.save();
    return { ok: true, tournament: copy(tournament) };
  }

  update(id, input) {
    const tournament = this.tournaments.get(id);
    if (!tournament) return resultError(404, 'Torneo no encontrado.');
    if (tournament.status === 'finalizado') return resultError(409, 'Un torneo finalizado ya no se edita.');
    const config = this.validate(input);
    if (typeof config === 'string') return resultError(400, config);
    // Con jugadores ya sentados no se tocan las fichas de partida.
    const seated = this.seatedCount(id);
    if (seated && config.startChips !== tournament.startChips) {
      return resultError(409, 'No se pueden cambiar las fichas iniciales con jugadores en la mesa.');
    }
    Object.assign(tournament, config, { status: tournament.status, updatedAt: Date.now() });
    const room = this.live.get(id);
    if (room && !room.startedAt) Object.assign(room, {
      maxPlayers: tournament.maxPlayers, startChips: tournament.startChips,
      baseSmallBlind: tournament.smallBlind, smallBlind: tournament.smallBlind,
      bigBlind: tournament.bigBlind, baseAnte: tournament.ante, ante: tournament.ante,
      levelMinutes: tournament.levelMinutes, maxLevels: tournament.maxLevels,
    });
    this.save();
    return { ok: true, tournament: copy(tournament) };
  }

  remove(id) {
    const tournament = this.tournaments.get(id);
    if (!tournament) return resultError(404, 'Torneo no encontrado.');
    if (tournament.status === 'en_curso') return resultError(409, 'No se puede borrar un torneo en marcha.');
    this.live.delete(id);
    this.tournaments.delete(id);
    this.requests = this.requests.filter(r => r.tournamentId !== id);
    this.save();
    return { ok: true };
  }

  // ---------- Solicitudes (jugadores) ----------
  request(token, tournamentId) {
    const user = this.userStore.userForToken(token);
    if (!user) return resultError(401, 'Inicia sesión para apuntarte al torneo.');
    const tournament = this.tournaments.get(String(tournamentId || ''));
    if (!tournament) return resultError(404, 'Torneo no encontrado.');
    if (tournament.visibility === 'privado' && !user.isAdmin) {
      return resultError(403, 'Este torneo es privado: pídele al admin una invitación.');
    }
    if (tournament.status === 'finalizado') return resultError(409, 'Ese torneo ya ha terminado.');
    const room = this.roomFor(tournamentId);
    if (room && !room.canRegister()) return resultError(409, 'El registro de este torneo está cerrado.');
    if (room && !room.openSeats()) return resultError(409, 'No quedan asientos libres en este torneo.');
    const existing = this.requests.find(r => r.tournamentId === tournament.id && r.accountKey === user.key && r.status !== 'rechazada' && r.status !== 'cancelada');
    if (existing) return { ok: true, request: copy(existing), duplicate: true };
    const now = Date.now();
    const entry = {
      id: this.newId(), tournamentId: tournament.id, accountKey: user.key, username: user.name,
      status: 'pendiente', createdAt: now, updatedAt: now, decidedAt: null, playerId: null, note: '',
    };
    this.requests.push(entry);
    this.save();
    return { ok: true, request: copy(entry) };
  }

  cancelRequest(token, tournamentId) {
    const user = this.userStore.userForToken(token);
    if (!user) return resultError(401, 'Inicia sesión para gestionar tu solicitud.');
    const entry = this.requests.find(r => r.tournamentId === String(tournamentId) && r.accountKey === user.key && r.status === 'pendiente');
    if (!entry) return resultError(404, 'No tienes ninguna solicitud pendiente en ese torneo.');
    entry.status = 'cancelada';
    entry.updatedAt = Date.now();
    entry.decidedAt = entry.updatedAt;
    this.save();
    return { ok: true, request: copy(entry) };
  }

  // ---------- Decisión del admin sobre las solicitudes ----------
  decide(adminToken, requestId, accept) {
    if (!this.userStore.isAdmin(adminToken)) return resultError(403, 'No tienes permisos de administrador.');
    const entry = this.requests.find(r => r.id === String(requestId || ''));
    if (!entry) return resultError(404, 'Solicitud no encontrada.');
    if (entry.status !== 'pendiente') return resultError(409, 'Esa solicitud ya se resolvió.');
    const tournament = this.tournaments.get(entry.tournamentId);
    if (!tournament) return resultError(404, 'Torneo no encontrado.');

    if (!accept) {
      entry.status = 'rechazada';
      entry.updatedAt = Date.now();
      entry.decidedAt = entry.updatedAt;
      this.save();
      return { ok: true, request: copy(entry) };
    }

    const room = this.ensureRoom(tournament);
    const user = this.userStore.users.get(entry.accountKey);
    if (!user) return resultError(404, 'La cuenta del jugador ya no existe.');
    if (!room.openSeats()) return resultError(409, 'No quedan asientos libres en este torneo.');
    if (user.chips < tournament.buyIn) {
      return resultError(400, user.name + ' ya no tiene fichas para la cuota de ' + tournament.buyIn + '.');
    }
    // Se cobra la cuota y se sienta con las fichas iniciales del torneo.
    const paid = this.userStore.adjustChipsByKey(user.key, -tournament.buyIn);
    if (!paid.ok) return paid;
    const playerId = 'tp_' + entry.id;
    const added = room.addPlayer(playerId, user.name, { buyIn: tournament.buyIn, accountKey: user.key });
    if (!added.ok) {
      this.userStore.adjustChipsByKey(user.key, tournament.buyIn); // se devuelve la cuota
      return resultError(409, added.error);
    }
    entry.status = 'aceptada';
    entry.playerId = playerId;
    entry.buyIn = tournament.buyIn;
    entry.updatedAt = Date.now();
    entry.decidedAt = entry.updatedAt;
    if (this.txLog) {
      this.txLog.add({
        type: 'tournament_buyin', username: user.name, game: 'tournament',
        amount: tournament.buyIn, balanceAfter: paid.after,
        message: user.name + ' se ha unido a ' + tournament.name + ' (' + tournament.buyIn + ' fichas de inscripción)',
      });
    }
    this.save();
    this.maybeAutoStart(tournament);
    return { ok: true, request: copy(entry), playerId };
  }

  // ---------- Mesa en juego ----------
  roomFor(id) { return this.live.get(String(id)) || null; }

  ensureRoom(tournament) {
    let room = this.live.get(tournament.id);
    if (room) return room;
    // Siempre un contenedor: con maxTables=1 se comporta como una sola mesa.
    room = new TournamentTables(tournament.id, tournament);
    this.live.set(tournament.id, room);
    return room;
  }

  // Jugadores sentados en todo el torneo (todas las mesas).
  seatedCount(id) {
    const room = this.roomFor(id);
    return room ? room.seatedCount() : 0;
  }

  // ---------- Arranque automático ----------
  // Modo efectivo. Un torneo guardado antes de que existiera startMode solo
  // tiene autoStart, así que el modo se deduce de ahí.
  startModeOf(tournament) {
    if (tournament.startMode) return tournament.startMode;
    return tournament.autoStart === false ? 'manual' : 'jugadores';
  }

  // Arranca solo si toca por número de jugadores o por fecha. En modo
  // programado da igual cuántos haya inscritos: arranca a su hora.
  maybeAutoStart(tournament, now = Date.now()) {
    const room = this.roomFor(tournament.id);
    if (!room || room.tournamentPhase !== 'registro' || room.startedAt !== null) return false;
    const mode = this.startModeOf(tournament);
    if (mode === 'programado') {
      if (!tournament.startsAt || now < tournament.startsAt) return false;
      // A la hora marcada, pero solo con alguien sentado: una mesa vacía no
      // puede repartir. Si aún no hay ninguno, arranca en cuanto se acepte a uno.
      if (!room.seatedCount()) return false;
    } else if (mode === 'jugadores') {
      if (room.seatedCount() < (tournament.minPlayers || 2)) return false;
      // No se arranca a medias: si el admin aún tiene solicitudes por
      // decidir y quedan plazas libres, el torneo espera a que decida.
      const pending = this.requests.filter(r =>
        r.tournamentId === tournament.id && r.status === 'pendiente').length;
      if (pending > 0 && room.openSeats() > 0) return false;
    } else {
      return false;   // manual: solo el admin con "Arrancar ahora"
    }
    this.beginTournament(tournament, room, now);
    return true;
  }

  beginTournament(tournament, room, now = Date.now()) {
    // En modo programado la mesa arranca por su cuenta aunque haya uno solo:
    // el contenedor pone el reloj en marcha y espera al segundo jugador.
    if (this.startModeOf(tournament) === 'programado') {
      room.startMode = 'programado';
      room.startsAt = tournament.startsAt || null;
      const result = room.beginScheduled(now);
      if (!result.ok) return false;
      tournament.status = 'en_curso';
      tournament.startedAt = room.startedAt;
      tournament.updatedAt = now;
      this.save();
      return true;
    }
    if (!this.start(tournament.id, now).ok) return false;
    const seated = this.roomFor(tournament.id).seatedCount();
    room.message = 'El torneo ha arrancado: ' + seated + ' jugadores.';
    return true;
  }

  // El contenedor reparte las ciegas y el bote entre todas sus mesas.
  syncRoom(room, now = Date.now()) {
    if (room.syncTables) room.syncTables();
    if (room.tables) for (const table of room.tables) table.syncNow = now;
    return room;
  }

  start(id, now = Date.now()) {
    const tournament = this.tournaments.get(String(id));
    if (!tournament) return resultError(404, 'Torneo no encontrado.');
    const room = this.ensureRoom(tournament);
    if (room.seatedCount() < 2) return resultError(400, 'Hacen falta al menos dos jugadores sentados.');
    if (room.tournamentPhase === 'en_curso' || room.tournamentPhase === 'descanso') {
      return resultError(409, 'El torneo ya está en marcha.');
    }
    // El contenedor decide el nivel y reparte; cada mesa reparte su mano.
    if (room.startDealt(now) === 0) return resultError(400, 'Hacen falta al menos dos jugadores sentados.');
    room.tournamentPhase = 'en_curso';
    room.startedAt = room.startedAt == null ? now : room.startedAt;
    tournament.status = 'en_curso';
    tournament.startedAt = room.startedAt;
    tournament.updatedAt = now;
    this.save();
    this.settleIfFinished(tournament, now);
    return { ok: true, tournament: copy(tournament) };
  }

  // El admin corta el torneo: gana quien más fichas tenga.
  forceFinish(id, now = Date.now()) {
    const tournament = this.tournaments.get(String(id));
    if (!tournament) return resultError(404, 'Torneo no encontrado.');
    const room = this.roomFor(id);
    if (!room) return resultError(400, 'Este torneo todavía no tiene mesa.');
    if (room.tournamentPhase === 'finalizado') return resultError(409, 'El torneo ya ha terminado.');
    room.forceFinish(now);
    this.save();
    return this.settle(tournament, now);
  }

  // Reparto de premios: solo una vez por torneo.
  settleIfFinished(tournament, now = Date.now()) {
    const room = this.roomFor(tournament.id);
    if (!room || room.tournamentPhase !== 'finalizado') return null;
    if (tournament.status === 'finalizado') return null;
    this.save();
    return this.settle(tournament, now);
  }

  settle(tournament, now = Date.now()) {
    const room = this.roomFor(tournament.id);
    if (!room) return resultError(400, 'Este torneo todavía no tiene mesa.');
    const pool = room.prizePool;
    const byPlace = new Map(this.computePayouts(tournament, pool).map(p => [p.position, p]));
    const standings = room.standings.slice().sort((a, b) => a.place - b.place);
    const results = [];
    let paidTotal = 0;

    for (const row of standings) {
      const prize = (byPlace.get(row.place) || {}).amount || 0;
      let paid = 0;
      if (prize > 0 && row.accountKey) {
        const adjusted = this.userStore.adjustChipsByKey(row.accountKey, prize);
        if (adjusted.ok) {
          paid = adjusted.delta;
          paidTotal += paid;
          if (this.txLog) {
            this.txLog.add({
              type: 'tournament_prize', username: row.name, game: 'tournament',
              amount: paid, balanceAfter: adjusted.after,
              message: '🏆 ' + row.name + ' gana ' + paid + ' fichas en ' + tournament.name + ' (' + row.place + 'º puesto)',
            });
          }
        }
      }
      results.push({ name: row.name, place: row.place, prize: paid, accountKey: row.accountKey || null });
    }

    tournament.status = 'finalizado';
    tournament.finishedAt = now;
    tournament.updatedAt = now;
    tournament.results = results;
    tournament.prizePool = pool;
    tournament.paidOut = paidTotal;
    tournament.winner = results.length ? results[0] : null;
    this.save();
    return { ok: true, tournament: copy(tournament), paid: paidTotal };
  }

  // Premios en % sobre el bote o en fichas fijas. Lo que sobre tras aplicar
  // los porcentajes se reparte a partes iguales entre los propios premios en %,
  // para que el bote no se quede fichas por el camino. Los premios en fichas
  // son fijos: no absorben el sobrante.
  computePayouts(tournament, pool) {
    const percent = (tournament.prizes || [])
      .filter(prize => prize.format !== 'fichas')
      .map(prize => ({
        position: prize.position,
        label: prize.label,
        amount: Math.floor(pool * prize.value / 100),
      }));
    const used = percent.reduce((n, prize) => n + prize.amount, 0);
    const extra = percent.length ? Math.floor(Math.max(0, pool - used) / percent.length) : 0;
    if (extra > 0) percent.forEach(prize => { prize.amount += extra; });
    const fixed = (tournament.prizes || [])
      .filter(prize => prize.format === 'fichas')
      .map(prize => ({
        position: prize.position,
        label: prize.label,
        amount: Math.floor(prize.value),
      }));
    return percent.concat(fixed)
      .filter(prize => prize.amount > 0)
      .sort((a, b) => a.position - b.position);
  }

  // ---------- Consultas ----------
  publicList(token) {
    const user = token ? this.userStore.userForToken(token) : null;
    return [...this.tournaments.values()]
      .filter(t => t.visibility === 'publico' || (user && (user.isAdmin ||
        this.requests.some(r => r.tournamentId === t.id && r.accountKey === user.key))))
      .map(t => this.view(t, user));
  }

  adminList() {
    return [...this.tournaments.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(t => Object.assign(this.view(t, null), { requests: this.requestsFor(t.id) }));
  }

  requestsFor(id) {
    return this.requests.filter(r => r.tournamentId === id)
      .sort((a, b) => b.createdAt - a.createdAt).map(copy);
  }

  // Estado para un jugador concreto (incluye su solicitud y su asiento).
  view(tournament, user) {
    const room = this.roomFor(tournament.id);
    const now = Date.now();
    const mine = user
      ? this.requests.find(r => r.tournamentId === tournament.id && r.accountKey === user.key && r.status !== 'cancelada')
      : null;
    const info = room ? room.publicInfo(now) : null;
    return Object.assign(copy(tournament), {
      status: room && room.tournamentPhase === 'finalizado' ? 'finalizado' : (room && room.startedAt ? 'en_curso' : 'registro'),
      seated: info ? info.seated : 0,
      remaining: info ? info.remaining : 0,
      openSeats: info ? info.openSeats : (tournament.maxTables || 1) * tournament.maxPlayers,
      // Mesas múltiples
      tableCount: info ? info.tableCount : 0,
      maxTables: tournament.maxTables || 1,
      seatsPerTable: tournament.maxPlayers,
      moveEveryLevels: tournament.moveEveryLevels || 0,
      tables: info ? info.tables : [],
      canRegister: room ? room.canRegister() : true,
      // Cuándo arranca: 'manual', 'jugadores' o 'programado' + su fecha.
      startMode: this.startModeOf(tournament),
      startsAt: tournament.startsAt || null,
      scheduledIn: tournament.startsAt && tournament.startsAt > now ? tournament.startsAt - now : null,
      waitingForPlayers: room ? !!room.waitingForPlayers : false,
      pendingRequests: this.requests.filter(r => r.tournamentId === tournament.id && r.status === 'pendiente').length,
      acceptedRequests: this.requests.filter(r => r.tournamentId === tournament.id && r.status === 'aceptada').length,
      live: info ? {
        phase: info.phase, level: info.level, smallBlind: info.smallBlind, bigBlind: info.bigBlind,
        ante: info.ante, prizePool: info.prizePool, remaining: info.remaining, breakMinutes: info.breakMinutes,
      } : null,
      myRequest: mine ? copy(mine) : null,
      playerId: mine && mine.playerId ? mine.playerId : null,
      seats: info ? room.allPlayers().filter(p => !p.left).map(p => ({
        name: p.name, chips: p.chips, accountKey: p.accountKey || null,
        you: !!(user && p.accountKey === user.key),
        tableNumber: (room.tableFor(p.id) || {}).tableNumber || 1,
      })) : [],
      standings: info ? info.standings : [],
    });
  }

  // Reloj: avanza las manos, sube niveles y liquida el bote al terminar.
  tick(now = Date.now()) {
    let changed = false;
    for (const tournament of this.tournaments.values()) {
      if (tournament.status === 'finalizado') continue;
      // Un torneo programado puede no tener mesa aún: se crea al aceptar al
      // primer jugador, así que aquí solo se mira si ya la tiene.
      const room = this.roomFor(tournament.id);
      if (room && room.tournamentPhase === 'finalizado') {
        if (tournament.status !== 'finalizado') { this.settle(tournament, now); changed = true; }
        continue;
      }
      if (room) {
        // Primero se comprueba si toca arrancar por fecha o por jugadores:
        // si arranca aquí, room.tick ya repartirá la primera mano.
        if (this.maybeAutoStart(tournament, now)) {
          changed = true;
          continue;
        }
        const before = room.version;
        room.tick(now);
        if (room.version !== before) changed = true;
        if (room.tournamentPhase === 'finalizado' && tournament.status !== 'finalizado') {
          this.settle(tournament, now);
          changed = true;
          continue;
        }
      }
      // Llega la hora y arranca solo, acepte quien acepte el número de
      // jugadores inscritos.
      if (this.maybeAutoStart(tournament, now)) changed = true;
    }
    if (changed) this.save();
  }
}

module.exports = { TournamentStore, REQUEST_STATUSES, PRIZE_FORMATS, LIMITS };
