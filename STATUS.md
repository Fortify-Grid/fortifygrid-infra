# Status: platform and portal

Updated 2026-11-15.

## Live
| Item | Since |
|---|---|
| fortifygrid.com, app.fortifygrid.com (portal + admin), heatmap / query / rev-anal on Workers behind Access | 2026-10-10 / 10-24 |
| Login: Access team `fortifyai` (Google + email code). Access groups synced from admin | ✅ |
| Auto-deploy on push for website, FGAI-RAG and revenue-analysis-module (repo secrets set) | ✅ |
| Dashboard folders: Market Data = heatmap, query. BTM Agentic Tools = revenue, ide. Staging site at `/staging/` (admins) | 2026-10-24 |
| Directory `users(appId)`: apps list who can open them (IDE uses it for per-project permissions) | 2026-10-25 |
| Planner (was Workplan; URL and app id still `workplan`) at **app.fortifygrid.com/workplan/** (in this Worker): tasks in D1 `wp_tasks`, week view + filters (Workstream sub-tabs Work, Family, Others, edited in the Admin tab; tasks move between them via Edit selected. "To do" sub-tab (next to the workstreams): the same table, chips, filters and sorting as the workstream tabs, for open tasks of every workstream, grouped by workstream; groups can be dragged up/down and collapsed (saved per browser). Per browser (localStorage): sub-tab order (drag), last sub-tab, column order, chip filter + sort. Immediate = due today or tomorrow, Current week, Next 2 weeks, Overdue), table on laptop / cards on phone. Tabs Workplan, System Pricing, Accounts ticked per user in its Admin tab (`user_tabs`). Pricing + Accounts are placeholders. Tasks have a Category; table columns can be dragged to reorder (saved per browser) and each has a filter dropdown. Tick rows → "Edit selected" changes project, category, status, dates on all (task name + dependencies stay per task). Complete tasks are auto-deleted 30 days after completion (purged when the list loads; table `completed_at`). Installable app (manifest `/workplan/manifest.webmanifest`, Fortify logo icons `/assets/planner-*.png`). Slack-style layout: sidebar with tabs + workstreams as channels. Tick tasks → "Copy list" copies names as `1. … 2. …` for WhatsApp etc. Admin tab → People: a Name per user (e.g. Sandeep) and shared workstreams (`wp_names`, `wp_shares`). Members now see only shared workstreams (add/edit there) plus tasks whose Depends-on note names them; Planner admins see all |  2026-11-15 |
| Repo renamed `fortifygrid-website` → `fortifygrid-infra` (GitHub redirects old URLs; Worker name unchanged). Drive code folders renamed `FG<n>. <repo>`; INFRA.md copied to every repo | 2026-11-15 |
| Shared platform (branch `platform-shared-ui`, not live until merged): UI kit at `fortifygrid.com/platform/v1/` (`fg-ui.css`, `fg-ui.js`: shell + Apps menu, draggable tabs/channels, table with sort / move / resize / column filters / groups / subtables / paging / phone cards, folding cards, URL filters; demo page), rules `platform/UI_PRINCIPLES.md` + `platform/README.md`; docs generator `npm run docs` → `docs/portal/` (29 routes, 4 RPC, 13 tables, 17 links, Mermaid ER); `npm run check` = docs check + tests + dry-run; CI `check.yml` on push / PR. Checked in a browser (desktop + phone) | 2026-11-15 |
| Portal on the shared UI (branch `portal-on-kit`, stacked on `platform-shared-ui`; not live until merged): home tiles, admin and Planner use the kit shell (Apps menu, sidebar sections, Planner workstreams as channels). Home: app folders are cards that fold and move. Admin: Users / Apps / Settings / Activity are sidebar sections; all four lists are kit tables (column filters, sort, move, resize, phone cards; Activity paged, newest first). Planner: same features as before on the kit table (chips in the URL, To do grouped, select + Copy list + Edit selected); click a row to edit (no Edit button); Admin tab parts are folding cards. Old per-browser Planner settings (`wp-cols`, `wp-view`, `wp-fold`, `wp-grporder`, `wp-wsorder`) are moved to the kit once. Kit served with `no-cache` (revalidate) so a new page never meets an old kit. Checked locally (desktop + phone) | 2026-11-15 |
| Kit v1.1 (branch `kit-sidebar-colors`, stacked on `portal-on-kit`; not live until merged): sidebar **«** hides to a ☰ rail in every app (kept per browser for all apps); palette Mint Green / Ice Blue / Warm Apricot replaces dark green (kit tokens, Planner theme colour, portal.css accent). Checked locally: demo, Planner, FGAI-RAG heatmap + query (desktop + phone) | 2026-11-15 |
| IDE at **app.fortifygrid.com/ide/**: the portal checks the role and forwards to the `fortifygrid-ide` Worker (no public route) | 2026-10-25 |

## Open
- Shared platform rollout, one PR per app: portal tiles + admin + Planner done (branch `portal-on-kit`); next FGAI-RAG, Revenue, IDE (load the kit, annotate, own `docs/<app>/`); copy the new INFRA.md section to every repo. Then the admin-only docs browser (admin + `code_docs` tab) reading every app's `docs/<app>/`.
- Planner: build System Pricing and Accounts tabs (data from RDS via Hyperdrive when needed).
- Contact form doesn't send.
- Secrets in git history not rotated (owner's choice).
- AWS CLI root keys.
- 2026 short ISO names.
- Old Pages project `fortifygrid-website` can be deleted.
- Delete archived repo `comstock-viewer` (needs `gh auth refresh -s delete_repo`).
- Add STATUS.md to FGAI-RAG and FGDataETL. In revenue-analysis-module, rename HANDOFF.md to STATUS.md (it has an uncommitted edit).
- Move subdomain apps under `app.fortifygrid.com/<app>/` (copy the `/ide/` forwarding pattern).
