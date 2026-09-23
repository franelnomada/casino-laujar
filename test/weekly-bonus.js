// Test del reparto automático de 1.000 fichas (lunes/miércoles/viernes, 10:00 Madrid)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UserStore } = require('../js/users.js');
const { TransactionLog } = require('../js/transactions.js');
const { WeeklyChipBonus, slotFor, DEFAULT_TZ } = require('../js/weekly-bonus.js');

let failures = 0;
function check(name, condition) {
  console.log((condition ? '✅' : '❌') + ' ' + name);
  if (!condition) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-weekly-bonus-'));
const usersFile = path.join(dir, 'users.json');
const txFile = path.join(dir, 'transactions.json');
const store = new UserStore(usersFile);
const txLog = new TransactionLog(txFile);
const mondayAt10 = Date.parse('2026-09-28T08:00:00.000Z'); // CEST
const mondayAt1030 = Date.parse('2026-09-28T08:30:00.000Z');
const wednesdayAt10 = Date.parse('2026-09-30T08:00:00.000Z');
const tuesdayAt11 = Date.parse('2026-09-29T09:00:00.000Z');
const fridayAt10 = Date.parse('2026-10-02T08:00:00.000Z');

store.register('Ana', 'secreta1', 1000);
store.register('Beto', 'secreta1', 500);
store.register('Carla', 'secreta1', 200);
store.register('Dalo', 'secreta1', 300);
for (const user of store.users.values()) user.createdAt = mondayAt10 - 60 * 60 * 1000;
// Carla se registra después del reparto del lunes; Dalo está suspendido.
store.users.get('carla').createdAt = mondayAt10 + 1000;
store.users.get('dalo').banned = true;

const bonus = new WeeklyChipBonus({ userStore: store, txLog, autoStart: false });
check('bonus: antes de las 10:00 no reparte', !slotFor(mondayAt10 - 60 * 1000, DEFAULT_TZ));
check('bonus: martes no reparte', !slotFor(tuesdayAt11, DEFAULT_TZ));
check('bonus: respeta el horario de verano (CEST)', !!slotFor(mondayAt10, DEFAULT_TZ));
check('bonus: respeta el horario de invierno (CET)', !!slotFor(Date.parse('2026-01-05T09:00:00.000Z'), DEFAULT_TZ));

const monday = bonus.tick(mondayAt1030);
check('bonus: al reiniciar después de las 10:00 entrega el reparto pendiente',
  monday.ran && monday.delivered === 2 && monday.total === 2000);
check('bonus: cada jugador activo recibe exactamente 1.000 fichas',
  store.users.get('ana').chips === 2000 && store.users.get('beto').chips === 1500);
check('bonus: no entrega a cuentas creadas tarde ni baneadas',
  store.users.get('carla').chips === 200 && store.users.get('dalo').chips === 300);
check('bonus: repetir el mismo día no duplica la entrega',
  !bonus.tick(mondayAt1030 + 1000).ran && store.users.get('ana').chips === 2000);

const wednesday = bonus.tick(wednesdayAt10);
const friday = bonus.tick(fridayAt10);
check('bonus: reparte los miércoles y viernes posteriores',
  wednesday.delivered === 3 && friday.delivered === 3 &&
  store.users.get('ana').chips === 4000 && store.users.get('beto').chips === 3500 &&
  store.users.get('carla').chips === 2200);
check('bonus: no reparte en días no programados',
  !bonus.tick(tuesdayAt11).ran && store.users.get('ana').chips === 4000);

const entries = txLog.list(20);
check('bonus: cada entrega aparece en la consola de transacciones',
  entries.filter(entry => entry.type === 'weekly_bonus').length === 8 &&
  entries.some(entry => /Ana ha recibido 1000 fichas de regalo semanal/.test(entry.message || '')));

const restartedStore = new UserStore(usersFile);
const restarted = new WeeklyChipBonus({ userStore: restartedStore, txLog, autoStart: false });
const afterRestart = restarted.tick(fridayAt10 + 60 * 60 * 1000);
check('bonus: tras reiniciar no vuelve a pagar el mismo día',
  afterRestart.ran && afterRestart.delivered === 0 && restartedStore.users.get('ana').chips === 4000 &&
  restartedStore.users.get('ana').lastScheduledBonus === '2026-10-02');

bonus.stop();
restarted.stop();
if (failures) {
  console.log(`\n❌ Test del bonus semanal: ${failures} fallo(s)`);
  process.exit(1);
}
console.log('\n✅ Test del bonus semanal pasado');
