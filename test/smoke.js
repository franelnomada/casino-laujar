// Test de humo de la lógica (sin navegador). Ejecutar con: node test/smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CHAT_MAX_LENGTH, CHAT_COOLDOWN_MS } = require('../js/room-chat.js');
const { SLOT_CONFIG, evaluateGrid, SYMBOLS } = require('../js/slots-engine.js');
const { SlotJackpot } = require('../js/slots-jackpot.js');

// --- Stubs mínimos de DOM ---
const fakeEl = () => ({
  textContent: '', innerHTML: '', value: '', style: {},
  children: [], firstChild: null, firstElementChild: null,
  scrollHeight: 0, scrollTop: 0, clientHeight: 0,
  classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, querySelector() { return null; },
  querySelectorAll() { return []; },
  setAttribute() {}, removeAttribute() {},
});
const elements = {};
global.document = {
  body: { classList: { toggle() {} } },
  getElementById: (id) => (elements[id] = elements[id] || fakeEl()),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
};
global.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; },
};
global.event = { currentTarget: { style: {} } };

// --- Cargar el código del juego ---
const root = path.join(__dirname, '..');
function load(file, exportName) {
  const code = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(`const ${exportName} =`, `global.${exportName} =`);
  new Function(code)();
}
load('js/app.js', 'App');
load('js/split-hands.js', 'SplitHands');
load('js/blackjack.js', 'Blackjack');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name);
  if (!cond) failures++;
}

// --- App ---
App.init();
check('App: fichas iniciales = 1000', App.chips === 1000);
App.takeChips(100);
check('App: descontar 100 -> 900', App.chips === 900);
App.takeChips(99999);
check('App: no deja quedar en negativo', App.chips === 900);
App.giveChips(100);
check('App: recargar -> 1000', App.chips === 1000);

// --- Blackjack: utilidades de render para mesas online (usadas por net.js y poker.js) ---

// handValue / handLabel
check('BJ: A+K = 21', Blackjack.handValue([{ rank: 'A', suit: '♠' }, { rank: 'K', suit: '♥' }]) === 21);
check('BJ: A+A+9 = 21 (as se rebaja)', Blackjack.handValue([{ rank: 'A', suit: '♠' }, { rank: 'A', suit: '♥' }, { rank: '9', suit: '♦' }]) === 21);
check('BJ: J+Q+K = 30', Blackjack.handValue([{ rank: 'J', suit: '♠' }, { rank: 'Q', suit: '♥' }, { rank: 'K', suit: '♦' }]) === 30);
check('BJ: 2+3+5 = 10', Blackjack.handValue([{ rank: '2', suit: '♠' }, { rank: '3', suit: '♥' }, { rank: '5', suit: '♦' }]) === 10);

check('BJ: handLabel vacío = ""', Blackjack.handLabel([]) === '');
check('BJ: handLabel 10+5 = "15"', Blackjack.handLabel([{ rank: '10', suit: '♠' }, { rank: '5', suit: '♥' }]) === '15');
check('BJ: handLabel A+6 = "7 / 17" (as flexible)', Blackjack.handLabel([{ rank: 'A', suit: '♠' }, { rank: '6', suit: '♥' }]) === '7 / 17');
check('BJ: handLabel 10+7 = "17" (sin as flexible)', Blackjack.handLabel([{ rank: '10', suit: '♠' }, { rank: '7', suit: '♥' }]) === '17');

// cardHTML
const redCard = { rank: 'K', suit: '♥' };
const blackCard = { rank: '7', suit: '♠' };
const faceDown = Blackjack.cardHTML(null, true);
check('BJ: cardHTML boca abajo = .face-down', faceDown.includes('face-down') && faceDown.includes('♠'));
check('BJ: cardHTML rojo incluye .red', Blackjack.cardHTML(redCard).includes('red'));
check('BJ: cardHTML negro NO incluye .red', !Blackjack.cardHTML(blackCard).includes('red'));
check('BJ: cardHTML contiene rank', Blackjack.cardHTML(redCard).includes('K'));
check('BJ: cardHTML contiene suit', Blackjack.cardHTML(redCard).includes('♥'));

// withFly
check('BJ: withFly inserta fly-in y animation-delay',
  Blackjack.withFly('<div class="playing-card"></div>', 0.5).includes('fly-in') &&
  Blackjack.withFly('<div class="playing-card"></div>', 0.5).includes('animation-delay:0.50s'));

// splitHTML
const p = {
  splitHands: [
    { hand: [{ rank: '8', suit: '♠' }, { rank: '8', suit: '♥' }], bet: 50, result: '', played: false },
    { hand: [{ rank: '3', suit: '♣' }, { rank: '5', suit: '♦' }], bet: 50, result: '', played: false },
  ],
  activeHand: 0,
};
const counts = {};
const splitHTML = Blackjack.splitHTML(p, true, counts, 'ace');
check('BJ: splitHTML genera contenedor de manos', splitHTML.includes('split-hands'));
check('BJ: splitHTML incluye Mano 1 ◀ Turno', splitHTML.includes('Mano 1 ◀ Turno'));
check('BJ: splitHTML incluye Mano 2', splitHTML.includes('Mano 2'));
check('BJ: splitHTML muestra scores', splitHTML.includes('8 / 16') || splitHTML.includes('16'));
check('BJ: splitHTML contiene apuestas', splitHTML.includes('bet-circle') && splitHTML.includes('>50<'));
check('BJ: splitHTML genera fly-in en cartas nuevas', splitHTML.includes('fly-in'));

// splitHTML: jugador inactivo (no es su turno)
const p2 = {
  splitHands: [
    { hand: [{ rank: '10', suit: '♠' }, { rank: '7', suit: '♥' }], bet: 50, result: '😢', played: true },
  ],
  activeHand: 0,
};
const counts2 = {};
const splitHTML2 = Blackjack.splitHTML(p2, false, counts2, 'folded');
check('BJ: splitHTML jugador retirado NO tiene hand-active', !splitHTML2.includes('hand-active'));
check('BJ: splitHTML jugador retirado muestra resultado', splitHTML2.includes('😢'));

// splitHTML: split incremental (add hand)
// Simula el caso: había 1 mano (counts total = 1, mano 0 = 1 carta),
// ahora el jugador hace split y tiene 2 manos.
const p3 = { splitHands: [
  { hand: [{ rank: '8', suit: '♠' }], bet: 50, result: '', played: false },
  { hand: [{ rank: '3', suit: '♣' }], bet: 50, result: '', played: false },
]};
const counts3 = { 'ace-split-total': 1, 'ace-split-0': 1 };
const splitHTML3 = Blackjack.splitHTML(p3, true, counts3, 'ace');
check('BJ: splitHTML split incremental actualiza counts', counts3['ace-split-total'] === 2 && counts3['ace-split-1'] === 1);
check('BJ: splitHTML split incremental crea nueva mano', splitHTML3.includes('Mano 2'));

// --- Net.leave(): al salir de la mesa, las fichas ganadas/perdidas pasan al saldo ---
load('js/auth.js', 'Auth');
load('js/net.js', 'Net');
let leaveReq = null;
let leaveReply = { ok: true, chips: 1500 };
const realFetch = global.fetch; // HTTP real para los tests de admin (tras el stub)
global.fetch = async (url, opts) => {
  leaveReq = JSON.parse((opts && opts.body) || '{}');
  return { ok: true, status: 200, json: async () => leaveReply };
};

(async () => {
  // Ganas y sales: el saldo local sube, se envía el playerId y el token de la cuenta
  Auth.token = 'tok-123'; Auth.user = null;
  Net.code = 'ABCD'; Net.playerId = 'pid-1';
  leaveReply = { ok: true, chips: 1500 };
  await Net.leave();
  check('Net: al salir, las fichas de la mesa se aplican al saldo (ganas -> 1500)', App.chips === 1500);
  check('Net: el leave envía el token de sesión para guardarlo en la cuenta', leaveReq && leaveReq.token === 'tok-123');
  check('Net: el leave envía el playerId propio', leaveReq && leaveReq.playerId === 'pid-1');
  check('Net: al salir se limpia la sesión de sala', Net.code === null);

  // Pierdes y sales: el saldo local baja
  Net.code = 'EFGH'; Net.playerId = 'pid-2';
  leaveReply = { ok: true, chips: 800 };
  await Net.leave();
  check('Net: al salir tras perder, el saldo baja (pierdes -> 800)', App.chips === 800);

  // La sala ya no existe (expiró): no se pisa el saldo local con null
  Net.code = 'IJKL'; Net.playerId = 'pid-3';
  leaveReply = { ok: true };
  await Net.leave();
  check('Net: si la sala ya no existe no se pisa el saldo', App.chips === 800);

  // Sin cuenta (invitado): el saldo local sí se aplica y no se manda token
  Auth.token = null;
  Net.code = 'MNOP'; Net.playerId = 'pid-4';
  leaveReply = { ok: true, chips: 900 };
  await Net.leave();
    check('Net: invitado: saldo local aplicado sin token', App.chips === 900 && !leaveReq.token);

  // ---------- Panel de admin: ban, kick y permisos (servidor real) ----------
  const stamp = Date.now();
  process.env.USERS_FILE = require('path').join(os.tmpdir(), 'smoke-adm-users-' + stamp + '.json');
  process.env.ROOMS_FILE = require('path').join(os.tmpdir(), 'smoke-adm-rooms-' + stamp + '.json');
  process.env.TX_FILE = require('path').join(os.tmpdir(), 'smoke-adm-tx-' + stamp + '.json');
  process.env.BETTING_FILE = require('path').join(os.tmpdir(), 'smoke-betting-' + stamp + '.json');
  process.env.JACKPOT_FILE = require('path').join(os.tmpdir(), 'smoke-jackpot-' + stamp + '.json');
  const srv = require('../server.js');
  global.fetch = realFetch; // de aquí en adelante, HTTP real contra el servidor
  const port = await new Promise(res => srv.server.listen(0, () => res(srv.server.address().port)));
  const base = 'http://127.0.0.1:' + port;
  const post = async (p, b) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
    return { status: r.status, data: await r.json() };
  };
  const slotApi = await post('/api/rooms', { name: 'Slot API', game: 'book-of-fran', chips: 1000 });
  const slotRoom = srv.rooms.get(slotApi.data.code);
  slotRoom._random = () => 0.999; // 15 libros: trigger sin premiobase
  const slotSpin = await post('/api/rooms/' + slotApi.data.code + '/action', {
    playerId: slotApi.data.playerId, type: 'spin', activeLines: 3, betPerLine: 20,
  });
  const slotTooFast = await post('/api/rooms/' + slotApi.data.code + '/action', {
    playerId: slotApi.data.playerId, type: 'spin', activeLines: 3, betPerLine: 20,
  });
  check('Book of Fran API: cobra 3 × 20, activa 10 giros y limita la frecuencia',
    slotApi.status === 200 && slotSpin.status === 200 && slotSpin.data.game === 'book-of-fran' &&
    slotSpin.data.players[0].chips === 940 && slotSpin.data.players[0].freeSpins === SLOT_CONFIG.FREE_SPINS_AWARDED &&
    slotSpin.data.players[0].lastResult.totalBet === 60 && slotTooFast.status === 400);

  const slotRolls = Array(15).fill(0.994); // corona: el trigger anterior la eligió para expandir
  let slotCursor = 0;
  slotRoom._random = () => slotRolls[slotCursor++] ?? 0;
  slotRoom._lastSpinAt.clear();
  const slotFree = await post('/api/rooms/' + slotApi.data.code + '/action', { playerId: slotApi.data.playerId, type: 'spin' });
  check('Book of Fran API: el giro gratis no cobra y expande el símbolo en 5x3',
    slotFree.status === 200 && slotFree.data.players[0].lastResult.mode === 'free' &&
    slotFree.data.players[0].lastResult.totalBet === 0 && slotFree.data.players[0].lastResult.expandedReels.length === 5 &&
    slotFree.data.players[0].lastResult.grid.every(reel => reel.length === 3));

  const brokeApi = await post('/api/rooms', { name: 'Slot broke', game: 'book-of-fran', chips: 30 });
  const brokeSpin = await post('/api/rooms/' + brokeApi.data.code + '/action', {
    playerId: brokeApi.data.playerId, type: 'spin', activeLines: 10, betPerLine: 5,
  });
  check('Book of Fran API: rechaza un coste de 50 con saldo de 30 sin mutarlo',
    brokeSpin.status === 400 && srv.rooms.get(brokeApi.data.code).find(brokeApi.data.playerId).chips === 30);

  const payGrid = [
    ['9', 'J', 'Q'], ['9', 'J', 'A'], ['9', 'J', 'K'], ['10', 'Q', '9'], ['A', '10', 'K'],
  ];
  const twoPaylines = evaluateGrid(payGrid, 5, 2);
  const smokePays = id => SYMBOLS.find(symbol => symbol.id === id).pays;
  check('Book of Fran API: las líneas ganadoras suman el pago de cada línea',
    twoPaylines.lines.length === 2 && twoPaylines.lines.every(line => line.count === 3) &&
    twoPaylines.win === Math.floor(5 * smokePays('9')[3]) + Math.floor(5 * smokePays('J')[3]));

  // ---------- Jackpot progresivo compartido ----------
  // Reinicia el singleton para aislar este flujo y fija el shuffle del servidor.
  srv.slotJackpot.jackpotPool = 100;
  srv.slotJackpot.updatedAt = Date.now();
  srv.slotJackpot.saveLocal();
  srv.slotJackpot.random = () => 0;
  const jackpotUser = await post('/api/auth/register', { name: 'JackpotUser', password: 'jackpot123', chips: 1000 });
  const jackpotRoom = await post('/api/rooms', {
    name: 'JackpotUser', game: 'book-of-fran', chips: 1000, token: jackpotUser.data.token,
  });
  const jackpotRoomRef = srv.rooms.get(jackpotRoom.data.code);
  const noPendingPick = await post('/api/slots/jackpot/pick', { token: jackpotUser.data.token, box: 1 });
  check('Jackpot API: elegir caja sin trigger pendiente devuelve 409', noPendingPick.status === 409);

  const ordinaryRolls = [
    0.10, 0.10, 0.10, // reel 0: 9
    0.30, 0.30, 0.30, // reel 1: 10
    0.50, 0.50, 0.50, // reel 2: J
    0.65, 0.65, 0.65, // reel 3: Q
    0.75, 0.75, 0.75, // reel 4: K
  ];
  let jackpotCursor = 0;
  jackpotRoomRef._random = () => ordinaryRolls[jackpotCursor++] ?? 0;
  const jackpotContribution = await post('/api/rooms/' + jackpotRoom.data.code + '/action', {
    playerId: jackpotRoom.data.playerId, type: 'spin', activeLines: 3, betPerLine: 25,
  });
  check('Book of Fran API: cada apuesta añade apuesta × 2% redondeado al bote',
    jackpotContribution.status === 200 && jackpotContribution.data.players[0].lastResult.jackpotContribution === 2 &&
    jackpotContribution.data.jackpot.jackpotPool === 102);

  jackpotCursor = 0;
  jackpotRoomRef._random = () => .999; // 15 libros y elección de 9 expandido
  jackpotRoomRef._lastSpinAt.clear();
  const jackpotTrigger = await post('/api/rooms/' + jackpotRoom.data.code + '/action', {
    playerId: jackpotRoom.data.playerId, type: 'spin', activeLines: 3, betPerLine: 20,
  });
  check('Book of Fran API: tres libros conceden free spins y un jackpotPick pendiente',
    jackpotTrigger.status === 200 && jackpotTrigger.data.players[0].lastResult.jackpotPick === true &&
    jackpotTrigger.data.players[0].lastResult.awarded === SLOT_CONFIG.FREE_SPINS_AWARDED &&
    jackpotTrigger.data.jackpot.jackpotPool === 103);

  const jackpotPick = await post('/api/slots/jackpot/pick', { token: jackpotUser.data.token, box: 1 });
  const expectedJackpot = Math.round(103 * .20); // RNG 0 deja SILVER en la caja 1
  const expectedChips = 1000 - 75 - 60 + expectedJackpot;
  check('Book of Fran API: el pick paga la caja, resetea el bote y sincroniza el saldo',
    jackpotPick.status === 200 && jackpotPick.data.box === 1 && jackpotPick.data.tier === 'SILVER' &&
    jackpotPick.data.value === expectedJackpot && jackpotPick.data.jackpot.jackpotPool === 100 &&
    jackpotPick.data.boxes.length === 3 && jackpotPick.data.user.chips === expectedChips);

  const repeatPick = await post('/api/slots/jackpot/pick', { token: jackpotUser.data.token, box: 2 });
  check('Book of Fran API: el mismo pick no puede cobrarse dos veces', repeatPick.status === 409 && srv.slotJackpot.jackpotPool === 100);

  jackpotCursor = 0;
  jackpotRoomRef._random = () => ordinaryRolls[jackpotCursor++] ?? 0;
  jackpotRoomRef._lastSpinAt.clear();
  const afterPickFree = await post('/api/rooms/' + jackpotRoom.data.code + '/action', { playerId: jackpotRoom.data.playerId, type: 'spin' });
  check('Book of Fran API: los free spins siguen funcionando después del pick',
    afterPickFree.status === 200 && afterPickFree.data.players[0].lastResult.mode === 'free' &&
    afterPickFree.data.players[0].lastResult.totalBet === 0 && afterPickFree.data.players[0].freeSpins === 9);

  const txAfterJackpot = await (await fetch(base + '/api/transactions?limit=20')).json();
  check('Jackpot API: la consola registra el premio GOLD/SILVER/BRONZE',
    txAfterJackpot.transactions.some(entry => entry.type === 'win' && /JACKPOT SILVER/.test(entry.message || '')));
  const reloadedJackpot = new SlotJackpot({ filePath: process.env.JACKPOT_FILE, seed: 100, remote: null });
  check('Jackpot API: el bote persiste en disco tras reiniciar el servicio',
    fs.existsSync(process.env.JACKPOT_FILE) && reloadedJackpot.jackpotPool === 100);

  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, data: await r.json() };
  };

  // ---------- Chat de sala (viaja en el estado del long-poll) ----------
  const chatCreated = await post('/api/rooms', { name: 'Ana chat', game: 'blackjack' });
  const chatCode = chatCreated.data.code;
  const chatA = chatCreated.data.playerId;
  const chatJoin = await post('/api/rooms/' + chatCode + '/join', { name: 'Bruno chat' });
  const chatB = chatJoin.data.playerId;
  const versionBeforeChat = srv.rooms.get(chatCode).version;
  const stateForB = get('/api/rooms/' + chatCode + '/state?player=' + chatB + '&v=' + versionBeforeChat);
  await new Promise(resolve => setTimeout(resolve, 75)); // deja el GET sospechoso esperando
  const sentChat = await post('/api/rooms/' + chatCode + '/chat', {
    playerId: chatA,
    text: '  Hola   mesa  ',
  });
  const chatForB = await Promise.race([
    stateForB,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('El long-poll del chat no se despertó')), 1500)),
  ]);
  check('Chat: un jugador publica, despierta a otro y este lo recibe en /state',
    sentChat.status === 200 && chatForB.status === 200 && chatForB.data.version > versionBeforeChat &&
    chatForB.data.chat.some(m => m.id === sentChat.data.message.id && m.playerId === chatA &&
      m.name === 'Ana chat' && m.text === 'Hola mesa'));

  const outsiderRoom = await post('/api/rooms', { name: 'Ajena' });
  const outsiderSend = await post('/api/rooms/' + chatCode + '/chat', {
    playerId: outsiderRoom.data.playerId,
    text: 'No pertenezco',
  });
  check('Chat: un playerId de otra sala recibe 403', outsiderSend.status === 403);

  const emptyChat = await post('/api/rooms/' + chatCode + '/chat', { playerId: chatA, text: '   \t  ' });
  const emptyTypeChat = await post('/api/rooms/' + chatCode + '/chat', { playerId: chatA, text: 123 });
  check('Chat: mensajes vacíos, solo espacios o no text reciben 400',
    emptyChat.status === 400 && emptyTypeChat.status === 400);

  const longText = '😀'.repeat(CHAT_MAX_LENGTH + 15);
  const longSent = await post('/api/rooms/' + chatCode + '/chat', { playerId: chatB, text: longText });
  check('Chat: el texto largo se recorta de forma consistente a 200 caracteres',
    longSent.status === 200 && Array.from(longSent.data.message.text).length === CHAT_MAX_LENGTH);

  const chatRoom = srv.rooms.get(chatCode);
  chatRoom.chatLastSent.set(chatA, 0);
  const firstRate = await post('/api/rooms/' + chatCode + '/chat', { playerId: chatA, text: 'Primero' });
  const tooSoon = await post('/api/rooms/' + chatCode + '/chat', { playerId: chatA, text: 'Demasiado rápido' });
  check('Chat: el segundo mensaje inmediato recibe 429 con error claro',
    firstRate.status === 200 && tooSoon.status === 429 && /espera/i.test(tooSoon.data.error || ''));
  await new Promise(resolve => setTimeout(resolve, CHAT_COOLDOWN_MS + 60));
  const afterRate = await post('/api/rooms/' + chatCode + '/chat', { playerId: chatA, text: 'Ya ha pasado' });
  check('Chat: el mismo jugador puede enviar después del tiempo de espera', afterRate.status === 200);

  for (let i = 0; i < 56; i++) {
    chatRoom.chatLastSent.set(chatA, 0); // la prueba de masa no debe esperar 1 s por mensaje
    const bulkMessage = await post('/api/rooms/' + chatCode + '/chat', { playerId: chatA, text: 'Carga ' + i });
    if (bulkMessage.status !== 200) break;
  }
  const cappedChat = await get('/api/rooms/' + chatCode + '/state?player=' + chatB + '&v=0');
  check('Chat: la sala conserva como máximo los 50 mensajes más recientes',
    cappedChat.status === 200 && cappedChat.data.chat.length === 50 &&
    cappedChat.data.chat[cappedChat.data.chat.length - 1].text === 'Carga 55');

  // Cuentas: franelnomada queda como admin por defecto (ADMIN_USERS)
  const admReg = await post('/api/auth/register', { name: 'franelnomada', password: 'admin123', chips: 1000 });
  check('Admin: franelnomada se registra como administrador', admReg.status === 200 && admReg.data.user.isAdmin === true);
  const admToken = admReg.data.token;
  const vicReg = await post('/api/auth/register', { name: 'victima', password: 'vic1234', chips: 1000 });
  const vicKey = 'victima';
  const vicToken = vicReg.data.token;
  const rndReg = await post('/api/auth/register', { name: 'rando', password: 'rando12', chips: 1000 });
  const rndToken = rndReg.data.token;

  // Un usuario normal no puede banear ni patear (403)
  const noBan = await post('/api/admin/users/' + vicKey + '/ban', { token: rndToken });
  check('Admin: sin permisos, ban devuelve 403', noBan.status === 403);

  // Banear: corta sesión e impide el login con error claro (no cuelga)
  const ban1 = await post('/api/admin/users/' + vicKey + '/ban', { token: admToken });
  check('Admin: el admin banea correctamente', ban1.status === 200 && ban1.data.user.banned === true);
  const blocked = await post('/api/auth/login', { name: 'victima', password: 'vic1234' });
  check('Admin: banear impide el login (403, mensaje claro)', blocked.status === 403 && /suspendida/i.test(blocked.data.error || ''));
  const meDead = await get('/api/auth/me?token=' + encodeURIComponent(vicToken));
  check('Admin: la sesión del baneado deja de valer (me -> 401)', meDead.status === 401);

  // Desbanear rehabilita el login con normalidad
  const unban = await post('/api/admin/users/' + vicKey + '/unban', { token: admToken });
  const backIn = await post('/api/auth/login', { name: 'victima', password: 'vic1234' });
  check('Admin: desbanear permite volver a entrar', unban.status === 200 && backIn.status === 200 && !!backIn.data.token);
  const vicToken2 = backIn.data.token;

  // Kick por playerId: sale de la mesa, se liquida su saldo y lo ve en el sondeo
  const created = await post('/api/rooms', { name: 'Victima', game: 'blackjack', chips: 500, token: vicToken2 });
  const code = created.data.code;
  const pid = created.data.playerId;
  const roomsList = await get('/api/admin/rooms?token=' + encodeURIComponent(admToken));
  check('Admin: /api/admin/rooms lista la sala con playerId',
    roomsList.status === 200 && roomsList.data.rooms.some(r =>
      r.code === code && r.players.some(p => p.playerId === pid && p.chips === 500)));
  const noKick = await post('/api/admin/rooms/' + code + '/kick', { token: rndToken, playerId: pid });
  check('Admin: kick sin permisos devuelve 403', noKick.status === 403);
  const kick = await post('/api/admin/rooms/' + code + '/kick', { token: admToken, playerId: pid });
  check('Admin: el admin expulsa al jugador', kick.status === 200 && kick.data.chips === 500);
  const stKicked = await get('/api/rooms/' + code + '/state?player=' + pid + '&v=0');
  check('Admin: el expulsado ve kicked en su siguiente sondeo', stKicked.status === 200 && stKicked.data.kicked === true);
  const afterKick = await get('/api/auth/me?token=' + encodeURIComponent(vicToken2));
  check('Admin: el kick liquida las fichas de la mesa en la cuenta (500)',
    afterKick.status === 200 && afterKick.data.user.chips === 500);

  // Banear a alguien sentado: sale de la mesa liquidando y pierde la sesión
  const seated = await post('/api/rooms', { name: 'Victima', game: 'blackjack', chips: 777, token: vicToken2 });
  const seatCode = seated.data.code;
  const seatPid = seated.data.playerId;
  const ban2 = await post('/api/admin/users/' + vicKey + '/ban', { token: admToken });
  check('Admin: banear a un jugador sentado lo expulsa de la mesa', ban2.status === 200);
  const seatKick = await get('/api/rooms/' + seatCode + '/state?player=' + seatPid + '&v=0');
  check('Admin: el baneado de la mesa ve kicked', seatKick.status === 200 && seatKick.data.kicked === true);
  const meSeat = await get('/api/auth/me?token=' + encodeURIComponent(vicToken2));
  check('Admin: el saldo de la mesa (777) queda liquidado y la sesión muerta',
    meSeat.status === 401 && srv.userStore.users.get(vicKey).chips === 777);
  const blocked2 = await post('/api/auth/login', { name: 'victima', password: 'vic1234' });
  check('Admin: tras el ban, el login sigue bloqueado', blocked2.status === 403);

  // Añadir/eliminar fichas desde el panel: sumar, restar, sin bajar de 0
  const unban2 = await post('/api/admin/users/' + vicKey + '/unban', { token: admToken });
  check('Admin: desbanear para probar fichas', unban2.status === 200);
  const chipsBase = srv.userStore.users.get(vicKey).chips;
  const addNo = await post('/api/admin/users/' + vicKey + '/chips', { token: rndToken, delta: 100 });
  check('Admin: ajustar fichas sin permisos devuelve 403', addNo.status === 403);
  const addBad = await post('/api/admin/users/' + vicKey + '/chips', { token: admToken, delta: 0 });
  check('Admin: ajustar fichas con cantidad no válida devuelve 400', addBad.status === 400);
  const addOk = await post('/api/admin/users/' + vicKey + '/chips', { token: admToken, delta: 500 });
  check('Admin: el admin añade 500 fichas (antes ' + chipsBase + ' -> ' + addOk.data.after + ')',
    addOk.status === 200 && addOk.data.after === chipsBase + 500);
  const subOk = await post('/api/admin/users/' + vicKey + '/chips', { token: admToken, delta: -200 });
  check('Admin: el admin quita 200 fichas (después ' + subOk.data.after + ')',
    subOk.status === 200 && subOk.data.after === chipsBase + 300);
  const over = await post('/api/admin/users/' + vicKey + '/chips', { token: admToken, delta: -99999999 });
  check('Admin: quitar de más deja el saldo en 0 sin bajar de ahí',
    over.status === 200 && over.data.after === 0);

  // ---------- Consola de transacciones pública (lobby) ----------
  const { MAX_ENTRIES } = require('../js/transactions.js');
  const txAll = async () => ((await get('/api/transactions')).data.transactions) || [];
  const txOpen = await get('/api/transactions');
  check('TX: /api/transactions es público y responde 200',
    txOpen.status === 200 && txOpen.data.ok === true && Array.isArray(txOpen.data.transactions));

  // Ganar: el saldo sube al salir de la mesa -> entrada 'win'
  const hugoReg = await post('/api/auth/register', { name: 'Hugo', password: 'hugo123', chips: 1000 });
  const hugoRoom = await post('/api/rooms', { name: 'Hugo', game: 'blackjack', chips: 1000, token: hugoReg.data.token });
  srv.rooms.get(hugoRoom.data.code).find(hugoRoom.data.playerId).chips = 1500; // la mesa rinde 500 de más
  const hugoLeave = await post('/api/rooms/' + hugoRoom.data.code + '/leave',
    { playerId: hugoRoom.data.playerId, token: hugoReg.data.token });
  const winEntry = (await txAll()).find(t => t.username === 'Hugo');
  check('TX: ganar al salir crea una entrada win con amount y game correctos',
    hugoLeave.status === 200 && hugoLeave.data.chips === 1500 && !!winEntry &&
    winEntry.type === 'win' && winEntry.amount === 500 &&
    winEntry.game === 'blackjack' && winEntry.balanceAfter === 1500);

  // Perder: el saldo baja al salir -> entrada 'loss' (con el juego de la mesa)
  const martaReg = await post('/api/auth/register', { name: 'Marta', password: 'marta123', chips: 1000 });
  const martaRoom = await post('/api/rooms', { name: 'Marta', game: 'poker', blindMinutes: 5, chips: 1000, token: martaReg.data.token });
  srv.rooms.get(martaRoom.data.code).find(martaRoom.data.playerId).chips = 760;
  const martaLeave = await post('/api/rooms/' + martaRoom.data.code + '/leave',
    { playerId: martaRoom.data.playerId, token: martaReg.data.token });
  const lossEntry = (await txAll()).find(t => t.username === 'Marta');
  check('TX: perder al salir crea una entrada loss con amount y game correctos',
    martaLeave.status === 200 && !!lossEntry &&
    lossEntry.type === 'loss' && lossEntry.amount === 240 &&
    lossEntry.game === 'poker' && lossEntry.balanceAfter === 760);

  // Invitado sin cuenta: aparece con su nombre de sala
  const ghostRoom = await post('/api/rooms', { name: 'InvitadoX', game: 'roulette', chips: 800 });
  srv.rooms.get(ghostRoom.data.code).find(ghostRoom.data.playerId).chips = 950;
  await post('/api/rooms/' + ghostRoom.data.code + '/leave', { playerId: ghostRoom.data.playerId });
  const guestEntry = (await txAll()).find(t => t.username === 'InvitadoX');
  check('TX: un invitado sin cuenta se registra con su nombre de sala',
    !!guestEntry && guestEntry.type === 'win' && guestEntry.amount === 150 &&
    guestEntry.game === 'roulette' && guestEntry.balanceAfter === 950);

  // Sin cambio de saldo al salir -> no se registra nada (ni con cuenta ni invitado)
  const nicoReg = await post('/api/auth/register', { name: 'Nico', password: 'nico1234', chips: 1000 });
  const nicoRoom = await post('/api/rooms', { name: 'Nico', game: 'blackjack', chips: 1000, token: nicoReg.data.token });
  await post('/api/rooms/' + nicoRoom.data.code + '/leave', { playerId: nicoRoom.data.playerId, token: nicoReg.data.token });
  const stayRoom = await post('/api/rooms', { name: 'Fantasma', game: 'blackjack', chips: 640 });
  await post('/api/rooms/' + stayRoom.data.code + '/leave', { playerId: stayRoom.data.playerId });
  const still = await txAll();
  check('TX: salir de la mesa sin cambio de saldo NO genera ninguna entrada',
    !still.some(t => t.username === 'Nico' || t.username === 'Fantasma'));

  // Ajustes del panel: delta + -> admin_grant, delta − -> admin_revoke (admin y afectado)
  const adminTxs = await txAll();
  const grant = adminTxs.find(t => t.type === 'admin_grant' && t.target === 'victima');
  const revoke = adminTxs.find(t => t.type === 'admin_revoke' && t.target === 'victima' &&
    t.balanceAfter === subOk.data.after);
  const wipe = adminTxs.find(t => t.type === 'admin_revoke' && t.target === 'victima' && t.balanceAfter === 0);
  check('TX: delta positivo crea admin_grant con el admin y el usuario afectado',
    !!grant && grant.username === 'franelnomada' && grant.amount === 500 &&
    grant.balanceAfter === addOk.data.after);
  check('TX: delta negativo crea admin_revoke con el admin y el usuario afectado',
    !!revoke && revoke.username === 'franelnomada' && revoke.amount === 200 && !!wipe);

  // ---------- Apuestas deportivas: API completa ----------
  const anaReg = await post('/api/auth/register', { name: 'Ana', password: 'ana12345', chips: 1000 });
  const luisReg = await post('/api/auth/register', { name: 'Luis', password: 'luis12345', chips: 1000 });
  const betAdminToken = admToken;
  const anaToken = anaReg.data.token;
  const luisToken = luisReg.data.token;
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const sportsEvent = title => ({
    title, teams: ['España', 'Alemania'], startsAt: future,
    markets: [{
      type: 'winner', label: 'Ganador',
      outcomes: [
        { label: 'Gana España', odds: 1.85 },
        { label: 'Empate', odds: 3.2 },
        { label: 'Gana Alemania', odds: 4.1 },
      ],
    }],
  });

  const createNo = await post('/api/admin/betting/events', { token: anaToken, ...sportsEvent('No permitido') });
  check('BET: un usuario no-admin no puede crear eventos (403)', createNo.status === 403);
  const sportsCreated = await post('/api/admin/betting/events', { token: betAdminToken, ...sportsEvent('España vs Alemania') });
  const event = sportsCreated.data.event;
  const market = event.markets[0];
  check('BET: el admin crea un evento abierto con mercados y cuotas',
    sportsCreated.status === 200 && event.status === 'open' && market.outcomes.length === 3 && market.outcomes[0].odds === 1.85);
  const publicList = await get('/api/betting/events');
  check('BET: la lista pública de eventos no necesita login',
    publicList.status === 200 && publicList.data.events.some(item => item.id === event.id));

  const place = await post('/api/betting/place', {
    token: anaToken, eventId: event.id, marketId: market.id,
    outcomeId: market.outcomes[0].id, stake: 100,
  });
  const anaAfterStake = await get('/api/auth/me?token=' + encodeURIComponent(anaToken));
  const minePending = await get('/api/betting/mine?token=' + encodeURIComponent(anaToken));
  check('BET: apostar descuenta el stake y crea la apuesta pendiente',
    place.status === 200 && place.data.bet.status === 'pending' && place.data.bet.odds === 1.85 &&
    anaAfterStake.data.user.chips === 900 && minePending.data.bets[0].id === place.data.bet.id);
  const loserBet = await post('/api/betting/place', {
    token: luisToken, eventId: event.id, marketId: market.id,
    outcomeId: market.outcomes[1].id, stake: 200,
  });
  const overStake = await post('/api/betting/place', {
    token: anaToken, eventId: event.id, marketId: market.id,
    outcomeId: market.outcomes[0].id, stake: 901,
  });
  const afterOver = await get('/api/auth/me?token=' + encodeURIComponent(anaToken));
  check('BET: no permite superar el saldo y no lo modifica (400)',
    loserBet.status === 200 && (overStake.status === 400 || overStake.status === 403) && afterOver.data.user.chips === 900);
  check('BET: permite apostar varias veces en el mismo mercado y las acumula',
    loserBet.data.bet.status === 'pending' && srv.bettingStore.bets.filter(b => b.eventId === event.id).length === 2);

  const lockNo = await post(`/api/admin/betting/events/${event.id}/lock`, { token: anaToken });
  const lockOk = await post(`/api/admin/betting/events/${event.id}/lock`, { token: betAdminToken });
  const lockedBet = await post('/api/betting/place', {
    token: anaToken, eventId: event.id, marketId: market.id,
    outcomeId: market.outcomes[0].id, stake: 10,
  });
  check('BET: bloquear exige admin y después ya no admite apuestas',
    lockNo.status === 403 && lockOk.status === 200 && lockOk.data.event.status === 'locked' &&
    (lockedBet.status === 400 || lockedBet.status === 403));

  const pastCreated = await post('/api/admin/betting/events', {
    token: betAdminToken, ...sportsEvent('Evento ya pasado'),
    startsAt: new Date(Date.now() - 1000).toISOString(),
  });
  const pastBet = await post('/api/betting/place', {
    token: anaToken, eventId: pastCreated.data.event.id, marketId: pastCreated.data.event.markets[0].id,
    outcomeId: pastCreated.data.event.markets[0].outcomes[0].id, stake: 10,
  });
  check('BET: un evento cuya hora ya pasó se bloquea automáticamente',
    pastCreated.data.event.status === 'locked' && (pastBet.status === 400 || pastBet.status === 403));

  const settleNo = await post(`/api/admin/betting/events/${event.id}/settle`, { token: anaToken, results: { [market.id]: market.outcomes[0].id } });
  const cancelNo = await post(`/api/admin/betting/events/${pastCreated.data.event.id}/cancel`, { token: anaToken });
  check('BET: un usuario no-admin recibe 403 al resolver y cancelar',
    settleNo.status === 403 && cancelNo.status === 403);
  const settled = await post(`/api/admin/betting/events/${event.id}/settle`, {
    token: betAdminToken, results: { [market.id]: market.outcomes[0].id },
  });
  const anaSettled = await get('/api/auth/me?token=' + encodeURIComponent(anaToken));
  const luisSettled = await get('/api/auth/me?token=' + encodeURIComponent(luisToken));
  const mineSettled = await get('/api/betting/mine?token=' + encodeURIComponent(anaToken));
  check('BET: resolver paga stake*odds al ganador y no toca al perdedor',
    settled.status === 200 && anaSettled.data.user.chips === 1085 && luisSettled.data.user.chips === 800);
  check('BET:Mis apuestas refleja los estados ganada y perdida',
    mineSettled.data.bets[0].status === 'won' &&
    (await get('/api/betting/mine?token=' + encodeURIComponent(luisToken))).data.bets[0].status === 'lost');


  // Cuotas congeladas: la edición posterior no cambia la apuesta ya creada
  const freezeCreated = await post('/api/admin/betting/events', { token: betAdminToken, ...sportsEvent('Cuotas congeladas') });
  const freezeEvent = freezeCreated.data.event;
  const freezeMarket = freezeEvent.markets[0];
  const frozenBet = await post('/api/betting/place', {
    token: anaToken, eventId: freezeEvent.id, marketId: freezeMarket.id,
    outcomeId: freezeMarket.outcomes[0].id, stake: 100,
  });
  const editedMarkets = JSON.parse(JSON.stringify(freezeEvent.markets));
  editedMarkets[0].outcomes[0].odds = 9;
  const edited = await post(`/api/admin/betting/events/${freezeEvent.id}/markets`, {
    token: betAdminToken, markets: editedMarkets,
  });
  await post(`/api/admin/betting/events/${freezeEvent.id}/lock`, { token: betAdminToken });
  await post(`/api/admin/betting/events/${freezeEvent.id}/settle`, {
    token: betAdminToken, results: { [freezeMarket.id]: freezeMarket.outcomes[0].id },
  });
  const anaFrozen = await get('/api/auth/me?token=' + encodeURIComponent(anaToken));
  check('BET: la cuota queda congelada aunque el admin edite el evento',
    frozenBet.data.bet.odds === 1.85 && edited.status === 200 &&
    edited.data.event.markets[0].outcomes[0].odds === 9 && anaFrozen.data.user.chips === 1170);

  // Cancelación: devuelve el stake exacto a todos los pendientes
  const betoReg = await post('/api/auth/register', { name: 'Beto', password: 'beto12345', chips: 1000 });
  const claraReg = await post('/api/auth/register', { name: 'Clara', password: 'clara12345', chips: 1000 });
  const cancelCreated = await post('/api/admin/betting/events', { token: betAdminToken, ...sportsEvent('Partido suspendido') });
  const cancelEvent = cancelCreated.data.event;
  const cancelMarket = cancelEvent.markets[0];
  await post('/api/betting/place', {
    token: betoReg.data.token, eventId: cancelEvent.id, marketId: cancelMarket.id,
    outcomeId: cancelMarket.outcomes[0].id, stake: 30,
  });
  await post('/api/betting/place', {
    token: claraReg.data.token, eventId: cancelEvent.id, marketId: cancelMarket.id,
    outcomeId: cancelMarket.outcomes[1].id, stake: 70,
  });
  const cancelled = await post(`/api/admin/betting/events/${cancelEvent.id}/cancel`, { token: betAdminToken });
  const betoCancelled = await get('/api/auth/me?token=' + encodeURIComponent(betoReg.data.token));
  const claraCancelled = await get('/api/auth/me?token=' + encodeURIComponent(claraReg.data.token));
  const betoMine = await get('/api/betting/mine?token=' + encodeURIComponent(betoReg.data.token));
  check('BET: cancelar devuelve el stake exacto a todos y marca refunded',
    cancelled.status === 200 && cancelled.data.refunded === 100 && betoCancelled.data.user.chips === 1000 &&
    claraCancelled.data.user.chips === 1000 && betoMine.data.bets[0].status === 'refunded');

  const bettingTxs = await txAll();
  check('BET: la consola existente registra apuesta, premio, pérdida y devolución',
    bettingTxs.some(t => t.type === 'betting_bet' && /ha apostado 100 fichas/.test(t.message || '')) &&
    bettingTxs.some(t => t.type === 'win' && /ha ganado 185 fichas/.test(t.message || '')) &&
    bettingTxs.some(t => t.type === 'loss' && /ha perdido su apuesta de 200 fichas/.test(t.message || '')) &&
    bettingTxs.some(t => t.type === 'betting_refund' && /apuestas? de 30 fichas devuelta/.test(t.message || '')));
  check('BET: eventos y apuestas quedan persistidos en BETTING_FILE',
    fs.existsSync(process.env.BETTING_FILE) && srv.bettingStore.events.size >= 4 && srv.bettingStore.bets.length >= 5);


  // El límite y el orden del endpoint (al final: la carga evicta las entradas ya verificadas)
  let lastId = null;
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    lastId = srv.txLog.add({ type: 'win', username: 'Carga' + i, game: 'blackjack', amount: 1, balanceAfter: i }).id;
  }
  const bulk = await get('/api/transactions');
  const bulkList = bulk.data.transactions || [];
  check('TX: GET devuelve como mucho el límite configurado',
    bulk.status === 200 && bulkList.length === MAX_ENTRIES);
  check('TX: GET devuelve las entradas de más reciente a más antigua',
    !!bulkList[0] && bulkList[0].id === lastId &&
    bulkList.every((t, i) => i === 0 || bulkList[i - 1].ts >= t.ts));

  await new Promise(res => srv.server.close(res));

  if (failures === 0) {
    console.log('\n✅ Smoke test pasado: todas las verificaciones correctas');
  } else {
    console.log('\n❌ Smoke test con ' + failures + ' fallo(s)');
    process.exit(1);
  }
})();
