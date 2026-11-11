const fs = require("fs/promises");
const path = require("path");
const { execFileSync } = require("child_process");

const { sourceTarotCommentariesRoot } = require("../src/config/paths");
const { normalizeCommentaryDocument } = require("../src/services/tarot-commentary-service");

function printHelp() {
  console.log(`Import tarot card commentaries into source/data/tarot-commentaries.

Usage:
  npm run import:tarot-commentaries -- <file-or-directory> [options]

Options:
  --id <id>             Collection id for bare entry arrays/maps
  --title <title>       Collection title for bare entry arrays/maps
  --author <name>       Author name
  --year <year>         Publication or composition year
  --kind <kind>         Default kind: commentary, meditation, poem, etc.
  --license <license>   License label, e.g. public-domain
  --source-url <url>    Source URL
  --force               Replace an existing collection with the same id
  --dry-run             Validate and print without writing files
  --allow-unknown       Keep entries whose card cannot be matched
  --migrate             Rebuild the storage snapshot after importing
  --help                Show this message

Accepted JSON shapes:
  1. A collection object:
     {
       "id": "tokens",
       "title": "Tokens",
       "author": "Paul Foster Case",
       "kind": "meditation",
       "entries": [
         { "cardId": "major-the-fool", "title": "The Fool", "body": "Line one\\nLine two" }
       ]
     }

  2. Entries keyed by canonical card id or card name:
     {
       "id": "tokens",
       "title": "Tokens",
       "entries": {
         "major-the-fool": { "title": "The Fool", "body": "..." },
         "The Magus": "..."
       }
     }

  3. A bare array/map plus --id/--title flags.

After importing, run:
  npm run migrate:data

Or pass --migrate to rebuild the snapshot in the same command.`);
}

function parseArgs(argv) {
  const options = {
    id: "",
    title: "",
    author: "",
    year: "",
    kind: "",
    license: "",
    sourceUrl: ""
  };
  const flags = {
    force: false,
    dryRun: false,
    allowUnknown: false,
    migrate: false,
    help: false
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--allow-unknown") {
      flags.allowUnknown = true;
    } else if (arg === "--migrate") {
      flags.migrate = true;
    } else if (arg === "--id") {
      options.id = String(argv[++index] || "");
    } else if (arg === "--title") {
      options.title = String(argv[++index] || "");
    } else if (arg === "--author") {
      options.author = String(argv[++index] || "");
    } else if (arg === "--year") {
      options.year = String(argv[++index] || "");
    } else if (arg === "--kind") {
      options.kind = String(argv[++index] || "");
    } else if (arg === "--license") {
      options.license = String(argv[++index] || "");
    } else if (arg === "--source-url") {
      options.sourceUrl = String(argv[++index] || "");
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option '${arg}'. Use --help.`);
    } else {
      positional.push(arg);
    }
  }

  return { options, flags, positional };
}

function applyOptionFallbacks(raw, options, fileStem) {
  const collection = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  collection.id = collection.id || options.id || fileStem;
  collection.title = collection.title || options.title || collection.id;
  collection.author = collection.author || options.author;
  collection.year = collection.year || options.year;
  collection.kind = collection.kind || options.kind;
  collection.license = collection.license || options.license;
  collection.sourceUrl = collection.sourceUrl || collection.url || options.sourceUrl;
  return collection;
}

function normalizeInput(raw, options, fileStem) {
  if (Array.isArray(raw)) {
    return normalizeCommentaryDocument(applyOptionFallbacks({ entries: raw }, options, fileStem));
  }

  if (raw && typeof raw === "object" && Array.isArray(raw.collections)) {
    return normalizeCommentaryDocument(raw);
  }

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const hasCollectionShape = raw.entries
      || raw.commentaries
      || raw.items
      || raw.id
      || raw.title
      || raw.author;
    const collection = hasCollectionShape ? raw : { entries: raw };
    return normalizeCommentaryDocument(applyOptionFallbacks(collection, options, fileStem));
  }

  throw new Error("Input must be a JSON object, an entry array, or a collection document.");
}

async function loadCardMatcher() {
  try {
    const {
      listCards,
      normalizeTarotCardLookupName,
      buildTarotCardLookupCandidates
    } = require("../src/services/tarot-service");
    const cards = await listCards();
    return {
      byId: new Map(cards.map((card) => [card.id, card])),
      byName: new Map(cards.map((card) => [normalizeTarotCardLookupName(card.name), card])),
      lookupCandidates: buildTarotCardLookupCandidates
    };
  } catch (_error) {
    return null;
  }
}

function resolveCardForEntry(entry, matcher) {
  if (!matcher) {
    return null;
  }

  if (entry.cardId && matcher.byId.has(entry.cardId)) {
    return matcher.byId.get(entry.cardId);
  }

  const candidates = [entry.card, entry.cardId].filter(Boolean);
  for (const candidate of candidates) {
    for (const lookup of matcher.lookupCandidates(candidate)) {
      const match = matcher.byName.get(lookup);
      if (match) {
        return match;
      }
    }
  }

  return null;
}

function serializeCollection(collection) {
  return {
    id: collection.id,
    title: collection.title,
    author: collection.author,
    year: collection.year,
    kind: collection.kind,
    description: collection.description,
    license: collection.license,
    sourceUrl: collection.sourceUrl,
    order: collection.order,
    entries: collection.entries.map((entry) => ({
      id: entry.id,
      cardId: entry.cardId,
      card: entry.card,
      title: entry.title,
      kind: entry.kind,
      body: entry.body,
      author: entry.author,
      year: entry.year,
      sourceUrl: entry.sourceUrl,
      license: entry.license,
      order: entry.order
    }))
  };
}

async function collectInputFiles(targets) {
  const files = [];

  for (const target of targets) {
    const resolved = path.resolve(target);
    const stats = await fs.stat(resolved);
    if (stats.isDirectory()) {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      entries
        .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name) && !entry.name.startsWith("_") && !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name))
        .forEach((entry) => files.push(path.join(resolved, entry.name)));
    } else {
      files.push(resolved);
    }
  }

  return files;
}

async function main() {
  const { options, flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return;
  }

  if (!positional.length) {
    printHelp();
    throw new Error("No input file or directory supplied.");
  }

  const inputFiles = await collectInputFiles(positional);
  if (!inputFiles.length) {
    throw new Error("No .json input files found.");
  }

  const matcher = await loadCardMatcher();
  if (!matcher) {
    console.warn("[tarot-commentaries] Card validation skipped because the storage snapshot is unavailable.");
  }

  const collections = [];
  const unknownCards = [];
  for (const filePath of inputFiles) {
    const rawText = await fs.readFile(filePath, "utf8");
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`${filePath}: invalid JSON (${error.message}).`);
    }

    const fileStem = path.basename(filePath, path.extname(filePath));
    const normalized = normalizeInput(raw, options, fileStem);
    if (!normalized.collections.length) {
      throw new Error(`${filePath}: no commentaries with a card reference and body were found.`);
    }

    normalized.collections.forEach((collection) => {
      collection.entries.forEach((entry) => {
        if (matcher && !resolveCardForEntry(entry, matcher)) {
          unknownCards.push(`${collection.id}/${entry.id} (${entry.cardId || entry.card || "no card"})`);
        }
      });
      collections.push(collection);
    });
  }

  if (unknownCards.length) {
    const message = `Could not match ${unknownCards.length} entr${unknownCards.length === 1 ? "y" : "ies"} to a tarot card:\n- ${unknownCards.join("\n- ")}`;
    if (!flags.allowUnknown) {
      throw new Error(`${message}\nUse canonical card ids from GET /api/v1/tarot/cards, or pass --allow-unknown.`);
    }
    console.warn(`[tarot-commentaries] ${message}`);
  }

  const seenIds = new Set();
  const plans = [];
  for (const collection of collections) {
    if (seenIds.has(collection.id)) {
      throw new Error(`Duplicate collection id '${collection.id}' in the import batch.`);
    }
    seenIds.add(collection.id);

    const outputPath = path.join(sourceTarotCommentariesRoot, `${collection.id}.json`);
    if (!flags.force) {
      try {
        await fs.access(outputPath);
        throw new Error(`Collection '${collection.id}' already exists at ${outputPath}. Use --force to replace it.`);
      } catch (error) {
        if (error && error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    plans.push({ collection, outputPath });
  }

  if (flags.dryRun) {
    plans.forEach(({ collection, outputPath }) => {
      console.log(`[dry-run] ${collection.id}: ${collection.entries.length} entries -> ${outputPath}`);
    });
    console.log("Dry run complete. No files were written.");
    return;
  }

  await fs.mkdir(sourceTarotCommentariesRoot, { recursive: true });
  for (const { collection, outputPath } of plans) {
    await fs.writeFile(outputPath, `${JSON.stringify(serializeCollection(collection), null, 2)}\n`, "utf8");
    console.log(`Imported ${collection.id}: ${collection.entries.length} entries -> ${outputPath}`);
  }

  if (flags.migrate) {
    console.log("Rebuilding the storage snapshot...");
    execFileSync(process.execPath, [
      "--max-old-space-size=4096",
      path.join(__dirname, "migrate-data-to-sqlite.js")
    ], { stdio: "inherit" });
    console.log("Storage snapshot rebuilt. Restart the API to load it.");
    return;
  }

  console.log("Run `npm run migrate:data` to rebuild the storage snapshot, then restart the API.");
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
