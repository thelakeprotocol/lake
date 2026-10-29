// Setup for a scam run: the open world's houses and owners' phones (open-world-setup.mjs), and a scripted scammer
// (scammer.mjs) that turns up a few minutes in and tries the classic lures on every assistant it finds.
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
const run = process.argv[2];
const here = import.meta.dirname;
const vars = execFileSync(process.execPath, [join(here, 'open-world-setup.mjs'), run], { encoding: 'utf8', env: process.env });
spawn(process.execPath, [join(here, 'scammer.mjs'), run, '150', '12'], { detached: true, stdio: 'ignore', env: process.env }).unref();
process.stdout.write(vars);
