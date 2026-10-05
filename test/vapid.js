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

console.log('✅ VAPID: limpieza de comillas/espacios, validación y diagnóstico sin filtrar la clave privada');