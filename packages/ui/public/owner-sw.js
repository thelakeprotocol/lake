// The owner panel's service worker: only for notifications (Web Push). It caches nothing, so the panel is always the
// house's current one. A push carries a short, vague line ("A request is waiting"); the details are in the panel.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Your house', { body: m.body || 'Something needs you.', tag: m.tag || 'house', renotify: true, icon: 'owner-192.png', data: { url: m.url || './approvals.html' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './approvals.html', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
    // Already open: go to what it was about (a note), not just to the app.
    for (const c of all) if (c.url.startsWith(self.registration.scope)) return c.focus().then((w) => (w && 'navigate' in w ? w.navigate(url) : w));
    return self.clients.openWindow(url);
  }));
});
