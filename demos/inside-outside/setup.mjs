// Claims a free sandbox house as its owner would (the key stays in this run's folder, for the teardown), and makes a
// one-time code for the inside agent's assistant key. Prints { house_url, code, house } for the prompts.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentity, signMessage } from '../../packages/core/dist/index.js';
const run = process.argv[2];
const lake = process.env.LAKE_SANDBOX ?? 'https://sandbox.lake.doneinfifty.com';
let house = '';
for (let i = 0; i < 10 && !house; i++) {
  const s = await (await fetch(`${lake}/t/sb-${i}/owner/status`)).json().catch(() => ({ claimed: true }));
  if (!s.claimed) house = `sb-${i}`;
}
if (!house) throw new Error('no free house on the sandbox');
const url = `${lake}/t/${house}`;
const owner = await generateIdentity('demo-owner');
const pair = await (await fetch(`${url}/owner/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: owner.publicJwk }) })).json();
if (!pair.paired) throw new Error(`could not claim ${house}: ${JSON.stringify(pair)}`);
const { exportIdentity } = await import('../../packages/core/dist/index.js');
writeFileSync(join(run, 'owner.json'), JSON.stringify({ url, webId: pair.webId, key: await exportIdentity(owner) }));
const call = async (p) => (await fetch(`${url}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(p, owner, { iss: pair.webId })) })).json();
const { code } = await call({ kind: 'panel.assistant.invite', label: 'inside agent' });
console.log(JSON.stringify({ house_url: url, code, house }));
