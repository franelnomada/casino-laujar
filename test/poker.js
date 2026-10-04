const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PokerRoom, buildDeck, evaluate, bestFive, compare, handLabel } = require('../js/poker-engine');
const cards = s => s.split(' ').map(x => ({rank:x.slice(0,-1),suit:x.slice(-1)}));
const r = new PokerRoom('TEST');
r.addPlayer('a','Ana');r.addPlayer('b','Bob');r.addPlayer('c','Cris');
assert.equal(r.start('b',1000).ok,false);
assert.equal(r.start('a',1000,buildDeck()).ok,true);
assert.equal(r.dealerId,'a');assert.equal(r.sbId,'b');assert.equal(r.bbId,'c');assert.equal(r.turnId,'a');
assert.equal(r.find('b').chips,990);assert.equal(r.find('c').chips,980);
assert.equal(r.action('a','call',null,1001).ok,false);
assert.deepEqual(r.events.map(e=>e.target),['b','c','a','b','c','a']);
assert.deepEqual(r.stateFor('a').players[1].cards,[null,null]);
const act = (type,amount) => { assert.equal(r.action(r.turnId,type,amount,r.visualUntil+1).ok,true); };
act('raise',60);act('call');act('call');assert.equal(r.phase,'flop');assert.equal(r.board.length,3);assert.equal(r.turnId,'b');
for(const phase of ['turn','river','finished']) { act('check');act('check');act('check');assert.equal(r.phase,phase); }
assert.equal(r.players.reduce((n,p)=>n+p.chips,0),3000);
assert.equal(r.board.length,5);assert.equal(new Set([...r.board,...r.players.flatMap(p=>p.hand)].map(c=>c.rank+c.suit)).size,11);
const shown=r.stateFor('a',r.visualUntil+1);const shownWinner=shown.players.find(p=>p.id===r.pots[0].winners[0]);
const available=new Set([...r.board,...r.players.flatMap(p=>p.hand)].map(c=>c.rank+c.suit));
assert.equal(shownWinner.bestHand.length,5,'El showdown expone cinco cartas ganadoras');
assert.ok(shownWinner.bestHand.every(c=>available.has(c.rank+c.suit)),'Las cartas ganadoras pertenecen a la mano');
assert.ok(shownWinner.handName,'El ganador recibe el nombre de su combinación');
assert.equal(r.start('a',601001).ok,true);assert.equal(r.smallBlind,20);assert.equal(r.dealerId,'b');
// Avisos de mesa: cada aviso tiene su sonido y su patrón de vibración.
const soundsSrc = fs.readFileSync(path.join(__dirname,'..','js','sounds.js'),'utf8');
assert.match(soundsSrc,/const GameAlerts/,'El módulo de avisos de mesa existe');
for (const name of ['turn','deal','call','raise','allin','fold','win','lose']) {
  assert.ok(soundsSrc.includes("case '" + name + "':"), 'El aviso "' + name + '" tiene su sonido');
}
// Los avisos con vibración propia: turno, todo-in, victoria y reparto.
for (const name of ['turn','allin','win','deal']) {
  assert.ok(new RegExp(name + ':\\s*\\[').test(soundsSrc), 'El aviso "' + name + '" tiene su vibración');
}
// En iPhone no hay API de vibración: el código lo contempla y no falla sin ella.
assert.match(soundsSrc,/if \(navigator\.vibrate\)/,'La vibración solo se usa si el dispositivo la tiene');
assert.match(soundsSrc,/AudioContext/,'El audio se desbloquea tras un gesto del usuario');
console.log('✅ Poker: mano completa, turnos, privacidad, reparto secuencial y subida de ciegas');
assert.equal(evaluate(cards('A♠ 2♥ 3♦ 4♣ 5♠ K♥ Q♦'))[1],5);
assert.equal(evaluate(cards('A♠ K♠ Q♠ J♠ 10♠ 2♥ 3♦'))[0],8);
assert.deepEqual(bestFive(cards('A♠ K♠ Q♠ J♠ 10♠ 2♥ 3♦')).cards.map(c=>c.rank+c.suit),['A♠','K♠','Q♠','J♠','10♠']);
assert.ok(compare(evaluate(cards('A♠ A♥ A♦ K♣ K♠ 2♥ 3♦')),evaluate(cards('K♥ K♦ K♣ A♣ A♦ 2♠ 3♥')))>0);
const heads = new PokerRoom('HEAD');heads.addPlayer('a','A');heads.addPlayer('b','B');heads.start('a',0);
assert.equal(heads.dealerId,heads.sbId);assert.equal(heads.turnId,'a');
heads.action('a','call',null,heads.visualUntil);heads.action('b','check',null,heads.visualUntil);
assert.equal(heads.phase,'flop');assert.equal(heads.turnId,'b');
heads.tick(heads.turnDeadline);assert.equal(heads.turnId,'a');
console.log('✅ Poker: evaluador, heads-up y tiempo de turno');
// Botes laterales deterministas: A gana principal, B lateral, C recupera exceso.
const side = new PokerRoom('SIDE');['a','b','c'].forEach(x=>side.addPlayer(x,x));
side.board=cards('2♠ 3♥ 7♦ 9♣ J♠');side.dealerId='a';
side.players.forEach((p,i)=>Object.assign(p,{inHand:true,total:[100,200,300][i],chips:2000-[100,200,300][i],hand:cards(['A♠ A♥','K♠ K♥','Q♠ Q♥'][i])}));
side.finish(true,0);
assert.deepEqual(side.players.map(p=>p.chips),[2200,2000,1800]);
assert.deepEqual(side.pots.map(p=>p.amount),[300,200,100]);
console.log('✅ Poker: botes laterales y devolución de exceso');
const automatic=new PokerRoom('AUTO');automatic.addPlayer('a','Ana');automatic.addPlayer('b','Bob');
automatic.phase='finished';automatic.visualUntil=0;automatic.nextHandAt=5000;automatic.tick(5000);
assert.equal(automatic.phase,'preflop','El servidor inicia automáticamente la siguiente mano');
assert.equal(automatic.handNo,1);
// Simulación reproducible de decisiones: nunca perder ni crear fichas.
for(let trial=0;trial<50;trial++) {
  const t=new PokerRoom('SIMU');['a','b','c','d'].forEach(x=>t.addPlayer(x,x));t.start('a',0);
  let n=0;
  while(t.phase!=='finished'&&n++<100) {
    const s=t.stateFor(t.turnId,t.visualUntil);let type=s.toCall?'call':'check';
    if(n%7===0&&s.canRaise)type='allIn';else if(n%11===0)type='fold';
    assert.equal(t.action(t.turnId,type,null,t.visualUntil).ok,true);
  }
  assert.equal(t.phase,'finished');assert.equal(t.players.reduce((n,p)=>n+p.chips,0),4000);
  assert.ok(t.players.every(p=>Number.isInteger(p.chips)&&p.chips>=0));
}
console.log('✅ Poker: 50 manos completas con all-in y conservación de fichas');

const hint = new PokerRoom('HINT');
hint.addPlayer('a','Ana'); hint.addPlayer('b','Bob');
assert.equal(hint.stateFor('a').privateHand, null);
hint.phase = 'flop';
for (const p of hint.players) p.inHand = true;
for (const [hand, board, label] of [
  ['A♠ A♥', '', 'Pareja de ases'],
  ['A♠ K♥', '', 'Carta alta (A)'],
  ['A♠ A♥', '2♦ 3♣ 9♠', 'Pareja de ases'],
  ['A♠ K♥', 'A♦ K♣ 9♠', 'Doble pareja de ases y reyes'],
  ['A♠ A♥', 'A♦ 3♣ 9♠', 'Trío de ases'],
  ['A♠ 2♥', '3♦ 4♣ 5♠', 'Escalera de doses a ases'],
  ['A♠ K♠', '2♠ 4♠ 9♠', 'Color de picas'],
  ['A♠ A♥', 'A♦ K♣ K♠', 'Full de ases sobre reyes'],
  ['A♠ A♥', 'A♦ A♣ K♠', 'Póker de ases'],
  ['A♠ K♠', 'Q♠ J♠ 10♠', 'Escalera de color de dieces a ases'],
  ['2♠ 3♥', '10♦ J♣ Q♠ K♥ A♦', 'Escalera de dieces a ases'],
]) {
  hint.find('a').hand = cards(hand); hint.board = board ? cards(board) : [];
  assert.equal(hint.stateFor('a').privateHand.labels.at(-1), label);
}
hint.find('a').hand = cards('A♠ K♠'); hint.find('b').hand = cards('2♥ 2♦');
hint.board = cards('Q♠ J♠ 10♠');
assert.equal(hint.stateFor('a').privateHand.labels[3], 'Escalera de color de dieces a ases');
assert.equal(hint.stateFor('b').privateHand.labels[3], 'Pareja de doses');
assert.equal(hint.stateFor('b').privateHand.playerId, 'b');
assert.ok(hint.stateFor('b').players.every(p => !p.handName && !p.bestHand.length && !p.privateHand));
assert.deepEqual(hint.stateFor('b').players[0].cards, [null,null]);
assert.equal(hint.stateFor('unknown').privateHand, null);
hint.find('a').inHand = false;
assert.equal(hint.stateFor('a').privateHand, null);
// La última acción de cada jugador viaja al cliente: sin esto no se puede ver
// en la mesa quién pasa, quién iguala y quién sube.
const acts = new PokerRoom('ACTS');
acts.addPlayer('a', 'Ana', 1000); acts.addPlayer('b', 'Bob', 1000); acts.addPlayer('c', 'Carla', 1000);
acts.start('a', 1000);
const turn = () => acts.turnId;
if (turn() === 'a') acts.action('a', 'raise', 300, acts.visualUntil + 1);
while (turn() && turn() !== 'b') acts.action(turn(), 'call', null, acts.visualUntil + 1);
acts.action('b', 'raise', 600, acts.visualUntil + 1);
while (turn() && turn() !== 'c') acts.action(turn(), 'call', null, acts.visualUntil + 1);
acts.action('c', 'call', null, acts.visualUntil + 1);
const seen = acts.stateFor('a').players;
assert.equal(seen.find(p => p.id === 'b').lastAction, 'raise', 'El que sube declara su acción');
assert.equal(seen.find(p => p.id === 'b').lastBet, 600, 'Y el importe con el que subió');
assert.equal(seen.find(p => p.id === 'c').lastAction, 'call', 'El que iguala también declara la suya');
// El nombre dice qué cartas llevas, no solo la categoría: "Pareja de doses".
assert.equal(handLabel(cards('2♠ 2♥')), 'Pareja de doses');
assert.equal(handLabel(cards('7♠ 7♥ 9♦ 4♣ 2♠')), 'Pareja de sietes');
assert.equal(handLabel(cards('J♠ 3♥')), 'Carta alta (J)');
assert.equal(handLabel(cards('A♠ 2♥ 3♦ 4♣ 5♠')), 'Escalera de doses a ases');
assert.equal(handLabel(cards('9♥ 8♥ 7♥ 6♥ 2♥')), 'Color de corazones');
console.log('✅ Poker: indicador privado, todas las combinaciones y sin filtración entre jugadores');
