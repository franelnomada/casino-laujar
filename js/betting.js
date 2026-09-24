// ============================================================
//  L&F Casino Club — apuestas deportivas (eventos, mercados y liquidaciones)
//  Persistencia local JSON + réplica opcional en Firebase RTDB.
//  Los saldos y la consola se resuelven con UserStore y TransactionLog.
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FirebaseRest } = require('./firebase-rest.js');

const MARKET_TYPES = ['winner', 'goal_diff', 'exact_score', 'custom'];
const EVENT_STATUSES = ['open', 'locked', 'settled', 'cancelled'];
const BET_STATUSES = ['pending', 'won', 'lost', 'refunded'];
const DEFAULT_FILE = 'casino-laujar-betting.json';
const LIMITS = { title: 120, team: 60, label: 100, markets: 20, outcomes: 50, odds: 1000 };

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').slice(0, max);
}
function resultError(status, error) { return { ok: false, status, error }; }
function copy(value) { return JSON.parse(JSON.stringify(value)); }

class BettingStore {
  constructor({ filePath, userStore, txLog } = {}) {
    this.filePath = filePath || path.join(process.env.DATA_DIR || os.tmpdir(), DEFAULT_FILE);
    this.userStore = userStore;
    this.txLog = txLog;
    this.events = new Map();
    this.bets = [];
    this.remote = FirebaseRest.configFromEnv(process.env, 'FIREBASE_BETTING_PATH', 'casino-laujar/betting');
    this.remoteOk = false;
    this.remoteError = '';
    this._remoteLoaded = !this.remote;
    this.load();
    this.lockExpired();
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

  validateMarkets(markets) {
    if (!Array.isArray(markets) || !markets.length) return 'Añade al menos un mercado de apuestas.';
    if (markets.length > LIMITS.markets) return 'No se pueden crear más de ' + LIMITS.markets + ' mercados.';
    const ids = new Set();
    const normalized = [];
    for (const market of markets) {
      const type = cleanText(market && market.type, 30);
      const label = cleanText(market && market.label, LIMITS.label) || ({
        winner: 'Ganador (1X2)', goal_diff: 'Diferencia de goles',
        exact_score: 'Resultado exacto', custom: 'Mercado personalizado',
      }[type] || 'Mercado');
      const marketId = cleanText(market && market.id, 80) || crypto.randomBytes(8).toString('hex');
      if (!MARKET_TYPES.includes(type)) return 'Tipo de mercado no válido.';
      if (ids.has(marketId)) return 'Hay dos mercados con el mismo identificador.';
      ids.add(marketId);
      const outcomes = market && Array.isArray(market.outcomes) ? market.outcomes : [];
      if (!outcomes.length || outcomes.length > LIMITS.outcomes) {
        return 'Cada mercado debe tener entre 1 y ' + LIMITS.outcomes + ' opciones.';
      }
      const outcomeIds = new Set();
      const cleanOutcomes = [];
      for (const outcome of outcomes) {
        const outcomeLabel = cleanText(outcome && outcome.label, LIMITS.label);
        const odds = Number(outcome && outcome.odds);
        const outcomeId = cleanText(outcome && outcome.id, 80) || crypto.randomBytes(8).toString('hex');
        if (!outcomeLabel) return 'Todas las opciones necesitan una etiqueta.';
        if (!Number.isFinite(odds) || odds < 1 || odds > LIMITS.odds) return 'Las cuotas deben estar entre 1 y ' + LIMITS.odds + '.';
        if (outcomeIds.has(outcomeId)) return 'Hay dos opciones con el mismo identificador en un mercado.';
        outcomeIds.add(outcomeId);
        cleanOutcomes.push({ id: outcomeId, label: outcomeLabel, odds });
      }
      normalized.push({ id: marketId, type, label, outcomes: cleanOutcomes });
    }
    return normalized;
  }

  // ---------- Persistencia ----------
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const event of (raw && raw.events) || []) {
        if (event && event.id && Array.isArray(event.teams) && Array.isArray(event.markets) && EVENT_STATUSES.includes(event.status)) {
          this.events.set(String(event.id), copy(event));
        }
      }
      this.bets = ((raw && raw.bets) || [])
        .filter(bet => bet && bet.id && this.events.has(bet.eventId) && BET_STATUSES.includes(bet.status))
        .map(copy);
    } catch (e) { /* primera ejecución o fichero ilegible */ }
  }

  snapshot() { return { events: [...this.events.values()], bets: this.bets }; }
  saveLocal() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot()));
    } catch (e) { /* seguimos en memoria */ }
  }
  save() { this.saveLocal(); this._pushRemote(); }

  mergeDocuments(a, b) {
    const byId = new Map();
    for (const event of [...(a.events || []), ...(b.events || [])]) {
      const old = byId.get(event.id);
      if (event && (!old || (event.updatedAt || 0) >= (old.updatedAt || 0))) byId.set(event.id, copy(event));
    }
    const events = [...byId.values()].filter(event => event.id && Array.isArray(event.markets) && EVENT_STATUSES.includes(event.status));
    const eventIds = new Set(events.map(event => event.id));
    const bets = new Map();
    for (const bet of [...(a.bets || []), ...(b.bets || [])]) {
      if (!bet || !bet.id || !eventIds.has(bet.eventId) || !BET_STATUSES.includes(bet.status)) continue;
      const old = bets.get(bet.id);
      if (!old || (bet.updatedAt || bet.placedAt || 0) >= (old.updatedAt || old.placedAt || 0)) bets.set(bet.id, copy(bet));
    }
    return { events, bets: [...bets.values()] };
  }

  async _initRemote() {
    try {
      const remote = await FirebaseRest.get(this.remote, '');
      const merged = this.mergeDocuments(this.snapshot(), remote || {});
      this.events = new Map(merged.events.map(event => [event.id, event]));
      this.bets = merged.bets;
      this.remoteOk = true;
      this._remoteLoaded = true;
      this.lockExpired();
      this.save();
      return true;
    } catch (e) {
      this.remoteOk = false;
      this.remoteError = String((e && e.message) || e).slice(0, 160);
      return false;
    }
  }

  _pushRemote() {
    if (!this.remote || this._pushing || !this._remoteLoaded) return;
    this._pushing = true;
    Promise.resolve(FirebaseRest.put(this.remote, this.snapshot()))
      .then(() => { this.remoteOk = true; this.remoteError = ''; })
      .catch(e => { this.remoteOk = false; this.remoteError = String((e && e.message) || e).slice(0, 160); })
      .finally(() => { this._pushing = false; });
  }

  // ---------- Eventos ----------
  createEvent(input) {
    const title = cleanText(input && input.title, LIMITS.title);
    const teams = input && Array.isArray(input.teams) ? input.teams.map(team => cleanText(team, LIMITS.team)) : [];
    const startsAt = new Date(input && input.startsAt);
    const markets = this.validateMarkets(input && input.markets);
    if (!title) return resultError(400, 'El evento necesita un título.');
    if (teams.length !== 2 || !teams[0] || !teams[1]) return resultError(400, 'Indica los dos equipos.');
    if (Number.isNaN(startsAt.getTime())) return resultError(400, 'La hora de inicio no es válida.');
    if (typeof markets === 'string') return resultError(400, markets);
    const now = Date.now();
    const event = {
      id: crypto.randomBytes(10).toString('hex'), title, teams,
      startsAt: startsAt.toISOString(), status: startsAt.getTime() <= now ? 'locked' : 'open', markets,
      createdAt: now, updatedAt: now,
    };
    this.events.set(event.id, event);
    this.save();
    return { ok: true, event: copy(event) };
  }

  updateMarkets(id, input) {
    const event = this.events.get(id);
    if (!event) return resultError(404, 'Evento no encontrado.');
    if (event.status !== 'open') return resultError(409, 'Solo se pueden editar cuotas de un evento abierto.');
    const markets = this.validateMarkets(input);
    if (typeof markets === 'string') return resultError(400, markets);
    for (const bet of this.bets.filter(bet => bet.eventId === id)) {
      const market = markets.find(candidate => candidate.id === bet.marketId);
      if (!market || !market.outcomes.some(outcome => outcome.id === bet.outcomeId)) {
        return resultError(409, 'No se pueden quitar mercados u opciones que ya tienen apuestas.');
      }
    }
    event.markets = markets;
    event.updatedAt = Date.now();
    this.save();
    return { ok: true, event: copy(event) };
  }

  lockEvent(id) {
    this.lockExpired();
    const event = this.events.get(id);
    if (!event) return resultError(404, 'Evento no encontrado.');
    if (event.status !== 'open') return resultError(409, 'El evento ya no está abierto.');
    event.status = 'locked';
    event.updatedAt = Date.now();
    this.save();
    return { ok: true, event: copy(event) };
  }

  lockExpired() {
    const now = Date.now();
    let changed = false;
    for (const event of this.events.values()) {
      if (event.status === 'open' && new Date(event.startsAt).getTime() <= now) {
        event.status = 'locked';
        event.updatedAt = now;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  listEvents(includeClosed) {
    this.lockExpired();
    return [...this.events.values()]
      .filter(event => includeClosed || ['open', 'locked'].includes(event.status))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map(copy);
  }

  // ---------- Apuestas ----------
  placeBet(token, input) {
    this.lockExpired();
    const user = this.userStore.userForToken(token);
    if (!user) return resultError(401, 'Sesión no válida o cuenta suspendida. Vuelve a entrar.');
    const event = this.events.get(String(input && input.eventId || ''));
    if (!event) return resultError(404, 'Evento no encontrado.');
    if (event.status !== 'open') return resultError(400, 'El evento ya no admite apuestas.');
    if (Date.now() >= new Date(event.startsAt).getTime()) return resultError(400, 'La hora del evento ya ha pasado.');
    const market = event.markets.find(candidate => candidate.id === input.marketId);
    if (!market) return resultError(400, 'Mercado no válido.');
    const outcome = market.outcomes.find(candidate => candidate.id === input.outcomeId);
    if (!outcome) return resultError(400, 'Opción de apuesta no válida.');
    const stake = Number(input.stake);
    if (!Number.isSafeInteger(stake) || stake <= 0) return resultError(400, 'La cantidad debe ser un entero positivo.');
    if (stake > user.chips) return resultError(400, 'No tienes suficientes fichas.');
    const adjusted = this.userStore.setChips(token, user.chips - stake);
    if (!adjusted.ok) return adjusted;
    const now = Date.now();
    const bet = {
      id: crypto.randomBytes(10).toString('hex'),
      eventId: event.id, marketId: market.id, outcomeId: outcome.id,
      accountKey: user.key, username: user.name, stake, odds: outcome.odds,
      marketLabel: market.label, outcomeLabel: outcome.label,
      placedAt: now, updatedAt: now, status: 'pending',
    };
    this.bets.push(bet);
    this.save();
    this.txLog.add({
      type: 'betting_bet', username: user.name, game: 'sports', amount: stake,
      balanceAfter: adjusted.user.chips,
      message: user.name + ' ha apostado ' + stake + ' fichas a ' + outcome.label + ' (cuota ' + outcome.odds + ')',
    });
    return { ok: true, bet: copy(bet), user: adjusted.user };
  }

  mine(token) {
    const user = this.userStore.userForToken(token);
    if (!user) return resultError(401, 'Sesión no válida o cuenta suspendida. Vuelve a entrar.');
    return {
      ok: true,
      bets: this.bets.filter(bet => bet.accountKey === user.key)
        .sort((a, b) => b.placedAt - a.placedAt)
        .map(bet => ({ ...copy(bet), eventTitle: this.events.get(bet.eventId).title })),
    };
  }

  // ---------- Liquidación y cancelación ----------
  settle(adminToken, id, results) {
    if (!this.userStore.isAdmin(adminToken)) return resultError(403, 'No tienes permisos de administrador.');
    this.lockExpired();
    const event = this.events.get(id);
    if (!event) return resultError(404, 'Evento no encontrado.');
    if (event.status !== 'locked') return resultError(409, 'El evento debe estar bloqueado para resolverse.');
    if (!results || typeof results !== 'object' || Array.isArray(results)) {
      return resultError(400, 'Indica el resultado ganador de cada mercado.');
    }
    const winners = new Map();
    for (const market of event.markets) {
      const outcomeId = results[market.id];
      if (!outcomeId) return resultError(400, 'Falta el resultado del mercado: ' + market.label);
      const outcome = market.outcomes.find(candidate => candidate.id === outcomeId);
      if (!outcome) return resultError(400, 'Resultado no válido en el mercado: ' + market.label);
      winners.set(market.id, outcome);
    }
    const now = Date.now();
    let paid = 0;
    for (const bet of this.bets) {
      if (bet.eventId !== id || bet.status !== 'pending') continue;
      const outcome = winners.get(bet.marketId);
      const user = this.userStore.users.get(bet.accountKey);
      if (bet.outcomeId === outcome.id) {
        const requested = Math.floor(bet.stake * bet.odds);
        const adjusted = this.userStore.adjustChips(adminToken, bet.accountKey, requested);
        if (!adjusted.ok) return adjusted;
        bet.status = 'won';
        bet.payout = adjusted.delta;
        paid += adjusted.delta;
        if (adjusted.delta > 0) this.txLog.add({
          type: 'win', username: bet.username, game: 'sports', amount: adjusted.delta,
          balanceAfter: adjusted.after,
          message: bet.username + ' ha ganado ' + adjusted.delta + ' fichas apostando a ' + bet.outcomeLabel + ' (cuota ' + bet.odds + ')',
        });
      } else {
        bet.status = 'lost';
        if (user) this.txLog.add({
          type: 'loss', username: bet.username, game: 'sports', amount: bet.stake,
          balanceAfter: user.chips,
          message: bet.username + ' ha perdido su apuesta de ' + bet.stake + ' fichas a ' + bet.outcomeLabel,
        });
      }
      bet.updatedAt = now;
    }
    event.results = Object.fromEntries(winners);
    event.status = 'settled';
    event.settledAt = now;
    event.updatedAt = now;
    this.save();
    return { ok: true, event: copy(event), paid };
  }

  cancel(adminToken, id) {
    if (!this.userStore.isAdmin(adminToken)) return resultError(403, 'No tienes permisos de administrador.');
    const event = this.events.get(id);
    if (!event) return resultError(404, 'Evento no encontrado.');
    if (!['open', 'locked'].includes(event.status)) return resultError(409, 'El evento ya no se puede cancelar.');
    const now = Date.now();
    let refunded = 0;
    for (const bet of this.bets) {
      if (bet.eventId !== id || bet.status !== 'pending') continue;
      const adjusted = this.userStore.adjustChips(adminToken, bet.accountKey, bet.stake);
      if (!adjusted.ok) return adjusted;
      bet.status = 'refunded';
      bet.payout = adjusted.delta;
      bet.updatedAt = now;
      refunded += adjusted.delta;
      if (adjusted.delta > 0) this.txLog.add({
        type: 'betting_refund', username: bet.username, game: 'sports', amount: adjusted.delta,
        balanceAfter: adjusted.after,
        message: 'Se ha cancelado ' + event.title + ', apuesta de ' + bet.stake + ' fichas devuelta',
      });
    }
    event.status = 'cancelled';
    event.cancelledAt = now;
    event.updatedAt = now;
    this.save();
    return { ok: true, event: copy(event), refunded };
  }
}

module.exports = { BettingStore, MARKET_TYPES, EVENT_STATUSES, BET_STATUSES };
