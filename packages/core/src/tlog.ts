import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import * as jose from 'jose';
import type { AgentCard } from '@a2a-js/sdk';
import { signMessage, type Identity } from './crypto.js';
import { verifyLakeData, type LakeData } from './a2a.js';
import { sendLake } from './agent.js';

/**
 * A transparency log (SPEC §11.8): an append-only Merkle tree of signed things (receipts, rulings, blueprints), so
 * anyone can check one was logged and that the log was never rewritten. The tree, its hashes and its proofs are RFC 9162
 * (Certificate Transparency v2): a leaf hashes as SHA-256(0x00 ‖ entry), a node as SHA-256(0x01 ‖ left ‖ right),
 * with inclusion and consistency proofs as its §2.1.3 and §2.1.4 define them. The log's word for its current size and
 * root is a checkpoint in C2SP's signed-note format (the one Go's checksum database and Sigstore's Rekor v2 use):
 * "<origin>\n<size>\n<base64 root>\n", signed with Ed25519.
 *
 * Monitors keep the last checkpoint they accepted from a log and take a later one only with a consistency proof from it
 * (followCheckpoint), so a log can't rewrite or fork its history without someone who watched noticing.
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

/** What a monitor remembers of a log: the last checkpoint it accepted from it (root in base64, so it stores as JSON). */
export interface SeenCheckpoint { origin: string; size: number; root: string }

/**
 * One step of watching a log, as RFC 9162's monitors do: checks a newly signed checkpoint against the last one accepted
 * from the same log, and returns the one to remember now. A log that shows anyone a tree which doesn't extend what it
 * signed before has rewritten its history, or shows different people different histories (a fork): the signature alone
 * can't tell, only the consistency proof between the two can. `consistency` is the log's proof from `last.size` to the
 * new checkpoint's size (`log.consistency { from }`, or `log.find { since }`). Throws, plainly, why the new one can't
 * be trusted. The first checkpoint seen from a log is taken on its signature (trust on first use).
 */
export function followCheckpoint(last: SeenCheckpoint | undefined, note: string, publicJwk: jose.JWK, consistency?: string[] | Uint8Array[]): SeenCheckpoint {
  const cp = verifyCheckpoint(note, publicJwk, last?.origin);
  const next = { origin: cp.origin, size: cp.size, root: b64(cp.root) };
  if (!last || last.size === 0) return next;
  if (cp.size < last.size) throw new Error(`the log now shows ${cp.size} entries, fewer than the ${last.size} it signed before: it has been rolled back`);
  if (cp.size === last.size) {
    if (next.root !== last.root) throw new Error(`the log signed two different trees of size ${cp.size}: it has forked`);
    return last;
  }
  if (!consistency) throw new Error(`no consistency proof from the tree of size ${last.size} it signed before`);
  const proof = consistency.map((p) => (typeof p === 'string' ? unb64(p) : p));
  if (!verifyConsistency(last.size, cp.size, unb64(last.root), cp.root, proof)) throw new Error(`the tree of size ${cp.size} does not extend the tree of size ${last.size} it signed before: the log has been rewritten or forked`);
  return next;
}

/** One log's `log.record` answer about one agent (SPEC §11.8). */
export interface LogRecord {
  origin: string; sales: number; purchases: number; refunds_given: number; held_now: number; sold: Record<string, number>;
  /** Held sales, by how the money was released: the buyer accepted, nobody answered in time, or a ruling that it arrived. */
  released: { accepted: number; review_expired: number; ruling: number };
  /**
   * Disputes of this agent's deliveries and how each ended (a revision is the good sign); changes a buyer asked for are
   * counted apart, as they aren't disputes. A ruling's "delivered" was never a merit (run 36), so rulings aren't counted.
   */
  disputes: { against: number; ended: { revision: number; refund: number; ruling: number; accepted: number }; changes_requested: number };
  /** Disputes this agent raised as a buyer: a serial disputer shows too. */
  disputes_raised: number;
}

/** A record with nothing on it. */
export const emptyRecord = (): Omit<LogRecord, 'origin'> => ({ sales: 0, purchases: 0, refunds_given: 0, held_now: 0, sold: {}, released: { accepted: 0, review_expired: 0, ruling: 0 }, disputes: { against: 0, ended: { revision: 0, refund: 0, ruling: 0, accepted: 0 }, changes_requested: 0 }, disputes_raised: 0 });

/**
 * One agent's record across the logs of several Lakes (SPEC §11.8). Across Lakes a record is spread: a buyer pays through
 * its own Lake's payments agent, which logs the receipt on its own Lake's log, and a ruling is on the log of the arbiter's
 * Lake. Each payments agent and arbiter logs what it signs on one log, so each fact is on one log and the counts add up;
 * a log answering twice (the same origin, reached through two Lakes) counts once. `logs` says which logs were counted.
 */
export function sumRecords(records: LogRecord[]): Omit<LogRecord, 'origin'> & { logs: string[] } {
  const seen = new Set<string>();
  const out = { ...emptyRecord(), logs: [] as string[] };
  for (const r of records) {
    if (seen.has(r.origin)) continue;
    seen.add(r.origin);
    out.logs.push(r.origin);
    out.sales += r.sales;
    out.purchases += r.purchases;
    out.refunds_given += r.refunds_given;
    out.held_now += r.held_now;
    for (const [cur, v] of Object.entries(r.sold ?? {})) out.sold[cur] = Math.round(((out.sold[cur] ?? 0) + v) * 100) / 100;
    for (const k of ['accepted', 'review_expired', 'ruling'] as const) out.released[k] += r.released?.[k] ?? 0;
    for (const k of ['revision', 'refund', 'ruling', 'accepted'] as const) out.disputes.ended[k] += r.disputes?.ended?.[k] ?? 0;
    out.disputes.against += r.disputes?.against ?? 0;
    out.disputes.changes_requested += r.disputes?.changes_requested ?? 0;
    out.disputes_raised += r.disputes_raised ?? 0;
  }
  return out;
}

/** The log answered, and said no (too big, too many this hour, a kind it won't take from this sender). */
export class LogRefused extends Error {}

/**
 * Puts an entry on a transparency log that runs elsewhere, over A2A, as `me` (`log.add`): the way a node logs the
 * blueprints published on it, and a payments agent or an arbiter in a process of its own logs what it signs. `kind`
 * (receipt, capture, void, ruling) is honoured only from senders the log was told to trust; to anyone else it's refused.
 * The log's inclusion proof is checked under its signed checkpoint before this says where the entry is. Throws why not.
 */
export async function addToLog(logUrl: string, entry: string, me: { id: Identity; card: AgentCard; webId: string }, o: { kind?: string; sandbox?: boolean; timeoutMs?: number } = {}): Promise<{ index: number; origin: string; checkpoint: string }> {
  const envelope = await signMessage({ kind: 'log.add', entry, ...(o.kind ? { entry_kind: o.kind } : {}) }, me.id, { iss: me.webId });
  const reply = await sendLake(logUrl, { lake: '0.1', card: me.card, envelope: envelope as LakeData['envelope'] }, { me: me.id, timeoutMs: o.timeoutMs ?? 10_000 });
  const v = await verifyLakeData<Record<string, any>>(reply as LakeData<Record<string, any>>, { sandbox: o.sandbox });
  if (!v.ok) throw new Error(`the log's reply does not verify: ${v.rejection.why}`);
  const r = v.payload;
  if (r.kind !== 'log.added') throw new LogRefused(`the log refused it: ${((r.problems as string[] | undefined) ?? []).join('; ') || r.kind}`);
  const cp = verifyCheckpoint(String(r.checkpoint ?? ''), v.profile.publicJwk);
  if (cp.size !== r.size || !verifyInclusion(leafHash(entry), r.index, r.size, ((r.proof as string[] | undefined) ?? []).map(unb64), cp.root)) throw new Error('the log\'s inclusion proof does not check');
  return { index: r.index, origin: cp.origin, checkpoint: r.checkpoint };
}
