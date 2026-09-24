// Tests deterministas de Book of Fran 5x3: líneas, pagos, apuesta y bonus.
const assert = require('assert');
const {
  BookOfFranRoom, SLOT_CONFIG, SYMBOLS, PAYLINES, makeGrid, expandGrid,
  evaluateGrid, countBooks, chooseExpandedSymbol, estimateRtp, exactBaseRtp, TARGET_RTP,
} = require('../js/slots-engine.js');

let failures = 0;
function check(name, condition) {
  console.log((condition ? '✅' : '❌') + ' ' + name);
  if (!condition) failures++;
}

const blankGrid = () => [
  ['9', 'J', 'Q'], ['10', 'K', 'A'], ['Q', '9', '10'],
  ['K', 'A', '9'], ['A', '10', 'K'],
];
const withCells = (cells, base = blankGrid()) => cells.reduce((grid, [reel, row, symbol]) => {
  grid[reel][row] = symbol;
  return grid;
}, base.map(reel => reel.slice()));

check('Book of Fran: la rejilla contiene 5 carretes por 3 filas',
  SLOT_CONFIG.REELS === 5 && SLOT_CONFIG.ROWS === 3 && makeGrid(() => .5).length === 5 && makeGrid(() => .5).every(reel => reel.length === 3));
check('Book of Fran: hay 10 paylines únicas con cinco coordenadas válidas',
  PAYLINES.length === 10 && new Set(PAYLINES.map(line => line.rows.join(','))).size === 10 &&
  PAYLINES.every(line => line.rows.length === 5 && line.rows.every(row => row >= 0 && row < 3)));
check('Book of Fran: la tabla mantiene los símbolos temáticos y pagos 3/4/5',
  ['9', '10', 'J', 'Q', 'K', 'A', 'ankh', 'cobra', 'scarab', 'crown', 'book'].every(id => SYMBOLS.some(s => s.id === id)) &&
  SYMBOLS.filter(s => s.id !== 'book').every(s => s.pays[3] < s.pays[4] && s.pays[4] < s.pays[5]));
const expandable = SYMBOLS.filter(symbol => symbol.id !== 'book').map(symbol => symbol.id);
check('Book of Fran: el RNG elige uniformemente cualquiera de los 10 símbolos expandibles',
  expandable.every((id, index) => chooseExpandedSymbol(() => index / expandable.length) === id));

const three = evaluateGrid(withCells([[0, 1, 'A'], [1, 1, 'A'], [2, 1, 'A'], [3, 1, 'Q']]), 10, 2);
const four = evaluateGrid(withCells([[0, 1, 'K'], [1, 1, 'K'], [2, 1, 'K'], [3, 1, 'K']]), 10, 2);
const five = evaluateGrid(Array.from({ length: 5 }, () => ['A', 'cobra', 'Q']), 10, 5);
const pays = id => SYMBOLS.find(symbol => symbol.id === id).pays;
check('Book of Fran: tres, cuatro y cinco iguales pagan según su tabla',
  three.lines[0].count === 3 && three.lines[0].win === Math.floor(10 * pays('A')[3]) &&
  four.lines[0].count === 4 && four.lines[0].win === Math.floor(10 * pays('K')[4]) &&
  five.lines.some(line => line.line === 2 && line.count === 5 && line.win === Math.floor(10 * pays('cobra')[5])));

const wild = evaluateGrid(withCells([[0, 2, 'Q'], [1, 2, 'book'], [2, 2, 'Q'], [3, 2, 'Q']]), 20, 3);
check('Book of Fran: el libro actúa como comodín y paga la combinación de la línea inferior',
  wild.lines.length === 1 && wild.lines[0].symbol === 'Q' && wild.lines[0].count === 4 &&
  wild.lines[0].win === Math.floor(20 * pays('Q')[4]) && wild.win === Math.floor(20 * pays('Q')[4]));

const twoLines = evaluateGrid(withCells([
  [0, 0, '9'], [1, 0, '9'], [2, 0, '9'],
  [0, 1, 'J'], [1, 1, 'J'], [2, 1, 'J'],
]), 5, 2);
check('Book of Fran: evalúa varias líneas y suma el total correctamente',
  twoLines.lines.length === 2 && twoLines.lines[0].line === 1 && twoLines.lines[1].line === 2 &&
  twoLines.win === twoLines.lines[0].win + twoLines.lines[1].win &&
  twoLines.win === Math.floor(5 * pays('9')[3]) + Math.floor(5 * pays('J')[3]));
const firstLineGrid = withCells([
  [0, 0, '9'], [1, 0, '9'], [2, 0, '9'], [0, 1, 'J'], [1, 1, 'J'], [2, 1, 'J'],
]);
const onlyFirst = evaluateGrid(firstLineGrid, 5, 1);
check('Book of Fran: activar N líneas ignora las posteriores', onlyFirst.lines.length === 1 && onlyFirst.lines[0].line === 1);

const room = new BookOfFranRoom('BOOK', { random: () => .5 });
room.addPlayer('hugo', 'Hugo', 1000);
const chipsBeforeBet = room.find('hugo').chips;
const first = room.spin('hugo', { activeLines: 4, betPerLine: 25 });
const firstPlayer = room.find('hugo');
check('Book of Fran: N líneas por X fichas descuentan exactamente N × X',
  first.ok && firstPlayer.lastResult.totalBet === 100 && firstPlayer.lastResult.activeLines === 4 &&
  firstPlayer.lastResult.betPerLine === 25 && chipsBeforeBet - firstPlayer.chips === 100 - firstPlayer.lastResult.win);
const brokeRoom = new BookOfFranRoom('BROKE', { random: () => .5 });
brokeRoom.addPlayer('pobre', 'Pobre', 100);
const insufficient = brokeRoom.spin('pobre', { activeLines: 10, betPerLine: 100 });
check('Book of Fran: no cobra ni gira si líneas × apuesta supera el saldo',
  !insufficient.ok && brokeRoom.find('pobre').chips === 100);

let cursor = 0;
const rolls = [];
const bonusRoom = new BookOfFranRoom('BONUS', { random: () => rolls[cursor++] ?? 0 });
bonusRoom.addPlayer('ana', 'Ana', 5000);
rolls.length = 0; rolls.push(...Array(15).fill(0.999), 0); cursor = 0;
const trigger = bonusRoom.spin('ana', { activeLines: 3, betPerLine: 20 });
let player = bonusRoom.find('ana');
check('Book of Fran: tres libros activan 10 giros gratis sobre 15 posiciones',
  trigger.ok && player.freeSpins === 10 && player.expandedSymbol === '9' &&
  player.lastResult.bookCount === 15 && player.lastResult.bonusStarted && player.lastResult.totalBet === 60);
rolls.length = 0; rolls.push(...Array(15).fill(0)); cursor = 0;
bonusRoom._lastSpinAt.clear();
const free = bonusRoom.spin('ana');
player = bonusRoom.find('ana');
check('Book of Fran: el primer gratis expande 9 en los cinco carretes y no cobra',
  free.ok && player.lastResult.mode === 'free' && player.lastResult.totalBet === 0 &&
  player.lastResult.expandedReels.length === 5 && player.lastResult.grid.every(reel => reel.every(symbol => symbol === '9')));
check('Book of Fran: la expansión y el trigger siguen contando la rejilla completa',
  countBooks(player.lastResult.rawGrid) === 0 && expandGrid(player.lastResult.rawGrid, '9').grid.length === 5);
rolls.length = 0; rolls.push(...Array(15).fill(0.999)); cursor = 0;
bonusRoom._lastSpinAt.clear();
const retrigger = bonusRoom.spin('ana');
player = bonusRoom.find('ana');
check('Book of Fran: un re-trigger añade 10 giros y conserva el acumulado del bonus',
  retrigger.ok && player.freeSpins === 18 && player.expandedSymbol === '9' && player.lastResult.awarded === 10 &&
  player.lastResult.bonusWinTotal === player.bonusWinTotal && player.jackpotPickPending === false);

check('Book of Fran: el objetivo RTP propio es 96,5% y está publicado en la config',
  TARGET_RTP === .965 && SLOT_CONFIG.BASE_RTP_TARGET === TARGET_RTP);
const exactRtp = exactBaseRtp();
check('Book of Fran: el RTP exacto de líneas base queda entre 96% y 97%', exactRtp >= .96 && exactRtp <= .97);
function seededRandom(seed) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
}
// 900k rondas de base + bonus en total. El jackpot no forma parte de este cálculo.
const rtpSamples = [0x12345678, 0x9e3779b9, 0xdeadbeef]
  .map(seed => estimateRtp(300000, { random: seededRandom(seed), freeSpins: SLOT_CONFIG.FREE_SPINS_AWARDED }));
const rtp = rtpSamples.reduce((sum, value) => sum + value, 0) / rtpSamples.length;
console.log(`ℹ️ Book of Fran RTP: exacto base ${(exactRtp * 100).toFixed(2)}% · muestra base+bonus ${(rtp * 100).toFixed(2)}%`);
check('Book of Fran: el RTP propio medio con bonus cae entre 96% y 97%', rtp >= .96 && rtp <= .97);

if (failures) {
  console.log(`\n❌ Tests de Book of Fran: ${failures} fallo(s)`);
  process.exit(1);
}
console.log(`\n✅ Tests de Book of Fran 5x3 pasados (RTP de muestra: ${(rtp * 100).toFixed(2)}%)`);
