// fortifygrid.com — public site (./public). app.fortifygrid.com — the signed-in portal (files in ./public/dashboard,
// served at the root of that host; fortifygrid.com/dashboard/* redirects there). See INFRA.md.
//
// Sign-in is Cloudflare Access (Google or one-time email code) in front of app.fortifygrid.com and every app host.
// This Worker is the one place that decides who may use which app. Everything is in D1 `fortifygrid-portal`
// and edited at app.fortifygrid.com/admin/:
//   - apps:       registered apps (tile, URL, roles, their Cloudflare Access app + group)
//   - app_folders: which dashboard folder each app's tile sits in (e.g. Market Data, BTM Agentic Tools)
//   - users:      people, admin flag, active flag;  app_access: role per user per app
//   - settings:   site config (key → value), e.g. dashboard_notice
//   - audit:      every admin change
// Saving a user re-syncs the Cloudflare Access groups, so Access only lets listed people through.
// App Workers call `Directory` over a service binding: config(appId) for JWT checks, access(email, appId) for the role.

import { WorkerEntrypoint } from 'cloudflare:workers';

const now = () => new Date().toISOString();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const SETTING_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
// Theme colours for every app on the kit (admin → Settings → Theme colours). Setting key → kit token. Hex only.
const THEME = { theme_main: '--fg-mint', theme_accent1: '--fg-ice', theme_accent2: '--fg-apricot' };
const HEX_RE = /^#[0-9a-f]{6}$/i;
const ROLE_RE = /^[a-z][a-z0-9_-]{1,20}$/;
const APP_HOST = 'app.fortifygrid.com';
const PORTAL_URL = `https://${APP_HOST}/`;
const appHost = (env) => (env.APP_HOST || APP_HOST).trim().toLowerCase();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
    },
  });

const teamDomain = (env) => (env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

/* ---------- Cloudflare Access JWT ----------
   Access signs every request it lets through (Cf-Access-Jwt-Assertion). We verify signature (team public keys),
   issuer, expiry and audience, then trust the email inside. Config: CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD. */

const b64urlDecode = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const parsePart = (s) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
let jwks = { at: 0, domain: '', keys: [] };

async function signingKey(domain, kid) {
  for (const refresh of [false, true]) {
    if (refresh || jwks.domain !== domain || Date.now() - jwks.at > 3600_000) {
      const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
      if (!res.ok) throw new Error('Could not load Access keys');
      jwks = { at: Date.now(), domain, keys: (await res.json()).keys };
    }
    const jwk = jwks.keys.find((k) => k.kid === kid);
    if (jwk) return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  return null;
}

async function accessEmail(req, env) {
  if (env.ENVIRONMENT === 'development' && env.DEV_USER_EMAIL) return normEmail(env.DEV_USER_EMAIL);
  const domain = teamDomain(env);
  const auds = (env.CF_ACCESS_AUD || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!domain || !auds.length) return null;
  const token = req.headers.get('cf-access-jwt-assertion') || '';
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  try {
    const header = parsePart(h);
    const payload = parsePart(p);
    if (header.alg !== 'RS256') return null;
    const key = await signingKey(domain, header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(sig), new TextEncoder().encode(`${h}.${p}`));
    const t = Date.now() / 1000;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!ok || payload.iss !== `https://${domain}` || !payload.exp || payload.exp < t || !aud.some((a) => auds.includes(a))) return null;
    return payload.email ? normEmail(payload.email) : null;
  } catch {
    return null;
  }
}

/* ---------- Apps, users ---------- */

const appRow = (r) => ({
  id: r.id, name: r.name, description: r.description, url: r.url, roles: JSON.parse(r.roles || '[]'),
  access_group_id: r.access_group_id, access_aud: r.access_aud, enabled: Boolean(r.enabled), sort: r.sort,
  folder: r.folder || '', folder_sort: r.folder_sort ?? 100,
});

const APP_SELECT = 'SELECT a.*, f.folder, f.folder_sort FROM apps a LEFT JOIN app_folders f ON f.app_id = a.id';

async function listApps(env, { all = false } = {}) {
  const { results } = await env.DB.prepare(`${APP_SELECT} ${all ? '' : 'WHERE a.enabled = 1'} ORDER BY a.sort, a.name`).all();
  return results.map(appRow);
}

async function getApp(env, id) {
  const r = await env.DB.prepare(`${APP_SELECT} WHERE a.id = ?`).bind(id).first();
  return r ? appRow(r) : null;
}

const bootstrapAdmins = (env) => (env.ADMIN_EMAILS || '').split(',').map(normEmail).filter(Boolean);

async function loadUser(env, email) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const isBootstrap = bootstrapAdmins(env).includes(email);
  if (!user && !isBootstrap) return null;
  if (user && !user.active && !isBootstrap) return null;
  const { results } = await env.DB.prepare('SELECT app_id, role FROM app_access WHERE email = ?').bind(email).all();
  const apps = Object.fromEntries(results.map((r) => [r.app_id, r.role]));
  // Bootstrap admins (ADMIN_EMAILS) always get in and get every app's top role, so nobody gets locked out.
  if (isBootstrap) for (const a of await listApps(env)) apps[a.id] = a.roles[a.roles.length - 1] || 'admin';
  return { email, name: user?.name || '', admin: isBootstrap || Boolean(user?.is_admin), apps, bootstrap: isBootstrap };
}

// Throttled to one write per user per 10 minutes (apps call Directory.access on every request).
const touch = (env, email) => env.DB.prepare('UPDATE users SET last_seen_at = ?1 WHERE email = ?2 AND (last_seen_at IS NULL OR last_seen_at < ?3)')
  .bind(now(), email, new Date(Date.now() - 600_000).toISOString()).run();

async function currentUser(req, env) {
  const email = await accessEmail(req, env);
  if (!email) throw new HttpError(401, `Not signed in. Open ${PORTAL_URL} to sign in.`);
  const user = await loadUser(env, email);
  if (!user) throw new HttpError(403, `${email} has not been given access. Ask a FortifyGrid admin to add you.`);
  await touch(env, email);
  return user;
}

async function audit(env, actor, action, target = '', detail = '') {
  await env.DB.prepare('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(now(), actor, action, target, detail).run();
}

/* ---------- Cloudflare API (Access groups + apps) ----------
   CF_API_TOKEN (secret) needs Account · Access: Organizations, Identity Providers, and Groups · Edit and
   Account · Access: Apps and Policies · Edit. CF_ACCOUNT_ID is a var. */

const cfConfigured = (env) => Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);

async function cf(env, path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID.trim()}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN.trim()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new Error((data.errors || []).map((e) => e.message).join('; ') || `Cloudflare API ${res.status}`);
  return data.result;
}

async function putGroupEmails(env, groupId, emails) {
  const g = await cf(env, `/access/groups/${groupId}`);
  // Only email rules are managed here; other rule types added by hand (domains etc.) are kept.
  const include = [...(g.include || []).filter((r) => !r.email), ...[...new Set(emails)].sort().map((email) => ({ email: { email } }))];
  await cf(env, `/access/groups/${groupId}`, { method: 'PUT', body: { name: g.name, include, exclude: g.exclude || [], require: g.require || [] } });
}

// Dashboard group (PORTAL_GROUP_ID) = every active user; each app's group = active users with a role in it.
// ADMIN_EMAILS are always included so a group is never empty.
async function syncAccessGroups(env) {
  if (!cfConfigured(env)) return { synced: false, note: 'Access sync not configured (CF_API_TOKEN): add emails to the Access groups by hand.' };
  const admins = bootstrapAdmins(env);
  const { results: active } = await env.DB.prepare('SELECT email FROM users WHERE active = 1').all();
  const { results: grants } = await env.DB.prepare(
    'SELECT a.email, a.app_id FROM app_access a JOIN users u ON u.email = a.email WHERE u.active = 1').all();
  const jobs = [];
  if (env.PORTAL_GROUP_ID) jobs.push(['dashboard', env.PORTAL_GROUP_ID, [...admins, ...active.map((r) => r.email)]]);
  for (const app of await listApps(env, { all: true })) {
    if (app.access_group_id) jobs.push([app.id, app.access_group_id, [...admins, ...grants.filter((g) => g.app_id === app.id).map((g) => g.email)]]);
  }
  const errors = [];
  for (const [name, gid, emails] of jobs) {
    try { await putGroupEmails(env, gid, emails); } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  return errors.length
    ? { synced: false, note: `Access sync failed for ${errors.join('; ')}` }
    : { synced: true, note: `Access groups updated (${jobs.length}).` };
}

// Creates "<name> users" group + a self-hosted Access app for the host, allowing that group, with every login
// method (Google, email code). Returns { groupId, aud }.
async function provisionAccess(env, name, host) {
  const idps = (await cf(env, '/access/identity_providers')).map((i) => i.id);
  const groups = await cf(env, '/access/groups');
  const group = groups.find((g) => g.name === `${name} users`)
    || await cf(env, '/access/groups', { method: 'POST', body: { name: `${name} users`, include: bootstrapAdmins(env).map((email) => ({ email: { email } })) } });
  const body = {
    name, domain: host, type: 'self_hosted', session_duration: '24h', allowed_idps: idps,
    app_launcher_visible: false, http_only_cookie_attribute: true, same_site_cookie_attribute: 'lax',
    policies: [{ name: `${name} users`, decision: 'allow', include: [{ group: { id: group.id } }], precedence: 1 }],
  };
  const existing = (await cf(env, '/access/apps')).find((a) => a.domain === host);
  const app = existing
    ? await cf(env, `/access/apps/${existing.id}`, { method: 'PUT', body })
    : await cf(env, '/access/apps', { method: 'POST', body });
  return { groupId: group.id, aud: app.aud };
}

/* ---------- Invite email (optional) ----------
   With EMAIL_API_KEY (Resend secret) + EMAIL_FROM set, invites are sent from the Worker. Otherwise the admin page
   opens the same message in the admin's own mail app. */

async function sendInvite(env, email, grants) {
  const apps = (await listApps(env)).filter((a) => grants?.[a.id]);
  const subject = 'Your access to FortifyGrid apps';
  const list = apps.map((a) => `- ${a.name}: ${a.url}`).join('\n') || `- Dashboard: ${PORTAL_URL}`;
  const text = [
    'Hello,', '', 'You have been given access to FortifyGrid apps:', list, '',
    'How to sign in:',
    `1. Open ${PORTAL_URL}`,
    `2. Choose Google (if ${email} is a Google account) or enter ${email} to get a one-time code by email.`,
    '3. Open any app tile. No password is needed.', '', 'FortifyGrid',
  ].join('\n');
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) return { sent: false, subject, text };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], reply_to: env.EMAIL_REPLY_TO || undefined, subject, text }),
  });
  return res.ok ? { sent: true, subject, text } : { sent: false, error: `Email failed (${res.status})`, subject, text };
}

/* ---------- Admin: users ---------- */

async function listUsers(env) {
  const { results: users } = await env.DB.prepare('SELECT * FROM users ORDER BY email').all();
  const { results: grants } = await env.DB.prepare('SELECT email, app_id, role FROM app_access').all();
  return users.map((u) => ({
    email: u.email, name: u.name, is_admin: Boolean(u.is_admin), active: Boolean(u.active),
    last_seen_at: u.last_seen_at, created_at: u.created_at, bootstrap: bootstrapAdmins(env).includes(u.email),
    apps: Object.fromEntries(grants.filter((g) => g.email === u.email).map((g) => [g.app_id, g.role])),
  }));
}

async function saveUser(env, actor, body) {
  const email = normEmail(body.email);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const apps = {};
  for (const app of await listApps(env, { all: true })) {
    const role = body.apps?.[app.id];
    if (role && app.roles.includes(role)) apps[app.id] = role;
  }
  const isAdmin = body.is_admin ? 1 : 0;
  const active = body.active === false ? 0 : 1;
  if (email === actor.email && (!isAdmin || !active) && !actor.bootstrap) throw new HttpError(400, 'You cannot remove your own admin access.');
  const existed = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (email, name, is_admin, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET name = excluded.name, is_admin = excluded.is_admin, active = excluded.active, updated_at = excluded.updated_at`)
      .bind(email, String(body.name || '').slice(0, 200), isAdmin, active, t, t),
    env.DB.prepare('DELETE FROM app_access WHERE email = ?').bind(email),
    ...Object.entries(apps).map(([appId, role]) =>
      env.DB.prepare('INSERT INTO app_access (email, app_id, role) VALUES (?, ?, ?)').bind(email, appId, role)),
  ]);
  await audit(env, actor.email, existed ? 'update user' : 'add user', email, JSON.stringify({ admin: Boolean(isAdmin), active: Boolean(active), apps }));
  const sync = await syncAccessGroups(env);
  let invite;
  if (!existed && body.invite) {
    invite = await sendInvite(env, email, apps);
    await audit(env, actor.email, 'invite', email, invite.sent ? 'sent' : 'manual');
  }
  return { ok: true, email, sync, invite };
}

async function deleteUser(env, actor, email) {
  if (email === actor.email) throw new HttpError(400, 'You cannot delete yourself.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM app_access WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email),
  ]);
  await audit(env, actor.email, 'delete user', email);
  return { ok: true, sync: await syncAccessGroups(env) };
}

/* ---------- Admin: apps ---------- */

async function saveApp(env, actor, body) {
  const id = String(body.id || '').trim().toLowerCase();
  if (!APP_ID_RE.test(id)) throw new HttpError(400, 'App id: lowercase letters, digits, dashes (e.g. "heatmap").');
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'App name is required.');
  let url;
  try { url = new URL(String(body.url || '')); } catch { throw new HttpError(400, 'Enter the app URL, e.g. https://heatmap.fortifygrid.com/'); }
  if (url.protocol !== 'https:') throw new HttpError(400, 'App URL must be https.');
  const roles = String(body.roles || 'viewer,admin').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (!roles.length || !roles.every((r) => ROLE_RE.test(r))) throw new HttpError(400, 'Roles: comma-separated words, lowest first (e.g. "viewer,admin").');
  const existing = await getApp(env, id);
  let groupId = existing?.access_group_id || String(body.access_group_id || '').trim();
  let aud = existing?.access_aud || '';
  let note = '';
  if (body.provision) {
    if (!cfConfigured(env)) throw new HttpError(400, 'CF_API_TOKEN is not set, so Cloudflare Access cannot be created from here.');
    try { ({ groupId, aud } = await provisionAccess(env, name, url.host)); note = 'Cloudflare Access app and group created.'; }
    catch (e) { throw new HttpError(502, `Cloudflare Access setup failed: ${e.message}`); }
  }
  const t = now();
  await env.DB.prepare(`INSERT INTO apps (id, name, description, url, roles, access_group_id, access_aud, enabled, sort, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, url = excluded.url, roles = excluded.roles,
        access_group_id = excluded.access_group_id, access_aud = excluded.access_aud, enabled = excluded.enabled, sort = excluded.sort,
        updated_at = excluded.updated_at`)
    .bind(id, name, String(body.description || '').slice(0, 300), url.href, JSON.stringify(roles), groupId, aud,
      body.enabled === false ? 0 : 1, Number(body.sort) || 0, t, t).run();
  // Folder = the dashboard section the tile sits in. Folders sort by the lowest folder_sort among their apps.
  const folder = String(body.folder ?? existing?.folder ?? '').trim().slice(0, 60);
  if (folder) {
    const folderSort = Number(body.folder_sort ?? existing?.folder_sort ?? (await env.DB.prepare(
      'SELECT MIN(folder_sort) AS s FROM app_folders WHERE folder = ?').bind(folder).first())?.s ?? 100);
    await env.DB.prepare(`INSERT INTO app_folders (app_id, folder, folder_sort) VALUES (?, ?, ?)
        ON CONFLICT(app_id) DO UPDATE SET folder = excluded.folder, folder_sort = excluded.folder_sort`).bind(id, folder, folderSort).run();
  } else {
    await env.DB.prepare('DELETE FROM app_folders WHERE app_id = ?').bind(id).run();
  }
  // Roles that no longer exist are dropped from users.
  await env.DB.prepare(`DELETE FROM app_access WHERE app_id = ? AND role NOT IN (SELECT value FROM json_each(?))`).bind(id, JSON.stringify(roles)).run();
  await audit(env, actor.email, existing ? 'update app' : 'add app', id, JSON.stringify({ name, url: url.href, roles, folder, enabled: body.enabled !== false }));
  const sync = groupId ? await syncAccessGroups(env) : undefined;
  return { ok: true, id, note, sync, aud };
}

/* ---------- Admin: tabs per role ---------- */

async function listTabs(env) {
  const { results: tabs } = await env.DB.prepare('SELECT app_id, tab, label, sort FROM app_tabs ORDER BY app_id, sort, tab').all();
  const { results: grants } = await env.DB.prepare('SELECT app_id, role, tab FROM role_tabs').all();
  return { tabs, grants };
}

// body: { tabs?: [{tab, label}], role_tabs: { <role>: [tab, ...] } }. Replaces the app's tab grants.
async function saveTabs(env, actor, appId, body) {
  const app = await getApp(env, appId);
  if (!app) throw new HttpError(404, 'No such app.');
  const stmts = [];
  if (Array.isArray(body.tabs)) {
    const defs = body.tabs.map((t, i) => ({ tab: String(t.tab || '').trim().toLowerCase(), label: String(t.label || t.tab || '').slice(0, 80), sort: i }))
      .filter((t) => SETTING_KEY_RE.test(t.tab));
    stmts.push(env.DB.prepare('DELETE FROM app_tabs WHERE app_id = ?').bind(appId),
      ...defs.map((t) => env.DB.prepare('INSERT INTO app_tabs (app_id, tab, label, sort) VALUES (?, ?, ?, ?)').bind(appId, t.tab, t.label, t.sort)));
  }
  const known = Array.isArray(body.tabs)
    ? new Set(body.tabs.map((t) => String(t.tab || '').trim().toLowerCase()))
    : new Set((await env.DB.prepare('SELECT tab FROM app_tabs WHERE app_id = ?').bind(appId).all()).results.map((r) => r.tab));
  stmts.push(env.DB.prepare('DELETE FROM role_tabs WHERE app_id = ?').bind(appId));
  for (const [role, tabs] of Object.entries(body.role_tabs || {})) {
    if (!app.roles.includes(role) || !Array.isArray(tabs)) continue;
    for (const tab of new Set(tabs)) if (known.has(tab)) stmts.push(env.DB.prepare('INSERT INTO role_tabs (app_id, role, tab) VALUES (?, ?, ?)').bind(appId, role, tab));
  }
  await env.DB.batch(stmts);
  await audit(env, actor.email, 'set tabs', appId, JSON.stringify(body.role_tabs || {}).slice(0, 300));
  return { ok: true };
}

/* ---------- Admin: settings ---------- */

async function listSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value, updated_at, updated_by FROM settings ORDER BY key').all();
  return results;
}

async function saveSetting(env, actor, body) {
  const key = String(body.key || '').trim().toLowerCase();
  if (!SETTING_KEY_RE.test(key)) throw new HttpError(400, 'Setting key: lowercase letters, digits, underscores.');
  const value = String(body.value ?? '').slice(0, 4000);
  if (key.startsWith('theme_') && !(THEME[key] && HEX_RE.test(value))) throw new HttpError(400, `Theme colours: ${Object.keys(THEME).join(', ')}, as #rrggbb.`);
  await env.DB.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(key, value, now(), actor.email).run();
  await audit(env, actor.email, 'set setting', key, value.slice(0, 200));
  return { ok: true, key };
}

async function deleteSetting(env, actor, key) {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
  await audit(env, actor.email, 'delete setting', key);
  return { ok: true };
}

// Tabs a user may see in appId: their role's tabs plus any given to them alone (user_tabs). Bootstrap admins see every tab.
async function appTabs(env, user, appId) {
  const role = user?.apps[appId];
  if (!role) return [];
  const q = user.bootstrap
    ? env.DB.prepare('SELECT tab FROM app_tabs WHERE app_id = ?').bind(appId)
    : env.DB.prepare('SELECT tab FROM role_tabs WHERE app_id = ?1 AND role = ?2 UNION SELECT tab FROM user_tabs WHERE app_id = ?1 AND email = ?3')
      .bind(appId, role, user.email);
  return (await q.all()).results.map((r) => r.tab);
}

/* ---------- Workplan (app.fortifygrid.com/workplan/) ----------
   Tasks in D1 wp_tasks. Tabs: workplan, pricing, accounts are ticked per user in the app's Admin tab (user_tabs);
   ticking any tab gives the user the member role, unticking all removes it. Role admin sees every tab. */

const WP = 'workplan';
const WP_TABS = ['workplan', 'pricing', 'accounts'];
const WP_STATUS = ['not_started', 'in_progress', 'blocked', 'complete'];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wpDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

/**
 * Planner: who am I here (role, tabs, Planner name, people names for the Depends-on picker).
 * @module planner
 * @route GET /api/workplan/me Planner role (member or admin)
 * @storageTier tier1_d1
 * @returns {{email, role, tabs: string[], admin: boolean, name, people: string[]}}
 * @throws 403 no Planner role
 */
/**
 * Planner tasks. Members see tasks of workstreams shared with them plus tasks whose Depends-on note names them;
 * Planner admins see all. Listing also deletes tasks completed more than 30 days ago.
 * @module planner
 * @route GET /api/workplan/tasks
 * @route POST /api/workplan/tasks
 * @route POST /api/workplan/tasks/:id
 * @route DELETE /api/workplan/tasks/:id
 * @route POST /api/workplan/tasks/bulk
 * @permission Planner tab workplan; only tasks the caller can see
 * @storageTier tier1_d1
 * @param {object} body POST: {project, category, task, workstream_id, depends_on, depends_note, start_date, due_date, status}; bulk: {ids[] ≤500, changes: {project, category, status, start_date, due_date, workstream_id}}
 * @returns {object[]|{ok: true}} tasks (GET), else ok
 * @throws 400 bad dates / nothing to change · 403 workstream not shared · 404 task not visible
 * @example POST /api/workplan/tasks/bulk {"ids":[3,4],"changes":{"status":"complete"}}
 */
/**
 * Planner workstreams (sub-tabs / channels): list, add, rename, reorder, delete (only when empty).
 * @module planner
 * @route GET /api/workplan/workstreams Planner tab workplan (members: shared ones + ones holding a task naming them)
 * @route POST /api/workplan/workstreams
 * @route POST /api/workplan/workstreams/:id
 * @route POST /api/workplan/workstreams/order
 * @route DELETE /api/workplan/workstreams/:id
 * @permission Planner tab admin
 * @storageTier tier1_d1
 * @param {object} body {name} or order: {ids[]}
 * @returns {object[]|{ok: true}} [{id, name, sort, edit}] for GET
 * @throws 400 duplicate name / workstream still has tasks / last workstream
 */
/**
 * Planner people and permissions: Planner name, shared workstreams and extra tabs per user.
 * @module planner
 * @route GET /api/workplan/access
 * @route POST /api/workplan/access
 * @permission Planner tab admin
 * @storageTier tier1_d1
 * @param {object} body {email, name, tabs[], ws[]}
 * @returns {object[]|{ok: true}} [{email, name, role, tabs, pname, ws}] for GET
 * @throws 404 no such active user · 400 name taken
 */
async function workplanApi(req, env, user, path, method) {
  const tabs = await appTabs(env, user, WP);
  const need = (t) => { if (!tabs.includes(t)) throw new HttpError(403, 'You do not have this tab. Ask a Planner admin.'); };
  const [, resource, rawId] = path.split('/');
  const id = Number(rawId) || 0;
  const body = method === 'POST' ? await req.json().catch(() => ({})) : {};

  /* What this user sees: Planner admins (admin tab) everything; members the workstreams shared with them plus any task
     whose "Depends on" note has their Planner name (set in the Admin tab) as a whole word, any case. */
  const all = tabs.includes('admin');
  const shared = all ? [] : (await env.DB.prepare('SELECT workstream_id id FROM wp_shares WHERE email = ?').bind(user.email).all()).results.map((r) => r.id);
  const myName = all ? '' : (await env.DB.prepare('SELECT name FROM wp_names WHERE email = ?').bind(user.email).first('name')) || '';
  const nameRe = myName && new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(myName)}($|[^\\p{L}\\p{N}])`, 'iu');
  const sees = (t) => all || shared.includes(t.workstream_id) || (nameRe && nameRe.test(t.depends_note || ''));
  const canWs = (wsId) => all || shared.includes(wsId);
  const seen = async (tid) => {
    const t = await env.DB.prepare('SELECT * FROM wp_tasks WHERE id = ?').bind(tid).first();
    if (!t || !sees(t)) throw new HttpError(404, 'No such task.');
    return t;
  };
  const noWs = () => new HttpError(403, 'That workstream is not shared with you.');

  if (resource === 'me' && method === 'GET') {
    const people = (await env.DB.prepare('SELECT name FROM wp_names ORDER BY name').all()).results.map((r) => r.name);
    return json({ email: user.email, role: user.apps[WP] || null, tabs, admin: all, name: myName, people });
  }

  if (resource === 'tasks') {
    need('workplan');
    if (method === 'GET') {
      /* completed tasks are deleted 30 days after completion (checked whenever the list is loaded) */
      const cut = new Date(Date.now() - 30 * 864e5).toISOString();
      const old = `status = 'complete' AND completed_at IS NOT NULL AND completed_at < ?1`;
      const [, del] = await env.DB.batch([
        env.DB.prepare(`UPDATE wp_tasks SET depends_on = NULL WHERE depends_on IN (SELECT id FROM wp_tasks WHERE ${old})`).bind(cut),
        env.DB.prepare(`DELETE FROM wp_tasks WHERE ${old}`).bind(cut),
      ]);
      if (del.meta.changes) await audit(env, 'system', 'purge completed tasks', `${WP}: ${del.meta.changes} older than 30 days`);
      return json((await env.DB.prepare('SELECT * FROM wp_tasks ORDER BY id').all()).results.filter(sees));
    }
    if (method === 'DELETE' && id) {
      await seen(id);
      await env.DB.batch([
        env.DB.prepare('UPDATE wp_tasks SET depends_on = NULL WHERE depends_on = ?').bind(id),
        env.DB.prepare('DELETE FROM wp_tasks WHERE id = ?').bind(id),
      ]);
      await audit(env, user.email, 'delete task', `${WP}#${id}`);
      return json({ ok: true });
    }
    if (method === 'POST' && rawId === 'bulk') {
      /* Bulk edit: only shared fields (project, category, status, dates, workstream). Task text and dependencies stay per task. Missing/blank = unchanged. */
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, 500);
      const c = body.changes || {};
      if (!ids.length) throw new HttpError(400, 'Select at least one task.');
      const { results: rows } = await env.DB.prepare(`SELECT * FROM wp_tasks WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
      if (rows.length !== ids.length || !rows.every(sees)) throw new HttpError(404, 'Some tasks are not visible to you.');
      const text = (k, n) => (c[k] == null || String(c[k]).trim() === '' ? null : String(c[k]).trim().slice(0, n));
      const set = { project: text('project', 80), category: text('category', 80), status: WP_STATUS.includes(c.status) ? c.status : null,
        start_date: wpDate(c.start_date), due_date: wpDate(c.due_date), workstream_id: Number(c.workstream_id) || null };
      if (set.workstream_id && !canWs(set.workstream_id)) throw noWs();
      if (set.workstream_id && !(await env.DB.prepare('SELECT 1 FROM wp_workstreams WHERE id = ?').bind(set.workstream_id).first())) throw new HttpError(400, 'No such workstream.');
      if (!Object.values(set).some((v) => v !== null)) throw new HttpError(400, 'Nothing to change.');
      const upd = rows.map((r) => ({ ...r, ...Object.fromEntries(Object.entries(set).filter(([, v]) => v !== null)) }));
      const bad = upd.find((r) => r.start_date && r.due_date && r.due_date < r.start_date);
      if (bad) throw new HttpError(400, `Task #${bad.id}: due date would be before start date.`);
      await env.DB.batch(upd.map((r) => env.DB.prepare(`UPDATE wp_tasks SET project = ?1, category = ?2, status = ?3, start_date = ?4, due_date = ?5,
          updated_at = ?6, updated_by = ?7,
          completed_at = CASE WHEN ?3 = 'complete' THEN COALESCE(completed_at, ?6) ELSE NULL END, workstream_id = ?9 WHERE id = ?8`).bind(r.project, r.category, r.status, r.start_date, r.due_date, now(), user.email, r.id, r.workstream_id)));
      await audit(env, user.email, 'bulk edit tasks', `${WP}#${ids.join(',')}`);
      return json({ ok: true, changed: upd.length });
    }
    if (method === 'POST') {
      const task = String(body.task || '').trim().slice(0, 500);
      if (!task) throw new HttpError(400, 'Task is required.');
      const start = wpDate(body.start_date), due = wpDate(body.due_date);
      if (start && due && due < start) throw new HttpError(400, 'Due date is before start date.');
      const dep = Number(body.depends_on) || null;
      if (dep && dep === id) throw new HttpError(400, 'A task cannot depend on itself.');
      const wsId = Number(body.workstream_id) || (await env.DB.prepare('SELECT id FROM wp_workstreams ORDER BY sort, id LIMIT 1').first('id'));
      if (!(await env.DB.prepare('SELECT 1 FROM wp_workstreams WHERE id = ?').bind(wsId).first())) throw new HttpError(400, 'No such workstream.');
      const old = id ? await seen(id) : null;
      if ((!old || old.workstream_id !== wsId) && !canWs(wsId)) throw noWs();
      const vals = [String(body.project || '').trim().slice(0, 80), String(body.category || '').trim().slice(0, 80), task, dep, String(body.depends_note || '').trim().slice(0, 300),
        start, due, WP_STATUS.includes(body.status) ? body.status : 'not_started', now(), user.email, wsId];
      if (id) {
        const r = await env.DB.prepare(`UPDATE wp_tasks SET project = ?1, category = ?2, task = ?3, depends_on = ?4, depends_note = ?5,
            start_date = ?6, due_date = ?7, status = ?8, updated_at = ?9, updated_by = ?10,
            completed_at = CASE WHEN ?8 = 'complete' THEN COALESCE(completed_at, ?9) ELSE NULL END, workstream_id = ?11 WHERE id = ?12`).bind(...vals, id).run();
        if (!r.meta.changes) throw new HttpError(404, 'No such task.');
      } else {
        await env.DB.prepare(`INSERT INTO wp_tasks (project, category, task, depends_on, depends_note, start_date, due_date, status, updated_at, updated_by, created_at, completed_at, workstream_id)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, CASE WHEN ?8 = 'complete' THEN ?9 END, ?11)`).bind(...vals).run();
      }
      return json({ ok: true });
    }
  }

  if (resource === 'workstreams') {
    if (method === 'GET') {
      if (!all) need('workplan');
      /* members: shared workstreams (edit) + ones holding a task that names them (view their tasks only) */
      const { results: list } = await env.DB.prepare('SELECT id, name, sort FROM wp_workstreams ORDER BY sort, id').all();
      const mine = all ? [] : (await env.DB.prepare('SELECT workstream_id, depends_note FROM wp_tasks').all()).results.filter(sees).map((t) => t.workstream_id);
      return json(list.filter((w) => canWs(w.id) || mine.includes(w.id)).map((w) => ({ ...w, edit: canWs(w.id) })));
    }
    need('admin');
    if (method === 'POST' && rawId === 'order') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number);
      await env.DB.batch(ids.map((i, n) => env.DB.prepare('UPDATE wp_workstreams SET sort = ? WHERE id = ?').bind(n + 1, i)));
      return json({ ok: true });
    }
    if (method === 'POST') {
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) throw new HttpError(400, 'Name is required.');
      if (await env.DB.prepare('SELECT 1 FROM wp_workstreams WHERE lower(name) = lower(?) AND id != ?').bind(name, id).first()) throw new HttpError(400, 'That workstream already exists.');
      if (id) {
        if (!(await env.DB.prepare('UPDATE wp_workstreams SET name = ? WHERE id = ?').bind(name, id).run()).meta.changes) throw new HttpError(404, 'No such workstream.');
      } else {
        await env.DB.prepare('INSERT INTO wp_workstreams (name, sort) VALUES (?, COALESCE((SELECT MAX(sort) FROM wp_workstreams), 0) + 1)').bind(name).run();
      }
      await audit(env, user.email, id ? 'rename workstream' : 'add workstream', `${WP}: ${name}`);
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) {
      const n = await env.DB.prepare('SELECT COUNT(*) n FROM wp_tasks WHERE workstream_id = ?').bind(id).first('n');
      if (n) throw new HttpError(400, `Move or delete its ${n} task${n > 1 ? 's' : ''} first.`);
      if ((await env.DB.prepare('SELECT COUNT(*) n FROM wp_workstreams').first('n')) < 2) throw new HttpError(400, 'Keep at least one workstream.');
      await env.DB.batch([env.DB.prepare('DELETE FROM wp_workstreams WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM wp_shares WHERE workstream_id = ?').bind(id)]);
      await audit(env, user.email, 'delete workstream', `${WP}#${id}`);
      return json({ ok: true });
    }
  }

  if (resource === 'access') {
    need('admin');
    if (method === 'GET') {
      const { results: users } = await env.DB.prepare(`SELECT u.email, u.name, a.role FROM users u
          LEFT JOIN app_access a ON a.email = u.email AND a.app_id = ? WHERE u.active = 1 ORDER BY u.email`).bind(WP).all();
      for (const email of bootstrapAdmins(env)) {
        const u = users.find((x) => x.email === email);
        if (u) u.role = 'admin'; else users.unshift({ email, name: '', role: 'admin' });
      }
      const { results: grants } = await env.DB.prepare('SELECT email, tab FROM user_tabs WHERE app_id = ?').bind(WP).all();
      const { results: names } = await env.DB.prepare('SELECT email, name FROM wp_names').all();
      const { results: shares } = await env.DB.prepare('SELECT email, workstream_id FROM wp_shares').all();
      return json(users.map((u) => ({ ...u, tabs: grants.filter((g) => g.email === u.email).map((g) => g.tab),
        pname: names.find((n) => n.email === u.email)?.name || '', ws: shares.filter((g) => g.email === u.email).map((g) => g.workstream_id) })));
    }
    if (method === 'POST') {
      const email = normEmail(body.email);
      if (!(await env.DB.prepare('SELECT 1 FROM users WHERE email = ? AND active = 1').bind(email).first())) throw new HttpError(404, 'No such active user.');
      const role = (await env.DB.prepare('SELECT role FROM app_access WHERE email = ? AND app_id = ?').bind(email, WP).first())?.role;
      const name = String(body.name ?? '').trim().slice(0, 40);
      if (name && (await env.DB.prepare('SELECT 1 FROM wp_names WHERE lower(name) = lower(?) AND email != ?').bind(name, email).first())) throw new HttpError(400, `Someone else is already "${name}".`);
      const setName = name ? env.DB.prepare('INSERT OR REPLACE INTO wp_names (email, name) VALUES (?, ?)').bind(email, name)
        : env.DB.prepare('DELETE FROM wp_names WHERE email = ?').bind(email);
      if (role === 'admin' || bootstrapAdmins(env).includes(email)) { /* admins see every tab and task; only the name applies */
        await setName.run();
        return json({ ok: true });
      }
      const ws = (Array.isArray(body.ws) ? body.ws : []).map(Number).filter(Boolean);
      const want = WP_TABS.filter((t) => (Array.isArray(body.tabs) && body.tabs.includes(t)) || (t === 'workplan' && ws.length)); /* sharing gives Tasks */
      await env.DB.batch([
        setName,
        env.DB.prepare('DELETE FROM wp_shares WHERE email = ?').bind(email),
        ...ws.map((w) => env.DB.prepare('INSERT OR IGNORE INTO wp_shares (workstream_id, email) SELECT id, ? FROM wp_workstreams WHERE id = ?').bind(email, w)),
        env.DB.prepare('DELETE FROM user_tabs WHERE app_id = ? AND email = ?').bind(WP, email),
        ...want.map((t) => env.DB.prepare('INSERT INTO user_tabs (app_id, email, tab) VALUES (?, ?, ?)').bind(WP, email, t)),
        want.length
          ? env.DB.prepare("INSERT OR IGNORE INTO app_access (email, app_id, role) VALUES (?, ?, 'member')").bind(email, WP)
          : env.DB.prepare("DELETE FROM app_access WHERE email = ? AND app_id = ? AND role = 'member'").bind(email, WP),
      ]);
      await audit(env, user.email, 'set user tabs', email, JSON.stringify({ app: WP, tabs: want, name, ws }));
      return json({ ok: true });
    }
  }
  throw new HttpError(404, 'Not found');
}

/* ---------- Router ---------- */

/**
 * The signed-in user and the app tiles they may open (dashboard). Every portal API call verifies the Access JWT;
 * writes must be same-origin JSON.
 * @module portal
 * @route GET /api/me signed-in user
 * @storageTier tier1_d1
 * @returns {{email, name, admin: boolean, apps: {id, name, description, url, folder, folder_sort, role}[], notice}}
 * @throws 401 not signed in · 403 not an active user
 */
/**
 * Admin overview: users, apps, settings, tabs, Access sync and login methods.
 * @module access
 * @route GET /api/admin/overview portal admin
 * @storageTier tier1_d1 external
 * @returns {{users, apps, settings, tabs, access_sync, email_invites, team_domain, logins}}
 * @throws 403 Admins only
 */
/**
 * Users: add or change (portal admin flag, active, role per app), delete, send invite. Saving rewrites the
 * Cloudflare Access group emails (portal + per app).
 * @module access
 * @route POST /api/admin/users
 * @route DELETE /api/admin/users/:email
 * @route POST /api/admin/users/:email/invite
 * @permission portal admin
 * @storageTier tier1_d1 external
 * @param {object} body {email, name, is_admin, active, apps: {appId: role}}
 * @returns {object} saved user + Access sync note / invite result
 * @throws 400 bad email / removing your own admin · 404 no such user
 */
/**
 * Apps: register or change an app (id, name, https URL, roles lowest first, folder); set its tabs and which role sees each.
 * @module access
 * @route POST /api/admin/apps
 * @route POST /api/admin/apps/:id/tabs
 * @permission portal admin
 * @storageTier tier1_d1 external
 * @param {object} body app: {id, name, description, url, roles, enabled, sort, folder}; tabs: {tabs: [{tab, label}], roles: {role: tab[]}}
 * @returns {object} saved app / tabs
 * @throws 400 bad id, URL or roles · 404 no such app
 */
/**
 * Site settings (e.g. dashboard_notice). theme_main / theme_accent1 / theme_accent2 = #rrggbb colours for every app.
 * @module portal
 * @route POST /api/admin/settings
 * @route DELETE /api/admin/settings/:key
 * @permission portal admin
 * @storageTier tier1_d1
 * @param {object} body {key, value ≤4000 chars}
 * @returns {{ok: true}}
 * @throws 400 bad key, or a theme_ key that is not a known colour as #rrggbb
 */
/**
 * Rewrite every Cloudflare Access group from the user list.
 * @module access
 * @route POST /api/admin/sync portal admin
 * @storageTier external
 * @returns {{ok, note}}
 */
/**
 * Audit log, newest 300.
 * @module access
 * @route GET /api/admin/audit portal admin
 * @storageTier tier1_d1
 * @returns {object[]} [{id, at, actor, action, target, detail}]
 */
async function api(req, env, url) {
  const user = await currentUser(req, env);
  const path = url.pathname.replace(/^\/(dashboard\/)?api\//, '').replace(/\/+$/, '');
  const method = req.method;

  // Writes must come from our own pages (blocks cross-site form posts riding the Access cookie).
  if (method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request refused.');
    if (method !== 'DELETE' && !(req.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Send JSON.');
  }

  if (path === 'me' && method === 'GET') {
    const apps = (await listApps(env)).filter((a) => user.apps[a.id])
      .map(({ id, name, description, url: u, folder, folder_sort }) => ({ id, name, description, url: u, folder, folder_sort, role: user.apps[id] }));
    const notice = await env.DB.prepare("SELECT value FROM settings WHERE key = 'dashboard_notice'").first();
    return json({ email: user.email, name: user.name, admin: user.admin, apps, notice: notice?.value || '' });
  }

  if (path.startsWith('workplan/')) return workplanApi(req, env, user, path, method);
  if (!path.startsWith('admin/')) throw new HttpError(404, 'Not found');
  if (!user.admin) throw new HttpError(403, 'Admins only.');
  const [, resource, rawId, sub] = path.split('/');
  const id = rawId ? decodeURIComponent(rawId) : '';
  const body = method === 'GET' || method === 'DELETE' ? {} : await req.json().catch(() => ({}));

  if (resource === 'overview' && method === 'GET') {
    let logins = [];
    if (cfConfigured(env)) {
      try { logins = (await cf(env, '/access/identity_providers')).map((i) => ({ type: i.type, name: i.name })); } catch { /* shown as unknown */ }
    }
    return json({
      users: await listUsers(env), apps: await listApps(env, { all: true }), settings: await listSettings(env), tabs: await listTabs(env),
      access_sync: cfConfigured(env), email_invites: Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM),
      team_domain: teamDomain(env), logins,
    });
  }
  if (resource === 'users') {
    if (method === 'POST' && !id) return json(await saveUser(env, user, body));
    if (method === 'DELETE' && id) return json(await deleteUser(env, user, normEmail(id)));
    if (method === 'POST' && id && sub === 'invite') {
      const target = await loadUser(env, normEmail(id));
      if (!target) throw new HttpError(404, 'No such user.');
      const invite = await sendInvite(env, target.email, target.apps);
      await audit(env, user.email, 'invite', target.email, invite.sent ? 'sent' : 'manual');
      return json({ ok: true, invite });
    }
  }
  if (resource === 'apps' && method === 'POST' && !id) return json(await saveApp(env, user, body));
  if (resource === 'apps' && method === 'POST' && id && sub === 'tabs') return json(await saveTabs(env, user, id, body));
  if (resource === 'settings') {
    if (method === 'POST' && !id) return json(await saveSetting(env, user, body));
    if (method === 'DELETE' && id) return json(await deleteSetting(env, user, id));
  }
  if (resource === 'sync' && method === 'POST') {
    const sync = await syncAccessGroups(env);
    await audit(env, user.email, 'sync', '', sync.note);
    return json(sync);
  }
  if (resource === 'audit' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all();
    return json(results);
  }
  throw new HttpError(404, 'Not found');
}

/* ---------- Directory RPC for app Workers (service binding only, not reachable from the internet) ---------- */

/**
 * Directory: what app Workers ask the portal over the service binding (never reachable from the internet).
 * config → {team_domain, aud} to verify Access logins; access → role or null; tabs → tab ids; users → who may open the app.
 * @module directory
 * @rpc Directory.config(appId)
 * @rpc Directory.access(email, appId)
 * @rpc Directory.tabs(email, appId)
 * @rpc Directory.users(appId)
 * @permission service binding (app Workers only)
 * @storageTier tier1_d1
 */
export class Directory extends WorkerEntrypoint {
  // What an app needs to verify Access logins itself: { team_domain, aud } or null if the app is unknown/disabled.
  async config(appId) {
    const app = await getApp(this.env, appId);
    if (!app || !app.enabled || !app.access_aud) return null;
    return { team_domain: teamDomain(this.env), aud: app.access_aud };
  }

  // Tabs the caller may see in appId (array of tab ids). Bootstrap admins see every tab.
  async tabs(email, appId) {
    return appTabs(this.env, await loadUser(this.env, normEmail(email)), appId);
  }

  // The caller's role in appId (one of the app's roles) or null.
  async access(email, appId) {
    const app = await getApp(this.env, appId);
    if (!app || !app.enabled) return null;
    const user = await loadUser(this.env, normEmail(email));
    if (!user) return null;
    await touch(this.env, user.email);
    return user.apps[appId] || null;
  }

  // Everyone who may open appId: [{ email, name, role, last_seen_at }]. Apps use it for their own finer permissions.
  async users(appId) {
    const app = await getApp(this.env, appId);
    if (!app) return [];
    const { results } = await this.env.DB.prepare(
      'SELECT a.email, u.name, a.role, u.last_seen_at FROM app_access a JOIN users u ON u.email = a.email WHERE a.app_id = ? AND u.active = 1 ORDER BY a.email').bind(appId).all();
    const top = app.roles[app.roles.length - 1] || 'admin';
    for (const email of bootstrapAdmins(this.env)) if (!results.some((r) => r.email === email)) results.push({ email, name: '', role: top, last_seen_at: null });
    return results;
  }
}

/**
 * Theme colours chosen in admin → Settings, as CSS the kit loads after fg-ui.css (it only sets --fg-mint, --fg-ice,
 * --fg-apricot; unset keys keep the kit defaults). Public like the kit; cached 60 s, so a change reaches every app
 * within a minute.
 * @module platform
 * @route GET /platform/v1/theme.css
 * @permission public
 * @storageTier tier1_d1
 * @returns {Response} text/css, `access-control-allow-origin: *`
 */
async function themeCss(env) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${Object.keys(THEME).map(() => '?').join(', ')})`)
    .bind(...Object.keys(THEME)).all();
  const vars = results.filter((r) => HEX_RE.test(r.value)).map((r) => `${THEME[r.key]}: ${r.value};`).join(' ');
  return new Response(`/* FortifyGrid theme from admin → Settings (empty = kit defaults). */\n${vars ? `:root { ${vars} }\n` : ''}`, {
    headers: { 'content-type': 'text/css; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' },
  });
}

/**
 * Shared UI kit for every app (public/platform/v<n>/: fg-ui.css, fg-ui.js, demo.html). Public on both hosts, so
 * subdomain apps load it without a portal sign-in; CORS open (static, no data). Rules: platform/UI_PRINCIPLES.md.
 * @module platform
 * @route GET /platform/:version/:file
 * @permission public
 * @storageTier static_assets
 * @returns {Response} the file, `access-control-allow-origin: *`, revalidated on every load
 */
async function platformFile(req, env) {
  if (new URL(req.url).pathname === '/platform/v1/theme.css') return themeCss(env);
  const res = await env.ASSETS.fetch(req);
  const out = new Response(res.body, res);
  out.headers.set('access-control-allow-origin', '*');
  if (res.ok) out.headers.set('cache-control', 'no-cache'); // always revalidate (cheap 304): a new page never meets an old kit
  return out;
}

/**
 * Portal pages and app gates on app.fortifygrid.com: pages need a signed-in user; /ide/ needs an IDE role (and the
 * downloads tab for /ide/files/) and is forwarded to the fortifygrid-ide Worker; /workplan/ needs a Planner role.
 * @module portal
 * @route GET /* signed-in user (Cloudflare Access)
 * @route GET /ide/* IDE role; /ide/files/* also tab downloads
 * @route GET /workplan/* Planner role
 * @storageTier static_assets
 * @throws 403 no role for that app
 */
// app.fortifygrid.com/<path> is served from ./public/dashboard/<path>; /api/* is the portal API; /assets/* is shared.
async function portalHost(req, env, url) {
  if (url.pathname.startsWith('/api/')) return apiResponse(req, env, url);
  if (url.pathname.startsWith('/platform/')) return platformFile(req, env);
  if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
    url.pathname = url.pathname.slice('/dashboard'.length) || '/';
    return Response.redirect(url.toString(), 301);
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/cdn-cgi/')) return env.ASSETS.fetch(req);
  // /ide/ (IDE app) needs an ide role; /ide/files/ (IFC, Excel) also needs the downloads tab. Then forward to the app.
  if (/^\/ide(\/|$)/.test(url.pathname)) {
    try {
      const user = await currentUser(req, env);
      if (!user.apps.ide) throw new HttpError(403, 'No IDE access. Ask a FortifyGrid admin.');
      if (url.pathname.startsWith('/ide/files/') && !(await appTabs(env, user, 'ide')).includes('downloads')) throw new HttpError(403, 'Your role cannot download files.');
    } catch (e) {
      return json({ message: e.message }, e.status || 500);
    }
    return env.IDE.fetch(req); // fortifygrid-ide Worker (repo Fortify-Grid/fortifygrid-ide), no public route
  }
  // /workplan/ needs a workplan role; the page itself is static (public/dashboard/workplan/), its API checks tabs.
  if (/^\/workplan(\/|$)/.test(url.pathname)) {
    try {
      if (!(await currentUser(req, env)).apps[WP]) throw new HttpError(403, 'No Planner access. Ask a Planner admin.');
    } catch (e) {
      return json({ message: e.message }, e.status || 500);
    }
  }
  const inner = new URL(url);
  inner.pathname = `/dashboard${url.pathname}`;
  const res = await env.ASSETS.fetch(new Request(inner, req));
  // Trailing-slash redirects from the asset server point at /dashboard/...; strip it for this host.
  const loc = res.headers.get('location');
  if (loc && res.status >= 300 && res.status < 400) {
    const to = new URL(loc, inner);
    if (to.pathname.startsWith('/dashboard')) {
      to.pathname = to.pathname.slice('/dashboard'.length) || '/';
      to.host = url.host;
      to.protocol = url.protocol;
      return Response.redirect(to.toString(), res.status === 308 ? 308 : 307);
    }
  }
  return res;
}

async function apiResponse(req, env, url) {
  try {
    return await api(req, env, url);
  } catch (e) {
    if (e instanceof HttpError) return json({ message: e.message }, e.status);
    console.error(e);
    return json({ message: 'Server error' }, 500);
  }
}

/**
 * Public website fortifygrid.com (public/): no sign-in. www → apex; old /dashboard links → app.fortifygrid.com.
 * @module site
 * @route GET / public
 * @storageTier static_assets
 */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // One canonical host per site: www → apex.
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (url.hostname === appHost(env)) return portalHost(req, env, url);
    // The portal moved to app.fortifygrid.com; old links keep working.
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      const to = new URL(url.pathname.slice('/dashboard'.length) || '/', `${url.protocol}//${appHost(env)}${url.port ? `:${url.port}` : ''}`);
      to.search = url.search;
      return Response.redirect(to.toString(), 301);
    }
    if (url.pathname.startsWith('/platform/')) return platformFile(req, env);
    return env.ASSETS.fetch(req);
  },
};
