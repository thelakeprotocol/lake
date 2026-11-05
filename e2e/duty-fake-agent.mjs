// A stand-in for the owner's agent CLI in e2e/duty.e2e.test.ts: what `lake duty --agent "node duty-fake-agent.mjs"` runs.
// It gets the prompt on stdin and the Lake MCP config in LAKE_MCP_CONFIG, as any agent CLI wired to the runner would.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const lake = JSON.parse(readFileSync(process.env.LAKE_MCP_CONFIG, 'utf8')).mcpServers.lake;
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const c = new Client({ name: 'fake-duty-agent', version: '0' });
await c.connect(new StreamableHTTPClientTransport(new URL(lake.url), { requestInit: { headers: lake.headers } }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { text, isError: r.isError }; }
};
const inbox = await call('lake_inbox', { wait_seconds: 0 });
const said = (inbox.messages ?? []).filter((m) => typeof m.message?.text === 'string');
// Someone new: their human hears of it first, as the prompt says.
for (const m of said) await call('lake_house_suggest', { text: `While you were away, ${m.from.name} wrote: "${m.message.text}". Shall I answer?`, ask: { choices: ['Yes, answer', 'Leave it'] } });
// And it tries what it may not do: the connector refuses it.
const paid = await call('lake_pay', { to: said[0]?.from?.url ?? 'https://nobody.example/a2a', amount: 1, currency: 'USD' });
console.log(`grant in the prompt: ${/AI on duty/.test(prompt)}; pay: ${paid.isError ? 'refused' : 'NOT refused'}`);
console.log(`Left my human ${said.length} note(s).`);
await c.close();
