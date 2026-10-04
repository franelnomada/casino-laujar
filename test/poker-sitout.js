// Ausentarse (sit out) como en PokerStars: quien está ausente sigue pagando
// las ciegas que le toquen y su mano se retira sola cuando le llega el turno.
//   node test/poker-sitout.js
const assert = require('node:assert/strict');
const { PokerRoom } = require('../js/poker-engine.js');
const { TournamentRoom } = require('../js/tournament-engine.js');

const deck = [
  'A♠', 'A♥', 'K♠', 'K♥', '2♦', '3♣', '9♠', 'Q♦', '7♥', 'J♣', '4♠', '8♦',
].map(c => ({ rank: c.slice(0, -1), suit: c.slice(-1) })).reverse();

// ---------- 1. El ausente paga su ciega y se retira solo cuando le toca ----------
{
  const room = new PokerRoom('SITOUT');
  room.addPlayer('ana', 'Ana', 1000);
  room.addPlayer('bob', 'Bob', 1000);
  room.addPlayer('carla', 'Carla', 1000);
  assert.equal(room.action('ana', 'sitout').ok, true);
  assert.equal(room.find('ana').sittingOut, true);

  // Siguiente al reparto: de Ana → Bob (dealer) → Carla (SB) → Ana (BB).
  room.dealerId = 'ana';
  assert.equal(room.start('ana', 1000, deck).ok, true);
  assert.equal(room.bbId, 'ana', 'La ciega grande le toca a la ausente');
  assert.equal(room.find('ana').total, room.bigBlind, 'La ciega grande se le cobra igual');
  assert.equal(room.find('ana').chips, 1000 - room.bigBlind, 'Se le descuenta de verdad');
  assert.equal(room.find('ana').folded, true, 'Su mano se retira sola al llegarle el turno');
  assert.equal(room.find('ana').result, 'Ausente');
  assert.notEqual(room.turnId, 'ana', 'Al ausente nunca le toca decidir');
  assert.equal(room.stateFor('ana').players.find(p => p.id === 'ana').sittingOut, true);

  assert.equal(room.action('ana', 'sitin').ok, true);
  assert.equal(room.find('ana').sittingOut, false);
}

// ---------- 1b. También cuando le toca la ciega pequeña ----------
{
  const room = new PokerRoom('SITOUT-SB');
  room.addPlayer('ana', 'Ana', 1000);
  room.addPlayer('bob', 'Bob', 1000);
  room.addPlayer('carla', 'Carla', 1000);
  room.action('ana', 'sitout');
  // Dealer Carla → SB Ana → BB Bob: esta vez la ciega pequeña es suya.
  room.dealerId = 'bob';
  room.start('ana', 1000, deck);
  assert.equal(room.sbId, 'ana', 'La ciega pequeña le toca a la ausente');
  assert.equal(room.find('ana').total, room.smallBlind, 'La ciega pequeña también se cobra');
  assert.equal(room.find('ana').folded, true);
}

// ---------- 2. Ausentado solo paga la ciega: no puede decidir ni apostar ----------
{
  const room = new PokerRoom('SITOUT-2');
  room.addPlayer('ana', 'Ana', 1000);
  room.addPlayer('bob', 'Bob', 1000);
  room.action('ana', 'sitout');
  room.start('ana', 1000, deck);
  const afterBlind = room.find('ana').total;
  assert.equal(room.action('ana', 'fold').ok, false, 'El ausente no puede actuar');
  assert.equal(room.find('ana').total, afterBlind, 'No se le descuenta nada más');
}

// ---------- 3. Si se ausenta todo el mundo, se vuelve a sentar para repartir ----------
{
  const room = new PokerRoom('SITOUT-3');
  room.addPlayer('ana', 'Ana', 1000);
  room.addPlayer('bob', 'Bob', 1000);
  room.action('ana', 'sitout');
  room.action('bob', 'sitout');
  assert.equal(room.start('ana', 1000, deck).ok, true);
  assert.equal(room.players.every(p => !p.sittingOut), true,
    'Con todos ausentes se reanuda el reparto, como en PokerStars');
}

// ---------- 4. Sin fichas no se puede seguir en la mesa ----------
{
  const room = new PokerRoom('SITOUT-4');
  room.addPlayer('ana', 'Ana', 0);
  const result = room.action('ana', 'sitout');
  assert.equal(result.ok, false);
  assert.match(result.error, /fichas/);
}

// ---------- 5. En torneo la misma regla ----------
{
  const tour = new TournamentRoom('T-SITOUT', {
    maxPlayers: 9, startChips: 10000, smallBlind: 100,
    levelMinutes: 10, maxLevels: 20, minPlayers: 2,
  });
  tour.addPlayer('ana', 'Ana', { buyIn: 500 });
  tour.addPlayer('bob', 'Bob', { buyIn: 500 });
  assert.equal(tour.action('ana', 'sitout').ok, true);
  tour.dealerId = 'ana'; // dealer Bob → SB Bob → BB Ana: la ciega grande es suya
  tour.start(null, 1000, deck);
  assert.equal(tour.bbId, 'ana', 'La ciega grande del torneo le toca a la ausente');
  assert.equal(tour.find('ana').total, tour.bigBlind, 'Las ciegas del torneo se cobran igual');
  assert.equal(tour.find('ana').folded, true, 'Su mano se retira sola');
  assert.equal(tour.find('ana').sittingOut, true, 'El ausente sigue en la mesa del torneo');
  assert.equal(tour.stateFor('ana').players.find(p => p.id === 'ana').sittingOut, true,
    'El cliente de torneo ve quién está ausente');
  assert.equal(tour.action('ana', 'sitin').ok, true);
  assert.equal(tour.find('ana').sittingOut, false);
}

console.log('✅ Ausentarse: se pagan las ciegas igual, la mano se retira sola y se puede volver');