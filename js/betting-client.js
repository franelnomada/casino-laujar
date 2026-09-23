// ============================================================
//  Cliente de apuestas deportivas: eventos, Mis apuestas y administración
// ============================================================
const Betting = {
  events: [],
  timer: null,

  init() {
    const form = document.getElementById('admin-betting-form');
    if (form) form.addEventListener('submit', event => BettingAdmin.createEvent(event));
    if (typeof BettingAdmin !== 'undefined') BettingAdmin.init();
    this.refresh();
    this.timer = setInterval(() => {
      const lobby = document.getElementById('screen-lobby');
      if (lobby && !lobby.classList.contains('hidden')) this.refresh();
    }, 5000);
  },

  sessionChanged() { this.refresh(); },

  async api(path, body) {
    const options = { headers: {} };
    if (typeof Auth !== 'undefined' && Auth.token) options.headers.Authorization = 'Bearer ' + Auth.token;
    if (body !== undefined) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    let data = {};
    try { data = await response.json(); } catch (e) { /* respuesta vacía */ }
    return { status: response.status, data };
  },

  async refresh(manual) {
    if (manual) {
      const status = document.getElementById('betting-status');
      if (status) status.textContent = 'Actualizando eventos…';
    }
    try {
      const response = await this.api('/api/betting/events');
      if (response.status !== 200) throw new Error(response.data.error || 'No se pudieron cargar.');
      this.events = response.data.events || [];
      this.renderEvents();
      const status = document.getElementById('betting-status');
      if (status) status.textContent = this.events.length
        ? this.events.length + (this.events.length === 1 ? ' evento visible.' : ' eventos visibles.')
        : 'Ahora mismo no hay eventos abiertos.';
    } catch (e) {
      const status = document.getElementById('betting-status');
      if (status) status.textContent = '⚠️ ' + e.message;
    }
    this.loadMine();
  },

  node(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  },

  renderEvents() {
    const box = document.getElementById('betting-events');
    if (!box) return;
    box.innerHTML = '';
    for (const event of this.events) {
      const card = this.node('article', 'betting-event');
      const head = this.node('div', 'betting-event-head');
      const title = this.node('div');
      title.appendChild(this.node('strong', '', event.title));
      title.appendChild(this.node('div', 'hint', event.teams.join(' vs ')));
      const meta = this.node('div', 'betting-event-meta');
      meta.appendChild(this.node('time', '', new Date(event.startsAt).toLocaleString('es-ES')));
      meta.appendChild(this.node('span', 'betting-status betting-status-' + event.status,
        event.status === 'open' ? 'ABIERTO' : 'BLOQUEADO'));
      head.append(title, meta);
      card.appendChild(head);
      for (const market of event.markets) card.appendChild(this.renderMarket(event, market));
      box.appendChild(card);
    }
  },

  renderMarket(event, market) {
    const section = this.node('section', 'betting-market');
    section.appendChild(this.node('h3', '', market.label));
    for (const outcome of market.outcomes) {
      const row = this.node('div', 'betting-outcome');
      const label = this.node('label', '', outcome.label + ' · cuota ' + outcome.odds);
      const amount = this.node('input', 'betting-stake');
      amount.type = 'number'; amount.min = '1'; amount.step = '1'; amount.value = '10';
      amount.setAttribute('aria-label', 'Cantidad para ' + outcome.label);
      const button = this.node('button', 'btn primary', 'Apostar');
      button.type = 'button';
      button.disabled = event.status !== 'open';
      button.onclick = () => this.place(event.id, market.id, outcome.id, amount, button);
      row.append(label, amount, button);
      section.appendChild(row);
    }
    return section;
  },

  async place(eventId, marketId, outcomeId, input, button) {
    if (typeof Auth === 'undefined' || !Auth.token) {
      if (typeof Auth !== 'undefined') Auth.openPanel();
      return;
    }
    const stake = Number(input.value);
    button.disabled = true;
    const response = await this.api('/api/betting/place', { eventId, marketId, outcomeId, stake });
    if (response.status !== 200) {
      const status = document.getElementById('betting-status');
      if (status) status.textContent = '⚠️ ' + (response.data.error || 'No se pudo apostar.');
    } else {
      Auth.applyUser(response.data.user);
      const status = document.getElementById('betting-status');
      if (status) status.textContent = '✅ Apuesta confirmada. ¡Buena suerte!';
      this.loadMine();
      if (typeof TxConsole !== 'undefined') TxConsole.poll();
    }
    await this.refresh();
  },

  async loadMine() {
    const list = document.getElementById('betting-mine-list');
    const status = document.getElementById('betting-mine-status');
    const count = document.getElementById('betting-mine-count');
    if (!list) return;
    list.innerHTML = '';
    if (typeof Auth === 'undefined' || !Auth.token) {
      if (status) status.textContent = 'Entra en tu cuenta para ver tus apuestas.';
      if (count) count.textContent = '';
      return;
    }
    const response = await this.api('/api/betting/mine?token=' + encodeURIComponent(Auth.token));
    if (response.status !== 200) {
      if (status) status.textContent = '⚠️ ' + (response.data.error || 'No se pudieron cargar tus apuestas.');
      return;
    }
    const names = { pending: 'Pendiente', won: 'Ganada', lost: 'Perdida', refunded: 'Devuelta' };
    const bets = response.data.bets || [];
    if (count) count.textContent = bets.length ? '(' + bets.length + ')' : '';
    if (status) status.textContent = bets.length ? 'Tus apuestas y su estado actual:' : 'Todavía no has apostado.';
    for (const bet of bets) {
      const row = this.node('article', 'betting-bet betting-bet-' + bet.status);
      const title = this.node('strong', '', bet.eventTitle);
      const detail = this.node('div', '', bet.marketLabel + ': ' + bet.outcomeLabel);
      const amount = this.node('div', 'hint', bet.stake + ' fichas · cuota ' + bet.odds +
        (bet.status === 'won' && bet.payout != null ? ' · premio ' + bet.payout : ''));
      const state = this.node('span', 'betting-state', names[bet.status] || bet.status);
      row.append(title, detail, amount, state);
      list.appendChild(row);
    }
  },
};

const BettingAdmin = {
  draft: [],
  node(tag, className, text) { return Betting.node(tag, className, text); },

  init() {
    this.setDefaultStart();
    this.draft = [];
    this.addMarket();
  },

  setDefaultStart() {
    const input = document.getElementById('admin-betting-starts');
    if (!input) return;
    const date = new Date(Date.now() + 60 * 60 * 1000);
    date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5, 0, 0);
    input.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  },

  defaults(type) {
    return {
      winner: [['Gana ' + (document.getElementById('admin-betting-team-a')?.value || 'equipo A'), 2], ['Empate', 3], ['Gana ' + (document.getElementById('admin-betting-team-b')?.value || 'equipo B'), 2]],
      goal_diff: [['0 goles', 3], ['1 gol', 3], ['2 goles', 4], ['3 o más', 6]],
      exact_score: [['1-0', 7], ['2-0', 7], ['1-1', 6], ['2-1', 8]],
      custom: [['Equipo A', 2], ['Equipo B', 2]],
    }[type] || [['Sí', 2], ['No', 2]];
  },

  addMarket(type) {
    type = type || 'winner';
    this.draft.push({ type, label: '', outcomes: this.defaults(type).map((item, i) => ({ id: '', label: item[0], odds: item[1] })) });
    this.renderDraft();
  },

  renderDraft() {
    const box = document.getElementById('admin-betting-markets');
    if (!box) return;
    box.innerHTML = '';
    this.draft.forEach((market, marketIndex) => {
      const card = this.node('div', 'admin-betting-market');
      const head = this.node('div', 'admin-betting-market-head');
      const select = this.node('select', 'name-input');
      for (const [value, name] of [['winner', 'Ganador (1X2)'], ['goal_diff', 'Diferencia de goles'], ['exact_score', 'Resultado exacto'], ['custom', 'Personalizado']]) {
        const option = this.node('option', '', name); option.value = value; select.appendChild(option);
      }
      select.value = market.type;
      select.onchange = () => { market.type = select.value; market.outcomes = this.defaults(market.type).map(item => ({ id: '', label: item[0], odds: item[1] })); this.renderDraft(); };
      const label = this.node('input', 'name-input'); label.value = market.label; label.placeholder = 'Nombre del mercado';
      label.oninput = () => { market.label = label.value; };
      const remove = this.node('button', 'btn danger', 'Quitar'); remove.type = 'button';
      remove.onclick = () => { this.draft.splice(marketIndex, 1); this.renderDraft(); };
      head.append(select, label, remove);
      card.appendChild(head);
      for (let i = 0; i < market.outcomes.length; i++) {
        const outcome = market.outcomes[i];
        const row = this.node('div', 'admin-betting-outcome');
        const text = this.node('input', 'name-input'); text.value = outcome.label; text.placeholder = 'Opción';
        text.oninput = () => { outcome.label = text.value; };
        const odds = this.node('input', 'name-input'); odds.type = 'number'; odds.min = '1'; odds.step = '0.01'; odds.value = outcome.odds; odds.title = 'Cuota';
        odds.oninput = () => { outcome.odds = Number(odds.value); };
        const del = this.node('button', 'btn danger', '×'); del.type = 'button'; del.title = 'Quitar opción';
        del.onclick = () => { market.outcomes.splice(i, 1); this.renderDraft(); };
        row.append(text, odds, del);
        card.appendChild(row);
      }
      const add = this.node('button', 'btn', '+ Opción'); add.type = 'button';
      add.onclick = () => { market.outcomes.push({ id: '', label: '', odds: 2 }); this.renderDraft(); };
      card.appendChild(add);
      box.appendChild(card);
    });
  },

  async createEvent(event) {
    event.preventDefault();
    const status = document.getElementById('admin-betting-form-status');
    const value = id => document.getElementById(id).value.trim();
    const body = {
      title: value('admin-betting-title'), teams: [value('admin-betting-team-a'), value('admin-betting-team-b')],
      startsAt: new Date(value('admin-betting-starts')).toISOString(), markets: this.draft,
    };
    const response = await Admin.post('/api/admin/betting/events', body);
    if (response.status !== 200) {
      if (status) status.textContent = '⚠️ ' + (response.data.error || 'No se pudo crear.');
      return;
    }
    if (status) status.textContent = '✅ Evento creado y abierto.';
    document.getElementById('admin-betting-form').reset();
    this.setDefaultStart();
    this.draft = []; this.addMarket();
    this.loadEvents();
    Betting.refresh();
  },

  async loadEvents() {
    const box = document.getElementById('admin-betting-events');
    const status = document.getElementById('admin-betting-status');
    if (!box) return;
    const response = await Admin.api('/api/admin/betting/events');
    if (response.status !== 200) {
      if (status) status.textContent = '⚠️ ' + (response.data.error || 'No se pudieron cargar.');
      return;
    }
    const events = (response.data.events || []).slice().reverse();
    box.innerHTML = '';
    for (const event of events) box.appendChild(this.renderEvent(event));
    if (status) status.textContent = events.length + (events.length === 1 ? ' evento.' : ' eventos.');
  },

  renderEvent(event) {
    const card = this.node('article', 'admin-betting-event');
    const head = this.node('div', 'admin-betting-event-head');
    const info = this.node('div');
    info.append(this.node('strong', '', event.title), this.node('div', 'hint', new Date(event.startsAt).toLocaleString('es-ES')));
    info.appendChild(this.node('span', 'betting-status betting-status-' + event.status, event.status.toUpperCase()));
    head.appendChild(info);
    const actions = this.node('div', 'btn-row');
    if (event.status === 'open') {
      const lock = this.node('button', 'btn', '🔒 Bloquear'); lock.type = 'button';
      lock.onclick = () => this.action(event.id, 'lock', {}, 'Evento bloqueado.');
      const odds = this.node('button', 'btn', 'Editar cuotas'); odds.type = 'button';
      odds.onclick = () => this.showOddsEditor(event, card);
      actions.append(lock, odds);
    }
    if (event.status === 'locked') {
      const settle = this.node('button', 'btn primary', '🏁 Resolver'); settle.type = 'button';
      settle.onclick = () => this.showSettleForm(event, card);
      actions.appendChild(settle);
    }
    if (['open', 'locked'].includes(event.status)) {
      const cancel = this.node('button', 'btn danger', 'Cancelar'); cancel.type = 'button';
      cancel.onclick = () => {
        if (confirm('¿Cancelar ' + event.title + ' y devolver todas las apuestas?')) {
          this.action(event.id, 'cancel', {}, 'Evento cancelado y apuestas devueltas.');
        }
      };
      actions.appendChild(cancel);
    }
    head.appendChild(actions);
    card.appendChild(head);
    for (const market of event.markets) {
      const marketLine = this.node('div', 'admin-betting-market-summary');
      marketLine.appendChild(this.node('strong', '', market.label + ': '));
      marketLine.appendChild(this.node('span', '', market.outcomes.map(o => o.label + ' @ ' + o.odds).join(' · ')));
      card.appendChild(marketLine);
    }
    return card;
  },

  async action(id, action, body, message) {
    const response = await Admin.post('/api/admin/betting/events/' + encodeURIComponent(id) + '/' + action, body);
    const status = document.getElementById('admin-betting-status');
    if (response.status !== 200) {
      if (status) status.textContent = '⚠️ ' + (response.data.error || 'No se pudo actualizar.');
      return;
    }
    if (status) status.textContent = '✅ ' + message;
    this.loadEvents();
    Betting.refresh();
  },

  showSettleForm(event, card) {
    const old = card.querySelector('.admin-betting-result-form');
    if (old) old.remove();
    const form = this.node('div', 'admin-betting-result-form');
    form.appendChild(this.node('h3', '', 'Resultado ganador por mercado'));
    for (const market of event.markets) {
      const row = this.node('label', 'admin-betting-result-row');
      row.appendChild(this.node('span', '', market.label));
      const select = this.node('select', 'name-input');
      select.dataset.marketId = market.id;
      for (const outcome of market.outcomes) {
        const option = this.node('option', '', outcome.label + ' @ ' + outcome.odds);
        option.value = outcome.id; select.appendChild(option);
      }
      row.appendChild(select); form.appendChild(row);
    }
    const button = this.node('button', 'btn primary', 'Resolver y pagar'); button.type = 'button';
    button.onclick = () => {
      const results = {};
      form.querySelectorAll('select').forEach(select => { results[select.dataset.marketId] = select.value; });
      this.action(event.id, 'settle', { results }, 'Evento resuelto y premios pagados.');
    };
    form.appendChild(button); card.appendChild(form);
  },

  showOddsEditor(event, card) {
    const old = card.querySelector('.admin-betting-odds-form');
    if (old) old.remove();
    const form = this.node('div', 'admin-betting-odds-form');
    form.appendChild(this.node('h3', '', 'Editar cuotas (las apuestas ya hechas conservan las suyas)'));
    const markets = JSON.parse(JSON.stringify(event.markets));
    for (const market of markets) {
      const block = this.node('div', 'admin-betting-market');
      block.appendChild(this.node('strong', '', market.label));
      for (const outcome of market.outcomes) {
        const row = this.node('label', 'admin-betting-result-row');
        row.appendChild(this.node('span', '', outcome.label));
        const input = this.node('input', 'name-input');
        input.type = 'number'; input.min = '1'; input.step = '0.01'; input.value = outcome.odds;
        input.oninput = () => { outcome.odds = Number(input.value); };
        row.appendChild(input); block.appendChild(row);
      }
      form.appendChild(block);
    }
    const actions = this.node('div', 'btn-row');
    const save = this.node('button', 'btn primary', 'Guardar cuotas'); save.type = 'button';
    save.onclick = () => this.action(event.id, 'markets', { markets }, 'Cuotas actualizadas.');
    const cancel = this.node('button', 'btn', 'Cancelar'); cancel.type = 'button'; cancel.onclick = () => form.remove();
    actions.append(save, cancel); form.appendChild(actions); card.appendChild(form);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Betting, BettingAdmin };
}
