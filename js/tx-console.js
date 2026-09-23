// ============================================================
//  Casino Night — consola pública de transacciones (lobby)
//  Muestra en tiempo real lo que pasa con las fichas de todos.
//  Los textos se construyen aquí a partir de los campos que
//  devuelve GET /api/transactions (el servidor no los formatea).
// ============================================================
const TxConsole = {
  MAX_LINES: 25,   // líneas visibles (el servidor guarda muchas más)
  INTERVAL: 4000,  // refresco automático en ms
  seen: {},        // id → true: evita repetir líneas ya pintadas
  shown: 0,
  box: null,
  status: null,
  timer: null,

  init() {
    this.box = document.getElementById('tx-console-lines');
    if (!this.box) return; // esta página no tiene consola
    this.status = document.getElementById('tx-console-status');
    this.poll();
    // Refresco automático solo mientras se ve el lobby (como loadOpenRooms)
    this.timer = setInterval(() => {
      const lobby = document.getElementById('screen-lobby');
      if (lobby && !lobby.classList.contains('hidden')) this.poll();
    }, this.INTERVAL);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.poll(); });
  },

  async poll() {
    if (document.hidden) return; // pestaña en segundo plano: no gastamos datos
    try {
      const r = await fetch('/api/transactions');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      this.render(data && Array.isArray(data.transactions) ? data.transactions : []);
      this.setStatus(this.shown ? '' : 'Aún no hay movimiento de fichas...');
    } catch (e) {
      this.setStatus('⚠️ sin conexión con la consola');
    }
  },

  setStatus(text) {
    if (this.status) this.status.textContent = text;
  },

  // Añade solo las entradas nuevas (arriba, sin repintar toda la lista)
  render(list) {
    const fresh = list.filter(t => t && t.id != null && !this.seen[t.id]);
    if (!fresh.length) return;
    for (const t of fresh) this.seen[t.id] = true;
    if (this.box.dataset.ready !== '1') { this.box.innerHTML = ''; this.box.dataset.ready = '1'; }
    for (const t of fresh.slice().reverse()) {
      const line = document.createElement('div');
      line.className = 'tx-line ' + this.classFor(t.type);
      line.textContent = this.textFor(t);
      const at = new Date(t.ts || Date.now());
      line.title = at.toLocaleTimeString('es-ES');
      this.box.insertBefore(line, this.box.firstChild);
      this.shown++;
    }
    while (this.box.children.length > this.MAX_LINES) this.box.removeChild(this.box.lastChild);
  },

  classFor(type) {
    if (type === 'win' || type === 'admin_grant' || type === 'betting_bet' || type === 'betting_refund' || type === 'weekly_bonus') return 'tx-win';
    if (type === 'loss' || type === 'admin_revoke') return 'tx-loss';
    return '';
  },

  gameName(game) {
    if (game === 'poker') return 'póker';
    if (game === 'roulette') return 'ruleta';
    if (game === 'blackjack') return 'blackjack';
    if (game === 'sports') return 'apuestas deportivas';
    return game || 'la mesa';
  },

  textFor(t) {
    if (t.message) return t.message;
    const amount = Number(t.amount || 0).toLocaleString('es-ES');
    const target = t.target || 'un jugador';
    const where = t.game ? ' jugando a ' + this.gameName(t.game) : ''; // set exacto: sin mesa
    const saldo = ' (saldo: ' + Number(t.balanceAfter || 0).toLocaleString('es-ES') + ')';
    if (t.type === 'win') {
      return t.username + ' ha ganado ' + amount + ' fichas' + where + saldo;
    }
    if (t.type === 'loss') {
      return t.username + ' ha perdido ' + amount + ' fichas' + where + saldo;
    }
    if (t.type === 'admin_grant') {
      return 'Admin (' + t.username + ') ha otorgado ' + amount + ' fichas a ' + target;
    }
    if (t.type === 'admin_revoke') {
      return 'Admin (' + t.username + ') ha quitado ' + amount + ' fichas a ' + target;
    }
    return t.username + ' — ' + amount + ' fichas';
  },
};
