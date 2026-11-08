// sw.js — service worker: notificações + "network-first" para nunca ficar
// preso em versão antiga (cache). Sempre busca o arquivo novo quando online;
// usa o cache só como reserva offline.
const CACHE = "sc-cache-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // só arquivos do próprio app
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: "no-store" }); // sempre o mais novo
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (_) {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw _;
    }
  })());
});

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
