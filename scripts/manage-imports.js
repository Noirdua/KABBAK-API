const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  projectRoot,
  textImportRoot,
  decksImportRoot,
  dlcRoot,
  sourceDecksRoot,
  sourceTextDataRoot,
  sourceGeneratedTextRoot,
  generatedTextSourceRegistryPath
} = require("../src/config/paths");

const dlc = require("../src/services/dlc-catalog");
const dlcSources = require("../src/services/dlc-sources");
const { scanTextLibrary, writeTextLibraryRegistry } = require("../src/services/text-library-registry");

function listTextImports() {
  const items = [];
  if (fs.existsSync(textImportRoot)) {
    for (const entry of fs.readdirSync(textImportRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".txt")) continue;
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

      const companionPath = path.join(textImportRoot, entry.name.replace(/\.txt$/i, ".manifest.json"));
      let meta = {};
      if (fs.existsSync(companionPath)) {
        try { meta = JSON.parse(fs.readFileSync(companionPath, "utf8")); } catch (_) {}
      }

      const generatedPath = path.join(sourceGeneratedTextRoot, entry.name.replace(/\.txt$/i, ".json"));
      const status = fs.existsSync(generatedPath) ? "imported" : "pending";

      items.push({
        name: entry.name.replace(/\.txt$/i, ""),
        type: "text",
        title: meta.title || "",
        translator: meta.translator || "",
        status,
        sourcePath: path.join(textImportRoot, entry.name),
        generatedPath
      });
    }
  }

  // Also check for generated-only sources (no source .txt remaining)
  if (fs.existsSync(sourceGeneratedTextRoot)) {
    for (const entry of fs.readdirSync(sourceGeneratedTextRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      if (entry.name === "sources.generated.json") continue;
      const baseName = entry.name.replace(/\.json$/i, "");
      if (items.some((i) => i.name === baseName)) continue;
      items.push({
        name: baseName,
        type: "text",
        title: "",
        translator: "",
        status: "orphan",
        sourcePath: "",
        generatedPath: path.join(sourceGeneratedTextRoot, entry.name)
      });
    }
  }

  return items;
}

function listDeckImports() {
  if (!fs.existsSync(decksImportRoot)) return [];
  return fs.readdirSync(decksImportRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
    .map((e) => {
      const deckJsonPath = path.join(decksImportRoot, e.name, "deck.json");
      let title = "";
      if (fs.existsSync(deckJsonPath)) {
        try { title = JSON.parse(fs.readFileSync(deckJsonPath, "utf8")).title || ""; } catch (_) {}
      }
      const sourceDeckPath = path.join(sourceDecksRoot, e.name);
      const status = fs.existsSync(sourceDeckPath) ? "imported" : "pending";
      return { name: e.name, type: "deck", title, status, path: path.join(decksImportRoot, e.name) };
    });
}

function cmdList(filterType) {
  const all = [];
  if (!filterType || filterType === "text") all.push(...listTextImports());
  if (!filterType || filterType === "deck") all.push(...listDeckImports());

  if (!all.length) {
    console.log("No imports found.");
    return;
  }

  const typePad = 6;
  const statusPad = 10;
  console.log(`\n${all.length} import(s) found:\n`);
  console.log(`${"TYPE".padEnd(typePad)} ${"STATUS".padEnd(statusPad)} ${"NAME".padEnd(30)} TITLE`);
  console.log("-".repeat(80));
  for (const item of all.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))) {
    const title = item.title || item.name;
    console.log(`${item.type.padEnd(typePad)} ${item.status.padEnd(statusPad)} ${item.name.padEnd(30)} ${title}`);
  }
  console.log("");
}

function removeDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
  console.log(`  Removed: ${dirPath}`);
}

function removeFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  fs.unlinkSync(filePath);
  console.log(`  Removed: ${filePath}`);
}

function cmdRemove(name, type) {
  if (!name) {
    console.error("Usage: npm run imports -- remove --name <name> [--text|--deck|--pack]");
    process.exit(1);
  }

  let removed = 0;

  if (!type || type === "text") {
    const txtPath = path.join(textImportRoot, name + ".txt");
    const manifestPath = path.join(textImportRoot, name + ".manifest.json");
    const generatedPath = path.join(sourceGeneratedTextRoot, name + ".json");
    const canonicalPath = path.join(sourceTextDataRoot, name + ".json");

    if (fs.existsSync(txtPath)) {
      removeFile(txtPath);
      removed++;
    }
    if (fs.existsSync(manifestPath)) {
      removeFile(manifestPath);
      removed++;
    }
    if (fs.existsSync(generatedPath)) {
      removeFile(generatedPath);
      removed++;
    }
    if (fs.existsSync(canonicalPath)) {
      removeFile(canonicalPath);
      removed++;
    }

    // Clean up generated registry
    if (fs.existsSync(generatedTextSourceRegistryPath)) {
      try {
        const registry = JSON.parse(fs.readFileSync(generatedTextSourceRegistryPath, "utf8"));
        const before = Array.isArray(registry.sources) ? registry.sources.length : 0;
        registry.sources = (registry.sources || []).filter(
          (s) => (s.id !== name) && (path.basename(s.fileName || "") !== name + ".json")
        );
        if (registry.sources.length !== before) {
          fs.writeFileSync(generatedTextSourceRegistryPath, JSON.stringify(registry, null, 2), "utf8");
          console.log("  Updated: " + generatedTextSourceRegistryPath);
        }
      } catch (_) {}
    }
  }

  if (!type || type === "deck") {
    const deckPath = path.join(decksImportRoot, name);
    const sourceDeckPath = path.join(sourceDecksRoot, name);
    if (fs.existsSync(deckPath)) {
      removeDir(deckPath);
      removed++;
    }
    if (fs.existsSync(sourceDeckPath)) {
      removeDir(sourceDeckPath);
      removed++;
    }
  }

  if (!removed) {
    console.log(`No import found for '${name}'${type ? " (type: " + type + ")" : ""}.`);
  } else {
    console.log(`\nRemoved ${removed} file(s) for '${name}'. Run npm start to rebuild the database.`);
  }
}

function inferRepoLabel(repoUrl) {
  const raw = String(repoUrl || "").trim();
  const match = raw.match(/\/([^/]+?)(?:\.git)?$/);
  return match ? match[1] : "";
}


function printUsage() {
  console.log(`
Usage: npm run imports -- <command> [options]
       npm run dlc -- <command> [options]      (shorthand for "imports -- dlc")

Local import commands:
  list                            List locally staged/installed items
  list --text | --deck            Filter the list by type
  remove --name <name> [--text|--deck]
                                  Remove a staged/installed item
  library [--write]               Show curated text sources and lexicons found in
                                  source/data/text; --write updates library.json

DLC commands (git folder tree — decks/, texts/, packs/, plugins/):
  dlc repo                        List configured DLC git repositories
  dlc repo <url>                  Add a repo (or set the primary if none)
  dlc repo <url> --replace        Change the primary repo URL
  dlc repo --remove <id|url>      Remove an extra repo (not the primary)
  dlc list [--refresh] [--deck|--text|--reference|--pack|--plugin]
                                  Show the catalog, grouped by repository
  dlc info --name <name> [--source <id>]
  dlc install --name <name> [--source <id>] [--stage-only]
  dlc install --all [--deck|--text|--reference|--pack] [--stage-only]
  dlc uninstall --name <name> [--source <id>] [--purge]
  dlc update                      Fast-forward every configured repo
  dlc check                       Validate downloaded DLC content before importing
  dlc init --repo <url>           Alias for: dlc repo <url> --replace

Examples:
  npm run dlc -- repo github.com/org/kabbak-dlc
  npm run dlc -- repo github.com/org/extra-plugins
  npm run dlc -- list
  npm run dlc -- install --name "Rider Waite"
  npm run dlc -- uninstall --name "Rider Waite" --purge
  npm run imports -- list --deck
`);
}

async function cmdLibrary(write) {
  const scan = await scanTextLibrary();

  if (!scan.sources.length && !scan.references.length) {
    console.log("No curated text documents found in source/data/text.");
  } else {
    console.log(`\nCurated text library (source/data/text):\n`);
    console.log(`${"KIND".padEnd(8)} ${"FORMAT".padEnd(17)} ${"ID".padEnd(34)} TITLE`);
    console.log("-".repeat(92));
    for (const source of scan.sources) {
      const references = source.referenceIds.length ? `  [references: ${source.referenceIds.join(", ")}]` : "";
      console.log(`${"source".padEnd(8)} ${source.format.padEnd(17)} ${source.id.padEnd(34)} ${source.title}${references}`);
    }
    for (const reference of scan.references) {
      console.log(`${"reference".padEnd(8)} ${String(reference.keyScheme || "-").padEnd(17)} ${reference.id.padEnd(34)} ${reference.title}`);
    }
    console.log(`\n${scan.sources.length} source(s), ${scan.references.length} reference(s).`);
  }

  for (const skipped of scan.skipped) {
    console.warn(`Skipped ${skipped.fileName}: ${skipped.reason}.`);
  }

  if (!write) {
    console.log("\nRun with --write to update source/data/text/library.json (npm run migrate:data does this automatically).");
    return;
  }

  await writeTextLibraryRegistry(scan);
  console.log("\nWrote source/data/text/library.json. Run npm run migrate:data to rebuild the database.");
}

// --- DLC catalog commands ---

const ORIGIN_LABEL = {
  git: "git tree",
  scan: "local folders",
  merged: "git tree + local folders"
};

function requireCatalogItem(items, name, kind, sourceId) {
  if (!name) {
    console.error("Provide an item name: --name <name>");
    process.exit(1);
  }
  const { matches, item } = dlc.findCatalogItem(items, name, kind, sourceId);
  if (item) return item;
  if (!matches.length) {
    console.error(`"${name}" was not found in the DLC catalog. Run: npm run dlc -- list`);
    process.exit(1);
  }
  console.error(`"${name}" matches ${matches.length} items. Narrow with --deck/--text/--pack/--plugin or --source <id>:`);
  for (const match of matches) {
    console.error(`  [${match.kind}] ${match.name}  ${match.sourceName || match.sourceId || "unknown repo"}`);
  }
  process.exit(1);
}

// A pack is a curated list, so acting on one acts on every item it lists.
function resolveTargets(items, item) {
  if (item.kind !== "pack") return [item];
  const { members, missing } = dlc.expandPack(item, items);
  for (const member of missing) {
    console.error(`  Pack '${item.name}' lists unknown item '${member.name}' — skipping.`);
    process.exitCode = 1;
  }
  return members;
}

function runRebuild() {
  console.log("\nRebuilding the database...\n");
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=4096", path.join(projectRoot, "scripts", "migrate-data-to-sqlite.js")],
    { cwd: projectRoot, stdio: "inherit" }
  );
  if (result.status !== 0) {
    console.error("\nDatabase rebuild failed. Fix the errors above and rerun: npm run migrate:data");
    process.exitCode = result.status || 1;
    return false;
  }
  return true;
}

function cmdDlcInit(repoUrl) {
  cmdDlcRepo(repoUrl, { replace: true });
}

function printRepoList() {
  const sources = dlcSources.listDescribedSources();
  if (!sources.length) {
    console.log("No DLC repositories configured. Add one with:");
    console.log("  npm run dlc -- repo github.com/org/kabbak-dlc");
    return;
  }
  console.log(`\n${sources.length} DLC repo(s):\n`);
  for (const source of sources) {
    const mark = source.primary ? "primary" : source.id;
    const state = source.present ? (source.head || "cloned") : "not cloned";
    console.log(`  [${mark}] ${source.name}`);
    console.log(`         ${source.url || "(no url)"}  ${source.branch || "main"}  ${state}`);
  }
  console.log("");
}

function cmdDlcRepo(rawUrl, { remove = "", replace = false, primary = false, name = "", branch = "" } = {}) {
  const log = (message) => console.log(message);
  if (remove) {
    const token = String(remove).trim();
    let source = dlcSources.getSource(token);
    if (!source) {
      try {
        source = dlcSources.findSourceByUrl(token);
      } catch (_error) {
        source = null;
      }
    }
    if (!source) {
      console.error(`No DLC repo matching '${token}'.`);
      process.exitCode = 1;
      return;
    }
    dlcSources.removeSource(source.id);
    dlc.invalidateCatalogCache();
    console.log(`Removed DLC repo '${source.name}' (${source.id}).`);
    return;
  }

  if (!rawUrl) {
    printRepoList();
    return;
  }

  const url = dlcSources.normalizeUrl(rawUrl);
  const existing = dlcSources.findSourceByUrl(url);
  const primarySource = dlcSources.getPrimarySource();

  if (existing) {
    const patch = {};
    if (name) patch.name = name;
    if (branch) patch.branch = branch;
    if (primary || replace) patch.primary = true;
    patch.sync = true;
    const described = dlcSources.updateSource(existing.id, patch, { log });
    dlc.invalidateCatalogCache();
    console.log(`\nDLC repo '${described.name}' ready (${described.url}).`);
    console.log("Next: npm run dlc -- list");
    return;
  }

  if (replace || !primarySource?.url) {
    if (!primarySource) {
      console.error(dlc.MISSING_DLC_REPO_MESSAGE);
      process.exitCode = 1;
      return;
    }
    const described = dlcSources.updateSource(primarySource.id, {
      url,
      name: name || primarySource.name || inferRepoLabel(url) || "KABBAK DLC",
      branch: branch || primarySource.branch || "main",
      primary: true,
      sync: true
    }, { log });
    dlc.invalidateCatalogCache();
    console.log(`\nPrimary DLC repo is now ${described.url}.`);
    console.log("Next: npm run dlc -- list");
    return;
  }

  const described = dlcSources.addSource({
    name: name || inferRepoLabel(url) || "Additional DLC",
    url,
    branch: branch || "main"
  }, { log });
  dlc.invalidateCatalogCache();
  console.log(`\nAdded DLC repo '${described.name}' (${described.url}).`);
  console.log("Catalog items from every repo show together, grouped, in: npm run dlc -- list");
}

async function cmdDlcList(kind, refresh, sourceId) {
  const { origin, items, sources } = await dlc.getCatalog({ refresh, log: (message) => console.log(message) });

  if (origin === "none" || !items.length) {
    console.error("No DLC catalog available. Run: npm run dlc -- repo <git-url>");
    process.exitCode = 1;
    return;
  }

  let visible = kind ? items.filter((item) => item.kind === kind) : items;
  if (sourceId) {
    const wanted = String(sourceId).trim().toLowerCase();
    visible = visible.filter((item) => String(item.sourceId || "").toLowerCase() === wanted
      || String(item.sourceName || "").toLowerCase() === wanted);
  }
  if (!visible.length) {
    console.log(`No DLC items listed (source: ${ORIGIN_LABEL[origin] || origin}).`);
    return;
  }

  const sourceList = Array.isArray(sources) && sources.length
    ? sources
    : dlcSources.listDescribedSources();
  const duplicates = visible.filter((item) => item.duplicate).length;

  console.log(`\nDLC catalog (${ORIGIN_LABEL[origin] || origin})`);
  if (duplicates) {
    console.log(`${duplicates} item(s) share a name across repos — listed in each group.`);
  }

  for (const source of sourceList) {
    const groupItems = visible.filter((item) => item.sourceId === source.id);
    if (!groupItems.length) continue;
    const label = source.primary ? `${source.name} (primary)` : source.name;
    console.log(`\n${label}`);
    console.log(`${source.url || "(local)"}  ${source.branch || "main"}`);
    console.log(`${"TYPE".padEnd(10)} ${"STATUS".padEnd(10)} ${"SIZE".padStart(9)}  ${"NAME".padEnd(34)} TITLE`);
    console.log("-".repeat(92));
    for (const category of dlc.CATEGORIES) {
      const group = groupItems
        .filter((item) => item.kind === category.kind)
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const item of group) {
        const detail = item.kind === "pack"
          ? `${item.memberCount} item(s)${item.missingCount ? `, ${item.missingCount} missing` : ""}`
          : (item.title === item.name ? "" : item.title);
        const dup = item.duplicate ? "  [also in another repo]" : "";
        console.log(`${item.kind.padEnd(10)} ${item.status.padEnd(10)} ${dlc.formatSize(item.size).padStart(9)}  ${item.name.padEnd(34)} ${detail}${dup}`);
      }
    }
  }

  const ungrouped = visible.filter((item) => !sourceList.some((source) => source.id === item.sourceId));
  if (ungrouped.length) {
    console.log(`\nOther`);
    console.log(`${"TYPE".padEnd(10)} ${"STATUS".padEnd(10)} ${"SIZE".padStart(9)}  ${"NAME".padEnd(34)} TITLE`);
    console.log("-".repeat(92));
    for (const item of ungrouped) {
      const detail = item.title === item.name ? "" : item.title;
      console.log(`${item.kind.padEnd(10)} ${item.status.padEnd(10)} ${dlc.formatSize(item.size).padStart(9)}  ${item.name.padEnd(34)} ${detail}`);
    }
  }

  const installed = visible.filter((item) => item.status === "installed").length;
  const staged = visible.filter((item) => item.status === "staged").length;
  console.log(`\n${visible.length} item(s) — ${installed} installed, ${staged} staged, ${visible.length - installed - staged} available.`);
  console.log(`Install one with: npm run dlc -- install --name "<name>"`);
  console.log(`Add another repo with: npm run dlc -- repo <git-url>`);
}

async function cmdDlcInfo(name, kind, sourceId) {
  const { items } = await dlc.getCatalog({ log: (message) => console.log(message) });
  const item = requireCatalogItem(items, name, kind, sourceId);
  console.log(`\n${item.title}`);
  console.log("-".repeat(Math.max(item.title.length, 12)));
  console.log(`  type         ${item.kind}`);
  console.log(`  name         ${item.name}`);
  console.log(`  id           ${item.id}`);
  if (item.sourceName || item.sourceUrl) {
    console.log(`  repo         ${item.sourceName || item.sourceId}${item.sourceUrl ? `  ${item.sourceUrl}` : ""}`);
  }
  if (item.duplicate) console.log("  duplicate    yes (same name in another repo)");
  console.log(`  size         ${dlc.formatSize(item.size)}${item.files ? ` (${item.files} file(s))` : ""}`);
  console.log(`  status       ${item.status}`);
  if (item.kind !== "pack") console.log(`  downloaded   ${item.downloaded ? "yes" : "no"}`);
  if (item.description) console.log(`  description  ${item.description}`);

  if (item.kind === "pack") {
    const { members, missing } = dlc.expandPack(item, items);
    console.log(`\n  Contains ${item.memberCount} item(s):`);
    for (const member of members) {
      console.log(`    ${member.kind.padEnd(5)} ${member.status.padEnd(10)} ${dlc.formatSize(member.size).padStart(9)}  ${member.name}`);
    }
    for (const member of missing) {
      console.log(`    ${String(member.type || "?").padEnd(5)} ${"missing".padEnd(10)} ${"-".padStart(9)}  ${member.name}`);
    }
  }
  console.log("");
}

async function cmdDlcInstall({ name, kind, all, stageOnly, sourceId }) {
  const { origin, items } = await dlc.getCatalog({ log: (message) => console.log(message) });
  if (origin === "none") {
    console.error("No DLC catalog available. Run: npm run dlc -- repo <git-url>");
    process.exitCode = 1;
    return;
  }

  let targets;
  if (all) {
    targets = items.filter((item) => item.kind !== "pack" && (!kind || item.kind === kind) && item.status === "available");
    if (!targets.length) {
      console.log("Nothing to install — every catalog item is already staged or installed.");
      return;
    }
  } else {
    targets = resolveTargets(items, requireCatalogItem(items, name, kind, sourceId));
    if (!targets.length) {
      console.log(`'${name}' lists no installable items.`);
      return;
    }
  }

  const totalSize = targets.reduce((sum, item) => sum + (item.size || 0), 0);
  console.log(`\nInstalling ${targets.length} item(s), about ${dlc.formatSize(totalSize)} to download.\n`);

  let staged = 0;
  const failures = [];
  for (const item of targets) {
    try {
      if (dlc.installItem(item, { log: (message) => console.log(`  ${message}`) })) staged += 1;
    } catch (error) {
      failures.push(`${item.name}: ${error.message}`);
      console.error(`  [${item.kind}] ${item.name} failed: ${error.message}`);
    }
  }

  if (failures.length) process.exitCode = 1;

  if (!staged) {
    console.log("\nNothing new was staged.");
    return;
  }

  console.log(`\n${staged} item(s) staged for import.`);
  if (stageOnly) {
    console.log("Run npm run migrate:data to import them into the database.");
    return;
  }

  if (runRebuild()) {
    console.log("\nDatabase rebuilt. Restart the API to serve the new content.");
  }
}

async function cmdDlcUninstall({ name, kind, purge, sourceId }) {
  const { items } = await dlc.getCatalog({ log: (message) => console.log(message) });
  const targets = resolveTargets(items, requireCatalogItem(items, name, kind, sourceId));

  let removed = 0;
  for (const item of targets) {
    console.log(`Uninstalling ${item.kind} '${item.name}'...`);
    removed += dlc.uninstallItem(item, { purge, log: (message) => console.log(message) });
  }

  if (!removed && !purge) {
    console.log(`Nothing was installed for '${name}'.`);
    return;
  }
  console.log(`\nRun npm run migrate:data to rebuild the database without this content.`);
}

function cmdDlcUpdate() {
  const results = dlcSources.syncAllEnabledSources({ log: (message) => console.log(message) });
  dlc.invalidateCatalogCache();
  if (!results.length) {
    console.error("No DLC repositories configured. Run: npm run dlc -- repo <git-url>");
    process.exitCode = 1;
    return;
  }
  console.log(`\nUpdated ${results.length} DLC repo(s).`);
  console.log("Run npm run dlc -- list to see what changed.");
}

function cmdDlcCheck() {
  if (!fs.existsSync(dlcRoot) || !fs.statSync(dlcRoot).isDirectory()) {
    console.log("DLC catalog not found. Clone it first:\n");
    console.log("  npm run dlc -- repo <git-url>");
    return;
  }

  let totalChecked = 0;
  let totalPassed = 0;
  let totalWarnings = 0;
  const failures = [];

  // Check decks
  const dlcDecksDir = path.join(dlcRoot, "decks");
  if (fs.existsSync(dlcDecksDir) && fs.statSync(dlcDecksDir).isDirectory()) {
    const entries = fs.readdirSync(dlcDecksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"));

    if (entries.length) {
      console.log(`\nDecks (${entries.length}):`);
      for (const entry of entries) {
        totalChecked++;
        const deckPath = path.join(dlcDecksDir, entry.name);
        const issues = [];

        const deckJsonPath = path.join(deckPath, "deck.json");
        if (!fs.existsSync(deckJsonPath)) {
          issues.push("missing deck.json");
        } else {
          let manifest;
          try {
            manifest = JSON.parse(fs.readFileSync(deckJsonPath, "utf8"));
          } catch (e) {
            issues.push(`invalid JSON in deck.json: ${e.message}`);
          }

          if (manifest) {
            if (!manifest.majors && !manifest.cards) {
              issues.push("no majors/cards section defined");
            }
            if (!manifest.minors && !manifest.cards) {
              issues.push("no minors section defined");
            }
          }
        }

        if (issues.length) {
          totalWarnings += issues.length;
          failures.push({ type: "deck", name: entry.name, issues });
          console.log(`  ✗ [deck] ${entry.name}`);
          for (const issue of issues) {
            console.log(`         ${issue}`);
          }
        } else {
          totalPassed++;
          console.log(`  ✓ [deck] ${entry.name}`);
        }
      }
    }
  }

  // Check packs
  const dlcPacksDir = path.join(dlcRoot, "packs");
  if (fs.existsSync(dlcPacksDir) && fs.statSync(dlcPacksDir).isDirectory()) {
    const entries = fs.readdirSync(dlcPacksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"));

    if (entries.length) {
      console.log(`\nPacks (${entries.length}):`);
      for (const entry of entries) {
        totalChecked++;
        const packPath = path.join(dlcPacksDir, entry.name);
        const issues = [];

        const packJsonPath = path.join(packPath, "pack.json");
        if (!fs.existsSync(packJsonPath)) {
          issues.push("missing pack.json");
        } else {
          let manifest;
          try {
            manifest = JSON.parse(fs.readFileSync(packJsonPath, "utf8"));
          } catch (e) {
            issues.push(`invalid JSON in pack.json: ${e.message}`);
          }

          if (manifest) {
            const items = dlc.normalizePackItems(manifest.items);
            if (!Array.isArray(manifest.items) || !manifest.items.length) {
              issues.push("missing or empty items array");
            } else if (items.length !== manifest.items.length) {
              issues.push(`${manifest.items.length - items.length} item entry(ies) missing a name`);
            }

            for (const item of items) {
              if (!item.type) {
                issues.push(`item '${item.name}' has no type (expected ${dlc.CONTENT_KINDS.join(" or ")})`);
                continue;
              }
              const category = dlc.categoryByKind(item.type);
              if (!fs.existsSync(path.join(dlcRoot, category.dir, item.name))) {
                issues.push(`item '${item.name}' not found at ${category.dir}/${item.name}`);
              }
            }
          }
        }

        if (issues.length) {
          totalWarnings += issues.length;
          failures.push({ type: "pack", name: entry.name, issues });
          console.log(`  ✗ [pack] ${entry.name}`);
          for (const issue of issues) {
            console.log(`         ${issue}`);
          }
        } else {
          totalPassed++;
          console.log(`  ✓ [pack] ${entry.name}`);
        }
      }
    }
  }

  // Check texts (folder-based: each folder contains a metadata.json manifest + content files)
  const dlcTextsDir = path.join(dlcRoot, "texts");
  if (fs.existsSync(dlcTextsDir) && fs.statSync(dlcTextsDir).isDirectory()) {
    const entries = fs.readdirSync(dlcTextsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"));

    if (entries.length) {
      console.log(`\nTexts (${entries.length}):`);
      const SUPPORTED_FORMATS = dlc.SUPPORTED_TEXT_FORMATS;

      for (const entry of entries) {
        totalChecked++;
        const textDir = path.join(dlcTextsDir, entry.name);
        const issues = [];

        // metadata.json is the universal manifest name; text.json is legacy.
        const metadataPath = path.join(textDir, "metadata.json");
        const legacyManifestPath = path.join(textDir, "text.json");
        const manifestPath = fs.existsSync(metadataPath)
          ? metadataPath
          : (fs.existsSync(legacyManifestPath) ? legacyManifestPath : null);

        if (!manifestPath) {
          issues.push("missing metadata.json manifest");
        } else {
          let manifest;
          try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          } catch (e) {
            issues.push(`invalid JSON in metadata.json: ${e.message}`);
          }

          if (manifest) {
            if (!manifest.id) issues.push("missing id in metadata.json");
            const inputPath = manifest?.input?.path || "";
            if (!inputPath) {
              issues.push("missing input.path in metadata.json");
            } else {
              const contentPath = path.join(textDir, inputPath);
              if (!fs.existsSync(contentPath)) {
                issues.push(`content file not found: ${inputPath}`);
              }
            }
            const format = manifest?.input?.format || "";
            if (!format) {
              issues.push("missing input.format in metadata.json");
            } else if (!SUPPORTED_FORMATS.has(format)) {
              issues.push(`unsupported format: ${format}`);
            }
          }
        }

        if (issues.length) {
          totalWarnings += issues.length;
          failures.push({ type: "text", name: entry.name, issues });
          console.log(`  ✗ [text] ${entry.name}/`);
          for (const issue of issues) {
            console.log(`        ${issue}`);
          }
        } else {
          totalPassed++;
          console.log(`  ✓ [text] ${entry.name}/`);
        }
      }
    }
  }

  // Check references (folder-based: reference.json manifest + entries file)
  const dlcReferencesDir = path.join(dlcRoot, "references");
  if (fs.existsSync(dlcReferencesDir) && fs.statSync(dlcReferencesDir).isDirectory()) {
    const entries = fs.readdirSync(dlcReferencesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"));

    if (entries.length) {
      console.log(`\nReferences (${entries.length}):`);
      for (const entry of entries) {
        totalChecked++;
        const refDir = path.join(dlcReferencesDir, entry.name);
        const issues = [];

        const manifestPath = path.join(refDir, "reference.json");
        if (!fs.existsSync(manifestPath)) {
          issues.push("missing reference.json manifest");
        } else {
          let manifest;
          try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          } catch (e) {
            issues.push(`invalid JSON in reference.json: ${e.message}`);
          }

          if (manifest) {
            if (!manifest.id) issues.push("missing id in reference.json");
            const kind = manifest.kind || "dictionary";
            if (!dlc.REFERENCE_KINDS.has(kind)) {
              issues.push(`unsupported kind: ${kind} (expected ${[...dlc.REFERENCE_KINDS].join(" or ")})`);
            }
            const keyScheme = manifest.keyScheme || "word";
            if (!dlc.REFERENCE_KEY_SCHEMES.has(keyScheme)) {
              issues.push(`unsupported keyScheme: ${keyScheme}`);
            }
            const entriesFile = manifest.entriesFile || "entries.json";
            if (!fs.existsSync(path.join(refDir, entriesFile))) {
              issues.push(`entries file not found: ${entriesFile}`);
            }
          }
        }

        if (issues.length) {
          totalWarnings += issues.length;
          failures.push({ type: "reference", name: entry.name, issues });
          console.log(`  ✗ [reference] ${entry.name}/`);
          for (const issue of issues) {
            console.log(`        ${issue}`);
          }
        } else {
          totalPassed++;
          console.log(`  ✓ [reference] ${entry.name}/`);
        }
      }
    }
  }

  console.log(`\n${totalChecked} item(s) checked — ${totalPassed} passed, ${failures.length} with issues (${totalWarnings} warning(s)).`);
  if (failures.length) {
    console.log(`\nFix the issues above before running dlc install / migrate:data to avoid import failures.`);
  }
}

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(argv) {
  const flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--text" || arg === "--texts") flags.type = "text";
    else if (arg === "--deck" || arg === "--decks") flags.type = "deck";
    else if (arg === "--pack" || arg === "--packs") flags.type = "pack";
    else if (arg === "--reference" || arg === "--references" || arg === "--ref") flags.type = "reference";
    else if (arg === "--plugin" || arg === "--plugins") flags.type = "plugin";
    else if (arg === "--all") flags.all = true;
    else if (arg === "--stage-only") flags.stageOnly = true;
    else if (arg === "--refresh") flags.refresh = true;
    else if (arg === "--purge") flags.purge = true;
    else if (arg === "--write") flags.write = true;
    else if (arg === "--replace") flags.replace = true;
    else if (arg === "--primary") flags.primary = true;
    else if (arg === "--name" && i + 1 < argv.length) flags.name = argv[++i];
    else if (arg === "--repo" && i + 1 < argv.length) flags.repo = argv[++i];
    else if (arg === "--source" && i + 1 < argv.length) flags.source = argv[++i];
    else if (arg === "--branch" && i + 1 < argv.length) flags.branch = argv[++i];
    else if (arg === "--remove" && i + 1 < argv.length) flags.remove = argv[++i];
    else if (arg === "--remove") flags.remove = true;
    else if (!arg.startsWith("--")) flags.positional.push(arg);
  }
  return flags;
}

async function handleDlcCommand(subArgs) {
  const subCmd = subArgs[0];
  const flags = parseFlags(subArgs.slice(1));
  const name = flags.name || flags.positional[0] || "";

  switch (subCmd) {
    case "init":
      cmdDlcInit(flags.repo || flags.positional[0] || "");
      return;
    case "repo":
      cmdDlcRepo(flags.repo || (flags.remove ? "" : flags.positional[0]) || "", {
        remove: flags.remove === true ? (flags.positional[0] || "") : (flags.remove || ""),
        replace: Boolean(flags.replace) || Boolean(flags.primary),
        primary: Boolean(flags.primary),
        name: flags.name || "",
        branch: flags.branch || ""
      });
      return;
    case "list":
      await cmdDlcList(flags.type, Boolean(flags.refresh), flags.source || "");
      return;
    case "info":
      await cmdDlcInfo(name, flags.type, flags.source || "");
      return;
    case "install":
      await cmdDlcInstall({
        name,
        kind: flags.type,
        all: Boolean(flags.all),
        stageOnly: Boolean(flags.stageOnly),
        sourceId: flags.source || ""
      });
      return;
    case "uninstall":
      await cmdDlcUninstall({
        name,
        kind: flags.type,
        purge: Boolean(flags.purge),
        sourceId: flags.source || ""
      });
      return;
    case "update":
      cmdDlcUpdate();
      return;
    case "check":
      cmdDlcCheck();
      return;
    default:
      printUsage();
  }
}

async function main() {
  const flags = parseFlags(args.slice(1));

  switch (command) {
    case "list":
      cmdList(flags.type);
      return;
    case "remove":
      cmdRemove(flags.name || flags.positional[0], flags.type);
      return;
    case "library":
      await cmdLibrary(Boolean(flags.write));
      return;
    case "dlc":
      await handleDlcCommand(args.slice(1));
      return;
    default:
      printUsage();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
