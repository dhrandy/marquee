const VERSION = "marquee-v6";
const SHELL = [
  "/",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/art/placeholder.svg",
  "/favicon.ico",
  "/favicon.png",
  "/icons/header-logo-96.png",
  "/icons/apple-touch-icon.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== VERSION)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // media data is never cached
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }
  // Network-first keeps a newly loaded HTML document and its code/styles in sync.
  // Cache-first assets previously left installed clients on old handlers forever.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(VERSION).then((cache) => cache.put(request, copy)),
          );
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});

self.addEventListener("push", event => {
  let data;
  try { data = event.data?.json(); } catch { return; }
  if (!data || typeof data.title !== "string" || typeof data.body !== "string") return;
  event.waitUntil(self.registration.showNotification(data.title.slice(0, 120), {
    body: data.body.slice(0, 600), icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
    tag: typeof data.tag === "string" ? data.tag.slice(0, 120) : "marquee",
    data: { url: "/" },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const existing = windows.find(window => new URL(window.url).origin === location.origin);
    if (existing) return existing.focus();
    return clients.openWindow("/");
  }));
});
