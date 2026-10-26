import type { Server } from 'node:http';
import {
  buildCard, generateIdentity, GROUP_SIZE, lakeAgentApp, LakeLinks, loadOrCreateIdentity, pack as packOf, ReplayGuard, runProgram, sendLake, signCard, signIntentMandate, signMessage,
  signPaymentMandate, verifyCredential, verifyLakeCard, verifyLakeData,
  type AgentCard, type Badge, type Claim, type Attachment, type Identity, type LakeData, type QuoterExample,
} from '@thelakeprotocol/core';
import { ask, type Visitor } from './knock.js';
import { makeHuman } from './dispatch.js';

/**
 * A quoter: an agent that prices intents for one pack (a lender for mortgages, an insurer, an energy
 * supplier…). It gets authorised by the pack's authority and its program certified by an auditor once;
 * then, for every intent a house sends it, it sends back its program to run inside that house. It never
 * sees the result unless the owner accepts; then it checks the released original with its issuer, confirms,
 * and pays the owner its fee, in its currency, under its own human's spending mandate.
 */
export interface QuoterOptions {
  example: QuoterExample;
  node: string;
  auditor: string;
  authority: string;
  payments?: string;
  /** Where houses reach it, without /a2a. */
  publicUrl: string;
  port?: number;
  mount?: (app: import('express').Express) => void;
  keyFile?: string;
  sandbox?: boolean;
  log?: (msg: string) => void;
  /**
   * Its WebID. Default: its own address (`<publicUrl>/#agent`), so the same demo quoter run by two deployments is two
   * agents, not one WebID with two keys (a node keeps one card per WebID: two federated Lakes each saw only their own).
   * Its domain (ownerDomain) stays the pack's, which is what a register lists.
   */
  webId?: string;
  /** How long to keep asking for the authorisation at start while the authority isn't up yet (ms). Default 3 minutes. */
  authoriseWithinMs?: number;
}

export interface Quoter { card: AgentCard; webId: string; quotes: () => number; close: () => Promise<void> }

export async function startQuoter(o: QuoterOptions): Promise<Quoter> {
  const ex = o.example;
  const p = packOf(ex.program.pack);
  if (!p) throw new Error(`no pack ${ex.program.pack} loaded`);
  const id: Identity = o.keyFile ? await loadOrCreateIdentity(o.keyFile) : await generateIdentity();
  const webId = o.webId ?? `${o.publicUrl.replace(/\/$/, '')}/#agent`;
  const cardWith = (badges?: Badge[]) => signCard(buildCard({
    name: ex.name, description: `Quotes for ${p.title.toLowerCase()} intents. Its program runs inside your house; only you see the result.`,
    url: `${o.publicUrl}/a2a`, skills: [{ id: `${p.id}-quote`, name: `${p.title} quotes`, description: ex.program.title }],
    profile: { role: 'agent', webId, ownerDomain: ex.domain, tags: [p.id], ...(badges ? { badges } : {}) },
  }, id), id);
  let card = await cardWith();
  const me: Visitor = { id, card, webId, domain: ex.domain };
  const log = o.log ?? (() => {});

  // Once: the authority's authorisation, and the auditor's certificate for the program. Started together with the
  // specialists, the authority may not be up yet ("fetch failed"): asked again with backoff, never on a refusal.
  const authorised = await untilReachable(() => ask(`${o.authority}/a2a`, me, { kind: 'authorise', pack: ex.program.pack }), o.authoriseWithinMs ?? 180_000, (e, wait) => log(`${ex.name}: the authority isn't answering yet (${e.message.slice(0, 80)}); again in ${Math.round(wait / 1000)} s`));
  if (authorised.reply.kind !== 'approved') throw new Error(`${ex.name} not authorised: ${(authorised.reply.problems ?? []).join('; ')}`);
  const authorisation: Attachment = { credential: authorised.reply.credential, card: await cardOf(o.authority) };
  // On its card too, as a badge: anyone searching sees the register vouches for it, not just a house that asks (run 23:
  // anyone could tag itself a grocer).
  card = await cardWith([{ credential: authorised.reply.credential, issuer: `${o.authority}/a2a` }]);
  me.card = card;
  const certified = await untilReachable(() => ask(`${o.auditor}/a2a`, me, { kind: 'audit-program', program: ex.program }), o.authoriseWithinMs ?? 180_000, () => {});
  if (certified.reply.kind !== 'certified') throw new Error(`${ex.name}'s program not certified: ${(certified.reply.problems ?? []).join('; ')}`);
  const certificate: Attachment = { credential: certified.reply.credential, card: await cardOf(o.auditor) };

  const currency = ex.currency ?? 'USD';
  const human = await makeHuman(await generateIdentity(), ex.domain);
  const mandate = await signIntentMandate(human.id, human.webId, {
    id: webId, natural_language_description: `${ex.name}: fees to applicants who accept our offers`, study: `urn:lake:quoter:${ex.domain}`,
    budget: { currency, amount: 1_000_000 }, intent_expiry: new Date(Date.now() + 365 * 86_400_000).toISOString(), user_cart_confirmation_required: false,
  });
  let quotes = 0;

  const reply = async (body: Record<string, unknown>): Promise<LakeData> => ({ lake: '0.1', card, envelope: (await signMessage(body, id, { iss: webId })) as LakeData['envelope'] });
  const replay = new ReplayGuard();
  const app = lakeAgentApp(card, async (data) => {
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox ?? true });
    if (!v.ok) return reply({ kind: 'rejected', code: v.rejection.code, why: v.rejection.why });
    const house = (data as LakeData).card.supportedInterfaces?.[0]?.url;
    const m = v.payload;
    if (m.kind === 'authorisation') return reply({ kind: 'authorisation', authorisation });
    if (m.kind === 'intent' && m.pack === ex.program.pack && house) {
      // Answer at once; quote right after, as a request of our own to the house.
      setTimeout(() => enqueue(house), 10);
      return reply({ kind: 'received' });
    }
    if (m.kind === 'accept' && house) return reply(await accepted(m, v.profile.webId, house));
    // Paid for an order: the payment's receipt arrives like any message; acknowledge it, naming the order.
    if (m.kind === 'receipt') return reply({ kind: 'received', note: `payment received${m.order ? ` for order ${String(m.order)}` : ''}; thank you` });
    // A question before accepting (run 24: "do you do halal beef?"): the answer is the certified program itself, which is
    // public: what it reads, what it says when it can't serve you, what the owner sees. Facts it stands behind, not chat.
    if (m.kind === 'question' || m.kind === 'note') {
      const pr = ex.program as typeof ex.program & { notes?: { say: string }[]; labels?: Record<string, { label: string; unit?: string }> };
      return reply({ kind: 'answer', from: ex.name, program: { title: pr.title, reads: pr.inputs, terms: pr.terms ?? [], says_when_it_cannot: (pr.notes ?? []).map((n) => n.say), shows: Object.fromEntries(Object.entries(pr.labels ?? {}).map(([k, v]) => [k, v.label + (v.unit ? ` (${v.unit})` : '')])) },
        note: 'what we offer is this certified program, run in your house on your data: it answers for us. Anything it doesn\'t say, it doesn\'t promise.' });
    }
    return reply({ kind: 'rejected', code: 'malformed', why: 'send an intent, an authorisation request, an acceptance, or a question (answered with our certified program)' });
  }, id, { replay });

  // A few quotes at a time, and another try for a house that was busy: a hundred homes asking at once is normal.
  const queue: string[] = [];
  let active = 0;
  function enqueue(house: string) {
    if (house && !queue.includes(house)) queue.push(house);
    while (active < 4 && queue.length) {
      active++;
      void sendQuote(queue.shift()!).finally(() => { active--; enqueue(''); });
    }
  }
  // What each house last said when it turned a quote away: logged when it changes, not every minute it says it again.
  const refusedBy = new Map<string, string>();
  async function sendQuote(house: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        const envelope = await signMessage({ kind: 'quote', program: ex.program, certificate, authorisation, fee: ex.feeOnAccept, currency }, id, { iss: webId });
        const raw = await sendLake(house, { lake: '0.1', card, envelope: envelope as LakeData['envelope'] }, { me: id, timeoutMs: 20_000 });
        // A reply is not a yes (run 32: three grocers took a day of refusals for quotes delivered). A refusal isn't retried:
        // the house will say the same until something changes, and it tells us again with its next intent.
        const v = raw ? await verifyLakeData<Record<string, unknown>>(raw as LakeData<Record<string, unknown>>, { sandbox: o.sandbox ?? true }) : null;
        const r = v?.ok ? v.payload : { kind: 'rejected', code: 'unreadable', why: v ? `its reply did not verify: ${v.rejection.why}` : 'no reply we could open' };
        if (r.kind === 'rejected') {
          const said = `${String(r.code)}: ${String(r.why)}`;
          if (refusedBy.get(house) !== said) log(`${ex.name}: ${house} turned our quote away (${said})`);
          refusedBy.set(house, said);
          return;
        }
        refusedBy.delete(house);
        quotes++;
        return;
      } catch (e) {
        if (attempt >= 3) return log(`${ex.name}: could not quote ${house}: ${(e as Error).message}`);
        await new Promise((ok) => setTimeout(ok, 2000 * attempt));
      }
    }
  }

  /** The owner said yes: check the released original with its issuer, confirm conditionally, pay the fee. */
  async function accepted(m: Record<string, unknown>, houseWebId: string, house: string): Promise<Record<string, unknown>> {
    const release = m.release as { original?: string; credential?: string; issuer?: { recordId: string; card: AgentCard }; claims?: Claim[] } | undefined;
    const terms = { ...(m.terms as Record<string, string | number>), [GROUP_SIZE]: Number((m.terms as Record<string, unknown>)?.[GROUP_SIZE] ?? 1) };
    const agreed = (outputs: Record<string, number>, paid = 0) => ({ kind: 'agreed', what: ex.acceptedAs ?? 'conditional approval', outputs, feePaid: paid, next: ex.next ?? 'a full application, with the documents you choose to send', order: String(m.ref) });
    // A pack that sends only the facts it names (a shopping list): the owner's own word, priced again as offered.
    if (p!.release?.includes('claims')) {
      if (!Array.isArray(release?.claims)) return { kind: 'rejected', code: 'malformed', why: `expected the claims for ${(p!.releaseFields ?? []).join(', ')}` };
      const result = runProgram(ex.program, release.claims.filter((c) => p!.releaseFields?.includes(c.field)), terms);
      return result.eligible ? agreed(result.outputs) : { kind: 'declined', why: 'that list no longer fits our offer' };
    }
    if (!release?.original || !release.credential || !release.issuer) return { kind: 'rejected', code: 'malformed', why: 'expected the original record, its credential and its issuer' };
    try {
      const issuer = await verifyLakeCard(release.issuer.card);
      if (issuer.ownerDomain !== p!.source?.issuer.domain && !(o.sandbox ?? true)) throw new Error(`we don't accept records from ${issuer.ownerDomain}`);
      const vc = await verifyCredential(release.credential, issuer.publicJwk, { id: release.issuer.recordId, bytes: release.original });
      if (vc.credentialSubject.id !== houseWebId) throw new Error('that record belongs to someone else');
    } catch (e) {
      return { kind: 'declined', why: `the record did not check out: ${(e as Error).message}` };
    }
    // Same rules, now on the verified original: the conditional approval stands, or it doesn't.
    const result = runProgram(ex.program, p!.source!.convert(release.original), terms);
    let paid: number | undefined;
    if (result.eligible && ex.feeOnAccept && o.payments) {
      try {
        const payment = await signPaymentMandate(id, webId, { payee: houseWebId, amount: ex.feeOnAccept, intentMandate: mandate, agreement: `urn:lake:offer:${String(m.ref)}`, currency });
        const settled = await ask(`${o.payments}/a2a`, me, { kind: 'settle', intent: { credential: mandate, card: human.card }, payments: [payment] });
        const receipt = settled.reply.receipts?.[0];
        if (receipt) {
          await ask(house, me, { kind: 'receipt', receipt: { credential: receipt.credential, card: await cardOf(o.payments) } });
          paid = ex.feeOnAccept;
        }
      } catch (e) {
        log(`${ex.name}: fee not paid: ${(e as Error).message}`);
      }
    }
    return result.eligible
      ? agreed(result.outputs, paid ?? 0)
      : { kind: 'declined', why: 'the verified record does not meet our rules after all' };
  }

  let server: Server | null = null;
  if (o.mount) o.mount(app);
  else server = app.listen(o.port ?? 0);
  const link = new LakeLinks({ nodeUrls: o.node.split(',').map((u) => u.trim()), card, identity: id, webId, log });
  await link.register(20);
  link.keepAlive(15_000);
  log(`${ex.name} quoting for ${ex.program.pack} at ${o.publicUrl}`);
  return {
    card, webId, quotes: () => quotes,
    close: async () => { link.stop(); await link.flush(); if (server) await new Promise((ok) => server!.close(ok)); },
  };
}

/** Retries what fails to reach its peer (a refused connection, a timeout), with backoff, until `withinMs` has passed. */
async function untilReachable<T>(fn: () => Promise<T>, withinMs: number, onRetry: (e: Error, waitMs: number) => void): Promise<T> {
  const end = Date.now() + withinMs;
  for (let wait = 1000; ; wait = Math.min(wait * 2, 15_000)) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() + wait > end) throw e;
      onRetry(e as Error, wait);
      await new Promise((ok) => setTimeout(ok, wait));
    }
  }
}

const cards = new Map<string, Promise<AgentCard>>();
function cardOf(base: string): Promise<AgentCard> {
  let c = cards.get(base);
  if (!c) {
    c = fetch(`${base}/.well-known/agent-card.json`).then((r) => r.json() as Promise<AgentCard>);
    cards.set(base, c);
  }
  return c;
}
