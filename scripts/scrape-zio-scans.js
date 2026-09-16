"use strict";

// Scrape the ZIO.Cards scan museum (zio.cards) into local scan folders.
//
// Each listing card pairs a scan page id with the storage folder that holds its
// files, and the scan page carries the authoritative face -> card mapping:
//   https://zio.cards/scans/<scanId>                    listing card link
//   "scanLayout":{"cards":[{"name":"AS","index":3},...]} face name + file number
//   https://scans.zio.cards/<folder>/raw/face-03.webp   the face image
//   https://scans.zio.cards/<folder>/faces.webp         contact sheet (--previews)
//   https://scans.zio.cards/<folder>/backs.webp         backs sheet (--previews)
//
// Face files are numbered in scan order, which is not playing order (face 3 can
// be the Ace of Spades, and some decks count a suit downwards). The scraper
// reads the layout, sorts the faces into playing order, and names every file
// after the card so the folder is usable without a lookup table:
//   01-as.webp  02-2s.webp  ...  53-joker-1.webp
//
//   node scripts/scrape-zio-scans.js
//   node scripts/scrape-zio-scans.js --pages 1-2 --dry-run --list
//   node scripts/scrape-zio-scans.js --only Pride --previews
//   node scripts/scrape-zio-scans.js --order scan --dirs id --faces 60
//   node scripts/scrape-zio-scans.js --out "D:\zio-scans" --parallel 3
//
// Output defaults to imports/scans/zio (gitignored): one folder per scan named
// after the deck, holding the faces plus a scan.json manifest, and a
// scans-index.json listing every discovered scan.

const fsp = require("node:fs/promises");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(REPO_ROOT, "imports", "scans", "zio");
const SITE_ORIGIN = "https://zio.cards";
const SCANS_ORIGIN = "https://scans.zio.cards";
const USER_AGENT = "KABBAK-Scans-Archiver/1.0 (+https://github.com/Noirdua/KABBAK-API)";
const DEFAULT_FACES = 56;
const DEFAULT_PAGES = 8;
const DEFAULT_SUIT_ORDER = ["S", "H", "D", "C"];
const RANK_ORDER = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const REQUEST_TIMEOUT_MS = 60000;
const MAX_DIR_SLUG = 60;

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    pages: [],
    faces: DEFAULT_FACES,
    facesExplicit: false,
    delay: 250,
    parallel: 1,
    retries: 3,
    only: [],
    order: "card",
    dirs: "name",
    suitOrder: [...DEFAULT_SUIT_ORDER],
    previews: false,
    force: false,
    dryRun: false,
    list: false,
    quiet: false
  };

  const parsePages = (value) => String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (!range) {
        const page = parseInt(part, 10);
        return Number.isFinite(page) ? [page] : [];
      }
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      const pages = [];
      for (let page = Math.min(start, end); page <= Math.max(start, end); page++) {
        pages.push(page);
      }
      return pages;
    })
    .filter((page) => page > 0);

  const parseSuits = (value) => String(value || "")
    .split(",")
    .map((suit) => suit.trim().toUpperCase())
    .filter((suit) => DEFAULT_SUIT_ORDER.includes(suit));

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    switch (arg) {
      case "--out": options.out = path.resolve(next()); break;
      case "--page": options.pages.push(...parsePages(next())); break;
      case "--pages": options.pages.push(...parsePages(next())); break;
      case "--faces":
        options.faces = Math.max(1, parseInt(next(), 10) || DEFAULT_FACES);
        options.facesExplicit = true;
        break;
      case "--delay": options.delay = Math.max(0, parseInt(next(), 10) || 0); break;
      case "--parallel": options.parallel = Math.min(4, Math.max(1, parseInt(next(), 10) || 1)); break;
      case "--retries": options.retries = Math.max(0, parseInt(next(), 10) || 0); break;
      case "--only":
        options.only.push(...String(next() || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
        break;
      case "--order": {
        const order = String(next() || "").toLowerCase();
        if (!["card", "scan"].includes(order)) {
          throw new Error("--order accepts 'card' or 'scan'.");
        }
        options.order = order;
        break;
      }
      case "--dirs": {
        const dirs = String(next() || "").toLowerCase();
        if (!["name", "id"].includes(dirs)) {
          throw new Error("--dirs accepts 'name' or 'id'.");
        }
        options.dirs = dirs;
        break;
      }
      case "--suit-order": {
        const suits = parseSuits(next());
        if (!suits.length) {
          throw new Error("--suit-order needs a list like S,H,D,C.");
        }
        options.suitOrder = suits;
        break;
      }
      case "--previews": options.previews = true; break;
      case "--force": options.force = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--list": options.list = true; break;
      case "--quiet": options.quiet = true; break;
      case "--help": options.help = true; break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option '${arg}'. Use --help for usage.`);
        }
    }
  }

  if (!options.pages.length) {
    options.pages = Array.from({ length: DEFAULT_PAGES }, (_unused, index) => index + 1);
  }
  options.pages = Array.from(new Set(options.pages)).sort((left, right) => left - right);
  return options;
}

function printHelp() {
  process.stdout.write([
    "Scrape the zio.cards scan museum into local image folders.",
    "",
    "Usage:",
    "  node scripts/scrape-zio-scans.js [options]",
    "",
    "Options:",
    "  --out <dir>        Output root (default imports/scans/zio).",
    "  --pages <list>     Pages to read, e.g. 1-8 or 1,3,5 (default 1-8).",
    "  --page <n>         Add a single page (repeatable).",
    "  --only <list>      Only these scans: folder id, scan id, or a title fragment.",
    "  --order <kind>     card (playing order, default) or scan (face file order).",
    "  --dirs <kind>      name (deck title, default) or id (storage folder id).",
    "  --suit-order <s>   Suit precedence for --order card (default S,H,D,C).",
    "  --faces <n>        Face numbers to probe when a scan has no layout; also",
    "                     extends past the layout when set explicitly (default 56).",
    "  --previews         Also fetch faces.webp and backs.webp per scan.",
    "  --delay <ms>       Pause between requests (default 250).",
    "  --parallel <n>     Scans downloaded at once, 1-4 (default 1).",
    "  --retries <n>      Retries per request on failure (default 3).",
    "  --force            Re-download files that already exist.",
    "  --dry-run          Discover only; write nothing.",
    "  --list             Print discovered scans without downloading.",
    "  --quiet            Only print the final summary.",
    "  --help             Show this help.",
    ""
  ].join("\n"));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&quot;/g, "\"")
    .replace(/&#?apos;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function slugify(value, maxLength = MAX_DIR_SLUG) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLength).replace(/-+$/g, "");
}

function faceFileName(number) {
  return `face-${String(number).padStart(2, "0")}.webp`;
}

function faceUrl(folder, number) {
  return `${SCANS_ORIGIN}/${folder}/raw/${faceFileName(number)}`;
}

async function fetchOnce(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: options.accept || "*/*"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 3;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(8000, 500 * (2 ** (attempt - 1))));
    }
    try {
      const response = await fetchOnce(url, options);
      if (response.status === 404) {
        return response;
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await sleep(Math.min(30000, retryAfter * 1000));
        }
        lastError = new Error(`${url} responded ${response.status}`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`${url} responded ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function fetchText(url, options) {
  const response = await fetchWithRetry(url, { ...options, accept: "text/html" });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return response.text();
}

function parseListingPage(html, page) {
  const scans = [];
  const anchors = Array.from(html.matchAll(/<a\b[^>]*href="\/scans\/([a-z0-9]+)"[^>]*>/g));

  anchors.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < anchors.length ? anchors[index + 1].index : html.length;
    const block = html.slice(start, end);
    const folderMatch = block.match(/scans\.zio\.cards\/([a-z0-9]+)\/faces\.webp/);
    if (!folderMatch) {
      return;
    }

    const altMatch = block.match(/alt="([^"]*)"/);
    const title = altMatch
      ? decodeEntities(altMatch[1]).replace(/\s+faces?$/i, "").trim()
      : "";

    scans.push({
      scanId: match[1],
      folder: folderMatch[1],
      title,
      page,
      scanUrl: `${SITE_ORIGIN}/scans/${match[1]}`,
      sourceUrl: `${SCANS_ORIGIN}/${folderMatch[1]}`
    });
  });

  return scans;
}

// The scan page embeds the face -> card mapping in its flight payload:
//   \"scanLayout\":{"mode":"fallback","cards":[{"name":"AS","index":3},...]}
// `index` is the face file number; array order is the site's numeric order.
function parseScanLayout(html) {
  const start = html.indexOf('\\"scanLayout\\":');
  if (start < 0) {
    return null;
  }

  const from = start + '\\"scanLayout\\":'.length;
  let depth = 0;
  let end = -1;
  for (let index = from; index < html.length; index++) {
    const char = html[index];
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) {
    return null;
  }

  const body = html.slice(from, end).replace(/\\"/g, "\"");
  const mode = (body.match(/"mode"\s*:\s*"([^"]*)"/) || [])[1] || "";
  const cards = [];
  const entryRe = /\{([^{}]*)\}/g;
  let match;
  while ((match = entryRe.exec(body))) {
    const entry = match[1];
    const name = (entry.match(/"name"\s*:\s*"([^"]*)"/) || [])[1];
    const index = Number((entry.match(/"index"\s*:\s*(\d+)/) || [])[1]);
    if (name && Number.isFinite(index)) {
      cards.push({ name, index, back: /"back"\s*:\s*true/.test(entry) });
    }
  }

  return cards.length ? { mode, cards } : null;
}

function parseCardName(name) {
  const match = /^(\d{1,2}|A|J|Q|K)\s*([SHDC])$/i.exec(String(name || "").trim());
  if (!match) {
    return null;
  }
  const rank = match[1].toUpperCase();
  const suit = match[2].toUpperCase();
  if (!RANK_ORDER.includes(rank)) {
    return null;
  }
  return { rank, suit };
}

function cardSortKey(face, options, fallbackIndex) {
  const parsed = parseCardName(face.name);
  if (!parsed) {
    return { group: 1, suit: 99, rank: 99, fallback: fallbackIndex };
  }
  const suitIndex = options.suitOrder.indexOf(parsed.suit);
  return {
    group: 0,
    suit: suitIndex >= 0 ? suitIndex : 99,
    rank: RANK_ORDER.indexOf(parsed.rank),
    fallback: fallbackIndex
  };
}

// Turns the layout into an ordered download plan. Faces the layout does not
// mention (or every face when there is no layout) are appended in scan order so
// nothing is dropped.
function planFaces(scan, layout, options) {
  const known = new Map();
  const ordered = [];

  if (layout) {
    layout.cards.forEach((card, index) => {
      if (known.has(card.index)) {
        return;
      }
      known.set(card.index, true);
      ordered.push({ name: card.name, index: card.index, back: card.back === true, layoutIndex: index });
    });
  }

  for (let index = 1; index <= options.probeTo; index++) {
    if (known.has(index)) {
      continue;
    }
    const fallbackName = layout ? `Unknown${index}` : `Face${String(index).padStart(2, "0")}`;
    ordered.push({ name: fallbackName, index, back: false, layoutIndex: ordered.length });
  }

  if (options.order === "scan" || !layout) {
    return ordered
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((face, position) => ({ ...face, position: position + 1, file: fileForFace(face, position + 1) }));
  }

  return ordered
    .slice()
    .sort((left, right) => {
      const a = cardSortKey(left, options, left.index);
      const b = cardSortKey(right, options, right.index);
      return (a.group - b.group)
        || (a.suit - b.suit)
        || (a.rank - b.rank)
        || (a.fallback - b.fallback);
    })
    .map((face, position) => ({ ...face, position: position + 1, file: fileForFace(face, position + 1) }));
}

function fileForFace(face, position) {
  const number = String(position).padStart(2, "0");
  const slug = slugify(face.name, 40) || `face-${String(face.index).padStart(2, "0")}`;
  return `${number}-${slug}.webp`;
}

function matchesOnly(scan, only) {
  if (!only.length) {
    return true;
  }
  const haystack = [scan.scanId, scan.folder, scan.title].map((value) => String(value).toLowerCase());
  return only.some((needle) => haystack.some((value) => value.includes(needle)));
}

function scanSummary(scan) {
  return `${scan.title ? `${scan.title} ` : ""}[${scan.folder}]`;
}

async function discoverScans(options) {
  const byScanId = new Map();

  for (const page of options.pages) {
    const url = `${SITE_ORIGIN}/scans?page=${page}`;
    const html = await fetchText(url, { retries: options.retries });
    const scans = parseListingPage(html, page);
    if (!options.quiet) {
      process.stdout.write(`[zio] page ${page}: ${scans.length} scan(s)\n`);
    }
    scans.forEach((scan) => {
      if (!byScanId.has(scan.scanId)) {
        byScanId.set(scan.scanId, scan);
      }
    });
    await sleep(options.delay);
  }

  return Array.from(byScanId.values());
}

async function loadExistingDirs(indexPath) {
  try {
    const raw = await fsp.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    const byScanId = new Map();
    const used = new Set();
    const entries = [];
    (Array.isArray(parsed?.scans) ? parsed.scans : []).forEach((entry) => {
      if (!entry?.scanId) {
        return;
      }
      entries.push(entry);
      if (entry.dir) {
        byScanId.set(entry.scanId, entry.dir);
        used.add(entry.dir);
      }
    });
    return { byScanId, used, entries };
  } catch (_error) {
    return { byScanId: new Map(), used: new Set(), entries: [] };
  }
}

// The index can go stale (hand edits, older runs); every scan folder carries its
// own scan.json, so the disk is the source of truth for dir <-> scan ownership.
async function readDiskEntries(outRoot) {
  const entries = [];
  let dirents = [];
  try {
    dirents = await fsp.readdir(outRoot, { withFileTypes: true });
  } catch (_error) {
    return entries;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    try {
      const raw = await fsp.readFile(path.join(outRoot, dirent.name, "scan.json"), "utf8");
      const manifest = JSON.parse(raw);
      if (!manifest?.scanId) {
        continue;
      }
      entries.push({
        scanId: manifest.scanId,
        folder: manifest.folder,
        title: manifest.title,
        page: manifest.page,
        scanUrl: manifest.scanUrl,
        sourceUrl: manifest.sourceUrl,
        dir: manifest.dir || dirent.name,
        order: manifest.order,
        faces: manifest.faces,
        bytes: manifest.bytes,
        status: "downloaded"
      });
    } catch (_error) {
      // Not a scan folder.
    }
  }

  return entries;
}

function dirsBase(scan, mode) {
  if (mode === "id") {
    return scan.folder;
  }
  return slugify(scan.title) || scan.folder;
}

// Reuses the folder recorded for a scan by an earlier run so re-runs resume, and
// gives duplicate deck names a numeric suffix instead of sharing a folder.
function allocateDir(scan, taken, mode) {
  if (taken.byScanId.has(scan.scanId)) {
    return taken.byScanId.get(scan.scanId);
  }

  const base = dirsBase(scan, mode);
  let candidate = base;
  let suffix = 2;
  while (taken.used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  taken.used.add(candidate);
  taken.byScanId.set(scan.scanId, candidate);
  return candidate;
}

async function fetchScanLayout(scan, options) {
  try {
    const html = await fetchText(scan.scanUrl, { retries: Math.min(1, options.retries) });
    return parseScanLayout(html);
  } catch (_error) {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    return stats.isFile() && stats.size > 0;
  } catch (_error) {
    return false;
  }
}

async function downloadScan(scan, dir, options) {
  const scanDir = path.join(options.out, dir);
  await fsp.mkdir(scanDir, { recursive: true });

  const layout = await fetchScanLayout(scan, options);
  await sleep(options.delay);
  if (layout) {
    const mode = layout.mode ? ` (${layout.mode})` : "";
    if (!options.quiet) {
      process.stdout.write(`[zio] ${dir}: layout lists ${layout.cards.length} face(s)${mode}\n`);
    }
  } else if (!options.quiet) {
    process.stdout.write(`[zio] ${dir}: no layout found, keeping scan order\n`);
  }

  // A layout already lists every face; only probe past it when the caller asks
  // for a higher --faces, so real decks do not collect phantom "missing" entries.
  const layoutMax = layout ? layout.cards.reduce((max, card) => Math.max(max, card.index), 0) : 0;
  const probeTo = layout && !options.facesExplicit ? Math.max(layoutMax, 0) : options.faces;
  const plan = planFaces(scan, layout, { ...options, probeTo });
  const faces = [];
  let bytes = 0;

  for (const face of plan) {
    const target = path.join(scanDir, face.file);

    if (!options.force && await fileExists(target)) {
      const stats = await fsp.stat(target);
      faces.push({ ...face, bytes: stats.size, cached: true });
      bytes += stats.size;
      continue;
    }

    const url = faceUrl(scan.folder, face.index);
    const response = await fetchWithRetry(url, { retries: options.retries });
    if (response.status === 404) {
      faces.push({ ...face, bytes: 0, missing: true });
      if (!options.quiet) {
        process.stdout.write(`[zio] ${dir}: ${face.file} missing (${url})\n`);
      }
      await sleep(options.delay);
      continue;
    }
    if (!response.ok) {
      throw new Error(`${url} responded ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(target, buffer);
    faces.push({ ...face, bytes: buffer.length, cached: false });
    bytes += buffer.length;

    if (!options.quiet) {
      process.stdout.write(`[zio] ${dir} ${face.file} ${(buffer.length / 1024).toFixed(0)}KB\n`);
    }
    await sleep(options.delay);
  }

  const downloaded = faces.filter((face) => !face.missing);
  if (!downloaded.length) {
    throw new Error(`${scan.folder}: no face images at ${faceUrl(scan.folder, 1)}`);
  }

  const previews = [];
  if (options.previews) {
    for (const name of ["faces.webp", "backs.webp"]) {
      const target = path.join(scanDir, name);
      if (!options.force && await fileExists(target)) {
        previews.push(name);
        continue;
      }
      const response = await fetchWithRetry(`${SCANS_ORIGIN}/${scan.folder}/${name}`, { retries: options.retries });
      if (response.status === 404) {
        await sleep(options.delay);
        continue;
      }
      if (!response.ok) {
        throw new Error(`${name} responded ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await fsp.writeFile(target, buffer);
      previews.push(name);
      await sleep(options.delay);
    }
  }

  const manifest = {
    scanId: scan.scanId,
    folder: scan.folder,
    dir,
    title: scan.title,
    page: scan.page,
    scanUrl: scan.scanUrl,
    sourceUrl: scan.sourceUrl,
    order: layout ? options.order : "scan",
    layoutMode: layout?.mode || "",
    suitOrder: options.suitOrder,
    faces: downloaded.length,
    missing: faces.filter((face) => face.missing).map((face) => face.index),
    bytes,
    previews,
    cards: faces.map((face) => ({
      position: face.position,
      name: face.name,
      face: face.index,
      file: face.file,
      back: face.back === true,
      missing: face.missing === true,
      bytes: face.bytes
    })),
    fetchedAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(scanDir, "scan.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (!options.quiet) {
    process.stdout.write(`[zio] done ${dir}: ${downloaded.length} face(s), ${(bytes / (1024 * 1024)).toFixed(1)}MB\n`);
  }

  return { scan, dir, manifest, faces: downloaded.length, bytes };
}

async function runPool(items, parallel, worker) {
  const results = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, parallel) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const discovered = await discoverScans(options);
  const selected = discovered.filter((scan) => matchesOnly(scan, options.only));

  process.stdout.write(`[zio] discovered ${discovered.length} scan(s); ${selected.length} selected\n`);
  if (options.list) {
    selected.forEach((scan) => {
      process.stdout.write(`  ${slugify(scan.title) || scan.folder}  ${scan.scanId}  ${scan.title}\n`);
    });
    return;
  }

  const indexPath = path.join(options.out, "scans-index.json");
  const taken = await loadExistingDirs(indexPath);
  const diskEntries = await readDiskEntries(options.out);
  diskEntries.forEach((entry) => {
    if (entry.dir) {
      taken.used.add(entry.dir);
      if (!taken.byScanId.has(entry.scanId)) {
        taken.byScanId.set(entry.scanId, entry.dir);
      }
    }
  });
  const jobs = selected.map((scan) => ({ scan, dir: allocateDir(scan, taken, options.dirs) }));

  if (options.dryRun) {
    process.stdout.write("[zio] dry run: nothing written\n");
    jobs.forEach((job) => {
      process.stdout.write(`  ${job.dir}  <- ${job.scan.folder}  ${job.scan.title}\n`);
    });
    return;
  }

  await fsp.mkdir(options.out, { recursive: true });

  const results = await runPool(jobs, options.parallel, (job) => downloadScan(job.scan, job.dir, options));

  const index = [];
  let failures = 0;
  let totalBytes = 0;

  results.forEach((result, position) => {
    const { scan, dir } = jobs[position];
    if (result?.ok) {
      totalBytes += result.value.bytes;
      index.push({
        ...scan,
        dir,
        order: result.value.manifest.order,
        faces: result.value.faces,
        bytes: result.value.bytes,
        status: "downloaded"
      });
      return;
    }
    failures++;
    process.stdout.write(`[zio] FAILED ${scanSummary(scan)}: ${result?.error?.message || "unknown error"}\n`);
    index.push({
      ...scan,
      dir,
      status: "failed",
      error: String(result?.error?.message || "unknown error")
    });
  });

  // Merge index + disk + this run so a partial run never forgets earlier scans
  // (their recorded dir is what keeps re-runs resuming into the same folder).
  const merged = new Map([
    ...diskEntries.map((entry) => [entry.scanId, entry]),
    ...taken.entries.map((entry) => [entry.scanId, entry])
  ]);
  index.forEach((entry) => merged.set(entry.scanId, entry));
  const mergedScans = Array.from(merged.values())
    .sort((left, right) => (Number(left.page) - Number(right.page)) || String(left.dir || "").localeCompare(String(right.dir || "")));

  await fsp.writeFile(indexPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    pages: options.pages,
    order: options.order,
    dirs: options.dirs,
    suitOrder: options.suitOrder,
    faceLimit: options.faces,
    count: mergedScans.length,
    downloaded: mergedScans.filter((entry) => entry.status === "downloaded").length,
    failed: mergedScans.filter((entry) => entry.status === "failed").length,
    bytes: mergedScans.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0),
    scans: mergedScans
  }, null, 2)}\n`, "utf8");

  process.stdout.write([
    "",
    `[zio] scans: ${index.length}`,
    `[zio] downloaded: ${index.length - failures}`,
    `[zio] failed: ${failures}`,
    `[zio] images: ${(totalBytes / (1024 * 1024)).toFixed(1)}MB`,
    `[zio] order: ${options.order}  dirs: ${options.dirs}`,
    `[zio] out: ${options.out}`,
    ""
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`[zio] ${error?.stack || error}\n`);
  process.exitCode = 1;
});
