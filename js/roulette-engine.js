// ================================================
//  Motor de Ruleta Europea multijugador (servidor)
//  Sin DOM, sin red: lógica pura y testeable.
// ================================================
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const MAX_PLAYERS = 10;
const START_CHIPS = 1000;
const { ensureChat, chatFor } = require('./room-chat.js');

function roulettePayout(id, n, amount) {
  const win = (mult) => amount + amount * mult;
  if (typeof id !== 'string') return 0;
  if (id.startsWith('n')) {
    return parseInt(id.slice(1), 10) === n ? win(35) : 0;
  }
  if (n === 0) return 0;
  switch (id) {
    case 'red':    return RED.has(n) ? win(1) : 0;
    case 'black':  return !RED.has(n) ? win(1) : 0;
    case 'even':   return n % 2 === 0 ? win(1) : 0;
    case 'odd':    return n % 2 === 1 ? win(1) : 0;
    case 'low':    return n <= 18 ? win(1) : 0;
    case 'high':   return n >= 19 ? win(1) : 0;
    case 'dozen1': return n <= 12 ? win(2) : 0;
    case 'dozen2': return (n >= 13 && n <= 24) ? win(2) : 0;
    case 'dozen3': return n >= 25 ? win(2) : 0;
    case 'col1':   return n % 3 === 1 ? win(2) : 0;
    case 'col2':   return n % 3 === 2 ? win(2) : 0;
    case 'col3':   return n % 3 === 0 ? win(2) : 0;
    default: return 0;
  }
}

class RouletteRoom {
  constructor(code) {
    this.code = code;
    this.game = 'roulette';
    this.version = 1;
    this.phase = 'betting';
    this.players = [];
    this.bets = {};
    this.lastNumber = null;
    this.lastPayouts = {};
    this.message = 'Coloca tus apuestas y gira cuando quieras.';
    this.chat = [];
    this.chatLastSent = new Map();
    this.lastActivity = Date.now();
  }

  touch() { this.version++; this.lastActivity = Date.now(); }
  find(id) { return this.players.find(p => p.id === id) || null; }
  alive() { return this.players.filter(p => !p.left); }

  addPlayer(id, name, initChips) {
    if (this.find(id)) return { ok: true };
    if (this.alive().length >= MAX_PLAYERS) return { ok: false, error: 'Mesa completa.' };
    this.players = this.players.filter(p => !p.left);
    // Respeta el saldo real del jugador, incluido el cero. Default solo si no llega valor.
    const chips = (initChips != null) ? Math.max(0, initChips) : START_CHIPS;
    this.players.push({ id, name: String(name || 'Jugador').slice(0, 12), chips, bet: 0, left: false });
    this.message = 'Se ha unido ' + this.players[this.players.length - 1].name + '.';
    this.touch();
    return { ok: true };
  }

  removePlayer(id) {
    const p = this.find(id);
    if (!p) return { ok: true, chips: null };
    p.left = true;
    if (this.bets[id]) {
      const total = Object.values(this.bets[id]).reduce((a, b) => a + b, 0);
      p.chips += total;
      p.bet = Math.max(0, p.bet - total);
      delete this.bets[id];
    }
    this.players = this.players.filter(q => !q.left);
    this.touch();
    return { ok: true, chips: p.chips };
  }

  hasAnyBet() { return Object.values(this.bets).some(b => Object.keys(b || {}).length > 0); }

  bet(id, betId, amount) {
    const p = this.find(id);
    if (!p || p.left) return { ok: false, error: 'No eres jugador de esta mesa.' };
    if (this.phase !== 'betting') return { ok: false, error: 'Espera al proximo giro.' };

    const value = Math.floor(Number(amount));
    if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, error: 'Apuesta no valida.' };
    if (p.chips < value) return { ok: false, error: 'No tienes suficientes fichas.' };
    if (!/^(n([0-9]|[12][0-9]|3[0-6])|red|black|even|odd|low|high|dozen[123]|col[123])$/.test(String(betId))) {
      return { ok: false, error: 'Casilla no valida.' };
    }
    p.chips -= value;
    p.bet += value;
    if (!this.bets[id]) this.bets[id] = {};
    this.bets[id][betId] = (this.bets[id][betId] || 0) + value;
    this.touch();
    return { ok: true };
  }

  clearBet(id) {
    const p = this.find(id);
    if (!p || p.left) return { ok: false, error: 'No eres jugador de esta mesa.' };
    if (this.phase !== 'betting') return { ok: false, error: 'Ya no se puede cambiar.' };
    const mine = this.bets[id] || {};
    const total = Object.values(mine).reduce((a, b) => a + b, 0);
    if (total > 0) {
      p.chips += total;
      p.bet = Math.max(0, p.bet - total);
      delete this.bets[id];
      this.touch();
    }
    return { ok: true };
  }

  spin(fixedNumber) {
    if (this.phase !== 'betting') return { ok: false, error: 'Ya se esta resolviendo.' };
    if (!this.hasAnyBet()) return { ok: false, error: 'Coloca alguna apuesta.' };
    const n = (Number.isInteger(fixedNumber) && fixedNumber >= 0 && fixedNumber <= 36)
      ? fixedNumber : Math.floor(Math.random() * 37);
    this.lastNumber = n;
    this.lastPayouts = {};
    let totalReturn = 0;
    for (const [pid, playerBets] of Object.entries(this.bets)) {
      let ret = 0;
      for (const [betId, amt] of Object.entries(playerBets || {})) ret += roulettePayout(betId, n, amt);
      const p = this.find(pid);
      if (p && !p.left) p.chips += ret;
      this.lastPayouts[pid] = ret;
      totalReturn += ret;
    }
    for (const p of this.players) p.bet = 0;
    this.bets = {};
    const color = n === 0 ? 'verde' : (RED.has(n) ? 'rojo' : 'negro');
    this.message = '🎯 Salio el ' + n + ' (' + color + ').' +
      (totalReturn > 0 ? ' Se reparten ' + totalReturn + ' fichas.' : ' Sin suerte…');
    this.touch();
    return { ok: true, number: n };
  }

  summary() {
    return { code: this.code, game: this.game, players: this.alive().length, phase: 'betting', lastActivity: this.lastActivity };
  }

  stateFor() {
    const tableTotal = Object.values(this.bets).reduce((sum, mine) =>
      sum + Object.values(mine || {}).reduce((a, b) => a + b, 0), 0);
    return {
      code: this.code, game: this.game, version: this.version, phase: this.phase,
      message: this.message, chat: chatFor(this), lastNumber: this.lastNumber, lastPayouts: this.lastPayouts,
      tableTotal: tableTotal, bets: this.bets,
      players: this.players.filter(q => !q.left).map(q => ({ id: q.id, name: q.name, chips: q.chips, bet: q.bet })),
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RouletteRoom, roulettePayout, RED };
}
