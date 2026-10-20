#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  buildCard, describe, exportIdentity, importIdentity, makeEvent, parseRules, signCard,
  type Identity, type LakeEvent,
} from '@thelakeprotocol/core';
import { Housekeeper } from './housekeeper.js';
import { createPodMcpServer } from './pod-mcp.js';
import { ownerSession, startPod, type OwnerSession } from './pod.js';
import { convertRecord, fetchRecord, RECORD } from './record.js';
import { createHouseServer } from './server.js';

const { values: a } = parseArgs({
  options: {
    name: { type: 'string' },
    rules: { type: 'string', default: process.env.LAKE_RULES ?? '/rules.yaml' },
    data: { type: 'string', default: process.env.LAKE_DATA ?? '/data' },
    port: { type: 'string', default: process.env.LAKE_PORT ?? '4000' },
    'pod-port': { type: 'string', default: process.env.LAKE_POD_PORT ?? '3000' },
    'public-url': { type: 'string', default: process.env.LAKE_PUBLIC_URL },
    'pod-url': { type: 'string', default: process.env.LAKE_POD_URL },
    'issuer-url': { type: 'string', default: process.env.LAKE_ISSUER_URL ?? 'http://issuer:4300' },
    domain: { type: 'string', default: process.env.LAKE_DOMAIN },
    production: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const rules = parseRules(await readFile(a.rules!, 'utf8').catch(() => readFile(new URL('../../../personas/stan.yaml', import.meta.url), 'utf8')));
const name = (a.name ?? rules.owner ?? hostname()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
const port = Number(a.port);
const podPort = Number(a['pod-port']);
// In Docker, other containers reach us by our hostname (set it with --hostname); elsewhere, localhost.
const inDocker = existsSync('/.dockerenv');
const publicUrl = (a['public-url'] ?? `http://${inDocker ? hostname() : 'localhost'}:${port}`).replace(/\/$/, '');
const podUrl = (a['pod-url'] ?? `http://localhost:${podPort}`).replace(/\/?$/, '/');
// Solid-OIDC only trusts HTTPS issuers, or plain HTTP on localhost (solid.github.io/solid-oidc/#security-tls).
const podHost = new URL(podUrl);
if (podHost.protocol === 'http:' && podHost.hostname.split('.').pop() !== 'localhost') {
  console.error(`--pod-url ${podUrl}: Solid-OIDC needs HTTPS here, or plain HTTP on localhost. Put TLS in front of the pod, or leave --pod-url unset.`);
  process.exit(2);
}
const sandbox = !a.production;
const actor = `house:${name}`;

const emit = (e: LakeEvent) => console.log(a.json ? JSON.stringify(e) : `[${actor}] ${describe(e)}`);
const say = (msg: string) => console.log(a.json ? JSON.stringify({ at: new Date().toISOString(), actor, msg }) : `[${actor}] ${msg}`);

// 1. The pod.
say(`starting pod for ${name}`);
const podOpts = { dataDir: `${a.data}/${name}`, port: podPort, baseUrl: podUrl, owner: name };
const pod = await startPod(podOpts);
const owner = await ownerSession(podOpts);
say(`pod up: ${owner.podRoot} (WebID ${owner.webId})`);

// 2. Folders and wallet. The owner sets these up; after this the housekeeper only goes through MCP.
for (const f of ['health/', 'health/original/', 'finance/', 'agreements/', 'receipts/', 'wallet/']) await ensureContainer(owner, f);
const id = await walletIdentity(owner);

// 3. The record: signed by the issuer, converted in the pod, signed again by the housekeeper.
const claimsUrl = `${owner.podRoot}${RECORD.claims}`;
if ((await owner.fetch(`${owner.podRoot}${RECORD.claims}`, { method: 'HEAD' })).status === 404) {
  say(`asking the issuer at ${a['issuer-url']} for a signed synthetic record`);
  try {
    const r = await fetchRecord(a['issuer-url']!, owner.webId);
    const c = await convertRecord(r, { webId: owner.webId, claimsUrl, id });
    await put(owner, RECORD.bundle, r.bundle, 'application/json');
    await put(owner, RECORD.credential, r.credential, 'text/plain');
    await put(owner, RECORD.issuer, JSON.stringify({ issuer: r.issuer, recordId: r.recordId, jwk: r.issuerJwk }), 'application/json');
    await put(owner, RECORD.claims, c.turtle, 'text/turtle');
    await put(owner, RECORD.claimsCredential, c.credential, 'text/plain');
    say(`record stored: ${c.claims.length} claims (${[...new Set(c.claims.map((x) => x.field))].join(', ')})`);
  } catch (e) {
    say(`WARNING: ${(e as Error).message}. This house holds no signed record and will not join studies.`);
  }
}

// 4. The housekeeper, its MCP door to the pod, and its signed card.
const mcp = createPodMcpServer({ podRoot: owner.podRoot, fetch: owner.fetch });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await mcp.connect(serverSide);
const podClient = new Client({ name: `housekeeper-${name}`, version: '0.1.0' });
await podClient.connect(clientSide);

const card = await signCard(
  buildCard(
    {
      name: `House ${name}`,
      description: `Housekeeper for ${name}. Answers by its owner's rules. Data never leaves.`,
      url: `${publicUrl}/a2a`,
      skills: [{ id: 'health-study', name: 'Health study', description: 'Considers research offers by its owner\'s rules', tags: rules.tags ?? [] }],
      profile: { role: 'house', webId: owner.webId, ownerDomain: a.domain ?? new URL(publicUrl).hostname, tags: rules.tags ?? [] },
    },
    id,
  ),
  id,
);
const keeper = new Housekeeper({ name, webId: owner.webId, id, card, rules, pod: podClient, claimsUrl, sandbox, emit });
const check = await keeper.verifyOwnRecord();
say(check.ok ? 'record chain verified: issuer → original → converted → housekeeper' : `record chain BROKEN: ${check.why}`);

const server = createHouseServer(card, keeper).listen(port, () => {
  say(`A2A on ${publicUrl}/a2a · card at ${publicUrl}/.well-known/agent-card.json${sandbox ? ' · sandbox Lake' : ''}`);
  emit(makeEvent('house.joined', actor, undefined, { tags: (rules.tags ?? []).join(',') }));
});

const stop = () => {
  emit(makeEvent('house.left', actor));
  server.close();
  pod.stop();
  setTimeout(() => process.exit(0), 300).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

async function ensureContainer(o: OwnerSession, path: string) {
  const url = o.podRoot + path;
  if ((await o.fetch(url, { method: 'HEAD' })).ok) return;
  const res = await o.fetch(url, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '' });
  if (!res.ok) throw new Error(`could not create ${path}: ${res.status}`);
}

async function put(o: OwnerSession, path: string, body: string, contentType: string) {
  const res = await o.fetch(o.podRoot + path, { method: 'PUT', headers: { 'content-type': contentType }, body });
  if (!res.ok) throw new Error(`could not write ${path}: ${res.status}`);
}

/** The housekeeper's signing key lives in the owner's pod, in /wallet/, readable only by the owner. */
async function walletIdentity(o: OwnerSession): Promise<Identity> {
  const url = `${o.podRoot}wallet/identity.json`;
  const res = await o.fetch(url);
  if (res.ok) return importIdentity(await res.json());
  const { generateIdentity } = await import('@thelakeprotocol/core');
  const fresh = await generateIdentity();
  await put(o, 'wallet/identity.json', JSON.stringify(await exportIdentity(fresh)), 'application/json');
  return fresh;
}
