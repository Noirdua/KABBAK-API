const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
const importsRoot = path.join(projectRoot, "imports");
const sourceRoot = path.join(projectRoot, "source");
const sourceImportRoot = path.join(sourceRoot, "imports");
const sourceTextImportRoot = path.join(sourceImportRoot, "text");
const sourceDataRoot = path.join(sourceRoot, "data");
const sourceTextDataRoot = path.join(sourceDataRoot, "text");
const sourceGeneratedTextRoot = path.join(sourceTextDataRoot, "_generated");
const generatedTextSourceRegistryPath = path.join(sourceGeneratedTextRoot, "sources.generated.json");
const textLibraryRegistryPath = path.join(sourceTextDataRoot, "library.json");
const sourceAssetRoot = path.join(sourceRoot, "assets");
const sourceDecksRoot = path.join(sourceAssetRoot, "tarot deck");
const sourceRuntimeRoot = path.join(sourceRoot, "runtime");
const sourceRuntimeAppRoot = path.join(sourceRuntimeRoot, "app");
const dlcRoot = path.join(importsRoot, "dlc");
const dlcSourcesRoot = path.join(importsRoot, "dlc-sources");
const decksImportRoot = path.join(importsRoot, "decks");
const textImportRoot = path.join(importsRoot, "text");
const referencesImportRoot = path.join(importsRoot, "references");
const storageRoot = path.join(projectRoot, "storage");
const storageConfigRoot = path.join(storageRoot, "config");
const databasePath = path.join(storageRoot, "kabbak.db");
const dataRoot = path.join(storageRoot, "data");
const assetRoot = path.join(storageRoot, "assets");
const imgRoot = path.join(assetRoot, "img");
const runtimeRoot = path.join(storageRoot, "runtime");
const runtimeAppRoot = path.join(runtimeRoot, "app");
const decksRoot = path.join(assetRoot, "tarot deck");
const deckRegistryPath = path.join(decksRoot, "decks.json");
const managedApiClientsPath = path.join(storageConfigRoot, "api-clients.json");
const apiRolesPath = path.join(storageConfigRoot, "api-roles.json");
const apiAccessLevelsPath = path.join(storageConfigRoot, "api-access-levels.json");

module.exports = {
  projectRoot,
  sourceRoot,
  sourceImportRoot,
  sourceTextImportRoot,
  sourceDataRoot,
  sourceTextDataRoot,
  sourceGeneratedTextRoot,
  generatedTextSourceRegistryPath,
  textLibraryRegistryPath,
  sourceAssetRoot,
  sourceDecksRoot,
  sourceRuntimeRoot,
  sourceRuntimeAppRoot,
  storageRoot,
  storageConfigRoot,
  databasePath,
  dataRoot,
  assetRoot,
  imgRoot,
  runtimeRoot,
  runtimeAppRoot,
  decksRoot,
  deckRegistryPath,
  managedApiClientsPath,
  apiRolesPath,
  apiAccessLevelsPath,
  decksImportRoot,
  textImportRoot,
  referencesImportRoot,
  dlcRoot,
  dlcSourcesRoot
};