// A blackout for a run: after `at` seconds, Lake B's node, specialists, houses and grocers stop for `for` seconds, then
// start again. Its connector stays up, so B's agents keep their identities while half their world is gone.
// Usage: node blackout.mjs <run> <at> <for> [compose project]; logs to <run>/blackout.log.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const [run, at = '600', dur = '180', project = 'lake-local-b'] = process.argv.slice(2);
const log = (s) => appendFileSync(join(run, 'blackout.log'), `${new Date().toISOString()} ${s}\n`);
const parts = ['lake-node', 'specialists', 'houses', 'grocers'].map((s) => `${project}-${s}-1`);
const docker = (...a) => { try { return execFileSync('docker', a, { encoding: 'utf8' }).trim(); } catch (e) { return `error: ${e.message}`; } };
await new Promise((r) => setTimeout(r, Number(at) * 1000));
log(`blackout: stopping ${parts.join(', ')}: ${docker('stop', '-t', '2', ...parts).replace(/\n/g, ' ')}`);
await new Promise((r) => setTimeout(r, Number(dur) * 1000));
log(`lights on: starting them again: ${docker('start', ...parts).replace(/\n/g, ' ')}`);
