const DEFAULT_KIND = "commentary";
const MAX_ORDER = Number.MAX_SAFE_INTEGER;

function normalizeSingleLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBody(value) {
  if (Array.isArray(value)) {
    return value
      .map((line) => String(line ?? ""))
      .join("\n")
      .replace(/\r\n?/g, "\n")
      .trim();
  }

  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeKind(value, fallback = DEFAULT_KIND) {
  const kind = normalizeSingleLine(value).toLowerCase();
  return kind || fallback;
}

function toOrder(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isCanonicalCardId(value) {
  return /^(major|minor)-[a-z0-9-]+$/i.test(normalizeSingleLine(value));
}

function compareByOrderThenTitle(left, right) {
  const leftOrder = Number.isFinite(Number(left?.order)) ? Number(left.order) : MAX_ORDER;
  const rightOrder = Number.isFinite(Number(right?.order)) ? Number(right.order) : MAX_ORDER;

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return String(left?.title || left?.id || "").localeCompare(String(right?.title || right?.id || ""));
}

function collectRawEntries(rawEntries) {
  if (Array.isArray(rawEntries)) {
    return rawEntries;
  }

  if (!rawEntries || typeof rawEntries !== "object") {
    return [];
  }

  return Object.entries(rawEntries)
    .map(([key, value]) => {
      if (value == null) {
        return null;
      }

      const cardId = isCanonicalCardId(key) ? key : "";
      const card = cardId ? "" : key;

      if (typeof value === "string") {
        return { cardId, card, body: value };
      }

      if (Array.isArray(value)) {
        return { cardId, card, lines: value };
      }

      if (typeof value !== "object") {
        return null;
      }

      const entry = { ...value };
      if (!entry.cardId && !entry.card && !entry.cardName) {
        if (cardId) {
          entry.cardId = cardId;
        } else {
          entry.card = card;
        }
      }

      return entry;
    })
    .filter(Boolean);
}

function normalizeEntry(rawEntry, index, collectionKind) {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return null;
  }

  const cardId = normalizeSingleLine(rawEntry.cardId).toLowerCase();
  const card = normalizeSingleLine(rawEntry.card || rawEntry.cardName);
  const body = normalizeBody(rawEntry.body ?? rawEntry.text ?? rawEntry.content ?? rawEntry.lines);
  if (!body || (!cardId && !card)) {
    return null;
  }

  const fallbackId = `${cardId || slugify(card) || "entry"}-${index + 1}`;

  return {
    id: slugify(rawEntry.id || fallbackId) || fallbackId,
    cardId,
    card,
    title: normalizeSingleLine(rawEntry.title || rawEntry.label),
    kind: normalizeKind(rawEntry.kind, collectionKind),
    body,
    author: normalizeSingleLine(rawEntry.author),
    year: normalizeSingleLine(rawEntry.year),
    sourceUrl: normalizeSingleLine(rawEntry.sourceUrl || rawEntry.url),
    license: normalizeSingleLine(rawEntry.license),
    order: toOrder(rawEntry.order, index)
  };
}

function dedupeEntryIds(entries) {
  const seen = new Set();

  return entries.map((entry) => {
    let id = entry.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${entry.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);

    return id === entry.id ? entry : { ...entry, id };
  });
}

function normalizeCommentaryCollection(rawCollection, index, options = {}) {
  if (!rawCollection || typeof rawCollection !== "object" || Array.isArray(rawCollection)) {
    return null;
  }

  const sourceFile = normalizeSingleLine(options.sourceFile);
  const fileStem = sourceFile ? sourceFile.replace(/\.json$/i, "") : "";
  const id = slugify(rawCollection.id || rawCollection.slug || rawCollection.title || fileStem || `collection-${index + 1}`);
  if (!id) {
    return null;
  }

  const kind = normalizeKind(rawCollection.kind);
  const rawEntries = rawCollection.entries ?? rawCollection.commentaries ?? rawCollection.items ?? null;
  const entries = dedupeEntryIds(
    collectRawEntries(rawEntries)
      .map((entry, entryIndex) => normalizeEntry(entry, entryIndex, kind))
      .filter(Boolean)
  );

  if (!entries.length) {
    return null;
  }

  return {
    id,
    title: normalizeSingleLine(rawCollection.title || rawCollection.label || rawCollection.name) || id,
    author: normalizeSingleLine(rawCollection.author),
    year: normalizeSingleLine(rawCollection.year),
    kind,
    description: normalizeSingleLine(rawCollection.description || rawCollection.summary),
    license: normalizeSingleLine(rawCollection.license),
    sourceUrl: normalizeSingleLine(rawCollection.sourceUrl || rawCollection.url),
    order: toOrder(rawCollection.order, index),
    sourceFile,
    entries: entries.sort(compareByOrderThenTitle)
  };
}

function looksLikeCollection(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      value.id
      || value.title
      || value.label
      || value.name
      || value.author
      || value.entries
      || value.commentaries
      || value.items
    )
  );
}

function normalizeCommentaryDocument(rawDocument, options = {}) {
  const collections = [];

  if (Array.isArray(rawDocument?.collections)) {
    rawDocument.collections.forEach((collection, index) => {
      const normalized = normalizeCommentaryCollection(collection, index, options);
      if (normalized) {
        collections.push(normalized);
      }
    });
  } else if (Array.isArray(rawDocument)) {
    rawDocument.forEach((collection, index) => {
      const normalized = normalizeCommentaryCollection(collection, index, options);
      if (normalized) {
        collections.push(normalized);
      }
    });
  } else if (rawDocument && typeof rawDocument === "object") {
    const collection = looksLikeCollection(rawDocument)
      ? rawDocument
      : { entries: rawDocument };
    const normalized = normalizeCommentaryCollection(collection, 0, options);
    if (normalized) {
      collections.push(normalized);
    }
  }

  const seenIds = new Set();
  const uniqueCollections = collections
    .sort(compareByOrderThenTitle)
    .map((collection) => {
      let id = collection.id;
      let suffix = 2;
      while (seenIds.has(id)) {
        id = `${collection.id}-${suffix}`;
        suffix += 1;
      }
      seenIds.add(id);
      return id === collection.id ? collection : { ...collection, id };
    });

  return { collections: uniqueCollections };
}

function buildCommentaryIndex(rawDocument, options = {}) {
  const document = normalizeCommentaryDocument(rawDocument);
  const resolveCardId = typeof options.resolveCardId === "function"
    ? options.resolveCardId
    : (entry) => entry.cardId || entry.card;
  const index = new Map();

  document.collections.forEach((collection) => {
    collection.entries.forEach((entry) => {
      const cardId = normalizeSingleLine(resolveCardId(entry, collection));
      if (!cardId) {
        return;
      }

      let collectionsByCard = index.get(cardId);
      if (!collectionsByCard) {
        collectionsByCard = new Map();
        index.set(cardId, collectionsByCard);
      }

      let cardCollection = collectionsByCard.get(collection.id);
      if (!cardCollection) {
        cardCollection = {
          id: collection.id,
          title: collection.title,
          author: collection.author,
          year: collection.year,
          kind: collection.kind,
          description: collection.description,
          license: collection.license,
          sourceUrl: collection.sourceUrl,
          order: collection.order,
          entries: []
        };
        collectionsByCard.set(collection.id, cardCollection);
      }

      cardCollection.entries.push({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        body: entry.body,
        author: entry.author || collection.author,
        year: entry.year || collection.year,
        sourceUrl: entry.sourceUrl || collection.sourceUrl,
        license: entry.license || collection.license,
        order: entry.order
      });
    });
  });

  index.forEach((collectionsByCard) => {
    collectionsByCard.forEach((collection) => {
      collection.entries.sort(compareByOrderThenTitle);
    });
  });

  return index;
}

function getCommentariesForCard(index, cardId) {
  const normalizedCardId = normalizeSingleLine(cardId);
  const collectionsByCard = index instanceof Map && normalizedCardId
    ? index.get(normalizedCardId) || null
    : null;
  const collections = collectionsByCard
    ? [...collectionsByCard.values()]
    : [];
  const sortedCollections = collections.sort(compareByOrderThenTitle);
  const count = sortedCollections.reduce((sum, collection) => sum + collection.entries.length, 0);

  return {
    cardId: normalizedCardId,
    count,
    collections: sortedCollections
  };
}

module.exports = {
  buildCommentaryIndex,
  getCommentariesForCard,
  normalizeCommentaryCollection,
  normalizeCommentaryDocument,
  normalizeEntry,
  slugify
};
