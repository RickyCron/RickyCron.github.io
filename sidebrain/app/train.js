// The Train tab: an optional plugin, off until switched on in the Account sheet (docs/(C) Gym plugin research.md §1, §7).
// Built on the shell's design system (web/(C) Design system.md): the Today-style hero answers "what now?", inset-grouped
// lists below it, the shell's sheet, Undo toast and folds. It owns #train and #train-sheet (one sheet, one mode at a time:
// a set, an exercise's menu, swap, another session, finish, bodyweight, food). The rules live in gym.js.
import { PLAN, KEYS, sessionForDay, sessionsOf, prescribe, warnings, deloadOffer, week, weightTrend, startFrom, e1rm, lastTime,
         planWeek, scaleItem, dayFood, foodRequest, parseFood, whoopFor, PROTEIN_TARGET, phaseOf, exerciseById, FEEL, WRECKED } from "./gym.js";
import { todayString, addDays } from "./sm2.js";
import { TICK } from "./notes.js";

let ctx = null;                  // app.js: helpers, the outbox, the client and the shell's components (see train.mount in app.js)
let rows = [];                   // gym items: this phone's copy, merged with the server's
let live = null;                 // the session in progress (kept in localStorage, so a locked phone or a reload loses nothing)
let editing = false, status = "", whoop = { connected: null, recovery: null, day: "" };
let sheet = null;                // what #train-sheet shows: {mode, ...}
let food = { items: [], note: "", busy: false, error: "", photo: null };
let just = "";                   // the tick that was just pressed, so only it plays the pop
let jwt = null, restTimer = null, quietTimer = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(String(s ?? ""));
const num = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const kg = (x) => (x == null ? "" : `${num(x)} kg`);
const profileRow = () => rows.find((r) => r.id === "gym-profile") ?? null;
const profile = () => profileRow()?.user_data ?? null;
const of = (type) => rows.filter((r) => r.data?.type === type && !r.deleted_at);

export function mount(c) {
  ctx = c;
  rows = ctx.load("gym", []);
  live = ctx.load("gym-live", null);
  const dlg = document.createElement("dialog");
  dlg.className = "sheet"; dlg.id = "train-sheet"; dlg.setAttribute("aria-labelledby", "train-sheet-title");
  document.body.append(dlg);
  dlg.innerHTML = sheetHead("Train"); // the gestures need a head to drag by; it is redrawn on every open
  ctx.sheetGestures(dlg);
  dlg.addEventListener("close", () => { sheet = null; });
  for (const el of [$("train"), dlg]) {
    el.addEventListener("click", click);
    el.addEventListener("change", change);
    el.addEventListener("input", input);
  }
  $("sheet")?.addEventListener("click", click); // Account → Train rows (accountRows)
  document.addEventListener("visibilitychange", restVisibility);
  const link = new URLSearchParams(location.search).get("whoop");
  if (link) status = link === "connected" ? "WHOOP connected." : "WHOOP didn’t connect. Try again.";
  if (live?.rest) { tick(); quietTimer = setTimeout(restQuiet, Math.max(0, live.rest.until - Date.now() - 10_000)); }
  setInterval(() => { if (live) paintLive(); }, 30_000);
}

/** Today's Gym event opens the Train tab while Train is on; false (do nothing) when it's off, so the row keeps its own tap. */
export function openToday() {
  if (!ctx?.on()) return false;
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
  const html = !profile() || editing ? setup() : live ? liveScreen() : home();
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
function planHero(today, sessions, p, phase) {
  const key = sessionForDay(today);
  if (phase === "over") return `<section class="hero" aria-label="Training now"><div class="hgrid"><p class="k">Autumn plan</p><span></span><h2>Plan finished</h2></div>
    <p class="where gym-hero-line">It ended on 12 Dec. Write the next block, then load it here.</p></section>`;
  if (!key) {
    const wd = new Date().getDay(), next = KEYS.map((k) => ({ k, d: [1, 2, 3, 4, 5, 6, 7].map((n) => addDays(today, n)).find((d) => sessionForDay(d) === k) }))
      .sort((a, b) => (a.d < b.d ? -1 : 1))[0];
    const what = wd === p.matchDay ? "Match day" : (p.rugbyDays ?? [2, 6]).includes(wd) ? "Rugby training" : "Rest day";
    return `<section class="hero" aria-label="Training now"><div class="hgrid"><p class="k">Today</p><p class="k r">Next</p>
      <h2>${what}</h2><b class="fig">${dayName(next.d, { weekday: "short" })}</b>
      <p class="where">Nothing in the gym</p><span class="range">${esc(PLAN.sessions[next.k].name)}</span></div></section>`;
  }
  const rx = prescribe(key, today, { sessions, profile: p, recovery: whoop.recovery });
  const lead = rx.items.find((e) => e.main && e.load != null) ?? rx.items.find((e) => e.load != null);
  return `<section class="hero" aria-label="Training now"><div class="hgrid"><p class="k">Today · ${phaseName(rx.phase)}</p><p class="k r">${lead ? esc(lead.name) : ""}</p>
    <h2${rx.name.length > 24 ? ` class="long"` : ""}>${esc(rx.name)}</h2><b class="fig">${lead ? kg(lead.load) : ""}</b>
    <p class="where">${rx.items.length} exercises</p><span class="range">${lead?.up ? "Up from last time" : ""}</span></div>
    <button class="btn primary gym-hero-btn" type="button" data-g="start" data-key="${key}">Start</button></section>`;
}

function home() {
  const today = todayString(), sessions = sessionsOf(rows), p = profile(), phase = phaseOf(today, p);
  const key = sessionForDay(today), wk = week(today, sessions);
  let out = ctx.head("Train", phase === "over" ? "" : `Week ${planWeek(today)}`) + planHero(today, sessions, p, phase);
  if (status) out += `<p class="foot mt-12">${esc(status)}</p>`;
  if (key && phase !== "over") {
    const rx = prescribe(key, today, { sessions, profile: p, recovery: whoop.recovery });
    const warn = warnings(key, today, Date.now(), p, sessions.filter((s) => s.date === today));
    for (const w of [...warn, ...rx.notes]) out += `<p class="foot mt-12${warn.includes(w) ? " warn" : ""}">${esc(w)}</p>`;
    out += `<ul class="group flat gym-folds mt-20">${ctx.fold("train-today", "Exercises", rx.items.length, rx.items.map((e) => `<li><div class="row"><span class="text">
      <span class="title">${esc(e.name)}</span><span class="subtitle">${e.sets} × ${reps(e)}${e.kind === "load" ? ` · RIR ${e.rir}` : ""}</span></span>
      ${e.load != null ? `<span class="trail">${kg(e.load)}${e.up ? " ↑" : ""}</span>` : ""}</div></li>`).join(""))}</ul>`;
  }
  if (phase !== "over") out += `<ul class="group flat mt-12">${ctx.row({ tag: "button", attrs: `data-g="others"`, title: key ? "Do a different session" : "Do a session anyway", chev: true })}</ul>`;
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
  const w = of("weight").find((r) => r.date === today)?.user_data?.kg, protein = dayFood(of("meal"), today).protein;
  return `<h2 class="section">Log</h2><ul class="group flat">
    ${ctx.row({ tag: "button", attrs: `data-g="weight"`, title: "Bodyweight", trail: typeof w === "number" ? kg(w) : "Add", chev: true })}
    ${ctx.row({ tag: "button", attrs: `data-g="food"`, title: "Food", trail: protein ? `${protein} g protein` : "Add", chev: true })}</ul>`;
}

function history(sessions) {
  if (!sessions.length) return "";
  return `<h2 class="section">Recent</h2><ul class="group flat">${sessions.slice(0, 5).map((s) => {
    const w = s.user_data?.whoop, top = (s.data.sets ?? []).filter((x) => x.done && x.load > 0 && !x.swap).map((x) => e1rm(x.load, x.reps, x.rir) ?? 0);
    return ctx.row({ title: esc(s.title), sub: dayName(s.date, { weekday: "short", day: "numeric", month: "short" })
      + `${top.length ? ` · best e1RM ${Math.max(...top)} kg` : ""}${WRECKED[s.data.wrecked - 1] ? ` · ${WRECKED[s.data.wrecked - 1]}` : ""}`,
      trail: w?.strain != null ? `Strain ${w.strain.toFixed(1)}` : "" });
  }).join("")}</ul>`;
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
  const today = todayString(), sessions = sessionsOf(rows), rx = prescribe(key, today, { sessions, profile: profile(), recovery: whoop.recovery });
  live = { key, name: rx.name, start: Date.now(), feel: null, deload: rx.phase === "deload", rest: null, skipped: [], swaps: {},
    items: rx.items.map((e) => {
      const last = lastTime(e.id, sessions)?.sets ?? [];
      return { id: e.id, name: e.name, kind: e.kind, unit: e.unit, lo: e.lo, hi: e.hi, rir: e.rir, rest: e.rest, note: e.note ?? "", up: e.up, alts: exerciseById(e.id)?.alts ?? [],
        sets: Array.from({ length: e.sets }, (_, i) => ({ load: e.load, reps: e.kind === "time" ? e.hi : (last[i]?.reps ?? e.hi), rir: null, done: false })) };
    }) };
  token().then((t) => { jwt = t ?? jwt; }).catch(() => {});
  saveLive();
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
  live.items.forEach((e, ei) => {
    const skipped = live.skipped.includes(e.id), name = live.swaps[e.id] ?? e.name;
    out += `<div class="gym-ex-head"><h2 class="section">${esc(name)}</h2>
      <button class="gym-more" type="button" data-g="menu" data-e="${ei}" aria-label="More for ${esc(name)}">${ctx.ICON.more}</button></div>
      <p class="foot">${skipped ? "Skipped" : `${e.sets.length} × ${reps(e)}${e.kind === "load" ? ` · RIR ${e.rir}` : ""}${e.up ? " · weight up" : ""}${!live.swaps[e.id] && e.note ? ` · ${esc(e.note)}` : ""}`}</p>`;
    if (skipped) return;
    out += `<ul class="group gym-sets mt-12">${e.sets.map((s, si) => `<li class="task${s.done ? " done" : ""}${just === `set${ei}-${si}` ? " just" : ""}">
      <button class="tick" type="button" data-g="set" data-e="${ei}" data-s="${si}" aria-pressed="${s.done}" aria-label="Set ${si + 1}, ${esc(setValue(e, s))}: ${s.done ? "done" : "not done"}">${TICK}</button>
      ${e.kind === "time" ? `<div class="row"><span class="text"><span class="title">Set ${si + 1}</span></span><span class="trail">${esc(setValue(e, s))}</span></div>`
        : `<button class="row" type="button" data-g="edit-set" data-e="${ei}" data-s="${si}"><span class="text"><span class="title">Set ${si + 1}</span>${s.rir != null ? `<span class="subtitle">RIR ${s.rir}</span>` : ""}</span>
          <span class="trail">${esc(setValue(e, s))}</span>${ctx.ICON.chev}</button>`}</li>`).join("")}</ul>`;
  });
  out += `<div class="gym-actions"><button class="btn primary" type="button" data-g="finish">Finish</button>
    <button class="btn plain gym-danger" type="button" data-g="discard">Discard session</button></div>
    <div class="gym-rest chrome" ${live.rest ? "" : "hidden"} role="timer" aria-live="off"><span>Rest</span><b id="gym-rest-left">${restLeft()}</b>
      <button class="btn small secondary" type="button" data-g="skip-rest">Skip</button></div>`;
  return out;
}

function restLeft() {
  const s = live?.rest ? Math.max(0, Math.ceil((live.rest.until - Date.now()) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
    data: { type: "session", key: live.key, start: live.start, end, feel: live.feel, wrecked, deload: live.deload, sets, skipped: live.skipped, swaps: live.swaps },
    user_data: {} });
  restStop();
  live = null; saveLive();
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
  live = null; saveLive();
  ctx.rerender();
  scrollTo(0, 0);
  ctx.toast("Session discarded", () => { live = { ...kept, rest: null }; saveLive(); ctx.rerender(); });
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
    const s = e.sets[sheet.si];
    html = `${sheetHead(live.swaps[e.id] ?? e.name, `Set ${sheet.si + 1} of ${e.sets.length}`)}
      <ul class="group">${e.kind === "load" ? `<li><div class="row"><span class="text"><span class="title">Weight</span><span class="subtitle">kg</span></span>
          <input class="gym-input" type="text" inputmode="decimal" data-g="set-load" value="${s.load ?? ""}" aria-label="Weight in kg">${stepper("step", null, "Weight", `data-f="load"`).replace("<b>–</b>", "")}</div></li>` : ""}
        <li><div class="row"><span class="text"><span class="title">Reps</span></span>
          <input class="gym-input short" type="text" inputmode="numeric" data-g="set-reps" value="${s.reps ?? ""}" aria-label="Reps">${stepper("step", null, "Reps", `data-f="reps"`).replace("<b>–</b>", "")}</div></li></ul>
      ${e.kind === "load" ? `<p class="caption-h">Reps in reserve</p>${seg("set-rir", s.rir, ["0", "1", "2", "3", "4"], "Reps in reserve")}` : ""}
      <button class="btn primary" type="button" data-close>Done</button>`;
  }
  if (sheet.mode === "menu") {
    const skipped = live.skipped.includes(e.id);
    html = `${sheetHead(live.swaps[e.id] ?? e.name)}<ul class="group">
      ${ctx.row({ tag: "button", attrs: `data-g="swap" data-e="${sheet.ei}"`, title: "Swap exercise", chev: true })}
      ${live.swaps[e.id] ? ctx.row({ tag: "button", attrs: `data-g="unswap" data-e="${sheet.ei}"`, title: `Back to ${esc(e.name)}` }) : ""}
      ${ctx.row({ tag: "button", attrs: `data-g="${skipped ? "unskip" : "skip"}" data-e="${sheet.ei}"`, title: skipped ? "Bring back" : "Skip exercise" })}</ul>`;
  }
  if (sheet.mode === "swap") {
    html = `${sheetHead(`Swap ${e.name}`)}${e.alts.length ? `<ul class="group">${e.alts.map((a) => ctx.row({ tag: "button", attrs: `data-g="swap-to" data-name="${esc(a)}"`,
        title: esc(a), trail: live.swaps[e.id] === a ? check : "" })).join("")}</ul>` : ""}
      <ul class="group flat"><li><input class="gym-text" type="text" data-g="swap-other" value="${esc(sheet.other ?? "")}" placeholder="Something else" aria-label="Something else" autocapitalize="sentences"></li></ul>
      <button class="btn secondary" type="button" data-g="swap-to-other" ${(sheet.other ?? "").trim() ? "" : "disabled"}>Swap</button>`;
  }
  if (sheet.mode === "others") {
    const key = sessionForDay(todayString());
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
  if (sheet.mode === "food") html = foodSheet();
  dlg.innerHTML = html;
}

// ---------- Food (research doc §8) ----------

function foodSheet() {
  const today = todayString(), meals = of("meal").filter((m) => m.date === today), totals = dayFood(of("meal"), today);
  const est = food.items.reduce((t, i) => ({ p: t.p + i.protein_g, k: t.k + i.kcal }), { p: 0, k: 0 });
  const ready = food.photo || food.note.trim();
  return `${sheetHead("Food", `About ${totals.protein} g protein of ${PROTEIN_TARGET(profile()?.weight)} g today`)}
    ${meals.length ? `<ul class="group">${meals.map((m) => ctx.row({ title: esc(m.data.note || m.data.items.map((i) => i.name).join(", ")),
      trail: `${m.data.items.reduce((a, i) => a + i.protein_g, 0)} g` })).join("")}</ul>` : ""}
    <ul class="group flat">
      <li><label class="row">${ctx.ICON.camera}<span class="text"><span class="title">${food.photo ? "Photo added" : "Take a photo"}</span></span>
        <input class="overlay" type="file" accept="image/*" capture="environment" data-g="photo" aria-label="Take a photo"></label></li>
      <li><input class="gym-text" type="text" data-g="note" value="${esc(food.note)}" placeholder="What it is, e.g. half chicken and rice" aria-label="What it is" autocapitalize="sentences"></li></ul>
    ${food.error ? `<p class="foot warn">${esc(food.error)}</p>` : ""}
    ${food.items.length ? `<ul class="group flat">${food.items.map((i, n) => `<li><label class="row"><span class="text"><span class="title">${esc(i.name)}</span>
      <span class="subtitle">${i.protein_g} g protein · ${i.kcal} kcal</span></span>
      <span class="gym-field"><input class="gym-input" type="text" inputmode="numeric" data-g="grams" data-i="${n}" value="${i.grams}" aria-label="${esc(i.name)} grams"><span class="gym-unit">g</span></span></label></li>`).join("")}</ul>
      <p class="foot">About ${est.p} g protein, ${est.k} kcal. Photo estimates read low on big portions, so fix the grams of the main item.</p>
      <button class="btn primary" type="button" data-g="save-meal">Save</button>
      <button class="btn plain" type="button" data-g="estimate" ${food.busy ? "disabled" : ""}>${food.busy ? "Estimating…" : "Re-estimate"}</button>`
    : `<button class="btn primary" type="button" data-g="estimate" ${food.busy || !ready ? "disabled" : ""}>${food.busy ? "Estimating…" : "Estimate"}</button>`}`;
}

async function estimate() {
  food.busy = true; food.error = ""; paintSheet();
  try {
    const reply = ctx.demo ? demoFood() : await call("ai", foodRequest(food.note, food.photo), { "X-Sidebrain-Task": "food" });
    food.items = parseFood(reply).map((i) => scaleItem(i, i.grams));
    if (!food.items.length) food.error = "Couldn’t read that meal. Add a line about what it is and try again.";
  } catch (e) { food.error = e.message; }
  food.busy = false; paintSheet();
}
const demoFood = () => ({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ items: [
  { name: "Grilled chicken", grams: 250, protein_g: 62, kcal: 410 }, { name: "Spicy rice", grams: 220, protein_g: 6, kcal: 330 }] }) }] }] });

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
  if (!t || t.tagName === "INPUT" || t.tagName === "SELECT") return;
  const d = t.dataset, ei = Number(d.e ?? sheet?.ei), si = Number(d.s ?? sheet?.si);
  switch (d.g) {
    // Plan
    case "start": return startSession(d.key);
    case "others": return openSheet("others");
    case "deload": patch(profileRow(), { deloadFrom: todayString() }); status = "Deload week: half the sets, same loads, until next week."; return ctx.rerender();
    case "weight": return openSheet("weight");
    case "food": food = { items: [], note: "", busy: false, error: "", photo: null }; return openSheet("food");
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
    case "step": {
      const s = live.items[ei].sets[si], dir = Number(d.v);
      if (d.f === "load") setLoad(ei, si, Math.max(0, round((s.load ?? 0) + dir * 2.5, 0.5)));
      else s.reps = Math.max(0, (s.reps ?? 0) + dir);
      saveLive();
      const box = $("train-sheet").querySelector(`[data-g="set-${d.f}"]`);
      if (box) box.value = d.f === "load" ? s.load ?? "" : s.reps ?? "";
      return ctx.rerender();
    }
    case "set-rir": live.items[ei].sets[si].rir = Number(d.v); saveLive(); pickSeg(t); return ctx.rerender();
    case "menu": return openSheet("menu", { ei });
    case "swap": return openSheet("swap", { ei, other: "" });
    case "swap-to": live.swaps[live.items[ei].id] = d.name; saveLive(); closeSheet(); return ctx.rerender();
    case "swap-to-other": live.swaps[live.items[ei].id] = (sheet.other ?? "").trim().slice(0, 60); saveLive(); closeSheet(); return ctx.rerender();
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
    case "estimate": return estimate();
    case "save-meal":
      add({ id: `you-gym-${crypto.randomUUID()}`, date: todayString(), title: food.note.trim() || "Meal", data: { type: "meal", note: food.note.trim(), items: food.items }, user_data: {} });
      closeSheet(); return ctx.rerender();
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
  else if (d.g === "note") { food.note = t.value; const b = $("train-sheet").querySelector('[data-g="estimate"]'); if (b && !food.items.length) b.disabled = food.busy || !(food.photo || t.value.trim()); }
}

async function change(ev) {
  const t = ev.target, d = t.dataset;
  if (d.g === "set-load" || d.g === "set-reps") {
    const v = t.value === "" ? null : parse(t.value);
    if (d.g === "set-load") setLoad(sheet.ei, sheet.si, v == null ? null : Math.max(0, v));
    else live.items[sheet.ei].sets[sheet.si].reps = v == null ? null : Math.max(0, Math.round(v));
    saveLive(); return ctx.rerender();
  }
  if (d.g === "grams") { const i = Number(d.i); food.items[i] = scaleItem(food.items[i], t.value); return paintSheet(); }
  if (d.g === "photo" && t.files?.[0]) {
    try { food.photo = await ctx.dataUrl(await ctx.shrink(t.files[0], 768)); } catch { food.error = "Couldn’t read that photo."; }
    paintSheet();
  }
}

async function connectWhoop() {
  if (ctx.demo) { status = "WHOOP connects on the real app, not the demo."; ctx.closeSheet($("sheet")); ctx.tab(); return ctx.rerender(); }
  try { location.href = (await call("whoop", { action: "connect" })).url; }
  catch (e) { status = `WHOOP: ${e.message}`; ctx.rerender(); }
}
