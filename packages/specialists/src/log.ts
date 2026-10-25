import { appendFile, readFile } from 'node:fs/promises';
import { b64, canonicalize, cardUrlFor, consistencyProof, inclusionProof, leafHash, signCheckpoint, treeRoot, verifyLakeCard, type AgentCard } from '@thelakeprotocol/core';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * The transparency log (SPEC §11.8): an append-only RFC 9162 Merkle tree of signed things (payment receipts, arbiter
 * rulings, published blueprints, anything an agent wants on the record), with signed C2SP checkpoints. Anyone can ask
 * for an entry's inclusion proof, or for proof that today's tree still holds yesterday's (consistency), so a receipt or
 * a ruling can't be quietly rewritten or dropped afterwards. It logs what it's given; it vouches for nothing inside.
 */
const MAX_ENTRY = 64_000;
const PER_HOUR = 60;

export interface Logger { add: (entry: string, kind: string) => Promise<{ index: number; origin: string; checkpoint: string }> }

/** The kinds that count toward an agent's record (log.record): only the payments agent and the arbiter may name them. */
const RECORD_KINDS = ['receipt', 'capture', 'void', 'ruling'];

/**
 * `trust`: the A2A endpoints of the payments agent and the arbiter when they run in processes of their own. Their cards
 * are fetched from there, and only a log.add signed by one of those keys may name a kind that counts toward a record;
 * in-process callers (Logger.add) need no such list. Keys, not names: a card can claim any webId.
 */
export async function createLog(o: SpecialistOptions & { dataDir: string; trust?: string[] }): Promise<Specialist & Logger> {
  const trustedKeys = new Set<string>();
  let fetchedAt = 0;
  const trusted = async (x: unknown) => {
    if (typeof x !== 'string' || !o.trust?.length) return false;
    // A key not known yet may be a trusted agent that restarted with a new one: look again, at most once a minute.
    if (!trustedKeys.has(x) && Date.now() - fetchedAt > 60_000) {
      fetchedAt = Date.now();
      for (const url of o.trust) {
        try {
          trustedKeys.add(String((await verifyLakeCard((await (await fetch(cardUrlFor(url), { signal: AbortSignal.timeout(5000) })).json()) as AgentCard)).publicJwk.x));
        } catch {
          // not up yet: asked again next time
        }
      }
    }
    return trustedKeys.has(x);
  };
  const file = `${o.dataDir}/tlog.jsonl`;
  const entries: { entry: string; kind: string; at: string }[] = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const leaves = entries.map((e) => leafHash(e.entry));
  const byHash = new Map(leaves.map((h, i) => [b64(h), i]));
  const origin = `${o.domain}/log`;
  let checkpoint = { size: -1, note: '' };
  // The signed checkpoint of the tree as it is now, with its size: every proof in one answer is made for that size, so
  // an entry appended meanwhile can't leave a proof and its checkpoint describing different trees.
  const current = async (): Promise<{ size: number; note: string }> => {
    const size = leaves.length;
    if (checkpoint.size !== size) {
      const note = await signCheckpoint(origin, size, treeRoot(leaves.slice(0, size)), o.id);
      if (size > checkpoint.size) checkpoint = { size, note };
      return { size, note };
    }
    return checkpoint;
  };
  // One append at a time: the index is the order of arrival.
  let queue: Promise<unknown> = Promise.resolve();
  const add = (entry: string, kind: string) => (queue = queue.then(async () => {
    const h = leafHash(entry);
    const known = byHash.get(b64(h));
    if (known !== undefined) return { index: known, origin, checkpoint: (await current()).note };
    const at = new Date().toISOString();
    await appendFile(file, `${JSON.stringify({ entry, kind, at })}\n`);
    entries.push({ entry, kind, at });
    leaves.push(h);
    byHash.set(b64(h), leaves.length - 1);
    return { index: leaves.length - 1, origin, checkpoint: (await current()).note };
  })) as Promise<{ index: number; origin: string; checkpoint: string }>;
  // A monitor's question: the proof that the tree of size `from` is a prefix of the tree of `size` (empty when equal).
  const consistent = (from: unknown, size: number) => {
    const m = Number(from);
    return Number.isInteger(m) && m >= 1 && m <= size ? consistencyProof(m, leaves.slice(0, size)).map(b64) : undefined;
  };

  const asked = new Map<string, number[]>();
  const s: Specialist = await specialist<{ kind: string } & Record<string, unknown>>(o, 'Transparency log', `An append-only log anyone can check (RFC 9162 Merkle tree, C2SP signed checkpoints; origin "${origin}"). { kind: "log.add", entry } puts something on the record (a string, or JSON, logged in its canonical form) and returns its index, inclusion proof and the signed checkpoint; { kind: "log.find", entry | leaf_hash, since? } proves an entry is in it (with since, the size of the last checkpoint you accepted, it also proves today's tree extends that one); { kind: "log.consistency", from } proves today's tree still holds the tree of that size; { kind: "log.checkpoint" } is the current one. Payment receipts, arbiter rulings and blueprints a node publishes are logged here. It logs; it vouches for nothing inside.`, 'log', async (p, from, profile) => {
    const proofFor = async (index: number) => {
      const cp = await current();
      const since = consistent(p.since, cp.size);
      return { index, size: cp.size, origin, leaf_hash: b64(leaves[index]!), proof: inclusionProof(index, leaves.slice(0, cp.size)).map(b64), checkpoint: cp.note, ...(since ? { since: Number(p.since), consistency: since } : {}), entry_kind: entries[index]!.kind, at: entries[index]!.at };
    };
    const text = (x: unknown) => (typeof x === 'string' ? x : x === undefined ? '' : canonicalize(x));
    // What the record says about one agent: only entries the payments agent and the arbiter logged themselves count (an
    // agent's own log.add, a node's blueprint included, can't pad it). Facts with counts, not a score.
    if (p.kind === 'log.record') {
      const who = String(p.webId ?? '');
      if (!who) return { kind: 'refused', problems: ['webId: whose record'] };
      const r = { sales: 0, purchases: 0, refunds_given: 0, held_now: 0, rulings: { delivered: 0, not_delivered: 0 } };
      const amounts: Record<string, number> = {};
      // Carts paid to this agent, with their buyers: a plain refund counts only for one of them, paid back to its buyer,
      // once (run 33 had a "refund" on a cart nobody paid).
      const sold = new Map<string, string>();
      const refunded = new Set<string>();
      for (const e of entries) {
        if (e.kind === 'agent') continue;
        let sub: Record<string, any> | undefined;
        try { sub = JSON.parse(Buffer.from(e.entry.split('.')[1] ?? '', 'base64url').toString()).credentialSubject; } catch { continue; }
        if (!sub) continue;
        const paid = (e.kind === 'receipt' || e.kind === 'capture') && sub.settlement === 'simulated';
        // A sale is money released for a cart the seller signed; any other payment isn't one. A plain refund (paid back
        // with order "refund:<cart>") is a refund its payer gave, not a sale to the buyer.
        if (paid && sub.cart && sub.id === who) { sold.set(String(sub.cart.id), String(sub.payer)); r.sales++; amounts[sub.amount?.currency ?? 'USD'] = Math.round(((amounts[sub.amount?.currency ?? 'USD'] ?? 0) + Number(sub.amount?.value ?? 0)) * 100) / 100; }
        if (paid && sub.cart && sub.payer === who) r.purchases++;
        const refundOf = String(sub.agreement ?? '').startsWith('urn:lake:order:refund:') ? String(sub.agreement).slice('urn:lake:order:refund:'.length) : undefined;
        if (paid && !sub.cart && refundOf && sub.payer === who && sold.get(refundOf) === sub.id && !refunded.has(refundOf)) { refunded.add(refundOf); r.refunds_given++; }
        if (e.kind === 'receipt' && sub.settlement === 'held' && sub.id === who) r.held_now++;
        if ((e.kind === 'capture' || e.kind === 'void') && sub.seller === who) r.held_now = Math.max(0, r.held_now - 1);
        if (e.kind === 'void' && sub.seller === who) r.refunds_given++;
        // A ruling counts only on a cart it found paid: one on a cart nobody paid settles nothing (and isn't logged now).
        if (e.kind === 'ruling' && sub.seller === who && sub.paid === true) sub.delivered ? r.rulings.delivered++ : r.rulings.not_delivered++;
      }
      return { kind: 'log.record', webId: who, ...r, sold: amounts, size: leaves.length, note: 'counted from receipts and rulings the payments agent and the arbiter put on this log; nothing an agent added itself' };
    }
    if (p.kind === 'log.checkpoint') { const cp = await current(); return { kind: 'log.checkpoint', origin, size: cp.size, checkpoint: cp.note }; }
    if (p.kind === 'log.add') {
      const entry = text(p.entry);
      if (!entry || entry.length > MAX_ENTRY) return { kind: 'refused', problems: [`entry: 1 to ${MAX_ENTRY} characters (a string, or JSON)`] };
      // Over A2A an entry is 'agent', whoever sends it (a node's blueprints too), unless its sender's key is one this log
      // was told to trust (the payments agent, the arbiter in processes of their own): only those may name a kind that
      // counts toward a record, so nobody else can make an entry count. Those aren't held to the hourly limit either.
      const kind = p.entry_kind === undefined || p.entry_kind === 'agent' ? 'agent' : String(p.entry_kind);
      const vouched = await trusted(profile.publicJwk.x);
      if (kind !== 'agent' && !(RECORD_KINDS.includes(kind) && vouched)) return { kind: 'refused', problems: [`entry_kind: only the payments agent and the arbiter this log trusts may log a ${kind}; leave it out to log as anyone`] };
      if (!vouched) {
        const recent = (asked.get(from) ?? []).filter((t) => Date.now() - t < 3_600_000);
        if (recent.length >= PER_HOUR) return { kind: 'refused', problems: [`at most ${PER_HOUR} entries an hour from one agent`] };
        asked.set(from, [...recent, Date.now()]);
      }
      const { index } = await add(entry, kind);
      return { kind: 'log.added', ...(await proofFor(index)) };
    }
    if (p.kind === 'log.find') {
      const hash = typeof p.leaf_hash === 'string' ? p.leaf_hash : b64(leafHash(text(p.entry)));
      const index = byHash.get(hash);
      if (index !== undefined) return { kind: 'log.found', ...(await proofFor(index)) };
      const cp = await current();
      const since = consistent(p.since, cp.size);
      return { kind: 'log.absent', leaf_hash: hash, size: cp.size, origin, checkpoint: cp.note, ...(since ? { since: Number(p.since), consistency: since } : {}) };
    }
    if (p.kind === 'log.consistency') {
      const cp = await current();
      const proof = consistent(p.from, cp.size);
      if (!proof) return { kind: 'refused', problems: [`from: a size from 1 to ${cp.size}`] };
      return { kind: 'log.consistency', from: Number(p.from), size: cp.size, origin, proof, checkpoint: cp.note };
    }
    return { kind: 'refused', problems: ['send log.add { entry }, log.find { entry | leaf_hash, since? }, log.consistency { from } or log.checkpoint'] };
  }, [], true);
  // Monitors watch the checkpoint without signing anything: the latest one, and (with ?from=<size> of the last one they
  // accepted) the proof that it extends that one, both for the same tree.
  s.app.get('/checkpoint', async (_req, res) => void res.type('text/plain').send((await current()).note));
  s.app.get('/checkpoints', async (req, res) => {
    const cp = await current();
    const from = req.query.from === undefined ? undefined : Number(req.query.from);
    const proof = from === undefined ? undefined : consistent(from, cp.size);
    if (from !== undefined && !proof) return void res.status(400).json({ error: `from: a size from 1 to ${cp.size}` });
    res.json({ origin, size: cp.size, checkpoint: cp.note, ...(proof ? { from, consistency: proof } : {}) });
  });
  return Object.assign(s, { add: (entry: string, kind: string) => add(entry, kind) });
}
