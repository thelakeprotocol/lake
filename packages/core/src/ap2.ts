import { issueCredential, digestSRI } from './vc.js';
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
  budget: { currency: 'USD'; amount: number };
  intent_expiry: string;
  user_cart_confirmation_required: false;
}

export function signIntentMandate(human: Identity, humanWebId: string, s: IntentMandateSubject): Promise<string> {
  return issueCredential(
    { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'IntentMandate'], issuer: humanWebId, validFrom: new Date().toISOString(), credentialSubject: s } as never,
    human,
  );
}

export function signPaymentMandate(agent: Identity, agentWebId: string, o: { payee: string; amount: number; intentMandate: string; agreement: string }): Promise<string> {
  return issueCredential(
    {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'PaymentMandate'],
      issuer: agentWebId,
      validFrom: new Date().toISOString(),
      credentialSubject: { id: o.payee, amount: { currency: 'USD', value: o.amount }, intentMandate: digestSRI(o.intentMandate), agreement: o.agreement },
    } as never,
    agent,
  );
}
