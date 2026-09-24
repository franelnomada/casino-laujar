// ================================================
//  Book of Fran — motor de tragaperras 5x3 (servidor)
//  Lógica autoritativa, sin DOM ni red. El cliente solo pinta el estado.
// ================================================
const { chatFor } = require('./room-chat.js');

const SLOT_CONFIG = Object.freeze({
  REELS: 5,
  ROWS: 3,
  MIN_LINES: 1,
  MAX_LINES: 10,
  MIN_BET_PER_LINE: 5,
  MAX_BET_PER_LINE: 100,
  SPIN_COOLDOWN_MS: 300,
  BOOKS_TO_TRIGGER: 3,
  FREE_SPINS_AWARDED: 10,
  BASE_RTP_TARGET: 0.93,
  BIG_WIN_MULTIPLIER: 20,
});

// Filas indexadas desde 0. Las 10 líneas se evalúan en este orden.
const PAYLINES = Object.freeze([
  { id: 1, name: ' superior', rows: [0, 0, 0, 0, 0] },
  { id: 2, name: ' central', rows: [1, 1, 1, 1, 1] },
  { id: 3, name: ' inferior', rows: [2, 2, 2, 2, 2] },
  { id: 4, name: ' en V', rows: [0, 1, 2, 1, 0] },
  { id: 5, name: ' en V invertida', rows: [2, 1, 0, 1, 2] },
  { id: 6, name: ' zigurat superior', rows: [0, 0, 1, 2, 2] },
  { id: 7, name: ' zigurat inferior', rows: [2, 2, 1, 0, 0] },
  { id: 8, name: ' diagonal descendente', rows: [1, 0, 0, 0, 1] },
  { id: 9, name: ' diagonal ascendente', rows: [1, 2, 2, 2, 1] },
  { id: 10, name: ' quiebro central', rows: [2, 1, 1, 1, 2] },
]);

// Los pagos son multiplicadores de la apuesta de ESA línea.
const SYMBOLS = Object.freeze([
  { id: '9', glyph: '9️⃣', weight: 26, pays: { 3: 10.65, 4: 35.49, 5: 106.47 } },
  { id: '10', glyph: '🔟', weight: 22, pays: { 3: 14.2, 4: 46.41, 5: 141.96 } },
  { id: 'J', glyph: 'J', weight: 18, pays: { 3: 21.29, 4: 70.98, 5: 212.94 } },
  { id: 'Q', glyph: 'Q', weight: 14, pays: { 3: 31.94, 4: 106.47, 5: 319.41 } },
  { id: 'K', glyph: 'K', weight: 11, pays: { 3: 49.69, 4: 159.71, 5: 496.86 } },
  { id: 'A', glyph: 'A', weight: 8.5, pays: { 3: 70.98, 4: 230.69, 5: 709.8 } },
  { id: 'ankh', glyph: '\u{132f9}', weight: 5.5, pays: { 3: 113.57, 4: 354.9, 5: 1064.7 } },
  { id: 'cobra', glyph: '\u{1f40d}', weight: 3, pays: { 3: 184.55, 4: 567.84, 5: 1774.5 } },
  { id: 'scarab', glyph: '\u{13153}', weight: 1.25, pays: { 3: 319.41, 4: 993.72, 5: 5441.1 } },
  { id: 'crown', glyph: '\u{1f451}', weight: .25, pays: { 3: 567.84, 4: 1774.5, 5: 7098 } },
  { id: 'book', glyph: '\u{1f4d6}', weight: .5, pays: null },
]);

const BOOK = 'book';
const PAY_SYMBOLS = SYMBOLS.filter(symbol => symbol.pays);
const SYMBOL_BY_ID = new Map(SYMBOLS.map(symbol => [symbol.id, symbol]));
const SYMBOLS_TOTAL_WEIGHT = SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);

function symbolForRoll(roll) {
  const value = Number(roll) || 0;
  let cursor = Math.max(0, value) * SYMBOLS_TOTAL_WEIGHT;
  for (const symbol of SYMBOLS) {
    cursor -= symbol.weight;
    if (cursor < 0) return symbol.id;
  }
  return BOOK;
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

function evaluateGrid(grid, betPerLine = 1, activeLines = PAYLINES.length) {
  const requested = Math.floor(Number(activeLines));
  const lineCount = Math.max(SLOT_CONFIG.MIN_LINES, Math.min(SLOT_CONFIG.MAX_LINES, requested || PAYLINES.length));
  const bet = Number(betPerLine);
  if (!Number.isFinite(bet) || bet <= 0) throw new Error('La apuesta por línea debe ser positiva.');
  const lines = [];
  let total = 0;
  for (const payline of PAYLINES.slice(0, lineCount)) {
    const symbols = payline.rows.map((row, reel) => grid[reel] == null ? null : grid[reel][row]);
    const firstThree = symbols.slice(0, 3);
    const base = firstThree.find(symbol => symbol && symbol !== BOOK);
    if (!base || !firstThree.every(symbol => symbol === base || symbol === BOOK)) continue;
    let count = 0;
    for (const symbol of symbols) {
      if (symbol !== base && symbol !== BOOK) break;
      count++;
    }
    const payout = SYMBOL_BY_ID.get(base).pays[count];
    const win = Math.floor(bet * payout);
    if (win <= 0) continue;
    const positions = Array.from({ length: count }, (_, reel) => ({ reel, row: payline.rows[reel] }));
    lines.push({ line: payline.id, name: payline.name, rows: payline.rows.slice(), symbol: base,
      count, payout, betPerLine: bet, win, positions });
    total += win;
  }
  return { lines, win: total };
}

function countBooks(grid) {
  return grid.reduce((sum, reel) => sum + reel.filter(symbol => symbol === BOOK).length, 0);
}

function chooseExpandedSymbol(random = Math.random) {
  return PAY_SYMBOLS[Math.floor(Math.max(0, Math.min(.999999, Number(random()) || 0)) * PAY_SYMBOLS.length)].id;
}

// Estimador reproducible. No participa en un giro: sirve para auditar el RTP.
// Simula el coste de todos los giros, incluidos los gratuitos, y sus re-disparos.
function estimateRtp(rounds = 10000, options = {}) {
  const random = options.random || Math.random;
  const freeSpins = options.freeSpins || 0;
  let returned = 0;
  let wagered = 0;
  for (let round = 0; round < rounds; round++) {
    const activeLines = 1 + Math.floor(random() * PAYLINES.length);
    const betPerLine = SLOT_CONFIG.MIN_BET_PER_LINE;
    const cost = activeLines * betPerLine;
    wagered += cost;
    const raw = makeGrid(random);
    returned += evaluateGrid(raw, betPerLine, activeLines).win;
    if (!freeSpins || countBooks(raw) < SLOT_CONFIG.BOOKS_TO_TRIGGER) continue;
    const expandedSymbol = chooseExpandedSymbol(random);
    let free = freeSpins;
    while (free > 0) {
      const bonusRaw = makeGrid(random);
      const bonusGrid = expandGrid(bonusRaw, expandedSymbol).grid;
      returned += evaluateGrid(bonusGrid, betPerLine, activeLines).win;
      wagered += cost;
      free--;
      if (countBooks(bonusRaw) >= SLOT_CONFIG.BOOKS_TO_TRIGGER) free += freeSpins;
    }
  }
  return returned / wagered;
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
      slotActiveLines: SLOT_CONFIG.MAX_LINES, slotBetPerLine: SLOT_CONFIG.MIN_BET_PER_LINE,
      spinCount: 0, freeSpins: 0, expandedSymbol: null, bonusWinTotal: 0, bonusSpinsPlayed: 0,
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

  spin(id, bet = {}) {
    const player = this.find(id);
    if (!player || player.left) return { ok: false, error: 'No eres jugador de esta mesa.' }
    // Salas 3x3 persistidas: migra su apuesta total al nuevo formato por línea.
    if (player.slotActiveLines == null) player.slotActiveLines = 1;
    if (player.slotBetPerLine == null) player.slotBetPerLine = Math.max(SLOT_CONFIG.MIN_BET_PER_LINE, Math.floor(Number(player.slotBet) / player.slotActiveLines) || SLOT_CONFIG.MIN_BET_PER_LINE);
    if (player.bonusWinTotal == null) player.bonusWinTotal = 0;
    if (player.bonusSpinsPlayed == null) player.bonusSpinsPlayed = 0;
    const isFreeSpin = player.freeSpins > 0;
    const activeLines = isFreeSpin ? player.slotActiveLines : Math.floor(Number(bet.activeLines));
    const betPerLine = isFreeSpin ? player.slotBetPerLine : Math.floor(Number(bet.betPerLine));
    const totalBet = activeLines * betPerLine;
    if (!isFreeSpin && (!Number.isSafeInteger(activeLines) || activeLines < SLOT_CONFIG.MIN_LINES || activeLines > SLOT_CONFIG.MAX_LINES)) {
      return { ok: false, error: `Elige entre ${SLOT_CONFIG.MIN_LINES} y ${SLOT_CONFIG.MAX_LINES} líneas activas.` };
    }
    if (!isFreeSpin && (!Number.isSafeInteger(betPerLine) || betPerLine < SLOT_CONFIG.MIN_BET_PER_LINE || betPerLine > SLOT_CONFIG.MAX_BET_PER_LINE)) {
      return { ok: false, error: `Elige una apuesta por línea entre ${SLOT_CONFIG.MIN_BET_PER_LINE} y ${SLOT_CONFIG.MAX_BET_PER_LINE} fichas.` };
    }
    if (!isFreeSpin && player.chips < totalBet) {
      return { ok: false, error: `Saldo insuficiente. El giro cuesta ${totalBet} fichas.` };
    }

    const now = Date.now();
    if (now - (this._lastSpinAt.get(id) || 0) < SLOT_CONFIG.SPIN_COOLDOWN_MS) {
      return { ok: false, error: 'Espera un momento antes del siguiente giro.' };
    }
    this._lastSpinAt.set(id, now);
    if (!isFreeSpin) {
      player.chips -= totalBet;
      player.slotActiveLines = activeLines;
      player.slotBetPerLine = betPerLine;
    }

    const rawGrid = makeGrid(this._random);
    const expanded = isFreeSpin ? expandGrid(rawGrid, player.expandedSymbol) : { grid: rawGrid, expandedReels: [] };
    const result = evaluateGrid(expanded.grid, betPerLine, activeLines);
    const bookCount = countBooks(rawGrid);
    let awarded = 0;
    let bonusStarted = false;
    let bonusEnded = false;
    const resultExpandedSymbol = isFreeSpin ? player.expandedSymbol : null;
    if (isFreeSpin) {
      player.freeSpins -= 1;
      player.bonusSpinsPlayed += 1;
      player.bonusWinTotal += result.win;
      if (bookCount >= SLOT_CONFIG.BOOKS_TO_TRIGGER) {
        awarded = SLOT_CONFIG.FREE_SPINS_AWARDED;
        player.freeSpins += awarded;
      }
      if (player.freeSpins <= 0) {
        player.freeSpins = 0;
        bonusEnded = true;
        player.expandedSymbol = null;
      }
    } else if (bookCount >= SLOT_CONFIG.BOOKS_TO_TRIGGER) {
      awarded = SLOT_CONFIG.FREE_SPINS_AWARDED;
      player.freeSpins = awarded;
      player.expandedSymbol = chooseExpandedSymbol(this._random);
      bonusStarted = true;
    }
    player.chips += result.win;
    if (player.spinCount == null) player.spinCount = 0;
    player.spinCount += 1;
    player.lastResult = {
      spinId: player.spinCount,
      grid: expanded.grid, rawGrid, expandedReels: expanded.expandedReels,
      lines: result.lines, win: result.win, bookCount, awarded,
      expandedSymbol: bonusStarted ? player.expandedSymbol : resultExpandedSymbol,
      mode: isFreeSpin ? 'free' : 'normal', activeLines, betPerLine,
      totalBet: isFreeSpin ? 0 : totalBet, freeSpinsRemaining: player.freeSpins,
      bonusWinTotal: player.bonusWinTotal, bonusStarted, bonusEnded,
      bigWin: result.win >= totalBet * SLOT_CONFIG.BIG_WIN_MULTIPLIER,
    };
    player.lastWin = result.win;
    player.lastBookCount = bookCount;
    player.lastFreeSpinsAwarded = awarded;
    if (awarded) player.lastBookSummary = { books: bookCount, spins: awarded };
    const symbol = bonusStarted ? SYMBOL_BY_ID.get(player.expandedSymbol).glyph : '';
    this.message = awarded ? `📖 ${player.name} ${isFreeSpin ? 'reactiva' : 'activa'} ${awarded} giros gratis${symbol ? `: ${symbol} se expande` : ''}.`
      : bonusEnded ? `✨ Fin de los giros gratis: ${player.name} ganó ${player.bonusWinTotal} fichas en la ronda.`
      : result.win > 0 ? `✨ ${player.name} gana ${result.win} fichas en Book of Fran.`
      : isFreeSpin ? `Giro gratis: ${player.freeSpins} restantes.`
      : 'La arena no perdona… vuelve a intentarlo.';
    this.touch();
    return { ok: true };
  }

  stateFor(playerId) {
    return { code: this.code, game: this.game, version: this.version, phase: this.phase, message: this.message,
      chat: chatFor(this), config: SLOT_CONFIG, symbols: SYMBOLS, paylines: PAYLINES,
      players: this.alive().map(p => ({ id: p.id, name: p.name, chips: p.chips, freeSpins: p.freeSpins,
        expandedSymbol: p.expandedSymbol, bonusWinTotal: p.bonusWinTotal, bonusSpinsPlayed: p.bonusSpinsPlayed,
        lastResult: p.id === playerId ? p.lastResult : null })) };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { BookOfFranRoom, SLOT_CONFIG, SYMBOLS, PAYLINES, BOOK, makeGrid, expandGrid, evaluateGrid, countBooks, chooseExpandedSymbol, estimateRtp };
