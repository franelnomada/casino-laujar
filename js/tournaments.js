// ============================================================
//  Cliente de torneos: lista del lobby, solicitud de plaza y
//  mesa de juego (estado + acciones de póker).
//
//  La mesa reutiliza la misma respuesta que las salas normales
//  (/api/tournaments/:id/state), así que la sincronización es
//  un long-polling como el resto del casino.
// ============================================================

// WhatsApp que atiende las dudas de inscripción (formato internacional,
// solo dígitos: el prefijo de España es 34). Se cambia aquí si cambia el número.
const TOURNAMENT_WHATSAPP = '34684753093';

const Tournaments = {
  list: [],
  timer: null,
  table: null,      // { id, playerId, name }
  state: null,
  version: 0,
  offset: 0,
  polling: false,
  generation: 0,
  busy: false,
  nodes: new Map(),
  cardTimer: null,
  slideTimer: null,

  el(id) { return document.getElementById('trn-' + id); },

  init() {
    if (typeof TournamentsAdmin !== 'undefined') TournamentsAdmin.init();
    this.refresh();
    this.timer = setInterval(() => {
      const lobby = document.getElementById('screen-lobby');
      const admin = document.getElementById('screen-admin');
      if ((lobby && !lobby.classList.contains('hidden')) || (admin && !admin.classList.contains('hidden'))) this.refresh();
    }, 5000);
  },

  sessionChanged() { this.refresh(); },

  async api(path, body) {
    const headers = {};
    if (typeof Auth !== 'undefined' && Auth.token) headers.Authorization = 'Bearer ' + Auth.token;
    const options = { headers };
    if (body !== undefined) {
      options.method = 'POST';
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    let data = {};
    try { data = await response.json(); } catch (e) { /* respuesta vacía */ }
    return { status: response.status, data };
  },

  node(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  },

  // ---------- Lista del lobby ----------
  async refresh(manual) {
    const status = document.getElementById('tournament-status');
    if (manual && status) status.textContent = 'Actualizando torneos…';
    try {
      const response = await this.api('/api/tournaments');
      if (response.status !== 200) throw new Error(response.data.error || 'No se pudieron cargar.');
      this.list = response.data.tournaments || [];
      this.renderList();
      if (status) {
        const open = this.list.filter(t => t.status !== 'finalizado').length;
        status.textContent = this.list.length
          ? this.list.length + (this.list.length === 1 ? ' torneo. ' : ' torneos. ') + open + ' en marcha.'
          : 'Ahora mismo no hay torneos abiertos.';
      }
    } catch (e) {
      if (status) status.textContent = '⚠️ ' + e.message;
    }
  },

  renderList() {
    const box = document.getElementById('tournament-list');
    if (!box) return;
    box.innerHTML = '';
    if (!this.list.length) {
      box.appendChild(this.node('p', 'hint', 'Todavía no hay torneos creados. El admin los publica desde su panel.'));
      return;
    }
    for (const t of this.list) box.appendChild(this.renderCard(t));
  },

  renderCard(t) {
    const card = this.node('article', 'tournament-card trn-status-' + t.status);

    const head = this.node('header', 'tournament-card-head');
    head.appendChild(this.node('strong', '', t.name));
    head.appendChild(this.node('span', 'trn-badge trn-badge-' + t.status,
      t.status === 'registro' ? 'REGISTRO' : t.status === 'en_curso' ? 'EN JUEGO' : 'FINALIZADO'));
    card.appendChild(head);

    if (t.description) card.appendChild(this.node('p', 'hint', t.description));

    // Reglas: cuota, reparto y ciegas, como las de un cartel de torneo real.
    const facts = this.node('dl', 'tournament-facts');
    const add = (label, value) => {
      facts.appendChild(this.node('dt', '', label));
      facts.appendChild(this.node('dd', '', value));
    };
    add('Cuota', t.buyIn + ' fichas');
    add('Reparto', t.startChips.toLocaleString('es-ES') + ' fichas');
    add('Ciegas', t.smallBlind + '/' + t.bigBlind + (t.ante ? ' ante ' + t.ante : '') +
      ' · suben cada ' + t.levelMinutes + ' min');
    add('Plazas', t.seated + '/' + t.maxPlayers + (t.minPlayers > 2 ? ' (mín. ' + t.minPlayers + ')' : ''));
    if ((t.maxTables || 1) > 1) {
      const mesas = (t.tables || []).map(x => 'M' + x.number + ':' + x.seated).join(' · ');
      add('Mesas', t.tableCount + '/' + t.maxTables + ' abiertas' + (mesas ? ' (' + mesas + ')' : ''));
      if (t.moveEveryLevels > 0) {
        add('Cambios', 'se reparten jugadores cada ' + t.moveEveryLevels + ' niveles');
      }
    }
    if (t.live && t.status === 'en_curso') {
      add('En juego', t.live.remaining + ' jugadores · nivel ' + t.live.level + '/' + t.maxLevels +
        ' · bote ' + Number(t.live.prizePool || 0).toLocaleString('es-ES'));
    }
    if (t.breakEvery > 0) add('Descansos', 'cada ' + t.breakEvery + ' niveles, ' + t.breakMinutes + ' min');
    if (t.lateRegistration && t.lateLevels > 0) add('Registro tardío', 'hasta el nivel ' + t.lateLevels);
    if (t.startMode === 'programado' && t.startsAt) {
      const left = t.scheduledIn == null ? null : TournamentsAdmin.countdown(t.scheduledIn);
      add('Empieza', t.status === 'registro' && left
        ? TournamentsAdmin.formatStartsAt(t.startsAt) + ' (' + left + ')'
        : TournamentsAdmin.formatStartsAt(t.startsAt));
    }
    card.appendChild(facts);

    if ((t.prizes || []).length) {
      const prizes = this.node('ul', 'tournament-prizes');
      for (const prize of t.prizes) {
        prizes.appendChild(this.node('li', '',
          (prize.label || (prize.position + 'º puesto')) + ': ' +
          (prize.format === 'fichas' ? prize.value + ' fichas' : prize.value + ' % del bote')));
      }
      card.appendChild(prizes);
    }

    if (t.status === 'finalizado' && (t.results || []).length) {
      const results = this.node('ol', 'tournament-results');
      for (const row of t.results) {
        results.appendChild(this.node('li', '',
          row.name + (row.prize ? ' · +' + row.prize.toLocaleString('es-ES') + ' fichas' : ' · sin premio')));
      }
      card.appendChild(this.node('h3', '', 'Resultado final')).appendChild(results);
    }

    card.appendChild(this.renderAction(t));
    return card;
  },

  // Botón según la situación del jugador: pedir plaza, esperar o jugar.
  renderAction(t) {
    const row = this.node('div', 'tournament-actions');
    const mine = t.myRequest;
    if (t.status === 'finalizado') {
      row.appendChild(this.node('p', 'hint', 'Este torneo ya ha terminado.'));
      return row;
    }
    if (mine && mine.status === 'aceptada') {
      const button = this.node('button', 'btn primary', t.status === 'en_curso' ? '🎮 Jugar ahora' : '👁 Ver la mesa');
      button.type = 'button';
      button.onclick = () => this.openTable(t);
      row.appendChild(button);
      if (t.status === 'registro') {
        const when = t.startMode === 'programado' && t.startsAt
          ? 'Empieza solo el ' + TournamentsAdmin.formatStartsAt(t.startsAt) + '.'
          : 'La mesa arranca sola en cuanto se llegue al mínimo de jugadores.';
        row.appendChild(this.node('p', 'hint', 'Tu plaza está confirmada. ' + when));
      }
      if (t.waitingForPlayers) {
        row.appendChild(this.node('p', 'hint', 'El torneo ya ha empezado a su hora. Se repartirá en cuanto se siente un segundo jugador.'));
      }
      return row;
    }
    if (mine && mine.status === 'pendiente') {
      row.appendChild(this.node('p', 'hint', '⏳ Solicitud enviada. El admin tiene que aceptar tu participación.'));
      const cancel = this.node('button', 'btn', 'Cancelar solicitud');
      cancel.type = 'button';
      cancel.onclick = () => this.cancel(t.id);
      row.appendChild(cancel);
      return row;
    }
    if (mine && mine.status === 'rechazada') {
      row.appendChild(this.node('p', 'hint', 'El admin no ha aceptado tu participación en este torneo.'));
    }
    const logged = typeof Auth !== 'undefined' && Auth.token;
    const button = this.node('button', 'btn primary', logged ? 'Pedir plaza' : 'Entra para apuntarte');
    button.type = 'button';
    button.disabled = !t.canRegister;
    button.onclick = () => (logged ? this.request(t.id) : Auth.openPanel());
    row.appendChild(button);
    // Debajo del botón de entrar: el que no sepa cómo apuntarse escribe a Fran
    // por WhatsApp con el mensaje ya redactado y el nombre del torneo puesto.
    row.appendChild(this.howToEnrollButton(t));
    if (!t.canRegister) row.appendChild(this.node('p', 'hint', 'El registro de este torneo está cerrado.'));
    else if (t.openSeats <= 0) row.appendChild(this.node('p', 'hint', 'No quedan plazas libres.'));
    return row;
  },

  // Texto del WhatsApp: incluye el título del torneo para que Fran sepa de cuál
  // le hablan sin tener que preguntarlo.
  enrollMessage(t) {
    return '¡Hola Fran! Estoy interesado en inscribirme en el torneo de poker ("'
      + (t.name || 'Torneo') + '") y quisiera más información, gracias.';
  },

  // Botón "Cómo inscribirse": abre WhatsApp con el mensaje ya escrito.
  howToEnrollButton(t) {
    const link = this.node('a', 'btn trn-howto', '💬 Cómo inscribirse');
    link.href = 'https://wa.me/' + TOURNAMENT_WHATSAPP + '?text=' + encodeURIComponent(this.enrollMessage(t));
    link.target = '_blank';
    link.rel = 'noopener';
    link.setAttribute('aria-label', 'Cómo inscribirse: abre WhatsApp con un mensaje preparado');
    return link;
  },

  async request(id) {
    const response = await this.api('/api/tournaments/' + id + '/request', {});
    this.say(response.status === 200
      ? (response.data.duplicate ? 'Ya tenías una solicitud en este torneo.' : '✅ Solicitud enviada. El admin la revisará.')
      : '⚠️ ' + (response.data.error || 'No se pudo enviar la solicitud.'));
    await this.refresh();
  },

  async cancel(id) {
    const response = await this.api('/api/tournaments/' + id + '/cancel', {});
    this.say(response.status === 200 ? 'Solicitud cancelada.' : '⚠️ ' + (response.data.error || 'No se pudo cancelar.'));
    await this.refresh();
  },

  say(text) {
    const status = document.getElementById('tournament-status');
    if (status) status.textContent = text;
  },

  // ---------- Mesa ----------
  // Posiciones de los asientos alrededor del óvalo (índice → casilla CSS).
  // El asiento 0 es el de la izquierda; los demás giran en sentido horario.
  openTable(t) {
    if (!t.playerId) return this.say('⚠️ Todavía no estás sentado en este torneo.');
    this.table = { id: t.id, playerId: t.playerId, name: t.name };
    this.state = null;
    this.version = 0;
    this.busy = false;
    this.nodes.clear();
    // App.show limpia las clases de sala, así que la del torneo va después.
    App.show('tournament');
    document.body.classList.add('in-tournament-room');
    this.el('name').textContent = t.name;
    this.lastTable = null;   // para detectar el cambio de mesa
    this.el('seats').innerHTML = '';
    this.el('board').innerHTML = '';
    this.el('me-cards').innerHTML = '';
    this.el('final').classList.add('hidden');
    this.setMessage('');
    this.pollGeneration += 1;
    this.polling = false;
    this.pollLoop();
  },

  closeTable() {
    this.generation += 1;
    this.polling = false;
    this.table = null;
    this.state = null;
    clearInterval(this.cardTimer); this.cardTimer = null;
    document.body.classList.remove('in-tournament-room');
    App.goLobby();
    this.refresh();
  },

  now() { return Date.now() + (this.offset || 0); },

  // El mensaje de error solo ocupa sitio cuando hay algo que decir.
  setMessage(text) {
    const el = this.el('message');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  },

  async pollLoop() {
    const generation = this.generation;
    if (this.polling || !this.table) return;
    this.polling = true;
    try {
      while (this.table && this.generation === generation) {
        const id = this.table.id;
        const player = this.table.playerId;
        try {
          const response = await fetch('/api/tournaments/' + id + '/state?player=' + encodeURIComponent(player) + '&v=' + this.version);
          if (this.generation !== generation || !this.table) break;
          const data = await response.json();
          if (response.status === 404) break; // aún no hay mesa: el admin la abre al arrancar
          if (data.notSeated) { this.say('Ya no estás sentado en este torneo.'); this.closeTable(); break; }
          this.version = data.version;
          this.offset = (data.serverNow || Date.now()) - Date.now();
          this.render(data);
        } catch (e) {
          if (this.generation !== generation) break;
          await new Promise(res => setTimeout(res, 1500)); // red caída: reintenta
        }
      }
    } finally {
      if (this.generation === generation) this.polling = false;
    }
  },

  // ---------- Render de la mesa ----------
  // "mm:ss" para la cuenta atrás, como el reloj de los carteles de torneo.
  clock(ms) {
    if (ms == null) return '';
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    return m + ':' + String(total % 60).padStart(2, '0');
  },

  render(s) {
    this.state = s;
    const info = s.tournament || {};
    const me = s.players.find(p => p.id === (this.table && this.table.playerId));

    // Ciegas: "600/1200(150)" con el ante entre paréntesis, como los carteles.
    this.el('blinds').textContent = info.smallBlind + '/' + info.bigBlind +
      (info.ante ? '(' + info.ante + ')' : '') + ' · nivel ' + (info.level || 1);

    // Con varias mesas se avisa de en cuál está el jugador. Con una sola, el
    // título se queda limpio (sin el sufijo de una ejecución anterior).
    if (info.tableCount > 1 && s.tableNumber) {
      const base = this.table && this.table.name ? this.table.name : 'Torneo';
      this.el('name').textContent = base + ' · Mesa ' + s.tableNumber + '/' + info.tableCount;
    } else if (this.table && this.table.name && /\s·\sMesa\s/.test(this.el('name').textContent)) {
      this.el('name').textContent = this.table.name;
    }

    // Panel central: progreso, bote, board y la mano del jugador.
    const lines = [];
    if (info.phase === 'descanso') lines.push('Descanso · se reanuda en ' + this.clock(info.breakTimeLeft));
    else if (info.phase === 'registro') lines.push('Registro abierto · ' + info.seated + '/' + info.maxPlayers + ' sentados');
    else {
      lines.push((info.remaining || 0) + '/' + (info.seated || 0) + ' en la mesa · bote ' +
        Number(info.prizePool || 0).toLocaleString('es-ES'));
      if (info.lateRegistration && info.lateLevels > 0) {
        lines.push('Registro tardío hasta el nivel ' + (info.lateLevels + 1));
      }
      if (info.levelTimeLeft != null) {
        lines.push(info.smallBlind + '/' + info.bigBlind + (info.ante ? '(' + info.ante + ')' : '') +
          ' sube en ' + this.clock(info.levelTimeLeft));
      }
    }
    this.el('info').textContent = lines.join('\n');
    this.el('pot').textContent = s.pot ? 'Bote: ' + s.pot.toLocaleString('es-ES') : '';
    this.renderBoard(s.board || []);
    const arrived = this.countArrived('board');
    const street = !s.handNo ? '' : arrived === 5 ? 'River' : arrived === 4 ? 'Turn' : arrived === 3 ? 'Flop' : 'Preflop';
    this.el('phase').textContent = street ? 'Mano ' + s.handNo + ' · ' + street : '';
    const label = s.privateHand && me ? s.privateHand.labels[arrived] : '';
    this.el('hand-label').textContent = label ? 'Tu mano: ' + label : '';

    this.renderSeats(s, me);
    this.renderShowdown(s, s.phase === 'finished' && (s.showdown || (s.pots || []).length > 0));
    this.renderMe(me);
    this.renderActions(s, me);
    this.renderStatus(s, me, info);
  },

  countArrived(prefix) {
    let n = 0;
    for (const [key, node] of this.nodes) {
      if (key.startsWith(prefix) && node.dataset.arrived === 'true') n++;
    }
    return n;
  },

  renderBoard(board) {
    const box = this.el('board');
    for (let i = 0; i < board.length; i++) this.placeCard(box, 'board:' + i, board[i], false);
  },

  // Las cartas usan el mismo HTML que el resto de mesas (Blackjack.cardHTML),
  // que ya aplica tamaño, sombras y el rojo de corazones/diamantes.
  placeCard(parent, key, card, faceDown) {
    let node = this.nodes.get(key);
    const html = faceDown || !card
      ? '<div class="playing-card face-down"><span class="suit">♠</span></div>'
      : Blackjack.cardHTML(card);
    if (!node) {
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      node = wrap.firstElementChild;
      parent.appendChild(node);
      this.nodes.set(key, node);
      node.dataset.arrived = 'false';
      setTimeout(() => { node.dataset.arrived = 'true'; }, 380);
    } else if (node._html !== html) {
      node.innerHTML = html;
    }
    node._card = card || null;
    node._html = html;
  },

  renderSeats(s, me) {
    const box = this.el('seats');
    const seats = s.players.filter(p => p.id !== (me && me.id));
    const self = me ? [me] : [];
    const ordered = self.concat(seats);
    const ids = new Set(ordered.map(p => p.id));
    for (const seat of [...box.children]) if (!ids.has(seat.dataset.player)) seat.remove();

    // Los asientos se construyen igual que en el póker normal (pk-seat con
    // nombre, distintivos, fichas, cartas, apuesta y resultado): al compartir
    // clases, la mesa se ve exactamente igual en los dos juegos.
    ordered.forEach((p, index) => {
      let seat = [...box.children].find(n => n.dataset.player === p.id);
      if (!seat) {
        seat = document.createElement('div');
        seat.dataset.player = p.id;
        seat.innerHTML = '<div class="pk-name"></div><div class="pk-badges"></div>' +
          '<div class="pk-chips"></div><div class="cards pk-hole"></div>' +
          '<div class="pk-bet"></div><div class="pk-result"></div>';
        box.appendChild(seat);
      }
      seat.className = 'pk-seat pk-seat-' + index + (p.folded ? ' folded' : '')
        + (p.lastAction && !p.folded ? ' act-' + p.lastAction : '') +
        (p.eliminated ? ' eliminated' : '') + (p.sittingOut && !p.eliminated ? ' sitting-out' : '') +
        (p.id === (me && me.id) ? ' self' : '') + (p.id === s.turnId ? ' active' : '');
      seat.querySelector('.pk-name').textContent = p.name + (p.id === (me && me.id) ? ' · Tú' : '') +
        (p.eliminated ? ' · ' + (p.place ? p.place + 'º' : 'fuera') : '');
      // En torneo el bote ya no se reparte al final: las fichas son del jugador.
      seat.querySelector('.pk-chips').textContent = p.eliminated ? '—' : p.chips.toLocaleString('es-ES');
      seat.querySelector('.pk-badges').textContent = [
        p.id === s.dealerId ? '⚪ D' : '', p.id === s.sbId ? '🔵 SB' : '', p.id === s.bbId ? '🟡 BB' : '',
        p.allIn ? 'ALL-IN' : '', p.sittingOut && !p.eliminated ? 'AUSENTE' : '',
      ].filter(Boolean).join(' ');

      // Solo se ven las cartas del rival cuando el servidor las envía
      // descubiertas (showdown); hasta entonces llegan a null.
      const holder = seat.querySelector('.pk-hole');
      const cards = p.cards || [];
      const revealed = cards.length > 0 && cards.every(c => !!c);
      const wanted = cards.length ? cards.length : 2;
      for (let i = 0; i < wanted; i++) {
        this.placeCard(holder, 'hole:' + p.id + ':' + i, cards[i] || null, !revealed);
      }
      while (holder.children.length > wanted) holder.removeChild(holder.lastElementChild);
      seat.querySelector('.pk-bet').textContent = p.inHand ? (p.folded ? 'Retirado'
        : p.allIn ? 'ALL-IN' : 'Apuesta: ' + p.bet) : 'Esperando';
      // Última acción, para ver de un vistazo quién pasa y quién sube.
      const result = seat.querySelector('.pk-result');
      result.textContent = Poker.actionLabel(p);
      result.className = 'pk-result' + (p.lastAction ? ' pk-act pk-act-' + p.lastAction : '');
    });
  },

  // Panel del showdown: mismo aspecto que el del póker normal (cartas ganadoras).
  renderShowdown(s, resultsReady) {
    const panel = this.el('showdown');
    const pot = (s.pots || []).find(p => !p.refund) || (s.pots || [])[0];
    const winners = pot ? pot.winners.map(id => s.players.find(p => p.id === id)).filter(Boolean) : [];
    const visible = resultsReady && winners.length > 0;
    panel.classList.toggle('hidden', !visible);
    if (!visible) return;
    this.el('winner-title').textContent = winners.map(p => p.name + ' gana con ' + p.handName).join(' · ');
    this.el('winning-detail').textContent = 'Estas son las cinco cartas de la combinación ganadora.';
    this.el('winning-hands').innerHTML = (winners[0].bestHand || [])
      .map(card => Blackjack.cardHTML(card)).join('');
  },

  renderMe(me) {
    this.el('me-name').textContent = me ? me.name + ' · Tú' : 'Tú';
    this.el('me-chips').textContent = me ? me.chips.toLocaleString('es-ES') + ' fichas' : '—';
    const box = this.el('me-cards');
    const cards = (me && me.cards) || [];
    for (let i = 0; i < cards.length; i++) this.placeCard(box, 'mine:' + i, cards[i], !cards[i]);
    while (box.children.length > cards.length) box.removeChild(box.lastElementChild);
  },

  // Botones de importe: Mín. / 50 % / Bote / Máx. y slider (estilo PokerStars).
  renderActions(s, me) {
    const box = this.el('actions');
    const amount = this.el('amount');
    const slider = this.el('slider');
    const min = Math.min(s.minRaiseTo, s.maxRaiseTo);
    const max = s.maxRaiseTo || 1;
    const away = !!(me && me.sittingOut);
    // Ausentado no se pierde el turno por accidente: los mandos se apagan.
    const canAct = s.canAct && me && !me.eliminated && !this.busy && !away;
    box.classList.toggle('disabled', !canAct);

    amount.min = min;
    amount.max = max;
    amount.disabled = !canAct || !s.canRaise;
    slider.disabled = amount.disabled;
    if (document.activeElement !== amount) this.setAmount(Math.max(min, Number(amount.value) || min));
    amount.oninput = () => this.setAmount(Number(amount.value) || min);
    slider.oninput = () => this.syncSlider();

    for (const id of ['fold', 'call', 'raise']) this.el(id).disabled = !canAct;
    this.el('raise').disabled = !canAct || !s.canRaise;
    this.el('call').textContent = s.toCall ? 'Igualar ' + s.toCall.toLocaleString('es-ES') : 'Pasar';
    this.el('raise').textContent = 'Apostar ' + Number(amount.value || 0).toLocaleString('es-ES');
    // Ausentarse / volver: siempre disponible mientras sigas en el torneo.
    const sitout = this.el('sitout');
    const canSit = !!(me && !me.eliminated && !this.busy);
    sitout.disabled = !canSit;
    sitout.textContent = away ? 'Volver a la mesa' : 'Ausentarse';
    sitout.setAttribute('aria-pressed', away ? 'true' : 'false');
    sitout.classList.toggle('is-away', away);
    sitout.title = away
      ? 'Vuelve a jugar: entrarás en la próxima mano.'
      : 'Deja de jugar un rato. Si te toca ciega, se te descontará igual.';
    const note = this.el('sitout-note');
    if (note) note.textContent = away
      ? 'Estás ausente: tu mano se retirará sola. Las ciegas que te toquen se descuentan igual.'
      : 'Si te ausentas, las ciegas que te toquen se te descuentan igual y tu mano se retira sola.';
  },

  // Ausentarse / volver a la mesa (sit out, como en PokerStars).
  toggleSitOut() {
    const me = this.state && this.state.players
      ? this.state.players.find(p => p.id === (this.table && this.table.playerId)) : null;
    return this.act(me && me.sittingOut ? 'sitin' : 'sitout');
  },

  // El slider mueve el importe entre el mínimo legal y el all-in.
  syncSlider() {
    const s = this.state;
    if (!s) return;
    const min = Math.min(s.minRaiseTo, s.maxRaiseTo);
    const max = s.maxRaiseTo || min;
    const value = min + Math.round((max - min) * (Number(this.el('slider').value) / 100));
    this.setAmount(Math.max(min, Math.min(max, value)));
  },

  // Fija el importe y recoloca el slider en la posición equivalente.
  // No llama a syncSlider: el slider manda sobre el importe, no al revés.
  setAmount(value) {
    const s = this.state;
    if (!s) return;
    const min = Math.min(s.minRaiseTo, s.maxRaiseTo);
    const max = s.maxRaiseTo || min;
    const clamped = Math.max(min, Math.min(max, Math.floor(value)));
    this.el('amount').value = String(clamped);
    const slider = this.el('slider');
    if (max > min) {
      slider.value = String(Math.max(1, Math.min(100, Math.round((clamped - min) / (max - min) * 100))));
    }
    this.el('raise').textContent = 'Apostar ' + clamped.toLocaleString('es-ES');
  },

  stepAmount(direction) {
    const s = this.state;
    if (!s) return;
    const step = Math.max(1, Math.floor(s.minRaiseTo / 2));
    this.setAmount((Number(this.el('amount').value) || 0) + direction * step);
  },

  // Atajos: Mín. / 50 % / Bote / Máx. El bote se ofrece como "todo lo que
  // tienes + lo que hay en medio"; el motor limita al máximo real del jugador.
  bet(kind) {
    const s = this.state;
    if (!s) return;
    const min = Math.min(s.minRaiseTo, s.maxRaiseTo);
    const max = s.maxRaiseTo;
    const value = {
      min,
      half: Math.floor((min + max) / 2),
      pot: max + (s.pot || 0),
      max,
    }[kind];
    if (value == null) return;
    this.setAmount(value);
  },

  async act(type) {
    if (this.busy || !this.table || !this.state) return;
    if (type === 'raise' && !this.state.canRaise) return;
    this.busy = true;
    const amount = Number(this.el('amount').value);
    try {
      const response = await this.api('/api/tournaments/' + this.table.id + '/action', {
        playerId: this.table.playerId, type, amount,
      });
      if (response.status !== 200) {
        this.setMessage('⚠️ ' + (response.data.error || 'Acción rechazada.'));
        return;
      }
      this.setMessage('');
      if (response.data.state) {
        this.version = response.data.version;
        this.render(response.data.state);
      }
    } catch (e) {
      this.setMessage('⚠️ Sin conexión con el servidor.');
    } finally {
      this.busy = false;
    }
  },

  call() { return this.act(this.state && this.state.toCall ? 'call' : 'check'); },

  // ---------- Barra de estado y clasificación final ----------
  renderStatus(s, me, info) {
    const now = this.now();
    const turn = s.players.find(p => p.id === s.turnId);
    let text;
    if (info.phase === 'descanso') {
      text = '⏸ Descanso: el torneo se reanuda en ' + Math.max(1, Math.ceil((info.breakTimeLeft || 0) / 60000)) + ' min.';
    } else if (info.phase === 'finalizado') {
      text = '🏆 Torneo terminado.';
    } else if (info.phase === 'registro' && s.turnId == null) {
      text = '⏳ Esperando jugadores: faltan ' + Math.max(0, info.maxPlayers - info.seated) + ' para llenar la mesa.';
    } else if (me && me.eliminated) {
      text = 'Has quedado eliminado. Puedes seguir mirando la mesa.';
    } else if (turn && me && turn.id === me.id) {
      text = '🎯 Tu turno · ' + Math.max(0, Math.ceil((s.turnDeadline - now) / 1000)) + ' s';
    } else if (turn) {
      text = 'Turno de ' + turn.name + ' · ' + Math.max(0, Math.ceil((s.turnDeadline - now) / 1000)) + ' s';
    } else {
      text = s.message || 'Mesa en espera.';
    }
    // Aviso de cambio de mesa: el servidor lo avisa un momento y luego
    // vuelve al estado normal, así se lee sin quedarse ahí fijo.
    if (this.lastTable && s.tableNumber && this.lastTable !== s.tableNumber) {
      text = '🔄 Te han cambiado a la mesa ' + s.tableNumber + ' para repartir mejor.';
    }
    this.lastTable = s.tableNumber;
    this.el('status').textContent = text;
    this.renderFinal(s, info);
  },

  renderFinal(s, info) {
    const box = this.el('final');
    if (info.phase !== 'finalizado') { box.classList.add('hidden'); return; }
    const me = s.players.find(p => p.id === (this.table && this.table.playerId));
    box.classList.remove('hidden');
    box.innerHTML = '';
    box.appendChild(this.node('h3', '', '🏆 Clasificación final'));
    const list = this.node('ol', 'trn-standings');
    for (const row of (info.standings || []).slice().sort((a, b) => a.place - b.place)) {
      list.appendChild(this.node('li', row.name === (me && me.name) ? 'me' : '', row.place + '. ' + row.name));
    }
    box.appendChild(list);
    if (me && me.eliminated) {
      const place = (info.standings || []).find(r => r.playerId === me.id);
      box.appendChild(this.node('p', 'hint', place ? 'Terminaste ' + place.place + 'º.' : ''));
    }
    box.appendChild(this.node('p', 'hint', 'Los premios se pagan al terminar. Vuelve al listado para ver el resultado.'));
    const back = this.node('button', 'btn primary', 'Volver a los torneos');
    back.type = 'button';
    back.onclick = () => this.closeTable();
    box.appendChild(back);
  },
};


// ============================================================
//  Panel de administración de torneos: crea y edita la
//  configuración, acepta o rechaza solicitudes y arranca o
//  finaliza el torneo. Usa Admin.post / Admin.api.
// ============================================================
const TournamentsAdmin = {
  prizes: [],

  init() {
    const form = document.getElementById('admin-tournament-form');
    if (form) form.addEventListener('submit', event => this.save(event));
    const mode = this.field('startmode');
    if (mode) mode.addEventListener('change', () => this.toggleStartDate());
    this.resetForm();
  },

  // Lectura y escritura de los campos del formulario (id 'trn-admin-<campo>').
  field(name) { return document.getElementById('trn-admin-' + name); },
  value(id) {
    const el = this.field(id);
    return el ? String(el.value || '').trim() : '';
  },
  setValue(id, value) {
    const el = this.field(id);
    if (el) el.value = value == null ? '' : String(value);
  },

  resetForm() {
    const id = this.value('id');
    this.prizes = [
      { position: 1, format: 'porcentaje', value: 50, label: 'Campeón' },
      { position: 2, format: 'porcentaje', value: 30, label: '' },
      { position: 3, format: 'porcentaje', value: 20, label: '' },
    ];
    this.renderPrizes();
    const form = document.getElementById('admin-tournament-form');
    if (form && !id) form.reset();
    this.setStartMode('jugadores');
    this.say('');
  },

  // Carga la configuración de un torneo en el formulario.
  edit(t) {
    this.setValue('id', t.id);
    this.setValue('name', t.name);
    this.setValue('buyin', t.buyIn);
    this.setValue('chips', t.startChips);
    this.setValue('sb', t.smallBlind);
    this.setValue('ante', t.ante);
    this.setValue('max', t.maxPlayers);
    this.setValue('min', t.minPlayers);
    this.setValue('tables', t.maxTables || 1);
    this.setValue('move', t.moveEveryLevels || 0);
    this.setValue('level', t.levelMinutes);
    this.setValue('levels', t.maxLevels);
    this.setValue('breakevery', t.breakEvery);
    this.setValue('breakmin', t.breakMinutes);
    this.setValue('late', t.lateLevels);
    this.setValue('visibility', t.visibility);
    this.setValue('desc', t.description);
    const auto = this.field('autostart');
    if (auto) auto.checked = t.autoStart !== false;
    this.setStartMode(t.startMode || (t.autoStart === false ? 'manual' : 'jugadores'), t.startsAt);
    this.prizes = (t.prizes || []).map(prize => Object.assign({}, prize));
    this.renderPrizes();
    this.say('Editando ' + t.name + '. Pulsa "Guardar torneo" para aplicar los cambios.');
  },

  // Muestra u oculta el campo de fecha según el modo elegido.
  setStartMode(mode, startsAt) {
    this.setValue('startmode', mode || 'jugadores');
    if (mode === 'programado' && startsAt) this.setValue('startat', TournamentsAdmin.toLocalInput(startsAt));
    this.toggleStartDate();
  },

  toggleStartDate() {
    const wrap = document.getElementById('trn-admin-startat-wrap');
    const on = this.value('startmode') === 'programado';
    if (wrap) wrap.classList.toggle('hidden', !on);
  },

  // Convierte un instante en "YYYY-MM-DDTHH:mm" para el input datetime-local.
  toLocalInput(when) {
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  },

  // Fecha y hora en texto para el listado del admin y del jugador.
  formatStartsAt(when) {
    if (!when) return '';
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('es-ES', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  },

  // Cuenta atrás legible: "en 2 días", "en 3 h 20 min", "en 12 min".
  countdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (days > 0) return 'en ' + days + (days === 1 ? ' día' : ' días');
    if (hours > 0) return 'en ' + hours + ' h' + (mins ? ' ' + mins + ' min' : '');
    return 'en ' + Math.max(0, mins) + ' min';
  },

  addPrize(prize) {
    this.prizes.push(prize || { position: this.prizes.length + 1, format: 'porcentaje', value: 10, label: '' });
    this.renderPrizes();
  },

  renderPrizes() {
    const box = document.getElementById('trn-admin-prize-list');
    if (!box) return;
    box.innerHTML = '';
    this.prizes.forEach((prize, index) => {
      const row = Tournaments.node('div', 'trn-prize-row');
      const position = Tournaments.node('input', 'name-input');
      position.type = 'number'; position.min = '1'; position.max = '9'; position.step = '1';
      position.value = prize.position; position.title = 'Puesto';
      position.oninput = () => { prize.position = Number(position.value); };
      const format = Tournaments.node('select', 'name-input');
      for (const [value, name] of [['porcentaje', '% del bote'], ['fichas', 'Fichas fijas']]) {
        const option = Tournaments.node('option', '', name);
        option.value = value;
        format.appendChild(option);
      }
      format.value = prize.format;
      format.onchange = () => { prize.format = format.value; };
      const value = Tournaments.node('input', 'name-input');
      value.type = 'number'; value.min = '0'; value.step = '1';
      value.value = prize.value; value.title = 'Cantidad';
      value.oninput = () => { prize.value = Number(value.value); };
      const label = Tournaments.node('input', 'name-input');
      label.value = prize.label || ''; label.placeholder = 'Nombre (campeón…)'; label.maxLength = 40;
      label.oninput = () => { prize.label = label.value; };
      const remove = Tournaments.node('button', 'btn danger', '×');
      remove.type = 'button'; remove.title = 'Quitar premio';
      remove.onclick = () => { this.prizes.splice(index, 1); this.renderPrizes(); };
      row.append(position, format, value, label, remove);
      box.appendChild(row);
    });
  },

  async save(event) {
    if (event && event.preventDefault) event.preventDefault();
    const id = this.value('id');
    const auto = this.field('autostart');
    const startMode = this.value('startmode') || 'jugadores';
    const payload = {
      name: this.value('name'),
      description: this.value('desc'),
      buyIn: this.value('buyin'),
      startChips: this.value('chips'),
      smallBlind: this.value('sb'),
      ante: this.value('ante'),
      maxPlayers: this.value('max'),
      minPlayers: this.value('min'),
      maxTables: this.value('tables'),
      moveEveryLevels: this.value('move'),
      levelMinutes: this.value('level'),
      maxLevels: this.value('levels'),
      breakEvery: this.value('breakevery'),
      breakMinutes: this.value('breakmin'),
      lateRegistration: Number(this.value('late')) > 0,
      lateLevels: this.value('late'),
      autoStart: auto ? auto.checked : true,
      startMode,
      startsAt: startMode === 'programado' ? this.value('startat') : '',
      visibility: this.value('visibility') || 'publico',
      prizes: this.prizes,
    };
    const response = await Admin.post('/api/admin/tournaments' + (id ? '/' + id + '/update' : ''), payload);
    if (response.status !== 200) {
      this.say('⚠️ ' + (response.data.error || 'No se pudo guardar el torneo.'));
      return;
    }
    this.say('✅ Torneo ' + (id ? 'actualizado' : 'creado') + ': ' + response.data.tournament.name);
    this.setValue('id', '');
    this.resetForm();
    this.load();
  },

  async act(id, action) {
    const response = await Admin.post('/api/admin/tournaments/' + id + '/' + action, {});
    if (response.status !== 200) {
      this.say('⚠️ ' + (response.data.error || 'No se pudo completar la acción.'));
      return;
    }
    this.say('✅ Listo.' + (response.data.paid ? ' Premios repartidos: ' + response.data.paid + ' fichas.' : ''));
    this.load();
  },

  async decide(requestId, accept) {
    const response = await Admin.post('/api/admin/tournaments/requests/' + requestId + '/' + (accept ? 'accept' : 'reject'), {});
    if (response.status !== 200) {
      this.say('⚠️ ' + (response.data.error || 'No se pudo resolver la solicitud.'));
      return;
    }
    this.say(accept ? '✅ Jugador sentado y cuota cobrada.' : '✅ Solicitud rechazada.');
    this.load();
  },

  async remove(id) {
    if (typeof confirm === 'function' && !confirm('¿Borrar este torneo y sus solicitudes?')) return;
    const response = await Admin.post('/api/admin/tournaments/' + id + '/delete', {});
    if (response.status !== 200) {
      this.say('⚠️ ' + (response.data.error || 'No se pudo borrar el torneo.'));
      return;
    }
    if (this.value('id') === id) { this.setValue('id', ''); this.resetForm(); }
    this.say('✅ Torneo borrado.');
    this.load();
  },

  async load() {
    const box = document.getElementById('admin-tournament-list');
    const status = document.getElementById('admin-tournament-status');
    if (!box) return;
    const response = await Admin.api('/api/admin/tournaments');
    if (response.status !== 200) {
      if (status) status.textContent = '⚠️ ' + (response.data.error || 'No se pudieron cargar los torneos.');
      return;
    }
    const tournaments = response.data.tournaments || [];
    box.innerHTML = '';
    if (!tournaments.length) {
      box.appendChild(Tournaments.node('p', 'hint', 'Todavía no hay torneos. Crea el primero con el formulario de arriba.'));
      if (status) status.textContent = '';
      return;
    }
    for (const t of tournaments) box.appendChild(this.renderRow(t));
    if (status) {
      const storage = response.data.storage || {};
      status.textContent = tournaments.length + (tournaments.length === 1 ? ' torneo' : ' torneos') +
        ' · almacenamiento: ' + storage.backend;
    }
  },

  // Una fila por torneo: reglas, solicitudes pendientes y acciones.
  renderRow(t) {
    const node = Tournaments.node('article', 'admin-tournament');
    const head = Tournaments.node('header', 'admin-tournament-head');
    head.appendChild(Tournaments.node('strong', '', t.name));
    head.appendChild(Tournaments.node('span', 'trn-badge trn-badge-' + t.status,
      t.status === 'registro' ? 'REGISTRO' : t.status === 'en_curso' ? 'EN JUEGO' : 'FINALIZADO'));
    node.appendChild(head);

    node.appendChild(Tournaments.node('p', 'hint',
      t.seated + '/' + t.maxPlayers + ' sentados · cuota ' + t.buyIn + ' · ' + t.startChips + ' fichas · ' +
      t.smallBlind + '/' + t.bigBlind + (t.ante ? '(' + t.ante + ')' : '') + ' · ' + t.levelMinutes + ' min/nivel' +
      (t.breakEvery ? ' · descanso cada ' + t.breakEvery + ' niveles' : '')));
    if ((t.maxTables || 1) > 1) {
      const detalle = (t.tables || []).map(x =>
        'Mesa ' + x.number + ': ' + x.seated + (x.playing ? ' repartiendo' : '')).join(' · ');
      node.appendChild(Tournaments.node('p', 'hint',
        '🍀 ' + t.tableCount + '/' + t.maxTables + ' mesas' + (detalle ? ' — ' + detalle : '') +
        (t.moveEveryLevels > 0 ? ' · se reparten cada ' + t.moveEveryLevels + ' niveles' : '')));
    }

    if (t.startMode === 'programado' && t.startsAt) {
      const left = t.scheduledIn == null ? '' : ' · ' + TournamentsAdmin.countdown(t.scheduledIn);
      node.appendChild(Tournaments.node('p', 'hint trn-when',
        '🗓️ Arranca solo el ' + TournamentsAdmin.formatStartsAt(t.startsAt) + left));
    }

    if ((t.requests || []).length) {
      const list = Tournaments.node('ul', 'admin-tournament-requests');
      for (const r of t.requests) {
        const row = Tournaments.node('li', 'trn-request trn-request-' + r.status);
        row.appendChild(Tournaments.node('b', '', r.username));
        row.appendChild(Tournaments.node('span', 'hint',
          ' ' + (r.status === 'pendiente' ? 'esperando' : r.status)));
        if (r.status === 'pendiente') {
          const accept = Tournaments.node('button', 'btn', 'Aceptar');
          accept.type = 'button';
          accept.onclick = () => this.decide(r.id, true);
          const reject = Tournaments.node('button', 'btn danger', 'Rechazar');
          reject.type = 'button';
          reject.onclick = () => this.decide(r.id, false);
          row.append(accept, reject);
        }
        list.appendChild(row);
      }
      node.appendChild(list);
    }

    if (t.status === 'finalizado' && (t.results || []).length) {
      const results = Tournaments.node('ol', 'tournament-results');
      for (const row of t.results) {
        results.appendChild(Tournaments.node('li', '',
          row.name + (row.prize ? ' · +' + row.prize + ' fichas' : ' · sin premio')));
      }
      node.appendChild(results);
    }

    const actions = Tournaments.node('div', 'btn-row');
    if (t.status !== 'finalizado') {
      const edit = Tournaments.node('button', 'btn', '✏️ Editar');
      edit.type = 'button';
      edit.onclick = () => this.edit(t);
      actions.appendChild(edit);
    }
    if (t.status === 'registro' && t.seated >= 2) {
      const start = Tournaments.node('button', 'btn primary', '▶️ Arrancar ahora');
      start.type = 'button';
      start.onclick = () => this.act(t.id, 'start');
      actions.appendChild(start);
    }
    if (t.status === 'en_curso') {
      const finish = Tournaments.node('button', 'btn danger', '🏁 Finalizar y pagar');
      finish.type = 'button';
      finish.onclick = () => this.act(t.id, 'finish');
      actions.appendChild(finish);
    }
    if (t.status !== 'en_curso') {
      const del = Tournaments.node('button', 'btn danger', '🗑 Borrar');
      del.type = 'button';
      del.onclick = () => this.remove(t.id);
      actions.appendChild(del);
    }
    node.appendChild(actions);
    return node;
  },

  say(text) {
    const el = document.getElementById('admin-tournament-form-status');
    if (el) el.textContent = text;
  },
};
