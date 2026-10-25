#!/usr/bin/env node
// `lake mcp` runs the Lake MCP connector over stdio; every other `lake` command is the visitor CLI.
if (process.argv[2] === 'mcp' && process.argv.includes('--http')) {
  // `lake mcp --http 4800 --public-url https://sandbox.example`: the connector over HTTP, one agent per conversation.
  const { parseArgs } = await import('node:util');
  const { values: a } = parseArgs({ args: process.argv.slice(3), options: { http: { type: 'string', default: '4800' }, 'public-url': { type: 'string' } } });
  const { lakeMcpHttpApp } = await import('./http.js');
  const env = process.env;
  const port = Number(a.http);
  const app = lakeMcpHttpApp({
    node: env.LAKE_NODE_URL ?? 'http://lake-node:7000', publicUrl: a['public-url'] ?? `http://localhost:${port}`, packs: env.LAKE_PACKS?.split(',').map((x) => x.trim()).filter(Boolean),
    ethics: env.LAKE_ETHICS_URL, auditor: env.LAKE_AUDITOR_URL, payments: env.LAKE_PAYMENTS_URL,
    allowanceUsd: Number(env.LAKE_ALLOWANCE_USD ?? 0), publicNode: env.LAKE_PUBLIC_NODE_URL,
    log: (m) => console.log(m),
  });
  const { keepAliveBehindProxy } = await import('@thelakeprotocol/core');
  keepAliveBehindProxy(app.listen(port, () => console.log(`Lake MCP over HTTP on :${port}/mcp`)));
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
    ethics: env.LAKE_ETHICS_URL, auditor: env.LAKE_AUDITOR_URL, payments: env.LAKE_PAYMENTS_URL,
    allowanceUsd: Number(env.LAKE_ALLOWANCE_USD ?? 0), publicNode: env.LAKE_PUBLIC_NODE_URL,
  });
  await server.connect(new StdioServerTransport());
} else {
  await import('@thelakeprotocol/visitor/dist/cli.js');
}
