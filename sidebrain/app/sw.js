// Sidebrain phone app service worker: keeps the app shell (and the pinned supabase-js module) cached so the
// app opens offline, shows the daily reminder, and sets the Home Screen badge. Card data is never cached here;
// app.js keeps its own copy in localStorage and Supabase stays the source of truth.
const CACHE = "sidebrain-v10"; // bump when the shell changes (v10: design round 3 labels and fictional demo names merged; v8: design round 2 copy)
const SHELL = ["./", "index.html", "styles.css", "app.js", "sm2.js", "today.js", "notes.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "apple-touch-icon.png"];

// GitHub Pages sends max-age=600, so every fetch of our own files skips the HTTP cache: the cached shell is
// always one consistent version.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Our own files: network first, cache only offline. Stale-while-revalidate let a new index.html run with an old
// app.js (an empty Today on 7 Oct). The pinned CDN module never changes, so it stays cache first.
self.addEventListener("fetch", (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== "GET" || !(url.origin === location.origin || url.origin === "https://cdn.jsdelivr.net")) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const key = req.mode === "navigate" ? "index.html" : req; // ?demo=1 and other queries open the same shell
    const cached = await cache.match(key);
    if (url.origin !== location.origin && cached) return cached;
    const own = url.origin === location.origin;
    try {
      const res = await fetch(own ? new Request(req.mode === "navigate" ? "index.html" : req.url, { cache: "no-cache" }) : req);
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch (e) {
      if (cached) return cached;
      throw e;
    }
  }));
});

// The `push` edge function sends {title, body, badge}.
self.addEventListener("push", (event) => {
  let msg = {};
  try { msg = event.data?.json() ?? {}; } catch { msg = { body: event.data?.text() }; }
  const badge = Number(msg.badge);
  event.waitUntil(Promise.all([
    self.registration.showNotification(msg.title || "Sidebrain", { body: msg.body || "", icon: "icon-192.png", tag: "due", data: { url: "./" } }),
    Number.isFinite(badge) && self.navigator.setAppBadge ? (badge > 0 ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()) : null,
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((all) =>
    all.length ? all[0].focus() : self.clients.openWindow(event.notification.data?.url || "./")));
});
