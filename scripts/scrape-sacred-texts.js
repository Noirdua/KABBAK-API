"use strict";

// Scrape the Sacred Texts archive (the offline "Sacred Texts 7" CD tree) into
// canonical `structured-text-source` JSON documents that the API text library
// can serve.
//
// The archive is a plain-HTML mirror: every book lives in its own folder with an
// `index.htm` whose anchors are the chapter list, and every chapter page carries
// a navigation header plus a copyright/attribution footer around the prose.
//
//   node scripts/scrape-sacred-texts.js --root "<Sacred Texts 7>"
//   node scripts/scrape-sacred-texts.js --root "<...>" --category tarot --limit 5
//   node scripts/scrape-sacred-texts.js --root "<...>" --install
//
// Output defaults to imports/text/_scraped (gitignored). Pass --install to copy
// the finished documents into source/data/text and refresh library.json.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(REPO_ROOT, "imports", "text", "_scraped");

// Directory listings are re-read constantly while resolving links; keep them so
// the Polyglot-style folders (tens of thousands of files) stay fast.
const directoryCache = new Map();

// Category folder -> tradition label shown in the reader. Mirrors the archive's
// top-level navigation. Unlisted folders fall back to a title-cased folder name.
const CATEGORY_TRADITIONS = {
  afr: "African",
  alc: "Alchemy",
  ame: "Americana",
  ane: "Ancient Near East",
  aor: "Age of Reason",
  asia: "Asia",
  astro: "Astrology",
  atl: "Atlantis",
  aus: "Australia",
  bhi: "Baha'i",
  bib: "Bible",
  bud: "Buddhism",
  cat: "Catalog",
  cfu: "Confucianism",
  chr: "Christianity",
  cla: "Classics",
  dna: "Science",
  earth: "Earth Mysteries",
  egy: "Egyptian",
  eso: "Esoteric/Occult",
  etc: "Miscellaneous",
  evil: "Demonology",
  fort: "Fortean",
  gno: "Gnosticism",
  goth: "Gothic",
  grim: "Grimoires",
  hin: "Hinduism",
  ich: "I Ching",
  isl: "Islam",
  jai: "Jainism",
  journals: "Journals",
  jud: "Judaism",
  lgbt: "LGBT",
  mas: "Freemasonry",
  mor: "Mormonism",
  nam: "Native American",
  nec: "Necronomicon",
  nel: "Paleolithic",
  neu: "Legends/Sagas",
  news: "News",
  nos: "Nostradamus",
  nth: "New Thought",
  oah: "Oahspe",
  oto: "Thelema",
  pac: "Pacific",
  pag: "Neopaganism/Wicca",
  phi: "Philosophy",
  piri: "Piri Re'is Map",
  pro: "Prophecy",
  ring: "Legends/Sagas",
  rss: "Journals",
  sbe: "Sacred Books of the East",
  sex: "Sacred Sexuality",
  sha: "Shamanism",
  shi: "Shinto",
  skh: "Sikhism",
  sks: "Shakespeare",
  sro: "Sub Rosa",
  swd: "Swedenborg",
  tantra: "Tantra",
  tao: "Taoism",
  tarot: "Tarot",
  the: "Theosophy",
  time: "Time",
  ufo: "UFO",
  utopia: "Utopia",
  wmn: "Women's Mysteries",
  zor: "Zoroastrianism"
};

// Asset/catalog folders that never hold a readable text.
const DEFAULT_EXCLUDE = new Set(["css", "img", "src", "cat", "rss"]);

const GENERIC_CHAPTER_TITLES = /^(start reading|read|read this|read now|continue|go|begin|title page|table of contents|contents)$/i;
const WEAK_CHAPTER_TITLES = /^(start reading|read|read this|read now|continue|go|begin)$/i;
const PAGE_MARKER = /^[[({]?\s*(?:p|pp|page)\.?\s*(?:\d+|[ivxlcdm]+)(?:\s*[-–]\s*(?:\d+|[ivxlcdm]+))?\s*[\])}]?\.?$/i;
const ATTRIBUTION_HINTS = [
  "sacred-texts.com",
  "sacred texts archive",
  "notice of attribution",
  "scanned at",
  "this text is in the public domain",
  "these files may be used for any non-commercial",
  "copyright"
];

// HTML4-era named entities are pervasive in the archive; numeric forms are
// handled separately. Only the entries the archive actually uses are listed,
// plus the common punctuation set.
const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", shy: "",
  iexcl: "¡", cent: "¢", pound: "£", curren: "¤", yen: "¥", brvbar: "¦",
  sect: "§", uml: "¨", copy: "©", ordf: "ª", laquo: "«", not: "¬", reg: "®",
  macr: "¯", deg: "°", plusmn: "±", sup2: "²", sup3: "³", acute: "´",
  micro: "µ", para: "¶", middot: "·", cedil: "¸", sup1: "¹", ordm: "º",
  raquo: "»", frac14: "¼", frac12: "½", frac34: "¾", iquest: "¿",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å",
  AElig: "Æ", Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ",
  Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", times: "×",
  Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý",
  THORN: "Þ", szlig: "ß", agrave: "à", aacute: "á", acirc: "â", atilde: "ã",
  auml: "ä", aring: "å", aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é",
  ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ",
  ouml: "ö", divide: "÷", oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û",
  uuml: "ü", yacute: "ý", thorn: "þ", yuml: "ÿ",
  OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ",
  circ: "ˆ", tilde: "˜",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", lrm: "", rlm: "",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“",
  rdquo: "”", bdquo: "„", dagger: "†", Dagger: "‡", bull: "•", hellip: "…",
  permil: "‰", prime: "′", Prime: "″", lsaquo: "‹", rsaquo: "›", oline: "‾",
  frasl: "⁄", euro: "€", trade: "™", larr: "←", uarr: "↑", rarr: "→",
  darr: "↓", harr: "↔", crarr: "↵", times_: "×", infin: "∞", ne: "≠",
  le: "≤", ge: "≥", minus: "−", lowast: "∗", radic: "√", prop: "∝",
  asymp: "≈", equiv: "≡", sum: "∑", prod: "∏", part: "∂", int: "∫",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
  nu: "ν", xi: "ξ", omicron: "ο", pi: "π", rho: "ρ", sigma: "σ",
  sigmaf: "ς", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ",
  omega: "ω", Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Epsilon: "Ε",
  Zeta: "Ζ", Eta: "Η", Theta: "Θ", Iota: "Ι", Kappa: "Κ", Lambda: "Λ",
  Mu: "Μ", Nu: "Ν", Xi: "Ξ", Omicron: "Ο", Pi: "Π", Rho: "Ρ", Sigma: "Σ",
  Tau: "Τ", Upsilon: "Υ", Phi: "Φ", Chi: "Χ", Psi: "Ψ", Omega: "Ω",
  spades: "♠", clubs: "♣", hearts: "♥", diams: "♦", loz: "◊", oplus: "⊕",
  otimes: "⊗", perp: "⊥", sdot: "⋅", lceil: "⌈", rceil: "⌉", lfloor: "⌊",
  rfloor: "⌋", lang: "〈", rang: "〉"
};

function decodeEntities(value) {
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const decoded = NAMED_ENTITIES[body];
    return decoded === undefined ? match : decoded;
  });
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripInlineTags(value) {
  return value.replace(/<[^>]*>/g, " ");
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "text";
}

function titleCase(value) {
  return String(value || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function listDirectory(dir) {
  const key = path.resolve(dir).toLowerCase();
  if (directoryCache.has(key)) {
    return directoryCache.get(key);
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  directoryCache.set(key, entries);
  return entries;
}

function findIndexFile(dir) {
  const wanted = new Set(["index.htm", "index.html", "index.shtml"]);
  const entry = listDirectory(dir).find((candidate) => candidate.isFile() && wanted.has(candidate.name.toLowerCase()));
  return entry ? path.join(dir, entry.name) : null;
}

// Resolve an href against a directory, tolerating mixed-case file names and
// dropping fragments/queries. Only paths inside `dir` are returned.
function resolveLocalFile(dir, href) {
  let clean = decodeEntities(String(href || "").trim());
  clean = clean.split("#")[0].split("?")[0].replace(/\\/g, "/");
  if (!clean || /^(?:[a-z]+:)?\/\//i.test(clean) || clean.startsWith("#")) {
    return null;
  }
  const candidate = path.resolve(dir, clean);
  const dirResolved = path.resolve(dir);
  if (candidate !== dirResolved && !candidate.startsWith(dirResolved + path.sep)) {
    return null;
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  const targetDir = path.dirname(candidate);
  const targetName = path.basename(candidate).toLowerCase();
  const match = listDirectory(targetDir).find((entry) => entry.isFile() && entry.name.toLowerCase() === targetName);
  return match ? path.join(targetDir, match.name) : null;
}

function collectAnchors(html) {
  const anchors = [];
  const re = /<a\s+[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    anchors.push({ href: match[1], text: normalizeWhitespace(decodeEntities(stripInlineTags(match[2]))) });
  }
  return anchors;
}

function extractHeading(html, tagNames) {
  for (const tag of tagNames) {
    const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match) {
      const text = normalizeWhitespace(decodeEntities(stripInlineTags(match[1])));
      if (text) return text;
    }
  }
  return "";
}

function extractTitleTag(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeWhitespace(decodeEntities(stripInlineTags(match[1]))) : "";
}

// Build the ordered chapter list for a book folder from its index anchors.
// Later, more descriptive labels win over generic ones ("Start Reading").
function collectChapters(dir, html, excludeFiles) {
  const excluded = new Set([...excludeFiles].map((file) => path.resolve(file).toLowerCase()));
  const titleRank = (label) => {
    if (!label) return -1;
    if (WEAK_CHAPTER_TITLES.test(label)) return 0;
    if (GENERIC_CHAPTER_TITLES.test(label)) return 1;
    return 2;
  };

  const chapters = [];
  const byFile = new Map();
  for (const anchor of collectAnchors(html)) {
    if (!/\.html?$/i.test(anchor.href.split("#")[0].split("?")[0])) continue;
    const target = resolveLocalFile(dir, anchor.href);
    if (!target || path.dirname(target) !== path.resolve(dir)) continue;
    const key = target.toLowerCase();
    if (excluded.has(key)) continue;
    const label = anchor.text;
    if (!byFile.has(key)) {
      const chapter = { file: target, title: label };
      byFile.set(key, chapter);
      chapters.push(chapter);
    } else if (titleRank(label) > titleRank(byFile.get(key).title)) {
      byFile.get(key).title = label;
    }
  }
  return chapters;
}

function sameDirectoryLinks(dir, html) {
  const links = [];
  for (const anchor of collectAnchors(html)) {
    if (!/\.html?$/i.test(anchor.href.split("#")[0].split("?")[0])) continue;
    const target = resolveLocalFile(dir, anchor.href);
    if (target && path.dirname(target) === path.resolve(dir)) links.push(target);
  }
  return links;
}

// Some books nest their table of contents: the folder index links to a cover
// page, which in turn links to the real chapters. Treat a page as such a cover
// when it is almost all links and almost no prose.
function looksLikeIndexPage(dir, html) {
  const body = extractBody(html);
  const links = sameDirectoryLinks(dir, body);
  if (links.length < 3) return false;
  const withoutAnchors = body.replace(/<a\b[\s\S]*?<\/a>/gi, " ");
  const proseLength = extractBlocks(withoutAnchors).reduce((sum, block) => sum + block.text.length, 0);
  return proseLength < Math.max(200, links.length * 25);
}

function expandIndexChapters(dir, chapters, depth, maxChapters, bookIndexFile, seen) {
  if (depth > 3) return chapters;
  const expanded = [];
  const visited = seen || new Set([path.resolve(bookIndexFile).toLowerCase()]);
  for (const chapter of chapters) {
    const key = path.resolve(chapter.file).toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    if (maxChapters > 0 && visited.size > maxChapters) return null;
    let html;
    try {
      html = readFile(chapter.file);
    } catch {
      continue;
    }
    if (looksLikeIndexPage(dir, html)) {
      const nested = collectChapters(dir, html, [bookIndexFile, chapter.file]);
      if (nested.length >= 2) {
        const sub = expandIndexChapters(dir, nested, depth + 1, maxChapters, bookIndexFile, visited);
        if (!sub) return null;
        expanded.push(...sub);
        continue;
      }
    }
    expanded.push(chapter);
  }
  return expanded;
}

// Cut the page down to its readable middle: drop the nav header (before the
// first <hr>) and the attribution/next-page footer (from the last <hr>).
function extractBody(html) {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : html;
  body = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Header: navigation sits before the first content rule. Treat that rule as
  // the boundary only when what precedes it is link text, not prose.
  const firstHr = body.search(/<hr\b/i);
  const beforeHr = body.slice(0, firstHr >= 0 ? firstHr : 0);
  const navText = normalizeWhitespace(decodeEntities(beforeHr.replace(/<a\b[\s\S]*?<\/a>/gi, " ").replace(/<[^>]+>/g, " ")));
  if (firstHr >= 0 && navText.length < 120) {
    body = handTrim(body.slice(body.indexOf(">", firstHr) + 1));
  } else {
    body = body.replace(/^\s*(?:<!--[\s\S]*?-->\s*)*<center\b[^>]*>[\s\S]*?<\/center\s*>/i, "");
  }

  // A page's footer separator is the last <hr> whose tail reads like navigation
  // or an attribution notice. Interior rules (e.g. on nested table-of-contents
  // pages) are followed by real content and must not truncate the page.
  let searchFrom = body.length;
  while (searchFrom > 0) {
    const index = body.toLowerCase().lastIndexOf("<hr", searchFrom - 1);
    if (index < 0) break;
    if (isFooterSeparator(body, index)) {
      body = body.slice(0, index);
      break;
    }
    searchFrom = index;
  }
  return body;
}

function isFooterSeparator(body, hrIndex) {
  const tail = normalizeWhitespace(decodeEntities(stripInlineTags(body.slice(hrIndex)))).toLowerCase();
  if (!tail || tail.length > 600) return false;
  if (/(next|previous|prev|start reading|back to|return to|up to|table of contents|sacred-?texts)/.test(tail)) {
    return true;
  }
  return ATTRIBUTION_HINTS.some((hint) => tail.includes(hint));
}

// Remove a leading run of navigation centers that precede any prose.
function handTrim(body) {
  let result = body;
  for (let guard = 0; guard < 3; guard++) {
    const match = result.match(/^\s*<center\b[^>]*>([\s\S]*?)<\/center\s*>/i);
    if (!match) break;
    if (!/href\s*=/i.test(match[1])) break;
    result = result.slice(match[0].length);
  }
  return result;
}

// Convert the remaining HTML into typed text blocks. `<p>`-style tags delimit
// blocks, headings are flagged (for section splits), table cells become columns
// and `<br>` becomes a line break.
function extractBlocks(html) {
  // Preformatted text keeps its meaning in blank-line-separated paragraphs;
  // turn those into block breaks before the tag pass removes the <pre> wrapper.
  const source = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (match, inner) => {
    const normalized = String(inner).replace(/\r\n?/g, "\n");
    return `\n~blk~ ${normalized.replace(/\n[ \t]*\n+/g, " ~blk~ ").replace(/\n/g, " ~nl~ ")} ~blk~ `;
  })
    .replace(/<\/t[dh]>/gi, " ~cell~ ")
    .replace(/<br\s*\/?>/gi, " ~nl~ ")
    .replace(/<\s*(\/?)\s*(p|div|h[1-6]|pre|blockquote|ul|ol|li|dl|dt|dd|tr|table|center|hr|address|section|article)\b[^>]*>/gi, (match, close, tag) => {
      const name = tag.toLowerCase();
      if (name === "hr") return " ~blk~ ";
      if (/^h[1-3]$/.test(name) && !close) return " ~head~ ";
      return " ~blk~ ";
    })
    .replace(/<[^>]+>/g, " ");

  const blocks = [];
  const tokenRe = /~(blk|head|nl|cell)~/g;
  let current = { heading: false, text: "" };
  let cursor = 0;
  let match;

  const flush = () => {
    const text = cleanInline(current.text);
    if (text) blocks.push({ heading: current.heading, text });
    current = { heading: false, text: "" };
  };

  while ((match = tokenRe.exec(source))) {
    current.text += source.slice(cursor, match.index);
    cursor = tokenRe.lastIndex;
    const kind = match[1];
    if (kind === "blk") flush();
    else if (kind === "head") { flush(); current.heading = true; }
    else if (kind === "nl") current.text += "\n";
    else if (kind === "cell") current.text += " | ";
  }
  current.text += source.slice(cursor);
  flush();

  return blocks.filter((block) => !shouldDropBlock(block.text));
}

function cleanInline(value) {
  const decoded = decodeEntities(stripInlineTags(value));
  return decoded.replace(/\s+/g, " ").trim();
}

const NAV_BLOCK = /^(?:index|contents|table of contents|previous|prev|next|home|up|main|sacred texts|start|start reading|read|title page)$/i;
const STRONG_ATTRIBUTION = /notice of attribution|scanned at sacred|sacred-texts\.com|these files may be used|this text is in the public domain/i;

function shouldDropBlock(text) {
  if (!text) return true;
  if (PAGE_MARKER.test(text)) return true;
  if (NAV_BLOCK.test(text)) return true;
  if (/^[\s\-–—_*·•.|]+$/.test(text)) return true;
  if (/^(?:next|previous|prev|up|index|start reading|back)\s*:/i.test(text)) return true;
  const lower = text.toLowerCase();
  if (STRONG_ATTRIBUTION.test(lower)) return true;
  if (text.length < 400 && ATTRIBUTION_HINTS.some((hint) => lower.includes(hint))) return true;
  if (/^url:\s*https?:/i.test(text)) return true;
  return false;
}

function buildVerse(number, reference, text) {
  return { id: String(number), number, reference, text };
}

function buildSection(number, label, verses) {
  if (!verses.length) return null;
  return {
    id: String(number),
    number,
    label,
    title: label,
    verseCount: verses.length,
    verses
  };
}

// Spread a chapter page's blocks into sections. Multi-page books use the index
// title for the whole page; single-page books split on their internal headings.
function sectionizeChapter(blocks, chapterTitle, splitOnHeadings, workTitle) {
  const sections = [];
  let currentLabel = chapterTitle;
  let currentVerses = [];

  const commit = () => {
    if (currentVerses.length) {
      sections.push({ label: currentLabel, verses: currentVerses });
      currentVerses = [];
    }
  };

  const sameAsWorkTitle = (text) => {
    const normalized = normalizeWhitespace(text).toLowerCase();
    const work = normalizeWhitespace(workTitle).toLowerCase();
    return Boolean(work) && (normalized === work || normalized.startsWith(`${work} `) || work.startsWith(`${normalized} `));
  };

  if (!splitOnHeadings) {
    // The index already names the chapter, so drop the repeated book-title
    // heading the archive prints at the top of every page.
    const firstContent = blocks.findIndex((block) => !block.heading);
    const relevant = firstContent < 0 ? [] : blocks.slice(firstContent);
    for (const block of relevant) {
      currentVerses.push(block.text);
    }
    commit();
    return sections;
  }

  for (const block of blocks) {
    if (block.heading) {
      if (!sections.length && !currentVerses.length && sameAsWorkTitle(block.text)) {
        continue;
      }
      commit();
      currentLabel = block.text;
      continue;
    }
    currentVerses.push(block.text);
  }
  commit();
  return sections;
}

function buildWork(book, chapters, parsed) {
  const workTitle = book.title || titleCase(path.basename(book.dir));
  const sections = [];
  const splitOnHeadings = chapters.length <= 1;

  for (const chapter of parsed) {
    const groups = sectionizeChapter(chapter.blocks, chapter.title || workTitle, splitOnHeadings, workTitle);
    for (const group of groups) {
      sections.push(group);
    }
  }

  const sectionRecords = sections
    .map((group, index) => {
      const number = index + 1;
      const label = normalizeWhitespace(group.label) || `Section ${number}`;
      const verses = group.verses
        .map((text, verseIndex) => buildVerse(verseIndex + 1, `${label}:${verseIndex + 1}`, text))
        .filter((verse) => verse.text);
      return buildSection(number, label, verses);
    })
    .filter(Boolean);

  if (!sectionRecords.length) {
    return null;
  }

  const verseCount = sectionRecords.reduce((sum, section) => sum + section.verseCount, 0);
  return {
    id: slugify(workTitle),
    title: workTitle,
    shortTitle: workTitle,
    order: 1,
    sectionCount: sectionRecords.length,
    verseCount,
    sections: sectionRecords
  };
}

function buildCanonicalDocument(title, works, metadata) {
  const list = (Array.isArray(works) ? works : [works]).filter(Boolean);
  const documentTitle = normalizeWhitespace(title) || list[0]?.title || "Untitled";
  return {
    schemaVersion: 1,
    type: "structured-text-source",
    title: documentTitle,
    shortTitle: documentTitle,
    metadata: {
      ...metadata,
      source: "Sacred Texts Archive",
      workLabel: "Book",
      sectionLabel: "Chapter",
      verseLabel: "Verse"
    },
    works: list
  };
}

// ---- discovery ----

function walkDirectories(root) {
  const dirs = [root];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of listDirectory(dir)) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      dirs.push(full);
      stack.push(full);
    }
  }
  return dirs;
}

function categoryFor(root, dir) {
  const rel = path.relative(root, dir);
  return rel ? rel.split(path.sep)[0] : "";
}

function isExcluded(root, dir, exclude) {
  if (path.resolve(dir) === path.resolve(root)) return true;
  const rel = path.relative(root, dir).split(path.sep);
  return rel.some((part) => exclude.has(part.toLowerCase()));
}

function cleanWorkTitle(raw) {
  return normalizeWhitespace(decodeEntities(stripInlineTags(raw)))
    .replace(/^sacred\s*texts?\s*[:\-–]\s*/i, "")
    .replace(/\s+(?:index|contents|title page)$/i, "")
    .replace(/\s+at\s+sacred-?texts\.com.*$/i, "");
}

function countHtmlFiles(dir) {
  return listDirectory(dir).filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name)).length;
}

function parseBook(root, dir, indexFile, options) {
  if (options.maxChapters > 0 && countHtmlFiles(dir) > options.maxChapters) {
    return { oversize: true };
  }
  const indexHtml = readFile(indexFile);
  const chapters = expandIndexChapters(dir, collectChapters(dir, indexHtml, [indexFile]), 0, options.maxChapters, indexFile);
  if (chapters === null) {
    return { oversize: true };
  }
  if (!chapters.length) return null;

  const h1 = cleanWorkTitle(extractHeading(indexHtml, ["h1"]));
  const h2 = extractHeading(indexHtml, ["h2"]);
  const titleTag = cleanWorkTitle(extractTitleTag(indexHtml));
  const workTitle = h1 || (h2 && !/^by\s+/i.test(h2) ? h2 : "") || titleTag || titleCase(path.basename(dir));
  const author = normalizeWhitespace(/^by\s+/i.test(h2) ? h2.replace(/^by\s+/i, "") : "");
  const yearMatch = indexHtml.match(/\[\s*(\d{3,4}(?:\s*[-–]\s*\d{3,4})?)\s*\]/);

  const parsed = [];
  for (const chapter of chapters) {
    let html;
    try {
      html = readFile(chapter.file);
    } catch {
      continue;
    }
    const blocks = extractBlocks(extractBody(html));
    if (!blocks.length) continue;
    const title = chapter.title || extractHeading(html, ["h1", "h2", "h3"]) || extractTitleTag(html);
    parsed.push({ title: normalizeWhitespace(title), blocks });
  }

  if (!parsed.length) return null;

  const book = {
    dir,
    rel: path.relative(root, dir),
    title: workTitle
  };
  const work = buildWork(book, chapters, parsed);
  if (!work) return null;

  const category = categoryFor(root, dir);
  const metadata = {
    tradition: CATEGORY_TRADITIONS[category] || titleCase(category),
    language: "English",
    script: "Latin",
    ...(author ? { author } : {}),
    ...(yearMatch ? { year: yearMatch[1].replace(/\s+/g, "") } : {}),
    sourcePath: book.rel.split(path.sep).join("/")
  };

  return {
    category,
    document: buildCanonicalDocument(work.title, [work], metadata),
    stats: { sections: work.sectionCount, verses: work.verseCount }
  };
}

// Raw .txt books (most of Philosophy) have no HTML at all. Treat each text file
// in the folder as a chapter and split it into blank-line paragraphs.
function collectTextFiles(dir) {
  return listDirectory(dir)
    .filter((entry) => entry.isFile() && /\.txt$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function parsePlainTextBlocks(raw) {
  return String(raw)
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((chunk) => cleanInline(chunk))
    .filter((text) => text && !shouldDropBlock(text))
    .map((text) => ({ heading: false, text }));
}

function isBoilerplateLine(line) {
  const lower = line.toLowerCase();
  return /^\[[^\]]*\]$/.test(line)
    || /^\d{3,4}(?:\s*(?:ad|bc))?$/.test(lower)
    || /^(?:project gutenberg|ebook|release date|language|character set|encoding|copyright|produced by|transcribed|updated|most recently|credits?|contents)\b/.test(lower)
    || /^\*+/.test(line)
    || /^by\s+/i.test(line)
    || /gutenberg\.org|etext/i.test(line)
    || /^\S+\.(?:txt|html?)$/i.test(line);
}

function textChapterTitle(raw, file) {
  const lines = String(raw)
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .slice(0, 40);

  for (const line of lines) {
    if (/^title:\s*\S/i.test(line)) {
      return normalizeWhitespace(line.replace(/^title:\s*/i, "")).slice(0, 160);
    }
    if (isBoilerplateLine(line)) continue;
    const words = line.split(/\s+/).length;
    if (line.length >= 4 && line.length <= 160 && !/[.!?;:,]$/.test(line) && (words >= 2 || /^[A-Z][A-Z\s'’-]{3,}$/.test(line))) {
      return line;
    }
  }
  return titleCase(path.basename(file).replace(/\.txt$/i, ""));
}

function parseTextBook(root, dir, options) {
  const files = collectTextFiles(dir);
  if (!files.length) return null;

  const works = [];
  for (const file of files) {
    if (options.maxChapters > 0 && works.length >= options.maxChapters) return { oversize: true };
    let raw;
    try {
      raw = readFile(file);
    } catch {
      continue;
    }
    const title = textChapterTitle(raw, file);
    let blocks = parsePlainTextBlocks(raw);
    if (blocks.length && blocks[0].text === title) blocks = blocks.slice(1);
    if (!blocks.length) continue;
    const work = buildWork({ dir, rel: path.relative(root, dir), title }, [{ file, title }], [{ title, blocks }]);
    if (work) works.push(work);
  }
  if (!works.length) return null;

  const category = categoryFor(root, dir);
  const metadata = {
    tradition: CATEGORY_TRADITIONS[category] || titleCase(category) || "Reference",
    language: "English",
    script: "Latin",
    sourcePath: path.relative(root, dir).split(path.sep).join("/")
  };

  return {
    category,
    document: buildCanonicalDocument(titleCase(path.basename(dir)), works, metadata),
    stats: {
      sections: works.reduce((sum, work) => sum + work.sectionCount, 0),
      verses: works.reduce((sum, work) => sum + work.verseCount, 0)
    }
  };
}

// ---- reporting / CLI ----

function parseArgs(argv) {
  const options = {
    root: process.env.KABBAK_SACRED_TEXTS_ROOT || "",
    out: DEFAULT_OUT,
    category: "",
    book: "",
    limit: 0,
    dryRun: false,
    install: false,
    quiet: false,
    list: false,
    force: false,
    maxChapters: 4000,
    text: true,
    exclude: [...DEFAULT_EXCLUDE]
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    switch (arg) {
      case "--root": options.root = next(); break;
      case "--out": options.out = path.resolve(next()); break;
      case "--category": options.category = String(next() || "").toLowerCase(); break;
      case "--book": options.book = next(); break;
      case "--limit": options.limit = Math.max(0, parseInt(next(), 10) || 0); break;
      case "--max-chapters": options.maxChapters = Math.max(0, parseInt(next(), 10) || 0); break;
      case "--no-text": options.text = false; break;
      case "--exclude": options.exclude = String(next() || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean); break;
      case "--dry-run": options.dryRun = true; break;
      case "--install": options.install = true; break;
      case "--quiet": options.quiet = true; break;
      case "--list": options.list = true; break;
      case "--force": options.force = true; break;
      case "--help": options.help = true; break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option '${arg}'. Use --help for usage.`);
        }
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write([
    "Scrape the Sacred Texts archive into canonical text-source JSON.",
    "",
    "Usage:",
    "  node scripts/scrape-sacred-texts.js --root <folder> [options]",
    "",
    "Options:",
    "  --root <dir>        Archive root (or KABBAK_SACRED_TEXTS_ROOT).",
    "  --out <dir>         Output folder (default imports/text/_scraped).",
    "  --category <code>   Only scrape one top-level category (e.g. tarot).",
    "  --book <relpath>    Only scrape one book folder, relative to the root.",
    "  --exclude <list>    Comma-separated folder names to skip.",
    "  --limit <n>         Stop after n books.",
    "  --max-chapters <n>  Skip books exceeding n chapters (0 = unlimited, default 4000).",
    "  --no-text           Ignore folders that hold only plain .txt books.",
    "  --install           Copy documents into source/data/text and refresh library.json.",
    "  --force             Overwrite existing output files.",
    "  --dry-run           Discover and parse, but write nothing.",
    "  --list              List discovered books without parsing them.",
    "  --quiet             Only print the final summary.",
    "  --help              Show this help.",
    ""
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.root) {
    throw new Error("Missing --root. Point it at the folder that contains the category subfolders (e.g. \"Sacred Texts 7\").");
  }
  const root = path.resolve(options.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Archive root not found: ${root}`);
  }

  const exclude = new Set(options.exclude);
  let dirs = walkDirectories(root);
  if (options.category) {
    dirs = dirs.filter((dir) => categoryFor(root, dir) === options.category);
  }
  if (options.book) {
    const target = path.resolve(root, options.book);
    dirs = dirs.filter((dir) => path.resolve(dir) === target);
  }

  const books = [];
  for (const dir of dirs.sort()) {
    if (isExcluded(root, dir, exclude)) continue;
    const indexFile = findIndexFile(dir);
    if (indexFile) {
      const indexHtml = readFile(indexFile);
      const chapters = collectChapters(dir, indexHtml, [indexFile]);
      if (!chapters.length) continue;
      books.push({ dir, indexFile, chapters });
      continue;
    }
    if (options.text) {
      const textFiles = collectTextFiles(dir);
      if (!textFiles.length) continue;
      books.push({ dir, indexFile: null, chapters: textFiles.map((file) => ({ file, title: "" })) });
    }
  }

  if (options.list) {
    for (const book of books) {
      process.stdout.write(`${path.relative(root, book.dir) || "."}\t${book.chapters.length}\n`);
    }
    process.stdout.write(`\n${books.length} book folders.\n`);
    return;
  }

  const limited = options.limit > 0 ? books.slice(0, options.limit) : books;
  if (!options.quiet) {
    process.stdout.write(`Scraping ${limited.length} of ${books.length} book folders from ${root}\n`);
  }

  await fsp.mkdir(options.out, { recursive: true });
  const usedNames = new Set();
  const manifest = [];
  let failed = 0;

  for (const entry of limited) {
    let result;
    try {
      result = entry.indexFile
        ? parseBook(root, entry.dir, entry.indexFile, options)
        : parseTextBook(root, entry.dir, options);
    } catch (error) {
      failed++;
      process.stderr.write(`  ! ${path.relative(root, entry.dir)}: ${error.message}\n`);
      continue;
    }
    if (result && result.oversize) {
      failed++;
      process.stderr.write(`  ! ${path.relative(root, entry.dir)}: more than ${options.maxChapters} chapters; raise --max-chapters to include it\n`);
      continue;
    }
    if (!result) {
      failed++;
      process.stderr.write(`  ! ${path.relative(root, entry.dir)}: no readable text\n`);
      continue;
    }

    const rel = path.relative(root, entry.dir) || ".";
    let fileName = `${slugify(result.document.title)}.json`;
    if (usedNames.has(fileName)) {
      let suffix = 2;
      while (usedNames.has(`${slugify(result.document.title)}-${suffix}.json`)) suffix++;
      fileName = `${slugify(result.document.title)}-${suffix}.json`;
    }
    usedNames.add(fileName);

    manifest.push({
      file: fileName,
      title: result.document.title,
      category: result.category,
      sourcePath: rel.split(path.sep).join("/"),
      sections: result.stats.sections,
      verses: result.stats.verses
    });

    if (!options.dryRun) {
      const outPath = path.join(options.out, fileName);
      if (options.force || !fs.existsSync(outPath)) {
        await fsp.writeFile(outPath, `${JSON.stringify(result.document, null, 2)}\n`, "utf8");
      }
    }
    if (!options.quiet) {
      process.stdout.write(`  ${rel} -> ${fileName} (${result.stats.sections} sections, ${result.stats.verses} verses)\n`);
    }
  }

  if (!options.dryRun) {
    await fsp.writeFile(
      path.join(options.out, "manifest.json"),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), root, count: manifest.length, books: manifest }, null, 2)}\n`,
      "utf8"
    );
  }

  process.stdout.write(`\nScraped ${manifest.length} books (${failed} skipped).\n`);

  if (options.install) {
    if (options.dryRun) {
      process.stdout.write("Dry run: skipping --install.\n");
      return;
    }
    const { sourceTextDataRoot } = require("../src/config/paths");
    const { refreshTextLibraryRegistry } = require("../src/services/text-library-registry");
    await fsp.mkdir(sourceTextDataRoot, { recursive: true });
    let copied = 0;
    for (const item of manifest) {
      const from = path.join(options.out, item.file);
      const to = path.join(sourceTextDataRoot, item.file);
      if (fs.existsSync(to) && !options.force) continue;
      await fsp.copyFile(from, to);
      copied++;
    }
    const scan = await refreshTextLibraryRegistry();
    process.stdout.write(`Installed ${copied} documents into source/data/text; library now lists ${scan.sources.length} sources.\n`);
  } else if (!options.quiet) {
    process.stdout.write(`Output: ${options.out}\n`);
    process.stdout.write("Register them with: npm run imports -- library --write\n");
  }
}

main().catch((error) => {
  process.stderr.write(`scrape-sacred-texts: ${error.message}\n`);
  process.exitCode = 1;
});
