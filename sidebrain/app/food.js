// Food (phone v2 brief items 5–6; research "(C) v2-research-food.md"): log by a photo and a line, a typed or dictated line,
// a barcode (Open Food Facts) or a usual meal; macros and the micros worth watching; targets from Train's setup, shaped by
// WHOOP workouts, every one adjustable. Meals stay `gym` rows with data.type "meal", so the ones Train logged still read;
// usual meals are meal rows marked saved (no new table). Pure functions are exported for food.test.mjs; the sheet only
// mounts in a browser. Every constant in the targets is a rule of thumb, and the screen says so.
import { sessionsOf, sessionForDay, weightTrend } from "./gym.js";
import { todayString, addDays } from "./sm2.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r1 = (x) => Math.round(x * 10) / 10;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------- Items and meals ----------

export const MACROS = ["kcal", "protein_g", "carbs_g", "fat_g", "fibre_g"];
/** The watch strip: UK adult reference intakes (NHS; salt is a ceiling). [key, label, unit, men, women, ceiling?] Fibre sits on the item, the rest in item.micros. */
export const WATCH = [
  ["fibre_g", "Fibre", "g", 30, 30], ["salt_g", "Salt", "g", 6, 6, true], ["iron_mg", "Iron", "mg", 8.7, 14.8],
  ["calcium_mg", "Calcium", "mg", 700, 700], ["potassium_mg", "Potassium", "mg", 3500, 3500], ["magnesium_mg", "Magnesium", "mg", 300, 270],
  ["vitd_ug", "Vitamin D", "µg", 10, 10], ["b12_ug", "B12", "µg", 1.5, 1.5], ["zinc_mg", "Zinc", "mg", 9.5, 7], ["vitc_mg", "Vitamin C", "mg", 40, 40],
];
export const MICROS = WATCH.slice(1).map((w) => w[0]);

/** One nutrient of an item, or null when it isn't known (shown "n/a", never 0). */
export const val = (i, k) => { const v = MACROS.includes(k) ? i?.[k] : i?.micros?.[k]; return isNum(v) ? v : null; };
const snap = (i) => ({ grams: i.grams, ...Object.fromEntries(MACROS.map((k) => [k, val(i, k)])),
  ...(i.micros ? { micros: Object.fromEntries(MICROS.map((k) => [k, val(i, k)])) } : {}) });

/** Scales an item to new grams from its first numbers (kept in `base`), so repeated edits never drift. Missing stays missing. */
export function scale(item, grams) {
  const base = item.base ?? snap(item);
  const g = Math.max(0, Math.round(Number(grams) || 0)), f = base.grams > 0 ? g / base.grams : 0;
  const s = (v, k) => (isNum(v) ? (k === "kcal" ? Math.round(v * f) : r1(v * f)) : null);
  const out = { ...item, base, grams: g };
  for (const k of MACROS) out[k] = s(base[k], k);
  if (base.micros) out.micros = Object.fromEntries(MICROS.map((k) => [k, s(base.micros[k], k)]));
  return out;
}

export const itemsOf = (m) => m.user_data?.items ?? m.data?.items ?? [];
export const meals = (rows) => rows.filter((r) => r.data?.type === "meal" && !r.deleted_at && !r.user_data?.gone);
export const mealAt = (m) => m.user_data?.at ?? m.data?.at ?? (Date.parse(m.created_at) || 0);
export const mealName = (m) => m.user_data?.name || m.data?.note || itemsOf(m).map((i) => i.name).join(", ") || m.title || "Meal";
export const isSaved = (m) => !!(m.user_data?.saved ?? m.data?.saved);
/** Train's first Food sheet only ever estimated, so an item without a source is an estimate too. */
export const isEstimate = (i) => i.estimate === true || !i.source;

/** Sums items. Each nutrient is {v, partial}: v null when no item has it; partial when some items lack it. */
export function sum(items) {
  const out = {};
  for (const k of [...MACROS, ...MICROS]) {
    const known = items.map((i) => val(i, k)).filter((v) => v != null), t = known.reduce((a, b) => a + b, 0);
    out[k] = { v: known.length ? (k === "kcal" ? Math.round(t) : r1(t)) : null, partial: known.length > 0 && known.length < items.length };
  }
  return out;
}

/** A day's totals, plus how many meals there are and how many hold an estimate. */
export function dayTotals(rows, day) {
  const today = meals(rows).filter((m) => m.date === day);
  return { ...sum(today.flatMap(itemsOf)), meals: today.length, estimated: today.filter((m) => itemsOf(m).some(isEstimate)).length };
}

// ---------- Usual meals: saved ones first, then what's been eaten on 2+ days this month ----------

const STOP = new Set("my usual the a an i i've ive had ate have just some normal regular for today again same as eaten and with of".split(" "));
export const words = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
const keyOf = (s) => [...new Set(words(s))].sort().join(" ");

export function usuals(rows, day, n = 6) {
  const all = meals(rows).sort((a, b) => mealAt(b) - mealAt(a)), out = [], seen = new Set();
  const push = (m) => { const k = keyOf(mealName(m)); if (!k || seen.has(k) || out.length >= n) return; seen.add(k); out.push({ name: mealName(m), items: itemsOf(m), from: m.id }); };
  all.filter(isSaved).forEach(push);
  const days = new Map(), from = addDays(day, -30);
  for (const m of all.filter((x) => x.date >= from)) { const k = keyOf(mealName(m)); if (k) (days.get(k) ?? days.set(k, { m, d: new Set() }).get(k)).d.add(m.date); }
  [...days.values()].filter((x) => x.d.size >= 2).sort((a, b) => b.d.size - a.d.size).forEach((x) => push(x.m));
  return out;
}

/** A typed line against the usual meals: every word of the line is in the meal's name, or the meal's name is most of the line. */
export function matchSaved(text, list) {
  const t = [...new Set(words(text))];
  if (!t.length) return null;
  let best = null, top = 0;
  for (const u of list) {
    const w = [...new Set(words(u.name))], hit = t.filter((x) => w.includes(x)).length, score = hit / Math.max(t.length, w.length);
    if (hit && (hit === t.length || (hit === w.length && score >= 0.75)) && score > top) { best = u; top = score; }
  }
  return best;
}

// ---------- Open Food Facts (per 100 g; minerals and vitamins come in grams) ----------

export const kcalFromKJ = (kj) => kj / 4.184;
const OFF = { protein_g: ["proteins"], carbs_g: ["carbohydrates"], fat_g: ["fat"], fibre_g: ["fiber"], salt_g: ["salt"],
  iron_mg: ["iron", 1e3], calcium_mg: ["calcium", 1e3], potassium_mg: ["potassium", 1e3], magnesium_mg: ["magnesium", 1e3],
  vitd_ug: ["vitamin-d", 1e6], b12_ug: ["vitamin-b12", 1e6], zinc_mg: ["zinc", 1e3], vitc_mg: ["vitamin-c", 1e3] };
export const servingGrams = (s) => { const m = String(s ?? "").match(/(\d+(?:[.,]\d+)?)\s*(g|ml)\b/i); return m ? Math.round(Number(m[1].replace(",", "."))) || null : null; };

/** An OFF product as an item at one serving (or 100 g). A nutrient OFF doesn't have stays null. */
export function fromOFF(p, code) {
  const n = p?.nutriments ?? {};
  const get = (k, f = 1) => { const raw = n[`${k}_100g`], v = Number(raw); return raw === undefined || raw === null || raw === "" || !Number.isFinite(v) ? null : v * f; };
  const kj = get("energy-kj") ?? get("energy"), kcal = get("energy-kcal") ?? (kj == null ? null : kcalFromKJ(kj));
  const pick = (k) => { const [key, f] = OFF[k]; const v = get(key, f); return v == null ? null : r1(v); };
  const base = { grams: 100, kcal: kcal == null ? null : Math.round(kcal), ...Object.fromEntries(["protein_g", "carbs_g", "fat_g", "fibre_g"].map((k) => [k, pick(k)])),
    micros: Object.fromEntries(MICROS.map((k) => [k, pick(k)])) };
  const name = [p?.brands?.split(",")[0]?.trim(), p?.product_name?.trim()].filter(Boolean).join(" ").slice(0, 60) || `Barcode ${code}`;
  return scale({ name, ...base, base, source: "label", estimate: false, code: String(code) }, servingGrams(p?.serving_size) ?? 100);
}

// ---------- The ai function (X-Sidebrain-Task: food): Responses API, strict JSON schema ----------

const RULES = "You estimate food from a photo and/or the person's words. List each food separately with its weight in grams as eaten and, per item: kcal; "
  + "protein, carbs, fat and fibre in grams; salt in grams; iron, calcium, potassium, magnesium, zinc and vitamin C in mg; vitamin D and B12 in micrograms. "
  + "Use null for any value you can't estimate. Portions are often restaurant-sized: list cooking oil, butter and sauces as their own items when they are likely. "
  + "When unsure of a portion, use the larger likely size. Use the person's names and amounts over what you see.";

export function foodAsk(note, image) {
  const n = { type: ["number", "null"] }, num = { type: "number" };
  const props = { name: { type: "string" }, grams: num, kcal: num, protein_g: num, carbs_g: n, fat_g: n, fibre_g: n, ...Object.fromEntries(MICROS.map((k) => [k, n])) };
  return {
    instructions: RULES,
    input: [{ role: "user", content: [{ type: "input_text", text: note?.trim() || "No note." }, ...(image ? [{ type: "input_image", image_url: image }] : [])] }],
    text: { format: { type: "json_schema", name: "meal", strict: true, schema: { type: "object", additionalProperties: false, required: ["items"],
      properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(props), properties: props } } } } } },
    max_output_tokens: 2500,
  };
}

/** Items out of a Responses reply: named, at most 12, numbers ≥ 0, each marked an estimate from `source`. */
export function parseAsk(reply, source) {
  const text = (reply?.output ?? []).flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text;
  let items;
  try { items = JSON.parse(text ?? "{}").items ?? []; } catch { return []; }
  const n = (v) => (isNum(Number(v)) && v !== null && v !== "" ? Math.max(0, r1(Number(v))) : null);
  return items.filter((i) => typeof i?.name === "string" && i.name.trim()).slice(0, 12).map((i) => {
    const it = { name: i.name.trim().slice(0, 60), grams: Math.round(n(i.grams) ?? 0), source, estimate: true,
      ...Object.fromEntries(MACROS.map((k) => [k, n(i[k])])), micros: Object.fromEntries(MICROS.map((k) => [k, n(i[k])])) };
    if (it.kcal != null) it.kcal = Math.round(it.kcal);
    return scale(it, it.grams);
  });
}

// ---------- Targets (research: modelled, every constant a rule of thumb) ----------

export const ACTIVITY = 1.55, GAIN = 1.10, SHAPE = 0.72, NUDGE = 150;
export const mifflin = ({ kg, cm, age, sex }) =>
  kg > 0 && cm > 0 && age > 0 && (sex === "m" || sex === "f") ? 10 * kg + 6.25 * cm - 5 * age + (sex === "m" ? 5 : -161) : null;

/** Maintenance kcal: Mifflin-St Jeor × 1.55, null without height, age or sex. Logged intake is not used: it reads 25–36%
 *  low, so a target built on it would fall below maintenance. The weight-trend nudge in targets() corrects instead. */
export function maintenance({ kg, cm, age, sex }) {
  const bmr = mifflin({ kg, cm, age, sex });
  return bmr == null ? null : { kcal: Math.round(bmr * ACTIVITY), bmr: Math.round(bmr) };
}

/** Protein 1.6 g/kg, fat 1 g/kg, carbs the rest but never under 3 g/kg. */
export function macros(kcal, kg, perKg = 1.6) {
  const protein = Math.round(perKg * kg), fat = Math.round(kg);
  return { protein, fat, carbs: Math.max(Math.round(3 * kg), Math.round((kcal - 4 * protein - 9 * fat) / 4)) };
}

/** Rugby (training or the match), a lift (logged, or on the plan) or rest. */
export function dayType(day, profile = {}, sessions = []) {
  const wd = new Date(day + "T12:00:00").getDay();
  if (wd === (profile?.matchDay ?? 3) || (profile?.rugbyDays ?? [2, 6]).includes(wd)) return "rugby";
  return sessions.some((s) => s.date === day) || sessionForDay(day) ? "lift" : "rest";
}

/** The day's shift: 0.72 × (this day type's average workout kcal − every day's average), to 10 kcal. Over a normal week
 *  it nets out, so a hard day gets more and a rest day less, and WHOOP never tops a day up. history: [{type, kcal}] per day. */
export function shape(type, history = []) {
  if (history.length < 7) return 0;
  const mine = history.filter((h) => h.type === type).map((h) => h.kcal);
  return mine.length ? Math.round((SHAPE * (avg(mine) - avg(history.map((h) => h.kcal)))) / 10) * 10 || 0 : 0; // || 0: never -0
}

/** Today's targets: suggested and yours (an override wins; carbs are re-worked from your calories, protein and fat).
 *  `proteinHigh` flags a protein override above 2.2 g/kg, past what the research supports; it is shown, never clamped. */
export function targets({ kg, cm, age, sex, status = null, type = "rest", history = [], over = {} }) {
  const m = maintenance({ kg, cm, age, sex });
  const nudge = status === "low" || status === "flat" ? NUDGE : status === "high" ? -NUDGE : 0, shift = shape(type, history);
  const kcal = m ? Math.round((m.kcal * GAIN + nudge + shift) / 10) * 10 : null;
  const sug = kg > 0 ? macros(kcal ?? 0, kg) : { protein: null, fat: null, carbs: null };
  const o = (k) => (isNum(over[k]) && over[k] > 0 ? over[k] : null);
  const protein = o("protein") ?? sug.protein;
  const fat = o("fat") ?? sug.fat, yk = o("kcal") ?? kcal;
  const carbs = yk != null && kg > 0 ? Math.max(Math.round(3 * kg), Math.round((yk - 4 * protein - 9 * fat) / 4)) : null;
  return { maintenance: m, nudge, shift, type, proteinHigh: kg > 0 && protein > 2.2 * kg,
    suggested: { kcal, protein: sug.protein, fat: sug.fat, carbs }, yours: { kcal: yk, protein, fat, carbs: o("carbs") ?? carbs } };
}

/** WHOOP workouts → kcal per local day (kJ ÷ 4.184). */
export function workoutKcal(workouts) {
  const out = {};
  for (const w of workouts ?? []) if (isNum(w.kilojoule)) { const d = todayString(new Date(w.start)); out[d] = (out[d] ?? 0) + kcalFromKJ(w.kilojoule); }
  return out;
}

// =====================================================================================================================
// The sheet (browser only). One <dialog id="food-sheet">, one view at a time: day, log, plate, barcode, targets.
// =====================================================================================================================

let ctx = null;
let rows = [];          // meal rows and the food row (gym-food); Train's profile, weights and sessions are read from its own copy
let view = null;        // {mode, back?}
let plate = null;       // the meal being built or edited: {id?, name, items, photo, saved, busy, error, retype?, matched?}
let line = "";          // the log sheet's text line
let scan = null;        // the barcode view: {stream, timer, product, grams, busy, error, code}
let notice = null;      // {text, undo?}: the day view's one-line status (the shell's toast sits under a modal sheet)
let hist = null;        // WHOOP workouts by day type, for the day's shape
let bad = "";           // Targets: a height or age out of range, not saved

const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(String(s ?? ""));
const fmt = (n) => new Intl.NumberFormat("en-GB").format(n);
const MINE = new Set(["meal", "food"]);
const G = (d) => `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const BARCODE = G(`<path d="M4.25 6v12M7.25 6v12M10.75 6v12M13.25 6v12M16.75 6v12M19.75 6v12"/>`);
const BACK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>`;

export function mount(c) {
  ctx = c;
  rows = ctx.load("food", []);
  hist = ctx.load("food-whoop", null);
  const dlg = document.createElement("dialog");
  dlg.className = "sheet food"; dlg.id = "food-sheet"; dlg.setAttribute("aria-labelledby", "food-title");
  document.body.append(dlg);
  dlg.innerHTML = head("Food");
  ctx.sheetGestures(dlg);
  dlg.addEventListener("close", () => { view = null; ctx.rerender(); }); // Train's Food row and Today's Suggestions catch up
  dlg.addEventListener("click", click);
  dlg.addEventListener("input", input);
  dlg.addEventListener("change", change);
  dlg.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-f=line], [data-f=retype-text], [data-f=code]")) { e.preventDefault(); e.target.blur(); submit(e.target.dataset.f); } });
}

/** Train's gym rows in (the same fetch): a local row wins while its userAt is newer; one added here stays until the server has it. */
export function setRows(fetched) {
  const mine = new Map(rows.map((r) => [r.id, r])), seen = new Set(fetched.map((r) => r.id)), recent = Date.now() - 10 * 60000;
  rows = fetched.filter((r) => MINE.has(r.data?.type))
    .map((f) => { const l = mine.get(f.id), at = l?.user_data?.userAt, theirs = f.user_data?.userAt ?? (Date.parse(f.updated_at) || 0);
      return typeof at === "number" && at > theirs ? { ...f, user_data: l.user_data } : f; })
    .concat(rows.filter((r) => !seen.has(r.id) && (r.fresh ?? 0) > recent));
  save();
  if (view?.mode === "day") paint(); // never under a half-typed line or an unsaved plate
}

/** Food today. */
export function open() { plate = null; scan = null; show({ mode: "day" }); pullWhoop(); }
/** Straight to logging: "barcode" opens the barcode view; "photo" the log view with Photo focused (iOS opens the camera
 *  only from a tap, never from a link); "text" (or nothing) the log view with the line focused. */
export function openLog(method = "text") {
  plate = null; line = ""; notice = null; scan = null;
  if (method === "barcode") return show({ mode: "barcode" });
  show({ mode: "log" });
  $("food-sheet").querySelector(method === "photo" ? "[data-f=photo]" : "[data-f=line]")?.focus();
}
/** Today's protein and kcal, for Train's Food row. */
/** Today so far, for Train's Food row and Today's Suggestion N8: the target is the one Food shows, Ricky's own if he set one. */
export const today = () => { const t = dayTotals(all(), todayString()); return { protein: t.protein_g.v ?? 0, kcal: t.kcal.v ?? 0, meals: t.meals, target: ctx ? context().t.yours.protein : null }; };

function show(v) {
  view = v;
  paint();
  ctx.openSheet($("food-sheet"));
  $("food-sheet").scrollTop = 0;
}
const save = () => ctx.keep("food", rows);
const foodRow = () => rows.find((r) => r.id === "gym-food") ?? null;
const me = () => foodRow()?.user_data ?? {};
const train = () => ctx.load("gym", []); // Train keeps its rows there (train.js save()); read-only here
/** Food's rows, plus any meal Train logged that the next fetch hasn't brought here yet. */
const all = () => { const ids = new Set(rows.map((r) => r.id)); return rows.concat(train().filter((r) => r.data?.type === "meal" && !ids.has(r.id))); };
const trainProfile = () => train().find((r) => r.id === "gym-profile")?.user_data ?? {};

function add(row) {
  const r = { kind: "gym", source: "you", module: null, deleted_at: null, ...row };
  rows.push({ ...r, fresh: Date.now(), created_at: new Date().toISOString() });
  save();
  ctx.addRow(r);
  return rows[rows.length - 1];
}
function patch(row, p) { ctx.writeUser(row, p, "edit"); save(); }
function setMe(p) {
  const r = foodRow();
  if (r) patch(r, p); else add({ id: "gym-food", date: null, title: "Food targets", data: { type: "food" }, user_data: { ...p, userAt: Date.now() } });
}

// ---------- Server calls ----------

async function call(fn, body, headers = {}) {
  const t = (await ctx.sb()?.auth.getSession())?.data?.session?.access_token;
  if (!t) throw new Error("Sign in to use this.");
  const r = await fetch(`${ctx.url}/functions/v1/${fn}`, { method: "POST", body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${t}`, apikey: ctx.anon, "Content-Type": "application/json", ...headers } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error?.message ?? j.error ?? "Couldn’t reach Sidebrain."); e.status = r.status; throw e; }
  return j;
}

/** The last 28 days of WHOOP workouts, once a day: each past day's type and workout kcal. */
async function pullWhoop() {
  const day = todayString();
  if (hist?.day === day) return;
  let kcal = {};
  try {
    if (ctx.demo) kcal = demoWorkouts(day);
    else kcal = workoutKcal((await call("whoop", { action: "workouts", start: new Date(Date.now() - 28 * 864e5).toISOString(), end: new Date().toISOString() })).workouts);
  } catch { return; } // not connected or offline: no shape today, the flat target stands
  const sessions = sessionsOf(train()), p = trainProfile();
  // ponytail: 28 days at WHOOP's 25-a-call limit; page the call if Ricky ever logs more than 25 workouts a month.
  const days = Array.from({ length: 28 }, (_, i) => addDays(day, -28 + i));
  hist = { day, days: days.map((d) => ({ type: dayType(d, p, sessions), kcal: Math.round(kcal[d] ?? 0) })) };
  ctx.keep("food-whoop", hist);
  if (view?.mode === "day") paint();
}

const OFF_URL = "https://world.openfoodfacts.org/api/v2/product/";
const offReads = [], offCache = new Map();
/** One product read. OFF asks for at most 15 a minute; the app is named in the query (a browser can't set User-Agent). */
async function lookup(code) {
  if (offCache.has(code)) return offCache.get(code);
  if (ctx.demo) return demoProduct(code);
  const now = Date.now();
  while (offReads.length && now - offReads[0] > 60_000) offReads.shift();
  if (offReads.length >= 15) throw new Error("That’s a lot of lookups. Try again in a minute.");
  offReads.push(now);
  const r = await fetch(`${OFF_URL}${encodeURIComponent(code)}.json?fields=product_name,brands,serving_size,nutriments&app_name=Sidebrain&app_version=2`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === 0 || !j.product) throw new Error("Open Food Facts doesn’t have that barcode. Type what it is instead.");
  offCache.set(code, j.product);
  return j.product;
}

// ---------- Painting ----------

function head(title, sub = "", back = false) {
  return `<div class="grabber" aria-hidden="true"></div><div class="sheet-head">
    ${back ? `<button class="close food-back" type="button" data-f="back" aria-label="Back">${BACK}</button>` : ""}
    <div class="head-text"><h2 class="headline" id="food-title">${esc(title)}</h2>${sub ? `<p class="foot">${esc(sub)}</p>` : ""}</div>
    <button class="close" type="button" data-close aria-label="Close">${ctx.ICON.close}</button></div>`;
}

function paint() {
  const dlg = $("food-sheet");
  if (!view || !dlg) return;
  dlg.innerHTML = { day: dayView, log: logView, plate: plateView, barcode: barcodeView, targets: targetsView }[view.mode]();
}

/** Calories rounded to 10 and said as "about" whenever an estimate is in them: photo maths is never precise. */
const kcalText = (v, est) => (v == null ? "n/a" : est ? `about ${fmt(Math.round(v / 10) * 10)}` : fmt(v));
// Whole numbers from 10 up, one decimal under: "112 g" and "1.5 µg", never "111.5 g" off an estimate. "~" marks an
// estimate in the total, "≥" a total some items have no value for.
const amount = (t, unit, est = false) => (t.v == null || (t.partial && t.v === 0) ? "n/a"
  : `${est ? "~" : t.partial ? "≥ " : ""}${fmt(t.v >= 10 ? Math.round(t.v) : t.v)}${unit ? ` ${unit}` : ""}`);

function context() {
  const day = todayString(), p = trainProfile(), m = me(), sessions = sessionsOf(train());
  const weights = train().filter((r) => r.data?.type === "weight" && isNum(r.user_data?.kg)).map((r) => ({ date: r.date, kg: r.user_data.kg }));
  const trend = weightTrend(weights, day), kg = trend?.avg ?? (isNum(p.weight) ? p.weight : null);
  const type = dayType(day, p, sessions);
  const t = targets({ kg, cm: m.height, age: m.age, sex: m.sex, status: trend?.status, type, history: hist?.day === day ? hist.days : [], over: m.over ?? {} });
  return { day, kg, t, type, sex: m.sex };
}

const TYPE = { rugby: "Rugby day", lift: "Lifting day", rest: "Rest day" };

function dayView() {
  const { day, t, type, sex } = context(), tot = dayTotals(all(), day), est = tot.estimated > 0;
  const list = meals(all()).filter((m) => m.date === day).sort((a, b) => mealAt(a) - mealAt(b));
  const y = t.yours, kcalNow = tot.meals ? tot.kcal.v ?? 0 : 0, have = (k) => (tot.meals ? amount(tot[k], "", est) : "0");
  const bar = (label, have, goal, unit, k) => `<button type="button" class="food-bar" data-f="targets" aria-label="${label}: ${have} of ${goal ?? "no target"} ${unit}. Change the target">
      <span class="food-line"><span>${label}</span><span>${have}${goal ? ` / ${fmt(goal)}` : ""} ${unit}</span></span>
      <span class="food-rail"><i style="--p:${goal ? Math.min(1, (tot[k].v ?? 0) / goal).toFixed(3) : 0}"></i></span></button>`;
  const usual = usuals(all(), day);
  return `${head("Food", `${TYPE[type]}${t.shift ? ` · ${t.shift > 0 ? "+" : "−"}${fmt(Math.abs(t.shift))} kcal` : ""}`)}
    ${notice ? `<p class="foot food-notice" role="status">${esc(notice.text)}${notice.undo ? ` <button type="button" class="food-link" data-f="undo">Undo</button>` : ""}</p>` : ""}
    ${logBar()}
    <button class="btn primary" type="button" data-f="go" ${line.trim() && !plate?.busy ? "" : "disabled"}>${plate?.busy ? "Estimating…" : "Estimate"}</button>
    ${usual.length ? `<p class="caption-h food-cap">Usual · one tap adds it</p><div class="food-chips">${chips(usual)}</div>` : ""}
    <section class="food-sum">
      <button type="button" class="food-bar" data-f="targets" aria-label="Calories: ${kcalText(kcalNow, est)} of ${y.kcal ?? "no target"}. Change the target">
        <span class="food-kcal"><b>${kcalText(kcalNow, est)}</b><span>${y.kcal ? `of ${fmt(y.kcal)} kcal` : "kcal"}</span></span>
        <span class="food-rail"><i style="--p:${y.kcal ? Math.min(1, kcalNow / y.kcal).toFixed(3) : 0}"></i></span></button>
      <div class="food-macros">${bar("Protein", have("protein_g"), y.protein, "g", "protein_g")}${bar("Carbs", have("carbs_g"), y.carbs, "g", "carbs_g")}${bar("Fat", have("fat_g"), y.fat, "g", "fat_g")}</div>
      ${est ? `<p class="foot">Includes ${tot.estimated} estimated ${tot.estimated === 1 ? "meal" : "meals"}. Estimates read low, so the real total is likely higher.</p>` : ""}
      ${!y.kcal ? `<p class="foot">Add your height, age and sex in Targets for a calorie target.</p>` : ""}
    </section>
    <ul class="food-strip" aria-label="Micros today">${WATCH.map(([k, label, unit, men, women, cap]) => { const v = tot.meals ? tot[k] : { v: null };
      return `<li><span class="k">${label}</span><span class="v${v.v == null ? " na" : ""}">${amount(v, unit, est)}</span><span class="k">${cap ? "under" : "of"} ${fmt(sex === "f" ? women : men)} ${unit}</span></li>`; }).join("")}</ul>
    ${list.length ? `<p class="caption-h food-cap">Today</p><ul class="group">${list.map((m) => { const s = sum(itemsOf(m)), e = itemsOf(m).some(isEstimate);
      return ctx.row({ tag: "button", attrs: `data-f="meal" data-id="${esc(m.id)}"`, lead: `<span class="time">${clock(mealAt(m))}</span>`, title: esc(mealName(m)),
        sub: `${kcalText(s.kcal.v, e)} kcal · ${amount(s.protein_g, "g", e)} protein`, chev: true }); }).join("")}</ul>` : ""}
    <ul class="group flat">${ctx.row({ tag: "button", attrs: `data-f="targets"`, title: "Targets", trail: y.kcal ? `${fmt(y.kcal)} kcal` : "Set up", chev: true })}</ul>`;
}
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "");
const chips = (list) => list.map((u, i) => `<button type="button" class="chip-btn" data-f="usual" data-i="${i}"><span class="chip">${esc(u.name)}</span></button>`).join("");

/** The line (the keyboard's mic is the voice input), the photo and the barcode: on the day view and the log view alike. */
function logBar() {
  const p = plate;
  return `<ul class="group flat"><li><input class="gym-text" type="text" data-f="line" value="${esc(line)}" enterkeyhint="go" autocomplete="off" autocapitalize="sentences"
      placeholder="${p?.photo ? "What’s in it? Or just Estimate" : "What did you eat? Type or say it"}" aria-label="What you ate"></li></ul>
    ${p?.photo && view.mode === "log" ? `<img class="food-photo" src="${p.photo}" alt="Your photo">` : ""}
    <div class="food-ways">
      <label class="btn secondary">${ctx.ICON.camera}${p?.photo ? "Retake" : "Photo"}<input class="overlay" type="file" accept="image/*" capture="environment" data-f="photo" aria-label="Take a photo of the meal"></label>
      <button class="btn secondary" type="button" data-f="barcode">${BARCODE}Barcode</button></div>
    ${p?.error ? `<p class="foot warn">${esc(p.error)}</p>` : ""}`;
}

function logView() {
  const p = plate, usual = usuals(all(), todayString()), busy = p?.busy;
  const ready = (line.trim() || p?.photo) && !busy;
  return `${head(p?.items.length ? "Add to this meal" : "Log food", "", view.back)}
    ${logBar()}
    ${usual.length && !p?.items.length ? `<p class="caption-h food-cap">Usual</p><div class="food-chips">${chips(usual)}</div>` : ""}
    <button class="btn primary" type="button" data-f="go" ${ready ? "" : "disabled"}>${busy ? "Estimating…" : "Estimate"}</button>`;
}

function plateView() {
  const p = plate, s = sum(p.items), est = p.items.some(isEstimate), label = p.items.some((i) => i.source === "label");
  const photoish = p.items.some((i) => i.source === "photo" || i.source === "text");
  const badge = (i) => ({ label: "label", saved: "saved" }[i.source] ?? (isEstimate(i) ? "estimate" : "typed"));
  const itemRow = (i, n) => p.retype === n
    ? `<li><div class="row food-item"><input class="gym-text food-retype" type="text" data-f="retype-text" value="${esc(i.name)}" aria-label="What this item is" enterkeyhint="go">
        <button class="btn small secondary" type="button" data-f="retype-go" ${p.busy ? "disabled" : ""}>${p.busy ? "…" : "Estimate"}</button></div></li>`
    : `<li><div class="row food-item"><span class="text">
        <button type="button" class="food-name" data-f="retype" data-i="${n}" aria-label="${esc(i.name)}: retype and re-estimate">${esc(i.name)}</button>
        <span class="subtitle"><span class="food-badge">${badge(i)}</span> ${kcalText(i.kcal, isEstimate(i))} kcal · ${amount({ v: i.protein_g }, "g", isEstimate(i))} protein</span></span>
        <span class="gym-field"><input class="gym-input" type="text" inputmode="numeric" data-f="grams" data-i="${n}" value="${i.grams}" aria-label="${esc(i.name)} grams"><span class="gym-unit">g</span></span>
        <button type="button" class="food-x" data-f="drop" data-i="${n}" aria-label="Remove ${esc(i.name)}">${ctx.ICON.close}</button></div></li>`;
  const macro = (label, t) => `<span><b>${amount(t, "g", est)}</b><span>${label}</span></span>`;
  return `${head(p.id ? "Meal" : "Check the plate", est ? "Estimates read low. Fix the grams of the main item." : label ? "Data: Open Food Facts" : "", !!view.back)}
    ${p.matched ? `<p class="foot">Matched your usual “${esc(p.name)}”. <button type="button" class="food-link" data-f="not-usual">Not this? Estimate it</button></p>` : ""}
    <div class="food-total"><span class="food-kcal"><b>${kcalText(s.kcal.v, est)}</b><span>kcal</span></span>
      <div class="food-trio">${macro("protein", s.protein_g)}${macro("carbs", s.carbs_g)}${macro("fat", s.fat_g)}</div></div>
    ${p.items.length ? `<ul class="group flat">${p.items.map(itemRow).join("")}</ul>` : `<p class="foot">Nothing on the plate yet.</p>`}
    ${photoish ? `<p class="foot">Photos miss oil, butter and sauce. Add what went in:</p><div class="food-chips">${FATS.map((f, i) =>
      `<button type="button" class="chip-btn" data-f="fat" data-i="${i}"><span class="chip">+ ${f.name}, ${f.grams} g</span></button>`).join("")}</div>` : ""}
    ${p.error ? `<p class="foot warn">${esc(p.error)}</p>` : ""}
    <div class="food-ways"><button class="btn secondary" type="button" data-f="more">Add item</button>
      <button class="btn secondary" type="button" data-f="barcode">${BARCODE}${label ? "Scan another" : "Barcode"}</button></div>
    <details class="food-micros"><summary>Fibre, salt and micros</summary><ul class="group flat">${WATCH.map(([k, name, unit]) =>
      ctx.row({ title: name, trail: amount(s[k], unit, est), trailCls: s[k].v == null ? "na" : "" })).join("")}</ul></details>
    ${label ? `<p class="foot">Data: Open Food Facts (ODbL).</p>` : ""}
    <ul class="group flat"><li><label class="row"><span class="text"><span class="title">Save as a usual meal</span><span class="subtitle">One tap to log it again</span></span>
      <input type="checkbox" switch data-f="keep" ${p.saved ? "checked" : ""} aria-label="Save as a usual meal"></label></li>
      ${p.id ? "" : `<li><div class="row"><span class="text"><span class="title">Name</span></span><input class="gym-text food-named" type="text" data-f="name" value="${esc(p.name)}" aria-label="Meal name" autocapitalize="sentences"></div></li>`}</ul>
    <button class="btn primary" type="button" data-f="save" ${p.items.length && !p.busy ? "" : "disabled"}>${p.id ? "Save changes" : "Save"}</button>
    ${p.id ? `<button class="btn plain food-danger" type="button" data-f="remove">Remove meal</button>` : ""}`;
}
// Rule-of-thumb fats (UK composition tables, rounded): what photos most often miss.
// Known zeros are 0, so adding one doesn't turn every total into "≥".
const zero = (m = {}) => Object.fromEntries(MICROS.map((k) => [k, m[k] ?? 0]));
const FATS = [
  { name: "Oil", grams: 14, kcal: 124, protein_g: 0, carbs_g: 0, fat_g: 14, fibre_g: 0, micros: zero() },
  { name: "Butter", grams: 10, kcal: 74, protein_g: 0.1, carbs_g: 0.1, fat_g: 8.2, fibre_g: 0, micros: zero({ salt_g: 0.2 }) },
  { name: "Mayo or creamy sauce", grams: 30, kcal: 140, protein_g: 0.3, carbs_g: 1.5, fat_g: 15, fibre_g: 0, micros: zero({ salt_g: 0.4 }) },
];

function barcodeView() {
  const s = scan ?? {}, item = s.product ? fromOFF(s.product, s.code) : null, it = item && scale(item, s.grams ?? item.grams);
  const serving = s.product ? servingGrams(s.product.serving_size) : null;
  return `${head("Barcode", "", true)}
    ${!item ? `<ul class="group flat">
      <li><label class="row">${ctx.ICON.camera}<span class="text"><span class="title">Photo of the barcode</span></span>
        <input class="overlay" type="file" accept="image/*" capture="environment" data-f="code-photo" aria-label="Take a photo of the barcode"></label></li>
      <li><div class="row"><input class="gym-text food-code" type="text" inputmode="numeric" pattern="[0-9]*" data-f="code" value="${esc(s.code ?? "")}"
        placeholder="Or type the number" aria-label="Barcode number" enterkeyhint="search">
        <button class="btn small secondary" type="button" data-f="lookup" ${s.busy ? "disabled" : ""}>${s.busy ? "…" : "Look up"}</button></div></li></ul>`
    : `<ul class="group flat"><li><div class="row"><span class="text"><span class="title">${esc(item.name)}</span>
        <span class="subtitle">${kcalText(it.kcal, false)} kcal · ${it.protein_g ?? "n/a"} g protein · ${it.carbs_g ?? "n/a"} g carbs · ${it.fat_g ?? "n/a"} g fat</span></span>
        <span class="gym-field"><input class="gym-input" type="text" inputmode="numeric" data-f="code-grams" value="${it.grams}" aria-label="Grams"><span class="gym-unit">g</span></span></div></li></ul>
      <div class="food-chips">${serving ? `<button type="button" class="chip-btn" data-f="serv" data-g="${serving}"><span class="chip${it.grams === serving ? " on" : ""}">1 serving, ${serving} g</span></button>
        <button type="button" class="chip-btn" data-f="serv" data-g="${serving * 2}"><span class="chip${it.grams === serving * 2 ? " on" : ""}">2 servings</span></button>` : ""}
        <button type="button" class="chip-btn" data-f="serv" data-g="100"><span class="chip${it.grams === 100 ? " on" : ""}">100 g</span></button></div>
      <p class="foot">Data: Open Food Facts. Values per 100 g on the label, scaled to your grams.</p>
      <button class="btn primary" type="button" data-f="code-add">Add</button>
      <button class="btn plain" type="button" data-f="rescan">Scan a different one</button>`}
    ${s.error ? `<p class="foot warn">${esc(s.error)}</p>` : ""}`;
}

function targetsView() {
  const { t, kg, type } = context(), m = me(), over = m.over ?? {}, sex = m.sex === "f" ? 1 : m.sex === "m" ? 0 : null;
  const field = (label, key, value, unit, attrs = "") => `<li><label class="row"><span class="text"><span class="title">${label}</span></span>
    <span class="gym-field"><input class="gym-input" type="text" inputmode="numeric" data-f="me" data-k="${key}" value="${value ?? ""}" placeholder="–" ${attrs}><span class="gym-unit">${unit}</span></span></label></li>`;
  const target = (label, key, unit) => { const sug = t.suggested[key], yours = t.yours[key], mine = isNum(over[key]);
    return `<li><div class="row"><span class="text"><span class="title">${label}</span>
      <span class="subtitle">${sug != null ? `Suggested ${fmt(sug)}${mine ? `, yours ${fmt(yours)}` : ""}` : "Needs the fields above"}</span>
      ${mine ? `<button type="button" class="food-link food-reset" data-f="reset" data-k="${key}">Reset to ${sug != null ? fmt(sug) : "suggested"}</button>` : ""}</span>
      <span class="gym-field"><input class="gym-input" type="text" inputmode="numeric" data-f="over" data-k="${key}" value="${yours ?? ""}" placeholder="–" aria-label="${label} target in ${unit}"><span class="gym-unit">${unit}</span></span></div></li>`; };
  const mt = t.maintenance, why = !mt ? "Add height, age and sex to work out calories."
    : `Maintenance ${fmt(mt.kcal)} (Mifflin-St Jeor ${fmt(mt.bmr)} × ${ACTIVITY}), `
      + `+10% to gain${t.nudge ? `, ${t.nudge > 0 ? "+" : "−"}${NUDGE} for your weight trend` : ""}${t.shift ? `, ${t.shift > 0 ? "+" : "−"}${fmt(Math.abs(t.shift))} on a ${TYPE[type].toLowerCase()} from WHOOP workouts` : ""}. `
      + `Protein 1.6 g/kg, fat 1 g/kg, carbs the rest.`;
  return `${head("Targets", `${TYPE[type]}${kg ? ` · ${kg} kg from Train` : ""}`, true)}
    <p class="caption-h food-cap">About you</p>
    <ul class="group flat">${field("Height", "height", m.height, "cm", `aria-label="Height in cm"`)}${field("Age", "age", m.age, "yrs", `aria-label="Age in years"`)}
      <li><div class="row"><span class="text"><span class="title">Sex</span><span class="subtitle">For the formula</span></span>
        <div class="seg food-seg" style="--n: 2; --i: ${sex ?? 0}" ${sex == null ? "data-none" : ""} role="group" aria-label="Sex"><span class="thumb"></span>
          <button type="button" data-f="sex" data-v="m" aria-pressed="${sex === 0}">Male</button><button type="button" data-f="sex" data-v="f" aria-pressed="${sex === 1}">Female</button></div></div></li></ul>
    ${bad ? `<p class="foot warn">${esc(bad)}</p>` : ""}
    ${kg ? "" : `<p class="foot warn">Add your bodyweight in Train for protein and calorie targets.</p>`}
    <p class="caption-h food-cap">Today · tap a number to change it</p>
    <ul class="group flat">${target("Calories", "kcal", "kcal")}${target("Protein", "protein", "g")}${target("Carbs", "carbs", "g")}${target("Fat", "fat", "g")}</ul>
    ${t.proteinHigh ? `<p class="foot warn">Your protein is over 2.2 g/kg. Past about 1.6 g/kg there is no further gain in the research, so the extra mostly displaces carbs.</p>` : ""}
    <p class="foot">${esc(why)} Rules of thumb, not measurements: if your weight trend in Train says otherwise, it wins.</p>`;
}

// ---------- Actions ----------

const fresh = () => ({ name: "", items: [], photo: null, saved: false, busy: false, error: "" });

async function estimate() {
  plate ??= fresh();
  const note = line.trim(), photo = plate.photo;
  if (!note && !photo) return;
  // Typed with no photo: a usual meal first, the model only when nothing matches.
  if (!photo && !plate.items.length && !plate.skipMatch) {
    const u = matchSaved(note, usuals(all(), todayString(), 50));
    if (u) { Object.assign(plate, { name: u.name, items: u.items.map((i) => ({ ...i, source: "saved" })), matched: true, error: "" }); line = note; return go("plate"); }
  }
  plate.busy = true; plate.error = ""; paint();
  try {
    const body = foodAsk(note, photo), reply = ctx.demo ? demoAsk(body) : await call("ai", body, { "X-Sidebrain-Task": "food" });
    const items = parseAsk(reply, photo ? "photo" : "text");
    if (!items.length) throw new Error("Couldn’t read that meal. Add a line about what it is and try again.");
    plate.items.push(...items);
    plate.name ||= note || items.map((i) => i.name).join(", ").slice(0, 60);
    plate.photo = null; line = "";
    plate.busy = false; plate.matched = false;
    return go("plate");
  } catch (e) { plate.error = e.message; }
  plate.busy = false; paint();
}

async function retype(n) {
  const text = $("food-sheet").querySelector("[data-f=retype-text]")?.value.trim();
  if (!text) return;
  plate.busy = true; plate.error = ""; paint();
  try {
    const body = foodAsk(text, null), items = parseAsk(ctx.demo ? demoAsk(body) : await call("ai", body, { "X-Sidebrain-Task": "food" }), "text");
    if (!items.length) throw new Error("Couldn’t read that. Try different words.");
    plate.items.splice(n, 1, ...items);
    plate.retype = null;
  } catch (e) { plate.error = e.message; }
  plate.busy = false; paint();
}

function go(mode, back = view?.mode === "day" || view?.back) { view = { mode, back: back ? "day" : null }; paint(); $("food-sheet").scrollTop = 0; }

function saveMeal() {
  const p = plate, day = todayString(), items = p.items.map(({ ...i }) => i);
  if (p.id) {
    const r = rows.find((x) => x.id === p.id);
    if (r) patch(r, { items, saved: p.saved, name: p.name });
  } else {
    const name = (p.name || items.map((i) => i.name).join(", ")).trim().slice(0, 60) || "Meal";
    add({ id: `you-gym-${crypto.randomUUID()}`, date: day, title: name, data: { type: "meal", v: 2, note: name, at: Date.now(), saved: p.saved, items }, user_data: {} });
  }
  plate = null; line = "";
  if (view.back || p.id) { notice = { text: p.id ? "Saved." : "Logged." }; return go("day", false); }
  ctx.closeSheet($("food-sheet"));
  ctx.rerender?.();
}

function relog(u) {
  const r = add({ id: `you-gym-${crypto.randomUUID()}`, date: todayString(), title: u.name,
    data: { type: "meal", v: 2, note: u.name, at: Date.now(), saved: false, items: u.items.map((i) => ({ ...i, source: "saved" })) }, user_data: {} });
  notice = { text: `Added ${u.name}.`, undo: () => patch(r, { gone: true }) };
  plate = null; line = "";
  go("day", false);
}

function click(ev) {
  const t = ev.target.closest("[data-f]");
  if (!t || t.tagName === "INPUT") return;
  const d = t.dataset, i = Number(d.i);
  switch (d.f) {
    case "back": // log or barcode go back to the plate they add to; barcode alone goes to the line; the rest to the day
      if ((view.mode === "log" || view.mode === "barcode") && plate?.items.length) return go("plate");
      if (view.mode === "barcode") return go("log", true);
      plate = null; line = ""; return go("day", false);
    case "targets": notice = null; return go("targets", true);
    case "meal": { const m = all().find((x) => x.id === d.id); if (!m) return;
      if (!rows.includes(m)) rows.push(m); // a meal Train's first Food sheet logged: Food keeps its edits from now on
      plate = { ...fresh(), id: m.id, name: mealName(m), items: structuredClone(itemsOf(m)), saved: isSaved(m) }; notice = null; return go("plate", true); }
    case "usual": { const u = usuals(all(), todayString())[i]; return u && relog(u); }
    case "undo": notice?.undo?.(); notice = null; return paint();
    case "go": return estimate();
    case "barcode": scan = null; return go("barcode");
    case "more": go("log"); return $("food-sheet").querySelector("[data-f=line]")?.focus();
    case "not-usual": plate = { ...fresh(), skipMatch: true }; return estimate();
    case "retype": plate.retype = i; paint(); return $("food-sheet").querySelector("[data-f=retype-text]")?.select();
    case "retype-go": return retype(plate.retype);
    case "drop": plate.items.splice(i, 1); return paint();
    case "fat": { const f = FATS[i]; plate.items.push(scale({ ...f, source: "added", estimate: true }, f.grams)); return paint(); }
    case "save": return saveMeal();
    case "remove": { const r = rows.find((x) => x.id === plate.id); if (!r) return; patch(r, { gone: true });
      notice = { text: `Removed ${mealName(r)}.`, undo: () => patch(r, { gone: false }) }; plate = null; return go("day", false); }
    case "lookup": return submit("code");
    case "serv": scan.grams = Number(d.g); return paint();
    case "code-add": { const it = scale(fromOFF(scan.product, scan.code), scan.grams ?? servingGrams(scan.product.serving_size) ?? 100);
      plate ??= fresh(); plate.items.push(it); plate.name ||= it.name; scan = null; return go("plate", view.back); }
    case "rescan": scan = null; return paint();
    case "sex": setMe({ sex: d.v }); return paint();
    case "reset": { const over = { ...(me().over ?? {}) }; delete over[d.k]; setMe({ over }); return paint(); }
  }
}

function submit(f) {
  if (f === "line") return estimate();
  if (f === "retype-text") return retype(plate.retype);
  if (f === "code") return find($("food-sheet").querySelector("[data-f=code]")?.value.replace(/\D/g, ""));
}

async function find(code) {
  scan ??= {};
  if (!code || code.length < 6) { scan.error = "Type the numbers under the barcode."; return paint(); }
  scan.code = code; scan.busy = true; scan.error = ""; paint();
  try { scan.product = await lookup(code); scan.grams = servingGrams(scan.product.serving_size) ?? 100; }
  catch (e) { scan.error = e.message; }
  scan.busy = false; paint();
}

/** Typing only updates state (no repaint), so the keyboard stays up. */
function input(ev) {
  const t = ev.target, f = t.dataset.f;
  if (f === "line") { line = t.value; const b = $("food-sheet").querySelector("[data-f=go]"); if (b) b.disabled = !!plate?.busy || !(t.value.trim() || plate?.photo); }
  else if (f === "name" && plate) plate.name = t.value;
  else if (f === "code") (scan ??= {}).code = t.value;
}

const parse = (v) => { const x = parseFloat(String(v).replace(",", ".")); return Number.isFinite(x) && x > 0 ? x : null; };

async function change(ev) {
  const t = ev.target, d = t.dataset;
  if (d.f === "grams") { plate.items[Number(d.i)] = scale(plate.items[Number(d.i)], t.value); return paint(); }
  if (d.f === "code-grams") { scan.grams = Math.round(parse(t.value) ?? 0); return paint(); }
  if (d.f === "keep") { plate.saved = t.checked; return; }
  if (d.f === "me") {
    const v = parse(t.value), [lo, hi, what] = d.k === "height" ? [120, 230, "Height must be 120–230 cm."] : [14, 100, "Age must be 14–100."];
    bad = v != null && (v < lo || v > hi) ? what : "";
    if (!bad) setMe({ [d.k]: v == null ? null : Math.round(v) });
    return paint();
  }
  if (d.f === "over") { const v = parse(t.value), over = { ...(me().over ?? {}) }; if (v == null) delete over[d.k]; else over[d.k] = Math.round(v); setMe({ over }); return paint(); }
  if (d.f === "photo" && t.files?.[0]) {
    plate ??= fresh();
    try {
      // 768 px on the long side (the brief), JPEG; the ai function takes 400 KB, so a busy photo drops to 512.
      let url = await ctx.dataUrl(await ctx.shrink(t.files[0], 768));
      if (url.length > 380_000) url = await ctx.dataUrl(await ctx.shrink(t.files[0], 512));
      plate.photo = url; plate.error = "";
    } catch { plate.error = "Couldn’t read that photo."; }
    if (view.mode === "day") { notice = null; go("log", true); } else paint();
    return $("food-sheet").querySelector("[data-f=line]")?.focus(); // the note next: say what it is, or just Estimate
  }
  if (d.f === "code-photo" && t.files?.[0]) {
    scan ??= {}; scan.busy = true; scan.error = ""; paint();
    try {
      const code = (await zxing().then((z) => z.readBarcodes(t.files[0], RETAIL)))[0]?.text;
      scan.busy = false;
      if (!code) throw new Error("Couldn’t find a barcode in that photo. Get closer, or type the number.");
      return find(code);
    } catch (e) { scan.busy = false; scan.error = e.message.startsWith("Couldn’t") ? e.message : "Couldn’t read that photo. Type the number instead."; paint(); }
  }
}

// ---------- The barcode reader: zxing-wasm's reader build, self-hosted in vendor/ and loaded on first use. A still photo
// (<input capture>) or the typed number: no live camera, which is flaky in an iOS home-screen app (research). ----------

const RETAIL = { formats: ["EAN13", "EAN8", "UPCA", "UPCE"], tryHarder: true, maxNumberOfSymbols: 1 };
let zx = null;
function zxing() {
  zx ??= new Promise((ok, fail) => {
    const s = Object.assign(document.createElement("script"), { src: "vendor/zxing-reader.js", async: true });
    s.onload = () => { const z = globalThis.ZXingWASM; z.prepareZXingModule({ overrides: { locateFile: (f) => new URL(`vendor/${f}`, location.href).href }, fireImmediately: true }); ok(z); };
    s.onerror = () => { zx = null; fail(new Error("Couldn’t load the barcode reader. Type the number instead.")); };
    document.head.append(s);
  });
  return zx;
}

// ---------- Demo (?demo=1): no network; the same paths with canned answers ----------

function demoAsk(body) {
  const content = body.input[0].content, text = content[0].text.toLowerCase(), photo = content.length > 1;
  const it = (name, grams, kcal, protein_g, carbs_g, fat_g, fibre_g, m = {}) => ({ name, grams, kcal, protein_g, carbs_g, fat_g, fibre_g,
    ...Object.fromEntries(MICROS.map((k) => [k, m[k] ?? null])) });
  const items = photo ? [it("Grilled chicken thighs", 250, 520, 58, 0, 32, 0, { salt_g: 1.1, iron_mg: 2.5, zinc_mg: 5.2, b12_ug: 0.9, potassium_mg: 600 }),
      it("Spicy rice", 220, 330, 6, 68, 4, 1.5, { salt_g: 0.8, magnesium_mg: 25 })]
    : /oat|porridge/.test(text) ? [it("Porridge oats", 80, 300, 9, 49, 6, 7, { iron_mg: 3.2, magnesium_mg: 104, zinc_mg: 2.4 }), it("Whole milk", 300, 189, 10, 14, 11, 0, { calcium_mg: 360, b12_ug: 1.2, vitd_ug: 0.1 }),
      it("Banana", 120, 107, 1, 24, 0.4, 2.5, { potassium_mg: 430, vitc_mg: 10 })]
    : [it(text.trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 40) || "Meal", 300, 450, 25, 50, 15, 4)];
  return { output: [{ content: [{ type: "output_text", text: JSON.stringify({ items }) }] }] };
}
const demoProduct = (code) => ({ product_name: "Greek style yoghurt", brands: "Demo Dairy", serving_size: "150 g",
  nutriments: { "energy-kcal_100g": 59, proteins_100g: 10, carbohydrates_100g: 3.6, fat_100g: 0.4, salt_100g: 0.1, calcium_100g: 0.11 }, code });
function demoWorkouts(day) {
  const out = {}, p = trainProfile();
  for (let i = 1; i <= 28; i++) { const d = addDays(day, -i), t = dayType(d, p, []); if (t !== "rest") out[d] = t === "rugby" ? 850 : 420; }
  return out;
}
