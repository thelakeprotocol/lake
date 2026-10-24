import { Bitstring } from '@digitalbazaar/bitstring';
import type * as jose from 'jose';
import type { AgentCard } from '@a2a-js/sdk';
import type { Identity } from './crypto.js';
import { verifyLakeCard } from './card.js';
import { issueCredential, verifyCredential, type Credential } from './vc.js';

/**
 * Revocation anyone can check (SPEC §6), as the W3C Bitstring Status List: an issuer publishes one signed list of
 * bits, and each credential it issues names its own bit. A set bit means the key was taken back, or used up. Checking
 * a key means fetching the whole list, so the issuer doesn't learn which key is being checked; and a list of at least
 * 131,072 bits, the standard's minimum, says little about any one of them.
 */
export const STATUS_LIST_LENGTH = 131_072;

export interface StatusEntry { id: string; type: 'BitstringStatusListEntry'; statusPurpose: 'revocation'; statusListIndex: string; statusListCredential: string }

/** Where a credential's bit is: put in the credential before it is signed. */
export const statusEntry = (listUrl: string, index: number): StatusEntry => ({ id: `${listUrl}#${index}`, type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: String(index), statusListCredential: listUrl });

/** The list as a signed credential (VC-JOSE), with the given bits set. */
export async function statusListCredential(issuer: string, listUrl: string, revoked: Iterable<number>, id: Identity): Promise<string> {
  const bits = new Bitstring({ length: STATUS_LIST_LENGTH });
  for (const i of revoked) if (Number.isInteger(i) && i >= 0 && i < STATUS_LIST_LENGTH) bits.set(i, true);
  return issueCredential({
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer,
    validFrom: new Date().toISOString(),
    credentialSubject: { id: `${listUrl}#list`, type: 'BitstringStatusList', statusPurpose: 'revocation', encodedList: `u${await bits.encodeBits()}` },
  } as Credential, id);
}

/** Reads one bit from a list credential, once it verifies against `issuerJwk` and comes from `issuer`. */
export async function readStatus(listJws: string, issuerJwk: jose.JWK, issuer: string, index: number): Promise<boolean> {
  const vc = await verifyCredential(listJws, issuerJwk);
  const s = vc.credentialSubject as { type?: string; statusPurpose?: string; encodedList?: string };
  if (!vc.type.includes('BitstringStatusListCredential') || s.type !== 'BitstringStatusList' || s.statusPurpose !== 'revocation') throw new Error('not a revocation status list');
  if (vc.issuer !== issuer) throw new Error('the status list is not from the credential\'s issuer');
  if (typeof s.encodedList !== 'string' || !s.encodedList.startsWith('u')) throw new Error('encodedList: multibase base64url');
  const bits = new Bitstring({ buffer: await Bitstring.decodeBits({ encoded: s.encodedList.slice(1) }) });
  if (bits.length < STATUS_LIST_LENGTH || index >= bits.length) throw new Error('the status list is too short');
  return bits.get(index);
}

/**
 * Whether a credential has been revoked, by its own status entry: fetches the list, and the signed card published
 * next to it (its key must sign the list, and its WebID must be the credential's issuer). No entry: nothing to check.
 */
export async function checkCredentialStatus(vc: { issuer: string; credentialStatus?: unknown }): Promise<{ checked: false } | { checked: true; revoked: boolean; list: string }> {
  const e = vc.credentialStatus as Partial<StatusEntry> | undefined;
  if (!e || e.type !== 'BitstringStatusListEntry' || e.statusPurpose !== 'revocation') return { checked: false };
  const list = String(e.statusListCredential ?? '');
  const index = Number(e.statusListIndex);
  if (!/^https?:\/\//.test(list) || !Number.isInteger(index) || index < 0) throw new Error('a malformed status entry');
  const base = list.replace(/\/status\/[^/]+$/, '');
  const [jws, card] = await Promise.all([
    fetch(list, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`status list: HTTP ${r.status}`)))),
    fetch(`${base}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json() as Promise<AgentCard>),
  ]);
  const signer = await verifyLakeCard(card);
  if (signer.webId !== vc.issuer) throw new Error('the status list is published by someone other than the issuer');
  return { checked: true, revoked: await readStatus(jws, signer.publicJwk, vc.issuer, index), list };
}
