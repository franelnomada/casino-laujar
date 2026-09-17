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
load('js/blackjack.js', 'Blackjack');
load('js/roulette.js', 'Roulette');

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

// --- Blackjack (mesa multijugador) ---
check('BJ: valor de mano con as como 11+10 = 21',
  Blackjack.handValue([{ rank: 'A', suit: '♠' }, { rank: 'K', suit: '♥' }]) === 21);
check('BJ: as se rebaja a 1 al pasarse (A+A+9 = 21)',
  Blackjack.handValue([{ rank: 'A', suit: '♠' }, { rank: 'A', suit: '♥' }, { rank: '9', suit: '♦' }]) === 21);
check('BJ: J,Q,K valen 10',
  Blackjack.handValue([{ rank: 'J', suit: '♠' }, { rank: 'Q', suit: '♥' }, { rank: 'K', suit: '♦' }]) === 30);

// Mesa con 2 jugadores (Ana y Bob)
Blackjack.players = [
  { name: 'Ana', chips: 1000, bet: 0, hand: [], result: '', played: false, busted: false, doubled: false },
  { name: 'Bob', chips: 1000, bet: 0, hand: [], result: '', played: false, busted: false, doubled: false },
];
Blackjack.startGame();
check('BJ: apuestas empezando por el asiento más a la derecha', Blackjack.phase === 'betting' && Blackjack.current === 1);
Blackjack.addBet(50);
check('BJ: Bob (derecha) apuesta 50 primero', Blackjack.players[1].bet === 50 && Blackjack.players[1].chips === 950);
Blackjack.confirmBet();
check('BJ: el turno pasa a Ana hacia la izquierda', Blackjack.current === 0);
Blackjack.addBet(50);
check('BJ: Ana apuesta 50', Blackjack.players[0].bet === 50 && Blackjack.players[0].chips === 950);
Blackjack.confirmBet();
check('BJ: al confirmar todos se reparte', Blackjack.dealerHand.length === 2 && Blackjack.players[0].hand.length === 2 && Blackjack.players[1].hand.length === 2);
check('BJ: primera mano para el asiento derecho', Blackjack.current === 1);

// Normalizamos el estado tras el reparto aleatorio (evita BJ natural de la suerte)
Blackjack.phase = 'playing';
Blackjack.current = 0;
Blackjack.players[0].chips = 950;
Blackjack.players[1].chips = 950;
Blackjack.players[0].result = '';
Blackjack.players[1].result = '';
Blackjack.players[0].busted = false;
Blackjack.players[1].busted = false;
Blackjack.players[0].played = false;
Blackjack.players[1].played = false;

// Ronda determinista: Ana 20 gana al dealer 19; Bob 19 empata
Blackjack.players[0].hand = [{ rank: '10', suit: '♠' }, { rank: 'Q', suit: '♥' }];
Blackjack.players[1].hand = [{ rank: '10', suit: '♦' }, { rank: '9', suit: '♣' }];
Blackjack.dealerHand = [{ rank: '10', suit: '♦' }, { rank: '9', suit: '♣' }];
Blackjack.current = 0;
Blackjack.stand();
check('BJ: ronda liquidada tras plantarse', Blackjack.phase === 'finished');
check('BJ: Ana gana +50 (cobra el doble)', Blackjack.players[0].chips === 1050 && Blackjack.players[0].result.includes('🏆'));
check('BJ: Bob empata con 19 y recupera apuesta', Blackjack.players[1].chips === 1000 && Blackjack.players[1].result.includes('🤝'));

// Blackjack natural paga 3:2 con dos jugadores en mesa
Blackjack.nextRound();
const ana = Blackjack.players[0];
const bob = Blackjack.players[1];
ana.chips = 1000; bob.chips = 1000;
ana.bet = 50; ana.chips -= 50;
bob.bet = 25; bob.chips -= 25;
Blackjack.deck = []; // sin cartas sobrantes: el dealer (19) no roba
Blackjack.dealerHand = [{ rank: '10', suit: '♦' }, { rank: '9', suit: '♣' }];
ana.hand = [{ rank: 'A', suit: '♥' }, { rank: 'K', suit: '♥' }];
bob.hand = [{ rank: '10', suit: '♠' }, { rank: '9', suit: '♣' }];
ana.played = false; bob.played = false;
ana.busted = false; bob.busted = false;
Blackjack.phase = 'playing';
Blackjack.current = 1;
Blackjack.stand();
check('BJ: tras Bob le toca a Ana (hacia la izquierda)', Blackjack.current === 0 && Blackjack.phase === 'playing');
Blackjack.stand();
check('BJ: Ana cobra blackjack 3:2 (950+125 = 1075)', ana.chips === 1075 && ana.result.includes('🎉'));
check('BJ: Bob empata con 19 y recupera apuesta', bob.chips === 1000 && bob.result.includes('🤝'));

// Pasarse al pedir carta
Blackjack.nextRound();
ana.chips = 1000;
ana.bet = 10; ana.chips -= 10;
bob.bet = 0; bob.played = true;
Blackjack.dealerHand = [{ rank: '10', suit: '♦' }, { rank: '9', suit: '♣' }];
ana.hand = [{ rank: 'K', suit: '♠' }, { rank: 'Q', suit: '♠' }];
Blackjack.deck = [{ rank: 'K', suit: '♥' }];
ana.played = false;
Blackjack.phase = 'playing';
Blackjack.current = 0;
Blackjack.hit();
check('BJ: pasarse de 21 pierde la apuesta', ana.chips === 990 && ana.busted === true && Blackjack.phase === 'finished');

// --- Ruleta ---
const R = Roulette.payoutFor.bind(Roulette);
check('Ruleta: pleno 17 con 10 paga 360', R('n17', 17, 10) === 360);
check('Ruleta: pleno falla devuelve 0', R('n17', 18, 10) === 0);
check('Ruleta: rojo gana 1:1', R('red', 32, 10) === 20);
check('Ruleta: negro gana 1:1', R('black', 26, 10) === 20);
check('Ruleta: par gana', R('even', 12, 10) === 20);
check('Ruleta: impar gana', R('odd', 9, 10) === 20);
check('Ruleta: con 0 pierden las apuestas simples', R('red', 0, 10) === 0 && R('even', 0, 10) === 0);
check('Ruleta: docena 2 gana 2:1 (n=20)', R('dozen2', 20, 10) === 30);
check('Ruleta: columna 1 gana con n=7', R('col1', 7, 10) === 30);
check('Ruleta: columna 3 gana con n=36', R('col3', 36, 10) === 30);
check('Ruleta: alto/bajo', R('high', 25, 10) === 20 && R('low', 5, 10) === 20);

// Mesa y apuestas
Roulette.buildTable();
const tableHTML = document.getElementById('roulette-table').innerHTML;
check('Ruleta: la mesa genera plenos y externas',
  tableHTML.includes('data-bet="n36"') && tableHTML.includes('data-bet="red"'));
Roulette.setChip(100);
const chipsR = App.chips;
Roulette.placeBet('red');
check('Ruleta: apuesta de 100 fichas al rojo', Roulette.bets.red === 100 && App.chips === chipsR - 100);
Roulette.clearBets();
check('Ruleta: limpiar devuelve las fichas', App.chips === chipsR && Object.keys(Roulette.bets).length === 0);

// Simulación de giros: verificar estadística y que no rompe
let totalChips = App.chips;
for (let i = 0; i < 200; i++) {
  Roulette.placeBet('red');
  const n = Math.floor(Math.random() * 37);
  totalChips = App.chips;
  Roulette.resolve(n);
}
check('Ruleta: 200 giros ejecutados sin errores y con fichas >= 0', App.chips >= 0);

console.log(failures === 0 ? '\n🎉 Todos los tests pasan' : `\n💥 ${failures} test(s) fallidos`);
process.exit(failures === 0 ? 0 : 1);
