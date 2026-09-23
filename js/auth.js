// ==============================================
//  Casino Night — cuentas (registro, sesión, fichas)
//  Invitado por defecto: sin cuenta todo funciona igual,
//  pero el nombre y las fichas solo viven en este móvil.
// ==============================================
const Auth = {
  KEY: 'casino-night-auth-token',
  user: null,
  token: null,
  mode: 'login',
  busyNow: false,
  _applyChips: false,
  _chipsTimer: null,
  board: [],
  boardStamp: 0,
  boardBusy: false,

  init() {
    const form = document.getElementById('auth-form');
    if (form) form.addEventListener('submit', (e) => this.submit(e));
    try { this.token = localStorage.getItem(this.KEY) || null; } catch (e) { this.token = null; }
    this.render();
    if (this.token) this.restore();
    this.loadLeaderboard();
  },

  // ---------- Sesión ----------
  async restore() {
    try {
      const data = await this.request('/api/auth/me');
      if (data && data.user) this.applyUser(data.user);
    } catch (e) { /* servidor caído o sesión caducada: seguimos como invitado */ }
  },

  async request(url, body) {
    const headers = {};
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const options = { headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.method = 'POST';
      options.body = JSON.stringify(body);
    }
    const r = await fetch(url, options);
    let data = {};
    try { data = await r.json(); } catch (e) { data = {}; }
    if (!r.ok) {
      // Token caducado o de otro servidor (Render reiniciado): volvemos a invitado
      if (r.status === 401 && url !== '/api/auth/login' && url !== '/api/auth/register') this.forget();
      throw new Error(data.error || 'No se pudo conectar con el servidor.');
    }
    return data;
  },

  async submit(event) {
    if (event) event.preventDefault();
    if (this.busyNow) return;
    const nameInput = document.getElementById('auth-name');
    const passInput = document.getElementById('auth-password');
    const passRepeat = document.getElementById('auth-password2');
    const name = nameInput ? nameInput.value.trim() : '';
    const password = passInput ? passInput.value : '';
    const register = this.mode === 'register';
    if (!name || !password) return this.say('Escribe tu nombre y tu contraseña.', true);
    if (register && password !== (passRepeat ? passRepeat.value : '')) {
      return this.say('Las contraseñas no coinciden.', true);
    }

    this.setBusy(true);
    try {
      const body = { name, password };
      if (register) body.chips = App.chips; // al crear la cuenta se lleva las fichas de este móvil
      const data = await this.request(register ? '/api/auth/register' : '/api/auth/login', body);
      this.token = data.token;
      try { localStorage.setItem(this.KEY, this.token); } catch (e) { /* modo privado */ }
      if (passInput) passInput.value = '';
      if (passRepeat) passRepeat.value = '';
      this.applyUser(data.user);
      this.say(register
        ? '🎉 Cuenta creada. ¡A jugar, ' + data.user.name + '!'
        : '👋 Hola de nuevo, ' + data.user.name + '.', false);
    } catch (e) {
      this.say('⚠️ ' + e.message, true);
    } finally {
      this.setBusy(false);
    }
  },

  async logout() {
    const had = !!this.token;
    try { if (had) await this.request('/api/auth/logout', {}); } catch (e) { /* igualmente salimos */ }
    this.forget();
    this.say(had ? 'Sesión cerrada. Sigues jugando como invitado.' : '', false);
  },

  forget() {
    this.token = null;
    this.user = null;
    try { localStorage.removeItem(this.KEY); } catch (e) { /* da igual */ }
    this.render();
    this.highlightBoard();
    if (typeof Betting !== 'undefined') Betting.sessionChanged();
  },

  applyUser(user) {
    this.user = user || null;
    clearTimeout(this._chipsTimer);
    this._chipsTimer = null;
    if (this.user && typeof this.user.chips === 'number' && this.user.chips >= 0) {
      this._applyChips = true;
      App.chips = this.user.chips;
      App.updateChips();
      this._applyChips = false;
    }
    if (this.user) this.prefillNames(this.user.name);
    this.render();
    this.loadLeaderboard();
    this.highlightBoard();
    if (typeof Betting !== 'undefined') Betting.sessionChanged();
  },

  // El nombre de la cuenta ahorra escribirlo en cada mesa
  prefillNames(name) {
    ['net-name', 'bj-name-input'].forEach((id) => {
      const input = document.getElementById(id);
      if (input && !String(input.value).trim()) input.value = name;
    });
  },

  // El ranking se pinta sin pedirlo al servidor al entrar/salir: basta resaltar la fila
  highlightBoard() {
    const list = document.getElementById('rank-list');
    if (!list || !list.children.length) return;
    const me = this.user ? this.user.name.toLowerCase() : null;
    [...list.children].forEach((li) => {
      const name = li.querySelector('.rank-name');
      const isMe = !!me && !!name && name.textContent.toLowerCase() === me;
      li.classList.toggle('me', isMe);
      let tag = li.querySelector('.rank-you');
      if (isMe && !tag) {
        tag = document.createElement('span');
        tag.className = 'rank-you';
        tag.textContent = 'tú';
        li.appendChild(tag);
      } else if (!isMe && tag) tag.remove();
    });
  },

  // ---------- Fichas: se guardan en la cuenta (con retardo, sin spamear) ----------
  chipsChanged(chips) {
    if (!this.user || !this.token || this._applyChips) return;
    clearTimeout(this._chipsTimer);
    this._chipsTimer = setTimeout(() => this.saveChips(chips), 1200);
  },

  async saveChips(chips) {
    if (!this.user || !this.token) return;
    try {
      const data = await this.request('/api/auth/chips', { chips });
      if (data && data.user) {
        this.user = data.user;
        this.render();
        this.loadLeaderboard();
      }
    } catch (e) { /* sin conexión: se reintenta al siguiente cambio de fichas */ }
  },

  // ---------- Ranking público del lobby ----------
  async loadLeaderboard(force) {
    const list = document.getElementById('rank-list');
    const status = document.getElementById('rank-status');
    if (!list || !status) return;
    if (this.boardBusy && !force) return;
    this.boardBusy = true;
    const stamp = ++this.boardStamp;
    status.textContent = this.board.length ? '' : 'Cargando clasificación…';
    try {
      const r = await fetch('/api/auth/leaderboard?limit=10');
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      if (stamp !== this.boardStamp) return;
      this.board = Array.isArray(data.players) ? data.players : [];
      this.renderBoard();
    } catch (e) {
      if (stamp !== this.boardStamp) return;
      // Sin servidor (file:// o caído): no rompemos el lobby
      if (!this.board.length) status.textContent = 'Clasificación no disponible sin conexión al servidor.';
    } finally {
      if (stamp === this.boardStamp) this.boardBusy = false;
    }
  },

  renderBoard() {
    const list = document.getElementById('rank-list');
    const status = document.getElementById('rank-status');
    if (!list || !status) return;
    const medals = ['🥇', '🥈', '🥉'];
    const me = this.user ? this.user.name.toLowerCase() : null;
    list.innerHTML = '';
    this.board.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'rank-row' + (me && String(p.name).toLowerCase() === me ? ' me' : '');
      li.innerHTML = '<span class="rank-pos">' + (medals[i] || (i + 1) + 'º') + '</span>' +
        '<span class="rank-name"></span>' +
        '<span class="rank-chips">💰 ' + Number(p.chips || 0).toLocaleString('es-ES') + '</span>' +
        (me && String(p.name).toLowerCase() === me ? '<span class="rank-you">tú</span>' : '');
      li.querySelector('.rank-name').textContent = p.name;
      list.appendChild(li);
    });
    status.textContent = this.board.length
      ? 'Solo cuentas registradas. Juega con tu cuenta para aparecer aquí.'
      : 'Aún no hay cuentas. ¡Crea la primera y lidera la tabla!';
  },

  // ---------- Interfaz ----------
  showForm(mode) {
    this.mode = mode === 'register' ? 'register' : 'login';
    this.applyMode();
    const input = document.getElementById('auth-name');
    if (input) input.focus();
  },

  applyMode() {
    const register = this.mode === 'register';
    const tabLogin = document.getElementById('auth-tab-login');
    const tabRegister = document.getElementById('auth-tab-register');
    if (tabLogin) tabLogin.classList.toggle('active', !register);
    if (tabRegister) tabRegister.classList.toggle('active', register);
    const repeat = document.getElementById('auth-password2');
    if (repeat) {
      repeat.classList.toggle('hidden', !register);
      repeat.required = register;
    }
    const submit = document.getElementById('auth-submit');
    if (submit) submit.textContent = register ? 'Crear cuenta 🎉' : 'Entrar';
    const pass = document.getElementById('auth-password');
    if (pass) pass.autocomplete = register ? 'new-password' : 'current-password';
  },

  say(text, error) {
    const el = document.getElementById('auth-message');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', !!error);
  },

  setBusy(on) {
    this.busyNow = on;
    const submit = document.getElementById('auth-submit');
    if (submit) submit.disabled = on;
  },

  render() {
    const user = this.user;
    const guestBlock = document.getElementById('auth-guest-block');
    const userBlock = document.getElementById('auth-user-block');
    if (guestBlock) guestBlock.classList.toggle('hidden', !!user);
    if (userBlock) userBlock.classList.toggle('hidden', !user);
    const welcomeName = document.getElementById('auth-user-name');
    if (welcomeName) welcomeName.textContent = user ? user.name : '';
    const accountName = document.getElementById('account-name');
    if (accountName) accountName.textContent = user ? user.name : '';
    const accountChips = document.getElementById('account-chips');
    if (accountChips) accountChips.textContent = user ? user.chips.toLocaleString('es-ES') : '0';
    const topbar = document.getElementById('auth-topbar');
    if (topbar) {
      topbar.textContent = user ? '👤 ' + user.name : '👤 Invitado';
      topbar.title = user ? 'Mi cuenta' : 'Entrar o crear cuenta';
    }
    const guestAcc = document.getElementById('account-guest');
    const userAcc = document.getElementById('account-user');
    if (guestAcc) guestAcc.classList.toggle('hidden', !!user);
    if (userAcc) userAcc.classList.toggle('hidden', !user);
    const adminBtn = document.getElementById('account-admin');
    if (adminBtn) adminBtn.classList.toggle('hidden', !(user && user.isAdmin));
    this.applyMode();
  },

  openPanel() {
    const modal = document.getElementById('account-modal');
    if (modal) modal.classList.remove('hidden');
    this.render();
  },

  closePanel() {
    const modal = document.getElementById('account-modal');
    if (modal) modal.classList.add('hidden');
  },

  openWelcome() {
    this.closePanel();
    App.show('welcome');
    this.showForm('login');
  },
};
