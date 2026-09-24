// Tests deterministas de Book of Fran: trigger, expansión y retorno a normal.
const assert = require('assert');
const {
  BookOfFranRoom, SLOT_CONFIG, SYMBOLS, makeGrid, expandGrid, countBooks,
} = require('../js/slots-engine.js');

let failures = 0;
function check(name, condition) {
  console.log((condition ? '✅' : '❌') + ' ' + name);
  if (!condition) failures++;
}

check('Book of Fran: 3 libros activan 10 giros gratis', SLOT_CONFIG.BOOKS_TO_TRIGGER === 3 && SLOT_CONFIG.FREE_SPINS_AWARDED === 10);
check('Book of Fran: la tabla contiene los símbolos temáticos', ['ankh', 'cobra', 'scarab', 'crown', 'book'].every(id => SYMBOLS.some(s => s.id === id)));
check('Book of Fran: el libro tiene el menor peso', SYMBOLS[SYMBOLS.length - 1].id === 'book' && SYMBOLS[SYMBOLS.length - 1].weight <= 1);

const triggerGrid = Array.from({ length: 3 }, () => ['book', 'book', 'book']);
check('Book of Fran: tres libros en la misma tirada se detectan', countBooks(triggerGrid) === 9);
const expanded = expandGrid([['9', 'ankh', '9'], ['10', 'Q', '10'], ['J', 'K', 'J']], '9');
check('Book of Fran: el símbolo expandido llena su carrete', expanded.expandedReels.length === 1 && expanded.grid[0].every(x => x === '9'));

let rolls = [];
let cursor = 0;
const room = new BookOfFranRoom('BOOK', { random: () => rolls[cursor++] ?? 0.999 });
room.addPlayer('hugo', 'Hugo', 1000);
// 9 libros + Elección de 9; durante los 10 giros, 9 en todas las posiciones.
rolls = Array(9).fill(0.999).concat([0]);
cursor = 0;
check('Book of Fran: el backend acepta el primer giro', room.spin('hugo', 100).ok);
let player = room.find('hugo');
check('Book of Fran: el trigger deja 10 giros y elige un símbolo de pago', player.freeSpins === 10 && player.expandedSymbol === '9' && player.lastResult.awarded === 10);
check('Book of Fran: el trigger no consume la apuesta gratuita inicial', player.lastResult.mode === 'normal' && player.slotBet === 100);

for (let i = 0; i < SLOT_CONFIG.FREE_SPINS_AWARDED; i++) {
  rolls = Array(9).fill(0);
  cursor = 0;
  room._lastSpinAt.clear();
  check(`Book of Fran: giro gratis ${i + 1} se procesa`, room.spin('hugo', 100).ok);
}
player = room.find('hugo');
check('Book of Fran: termina la ronda y vuelve al modo normal', player.freeSpins === 0 && player.expandedSymbol === null);
const lastFree = player.lastResult;
check('Book of Fran: el último resultado conserva la expansión aplicada', lastFree.mode === 'free' && lastFree.expandedReels.length === 3 && lastFree.grid.every(reel => reel.every(symbol => symbol === '9')));
rolls = Array(9).fill(0);
cursor = 0;
room._lastSpinAt.clear();
room.spin('hugo', 100);
check('Book of Fran: el siguiente giro vuelve a cobrar apuesta normal', room.find('hugo').lastResult.mode === 'normal' && room.find('hugo').freeSpins === 0 && room.find('hugo').expandedSymbol === null);

if (failures) {
  console.log(`\n❌ Tests de Book of Fran: ${failures} fallo(s)`);
  process.exit(1);
}
console.log('\n✅ Tests de Book of Fran pasados');
