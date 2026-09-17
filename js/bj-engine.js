// ================================================
//  Motor de Blackjack multijugador (lado servidor)
//  Sin DOM, sin red: lógica pura y testeable.
// ================================================
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SHOE_DECKS = 6;
const MAX_PLAYERS = 5;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I

function handValue(hand) {
  let total = 0, aces = 0;
  for (const card of hand) {
    if (card.rank === 'A') { total += 11; aces++; }
    else if (['J', 'Q', 'K'].includes(card.rank)) total += 10;
    else total += parseInt(card.rank, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
}

function buildShoe() {
  const deck = [];
  for (let d = 0; d < SHOE_DECKS; d++) {
    for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function genCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

class BlackjackRoom {
  constructor(code) {
    this.code = code;
    this.version = 1;
    this.phase = 'lobby'; // lobby | betting | playing | finished
    this.players = [];
    this.dealerHand = [];
    this.deck = [];
    this.message = 'Esperando jugadores…';
    this.turnOrder = []; // ids en orden de turno (derecha → izquierda)
    this.turnId = null;  // jugador al que le toca
    this.lastActivity = Date.now();
  }

  touch() { this.version++; this.lastActivity = Date.now(); }

  find(id) { return this.players.find(p => p.id === id) || null; }

  addPlayer(id, name) {
    if (this.find(id)) return { ok: true };
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: 'La mesa está completa (máx. 5).' };
    }
    this.players.push({
      id, name: (name || 'Jugador').slice(0, 12), chips: 1000, bet: 0,
      confirmed: false, hand: [], played: false, busted: false, doubled: false, result: '',
    });
    this.message = 'Se ha unido ' + this.players[this.players.length - 1].name + '.';
    this.touch();
    return { ok: true };
  }

  removePlayer(id) {
    const i = this.players.findIndex(p => p.id === id);
    if (i === -1) return { ok: true };
    this.players.splice(i, 1);
    if (this.turnOrder) this.turnOrder = this.turnOrder.filter(x => x !== id);
    if (this.turnId === id) this.advanceTurn();
    if (this.phase === 'betting') this.maybeDeal();
    else if (this.phase === 'playing') this.checkAllPlayed();
    this.touch();
    return { ok: true };
  }

  start() {
    if (this.phase !== 'lobby' && this.phase !== 'finished') {
      return { ok: false, error: 'La ronda ya está en marcha.' };
    }
    if (this.players.length === 0) return { ok: false, error: 'No hay jugadores.' };
    if (this.deck.length < 52) this.deck = buildShoe();
    this.dealerHand = [];
    this.turnOrder = [];
    this.turnId = null;
    this.phase = 'betting';
    this.players.forEach(p => {
      p.bet = 0; p.hand = []; p.played = false; p.busted = false;
      p.doubled = false; p.result = ''; p.confirmed = p.chips < 1;
    });
    this.message = 'Ronda de apuestas abierta.';
    this.maybeDeal();
    this.touch();
    return { ok: true };
  }

  bet(id, amount) {
    if (this.phase !== 'betting') return { ok: false, error: 'No es momento de apostar.' };
    const p = this.find(id);
    if (!p) return { ok: false, error: 'No estás en la sala.' };
    if (p.confirmed) return { ok: false, error: 'Ya has confirmado tu apuesta.' };
    amount = Math.max(0, Math.floor(amount || 0));
    if (p.bet + amount > p.chips) return { ok: false, error: 'No tienes tantas fichas.' };
    p.bet += amount;
    this.touch();
    return { ok: true };
  }

  clearBet(id) {
    if (this.phase !== 'betting') return { ok: false, error: 'No es momento de apostar.' };
    const p = this.find(id);
    if (!p || p.confirmed) return { ok: false, error: 'No puedes cambiar tu apuesta.' };
    p.bet = 0;
    this.touch();
    return { ok: true };
  }

  confirm(id) {
    if (this.phase !== 'betting') return { ok: false, error: 'No es momento de apostar.' };
    const p = this.find(id);
    if (!p) return { ok: false, error: 'No estás en la sala.' };
    p.confirmed = true;
    this.maybeDeal();
    this.touch();
    return { ok: true };
  }

  unconfirm(id) {
    if (this.phase !== 'betting') return { ok: false, error: 'No es momento de apostar.' };
    const p = this.find(id);
    if (!p) return { ok: false, error: 'No estás en la sala.' };
    p.confirmed = false;
    this.touch();
    return { ok: true };
  }

  maybeDeal() {
    if (this.phase !== 'betting') return;
    if (!this.players.every(p => p.confirmed)) return;
    if (!this.players.some(p => p.bet > 0)) {
      this.message = 'Nadie ha apostado todavía. Colocad apuestas y confirmad.';
      this.players.forEach(p => { p.confirmed = false; });
      return;
    }
    // Orden de turnos: de derecha a izquierda (asiento de mayor índice primero)
    this.turnOrder = this.players
      .map((p, i) => ({ id: p.id, seat: i, bet: p.bet }))
      .filter(x => x.bet > 0)
      .sort((a, b) => b.seat - a.seat)
      .map(x => x.id);

    // Reparto en orden: una carta por jugador en orden de turno (dos pasadas), dealer al final
    this.players.forEach(p => {
      p.chips -= p.bet;
      p.hand = [];
      p.played = p.bet === 0;
    });
    for (let card = 0; card < 2; card++) {
      for (const id of this.turnOrder) this.find(id).hand.push(this.deck.pop());
    }
    this.dealerHand = [this.deck.pop(), this.deck.pop()];
    this.phase = 'playing';
    this.message = '';
    this.turnId = this.turnOrder[0] || null;
    this.players.forEach(p => {
      if (p.bet > 0 && isBlackjack(p.hand)) p.played = true;
    });
    if (isBlackjack(this.dealerHand)) { this.settle(); return; }
    // Si el primero tiene blackjack natural, salta su turno; si no, le toca jugar
    const first = this.find(this.turnId);
    if (first && first.played) this.advanceTurn();
  }

  advanceTurn() {
    const idx = this.turnOrder.indexOf(this.turnId);
    for (let k = idx + 1; k < this.turnOrder.length; k++) {
      const p = this.find(this.turnOrder[k]);
      if (p && !p.played) { this.turnId = p.id; return; }
    }
    this.turnId = null;
    this.checkAllPlayed();
  }

  hit(id) {
    if (this.phase !== 'playing') return { ok: false, error: 'No es tu momento.' };
    const p = this.find(id);
    if (!p || p.bet === 0) return { ok: false, error: 'No apostaste esta mano.' };
    if (id !== this.turnId) return { ok: false, error: 'Espera tu turno.' };
    if (p.played) return { ok: false, error: 'Ya has terminado tu mano.' };
    p.hand.push(this.deck.pop());
    const value = handValue(p.hand);
    if (value > 21) {
      p.busted = p.played = true;
      this.advanceTurn(); // se pasó: siguiente jugador
    } else if (value === 21) {
      p.played = true;
      this.advanceTurn(); // 21: plantado automáticamente
    }
    this.touch();
    return { ok: true };
  }

  stand(id) {
    if (this.phase !== 'playing') return { ok: false, error: 'No es tu momento.' };
    const p = this.find(id);
    if (!p || p.bet === 0) return { ok: false, error: 'No apostaste esta mano.' };
    if (id !== this.turnId) return { ok: false, error: 'Espera tu turno.' };
    if (p.played) return { ok: false, error: 'Ya has terminado tu mano.' };
    p.played = true;
    this.advanceTurn();
    this.touch();
    return { ok: true };
  }

  double(id) {
    if (this.phase !== 'playing') return { ok: false, error: 'No es tu momento.' };
    const p = this.find(id);
    if (!p || p.bet === 0) return { ok: false, error: 'No apostaste esta mano.' };
    if (id !== this.turnId) return { ok: false, error: 'Espera tu turno.' };
    if (p.played || p.hand.length !== 2) {
      return { ok: false, error: 'Solo puedes doblar con 2 cartas en tu turno.' };
    }
    if (p.chips < p.bet) return { ok: false, error: 'No tienes fichas para doblar.' };
    p.chips -= p.bet;
    p.bet *= 2;
    p.doubled = true;
    p.hand.push(this.deck.pop());
    if (handValue(p.hand) > 21) { p.busted = true; }
    p.played = true;
    this.advanceTurn();
    this.touch();
    return { ok: true };
  }

  checkAllPlayed() {
    if (this.phase !== 'playing') return;
    const active = this.players.filter(p => p.bet > 0);
    if (active.length && active.every(p => p.played)) {
      while (handValue(this.dealerHand) < 17) this.dealerHand.push(this.deck.pop());
      this.settle();
    }
  }

  settle() {
    const dealerVal = handValue(this.dealerHand);
    const dealerBJ = isBlackjack(this.dealerHand);
    const dealerBusted = dealerVal > 21;
    this.players.forEach(p => {
      if (p.bet === 0) { p.result = '🪑'; return; }
      const pv = handValue(p.hand);
      const pBJ = isBlackjack(p.hand);
      let earnings = 0;
      if (pBJ && dealerBJ) { earnings = p.bet; p.result = '🤝'; }
      else if (pBJ) { earnings = Math.floor(p.bet * 2.5); p.result = '🎉'; }
      else if (p.busted) { p.result = '💥'; }
      else if (dealerBJ) { p.result = '😢'; }
      else if (dealerBusted || pv > dealerVal) { earnings = p.bet * 2; p.result = '🏆'; }
      else if (pv < dealerVal) { p.result = '😢'; }
      else { earnings = p.bet; p.result = '🤝'; }
      p.chips += earnings;
    });
    this.phase = 'finished';
    this.message = 'Dealer: ' + dealerVal + (dealerBusted ? ' (se pasa)' : '') + ' — mano resuelta.';
    this.touch();
  }

  // Vista del estado para un jugador concreto (oculta información privada)
  stateFor(playerId) {
    const finished = this.phase === 'finished';
    const dealerVal = handValue(this.dealerHand);
    return {
      code: this.code,
      version: this.version,
      phase: this.phase,
      message: this.message,
      turnId: this.turnId,
      dealer: {
        cards: finished ? this.dealerHand : this.dealerHand.slice(0, 1),
        hidden: !finished && this.dealerHand.length > 1,
        value: finished ? dealerVal : (this.dealerHand.length ? handValue([this.dealerHand[0]]) + '+' : null),
      },
      players: this.players.map(p => {
        return {
          id: p.id, name: p.name, chips: p.chips, bet: p.bet,
          confirmed: p.confirmed, played: p.played, busted: p.busted, doubled: p.doubled,
          result: p.result,
          isTurn: p.id === this.turnId,
          cards: p.hand,
          cardsCount: p.hand.length,
          value: p.hand.length ? handValue(p.hand) : null,
        };
      }),
    };
  }
}

// Export para Node (tests/servidor)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BlackjackRoom, genCode, randomId, handValue, isBlackjack, buildShoe };
}
