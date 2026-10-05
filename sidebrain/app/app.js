// Sidebrain on the phone: review due flashcards and capture notes, on the same Supabase backend as the Mac app.
// Every review writes items.user_data and one `activity` row exactly as Sources/(C) View Study.swift does.
// Writes go through a small outbox in localStorage, so a review on a train with no signal is never lost.
import { schedule, intervalLabel, due, nextDue, examDays, todayString, daysBetween, addDays } from "./sm2.js";

// ---- Settings to fill in before publishing (web/(C) README.md) ----
const SUPABASE_URL = "https://rdwavprncthvujmckige.supabase.co";
// Public by design, the same key the Mac app ships (Sources/(C) Flavor.swift); row-level security protects every row.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkd2F2cHJuY3RodnVqbWNraWdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEwNDg2MjYsImV4cCI6MjA3NjYyNDYyNn0.eg_I1CtKu3dF98JdLB8eU4Yww1NkJXtlRVo4orapeTM";
const GOOGLE_CLIENT_ID = "327768131024-jqlmp8jeb6qtouq2b4sv8v1pigss6fa4.apps.googleusercontent.com";  // the new Google *Web* OAuth client ID (README step 1)
const VAPID_PUBLIC_KEY = "";  // the "application server key" generate-vapid-keys prints (README step 3)
const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
// ponytail: supabase-js from a pinned CDN URL, no integrity check; vendor the file into web/ if that ever matters.

const DEMO = new URLSearchParams(location.search).get("demo") === "1";
const NAMES = ["Again", "Hard", "Good", "Easy"];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// Per-device state. Demo mode keeps its own keys so it never mixes with real data.
const PREFIX = DEMO ? "sidebrain.demo." : "sidebrain.";
const load = (k, fallback) => { try { return JSON.parse(localStorage.getItem(PREFIX + k)) ?? fallback; } catch { return fallback; } };
const keep = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* private mode: the app still works, just without the offline copy */ } };

let sb = null, user = null;
let cards = [], byId = new Map(), assessments = [];
let outbox = load("outbox", []);     // [{t: "review", id, user_data, activity} | {t: "note", row}], oldest first
let captures = load("captures", []); // the last captures made on this phone
let tab = "review", loaded = false, cloud = "", syncError = "", reminders = "off", photoFile = null;
const session = { queue: [], index: 0, flipped: false, grades: [0, 0, 0, 0], day: "" };

// ---------- Start ----------

async function start() {
  navigator.serviceWorker?.register("sw.js").catch(() => {});
  navigator.storage?.persist?.().catch(() => {}); // ask Safari not to evict the offline copy and the outbox
  bind();
  if (DEMO) {
    user = { email: "Demo" };
    $("demo-note").hidden = false;
    reminders = load("reminders", false) ? "on" : "off";
    useCards(demoCards(), demoAssessments());
    return render();
  }
  const cached = load("cache", null);
  if (cached && load("user", null)) { user = load("user", null); useCards(cached.cards, cached.assessments); }
  render();
  await connect();
}

async function connect() {
  if (sb) return;
  try {
    const { createClient } = await import(SUPABASE_JS);
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } });
  } catch {
    cloud = "You're offline. Reviews are saved on this phone and sync when you're back.";
    if (!user) say("signin-status", "You're offline. Connect to sign in.", true);
    return render();
  }
  // supabase-js asks that its own calls never run inside this callback, hence the setTimeout.
  sb.auth.onAuthStateChange((event, s) => setTimeout(() => {
    if (!s?.user) { if (event === "INITIAL_SESSION" || event === "SIGNED_OUT") signedOut(); return; }
    if (event === "INITIAL_SESSION" || (event === "SIGNED_IN" && s.user.id !== user?.id)) {
      user = { id: s.user.id, email: s.user.email };
      keep("user", user);
      refresh();
    }
  }));
}

function signedOut() {
  user = null; cards = []; byId = new Map(); loaded = false;
  localStorage.removeItem(PREFIX + "user"); // the outbox stays, and syncs after the next sign-in
  render();
  showSignIn();
}

// ---------- Cards ----------

async function all(kind, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("items").select(select).eq("kind", kind).is("deleted_at", null).order("id").range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function refresh() {
  if (!sb || !user) return;
  try {
    const [c, a] = await Promise.all([all("card", "id,module,title,data,user_data"), all("assessment", "id,module,title,data,date")]);
    keep("cache", { cards: c, assessments: a });
    useCards(c, a);
    cloud = "";
  } catch (e) {
    cloud = loaded ? "Couldn't reach Sidebrain cloud. Showing the cards saved on this phone." : `Couldn't load your cards: ${e.message || "network error"}`;
  }
  render();
  flush();
  reminders = await reminderStatus();
  render();
}

/** New server data. Reviews still in the outbox win, so a card graded offline doesn't come back as due. */
function useCards(c, a) {
  const pending = new Map(outbox.filter((o) => o.t === "review").map((o) => [o.id, o.user_data]));
  cards = c.map((x) => (pending.has(x.id) ? { ...x, user_data: pending.get(x.id) } : x));
  byId = new Map(cards.map((x) => [x.id, x]));
  assessments = a;
  loaded = true;
  if (session.index === 0 || session.day !== todayString()) newSession(); // never reshuffle a session in progress
}

function newSession() {
  Object.assign(session, { queue: due(cards, todayString()).map((x) => x.id), index: 0, flipped: false, grades: [0, 0, 0, 0], day: todayString() });
}

const current = () => byId.get(session.queue[session.index]);
const examFor = (card) => examDays(assessments, card.module ?? null, todayString());

function flip() {
  if (!current() || session.flipped) return;
  session.flipped = true;
  render();
}

function grade(g) {
  const card = current();
  if (!card || !session.flipped) return;
  const today = todayString(), now = Date.now();
  const next = schedule(card.user_data ?? {}, g, examFor(card), today, now);
  card.user_data = { ...card.user_data, ...next }; // Store.setUser merges, exactly like the Mac
  outbox.push({ t: "review", id: card.id, user_data: card.user_data, activity: {
    id: crypto.randomUUID(), item_id: card.id, at: new Date(now).toISOString(), kind: "review",
    payload: { grade: g, interval: next.interval, ease: next.ease },
  } });
  keep("outbox", outbox);
  if (!DEMO) keep("cache", { cards, assessments });
  session.grades[g] += 1;
  if (g === 0) session.queue.push(card.id); // Again is due today, so it comes round once more this session
  session.index += 1; session.flipped = false;
  render();
  flush();
}

// ---------- Sync ----------

let flushing = false;
async function flush() {
  if (DEMO || !sb || !user?.id || flushing || !outbox.length) return;
  flushing = true;
  try {
    while (outbox.length) {
      const op = outbox[0];
      const results = op.t === "review"
        ? [await sb.from("items").update({ user_data: op.user_data }).eq("id", op.id),
           await sb.from("activity").upsert(op.activity, { onConflict: "id", ignoreDuplicates: true })]
        : [await sb.from("items").upsert(op.row, { onConflict: "user_id,id", ignoreDuplicates: true })];
      const bad = results.find((r) => r.error);
      if (bad) {
        // Offline, signed out or a server hiccup: keep it for later. Anything else the server refused for good.
        if (!bad.status || bad.status === 401 || bad.status >= 500) throw bad.error;
        syncError = `One change couldn't be saved: ${bad.error.message}`;
      }
      outbox.shift();
      keep("outbox", outbox);
    }
  } catch { /* stays in the outbox; retried on the next review, when back online, or when the app reopens */ }
  finally { flushing = false; render(); }
}

// ---------- Capture ----------

const titleOf = (body) => body.split("\n")[0].trim().slice(0, 80) || "Photo";

async function shrink(file, max = 1600) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn't read that photo."))), "image/jpeg", 0.82));
}

async function saveCapture(event) {
  event.preventDefault();
  const body = $("note").value.trim();
  if (!body && !photoFile) return say("capture-status", "Write something or add a photo first.", true);
  $("save").disabled = true;
  const id = "you-" + crypto.randomUUID(); // Store.addOwn's id shape
  try {
    let photo = null;
    if (photoFile) {
      const jpeg = await shrink(photoFile); // demo too, so it runs the same path
      if (DEMO) photo = "demo";
      else {
        if (!navigator.onLine) throw new Error("You're offline. Photos need a connection, so your note is still here.");
        photo = `${user.id}/${id}.jpg`;
        const { error } = await sb.storage.from("captures").upload(photo, jpeg, { contentType: "image/jpeg" });
        if (error) throw error;
      }
    }
    // ponytail: a photo can't wait in the outbox (localStorage is too small); keep it in IndexedDB if offline photos matter.
    const row = { id, kind: "quicknote", source: "you", module: null, date: null, title: titleOf(body),
                  data: photo ? { body, photo } : { body }, user_data: {}, deleted_at: null };
    outbox.push({ t: "note", row });
    keep("outbox", outbox);
    captures = [{ id, body, photo: !!photo, at: Date.now() }, ...captures].slice(0, 20);
    keep("captures", captures);
    $("note").value = "";
    setPhoto(null);
    say("capture-status", DEMO ? "Saved on this phone." : "Saved.");
    flush();
  } catch (e) {
    say("capture-status", e.message || "Couldn't save. Try again.", true);
  } finally {
    $("save").disabled = false;
    render();
  }
}

function setPhoto(file) {
  photoFile = file;
  const img = $("preview").querySelector("img");
  if (img.src) URL.revokeObjectURL(img.src);
  img.removeAttribute("src");
  if (file) img.src = URL.createObjectURL(file);
  $("preview").hidden = !file;
  $("photo-label").querySelector("span").textContent = file ? "Retake" : "Add photo";
  $("photo").value = "";
}

// ---------- Reminders (Web Push; iOS 16.4+ once added to the Home Screen) ----------

async function reminderStatus() {
  if (DEMO) return reminders;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return ios && !standalone ? "install" : "unsupported";
  if (!VAPID_PUBLIC_KEY) return "unset";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ? "on" : "off";
}

const REMINDERS = {
  off: ["Turn on reminders", "One nudge each morning with how many cards are due and your next deadline."],
  on: ["Turn off reminders", "On. Each morning you get what's due, and the app icon shows the count."],
  busy: ["Turning on…", "Allow notifications when your phone asks."],
  install: ["Turn on reminders", "Add Sidebrain to your Home Screen first (Share, then Add to Home Screen), and open it from there."],
  denied: ["Turn on reminders", "Notifications are off for Sidebrain. Turn them on in Settings, Notifications, Sidebrain."],
  unsupported: ["Turn on reminders", "This browser can't show reminders."],
  unset: ["Turn on reminders", "Reminders aren't set up yet."],
};

async function toggleReminders() {
  const was = reminders;
  try {
    if (DEMO) { reminders = was === "on" ? "off" : "on"; keep("reminders", reminders === "on"); return; }
    if (was === "on") {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) { await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
      navigator.clearAppBadge?.().catch(() => {});
    } else {
      const permission = await Notification.requestPermission(); // first await: iOS only asks inside the tap
      if (permission !== "granted") return;
      reminders = "busy"; render();
      const sub = await (await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(VAPID_PUBLIC_KEY) });
      const { endpoint, keys } = sub.toJSON();
      const { error } = await sb.from("push_subscriptions").upsert({ endpoint, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: "user_id,endpoint" });
      if (error) { await sub.unsubscribe(); throw error; }
    }
  } catch (e) {
    say("remind-detail", `Couldn't change reminders: ${e.message || "try again"}`, true);
  } finally {
    if (!DEMO) reminders = await reminderStatus();
    render();
  }
}

function fromBase64Url(s) {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ---------- Sign in (Google Identity Services, then supabase-js signInWithIdToken) ----------

let gsiReady = false;
async function showSignIn() {
  $("signin-hint").hidden = !ios || standalone;
  if (!GOOGLE_CLIENT_ID) return say("signin-status", "Sign-in isn't set up yet: the Google Web client ID goes in app.js.", true);
  $("redirect-signin").hidden = false;
  if (gsiReady) return;
  try {
    await new Promise((ok, fail) => document.head.append(Object.assign(document.createElement("script"), { src: "https://accounts.google.com/gsi/client", onload: ok, onerror: fail })));
  } catch {
    return say("signin-status", "Couldn't reach Google. Check your connection and reopen Sidebrain.", true);
  }
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const hashed = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce))), (b) => b.toString(16).padStart(2, "0")).join("");
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID, nonce: hashed, ux_mode: "popup", itp_support: true, use_fedcm_for_prompt: true,
    callback: async ({ credential }) => {
      say("signin-status", "Signing in…");
      const { error } = await sb.auth.signInWithIdToken({ provider: "google", token: credential, nonce });
      say("signin-status", error ? `Sign-in failed: ${error.message}` : "", !!error);
    },
  });
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  google.accounts.id.renderButton($("gsi"), { theme: dark ? "filled_black" : "outline", size: "large", shape: "pill", text: "signin_with", width: 280 });
  gsiReady = true;
}

// Fallback for a Home Screen app where Google's pop-up can't report back: Supabase's own redirect sign-in.
function redirectSignIn() {
  sb?.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
}

async function signOut() {
  if (DEMO) {
    for (const k of ["outbox", "captures", "reminders"]) localStorage.removeItem(PREFIX + k);
    return location.reload();
  }
  if (outbox.length && !confirm(`${plural(outbox.length, "change")} haven't synced yet and will be lost. Sign out anyway?`)) return;
  for (const k of ["outbox", "captures", "cache", "user"]) localStorage.removeItem(PREFIX + k);
  outbox = []; captures = [];
  $("sheet").close();
  navigator.clearAppBadge?.().catch(() => {});
  await sb?.auth.signOut();
  signedOut();
}

// ---------- Rendering ----------

function say(id, text, warn = false) {
  $(id).textContent = text;
  $(id).classList.toggle("warn", warn);
}

function render() {
  const signedIn = !!user;
  const today = todayString();
  const dueNow = due(cards, today).length;
  $("signin").hidden = signedIn;
  $("tabs").hidden = $("account").hidden = !signedIn;
  $("review").hidden = !signedIn || tab !== "review";
  $("capture").hidden = !signedIn || tab !== "capture";
  $("heading").textContent = !signedIn ? "Sidebrain" : tab === "review" ? "Review" : "Capture";
  $("eyebrow").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  $("due-pill").hidden = !signedIn || !loaded || tab !== "review";
  $("due-pill").textContent = `${dueNow} due`;
  $("account").textContent = (user?.email || "?")[0].toUpperCase();
  for (const b of $("tabs").querySelectorAll("button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (signedIn && loaded) navigator.setAppBadge?.(dueNow).catch(() => {});
  if (signedIn) { renderReview(today); renderCaptures(); renderSheet(); }
}

function renderReview(today) {
  const waiting = outbox.filter((o) => o.t === "review").length;
  const footer = [
    cloud && `<p class="status warn">${esc(cloud)}</p>`,
    syncError && `<p class="status warn">${esc(syncError)}</p>`,
    !DEMO && waiting && `<p class="caption">${plural(waiting, "review")} waiting to sync</p>`,
  ].filter(Boolean).join("");
  if (!loaded) { $("review").innerHTML = `<p class="status">Loading your cards…</p>${footer}`; return; }
  const card = current();
  if (!card) {
    const done = session.index > 0, next = nextDue(cards, today);
    const nextText = next ? `Next cards due ${daysBetween(today, next) === 1 ? "tomorrow" : new Date(next + "T12:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}.` : "";
    $("review").innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9.5"/></svg>
        <h2>${done ? "Session done" : "Nothing due"}</h2>
        <p class="muted">${done ? plural(session.index, "review") : "Every card is scheduled for later."}</p>
        ${done ? `<p class="caption">${NAMES.map((n, g) => `${n} ${session.grades[g]}`).join(" · ")}</p>` : ""}
        ${nextText ? `<p class="caption">${esc(nextText)}</p>` : ""}
        ${due(cards, today).length ? `<button class="quiet" data-act="again">Review ${plural(due(cards, today).length, "due card")}</button>` : ""}
        ${reminders === "off" ? `<button class="quiet" data-act="remind">Get a nudge each morning</button>` : ""}
      </div>${footer}`;
    return;
  }
  const where = [card.module, card.data?.lecture].filter(Boolean).join(" · ");
  const exam = examFor(card);
  $("review").innerHTML = `
    <div class="meta"><span>Due today</span><span>${session.index + 1} of ${session.queue.length}</span></div>
    <div class="bar"><i style="width:${(session.index / Math.max(session.queue.length, 1)) * 100}%"></i></div>
    <div class="flash" data-act="flip">
      ${where ? `<span class="where">${esc(where)}</span>` : ""}
      <h2 class="front">${esc(card.data?.front ?? card.title ?? "")}</h2>
      ${session.flipped ? `<hr><p class="back">${esc(card.data?.back ?? "")}</p>` : `<p class="hint">Say the answer out loud, then tap</p>`}
    </div>
    <div class="actions">
      ${session.flipped
        ? `<div class="grades">${NAMES.map((n, g) => `<button class="grade glass" data-grade="${g}"><b>${n}</b><span>${intervalLabel(schedule(card.user_data ?? {}, g, exam, today).interval)}</span></button>`).join("")}</div>
           <p class="keys">Keys 1 to 4 grade the card</p>`
        : `<button class="primary" data-act="flip">Show answer</button>`}
      ${footer}
    </div>`;
}

function renderCaptures() {
  const waiting = new Set(outbox.filter((o) => o.t === "note").map((o) => o.row.id));
  $("recent-label").hidden = !captures.length;
  $("recent").innerHTML = captures.slice(0, 5).map((c) => `
    <li><p class="body">${esc(c.body || "Photo")}</p>
      <p class="caption">${new Date(c.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}${c.photo ? " · Photo" : ""} · ${DEMO ? "On this phone" : waiting.has(c.id) ? "Waiting to sync" : "Saved to Sidebrain"}</p></li>`).join("");
}

function renderSheet() {
  const [label, detail] = REMINDERS[reminders] ?? REMINDERS.off;
  $("who").textContent = DEMO ? "Demo mode: sample cards, saved only on this phone." : `Signed in as ${user.email ?? "you"}`;
  $("remind").textContent = label;
  $("remind").className = reminders === "on" ? "quiet" : "primary";
  $("remind").disabled = !["on", "off"].includes(reminders);
  if (!$("remind-detail").classList.contains("warn")) say("remind-detail", DEMO ? `${detail} (Demo: nothing is sent.)` : detail);
  $("sync-detail").textContent = outbox.length ? `${plural(outbox.length, "change")} waiting to sync.` : "Everything is synced.";
  $("sync-detail").hidden = DEMO;
  $("signout").textContent = DEMO ? "Reset demo" : "Sign out";
}

// ---------- Events ----------

function bind() {
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act],[data-grade],[data-tab]");
    if (!t) return;
    if (t.dataset.grade) return grade(Number(t.dataset.grade));
    if (t.dataset.tab) { tab = t.dataset.tab; return render(); }
    if (t.dataset.act === "flip") return flip();
    if (t.dataset.act === "again") { newSession(); return render(); }
    if (t.dataset.act === "remind") return $("sheet").showModal();
  });
  document.addEventListener("keydown", (e) => {
    if (tab !== "review" || $("sheet").open || e.target.matches("textarea, input")) return;
    if (e.key === " " && !session.flipped && current()) { e.preventDefault(); flip(); }
    if (/^[1-4]$/.test(e.key)) grade(Number(e.key) - 1);
  });
  $("account").onclick = () => { say("remind-detail", ""); renderSheet(); $("sheet").showModal(); };
  $("close-sheet").onclick = () => $("sheet").close();
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) $("sheet").close(); }); // tap outside closes
  $("remind").onclick = toggleReminders;
  $("signout").onclick = signOut;
  $("redirect-signin").onclick = redirectSignIn;
  $("capture-form").onsubmit = saveCapture;
  $("photo").onchange = (e) => setPhoto(e.target.files?.[0] ?? null);
  $("remove-photo").onclick = () => setPhoto(null);
  addEventListener("online", () => { cloud = ""; sb ? (refresh()) : connect(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || DEMO) return;
    if (session.day !== todayString() && !current()) newSession();
    refresh();
  });
}

// ---------- Demo fixtures (?demo=1): sample cards, no network ----------

function demoCards() {
  const crg = "Corporate Restructuring & Governance", sm = "Strategic Management", t = todayString();
  const card = (id, module, lecture, front, back, user_data = {}) => ({ id, module, title: null, data: { front, back, lecture, origin: "Demo" }, user_data });
  return [
    card("crg-l1-1", crg, "L1", "What did Berle and Means (1932) identify?", "The separation of ownership and control: dispersed shareholders own the firm, professional managers run it.", { due: t, ease: 2.5, interval: 3, reps: 2, lapses: 0 }),
    card("crg-l1-2", crg, "L1", "State the agency problem in one sentence.", "Managers (agents) may pursue their own interests rather than those of shareholders (principals), because their actions are hard to observe."),
    card("crg-l1-3", crg, "L1", "Name two costs Jensen and Meckling (1976) say agency creates.", "Monitoring costs paid by the principal, bonding costs paid by the agent, and the residual loss that remains."),
    card("crg-l1-4", crg, "L1", "What does \"comply or explain\" mean in the UK Corporate Governance Code?", "Companies follow each provision or explain publicly why they don't; the market judges the explanation.", { due: t, ease: 2.35, interval: 1, reps: 3, lapses: 1 }),
    card("crg-l2-1", crg, "L2", "Which 1992 report started UK governance codes?", "The Cadbury Report, after the Maxwell and BCCI scandals."),
    card("sm-l1-1", sm, "L1", "What are the four VRIO questions?", "Is the resource Valuable, Rare, costly to Imitate, and is the firm Organised to capture its value? (Barney, 1991)"),
    card("sm-l1-2", sm, "L1", "Porter's five forces: name them.", "Rivalry, threat of new entrants, threat of substitutes, buyer power, supplier power."),
    card("sm-l1-3", sm, "L1", "Shareholder primacy versus stakeholder theory?", "Primacy: the firm exists to maximise shareholder value. Stakeholder theory: managers balance the claims of everyone the firm affects.", { due: addDays(t, 3), ease: 2.6, interval: 20, reps: 4, lapses: 0 }),
  ];
}
function demoAssessments() {
  return [{ id: "assess-crg-essay", module: "Corporate Restructuring & Governance", title: "Essay", data: {}, date: null },
          { id: "assess-sm-exam", module: "Strategic Management", title: "Exam", data: {}, date: "2027-01-14" }];
}

start();
