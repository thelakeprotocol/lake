#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import express from 'express';
import { describe, parseRules, seedFrom, type LakeEvent } from '@thelakeprotocol/core';

import { startHouse, type House } from './house.js';
import { loadPacks } from './packs.js';
import { closePodRoot, externalSession, ownerSession, startPod, startProvider, tenantSessions, type OwnerSession } from './pod.js';

const { values: a } = parseArgs({
  options: {
    name: { type: 'string' },
    rules: { type: 'string', default: process.env.LAKE_RULES ?? '/rules.yaml' },
    data: { type: 'string', default: process.env.LAKE_DATA ?? '/data' },
    port: { type: 'string', default: process.env.LAKE_PORT ?? '4000' },
    'pod-port': { type: 'string', default: process.env.LAKE_POD_PORT ?? '3000' },
    'public-url': { type: 'string', default: process.env.LAKE_PUBLIC_URL },
    'pod-url': { type: 'string', default: process.env.LAKE_POD_URL },
    // The use cases this house takes part in, by pack id (each one is a package: @thelakeprotocol/usecase-<id>).
    packs: { type: 'string', default: process.env.LAKE_PACKS ?? 'health' },
    // Each pack's issuer: health=http://…,mortgage=http://… (--issuer-url sets the first pack's, as before).
    issuers: { type: 'string', default: process.env.LAKE_ISSUERS },
    'issuer-url': { type: 'string', default: process.env.LAKE_ISSUER_URL },
    lake: { type: 'string', default: process.env.LAKE_NODE_URL },
    'auditor-url': { type: 'string', default: process.env.LAKE_AUDITOR_URL },
    // The person checker this house asks for its stamp (one person, one house); none by default.
    'person-url': { type: 'string', default: process.env.LAKE_PERSON_URL },
    // The tellers this operator vouches for, by address: where domains aren't proven (a sandbox), houses trust tellers only here.
    tellers: { type: 'string', default: process.env.LAKE_TELLERS },
    join: { type: 'string', default: process.env.LAKE_JOIN },
    // Bring your own pod (any Solid server): your WebID and client credentials registered with its identity provider.
    webid: { type: 'string', default: process.env.LAKE_WEBID },
    'client-id': { type: 'string', default: process.env.LAKE_CLIENT_ID },
    'client-secret': { type: 'string', default: process.env.LAKE_CLIENT_SECRET },
    pod: { type: 'string', default: process.env.LAKE_POD },
    'oidc-issuer': { type: 'string', default: process.env.LAKE_OIDC_ISSUER },
    'pod-folder': { type: 'string', default: process.env.LAKE_POD_FOLDER ?? 'lake' },
    seed: { type: 'string', default: process.env.LAKE_SEED },
    'owner-url': { type: 'string', default: process.env.LAKE_OWNER_URL },
    'open-pairing': { type: 'boolean', default: process.env.LAKE_OPEN_PAIRING === '1' },
    domain: { type: 'string', default: process.env.LAKE_DOMAIN },
    production: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    tenants: { type: 'string', default: process.env.LAKE_TENANTS },
    'tenant-prefix': { type: 'string', default: process.env.LAKE_TENANT_PREFIX },
    'personas-dir': { type: 'string', default: process.env.LAKE_PERSONAS ?? '/personas' },
    relay: { type: 'boolean', default: process.env.LAKE_RELAY === '1' },
    // With --open-pairing, how long a claim lasts before the house resets for the next person (0: forever).
    'lease-hours': { type: 'string', default: process.env.LAKE_LEASE_HOURS },
  },
});

// `--join https://sandbox.lake.example`: one flag for a house at home. That Lake's node, its issuer and
// auditor (at /s/issuer, /s/auditor, as a sandbox serves them), reached through its relay.
if (a.join) {
  const lake = a.join.replace(/\/$/, '');
  a.lake ??= lake;
  a['auditor-url'] ??= `${lake}/s/auditor`;
  a['person-url'] ??= `${lake}/s/person`;
  a.tellers ??= `${lake}/s/teller-a/a2a,${lake}/s/teller-b/a2a`;
  a.relay = true;
}
const port = Number(a.port);
const podPort = Number(a['pod-port']);
// In Docker, other containers reach us by our hostname (set it with --hostname); elsewhere, localhost.
const inDocker = existsSync('/.dockerenv');
// Joining from home, only you open this address (your control panel); everyone else comes through the relay.
const baseUrl = (a['public-url'] ?? `http://${inDocker && !a.join ? hostname() : 'localhost'}:${port}`).replace(/\/$/, '');
const podUrl = (a['pod-url'] ?? `http://localhost:${podPort}`).replace(/\/?$/, '/');
// Solid-OIDC only trusts HTTPS issuers, or plain HTTP on localhost (solid.github.io/solid-oidc/#security-tls).
const podHost = new URL(podUrl);
if (podHost.protocol === 'http:' && podHost.hostname.split('.').pop() !== 'localhost') {
  console.error(`--pod-url ${podUrl}: Solid-OIDC needs HTTPS here, or plain HTTP on localhost. Put TLS in front of the pod, or leave --pod-url unset.`);
  process.exit(2);
}
const sandbox = !a.production;
const packs = await loadPacks(a.packs!.split(','), (n) => import(n));
// A pack's issuer: named explicitly, or the joined Lake's (/s/<path>), or the demo compose service (<path>:4300).
const named = Object.fromEntries((a.issuers ?? '').split(',').filter((x) => x.includes('=')).map((x) => x.split('=').map((y) => y.trim()) as [string, string]));
const issuerUrls = Object.fromEntries(packs.filter((p) => p.source).map((p, i) => [p.id,
  (named[p.id] ?? (i === 0 ? a['issuer-url'] : undefined) ?? (a.join ? `${a.join.replace(/\/$/, '')}/s/${p.source!.issuer.path}` : `http://${p.source!.issuer.path}:4300`)).replace(/\/$/, '')]));
const common = { packs, issuerUrls, auditorUrl: a['auditor-url'] ?? 'http://auditor:4400', personUrl: a['person-url'], tellerUrls: (a.tellers ?? '').split(',').map((u) => u.trim()).filter(Boolean), lakeUrl: a.lake, seed: a.seed, sandbox, domain: a.domain };

if (a.tenants) await hosted(Number(a.tenants));
else await single();

/** One house: its own pod server, its own port. `docker run lake-house --name you`. */
async function single() {
  const rulesText = await readFile(a.rules!, 'utf8').catch(() => readFile(new URL('../../../personas/stan.yaml', import.meta.url), 'utf8'));
  const rules = parseRules(rulesText);
  const name = (a.name ?? rules.owner ?? hostname()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const actor = `house:${name}`;
  const emit = (e: LakeEvent) => console.log(a.json ? JSON.stringify(e) : `[${actor}] ${describe(e)}`);
  const say = (msg: string) => console.log(a.json ? JSON.stringify({ at: new Date().toISOString(), actor, msg }) : `[${actor}] ${msg}`);

  const podOpts = { dataDir: `${a.data}/${name}`, port: podPort, baseUrl: podUrl, owner: name };
  let pod: { stop: () => void } | null = null;
  let owner: OwnerSession;
  if (a.webid) {
    if (!a['client-id'] || !a['client-secret']) throw new Error('--webid needs --client-id and --client-secret: register an app with your Solid identity provider');
    const x = await externalSession({ webId: a.webid, clientId: a['client-id'], clientSecret: a['client-secret'], podRoot: a.pod, oidcIssuer: a['oidc-issuer'], folder: a['pod-folder'] });
    owner = x;
    await mkdir(podOpts.dataDir, { recursive: true }); // the owner's desk keeps its pairing state here
    say(`your own pod: ${owner.podRoot} (WebID ${owner.webId}, logged in at ${x.oidcIssuer})`);
  } else {
    say(`starting pod for ${name}`);
    pod = await startPod(podOpts);
    owner = await ownerSession(podOpts);
    if (await closePodRoot(owner)) say('closed the pod\'s top folder to strangers');
    say(`pod up: ${owner.podRoot} (WebID ${owner.webId})`);
  }

  if (a.relay && !a.lake) throw new Error('--relay needs at least one Lake node (--lake or LAKE_NODE_URL) to relay through');
  const house = await startHouse({ ...common, name, rulesText, owner, dataDir: podOpts.dataDir, publicUrl: baseUrl, ownerUrl: a['owner-url'], openPairing: a['open-pairing'], leaseHours: a['open-pairing'] && a['lease-hours'] ? Number(a['lease-hours']) || undefined : undefined, emit, say, quiet: a.json, relay: a.relay ? { localPort: port } : undefined });
  const server = house.app.listen(port, async () => {
    say(a.relay ? `reached through the Lake's relay: ${house.card.supportedInterfaces.map((i) => i.url).join(' · ')}` : `A2A on ${baseUrl}/a2a · card at ${baseUrl}/.well-known/agent-card.json${sandbox ? ' · sandbox Lake' : ''}`);
    await house.join();
  });
  const stop = async () => {
    await house.leave();
    server.close();
    pod?.stop();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/**
 * Many houses in one process, like a pod provider: `lake-house --tenants 250`. Each is still its own
 * WebID, pod, wallet, signed card and rules file; only the process (and one pod server) is shared.
 */
async function hosted(n: number) {
  const t0 = Date.now();
  const prefix = (a['tenant-prefix'] ?? `${hostname().replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}-`).replace(/[^a-z0-9-]/g, '');
  const names = Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const dataDir = join(a.data!, 'hosted');
  const log = (msg: string) => console.log(`[hosted ${prefix}*] ${msg}`);
  // One process holds every hosted house: a slip in one (a pod write that timed out) must not take down the rest.
  process.on('unhandledRejection', (e) => log(`unhandled: ${(e as Error)?.message ?? e}`));

  log(`starting one pod server for ${n} houses`);
  const pods = await startProvider({ dataDir, port: podPort, baseUrl: podUrl, names });
  const sessions = await tenantSessions({ dataDir, baseUrl: podUrl, names });
  let closed = 0;
  await pool([...sessions.values()], 8, async (o) => { if (await closePodRoot(o).catch(() => false)) closed++; });
  if (closed) log(`closed ${closed} pods' top folders to strangers`);
  log(`${n} pods up, ${n} owners logged in (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const personas = await loadPersonas(a['personas-dir']!);
  const TAGS = ['research-volunteers', 'carers', 'renters', 'energy-buyers', 'cyclists'];
  const app = express();
  const houses: House[] = [];
  let warnings = 0;
  await pool(names, 8, async (name) => {
    // Each hosted house gets its own rules file: a persona, its own owner name, one or two interests.
    const h = seedFrom(name);
    // Personas are picked by their `# weight:`, the same one every time for the same house; `{{pick:a,b}}` picks a choice the same way.
    const total = personas.reduce((n, p) => n + p.weight, 0);
    let at = h % total;
    const persona = personas.find((p) => (at -= p.weight) < 0)!.text;
    let k = 0;
    const filled = persona.replace(/\{\{pick:([^}]+)\}\}/g, (_, list: string) => { const xs = list.split(','); return xs[seedFrom(`${name}|${k++}`) % xs.length]!.trim(); });
    const tags = [TAGS[h % TAGS.length]!, ...(h % 3 === 0 ? [TAGS[(h >> 3) % TAGS.length]!] : [])];
    const rulesText = filled.replace(/^owner: .*$/m, `owner: ${name}`).replace(/^tags: .*$/m, '') + `\ntags: [${[...new Set(tags)].join(', ')}]\n`;
    const houseDir = join(dataDir, 'houses', name);
    await mkdir(houseDir, { recursive: true });
    await writeFile(join(houseDir, 'rules.yaml'), rulesText);
    const house = await startHouse({
      ...common, name, rulesText, owner: sessions.get(name)!, dataDir: houseDir, publicUrl: `${baseUrl}/t/${name}`, openPairing: a['open-pairing'],
      leaseHours: a['open-pairing'] ? Number(a['lease-hours'] ?? 24) || undefined : undefined,
      emit: () => {}, say: (msg) => { if (/WARNING|BROKEN/.test(msg)) { warnings++; log(`${name}: ${msg}`); } }, quiet: true,
    });
    app.use(`/t/${name}`, house.app);
    houses.push(house);
  });
  app.get('/health', (_req, res) => void res.json({ ok: true, houses: houses.length }));
  // Which houses are free to claim right now, and when the taken ones free up.
  app.get('/t/', (_req, res) => {
    const rows = houses.map((h) => ({ name: h.name, until: h.desk.ownerJwk ? h.desk.leaseUntil()?.toISOString() ?? 'kept' : null }));
    if (_req.accepts(['html', 'json']) === 'json') return void res.json(rows);
    const li = rows.map((r) => r.until
      ? `<li><span>${r.name}</span><em>taken${r.until === 'kept' ? '' : ` until ${r.until.slice(11, 16)} UTC`}</em></li>`
      : `<li><a href="${r.name}/owner/">${r.name}</a><b>free · claim it</b></li>`).join('');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claim a house</title>
<style>body{margin:0;background:#070B12;color:#E6EDF2;font:16px/1.5 system-ui,sans-serif;padding:24px 16px;max-width:560px}h1{font:700 32px/1 'Arial Narrow',sans-serif;text-transform:uppercase}p{color:#8B9BAE}ul{list-style:none;padding:0;display:grid;gap:8px}li{display:flex;justify-content:space-between;border:1px solid #1D2838;border-radius:8px;padding:12px 14px;font-family:ui-monospace,monospace}a{color:#3DDC97}b{color:#3DDC97;font-weight:400}em{color:#8B9BAE;font-style:normal}</style>
<h1>Claim a house</h1><p>Sandbox houses: synthetic data, simulated money. A claim lasts ${Number(a['lease-hours'] ?? 24) || 'unlimited'} hours, then the house resets for the next person. Open one, tap <b>Pair this device</b>, and it's yours.</p><ul>${li}</ul>`);
  });

  const server = app.listen(port, async () => {
    await pool(houses, 16, (h) => h.join());
    log(`${houses.length} houses joined in ${((Date.now() - t0) / 1000).toFixed(1)}s${warnings ? ` (${warnings} warnings)` : ''}; each at ${baseUrl}/t/<name>/a2a`);
  });
  const stop = async () => {
    await Promise.all(houses.map((h) => h.leave()));
    server.close();
    pods.stop();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** Every persona in the folder (personas/*.yaml), with its `# weight:` (default 1). */
async function loadPersonas(dir: string): Promise<{ name: string; text: string; weight: number }[]> {
  const from = existsSync(dir) ? dir : new URL('../../../personas/', import.meta.url).pathname;
  const files = (await readdir(from)).filter((f) => f.endsWith('.yaml')).sort();
  return Promise.all(files.map(async (f) => {
    const text = await readFile(join(from, f), 'utf8');
    return { name: f.replace(/\.yaml$/, ''), text, weight: Number(text.match(/^# weight: (\d+)/m)?.[1] ?? 1) };
  }));
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}
