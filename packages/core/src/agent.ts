import express from 'express';
import { ClientFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { AgentCard } from '@a2a-js/sdk';
import { lakeMessage, readLakePart, type LakeData } from './a2a.js';
import { verifyLakeCard } from './card.js';
import type { Identity, ReplayGuard } from './crypto.js';
import { isSealed, openLake, sealLake } from './seal.js';
import { LAKE_EXTENSION_URI } from './lake.js';
import { ReplyCache } from './replies.js';

/**
 * Serves a Lake agent over A2A: the signed card at the well-known path, JSON-RPC at /a2a.
 * Messages arrive sealed for `me` (SPEC §3): `handle` gets them opened (verify them yourself), or null if they weren't
 * sealed for this agent, and returns a signed reply, which goes back sealed for the sender's card.
 *
 * Give it the ReplayGuard `handle` verifies with, and a copy of a message it already verified and answered (a sender
 * retrying after a dropped connection) gets the same signed reply again without reaching `handle`: the work is done
 * once (SPEC §3). The copy must be the same signed envelope from the same card; anything else goes to `handle`, whose
 * guard refuses a reused nonce.
 */
export function lakeAgentApp(card: AgentCard, handle: (data: LakeData | null) => Promise<LakeData>, me: Identity, opts: { replay?: ReplayGuard; replies?: ReplyCache<LakeData> } = {}): express.Express {
  const guard = opts.replay;
  const replies = guard ? (opts.replies ?? new ReplyCache<LakeData>()) : null;
  const answer = (data: LakeData | null): Promise<LakeData> => {
    const env = data?.envelope;
    if (!replies || !guard || !env?.payload || !env.jws) return handle(data);
    // Keyed by the card too: the reply is sealed for that card, so only the sender it was first given to can read it.
    const key = ReplyCache.keyOf({ card: data!.card, envelope: { payload: env.payload, jws: { protected: env.jws.protected, signature: env.jws.signature } } });
    return replies.answer(key, Number(env.payload.exp), () => handle(data), () => guard.accepted(env));
  };
  const executor: AgentExecutor = {
    async execute(ctx, bus) {
      const part = readLakePart(ctx.userMessage);
      const data = isSealed(part) ? await openLake(part, me).catch(() => null) : null;
      const reply = await answer(data);
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

// What a connection that broke under a request looks like (Node's fetch puts the socket's error in `cause`). Not a
// timeout (the caller's own deadline), not an HTTP error (someone answered), not a name that doesn't resolve.
const DROPPED_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const DROPPED_TEXT = /ECONNRESET|socket hang up|other side closed|closed unexpectedly/i;

/** Whether an error is a connection that dropped before a reply came back: the message may or may not have arrived. */
export function droppedConnection(e: unknown): boolean {
  for (let x = e as { name?: string; code?: string; message?: string; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) {
    if (x.name === 'TimeoutError' || x.name === 'AbortError') return false;
    if ((x.code && DROPPED_CODES.has(x.code)) || DROPPED_TEXT.test(String(x.message ?? ''))) return true;
  }
  return false;
}

/**
 * Sends a signed Lake message to an agent over A2A (declaring the Lake extension), sealed for the key on that agent's
 * own signed card, and returns its reply opened with `me` (null if the reply wasn't sealed for `me`).
 *
 * A connection that drops before the reply comes back is tried again (`retries` times, 2 by default, with jittered
 * backoff) with the very same signed message, sealed afresh: a receiver answers a copy of a message it already acted
 * on with the reply it gave the first time (SPEC §3), so it is acted on at most once. A timeout is not retried.
 */
export async function sendLake(agentUrl: string, data: LakeData, opts: { me: Identity; timeoutMs?: number; retries?: number; onRetry?: (e: unknown, attempt: number) => void }): Promise<LakeData | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { card } = await clientFor(agentUrl);
      const part = await postLakePart(agentUrl, await sealLake(data, card), opts);
      return isSealed(part) ? openLake(part, opts.me).catch(() => null) : null;
    } catch (e) {
      if (attempt >= (opts.retries ?? 2) || !droppedConnection(e)) throw e;
      opts.onRetry?.(e, attempt + 1);
      await new Promise((r) => setTimeout(r, 200 * 3 ** attempt * (0.5 + Math.random())));
    }
  }
}

/**
 * Idle connections outlive the proxy's (SPEC §3, Retries). Node closes an idle keep-alive connection after 5 s; a
 * proxy in front (Apache pools its backend connections with no time limit of its own; Caddy keeps them 2 minutes) can
 * send the next request down a connection Node is closing just then. Apache then drops the client's connection
 * without an answer, and the client sees ECONNRESET with no idea whether its request was acted on (run 31). So the
 * server keeps idle connections longer than any proxy in front keeps them (deploy/apache-sandbox.conf gives Apache's
 * pool ttl=60).
 */
export function keepAliveBehindProxy<S extends { keepAliveTimeout: number; headersTimeout: number }>(server: S): S {
  server.keepAliveTimeout = 130_000;
  // Older Nodes drop a reused connection whose next request's headers take longer than this; keep it above.
  server.headersTimeout = 131_000;
  return server;
}
