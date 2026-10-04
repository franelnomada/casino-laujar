// ============================================================
//  Avisos de mesa: sonido y vibración, al estilo de PokerStars.
//  Los sonidos se generan con Web Audio (sin ficheros de audio que
//  cargar). En iPhone/iPad el navegador NO tiene API de vibración,
//  así que ahí el aviso es solo sonoro; en Android vibra también.
// ============================================================
const GameAlerts = {
  enabled: true,
  ctx: null,
  KEY: 'lf-sonido',

  // Patrón de vibración por aviso (ms). Corto y seco, como el de PokerStars.
  VIBRATION: {
    turn: [90, 60, 90],
    action: [40],
    allin: [140, 50, 140],
    win: [60, 40, 60, 40, 120],
    deal: [25],
  },

  init() {
    try {
      const saved = localStorage.getItem(this.KEY);
      if (saved !== null) this.enabled = saved === '1';
    } catch (e) { /* modo privado: se queda activado */ }
    this.applyLabel();
    // Los navegadores no dejan sonar nada hasta que el usuario toca algo:
    // en el primer gesto se abre el audio (queda listo para después).
    const unlock = () => {
      this.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
  },

  applyLabel() {
    const button = document.getElementById('sound-toggle');
    if (!button) return;
    button.textContent = this.enabled ? '🔊' : '🔇';
    button.setAttribute('aria-pressed', this.enabled ? 'true' : 'false');
    button.title = this.enabled ? 'Sonido y vibración activados (toca para silenciar)' : 'Silenciado (toca para activar)';
    button.setAttribute('aria-label', button.title);
  },

  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem(this.KEY, this.enabled ? '1' : '0'); } catch (e) { /* sin memoria */ }
    this.applyLabel();
    if (this.enabled) this.unlock();
    return this.enabled;
  },

  // Abre (o reanuda) el contexto de audio. Necesario tras cualquier gesto.
  unlock() {
    if (!this.enabled) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this.ctx) this.ctx = new Ctx();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { /* sin audio disponible */ }
  },

  // Una nota: frecuencia en Hz, duración en segundos y volumen 0..1.
  note(frequency, duration = 0.12, volume = 0.16, type = 'sine', delay = 0) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const start = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    // Ataque y caída suaves: el tono no cruje.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  },

  // Aviso por nombre. Cada uno tiene su "melodía" corta.
  play(name) {
    if (!this.enabled) return;
    this.unlock();
    this.vibrate(name);
    switch (name) {
      case 'turn': // el clásico "ding" de turno: dos notas ascendentes
        this.note(880, 0.1, 0.18);
        this.note(1320, 0.14, 0.16, 'sine', 0.09);
        break;
      case 'deal':
        this.note(520, 0.06, 0.1, 'triangle');
        break;
      case 'call':
        this.note(660, 0.07, 0.12, 'triangle');
        break;
      case 'raise': // subida: nota que trepa
        this.note(560, 0.08, 0.14, 'square');
        this.note(840, 0.1, 0.13, 'square', 0.07);
        break;
      case 'allin':
        this.note(320, 0.12, 0.18, 'sawtooth');
        this.note(640, 0.14, 0.16, 'sawtooth', 0.1);
        this.note(960, 0.18, 0.14, 'square', 0.22);
        break;
      case 'fold':
        this.note(420, 0.12, 0.11, 'sine');
        this.note(260, 0.18, 0.1, 'sine', 0.1);
        break;
      case 'win': // victoria: arpegio mayor
        [523, 659, 784, 1047].forEach((f, i) => this.note(f, 0.16, 0.16, 'triangle', i * 0.09));
        break;
      case 'lose':
        [523, 440, 349].forEach((f, i) => this.note(f, 0.2, 0.13, 'sine', i * 0.12));
        break;
      default:
        this.note(660, 0.1, 0.12);
    }
  },

  // En iPhone no existe navigator.vibrate: el aviso queda solo en el sonido.
  vibrate(name) {
    const pattern = this.VIBRATION[name];
    if (!pattern || !this.enabled) return;
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) { /* sin vibración */ }
  },

  // ¿Puede este dispositivo vibrar? Sirve para explanatory en la interfaz.
  canVibrate() { return typeof navigator !== 'undefined' && !!navigator.vibrate; },
};