"use strict";

const fs = require("fs");
const path = require("path");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUInt16LE(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function writeUInt16LE(buffer, offset, value) {
  buffer.writeUInt16LE(value >>> 0, offset);
}

function writeUInt32LE(buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function normalizeZipPath(name) {
  return String(name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function packStoreZip(files) {
  const entries = (Array.isArray(files) ? files : []).map((file) => {
    const name = normalizeZipPath(file?.name);
    const data = Buffer.isBuffer(file?.data) ? file.data : Buffer.from(file?.data || []);
    if (!name || !data.length) {
      return null;
    }
    return { name, data, crc: crc32(data) };
  }).filter(Boolean);

  const locals = [];
  const centrals = [];
  let offset = 0;
  entries.forEach((entry) => {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30 + nameBuf.length);
    local.write("PK\u0003\u0004", 0, "binary");
    writeUInt16LE(local, 4, 20);
    writeUInt16LE(local, 8, 0);
    writeUInt32LE(local, 14, entry.crc);
    writeUInt32LE(local, 18, entry.data.length);
    writeUInt32LE(local, 22, entry.data.length);
    writeUInt16LE(local, 26, nameBuf.length);
    nameBuf.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.write("PK\u0001\u0002", 0, "binary");
    writeUInt16LE(central, 4, 20);
    writeUInt16LE(central, 6, 20);
    writeUInt32LE(central, 16, entry.crc);
    writeUInt32LE(central, 20, entry.data.length);
    writeUInt32LE(central, 24, entry.data.length);
    writeUInt16LE(central, 28, nameBuf.length);
    writeUInt32LE(central, 42, offset);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.data.length;
  });

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.write("PK\u0005\u0006", 0, "binary");
  writeUInt16LE(eocd, 8, entries.length);
  writeUInt16LE(eocd, 10, entries.length);
  writeUInt32LE(eocd, 12, centralSize);
  writeUInt32LE(eocd, 16, offset);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function findEocdOffset(buffer) {
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer[offset] === 0x50 && buffer[offset + 1] === 0x4b && buffer[offset + 2] === 0x05 && buffer[offset + 3] === 0x06) {
      return offset;
    }
  }
  return -1;
}

function unpackStoreZip(buffer) {
  const zip = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const eocd = findEocdOffset(zip);
  if (eocd < 0) {
    throw new Error("Not a zip archive.");
  }
  const count = readUInt16LE(zip, eocd + 10);
  const centralSize = readUInt32LE(zip, eocd + 12);
  const centralOffset = readUInt32LE(zip, eocd + 16);
  const files = [];
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > centralEnd || zip[cursor] !== 0x50 || zip[cursor + 1] !== 0x4b) {
      throw new Error("Zip directory is truncated.");
    }
    const method = readUInt16LE(zip, cursor + 10);
    const crc = readUInt32LE(zip, cursor + 16);
    const size = readUInt32LE(zip, cursor + 20);
    const nameLength = readUInt16LE(zip, cursor + 28);
    const extraLength = readUInt16LE(zip, cursor + 30);
    const commentLength = readUInt16LE(zip, cursor + 32);
    const localOffset = readUInt32LE(zip, cursor + 42);
    const name = zip.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    const safeName = normalizeZipPath(name);
    if (!safeName || safeName.endsWith("/")) {
      continue;
    }
    if (method !== 0) {
      throw new Error(`Zip entry '${safeName}' is compressed. Upload an uncompressed zip.`);
    }
    const localNameLength = readUInt16LE(zip, localOffset + 26);
    const localExtraLength = readUInt16LE(zip, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.slice(dataStart, dataStart + size);
    if (data.length !== size) {
      throw new Error(`Zip entry '${safeName}' is truncated.`);
    }
    if (crc32(data) !== crc) {
      throw new Error(`Zip entry '${safeName}' failed checksum.`);
    }
    files.push({ name: safeName, data });
  }
  return files;
}

function packDirectory(rootDir, {
  skipNames = ["thumbs", "node_modules"],
  skipFiles = [],
  skipFilePattern = null
} = {}) {
  const skipDirs = new Set((skipNames || []).map((name) => String(name).toLowerCase()));
  const skipFileSet = new Set((skipFiles || []).map((name) => String(name).toLowerCase()));
  const files = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    entries.forEach((entry) => {
      if (entry.name.startsWith(".")) {
        return;
      }
      const lower = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (skipDirs.has(lower)) {
          return;
        }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        walk(path.join(dir, entry.name), relative);
        return;
      }
      if (!entry.isFile()) {
        return;
      }
      if (skipFileSet.has(lower) || (skipFilePattern && skipFilePattern.test(entry.name))) {
        return;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      files.push({
        name: relative.replace(/\\/g, "/"),
        data: fs.readFileSync(path.join(dir, entry.name))
      });
    });
  };
  walk(path.resolve(rootDir), "");
  return packStoreZip(files);
}

module.exports = {
  crc32,
  normalizeZipPath,
  packDirectory,
  packStoreZip,
  unpackStoreZip
};
