# FortifyGrid website and portal

One Cloudflare Worker (`worker.js`) serves:
- **fortifygrid.com**: the public site, from `public/`.
- **app.fortifygrid.com**: the signed-in portal, from `public/dashboard/` at the host root.
  - Tiles: `/`
  - Admin (users, apps, roles, tabs, settings): `/admin/`
  - Portal API: `/api/`
  - `/workplan/`: Planner app (id `workplan`) (tasks, per-user tabs), page `public/dashboard/workplan/`, API `/api/workplan/`
  - `/ide/`: role check, then forwarded to the IDE app (repo `fortifygrid-ide`)

Platform wiring is in INFRA.md. Human setup steps are in USER_SETUP.md.

| Path | What |
|---|---|
| `worker.js` | Routing, Access JWT check, roles (D1), admin API, Access group sync, `Directory` RPC for app Workers, `/<app>/` gate + forward |
| `schema.sql` | Portal D1 tables and app rows. Idempotent; runs on every deploy |
| `public/` | Public site |
| `public/dashboard/` | Portal pages (`index.html`, `admin/`, `staging/`) |
| `infra/cf-setup.mjs` | One-time Cloudflare setup (Access, Hyperdrive) |

```bash
npm install
cp .dev.vars.example .dev.vars && npm run db:schema:local
npx wrangler dev --var APP_HOST:fortifygrid.com    # portal at http://localhost:8787
npm run check                                     # before pushing
```
A push to `main` deploys: `.github/workflows/deploy.yml` applies `schema.sql`, then runs `wrangler deploy`.

**IDE viewer:**
- Edit `public/dashboard/ide/index.html` directly. Its model data is embedded in the page.
- For new IFC / Excel files, run the engine in `fortifygrid-ide` and copy the outputs into `public/dashboard/ide/files/`.

© 2024 Fortify Grid. All Rights Reserved.

## Code / UI map
| What | File |
|---|---|
| Public site | `public/index.html`, `site.css`, `script.js` |
| Portal tiles (folders = folding cards; shared UI kit) | `public/dashboard/index.html`, `portal.js`, `portal.css` |
| Planner (tasks, Admin tab: people names, shared workstreams, tab permissions) | `public/dashboard/workplan/index.html`, `manifest.webmanifest`; API `workplanApi` in `worker.js` (visibility: `sees`) |
| Admin (users, apps, roles, tabs) | `public/dashboard/admin/index.html` |
| Worker (routing, auth, `/api/`, app gates e.g. `/ide/`) | `worker.js`; tables `schema.sql` |
| Cloudflare setup script | `infra/cf-setup.mjs` |
| Shared UI kit for every app (served at `/platform/v1/`, demo page) | `public/platform/v1/fg-ui.css`, `fg-ui.js`, `demo.html`; rules `platform/UI_PRINCIPLES.md` |
| Shared platform rules (what apps share, docs annotations, storage tiers) | `platform/README.md` |
| API / schema docs of this repo (generated, do not edit) | `docs/portal/`; `npm run docs`; generator `platform/tools/generate-docs.mjs`, config `docs.config.json` |
