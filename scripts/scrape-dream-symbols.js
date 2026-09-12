"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "dream-symbols.json");
const SECTION_IDS = ["what-your-dream", "the-science", "psychology", "shadow-question"];
const SECTION_KEYS = {
  "what-your-dream": "whatYourDream",
  "the-science": "theScience",
  psychology: "psychology",
  "shadow-question": "shadowQuestion"
};
const TABLE_MARKER = 'style="width:100%;border-collapse:collapse;font-size:0.85rem;"';
const CONCURRENCY = 4;
const RETRIES = 2;

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(html) {
  return decodeEntities(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanSectionText(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const lower = line.toLowerCase();
      if (lower.includes("mysticsense") || lower.includes("5-minute session") || lower.includes("affiliate disclosure")) {
        return false;
      }
      return true;
    })
    .join("\n\n")
    .trim();
}

function extractSection(html, id) {
  const needle = `id="${id}"`;
  const start = html.indexOf(needle);
  if (start < 0) {
    return "";
  }
  const from = html.indexOf(">", start);
  if (from < 0) {
    return "";
  }
  const rest = html.slice(from + 1);
  const next = rest.search(/\n\s*(?:<div class="glass-card"|<!-- )/);
  const chunk = next < 0 ? rest : rest.slice(0, next);
  return cleanSectionText(stripHtml(chunk));
}

function extractCellText(cellHtml) {
  return stripHtml(cellHtml).replace(/\s+/g, " ").trim();
}

function parseTable(tableHtml) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  let header = true;
  while ((trMatch = trRe.exec(tableHtml))) {
    const cells = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(trMatch[1]))) {
      cells.push(extractCellText(cellMatch[1]));
    }
    if (!cells.length) {
      continue;
    }
    if (header) {
      header = false;
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

function extractMatchingTables(html) {
  const tables = [];
  let pos = 0;
  while (true) {
    const found = html.indexOf(TABLE_MARKER, pos);
    if (found < 0) {
      break;
    }
    const start = html.lastIndexOf("<table", found);
    const end = html.indexOf("</table>", found);
    if (start < 0 || end < 0) {
      break;
    }
    tables.push(parseTable(html.slice(start, end + 8)));
    pos = end + 8;
  }
  return tables;
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "KABBAK-DLC/1.0 (dream-symbol enrichment)",
        Accept: "text/html"
      },
      timeout: 25000
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        fetchHtml(new URL(response.headers.location, url).href).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function scrapeEntry(entry) {
  const html = await fetchHtml(entry.url);
  const next = { ...entry };
  SECTION_IDS.forEach((id) => {
    const text = extractSection(html, id);
    if (text) {
      next[SECTION_KEYS[id]] = text;
    }
  });
  const tables = extractMatchingTables(html);
  if (tables[0] && tables[0].length) {
    next.scenarioMatrix = tables[0].map((row) => ({
      happens: row[0] || "",
      feel: row[1] || "",
      meaning: row[2] || ""
    }));
  }
  if (tables[1] && tables[1].length) {
    next.spiritualRemedies = tables[1].map((row) => ({
      type: row[0] || "",
      recommendation: row[1] || "",
      why: row[2] || ""
    }));
  }
  return next;
}

async function withRetry(task) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

function writeAtomic(data) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, FILE);
}

async function main() {
  const entries = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const pending = [];
  entries.forEach((entry, index) => {
    if (entry && entry.url && !entry.whatYourDream) {
      pending.push(index);
    }
  });
  console.log(`[scrape] ${pending.length} of ${entries.length} still need enrichment.`);
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const index = pending[cursor];
      cursor += 1;
      const entry = entries[index];
      try {
        entries[index] = await withRetry(() => scrapeEntry(entry));
      } catch (error) {
        console.warn(`[scrape] failed ${entry.slug || entry.url}: ${error.message}`);
      }
      done += 1;
      if (done % 20 === 0 || done === pending.length) {
        writeAtomic(entries);
        console.log(`[scrape] ${done}/${pending.length} saved.`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  writeAtomic(entries);
  const filled = entries.filter((entry) => entry.whatYourDream).length;
  console.log(`[scrape] done. ${filled}/${entries.length} have whatYourDream.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
