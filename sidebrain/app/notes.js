// Lecture notes on the phone. A small Markdown renderer for `note` bodies (the subset uni-lectures writes, split the
// way Sources/(C) StudyModel.swift `blocks` does and drawn like MarkdownView in Sources/(C) Glass.swift), and the
// structured lecture doc in `data.doc` (docs/(C) Lecture doc format.md; Sources/(C) LectureDoc.swift and
// Sources/(C) View LectureDoc.swift). All text is HTML-escaped first; only http(s) and mailto links become links.
// Pure functions, no DOM: checked by node --test web/notes.test.mjs.
import { prep } from "./today.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** The round tick (tasks, checklists). */
export const TICK = `<svg viewBox="0 0 22 22" aria-hidden="true"><circle class="ring" cx="11" cy="11" r="10.25"/><circle class="disc" cx="11" cy="11" r="11"/><path class="check" d="M6.6 11.4l3 3 5.8-6.3" pathLength="1"/></svg>`;
const str = (x) => (typeof x === "string" ? x : "");
const arr = (x) => (Array.isArray(x) ? x : []);
const WIKI = [[/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2"], [/\[\[([^\]]+)\]\]/g, "$1"]];

/** Inline Markdown as HTML: **bold**, *italic*, `code`, [text](https://…); [[wiki|links]] show their name. */
export function inline(s) {
  const kept = [], stash = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let t = String(s ?? "").replace(/\u0000/g, "");
  for (const [re, to] of WIKI) t = t.replace(re, to);
  t = esc(t)
    .replace(/`([^`]+)`/g, (_, code) => stash(`<code>${code}</code>`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
      /^(https?:\/\/|mailto:)/i.test(url) ? stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">`) + label + stash("</a>") : label)
    .replace(/(\*\*|__)(\S|\S.*?\S)\1/g, "<strong>$2</strong>")
    .replace(/(^|[^\w*])\*(\S|\S[^*]*?\S)\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|\W)_(\S|\S[^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[i]);
}

/** Inline marks gone, for labels and the Contents list (MarkdownText.inline). Not HTML: escape it where it lands. */
export function plain(s) {
  let t = String(s ?? "");
  for (const [re, to] of [...WIKI, [/!\[([^\]]*)\]\([^)]*\)/g, "$1"], [/\[([^\]]+)\]\([^)]*\)/g, "$1"], [/\*\*|__|~~|`/g, ""],
                          [/(^|[^\w*])\*(\S|\S[^*]*?\S)\*(?![\w*])/g, "$1$2"]]) t = t.replace(re, to);
  return t;
}

/** "**Exam steer:** text" → a small caption ("Exam steer") on its own line, then the text. Labels up to 40 characters,
 *  with the colon inside or after the bold; "Check yourself" is captioned in the accent. Returns the HTML, or null. */
export function leadIn(text) {
  const m = String(text ?? "").match(/^\s*\*\*([^*\n]{1,40}?):\*\*:?\s*|^\s*\*\*([^*\n]{1,40}?)\*\*:\s*/);
  if (!m) return null;
  const label = (m[1] ?? m[2]).trim(), rest = text.slice(m[0].length);
  const body = rest.trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  return `<p class="lead-cap${/^check yourself/i.test(label) ? " accent" : ""}">${inline(label)}</p>${body ? `<p>${inline(body)}</p>` : ""}`;
}
const para = (text) => leadIn(text) ?? `<p>${inline(text)}</p>`;

/** An answers callout: "**Answers.** 1 Because… 2 Hidden…" → the label goes and numbered answers become a list. */
export function answers(text) {
  const body = String(text ?? "").replace(/^\s*(?:\*\*|_)?(?:check[- ]yourself answers|answers)[.:]?(?:\*\*|_)?[.:]?\s*/i, "").replace(/\s*\n\s*/g, " ").trim();
  const parts = body.split(/(?:^|(?<=[.?!)])\s+)(\d{1,2})[.)]?\s+(?=\S)/);
  const items = [];
  for (let i = 1; i < parts.length; i += 2) items.push([Number(parts[i]), parts[i + 1].trim()]);
  const listed = parts[0].trim() === "" && items.length >= 2 && items.every(([n], k) => n === k + 1);
  return listed ? `<ol>${items.map(([, t]) => `<li>${inline(t)}</li>`).join("")}</ol>` : `<p>${inline(body)}</p>`;
}

/** A table: a grid up to two columns; wider ones stack one row per card line, each cell after the first labelled with
 *  its column (DocTable / MarkdownView's stacked rows, which is how they read at phone width). */
export function table(header, rows) {
  const n = Math.max(header.length, ...rows.map((r) => r.length), 1), cell = (r, j) => r[j] ?? "";
  const head = header.some(Boolean) ? `<thead><tr>${Array.from({ length: n }, (_, j) => `<th>${inline(cell(header, j))}</th>`).join("")}</tr></thead>` : "";
  const body = rows.map((r) => `<tr>${Array.from({ length: n }, (_, j) => {
    const label = j > 0 && n > 2 ? plain(cell(header, j)).trim() : "";
    return `<td${label ? ` data-label="${esc(label)}"` : ""}>${inline(cell(r, j))}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="table${n > 2 ? " stack" : ""}"><table>${head}<tbody>${body}</tbody></table></div>`;
}

/** Markdown blocks as HTML. Each line is a block, as on the Mac: headings, bullets (two spaces per level), numbered
 *  items, pipe tables, quotes, rules and paragraphs. With `sections`, h2s get an id and go onto it ({id, title}) for Contents. */
export function markdown(src, sections = null) {
  const out = [];
  let open = "", rows = null; // the list or quote being built ("ul" | "ol" | "blockquote"), the table being built
  const close = () => {
    if (rows) { out.push(table(rows[0], rows.slice(1))); rows = null; }
    if (open) { out.push(`</${open}>`); open = ""; }
  };
  const start = (tag) => { if (open !== tag || rows) { close(); open = tag; out.push(`<${tag}>`); } };
  for (const raw of withoutFrontMatter(String(src ?? "")).split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if (!line) continue; // blank lines end nothing, as in StudyModel.blocks
    if (line.startsWith("|")) {
      const cells = line.replace(/^\|+|\|+$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => c && /^[-: ]+$/.test(c))) continue; // |---|---|
      if (!rows) { close(); rows = []; }
      rows.push(cells);
    } else if ((m = line.match(/^(#{1,6}) (.*)$/))) {
      close();
      const level = m[1].length, text = m[2].trim();
      const id = level === 2 && sections ? `sec-${sections.push({ id: `sec-${sections.length}`, title: plain(text) }) - 1}` : "";
      out.push(level <= 2 ? `<h3 class="md-h${level}"${id ? ` id="${id}"` : ""}>${inline(text)}</h3>` : `<h4 class="md-h3">${inline(text)}</h4>`);
    } else if ((m = raw.match(/^([ \t]*)[-*] (.*)$/))) {
      start("ul");
      const depth = Math.min(3, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
      out.push(`<li${depth ? ` class="d${depth}"` : ""}>${inline(m[2].trim())}</li>`);
    } else if ((m = line.match(/^(\d+)\. (.*)$/))) {
      start("ol");
      out.push(`<li value="${Number(m[1])}">${inline(m[2])}</li>`);
    } else if (/^([-*_]\s*){3,}$/.test(line)) {
      close(); out.push("<hr>");
    } else if (line.startsWith(">")) {
      start("blockquote");
      out.push(`<p>${inline(line.replace(/^(>\s?)+/, ""))}</p>`);
    } else {
      close(); out.push(para(line));
    }
  }
  close();
  return out.join("");
}

/** MarkdownText.body: the text without leading YAML front matter. */
function withoutFrontMatter(s) {
  if (!s.startsWith("---")) return s;
  const lines = s.split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return lines[0].trim() === "---" && end > 0 ? lines.slice(end + 1).join("\n") : s;
}

/** Quiz answer callouts ("**Answers.** …", "Check-yourself answers …") stay folded until revealed. */
export function isAnswers(callout) {
  const first = plain(String(callout ?? "").split("\n")[0]).trim().toLowerCase();
  return first.startsWith("answers") || first.startsWith("check-yourself answers") || first.startsWith("check yourself answers");
}

/** A note's `data.doc` as HTML, blocks in order, h1 skipped (the screen carries the title). Null unless it is a
 *  version-1 doc with a readable block (LectureDoc(json:)); unknown block types are skipped. `state` is the reader's:
 *  `open` holds the block indexes of revealed answers, `shown` the "block:node" ids tapped open on a blank diagram,
 *  `frames` each steps block's frame (block index → frame), `user` the note's user_data (checks, quiz, guesses),
 *  and `reask` true when opened as a re-ask. */
export function lectureDoc(json, state = {}, sections = []) {
  if (!json || typeof json !== "object" || Array.isArray(json) || (json.version ?? 1) !== 1 || !Array.isArray(json.blocks)) return null;
  const n = { quiz: 0, pre: 0 }; // quiz and guess keys count across the whole doc, as on the Mac (LectureDoc.itemStarts)
  const parts = json.blocks.map((b, i) => (b && typeof b === "object" ? block(b, i, state, sections, n) : null));
  return parts.some((p) => p != null) ? parts.join("") : null;
}

const TEXT = ["h1", "h2", "h3", "p", "meta", "quote", "callout"], LISTS = ["inshort", "bullets", "numbers", "sources"];
/** Nothing to show: blank text, no non-blank item, a table without rows (LectureDoc.Block.hasContent). Skipped like an
 *  unknown block, so a note a model padded with empty blocks reads clean. Brief blocks are never judged here. */
const empty = (b, text, items) =>
  TEXT.includes(b.t) ? !text.trim() : LISTS.includes(b.t) ? !items.some((x) => x.trim()) : b.t === "table" && !arr(b.rows).some(Array.isArray);

function block(b, i, state, sections, n) {
  const text = str(b.text), items = arr(b.items).filter((x) => typeof x === "string");
  if (empty(b, text, items)) return null;
  const list = (tag) => `<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${tag}>`;
  switch (b.t) {
    case "h1": return "";
    case "h2":
      sections.push({ id: `sec-${i}`, title: plain(text) });
      return `<h3 class="doc-h2" id="sec-${i}">${inline(text)}</h3>`;
    case "h3": return `<h4>${inline(text)}</h4>`;
    case "p": return para(text);
    case "meta": return i <= 1 ? "" : `<p class="caption">${inline(text)}</p>`; // the header line repeats the screen's own header
    case "quote": return `<figure class="doc-quote"><blockquote><p>${inline(text)}</p></blockquote>${str(b.by) ? `<figcaption>${inline(b.by)}</figcaption>` : ""}</figure>`;
    case "inshort": return `<div class="card inshort"><p class="strong">In short</p>${list("ul")}</div>`;
    case "bullets": return list("ul");
    case "numbers": return list("ol");
    case "sources": return `<ol class="sources">${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`;
    case "callout": {
      const tone = ["key", "warn", "note"].includes(b.tone) ? b.tone : "note";
      if (isAnswers(text)) return `<details class="reveal" data-fold="${i}"${state.open?.has(String(i)) ? " open" : ""}><summary>
        <span>Answers</span><span class="act"><span class="when-closed">Show</span><span class="when-open">Hide</span></span>
      </summary><div class="callout c-${tone}">${answers(text)}</div></details>`;
      const html = `<div class="callout c-${tone}">${text.split("\n").filter(Boolean)
        .map((l) => (l.startsWith("• ") ? `<p class="bullet">${inline(l.slice(2))}</p>` : para(l))).join("")}</div>`;
      return html;
    }
    case "table": return table(arr(b.header).map((x) => String(x ?? "")), arr(b.rows).filter(Array.isArray).map((r) => r.map((x) => String(x ?? ""))));
    case "diagram": return diagram(b.diagram, str(b.caption), i, state);
    case "checklist": return checklist(b, state.user ?? {});
    case "steps": return steps(b, i, state);
    case "quiz": return quiz(b, state.user ?? {}, n);
    case "marks": return marks(b);
    case "prequestions": return prequestions(b, i, state, n);
    default: return null;
  }
}

// ---------- Brief blocks (docs/(C) Brief + ping contract.md §2) ----------

const objects = (x) => arr(x).filter((o) => o && typeof o === "object");

/** A tick list with minutes; ticks are user_data.checks {id: true}. The top line counts the must-dos and the minutes left. */
function checklist(b, user) {
  const items = objects(b.items).filter((x) => typeof x.id === "string" && typeof x.text === "string");
  if (!items.length) return null;
  const checks = user.checks && typeof user.checks === "object" ? user.checks : {}, done = (x) => checks[x.id] === true;
  const must = items.filter((x) => x.must === true), left = items.filter((x) => !done(x)).reduce((s, x) => s + (Number(x.minutes) || 0), 0);
  const line = [must.length && `${must.filter(done).length} of ${must.length} must-dos done`, left ? `${prep(left)} left` : items.every(done) ? "All done" : ""].filter(Boolean).join(" · ");
  return `<div class="card checklist">${line ? `<p class="caption">${esc(line)}</p>` : ""}<ul>${items.map((x) => {
    const meta = [Number(x.minutes) > 0 && prep(Number(x.minutes)), x.must === true && "Must do"].filter(Boolean).join(" · ");
    return `<li class="cl${done(x) ? " done" : ""}"><button class="tick" type="button" data-cl="${esc(x.id)}" aria-pressed="${done(x)}" aria-label="${done(x) ? "Undo" : "Done"}: ${esc(plain(x.text))}">${TICK}</button>
      <span class="cl-text"><span>${inline(x.text)}</span>${str(x.detail) ? `<span class="foot">${inline(x.detail)}</span>` : ""}${meta ? `<span class="foot">${meta}</span>` : ""}</span></li>`;
  }).join("")}</ul></div>`;
}

/** A step-through: one frame at a time with Back and Next. A frame's `focus` nodes are highlighted and the rest dimmed;
 *  a frame's own diagram replaces the shared one. The app swaps frames in a view transition (none under Reduce Motion). */
function steps(b, i, state) {
  const frames = objects(b.frames);
  if (!frames.length) return null;
  const n = frames.length, k = Math.min(Math.max(0, Number(state.frames?.get(String(i))) || 0), n - 1), f = frames[k];
  const nav = `<p class="step-text">${inline(str(f.text))}</p><div class="step-nav">
    <button class="btn secondary small back" type="button" data-step="${i}:${k - 1}"${k === 0 ? " disabled" : ""}>Back</button>
    <span class="foot">Step ${k + 1} of ${n}</span>
    <button class="btn primary small next" type="button" data-step="${i}:${k + 1}"${k === n - 1 ? " disabled" : ""}>Next</button></div>`;
  const d = f.diagram && typeof f.diagram === "object" ? f.diagram : b.diagram;
  const title = str(b.title) || str(d?.title);
  return diagram(d && { ...d, title }, "", i, state, { focus: arr(f.focus), html: nav })
    ?? `<div class="card steps">${title ? `<p class="strong">${inline(title)}</p>` : ""}${nav}</div>`;
}

/** Tap an answer, then right or wrong plus why; choices are user_data.quiz {index: chosen}, index counted doc-wide. */
function quiz(b, user, n) {
  const qs = objects(b.items).filter((x) => typeof x.q === "string" && Array.isArray(x.options));
  if (!qs.length) return null;
  const at = n.quiz; n.quiz += qs.length;
  const all = user.quiz && typeof user.quiz === "object" ? user.quiz : {}, chosen = qs.map((_, k) => all[at + k]), picked = (k) => Number.isInteger(chosen[k]);
  const answered = qs.filter((_, k) => picked(k)).length, right = qs.filter((x, k) => picked(k) && chosen[k] === x.answer).length;
  const score = answered ? `${right} of ${answered} right${answered < qs.length ? ` · ${qs.length - answered} to go` : ""}` : `${qs.length} question${qs.length === 1 ? "" : "s"}`;
  return `<div class="card quiz"><p class="caption" aria-live="polite">${score}</p>${qs.map((x, k) => {
    const has = picked(k), ok = has && chosen[k] === x.answer;
    return `<div class="qz"><p class="strong">${inline(x.q)}</p><div class="opts">${x.options.map((o, j) => {
      const cls = has && j === x.answer ? " right" : has && j === chosen[k] ? " wrong" : "";
      return `<button class="opt${cls}" type="button" data-qz="${at + k}:${j}" aria-pressed="${has && j === chosen[k]}"${has ? " disabled" : ""}>${inline(String(o ?? ""))}</button>`;
    }).join("")}</div>${has ? `<p class="why"><span class="${ok ? "ok" : "no"}">${ok ? "Right." : "Not quite."}</span> ${inline(str(x.why))}</p>` : ""}</div>`;
  }).join("")}</div>`;
}

const AI = { ban: "AI not allowed", opt: "AI optional", gram: "Grammar checks only" };
/** Where the words and the marks go: two stacked bars coloured by the AI rule, a legend, and each part in words. */
function marks(b) {
  const rows = objects(b.rows).filter((r) => typeof r.label === "string");
  if (!rows.length) return null;
  const ai = (r) => (AI[r.ai] ? r.ai : "gram"), num = (x) => Math.max(0, Number(x) || 0);
  const total = (key) => rows.reduce((s, r) => s + num(r[key]), 0);
  const bar = (key, label) => total(key) ? `<div class="mk-bar"><span class="foot">${label}</span><div class="mk-track">${rows.map((r) =>
    num(r[key]) ? `<i class="ai-${ai(r)}" style="flex-grow:${num(r[key])}"></i>` : "").join("")}</div></div>` : "";
  const used = Object.keys(AI).filter((k) => rows.some((r) => ai(r) === k));
  return `<figure class="card marks">${str(b.title) ? `<p class="strong">${inline(b.title)}</p>` : ""}
    <div aria-hidden="true">${bar("words", "Words")}${bar("weight", "Marks")}</div>
    <ul class="mk-rows">${rows.map((r) => `<li><i class="sw ai-${ai(r)}" aria-hidden="true"></i><span>${inline(r.label)}</span>
      <span class="foot">${[num(r.words) && `${num(r.words).toLocaleString("en-GB")} words`, num(r.weight) && `${num(r.weight)}%`].filter(Boolean).join(" · ")}<span class="sr">, ${AI[ai(r)]}</span></span></li>`).join("")}</ul>
    <p class="mk-legend foot" aria-hidden="true">${used.map((k) => `<span><i class="sw ai-${k}"></i>${AI[k]}</span>`).join("")}</p></figure>`;
}

/** Questions to guess before class: a guess field each (user_data.guesses {i: text}, i doc-wide; the app fills the values,
 *  so typing survives a redraw) and no answers. Opened as a re-ask, each guess beside its answer; the answers show nowhere else. */
function prequestions(b, i, state, n) {
  const qs = objects(b.items).filter((x) => typeof x.q === "string");
  if (!qs.length) return null;
  const at = n.pre; n.pre += qs.length;
  const guesses = state.user?.guesses && typeof state.user.guesses === "object" ? state.user.guesses : {};
  const guess = (k) => (typeof guesses[at + k] === "string" ? guesses[at + k].trim() : "");
  if (state.reask) {
    return `<div class="card preq" id="preq-${i}"><p class="strong">Your guesses and the answers</p><ol>${qs.map((x, k) => `<li><p>${inline(x.q)}</p>
      <p class="foot">${guess(k) ? `You guessed: ${esc(guess(k))}` : "No guess"}</p><p class="answer">${inline(str(x.answer))}</p></li>`).join("")}</ol></div>`;
  }
  return `<div class="card preq" id="preq-${i}"><p class="strong">Guess first</p><p class="caption">A guess for each, even a wild one. The class answers them.</p><ol>${qs.map((x, k) =>
    `<li><label><span>${inline(x.q)}</span><input class="guess" type="text" data-guess="${at + k}" placeholder="Your guess" enterkeyhint="done" autocomplete="off"></label></li>`).join("")}</ol></div>`;
}

const TONES = ["key", "con", "plain", "verdict"];
const tone = (t) => (TONES.includes(t) ? t : "plain");

/** A diagram as boxes in their rows (wrapping to fit), with each arrow written out under them ("A supports → B",
 *  dashed = opposing ⇢), or a timeline down the left edge. Blank "complete me" diagrams hide every box not in `keep`
 *  (and its name in the arrows) until it is tapped.
 *  ponytail: no drawn arrows; the Mac's routed graph layout is 400 lines. Port it if the written-out arrows read badly. */
function diagram(d, caption, i, state, step = null) {
  if (!d || typeof d !== "object" || (d.type !== "graph" && d.type !== "timeline")) return null;
  const raw = arr(d.nodes).filter((n) => n && typeof n === "object");
  // Rows: explicit `row`, else the old x/y layouts clustered (same y within 40 = same row, then by x).
  const levels = [];
  for (const y of raw.map((n) => n.y).filter(Number.isFinite).sort((a, b) => a - b)) if (!levels.length || y - levels.at(-1) > 40) levels.push(y);
  const nodes = raw.map((n, k) => typeof n.id !== "string" ? null : {
    id: n.id, title: str(n.title), sub: str(n.sub), tone: tone(n.tone), k, x: Number.isFinite(n.x) ? n.x : k,
    row: Number.isFinite(n.row) ? Math.trunc(n.row) : Number.isFinite(n.y) ? Math.max(0, levels.findLastIndex((l) => l <= n.y)) : 0,
  }).filter(Boolean).sort((a, b) => a.row - b.row || a.x - b.x || a.k - b.k);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = arr(d.edges).filter((e) => e && byId.has(e.from) && byId.has(e.to));
  const events = arr(d.events).filter((e) => e && typeof e === "object");
  if (d.type === "graph" ? !nodes.length : !events.length) return null;

  const keep = arr(d.keep), blank = d.blank === true && d.type === "graph";
  const blankable = (n) => blank && !keep.includes(n.id);
  const hidden = (n) => blankable(n) && !state.shown?.has(`${i}:${n.id}`);
  // A step's focus: its nodes highlighted, the rest dimmed.
  const lit = (id) => (!step?.focus.length ? "" : step.focus.includes(id) ? " focus" : " dim");
  let body;
  if (d.type === "timeline") {
    body = `<ol class="dg-time">${events.map((e) => `<li class="tone-${tone(e.tone)}${lit(e.id ?? e.label)}"><b>${esc(e.label)}</b><i aria-hidden="true"></i><span>${esc(e.text)}</span></li>`).join("")}</ol>`;
  } else {
    const rows = [...new Set(nodes.map((n) => n.row))].map((r) => nodes.filter((n) => n.row === r));
    // An argument map (any key, con or verdict box) reads by its captions: Claim, For, Against, Verdict. A plain flow keeps its arrows.
    const argument = nodes.some((n) => n.tone !== "plain");
    const role = (n) => (n.tone === "key" ? "For" : n.tone === "con" ? "Against" : n.tone === "verdict" ? "Verdict" : n.row === nodes[0].row ? "Claim" : "");
    const inner = (n) => `<b>${esc(n.title)}</b>${n.sub ? `<small>${esc(n.sub)}</small>` : ""}`;
    const box = (n) => !blankable(n) ? `<div class="dg-node tone-${n.tone}${lit(n.id)}">${inner(n)}</div>`
      : `<button type="button" class="dg-node tone-${hidden(n) ? "blank" : n.tone}" data-dg="${i}" data-node="${esc(n.id)}" aria-pressed="${!hidden(n)}"${hidden(n) ? ` aria-label="Blank box"` : ""}>${hidden(n) ? "" : inner(n)}</button>`;
    const name = (n) => (hidden(n) ? `<span class="blank-name" aria-label="blank">?</span>` : esc(n.title));
    const groups = argument ? rows.flatMap((row) => [...new Set(row.map(role))].map((r) => [r, row.filter((n) => role(n) === r)])) : rows.map((row) => ["", row]);
    body = `<div class="dg-rows">${groups.map(([r, row]) => `<div class="dg-group">${r ? `<p class="dg-cap">${r}</p>` : ""}<div class="dg-row">${row.map(box).join("")}</div></div>`).join("")}</div>
      ${edges.length && !argument ? `<ul class="dg-edges">${edges.map((e) => `<li${e.style === "dashed" ? ` class="against"` : ""}>${name(byId.get(e.from))} <i>${esc(e.verb)}</i> ${e.style === "dashed" ? "⇢" : "→"} ${name(byId.get(e.to))}</li>`).join("")}</ul>` : ""}`;
  }
  const blanks = nodes.filter(blankable), all = blanks.every((n) => !hidden(n));
  return `<figure class="card diagram${step ? " steps" : ""}">
    ${str(d.title) ? `<p class="strong">${esc(d.title)}</p>` : ""}${str(d.note) && d.type !== "graph" ? `<p class="caption">${inline(d.note)}</p>` : ""}
    ${blank && caption ? `<figcaption class="above">${leadIn(caption) ?? inline(caption)}</figcaption>` : ""}${body}${caption && !blank ? `<figcaption>${leadIn(caption) ?? inline(caption)}</figcaption>` : ""}
    ${blanks.length ? `<div class="dg-foot"><button type="button" class="link" data-dg-all="${i}">${all ? "Hide all" : "Show all"}</button></div>` : ""}${step?.html ?? ""}
  </figure>`;
}

// ---------- Which notes belong to a lecture (Sources/(C) View Study.swift LectureReader) ----------

/** A lecture's primer and full notes: data.pre and data.post, else the notes built in the app (user_data.builtPost). */
export function lectureNotes(lecture, byId) {
  const get = (id) => (typeof id === "string" && byId.get(id)) || null;
  return { pre: get(lecture.data?.pre), post: get(lecture.data?.post) ?? get(lecture.user_data?.builtPost) };
}

/** "L2" → 2, "S10" → 10. */
const number = (n) => Number(String(n ?? "").replace(/\D/g, "")) || 0;
/** Newest first: higher lecture number, then later date (StudyModel.ordered). */
export const ordered = (lectures) => [...lectures].sort((a, b) =>
  number(b.data?.n) - number(a.data?.n) || ((b.date ?? "") > (a.date ?? "") ? 1 : (b.date ?? "") < (a.date ?? "") ? -1 : 0));
/** A lecture's own day, null when it is only the day its slides went up (data.dated "posted"), so that day is never shown
 *  or taken for the next lecture (StudyModel.lectureDay). */
export const lectureDay = (l) => (l?.data?.dated === "posted" ? null : l?.date ?? null);
