const assert = require('node:assert/strict');
const vapid = require('../js/vapid.js');

// Par real generado con `npx web-push generate-vapid-keys`.
const PUBLIC = 'BCEWKMw7siwSzlUaa9SEjICcx5F2DdY9IQ2dxKQx2-R5TbJ0E4M-oF7-YwsJ2bI3CM2jJ48nkYHD6hdblyUuBOM';
const PRIVATE = '5cghwaQL1hJI5yMiNb1rLYuLjeVYvpFkkGTSUyvwh9E';

// Lo que suele pasar al copiar y pegar en el panel de Render.
assert.equal(vapid.clean('  "' + PUBLIC + '"  '), PUBLIC, 'Quita comillas y espacios');
assert.equal(vapid.clean("'" + PUBLIC + "'"), PUBLIC, 'Quita comillas simples');
assert.equal(vapid.clean('VAPID_PUBLIC_KEY=' + PUBLIC), PUBLIC, 'Quita el prefijo del panel');
assert.equal(vapid.clean(PUBLIC.slice(0, 20) + '\n  ' + PUBLIC.slice(20)), PUBLIC, 'Une líneas partidas');
assert.equal(vapid.clean('  -----BEGIN PRIVATE KEY-----\n' + PRIVATE + '\n'), PRIVATE, 'Quita cabecera PEM');
assert.equal(vapid.clean(undefined), '', 'Sin valor no inventa nada');
assert.equal(vapid.clean(''), '', 'Una cadena vacía sigue vacía');

// Un par válido se acepta tal cual.
const good = vapid.fromEnv({ VAPID_PUBLIC_KEY: PUBLIC, VAPID_PRIVATE_KEY: PRIVATE, VAPID_SUBJECT: 'mailto:yo@casino-laujar.onrender.com' });
assert.equal(good.enabled, true, 'Un par válido activa los avisos');
assert.deepEqual(good.missing, [], 'No falta ninguna variable');
assert.equal(good.publicKey, PUBLIC, 'La clave pública se entrega tal cual');
assert.equal(good.subjectOk, true, 'El asunto mailto: es válido');

// El mismo par "envalado" como llega de un panel: debe funcionar igual.
const dirty = vapid.fromEnv({
  VAPID_PUBLIC_KEY: ' "' + PUBLIC + ' " ',
  VAPID_PRIVATE_KEY: 'VAPID_PRIVATE_KEY=' + PRIVATE,
  VAPID_SUBJECT: 'mailto:yo@casino-laujar.onrender.com',
});
assert.equal(dirty.enabled, true, 'Las comillas y el prefijo no rompen la configuración');
assert.equal(dirty.publicKey, PUBLIC, 'La clave pública queda limpia');

// Claves rotas: se dicen cuáles y por qué, sin filtrar el valor.
const empty = vapid.fromEnv({});
assert.equal(empty.enabled, false, 'Sin claves no hay avisos');
assert.deepEqual(empty.missing, ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'], 'Se=listan las que faltan');
assert.equal(empty.diagnostics.VAPID_PUBLIC_KEY.reason, 'no está definida', 'Se explica el motivo');
assert.ok(!JSON.stringify(empty.diagnostics).includes(PRIVATE), 'El diagnóstico nunca incluye la clave privada');

const short = vapid.fromEnv({ VAPID_PUBLIC_KEY: 'BM8vYQ', VAPID_PRIVATE_KEY: PRIVATE });
assert.equal(short.enabled, false, 'Una clave truncada no se acepta');
assert.match(short.diagnostics.VAPID_PUBLIC_KEY.reason, /65 bytes/, 'Dice cuántos bytes debería decodificar');
assert.deepEqual(short.missing, ['VAPID_PUBLIC_KEY'], 'Solo marca la variable rota');

const junk = vapid.fromEnv({ VAPID_PUBLIC_KEY: PUBLIC + '!!', VAPID_PRIVATE_KEY: PRIVATE });
assert.equal(junk.enabled, false, 'Caracteres no base64url invalidan la clave');
assert.match(junk.diagnostics.VAPID_PUBLIC_KEY.reason, /base64url/, 'Dice que no es base64url');

// Una privada en formato PEM (con cabeceras dentro) se limpia y se acepta.
const pem = vapid.fromEnv({ VAPID_PUBLIC_KEY: PUBLIC, VAPID_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\n' + PRIVATE + '\n-----END PRIVATE KEY-----' });
assert.equal(pem.enabled, true, 'La clave privada pegada como PEM también vale');

// El asunto con formato raro se sustituye por uno válido en vez de romper push.
const badSubject = vapid.fromEnv({ VAPID_PUBLIC_KEY: PUBLIC, VAPID_PRIVATE_KEY: PRIVATE, VAPID_SUBJECT: 'admin@ejemplo.com' });
assert.equal(badSubject.subjectOk, false, 'Un asunto sin mailto:/https: no es válido');
assert.match(badSubject.subject, /^mailto:/, 'Se usa un asunto válido por defecto');
assert.equal(badSubject.enabled, true, 'El asunto no desactiva los avisos');

// ---- ensure: los avisos funcionan sin configurar nada a mano ----
// El fichero simula el almacenamiento del servidor (aquí, en memoria).
function fakeStore(initial) {
  const disk = { data: initial || {} };
  return {
    disk,
    read: () => JSON.parse(JSON.stringify(disk.data)),
    write: d => { disk.data = JSON.parse(JSON.stringify(d)); },
  };
}

// 1. Con un par válido en el entorno, manda el entorno.
{
  const store = fakeStore();
  const keys = vapid.ensure({ VAPID_PUBLIC_KEY: PUBLIC, VAPID_PRIVATE_KEY: PRIVATE }, null, store);
  assert.equal(keys.enabled, true, 'El par del entorno se usa tal cual');
  assert.equal(keys.origin, 'entorno', 'Se indica que vienen del entorno');
  assert.equal(keys.publicKey, PUBLIC, 'La clave pública es la del entorno');
  assert.equal(store.disk.data.vapidPublicKey, undefined, 'No se tocan las variables de entorno');
}

// 2. Sin variables, se genera un par y se guarda para el próximo arranque.
{
  const store = fakeStore();
  const keys = vapid.ensure({}, null, store);
  assert.equal(keys.enabled, true, 'Se genera un par válido si no hay nada');
  assert.equal(keys.origin, 'generadas', 'Se indica que son nuevas');
  assert.equal(keys.publicKey.length, 87, 'La clave pública generada es la de P-256 (87 caracteres)');
  assert.ok(vapid.isUncompressedPoint(keys.publicKey), 'La clave generada empieza por 0x04');
  assert.ok(store.disk.data.vapidPrivateKey, 'La privada queda guardada en el fichero');

  // 3. Al reiniciar se reutiliza ese mismo par: es lo que evita que las
  //    suscripciones guardadas dejen de valer.
  const again = vapid.ensure({}, null, fakeStore(store.disk.data));
  assert.equal(again.origin, 'guardado', 'En el segundo arranque se lee del fichero');
  assert.equal(again.publicKey, keys.publicKey, 'La clave pública no cambia entre reinicios');
  assert.equal(again.privateKey, keys.privateKey, 'La privada tampoco cambia');
}

// 4. Un par guardado pero corrupto se descarta y se genera otro.
{
  const store = fakeStore({ vapidPublicKey: 'basura', vapidPrivateKey: 'basura', subs: { x: 1 } });
  const keys = vapid.ensure({}, null, store);
  assert.equal(keys.enabled, true, 'Un par guardado corrupto no bloquea los avisos');
  assert.equal(keys.origin, 'generadas', 'Se genera un par nuevo en su lugar');
  assert.deepEqual(store.disk.data.subs, { x: 1 }, 'No se pisan las suscripciones ya guardadas');
}

// 5. Si el disco no responde, los avisos siguen funcionando (solo habría
//    que volver a suscribirse tras reiniciar).
{
  const broken = { read: () => { throw new Error('sin disco'); }, write: () => { throw new Error('sin disco'); } };
  const keys = vapid.ensure({}, null, broken);
  assert.equal(keys.enabled, true, 'Sin disco los avisos se activan igualmente');
  assert.equal(keys.origin, 'generadas', 'Se genera un par en memoria');
}

// 6. Un par guardado tiene prioridad sobre generar otro (evita invalidar
//    las suscripciones existentes aunque el entorno cambie).
{
  const store = fakeStore();
  const saved = vapid.ensure({}, null, store);
  const withOtherEnv = vapid.ensure({ VAPID_SUBJECT: 'mailto:otro@ejemplo.com' }, null, fakeStore(store.disk.data));
  assert.equal(withOtherEnv.origin, 'guardado', 'El par guardado gana si el entorno no trae claves');
  assert.equal(withOtherEnv.publicKey, saved.publicKey, 'La clave guardada se respeta');
  assert.equal(withOtherEnv.subject, 'mailto:otro@ejemplo.com', 'El asunto del entorno sí se respeta');
}

console.log('✅ VAPID: limpieza de comillas/espacios, validación y diagnóstico sin filtrar la clave privada');
console.log('✅ VAPID: claves automáticas persistentes (sin configurar el panel a mano)');