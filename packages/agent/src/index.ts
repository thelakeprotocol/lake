import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { homedir, hostname } from 'node:os';
import {
  buildCard, cardUrlFor, exampleStudies, issueCredential, generateIdentity, lakeProfile, loadPacks, lakeAgentApp, LakeLinks, loadOrCreateIdentity, makeEvent, ReplayGuard, signCard, signIntentMandate, signMessage, signPaymentMandate, verifyLakeData,
  type AgentCard, type Identity, type LakeData, type LakeProfile, type Offer, type Study,
} from '@thelakeprotocol/core';
import { ask, dispatch, knock, makeHuman, makeVisitor, type MissionResult, type StudyRun, type Visitor } from '@thelakeprotocol/visitor';


/** Units a transfer may not use: currency codes and money words. Real money goes through a payments agent. */
const MONEYLIKE = /^(usd|aud|eur|gbp|cad|nzd|jpy|chf|cny|inr|sgd|hkd|btc|eth|usdc|usdt)|dollar|euro|pound|sterling|cent|cash|money|fiat/;

export type { MissionResult, StudyRun, Study };

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
  /** `signed` is the message exactly as it arrived (card and envelope), so it can be forwarded as evidence anyone can check. */
  onMessage?: (m: { from: LakeProfile; card: AgentCard; payload: Record<string, unknown>; signed: LakeData }) => Promise<Record<string, unknown>>;
  /** A sandbox Lake: skip domain proof when checking who sent a message. Default true. */
  sandbox?: boolean;
  /** The use cases this agent works with (their studies, fields and houses). Default: health. */
  packs?: string[];
  /** Specialists to use. Defaults are the demo Lake's (docker compose). */
  ethics?: string;
  auditor?: string;
  payments?: string;
  /**
   * What this agent may pay other agents (lake_pay), under one Intent Mandate. On a real Lake the human signs it
   * on their own device; a sandbox connector signs a play-money allowance in their place and says so. 0: none.
   */
  allowanceUsd?: number;
  /** The node's public address, when `node` is an internal one (shown to assistants as the map). */
  publicNode?: string;
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
  /** This agent as a signed visitor (its key and card), for helpers that sign their own messages. */
  visitor: Visitor;
  webId: string;
  domain: string;
  /** Search the node: houses by skill or interest, specialists, other agents. */
  find(q?: { skill?: string; tag?: string; role?: string }): Promise<{ name: string; role: string; domain: string; tags: string[]; url: string }[]>;
  /** One signed offer to one house; the house's verified, signed reply. */
  knock(houseUrl: string, terms: Omit<Offer, 'id' | 'requester'>): Promise<Record<string, unknown>>;
  /** Any signed message to any Lake agent (the guide, the inspector, …); its verified, signed reply. */
  ask(agentUrl: string, payload: Record<string, unknown> & { kind: string }): Promise<Record<string, unknown>>;
  /** What this agent sent and the signed replies it got, newest last: its own evidence. */
  sent: { at: string; to: string; message: Record<string, unknown>; reply: LakeData }[];
  /** A whole study: ethics, audit, knock every house, bargain, agree, compute in place, pay, answer. */
  study(question: string, o?: StudyOptions): Promise<StudyRun>;
  /** Say what you're up for (e.g. game:connect4): same key, same address, a re-signed card, registered again. */
  setTags(tags: string[]): Promise<void>;
  /** Put a blueprint you wrote on the Lake (SPEC §11.3), signed by you; others find and read it there. */
  publishBlueprint(markdown: string): Promise<{ name: string; version: string; url: string }>;
  /**
   * Pay another agent. In USD: under this agent's allowance, settled by a payments agent, the receipt delivered to the
   * payee. In any other unit the two agreed on (hours, favours, a naming right): a transfer the payer signs and sends;
   * nothing backs it but the signature and the payer's word.
   */
  /** `order`: an order id, or the sha256 of what was delivered; the payment and its receipt name it. */
  pay(agentUrl: string, amount: number, memo: string, unit?: string, order?: string): Promise<{ paid: number; unit: string; to: string; remaining?: number; receipt: string; under?: string }>;
  /**
   * Where this agent's spending allowance comes from, once it's connected to its human's house: the allowance the human
   * signed there (SPEC §6.2). Without one, USD payments use the sandbox's play-money allowance, if any.
   */
  setAllowanceSource(source: () => Promise<{ credential: string; card: AgentCard; owner?: string } | null>): void;
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
  await loadPacks(o.packs ?? ['health'], (n) => import(n));
  const id: Identity = o.identity ?? (o.keyFile ? await loadOrCreateIdentity(o.keyFile) : await generateIdentity());
  const visitor: Visitor = await makeVisitor(id, o.domain, o.name, `${base}/a2a`);
  const sent: LakeAgent['sent'] = [];
  const quietMe = () => !!(lakeProfile(visitor.card)?.tags ?? []).includes('quiet');
  // Same identity, a card that also lists what this agent is up for.
  const tagged = async (tags: string[]) => signCard(buildCard({ name: o.name, description: `An agent acting for ${o.domain}.`, url: `${base}/a2a`, skills: [{ id: 'study', name: 'Studies', description: 'Asks houses to join studies' }, { id: 'messages', name: 'Messages', description: 'Takes signed messages from other agents' }], profile: { role: 'visitor', webId: `https://${o.domain}/#agent`, ownerDomain: o.domain, tags } }, id), id);
  if (o.tags?.length) visitor.card = await tagged(o.tags);
  const nodes = o.node.split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);

  // Serve our card while we're around, so a node can verify it and others can look us up.
  const reply = async (body: Record<string, unknown>): Promise<LakeData> => ({ lake: '0.1', card: visitor.card, envelope: (await signMessage(body, id, { iss: visitor.webId })) as LakeData['envelope'] });
  const replay = new ReplayGuard();
  const app = lakeAgentApp(visitor.card, async (data) => {
    if (!o.onMessage) return reply({ kind: 'rejected', code: 'busy', why: 'this agent visits; it does not take offers' });
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox ?? true });
    if (!v.ok) return reply({ kind: 'rejected', code: v.rejection.code, why: v.rejection.why });
    const { nonce: _n, iat: _i, exp: _e, iss: _s, ...payload } = v.payload;
    return reply(await o.onMessage({ from: v.profile, card: (data as LakeData).card, payload, signed: data as LakeData }));
  }, id);
  let server: Server | null = null;
  if (o.mount) o.mount(app);
  else {
    server = app.listen(port);
    await new Promise((ok) => server!.once('listening', ok));
  }
  const link = new LakeLinks({ nodeUrls: nodes, card: visitor.card, identity: id, webId: visitor.webId });
  await link.register(10);
  if (o.onMessage) link.keepAlive(20_000); // an agent that takes messages stays findable
  let allowance: Promise<{ credential: string; card: AgentCard }> | undefined;
  let allowanceSource: (() => Promise<{ credential: string; card: AgentCard; owner?: string } | null>) | undefined;

  return {
    card: visitor.card,
    visitor,
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
        // Your own card turns up in searches too; say so, or an agent ends up messaging itself.
        return { name: card.name, role: p.role, domain: p.ownerDomain, tags: p.tags, url: card.supportedInterfaces[0]!.url, ...(p.ownerDomain === visitor.domain ? { you: true } : {}) };
      });
    },
    sent,
    setAllowanceSource(source) { allowanceSource = source; },
    async knock(houseUrl, terms) {
      // The house reports the knock; the agent doesn't, or the two reports would pair it with the house (SPEC §8).
      const { reply } = await knock(houseUrl, visitor, terms);
      return reply;
    },
    async ask(agentUrl, payload) {
      const { reply: r, from, signed } = await ask(agentUrl, visitor, payload);
      // What this agent sent, and the other side's signed answer to it: evidence for a dispute, kept here only.
      sent.push({ at: new Date().toISOString(), to: agentUrl, message: payload, reply: signed });
      if (sent.length > 300) sent.shift();
      // Who talks to whom, and about what, is theirs (SPEC §8): the feed hears that this agent sent a message, never to whom or
      // what kind. (Guessing which kinds are private from their names leaked menus and findings on market day.) Nothing at all
      // for a quiet agent or to one: that someone talked to it is the secret.
      if (!from.tags?.includes('quiet') && !quietMe()) link.report(makeEvent('agent.message', 'self', undefined, { kind: 'message' }));
      const { nonce: _n, iat: _i, exp: _e, iss: _s, ...reply } = r;
      return reply;
    },
    async pay(agentUrl, amountUsd, memo, unit = 'USD', order) {
      // Some rulebooks call the sandbox's play dollars "USD-sim"; they are the same dollars.
      if (/^usd([-_ ]?sim)?$/i.test(unit)) unit = 'USD';
      // At least a cent, in whole cents: no dust, and no rounding drift in anyone's balance.
      if (!(amountUsd >= 0.01) || Math.abs(amountUsd * 100 - Math.round(amountUsd * 100)) > 1e-6) throw new Error('pay at least 0.01, in whole hundredths');
      const payeeCard = (await (await fetch(cardUrlFor(agentUrl))).json()) as AgentCard;
      const payee = lakeProfile(payeeCard)?.webId;
      if (!payee) throw new Error(`no Lake agent at ${agentUrl}`);
      if (payee === visitor.webId) throw new Error('paying yourself moves nothing; pay another agent');
      if (unit !== 'USD') {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(unit)) throw new Error('a unit is a short lowercase word, like hour or favour');
        // A self-signed IOU named like money ("usdsim", "eur") reads as money settled by a third party, which it isn't.
        if (MONEYLIKE.test(unit)) throw new Error(`"${unit}" looks like money: pay in USD (settled by the payments agent), or name what it really is (hour, favour, a token you invented)`);
        const credential = await issueCredential({
          '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeTransfer'], issuer: visitor.webId, validFrom: new Date().toISOString(),
          credentialSubject: { id: payee, amount: { unit, value: amountUsd }, memo: memo.slice(0, 200), ...(order ? { order: order.slice(0, 120) } : {}), backing: 'the payer\'s signature and word, nothing else' },
        }, id);
        await ask(agentUrl, visitor, { kind: 'transfer', transfer: { credential, card: visitor.card }, amount: amountUsd, unit, memo: memo.slice(0, 200) });
        if (!quietMe()) link.report(makeEvent('agent.message', 'self', undefined, { kind: 'payment', amount: amountUsd, unit }));
        return { paid: amountUsd, unit, to: payee, receipt: credential };
      }
      // The human's own signed allowance, from their house, comes first; then the sandbox's play money, if any.
      const own = (await allowanceSource?.().catch(() => null)) ?? null;
      if (!own && !o.allowanceUsd) throw new Error('this agent has no allowance to pay from in USD. Spending a person\'s money needs their house: they sign an allowance in its control panel (Money → Spending allowance) and you connect with lake_house_connect. Or pay in another unit you agreed on.');
      if (!own) allowance ??= (async () => {
        const human = await makeHuman(await generateIdentity(), o.domain, `Spending allowance for ${o.domain}`);
        const credential = await signIntentMandate(human.id, human.webId, {
          id: visitor.webId, natural_language_description: `What ${o.domain} may pay other agents`, study: `urn:lake:allowance:${o.domain}`,
          budget: { currency: 'USD', amount: o.allowanceUsd! }, intent_expiry: new Date(Date.now() + 86_400_000).toISOString(), user_cart_confirmation_required: false,
        });
        return { credential, card: human.card };
      })();
      const intent = own ?? (await allowance!);
      const payment = await signPaymentMandate(id, visitor.webId, { payee, amount: amountUsd, intentMandate: intent.credential, agreement: order ? `urn:lake:order:${order.slice(0, 120)}` : `urn:lake:memo:${memo.slice(0, 80)}`, currency: 'USD' });
      const payments = o.payments ?? 'http://payments:4600';
      const settled = (await ask(`${payments}/a2a`, visitor, { kind: 'settle', intent, payments: [payment] })).reply;
      if (settled.kind !== 'settled') throw new Error((settled.problems ?? [settled.why ?? 'refused']).join('; '));
      const receipt = settled.receipts[0].credential as string;
      const paymentsCard = (await (await fetch(cardUrlFor(`${payments}/a2a`))).json()) as AgentCard;
      // The payee gets the signed receipt; its inbox shows it like any other message.
      await ask(agentUrl, visitor, { kind: 'receipt', receipt: { credential: receipt, card: paymentsCard }, amount: amountUsd, memo: memo.slice(0, 200), ...(order ? { order } : {}) });
      if (!quietMe()) link.report(makeEvent('agent.message', 'self', undefined, { kind: 'payment', amount: amountUsd }));
      return { paid: amountUsd, unit, to: payee, remaining: settled.remaining as number, receipt, under: own ? 'your human\'s signed allowance' : 'the sandbox\'s play-money allowance' };
    },
    async study(question, s = {}) {
      const budget = s.budgetUsd ?? 0;
      return dispatch({
        visitor, node: nodes, link, log: s.log, houseCache: o.keyFile ? `${o.keyFile}.houses.json` : undefined,
        ethics: o.ethics ?? 'http://ethics:4500',
        auditor: o.auditor ?? 'http://auditor:4400',
        study: s.study ?? studyFor(question),
        // With no budget, offer nothing: a priced offer is a promise to pay.
        priceUsd: s.priceUsd ?? (budget > 0 ? 2 : 0),
        extraFields: s.extraFields,
        waitSeconds: s.waitSeconds,
        money: budget > 0
          ? { human: await makeHuman(o.keyFile ? await loadOrCreateIdentity(`${o.keyFile}.human`) : await generateIdentity(), o.domain), budgetUsd: budget, payments: o.payments ?? 'http://payments:4600' }
          : undefined,
      });
    },
    async publishBlueprint(markdown) {
      const envelope = await signMessage({ kind: 'blueprint', text: markdown }, id, { iss: visitor.webId });
      const res = await fetch(`${nodes[0]}/blueprints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
      const body = (await res.json()) as { name: string; version: string; url: string; why?: string; problems?: string[] };
      if (!res.ok) throw new Error(body.problems?.length ? `not a valid blueprint: ${body.problems.join('; ')}` : body.why ?? `node said ${res.status}`);
      return body;
    },
    async setTags(tags) {
      // In place: the card we serve and the one the nodes hold are this same object, so the address never changes.
      const fresh = await tagged(tags);
      for (const k of Object.keys(visitor.card)) delete (visitor.card as unknown as Record<string, unknown>)[k];
      Object.assign(visitor.card, fresh);
      await link.register(5);
    },
    async close() {
      link.stop();
      await link.flush();
      if (server) await new Promise((ok) => server!.close(ok));
    },
  };
}

/** Studies are certified in advance: a question must be one the loaded packs offer, or pass `study` yourself. */
function studyFor(question: string): Study {
  const found = exampleStudies().find((s) => s.question.toLowerCase() === question.trim().toLowerCase());
  if (!found) throw new Error(`no loaded pack offers "${question}"; pick one of: ${exampleStudies().map((s) => `"${s.question}"`).join(', ')}, or pass a study`);
  return found;
}

export { createLakeMcpServer } from './mcp.js';
export { lakeMcpHttpApp } from './http.js';

export const defaultKeyFile = (domain: string) => `${homedir()}/.lake/agent-${domain}.json`;
