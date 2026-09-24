// ============================================================
//  L&F Casino Club — cliente REST mínimo para Firebase Realtime
//  Database. Sin dependencias: fetch global + JWT RS256 a mano
//  para cuentas de servicio. Lo comparten las cuentas
//  (js/users.js) y las salas (js/rooms-remote.js).
//
//  Config (objeto):
//    baseUrl        URL de la base, sin barra final
//    path           ruta del documento (ej. 'casino-laujar/users')
//    secret         Database secret (lo simple)
//    serviceAccount JSON de cuenta de servicio (lo seguro)
// ============================================================
const crypto = require('crypto');

// Token de cuenta de servicio en caché (por client_email): caduca a la hora,
// se renueva 10 min antes.
const TOKEN_CACHE = new Map();

class FirebaseRest {
  static configFromEnv(env, pathVar, defaultPath) {
    const e = env || process.env;
    const baseUrl = String(e.FIREBASE_DB_URL || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return null;
    let serviceAccount = null;
    const rawSa = String(e.FIREBASE_SERVICE_ACCOUNT || '').trim();
    if (rawSa) {
      try { serviceAccount = JSON.parse(rawSa); }
      catch (err) { serviceAccount = { _invalid: true }; }
    }
    return {
      baseUrl,
      path: String(e[pathVar] || defaultPath).replace(/^\/+|\/+$/g, ''),
      secret: String(e.FIREBASE_DB_SECRET || '').trim(),
      serviceAccount,
    };
  }

  static docUrl(config, auth) {
    return config.baseUrl + '/' + config.path + '.json' + (auth ? '?auth=' + encodeURIComponent(auth) : '');
  }

  static async remoteAuth(config) {
    if (!config) return '';
    if (config.secret) return config.secret;
    const sa = config.serviceAccount;
    if (!sa) return '';
    if (sa._invalid) throw new Error('FIREBASE_SERVICE_ACCOUNT no es un JSON válido.');
    if (!sa.client_email || !sa.private_key) throw new Error('La cuenta de servicio necesita client_email y private_key.');
    const cached = TOKEN_CACHE.get(sa.client_email);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
    const token = await FirebaseRest.serviceAccountToken(sa);
    TOKEN_CACHE.set(sa.client_email, { token, expiresAt: Date.now() + 50 * 60 * 1000 });
    return token;
  }

  // JWT RS256 firmado a mano (sin dependencias) para cuentas de servicio.
  static async serviceAccountToken(sa) {
    const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/userinfo.email',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    }));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(header + '.' + payload);
    signer.end();
    const signature = b64url(signer.sign(sa.private_key));
    const assertion = header + '.' + payload + '.' + signature;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
        '&assertion=' + encodeURIComponent(assertion),
    });
    if (!r.ok) throw new Error('Google rechaza la cuenta de servicio (' + r.status + ').');
    const data = await r.json();
    if (!data.access_token) throw new Error('Google no devolvió access_token.');
    return data.access_token;
  }

  static async fetchDoc(config, method, body) {
    const auth = await FirebaseRest.remoteAuth(config);
    const r = await fetch(FirebaseRest.docUrl(config, auth), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error('Firebase responde ' + r.status + '. Revisa URL, reglas y credenciales.');
    try { return await r.json(); } catch (e) { return null; }
  }

  static get(config) { return FirebaseRest.fetchDoc(config, 'GET'); }
  static put(config, doc) { return FirebaseRest.fetchDoc(config, 'PUT', doc); }
}

module.exports = { FirebaseRest };
