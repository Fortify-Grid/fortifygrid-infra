// node --test platform/ — the UI kit's plain functions (no browser needed). The kit itself: public/platform/v1/fg-ui.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mem = new Map();
const ctx = {
  window: {}, location: { search: '', pathname: '/', hash: '' }, history: { replaceState() {} },
  document: { addEventListener() {}, querySelectorAll: () => [] },
  localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) },
};
vm.runInNewContext(fs.readFileSync('public/platform/v1/fg-ui.js', 'utf8'), ctx);
const FG = ctx.window.FG;
const j = (x) => JSON.parse(JSON.stringify(x)); // values from the sandbox → plain objects

test('order: saved order first, new items after, unknown ids dropped', () => {
  assert.deepEqual(j(FG.orderBy(['a', 'b', 'c', 'd'], ['c', 'x', 'a'])), ['c', 'a', 'b', 'd']);
  assert.deepEqual(j(FG.orderBy([{ id: 1 }, { id: 2 }], ['2'], (x) => x.id).map((x) => x.id)), [2, 1]);
});

test('move: dropped item takes the target place', () => {
  assert.deepEqual(j(FG.moveKey(['a', 'b', 'c', 'd'], 'd', 'b')), ['a', 'd', 'b', 'c']);
  assert.deepEqual(j(FG.moveKey(['a', 'b', 'c'], 'a', 'c')), ['b', 'a', 'c']);
  assert.deepEqual(j(FG.moveKey(['a', 'b'], 'a', 'zz')), ['a', 'b']);
});

test('settings are per app and per user', () => {
  FG.configure({ app: 'planner', user: 'a@x.com' });
  assert.equal(FG.key('table:tasks'), 'fg:planner:a@x.com:table:tasks');
  FG.store.set(FG.key('t'), { n: 1 });
  assert.deepEqual(j(FG.store.get('fg:planner:a@x.com:t')), { n: 1 });
  assert.equal(FG.store.get('missing', 7), 7);
});

test('escape and help markup', () => {
  assert.equal(FG.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.match(FG.info('Why <b>'), /class="fg-info".*role="tooltip" hidden>Why &lt;b&gt;</);
});

test('app list: Home first, every FortifyGrid app on https', () => {
  assert.equal(FG.HOME.url, 'https://app.fortifygrid.com/');
  assert.deepEqual(j(FG.APPS.map((a) => a.id)), ['website', 'workplan', 'ide', 'heatmap', 'query', 'revenue']);
  assert.ok(FG.APPS.every((a) => a.url.startsWith('https://')));
});
