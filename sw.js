// ============================================================
//  Service worker: recibe los avisos aunque la app esté en segundo
//  plano o con el móvil bloqueado. Es la única forma de que el
//  navegador permita vibrar y sonar fuera de la pestaña activa.
// ============================================================
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Llega un aviso ("te toca", victoria…).
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'L&F Casino Club' }; }
  const title = data.title || 'L&F Casino Club';
  const options = {
    body: data.body || '',
    icon: 'icon.svg',
    badge: 'icon.svg',
    // El tag evita que se apilen avisos del mismo turno.
    tag: data.tag || 'lf-turn',
    renotify: true,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || './index.html' },
    actions: [{ action: 'open', title: 'Jugar' }],
  };
  // Al usuario le gusta el sonido del sistema: salvo que se pida silencio.
  if (!data.silent) options.silent = false;
  event.waitUntil(self.registration.showNotification(title, options));
});

// El aviso vibra al llegar: aquí sí (la pestaña está cerrada, pero el
// service worker sí tiene permisos de vibración en Android).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        client.postMessage({ type: 'turn', data: event.notification.data });
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});

// El navegador lo pide al suscribirse; se responde con la clave pública VAPID.
self.addEventListener('pushsubscriptionchange', () => {
  // La suscripción caducó: el cliente tendrá que volver a suscribirse al abrir.
});