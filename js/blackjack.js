// ==========================================
//  Blackjack multijugador (hot-seat)
// ==========================================
const Blackjack = {
  SUITS: ['♠', '♥', '♦', '♣'],
  RANKS: ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'],
  MAX_SEATS: 5,

  players: [],   // { name, chips, bet, hand, result, doubled, played }
  dealerHand: [],
  current: 0,
  phase: 'setup', // setup | betting | playing | finished
  deck: [],

  // ---------- Utilidades ----------
  message(text) {
    document.getElementById('bj-message').textContent = text;
  },

  setControls(which) {
    ['bj-setup', 'bj-bet-zone', 'bj-actions', 'bj-replay'].forEach(id =>
      document.getElementById(id).classList.toggle('hidden', id !== 'bj-' + which)
    );
  },

  handValue(hand) {
    let total = 0, aces = 0;
    for (const card of hand) {
      if (card.rank === 'A') { total += 11; aces++; }
      else if (['J', 'Q', 'K'].includes(card.rank)) total += 10;
      else total += parseInt(card.rank, 10);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  },

  isBlackjack(hand) {
    return hand.length === 2 && this.handValue(hand) === 21;
  },

  buildDeck() {
    this.deck = [];
    for (const suit of this.SUITS) {
      for (const rank of this.RANKS) this.deck.push({ rank, suit });
    }
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  },

  draw() {
    return this.deck.pop();
  },

  // ---------- Gestión de jugadores ----------
  addPlayerFromInput() {
    const input = document.getElementById('bj-name-input');
    const name = input.value.trim() || ('Jugador ' + (this.players.length + 1));
    if (this.players.length >= this.MAX_SEATS) {
      this.message('La mesa está completa (5 jugadores).');
      return;
    }
    this.players.push({ name, chips: 1000, bet: 0, hand: [], result: '', played: false });
    input.value = '';
    this.renderSeats();
    this.message('');
  },

  removePlayer(index) {
    this.players.splice(index, 1);
    this.renderSeats();
  },

  startGame() {
    if (this.players.length === 0) {
      this.message('Añade al menos un jugador para empezar.');
      return;
    }
    this.phase = 'betting';
    this.current = Math.max(0, this.players.length - 1); // el asiento más a la derecha apuesta primero
    this._prevCounts = {};
    this._prevDealer = 0;
    this.setControls('bet-zone');
    this.renderSeats();
    this.updateTurnLabels();
    this.message('');
  },

  editPlayers() {
    this.phase = 'setup';
    this.dealerHand = [];
    this.players.forEach(p => { p.bet = 0; p.hand = []; p.result = ''; p.played = false; });
    this.setControls('setup');
    this.renderSeats();
    this.message('');
  },

  updateTurnLabels() {
    const p = this.players[this.current];
    const name = p ? p.name : '';
    document.getElementById('bj-turn-name').textContent = name;
    document.getElementById('bj-turn-name-2').textContent = name;
  },

  // ---------- Ronda de apuestas ----------
  addBet(amount) {
    if (this.phase !== 'betting') return;
    const p = this.players[this.current];
    if (p.chips < amount) {
      this.message('¡' + p.name + ' no tiene suficientes fichas!');
      return;
    }
    p.chips -= amount;
    p.bet += amount;
    this.renderSeats();
    this.message('');
  },

  clearBet() {
    if (this.phase !== 'betting') return;
    const p = this.players[this.current];
    p.chips += p.bet;
    p.bet = 0;
    this.renderSeats();
  },

  confirmBet() {
    if (this.phase !== 'betting') return;
    const p = this.players[this.current];
    if (p.bet <= 0) { this.message('Coloca una apuesta en tu círculo.'); return; }
    p.played = false;
    this.current--; // hacia la izquierda
    if (this.current < 0) {
      this.dealInitial();
    } else {
      this.updateTurnLabels();
      this.renderSeats();
    }
  },

  pass() {
    if (this.phase !== 'betting') return;
    const p = this.players[this.current];
    p.bet = 0;
    p.played = true;   // no juega esta mano
    this.current--; // hacia la izquierda
    if (this.current < 0) this.dealInitial();
    else { this.updateTurnLabels(); this.renderSeats(); }
  },

  lastActive() {
    for (let i = this.players.length - 1; i >= 0; i--) {
      if (this.players[i].bet > 0) return i;
    }
    return 0;
  },

  dealInitial() {
    this.buildDeck();
    this._prevCounts = {};
    this._prevDealer = 0;
    // Reparto en orden: una carta por jugador de derecha a izquierda, dos pasadas, dealer al final
    const bettors = [];
    for (let i = this.players.length - 1; i >= 0; i--) {
      if (this.players[i].bet > 0) bettors.push(this.players[i]);
    }
    this.players.forEach(p => {
      p.hand = [];
      p.played = p.bet === 0;
      p.result = '';
      p.doubled = false;
      p.busted = false;
    });
    for (let card = 0; card < 2; card++) {
      for (const p of bettors) p.hand.push(this.draw());
    }
    this.dealerHand = [this.draw(), this.draw()];
    this.current = this.lastActive();
    this.phase = 'playing';
    this.renderAll();
    this.updateTurnLabels();
    this.setControls('actions');

    // Check de blackjacks naturales
    if (this.isBlackjack(this.dealerHand)) {
      this.settleAll();
      return;
    }
    if (this.isBlackjack(this.players[this.current].hand)) {
      this.finishPlayerTurn();
    }
  },

  // ---------- Acciones de juego ----------
  hit() {
    if (this.phase !== 'playing') return;
    const p = this.players[this.current];
    p.hand.push(this.draw());
    const value = this.handValue(p.hand);
    this.renderSeats();
    this.updateTurnLabels();
    if (value > 21) {
      p.result = '💥';
      p.busted = true;
      this.finishPlayerTurn();
    } else if (value === 21) {
      this.finishPlayerTurn();
    }
  },

  stand() {
    if (this.phase !== 'playing') return;
    this.finishPlayerTurn();
  },

  doubleDown() {
    if (this.phase !== 'playing') return;
    const p = this.players[this.current];
    if (p.hand.length !== 2) return;
    if (p.chips < p.bet) {
      this.message('¡No tienes fichas para doblar, ' + p.name + '!');
      return;
    }
    p.chips -= p.bet;
    p.bet *= 2;
    p.doubled = true;
    p.hand.push(this.draw());
    if (this.handValue(p.hand) > 21) {
      p.result = '💥';
      p.busted = true;
    }
    this.renderSeats();
    this.finishPlayerTurn();
  },

  finishPlayerTurn() {
    const p = this.players[this.current];
    if (p && p.bet > 0 && p.result !== '💥' && !p.played) p.played = true;
    // Siguiente jugador activo hacia la izquierda
    do {
      this.current--;
      if (this.current < 0) break;
      var next = this.players[this.current];
      if (next.bet > 0 && !next.played) break;
    } while (true);

    if (this.current < 0) {
      this.dealerPlay();
    } else {
      this.renderSeats();
      this.updateTurnLabels();
    }
  },

  dealerPlay() {
    // El dealer roba hasta 17 o más
    while (this.handValue(this.dealerHand) < 17) {
      this.dealerHand.push(this.draw());
    }
    this.settleAll();
  },

  settleAll() {
    const dealerVal = this.handValue(this.dealerHand);
    const dealerBJ = this.isBlackjack(this.dealerHand);
    const dealerBusted = dealerVal > 21;
    const parts = ['Dealer: ' + dealerVal + (dealerBusted ? ' (se pasa)' : '')];

    this.players.forEach(p => {
      if (p.bet === 0) { p.result = '🪑'; return; }
      const pv = this.handValue(p.hand);
      const pBJ = this.isBlackjack(p.hand);
      let earnings = 0;
      let text = '';
      if (pBJ && dealerBJ) {
        earnings = p.bet; text = '🤝 Empate';
      } else if (pBJ) {
        earnings = Math.floor(p.bet * 2.5); text = '🎉 Blackjack +' + (earnings - p.bet);
      } else if (p.busted) {
        text = '💥 Pierde ' + p.bet;
      } else if (dealerBJ) {
        text = '😢 Pierde ' + p.bet;
      } else if (dealerBusted || pv > dealerVal) {
        earnings = p.bet * 2; text = '🏆 Gana +' + p.bet;
      } else if (pv < dealerVal) {
        text = '😢 Pierde ' + p.bet;
      } else {
        earnings = p.bet; text = '🤝 Empate';
      }
      p.chips += earnings;
      p.result = text;
      parts.push(p.name + ': ' + text);
    });

    this.message(parts.join('  ·  '));
    this.phase = 'finished';
    this.renderAll();
    this.setControls('replay');
  },

  nextRound() {
    this.phase = 'betting';
    this.current = 0;
    this.dealerHand = [];
    this.players.forEach(p => {
      p.bet = 0; p.hand = []; p.result = ''; p.played = false; p.busted = false; p.doubled = false;
    });
    this.setControls('bet-zone');
    this.renderAll();
    this.updateTurnLabels();
    this.message('');
  },
  cardHTML(card, faceDown = false) {
    if (faceDown) return '<div class="playing-card face-down"><span class="suit">♠</span></div>';
    const red = card.suit === '♥' || card.suit === '♦';
    return `<div class="playing-card${red ? ' red' : ''}">
      <div>${card.rank}</div>
      <div class="suit">${card.suit}</div>
    </div>`;
  },

  renderAll() {
    this.renderDealer();
    this.renderSeats();
  },

  renderDealer() {
    const hide = this.phase === 'playing';
    if (this._prevDealer === undefined) this._prevDealer = 0;
    if (this.dealerHand.length < this._prevDealer) this._prevDealer = 0;
    const html = this.dealerHand.map((c, i) => {
      let h = this.cardHTML(c, hide && i === 1);
      if (i >= this._prevDealer) {
        h = h.replace('class="playing-card', 'class="playing-card fly-in" style="animation-delay:' + (1 + i * 0.3).toFixed(2) + 's"');
      }
      return h;
    }).join('');
    this._prevDealer = this.dealerHand.length;
    document.getElementById('bj-dealer-hand').innerHTML = html;
    document.getElementById('bj-dealer-score').textContent =
      this.dealerHand.length === 0 ? '' : (hide ? '?' : String(this.handValue(this.dealerHand)));
  },

  renderSeats() {
    const wrap = document.getElementById('bj-seats');
    const n = Math.max(this.players.length, this.phase === 'setup' ? this.MAX_SEATS : this.players.length);
    if (!this._prevCounts) this._prevCounts = {};
    let html = '';
    this.players.forEach((p, i) => {
      if (p.hand.length < (this._prevCounts[i] || 0)) this._prevCounts[i] = 0;
      const before = this._prevCounts[i] || 0;
      const off = Math.abs(i - (n - 1) / 2);
      const ty = Math.round(off * off * 9);
      const rot = ((i - (n - 1) / 2) * 3).toFixed(1);
      const isActive = (this.phase === 'betting' || this.phase === 'playing') && i === this.current;
      const showRemove = this.phase === 'setup' && this.players.length > 1;
      const cards = p.hand.length
        ? p.hand.map((c, idx) => {
            let h = this.cardHTML(c);
            if (idx >= before && this.phase !== 'setup') {
              const delay = ((this.players.length - 1 - i) * 0.22 + idx * 0.28).toFixed(2);
              h = h.replace('class="playing-card', 'class="playing-card fly-in" style="animation-delay:' + delay + 's"');
            }
            return h;
          }).join('')
        : '<span class="no-cards">—</span>';
      this._prevCounts[i] = p.hand.length;
      html += `<div class="seat${isActive ? ' active' : ''}" style="transform:translateY(${ty}px) rotate(${rot}deg)">` +
        (showRemove ? `<button class="seat-x" title="Quitar" onclick="Blackjack.removePlayer(${i})">✕</button>` : '') +
        `<div class="p-name">${p.name}</div>` +
        `<div class="p-chips">💰 ${p.chips}</div>` +
        `<div class="cards seat-cards">${cards}</div>` +
        (p.hand.length ? `<div class="score">${this.handValue(p.hand)}</div>` : '') +
        `<div class="bet-circle">${p.bet > 0 ? p.bet : ''}</div>` +
        `<div class="p-result">${p.result}</div>` +
      `</div>`;
    });
    if (this.phase === 'setup' && this.players.length < this.MAX_SEATS) {
      html += '<div class="seat free-seat" onclick="Blackjack.addPlayerFromInput()">' +
        '<div class="plus">➕</div><div>Asiento libre</div></div>';
    }
    wrap.innerHTML = html;
    // Botón de doblar solo con 2 cartas y saldo
    const dbl = document.getElementById('bj-double-btn');
    const p = this.players[this.current];
    dbl.disabled = !(this.phase === 'playing' && p && p.hand.length === 2 && p.chips >= p.bet);
  }
};

// Render inicial de los asientos al cargar la página
Blackjack.renderSeats();
