// Sidebrain on the phone: what's due today, study (flashcards, lecture notes, practice) and capture notes, on the same
// Supabase backend as the Mac app. Every review and practice attempt writes items.user_data and one `activity` row exactly
// as Sources/(C) View Study.swift does; a task tick writes what Sources/(C) View Today.swift does. Every user_data write
// carries `userAt` so the server can keep the newer one.
// Writes go through a small outbox in localStorage, so a review on a train with no signal is never lost.
import { schedule, intervalLabel, due, nextDue, examDays, todayString, daysBetween, addDays } from "./sm2.js";
import { withoutGreeting, dueSoon, dueLabel, urgent, runway } from "./today.js";
import { esc, markdown, lectureDoc, lectureNotes, ordered } from "./notes.js";

// ---- Settings to fill in before publishing (web/(C) README.md) ----
const SUPABASE_URL = "https://rdwavprncthvujmckige.supabase.co";
// Public by design, the same key the Mac app ships (Sources/(C) Flavor.swift); row-level security protects every row.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkd2F2cHJuY3RodnVqbWNraWdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEwNDg2MjYsImV4cCI6MjA3NjYyNDYyNn0.eg_I1CtKu3dF98JdLB8eU4Yww1NkJXtlRVo4orapeTM";
const GOOGLE_CLIENT_ID = "327768131024-jqlmp8jeb6qtouq2b4sv8v1pigss6fa4.apps.googleusercontent.com";  // the new Google *Web* OAuth client ID (README step 1)
// Optional override. Empty: the app asks the push function for it (GET /functions/v1/push → {publicKey}).
const VAPID_PUBLIC_KEY = "";
const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
// ponytail: supabase-js from a pinned CDN URL, no integrity check; vendor the file into web/ if that ever matters.

const DEMO_MODE = new URLSearchParams(location.search).get("demo");
const DEMO = DEMO_MODE === "1" || DEMO_MODE === "empty"; // ?demo=empty: a new friend's account, nothing in it yet
const NAMES = ["Again", "Hard", "Good", "Easy"];
const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// Per-device state. Demo mode keeps its own keys so it never mixes with real data.
const PREFIX = DEMO ? `sidebrain.demo${DEMO_MODE === "empty" ? "-empty" : ""}.` : "sidebrain.";
const load = (k, fallback) => { try { return JSON.parse(localStorage.getItem(PREFIX + k)) ?? fallback; } catch { return fallback; } };
const keep = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* private mode: the app still works, just without the offline copy */ } };

let sb = null, user = null;
let cards = [], byId = new Map(), assessments = [], tasks = [], applications = [], brief = null, notes = [];
let modules = [], lectures = [], practice = [], noteById = new Map(); // Study: lecture notes are `note` items, by id
let thumbs = new Map();              // photo path → signed URL (or a data URL in demo), for capture thumbnails
let outbox = load("outbox", []);     // [{t: "review" | "tick" | "attempt", id, user_data, activity?} | {t: "note", row}], oldest first
let captures = load("captures", []); // the last captures made on this phone: {id, body, photo, thumb?, at}
let tab = "today", loaded = false, cloud = "", syncError = "", reminders = "off", photoFile = null;
let undo = null, undoTimer = 0, allDue = false; // the task just ticked (Undo for 6 s, as on the Mac); "Show all" on Due soon
const session = { queue: [], index: 0, flipped: false, grades: [0, 0, 0, 0], day: "", module: null, lecture: null };
// Study screens, pushed and popped inside the tab like the Mac's StudyView: {s: "home" | "module" | "lecture" | "note" |
// "practice" | "review", m?, id?, y (scroll to come back to)}.
let stack = [{ s: "home" }];
const drafts = new Map();      // practice id → the answer being typed (kept across re-renders)
const shown = new Set();       // practice ids whose model answer is showing
const primer = new Map();      // lecture id → true when the Primer is chosen over the Notes
const folds = new Map();       // note id → {open: Set of revealed answer blocks, shown: Set of "block:node" tapped open}
let studyHtml = "";            // what #study shows now, so a re-render with nothing new keeps typing and focus

// ---------- Start ----------

async function start() {
  navigator.serviceWorker?.register("sw.js").catch(() => {});
  navigator.storage?.persist?.().catch(() => {}); // ask Safari not to evict the offline copy and the outbox
  bind();
  if (DEMO) {
    user = { email: "Demo" };
    $("demo-note").hidden = false;
    reminders = load("reminders", false) ? "on" : "off";
    useData(DEMO_MODE === "empty" ? {} : demoData());
    return render();
  }
  const cached = load("cache", null);
  if (cached && load("user", null)) { user = load("user", null); useData({ ...cached, lectureNotes: load("lecture-notes", []) }); }
  render();
  await connect();
}

async function connect() {
  if (sb) return;
  try {
    const { createClient } = await import(SUPABASE_JS);
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } });
  } catch {
    cloud = "You're offline. Reviews are saved on this phone and sync when you're back.";
    if (!user) say("signin-status", "You're offline. Connect to sign in.", true);
    return render();
  }
  // supabase-js asks that its own calls never run inside this callback, hence the setTimeout.
  sb.auth.onAuthStateChange((event, s) => setTimeout(() => {
    if (!s?.user) { if (event === "INITIAL_SESSION" || event === "SIGNED_OUT") signedOut(); return; }
    if (event === "INITIAL_SESSION" || (event === "SIGNED_IN" && s.user.id !== user?.id)) {
      user = { id: s.user.id, email: s.user.email };
      keep("user", user);
      refresh();
    }
  }));
}

function signedOut() {
  user = null; cards = []; byId = new Map(); tasks = []; applications = []; brief = null; notes = []; loaded = false;
  modules = []; lectures = []; practice = []; noteById = new Map(); stack = [{ s: "home" }]; studyHtml = "";
  localStorage.removeItem(PREFIX + "user"); // the outbox stays, and syncs after the next sign-in
  render();
  showSignIn();
}

// ---------- Cards ----------

const run = async (query) => { const { data, error } = await query; if (error) throw error; return data; };
const items = (kind, select) => sb.from("items").select(select).eq("kind", kind).is("deleted_at", null);

async function all(kind, select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const data = await run(items(kind, select).order("id").range(from, from + 999));
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function refresh() {
  if (!sb || !user) return;
  try {
    const [c, a, t, ap, b, n, mo, le, pr, ln] = await Promise.all([
      all("card", "id,module,title,data,user_data"), all("assessment", "id,source,module,title,data,date"),
      all("task", "id,title,date,data,user_data"), all("application", "id,title,date,data"),
      run(items("brief", "id,date,data").eq("date", todayString()).limit(1)),
      run(items("quicknote", "id,title,data,created_at").order("created_at", { ascending: false }).limit(5)),
      all("module", "id,module,title,data"), all("lecture", "id,module,date,title,data,user_data"),
      all("practice", "id,module,title,data,user_data"), all("note", "id,module,date,title,data"),
    ]);
    const fresh = { cards: c, assessments: a, tasks: t, applications: ap, brief: b[0] ?? null, notes: n, modules: mo, lectures: le, practice: pr };
    keep("cache", fresh);
    // Lecture notes are the bulk (~25 KB each with their doc), so they get their own key: if they ever outgrow
    // localStorage, only offline reading is lost, never the cards and the outbox.
    // ponytail: localStorage for notes; move them to IndexedDB if a term's worth stops fitting (about 5 MB).
    keep("lecture-notes", ln);
    useData({ ...fresh, lectureNotes: ln });
    cloud = "";
    signThumbs();
  } catch (e) {
    cloud = loaded ? "Couldn't reach Sidebrain cloud. Showing the cards saved on this phone." : `Couldn't load your cards: ${e.message || "network error"}`;
  }
  render();
  flush();
  reminders = await reminderStatus();
  render();
}

/** New server data. Reviews and ticks still in the outbox win, so a card graded offline doesn't come back as due. */
function useData(d) {
  const pending = new Map(outbox.filter((o) => o.user_data).map((o) => [o.id, o.user_data]));
  const withPending = (list = []) => list.map((x) => (pending.has(x.id) ? { ...x, user_data: pending.get(x.id) } : x));
  cards = withPending(d.cards);
  byId = new Map(cards.map((x) => [x.id, x]));
  tasks = withPending(d.tasks);
  assessments = d.assessments ?? []; applications = d.applications ?? []; brief = d.brief ?? null; notes = d.notes ?? [];
  modules = [...(d.modules ?? [])].sort((a, b) => ((a.data?.code ?? "") < (b.data?.code ?? "") ? -1 : 1));
  lectures = d.lectures ?? []; practice = withPending(d.practice);
  noteById = new Map((d.lectureNotes ?? []).map((x) => [x.id, x]));
  loaded = true;
  if (session.index === 0 || session.day !== todayString()) newSession(); // never reshuffle a session in progress
}

/** Due cards, all of them or one module's (and one lecture's), as the Mac's reviewScreen picks them. */
const dueFor = (module = null, lecture = null) =>
  due(cards.filter((c) => (!module || c.module === module) && (!lecture || c.data?.lecture === lecture)), todayString());

function newSession(module = session.module, lecture = session.lecture) {
  Object.assign(session, { queue: dueFor(module, lecture).map((x) => x.id), index: 0, flipped: false, grades: [0, 0, 0, 0], day: todayString(), module, lecture });
}

const current = () => byId.get(session.queue[session.index]);
const examFor = (card) => examDays(assessments, card.module ?? null, todayString());

function flip() {
  if (!current() || session.flipped) return;
  session.flipped = true;
  render();
}

function grade(g) {
  const card = current();
  if (!card || !session.flipped) return;
  const today = todayString(), now = Date.now();
  const next = schedule(card.user_data ?? {}, g, examFor(card), today, now);
  card.user_data = { ...card.user_data, ...next, userAt: now }; // Store.setUser merges, exactly like the Mac
  outbox.push({ t: "review", id: card.id, user_data: card.user_data, activity: {
    id: crypto.randomUUID(), item_id: card.id, at: new Date(now).toISOString(), kind: "review",
    payload: { grade: g, interval: next.interval, ease: next.ease },
  } });
  keep("outbox", outbox);
  saveCache();
  session.grades[g] += 1;
  if (g === 0) session.queue.push(card.id); // Again is due today, so it comes round once more this session
  session.index += 1; session.flipped = false;
  render();
  flush();
}

const saveCache = () => { if (!DEMO) keep("cache", { cards, assessments, tasks, applications, brief, notes, modules, lectures, practice }); };

// ---------- Tasks (Sources/(C) View Today.swift tick/untick) ----------

/** Done: {done: true, doneAt} plus a `done` activity row. Undone: {done: false, doneAt: null} and no activity
 *  (the server only allows review/attempt/done/edit/snooze). Merged into the task's user_data, never replacing it. */
function setDone(id, done) {
  const task = tasks.find((x) => x.id === id);
  if (!task) return;
  const now = Date.now();
  task.user_data = { ...task.user_data, done, doneAt: done ? now : null, userAt: now };
  outbox.push({ t: "tick", id, user_data: task.user_data, activity: done
    ? { id: crypto.randomUUID(), item_id: id, at: new Date(now).toISOString(), kind: "done", payload: {} } : null });
  keep("outbox", outbox);
  saveCache();
  clearTimeout(undoTimer);
  undo = done ? task : null;
  if (done) undoTimer = setTimeout(() => { undo = null; render(); }, 6000);
  render();
  flush();
}

// ---------- Practice (Sources/(C) View Study.swift PracticeCard.check) ----------

/** Attempt first: saves {attempt, attemptedAt, feedback: null} (merged, plus userAt) and an `attempt` activity row with
 *  the answer's length, then shows the model answer. No AI feedback on the phone yet. */
function attempt(id) {
  const q = practice.find((x) => x.id === id), saved = q?.user_data?.attempt ?? "", text = (drafts.get(id) ?? saved).trim();
  if (!q || !text) return;
  if (text === saved) { shown.add(id); return render(); } // tried before and unchanged: just show the model answer
  const now = Date.now();
  q.user_data = { ...q.user_data, attempt: text, attemptedAt: now, feedback: null, userAt: now };
  outbox.push({ t: "attempt", id, user_data: q.user_data, activity: {
    id: crypto.randomUUID(), item_id: id, at: new Date(now).toISOString(), kind: "attempt", payload: { length: [...text].length },
  } });
  keep("outbox", outbox);
  saveCache();
  shown.add(id);
  render();
  flush();
}

// ---------- Sync ----------

let flushing = false;
async function flush() {
  if (DEMO || !sb || !user?.id || flushing || !outbox.length) return;
  flushing = true;
  try {
    while (outbox.length) {
      const op = outbox[0];
      const results = op.t === "note"
        ? [await sb.from("items").upsert(op.row, { onConflict: "user_id,id", ignoreDuplicates: true })]
        : [await sb.from("items").update({ user_data: op.user_data }).eq("id", op.id),
           op.activity && await sb.from("activity").upsert(op.activity, { onConflict: "id", ignoreDuplicates: true })];
      const bad = results.find((r) => r?.error);
      if (bad) {
        // Offline, signed out or a server hiccup: keep it for later. Anything else the server refused for good.
        if (!bad.status || bad.status === 401 || bad.status >= 500) throw bad.error;
        syncError = `One change couldn't be saved: ${bad.error.message}`;
      }
      outbox.shift();
      keep("outbox", outbox);
    }
  } catch { /* stays in the outbox; retried on the next review, when back online, or when the app reopens */ }
  finally { flushing = false; render(); }
}

// ---------- Capture ----------

const titleOf = (body) => body.split("\n")[0].trim().slice(0, 80) || "Photo";

async function shrink(file, max = 1600) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn't read that photo."))), "image/jpeg", 0.82));
}

const dataUrl = (blob) => new Promise((ok, fail) => Object.assign(new FileReader(), { onload: (e) => ok(e.target.result), onerror: fail }).readAsDataURL(blob));

/** The one capture path, for the Capture tab and Today's quick capture. True when the note was saved. */
async function capture(body, file, status) {
  if (!body && !file) { say(status, "Write something or add a photo first.", true); return false; }
  const id = "you-" + crypto.randomUUID(); // Store.addOwn's id shape
  try {
    let photo = null, thumb = null;
    if (file) {
      const jpeg = await shrink(file); // demo too, so it runs the same path
      thumb = await dataUrl(await shrink(jpeg, 160)); // ~6 KB, so the list shows the photo offline and in demo
      if (DEMO) photo = "demo";
      else {
        if (!navigator.onLine) throw new Error("You're offline. Photos need a connection, so your note is still here.");
        photo = `${user.id}/${id}.jpg`;
        const { error } = await sb.storage.from("captures").upload(photo, jpeg, { contentType: "image/jpeg" });
        if (error) throw error;
      }
    }
    // ponytail: a photo can't wait in the outbox (localStorage is too small); keep it in IndexedDB if offline photos matter.
    const row = { id, kind: "quicknote", source: "you", module: null, date: null, title: titleOf(body),
                  data: photo ? { body, photo } : { body }, user_data: {}, deleted_at: null };
    outbox.push({ t: "note", row });
    keep("outbox", outbox);
    captures = [{ id, body, photo: !!photo, thumb, at: Date.now() }, ...captures].slice(0, 20);
    keep("captures", captures);
    say(status, DEMO ? "Saved on this phone." : "Saved.");
    flush();
    return true;
  } catch (e) {
    say(status, e.message || "Couldn't save. Try again.", true);
    return false;
  } finally {
    render();
  }
}

async function saveCapture(event) {
  event.preventDefault();
  $("save").disabled = true;
  if (await capture($("note").value.trim(), photoFile, "capture-status")) { $("note").value = ""; setPhoto(null); }
  $("save").disabled = false;
}

/** Today's one-line capture: Return (or the arrow) saves the note; the camera saves a photo with whatever is typed. */
async function quickCapture(file = null) {
  const form = $("quick");
  if (form.dataset.busy) return;
  form.dataset.busy = "1";
  if (await capture($("quick-note").value.trim(), file, "quick-status")) $("quick-note").value = "";
  delete form.dataset.busy;
  $("quick-photo").value = "";
}

/** Thumbnails for synced captures with a photo that this phone has no copy of (another phone, or after a sign-out). */
async function signThumbs() {
  const paths = notes.map((n) => n.data?.photo).filter((p) => typeof p === "string" && !thumbs.has(p));
  if (!paths.length) return;
  const { data } = await sb.storage.from("captures").createSignedUrls(paths, 3600).catch(() => ({}));
  for (const x of data ?? []) if (x.signedUrl) thumbs.set(x.path, x.signedUrl);
  render();
}

function setPhoto(file) {
  photoFile = file;
  const img = $("preview").querySelector("img");
  if (img.src) URL.revokeObjectURL(img.src);
  img.removeAttribute("src");
  if (file) img.src = URL.createObjectURL(file);
  $("preview").hidden = !file;
  $("photo-label").querySelector("span").textContent = file ? "Retake" : "Add photo";
  $("photo").value = "";
}

// ---------- Reminders (Web Push; iOS 16.4+ once added to the Home Screen) ----------

async function reminderStatus() {
  if (DEMO) return reminders;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return ios && !standalone ? "install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  if (await reg?.pushManager.getSubscription()) return "on"; // turning off needs no key
  return (await serverKey()) ? "off" : "unset";
}

/** The VAPID public key: the override above, else the push function's GET answer, kept for this launch once it comes.
 *  A failure or a 503 (VAPID_KEYS not set) means "not set up yet"; the next status check asks again. */
let vapidKey = VAPID_PUBLIC_KEY;
async function serverKey() {
  if (vapidKey || DEMO) return vapidKey;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/push`, { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY } });
    const key = res.ok ? (await res.json()).publicKey : "";
    if (typeof key === "string" && /^[A-Za-z0-9_-]{80,}$/.test(key)) vapidKey = key;
  } catch { /* offline or not deployed: stays "unset" */ }
  return vapidKey;
}

const REMINDERS = {
  off: ["Turn on reminders", "One nudge each morning with how many cards are due and your next deadline."],
  on: ["Turn off reminders", "On. Each morning you get what's due, and the app icon shows the count."],
  busy: ["Turning on…", "Allow notifications when your phone asks."],
  install: ["Turn on reminders", "Add Sidebrain to your Home Screen first (Share, then Add to Home Screen), and open it from there."],
  denied: ["Turn on reminders", "Notifications are off for Sidebrain. Turn them on in Settings, Notifications, Sidebrain."],
  unsupported: ["Turn on reminders", "This browser can't show reminders."],
  unset: ["Turn on reminders", "Reminders aren't set up yet."],
};

async function toggleReminders() {
  const was = reminders;
  try {
    if (DEMO) { reminders = was === "on" ? "off" : "on"; keep("reminders", reminders === "on"); return; }
    if (was === "on") {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) { await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
      navigator.clearAppBadge?.().catch(() => {});
    } else {
      const permission = await Notification.requestPermission(); // first await: iOS only asks inside the tap
      if (permission !== "granted") return;
      reminders = "busy"; render();
      const key = await serverKey();
      if (!key) throw new Error("reminders aren't set up yet");
      const sub = await (await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
      const { endpoint, keys } = sub.toJSON();
      const { error } = await sb.from("push_subscriptions").upsert({ endpoint, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: "user_id,endpoint" });
      if (error) { await sub.unsubscribe(); throw error; }
    }
  } catch (e) {
    say("remind-detail", `Couldn't change reminders: ${e.message || "try again"}`, true);
  } finally {
    if (!DEMO) reminders = await reminderStatus();
    render();
  }
}

function fromBase64Url(s) {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ---------- Sign in (Google Identity Services, then supabase-js signInWithIdToken) ----------

let gsiReady = false;
async function showSignIn() {
  $("signin-hint").hidden = !ios || standalone;
  if (!GOOGLE_CLIENT_ID) return say("signin-status", "Sign-in isn't set up yet: the Google Web client ID goes in app.js.", true);
  $("redirect-signin").hidden = false;
  if (gsiReady) return;
  try {
    await new Promise((ok, fail) => document.head.append(Object.assign(document.createElement("script"), { src: "https://accounts.google.com/gsi/client", onload: ok, onerror: fail })));
  } catch {
    return say("signin-status", "Couldn't reach Google. Check your connection and reopen Sidebrain.", true);
  }
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const hashed = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce))), (b) => b.toString(16).padStart(2, "0")).join("");
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID, nonce: hashed, ux_mode: "popup", itp_support: true, use_fedcm_for_prompt: true,
    callback: async ({ credential }) => {
      say("signin-status", "Signing in…");
      const { error } = await sb.auth.signInWithIdToken({ provider: "google", token: credential, nonce });
      say("signin-status", error ? `Sign-in failed: ${error.message}` : "", !!error);
    },
  });
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  google.accounts.id.renderButton($("gsi"), { theme: dark ? "filled_black" : "outline", size: "large", shape: "pill", text: "signin_with", width: 280 });
  gsiReady = true;
}

// Fallback for a Home Screen app where Google's pop-up can't report back: Supabase's own redirect sign-in.
function redirectSignIn() {
  sb?.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
}

async function signOut() {
  if (DEMO) {
    for (const k of ["outbox", "captures", "reminders"]) localStorage.removeItem(PREFIX + k);
    return location.reload();
  }
  if (outbox.length && !confirm(`${plural(outbox.length, "change")} haven't synced yet and will be lost. Sign out anyway?`)) return;
  for (const k of ["outbox", "captures", "cache", "user"]) localStorage.removeItem(PREFIX + k);
  outbox = []; captures = [];
  $("sheet").close();
  navigator.clearAppBadge?.().catch(() => {});
  await sb?.auth.signOut();
  signedOut();
}

// ---------- Rendering ----------

function say(id, text, warn = false) {
  $(id).textContent = text;
  $(id).classList.toggle("warn", warn);
}

function render() {
  const signedIn = !!user;
  const today = todayString();
  const dueNow = due(cards, today).length;
  const reviewing = tab === "study" && top().s === "review";
  $("signin").hidden = signedIn;
  $("tabs").hidden = $("account").hidden = !signedIn;
  for (const t of ["today", "study", "capture"]) $(t).hidden = !signedIn || tab !== t || (t === "study" && reviewing);
  $("review").hidden = !signedIn || !reviewing;
  $("heading").textContent = !signedIn ? "Sidebrain" : reviewing ? "Review" : { today: "Today", study: "Study", capture: "Capture" }[tab];
  $("eyebrow").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  $("due-pill").hidden = !signedIn || !loaded || !reviewing;
  $("due-pill").textContent = `${dueNow} due`;
  $("account").textContent = (user?.email || "?")[0].toUpperCase();
  for (const b of $("tabs").querySelectorAll("button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (signedIn && loaded) navigator.setAppBadge?.(dueNow).catch(() => {});
  if (signedIn) { renderToday(today, dueNow); renderStudy(today); renderReview(today); renderCaptures(); renderSheet(); }
}

const ICONS = {
  tick: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/></svg>`,
  assessment: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5L12 5l9 4.5-9 4.5z"/><path d="M7 11.5v4c1.4 1.3 3 2 5 2s3.6-.7 5-2v-4"/></svg>`,
  application: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 12.5h17"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>`,
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>`,
  done: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.6-5"/></svg>`,
  open: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h9v9M18 6L7 17"/></svg>`,
  practice: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4.5" width="14" height="16" rx="2.5"/><path d="M9 4.5V3.8c0-.4.3-.8.8-.8h4.4c.5 0 .8.4.8.8v.7M8.5 10.5h7M8.5 14h7M8.5 17.5h4"/></svg>`,
  list: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/></svg>`,
};
const at = (ms) => new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Today: top priority, the review entry, quick capture (static in index.html), due soon, coursework runway, captures. */
function renderToday(today, dueNow) {
  const warn = [cloud, syncError].filter(Boolean).map((m) => `<p class="status warn">${esc(m)}</p>`).join("");
  if (!loaded) { $("today-top").innerHTML = `<p class="status">Loading your day…</p>${warn}`; $("today-rest").innerHTML = ""; return; }
  const p = brief?.date?.slice(0, 10) === today ? brief.data?.priority : null; // only today's brief, as on the Mac
  const why = p && typeof p.why === "string" ? withoutGreeting(p.why) : "";
  const pDue = p && typeof p.due === "string" ? { date: p.due, days: daysBetween(today, p.due.slice(0, 10)) } : null;
  const pLabel = pDue && dueLabel(pDue);
  $("today-top").innerHTML = `${warn}
    ${p?.title ? `<article class="card priority">
      <p class="kicker">Top priority</p>
      <h2>${esc(p.title)}</h2>
      ${why ? `<p class="muted">${esc(why)}</p>` : ""}
      ${pLabel ? `<p class="caption${urgent(pDue) ? " warn" : ""}">${pDue.days < 0 ? esc(pLabel) : "Due " + esc(pDue.days <= 1 ? pLabel.toLowerCase() : pLabel)}</p>` : ""}
    </article>` : ""}
    ${dueNow ? `<button class="primary go" type="button" data-act="review"><span>${plural(dueNow, "card")} due</span>${ICONS.chevron}</button>` : ""}`;

  const soon = dueSoon(tasks, assessments, applications, today).filter((r) => r.id !== undo?.id);
  const shown = allDue ? soon : soon.slice(0, 6);
  const dueHtml = shown.map((r) => {
    const label = dueLabel(r);
    return `<li>
      ${r.kind === "task" ? `<button class="tick" type="button" data-tick="${esc(r.id)}" aria-label="Mark ${esc(r.title)} done">${ICONS.tick}</button>`
                          : `<span class="kind">${r.kind === "application" ? ICONS.application : ICONS.assessment}</span>`}
      <div class="grow"><p>${esc(r.title)}</p>${r.detail ? `<p class="caption">${esc(r.detail)}</p>` : ""}</div>
      ${label ? `<span class="when${urgent(r) ? " warn" : ""}">${esc(label).replace(" · ", "<br>")}</span>` : ""}
    </li>`; }).join("");
  const more = soon.length > 6 ? `<li><button class="link" type="button" data-act="all-due">${allDue ? "Show less" : `Show all ${soon.length}`}</button></li>` : "";
  const undoHtml = undo ? `<li class="undo"><p class="grow caption">Done · ${esc(undo.data?.title || undo.title || "Task")}</p><button class="quiet" type="button" data-act="untick">Undo</button></li>` : "";
  const empty = !soon.length && !undo ? `<li><p class="caption">Nothing due in the next seven days.</p></li>` : "";

  const later = runway(assessments, today);
  const local = new Set(captures.map((c) => c.id));
  const waiting = new Set(outbox.filter((o) => o.t === "note").map((o) => o.row.id));
  const recent = [...captures, ...notes.filter((n) => !local.has(n.id)).map((n) => ({ id: n.id, body: n.data?.body ?? n.title, photo: !!n.data?.photo, at: Date.parse(n.created_at) || 0, path: n.data?.photo }))]
    .sort((a, b) => b.at - a.at).slice(0, 5);
  $("today-rest").innerHTML = `
    <h3 class="label">Due soon</h3>
    <ul class="rows">${dueHtml}${more}${undoHtml}${empty}</ul>
    ${later.length ? `<h3 class="label">Coursework runway</h3>
    <ul class="rows">${later.map((r) => `<li><span class="kind">${ICONS.assessment}</span>
      <div class="grow"><p>${esc(r.title)}</p><p class="caption">${esc(r.detail)}</p></div><span class="when">${esc(r.left)}</span></li>`).join("")}</ul>` : ""}
    ${recent.length ? `<h3 class="label">Your captures</h3>
    <ul class="rows">${recent.map((c) => { const src = c.thumb || thumbs.get(c.path);
      return `<li>${src ? `<img class="thumb" src="${esc(src)}" alt="Photo">` : ""}
      <div class="grow"><p class="body">${esc(c.body || "Photo")}</p>
      <p class="caption">${at(c.at)}${c.photo && !src ? " · Photo" : ""}${!DEMO && waiting.has(c.id) ? " · Waiting to sync" : ""}</p></div></li>`; }).join("")}</ul>` : ""}`;
}

function renderReview(today) {
  const waiting = outbox.filter((o) => o.t === "review").length;
  const footer = [
    cloud && `<p class="status warn">${esc(cloud)}</p>`,
    syncError && `<p class="status warn">${esc(syncError)}</p>`,
    !DEMO && waiting && `<p class="caption">${plural(waiting, "review")} waiting to sync</p>`,
  ].filter(Boolean).join("");
  const back = backButton();
  if (!loaded) { $("review").innerHTML = `${back}<p class="status">Loading your cards…</p>${footer}`; return; }
  const card = current(), left = dueFor(session.module, session.lecture).length;
  if (!card) {
    const done = session.index > 0, next = nextDue(cards, today);
    const nextText = next ? `Next cards due ${daysBetween(today, next) === 1 ? "tomorrow" : new Date(next + "T12:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}.` : "";
    $("review").innerHTML = `${back}
      <div class="empty">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9.5"/></svg>
        <h2>${done ? "Session done" : "Nothing due"}</h2>
        <p class="muted">${done ? plural(session.index, "review") : "Every card is scheduled for later."}</p>
        ${done ? `<p class="tally">${NAMES.map((n, g) => `<span><b>${session.grades[g]}</b> ${n}</span>`).join("")}</p>` : ""}
        ${nextText ? `<p class="caption">${esc(nextText)}</p>` : ""}
        ${left ? `<button class="quiet" data-act="again">Review ${plural(left, "due card")}</button>` : ""}
        ${reminders === "off" ? `<button class="quiet" data-act="remind">Get a nudge each morning</button>` : ""}
      </div>${footer}`;
    return;
  }
  const where = [card.module, card.data?.lecture].filter(Boolean).join(" · ");
  const exam = examFor(card);
  const scope = session.lecture ? `${short(session.module)} ${session.lecture}` : session.module ? short(session.module) : "Due today";
  $("review").innerHTML = `${back}
    <div class="meta"><span>${esc(scope)}</span><span>${session.index + 1} of ${session.queue.length}</span></div>
    <div class="bar"><i style="width:${(session.index / Math.max(session.queue.length, 1)) * 100}%"></i></div>
    <div class="flash" data-act="flip">
      ${where ? `<span class="where">${esc(where)}</span>` : ""}
      <h2 class="front">${esc(card.data?.front ?? card.title ?? "")}</h2>
      ${session.flipped ? `<hr><p class="back">${esc(card.data?.back ?? "")}</p>` : `<p class="hint">Say the answer out loud, then tap</p>`}
    </div>
    <div class="actions">
      ${session.flipped
        ? `<div class="grades">${NAMES.map((n, g) => `<button class="grade glass" data-grade="${g}"><b>${n}</b><span>${intervalLabel(schedule(card.user_data ?? {}, g, exam, today).interval)}</span></button>`).join("")}</div>
           <p class="keys">Keys 1 to 4 grade the card</p>`
        : `<button class="primary" data-act="flip">Show answer</button>`}
      ${footer}
    </div>`;
}

// ---------- Study (Sources/(C) View Study.swift: modules → lectures → reader, review, attempt-first practice) ----------

const top = () => stack[stack.length - 1];
const moduleName = (m) => m.module ?? m.title ?? m.id;
const short = (name) => modules.find((m) => moduleName(m) === name)?.data?.short ?? name ?? "";
const KINDS = { essay: "Essay", short: "Short answer", mcq: "Multiple choice" };
const tabY = {}; // each tab's scroll, so switching tabs comes back to the same place

/** "today", "tomorrow" or "Mon 5 Oct". */
function dayLabel(d) {
  const day = String(d).slice(0, 10), n = daysBetween(todayString(), day);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : new Date(day + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
const caughtUp = (next) => (next ? `All caught up · next due ${dayLabel(next)}` : "All caught up");
const emptyCard = (title, detail) => `<div class="card stack tight"><p class="strong">${esc(title)}</p><p class="caption">${esc(detail)}</p></div>`;
const navRow = (attrs, lead, main) => `<li class="nav"><button class="row" type="button" ${attrs}>${lead}<div class="grow">${main}</div>${ICONS.chevron}</button></li>`;

/** A screen's name, as the back control shows it. */
function screenName(sc) {
  if (sc.s === "module") return short(sc.m);
  if (sc.s === "lecture") { const l = lectures.find((x) => x.id === sc.id); return [short(l?.module), l?.data?.n].filter(Boolean).join(" ") || "Lecture"; }
  if (sc.s === "practice") return sc.m ? `${short(sc.m)} practice` : "Practice";
  return { note: "Notes", review: "Review" }[sc.s] ?? "Study";
}
const backButton = () => (stack.length > 1 ? `<button class="back" type="button" data-act="back">${ICONS.back}<span>${esc(screenName(stack[stack.length - 2]))}</span></button>` : "");

function go(screen) {
  top().y = scrollY;
  stack.push(screen);
  render();
  scrollTo(0, 0);
}
function back() {
  if (stack.length < 2) return;
  stack.pop();
  render();
  scrollTo(0, top().y ?? 0);
}
/** "N cards due" anywhere: all due cards, one module's or one lecture's. A session in progress over the same cards carries on. */
function openReview(module = null, lecture = null) {
  if (session.module !== module || session.lecture !== lecture || !current()) newSession(module, lecture);
  if (tab === "study") return go({ s: "review" });
  tabY[tab] = scrollY;
  tab = "study"; stack = [{ s: "home", y: 0 }, { s: "review" }];
  render();
  scrollTo(0, 0);
}

function renderStudy(today) {
  const sc = top();
  if (sc.s === "review") return;
  const html = !loaded ? `<p class="status">Loading your modules…</p>` : sc.s === "module" ? moduleScreen(sc.m, today) : sc.s === "lecture" ? lectureScreen(sc.id, today)
    : sc.s === "note" ? noteScreen(sc.id) : sc.s === "practice" ? practiceScreen(sc) : homeScreen(today);
  if (html === studyHtml) return; // nothing new: leave the page alone, so typing, focus and open menus survive
  const a = document.activeElement;
  const refocus = a?.dataset?.draft != null ? `[data-draft="${CSS.escape(a.dataset.draft)}"]`
    : a?.dataset?.node != null ? `[data-dg="${a.dataset.dg}"][data-node="${CSS.escape(a.dataset.node)}"]` : null;
  const caret = a?.dataset?.draft != null ? [a.selectionStart, a.selectionEnd] : null;
  $("study").innerHTML = studyHtml = html;
  for (const box of $("study").querySelectorAll("textarea[data-draft]")) {
    const id = box.dataset.draft;
    box.value = drafts.get(id) ?? practice.find((q) => q.id === id)?.user_data?.attempt ?? "";
    syncCheck(box);
  }
  const again = refocus && $("study").querySelector(refocus);
  again?.focus({ preventScroll: true });
  if (again && caret) again.setSelectionRange(...caret);
}

function homeScreen(today) {
  const dueAll = due(cards, today), open = practice.filter((q) => !q.user_data?.attempt);
  const warn = [cloud, syncError].filter(Boolean).map((m) => `<p class="status warn">${esc(m)}</p>`).join("");
  return `${warn}
    ${dueAll.length ? `<div class="stack tight"><button class="primary go" type="button" data-act="review"><span>${plural(dueAll.length, "card")} due</span>${ICONS.chevron}</button>
      <p class="caption center">Across ${plural(new Set(dueAll.map((c) => c.module).filter(Boolean)).size, "module")}. Say each answer out loud before you flip.</p></div>`
      : cards.length ? `<div class="card"><p class="strong">${esc(caughtUp(nextDue(cards, today)))}</p></div>` : ""}
    ${practice.length ? `<ul class="rows">${navRow(`data-practice=""`, `<span class="kind">${ICONS.practice}</span>`,
      `<p class="strong">${open.length ? plural(open.length, "practice question") + " to try" : "All practice attempted"}</p>`)}</ul>` : ""}
    ${modules.length ? `<h3 class="label">Modules</h3><ul class="rows">${modules.map((m) => {
      const name = moduleName(m), n = lectures.filter((l) => l.module === name).length, d = dueFor(name).length;
      return navRow(`data-module="${esc(name)}"`, "", `<p class="strong">${esc(name)}</p>
        ${m.data?.assessment ? `<p class="caption">${esc(m.data.assessment)}</p>` : ""}
        <p class="caption">${plural(n, "lecture")}${d ? ` · <b class="accent">${d} due</b>` : ""}</p>`);
    }).join("")}</ul>`
      : emptyCard("No modules yet", "Your modules, lecture notes and flashcards arrive here after the next lecture sync.")}`;
}

function moduleScreen(name, today) {
  const mod = modules.find((x) => moduleName(x) === name), d = mod?.data ?? {};
  const lecs = ordered(lectures.filter((l) => l.module === name));
  const deck = cards.filter((c) => c.module === name), dueHere = dueFor(name), qs = practice.filter((q) => q.module === name);
  // Notes no lecture points at and no lecture covers: built on the Mac from a recording that has no lecture row.
  const linked = new Set(lectures.flatMap((l) => [l.data?.pre, l.data?.post, l.user_data?.builtPost]));
  const covered = new Set(lecs.map((l) => String(l.data?.n ?? "").toUpperCase()));
  const more = [...noteById.values()].filter((x) => x.module === name && x.data?.kind !== "readings" && !linked.has(x.id) && !covered.has(String(x.data?.lecture ?? "").toUpperCase()));
  // The feed's "next" line repeats the assessment's weighting, so those segments go (as on the Mac).
  const next = String(d.next ?? "").split(" · ").filter((p) => p && !p.includes("%")).join(" · ");
  const by = [d.code, d.convenor].filter(Boolean).join(" · ");
  return `${backButton()}
    <header class="page-head">${by ? `<p class="caption">${esc(by)}</p>` : ""}<h2>${esc(name)}</h2>
      ${d.assessment ? `<p>${esc(d.assessment)}</p>` : ""}${next ? `<p class="caption">${esc(next)}</p>` : ""}</header>
    <h3 class="label">Lectures</h3>
    ${lecs.length ? `<ul class="rows">${lecs.map((l) => {
      const notes = [l.date && dayLabel(l.date), l.data?.pre && "Primer", (l.data?.post || l.user_data?.builtPost) && "Notes"].filter(Boolean);
      return navRow(`data-lecture="${esc(l.id)}"`, `<span class="num">${esc(l.data?.n ?? "")}</span>`,
        `<p class="strong">${esc(l.data?.topic ?? l.title ?? "Lecture")}</p>${notes.length ? `<p class="caption">${esc(notes.join(" · "))}</p>` : ""}`);
    }).join("")}</ul>` : emptyCard("No lectures yet", "Lectures appear here after each one is processed.")}
    ${more.length ? `<h3 class="label">More notes</h3><ul class="rows">${more.map((x) => navRow(`data-note="${esc(x.id)}"`, "",
      `<p class="strong">${esc(x.title ?? x.data?.topic ?? "Lecture notes")}</p>${x.date ? `<p class="caption">${esc(dayLabel(x.date))}</p>` : ""}`)).join("")}</ul>` : ""}
    <h3 class="label">Flashcards</h3>
    <div class="card stack"><p class="strong">${dueHere.length ? `${plural(dueHere.length, "card")} due of ${deck.length}` : esc(caughtUp(nextDue(deck, today)))}</p>
      ${dueHere.length ? `<button class="primary" type="button" data-act="review" data-m="${esc(name)}">Review this module</button>` : ""}</div>
    ${qs.length ? `<h3 class="label">Practice</h3><ul class="rows">${qs.map((q) => navRow(`data-practice="${esc(name)}"`,
      `<span class="kind${q.user_data?.attempt ? "" : " faint"}">${q.user_data?.attempt ? ICONS.done : ICONS.tick}</span>`,
      `<p class="clamp">${esc(q.data?.prompt ?? q.title ?? "")}</p>`)).join("")}</ul>` : ""}`;
}

/** The note's structured doc when it has one, else its Markdown body; "" when it has neither. */
function noteHtml(note, sections) {
  if (!folds.has(note.id)) folds.set(note.id, { open: new Set(), shown: new Set() });
  const body = typeof note.data?.body === "string" ? note.data.body : "";
  const html = lectureDoc(note.data?.doc, folds.get(note.id), sections) ?? (body.trim() ? markdown(body, sections) : "");
  return html ? `<div class="prose" data-doc="${esc(note.id)}">${html}</div>` : "";
}

/** Contents (the h2s) and the Google Doc, when there are any. */
function toolbar(sections, url) {
  const docs = typeof url === "string" && url.startsWith("https://");
  if (!sections.length && !docs) return "";
  return `<div class="toolbar">
    ${sections.length ? `<details class="contents"><summary class="quiet small">${ICONS.list}<span>Contents</span></summary>
      <ul class="menu">${sections.map((x) => `<li><button type="button" data-jump="${x.id}">${esc(x.title)}</button></li>`).join("")}</ul></details>` : ""}
    ${docs ? `<a class="quiet small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Google Doc ${ICONS.open}</a>` : ""}
  </div>`;
}

function lectureScreen(id, today) {
  const lec = lectures.find((x) => x.id === id);
  if (!lec) return `${backButton()}${emptyCard("Lecture not found", "It may have been removed by the last lecture sync.")}`;
  const { pre, post } = lectureNotes(lec, noteById), n = lec.data?.n ?? "";
  const usePrimer = primer.get(id) ?? !post, note = usePrimer ? (pre ?? post) : (post ?? pre);
  const url = (usePrimer ? lec.data?.primerUrl : lec.data?.docUrl) ?? note?.data?.docUrl;
  const readings = [...noteById.values()].find((x) => x.module === lec.module && x.data?.kind === "readings" && x.data?.lecture === n);
  const deck = cards.filter((c) => c.module === lec.module && c.data?.lecture === n), dueHere = dueFor(lec.module, n);
  const qs = practice.filter((q) => q.module === lec.module && q.data?.lecture === n);
  const sections = [], body = note ? noteHtml(note, sections) : "";
  const over = !lec.date || lec.date.slice(0, 10) < today; // ponytail: the day, not the timetable's end time as on the Mac
  return `${backButton()}
    <header class="page-head"><p class="caption">${esc([short(lec.module), n, lec.date && dayLabel(lec.date)].filter(Boolean).join(" · "))}</p>
      <h2>${esc(lec.data?.topic ?? lec.title ?? "Lecture")}</h2></header>
    ${pre && post ? `<div class="segmented" role="group" aria-label="Which note">${[["Primer", true], ["Notes", false]]
      .map(([label, v]) => `<button type="button" data-primer="${v}" aria-pressed="${usePrimer === v}">${label}</button>`).join("")}</div>` : ""}
    ${toolbar(sections, url)}
    ${body || (over ? emptyCard("No notes yet", "Build the full notes from the recording in Sidebrain on your Mac.")
                    : emptyCard("Notes come after the lecture", "Once it has finished, the notes arrive here."))}
    ${readings?.data?.body ? `<h3 class="label">Readings</h3><div class="card prose">${markdown(readings.data.body)}</div>` : ""}
    ${deck.length ? `<h3 class="label">Flashcards · ${deck.length}</h3>
      <ul class="rows">${deck.map((c) => `<li><p class="grow">${esc(c.data?.front ?? c.title ?? "")}</p></li>`).join("")}</ul>
      ${dueHere.length ? `<button class="quiet" type="button" data-act="review" data-m="${esc(lec.module)}" data-l="${esc(n)}">Review ${dueHere.length} due from ${esc(n)}</button>` : ""}` : ""}
    ${qs.length ? `<h3 class="label">Practice</h3>${qs.map((q) => practiceCard(q)).join("")}` : ""}`;
}

function noteScreen(id) {
  const note = noteById.get(id);
  if (!note) return `${backButton()}${emptyCard("Notes not found", "They may have been removed by the last sync.")}`;
  const sections = [], body = noteHtml(note, sections);
  const title = (Array.isArray(note.data?.doc?.blocks) ? note.data.doc.blocks : []).find((b) => b?.t === "h1" && b.text)?.text;
  return `${backButton()}<header class="page-head"><h2>${esc(title ?? note.title ?? "Lecture notes")}</h2></header>
    ${toolbar(sections, note.data?.docUrl)}${body || emptyCard("Nothing in these notes", "They may still be building on your Mac.")}`;
}

function practiceScreen(sc) {
  const all = practice.filter((q) => !sc.m || q.module === sc.m);
  // Not yet tried first, fixed when the screen opens, so a card doesn't jump away the moment it's answered.
  sc.order ??= [...all.filter((q) => !q.user_data?.attempt), ...all.filter((q) => q.user_data?.attempt)].map((q) => q.id);
  const qs = [...all].sort((a, b) => sc.order.indexOf(a.id) - sc.order.indexOf(b.id));
  return `${backButton()}<header class="page-head"><h2>${esc(sc.m ?? "Practice")}</h2>
      <p class="caption">Answer first. The model answer is there to compare against once you have tried.</p></header>
    ${qs.length ? qs.map((q) => practiceCard(q, !sc.m)).join("") : emptyCard("No practice yet", "Questions arrive the morning after each lecture.")}`;
}

/** Attempt first: the model answer stays locked until something is written, or "Skip to answer" is tapped. */
function practiceCard(q, withModule = false) {
  const id = q.id, open = shown.has(id), model = typeof q.data?.model === "string" ? q.data.model : "";
  const meta = [withModule && short(q.module), q.data?.lecture, KINDS[q.data?.kind] ?? "Question"].filter(Boolean).join(" · ");
  return `<article class="card practice">
    <div class="meta"><span>${esc(meta)}</span>${q.user_data?.attempt ? "<span>Attempted</span>" : ""}</div>
    <p class="prompt">${esc(q.data?.prompt ?? q.title ?? "")}</p>
    <textarea data-draft="${esc(id)}" rows="4" placeholder="Your answer. The model answer unlocks once you've written something." aria-label="Your answer"></textarea>
    <div class="acts">
      <button class="quiet" type="button" data-check="${esc(id)}" disabled>${open ? "Save attempt" : "Show model answer"}</button>
      ${open ? "" : `<button class="link" type="button" data-skip="${esc(id)}">Skip to answer</button>`}
    </div>
    ${open ? `<h4 class="label">Model answer</h4><div class="prose">${markdown(model)}</div>${q.data?.origin ? `<p class="caption">${esc(q.data.origin)}</p>` : ""}` : ""}
  </article>`;
}

/** The answer button: needs something written, and once the model answer shows, something new to save. */
function syncCheck(box) {
  const id = box.dataset.draft, text = box.value.trim(), saved = practice.find((q) => q.id === id)?.user_data?.attempt ?? "";
  const button = box.closest(".practice")?.querySelector("[data-check]");
  if (button) button.disabled = !text || (shown.has(id) && text === saved);
}

function renderCaptures() {
  const waiting = new Set(outbox.filter((o) => o.t === "note").map((o) => o.row.id));
  $("recent-label").hidden = !captures.length;
  $("recent").innerHTML = captures.slice(0, 5).map((c) => `
    <li><p class="body">${esc(c.body || "Photo")}</p>
      <p class="caption">${new Date(c.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}${c.photo ? " · Photo" : ""} · ${DEMO ? "On this phone" : waiting.has(c.id) ? "Waiting to sync" : "Saved to Sidebrain"}</p></li>`).join("");
}

function renderSheet() {
  const [label, detail] = REMINDERS[reminders] ?? REMINDERS.off;
  $("who").textContent = DEMO ? "Demo mode: sample cards, saved only on this phone." : `Signed in as ${user.email ?? "you"}`;
  $("remind").textContent = label;
  $("remind").className = reminders === "on" ? "quiet" : "primary";
  $("remind").disabled = !["on", "off"].includes(reminders);
  if (!$("remind-detail").classList.contains("warn")) say("remind-detail", DEMO ? `${detail} (Demo: nothing is sent.)` : detail);
  $("sync-detail").textContent = outbox.length ? `${plural(outbox.length, "change")} waiting to sync.` : "Everything is synced.";
  $("sync-detail").hidden = DEMO;
  $("signout").textContent = DEMO ? "Reset demo" : "Sign out";
}

// ---------- Events ----------

function bind() {
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act],[data-grade],[data-tab],[data-tick],[data-module],[data-lecture],[data-note],[data-practice],[data-primer],[data-check],[data-skip],[data-jump],[data-dg],[data-dg-all]");
    if (!t) return;
    const d = t.dataset;
    if (d.grade) return grade(Number(d.grade));
    if (d.tick) return setDone(d.tick, true);
    if (d.act === "untick") return undo && setDone(undo.id, false);
    if (d.act === "all-due") { allDue = !allDue; return render(); }
    if (d.tab) {
      tabY[tab] = scrollY;
      if (d.tab === "study" && tab === "study") { stack = [{ s: "home" }]; tabY.study = 0; } // the current tab again: back to its start
      tab = d.tab;
      render();
      return scrollTo(0, tabY[tab] ?? 0);
    }
    if (d.act === "flip") return flip();
    if (d.act === "again") { newSession(); return render(); }
    if (d.act === "remind") return $("sheet").showModal();
    if (d.act === "review") return openReview(d.m || null, d.l || null);
    if (d.act === "back") return back();
    if (d.module) return go({ s: "module", m: d.module });
    if (d.lecture) return go({ s: "lecture", id: d.lecture });
    if (d.note) return go({ s: "note", id: d.note });
    if (d.practice != null) return go({ s: "practice", m: d.practice || null });
    if (d.primer) { primer.set(top().id, d.primer === "true"); render(); return scrollTo(0, 0); }
    if (d.check) return attempt(d.check);
    if (d.skip) { shown.add(d.skip); return render(); }
    if (d.jump) {
      t.closest("details")?.removeAttribute("open");
      return document.getElementById(d.jump)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
    if (d.dg != null || d.dgAll != null) { // a blank diagram's box, or its Reveal all / Hide all
      const state = folds.get(t.closest("[data-doc]")?.dataset.doc), block = d.dg ?? d.dgAll;
      if (!state) return;
      const keys = (d.node != null ? [d.node] : [...t.closest("figure").querySelectorAll("[data-node]")].map((b) => b.dataset.node)).map((n) => `${block}:${n}`);
      const all = keys.every((k) => state.shown.has(k));
      for (const k of keys) state.shown[all ? "delete" : "add"](k);
      return render();
    }
  });
  // Revealed answers stay revealed when the page redraws.
  document.addEventListener("toggle", (e) => {
    if (!e.target.matches?.("details[data-fold]")) return;
    folds.get(e.target.closest("[data-doc]")?.dataset.doc)?.open[e.target.open ? "add" : "delete"](e.target.dataset.fold);
  }, true);
  document.addEventListener("input", (e) => {
    if (e.target.dataset?.draft == null) return;
    drafts.set(e.target.dataset.draft, e.target.value);
    syncCheck(e.target);
  });
  document.addEventListener("keydown", (e) => {
    if (tab !== "study" || top().s !== "review" || $("sheet").open || e.target.matches("textarea, input")) return;
    if (e.key === " " && !session.flipped && current()) { e.preventDefault(); flip(); }
    if (/^[1-4]$/.test(e.key)) grade(Number(e.key) - 1);
  });
  $("account").onclick = () => { say("remind-detail", ""); renderSheet(); $("sheet").showModal(); };
  $("close-sheet").onclick = () => $("sheet").close();
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) $("sheet").close(); }); // tap outside closes
  $("remind").onclick = toggleReminders;
  $("signout").onclick = signOut;
  $("redirect-signin").onclick = redirectSignIn;
  $("capture-form").onsubmit = saveCapture;
  $("quick").onsubmit = (e) => { e.preventDefault(); quickCapture(); };
  $("quick-photo").onchange = (e) => e.target.files?.[0] && quickCapture(e.target.files[0]);
  $("photo").onchange = (e) => setPhoto(e.target.files?.[0] ?? null);
  $("remove-photo").onclick = () => setPhoto(null);
  addEventListener("online", () => { cloud = ""; sb ? (refresh()) : connect(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || DEMO) return;
    if (session.day !== todayString() && !current()) newSession();
    refresh();
  });
}

// ---------- Demo fixtures (?demo=1): sample cards and a sample day, no network; ?demo=empty starts with nothing ----------

function demoCards() {
  const crg = "Corporate Restructuring & Governance", sm = "Strategic Management", t = todayString();
  const card = (id, module, lecture, front, back, user_data = {}) => ({ id, module, title: null, data: { front, back, lecture, origin: "Demo" }, user_data });
  return [
    card("crg-l1-1", crg, "L1", "What did Berle and Means (1932) identify?", "The separation of ownership and control: dispersed shareholders own the firm, professional managers run it.", { due: t, ease: 2.5, interval: 3, reps: 2, lapses: 0 }),
    card("crg-l1-2", crg, "L1", "State the agency problem in one sentence.", "Managers (agents) may pursue their own interests rather than those of shareholders (principals), because their actions are hard to observe."),
    card("crg-l1-3", crg, "L1", "Name two costs Jensen and Meckling (1976) say agency creates.", "Monitoring costs paid by the principal, bonding costs paid by the agent, and the residual loss that remains."),
    card("crg-l1-4", crg, "L1", "What does \"comply or explain\" mean in the UK Corporate Governance Code?", "Companies follow each provision or explain publicly why they don't; the market judges the explanation.", { due: t, ease: 2.35, interval: 1, reps: 3, lapses: 1 }),
    card("crg-l2-1", crg, "L2", "Which 1992 report started UK governance codes?", "The Cadbury Report, after the Maxwell and BCCI scandals."),
    card("sm-l1-1", sm, "L1", "What are the four VRIO questions?", "Is the resource Valuable, Rare, costly to Imitate, and is the firm Organised to capture its value? (Barney, 1991)"),
    card("sm-l1-2", sm, "L1", "Porter's five forces: name them.", "Rivalry, threat of new entrants, threat of substitutes, buyer power, supplier power."),
    card("sm-l1-3", sm, "L1", "Shareholder primacy versus stakeholder theory?", "Primacy: the firm exists to maximise shareholder value. Stakeholder theory: managers balance the claims of everyone the firm affects.", { due: addDays(t, 3), ease: 2.6, interval: 20, reps: 4, lapses: 0 }),
  ];
}
/** Everything Today shows, dated from today so the demo never goes stale. The brief opens with a greeting on purpose. */
function demoData() {
  const crg = "Corporate Restructuring & Governance", sm = "Strategic Management", t = todayString(), day = (n) => addDays(t, n);
  const assess = (id, module, date, data) => ({ id, source: "demo", module, title: data.title, date, data });
  const task = (id, date, title, origin, user_data = {}, more = {}) => ({ id, title, date, data: { title, origin, ...more }, user_data });
  const clockAt = (hhmm) => new Date(`${t}T${hhmm}:00`).toISOString().replace(/\.\d{3}Z$/, "Z"); // today, local time, as VoiceType writes it
  const whiteboard = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e9e8f4"/><rect x="7" y="9" width="50" height="38" rx="3" fill="#fff" stroke="#c9c8d8"/><path d="M13 19h24M13 27h32M13 35h18" stroke="#4b44a8" stroke-width="2.5" stroke-linecap="round"/><path d="M40 35l5 5 8-11" stroke="#c2410c" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M20 47l-4 10M44 47l4 10" stroke="#9a98ad" stroke-width="2"/></svg>`;
  thumbs.set("demo/whiteboard.jpg", "data:image/svg+xml," + encodeURIComponent(whiteboard));
  return {
    cards: demoCards(),
    brief: { id: "brief-" + t, date: t, data: { priority: { title: "Outline the CRG essay", due: day(1),
      why: "Hello, student—the outline goes to your tutor tomorrow, and the essay is worth 50% of the module." } } },
    assessments: [
      assess("assess-crg-essay", crg, day(5), { title: "Essay", weight: "50%", milestones: [{ date: day(1), label: "Outline to tutor" }, { date: day(12), label: "Full draft" }] }),
      assess("assess-sm-group", sm, day(24), { title: "Group presentation", weight: "30%", milestones: [{ date: day(6), label: "Slides to the group" }] }),
      assess("assess-ms-essay", "Marketing & Society", day(63), { title: "M&S essay", weight: "50%" }),
      assess("assess-sm-exam", sm, day(100), { title: "Exam", weight: "70%" }),
    ],
    tasks: [
      task("you-demo-1", day(-1), "Email Dr Amess about the essay question", "You"),
      task("auto-demo-2", t, "Read Jensen & Meckling (1976) before the seminar", "Lectures"),
      task("auto-demo-3", day(2), "Book a library group room", "Uni mail"),
      task("you-demo-4", null, "Renew railcard", "You"),
      task("you-demo-5", day(-2), "Submit module choices", "You", { done: true, doneAt: Date.now() - 2 * 86400000 }),
      task("auto-voice-demo-6", t, "Call the accommodation office", "VoiceType", {}, { remindAt: clockAt("17:30") }),
    ],
    ...demoStudy(t, day),
    applications: [{ id: "app-demo-orbis", title: null, date: day(4), data: { org: "Orbis", role: "Summer Analyst" } }],
    notes: [
      { id: "you-demo-n1", title: "Ask Dr Amess", data: { body: "Ask Dr Amess if the essay can use 2025 annual reports" }, created_at: new Date(Date.now() - 2 * 3600000).toISOString() },
      { id: "you-demo-n2", title: "Seminar whiteboard", data: { body: "Seminar whiteboard: agency costs", photo: "demo/whiteboard.jpg" }, created_at: new Date(Date.now() - 26 * 3600000).toISOString() },
    ],
  };
}

/** Study's sample: two modules, three lectures, a structured doc (every block type, a blank diagram, folded answers),
 *  Markdown notes, readings and practice. Shapes as in docs/(C) Data model.md and docs/(C) Lecture doc format.md. */
function demoStudy(t, day) {
  const crg = "Corporate Restructuring & Governance", sm = "Strategic Management";
  const note = (id, module, kind, lecture, title, data) => ({ id, module, date: null, title, data: { kind, lecture, ...data } });
  const debate = (blank) => ({ type: "graph", title: blank ? "Fill in the map" : "Should firms maximise shareholder value?",
    note: blank ? "" : "Solid arrows support; dashed ones push against.", blank, keep: blank ? ["c"] : [],
    nodes: [{ id: "c", title: "Maximise shareholder value", sub: "the contention", tone: "plain", row: 0 },
            { id: "r1", title: "One measurable objective", sub: "Jensen 2002", tone: "key", row: 1 },
            { id: "r2", title: "Profit within the rules", sub: "Friedman 1970", tone: "key", row: 1 },
            { id: "o1", title: "Harm can't be separated", sub: "Hart & Zingales 2022", tone: "con", row: 1 },
            { id: "v", title: "Maximise shareholder welfare", sub: "the verdict", tone: "verdict", row: 2 }],
    edges: [{ from: "r1", to: "c", verb: "supports", style: "solid" }, { from: "r2", to: "c", verb: "supports", style: "solid" },
            { from: "o1", to: "c", verb: "undermines", style: "dashed" }, { from: "c", to: "v", verb: "so", style: "solid" }] });
  const doc = { version: 1, blocks: [
    { t: "h1", text: "CRG L1 · Why corporate governance exists" },
    { t: "meta", text: "Corporate Restructuring & Governance (BUSI3028) · 100% exam" },
    { t: "callout", tone: "note", text: "**Built from:** the recording, 22 slides and ✎ your notes. Small numbers¹ point to sources." },
    { t: "table", header: ["Key term", "In one line"], rows: [["**Agency problem**", "Managers may serve themselves, not the owners"], ["**Moral hazard**", "Hidden *actions*: is the manager working for us?"], ["**Blockholder**", "An owner big enough (8–10%) to make monitoring pay"]] },
    { t: "h2", text: "1. The lecture in a minute" },
    { t: "p", text: "Once thousands of shareholders own a firm that a few managers run, **nobody has a reason to watch the managers**. That gap is the agency problem, and governance is the toolkit for closing it.¹" },
    { t: "callout", tone: "warn", text: "✎ **Exam steer:** shareholder value won't be a whole question, but it may be part (a) of one." },
    { t: "h2", text: "2. The lecture, step by step" },
    { t: "h3", text: "2.1 Why don't shareholders just watch managers?" },
    { t: "p", text: "Because monitoring is a *public good*: the monitor pays the full cost and shares the gain with every owner. See [the ECGI primer](https://ecgi.global/) for more." },
    { t: "bullets", items: ["Smith (1776): managers aren't careful with other people's money.", "Berle & Means (1932): law separates ownership from control."] },
    { t: "diagram", caption: "**Takeaway:** a claim, two reasons, one objection, then a verdict with a condition.", diagram: debate(false) },
    { t: "callout", tone: "key", text: "✔ **Check yourself:** why does *more* shareholders make monitoring *less* likely? *Answer in section 4.*" },
    { t: "h3", text: "2.2 Where each idea comes from" },
    { t: "diagram", caption: "Quote the year with the name.", diagram: { type: "timeline", title: "The debate over time", events: [
      { label: "1776", text: "Smith: 'negligence and profusion'", tone: "plain" }, { label: "1932", text: "Berle & Means: ownership ≠ control", tone: "key" },
      { label: "1970", text: "Friedman: one social responsibility", tone: "plain" }, { label: "2022", text: "Hart & Zingales: welfare, not value", tone: "con" }] } },
    { t: "table", header: ["", "Friedman (1970)", "Jensen (2002)", "Hart & Zingales (2022)"], rows: [["Maximise", "Profit", "Firm value", "Shareholder welfare"], ["Weak spot", "Inseparable harm", "Needs fair prices", "Whose welfare?"]] },
    { t: "quote", text: "The social responsibility of business is to increase its profits." },
    { t: "h2", text: "3. Use it in the exam" },
    { t: "callout", tone: "warn", text: "**Common mistakes:**\n• Stating a point without the logic behind it.\n• Describing every theory instead of arguing with two." },
    { t: "h2", text: "4. Study it" },
    { t: "diagram", caption: "**Do this first:** fill in the blank map from memory, then check it against 2.1.", diagram: debate(true) },
    { t: "numbers", items: ["Why is monitoring a public good when ownership is dispersed?", "What's the difference between moral hazard and adverse selection?"] },
    { t: "callout", tone: "note", text: "**Answers.** 1 The monitor pays the full cost but shares the gain with every owner. 2 Hidden actions versus hidden qualities." },
    { t: "inshort", items: ["Dispersed owners don't monitor.", "Governance closes the gap.", "The exam wants the condition, not a list."] },
    { t: "h2", text: "Sources" },
    { t: "sources", items: ["Lecture recording 9:23–10:15; ✎ your notes.", "Slides 4–6."] },
  ] };
  return {
    modules: [
      { id: "mod-crg", module: crg, title: crg, data: { code: "BUSI3028", short: "CRG", convenor: "Prof Kevin Amess", assessment: "Exam, 2 hours, 100%, 2 essays from 6, January", next: "L2 Wed 10:00 · Jensen & Meckling model · exam 100%" } },
      { id: "mod-sm", module: sm, title: sm, data: { code: "BUSI3186", short: "SM", convenor: "Dr Andrew Wild", assessment: "Group video 30% due 10 Dec · case study 70% due 13 May", next: "L2 Fri 09:00 · External analysis" } },
    ],
    lectures: [
      { id: "lec-crg-l1", module: crg, date: day(-6), title: null, data: { n: "L1", topic: "Why corporate governance exists", pre: "auto-pre-crg-l1", post: "auto-post-crg-l1" }, user_data: {} },
      { id: "lec-crg-l2", module: crg, date: day(1), title: null, data: { n: "L2", topic: "The Jensen & Meckling model", pre: "auto-pre-crg-l2" }, user_data: {} },
      { id: "lec-sm-l1", module: sm, date: day(-4), title: null, data: { n: "L1", topic: "What is strategy?", post: "auto-post-sm-l1" }, user_data: {} },
    ],
    lectureNotes: [
      note("auto-pre-crg-l1", crg, "pre", "L1", "CRG L1 primer", { body: "Before L1: skim **Berle & Means (1932)**, the abstract only.\n\n- Who owns a listed firm?\n- Who runs it, and why might they differ?" }),
      note("auto-post-crg-l1", crg, "post", "L1", "CRG L1 · Why corporate governance exists", { body: "## One-page core\nDispersed owners don't monitor.", doc }),
      note("auto-pre-crg-l2", crg, "pre", "L2", "CRG L2 primer", { body: "## Before L2\nThe *Jensen & Meckling (1976)* model is \"as hard as it gets\": one graph, no heavy maths.\n\n1. Draw firm value against the manager's share.\n2. Mark where perks start to cost the owners.\n\n> Read the introduction and conclusion; skip the proofs." }),
      note("auto-post-sm-l1", sm, "post", "L1", "SM L1 · What is strategy?", { body: "## One-page core\n**Strategy** is a set of choices about where to compete and how to win (Porter, 1996).\n\n| Theory | Question it answers | Use it for |\n|---|---|---|\n| Five Forces | How attractive is the industry? | Part 1: why change started |\n| VRIO | Which resources give an edge? | Part 2: what changed |\n| Upper echelons | How do leaders shape it? | Part 3: leadership |\n\n## How to do well\n- Use 2–3 theories **systematically**, not a tour of every model.\n  - Apply each one to the case evidence.\n- Five Forces substitutes are *other products* (trains versus flights).\n\n> Last year's markers punished describing the case instead of applying theory.\n\n---\nSlides and the brief are on [Moodle](https://moodle.nottingham.ac.uk/)." }),
      note("auto-crg-l1-readings", crg, "readings", "L1", "CRG L1 readings", { body: "- **Jensen (2002)**, *Value maximization, stakeholder theory and the corporate objective function*. Essential.\n- Hart & Zingales (2022). Read the abstract, introduction and conclusion." }),
    ],
    practice: [
      { id: "crg-l1-svm", module: crg, title: null, data: { kind: "essay", lecture: "L1", origin: "From the CRG L1 notes",
        prompt: "Should firms maximise shareholder value? Answer with Friedman (1970) and Hart & Zingales (2022).",
        model: "**Thesis:** yes, *but only when* the firm's harms are separable and reversible.\n\n1. Friedman: profit within the rules; governments provide social goods.\n2. Jensen: one measurable objective beats many conflicting ones.\n3. Against: when harm can't be separated from production (PFAS), the firm prevents it more cheaply than anyone can clean it up.\n\n**Verdict:** Hart & Zingales' shareholder *welfare* keeps primacy and is still not stakeholder theory." }, user_data: {} },
      { id: "crg-l1-monitor", module: crg, title: null, data: { kind: "short", lecture: "L1", origin: "From the CRG L1 notes",
        prompt: "Why is monitoring managers a public good when ownership is dispersed?",
        model: "The monitor bears the **full cost** but shares the **gain** with every shareholder, so no small owner's private benefit exceeds their cost. Blockholders of about 8–10% are the exception." }, user_data: {} },
      { id: "sm-l1-substitutes", module: sm, title: null, data: { kind: "short", lecture: "L1", origin: "From the SM L1 notes",
        prompt: "In Five Forces, is easyJet a substitute for Ryanair?",
        model: "No. They are **rivals** in the same industry. A substitute is a different product meeting the same need, such as trains instead of flights." },
        user_data: { attempt: "No, they're rivals; a substitute would be something like the train.", attemptedAt: Date.now() - 86400000 } },
    ],
  };
}

start();
