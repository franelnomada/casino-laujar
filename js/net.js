// ================================================
//  Cliente multijugador (salas online, long-polling)
// ================================================
const Net = {
  KEY: 'casino-night-net-session',
  code: null,
  playerId: null,
  version: 0,
  state: null,
  polling: false,

  // ---------- Sesión ----------
  init() {
    const saved = this.loadSession();
    if (saved) {
      const btn = document.getElementById('net-resume');
      btn.textContent = '↩ Volver a ' + saved.code;
      btn.classList.remove('hidden');
    }
    // Enlace de invitación: ?room=CODIGO precarga el código
    const roomParam = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(roomParam)) {
      document.getElementById('net-code').value = roomParam;
      const box = document.querySelector('.net-box');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },

  loadSession() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || 'null'); }
    catch (e) { return null; }
  },

  saveSession() {
    localStorage.setItem(this.KEY, JSON.stringify({ code: this.code, playerId: this.playerId }));
  },

  async createRoom() {
    const name = document.getElementById('net-name').value.trim() || 'Jugador';
    try {
      const r = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      if (!r.ok) return this.showError(data.error || 'No se pudo crear la sala.');
      this.code = data.code;
      this.playerId = data.playerId;
      this.version = 0;
      this.saveSession();
      document.getElementById('net-resume').classList.add('hidden');
      this.enterRoom();
    } catch (e) {
      this.showError('No se pudo conectar con el servidor. ¿Está arrancado (node server.js)?');
    }
  },

  async joinRoom() {
    const code = document.getElementById('net-code').value.trim().toUpperCase();
    const name = document.getElementById('net-name').value.trim() || 'Jugador';
    if (code.length !== 4) return this.showError('Escribe el código de 4 letras.');
    try {
      const r = await fetch('/api/rooms/' + code + '/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      if (!r.ok) return this.showError(data.error || 'No se pudo unir.');
      this.code = data.code;
      this.playerId = data.playerId;
      this.version = 0;
      this.saveSession();
      this.enterRoom();
    } catch (e) {
      this.showError('No se pudo conectar con el servidor. ¿Está arrancado (node server.js)?');
    }
  },

  resume() {
    const saved = this.loadSession();
    if (!saved) return;
    this.code = saved.code;
    this.playerId = saved.playerId;
    this.version = 0;
    this.enterRoom();
  },

  enterRoom() {
    App.show('room');
    document.getElementById('net-room-code').textContent = this.code;
    this.pollLoop();
  },

  async leave() {
    if (this.code) {
      try {
        await fetch('/api/rooms/' + this.code + '/leave', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: this.playerId }),
        });
      } catch (e) { /* da igual, salimos igualmente */ }
    }
    this.disconnect();
    App.goLobby();
  },

  disconnect() {
    this.code = null;
    this.state = null;
    localStorage.removeItem(this.KEY);
  },

  showError(text) {
    document.getElementById('net-message').textContent = '⚠️ ' + text;
    setTimeout(() => {
      const el = document.getElementById('net-message');
      if (el.textContent === '⚠️ ' + text) el.textContent = '';
    }, 4000);
  },

  showInfo(text) {
    document.getElementById('net-message').textContent = text;
    setTimeout(() => {
      const el = document.getElementById('net-message');
      if (el.textContent === text) el.textContent = '';
    }, 4000);
  },

  copyLink() {
    if (!this.code) return;
    const link = location.origin + '/?room=' + this.code;
    const done = () => this.showInfo('🔗 Enlace copiado: ' + link);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done).catch(() => this.showInfo(link));
    } else {
      this.showInfo(link);
    }
  },

  // ---------- Sincronización ----------
  async pollLoop() {
    if (this.polling) return;
    this.polling = true;
    let notFound = 0;
    while (this.code) {
      try {
        const r = await fetch('/api/rooms/' + this.code +
          '/state?player=' + encodeURIComponent(this.playerId) + '&v=' + this.version);
        if (r.status === 404) {
          // Puede ser un reinicio puntual del servidor: reintentar antes de rendirse
          notFound++;
          if (notFound >= 3) {
            this.roomLost();
            break;
          }
          await new Promise(res => setTimeout(res, 1500));
          continue;
        }
        notFound = 0;
        const data = await r.json();
        this.version = data.version;
        this.state = data;
        this.render();
      } catch (e) {
        await new Promise(res => setTimeout(res, 1000)); // red caída: reintenta
      }
    }
    this.polling = false;
  },

  roomLost() {
    this.state = null;
    ['lobby', 'bet', 'play', 'finished', 'wait'].forEach(z => this.showZone(z, false));
    this.showZone('lost', true);
    document.getElementById('net-message').textContent =
      '💔 Se ha perdido la sala: el servidor se ha reiniciado o la sala ha expirado. Las fichas online se reinician con él.';
  },

  retry() {
    this.showZone('lost', false);
    this.version = 0;
    this.pollLoop();
  },

  async action(type, amount) {
    if (!this.code) return;
    try {
      const r = await fetch('/api/rooms/' + this.code + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: this.playerId, type, amount }),
      });
      const data = await r.json();
      if (!r.ok) { this.showError(data.error || 'Acción rechazada.'); return; }
      this.version = data.version;
      this.state = data;
      this.render();
    } catch (e) {
      this.showError('Sin conexión con el servidor.');
    }
  },

  // ---------- Render ----------
  render() {
    const s = this.state;
    if (!s) return;

    // Dealer (con animación de salida del zapato)
    if (this._prevDealer === undefined) this._prevDealer = 0;
    if ((s.dealer.cards || []).length < this._prevDealer) this._prevDealer = 0;
    let dealerHTML = (s.dealer.cards || []).map((c, i) => {
      let h = Blackjack.cardHTML(c);
      if (i >= this._prevDealer) {
        h = h.replace('class="playing-card', 'class="playing-card fly-in" style="animation-delay:' + (1 + i * 0.3).toFixed(2) + 's"');
      }
      return h;
    }).join('');
    if (s.dealer.hidden) {
      dealerHTML += '<div class="playing-card face-down fly-in" style="animation-delay:1.6s"><span class="suit">♠</span></div>';
    }
    this._prevDealer = (s.dealer.cards || []).length + (s.dealer.hidden ? 1 : 0);
    document.getElementById('net-dealer-hand').innerHTML = dealerHTML;
    document.getElementById('net-dealer-score').textContent =
      s.dealer.value === null ? '' : String(s.dealer.value);

    // Asientos (con animación escalonada según el orden de reparto)
    const prevCounts = this._prevCounts || (this._prevCounts = {});
    let html = '';
    s.players.forEach((p, seat) => {
      if (p.cardsCount < (prevCounts[p.id] || 0)) prevCounts[p.id] = 0;
      const before = prevCounts[p.id] || 0;
      const isSelf = p.id === this.playerId;
      const cards = (p.cards && p.cards.length)
        ? p.cards.map((c, idx) => {
            let h = Blackjack.cardHTML(c);
            if (idx >= before) {
              const delay = ((s.players.length - 1 - seat) * 0.22 + idx * 0.28).toFixed(2);
              h = h.replace('class="playing-card', 'class="playing-card fly-in" style="animation-delay:' + delay + 's"');
            }
            return h;
          }).join('')
        : (p.cardsCount > 0
          ? Array(p.cardsCount).fill('<div class="playing-card face-down"><span class="suit">♠</span></div>').join('')
          : '<span class="no-cards">—</span>');
      prevCounts[p.id] = p.cardsCount;
      const status = isSelf ? ' ⭐' : '';
      html += '<div class="seat' + (p.isTurn ? ' active' : '') + '">' +
        `<div class="p-name">${p.name}${status}${p.isTurn ? ' 🎯' : ''}</div>` +
        `<div class="p-chips">💰 ${p.chips}${p.confirmed && s.phase === 'betting' ? ' ✔' : ''}</div>` +
        `<div class="cards seat-cards">${cards}</div>` +
        (p.value !== null ? `<div class="score">${p.value}</div>` : '') +
        `<div class="bet-circle">${p.bet > 0 ? p.bet : ''}</div>` +
        `<div class="p-result">${p.result}</div>` +
      '</div>';
    });
    document.getElementById('net-seats').innerHTML = html;

    // Zonas de control según fase y turno
    const you = s.players.find(p => p.id === this.playerId);
    const myTurn = s.turnId === this.playerId;
    this.showZone('lost', false);
    this.showZone('lobby', s.phase === 'lobby');
    this.showZone('bet', s.phase === 'betting' && you && !you.confirmed);
    this.showZone('play', s.phase === 'playing' && myTurn && you && you.bet > 0 && !you.played);
    this.showZone('finished', s.phase === 'finished');
    const waiting = (s.phase === 'betting' && you && you.confirmed) ||
                    (s.phase === 'playing' && !myTurn);
    this.showZone('wait', waiting);

    if (s.phase === 'betting') {
      document.getElementById('net-bet').textContent = you ? you.bet : 0;
      const confirmedCount = s.players.filter(p => p.confirmed).length;
      document.getElementById('net-wait-text').textContent =
        `✔ Apuesta confirmada. Esperando al resto (${confirmedCount}/${s.players.length})…`;
    } else if (waiting) {
      const turnP = s.players.find(p => p.id === s.turnId);
      document.getElementById('net-wait-text').textContent =
        turnP ? '⏳ Turno de ' + turnP.name + '…' : '⏳ Repartiendo…';
    }

    const dbl = document.getElementById('net-double-btn');
    dbl.disabled = !(you && you.cardsCount === 2 && you.chips >= you.bet && !you.played);

    document.getElementById('net-message').textContent = s.message || '';
  },

  showZone(name, visible) {
    document.getElementById('net-zone-' + name).classList.toggle('hidden', !visible);
  }
};
