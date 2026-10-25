import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import * as jose from 'jose';
import type { Identity } from './crypto.js';

/**
 * A transparency log (SPEC §11.8): an append-only Merkle tree of signed things (receipts, rulings, blueprints), so
 * anyone can check one was logged and that the log was never rewritten. The tree, its hashes and its proofs are RFC 9162
 * (Certificate Transparency v2): a leaf hashes as SHA-256(0x00 ‖ entry), a node as SHA-256(0x01 ‖ left ‖ right),
 * with inclusion and consistency proofs as its §2.1.3 and §2.1.4 define them. The log's word for its current size and
 * root is a checkpoint in C2SP's signed-note format (the one Go's checksum database and Sigstore's Rekor v2 use):
 * "<origin>\n<size>\n<base64 root>\n", signed with Ed25519.
 *
 * SCITT (the IETF's supply-chain transparency work) puts the same trees behind COSE envelopes; those are still drafts,
 * so entries here stay the Lake's own signed objects.
 */
const sha256 = (...parts: Uint8Array[]) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return new Uint8Array(h.digest()); };
const LEAF = Uint8Array.of(0), NODE = Uint8Array.of(1);

/** The hash of one entry, as a leaf. */
export const leafHash = (entry: Uint8Array | string) => sha256(LEAF, typeof entry === 'string' ? new TextEncoder().encode(entry) : entry);
const nodeHash = (l: Uint8Array, r: Uint8Array) => sha256(NODE, l, r);
// The largest power of two smaller than n (RFC 9162 §2.1.1's k).
const split = (n: number) => { let k = 1; while (k * 2 < n) k *= 2; return k; };

/** The root of a tree over these leaf hashes (RFC 9162 §2.1.1; the empty tree's root is SHA-256 of nothing). */
export function treeRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256();
  if (leaves.length === 1) return leaves[0]!;
  const k = split(leaves.length);
  return nodeHash(treeRoot(leaves.slice(0, k)), treeRoot(leaves.slice(k)));
}

/** The audit path for leaf `index` in the tree over `leaves` (RFC 9162 §2.1.3.1). */
export function inclusionProof(index: number, leaves: Uint8Array[]): Uint8Array[] {
  if (index < 0 || index >= leaves.length) throw new Error('no such leaf');
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k ? [...inclusionProof(index, leaves.slice(0, k)), treeRoot(leaves.slice(k))] : [...inclusionProof(index - k, leaves.slice(k)), treeRoot(leaves.slice(0, k))];
}

/** Checks an audit path against a root (RFC 9162 §2.1.3.2). */
export function verifyInclusion(leaf: Uint8Array, index: number, size: number, proof: Uint8Array[], root: Uint8Array): boolean {
  if (index < 0 || index >= size) return false;
  let fn = index, sn = size - 1, r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else r = nodeHash(r, p);
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && equal(r, root);
}

/** The consistency proof between the first `m` leaves and all of them (RFC 9162 §2.1.4.1). */
export function consistencyProof(m: number, leaves: Uint8Array[]): Uint8Array[] {
  if (m < 1 || m > leaves.length) throw new Error('bad sizes');
  const sub = (m2: number, d: Uint8Array[], whole: boolean): Uint8Array[] => {
    if (m2 === d.length) return whole ? [] : [treeRoot(d)];
    const k = split(d.length);
    return m2 <= k ? [...sub(m2, d.slice(0, k), whole), treeRoot(d.slice(k))] : [...sub(m2 - k, d.slice(k), false), treeRoot(d.slice(0, k))];
  };
  return sub(m, leaves, true);
}

/** Checks that the tree of size `m` with root `first` is a prefix of the one of size `n` with root `second` (§2.1.4.2). */
export function verifyConsistency(m: number, n: number, first: Uint8Array, second: Uint8Array, proof: Uint8Array[]): boolean {
  if (m < 1 || m > n) return false;
  if (m === n) return proof.length === 0 && equal(first, second);
  let p = proof;
  if ((m & (m - 1)) === 0) p = [first, ...p];
  if (!p.length) return false;
  let fn = m - 1, sn = n - 1;
  while (fn % 2 === 1) { fn >>= 1; sn >>= 1; }
  let fr = p[0]!, sr = p[0]!;
  for (const c of p.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr); sr = nodeHash(c, sr);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else sr = nodeHash(sr, c);
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && equal(fr, first) && equal(sr, second);
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
export const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/**
 * A checkpoint, as a C2SP signed note: the body "<origin>\n<size>\n<base64 root>\n", a blank line, then
 * "— <key name> <base64(4-byte key hash ‖ Ed25519 signature)>\n". The key hash is the first four bytes of
 * SHA-256(<key name> ‖ "\n" ‖ 0x01 ‖ public key), as the note format defines for Ed25519.
 */
export async function signCheckpoint(origin: string, size: number, root: Uint8Array, id: Identity): Promise<string> {
  const body = `${origin}\n${size}\n${b64(root)}\n`;
  const pub = jose.base64url.decode(String(id.publicJwk.x));
  const keyHash = sha256(new TextEncoder().encode(`${origin}\n`), Uint8Array.of(1), pub).slice(0, 4);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', id.privateKey as CryptoKey, new TextEncoder().encode(body)));
  return `${body}\n— ${origin} ${b64(new Uint8Array([...keyHash, ...sig]))}\n`;
}

/** Reads a checkpoint and checks its signature by this public key (an Ed25519 JWK). Throws why not. */
export function verifyCheckpoint(note: string, publicJwk: jose.JWK, origin?: string): { origin: string; size: number; root: Uint8Array } {
  const at = note.indexOf('\n\n');
  if (at < 0) throw new Error('not a signed note');
  const body = note.slice(0, at + 1);
  const [o, size, root] = body.split('\n');
  if (!o || !size || !root || !/^\d+$/.test(size)) throw new Error('not a checkpoint');
  if (origin && o !== origin) throw new Error(`a checkpoint of ${o}, not ${origin}`);
  const pub = jose.base64url.decode(String(publicJwk.x));
  const keyHash = sha256(new TextEncoder().encode(`${o}\n`), Uint8Array.of(1), pub).slice(0, 4);
  const line = note.slice(at + 2).split('\n').find((l) => l.startsWith(`— ${o} `));
  if (!line) throw new Error('no signature by the log');
  const sig = unb64(line.slice(`— ${o} `.length));
  if (!equal(sig.slice(0, 4), keyHash)) throw new Error('signed with another key');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: String(publicJwk.x) }, format: 'jwk' });
  if (!nodeVerify(null, Buffer.from(body), key, Buffer.from(sig.slice(4)))) throw new Error('the checkpoint signature does not verify');
  return { origin: o, size: Number(size), root: unb64(root) };
}
