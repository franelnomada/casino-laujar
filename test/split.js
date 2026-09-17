const assert = require('node:assert/strict');
const { BlackjackRoom } = require('../js/bj-engine.js');
const cards = ranks => ranks.map(rank => ({ rank, suit: '♠' }));
const room = new BlackjackRoom('SPLT');
room.addPlayer('left', 'Ana');
room.addPlayer('right', 'Bob');
room.start();
room.bet('left', 50);
room.bet('right', 50);
// Orden de extracción: Bob 8, Ana 10, Bob 8, Ana 7, dealer 10+8, split 2+3.
room.deck = cards(['3', '2', '8', '10', '7', '8', '10', '8']);
room.confirm('left');
room.confirm('right');
assert.equal(room.turnId, 'right');
assert.equal(room.split('right').ok, true);
const p = room.find('right');
assert.equal(p.splitHands.length, 2);
assert.equal(p.chips, 900);
assert.deepEqual(p.splitHands.map(h => h.bet), [50, 50]);
assert.deepEqual(p.splitHands.map(h => h.hand.map(c => c.rank)), [['8', '2'], ['8', '3']]);
assert.equal(p.activeHand, 0);
const dealer = JSON.stringify(room.dealerHand);
room.stand('right');
assert.equal(room.turnId, 'right');
assert.equal(p.activeHand, 1);
assert.equal(p.played, false);
room.stand('right');
assert.equal(room.turnId, 'left');
assert.equal(JSON.stringify(room.dealerHand), dealer);
room.stand('left');
assert.equal(room.phase, 'finished');
assert.equal(p.chips, 900);
assert.deepEqual(p.splitHands.map(h => h.result), ['😢', '😢']);
console.log('✅ Split: dos manos, apuesta adicional y turnos consecutivos');

function fixture(pair = ['8', '8'], draws = ['2', '3']) {
  const r = new BlackjackRoom('MORE');
  r.addPlayer('p', 'Prueba');
  r.phase = 'playing'; r.turnId = 'p'; r.turnOrder = ['p'];
  const p = r.find('p');
  p.hand = cards(pair); p.bet = 50; p.chips = 950;
  r.dealerHand = cards(['10', '8']);
  r.deck = cards([...draws].reverse());
  return r;
}
for (const change of [
  r => { r.find('p').chips = 49; },
  r => { r.find('p').hand = cards(['8', '7']); },
  r => { r.find('p').hand.push(...cards(['8'])); },
  r => { r.turnId = 'other'; },
  r => { r.phase = 'betting'; },
  r => { r.find('p').played = true; },
]) {
  const r = fixture(); change(r);
  const before = JSON.stringify(r);
  assert.equal(r.split('p').ok, false);
  assert.equal(JSON.stringify(r), before);
}
assert.equal(fixture(['K', 'Q']).split('p').ok, false);
assert.equal(fixture(['K', 'K'], ['2', '3']).split('p').ok, true);
console.log('✅ Split: rechaza saldo, rango, número de cartas, fase y turno inválidos sin mutar');
const doubled = fixture();
doubled.split('p');
assert.equal(doubled.split('p').ok, false);
doubled.deck = cards(['10']);
assert.equal(doubled.double('p').ok, true);
assert.equal(doubled.find('p').activeHand, 1);
assert.equal(doubled.find('p').chips, 850);
assert.deepEqual(doubled.find('p').splitHands.map(h => h.bet), [100, 50]);
doubled.deck = cards(['7']);
doubled.hit('p'); // 8+3+7 = 18, empate contra dealer 18.
doubled.stand('p');
assert.equal(doubled.find('p').chips, 1100); // 850 + 200 + 50.
assert.deepEqual(doubled.find('p').splitHands.map(h => h.result), ['🏆', '🤝']);
console.log('✅ Split: doblar y liquidar cada apuesta por separado');
const busted = fixture(['8', '8'], ['10', '2']);
busted.split('p'); busted.deck = cards(['10']); busted.hit('p');
assert.equal(busted.find('p').activeHand, 1);
assert.equal(busted.find('p').splitHands[0].busted, true);
assert.equal(busted.find('p').busted, false);
assert.equal(busted.phase, 'playing');
busted.stand('p');
assert.equal(busted.find('p').chips, 900);
const aces = fixture(['A', 'A'], ['K', '9']);
aces.split('p');
assert.equal(aces.phase, 'finished');
assert.equal(aces.find('p').chips, 1100); // Dos victorias normales, no pago 3:2.
assert.ok(aces.find('p').splitHands.every(h => h.hand.length === 2));
assert.equal(aces.hit('p').ok, false);
assert.equal(aces.double('p').ok, false);
const natural = fixture(['K', 'K'], ['A', 'A']);
natural.split('p');
assert.equal(natural.phase, 'finished');
assert.equal(natural.find('p').chips, 1100);
console.log('✅ Split: pasarse en una mano no termina la otra; ases y 21 pagan 1:1');
const saved = fixture(); saved.split('p');
const restored = Object.assign(new BlackjackRoom('MORE'), JSON.parse(JSON.stringify(saved)));
restored.deck = cards(['4']); restored.hit('p');
assert.equal(restored.stateFor('p').players[0].splitHands[0].hand.length, 3);
restored.stand('p'); restored.stand('p');
restored.start();
assert.equal(restored.find('p').splitHands, undefined);
assert.equal(restored.find('p').activeHand, undefined);
console.log('✅ Split: restauración JSON y limpieza de la siguiente ronda');

const resplit = fixture(['8', '8'], ['8', '3', '2', '4']);
assert.equal(resplit.split('p').ok, true);
assert.equal(resplit.stateFor('p').players[0].canSplit, true);
assert.equal(resplit.split('p').ok, true);
const rp = resplit.find('p');
assert.equal(rp.chips, 850);
assert.deepEqual(rp.splitHands.map(h => h.bet), [50, 50, 50]);
assert.deepEqual(rp.splitHands.map(h => h.hand.map(c => c.rank)), [['8', '2'], ['8', '4'], ['8', '3']]);
for (let i = 0; i < 3; i++) {
  assert.equal(rp.activeHand, i);
  assert.equal(resplit.turnId, 'p');
  assert.equal(resplit.stand('p').ok, true);
}
assert.equal(resplit.phase, 'finished');
assert.equal(rp.chips, 850);
console.log('✅ Redivisión: tres manos, tres apuestas y turnos en orden');

// Cuatro manos: aún queda pareja, pero no se permite una quinta apuesta.
const capped = fixture(['8', '8'], ['8', '8', '8', '8', '8', '8']);
for (let n = 2; n <= 4; n++) {
  assert.equal(capped.stateFor('p').players[0].canSplit, true);
  assert.equal(capped.split('p').ok, true);
  assert.equal(capped.find('p').splitHands.length, n);
  assert.equal(capped.find('p').chips, 1000 - n * 50);
}
assert.equal(capped.stateFor('p').players[0].canSplit, false);
const beforeFifth = JSON.stringify(capped);
assert.equal(capped.split('p').ok, false);
assert.equal(JSON.stringify(capped), beforeFifth);
for (let i = 0; i < 4; i++) {
  assert.equal(capped.find('p').activeHand, i);
  assert.equal(capped.stand('p').ok, true);
}
assert.equal(capped.phase, 'finished');
assert.equal(capped.find('p').chips, 800);
console.log('✅ Redivisión: máximo cuatro manos, quinta rechazada sin cambios');

