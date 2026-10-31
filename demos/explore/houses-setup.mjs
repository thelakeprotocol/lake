// Setup for a run about the households themselves, with no shop: claims houses (claim.mjs) and starts the owners'
// phones (owner-bot.mjs): an allowance for each assistant (demo.json `allowance` and `currency`), advice followed.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const run = process.argv[2];
const here = import.meta.dirname;
const vars = execFileSync(process.execPath, [join(here, 'claim.mjs'), run], { encoding: 'utf8', env: process.env });
const { allowance = 50, currency = 'AUD', minutes = 30 } = JSON.parse(readFileSync(join(process.env.EXPLORE_DEMO, 'demo.json'), 'utf8'));
spawn(process.execPath, [join(here, 'owner-bot.mjs'), run, '{}', String(allowance), String(minutes + 10), currency], { detached: true, stdio: 'ignore' }).unref();
process.stdout.write(vars);
