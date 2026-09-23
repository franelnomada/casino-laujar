// ==============================
//  Casino Night — app core
// ==============================
const App = {
  CHIPS_KEY: 'casino-night-chips',

  init() {
    this.loadChips();
    this.show('welcome');
  },

  loadChips() {
    const raw = localStorage.getItem(this.CHIPS_KEY);
    this.chips = raw !== null ? parseInt(raw, 10) : 1000;
    this.updateChips();
  },

  saveChips() {
    localStorage.setItem(this.CHIPS_KEY, String(this.chips));
  },

  updateChips() {
    document.getElementById('chips-amount').textContent =
      this.chips.toLocaleString('es-ES');
    this.saveChips();
    // Con cuenta abierta, las fichas también se guardan en el servidor
    if (typeof Auth !== 'undefined') Auth.chipsChanged(this.chips);
  },

  // Devuelve true si se pudo descontar
  takeChips(amount) {
    if (this.chips < amount) return false;
    this.chips -= amount;
    this.updateChips();
    return true;
  },

  giveChips(amount) {
    this.chips += amount;
    this.updateChips();
  },

  checkBankrupt() {
    if (this.chips < 5) {
      document.getElementById('reload-modal').classList.remove('hidden');
    }
  },

  reloadChips() {
    this.chips += 1000;
    this.updateChips();
    document.getElementById('reload-modal').classList.add('hidden');
  },

  show(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    const el = document.getElementById('screen-' + screen);
    if (el) el.classList.remove('hidden');
    document.body.classList.toggle('at-welcome', screen === 'welcome');
    if (typeof Betting !== 'undefined' && screen === 'lobby') Betting.refresh();
    if (screen !== 'room') {
      document.body.classList.toggle('in-poker-room', false);
      document.body.classList.toggle('in-blackjack-room', false);
    }
  },

  goLobby() {
    this.show('lobby');
  }
};
