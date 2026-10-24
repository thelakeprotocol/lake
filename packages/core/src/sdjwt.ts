import { createHash, createPublicKey, KeyObject, randomBytes, sign, verify } from 'node:crypto';
import { SDJwtVcInstance, type SdJwtVcPayload } from '@sd-jwt/sd-jwt-vc';
import type * as jose from 'jose';
import type { AgentCard } from '@a2a-js/sdk';
import type { Identity } from './crypto.js';
import { verifyLakeCard } from './card.js';
import { proveDomain } from './domain.js';

/**
 * SD-JWT VCs (RFC 9901, with the IETF SD-JWT VC format the EU Digital Identity Wallet uses): a credential whose claims
 * the holder may show one by one, bound to the holder's key (`cnf`), and presented with a Key Binding JWT naming who
 * it's for and a nonce, so a presentation can't be replayed elsewhere or by anyone else. Ed25519, like every Lake key.
 */

/** A person stamp (SPEC §6.4): one person, the number hidden. */
export const PERSON_VCT = 'https://lake.doneinfifty.com/vct/person';
/** A person stamp for one count: a number that means something in that context only. */
export const PERSON_IN_CONTEXT_VCT = 'https://lake.doneinfifty.com/vct/person-in-context';

/** What a person stamp for one count names: the counter and the count, so a stamp for one is no good at another. */
export const countContext = (counter: string, id: string) => `${counter}|${id}`;

const b64u = (b: Buffer) => b.toString('base64url');
const signer = (id: Identity) => {
  const key = id.privateKey instanceof KeyObject ? id.privateKey : KeyObject.from(id.privateKey as CryptoKey);
  return (data: string) => b64u(sign(null, Buffer.from(data), key));
};
const verifierFor = (jwk: jose.JWK) => {
  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  return (data: string, sig: string) => verify(null, Buffer.from(data), key, Buffer.from(sig, 'base64url'));
};
const common = {
  hasher: (data: string | ArrayBuffer, alg: string) => {
    if (alg !== 'sha-256') throw new Error(`hash ${alg}: only sha-256`);
    return new Uint8Array(createHash('sha256').update(typeof data === 'string' ? data : Buffer.from(data)).digest());
  },
  hashAlg: 'sha-256' as const,
  saltGenerator: (n: number) => b64u(randomBytes(n)),
};
// The public half of a key, as a credential binds it: nothing private, ever.
const publicOnly = (jwk: jose.JWK): jose.JWK => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });

/** Issues an SD-JWT VC: `hidden` claims are selectively disclosable; the rest are always visible. */
export async function issueSdJwtVc(
  claims: { iss: string; sub: string; vct: string; holder: jose.JWK; days: number } & Record<string, unknown>,
  hidden: string[],
  issuer: Identity,
): Promise<string> {
  const { holder, days, ...rest } = claims;
  const now = Math.floor(Date.now() / 1000);
  const sd = new SDJwtVcInstance({ ...common, signer: signer(issuer), signAlg: 'EdDSA' });
  return sd.issue({ ...rest, iat: now, exp: now + days * 86_400, cnf: { jwk: publicOnly(holder) } } as SdJwtVcPayload, hidden.length ? ({ _sd: hidden } as never) : undefined, { header: { kid: issuer.kid } } as never);
}

/** Presents an SD-JWT VC: shows the `reveal`ed claims, with a Key Binding JWT for `aud`, signed by the holder. */
export async function presentSdJwtVc(credential: string, reveal: string[], holder: Identity, kb: { aud: string; nonce: string }): Promise<string> {
  const sd = new SDJwtVcInstance({ ...common, kbSigner: signer(holder), kbSignAlg: 'EdDSA' });
  return sd.present(credential, Object.fromEntries(reveal.map((c) => [c, true])) as never, { kb: { payload: { iat: Math.floor(Date.now() / 1000), aud: kb.aud, nonce: kb.nonce } } });
}

/** The claims a presentation shows, once its issuer's signature, its type, its expiry and its key binding all check out. */
export async function verifySdJwtVc(presentation: string, issuerJwk: jose.JWK, o: { vct: string; aud: string; nonce: string; holder?: jose.JWK }): Promise<Record<string, unknown> & { iss: string; sub?: string; cnf: { jwk: jose.JWK } }> {
  const sd = new SDJwtVcInstance({
    ...common,
    verifier: verifierFor(issuerJwk),
    kbVerifier: (data: string, sig: string, payload: { cnf?: { jwk?: jose.JWK } }) => !!payload.cnf?.jwk && verifierFor(payload.cnf.jwk)(data, sig),
  });
  const { payload } = await sd.verify(presentation, {
    keyBindingNonce: o.nonce, expectedKeyBindingAudience: o.aud, keyBindingMaxAgeSeconds: 600, expectedVct: o.vct,
    allowedIssuerAlgorithms: ['EdDSA'], allowedKeyBindingAlgorithms: ['EdDSA'], disableStatusVerification: true, requiredClaimKeys: ['exp', 'cnf'],
  } as never);
  const p = payload as Record<string, unknown> & { iss: string; sub?: string; cnf: { jwk: jose.JWK } };
  if (!p.cnf?.jwk) throw new Error('not bound to a key');
  // Bound to whoever must hold it: the presenter's own key, not just any key.
  if (o.holder && (p.cnf.jwk.x !== o.holder.x || p.cnf.jwk.crv !== o.holder.crv)) throw new Error('bound to another key');
  return p;
}

/**
 * Checks an SD-JWT VC someone attached, with its issuer's signed card: an issuer this party trusts, proven on its
 * domain, for this subject, bound to the presenter's key, presented to this party for this nonce.
 */
export async function checkSdJwtAttachment(
  att: { credential?: unknown; card?: AgentCard } | undefined,
  o: { trusted: string[]; vct: string; subject: string; holder: jose.JWK; aud: string; nonce: string; sandbox?: boolean },
): Promise<{ ok: true; claims: Record<string, unknown>; domain: string } | { ok: false; why: string }> {
  if (typeof att?.credential !== 'string' || !att.card) return { ok: false, why: `no ${o.vct}` };
  let profile;
  try {
    profile = await verifyLakeCard(att.card);
  } catch (e) {
    return { ok: false, why: `issuer card: ${(e as Error).message}` };
  }
  const domain = profile.ownerDomain.toLowerCase();
  if (!o.trusted.map((d) => d.toLowerCase()).includes(domain)) return { ok: false, why: `issued by ${domain}, which you don't trust` };
  const proof = await proveDomain(profile, { sandbox: o.sandbox });
  if (!proof.ok) return { ok: false, why: proof.reason };
  try {
    const claims = await verifySdJwtVc(att.credential, profile.publicJwk, o);
    if (claims.iss !== profile.webId) return { ok: false, why: 'not issued by its card\'s owner' };
    if (claims.sub !== o.subject) return { ok: false, why: 'issued for someone else' };
    return { ok: true, claims, domain };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

/** Reads an SD-JWT VC's claims as its holder (all disclosures), without checking: for showing an owner what they hold. */
export async function readSdJwtVc(credential: string): Promise<Record<string, unknown>> {
  return (await new SDJwtVcInstance({ ...common }).getClaims(credential)) as Record<string, unknown>;
}
