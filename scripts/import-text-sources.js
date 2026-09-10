const path = require("path");

const {
  importTextSources
} = require("../src/services/text-importer");

async function main() {
  const summary = await importTextSources();
  const imported = Array.isArray(summary?.sources) ? summary.sources : [];
  console.log(`Imported ${imported.length} text source${imported.length === 1 ? "" : "s"} into canonical JSON.`);
  imported.forEach((source) => {
    console.log(`- ${source.id} -> ${path.join("source", "data", "text", source.fileName)}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});