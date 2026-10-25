import { randomUUID } from 'node:crypto';
import {
  auditProgram, auditStudy, checkCredentialStatus, verifyOwnerKey, purposeWithin, buildCard, digestSRI, identifyingFields, packs, programId, type QuoteProgram, makeEvent, type LakeEvent, verifyCredential, verifyLakeCard, issueCredential, lakeAgentApp, ReplayGuard, sendLake, signCard, signMessage, studyFields, studyId, verifyLakeData,
  packId, checkCart, type CartMandate, type CheckedCart, type AgentCard, type Identity, type LakeData, type LakePack, type LakeProfile, type Study,
} from '@thelakeprotocol/core';
import type express from 'express';

export interface SpecialistOptions { id: Identity; url: string; domain: string; sandbox: boolean; report?: (e: LakeEvent) => void }
type Reply =
  | { kind: 'approved' | 'certified'; credential: string; notes: string[] }
  | { kind: 'settled'; receipts: { payee: string; credential: string; logged?: { index: number; origin: string } }[]; currency?: string; total: number; remaining: number }
  | { kind: 'registered'; pack: string; domain: string; registered: boolean; register: string }
  | { kind: 'refused'; problems: string[] };

/** Converters this auditor has reviewed: those of the packs it runs with. A real auditor would pin the package digest too. */
const certifiedConverters = () => packs().map((p) => p.source?.converter).filter(Boolean);
const DAY = 86_400_000;

export type Refused = { kind: 'refused'; problems: string[] };
export interface Specialist { app: express.Express; card: AgentCard; webId: string; vc: (type: string, subject: Record<string, unknown> & { id: string }, days: number) => Promise<string> }

/** A signed Lake agent with one skill: verifies every message before `decide` sees it, signs every reply. */
export async function specialist<R extends { kind: string } = Reply>(o: SpecialistOptions, name: string, description: string, skill: string, decide: (payload: Record<string, unknown>, from: string, profile: LakeProfile, card: AgentCard) => Promise<R | Refused>, extraSkills: { id: string; name: string; description: string }[] = [], quiet = false, anonymous?: (payload: Record<string, unknown>) => boolean): Promise<Specialist> {
  const webId = `${o.url}/#${skill}`;
  const card = await signCard(
    // A quiet agent's visitors are nobody's business: it says so on its card, and reports no visits.
    buildCard({ name, description, url: `${o.url}/a2a`, skills: [{ id: skill, name, description }, ...extraSkills], profile: { role: 'specialist', webId, ownerDomain: o.domain, tags: quiet ? [skill, 'quiet'] : [skill] } }, o.id),
    o.id,
  );
  const replay = new ReplayGuard();
  const reply = async (body: R | Refused): Promise<LakeData> => ({ lake: '0.1', card, envelope: (await signMessage(body, o.id, { iss: webId })) as LakeData['envelope'] });
  const app = lakeAgentApp(card, async (data) => {
    // A message whose authority is something it carries (a blind pledge's pass), not who sent it, may come from a
    // throwaway identity whose domain proves nothing; its card and signature are still checked, and replays refused.
    const anon = !!anonymous?.(((data as LakeData | null)?.envelope?.payload ?? {}) as Record<string, unknown>);
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox || anon });
    if (!v.ok) return reply({ kind: 'refused', problems: [`${v.rejection.code}: ${v.rejection.why}`] });
    const out = await decide(v.payload, v.profile.webId, v.profile, (data as LakeData).card);
    // Tell the map who just came by, so it can show the visit. Ids and kinds only.
    if (out.kind !== 'refused' && !quiet) o.report?.(makeEvent('decision', 'self', `agent:${v.profile.ownerDomain}`, { decision: out.kind }));
    return reply(out);
  }, o.id);
  const vc = (type: string, subject: Record<string, unknown> & { id: string }, days: number) =>
    issueCredential(
      { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', type], issuer: webId, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + days * DAY).toISOString(), credentialSubject: subject } as never,
      o.id,
    );
  return { app, card, webId, vc };
}

/**
 * The demo Ethics agent: a fixed checklist, clearly labelled. A real one is a door to a human committee;
 * owners decide which ethics domains they trust (rules.yaml → trust.ethics).
 */
export async function createEthics(o: SpecialistOptions): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const s: Specialist = await specialist<Reply>(o, 'Ethics (demo checklist)', 'Reviews study protocols against a fixed checklist. A demo, not a human ethics committee.', 'ethics-review', async (p, from) => {
    if (p.kind !== 'ethics-review') return { kind: 'refused', problems: ['send { kind: "ethics-review", protocol }'] };
    const protocol = p.protocol as { study: Study; purpose: string; fields: string[]; retention: string } | undefined;
    const problems: string[] = [];
    if (!protocol?.study) return { kind: 'refused', problems: ['no study in the protocol'] };
    if (!purposeWithin(protocol.purpose, 'research')) problems.push('purpose must be research');
    if (protocol.retention !== 'none') problems.push('results only; no retention of anything else');
    const identifying = (protocol.fields ?? []).filter((f) => identifyingFields().includes(f));
    if (identifying.length) problems.push(`directly identifying fields: ${identifying.join(', ')}`);
    const missing = studyFields(protocol.study).filter((f) => !protocol.fields.includes(f));
    if (missing.length) problems.push(`the study uses fields the protocol doesn't declare: ${missing.join(', ')}`);
    const audit = auditStudy(protocol.study);
    if (!audit.ok) problems.push(...audit.problems);
    if (problems.length) return { kind: 'refused', problems };
    const credential = await s.vc('LakeEthicsApproval', { id: studyId(protocol.study), question: protocol.study.question, purpose: protocol.purpose, fields: protocol.fields, sponsor: from, reviewedBy: 'demo checklist, not a human committee' }, 90);
    return { kind: 'approved', credential, notes: ['demo approval: counts only with owners who trust this domain'] };
  });
  return { app: s.app, card: s.card, webId: s.webId };
}

/** The demo Auditor: certifies declarative studies the Lake can run safely, and reviewed converter packages. */
export async function createAuditor(o: SpecialistOptions): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const s: Specialist = await specialist<Reply>(o, 'Auditor (demo)', 'Certifies studies (exact totals of known questions, counted by two tellers) and converter packages.', 'study-audit', async (p) => {
    if (p.kind === 'audit-study') {
      const study = p.study as Study;
      const audit = auditStudy(study);
      if (!audit.ok) return { kind: 'refused', problems: audit.problems };
      const credential = await s.vc('LakeStudyCertificate', { id: studyId(study), checks: ['declarative study, no code', 'answers split between two tellers run by different parties', 'totals only', `no table from fewer than ${study.privacy.min} houses`] }, 90);
      return { kind: 'certified', credential, notes: [] };
    }
    if (p.kind === 'audit-program') {
      // Quote programs: declarative, bounded, reading only safe fields of a pack here, shown only to the owner.
      const program = p.program as QuoteProgram;
      const audit = auditProgram(program);
      if (!audit.ok) return { kind: 'refused', problems: audit.problems };
      const credential = await s.vc('LakeProgramCertificate', { id: programId(program), pack: program.pack, checks: ['declarative program, no code', 'reads only safe fields of its pack', 'result shown to the owner only'] }, 90);
      return { kind: 'certified', credential, notes: [] };
    }
    if (p.kind === 'audit-converter') {
      const pkg = String(p.package ?? '');
      if (!certifiedConverters().includes(pkg)) return { kind: 'refused', problems: [`${pkg} has not been reviewed`] };
      const credential = await s.vc('LakeConverterCertificate', { id: `urn:lake:converter:${pkg}`, package: pkg }, 365);
      return { kind: 'certified', credential, notes: [] };
    }
    return { kind: 'refused', problems: ['send { kind: "audit-study", study }, { kind: "audit-program", program } or { kind: "audit-converter", package }'] };
  });
  return { app: s.app, card: s.card, webId: s.webId };
}

/**
 * A demo authority for a pack (for mortgages: a stand-in for a register of authorised firms, like the FCA's).
 * It authorises the agents on its register to quote for that pack, as a signed credential houses check.
 */
export async function createAuthority(o: SpecialistOptions & { pack: LakePack }): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const a = o.pack.authority!;
  const id = packId(o.pack);
  const s: Specialist = await specialist<Reply>(o, a.name, `${a.description} Anyone may check an agent: { kind: "registered", domain }.`, 'authorise', async (p, from, profile) => {
    // Anyone may ask whether an agent is on the register (run 26's agents couldn't check a grocer before talking to it).
    if (p.kind === 'registered') {
      const domain = String(p.domain ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/[/#].*$/, '');
      return { kind: 'registered', pack: id, domain, registered: a.register.includes(domain), register: a.name };
    }
    if (p.kind !== 'authorise') return { kind: 'refused', problems: ['send { kind: "authorise", pack } for yourself, or { kind: "registered", domain } to check anyone'] };
    if (p.pack !== id) return { kind: 'refused', problems: [`this register covers ${id}`] };
    if (!a.register.includes(profile.ownerDomain)) return { kind: 'refused', problems: [`${profile.ownerDomain} is not on the register`] };
    const credential = await s.vc('LakeAuthorisation', { id: from, domain: profile.ownerDomain, pack: id, scope: 'quote' }, 365);
    return { kind: 'approved', credential, notes: [`authorised to quote for ${id}`] };
  });
  return { app: s.app, card: s.card, webId: s.webId };
}

export const newId = () => randomUUID();

/**
 * The demo Payments agent: checks the AP2 mandate chain (a human's Intent Mandate, the agent's Payment
 * Mandates under it, the budget) and records settlements. Settlement is simulated; receipts are real VCs.
 */
export async function createPayments(o: SpecialistOptions & { onSettled?: (amount: number, count: number) => void; log?: (entry: string, kind: string) => Promise<{ index: number; origin: string }> }): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const spent = new Map<string, number>();
  // Carts already paid, by the hash of their contents: a seller's cart is paid once.
  const paidCarts = new Set<string>();
  /**
   * Payments held until delivery (authorize, then capture, as card payments do): a cart paid with hold is counted
   * against the buyer's budget at once, but reaches the seller only when the buyer accepts, when its time runs out with
   * no dispute, or when an arbiter's ruling says it was delivered; the seller can void it (a refund), and a ruling that
   * it wasn't delivered voids it. Kept in memory: a restart pays out nothing it shouldn't, and forgets holds.
   */
  const holds = new Map<string, { id: string; payer: string; payee: string; payeeUrl?: string; amount: number; currency: string; digest: string; cart: { id: string; hash: string }; until: number; status: 'held' | 'captured' | 'voided'; disputed?: boolean }>();
  const HOLD_MS = 24 * 3_600_000;
  const arbiters = ['arbiter.lake.local'];
  const s: Specialist = await specialist<Reply>(o, 'Payments (demo)', 'Verifies AP2 mandate chains and settles. Settlement is simulated; receipts are signed. Pays an AP2 cart a seller signed (SPEC §6.5) for exactly its total, once.', 'payments', async (p, agentWebId, agent) => {
    if (p.kind === 'capture' || p.kind === 'void' || p.kind === 'dispute' || p.kind === 'rule') return settleHold(p, agentWebId);
    if (p.kind !== 'settle') return { kind: 'refused', problems: ['send { kind: "settle", intent: { credential, card }, payments: [...], cart?, hold? }, or for a held payment capture / void / dispute { hold }, or rule { hold, ruling: { credential, card } }'] };
    const intent = p.intent as { credential: string; card: AgentCard; owner?: string } | undefined;
    const payments = (p.payments as string[] | undefined) ?? [];
    if (!intent?.credential || !intent.card) return { kind: 'refused', problems: ['no Intent Mandate'] };
    let human;
    try {
      human = await verifyLakeCard(intent.card);
    } catch (e) {
      return { kind: 'refused', problems: [`the human's card: ${(e as Error).message}`] };
    }
    // An owner's allowance: signed with the owner's own key, which their house vouches for (the card is the house's). The
    // owner names the assistant in it, so it needn't share the assistant's organisation. Otherwise: a person of the
    // agent's own organisation signed it with the key on their card.
    let signerJwk = human.publicJwk;
    if (intent.owner) {
      try {
        signerJwk = await verifyOwnerKey(intent.owner, human.publicJwk, human.webId);
      } catch (e) {
        return { kind: 'refused', problems: [`the house's word for its owner's key: ${(e as Error).message}`] };
      }
    } else if (human.ownerDomain !== agent.ownerDomain) return { kind: 'refused', problems: ['the Intent Mandate was signed by someone outside the agent\'s organisation'] };
    let mandate;
    try {
      mandate = await verifyCredential(intent.credential, signerJwk);
    } catch {
      return { kind: 'refused', problems: ['the Intent Mandate signature does not verify'] };
    }
    if (intent.owner && mandate.issuer !== human.webId) return { kind: 'refused', problems: ['the allowance was not issued as this house\'s owner'] };
    // Taken back? The owner revokes an allowance on the house's public status list.
    const status = await checkCredentialStatus(mandate as never).catch((e: Error) => ({ checked: true as const, revoked: true, why: e.message }));
    if (status.checked && status.revoked) return { kind: 'refused', problems: ['the owner has taken this allowance back'] };
    const m = mandate.credentialSubject as unknown as { id: string; budget: { amount: number; currency?: string }; intent_expiry: string };
    if (!mandate.type.includes('IntentMandate') || m.id !== agentWebId) return { kind: 'refused', problems: ['the Intent Mandate is not for this agent'] };
    if (Date.parse(m.intent_expiry) < Date.now()) return { kind: 'refused', problems: ['the Intent Mandate has expired'] };
    const digest = digestSRI(intent.credential);
    const currency = m.budget.currency ?? 'USD';
    // Paying a seller's cart: its signature, its total and its buyer are checked here, before any money moves.
    const c = p.cart as { mandate?: CartMandate; card?: AgentCard } | undefined;
    let cart: (CheckedCart & { webId: string }) | undefined;
    if (c) {
      try {
        const seller = await verifyLakeCard(c.card as AgentCard);
        cart = { ...(await checkCart(c.mandate as CartMandate, seller.publicJwk)), webId: seller.webId };
        if (cart.seller !== seller.webId) throw new Error('the cart was signed for another seller');
        if (cart.buyer !== agentWebId) throw new Error('the cart was made out to another buyer');
      } catch (e) {
        return { kind: 'refused', problems: [(e as Error).message] };
      }
      if (paidCarts.has(cart.hash)) return { kind: 'refused', problems: [`cart ${cart.id} is paid already`] };
      if (payments.length !== 1) return { kind: 'refused', problems: ['one payment per cart'] };
    }
    const checked: { payee: string; amount: number; agreement: string }[] = [];
    for (const pm of payments) {
      try {
        const vc = await verifyCredential(pm, agent.publicJwk);
        const x = vc.credentialSubject as unknown as { id: string; amount: { value: number; currency?: string }; intentMandate: string; agreement: string; payment_details_id?: string; cart_hash?: string };
        if (!vc.type.includes('PaymentMandate') || x.intentMandate !== digest || !(x.amount.value > 0)) throw new Error();
        // The owner signed a budget in one currency: a payment in another isn't under it (nothing here converts).
        if ((x.amount.currency ?? 'USD') !== currency) return { kind: 'refused', problems: [`the allowance is in ${currency}; this payment is in ${x.amount.currency ?? 'USD'}`] };
        // Whole cents, at least one; and an agent can't pay itself (it would only inflate what looks settled).
        if (x.amount.value < 0.01 || Math.abs(x.amount.value * 100 - Math.round(x.amount.value * 100)) > 1e-6) return { kind: 'refused', problems: [`${currency} ${x.amount.value}: pay at least 0.01, in whole cents`] };
        if (x.id === agentWebId) return { kind: 'refused', problems: ['an agent can\'t pay itself'] };
        if (cart && (x.id !== cart.webId || x.cart_hash !== cart.hash || Math.round(x.amount.value * 100) !== Math.round(cart.total.value * 100) || (x.amount.currency ?? 'USD') !== cart.total.currency)) {
          return { kind: 'refused', problems: [`the payment must be exactly the cart: ${cart.total.currency} ${cart.total.value} to its seller, naming its hash`] };
        }
        checked.push({ payee: x.id, amount: Math.round(x.amount.value * 100), agreement: x.agreement });
      } catch {
        return { kind: 'refused', problems: ['a Payment Mandate is not signed by the agent under this Intent Mandate'] };
      }
    }
    // Counted in cents, so a budget never drifts by a rounding error.
    const total = checked.reduce((a, c) => a + c.amount, 0);
    const already = spent.get(digest) ?? 0;
    const cap = Math.round(m.budget.amount * 100);
    if (already + total > cap) {
      return { kind: 'refused', problems: [`${currency} ${(already + total) / 100} is over the ${currency} ${m.budget.amount} the human signed for: a human must approve`] };
    }
    spent.set(digest, already + total);
    if (cart) paidCarts.add(cart.hash);
    const hold = !!cart && p.hold === true;
    const receipts = await Promise.all(
      checked.map(async (c) => {
        // A settlement id of its own: two payments with the same payer, payee, amount and memo are still two receipts.
        const settlementId = randomUUID();
        if (hold) holds.set(settlementId, { id: settlementId, payer: agentWebId, payee: c.payee, payeeUrl: (p.cart as { card?: AgentCard })?.card?.supportedInterfaces?.[0]?.url, amount: c.amount, currency, digest, cart: { id: cart!.id, hash: cart!.hash }, until: Date.now() + HOLD_MS, status: 'held' });
        return {
          payee: c.payee,
          credential: await s.vc('LakeReceipt', { id: c.payee, payer: agentWebId, amount: { currency, value: c.amount / 100 }, agreement: c.agreement, ...(cart ? { cart: { id: cart.id, hash: cart.hash } } : {}), intentMandate: digest, settlement: hold ? 'held' : 'simulated', settlementId, ...(hold ? { heldUntil: new Date(Date.now() + HOLD_MS).toISOString() } : {}) }, 3650),
        };
      }),
    );
    o.onSettled?.(total / 100, checked.length);
    // On the record: every receipt goes into the transparency log, so it can't be quietly rewritten or denied later.
    const logged = await Promise.all(receipts.map(async (r) => ({ ...r, ...(o.log ? { logged: await o.log(r.credential, 'receipt').then(({ index, origin }) => ({ index, origin })).catch(() => undefined) } : {}) })));
    return { kind: 'settled', receipts: logged, currency, total: total / 100, remaining: (cap - already - total) / 100, ...(hold ? { held: true, until: new Date(Date.now() + HOLD_MS).toISOString() } : {}) };
  });

  // The money of a held payment moves: to the seller (capture), or back under the buyer's budget (void). The seller gets
  // the capture receipt; either way it goes on the log.
  const finish = async (h: NonNullable<ReturnType<typeof holds.get>>, to: 'captured' | 'voided', why: string) => {
    h.status = to;
    if (to === 'voided') spent.set(h.digest, Math.max(0, (spent.get(h.digest) ?? 0) - h.amount));
    const credential = await s.vc('LakeReceipt', { id: to === 'captured' ? h.payee : h.payer, payer: h.payer, amount: { currency: h.currency, value: h.amount / 100 }, agreement: `urn:ap2:cart:${h.cart.id}`, cart: h.cart, intentMandate: h.digest, settlement: to === 'captured' ? 'simulated' : 'voided', settlementId: randomUUID(), [to === 'captured' ? 'captures' : 'voids']: h.id, why }, 3650);
    const logged = o.log ? await o.log(credential, to === 'captured' ? 'capture' : 'void').then(({ index, origin }) => ({ index, origin })).catch(() => undefined) : undefined;
    if (to === 'captured' && h.payeeUrl) {
      const envelope = await signMessage({ kind: 'receipt', receipt: { credential, card: s.card }, amount: h.amount / 100, currency: h.currency, cart: h.cart.id, order: h.cart.id, memo: `released: ${why}` }, o.id, { iss: s.webId });
      void sendLake(h.payeeUrl, { lake: '0.1', card: s.card, envelope: envelope as LakeData['envelope'] }, { me: o.id, timeoutMs: 10_000 }).catch(() => {});
    }
    if (to === 'captured') o.onSettled?.(h.amount / 100, 1);
    return { kind: to, hold: h.id, cart: h.cart.id, credential, ...(logged ? { logged } : {}), why };
  };
  setInterval(() => { for (const h of holds.values()) if (h.status === 'held' && !h.disputed && h.until < Date.now()) void finish(h, 'captured', 'its time ran out with no dispute'); }, 60_000).unref();
  const settleHold = async (p: Record<string, unknown>, from: string): Promise<Reply> => {
    const h = holds.get(String(p.hold ?? ''));
    if (!h) return { kind: 'refused', problems: ['no held payment with that id (the receipt\'s settlementId)'] };
    if (h.status !== 'held') return { kind: 'refused', problems: [`it was ${h.status} already`] };
    if (p.kind === 'capture') return from === h.payer ? (await finish(h, 'captured', 'the buyer accepted')) as never : { kind: 'refused', problems: ['only the buyer releases it'] };
    if (p.kind === 'void') return from === h.payee ? (await finish(h, 'voided', 'the seller refunded it')) as never : { kind: 'refused', problems: ['only the seller voids it (a refund)'] };
    if (p.kind === 'dispute') {
      if (from !== h.payer) return { kind: 'refused', problems: ['only the buyer disputes it'] };
      h.disputed = true;
      return { kind: 'disputed', hold: h.id, note: 'held until the seller refunds or an arbiter rules' } as never;
    }
    // A ruling, from an arbiter this payments agent trusts, about this very cart: delivered and acknowledged releases it;
    // not delivered voids it; anything else leaves it held.
    const r = p.ruling as { credential?: string; card?: AgentCard } | undefined;
    try {
      const signer = await verifyLakeCard(r?.card as AgentCard);
      if (!arbiters.includes(signer.ownerDomain)) throw new Error(`${signer.ownerDomain} is not an arbiter this payments agent trusts`);
      const vc = await verifyCredential(String(r?.credential ?? ''), signer.publicJwk);
      const sub = vc.credentialSubject as unknown as { cart?: { hash: string }; paid?: boolean; delivered?: { acknowledged?: boolean } | null };
      if (!vc.type.includes('LakeRuling') || sub.cart?.hash !== h.cart.hash) throw new Error('not a ruling on this cart');
      if (sub.delivered?.acknowledged) return (await finish(h, 'captured', 'an arbiter ruled it delivered')) as never;
      if (!sub.delivered) return (await finish(h, 'voided', 'an arbiter ruled it not delivered')) as never;
      return { kind: 'refused', problems: ['the ruling settles neither way: it stays held'] };
    } catch (e) {
      return { kind: 'refused', problems: [(e as Error).message] };
    }
  };
  return { app: s.app, card: s.card, webId: s.webId };
}
