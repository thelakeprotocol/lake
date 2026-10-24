// Setup for a shopping run: claims houses (claim.mjs), then starts the owners' phones (owner-bot.mjs) in the background:
// a weekly-shop intent for each house, an allowance for its assistant, Accept when the assistant names an offer.
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
const run = process.argv[2];
const here = import.meta.dirname;
const vars = JSON.parse(execFileSync(process.execPath, [join(here, 'claim.mjs'), run], { encoding: 'utf8', env: process.env }));
const intent = JSON.stringify({ pack: 'shopping', terms: { region: 'vic', budget: 'auto', delivery: 'this-week' } });
spawn(process.execPath, [join(here, 'owner-bot.mjs'), run, intent, '150', '30', 'AUD'], { detached: true, stdio: 'ignore' }).unref();
console.log(JSON.stringify(vars));
