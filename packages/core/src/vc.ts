import { createHash } from 'node:crypto';
import * as jose from 'jose';
import type { Identity } from './crypto.js';

/**
 * W3C Verifiable Credentials 2.0, secured with VC-JOSE-COSE (a compact JWS whose payload is the credential).
 * Records are not embedded: the credential points at the original resource and pins it with a digest,
 * so the signed original can stay unchanged in the pod.
 */
export interface Credential {
  '@context': string[];
  type: string[];
  issuer: string;
  validFrom: string;
  credentialSubject: { id: string } & Record<string, unknown>;
  relatedResource?: { id: string; digestSRI: string; mediaType?: string }[];
}

/** Subresource Integrity digest, as used by VC 2.0 `relatedResource.digestSRI`. */
export function digestSRI(bytes: string | Uint8Array): string {
  return 'sha256-' + createHash('sha256').update(bytes).digest('base64');
}

export async function issueCredential(vc: Credential, id: Identity): Promise<string> {
  return new jose.CompactSign(new TextEncoder().encode(JSON.stringify(vc)))
    .setProtectedHeader({ alg: 'EdDSA', kid: id.kid, typ: 'vc+jwt', cty: 'vc' })
    .sign(id.privateKey);
}

export class CredentialError extends Error {}

/** Verifies a VC-JOSE credential against the issuer's public key; optionally checks a related resource's bytes. */
export async function verifyCredential(jws: string, issuerJwk: jose.JWK, related?: { id: string; bytes: string | Uint8Array }): Promise<Credential> {
  let vc: Credential;
  try {
    const key = await jose.importJWK(issuerJwk, 'EdDSA');
    const { payload, protectedHeader } = await jose.compactVerify(jws, key);
    if (protectedHeader.typ !== 'vc+jwt') throw new Error('wrong typ');
    vc = JSON.parse(new TextDecoder().decode(payload)) as Credential;
  } catch {
    throw new CredentialError('credential signature does not verify');
  }
  if (Date.parse(vc.validFrom) > Date.now()) throw new CredentialError('credential not yet valid');
  if (related) {
    const pinned = vc.relatedResource?.find((r) => r.id === related.id);
    if (!pinned) throw new CredentialError(`credential does not cover ${related.id}`);
    if (pinned.digestSRI !== digestSRI(related.bytes)) throw new CredentialError(`${related.id} was changed after it was signed`);
  }
  return vc;
}
