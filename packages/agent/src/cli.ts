#!/usr/bin/env node
// `lake mcp` runs the Lake MCP connector over stdio; every other `lake` command is the visitor CLI.
// Trade terms (SPEC §6.5): payments agents a seller also accepts besides its own (LAKE_ACCEPT_PAYMENTS), and the arbiters it
// names in its carts and accepts in others' (LAKE_ARBITERS, its own first). A2A addresses, comma-separated, without /a2a.
const list = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const trade = (env: NodeJS.ProcessEnv) => ({ acceptPayments: list(env.LAKE_ACCEPT_PAYMENTS), arbiters: list(env.LAKE_ARBITERS) });
if (process.argv[2] === 'mcp' && process.argv.includes('--http')) {
  // `lake mcp --http 4800 --public-url https://sandbox.example`: the connector over HTTP, one agent per conversation.
  const { parseArgs } = await import('node:util');
  const { values: a } = parseArgs({ args: process.argv.slice(3), options: { http: { type: 'string', default: '4800' }, 'public-url': { type: 'string' } } });
  const { lakeMcpHttpApp } = await import('./http.js');
  const env = process.env;
  const port = Number(a.http);
  const app = lakeMcpHttpApp({
    node: env.LAKE_NODE_URL ?? 'http://lake-node:7000', publicUrl: a['public-url'] ?? `http://localhost:${port}`, packs: env.LAKE_PACKS?.split(',').map((x) => x.trim()).filter(Boolean),
    ethics: env.LAKE_ETHICS_URL, auditor: env.LAKE_AUDITOR_URL, payments: env.LAKE_PAYMENTS_URL, ...trade(env),
    allowanceUsd: Number(env.LAKE_ALLOWANCE_USD ?? 0), publicNode: env.LAKE_PUBLIC_NODE_URL,
    // A data folder turns sign-in on: an AI keeps one agent from chat to chat (and across restarts).
    data: env.LAKE_MCP_DATA, kek: env.LAKE_MCP_KEK,
    // Play money in more than one currency ("USD:50,AUD:80"), for a sandbox whose shops price in more than dollars.
    ...(env.LAKE_PLAY_MONEY ? { playMoney: Object.fromEntries(env.LAKE_PLAY_MONEY.split(',').map((x) => x.split(':')).filter(([c, n]) => /^[A-Z]{3}$/.test(c ?? '') && Number(n) > 0).map(([c, n]) => [c!, Number(n)])) } : {}),
    log: (m) => console.log(m),
  });
  const { keepAliveBehindProxy } = await import('@thelakeprotocol/core');
  keepAliveBehindProxy(app.listen(port, () => console.log(`Lake MCP over HTTP on :${port}/mcp`)));
} else if (process.argv[2] === 'duty') {
  // `lake duty --lake <connector>/mcp --house <house> --code <code>`: the owner's own AI on duty while they're away.
  const { parseArgs } = await import('node:util');
  const { values: a } = parseArgs({ args: process.argv.slice(3), options: {
    lake: { type: 'string', default: 'https://sandbox.lake.doneinfifty.com/mcp' }, house: { type: 'string' }, code: { type: 'string' },
    agent: { type: 'string', default: 'claude -p' }, every: { type: 'string', default: '600' }, 'max-runs': { type: 'string', default: '30' },
    'max-tools': { type: 'string', default: '40' }, state: { type: 'string' }, menu: { type: 'string' },
  } });
  if (!a.house) { console.error('usage: lake duty --house <your house> --code <the code from your panel> [--lake <connector>/mcp] [--agent "claude -p"] [--every 600] [--max-runs 30] [--max-tools 40] [--menu menu.json]'); process.exit(2); }
  const { runDuty } = await import('./duty.js');
  const { readFileSync } = await import('node:fs');
  // The menu its agent sells from while on duty (with "deliver" in the grant), set at first sign-in: a JSON list of items,
  // or { items, about, tags } to say on its card what it sells.
  const file = a.menu ? JSON.parse(readFileSync(a.menu, 'utf8')) as unknown[] | { items: unknown[]; about?: string; tags?: string[] } : undefined;
  const menu = Array.isArray(file) ? { menu: file } : file ? { menu: file.items, ...(file.about ? { about: file.about } : {}), ...(file.tags ? { tags: file.tags } : {}) } : {};
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  await runDuty({ lake: a.lake!, house: a.house, code: a.code, agent: a.agent, every: Number(process.env.LAKE_DUTY_EVERY_MS) || Number(a.every) * 1000, maxRuns: Number(a['max-runs']), maxTools: Number(a['max-tools']), state: a.state, ...menu, signal: stop.signal })
    .catch((e: Error) => { console.error(`lake duty: ${e.message}`); process.exit(1); });
} else if (process.argv[2] === 'mcp') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { createLakeMcpServer } = await import('./mcp.js');
  const env = process.env;
  const server = createLakeMcpServer({
    name: env.LAKE_AGENT_NAME ?? 'Assistant (via MCP)',
    domain: env.LAKE_AS ?? 'assistant.example',
    node: env.LAKE_NODE_URL ?? 'http://lake-node:7000', packs: env.LAKE_PACKS?.split(',').map((x) => x.trim()).filter(Boolean),
    port: Number(env.LAKE_MCP_PORT ?? 4890),
    keyFile: env.LAKE_KEY_FILE,
    ethics: env.LAKE_ETHICS_URL, auditor: env.LAKE_AUDITOR_URL, payments: env.LAKE_PAYMENTS_URL, ...trade(env),
    allowanceUsd: Number(env.LAKE_ALLOWANCE_USD ?? 0), publicNode: env.LAKE_PUBLIC_NODE_URL,
  });
  await server.connect(new StdioServerTransport());
} else {
  await import('@thelakeprotocol/visitor/dist/cli.js');
}
