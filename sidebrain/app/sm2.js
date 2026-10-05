// Study's review logic, ported exactly from Sources/(C) StudyModel.swift. Both sides check the shared
// vectors in Tests/(C) Fixtures/(C) sm2-vectors.json (Swift: "(C) Test Store.sh"; here: node --test web/sm2.test.mjs).
// Days are "YYYY-MM-DD" strings in the phone's own calendar, as on the Mac.

const num = (v) => (typeof v === "number" ? v : 0); // Swift: (user[key] as? NSNumber)?.doubleValue ?? 0
const str = (v) => (typeof v === "string" ? v : ""); // Swift: user(key) ?? ""

export const pad = (n) => String(n).padStart(2, "0");
export const todayString = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const utc = (day) => { const [y, m, d] = day.split("-").map(Number); return Date.UTC(y, m - 1, d); };
export const addDays = (day, n) => new Date(utc(day) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / 86400000);

/** SM-2 style schedule. grade: 0 Again, 1 Hard, 2 Good, 3 Easy. Inside 28 days of the module's exam, intervals shrink to 60%. */
export function schedule(user, grade, examDays = 999, today = todayString(), now = Date.now()) {
  let ease = num(user.ease) === 0 ? 2.5 : num(user.ease), iv = num(user.interval), lapses = num(user.lapses);
  switch (grade) {
    case 0: lapses += 1; ease = Math.max(1.3, ease - 0.2); iv = 0; break;
    case 1: ease = Math.max(1.3, ease - 0.15); iv = Math.max(1, Math.round(iv * 1.2)); break;
    case 2: iv = iv < 1 ? 2 : Math.max(iv + 1, Math.round(iv * ease)); break;
    default: ease += 0.15; iv = iv < 1 ? 4 : Math.round(iv * ease * 1.3);
  }
  if (iv > 1 && examDays <= 28) iv = Math.max(1, Math.round(iv * 0.6));
  const interval = Math.trunc(iv); // Swift Int(iv)
  return { ease: Math.round(ease * 100) / 100, interval, lapses: Math.trunc(lapses), reps: Math.trunc(num(user.reps)) + 1,
           due: addDays(today, interval), reviewedAt: Math.round(now) };
}

export const intervalLabel = (days) => (days === 0 ? "today" : days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`);

/** A card with no due date is new, so it is due now. */
export const isDue = (card, today) => str(card.user_data?.due) <= today;

/** Due cards, oldest due first, then by id in natural order (crg-l1-2 before crg-l1-10). */
export function due(cards, today) {
  return cards.filter((c) => isDue(c, today)).sort((a, b) => {
    const x = str(a.user_data?.due), y = str(b.user_data?.due);
    return x !== y ? (x < y ? -1 : 1) : a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
  });
}

/** The earliest due date still in the future, if any. */
export const nextDue = (cards, today) => cards.map((c) => str(c.user_data?.due)).filter((d) => d > today).sort()[0] ?? null;

/** Days until the card's module exam (an assessment titled "…exam…" not yet past), 999 if none.
 *  A card with no module looks at every assessment, as StudyModel does via store.items(module: nil). */
export function examDays(assessments, module, today) {
  const days = assessments
    .filter((a) => (module == null || a.module === module) && /exam/i.test(a.title ?? (a.data?.title || "")) && a.date)
    .map((a) => daysBetween(today, a.date.slice(0, 10)))
    .filter((d) => d >= 0);
  return days.length ? Math.min(...days) : 999;
}
