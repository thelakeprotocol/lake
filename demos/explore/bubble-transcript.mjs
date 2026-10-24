// Teardown for a bubble experiment: saves the closed bubble's transcript (public on the sandbox) as bubble.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const run = process.argv[2];
const lake = process.env.LAKE_SANDBOX ?? 'https://sandbox.lake.doneinfifty.com';
const id = readFileSync(join(run, 'bubble-id'), 'utf8').trim();
for (let i = 0; i < 8; i++) {
  const r = await fetch(`${lake}/s/rooms/transcripts/${id}`);
  if (r.ok) { writeFileSync(join(run, 'bubble.json'), JSON.stringify(await r.json(), null, 1)); console.log('bubble transcript saved'); process.exit(0); }
  await new Promise((ok) => setTimeout(ok, 15_000));
}
console.log('no transcript yet (the bubble may still be open)');
