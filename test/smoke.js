// Test de humo de la lógica (sin navegador). Ejecutar con: node test/smoke.js
const fs = require('fs');
const path = require('path');

// --- Stubs mínimos de DOM ---
const fakeEl = () => ({
  textContent: '', innerHTML: '', style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, querySelector() { return null; },
  querySelectorAll() { return []; },
  setAttribute() {}, removeAttribute() {},
});
const elements = {};
global.document = {
  body: { classList: { toggle() {} } },
  getElementById: (id) => (elements[id] = elements[id] || fakeEl()),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
};
global.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; },
};
global.event = { currentTarget: { style: {} } };

// --- Cargar el código del juego ---
const root = path.join(__dirname, '..');
function load(file, exportName) {
  const code = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(`const ${exportName} =`, `global.${exportName} =`);
  new Function(code)();
}
load('js/app.js', 'App');
load('js/split-hands.js', 'SplitHands');
load('js/blackjack.js', 'Blackjack');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name);
  if (!cond) failures++;
}

// --- App ---
App.init();
check('App: fichas iniciales = 1000', App.chips === 1000);
App.takeChips(100);
check('App: descontar 100 -> 900', App.chips === 900);
App.takeChips(99999);
check('App: no deja quedar en negativo', App.chips === 900);
App.giveChips(100);
check('App: recargar -> 1000', App.chips === 1000);

// --- Blackjack: utilidades de render para mesas online (usadas por net.js y poker.js) ---

// handValue / handLabel
check('BJ: A+K = 21', Blackjack.handValue([{ rank: 'A', suit: '♠' }, { rank: 'K', suit: '♥' }]) === 21);
check('BJ: A+A+9 = 21 (as se rebaja)', Blackjack.handValue([{ rank: 'A', suit: '♠' }, { rank: 'A', suit: '♥' }, { rank: '9', suit: '♦' }]) === 21);
check('BJ: J+Q+K = 30', Blackjack.handValue([{ rank: 'J', suit: '♠' }, { rank: 'Q', suit: '♥' }, { rank: 'K', suit: '♦' }]) === 30);
check('BJ: 2+3+5 = 10', Blackjack.handValue([{ rank: '2', suit: '♠' }, { rank: '3', suit: '♥' }, { rank: '5', suit: '♦' }]) === 10);

check('BJ: handLabel vacío = ""', Blackjack.handLabel([]) === '');
check('BJ: handLabel 10+5 = "15"', Blackjack.handLabel([{ rank: '10', suit: '♠' }, { rank: '5', suit: '♥' }]) === '15');
check('BJ: handLabel A+6 = "7 / 17" (as flexible)', Blackjack.handLabel([{ rank: 'A', suit: '♠' }, { rank: '6', suit: '♥' }]) === '7 / 17');
check('BJ: handLabel 10+7 = "17" (sin as flexible)', Blackjack.handLabel([{ rank: '10', suit: '♠' }, { rank: '7', suit: '♥' }]) === '17');

// cardHTML
const redCard = { rank: 'K', suit: '♥' };
const blackCard = { rank: '7', suit: '♠' };
const faceDown = Blackjack.cardHTML(null, true);
check('BJ: cardHTML boca abajo = .face-down', faceDown.includes('face-down') && faceDown.includes('♠'));
check('BJ: cardHTML rojo incluye .red', Blackjack.cardHTML(redCard).includes('red'));
check('BJ: cardHTML negro NO incluye .red', !Blackjack.cardHTML(blackCard).includes('red'));
check('BJ: cardHTML contiene rank', Blackjack.cardHTML(redCard).includes('K'));
check('BJ: cardHTML contiene suit', Blackjack.cardHTML(redCard).includes('♥'));

// withFly
check('BJ: withFly inserta fly-in y animation-delay',
  Blackjack.withFly('<div class="playing-card"></div>', 0.5).includes('fly-in') &&
  Blackjack.withFly('<div class="playing-card"></div>', 0.5).includes('animation-delay:0.50s'));

// splitHTML
const p = {
  splitHands: [
    { hand: [{ rank: '8', suit: '♠' }, { rank: '8', suit: '♥' }], bet: 50, result: '', played: false },
    { hand: [{ rank: '3', suit: '♣' }, { rank: '5', suit: '♦' }], bet: 50, result: '', played: false },
  ],
  activeHand: 0,
};
const counts = {};
const splitHTML = Blackjack.splitHTML(p, true, counts, 'ace');
check('BJ: splitHTML genera contenedor de manos', splitHTML.includes('split-hands'));
check('BJ: splitHTML incluye Mano 1 ◀ Turno', splitHTML.includes('Mano 1 ◀ Turno'));
check('BJ: splitHTML incluye Mano 2', splitHTML.includes('Mano 2'));
check('BJ: splitHTML muestra scores', splitHTML.includes('8 / 16') || splitHTML.includes('16'));
check('BJ: splitHTML contiene apuestas', splitHTML.includes('bet-circle') && splitHTML.includes('>50<'));
check('BJ: splitHTML genera fly-in en cartas nuevas', splitHTML.includes('fly-in'));

// splitHTML: jugador inactivo (no es su turno)
const p2 = {
  splitHands: [
    { hand: [{ rank: '10', suit: '♠' }, { rank: '7', suit: '♥' }], bet: 50, result: '😢', played: true },
  ],
  activeHand: 0,
};
const counts2 = {};
const splitHTML2 = Blackjack.splitHTML(p2, false, counts2, 'folded');
check('BJ: splitHTML jugador retirado NO tiene hand-active', !splitHTML2.includes('hand-active'));
check('BJ: splitHTML jugador retirado muestra resultado', splitHTML2.includes('😢'));

// splitHTML: split incremental (add hand)
// Simula el caso: había 1 mano (counts total = 1, mano 0 = 1 carta),
// ahora el jugador hace split y tiene 2 manos.
const p3 = { splitHands: [
  { hand: [{ rank: '8', suit: '♠' }], bet: 50, result: '', played: false },
  { hand: [{ rank: '3', suit: '♣' }], bet: 50, result: '', played: false },
]};
const counts3 = { 'ace-split-total': 1, 'ace-split-0': 1 };
const splitHTML3 = Blackjack.splitHTML(p3, true, counts3, 'ace');
check('BJ: splitHTML split incremental actualiza counts', counts3['ace-split-total'] === 2 && counts3['ace-split-1'] === 1);
check('BJ: splitHTML split incremental crea nueva mano', splitHTML3.includes('Mano 2'));

// --- Net.leave(): al salir de la mesa, las fichas ganadas/perdidas pasan al saldo ---
load('js/auth.js', 'Auth');
load('js/net.js', 'Net');
let leaveReq = null;
let leaveReply = { ok: true, chips: 1500 };
global.fetch = async (url, opts) => {
  leaveReq = JSON.parse((opts && opts.body) || '{}');
  return { ok: true, status: 200, json: async () => leaveReply };
};

(async () => {
  // Ganas y sales: el saldo local sube, se envía el playerId y el token de la cuenta
  Auth.token = 'tok-123'; Auth.user = null;
  Net.code = 'ABCD'; Net.playerId = 'pid-1';
  leaveReply = { ok: true, chips: 1500 };
  await Net.leave();
  check('Net: al salir, las fichas de la mesa se aplican al saldo (ganas -> 1500)', App.chips === 1500);
  check('Net: el leave envía el token de sesión para guardarlo en la cuenta', leaveReq && leaveReq.token === 'tok-123');
  check('Net: el leave envía el playerId propio', leaveReq && leaveReq.playerId === 'pid-1');
  check('Net: al salir se limpia la sesión de sala', Net.code === null);

  // Pierdes y sales: el saldo local baja
  Net.code = 'EFGH'; Net.playerId = 'pid-2';
  leaveReply = { ok: true, chips: 800 };
  await Net.leave();
  check('Net: al salir tras perder, el saldo baja (pierdes -> 800)', App.chips === 800);

  // La sala ya no existe (expiró): no se pisa el saldo local con null
  Net.code = 'IJKL'; Net.playerId = 'pid-3';
  leaveReply = { ok: true };
  await Net.leave();
  check('Net: si la sala ya no existe no se pisa el saldo', App.chips === 800);

  // Sin cuenta (invitado): el saldo local sí se aplica y no se manda token
  Auth.token = null;
  Net.code = 'MNOP'; Net.playerId = 'pid-4';
  leaveReply = { ok: true, chips: 900 };
  await Net.leave();
  check('Net: invitado: saldo local aplicado sin token', App.chips === 900 && !leaveReq.token);

  if (failures === 0) {
    console.log('\n✅ Smoke test pasado: todas las verificaciones correctas');
  } else {
    console.log('\n❌ Smoke test con ' + failures + ' fallo(s)');
    process.exit(1);
  }
})();
