// sw.js — service worker mínimo para notificações.
// No Android, notificações precisam vir do service worker (showNotification),
// e é aqui que tratamos o clique para abrir/focar o app.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sym = event.notification.data && event.notification.data.sym;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          if (sym && "postMessage" in client) client.postMessage({ type: "select", sym });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow("./" + (sym ? "?sym=" + sym : ""));
    })
  );
});
