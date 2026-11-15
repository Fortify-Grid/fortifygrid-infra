// node --test platform/ — the docs generator reads every route and foreign key, and refuses missing annotations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseJs, parseSql, validate, mermaid, run } from './generate-docs.mjs';

const JS = `
/**
 * Things: list and add.
 * @module things
 * @route GET /api/things
 * @route POST /api/things admin
 * @permission signed-in user
 * @storageTier tier1_d1
 * @param {object} body {name}
 * @throws 400 no name
 */
// helper comment
export async function things(req) {}
/**
 * @rpc Dir.who(email, appId)
 * @module things
 * @permission service binding
 */
export class Dir {}
/** plain comment, not a route */
function x() {}
`;
const SQL = `
-- @table things
-- @module things
-- @storageTier tier1_d1
-- @description A thing.
-- @foreignKey owner users.email (N:1) who made it
CREATE TABLE IF NOT EXISTS things (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,  -- users.email
  kind  TEXT NOT NULL DEFAULT 'a',
  parent INTEGER REFERENCES things(id)
);
CREATE INDEX IF NOT EXISTS things_owner ON things (owner);
INSERT INTO things (owner) VALUES ('x');
-- @module things
-- @storageTier tier1_d1
-- @description People.
CREATE TABLE IF NOT EXISTS users (
  email TEXT NOT NULL,
  name  TEXT,
  PRIMARY KEY (email)
);
`;
const cfg = { app: 't', name: 'T', modules: { things: 'Things' } };

test('routes: one entry per @route, per-route permission, handler found past comments', () => {
  const r = parseJs(JS, 'w.js');
  assert.deepEqual(r.map((x) => `${x.method} ${x.path} [${x.permission}] ${x.handler}`), [
    'GET /api/things [signed-in user] things', 'POST /api/things [admin] things', 'RPC Dir.who(email, appId) [service binding] Dir']);
  assert.equal(r[0].storageTier, 'tier1_d1');
  assert.equal(r[0].description, 'Things: list and add.');
  assert.deepEqual(r[0].throws, ['400 no name']);
});

test('schema: columns, keys, defaults, indexes, annotated and DDL foreign keys', () => {
  const s = parseSql(SQL, 's.sql');
  assert.deepEqual(Object.keys(s.tables), ['things', 'users']);
  assert.deepEqual(s.tables.things.columns.map((c) => c.name), ['id', 'owner', 'kind', 'parent']);
  assert.deepEqual(s.tables.things.primaryKey, ['id']);
  assert.deepEqual(s.tables.users.primaryKey, ['email']);
  assert.equal(s.tables.things.columns[2].default, "'a'");
  assert.equal(s.tables.things.columns[1].description, 'users.email');
  assert.deepEqual(s.tables.things.indexes, ['things_owner (owner)']);
  assert.deepEqual(s.fks.map((f) => `${f.from}>${f.to} ${f.cardinality} ${f.enforced}`), ['things.owner>users.email N:1 false', 'things.parent>things.id N:1 true']);
  assert.deepEqual(validate(cfg, parseJs(JS, 'w.js'), s), []);
});

test('mermaid: entities, keys and parent-first relationships', () => {
  const m = mermaid(parseSql(SQL, 's.sql'));
  assert.match(m, /^erDiagram/);
  assert.match(m, /INTEGER id PK/);
  assert.match(m, /TEXT owner FK/);
  assert.match(m, /users \|\|--o\{ things : "owner \(logical\)"/);
  assert.match(m, /things \|\|--o\{ things : "parent"/);
});

test('missing annotations and broken links are errors', () => {
  const s = parseSql('CREATE TABLE a (\n  id TEXT PRIMARY KEY\n);\n-- @module things\n-- @storageTier nowhere\n-- @description B\n-- @foreignKey x a.nope\nCREATE TABLE b (\n  x TEXT\n);\n', 's.sql');
  const errs = validate(cfg, parseJs('/**\n * @route GET /x\n */\nfunction f() {}', 'w.js'), s).join('\n');
  assert.match(errs, /GET \/x: missing @module/);
  assert.match(errs, /GET \/x: missing @permission/);
  assert.match(errs, /table a: missing -- @module/);
  assert.match(errs, /table b: missing or unknown -- @storageTier/);
  assert.match(errs, /b\.x → a\.nope: no such column/);
});

test('this repo: docs are complete and up to date', () => {
  const { errors, stale, counts } = run(process.cwd(), 'docs.config.json', true);
  assert.deepEqual(errors, []);
  assert.deepEqual(stale, [], 'run npm run docs and commit');
  // every API branch in worker.js has a documented route
  const src = fs.readFileSync('worker.js', 'utf8');
  const routes = parseJs(src, 'worker.js').map((r) => r.path);
  for (const [, res] of src.matchAll(/resource === '([\w-]+)'/g)) assert.ok(routes.some((p) => p.includes(`/${res}`)), `undocumented resource ${res}`);
  assert.ok(counts.tables >= 13 && counts.foreignKeys >= 17);
});
