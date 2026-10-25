#!/usr/bin/env node
import { parseArgs } from 'node:util';
import express from 'express';
import { keepAliveBehindProxy, LakeLinks, loadOrCreateIdentity, loadPacks, makeEvent, type AgentCard, type LakePack } from '@thelakeprotocol/core';
import { createIssuer } from './issuer.js';
import { createAuditor, createAuthority, createEthics, createPayments } from './review.js';
import { createGuide } from './guide.js';
import { createInspector } from './inspector.js';
import { createSparring } from './sparring.js';
import { createQuests } from './quests.js';
import { createTally } from './tally.js';
import { createPersonhood } from './person.js';
import { createTeller } from './teller.js';
import { createPasses } from './passes.js';
import { createRooms } from './room.js';
import { createArbiter } from './arbiter.js';
import { createLog, type Logger } from './log.js';

const DEFAULTS: Record<string, { port: string; domain: string; pack?: LakePack; authority?: boolean }> = {
  auditor: { port: '4400', domain: 'audit.lake.local' },
  ethics: { port: '4500', domain: 'ethics.lake.local' },
  payments: { port: '4600', domain: 'payments.lake.local' },
  guide: { port: '4710', domain: 'guide.lake.local' },
  inspector: { port: '4720', domain: 'inspector.lake.local' },
  sparring: { port: '4730', domain: 'sparring.lake.local' },
  quests: { port: '4740', domain: 'quests.lake.local' },
  tally: { port: '4750', domain: 'tally.lake.local' },
  person: { port: '4760', domain: 'person.lake.local' },
  // Two tellers under different names, so studies have a pair. For real, the two are run by different organisations.
  'teller-a': { port: '4770', domain: 'teller-a.lake.local' },
  'teller-b': { port: '4780', domain: 'teller-b.lake.local' },
  rooms: { port: '4790', domain: 'rooms.lake.local' },
  // Rules on trades from signed evidence (SPEC §6.5).
  arbiter: { port: '4796', domain: 'arbiter.lake.local' },
  // The transparency log: receipts and rulings on the record (SPEC §11.8).
  log: { port: '4798', domain: 'log.lake.local' },
  // Anonymous passes for blind pledges (Privacy Pass): a separate party from the tally.
  passes: { port: '4797', domain: 'passes.lake.local' },
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    url: { type: 'string' },
    domain: { type: 'string' },
    data: { type: 'string', default: '/data' },
    seed: { type: 'string' },
    lake: { type: 'string', default: process.env.LAKE_NODE_URL },
    'public-node': { type: 'string', default: process.env.LAKE_PUBLIC_NODE_URL },
    'spar-every': { type: 'string', default: '1800' },
    'passes-url': { type: 'string' },
    // The use cases whose demo issuers to run (and whose converters the auditor certifies).
    packs: { type: 'string', default: process.env.LAKE_PACKS ?? 'health' },
    // Who settles trades (SPEC §6.5): the arbiters whose rulings the payments agent follows, and the payments agents whose
    // receipts the arbiter counts as paid. Domains, comma-separated.
    'trust-arbiters': { type: 'string', default: process.env.LAKE_TRUST_ARBITERS ?? 'arbiter.lake.local' },
    'trust-payments': { type: 'string', default: process.env.LAKE_TRUST_PAYMENTS ?? 'payments.lake.local' },
    production: { type: 'boolean', default: false },
  },
});

// `lake-specialist all` (or a list: `guide,inspector`) runs several in one process, each under its own
// path (/issuer, /guide, …): what a small server can afford.
// Each pack brings its own demo authority: the hospital for health (/issuer), the bank for mortgages (/bank)…
for (const p of await loadPacks(values.packs!.split(','), (n) => import(n))) {
  if (p.source) DEFAULTS[p.source.issuer.path] = { port: '4300', domain: p.source.issuer.domain, pack: p };
  if (p.authority) DEFAULTS[p.authority.path] = { port: '4800', domain: p.authority.domain, pack: p, authority: true };
}
const kind = positionals[0] ?? 'issuer';
const kinds = kind === 'all' ? Object.keys(DEFAULTS) : kind.split(',');
const unknown = kinds.filter((k) => !DEFAULTS[k]);
if (unknown.length) {
  console.error(`lake-specialist: unknown agent "${unknown.join(', ')}". Available: ${Object.keys(DEFAULTS).join(', ')}, a comma-separated list, or all.`);
  process.exit(2);
}
const several = kinds.length > 1;
const port = Number(values.port ?? (several ? '4300' : DEFAULTS[kind]!.port));
const base = (values.url ?? `http://localhost:${port}`).replace(/\/$/, '');
const nodes = (values.lake ?? '').split(',').map((u) => u.trim()).filter(Boolean);
const log = (msg: string) => console.log(JSON.stringify({ at: new Date().toISOString(), msg }));
const domains = (v: string) => v.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

// The log, when it runs in this process: payments and the arbiter put what they sign on its record.
let logger: Logger | undefined;
const toLog = (entry: string, kind: string) => (logger ? logger.add(entry, kind) : Promise.reject(new Error('no log here')));

async function start(k: string, url: string) {
  const id = await loadOrCreateIdentity(`${values.data}/${k}-key.json`);
  const domain = (several ? undefined : values.domain) ?? DEFAULTS[k]!.domain;
  let link: LakeLinks | null = null;
  const o = { id, url, domain, sandbox: !values.production, report: (e: import('@thelakeprotocol/core').LakeEvent) => link?.report(e) };
  const s: { app: express.Express; card: AgentCard; webId: string } =
    DEFAULTS[k]!.authority ? await createAuthority({ ...o, pack: DEFAULTS[k]!.pack! })
    : DEFAULTS[k]!.pack ? await createIssuer({ ...o, pack: DEFAULTS[k]!.pack!, asOf: values.seed ? Date.UTC(2026, 9, 1) : undefined })
    : k === 'ethics' ? await createEthics(o)
    : k === 'payments' ? await createPayments({ ...o, log: toLog, dataDir: values.data!, arbiters: domains(values['trust-arbiters']!), onSettled: (amount, count) => link?.report(makeEvent('payment.settled', 'self', undefined, { amount, count })) })
    : k === 'guide' ? await createGuide({ ...o, nodeUrl: nodes[0], publicNodeUrl: values['public-node'] })
    : k === 'inspector' ? await createInspector({ ...o, nodeUrl: nodes[0] })
    : k === 'sparring' ? await createSparring({ ...o, nodeUrl: nodes[0], everyMs: Number(values['spar-every']) * 1000 })
    : k === 'quests' ? await createQuests({ ...o, nodeUrl: nodes[0] ?? 'http://localhost:7000', dataDir: values.data! })
    : k === 'tally' ? await createTally({ ...o, dataDir: values.data!, passesUrl: values['passes-url'] ?? (several && kinds.includes('passes') ? `${base}/passes/a2a` : undefined) })
    : k === 'passes' ? await createPasses({ ...o, dataDir: values.data! })
    : k === 'person' ? await createPersonhood({ ...o, dataDir: values.data! })
    : k === 'rooms' ? await createRooms({ ...o, dataDir: values.data! })
    : k === 'arbiter' ? await createArbiter({ ...o, log: toLog, payments: domains(values['trust-payments']!) })
    : k === 'log' ? (logger = await createLog({ ...o, dataDir: values.data! }))
    : k.startsWith('teller-') ? await createTeller({ ...o, dataDir: values.data!, name: `Teller ${k.slice(7).toUpperCase()}` })
    : await createAuditor(o);
  const join = async () => {
    log(`${k} ${s.webId} at ${url}`);
    if (!nodes.length) return;
    link = new LakeLinks({ nodeUrls: nodes, card: s.card, identity: id, webId: s.webId, log });
    (await link.register()).forEach((nodeId, i) => { if (nodeId) log(`${k} registered with the Lake node at ${nodes[i]} as ${nodeId}`); });
    link.keepAlive(5_000);
  };
  return { app: s.app, join };
}

if (several) {
  const root = express();
  const started: Awaited<ReturnType<typeof start>>[] = [];
  for (const k of kinds) {
    const s = await start(k, `${base}/${k}`);
    root.use(`/${k}`, s.app);
    started.push(s);
  }
  root.get('/health', (_req, res) => void res.json({ ok: true, agents: kinds }));
  keepAliveBehindProxy(root.listen(port, async () => {
    log(`${kinds.length} specialists listening on :${port}`);
    for (const s of started) await s.join();
  }));
} else {
  const s = await start(kind, base);
  keepAliveBehindProxy(s.app.listen(port, () => void s.join()));
}
