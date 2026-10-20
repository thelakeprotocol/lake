#!/usr/bin/env node
/**
 * For the machine's operator, inside the house container:
 *   docker compose exec house-stan node dist/admin.js revoke-all
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [cmd] = process.argv.slice(2);
const owner = process.env.LAKE_OWNER ?? (await readFile('/proc/1/cmdline', 'utf8').then((c) => c.split('\0')).then((a) => a[a.indexOf('--name') + 1]).catch(() => undefined));
const port = process.env.LAKE_PORT ?? '4000';
if (cmd !== 'revoke-all' || !owner) {
  console.error('usage: admin.js revoke-all   (set LAKE_OWNER if the house was not started with --name)');
  process.exit(2);
}
const token = (await readFile(join(process.env.LAKE_DATA ?? '/data', owner, 'operator-token'), 'utf8')).trim();
const res = await fetch(`http://localhost:${port}/owner/operator/revoke-all`, { method: 'POST', headers: { 'x-lake-operator': token } });
console.log(res.ok ? `revoked ${(await res.json()).revoked} key(s) of house ${owner}` : `failed: ${res.status} ${await res.text()}`);
