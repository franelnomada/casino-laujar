// ================================================
//  Book of Fran — motor de tragaperras 3x3 (servidor)
//  Lógica autoritativa, sin DOM ni red. El cliente solo pinta el estado.
// ================================================
const { chatFor } = require('./room-chat.js');

const SLOT_CONFIG = Object.freeze({
  REELS: 3,
  ROWS: 3,
  MIN_BET: 5,
  MAX_BET: 500,
  SPIN_COOLDOWN_MS: 300,
  BOOKS_TO_TRIGGER: 3,
  FREE_SPINS_AWARDED: 10,
  PAYOUT_FACTOR: 1.45,
  BASE_RTP_TARGET: 0.93,
});

const SYMBOLS = Object.freeze([
  { id: '9', glyph: '\u0039\ufe0f\u20e3', weight: 18, pay: 0.04 },
  { id: '10', glyph: '\u0031\u0030\ufe0f\u20e3', weight: 16, pay: 0.06 },
  { id: 'J', glyph: 'J', weight: 13, pay: 0.09 },
  { id: 'Q', glyph: 'Q', weight: 10, pay: 0.13 },
  { id: 'K', glyph: 'K', weight: 8, pay: 0.20 },
  { id: 'A', glyph: 'A', weight: 6, pay: 0.33 },
  { id: 'ankh', glyph: '\u{132f9}', weight: 4, pay: 0.55 },
  { id: 'cobra', glyph: '\u{1f40d}', weight: 3, pay: 0.92 },
  { id: 'scarab', glyph: '\u{13153}', weight: 1.4, pay: 1.65 },
  { id: 'crown', glyph: '\u{1f451}', weight: 0.6, pay: 3.20 },
  { id: 'book', glyph: '\u{1f4d6}', weight: 0.4, pay: 0 },
]);

const BOOK = 'book';
const PAY_SYMBOLS = SYMBOLS.filter(s => s.id !== BOOK);
const SYMBOL_BY_ID = new Map(SYMBOLS.map(symbol => [symbol.id, symbol]));
const SYMBOLS_TOTAL_WEIGHT = SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);

function symbolForRoll(roll) {
  const value = Number(roll) || 0;
  let cursor = Math.max(0, value) * SYMBOLS_TOTAL_WEIGHT;
  for (const symbol of SYMBOLS) {
    cursor -= symbol.weight;
    if (cursor < 0) return symbol.id;
  }
  return SYMBOLS[SYMBOLS.length - 1].id;
}

function makeGrid(random = Math.random) {
  return Array.from({ length: SLOT_CONFIG.REELS }, () =>
    Array.from({ length: SLOT_CONFIG.ROWS }, () => symbolForRoll(random())));
}

function expandGrid(grid, expandedSymbol) {
  if (!PAY_SYMBOLS.some(symbol => symbol.id === expandedSymbol)) {
    return { grid: grid.map(reel => reel.slice()), expandedReels: [] };
  }
  const expandedReels = [];
  const expanded = grid.map((reel, index) => {
    if (!reel.includes(expandedSymbol)) return reel.slice();
    expandedReels.push(index);
    return Array(SLOT_CONFIG.ROWS).fill(expandedSymbol);
  });
  return { grid: expanded, expandedReels };
}

function evaluateGrid(grid, bet) {
  const lines = [];
  let total = 0;
  for (let row = 0; row < SLOT_CONFIG.ROWS; row++) {
    const symbols = grid.map(reel => reel[row]);
    const base = symbols.find(symbol => symbol !== BOOK);
    if (!base || !symbols.every(symbol => symbol === base || symbol === BOOK)) continue;
    const win = Math.floor(Number(bet) * SYMBOL_BY_ID.get(base).pay * SLOT_CONFIG.PAYOUT_FACTOR);
    if (win > 0) {
      lines.push({ row: row + 1, symbols, symbol: base, multiplier: SYMBOL_BY_ID.get(base).pay, win });
      total += win;
    }
  }
  return { lines, win: total };
}

function countBooks(grid) {
  return grid.reduce((sum, reel) => sum + reel.filter(symbol => symbol === BOOK).length, 0);
}

function chooseExpandedSymbol(random = Math.random) {
  return PAY_SYMBOLS[Math.floor(Math.max(0, Number(random) || 0) * PAY_SYMBOLS.length)].id;
}

class BookOfFranRoom {
  constructor(code, options = {}) {
    this.code = code;
    this.game = 'book-of-fran';
    this.version = 1;
    this.phase = 'betting';
    this.players = [];
    this.message = 'Abre el Book of Fran y busca los libros dorados.';
    this.chat = [];
    this.chatLastSent = new Map();
    this.lastActivity = Date.now();
    this._random = typeof options.random === 'function' ? options.random : Math.random;
    this._lastSpinAt = new Map();
  }

  touch() { this.version++; this.lastActivity = Date.now(); }
  find(id) { return this.players.find(player => player.id === id) || null; }
  alive() { return this.players.filter(player => !player.left); }

  addPlayer(id, name, initChips) {
    if (this.find(id)) return { ok: true };
    const chips = initChips != null ? Math.max(0, initChips) : 1000;
    this.players.push({ id, name: String(name || 'Jugador').slice(0, 12), chips, left: false,
      slotBet: SLOT_CONFIG.MIN_BET, freeSpins: 0, expandedSymbol: null,
      lastResult: null, lastWin: 0, lastBookCount: 0, lastFreeSpinsAwarded: 0 });
    this.touch();
    return { ok: true };
  }

  removePlayer(id) {
    const player = this.find(id);
    if (!player) return { ok: true, chips: null };
    player.left = true;
    this._lastSpinAt.delete(id);
    this.touch();
    return { ok: true, chips: player.chips };
  }

  spin(id, amount) {
    const player = this.find(id);
    if (!player || player.left) return { ok: false, error: 'No eres jugador de esta mesa.' };
    const now = Date.now();
    if (now - (this._lastSpinAt.get(id) || 0) < SLOT_CONFIG.SPIN_COOLDOWN_MS) return { ok: false, error: 'Espera un momento antes del siguiente giro.' };
    this._lastSpinAt.set(id, now);
    const isFreeSpin = player.freeSpins > 0;
    let bet = 0;
    if (!isFreeSpin) {
      bet = Math.floor(Number(amount));
      if (!Number.isSafeInteger(bet) || bet < SLOT_CONFIG.MIN_BET || bet > SLOT_CONFIG.MAX_BET) return { ok: false, error: 'Elige una apuesta entre 5 y 500 fichas.' };
      if (player.chips < bet) return { ok: false, error: 'No tienes suficientes fichas.' };
      player.chips -= bet; player.slotBet = bet;
    } else bet = player.slotBet;
    const rawGrid = makeGrid(this._random);
    const expanded = isFreeSpin ? expandGrid(rawGrid, player.expandedSymbol) : { grid: rawGrid, expandedReels: [] };
    const result = evaluateGrid(expanded.grid, bet);
    const bookCount = countBooks(rawGrid);
    let awarded = 0;
    let expandedSymbol = isFreeSpin ? player.expandedSymbol : null;
    if (isFreeSpin) {
      player.freeSpins -= 1;
      if (bookCount >= SLOT_CONFIG.BOOKS_TO_TRIGGER) { awarded = SLOT_CONFIG.FREE_SPINS_AWARDED; player.freeSpins += awarded; }
      if (player.freeSpins <= 0) { player.freeSpins = 0; player.expandedSymbol = null; }
    } else if (bookCount >= SLOT_CONFIG.BOOKS_TO_TRIGGER) {
      awarded = SLOT_CONFIG.FREE_SPINS_AWARDED; player.freeSpins = awarded; player.expandedSymbol = chooseExpandedSymbol(this._random); expandedSymbol = player.expandedSymbol;
    }
    player.chips += result.win;
    player.lastResult = { grid: expanded.grid, rawGrid, expandedReels: expanded.expandedReels, lines: result.lines, win: result.win, bookCount, awarded, expandedSymbol, mode: isFreeSpin ? 'free' : 'normal' };
    player.lastWin = result.win; player.lastBookCount = bookCount; player.lastFreeSpinsAwarded = awarded;
    if (awarded) player.lastBookSummary = { books: bookCount, spins: awarded };
    this.message = awarded ? `📖 ${player.name} activa ${awarded} giros gratis: ${SYMBOL_BY_ID.get(expandedSymbol).glyph} se expande.` : (result.win > 0 ? `✨ ${player.name} gana ${result.win} fichas en Book of Fran.` : (isFreeSpin ? `Giro gratis: ${player.freeSpins} restantes.` : 'La arena no perdona… vuelve a intentarlo.'));
    this.touch();
    return { ok: true };
  }

  stateFor(playerId) {
    return { code: this.code, game: this.game, version: this.version, phase: this.phase, message: this.message,
      chat: chatFor(this), config: SLOT_CONFIG, symbols: SYMBOLS,
      players: this.alive().map(p => ({ id: p.id, name: p.name, chips: p.chips, freeSpins: p.freeSpins,
        expandedSymbol: p.expandedSymbol, lastResult: p.id === playerId ? p.lastResult : null })) };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { BookOfFranRoom, SLOT_CONFIG, SYMBOLS, BOOK, makeGrid, expandGrid, evaluateGrid, countBooks, chooseExpandedSymbol };
