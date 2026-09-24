// ================================================
//  Jackpot progresivo compartido de Book of Fran
//  Un único bote global: persistencia local + Firebase opcional.
// ================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FirebaseRest } = require('./firebase-rest.js');

// JACKPOT_RATE vive en SLOT_CONFIG; GOLD/SILVER/BRONZE son porcentajes fijos
// del mismo bote y deben sumar 1.0.
const DEFAULT_SEED = 100;
const DEFAULT_FILE = 'casino-laujar-jackpot.json';
const TIER_SHARES = Object.freeze({ GOLD: .70, SILVER: .20, BRONZE: .10 });
const TIER_NAMES = Object.freeze(['GOLD', 'SILVER', 'BRONZE']);

function configuredSeed(env) {
  const value = Math.floor(Number((env || process.env).JACKPOT_SEED));
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_SEED;
}

function boxValue(pool, tier) {
  return Math.round(pool * TIER_SHARES[tier]);
}

class SlotJackpot {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(process.env.DATA_DIR || os.tmpdir(), DEFAULT_FILE);
    this.seed = Number.isSafeInteger(options.seed) && options.seed >= 0 ? options.seed : configuredSeed();
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.remote = options.remote === undefined
      ? FirebaseRest.configFromEnv(process.env, 'FIREBASE_JACKPOT_PATH', 'casino-laujar/jackpot')
      : options.remote;
    this.jackpotPool = this.seed;
    this.updatedAt = 0;
    this.remoteOk = false;
    this.remoteError = '';
    this.remoteLoaded = !this.remote;
    this._saveTimer = null;
    this._pushTimer = null;
    this._pushing = false;
    this._pushAgain = false;
    this.pendingPicks = new Map(); // accountKey -> { roomCode, playerId, createdAt }
    this.loadLocal();
    this._ready = this.remote ? this._initRemote() : Promise.resolve(false);
  }

  ready() { return this._ready || Promise.resolve(false); }
  storageInfo() {
    return { backend: this.remote ? 'firebase' : 'local', remoteOk: this.remoteOk, remoteError: this.remote ? this.remoteError : 'sin configurar' };
  }

  view() {
    return {
      jackpotPool: this.jackpotPool,
      seed: this.seed,
      shares: { ...TIER_SHARES },
      values: {
        GOLD: boxValue(this.jackpotPool, 'GOLD'),
        SILVER: boxValue(this.jackpotPool, 'SILVER'),
        BRONZE: boxValue(this.jackpotPool, 'BRONZE'),
      },
    };
  }

  add(wager) {
    const contribution = Math.max(0, Math.round(Number(wager) || 0));
    if (!contribution) return 0;
    this.jackpotPool += contribution;
    this.updatedAt = Date.now();
    this.saveLocal();
    this.schedulePush();
    return contribution;
  }

  grantPick(accountKey, roomCode, playerId) {
    if (!accountKey) return false;
    if (this.pendingPicks.has(accountKey)) return false;
    this.pendingPicks.set(accountKey, { accountKey, roomCode, playerId, createdAt: Date.now() });
    return true;
  }

  pendingFor(accountKey) {
    return this.pendingPicks.get(accountKey) || null;
  }

  cancelPick(accountKey, roomCode, playerId) {
    const pending = this.pendingPicks.get(accountKey);
    if (pending && pending.roomCode === roomCode && pending.playerId === playerId) this.pendingPicks.delete(accountKey);
  }

  claimPick(accountKey, roomCode, playerId, box) {
    const pending = this.pendingPicks.get(accountKey);
    if (!pending || pending.roomCode !== roomCode || pending.playerId !== playerId) return null;
    const chosen = Math.floor(Number(box));
    if (!Number.isInteger(chosen) || chosen < 1 || chosen > 3) return null;
    const levels = TIER_NAMES.slice();
    for (let i = levels.length - 1; i > 0; i--) {
      const j = Math.floor(Math.max(0, Math.min(.999999, Number(this.random()) || 0)) * (i + 1));
      [levels[i], levels[j]] = [levels[j], levels[i]];
    }
    const poolAtPick = this.jackpotPool;
    const boxes = levels.map((level, index) => ({ box: index + 1, tier: level, value: boxValue(poolAtPick, level) }));
    const chosenBox = boxes[chosen - 1];
    this.pendingPicks.delete(accountKey);
    this.jackpotPool = this.seed;
    this.updatedAt = Date.now();
    this.saveLocal();
    this.schedulePush();
    return { box: chosen, tier: chosenBox.tier, value: chosenBox.value, boxes, poolAtPick };
  }

  loadLocal() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const pool = Math.floor(Number(raw && raw.jackpotPool));
      if (Number.isSafeInteger(pool) && pool >= this.seed) this.jackpotPool = pool;
      this.updatedAt = Math.max(0, Math.floor(Number(raw && raw.updatedAt) || 0));
    } catch (e) { /* primera ejecución */ }
  }

  saveLocal() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ jackpotPool: this.jackpotPool, updatedAt: this.updatedAt, seed: this.seed }));
      return true;
    } catch (e) { return false; }
  }

  async _initRemote() {
    try {
      const remote = await FirebaseRest.get(this.remote, '');
      const pool = Math.floor(Number(remote && remote.jackpotPool));
      const remoteUpdatedAt = Math.floor(Number(remote && remote.updatedAt) || 0);
      if (Number.isSafeInteger(pool) && pool >= this.seed && remoteUpdatedAt >= this.updatedAt) {
        this.jackpotPool = pool;
        this.updatedAt = remoteUpdatedAt;
        this.saveLocal();
      }
      this.remoteLoaded = true;
      this.remoteOk = true;
      this.remoteError = '';
      this.schedulePush();
      return true;
    } catch (e) {
      this.remoteOk = false;
      this.remoteError = String((e && e.message) || e).slice(0, 160);
      return false;
    }
  }

  schedulePush() {
    if (!this.remote || !this.remoteLoaded) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => {
      this._pushTimer = null;
      this.pushRemote().catch(() => { /* se reintenta en el próximo cambio */ });
    }, 250);
    if (this._pushTimer.unref) this._pushTimer.unref();
  }

  async pushRemote() {
    if (!this.remote || !this.remoteLoaded) return false;
    if (this._pushing) { this._pushAgain = true; return false; }
    this._pushing = true;
    try {
      do {
        this._pushAgain = false;
        const snapshot = { jackpotPool: this.jackpotPool, updatedAt: this.updatedAt, seed: this.seed };
        await FirebaseRest.put(this.remote, snapshot);
        this.remoteOk = true;
        this.remoteError = '';
      } while (this._pushAgain);
      return true;
    } catch (e) {
      this.remoteOk = false;
      this.remoteError = String((e && e.message) || e).slice(0, 160);
      return false;
    } finally {
      this._pushing = false;
    }
  }
}

module.exports = { SlotJackpot, TIER_SHARES, TIER_NAMES, boxValue, configuredSeed, DEFAULT_SEED };
