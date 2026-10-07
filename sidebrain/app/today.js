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

/** Open tasks due within `horizon` days (overdue included, undated last), plus assessment dues, their milestones and
 *  application deadlines from today to the horizon. Rows: {id, kind, title, detail, date, days}. */
export function dueSoon(tasks, assessments, applications, today, horizon = 7) {
  const upcoming = (date) => { const d = daysTo(today, date); return d != null && d >= 0 && d <= horizon; };
  const rows = [];
  for (const t of tasks) {
    if (t.user_data?.done === true) continue;
    const d = daysTo(today, t.date);
    if (d != null && d > horizon) continue;
    const at = remindAt(t);
    rows.push({ id: t.id, kind: "task", title: text(t.data, "title") ?? t.title ?? "Task", detail: text(t.data, "origin") ?? "", date: t.date ?? null, days: d,
                time: at ? clock(at) : null });
  }
  for (const a of own(assessments)) {
    const title = text(a.data, "title") ?? a.title ?? "Assessment", module = a.module ?? "";
    if (upcoming(a.date)) {
      rows.push({ id: a.id, kind: "assessment", title: title + " due", detail: [module, text(a.data, "weight")].filter(Boolean).join(" · "), date: a.date, days: daysTo(today, a.date) });
    }
    for (const m of Array.isArray(a.data?.milestones) ? a.data.milestones : []) {
      if (typeof m?.date !== "string" || !upcoming(m.date) || typeof m.label !== "string") continue;
      rows.push({ id: `${a.id}#${m.date}${m.label}`, kind: "milestone", title: m.label, detail: [module, title].filter(Boolean).join(" · "), date: m.date, days: daysTo(today, m.date) });
    }
  }
  for (const app of applications) {
    if (!upcoming(app.date)) continue;
    rows.push({ id: app.id, kind: "application", title: (text(app.data, "org") ?? app.title ?? "Application") + " deadline", detail: text(app.data, "role") ?? "", date: app.date, days: daysTo(today, app.date) });
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
  const short = new Date(row.date.slice(0, 10) + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const label = row.days < 0 ? "Overdue · " + short : row.days === 0 ? "Today" : row.days === 1 ? "Tomorrow" : short;
  return row.time ? `${label} · ${row.time}` : label;
}

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
