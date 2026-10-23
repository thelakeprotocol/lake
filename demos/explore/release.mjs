// Teardown for an exploration: saves what each claimed house's owner saw, then hands the houses back.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importIdentity, signMessage } from '../../packages/core/dist/index.js';
const run = process.argv[2];
const owners = JSON.parse(readFileSync(join(run, 'owners.json'), 'utf8'));
const views = {};
for (const o of owners) {
  const owner = await importIdentity(o.key);
  const call = async (p) => (await fetch(`${o.url}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(p, owner, { iss: o.webId })) })).json().catch((e) => ({ error: e.message }));
  views[o.house] = { list: await call({ kind: 'list' }), activity: await call({ kind: 'panel.activity' }), overview: await call({ kind: 'panel.overview' }) };
  console.log(`released ${o.house}:`, (await call({ kind: 'release' })).released);
}
writeFileSync(join(run, 'owner-view.json'), JSON.stringify(views, null, 1));
