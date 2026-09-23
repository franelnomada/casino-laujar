// ============================================================
//  Reparto automático de fichas: lunes, miércoles y viernes a las 10:00
//  Zona horaria Europe/Madrid. Cada cuenta recibe el bonus una sola vez por día.
// ============================================================
const DAYS = { Monday: 1, Wednesday: 3, Friday: 5 };
const DEFAULT_AMOUNT = 1000;
const DEFAULT_TZ = 'Europe/Madrid';

function zonedParts(timestamp, timeZone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const out = {};
  for (const part of parts) {
    if (part.type === 'literal') continue;
    out[part.type] = part.type === 'weekday' ? part.value : Number(part.value);
  }
  const weekdays = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
  out.weekday = weekdays[out.weekday];
  return out;
}

// Convierte una hora local de la zona indicada al instante UTC, incluyendo DST.
function zonedTimeToUtc(parts, timeZone = DEFAULT_TZ) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const local = zonedParts(guess, timeZone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    guess += target - represented;
  }
  return guess;
}

function slotFor(timestamp, timeZone = DEFAULT_TZ) {
  const now = Number(timestamp);
  if (!Number.isFinite(now)) return null;
  const local = zonedParts(now, timeZone);
  if (!DAYS[local.weekday] || local.hour < 10) return null;
  const date = [local.year, String(local.month).padStart(2, '0'), String(local.day).padStart(2, '0')].join('-');
  const scheduledAt = zonedTimeToUtc({ ...local, hour: 10, minute: 0, second: 0 }, timeZone);
  return now < scheduledAt ? null : { date, scheduledAt };
}

class WeeklyChipBonus {
  constructor({ userStore, txLog, amount = DEFAULT_AMOUNT, timeZone = DEFAULT_TZ, intervalMs = 30000, autoStart = true } = {}) {
    this.userStore = userStore;
    this.txLog = txLog;
    this.amount = Math.floor(Number(amount));
    this.timeZone = timeZone;
    this.intervalMs = intervalMs;
    this.lastSlot = null;
    this.timer = null;
    this.lastRun = null;
    if (autoStart) this.start();
  }

  start() {
    this.stop();
    this.ready = Promise.resolve(this.userStore && this.userStore.ready ? this.userStore.ready() : false)
      .catch(() => false)
      .then(() => { this.tick(); });
    this.timer = setInterval(() => {
      Promise.resolve(this.ready).catch(() => false).then(() => this.tick());
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this.ready;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = Date.now()) {
    const slot = slotFor(now, this.timeZone);
    if (!slot || this.lastSlot === slot.date) return { ran: false, delivered: 0, total: 0, date: slot && slot.date };
    this.lastSlot = slot.date;
    let delivered = 0;
    let total = 0;
    for (const user of this.userStore.users.values()) {
      if (user.banned || Number(user.createdAt || 0) > slot.scheduledAt) continue;
      const result = this.userStore.grantScheduledChips(user.key, this.amount, slot.date);
      if (!result.ok || result.skipped) continue;
      delivered++;
      total += result.delta;
      this.txLog.add({
        type: 'weekly_bonus', username: result.user.name, game: null,
        amount: result.delta, balanceAfter: result.after,
        message: result.user.name + ' ha recibido ' + result.delta + ' fichas de regalo semanal',
      });
    }
    this.lastRun = { date: slot.date, at: now, delivered, total };
    return { ran: true, delivered, total, date: slot.date };
  }

  info() {
    return {
      amount: this.amount, timeZone: this.timeZone,
      schedule: 'lunes, miércoles y viernes a las 10:00',
      lastSlot: this.lastSlot, lastRun: this.lastRun,
    };
  }
}

module.exports = { WeeklyChipBonus, slotFor, zonedTimeToUtc, DEFAULT_AMOUNT, DEFAULT_TZ };
