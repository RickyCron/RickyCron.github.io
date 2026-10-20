// Suggestions (proactive nudges N1–N8) and the morning check-in, as pure functions: no DOM, no clock reads, so
// `node --test web/nudges.test.mjs` feeds any `now`. Spec: scratchpad (C) v2-spec-nudges-checkin.md §1–§3.
// State lives in one synced `gym` row a day, id daily-YYYY-MM-DD, data.type "daily": user_data {rugby, answeredAt, shown,
// acted, muted: {key: "YYYY-MM-DD"}}. app.js renders and writes; this file only decides.
import { todayString, addDays, daysBetween, due } from "./sm2.js";
import { own, gone, closedApplication, weightPercent, shortDay, clock, WEEKDAYS, isClass, moduleOfEvent } from "./today.js";
import { lectureDay } from "./notes.js";
import { PLAN, week, planOver, sessionForDay, sessionsOf, prescribe, dayFood, PROTEIN_TARGET } from "./gym.js";

// Thresholds are rules of thumb (spec "guess"), the first thing to tune at the 14-day review.
export const T = { appFrom: 8, appTo: 14, msBack: 7, msAhead: 28, startWeight: 20, startFrom: 8, startTo: 21, cards: 15,
                   reviewFrom: 2, reviewTo: 7, noteDays: 14, classHours: 48, trainFrom: 16, foodFrom: 17, proteinShare: 0.5,
                   open: 8, close: 22, checkinFrom: 5, checkinTo: 15, cap: 2, snooze: 3, dismiss: 7, titleMax: 60 };

export const dailyId = (day) => `daily-${day}`;
export const dailyOf = (daily, day) => daily.find((r) => r.id === dailyId(day)) ?? null;
/** "no" | "training" | "match" | "rest", or null when not answered (or cleared). */
export const rugbyOn = (daily, day) => dailyOf(daily, day)?.user_data?.rugby ?? null;
/** Today's all-day line after the check-in (K7); "no" adds nothing. */
export const RUGBY_LINE = { training: "Rugby training", match: "Match day", rest: "Rugby rest" };

/** K5: the card shows from 05:00 to 14:59 while Train is on with a profile and today has no answer. An answer cleared from
 *  the all-day line (K7, rugby: null) asks again until 21:59, so a wrong tap after 15:00 is still fixable. */
export function showCheckin({ now, on, profile, daily = [] }) {
  const h = now.getHours(), u = dailyOf(daily, todayString(now))?.user_data;
  return !!(on && profile) && h >= T.checkinFrom && h < (u?.rugby === null ? T.close : T.checkinTo) && !u?.rugby;
}

const str = (v) => (typeof v === "string" && v ? v : null);
const ending = (s) => s.replace(/[—!]/g, "").replace(/\s+/g, " ").trim();
/** A title within 60 characters: the variable head is cut with an ellipsis, the tail (the point) is kept whole. */
const fit = (head, tail = "") => {
  head = ending(head); // data only: the templated tail never holds "!" or an em dash
  const room = T.titleMax - tail.length;
  const h = head.length <= room ? head : head.slice(0, room - 1).trimEnd() + "…";
  return h.slice(0, 1).toUpperCase() + h.slice(1) + tail;
};
const daysTo = (today, date) => (typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) ? daysBetween(today, date.slice(0, 10)) : null);
const nearest = (xs) => xs.sort((a, b) => a.days - b.days || (a.id < b.id ? -1 : 1))[0] ?? null;
const titleOf = (a, fallback) => str(a.data?.title) ?? str(a.title) ?? fallback;
const shortOf = (modules, name) => str(modules.find((m) => (m.module ?? m.title) === name)?.data?.short) ?? name ?? "";
const coursework = (assessments) => own(assessments.filter((a) => !gone(a) && !/exam/i.test(titleOf(a, ""))));

/** N2's milestone for one assessment: the latest from 7 days ago to yesterday, while it is 1–28 days out. */
function missedMilestone(a, today) {
  const d = daysTo(today, a.date);
  if (d == null || d < 1 || d > T.msAhead) return null;
  const ms = (Array.isArray(a.data?.milestones) ? a.data.milestones : [])
    .filter((m) => typeof m?.label === "string" && m.label && daysTo(today, m.date) <= -1 && daysTo(today, m.date) >= -T.msBack)
    .sort((x, y) => (x.date < y.date ? 1 : -1));
  return ms[0] ? { m: ms[0], days: d } : null;
}

/** Every nudge whose trigger holds now, in rule order (N1 … N8), at most one per rule. */
export function candidates({ now, assessments = [], applications = [], cards = [], events = [], modules = [], notes = [], lectures = [], daily = [], train = {} }) {
  const today = todayString(now), h = now.getHours(), out = [];
  const add = (key, title, sub, open, more = {}) => out.push({ key, title, sub, open, ...more });

  // N1: an open application closing in 8–14 days, the nearest.
  const app = nearest(applications.filter((a) => !gone(a) && !closedApplication(a))
    .map((a) => ({ a, id: a.id, days: daysTo(today, a.date) })).filter((x) => x.days != null && x.days >= T.appFrom && x.days <= T.appTo));
  if (app) {
    const org = str(app.a.data?.org) ?? str(app.a.title) ?? "Application", role = str(app.a.data?.role);
    add(`app:${app.id}`, fit(role ? `${org} ${role}` : org, ` closes in ${app.days} days`), `Closes ${shortDay(app.a.date)}. Not submitted.`, `item:${app.id}`);
  }

  // N2: a coursework milestone missed in the last week, the most recent.
  const work = coursework(assessments);
  const missed = work.map((a) => ({ a, x: missedMilestone(a, today) })).filter((y) => y.x)
    .sort((p, q) => (p.x.m.date < q.x.m.date ? 1 : p.x.m.date > q.x.m.date ? -1 : p.x.days - q.x.days))[0];
  if (missed) {
    const { a, x: { m, days } } = missed;
    add(`ms:${a.id}:${m.date}:${m.label}`, fit(`${shortOf(modules, a.module)} ${titleOf(a, "Assessment")}: ${m.label}`.trim(), ` was due ${shortDay(m.date)}`),
        days === 1 ? "Due tomorrow." : `Due in ${days} days.`, `item:${a.id}`);
  }

  // N3: weighted coursework 8–21 days out and not started (N2 wins for the same assessment).
  const start = nearest(work.filter((a) => !a.user_data?.startedAt && !missedMilestone(a, today) && (weightPercent(str(a.data?.weight)) ?? 0) >= T.startWeight)
    .map((a) => ({ a, id: a.id, days: daysTo(today, a.date) })).filter((x) => x.days != null && x.days >= T.startFrom && x.days <= T.startTo));
  if (start) {
    add(`start:${start.id}`, fit(titleOf(start.a, "Assessment"), ` is worth ${weightPercent(start.a.data.weight)}% and due in ${start.days} days`),
        "Not marked as started.", `item:${start.id}`, { started: start.id });
  }

  // N4: 15 or more cards due, and the newest review 2–7 days old (a lapsed streak is not nagged).
  const dueCount = due(cards, today).length, last = Math.max(0, ...cards.map((c) => Number(c.user_data?.reviewedAt) || 0));
  const lastDay = last ? todayString(new Date(last)) : null, gap = lastDay ? daysBetween(lastDay, today) : null;
  if (dueCount >= T.cards && gap != null && gap >= T.reviewFrom && gap <= T.reviewTo) add("cards", `${dueCount} flashcards due`, `Last review ${shortDay(lastDay)}.`, "review");

  // N5: the latest post-lecture notes of a module, unread, from the last 14 days, with that module's class within 48 h.
  const lecOf = (n) => lectures.find((l) => l.data?.post === n.id || l.user_data?.builtPost === n.id);
  const latest = new Map();
  for (const n of notes) {
    if (n.data?.kind !== "post" || !n.module) continue;
    const day = lectureDay(lecOf(n)) ?? n.date ?? null;
    if (day && (!latest.has(n.module) || latest.get(n.module).day < day)) latest.set(n.module, { n, day });
  }
  const soon = events.map((e) => ({ e, start: new Date(e.data?.start) }))
    .filter(({ e, start }) => !gone(e) && e.data?.allDay !== true && start > now && start - now <= T.classHours * 36e5 && isClass(e))
    .sort((a, b) => a.start - b.start);
  const reads = [];
  for (const { n, day } of latest.values()) {
    const ago = daysTo(today, day);
    if (n.user_data?.openedAt || ago == null || ago > 0 || ago < -T.noteDays) continue;
    const cls = soon.find(({ e }) => { const m = moduleOfEvent(e, modules); return !!m && (m.module ?? m.title) === n.module; });
    if (cls) reads.push({ n, cls });
  }
  const read = reads.sort((a, b) => a.cls.start - b.cls.start)[0];
  if (read) {
    const s = shortOf(modules, read.n.module), kind = (titleOf(read.cls.e, "").match(/lecture|seminar|workshop/i)?.[0] ?? "class").toLowerCase();
    const day = todayString(read.cls.start), word = day === today ? "today" : day === addDays(today, 1) ? "tomorrow" : WEEKDAYS[read.cls.start.getDay()];
    add(`read:${read.n.id}`, fit(`${s} ${str(read.n.data?.lecture) ?? ""}`.trim(), " notes are unread"), `${s} ${kind} is ${word} at ${clock(read.cls.start)}.`, `note:${read.n.id}`);
  }

  // N6–N8 need Train on with a profile.
  const { on, profile, sessions = [], meals = [], food = null } = train;
  if (!on || !profile) return out;
  const rugby = rugbyOn(daily, today), logged = sessionsOf(sessions);

  // N6: two or more missed sessions this week (a slot on a match day does not count, K10).
  const w = week(today, logged), miss = w.slots.filter((s) => s.state === "missed" && rugbyOn(daily, s.day) !== "match");
  const n6 = miss.length >= 2 && !planOver(today);
  if (n6) {
    const next = w.slots.find((s) => s.state === "today" || s.state === "later");
    add("missed", `${miss.length} sessions missed this week`,
        next ? `Missed sessions are not stacked. Next: ${WEEKDAYS[new Date(next.day + "T12:00").getDay()]}, ${PLAN.sessions[next.key].name}.` : "Nothing left in the plan this week.", "train");
  }

  // N7: today's plan session not started by 16:00, unless rugby is on (training or match) or N6 already speaks.
  const key = sessionForDay(today);
  if (!n6 && key && !planOver(today) && h >= T.trainFrom && h < T.close && !logged.some((s) => s.date === today) && !["training", "match"].includes(rugby)) {
    const p = prescribe(key, today, { sessions: logged, profile });
    add("train-today", fit(p.name, " is planned today"), `Not started. ${p.items.length} exercises.`, "train");
  }

  // N8: from 17:00, no food logged or protein under half the target.
  const kg = Number(profile.weight);
  if (kg > 0 && h >= T.foodFrom && h < T.close) {
    // food: food.js's today() (the app); meals: raw meal rows (the tests and the drop tool's vectors).
    const target = food?.target || PROTEIN_TARGET(kg), p = food ? Math.round(food.protein) : dayFood(meals, today).protein;
    if (food ? !food.meals : !meals.some((m) => m.date === today)) add("food", "No food logged today", `Protein target is ${target} g.`, "food");
    else if (p < T.proteinShare * target) add("food", `Protein is at ${p} of ${target} g`, `${target - p} g left for today.`, "food");
  }
  return out;
}

/** G1–G5: what Suggestions shows now. {rows, shown}: `shown` is today's new list when it grew (the caller writes it),
 *  else null. Outside 08:00–21:59 or switched off: nothing, and nothing recorded. `pings` lets a P1 push line ("suggest")
 *  claim its slot first, so the push, the Inbox and the card agree. */
export function suggestions(input) {
  const { now, daily = [], prefsOn = true, pings = [] } = input;
  const h = now.getHours();
  if (!prefsOn || h < T.open || h >= T.close) return { rows: [], shown: null };
  const today = todayString(now), u = dailyOf(daily, today)?.user_data ?? {};
  const was = Array.isArray(u.shown) ? u.shown : [], acted = new Set(u.acted ?? []);
  const yesterday = new Set(dailyOf(daily, addDays(today, -1))?.user_data?.shown ?? []);
  const muted = (key) => daily.some((r) => r.date >= addDays(today, -7) && r.date <= today && (r.user_data?.muted?.[key] ?? "") > today);
  const live = new Map(candidates(input).map((c) => [c.key, c]));
  const pushed = pings.filter((p) => p.data?.kind === "suggest" && String(p.date ?? "").slice(0, 10) === today).map((p) => p.data?.nudge);
  // A pushed key was surfaced by the push itself, so it takes a slot first whether or not it is live here; G4 still holds.
  const fresh = [...new Set([...pushed.filter((k) => typeof k === "string" && k && !was.includes(k)),
    ...[...live.keys()].filter((k) => !was.includes(k) && !muted(k) && !acted.has(k) && !yesterday.has(k))])].slice(0, Math.max(0, T.cap - was.length));
  const shown = [...was, ...fresh];
  return { rows: shown.filter((k) => live.has(k) && !acted.has(k) && !muted(k) && !yesterday.has(k)).map((k) => live.get(k)), shown: fresh.length ? shown : null };
}

/** The mute a More menu choice writes (G5): today + 3 days for Snooze, + 7 for Dismiss. */
export const muteUntil = (today, kind) => addDays(today, kind === "snooze" ? T.snooze : T.dismiss);
