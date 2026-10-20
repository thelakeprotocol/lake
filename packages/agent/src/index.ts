import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { homedir, hostname } from 'node:os';
import {
  generateIdentity, lakeAgentApp, LakeLink, loadOrCreateIdentity, signMessage,
  type AgentCard, type Identity, type LakeData, type Offer, type Study,
} from '@thelakeprotocol/core';
import { dispatch, knock, makeHuman, makeVisitor, readmissionStudy, type MissionResult, type Visitor } from '@thelakeprotocol/visitor';

export type { MissionResult, Study };

export interface LakeAgentOptions {
  /** What people see on the map. */
  name: string;
  /** The domain that answers for this agent. Outside a sandbox it must publish your key (SPEC §2.3). */
  domain: string;
  /** A Lake node to register with and search. */
  node: string;
  /** Port to serve this agent's card on. Default 4800. */
  port?: number;
  /** Where others reach this agent, without /a2a. Default http://<host>:<port>. */
  publicUrl?: string;
  /** Keep the agent's key here so it keeps its identity (and reputation) across runs. Default: a fresh key. */
  keyFile?: string;
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
  const id: Identity = o.keyFile ? await loadOrCreateIdentity(o.keyFile) : await generateIdentity();
  const visitor: Visitor = await makeVisitor(id, o.domain, o.name, `${base}/a2a`);
  const node = o.node.replace(/\/$/, '');

  // Serve our card while we're around, so a node can verify it and others can look us up.
  const busy = async (): Promise<LakeData> => ({ lake: '0.1', card: visitor.card, envelope: (await signMessage({ kind: 'rejected', code: 'busy', why: 'this agent visits; it does not take offers' }, id, { iss: visitor.webId })) as LakeData['envelope'] });
  const server: Server = lakeAgentApp(visitor.card, busy).listen(port);
  await new Promise((ok) => server.once('listening', ok));
  const link = new LakeLink({ nodeUrl: node, card: visitor.card, identity: id, webId: visitor.webId });
  await link.register(10);

  return {
    card: visitor.card,
    webId: visitor.webId,
    domain: o.domain,
    async find(q = {}) {
      const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
      const found = (await (await fetch(`${node}/cards?${params}`)).json()) as { card: AgentCard }[];
      return found.map(({ card }) => {
        const p = card.capabilities?.extensions?.[0]?.params as { role: string; ownerDomain: string; tags: string[] };
        return { name: card.name, role: p.role, domain: p.ownerDomain, tags: p.tags, url: card.supportedInterfaces[0]!.url };
      });
    },
    async knock(houseUrl, terms) {
      return (await knock(houseUrl, visitor, terms)).reply;
    },
    async study(question, s = {}) {
      const budget = s.budgetUsd ?? 0;
      return dispatch({
        visitor, node, link, log: s.log,
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
      await link.flush();
      await new Promise((ok) => server.close(ok));
    },
  };
}

export { createLakeMcpServer } from './mcp.js';

export const defaultKeyFile = (domain: string) => `${homedir()}/.lake/agent-${domain}.json`;
