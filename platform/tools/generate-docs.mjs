#!/usr/bin/env node
// API + schema docs from code comments. Zero dependencies; same script in every FortifyGrid repo (master: fortifygrid-infra).
// node platform/tools/generate-docs.mjs [--check] [docs.config.json]
//   writes docs/<app>/ : index.json, api-reference.{json,md}, relationships.json, schema-erd.md, architecture.md
//   --check: fail if the docs are out of date or an annotation is missing (run by `npm run check` and CI).
// Annotation rules: platform/README.md (Docs).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TIERS = {
  tier1_d1: 'Tier 1 · D1 (hot app state, roles, small tables)',
  tier2_git: 'Tier 2 · Git (versioned Markdown / docs)',
  tier3_files: 'Tier 3 · Google Drive / Dropbox (heavy files)',
  tier4_heavy: 'Tier 4 · AWS RDS / S3 (heavy tables, archives)',
  static_assets: 'Static assets (Workers assets)',
  external: 'External service (no storage here)',
};
const CARD = new Set(['1:1', 'N:1', '1:N', 'N:M']);

/* ---------- JS: /** … *\/ blocks with @route or @rpc ---------- */
export function parseJs(text, file) {
  const out = [];
  const re = /\/\*\*([\s\S]*?)\*\//g;
  let m;
  while ((m = re.exec(text))) {
    const lines = m[1].split('\n').map((l) => l.replace(/^\s*\* ?/, '').trimEnd());
    if (!lines.some((l) => /^@(route|rpc)\b/.test(l))) continue;
    const tags = []; const desc = [];
    for (const l of lines) {
      const t = l.match(/^@(\w+)\s*(.*)$/);
      if (t) tags.push([t[1], t[2].trim()]);
      else if (tags.length && l.trim()) tags[tags.length - 1][1] += (tags[tags.length - 1][1] ? ' ' : '') + l.trim();
      else if (l.trim()) desc.push(l.trim());
    }
    const one = (k) => tags.find(([n]) => n === k)?.[1] || '';
    const many = (k) => tags.filter(([n]) => n === k).map(([, v]) => v).filter(Boolean);
    // the function / class this block documents (skipping other doc blocks and // comments in between)
    const after = text.slice(m.index + m[0].length).match(/^(?:\s*(?:\/\*\*[\s\S]*?\*\/|\/\/[^\n]*))*\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*\(|class\s+(\w+))/);
    const base = {
      module: one('module'), permission: one('permission'), storageTier: one('storageTier'), description: desc.join(' '),
      params: many('param'), returns: one('returns'), throws: many('throws'), examples: many('example'),
      handler: after ? after[1] || after[2] || after[3] : '', file, line: text.slice(0, m.index).split('\n').length,
    };
    for (const r of many('route')) {
      const [method, route, ...perm] = r.split(/\s+/);
      out.push({ ...base, kind: 'http', method: method.toUpperCase(), path: route, permission: perm.join(' ') || base.permission });
    }
    // @rpc Name.method(args) — the whole signature; permission comes from @permission
    for (const r of many('rpc')) out.push({ ...base, kind: 'rpc', method: 'RPC', path: r });
  }
  return out;
}

/* ---------- SQL: -- @tags above CREATE TABLE; columns, keys and indexes read from the DDL ---------- */
export function parseSql(text, file) {
  const tables = {}; const fks = []; const errors = [];
  const lines = text.split('\n');
  let pending = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tag = line.match(/^\s*--\s*@(\w+)\s*(.*)$/);
    if (tag) { pending.push([tag[1], tag[2].trim()]); continue; }
    const idx = line.match(/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/i);
    if (idx) { (tables[idx[2]] ||= { indexes: [] }).indexes = [...(tables[idx[2]].indexes || []), `${idx[1]} (${idx[3].replace(/\s+/g, ' ').trim()})`]; continue; }
    const ct = line.match(/^\s*CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
    if (!ct) { if (!/^\s*--/.test(line) && line.trim()) pending = []; continue; }
    const name = ct[1];
    const one = (k) => pending.find(([n]) => n === k)?.[1] || '';
    const t = (tables[name] = { ...(tables[name] || {}), name, module: one('module'), storageTier: one('storageTier'), description: one('description'),
      file, line: i + 1, columns: [], primaryKey: [], indexes: tables[name]?.indexes || [] });
    if (one('table') && one('table') !== name) errors.push(`${file}:${i + 1} @table ${one('table')} does not match CREATE TABLE ${name}`);
    for (const [k, v] of pending.filter(([n]) => n === 'foreignKey')) {
      const f = v.match(/^(\w+)\s+(\w+)\.(\w+)(?:\s+\(([^)]+)\))?\s*(.*)$/);
      if (!f) { errors.push(`${file}:${i + 1} bad @${k} "${v}" (want: <col> <table.col> (N:1) note)`); continue; }
      fks.push({ from: `${name}.${f[1]}`, to: `${f[2]}.${f[3]}`, cardinality: f[4] || 'N:1', enforced: false, note: f[5] || '' });
    }
    for (const v of pending.filter(([n]) => n === 'index').map(([, x]) => x)) t.indexes.push(v);
    pending = [];
    for (i += 1; i < lines.length && !/^\s*\)\s*;?/.test(lines[i]); i++) {
      const raw = lines[i]; const [code, ...rest] = raw.split('--'); const note = rest.join('--').trim();
      const c = code.trim().replace(/,$/, '');
      if (!c) continue;
      const pk = c.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (pk) { t.primaryKey = pk[1].split(',').map((s) => s.trim()); continue; }
      if (/^(UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(c)) {
        const ff = c.match(/^FOREIGN\s+KEY\s*\((\w+)\)\s*REFERENCES\s+(\w+)\s*\((\w+)\)/i);
        if (ff) fks.push({ from: `${name}.${ff[1]}`, to: `${ff[2]}.${ff[3]}`, cardinality: 'N:1', enforced: true, note: '' });
        continue;
      }
      const col = c.match(/^(\w+)\s+(\w+)?(.*)$/);
      if (!col) continue;
      const extra = col[3] || '';
      const def = extra.match(/DEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i)?.[1];
      t.columns.push({ name: col[1], type: (col[2] || '').toUpperCase(), notNull: /NOT\s+NULL/i.test(extra), default: def ?? null,
        primaryKey: /PRIMARY\s+KEY/i.test(extra), unique: /UNIQUE/i.test(extra), description: note });
      if (/PRIMARY\s+KEY/i.test(extra)) t.primaryKey = [col[1]];
      const ref = extra.match(/REFERENCES\s+(\w+)\s*\((\w+)\)/i);
      if (ref) fks.push({ from: `${name}.${col[1]}`, to: `${ref[1]}.${ref[2]}`, cardinality: /UNIQUE|PRIMARY/i.test(extra) ? '1:1' : 'N:1', enforced: true, note: '' });
    }
  }
  for (const [n, t] of Object.entries(tables)) if (!t.columns) { errors.push(`index on unknown table ${n}`); delete tables[n]; }
  // an annotation for a REFERENCES the DDL already has: keep one (enforced)
  const seen = new Map();
  for (const f of fks) { const k = `${f.from}>${f.to}`; const old = seen.get(k); if (!old) seen.set(k, f); else seen.set(k, { ...old, ...f, enforced: old.enforced || f.enforced, note: old.note || f.note }); }
  return { tables, fks: [...seen.values()], errors };
}

/* ---------- checks ---------- */
export function validate(cfg, routes, schema) {
  const errs = [...schema.errors];
  const mods = new Set(Object.keys(cfg.modules || {}));
  for (const r of routes) {
    const at = `${r.file}:${r.line} ${r.method} ${r.path}`;
    if (!r.module) errs.push(`${at}: missing @module`);
    else if (!mods.has(r.module)) errs.push(`${at}: @module ${r.module} is not in docs.config.json modules`);
    if (!r.permission) errs.push(`${at}: missing @permission`);
    if (r.storageTier && !r.storageTier.split(/[\s,]+/).every((x) => TIERS[x])) errs.push(`${at}: unknown @storageTier ${r.storageTier}`);
  }
  for (const t of Object.values(schema.tables)) {
    const at = `${t.file}:${t.line} table ${t.name}`;
    if (!t.module) errs.push(`${at}: missing -- @module`); else if (!mods.has(t.module)) errs.push(`${at}: @module ${t.module} is not in docs.config.json modules`);
    if (!TIERS[t.storageTier]) errs.push(`${at}: missing or unknown -- @storageTier (${Object.keys(TIERS).join(' | ')})`);
    if (!t.description) errs.push(`${at}: missing -- @description`);
  }
  for (const f of schema.fks) {
    const [tt, tc] = f.to.split('.'); const [ft, fc] = f.from.split('.');
    if (!CARD.has(f.cardinality)) errs.push(`foreign key ${f.from}: cardinality ${f.cardinality} (use 1:1, N:1, 1:N, N:M)`);
    if (!schema.tables[tt]?.columns.some((c) => c.name === tc)) errs.push(`foreign key ${f.from} → ${f.to}: no such column`);
    if (!schema.tables[ft]?.columns.some((c) => c.name === fc)) errs.push(`foreign key ${f.from}: no such column`);
  }
  return errs;
}

/* ---------- outputs ---------- */
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const sortRoutes = (a, b) => a.module.localeCompare(b.module) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method);

export function mermaid(schema) {
  const lines = ['erDiagram'];
  for (const t of Object.values(schema.tables).sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`  ${t.name} {`);
    for (const c of t.columns) {
      const keys = [t.primaryKey.includes(c.name) && 'PK', schema.fks.some((f) => f.from === `${t.name}.${c.name}`) && 'FK'].filter(Boolean).join(', ');
      lines.push(`    ${c.type || 'ANY'} ${c.name}${keys ? ` ${keys}` : ''}`);
    }
    lines.push('  }');
  }
  const rel = { 'N:1': '||--o{', '1:N': '||--o{', '1:1': '||--o|', 'N:M': '}o--o{' };
  for (const f of [...schema.fks].sort((a, b) => a.from.localeCompare(b.from))) {
    const [ft, fc] = f.from.split('.'); const [tt] = f.to.split('.');
    // parent first: N:1 child→parent is drawn parent ||--o{ child
    const [a, b] = f.cardinality === '1:N' ? [ft, tt] : [tt, ft];
    lines.push(`  ${a} ${rel[f.cardinality] || '||--o{'} ${b} : "${fc}${f.enforced ? '' : ' (logical)'}"`);
  }
  return lines.join('\n');
}

export function build(cfg, routes, schema) {
  const mods = Object.entries(cfg.modules || {}).sort(([a], [b]) => a.localeCompare(b));
  const rs = [...routes].sort(sortRoutes);
  const tables = Object.values(schema.tables).sort((a, b) => a.name.localeCompare(b.name));
  const files = {};
  const index = {
    app: cfg.app, name: cfg.name, repo: cfg.repo || '', sources: { api: cfg.api || [], schema: cfg.schema || [] },
    counts: { modules: mods.length, routes: rs.filter((r) => r.kind === 'http').length, rpc: rs.filter((r) => r.kind === 'rpc').length, tables: tables.length, foreignKeys: schema.fks.length },
    modules: mods.map(([id, label]) => ({ id, label, ui: cfg.ui?.[id] || [], routes: rs.filter((r) => r.module === id).length, tables: tables.filter((t) => t.module === id).map((t) => t.name) })),
    files: ['index.json', 'api-reference.json', 'api-reference.md', 'relationships.json', 'schema-erd.md', 'architecture.md'],
  };
  files['index.json'] = index;
  files['api-reference.json'] = { app: cfg.app, routes: rs.map(({ line, ...r }) => ({ ...r, source: `${r.file}:${line}` })).map(({ file, ...r }) => r) };
  files['relationships.json'] = { app: cfg.app, tables: Object.fromEntries(tables.map(({ file, line, ...t }) => [t.name, { ...t, source: `${file}:${line}` }])), foreignKeys: [...schema.fks].sort((a, b) => a.from.localeCompare(b.from)) };

  const md = [`# ${cfg.name}: API reference`, '', `Generated by \`npm run docs\` from ${(cfg.api || []).map((f) => `\`${f}\``).join(', ')}. Do not edit; change the code comments.`, ''];
  for (const [id, label] of mods) {
    const list = rs.filter((r) => r.module === id); if (!list.length) continue;
    md.push(`## ${id}: ${label}`, '', '| Method | Path | Permission | Storage | What | Source |', '|---|---|---|---|---|---|');
    for (const r of list) md.push(`| ${r.method} | \`${cell(r.path)}\` | ${cell(r.permission)} | ${cell(r.storageTier)} | ${cell(r.description)}${r.params.length ? `<br>Params: ${cell(r.params.join('; '))}` : ''}${r.returns ? `<br>Returns: ${cell(r.returns)}` : ''}${r.throws.length ? `<br>Errors: ${cell(r.throws.join('; '))}` : ''} | \`${r.file}:${r.line}\` |`);
    md.push('');
  }
  files['api-reference.md'] = md.join('\n');

  const er = [`# ${cfg.name}: schema and relationships`, '', `Generated by \`npm run docs\` from ${(cfg.schema || []).map((f) => `\`${f}\``).join(', ')}. "logical" = the link is kept by code, not by a database constraint.`, '', '```mermaid', mermaid(schema), '```', ''];
  for (const t of tables) {
    er.push(`## ${t.name}`, '', `${t.description}  `, `Module **${t.module}** · ${TIERS[t.storageTier] || t.storageTier} · key (${t.primaryKey.join(', ')}) · \`${t.file}:${t.line}\``, '',
      '| Column | Type | Null | Default | Notes |', '|---|---|---|---|---|');
    for (const c of t.columns) {
      const fk = schema.fks.filter((f) => f.from === `${t.name}.${c.name}`).map((f) => `→ ${f.to} (${f.cardinality}${f.enforced ? '' : ', logical'})`);
      er.push(`| ${c.name}${t.primaryKey.includes(c.name) ? ' 🔑' : ''} | ${c.type} | ${c.notNull ? 'no' : 'yes'} | ${cell(c.default ?? '')} | ${cell([...fk, c.description].filter(Boolean).join(' · '))} |`);
    }
    if (t.indexes.length) er.push('', `Indexes: ${t.indexes.map((x) => `\`${x}\``).join(', ')}`);
    er.push('');
  }
  files['schema-erd.md'] = er.join('\n');

  const ar = [`# ${cfg.name}: architecture`, '', 'Generated by `npm run docs`. Which functionality lives where, and where its data is stored.', '',
    '## Modules', '', '| Module | What | UI | API routes | Tables |', '|---|---|---|---|---|'];
  for (const m of index.modules) ar.push(`| ${m.id} | ${cell(m.label)} | ${m.ui.map((u) => `\`${u}\``).join('<br>')} | ${m.routes} | ${m.tables.join(', ')} |`);
  ar.push('', '## Storage tiers', '', '| Tier | Here | Tables |', '|---|---|---|');
  for (const [k, label] of Object.entries(TIERS)) {
    const ts = tables.filter((t) => t.storageTier === k).map((t) => t.name);
    if (ts.length || cfg.storage?.[k]) ar.push(`| ${label} | ${cell(cfg.storage?.[k] || '')} | ${ts.join(', ')} |`);
  }
  ar.push('', 'Rules for every app (memory, paging, files, archives): `platform/README.md` in fortifygrid-infra.', '');
  files['architecture.md'] = ar.join('\n');
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? `${v.trimEnd()}\n` : `${JSON.stringify(v, null, 2)}\n`]));
}

export function run(root, configFile = 'docs.config.json', check = false) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, configFile), 'utf8'));
  const routes = (cfg.api || []).flatMap((f) => parseJs(fs.readFileSync(path.join(root, f), 'utf8'), f));
  const parsed = (cfg.schema || []).map((f) => parseSql(fs.readFileSync(path.join(root, f), 'utf8'), f));
  const schema = { tables: Object.assign({}, ...parsed.map((p) => p.tables)), fks: parsed.flatMap((p) => p.fks), errors: parsed.flatMap((p) => p.errors) };
  const errors = validate(cfg, routes, schema);
  const files = build(cfg, routes, schema);
  const out = path.join(root, cfg.out || `docs/${cfg.app}`);
  const stale = Object.entries(files).filter(([n, body]) => { try { return fs.readFileSync(path.join(out, n), 'utf8') !== body; } catch { return true; } }).map(([n]) => n);
  if (!check && !errors.length) { fs.mkdirSync(out, { recursive: true }); for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(out, n), body); }
  return { errors, stale: check ? stale : [], out, counts: JSON.parse(files['index.json']).counts };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const check = process.argv.includes('--check');
  const conf = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'docs.config.json';
  const { errors, stale, out, counts } = run(process.cwd(), conf, check);
  for (const e of errors) console.error(`docs: ${e}`);
  if (stale.length) console.error(`docs: out of date in ${out}: ${stale.join(', ')}. Run npm run docs and commit.`);
  if (errors.length || stale.length) process.exit(1);
  console.log(`docs: ${check ? 'up to date' : `wrote ${out}`} (${counts.routes} routes, ${counts.rpc} rpc, ${counts.tables} tables, ${counts.foreignKeys} links)`);
}
