// Sidebrain on the phone: what's on and due today, study (flashcards, lecture notes, practice), and quick to-dos and notes,
// on the same Supabase backend as the Mac app. Every review and practice attempt writes items.user_data and one `activity`
// row exactly as Sources/(C) View Study.swift does; a tick writes what Sources/(C) View Today.swift does. Every user_data
// write is merged into the row's user_data and carries `userAt`, so the server can keep the newer one.
// Writes go through a small outbox in localStorage, so a review on a train with no signal is never lost.
import { schedule, intervalLabel, due, nextDue, examDays, todayString, daysBetween, addDays } from "./sm2.js";
import { withoutGreeting, dueSoon, dueLabel, runway, gone, parseWhen, daySchedule, ago, priorityDueLabel, shortDay, WEEKDAYS, MONTHS,
         upNext, inbox, fireAt, snoozeChoices, nextBrief, briefLabel, clock } from "./today.js";
import { esc, markdown, lectureDoc, lectureNotes, ordered, lectureDay, TICK } from "./notes.js";

// ---- Settings to fill in before publishing (web/(C) README.md) ----
const SUPABASE_URL = "https://rdwavprncthvujmckige.supabase.co";
// Public by design, the same key the Mac app ships (Sources/(C) Flavor.swift); row-level security protects every row.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkd2F2cHJuY3RodnVqbWNraWdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEwNDg2MjYsImV4cCI6MjA3NjYyNDYyNn0.eg_I1CtKu3dF98JdLB8eU4Yww1NkJXtlRVo4orapeTM";
const GOOGLE_CLIENT_ID = "327768131024-jqlmp8jeb6qtouq2b4sv8v1pigss6fa4.apps.googleusercontent.com";  // the Google *Web* OAuth client ID (README step 1)
// Optional override. Empty: the app asks the push function for it (GET /functions/v1/push → {publicKey}).
const VAPID_PUBLIC_KEY = "";
const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
// ponytail: supabase-js from a pinned CDN URL, no integrity check; vendor the file into web/ if that ever matters.

const DEMO_MODE = new URLSearchParams(location.search).get("demo");
const DEMO = DEMO_MODE === "1" || DEMO_MODE === "empty"; // ?demo=empty: a new friend's account, nothing in it yet
const NAMES = ["Again", "Hard", "Good", "Easy"];
const FRESH = 5 * 60000; // refresh every 5 minutes while the app is open
const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Per-device state. Demo mode keeps its own keys so it never mixes with real data.
const PREFIX = DEMO ? `sidebrain.demo${DEMO_MODE === "empty" ? "-empty" : ""}.` : "sidebrain.";
const load = (k, fallback) => { try { return JSON.parse(localStorage.getItem(PREFIX + k)) ?? fallback; } catch { return fallback; } };
const keep = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* private mode: the app still works, just without the offline copy */ } };

let sb = null, user = null;
let cards = [], byId = new Map(), assessments = [], tasks = [], applications = [], events = [], brief = null, notes = [], pings = [];
let modules = [], lectures = [], practice = [], noteById = new Map(); // Study: lecture notes are `note` items, by id
let thumbs = new Map();              // photo path → signed URL (or a data URL in demo), for capture thumbnails
let outbox = load("outbox", []);     // [{t: "review" | "tick" | "edit" | "attempt", id, user_data, activity?} | {t: "note" | "add", row}], oldest first
let captures = load("captures", []); // the last captures made on this phone: {id, body, photo, thumb?, at}
let synced = load("synced", 0), tried = 0;
let tab = "today", reviewing = false, loaded = false, cloud = "", syncError = "", signedOutOfSync = false, reminders = "off";
const photos = { capture: null, add: null }; // the photo waiting in each composer
// Today's view state.
const held = new Map();     // task id → {kind: "done" | "gone", at, timer}: shown (ticked or leaving) until it collapses
const datesShown = new Set(); // coursework ids showing their date instead of the countdown
let openSlipped = false, openEarlier = false, allDue = false, allEvents = false, allNext = false, sheetTask = null, sheetPing = null;
let addMode = "todo", todoIgnore = new Set(), todoParse = null, todoManual = null;
const session = { queue: [], index: 0, flipped: false, grades: [0, 0, 0, 0], day: "", module: null, lecture: null };
// Study screens, pushed and popped inside the tab like the Mac's StudyView: {s: "home" | "module" | "lecture" | "note" |
// "practice", m?, id?, y (scroll to come back to)}.
let stack = [{ s: "home" }];
const drafts = new Map();      // practice id → the answer being typed (kept across re-renders)
const shown = new Set();       // practice ids whose model answer is showing
const primer = new Map();      // lecture id → true when the Primer is chosen over the Notes
const folds = new Map();       // note id → {open: Set of revealed answer blocks, shown: Set of "block:node" tapped open}
const tabY = {};               // each tab's scroll, so switching tabs comes back to the same place

// ---------- Start ----------

async function start() {
  navigator.serviceWorker?.register("sw.js").catch(() => {});
  navigator.storage?.persist?.().catch(() => {}); // ask Safari not to evict the offline copy and the outbox
  if (!("switch" in HTMLInputElement.prototype)) document.documentElement.classList.add("noswitch");
  for (const form of document.querySelectorAll("form.compose")) form.innerHTML = composer();
  bind();
  setInterval(tickClock, 60000);
  if (DEMO) {
    user = { email: "Demo" };
    reminders = load("reminders", false) ? "on" : "off";
    synced = Date.now();
    useData(DEMO_MODE === "empty" ? {} : demoData());
    render();
    return routePending(true);
  }
  const cached = load("cache", null);
  if (cached && load("user", null)) { user = load("user", null); useData({ ...cached, lectureNotes: load("lecture-notes", []) }); }
  render();
  if (loaded) routePending(false); // the cached copy, when it already has what the link points at
  await connect();
}

async function connect() {
  if (sb) return;
  try {
    const { createClient } = await import(SUPABASE_JS);
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } });
  } catch {
    cloud = "Offline. Changes are saved on this phone and sync when it reconnects.";
    if (!user) say("signin-status", "Offline. Connect to sign in.", true);
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
  user = null; cards = []; byId = new Map(); tasks = []; applications = []; events = []; brief = null; notes = []; pings = []; loaded = false;
  modules = []; lectures = []; practice = []; noteById = new Map(); stack = [{ s: "home" }]; reviewing = false;
  localStorage.removeItem(PREFIX + "user"); // the outbox stays, and syncs after the next sign-in
  render();
  showSignIn();
}

/** Every minute: the footnote and the schedule's "now" line move on; while the app is open, data older than 5 minutes is fetched again. */
function tickClock() {
  if (document.visibilityState !== "visible") return;
  if (!DEMO && user && Date.now() - Math.max(synced, tried) > FRESH) refresh();
  else render(); // repaints only what changed (an event passing); the footnote's text is set on its own
  updateFoot();
}

// ---------- Data ----------

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
  tried = Date.now();
  try {
    const today = todayString();
    const [c, a, t, ap, ev, b, n, mo, le, pr, ln, pg] = await Promise.all([
      all("card", "id,module,title,data,user_data,updated_at"), all("assessment", "id,source,module,title,data,date,user_data"),
      all("task", "id,source,title,date,data,user_data,created_at,updated_at"), all("application", "id,title,date,data,user_data"),
      run(items("event", "id,title,date,data,user_data").gte("date", addDays(today, -14)).lte("date", addDays(today, 7))), // earlier ones may still be running; Up next runs to Sunday
      run(items("brief", "id,date,data").eq("date", today).limit(1)),
      run(items("quicknote", "id,source,title,data,user_data,created_at").order("created_at", { ascending: false }).limit(50)),
      all("module", "id,module,title,data"), all("lecture", "id,module,date,title,data,user_data"),
      all("practice", "id,module,title,data,user_data,updated_at"), all("note", "id,module,date,title,data,user_data,updated_at"),
      // ponytail: the last 30 days of pings; page further back if the Inbox ever needs older ones.
      run(items("ping", "id,title,date,data,user_data,updated_at").gte("date", addDays(today, -30)).lte("date", addDays(today, 7))),
    ]);
    const fresh = { cards: c, assessments: a, tasks: t, applications: ap, events: ev, brief: b[0] ?? null, notes: n, modules: mo, lectures: le, practice: pr, pings: pg };
    // Lecture notes are the bulk (~25 KB each with their doc), so they get their own key: if they ever outgrow
    // localStorage, only offline reading is lost, never the cards and the outbox.
    // ponytail: localStorage for notes; move them to IndexedDB if a term's worth stops fitting (about 5 MB).
    useData({ ...fresh, lectureNotes: ln });
    for (const [k, v] of blobs) if (v === false) blobs.delete(k); // a failed download tries again on the next refresh
    keep("lecture-notes", [...noteById.values()]); // merged, so a guess or a tick made during the fetch stays
    saveCache(); // merged, so a write made during the fetch stays
    cloud = ""; syncError = "";
    synced = Date.now(); keep("synced", synced);
    signThumbs();
  } catch (e) {
    cloud = loaded ? "Couldn’t reach Sidebrain. Showing what’s saved on this phone." : `Couldn’t load: ${e.message || "network error"}`;
  }
  render();
  routePending(true);
  flush();
  reminders = await reminderStatus();
  render();
}

/** Fetched rows merged with what this phone knows, so a fetch that was already in flight can't undo a tick or a review:
 *  a local user_data wins when its userAt is newer than the fetched row's (its user_data.userAt, else its updated_at),
 *  and rows added here in the last 10 minutes stay until the server returns them. */
const stamp = (row) => (typeof row.user_data?.userAt === "number" ? row.user_data.userAt : Date.parse(row.updated_at) || 0);
function merge(fetched = [], local = []) {
  const mine = new Map(local.map((x) => [x.id, x]));
  const out = fetched.map((f) => {
    const l = mine.get(f.id), at = l?.user_data?.userAt;
    return typeof at === "number" && at > stamp(f) ? { ...f, user_data: l.user_data } : f;
  });
  const seen = new Set(fetched.map((f) => f.id)), recent = Date.now() - 10 * 60000;
  return out.concat(local.filter((l) => !seen.has(l.id) && l.source === "you" && Date.parse(l.created_at) > recent));
}

/** New server data. Writes still in the outbox win too, so a card graded offline doesn't come back as due. */
function useData(d) {
  const pending = new Map(outbox.filter((o) => o.user_data).map((o) => [o.id, o.user_data]));
  const withPending = (list = []) => list.map((x) => (pending.has(x.id) ? { ...x, user_data: pending.get(x.id) } : x));
  const added = outbox.filter((o) => o.t === "add").map((o) => ({ ...o.row, created_at: o.at }));
  cards = withPending(merge(d.cards, cards));
  byId = new Map(cards.map((x) => [x.id, x]));
  tasks = withPending(merge([...(d.tasks ?? []).filter((x) => !added.some((a) => a.id === x.id)), ...added], tasks));
  assessments = d.assessments ?? []; applications = d.applications ?? []; events = d.events ?? []; brief = d.brief ?? null; notes = d.notes ?? [];
  modules = [...(d.modules ?? [])].sort((a, b) => ((a.data?.code ?? "") < (b.data?.code ?? "") ? -1 : 1));
  lectures = d.lectures ?? []; practice = withPending(merge(d.practice, practice)); pings = withPending(merge(d.pings, pings));
  noteById = new Map(withPending(merge(d.lectureNotes, [...noteById.values()])).map((x) => [x.id, x]));
  loaded = true;
  if (!reviewing && (session.index === 0 || session.day !== todayString())) newSession(); // never reshuffle a session in progress, even on its first card
}

const saveCache = () => { if (!DEMO) keep("cache", { cards, assessments, tasks, applications, events, brief, notes, modules, lectures, practice, pings }); };

// ---------- Writes ----------

const activity = (id, kind, now, payload = {}) => ({ id: crypto.randomUUID(), item_id: id, at: new Date(now).toISOString(), kind, payload });

/** Merges `patch` into the row's user_data (Store.setUser), stamps userAt and queues it. The caller renders. */
function writeUser(item, patch, t, act = null) {
  const now = Date.now(), before = item.user_data ?? {};
  item.user_data = { ...before, ...patch, userAt: now };
  outbox.push({ t, id: item.id, user_data: item.user_data, activity: act, before });
  keep("outbox", outbox);
  saveCache();
  if (!DEMO && noteById.has(item.id)) keep("lecture-notes", [...noteById.values()]);
  flush();
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
  writeUser(card, next, "review", activity(card.id, "review", now, { grade: g, interval: next.interval, ease: next.ease }));
  session.grades[g] += 1;
  if (g === 0) session.queue.push(card.id); // Again is due today, so it comes round once more this session
  session.index += 1; session.flipped = false;
  render();
}

/** Tick: {done: true, doneAt} plus a `done` activity row. The row stays, ticked, for 6 s; tapping the tick again undoes it
 *  with {done: false, doneAt: null} and no activity (the server only allows review/attempt/done/edit/snooze). */
function tick(id) {
  const task = tasks.find((x) => x.id === id);
  if (!task) return;
  const h = held.get(id);
  if (h?.kind === "done" || task.user_data?.done === true) {
    clearTimeout(h?.timer); held.delete(id);
    writeUser(task, { done: false, doneAt: null }, "tick");
    return render();
  }
  const now = Date.now();
  writeUser(task, { done: true, doneAt: now }, "tick", activity(id, "done", now));
  held.set(id, { kind: "done", at: now, timer: setTimeout(() => collapse(id), 6000) });
  render();
}

/** The row folds away (height over 300 ms), then the list redraws without it. */
function collapse(id) {
  const li = $("today").querySelector(`[data-row="${CSS.escape(id)}"]`);
  const finish = () => { held.delete(id); render(); };
  if (!li || still()) return finish();
  li.style.height = li.offsetHeight + "px";
  li.classList.add("collapsing");
  void li.offsetHeight;
  li.style.height = "0px"; li.style.opacity = "0";
  setTimeout(finish, 300);
}

/** Reschedule: user_data.doDate, which wins over the row's own date (R1). */
function move(id, day) {
  const task = tasks.find((x) => x.id === id), today = todayString();
  if (!task || !day || day < today) return; // a picker that lets a past day through (min isn't enforced everywhere)
  const prev = task.user_data ?? {};
  writeUser(task, { doDate: day }, "edit");
  $("task-sheet").close();
  if (daysBetween(today, day) > 7) { // off Due soon: the row says where it went, then folds away
    held.set(id, { kind: "moved", at: Date.now(), prev, note: `Moved to ${dayName(day, today)}` });
    setTimeout(() => collapse(id), 1800);
  }
  render();
}

/** Let go: {dismissed: true}; the row folds away. */
function letGo(id) {
  const task = tasks.find((x) => x.id === id);
  if (!task) return;
  writeUser(task, { dismissed: true }, "edit");
  held.set(id, { kind: "gone", at: Date.now() });
  $("task-sheet").close();
  render();
  requestAnimationFrame(() => collapse(id));
}

/** A new to-do: the row the Mac's quick add writes (Store.addOwn: kind task, source you, data {title, origin: "You"}). */
function addTask(title, date) {
  const now = Date.now(), at = new Date(now).toISOString();
  const row = { id: "you-" + crypto.randomUUID(), kind: "task", source: "you", module: null, date: date ?? null, title,
                data: { title, origin: "You" }, user_data: {}, deleted_at: null };
  outbox.push({ t: "add", row, at });
  keep("outbox", outbox);
  tasks.push({ ...row, created_at: at, fresh: now });
  saveCache();
  flush();
  render();
}

/** Attempt first: saves {attempt, attemptedAt, feedback: null} and an `attempt` activity row with the answer's length,
 *  then shows the model answer (PracticeCard.check). No AI feedback on the phone yet. */
function attempt(id) {
  const q = practice.find((x) => x.id === id), saved = q?.user_data?.attempt ?? "", text = (drafts.get(id) ?? saved).trim();
  if (!q || !text) return;
  if (text === saved) { shown.add(id); return render(); } // tried before and unchanged: just show the model answer
  const now = Date.now();
  writeUser(q, { attempt: text, attemptedAt: now, feedback: null }, "attempt", activity(id, "attempt", now, { length: [...text].length }));
  shown.add(id);
  render();
}

// ---------- Sync ----------

let flushing = false;
async function flush() {
  if (DEMO || !sb || !user?.id || flushing || !outbox.length) return;
  flushing = true;
  try {
    while (outbox.length) {
      const op = outbox[0];
      let r = op.row ? await sb.from("items").upsert(op.row, { onConflict: "user_id,id", ignoreDuplicates: true })
                     : await sb.from("items").update({ user_data: op.user_data }).eq("id", op.id);
      const landed = !r.error;
      if (landed && op.activity) r = await sb.from("activity").upsert(op.activity, { onConflict: "id", ignoreDuplicates: true }); // only once the item landed
      if (r.error) {
        // Offline, signed out, timed out, throttled or a server hiccup: keep it for later.
        signedOutOfSync = r.status === 401;
        if (!r.status || [401, 408, 429].includes(r.status) || r.status >= 500) throw r.error;
        // Refused for good: undo it on this phone (unless only the activity row was refused) and say so once.
        if (!landed) rollback(op);
        syncError = "Couldn’t save that change.";
      } else signedOutOfSync = false;
      outbox.shift();
      keep("outbox", outbox);
    }
  } catch { /* stays in the outbox; retried on the next change, when back online, or when the app reopens */ }
  finally { flushing = false; render(); }
}

/** A change the server refused for good: the row goes back to what it was before (a later queued change to the same
 *  row keeps its own say), and a refused new row leaves this phone. */
function rollback(op) {
  if (op.row) {
    tasks = tasks.filter((x) => x.id !== op.row.id);
    captures = captures.filter((x) => x.id !== op.row.id); keep("captures", captures);
  } else if (!outbox.slice(1).some((o) => o.id === op.id)) {
    const item = [...cards, ...tasks, ...practice, ...pings, ...noteById.values()].find((x) => x.id === op.id);
    if (item) item.user_data = op.before ?? {};
  }
  saveCache();
}

// ---------- Capture ----------

const titleOf = (body) => body.split("\n")[0].trim().slice(0, 80) || "Photo";

async function shrink(file, max = 1600) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => { throw new Error("Couldn’t read that photo."); });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn’t read that photo."))), "image/jpeg", 0.82));
}

const dataUrl = (blob) => new Promise((ok, fail) => Object.assign(new FileReader(), { onload: (e) => ok(e.target.result), onerror: fail }).readAsDataURL(blob));

/** The one capture path, for the Capture tab and the Add sheet. True when the note was saved. */
async function capture(body, file, status, cls = null) {
  if (!body && !file) { say(status, "Write something or add a photo first.", true); return false; }
  const id = "you-" + crypto.randomUUID(); // Store.addOwn's id shape
  try {
    let photo = null, thumb = null;
    if (file) {
      const jpeg = await shrink(file); // demo too, so it runs the same path
      thumb = await dataUrl(await shrink(jpeg, 160)); // ~6 KB, so the list shows the photo offline and in demo
      if (DEMO) photo = "demo";
      else {
        if (!navigator.onLine) throw new Error("Offline. Photos need a connection, so the note is still here.");
        photo = `${user.id}/${id}.jpg`;
        const { error } = await sb.storage.from("captures").upload(photo, jpeg, { contentType: "image/jpeg" });
        if (error) throw error;
      }
    }
    // ponytail: a photo can't wait in the outbox (localStorage is too small); keep it in IndexedDB if offline photos matter.
    const row = { id, kind: "quicknote", source: "you", module: cls?.module ?? null, date: null, title: titleOf(body),
                  data: { body, ...(photo ? { photo } : {}), ...(cls?.lecture ? { lecture: cls.lecture } : {}) }, user_data: {}, deleted_at: null };
    outbox.push({ t: "note", row });
    keep("outbox", outbox);
    captures = [{ id, body, photo: !!photo, thumb, at: Date.now() }, ...captures].slice(0, 20);
    keep("captures", captures);
    say(status, "");
    flush();
    return true;
  } catch (e) {
    say(status, e.message || "Couldn’t save. Try again.", true);
    return false;
  } finally {
    render();
  }
}

async function saveCompose(form) {
  const name = form.dataset.compose, button = form.querySelector("[type=submit]"), status = form.querySelector("[role=status]");
  button.disabled = true;
  const ok = await capture(form.elements.body.value.trim(), photos[name], status, name === "add" ? captureFor : null);
  if (ok) { form.elements.body.value = ""; setPhoto(form, null); }
  canSave(form);
  if (ok && name === "add") $("add-sheet").close();
}

/** Thumbnails for synced captures with a photo that this phone has no copy of (another phone, or after a sign-out). */
async function signThumbs() {
  const paths = notes.map((n) => n.data?.photo).filter((p) => typeof p === "string" && !thumbs.has(p));
  if (!paths.length) return;
  const { data } = await sb.storage.from("captures").createSignedUrls(paths, 3600).catch(() => ({}));
  for (const x of data ?? []) if (x.signedUrl) thumbs.set(x.path, x.signedUrl);
  render();
}

function setPhoto(form, file) {
  const name = form.dataset.compose, img = form.querySelector(".preview img");
  photos[name] = file;
  if (img.src) URL.revokeObjectURL(img.src);
  img.removeAttribute("src");
  if (file) img.src = URL.createObjectURL(file);
  form.querySelector(".preview-li").hidden = form.querySelector(".remove-li").hidden = !file;
  form.querySelector(".photo .title").textContent = file ? "Retake photo" : "Add photo";
  form.elements.photo.value = "";
  canSave(form);
}

/** Captures, newest first: this phone's, then the synced ones it didn't make (not marked done on the Mac). */
function captureList() {
  const local = new Set(captures.map((c) => c.id)), cleared = new Set(notes.filter(gone).map((n) => n.id));
  return [...captures.filter((c) => !cleared.has(c.id)), ...notes.filter((n) => !local.has(n.id) && !gone(n))
    .map((n) => ({ id: n.id, body: n.data?.body ?? n.title, photo: !!n.data?.photo, at: Date.parse(n.created_at) || 0, path: n.data?.photo }))]
    .sort((a, b) => b.at - a.at);
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

const REMINDER_NOTE = {
  busy: "Turning on…", install: "Add Sidebrain to the Home Screen first", denied: "Notifications are off in Settings",
  unsupported: "Not available in this browser", unset: "Not set up yet",
};
let reminderError = "";

async function toggleReminders() {
  const was = reminders;
  reminderError = "";
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
      if (!key) throw new Error("not set up yet");
      const sub = await (await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
      const { endpoint, keys } = sub.toJSON();
      const { error } = await sb.from("push_subscriptions").upsert({ endpoint, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: "user_id,endpoint" });
      if (error) { await sub.unsubscribe(); throw error; }
    }
  } catch (e) {
    reminderError = `Couldn’t change it: ${e.message || "try again"}`;
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
  if (!GOOGLE_CLIENT_ID) return say("signin-status", "Sign-in isn’t set up yet: the Google Web client ID goes in app.js.", true);
  $("redirect-signin").hidden = false;
  if (gsiReady) return;
  try {
    await new Promise((ok, fail) => document.head.append(Object.assign(document.createElement("script"), { src: "https://accounts.google.com/gsi/client", onload: ok, onerror: fail })));
  } catch {
    return say("signin-status", "Couldn’t reach Google. Check the connection and open Sidebrain again.", true);
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
  // GIS has no supported way to start this ID-token flow from a custom button, so this is its own button, as wide as it goes.
  google.accounts.id.renderButton($("gsi"), { theme: dark ? "filled_black" : "outline", size: "large", shape: "pill", text: "continue_with", logo_alignment: "left",
    width: Math.min(400, Math.round($("gsi").getBoundingClientRect().width) || 358) });
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
  if (outbox.length && !confirm(`${plural(outbox.length, "change")} ${outbox.length === 1 ? "hasn’t" : "haven’t"} synced yet and will be lost. Sign out anyway?`)) return;
  for (const k of ["outbox", "captures", "cache", "user", "synced"]) localStorage.removeItem(PREFIX + k);
  outbox = []; captures = [];
  $("sheet").close();
  navigator.clearAppBadge?.().catch(() => {});
  // Local scope: supabase-js defaults to "global", which revoked the Macs' sessions too (7 Oct, sync stopped on both).
  await sb?.auth.signOut({ scope: "local" });
  signedOut();
}

// ---------- Rendering ----------

function say(target, text, warn = false) {
  const el = typeof target === "string" ? $(target) : target;
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("warn", warn);
}

/** Replaces an element's HTML only when it changed, so typing, focus, open menus and running animations survive. */
function paint(el, html) {
  if (el._html === html) return false;
  el.innerHTML = el._html = html;
  return true;
}

const top = () => stack[stack.length - 1];

const TABS = ["today", "study", "inbox", "capture"];
function render() {
  const signedIn = !!user, today = todayString(), root = document.documentElement;
  const pushed = signedIn && tab === "study" && stack.length > 1;
  root.classList.toggle("reviewing", signedIn && reviewing);
  $("signin").hidden = signedIn;
  $("dock").hidden = !signedIn;
  for (const t of TABS) $(t).hidden = !signedIn || tab !== t;
  $("review").hidden = !(signedIn && reviewing);
  $("back").hidden = !pushed;
  $("account").hidden = !signedIn || pushed;
  $("account").textContent = (user?.email || "?")[0].toUpperCase();
  $("bar-title").textContent = !signedIn ? "Sidebrain" : tab === "study" ? screenTitle(top()) : { today: "Today", capture: "Capture", inbox: "Inbox" }[tab];
  $("tabs").style.setProperty("--i", TABS.indexOf(tab));
  for (const b of $("tabs").querySelectorAll("button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (signedIn && loaded) navigator.setAppBadge?.(due(cards, today).length).catch(() => {});
  if (signedIn) { renderToday(today); renderStudy(today); renderReview(today); renderCaptures(); renderInbox(); renderSheet(); }
  $("contents").hidden = !pushed || !screenSections.length;
  if ($("contents").hidden) setContents(false);
  watchTitle();
}

// The large title scrolls away under the bar; once it has gone, html.scrolled fades in the small title and the edge strip.
let watched = null;
const titleWatch = new IntersectionObserver(([e]) => {
  if (e) document.documentElement.classList.toggle("scrolled", !e.isIntersecting && e.boundingClientRect.top < 100);
}, { rootMargin: "-44px 0px 0px 0px" });
function watchTitle() {
  const el = [...document.querySelectorAll("main .page:not([hidden]) > .large")][0] ?? null;
  if (el === watched) return;
  if (watched) titleWatch.unobserve(watched);
  watched = el;
  if (el) titleWatch.observe(el); else document.documentElement.classList.remove("scrolled");
}

/** Line icons: SF Symbols shapes, 1.75 stroke. */
const svg = (d, cls = "glyph") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  chev: `<svg class="chev" viewBox="0 0 7 12" aria-hidden="true"><path d="M1 1l5 5-5 5"/></svg>`,
  cap: svg(`<path d="M2.75 9.25L12 5l9.25 4.25L12 13.5z"/><path d="M6.75 11.25v4.25c1.4 1.4 3.15 2.1 5.25 2.1s3.85-.7 5.25-2.1v-4.25M21.25 9.25v5"/>`),
  briefcase: svg(`<rect x="3.25" y="7.25" width="17.5" height="12.5" rx="2.5"/><path d="M8.75 7.25V5.9c0-.9.7-1.65 1.6-1.65h3.3c.9 0 1.6.75 1.6 1.65v1.35M3.25 12.5h17.5"/>`),
  clock: svg(`<circle cx="12" cy="12" r="8.25"/><path d="M12 7.5V12l3 2"/>`),
  practice: svg(`<rect x="4.75" y="4.25" width="14.5" height="16.5" rx="2.5"/><path d="M9 4.25v-.5c0-.55.45-1 1-1h4c.55 0 1 .45 1 1v.5M8.5 10.5h7M8.5 14h7M8.5 17.5h4"/>`),
  calendar: svg(`<rect x="3.75" y="5.25" width="16.5" height="15" rx="2.75"/><path d="M3.75 9.75h16.5M8 3.25v3.5M16 3.25v3.5"/>`),
  nextWeek: svg(`<rect x="3.75" y="5.25" width="16.5" height="15" rx="2.75"/><path d="M3.75 9.75h16.5M8 3.25v3.5M16 3.25v3.5M9 15h6M13 13l2 2-2 2"/>`),
  sun: svg(`<circle cx="12" cy="12" r="3.75"/><path d="M12 2.75v2M12 19.25v2M2.75 12h2M19.25 12h2M5.46 5.46l1.41 1.41M17.13 17.13l1.41 1.41M5.46 18.54l1.41-1.41M17.13 6.87l1.41-1.41"/>`),
  sunrise: svg(`<path d="M3 18.25h18M7.25 18.25a4.75 4.75 0 0 1 9.5 0M12 4v5M9.5 6.5L12 4l2.5 2.5M4.6 12.6l1.4 1.1M19.4 12.6l-1.4 1.1"/>`),
  bell: svg(`<path d="M6.25 16.75V11a5.75 5.75 0 0 1 11.5 0v5.75l1.5 1.5H4.75zM10 20.25a2 2 0 0 0 4 0"/>`),
  sync: svg(`<path d="M19.25 12a7.25 7.25 0 0 1-12.6 4.9M4.75 12a7.25 7.25 0 0 1 12.6-4.9M17.75 3.75v3.5h-3.5M6.25 20.25v-3.5h3.5"/>`),
  person: svg(`<circle cx="12" cy="8.5" r="3.75"/><path d="M4.75 20.25c.6-3.6 3.6-5.75 7.25-5.75s6.65 2.15 7.25 5.75"/>`),
  camera: svg(`<path d="M3.75 8.75a2.5 2.5 0 0 1 2.5-2.5h1.9l1.5-2h4.7l1.5 2h1.9a2.5 2.5 0 0 1 2.5 2.5v8.5a2.5 2.5 0 0 1-2.5 2.5H6.25a2.5 2.5 0 0 1-2.5-2.5z"/><circle cx="12" cy="12.75" r="3.5"/>`),
  xmark: svg(`<circle cx="12" cy="12" r="8.25"/><path d="M9.25 9.25l5.5 5.5M14.75 9.25l-5.5 5.5"/>`),
  check: svg(`<circle cx="12" cy="12" r="8.25"/><path d="M8.5 12.25l2.4 2.4 4.6-5"/>`),
  doc: svg(`<path d="M6.75 3.25h7l4.5 4.5v11.5a1.5 1.5 0 0 1-1.5 1.5H6.75a1.5 1.5 0 0 1-1.5-1.5V4.75a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M13.25 3.25v5h5M8.75 12.5h6.5M8.75 16h6.5"/>`),
  books: svg(`<path d="M12 6.5C10.2 5.2 7.7 4.6 3.75 4.6v13c3.95 0 6.45.6 8.25 1.9 1.8-1.3 4.3-1.9 8.25-1.9v-13c-3.95 0-6.45.6-8.25 1.9zM12 6.5v13"/>`),
  list: svg(`<path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/>`),
  open: svg(`<path d="M9.5 6.25h8.25v8.25M17.5 6.5L6.25 17.75"/>`),
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>`,
  more: `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18" cy="12" r="1.1"/></svg>`,
  play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="solid" d="M8 5.5v13l10.5-6.5z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.75v12.5M15.5 5.75v12.5"/></svg>`,
};

/** A list row. `tag` is button for tappable rows; `lead` is a glyph (or a time); `trail` is a value; `chev` a disclosure. */
function row({ tag = "div", attrs = "", lead = "", title, sub = "", trail = "", chev = false, cls = "", titleCls = "", trailCls = "" }) {
  const type = tag === "button" ? ` type="button"` : "";
  return `<li><${tag} class="row${cls ? " " + cls : ""}"${type} ${attrs}>${lead}<span class="text"><span class="title${titleCls ? " " + titleCls : ""}">${title}</span>${sub ? `<span class="subtitle">${sub}</span>` : ""}</span>${trail !== "" ? `<span class="trail${trailCls ? " " + trailCls : ""}">${trail}</span>` : ""}${chev ? ICON.chev : ""}</${tag}></li>`;
}
const head = (title, sub = "") => `<h1 class="large">${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}`;
const empty = (icon, title, line, action = "") => `<div class="empty">${icon.replace('class="glyph"', "")}<h2 class="section-title">${esc(title)}</h2>${line ? `<p>${esc(line)}</p>` : ""}${action}</div>`;
const SKELETON = `<div class="skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></div>`;
const longDate = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
/** Capture times: "12:20" today, "Yesterday", the weekday up to 6 days back, then "4 Oct". */
function when(ms) {
  const day = localDay(ms), n = daysBetween(day, todayString());
  if (n === 0) return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (n === 1) return "Yesterday";
  const d = new Date(day + "T12:00");
  return n > 1 && n <= 6 ? WEEKDAYS[d.getDay()] : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
const localDay = (ms) => todayString(new Date(ms));
const countdown = (days) => (days < 14 ? `${days} days` : `${Math.floor(days / 7)} wk`);
const dayName = (day, today = todayString()) => (day === today ? "Today" : day === addDays(today, 1) ? "Tomorrow" : shortDay(day) + (day.slice(0, 4) !== today.slice(0, 4) ? " " + day.slice(0, 4) : ""));
const nextMonday = (today) => parseWhen("next week", today).date;
const norm = (t) => String(t ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const notices = () => [syncError && `<p class="foot warn">${esc(syncError)}</p>`, routeNote && `<p class="foot warn">${esc(routeNote)}</p>`, cloud && `<p class="foot">${esc(cloud)}</p>`].filter(Boolean).join("");
/** Due soon's trailing value: "17:30" or "Today", "Tomorrow", the weekday 2 to 6 days out ("Fri"), then "Wed 14 Oct". */
function dueText(r) {
  if (r.slipped) return shortDay(r.date);
  if (r.days === 0 && r.time) return r.time;
  if (r.days >= 2 && r.days <= 6) return WEEKDAYS[new Date(r.date.slice(0, 10) + "T12:00").getDay()];
  return dueLabel(r);
}

// ---------- Today ----------

function renderToday(today) {
  const top = head("Today", longDate()) + notices();
  if (!loaded) return paint($("today"), top + SKELETON);
  const now = Date.now();
  const sched = daySchedule(events, new Date(now), 3, allEvents);
  const p = brief?.date?.slice(0, 10) === today && typeof brief.data?.priority?.title === "string" && brief.data.priority.title ? brief.data.priority : null; // only today's brief, as on the Mac
  // The priority, when it is one of the tasks, gets that task's tick, and the task leaves Due soon.
  const pTask = p && tasks.find((t) => !t.user_data?.dismissed && norm(t.data?.title ?? t.title) === norm(p.title));
  const cardsDue = due(cards, today).length;
  // Held rows (just ticked, or leaving) stay in the list until they fold away.
  const list = tasks.map((t) => { const h = held.get(t.id);
    return !h ? t : { ...t, user_data: h.kind === "moved" ? h.prev : { ...t.user_data, done: false, dismissed: false } }; });
  // ...and so does a deadline of the priority's module on the priority's due day ("Outline to tutor" under "Outline the CRG essay").
  const pModules = !p ? [] : [p.module, ...modules.filter((m) => [m.data?.short, moduleName(m)].some((n) => n && new RegExp(`(^|\\W)${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`, "i").test(p.title))).map(moduleName)].filter(Boolean);
  const pDay = typeof p?.due === "string" ? p.due.slice(0, 10) : null;
  const rows = dueSoon(list, assessments, applications, today).filter((r) => r.id !== pTask?.id && !(p && !pTask && norm(r.title) === norm(p.title))
    && !((r.kind === "assessment" || r.kind === "milestone") && r.date === pDay && pModules.includes(r.module)));
  const slipped = rows.filter((r) => r.slipped), soon = rows.filter((r) => !r.slipped);
  const later = runway(assessments.filter((a) => !gone(a)), today);
  const caps = captureList();
  const hasSchedule = sched.allDay.length || sched.past.length || sched.now.length || sched.next.length;
  const foot = `<p class="foot mt-28" id="today-foot"></p>`;
  // Up next, now to Sunday. Today's classes are already in Schedule, so they aren't repeated here.
  const ahead = upNext({ events, pings, tasks, assessments, notes: [...noteById.values()] }, new Date(now)).filter((r) => !(r.event && r.day === today && hasSchedule));
  const briefAt = new Map([...noteById.values()].filter((n) => n.data?.kind === "pre" && Date.parse(n.data?.classAt)).map((n) => [Date.parse(n.data.classAt), n]));

  if (!hasSchedule && !ahead.length && !p && !cardsDue && !rows.length && !later.length && !caps.length) {
    paint($("today"), top + empty(ICON.sun, "Nothing due", "Deadlines, lectures and to-dos from the Mac show up here.",
      `<button class="btn secondary" type="button" data-act="add">Add a to-do</button>`).replace('class="empty"', 'class="empty fill"') + foot);
    return updateFoot();
  }

  let html = top;
  if (hasSchedule) {
    const time = (t) => `<span class="time">${t}</span>`;
    const event = (e, trail = "") => { const b = briefAt.get(e.start.getTime());
      return row({ tag: b ? "button" : "div", attrs: `data-item="${esc(e.id)}"${b ? ` data-open="note:${esc(b.id)}"` : ""}`, lead: time(e.time), title: esc(e.title),
        sub: esc([b && briefLabel(b), e.location].filter(Boolean).join(" · ")), trail, cls: e.state === "past" ? "past" : "", chev: !!b }); };
    html += `<h2 class="section">Schedule</h2><ul class="group times">
      ${sched.allDay.length ? row({ lead: time("All day"), title: esc(sched.allDay.join(", ")), titleCls: "one" }) : ""}
      ${sched.past.length ? row({ tag: "button", attrs: `data-act="earlier" aria-expanded="${openEarlier}"`, lead: time(""), title: `${sched.past.length} earlier`, cls: "fold", chev: true }) : ""}
      ${openEarlier ? sched.past.map((e) => event(e)).join("") : ""}
      ${sched.now.map((e) => event(e, "Now")).join("")}
      ${sched.next.map((e) => event(e)).join("")}
      ${!sched.now.length && !sched.next.length ? row({ lead: time(""), title: "Nothing else today", cls: "quiet" }) : ""}
      ${sched.more ? row({ tag: "button", attrs: `data-act="all-events"`, title: allEvents ? "Show less" : "Show all", cls: "more" }) : ""}
    </ul>`;
  }
  if (ahead.length) {
    const label = (r) => (r.day === today ? "Today" : r.day === addDays(today, 1) ? "Tomorrow" : WEEKDAYS[new Date(r.day + "T12:00").getDay()]);
    html += `<h2 class="section">Up next</h2><ul class="group times">${(allNext ? ahead : ahead.slice(0, 5)).map((r) => row({
      tag: r.open ? "button" : "div", attrs: `data-next="${esc(r.id)}"${r.open ? ` data-open="${esc(r.open)}"` : ""}`,
      lead: `<span class="time">${r.time ?? (r.kind === "assessment" ? "Due" : "All day")}</span>`, title: esc(r.title), titleCls: "clamp",
      sub: esc(shorten(r.sub)), trail: label(r), chev: !!r.open })).join("")}
      ${ahead.length > 5 ? row({ tag: "button", attrs: `data-act="all-next"`, title: allNext ? "Show less" : "Show all", cls: "more" }) : ""}</ul>`;
  }
  if (p) {
    const why = typeof p.why === "string" ? withoutGreeting(p.why) : "";
    const pd = typeof p.due === "string" && /^\d{4}-\d{2}-\d{2}/.test(p.due) ? { date: p.due, days: daysBetween(today, p.due.slice(0, 10)) } : null;
    const h = pTask && held.get(pTask.id), done = !!pTask && (h?.kind === "done" || pTask.user_data?.done === true);
    const text = `<span class="text"><span class="title strong">${esc(p.title)}</span>${why ? `<span class="why">${esc(why)}</span>` : ""}
      ${pd ? `<span class="subtitle${pd.days < 0 && !done ? " warn" : ""}">${esc(priorityDueLabel(pd))}</span>` : ""}</span>`;
    html += `<h2 class="section">Top priority</h2><div class="group">${pTask
      ? `<div class="task prio${done ? " done" : ""}${h && now - h.at < 450 ? " just" : ""}">${tickButton(pTask.id, p.title, done)}<div class="row block">${text}</div></div>`
      : `<div class="row block">${text}</div>`}</div>`;
  }

  html += `<h2 class="section">Due soon</h2>`;
  const quiet = !slipped.length && !soon.some((r) => r.days === 0);
  const visible = allDue ? soon : soon.slice(0, 6);
  html += `<ul class="group">
    ${quiet ? row({ lead: ICON.check.replace('class="glyph"', 'class="glyph success"'), title: soon.length ? "Nothing due today" : "Nothing due in the next seven days", cls: "quiet" }) : ""}
    ${slipped.length ? row({ tag: "button", attrs: `data-act="slipped" aria-expanded="${openSlipped}" aria-label="Slipped, ${slipped.length}"`, lead: ICON.clock.replace('class="glyph"', 'class="glyph warn"'),
      title: "Slipped", titleCls: "warn", trail: String(slipped.length), cls: "fold", chev: true }) : ""}
    ${openSlipped ? slipped.map((r) => dueRow(r, now)).join("") : ""}
    ${visible.map((r) => dueRow(r, now)).join("")}
    ${soon.length > 6 ? row({ tag: "button", attrs: `data-act="all-due"`, title: allDue ? "Show less" : "Show all", cls: "more" }) : ""}
  </ul>`;
  if (cardsDue) html += `<button class="btn primary mt-20" type="button" data-act="review">Review ${plural(cardsDue, "card")}</button>`;
  if (later.length) {
    html += `<h2 class="section">Coursework</h2><ul class="group flat">${later.map((r) => row({ tag: "button", attrs: `data-cw="${esc(r.id)}" aria-label="${esc(r.title)}, ${esc(r.left)}"`,
      title: esc(r.title), sub: esc(shorten(r.detail)), trail: esc(datesShown.has(r.id) ? shortDay(addDays(today, r.days)) : countdown(r.days)) })).join("")}</ul>`;
  }
  if (caps.length) {
    html += `<h2 class="section">Captures</h2><ul class="group flat">${caps.slice(0, 3).map(captureRow).join("")}
      ${caps.length > 3 ? row({ tag: "button", attrs: `data-tab="capture"`, title: "Show all", cls: "more" }) : ""}</ul>`;
  }
  paint($("today"), html + foot);
  updateFoot();
}

/** The footnote's text is set on its own, so the minute clock never redraws the list around it. */
function updateFoot() {
  const el = $("today-foot");
  if (!el) return;
  const waiting = outbox.length;
  el.textContent = `Updated ${ago(synced, Date.now())}.`
    + (signedOutOfSync && waiting ? ` Sign in again to sync ${plural(waiting, "change")}.` : "")
    + (DEMO ? " Demo data stays on this phone." : "");
}

const tickButton = (id, title, done) =>
  `<button class="tick" type="button" data-tick="${esc(id)}" aria-pressed="${done}" aria-label="${done ? "Undo" : "Complete"}: ${esc(title)}">${TICK}</button>`;

/** A Due soon row. Tasks get a tick and open the action sheet; slipped dates are the only warning colour. Only rows with a
 *  module or a role carry a subtitle. */
function dueRow(r, now) {
  const label = dueText(r), sub = r.kind === "task" ? held.get(r.id)?.note ?? "" : shorten(r.detail);
  const text = `<span class="text"><span class="title clamp">${esc(r.title)}</span>${sub ? `<span class="subtitle">${esc(sub)}</span>` : ""}</span>`
    + (label ? `<span class="trail${r.slipped ? " warn" : ""}">${esc(label)}</span>` : "");
  if (r.kind !== "task") return `<li data-item="${esc(r.id)}"><div class="row">${r.kind === "application" ? ICON.briefcase : ICON.cap}${text}</div></li>`;
  const h = held.get(r.id), done = h?.kind === "done", task = tasks.find((t) => t.id === r.id);
  const cls = ["task", done && "done", done && now - h.at < 450 && "just", task?.fresh && now - task.fresh < 450 && "fresh"].filter(Boolean).join(" ");
  return `<li class="${cls}" data-row="${esc(r.id)}">${tickButton(r.id, r.title, done)}<button class="row" type="button" data-task="${esc(r.id)}">${text}</button></li>`;
}

function captureRow(c) {
  const src = c.thumb || thumbs.get(c.path), waiting = !DEMO && outbox.some((o) => o.row?.id === c.id);
  return row({ title: esc(c.body || "Photo"), titleCls: "clamp", sub: esc([when(c.at), c.photo && !src && "Photo", waiting && "Waiting to sync"].filter(Boolean).join(" · ")),
    trail: src ? `<img class="thumb-img" src="${esc(src)}" alt="">` : "" });
}

function renderCaptures() {
  const caps = captureList();
  paint($("capture-list"), caps.length ? `<h2 class="section">Captures</h2><ul class="group flat">${caps.map(captureRow).join("")}</ul>` : "");
}

/** The task action sheet: Today, Tomorrow, Next week, Pick a date, Let go. */
function openTaskSheet(id) {
  const task = tasks.find((t) => t.id === id), r = dueSoon([task], [], [], todayString())[0];
  if (!task || !r) return;
  sheetTask = id;
  const today = todayString();
  say("task-title", r.title);
  say("task-detail", r.slipped ? "Was due " + shortDay(r.date) : r.date ? priorityDueLabel(r) : "");
  $("task-moves").innerHTML = [
    row({ tag: "button", attrs: `data-move="${today}"`, lead: ICON.sun, title: "Today", trail: shortDay(today) }),
    row({ tag: "button", attrs: `data-move="${addDays(today, 1)}"`, lead: ICON.sunrise, title: "Tomorrow", trail: shortDay(addDays(today, 1)) }),
    row({ tag: "button", attrs: `data-move="${nextMonday(today)}"`, lead: ICON.nextWeek, title: "Next week", trail: shortDay(nextMonday(today)) }),
    `<li><label class="row">${ICON.calendar}<span class="text"><span class="title">Pick a date</span></span>${ICON.chev}
      <input type="date" class="overlay" data-pick min="${today}" value="${r.date && r.date > today ? esc(r.date) : today}" aria-label="Pick a date"></label></li>`,
  ].join("");
  $("task-sheet").showModal();
}

// ---------- Inbox: every ping that has fired (docs/(C) Brief + ping contract.md §6) ----------

function renderInbox() {
  const { rows, unread } = inbox(pings, new Date());
  $("inbox-badge").textContent = unread > 99 ? "99+" : String(unread);
  $("inbox-badge").hidden = !unread;
  $("tabs").querySelector('[data-tab="inbox"]').setAttribute("aria-label", unread ? `Inbox, ${unread} unread` : "Inbox");
  const top = head("Inbox") + notices();
  if (!loaded) return paint($("inbox"), top + SKELETON);
  if (!rows.length) return paint($("inbox"), top + empty(ICON.bell, "No notifications yet", "Briefs, deadlines and reminders collect here as they arrive."));
  paint($("inbox"), top + `<ul class="group inbox mt-20">${rows.map((x) => {
    const done = x.user_data?.done === true, fresh = !x.user_data?.seenAt && !done, at = fireAt(x);
    const sub = [when(at.getTime()) + (localDay(at.getTime()) === todayString() ? "" : ", " + clock(at)), done && "Done"].filter(Boolean).join(" · ");
    return `<li class="ping${done ? " done" : ""}" data-item="${esc(x.id)}">${fresh ? `<i class="dot" aria-hidden="true"></i>` : ""}
      <button class="row" type="button" data-ping="${esc(x.id)}" aria-label="${fresh ? "Unread. " : ""}${esc(x.title ?? "")}, ${esc(sub)}"><span class="text"><span class="title${fresh ? " strong" : ""}">${esc(x.title ?? "Notification")}</span><span class="subtitle">${esc(sub)}</span></span></button>
      <button class="more-btn" type="button" data-pmore="${esc(x.id)}" aria-label="Snooze or done: ${esc(x.title ?? "")}">${ICON.more}</button></li>`;
  }).join("")}</ul>`);
}

/** A ping's sheet: Snooze (1 h, 20:00 tonight, 08:00 tomorrow) and Done. Both mark it seen. */
function openPingSheet(id) {
  const p = pings.find((x) => x.id === id);
  if (!p) return;
  sheetPing = id;
  const done = p.user_data?.done === true;
  say("ping-title", p.title ?? "Notification");
  const at = fireAt(p);
  say("ping-when", at ? `${when(at.getTime())}${localDay(at.getTime()) === todayString() ? "" : ", " + clock(at)}` : "");
  $("ping-moves").innerHTML = snoozeChoices(new Date()).map(([label, d]) =>
    row({ tag: "button", attrs: `data-snooze="${d.toISOString().replace(/\.\d{3}Z$/, "Z")}"`, lead: ICON.clock, title: label, trail: clock(d) })).join("");
  say("ping-done-label", done ? "Mark as not done" : "Done");
  $("ping-sheet").showModal();
}

/** Open, Done and Snooze write user_data (with userAt, as every write does). Open and Done mark the ping seen; Snooze
 *  clears seenAt, so it comes back unread when it fires again (as on the Mac). */
function pingWrite(id, patch) {
  const p = pings.find((x) => x.id === id);
  if (!p) return null;
  writeUser(p, { ...(p.user_data?.seenAt ? {} : { seenAt: Date.now() }), ...patch }, "edit");
  return p;
}
function openPing(id) {
  const p = pingWrite(id, {});
  render();
  if (p && typeof p.data?.open === "string" && !openTarget(p.data.open)) tell("That isn’t on this phone yet. It arrives with the next sync from the Mac.");
}

// ---------- Opening a target: ?open=, a notification tap, Up next and the Inbox (contract §3) ----------

let routeNote = "";
const tell = (text) => { routeNote = text; render(); };
// The link this launch came with. It's taken off the address, so a reload doesn't open it again.
let pending = null, pendingPing = null;
takeLink(location.href);
function takeLink(href) {
  const url = new URL(href, location.href);
  pending = url.searchParams.get("open") ?? pending; pendingPing = url.searchParams.get("ping") ?? pendingPing;
  url.searchParams.delete("open"); url.searchParams.delete("ping");
  if (href === location.href) history.replaceState(null, "", url.pathname + url.search + url.hash);
}
/** Opens the pending link once the data has what it points at; `final` (fresh data, or none coming) gives up with a note. */
function routePending(final) {
  if (pendingPing && (pings.some((x) => x.id === pendingPing) || final)) { pingWrite(pendingPing, {}); pendingPing = null; }
  if (!pending) return;
  if (openTarget(pending)) pending = null;
  else if (final) { pending = null; tell("That isn’t on this phone yet. It arrives with the next sync from the Mac."); }
}

/** Shows a target. False when what it points at isn't here. */
function openTarget(target) {
  const t = String(target ?? ""), at = t.indexOf(":"), kind = t.slice(0, at), id = t.slice(at + 1);
  if (at < 1) return false;
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  reviewing = false;
  routeNote = "";
  if (kind === "url") {
    if (!/^https:\/\//i.test(id)) return true; // only web links leave the app
    const w = window.open(id, "_blank");
    if (w) { w.opener = null; return true; }
    switchTab("inbox"); // a link opened without a tap is blocked: the Inbox's Open is a tap
    return true;
  }
  if (kind === "item") {
    switchTab("today");
    // Its own card: a task's Due soon row, else Schedule or Due soon, Coursework, then Up next.
    const el = ["row", "item", "cw", "next"].map((a) => $("today").querySelector(`[data-${a}="${CSS.escape(id)}"]`)).find(Boolean);
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: still() ? "auto" : "smooth" });
    el.classList.add("spot");
    setTimeout(() => el.classList.remove("spot"), 1600);
    return true;
  }
  if (kind === "lecture") {
    const lec = lectures.find((l) => l.id === id);
    return !!lec && (study([{ s: "module", m: lec.module }, { s: "lecture", id }]), true);
  }
  if (!["note", "reask", "listen"].includes(kind)) return false;
  const n = id === "next" ? nextBrief([...noteById.values()]) : noteById.get(id);
  if (!n) return false;
  foldsFor(n.id).reask = kind === "reask";
  const lec = lectures.find((l) => [l.data?.pre, l.data?.post, l.user_data?.builtPost].includes(n.id));
  if (lec) primer.set(lec.id, lec.data?.pre === n.id);
  study(lec ? [{ s: "module", m: lec.module }, { s: "lecture", id: lec.id }] : [...(n.module ? [{ s: "module", m: n.module }] : []), { s: "note", id: n.id }]);
  const el = kind === "reask" ? $("study").querySelector(".preq") : kind === "listen" ? $("study").querySelector("[data-play]") : null;
  el?.scrollIntoView({ block: "start" });
  if (el) scrollBy(0, -60);
  if (kind === "listen") el?.focus({ preventScroll: true });
  return true;
}
/** Study, at these screens under its home. */
function study(screens) {
  setContents(false);
  tabY[tab] = scrollY;
  tab = "study";
  stack = [{ s: "home" }, ...screens];
  render();
  scrollTo(0, 0);
}

// ---------- Listening to a brief (contract §4) ----------

// One <audio> for the app, outside the page, so redraws never stop it. The recording is downloaded ahead (from the
// private `audio` bucket, as a blob), because iOS only starts playback inside the tap itself.
const audio = new Audio();
const blobs = new Map();   // storage path → blob URL, null while it downloads, false when it couldn't
const player = { id: null, version: "short", playing: false, started: false, speech: false };
let speed = load("speed", 1);
const SPEEDS = [1, 1.25, 1.5, 2];

// Keyed by path and script hash: the Mac re-uploads a changed script to the same path.
const recording = (n, version) => { const p = n.user_data?.audio?.[version]; return typeof p === "string" && p ? p + "#" + (n.user_data.audio.hash ?? "") : null; };
const script = (n, version) => { const s = n.data?.audio?.[version]?.script; return typeof s === "string" ? s.trim() : ""; };
const briefTitle = (n) => (Array.isArray(n.data?.doc?.blocks) ? n.data.doc.blocks : []).find((b) => b?.t === "h1" && b.text)?.text ?? n.title ?? "Brief";

function prefetch(path) {
  if (!path || blobs.has(path) || DEMO || !sb) return;
  blobs.set(path, null);
  sb.storage.from("audio").download(path.split("#")[0])
    .then(({ data, error }) => { if (error || !data) throw error; blobs.set(path, URL.createObjectURL(data)); })
    .catch(() => blobs.set(path, false)) // the phone's own voice reads it instead
    .finally(render);
}

/** The player above a brief that has audio scripts or a recording: Play, Short or Full, and speed. */
function playerHtml(n) {
  const version = player.id === n.id ? player.version : "short", path = recording(n, version);
  if (!path && !script(n, "short") && !script(n, "full")) return "";
  prefetch(path);
  const mine = player.id === n.id, file = path ? blobs.get(path) : false, waiting = file === null;
  const label = mine && player.playing ? "Pause" : waiting ? "Loading…" : mine && player.started ? "Resume" : "Play";
  const both = (recording(n, "short") || script(n, "short")) && (recording(n, "full") || script(n, "full"));
  return `<div class="player" data-player="${esc(n.id)}">
    <button class="btn primary" type="button" data-play="${esc(n.id)}"${waiting ? " disabled" : ""}>${mine && player.playing ? ICON.pause : ICON.play}${label}</button>
    <div class="player-row">${both ? `<div class="seg" role="tablist" aria-label="Which version" style="--n: 2; --i: ${version === "short" ? 0 : 1}"><span class="thumb" aria-hidden="true"></span>${[["short", "Short"], ["full", "Full"]]
      .map(([v, l]) => `<button type="button" role="tab" data-ver="${v}" aria-selected="${version === v}">${l}</button>`).join("")}</div>` : ""}
      <button class="btn secondary small" type="button" data-speed aria-label="Speed ${speed} times">${speed}×</button></div>
    ${file === false ? `<p class="foot">${path ? "Couldn’t load the recording, so" : "No recording yet, so"} the phone’s voice reads it.</p>` : ""}
  </div>`;
}

function stopAudio() {
  audio.pause();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  Object.assign(player, { playing: false, started: false, speech: false });
}

/** Play, pause or resume, all inside the tap: the downloaded recording, else the script in the phone's own voice. */
function togglePlay(id) {
  const n = noteById.get(id);
  if (!n) return;
  if (player.id === id && player.started) {
    if (player.playing) player.speech ? speechSynthesis.pause() : audio.pause();
    else player.speech ? speechSynthesis.resume() : audio.play().catch(() => {});
    player.playing = !player.playing;
    return render();
  }
  const version = player.id === id ? player.version : "short", url = blobs.get(recording(n, version));
  stopAudio();
  Object.assign(player, { id, version, playing: true, started: true, speech: !url });
  if (url) {
    audio.src = url; audio.playbackRate = speed;
    audio.play().catch(() => { player.playing = player.started = false; render(); });
    lockScreen(n);
  } else if ("speechSynthesis" in window && script(n, version)) {
    const u = Object.assign(new SpeechSynthesisUtterance(script(n, version)), { lang: "en-GB", rate: speed });
    u.onend = () => { if (player.id === id) { player.playing = player.started = false; render(); } };
    speechSynthesis.speak(u);
  } else player.playing = player.started = false;
  render();
}

/** Lock-screen and headphone controls: title, module, play and pause, and 15 s back and forward. */
function lockScreen(n) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  ms.metadata = new MediaMetadata({ title: briefTitle(n), artist: n.module ?? "Sidebrain", artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }] });
  const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* not supported here */ } };
  const seek = (by) => { audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + by)); };
  on("play", () => audio.play()); on("pause", () => audio.pause());
  on("seekbackward", (e) => seek(-(e.seekOffset || 15))); on("seekforward", (e) => seek(e.seekOffset || 15));
  on("seekto", (e) => { audio.currentTime = e.seekTime; });
}
const position = () => { try { if (Number.isFinite(audio.duration)) navigator.mediaSession?.setPositionState?.({ duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime }); } catch { /* ignore */ } };
audio.onplay = () => { player.playing = true; position(); if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing"; render(); };
audio.onpause = () => { player.playing = false; position(); if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused"; render(); };
audio.onended = () => { player.playing = player.started = false; render(); };
audio.onratechange = audio.onseeked = audio.onloadedmetadata = position;

// ---------- Add (To-do | Note) ----------

let captureFor = null; // {module, lecture}: the Add sheet's note goes to this class (a lecture's "Note for this class")

function openAdd(mode = "todo") {
  for (const el of $("add-sheet").querySelectorAll("[role=status]")) say(el, "");
  setMode(mode);
  $("add-sheet").showModal();
  setTimeout(() => (mode === "todo" ? $("todo") : $("add-sheet").querySelector("textarea")).focus(), 60);
}

function setMode(mode) {
  addMode = mode;
  const seg = $("add-sheet").querySelector(".seg");
  seg.style.setProperty("--i", mode === "todo" ? 0 : 1);
  for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.mode === mode));
  $("todo-form").hidden = mode !== "todo";
  $("add-sheet").querySelector("[data-compose=add]").hidden = mode !== "note";
}

/** Parse as you type: the date phrase is highlighted in place and the Date row shows the day. */
function updateTodo() {
  const input = $("todo"), value = input.value, today = todayString();
  const p = todoParse = parseWhen(value, today, todoIgnore);
  if (p.date && todoManual) todoManual = null; // a date typed after picking one wins: the most recent choice counts
  $("todo-mirror").innerHTML = p.start < 0 ? esc(value)
    : `${esc(value.slice(0, p.start))}<mark>${esc(value.slice(p.start, p.end))}</mark>${esc(value.slice(p.end))}`;
  $("todo-mirror").scrollLeft = input.scrollLeft;
  const date = todoManual ?? p.date, past = !!date && date < today;
  say("todo-date-label", !date ? "None" : past ? `Past date · ${shortDay(date)}` : dayName(date, today), past);
  $("todo-date").value = date ?? ""; // no min here: a typed past date is allowed, and the form never validates it (novalidate)
  $("todo-save").disabled = !value.trim();
}

function resetTodo() {
  $("todo").value = ""; todoIgnore = new Set(); todoManual = null;
  updateTodo();
}

function saveTodo(e) {
  e.preventDefault();
  const p = todoParse ?? parseWhen($("todo").value, todayString(), todoIgnore);
  if (!p.title.trim()) return;
  const date = todoManual ?? p.date;
  addTask(p.title, date);
  resetTodo();
  // The sheet stays open for the next one, and says where this one went: a date past Due soon's week is off Today.
  say("todo-status", date ? `Added for ${dayName(date).replace(/^(Today|Tomorrow)$/, (w) => w.toLowerCase())}` : "Added");
  clearTimeout(saveTodo.timer);
  saveTodo.timer = setTimeout(() => say("todo-status", ""), 4000);
  $("todo").focus();
}

/** The note composer (Capture tab and the Add sheet's Note): text, an optional photo, Save. */
const composer = () => `<ul class="group flat">
    <li><textarea name="body" rows="5" placeholder="Note" aria-label="Note"></textarea></li>
    <li class="preview-li" hidden><div class="preview"><img alt="Photo to attach"></div></li>
    <li><label class="row photo"><input type="file" name="photo" accept="image/*" capture="environment" aria-label="Add photo">${ICON.camera}
      <span class="text"><span class="title link">Add photo</span></span></label></li>
    <li class="remove-li" hidden><button class="row" type="button" data-remove-photo>${ICON.xmark}<span class="text"><span class="title link">Remove photo</span></span></button></li>
  </ul>
  <button class="btn primary" type="submit" disabled>Save</button>
  <p class="foot" role="status"></p>`;
/** Save needs a note or a photo. */
const canSave = (form) => { form.querySelector("[type=submit]").disabled = !form.elements.body.value.trim() && !photos[form.dataset.compose]; };

// ---------- Review: full screen ----------

let reviewReturn = null; // where focus goes back to when the review closes
function openReview(module = null, lecture = null) {
  if (session.module !== module || session.lecture !== lecture || !current()) newSession(module, lecture);
  tabY.review = scrollY;
  reviewReturn = document.activeElement;
  reviewing = true;
  render();
}
function closeReview() {
  reviewing = false;
  render();
  scrollTo(0, tabY.review ?? 0);
  const back = reviewReturn?.isConnected ? reviewReturn : $(tab).querySelector('[data-act="review"]') ?? $("tabs").querySelector("[aria-current]");
  back?.focus({ preventScroll: true });
}

function renderReview(today) {
  if (!reviewing) return;
  const close = `<button class="circle" type="button" data-act="close-review" aria-label="Close">${ICON.close}</button>`;
  const card = current(), total = session.queue.length;
  if (!loaded || !card) {
    const done = new Set(session.queue.slice(0, session.index)).size, next = nextDue(cards, today);
    const nextText = next ? `Next cards due ${daysBetween(today, next) === 1 ? "tomorrow" : shortDay(next)}.` : "";
    paint($("review"), `<div class="review-top"></div>
      ${empty(ICON.check, done ? `${plural(done, "card")} reviewed` : "Nothing due", nextText || "Every card is scheduled for later.")}
      <div class="review-bar chrome"><button class="btn primary" type="button" data-act="close-review">Done</button></div>`);
    return focusReview();
  }
  const where = [short(card.module), card.data?.lecture].filter(Boolean).join(" · ");
  const exam = examFor(card);
  paint($("review"), `<div class="review-top">${close}<p class="count">${session.index + 1} of ${total}</p></div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${session.index}"><i style="width:${(session.index / Math.max(total, 1)) * 100}%"></i></div>
    <article class="flash" data-act="flip">
      <div class="qa">${where ? `<p class="foot">${esc(where)}</p>` : ""}<h2 class="front">${esc(card.data?.front ?? card.title ?? "")}</h2>
      ${session.flipped ? `<hr><p class="answer">${esc(card.data?.back ?? "")}</p>` : ""}</div>
    </article>
    <div class="review-bar chrome">${session.flipped
      ? NAMES.map((n, g) => `<button class="grade${g === 2 ? " good" : ""}" type="button" data-grade="${g}"><b>${n}</b><small>${intervalLabel(schedule(card.user_data ?? {}, g, exam, today).interval)}</small></button>`).join("")
      : `<button class="btn primary" type="button" data-act="flip">Show answer</button>`}</div>`);
  focusReview();
}
/** Focus stays inside the review: on its main button, after every redraw. */
function focusReview() {
  if (!$("review").contains(document.activeElement)) ($("review").querySelector(".review-bar .good") ?? $("review").querySelector(".review-bar button"))?.focus({ preventScroll: true });
}

// ---------- Study (Sources/(C) View Study.swift: modules → lectures → reader, review, attempt-first practice) ----------

const moduleName = (m) => m.module ?? m.title ?? m.id;
const short = (name) => modules.find((m) => moduleName(m) === name)?.data?.short ?? name ?? "";
/** "Corporate Restructuring & Governance · 50%" → "CRG · 50%", for one-line subtitles. */
const shorten = (text) => modules.reduce((t, m) => (m.data?.short ? t.split(moduleName(m)).join(m.data.short) : t), text);
const KINDS = { essay: "Essay", short: "Short answer", mcq: "Multiple choice" };

/** "today", "tomorrow" or "Mon 5 Oct". */
function dayLabel(d) {
  const day = String(d).slice(0, 10), n = daysBetween(todayString(), day);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : shortDay(day);
}
const caughtUp = (next) => (next ? `All caught up. Next cards due ${dayLabel(next)}.` : "All caught up.");

function screenTitle(sc) {
  if (sc.s === "module") return short(sc.m);
  if (sc.s === "lecture") { const l = lectures.find((x) => x.id === sc.id); return [short(l?.module), l?.data?.n].filter(Boolean).join(" ") || "Lecture"; }
  if (sc.s === "practice") return "Practice";
  if (sc.s === "note") return "Notes";
  return "Study";
}

/** Push and pop slide 24 px over 280 ms (startViewTransition); without it, they just swap. */
function navigate(dir, change) {
  const root = document.documentElement;
  if (!document.startViewTransition || still()) return change();
  root.dataset.nav = dir;
  document.startViewTransition(change).finished.finally(() => delete root.dataset.nav);
}
function go(screen) {
  top().y = scrollY;
  navigate("push", () => { stack.push(screen); render(); scrollTo(0, 0); });
}
function back() {
  if (stack.length < 2) return;
  setContents(false);
  navigate("pop", () => { stack.pop(); render(); scrollTo(0, top().y ?? 0); });
}

function renderStudy(today) {
  const sc = top();
  screenSections = []; // the lecture and note screens fill it
  const html = !loaded ? head("Study") + SKELETON : sc.s === "module" ? moduleScreen(sc.m, today) : sc.s === "lecture" ? lectureScreen(sc.id, today)
    : sc.s === "note" ? noteScreen(sc.id) : sc.s === "practice" ? practiceScreen(sc) : homeScreen(today);
  if ($("study")._html === html) return; // nothing new: leave the page alone, so typing, focus and open menus survive
  const a = document.activeElement, docOf = (el) => `[data-doc="${CSS.escape(el.closest("[data-doc]")?.dataset.doc ?? "")}"] `;
  const refocus = a?.dataset?.draft != null ? `[data-draft="${CSS.escape(a.dataset.draft)}"]`
    : a?.dataset?.guess != null ? docOf(a) + `[data-guess="${CSS.escape(a.dataset.guess)}"]`
    : a?.dataset?.step != null ? docOf(a) + `[data-step^="${CSS.escape(a.dataset.step.split(":")[0])}:"].${a.classList.contains("next") ? "next" : "back"}`
    : a?.dataset?.node != null ? `[data-dg="${a.dataset.dg}"][data-node="${CSS.escape(a.dataset.node)}"]` : null;
  const caret = a?.dataset?.draft != null || a?.dataset?.guess != null ? [a.selectionStart, a.selectionEnd] : null;
  paint($("study"), html);
  for (const box of $("study").querySelectorAll("textarea[data-draft]")) {
    const id = box.dataset.draft;
    box.value = drafts.get(id) ?? practice.find((q) => q.id === id)?.user_data?.attempt ?? "";
    syncCheck(box);
  }
  for (const box of $("study").querySelectorAll("input[data-guess]")) { // a guess being typed survives the redraw
    box.value = drafts.get(guessKey(box)) ?? noteById.get(box.closest("[data-doc]")?.dataset.doc)?.user_data?.guesses?.[box.dataset.guess] ?? "";
  }
  const again = refocus && $("study").querySelector(refocus);
  again?.focus({ preventScroll: true });
  if (again && caret) again.setSelectionRange(...caret);
}

function homeScreen(today) {
  const n = due(cards, today).length, open = practice.filter((q) => !q.user_data?.attempt).length;
  let html = head("Study", !n && cards.length ? caughtUp(nextDue(cards, today)) : "") + notices();
  if (n) html += `<button class="btn primary mt-20" type="button" data-act="review">Review ${plural(n, "card")}</button>`;
  if (practice.length) {
    html += `<ul class="group mt-20">${row({ tag: "button", attrs: `data-practice=""`, lead: ICON.practice, title: open ? plural(open, "practice question") : "All practice attempted", chev: true })}</ul>`;
  }
  if (!modules.length) return html + empty(ICON.books, "No modules yet", "Modules, lecture notes and flashcards arrive after the next lecture sync on the Mac.");
  return html + `<h2 class="section">Modules</h2><ul class="group flat">${modules.map((m) => {
    const name = moduleName(m), lecs = lectures.filter((l) => l.module === name).length, d = dueFor(name).length;
    return row({ tag: "button", attrs: `data-module="${esc(name)}"`, title: esc(name), sub: esc([plural(lecs, "lecture"), d && `${d} due`, prepLine(name)].filter(Boolean).join(" · ")), chev: true });
  }).join("")}</ul>`;
}

/** "Prep 2 of 6": the tick list of the module's next brief, "" when it has none. */
function prepLine(name) {
  const b = nextBrief([...noteById.values()].filter((x) => x.module === name));
  const items = (Array.isArray(b?.data?.doc?.blocks) ? b.data.doc.blocks : []).filter((x) => x?.t === "checklist").flatMap((x) => (Array.isArray(x.items) ? x.items : []));
  return items.length ? `Prep ${items.filter((x) => b.user_data?.checks?.[x.id] === true).length} of ${items.length}` : "";
}

function moduleScreen(name, today) {
  const mod = modules.find((x) => moduleName(x) === name), d = mod?.data ?? {};
  const lecs = ordered(lectures.filter((l) => l.module === name));
  const deck = cards.filter((c) => c.module === name), dueHere = dueFor(name), qs = practice.filter((q) => q.module === name);
  // Notes no lecture points at and no lecture covers: built on the Mac from a recording that has no lecture row.
  const linked = new Set(lectures.flatMap((l) => [l.data?.pre, l.data?.post, l.user_data?.builtPost]));
  const covered = new Set(lecs.map((l) => String(l.data?.n ?? "").toUpperCase()));
  const more = [...noteById.values()].filter((x) => x.module === name && x.data?.kind !== "readings" && !linked.has(x.id) && !covered.has(String(x.data?.lecture ?? "").toUpperCase()));
  const coming = lecs.filter((l) => (lectureDay(l) ?? "").slice(0, 10) >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  const by = [d.convenor, d.code].filter(Boolean).join(" · ");
  const info = [...assessmentRows(d.assessment).map((a) => row({ lead: ICON.cap, title: esc(a.title), sub: esc(a.sub) })),
    coming && row({ lead: ICON.calendar, title: esc([coming.data?.n, coming.data?.topic].filter(Boolean).join(" · ")), sub: esc("Next lecture, " + dayLabel(coming.date)) }),
    by && row({ lead: ICON.person, title: esc(by) })].filter(Boolean);
  let html = head(short(name), name !== short(name) ? name : "");
  if (dueHere.length) html += `<button class="btn primary mt-20" type="button" data-act="review" data-m="${esc(name)}">Review ${plural(dueHere.length, "card")}</button>`;
  else if (deck.length) html += `<p class="foot mt-12">${esc(caughtUp(nextDue(deck, today)))}</p>`;
  if (info.length) html += `<ul class="group info mt-20">${info.join("")}</ul>`;
  html += `<h2 class="section">Lectures</h2>` + (lecs.length ? `<ul class="group flat">${lecs.map((l) => {
    const postId = l.data?.post || l.user_data?.builtPost, fromSlides = noteById.get(postId)?.data?.from === "slides", day = lectureDay(l);
    const sub = [l.data?.n, day && dayName(day.slice(0, 10)), l.data?.pre && "Primer", postId && (fromSlides ? "Notes from slides" : "Notes")].filter(Boolean).join(" · ");
    return row({ tag: "button", attrs: `data-lecture="${esc(l.id)}"`, title: esc(l.data?.topic ?? l.title ?? "Lecture"), sub: esc(sub), chev: true });
  }).join("")}</ul>` : `<p class="note-line">Lectures appear here as Moodle posts their slides and recordings.</p>`);
  if (more.length) html += `<h2 class="section">More notes</h2><ul class="group flat">${more.map((x) => row({ tag: "button", attrs: `data-note="${esc(x.id)}"`,
    title: esc(x.title ?? x.data?.topic ?? "Lecture notes"), sub: x.date ? esc(dayName(x.date.slice(0, 10))) : "", chev: true })).join("")}</ul>`;
  if (qs.length) html += `<h2 class="section">Practice</h2><ul class="group flat">${qs.map((q) => row({ tag: "button", attrs: `data-practice="${esc(name)}"`,
    title: esc(q.data?.prompt ?? q.title ?? ""), titleCls: "clamp", sub: esc([q.data?.lecture, KINDS[q.data?.kind], q.user_data?.attempt && "Tried"].filter(Boolean).join(" · ")), chev: true })).join("")}</ul>`;
  return html;
}

/** A module's one-line assessment as rows. "Exam, 2 hours, 100%, 2 essays from 6, January" → "Exam · January" over
 *  "2 hours · 100% · answer 2 of 6"; anything else ("Group video 30% due 10 Dec · case study …") one row per part, as written. */
function assessmentRows(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const parts = text.split(/\s*,\s*/).filter(Boolean), cap = (t) => t.slice(0, 1).toUpperCase() + t.slice(1);
  if (parts.length < 3) return text.split(/\s+·\s+/).map((p) => ({ title: cap(p), sub: "" }));
  const month = parts.slice(1).find((p) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i.test(p));
  return [{ title: [parts[0], month].filter(Boolean).join(" · "),
            sub: parts.slice(1).filter((p) => p !== month).map((p) => p.replace(/^(\d+) (?:essays?|questions?) from (\d+)$/i, "answer $1 of $2")).join(" · ") }];
}

/** The note's structured doc when it has one, else its Markdown body; "" when it has neither. */
function noteHtml(note, sections) {
  const body = typeof note.data?.body === "string" ? note.data.body : "";
  const state = { ...foldsFor(note.id), user: note.user_data ?? {} };
  const html = lectureDoc(note.data?.doc, state, sections) ?? (body.trim() ? markdown(body, sections) : "");
  return html ? playerHtml(note) + `<div class="prose" data-doc="${esc(note.id)}">${html}</div>` : "";
}
/** The reader's state for a note: revealed answers, tapped-open boxes, each steps block's frame, and re-ask mode. */
const foldsFor = (id) => { if (!folds.has(id)) folds.set(id, { open: new Set(), shown: new Set(), frames: new Map(), reask: false }); return folds.get(id); };

/** The Google Doc, when there is one. The note's sections go to the bar's Contents button (`contentsFor`). */
let screenSections = [];
function toolbar(sections, url, more = "") {
  screenSections = sections;
  const docs = typeof url === "string" && url.startsWith("https://");
  return docs || more ? `<div class="toolbar">${docs ? `<a class="btn secondary small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open in Google Docs</a>` : ""}${more}</div>` : "";
}
function setContents(open) {
  const menu = $("contents-menu");
  if (open) menu.innerHTML = screenSections.map((x) => `<li><button type="button" data-jump="${x.id}">${esc(x.title)}</button></li>`).join("");
  menu.hidden = !open;
  $("contents").setAttribute("aria-expanded", String(open));
}

function lectureScreen(id, today) {
  const lec = lectures.find((x) => x.id === id);
  if (!lec) return head("Lecture") + empty(ICON.doc, "Lecture not found", "The last lecture sync may have removed it.");
  const { pre, post } = lectureNotes(lec, noteById), n = lec.data?.n ?? "";
  const usePrimer = primer.get(id) ?? !post, note = usePrimer ? (pre ?? post) : (post ?? pre);
  const url = (usePrimer ? lec.data?.primerUrl : lec.data?.docUrl) ?? note?.data?.docUrl;
  const readings = [...noteById.values()].find((x) => x.module === lec.module && x.data?.kind === "readings" && x.data?.lecture === n);
  const deck = cards.filter((c) => c.module === lec.module && c.data?.lecture === n), dueHere = dueFor(lec.module, n);
  const qs = practice.filter((q) => q.module === lec.module && q.data?.lecture === n);
  const sections = [], body = note ? noteHtml(note, sections) : "";
  const day = lectureDay(lec), over = !day || day.slice(0, 10) < today; // ponytail: the day, not the timetable's end time as on the Mac
  return `${head(lec.data?.topic ?? lec.title ?? "Lecture", [short(lec.module), n, day && shortDay(day.slice(0, 10))].filter(Boolean).join(" · "))}
    ${pre && post ? `<div class="seg" role="tablist" aria-label="Which note" style="--n: 2; --i: ${usePrimer ? 0 : 1}"><span class="thumb" aria-hidden="true"></span>${[["Primer", true], ["Notes", false]]
      .map(([label, v]) => `<button type="button" role="tab" data-primer="${v}" aria-selected="${usePrimer === v}">${label}</button>`).join("")}</div>` : ""}
    ${toolbar(sections, url, `<button class="btn secondary small" type="button" data-act="note-class" data-m="${esc(lec.module)}" data-l="${esc(n)}">Note for this class</button>`)}
    ${note?.data?.kind === "post" && note.data.from === "slides" ? `<p class="note-line">Built from the slides. Sidebrain rebuilds these notes when the recording’s transcript arrives.</p>` : ""}
    ${body || (over ? empty(ICON.doc, "No notes yet", "Build the notes from the recording in Sidebrain on the Mac.")
                    : empty(ICON.doc, "Notes come after the lecture", "They arrive here once it has finished."))}
    ${readings?.data?.body ? `<h2 class="section">Readings</h2><div class="prose boxed">${markdown(readings.data.body)}</div>` : ""}
    ${deck.length ? `<h2 class="section">Flashcards</h2>
      ${dueHere.length ? `<button class="btn primary" type="button" data-act="review" data-m="${esc(lec.module)}" data-l="${esc(n)}">Review ${plural(dueHere.length, "card")}</button>` : ""}
      <ul class="group flat${dueHere.length ? " mt-12" : ""}">${deck.map((c) => row({ title: esc(c.data?.front ?? c.title ?? "") })).join("")}</ul>` : ""}
    ${qs.length ? `<h2 class="section">Practice</h2>${qs.map((q) => practiceCard(q)).join("")}` : ""}`;
}

function noteScreen(id) {
  const note = noteById.get(id);
  if (!note) return head("Notes") + empty(ICON.doc, "Notes not found", "The last sync may have removed them.");
  const sections = [], body = noteHtml(note, sections);
  const title = (Array.isArray(note.data?.doc?.blocks) ? note.data.doc.blocks : []).find((b) => b?.t === "h1" && b.text)?.text;
  return head(title ?? note.title ?? "Lecture notes") + toolbar(sections, note.data?.docUrl) + (body || empty(ICON.doc, "Nothing in these notes", "They may still be building on the Mac."));
}

function practiceScreen(sc) {
  const all = practice.filter((q) => !sc.m || q.module === sc.m);
  // Not yet tried first, fixed when the screen opens, so a card doesn't jump away the moment it's answered.
  sc.order ??= [...all.filter((q) => !q.user_data?.attempt), ...all.filter((q) => q.user_data?.attempt)].map((q) => q.id);
  const qs = [...all].sort((a, b) => sc.order.indexOf(a.id) - sc.order.indexOf(b.id));
  return head("Practice", sc.m ?? "") + `<div class="mt-20">${qs.length ? qs.map((q) => practiceCard(q, !sc.m)).join("")
    : empty(ICON.practice, "No practice yet", "Practice questions come with each lecture’s notes.")}</div>`;
}

/** Attempt first: the model answer stays locked until something is written, or "Skip to answer" is tapped. */
function practiceCard(q, withModule = false) {
  const id = q.id, open = shown.has(id) || !!q.user_data?.attempt, model = typeof q.data?.model === "string" ? q.data.model : "";
  const meta = [withModule && short(q.module), q.data?.lecture, KINDS[q.data?.kind] ?? "Question", q.user_data?.attempt && "Tried"].filter(Boolean).join(" · ");
  return `<article class="practice-card">
    <p class="foot">${esc(meta)}</p>
    <p class="headline">${esc(q.data?.prompt ?? q.title ?? "")}</p>
    <textarea data-draft="${esc(id)}" rows="4" placeholder="Answer" aria-label="Answer"></textarea>
    <div class="actions">
      <button class="btn secondary" type="button" data-check="${esc(id)}" disabled>${open ? "Save attempt" : "Show model answer"}</button>
      ${open ? "" : `<button class="btn plain" type="button" data-skip="${esc(id)}">Skip</button>`}
    </div>
    ${open ? `<div class="model"><div class="prose tight">${markdown(model)}</div>${q.data?.origin ? `<p class="foot">${esc(q.data.origin)}</p>` : ""}</div>` : ""}
  </article>`;
}

const guessKey = (el) => `${el.closest("[data-doc]")?.dataset.doc}:${el.dataset.guess}`;

/** The answer button: needs something written, and once the model answer shows, something new to save. */
function syncCheck(box) {
  const id = box.dataset.draft, text = box.value.trim(), saved = practice.find((q) => q.id === id)?.user_data?.attempt ?? "";
  const button = box.closest(".practice-card")?.querySelector("[data-check]"), open = shown.has(id) || !!saved;
  if (!button) return;
  button.disabled = !text || (open && text === saved);
  button.hidden = open && text === saved; // once the model answer shows, the button only appears for something new to save
}

// ---------- Account sheet ----------

function renderSheet() {
  const waiting = outbox.length, note = reminderError || REMINDER_NOTE[reminders] || "";
  paint($("sheet-body"), `<ul class="group">${row({ lead: `<span class="avatar-lg">${esc((user?.email || "?")[0].toUpperCase())}</span>`,
      title: esc(DEMO ? "Demo" : user?.email ?? ""), sub: DEMO ? "Sample data, kept on this phone" : "Signed in with Google" })}</ul>
    <ul class="group">
      <li><label class="row">${ICON.bell}<span class="text"><span class="title">Morning reminder</span>${note ? `<span class="subtitle${reminderError ? " warn" : ""}">${esc(note)}</span>` : ""}</span>
        <input type="checkbox" switch id="remind" ${reminders === "on" ? "checked" : ""} ${["on", "off"].includes(reminders) ? "" : "disabled"} aria-label="Morning reminder"></label></li>
      ${DEMO ? "" : row({ lead: ICON.sync, title: "Sync", sub: signedOutOfSync && waiting ? `Sign in again to sync ${plural(waiting, "change")}` : "",
        trail: waiting ? `${waiting} waiting` : "Up to date" }).replace('class="subtitle"', 'class="subtitle warn"')}
    </ul>
    <ul class="group flat">${row({ tag: "button", attrs: `data-act="signout"`, title: DEMO ? "Reset demo" : "Sign out", cls: "destructive" })}</ul>`);
}

// ---------- Events ----------

function bind() {
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act],[data-grade],[data-tab],[data-tick],[data-task],[data-move],[data-letgo],[data-cw],[data-module],[data-lecture],[data-note],[data-practice],[data-primer],[data-check],[data-skip],[data-jump],[data-dg],[data-dg-all],[data-close],[data-mode],[data-remove-photo],"
      + "[data-open],[data-ping],[data-pmore],[data-snooze],[data-pdone],[data-cl],[data-step],[data-qz],[data-play],[data-ver],[data-speed]");
    if (!t) return;
    const d = t.dataset;
    if (d.close != null) return t.closest("dialog").close();
    if (d.open) return openTarget(d.open) || tell("That isn’t on this phone yet. It arrives with the next sync from the Mac.");
    if (d.ping) return openPing(d.ping);
    if (d.pmore) return openPingSheet(d.pmore);
    if (d.snooze) { pingWrite(sheetPing, { snoozedUntil: d.snooze, seenAt: null }); $("ping-sheet").close(); return render(); }
    if (d.pdone != null) { const done = pings.find((x) => x.id === sheetPing)?.user_data?.done === true;
      pingWrite(sheetPing, done ? { done: false, doneAt: null } : { done: true, doneAt: Date.now() }); $("ping-sheet").close(); return render(); }
    if (d.play) return togglePlay(d.play);
    if (d.ver) { if (player.version !== d.ver || player.id !== t.closest("[data-player]").dataset.player) { stopAudio(); player.id = t.closest("[data-player]").dataset.player; player.version = d.ver; } return render(); }
    if (d.speed != null) { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; keep("speed", speed); audio.playbackRate = speed; return render(); }
    const doc = noteById.get(t.closest("[data-doc]")?.dataset.doc);
    if (doc && d.cl) { const checks = { ...(doc.user_data?.checks ?? {}) }; checks[d.cl] = checks[d.cl] !== true; writeUser(doc, { checks }, "edit"); return render(); }
    if (doc && d.qz) { const [k, j] = d.qz.split(":").map(Number); writeUser(doc, { quiz: { ...(doc.user_data?.quiz ?? {}), [k]: j } }, "edit"); return render(); }
    if (doc && d.step) { // one frame on, or back; a gentle cross-fade, none under Reduce Motion
      const [block, k] = d.step.split(":");
      foldsFor(doc.id).frames.set(block, Number(k));
      return document.startViewTransition && !still() ? document.startViewTransition(render) : render();
    }
    if (d.grade) return grade(Number(d.grade));
    if (d.tick) return tick(d.tick);
    if (d.task) return openTaskSheet(d.task);
    if (d.move) return move(sheetTask, d.move);
    if (d.letgo != null) return letGo(sheetTask);
    if (d.mode) { setMode(d.mode); return (d.mode === "todo" ? $("todo") : $("add-sheet").querySelector("textarea")).focus(); }
    if (d.removePhoto != null) return setPhoto(t.closest("form"), null);
    if (d.cw) { datesShown.has(d.cw) ? datesShown.delete(d.cw) : datesShown.add(d.cw); return render(); }
    if (d.tab) return switchTab(d.tab);
    switch (d.act) {
      case "slipped": openSlipped = !openSlipped; return render();
      case "all-due": allDue = !allDue; return render();
      case "all-events": allEvents = !allEvents; return render();
      case "all-next": allNext = !allNext; return render();
      case "earlier": openEarlier = !openEarlier; return render();
      case "add": return openAdd("todo");
      case "note-class": captureFor = { module: d.m, lecture: d.l || null }; openAdd("note");
        return say($("add-sheet").querySelector("[data-compose=add] [role=status]"), `For ${[short(d.m), d.l].filter(Boolean).join(" ")}`);
      case "flip": return flip();
      case "review": return openReview(d.m || null, d.l || null);
      case "close-review": return closeReview();
      case "signout": return signOut();
    }
    if (d.module) return go({ s: "module", m: d.module });
    if (d.lecture) return go({ s: "lecture", id: d.lecture });
    if (d.note) return go({ s: "note", id: d.note });
    if (d.practice != null) return go({ s: "practice", m: d.practice || null });
    if (d.primer) { primer.set(top().id, d.primer === "true"); render(); return scrollTo(0, 0); }
    if (d.check) return attempt(d.check);
    if (d.skip) { shown.add(d.skip); return render(); }
    if (d.jump) {
      setContents(false);
      const target = document.getElementById(d.jump);
      return target && scrollTo({ top: target.getBoundingClientRect().top + scrollY - 60, behavior: still() ? "auto" : "smooth" });
    }
    if (d.dg != null || d.dgAll != null) { // a blank diagram's box, or its Show all / Hide all
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
    if (e.target.matches?.("form.compose textarea")) return canSave(e.target.closest("form"));
    if (e.target.dataset?.guess != null) return drafts.set(guessKey(e.target), e.target.value);
    if (e.target.dataset?.draft == null) return;
    drafts.set(e.target.dataset.draft, e.target.value);
    syncCheck(e.target);
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.matches("[data-pick]")) return el.value && move(sheetTask, el.value);
    if (el.dataset.guess != null) { // a guess is saved when the field is left (or the app goes to the background)
      const doc = noteById.get(el.closest("[data-doc]")?.dataset.doc);
      if (doc && (doc.user_data?.guesses?.[el.dataset.guess] ?? "") !== el.value.trim()) writeUser(doc, { guesses: { ...(doc.user_data?.guesses ?? {}), [el.dataset.guess]: el.value.trim() } }, "edit");
      drafts.delete(guessKey(el));
      return;
    }
    if (el.id === "remind") return toggleReminders();
    if (el.name === "photo") return el.files?.[0] && setPhoto(el.closest("form"), el.files[0]);
  });
  document.addEventListener("submit", (e) => {
    if (!e.target.matches("form.compose")) return;
    e.preventDefault();
    saveCompose(e.target);
  });
  // A date input opens its picker from anywhere on its row (Safari does this; Chrome needs showPicker).
  document.addEventListener("click", (e) => { if (e.target.matches?.("input[type=date].overlay")) try { e.target.showPicker(); } catch { /* not allowed here */ } });
  document.addEventListener("keydown", (e) => {
    if (!reviewing || document.querySelector("dialog[open]") || e.target.matches("textarea, input")) return;
    if (e.key === "Escape") return closeReview();
    if (e.key === " " && !session.flipped && current()) { e.preventDefault(); flip(); }
    if (/^[1-4]$/.test(e.key)) grade(Number(e.key) - 1);
  });
  $("account").onclick = () => { reminderError = ""; renderSheet(); $("sheet").showModal(); };
  $("back").onclick = back;
  $("contents").onclick = () => setContents($("contents-menu").hidden);
  // Contents closes on any tap outside it.
  document.addEventListener("pointerdown", (e) => { if (!$("contents-menu").hidden && !e.target.closest("#contents-menu, #contents")) setContents(false); });
  $("add").onclick = () => openAdd(addMode);
  for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); }); // tap outside closes
  $("todo").addEventListener("input", updateTodo);
  $("todo").addEventListener("scroll", () => { $("todo-mirror").scrollLeft = $("todo").scrollLeft; });
  // Tapping the highlighted date undoes the parse: the phrase stays in the title and no date is set.
  $("todo").addEventListener("click", () => {
    const p = todoParse, at = $("todo").selectionStart;
    if (p && p.start >= 0 && at >= p.start && at <= p.end) { todoIgnore = new Set([...todoIgnore, ...p.keys]); updateTodo(); }
  });
  $("todo-date").addEventListener("change", (e) => {
    todoManual = e.target.value || null;
    if (todoParse) todoIgnore = new Set([...todoIgnore, ...todoParse.keys]); // a picked date replaces the typed one
    updateTodo();
  });
  $("todo-form").onsubmit = saveTodo;
  $("add-sheet").addEventListener("close", () => { captureFor = null; if (!$("todo").value.trim()) resetTodo(); });
  $("redirect-signin").onclick = redirectSignIn;
  addEventListener("online", () => { cloud = ""; sb ? refresh() : connect(); });
  if (navigator.serviceWorker) navigator.serviceWorker.onmessage = (e) => {
    if (typeof e.data?.open !== "string") return;
    takeLink(e.data.open);
    routePending(DEMO);
    if (pending || pendingPing) refresh(); // not here yet: fetch, then try again
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return document.activeElement?.matches?.("[data-guess]") && document.activeElement.blur();
    if (session.day !== todayString() && !current()) newSession();
    DEMO ? render() : refresh();
  });
}

function switchTab(next) {
  setContents(false);
  tabY[tab] = scrollY;
  if (next === tab && next === "study") { stack = [{ s: "home" }]; tabY.study = 0; } // the current tab again: back to its start
  tab = next;
  render();
  scrollTo(0, tabY[tab] ?? 0);
  const page = $(tab);
  page.classList.remove("enter"); void page.offsetWidth; page.classList.add("enter");
}

// ---------- Demo fixtures (?demo=1): sample data dated from now, no network; ?demo=empty starts with nothing ----------

function demoCards() {
  const crg = "Corporate Restructuring & Governance", sm = "Strategic Management", t = todayString();
  const card = (id, module, lecture, front, back, user_data = {}) => ({ id, module, title: null, data: { front, back, lecture, origin: "Demo" }, user_data });
  return [
    card("crg-l1-1", crg, "L1", "What did Berle and Means (1932) identify?", "The separation of ownership and control: dispersed shareholders own the firm, professional managers run it.", { due: t, ease: 2.5, interval: 3, reps: 2, lapses: 0 }),
    card("crg-l1-2", crg, "L1", "State the agency problem in one sentence.", "Managers (agents) may pursue their own interests rather than those of shareholders (principals), because their actions are hard to observe."),
    card("crg-l1-3", crg, "L1", "Name two costs Jensen and Meckling (1976) say agency creates.", "Monitoring costs paid by the principal, bonding costs paid by the agent, and the residual loss that remains."),
    card("crg-l1-4", crg, "L1", "What does “comply or explain” mean in the UK Corporate Governance Code?", "Companies follow each provision or explain publicly why they don’t; the market judges the explanation.", { due: t, ease: 2.35, interval: 1, reps: 3, lapses: 1 }),
    card("crg-l2-1", crg, "L2", "Which 1992 report started UK governance codes?", "The Cadbury Report, after the Maxwell and BCCI scandals."),
    card("sm-l1-1", sm, "L1", "What are the four VRIO questions?", "Is the resource Valuable, Rare, costly to Imitate, and is the firm Organised to capture its value? (Barney, 1991)"),
    card("sm-l1-2", sm, "L1", "Porter’s five forces: name them.", "Rivalry, threat of new entrants, threat of substitutes, buyer power, supplier power."),
    card("sm-l1-3", sm, "L1", "Shareholder primacy versus stakeholder theory?", "Primacy: the firm exists to maximise shareholder value. Stakeholder theory: managers balance the claims of everyone the firm affects.", { due: addDays(t, 3), ease: 2.6, interval: 20, reps: 4, lapses: 0 }),
  ];
}

/** Everything Today shows, dated from now so the demo never goes stale: today's events (some already past), slipped and
 *  rescheduled tasks, rows the relevance rules hide (expired, let go, slipped too long, old and undated, closed
 *  applications), and a brief that opens with a greeting on purpose. */
function demoData() {
  const crg = "Corporate Restructuring & Governance", sm = "Strategic Management", t = todayString(), day = (n) => addDays(t, n);
  const assess = (id, module, date, data) => ({ id, source: "demo", module, title: data.title, date, data, user_data: {} });
  const daysAgo = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const task = (id, date, title, origin, user_data = {}, more = {}, created = 1) => ({ id, source: "demo", title, date, data: { title, origin, ...more }, user_data, created_at: daysAgo(created) });
  const clockAt = (hhmm) => new Date(`${t}T${hhmm}:00`).toISOString().replace(/\.\d{3}Z$/, "Z"); // today, local time, as VoiceType writes it
  const h = new Date().getHours();
  const msStart = new Date(`${day(1)}T11:00`), msClass = { id: "ev-ms-sem1", title: "Marketing and Society seminar", date: day(1),
    data: { title: "Marketing and Society seminar", start: msStart.toISOString(), end: new Date(msStart.getTime() + 36e5).toISOString(), location: "JC Computer Science A01" }, user_data: {} };
  const event = (id, dh, mins, title, location, m = 0) => {
    const start = new Date(); start.setHours(h + dh, m, 0, 0);
    return start.getDate() === new Date().getDate() && start.getHours() >= 6
      ? { id, title, date: t, data: { title, start: start.toISOString(), end: new Date(start.getTime() + mins * 6e4).toISOString(), location }, user_data: {} } : null;
  };
  return {
    cards: demoCards(),
    brief: { id: "brief-" + t, date: t, data: { priority: { title: "Outline the CRG essay", due: day(1),
      why: "Hello, student—the outline goes to the tutor tomorrow, and the essay is worth 50% of the module." } } },
    events: [
      event("ev-run", -5, 45, "Run club", "University Park lakeside"),
      event("ev-crg", -3, 60, "CRG lecture: Jensen & Meckling", "Portland A13"),
      event("ev-sm", -1, 50, "SM seminar", "Business School South B32"),
      event("ev-gym", 1, 60, "Gym", "David Ross Sports Village"),
      event("ev-mum", 2, 30, "Call with Mum", "", 30),
      event("ev-group", 4, 90, "SM group meeting", "Hallward Library, room 3"),
      event("ev-spin", 6, 45, "Spin class", "Jubilee Sports Centre"),
      { id: "ev-fair", title: "Careers fair week", date: day(-2), data: { title: "Careers fair week", allDay: true, start: `${day(-2)}T00:00:00+01:00`, end: `${day(3)}T00:00:00+01:00` }, user_data: {} }, // began before today, still on
      msClass, // tomorrow 11:00, the brief's class
    ].filter(Boolean),
    pings: demoPings(),
    assessments: [
      assess("assess-crg-essay", crg, day(5), { title: "Essay", weight: "50%", milestones: [{ date: day(1), label: "Outline to tutor" }, { date: day(12), label: "Full draft" }] }),
      assess("assess-sm-group", sm, day(24), { title: "Group presentation", weight: "30%", milestones: [{ date: day(6), label: "Slides to the group" }] }),
      assess("assess-ms-essay", "Marketing & Society", day(63), { title: "M&S essay", weight: "50%" }),
      assess("assess-sm-exam", sm, day(100), { title: "Exam", weight: "70%" }),
    ],
    tasks: [
      task("you-demo-1", day(-1), "Email Dr Lane about the essay question", "You"),
      task("you-demo-13", day(1), "Outline the CRG essay", "You"), // the brief's priority, so its card gets the tick
      task("auto-demo-7", day(-3), "Return the library books", "Uni mail"),
      task("auto-demo-2", t, "Read Jensen & Meckling (1976) before the seminar", "Lectures"),
      task("auto-voice-demo-6", t, "Call the accommodation office", "You", {}, { remindAt: clockAt("17:30") }),
      task("auto-demo-3", day(2), "Book a library group room", "Uni mail"),
      task("you-demo-8", day(-2), "Draft the Orbis cover letter", "You", { doDate: day(3) }),
      task("you-demo-4", null, "Renew railcard", "You"),
      // Hidden by the relevance rules:
      task("you-demo-5", day(-2), "Submit module choices", "You", { done: true, doneAt: Date.now() - 2 * 864e5 }),  // R2 done
      task("auto-demo-9", day(1), "Buy a lab coat", "Uni mail", { dismissed: true }),                                   // R2 let go
      task("auto-demo-10", day(-1), "Sign up for the careers talk", "Uni mail", {}, { expires: day(-1) }),            // R4 expired
      task("auto-demo-11", day(-20), "Fill in the module survey", "Uni mail"),                                         // R5 slipped too long
      task("you-demo-12", null, "Sort out the gym membership", "You", {}, {}, 30),                                     // R6 old and undated
    ],
    ...demoStudy(t, day),
    applications: [
      { id: "app-demo-orbis", title: null, date: day(4), data: { org: "Orbis", role: "Summer Analyst", stage: "Applying" }, user_data: {} },
      { id: "app-demo-lazard", title: null, date: day(3), data: { org: "Lazard", role: "Spring Insight", stage: "Submitted 2 Oct" }, user_data: {} }, // R3
      { id: "app-demo-jpm", title: null, date: day(5), data: { org: "JPMorgan", role: "Off-cycle", status: "rejected" }, user_data: {} },             // R3
    ],
    notes: [
      { id: "you-demo-n1", source: "you", title: "Ask Dr Lane", data: { body: "Ask Dr Lane if the essay can use 2025 annual reports" }, user_data: {}, created_at: daysAgo(2 / 24) },
      { id: "you-demo-n2", source: "you", title: "Agency costs", data: { body: "Agency costs = monitoring + bonding + residual loss (seminar board)" }, user_data: {}, created_at: daysAgo(26 / 24) },
      { id: "you-demo-n3", source: "you", title: "Compare Tesco", data: { body: "Compare Tesco and Sainsbury’s board structures for the essay" }, user_data: {}, created_at: daysAgo(2.2) },
      { id: "you-demo-n4", source: "you", title: "Room change", data: { body: "SM seminar moves to B32 from next week" }, user_data: {}, created_at: daysAgo(3.1) },
    ],
  };
}

/** The contract's test brief (docs/(C) Brief + ping contract.md §8): M&S Seminar 1, tomorrow 11:00 in JC CS A01, with
 *  every brief block and audio scripts but no recording, so the player falls back to the phone's voice. */
function demoBrief(day) {
  const classAt = new Date(`${day(1)}T11:00`).toISOString();
  const doc = { version: 1, blocks: [
    { t: "h1", text: "M&S Seminar 1 · The essay brief" },
    { t: "meta", text: "Marketing & Society (BUSI3023) · Seminar 1 · JC Computer Science A01" },
    { t: "p", text: "The seminar walks through the **assessment brief**, the **rubric** and the **AI rules**. Prep is compulsory: you may be asked to leave without it." },
    { t: "checklist", items: [
      { id: "c1", text: "Read the assessment brief", detail: "8 pages. Note the four sections and the AI table.", minutes: 20, must: true },
      { id: "c2", text: "Read the marking rubric", detail: "10 criteria; watch “Written communication”.", minutes: 20, must: true },
      { id: "c3", text: "Pick one context", detail: "Advertising, energy and poverty, or healthy sustainable food.", minutes: 5, must: true },
      { id: "c4", text: "Find an example you have met yourself", minutes: 25, must: true },
      { id: "c5", text: "Background reading on the scale of the problem", minutes: 50, must: true },
      { id: "c6", text: "Write down your questions", minutes: 10 } ] },
    { t: "steps", title: "How the essay is built", diagram: { type: "graph", nodes: [
        { id: "s1", title: "1 · The problem", sub: "300 words", row: 0 }, { id: "s2", title: "2 · Critical analysis", sub: "700 words", row: 0 },
        { id: "s3", title: "3 · Reflection", sub: "500 words", row: 1 }, { id: "s4", title: "4 · Recommendations", sub: "500 words", row: 1 }], edges: [] },
      frames: [
        { text: "**Section 1** names a problem you have met yourself, with your own evidence and its scale in the UK.", focus: ["s1"] },
        { text: "**Section 2** brings in theory. It carries the most marks: 30% for 700 words.", focus: ["s2"] },
        { text: "**Section 3** reflects as a consumer *and* a citizen, and links back to section 2.", focus: ["s3"] },
        { text: "**Section 4** recommends, for a named stakeholder, with the obstacles.", focus: ["s4"] } ] },
    { t: "marks", title: "Where the marks are", rows: [
      { label: "1 · The problem", words: 300, weight: 15, ai: "ban" }, { label: "2 · Critical analysis", words: 700, weight: 30, ai: "opt" },
      { label: "3 · Reflection", words: 500, weight: 25, ai: "ban" }, { label: "4 · Recommendations", words: 500, weight: 25, ai: "ban" },
      { label: "Written communication", words: 0, weight: 5, ai: "gram" } ] },
    { t: "prequestions", items: [
      { q: "Which three contexts may the essay use?", answer: "Advertising; energy use and poverty; healthy, sustainable food." },
      { q: "Which section carries the most marks?", answer: "Section 2, critical analysis: 30%." },
      { q: "Where is AI banned outright?", answer: "Problem identification, personal reflection and recommendations." } ] },
    { t: "quiz", items: [
      { q: "How long is the essay?", options: ["1,500 words", "2,000 words", "3,000 words"], answer: 1, why: "Four sections: 300, 700, 500 and 500." },
      { q: "Can AI check your grammar?", options: ["Never", "Yes, once your own content is complete"], answer: 1, why: "Grammar and structure checks are optional, after you've written it." } ] },
  ] };
  return { id: "auto-pre-ms-sem1", module: "Marketing & Society", date: day(1), title: "M&S Seminar 1 brief", user_data: {},
    data: { kind: "pre", lecture: "Seminar 1", classAt, where: "JC Computer Science A01", minutes: 130, doc,
      audio: { short: { script: "Tomorrow's Marketing and Society seminar goes through the essay brief, the rubric and the AI rules. Read the brief and the rubric, pick one of the three contexts, and find an example you have met yourself." },
               full: { script: "Here is the full brief for Marketing and Society, Seminar 1. The seminar walks through the assessment brief, the marking rubric and the rules on AI. The essay has four sections: the problem, critical analysis, reflection and recommendations." } } } };
}

/** Pings around the demo brief: some have fired (the Inbox), some are still to come (Up next). */
function demoPings() {
  const t = todayString(), at = (days, hhmm) => new Date(`${addDays(t, days)}T${hhmm}`), iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const ping = (id, title, when, kind, open, user_data = {}) => ({ id, title, date: localDay(when.getTime()), data: { at: iso(when), kind, open }, user_data });
  const ago = (mins) => new Date(Date.now() - mins * 6e4);
  return [
    ping("ping-moodle-ms-brief", "M&S: assessment brief posted", ago(95), "moodle", "url:https://moodle.nottingham.ac.uk/"),
    ping("ping-notes-crg-l1", "CRG L1 notes ready", ago(26 * 60), "notes", "note:auto-post-crg-l1", { seenAt: Date.now() - 25 * 36e5 }),
    ping("ping-deadline-crg-outline", "CRG essay outline due tomorrow", ago(4 * 60), "deadline", "item:assess-crg-essay"),
    ping("ping-brief-ms-sem1", "M&S Seminar 1 brief", at(0, "20:00"), "brief", "note:auto-pre-ms-sem1"),
    ping("ping-nudge-ms-sem1", "M&S Seminar 1 in an hour", at(1, "10:00"), "nudge", "listen:auto-pre-ms-sem1"),
    ping("ping-reask-ms-sem1", "M&S Seminar 1: three questions", at(2, "09:00"), "reask", "reask:auto-pre-ms-sem1"),
  ];
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
            { id: "o1", title: "Harm can’t be separated", sub: "Hart & Zingales 2022", tone: "con", row: 1 },
            { id: "v", title: "Maximise shareholder welfare", sub: "the verdict", tone: "verdict", row: 2 }],
    edges: [{ from: "r1", to: "c", verb: "supports", style: "solid" }, { from: "r2", to: "c", verb: "supports", style: "solid" },
            { from: "o1", to: "c", verb: "undermines", style: "dashed" }, { from: "c", to: "v", verb: "so", style: "solid" }] });
  const doc = { version: 1, blocks: [
    { t: "h1", text: "CRG L1 · Why corporate governance exists" },
    { t: "meta", text: "Corporate Restructuring & Governance (BUSI3028) · 100% exam" },
    { t: "callout", tone: "note", text: "**Built from:** the recording, 22 slides and handwritten notes. Small numbers¹ point to sources." },
    { t: "table", header: ["Key term", "In one line"], rows: [["**Agency problem**", "Managers may serve themselves, not the owners"], ["**Moral hazard**", "Hidden *actions*: is the manager working for us?"], ["**Blockholder**", "An owner big enough (8–10%) to make monitoring pay"]] },
    { t: "h2", text: "1. The lecture in a minute" },
    { t: "p", text: "Once thousands of shareholders own a firm that a few managers run, **nobody has a reason to watch the managers**. That gap is the agency problem, and governance is the toolkit for closing it.¹" },
    { t: "callout", tone: "warn", text: "**Exam steer:** shareholder value won’t be a whole question, but it may be part (a) of one." },
    { t: "h2", text: "2. The lecture, step by step" },
    { t: "h3", text: "2.1 Why don’t shareholders just watch managers?" },
    { t: "p", text: "Because monitoring is a *public good*: the monitor pays the full cost and shares the gain with every owner. See [the ECGI primer](https://ecgi.global/) for more." },
    { t: "bullets", items: ["Smith (1776): managers aren’t careful with other people’s money.", "Berle & Means (1932): law separates ownership from control."] },
    { t: "diagram", caption: "**Takeaway:** a claim, two reasons, one objection, then a verdict with a condition.", diagram: debate(false) },
    { t: "callout", tone: "key", text: "**Check yourself:** why does *more* shareholders make monitoring *less* likely? *Answer in section 4.*" },
    { t: "h3", text: "2.2 Where each idea comes from" },
    { t: "diagram", caption: "Quote the year with the name.", diagram: { type: "timeline", title: "The debate over time", events: [
      { label: "1776", text: "Smith: “negligence and profusion”", tone: "plain" }, { label: "1932", text: "Berle & Means: ownership ≠ control", tone: "key" },
      { label: "1970", text: "Friedman: one social responsibility", tone: "plain" }, { label: "2022", text: "Hart & Zingales: welfare, not value", tone: "con" }] } },
    { t: "table", header: ["", "Friedman (1970)", "Jensen (2002)", "Hart & Zingales (2022)"], rows: [["Maximise", "Profit", "Firm value", "Shareholder welfare"], ["Weak spot", "Inseparable harm", "Needs fair prices", "Whose welfare?"]] },
    { t: "quote", text: "The social responsibility of business is to increase its profits.", by: "Milton Friedman, 1970" },
    { t: "h2", text: "3. Use it in the exam" },
    { t: "callout", tone: "warn", text: "**Common mistakes:**\n• Stating a point without the logic behind it.\n• Describing every theory instead of arguing with two." },
    { t: "h2", text: "4. Study it" },
    { t: "diagram", caption: "**Do this first:** fill in the blank map from memory, then check it against 2.1.", diagram: debate(true) },
    { t: "numbers", items: ["Why is monitoring a public good when ownership is dispersed?", "What’s the difference between moral hazard and adverse selection?"] },
    { t: "callout", tone: "note", text: "**Answers.** 1 The monitor pays the full cost but shares the gain with every owner. 2 Hidden actions versus hidden qualities." },
    { t: "inshort", items: ["Dispersed owners don’t monitor.", "Governance closes the gap.", "The exam wants the condition, not a list."] },
    { t: "h2", text: "Sources" },
    { t: "sources", items: ["Lecture recording 9:23–10:15; handwritten notes.", "Slides 4–6."] },
  ] };
  return {
    modules: [
      { id: "mod-ms", module: "Marketing & Society", title: "Marketing & Society", data: { code: "BUSI3023", short: "M&S", convenor: "Dr Samanthika Gallage", assessment: "Essay 100% due 8 Dec" } },
      { id: "mod-crg", module: crg, title: crg, data: { code: "BUSI3028", short: "CRG", convenor: "Dr Sarah Lane", assessment: "Exam, 2 hours, 100%, 2 essays from 6, January", next: "L2 Wed 10:00 · Jensen & Meckling model · exam 100%" } },
      { id: "mod-sm", module: sm, title: sm, data: { code: "BUSI3186", short: "SM", convenor: "Dr Tom Hale", assessment: "Group video 30% due 10 Dec · case study 70% due 13 May", next: "L2 Fri 09:00 · External analysis" } },
    ],
    lectures: [
      { id: "lec-marketing-society-sem1", module: "Marketing & Society", date: day(1), title: null, data: { n: "Seminar 1", topic: "The essay brief, the rubric and AI rules", pre: "auto-pre-ms-sem1" }, user_data: {} },
      { id: "lec-crg-l1", module: crg, date: day(-6), title: null, data: { n: "L1", topic: "Why corporate governance exists", pre: "auto-pre-crg-l1", post: "auto-post-crg-l1" }, user_data: {} },
      { id: "lec-crg-l2", module: crg, date: day(1), title: null, data: { n: "L2", topic: "The Jensen & Meckling model", pre: "auto-pre-crg-l2" }, user_data: {} },
      { id: "lec-sm-l1", module: sm, date: day(-4), title: null, data: { n: "L1", topic: "What is strategy?", post: "auto-post-sm-l1" }, user_data: {} },
    ],
    lectureNotes: [
      demoBrief(day),
      note("auto-pre-crg-l1", crg, "pre", "L1", "CRG L1 primer", { body: "Before L1: skim **Berle & Means (1932)**, the abstract only.\n\n- Who owns a listed firm?\n- Who runs it, and why might they differ?" }),
      note("auto-post-crg-l1", crg, "post", "L1", "CRG L1 · Why corporate governance exists", { body: "## One-page core\nDispersed owners don’t monitor.", doc }),
      note("auto-pre-crg-l2", crg, "pre", "L2", "CRG L2 primer", { body: "## Before L2\nThe *Jensen & Meckling (1976)* model is “as hard as it gets”: one graph, no heavy maths.\n\n1. Draw firm value against the manager’s share.\n2. Mark where perks start to cost the owners.\n\n> Read the introduction and conclusion; skip the proofs." }),
      note("auto-post-sm-l1", sm, "post", "L1", "SM L1 · What is strategy?", { body: "## One-page core\n**Strategy** is a set of choices about where to compete and how to win (Porter, 1996).\n\n| Theory | Question it answers | Use it for |\n|---|---|---|\n| Five Forces | How attractive is the industry? | Part 1: why change started |\n| VRIO | Which resources give an edge? | Part 2: what changed |\n| Upper echelons | How do leaders shape it? | Part 3: leadership |\n\n## How to do well\n- Use 2–3 theories **systematically**, not a tour of every model.\n  - Apply each one to the case evidence.\n- Five Forces substitutes are *other products* (trains versus flights).\n\n> Last year’s markers punished describing the case instead of applying theory.\n\n---\nSlides and the brief are on [Moodle](https://moodle.nottingham.ac.uk/)." }),
      note("auto-crg-l1-readings", crg, "readings", "L1", "CRG L1 readings", { body: "- **Jensen (2002)**, *Value maximization, stakeholder theory and the corporate objective function*. Essential.\n- Hart & Zingales (2022). Read the abstract, introduction and conclusion." }),
    ],
    practice: [
      { id: "crg-l1-svm", module: crg, title: null, data: { kind: "essay", lecture: "L1", origin: "From the CRG L1 notes",
        prompt: "Should firms maximise shareholder value? Answer with Friedman (1970) and Hart & Zingales (2022).",
        model: "**Thesis:** yes, *but only when* the firm’s harms are separable and reversible.\n\n1. Friedman: profit within the rules; governments provide social goods.\n2. Jensen: one measurable objective beats many conflicting ones.\n3. Against: when harm can’t be separated from production (PFAS), the firm prevents it more cheaply than anyone can clean it up.\n\n**Verdict:** Hart & Zingales’ shareholder *welfare* keeps primacy and is still not stakeholder theory." }, user_data: {} },
      { id: "crg-l1-monitor", module: crg, title: null, data: { kind: "short", lecture: "L1", origin: "From the CRG L1 notes",
        prompt: "Why is monitoring managers a public good when ownership is dispersed?",
        model: "The monitor bears the **full cost** but shares the **gain** with every shareholder, so no small owner’s private benefit exceeds their cost. Blockholders of about 8–10% are the exception." }, user_data: {} },
      { id: "sm-l1-substitutes", module: sm, title: null, data: { kind: "short", lecture: "L1", origin: "From the SM L1 notes",
        prompt: "In Five Forces, is easyJet a substitute for Ryanair?",
        model: "No. They are **rivals** in the same industry. A substitute is a different product meeting the same need, such as trains instead of flights." },
        user_data: { attempt: "No, they’re rivals; a substitute would be something like the train.", attemptedAt: Date.now() - 86400000 } },
    ],
  };
}

start();
