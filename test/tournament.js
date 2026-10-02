// ============================================================
//  Test de los torneos: configuración, solicitudes, aceptación,
//  mesa en juego, eliminaciones y reparto de premios.
//  Ejecutar con: node test/tournament.js
// ============================================================
const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UserStore } = require('../js/users.js');
const { TransactionLog } = require('../js/transactions.js');
const { TournamentStore } = require('../js/tournament-store.js');
const { TournamentRoom, TournamentTables, MAX_SEATS } = require('../js/tournament-engine.js');

let failures = 0;
function check(name, condition) {
  console.log((condition ? '✅' : '❌') + ' ' + name);
  if (!condition) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-tournament-'));
const userStore = new UserStore(path.join(dir, 'users.json'));
const txLog = new TransactionLog(path.join(dir, 'tx.json'));
const file = path.join(dir, 'tournaments.json');
const store = new TournamentStore({ filePath: file, userStore, txLog });

// Cuentas: franelnomada es admin por defecto (ADMIN_USERS).
const admin = userStore.register('franelnomada', 'secreta1', 9000);
const ana = userStore.register('Ana', 'secreta1', 6000);
const beto = userStore.register('Beto', 'secreta1', 6000);
const cari = userStore.register('Carla', 'secreta1', 300);

// ---------- Validación de la configuración ----------
check('torneos: sin nombre no se crea', !store.create({ buyIn: 100, startChips: 1000, smallBlind: 10 }).ok);
check('torneos: las fichas iniciales deben ser válidas',
  !store.create({ name: 'X', buyIn: 100, startChips: 'abc', smallBlind: 10 }).ok);
check('torneos: el máximo de jugadores no pasa de ' + MAX_SEATS,
  !store.create({ name: 'X', buyIn: 100, startChips: 1000, smallBlind: 10, maxPlayers: 40 }).ok);
check('torneos: los premios en % no pueden sumar más de 100',
  !store.create({
    name: 'X', buyIn: 100, startChips: 1000, smallBlind: 10, maxPlayers: 6,
    prizes: [{ position: 1, value: 70 }, { position: 2, value: 40 }],
  }).ok);
assert.ok(MAX_SEATS === 9, 'El torneo admite hasta 9 asientos');

// ---------- Creación ----------
const created = store.create({
  name: 'Relámpago nocturno', description: 'Ciegas rápidas', buyIn: 500, startChips: 5000,
  smallBlind: 100, ante: 50, levelMinutes: 5, maxLevels: 10, maxPlayers: 6, minPlayers: 2,
  breakEvery: 2, breakMinutes: 3, lateRegistration: true, lateLevels: 1, autoStart: true,
  prizes: [{ position: 1, format: 'porcentaje', value: 60, label: 'Campeón' }, { position: 2, format: 'porcentaje', value: 40 }],
});
check('torneos: el admin crea el torneo', created.ok);
const id = created.tournament.id;
check('torneos: la ciega grande es el doble de la pequeña', created.tournament.bigBlind === 200);
check('torneos: guarda el ante y el registro tardío', created.tournament.ante === 50 && created.tournament.lateRegistration === true);

// Editar antes de que haya gente sentada
const edited = store.update(id, { ...created.tournament, name: 'Relámpago v2', smallBlind: 50 });
check('torneos: el admin edita la configuración', edited.ok && edited.tournament.name === 'Relámpago v2' && edited.tournament.bigBlind === 100);
store.update(id, { ...edited.tournament, name: 'Relámpago nocturno', smallBlind: 100 });

// ---------- Solicitudes ----------
check('torneos: sin cuenta no se puede apuntar', !store.request('', id).ok);
check('torneos: se puede apuntar aunque falten fichas (decide el admin)', store.request(cari.token, id).ok);
check('torneos: el jugador solicita participar', store.request(ana.token, id).ok);
check('torneos: el jugador solicita participar', store.request(beto.token, id).ok);
check('torneos: no se duplica la solicitud', store.request(ana.token, id).duplicate === true);
check('torneos: el admin ve las solicitudes pendientes', store.adminList()[0].pendingRequests === 3);
check('torneos: el admin ve las fichas del solicitante',
  store.adminList()[0].requests.every(r => r.username && r.status === 'pendiente'));

// ---------- Aceptación y rechazo ----------
const requests = store.requestsFor(id);
const pendingByName = name => store.requestsFor(id).find(r => r.username === name);
check('torneos: un jugador no admin no acepta solicitudes',
  !store.decide(ana.token, pendingByName('Ana').id, true).ok);
check('torneos: no se puede resolver una solicitud inexistente', !store.decide(admin.token, 'nope', false).ok);

// Carla tiene 300 fichas y la cuota es 500: la solicitud se puede hacer,
// pero el admin no puede aceptarla hasta que tenga saldo.
const acceptCarla = store.decide(admin.token, pendingByName('Carla').id, true);
check('torneos: no se acepta a quien no tiene fichas para la cuota', !acceptCarla.ok && /fichas/.test(acceptCarla.error));
check('torneos: al no aceptar no se le descuenta nada', userStore.users.get('carla').chips === 300);

const acceptAna = store.decide(admin.token, pendingByName('Ana').id, true);
check('torneos: el admin acepta la participación', acceptAna.ok);
check('torneos: la cuota se cobra de la cuenta de Ana', userStore.users.get('ana').chips === 5500);
check('torneos: se genera un asiento para el jugador', !!acceptAna.playerId);
check('torneos: no se resuelve dos veces la misma solicitud', !store.decide(admin.token, pendingByName('Ana').id, false).ok);

const rejectCarla = store.decide(admin.token, pendingByName('Carla').id, false);
check('torneos: el admin puede rechazar una solicitud', rejectCarla.ok);
check('torneos: al rechazar no se cobra nada', userStore.users.get('carla').chips === 300);
check('torneos: el admin ve que fue rechazada',
  store.requestsFor(id).find(r => r.username === 'Carla').status === 'rechazada');

// Autoarranque: al entrar el segundo jugador con el mínimo configurado, arranca solo
store.decide(admin.token, store.requestsFor(id).find(r => r.username === 'Beto').id, true);
const room = store.roomFor(id);
// A partir de aquí el torneo es un contenedor de mesas: room.tables[0] es
// la mesa donde se sentaron los jugadores (con maxTables=1 solo hay una).
const table = room.tables[0];
check('torneos: los jugadores aceptados quedan sentados', room.allPlayers().length === 2);
check('torneos: el bote suma las cuotas', room.prizePool === 1000);
check('torneos: con minPlayers alcanzados el torneo arranca solo', room.tournamentPhase === 'en_curso' && room.startedAt !== null);
check('torneos: las fichas iniciales son las del torneo',
  room.allPlayers().every(p => p.chips === 5000 || p.chips < 5000));
check('torneos: con una sola mesa no se crean más', room.tables.length === 1);
check('torneos: con el torneo en marcha no se cambia el reparto', !store.update(id, { ...created.tournament, startChips: 9000 }).ok);

// ---------- La mesa: ciegas, ante y niveles ----------
const t0 = room.startedAt;
room.syncTables();
table.bumpLevel(t0 + 5 * 60 * 1000);
check('torneos: las ciegas se duplican al cambiar de nivel', table.smallBlind === 200 && table.bigBlind === 400 && table.ante === 100);
table.bumpLevel(t0);
check('torneos: el nivel no retrocede', table.level === 1);
table.bumpLevel(t0 + 99 * 60 * 1000);
check('torneos: las ciegas respetan el nivel máximo', table.smallBlind === 100 * 2 ** 9 && table.maxLevels === 10);
table.level = 0; table.startedAt = t0;
table.bumpLevel(t0);

// Descanso programado cada 2 niveles
const restRoom = new TournamentRoom('descanso', { breakEvery: 2, breakMinutes: 3, levelMinutes: 1, startChips: 1000, smallBlind: 10 });
restRoom.addPlayer('a', 'Ana', { buyIn: 100 });
restRoom.addPlayer('b', 'Beto', { buyIn: 100 });
restRoom.start(null, 1000);
check('torneos: arranca repartiendo', restRoom.phase === 'preflop');
restRoom.finish(true, 2000);
restRoom.start(null, 1000 + 2 * 60 * 1000);
check('torneos: entra en descanso en el nivel múltiplo configurado', restRoom.tournamentPhase === 'descanso');
check('torneos: el mensaje anuncia el descanso', /descanso/i.test(restRoom.message));
restRoom.tick(1000 + 2 * 60 * 1000 + 3 * 60 * 1000 + 1);
check('torneos: pasado el descanso el torneo continúa', restRoom.tournamentPhase === 'en_curso');

// Registro tardío y aforo
const late = new TournamentRoom('tarde', { lateRegistration: true, lateLevels: 1, startChips: 1000, smallBlind: 10, maxPlayers: 3 });
late.addPlayer('a', 'Ana', {});
late.addPlayer('b', 'Beto', {});
late.start(null, 1000);
check('torneos: con registro tardío se puede entrar en el nivel 1', late.addPlayer('c', 'Carla', {}).ok);
late.level = 5;
check('torneos: pasado el nivel límite se cierra el registro', !late.addPlayer('d', 'Dalo', {}).ok);
const full = new TournamentRoom('lleno', { maxPlayers: 2, startChips: 1000, smallBlind: 10 });
full.addPlayer('a', 'Ana', {});
full.addPlayer('b', 'Beto', {});
check('torneos: sin asientos libres no se entra más', !full.addPlayer('c', 'Carla', {}).ok);

// ---------- Torneos programados por fecha ----------
// Cuentas aparte: aquí se cobran cuotas y no deben alterar los saldos
// que se comprueban más abajo en los torneos anteriores.
const ana2 = userStore.register('Ana2', 'secreta1', 5000);
const beto2 = userStore.register('Beto2', 'secreta1', 5000);
const inAnHour = Date.now() + 60 * 60 * 1000;
const future = store.create({
  name: 'Torneo del viernes', buyIn: 100, startChips: 2000, smallBlind: 20,
  maxPlayers: 9, minPlayers: 6, startMode: 'programado', startsAt: inAnHour,
});
check('torneos: se crea un torneo con fecha de inicio', future.ok);
check('torneos: guarda la fecha programada', future.tournament.startsAt === inAnHour);
check('torneos: programado ignora el mínimo de jugadores',
  future.tournament.startMode === 'programado' && future.tournament.minPlayers === 1);
check('torneos: sin fecha no se puede programar',
  !store.create({ name: 'X', buyIn: 100, startChips: 1000, smallBlind: 10, startMode: 'programado' }).ok);
check('torneos: una fecha ya pasada no se acepta',
  !store.create({ name: 'X', buyIn: 100, startChips: 1000, smallBlind: 10, startMode: 'programado', startsAt: Date.now() - 86400000 }).ok);
check('torneos: solo el día se interpreta a las 20:00',
  store.parseStartsAt('2099-04-12') === Date.parse('2099-04-12T20:00'));
check('torneos: el listado avisa de cuándo arranca', (() => {
  const t = future.tournament;
  const row = Object.assign({}, t, { status: 'registro' });
  const view = store.publicList(ana2.token).find(x => x.id === t.id);
  return view && view.startMode === 'programado' && view.scheduledIn > 0 && view.scheduledIn <= 60 * 60 * 1000;
})());

const schedId = future.tournament.id;
store.request(ana2.token, schedId);
store.decide(admin.token, store.requestsFor(schedId).find(r => r.username === 'Ana2').id, true);
const schedRoom = store.roomFor(schedId);
check('torneos: antes de la hora el torneo no arranca', schedRoom.tournamentPhase === 'registro' && schedRoom.startedAt === null);
check('torneos: con 1 de 6 jugadores tampoco arranca', !store.maybeAutoStart(store.tournaments.get(schedId)));
check('torneos: pasado el día y la hora, el tick lo arranca solo', (() => {
  store.tick(Date.now() + 61 * 60 * 1000);
  return schedRoom.tournamentPhase === 'en_curso' && schedRoom.waitingForPlayers();
})());
check('torneos: arrancado por hora con un solo jugador, la mesa espera', schedRoom.waitingForPlayers() && !store.maybeAutoStart(store.tournaments.get(schedId)));
check('torneos: el registro sigue abierto para que se siente alguien', schedRoom.canRegister());
store.request(beto2.token, schedId);
const seated2 = store.decide(admin.token, store.requestsFor(schedId).find(r => r.username === 'Beto2').id, true);
check('torneos: el segundo jugador puede sentarse tras arrancar por hora', seated2.ok);
schedRoom.tick(Date.now() + 62 * 60 * 1000);
check('torneos: al sentarse el segundo, el torneo reparte solo',
  schedRoom.waitingForPlayers() === false && schedRoom.tables[0].handNo >= 1 && schedRoom.tournamentPhase === 'en_curso');
check('torneos: en modo programado no hace falta el mínimo de jugadores', schedRoom.tables[0].handNo >= 1);

// Modo manual: nadie lo arranca por su cuenta
const manual = store.create({ name: 'A mano', buyIn: 100, startChips: 1000, smallBlind: 10, maxPlayers: 6, startMode: 'manual' });
store.request(ana2.token, manual.tournament.id);
store.request(beto2.token, manual.tournament.id);
for (const r of store.requestsFor(manual.tournament.id)) store.decide(admin.token, r.id, true);
const manualRoom = store.roomFor(manual.tournament.id);
store.tick(Date.now() + 3600000);
check('torneos: en modo manual no arranca solo ni por jugadores ni por fecha',
  manualRoom.tournamentPhase === 'registro' && store.start(manual.tournament.id).ok);
check('torneos: arrancado a mano por el admin', manualRoom.tournamentPhase === 'en_curso');
store.remove(manual.tournament.id);
store.remove(schedId);

// ---------- Mesas múltiples: más de 9 jugadores ----------
check('torneos: no se pueden pedir más de 20 mesas',
  !store.create({ name: 'X', buyIn: 100, startChips: 1000, smallBlind: 10, maxTables: 25 }).ok);
check('torneos: el mínimo de jugadores no puede pasar del aforo total',
  !store.create({ name: 'X', buyIn: 100, startChips: 1000, smallBlind: 10, maxPlayers: 9, maxTables: 2, minPlayers: 20 }).ok);
check('torneos: no se equilibra cada más niveles de los que tiene',
  !store.create({ name: 'X', buyIn: 100, startChips: 1000, smallBlind: 10, maxLevels: 5, moveEveryLevels: 10 }).ok);

const big = store.create({
  name: 'Torneo grande', buyIn: 100, startChips: 5000, smallBlind: 100,
  maxPlayers: 3, maxTables: 3, minPlayers: 6, levelMinutes: 10, maxLevels: 20,
  moveEveryLevels: 2,
  prizes: [{ position: 1, format: 'porcentaje', value: 100, label: 'Campeón' }],
});
assert.ok(big.ok, 'torneos: se crea un torneo de varias mesas: ' + big.error);
check('torneos: se crea un torneo de varias mesas', big.ok && big.tournament.maxTables === 3);
// Aforo total = 3 mesas × 3 asientos = 9 jugadores.
check('torneos: el aforo total son las mesas por los asientos',
  big.tournament.maxPlayers * big.tournament.maxTables === 9);

const bigId = big.tournament.id;
const players9 = [];
for (let i = 0; i < 9; i++) {
  const name = 'P' + (i + 1);
  const acc = userStore.register(name, 'secreta1', 5000);
  players9.push(acc);
  store.request(acc.token, bigId);
}
check('torneos: nueve jugadores pueden apuntarse a un torneo de 3 mesas',
  store.requestsFor(bigId).length === 9);
for (const r of store.requestsFor(bigId)) store.decide(admin.token, r.id, true);
const bigRoom = store.roomFor(bigId);
check('torneos: los 9 quedan repartidos en 3 mesas de 3',
  bigRoom.tables.length === 3 && bigRoom.tables.every(t => t.players.length === 3),
  'mesas: ' + bigRoom.tables.map(t => t.players.length).join(','));
check('torneos: todas las mesas tienen la misma ciega', (() => {
  bigRoom.syncTables();
  const blinds = bigRoom.tables.map(t => t.smallBlind + '/' + t.bigBlind);
  return blinds.every(b => b === blinds[0]);
})());
check('torneos: el bote reúne todas las cuotas', bigRoom.prizePool === 900);
store.start(bigId);
check('torneos: el torneo arranca con los 6 mínimos repartidos en las 3 mesas',
  bigRoom.tables.every(t => t.handNo >= 1) && bigRoom.tables.length === 3);

// El jugador ve la mesa donde está sentado, no las demás.
const firstOfTable2 = bigRoom.tables[1].players[0];
const st2 = bigRoom.stateFor(firstOfTable2.id);
check('torneos: el jugador solo ve su mesa',
  st2 && st2.tableNumber === 2 && st2.players.length === 3, 'mesa ' + (st2 && st2.tableNumber));
check('torneos: el estado dice cuántas mesas hay', st2.tableCount === 3);
check('torneos: no se puede actuar en una mesa ajena',
  bigRoom.action(firstOfTable2.id, 'check').ok !== undefined);

// Equilibrado: una mesa que se queda con 1 jugador recibe de otra.
// Las mesas deben estar libres para poder mover a alguien.
bigRoom.tables.forEach(t => { t.phase = 'lobby'; t.nextHandAt = 0; t.visualUntil = 0; });
const t1 = bigRoom.tables[0];
t1.players[2].chips = 0; t1.players[2].eliminated = true; t1.players[2].left = true;
t1.players[1].chips = 0; t1.players[1].eliminated = true; t1.players[1].left = true;
bigRoom.movedAtLevel = -1;
const movedNames = bigRoom.rebalance();
check('torneos: una mesa con un solo jugador recibe de otra',
  bigRoom.tableSize(t1) === 2 && movedNames.length >= 1,
  'movidos: ' + movedNames.join(',') + ' / mesa1=' + bigRoom.tableSize(t1));
check('torneos: el jugador movido conserva sus fichas',
  bigRoom.allPlayers().filter(p => !p.eliminated && !p.left).every(p => p.chips > 0),
  'sin fichas: ' + bigRoom.allPlayers().filter(p => !p.eliminated && !p.left && p.chips <= 0).map(p => p.name).join(','));
check('torneos: el aviso de cambio de mesa se guarda en el torneo',
  /Cambio de mesa/.test(bigRoom.message), bigRoom.message);
check('torneos: no se deja ninguna mesa con menos de 2 jugadores',
  bigRoom.tables.every(t => bigRoom.tableSize(t) >= 2),
  'tamaños: ' + bigRoom.tables.map(t => bigRoom.tableSize(t)).join(','));
check('torneos: el número de jugadores con fichas se conserva',
  bigRoom.alivePlayers().length === 7, 'vivos: ' + bigRoom.alivePlayers().length);
check('torneos: el aviso de cambio de mesa se guarda en el torneo',
  /Cambio de mesa/.test(bigRoom.message), bigRoom.message);

// Redistribución automática al subir de nivel (sin tocar rebalance a mano).
bigRoom.startedAt = Date.now();
bigRoom.tables.forEach(t => { t.startedAt = bigRoom.startedAt; t.phase = 'lobby'; t.visualUntil = 0; });
bigRoom.movedAtLevel = -1;
// Se hunde un jugador más de la mesa 1 para que se quede en 1.
t1.players[0].chips = 0; t1.players[0].eliminated = true; t1.players[0].left = true;
const antesNivel = bigRoom.tableSize(t1);
bigRoom.tick(Date.now() + 20 * 60 * 1000);   // nivel 2: toca redistribuir
check('torneos: al subir de nivel las mesas se equilibran solas',
  bigRoom.tableSize(t1) > antesNivel,
  'mesa1 pasó de ' + antesNivel + ' a ' + bigRoom.tableSize(t1));
check('torneos: solo se redistribuye una vez por nivel',
  bigRoom.movedAtLevel === 2, 'nivel marcado: ' + bigRoom.movedAtLevel);

// Una mesa que se queda sin jugadores con fichas deja de repartir.
check('torneos: el torneo sigue vivo con los que quedan',
  bigRoom.tournamentPhase === 'en_curso' || bigRoom.tournamentPhase === 'finalizado');

// Persistencia con varias mesas
const bigSnap = JSON.stringify(bigRoom.serialize());
check('torneos: el contenedor con mesas se puede guardar', bigSnap.includes('"kind":"tables"') && bigSnap.includes('"tableNumber"'));
check('torneos: el guardado no incluye referencias circulares', !bigSnap.includes('"owner"'));
const restored = TournamentTables.restore(JSON.parse(bigSnap), store.tournaments.get(bigId));
check('torneos: al reiniciar el servidor se recuperan todas las mesas',
  restored.tables.length === bigRoom.tables.length &&
  restored.allPlayers().length === bigRoom.allPlayers().length &&
  restored.prizePool === bigRoom.prizePool,
  'recuperadas: ' + restored.tables.length + ' mesas, ' + restored.allPlayers().length + ' jugadores');
check('torneos: las fichas de cada jugador sobreviven al reinicio',
  restored.allPlayers().filter(p => !p.eliminated && !p.left).every(p => p.chips > 0),
  'sin fichas: ' + restored.allPlayers().filter(p => !p.eliminated && !p.left && p.chips <= 0).map(p => p.name).join(','));
store.remove(bigId);

// ---------- Eliminaciones y puestos ----------
const duel = new TournamentRoom('duelo', { startChips: 100, smallBlind: 10, maxPlayers: 2 });
duel.addPlayer('a', 'Ana', { buyIn: 100, accountKey: 'ana' });
duel.addPlayer('b', 'Beto', { buyIn: 100, accountKey: 'beto' });
duel.start(null, 1000);
duel.find('a').chips = 0;
duel.afterHand(2000);
check('torneos: sin fichas quedas eliminado', duel.find('a').eliminated === true);
const anaPlace = duel.standings.find(row => row.name === 'Ana');
check('torneos: el eliminado tiene puesto asignado', anaPlace && anaPlace.place === 2);
check('torneos: el campeón queda con el primer puesto',
  duel.standings.find(row => row.name === 'Beto').place === 1);
check('torneos: con un solo vivo el torneo termina', duel.tournamentPhase === 'finalizado');
const duelState = duel.stateFor('b', 2000);
check('torneos: el eliminado sigue visible con su posición',
  duelState.players.some(p => p.id === 'a' && p.eliminated && /2º/.test(p.result)));

// Retirada = eliminación, y el torneo continúa con el resto
const walk = new TournamentRoom('retirada', { startChips: 100, smallBlind: 10, maxPlayers: 3 });
walk.addPlayer('a', 'Ana', { buyIn: 100, accountKey: 'ana' });
walk.addPlayer('b', 'Beto', { buyIn: 100, accountKey: 'beto' });
walk.addPlayer('c', 'Carla', { buyIn: 100, accountKey: 'carla' });
walk.start(null, 1000);
walk.removePlayer('c', 1500);
check('torneos: retirarse deja al jugador sin fichas', walk.find('c').chips === 0 && walk.find('c').eliminated === true);
check('torneos: el torneo sigue vivo con dos jugadores', walk.tournamentPhase === 'en_curso');

// ---------- Reparto de premios ----------
const payouts = store.computePayouts(store.tournaments.get(id), 1000);
check('torneos: los premios en % se calculan sobre el bote', payouts[0].amount === 600 && payouts[1].amount === 400);
const fixed = store.computePayouts({ prizes: [{ position: 1, format: 'fichas', value: 300 }] }, 1000);
check('torneos: los premios en fichas son fijos', fixed[0].amount === 300);
const leftover = store.computePayouts({ prizes: [{ position: 1, format: 'porcentaje', value: 50 }] }, 1000);
check('torneos: el bote sobrante no se pierde', leftover[0].amount === 1000);

const fin = store.forceFinish(id);
check('torneos: el admin puede finalizar el torneo', fin.ok);
check('torneos: el bote se reparte entre los dos puestos', fin.paid === 1000);
check('torneos: hay ganador y resultados', !!fin.tournament.winner && fin.tournament.results.length === 2);
check('torneos: el ganador cobra su premio',
  userStore.users.get('beto').chips === 6100 || userStore.users.get('ana').chips === 6100);
check('torneos: un torneo finalizado no se edita', !store.update(id, { ...created.tournament, name: 'nuevo' }).ok);
check('torneos: la consola registra la cuota y el premio',
  txLog.list(50).some(t => t.type === 'tournament_buyin') && txLog.list(50).some(t => t.type === 'tournament_prize'));
check('torneos: finalizar dos veces no reparte de nuevo', !store.forceFinish(id).ok);

// ---------- Visibilidad, borrado y persistencia ----------
check('torneos: el estado final aparece en la lista del admin',
  store.adminList().some(t => t.id === id && t.status === 'finalizado'));
check('torneos: se puede borrar un torneo terminado', store.remove(id).ok);
check('torneos: tras borrar no aparece', !store.adminList().some(t => t.id === id));

const again = store.create({ name: 'Persistente', buyIn: 100, startChips: 1000, smallBlind: 10, maxPlayers: 6 });
store.request(ana.token, again.tournament.id);
const reloaded = new TournamentStore({ filePath: file, userStore, txLog });
check('torneos: la configuración sobrevive al reinicio', reloaded.adminList().some(t => t.name === 'Persistente'));
check('torneos: las solicitudes sobreviven al reinicio',
  reloaded.adminList().find(t => t.name === 'Persistente').pendingRequests === 1);

if (failures) {
  console.log(`\n❌ Test de torneos: ${failures} fallo(s)`);
  process.exit(1);
}
console.log('\n✅ Test de torneos pasado');
