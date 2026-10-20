#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { LakeLink, loadOrCreateIdentity } from '@thelakeprotocol/core';
import { createIssuer } from './issuer.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '4300' },
    url: { type: 'string' },
    domain: { type: 'string', default: 'issuer.lake.local' },
    data: { type: 'string', default: '/data' },
    seed: { type: 'string' },
    lake: { type: 'string', default: process.env.LAKE_NODE_URL },
  },
});

const kind = positionals[0] ?? 'issuer';
if (kind !== 'issuer') {
  console.error(`lake-specialist: "${kind}" is not built yet (ethics, auditor and payments land in milestones 3 and 5)`);
  process.exit(2);
}
const port = Number(values.port);
const id = await loadOrCreateIdentity(`${values.data}/issuer-key.json`);
const asOf = values.seed ? Date.UTC(2026, 9, 1) : undefined;
const { app, webId, card } = await createIssuer({ id, url: values.url ?? `http://localhost:${port}`, domain: values.domain!, asOf });
app.listen(port, async () => {
  const log = (msg: string) => console.log(JSON.stringify({ at: new Date().toISOString(), msg }));
  log(`issuer ${webId} listening on :${port}`);
  if (values.lake) {
    const nodeId = await new LakeLink({ nodeUrl: values.lake.replace(/\/$/, ''), card, identity: id, webId, log }).register();
    if (nodeId) log(`registered with the Lake node at ${values.lake} as ${nodeId}`);
  }
});
