import { ed25519 } from '@noble/curves/ed25519.js';

// The owner's key lives on this device only. Pure-JS Ed25519, because phones on a home network
// load this page over plain HTTP, where browsers switch off WebCrypto.

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Same canonical form as @thelakeprotocol/core: sorted keys, no whitespace. */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, x]) => JSON.stringify(k) + ':' + canonicalize(x)).join(',') + '}';
}

export interface OwnerKey { secret: Uint8Array; jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; alg: 'EdDSA' } }

const STORE = `lake-owner-key:${location.host}`;

export function loadKey(): OwnerKey {
  let saved: { secret: string; kid: string } | null = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) ?? 'null'); } catch { /* private mode */ }
  const secret = saved ? unhex(saved.secret) : ed25519.utils.randomSecretKey();
  const kid = saved?.kid ?? `owner-${hex(random(6))}`;
  if (!saved) try { localStorage.setItem(STORE, JSON.stringify({ secret: hex(secret), kid })); } catch { /* the key lives for this tab only */ }
  return { secret, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(ed25519.getPublicKey(secret)), kid, alg: 'EdDSA' } };
}

const sign = (input: string, k: OwnerKey) => b64u(ed25519.sign(enc.encode(input), k.secret));

/** A signed Lake envelope, byte-compatible with core's signMessage. */
export function signEnvelope(payload: Record<string, unknown>, k: OwnerKey, iss: string) {
  const iat = Math.floor(Date.now() / 1000);
  const full = { ...payload, nonce: hex(random(16)), iat, exp: iat + 60, iss };
  const protectedHeader = b64u(enc.encode(JSON.stringify({ alg: 'EdDSA', kid: k.jwk.kid, typ: 'lake+jws' })));
  return { payload: full, jws: { protected: protectedHeader, signature: sign(`${protectedHeader}.${b64u(enc.encode(canonicalize(full)))}`, k) } };
}

/** A W3C VC secured as VC-JOSE (compact JWS), signed on this device. */
export function signCredential(vc: Record<string, unknown>, k: OwnerKey): string {
  const h = b64u(enc.encode(JSON.stringify({ alg: 'EdDSA', kid: k.jwk.kid, typ: 'vc+jwt', cty: 'vc' })));
  const p = b64u(enc.encode(JSON.stringify(vc)));
  return `${h}.${p}.${sign(`${h}.${p}`, k)}`;
}
