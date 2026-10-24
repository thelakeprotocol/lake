import express from 'express';
import { ClientFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { AgentCard } from '@a2a-js/sdk';
import { lakeMessage, readLakePart, type LakeData } from './a2a.js';
import { verifyLakeCard } from './card.js';
import type { Identity } from './crypto.js';
import { isSealed, openLake, sealLake } from './seal.js';
import { LAKE_EXTENSION_URI } from './lake.js';

/**
 * Serves a Lake agent over A2A: the signed card at the well-known path, JSON-RPC at /a2a.
 * Messages arrive sealed for `me` (SPEC §3): `handle` gets them opened (verify them yourself), or null if they weren't
 * sealed for this agent, and returns a signed reply, which goes back sealed for the sender's card.
 */
export function lakeAgentApp(card: AgentCard, handle: (data: LakeData | null) => Promise<LakeData>, me: Identity): express.Express {
  const executor: AgentExecutor = {
    async execute(ctx, bus) {
      const part = readLakePart(ctx.userMessage);
      const data = isSealed(part) ? await openLake(part, me).catch(() => null) : null;
      const reply = await handle(data);
      // Sealed back to whoever sent it; a message nobody could open gets its refusal in the clear (it says nothing).
      const out = data?.card ? await sealLake(reply, data.card).catch(() => reply) : reply;
      bus.publish({ kind: 'message', data: lakeMessage(out, 'agent', ctx.contextId) });
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

const clients = new Map<string, Promise<{ card: AgentCard; client: Awaited<ReturnType<ClientFactory['createFromUrl']>> }>>();
const serviceParameters = ServiceParameters.create(withA2AExtensions(LAKE_EXTENSION_URI));

async function clientFor(agentUrl: string) {
  const base = agentUrl.replace(/\/$/, '');
  let entry = clients.get(base);
  if (!entry) {
    entry = fetch(cardUrlFor(base), { headers: { 'A2A-Version': '1.0' } })
      // Nobody there (an agent that left, a typo): say so, not "card has no Lake profile" (run 17).
      .then(async (r) => { if (!r.ok) throw new Error(`no agent answers at ${base} (HTTP ${r.status}): it may have left the Lake`); return r.json() as Promise<AgentCard>; })
      // Sealed only for a key its own signed card vouches for.
      .then(async (card) => { await verifyLakeCard(card); return { card, client: await new ClientFactory().createFromAgentCard(card) }; });
    clients.set(base, entry);
    entry.catch(() => clients.delete(base));
  }
  return entry;
}

/** Sends one A2A data part as it is and returns the reply's part as it came: for tests and attack tools, not for talking. */
export async function postLakePart(agentUrl: string, part: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
  const { client } = await clientFor(agentUrl);
  const res = await client.sendMessage(
    { tenant: '', message: lakeMessage(part as LakeData, 'user'), configuration: undefined, metadata: undefined },
    { serviceParameters, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) },
  );
  return readLakePart('role' in res ? res : undefined);
}

/**
 * Sends a signed Lake message to an agent over A2A (declaring the Lake extension), sealed for the key on that agent's
 * own signed card, and returns its reply opened with `me` (null if the reply wasn't sealed for `me`).
 */
export async function sendLake(agentUrl: string, data: LakeData, opts: { me: Identity; timeoutMs?: number }): Promise<LakeData | null> {
  const { card } = await clientFor(agentUrl);
  const part = await postLakePart(agentUrl, await sealLake(data, card), opts);
  return isSealed(part) ? openLake(part, opts.me).catch(() => null) : null;
}
