import * as jose from 'jose';
import { canonicalize } from './canonical.js';
import type { Identity } from './crypto.js';
import type { Offer } from './offer.js';
import { toOdrl } from './offer.js';
import { digestSRI } from './vc.js';

/**
 * Terms of a deal as a W3C ODRL Agreement, signed by both parties (SPEC §4).
 * The grant a house issues is built from the same terms, so the contract and the key cannot drift apart.
 */
export interface SignedAgreement {
  agreement: Record<string, unknown> & { uid: string };
  signatures: { by: string; jws: string }[];
}

export function agreementFor(offer: Offer, house: string, visitor: string, until: Date): SignedAgreement['agreement'] {
  const odrl = toOdrl(offer, house) as Record<string, any>;
  const permission = odrl.permission[0];
  permission.constraint.push({ leftOperand: 'dateTime', operator: 'lt', rightOperand: { '@value': until.toISOString(), '@type': 'xsd:dateTime' } });
  return {
    ...odrl,
    '@type': 'Agreement',
    uid: `urn:lake:agreement:${offer.id}:${digestSRI(house).slice(7, 19).replace(/[^a-zA-Z0-9]/g, '')}`,
    assigner: house,
    assignee: visitor,
    permission: [{ ...permission, assigner: house, assignee: visitor }],
  } as SignedAgreement['agreement'];
}

/** Detached JWS over the agreement's canonical form. */
export async function signAgreement(agreement: SignedAgreement['agreement'], id: Identity): Promise<string> {
  const jws = await new jose.FlattenedSign(new TextEncoder().encode(canonicalize(agreement))).setProtectedHeader({ alg: 'EdDSA', kid: id.kid, typ: 'odrl+jws' }).sign(id.privateKey);
  return `${jws.protected}..${jws.signature}`;
}

export async function verifyAgreementSignature(agreement: SignedAgreement['agreement'], jws: string, jwk: jose.JWK): Promise<boolean> {
  const [protectedHeader, , signature] = jws.split('.');
  try {
    await jose.flattenedVerify({ protected: protectedHeader!, signature: signature!, payload: jose.base64url.encode(canonicalize(agreement)) }, await jose.importJWK(jwk, 'EdDSA'));
    return true;
  } catch {
    return false;
  }
}

export const agreementDigest = (a: SignedAgreement['agreement']) => digestSRI(canonicalize(a));
