// ============================================================
//  Casino Night — persistencia de salas en dos niveles:
//   1) Caché local en JSON (sobrevive a reinicios del proceso
//      en la misma instancia).
//   2) Remoto opcional en Firebase Realtime Database por REST
//      (sobrevive a redespliegues). Misma configuración que las
//      cuentas: FIREBASE_DB_URL (+ FIREBASE_DB_SECRET o
//      FIREBASE_SERVICE_ACCOUNT) y, opcionalmente,
//      FIREBASE_ROOMS_PATH (por defecto casino-laujar/rooms).
//
//  Fusión por lastActivity: nunca se pisa la sala más nueva.
//  No se escribe en remoto hasta que la primera carga ha
//  terminado (evita machacar lo guardado por el despliegue
//  anterior con una caché local a medias).
// ============================================================
const fs = require('fs');
const path = require('path');
const { FirebaseRest } = require('./firebase-rest.js');

class RoomReplica {
  constructor({ config, persistPath, rooms, restoreRoom, saveMs = 500, pushMs = 1000 }) {
    this.config = config || null;   // null → solo copia local
    this.persistPath = persistPath;
    this.rooms = rooms;             // Map code → sala
    this.restoreRoom = restoreRoom; // (code, data) → sala restaurada o null
    this.saveMs = saveMs;
    this.pushMs = pushMs;
    this.remoteOk = false;
    this.remoteError = '';
    this.remoteLoaded = false; // true tras la primera carga remota con éxito
    this._saveTimer = null;
    this._pushTimer = null;
  }

  // Copia local al instante + carga remota en segundo plano (si la hay).
  init() {
    this.loadLocal();
    return this.config ? this.loadRemote().catch(() => false) : Promise.resolve(false);
  }

  // Llamar cada vez que cambia una sala: guarda pronto, sube despacio.
  touch() {
    this.scheduleSave();
    this.schedulePush();
  }

  snapshot() {
    const data = {};
    for (const [code, room] of this.rooms) data[code] = room;
    return data;
  }

  // RTDB no guarda arrays vacíos ni nulls (p.hand = [], dealerHand = [],
  // turnId = null…): para conservar el estado exacto de cada sala, en
  // remoto cada sala viaja como cadena JSON.
  remoteSnapshot() {
    const data = {};
    for (const [code, room] of this.rooms) data[code] = JSON.stringify(room);
    return data;
  }

  // Acepta salas como cadena JSON (formato actual) o como objeto suelto
  // (compatibilidad con lo escrito por versiones anteriores).
  parseRemoteDoc(raw) {
    const out = [];
    for (const [code, value] of Object.entries(raw || {})) {
      if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) continue;
      try {
        const data = typeof value === 'string' ? JSON.parse(value) : value;
        if (data && typeof data === 'object') out.push([code, data]);
      } catch (e) { /* entrada corrupta: se ignora */ }
    }
    return out;
  }

  // ---------- Disco local ----------
  loadLocal() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const [code, data] of Object.entries(raw || {})) this.restoreRoom(code, data);
    } catch (e) { /* primera ejecución: no hay copia */ }
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.saveLocal(); }, this.saveMs);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  saveLocal() {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.snapshot()));
      return true;
    } catch (e) { return false; } // sin disco: seguimos solo en memoria
  }

  // ---------- Remoto (Firebase RTDB por REST) ----------
  async loadRemote() {
    if (!this.config) return false;
    try {
      const raw = await FirebaseRest.get(this.config);
      let adopted = 0;
      for (const [code, data] of this.parseRemoteDoc(raw)) {
        const local = this.rooms.get(code);
        if (!local || (data.lastActivity || 0) >= (local.lastActivity || 0)) {
          if (this.restoreRoom(code, data)) adopted++;
        }
      }
      this.remoteLoaded = true;
      this.remoteOk = true;
      this.remoteError = '';
      if (adopted) this.saveLocal(); // deja la copia local al día
      this.schedulePush(); // sube lo local que remoto aún no conozca
      return true;
    } catch (err) {
      this.remoteOk = false;
      this.remoteError = String((err && err.message) || err).slice(0, 160);
      return false;
    }
  }

  schedulePush() {
    if (!this.config || !this.remoteLoaded) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => {
      this._pushTimer = null;
      this.pushRemote().catch(() => { /* se reintenta en el próximo cambio */ });
    }, this.pushMs);
    if (this._pushTimer.unref) this._pushTimer.unref();
  }

  async pushRemote() {
    if (!this.config) return false;
    if (!this.remoteLoaded) {
      // La carga inicial falló o aún no terminó: NO machacar lo remoto con
      // el estado local a medias (borraría las salas del despliegue
      // anterior). Se reintenta la carga antes de escribir.
      try { await this.loadRemote(); } catch (err) { /* loadRemote ya captura */ }
      if (!this.remoteLoaded) return false;
    }
    try {
      await FirebaseRest.put(this.config, this.remoteSnapshot());
      this.remoteOk = true;
      this.remoteError = '';
      return true;
    } catch (err) {
      this.remoteOk = false;
      this.remoteError = String((err && err.message) || err).slice(0, 160);
      return false;
    }
  }

  info() {
    return {
      backend: this.config ? 'firebase' : 'local',
      remoteOk: this.remoteOk,
      remoteError: this.config ? this.remoteError : 'sin configurar',
      loaded: this.remoteLoaded,
    };
  }
}

module.exports = { RoomReplica };
