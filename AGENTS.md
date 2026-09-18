# KABBAK — agent reference

KABBAK is a correspondence encyclopedia (tarot, kabbalah, astrology, alphabets, I Ching, etc.). This repo is the **API**. The browser app is a sibling checkout: `../KABBAK-GUI`.

Do not invent a bundler or framework. API is Express + SQLite JSON blobs. GUI is static HTML + IIFE scripts on `window.*`.

## Repos

| Repo | Role |
|---|---|
| `KABBAK-API` (this) | HTTP API, SQLite snapshot, DLC/plugin serving, admin, profiles |
| `KABBAK-GUI` | Static SPA (`index.html` + `app/*.js`), no build step |
| `KABBAK-DLC` | Operator-provided DLC catalog (plugins, packs). No default URL; live checkout is `imports/dlc/` |

Local run order:

1. API: `npm install && npm start` → `http://127.0.0.1:3100` (override bind with `HOST`)
2. GUI: `cd ../KABBAK-GUI && npm start` → `http://127.0.0.1:8080`
3. Browser: connection gate asks for API base URL + key

## API layout

```
src/server.js          listen, storage bootstrap
src/app.js             middleware order, route mount
src/config/            env, paths, access policy
src/middleware/        api-key, access levels, rate limit, errors
src/routes/            HTTP only
src/routes/domains/    thin slices over magick/reference blobs
src/services/          domain logic (tarot, dlc-catalog, profile, …)
  post-model.js        pure post/evidence normalizers (leaf; no service deps)
  post-share-service.js post share/preview page rendering + signed post tokens
  (profile-service.js is large; further post split — post-service.js, routes/posts.js — is a planned stage)
src/lib/               envelopes, pagination, http errors
source/                canonical data + runtime JS copied into the snapshot
imports/               DLC checkout, decks, texts, references
storage/               kabbak.db, assets, config, runtime copy of GUI tarot JS
```

Layering: **routes → services → data-loader (SQLite documents)**. Do not query SQLite ad hoc; documents are JSON blobs (`magickDataset`, `referenceData`, decks, texts).

### Middleware order (`src/app.js`)

Compression → request id → IP ban → observability → security headers → CORS → JSON body (runtime limit) → **health + public assets** → `requireApiKey` → rate limit → access level → protected routers.

Public without a key: `/api/v1/health*`, `/branding`, non-tarot `/assets/img`. DLC plugins can add their own public routes via a manifest `server` entry (mounted at `/api/v1/plugins/<name>/server/…`) — e.g. the `demo-users` plugin serves `/demo-access`.

### Success envelope

```json
{ "data": <payload>, "meta": { "requestId", "version", "total?", "offset?", "limit?" } }
```

Use `response.apiSuccess(data)` or `response.apiPaginated(items, { offset, limit })`. Errors: `{ error, message, requestId, details? }`. GUI `TarotDataService.requestJson` unwraps `.data`.

### Auth

Keys: `x-api-key` or `Authorization: Bearer`. Query `apiKey` still works for `<img>`/`<audio>` tags; prefer headers. Precedence: managed `storage/config/api-clients.json` → env clients → `KABBAK_API_KEYS` → `KABBAK_API_KEY`. Managed clients can set `hidden: true` (kept out of Admin → Users) and `expiresAt` (ISO; expired keys stop authenticating) — used by the `demo-users` plugin. `KABBAK_NO_AUTH=1` opens routes. Access levels (`basic` / `premium` / …) are hardcoded in `src/config/api-access.js`; admin “tiers” UI does not remap routes. Admin mutations need role `admin` or scope `api:admin`.

### Data

- First boot: `KABBAK_AUTO_MIGRATE` (default true) builds `storage/kabbak.db` from `source/` via `scripts/migrate-data-to-sqlite.js` (needs ~4GB heap).
- Hot reload after DLC install: `POST /api/v1/admin/dlc/reload` → `storage-bootstrap` resets data-loader **and** tarot/quiz/VM caches.
- Domain routes load the whole magick/reference document then slice in JS.
- Profile status: `profile.tagline` (≤120 chars) set with `PATCH /profile/tagline` and exposed by `getProfileSummary`.
- Journal sharing: `profile.journalVisibility` (`private` default, `friends`, `public`), set with `PATCH /profile/journal-visibility` and read by `GET /profile/directory/users/:clientId/journal` (403 `journal_private` unless the viewer is the owner, a friend for `friends`, or `public`). `getProfileSummary` exposes `journalVisibility`. Journal entries can also be **shared as profile posts** (`profile.posts`, snapshot of the entry body): `POST|GET /profile/posts` (also creates free posts/threads from `{ body }`, ≤999 chars, or from an ordered `entries` draft plus `evidenceIds`, where entries are `kind:"text"` or `kind:"evidence"` + `evidenceId` and an entry-only evidence reference joins the bucket), `DELETE /profile/posts/:postId`, `POST|DELETE /profile/posts/:postId/items[/:itemId]` (the "add to post" evidence bucket), `GET|POST|DELETE /profile/evidence[/:evidenceId]` (list, collect, and remove store items): a post is a **theory** (editable `title`/`body` via `PATCH /profile/posts/:postId`; `body`/entry `text` are rich HTML sanitized with `sanitizeMessageHtml`, and posts/evidence carry `attachments`) with an ordered thread of `entries` (`POST|PATCH|DELETE /profile/posts/:postId/entries[/:entryId]`) whose entries are either prose (`kind:"text"`) or a reference to a piece of collected evidence (`kind:"evidence"`, `evidenceId`), so evidence can be inserted anywhere and reordered (`move:"up"|"down"`), `GET /profile/feed` combines your shares with friends' and public shares, and for other users `GET /profile/directory/users/:clientId/posts` plus `POST /profile/directory/users/:clientId/posts/:postId/comments` (same visibility rule as the journal; comments only, no likes). Posts render as a full page through the same share template as messages/announcements: owner-only `POST /profile/posts/preview` returns `{ html }` for the current draft and `GET /profile/posts/:postId/share` returns `{ path, token, html }`, and owner-facing post payloads carry `sharePath` (a signed `s1` token, same feed-token secret as attachment shares, `""` when no feed secret). `GET /api/v1/share/<token>` renders the page with title, body, entries, evidence and attachments, but only while the author's `journalVisibility` is `public` (otherwise 404, no existence leak).
- Calendar subscriptions: each profile has one ICS feed (`profile.calendarFeed`, token in `GET /calendar/feed.ics?token=`) with stored layers — `user`, `notes`, `holidays`, `moon` (four principal phases), `astrology` (decan/degree/sign boundaries), `planetary` (planetary hours as timed events, rolling ~14 days back / 60 forward around now) — edited via `GET|POST /profile/calendar-feed` (no action needed to set `layers`/`notesFormat`/`options`). Per-calendar `options`: `moonPhases` (any of `new`/`first-quarter`/`full`/`last-quarter`) and `astrologyDetail` (`decan` = 10° steps, `degree` = 1° steps, `sign` = ingresses only). The URL is token-only and layers come from the stored feed, so changing the selection applies on the next calendar refresh without re-subscribing (a legacy `?layers=` URL is honored only until a selection is saved; old `decan`/`moon-full`/`moon-new` names map to `astrology`/`moon`). Sky events are computed with `astronomy-engine` (`SearchSunLongitude` for exact 10° decan boundaries, `SearchMoonPhase` for exact phase instants) and emitted as all-day events on the subscriber's local date with the precise moment in the description; the local date uses the location's `utcOffsetMinutes` (set with `PATCH /profile/location`), falling back to longitude. `GET /profile/calendar-events?from&to` returns the same events as JSON (with an exact local `time`) so the GUI calendar mirrors the subscription — the planner has no separate holiday/moon toggles; planetary hours are a local display layer computed from the profile location via `/calendar/week-events`.

### DLC / plugins (API)

Catalog + install: `src/services/dlc-catalog.js` + `src/routes/dlc.js`. Installed plugins live under `imports/dlc/plugins/<name>/` (or extra sources).

Plugin list: `GET /api/v1/plugins` → `{ plugins[], uploadLimitBytes }`. Fields the GUI host needs: `name`, `kind`, `id`, `title`, `entry`, `css`, `section`, `role`, `preserveChrome`.

`role`: `widget` (top bar), `section` / `kind: "api"` (extra page), `skin` (layout overhaul). `preserveChrome: true` = official default layout (do not hide the top bar).

Plugin JS/CSS: `GET /plugins/:name/:file` (`Cache-Control: no-cache` for code). Nested files: `/plugins/:name/files/:dir/:file`. Config GET redacts `*key*` / `*secret*` fields; POST is admin-only.

**Do not delete `source/` on uninstall.** Shop uninstall removes import/checkout copies only.

**Plugin data is split:** stock code in the checkout (`resolvePluginRoot`, multi-source); operator data in `storage/plugin-data/<name>/` (`config.json`, `logs/`, `media/`, `.tombstones.json`). That dir is outside git, so refresh is pull-only and data survives update/uninstall. Legacy in-checkout `user-data/` + `media/` + root `config.json` are read and migrated once (marker `.migrated-from-checkout`). Deleting a stock asset writes a tombstone instead of touching the repo. Plugin servers receive `ctx.dataDir` / `ctx.mediaDir` / `ctx.readConfig()` / `ctx.writeConfig()`.

**Plugin messaging + scheduling (generic, not calendar-specific):** `ctx.inbox.send(clientId, { title, description, kind, attachments, visibility, publishAt, expiresAt, requiresAck })` writes to one user's inbox; `ctx.inbox.broadcast(message)` sends to everyone; `ctx.inbox.listFor(clientId)` reads a user's inbox. `ctx.links.create(clientId, link)` makes a public/internal share link. `ctx.users.list()` enumerates profiles for fan-out. `ctx.schedule.daily(jobId, hour, run, { minute })` / `ctx.schedule.interval(jobId, ms, run)` register durable jobs on the shared scheduler (ids namespaced `plugin:<name>:<jobId>`, cleared on reload); `ctx.schedule.cancel/list` manage them. `visibility` defaults to `internal` (public share route refuses it; use the authenticated inbox attachment route instead).

**Turn-based games (generic, not game-specific):** builtin Hangman plus any plugin game. A plugin server registers one with `ctx.games.register({ id, title, description, create, view, move })`; ids are namespaced `plugin:<name>:<gameId>` (builtin ids stay bare), and registrations are cleared on plugin reload like scheduler jobs. `create({ hostClientId, guestClientId, settings })` returns `{ secret, public, firstClientId? }`; `view(session, viewerId)` returns the per-viewer board and must not leak hidden state before the game ends; `move(session, playerId, move)` mutates `session.public` and, like Hangman, may set `session.status` / `session.winnerClientId` / `session.result`. `firstClientId` decides who opens after acceptance (default: the challenged player). Sessions are durable in `storage/config/game-sessions.json`; routes are `GET /games`, `GET|POST /games/sessions`, `GET /games/sessions/:id`, and `POST /games/sessions/:id/{accept,decline,moves}`. The GUI only renders Hangman itself — a plugin game must ship a browser entry that calls `window.GamesSectionUi.registerRenderer("<namespaced id>", { render(session, container, actions) })` (queue it on `window.__kabbakGameRenderers` if the Games panel has not loaded yet) and uses `actions.move({ from, to })`.

Layout skins currently in the DLC checkout:

| id | What |
|---|---|
| `layout-default` | Built-in top bar (`preserveChrome`) |
| `layout-dock` | Left dock + HUD |
| `mindmap-layout` | Correspondence mindmap; tools/admin/plugin pages stay real screens |

Only one skin is active (`kabbak-active-skin` in the browser). Default if unset: `layout-default`.

## GUI layout (`KABBAK-GUI`)

No modules, no bundler. Scripts are IIFEs that assign `window.TarotDataService`, `window.TaroTimePluginHost`, `window.TarotSectionStateUi`, etc.

| Path | Role |
|---|---|
| `index.html` | Full chrome + every section shell (large) |
| `app.js` | Boot: gate, reconnect, visibility, init orchestration |
| `app/data-service.js` | API client, caches, `requestJson` unwraps `{ data }` |
| `app/plugins-host.js` | Load/mount widgets, section plugins, skins |
| `app/ui-section-state.js` | `VALID_SECTIONS`, show/hide, history |
| `app/ui-navigation.js` | Top-bar clicks + `nav:*` custom events |
| `app/ui-settings.js` | User prefs; UI Overhaul `<select id="ui-skin">` |
| `app/ui-admin.js` | Admin panel (lazy) |
| `app/ui-dlc-shop.js` | Plugin settings editors (eager) |
| `app/lazy-sections.js` | Injects section JS on first open; bump `?v=` when editing those files |
| `app/styles.css` | Global CSS; bump `index.html` query when changing |

Navigation is **DOM id coupling**: `#open-tarot-cards` → `setActiveSection("tarot")`. Skins call `helpers.ui.openNav("open-tarot-cards")` which `.click()`s the original (possibly hidden) button. Do not rename those ids lightly.

### Skin host contract

`window.TaroTimePluginHost.register({ id, role, preserveChrome, mount })`.

Skins that replace chrome must call `helpers.ui.hideDefaultChrome()` **inside** `mount` (host hides chrome only after mount succeeds). `attachPages(el)` moves `body > section` + `#home-welcome` into the skin. Unmount restores parents. Widget `mount` return value is `_pluginUnmount` (not a `"remove"` event).

JS/CSS for plugins are fetched with `x-api-key` and injected as blob URLs. `<audio>`/`<img>` helpers may still put `apiKey` on the query string.

Mindmap: correspondence catalogs stay graphs; Admin, Settings, Quiz, Scriber, Spread, Frame, House, plugin API pages (`data-plugin-section-open`) open the real page drawer.

## Conventions

- **Package manager:** npm + `package-lock.json` on API and GUI. Do not switch to pnpm — GUI is unbundled and serves `node_modules/` (fonts, calendar, astronomy, html2canvas, jspdf) as static files; pnpm’s symlink layout breaks that on Windows/`serve`. Trees are tiny (~9–11 direct deps); npm ships with Node.
- **JS:** Node 18+, `"use strict"` IIFEs in the GUI, no new comments unless asked.
- **Cache-bust GUI** script tags in `index.html` and `lazy-sections.js` when you change those files.
- **Do not commit secrets.** Managed keys live in `storage/config/api-clients.json` (plaintext today).
- **Do not `rm` `source/`** from DLC uninstall/install paths.
- **One skin at a time.** Add overhauls as `role: "skin"` plugins, not forks of `index.html`.
- Prefer `response.apiSuccess` on new routes. Keep `{ data, meta }` in tests.

## Commands

API (this repo):

```text
npm start                 # src/server.js
npm test                  # integration + client CLI
npm run check:syntax
npm run migrate:data      # rebuild SQLite snapshot
npm run dlc               # DLC checkout helpers
npm run scrape:sacred-texts -- --root <folder>   # archive HTML/TXT -> canonical text JSON
npm run scrape:zio-scans                        # archive zio.cards scans -> imports/scans/zio/<deck>/NN-<card>.webp
```

GUI:

```text
npm start                 # serve (port 8080)
npm run check:syntax
npm run check:html        # untagged innerHTML linter
```

## KABBAK-BOT sync

The chat bot is a sibling checkout: `../KABBAK-BOT` (Discord + Matrix adapters over one command core). It talks to this API over HTTP with `x-api-key`.

**Mandatory rule: every API change ships with a matching `../KABBAK-BOT` update.** Do not let the bot drift behind the API. Any change here that touches a route, response shape, query/body params, auth behavior, error codes, deck/data systems, or a domain feature may be consumed by the bot, so:

1. Before finishing, open `../KABBAK-BOT` and grep it for the affected route/field (`lib/kabbak-api.js`, `lib/catalog.js`, `lib/commands.js`).
2. Update the bot in the **same change** so it matches the new contract (new endpoint, renamed field, new `system`/`language`/`method` values, envelope/error change, etc.). Add new bot behavior in `lib/`, not in a `platforms/*` adapter.
3. Verify the bot: `node --check <changed-file>` for each edited bot file (no build step).
4. Note the bot update in the commit/summary. If the bot genuinely needs no change, say so explicitly and cite what you checked — "no bot change needed" must be a verified statement, not an assumption.

When you add or change a bot-facing endpoint, update the list below in the same edit. Prefer additive, backward-compatible changes; if you must break the contract, bump the bot in lockstep.

Endpoints the bot calls (keep these shapes/names):

- Envelope: `{ data, meta }`; the bot unwraps `res.data.data || res.data`.
- Key check + status: `GET /health`, `GET /profile`; bot keys may be per chat-user (`x-api-key`).
- Astro: `GET /now`, `GET /calendar/week-events`, `GET /astrology/natal` (`date` or `datetime`, optional `time` / `timeUnknown` / `utcOffsetMinutes`, plus location like `/now`).
- Tarot: `GET /tarot/cards`, `GET /tarot/cards/:cardId`, `GET /tarot/cards/:cardId/image`, `GET /tarot/spreads` (`{ spreads: [...] }`), `GET /tarot/spreads/:spreadId/pull`.
- Decks: `GET /decks/options` (items are `{ id, name, label, system }`), `GET /decks`. `system` is `tarot` | `iching` | `playing-cards` | … — tarot-only features (spreads, card lookups) must filter out non-`tarot` decks.
- I Ching: `GET /iching`, `GET /iching/hexagrams/:number`.
- Texts: `GET /texts`, `GET /texts/search`, `GET /texts/:sourceId/works/:workId/sections/:sectionId`.
- Library: `GET /tattvas`, `GET /tattvas/:id`, `GET /locations/*`, `GET /quiz/session` (`count` 1–25, default 5), `GET /quiz/questions/pull`, `GET /quiz/categories`.
- Gematria: `GET /gematria/words` (`value` + optional `language` = `english`|`hebrew`|`greek`, `method`, `ciphers`), `GET /gematria/methods` (`{ hebrew: [{id,label,description}], greek: [...] }`), `GET /gematria/calculate` (`text`, `language`, `method`). `language`/`method` are additive — bots that only send `value` keep the English behavior.
- Assets: `GET /assets/<path>` (query `apiKey` only for media tags).

Bot layout: `lib/kabbak-api.js` (client), `lib/catalog.js` (autocomplete + caches), `lib/commands.js` (command core), `lib/spread-stitch.js` / `lib/tattva-image.js` (image rendering), `platforms/*` (thin adapters). Add new bot behavior in `lib/`, not in an adapter.

## Pitfalls

- Bind default is `127.0.0.1`. LAN access needs `HOST=0.0.0.0` and matching `KABBAK_ALLOWED_ORIGINS`.
- No default DLC/plugin catalog URL. `npm run dlc -- repo <url>` (more than one repo is allowed; `dlc list` groups by source). Or Admin → DLC.
- Demo user is a DLC plugin (`demo-users`): GUI + server routes. Demo gate key is **not** public unless loopback or `KABBAK_DEMO_ACCESS=1`. Install the plugin to use it.
- Hydrus has no hardcoded key; plugin config GET redacts secrets; file URLs are proxied through `/api/v1/integrations/hydrus-network/…`.
- Failed skin `mount` must not leave `html[data-plugin-skin]` set (host restores chrome on throw).
- `unregisterSection` must not delete builtin ids (`home`, `tarot`, `admin`, …).
- Magick dataset is large; first paint should not wait on it (cache loader idles it).
- Tarot card images resolve from Thoth names (Knight/Queen/Prince/Princess). RWS-style file-maps (Page/Knight/Queen/King) alias automatically (Princess→Page, Prince→Knight, Knight→King). Filenames like `32.jpg` come from that deck’s `minors.cards` map, not a global numbering. Funky ranks/suits: `courtRankAliases` (`"sibyl": "princess"`), `courtNameOverrides`, `suitNameOverrides`, or `rankIndexByKey`. Keep `src/services/deck-service.js` and `../KABBAK-GUI/app/card-images.js` in sync.
- Scraper targets differ: `npm run scrape:sacred-texts -- --install` writes the **runtime library** (`source/data/text` + `library.json`; reload the API to show them in the reader). Add `--dlc` to also write DLC text items into `imports/dlc/texts/<id>/` (`metadata.json` + `<id>.json`) so they appear under Admin → DLC → Texts. The Admin DLC list only ever scans the DLC checkout, never `source/`.
- Query-string API keys leak; do not add new ones except media tags that cannot send headers.
- `dlc-catalog.js` is a god module — extend carefully; invalidate catalog cache on install/uninstall.
