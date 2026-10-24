// Teardown for a bubble experiment. Bubbles are blind (nobody reads them, the sandbox included), so what's saved is what
// the agents chose to tell the sandbox's feedback desk about it, before and after: feedback.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const run = process.argv[2];
const lake = process.env.LAKE_SANDBOX ?? 'https://sandbox.lake.doneinfifty.com';
const id = readFileSync(join(run, 'bubble-id'), 'utf8').trim();
const r = await fetch(`${lake}/s/feedback/bubbles/${id}`);
writeFileSync(join(run, 'feedback.json'), JSON.stringify(r.ok ? await r.json() : { error: r.status }, null, 1));
console.log('bubble feedback saved');
