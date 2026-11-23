-- fortifygrid-portal D1. Idempotent: runs on every deploy. Changes to existing tables → migrations/ first.
-- Doc tags (-- @table … above each CREATE TABLE) feed `npm run docs`; rules in platform/README.md (Docs).
-- @table users
-- @module access
-- @storageTier tier1_d1
-- @description Every person who can sign in to the portal; is_admin = portal admin. Roles per app are in app_access.
CREATE TABLE IF NOT EXISTS users (
  email        TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  is_admin     INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_seen_at TEXT
);

-- One row per user per app they may open. role is one of that app's roles in worker.js APPS.
-- @table app_access
-- @module access
-- @storageTier tier1_d1
-- @description Which apps each user may open, and their role there (one of the app's roles in apps.roles).
-- @foreignKey email users.email (N:1)
-- @foreignKey app_id apps.id (N:1)
CREATE TABLE IF NOT EXISTS app_access (
  email  TEXT NOT NULL,
  app_id TEXT NOT NULL,
  role   TEXT NOT NULL,
  PRIMARY KEY (email, app_id)
);

-- @table audit
-- @module access
-- @storageTier tier1_d1
-- @description Who changed what in admin (users, apps, tabs, settings, invites, sync). Append-only; newest 300 shown.
-- @foreignKey actor users.email (N:1) any email; not checked
CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);

-- Registered apps (edited at /dashboard/admin → Apps). roles = JSON array, lowest first.
-- access_group_id / access_aud = the app's Cloudflare Access group and Access app audience (set by "Create Access").
-- @table apps
-- @module access
-- @storageTier tier1_d1
-- @description Registered apps: URL, roles (JSON, lowest first), Cloudflare Access group and audience.
CREATE TABLE IF NOT EXISTS apps (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL,
  roles           TEXT NOT NULL DEFAULT '["viewer","admin"]',
  access_group_id TEXT NOT NULL DEFAULT '',
  access_aud      TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
INSERT OR IGNORE INTO apps (id, name, description, url, roles, created_at, updated_at) VALUES
  ('heatmap', 'Grid Heatmap', 'LMP price heatmap with generators and GIS layers, live from the FortifyGrid database.',
   'https://heatmap.fortifygrid.com/', '["viewer","admin"]', datetime('now'), datetime('now'));

-- Site config (edited at /dashboard/admin → Settings). Known keys: dashboard_notice (banner on the dashboard);
-- theme_main, theme_accent1, theme_accent2 (#rrggbb colours for every app on the kit, served as /platform/v1/theme.css).
-- @table settings
-- @module portal
-- @storageTier tier1_d1
-- @description Site config edited in admin → Settings (e.g. dashboard_notice banner).
-- @foreignKey updated_by users.email (N:1)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- Tabs each app has (its UI marks them data-tab="<tab>") and which role may see which (admin → Apps → Tabs).
-- @table app_tabs
-- @module access
-- @storageTier tier1_d1
-- @description Tabs each app has; its UI marks them data-tab="<tab>".
-- @foreignKey app_id apps.id (N:1)
CREATE TABLE IF NOT EXISTS app_tabs (
  app_id TEXT NOT NULL,
  tab    TEXT NOT NULL,
  label  TEXT NOT NULL,
  sort   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, tab)
);
-- @table role_tabs
-- @module access
-- @storageTier tier1_d1
-- @description Which role may see which tab of an app.
-- @foreignKey app_id apps.id (N:1)
-- @foreignKey tab app_tabs.tab (N:1) together with app_id
CREATE TABLE IF NOT EXISTS role_tabs (
  app_id TEXT NOT NULL,
  role   TEXT NOT NULL,
  tab    TEXT NOT NULL,
  PRIMARY KEY (app_id, role, tab)
);
INSERT OR IGNORE INTO app_tabs (app_id, tab, label, sort) VALUES
  ('heatmap', 'filters', 'Filters (left pane)', 1),
  ('heatmap', 'database', 'Load from Database', 2),
  ('heatmap', 'csv_upload', 'Load CSV', 3),
  ('heatmap', 'gis_layers', 'GIS layers', 4),
  ('heatmap', 'generators', 'Generators', 5),
  ('heatmap', 'results', 'Results table', 6),
  ('heatmap', 'search', 'Address search', 7);
-- Defaults only on first run, so admin changes are never overwritten by a deploy.
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'heatmap', 'viewer', tab FROM app_tabs WHERE app_id = 'heatmap' AND tab IN ('filters', 'gis_layers', 'generators', 'results', 'search')
  AND NOT EXISTS (SELECT 1 FROM role_tabs WHERE app_id = 'heatmap');
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'heatmap', 'admin', tab FROM app_tabs WHERE app_id = 'heatmap'
  AND NOT EXISTS (SELECT 1 FROM role_tabs WHERE app_id = 'heatmap' AND role = 'admin');

-- Data Query app (FGAI-RAG/query). Tabs: download = CSV export, save = save/delete queries, configure = choose datasets,
-- ercot = ERCOT prices view (hubs/nodes, monthly TB2/TB4, spike hours), tb2m = TB2M view (pasted nodes, TB2 across years),
-- ancillary = Ancillary view (ancillary prices by ISO / zone / service / year).
INSERT OR IGNORE INTO apps (id, name, description, url, roles, sort, created_at, updated_at) VALUES
  ('query', 'Data Query', 'Filter any exposed table or view with cascading lists, view or download results, save queries.',
   'https://query.fortifygrid.com/', '["viewer","admin"]', 2, datetime('now'), datetime('now'));
INSERT OR IGNORE INTO app_tabs (app_id, tab, label, sort) VALUES
  ('query', 'download', 'Download CSV', 1),
  ('query', 'save', 'Save queries', 2),
  ('query', 'configure', 'Configure datasets', 3),
  ('query', 'ercot', 'ERCOT prices', 4),
  ('query', 'tb2m', 'TB2M', 5),
  ('query', 'ancillary', 'Ancillary', 6);
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'query', 'viewer', tab FROM app_tabs WHERE app_id = 'query' AND tab IN ('download', 'save', 'ercot', 'tb2m', 'ancillary')
  AND NOT EXISTS (SELECT 1 FROM role_tabs WHERE app_id = 'query');
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'query', 'admin', tab FROM app_tabs WHERE app_id = 'query'
  AND NOT EXISTS (SELECT 1 FROM role_tabs WHERE app_id = 'query' AND role = 'admin');
-- Tabs added later: give each to viewer + admin once (an admin can remove it afterwards).
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'query', r.role, t.tab FROM (SELECT 'viewer' AS role UNION ALL SELECT 'admin') r, (SELECT 'ercot' AS tab UNION ALL SELECT 'tb2m' UNION ALL SELECT 'ancillary') t
  WHERE NOT EXISTS (SELECT 1 FROM role_tabs x WHERE x.app_id = 'query' AND x.tab = t.tab);

-- Revenue Analysis app (Fortify-Grid/revenue-analysis-module). Append to fortifygrid-infra schema.sql (idempotent).
-- Tabs: analyze = upload / run / change battery settings, export = Excel / PDF / zip, admin = delete customers.
-- Roles: viewer sees results, analyst runs analyses, admin everything.
INSERT OR IGNORE INTO apps (id, name, description, url, roles, sort, created_at, updated_at) VALUES
  ('revenue', 'Revenue Analysis', 'Utility bills + interval data: learned tariffs by utility, bill recreation, battery savings and payback.',
   'https://rev-anal.fortifygrid.com/', '["viewer","analyst","admin"]', 3, datetime('now'), datetime('now'));
INSERT OR IGNORE INTO app_tabs (app_id, tab, label, sort) VALUES
  ('revenue', 'analyze', 'Run analyses', 1),
  ('revenue', 'export', 'Export Excel / PDF', 2),
  ('revenue', 'admin', 'Delete customers', 3);
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'revenue', 'viewer', tab FROM app_tabs WHERE app_id = 'revenue' AND tab IN ('export')
  AND NOT EXISTS (SELECT 1 FROM role_tabs WHERE app_id = 'revenue');
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'revenue', 'analyst', tab FROM app_tabs WHERE app_id = 'revenue' AND tab IN ('analyze', 'export')
  AND NOT EXISTS (SELECT 1 FROM role_tabs WHERE app_id = 'revenue' AND role = 'analyst');
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'revenue', 'admin', tab FROM app_tabs WHERE app_id = 'revenue'
  AND NOT EXISTS (SELECT 1 FROM role_tabs WHERE app_id = 'revenue' AND role = 'admin');

-- Dashboard folders: which section each app's tile sits in (admin → Apps → Folder). Folders sort by the lowest
-- folder_sort among their apps; apps without a row show under "Other apps".
-- @table app_folders
-- @module portal
-- @storageTier tier1_d1
-- @description Dashboard folder (section) each app's tile sits in.
-- @foreignKey app_id apps.id (1:1)
CREATE TABLE IF NOT EXISTS app_folders (
  app_id      TEXT PRIMARY KEY,
  folder      TEXT NOT NULL,
  folder_sort INTEGER NOT NULL DEFAULT 100
);

-- IDE: app.fortifygrid.com/ide/, role-checked in worker.js, served by the fortifygrid-ide Worker (binding IDE).
-- Engine (IFC / Excel): Fortify-Grid/fortifygrid-ide. Roles: viewer looks; engineer, admin also download (tab downloads).
INSERT OR IGNORE INTO apps (id, name, description, url, roles, sort, created_at, updated_at) VALUES
  ('ide', 'IDE — Digital Engineering Model', 'Comstock BESS plant viewer: spatial, electrical, civil; measure; BOM and work statement; IFC / Excel.',
   'https://app.fortifygrid.com/ide/', '["viewer","engineer","admin"]', 4, datetime('now'), datetime('now'));
-- One-time move from ide.fortifygrid.com (own Access app retired).
UPDATE apps SET url = 'https://app.fortifygrid.com/ide/', access_group_id = '', access_aud = '',
  description = 'Comstock BESS plant viewer: spatial, electrical, civil; measure; BOM and work statement; IFC / Excel.'
  WHERE id = 'ide' AND url <> 'https://app.fortifygrid.com/ide/';
DELETE FROM role_tabs WHERE app_id = 'ide' AND tab = 'qa';
DELETE FROM app_tabs WHERE app_id = 'ide' AND tab = 'qa';
INSERT OR IGNORE INTO app_tabs (app_id, tab, label, sort) VALUES ('ide', 'downloads', 'Download IFC / Excel', 1);
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'ide', r.role, 'downloads' FROM (SELECT 'engineer' AS role UNION ALL SELECT 'admin') r
  WHERE NOT EXISTS (SELECT 1 FROM role_tabs x WHERE x.app_id = 'ide' AND x.role = r.role);

-- FGAI QuickBooks: app.fortifygrid.com/quickbooks/, role-checked in worker.js, served by the fgai-quickbooks Worker
-- (binding QUICKBOOKS, repo Fortify-Grid/FGAI-Quickbooks). viewer reads; editor reclassifies / runs AI reads; admin also moves files.
INSERT OR IGNORE INTO apps (id, name, description, url, roles, sort, created_at, updated_at) VALUES
  ('quickbooks', 'FGAI QuickBooks', 'Live P&L, balance sheet, GL and monthly spend from the QuickBooks GL, vendor receipts and the latest statements.',
   'https://app.fortifygrid.com/quickbooks/', '["viewer","editor","admin"]', 6, datetime('now'), datetime('now'));
INSERT OR IGNORE INTO app_tabs (app_id, tab, label, sort) VALUES
  ('quickbooks', 'pnl', 'P&L', 1),
  ('quickbooks', 'bs', 'Balance Sheet', 2),
  ('quickbooks', 'gl', 'General Ledger', 3),
  ('quickbooks', 'spend', 'Monthly Spend', 4),
  ('quickbooks', 'recon', 'Statement Reconciliation', 5),
  ('quickbooks', 'scoa', 'SCOA', 6),
  ('quickbooks', 'receipts', 'Receipts', 7);
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'quickbooks', r.role, t.tab FROM (SELECT 'viewer' AS role UNION ALL SELECT 'editor' UNION ALL SELECT 'admin') r
  JOIN app_tabs t ON t.app_id = 'quickbooks'
  WHERE NOT EXISTS (SELECT 1 FROM role_tabs x WHERE x.app_id = 'quickbooks' AND x.role = r.role);

INSERT OR IGNORE INTO app_folders (app_id, folder, folder_sort) VALUES
  ('heatmap', 'Market Data', 1),
  ('query', 'Market Data', 1),
  ('revenue', 'BTM Agentic Tools', 2),
  ('ide', 'BTM Agentic Tools', 2),
  ('quickbooks', 'Finance', 3);

-- Extra tabs for one user on top of their role's tabs (role_tabs). The Workplan Admin tab edits these.
-- @table user_tabs
-- @module access
-- @storageTier tier1_d1
-- @description Extra tabs for one user on top of their role's tabs (Planner Admin tab edits these).
-- @foreignKey app_id apps.id (N:1)
-- @foreignKey email users.email (N:1)
-- @foreignKey tab app_tabs.tab (N:1) together with app_id
CREATE TABLE IF NOT EXISTS user_tabs (
  app_id TEXT NOT NULL,
  email  TEXT NOT NULL,
  tab    TEXT NOT NULL,
  PRIMARY KEY (app_id, email, tab)
);

-- Workplan: app.fortifygrid.com/workplan/, served by this Worker. Tabs workplan, pricing, accounts (given per user in
-- the app's Admin tab) and admin (role admin). Roles: member (only the tabs ticked for them), admin (every tab).
INSERT OR IGNORE INTO apps (id, name, description, url, roles, sort, created_at, updated_at) VALUES
  ('workplan', 'Planner', 'Weekly tasks by project: dependencies, target dates, status. System Pricing and Accounts coming.',
   'https://app.fortifygrid.com/workplan/', '["member","admin"]', 5, datetime('now'), datetime('now'));
INSERT OR IGNORE INTO app_tabs (app_id, tab, label, sort) VALUES
  ('workplan', 'workplan', 'Tasks', 1),
  ('workplan', 'pricing', 'System Pricing', 2),
  ('workplan', 'accounts', 'Accounts', 3),
  ('workplan', 'admin', 'Admin (tab permissions)', 4);
INSERT INTO role_tabs (app_id, role, tab)
  SELECT 'workplan', 'admin', tab FROM app_tabs WHERE app_id = 'workplan'
  AND NOT EXISTS (SELECT 1 FROM role_tabs WHERE app_id = 'workplan');
-- Renamed Workplan -> Planner (display only; app id and URL stay 'workplan'). Idempotent.
UPDATE apps SET name = 'Planner' WHERE id = 'workplan' AND name = 'Workplan';
UPDATE app_tabs SET label = 'Tasks' WHERE app_id = 'workplan' AND tab = 'workplan' AND label = 'Workplan';
INSERT OR IGNORE INTO app_folders (app_id, folder, folder_sort) VALUES ('workplan', 'Operations', 3);

-- Workplan tasks. Dates are YYYY-MM-DD; the week number (ISO) comes from the dates. depends_on = another task's id.
-- @table wp_tasks
-- @module planner
-- @storageTier tier1_d1
-- @description Planner tasks. Dates YYYY-MM-DD; complete tasks are deleted 30 days after completed_at.
-- @foreignKey workstream_id wp_workstreams.id (N:1)
-- @foreignKey depends_on wp_tasks.id (N:1) the task this one waits for
-- @foreignKey updated_by users.email (N:1)
CREATE TABLE IF NOT EXISTS wp_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project      TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',  -- existing DBs: run once  ALTER TABLE wp_tasks ADD COLUMN category TEXT NOT NULL DEFAULT '';
  workstream_id INTEGER,  -- wp_workstreams.id. Existing DBs: ALTER TABLE wp_tasks ADD COLUMN workstream_id INTEGER;
  completed_at TEXT,  -- set when status becomes complete; task is deleted 30 days later. Existing DBs: ALTER TABLE wp_tasks ADD COLUMN completed_at TEXT;
  task         TEXT NOT NULL,
  depends_on   INTEGER,
  depends_note TEXT NOT NULL DEFAULT '',
  start_date   TEXT,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'not_started',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL
);

-- Workplan workstreams = sub-tabs of the Workplan tab. Edited in the Workplan Admin tab. Seeded once; tasks without one go to the first.
-- @table wp_workstreams
-- @module planner
-- @storageTier tier1_d1
-- @description Planner workstreams (sub-tabs / channels). Edited in the Planner Admin tab.
CREATE TABLE IF NOT EXISTS wp_workstreams (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
INSERT INTO wp_workstreams (name, sort)
  SELECT n, s FROM (SELECT 'Work' n, 1 s UNION ALL SELECT 'Family', 2 UNION ALL SELECT 'Others', 3)
  WHERE NOT EXISTS (SELECT 1 FROM wp_workstreams);
UPDATE wp_tasks SET workstream_id = (SELECT id FROM wp_workstreams ORDER BY sort, id LIMIT 1) WHERE workstream_id IS NULL;

-- Planner people. name = what the owner types in a task's "Depends on" note (e.g. Sandeep): tasks naming them show in
-- their view. wp_shares = whole workstreams shared with a member (they see, add and edit its tasks). Planner admins see all.
-- @table wp_names
-- @module planner
-- @storageTier tier1_d1
-- @description Planner name per person; tasks whose Depends-on note names them show in their view.
-- @foreignKey email users.email (1:1)
CREATE TABLE IF NOT EXISTS wp_names (
  email TEXT PRIMARY KEY,
  name  TEXT NOT NULL
);
-- @table wp_shares
-- @module planner
-- @storageTier tier1_d1
-- @description Workstreams shared with a member (they see, add and edit its tasks).
-- @foreignKey workstream_id wp_workstreams.id (N:1)
-- @foreignKey email users.email (N:1)
CREATE TABLE IF NOT EXISTS wp_shares (
  workstream_id INTEGER NOT NULL,
  email         TEXT NOT NULL,
  PRIMARY KEY (workstream_id, email)
);
