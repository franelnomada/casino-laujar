// Prueba mínima determinista: node test/poker-heads-up.js
const assert = require('node:assert/strict');
const { PokerRoom } = require('../js/poker-engine.js');

// Extracción: Bob, Ana, Bob, Ana; quemada, flop; quemada, turn; quemada, river.
// Ana: AA. Bob: KK. Mesa: 2, 7, 9, J, 3 sin color ni escalera.
const deck = ['K♠', 'A♠', 'K♥', 'A♥', '4♣', '2♣', '7♦', '9♥', '5♣', 'J♠', '6♦', '3♦']
  .map(c => ({ rank: c.slice(0, -1), suit: c.slice(-1) })).reverse();
const room = new PokerRoom('HEAD');
assert.equal(room.addPlayer('ana', 'Ana').ok, true);
assert.equal(room.addPlayer('bob', 'Bob').ok, true);
assert.equal(room.start('ana', 1000, deck).ok, true);
assert.equal(room.dealerId, 'ana');
assert.equal(room.sbId, 'ana');
assert.equal(room.bbId, 'bob');
assert.deepEqual(room.find('ana').hand.map(c => c.rank), ['A', 'A']);
assert.deepEqual(room.find('bob').hand.map(c => c.rank), ['K', 'K']);

function act(id, type) {
  assert.equal(room.turnId, id, 'Turno esperado antes de ' + type);
  let result;
  assert.doesNotThrow(() => { result = room.action(id, type, null, room.visualUntil + 1); });
  assert.equal(result.ok, true, result.error);
}
act('ana', 'call');
act('bob', 'check');
assert.equal(room.phase, 'flop');
assert.equal(room.board.length, 3);
for (const nextPhase of ['turn', 'river', 'finished']) {
  act('bob', 'check');
  act('ana', 'check');
  assert.equal(room.phase, nextPhase);
}
assert.deepEqual(room.board.map(c => c.rank), ['2', '7', '9', 'J', '3']);
assert.equal(room.turnId, null);
assert.deepEqual(room.pots, [{ amount: 40, winners: ['ana'], refund: false }]);
assert.equal(room.find('ana').chips, 1020);
assert.equal(room.find('bob').chips, 980);
assert.equal(room.players.reduce((sum, p) => sum + p.chips, 0), 2000);
assert.equal(room.deck.length, 0);
console.log('✅ Heads-up determinista: preflop → flop → turn → river → showdown, sin excepciones ni acciones rechazadas.');
console.log('✅ Ana gana con AA frente a KK: bote 40, saldos 1020 / 980; se conservan las 2000 fichas.');
