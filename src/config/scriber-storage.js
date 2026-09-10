const path = require("node:path");

const { storageRoot } = require("./paths");

const scriberRoot = path.join(storageRoot, "scriber");

const MAX_SCRIBER_DOCUMENTS = 300;
const MAX_SCRIBER_TITLE_LENGTH = 200;
const MAX_SCRIBER_TEXT_LENGTH = 400 * 1024;

module.exports = {
  scriberRoot,
  MAX_SCRIBER_DOCUMENTS,
  MAX_SCRIBER_TITLE_LENGTH,
  MAX_SCRIBER_TEXT_LENGTH
};
