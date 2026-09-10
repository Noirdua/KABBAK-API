# KABBAK API

Read-only API backend for the KABBAK frontend. Serves astrology, tarot, gematria, I-Ching, quiz, text sources, and calendar data from a SQLite snapshot.

## Quick Start

**Prerequisites:** Node.js 22+, npm.

```text
git clone <this-repo>
cd kabbak-api
cp .env.example .env
npm install
npm start
```

The server listens on `http://localhost:3100`. The `.env.example` file contains commented templates for all supported environment variables. Copy it to `.env` and uncomment the ones you need.

> **First run:** The API auto-migrates on startup — it builds `storage/kabbak.db` from `source/`. No text sources or deck images ship with the repo. You will have a functional but *empty* server. See [Text Packs](#text-packs) and [Deck Packs](#deck-packs) below to populate content.

## Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3100) |
| `KABBAK_API_KEY` | Single API key for all clients |
| `KABBAK_API_KEYS` | Multiple keys (semicolon-separated) |
| `KABBAK_API_CLIENTS` | JSON array of named client definitions |
| `KABBAK_NO_AUTH` | Skip authentication — all routes open (set to `1`) |
| `KABBAK_ALLOWED_ORIGINS` | CORS origins (semicolon-separated URLs) |
| `KABBAK_ALLOW_NULL_ORIGIN` | Allow `Origin: null` (default false) |
| `KABBAK_JSON_BODY_LIMIT` | Request body limit, e.g. `64mb` (default `64mb`) |
| `KABBAK_MAX_PLUGIN_UPLOAD_MB` | Plugin content upload limit in MB (default 25) |
| `KABBAK_REQUEST_LOG` | Request log mode: `errors`, `all`, `none` |
| `KABBAK_PROFILE_ENCRYPTION_SECRET` | Secret used to encrypt stored profiles |
| `KABBAK_AUTO_MIGRATE` | Auto-migrate on startup (default true) |
| `KABBAK_DLC_REPO` | Git URL of the DLC/plugin catalog (no default; required to install packs) |
| `KABBAK_DLC_BRANCH` | DLC catalog branch (default `main`) |

Everything except `PORT` (and the bind host) can also be changed at runtime from
the Admin panel → Server Settings. Those edits apply immediately, persist to
`storage/config/runtime-settings.json`, and win over the environment values on
the next boot.

For a fully open public server, set only:

```dotenv
PORT=3100
KABBAK_NO_AUTH=1
```

No API key required — all routes, including premium assets, are public.

Minimal `.env` for local development (browser on localhost):

```dotenv
PORT=3100
KABBAK_API_KEYS=client-alpha-key;client-beta-key
```

For deployments where the browser runs from a different host:

```dotenv
PORT=3100
KABBAK_API_KEYS=client-alpha-key;client-beta-key
KABBAK_ALLOWED_ORIGINS=https://app.example.com
```

`KABBAK_ALLOWED_ORIGINS` must match the browser's exact origin (protocol + hostname + port). The origin is the page's `window.location.origin`, not the API URL.

## Authentication

API keys are sent via `x-api-key` or `Authorization: Bearer <key>`. Unauthenticated requests can reach only public endpoints (`/health`, `/health/live`, `/health/ready`, public assets).

**Key precedence:** Managed client registry → `KABBAK_API_CLIENTS` → `KABBAK_API_KEYS` → `KABBAK_API_KEY`.

### Managed Client Registry

For named clients with per-client access levels and capabilities, use the registry at `storage/config/api-clients.json`. It hot-reloads on file change — no server restart needed.

Manage it with the built-in CLI:

```text
npm run clients -- list
npm run clients -- add -Name "my-client" -Access "pro+"
npm run clients -- rekey -Id cli_<id>
npm run clients -- upsert -Id client-basic -Key client-basic-key -AccountId account-basic -AccessLevel basic -Roles reader -Scopes api:read
npm run clients -- upsert -Id client-basic -AccessLevel premium
npm run clients -- remove -Id client-basic
```

`add` generates the client id (`cli_<random hex>`) and API key (`kabbak_<random base64url>`) server-side. `rekey` replaces a lost key with a freshly generated one (target by `-Id` or unique `-Name`). The full key is printed once after creation/rotation and only ever stored masked. `list` prints one plain line per client so nothing gets cut off.

Access levels are `basic`, `premium`, and `pro+` (defaults to `premium`). When roles/scopes are not provided, they are derived from the access level:

| Access level | Roles | Scopes |
|---|---|---|
| `basic` | `reader` | `api:read` |
| `premium` | `reader` | `api:read`, `api:tarot`, `api:decks` |
| `pro+` | `reader` | `api:read`, `api:tarot`, `api:decks`, `api:metrics` |

Explicit `-Roles`/`-Scopes` always override the derived defaults. The `admin` role / `api:admin` scope stays opt-in for the admin API. `accountId` is an optional external account link (`-AccountId`) and stays blank unless provided.

Or via the admin API (requires premium access + `admin` role or `api:admin` scope):

```http
GET /api/v1/admin/api-clients
PATCH /api/v1/admin/api-clients/:clientId
DELETE /api/v1/admin/api-clients/:clientId
```

Example admin client entry:

```json
{
  "id": "client-admin",
  "accountId": "account-admin",
  "key": "client-admin-key",
  "accessLevel": "premium",
  "roles": ["admin"],
  "scopes": ["api:read", "api:admin"]
}
```

Example registry file:

```json
[
  { "id": "client-basic",    "accountId": "account-basic",    "key": "client-basic-key",    "accessLevel": "basic",   "roles": ["reader"], "scopes": ["api:read"] },
  { "id": "client-premium",  "accountId": "account-premium",  "key": "client-premium-key",  "accessLevel": "premium", "roles": ["reader"], "scopes": ["api:read"] }
]
```

### Access Levels

- **basic** — All API routes except admin, decks, tarot, and metrics
- **premium** — All API routes

Premium-gated groups are defined in `src/config/api-access.js`. Tarot deck asset files under `GET /api/v1/assets/tarot deck/*` follow the same premium policy. Non-tarot assets (`/api/v1/assets/img/*`) are public.

## Response Format (Success Envelope)

All content routes under `/api/v1` (tarot, decks, bootstrap, texts, quiz, domains, etc.) return a consistent envelope:

```json
{
  "data": { /* object, array, or value specific to the endpoint */ },
  "meta": {
    "requestId": "uuid-or-from-header",
    "version": "0.2.0",
    "total": 123,      // only for paginated list responses
    "offset": 0,
    "limit": 100,
    "count": 50
  }
}
```

- Errors remain top-level: `{ "error": "code", "message": "...", "requestId": "..." }`
- `meta.version` lets consuming GUIs detect when shapes or semantics change.
- Pagination uses `offset`/`limit` query params (server caps at 500).
- Search endpoints return `data.matches` (the item array) plus `data.total` (total matches) and `data.truncated` (true when the result set was capped). The words, gematria, text, and reference search endpoints all share this shape.
- This format is the contract for custom GUIs. No legacy shapes are preserved.

## Text Packs

Text sources (scriptures, literature, reference texts) are **not included** in the repository. Install them as optional packs.

### Installing a pack

1. Download a pack archive (e.g., `abrahamic.zip`)
2. Extract into the `packs/` directory:

```
packs/
  abrahamic/
    pack.json
    kjv.json
    book-of-mormon.json
    quran.json
    ...
```

3. Run `npm start` to trigger auto-migration, or `npm run migrate:data` to rebuild the database manually.

### Creating a pack

Each pack is a directory containing a `pack.json` manifest and text source JSON files. See `packs/README.md` for the full pack format and schema.

### Importing raw text files

Raw text files can be converted to canonical JSON via the import system. Place a `metadata.json` manifest in `source/imports/text/<folder>/` describing the input format and source metadata, then run:

```text
npm run import:texts
```

Supported input formats: `structured-json`, `chaptered-books`, `sections`, `tokenized-books`, `titled-prose-json`, `quran-verse-table`, `numbered-aphorisms-text`, `roman-verse-text`, `numbered-chapter-prose-text`, `headed-prose-text`, `auto-sectioned-text`.

Documents that are already canonical go straight into `source/data/text/` and are registered by `source/data/text/library.json`:

```text
npm run imports -- library --write
```

That scan also detects Strong's-style lexicons and links them to interlinear sources. `npm run migrate:data` runs it automatically.

## Decks

Tarot deck images are **not included** in the repository. Point the server at your DLC catalog, then install items from it:

```text
npm run dlc -- repo <your-dlc-git-url>
npm run dlc -- list
npm run dlc -- install --name "Rider Waite"
```

There is no default catalog URL. Set `KABBAK_DLC_REPO` (and optionally `KABBAK_DLC_BRANCH`) or add the source in Admin → DLC.

### Adding a deck by hand

1. Create a directory in `imports/decks/<deck-name>/`
2. Add a `deck.json` manifest describing how card names map to image files
3. Place the card images alongside it, matching the manifest templates
4. Run `npm run migrate:data`

Migration moves the folder into `source/assets/tarot deck/`, regenerates the deck registry, and builds thumbnails. See [imports/_templates/deck/](imports/_templates/deck/README.md) for the full manifest format, resolution modes, and naming conventions.

## Frontend Hookup

KABBAK is API-only — the frontend connects to it over HTTP.

1. Start the frontend's static file server (from the frontend project root)
2. Open the frontend in a browser (e.g., `http://127.0.0.1:8080`)
3. The connection gate appears — enter the API Base URL (e.g., `http://localhost:3100`) and your API key

The API URL and key are stored in the browser's local storage. To pre-set them via URL:

```text
http://127.0.0.1:8080/index.html?apiBaseUrl=http://localhost:3100
```

Premium assets (tarot deck images) require an authorized key. Public assets (`/api/v1/assets/img/*`) and health endpoints remain open.

## Local Run Order

1. API: `cd kabbak-api && npm install && npm start` (port 3100)
2. Frontend: `cd kabbak && npm start` (port 8080)
3. Browser: `http://127.0.0.1:8080`

## Testing

### Smoke Test

Verifies health, auth, metrics, bootstrap, CORS, and tiered access:

```text
npm run smoke -- -BaseUrl http://127.0.0.1:3100 -ApiKey client-premium-key -BasicApiKey client-basic-key -AdminApiKey client-admin-key
```

### Integration Suite

Runs `createApp()` directly, no server needed:

```text
npm test
```

### OpenAPI Contract

Verifies the OpenAPI document matches the mounted route surface:

```text
npm run check:openapi
```

### Full Check

Syntax + OpenAPI contract:

```text
npm run check
```

## API Routes

### Health
| Method | Path |
|---|---|
| GET | `/api/v1/health` |
| GET | `/api/v1/health/live` |
| GET | `/api/v1/health/ready` |

### Admin (premium + admin role/scope)
| Method | Path |
|---|---|
| GET | `/api/v1/admin/api-clients` |
| PATCH | `/api/v1/admin/api-clients/:clientId` |
| DELETE | `/api/v1/admin/api-clients/:clientId` |

### Metrics (premium)
| Method | Path |
|---|---|
| GET | `/api/v1/metrics` |

### Bootstrap
| Method | Path |
|---|---|
| GET | `/api/v1/bootstrap/reference-data` |
| GET | `/api/v1/bootstrap/magick-manifest` |
| GET | `/api/v1/bootstrap/magick-dataset` |

### Astrology
| Method | Path |
|---|---|
| GET | `/api/v1/astrology/planets` |
| GET | `/api/v1/astrology/signs` |
| GET | `/api/v1/astrology/decans` |

### Calendar
| Method | Path |
|---|---|
| GET | `/api/v1/calendar/months` |
| GET | `/api/v1/calendar/holidays?kind=all\|celestial\|calendar` |
| GET | `/api/v1/calendar/week-events?latitude=51.5&longitude=-0.13&date=2026-03-08` |
| GET | `/api/v1/now?latitude=51.5&longitude=-0.13&date=2026-03-08T12:00:00Z` |

### Tarot
| Method | Path |
|---|---|
| GET | `/api/v1/tarot/cards` |
| GET | `/api/v1/tarot/cards/:cardId` |
| GET | `/api/v1/tarot/cards/:cardId/relations` |
| GET | `/api/v1/tarot/spreads` |
| GET | `/api/v1/tarot/spreads/:spreadId/pull?seed=demo` |
| GET | `/api/v1/tarot/spreads/:spreadId/pull?reversed=true` |

### Decks (premium)
| Method | Path |
|---|---|
| GET | `/api/v1/decks` |
| GET | `/api/v1/decks/options` |
| GET | `/api/v1/decks/:deckId/manifest` |
| GET | `/api/v1/decks/:deckId/cards/resolve?name=The%20Fool&variant=full\|thumbnail` |
| GET | `/api/v1/decks/:deckId/back?variant=full\|thumbnail` |
| GET | `/api/v1/decks/:deckId/cards/search-aliases?name=The%20Fool` |

### I-Ching
| Method | Path |
|---|---|
| GET | `/api/v1/iching` |

### Kabbalah
| Method | Path |
|---|---|
| GET | `/api/v1/kabbalah/tree` |
| GET | `/api/v1/kabbalah/cube` |

### Words & Gematria
| Method | Path |
|---|---|
| GET | `/api/v1/gematria/words?value=33` |
| GET | `/api/v1/words/anagrams?text=listen` |
| GET | `/api/v1/words/prefix?prefix=creat` |

### Reference
| Method | Path |
|---|---|
| GET | `/api/v1/texts/references` |
| GET | `/api/v1/texts/references/:referenceId/search?q=abe` |
| GET | `/api/v1/texts/references/:referenceId/entries/:entryId` |
| GET | `/api/v1/texts/references/:referenceId/entries/:entryId/occurrences?limit=100` |

(Dictionaries/lexicons/encyclopedias are the "references" — keyed lookup helpers,
distinct from the domain tables below. `keyScheme` is `strongs`, `word`, or `term`.)

### Domain Tables
| Method | Path |
|---|---|
| GET | `/api/v1/alphabets` |
| GET | `/api/v1/gods` |
| GET | `/api/v1/numbers` |
| GET | `/api/v1/chakras` |
| GET | `/api/v1/enochian` |
| GET | `/api/v1/playing-cards` |

### Quiz
| Method | Path |
|---|---|
| GET | `/api/v1/quiz/categories` |
| GET | `/api/v1/quiz/templates` |
| GET | `/api/v1/quiz/templates?categoryId=tarot-decan-sign` |
| GET | `/api/v1/quiz/questions/pull?categoryId=tarot-decan-sign&difficulty=normal&seed=demo` |
| GET | `/api/v1/quiz/questions/pull?templateKey=tarot-decan-sign:libra-3&difficulty=normal&includeAnswer=true` |

### Texts
| Method | Path |
|---|---|
| GET | `/api/v1/texts` |
| GET | `/api/v1/texts/:sourceId` |
| GET | `/api/v1/texts/:sourceId/works/:workId/sections/:sectionId` |
| GET | `/api/v1/texts/search?q=light&limit=20` |
| GET | `/api/v1/texts/:sourceId/search?q=light&limit=20` |
| GET | `/api/v1/texts/references` |
| GET | `/api/v1/texts/references/:referenceId/entries/:entryId` |
| GET | `/api/v1/texts/references/:referenceId/entries/:entryId/occurrences?limit=100` |

### Static Assets
| Method | Path |
|---|---|
| GET | `/api/v1/assets/*` |
| GET | `/api/v1/data/*` |

## Text Source Schema

Canonical text files under `source/data/text/` use a unified JSON schema:

```json
{
  "schemaVersion": 1,
  "type": "structured-text-source",
  "title": "Source Title",
  "shortTitle": "Short Title",
  "metadata": {},
  "works": [{
    "id": "work-id",
    "title": "Work Title",
    "shortTitle": "Work Short Title",
    "order": 1,
    "sections": [{
      "id": "1",
      "number": 1,
      "label": "Chapter 1",
      "title": "Work Title 1",
      "verses": [{
        "id": "1",
        "number": 1,
        "reference": "Work Title 1:1",
        "text": "Rendered text",
        "originalText": "Optional source-language text",
        "tokens": [{
          "index": 1,
          "gloss": "Optional gloss",
          "original": "Optional token text",
          "strongs": ["G3056"]
        }],
        "metadata": {}
      }]
    }]
  }]
}
```

KJV+ stores interlinear annotations in `verse.tokens`. Bilingual texts like the Quran use `originalText` alongside `text`.

## Storage Layout

| Path | Purpose |
|---|---|
| `source/data/` | Canonical structured source data |
| `source/data/text/` | Text source JSON files |
| `source/data/text/_generated/` | Generated text sources from imports |
| `source/imports/text/` | Manifest-driven text import drop-folder |
| `source/assets/tarot deck/` | Deck asset source (add-on packs) |
| `source/runtime/app/` | Shared runtime scripts for migration |
| `packs/` | Installed text source packs |
| `storage/kabbak.db` | SQLite snapshot of the app dataset |
| `storage/data/` | Copied JSON for `GET /api/v1/data/*` |
| `storage/assets/` | Copied assets for `GET /api/v1/assets/*` |
| `storage/config/api-clients.json` | Hot-reloaded client registry |
| `storage/runtime/app/` | Copied shared runtime scripts |

## Notes

- The API emits structured JSON request logs with `requestId`, status, duration, and client identity.
- Admin mutations emit audit log events (without raw API keys).
- Set `KABBAK_AUTO_MIGRATE=0` to make startup fail instead of auto-migrating.
- Use long random API keys before any shared or remote deployment.
- Browser-stored API keys need HTTPS for transport security.
