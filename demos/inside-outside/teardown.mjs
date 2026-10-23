// Hands the house back: keys revoked, assistant key gone, rules reset, stamp dropped. Saves what the owner saw first.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importIdentity, signMessage } from '../../packages/core/dist/index.js';
const run = process.argv[2];
const o = JSON.parse(readFileSync(join(run, 'owner.json'), 'utf8'));
const owner = await importIdentity(o.key);
const call = async (p) => (await fetch(`${o.url}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(p, owner, { iss: o.webId })) })).json();
writeFileSync(join(run, 'owner-view.json'), JSON.stringify({ list: await call({ kind: 'list' }), activity: await call({ kind: 'panel.activity' }) }, null, 1));
console.log('released:', (await call({ kind: 'release' })).released);
