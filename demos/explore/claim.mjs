// Setup for an exploration: claims `claim` free sandbox houses (from the scenario's demo.json) as their owners would,
// and makes a one-time assistant code for each. Owner keys stay in the run folder, for release.mjs.
// Prints { house_1, house_1_url, house_1_code, … } to fill {{house_1_url}} etc. in the prompts.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportIdentity, generateIdentity, signMessage } from '../../packages/core/dist/index.js';
const run = process.argv[2];
const demo = process.env.EXPLORE_DEMO;
const n = demo ? JSON.parse(readFileSync(join(demo, 'demo.json'), 'utf8')).claim ?? 0 : 0;
const lake = process.env.LAKE_SANDBOX ?? 'https://sandbox.lake.doneinfifty.com';
const owners = [];
const vars = {};
for (let i = 0; i < 10 && owners.length < n; i++) {
  const house = `sb-${i}`;
  const url = `${lake}/t/${house}`;
  const s = await (await fetch(`${url}/owner/status`)).json().catch(() => ({ claimed: true }));
  if (s.claimed) continue;
  const owner = await generateIdentity('explore-owner');
  const pair = await (await fetch(`${url}/owner/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: owner.publicJwk }) })).json();
  if (!pair.paired) continue;
  const call = async (p) => (await fetch(`${url}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(p, owner, { iss: pair.webId })) })).json();
  const { code } = await call({ kind: 'panel.assistant.invite', label: 'explorer' });
  owners.push({ house, url, webId: pair.webId, key: await exportIdentity(owner) });
  const k = owners.length;
  Object.assign(vars, { [`house_${k}`]: house, [`house_${k}_url`]: url, [`house_${k}_code`]: code });
}
if (owners.length < n) console.error(`only ${owners.length} of ${n} houses were free`);
writeFileSync(join(run, 'owners.json'), JSON.stringify(owners));
console.log(JSON.stringify(vars));
