const assert = require('node:assert/strict');
const { PokerRoom, buildDeck, evaluate, compare } = require('../js/poker-engine');
const cards = s => s.split(' ').map(x => ({rank:x.slice(0,-1),suit:x.slice(-1)}));
const r = new PokerRoom('TEST');
r.addPlayer('a','Ana');r.addPlayer('b','Bob');r.addPlayer('c','Cris');
assert.equal(r.start('b',1000).ok,false);
assert.equal(r.start('a',1000,buildDeck()).ok,true);
assert.equal(r.dealerId,'a');assert.equal(r.sbId,'b');assert.equal(r.bbId,'c');assert.equal(r.turnId,'a');
assert.equal(r.find('b').chips,1990);assert.equal(r.find('c').chips,1980);
assert.equal(r.action('a','call',null,1001).ok,false);
assert.deepEqual(r.events.map(e=>e.target),['b','c','a','b','c','a']);
assert.deepEqual(r.stateFor('a').players[1].cards,[null,null]);
const act = (type,amount) => { assert.equal(r.action(r.turnId,type,amount,r.visualUntil+1).ok,true); };
act('raise',60);act('call');act('call');assert.equal(r.phase,'flop');assert.equal(r.board.length,3);assert.equal(r.turnId,'b');
for(const phase of ['turn','river','finished']) { act('check');act('check');act('check');assert.equal(r.phase,phase); }
assert.equal(r.players.reduce((n,p)=>n+p.chips,0),6000);
assert.equal(r.board.length,5);assert.equal(new Set([...r.board,...r.players.flatMap(p=>p.hand)].map(c=>c.rank+c.suit)).size,11);
assert.equal(r.start('a',601001).ok,true);assert.equal(r.smallBlind,20);assert.equal(r.dealerId,'b');
console.log('✅ Poker: mano completa, turnos, privacidad, reparto secuencial y subida de ciegas');
assert.equal(evaluate(cards('A♠ 2♥ 3♦ 4♣ 5♠ K♥ Q♦'))[1],5);
assert.equal(evaluate(cards('A♠ K♠ Q♠ J♠ 10♠ 2♥ 3♦'))[0],8);
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
// Simulación reproducible de decisiones: nunca perder ni crear fichas.
for(let trial=0;trial<50;trial++) {
  const t=new PokerRoom('SIMU');['a','b','c','d'].forEach(x=>t.addPlayer(x,x));t.start('a',0);
  let n=0;
  while(t.phase!=='finished'&&n++<100) {
    const s=t.stateFor(t.turnId,t.visualUntil);let type=s.toCall?'call':'check';
    if(n%7===0&&s.canRaise)type='allIn';else if(n%11===0)type='fold';
    assert.equal(t.action(t.turnId,type,null,t.visualUntil).ok,true);
  }
  assert.equal(t.phase,'finished');assert.equal(t.players.reduce((n,p)=>n+p.chips,0),8000);
  assert.ok(t.players.every(p=>Number.isInteger(p.chips)&&p.chips>=0));
}
console.log('✅ Poker: 50 manos completas con all-in y conservación de fichas');
