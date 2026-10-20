// The Train tab: an optional plugin, off until switched on in the Account sheet (docs/(C) Gym plugin research.md §1, §7).
// Built on the shell's design system (web/(C) Design system.md): the Today-style hero answers "what now?", inset-grouped
// lists below it, the shell's sheet, Undo toast and folds. It owns #train and #train-sheet (one sheet, one mode at a time:
// a set, an exercise's menu, swap, another session, finish, bodyweight, an exercise in the plan). Food is food.js (ctx.food). The rules live in gym.js.
// History, a session, an exercise and Edit plan are pushed over the main screen; the shell's back button pops them (depth/back).
import { PLAN, KEYS, sessionForDay, sessionsOf, prescribe, warnings, deloadOffer, week, weightTrend, startFrom, lastTime,
         planWeek, whoopFor, phaseOf, exerciseById, FEEL, WRECKED,
         planOf, setsOf, prsOf, bestOf, beats, absorb, exerciseLog, records, idFor, updateSwap, dayPlan } from "./gym.js";
import { todayString, addDays } from "./sm2.js";
import { TICK } from "./notes.js";

let ctx = null;                  // app.js: helpers, the outbox, the client and the shell's components (see train.mount in app.js)
/** The check-in rows: the shell's copy (updated the moment Ricky taps) over whatever the last gym fetch brought. */
const dayRows = () => { if (!ctx?.daily) return rows; const d = ctx.daily(), ids = new Set(d.map((r) => r.id)); return rows.filter((r) => !ids.has(r.id)).concat(d); };
let rows = [];                   // gym items: this phone's copy, merged with the server's
let live = null;                 // the session in progress (kept in localStorage, so a locked phone or a reload loses nothing)
let editing = false, status = "", whoop = { connected: null, recovery: null, day: "" };
let sheet = null;                // what #train-sheet shows: {mode, ...}
let just = "";                   // the tick that was just pressed, so only it plays the pop
let jwt = null, restTimer = null, quietTimer = null;
let nav = [], homeY = 0;         // pushed screens: {s: "history" | "session" | "exercise" | "plan", id?, key?, y?}
let chartM = 0, chartR = 1;      // the exercise chart: Weight | e1RM | Volume, and 4W | All
let wake = null;                 // the Screen Wake Lock while a session runs (a promise of the lock)
let noClick = 0;                 // a swipe or drag just ended: swallow the click it makes

const $ = (id) => document.getElementById(id);
const DRAWER = "cubic-bezier(.32,.72,0,1)";
const esc = (s) => ctx.esc(String(s ?? ""));
const num = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const kg = (x) => (x == null ? "" : `${num(x)} kg`);
const profileRow = () => rows.find((r) => r.id === "gym-profile") ?? null;
const profile = () => profileRow()?.user_data ?? null;
const of = (type) => rows.filter((r) => r.data?.type === type && !r.deleted_at);
const rowById = (id) => rows.find((r) => r.id === id) ?? null;
const exOf = (id) => exerciseById(id, profile());
/** An exercise's name: as the session logged it, else from the plan, else from any session that logged it. */
const exName = (id, s = null) => s?.data?.names?.[id] ?? exOf(id)?.name ?? sessionsOf(rows).map((x) => x.data.names?.[id]).find(Boolean) ?? "Exercise";
const redraw = () => { const el = $("train"); if (el) el._html = null; ctx.rerender(); };

export function mount(c) {
  ctx = c;
  rows = ctx.load("gym", []);
  live = ctx.load("gym-live", null);
  const dlg = document.createElement("dialog");
  dlg.className = "sheet"; dlg.id = "train-sheet"; dlg.setAttribute("aria-labelledby", "train-sheet-title");
  document.body.append(dlg);
  dlg.innerHTML = sheetHead("Train"); // the gestures need a head to drag by; it is redrawn on every open
  ctx.sheetGestures(dlg);
  dlg.addEventListener("close", () => { // a past set or a plan exercise is edited on a copy and saved once, here
    const done = sheet?.dirty && sheet;
    sheet = null;
    if (done?.row && rowById(done.row)) { patch(rowById(done.row), { sets: done.sets }); ctx.rerender(); }
    if (done?.mode === "plan-ex") savePlan(done.key, done.items);
  });
  for (const el of [$("train"), dlg]) {
    el.addEventListener("click", click);
    el.addEventListener("change", change);
    el.addEventListener("input", input);
  }
  $("sheet")?.addEventListener("click", click); // Account → Train rows (accountRows)
  planGestures($("train"));
  document.addEventListener("visibilitychange", restVisibility);
  awake();
  const link = new URLSearchParams(location.search).get("whoop");
  if (link) status = link === "connected" ? "WHOOP connected." : "WHOOP didn’t connect. Try again.";
  if (live?.rest) { tick(); quietTimer = setTimeout(restQuiet, Math.max(0, live.rest.until - Date.now() - 10_000)); }
  setInterval(() => { if (live) paintLive(); }, 30_000);
}

/** Today's Gym event opens the Train tab while Train is on; false (do nothing) when it's off, so the row keeps its own tap. */
export function openToday() {
  if (!ctx?.on()) return false;
  nav = [];
  ctx.tab();
  scrollTo(0, 0);
  return true;
}

/** Server rows in; a local row wins while its userAt is newer, and rows added here stay until the server returns them. */
export function setRows(fetched) {
  const mine = new Map(rows.map((r) => [r.id, r])), seen = new Set(fetched.map((r) => r.id)), recent = Date.now() - 10 * 60000;
  rows = fetched.map((f) => {
    const l = mine.get(f.id), at = l?.user_data?.userAt, theirs = f.user_data?.userAt ?? (Date.parse(f.updated_at) || 0);
    return typeof at === "number" && at > theirs ? { ...f, user_data: l.user_data } : f;
  }).concat(rows.filter((r) => !seen.has(r.id) && (r.fresh ?? 0) > recent));
  save();
  pullStrain();
}

const save = () => ctx.keep("gym", rows);
const saveLive = () => ctx.keep("gym-live", live);
function add(row) {
  const r = { kind: "gym", source: "you", module: null, deleted_at: null, ...row };
  rows.push({ ...r, fresh: Date.now(), created_at: new Date().toISOString() });
  save();
  ctx.addRow(r);
  return rows[rows.length - 1];
}
function patch(row, p) { ctx.writeUser(row, p, "edit"); save(); }

// ---------- Server calls (all optional: each fails quietly into a plain line) ----------

async function token() { return (await ctx.sb()?.auth.getSession())?.data?.session?.access_token ?? null; }
async function call(fn, body, headers = {}) {
  const t = await token();
  if (!t) throw new Error("Sign in to use this.");
  const r = await fetch(`${ctx.url}/functions/v1/${fn}`, { method: "POST", body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${t}`, apikey: ctx.anon, "Content-Type": "application/json", ...headers } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error?.message ?? j.error ?? "Couldn’t reach Sidebrain."); e.status = r.status; e.body = j; throw e; }
  return j;
}

async function whoopStatus() {
  if (ctx.demo || whoop.day === todayString()) return;
  whoop.day = todayString();
  try {
    whoop.connected = (await call("whoop", { action: "status" })).connected;
    if (whoop.connected) whoop.recovery = (await call("whoop", { action: "recovery" })).recovery?.score ?? null;
  } catch { whoop.connected = null; }
  ctx.rerender();
}

/** Strain and HR for sessions in the last 2 days that don't have them yet (WHOOP scores a workout a few minutes after it ends). */
let pulling = false;
async function pullStrain() {
  if (ctx.demo || pulling || whoop.connected === false) return;
  const due = sessionsOf(rows).filter((s) => !s.user_data?.whoop && s.date >= addDays(todayString(), -2) && Date.now() - (s.data.end ?? 0) > 3 * 60000);
  if (!due.length) return;
  pulling = true;
  try {
    for (const s of due) {
      const { workouts } = await call("whoop", { action: "workouts", start: new Date(s.data.start - 3600_000).toISOString(), end: new Date(s.data.end + 3600_000).toISOString() });
      const w = whoopFor(workouts, s.data.start, s.data.end);
      if (w) patch(s, { whoop: w });
    }
  } catch (e) { if (e.status === 409) whoop.connected = false; }
  finally { pulling = false; ctx.rerender(); }
}

// ---------- The rest push (a 5-second cron sends rest_timers rows to the lock screen) ----------
// Written when the rest starts, so a phone locked straight after a set still buzzes. While Train is on screen the push is
// noise, so 10 s before the end a visible page takes the row back; if the phone is then locked, the row goes back up.
// keepalive lets the write finish while iOS suspends the page.

function restWrite(at, body = "") {
  const uid = ctx.user()?.id;
  if (ctx.demo || !uid || !jwt) return;
  const headers = { apikey: ctx.anon, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", Prefer: "return=minimal" };
  const req = at
    ? fetch(`${ctx.url}/rest/v1/rest_timers?on_conflict=user_id`, { method: "POST", keepalive: true, headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: uid, fire_at: new Date(at).toISOString(), title: "Rest over", body, sent_at: null }) })
    : fetch(`${ctx.url}/rest/v1/rest_timers?user_id=eq.${uid}`, { method: "DELETE", keepalive: true, headers });
  req.catch(() => { /* the countdown on screen still works; only the lock-screen push is lost */ });
}
function restStart(seconds, body) {
  const until = Date.now() + seconds * 1000;
  live.rest = { until, body, server: true };
  clearTimeout(quietTimer);
  quietTimer = setTimeout(restQuiet, Math.max(0, seconds * 1000 - 10_000));
  saveLive();
  tick();
  token().then((t) => { jwt = t ?? jwt; }).catch(() => {}).finally(() => { if (live?.rest?.until === until) restWrite(until, body); });
}
function restStop() {
  clearTimeout(quietTimer);
  if (live?.rest?.server) restWrite(null);
  if (live) live.rest = null;
}
function restQuiet() {
  if (live?.rest?.server && document.visibilityState === "visible") { restWrite(null); live.rest.server = false; saveLive(); }
}
function restVisibility() {
  if (document.visibilityState === "visible") awake(); // iOS drops the wake lock whenever the page is hidden
  const r = live?.rest, left = r ? r.until - Date.now() : 0;
  if (!r || left <= 0) return;
  if (document.visibilityState === "hidden" && !r.server && left > 3000) { restWrite(r.until, r.body); r.server = true; }
  else if (document.visibilityState === "visible" && r.server && left < 12_000) { restWrite(null); r.server = false; }
  saveLive();
}

// ---------- Screens ----------

export function render() {
  const el = $("train");
  if (!el || !ctx) return;
  const sc = profile() && !editing ? nav.at(-1) : null;
  const html = sc ? pushed(sc) + (live ? restPill() : "") : !profile() || editing ? setup() : live ? liveScreen() : home();
  if (el._html !== html) el.innerHTML = el._html = html;
  just = "";
  if (profile() && !live) whoopStatus();
}

/** The shell's segmented control for one choice; `value` is the chosen index or null (no thumb). */
const seg = (g, value, labels, label, extra = "") => `<div class="seg gym-seg" role="radiogroup" aria-label="${label}" style="--n: ${labels.length}; --i: ${value ?? 0}"${value == null ? " data-none" : ""} ${extra}>
  <span class="thumb" aria-hidden="true"></span>${labels.map((l, i) => `<button type="button" role="radio" data-g="${g}" data-v="${i}" aria-checked="${value === i}">${l}</button>`).join("")}</div>`;
/** Slides the thumb on the live element (no redraw), as the design system asks. */
function pickSeg(t) {
  const s = t.closest(".seg");
  s.style.setProperty("--i", t.dataset.v);
  s.removeAttribute("data-none");
  for (const b of s.querySelectorAll("button")) b.setAttribute("aria-checked", String(b === t));
}
const reps = (e) => (e.kind === "time" ? `${e.hi} ${e.unit ?? "s"}` : e.lo === e.hi ? `${e.hi}` : `${e.lo}–${e.hi}`);
const dayName = (day, opts = { weekday: "long" }) => new Date(day + "T12:00").toLocaleDateString("en-GB", opts);
const phaseName = (phase) => ({ build: "Build", deload: "Deload", light: "Light week" }[phase] ?? "");

/** The hero for the plan: what now, in the Today hero's grid. */
function planHero(today, sessions, p, phase, dp) {
  const key = dp.key;
  if (phase === "over") return `<section class="hero" aria-label="Training now"><div class="hgrid"><p class="k">Autumn plan</p><span></span><h2>Plan finished</h2></div>
    <p class="where gym-hero-line">It ended on 12 Dec. Write the next block, then load it here.</p></section>`;
  if (!key) {
    const wd = new Date().getDay(), next = KEYS.map((k) => ({ k, d: [1, 2, 3, 4, 5, 6, 7].map((n) => addDays(today, n)).find((d) => sessionForDay(d) === k) }))
      .sort((a, b) => (a.d < b.d ? -1 : 1))[0];
    const what = { match: "Match day", training: "Rugby training", rest: "Rest day" }[dp.what]
      ?? (wd === p.matchDay ? "Match day" : (p.rugbyDays ?? [2, 6]).includes(wd) ? "Rugby training" : "Rest day");
    return `<section class="hero" aria-label="Training now"><div class="hgrid"><p class="k">Today</p><p class="k r">Next</p>
      <h2>${what}</h2><b class="fig">${dayName(next.d, { weekday: "short" })}</b>
      <p class="where">Nothing in the gym</p><span class="range">${esc(PLAN.sessions[next.k].name)}</span></div></section>`;
  }
  const rx = prescribe(key, today, { sessions, profile: p, recovery: whoop.recovery, rugby: dp.rugby });
  const lead = rx.items.find((e) => e.main && e.load != null) ?? rx.items.find((e) => e.load != null);
  return `<section class="hero" aria-label="Training now"><div class="hgrid"><p class="k">Today · ${phaseName(rx.phase)}</p><p class="k r">${lead ? esc(lead.name) : ""}</p>
    <h2${rx.name.length > 24 ? ` class="long"` : ""}>${esc(rx.name)}</h2><b class="fig">${lead ? kg(lead.load) : ""}</b>
    <p class="where">${rx.items.length} exercises</p><span class="range">${lead?.up ? "Up from last time" : ""}</span></div>
    <button class="btn primary gym-hero-btn" type="button" data-g="start" data-key="${key}">Start</button></section>`;
}

function home() {
  const today = todayString(), sessions = sessionsOf(rows), p = profile(), phase = phaseOf(today, p);
  const dp = dayPlan(today, dayRows(), p), key = dp.key, wk = week(today, sessions);
  let out = ctx.head("Train", phase === "over" ? "" : `Week ${planWeek(today)}`) + planHero(today, sessions, p, phase, dp);
  if (status) out += `<p class="foot mt-12">${esc(status)}</p>`;
  if (key && phase !== "over") {
    const rx = prescribe(key, today, { sessions, profile: p, recovery: whoop.recovery, rugby: dp.rugby });
    const warn = warnings(key, today, Date.now(), p, sessions.filter((s) => s.date === today), dayRows());
    for (const w of [...warn, ...rx.notes]) out += `<p class="foot mt-12${warn.includes(w) ? " warn" : ""}">${esc(w)}</p>`;
    out += `<ul class="group flat gym-folds mt-20">${ctx.fold("train-today", "Exercises", rx.items.length, rx.items.map((e) => ctx.row({ tag: "button",
      attrs: `data-g="open-ex" data-id="${esc(e.id)}"`, title: esc(e.name), sub: `${e.sets} × ${reps(e)}${e.kind === "load" ? ` · RIR ${e.rir}` : ""}`,
      trail: e.load != null ? `${kg(e.load)}${e.up ? " ↑" : ""}` : "", chev: true })).join(""))}</ul>`;
  }
  if (phase !== "over") out += `<ul class="group flat mt-12">${ctx.row({ tag: "button", attrs: `data-g="others"`, title: key ? "Do a different session" : "Do a session anyway", chev: true })}
    ${ctx.row({ tag: "button", attrs: `data-g="plan"`, title: "Edit plan", chev: true })}</ul>`;
  if (deloadOffer(sessions, today, p)) out += `<ul class="group mt-12">${ctx.row({ tag: "button", attrs: `data-g="deload"`, lead: ctx.ICON.sunrise,
    title: "Take a deload week", sub: "The last two sessions felt wrecked" })}</ul>`;
  out += `<h2 class="section">This week · <span class="count">${wk.count} of ${p.target ?? 4}</span></h2><ul class="group">${wk.slots.map((s) => ctx.row({
    lead: s.state === "done" ? ctx.ICON.check.replace('class="glyph"', 'class="glyph success"') : ctx.ICON.calendar,
    title: esc(PLAN.sessions[s.key].name), sub: dayName(s.day),
    trail: { done: "Done", missed: "Missed", today: "Today", later: "" }[s.state], trailCls: s.state === "missed" ? "warn" : "" })).join("")}</ul>`;
  out += log(today) + history(sessions);
  return out;
}

/** Bodyweight and food: one group, today's value trailing, each opening its sheet. */
function log(today) {
  const w = of("weight").find((r) => r.date === today)?.user_data?.kg, protein = ctx.food?.today().protein ?? 0;
  return `<h2 class="section">Log</h2><ul class="group flat">
    ${ctx.row({ tag: "button", attrs: `data-g="weight"`, title: "Bodyweight", trail: typeof w === "number" ? kg(w) : "Add", chev: true })}
    ${ctx.row({ tag: "button", attrs: `data-g="food"`, title: "Food", trail: protein ? `${protein} g protein` : "Add", chev: true })}</ul>`;
}

/** The last three sessions, each opening its detail, and the full History. */
function history(sessions) {
  if (!sessions.length) return "";
  const prs = prsOf(sessions);
  return `<h2 class="section">History</h2><ul class="group flat">${sessions.slice(0, 3).map((s) => sessionRow(s, prs)).join("")}
    ${ctx.row({ tag: "button", attrs: `data-g="history"`, title: "All sessions", trail: String(sessions.length), chev: true })}</ul>`;
}

const dur = (s) => (s.data.end > s.data.start ? `${Math.max(1, Math.round((s.data.end - s.data.start) / 60000))} min` : "");
const dateShort = (day) => dayName(day, { day: "numeric", month: "short" });
const PR = `<span class="gym-pr">PR</span>`;
/** A logged set in words: "117.5 kg × 5", "8 reps", "15 s". */
const setText = (kind, x, unit) => (kind === "load" ? `${x.load == null ? "–" : num(x.load)} kg × ${x.reps ?? "–"}` : kind === "time" ? `${x.reps ?? "–"} ${unit ?? "s"}` : `${x.reps ?? "–"} reps`);

function sessionRow(s, prs) {
  const n = setsOf(s).filter((_, i) => prs.has(`${s.id}:${i}`)).length, w = s.user_data?.whoop;
  return ctx.row({ tag: "button", attrs: `data-g="open-session" data-id="${esc(s.id)}"`, title: esc(s.title),
    sub: [dayName(s.date, { weekday: "short", day: "numeric", month: "short" }), dur(s), n ? `${n} PR${n > 1 ? "s" : ""}` : "", WRECKED[s.data.wrecked - 1]].filter(Boolean).join(" · "),
    trail: w?.strain != null ? `Strain ${w.strain.toFixed(1)}` : "", chev: true });
}

// ---------- Pushed screens ----------

export const depth = () => (profile() && !editing ? nav.length : 0);
/** The bar's title while a screen is pushed. */
export function title() {
  const sc = depth() ? nav.at(-1) : null;
  return !sc ? "Train" : sc.s === "history" ? "History" : sc.s === "plan" ? "Edit plan" : sc.s === "session" ? rowById(sc.id)?.title ?? "Session" : exName(sc.id);
}
/** Push and pop as the shell does it: the page slides 32 px and fades in over 280 ms on the drawer curve. */
function slide(dir, change) {
  change();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
    $("train").animate([{ opacity: 0, transform: `translateX(${dir === "push" ? 32 : -32}px)` }, { opacity: 1, transform: "none" }], { duration: 280, easing: DRAWER });
}
function go(screen) {
  if (nav.length) nav.at(-1).y = scrollY; else homeY = scrollY;
  slide("push", () => { nav.push(screen); ctx.rerender(); scrollTo(0, 0); });
}
/** The Train tab tapped again: back to its main screen. */
export function reset() { nav = []; }
export function back() {
  if (!nav.length) return;
  slide("pop", () => { nav.pop(); ctx.rerender(); scrollTo(0, nav.at(-1)?.y ?? homeY); });
}

const pushed = (sc) => (sc.s === "history" ? historyScreen() : sc.s === "session" ? sessionScreen(sc.id) : sc.s === "exercise" ? exerciseScreen(sc.id) : planScreen(sc.key));

function historyScreen() {
  const sessions = sessionsOf(rows), prs = prsOf(sessions);
  if (!sessions.length) return `${ctx.head("History")}<p class="foot mt-12">Finished sessions show here.</p>`;
  let out = ctx.head("History", `${sessions.length} session${sessions.length > 1 ? "s" : ""}`), month = "";
  for (const s of sessions) {
    const m = dayName(s.date, { month: "long", year: "numeric" });
    if (m !== month) out += `${month ? "</ul>" : ""}<p class="caption-h">${m}</p><ul class="group flat">`;
    month = m;
    out += sessionRow(s, prs);
  }
  return `${out}</ul>`;
}

/** One session: its ticked sets by exercise (tap one to fix it), Repeat, and Delete with Undo. */
function sessionScreen(id) {
  const s = rowById(id);
  if (!s || s.user_data?.deleted) return `${ctx.head("Session")}<p class="foot mt-12">This session was deleted.</p>`;
  const prs = prsOf(sessionsOf(rows)), groups = [];
  setsOf(s).forEach((x, i) => {
    if (!x.done) return;
    const k = `${x.ex}|${x.swap ?? ""}`;
    let g = groups.find((y) => y.k === k);
    if (!g) groups.push(g = { k, ex: x.ex, swap: x.swap, sets: [] });
    g.sets.push([x, i]);
  });
  const w = s.user_data?.whoop;
  let out = ctx.head(s.title, [dayName(s.date, { weekday: "long", day: "numeric", month: "long" }), dur(s), WRECKED[s.data.wrecked - 1], w?.strain != null ? `Strain ${w.strain.toFixed(1)}` : ""].filter(Boolean).join(" · "));
  if (!groups.length) out += `<p class="foot mt-12">No sets were ticked.</p>`;
  for (const g of groups) {
    const e = exOf(g.ex), kind = e?.kind ?? "load";
    out += g.swap ? `<h2 class="section">${esc(g.swap)}</h2><p class="foot">In place of ${esc(exName(g.ex, s))}</p>`
      : `<h2 class="section"><button class="gym-ex-link" type="button" data-g="open-ex" data-id="${esc(g.ex)}">${esc(exName(g.ex, s))}${ctx.ICON.chev}</button></h2>`;
    out += `<ul class="group flat">${g.sets.map(([x, i], n) => ctx.row({ tag: "button", attrs: `data-g="past-set" data-id="${esc(s.id)}" data-i="${i}"`,
      title: `Set ${n + 1}${prs.has(`${s.id}:${i}`) ? PR : ""}`, sub: kind === "load" && x.rir != null ? `RIR ${x.rir}` : "", trail: esc(setText(kind, x, e?.unit)), chev: true })).join("")}</ul>`;
  }
  return `${out}<div class="gym-actions">${!live && PLAN.sessions[s.data.key] ? `<button class="btn primary" type="button" data-g="start" data-key="${s.data.key}">Repeat this session</button>` : ""}
    <button class="btn plain gym-danger" type="button" data-g="del-session" data-id="${esc(s.id)}">Delete session</button></div>`;
}

/** Runs of the same weight: "117.5 kg: 5, 5, 4 · 120 kg: 3". */
function setsLine(sets, kind) {
  if (kind !== "load") return sets.map((x) => x.reps).join(", ");
  const runs = [];
  for (const x of sets) { const l = num(x.load ?? 0); if (runs.at(-1)?.l === l) runs.at(-1).r.push(x.reps); else runs.push({ l, r: [x.reps] }); }
  return runs.map((r) => `${r.l} kg: ${r.r.join(", ")}`).join(" · ");
}

/** One exercise: the records in the hero, a chart, the records list and every session that had it. */
function exerciseScreen(id) {
  const e = exOf(id), name = exName(id), kind = e?.kind ?? "load", log = exerciseLog(id, sessionsOf(rows)), r = records(log);
  let out = ctx.head(name, e?.note ?? "");
  if (!r) return `${out}<p class="foot mt-12">Nothing logged yet. Tick a set of it in a session and it shows here.</p>`;
  const last = log.at(-1), n = log.length, big = (v) => v.toLocaleString("en-GB");
  if (kind === "load") {
    out += `<section class="hero" aria-label="Records"><div class="hgrid"><p class="k">Heaviest</p><p class="k r">Best e1RM</p>
      <h2>${num(r.heaviest.load)} kg × ${r.heaviest.reps}</h2><b class="fig">${r.e1 ? `${num(r.e1.value)} kg` : "–"}</b>
      <p class="where">Last ${dateShort(last.date)}</p><span class="range">${n} session${n > 1 ? "s" : ""}</span></div></section>
      <div class="gym-chart-ctl">${seg("chart-m", chartM, ["Weight", "e1RM", "Volume"], "Chart")}${seg("chart-r", chartR, ["4W", "All"], "Range")}</div>
      <figure class="gym-chart" id="gym-chart">${chart(log)}</figure>
      <h2 class="section">Records</h2><ul class="group flat">
      ${ctx.row({ title: "Heaviest", sub: dateShort(r.heaviest.date), trail: `${num(r.heaviest.load)} kg × ${r.heaviest.reps}` })}
      ${r.e1 ? ctx.row({ title: "Best e1RM", sub: dateShort(r.e1.date), trail: `${num(r.e1.value)} kg` }) : ""}
      ${ctx.row({ title: "Best set volume", sub: `${num(r.set.load)} kg × ${r.set.reps}`, trail: `${big(r.set.volume)} kg` })}
      ${ctx.row({ title: "Best session volume", sub: dateShort(r.session.date), trail: `${big(r.session.volume)} kg` })}
      ${r.at.map((x) => ctx.row({ title: `Best at ${x.reps} rep${x.reps > 1 ? "s" : ""}`, sub: dateShort(x.date), trail: `${num(x.load)} kg` })).join("")}</ul>`;
  } else {
    out += `<h2 class="section">Records</h2><ul class="group flat">${ctx.row({ title: kind === "time" ? "Longest" : "Most reps", sub: dateShort(r.mostReps.date),
      trail: esc(setText(kind, r.mostReps, e?.unit)) })}</ul>`;
  }
  return `${out}<h2 class="section">History</h2><ul class="group flat">${[...log].reverse().map((l) => ctx.row({ tag: "button",
    attrs: `data-g="open-session" data-id="${esc(l.id)}"`, title: dayName(l.date, { weekday: "short", day: "numeric", month: "short" }),
    sub: esc(setsLine(l.sets, kind)), trail: kind === "load" && l.e1 ? `${num(l.e1)} kg` : "", chev: true })).join("")}</ul>
    ${kind === "load" ? `<p class="foot mt-12">e1RM estimates a one-rep max from weight, reps and reps in reserve (Epley). It skips sets over 12 reps.</p>` : ""}`;
}

/** The chart: one line per session, its value on the right axis; dates under the ends. */
function chart(log) {
  const key = ["top", "e1", "volume"][chartM], what = ["Top weight", "Best e1RM", "Volume"][chartM];
  const from = chartR === 0 ? addDays(todayString(), -27) : "";
  const pts = log.filter((l) => l.date >= from && l[key] > 0).map((l) => ({ d: l.date, v: l[key] }));
  if (!pts.length) return `<p class="foot">${chartR === 0 ? "Nothing in the last 4 weeks." : "No weights logged yet."}</p>`;
  const W = 340, H = 168, L = 6, R = 44, T = 10, B = 26, t = (d) => Date.parse(d + "T12:00");
  const t0 = t(pts[0].d), t1 = t(pts.at(-1).d);
  // Gridlines on round numbers: the smallest 1–2–2.5–5 step that covers the range in two.
  const vmin = Math.min(...pts.map((p) => p.v)), vmax = Math.max(...pts.map((p) => p.v)), raw = Math.max(vmax - vmin, vmax * 0.04) / 2;
  const mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  let lo = Math.floor(vmin / step) * step, hi = lo + 2 * step;
  if (hi < vmax) hi = Math.ceil(vmax / step) * step;
  if (lo === vmin && vmin - step >= 0 && hi - lo < 3 * step) { lo -= step; } // keep the first point off the bottom edge
  const x = (d) => (t1 === t0 ? (W - R) / 2 : L + 6 + ((t(d) - t0) / (t1 - t0)) * (W - R - L - 12));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const label = (v) => (v >= 1000 ? `${num(Math.round(v / 100) / 10)}k` : num(v));
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const grid = ticks.map((v) => `<line class="grid" x1="0" x2="${W - R + 6}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
    <text x="${W}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${label(v)}</text>`).join("");
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)} ${y(p.v).toFixed(1)}`).join("");
  const dots = pts.map((p, i) => `<circle class="dot${i === pts.length - 1 ? " last" : ""}" cx="${x(p.d).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${i === pts.length - 1 ? 4.5 : 3.5}"/>`).join("");
  const a = pts[0], z = pts.at(-1), unit = (v) => `${num(Math.round(v * 10) / 10)} kg`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${what}: ${unit(a.v)} on ${dateShort(a.d)}${pts.length > 1 ? ` to ${unit(z.v)} on ${dateShort(z.d)}, ${pts.length} sessions` : ""}">
    ${grid}<path class="line" d="${path}"/>${dots}
    <text x="${x(a.d).toFixed(1)}" y="${H - 6}" text-anchor="${pts.length > 1 ? "start" : "middle"}">${dateShort(a.d)}</text>
    ${pts.length > 1 ? `<text x="${x(z.d).toFixed(1)}" y="${H - 6}" text-anchor="end">${dateShort(z.d)}</text>` : ""}</svg>
    <figcaption class="foot">${what} per session, kg</figcaption>`;
}

// ---------- Edit plan: this user's copy of the Autumn plan, saved on the profile row (gym.js planOf) ----------

const PLAN_ORDER = ["A", "C", "D", "B"]; // Monday first
const GRIP = `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>`;
const restText = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
const planItems = (key) => planOf(profile()).sessions[key].items.map((e) => ({ ...e }));
/** Only what differs from the Autumn plan is stored, so a fix to the plan's own rules still reaches edited sessions. */
const lean = (e) => { const d = exerciseById(e.id); return d ? Object.fromEntries(Object.entries(e).filter(([k, v]) => k === "id" || JSON.stringify(v) !== JSON.stringify(d[k]))) : e; };
function savePlan(key, items) {
  const p = profileRow(), plan = { ...(p.user_data.plan ?? {}) }, list = items.map(lean);
  if (JSON.stringify(list) === JSON.stringify(PLAN.sessions[key].items.map((e) => ({ id: e.id })))) delete plan[key]; else plan[key] = list;
  patch(p, { plan });
  redraw();
}
function moveExercise(from, to, key = nav.at(-1).key) {
  const items = planItems(key), [x] = items.splice(from, 1);
  items.splice(to, 0, x);
  savePlan(key, items);
}
function removeExercise(i, key = nav.at(-1).key) {
  const before = planItems(key);
  if (before.length < 2) { ctx.toast("A session needs one exercise."); return redraw(); }
  savePlan(key, before.filter((_, j) => j !== i));
  ctx.toast(`Removed ${before[i].name}`, () => savePlan(key, before));
}

function planScreen(key) {
  return `${ctx.head("Edit plan", "Changes start with the next session.")}
    ${seg("plan-key", PLAN_ORDER.indexOf(key), PLAN_ORDER.map((k) => DAYS[(PLAN.sessions[k].day + 6) % 7]), "Session")}
    <div id="gym-plan-list">${planList(key)}</div>`;
}
function planList(key) {
  const items = planOf(profile()).sessions[key].items, own = !!profile()?.plan?.[key];
  return `<p class="caption-h">${esc(PLAN.sessions[key].name)}${own ? " · edited" : ""}</p>
    <ul class="group flat gym-plan">${items.map((e, i) => `<li data-i="${i}"><div class="gym-del" aria-hidden="true">Remove</div>
      <div class="slide"><button class="row" type="button" data-g="plan-ex" data-i="${i}"><span class="text"><span class="title">${esc(e.name)}</span>
        <span class="subtitle">${e.sets} × ${reps(e)} · ${e.rest ? `rest ${restText(e.rest)}` : "no rest"}</span></span>${ctx.ICON.chev}</button>
      <button class="gym-grip" type="button" data-i="${i}" aria-label="Move ${esc(e.name)}, ${i + 1} of ${items.length}. Up and down arrows move it.">${GRIP}</button></div></li>`).join("")}</ul>
    <ul class="group flat mt-12">${ctx.row({ tag: "button", attrs: `data-g="plan-add"`, title: "Add exercise", titleCls: "gym-link" })}</ul>
    <p class="foot mt-12">Swipe left to remove. Drag the lines to reorder.</p>
    ${own ? `<div class="gym-actions"><button class="btn plain" type="button" data-g="plan-reset">Reset to the Autumn plan</button></div>` : ""}`;
}

// Gestures on the plan's rows: swiped left past 40% (or flicked past 20%), a row is removed with Undo; the grip drags it.
function planGestures(root) {
  let g = null;
  root.addEventListener("pointerdown", (ev) => {
    const li = ev.target.closest(".gym-plan > li");
    if (!li || g || ev.button > 0) return;
    const grip = ev.target.closest(".gym-grip");
    g = { li, id: ev.pointerId, x: ev.clientX, y: ev.clientY, mode: "", hist: [] };
    if (grip) { grip.setPointerCapture?.(ev.pointerId); dragStart(g); }
  });
  root.addEventListener("pointermove", (ev) => {
    if (!g || ev.pointerId !== g.id) return;
    const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
    if (g.mode === "drag") return dragMove(g, dy);
    if (!g.mode) {
      if ((Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) || dx > 10) { g = null; return; }
      if (dx > -8) return;
      g.mode = "swipe"; g.x -= 8; g.li.dataset.dir = "l";
    }
    g.hist.push([ev.timeStamp, ev.clientX]);
    while (g.hist.length > 2 && ev.timeStamp - g.hist[0][0] > 100) g.hist.shift();
    g.li.querySelector(".slide").style.transform = `translate3d(${Math.min(0, ev.clientX - g.x)}px,0,0)`;
  });
  const up = (ev) => {
    if (!g || ev.pointerId !== g.id) return;
    const { li, mode, hist: h } = g, x0 = g.x;
    g = null;
    if (!mode) return;
    noClick = Date.now() + 350;
    if (mode === "drag") return dragEnd(li._drag, ev.type === "pointercancel");
    const el = li.querySelector(".slide"), w = li.offsetWidth, dx = Math.min(0, ev.clientX - x0);
    const v = h.length > 1 ? (h.at(-1)[1] - h[0][1]) / Math.max(1, h.at(-1)[0] - h[0][0]) : 0;
    const commit = ev.type !== "pointercancel" && (dx < -w * 0.4 || (v < -0.11 && dx < -w * 0.2));
    const end = () => { if (commit) removeExercise(Number(li.dataset.i)); else { el.style.transform = ""; delete li.dataset.dir; } };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return end();
    el.animate([{ transform: `translate3d(${dx}px,0,0)` }, { transform: `translate3d(${commit ? -w : 0}px,0,0)` }], { duration: commit ? 200 : 240, easing: DRAWER }).onfinish = end;
  };
  root.addEventListener("pointerup", up);
  root.addEventListener("pointercancel", up);
  root.addEventListener("keydown", (ev) => { // the grip by keyboard: up and down arrows move the exercise one place
    const grip = ev.target.closest?.(".gym-grip");
    if (!grip || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
    ev.preventDefault();
    const i = Number(grip.dataset.i), to = i + (ev.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= planItems(nav.at(-1).key).length) return;
    moveExercise(i, to);
    $("train").querySelector(`.gym-grip[data-i="${to}"]`)?.focus();
  });
}
function dragStart(g) {
  const lis = [...g.li.parentElement.children], from = lis.indexOf(g.li);
  g.mode = "drag";
  g.li._drag = { li: g.li, lis, from, to: from, h: g.li.offsetHeight, mids: lis.map((l) => { const r = l.getBoundingClientRect(); return r.top + r.height / 2; }) };
  g.li.parentElement.classList.add("dragging"); g.li.classList.add("lifted");
}
function dragMove(g, dy) {
  const d = g.li._drag, c = d.mids[d.from] + dy;
  g.li.style.transform = `translate3d(0,${dy}px,0)`;
  d.to = d.mids.filter((m, j) => j !== d.from && m < c).length;
  d.lis.forEach((l, j) => {
    if (j === d.from) return;
    const s = j > d.from && j <= d.to ? -d.h : j < d.from && j >= d.to ? d.h : 0;
    l.style.transform = s ? `translate3d(0,${s}px,0)` : "";
  });
}
function dragEnd(d, cancel) {
  d.li.parentElement?.classList.remove("dragging"); d.li.classList.remove("lifted");
  for (const l of d.lis) l.style.transform = "";
  if (!cancel && d.to !== d.from) moveExercise(d.from, d.to);
}

/** Account → Train: WHOOP and the setup live here, not on the Train page. */
export function accountRows() {
  const w = whoop.connected === true ? `Connected${whoop.recovery != null ? ` · ${whoop.recovery}%` : ""}` : "Connect";
  return `${ctx.row({ tag: whoop.connected === true ? "div" : "button", attrs: `data-g="whoop"`, title: "WHOOP", trail: w, chev: whoop.connected !== true })}
    ${ctx.row({ tag: "button", attrs: `data-g="edit"`, title: "Edit setup", chev: true })}`;
}

// ---------- Setup (research doc §2): four short steps, every answer editable later ----------
// Only what the plan uses: the health screen, injuries, bodyweight (protein target), a recent heavy set per main lift
// (start loads), and the week (match day for R2, rugby days for the Today line, sessions a week for the count).

const PARQ = [
  "A doctor has said you have a heart condition or high blood pressure",
  "You get chest pain at rest, in daily life or when you exercise",
  "You've lost balance from dizziness, or lost consciousness, in the last 12 months",
  "You have another chronic medical condition",
  "You take prescribed medicine for a chronic condition",
  "You have a bone, joint or soft-tissue problem that more activity could make worse",
  "A doctor has said you should only do medically supervised activity",
];
const LIFTS = [["bench", "Bench press"], ["squat", "Back squat"], ["deadlift", "Deadlift"], ["row", "Barbell row"]];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // index i is weekday (i + 1) % 7
const STEPS = ["Health", "Injuries", "You", "Week"];
let draft = null; // the setup being filled in: {step, ...answers}

function startSetup() {
  const a = profile() ?? {};
  draft = { step: 0, parq: PARQ.map((_, i) => !!a[`parq${i}`]), injury: a.injury ?? "", surgery: !!a.surgery, concussion: !!a.concussion,
    weight: a.weight ?? "", lifts: structuredClone(a.lifts ?? {}), rugbyDays: a.rugbyDays ?? [2, 6], matchDay: a.matchDay ?? 3, target: a.target ?? 4 };
}

/** A multi-choice row, built like a task row: the tick on the left, pressed when true. */
const pick = (g, i, title, on) => `<li class="task gym-pick${on ? " done" : ""}${just === `${g}${i}` ? " just" : ""}">
  <button class="tick" type="button" data-g="${g}" data-i="${i}" aria-pressed="${on}" aria-label="${esc(title)}">${TICK}</button>
  <button class="row" type="button" data-g="${g}" data-i="${i}" tabindex="-1" aria-hidden="true"><span class="text"><span class="title">${esc(title)}</span></span></button></li>`;
const field = (label, g, value, unit, extra = "") => `<li><label class="row"><span class="text"><span class="title">${esc(label)}</span></span>
  <span class="gym-field"><input class="gym-input" type="text" inputmode="decimal" data-g="${g}" value="${esc(value)}" ${extra}>${unit ? `<span class="gym-unit">${unit}</span>` : ""}</span></label></li>`;
const check = `<svg class="gym-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4.25 4.25L18.5 7.5"/></svg>`;
const stepper = (g, value, label, attrs = "") => `<span class="gym-stepper" role="group" aria-label="${label}">
  <button type="button" class="gym-step" data-g="${g}" data-v="-1" ${attrs} aria-label="Less">−</button><b>${value ?? "–"}</b>
  <button type="button" class="gym-step" data-g="${g}" data-v="1" ${attrs} aria-label="More">+</button></span>`;

function setup() {
  if (!draft) startSetup();
  const d = draft, last = d.step === STEPS.length - 1;
  let body = "";
  if (d.step === 0) body = `${ctx.head("Health check", "Tick what applies.")}
    <ul class="group flat gym-picks mt-20">${PARQ.map((q, i) => pick("parq", i, q, d.parq[i])).join("")}</ul>
    <p class="foot mt-12">${d.parq.some(Boolean) ? "See a doctor or physio before training hard. You can still set up." : "Nothing ticked means you're clear to train."} From the PAR-Q+.</p>`;
  if (d.step === 1) body = `${ctx.head("Injuries")}
    <ul class="group flat mt-20"><li><input class="gym-text" type="text" data-g="injury" value="${esc(d.injury)}" placeholder="Anything that hurts or limits you" aria-label="Injuries" autocapitalize="sentences"></li></ul>
    <ul class="group flat gym-picks mt-20">${pick("surgery", 0, "Surgery in the last 12 months", d.surgery)}${pick("concussion", 0, "Concussion this season", d.concussion)}</ul>
    ${d.concussion ? `<p class="foot mt-12">Follow World Rugby's graduated return before lifting heavy.</p>` : ""}`;
  if (d.step === 2) body = `${ctx.head("You")}
    <ul class="group flat mt-20">${field("Bodyweight", "bw", d.weight, "kg", `aria-label="Bodyweight in kg"`)}</ul>
    <h2 class="section">A recent heavy set</h2>
    <ul class="group flat">${LIFTS.map(([id, name]) => `<li><div class="row"><span class="text"><span class="title">${name}</span></span>
      <span class="gym-field"><input class="gym-input" type="text" inputmode="decimal" data-g="lift-kg" data-id="${id}" value="${esc(d.lifts[id]?.kg ?? "")}" placeholder="kg" aria-label="${name} kg">
      <span class="gym-unit">×</span><input class="gym-input short" type="text" inputmode="numeric" data-g="lift-reps" data-id="${id}" value="${esc(d.lifts[id]?.reps ?? "")}" placeholder="reps" aria-label="${name} reps"></span></div></li>`).join("")}</ul>
    <p class="foot mt-12">Leave any blank to start from the plan's loads.</p>`;
  if (d.step === 3) body = `${ctx.head("Week")}
    <h2 class="section">Rugby training</h2>
    <div class="gym-chips" role="group" aria-label="Rugby training days">${DAYS.map((n, i) => { const wd = (i + 1) % 7, on = d.rugbyDays.includes(wd);
      return `<button type="button" data-g="rugby" data-v="${wd}" aria-pressed="${on}" aria-label="${n}">${on ? check : ""}<span>${n[0]}</span></button>`; }).join("")}</div>
    <h2 class="section">Match day</h2>
    ${seg("match", DAYS.findIndex((_, i) => (i + 1) % 7 === d.matchDay), DAYS.map((n) => n[0]), "Match day")}
    <ul class="group flat mt-28"><li><div class="row"><span class="text"><span class="title">Gym sessions a week</span></span>${stepper("target", d.target, "Gym sessions a week")}</div></li></ul>`;
  return `<p class="gym-steps" aria-label="Step ${d.step + 1} of ${STEPS.length}">${STEPS.map((_, i) => `<i class="${i <= d.step ? "on" : ""}"></i>`).join("")}</p>
    ${body}
    <div class="gym-actions"><button class="btn primary" type="button" data-g="next">${last ? (profile() ? "Save" : "Start training") : "Continue"}</button>
    ${d.step > 0 ? `<button class="btn plain" type="button" data-g="back">Back</button>` : profile() ? `<button class="btn plain" type="button" data-g="cancel">Cancel</button>` : ""}</div>`;
}

function finishSetup() {
  const d = draft, n = (v) => { const x = parseFloat(String(v).replace(",", ".")); return Number.isFinite(x) && x > 0 ? x : null; };
  const a = { injury: d.injury.trim(), surgery: d.surgery, concussion: d.concussion, weight: n(d.weight), rugbyDays: d.rugbyDays, matchDay: d.matchDay,
    target: d.target, lifts: {}, starts: {}, avoid: profile()?.avoid ?? [], deloadFrom: profile()?.deloadFrom ?? null };
  d.parq.forEach((v, i) => { a[`parq${i}`] = v; });
  for (const [id] of LIFTS) {
    const w = n(d.lifts[id]?.kg), r = n(d.lifts[id]?.reps);
    if (w && r) { a.lifts[id] = { kg: w, reps: Math.round(r) }; const s = startFrom(w, Math.round(r)); if (s) a.starts[id] = s; }
  }
  const p = profileRow();
  if (p) patch(p, a); else add({ id: "gym-profile", date: null, title: "Train profile", data: { type: "profile" }, user_data: { ...a, userAt: Date.now() } });
  status = d.parq.some(Boolean) || d.concussion ? "You ticked a health question. See a doctor or physio before training hard." : "";
  draft = null; editing = false;
  ctx.rerender();
  scrollTo(0, 0);
}

// ---------- The session in progress ----------

const elapsed = () => `${Math.max(0, Math.floor((Date.now() - live.start) / 60000))} min`;
const active = () => live.items.filter((e) => !live.skipped.includes(e.id));

function startSession(key) {
  const today = todayString(), sessions = sessionsOf(rows), rugby = dayPlan(today, dayRows(), profile()).rugby;
  const rx = prescribe(key, today, { sessions, profile: profile(), recovery: whoop.recovery, rugby });
  live = { key, name: rx.name, start: Date.now(), feel: null, deload: rx.phase === "deload", rest: null, skipped: [], swaps: {},
    items: rx.items.map((e) => {
      const last = lastTime(e.id, sessions)?.sets ?? [];
      return { id: e.id, name: e.name, kind: e.kind, unit: e.unit, lo: e.lo, hi: e.hi, rir: e.rir, rest: e.rest, note: e.note ?? "", up: e.up, alts: e.alts ?? [],
        sets: Array.from({ length: e.sets }, (_, i) => ({ load: e.load, reps: e.kind === "time" ? e.hi : (last[i]?.reps ?? e.hi), rir: null, done: false })) };
    }) };
  token().then((t) => { jwt = t ?? jwt; }).catch(() => {});
  saveLive();
  nav = [];
  awake();
  ctx.closeSheet($("train-sheet"));
  ctx.rerender();
  scrollTo(0, 0);
}

const setValue = (e, s) => (e.kind === "load" ? `${s.load == null ? "–" : num(s.load)} kg × ${s.reps ?? "–"}` : e.kind === "time" ? `${e.hi} ${e.unit ?? "s"}` : `${s.reps ?? "–"} reps`);

/** Where the session is: the first set not ticked, and how many are done out of all. */
function progress() {
  const sets = active().flatMap((e) => e.sets), done = sets.filter((s) => s.done).length;
  for (const e of active()) { const i = e.sets.findIndex((s) => !s.done); if (i >= 0) return { e, i, done, all: sets.length }; }
  return { e: null, i: -1, done, all: sets.length };
}

/** The Screen Wake Lock while a session runs, so the phone doesn't lock between sets. Where it's refused (Low Power Mode,
 *  an older iOS) the screen sleeps as before. */
function awake() {
  if (!live || wake || document.visibilityState !== "visible" || !navigator.wakeLock) return;
  // Each request owns `wake` only while it is the current one, so a late release or refusal never clears a newer lock.
  const p = navigator.wakeLock.request("screen").then((l) => {
    l.addEventListener("release", () => { if (wake === p) wake = null; });
    if (!live || wake !== p) l.release();
    return l;
  }, () => { if (wake === p) wake = null; return null; });
  wake = p;
}
function sleep() { const w = wake; wake = null; w?.then((l) => l?.release()).catch(() => {}); }

/** The live hero: the exercise now, its set and value; the rest countdown in the figure while resting. */
function liveHero() {
  const { e, i, done, all } = progress(), name = e ? live.swaps[e.id] ?? e.name : "All sets done";
  const k = live.rest ? "Rest" : e ? `Set ${i + 1} of ${e.sets.length}` : "";
  const fig = live.rest ? `<b class="fig" id="gym-rest-fig">${restLeft()}</b>` : e ? `<b class="fig">${esc(setValue(e, e.sets[i]))}</b>` : `<span></span>`;
  return `<section class="hero" aria-label="Session now"><div class="hgrid"><p class="k">${live.rest ? "Up next" : "Now"}</p><p class="k r">${k}</p>
    <h2${name.length > 24 ? ` class="long"` : ""}>${esc(name)}</h2>${fig}</div>
    <div class="track" role="progressbar" aria-label="Sets done" aria-valuemin="0" aria-valuemax="${all}" aria-valuenow="${done}">
      <time id="gym-elapsed">${elapsed()}</time><span class="rail"><i style="transform:scaleX(${all ? (done / all).toFixed(3) : 0})"></i></span><span>${done} of ${all}</span></div></section>`;
}
/** The 30-second clock and the rest figure change without redrawing the lists. */
function paintLive() {
  const el = $("gym-elapsed");
  if (el) el.textContent = elapsed();
}

function liveScreen() {
  let out = `${ctx.head(live.name, live.deload ? "Deload" : "")}${liveHero()}
    <p class="caption-h mt-20">How do you feel?</p>${seg("feel", live.feel == null ? null : live.feel - 1, FEEL, "How do you feel")}`;
  const sessions = sessionsOf(rows);
  live.items.forEach((e, ei) => {
    const skipped = live.skipped.includes(e.id), swapped = !!live.swaps[e.id], name = live.swaps[e.id] ?? e.name;
    const plain = !swapped && e.kind !== "time", last = plain ? lastTime(e.id, sessions) : null;
    let b = plain ? bestOf(e.id, sessions) : null;
    if (!b?.n) b = null; // no history yet: this session is the baseline, so nothing in it is a PR
    out += `<div class="gym-ex-head"><h2 class="section">${swapped ? esc(name) : `<button class="gym-ex-link" type="button" data-g="open-ex" data-id="${esc(e.id)}">${esc(name)}${ctx.ICON.chev}</button>`}</h2>
      <button class="gym-more" type="button" data-g="menu" data-e="${ei}" aria-label="More for ${esc(name)}">${ctx.ICON.more}</button></div>
      <p class="foot">${skipped ? "Skipped" : `${e.sets.length} × ${reps(e)}${e.kind === "load" ? ` · RIR ${e.rir}` : ""}${e.up ? " · weight up" : ""}${!live.swaps[e.id] && e.note ? ` · ${esc(e.note)}` : ""}`}</p>`;
    if (skipped) return;
    // Each set: the tick (the big target), "Last 115 × 5" under its number (tap to use it), and the value (tap to change it).
    out += `<ul class="group gym-sets mt-12">${e.sets.map((s, si) => {
      const pr = b && s.done && beats(b, s), l = last && (last.sets[si] ?? last.sets.at(-1));
      if (b && s.done) absorb(b, s);
      const lastLine = l ? `<button class="gym-last" type="button" data-g="fill" data-e="${ei}" data-s="${si}" aria-label="Use last time's ${esc(setText(e.kind, l))}">Last ${e.kind === "load" ? `${num(l.load ?? 0)} × ${l.reps}` : `${l.reps} reps`}</button>` : "";
      return `<li class="task${s.done ? " done" : ""}${just === `set${ei}-${si}` ? " just" : ""}">
      <button class="tick" type="button" data-g="set" data-e="${ei}" data-s="${si}" aria-pressed="${s.done}" aria-label="Set ${si + 1}, ${esc(setValue(e, s))}: ${s.done ? "done" : "not done"}${pr ? ", a record" : ""}">${TICK}</button>
      ${e.kind === "time" ? `<div class="row"><span class="text"><span class="title">Set ${si + 1}</span></span><span class="trail">${esc(setValue(e, s))}</span></div>`
        : `<div class="row"><span class="text"><span class="title">Set ${si + 1}${pr ? PR : ""}</span>${lastLine || s.rir != null ? `<span class="subtitle gym-sub">${lastLine}${lastLine && s.rir != null ? " · " : ""}${s.rir != null ? `RIR ${s.rir}` : ""}</span>` : ""}</span>
          <button class="gym-val" type="button" data-g="edit-set" data-e="${ei}" data-s="${si}" aria-label="Change set ${si + 1}"><span class="trail">${esc(setValue(e, s))}</span>${ctx.ICON.chev}</button></div>`}</li>`;
    }).join("")}</ul>`;
  });
  out += `<div class="gym-actions"><button class="btn primary" type="button" data-g="finish">Finish</button>
    <button class="btn plain gym-danger" type="button" data-g="discard">Discard session</button></div>${restPill()}`;
  return out;
}

/** The rest pill, on the session and on any screen pushed over it, so a rest keeps counting while you look something up. */
const restPill = () => `<div class="gym-rest chrome" ${live?.rest ? "" : "hidden"} role="timer" aria-live="off"><span>Rest</span><b id="gym-rest-left">${restLeft()}</b>
  <button class="gym-adj" type="button" data-g="rest-adj" data-v="-15" aria-label="15 seconds less">−15</button>
  <button class="gym-adj" type="button" data-g="rest-adj" data-v="15" aria-label="15 seconds more">+15</button>
  <button class="btn small secondary" type="button" data-g="skip-rest">Skip</button></div>`;

function restLeft() {
  const s = live?.rest ? Math.max(0, Math.ceil((live.rest.until - Date.now()) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** −15 s / +15 s on the rest pill; the lock-screen push moves with it. */
function restAdjust(v) {
  const r = live?.rest;
  if (!r) return;
  r.until = Math.max(Date.now() + 1000, r.until + v * 1000);
  clearTimeout(quietTimer);
  quietTimer = setTimeout(restQuiet, Math.max(0, r.until - Date.now() - 10_000));
  if (r.server) restWrite(r.until, r.body);
  saveLive();
  for (const id of ["gym-rest-left", "gym-rest-fig"]) { const el = $(id); if (el) el.textContent = restLeft(); }
}

function tick() {
  clearInterval(restTimer);
  restTimer = setInterval(() => {
    if (!live?.rest) return clearInterval(restTimer);
    for (const id of ["gym-rest-left", "gym-rest-fig"]) { const el = $(id); if (el) el.textContent = restLeft(); }
    if (Date.now() >= live.rest.until) { live.rest = null; saveLive(); clearInterval(restTimer); ctx.rerender(); }
  }, 1000);
}

function toggleSet(ei, si) {
  const e = live.items[ei], s = e.sets[si];
  s.done = !s.done;
  if (s.done) just = `set${ei}-${si}`;
  if (s.done && e.kind === "load" && s.rir == null && si > 0) s.rir = e.sets[si - 1].rir; // RIR carries to the next set until changed
  const next = s.done && nextSet(ei, si);
  restStop();
  if (next && e.rest > 0) restStart(e.rest, `${next.name} · set ${next.set} of ${next.of}`);
  saveLive();
  ctx.rerender();
}
function nextSet(ei, si) {
  for (let i = ei; i < live.items.length; i++) {
    const e = live.items[i];
    if (live.skipped.includes(e.id)) continue;
    const j = e.sets.findIndex((s, k) => !s.done && (i > ei || k > si));
    if (j >= 0) return { name: live.swaps[e.id] ?? e.name, set: j + 1, of: e.sets.length };
  }
  return null;
}

function finish(wrecked) {
  const today = todayString(), end = Date.now();
  const sets = live.items.flatMap((e) => live.skipped.includes(e.id) ? [] : e.sets.map((s) => ({ ex: e.id, load: s.load, reps: s.reps, rir: s.rir, done: s.done,
    ...(live.swaps[e.id] ? { swap: live.swaps[e.id] } : {}) })));
  add({ id: `you-gym-${crypto.randomUUID()}`, date: today, title: live.name,
    data: { type: "session", key: live.key, start: live.start, end, feel: live.feel, wrecked, deload: live.deload, sets, skipped: live.skipped, swaps: live.swaps,
      names: Object.fromEntries(live.items.map((e) => [e.id, e.name])) },
    user_data: {} });
  restStop();
  live = null; saveLive(); sleep();
  status = "Saved. WHOOP strain comes back once the band has scored the workout.";
  ctx.closeSheet($("train-sheet"));
  ctx.rerender();
  scrollTo(0, 0);
  setTimeout(pullStrain, 4 * 60000);
}

/** Discard at once, with the shell's 5-second Undo (the Today pattern), instead of asking first. */
function discard() {
  const kept = live;
  restStop();
  live = null; saveLive(); sleep();
  ctx.rerender();
  scrollTo(0, 0);
  ctx.toast("Session discarded", () => { live = { ...kept, rest: null }; saveLive(); awake(); ctx.rerender(); });
}

// ---------- The sheet (one dialog, one mode at a time; the shell opens, drags and closes it) ----------

function openSheet(mode, data = {}) {
  sheet = { mode, ...data };
  paintSheet();
  ctx.openSheet($("train-sheet"));
}
const closeSheet = () => ctx.closeSheet($("train-sheet"));

function sheetHead(title, sub = "") {
  return `<div class="grabber" aria-hidden="true"></div><div class="sheet-head"><div class="head-text">
    <h2 class="headline" id="train-sheet-title">${esc(title)}</h2>${sub ? `<p class="foot">${esc(sub)}</p>` : ""}</div>
    <button class="close" type="button" data-close aria-label="Close">${ctx.ICON.close}</button></div>`;
}

function paintSheet() {
  const dlg = $("train-sheet");
  if (!sheet || !dlg) return;
  let html = "";
  const e = live?.items[sheet.ei];
  if (sheet.mode === "set") {
    const { s, kind, name, sub } = cur();
    html = `${sheetHead(name, sub)}
      <ul class="group">${kind === "load" ? `<li><div class="row"><span class="text"><span class="title">Weight</span><span class="subtitle">kg</span></span>
          <input class="gym-input" type="text" inputmode="decimal" data-g="set-load" value="${s.load ?? ""}" aria-label="Weight in kg">${stepper("step", null, "Weight", `data-f="load"`).replace("<b>–</b>", "")}</div></li>` : ""}
        <li><div class="row"><span class="text"><span class="title">Reps</span></span>
          <input class="gym-input short" type="text" inputmode="numeric" data-g="set-reps" value="${s.reps ?? ""}" aria-label="Reps">${stepper("step", null, "Reps", `data-f="reps"`).replace("<b>–</b>", "")}</div></li></ul>
      ${kind === "load" ? `<p class="caption-h">Reps in reserve</p>${seg("set-rir", s.rir, ["0", "1", "2", "3", "4"], "Reps in reserve")}` : ""}
      <button class="btn primary" type="button" data-close>Done</button>
      ${sheet.row ? `<button class="btn plain gym-danger" type="button" data-g="uncount">Doesn’t count</button>` : ""}`;
  }
  if (sheet.mode === "menu") {
    const skipped = live.skipped.includes(e.id);
    html = `${sheetHead(live.swaps[e.id] ?? e.name)}<ul class="group">
      ${ctx.row({ tag: "button", attrs: `data-g="swap" data-e="${sheet.ei}"`, title: "Swap exercise", chev: true })}
      ${live.swaps[e.id] ? ctx.row({ tag: "button", attrs: `data-g="unswap" data-e="${sheet.ei}"`, title: `Back to ${esc(e.name)}` }) : ""}
      ${ctx.row({ tag: "button", attrs: `data-g="${skipped ? "unskip" : "skip"}" data-e="${sheet.ei}"`, title: skipped ? "Bring back" : "Skip exercise" })}</ul>`;
  }
  if (sheet.mode === "swap") {
    html = `${sheetHead(`Swap ${e.name}`)}${seg("swap-mode", sheet.update ? 1 : 0, ["Just today", "Update plan"], "Swap for")}
      <p class="foot" id="gym-swap-why">${swapWhy(e)}</p>${e.alts.length ? `<ul class="group">${e.alts.map((a) => ctx.row({ tag: "button", attrs: `data-g="swap-to" data-name="${esc(a)}"`,
        title: esc(a), trail: live.swaps[e.id] === a ? check : "" })).join("")}</ul>` : ""}
      <ul class="group flat"><li><input class="gym-text" type="text" data-g="swap-other" value="${esc(sheet.other ?? "")}" placeholder="Something else" aria-label="Something else" autocapitalize="sentences"></li></ul>
      <button class="btn secondary" type="button" data-g="swap-to-other" ${(sheet.other ?? "").trim() ? "" : "disabled"}>Swap</button>`;
  }
  if (sheet.mode === "others") {
    const key = dayPlan(todayString(), dayRows(), profile()).key;
    html = `${sheetHead("Another session")}<ul class="group">${KEYS.filter((k) => k !== key).map((k) => ctx.row({ tag: "button", attrs: `data-g="start" data-key="${k}"`,
      title: esc(PLAN.sessions[k].name), sub: `${PLAN.sessions[k].items.length} exercises`, chev: true })).join("")}</ul>`;
  }
  if (sheet.mode === "finish") {
    const open = active().flatMap((x) => x.sets).filter((s) => !s.done).length;
    html = `${sheetHead("Finish session", open ? `${open} unticked ${open === 1 ? "set doesn’t" : "sets don’t"} count` : "")}
      <p class="caption-h">How do you feel now?</p>
      <ul class="group">${WRECKED.map((w, i) => ctx.row({ tag: "button", attrs: `data-g="finish-as" data-v="${i + 1}"`, title: w })).join("")}</ul>`;
  }
  if (sheet.mode === "weight") {
    const today = todayString(), entries = of("weight").map((r) => ({ date: r.date, kg: r.user_data?.kg })).filter((x) => typeof x.kg === "number");
    const t = weightTrend(entries, today), v = sheet.value ?? entries.find((x) => x.date === today)?.kg ?? "";
    const line = !t ? "Weigh in each morning. The 7-day average shows from the first one."
      : t.change == null ? `7-day average ${t.avg} kg. The weekly change shows after a second week.`
      : `7-day average ${t.avg} kg, ${t.change >= 0 ? "+" : ""}${t.change} kg on last week. Aim for +${t.lo} to +${t.hi}.`;
    const nudge = { low: "Gaining slower than the aim: add a snack or a bigger portion.", high: "Gaining faster than the aim.", flat: "Flat for two weeks: eat more." }[t?.status] ?? "";
    html = `${sheetHead("Bodyweight", "This morning")}<ul class="group">${field("Weight", "weight", v, "kg", `aria-label="Bodyweight in kg" placeholder="–"`)}</ul>
      <p class="foot">${esc(line)}${nudge ? ` ${esc(nudge)}` : ""}</p>
      <button class="btn primary" type="button" data-g="save-weight">Save</button>`;
  }
  if (sheet.mode === "plan-ex") {
    const x = sheet.items[sheet.i], time = x.kind === "time", f = (label, field, value) => `<li><div class="row"><span class="text"><span class="title">${label}</span></span>
      ${stepper("pstep", value, label, `data-f="${field}"`)}</div></li>`;
    html = `${sheetHead(x.name, PLAN.sessions[sheet.key].name)}<ul class="group">${f("Sets", "sets", x.sets)}
      ${time ? f(x.unit === "min" ? "Minutes" : "Seconds", "hi", x.hi) : `${f("Reps from", "lo", x.lo)}${f("Reps to", "hi", x.hi)}`}
      ${f("Rest", "rest", x.rest ? restText(x.rest) : "Off")}</ul>
      <ul class="group flat"><li><input class="gym-text" type="text" data-g="plan-note" value="${esc(x.note ?? "")}" placeholder="Add a note" aria-label="Note" autocapitalize="sentences" maxlength="80"></li></ul>
      <button class="btn primary" type="button" data-close>Done</button>
      <button class="btn plain gym-danger" type="button" data-g="plan-remove">Remove from plan</button>`;
  }
  if (sheet.mode === "plan-add") {
    const plan = planOf(profile()), have = new Set(plan.sessions[sheet.key].items.map((x) => x.id)), seen = new Set();
    const picks = KEYS.flatMap((k) => [...plan.sessions[k].items, ...PLAN.sessions[k].items]).filter((x) => !have.has(x.id) && !seen.has(x.id) && seen.add(x.id));
    html = `${sheetHead("Add exercise", PLAN.sessions[sheet.key].name)}
      <ul class="group flat"><li><input class="gym-text" type="text" data-g="add-name" value="${esc(sheet.name)}" placeholder="Name, e.g. Lat pulldown" aria-label="Exercise name" autocapitalize="sentences" maxlength="60"></li></ul>
      ${seg("add-kind", sheet.kind, ["Weight × reps", "Reps only"], "Logged as")}
      <button class="btn secondary" type="button" data-g="add-new" ${sheet.name.trim() ? "" : "disabled"}>Add</button>
      ${picks.length ? `<p class="caption-h">From the plan</p><ul class="group">${picks.map((x) => ctx.row({ tag: "button", attrs: `data-g="add-pick" data-id="${esc(x.id)}"`,
        title: esc(x.name), sub: `${x.sets} × ${reps(x)}` })).join("")}</ul>` : ""}`;
  }
  dlg.innerHTML = html;
}

/** The set the sheet edits: one in the session now, or a past one (a copy, saved when the sheet closes). */
function cur() {
  if (sheet.row) {
    const s = sheet.sets[sheet.i], r = rowById(sheet.row), n = sheet.sets.slice(0, sheet.i + 1).filter((x) => x.ex === s.ex && x.done && x.swap === s.swap).length;
    return { s, kind: exOf(s.ex)?.kind ?? "load", name: s.swap ?? exName(s.ex, r), sub: `Set ${n} · ${dayName(r.date, { weekday: "short", day: "numeric", month: "short" })}` };
  }
  const e = live.items[sheet.ei];
  return { s: e.sets[sheet.si], kind: e.kind, name: live.swaps[e.id] ?? e.name, sub: `Set ${sheet.si + 1} of ${e.sets.length}` };
}
const swapWhy = (e) => (sheet.update ? `From now on. The new lift keeps its own history; ${e.name}’s weights stay as they are.`
  : `Today only. It’s logged under its own name and never moves ${e.name}’s weights.`);

/** "Update plan" on a swap: the plan takes the new lift for good. Today moves to it only when nothing of it is ticked yet
 *  (gym.js updateSwap); otherwise today stays a swap, so ticked sets never count for the new lift. */
function planSwap(ei, name) {
  const id = idFor(name);
  if (live.items.some((x, j) => j !== ei && x.id === id) || planItems(live.key).some((x) => x.id === id && x.id !== live.items[ei].id)) {
    ctx.toast(`${name} is already in this session.`);
    return;
  }
  const r = updateSwap(live, ei, name, planItems(live.key), sessionsOf(rows));
  live = r.live;
  saveLive();
  savePlan(live.key, r.items);
  if (r.today === "swap") ctx.toast("Plan updated from next session. Today stays a swap.");
}

// ---------- Events ----------

const parse = (raw) => { const x = parseFloat(String(raw).replace(",", ".")); return Number.isFinite(x) ? x : null; };
const round = (x, step) => Math.round(x / step) * step;

function setLoad(ei, si, v) { // a load carries to the later sets not yet ticked
  const e = live.items[ei];
  e.sets[si].load = v;
  for (const later of e.sets.slice(si + 1)) if (!later.done) later.load = v;
}

function click(ev) {
  const t = ev.target.closest("[data-g]");
  if (!t || t.tagName === "INPUT" || t.tagName === "SELECT" || Date.now() < noClick) return;
  const d = t.dataset, ei = Number(d.e ?? sheet?.ei), si = Number(d.s ?? sheet?.si);
  switch (d.g) {
    // Plan
    case "start": return startSession(d.key);
    // History, an exercise, Edit plan
    case "history": return go({ s: "history" });
    case "open-session": return go({ s: "session", id: d.id });
    case "open-ex": return go({ s: "exercise", id: d.id });
    case "plan": return go({ s: "plan", key: sessionForDay(todayString()) ?? "A" });
    case "past-set": return openSheet("set", { row: d.id, i: Number(d.i), sets: structuredClone(setsOf(rowById(d.id))) });
    case "uncount": sheet.sets[sheet.i].done = false; sheet.dirty = true; return closeSheet();
    case "del-session": {
      const r = rowById(d.id);
      patch(r, { deleted: true });
      back();
      return ctx.toast("Session deleted", () => { patch(r, { deleted: false }); ctx.rerender(); });
    }
    case "chart-m": case "chart-r": {
      if (d.g === "chart-m") chartM = Number(d.v); else chartR = Number(d.v);
      pickSeg(t);
      const sc = nav.at(-1), el = $("gym-chart");
      if (el) el.innerHTML = chart(exerciseLog(sc.id, sessionsOf(rows)));
      return;
    }
    case "plan-key": {
      nav.at(-1).key = PLAN_ORDER[Number(d.v)];
      pickSeg(t);
      $("gym-plan-list").innerHTML = planList(nav.at(-1).key);
      return;
    }
    case "plan-ex": return openSheet("plan-ex", { key: nav.at(-1).key, i: Number(d.i), items: planItems(nav.at(-1).key) });
    case "pstep": {
      const x = sheet.items[sheet.i], v = Number(d.v), f = d.f;
      if (f === "sets") x.sets = Math.min(10, Math.max(1, x.sets + v));
      if (f === "lo") x.lo = Math.min(x.hi, Math.max(1, x.lo + v));
      if (f === "hi") { x.hi = Math.min(60, Math.max(x.kind === "time" ? 1 : x.lo, x.hi + v)); if (x.kind === "time") x.lo = x.hi; }
      if (f === "rest") x.rest = Math.min(600, Math.max(0, x.rest + v * 15));
      sheet.dirty = true;
      t.parentElement.querySelector("b").textContent = f === "rest" ? (x.rest ? restText(x.rest) : "Off") : x[f];
      return;
    }
    case "plan-remove": { const { key, i } = sheet; sheet.dirty = false; closeSheet(); return removeExercise(i, key); }
    case "plan-add": return openSheet("plan-add", { key: nav.at(-1).key, name: "", kind: 0 });
    case "add-kind": sheet.kind = Number(d.v); return pickSeg(t);
    case "add-new": case "add-pick": {
      const key = sheet.key, items = planItems(key), name = (sheet.name ?? "").trim().slice(0, 60);
      const id = d.g === "add-pick" ? d.id : idFor(name);
      if (items.some((x) => x.id === id)) return ctx.toast("That’s already in this session.");
      const base = exOf(id);
      items.push(base ? { ...base } : { id, name, kind: sheet.kind === 1 ? "reps" : "load", sets: 3, lo: 8, hi: 12, rest: 90, note: "" });
      closeSheet();
      return savePlan(key, items);
    }
    case "plan-reset": return ctx.ask("Reset this session to the Autumn plan? Your changes to it go.", "Reset", () => {
      const p = profileRow(), plan = { ...(p.user_data.plan ?? {}) };
      delete plan[nav.at(-1).key];
      patch(p, { plan }); redraw();
    });
    case "others": return openSheet("others");
    case "deload": patch(profileRow(), { deloadFrom: todayString() }); status = "Deload week: half the sets, same loads, until next week."; return ctx.rerender();
    case "weight": return openSheet("weight");
    case "food": return ctx.food.open();
    // Account → Train
    case "whoop": return connectWhoop();
    case "edit": ctx.closeSheet($("sheet")); ctx.tab(); editing = true; startSetup(); ctx.rerender(); return scrollTo(0, 0);
    // Setup
    case "cancel": editing = false; draft = null; return ctx.rerender();
    case "parq": draft.parq[Number(d.i)] = !draft.parq[Number(d.i)]; if (draft.parq[Number(d.i)]) just = `parq${d.i}`; return ctx.rerender();
    case "surgery": case "concussion": draft[d.g] = !draft[d.g]; if (draft[d.g]) just = `${d.g}0`; return ctx.rerender();
    case "rugby": { const v = Number(d.v); draft.rugbyDays = draft.rugbyDays.includes(v) ? draft.rugbyDays.filter((x) => x !== v) : [...draft.rugbyDays, v]; return ctx.rerender(); }
    case "match": draft.matchDay = (Number(d.v) + 1) % 7; return pickSeg(t);
    case "target": draft.target = Math.min(7, Math.max(1, draft.target + Number(d.v))); return ctx.rerender();
    case "next": if (draft.step === STEPS.length - 1) return finishSetup(); draft.step++; ctx.rerender(); return scrollTo(0, 0);
    case "back": draft.step--; ctx.rerender(); return scrollTo(0, 0);
    // Session
    case "feel": live.feel = Number(d.v) + 1; saveLive(); return pickSeg(t);
    case "set": return toggleSet(ei, si);
    case "edit-set": return openSheet("set", { ei, si });
    case "fill": {
      const e = live.items[ei], l = lastTime(e.id, sessionsOf(rows))?.sets, x = l && (l[si] ?? l.at(-1));
      if (!x) return;
      if (e.kind === "load") setLoad(ei, si, x.load ?? null);
      e.sets[si].reps = x.reps;
      saveLive();
      return ctx.rerender();
    }
    case "rest-adj": return restAdjust(Number(d.v));
    case "step": {
      const { s } = cur(), dir = Number(d.v);
      if (d.f === "load") { const v = Math.max(0, round((s.load ?? 0) + dir * 2.5, 0.5)); if (sheet.row) s.load = v; else setLoad(ei, si, v); }
      else s.reps = Math.max(0, (s.reps ?? 0) + dir);
      sheet.dirty = true;
      if (!sheet.row) saveLive();
      const box = $("train-sheet").querySelector(`[data-g="set-${d.f}"]`);
      if (box) box.value = d.f === "load" ? s.load ?? "" : s.reps ?? "";
      return ctx.rerender();
    }
    case "set-rir": cur().s.rir = Number(d.v); sheet.dirty = true; if (!sheet.row) saveLive(); pickSeg(t); return ctx.rerender();
    case "menu": return openSheet("menu", { ei });
    case "swap": return openSheet("swap", { ei, other: "", update: false });
    case "swap-mode": sheet.update = d.v === "1"; pickSeg(t); $("gym-swap-why").textContent = swapWhy(live.items[ei]); return;
    case "swap-to": case "swap-to-other": {
      const name = d.g === "swap-to" ? d.name : (sheet.other ?? "").trim().slice(0, 60);
      if (sheet.update) planSwap(ei, name); else { live.swaps[live.items[ei].id] = name; saveLive(); }
      closeSheet(); return ctx.rerender();
    }
    case "unswap": delete live.swaps[live.items[ei].id]; saveLive(); closeSheet(); return ctx.rerender();
    case "skip": live.skipped.push(live.items[ei].id); saveLive(); closeSheet(); return ctx.rerender();
    case "unskip": live.skipped = live.skipped.filter((id) => id !== live.items[ei].id); saveLive(); closeSheet(); return ctx.rerender();
    case "skip-rest": restStop(); saveLive(); return ctx.rerender();
    case "finish": return openSheet("finish");
    case "finish-as": return finish(Number(d.v));
    case "discard": return discard();
    // Sheets
    case "save-weight": {
      const v = parse(sheet.value ?? $("train-sheet").querySelector('[data-g="weight"]')?.value);
      if (!(v > 20 && v < 300)) return;
      const today = todayString(), r = of("weight").find((x) => x.date === today);
      if (r) patch(r, { kg: v }); else add({ id: `you-gym-w-${today}`, date: today, title: "Bodyweight", data: { type: "weight" }, user_data: { kg: v, userAt: Date.now() } });
      closeSheet(); return ctx.rerender();
    }
  }
}

/** Typing only updates state: no re-render, so the keyboard stays up. */
function input(ev) {
  const t = ev.target, d = t.dataset;
  if (d.g === "injury" && draft) draft.injury = t.value;
  else if (d.g === "bw" && draft) draft.weight = t.value;
  else if ((d.g === "lift-kg" || d.g === "lift-reps") && draft) (draft.lifts[d.id] ??= {})[d.g === "lift-kg" ? "kg" : "reps"] = t.value;
  else if (d.g === "swap-other" && sheet) { sheet.other = t.value; const b = $("train-sheet").querySelector('[data-g="swap-to-other"]'); if (b) b.disabled = !t.value.trim(); }
  else if (d.g === "weight" && sheet) sheet.value = t.value;
  else if (d.g === "plan-note" && sheet) { sheet.items[sheet.i].note = t.value.slice(0, 80); sheet.dirty = true; }
  else if (d.g === "add-name" && sheet) { sheet.name = t.value; const b = $("train-sheet").querySelector('[data-g="add-new"]'); if (b) b.disabled = !t.value.trim(); }
}

function change(ev) {
  const t = ev.target, d = t.dataset;
  if (d.g === "set-load" || d.g === "set-reps") {
    const v = t.value === "" ? null : parse(t.value), { s } = cur();
    if (d.g === "set-load") { const x = v == null ? null : Math.max(0, v); if (sheet.row) s.load = x; else setLoad(sheet.ei, sheet.si, x); }
    else s.reps = v == null ? null : Math.max(0, Math.round(v));
    sheet.dirty = true;
    if (!sheet.row) saveLive();
    return ctx.rerender();
  }
}

async function connectWhoop() {
  if (ctx.demo) { status = "WHOOP connects on the real app, not the demo."; ctx.closeSheet($("sheet")); ctx.tab(); return ctx.rerender(); }
  try { location.href = (await call("whoop", { action: "connect" })).url; }
  catch (e) { status = `WHOOP: ${e.message}`; ctx.rerender(); }
}
