import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { lakeMcpAgent, TOOL_SETS, toolSet } from './mcp.js';
import { DUTY_TOOLS } from './duty.js';

const agent = lakeMcpAgent({ name: 'Test assistant', domain: 'assistant.example', node: 'http://127.0.0.1:9' });
async function connect(tools?: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await agent.session({ tools }).connect(a);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(b);
  return c;
}
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

describe('tool sets (SPEC §6.1)', () => {
  it('lists the everyday tools by default, a group on asking, all with "all"', async () => {
    expect(toolSet('')!.size).toBe(9);
    expect(toolSet('all')).toBeNull();
    expect([...toolSet('trade, nonsense')!]).toEqual([...TOOL_SETS.core!, ...TOOL_SETS.trade!]);
    // Every group's tools exist, and the groups with the everyday ones cover all 28 without overlap.
    const all = await names(await connect('all'));
    expect(all).toHaveLength(28);
    const grouped = ['core', 'trade', 'together', 'research'].flatMap((g) => TOOL_SETS[g]!);
    expect([...grouped].sort()).toEqual(all);
    expect(DUTY_TOOLS.every((t) => all.includes(t))).toBe(true);
  });

  it('narrows the list only: a tool left off still answers when called', async () => {
    const c = await connect();
    expect(await names(c)).toEqual([...TOOL_SETS.core!].sort());
    expect(c.getInstructions()).toMatch(/everyday tools/);
    // Bad input, so it answers without the network: a validation error, not "no such tool".
    const r = await c.callTool({ name: 'lake_commit', arguments: { action: 42 } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).not.toMatch(/not found/i);
    expect(await names(await connect('duty'))).toEqual([...new Set([...TOOL_SETS.core!, ...DUTY_TOOLS])].sort());
  });
});
