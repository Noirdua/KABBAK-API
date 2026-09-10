const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const skippedDirectoryNames = new Set(["node_modules", ".git"]);

function collectJavaScriptFiles(targetPath, results = []) {
  const resolvedPath = path.resolve(targetPath);
  if (!fs.existsSync(resolvedPath)) {
    return results;
  }

  const stats = fs.statSync(resolvedPath);
  if (stats.isDirectory()) {
    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && skippedDirectoryNames.has(entry.name)) {
        continue;
      }

      collectJavaScriptFiles(path.join(resolvedPath, entry.name), results);
    }
    return results;
  }

  if (stats.isFile() && resolvedPath.endsWith(".js")) {
    results.push(resolvedPath);
  }

  return results;
}

function main() {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error("Provide at least one file or directory to validate.");
    process.exit(1);
  }

  const files = Array.from(new Set(
    targets.flatMap((targetPath) => collectJavaScriptFiles(targetPath))
  )).sort();

  if (!files.length) {
    console.error("No JavaScript files were found for validation.");
    process.exit(1);
  }

  let hasFailures = false;

  for (const filePath of files) {
    const result = spawnSync(process.execPath, ["--check", filePath], {
      encoding: "utf8"
    });

    if (result.status === 0) {
      continue;
    }

    hasFailures = true;
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${filePath}\n`);
  }

  if (hasFailures) {
    process.exit(1);
  }

  console.log(`Syntax check passed for ${files.length} files.`);
}

main();