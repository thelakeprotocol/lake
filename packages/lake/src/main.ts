#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { loadOrCreateIdentity } from '@thelakeprotocol/core';
import { createNode } from './node.js';

const { values: a } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.LAKE_PORT ?? '7000' },
    url: { type: 'string', default: process.env.LAKE_NODE_PUBLIC_URL },
    domain: { type: 'string', default: process.env.LAKE_DOMAIN ?? 'lake.local' },
    data: { type: 'string', default: process.env.LAKE_DATA ?? '/data' },
    ui: { type: 'string', default: process.env.LAKE_UI_DIR },
    production: { type: 'boolean', default: false },
  },
});

const port = Number(a.port);
let uiDir = a.ui;
if (!uiDir) {
  try {
    uiDir = join(dirname(createRequire(import.meta.url).resolve('@thelakeprotocol/ui/package.json')), 'dist');
  } catch {
    // no map built; the API still works
  }
}
const id = await loadOrCreateIdentity(`${a.data}/node-key.json`);
const { server } = await createNode({ id, url: a.url ?? `http://localhost:${port}`, domain: a.domain!, sandbox: !a.production, uiDir });
server.listen(port, () => console.log(`[node:${a.domain}] Lake node on :${port} · map at http://localhost:${port}/ · ${a.production ? 'production' : 'sandbox'}`));
