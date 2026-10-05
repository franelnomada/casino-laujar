// ============================================================
//  Claves VAPID: limpieza y validación.
//
//  Copiar y pegar claves desde un panel (Render, Notion, WhatsApp,
//  un correo...) arrastra comillas, espacios, saltos de línea e
//  incluso el prefijo "VAPID_PUBLIC_KEY=". web-push no lo tolera:
//  falla al firmar cada envío. Aquí se limpia el valor y, si aun
//  así no sirve, se explica el motivo exacto en vez de fallar en
//  silencio. Genera un par con:  npx web-push generate-vapid-keys
// ============================================================
'use strict';
const fs = require('fs');
const webpush = require('web-push');

// Longitudes de una clave VAPID P-256 en base64url: 65 bytes la
// pública (punto sin comprimir, prefijo 0x04) y 32 la privada.
const PUBLIC_BYTES = 65;
const PRIVATE_BYTES = 32;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
// Prefijos que se cuelan al pegar desde un dashboard o un .env.
const PREFIXES = [
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^-----BEGIN (PUBLIC|PRIVATE) KEY-----/,
  /^VAPID_(PUBLIC|PRIVATE)_KEY\s*[:=]\s*/i,
  /^(PUBLIC|PRIVATE)\s*KEY\s*[:=]\s*/i,
];
// El pie de un bloque PEM también hay que quitarlo, o se cuela en la clave.
const SUFFIXES = [/-----END [A-Z ]*PRIVATE KEY-----\s*$/, /-----END (PUBLIC|PRIVATE) KEY-----\s*$/];

// Devuelve el valor utilizable: sin comillas, sin espacios y sin el
// prefijo que trajera de origen. Si no hay nada, cadena vacía.
function clean(value) {
  if (typeof value !== 'string') return '';
  let out = value.trim();
  for (const suffix of SUFFIXES) out = out.replace(suffix, '').trim();
  for (const prefix of PREFIXES) out = out.replace(prefix, '').trim();
  // Comillas sueltas al principio o al final ("clave" o 'clave`).
  if (out.length > 1 && /^["'`]/.test(out) && /["'`]$/.test(out)) out = out.slice(1, -1).trim();
  // Espacios, tabuladores y saltos de línea internos.
  return out.replace(/\s+/g, '');
}

// Comprueba que sea base64url y que decodifique a los bytes correctos.
// Se decodifica y se vuelve a codificar: si el resultado no coincide,
// el valor tenía caracteres raros y Buffer los habría descartado en
// silencio (Buffer.from es permisivo).
function inspect(raw, expectedBytes) {
  const value = clean(raw);
  if (!value) return { present: false, ok: false, reason: 'no está definida' };
  if (!BASE64URL.test(value)) {
    return { present: true, ok: false, length: value.length, reason: 'no es base64url (¿le pegaste comillas o espacios dentro?)' };
  }
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch (e) {
    return { present: true, ok: false, length: value.length, reason: 'no se puede decodificar' };
  }
  if (bytes.toString('base64url') !== value) {
    return { present: true, ok: false, length: value.length, reason: 'base64url incompleto o con caracteres inválidos' };
  }
  if (bytes.length !== expectedBytes) {
    return {
      present: true,
      ok: false,
      length: value.length,
      bytes: bytes.length,
      reason: 'debe decodificar a ' + expectedBytes + ' bytes y decodifica a ' + bytes.length,
    };
  }
  return { present: true, ok: true, length: value.length, bytes: bytes.length };
}

// Punto sin comprimir de una clave pública P-256.
function isUncompressedPoint(value) {
  const bytes = Buffer.from(clean(value), 'base64url');
  return bytes.length === PUBLIC_BYTES && bytes[0] === 0x04;
}

// Normaliza las dos claves y el asunto tal y como llegan del entorno.
// Devuelve el par listo para web-push más el detalle de cada variable,
// para poder explicar en /api/push/key qué está mal.
function fromEnv(env) {
  const source = env || process.env || {};
  const publicKey = clean(source.VAPID_PUBLIC_KEY);
  const privateKey = clean(source.VAPID_PRIVATE_KEY);

  const publicInfo = inspect(source.VAPID_PUBLIC_KEY, PUBLIC_BYTES);
  const privateInfo = inspect(source.VAPID_PRIVATE_KEY, PRIVATE_BYTES);
  const subject = clean(source.VAPID_SUBJECT) || 'mailto:admin@casino-laujar.onrender.com';

  const missing = [];
  if (!publicInfo.ok) missing.push('VAPID_PUBLIC_KEY');
  if (!privateInfo.ok) missing.push('VAPID_PRIVATE_KEY');

  // El asunto lo acepta el estándar como mailto: o https:; si no, se
  // deja el de por defecto para que los push no se rechacen.
  const subjectOk = /^(mailto|https):/i.test(subject);

  return {
    publicKey,
    privateKey,
    subject: subjectOk ? subject : 'mailto:admin@casino-laujar.onrender.com',
    subjectOk,
    enabled: missing.length === 0 && isUncompressedPoint(publicKey),
    missing,
    // Detalle por variable. Nunca incluye el valor: solo longitudes y el
    // motivo, para poder depurar sin filtrar la clave privada.
    diagnostics: {
      VAPID_PUBLIC_KEY: publicInfo,
      VAPID_PRIVATE_KEY: privateInfo,
      subjectOk,
    },
  };
}

// Devuelve un par listo para web-push. Las variables de entorno tienen
// prioridad; si no hay un par válido ahí, se busca uno guardado en el
// fichero de datos y, si tampoco hay, se genera uno nuevo.
//
// Se guardan junto a las suscripciones a propósito: si el disco sobrevive,
// sobreviven las dos cosas, así que el navegador que se suscribió con la
// clave pública sigue reconociendo al servidor. Si el disco se pierde (es
// lo normal en un hosting efímero), se pierden también las suscripciones,
// de modo que regenerar la clave no rompe a nadie.
function ensure(env, store, ops) {
  const source = env || process.env || {};
  const fromEnvironment = fromEnv(source);
  if (fromEnvironment.enabled) {
    return { ...fromEnvironment, origin: 'entorno' };
  }

  const io = ops || {
    read: () => JSON.parse(fs.readFileSync(store, 'utf8')),
    write: data => fs.writeFileSync(store, JSON.stringify(data)),
  };

  // Segundo intento: un par guardado en el fichero de suscripciones.
  let data = null;
  try { data = io.read() || {}; } catch (e) { data = {}; }
  const saved = fromEnv({
    VAPID_PUBLIC_KEY: data.vapidPublicKey,
    VAPID_PRIVATE_KEY: data.vapidPrivateKey,
    VAPID_SUBJECT: source.VAPID_SUBJECT,
  });
  if (saved.enabled) return { ...saved, origin: 'guardado' };

  // Último recurso: generar el par ahora y anotarlo para el próximo arranque.
  const generated = webpush.generateVAPIDKeys();
  try {
    io.write({ ...data, vapidPublicKey: generated.publicKey, vapidPrivateKey: generated.privateKey });
  } catch (e) { /* sin disco: el push funciona, pero habrá que re-suscribir */ }
  const fresh = fromEnv({
    VAPID_PUBLIC_KEY: generated.publicKey,
    VAPID_PRIVATE_KEY: generated.privateKey,
    VAPID_SUBJECT: source.VAPID_SUBJECT,
  });
  return { ...fresh, origin: 'generadas' };
}

module.exports = { clean, inspect, isUncompressedPoint, fromEnv, ensure, PUBLIC_BYTES, PRIVATE_BYTES };