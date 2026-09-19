const fs = require("node:fs");
const path = require("node:path");

// Write via a temp file in the same directory and rename, so a crash mid-write
// can never leave a truncated JSON document behind.
function writeFileAtomicSync(filePath, contents, { encoding = "utf8" } = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  try {
    fs.writeFileSync(tempPath, contents, { encoding });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (_cleanupError) {}
    throw error;
  }
}

module.exports = {
  writeFileAtomicSync
};
