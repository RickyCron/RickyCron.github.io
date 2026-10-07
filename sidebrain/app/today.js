// Today's pure logic, ported from Sources/(C) TodayModel.swift (dueSoon, dueLabel, remindAt, clock) and Sources/(C) TodayBrief.swift
// (withoutGreeting, weightPercent). Items are Supabase `items` rows: {id, kind, source, module, date, title, data, user_data}.
// Checked by node --test web/today.test.mjs, with cases taken from the Swift tests.
import { daysBetween } from "./sm2.js";

const text = (data, key) => (typeof data?.[key] === "string" && data[key] ? data[key] : null); // StoreItem.string: empty is nil
const isDay = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d);
const daysTo = (today, date) => (isDay(date) ? daysBetween(today, date.slice(0, 10)) : null);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const GREETING = /^(?:hello|hi|hey|dear|greetings|good (?:morning|afternoon|evening))\b(?:\s*,?\s*[\p{L}'’]+){0,3}\s*[—–,.!:;-]+\s*/iu;

/** "Hello, student—your essay…" → "Your essay…". Only a greeting word plus up to three words and punctuation is cut. */
export function withoutGreeting(line) {
  let s = String(line ?? "").trim();
  const m = s.match(GREETING);
  if (m && m[0].length < s.length) s = s.slice(m[0].length);
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

/** "40%" / "40" / "40 percent" → 40. */
export const weightPercent = (t) => { const m = typeof t === "string" && t.match(/(\d{1,3})/); return m ? Number(m[1]) : null; };

/** Moodle's copy of an assessment another source already tracks (same module and day) is left out. */
function own(assessments) {
  const key = (a) => `${a.module ?? ""}|${a.date ?? ""}`;
  const tracked = new Set(assessments.filter((a) => a.source !== "moodle").map(key));
  return assessments.filter((a) => a.source !== "moodle" || !tracked.has(key(a)));
}

// ---------- Relevance (R1–R7, shared with the Mac: Tests/(C) Fixtures/(C) today-vectors.json) ----------

/** R1: a task's effective day is user_data.doDate (a reschedule) when set, else the row's date. */
export const effectiveDate = (t) => (typeof t.user_data?.doDate === "string" && t.user_data.doDate ? t.user_data.doDate : t.date ?? null);
/** R2: ticked or let go. */
export const gone = (x) => x?.user_data?.done === true || x?.user_data?.dismissed === true;
const CLOSED_STATUS = ["submitted", "rejected", "withdrawn", "closed"], CLOSED_STAGE = ["submitted", "rejected", "withdrawn", "offer"];
/** R3 (TodayModel.closedStage): data.status is exactly one of the closed words, or data.stage starts with one (any case). */
export const closedApplication = (a) => CLOSED_STATUS.includes(text(a.data, "status")) || CLOSED_STAGE.some((w) => (text(a.data, "stage") ?? "").toLowerCase().startsWith(w));
/** The phone's own calendar day of a timestamp (ISO string or epoch ms). */
const localDay = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Open tasks due within `horizon` days (slipped ones included, undated last), plus assessment dues, their milestones and
 *  application deadlines from today to the horizon. Rows: {id, kind, title, detail, date, days, time, slipped}.
 *  R2 done/let go, R3 closed applications, R4 expired, R5 slipped more than 14 days, R6 undated and older than 14 days. */
export function dueSoon(tasks, assessments, applications, today, horizon = 7) {
  const upcoming = (date) => { const d = daysTo(today, date); return d != null && d >= 0 && d <= horizon; };
  const rows = [];
  for (const t of tasks) {
    if (gone(t)) continue;
    if (text(t.data, "expires") && t.data.expires < today) continue;
    const date = effectiveDate(t), d = daysTo(today, date);
    if (d != null && (d > horizon || d < -14)) continue;
    if (d == null && t.created_at != null) { const made = localDay(t.created_at); if (made && daysBetween(made, today) > 14) continue; }
    const at = remindAt(t);
    rows.push({ id: t.id, kind: "task", title: text(t.data, "title") ?? t.title ?? "Task", detail: text(t.data, "origin") ?? "", date, days: d,
                time: at ? clock(at) : null, slipped: d != null && d < 0 });
  }
  for (const a of own(assessments.filter((x) => !gone(x)))) {
    const title = text(a.data, "title") ?? a.title ?? "Assessment", module = a.module ?? "";
    if (upcoming(a.date)) {
      rows.push({ id: a.id, kind: "assessment", title: title + " due", detail: [module, text(a.data, "weight")].filter(Boolean).join(" · "), date: a.date, days: daysTo(today, a.date), slipped: false, module });
    }
    for (const m of Array.isArray(a.data?.milestones) ? a.data.milestones : []) {
      if (typeof m?.date !== "string" || !upcoming(m.date) || typeof m.label !== "string") continue;
      rows.push({ id: `${a.id}#${m.date}${m.label}`, kind: "milestone", title: m.label, detail: [module, title].filter(Boolean).join(" · "), date: m.date, days: daysTo(today, m.date), slipped: false, module });
    }
  }
  for (const app of applications) {
    if (gone(app) || closedApplication(app) || !upcoming(app.date)) continue;
    rows.push({ id: app.id, kind: "application", title: (text(app.data, "org") ?? app.title ?? "Application") + " deadline", detail: text(app.data, "role") ?? "", date: app.date, days: daysTo(today, app.date), slipped: false });
  }
  return rows.sort((x, y) => cmp(x.date ?? "9999", y.date ?? "9999") || cmp(x.time ?? "", y.time ?? "") || cmp(x.title, y.title)); // all-day first, then by time
}

// ISO8601DateFormatter's default: whole seconds and a zone (Z or ±hh:mm). Anything else is all-day, as on the Mac.
const INTERNET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
/** A task's time (data.remindAt, e.g. VoiceType's "…at 6pm"); null = all-day. */
export function remindAt(task) {
  const s = text(task.data, "remindAt");
  const d = s && INTERNET_TIME.test(s) ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
/** "18:00" in this phone's time zone. */
export const clock = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const urgent = (row) => (row.days ?? 99) <= 3;

/** "Overdue · Wed 30 Sep", "Today", "Tomorrow", "Mon 5 Oct"; " · 18:00" after it when the task has a time; "" for an undated task. */
export function dueLabel(row) {
  if (row.days == null || !isDay(row.date)) return "";
  const short = shortDay(row.date);
  const label = row.days < 0 ? "Overdue · " + short : row.days === 0 ? "Today" : row.days === 1 ? "Tomorrow" : short;
  return row.time ? `${label} · ${row.time}` : label;
}

/** "Overdue since Mon 5 Oct", "Due today", "Due tomorrow", "Due Mon 5 Oct" (TodayModel.priorityDueLabel). */
export function priorityDueLabel(row) {
  if (row.days == null || !isDay(row.date)) return "";
  return row.days < 0 ? "Overdue since " + shortDay(row.date) : row.days === 0 ? "Due today" : row.days === 1 ? "Due tomorrow" : "Due " + shortDay(row.date);
}
// Fixed three-letter names: browsers disagree on September ("Sep" / "Sept").
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const noon = (date) => new Date(String(date).slice(0, 10) + "T12:00");
/** "Mon 5 Oct". */
export const shortDay = (date) => { const d = noon(date); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

/** Weighted assessments further out than the due-soon horizon, nearest first: {id, title, detail, days, left}. */
export function runway(assessments, today, horizon = 7, limit = 4) {
  return own(assessments)
    .map((a) => ({ a, days: daysTo(today, a.date), weight: weightPercent(text(a.data, "weight")) }))
    .filter((x) => x.days != null && x.days > horizon && x.weight != null)
    .sort((x, y) => x.days - y.days || cmp(x.a.id, y.a.id))
    .slice(0, limit)
    .map(({ a, days, weight }) => ({ id: a.id, title: text(a.data, "title") ?? a.title ?? "Assessment", detail: [a.module, `${weight}%`].filter(Boolean).join(" · "),
                                     days, left: days < 14 ? `${days} days` : `${Math.floor(days / 7)} weeks` }));
}

// ---------- Natural-language dates for a new to-do ("essay plan fri" → "Essay plan", Friday) ----------

const WD = "mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
const MON = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const ORD = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(?:\\s+(\\d{4}))?";
const weekday = (w) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(w.slice(0, 3).toLowerCase());
const month = (m) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m.slice(0, 3).toLowerCase()) + 1;
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const real = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const plusDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dow = (day) => new Date(day + "T00:00:00Z").getUTCDay();
/** An explicit day and month. With a year, that year. Without one: this year if it is today, ahead, or up to 14 days gone
 *  (kept and shown as a past date), else next year ("revise 12 jan" in October is January). */
const explicit = (today, m, d, y) => {
  if (y) return real(Number(y), m, d) ? ymd(Number(y), m, d) : null;
  const year = Number(today.slice(0, 4)), day = real(year, m, d) ? ymd(year, m, d) : null;
  if (day && daysBetween(day, today) <= 14) return day;
  return real(year + 1, m, d) ? ymd(year + 1, m, d) : day;
};
/** The next day-of-month d on or after today (this month, else the next month that has one). */
const nextDayOfMonth = (today, d) => {
  let [y, m] = today.split("-").map(Number);
  for (let i = 0; i < 13; i++, m = m === 12 ? 1 : m + 1, y += m === 1 ? 1 : 0) if (real(y, m, d) && ymd(y, m, d) >= today) return ymd(y, m, d);
  return null;
};
const nextWeekday = (today, w) => plusDays(today, (w - dow(today) + 7) % 7); // the same weekday is today
const nextMonday = (today) => plusDays(today, ((8 - dow(today)) % 7) || 7);
/** "next fri": that weekday in the coming Monday-to-Sunday week. */
const weekdayNextWeek = (today, w) => plusDays(nextMonday(today), (w + 6) % 7);

// A phrase is whole words: not inside a word, a number, "mon-fri", "9/10/x" or "tomorrow’s", and not before ":" ("today: …").
const B = "(?<![\\p{L}\\d/’'\\-])", E = "(?![\\p{L}\\d/’':\\-])", PRE = "(?:(?:on|by|due|this)\\s+)?";
const PATTERNS = [
  [`${PRE}(${WD})\\s+${ORD}(?:\\s+(${MON})${YEAR})?`, (t, m) => m[3] ? explicit(t, month(m[3]), +m[2], m[4]) : nextDayOfMonth(t, +m[2])], // the weekday is checked below
  [`${PRE}${ORD}\\s+(${MON})${YEAR}`, (t, m) => explicit(t, month(m[2]), +m[1], m[3])],
  [`${PRE}(${MON})\\s+${ORD}${YEAR}`, (t, m) => explicit(t, month(m[1]), +m[2], m[3])],
  [`${PRE}(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}))?`, (t, m) => explicit(t, +m[2], +m[1], m[3])], // day/month, as in the UK
  [`${PRE}next\\s+week`, (t) => nextMonday(t)],
  [`${PRE}next\\s+(${WD})`, (t, m) => weekdayNextWeek(t, weekday(m[1]))],
  [`${PRE}(?:today|tonight)`, (t) => t],
  [`${PRE}(?:tomorrow|tmrw)`, (t) => plusDays(t, 1)],
  // A bare weekday counts after on/by/due/this, as the first or last word, or before a time ("gym mon evening",
  // "call mum fri at 6", "dentist fri 3pm"). Anywhere else ("buy sun cream") it is a word. Tapping the highlight undoes a wrong one.
  [`(?:on|by|due|this)\\s+(${WD})`, (t, m) => nextWeekday(t, weekday(m[1]))],
  [`(${WD})(?=[\\s.,;!?—–-]*$)`, (t, m) => nextWeekday(t, weekday(m[1]))],
  [`(?<=^\\s*)(${WD})`, (t, m) => nextWeekday(t, weekday(m[1]))],
  [`(${WD})(?=,?\\s+(?:morning|afternoon|evening|tonight|night|at|by|\\d))`, (t, m) => nextWeekday(t, weekday(m[1]))],
].map(([re, day]) => [new RegExp(`${B}(?:${re})${E}`, "giu"), day]);

/** The date phrase in a to-do, as typed: {title, date, past, start, end, keys}. `start`/`end` mark the phrase (with a leading
 *  "on", "by", "due" or "this") for highlighting; `keys` names every phrase found, so tapping the highlight can ignore them
 *  all (`ignore`). The last phrase wins ("Book sat exam room tomorrow" → tomorrow); on a tie, the longer one ("fri 9 oct").
 *  An explicit past day ("1/9") stays this year and comes back with past: true; a weekday that doesn't fit the day
 *  number ("fri 31") is ignored in favour of the number. */
export function parseWhen(input, today, ignore = new Set()) {
  const s = String(input ?? "");
  let best = null;
  const keys = [];
  for (const [re, day] of PATTERNS) {
    for (const m of s.matchAll(re)) {
      const date = day(today, m), key = m[0].toLowerCase().replace(/\s+/g, " ");
      if (!date || ignore.has(key)) continue;
      keys.push(key);
      const end = m.index + m[0].length;
      if (!best || end > best.end || (end === best.end && m.index < best.start)) best = { date, start: m.index, end };
    }
  }
  const raw = s.trim();
  if (!best) return { title: capitalise(raw), date: null, past: false, start: -1, end: -1, keys };
  // The phrase goes, and with it any punctuation or dash left hanging at the join or the end ("plan — fri", "essay plan fri!").
  const title = (s.slice(0, best.start).replace(/[\s,;:–—-]+$/, "") + " " + s.slice(best.end).replace(/^[\s,.;:!?–—-]+/, ""))
    .replace(/\s+/g, " ").replace(/^[\s,.;:!?–—-]+|[\s,.;:!?–—-]+$/g, "");
  return { title: capitalise(title || raw), date: best.date, past: best.date < today, start: best.start, end: best.end, keys };
}
const capitalise = (t) => t.slice(0, 1).toUpperCase() + t.slice(1);

// ---------- Schedule (`event` rows: today's, plus earlier ones still running) ----------

const instant = (s) => { const d = typeof s === "string" && s.includes("T") ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };

/** Today's calendar, anchored on the time: {allDay: [titles], past, now, next: [{id, title, time, location}], more}.
 *  All-day events, and anything that began before today and is still running, go on the all-day line. Timed events
 *  whose end has passed are `past`; started and not ended are `now`; then the next `limit` to come (all of them with `all`). */
export function daySchedule(events, now = new Date(), limit = 3, all = false) {
  const day = localDay(now), dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const title = (e) => text(e.data, "title") ?? e.title ?? "Event";
  const allDay = [], timed = [];
  for (const e of events) {
    const date = String(e.date ?? "").slice(0, 10), start = instant(e.data?.start), end = instant(e.data?.end);
    if (gone(e) || !(date === day || (date && date < day))) continue;
    // Begun before today (a trip, an overnight flight): on the all-day line while it is still running.
    if (start && start < dayStart) { if (end && end > now) allDay.push(title(e)); continue; }
    if (e.data?.allDay === true || !start) { allDay.push(title(e)); continue; }
    timed.push({ id: e.id, title: title(e), start, time: clock(start), location: text(e.data, "location") ?? "",
                 state: (end ?? start) <= now ? "past" : start <= now ? "now" : "next" });
  }
  timed.sort((a, b) => a.start - b.start || cmp(a.title, b.title));
  const next = timed.filter((e) => e.state === "next");
  return { allDay, past: timed.filter((e) => e.state === "past"), now: timed.filter((e) => e.state === "now"),
           next: all ? next : next.slice(0, limit), more: next.length > limit };
}

/** "just now", "2 min ago", "at 09:14", "on Tue 6 Oct". */
export function ago(then, now = Date.now()) {
  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return localDay(then) === localDay(now) ? "at " + clock(new Date(then)) : "on " + shortDay(localDay(then));
}
