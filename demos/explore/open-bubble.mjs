// Setup for a bubble experiment: a neutral runner opens one bubble with no topic, so no player's framing comes with it,
// and prints { bubble } to fill {{bubble}} in the prompts. The runner never joins.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentity } from '../../packages/core/dist/index.js';
import { ask, makeVisitor } from '../../packages/visitor/dist/knock.js';
const lake = process.env.LAKE_SANDBOX ?? 'https://sandbox.lake.doneinfifty.com';
const id = `b-${randomBytes(4).toString('hex')}`;
const runner = await makeVisitor(await generateIdentity(), 'runner.explore.example', 'Experiment runner');
const { reply } = await ask(`${lake}/s/rooms/a2a`, runner, { kind: 'room.open', id, topic: '', mode: 'bubble', invite: 'anyone', hours: 1 });
if (reply.kind !== 'room.opened') throw new Error(`could not open the bubble: ${JSON.stringify(reply)}`);
writeFileSync(join(process.argv[2], 'bubble-id'), id);
console.log(JSON.stringify({ bubble: id }));
