const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

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

// --- Submodule commands ---

function exec(args, opts = {}) {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: opts.stdio || "pipe", ...opts });
  } catch (error) {
    if (opts.ignoreError) return "";
    throw error;
  }
}

function inferSubmoduleName(repoUrl) {
  const raw = String(repoUrl || "").trim();
  const match = raw.match(/\/([^/]+?)(?:\.git)?$/);
  return match ? match[1] : "";
}

function resolveSubmodulePath(name) {
  const deckPath = path.join(decksImportRoot, name);
  const dlcPath = path.join(dlcRoot, name);

  if (fs.existsSync(deckPath) && fs.statSync(deckPath).isDirectory()) {
    return { type: "deck", filePath: deckPath };
  }
  if (fs.existsSync(dlcPath) && fs.statSync(dlcPath).isDirectory()) {
    return { type: "dlc", filePath: dlcPath };
  }

  const gitmodulesPath = path.join(projectRoot, ".gitmodules");
  if (fs.existsSync(gitmodulesPath)) {
    try {
      const content = fs.readFileSync(gitmodulesPath, "utf8");
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const sectionRe = new RegExp(`\\[submodule\\s+"([^"]*${escaped}[^"]*)"\\]`, "i");
      const match = content.match(sectionRe);
      if (match) {
        const subPath = match[1];
        if (subPath.startsWith("imports/decks/")) {
          return { type: "deck", filePath: path.join(projectRoot, subPath) };
        }
        if (subPath.startsWith("imports/dlc/")) {
          return { type: "dlc", filePath: path.join(projectRoot, subPath) };
        }
      }
    } catch (_error) {}
  }

  return null;
}

function cmdSubmoduleAdd(repoUrl, type, displayName) {
  if (!repoUrl) {
    console.error("Usage: npm run imports -- submodule add <repo-url> --deck|--dlc [name]");
    process.exit(1);
  }

  if (type === "dlc") {
    console.error("The DLC catalog is managed by the dlc commands, not submodule add.");
    console.error("  npm run dlc -- init --repo " + repoUrl);
    process.exit(1);
  }

  if (type !== "deck") {
    console.error("Specify --deck to indicate the submodule type.");
    process.exit(1);
  }

  const name = displayName || inferSubmoduleName(repoUrl);
  if (!name) {
    console.error("Could not infer a name from the repo URL. Provide one: --name <name>");
    process.exit(1);
  }

  const targetPath = path.join(decksImportRoot, name);
  const relativePath = path.relative(projectRoot, targetPath).replace(/\\/g, "/");

  fs.mkdirSync(decksImportRoot, { recursive: true });

  if (fs.existsSync(targetPath)) {
    console.error(`Path already exists: ${targetPath}`);
    console.error("Remove it first with: npm run imports -- submodule remove --name " + name);
    process.exit(1);
  }

  console.log(`Adding deck submodule '${name}' from ${repoUrl}...\n`);
  exec(["submodule", "add", "--force", repoUrl, relativePath], { stdio: "inherit" });

  const statusOut = exec(["submodule", "status", relativePath], { ignoreError: true }).trim();
  console.log(`\nSubmodule status: ${statusOut || "added"}`);
  console.log(`\n"${name}" added as a git submodule at ${relativePath}.`);
  console.log(`Run npm run migrate:data to import into the database.`);
}

function cmdSubmoduleRemove(name) {
  if (!name) {
    console.error("Usage: npm run imports -- submodule remove --name <name>");
    process.exit(1);
  }

  const resolved = resolveSubmodulePath(name);
  if (!resolved) {
    console.error(`Submodule '${name}' not found in imports/decks/ or imports/dlc/.`);
    process.exit(1);
  }

  const relativePath = path.relative(projectRoot, resolved.filePath).replace(/\\/g, "/");

  console.log(`Removing ${resolved.type} submodule '${name}' from ${relativePath}...\n`);

  exec(["submodule", "deinit", "-f", relativePath], { stdio: "inherit", ignoreError: true });
  exec(["rm", "-f", relativePath], { stdio: "inherit", ignoreError: true });

  const modPath = path.join(projectRoot, ".git", "modules", relativePath);
  if (fs.existsSync(modPath)) {
    fs.rmSync(modPath, { recursive: true, force: true });
    console.log(`  Removed: ${modPath}`);
  }

  console.log(`\nSubmodule '${name}' removed. Commit the change to complete removal.`);
  console.log(`Run npm run migrate:data to rebuild the database without this ${resolved.type}.`);
}

function cmdSubmoduleList() {
  const gitmodulesPath = path.join(projectRoot, ".gitmodules");
  if (!fs.existsSync(gitmodulesPath)) {
    console.log("No git submodules configured. Add packs/decks with:\n");
    console.log("  npm run imports -- submodule add <repo-url> --pack <name>");
    console.log("  npm run imports -- submodule add <repo-url> --deck <name>");
    return;
  }

  const statusOut = exec(["submodule", "status"], { ignoreError: true }).trim();
  if (!statusOut) {
    console.log("No submodules found.");
    return;
  }

  const lines = statusOut.split(/\r?\n/).filter(Boolean);
  const importLines = lines.filter((line) => {
    const parts = line.trim().split(/\s+/);
    const subPath = parts[parts.length - 1] || "";
    return subPath.startsWith("imports/decks/") || subPath.startsWith("imports/dlc/");
  });

  if (!importLines.length) {
    console.log("No deck or dlc submodules found.");
    return;
  }

  console.log(`\n${importLines.length} submodule(s):\n`);
  for (const line of importLines) {
    const parts = line.trim().split(/\s+/);
    const sha = parts[0] || "";
    const subPath = parts[parts.length - 1] || "";
    let type = "dlc";
    if (subPath.startsWith("imports/decks/")) type = "deck";
    const name = path.basename(subPath);
    const prefix = sha.startsWith("-") ? "  (not initialized)" : sha.startsWith("+") ? "  (modified)" : "";
    console.log(`  [${type}] ${name}  ${sha.substring(0, 8)}${prefix}`);
  }
  console.log("");
}

function cmdSubmoduleUpdate(name) {
  if (name) {
    const resolved = resolveSubmodulePath(name);
    if (!resolved) {
      console.error(`Submodule '${name}' not found.`);
      process.exit(1);
    }

    const relativePath = path.relative(projectRoot, resolved.filePath).replace(/\\/g, "/");
    console.log(`Updating submodule '${name}' to latest remote...\n`);
    exec(["submodule", "update", "--init", "--remote", relativePath], { stdio: "inherit" });
    console.log(`\n"${name}" updated. Run npm run migrate:data to rebuild the database.`);
    return;
  }

  console.log("Updating all submodules...\n");
  exec(["submodule", "update", "--init", "--remote"], { stdio: "inherit" });
  console.log("\nAll submodules updated. Run npm run migrate:data to rebuild the database.");
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

DLC catalog commands (content published in the DLC repository):
  dlc init --repo <url>           Clone the DLC catalog (metadata only, no content)
  dlc list [--refresh] [--deck|--text|--reference|--pack]
                                  Show the catalog with sizes and install status
  dlc info --name <name>          Show details for one catalog item
  dlc install --name <name> [--stage-only]
  dlc install --all [--deck|--text|--reference|--pack] [--stage-only]
                                  Download the item, stage it, and rebuild the database
  dlc uninstall --name <name> [--purge]
                                  Remove an installed item (--purge also frees the download)
  dlc update                      Fast-forward the catalog to the latest published revision
  dlc check                       Validate downloaded DLC content before importing
  dlc manifest                    (publisher) Update manifest.json only when the catalog changed

Deck submodules (for decks hosted in their own repository):
  submodule add <repo-url> --deck [--name <name>]
  submodule remove --name <name>
  submodule list
  submodule update [--name <name>]

Examples:
  npm run dlc -- init --repo <your-dlc-git-url>
  npm run dlc -- list
  npm run dlc -- install --name "Rider Waite"
  npm run dlc -- uninstall --name "Rider Waite" --purge
  npm run dlc -- update
  npm run imports -- list --deck
  npm run imports -- library --write
  npm run imports -- remove --name "my-book" --text
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
  local: "local catalog copy",
  remote: "remote repository",
  scan: "local file scan"
};

function requireCatalogItem(items, name, kind) {
  if (!name) {
    console.error("Provide an item name: --name <name>");
    process.exit(1);
  }
  const { matches, item } = dlc.findCatalogItem(items, name, kind);
  if (item) return item;
  if (!matches.length) {
    console.error(`"${name}" was not found in the DLC catalog. Run: npm run dlc -- list`);
    process.exit(1);
  }
  console.error(`"${name}" is ambiguous across ${matches.map((m) => m.kind).join(", ")}. Narrow it with --deck/--text/--pack.`);
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
  if (repoUrl) process.env.KABBAK_DLC_REPO = repoUrl;
  if (!String(process.env.KABBAK_DLC_REPO || "").trim() && !dlc.isRepoPresent() && !dlc.resolveRepoUrl()) {
    console.error(dlc.MISSING_DLC_REPO_MESSAGE);
    process.exit(1);
  }
  const { cloned, url } = dlc.ensureRepo({ log: (message) => console.log(message) });
  console.log(cloned
    ? `\nDLC catalog ready at imports/dlc (${url}).`
    : `\nDLC catalog already present at imports/dlc (${url}).`);
  console.log("Next: npm run dlc -- list");
}

async function cmdDlcList(kind, refresh) {
  const { origin, items } = await dlc.getCatalog({ refresh, log: (message) => console.log(message) });

  if (origin === "none") {
    console.error("No DLC catalog available. Run: npm run dlc -- init --repo <your-dlc-git-url>");
    process.exitCode = 1;
    return;
  }

  const visible = kind ? items.filter((item) => item.kind === kind) : items;
  if (!visible.length) {
    console.log(`No DLC items listed (source: ${ORIGIN_LABEL[origin] || origin}).`);
    return;
  }

  console.log(`\nDLC catalog — ${dlc.resolveRepoUrl()} (${dlc.resolveBranch()})`);
  console.log(`Source: ${ORIGIN_LABEL[origin] || origin}\n`);
  console.log(`${"TYPE".padEnd(6)} ${"STATUS".padEnd(10)} ${"SIZE".padStart(9)}  ${"NAME".padEnd(34)} TITLE`);
  console.log("-".repeat(92));

  for (const category of dlc.CATEGORIES) {
    const group = visible
      .filter((item) => item.kind === category.kind)
      .sort((a, b) => {
        const order = { installed: 0, staged: 1, available: 2 };
        return (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.name.localeCompare(b.name);
      });
    for (const item of group) {
      const detail = item.kind === "pack"
        ? `${item.memberCount} item(s)${item.missingCount ? `, ${item.missingCount} missing` : ""}`
        : (item.title === item.name ? "" : item.title);
      console.log(`${item.kind.padEnd(6)} ${item.status.padEnd(10)} ${dlc.formatSize(item.size).padStart(9)}  ${item.name.padEnd(34)} ${detail}`);
    }
  }

  const installed = visible.filter((item) => item.status === "installed").length;
  const staged = visible.filter((item) => item.status === "staged").length;
  console.log(`\n${visible.length} item(s) — ${installed} installed, ${staged} staged, ${visible.length - installed - staged} available.`);
  console.log(`Install one with: npm run dlc -- install --name "<name>"`);
  console.log(`Install all with: npm run dlc -- install --all`);
}

async function cmdDlcInfo(name, kind) {
  const { items } = await dlc.getCatalog({ log: (message) => console.log(message) });
  const item = requireCatalogItem(items, name, kind);
  console.log(`\n${item.title}`);
  console.log("-".repeat(Math.max(item.title.length, 12)));
  console.log(`  type         ${item.kind}`);
  console.log(`  name         ${item.name}`);
  console.log(`  id           ${item.id}`);
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

async function cmdDlcInstall({ name, kind, all, stageOnly }) {
  const { origin, items } = await dlc.getCatalog({ log: (message) => console.log(message) });
  if (origin === "none") {
    console.error("No DLC catalog available. Run: npm run dlc -- init --repo <your-dlc-git-url>");
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
    targets = resolveTargets(items, requireCatalogItem(items, name, kind));
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

async function cmdDlcUninstall({ name, kind, purge }) {
  const { items } = await dlc.getCatalog({ log: (message) => console.log(message) });
  const targets = resolveTargets(items, requireCatalogItem(items, name, kind));

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
  const head = dlc.updateRepo({ log: (message) => console.log(message) });
  console.log(`\nDLC catalog now at ${head || "latest"}.`);
  console.log("Run npm run dlc -- list to see what changed.");
}

function cmdDlcCheck() {
  if (!fs.existsSync(dlcRoot) || !fs.statSync(dlcRoot).isDirectory()) {
    console.log("DLC catalog not found. Clone it first:\n");
    console.log("  npm run dlc -- init --repo <your-dlc-git-url>");
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

function cmdDlcManifest() {
  const previous = dlc.readLocalManifest();
  const manifest = dlc.buildManifest();
  const diff = dlc.diffManifests(previous, manifest);
  const counts = `${manifest.decks.length} deck(s), ${manifest.packs.length} pack(s), ${manifest.texts.length} text(s), ${manifest.references.length} reference(s), ${manifest.plugins.length} plugin(s).`;
  if (diff.hadPrevious && !dlc.manifestHasChanges(diff)) {
    console.log(`Manifest unchanged. ${counts}`);
    for (const line of dlc.formatManifestDiff(diff)) {
      console.log(line);
    }
    return;
  }

  const manifestPath = dlc.writeManifest(manifest);
  console.log(`Wrote ${path.relative(projectRoot, manifestPath)}`);
  console.log(counts);
  for (const line of dlc.formatManifestDiff(diff)) {
    console.log(line);
  }
  console.log("Commit and push the DLC repo to publish the catalog.");
}

// --- Command routing ---

function handleSubmoduleCommand(subArgs) {
  const subCmd = subArgs[0];
  let repoUrl = "";
  let type = "";
  let name = "";

  for (let i = 1; i < subArgs.length; i++) {
    if (subArgs[i] === "--deck" || subArgs[i] === "--decks") type = "deck";
    else if (subArgs[i] === "--dlc") type = "dlc";
    else if (subArgs[i] === "--name" && i + 1 < subArgs.length) { name = subArgs[++i]; }
    else if (!repoUrl) repoUrl = subArgs[i];
  }

  switch (subCmd) {
    case "add":
      cmdSubmoduleAdd(repoUrl, type, name);
      break;
    case "remove":
      cmdSubmoduleRemove(name);
      break;
    case "list":
      cmdSubmoduleList();
      break;
    case "update":
      cmdSubmoduleUpdate(name);
      break;
    default:
      printUsage();
      break;
  }
}

// Main
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
    else if (arg === "--all") flags.all = true;
    else if (arg === "--stage-only") flags.stageOnly = true;
    else if (arg === "--refresh") flags.refresh = true;
    else if (arg === "--purge") flags.purge = true;
    else if (arg === "--write") flags.write = true;
    else if (arg === "--name" && i + 1 < argv.length) flags.name = argv[++i];
    else if (arg === "--repo" && i + 1 < argv.length) flags.repo = argv[++i];
    else if (!arg.startsWith("--")) flags.positional.push(arg);
  }
  return flags;
}

async function handleDlcCommand(subArgs) {
  const subCmd = subArgs[0];
  const flags = parseFlags(subArgs.slice(1));
  // Allow `dlc install "Rider Waite"` as a shorthand for `--name "Rider Waite"`.
  const name = flags.name || flags.positional[0] || "";

  switch (subCmd) {
    case "init":
      cmdDlcInit(flags.repo || flags.positional[0] || "");
      return;
    case "list":
      await cmdDlcList(flags.type, Boolean(flags.refresh));
      return;
    case "info":
      await cmdDlcInfo(name, flags.type);
      return;
    case "install":
      await cmdDlcInstall({ name, kind: flags.type, all: Boolean(flags.all), stageOnly: Boolean(flags.stageOnly) });
      return;
    case "uninstall":
      await cmdDlcUninstall({ name, kind: flags.type, purge: Boolean(flags.purge) });
      return;
    case "update":
      cmdDlcUpdate();
      return;
    case "check":
      cmdDlcCheck();
      return;
    case "manifest":
      cmdDlcManifest();
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
    case "submodule":
      handleSubmoduleCommand(args.slice(1));
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
