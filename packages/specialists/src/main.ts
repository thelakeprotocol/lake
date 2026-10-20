#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { LakeLink, loadOrCreateIdentity, type AgentCard } from '@thelakeprotocol/core';
import type express from 'express';
import { createIssuer } from './issuer.js';
import { createAuditor, createEthics } from './review.js';

const DEFAULTS: Record<string, { port: string; domain: string }> = {
  issuer: { port: '4300', domain: 'issuer.lake.local' },
  auditor: { port: '4400', domain: 'audit.lake.local' },
  ethics: { port: '4500', domain: 'ethics.lake.local' },
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
    production: { type: 'boolean', default: false },
  },
});

const kind = positionals[0] ?? 'issuer';
const d = DEFAULTS[kind];
if (!d) {
  console.error(`lake-specialist: "${kind}" is not built yet. Available: ${Object.keys(DEFAULTS).join(', ')}. Payments lands in milestone 5.`);
  process.exit(2);
}
const port = Number(values.port ?? d.port);
const domain = values.domain ?? d.domain;
const url = values.url ?? `http://localhost:${port}`;
const id = await loadOrCreateIdentity(`${values.data}/${kind}-key.json`);
const o = { id, url, domain, sandbox: !values.production };

let s: { app: express.Express; card: AgentCard; webId: string };
if (kind === 'issuer') s = await createIssuer({ ...o, asOf: values.seed ? Date.UTC(2026, 9, 1) : undefined });
else if (kind === 'ethics') s = await createEthics(o);
else s = await createAuditor(o);

s.app.listen(port, async () => {
  const log = (msg: string) => console.log(JSON.stringify({ at: new Date().toISOString(), msg }));
  log(`${kind} ${s.webId} listening on :${port}`);
  if (values.lake) {
    const nodeId = await new LakeLink({ nodeUrl: values.lake.replace(/\/$/, ''), card: s.card, identity: id, webId: s.webId, log }).register();
    if (nodeId) log(`registered with the Lake node at ${values.lake} as ${nodeId}`);
  }
});
