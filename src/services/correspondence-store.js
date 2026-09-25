const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { storageRoot } = require("../config/paths");
const { openReadOnlyDatabase } = require("./data-loader");

const STORE_PATH = path.join(storageRoot, "correspondences.db");
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS correspondence_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS correspondence_collections (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS correspondence_entities (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    ordinal INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS correspondence_aliases (
    kind TEXT NOT NULL,
    alias TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (kind, alias)
  );
  CREATE TABLE IF NOT EXISTS correspondence_relations (
    from_kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    to_kind TEXT NOT NULL,
    to_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (from_kind, from_id, relation, to_kind, to_id)
  );
  CREATE INDEX IF NOT EXISTS idx_correspondence_rel_from
    ON correspondence_relations(from_kind, from_id);
  CREATE INDEX IF NOT EXISTS idx_correspondence_rel_to
    ON correspondence_relations(to_kind, to_id);
`;

let storeDb = null;
let storeReady = false;
let building = null;
const collectionCache = new Map();

function slug(value) {
  return String(value ?? "").trim().toLowerCase();
}

function createBucket() {
  return {
    entities: [],
    aliases: [],
    relations: [],
    collections: [],
    seenEntities: new Set(),
    seenAliases: new Set(),
    seenRelations: new Set()
  };
}

function pushEntity(bucket, kind, id, name, payload, ordinal = 0) {
  const key = slug(id);
  if (!kind || !key) return;
  const token = `${kind}\0${key}`;
  if (bucket.seenEntities.has(token)) return;
  bucket.seenEntities.add(token);
  bucket.entities.push({
    kind,
    id: key,
    name: String(name || key),
    ordinal: Number.isFinite(Number(ordinal)) ? Number(ordinal) : 0,
    payload
  });
  pushAlias(bucket, kind, key, key);
}

function pushAlias(bucket, kind, alias, id) {
  const aliasKey = slug(alias);
  const target = slug(id);
  if (!kind || !aliasKey || !target) return;
  const token = `${kind}\0${aliasKey}`;
  if (bucket.seenAliases.has(token)) return;
  bucket.seenAliases.add(token);
  bucket.aliases.push({ kind, alias: aliasKey, id: target });
}

function pushRelation(bucket, fromKind, fromId, relation, toKind, toId, label = "") {
  const from = slug(fromId);
  const to = slug(toId);
  const rel = slug(relation);
  if (!fromKind || !from || !rel || !toKind || !to) return;
  const token = `${fromKind}\0${from}\0${rel}\0${toKind}\0${to}`;
  if (bucket.seenRelations.has(token)) return;
  bucket.seenRelations.add(token);
  bucket.relations.push({
    fromKind,
    fromId: from,
    relation: rel,
    toKind,
    toId: to,
    label: String(label || "")
  });
}

function pushCollection(bucket, key, value) {
  bucket.collections.push({ key, payload: value == null ? {} : value });
}

function rememberTarot(bucket, cardName, trumpNumber) {
  const name = String(cardName || "").trim();
  const id = slug(name);
  if (!id) return id;
  pushEntity(bucket, "tarot-card", id, name, {
    name,
    trumpNumber: trumpNumber == null ? null : Number(trumpNumber)
  }, trumpNumber ?? 0);
  if (trumpNumber != null && Number.isFinite(Number(trumpNumber))) {
    pushAlias(bucket, "tarot-card", String(trumpNumber), id);
  }
  return id;
}

function extractCorrespondence(magickDataset, referenceData) {
  const bucket = createBucket();
  const grouped = magickDataset?.grouped || {};
  const planets = referenceData?.planets || {};
  const signs = Array.isArray(referenceData?.signs) ? referenceData.signs : [];
  const decansBySign = referenceData?.decansBySign || {};
  const iching = referenceData?.iChing || {};
  const kabbalah = grouped.kabbalah || {};
  const tree = kabbalah["kabbalah-tree"] || {};
  const planetIdByName = new Map();

  pushCollection(bucket, "magick:alphabets", grouped.alphabets || {});
  pushCollection(bucket, "magick:chakras", grouped.chakras || {});
  pushCollection(bucket, "magick:enochian", grouped.enochian || {});
  pushCollection(bucket, "magick:gods", grouped.gods || {});
  pushCollection(bucket, "magick:kabbalah", kabbalah);
  pushCollection(bucket, "magick:numbers", grouped.numbers || {});
  pushCollection(bucket, "magick:playing-cards", grouped["playing-cards-52"] || {});
  pushCollection(bucket, "magick:tattvas", grouped.alchemy?.tattvas || {});
  pushCollection(bucket, "reference:planets", planets);
  pushCollection(bucket, "reference:signs", signs);
  pushCollection(bucket, "reference:decansBySign", decansBySign);
  pushCollection(bucket, "reference:calendarMonths", referenceData?.calendarMonths || []);
  pushCollection(bucket, "reference:calendarHolidays", referenceData?.calendarHolidays || []);
  pushCollection(bucket, "reference:celestialHolidays", referenceData?.celestialHolidays || []);
  pushCollection(bucket, "reference:iChing", iching);
  pushCollection(bucket, "reference:sabianSymbols", Array.isArray(referenceData?.sabianSymbols) ? referenceData.sabianSymbols : []);
  pushCollection(bucket, "reference:tarotCourt", {
    courtDateRanges: referenceData?.tarotDatabase?.courtDateRanges || {},
    courtDecanWindows: referenceData?.tarotDatabase?.courtDecanWindows || {}
  });

  Object.entries(planets).forEach(([id, planet], ordinal) => {
    pushEntity(bucket, "planet", id, planet?.name || id, planet, ordinal);
    pushAlias(bucket, "planet", planet?.name, id);
    planetIdByName.set(slug(id), slug(id));
    planetIdByName.set(slug(planet?.name), slug(id));
    const cardId = rememberTarot(bucket, planet?.tarot?.majorArcana, planet?.tarot?.number);
    if (cardId) pushRelation(bucket, "planet", id, "tarot", "tarot-card", cardId, planet.tarot.majorArcana);
  });

  signs.forEach((sign, ordinal) => {
    pushEntity(bucket, "sign", sign?.id, sign?.name || sign?.id, sign, ordinal);
    pushAlias(bucket, "sign", sign?.name, sign?.id);
    if (sign?.rulingPlanetId) {
      pushRelation(bucket, "sign", sign.id, "ruled-by", "planet", sign.rulingPlanetId, sign.rulingPlanetId);
    }
    const cardId = rememberTarot(bucket, sign?.tarot?.majorArcana, sign?.tarot?.number);
    if (cardId) pushRelation(bucket, "sign", sign.id, "tarot", "tarot-card", cardId, sign.tarot.majorArcana);
  });

  Object.values(decansBySign).flat().forEach((decan, ordinal) => {
    pushEntity(bucket, "decan", decan?.id, decan?.id, decan, ordinal);
    if (decan?.signId) pushRelation(bucket, "decan", decan.id, "of-sign", "sign", decan.signId, decan.signId);
    if (decan?.rulerPlanetId) {
      pushRelation(bucket, "decan", decan.id, "ruled-by", "planet", decan.rulerPlanetId, decan.rulerPlanetId);
    }
    const cardId = rememberTarot(bucket, decan?.tarotMinorArcana, null);
    if (cardId) pushRelation(bucket, "decan", decan.id, "tarot", "tarot-card", cardId, decan.tarotMinorArcana);
  });

  (Array.isArray(iching.trigrams) ? iching.trigrams : []).forEach((trigram, ordinal) => {
    pushEntity(bucket, "trigram", trigram?.name, trigram?.name, trigram, ordinal);
  });
  (Array.isArray(iching.hexagrams) ? iching.hexagrams : []).forEach((hexagram, ordinal) => {
    const id = hexagram?.number;
    pushEntity(bucket, "hexagram", id, hexagram?.name || id, hexagram, ordinal);
    pushAlias(bucket, "hexagram", hexagram?.name, id);
    if (hexagram?.upperTrigram) {
      pushRelation(bucket, "hexagram", id, "upper-trigram", "trigram", hexagram.upperTrigram, hexagram.upperTrigram);
    }
    if (hexagram?.lowerTrigram) {
      pushRelation(bucket, "hexagram", id, "lower-trigram", "trigram", hexagram.lowerTrigram, hexagram.lowerTrigram);
    }
    const planetId = planetIdByName.get(slug(hexagram?.planetaryInfluence));
    if (planetId) {
      pushRelation(bucket, "hexagram", id, "planet", "planet", planetId, hexagram.planetaryInfluence);
    }
  });

  (Array.isArray(tree.sephiroth) ? tree.sephiroth : []).forEach((sephirah, ordinal) => {
    const id = sephirah?.sephiraId || sephirah?.name;
    pushEntity(bucket, "sephirah", id, sephirah?.name || id, sephirah, ordinal);
    pushAlias(bucket, "sephirah", sephirah?.name, id);
    pushAlias(bucket, "sephirah", sephirah?.number, id);
    const planetId = planetIdByName.get(slug(sephirah?.planet));
    if (planetId) pushRelation(bucket, "sephirah", id, "planet", "planet", planetId, sephirah.planet);
  });

  (Array.isArray(tree.paths) ? tree.paths : []).forEach((pathEntry, ordinal) => {
    const id = pathEntry?.pathNumber;
    pushEntity(bucket, "kabbalah-path", id, `Path ${id}`, pathEntry, ordinal);
    pushAlias(bucket, "kabbalah-path", pathEntry?.hebrewLetter?.transliteration, id);
    pushAlias(bucket, "kabbalah-path", pathEntry?.tarot?.card, id);
    if (pathEntry?.connectIds?.from) {
      pushRelation(bucket, "kabbalah-path", id, "connects", "sephirah", pathEntry.connectIds.from, pathEntry.connects?.from);
    }
    if (pathEntry?.connectIds?.to) {
      pushRelation(bucket, "kabbalah-path", id, "connects", "sephirah", pathEntry.connectIds.to, pathEntry.connects?.to);
    }
    const letter = pathEntry?.hebrewLetter?.transliteration;
    if (letter) {
      pushEntity(bucket, "hebrew-letter", letter, letter, pathEntry.hebrewLetter, ordinal);
      pushRelation(bucket, "kabbalah-path", id, "hebrew-letter", "hebrew-letter", letter, letter);
    }
    const cardId = rememberTarot(bucket, pathEntry?.tarot?.card, pathEntry?.tarot?.trumpNumber);
    if (cardId) pushRelation(bucket, "kabbalah-path", id, "tarot", "tarot-card", cardId, pathEntry.tarot.card);
    const astrology = pathEntry?.astrology;
    if (astrology?.name) {
      const toKind = slug(astrology.type) === "planet" ? "planet" : slug(astrology.type) || "astrology";
      const target = toKind === "planet" ? (planetIdByName.get(slug(astrology.name)) || astrology.name) : astrology.name;
      pushRelation(bucket, "kabbalah-path", id, "astrology", toKind, target, astrology.name);
    }
  });

  return bucket;
}

function writeCorrespondenceTables(database, { magickDataset, referenceData, stamp = "" } = {}) {
  database.exec(SCHEMA);
  database.exec("DELETE FROM correspondence_entities;");
  database.exec("DELETE FROM correspondence_aliases;");
  database.exec("DELETE FROM correspondence_relations;");
  database.exec("DELETE FROM correspondence_collections;");
  const extracted = extractCorrespondence(magickDataset, referenceData);
  const putEntity = database.prepare(
    "INSERT INTO correspondence_entities (kind, id, name, ordinal, payload) VALUES (?, ?, ?, ?, ?)"
  );
  const putAlias = database.prepare(
    "INSERT OR REPLACE INTO correspondence_aliases (kind, alias, id) VALUES (?, ?, ?)"
  );
  const putRelation = database.prepare(
    "INSERT INTO correspondence_relations (from_kind, from_id, relation, to_kind, to_id, label) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const putCollection = database.prepare(
    "INSERT INTO correspondence_collections (key, payload) VALUES (?, ?)"
  );
  database.exec("BEGIN");
  for (const entity of extracted.entities) {
    putEntity.run(entity.kind, entity.id, entity.name, entity.ordinal, JSON.stringify(entity.payload));
  }
  for (const alias of extracted.aliases) {
    putAlias.run(alias.kind, alias.alias, alias.id);
  }
  for (const relation of extracted.relations) {
    putRelation.run(relation.fromKind, relation.fromId, relation.relation, relation.toKind, relation.toId, relation.label);
  }
  for (const collection of extracted.collections) {
    putCollection.run(collection.key, JSON.stringify(collection.payload));
  }
  database.prepare("INSERT OR REPLACE INTO correspondence_meta (key, value) VALUES ('stamp', ?)").run(String(stamp || ""));
  database.exec("COMMIT");
  return {
    entities: extracted.entities.length,
    relations: extracted.relations.length
  };
}

function sourceStamp(database) {
  try {
    const rows = database.prepare(
      "SELECT key, updated_at FROM documents WHERE key IN ('magickDataset', 'referenceData') ORDER BY key"
    ).all();
    return `v2|${rows.map((row) => `${row.key}:${row.updated_at || ""}`).join("|")}`;
  } catch (_error) {
    return "";
  }
}

function storeHasData(database) {
  try {
    const row = database.prepare("SELECT count(*) AS total FROM correspondence_entities").get();
    return Number(row?.total || 0) > 0;
  } catch (_error) {
    return false;
  }
}

function useDatabase(database) {
  if (storeDb && storeDb !== database) {
    try { storeDb.close(); } catch (_error) {}
  }
  storeDb = database;
  storeReady = true;
  collectionCache.clear();
}

function readDocuments(database) {
  const read = database.prepare("SELECT json FROM documents WHERE key = ? LIMIT 1");
  const magickRow = read.get("magickDataset");
  const referenceRow = read.get("referenceData");
  return {
    magickDataset: magickRow?.json ? JSON.parse(magickRow.json) : null,
    referenceData: referenceRow?.json ? JSON.parse(referenceRow.json) : null
  };
}

function buildSidecar(source) {
  const stamp = sourceStamp(source);
  const sidecar = new DatabaseSync(STORE_PATH);
  try {
    const existingStamp = (() => {
      try {
        return sidecar.prepare("SELECT value FROM correspondence_meta WHERE key = 'stamp'").get()?.value || "";
      } catch (_error) {
        return "";
      }
    })();
    if (existingStamp && existingStamp === stamp && storeHasData(sidecar)) {
      useDatabase(sidecar);
      return true;
    }
    const documents = readDocuments(source);
    writeCorrespondenceTables(sidecar, { ...documents, stamp });
    useDatabase(sidecar);
    return true;
  } catch (error) {
    try { sidecar.close(); } catch (_closeError) {}
    throw error;
  }
}

async function ensureCorrespondenceStore() {
  if (storeReady && storeDb) return true;
  if (building) return building;
  building = Promise.resolve().then(() => {
    const source = openReadOnlyDatabase();
    if (!source) return false;
    try {
      const stamp = sourceStamp(source);
      if (storeHasData(source)) {
        let mainStamp = "";
        try {
          mainStamp = source.prepare("SELECT value FROM correspondence_meta WHERE key = 'stamp'").get()?.value || "";
        } catch (_error) {
          mainStamp = "";
        }
        if (mainStamp && mainStamp === stamp) {
          useDatabase(source);
          return true;
        }
      }
      return buildSidecar(source);
    } finally {
      if (storeDb !== source) {
        try { source.close(); } catch (_error) {}
      }
    }
  }).finally(() => {
    building = null;
  });
  return building;
}

function resetCorrespondenceStore() {
  storeReady = false;
  collectionCache.clear();
  if (storeDb) {
    try { storeDb.close(); } catch (_error) {}
  }
  storeDb = null;
  try {
    fs.rmSync(STORE_PATH, { force: true });
  } catch (_error) {}
  return ensureCorrespondenceStore();
}

function getCollection(key) {
  if (!storeReady || !storeDb) return null;
  if (collectionCache.has(key)) return collectionCache.get(key);
  try {
    const row = storeDb.prepare("SELECT payload FROM correspondence_collections WHERE key = ?").get(key);
    if (!row?.payload) return null;
    const value = JSON.parse(row.payload);
    collectionCache.set(key, value);
    return value;
  } catch (_error) {
    return null;
  }
}

function resolveEntityId(kind, id) {
  const alias = slug(id);
  if (!storeReady || !storeDb || !kind || !alias) return "";
  const row = storeDb.prepare(
    "SELECT id FROM correspondence_aliases WHERE kind = ? AND alias = ?"
  ).get(kind, alias);
  return row?.id || "";
}

function getEntityRecord(kind, id) {
  if (!storeReady || !storeDb) return null;
  const resolved = resolveEntityId(kind, id) || slug(id);
  if (!resolved) return null;
  const row = storeDb.prepare(
    "SELECT id, name, payload FROM correspondence_entities WHERE kind = ? AND id = ?"
  ).get(kind, resolved);
  if (!row) return null;
  return {
    kind,
    id: row.id,
    name: row.name,
    entity: JSON.parse(row.payload)
  };
}

function getEntityRelations(kind, id) {
  if (!storeReady || !storeDb) return [];
  const resolved = resolveEntityId(kind, id) || slug(id);
  if (!resolved) return [];
  const rows = storeDb.prepare(`
    SELECT from_kind, from_id, relation, to_kind, to_id, label
    FROM correspondence_relations
    WHERE (from_kind = ? AND from_id = ?) OR (to_kind = ? AND to_id = ?)
    ORDER BY relation, to_kind, to_id, from_kind, from_id
  `).all(kind, resolved, kind, resolved);
  return rows.map((row) => {
    const outgoing = row.from_kind === kind && row.from_id === resolved;
    return {
      direction: outgoing ? "out" : "in",
      relation: row.relation,
      kind: outgoing ? row.to_kind : row.from_kind,
      id: outgoing ? row.to_id : row.from_id,
      label: row.label
    };
  });
}

function listCorrespondenceKinds() {
  if (!storeReady || !storeDb) return [];
  return storeDb.prepare(
    "SELECT kind, count(*) AS count FROM correspondence_entities GROUP BY kind ORDER BY kind"
  ).all().map((row) => ({ kind: row.kind, count: Number(row.count || 0) }));
}

module.exports = {
  ensureCorrespondenceStore,
  extractCorrespondence,
  getCollection,
  getEntityRecord,
  getEntityRelations,
  listCorrespondenceKinds,
  resetCorrespondenceStore,
  writeCorrespondenceTables
};
