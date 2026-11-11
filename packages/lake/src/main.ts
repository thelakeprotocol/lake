#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { keepAliveBehindProxy, loadOrCreateIdentity, parseCli } from '@thelakeprotocol/core';
import { createNode, replayNode } from './node.js';

const { values: a } = parseCli({
  name: 'lake-node',
  about: 'A Lake node: a registry, a relay and an event stream. It holds no personal data and decides nothing (https://lake.doneinfifty.com/docs/run-a-node).',
  usage: 'lake-node [--port 7000] [--url <public url>] [--data <dir>] [--follow <other nodes>] …',
  example: 'lake-node --port 7000 --url http://localhost:7000 --data ./node',
  notes: { port: 'its HTTP port (map at /, cards, wants, events)', url: 'the address houses and agents reach it at', data: 'where it keeps cards and the feed', follow: 'other Lakes\' nodes to follow, comma-separated' },
  options: {
    port: { type: 'string', default: process.env.LAKE_PORT ?? '7000' },
    url: { type: 'string', default: process.env.LAKE_NODE_PUBLIC_URL },
    domain: { type: 'string', default: process.env.LAKE_DOMAIN ?? 'lake.local' },
    data: { type: 'string', default: process.env.LAKE_DATA ?? '/data' },
    ui: { type: 'string', default: process.env.LAKE_UI_DIR },
    production: { type: 'boolean', default: false },
    'approvals-url': { type: 'string', default: process.env.LAKE_APPROVALS_URL },
    'quarantine-after': { type: 'string', default: '3' },
    'feed-batch-ms': { type: 'string', default: '7000' },
    'guild-min': { type: 'string', default: '3' },
    'intent-min': { type: 'string', default: '2' },
    'show-intent-houses': { type: 'boolean', default: false },
    follow: { type: 'string', default: process.env.LAKE_FOLLOW },
    'sync-ms': { type: 'string', default: '5000' },
    // The Ocean: follow back Lakes that say hello, and the Lakes they know (SPEC §9.2).
    ocean: { type: 'boolean', default: process.env.LAKE_OCEAN === '1' },
    // The most cards this node takes from any one Lake it follows.
    'peer-max': { type: 'string', default: process.env.LAKE_PEER_MAX ?? '5000' },
    record: { type: 'string', default: process.env.LAKE_RECORD },
    // A transparency log's A2A endpoint: published blueprints go on its record (SPEC §11.8). Off unless set.
    'log-url': { type: 'string', default: process.env.LAKE_LOG_URL },
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
// The project's own blueprints, copied next to the build (spec/blueprints), so a fresh node has a few to show.
function seeds(): string[] {
  const dir = new URL('./blueprints/', import.meta.url).pathname;
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort().map((f) => readFileSync(join(dir, f), 'utf8')) : [];
}
const { server } = await createNode({ id, url: a.url ?? `http://localhost:${port}`, domain: a.domain!, sandbox: !a.production, uiDir, approvalsUrl: a['approvals-url'], quarantineAfter: Number(a['quarantine-after']), feedBatchMs: Number(a['feed-batch-ms']), guildMin: Number(a['guild-min']), intentMin: Number(a['intent-min']), showIntentHouses: a['show-intent-houses'], resetToken: process.env.LAKE_RESET_TOKEN, record: a.record, blueprintsFile: `${a.data}/blueprints.json`, hostStatusFile: `${a.data}/host-status.json`, seedBlueprints: seeds(), follow: a.follow?.split(',').map((u) => u.trim()).filter(Boolean), ocean: a.ocean, peerMax: Number(a['peer-max']), syncMs: Number(a['sync-ms']) , logUrl: a['log-url'] || undefined });
keepAliveBehindProxy(server).listen(port, () => console.log(`[node:${a.domain}] Lake node on :${port} · map at http://localhost:${port}/ · ${a.production ? 'production' : 'sandbox'}${a.record ? ` · recording to ${a.record}` : ''}${a['log-url'] ? ` · blueprints logged at ${a['log-url']}` : ''}`));
}
