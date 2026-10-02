// ============================================================
//  L&F Casino Club — mesa de torneo (Texas Hold'em con ciegas
//  ascendentes configurables).
//
//  Extiende PokerRoom: hereda reparto, calles, botes laterales,
//  showdown y el reparto automático entre manos. Añade las
//  reglas de torneo: fichas de entrada, nivel de ciegas y ante,
//  hasta 9 asientos, registro tardío, descansos entre niveles,
//  eliminación por falta de fichas y posiciones finales.
//
//  phase           → fase de la mano (igual que PokerRoom)
//  tournamentPhase → 'registro' | 'en_curso' | 'descanso' | 'finalizado'
// ============================================================
const { PokerRoom, buildDeck } = require('./poker-engine.js');

const MAX_SEATS = 9;
const TOURNAMENT_PHASES = ['registro', 'en_curso', 'descanso', 'finalizado'];
// Cómo decide el torneo cuándo empezar:
//   'manual'   → solo cuando el admin pulsa "Arrancar ahora".
//   'jugadores'→ arranca solo al alcanzar el mínimo de jugadores.
//   'programado'→ arranca solo en la fecha y hora indicadas, acepte
//                 quien acepte el número de jugadores (incluso uno).
const START_MODES = ['manual', 'jugadores', 'programado'];

function int(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}
const fail = error => ({ ok: false, error });

class TournamentRoom extends PokerRoom {
  constructor(id, options = {}) {
    super(id, options);
    this.id = String(id);
    this.game = 'tournament';
    this.version = 1;
    this.lastActivity = Date.now();

    this.maxPlayers = int(options.maxPlayers, 2, MAX_SEATS, 9);
    this.startChips = int(options.startChips, 100, 10000000, 10000);
    this.baseSmallBlind = int(options.smallBlind, 1, 1000000, 100);
    this.baseAnte = int(options.ante, 0, 1000000, 0);
    this.levelMinutes = int(options.levelMinutes, 1, 240, 10);
    this.maxLevels = int(options.maxLevels, 1, 100, 20);
    this.breakEvery = int(options.breakEvery, 0, 50, 0);
    this.breakMinutes = int(options.breakMinutes, 1, 60, 3);
    this.lateRegistration = !!options.lateRegistration;
    this.lateLevels = int(options.lateLevels, 0, 100, 0);
    this.startMode = START_MODES.includes(options.startMode) ? options.startMode : 'manual';
    this.startsAt = Number.isFinite(Number(options.startsAt)) && Number(options.startsAt) > 0
      ? Number(options.startsAt) : null;

    this.level = 0;
    this.smallBlind = this.baseSmallBlind;
    this.bigBlind = this.baseSmallBlind * 2;
    this.ante = this.baseAnte;
    this.blindMinutes = this.levelMinutes;
    this.tournamentPhase = 'registro';
    this.startedAt = null;
    this.waitingForPlayers = false;
    // Con varias mesas: el contenedor que reparte jugadores y decide puestos.
    this.owner = options.owner || null;
    this.tableNumber = int(options.tableNumber, 1, 99, 1);
    this.breakUntil = 0;
    this.prizePool = 0;
    this.standings = [];
    this.seatCounter = 0;
    this.brokeAt = 0;
    this.message = options.startMode === 'programado'
      ? 'Programado: el torneo arranca solo en la fecha indicada.'
      : 'Registro abierto: el admin acepta a quien se una.';
  }

  // ---------- Ciegas por nivel ----------
  blindsForLevel(level) {
    const small = this.baseSmallBlind * (2 ** level);
    return { smallBlind: small, bigBlind: small * 2, ante: this.baseAnte * (2 ** level) };
  }

  // Suben por tiempo transcurrido, hasta el último nivel configurado.
  bumpLevel(now) {
    if (this.startedAt == null) return;
    const byTime = Math.floor((now - this.startedAt) / (this.levelMinutes * 60000));
    const next = Math.max(this.level, Math.min(this.maxLevels - 1, byTime));
    if (next === this.level) return;
    this.level = next;
    const blinds = this.blindsForLevel(this.level);
    this.smallBlind = blinds.smallBlind;
    this.bigBlind = blinds.bigBlind;
    this.ante = blinds.ante;
    this.touch();
  }

  levelTimeLeft(now) {
    if (this.startedAt == null) return null;
    return Math.max(0, this.startedAt + (this.level + 1) * this.levelMinutes * 60000 - now);
  }

  // ¿Se puede sentar alguien nuevo ahora mismo?
  canRegister() {
    // Mientras la mesa espera al segundo jugador, el registro sigue abierto:
    // el torneo ya arrancó por horario y solo falta que se siente alguien.
    if (this.waitingForPlayers) return this.tournamentPhase !== 'finalizado';
    if (this.tournamentPhase === 'registro') return true;
    return this.lateRegistration && this.tournamentPhase === 'en_curso' && this.level <= this.lateLevels;
  }

  // ---------- Guardado ----------
  // Se guardan los datos de la mesa, sin la referencia al contenedor
  // (se vuelve a enlazar al restaurar).
  serialize() {
    const data = {};
    for (const key of Object.keys(this)) {
      const value = this[key];
      if (key === 'owner') continue;
      if (value instanceof Map || value instanceof Set) continue;
      if (typeof value === 'function') continue;
      data[key] = value;
    }
    return data;
  }

  static restore(data, options = {}) {
    const room = new TournamentRoom(data.id || options.id, options);
    for (const key of Object.keys(data)) {
      if (key === 'owner' || key === 'id') continue;
      room[key] = data[key];
    }
    room.chat = Array.isArray(room.chat) ? room.chat : [];
    room.chatLastSent = new Map();
    room.owner = options.owner || null;
    room.tableNumber = data.tableNumber || options.tableNumber || 1;
    return room;
  }

  // Arranque por fecha: la mesa empieza su reloj aunque todavía no haya
  // dos jugadores. Se queda esperando y en cuanto se siente el segundo,
  // el tick reparte la primera mano.
  beginScheduled(now = Date.now()) {
    if (this.tournamentPhase === 'finalizado') return fail('El torneo ya ha terminado.');
    if (this.startedAt !== null) return { ok: true };
    this.startedAt = now;
    this.tournamentPhase = 'en_curso';
    this.waitingForPlayers = this.players.filter(p => !p.left && p.chips > 0).length < 2;
    this.message = this.waitingForPlayers
      ? 'El torneo ha arrancado a su hora. Se repartirá en cuanto se siente un segundo jugador.'
      : 'El torneo ha arrancado a su hora programada.';
    this.touch();
    return { ok: true };
  }

  openSeats() {
    return Math.max(0, this.maxPlayers - this.players.filter(p => !p.left).length);
  }

  // ---------- Jugadores ----------
  addPlayer(id, name, meta = {}) {
    if (this.find(id)) return { ok: true };
    if (this.tournamentPhase === 'finalizado') return fail('El torneo ya ha terminado.');
    if (this.owner) {
      // El contenedor decide si se puede entrar: mientras espera al
      // segundo jugador, el registro sigue abierto.
      if (!this.owner.canRegister()) return fail('El registro de este torneo está cerrado.');
    } else if (!this.canRegister()) {
      return fail('El registro de este torneo está cerrado.');
    }
    if (!this.openSeats()) return fail('No quedan asientos libres.');
    this.players = this.players.filter(p => !p.left);
    const buyIn = int(meta && meta.buyIn, 0, 10000000, 0);
    this.players.push({
      id, name: String(name || 'Jugador').slice(0, 12), chips: this.startChips,
      hand: [], bet: 0, total: 0, folded: false, allIn: false, inHand: false,
      left: false, eliminated: false, result: '', actedAt: null,
      accountKey: (meta && meta.accountKey) || null, buyIn, seat: ++this.seatCounter,
    });
    this.prizePool += buyIn;
    this.touch();
    return { ok: true };
  }

  // ---------- Reparto (sin anfitrión: el torneo avanza solo) ----------
  start(_id, now = Date.now(), deck = null) {
    if (!['lobby', 'finished'].includes(this.phase) || now < this.visualUntil) {
      return fail('La mano o el reparto aún no han terminado.');
    }
    if (this.tournamentPhase === 'finalizado') return fail('El torneo ya ha terminado.');
    const alive = p => !p.left && !p.eliminated && p.chips > 0;
    if (this.players.filter(alive).length < 2) return fail('Se necesitan dos jugadores con fichas.');

    if (this.startedAt === null) { this.startedAt = now; this.tournamentPhase = 'en_curso'; }
    this.bumpLevel(now);
    // Descanso programado al cambiar de nivel (p. ej. cada 2 niveles).
    if (this.tournamentPhase === 'en_curso' && this.breakEvery > 0 &&
        this.level > 0 && this.level % this.breakEvery === 0 && this.brokeAt !== this.level) {
      this.brokeAt = this.level;
      this.tournamentPhase = 'descanso';
      this.breakUntil = now + this.breakMinutes * 60000;
      this.phase = 'lobby';
      this.nextHandAt = 0;
      this.message = 'Los jugadores están en un descanso. El torneo se reanuda en ' + this.breakMinutes + ' min.';
      this.touch();
      return { ok: true, break: true };
    }
    if (this.tournamentPhase === 'descanso' && now < this.breakUntil) return { ok: true, break: true };
    if (this.tournamentPhase === 'descanso') this.tournamentPhase = 'en_curso';

    this.dealerId = this.order(this.dealerId, alive)[0].id;
    this.deck = deck ? deck.map(c => ({ ...c })) : buildDeck();
    this.board = []; this.pots = []; this.events = [];
    this.visualUntil = now; this.nextHandAt = 0; this.handNo++;
    this.players.forEach(p => Object.assign(p, {
      hand: [], bet: 0, total: 0, folded: !alive(p), inHand: alive(p),
      allIn: false, result: '', actedAt: null,
    }));
    const count = this.players.filter(alive).length;
    this.sbId = count === 2 ? this.dealerId : this.order(this.dealerId, alive)[0].id;
    this.bbId = this.order(this.sbId, alive)[0].id;
    this.pay(this.find(this.sbId), this.smallBlind);
    this.pay(this.find(this.bbId), this.bigBlind);
    if (this.ante > 0) for (const p of this.players.filter(alive)) this.pay(p, this.ante);
    const order = this.order(this.dealerId, p => p.inHand);
    for (let i = 0; i < 2; i++) {
      for (const p of order) { p.hand.push(this.deck.pop()); this.event('hole', p.id, i, now); }
    }
    this.phase = 'preflop';
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.pending = this.order(this.bbId, p => p.inHand && !p.allIn).map(p => p.id);
    this.message = 'Reparto · Preflop';
    this.progress(now);
    this.touch();
    return { ok: true };
  }

  // Retirada: en torneo es eliminación (sus fichas van al bote de la mesa).
  removePlayer(id, now = Date.now()) {
    const p = this.find(id);
    if (!p) return { ok: true, chips: null };
    if (p.eliminated || p.left) return { ok: true, chips: p.chips };
    p.left = true;
    p.folded = true;
    p.eliminated = true;
    p.chips = 0;
    this.pending = this.pending.filter(x => x !== id);
    if (id === this.hostId) this.hostId = (this.players.find(q => !q.left) || {}).id || null;
    if (!['lobby', 'finished'].includes(this.phase)) this.progress(now);
    this.afterHand(now);
    this.touch();
    return { ok: true, chips: 0 };
  }

  // ---------- Mano terminada: eliminaciones y fin de torneo ----------
  // Con varias mesas manda el contenedor: una mesa por sí sola no sabe
  // cuántos quedan vivos en el resto del torneo.
  finish(showdown, now) {
    super.finish(showdown, now);
    if (this.owner) { this.owner.afterTableHand(this, now); return; }
    this.afterHand(now);
  }

  // El contenedor decide eliminaciones y puestos de todo el torneo.
  afterHand(now = Date.now()) {
    if (this.owner) return this.owner.afterTableHand(this, now);
    if (this.tournamentPhase === 'finalizado') return;
    // 1) Quien se queda sin fichas queda eliminado.
    for (const p of this.players) {
      if (p.left || p.eliminated) continue;
      if (p.chips <= 0) { p.eliminated = true; p.left = true; p.inHand = false; }
    }
    const alive = this.players.filter(p => !p.left && !p.eliminated && p.chips > 0);
    // 2) Posición de cada eliminado: los que quedan con fichas por delante.
    //    Si dos se hunden en la misma mano comparten puesto (como en la realidad).
    for (const p of this.players) {
      if (!p.eliminated || this.standings.some(row => row.playerId === p.id)) continue;
      this.registerPlacement(p, alive.length + 1, now);
    }
    if (alive.length === 1) {
      // El último con fichas es el campeón: se registra con el primer puesto.
      this.registerPlacement(alive[0], 1, now);
      this.tournamentPhase = 'finalizado';
      this.phase = 'finished';
      this.nextHandAt = 0;
      this.turnId = null;
      this.message = '🏆 ¡Gana ' + alive[0].name + ' con ' + alive[0].chips + ' fichas!';
      this.touch();
    }
  }

  // Final forzado por el admin: gana quien más fichas tenga.
  forceFinish(now = Date.now()) {
    const alive = this.players.filter(p => !p.left && !p.eliminated).sort((a, b) => b.chips - a.chips);
    // alive[0] es el campeón (puesto 1) y el resto van por detrás de él.
    if (alive[0]) this.registerPlacement(alive[0], 1, now);
    for (let i = 1; i < alive.length; i++) this.registerPlacement(alive[i], i + 1, now);
    if (alive[0]) {
      this.tournamentPhase = 'finalizado';
      this.phase = 'finished';
      this.nextHandAt = 0;
      this.turnId = null;
      this.message = '🏆 ¡Gana ' + alive[0].name + ' con ' + alive[0].chips + ' fichas!';
    }
    this.touch();
    return this.standings;
  }

  registerPlacement(player, place, now = Date.now()) {
    if (this.standings.some(row => row.playerId === player.id)) return;
    this.standings.push({
      playerId: player.id, accountKey: player.accountKey || null, name: player.name,
      place, at: now,
    });
    this.standings.sort((a, b) => a.place - b.place);
  }

  // ---------- Reloj del torneo ----------
  tick(now = Date.now()) {
    if (this.tournamentPhase === 'finalizado') return;
    if (this.tournamentPhase === 'descanso' && now >= this.breakUntil) this.tournamentPhase = 'en_curso';
    // Arrancado por fecha y aún sin segundo jugador: en cuanto se sienta,
    // el torneo pasa a repartir sin que el admin tenga que hacer nada.
    if (this.waitingForPlayers) {
      if (this.players.filter(p => !p.left && !p.eliminated && p.chips > 0).length < 2) return;
      this.waitingForPlayers = false;
      this.message = 'Ya hay dos jugadores: el torneo empieza.';
      this.touch();
    }
    if (this.tournamentPhase === 'en_curso' && this.phase === 'lobby') this.start(null, now);
    if (this.phase === 'finished' && this.nextHandAt && now >= this.nextHandAt) {
      const enough = this.players.filter(p => !p.left && !p.eliminated && p.chips > 0).length >= 2;
      if (enough) this.start(null, now);
      else this.nextHandAt = 0;
      return;
    }
    if (this.turnId && now >= this.turnDeadline && now >= this.visualUntil) {
      const p = this.find(this.turnId);
      if (p) this.action(p.id, p.bet >= this.currentBet ? 'check' : 'fold', null, now);
    }
  }

  // ---------- Estado público ----------
  publicInfo(now = Date.now()) {
    return {
      id: this.id,
      phase: this.tournamentPhase,
      level: this.level + 1,
      maxLevels: this.maxLevels,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      ante: this.ante,
      levelTimeLeft: this.tournamentPhase === 'en_curso' ? this.levelTimeLeft(now) : null,
      breakMinutes: this.breakMinutes,
      breakTimeLeft: this.tournamentPhase === 'descanso' ? Math.max(0, this.breakUntil - now) : null,
      maxPlayers: this.maxPlayers,
      startMode: this.startMode,
      startsAt: this.startsAt,
      waitingForPlayers: this.waitingForPlayers,
      seated: this.players.filter(p => !p.left).length,
      remaining: this.players.filter(p => !p.left && !p.eliminated).length,
      canRegister: this.canRegister(),
      openSeats: this.openSeats(),
      lateRegistration: this.lateRegistration,
      lateLevels: this.lateLevels,
      prizePool: this.prizePool,
      startedAt: this.startedAt,
      standings: this.standings.map(row => ({ ...row })),
    };
  }

  stateFor(id, now = Date.now()) {
    const base = super.stateFor(id, now);
    // PokerRoom oculta a quien ya no está en la mesa; en torneo el eliminado
    // sigue en la pantalla (con su posición) hasta que acaba el torneo.
    const shown = new Set(base.players.map(p => p.id));
    const players = base.players.map(p => {
      const seat = this.find(p.id);
      return Object.assign(p, { accountKey: (seat && seat.accountKey) || null, eliminated: !!(seat && seat.eliminated) });
    });
    for (const seat of this.players) {
      if (shown.has(seat.id)) continue;
      const row = this.standings.find(entry => entry.playerId === seat.id);
      players.push({
        id: seat.id, name: seat.name, chips: 0, bet: 0, total: 0, folded: true, allIn: false,
        inHand: false, left: true, eliminated: true, result: row ? (row.place + 'º puesto') : 'Eliminado',
        cards: [], handName: '', bestHand: [], accountKey: seat.accountKey || null, place: row ? row.place : null,
      });
    }
    return Object.assign(base, {
      game: 'tournament',
      ante: this.ante,
      tournament: this.publicInfo(now),
      players,
    });
  }
}

// ============================================================
//  Contenedor de mesas de un mismo torneo.
//
//  Un torneo grande no cabe en una mesa de 9 asientos. Este
//  objeto reparte a los jugadores en varias mesas, comparte entre
//  todas el mismo nivel de ciegas, el mismo bote y la misma
//  clasificación, y cada cierto tiempo equilibra las mesas
//  moviendo jugadores de unas a otras (como hace PokerStars).
//
//  El cambio de mesa solo ocurre entre manos: nunca en medio de
//  una mano, para no fastidiar al jugador.
// ============================================================
class TournamentTables {
  constructor(id, options = {}) {
    this.id = String(id);
    this.game = 'tournament';
    this.version = 1;
    this.options = options;
    this.maxTables = Math.max(1, Math.min(20, int(options.maxTables, 1, 20, 1)));
    this.seatsPerTable = int(options.maxPlayers, 2, MAX_SEATS, MAX_SEATS);
    this.moveEveryLevels = int(options.moveEveryLevels, 0, 100, 0);
    this.movedAtLevel = -1;
    this.tables = [];
    this.standings = [];
    this.prizePool = 0;
    this.tournamentPhase = 'registro';
    this.startedAt = null;
    this.message = 'Registro abierto: el admin acepta a quien se una.';
  }

  touch() { this.version++; }

  // ---------- Mesas ----------
  allPlayers() { return this.tables.flatMap(table => table.players); }

  alivePlayers() {
    return this.allPlayers().filter(p => !p.left && !p.eliminated && p.chips > 0);
  }

  seatedCount() { return this.allPlayers().filter(p => !p.left).length; }

  openSeats() {
    return Math.max(0, this.maxTables * this.seatsPerTable - this.seatedCount());
  }

  canRegister() {
    if (this.tournamentPhase === 'finalizado') return false;
    // Arrancado por fecha y aún sin segundo jugador: el registro sigue
    // abierto para que se pueda completar la mesa.
    if (this.waitingForPlayers()) return this.openSeats() > 0;
    return this.openSeats() > 0;
  }

  // Mesa con más asientos libres: se llenan primero las que ya existen
  // y solo se abre una nueva cuando todas están llenas.
  pickTable() {
    let best = null;
    for (const table of this.tables) {
      if (table.openSeats() <= 0) continue;
      if (!best || table.openSeats() > best.openSeats()) best = table;
    }
    if (best) return best;
    if (this.tables.length >= this.maxTables) return null;
    return this.createTable();
  }

  createTable() {
    const table = new TournamentRoom(this.id + ':' + (this.tables.length + 1), Object.assign({}, this.options, {
      maxPlayers: this.seatsPerTable,
      owner: this,
      tableNumber: this.tables.length + 1,
    }));
    this.tables.push(table);
    return table;
  }

  tableFor(playerId) {
    return this.tables.find(table => table.find(playerId)) || null;
  }

  // Busca un jugador en cualquiera de las mesas. El contenedor no es una
  // mesa en sí, pero ofrece el mismo método para no cambiar el código que
  // ya lo usaba.
  find(playerId) {
    for (const table of this.tables) {
      const player = table.find(playerId);
      if (player) return player;
    }
    return null;
  }

  // Arranque por fecha: el torneo pone su reloj en marcha aunque falte
  // un jugador. Se queda esperando y en cuanto haya dos con fichas reparte.
  beginScheduled(now = Date.now()) {
    if (this.tournamentPhase === 'finalizado') return fail('El torneo ya ha terminado.');
    if (this.startedAt != null) return { ok: true };
    this.startedAt = now;
    this.tournamentPhase = 'en_curso';
    this.syncTables();
    this.message = this.alivePlayers().length < 2
      ? 'El torneo ha arrancado a su hora. Se repartirá en cuanto haya un segundo jugador.'
      : 'El torneo ha arrancado a su hora programada.';
    return { ok: true };
  }

  // Reparte la primera mano de cada mesa que pueda. Se sincroniza el nivel
  // antes de repartir, para que todas las mesas jueguen con las mismas ciegas.
  startDealt(now = Date.now()) {
    this.tournamentPhase = 'en_curso';
    if (this.startedAt == null) this.startedAt = now;
    this.syncTables();
    let dealt = 0;
    const errores = [];
    for (const table of this.tables) {
      if (this.tableSize(table) < 2) continue;
      // Se intenta en todas: si una mesa está repartiendo, start() lo dice
      // y se salta. Así ninguna mesa se queda fuera por un estado viejo.
      const r = table.start(null, now);
      if (r.ok) dealt++;
      else errores.push('m' + table.tableNumber + ':' + r.error);
    }
    this.lastStartErrors = errores;
    // Las mesas que no pudieron repartir quedan en espera.
    for (const table of this.tables) {
      if (dealt > 0 && this.tableSize(table) < 2) {
        table.phase = 'lobby';
        table.nextHandAt = 0;
      }
    }
    return dealt;
  }

  // ---------- Guardado ----------
  // El contenedor tiene referencias cruzadas (owner ↔ mesa), así que se
  // guarda por partes: los datos del torneo y cada mesa por separado.
  serialize() {
    return {
      kind: 'tables',
      id: this.id,
      options: this.options,
      version: this.version,
      maxTables: this.maxTables,
      seatsPerTable: this.seatsPerTable,
      moveEveryLevels: this.moveEveryLevels,
      movedAtLevel: this.movedAtLevel,
      standings: this.standings,
      prizePool: this.prizePool,
      tournamentPhase: this.tournamentPhase,
      startedAt: this.startedAt,
      message: this.message,
      tables: this.tables.map(table => table.serialize()),
    };
  }

  // Restaura un contenedor guardado (tras reiniciar el servidor).
  static restore(data, tournament) {
    const room = new TournamentTables(data.id || tournament.id, tournament);
    Object.assign(room, {
      maxTables: data.maxTables, seatsPerTable: data.seatsPerTable,
      moveEveryLevels: data.moveEveryLevels, movedAtLevel: data.movedAtLevel,
      standings: Array.isArray(data.standings) ? data.standings : [],
      prizePool: data.prizePool || 0,
      tournamentPhase: data.tournamentPhase || 'registro',
      startedAt: data.startedAt == null ? null : data.startedAt,
      message: data.message || '',
      version: data.version || 1,
    });
    room.tables = (data.tables || []).map((tableData, index) => {
      const table = TournamentRoom.restore(tableData, Object.assign({}, tournament, {
        maxPlayers: room.seatsPerTable,
        owner: room,
        tableNumber: (tableData.tableNumber || index + 1),
      }));
      table.standings = room.standings;
      return table;
    });
    return room;
  }

  // ---------- Jugadores ----------
  addPlayer(id, name, meta = {}) {
    const table = this.pickTable();
    if (!table) return { ok: false, error: 'No quedan asientos libres en este torneo.' };
    const result = table.addPlayer(id, name, meta);
    if (!result.ok) return result;
    // El bote y la clasificación son de todo el torneo, no de una mesa.
    this.prizePool += int(meta && meta.buyIn, 0, 10000000, 0);
    this.touch();
    return { ok: true, tableNumber: table.tableNumber };
  }

  // ---------- Reloj compartido ----------
  levelNow(now = Date.now()) {
    if (this.startedAt == null) return 0;
    const minutes = int(this.options.levelMinutes, 1, 240, 10);
    return Math.max(0, Math.floor((now - this.startedAt) / (minutes * 60000)));
  }

  // El nivel de ciegas es el mismo en todas las mesas: se reparte
  // el nivel alcanzado y el bote entre todas.
  syncTables() {
    const level = this.levelNow();
    const base = int(this.options.smallBlind, 1, 1000000, 100);
    const baseAnte = int(this.options.ante, 0, 1000000, 0);
    for (const table of this.tables) {
      table.level = level;
      table.smallBlind = base * (2 ** level);
      table.bigBlind = base * (2 ** level) * 2;
      table.ante = baseAnte * (2 ** level);
      table.tournamentPhase = this.tournamentPhase;
      table.startedAt = this.startedAt;
      table.prizePool = 0;          // el bote es del torneo, no de la mesa
      table.standings = this.standings;
      table.owner = this;
    }
  }

  tick(now = Date.now()) {
    if (this.tournamentPhase === 'finalizado') return;
    const before = this.version;
    // Se hace ANTES de repartir la siguiente mano, para que el reparto
    // tenga en cuenta a quién se ha movido.
    const level = this.levelNow(now);
    if (this.startedAt != null && this.moveEveryLevels > 0 &&
        level > 0 && level % this.moveEveryLevels === 0 && this.movedAtLevel !== level) {
      this.movedAtLevel = level;
      // Solo se reparten si todas están en el mismo punto: si una mesa ya
      // está repartiendo, mover a alguien sería molestarlo en mitad de la mano.
      if (this.tables.every(t => this.tableIsIdle(t))) this.rebalance(now);
    }
    // Ahora sí, cada mesa avanza.
    for (const table of this.tables) table.tick(now);
    this.syncTables();
    // Arrancado por hora y aún sin segundo jugador: en cuanto se siente,
    // el torneo empieza a repartir sin que nadie tenga que hacer nada.
    if (this.waitingForPlayers()) {
      if (this.startDealt(now) > 0) {
        this.message = 'Ya hay dos jugadores: el torneo empieza.';
        this.touch();
      }
      return;
    }
    this.afterTableHand(null, now);
    if (this.version !== before) this.touch();
  }

  // ---------- Reparto entre mesas ----------
  // Nunca en mitad de una mano: solo cuando la mesa está libre.

  // ¿Falta un jugador para poder repartir? Entonces el registro sigue
  // abierto: el torneo arrancó por hora y solo falta que se siente alguien.
  waitingForPlayers() {
    return this.startedAt != null && this.alivePlayers().length < 2 &&
      this.tournamentPhase === 'en_curso';
  }

  // Arranque por fecha pendiente: aún no ha llegado la hora o no hay
  // quien reparta. El torneo no puede darse por acabado en ese estado.
  isWaiting() {
    return this.waitingForPlayers() ||
      (this.tournamentPhase === 'registro' && this.startedAt == null &&
        this.alivePlayers().length < 2);
  }
  tableIsIdle(table) {
    return ['lobby', 'finished'].includes(table.phase);
  }

  tableSize(table) {
    return table.players.filter(p => !p.left && !p.eliminated && p.chips > 0).length;
  }

  // Equilibra las mesas: si alguna se queda con menos de 2 jugadores
  // con fichas, le presta uno de las que tienen más. Es el aviso de
  // "mesa final" que hace PokerStars cuando ya solo queda una.
  // Equilibra las mesas: si alguna tiene menos jugadores con fichas que
  // otra, se le traspasa uno. Es el aviso de "mesa final" de PokerStars y
  // también el reparto aleatorio entre niveles, para que la gente se cruce.
  rebalance(now = Date.now()) {
    const moved = [];
    const idle = this.tables.filter(t => this.tableIsIdle(t));
    if (idle.length < 2) return moved;
    // Se itira un par de veces: mover uno puede crear otra mesa corta.
    const yaMovidos = new Set();
    // Reparto justo: todos deberían acabar en mesas del mismo tamaño. Se
    // calcula a partir del total de jugadores vivos, así que si uno cae,
    // el resto se reparte entre menos mesas.
    const vivos = this.alivePlayers().length;
    const objetivo = Math.max(1, Math.ceil(vivos / Math.max(1, this.tables.length)));
    for (let ronda = 0; ronda < idle.length * 2; ronda++) {
      const sizes = idle.map(t => this.tableSize(t));
      const min = Math.min(...sizes), max = Math.max(...sizes);
      // Una mesa con un solo jugador siempre necesita ayuda, aunque el
      // objetivo matemático ya esté cubierto.
      // Se busca que todas las mesas tengan el mismo número de jugadores.
      // Si solo faltan 1, la diferencia no molesta a nadie y no se toca:
      // mover jugadores sin necesidad es más molesto que una mesa de +1.
      // Pero si una mesa se queda con 1 (o 0), sí hay que rescatarla.
      const hayMesaCorta = min < 2;
      const diferencia = max - min;
      if (diferencia < 2 && !hayMesaCorta) break;
      if (diferencia < 1 && !hayMesaCorta) break;
      const target = idle[sizes.indexOf(min)];
      const source = idle[sizes.indexOf(max)];
      if (!target || !source || target === source) break;
      // No se deja la mesa más llena por debajo de 2 con fichas.
      if (this.tableSize(source) - 1 < 2) break;
      // El jugador movido no vuelve a moverse en este reparto: así la
      // diferencia se corrige de verdad y no se entra en bucle.
      const candidates = source.players
        .filter(p => !p.left && !p.eliminated && p.chips > 0 && !yaMovidos.has(p.id));
      const mover = candidates[candidates.length - 1];
      if (!mover) break;
      yaMovidos.add(mover.id);
      this.movePlayer(mover, source, target);
      moved.push(mover.name);
    }
    if (moved.length) {
      this.message = 'Cambio de mesa: ' + moved.join(', ') + ' pasa' +
        (moved.length === 1 ? '' : 'n') + ' a otra mesa para repartirlas.';
      this.touch();
    }
    return moved;
  }

  movePlayer(player, from, to) {
    // Se saca de la lista de la mesa origen: si no, tableSize() seguiría
    // contando al jugador en las dos y el equilibrado no terminaría.
    from.players = from.players.filter(p => p !== player);
    from.pending = from.pending.filter(x => x !== player.id);
    if (from.turnId === player.id) from.turnId = null;
    if (from.dealerId === player.id) from.dealerId = null;
    if (from.sbId === player.id) from.sbId = null;
    if (from.bbId === player.id) from.bbId = null;
    player.bet = 0; player.total = 0; player.folded = true; player.inHand = false;
    to.players.push(player);
    // Una mesa que se queda sin jugadores con fichas deja de repartir.
    if (this.tableSize(from) < 2) {
      from.tournamentPhase = 'cerrada';
      from.phase = 'finished';
      from.nextHandAt = 0;
      from.turnId = null;
    }
    this.touch();
    return true;
  }

  // ---------- Eliminaciones y puestos ----------
  // Tras cada mano de cualquier mesa. table=null: revisión general.
  afterTableHand(table, now = Date.now()) {
    if (this.tournamentPhase === 'finalizado') return false;
    for (const t of this.tables) {
      for (const p of t.players) {
        if (p.left || p.eliminated) continue;
        if (p.chips <= 0) { p.eliminated = true; p.left = true; p.inHand = false; }
      }
    }
    const alive = this.alivePlayers();
    // Arrancado por hora y aún sin segundo jugador: la mesa espera en vez
    // de dar el torneo por ganado.
    if (this.isWaiting()) return false;
    // Quien se hunde comparte puesto con los que se hundieron a la vez.
    for (const p of this.allPlayers()) {
      if (!p.eliminated || this.standings.some(row => row.playerId === p.id)) continue;
      this.registerPlacement(p, alive.length + 1, now);
    }
    if (alive.length === 1) {
      this.registerPlacement(alive[0], 1, now);
      this.tournamentPhase = 'finalizado';
      this.message = '🏆 ¡Gana ' + alive[0].name + ' con ' + alive[0].chips + ' fichas!';
      for (const t of this.tables) {
        t.tournamentPhase = 'finalizado';
        t.phase = 'finished';
        t.nextHandAt = 0;
        t.turnId = null;
      }
      this.touch();
      return true;
    }
    return false;
  }

  registerPlacement(player, place, now = Date.now()) {
    if (this.standings.some(row => row.playerId === player.id)) return;
    this.standings.push({
      playerId: player.id, accountKey: player.accountKey || null, name: player.name,
      place, at: now,
    });
    this.standings.sort((a, b) => a.place - b.place);
    this.touch();
  }

  // ---------- Estado y acciones del jugador ----------
  // Cada jugador ve la mesa donde está sentado, con los datos comunes.
  stateFor(playerId, now = Date.now()) {
    const table = this.tableFor(playerId) ||
      this.tables.find(t => t.players.some(p => p.id === playerId)) || this.tables[0];
    if (!table) return null;
    const state = table.stateFor(playerId, now);
    if (!state) return null;
    state.game = 'tournament';
    state.tournament = this.publicInfo(now);
    state.tableNumber = table.tableNumber;
    state.tableCount = this.tables.length;
    return state;
  }

  // El jugador actúa en la mesa donde está sentado.
  action(playerId, type, amount, now = Date.now()) {
    const table = this.tableFor(playerId);
    if (!table) return fail('No estás sentado en ninguna mesa.');
    return table.action(playerId, type, amount, now);
  }

  removePlayer(playerId, now = Date.now()) {
    const table = this.tableFor(playerId);
    return table ? table.removePlayer(playerId, now) : { ok: true, chips: null };
  }

  // Final forzado por el admin: gana quien más fichas tenga.
  forceFinish(now = Date.now()) {
    const alive = this.alivePlayers().sort((a, b) => b.chips - a.chips);
    if (alive[0]) this.registerPlacement(alive[0], 1, now);
    for (let i = 1; i < alive.length; i++) this.registerPlacement(alive[i], i + 1, now);
    if (alive[0]) {
      this.tournamentPhase = 'finalizado';
      this.message = '🏆 ¡Gana ' + alive[0].name + ' con ' + alive[0].chips + ' fichas!';
      for (const t of this.tables) { t.tournamentPhase = 'finalizado'; t.phase = 'finished'; t.turnId = null; }
    }
    this.touch();
    return this.standings;
  }

  publicInfo(now = Date.now()) {
    const level = this.levelNow(now);
    const base = int(this.options.smallBlind, 1, 1000000, 100);
    const minutes = int(this.options.levelMinutes, 1, 240, 10);
    const started = this.startedAt;
    return {
      id: this.id,
      phase: this.tournamentPhase,
      level: level + 1,
      maxLevels: int(this.options.maxLevels, 1, 100, 20),
      smallBlind: base * (2 ** level),
      bigBlind: base * (2 ** level) * 2,
      ante: int(this.options.ante, 0, 1000000, 0) * (2 ** level),
      levelTimeLeft: started == null ? null : Math.max(0, started + (level + 1) * minutes * 60000 - now),
      breakMinutes: int(this.options.breakMinutes, 1, 60, 3),
      breakTimeLeft: null,
      maxPlayers: this.maxTables * this.seatsPerTable,
      seated: this.seatedCount(),
      remaining: this.alivePlayers().length,
      canRegister: this.canRegister(),
      openSeats: this.openSeats(),
      lateRegistration: !!this.options.lateRegistration,
      lateLevels: int(this.options.lateLevels, 0, 100, 0),
      prizePool: this.prizePool,
      startedAt: started,
      standings: this.standings.map(row => ({ ...row })),
      // Datos de las mesas múltiples
      tableCount: this.tables.length,
      maxTables: this.maxTables,
      seatsPerTable: this.seatsPerTable,
      moveEveryLevels: this.moveEveryLevels,
      tables: this.tables.map(t => ({
        number: t.tableNumber,
        seated: this.tableSize(t),
        playing: !['lobby', 'finished'].includes(t.phase),
      })),
      message: this.message,
    };
  }
}

module.exports = { TournamentRoom, TournamentTables, MAX_SEATS, TOURNAMENT_PHASES, START_MODES, int };


