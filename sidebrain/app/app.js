// Sidebrain on the phone: what's on and due today, study (flashcards, lecture notes, practice), and quick to-dos and notes,
// on the same Supabase backend as the Mac app. Every review and practice attempt writes items.user_data and one `activity`
// row exactly as Sources/(C) View Study.swift does; a tick writes what Sources/(C) View Today.swift does. Every user_data
// write is merged into the row's user_data and carries `userAt`, so the server can keep the newer one.
// Writes go through a small outbox in localStorage, so a review on a train with no signal is never lost.
import { schedule, intervalLabel, due, nextDue, examDays, todayString, daysBetween, addDays } from "./sm2.js";
import { withoutGreeting, dueSoon, runway, gone, parseWhen, daySchedule, ago, priorityDueLabel, shortDay, WEEKDAYS, MONTHS, effectiveDate,
         upNext, inbox, fireAt, snoozeChoices, nextBrief, briefLabel, clock, classNow, heroEvent, heroFigure, weekEnd, prep } from "./today.js";
import { esc, markdown, lectureDoc, lectureNotes, ordered, lectureDay, modulesByName, TICK } from "./notes.js";
import * as train from "./train.js";
import { messageView, conversations, threadBody, mailUrl, foldedPings, plainHtml, replyLink, draftRequest, askRequest, answerText, docText } from "./nexi.js";
import * as food from "./food.js";
import { suggestions, showCheckin, dailyId, dailyOf, rugbyOn, RUGBY_LINE, muteUntil } from "./nudges.js";

// ---- Settings to fill in before publishing (web/(C) README.md) ----
const SUPABASE_URL = "https://rdwavprncthvujmckige.supabase.co";
// Public by design, the same key the Mac app ships (Sources/(C) Flavor.swift); row-level security protects every row.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkd2F2cHJuY3RodnVqbWNraWdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEwNDg2MjYsImV4cCI6MjA3NjYyNDYyNn0.eg_I1CtKu3dF98JdLB8eU4Yww1NkJXtlRVo4orapeTM";
const GOOGLE_CLIENT_ID = "327768131024-jqlmp8jeb6qtouq2b4sv8v1pigss6fa4.apps.googleusercontent.com";  // the Google *Web* OAuth client ID (README step 1)
// Optional override. Empty: the app asks the push function for it (GET /functions/v1/push → {publicKey}).
const VAPID_PUBLIC_KEY = "";
const SUPABASE_JS = "./vendor/supabase/supabase-js.js"; // 2.117.2, self-hosted (vendor/supabase/LICENSE) so the CSP allows no CDN
// ponytail: supabase-js from a pinned CDN URL, no integrity check; vendor the file into web/ if that ever matters.

const DEMO_MODE = new URLSearchParams(location.search).get("demo");
const DEMO = DEMO_MODE === "1" || DEMO_MODE === "empty"; // ?demo=empty: a new friend's account, nothing in it yet
const CAP = 20; // cards per review session: a small daily dose with a real end
const num = (n) => new Intl.NumberFormat("en-GB").format(n);
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
let cards = [], byId = new Map(), assessments = [], tasks = [], applications = [], events = [], brief = null, notes = [], pings = [], messages = [];
let modules = [], lectures = [], practice = [], noteById = new Map(); // Study: lecture notes are `note` items, by id
let thumbs = new Map();              // photo path → signed URL (or a data URL in demo), for capture thumbnails
let outbox = load("outbox", []);     // [{t: "review" | "tick" | "edit" | "attempt", id, user_data, activity?} | {t: "note" | "add", row}], oldest first
let captures = load("captures", []); // the last captures made on this phone: {id, body, photo, thumb?, at}
let synced = load("synced", 0), tried = 0;
// The Train plugin (train.js): off until switched on in the Account sheet, per phone. Off, no `gym` row is fetched.
let trainOn = load("train", false);
let daily = load("daily", []);         // the check-in and Suggestions state: one synced gym row a day (nudges.js)
// Nothing writes today's row until the server's copy (or this phone's saved one) is in: a row made before the fetch would
// be refused as a duplicate, and the next write would then send this phone's thin copy as the whole user_data.
let dailyReady = DEMO || load("daily", null) !== null;
let sugOn = load("suggestions", true), sugRows = [], sugKey = null, checkinStep = 1;
let tab = "today", reviewing = false, loaded = false, cloud = "", syncError = "", signedOutOfSync = false, reminders = "off";
const photos = { add: null }; // the photo waiting in the composer
// Today's view state.
const held = new Map();     // task id → {kind: "done" | "gone", at, timer}: shown (ticked or leaving) until it collapses
let sheetTask = null;
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
  train.mount({ sb: () => sb, user: () => user, esc, row, head, ICON, addRow, writeUser, shrink, dataUrl, url: SUPABASE_URL, anon: SUPABASE_ANON_KEY,
                demo: DEMO, keep, load, rerender: () => render(), tab: () => switchTab("train"),
                // Train builds on the shell's components (Design system.md): its sheet, the Undo toast, the confirm and folds.
                openSheet, closeSheet, sheetGestures, toast, ask, fold, on: () => trainOn, food, daily: () => daily });
  food.mount({ sb: () => sb, esc, row, ICON, addRow, writeUser, shrink, dataUrl, url: SUPABASE_URL, anon: SUPABASE_ANON_KEY, demo: DEMO, keep, load,
               openSheet, closeSheet, sheetGestures, rerender: () => render() });
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
      const meta = s.user.user_metadata ?? {};
      user = { id: s.user.id, email: s.user.email, name: meta.given_name ?? meta.full_name?.split(" ")[0] ?? null }; // Nexi's prompts use the first name
      keep("user", user);
      refresh();
    }
  }));
}

function signedOut() {
  user = null; cards = []; byId = new Map(); tasks = []; applications = []; events = []; brief = null; notes = []; pings = []; messages = []; loaded = false;
  chats.clear(); replies.clear(); drafting.clear(); materials.clear(); nx = null; how = ""; sheetItem = null; // message bodies, drafts and chats never outlive the session
  for (const d of ["item-sheet", "nexi-sheet"]) if ($(d).open) $(d).close();
  modules = []; lectures = []; practice = []; noteById = new Map(); stack = [{ s: "home" }]; reviewing = false; daily = []; dailyReady = false;
  // Everything this account's data left on the phone (the cache holds message bodies). The outbox and captures stay, and
  // sync after the next sign-in; Sign out removes those too.
  for (const k of ["cache", "user", "synced", "daily", "nexi-chat", "lecture-notes"]) localStorage.removeItem(PREFIX + k);
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
  const uid = user.id, gone = () => user?.id !== uid; // signed out (or another account) while this was in flight: write nothing back
  try {
    const today = todayString();
    const [c, a, t, ap, ev, b, n, mo, le, pr, ln, pg, ms] = await Promise.all([
      all("card", "id,module,title,data,user_data,updated_at"), all("assessment", "id,source,module,title,data,date,user_data"),
      all("task", "id,source,title,date,data,user_data,created_at,updated_at"), all("application", "id,title,date,data,user_data"),
      run(items("event", "id,title,date,data,user_data").gte("date", addDays(today, -14)).lte("date", addDays(today, 7))), // earlier ones may still be running; Up next runs to Sunday
      run(items("brief", "id,date,data").eq("date", today).limit(1)),
      run(items("quicknote", "id,source,title,data,user_data,created_at").order("created_at", { ascending: false }).limit(50)),
      all("module", "id,module,title,data,updated_at"), all("lecture", "id,module,date,title,data,user_data"),
      all("practice", "id,module,title,data,user_data,updated_at"), all("note", "id,module,date,title,data,user_data,updated_at"),
      // ponytail: the last 30 days of pings; page further back if the Inbox ever needs older ones.
      run(items("ping", "id,title,date,data,user_data,updated_at").gte("date", addDays(today, -30)).lte("date", addDays(today, 7))),
      // Priority messages, mirrored by the Mac (v2 design §1). Before the `message` migration this is just [].
      all("message", "id,title,date,data,user_data,updated_at"),
    ]);
    if (gone()) return;
    // Off the critical path: before the gym migration is applied the query fails, and Today must still load.
    if (trainOn) all("gym", "id,kind,source,date,title,data,user_data,created_at,updated_at,deleted_at").then((r) => { if (!gone()) { train.setRows(r); food.setRows(r); } }, () => {});
    run(items("gym", "id,source,date,title,data,user_data,created_at,updated_at").like("id", "daily-%").gte("date", addDays(today, -8))).then((r) => { if (!gone()) setDaily(r); }, () => {});
    const fresh = { cards: c, assessments: a, tasks: t, applications: ap, events: ev, brief: b[0] ?? null, notes: n, modules: mo, lectures: le, practice: pr, pings: pg, messages: ms };
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
    if (gone()) return;
    cloud = loaded ? "Couldn’t reach Sidebrain. Showing what’s saved on this phone." : `Couldn’t load: ${e.message || "network error"}`;
  }
  render();
  routePending(true);
  flush();
  const status = await reminderStatus();
  if (gone()) return;
  reminders = status;
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
  const added = outbox.filter((o) => o.t === "add" && o.row.kind === "task").map((o) => ({ ...o.row, created_at: o.at }));
  cards = withPending(merge(d.cards, cards));
  byId = new Map(cards.map((x) => [x.id, x]));
  tasks = withPending(merge([...(d.tasks ?? []).filter((x) => !added.some((a) => a.id === x.id)), ...added], tasks));
  assessments = withPending(merge(d.assessments, assessments)); applications = d.applications ?? []; events = d.events ?? []; brief = d.brief ?? null; notes = d.notes ?? [];
  modules = modulesByName(d.modules ?? []);
  lectures = d.lectures ?? []; practice = withPending(merge(d.practice, practice)); pings = withPending(merge(d.pings, pings));
  messages = withPending(merge(d.messages, messages));
  noteById = new Map(withPending(merge(d.lectureNotes, [...noteById.values()])).map((x) => [x.id, x]));
  loaded = true;
  if (!reviewing && (session.index === 0 || session.day !== todayString())) newSession(); // never reshuffle a session in progress, even on its first card
}

const saveCache = () => { if (!DEMO) keep("cache", { cards, assessments, tasks, applications, events, brief, notes, modules, lectures, practice, pings, messages }); };

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
  Object.assign(session, { queue: dueFor(module, lecture).slice(0, CAP).map((x) => x.id), index: 0, flipped: false, grades: [0, 0, 0, 0], day: todayString(), module, lecture });
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
  if (!session.queue.slice(0, session.index).includes(card.id)) session.grades[g] += 1; // each card's first grade: "7 cards · 5 Good · 2 Again"
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
  const li = document.querySelector(`#day [data-row="${CSS.escape(id)}"]`);
  const finish = () => { held.delete(id); render(); };
  if (!li || still()) return finish();
  li.style.height = li.offsetHeight + "px";
  li.classList.add("collapsing");
  void li.offsetHeight;
  li.style.height = "0px"; li.style.opacity = "0";
  setTimeout(finish, 300);
}

/** A task leaves its place (moved or let go): the row shows as it was, folds away, and a toast offers Undo, which writes
 *  `undo` back. */
function leave(task, prev, patch, message, undo) {
  writeUser(task, patch, "edit");
  closeSheet($("task-sheet"));
  held.set(task.id, { kind: "moved", at: Date.now(), prev });
  render();
  requestAnimationFrame(() => collapse(task.id));
  toast(message, () => { held.delete(task.id); writeUser(task, undo, "edit"); render(); });
}

/** Reschedule: user_data.doDate, which wins over the row's own date (R1). */
function move(id, day) {
  const task = tasks.find((x) => x.id === id), today = todayString();
  if (!task || !day || day < today) return; // a picker that lets a past day through (min isn't enforced everywhere)
  const prev = task.user_data ?? {};
  leave(task, prev, { doDate: day }, `Moved to ${dayName(day, today).replace(/^(Today|Tomorrow)$/, (w) => w.toLowerCase())}`, { doDate: prev.doDate ?? null });
}

/** Let go: {dismissed: true}. */
function letGo(id) {
  const task = tasks.find((x) => x.id === id);
  if (task) leave(task, task.user_data ?? {}, { dismissed: true }, "Let go", { dismissed: false });
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

/** A new row from a plugin (train.js): queued like a to-do, but kept out of Today's tasks. */
function addRow(row) {
  outbox.push({ t: "gym", row, at: new Date().toISOString() });
  keep("outbox", outbox);
  flush();
}

/** Server daily rows in (S1): merged like the rest, with adds and writes still in the outbox kept, the last 9 days only. */
function setDaily(fetched) {
  const pending = new Map(outbox.filter((o) => o.user_data).map((o) => [o.id, o.user_data]));
  const added = outbox.filter((o) => o.t === "gym" && o.row.id?.startsWith("daily-") && !fetched.some((f) => f.id === o.row.id)).map((o) => ({ ...o.row, created_at: o.at }));
  const from = addDays(todayString(), -8);
  daily = merge([...fetched, ...added], daily).map((x) => (pending.has(x.id) ? { ...x, user_data: pending.get(x.id) } : x)).filter((x) => x.date >= from);
  dailyReady = true;
  keep("daily", daily);
  render();
}
/** Today's daily row: made on the first write of the day (S2), merged after that. */
function dailyWrite(patch) {
  const today = todayString(), r = dailyOf(daily, today);
  if (r) writeUser(r, patch, "edit");
  else {
    const row = { id: dailyId(today), kind: "gym", source: "you", module: null, deleted_at: null, date: today, title: "Daily", data: { type: "daily" }, user_data: { ...patch, userAt: Date.now() } };
    daily.push({ ...row, created_at: new Date().toISOString() });
    addRow(row);
  }
  keep("daily", daily);
}
/** Train's rows as train.js keeps them on this phone (read only: the Training lane owns train.js). */
function trainState() {
  if (!trainOn) return { on: false };
  const rows = load("gym", []).filter((r) => !r.deleted_at);
  // Meals come from Food (food.js keeps them under its own key since Food v2), so a meal logged a minute ago counts.
  return { on: true, profile: rows.find((r) => r.id === "gym-profile")?.user_data ?? null, sessions: rows, food: food.today() };
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
    const item = [...cards, ...tasks, ...practice, ...pings, ...messages, ...noteById.values(), ...assessments, ...daily].find((x) => x.id === op.id);
    if (item) item.user_data = op.before ?? {};
    if (item && op.id.startsWith("daily-")) keep("daily", daily);
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
  // In class, the note goes to that class's snippets on the Mac (the placeholder names the class); "Note for this class" picks one.
  const ok = await capture(form.elements.body.value.trim(), photos[name], status, captureFor ?? classNow(events, modules, lectures));
  if (ok) { form.elements.body.value = ""; setPhoto(form, null); }
  canSave(form);
  if (ok) closeSheet($("add-sheet"));
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
  const dark = theme() === "dark" || (theme() === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
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
    for (const k of ["outbox", "captures", "reminders", "daily", "nexi-chat", "lecture-notes"]) localStorage.removeItem(PREFIX + k);
    return location.reload();
  }
  for (const k of ["outbox", "captures"]) localStorage.removeItem(PREFIX + k); // signedOut() clears the rest
  outbox = []; captures = [];
  closeSheet($("sheet"));
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

const TABS = ["today", "study", "inbox", "train"];
function render() {
  const signedIn = !!user, today = todayString(), root = document.documentElement;
  const pushed = signedIn && tab === "study" && stack.length > 1;
  const deep = pushed || (signedIn && tab === "train" && trainOn && train.depth() > 0); // Train pushes History, a session, an exercise, Edit plan
  root.classList.toggle("reviewing", signedIn && reviewing);
  $("signin").hidden = signedIn;
  $("dock").hidden = !signedIn;
  if (tab === "train" && !trainOn) tab = "today"; // before the pages show, so turning Train off on its own tab lands on Today
  for (const t of TABS) $(t).hidden = !signedIn || tab !== t;
  $("review").hidden = !(signedIn && reviewing);
  $("back").hidden = !deep;
  $("account").hidden = !signedIn || deep;
  $("account").textContent = (user?.email || "?")[0].toUpperCase();
  $("bar-title").textContent = !signedIn ? "Sidebrain" : tab === "study" ? screenTitle(top()) : { today: "Today", inbox: "Inbox", train: train.title() }[tab];
  $("tabs").querySelector('[data-tab="train"]').hidden = !trainOn;
  $("tabs").style.setProperty("--n", trainOn ? 4 : 3);
  $("tabs").style.setProperty("--i", TABS.indexOf(tab));
  for (const b of $("tabs").querySelectorAll("button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (signedIn && loaded) navigator.setAppBadge?.(due(cards, today).length).catch(() => {});
  $("read-all").hidden = true; // renderInbox shows it on the Inbox while something is unread
  if (signedIn) { renderToday(today); renderStudy(today); renderReview(today); renderCaptures(); renderInbox(); renderSheet(); if (trainOn) train.render(); }
  if (signedIn && $("item-sheet").open) renderItem();
  if (signedIn && $("nexi-sheet").open) renderNexi();
  $("ask").hidden = !signedIn || tab !== "today" || reviewing;
  // The day sheet lives on Today only, under the hero; the tab bar's scroll edge then fades into the sheet's colour.
  const day = signedIn && tab === "today" && !reviewing && todaySheet;
  $("day").hidden = $("scrim").hidden = !day;
  root.classList.toggle("on-today", day);
  if (day) daySheet.layout(); else daySheet.focusable();
  $("contents").hidden = !pushed || !screenSections.length;
  $("more").hidden = !pushed || !screenMore;
  root.classList.toggle("pushed", deep);
  if ($("contents").hidden && menuFor === "contents" || $("more").hidden && menuFor === "more") setMenu(null, true);
  updateSection();
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
  map: svg(`<path d="M3.75 6.25l5.25-2 6 2 5.25-2v13.5l-5.25 2-6-2-5.25 2zM9 4.25v13.5M15 6.25v13.5"/>`),
  list: svg(`<path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/>`),
  open: svg(`<path d="M9.5 6.25h8.25v8.25M17.5 6.5L6.25 17.75"/>`),
  cards: svg(`<rect x="3.75" y="7.25" width="13.5" height="12.5" rx="2.25"/><path d="M7.25 4.25h10.75a2.25 2.25 0 0 1 2.25 2.25v9.75"/>`),
  note: svg(`<path d="M5.25 4.75h13.5v9.5l-4.5 4.5h-9z"/><path d="M14.25 18.75v-4.5h4.5M8.5 9h7M8.5 12.5h4"/>`),
  pin: svg(`<path d="M12 21s-6.25-5.4-6.25-10.5a6.25 6.25 0 0 1 12.5 0C18.25 15.6 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.25"/>`),
  contrast: svg(`<circle cx="12" cy="12" r="8.25"/><path d="M12 3.75a8.25 8.25 0 0 1 0 16.5z" fill="currentColor" stroke="none"/>`),
  mail: svg(`<rect x="3.25" y="5.25" width="17.5" height="13.5" rx="2.5"/><path d="M3.75 7.25l8.25 6 8.25-6"/>`),
  bubble: svg(`<path d="M12 4.25c4.56 0 8.25 3.13 8.25 7s-3.69 7-8.25 7c-1.1 0-2.15-.18-3.1-.52L4.75 19.5l1.2-3.6c-1.4-1.3-2.2-2.9-2.2-4.65 0-3.87 3.69-7 8.25-7z"/>`),
  tray: svg(`<path d="M3.75 13.25l2.6-7.1a1.5 1.5 0 0 1 1.4-.9h8.5a1.5 1.5 0 0 1 1.4.9l2.6 7.1v4.5a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5zM3.75 13.25H8.5l1 2h5l1-2h4.75"/>`),
  dumbbell: svg(`<path d="M3.25 9.5v5M6.25 7v10M17.75 7v10M20.75 9.5v5M6.25 12h11.5"/>`),
  tickMark: `<svg class="check-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4.25 4.25L18.5 7.5"/></svg>`,
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
const head = (title, sub = "") => `<h1 class="large${String(title).length > 60 ? " long" : ""}">${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}`;
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
const dayName = (day, today = todayString()) => (day === today ? "Today" : day === addDays(today, 1) ? "Tomorrow" : shortDay(day) + (day.slice(0, 4) !== today.slice(0, 4) ? " " + day.slice(0, 4) : ""));
const nextMonday = (today) => parseWhen("next week", today).date;
const norm = (t) => String(t ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const notices = () => [syncError && `<p class="foot warn">${esc(syncError)}</p>`, routeNote && `<p class="foot warn">${esc(routeNote)}</p>`, cloud && `<p class="foot">${esc(cloud)}</p>`].filter(Boolean).join("");

// ---------- Today: the hero ("what now?"), the priority line, and the rest of the day in the day sheet ----------

let todaySheet = false; // the day sheet shows only when Today has content (not while loading, not on the empty state)

function renderToday(today) {
  todaySheet = false;
  if (!loaded) return paint($("today"), head("Today", longDate()) + notices() + SKELETON);
  const now = Date.now(), at = new Date(now);
  const ts = trainState(), top = head("Today", longDate()) + notices() + checkinHtml(at, ts);
  const rugbyLine = trainOn ? RUGBY_LINE[rugbyOn(daily, today)] : null;
  sugRows = tab === "today" ? suggestNow(at, ts) : [];
  const sched = daySchedule(events, at, 0, true);
  const p = brief?.date?.slice(0, 10) === today && typeof brief.data?.priority?.title === "string" && brief.data.priority.title ? brief.data.priority : null; // only today's brief, as on the Mac
  // The priority, when it is one of the tasks, gets that task's tick, and the task leaves To do.
  const pTask = p && tasks.find((t) => !t.user_data?.dismissed && norm(t.data?.title ?? t.title) === norm(p.title));
  const cardsDue = due(cards, today).length;
  // Held rows (just ticked, or leaving) stay in the list until they fold away.
  const list = tasks.map((t) => { const h = held.get(t.id);
    return !h ? t : { ...t, user_data: h.kind === "moved" ? h.prev : { ...t.user_data, done: false, dismissed: false } }; });
  // ...and so does a deadline of the priority's module on the priority's due day ("Outline to tutor" under "Outline the CRG essay").
  const pModules = !p ? [] : [p.module, ...modules.filter((m) => [m.data?.short, moduleName(m)].some((n) => n && new RegExp(`(^|\\W)${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`, "i").test(p.title))).map(moduleName)].filter(Boolean);
  const pDay = typeof p?.due === "string" ? p.due.slice(0, 10) : null;
  const all = dueSoon(list, assessments, applications, today), swallowed = (r) => r.id === pTask?.id || (p && !pTask && norm(r.title) === norm(p.title))
    || ((r.kind === "assessment" || r.kind === "milestone") && r.date === pDay && pModules.includes(r.module));
  const rows = all.filter((r) => !swallowed(r));
  // What the priority stands for, so a ping's item: link finds it there (a milestone answers to its assessment's id).
  const pItems = [pTask?.id, ...all.filter(swallowed).map((r) => itemId(r.id))].filter(Boolean);
  const slipped = rows.filter((r) => r.slipped), toDo = rows.filter((r) => !r.slipped && (r.days == null || r.days === 0));
  const lastDay = localDay(weekEnd(at).getTime());
  const weekDue = rows.filter((r) => r.days >= 1 && r.date.slice(0, 10) <= lastDay);
  const later = runway(assessments.filter((a) => !gone(a)), today);
  const hero = heroEvent(events, at);
  const hasDay = rugbyLine || sched.allDay.length || sched.past.length || sched.now.length || sched.next.length;
  const foot = `<p class="${hasDay || rows.length || cardsDue ? "day-foot" : "foot mt-28"}" id="today-foot"></p>`;

  if (!hero && !hasDay && !p && !cardsDue && !rows.length && !later.length && !sugRows.length) {
    paint($("today"), top + empty(ICON.sun, "Nothing due", "Deadlines, classes and to-dos show up here.",
      `<button class="btn secondary" type="button" data-act="add">Add a to-do</button>${foot}`).replace('class="empty"', 'class="empty fill"'));
    return updateFoot();
  }
  todaySheet = true;
  const briefAt = new Map([...noteById.values()].filter((n) => n.data?.kind === "pre" && Date.parse(n.data?.classAt)).map((n) => [Date.parse(n.data.classAt), n]));
  paint($("today"), top + heroHtml(hero, briefAt, at) + prioHtml(p, pTask, today, now, pItems));

  // The day sheet: To do (today and undated, at most five, More and Slipped folded), then one timeline.
  const room = 5 - (slipped.length ? 1 : 0), shown = toDo.length <= room ? toDo : toDo.slice(0, room - 1), rest = toDo.slice(shown.length);
  const todo = shown.map((r) => dueRow(r, now));
  if (cardsDue) todo.push(row({ tag: "button", attrs: `data-act="review"`, lead: ICON.cards, title: "Flashcards", trail: `${count(cardsDue)} due`, chev: true }));
  if (rest.length) todo.push(fold("more", "More today", rest.length, rest.map((r) => dueRow(r, now)).join(""), "ticks"));
  if (slipped.length) todo.push(fold("slipped", "Slipped", slipped.length, slipped.map((r) => dueRow(r, now)).join(""), "ticks"));

  const time = (t) => `<span class="time">${esc(t)}</span>`;
  const event = (e, cls = "") => { const b = briefAt.get(e.start.getTime()), gym = !b && gymHook() && GYM.test(e.title);
    return row({ tag: b || gym ? "button" : "div", attrs: `data-item="${esc(e.id)}"${b ? ` data-open="note:${esc(b.id)}"` : gym ? ` data-act="gym"` : ""}`, lead: time(e.time), title: esc(e.title),
      sub: esc([b && briefLabel(b), place(e.location)].filter(Boolean).join(" · ")), chev: !!b || gym }).replace("<li>", `<li class="${cls}">`); };
  const tl = [];
  // K7: the check-in's answer is its own all-day line; tapping it clears the answer and asks again.
  if (rugbyLine) tl.push(row({ tag: "button", attrs: `data-act="rugby-clear" aria-label="${esc(rugbyLine)}. Change the answer"`, lead: time("All day"), title: esc(rugbyLine), titleCls: "one" }));
  if (sched.allDay.length) tl.push(row({ lead: time("All day"), title: esc(sched.allDay.join(", ")), titleCls: "one" }));
  if (sched.past.length) tl.push(fold("earlier", `${sched.past.length} earlier`, null, sched.past.map((e) => event(e, "past")).join(""), "tl"));
  for (const e of sched.now) tl.push(event(e, "now"));
  if (hasDay) tl.push(`<li class="nowline" aria-label="Now, ${clock(at)}"><time>${clock(at)}</time><i></i></li>`);
  sched.next.forEach((e, i) => tl.push(event(e, i === 0 && !sched.now.length ? "next" : "")));
  if (!sched.now.length && !sched.next.length) tl.push(row({ lead: time(""), title: "Nothing else today", cls: "quiet" }));
  // Rest of the week, to Sunday: classes (with their briefs) and what falls due, by day.
  const week = [
    ...upNext({ events, notes: [...noteById.values()] }, at).filter((r) => r.kind === "class" && r.day > today)
      .map((r) => ({ day: r.day, at: r.at, html: row({ tag: r.open ? "button" : "div", attrs: `data-item="${esc(r.id)}"${r.open ? ` data-open="${esc(r.open)}"` : ""}`,
        lead: time(r.time), title: esc(r.title), sub: esc(r.sub.split(" · ").map(place).join(" · ")), chev: !!r.open }) })),
    ...weekDue.map((r) => ({ day: r.date.slice(0, 10), at: r.time ? Date.parse(`${r.date.slice(0, 10)}T${r.time}`) : -Infinity,
      html: row({ tag: r.kind === "task" ? "button" : "div", attrs: r.kind === "task" ? `data-task="${esc(r.id)}" data-item="${esc(r.id)}"` : `data-item="${esc(itemId(r.id))}"`,
        lead: time(r.time ?? (r.kind === "task" ? "" : "Due")), title: esc(r.title), sub: r.kind === "task" ? "" : esc(shorten(r.detail)) }) })),
  ].sort((a, b) => cmpDay(a.day, b.day) || a.at - b.at);
  if (week.length) {
    let body = "", last = "";
    for (const w of week) { if (w.day !== last) { body += `<li class="dayhead">${esc(dayName(w.day, today))}</li>`; last = w.day; } body += w.html; }
    tl.push(fold("week", "Rest of the week", week.length, body, "tl"));
  }
  const big = later[0];
  paint($("day-scroll"), `${sugRows.length ? `<p class="caption-h">Suggestions</p><ul class="list sugs">${sugRows.map(sugRow).join("")}</ul>` : ""}
    <p class="caption-h">To do</p>
    ${todo.length ? `<ul class="list ticks">${todo.join("")}</ul>` : `<p class="foot empty-line">Nothing due today.</p>`}
    <p class="caption-h">Today</p><ul class="list tl">${tl.join("")}</ul>
    ${big ? `<p class="day-foot" data-item="${esc(big.id)}">Next big deadline: ${esc(big.title)} in ${esc(big.left)}</p>` : ""}${foot}`);
  const open = toDo.concat(slipped).filter((r) => !(held.get(r.id)?.kind === "done")).length + (cardsDue ? 1 : 0);
  $("day-sum-text").textContent = `${sugRows.length ? `${plural(sugRows.length, "suggestion")} · ` : ""}${open ? `${count(open)} to do` : "Nothing to do"} · ${sched.next.length ? `${count(sched.next.length)} more today` : "Nothing else today"}`;
  updateFoot();
}
const cmpDay = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const count = (n) => n.toLocaleString("en-GB"); // "1,284"
/** A milestone's id is "<assessment id>#<date><label>"; a link to it names the assessment. */
const itemId = (id) => String(id).split("#")[0];
/** A meeting link as a place: "Teams", "Zoom" or the host, so a URL never fills the line. */
const place = (s) => { if (!/^https?:\/\//i.test(s ?? "")) return s ?? "";
  try { const h = new URL(s).hostname; return /teams\./.test(h) ? "Teams" : /zoom\./.test(h) ? "Zoom" : h.replace(/^www\./, ""); } catch { return "Online"; } };
/** Train's hook for a gym event (train.openToday lands from the Train branch; until then the Train tab opens). */
const GYM = /\bgym\b/i;
const gymHook = () => trainOn && rugbyOn(daily, todayString()) !== "match"; // a match day: nothing in the gym (K3 table)

// ---------- The morning check-in (K1–K9) and Suggestions (G1–G11): the rules are in nudges.js ----------

function checkinHtml(at, ts) {
  if (!dailyReady || !showCheckin({ now: at, on: ts.on, profile: ts.profile, daily })) return "";
  const btn = (v, label) => `<button class="btn secondary" type="button" data-act="rugby" data-v="${v}">${label}</button>`;
  const two = checkinStep === 2;
  // One line (the question, with the caption or Back at its end) over the answers: the same height for both questions.
  return `<section class="checkin" aria-label="Check-in"><div class="qrow"><h2 class="q" id="checkin-q">${two ? "What is rugby doing?" : "Rugby today?"}</h2>${two
      ? `<button class="link back-q" type="button" data-act="rugby" data-v="back">Back</button>` : `<p class="cap">Check-in</p>`}</div>
    <div class="answers" role="group" aria-labelledby="checkin-q" style="--n: ${two ? 3 : 2}">${two ? btn("training", "Training") + btn("match", "Match") + btn("rest", "Rest") : btn("yes", "Yes") + btn("no", "No")}</div></section>`;
}
function answer(v) {
  if (v === "yes" || v === "back") { checkinStep = v === "yes" ? 2 : 1; render(); return $("today").querySelector(".checkin [data-v]:not(.back-q)")?.focus({ preventScroll: true }); }
  checkinStep = 1;
  dailyWrite({ rugby: v, answeredAt: Date.now() });
  render();
}

/** G1–G5 for now; records today's shown list the first time a key appears (G3). */
function suggestNow(at, ts) {
  if (!user || !dailyReady) return [];
  const { rows, shown } = suggestions({ now: at, prefsOn: sugOn, daily, pings, train: ts, assessments, applications, cards, events, modules,
                                        notes: [...noteById.values()], lectures });
  if (shown) dailyWrite({ shown });
  return rows;
}
const SUG_GLYPH = { app: "briefcase", ms: "cap", start: "cap", cards: "cards", read: "doc", missed: "dumbbell", "train-today": "dumbbell", food: "dumbbell" };
function sugRow(c) {
  const k = esc(c.key);
  return `<li class="sug"><button class="row" type="button" data-act="sug" data-key="${k}">${ICON[SUG_GLYPH[c.key.split(":")[0]]]}<span class="text"><span class="title clamp">${esc(c.title)}</span><span class="subtitle">${esc(c.sub)}</span></span></button>${
    c.started ? `<button class="btn secondary small" type="button" data-act="sug-started" data-key="${k}" aria-label="Started: ${esc(c.title)}">Started</button>` : ""}<button class="circle" type="button" data-act="sug-more" data-key="${k}" aria-label="More: ${esc(c.title)}">${ICON.more}</button></li>`;
}
/** G6: the key goes into acted, then its target opens. */
function sugAct(key, started = false) {
  const c = sugRows.find((x) => x.key === key), today = todayString();
  if (!c) return;
  dailyWrite({ acted: [...(dailyOf(daily, today)?.user_data?.acted ?? []), key] });
  if (started) {
    const a = assessments.find((x) => x.id === c.started);
    if (a) writeUser(a, { startedAt: Date.now() }, "edit");
    toast("Marked as started");
    return render();
  }
  render();
  if (!openTarget(c.open)) tell("That isn’t on this phone yet. It arrives with the next sync from the Mac.");
}
/** G5: Snooze 3 days or Dismiss 7, from the More sheet. */
function sugMute(kind) {
  const today = todayString(), key = sugKey, was = dailyOf(daily, today)?.user_data?.muted ?? {};
  closeSheet($("sug-sheet"));
  if (!key) return;
  dailyWrite({ muted: { ...was, [key]: muteUntil(today, kind) } });
  render();
  toast(kind === "snooze" ? "Snoozed for 3 days" : "Dismissed for 7 days", () => { dailyWrite({ muted: was }); render(); });
}

/** What now: the event on now (with a progress track), else the next one today, else the next day's first; one prep action. */
function heroHtml(e, briefAt, at) {
  if (!e) return `<section class="hero" aria-label="What now"><div class="hgrid"><p class="k">Today</p><span></span><h2>No more events today</h2></div></section>`;
  const f = heroFigure(e, at), b = briefAt.get(e.start.getTime());
  const cls = e.state === "now" ? classNow(events, modules, lectures, at) : null;
  const where = place(e.location), url = where !== (e.location ?? "") && /^https:\/\//i.test(e.location);
  const action = gymHook() && GYM.test(e.title) ? `<button class="btn secondary small act" type="button" data-act="gym">${ICON.dumbbell}Open Train</button>`
    : cls ? `<button class="btn secondary small act" type="button" data-act="note-class" data-m="${esc(cls.module)}" data-l="${esc(cls.lecture ?? "")}">${ICON.note}Note for this class</button>`
    : b ? `<button class="btn secondary small act" type="button" data-open="note:${esc(b.id)}">${ICON.doc}${esc(Number(b.data?.minutes) > 0 ? `Brief · ${prep(b.data.minutes)}` : "Brief")}</button>`
    : url ? `<a class="btn secondary small act" href="${esc(e.location)}" target="_blank" rel="noopener noreferrer">${ICON.open}Join</a>`
    : where ? `<a class="btn secondary small act" href="https://maps.apple.com/?q=${encodeURIComponent(where)}" target="_blank" rel="noopener noreferrer">${ICON.pin}Directions</a>` : "";
  // A countdown in hours needs the width: the right caption joins the left one and the title takes its own row.
  const wide = / h\b/.test(f.fig);
  const progress = e.state === "now" && e.end ? Math.min(1, Math.max(0, (at - e.start) / (e.end - e.start))) : null;
  return `<section class="hero" aria-label="What now">
    <div class="hgrid${wide ? " wide" : ""}"><p class="k">${esc(wide ? `${f.label} · ${f.k.toLowerCase()}` : f.label)}</p>${wide ? "" : `<p class="k r">${esc(f.k)}</p>`}
      <h2${e.title.length > 24 ? ` class="long"` : ""}>${esc(e.title)}</h2><b class="fig">${esc(f.fig)}</b>
      ${where || f.range ? `<p class="where">${esc(where)}</p><span class="range">${esc(f.range)}</span>` : ""}</div>
    ${progress != null ? `<div class="track" role="progressbar" aria-label="Time through" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress * 100)}"><time>${clock(e.start)}</time><span class="rail"><i style="transform:scaleX(${progress.toFixed(3)})"></i></span><time>${clock(e.end)}</time></div>` : ""}
    ${action}
  </section>`;
}

/** The priority: one line with its tick (when it is one of the tasks), its due day in the caption, the why clamped to 2 lines. */
function prioHtml(p, pTask, today, now, items = []) {
  if (!p) return "";
  const why = typeof p.why === "string" ? withoutGreeting(p.why) : "";
  const day = typeof p.due === "string" && /^\d{4}-\d{2}-\d{2}/.test(p.due) ? p.due.slice(0, 10) : null, days = day ? daysBetween(today, day) : null;
  const h = pTask && held.get(pTask.id), done = !!pTask && (h?.kind === "done" || pTask.user_data?.done === true);
  const when = days == null ? "" : days < 0 ? `was due ${shortDay(day)}` : `due ${days <= 1 ? dayName(day, today).toLowerCase() : shortDay(day)}`;
  const text = `<span class="text"><span class="title">${esc(p.title)}</span>${why ? `<span class="why">${esc(why)}</span>` : ""}</span>`;
  return `<section class="prio" aria-label="Priority"${items.length ? ` data-item="${esc(items.join(" "))}"` : ""}><p class="cap">Priority${when ? ` · <span class="${days < 0 && !done ? "warn" : ""}">${esc(when)}</span>` : ""}</p>
    <div class="prio-line${done ? " done" : ""}${h && now - h.at < 450 ? " just" : ""}">${pTask
      ? `${tickButton(pTask.id, p.title, done)}<button class="row" type="button" data-task="${esc(pTask.id)}">${text}</button>` : `<div class="row">${text}</div>`}</div></section>`;
}

/** A fold in the day sheet: its DOM stays, so opening animates (grid rows, 240 ms) and the open ones survive redraws. */
const dayFolds = new Set();
function fold(key, label, n, body, listCls = "") {
  const open = dayFolds.has(key);
  return `<li class="fold${open ? " open" : ""}" data-fold="${key}"><button class="row fold-row" type="button" aria-expanded="${open}" data-act="fold"><span class="text"><span class="title">${esc(label)}${n != null ? ` · <span class="count">${count(n)}</span>` : ""}</span></span>${ICON.chev}</button>
    <div class="fold-body"${open ? "" : " inert"}><div><ul class="list ${listCls}">${body}</ul></div></div></li>`;
}
function toggleFold(li, open = !li.classList.contains("open")) {
  dayFolds[open ? "add" : "delete"](li.dataset.fold);
  li.classList.toggle("open", open);
  li.querySelector(":scope > .fold-row").setAttribute("aria-expanded", String(open));
  li.querySelector(":scope > .fold-body").toggleAttribute("inert", !open);
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

/** A To do row. Tasks get a tick and open the task sheet; a slipped date is the only warning colour; a timed task shows its
 *  time. Only rows with a module or a role carry a subtitle. */
function dueRow(r, now) {
  const label = r.slipped ? shortDay(r.date) : r.time ?? "", sub = r.kind === "task" ? "" : shorten(r.detail);
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

/** The + sheet's Note: a "For SM L3 · Change" chip over the field (the class on now, or the one picked; Change lists today's
 *  classes and No class), and the recent captures under it. */
let classPick = false; // the Change list is open
const classLabel = (c) => c.label ?? [short(c.module), c.lecture].filter(Boolean).join(" ");
function todaysClasses() {
  const today = todayString(), seen = new Set();
  // A class is an event classNow recognises at its own start time; one per module and lecture.
  return events.filter((e) => localDay(Date.parse(e.data?.start) || 0) === today && !gone(e))
    .sort((a, b) => Date.parse(a.data.start) - Date.parse(b.data.start))
    .map((e) => { const at = new Date(Date.parse(e.data.start) + 6e4), c = classNow(events, modules, lectures, at); return c && { ...c, time: clock(new Date(Date.parse(e.data.start))) }; })
    .filter((c) => c && !seen.has(c.module + "|" + c.lecture) && seen.add(c.module + "|" + c.lecture));
}
function renderCaptures() {
  const caps = captureList(), on = captureFor ?? classNow(events, modules, lectures), list = todaysClasses();
  if (on && !list.some((c) => c.module === on.module && c.lecture === on.lecture)) list.unshift(on); // "Note for this class" from a lecture page
  const form = $("add-sheet").querySelector("[data-compose=add]"), chip = form?.querySelector(".chips");
  if (chip) {
    chip.hidden = !list.length;
    paint(chip, `<button class="chip-btn" type="button" data-act="class-pick" aria-expanded="${classPick}"><span class="chip${on ? " on" : ""}">${on ? `For ${esc(classLabel(on))}` : "No class"}</span><span class="link">Change</span></button>`);
    const pick = form.querySelector(".choices");
    pick.hidden = !classPick || !list.length;
    const same = (c) => !!on && c.module === on.module && c.lecture === on.lecture;
    paint(pick, [...list.map((c, i) => row({ tag: "button", attrs: `data-class="${i}"`, title: esc(classLabel(c)), trail: `${esc(c.time ?? "")}${same(c) ? ICON.tickMark : ""}` })),
      row({ tag: "button", attrs: `data-class="none"`, title: "No class", trail: on ? "" : ICON.tickMark })].join(""));
    pick._list = list;
  }
  paint($("capture-list"), caps.length ? `<p class="caption-h">Recent</p><ul class="group flat">${caps.slice(0, 3).map(captureRow).join("")}</ul>` : "");
}

/** The task sheet: Today, Tomorrow, Next week (the task's own day ticked and not tappable), Pick a date, Let go. */
function openTaskSheet(id) {
  const task = tasks.find((t) => t.id === id), r = task && dueSoon([task], [], [], todayString(), 3650)[0];
  if (!task) return;
  sheetTask = id;
  const today = todayString(), date = effectiveDate(task)?.slice(0, 10) ?? null;
  say("task-title", task.data?.title ?? task.title ?? "Task");
  say("task-detail", !date ? "No date" : r?.slipped ? "Was due " + shortDay(date) : priorityDueLabel({ date, days: daysBetween(today, date) }), !!r?.slipped);
  const opt = (day, glyph, label) => row({ tag: "button", attrs: day === date ? `disabled aria-current="date"` : `data-move="${day}"`, lead: glyph, title: label,
    trail: shortDay(day) }).replace("</button>", day === date ? `${ICON.tickMark}</button>` : "</button>");
  $("task-moves").innerHTML = [opt(today, ICON.sun, "Today"), opt(addDays(today, 1), ICON.sunrise, "Tomorrow"), opt(nextMonday(today), ICON.nextWeek, "Next week"),
    `<li><label class="row">${ICON.calendar}<span class="text"><span class="title">Pick a date</span></span>${ICON.chev}
      <input type="date" class="overlay" data-pick min="${today}" value="${date && date > today ? esc(date) : today}" aria-label="Pick a date"></label></li>`,
  ].join("");
  openSheet($("task-sheet"));
}

// ---------- Inbox: Priority messages on top, then every ping that has fired (contract §6); a tap opens the item sheet ----------

const PING_GLYPH = { moodle: "books", recording: "books", notes: "doc", brief: "doc", reask: "doc", readings: "doc", deadline: "clock", exam: "clock", application: "briefcase",
  email: "mail", nudge: "clock", room: "clock" };
const KIND = { brief: "Brief", nudge: "Class", reask: "Recall", readings: "Readings", deadline: "Deadline", exam: "Exam", application: "Application", moodle: "Moodle",
  recording: "Recording", notes: "Notes", room: "Class change", email: "Email", grade: "Grade", group: "Group work", event: "Event" };
const SERVICE_GLYPH = { gmail: "mail", outlook: "mail", whatsapp: "bubble", linkedin: "person" };

/** A Moodle ping from one sync carries `counts` per module (PingDetect.moodle, 17 Oct): more than one item reads as one
 *  batched row, "Moodle · 3 new" over "M&S, CRG". Anything else keeps its own title over its kind and module. */
function pingText(p) {
  const counts = p.data?.kind === "moodle" && p.data?.counts && typeof p.data.counts === "object" ? Object.entries(p.data.counts) : [];
  const n = counts.reduce((a, [, v]) => a + (Number(v) || 0), 0);
  return n > 1 ? { title: `Moodle · ${n} new`, sub: counts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m).join(", ") }
    : { title: p.title ?? "Notification", sub: [KIND[p.data?.kind], typeof p.data?.module === "string" && short(p.data.module)].filter(Boolean).join(" · ") };
}

/** What the Inbox holds: message conversations, and the pings still in it (less the email pings a message stands for). */
function inboxState(now = new Date()) {
  const folded = foldedPings(messages), box = inbox(pings.filter((p) => !folded.has(p.id)), now), convs = conversations(messages, now);
  const rows = box.rows.filter((p) => p.user_data?.done !== true), unseen = [...rows.filter((p) => !p.user_data?.seenAt), ...convs.filter((c) => !c.rows.at(-1).user_data?.seenAt).map((c) => c.rows.at(-1))];
  return { convs, rows, unseen, unread: box.unread + convs.filter((c) => !c.rows.at(-1).user_data?.seenAt).length };
}
/** A message thread: the conversation a row belongs to (oldest first), or just the row when it's done or snoozed. */
function threadOf(id) {
  const r = messages.find((x) => x.id === id);
  return r ? conversations(messages).find((c) => c.rows.includes(r))?.rows ?? [r] : null;
}

function renderInbox() {
  const { convs, rows, unseen, unread } = inboxState();
  $("inbox-badge").textContent = unread > 9 ? "9+" : String(unread);
  $("inbox-badge").hidden = !unread;
  $("tabs").querySelector('[data-tab="inbox"]').setAttribute("aria-label", unread ? `Inbox, ${unread} unread` : "Inbox");
  $("read-all").hidden = !(tab === "inbox" && unseen.length);
  const top = head("Inbox") + notices();
  if (!loaded) return paint($("inbox"), top + SKELETON);
  if (!rows.length && !convs.length) return paint($("inbox"), top + empty(ICON.tray, "Nothing new", "Briefs, deadlines, Moodle and priority messages land here.").replace('class="empty"', 'class="empty fill"'));
  // Swipe left = Done, right = Later; a tap opens the item sheet, which has both too (the VoiceOver path).
  const swipe = (id, fresh, glyph, title, sub, time) => `<li class="ping${fresh ? " unread" : ""}" data-swipe="${esc(id)}"><div class="swipe-bg" aria-hidden="true"><span class="l">Later</span><span class="r">Done</span></div>
    <div class="slide"><button class="row" type="button" data-ping="${esc(id)}" aria-label="${fresh ? "Unread. " : ""}${esc(title)}${sub ? ", " + esc(sub) : ""}, ${esc(time)}">${fresh ? `<i class="dot" aria-hidden="true"></i>` : ""}${glyph}<span class="text"><span class="title clamp">${esc(title)}</span>${sub ? `<span class="subtitle">${esc(sub)}</span>` : ""}</span><span class="trail">${esc(time)}</span></button></div></li>`;
  const today = todayString(), yesterday = addDays(today, -1), groups = new Map();
  if (convs.length) groups.set("Priority", convs.map(({ latest: m, rows: t }) => swipe(m.id, !t.at(-1).user_data?.seenAt, ICON[SERVICE_GLYPH[m.service.toLowerCase()]] ?? ICON.mail, m.sender,
    [m.service, m.subject || m.body.trim().split("\n")[0].slice(0, 120)].filter(Boolean).join(" · "), m.received ? when(m.received) : "")));
  for (const p of rows) {
    const at = fireAt(p), day = localDay(at.getTime()), g = day === today ? "Today" : day === yesterday ? "Yesterday" : "Earlier", { title, sub } = pingText(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(swipe(p.id, !p.user_data?.seenAt, ICON[PING_GLYPH[p.data?.kind]] ?? ICON.bell, title, sub, day === today || day === yesterday ? clock(at) : shortDay(day)));
  }
  paint($("inbox"), top + [...groups].map(([g, html]) => `<p class="caption-h" role="heading" aria-level="2">${g}</p><ul class="group inbox">${html.join("")}</ul>`).join(""));
}

const isoZ = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const dayClock = (d) => (localDay(d.getTime()) === todayString() ? clock(d) : `${dayName(localDay(d.getTime()))} ${clock(d)}`);
/** Later's choices: a ping's snoozes (1 h, 20:00, 08:00 tomorrow); a message's match the Mac's Snooze menu (+3 h, 08:00 tomorrow). */
function laterChoices(message, now = new Date()) {
  if (!message) return snoozeChoices(now);
  const morning = new Date(now); morning.setDate(morning.getDate() + 1); morning.setHours(8, 0, 0, 0);
  const later = new Date(now.getTime() + 3 * 36e5);
  return [...(localDay(later.getTime()) === localDay(now.getTime()) ? [["Later today", later]] : []), ["Tomorrow morning", morning]]; // after 21:00, only the morning
}

/** Done, or Later (the first choice, unless one was picked), then a 5 s Undo that puts user_data back as it was. A message
 *  is done or snoozed with its whole conversation. */
function triage(id, done, until = null) {
  const list = threadOf(id) ?? pings.filter((x) => x.id === id);
  if (!list.length) return;
  const later = until ?? laterChoices(messages.includes(list[0]))[0][1], was = list.map((x) => x.user_data ?? {});
  const keys = done ? ["done", "doneAt", "seenAt"] : ["snoozedUntil", "seenAt"];
  for (const x of list) writeUser(x, done ? { done: true, doneAt: Date.now(), seenAt: x.user_data?.seenAt ?? Date.now() } : { snoozedUntil: isoZ(later), seenAt: null }, "edit");
  render();
  toast(done ? "Marked done" : `Snoozed until ${dayClock(later)}`, () => {
    list.forEach((x, i) => writeUser(x, Object.fromEntries(keys.map((k) => [k, was[i][k] ?? (k === "done" ? false : null)])), "edit"));
    render();
  });
}

/** Marks everything unread in the Inbox seen, with Undo. */
function readAll() {
  const fresh = inboxState().unseen; // one per Inbox line (a chat's newest message stands for it)
  for (const x of fresh) writeUser(x, { seenAt: Date.now() }, "edit");
  render();
  toast(`${plural(fresh.length, "item")} marked read`, () => { for (const x of fresh) writeUser(x, { seenAt: null }, "edit"); render(); });
}

/** Inbox rows: 10 px of hysteresis, then a horizontal drag tracks 1:1 (vertical stays the page's scroll, touch-action pan-y).
 *  On release it commits past 40% of the width, or past 20% with a flick over .11 px/ms in the drag's direction (the lift
 *  counts, so a drag that pauses before it is not a flick); otherwise it snaps back. A row
 *  caught mid snap-back is picked up where it is. A tap opens the item sheet. One pointer at a time. */
function inboxGestures(root) {
  let g = null;
  const label = (li, x) => { // the Done / Later label rides 16 px off the slide's edge once 88 px are open
    const l = li.querySelector(x < 0 ? ".swipe-bg .r" : ".swipe-bg .l");
    if (l) l.style.transform = `translateX(${x < 0 ? Math.min(0, x + 88) : Math.max(0, x - 88)}px)`;
  };
  const reset = (li) => { delete li.dataset.dir; for (const l of li.querySelectorAll(".swipe-bg span")) l.style.transform = ""; };
  const place = (li, x) => { li.dataset.dir = x > 0 ? "r" : "l"; li.querySelector(".slide").style.transform = `translateX(${x}px)`; label(li, x); };
  root.addEventListener("pointerdown", (e) => {
    const li = e.target.closest("[data-swipe]");
    if (g || !li || e.button > 0 || li.dataset.leaving) return;
    const slide = li.querySelector(".slide"), at = new DOMMatrix(getComputedStyle(slide).transform).m41;
    slide.getAnimations().forEach((a) => a.cancel());
    g = { li, id: e.pointerId, x: e.clientX - at, y: e.clientY, on: Math.abs(at) > .5, hist: [[e.timeStamp, e.clientX]] };
    if (g.on) { place(li, at); try { li.setPointerCapture(e.pointerId); } catch { /* not capturable */ } }
  });
  addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }
      if (Math.abs(dx) < 10) return;
      g.on = true; g.x += Math.sign(dx) * 10; // no jump at the threshold
      try { g.li.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }
    g.hist.push([e.timeStamp, e.clientX]); while (g.hist.length > 2 && e.timeStamp - g.hist[0][0] > 100) g.hist.shift();
    place(g.li, e.clientX - g.x);
  });
  const up = (e) => {
    if (!g || e.pointerId !== g.id) return;
    g.hist.push([e.timeStamp, e.clientX]); while (g.hist.length > 2 && e.timeStamp - g.hist[0][0] > 100) g.hist.shift(); // the lift counts
    const { li, on, hist: h } = g, x = e.clientX - g.x, v = (h.at(-1)[1] - h[0][1]) / Math.max(1, h.at(-1)[0] - h[0][0]);
    g = null;
    if (!on) return;
    suppressClick = Date.now() + 350;
    const slide = li.querySelector(".slide"), w = slide.offsetWidth;
    const commit = e.type !== "pointercancel" && x !== 0 && (Math.abs(x) > w * .4 || (Math.abs(x) > w * .2 && Math.abs(v) > .11 && Math.sign(v) === Math.sign(x)));
    slide.style.transform = "";
    if (!commit) {
      if (still()) return reset(li);
      for (const l of li.querySelectorAll(".swipe-bg span")) l.style.transform = "";
      slide.animate([{ transform: `translateX(${x}px)` }, { transform: "none" }], { duration: 300, easing: DRAWER }).onfinish = () => reset(li);
      return;
    }
    const done = x < 0, id = li.dataset.swipe;
    li.dataset.leaving = "1";
    if (still()) return triage(id, done);
    slide.animate([{ transform: `translateX(${x}px)` }, { transform: `translateX(${done ? -w : w}px)` }], { duration: 180, easing: DRAWER, fill: "forwards" }).onfinish = () =>
      li.animate([{ height: li.offsetHeight + "px" }, { height: 0 }], { duration: 220, easing: DRAWER, fill: "forwards" }).onfinish = () => triage(id, done);
  };
  addEventListener("pointerup", up); addEventListener("pointercancel", up);
}

/** Opening writes seenAt (with userAt, as every write does); Snooze clears it, so it comes back unread when it fires again (as on the Mac). */
function pingWrite(id, patch) {
  const p = pings.find((x) => x.id === id);
  if (!p) return null;
  writeUser(p, { ...(p.user_data?.seenAt ? {} : { seenAt: Date.now() }), ...patch }, "edit");
  return p;
}

// ---------- The item sheet: an Inbox row opened over the Inbox, never a jump to another tab (Ricky, 20 Oct) ----------
// A brief inline with Listen, a deadline with its milestones, a Moodle batch's links, a note's summary, or a message with
// a draft reply to copy. Done and Later sit at the bottom; Open in Study is the secondary way out.

let sheetItem = null, laterOpen = false, itemAsk = null, copied = null;
const replies = new Map();   // message id → the draft reply on screen (this session only, never synced)
const drafting = new Map();  // message id → true while drafting, else the error to show
const materials = new Map(); // Moodle ping id → its materials, null while loading, false when they couldn't load
let how = "";                // "How should it sound?" for the next Redraft

/** Opens an Inbox row (or an email ping's message). False when it isn't on this phone. */
function openItem(id) {
  const fold = messages.find((m) => m.data?.ping === id);
  if (fold) { pingWrite(id, {}); id = fold.id; }
  const p = pings.find((x) => x.id === id), list = !p && threadOf(id);
  if (!p && !list) return false;
  sheetItem = p ? id : list.at(-1).id; laterOpen = false; copied = null;
  if (p) {
    pingWrite(id, {});
    const t = String(p.data?.open ?? "");
    if (/^(note|listen|reask):/.test(t)) foldsFor(t.slice(t.indexOf(":") + 1)).reask = t.startsWith("reask:");
  } else for (const r of list) if (!r.user_data?.seenAt) writeUser(r, { seenAt: Date.now() }, "edit");
  render();
  renderItem();
  openSheet($("item-sheet"));
  $("item-sheet").scrollTop = 0;
  return true;
}

function renderItem() {
  const p = pings.find((x) => x.id === sheetItem), list = !p && threadOf(sheetItem);
  if (!p && !list) return closeSheet($("item-sheet")); // done or gone on another device
  const v = p ? pingView(p) : messageSheet(list);
  itemAsk = v.ask;
  say("item-title", v.title);
  say("item-meta", v.meta);
  const ask = v.ask ? `<button class="btn secondary small" type="button" data-act="ask-item">${ICON.bubble}Ask Nexi</button>` : "";
  if (paint($("item-body"), v.body + (v.links || ask ? `<div class="actions wrap">${v.links}${ask}</div>` : ""))) {
    const ta = $("draft-text"), hw = $("draft-how");
    if (ta) ta.value = replies.get(sheetItem) ?? messageView(list.at(-1)).draft;
    if (hw) hw.value = how;
  }
  paint($("item-foot"), `${laterOpen ? `<ul class="group later">${laterChoices(!p).map(([label, d]) =>
      row({ tag: "button", attrs: `data-later="${isoZ(d)}"`, lead: ICON.clock, title: label, trail: dayClock(d) })).join("")}</ul>` : ""}
    <div class="actions"><button class="btn secondary" type="button" data-act="item-later" aria-expanded="${laterOpen}">Later</button>
      <button class="btn ${p ? "primary" : "secondary"}" type="button" data-act="item-done">Done</button></div>`);
}

const studyButton = (target) => `<button class="btn secondary small" type="button" data-study="${esc(target)}">${ICON.books}Open in Study</button>`;
const linkButton = (href, label, glyph = ICON.open) => `<a class="btn secondary small" href="${esc(href)}"${/^https:/.test(href) ? ` target="_blank" rel="noopener noreferrer"` : ""}>${glyph}${esc(label)}</a>`;
const info = (rows) => `<ul class="group info">${rows.filter(Boolean).join("")}</ul>`;
const CHIPS = { note: ["Explain this", "Quiz me"], item: ["Explain this", "What first?"] };

/** A ping's sheet, by what it opens. */
function pingView(p) {
  const t = String(p.data?.open ?? ""), i = t.indexOf(":"), kind = i > 0 ? t.slice(0, i) : t, id = t.slice(i + 1), at = fireAt(p), { title, sub } = pingText(p);
  const v = { title, meta: [sub, at && when(at.getTime()) + (localDay(at.getTime()) === todayString() ? "" : ", " + clock(at))].filter(Boolean).join(" · "), body: "", links: "",
    ask: { key: `ping:${p.id}`, label: title, chips: CHIPS.item, context: () => `Notification: ${title}${sub ? ` (${sub})` : ""}` } };
  const today = todayString();
  if (["note", "listen", "reask"].includes(kind)) {
    const n = id === "next" ? nextBrief([...noteById.values()]) : noteById.get(id);
    if (n) {
      const isBrief = n.data?.kind === "pre", classAt = Date.parse(n.data?.classAt);
      if (isBrief) v.meta = [briefLabel(n), classAt && `Class ${dayClock(new Date(classAt)).replace(/^(Today|Tomorrow) /, (w) => w.toLowerCase())}`].filter(Boolean).join(" · ");
      v.body = isBrief ? noteHtml(n, []) : summaryHtml(n);
      v.links = studyButton(`note:${n.id}`);
      v.ask = noteAsk(n);
      return v;
    }
  }
  if (kind === "item") {
    const a = assessments.find((x) => x.id === id), ap = applications.find((x) => x.id === id), e = events.find((x) => x.id === id), tk = tasks.find((x) => x.id === id);
    if (a) {
      const due = typeof a.date === "string" ? a.date.slice(0, 10) : null, days = due ? daysBetween(today, due) : null;
      const ms = (Array.isArray(a.data?.milestones) ? a.data.milestones : []).filter((m) => typeof m?.date === "string" && m.label).sort((x, y) => cmpDay(x.date, y.date));
      v.body = info([row({ lead: ICON.clock, title: due ? `Due ${esc(dayName(due, today))}` : "No date yet", trail: days == null ? "" : days < 0 ? "Passed" : days === 0 ? "Today" : `in ${plural(days, "day")}` }),
        a.data?.weight && row({ lead: ICON.cap, title: esc(`${a.data.weight} of ${short(a.module) || "the module"}`) })])
        + (ms.length ? `<p class="caption-h">Milestones</p><ul class="group flat">${ms.map((m) => row({ title: esc(m.label), trail: esc(dayName(m.date.slice(0, 10), today)), cls: m.date.slice(0, 10) < today ? "past" : "" })).join("")}</ul>` : "");
      v.links = a.module ? studyButton(`module:${a.module}`) : "";
      v.ask.context = () => `Assessment: ${a.data?.title ?? a.title} (${a.module ?? ""}), due ${due ?? "no date"}, weight ${a.data?.weight ?? "unknown"}.\nMilestones: ${ms.map((m) => `${m.date.slice(0, 10)} ${m.label}`).join("; ") || "none"}\nToday: ${today}`;
    } else if (ap) {
      v.body = info([row({ lead: ICON.briefcase, title: esc([ap.data?.org, ap.data?.role].filter(Boolean).join(" · ") || ap.title || "Application"), sub: esc(ap.data?.stage ?? "") }),
        ap.date && row({ lead: ICON.clock, title: `Closes ${esc(dayName(ap.date.slice(0, 10), today))}` })]);
    } else if (e) {
      const s = new Date(e.data?.start), where = place(e.data?.location ?? "");
      v.body = info([row({ lead: ICON.clock, title: esc(e.data?.title ?? e.title ?? "Event"), sub: Number.isNaN(s.getTime()) ? "" : esc(dayClock(s)) }), where && row({ lead: ICON.pin, title: esc(where) })]);
      if (where && !/^https?:/i.test(e.data?.location ?? "")) v.links = linkButton(`https://maps.apple.com/?q=${encodeURIComponent(where)}`, "Directions", ICON.pin);
    } else if (tk) {
      const d = effectiveDate(tk)?.slice(0, 10);
      v.body = info([row({ lead: ICON.list, title: esc(tk.data?.title ?? tk.title ?? "Task"), sub: d ? esc(`Due ${dayName(d, today)}`) : "" })]);
    }
  }
  if (kind === "url" && /^https:\/\//i.test(id)) {
    const moodle = p.data?.kind === "moodle";
    if (moodle) { loadMaterials(p); v.body = materialsHtml(p); }
    const mail = p.data?.kind === "email" ? mailUrl(id) : null; // an email's link only when it's a known webmail host
    v.links = mail === "" ? "" : linkButton(mail ?? id, moodle ? "Open Moodle" : mail ? "Open in Gmail" : "Open");
  }
  if (kind === "lecture") {
    const lec = lectures.find((l) => l.id === id), { pre, post } = lec ? lectureNotes(lec, noteById) : {}, n = post ?? pre;
    if (n) { v.body = summaryHtml(n); v.ask = noteAsk(n); }
    if (lec) v.links = studyButton(`lecture:${id}`);
  }
  if (!v.body && !v.links) v.body = `<p class="foot">The rest isn’t on this phone yet. It arrives with the next sync from the Mac.</p>`;
  return v;
}

/** A lecture note's short version: the first section's opening paragraphs and its "In short", else the Markdown's first section. */
function summaryHtml(n) {
  const blocks = Array.isArray(n.data?.doc?.blocks) ? n.data.doc.blocks : [], h2 = blocks.findIndex((b) => b?.t === "h2"), end = blocks.findIndex((b, i) => i > h2 && b?.t === "h2");
  const pick = [...blocks.slice(h2 + 1, end < 0 ? undefined : end).filter((b) => b?.t === "p").slice(0, 2), ...blocks.filter((b) => b?.t === "inshort").slice(0, 1)];
  const body = typeof n.data?.body === "string" ? n.data.body.split(/\n(?=## )/).find((s) => s.trim()) ?? "" : "";
  const html = (pick.length ? lectureDoc({ version: 1, blocks: pick }, {}, []) : null) ?? (body.trim() ? markdown(body) : "");
  return playerHtml(n) + (html ? `<div class="prose tight">${html}</div>` : `<p class="foot">Nothing to summarise yet.</p>`);
}
const noteAsk = (n) => ({ key: `note:${n.id}`, label: docTitle(n) ?? n.title ?? "these notes", chips: CHIPS.note,
  context: () => `Notes: ${docTitle(n) ?? n.title ?? ""}\nModule: ${n.module ?? ""}\n\n${docText(n)}` });

/** The Moodle batch: materials that reached Supabase within 15 minutes of the ping (the sync that made it).
 *  ponytail: a time window, because the ping doesn't list its materials; PingDetect.moodle can add `items` if it ever misses. */
async function loadMaterials(p) {
  if (materials.has(p.id)) return;
  if (DEMO) return materials.set(p.id, demoMaterials());
  const at = Date.parse(p.data?.at);
  if (!sb || !at) return materials.set(p.id, false);
  materials.set(p.id, null);
  try {
    const rows = await run(items("material", "id,module,title,data,created_at").gte("created_at", new Date(at - 15 * 6e4).toISOString()).lte("created_at", new Date(at + 15 * 6e4).toISOString()).limit(40));
    materials.set(p.id, rows.filter((r) => r.data?.type !== "recording"));
  } catch { materials.set(p.id, false); }
  render();
}
function materialsHtml(p) {
  const list = materials.get(p.id);
  if (list === undefined || list === null) return `<p class="foot" role="status">Loading what’s new…</p>`;
  if (!list || !list.length) return `<p class="foot">The new files are on Moodle.</p>`;
  return `<ul class="group">${list.map((m) => { const url = typeof m.data?.url === "string" && /^https:\/\//i.test(m.data.url) ? m.data.url : null, files = Array.isArray(m.data?.files) ? m.data.files.length : 0;
    return row({ tag: url ? "a" : "div", attrs: url ? `href="${esc(url)}" target="_blank" rel="noopener noreferrer"` : "", lead: ICON.doc, title: esc(m.title ?? "Untitled"), titleCls: "clamp",
      sub: esc([short(m.module), m.data?.section, files && plural(files, "file")].filter(Boolean).join(" · ")), chev: !!url }); }).join("")}</ul>`;
}

/** A message thread: who, where, the text (plain, never HTML), and the reply draft to copy. There is no Send. */
function messageSheet(list) {
  const m = messageView(list.at(-1)), id = m.id, link = replyLink(m), state = drafting.get(id), has = replies.has(id) || !!m.draft;
  const texts = list.map(messageView).map((x) => `${list.length > 1 && x.received ? `<p class="foot">${esc(when(x.received))}</p>` : ""}<div class="msg-text">${plainHtml(x.body) || `<p class="foot">No text.</p>`}</div>`).join("");
  const open = link ? linkButton(link.href, link.label) : "";
  return {
    title: m.sender, meta: [m.service, m.received && when(m.received) + (localDay(m.received) === todayString() ? "" : ", " + clock(new Date(m.received)))].filter(Boolean).join(" · "),
    body: `<section class="msg">${m.subject ? `<p class="headline">${esc(m.subject)}</p>` : ""}${m.reason ? `<p class="foot">${esc(m.reason)}</p>` : ""}${texts}
        ${m.cut ? `<p class="foot">${esc(link?.label ?? "Open the app")} for the rest.</p>` : ""}</section>
      <p class="caption-h">Reply</p>
      ${has ? `<ul class="group flat"><li><textarea id="draft-text" class="draft" rows="6" aria-label="Draft reply"></textarea></li>
          <li class="how"><input id="draft-how" type="text" placeholder="How should it sound?" aria-label="How should it sound?" enterkeyhint="go" autocomplete="off">
            <button class="btn plain" type="button" data-act="draft"${state === true ? " disabled" : ""}>${state === true ? "Drafting…" : "Redraft"}</button></li></ul>
        <div class="btns"><button class="btn primary" type="button" data-act="copy-draft">${copied === id ? "Copied" : "Copy"}</button>${open.replace(" small", "")}</div>`
      : `<div class="btns"><button class="btn secondary" type="button" data-act="draft"${state === true ? " disabled" : ""}>${state === true ? "Drafting…" : "Draft reply"}</button>${open.replace(" small", "")}</div>`}
      ${typeof state === "string" ? `<p class="foot warn" role="alert">${esc(state)}</p>` : `<p class="foot">Sidebrain never sends. Copy it, then send it from ${esc(m.service)}.</p>`}`,
    links: "",
    ask: { key: `msg:${id}`, label: `${m.sender}’s message`, chips: CHIPS.item,
      context: () => `${m.service} message from ${m.sender}${m.received ? `, received ${new Date(m.received).toISOString()}` : ""}\nSubject: ${m.subject}\nWhy it's priority: ${m.reason}\n\n${threadBody(list)}` },
  };
}

async function draftReply() {
  const list = threadOf(sheetItem);
  if (!list || drafting.get(sheetItem) === true) return;
  const id = sheetItem, uid = user?.id, m = messageView(list.at(-1)), thread = { ...m, body: threadBody(list) };
  drafting.set(id, true); render();
  let text = "", error = "";
  try {
    text = answerText(DEMO ? await demoAnswer(demoDraft(thread)) : await ai(draftRequest(thread, how, firstName()), "drafts"));
    if (!text) error = "Nexi didn’t return a draft. Try again.";
  } catch (e) { error = e.message || "Couldn’t draft that. Try again."; }
  if (user?.id !== uid) return; // signed out meanwhile: the draft goes nowhere
  if (error) drafting.set(id, error); else { replies.set(id, text); drafting.delete(id); copied = null; }
  render();
}

async function copyDraft() {
  const ta = $("draft-text");
  if (!ta) return;
  try { await navigator.clipboard.writeText(ta.value); copied = sheetItem; }
  catch { ta.focus(); ta.select(); drafting.set(sheetItem, "Couldn’t copy. The text is selected: copy it from the menu."); }
  render();
  setTimeout(() => { if (copied) { copied = null; render(); } }, 2000);
}

// ---------- Nexi: Ask in context (Today, notes, any Inbox item) and a full chat from + (v2 design §6) ----------
// Through Sidebrain's own `ai` function and its per-user cap. Answers are plain text (plainHtml): no Markdown, links or images.

const firstName = () => user?.name || "the user";
const CHIP_ASK = { "Explain this": "Explain this simply.", "Quiz me": "Quiz me on this, one question at a time.", "What first?": "What should I do first?" };
const chats = new Map();      // context key → [{role, text}]; "chat" (the + chat) is kept on this phone, the rest for this session
const chatLog = (key) => { if (!chats.has(key)) chats.set(key, key === "chat" ? load("nexi-chat", []) : []); return chats.get(key); };
let nx = null, nxBusy = false, nxError = "", nxScroll = false; // nxScroll: a turn was added, so the log follows it once

/** POST to the `ai` function. ponytail: twin of train.js `call`; share one helper once the gym lane agrees. */
async function ai(body, task) {
  const t = (await sb?.auth.getSession())?.data?.session?.access_token;
  if (!t) throw new Error("Sign in to use Nexi.");
  const r = await fetch(`${SUPABASE_URL}/functions/v1/ai`, { method: "POST", body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${t}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json", "X-Sidebrain-Task": task } });
  const j = await r.json().catch(() => ({}));
  // The function's 403/503 copy points at the Mac's own-AI setting, which the phone doesn't have.
  if (!r.ok) throw new Error(String(j.error?.message ?? (typeof j.error === "string" ? j.error : "Couldn’t reach Nexi. Try again.")).replace(/\s*Choose your own AI in Settings[^.]*\./, ""));
  return j;
}

/** Today's facts for Nexi: now, what's left today, the week's classes, open to-dos, deadlines in 7 days, cards due, the priority. */
function todayContext() {
  const now = new Date(), today = todayString(), sched = daySchedule(events, now, 0, true), rows = dueSoon(tasks, assessments, applications, today);
  const p = brief?.date?.slice(0, 10) === today ? brief.data?.priority : null;
  const lines = [`Now: ${longDate()}, ${clock(now)}`,
    `Left today: ${[...sched.now, ...sched.next].slice(0, 8).map((e) => `${e.time} ${e.title}${e.location ? ` (${place(e.location)})` : ""}`).join("; ") || "nothing"}`,
    `This week: ${upNext({ events, notes: [...noteById.values()] }, now).filter((r) => r.kind === "class" && r.day > today).slice(0, 10).map((r) => `${shortDay(r.day)} ${r.time} ${r.title}`).join("; ") || "nothing"}`,
    `To do: ${rows.filter((r) => r.kind === "task").slice(0, 10).map((r) => r.title + (r.date ? ` (due ${r.date.slice(0, 10)})` : "")).join("; ") || "nothing"}`,
    `Deadlines in 7 days: ${rows.filter((r) => r.kind !== "task" && r.days != null && r.days <= 7).slice(0, 5).map((r) => `${r.title}, ${r.detail ?? ""} (${r.date.slice(0, 10)})`).join("; ") || "none"}`,
    `Flashcards due: ${due(cards, today).length}`, p?.title ? `Today's priority: ${p.title}${p.why ? `. ${withoutGreeting(p.why)}` : ""}` : ""];
  return lines.filter(Boolean).join("\n").slice(0, 3000);
}
const todayAsk = () => ({ key: "today", label: "your day", chips: ["What first?"], context: todayContext });
const chatAsk = () => ({ key: "chat", label: "", chips: [], context: todayContext });

function openNexi(ctx) {
  if (!ctx) return;
  nx = ctx; nxError = ""; nxScroll = true;
  renderNexi();
  openSheet($("nexi-sheet"));
  if (!ctx.chips.length) setTimeout(() => $("nexi-q").focus(), 60);
}

function renderNexi() {
  if (!nx) return;
  const log = chatLog(nx.key);
  say("nexi-about", nx.label ? `About ${nx.label}` : "Your day, notes and deadlines");
  paint($("nexi-log"), (log.length ? log.map((t) => `<div class="bubble${t.role === "user" ? " me" : ""}">${plainHtml(t.text)}</div>`).join("")
      : `<p class="foot nexi-hint">${nx.label ? "Ask anything about this." : "Ask about your day, notes or deadlines."} Nexi only reads: it can’t send or change anything.</p>`)
    + (nxBusy ? `<div class="bubble typing" role="status" aria-label="Nexi is thinking"><i></i><i></i><i></i></div>` : "")
    + (nxError ? `<p class="foot warn" role="alert">${esc(nxError)}</p>` : ""));
  paint($("nexi-chips"), log.length || nxBusy ? "" : nx.chips.map((c) => `<button class="chip-btn" type="button" data-chip="${esc(c)}"><span class="chip">${esc(c)}</span></button>`).join(""));
  $("nexi-send").disabled = nxBusy || !$("nexi-q").value.trim();
  if (nxScroll) { nxScroll = false; $("nexi-log").scrollTop = $("nexi-log").scrollHeight; }
}

/** One turn: the chip's label (or the typed text) shows; the answer arrives whole (no streaming through the proxy). */
async function askNexi(question, label = question) {
  if (!nx || nxBusy || !question.trim()) return;
  const ctx = nx, uid = user?.id, log = chatLog(ctx.key), history = log.slice();
  log.push({ role: "user", text: label });
  nxBusy = true; nxError = ""; nxScroll = true;
  renderNexi();
  let text = "", error = "";
  try {
    text = answerText(DEMO ? await demoAnswer(demoAsk(question, ctx)) : await ai(askRequest(history, ctx.context(), question, firstName()), "nexi"));
    if (!text) error = "Nexi didn’t answer. Try again.";
  } catch (e) { error = e.message || "Couldn’t reach Nexi. Try again."; }
  nxBusy = false;
  if (user?.id !== uid) return; // signed out meanwhile: nothing is kept or shown
  if (error) { log.pop(); nxError = error; if (label === question && !$("nexi-q").value) $("nexi-q").value = question; }
  else { log.push({ role: "assistant", text }); say("nexi-live", text); }
  if (ctx.key === "chat") keep("nexi-chat", log.slice(-20));
  nxScroll = true;
  if (nx === ctx) renderNexi();
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
  if (pendingPing && (pings.some((x) => x.id === pendingPing) || final)) {
    if (messages.some((m) => m.data?.ping === pendingPing)) { pending = null; openItem(pendingPing); } // an email: its message, with the draft
    else pingWrite(pendingPing, {});
    pendingPing = null;
  }
  if (!pending) return;
  if (openTarget(pending)) pending = null;
  else if (final) { pending = null; tell("That isn’t on this phone yet. It arrives with the next sync from the Mac."); }
}

/** Shows a target. False when what it points at isn't here. */
function openTarget(target) {
  const t = String(target ?? ""), at = t.indexOf(":"), kind = t.slice(0, at), id = t.slice(at + 1);
  if (t === "train") { if (!trainOn) return false; switchTab("train"); return true; } // the rest-over push and WHOOP's return
  if (t === "food" || kind === "food") { // ?open=food, ?open=food:photo|text|barcode; Food is part of Train, so off with it
    if (!trainOn) return false;
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    if (kind === "food") food.openLog(id); else food.open();
    return true;
  }
  // Shortcuts and the Action Button (?open=review, add:note): one press to the right place.
  if (t === "review") { openReview(); return true; }
  if (t === "add:note") { openAdd("note"); return true; }
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
    // Its own row on Today: the priority (which stands for its task and the deadlines it swallowed), a task's row, the
    // timeline or the week (the day sheet then opens full, its fold open), or the next-big-deadline line.
    const q = `[data-row="${CSS.escape(id)}"], [data-item~="${CSS.escape(id)}"]`, el = $("today").querySelector(q) ?? (todaySheet ? $("day").querySelector(q) : null);
    if (!el) { // in local data but not on Today: its module, or the task's own sheet
      const x = [...assessments, ...tasks, ...applications].find((r) => r.id === id);
      if (!x) return false;
      if (x.module) study([{ s: "module", m: x.module }]);
      else if (tasks.includes(x)) openTaskSheet(id);
      return true;
    }
    if (el.closest("#day")) {
      for (let f = el.closest(".fold"); f; f = f.parentElement.closest(".fold")) toggleFold(f, true);
      daySheet.go("full");
    }
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
  setMenu(null, true);
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
// A lecture note's spoken version (Listen on the Mac) is one script, kept in user_data.listen, played as "short".
const script = (n, version) => { const s = n.data?.audio?.[version]?.script ?? (version === "short" ? n.user_data?.listen?.script : null); return typeof s === "string" ? s.trim() : ""; };
const briefTitle = (n) => (Array.isArray(n.data?.doc?.blocks) ? n.data.doc.blocks : []).find((b) => b?.t === "h1" && b.text)?.text ?? n.title ?? "Brief";

function prefetch(path) {
  if (!path || blobs.has(path) || DEMO || !sb) return;
  blobs.set(path, null);
  sb.storage.from("audio").download(path.split("#")[0])
    .then(({ data, error }) => { if (error || !data) throw error; blobs.set(path, URL.createObjectURL(data)); })
    .catch(() => blobs.set(path, false)) // the phone's own voice reads it instead
    .finally(render);
}

/** Listen, one compact row under the title: ▶ · Listen · 7 min · Short/Full (only when both exist) · 1×. The length is
 *  the recording's once it has loaded, else the script read at 160 words a minute; "phone voice" when there's no recording. */
function playerHtml(n) {
  const version = player.id === n.id ? player.version : "short", path = recording(n, version);
  if (!path && !script(n, "short") && !script(n, "full")) return "";
  prefetch(path);
  const mine = player.id === n.id, file = path ? blobs.get(path) : false, waiting = file === null, on = mine && player.playing;
  const both = (recording(n, "short") || script(n, "short")) && (recording(n, "full") || script(n, "full"));
  const secs = mine && !player.speech && Number.isFinite(audio.duration) ? audio.duration : (script(n, version).match(/\S+/g)?.length ?? 0) / 160 * 60;
  const label = waiting ? "Loading" : mine && player.started && !on ? "Resume" : "Listen";
  const len = [secs && `${Math.max(1, Math.round(secs / 60))} min`, file === false && !both && "phone voice"].filter(Boolean).map((x) => ` · ${x}`).join("");
  return `<div class="listen" data-player="${esc(n.id)}">
    <button class="playb" type="button" data-play="${esc(n.id)}" aria-label="${on ? "Pause" : label}"${waiting ? " disabled" : ""}><i>${on ? ICON.pause : ICON.play}</i></button>
    <span class="what">${label}</span><span class="len">${len}</span>
    ${both ? `<div class="seg" role="tablist" aria-label="Which version" style="--n: 2; --i: ${version === "short" ? 0 : 1}"><span class="thumb" aria-hidden="true"></span>${[["short", "Short"], ["full", "Full"]]
      .map(([v, l]) => `<button type="button" role="tab" data-ver="${v}" aria-selected="${version === v}">${l}</button>`).join("")}</div>` : ""}
    <button class="rate" type="button" data-speed aria-label="Speed ${speed} times">${speed}×</button>
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

let captureFor = null; // {module, lecture}: the Add sheet's note goes to this class (a lecture's "Note for this class", or Change); false: No class

function openAdd(mode = "todo") {
  for (const el of $("add-sheet").querySelectorAll("[role=status]")) say(el, "");
  setMode(mode);
  renderCaptures(); // the chip says where this note goes now, not where the last one went
  openSheet($("add-sheet"));
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
  const p = todoParse = parseWhen(value, today, todoIgnore, new Date());
  if (p.date && todoManual) todoManual = null; // a date typed after picking one wins: the most recent choice counts
  $("todo-mirror").innerHTML = p.start < 0 ? esc(value)
    : `${esc(value.slice(0, p.start))}<mark>${esc(value.slice(p.start, p.end))}</mark>${esc(value.slice(p.end))}`;
  $("todo-mirror").scrollLeft = input.scrollLeft;
  const date = todoManual ?? p.date, past = !!date && date < today;
  say("todo-date-label", !date ? "None" : past ? `Past date · ${shortDay(date)}` : dayName(date, today), past);
  $("todo-date-label").classList.toggle("link", !!date && !past); // the parsed (or picked) date is state: the accent
  $("todo-date").value = date ?? ""; // no min here: a typed past date is allowed, and the form never validates it (novalidate)
  $("todo-save").disabled = !value.trim();
}

function resetTodo() {
  $("todo").value = ""; todoIgnore = new Set(); todoManual = null;
  updateTodo();
}

function saveTodo(e) {
  e.preventDefault();
  const p = todoParse ?? parseWhen($("todo").value, todayString(), todoIgnore, new Date());
  if (!p.title.trim()) return;
  const date = todoManual ?? p.date;
  addTask(p.title, date);
  resetTodo();
  // The sheet stays open for the next one, and says where this one went: a date past Due soon's week is off Today.
  say("todo-status", `Added ‘${p.title}’${date ? ` for ${dayName(date).replace(/^(Today|Tomorrow)$/, (w) => w.toLowerCase())}` : ""}`);
  clearTimeout(saveTodo.timer);
  saveTodo.timer = setTimeout(() => say("todo-status", ""), 4000);
  $("todo").focus();
}

/** The note composer (Capture tab and the Add sheet's Note): text, an optional photo, Save. */
const composer = () => `<div class="chips" hidden></div>
  <ul class="group flat choices" hidden></ul>
  <ul class="group flat">
    <li><textarea name="body" rows="5" placeholder="Note" aria-label="Note"></textarea></li>
    <li class="preview-li" hidden><div class="preview"><img alt="Photo to attach"></div></li>
    <li><label class="row photo"><input type="file" name="photo" accept="image/*" capture="environment" aria-label="Add photo">${ICON.camera}
      <span class="text"><span class="title link">Add photo</span></span></label></li>
    <li class="remove-li" hidden><button class="row" type="button" data-remove-photo>${ICON.xmark}<span class="text"><span class="title link">Remove photo</span></span></button></li>
  </ul>
  <button class="btn primary" type="submit" disabled>Save</button>
  <p class="foot" role="status"></p>
  <div id="capture-list"></div>`;
/** Save needs a note or a photo. */
const canSave = (form) => { form.querySelector("[type=submit]").disabled = !form.elements.body.value.trim() && !photos[form.dataset.compose]; };

// ---------- Review: full screen ----------

let reviewReturn = null; // where focus goes back to when the review closes
function openReview(module = null, lecture = null) {
  if (session.module !== module || session.lecture !== lecture || !current()) newSession(module, lecture);
  tabY.review = scrollY;
  reviewReturn = document.activeElement;
  reviewing = true;
  $("review").classList.remove("out");
  render();
}
/** Back down the way it came: 200 ms (the open is 280), then the page underneath. */
function closeReview() {
  const el = $("review");
  if (!reviewing || el.classList.contains("out")) return;
  const done = () => {
    el.classList.remove("out");
    reviewing = false;
    render();
    scrollTo(0, tabY.review ?? 0);
    const back = reviewReturn?.isConnected ? reviewReturn : $(tab).querySelector('[data-act="review"]') ?? $("tabs").querySelector("[aria-current]");
    back?.focus({ preventScroll: true });
  };
  if (still()) return done();
  el.classList.add("out");
  el.addEventListener("animationend", function end(e) { if (e.target === el) { el.removeEventListener("animationend", end); done(); } });
}

/** Again or Good, each with the interval it sets. Tap anywhere reveals; grading moves on at once (100 a day, so no motion). */
function renderReview(today) {
  if (!reviewing) return;
  const close = `<button class="circle" type="button" data-act="close-review" aria-label="Close">${ICON.close}</button>`;
  const card = current(), total = session.queue.length;
  const bar = (at) => `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${at}"><i style="transform: scaleX(${total ? (at / total).toFixed(3) : 1})"></i></div>`;
  if (!loaded || !card) {
    const done = new Set(session.queue.slice(0, session.index)).size, next = nextDue(cards, today), more = dueFor(session.module, session.lecture).length;
    const [again, , good] = session.grades;
    paint($("review"), `<div class="review-top">${close}</div>${bar(total)}
      ${done ? `<div class="empty rv-done">${ICON.check.replace('class="glyph"', "")}<h2>${num(done)} ${done === 1 ? "card" : "cards"}</h2><p>${num(good)} Good · ${num(again)} Again</p></div>`
        : empty(ICON.check, "Nothing due", next ? `Next cards due ${daysBetween(today, next) === 1 ? "tomorrow" : shortDay(next)}.` : "Every card is scheduled for later.")}
      <div class="review-bar">${more ? `<button class="btn secondary" type="button" data-act="review-more">Review ${num(Math.min(more, CAP))} more</button>` : ""}
        <button class="btn primary" type="button" data-act="close-review">Back to Study</button></div>`);
    return focusReview();
  }
  const where = [short(card.module), card.data?.lecture].filter(Boolean).join(" · ");
  const exam = examFor(card), after = (g) => intervalLabel(schedule(card.user_data ?? {}, g, exam, today).interval);
  paint($("review"), `<div class="review-top">${close}<p class="count">${num(session.index + 1)} of ${num(total)}</p></div>${bar(session.index)}
    <article class="flash" data-act="flip" aria-live="polite">
      <div class="qa">${where ? `<p class="foot">${esc(where)}</p>` : ""}<h2 class="front">${esc(card.data?.front ?? card.title ?? "")}</h2>
      ${session.flipped ? `<hr><p class="answer">${esc(card.data?.back ?? "")}</p>` : ""}</div>
    </article>
    <div class="review-bar">${session.flipped
      ? `<button class="grade" type="button" data-grade="0"><b>Again</b><small>${after(0)}</small></button><button class="grade good" type="button" data-grade="2"><b>Good</b><small>${after(2)}</small></button>`
      : `<button class="btn secondary" type="button" data-act="flip">Show answer</button>`}</div>`);
  focusReview();
}
/** Focus stays inside the review: on its main button, after every redraw. */
function focusReview() {
  if (!$("review").contains(document.activeElement)) ($("review").querySelector(".review-bar .good, .review-bar .primary") ?? $("review").querySelector(".review-bar button"))?.focus({ preventScroll: true });
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
  if (sc.s === "note") { const n = noteById.get(sc.id); return docTitle(n) ?? (n?.data?.kind === "map" ? "Module map" : "Notes"); }
  return "Study";
}

/** Push and pop: the page slides 32 px and fades in over 280 ms on the drawer curve; the bar and tab bar stay put. */
function navigate(dir, change) {
  change();
  if (!still()) $("main").animate([{ opacity: 0, transform: `translateX(${dir === "push" ? 32 : -32}px)` }, { opacity: 1, transform: "none" }], { duration: 280, easing: DRAWER });
}
function go(screen) {
  top().y = scrollY;
  setMenu(null, true);
  navigate("push", () => { stack.push(screen); render(); scrollTo(0, 0); });
}
function back(animate = true) {
  if (tab === "train") return train.back();
  if (stack.length < 2) return;
  setMenu(null, true);
  const pop = () => { stack.pop(); render(); scrollTo(0, top().y ?? 0); };
  animate ? navigate("pop", pop) : pop();
}

/** Edge swipe-back on Study's pushed screens (Focus prototype): a pointer down within 20 px of the left edge, 8 px of
 *  hysteresis, then the page follows 1:1 over the screen it came from (drawn underneath, 30% parallax, dimmed). It pops past
 *  35% of the width or at a flick over .3 px/ms, and snaps back otherwise. */
function edgeSwipe() {
  let s = null, under = null;
  const parentHtml = () => { // the screen underneath, drawn without touching what the bar shows for this one
    const keep = [screenSections, screenMore], html = screenHtml(stack.at(-2), todayString());
    [screenSections, screenMore] = keep;
    return html;
  };
  const fading = () => ["bar-title", "contents", "more"].map($); // the bar's title and right-hand circles fade as the page leaves
  const move = (dx) => {
    const f = Math.min(1, Math.max(0, dx) / innerWidth), x = dx < 0 ? -rubber(-dx, 80) : dx; // rubber-band past the start
    $("main").style.transform = `translate3d(${x}px,0,0)`;
    for (const el of fading()) el.style.opacity = (1 - f).toFixed(3);
    under.firstElementChild.style.transform = `translate3d(${(-30 + 30 * f).toFixed(2)}%,${-(stack.at(-2).y ?? 0)}px,0)`;
    under.style.setProperty("--dim", (1 - f).toFixed(3));
  };
  document.addEventListener("pointerdown", (e) => {
    if (s || e.clientX > 20 || e.button > 0 || tab !== "study" || stack.length < 2 || reviewing || document.querySelector("dialog[open]")) return;
    s = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, hist: [] };
  }, true);
  document.addEventListener("pointermove", (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > dx) { s = null; return; }
      if (dx < 8) return;
      s.on = true; s.x += 8;
      setMenu(null, true);
      under = Object.assign(document.createElement("div"), { className: "under", innerHTML: `<div><section class="page">${parentHtml()}</section></div>` });
      document.body.prepend(under);
      $("main").classList.add("swiping");
      document.documentElement.classList.remove("sec");
    }
    s.hist.push([e.timeStamp, e.clientX]); while (s.hist.length > 2 && e.timeStamp - s.hist[0][0] > 100) s.hist.shift();
    move(e.clientX - s.x);
  }, true);
  const up = (e) => {
    if (!s || e.pointerId !== s.id) return;
    const { on, hist: h } = s, dx = Math.max(0, e.clientX - s.x);
    s = null;
    if (!on) return;
    suppressClick = Date.now() + 350;
    const v = h.length > 1 ? (h.at(-1)[1] - h[0][1]) / Math.max(1, h.at(-1)[0] - h[0][0]) : 0;
    const commit = e.type !== "pointercancel" && (dx > innerWidth * .35 || v > .3), main = $("main"), u = under;
    under = null;
    const done = () => {
      main.classList.remove("swiping"); main.style.transform = ""; u.remove();
      for (const el of fading()) el.style.opacity = "";
      if (commit) { back(false); requestAnimationFrame(() => scrollTo(0, top().y ?? 0)); } // the parent's scroll, after the swipe's layout settles
      else updateSection();
    };
    if (still()) return done();
    const a = main.animate([{ transform: `translate3d(${dx}px,0,0)` }, { transform: `translate3d(${commit ? innerWidth : 0}px,0,0)` }], { duration: commit ? 200 : 240, easing: DRAWER, fill: "forwards" });
    u.firstElementChild.animate([{ transform: u.firstElementChild.style.transform }, { transform: `translate3d(${commit ? 0 : -30}%,${-(stack.at(-2).y ?? 0)}px,0)` }], { duration: commit ? 200 : 240, easing: DRAWER, fill: "forwards" });
    a.onfinish = () => { done(); a.cancel(); };
  };
  document.addEventListener("pointerup", up, true); document.addEventListener("pointercancel", up, true);
}

const screenHtml = (sc, today) => sc.s === "module" ? moduleScreen(sc.m, today) : sc.s === "lecture" ? lectureScreen(sc.id, today)
  : sc.s === "note" ? noteScreen(sc.id) : sc.s === "practice" ? practiceScreen(sc) : homeScreen(today);
function renderStudy(today) {
  const sc = top();
  screenSections = []; screenMore = null; // the lecture and note screens fill them
  const html = !loaded ? head("Study") + SKELETON : screenHtml(sc, today);
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
  if (n) html += `<button class="btn primary mt-20" type="button" data-act="review">${n > CAP ? `Review ${CAP} of ${num(n)}` : `Review ${plural(n, "card")}`}</button>`;
  if (practice.length) html += `<ul class="list bare${n ? " mt-12" : " mt-20"}">${row({ tag: "button", attrs: `data-practice=""`, lead: ICON.practice, title: "Practice",
    trail: open ? num(open) : "", chev: true })}</ul>`;
  if (!modules.length) return html + empty(ICON.books, "No modules yet", "Modules, lecture notes and flashcards arrive after the next lecture sync on the Mac.");
  const next = (name) => lectures.filter((l) => l.module === name && (lectureDay(l) ?? "").slice(0, 10) >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  const line = (m) => {
    const name = moduleName(m), l = next(name), d = dueFor(name).length;
    return [l ? `Next: ${l.data?.n ?? "class"} ${dayLabel(lectureDay(l))}` : m.data?.next ? `Next: ${String(m.data.next).split(" · ")[0]}` : "", d && plural(d, "card")].filter(Boolean).join(" · ") || m.data?.code || "";
  };
  // Soonest class first; modules with none keep their order at the end.
  const order = [...modules].sort((a, b) => (lectureDay(next(moduleName(a)) ?? {}) ?? "9999").localeCompare(lectureDay(next(moduleName(b)) ?? {}) ?? "9999"));
  return html + `<p class="caption-h">Modules</p><ul class="group flat">${order.map((m) =>
    row({ tag: "button", attrs: `data-module="${esc(moduleName(m))}"`, title: esc(moduleName(m)), sub: esc(line(m)), chev: true })).join("")}</ul>`;
}

function moduleScreen(name, today) {
  const mod = modules.find((x) => moduleName(x) === name), d = mod?.data ?? {};
  const lecs = ordered(lectures.filter((l) => l.module === name));
  const deck = cards.filter((c) => c.module === name), dueHere = dueFor(name), qs = practice.filter((q) => q.module === name);
  // Notes no lecture points at and no lecture covers: built on the Mac from a recording that has no lecture row.
  const linked = new Set(lectures.flatMap((l) => [l.data?.pre, l.data?.post, l.user_data?.builtPost]));
  const covered = new Set(lecs.map((l) => String(l.data?.n ?? "").toUpperCase()));
  const more = [...noteById.values()].filter((x) => x.module === name && !["readings", "map"].includes(x.data?.kind) && !linked.has(x.id) && !covered.has(String(x.data?.lecture ?? "").toUpperCase()));
  const map = [...noteById.values()].find((x) => x.module === name && x.data?.kind === "map"); // StudyModel.moduleMap
  const coming = lecs.filter((l) => (lectureDay(l) ?? "").slice(0, 10) >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  const info = [name.length > 48 && row({ lead: ICON.books, title: esc(name), cls: "wrap" }), // the title clamps at 2 lines: the full name here
    ...assessmentRows(d.assessment).map((a) => row({ lead: ICON.cap, title: esc(a.title), sub: esc(a.sub), cls: "wrap" })),
    coming && row({ lead: ICON.calendar, title: esc([coming.data?.n, coming.data?.topic].filter(Boolean).join(" · ")), sub: esc("Next class, " + dayLabel(lectureDay(coming))), cls: "wrap" }),
    d.convenor && row({ lead: ICON.person, title: esc(d.convenor) })].filter(Boolean);
  let html = `<h1 class="large clamp${name.length > 60 ? " long" : name.length > 24 ? " mid" : ""}">${esc(name)}</h1>${d.code ? `<p class="sub">${esc(d.code)}</p>` : ""}`;
  if (dueHere.length) html += `<button class="btn primary mt-20" type="button" data-act="review" data-m="${esc(name)}">Review ${num(Math.min(dueHere.length, CAP))} ${Math.min(dueHere.length, CAP) === 1 ? "card" : "cards"}</button>`;
  else if (deck.length) html += `<p class="foot mt-12">${esc(caughtUp(nextDue(deck, today)))}</p>`;
  if (info.length || map) html += `<ul class="group info mt-20">${info.join("")}${map ? row({ tag: "button", attrs: `data-note="${esc(map.id)}"`, lead: ICON.map, title: "Module map", chev: true }) : ""}</ul>`;
  html += `<p class="caption-h">Lectures</p>` + (lecs.length ? `<ul class="group flat">${lecs.map((l) => {
    const day = lectureDay(l), notes = !!(l.data?.post || l.user_data?.builtPost);
    return row({ tag: "button", attrs: `data-lecture="${esc(l.id)}"`, title: esc(l.data?.topic ?? l.title ?? "Lecture"), titleCls: "clamp", sub: esc([l.data?.n, day && dayName(day.slice(0, 10))].filter(Boolean).join(" · ")),
      trail: notes ? `<span class="sr">Notes</span>${ICON.doc}` : "", trailCls: "glyph-trail", chev: true });
  }).join("")}</ul>` : `<p class="note-line">Lectures appear here as Moodle posts their slides and recordings.</p>`);
  if (more.length) html += `<p class="caption-h">More notes</p><ul class="group flat">${more.map((x) => row({ tag: "button", attrs: `data-note="${esc(x.id)}"`,
    title: esc(x.title ?? x.data?.topic ?? "Lecture notes"), sub: x.date ? esc(dayName(x.date.slice(0, 10))) : "", chev: true })).join("")}</ul>`;
  if (qs.length) html += `<p class="caption-h">Practice</p><ul class="group flat">${qs.map((q) => row({ tag: "button", attrs: `data-practice="${esc(name)}"`,
    title: esc(q.data?.prompt ?? q.title ?? ""), titleCls: "clamp", sub: esc([q.data?.lecture, KINDS[q.data?.kind], q.user_data?.attempt && "Tried"].filter(Boolean).join(" · ")), chev: true })).join("")}</ul>`;
  return html;
}

/** A module's one-line assessment as rows, split on a comma and a space only, so "2,000 words" stays whole.
 *  "Exam, 2 hours, 100%, 2 essays from 6, January" → "Exam · January" over
 *  "2 hours · 100% · answer 2 of 6"; anything else ("Group video 30% due 10 Dec · case study …") one row per part, as written. */
function assessmentRows(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const parts = text.split(/\s*,\s+/).filter(Boolean), cap = (t) => t.slice(0, 1).toUpperCase() + t.slice(1);
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
const docTitle = (n) => (Array.isArray(n?.data?.doc?.blocks) ? n.data.doc.blocks : []).find((b) => b?.t === "h1" && b.text)?.text ?? null;

// ---------- The reader's bar: Contents (its h2s, the current one ticked) and ••• (Open in Google Docs, Note for this class) ----------

let screenSections = [], screenMore = null; // set by the lecture and note screens as they draw
let menuFor = null;                          // "contents" | "more" | null: the popover that's open
function setMenu(kind, now = false) {
  const menu = $("contents-menu"), was = menuFor;
  for (const id of ["contents", "more"]) $(id).setAttribute("aria-expanded", String(kind === id));
  menuFor = kind;
  if (!kind) {
    if (!was || menu.hidden) return;
    if (menu.contains(document.activeElement)) $(was).focus({ preventScroll: true }); // focus goes back to its trigger
    if (now || still()) { menu.hidden = true; return; }
    menu.classList.add("out");
    menu.addEventListener("animationend", () => { if (!menuFor) menu.hidden = true; menu.classList.remove("out"); }, { once: true });
    return;
  }
  const cur = currentSection()?.id, m = screenMore;
  menu.innerHTML = kind === "contents"
    ? screenSections.map((x) => `<li${x.id === cur ? ` class="cur"` : ""}><button type="button" data-jump="${x.id}">${ICON.tickMark}<span class="lbl">${esc(x.title)}</span></button></li>`).join("")
    : [m?.url && `<li><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer" data-act="docs">${ICON.open}<span class="lbl">Open in Google Docs</span></a></li>`,
       m?.module && `<li><button type="button" data-act="note-class" data-m="${esc(m.module)}" data-l="${esc(m.lecture ?? "")}">${ICON.note}<span class="lbl">Note for this class</span></button></li>`,
       m?.ask && `<li><button type="button" data-act="ask-note" data-n="${esc(m.ask)}">${ICON.bubble}<span class="lbl">Ask Nexi</span></button></li>`].filter(Boolean).join("");
  menu.dataset.kind = kind;
  const r = $(kind).getBoundingClientRect();
  menu.style.right = `${Math.max(8, innerWidth - r.right + 4)}px`; // scales from its trigger
  menu.classList.remove("out");
  menu.hidden = false;
  menu.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
  (menu.querySelector(".cur button") ?? menu.querySelector("button, a"))?.focus({ preventScroll: true });
}
/** The section being read: the last h2 above the bar's bottom edge. */
function currentSection() {
  const line = $("bar").offsetHeight + 60; // a jump lands its h2 at the bar + 40 (scroll-margin)
  let cur = null;
  for (const x of screenSections) { const el = document.getElementById(x.id); if (el && el.getBoundingClientRect().top < line) cur = x; }
  return cur;
}
/** The sticky caption under the bar names the current section once one has scrolled under it. */
function updateSection() {
  const x = tab === "study" && stack.length > 1 && !reviewing && screenSections.length ? currentSection() : null;
  const edge = $("bar").offsetHeight + 28, doc = $("study").querySelector(".prose[data-doc]");
  // Only once its h2 has gone under the caption (no twin right below it), and not past the end of the notes.
  const show = !!x && document.getElementById(x.id).getBoundingClientRect().bottom <= edge && (doc?.getBoundingClientRect().bottom ?? 0) > edge;
  document.documentElement.classList.toggle("sec", show);
  if (show) $("bar-sec").textContent = x.title;
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
  opened(note);
  const day = lectureDay(lec), over = !day || day.slice(0, 10) < today; // ponytail: the day, not the timetable's end time as on the Mac
  screenSections = sections;
  screenMore = { url: typeof url === "string" && url.startsWith("https://") ? url : null, module: lec.module, lecture: n, ask: body ? note.id : null };
  const slides = note?.data?.kind === "post" && note.data.from === "slides" && !body.includes(`class="provenance"`);
  return `${head(lec.data?.topic ?? lec.title ?? "Lecture", [short(lec.module), n, day && shortDay(day.slice(0, 10))].filter(Boolean).join(" · "))}
    ${pre && post ? `<div class="seg" role="tablist" aria-label="Which note" style="--n: 2; --i: ${usePrimer ? 0 : 1}"><span class="thumb" aria-hidden="true"></span>${[["Primer", true], ["Notes", false]]
      .map(([label, v]) => `<button type="button" role="tab" data-primer="${v}" aria-selected="${usePrimer === v}">${label}</button>`).join("")}</div>` : ""}
    ${body || (over ? empty(ICON.doc, "No notes yet", "Build the notes from the recording in Sidebrain on the Mac.")
                    : empty(ICON.doc, "Notes come after the lecture", "They arrive here once it has finished."))}
    ${slides ? `<p class="provenance">Built from the slides. Sidebrain rebuilds these notes when the recording’s transcript arrives.</p>` : ""}
    ${readings?.data?.body ? `<p class="caption-h">Readings</p><div class="prose boxed">${markdown(readings.data.body)}</div>` : ""}
    ${deck.length ? `<p class="caption-h">Flashcards</p>
      ${dueHere.length ? `<button class="btn primary" type="button" data-act="review" data-m="${esc(lec.module)}" data-l="${esc(n)}">Review ${num(Math.min(dueHere.length, CAP))} ${Math.min(dueHere.length, CAP) === 1 ? "card" : "cards"}</button>` : ""}
      <ul class="group flat${dueHere.length ? " mt-12" : ""}">${deck.map((c) => row({ title: esc(c.data?.front ?? c.title ?? "") })).join("")}</ul>` : ""}
    ${qs.length ? `<p class="caption-h">Practice</p>${qs.map((q) => practiceCard(q)).join("")}` : ""}`;
}

/** Post-lecture notes read here get openedAt once, so Suggestions stops asking (N5). */
const opened = (n) => { if (tab === "study" && n?.data?.kind === "post" && !n.user_data?.openedAt) writeUser(n, { openedAt: Date.now() }, "edit"); };

function noteScreen(id) {
  const note = noteById.get(id);
  if (!note) return head("Notes") + empty(ICON.doc, "Notes not found", "The last sync may have removed them.");
  const sections = [], body = noteHtml(note, sections), url = note.data?.docUrl;
  opened(note);
  screenSections = sections;
  const docs = typeof url === "string" && url.startsWith("https://") ? url : null;
  screenMore = docs || body ? { url: docs, ask: body ? id : null } : null;
  return head(docTitle(note) ?? note.title ?? (note.data?.kind === "map" ? "Module map" : "Lecture notes")) + (body || empty(ICON.doc, "Nothing in these notes", "They may still be building on the Mac."));
}

function practiceScreen(sc) {
  const all = practice.filter((q) => !sc.m || q.module === sc.m);
  // Not yet tried first, fixed when the screen opens, so a card doesn't jump away the moment it's answered.
  sc.order ??= [...all.filter((q) => !q.user_data?.attempt), ...all.filter((q) => q.user_data?.attempt)].map((q) => q.id);
  const qs = [...all].sort((a, b) => sc.order.indexOf(a.id) - sc.order.indexOf(b.id));
  return head("Practice", sc.m ?? "") + `<div class="mt-20">${qs.length ? qs.map((q) => practiceCard(q, !sc.m)).join("")
    : empty(ICON.practice, "No practice yet", "Practice questions come with each lecture’s notes.")}</div>`;
}

/** Attempt first: the model answer stays locked until something is written and checked, or the answer is asked for. */
function practiceCard(q, withModule = false) {
  const id = q.id, open = shown.has(id) || !!q.user_data?.attempt, model = typeof q.data?.model === "string" ? q.data.model : "";
  const meta = [withModule && short(q.module), q.data?.lecture, KINDS[q.data?.kind] ?? "Question", q.user_data?.attempt && "Tried"].filter(Boolean).join(" · ");
  return `<article class="practice-card">
    <p class="foot">${esc(meta)}</p>
    <p class="headline">${esc(q.data?.prompt ?? q.title ?? "")}</p>
    <textarea data-draft="${esc(id)}" rows="4" placeholder="Answer" aria-label="Answer"></textarea>
    <div class="actions">
      <button class="btn secondary small" type="button" data-check="${esc(id)}" disabled>${open ? "Save attempt" : "Check"}</button>
      ${open ? "" : `<button class="btn plain" type="button" data-skip="${esc(id)}">Show the answer</button>`}
    </div>
    ${open ? `<div class="model"><p class="cap">Model answer</p><div class="prose tight">${markdown(model)}</div>${q.data?.origin ? `<p class="foot">${esc(q.data.origin)}</p>` : ""}</div>` : ""}
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
  // The switch is the master push switch: every ping and the daily summary. Quiet hours and the summary time are the server's.
  const waiting = outbox.length, note = reminderError || (reminders === "on" ? "On · quiet 22:00–08:00, summary at 08:00" : reminders === "off" ? "Off" : REMINDER_NOTE[reminders] ?? "");
  const t = theme(), looks = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
  paint($("sheet-body"), `<ul class="group">${row({ lead: `<span class="avatar-lg">${esc((user?.email || "?")[0].toUpperCase())}</span>`,
      title: esc(DEMO ? "Demo" : user?.email ?? ""), sub: DEMO ? "Sample data, kept on this phone" : "Signed in with Google" })}</ul>
    <ul class="group"><li><div class="row">${ICON.contrast}<span class="text"><span class="title">Appearance</span></span></div>
      <div class="seg looks" role="radiogroup" aria-label="Appearance" style="--n: 3"><span class="thumb" aria-hidden="true"></span>${looks
        .map(([k, l]) => `<button type="button" role="radio" data-theme-pick="${k}">${l}</button>`).join("")}</div></li></ul>
    <ul class="group">
      <li><label class="row">${ICON.bell}<span class="text"><span class="title">Notifications</span>${note ? `<span class="subtitle wrap${reminderError ? " warn" : ""}">${esc(note)}</span>` : ""}</span>
        <input type="checkbox" switch id="remind" ${reminders === "on" ? "checked" : ""} ${["on", "off"].includes(reminders) ? "" : "disabled"} aria-label="Notifications"></label></li>
      <li><label class="row">${ICON.list}<span class="text"><span class="title">Suggestions</span><span class="subtitle">Up to 2 a day on Today, 08:00–22:00</span></span>
        <input type="checkbox" switch id="sug-on" ${sugOn ? "checked" : ""} aria-label="Suggestions"></label></li>
      <li><label class="row">${ICON.dumbbell}<span class="text"><span class="title">Train</span><span class="subtitle">Gym plan and logging</span></span>
        <input type="checkbox" switch id="train-on" ${trainOn ? "checked" : ""} aria-label="Train"></label></li>
      ${trainOn ? train.accountRows() : ""}
      ${DEMO ? "" : row({ lead: ICON.sync, title: "Sync", sub: signedOutOfSync && waiting ? `Sign in again to sync ${plural(waiting, "change")}` : "",
        trail: waiting ? `${waiting} waiting` : "Up to date" }).replace('class="subtitle"', 'class="subtitle warn"')}
    </ul>
    <ul class="group flat">${row({ tag: "button", attrs: `data-act="signout"`, title: DEMO ? "Reset demo" : "Sign out", cls: "destructive" })}</ul>`);
  // The choice is set on the live control, so its thumb slides instead of the group being redrawn.
  const seg = $("sheet-body").querySelector(".looks");
  seg.style.setProperty("--i", looks.findIndex(([k]) => k === t));
  for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.themePick === t));
}

// ---------- Appearance: System, Light or Dark (Account sheet) ----------

const THEME = "sidebrain.theme"; // one per phone, demo or not; index.html applies it before the first paint
const theme = () => { try { const t = localStorage.getItem(THEME); return t === "light" || t === "dark" ? t : "system"; } catch { return "system"; } };
function applyTheme(t) {
  try { if (t === "system") localStorage.removeItem(THEME); else localStorage.setItem(THEME, t); } catch { /* private mode: it lasts until the app closes */ }
  if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  // The status bar follows: an explicit choice sets both theme-color metas, System gives each its own scheme's colour back.
  for (const m of document.querySelectorAll("meta[name=theme-color]")) m.content = (t === "system" ? m.media.includes("dark") : t === "dark") ? "#000000" : "#f2f2f7";
  render();
}

// ---------- Sheets: open 380 ms, close 220 ms on animationend, drag the head down to dismiss; the confirm action sheet ----------

const DRAWER = "cubic-bezier(.32,.72,0,1)";
let suppressClick = 0;
function openSheet(d) {
  d.classList.remove("closing", "closing-drag");
  d.getAnimations().forEach((a) => a.cancel());
  if (!d.open) d.showModal();
}
/** Closes with the slide down; `from` is where a drag let go of it, so the close carries on from there. */
function closeSheet(d, from = null) {
  if (!d?.open || d.classList.contains("closing") || d.classList.contains("closing-drag")) return;
  if (from != null && !still()) {
    d.classList.add("closing-drag");
    d.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(calc(100% + 16px))" }], { duration: 220, easing: DRAWER, fill: "forwards" })
      .onfinish = () => { d.close(); d.getAnimations().forEach((a) => a.cancel()); };
    return;
  }
  d.classList.add("closing");
  const done = () => { clearTimeout(fallback); d.removeEventListener("animationend", end); if (d.classList.contains("closing")) d.close(); };
  const end = (e) => { if (e.target === d && (e.animationName === "sheet-out" || e.animationName === "fade-out")) done(); }; // fade-out: Reduce Motion
  const fallback = setTimeout(done, 300); // in case animationend never comes (a hidden tab)
  d.addEventListener("animationend", end);
}
const rubber = (over, dim, c = .55) => (over * dim * c) / (dim + c * Math.abs(over));
/** Tap outside, Escape and the drag for one sheet. The drag starts on the grabber or the head: 8 px of hysteresis, then 1:1;
 *  it dismisses past 25% of the height or at a flick over .11 px/ms, rubber-bands upward, and snaps back otherwise. */
function sheetGestures(d) {
  d.addEventListener("cancel", (e) => { e.preventDefault(); closeSheet(d); });
  d.addEventListener("close", () => d.classList.remove("closing", "closing-drag"));
  d.addEventListener("click", (e) => {
    const r = d.getBoundingClientRect();
    if (e.target === d && (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right)) closeSheet(d);
  });
  const head = d.querySelector(".sheet-head");
  if (!head) return;
  let g = null;
  d.addEventListener("pointerdown", (e) => {
    const r = d.getBoundingClientRect();
    if (g || e.button > 0 || d.classList.contains("closing") || e.target.closest("input, textarea")) return;
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > head.getBoundingClientRect().bottom) return;
    g = { id: e.pointerId, y: e.clientY, x: e.clientX, on: false, hist: [[e.timeStamp, e.clientY]] };
  });
  d.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dy = e.clientY - g.y;
    if (!g.on) {
      if (Math.abs(e.clientX - g.x) > 10 && Math.abs(e.clientX - g.x) > Math.abs(dy)) { g = null; return; }
      if (Math.abs(dy) < 8) return;
      g.on = true; g.y += Math.sign(dy) * 8; // no jump at the threshold
      try { d.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }
    g.hist.push([e.timeStamp, e.clientY]); while (g.hist.length > 2 && e.timeStamp - g.hist[0][0] > 100) g.hist.shift();
    const y = e.clientY - g.y;
    d.style.transform = `translateY(${y > 0 ? y : -rubber(-y, 80)}px)`;
  });
  const up = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const { on, hist: h } = g, y = e.clientY - g.y, v = (h.at(-1)[1] - h[0][1]) / Math.max(1, h.at(-1)[0] - h[0][0]);
    g = null;
    if (!on) return;
    suppressClick = Date.now() + 350;
    const shown = y > 0 ? y : -rubber(-y, 80);
    d.style.transform = "";
    if (e.type !== "pointercancel" && (y > d.offsetHeight * .25 || v > .11)) return closeSheet(d, Math.max(0, shown));
    if (!still()) d.animate([{ transform: `translateY(${shown}px)` }, { transform: "none" }], { duration: 300, easing: DRAWER });
  };
  d.addEventListener("pointerup", up); d.addEventListener("pointercancel", up);
}

/** The in-app confirm: a message, one destructive action, Cancel. Never confirm(). */
let asked = null;
function ask(message, action, then) {
  say("confirm-msg", message);
  $("confirm-yes").textContent = action;
  asked = then;
  openSheet($("confirm-sheet"));
}

// ---------- Toast: one line and Undo, 5 s ----------

let toastTimer = 0, toastUndo = null;
function toast(message, undo = null) {
  clearTimeout(toastTimer);
  $("toast-text").textContent = message; toastUndo = undo; $("toast-undo").hidden = !undo;
  $("toast").classList.add("on");
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() { clearTimeout(toastTimer); $("toast").classList.remove("on"); toastUndo = null; }

// ---------- The day sheet: two detents, 1:1 drag, momentum projection, a spring with velocity handoff (Focus prototype) ----------

const daySheet = (() => {
  const el = $("day"), scrim = $("scrim"), scroller = $("day-scroll");
  let y = 0, state = "peek", full = 0, peek = 0, raf = 0, dragging = false, startY = 0, sy = 0, hist = [], low = false;
  const set = (v) => {
    y = v; el.style.transform = `translate3d(0,${v.toFixed(2)}px,0)`;
    scrim.style.opacity = Math.min(1, Math.max(0, (peek - v) / Math.max(1, peek - full))).toFixed(3);
    // A peek that shows only the summary keeps the list hidden until the sheet has moved 40 px.
    scroller.style.opacity = low ? Math.min(1, Math.max(0, (peek - v) / 40)).toFixed(3) : "";
  };
  const setState = (s) => {
    state = s; el.classList.toggle("peek", s === "peek"); el.classList.toggle("full", s === "full");
    scrim.classList.toggle("on", s === "full"); $("day-sum").setAttribute("aria-expanded", String(s === "full"));
    if (s === "peek") scroller.scrollTop = 0;
    focusable();
  };
  // At full the page behind is inert; a peek that shows only the summary keeps its hidden list out of the focus order.
  const focusable = () => { $("main").inert = $("bar").inert = !el.hidden && state === "full"; scroller.inert = low && state === "peek"; };
  /** Full sits just under the status bar; the peek never covers the priority, and on a short phone shows only the summary. */
  function layout() {
    const dockH = parseFloat(getComputedStyle($("dock")).bottom) + 62;
    full = (parseFloat(getComputedStyle($("bar")).paddingTop) || 0) + 8;
    const floor = innerHeight - dockH - 84, content = $("today").querySelector(".prio") ?? $("today").querySelector(".hero");
    const bottom = content ? content.getBoundingClientRect().bottom + scrollY + 28 : floor;
    low = floor - bottom < 130;
    peek = Math.round(low ? floor : Math.max(bottom, innerHeight * .45));
    document.documentElement.style.setProperty("--full-y", full + "px");
    if (!dragging && !raf) set(state === "full" ? full : peek);
    focusable();
  }
  /** A damped spring (response .42 s, damping ratio) stepped per frame from the live position and velocity. */
  function springTo(target, v0 = 0, damping = 1) {
    cancelAnimationFrame(raf); raf = 0;
    if (still()) return set(target);
    const response = .42, k = (2 * Math.PI / response) ** 2, c = 4 * Math.PI * damping / response;
    let x = y - target, v = v0, last = performance.now();
    const step = (t) => {
      const dt = Math.min(.032, (t - last) / 1000); last = t;
      for (let i = 0; i < 4; i++) { const a = -k * x - c * v; v += a * dt / 4; x += v * dt / 4; }
      if (Math.abs(x) < .4 && Math.abs(v) < 8) { raf = 0; return set(target); }
      set(target + x); raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function go(s, v0 = 0, damping = 1) { setState(s); springTo(s === "full" ? full : peek, v0, damping); }
  const begin = (cy, t) => { cancelAnimationFrame(raf); raf = 0; dragging = true; startY = cy; sy = y; hist = [[t, cy]]; };
  const track = (cy, t) => {
    hist.push([t, cy]); while (hist.length > 2 && t - hist[0][0] > 100) hist.shift();
    let v = sy + (cy - startY);
    if (v < full) v = full - rubber(full - v, 140); // past full: firm resistance
    if (v > peek) v = peek + rubber(v - peek, 220);
    set(v);
  };
  const finish = () => {
    dragging = false;
    const a = hist[0], b = hist[hist.length - 1], vms = (b[1] - a[1]) / Math.max(1, b[0] - a[0]); // px/ms
    const projected = y + vms * (.995 / (1 - .995));                                       // Apple's projection, d = .995
    const target = Math.abs(vms) > .3 ? (vms < 0 ? "full" : "peek") : Math.abs(projected - full) < Math.abs(projected - peek) ? "full" : "peek";
    go(target, vms * 1000, .86);
  };
  // Pointer: the head always, the whole sheet while it peeks. Grabbing it mid-flight stops the spring where it is.
  let p = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || p || (state === "full" && !raf && !e.target.closest(".day-head"))) return;
    p = { id: e.pointerId, y: e.clientY, on: false };
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  });
  el.addEventListener("pointermove", (e) => {
    if (!p || e.pointerId !== p.id) return;
    if (!p.on) { if (Math.abs(e.clientY - p.y) < 6) return; p.on = true; try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ } begin(e.clientY, e.timeStamp); }
    track(e.clientY, e.timeStamp);
  });
  const up = (e) => {
    if (!p || e.pointerId !== p.id) return;
    const on = p.on; p = null;
    if (on) { suppressClick = Date.now() + 350; finish(); } else if (Math.abs(y - (state === "full" ? full : peek)) > 1) springTo(state === "full" ? full : peek);
  };
  el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  // At full, a pull down on the list from its top hands over to the sheet.
  let ts = null;
  scroller.addEventListener("touchstart", (e) => { if (state !== "full" || e.touches.length > 1) return; ts = { y: e.touches[0].clientY, on: false }; }, { passive: true });
  scroller.addEventListener("touchmove", (e) => {
    if (!ts) return;
    const cy = e.touches[0].clientY, dy = cy - ts.y;
    if (!ts.on) {
      if (scroller.scrollTop > 0 || dy <= 0) { if (dy < 0) ts = null; return; }
      if (e.cancelable) e.preventDefault();
      if (dy < 6) return;
      ts.on = true; begin(cy, e.timeStamp);
    }
    if (e.cancelable) e.preventDefault();
    track(cy, e.timeStamp);
  }, { passive: false });
  scroller.addEventListener("touchend", () => { if (ts?.on) { suppressClick = Date.now() + 350; finish(); } ts = null; });
  return { layout, go, focusable, get state() { return state; } };
})();

// ---------- Events ----------

function bind() {
  document.addEventListener("click", (e) => {
    if (reviewing && e.target.closest("#review .flash, #review .review-top, #review .progress") && !e.target.closest("button")) return flip(); // tap anywhere reveals
    const t = e.target.closest("[data-act],[data-grade],[data-tab],[data-tick],[data-task],[data-move],[data-letgo],[data-module],[data-lecture],[data-note],[data-practice],[data-primer],[data-check],[data-skip],[data-jump],[data-dg],[data-dg-all],[data-close],[data-mode],[data-remove-photo],"
      + "[data-open],[data-ping],[data-class],[data-later],[data-study],[data-chip],[data-cl],[data-step],[data-qz],[data-play],[data-ver],[data-speed],[data-theme-pick]");
    if (!t) return;
    const d = t.dataset;
    if (t.closest("#contents-menu") && !d.jump) setMenu(null, true); // a ••• item: the menu goes as it acts
    if (d.close != null) return closeSheet(t.closest("dialog"));
    if (d.open) return openTarget(d.open) || tell("That isn’t on this phone yet. It arrives with the next sync from the Mac.");
    if (d.ping) return openItem(d.ping);
    if (d.class) { const list = t.closest(".choices")._list ?? []; captureFor = d.class === "none" ? false : list[Number(d.class)] ?? null; classPick = false; render(); return $("add-sheet").querySelector("textarea").focus(); }
    if (d.later) { closeSheet($("item-sheet")); return triage(sheetItem, false, new Date(d.later)); }
    if (d.study) { closeSheet($("item-sheet")); return d.study.startsWith("module:") ? study([{ s: "module", m: d.study.slice(7) }]) : openTarget(d.study) || tell("That isn’t on this phone yet. It arrives with the next sync from the Mac."); }
    if (d.chip) return askNexi(CHIP_ASK[d.chip] ?? d.chip, d.chip);
    if (d.play) return togglePlay(d.play);
    if (d.ver) { if (player.version !== d.ver || player.id !== t.closest("[data-player]").dataset.player) { stopAudio(); player.id = t.closest("[data-player]").dataset.player; player.version = d.ver; } return render(); }
    if (d.speed != null) { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; keep("speed", speed); audio.playbackRate = speed; return render(); }
    const doc = noteById.get(t.closest("[data-doc]")?.dataset.doc);
    if (doc && d.cl) { const checks = { ...(doc.user_data?.checks ?? {}) }; checks[d.cl] = checks[d.cl] !== true; writeUser(doc, { checks }, "edit"); return render(); }
    if (doc && d.qz) { const [k, j] = d.qz.split(":").map(Number); writeUser(doc, { quiz: { ...(doc.user_data?.quiz ?? {}), [k]: j } }, "edit"); return render(); }
    if (doc && d.step) { // one frame on, or back: only the figure changes, so it just redraws
      const [block, k] = d.step.split(":");
      foldsFor(doc.id).frames.set(block, Number(k));
      return render();
    }
    if (d.grade) return grade(Number(d.grade));
    if (d.tick) return tick(d.tick);
    if (d.task) return openTaskSheet(d.task);
    if (d.move) return move(sheetTask, d.move);
    if (d.letgo != null) return letGo(sheetTask);
    if (d.mode === "ask") { closeSheet($("add-sheet")); return openNexi(chatAsk()); }
    if (d.mode) { setMode(d.mode); return (d.mode === "todo" ? $("todo") : $("add-sheet").querySelector("textarea")).focus(); }
    if (d.removePhoto != null) return setPhoto(t.closest("form"), null);
    if (d.themePick) return applyTheme(d.themePick);
    if (d.tab) return switchTab(d.tab);
    switch (d.act) {
      case "fold": return toggleFold(t.closest("[data-fold]"));
      case "gym": if (!train.openToday?.()) switchTab("train"); return;
      case "rugby": return answer(d.v);
      case "rugby-clear": dailyWrite({ rugby: null, answeredAt: null }); return render();
      case "sug": return sugAct(d.key);
      case "sug-started": return sugAct(d.key, true);
      case "sug-more": sugKey = d.key; say("sug-msg", sugRows.find((x) => x.key === d.key)?.title ?? ""); return openSheet($("sug-sheet"));
      case "sug-mute": return sugMute(d.mute);
      case "add": return openAdd("todo");
      case "note-class": captureFor = { module: d.m, lecture: d.l || null }; openAdd("note"); return render();
      case "class-pick": classPick = !classPick; render(); return $("add-sheet").querySelector("[data-act=class-pick]")?.focus();
      case "item-done": closeSheet($("item-sheet")); return triage(sheetItem, true);
      case "item-later": laterOpen = !laterOpen; return renderItem();
      case "draft": return draftReply();
      case "copy-draft": return copyDraft();
      case "ask-item": return openNexi(itemAsk);
      case "ask-note": return noteById.has(d.n) && openNexi(noteAsk(noteById.get(d.n)));
      case "flip": return flip();
      case "review": return openReview(d.m || null, d.l || null);
      case "close-review": return closeReview();
      case "review-more": newSession(); return render();
      case "signout": return ask(DEMO ? "Reset the demo on this phone?" : outbox.length
        ? `${plural(outbox.length, "change")} ${outbox.length === 1 ? "hasn’t" : "haven’t"} synced yet and will be lost.` : "Sign out of Sidebrain on this phone?",
        DEMO ? "Reset demo" : "Sign out", signOut);
    }
    if (d.module) return go({ s: "module", m: d.module });
    if (d.lecture) return go({ s: "lecture", id: d.lecture });
    if (d.note) { e.preventDefault(); return go({ s: "note", id: d.note }); } // a map's note: link is an <a> with a real href
    if (d.practice != null) return go({ s: "practice", m: d.practice || null });
    if (d.primer) { primer.set(top().id, d.primer === "true"); render(); return scrollTo(0, 0); }
    if (d.check) return attempt(d.check);
    if (d.skip) { shown.add(d.skip); return render(); }
    if (d.jump) {
      setMenu(null);
      return document.getElementById(d.jump)?.scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" }); // scroll-margin clears the bar
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
    if (e.target.id === "draft-text") { replies.set(sheetItem, e.target.value); copied = null; return; }
    if (e.target.id === "draft-how") { how = e.target.value; return; }
    if (e.target.id === "nexi-q") { $("nexi-send").disabled = nxBusy || !e.target.value.trim(); return; }
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
    if (el.id === "sug-on") { sugOn = el.checked; keep("suggestions", sugOn); return render(); }
    if (el.id === "train-on") { trainOn = el.checked; keep("train", trainOn); if (trainOn) refresh(); return render(); }
    if (el.name === "photo") return el.files?.[0] && setPhoto(el.closest("form"), el.files[0]);
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id === "nexi-form") { e.preventDefault(); const q = $("nexi-q").value.trim(); $("nexi-q").value = ""; return askNexi(q); }
    if (!e.target.matches("form.compose")) return;
    e.preventDefault();
    saveCompose(e.target);
  });
  // A date input opens its picker from anywhere on its row (Safari does this; Chrome needs showPicker).
  document.addEventListener("click", (e) => { if (e.target.matches?.("input[type=date].overlay")) try { e.target.showPicker(); } catch { /* not allowed here */ } });
  document.addEventListener("keydown", (e) => {
    if (menuFor && e.key === "Escape") return setMenu(null);
    if (e.target.id === "draft-how" && e.key === "Enter") { e.preventDefault(); return draftReply(); }
    if (!reviewing || document.querySelector("dialog[open]") || e.target.matches("textarea, input")) return;
    if (e.key === "Escape") return closeReview();
    if (!current() && (e.key === " " || e.key === "Enter")) { e.preventDefault(); return closeReview(); }
    if (e.key === " ") { e.preventDefault(); return session.flipped ? grade(2) : flip(); } // Space reveals, then answers Good
    if (e.key === "1" || e.key === "2") grade(e.key === "1" ? 0 : 2);
  });
  $("account").onclick = () => { reminderError = ""; renderSheet(); openSheet($("sheet")); };
  $("ask").onclick = () => openNexi(todayAsk());
  $("back").onclick = back;
  $("contents").onclick = () => setMenu(menuFor === "contents" ? null : "contents");
  $("more").onclick = () => setMenu(menuFor === "more" ? null : "more");
  // A popover closes on any tap outside it.
  document.addEventListener("pointerdown", (e) => { if (menuFor && !e.target.closest("#contents-menu, #contents, #more")) setMenu(null); });
  let secFrame = 0;
  addEventListener("scroll", () => { if (screenSections.length && !secFrame) secFrame = requestAnimationFrame(() => { secFrame = 0; updateSection(); }); }, { passive: true });
  edgeSwipe();
  $("add").onclick = () => openAdd(addMode);
  for (const dialog of document.querySelectorAll("dialog.sheet")) sheetGestures(dialog);
  $("confirm-yes").onclick = () => { const then = asked; asked = null; closeSheet($("confirm-sheet")); then?.(); };
  $("toast-undo").onclick = () => { const undo = toastUndo; hideToast(); undo?.(); };
  $("day-sum").onclick = () => daySheet.go(daySheet.state === "full" ? "peek" : "full");
  $("scrim").onclick = () => daySheet.go("peek");
  addEventListener("resize", () => { if (!$("day").hidden) daySheet.layout(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => theme() === "system" && applyTheme("system"));
  document.addEventListener("touchstart", () => {}, { passive: true }); // iOS applies :active only when a touch listener exists
  // A drag never ends in a tap on what it started on.
  document.addEventListener("click", (e) => { if (Date.now() < suppressClick) { e.preventDefault(); e.stopPropagation(); } }, true);
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
  $("add-sheet").addEventListener("close", () => { captureFor = null; classPick = false; renderCaptures(); if (!$("todo").value.trim()) resetTodo(); });
  // IME: while a composition is open the input draws its own text (the mirror can't see uncommitted text).
  $("todo").addEventListener("compositionstart", () => $("todo").parentElement.classList.add("composing"));
  $("todo").addEventListener("compositionend", () => { $("todo").parentElement.classList.remove("composing"); updateTodo(); });
  document.addEventListener("selectionchange", () => { if (document.activeElement === $("todo")) $("todo-mirror").scrollLeft = $("todo").scrollLeft; });
  $("redirect-signin").onclick = redirectSignIn;
  $("read-all").onclick = readAll;
  // The keyboard: iOS standalone doesn't resize the layout viewport, so open sheets are lifted by what it covers (--kb).
  if (window.visualViewport) { const vv = visualViewport, kb = () => document.documentElement.style.setProperty("--kb", (vv.scale > 1.01 ? 0 : Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))) + "px"); // a pinch zoom is not a keyboard
    vv.addEventListener("resize", kb); vv.addEventListener("scroll", kb); }
  inboxGestures($("inbox"));
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
  setMenu(null, true);
  tabY[tab] = scrollY;
  if (next === tab && next === "study") { stack = [{ s: "home" }]; tabY.study = 0; } // the current tab again: back to its start
  if (next === tab && next === "train") { train.reset(); tabY.train = 0; }
  tab = next;
  render();
  scrollTo(0, tabY[tab] ?? 0); // instant, as native tabs are
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
    // ?demo=1&many=1: 1,280 more due today, for the session cap of 20 and the number format
    ...(new URLSearchParams(location.search).has("many") ? Array.from({ length: 1280 }, (_, i) => card(`many-${i}`, sm, "L1", `Sample question ${i + 1}`, "Sample answer.")) : []),
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
      // ?demo=1&classnow=1: a lecture on now, for the hero's On now and Note for this class
      ...(new URLSearchParams(location.search).has("classnow") ? [{ id: "ev-now", title: "CRG lecture L2: Jensen & Meckling", date: t, data: { title: "CRG lecture L2: Jensen & Meckling",
        start: new Date(Date.now() - 20 * 6e4).toISOString(), end: new Date(Date.now() + 40 * 6e4).toISOString(), location: "Portland A13" }, user_data: {} }] : []),
    ].filter(Boolean),
    pings: demoPings(),
    messages: demoMessages(),
    assessments: [
      assess("assess-crg-essay", crg, day(5), { title: "Essay", weight: "50%", milestones: [{ date: day(1), label: "Outline to tutor" }, { date: day(12), label: "Full draft" }] }),
      assess("assess-sm-group", sm, day(24), { title: "Group presentation", weight: "30%", milestones: [{ date: day(-1), label: "Pick the case company" }, { date: day(6), label: "Slides to the group" }] }), // Suggestions N2
      assess("assess-ms-report", "Marketing & Society", day(16), { title: "Consumer report", weight: "40%" }), // Suggestions N3
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
      { id: "app-demo-bain", title: null, date: day(10), data: { org: "Bain", role: "Associate Consultant Intern", stage: "Applying" }, user_data: {} }, // Suggestions N1
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
    // One Moodle ping per sync, with counts per module (PingDetect.moodle): the Inbox shows it as one batched row.
    { ...ping("ping-moodle-sync", "New on Moodle: M&S 2 · CRG 1", ago(95), "moodle", "url:https://moodle.nottingham.ac.uk/"), data: { at: iso(ago(95)), kind: "moodle", open: "url:https://moodle.nottingham.ac.uk/", counts: { "M&S": 2, CRG: 1 } } },
    ping("ping-moodle-sm-case", "New SM material: Harley case", ago(27 * 60), "moodle", "url:https://moodle.nottingham.ac.uk/", { seenAt: Date.now() - 26 * 36e5 }),
    ping("ping-deadline-crg-week", "CRG essay due in 8 days", ago(3 * 1440), "deadline", "item:assess-crg-essay", { seenAt: Date.now() - 3 * 864e5 }),
    ping("ping-notes-crg-l1", "CRG L1 notes ready", ago(26 * 60), "notes", "note:auto-post-crg-l1", { seenAt: Date.now() - 25 * 36e5 }),
    ping("ping-deadline-crg-outline", "CRG essay outline due tomorrow", ago(4 * 60), "deadline", "item:assess-crg-essay"),
    ping("ping-brief-ms-sem1", "M&S Seminar 1 brief", at(0, "20:00"), "brief", "note:auto-pre-ms-sem1"),
    ping("ping-nudge-ms-sem1", "M&S Seminar 1 in 30 min · JC CS A01", at(1, "10:00"), "nudge", "listen:auto-pre-ms-sem1"),
    ping("ping-reask-ms-sem1", "M&S Seminar 1: three questions", at(2, "09:00"), "reask", "reask:auto-pre-ms-sem1"),
    // A priority email's ping: its message row (demoMessages) stands for it, so the Inbox shows the message once.
    ping("ping-app-email-demo-lane", "Dr Sarah Lane: CRG essay outline", ago(40), "email", "url:https://mail.google.com/mail/u/0/#inbox/demo"),
  ];
}

/** Priority messages as the Mac mirrors them (v2 design §1): a Gmail with its email ping and a free draft, a two-message
 *  WhatsApp thread, a LinkedIn. */
function demoMessages() {
  const ago = (mins) => new Date(Date.now() - mins * 6e4).toISOString();
  const msg = (id, data) => ({ id, title: data.sender, date: localDay(Date.parse(data.received)), data, user_data: {} });
  return [
    msg("msg-demo-lane", { service: "Gmail", sender: "Dr Sarah Lane", subject: "CRG essay outline", received: ago(40), replyNeeded: true, ping: "ping-app-email-demo-lane",
      url: "https://mail.google.com/mail/u/0/#inbox/demo", reason: "Your tutor asks when the outline will be ready.",
      body: "Hi,\n\nThanks for your question in the seminar. Could you send me your essay outline by Thursday? One page is plenty: your question, the two theories you’ll argue between, and the evidence you plan to use.\n\nIf Thursday doesn’t work, tell me which day does.\n\nBest wishes,\nSarah",
      draft: "Hi Sarah,\n\nThanks, I’ll send the outline by Thursday. It will set out my question, Jensen (2002) and Hart & Zingales (2022) as the two sides, and the annual reports I plan to use.\n\nBest wishes" }),
    msg("msg-demo-tom-1", { service: "WhatsApp", sender: "Tom (rugby)", received: ago(95), replyNeeded: true, reason: "Asks if you’re playing Saturday.", body: "Are you in for Saturday?" }),
    msg("msg-demo-tom-2", { service: "WhatsApp", sender: "Tom (rugby)", received: ago(92), replyNeeded: true, reason: "Asks if you’re playing Saturday.", body: "Coach needs numbers by tonight" }),
    msg("msg-demo-orbis", { service: "LinkedIn", sender: "Hannah Price", received: ago(26 * 60), reason: "Orbis recruiter, about the Summer Analyst deadline.",
      body: "Thanks for connecting. Applications for the Summer Analyst programme close on Friday. Happy to answer questions about the assessment centre before then." }),
  ];
}
const demoMaterials = () => [
  { id: "moodle-cm-demo-1", module: "Marketing & Society", title: "Week 4 slides: Advertising and children", data: { type: "resource", section: "Week 4", url: "https://moodle.nottingham.ac.uk/", files: [{ name: "W4 slides.pdf" }] } },
  { id: "moodle-cm-demo-2", module: "Marketing & Society", title: "Seminar 2 reading list", data: { type: "page", section: "Week 4", url: "https://moodle.nottingham.ac.uk/" } },
  { id: "moodle-cm-demo-3", module: "Corporate Restructuring & Governance", title: "Lecture 3 Part 1: Executive pay", data: { type: "url", section: "Week 3", url: "https://moodle.nottingham.ac.uk/" } },
];
/** Nexi in the demo: a canned answer after half a second, no network. Free text is echoed back, so the plain-text
 *  rendering can be seen (a typed <img> shows as text in the answer too). */
const demoAnswer = (text) => new Promise((ok) => setTimeout(() => ok({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }), 500));
const demoDraft = (m) => (m.service === "WhatsApp" ? "Yes, I’m in for Saturday. See you there."
  : m.service === "LinkedIn" ? "Hi Hannah, thanks. I’m applying this week and would value ten minutes on the assessment centre. Would [day] suit you?"
  : `Hi ${m.sender.replace(/^Dr /, "").split(" ")[0]},\n\nThanks, I’ll send it by [day].\n\nBest wishes`);
function demoAsk(q, ctx) {
  if (q === CHIP_ASK["What first?"]) return ctx.key === "today" ? "Start with “Outline the CRG essay”: the outline goes to your tutor tomorrow. Then read Jensen & Meckling before the seminar."
    : `Start with ${ctx.label}: it’s the nearest thing due. Then clear today’s to-dos.`;
  if (q === CHIP_ASK["Explain this"]) return `In the demo this is sample text. Signed in, Nexi explains ${ctx.label} in plain words, using only what’s on screen.`;
  if (q === CHIP_ASK["Quiz me"]) return `Question 1 on ${ctx.label}: what is the one idea you’d have to explain in the exam? Reply and I’ll mark it.`;
  return `Demo answer to “${q}”. Signed in, Nexi answers from your day, notes and messages.`;
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
    { t: "callout", tone: "key", text: "✔ **Check yourself:** why does *more* shareholders make monitoring *less* likely? *Answer in section 4.*" },
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
      { id: "mod-ms", module: "Marketing & Society", title: "Marketing & Society", data: { code: "BUSI3023", short: "M&S", convenor: "Dr Samanthika Gallage", assessment: "Essay, 2,000 words, 100%, due 8 Dec" } },
      { id: "mod-crg", module: crg, title: crg, data: { code: "BUSI3028", short: "CRG", convenor: "Dr Sarah Lane", assessment: "Exam, 2 hours, 100%, 2 essays from 6, January", next: "L2 Wed 10:00 · Jensen & Meckling model · exam 100%" } },
      { id: "mod-sm", module: sm, title: sm, data: { code: "BUSI3186", short: "SM", convenor: "Dr Tom Hale", assessment: "Group video 30% due 10 Dec · case study 70% due 13 May", next: "L2 Fri 09:00 · External analysis" } },
    ],
    lectures: [
      { id: "lec-marketing-society-sem1", module: "Marketing & Society", date: day(1), title: null, data: { n: "Seminar 1", topic: "The essay brief, the rubric and AI rules", pre: "auto-pre-ms-sem1" }, user_data: {} },
      { id: "lec-crg-l1", module: crg, date: day(-6), title: null, data: { n: "L1", topic: "Why corporate governance exists", pre: "auto-pre-crg-l1", post: "auto-post-crg-l1", docUrl: "https://docs.google.com/document/d/demo" }, user_data: {} },
      { id: "lec-crg-l2", module: crg, date: day(1), title: null, data: { n: "L2", topic: "The Jensen & Meckling model", pre: "auto-pre-crg-l2" }, user_data: {} },
      { id: "lec-sm-l1", module: sm, date: day(-4), title: null, data: { n: "L1", topic: "What is strategy?", post: "auto-post-sm-l1" }, user_data: {} },
    ],
    lectureNotes: [
      demoBrief(day),
      note("auto-pre-crg-l1", crg, "pre", "L1", "CRG L1 primer", { body: "Before L1: skim **Berle & Means (1932)**, the abstract only.\n\n- Who owns a listed firm?\n- Who runs it, and why might they differ?" }),
      { ...note("auto-post-crg-l1", crg, "post", "L1", "CRG L1 · Why corporate governance exists", { body: "## One-page core\nDispersed owners don’t monitor.", doc }),
        user_data: { listen: { script: Array(100).fill("Dispersed owners do not monitor managers, so governance closes the gap.").join(" ") } } }, // Listen, made on the Mac
      note("auto-pre-crg-l2", crg, "pre", "L2", "CRG L2 primer", { body: "## Before L2\nThe *Jensen & Meckling (1976)* model is “as hard as it gets”: one graph, no heavy maths.\n\n1. Draw firm value against the manager’s share.\n2. Mark where perks start to cost the owners.\n\n> Read the introduction and conclusion; skip the proofs." }),
      note("auto-post-sm-l1", sm, "post", "L1", "SM L1 · What is strategy?", { body: "## One-page core\n**Strategy** is a set of choices about where to compete and how to win (Porter, 1996).\n\n| Theory | Question it answers | Use it for |\n|---|---|---|\n| Five Forces | How attractive is the industry? | Part 1: why change started |\n| VRIO | Which resources give an edge? | Part 2: what changed |\n| Upper echelons | How do leaders shape it? | Part 3: leadership |\n\n## How to do well\n- Use 2–3 theories **systematically**, not a tour of every model.\n  - Apply each one to the case evidence.\n- Five Forces substitutes are *other products* (trains versus flights).\n\n> Last year’s markers punished describing the case instead of applying theory.\n\n---\nSlides and the brief are on [Moodle](https://moodle.nottingham.ac.uk/)." }),
      note("auto-map-crg", crg, "map", null, "CRG module map", { doc: { version: 1, blocks: [
        { t: "h1", text: "CRG module map" },
        { t: "p", text: "Ten lectures build one argument: who should a company serve, and who makes sure it does? Start at [**L1 · Why governance exists**](note:auto-post-crg-l1)." },
        { t: "diagram", caption: "**Takeaway:** each class answers the question the last one raised.", diagram: { type: "graph", nodes: [
          { id: "l1", title: "L1 · Why governance exists", sub: "the agency problem", row: 0 }, { id: "l2", title: "L2 · The Jensen & Meckling model", sub: "what the agency costs", row: 1 },
          { id: "l3", title: "L3 · Executive pay", sub: "aligning managers", row: 2 }, { id: "l4", title: "L4 · Boards and blockholders", sub: "who watches", row: 3 }],
          edges: [{ from: "l1", to: "l2", verb: "prices the problem", style: "solid" }, { from: "l2", to: "l3", verb: "one fix", style: "solid" }, { from: "l2", to: "l4", verb: "the other fix", style: "solid" }, { from: "l3", to: "l4", verb: "set by", style: "dashed" }] } },
        { t: "h2", text: "The classes" },
        { t: "table", header: ["Class", "Core claim", "Use it for"], rows: [["**L1**", "Dispersed owners don’t monitor, so managers drift.", "Part (a) of any essay"], ["**L2**", "Agency costs are real and can be priced.", "The mechanism"], ["**L3**", "Pay aligns managers only when it tracks their own effort.", "Evaluating a fix"]] },
        { t: "h2", text: "Essay steer" },
        { t: "callout", tone: "key", text: "**Exam steer:** pick two lectures and argue between them; don’t tour all ten." },
      ] } }),
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
