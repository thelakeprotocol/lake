// Teardown for a shopping run: stops the owners' phones (owner-bot.mjs), then hands the houses back (release.mjs).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const run = process.argv[2];
writeFileSync(join(run, 'stop-owner-bot'), '');
process.stdout.write(execFileSync(process.execPath, [join(import.meta.dirname, 'release.mjs'), run], { encoding: 'utf8', env: process.env }));
