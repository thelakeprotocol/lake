import { Resolver, type DIDDocument, type VerificationMethod } from 'did-resolver';
import { getResolver } from 'web-did-resolver';
import * as jose from 'jose';
import type { LakeProfile } from './card.js';

export type DomainProof = { ok: true; via: 'did:web' | 'did-configuration' | 'sandbox' } | { ok: false; reason: string };

const resolver = new Resolver(getResolver());

/** The did:web DID of a domain (a port is percent-encoded, as did:web writes it). */
export const didWebOf = (domain: string) => `did:web:${domain.toLowerCase().replace(/:/g, '%3A')}`;

const sameKey = (a: jose.JWK | undefined, b: jose.JWK) => !!a && a.kty === b.kty && a.crv === b.crv && a.x === b.x && (a.y ?? null) === (b.y ?? null);

/** The key in a DID document that is this very key and may sign for it (assertionMethod or authentication), if any. */
function keyIn(doc: DIDDocument | null, key: jose.JWK): VerificationMethod | undefined {
  if (!doc) return undefined;
  const ref = (r: string | VerificationMethod) => (typeof r === 'string' ? r : r.id);
  const may = new Set([...(doc.assertionMethod ?? []), ...(doc.authentication ?? [])].map(ref).map((id) => (id.startsWith('#') ? doc.id + id : id)));
  const methods = [...(doc.verificationMethod ?? []), ...[...(doc.assertionMethod ?? []), ...(doc.authentication ?? [])].filter((r): r is VerificationMethod => typeof r !== 'string')];
  return methods.find((vm) => sameKey(vm.publicKeyJwk as jose.JWK | undefined, key) && may.has(vm.id.startsWith('#') ? doc.id + vm.id : vm.id));
}

const resolve = async (did: string) => (await resolver.resolve(did)).didDocument;

/**
 * Checks that the card's key belongs to its claimed owner domain (SPEC §2.3), by the standards for linking a domain to
 * keys: the domain's **did:web** DID document lists this very key, or the domain's **DIF Well-Known DID
 * Configuration** links a DID (with a Domain Linkage Credential that DID signed) whose document lists it. The whole key
 * is compared, never just its name. A sandbox Lake (synthetic data only) skips the check and says so.
 */
export async function proveDomain(profile: LakeProfile, opts: { sandbox?: boolean } = {}): Promise<DomainProof> {
  const domain = profile.ownerDomain.toLowerCase();
  if (opts.sandbox) return { ok: true, via: 'sandbox' };
  const key = profile.publicJwk as jose.JWK;
  try {
    if (keyIn(await resolve(didWebOf(domain)), key)) return { ok: true, via: 'did:web' };
  } catch {
    // no DID document; try the DID Configuration
  }
  try {
    const res = await fetch(`https://${domain}/.well-known/did-configuration.json`, { signal: AbortSignal.timeout(5000) });
    const config = res.ok ? ((await res.json()) as { linked_dids?: unknown[] }) : {};
    for (const jwt of (config.linked_dids ?? []).filter((x): x is string => typeof x === 'string').slice(0, 10)) {
      if (await linksDomain(jwt, domain, key)) return { ok: true, via: 'did-configuration' };
    }
  } catch {
    // unreachable, or not JSON
  }
  return { ok: false, reason: `${domain} does not publish this key (no did:web document or DID Configuration lists it)` };
}

/** A Domain Linkage Credential (JWT): signed by its own DID, for this origin, and that DID's document holds `key`. */
async function linksDomain(jwt: string, domain: string, key: jose.JWK): Promise<boolean> {
  try {
    const { kid } = jose.decodeProtectedHeader(jwt);
    const claims = jose.decodeJwt(jwt) as { iss?: string; sub?: string; vc?: { type?: string[]; credentialSubject?: { id?: string; origin?: string } } };
    const did = claims.iss;
    if (!did || claims.sub !== did || claims.vc?.credentialSubject?.id !== did || !claims.vc?.type?.includes('DomainLinkageCredential')) return false;
    if (claims.vc.credentialSubject.origin?.replace(/\/+$/, '') !== `https://${domain}`) return false;
    const doc = await resolve(did);
    const signer = doc?.verificationMethod?.find((vm) => vm.id === kid || doc.id + (kid ?? '') === vm.id);
    if (!signer?.publicKeyJwk) return false;
    await jose.jwtVerify(jwt, await jose.importJWK(signer.publicKeyJwk as jose.JWK, signer.publicKeyJwk.crv === 'Ed25519' ? 'EdDSA' : undefined));
    return !!keyIn(doc, key);
  } catch {
    return false;
  }
}

/** A did:web DID document for a domain, listing the keys of its agents: what an operator hosts at /.well-known/did.json. */
export function didWebDocument(domain: string, keys: jose.JWK[]): DIDDocument {
  const id = didWebOf(domain);
  const methods = keys.map((k) => ({ id: `${id}#${k.kid}`, type: 'JsonWebKey', controller: id, publicKeyJwk: { kty: k.kty!, crv: k.crv!, x: k.x!, kid: k.kid! } }));
  return { '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/jwk/v1'], id, verificationMethod: methods, assertionMethod: methods.map((m) => m.id), authentication: methods.map((m) => m.id) } as DIDDocument;
}
