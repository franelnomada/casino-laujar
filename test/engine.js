// Tests del motor de Blackjack multijugador (servidor)
// Ejecutar con: node test/engine.js
const assert = require('assert');
const { BlackjackRoom, handValue, isBlackjack, genCode } = require('../js/bj-engine.js');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name);
  if (!cond) failures++;
}

// Utilidades de valores
check('handValue: A+K = 21', handValue([{ rank: 'A' }, { rank: 'K' }]) === 21);
check('handValue: A+A+9 = 21', handValue([{ rank: 'A' }, { rank: 'A' }, { rank: '9' }]) === 21);
check('isBlackjack: 2 cartas 21', isBlackjack([{ rank: 'A' }, { rank: 'K' }]) === true);
check('isBlackjack: 3 cartas 21 no es BJ', isBlackjack([{ rank: 'A' }, { rank: 'A' }, { rank: '9' }]) === false);
check('genCode: 4 caracteres sin 0/O/1/I', /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(genCode()));

// Flujo completo de sala
const room = new BlackjackRoom('TEST');
const A = 'player-a', B = 'player-b', C = 'player-c';

check('sala: fase inicial lobby', room.phase === 'lobby');
room.addPlayer(A, 'Ana');
room.addPlayer(B, 'Bob');
room.addPlayer(C, '');
check('sala: 3 jugadores, nombre por defecto', room.players.length === 3 && room.players[2].name === 'Jugador');

room.start();
check('sala: fase de apuestas tras start', room.phase === 'betting');
check('sala: nadie confirmado al inicio', room.players.every(p => !p.confirmed));

room.bet(A, 100);
room.bet(B, 50);
check('sala: apuesta resta fichas en el reparto (aún no)', room.players[0].chips === 1000 && room.players[0].bet === 100);
check('sala: no deja apostar más de lo que tienes', room.bet(A, 10000).ok === false);

// Baraja determinista (todos 5) para que ni dealer ni jugadores tengan BJ natural
room.deck = Array.from({ length: 52 }, () => ({ rank: '5', suit: '♠' }));

// La mano no se reparte hasta que confirman todos
room.confirm(A);
check('sala: no reparte con jugadores sin confirmar', room.phase === 'betting');
room.confirm(B);
room.confirm(C);
check('sala: reparte cuando todos confirman', room.phase === 'playing');
check('sala: fichas descontadas tras repartir', room.players[0].chips === 900 && room.players[1].chips === 950);
check('sala: quien apostó tiene 2 cartas', room.players[0].hand.length === 2 && room.players[1].hand.length === 2);
check('sala: quien no apostó no recibe cartas', room.players[2].hand.length === 0 && room.players[2].played === true);

// Turnos: de derecha a izquierda, uno a uno
check('turnos: juega primero el asiento más a la derecha apostado', room.turnId === 'player-b');
check('turnos: fuera de turno se rechaza', room.hit(A).ok === false && room.turnId === 'player-b');

// Visibilidad: las cartas de todos los jugadores son públicas (como en una mesa real)
const viewA = room.stateFor(A);
const viewB = room.stateFor(B);
check('cartas visibles: A ve las de B y viceversa',
  viewA.players[0].cards.length === 2 && viewA.players[1].cards.length === 2 && viewB.players[0].cards.length === 2);
check('privacidad dealer: la segunda carta sigue oculta',
  viewA.dealer.cards.length === 1 && viewA.dealer.hidden === true);
check('privacidad dealer: valor parcial (X+)', /[0-9]+\+/.test(String(viewA.dealer.value)));

// Juego: B (derecha) se planta, luego A roba y se planta
room.stand(B);
check('sala: plantarse marca played', room.players[1].played === true);
check('turnos: el turno pasa hacia la izquierda', room.turnId === 'player-a');
room.hit(A);
const after = room.players[0];
if (handValue(after.hand) > 21) {
  check('sala: al pasarse termina played', after.played === true && after.busted === true);
} else {
  room.stand(A);
}
check('sala: ronda resuelta cuando todos juegan', room.phase === 'finished');

// Liquidación coherente
const dealerVal = handValue(room.dealerHand);
const finalA = room.players[0];
if (after.busted) {
  check('liquidación: pasarse pierde la apuesta (900)', finalA.chips === 900);
} else if (isBlackjack(after.hand)) {
  check('liquidación: blackjack paga 3:2', finalA.chips === Math.floor(900 + 100 * 2.5));
} else if (dealerVal > 21 || handValue(after.hand) > dealerVal) {
  check('liquidación: ganar paga 2x (1100)', finalA.chips === 1100);
} else if (handValue(after.hand) < dealerVal) {
  check('liquidación: perder deja 900', finalA.chips === 900);
} else {
  check('liquidación: empate devuelve (1000)', finalA.chips === 1000);
}
check('liquidación: espectador sin cambios y marcado', room.players[2].chips === 1000 && room.players[2].result === '🪑');

// Nueva ronda y estados
check('sala: se puede abrir nueva ronda', room.start().ok === true && room.phase === 'betting');
check('sala: reset de apuestas y resultados', room.players[0].bet === 0 && room.players[0].result === '');

// Acciones inválidas rechazadas
check('sala: no se puede robar en fase de apuestas', room.hit(A).ok === false);
check('sala: jugador inexistente rechazado', room.hit('fantasma').ok === false);

// Unirse a mesa llena
const full = new BlackjackRoom('FULL');
for (let i = 0; i < 5; i++) full.addPlayer('p' + i, 'P' + i);
check('sala: máximo 5 jugadores', full.addPlayer('extra', 'Extra').ok === false);

// removePlayer durante betting reevalúa el reparto
const r2 = new BlackjackRoom('R2');
r2.addPlayer('x1', 'Uno');
r2.addPlayer('x2', 'Dos');
r2.start();
r2.confirm('x1');
r2.confirm('x2');
r2.bet('x1', 50);
r2.confirm('x1');
r2.unconfirm('x2'); // vuelve a la ronda de apuestas
check('sala: se puede des-confirmar', r2.players[1].confirmed === false);

console.log(failures === 0 ? '\n🎉 Todos los tests del motor pasan' : `\n💥 ${failures} test(s) fallidos`);
process.exit(failures === 0 ? 0 : 1);
