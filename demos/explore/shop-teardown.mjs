// Teardown for a shopping run: stops the owners' phones (owner-bot.mjs), then hands the houses back (release.mjs).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const run = process.argv[2];
writeFileSync(join(run, 'stop-owner-bot'), '');
// What the owner's calendar app and a visitor would see, before the houses are handed back (run 49: after release the
// calendar address was gone and the door closed, and the narrator couldn't tell why).
const feed = existsSync(join(run, 'calendar-feed.txt')) ? readFileSync(join(run, 'calendar-feed.txt'), 'utf8').trim() : '';
if (feed) writeFileSync(join(run, 'calendar.ics'), await fetch(feed).then((r) => r.text()).catch((e) => `unreadable: ${e.message}`));
const [first] = existsSync(join(run, 'owners.json')) ? JSON.parse(readFileSync(join(run, 'owners.json'), 'utf8')) : [];
if (first?.url) writeFileSync(join(run, 'door-page.html'), await fetch(first.url, { headers: { accept: 'text/html' } }).then((r) => r.text()).catch((e) => `unreadable: ${e.message}`));
process.stdout.write(execFileSync(process.execPath, [join(import.meta.dirname, 'release.mjs'), run], { encoding: 'utf8', env: process.env }));
