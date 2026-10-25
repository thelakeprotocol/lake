import { createHash, randomUUID } from 'node:crypto';
import * as jose from 'jose';
import { canonicalize } from './canonical.js';

export type PrivateKey = jose.CryptoKey | jose.KeyObject | jose.JWK;

export interface Identity {
  /** Key id; also the fragment of the key inside the owner's WebID profile. */
  kid: string;
  privateKey: PrivateKey;
  publicJwk: jose.JWK;
}

const ALG = 'EdDSA';

export async function generateIdentity(kid: string = randomUUID()): Promise<Identity> {
  const { privateKey, publicKey } = await jose.generateKeyPair(ALG, { crv: 'Ed25519', extractable: true });
  const publicJwk = { ...(await jose.exportJWK(publicKey)), kid, alg: ALG };
  return { kid, privateKey, publicJwk };
}

export async function exportIdentity(id: Identity): Promise<{ kid: string; privateJwk: jose.JWK; publicJwk: jose.JWK }> {
  const privateJwk = { ...(await jose.exportJWK(id.privateKey as jose.CryptoKey)), kid: id.kid, alg: ALG };
  return { kid: id.kid, privateJwk, publicJwk: id.publicJwk };
}

export async function importIdentity(saved: { kid: string; privateJwk: jose.JWK; publicJwk: jose.JWK }): Promise<Identity> {
  // Extractable, like a fresh one: sealed messages are opened with the X25519 twin of this key, worked out from it (SPEC §3).
  return { kid: saved.kid, privateKey: (await jose.importJWK(saved.privateJwk, ALG, { extractable: true })) as jose.CryptoKey, publicJwk: saved.publicJwk };
}

/** A signed Lake message: the payload plus a detached-free flattened JWS over its canonical form. */
export interface Signed<T> {
  payload: T & { nonce: string; iat: number; exp: number; iss: string };
  jws: { protected: string; signature: string };
}

export interface SignOptions {
  /** Who signs: a WebID or agent card URL. */
  iss: string;
  /** Seconds until the message expires. Default 300. */
  ttl?: number;
  /** Override the clock (ms since epoch); used by seeded demo runs. */
  now?: number;
}

/** The envelope's own fields. A payload can't use them: they'd be overwritten, and the sender's value silently lost. */
export const RESERVED_FIELDS = ['nonce', 'iat', 'exp', 'iss'] as const;

export async function signMessage<T extends object>(payload: T, id: Identity, opts: SignOptions): Promise<Signed<T>> {
  const taken = RESERVED_FIELDS.filter((f) => f in payload);
  if (taken.length) throw new Error(`"${taken.join('", "')}" ${taken.length > 1 ? 'are' : 'is'} reserved for the signed envelope; call your field something else (e.g. salt)`);
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const full = { ...payload, nonce: randomUUID(), iat, exp: iat + (opts.ttl ?? 300), iss: opts.iss };
  const jws = await new jose.FlattenedSign(new TextEncoder().encode(canonicalize(full)))
    .setProtectedHeader({ alg: ALG, kid: id.kid, typ: 'lake+jws' })
    .sign(id.privateKey);
  return { payload: full, jws: { protected: jws.protected!, signature: jws.signature } };
}

export type KeyResolver = (kid: string, iss: string) => Promise<PrivateKey | jose.JWK | null>;

export class SignatureError extends Error {
  constructor(public readonly code: 'bad-signature' | 'unknown-key' | 'expired' | 'replayed' | 'malformed', message: string) {
    super(message);
  }
}

/**
 * Verifies a signed message: signature, expiry and (if a guard is given) replay.
 * Throws SignatureError; never returns a payload it could not verify.
 */
export async function verifyMessage<T>(msg: Signed<T>, resolveKey: KeyResolver, opts: { now?: number; replay?: ReplayGuard } = {}): Promise<Signed<T>['payload']> {
  if (!msg?.payload || !msg.jws?.protected || !msg.jws.signature) throw new SignatureError('malformed', 'message is not a signed Lake message');
  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(msg.jws);
  } catch {
    throw new SignatureError('malformed', 'unreadable JWS header');
  }
  if (header.alg !== ALG || !header.kid) throw new SignatureError('malformed', 'unsupported JWS header');
  const key = await resolveKey(header.kid, msg.payload.iss);
  if (!key) throw new SignatureError('unknown-key', `no key ${header.kid} for ${msg.payload.iss}`);
  const keyLike = 'kty' in (key as object) ? await jose.importJWK(key as jose.JWK, ALG) : (key as jose.CryptoKey);
  try {
    await jose.flattenedVerify(
      { protected: msg.jws.protected, signature: msg.jws.signature, payload: jose.base64url.encode(canonicalize(msg.payload)) },
      keyLike,
    );
  } catch {
    throw new SignatureError('bad-signature', 'signature does not match the message');
  }
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (msg.payload.exp < now) throw new SignatureError('expired', 'message expired');
  if (opts.replay && !opts.replay.accept(msg.payload.nonce, msg.payload.exp, now, messageDigest(msg))) throw new SignatureError('replayed', 'nonce already seen');
  return msg.payload;
}

/**
 * A signed message's fingerprint: its canonical payload and its signature, nothing else. The same message re-serialised,
 * re-sealed or carried by another hop has the same one; a message changed in any way, or re-signed, has another.
 */
export function messageDigest(msg: Signed<unknown>): string {
  return createHash('sha256').update(canonicalize({ payload: msg.payload, jws: { protected: msg.jws.protected, signature: msg.jws.signature } })).digest('base64url');
}

/** Remembers nonces until they expire, so a captured message cannot be acted on twice. */
export class ReplayGuard {
  private seen = new Map<string, { exp: number; digest?: string }>();
  accept(nonce: string, exp: number, now = Math.floor(Date.now() / 1000), digest?: string): boolean {
    if (this.seen.size > 10_000) for (const [n, e] of this.seen) if (e.exp < now) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, { exp, digest });
    return true;
  }
  /** Whether this very message (not just its nonce) passed verification here: the one a repeat may be answered for (SPEC §3). */
  accepted(msg: Signed<unknown>): boolean {
    const e = msg?.payload?.nonce ? this.seen.get(msg.payload.nonce) : undefined;
    return !!e?.digest && e.digest === messageDigest(msg);
  }
}
