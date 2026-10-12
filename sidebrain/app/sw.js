// Sidebrain phone app service worker: keeps the app shell (and the pinned supabase-js module) cached so the
// app opens offline, shows the daily reminder, and sets the Home Screen badge. Card data is never cached here;
// app.js keeps its own copy in localStorage and Supabase stays the source of truth.
const CACHE = "sidebrain-v12"; // bump when the shell changes (v12: empty doc blocks skipped; v11: pings, Inbox, Up next, brief blocks and audio; v10: design round 3 labels)
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

// The `push` edge function sends a ping as {title, body: "", url: "./?open=<target>", tag: <ping id>} (docs/(C) Brief +
// ping contract.md §3), so it shows the title only, and the daily digest as {title, body, badge}. Each ping has its own
// tag, so one never replaces another; the tag rides along as ?ping= so the app can mark it seen.
self.addEventListener("push", (event) => {
  let msg = {};
  try { msg = event.data?.json() ?? {}; } catch { msg = { title: event.data?.text() }; }
  const badge = Number(msg.badge);
  let url = new URL(typeof msg.url === "string" ? msg.url : "./", self.registration.scope);
  if (url.origin !== self.location.origin) url = new URL("./", self.registration.scope); // a tap only ever opens this app
  if (msg.tag) url.searchParams.set("ping", msg.tag);
  event.waitUntil(Promise.all([
    self.registration.showNotification(msg.title || "Sidebrain", { body: msg.body || "", icon: "icon-192.png", tag: msg.tag || "due", data: { url: url.href } }),
    Number.isFinite(badge) && self.navigator.setAppBadge ? (badge > 0 ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()) : null,
  ]));
});

// A tap navigates an open window to the ping's link, then focuses it; with no window, it opens one. iOS 17–18 opens the
// app without navigating when openWindow meets a window that's already there, hence navigate first
// (developer.apple.com/forums/thread/733604). A window this worker doesn't control can't be navigated, so it gets the
// link as a message instead (app.js routes both).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || new URL("./", self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((all) => {
    const client = all.find((c) => c.focused) ?? all[0];
    if (!client) return self.clients.openWindow(url);
    const moved = Promise.resolve().then(() => client.navigate(url)).catch(() => client.postMessage({ open: url }));
    return Promise.all([moved, client.focus().catch(() => {})]);
  }));
});
