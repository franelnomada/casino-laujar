// ============================================================
//  Avisos cuando la app no está a la vista (móvil bloqueado o en
//  segundo plano). Aquí no valen ni el sonido de Web Audio ni
//  navigator.vibrate: hacen falta notificaciones push, que Chrome,
//  Firefox y Safari 16.4+ sí soportan.
//
//  El aviso normal (sonido + vibración) lo pone GameAlerts.
// ============================================================
const PushAlerts = {
  registration: null,
  key: '',
  busy: false,
  state: 'idle', // idle | unsupported | denied | off | on | error

  supported() {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
      && 'Notification' in window;
  },

  async init() {
    const button = document.getElementById('push-toggle');
    if (!this.supported()) {
      this.state = 'unsupported';
      if (button) { button.disabled = true; button.textContent = '🔕'; button.title = 'Este navegador no admite avisos'; }
      return;
    }
    // Si el permiso ya está concedido, se reactiva solo sin molestar.
    if (Notification.permission === 'granted') this.subscribe();
    this.applyLabel();
  },

  applyLabel() {
    const button = document.getElementById('push-toggle');
    if (!button) return;
    const on = this.state === 'on';
    const denied = this.state === 'denied';
    button.textContent = on ? '🔔' : '🔕';
    button.disabled = denied;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.title = on ? 'Avisos activados: te avisa aunque bloquees el móvil (toca para quitar)'
      : denied ? 'Los avisos están bloqueados en los ajustes del navegador'
      : 'Activar avisos cuando te toque el turno (toca para activar)';
    button.setAttribute('aria-label', button.title);
  },

  async toggle() {
    if (this.busy) return this.state;
    this.busy = true;
    try {
      if (this.state === 'on') {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg && reg.pushManager.getSubscription();
        if (sub) await this.send('/api/push/unsubscribe', { endpoint: sub.endpoint });
        if (reg) await reg.pushManager.unsubscribe();
        this.state = 'off';
      } else {
        await this.subscribe();
      }
    } catch (e) {
      this.state = 'error';
    } finally {
      this.busy = false;
      this.applyLabel();
    }
    return this.state;
  },

  async send(path, body) {
    try {
      await fetch(path, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, this.authHeaders()),
        body: JSON.stringify(body),
      });
    } catch (e) { /* sin conexión: el aviso simplemente no se registra */ }
  },

  authHeaders() {
    if (typeof Auth !== 'undefined' && Auth.token) return { Authorization: 'Bearer ' + Auth.token };
    return {};
  },

  async subscribe() {
    if (!this.supported()) { this.state = 'unsupported'; return; }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      this.state = 'denied';
      return;
    }
    // La clave pública la da el servidor (debe coincidir con su par privada).
    if (!this.key) {
      try {
        const r = await fetch('/api/push/key');
        this.key = (await r.json()).publicKey || '';
      } catch (e) { this.key = ''; }
    }
    if (!this.key) { this.state = 'error'; return; }
    this.registration = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const sub = await this.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.base64ToBytes(this.key),
    });
    const name = (typeof Auth !== 'undefined' && Auth.user && Auth.user.name)
      || (document.getElementById('net-name') || {}).value || '';
    await this.send('/api/push/subscribe', {
      subscription: sub.toJSON(),
      name: String(name).slice(0, 12),
      playerId: (typeof Net !== 'undefined' && Net.playerId) || '',
      game: (typeof Net !== 'undefined' && Net.state && Net.state.game) || '',
      room: (typeof Net !== 'undefined' && (Net.code || (Net.table && Net.table.id))) || '',
    });
    this.state = 'on';
  },

  base64ToBytes(base64) {
    const raw = atob((base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  },
};