# Shared platform: what every FortifyGrid app gets, and how

The master copy of everything shared lives here in fortifygrid-infra. Apps: Website + portal + Planner (this repo),
IDE (`fortifygrid-ide`), RAG (`FGAI-RAG`: heatmap, query), Revenue analysis (`revenue-analysis-module`).

| Shared piece | Every app gets it by | Where |
|---|---|---|
| **Login and roles** | Live: Access JWT checked in the app Worker, role and tabs from the portal `Directory` binding | `worker.js` (Directory), `FGAI-RAG/shared/app-worker.js` (app side) · INFRA.md |
| **UI kit** (shell, tabs, tables, groups, subtables, folding cards, filters) | Live: two lines in the page, served at `https://fortifygrid.com/platform/v1/` | `public/platform/v1/` · [UI_PRINCIPLES.md](UI_PRINCIPLES.md) |
| **Docs** (API, schema, ER diagram, module map) | Copy `platform/tools/generate-docs.mjs` + a `docs.config.json`; `npm run docs`; CI checks | below · output `docs/<app>/` |
| **Storage and memory rules** | Rules below; each app follows them in its Worker | below |
| **Deploy, secrets, git, Drive folders** | INFRA.md (same file in every repo) | INFRA.md |

## Docs: API and schema from code comments
Every app has `docs/<app>/` with the same files: `index.json` (modules, counts), `api-reference.md/.json` (routes by
module with permission and storage tier), `schema-erd.md` (column dictionary + Mermaid ER diagram),
`relationships.json`, `architecture.md` (module → UI files, routes, tables; storage tiers). `npm run check` fails when
they are stale or an annotation is missing, so docs never drift.

**Routes** (JSDoc right above the handler; one block may list several routes):
```js
/**
 * Planner tasks: list, add, edit, delete, bulk edit.
 * @module planner                     (a key of docs.config.json → modules)
 * @route GET /api/workplan/tasks
 * @route POST /api/workplan/tasks/bulk Planner tab admin     (text after the path = this route's permission)
 * @permission Planner tab workplan     (default permission for the block's routes)
 * @storageTier tier1_d1                (tier1_d1 | tier2_git | tier3_files | tier4_heavy | static_assets | external)
 * @param {object} body {ids[], changes}
 * @returns {object[]} tasks
 * @throws 403 workstream not shared
 * @example POST /api/workplan/tasks/bulk {"ids":[3],"changes":{"status":"complete"}}
 */
```
RPC methods: `@rpc Directory.tabs(email, appId)`.

**Tables** (SQL comments right above `CREATE TABLE`; columns, keys and indexes are read from the DDL itself):
```sql
-- @table wp_tasks
-- @module planner
-- @storageTier tier1_d1
-- @description Planner tasks.
-- @foreignKey workstream_id wp_workstreams.id (N:1)      (a link kept by code; REFERENCES in the DDL are found too)
CREATE TABLE IF NOT EXISTS wp_tasks ( … );
```

## Storage tiers and Worker memory (every app)
| Tier | Use for | Not for |
|---|---|---|
| 1 · D1 | Users, roles, settings, small app tables, search indexes. Keep each DB small and fast | Files, logs that grow forever, big datasets |
| 2 · Git | Versioned Markdown, configs, small outputs (Revenue: `data/`) | Large or binary files |
| 3 · Google Drive / Dropbox | Heavy files (PDF, DWG, video, uploads). The browser uploads straight to the provider | Anything the Worker must stream through itself |
| 4 · AWS RDS / S3 | Large tables (market data), archives, old audit rows | Per-click app state |

Worker rules (128 MB memory, short CPU):
- Never hold a whole file or a whole table in memory: stream (`ReadableStream`) and page queries (`LIMIT` ≤ 100 with a cursor).
- Bound parameters only (`.bind(…)`); never build SQL from user text.
- No heavy SDKs in Workers: `fetch` + Web Crypto. Big maths runs in Python (Actions / engine), not in the Worker.
- Each table's tier is its `-- @storageTier`, so `architecture.md` shows what lives where.

## Adding an app to the shared platform
1. Login: copy `FGAI-RAG/shared/app-worker.js` (or put the app under `app.fortifygrid.com/<app>/`, INFRA.md).
2. UI: load the kit, build the page with `FG.shell` / `FG.table` / `FG.filters` / `FG.sections`; add the app to `FG.APPS` here.
3. Docs: copy `platform/tools/generate-docs.mjs` to the same path, write `docs.config.json`, annotate, `npm run docs`,
   add it to `npm run check`.
