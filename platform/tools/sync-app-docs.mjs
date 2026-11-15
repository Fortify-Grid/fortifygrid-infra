#!/usr/bin/env node
// Copies the generated docs of other FortifyGrid apps (sibling repos) into docs/apps/<app>/ so admin → Documentation can show them.
// Usage: node platform/tools/sync-app-docs.mjs ide=../FG2.\ fortifygrid-ide/docs/ide revenue=../FG3.\ revenue-analysis-module/docs/revenue
import fs from 'node:fs';
import path from 'node:path';
const FILES = ['index.json', 'api-reference.json', 'relationships.json'];
for (const arg of process.argv.slice(2)) {
  const [id, src] = arg.split('=');
  if (!id || !src) { console.error(`bad argument: ${arg} (use id=path/to/docs/<app>)`); process.exit(1); }
  const dest = path.join('docs', 'apps', id);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  console.log(`synced ${id} <- ${src}`);
}
