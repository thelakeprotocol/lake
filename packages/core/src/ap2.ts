import { createHash } from 'node:crypto';
import type { JWK } from 'jose';
import { issueCredential, digestSRI, verifyCredential } from './vc.js';
import type { Identity } from './crypto.js';

/**
 * AP2 (Agent Payments Protocol) mandates as W3C VCs.
 * A human signs an Intent Mandate: what the agent may buy, and the most it may spend. Within it, the
 * agent signs a Payment Mandate per payee. A payments agent checks the chain before it settles.
 */
export interface IntentMandateSubject {
  id: string;
  natural_language_description: string;
  study: string;
  /** ISO 4217, e.g. USD, AUD. */
  budget: { currency: string; amount: number };
  intent_expiry: string;
  user_cart_confirmation_required: false;
}

export function signIntentMandate(human: Identity, humanWebId: string, s: IntentMandateSubject): Promise<string> {
  return issueCredential(
    { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'IntentMandate'], issuer: humanWebId, validFrom: new Date().toISOString(), credentialSubject: s } as never,
    human,
  );
}

/**
 * `cart`: paying an AP2 cart a seller signed (SPEC §6.5): the mandate then names the cart's payment details id and the
 * hash of its contents, as AP2's PaymentMandateContents do, so the payment is for that cart and nothing else.
 */
export function signPaymentMandate(agent: Identity, agentWebId: string, o: { payee: string; amount: number; intentMandate: string; agreement: string; currency?: string; cart?: { detailsId: string; hash: string } }): Promise<string> {
  return issueCredential(
    {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'PaymentMandate'],
      issuer: agentWebId,
      validFrom: new Date().toISOString(),
      credentialSubject: { id: o.payee, amount: { currency: o.currency ?? 'USD', value: o.amount }, intentMandate: digestSRI(o.intentMandate), agreement: o.agreement, ...(o.cart ? { payment_details_id: o.cart.detailsId, cart_hash: o.cart.hash } : {}) },
    } as never,
    agent,
  );
}

/**
 * A house vouching that a key is its owner's (SPEC §6.2): the owner signs a spending allowance with a key that is on no
 * card, as the house's WebID, and whoever checks the allowance (a payments agent) checks this first, against the house's
 * card. The house never signs the money itself. Shown only to whoever must check it, so it doesn't link the owner's houses.
 */
export const OWNER_KEY_TYPE = 'LakeOwnerKey';

export function ownerKeyCredential(house: Identity, houseWebId: string, ownerJwk: JWK, days = 30): Promise<string> {
  const now = Date.now();
  return issueCredential(
    {
      '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', OWNER_KEY_TYPE], issuer: houseWebId,
      validFrom: new Date(now).toISOString(), validUntil: new Date(now + days * 86_400_000).toISOString(),
      credentialSubject: { id: houseWebId, ownerKey: { kty: ownerJwk.kty, crv: ownerJwk.crv, x: ownerJwk.x, kid: ownerJwk.kid } },
    } as never,
    house,
  );
}

/** The owner's key a house vouches for, once the vouching verifies against the house's own key and WebID. */
export async function verifyOwnerKey(credential: string, houseJwk: JWK, houseWebId: string): Promise<JWK> {
  const vc = await verifyCredential(credential, houseJwk);
  const s = vc.credentialSubject as { id?: string; ownerKey?: JWK };
  if (!vc.type.includes(OWNER_KEY_TYPE) || vc.issuer !== houseWebId || s.id !== houseWebId || !s.ownerKey?.x) throw new Error('not this house\'s word for its owner\'s key');
  const until = (vc as { validUntil?: string }).validUntil;
  if (until && Date.parse(until) < Date.now()) throw new Error('the house\'s word for its owner\'s key has expired');
  return { ...s.ownerKey, alg: 'EdDSA' };
}

/**
 * A house's word that an agent is its owner's assistant and may sell for it (SPEC §6.5): pinned to the assistant's key,
 * revocable on the house's status list (taking the assistant's key back sets its bit). A cart the assistant signs can
 * then name the house as payee, so what it earns is the house's. It widens nothing and moves no money by itself, so the
 * house's key signs it, not the owner's.
 */
export const ASSISTANT_KEY_TYPE = 'LakeAssistantKey';

export function assistantKeyCredential(house: Identity, houseWebId: string, assistant: { webId: string; jkt: string }, status: unknown, days = 30): Promise<string> {
  const now = Date.now();
  return issueCredential(
    {
      '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', ASSISTANT_KEY_TYPE], issuer: houseWebId,
      validFrom: new Date(now).toISOString(), validUntil: new Date(now + days * 86_400_000).toISOString(),
      // What it may do for the house, in its word: answer at its door for the owner, and sell for them (run 44: visitors read
      // "sell" alone and wondered whether the assistant was allowed to be talking to them).
      credentialSubject: { id: assistant.webId, cnf: { jkt: assistant.jkt }, house: houseWebId, may: ['answer', 'sell'] }, credentialStatus: status,
    } as never,
    house,
  );
}

/** An allowance the owner signs on their device: what their assistant may spend for them, in which currency, until when (SPEC §6.2). */
export const allowanceDraft = (houseWebId: string, assistantWebId: string, amount: number, until: Date, status?: unknown, currency = 'USD') => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential', 'IntentMandate'],
  issuer: houseWebId,
  credentialSubject: {
    id: assistantWebId, natural_language_description: 'What my assistant may spend for me on the Lake', study: `urn:lake:allowance:${houseWebId}`,
    budget: { currency, amount }, intent_expiry: until.toISOString(), user_cart_confirmation_required: false,
  } satisfies IntentMandateSubject,
  ...(status ? { credentialStatus: status } : {}),
});

/**
 * What money held for a pledge names as its agreement (SPEC §11.4a): the tally that settles it and the pledge's id, and
 * `|bond` for its opener's refund bond. A payments agent moves that money only on that tally's word.
 */
export const pledgeAgreement = (tally: string, id: string, bond = false) => `urn:lake:pledge:${tally}|${id}${bond ? '|bond' : ''}`;
/** Where a house files what it put into a pledge (its held receipt, then how it ended): beside what its assistant spent. */
export const pledgeReceiptPath = (agreement: string) => `receipts/spent-pledge-${createHash('sha256').update(agreement).digest('hex').slice(0, 16)}.receipt.jwt`;
/** Where a house files what it paid for a cart (its held receipt, then how it ended: released to the shop, or back). */
export const cartReceiptPath = (cartId: string) => `receipts/spent-cart-${createHash('sha256').update(cartId).digest('hex').slice(0, 16)}.receipt.jwt`;

/**
 * A contribution the owner signs on their device for one pledge: exactly its amount, to be held for that pledge and
 * nothing else (its `study` is the pledge's agreement), until just after the pledge settles.
 */
export const pledgeDraft = (houseWebId: string, pledge: { tally: string; id: string; text: string }, amount: number, currency: string, until: Date, status?: unknown) => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential', 'IntentMandate'],
  issuer: houseWebId,
  credentialSubject: {
    id: houseWebId, natural_language_description: `My contribution to the pledge "${pledge.text.slice(0, 200)}"`, study: pledgeAgreement(pledge.tally, pledge.id),
    budget: { currency, amount }, intent_expiry: until.toISOString(), user_cart_confirmation_required: false,
  } satisfies IntentMandateSubject,
  ...(status ? { credentialStatus: status } : {}),
});

/** What an owner may put their AI on duty for while they're away (SPEC §6.1): never money. */
export const DUTY_KINDS = ['reply', 'book', 'deliver'] as const;
export type DutyKind = (typeof DUTY_KINDS)[number];
/**
 * A duty grant the owner signs on their device: what their AI may do for them while they're away, how many actions a night,
 * in which hours, until when. A credential with a status bit, so taking it back (off duty) is one revocation.
 */
export const dutyDraft = (houseWebId: string, d: { kinds: DutyKind[]; cap: number; until: Date; hours?: { from: string; to: string; tz: string } }, status?: unknown) => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential', 'LakeDutyGrant'],
  issuer: houseWebId,
  credentialSubject: { id: `urn:lake:duty:${houseWebId}`, natural_language_description: 'What my AI may do for me while I am away', kinds: d.kinds, cap: d.cap, until: d.until.toISOString(), ...(d.hours ? { hours: d.hours } : {}) },
  ...(status ? { credentialStatus: status } : {}),
});

/** A currency, as AP2 and receipts name it: an ISO 4217 code. */
export const isCurrency = (c: unknown): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c);
