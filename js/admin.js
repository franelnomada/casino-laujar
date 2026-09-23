// ============================================================
//  Casino Night — panel de administración (ban/unban/kick)
//  Solo para cuentas con isAdmin (franelnomada). Usa el token
//  de Auth en la cabecera Authorization: Bearer.
// ============================================================
const Admin = {
  timer: null,

  async api(path, opts) {
    const r = await fetch(path, Object.assign({
      headers: {
        'Authorization': 'Bearer ' + (typeof Auth !== 'undefined' && Auth.token ? Auth.token : ''),
        'Content-Type': 'application/json',
      },
    }, opts || {}));
    let data = {};
    try { data = await r.json(); } catch (e) { /* respuesta vacía */ }
    return { status: r.status, data };
  },

  post(path, body) {
    return this.api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  },

  open() {
    App.show('admin');
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), 5000);
  },

  close() {
    clearInterval(this.timer);
    this.timer = null;
    App.show('lobby');
  },

  // El panel puede abrirse y luego navegarse fuera: si la pantalla está
  // oculta, el refresco automático se corta solo.
  refresh() {
    const screen = document.getElementById('screen-admin');
    if (!screen || screen.classList.contains('hidden')) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    this.loadUsers();
    this.loadRooms();
    if (typeof BettingAdmin !== 'undefined') this.loadBettingEvents();
  },

  loadBettingEvents() {
    if (typeof BettingAdmin !== 'undefined') BettingAdmin.loadEvents();
  },

  async loadUsers() {
    const body = document.getElementById('admin-users-body');
    const status = document.getElementById('admin-users-status');
    if (!body) return;
    try {
      const r = await this.api('/api/admin/users');
      if (r.status !== 200) {
        if (status) status.textContent = '⚠️ ' + (r.data.error || 'No se pudieron cargar las cuentas.');
        return;
      }
      const users = r.data.users || [];
      body.innerHTML = users.map(u =>
        '<tr' + (u.banned ? ' class="banned"' : '') + '>' +
          '<td class="admin-name"></td>' +
          '<td>💰 ' + Number(u.chips || 0).toLocaleString('es-ES') + '</td>' +
          '<td>' + (u.banned ? '🚫 Baneada' : '✔ Activa') + (u.isAdmin ? ' · 🛠 admin' : '') + '</td>' +
          '<td><button class="btn" onclick="Admin.adjustChips(\'' +
            encodeURIComponent(String(u.name).toLowerCase()) + '\',1)">+ Fichas</button> ' +
            '<button class="btn" onclick="Admin.adjustChips(\'' +
            encodeURIComponent(String(u.name).toLowerCase()) + '\',-1)">− Fichas</button></td>' +
          '<td>' + (u.isAdmin ? '' :
                        '<button class="btn' + (u.banned ? '' : ' danger') + '" onclick="Admin.toggleBan(\'' +
            encodeURIComponent(String(u.name).toLowerCase()) + '\',' + (u.banned ? 'false' : 'true') + ')">' +
            (u.banned ? 'Desbanear' : 'Banear') + '</button>') + '</td>' +
        '</tr>').join('');
      // El nombre va por textContent: los usuarios no escriben HTML
      body.querySelectorAll('.admin-name').forEach((td, i) => { td.textContent = users[i].name; });
      if (status) status.textContent = users.length + (users.length === 1 ? ' cuenta.' : ' cuentas.');
    } catch (e) {
      if (status) status.textContent = '⚠️ No se pudo conectar con el servidor.';
    }
  },

  async toggleBan(keyEncoded, ban) {
    const key = decodeURIComponent(keyEncoded);
    const r = await this.post('/api/admin/users/' + encodeURIComponent(key) + '/' + (ban ? 'ban' : 'unban'));
    if (r.status !== 200) { this.sayUsers(r.data.error || 'No se pudo actualizar la cuenta.'); return; }
    this.loadUsers();
    this.loadRooms(); // un ban puede expulsar a alguien de una mesa
  },

  // Añadir/eliminar fichas: multiplica +1/-1 por la cantidad pedida.
  async adjustChips(keyEncoded, sign) {
    const key = decodeURIComponent(keyEncoded);
    const raw = typeof prompt === 'function'
      ? prompt((sign > 0 ? 'Añadir fichas a ' : 'Quitar fichas a ') + key + '.\n¿Cuántas?')
      : null;
    if (raw == null) return; // cancelado
    const qty = Math.floor(Number(raw));
    if (!Number.isFinite(qty) || qty <= 0) { this.sayUsers('Cantidad no válida.'); return; }
    const r = await this.post('/api/admin/users/' + encodeURIComponent(key) + '/chips', { delta: sign > 0 ? qty : -qty });
    if (r.status !== 200) { this.sayUsers(r.data.error || 'No se pudieron ajustar las fichas.'); return; }
    this.loadUsers();
  },

  async loadRooms() {
    const el = document.getElementById('admin-rooms');
    const status = document.getElementById('admin-rooms-status');
    if (!el) return;
    try {
      const r = await this.api('/api/admin/rooms');
      if (r.status !== 200) {
        if (status) status.textContent = '⚠️ ' + (r.data.error || 'No se pudieron cargar las salas.');
        return;
      }
      const rooms = r.data.rooms || [];
      if (!rooms.length) {
        el.innerHTML = '<p class="hint">No hay mesas activas ahora mismo.</p>';
        if (status) status.textContent = '';
        return;
      }
      const NAME = { blackjack: '🃏 Blackjack', roulette: '🎡 Ruleta', poker: '♠️ Póker' };
      el.innerHTML = rooms.map(room =>
        '<div class="admin-room">' +
          '<div class="admin-room-head"><b>' + room.code + '</b> · ' + (NAME[room.game] || room.game) +
            ' · Fase: ' + (room.phase || '—') + '</div>' +
          '<ul>' + room.players.map(p =>
            '<li><span class="admin-player-name"></span>' +
              ' <span class="hint">(' + p.playerId + ')</span>' +
              ' · 💰 ' + Number(p.chips || 0).toLocaleString('es-ES') +
              (p.accountKey ? '' : ' <span class="hint">invitado</span>') +
              ' <button class="btn danger" onclick="Admin.kick(\'' + room.code + '\',\'' +
                p.playerId + '\')">Expulsar</button>' +
            '</li>').join('') +
          '</ul>' +
        '</div>').join('');
      const names = el.querySelectorAll('.admin-player-name');
      let i = 0;
      rooms.forEach(rm => rm.players.forEach(p => {
        if (names[i]) names[i].textContent = p.name;
        i++;
      }));
      if (status) status.textContent = 'Se refresca solo cada 5 s · ' +
        rooms.length + (rooms.length === 1 ? ' sala.' : ' salas.');
    } catch (e) {
      if (status) status.textContent = '⚠️ No se pudo conectar con el servidor.';
    }
  },

  async kick(code, playerId) {
    const r = await this.post('/api/admin/rooms/' + code + '/kick', { playerId });
    if (r.status !== 200) { this.sayRooms(r.data.error || 'No se pudo expulsar al jugador.'); return; }
    this.loadRooms();
  },

  sayUsers(text) {
    const el = document.getElementById('admin-users-status');
    if (el) el.textContent = '⚠️ ' + text;
  },

  sayRooms(text) {
    const el = document.getElementById('admin-rooms-status');
    if (el) el.textContent = '⚠️ ' + text;
  },
};