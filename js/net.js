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
  rlChip: 5,
  slotChip: 5,
  chatIds: new Set(),
  chatVisible: false,
  chatPrimed: false,
  chatUnread: false,

  // ---------- Sesión ----------
  init() {
    if (document.addEventListener) {
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && this.chatVisible) this.closeChat();
      });
    }
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
    // Salas abiertas: primera carga + refresco automático en el lobby
    this.loadOpenRooms();
    setInterval(() => {
      const lobby = document.getElementById('screen-lobby');
      const admin = document.getElementById('screen-admin');
      if ((lobby && !lobby.classList.contains('hidden')) || (admin && !admin.classList.contains('hidden'))) this.loadOpenRooms();
    }, 8000);
  },

  loadSession() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || 'null'); }
    catch (e) { return null; }
  },

  saveSession() {
    localStorage.setItem(this.KEY, JSON.stringify({ code: this.code, playerId: this.playerId }));
  },

  openCreate(game = 'blackjack') {
    App.show('lobby');
    App.openLobbySection('games');
    document.getElementById('net-create-options').classList.remove('hidden');
    document.getElementById('net-game').value = game;
    this.gameChanged();
    document.getElementById('net-game').focus();
  },
  gameChanged() {
    document.getElementById('net-poker-options').classList.toggle('hidden', document.getElementById('net-game').value !== 'poker');
  },

  // Abre una mesa online automáticamente con un clic (tarjetas del lobby)
  async quickStart(game) {
    const nameInput = document.getElementById('net-name');
    const name = nameInput ? nameInput.value.trim() || 'Jugador' : 'Jugador';
    const prevGame = document.getElementById('net-game').value;
    document.getElementById('net-game').value = game;
    try {
      const r = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, game, blindMinutes: 10, chips: App.chips, token: (typeof Auth !== 'undefined' && Auth.token) || '' }),
      });
      const data = await r.json();
      if (!r.ok) return this.showError(data.error || 'No se pudo crear la mesa online.');
      this.code = data.code;
      this.playerId = data.playerId;
      this.version = 0;
      this.saveSession();
      document.getElementById('net-resume').classList.add('hidden');
      this.enterRoom();
    } catch (e) {
      document.getElementById('net-game').value = prevGame;
      this.showError('No se pudo conectar con el servidor. ¿Está arrancado (node server.js)?');
    }
  },

  // ---------- Salas abiertas (lobby) ----------
  async loadOpenRooms(manual) {
    const status = document.getElementById('open-rooms-status');
    const listEl = document.getElementById('open-rooms-list');
    if (!status || !listEl) return;
    try {
      const r = await fetch('/api/rooms');
      const data = await r.json();
      const rooms = (data.rooms || []).filter(x => x && x.code);
      if (!rooms.length) {
        status.textContent = 'No hay salas abiertas ahora mismo. ¡Abre una y comparte el código!';
        listEl.innerHTML = '';
        return;
      }
      status.textContent = rooms.length + (rooms.length === 1 ? ' sala abierta:' : ' salas abiertas:');
      const ICON = { blackjack: '🃏', roulette: '🎡', poker: '♠️', 'book-of-fran': '📖' };
      const NAME = { blackjack: 'Blackjack', roulette: 'Ruleta', poker: 'Póker', 'book-of-fran': 'Book of Fran' };
      listEl.innerHTML = rooms.map(x => {
        const inside = x.code === this.code;
        return '<div class="open-room-row">' +
          '<span class="open-room-icon">' + (ICON[x.game] || '🎲') + '</span>' +
          '<span class="open-room-code">' + x.code + '</span>' +
          '<span class="open-room-info">' + (NAME[x.game] || x.game) +
            ' · ' + x.players + (x.players === 1 ? ' jugador' : ' jugadores') + '</span>' +
          '<button class="btn' + (inside ? '' : ' primary') + '"' + (inside ? ' disabled' : '') +
            ' onclick="Net.joinCode(\'' + x.code + '\')">' + (inside ? '✔ Dentro' : 'Unirse') + '</button>' +
        '</div>';
      }).join('');
    } catch (e) {
      if (manual) status.textContent = '⚠️ No se pudo conectar con el servidor. ¿Está arrancado (node server.js)?';
    }
  },

  async joinCode(code) {
    const name = document.getElementById('net-name').value.trim() || 'Jugador';
    try {
      const r = await fetch('/api/rooms/' + code + '/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, chips: App.chips, token: (typeof Auth !== 'undefined' && Auth.token) || '' }),
      });
      const data = await r.json();
      if (!r.ok) return this.showError(data.error || 'No se pudo unir.');
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

  async createRoom() {
    const name = document.getElementById('net-name').value.trim() || 'Jugador';
    try {
      const r = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, game: document.getElementById('net-game').value,
          blindMinutes: Number(document.getElementById('net-blind-minutes').value), chips: App.chips,
          token: (typeof Auth !== 'undefined' && Auth.token) || '' }),
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
        body: JSON.stringify({ name, chips: App.chips, token: (typeof Auth !== 'undefined' && Auth.token) || '' }),
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
    this.state = null;
    this._prevCounts = {}; this._prevDealer = 0;
    this.clearChat();
    if (typeof Poker !== 'undefined') Poker.reset();
    document.body.classList.toggle('in-poker-room', false);
    document.body.classList.toggle('in-blackjack-room', false);
    document.getElementById('net-poker').classList.add('hidden');
    document.getElementById('net-blackjack-table').classList.add('hidden');
    document.getElementById('net-blackjack-controls').classList.add('hidden');
    document.getElementById('net-roulette').classList.add('hidden');
    document.getElementById('net-book-of-fran').classList.add('hidden');
    App.show('room');
    document.getElementById('net-room-code').textContent = this.code;
    this.pollLoop();
  },
  applyRoomChips(chips) {
    if (chips != null && typeof chips === 'number') {
      App.chips = chips;
      App.updateChips();
    }
  },

  async leave() {
    const code = this.code;
    this.code = null; // corta el sondeo al instante: un leave no debe leerse como "expulsado"
    if (code) {
      try {
        const r = await fetch('/api/rooms/' + code + '/leave', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId: this.playerId,
            token: (typeof Auth !== 'undefined' && Auth.token) || '',
          }),
        });
        const data = await r.json();
        // El servidor devuelve el saldo final de la mesa (ganado o perdido):
        // se aplica al móvil y, con sesión, Auth.chipsChanged lo guarda en la cuenta.
        this.applyRoomChips(data && data.chips);
      } catch (e) { /* sin respuesta no tocamos las fichas: salimos igualmente */ }
    }
    this.disconnect();
    App.goLobby();
  },

  disconnect() {
    if (typeof Poker !== 'undefined') Poker.reset();
    document.body.classList.toggle('in-poker-room', false);
    document.body.classList.toggle('in-blackjack-room', false);
    this.code = null;
    this.state = null;
    this.clearChat();
    localStorage.removeItem(this.KEY);
  },

  clearChat() {
    this.chatIds.clear();
    this.chatPrimed = false;
    this.chatUnread = false;
    this.closeChat(false);
    const list = document.getElementById('net-chat-messages');
    const preview = document.getElementById('net-chat-preview');
    if (preview) preview.innerHTML = '';
    while (list && list.firstChild) list.removeChild(list.firstChild);
    const input = document.getElementById('net-chat-input');
    if (input) input.value = '';
    const status = document.getElementById('net-chat-status');
    if (status) status.textContent = '';
  },

  openChat() {
    const panel = document.getElementById('net-chat');
    const toggle = document.getElementById('net-chat-toggle');
    if (!panel) return;
    panel.classList.add('is-open');
    panel.setAttribute('aria-modal', 'true');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    document.body.classList.toggle('chat-open', true);
    this.chatVisible = true;
    this.chatUnread = false;
    const dot = document.getElementById('net-chat-unread');
    if (dot) dot.classList.add('hidden');
    const list = document.getElementById('net-chat-messages');
    if (list) list.scrollTop = list.scrollHeight;
    const input = document.getElementById('net-chat-input');
    if (input && typeof input.focus === 'function') input.focus();
  },

  closeChat(restoreFocus = true) {
    const panel = document.getElementById('net-chat');
    if (panel) {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-modal', 'false');
    }
    const toggle = document.getElementById('net-chat-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    document.body.classList.toggle('chat-open', false);
    this.chatVisible = false;
    this.chatUnread = false;
    const dot = document.getElementById('net-chat-unread');
    if (dot) dot.classList.add('hidden');
    if (restoreFocus && toggle && typeof toggle.focus === 'function') toggle.focus();
  },

  markChatUnread() {
    this.chatUnread = true;
    const dot = document.getElementById('net-chat-unread');
    if (dot) dot.classList.remove('hidden');
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([90, 45, 90]);
    } catch (e) { /* la vibración es opcional */ }
  },

  updateChatPreview() {
    const list = document.getElementById('net-chat-messages');
    const preview = document.getElementById('net-chat-preview');
    if (!list || !preview) return;
    preview.innerHTML = '';
    const rows = [...list.querySelectorAll('.chat-message')].slice(-3);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-preview-message';
      empty.textContent = 'Sin mensajes todavía';
      preview.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'chat-preview-message';
      const name = document.createElement('b');
      name.textContent = (row.querySelector('.chat-name') || {}).textContent || 'Jugador';
      const text = document.createElement('span');
      text.textContent = (row.querySelector('.chat-text') || {}).textContent || '';
      line.appendChild(name);
      line.appendChild(document.createTextNode(': '));
      line.appendChild(text);
      preview.appendChild(line);
    }
  },

  renderChat(messages) {
    const list = document.getElementById('net-chat-messages');
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    let added = 0;
    let unread = false;

    for (const message of messages) {
      if (!message || this.chatIds.has(message.id)) continue;
      const row = document.createElement('article');
      row.className = 'chat-message';
      if (row.dataset) row.dataset.messageId = String(message.id);
      const name = document.createElement('span');
      name.className = 'chat-name';
      name.textContent = String(message.name || 'Jugador');
      const time = document.createElement('time');
      time.className = 'chat-time';
      const date = new Date(message.ts);
      if (Number.isNaN(date.getTime())) {
        time.textContent = '';
      } else {
        time.dateTime = date.toISOString();
        time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      const text = document.createElement('span');
      text.className = 'chat-text';
      text.textContent = String(message.text || '');
      row.appendChild(name);
      row.appendChild(time);
      row.appendChild(text);
      list.appendChild(row);
      this.chatIds.add(message.id);
      if (this.chatPrimed && message.playerId && message.playerId !== this.playerId && !this.chatVisible) unread = true;
      added++;
    }
    this.chatPrimed = true;

    while (list.children.length > 50) {
      const first = list.firstElementChild;
      if (first) {
        if (first.dataset && first.dataset.messageId) this.chatIds.delete(first.dataset.messageId);
        list.removeChild(first);
      } else break;
    }
    if (added) {
      let empty = list.querySelector('.chat-empty');
      if (empty) list.removeChild(empty);
      if (nearBottom) list.scrollTop = list.scrollHeight;
    } else if (!list.children.length) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = 'Todavía no hay mensajes. ¡Saluda a la mesa!';
      list.appendChild(empty);
    }
    this.updateChatPreview();
    if (unread) this.markChatUnread();
  },

  async sendChat(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const input = document.getElementById('net-chat-input');
    const status = document.getElementById('net-chat-status');
    const send = document.getElementById('net-chat-send');
    const text = input ? input.value : '';
    if (!this.code || !text.trim()) return;
    if (status) status.textContent = '';
    if (send) send.disabled = true;
    try {
      const r = await fetch('/api/rooms/' + this.code + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: this.playerId, text }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (status) status.textContent = data.error || 'No se pudo enviar el mensaje.';
        return;
      }
      if (input) input.value = '';
      // El siguiente long-poll trae el historial y lo pinta por su ID.
    } catch (e) {
      if (status) status.textContent = 'No se pudo conectar con el servidor.';
    } finally {
      if (send) send.disabled = false;
      if (input) input.focus();
    }
  },

  showError(text) {
    document.getElementById('net-lobby-message').textContent = '⚠️ ' + text;
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
        if (!this.code) break; // salimos (leave) mientras esperábamos: no procesar
        if (data && data.kicked) { this.kickedOut(data.message); break; }
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
    if (typeof Poker !== 'undefined') Poker.reset();
    document.body.classList.toggle('in-poker-room', false);
    document.body.classList.toggle('in-blackjack-room', false);
    document.getElementById('net-poker').classList.add('hidden');
    document.getElementById('net-roulette').classList.add('hidden');
    document.getElementById('net-book-of-fran').classList.add('hidden');
    document.getElementById('net-blackjack-table').classList.add('hidden');
    document.getElementById('net-blackjack-controls').classList.remove('hidden');
    this.state = null;
    ['lobby', 'bet', 'play', 'finished', 'wait'].forEach(z => this.showZone(z, false));
    this.showZone('lost', true);
    document.getElementById('net-message').textContent =
      '💔 Se ha perdido la sala: el servidor se ha reiniciado o la sala ha expirado. Las fichas online se reinician con él.';
  },

  // Un admin nos ha expulsado de la mesa: volvemos al lobby con el aviso
  kickedOut(message) {
    if (typeof Poker !== 'undefined') Poker.reset();
    this.disconnect();
    App.goLobby();
    const text = '🚪 ' + (message || 'Un admin te ha expulsado de la mesa.');
    const el = document.getElementById('net-lobby-message');
    if (el) {
      el.textContent = text;
      setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 5000);
    }
  },

  retry() {
    this.showZone('lost', false);
    this.version = 0;
    this.pollLoop();
  },

  async action(type, amount, betId) {
    if (!this.code) return;
    try {
      const r = await fetch('/api/rooms/' + this.code + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: this.playerId, type, amount, betId }),
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
    this.renderChat(s.chat || []);
    const notBJ = s.game === 'poker' || s.game === 'roulette' || s.game === 'book-of-fran';
    document.getElementById('net-blackjack-table').classList.toggle('hidden', notBJ);
    document.getElementById('net-blackjack-controls').classList.toggle('hidden', notBJ);
    document.getElementById('net-poker').classList.toggle('hidden', s.game !== 'poker');
    document.getElementById('net-roulette').classList.toggle('hidden', s.game !== 'roulette');
    document.getElementById('net-book-of-fran').classList.toggle('hidden', s.game !== 'book-of-fran');
    document.body.classList.toggle('in-poker-room', s.game === 'poker');
    document.body.classList.toggle('in-blackjack-room', s.game === 'blackjack');
    if (s.game === 'blackjack') {
      document.getElementById('bj-room-code').textContent = s.code || '';
      document.getElementById('net-blackjack-result').textContent = s.phase === 'finished' ? (s.message || '') : '';
    }
    if (s.game === 'poker') {
      document.getElementById('pk-room-code').textContent = s.code || '';
      Poker.render(s); return;
    }
    if (s.game === 'roulette') { this.renderRoulette(s); return; }
    if (s.game === 'book-of-fran') { this.renderBookOfFran(s); return; }

    // Dealer (animación SOLO cuando aparece una carta nueva, no en cada refresco)
    const cardsD = s.dealer.cards || [];
    const totalD = cardsD.length + (s.dealer.hidden ? 1 : 0);
    if (this._prevDealer === undefined) this._prevDealer = 0;
    if (totalD < this._prevDealer) this._prevDealer = 0;
    const beforeD = this._prevDealer;
    const inHand = Math.max(1, s.players.filter(p => p.cardsCount > 0).length);
    const dealBase = inHand * 2 * 0.6; // el dealer reparte al final, tras los jugadores
    let dealerHTML = '';
    let vi = 0;
    for (const c of cardsD) {
      let h = Blackjack.cardHTML(c);
      if (vi >= beforeD) h = this.withFly(h, dealBase + vi * 0.6);
      vi++;
      dealerHTML += h;
    }
    if (s.dealer.hidden) {
      let h = '<div class="playing-card face-down"><span class="suit">♠</span></div>';
      if (vi >= beforeD) h = this.withFly(h, dealBase + vi * 0.6);
      dealerHTML += h;
    }
    this._prevDealer = totalD;
    document.getElementById('net-dealer-hand').innerHTML = dealerHTML;
    document.getElementById('net-dealer-score').textContent =
      s.dealer.value === null ? '' : Blackjack.handLabel(cardsD) + (s.dealer.hidden ? ' + ?' : '');

    // Asientos: animación escalonada siguiendo el orden real de reparto
    const prevCounts = this._prevCounts || (this._prevCounts = {});
    let lastSeat = -1;
    s.players.forEach((p, seat) => { if (p.cardsCount > 0) lastSeat = seat; });
    let html = '';
    s.players.forEach((p, seat) => {
      if (!p.splitHands) {
        Object.keys(prevCounts).filter(k => k.startsWith(p.id + '-split-'))
          .forEach(k => delete prevCounts[k]);
      }
      if (p.cardsCount < (prevCounts[p.id] || 0)) prevCounts[p.id] = 0;
      const before = prevCounts[p.id] || 0;
      const isSelf = p.id === this.playerId;
      const seatDist = Math.max(0, lastSeat - seat); // distancia al asiento que reparte primero
      const cards = (p.cards && p.cards.length)
        ? p.cards.map((c, idx) => {
            let h = Blackjack.cardHTML(c);
            if (idx >= before) {
              const delay = idx >= 2
                ? 0.2 + (idx - 2) * 0.45                       // cartas robadas en tu turno
                : (seatDist * 0.6) + (idx * inHand * 0.6);      // reparto inicial ordenado
              h = this.withFly(h, delay);
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
        (p.splitHands ? Blackjack.splitHTML(p, s.phase === 'playing' && p.isTurn, prevCounts, p.id) :
          `<div class="cards seat-cards">${cards}</div>` +
          (p.value !== null ? `<div class="score">${p.cards && p.cards.length ? Blackjack.handLabel(p.cards) : p.value}</div>` : '') +
          `<div class="bet-circle">${p.bet > 0 ? p.bet : ''}</div>` +
          `<div class="p-result">${p.result}</div>`) +
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
    document.getElementById('net-split-btn').disabled = !(you && you.canSplit);
    document.getElementById('net-hand-label').textContent =
      you && you.splitHands ? `Juegas la mano ${you.activeHand + 1} de ${you.splitHands.length}` : '';
    dbl.disabled = !(s.phase === 'playing' && myTurn && you && you.cardsCount === 2 && you.chips >= you.bet && !you.played);

    document.getElementById('net-message').textContent = s.message || '';
  },

  slotSetChip(value) {
    this.slotChip = Number(value);
    document.querySelectorAll('#net-book-of-fran .chip').forEach(c => c.classList.toggle('chip-selected', Number(c.textContent) === this.slotChip));
  },

  async slotSpin() {
    if (!this.state || this.state.game !== 'book-of-fran') return;
    await this.action('spin', this.slotChip);
  },

  renderBookOfFran(s) {
    const roomCode = document.getElementById('bof-room-code');
    const reels = document.getElementById('bof-reels');
    const lines = document.getElementById('bof-lines');
    const message = document.getElementById('bof-message');
    const mode = document.getElementById('bof-mode');
    const chips = document.getElementById('bof-chips');
    if (!reels || !lines) return;
    if (roomCode) roomCode.textContent = s.code || '';
    const me = s.players.find(p => p.id === this.playerId);
    const result = me && me.lastResult;
    const grid = result && result.grid;
    reels.innerHTML = Array.from({ length: 3 }, (_, reel) =>
      '<div class="bof-reel">' + Array.from({ length: 3 }, (_, row) => {
        const id = grid && grid[reel] && grid[reel][row];
        const symbol = (s.symbols || []).find(x => x.id === id);
        return '<div class="bof-symbol' + (result && result.expandedReels.includes(reel) ? ' expanded' : '') + '">' +
          (symbol ? symbol.glyph : '·') + '</div>';
      }).join('') + '</div>'
    ).join('');
    lines.innerHTML = result && result.lines && result.lines.length
      ? result.lines.map(line => '🟡 ' + (s.symbols.find(x => x.id === line.symbol) || { glyph: line.symbol }).glyph + ' × ' + line.win + ' fichas').join(' · ')
      : '<span class="hint">Tres símbolos iguales en una fila pagan.</span>';
    if (message) message.textContent = s.message || '';
    if (mode) {
      const free = me && me.freeSpins > 0;
      const expanded = me && me.expandedSymbol ? (s.symbols.find(x => x.id === me.expandedSymbol) || { glyph: me.expandedSymbol }).glyph : '';
      mode.textContent = free ? 'GIROS GRATIS: ' + me.freeSpins + (expanded ? ' · expands ' + expanded : '') : 'Modo normal · 3 libros activan la ronda';
    }
    if (chips) chips.textContent = 'Tus fichas: ' + (me ? me.chips : 0);
    const players = document.getElementById('bof-players');
    if (players) players.innerHTML = s.players.map(p => '<div class="seat' + (p.id === this.playerId ? ' active' : '') + '"><div class="p-name">' + p.name + (p.id === this.playerId ? ' ⭐' : '') + '</div><div class="p-chips">💰 ' + p.chips + '</div><div class="p-result">' + (p.freeSpins ? '📖 ' + p.freeSpins : '') + '</div></div>').join('');
    this.slotSetChip(this.slotChip);
  },

  renderRoulette(s) {
    const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
    const res = document.getElementById('net-roulette-result');
    const n = s.lastNumber;
    res.textContent = n != null ? n : '?';
    res.style.color = n == null ? '' : (n === 0 ? '#2ecc71' : (RED.has(n) ? '#e74c3c' : '#ecf0f1'));

    const table = document.getElementById('net-roulette-table');
    if (!table) return;

    const bets = this.playerBets(s);
    const chipTag = (id) => bets[id] ? '<span class="rl-chip">' + bets[id] + '</span>' : '';
    const click = (id) => ' onclick="Net.rlBet(\'' + id + '\')"';

    let html = '<div class="rl-grid">';
    html += '<div class="rl-cell zero-cell" data-bet="n0"' + click('n0') + '>' + chipTag('n0') + '0</div>';
    for (let row = 2; row >= 0; row--) {
      for (let col = 1; col <= 12; col++) {
        const num = col * 3 - row;
        const color = RED.has(num) ? 'red-cell' : 'black-cell';
        const id = 'n' + num;
        html += '<div class="rl-cell ' + color + '" data-bet="' + id + '"' + click(id) + '>' + chipTag(id) + num + '</div>';
      }
    }
    html += '</div>';
    const outside = [
      ['dozen1', '1&#170; 12'], ['dozen2', '2&#170; 12'], ['dozen3', '3&#170; 12'],
      ['low', '1-18'], ['even', 'PAR'], ['red', 'ROJO'],
      ['black', 'NEGRO'], ['odd', 'IMPAR'], ['high', '19-36'],
      ['col1', 'COL 1'], ['col2', 'COL 2'], ['col3', 'COL 3']
    ];
    html += '<div class="rl-outside">';
    for (const [id, label] of outside) {
      const redStyle = id === 'red' ? ' style="background:var(--red)"' : '';
      const blackStyle = id === 'black' ? ' style="background:#1c1c1c"' : '';
      html += '<div class="rl-cell"' + redStyle + blackStyle + click(id) + '>' + chipTag(id) + label + '</div>';
    }
    html += '</div>';
    table.innerHTML = html;

    if (n != null) {
      const winCell = table.querySelector('[data-bet="n' + n + '"]');
      if (winCell) winCell.classList.add('win-highlight');
    }

    const myTotal = Object.values(bets).reduce((a, b) => a + b, 0);
    document.getElementById('net-rl-total').textContent = myTotal;
    const you = s.players.find(p => p.id === this.playerId);
    document.getElementById('net-rl-chips').textContent = you ? you.chips : 0;

    let seats = '';
    for (const p of s.players) {
      seats += '<div class="seat' + (p.id === this.playerId ? ' active' : '') + '">' +
        '<div class="p-name">' + p.name + (p.id === this.playerId ? ' &#11088;' : '') + '</div>' +
        '<div class="p-chips">&#128176; ' + p.chips + '</div>' +
        '<div class="bet-circle">' + (p.bet > 0 ? p.bet : '') + '</div>' +
      '</div>';
    }
    document.getElementById('net-rl-players').innerHTML = seats;
    document.getElementById('net-rl-message').textContent = s.message || '';
  },

  rlBet(betId) {
    const s = this.state;
    if (!s || s.game !== 'roulette') return;
    this.action('bet', this.rlChip, betId);
  },

  rlSetChip(v) {
    this.rlChip = v;
    document.querySelectorAll('#net-roulette .chip').forEach(c => {
      c.classList.toggle('chip-selected', Number(c.textContent) === v);
    });
  },

  playerBets(s) {
    // Extraer las apuestas del jugador actual desde el estado del servidor
    const you = s.players.find(p => p.id === this.playerId);
    if (!you) return {};
    const myBets = s.bets[this.playerId] || {};
    const out = {};
    for (const key of Object.keys(myBets)) {
      out[key] = myBets[key] || 0;
    }
    return out;
  },

  showZone(name, visible) {
    document.getElementById('net-zone-' + name).classList.toggle('hidden', !visible);
  },

  withFly(html, delay) {
    return html.replace('class="playing-card',
      'class="playing-card fly-in" style="animation-delay:' + delay.toFixed(2) + 's"');
  }
};
