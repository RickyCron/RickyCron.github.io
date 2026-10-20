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
export function own(assessments) {
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
const nextWeekday = (today, w) => plusDays(today, (w - dow(today) + 7) % 7); // the same weekday is today ("by wed" on a Wednesday)
/** "fri" or "on fri" means the coming one: typed on a Friday, that is next Friday, unless `keep` (a time still ahead today). */
const comingWeekday = (today, w, keep = false) => plusDays(today, ((w - dow(today) + 7) % 7) || (keep ? 0 : 7));
/** Whether the time after the weekday ("3pm", "at 6", "evening") is still ahead of `now`, on `today`. A bare hour under 8 is pm. */
function ahead(m, today, now) {
  if (!now || ymd(now.getFullYear(), now.getMonth() + 1, now.getDate()) !== today) return false;
  const part = m[2]?.toLowerCase(), mins = now.getHours() * 60 + now.getMinutes();
  if (part) return mins < { morning: 12, afternoon: 17, evening: 24, tonight: 24, night: 24 }[part] * 60;
  if (!m[3]) return false;
  const n = Number(m[3]), ap = m[5]?.toLowerCase(), h = ap === "pm" ? (n % 12) + 12 : ap === "am" ? n % 12 : n < 8 ? n + 12 : n;
  return mins < h * 60 + Number(m[4] ?? 0);
}
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
  // Typed on that weekday (Ricky, 17 Oct): "fri" and "on fri" mean next week unless the time after it is still ahead today;
  // "this fri", "by fri" and "due fri" mean today. Before a time comes first, so it wins the tie with "on fri".
  [`(?:on\\s+)?(${WD})(?=,?\\s+(?:(morning|afternoon|evening|tonight|night)|(?:at\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?|by)(?![\\p{L}\\d]))`,
    (t, m, now) => comingWeekday(t, weekday(m[1]), ahead(m, t, now))],
  [`(?:by|due|this)\\s+(${WD})`, (t, m) => nextWeekday(t, weekday(m[1]))],
  [`on\\s+(${WD})`, (t, m) => comingWeekday(t, weekday(m[1]))],
  [`(${WD})(?=[\\s.,;!?—–-]*$)`, (t, m) => comingWeekday(t, weekday(m[1]))],
  [`(?<=^\\s*)(${WD})`, (t, m) => comingWeekday(t, weekday(m[1]))],
].map(([re, day]) => [new RegExp(`${B}(?:${re})${E}`, "giu"), day]);

/** The date phrase in a to-do, as typed: {title, date, past, start, end, keys}. `start`/`end` mark the phrase (with a leading
 *  "on", "by", "due" or "this") for highlighting; `keys` names every phrase found, so tapping the highlight can ignore them
 *  all (`ignore`). The last phrase wins ("Book sat exam room tomorrow" → tomorrow); on a tie, the longer one ("fri 9 oct").
 *  An explicit past day ("1/9") stays this year and comes back with past: true; a weekday that doesn't fit the day
 *  number ("fri 31") is ignored in favour of the number. */
export function parseWhen(input, today, ignore = new Set(), now = null) {
  const s = String(input ?? "");
  let best = null;
  const keys = [];
  for (const [re, day] of PATTERNS) {
    for (const m of s.matchAll(re)) {
      const date = day(today, m, now), key = m[0].toLowerCase().replace(/\s+/g, " ");
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
    timed.push({ id: e.id, title: title(e), start, end, time: clock(start), location: text(e.data, "location") ?? "",
                 state: (end ?? start) <= now ? "past" : start <= now ? "now" : "next" });
  }
  timed.sort((a, b) => a.start - b.start || cmp(a.title, b.title));
  const next = timed.filter((e) => e.state === "next");
  return { allDay, past: timed.filter((e) => e.state === "past"), now: timed.filter((e) => e.state === "now"),
           next: all ? next : next.slice(0, limit), more: next.length > limit };
}

// ---------- The hero: what now? (the Focus direction's departure board) ----------

/** The event the hero shows: the one on now, else the next one today, else the first timed one after today (as far as the
 *  fetched events reach). {id, title, start, end, location, state: "now" | "next" | "later"}, or null. */
export function heroEvent(events, now = new Date()) {
  const s = daySchedule(events, now, 1), e = s.now[0] ?? s.next[0];
  if (e) return { id: e.id, title: e.title, start: e.start, end: e.end, location: e.location, state: e.state };
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const later = events.map((x) => ({ x, start: instant(x.data?.start) }))
    .filter(({ x, start }) => start && start >= tomorrow && !gone(x) && x.data?.allDay !== true)
    .sort((a, b) => a.start - b.start || cmp(a.x.id, b.x.id))[0];
  return later ? { id: later.x.id, title: text(later.x.data, "title") ?? later.x.title ?? "Event", start: later.start, end: instant(later.x.data?.end),
                   location: text(later.x.data, "location") ?? "", state: "later" } : null;
}

/** The hero's captions and big figure: "Up next" / "Starts in" "25 min", "On now" / "Ends in" "40 min", "Tomorrow" /
 *  "Starts at" "11:00". Past three hours a countdown turns into the clock time. Range is "14:40–15:40" (not while on). */
export function heroFigure(e, now = new Date()) {
  const mins = (d) => Math.max(0, Math.round((d - now) / 6e4));
  const span = (d, word) => (mins(d) < 180 ? [`${word} in`, mins(d) === 0 ? "now" : prep(mins(d))] : [`${word} at`, clock(d)]);
  const range = e.end ? `${clock(e.start)}–${clock(e.end)}` : clock(e.start);
  if (e.state === "now") { const [k, fig] = e.end ? span(e.end, "Ends") : ["Started at", clock(e.start)]; return { label: "On now", k, fig, range: "" }; }
  if (e.state === "next") { const [k, fig] = span(e.start, "Starts"); return { label: "Up next", k, fig, range }; }
  const day = localDay(e.start), next = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  return { label: day === next ? "Tomorrow" : shortDay(day), k: "Starts at", fig: clock(e.start), range };
}

// ---------- Pings, Up next and the Inbox (docs/(C) Brief + ping contract.md §1, §6) ----------

/** A ping's fire time: user_data.snoozedUntil, else data.at; null when neither is a time. */
export const fireAt = (p) => instant(p.user_data?.snoozedUntil) ?? instant(p.data?.at);
/** Still to fire: not done, firing after `now`, and not after it expires: data.expires, else 12 h after the fire time.
 *  The contract's default is data.at + 12 h; counted from the fire time instead, so "Snooze until tomorrow" still fires
 *  (docs/(C) Lane phone notes.md). */
function willFire(p, now) {
  const f = fireAt(p);
  return !!f && p.user_data?.done !== true && f > now && f <= (instant(p.data?.expires) ?? new Date(f.getTime() + 12 * 36e5));
}
/** The end of this week: Sunday 23:59:59.999 on this phone's clock. On a Sunday it is next Sunday, so Sunday evening
 *  shows the week ahead (as the Mac does). */
export function weekEnd(now) {
  const d = new Date(now);
  d.setDate(d.getDate() + (7 - d.getDay()));
  d.setHours(23, 59, 59, 999);
  return d;
}
/** A brief's prep time: "45 min", "2 h", "1 h 30 min". */
export const prep = (minutes) => { const m = Math.round(Number(minutes) || 0); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
/** "Brief · 2 h prep", or "Brief" when the brief has no minutes. */
export const briefLabel = (note) => (Number(note.data?.minutes) > 0 ? `Brief · ${prep(note.data.minutes)} prep` : "Brief");
const isBrief = (n) => n?.data?.kind === "pre" && !!instant(n.data?.classAt);

/** Today's "Up next", from now to the end of Sunday, by day (all-day rows first) and then time: classes (timed `event`
 *  rows starting after now, plus briefs whose class has no event row), pings still to fire, timed tasks, and
 *  assessments due. A class with a brief carries "Brief · 2 h prep" and opens it.
 *  Rows: {id, kind: "class" | "ping" | "task" | "assessment", day, at (ms, null = all day), time, title, sub, open, event?}. */
export function upNext({ events = [], pings = [], tasks = [], assessments = [], notes = [] }, now = new Date()) {
  const end = weekEnd(now), today = localDay(now), last = localDay(end), rows = [];
  const ahead = (d) => !!d && d > now && d <= end;
  const add = (id, kind, at, title, sub, open, more = {}) =>
    rows.push({ id, kind, day: at ? localDay(at) : null, at: at ? at.getTime() : null, time: at ? clock(at) : null, title, sub, open, ...more });
  const briefs = new Map(notes.filter(isBrief).map((n) => [instant(n.data.classAt).getTime(), n])), used = new Set();
  for (const e of events) {
    const start = instant(e.data?.start);
    if (gone(e) || e.data?.allDay === true || !ahead(start)) continue;
    const b = briefs.get(start.getTime());
    if (b) used.add(b.id);
    add(e.id, "class", start, text(e.data, "title") ?? e.title ?? "Event", [b && briefLabel(b), text(e.data, "location")].filter(Boolean).join(" · "), b ? `note:${b.id}` : null, { event: true });
  }
  for (const [at, b] of briefs) {
    if (!used.has(b.id) && ahead(new Date(at))) add(b.id, "class", new Date(at), b.title ?? "Class", [briefLabel(b), text(b.data, "where")].filter(Boolean).join(" · "), `note:${b.id}`);
  }
  // Class nudges and event pings are left out: their class or event is already a row (as on the Mac).
  for (const p of pings) if (willFire(p, now) && fireAt(p) <= end && !["nudge", "event"].includes(p.data?.kind)) add(p.id, "ping", fireAt(p), p.title ?? "Reminder", "Notification", text(p.data, "open")?.replace(/^reask:/, "note:"));
  for (const t of tasks) {
    const at = remindAt(t);
    if (!gone(t) && ahead(at)) add(t.id, "task", at, text(t.data, "title") ?? t.title ?? "Task", text(t.data, "origin") ?? "", `item:${t.id}`);
  }
  for (const a of own(assessments.filter((x) => !gone(x)))) {
    const day = isDay(a.date) ? a.date.slice(0, 10) : null;
    if (day && day >= today && day <= last) {
      add(a.id, "assessment", null, (text(a.data, "title") ?? a.title ?? "Assessment") + " due", [a.module, text(a.data, "weight")].filter(Boolean).join(" · "), `item:${a.id}`, { day });
    }
  }
  return rows.sort((x, y) => cmp(x.day, y.day) || (x.at ?? -Infinity) - (y.at ?? -Infinity) || cmp(x.title, y.title));
}

/** The Inbox: every ping whose fire time has come, newest first, until it expires (contract §6, as Pings.inbox on the
 *  Mac): one with its own data.expires (a nudge, event or room ping) leaves then, any other 2 days after it fired.
 *  Unread = no seenAt and not done; the count (the badge) is the unread ones that fired today. */
export function inbox(pings, now = new Date()) {
  const rows = pings.map((p) => ({ p, at: fireAt(p) })).filter((x) => x.at && x.at <= now && now < (instant(x.p.data?.expires) ?? new Date(x.at.getTime() + 2 * 864e5)))
    .sort((a, b) => b.at - a.at || cmp(a.p.id, b.p.id)).map((x) => x.p);
  return { rows, unread: rows.filter((p) => !p.user_data?.seenAt && p.user_data?.done !== true && localDay(fireAt(p)) === localDay(now)).length };
}

/** Snooze choices still ahead of `now`, [label, Date]: 1 hour, 20:00 tonight and 08:00 tomorrow. */
export function snoozeChoices(now = new Date()) {
  const at = (days, hour) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
  return [["Snooze 1 hour", new Date(now.getTime() + 36e5)], ["Snooze until tonight", at(0, 20)], ["Snooze until tomorrow", at(1, 8)]].filter(([, d]) => d > now);
}

/** `listen:next`: the brief for the next class still to start, or null. */
export const nextBrief = (notes, now = new Date()) =>
  notes.filter((n) => isBrief(n) && instant(n.data.classAt) > now).sort((a, b) => instant(a.data.classAt) - instant(b.data.classAt))[0] ?? null;

/** "just now", "2 min ago", "at 09:14", "on Tue 6 Oct". */
export function ago(then, now = Date.now()) {
  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return localDay(then) === localDay(now) ? "at " + clock(new Date(then)) : "on " + shortDay(localDay(then));
}

// ---------- The class on now (the Capture tab files a note under it; NexiJev.classNow on the Mac) ----------

const plainName = (s) => String(s ?? "").toLowerCase().replaceAll("&", " and ").split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");

/** A lecture, seminar or workshop event, or one with a module code. */
export const isClass = (e) => /lecture|seminar|workshop/i.test(text(e.data, "title") ?? e.title ?? "") || !!text(e.data, "code");
/** The module row an event's title names, by full name, code or short name; null when none does. */
export function moduleOfEvent(e, modules) {
  const title = text(e.data, "title") ?? e.title ?? "", code = text(e.data, "code")?.toUpperCase();
  const words = title.toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return modules.find((m) => {
    const name = m.module ?? m.title ?? "";
    return (code && text(m.data, "code")?.toUpperCase() === code) || (name && plainName(title).includes(plainName(name)))
      || [text(m.data, "code"), text(m.data, "short")].some((x) => x && words.includes(x.toUpperCase()));
  }) ?? null;
}

/** The class on now, as {module, lecture, label} ("BES L3"), or null: a lecture, seminar or workshop event (or one with a
 *  module code) from 15 minutes before it starts to its end, whose title names a module by full name, code or short name
 *  (TodayModel.lecture). The lecture is the module's one that day, else the one whose L/S number is in the title; the class
 *  already running wins over the next one. */
export function classNow(events, modules, lectures, now = new Date()) {
  const wait = (start) => (start <= now ? now - start : 1e12 + (start - now));
  const on = events.map((e) => ({ e, title: text(e.data, "title") ?? e.title ?? "", start: instant(e.data?.start), end: instant(e.data?.end) }))
    .filter(({ e, start, end }) => start && !gone(e) && isClass(e) && start - 15 * 6e4 <= now && now <= (end ?? new Date(start.getTime() + 36e5)))
    .sort((a, b) => wait(a.start) - wait(b.start));
  for (const { e, title, start } of on) {
    const words = title.toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean), mod = moduleOfEvent(e, modules);
    if (!mod) continue;
    const module = mod.module ?? mod.title, day = localDay(start), own = lectures.filter((l) => l.module === module);
    const said = title.match(/(lecture|session|seminar)\s*(\d+)/i);
    const number = words.find((w) => /^[LS]\d+$/.test(w)) ?? (said ? (/^(session|seminar)$/i.test(said[1]) ? "S" : "L") + said[2] : null);
    const lec = own.find((l) => String(l.date ?? "").slice(0, 10) === day && l.data?.dated !== "posted") ?? own.find((l) => number && text(l.data, "n")?.toUpperCase() === number);
    const n = text(lec?.data, "n");
    return { module, lecture: n, label: [text(mod.data, "short") ?? module, n].filter(Boolean).join(" ") };
  }
  return null;
}
