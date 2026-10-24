import { ed25519 } from '@noble/curves/ed25519.js';
import * as jose from 'jose';
import type { AgentCard } from '@a2a-js/sdk';
import { exportIdentity, type Identity } from './crypto.js';
import { lakeProfile } from './card.js';
import type { LakeData } from './a2a.js';

/**
 * Sealed Lake messages (SPEC §3): a signed message travels encrypted to its recipient, so whatever carries it (a
 * node relaying to a house behind a home router, a proxy, a log) can't read it, or see who sent it. The signed
 * envelope and the sender's card go inside a JWE (RFC 7516: ECDH-ES+A256KW, A256GCM) for the recipient's key; once
 * opened, it is the same signed message as ever, so it can still be forwarded as evidence.
 *
 * The recipient's encryption key is the X25519 twin of the Ed25519 key on its signed card (the conversion did:key and
 * libsodium use), so a card needs nothing new, and a key a card doesn't vouch for can't be slipped in.
 */
export interface Sealed { lake: '0.2'; sealed: string }

const ALG = 'ECDH-ES+A256KW';
const ENC = 'A256GCM';
const b64u = (u: Uint8Array) => Buffer.from(u).toString('base64url');

/** The X25519 public key that goes with an Ed25519 public key. */
export function encryptionKeyOf(signingJwk: jose.JWK): jose.JWK {
  if (signingJwk.kty !== 'OKP' || signingJwk.crv !== 'Ed25519' || !signingJwk.x) throw new Error('an Ed25519 key is needed to seal to');
  return { kty: 'OKP', crv: 'X25519', x: b64u(ed25519.utils.toMontgomery(Buffer.from(signingJwk.x, 'base64url'))), kid: signingJwk.kid };
}

const opening = new WeakMap<Identity, Promise<jose.CryptoKey | Uint8Array>>();
/** The X25519 private key that goes with an identity's Ed25519 key, worked out once. */
function openingKey(me: Identity) {
  let k = opening.get(me);
  if (!k) {
    k = exportIdentity(me).then(({ privateJwk }) => {
      const d = ed25519.utils.toMontgomerySecret(Buffer.from(privateJwk.d!, 'base64url'));
      return jose.importJWK({ ...encryptionKeyOf(me.publicJwk), d: b64u(d) }, ALG);
    });
    opening.set(me, k);
  }
  return k;
}

/** Seals a signed Lake message for the agent whose signed card is `to`. */
export async function sealLake(data: LakeData, to: AgentCard): Promise<Sealed> {
  const key = lakeProfile(to)?.publicJwk;
  if (!key) throw new Error('the recipient\'s card has no Lake key to seal to');
  const jwe = await new jose.CompactEncrypt(new TextEncoder().encode(JSON.stringify(data)))
    .setProtectedHeader({ alg: ALG, enc: ENC, kid: key.kid, cty: 'lake+json' })
    .encrypt(await jose.importJWK(encryptionKeyOf(key), ALG));
  return { lake: '0.2', sealed: jwe };
}

/** Opens a message sealed for `me`; throws if it wasn't sealed for this key or was changed on the way. */
export async function openLake(msg: Sealed, me: Identity): Promise<LakeData> {
  const { plaintext } = await jose.compactDecrypt(msg.sealed, await openingKey(me), { keyManagementAlgorithms: [ALG], contentEncryptionAlgorithms: [ENC] });
  return JSON.parse(new TextDecoder().decode(plaintext)) as LakeData;
}

export const isSealed = (x: unknown): x is Sealed => !!x && typeof x === 'object' && (x as Sealed).lake === '0.2' && typeof (x as Sealed).sealed === 'string';
