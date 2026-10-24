import { createHash } from 'node:crypto';
import { publicVerif, Token, TokenChallenge } from '@cloudflare/privacypass-ts';

/**
 * Privacy Pass (RFC 9576 architecture, RFC 9578 issuance; Cloudflare's implementation): anonymous one-time tokens. An
 * issuer signs a token it can't see (blind RSA), so when the token is spent later nobody, the issuer included, can tell
 * whose it was. The Lake uses them for blind pledges (SPEC §11.4): one issuer key per pledge, a token bound to that
 * pledge and that tally, spent once.
 */
const { BlindRSAMode, Issuer, Client, Origin, getPublicKeyBytes, BLIND_RSA } = publicVerif;
const MODE = BlindRSAMode.PSS;
const ALG = { name: 'RSA-PSS', hash: 'SHA-384' };
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

export interface PassKey { publicKey: string; publicJwk: JsonWebKey; privateJwk: JsonWebKey }

/** A fresh issuer key: one per pledge, so a token for one pledge is no good at another. */
export async function newPassKey(): Promise<PassKey> {
  const k = await Issuer.generateKey(MODE, { modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]) });
  return { publicKey: b64(await getPublicKeyBytes(k.publicKey)), publicJwk: await crypto.subtle.exportKey('jwk', k.publicKey), privateJwk: await crypto.subtle.exportKey('jwk', k.privateKey) };
}

/** What a token is for: this issuer, this pledge (as a 32-byte context) and this tally. */
export const passChallenge = (issuer: string, pledge: string, tally: string) =>
  new TokenChallenge(BLIND_RSA.value, issuer, new Uint8Array(createHash('sha256').update(pledge).digest()), [tally]);

/** The client's half: a blinded request to send the issuer, and how to finish the token from its answer. */
export async function requestPass(challenge: TokenChallenge, issuerPublicKey: string) {
  const client = new Client(MODE);
  const request = await client.createTokenRequest(challenge, unb64(issuerPublicKey));
  return { request: b64(request.serialize()), finish: async (response: string) => b64((await client.finalize(publicVerif.TokenResponse.deserialize(unb64(response)))).serialize()) };
}

/** The issuer signs a blinded request: it can't see what it signs. */
export async function issuePass(issuerName: string, key: PassKey, request: string): Promise<string> {
  const [privateKey, publicKey] = await Promise.all([crypto.subtle.importKey('jwk', key.privateJwk, ALG, true, ['sign']), crypto.subtle.importKey('jwk', key.publicJwk, ALG, true, ['verify'])]);
  const issuer = new Issuer(MODE, issuerName, privateKey, publicKey);
  return b64((await issuer.issue(publicVerif.TokenRequest.deserialize(BLIND_RSA, unb64(request)))).serialize());
}

/** A spent token checked: signed by this pledge's issuer key, for exactly this challenge. Its nonce is what can't repeat. */
export async function checkPass(token: string, issuerPublicJwk: JsonWebKey, challenge: TokenChallenge): Promise<{ ok: true; nonce: string } | { ok: false; why: string }> {
  try {
    const t = Token.deserialize(BLIND_RSA, unb64(token));
    const key = await crypto.subtle.importKey('jwk', issuerPublicJwk, ALG, true, ['verify']);
    if (!(await new Origin(MODE, challenge.originInfo).verify(t, key))) return { ok: false, why: 'the pass is not signed by this pledge\'s issuer' };
    const digest = createHash('sha256').update(challenge.serialize()).digest();
    if (!Buffer.from(t.authInput.challengeDigest).equals(digest)) return { ok: false, why: 'the pass is for another pledge or tally' };
    return { ok: true, nonce: b64(t.authInput.nonce) };
  } catch (e) {
    return { ok: false, why: `not a pass: ${(e as Error).message}` };
  }
}

/** A commitment to who you are (or anything), opened later: sha256(value | salt), as lake_commit and the blueprints use. */
export const commitTo = (value: string, salt: string) => createHash('sha256').update(`${value}|${salt}`).digest('hex');
