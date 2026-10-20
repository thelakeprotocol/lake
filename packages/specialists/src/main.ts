#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadOrCreateIdentity } from '@thelakeprotocol/core';
import { createIssuer } from './issuer.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '4300' },
    url: { type: 'string' },
    domain: { type: 'string', default: 'issuer.lake.local' },
    data: { type: 'string', default: '/data' },
    seed: { type: 'string' },
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
const { app, webId } = await createIssuer({ id, url: values.url ?? `http://localhost:${port}`, domain: values.domain!, asOf });
app.listen(port, () => console.log(JSON.stringify({ at: new Date().toISOString(), msg: `issuer ${webId} listening on :${port}` })));
