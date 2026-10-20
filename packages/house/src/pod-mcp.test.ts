import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createPodMcpServer } from './pod-mcp.js';

const root = 'http://pod.test/stan/';
const files: Record<string, string> = {
  [`${root}health/claims.ttl`]: `@prefix lake: <https://lake.doneinfifty.com/model/v0#>.
<#age> a lake:AgeBand; lake:value "60-69".
<#med-0> a lake:Medication; lake:value "Drug X"; lake:code "drug-x".`,
  [`${root}wallet/identity.json`]: '{"secret":true}',
};
const fakeFetch = (async (url: string) => new Response(files[url] ?? 'nope', { status: files[url] ? 200 : 404 })) as unknown as typeof fetch;

async function connect(deny?: string[]) {
  const seen: string[] = [];
  const server = createPodMcpServer({ podRoot: root, fetch: fakeFetch, deny, onAccess: (_t, p) => seen.push(p) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, text: (r.content as { text: string }[])[0]!.text };
  };
  return { call, seen };
}

describe('pod MCP door', () => {
  it('returns canonical claims, filtered by field', async () => {
    const { call } = await connect();
    expect(JSON.parse((await call('pod_claims', { fields: ['medications'] })).text)).toEqual([{ field: 'medications', value: 'Drug X', code: 'drug-x' }]);
  });

  it('never leaves the pod', async () => {
    const { call } = await connect();
    expect(await call('pod_read', { path: '../other/secret' })).toMatchObject({ error: true });
    expect(await call('pod_read', { path: 'http://evil.test/x' })).toMatchObject({ error: true });
  });

  it('keeps the wallet shut for outside assistants, and logs every access', async () => {
    const { call, seen } = await connect(['wallet/']);
    expect(await call('pod_read', { path: 'wallet/identity.json' })).toMatchObject({ error: true });
    await call('pod_read', { path: 'health/claims.ttl' });
    expect(seen).toEqual(['health/claims.ttl']);
  });
});
