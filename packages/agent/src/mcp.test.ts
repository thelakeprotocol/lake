import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { asAddress, blueprintList, foldFyi, inboxBatch, lakeMcpAgent, listedOnly, TOOL_SETS, toolSet } from './mcp.js';
import { DUTY_TOOLS, TASK_TOOLS, taskPrompt, taskUrl } from './duty.js';

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

  it('names only the tools a conversation lists, in what it is told first and in what it can do', async () => {
    for (const tools of ['', 'trade', 'together', 'research', 'duty', 'trade,together']) {
      const c = await connect(tools), listed = await names(c);
      const named = [...new Set(c.getInstructions()!.match(/lake_[a-z_]+/g))];
      expect(named.filter((t) => !listed.includes(t)), `tools=${tools}`).toEqual([]);
    }
    expect((await connect('trade')).getInstructions()).toMatch(/everyday tools, and the ones for these: buy, sell/);
    // With every group the full text goes out, as with "all".
    expect((await connect('trade,together,research')).getInstructions()).toBe((await connect('all')).getInstructions());
    const what = { trade: ['lake_sell { item }', 'lake_buy'], rooms: 'lake_room { action: "open" }', house: 'lake_house_connect, then lake_house', plain: 'no tool named' };
    expect(Object.keys(listedOnly(what, toolSet('trade')!))).toEqual(['trade', 'house', 'plain']);
    expect(Object.keys(listedOnly(what, toolSet('')!))).toEqual(['house', 'plain']);
  });
});

describe('a run for one task (SPEC §6.1)', () => {
  it('lists three tools, and nothing else answers there', async () => {
    expect(new URL(taskUrl('https://lake.example/mcp?x=1')).searchParams.get('tools')).toBe('task');
    const c = await connect('task');
    expect(await names(c)).toEqual([...TASK_TOOLS].sort());
    // What it is told first, and its prompt, name only those three.
    for (const text of [c.getInstructions()!, taskPrompt('https://house.example')]) expect([...new Set(text.match(/lake_[a-z_]+/g))].sort()).toEqual([...TASK_TOOLS].sort());
    // Unlike a list, this is a wall: a tool by name is refused before it runs, whatever its input.
    for (const [name, args] of [['lake_inbox', {}], ['lake_pay', { agent_url: 'https://x.example/a2a', amount: 5, memo: 'deposit' }], ['lake_ask', { agent_url: 'https://x.example/a2a', message: { kind: 'note', text: 'hi' } }], ['lake_overview', {}], ['lake_house_connect', { code: 'x' }]] as const) {
      const r = await c.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(JSON.stringify(r.content), name).toContain('one task from your human');
    }
    // Of the house, its tasks only; a note for its human only with the task it is about.
    expect(JSON.stringify((await c.callTool({ name: 'lake_house', arguments: { view: 'requests' } })).content)).toContain('your tasks only');
    expect(JSON.stringify((await c.callTool({ name: 'lake_house', arguments: { view: 'money' } })).content)).toContain('your tasks only');
    expect(JSON.stringify((await c.callTool({ name: 'lake_house_suggest', arguments: { text: 'Shall I pay them?' } })).content)).toContain('goes with the task');
    // No house connected here: an answer finds no task and is refused by the wall, not sent.
    expect(JSON.stringify((await c.callTool({ name: 'lake_house_reply', arguments: { note: 'n1', text: 'hello' } })).content)).toContain('only in the conversation');
  });
});

describe('what a newcomer reads first (round 20)', () => {
  const house = { name: 'A house', domain: 'house.example', your_house: true };
  const news = (i: number, about: string) => ({ id: `n${i}`, at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), from: house, message: { kind: 'house.news', about, fyi: true, text: `${about} ${i}` } });
  const note = (i: number) => ({ id: `m${i}`, at: new Date(Date.UTC(2026, 10, 2, 0, i)).toISOString(), from: { name: 'Someone', domain: 'someone.example' }, message: { kind: 'note', text: `hello ${i}` } });
  const waiting = { id: 'w1', at: new Date(Date.UTC(2026, 10, 3)).toISOString(), from: house, message: { kind: 'house.news', about: 'request.waiting' } };

  it('an inbox of a hundred: what asks something first, news that asks nothing folded, the rest counted', () => {
    const inbox = [...Array.from({ length: 50 }, (_, i) => [news(i, 'study'), news(i, 'money')]).flat(), note(1), waiting, note(2)];
    const { take, left } = inboxBatch(inbox);
    expect(left).toEqual([]);
    const out = foldFyi(take);
    expect(out.map((m) => m.id)).toEqual(['m1', 'w1', 'm2', 'n49', 'n49']);
    expect(out[3]).toMatchObject({ message: { about: 'study', text: 'study 49' }, folded: { count: 50, since: news(0, 'study').at } });
    expect(out[0]).not.toHaveProperty('folded');
    expect(JSON.stringify(out).length).toBeLessThan(2000);
    // Read again, the same batch folds the same way.
    expect(foldFyi(take)).toEqual(out);
    // One piece of news is itself, not "1 like this".
    expect(foldFyi([news(7, 'block')])[0]).not.toHaveProperty('folded');
  });

  it('more than thirty that ask something come thirty at a time, oldest first', () => {
    const inbox = [news(0, 'study'), ...Array.from({ length: 45 }, (_, i) => note(i)), news(1, 'study')];
    const first = inboxBatch(inbox);
    expect(first.take.filter((m) => m.message.kind === 'note').map((m) => m.id)).toEqual(Array.from({ length: 30 }, (_, i) => `m${i}`));
    expect(first.take).toHaveLength(32);
    expect(first.left.map((m) => m.id)).toEqual(Array.from({ length: 15 }, (_, i) => `m${i + 30}`));
    expect(inboxBatch(first.left)).toEqual({ take: first.left, left: [] });
    // As signed, nothing is folded, so news counts toward the thirty.
    const raw = inboxBatch(inbox, 30, false);
    expect(raw.take).toHaveLength(30);
    expect(raw.left).toHaveLength(17);
    expect(raw.left.at(-1)!.id).toBe('n1');
  });

  it('an address is an address: a bare host gets its scheme, a name is no address', () => {
    expect(asAddress('https://lake.example/s/guide')).toBe('https://lake.example/s/guide');
    expect(asAddress(' lake.example/s/guide ')).toBe('https://lake.example/s/guide');
    expect(asAddress('localhost:7000/t/a')).toBeNull();
    expect(asAddress('http://localhost:7000/t/a')).toBe('http://localhost:7000/t/a');
    for (const name of ['Guide', 'the guide', 'Dana', '', 'https://']) expect(asAddress(name), name).toBeNull();
  });

  it('the list of blueprints is short: newest first, thirty at a time, each with how to read it', () => {
    const all = Array.from({ length: 71 }, (_, i) => ({ name: `bp-${i}`, version: 1, title: `Blueprint ${i}`, summary: `${i % 7 === 0 ? 'A coin flip. ' : ''}${'long words '.repeat(60)}`, tag: 'game', author: 'Someone', at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), logged: {}, url: `https://lake.example/blueprints/bp-${i}` }));
    const list = blueprintList(all);
    expect(list.blueprints).toHaveLength(30);
    expect(list.blueprints[0]).toEqual({ name: 'bp-70', title: 'Blueprint 70', tag: 'game', read: 'lake_blueprints { name: "bp-70" }' });
    expect(list).toMatchObject({ more: 41 });
    expect(JSON.stringify(list).length).toBeLessThan(4000);
    const flips = blueprintList(all, 'Coin Flip');
    expect(flips.blueprints.map((b) => b.name)).toEqual(['bp-70', 'bp-63', 'bp-56', 'bp-49', 'bp-42', 'bp-35', 'bp-28', 'bp-21', 'bp-14', 'bp-7', 'bp-0']);
    expect(flips).not.toHaveProperty('more');
    expect(blueprintList(all, 'zebra')).toMatchObject({ blueprints: [], note: expect.stringMatching(/none mentions "zebra"/) });
  });
});
