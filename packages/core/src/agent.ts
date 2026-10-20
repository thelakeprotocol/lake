import express from 'express';
import { ClientFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { AgentCard } from '@a2a-js/sdk';
import { lakeMessage, readLakeData, type LakeData } from './a2a.js';
import { LAKE_EXTENSION_URI } from './lake.js';

/**
 * Serves a Lake agent over A2A: the signed card at the well-known path, JSON-RPC at /a2a.
 * `handle` gets the raw Lake data (verify it yourself) and returns a signed reply.
 */
export function lakeAgentApp(card: AgentCard, handle: (data: LakeData | null) => Promise<LakeData>): express.Express {
  const executor: AgentExecutor = {
    async execute(ctx, bus) {
      const reply = await handle(readLakeData(ctx.userMessage));
      bus.publish({ kind: 'message', data: lakeMessage(reply, 'agent', ctx.contextId) });
      bus.finished();
    },
    async cancelTask() {},
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const app = express();
  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: async () => card }));
  app.use('/a2a', express.json({ limit: '512kb' }), jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return app;
}

/**
 * Where an agent's card lives, given its A2A endpoint: next to it. `https://h/a2a` → `https://h/.well-known/agent-card.json`;
 * a hosted house at `https://h/t/stan/a2a` → `https://h/t/stan/.well-known/agent-card.json`.
 */
export function cardUrlFor(interfaceUrl: string): string {
  return `${interfaceUrl.replace(/\/$/, '').replace(/\/a2a$/, '')}/.well-known/agent-card.json`;
}

const clients = new Map<string, Promise<Awaited<ReturnType<ClientFactory['createFromUrl']>>>>();
const serviceParameters = ServiceParameters.create(withA2AExtensions(LAKE_EXTENSION_URI));

/** Sends Lake data to an agent over A2A (declaring the Lake extension) and returns the raw reply data. */
export async function sendLake(agentUrl: string, data: LakeData, opts: { timeoutMs?: number } = {}): Promise<LakeData | null> {
  const base = agentUrl.replace(/\/$/, '');
  let client = clients.get(base);
  if (!client) {
    client = fetch(cardUrlFor(base), { headers: { 'A2A-Version': '1.0' } })
      .then((r) => r.json() as Promise<AgentCard>)
      .then((card) => new ClientFactory().createFromAgentCard(card));
    clients.set(base, client);
    client.catch(() => clients.delete(base));
  }
  const res = await (await client).sendMessage(
    { tenant: '', message: lakeMessage(data, 'user'), configuration: undefined, metadata: undefined },
    { serviceParameters, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) },
  );
  return readLakeData('role' in res ? res : undefined);
}
