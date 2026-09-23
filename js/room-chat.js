// Lógica compartida por los tres motores de sala para el chat que viaja
// dentro del estado y del long-polling existente.
const { randomUUID } = require('node:crypto');

const CHAT_MAX_MESSAGES = 50;
const CHAT_MAX_LENGTH = 200;
const CHAT_COOLDOWN_MS = 1000;

function ensureChat(room) {
  if (!Array.isArray(room.chat)) room.chat = [];
  if (!(room.chatLastSent instanceof Map)) room.chatLastSent = new Map();
  room.chat = room.chat.filter(m => m && typeof m.id !== 'undefined');
  if (room.chat.length > CHAT_MAX_MESSAGES) room.chat = room.chat.slice(-CHAT_MAX_MESSAGES);
}

function chatFor(room) {
  ensureChat(room);
  return room.chat.map(message => ({ ...message }));
}

function cleanChatText(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, CHAT_MAX_LENGTH).join('');
}

function addChatMessage(room, playerId, value, now = Date.now()) {
  ensureChat(room);
  const player = (room.players || []).find(p => p.id === playerId && !p.left);
  if (!player) return { ok: false, status: 403, error: 'No eres jugador de esta sala.' };

  const text = cleanChatText(value);
  if (!text) return { ok: false, status: 400, error: 'El mensaje no puede estar vacío.' };

  const lastSent = room.chatLastSent.get(playerId);
  const remaining = lastSent == null ? 0 : CHAT_COOLDOWN_MS - (now - lastSent);
  if (remaining > 0) {
    return {
      ok: false,
      status: 429,
      error: `Espera ${(Math.ceil(remaining / 100) / 10).toFixed(1).replace('.', ',')} s antes de enviar otro mensaje.`,
    };
  }

  const message = { id: randomUUID(), playerId, name: String(player.name || 'Jugador'), text, ts: now };
  room.chat.push(message);
  if (room.chat.length > CHAT_MAX_MESSAGES) room.chat = room.chat.slice(-CHAT_MAX_MESSAGES);
  room.chatLastSent.set(playerId, now);
  room.touch();
  return { ok: true, message: { ...message } };
}

module.exports = {
  CHAT_MAX_MESSAGES,
  CHAT_MAX_LENGTH,
  CHAT_COOLDOWN_MS,
  ensureChat,
  chatFor,
  cleanChatText,
  addChatMessage,
};
