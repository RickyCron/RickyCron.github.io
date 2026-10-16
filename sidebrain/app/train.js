// The Train tab: an optional plugin, off until switched on in the Account sheet (docs/(C) Gym plugin research.md §1, §7).
// It owns #train and #food-sheet; app.js hands it the outbox, the Supabase client and its row/HTML helpers, and loads
// `gym` items only while it is on. The rules live in gym.js; this file is screens and writes.
import { PLAN, KEYS, sessionForDay, sessionsOf, prescribe, warnings, deloadOffer, week, weightTrend, startFrom, e1rm, lastTime,
         planWeek, scaleItem, dayFood, foodRequest, parseFood, whoopFor, PROTEIN_TARGET, phaseOf, exerciseById } from "./gym.js";
import { todayString, addDays } from "./sm2.js";

let ctx = null;                  // {sb, user, esc, row, head, ICON, addRow, writeUser, shrink, dataUrl, url, anon, demo, keep, load, rerender}
let rows = [];                   // gym items: this phone's copy, merged with the server's
let live = null;                 // the session in progress (kept in localStorage, so a locked phone or a reload loses nothing)
let feel = 0, wrecked = 0, editing = false, status = "", whoop = { connected: null, recovery: null, day: "" };
let food = { items: [], note: "", busy: false, error: "", photo: null };
let tickTimer = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(String(s ?? ""));
const kg = (x) => (x == null ? "" : `${Number.isInteger(x) ? x : x.toFixed(1)} kg`);
const profileRow = () => rows.find((r) => r.id === "gym-profile") ?? null;
const profile = () => profileRow()?.user_data ?? null;
const of = (type) => rows.filter((r) => r.data?.type === type && !r.deleted_at);

export function mount(c) {
  ctx = c;
  rows = ctx.load("gym", []);
  live = ctx.load("gym-live", null);
  const sheet = document.createElement("dialog");
  sheet.className = "sheet"; sheet.id = "food-sheet"; sheet.setAttribute("aria-label", "Add a meal");
  document.body.append(sheet);
  for (const el of [$("train"), sheet]) {
    el.addEventListener("click", click);
    el.addEventListener("change", change);
  }
  const link = new URLSearchParams(location.search).get("whoop");
  if (link) status = link === "connected" ? "WHOOP connected." : "WHOOP didn’t connect. Try again.";
  if (live?.rest) tick();
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
  const jwt = await token();
  if (!jwt) throw new Error("Sign in to use this.");
  const r = await fetch(`${ctx.url}/functions/v1/${fn}`, { method: "POST", body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${jwt}`, apikey: ctx.anon, "Content-Type": "application/json", ...headers } });
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

/** One rest timer per user on the server; a 5-second cron pushes it to the lock screen when it's due. */
async function restTimer(at, body) {
  const sb = ctx.sb(), uid = ctx.user()?.id;
  if (ctx.demo || !sb || !uid) return;
  try {
    if (at) await sb.from("rest_timers").upsert({ user_id: uid, fire_at: new Date(at).toISOString(), title: "Rest over", body, sent_at: null }, { onConflict: "user_id" });
    else await sb.from("rest_timers").delete().eq("user_id", uid);
  } catch { /* the countdown on screen still works; only the lock-screen push is lost */ }
}

// ---------- Screens ----------

export function render() {
  const el = $("train");
  if (!el || !ctx) return;
  const html = !profile() || editing ? onboarding() : live ? liveScreen() : home();
  if (el._html !== html) el.innerHTML = el._html = html;
  if (profile() && !live) whoopStatus();
}

const seg = (name, value, n = 5, labels = null) => `<div class="seg gym-seg" role="radiogroup" style="--n: ${n}">${Array.from({ length: n }, (_, i) => {
  const v = labels ? i : i + 1;
  return `<button type="button" role="radio" data-g="${name}" data-v="${v}" aria-checked="${value === v}">${labels ? labels[i] : v}</button>`;
}).join("")}</div>`;
const reps = (e) => (e.kind === "time" ? `${e.hi} ${e.unit ?? "s"}` : e.lo === e.hi ? `${e.hi}` : `${e.lo}–${e.hi}`);

function home() {
  const today = todayString(), sessions = sessionsOf(rows), p = profile(), phase = phaseOf(today, p);
  const key = live?.key ?? sessionForDay(today), wk = week(today, sessions);
  const sub = phase === "over" ? "The Autumn plan ended on 12 Dec" : `Week ${planWeek(today)} · ${{ build: "Build", deload: "Deload", light: "Light week" }[phase]}`;
  let out = ctx.head("Train", sub);
  if (status) out += `<p class="foot">${esc(status)}</p>`;
  if (phase !== "over") {
    if (key) {
      const rx = prescribe(key, today, { sessions, profile: p, recovery: whoop.recovery });
      const warn = warnings(key, today, Date.now(), p, sessions.filter((s) => s.date === today));
      out += `<h2 class="section">Today · ${esc(rx.name)}</h2>`;
      for (const w of [...warn, ...rx.notes]) out += `<p class="foot ${warn.includes(w) ? "warn" : ""}">${esc(w)}</p>`;
      out += `<ul class="group flat mt-12">${rx.items.map((e) => ctx.row({ title: esc(e.name), sub: `${e.sets} × ${reps(e)}${e.kind === "load" ? ` · RIR ${e.rir}` : ""}`,
        trail: e.load != null ? `${kg(e.load)}${e.up ? " ↑" : ""}` : "" })).join("")}</ul>
        <p class="foot mt-20">How do you feel?</p>${seg("feel", feel)}
        <button class="btn primary mt-12" type="button" data-g="start" data-key="${key}">Start</button>`;
    } else out += `<h2 class="section">Today</h2><p class="sub">${[2, 6].includes(new Date().getDay()) ? "Rugby training." : new Date().getDay() === p.matchDay ? "Match day." : "Rest day."} Nothing in the gym.</p>`;
    out += `<ul class="group flat mt-12">${KEYS.filter((k) => k !== key).map((k) => ctx.row({ tag: "button", attrs: `data-g="other" data-key="${k}"`,
      title: `Do ${PLAN.sessions[k].name} instead`, chev: true, cls: "fold" })).join("")}</ul>`;
    if (deloadOffer(sessions, today, p)) out += `<ul class="group mt-12">${ctx.row({ tag: "button", attrs: `data-g="deload"`, lead: ctx.ICON.sunrise,
      title: "Take a deload week", sub: "Your last two sessions felt wrecked. Half the sets for 7 days, same loads." })}</ul>`;
  }
  out += `<h2 class="section">This week · ${wk.count} of ${p.target ?? 4}</h2><ul class="group">${wk.slots.map((s) => ctx.row({
    lead: s.state === "done" ? ctx.ICON.check.replace('class="glyph"', 'class="glyph success"') : ctx.ICON.calendar,
    title: esc(PLAN.sessions[s.key].name), sub: new Date(s.day + "T12:00").toLocaleDateString("en-GB", { weekday: "long" }),
    trail: { done: "Done", missed: "Missed", today: "Today", later: "" }[s.state], trailCls: s.state === "missed" ? "warn" : "" })).join("")}</ul>`;
  out += bodyweight(today) + foodSection(today) + history(sessions) + settings();
  return out;
}

function bodyweight(today) {
  const entries = of("weight").map((r) => ({ date: r.date, kg: r.user_data?.kg })).filter((e) => typeof e.kg === "number");
  const t = weightTrend(entries, today), todays = entries.find((e) => e.date === today);
  const line = !t ? "Weigh in each morning; the average shows after the first one."
    : t.change == null ? `7-day average ${t.avg} kg. The weekly change shows after a second week.`
    : `7-day average ${t.avg} kg, ${t.change >= 0 ? "+" : ""}${t.change} kg on last week. Aim for +${t.lo} to +${t.hi}.`;
  const nudge = { low: "Gaining slower than the aim: add a snack or a bigger portion.", high: "Gaining faster than the aim: some of that is likely fat.", flat: "Flat for two weeks: eat more." }[t?.status] ?? "";
  return `<h2 class="section">Bodyweight</h2><ul class="group flat"><li class="field gym-inline"><label class="row">
    <span class="text"><span class="title">This morning</span></span>
    <input class="gym-num" type="number" inputmode="decimal" step="0.1" min="30" max="250" data-g="weight" value="${todays?.kg ?? ""}" placeholder="kg" aria-label="Bodyweight in kg"></label></li></ul>
    <p class="foot mt-12">${esc(line)}</p>${nudge ? `<p class="foot">${esc(nudge)}</p>` : ""}`;
}

function foodSection(today) {
  const meals = of("meal").filter((m) => m.date === today), totals = dayFood(of("meal"), today), target = PROTEIN_TARGET(profile()?.weight);
  return `<h2 class="section">Food</h2><ul class="group">
    ${ctx.row({ title: `Protein today: about ${totals.protein} g of ${target} g`, sub: "Photo estimates read low on big portions. Treat this as a floor." })}
    ${meals.map((m) => ctx.row({ title: esc(m.data.note || m.data.items.map((i) => i.name).join(", ")), sub: m.data.items.map((i) => esc(i.name)).join(" · "),
      trail: `${m.data.items.reduce((a, i) => a + i.protein_g, 0)} g` })).join("")}
    ${ctx.row({ tag: "button", attrs: `data-g="food"`, lead: ctx.ICON.camera, title: "Add a meal", chev: true })}</ul>`;
}

function history(sessions) {
  if (!sessions.length) return "";
  return `<h2 class="section">Recent</h2><ul class="group">${sessions.slice(0, 5).map((s) => {
    const w = s.user_data?.whoop, top = (s.data.sets ?? []).filter((x) => x.done && x.load > 0).map((x) => e1rm(x.load, x.reps, x.rir) ?? 0);
    return ctx.row({ title: esc(s.title), sub: `${new Date(s.date + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`
      + `${top.length ? ` · best e1RM ${Math.max(...top)} kg` : ""}${s.data.wrecked ? ` · wrecked ${s.data.wrecked}/5` : ""}`,
      trail: w?.strain != null ? `Strain ${w.strain.toFixed(1)}` : "" });
  }).join("")}</ul>`;
}

function settings() {
  const w = whoop.connected === true ? `Connected${whoop.recovery != null ? ` · recovery ${whoop.recovery}%` : ""}` : whoop.connected === false ? "Not connected" : "";
  return `<ul class="group mt-28">
    ${ctx.row({ tag: whoop.connected === true ? "div" : "button", attrs: `data-g="whoop"`, lead: ctx.ICON.sync, title: "WHOOP",
      sub: whoop.connected === true ? "Strain and heart rate come back after each session" : "Start the activity on your band; strain comes back here", trail: w, chev: whoop.connected !== true })}
    ${ctx.row({ tag: "button", attrs: `data-g="edit"`, lead: ctx.ICON.person, title: "Your answers", chev: true })}</ul>`;
}

// ---------- Onboarding (research doc §2): one sheet, every answer editable later ----------

const PARQ = [
  "Has a doctor ever said you have a heart condition or high blood pressure?",
  "Do you feel pain in your chest at rest, in daily life, or when you exercise?",
  "In the last 12 months, have you lost balance from dizziness or lost consciousness?",
  "Have you been diagnosed with another chronic medical condition?",
  "Do you take prescribed medicine for a chronic condition?",
  "Do you have a bone, joint or soft-tissue problem that more activity could make worse?",
  "Has a doctor said you should only do medically supervised activity?",
];
const LIFTS = [["bench", "Bench press"], ["squat", "Back squat"], ["deadlift", "Deadlift"], ["row", "Barbell row"]];
const GOALS = [["rugby", "Rugby performance"], ["size", "Size"], ["strength", "Strength"], ["race", "A race (Hyrox)"]];

function onboarding() {
  const a = profile() ?? {}, v = (k) => esc(a[k] ?? ""), yes = (k) => (a[k] ? "checked" : "");
  const check = (name, label, on) => `<li><label class="row"><span class="text"><span class="title">${esc(label)}</span></span><input type="checkbox" switch name="${name}" ${on}></label></li>`;
  const text = (name, label, attrs = "") => `<li class="field"><label class="row"><span class="text"><span class="title">${esc(label)}</span></span><input class="gym-num" name="${name}" value="${v(name)}" ${attrs}></label></li>`;
  return `${ctx.head(profile() ? "Your answers" : "Set up Train", "About two minutes. Change any of it later.")}
  <form id="gym-setup" autocomplete="off">
    <h2 class="section">Health check</h2><p class="foot">The PAR-Q+ first page, in short. Full form at eparmedx.com.</p>
    <ul class="group flat mt-12">${PARQ.map((q, i) => check(`parq${i}`, q, yes(`parq${i}`))).join("")}</ul>
    <ul class="group flat mt-12">${text("injury", "Injury affecting training", `placeholder="None"`)}
      ${check("surgery", "Surgery in the last 12 months", yes("surgery"))}${check("concussion", "Concussion this season", yes("concussion"))}</ul>
    <h2 class="section">You</h2><ul class="group flat">${text("age", "Age", `type="number" inputmode="numeric"`)}${text("height", "Height (cm)", `type="number" inputmode="numeric"`)}
      ${text("weight", "Bodyweight (kg)", `type="number" inputmode="decimal" step="0.1"`)}${text("years", "Years of steady lifting", `type="number" inputmode="decimal"`)}</ul>
    <h2 class="section">Goal</h2><ul class="group flat"><li><label class="row"><span class="text"><span class="title">Main goal</span></span>
      <select name="goal">${GOALS.map(([k, l]) => `<option value="${k}" ${a.goal === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></li>
      <li><label class="row"><span class="text"><span class="title">Second goal</span></span><select name="goal2"><option value="">None</option>${GOALS.map(([k, l]) => `<option value="${k}" ${a.goal2 === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></li></ul>
    <h2 class="section">A recent heavy set</h2><p class="foot">Weight × reps. Start loads are 90% of the 5-rep max it implies.</p>
    <ul class="group flat mt-12">${LIFTS.map(([id, l]) => `<li class="field"><label class="row"><span class="text"><span class="title">${l}</span></span>
      <input class="gym-num" name="${id}-kg" type="number" inputmode="decimal" step="0.5" placeholder="kg" value="${esc(a.lifts?.[id]?.kg ?? "")}" aria-label="${l} kg">
      <input class="gym-num short" name="${id}-reps" type="number" inputmode="numeric" placeholder="reps" value="${esc(a.lifts?.[id]?.reps ?? "")}" aria-label="${l} reps"></label></li>`).join("")}</ul>
    <h2 class="section">Your week</h2><ul class="group flat">${text("rugby", "Rugby training", `placeholder="Tue, Sat"`)}
      <li><label class="row"><span class="text"><span class="title">Match day</span></span><select name="matchDay">${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) =>
        `<option value="${i}" ${(a.matchDay ?? 3) === i ? "selected" : ""}>${d}</option>`).join("")}</select></label></li>
      ${text("target", "Gym sessions a week", `type="number" inputmode="numeric" placeholder="4"`)}${text("time", "Time per session (min)", `type="number" inputmode="numeric" placeholder="75"`)}
      ${check("limited", "Limited equipment", yes("limited"))}</ul>
    <h2 class="section">Leave out</h2><ul class="group flat">${KEYS.flatMap((k) => PLAN.sessions[k].items).filter((e, i, all) => all.findIndex((x) => x.name === e.name) === i)
      .map((e) => check(`avoid-${e.id}`, e.name, (a.avoid ?? []).includes(e.id) ? "checked" : "")).join("")}</ul>
    <button class="btn primary mt-20" type="submit">${profile() ? "Save" : "Start training"}</button>
    ${profile() ? `<button class="btn plain mt-12" type="button" data-g="cancel">Cancel</button>` : ""}
    <p class="foot" id="gym-setup-status" role="status"></p>
  </form>`;
}

function submitSetup(form) {
  const f = new FormData(form), n = (k) => (f.get(k) === "" || f.get(k) == null ? null : Number(f.get(k)));
  const a = { parq: PARQ.map((_, i) => f.get(`parq${i}`) === "on") };
  PARQ.forEach((_, i) => { a[`parq${i}`] = a.parq[i]; });
  Object.assign(a, { injury: String(f.get("injury") ?? "").trim(), surgery: f.get("surgery") === "on", concussion: f.get("concussion") === "on",
    age: n("age"), height: n("height"), weight: n("weight"), years: n("years"), goal: f.get("goal"), goal2: f.get("goal2") || null,
    rugby: String(f.get("rugby") ?? "").trim(), matchDay: n("matchDay") ?? 3, target: n("target") ?? 4, time: n("time"), limited: f.get("limited") === "on" });
  a.lifts = {}; a.starts = {};
  for (const [id] of LIFTS) {
    const w = n(`${id}-kg`), r = n(`${id}-reps`);
    if (w && r) { a.lifts[id] = { kg: w, reps: r }; const s = startFrom(w, r); if (s) a.starts[id] = s; }
  }
  a.avoid = KEYS.flatMap((k) => PLAN.sessions[k].items).map((e) => e.id).filter((id) => f.get(`avoid-${id}`) === "on");
  a.deloadFrom = profile()?.deloadFrom ?? null;
  delete a.parq;
  const p = profileRow();
  if (p) patch(p, a); else add({ id: "gym-profile", date: null, title: "Train profile", data: { type: "profile" }, user_data: { ...a, userAt: Date.now() } });
  status = a.parq0 || PARQ.some((_, i) => a[`parq${i}`]) || a.concussion
    ? "You answered yes to a health question. See a doctor or physio before training hard."
    : "";
  editing = false;
  ctx.rerender();
}

// ---------- The session in progress ----------

function startSession(key) {
  const today = todayString(), sessions = sessionsOf(rows), rx = prescribe(key, today, { sessions, profile: profile(), recovery: whoop.recovery });
  live = { key, name: rx.name, start: Date.now(), feel: feel || null, deload: rx.phase === "deload", rest: null, skipped: [], swaps: {},
    items: rx.items.map((e) => {
      const last = lastTime(e.id, sessions)?.sets ?? [];
      return { id: e.id, name: e.name, kind: e.kind, unit: e.unit, lo: e.lo, hi: e.hi, rir: e.rir, rest: e.rest, note: e.note ?? "", up: e.up,
        sets: Array.from({ length: e.sets }, (_, i) => ({ load: e.load, reps: e.kind === "time" ? e.hi : (last[i]?.reps ?? e.hi), rir: null, done: false })) };
    }) };
  feel = 0;
  saveLive();
  ctx.rerender();
  scrollTo(0, 0);
}

function liveScreen() {
  const mins = Math.max(0, Math.round((Date.now() - live.start) / 60000));
  let out = ctx.head(live.name, `${mins} min${live.deload ? " · deload" : ""}`);
  out += `<div class="gym-rest" ${live.rest ? "" : "hidden"}><span>Rest</span><b id="gym-rest-left">${restLeft()}</b><button class="btn small secondary" type="button" data-g="skip-rest">Skip</button></div>`;
  live.items.forEach((e, ei) => {
    const skipped = live.skipped.includes(e.id);
    out += `<h2 class="section">${esc(live.swaps[e.id] ?? e.name)}</h2><p class="foot">${e.sets.length} × ${reps(e)}${e.kind === "load" ? ` · RIR ${e.rir}` : ""}${e.up ? " · weight up from last time" : ""}${e.note ? ` · ${esc(e.note)}` : ""}</p>`;
    if (skipped) { out += `<ul class="group flat mt-12">${ctx.row({ tag: "button", attrs: `data-g="unskip" data-e="${ei}"`, title: "Skipped. Tap to bring back.", cls: "fold" })}</ul>`; return; }
    out += `<ul class="group gym-sets mt-12">${e.sets.map((s, si) => `<li class="${s.done ? "done" : ""}"><div class="row gym-set">
      <button class="tick" type="button" data-g="set" data-e="${ei}" data-s="${si}" aria-label="Set ${si + 1} ${s.done ? "done" : "not done"}" aria-pressed="${s.done}">
        <svg viewBox="0 0 22 22"><circle class="ring" cx="11" cy="11" r="10"/><circle class="disc" cx="11" cy="11" r="11"/><path class="check" pathLength="1" d="M6.5 11.5l3 3 6-6.5"/></svg></button>
      <span class="text"><span class="title">Set ${si + 1}</span></span>
      ${e.kind === "load" ? `<input class="gym-num" type="number" inputmode="decimal" step="0.5" data-g="load" data-e="${ei}" data-s="${si}" value="${s.load ?? ""}" placeholder="kg" aria-label="Set ${si + 1} kg">` : ""}
      ${e.kind !== "time" ? `<input class="gym-num short" type="number" inputmode="numeric" data-g="reps" data-e="${ei}" data-s="${si}" value="${s.reps ?? ""}" aria-label="Set ${si + 1} reps">` : `<span class="trail">${e.hi} ${e.unit ?? "s"}</span>`}
      ${e.kind === "load" ? `<select class="gym-rir" data-g="rir" data-e="${ei}" data-s="${si}" aria-label="Set ${si + 1} reps in reserve"><option value="">RIR</option>${[0, 1, 2, 3, 4].map((r) => `<option ${s.rir === r ? "selected" : ""}>${r}</option>`).join("")}</select>` : ""}
    </div></li>`).join("")}</ul>
    <div class="gym-ex-actions"><button type="button" class="link" data-g="skip" data-e="${ei}">Skip</button><button type="button" class="link" data-g="swap" data-e="${ei}">Swap</button></div>`;
  });
  out += `<p class="foot mt-28">How wrecked are you?</p>${seg("wrecked", wrecked)}
    <button class="btn primary mt-12" type="button" data-g="finish" ${wrecked ? "" : "disabled"}>Finish</button>
    <button class="btn plain mt-12" type="button" data-g="discard">Discard session</button>`;
  return out;
}

function restLeft() {
  const s = live?.rest ? Math.max(0, Math.ceil((live.rest.until - Date.now()) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function tick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (!live?.rest) return clearInterval(tickTimer);
    const el = $("gym-rest-left");
    if (el) el.textContent = restLeft();
    if (Date.now() >= live.rest.until) {
      live.rest = null; saveLive(); clearInterval(tickTimer);
      navigator.vibrate?.(300);
      ctx.rerender();
    }
  }, 1000);
}

function toggleSet(ei, si) {
  const e = live.items[ei], s = e.sets[si];
  s.done = !s.done;
  if (s.done && e.kind === "load" && s.rir == null && si > 0) s.rir = e.sets[si - 1].rir; // RIR carries to the next set until changed
  const next = s.done && nextSet(ei, si);
  if (next && e.rest > 0) {
    live.rest = { until: Date.now() + e.rest * 1000 };
    restTimer(live.rest.until, `${next.name} · set ${next.set} of ${next.of}`);
    tick();
  } else if (live.rest) { live.rest = null; restTimer(null); }
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

function finish() {
  const today = todayString(), end = Date.now();
  const sets = live.items.flatMap((e) => live.skipped.includes(e.id) ? [] : e.sets.map((s) => ({ ex: e.id, load: s.load, reps: s.reps, rir: s.rir, done: s.done })));
  add({ id: `you-gym-${crypto.randomUUID()}`, date: today, title: live.name,
    data: { type: "session", key: live.key, start: live.start, end, feel: live.feel, wrecked, deload: live.deload, sets, skipped: live.skipped, swaps: live.swaps },
    user_data: {} });
  restTimer(null);
  live = null; wrecked = 0; saveLive();
  status = "Saved. WHOOP strain comes back once the band has scored the workout.";
  ctx.rerender();
  scrollTo(0, 0);
  setTimeout(pullStrain, 4 * 60000);
}

// ---------- Food (research doc §8) ----------

function foodSheet() {
  const totals = food.items.reduce((t, i) => ({ p: t.p + i.protein_g, k: t.k + i.kcal }), { p: 0, k: 0 });
  return `<div class="grabber" aria-hidden="true"></div><div class="sheet-head"><h2 class="section-title">Add a meal</h2>
    <button class="close" type="button" data-close aria-label="Close">${ctx.ICON.close}</button></div>
    <div class="pane"><ul class="group flat">
      <li><label class="row">${ctx.ICON.camera}<span class="text"><span class="title">${food.photo ? "Photo added" : "Take a photo"}</span></span>
        <input class="overlay" type="file" accept="image/*" capture="environment" data-g="photo" aria-label="Take a photo"></label></li>
      <li class="field"><input type="text" data-g="note" value="${esc(food.note)}" placeholder="What is it? e.g. Nando's half chicken, large rice" aria-label="What is it?"></li></ul>
    <button class="btn secondary mt-12" type="button" data-g="estimate" ${food.busy || (!food.photo && !food.note.trim()) ? "disabled" : ""}>${food.busy ? "Estimating…" : "Estimate"}</button>
    ${food.error ? `<p class="foot warn">${esc(food.error)}</p>` : ""}
    ${food.items.length ? `<ul class="group flat mt-20">${food.items.map((i, n) => `<li class="field"><label class="row"><span class="text"><span class="title">${esc(i.name)}</span>
      <span class="subtitle">${i.protein_g} g protein · ${i.kcal} kcal</span></span>
      <input class="gym-num" type="number" inputmode="numeric" data-g="grams" data-i="${n}" value="${i.grams}" aria-label="${esc(i.name)} grams"><span class="trail">g</span></label></li>`).join("")}</ul>
      <p class="foot mt-12">About ${totals.p} g protein, ${totals.k} kcal. Fix the grams of the main item; it reads low on big portions.</p>
      <button class="btn primary mt-12" type="button" data-g="save-meal">Save</button>` : ""}</div>`;
}
const paintFood = () => { const el = $("food-sheet"); el.innerHTML = foodSheet(); };

async function estimate() {
  food.busy = true; food.error = ""; paintFood();
  try {
    const reply = ctx.demo ? demoFood() : await call("ai", foodRequest(food.note, food.photo), { "X-Sidebrain-Task": "food" });
    food.items = parseFood(reply).map((i) => scaleItem(i, i.grams));
    if (!food.items.length) food.error = "Couldn’t read that meal. Add a line about what it is and try again.";
  } catch (e) { food.error = e.message; }
  food.busy = false; paintFood();
}
const demoFood = () => ({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ items: [
  { name: "Grilled chicken", grams: 250, protein_g: 62, kcal: 410 }, { name: "Spicy rice", grams: 220, protein_g: 6, kcal: 330 }] }) }] }] });

// ---------- Events ----------

function click(ev) {
  const t = ev.target.closest("[data-g]");
  if (!t || t.tagName === "INPUT" || t.tagName === "SELECT") return;
  const d = t.dataset, ei = Number(d.e), si = Number(d.s);
  switch (d.g) {
    case "feel": feel = Number(d.v); return ctx.rerender();
    case "wrecked": wrecked = Number(d.v); return ctx.rerender();
    case "start": return startSession(d.key);
    case "other": return startSession(d.key);
    case "set": return toggleSet(ei, si);
    case "skip-rest": live.rest = null; restTimer(null); saveLive(); return ctx.rerender();
    case "skip": live.skipped.push(live.items[ei].id); saveLive(); return ctx.rerender();
    case "unskip": live.skipped = live.skipped.filter((id) => id !== live.items[ei].id); saveLive(); return ctx.rerender();
    case "swap": {
      const name = prompt("Swap for which exercise?", live.swaps[live.items[ei].id] ?? "");
      if (name?.trim()) { live.swaps[live.items[ei].id] = name.trim().slice(0, 60); saveLive(); ctx.rerender(); }
      return;
    }
    case "finish": return finish();
    case "discard": if (confirm("Discard this session? Nothing from it is saved.")) { restTimer(null); live = null; saveLive(); ctx.rerender(); } return;
    case "deload": patch(profileRow(), { deloadFrom: todayString() }); status = "Deload week: half the sets, same loads, until next week."; return ctx.rerender();
    case "edit": editing = true; ctx.rerender(); return scrollTo(0, 0);
    case "cancel": editing = false; return ctx.rerender();
    case "whoop": return connectWhoop();
    case "food": food = { items: [], note: "", busy: false, error: "", photo: null }; paintFood(); return $("food-sheet").showModal();
    case "estimate": return estimate();
    case "save-meal":
      add({ id: `you-gym-${crypto.randomUUID()}`, date: todayString(), title: food.note.trim() || "Meal", data: { type: "meal", note: food.note.trim(), items: food.items }, user_data: {} });
      $("food-sheet").close(); return ctx.rerender();
  }
}

async function change(ev) {
  const t = ev.target, d = t.dataset;
  if (t.form?.id === "gym-setup") return;
  const e = live?.items[Number(d.e)], s = e?.sets[Number(d.s)], v = t.value === "" ? null : Number(t.value);
  if (d.g === "load" && s) { s.load = v; for (const later of e.sets.slice(Number(d.s) + 1)) if (!later.done) later.load = v; saveLive(); ctx.rerender(); }
  else if (d.g === "reps" && s) { s.reps = v; saveLive(); }
  else if (d.g === "rir" && s) { s.rir = v; saveLive(); }
  else if (d.g === "weight" && v > 0) {
    const today = todayString(), r = of("weight").find((x) => x.date === today);
    if (r) patch(r, { kg: v }); else add({ id: `you-gym-w-${today}`, date: today, title: "Bodyweight", data: { type: "weight" }, user_data: { kg: v, userAt: Date.now() } });
    ctx.rerender();
  } else if (d.g === "note") { food.note = t.value; paintFood(); }
  else if (d.g === "grams") { const i = Number(d.i); food.items[i] = scaleItem(food.items[i], t.value); paintFood(); }
  else if (d.g === "photo" && t.files?.[0]) {
    try { food.photo = await ctx.dataUrl(await ctx.shrink(t.files[0], 768)); } catch { food.error = "Couldn’t read that photo."; }
    paintFood();
  }
}

async function connectWhoop() {
  if (ctx.demo) { status = "WHOOP connects on the real app, not the demo."; return ctx.rerender(); }
  try { location.href = (await call("whoop", { action: "connect" })).url; }
  catch (e) { status = `WHOOP: ${e.message}`; ctx.rerender(); }
}

export function bindSubmit() {
  document.addEventListener("submit", (ev) => { if (ev.target.id === "gym-setup") { ev.preventDefault(); submitSetup(ev.target); } });
}
export const exerciseName = (id) => exerciseById(id)?.name ?? id;
