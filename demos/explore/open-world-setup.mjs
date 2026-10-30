// Setup for an open-world run: claims houses (claim.mjs), starts the owners' phones (owner-bot.mjs: a weekly shop for each
// house, an allowance for its assistant, advice followed) and, if demo.json has `blackout: { at, for }` (seconds), a
// blackout of Lake B (blackout.mjs) that nobody in the run is told about.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const run = process.argv[2];
const here = import.meta.dirname;
const vars = JSON.parse(execFileSync(process.execPath, [join(here, 'claim.mjs'), run], { encoding: 'utf8', env: process.env }));
// The houses' regions, in turn: demo.json `regions` (default all in VIC).
const { blackout, regions = ['vic'] } = JSON.parse(readFileSync(join(process.env.EXPLORE_DEMO, 'demo.json'), 'utf8'));
const intent = JSON.stringify({ pack: 'shopping', terms: { region: regions, budget: 'auto', delivery: 'this-week' } });
spawn(process.execPath, [join(here, 'owner-bot.mjs'), run, intent, '80', '40', 'AUD'], { detached: true, stdio: 'ignore' }).unref();
if (blackout) spawn(process.execPath, [join(here, 'blackout.mjs'), run, String(blackout.at), String(blackout.for)], { detached: true, stdio: 'ignore' }).unref();
console.log(JSON.stringify(vars));
