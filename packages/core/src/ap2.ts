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
      credentialSubject: { id: assistant.webId, cnf: { jkt: assistant.jkt }, house: houseWebId, may: ['sell'] }, credentialStatus: status,
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

/** A currency, as AP2 and receipts name it: an ISO 4217 code. */
export const isCurrency = (c: unknown): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c);
