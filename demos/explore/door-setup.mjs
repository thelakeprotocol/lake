// Setup for a door run: claims houses (claim.mjs), opens house 1's door with a line (the owner's phone, through the panel),
// and starts the owners' phones (owner-bot.mjs) in the background: no shop, an allowance for the assistant, advice followed.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importIdentity, signMessage } from '../../packages/core/dist/index.js';
const run = process.argv[2];
const here = import.meta.dirname;
const vars = JSON.parse(execFileSync(process.execPath, [join(here, 'claim.mjs'), run], { encoding: 'utf8', env: process.env }));
const [stan] = JSON.parse(readFileSync(join(run, 'owners.json'), 'utf8'));
const owner = await importIdentity(stan.key);
const call = async (p) => (await fetch(`${stan.url}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(p, owner, { iss: stan.webId })) })).json();
// The scenario may give the door its own line (demo.json `doorAbout`).
const about = (process.env.EXPLORE_DEMO && JSON.parse(readFileSync(join(process.env.EXPLORE_DEMO, 'demo.json'), 'utf8')).doorAbout) || 'Ask my agent about work, talks or meeting up.';
const opened = await call({ kind: 'panel.door.set', open: true, about });
if (!opened.ok) throw new Error(`door: ${JSON.stringify(opened)}`);
vars.house_1_door = (await call({ kind: 'panel.door' })).address;
spawn(process.execPath, [join(here, 'owner-bot.mjs'), run, '{}', '50', '30', 'USD'], { detached: true, stdio: 'ignore' }).unref();
console.log(JSON.stringify(vars));
