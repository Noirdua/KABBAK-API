const { DatabaseSync } = require("node:sqlite");

const { databasePath } = require("../config/paths");
const { openReadOnlyDatabase } = require("./data-loader");

const INDEX_PATH = `${databasePath}.text-search`;
let ready = false;
let building = null;
let searchDb = null;

function yieldLoop() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function verseSearchText(verse) {
  const parts = [verse?.reference, verse?.text, verse?.originalText];
  (Array.isArray(verse?.tokens) ? verse.tokens : []).forEach((token) => {
    parts.push(token?.gloss, token?.original);
    (Array.isArray(token?.strongs) ? token.strongs : []).forEach((strongId) => {
      parts.push(strongId);
    });
  });
  return parts
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase())
    .join(" ");
}

function ftsMatchQuery(normalizedQuery) {
  const query = String(normalizedQuery || "").trim().toLowerCase();
  if (!query || !/^[\p{L}\p{N} ]+$/u.test(query)) {
    return "";
  }
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return "";
  }
  return `"${tokens.join(" ")}"`;
}

function closeSearchDb() {
  if (searchDb) {
    try {
      searchDb.close();
    } catch (_error) {}
  }
  searchDb = null;
  ready = false;
}

function catalogTitles(db) {
  const titles = new Map();
  try {
    const row = db.prepare("SELECT json FROM documents WHERE key = ? LIMIT 1").get("textCatalog");
    const catalog = row?.json ? JSON.parse(row.json) : null;
    for (const source of Array.isArray(catalog?.sources) ? catalog.sources : []) {
      const id = String(source?.id || "").trim().toLowerCase();
      if (id) {
        titles.set(id, source);
      }
    }
  } catch (_error) {}
  return titles;
}

async function buildTextSearchIndex() {
  const sourceDb = openReadOnlyDatabase();
  if (!sourceDb) {
    return false;
  }
  let indexDb = null;
  try {
    const titles = catalogTitles(sourceDb);
    indexDb = new DatabaseSync(INDEX_PATH);
    indexDb.exec("DROP TABLE IF EXISTS verses");
    indexDb.exec(`
      CREATE VIRTUAL TABLE verses USING fts5(
        source_id UNINDEXED,
        source_title UNINDEXED,
        source_short_title UNINDEXED,
        work_id UNINDEXED,
        work_title UNINDEXED,
        section_id UNINDEXED,
        section_number UNINDEXED,
        section_label UNINDEXED,
        section_title UNINDEXED,
        verse_id UNINDEXED,
        verse_number UNINDEXED,
        reference UNINDEXED,
        body UNINDEXED,
        search_text,
        tokenize = "unicode61 remove_diacritics 0"
      )
    `);
    const insert = indexDb.prepare(`
      INSERT INTO verses (
        source_id, source_title, source_short_title, work_id, work_title,
        section_id, section_number, section_label, section_title,
        verse_id, verse_number, reference, body, search_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const sources = sourceDb.prepare("SELECT key, json FROM documents WHERE key LIKE 'textSource:%'");
    indexDb.exec("BEGIN");
    let pending = 0;
    for (const row of sources.iterate()) {
      const sourceId = String(row.key || "").slice("textSource:".length);
      const summary = titles.get(sourceId) || {};
      let document = null;
      try {
        document = row.json ? JSON.parse(row.json) : null;
      } catch (_error) {
        document = null;
      }
      const works = Array.isArray(document?.works) ? document.works : [];
      for (const work of works) {
        const sections = Array.isArray(work?.sections) ? work.sections : [];
        for (const section of sections) {
          const verses = Array.isArray(section?.verses) ? section.verses : [];
          for (const verse of verses) {
            insert.run(
              sourceId,
              String(summary.title || document?.title || ""),
              String(summary.shortTitle || document?.shortTitle || ""),
              String(work?.id || ""),
              String(work?.title || ""),
              String(section?.id || ""),
              section?.number == null ? "" : String(section.number),
              String(section?.label || ""),
              String(section?.title || ""),
              String(verse?.id || ""),
              verse?.number == null ? "" : String(verse.number),
              String(verse?.reference || ""),
              String(verse?.text || ""),
              verseSearchText(verse)
            );
            pending += 1;
          }
        }
      }
      document = null;
      if (pending >= 400) {
        indexDb.exec("COMMIT");
        await yieldLoop();
        indexDb.exec("BEGIN");
        pending = 0;
      }
    }
    indexDb.exec("COMMIT");
    closeSearchDb();
    searchDb = indexDb;
    indexDb = null;
    ready = true;
    return true;
  } catch (_error) {
    ready = false;
    return false;
  } finally {
    try {
      sourceDb.close();
    } catch (_error) {}
    if (indexDb) {
      try {
        indexDb.close();
      } catch (_error) {}
    }
  }
}

function startTextSearchIndex() {
  if (building) {
    return building;
  }
  building = buildTextSearchIndex().finally(() => {
    building = null;
  });
  return building;
}

function resetTextSearchIndex() {
  closeSearchDb();
  return startTextSearchIndex();
}

function searchVerses(normalizedQuery, { sourceId = "", workId = "", limit = 50 } = {}) {
  if (!ready || !searchDb) {
    return null;
  }
  const match = ftsMatchQuery(normalizedQuery);
  if (!match) {
    return null;
  }
  const bounded = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const filters = ["verses MATCH ?"];
  const params = [match];
  if (sourceId) {
    filters.push("source_id = ?");
    params.push(String(sourceId).trim().toLowerCase());
  }
  if (workId) {
    filters.push("work_id = ?");
    params.push(String(workId));
  }
  const where = filters.join(" AND ");
  try {
    const totalRow = searchDb.prepare(`SELECT count(*) AS total FROM verses WHERE ${where}`).get(...params);
    const rows = searchDb.prepare(`
      SELECT source_id, source_title, source_short_title, work_id, work_title,
        section_id, section_number, section_label, section_title,
        verse_id, verse_number, reference, body
      FROM verses
      WHERE ${where}
      ORDER BY rowid
      LIMIT ?
    `).all(...params, bounded);
    const total = Number(totalRow?.total || 0);
    return {
      total,
      truncated: total > rows.length,
      matches: rows.map((row) => ({
        sourceId: row.source_id,
        sourceTitle: row.source_title,
        sourceShortTitle: row.source_short_title,
        workId: row.work_id,
        workTitle: row.work_title,
        sectionId: row.section_id,
        sectionNumber: row.section_number === "" ? undefined : Number(row.section_number),
        sectionLabel: row.section_label,
        sectionTitle: row.section_title,
        verseId: row.verse_id,
        verseNumber: row.verse_number === "" ? undefined : Number(row.verse_number),
        reference: row.reference,
        text: row.body
      }))
    };
  } catch (_error) {
    return null;
  }
}

module.exports = {
  resetTextSearchIndex,
  searchVerses,
  startTextSearchIndex
};
