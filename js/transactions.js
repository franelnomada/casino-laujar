// ============================================================
//  Casino Night — registro público de transacciones de fichas
//  Consola en vivo del lobby. Persistencia igual que users.js:
//  caché local JSON + remoto opcional en Firebase RTDB por REST.
//  Se guardan solo las últimas MAX_ENTRIES entradas.
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { FirebaseRest } = require('./firebase-rest.js');

const MAX_ENTRIES = 200;
const DEFAULT_FILE = 'casino-laujar-transactions.json';
const TYPES = ['win', 'loss', 'admin_grant', 'admin_revoke', 'betting_bet', 'betting_refund'];

class TransactionLog {
  constructor(filePath) {
    this.filePath = filePath || path.join(process.env.DATA_DIR || os.tmpdir(), DEFAULT_FILE);
    this.entries = []; // la más reciente al final (push) y se sirven invertidas
    this.remote = FirebaseRest.configFromEnv(process.env, 'FIREBASE_TX_PATH', 'casino-laujar/transactions');
    this.remoteOk = false;
    this.load();
    this._ready = this.remote ? this._initRemote() : Promise.resolve(false);
  }

  ready() { return this._ready || Promise.resolve(false); }

  storageInfo() {
    return {
      backend: this.remote ? 'firebase' : 'local',
      remoteOk: this.remoteOk,
      remoteError: this.remote ? '' : 'sin configurar',
    };
  }

  // ---- Alta de entrada (solo donde el saldo YA cambió) ----
  add({ type, username, game, amount, balanceAfter, target, message }) {
    if (!TYPES.includes(type)) return null;
    const value = Math.floor(Number(amount));
    if (!Number.isFinite(value) || value <= 0) return null;
    const after = Math.floor(Number(balanceAfter));
    if (!Number.isFinite(after) || after < 0) return null;
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      ts: Date.now(),
      type,
      username: String(username || '???').slice(0, 40),
      game: game ? String(game).slice(0, 20) : null,
      amount: value,
      balanceAfter: after,
    };
    if (target) entry.target = String(target).slice(0, 40);
    if (message) entry.message = String(message).slice(0, 240);
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.save();
    return entry;
  }

  // ---- Lectura pública: de más reciente a más antigua ----
  list(limit) {
    let n = Math.floor(Number(limit));
    if (!Number.isFinite(n) || n <= 0) n = MAX_ENTRIES;
    n = Math.min(n, MAX_ENTRIES);
    return this.entries.slice(-n).reverse();
  }

  count() { return this.entries.length; }

  // ---------- Persistencia local (mismo patrón que users.js) ----------
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw && raw.entries) || [];
      this.entries = list.filter(e => e && e.id && TYPES.includes(e.type)).slice(-MAX_ENTRIES);
    } catch (e) { this.entries = []; }
  }

  save() {
    const doc = JSON.stringify({ entries: this.entries }, null, 2);
    try { fs.writeFileSync(this.filePath, doc); } catch (e) { /* disco efímero o solo lectura */ }
    if (this.remote) this._pushRemote();
  }

  // ---------- Remoto opcional (Firebase RTDB por REST) ----------
  static remoteConfigFromEnv(env) {
    return FirebaseRest.configFromEnv(env || process.env, 'FIREBASE_TX_PATH', 'casino-laujar/transactions');
  }

  async _initRemote() {
    try {
      const remote = await FirebaseRest.get(this.remote, '');
      const list = remote && (Array.isArray(remote) ? remote : remote.entries) || [];
      const valid = list.filter(e => e && e.id && TYPES.includes(e.type)).slice(-MAX_ENTRIES);
      // Fusión simple: nos quedamos con lo más nuevo por ts (sin borrar lo local).
      const merged = [...this.entries, ...valid]
        .sort((a, b) => a.ts - b.ts)
        .filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i)
        .slice(-MAX_ENTRIES);
      this.entries = merged;
      this.remoteOk = true;
      this.save();
      return true;
    } catch (e) {
      this.remoteOk = false;
      return false;
    }
  }

  _pushRemote() {
    if (this._pushing) return;
    this._pushing = true;
    const doc = { entries: this.entries };
    Promise.resolve(FirebaseRest.put(this.remote, doc))
      .then(() => { this.remoteOk = true; })
      .catch(() => { this.remoteOk = false; })
      .finally(() => { this._pushing = false; });
  }
}

module.exports = { TransactionLog, MAX_ENTRIES, TYPES };