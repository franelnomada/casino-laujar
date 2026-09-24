// ============================================================
//  L&F Casino Club — cuentas de jugador (registro, sesión y fichas)
//  Sin dependencias: hash scrypt + sal de node:crypto.
//
//  Persistencia en dos niveles:
//   1) Caché local en JSON (rápido, sobrevive a reinicios del
//      proceso en la misma instancia).
//   2) Remoto opcional en Firebase Realtime Database por REST
//      (sobrevive a redespliegues). Se activa con:
//        FIREBASE_DB_URL=https://<proyecto>-default-rtdb.firebaseio.com
//      y uno de:
//        FIREBASE_DB_SECRET=<secreto de la base de datos>  (simple)
//        FIREBASE_SERVICE_ACCOUNT=<JSON de cuenta de servicio> (seguro)
//      Sin esas variables, todo sigue funcionando solo con el fichero
//      local (ojo: en Render el disco es efímero y se pierde al
//      redesplegar, como pasaba hasta ahora).
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FirebaseRest } = require('./firebase-rest.js'); // cliente REST compartido

const NAME_MIN = 2;
const NAME_MAX = 14;
const PASS_MIN = 6;
const PASS_MAX = 64;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 días
const MAX_FAILS = 5;                          // intentos fallidos seguidos
const LOCK_MS = 60 * 1000;                    // bloqueo temporal de la cuenta
const MAX_CHIPS = 10000000;
const ADMIN_USERS = ['franelnomada', 'fran']; // administradores del casino (lowercase)
const DEFAULT_CHIPS = 1000;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const DEFAULT_USERS_FILE = 'casino-laujar-users.json';
const LEADERBOARD_DEFAULT = 10;
const LEADERBOARD_MAX = 25;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

class UserStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(os.tmpdir(), DEFAULT_USERS_FILE);
    this.users = new Map();    // nombre en minúsculas → cuenta
    this.sessions = new Map(); // token → { key, expiresAt }
    this.fails = new Map();    // nombre en minúsculas → { count, until } (solo memoria)
    this.remote = UserStore.remoteConfigFromEnv();
    this.remoteOk = false;
    this.remoteError = '';
    this.remoteLoaded = false; // true tras la primera carga remota con éxito
    this._pushTimer = null;
    this.load();
    // Carga remota en segundo plano: al terminar fusiona con lo local
    // (por updatedAt/expiresAt, nunca borra lo más nuevo).
    this._ready = this.remote ? this._initRemote() : Promise.resolve(false);
  }

  // ---------- Configuración remota (Firebase RTDB por REST) ----------
  static remoteConfigFromEnv(env) {
    return FirebaseRest.configFromEnv(env || process.env, 'FIREBASE_DB_PATH', 'casino-laujar/users');
  }

  ready() { return this._ready || Promise.resolve(false); }

  storageInfo() {
    return {
      backend: this.remote ? 'firebase' : 'local',
      remoteOk: this.remoteOk,
      remoteError: this.remote ? this.remoteError : 'sin configurar',
    };
  }

  // Guarda todo el estado en un solo documento: evita problemas con
  // caracteres prohibidos en claves de RTDB (el '.' de los nombres).
  snapshot() {
    return {
      users: [...this.users.values()],
      sessions: Object.fromEntries(this.sessions),
    };
  }

  normalizeUser(user) {
    if (!user || typeof user !== 'object') return null;
    if (!user.key || !user.hash || !user.salt) return null;
    // Migración de cuentas antiguas: aseguramos los campos nuevos
    if (user.banned === undefined) user.banned = false;
    if (user.isAdmin === undefined) user.isAdmin = ADMIN_USERS.includes(user.key);
    if (typeof user.chips !== 'number') user.chips = this.clampChips(user.chips);
    return user;
  }

  restoreSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return { users: 0, sessions: 0 };
    let users = 0;
    for (const user of raw.users || []) {
      const normalized = this.normalizeUser(user);
      if (normalized) {
        const prev = this.users.get(normalized.key);
        if (!prev || (normalized.updatedAt || 0) >= (prev.updatedAt || 0)) {
          this.users.set(normalized.key, normalized);
          users++;
        }
      }
    }
    let sessions = 0;
    const now = Date.now();
    for (const [token, session] of Object.entries(raw.sessions || {})) {
      if (session && session.expiresAt > now && this.users.has(session.key)) {
        const prev = this.sessions.get(token);
        if (!prev || session.expiresAt >= prev.expiresAt) {
          this.sessions.set(token, session);
          sessions++;
        }
      }
    }
    return { users, sessions };
  }

  async _initRemote() {
    try {
      const raw = await this.remoteGet();
      this.restoreSnapshot(raw);
      this.remoteLoaded = true;
      this.remoteOk = true;
      this.remoteError = '';
    this.save(); // deja la caché local al día
      return true;
    } catch (err) {
      this.remoteOk = false;
      this.remoteError = String((err && err.message) || err).slice(0, 160);
      return false;
    }
  }

  schedulePush() {
    if (!this.remote) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => {
      this._pushTimer = null;
      this.pushRemote().catch(() => { /* se reintenta en el próximo cambio */ });
    }, 1000);
    if (this._pushTimer.unref) this._pushTimer.unref();
  }

  async pushRemote() {
    if (!this.remote) return false;
    if (!this.remoteLoaded) {
      // La carga inicial falló o aún no terminó: NO machacar lo remoto con
      // la caché local a medias (borraría las cuentas del despliegue
      // anterior). Se reintenta la carga antes de escribir.
      try {
        this.restoreSnapshot(await this.remoteGet());
        this.remoteLoaded = true;
      } catch (err) {
        this.remoteOk = false;
        this.remoteError = String((err && err.message) || err).slice(0, 160);
        return false;
      }
    }
    try {
      await this.remotePut(this.snapshot());
      this.remoteOk = true;
      this.remoteError = '';
      return true;
    } catch (err) {
      this.remoteOk = false;
      this.remoteError = String((err && err.message) || err).slice(0, 160);
      return false;
    }
  }

  // El trabajo HTTP/JWT vive en js/firebase-rest.js (compartido con las salas).
  // Se le pasa this.remote en cada llamada: los tests cambian la configuración
  // en caliente y no debe quedar cacheada la del arranque.
  remoteDocUrl(auth) { return FirebaseRest.docUrl(this.remote, auth); }
  async remoteAuth() { return FirebaseRest.remoteAuth(this.remote); }
  async remoteFetch(method, body) { return FirebaseRest.fetchDoc(this.remote, method, body); }

  remoteGet() { return this.remoteFetch('GET'); }
  remotePut(doc) { return this.remoteFetch('PUT', doc); }

  // ---------- Disco ----------
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                                    for (const user of raw.users || []) {
        const normalized = this.normalizeUser(user);
        if (normalized) this.users.set(normalized.key, normalized);
      }
      const now = Date.now();
    for (const [token, session] of Object.entries(raw.sessions || {})) {
        if (session && session.expiresAt > now && this.users.has(session.key)) this.sessions.set(token, session);
      }
    } catch (e) { /* primera ejecución o fichero ilegible: empezamos limpios */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({
        users: [...this.users.values()],
        sessions: Object.fromEntries(this.sessions),
      }));
    } catch (e) { /* sin disco: seguimos solo en memoria */ }
    this.schedulePush(); // réplica remota (si Firebase está configurado)
  }

  // ---------- Nombres y validación ----------
  normalizeName(name) {
    return String(name === undefined || name === null ? '' : name).trim().replace(/\s+/g, ' ');
  }

  keyOf(name) {
    return this.normalizeName(name).toLowerCase();
  }

  validate(name, password) {
    const clean = this.normalizeName(name);
    if (clean.length < NAME_MIN) return 'El nombre debe tener al menos ' + NAME_MIN + ' caracteres.';
    if (clean.length > NAME_MAX) return 'El nombre no puede pasar de ' + NAME_MAX + ' caracteres.';
    if (!NAME_RE.test(clean)) return 'En el nombre solo valen letras, números, espacios, puntos, guiones y guiones bajos.';
    if (typeof password !== 'string' || password.length < PASS_MIN) return 'La contraseña debe tener al menos ' + PASS_MIN + ' caracteres.';
    if (password.length > PASS_MAX) return 'La contraseña no puede pasar de ' + PASS_MAX + ' caracteres.';
    return null;
  }

  clampChips(chips) {
    const value = Math.floor(Number(chips));
    if (!Number.isFinite(value)) return DEFAULT_CHIPS;
    return Math.max(0, Math.min(value, MAX_CHIPS));
  }

  // ---------- Cuentas ----------
  register(name, password, chips) {
    const error = this.validate(name, password);
    if (error) return { ok: false, status: 400, error };
    const clean = this.normalizeName(name);
    const key = clean.toLowerCase();
    if (this.users.has(key)) {
      return { ok: false, status: 409, error: 'Ese nombre ya está cogido. Entra con tu contraseña o elige otro.' };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      name: clean, key, salt,
      hash: hashPassword(password, salt),
      chips: this.clampChips(chips),
      banned: false,
      isAdmin: ADMIN_USERS.includes(key),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.users.set(key, user);
    const token = this.openSession(key);
    this.save();
    return { ok: true, token, user: this.publicUser(user) };
  }

  login(name, password) {
    const key = this.keyOf(name);
    if (this.isLocked(key)) {
      return { ok: false, status: 429, error: 'Demasiados intentos fallidos. Espera un minuto e inténtalo otra vez.' };
    }
    const user = this.users.get(key);
    if (!user || !this.checkPassword(user, password)) {
      this.fail(key);
      return { ok: false, status: 401, error: 'Nombre o contraseña incorrectos.' };
    }
    if (user.banned) {
      return { ok: false, status: 403, error: 'Esta cuenta ha sido suspendida.' };
    }
    this.fails.delete(key);
    const token = this.openSession(key);
    this.save();
    return { ok: true, token, user: this.publicUser(user) };
  }

  // ---------- Fichas ----------
  setChips(token, chips) {
    const user = this.userForToken(token);
    if (!user) return { ok: false, status: 401, error: 'Sesión no válida. Vuelve a entrar.' };
    const value = Math.floor(Number(chips));
    if (!Number.isFinite(value) || value < 0) return { ok: false, status: 400, error: 'Fichas no válidas.' };
    user.chips = Math.min(value, MAX_CHIPS);
    user.updatedAt = Date.now();
    this.save();
    return { ok: true, user: this.publicUser(user) };
  }

  // ---------- Clasificación pública (solo nombre y fichas) ----------
  leaderboard(limit) {
    let n = Math.floor(Number(limit));
    if (!Number.isFinite(n) || n <= 0) n = LEADERBOARD_DEFAULT;
    n = Math.min(n, LEADERBOARD_MAX);
    return [...this.users.values()]
      .map(u => ({ name: u.name, chips: u.chips }))
      .sort((a, b) => b.chips - a.chips || a.name.localeCompare(b.name, 'es'))
      .slice(0, n);
  }

  // ---------- Sesiones ----------
  openSession(key) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(token, { key, expiresAt: Date.now() + SESSION_TTL });
    this.gcSessions();
    return token;
  }

  userForToken(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
        if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      this.save();
      return null;
    }
    const user = this.users.get(session.key);
    if (!user) { this.sessions.delete(token); return null; }
    if (user.banned) { this.sessions.delete(token); this.save(); return null; }
    return user;
  }

  userByToken(token) {
    const user = this.userForToken(token);
    return user ? this.publicUser(user) : null;
  }

  logout(token) {
    this.sessions.delete(token);
    this.save();
    return { ok: true };
  }

  gcSessions() {
    const now = Date.now();
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token);
  }

  // ---------- Protección contra fuerza bruta ----------
  fail(key) {
    const entry = this.fails.get(key) || { count: 0, until: 0 };
    entry.count++;
    if (entry.count >= MAX_FAILS) { entry.until = Date.now() + LOCK_MS; entry.count = 0; }
    this.fails.set(key, entry);
  }

  isLocked(key) {
    const entry = this.fails.get(key);
    if (!entry) return false;
    if (entry.until > Date.now()) return true;
    if (entry.until) this.fails.delete(key);
    return false;
  }

  // ---------- Interno ----------
  checkPassword(user, password) {
    if (typeof password !== 'string') return false;
    const expected = Buffer.from(user.hash, 'hex');
    const actual = crypto.scryptSync(password, user.salt, expected.length);
    return expected.length > 0 && crypto.timingSafeEqual(expected, actual);
  }

  publicUser(user) {
    return { name: user.name, chips: user.chips, createdAt: user.createdAt, banned: !!user.banned, isAdmin: !!user.isAdmin };
  }

  // ---------- Administración ----------
  isAdmin(adminToken) {
    const user = this.userForToken(adminToken);
    return !!(user && user.isAdmin);
  }

  ban(adminToken, key) {
    if (!this.isAdmin(adminToken)) return { ok: false, status: 403, error: 'No tienes permisos de administrador.' };
    const user = this.users.get(key);
    if (!user) return { ok: false, status: 404, error: 'Cuenta no encontrada.' };
    user.banned = true;
    user.updatedAt = Date.now();
    for (const [token, session] of this.sessions) if (session.key === key) this.sessions.delete(token);
    this.save();
    return { ok: true, user: this.publicUser(user) };
  }

  unban(adminToken, key) {
    if (!this.isAdmin(adminToken)) return { ok: false, status: 403, error: 'No tienes permisos de administrador.' };
    const user = this.users.get(key);
    if (!user) return { ok: false, status: 404, error: 'Cuenta no encontrada.' };
    user.banned = false;
    user.updatedAt = Date.now();
    this.save();
    return { ok: true, user: this.publicUser(user) };
  }

  setChipsByKey(key, chips) {
    const user = this.users.get(key);
    if (!user) return { ok: false, status: 404, error: 'Cuenta no encontrada.' };
    const value = Math.floor(Number(chips));
    if (!Number.isFinite(value) || value < 0) return { ok: false, status: 400, error: 'Fichas no válidas.' };
    user.chips = Math.min(value, MAX_CHIPS);
    user.updatedAt = Date.now();
    this.save();
    return { ok: true, user: this.publicUser(user) };
  }

  // Ajuste interno por clave. Los pagos de admin y el bonus automático usan
  // este mismo cálculo para conservar límites, persistencia y réplica.
  adjustChipsByKey(key, delta) {
    const user = this.users.get(key);
    if (!user) return { ok: false, status: 404, error: 'Cuenta no encontrada.' };
    const amount = Math.floor(Number(delta));
    if (!Number.isFinite(amount) || amount === 0) return { ok: false, status: 400, error: 'Cantidad no válida.' };
    const before = user.chips;
    user.chips = Math.min(Math.max(0, before + amount), MAX_CHIPS);
    user.updatedAt = Date.now();
    this.save();
    return { ok: true, user: this.publicUser(user), delta: user.chips - before, before, after: user.chips };
  }

  grantScheduledChips(key, amount, bonusId) {
    const user = this.users.get(key);
    if (!user) return { ok: false, status: 404, error: 'Cuenta no encontrada.' };
    if (user.lastScheduledBonus === bonusId) {
      return { ok: true, skipped: true, user: this.publicUser(user), delta: 0, before: user.chips, after: user.chips };
    }
    const result = this.adjustChipsByKey(key, amount);
    if (!result.ok) return result;
    // La marca se persiste con la cuenta y evita duplicados tras reinicios.
    user.lastScheduledBonus = String(bonusId);
    this.save();
    return { ...result, skipped: false };
  }

  // Suma (o resta, con delta negativo) fichas a una cuenta. Nunca baja de 0.
  adjustChips(adminToken, key, delta) {
    if (!this.isAdmin(adminToken)) return { ok: false, status: 403, error: 'No tienes permisos de administrador.' };
    return this.adjustChipsByKey(key, delta);
  }

  listUsers() {
    return [...this.users.values()].map(u => this.publicUser(u));
  }

  count() { return this.users.size; }
}

module.exports = {
  UserStore, hashPassword,
  NAME_MIN, NAME_MAX, PASS_MIN, PASS_MAX, SESSION_TTL, MAX_FAILS, LOCK_MS, DEFAULT_CHIPS,
  LEADERBOARD_DEFAULT, LEADERBOARD_MAX,
};
