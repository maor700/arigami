// Arigami service worker — handles push notifications. v3 (folded-star icons)
// Kept minimal: no cache/fetch interception (Vite handles assets).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() ?? {}; } catch { data = { body: e.data?.text() || '' }; }
  const title = data.title || 'Arigami';
  const body = data.body || 'New notification';
  const options = {
    body,
    icon: '/__host/icon-192.png',
    badge: '/__host/badge-96.png', // monochrome white mark — Android tints/masks the status-bar badge
    tag: data.tag || 'arigami',
    data: { url: data.url || '/__host/', sessionId: data.sessionId, eventId: data.eventId },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const sessionId = e.notification.data?.sessionId;
  const target = sessionId
    ? `/__host/#/session/${encodeURIComponent(sessionId)}`
    : '/__host/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).pathname.startsWith('/__host')) {
          // Navigate existing window to the right session
          c.postMessage({ type: 'navigate-session', sessionId, eventId: e.notification.data?.eventId });
          return c.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
