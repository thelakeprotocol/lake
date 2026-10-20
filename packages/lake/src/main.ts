#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { loadOrCreateIdentity } from '@thelakeprotocol/core';
import { createNode, replayNode } from './node.js';

const { values: a } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.LAKE_PORT ?? '7000' },
    url: { type: 'string', default: process.env.LAKE_NODE_PUBLIC_URL },
    domain: { type: 'string', default: process.env.LAKE_DOMAIN ?? 'lake.local' },
    data: { type: 'string', default: process.env.LAKE_DATA ?? '/data' },
    ui: { type: 'string', default: process.env.LAKE_UI_DIR },
    production: { type: 'boolean', default: false },
    'approvals-url': { type: 'string', default: process.env.LAKE_APPROVALS_URL },
    'quarantine-after': { type: 'string', default: '3' },
    'guild-min': { type: 'string', default: '3' },
    follow: { type: 'string', default: process.env.LAKE_FOLLOW },
    'sync-ms': { type: 'string', default: '5000' },
    record: { type: 'string', default: process.env.LAKE_RECORD },
    replay: { type: 'string' },
    speed: { type: 'string', default: '1' },
    loop: { type: 'boolean', default: false },
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
if (a.replay) {
  const server = await replayNode({ file: a.replay, uiDir, speed: Number(a.speed), loop: a.loop, domain: a.domain! });
  server.listen(port, () => console.log(`[node:${a.domain}] replaying ${a.replay} at ${a.speed}x · map at http://localhost:${port}/`));
} else {
const id = await loadOrCreateIdentity(`${a.data}/node-key.json`);
const { server } = await createNode({ id, url: a.url ?? `http://localhost:${port}`, domain: a.domain!, sandbox: !a.production, uiDir, approvalsUrl: a['approvals-url'], quarantineAfter: Number(a['quarantine-after']), guildMin: Number(a['guild-min']), resetToken: process.env.LAKE_RESET_TOKEN, record: a.record, follow: a.follow?.split(',').map((u) => u.trim()).filter(Boolean), syncMs: Number(a['sync-ms']) });
server.listen(port, () => console.log(`[node:${a.domain}] Lake node on :${port} · map at http://localhost:${port}/ · ${a.production ? 'production' : 'sandbox'}${a.record ? ` · recording to ${a.record}` : ''}`));
}
