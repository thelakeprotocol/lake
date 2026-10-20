import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { homedir, hostname } from 'node:os';
import {
  buildCard, generateIdentity, lakeAgentApp, LakeLinks, loadOrCreateIdentity, ReplayGuard, signCard, signMessage, verifyLakeData,
  type AgentCard, type Identity, type LakeData, type LakeProfile, type Offer, type Study,
} from '@thelakeprotocol/core';
import { ask, dispatch, knock, makeHuman, makeVisitor, readmissionStudy, type MissionResult, type Visitor } from '@thelakeprotocol/visitor';

export type { MissionResult, Study };

export interface LakeAgentOptions {
  /** What people see on the map. */
  name: string;
  /** The domain that answers for this agent. Outside a sandbox it must publish your key (SPEC §2.3). */
  domain: string;
  /** One or more Lake nodes (comma-separated) to register with and search. */
  node: string;
  /** Port to serve this agent's card on. Default 4800. */
  port?: number;
  /** Where others reach this agent, without /a2a. Default http://<host>:<port>. */
  publicUrl?: string;
  /** Keep the agent's key here so it keeps its identity (and reputation) across runs. Default: a fresh key. */
  keyFile?: string;
  /**
   * Serve this agent's card from an app you already run, instead of its own port: `mount` gets the
   * agent's routes (card at /.well-known/agent-card.json, A2A at /a2a). Set `publicUrl` to where they land.
   */
  mount?: (app: import('express').Express) => void;
  /** Interest tags on this agent's card: others find it by them (e.g. `game:connect4`). */
  tags?: string[];
  /** Use this key instead of keyFile or a fresh one (to re-join with a new card under the same identity). */
  identity?: Identity;
  /**
   * Messages other agents send this one. Each arrives verified (signed card, signed envelope, not replayed,
   * not expired); whatever you return is signed and sent back. Without it, the agent answers "busy".
   */
  onMessage?: (m: { from: LakeProfile; card: AgentCard; payload: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  /** A sandbox Lake: skip domain proof when checking who sent a message. Default true. */
  sandbox?: boolean;
  /** Specialists to use. Defaults are the demo Lake's (docker compose). */
  ethics?: string;
  auditor?: string;
  payments?: string;
}

export interface StudyOptions {
  priceUsd?: number;
  /** The most a human at your organisation lets this study spend. Signs an AP2 Intent Mandate. 0: unpaid. */
  budgetUsd?: number;
  /** Fields beyond what the study reads, to see houses push back (e.g. postcode). */
  extraFields?: string[];
  /** Wait this long for owners who were asked to tap Allow. */
  waitSeconds?: number;
  /** A custom declarative study. Default: the readmission study for `question`. */
  study?: Study;
  log?: (step: string, detail: string) => void;
}

export interface LakeAgent {
  card: AgentCard;
  webId: string;
  domain: string;
  /** Search the node: houses by skill or interest, specialists, other agents. */
  find(q?: { skill?: string; tag?: string; role?: string }): Promise<{ name: string; role: string; domain: string; tags: string[]; url: string }[]>;
  /** One signed offer to one house; the house's verified, signed reply. */
  knock(houseUrl: string, terms: Omit<Offer, 'id' | 'requester'>): Promise<Record<string, unknown>>;
  /** Any signed message to any Lake agent (the guide, the inspector, …); its verified, signed reply. */
  ask(agentUrl: string, payload: Record<string, unknown> & { kind: string }): Promise<Record<string, unknown>>;
  /** A whole study: ethics, audit, knock every house, bargain, agree, compute in place, pay, answer. */
  study(question: string, o?: StudyOptions): Promise<MissionResult>;
  close(): Promise<void>;
}

/**
 * Join the Lake:
 *
 *   const me = await joinLake({ name: 'My study bot', domain: 'me.example', node: 'http://lake-node:7000' });
 *   const r = await me.study('Do over-60s on drug X get readmitted less?', { priceUsd: 5, budgetUsd: 500 });
 *   console.log(r.answer.summary);
 *   await me.close();
 */
export async function joinLake(o: LakeAgentOptions): Promise<LakeAgent> {
  const port = o.port ?? 4800;
  const base = (o.publicUrl ?? `http://${existsSync('/.dockerenv') ? hostname() : 'localhost'}:${port}`).replace(/\/$/, '');
  const id: Identity = o.identity ?? (o.keyFile ? await loadOrCreateIdentity(o.keyFile) : await generateIdentity());
  const visitor: Visitor = await makeVisitor(id, o.domain, o.name, `${base}/a2a`);
  if (o.tags?.length) {
    // Same identity, a card that also lists what this agent is up for.
    const webId = `https://${o.domain}/#agent`;
    visitor.card = await signCard(buildCard({ name: o.name, description: `An agent acting for ${o.domain}.`, url: `${base}/a2a`, skills: [{ id: 'health-study', name: 'Health study', description: 'Asks houses to join studies' }, { id: 'messages', name: 'Messages', description: 'Takes signed messages from other agents' }], profile: { role: 'visitor', webId, ownerDomain: o.domain, tags: o.tags } }, id), id);
  }
  const nodes = o.node.split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);

  // Serve our card while we're around, so a node can verify it and others can look us up.
  const reply = async (body: Record<string, unknown>): Promise<LakeData> => ({ lake: '0.1', card: visitor.card, envelope: (await signMessage(body, id, { iss: visitor.webId })) as LakeData['envelope'] });
  const replay = new ReplayGuard();
  const app = lakeAgentApp(visitor.card, async (data) => {
    if (!o.onMessage) return reply({ kind: 'rejected', code: 'busy', why: 'this agent visits; it does not take offers' });
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox ?? true });
    if (!v.ok) return reply({ kind: 'rejected', code: v.rejection.code, why: v.rejection.why });
    const { nonce: _n, iat: _i, exp: _e, iss: _s, ...payload } = v.payload;
    return reply(await o.onMessage({ from: v.profile, card: (data as LakeData).card, payload }));
  });
  let server: Server | null = null;
  if (o.mount) o.mount(app);
  else {
    server = app.listen(port);
    await new Promise((ok) => server!.once('listening', ok));
  }
  const link = new LakeLinks({ nodeUrls: nodes, card: visitor.card, identity: id, webId: visitor.webId });
  await link.register(10);
  if (o.onMessage) link.keepAlive(20_000); // an agent that takes messages stays findable

  return {
    card: visitor.card,
    webId: visitor.webId,
    domain: o.domain,
    async find(q = {}) {
      const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
      let found: { card: AgentCard }[] | null = null;
      for (const node of nodes) {
        try {
          found = (await (await fetch(`${node}/cards?${params}`, { signal: AbortSignal.timeout(5000) })).json()) as { card: AgentCard }[];
          break;
        } catch {
          // try the next node
        }
      }
      if (!found) throw new Error('no Lake node reachable');
      return found.map(({ card }) => {
        const p = card.capabilities?.extensions?.[0]?.params as { role: string; ownerDomain: string; tags: string[] };
        return { name: card.name, role: p.role, domain: p.ownerDomain, tags: p.tags, url: card.supportedInterfaces[0]!.url };
      });
    },
    async knock(houseUrl, terms) {
      return (await knock(houseUrl, visitor, terms)).reply;
    },
    async ask(agentUrl, payload) {
      const { nonce: _n, iat: _i, exp: _e, iss: _s, ...reply } = (await ask(agentUrl, visitor, payload)).reply;
      return reply;
    },
    async study(question, s = {}) {
      const budget = s.budgetUsd ?? 0;
      return dispatch({
        visitor, node: nodes, link, log: s.log, houseCache: o.keyFile ? `${o.keyFile}.houses.json` : undefined,
        ethics: o.ethics ?? 'http://ethics:4500',
        auditor: o.auditor ?? 'http://auditor:4400',
        study: s.study ?? readmissionStudy(question),
        priceUsd: s.priceUsd ?? 2,
        extraFields: s.extraFields,
        waitSeconds: s.waitSeconds,
        money: budget > 0
          ? { human: await makeHuman(o.keyFile ? await loadOrCreateIdentity(`${o.keyFile}.human`) : await generateIdentity(), o.domain), budgetUsd: budget, payments: o.payments ?? 'http://payments:4600' }
          : undefined,
      });
    },
    async close() {
      link.stop();
      await link.flush();
      if (server) await new Promise((ok) => server!.close(ok));
    },
  };
}

export { createLakeMcpServer } from './mcp.js';
export { lakeMcpHttpApp } from './http.js';

export const defaultKeyFile = (domain: string) => `${homedir()}/.lake/agent-${domain}.json`;
