// The Train plugin's logic: the Autumn plan as data, and the six rules that adjust it (docs/(C) Gym plugin research.md §3).
// Pure functions only, so `node --test web/gym.test.mjs` checks every rule. Days are "YYYY-MM-DD" in the phone's calendar.
// Rows are `gym` items: data.type "session" | "weight" | "meal", plus one "profile" row (id gym-profile, answers in user_data).
import { addDays, daysBetween } from "./sm2.js";

const round = (x, step = 2.5) => Math.round(x / step) * step;
const weekday = (day) => new Date(day + "T12:00:00").getDay(); // 0 Sun … 6 Sat
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---- The plan: (C) Gym & Running Plan — Autumn 2026.md (28 Sept), rugby Tue + Sat, match Wed ----
// kind: "load" (kg × reps), "reps" (bodyweight reps), "time" (seconds or minutes, ticked done). inc: kg added by R1.
// main: a main lift (R6 never cuts it, the light week keeps it). lower: heavy legs (R2). rest: seconds between sets.
// alts: what the session's Swap sheet offers, the plan's own "or" first.
const ex = (id, name, sets, lo, hi, o = {}) => ({ id, name, sets, lo, hi, kind: "load", inc: 2.5, main: false, lower: false, rest: 90, start: null, ...o });
export const PLAN = {
  // Deload and light weeks by their Monday: the plan calls them "week 7" and "week 12", but its own dates (w/c 2 Nov, 7 Dec)
  // are weeks 6 and 11 counted from 28 Sept. The dates win.
  start: "2026-09-28", end: "2026-12-12", deload: ["2026-11-02"], light: ["2026-12-07"], matchDay: 3,
  sessions: {
    A: { day: 1, name: "Upper strength + power", items: [
      ex("box-jump", "Box jumps", 3, 5, 5, { kind: "reps", rest: 90, note: "Full reset each rep" , alts: ["Broad jumps", "Med-ball slams"] }),
      ex("bench", "Bench press", 4, 4, 5, { main: true, start: 117.5, rest: 180 , alts: ["Dumbbell bench press", "Floor press"] }),
      ex("pull-up", "Weighted pull-up", 4, 5, 8, { start: 0, rest: 150, note: "Or chest-supported row" , alts: ["Chest-supported row", "Lat pulldown"] }),
      ex("ohp", "Overhead press", 3, 6, 8, { rest: 120, note: "Or landmine press" , alts: ["Landmine press", "Dumbbell shoulder press"] }),
      ex("neck-a", "Neck isometrics, 4 directions", 2, 15, 15, { kind: "time", rest: 30, unit: "s" }),
    ] },
    B: { day: 0, name: "Heavy lower + pull", items: [
      ex("squat", "Back squat", 4, 4, 6, { main: true, lower: true, inc: 5, start: 117.5, rest: 180 , alts: ["Front squat", "Safety bar squat"] }),
      ex("deadlift", "Deadlift (hex bar)", 4, 4, 6, { main: true, lower: true, inc: 5, start: 145, rest: 180 , alts: ["Conventional deadlift", "Romanian deadlift"] }),
      ex("row", "Barbell row", 3, 8, 8, { rest: 120 , alts: ["Chest-supported row", "Seal row"] }),
      ex("nordic-b", "Nordic hamstring curls", 3, 3, 5, { kind: "reps", lower: true, rest: 120 , alts: ["Razor curls", "Lying leg curl"] }),
      ex("copenhagen", "Copenhagen adduction, per side", 2, 6, 8, { kind: "reps", rest: 60 , alts: ["Short-lever Copenhagen", "Cable adduction"] }),
      ex("neck-b", "Neck isometrics", 2, 15, 15, { kind: "time", rest: 30, unit: "s" }),
    ] },
    C: { day: 4, name: "Light upper + prehab", items: [
      ex("incline-db", "Incline dumbbell press", 3, 8, 10, { inc: 2, rest: 90 , alts: ["Incline bench press", "Push-ups"] }),
      ex("cs-row", "Chest-supported row", 3, 10, 10, { rest: 90 , alts: ["Seated cable row", "Dumbbell row"] }),
      ex("face-pull", "Face pulls", 3, 15, 15, { kind: "reps", rest: 60 , alts: ["Band pull-aparts", "Rear-delt fly"] }),
      ex("ext-rot", "Band external rotations", 2, 15, 15, { kind: "reps", rest: 45 , alts: ["Cable external rotation"] }),
      ex("arms", "Arms (optional)", 2, 12, 12, { rest: 60 }),
      ex("bike-c", "Easy bike", 1, 20, 20, { kind: "time", unit: "min", rest: 0 , alts: ["Easy row", "Easy walk"] }),
    ] },
    D: { day: 5, name: "Intervals + Nordics", items: [
      ex("warm-up", "Warm-up", 1, 10, 10, { kind: "time", unit: "min", rest: 0 }),
      ex("intervals", "6 min of 15 s on / 15 s off", 3, 6, 6, { kind: "time", unit: "min", rest: 180, conditioning: true, note: "55–60 m per 15 s rep" , alts: ["Bike intervals", "Rower intervals"] }),
      ex("nordic-d", "Nordics (light)", 2, 3, 3, { kind: "reps", lower: true, rest: 90 , alts: ["Razor curls", "Lying leg curl"] }),
      ex("pallof", "Pallof press, per side", 2, 10, 10, { kind: "reps", rest: 60 , alts: ["Dead bug", "Side plank"] }),
    ] },
  },
};
export const KEYS = ["A", "B", "C", "D"];
const inPlan = (plan, id) => KEYS.flatMap((k) => plan.sessions[k].items).find((e) => e.id === id) ?? null;
/** An exercise by id: from this user's plan first (pass the profile), then the Autumn plan. */
export const exerciseById = (id, profile = null) => inPlan(planOf(profile), id) ?? inPlan(PLAN, id);

/** The plan with this user's edits (Edit plan): profile.plan[key] is that session's whole list, in order. Each item keeps
 *  the Autumn plan's fields for its id (main, lower, inc, start, alts) under the edits, so every rule reads it as before. */
export function planOf(profile) {
  const own = profile?.plan;
  if (!own || typeof own !== "object") return PLAN;
  const sessions = {};
  for (const k of KEYS) sessions[k] = Array.isArray(own[k])
    ? { ...PLAN.sessions[k], items: own[k].filter((o) => o?.id).map((o) => ({ ...(inPlan(PLAN, o.id) ?? ex(o.id, o.name ?? o.id, 3, 8, 12)), ...o })) }
    : PLAN.sessions[k];
  return { ...PLAN, sessions };
}

/** Plan week 1 starts on PLAN.start (a Monday). Past the end the plan has run out and there is nothing to prescribe. */
export const planWeek = (day) => Math.floor(daysBetween(PLAN.start, day) / 7) + 1;
export const planOver = (day) => day > PLAN.end;
/** The plan's session for this weekday, or null on rugby and rest days. */
export const sessionForDay = (day) => KEYS.find((k) => PLAN.sessions[k].day === weekday(day)) ?? null;

/** The morning check-in's rugby answer for a day (Today's gym row "daily-YYYY-MM-DD"): "training" | "match" | "no", with
 *  "rest" read as "no"; null when it wasn't asked or answered. */
export function rugbyOn(day, rows = []) {
  const r = rows.find((x) => x.id === `daily-${day}`)?.user_data?.rugby;
  return r === "rest" ? "no" : ["training", "match", "no"].includes(r) ? r : null;
}

/** What the day is, for Train's hero and later Food's day type: {rugby, what, key}. `what` is "match", "training" or "rest"
 *  from the check-in (a "no" counts only on a rugby or match weekday), else null. On a match day the plan's session drops. */
export function dayPlan(day, rows = [], profile = {}) {
  const rugby = rugbyOn(day, rows), wd = weekday(day);
  const rugbyDay = wd === (profile?.matchDay ?? PLAN.matchDay) || (profile?.rugbyDays ?? [2, 6]).includes(wd);
  const what = rugby === "match" ? "match" : rugby === "training" ? "training" : rugby === "no" && rugbyDay ? "rest" : null;
  return { rugby, what, key: what === "match" ? null : sessionForDay(day) };
}

// ---- History ----

/** Logged sessions, newest first by date then end time. A deleted one (user_data.deleted, so Undo can bring it back) is gone. */
export const sessionsOf = (rows) => rows.filter((r) => r.data?.type === "session" && !r.deleted_at && !r.user_data?.deleted)
  .sort((a, b) => (a.date === b.date ? (b.data.end ?? 0) - (a.data.end ?? 0) : a.date < b.date ? 1 : -1));

/** The id for an exercise by name: the Autumn plan's own when it has one (so history is shared), else one made from the name. */
export const idFor = (name) => KEYS.flatMap((k) => PLAN.sessions[k].items).find((e) => e.name.toLowerCase() === name.trim().toLowerCase())?.id
  ?? `you-ex-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x"}`;

/** "Update plan" on a swap: the new lift takes the old one's place, sets, reps, rest and role, with its own id and history
 *  (no start load); the old lift becomes its first alternative, so it's one tap back. */
export function swapInPlan(items, oldId, name) {
  const id = idFor(name);
  return items.map((e) => (e.id !== oldId ? e
    : { ...e, id, name: name.trim(), start: null, note: "", alts: [e.name, ...(e.alts ?? []).filter((a) => a !== name.trim())] }));
}

/** "Update plan" during a session: the plan always takes the new lift (returned as `items`). Today moves to it only while
 *  none of its sets are ticked; ticked sets were done as the old lift, so today stays a swap ("swap") and they never count
 *  for either lift's load. Returns {items, live, today: "moved" | "swap"}; `live` is a new copy. */
export function updateSwap(live, ei, name, items, sessions) {
  const next = swapInPlan(items, live.items[ei].id, name), id = idFor(name), out = structuredClone(live), x = out.items[ei];
  if (x.sets.some((s) => s.done)) { out.swaps[x.id] = name.trim(); return { items: next, live: out, today: "swap" }; }
  delete out.swaps[x.id];
  const last = lastTime(id, sessions), load = last ? Math.max(...last.sets.map((s) => num(s.load) ?? 0)) || null : null;
  Object.assign(x, { id, name: name.trim(), note: "", up: false, alts: next.find((e) => e.id === id)?.alts ?? [] });
  if (x.kind === "load") for (const s of x.sets) if (!s.done) s.load = load;
  return { items: next, live: out, today: "moved" };
}

/** A session's sets: an edit made afterwards (user_data.sets, from History) wins over what was logged. */
export const setsOf = (s) => s.user_data?.sets ?? s.data?.sets ?? [];

/** The last time an exercise was done: {date, sets, deload}, sets being the ticked ones only. */
export function lastTime(id, sessions) {
  for (const s of sessions) {
    const sets = setsOf(s).filter((x) => x.ex === id && x.done && !x.swap); // a swapped-in lift never moves the plan's load
    if (sets.length) return { date: s.date, sets, deload: !!s.data.deload };
  }
  return null;
}

/** Epley with reps in reserve, for trend lines only: RIR is unreliable past 12 reps (Halperin 2022), so those give null. */
export function e1rm(load, reps, rir = 0) {
  if (!(load > 0) || !(reps > 0) || reps > 12) return null;
  return Math.round(load * (1 + (reps + (num(rir) ?? 0)) / 30) * 2) / 2;
}

/** A start load from a recent heavy set (onboarding): 90% of the 5-rep max that set implies, as the plan started bench. */
export const startFrom = (load, reps) => (load > 0 && reps > 0 && reps <= 12 ? round(0.9 * load * (1 + reps / 30) / (1 + 5 / 30)) : null);

/** R1 double progression + R4 long gap. Returns {load, why} for the next session, or null when there's no load to suggest. */
export function nextLoad(e, sessions, today, starts = {}) {
  if (e.kind !== "load") return null;
  const last = lastTime(e.id, sessions);
  if (!last) {
    const s = num(starts[e.id]) ?? e.start;
    return s == null ? null : { load: s, why: "start" };
  }
  const load = Math.max(...last.sets.map((x) => num(x.load) ?? 0));
  if (daysBetween(last.date, today) > 14) return { load: round(load * 0.9), why: "gap" }; // R4: over 2 weeks off, back 10%
  if (last.deload) return { load, why: "same" };
  const top = last.sets.length >= e.sets && last.sets.every((x) => (num(x.reps) ?? 0) >= e.hi && (num(x.rir) ?? -1) >= 2 && (num(x.load) ?? 0) >= load);
  return top ? { load: load + e.inc, why: "up" } : { load, why: "same" };
}

/** WHOOP recovery under 34% is red, WHOOP's own band. */
export const isRed = (recovery) => num(recovery) != null && recovery < 34;

/** Is this day inside an asked-for deload (profile.deloadFrom … +6) or a planned one? */
export function phaseOf(day, profile = {}) {
  if (planOver(day)) return "over";
  const from = profile.deloadFrom;
  if (typeof from === "string" && day >= from && day <= addDays(from, 6)) return "deload";
  const monday = addDays(day, -((weekday(day) + 6) % 7));
  if (PLAN.deload.includes(monday)) return "deload";
  if (PLAN.light.includes(monday)) return "light";
  return "build";
}

/** Today's prescription for one session: the exercises with sets, rep range and load, and a note for every rule that
 *  changed something (R4–R6), so no input is silently ignored. */
export function prescribe(key, day, { sessions = [], profile = {}, recovery = null, rugby = null } = {}) {
  const plan = planOf(profile).sessions[key], phase = phaseOf(day, profile), red = isRed(recovery);
  const skip = new Set(profile.avoid ?? []), notes = [];
  if (phase === "deload") notes.push("Deload week: half the sets, same loads, two more reps in reserve.");
  if (phase === "light") notes.push("Light week: main lifts 2 × 3 at RPE 7, one set of Nordics and Copenhagens.");
  if (red) notes.push(`WHOOP recovery ${recovery}%: one set fewer on accessories${key === "D" ? ", and easy bike instead of intervals" : ""}. Main lifts unchanged.`);
  const easy = rugby === "training"; // the check-in said rugby training today: no hard conditioning on top of it
  if (easy && plan.items.some((e) => e.conditioning)) notes.push("Rugby training today: conditioning swapped for easy bike.");
  const items = [];
  for (const e of plan.items) {
    if (skip.has(e.id)) continue;
    if (phase === "light" && !e.main && !["nordic-b", "nordic-d", "copenhagen"].includes(e.id)) continue;
    let sets = e.sets, lo = e.lo, hi = e.hi, rir = e.main ? "1–3" : "1–2", name = e.name;
    if (phase === "deload") { sets = Math.ceil(sets / 2); rir = "3–4"; }
    if (phase === "light") { sets = e.main ? 2 : 1; if (e.main) { lo = hi = 3; rir = "3"; } }
    if (red && !e.main) sets = Math.max(1, sets - 1);
    if (red && e.conditioning) { name = "Easy bike (recovery is red)"; sets = 1; lo = hi = 20; }
    if (easy && e.conditioning) { name = "Easy bike"; sets = 1; lo = hi = 20; }
    const next = e.kind === "load" ? nextLoad(e, sessions, day, profile.starts) : null;
    if (next?.why === "gap") notes.push(`${e.name}: over 2 weeks since you last did it, so 10% lighter.`);
    items.push({ ...e, name, sets, lo, hi, rir, load: next?.load ?? null, up: next?.why === "up" });
  }
  return { key, name: plan.name, phase, items, notes };
}

/** R2 and R3 as plain warnings for the session about to start. `doneToday` are today's logged sessions. */
export function warnings(key, day, now, profile = {}, doneToday = [], rows = []) {
  const out = [], match = profile.matchDay ?? PLAN.matchDay, wd = weekday(day);
  const heavyLegs = planOf(profile).sessions[key].items.some((e) => e.main && e.lower);
  // R2: a check-in answer for today or yesterday wins over the weekday; without one the match weekday counts.
  const isMatch = (d, weekdayRule) => { const a = rugbyOn(d, rows); return a ? a === "match" : weekdayRule; };
  if (heavyLegs && (isMatch(day, wd === match) || isMatch(addDays(day, -1), wd === (match + 1) % 7)))
    out.push("Heavy legs within 48 h of the match. Do the light session today and keep this one for Sunday.");
  if (heavyLegs && rugbyOn(day, rows) === "training")
    out.push("Rugby training today. Heavy legs on top of it is a lot: go light, or move this session.");
  const conditioning = key === "D";
  for (const s of doneToday) {
    const other = s.data.key === "D";
    if (other !== conditioning && now - (s.data.end ?? 0) < 3 * 3600_000)
      out.push("Less than 3 hours since your last session. Lift first and keep conditioning 3 hours apart where you can.");
  }
  return [...new Set(out)];
}

// ---- Records (research: Hevy, Fitbod): one PR rule for the live tick, History and the exercise screen ----
// A ticked set is a PR when it beats every set of that exercise before it on weight, on e1RM, or on reps at a weight done
// before. The first time is the baseline, never a PR. Swapped-in sets are another lift, so they never count.

const counts = (x) => !!x?.done && !x.swap && (num(x.reps) ?? 0) > 0;
export const best = () => ({ n: 0, load: 0, e1: 0, at: {} });
export function beats(b, x) {
  if (!b.n || !counts(x)) return false;
  const load = num(x.load) ?? 0, e = e1rm(load, x.reps, x.rir);
  return load > b.load || (e != null && e > b.e1) || (b.at[load] != null && x.reps > b.at[load]);
}
export function absorb(b, x) {
  if (!counts(x)) return b;
  const load = num(x.load) ?? 0;
  b.n++; b.load = Math.max(b.load, load); b.e1 = Math.max(b.e1, e1rm(load, x.reps, x.rir) ?? 0); b.at[load] = Math.max(b.at[load] ?? 0, x.reps);
  return b;
}
/** The best so far for one exercise over these sessions. */
export const bestOf = (id, sessions) => sessions.reduce((b, s) => { for (const x of setsOf(s)) if (x.ex === id) absorb(b, x); return b; }, best());

/** Every PR in the log as "sessionId:setIndex", walking the sessions oldest first (sessions come newest first). The first
 *  session of an exercise is its baseline, so its later sets beating its first never count. */
export function prsOf(sessions) {
  const bests = {}, out = new Set();
  for (const s of [...sessions].reverse()) {
    const had = new Set(Object.keys(bests).filter((k) => bests[k].n));
    setsOf(s).forEach((x, i) => {
      const b = (bests[x.ex] ??= best());
      if (had.has(x.ex) && beats(b, x)) out.add(`${s.id}:${i}`);
      absorb(b, x);
    });
  }
  return out;
}

/** One exercise across the log, oldest first: each session's counted sets, top weight, best e1RM and volume (kg × reps). */
export function exerciseLog(id, sessions) {
  return [...sessions].reverse().flatMap((s) => {
    const sets = setsOf(s).filter((x) => x.ex === id && counts(x));
    if (!sets.length) return [];
    const e1 = sets.map((x) => e1rm(x.load, x.reps, x.rir)).filter((v) => v != null);
    return [{ id: s.id, date: s.date, sets, top: Math.max(...sets.map((x) => num(x.load) ?? 0)), e1: e1.length ? Math.max(...e1) : null,
      volume: Math.round(sets.reduce((a, x) => a + (num(x.load) ?? 0) * x.reps, 0)) }];
  });
}

/** Records from an exerciseLog: heaviest set, best e1RM, best set and session volume, and the heaviest weight at each rep count. */
export function records(log) {
  const sets = log.flatMap((l) => l.sets.map((x) => ({ load: num(x.load) ?? 0, reps: x.reps, rir: x.rir, date: l.date })));
  if (!sets.length) return null;
  const top = (f) => sets.reduce((a, x) => (f(x) > f(a) ? x : a));
  const heaviest = top((x) => x.load * 1000 + x.reps), bestSet = top((x) => x.load * x.reps);
  const e1 = log.filter((l) => l.e1 != null).reduce((a, l) => (!a || l.e1 > a.e1 ? l : a), null);
  const session = log.reduce((a, l) => (l.volume > a.volume ? l : a));
  const at = {};
  for (const x of sets) if (x.reps <= 12 && (!at[x.reps] || x.load > at[x.reps].load)) at[x.reps] = x;
  return { heaviest, e1: e1 && { value: e1.e1, date: e1.date }, set: { ...bestSet, volume: Math.round(bestSet.load * bestSet.reps) },
    session: { volume: session.volume, date: session.date }, at: Object.values(at).sort((a, b) => a.reps - b.reps), mostReps: top((x) => x.reps) };
}

/** How a session left you, asked when it's finished: 1 Fine, 2 Tired, 3 Wrecked. */
export const WRECKED = ["Fine", "Tired", "Wrecked"];
/** How you feel before it: 1 Rough, 2 OK, 3 Good. */
export const FEEL = ["Rough", "OK", "Good"];

/** R5 on demand: the last two sessions both rated Wrecked, and no deload under way. */
export function deloadOffer(sessions, day, profile = {}) {
  if (phaseOf(day, profile) === "deload") return false;
  const [a, b] = sessions;
  return !!(a && b && (a.data.wrecked ?? 0) >= 3 && (b.data.wrecked ?? 0) >= 3);
}

/** This week (Mon–Sun): each plan session with its day and whether it was done; missed ones stay missed (R4: never stacked). */
export function week(day, sessions) {
  const monday = addDays(day, -((weekday(day) + 6) % 7)), sunday = addDays(monday, 6);
  const done = sessions.filter((s) => s.date >= monday && s.date <= sunday);
  const slots = KEYS.map((k) => {
    const d = addDays(monday, (PLAN.sessions[k].day + 6) % 7);
    const hit = done.find((s) => s.data.key === k);
    return { key: k, day: d, state: hit ? "done" : d < day ? "missed" : d === day ? "today" : "later" };
  }).sort((a, b) => (a.day < b.day ? -1 : 1));
  return { monday, slots, count: done.length };
}

// ---- Bodyweight (research doc §5): a 7-day average against +0.25–0.5% of bodyweight a week (Iraki 2019) ----

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const windowAvg = (entries, from, to) => avg(entries.filter((e) => e.date >= from && e.date <= to).map((e) => e.kg));

/** {avg, change, lo, hi, status} where status is "low" | "ok" | "high" | "flat" | null (not enough weigh-ins yet). */
export function weightTrend(entries, day) {
  const now = windowAvg(entries, addDays(day, -6), day), before = windowAvg(entries, addDays(day, -13), addDays(day, -7));
  if (now == null) return null;
  const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;
  const lo = r2(now * 0.0025), hi = r2(now * 0.005);
  if (before == null) return { avg: r1(now), change: null, lo, hi, status: null };
  const change = r2(now - before), older = windowAvg(entries, addDays(day, -20), addDays(day, -14));
  const status = older != null && Math.abs(now - older) < 0.15 ? "flat" : change < lo ? "low" : change > hi ? "high" : "ok";
  return { avg: r1(now), change, lo, hi, status };
}

// ---- Food (research doc §8): a photo + one line → items with grams, protein and kcal, all editable ----

export const PROTEIN_TARGET = (kg) => Math.round(1.6 * (kg || 92)); // Morton 2018: no further gain past ~1.6 g/kg

/** Scales an item to new grams from the model's first estimate (kept in `base`), so repeated edits never drift. */
export function scaleItem(item, grams) {
  const base = item.base ?? { grams: item.grams, protein_g: item.protein_g, kcal: item.kcal };
  const g = Math.max(0, Number(grams) || 0), f = base.grams > 0 ? g / base.grams : 0;
  return { ...item, base, grams: g, protein_g: Math.round(base.protein_g * f), kcal: Math.round(base.kcal * f) };
}

export const dayFood = (meals, day) => meals.filter((m) => m.date === day && !m.user_data?.gone).flatMap((m) => m.user_data?.items ?? m.data?.items ?? [])
  .reduce((t, i) => ({ protein: t.protein + (i.protein_g || 0), kcal: t.kcal + (i.kcal || 0) }), { protein: 0, kcal: 0 });

const FOOD_RULES = "You estimate food from a photo and the person's note. List each food separately with its cooked weight in grams, protein in grams and kcal. "
  + "Portions are often restaurant-sized: count cooking oil, sauces and sides. When unsure of a portion, use the larger likely size. Use the note's names and amounts over what you see.";

/** The Responses-API body for the `ai` function (X-Sidebrain-Task: food). Strict JSON schema, so the reply always parses. */
export function foodRequest(note, image) {
  const item = { type: "object", additionalProperties: false, required: ["name", "grams", "protein_g", "kcal"],
    properties: { name: { type: "string" }, grams: { type: "number" }, protein_g: { type: "number" }, kcal: { type: "number" } } };
  return {
    instructions: FOOD_RULES,
    input: [{ role: "user", content: [{ type: "input_text", text: note?.trim() || "No note." }, ...(image ? [{ type: "input_image", image_url: image }] : [])] }],
    text: { format: { type: "json_schema", name: "meal", strict: true,
      schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: item } } } } },
    max_output_tokens: 1500,
  };
}

/** The items out of a Responses-API reply, cleaned: positive whole numbers, at most 12 items, nothing without a name. */
export function parseFood(reply) {
  const text = (reply?.output ?? []).flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text;
  let items = [];
  try { items = JSON.parse(text ?? "{}").items ?? []; } catch { return []; }
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  return items.filter((i) => typeof i?.name === "string" && i.name.trim()).slice(0, 12)
    .map((i) => ({ name: i.name.trim().slice(0, 60), grams: n(i.grams), protein_g: n(i.protein_g), kcal: n(i.kcal) }));
}

// ---- WHOOP: strain and heart rate pulled back by time (the API is read-only, research doc §4) ----

/** The WHOOP workout that overlaps the session most, allowing 15 minutes either side, or null. */
export function whoopFor(workouts, start, end) {
  const pad = 15 * 60_000;
  let best = null, most = 0;
  for (const w of workouts ?? []) {
    const ws = Date.parse(w.start), we = Date.parse(w.end);
    const overlap = Math.min(we, end + pad) - Math.max(ws, start - pad);
    if (overlap > most) { most = overlap; best = w; }
  }
  return best && { id: best.id, sport: best.sport_name ?? null, strain: num(best.strain), avgHr: num(best.average_heart_rate), maxHr: num(best.max_heart_rate) };
}
