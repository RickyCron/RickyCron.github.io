// Lecture notes on the phone. A small Markdown renderer for `note` bodies (the subset uni-lectures writes, split the
// way Sources/(C) StudyModel.swift `blocks` does and drawn like MarkdownView in Sources/(C) Glass.swift), and the
// structured lecture doc in `data.doc` (docs/(C) Lecture doc format.md; Sources/(C) LectureDoc.swift and
// Sources/(C) View LectureDoc.swift). All text is HTML-escaped first; only http(s) and mailto links become links.
// Pure functions, no DOM: checked by node --test web/notes.test.mjs.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
      close(); out.push(`<p>${inline(line)}</p>`);
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
 *  `open` holds the block indexes of revealed answers, `shown` the "block:node" ids tapped open on a blank diagram. */
export function lectureDoc(json, state = {}, sections = []) {
  if (!json || typeof json !== "object" || Array.isArray(json) || (json.version ?? 1) !== 1 || !Array.isArray(json.blocks)) return null;
  const parts = json.blocks.map((b, i) => (b && typeof b === "object" ? block(b, i, state, sections) : null));
  return parts.some((p) => p != null) ? parts.join("") : null;
}

function block(b, i, state, sections) {
  const text = str(b.text), items = arr(b.items).filter((x) => typeof x === "string");
  const list = (tag) => `<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${tag}>`;
  switch (b.t) {
    case "h1": return "";
    case "h2":
      if (!text) return "";
      sections.push({ id: `sec-${i}`, title: plain(text) });
      return `<h3 class="doc-h2" id="sec-${i}">${inline(text)}</h3>`;
    case "h3": return `<h4>${inline(text)}</h4>`;
    case "p": return `<p>${inline(text)}</p>`;
    case "meta": return `<p class="caption">${inline(text)}</p>`;
    case "quote": return `<blockquote class="doc-quote"><p>${inline(text)}</p></blockquote>`;
    case "inshort": return `<div class="card inshort"><p class="strong">In short</p>${list("ul")}</div>`;
    case "bullets": return list("ul");
    case "numbers": return list("ol");
    case "sources": return `<ol class="sources">${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`;
    case "callout": {
      const tone = ["key", "warn", "note"].includes(b.tone) ? b.tone : "note";
      const html = `<div class="callout c-${tone}">${text.split("\n").filter(Boolean)
        .map((l) => (l.startsWith("• ") ? `<p class="bullet">${inline(l.slice(2))}</p>` : `<p>${inline(l)}</p>`)).join("")}</div>`;
      if (!isAnswers(text)) return html;
      return `<details class="reveal" data-fold="${i}"${state.open?.has(String(i)) ? " open" : ""}><summary>
        <span class="caption when-closed">Answers hidden until you've tried</span><span class="act"><span class="when-closed">Reveal</span><span class="when-open">Hide answers</span></span>
      </summary>${html}</details>`;
    }
    case "table": return table(arr(b.header).map((x) => String(x ?? "")), arr(b.rows).filter(Array.isArray).map((r) => r.map((x) => String(x ?? ""))));
    case "diagram": return diagram(b.diagram, str(b.caption), i, state);
    default: return null;
  }
}

const TONES = ["key", "con", "plain", "verdict"];
const tone = (t) => (TONES.includes(t) ? t : "plain");

/** A diagram as boxes in their rows (wrapping to fit), with each arrow written out under them ("A supports → B",
 *  dashed = opposing ⇢), or a timeline down the left edge. Blank "complete me" diagrams hide every box not in `keep`
 *  (and its name in the arrows) until it is tapped.
 *  ponytail: no drawn arrows; the Mac's routed graph layout is 400 lines. Port it if the written-out arrows read badly. */
function diagram(d, caption, i, state) {
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
  let body;
  if (d.type === "timeline") {
    body = `<ol class="dg-time">${events.map((e) => `<li class="tone-${tone(e.tone)}"><b>${esc(e.label)}</b><i aria-hidden="true"></i><span>${esc(e.text)}</span></li>`).join("")}</ol>`;
  } else {
    const rows = [...new Set(nodes.map((n) => n.row))].map((r) => nodes.filter((n) => n.row === r));
    const inner = (n) => `<b>${esc(n.title)}</b>${n.sub ? `<small>${esc(n.sub)}</small>` : ""}`;
    const box = (n) => !blankable(n) ? `<div class="dg-node tone-${n.tone}">${inner(n)}</div>`
      : `<button type="button" class="dg-node tone-${hidden(n) ? "blank" : n.tone}" data-dg="${i}" data-node="${esc(n.id)}" aria-pressed="${!hidden(n)}"${hidden(n) ? ` aria-label="Blank box"` : ""}>${hidden(n) ? "" : inner(n)}</button>`;
    const name = (n) => (hidden(n) ? `<span class="blank-name" aria-label="blank">?</span>` : esc(n.title));
    body = `<div class="dg-rows">${rows.map((row) => `<div class="dg-row">${row.map(box).join("")}</div>`).join("")}</div>
      ${edges.length ? `<ul class="dg-edges">${edges.map((e) => `<li${e.style === "dashed" ? ` class="against"` : ""}>${name(byId.get(e.from))} <i>${esc(e.verb)}</i> ${e.style === "dashed" ? "⇢" : "→"} ${name(byId.get(e.to))}</li>`).join("")}</ul>` : ""}`;
  }
  const blanks = nodes.filter(blankable), all = blanks.every((n) => !hidden(n));
  return `<figure class="card diagram">
    ${str(d.title) ? `<p class="strong">${esc(d.title)}</p>` : ""}${str(d.note) ? `<p class="caption">${inline(d.note)}</p>` : ""}
    ${body}${caption ? `<figcaption>${inline(caption)}</figcaption>` : ""}
    ${blanks.length ? `<div class="dg-foot"><span class="caption">Tap a box to check it</span><button type="button" class="link" data-dg-all="${i}">${all ? "Hide all" : "Reveal all"}</button></div>` : ""}
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
