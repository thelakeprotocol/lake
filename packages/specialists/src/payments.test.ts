import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCard, cartHash, EMPTY_SHA256, generateIdentity, issueCredential, sendLake, signCard, signCart, signIntentMandate, signMessage, signPaymentMandate, verifyLakeData, type AgentCard, type CartMandate, type DeliveryTerms, type Identity, type LakeData } from '@thelakeprotocol/core';
import { createPayments } from './review.js';

type Agent = { id: Identity; card: AgentCard; webId: string };
const agent = async (domain: string, name = domain, role: 'agent' | 'specialist' = 'agent'): Promise<Agent> => {
  const id = await generateIdentity();
  const webId = `https://${name}.example/#agent`;
  return { id, webId, card: await signCard(buildCard({ name, description: 'x', url: `https://${name}.example/a2a`, skills: [], profile: { role, webId, ownerDomain: domain, tags: [] } }, id), id) };
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let server: Server;
let url: string;
let seller: Agent, buyer: Agent, human: Agent, arbiter: Agent;
let intent: string;

// An arbiter's signed ruling on a cart: paid, and what it found about the delivery.
const rulingOn = async (cart: CartMandate, delivered: unknown) => ({ credential: await issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeRuling'], issuer: arbiter.webId, validFrom: new Date().toISOString(), credentialSubject: { id: `urn:ap2:cart:${cart.contents.id}`, cart: { id: cart.contents.id, hash: cartHash(cart.contents) }, paid: true, delivered } } as never, arbiter.id), card: arbiter.card });

const ask = async (from: Agent, payload: Record<string, unknown>) => {
  const reply = await sendLake(url, { lake: '0.1', card: from.card, envelope: (await signMessage(payload, from.id, { iss: from.webId })) as LakeData['envelope'] }, { me: from.id });
  const v = await verifyLakeData<Record<string, any>>(reply as LakeData<Record<string, any>>, { sandbox: true });
  if (!v.ok) throw new Error(v.rejection.why);
  return v.payload;
};
// A held payment for a fresh $2 cart (with the seller's delivery terms, if any): its hold id.
const payHeld = async (delivery?: DeliveryTerms, extra: Record<string, unknown> = {}) => {
  const cart: CartMandate = await signCart({ seller: seller.id, sellerWebId: seller.webId, sellerName: 'Seller', buyerWebId: buyer.webId, items: [{ label: 'A haiku', amount: { currency: 'USD', value: 2 } }], delivery });
  const payment = await signPaymentMandate(buyer.id, buyer.webId, { payee: seller.webId, amount: 2, intentMandate: intent, agreement: `urn:ap2:cart:${cart.contents.id}`, cart: { detailsId: cart.contents.payment_request.details.id, hash: cartHash(cart.contents) } });
  const r = await ask(buyer, { kind: 'settle', intent: { credential: intent, card: human.card }, payments: [payment], cart: { mandate: cart, card: seller.card }, hold: true, ...extra });
  if (r.kind !== 'settled') throw new Error(r.problems.join('; '));
  return { hold: JSON.parse(Buffer.from(r.receipts[0].credential.split('.')[1], 'base64url').toString()).credentialSubject.settlementId as string, cart };
};

beforeAll(async () => {
  [seller, buyer, human, arbiter] = await Promise.all([agent('seller.example', 'seller'), agent('buyer.example', 'buyer'), agent('buyer.example', 'human'), agent('arbiter.lake.local', 'arbiter', 'specialist')]);
  intent = await signIntentMandate(human.id, human.webId, { id: buyer.webId, natural_language_description: 'small purchases', study: 'none', budget: { currency: 'USD', amount: 20 }, intent_expiry: new Date(Date.now() + 3_600_000).toISOString(), user_cart_confirmation_required: false });
  const app = express();
  server = await new Promise<Server>((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://localhost:${(server.address() as { port: number }).port}`;
  const payments = await createPayments({ id: await generateIdentity(), url: base, domain: 'payments.lake.local', sandbox: true });
  app.use(payments.app);
  url = `${base}/a2a`;
});

afterAll(() => server.close());

describe('a held payment follows the delivery (SPEC §6.5)', () => {
  it('takes no accept before a delivery, no empty delivery, and an accept only of the latest one', async () => {
    const { hold } = await payHeld();
    expect(await ask(buyer, { kind: 'capture', hold })).toMatchObject({ kind: 'refused', problems: [expect.stringMatching(/nothing has been delivered yet/)] });
    expect(await ask(seller, { kind: 'delivered', hold, sha256: EMPTY_SHA256 })).toMatchObject({ kind: 'refused', problems: [expect.stringMatching(/sha256 of nothing/)] });
    expect(await ask(buyer, { kind: 'delivered', hold, sha256: sha('x') })).toMatchObject({ kind: 'refused', problems: ['only the seller files a delivery'] });
    expect(await ask(seller, { kind: 'delivered', hold, sha256: sha('first') })).toMatchObject({ kind: 'delivered', revision: 1 });
    expect(await ask(seller, { kind: 'delivered', hold, sha256: sha('second') })).toMatchObject({ kind: 'delivered', revision: 2 });
    expect(await ask(buyer, { kind: 'capture', hold, sha256: sha('first') })).toMatchObject({ kind: 'refused', problems: [expect.stringMatching(/the latest is .* \(revision 2\)/)] });
    expect(await ask(buyer, { kind: 'capture', hold, sha256: sha('second') })).toMatchObject({ kind: 'captured' });
  });

  it('settles a "not as described" dispute by a revision, a part refund and an accept, never by a ruling', async () => {
    const { hold } = await payHeld();
    await ask(seller, { kind: 'delivered', hold, sha256: sha('owl?') });
    expect(await ask(buyer, { kind: 'dispute', hold, sha256: sha('owl?'), code: 'not_as_described' })).toMatchObject({ kind: 'disputed', code: 'not_as_described' });
    expect(await ask(buyer, { kind: 'dispute', hold, sha256: sha('owl?'), code: 'not_as_described' })).toMatchObject({ kind: 'refused' });
    expect(await ask(seller, { kind: 'rule', hold, ruling: {} })).toMatchObject({ kind: 'refused' });
    expect(await ask(seller, { kind: 'void', hold, amount: 2 })).toMatchObject({ kind: 'refused', problems: [expect.stringMatching(/^amount: part of/)] });
    expect(await ask(seller, { kind: 'void', hold, amount: 0.5 })).toMatchObject({ kind: 'voided', partial: true, refunded: 0.5, still_held: 1.5 });
    const done = await ask(buyer, { kind: 'capture', hold, sha256: sha('owl?') });
    expect(done).toMatchObject({ kind: 'captured' });
    // The release receipt tells the story: how it ended, the delivery, and the dispute and how that ended.
    const sub = JSON.parse(Buffer.from(done.credential.split('.')[1], 'base64url').toString()).credentialSubject;
    expect(sub).toMatchObject({ amount: { value: 1.5 }, how: 'accepted', delivered: sha('owl?'), deliveries: 1, disputes: [{ code: 'not_as_described', ended: 'accepted' }] });
  });

  it('follows the cart\'s signed terms: its clocks, its revisions, and a ruling that a delivery misses its counts (run 36)', async () => {
    const { hold, cart } = await payHeld({ within_hours: 2, review_hours: 3, revisions: 1, words: { min: 90, max: 110 } });
    await ask(seller, { kind: 'delivered', hold, sha256: sha('124 words') });
    const second = await ask(seller, { kind: 'delivered', hold, sha256: sha('still 124 words') });
    expect(Math.abs(Date.parse(second.until) - Date.now() - 3 * 3_600_000)).toBeLessThan(60_000);
    expect(await ask(seller, { kind: 'delivered', hold, sha256: sha('a third') })).toMatchObject({ kind: 'refused', problems: [expect.stringMatching(/^2 deliveries filed, all the cart promises/)] });
    await ask(buyer, { kind: 'dispute', hold, sha256: sha('still 124 words'), code: 'not_as_described' });
    // Meeting the counts proves nothing about quality: no money moves. Missing them is a fact: refunded.
    expect(await ask(seller, { kind: 'rule', hold, ruling: await rulingOn(cart, { sha256: sha('still 124 words'), acknowledged: true, meets_terms: true }) })).toMatchObject({ kind: 'refused', problems: [expect.stringMatching(/meets the counts the cart names/)] });
    const refunded = await ask(buyer, { kind: 'rule', hold, ruling: await rulingOn(cart, { sha256: sha('still 124 words'), acknowledged: true, meets_terms: false }) });
    expect(refunded).toMatchObject({ kind: 'voided' });
    expect(JSON.parse(Buffer.from(refunded.credential.split('.')[1], 'base64url').toString()).credentialSubject).toMatchObject({ how: 'ruling', disputes: [{ code: 'not_as_described', ended: 'ruling_for_buyer' }] });
    // A buyer can't pick other hours than the cart's.
    await expect(payHeld({ review_hours: 3 }, { release_after_hours: 5 })).rejects.toThrow(/the cart's terms give you 3 hours to answer each delivery/);
  });

  it('lets an arbiter settle "never arrived" only, about the delivery disputed, and says which way it went', async () => {
    const { hold, cart } = await payHeld();
    // Nothing filed: there is nothing to say never came; the seller's clock runs.
    expect(await ask(buyer, { kind: 'dispute', hold, code: 'not_received' })).toMatchObject({ kind: 'refused', problems: [expect.stringMatching(/the seller has filed no delivery/)] });
    await ask(seller, { kind: 'delivered', hold, sha256: sha('sent?') });
    // "It never arrived" can't name what never came: it is about the latest delivery filed.
    expect(await ask(buyer, { kind: 'dispute', hold, code: 'not_received' })).toMatchObject({ kind: 'disputed', code: 'not_received' });
    const ruling = async (delivered: unknown) => rulingOn(cart, delivered);
    expect(await ask(seller, { kind: 'rule', hold, ruling: await ruling({ sha256: sha('another'), acknowledged: true }) })).toMatchObject({ kind: 'refused', problems: [expect.stringMatching(/another delivery than the one disputed/)] });
    const released = await ask(seller, { kind: 'rule', hold, ruling: await ruling({ sha256: sha('sent?'), acknowledged: true }) });
    expect(released).toMatchObject({ kind: 'captured' });
    expect(JSON.parse(Buffer.from(released.credential.split('.')[1], 'base64url').toString()).credentialSubject).toMatchObject({ how: 'ruling', disputes: [{ code: 'not_received', ended: 'ruling_for_seller' }] });
  });
});
