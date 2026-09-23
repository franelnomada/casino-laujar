// Mesa de póker: nodos de cartas persistentes y animación desde el mazo real.
const Poker = {
  state: null, nodes: new Map(), animations: new Set(), timer: null, busy: false,
  el(id) { return document.getElementById('pk-' + id); },
  reset() {
    clearInterval(this.timer); this.timer = null;
    for (const a of this.animations) a.cancel();
    this.animations.clear(); this.nodes.clear(); this.state = null; this.key = null;
    this.el('seats').innerHTML = ''; this.el('board').innerHTML = '';
    this.el('private-hand').textContent = '';
    this.el('winning-hands').innerHTML = '';
    this.el('showdown').classList.add('hidden');
  },
  now() { return Date.now() + (this.offset || 0); },
  render(s) {
    const key = s.code + ':' + s.handNo;
    if (key !== this.key) { this.reset(); this.key = key; }
    this.state = s; this.offset = s.serverNow - Date.now();
    this.el('blinds').textContent = `Nivel ${s.level + 1} · SB ${s.smallBlind} / BB ${s.bigBlind}`;
    const seats = this.el('seats');
    const ids = new Set(s.players.map(p => p.id));
    for (const seat of [...seats.children]) if (!ids.has(seat.dataset.player)) seat.remove();
    for (const [i, p] of s.players.entries()) {
      let seat = [...seats.children].find(n => n.dataset.player === p.id);
      if (!seat) {
        seat = document.createElement('div'); seat.dataset.player = p.id;
        seat.innerHTML = '<div class="pk-name"></div><div class="pk-badges"></div><div class="pk-chips"></div><div class="cards pk-hole"></div><div class="pk-bet"></div><div class="pk-result"></div>';
        seats.appendChild(seat);
      }
      seat.className = 'pk-seat pk-seat-' + i + (p.folded ? ' folded' : '') + (p.id === Net.playerId ? ' self' : '');
      seat.querySelector('.pk-name').textContent = p.name + (p.id === Net.playerId ? ' · Tú' : '');
      seat.querySelector('.pk-badges').textContent = [p.id === s.dealerId ? '⚪ D' : '',p.id === s.sbId ? '🔵 SB' : '',p.id === s.bbId ? '🟡 BB' : ''].filter(Boolean).join(' ');
      seat.querySelector('.pk-bet').textContent = p.inHand ? (p.folded ? 'Retirado' : p.allIn ? 'ALL-IN' : 'Apuesta: ' + p.bet) : 'Esperando';
      p.cards.forEach((c, index) => this.card(seat.querySelector('.pk-hole'), 'hole', p.id, index, c));
    }
    s.board.forEach((c, index) => this.card(this.el('board'), 'board', 'board', index, c));
    const amount = this.el('amount');
    const minimum = Math.min(s.minRaiseTo, s.maxRaiseTo);
    amount.min = minimum; amount.max = s.maxRaiseTo;
    if (document.activeElement !== amount) amount.value = minimum;
    this.update();
    if (!this.timer) this.timer = setInterval(() => this.update(), 150);
  },
  card(parent, type, target, index, card) {
    const key = type + ':' + target + ':' + index;
    let node = this.nodes.get(key);
    if (!node) {
      const wrap = document.createElement('div'); wrap.innerHTML = Blackjack.cardHTML(null, true);
      node = wrap.firstElementChild; node.classList.add('pk-card'); parent.appendChild(node);
      node.dataset.arrived = 'false'; this.nodes.set(key, node);
      const e = this.state.events.find(e => e.type === type && e.target === target && e.index === index);
      if (e && e.at + e.duration > this.now()) this.fly(node, e);
      else node.dataset.arrived = 'true';
    }
    node._card = card;
    node._type = type;
  },
  fly(node, event) {
    const source = this.el('shoe').getBoundingClientRect();
    const dest = node.getBoundingClientRect();
    const dx = source.left + source.width / 2 - dest.left - dest.width / 2;
    const dy = source.top + source.height / 2 - dest.top - dest.height / 2;
    if (!node.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node._arrival = event.at + event.duration; return;
    }
    const a = node.animate([
      {transform:`translate(${dx}px, ${dy}px) rotate(-24deg) scale(.72)`,opacity:0,offset:0},
      {transform:`translate(${dx}px, ${dy}px) rotate(-24deg) scale(.72)`,opacity:1,offset:.12},
      {transform:`translate(${dx*.48}px, ${dy*.48-28}px) rotate(12deg) scale(.95)`,opacity:1,offset:.56},
      {transform:'translate(0, 3px) rotate(-2deg)',opacity:1,offset:.91},
      {transform:'none',opacity:1,offset:1}
    ], {duration:event.duration,delay:event.at-this.now(),fill:'both',easing:'ease-in-out'});
    this.animations.add(a);
    a.onfinish = () => { node.dataset.arrived = 'true'; a.cancel(); this.animations.delete(a); this.update(); };
    a.oncancel = () => this.animations.delete(a);
  },
  reveal(node) {
    if (!node._card || node.dataset.face === 'up') return;
    const wrap = document.createElement('div'); wrap.innerHTML = Blackjack.cardHTML(node._card);
    const face = wrap.firstElementChild;
    node.innerHTML = face.innerHTML; node.classList.remove('face-down');
    node.classList.toggle('red', face.classList.contains('red')); node.dataset.face = 'up';
    if (node.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const a = node.animate([{transform:'rotateY(90deg)'},{transform:'rotateY(0)'}],{duration:180});
      this.animations.add(a); a.onfinish = () => this.animations.delete(a);
    }
  },
  showResult(s, resultsReady) {
    const panel = this.el('showdown');
    const mainPot = s.pots.find(pot => !pot.refund) || s.pots[0];
    const winners = mainPot ? mainPot.winners.map(id => s.players.find(p => p.id === id)).filter(Boolean) : [];
    panel.classList.toggle('hidden', !resultsReady || !winners.length);
    if (!resultsReady || !winners.length) {
      this.el('winning-hands').innerHTML = '';
      return;
    }
    const names = winners.map(p => p.name).join(' y ');
    this.el('winner-title').textContent = s.showdown ?
      winners.map(p => `${p.name} gana con ${p.handName}`).join(' · ') :
      `${names} ${winners.length > 1 ? 'ganan' : 'gana'} la mano`;
    const signatures = new Set(winners.map(p => (p.bestHand || []).map(c => c.rank + c.suit).join(',')));
    const sharedHand = signatures.size === 1;
    this.el('winning-detail').textContent = s.showdown ?
      (sharedHand ? 'Estas son las cinco cartas de la combinación ganadora:' : 'Combinación principal de la mano:') : 'La partida terminó antes del showdown.';
    this.el('winning-hands').innerHTML = (winners[0].bestHand || []).map(card => Blackjack.cardHTML(card)).join('');
  },

  update() {
    const s = this.state; if (!s) return;
    const now = this.now(); const dealing = now < s.visualUntil;
    const show = s.events.find(e => e.type === 'showdown');
    const resultsReady = s.phase === 'finished' && (!show || now >= show.at);
    const winnerIds = new Set(s.pots.flatMap(pot => pot.winners));
    for (const node of this.nodes.values()) {
      if (node._arrival && now >= node._arrival) node.dataset.arrived = 'true';
      node.style.visibility = node._arrival && now < node._arrival ? 'hidden' : '';
      if (node.dataset.arrived === 'true' && (node._type === 'board' || node.parentElement.parentElement.dataset.player === Net.playerId || resultsReady)) this.reveal(node);
    }
    this.el('pot').textContent = (resultsReady ? 'Bote repartido: ' : 'Bote: ') + s.pot;
    const visibleBoard = [...this.nodes.entries()].filter(([k,n]) => k.startsWith('board:') && n.dataset.arrived === 'true').length;
    const street = visibleBoard === 5 ? 'River' : visibleBoard === 4 ? 'Turn' : visibleBoard === 3 ? 'Flop' : 'Preflop';
    this.el('phase').textContent = s.handNo ? 'Mano ' + s.handNo + ' · ' + (resultsReady ? 'Showdown' : street) : 'Esperando jugadores';
    const privateHand = s.privateHand;
    const ownCardsReady = [0, 1].every(index => {
      const node = this.nodes.get('hole:' + Net.playerId + ':' + index);
      return node && node.dataset.arrived === 'true';
    });
    const label = privateHand && privateHand.playerId === Net.playerId && ownCardsReady ?
      privateHand.labels[visibleBoard] : '';
    this.el('private-hand').textContent = label ? 'Tu mano: ' + label + ' · Solo tú' : '';
    const turn = s.players.find(p => p.id === s.turnId);
    const mine = s.turnId === Net.playerId;
    const canAct = mine && !dealing && !this.busy && !!turn;
    this.showResult(s, resultsReady);
    for (const seat of this.el('seats').children) {
      const p = s.players.find(p => p.id === seat.dataset.player);
      seat.classList.toggle('active', !dealing && p.id === s.turnId);
      seat.classList.toggle('winner', resultsReady && winnerIds.has(p.id));
      const awarded = s.pots.filter(pot => pot.winners.includes(p.id)).reduce((sum,pot) => {
        const i = pot.winners.indexOf(p.id);
        return sum + Math.floor(pot.amount / pot.winners.length) + (i < pot.amount % pot.winners.length ? 1 : 0);
      },0);
      seat.querySelector('.pk-chips').textContent = '💰 ' + (s.phase === 'finished' && !resultsReady ? p.chips - awarded : p.chips);
      seat.querySelector('.pk-result').textContent = resultsReady ? [p.result,p.handName].filter(Boolean).join(' · ') : '';
    }
    const enoughPlayers = s.players.filter(p => !p.left && p.chips > 0).length >= 2;
    this.el('status').textContent = dealing ? 'Repartiendo, espera a que lleguen las cartas…' : turn ?
      (mine ? 'Tu turno' : 'Turno de ' + turn.name) + ' · ' + Math.max(0,Math.ceil((s.turnDeadline-now)/1000)) + ' s' :
      !enoughPlayers ? 'Se necesitan dos jugadores con fichas. Puedes crear otra mesa para volver a empezar.' :
      s.phase === 'finished' ? `Mano terminada · siguiente en ${Math.max(0,Math.ceil((s.nextHandAt-now)/1000))} s` :
      'El anfitrión puede repartir la mano inicial.';
    this.el('clock').textContent = s.nextBlindAt ? (s.nextBlindAt <= now ? 'Subida pendiente para la siguiente mano' : 'Subida en ' + Math.ceil((s.nextBlindAt-now)/60000) + ' min') : 'Ciegas cada ' + s.blindMinutes + ' min';
    const start = this.el('start');
    start.classList.toggle('hidden', s.phase !== 'lobby' || s.hostId !== Net.playerId);
    start.textContent = 'Repartir primera mano';
    start.disabled = dealing || this.busy || !enoughPlayers;
    this.el('actions').classList.toggle('hidden', !mine);
    for (const id of ['fold','call','raise','allin','amount']) this.el(id).disabled = !canAct;
    this.el('raise').disabled = !canAct || !s.canRaise;
    this.el('amount').disabled = !canAct || !s.canRaise;
    this.el('allin').disabled = !canAct || (!s.canRaise && s.maxRaiseTo > s.currentBet);
    this.el('call').textContent = s.toCall ? 'Igualar ' + s.toCall : 'Pasar';
    this.el('results').textContent = resultsReady ? s.message : '';
  },
  async act(type, amount) {
    if (this.busy) return;
    this.busy = true; this.update();
    try { await Net.action(type,amount); } finally { this.busy = false; this.update(); }
  },
  call() { return this.act(this.state.toCall ? 'call' : 'check'); },
  raise() { return this.act('raise',Number(this.el('amount').value)); }
};
