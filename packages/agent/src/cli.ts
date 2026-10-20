#!/usr/bin/env node
// `lake mcp` runs the Lake MCP connector over stdio; every other `lake` command is the visitor CLI.
if (process.argv[2] === 'mcp') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { createLakeMcpServer } = await import('./mcp.js');
  const env = process.env;
  const server = createLakeMcpServer({
    name: env.LAKE_AGENT_NAME ?? 'Assistant (via MCP)',
    domain: env.LAKE_AS ?? 'assistant.example',
    node: env.LAKE_NODE_URL ?? 'http://lake-node:7000',
    port: Number(env.LAKE_MCP_PORT ?? 4890),
    keyFile: env.LAKE_KEY_FILE,
    ethics: env.LAKE_ETHICS_URL, auditor: env.LAKE_AUDITOR_URL, payments: env.LAKE_PAYMENTS_URL,
  });
  await server.connect(new StdioServerTransport());
} else {
  await import('@thelakeprotocol/visitor/dist/cli.js');
}
