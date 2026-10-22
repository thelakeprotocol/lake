#!/usr/bin/env node
/**
 * The pod's MCP door over stdio, for any MCP-capable assistant (Claude Desktop, Claude Code, others).
 * Logs in as the owner with the house's own secrets, and never exposes /wallet/.
 *
 *   docker exec -i -e LAKE_OWNER=stan <house-container> node dist/pod-mcp-stdio.js
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { packPaths } from '@thelakeprotocol/core';
import { loadPacks } from './packs.js';
import { createPodMcpServer } from './pod-mcp.js';
import { ownerSession } from './pod.js';
import { packFolders } from './typeindex.js';

const owner = process.env.LAKE_OWNER;
if (!owner) {
  console.error('set LAKE_OWNER to the house name, e.g. LAKE_OWNER=stan');
  process.exit(2);
}
// Same layout as the house itself: <data>/<owner>/.
const dataDir = join(process.env.LAKE_DATA ?? '/data', owner);
if (!existsSync(join(dataDir, 'house-secrets.json'))) {
  console.error(`no house found in ${dataDir}; start the house first, or point LAKE_DATA at its data folder`);
  process.exit(2);
}
const s = await ownerSession({
  dataDir,
  port: 0,
  baseUrl: (process.env.LAKE_POD_URL ?? 'http://localhost:3000/').replace(/\/?$/, '/'),
  owner,
});
const packs = await loadPacks((process.env.LAKE_PACKS ?? 'health').split(','), (n) => import(n));
const folders = await packFolders(s, packs);
const claimsDocs = packs.map((p) => packPaths(p, folders.get(p.id)).claims);
await createPodMcpServer({ podRoot: s.podRoot, fetch: s.fetch, deny: ['wallet/'], claimsDocs }).connect(new StdioServerTransport());
