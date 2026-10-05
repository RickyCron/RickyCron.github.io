// Sidebrain phone app service worker: keeps the app shell (and the pinned supabase-js module) cached so the
// app opens offline, shows the daily reminder, and sets the Home Screen badge. Card data is never cached here;
// app.js keeps its own copy in localStorage and Supabase stays the source of truth.
const CACHE = "sidebrain-v1"; // bump when the shell changes shape; files themselves refresh in the background
const SHELL = ["./", "index.html", "styles.css", "app.js", "sm2.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Stale-while-revalidate for the shell and the CDN module: instant start, fresh copy next launch.
self.addEventListener("fetch", (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== "GET" || !(url.origin === location.origin || url.origin === "https://cdn.jsdelivr.net")) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const key = req.mode === "navigate" ? "index.html" : req; // ?demo=1 and other queries open the same shell
    const cached = await cache.match(key);
    const fresh = fetch(req).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; });
    if (cached) { event.waitUntil(fresh.catch(() => {})); return cached; }
    return fresh;
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
