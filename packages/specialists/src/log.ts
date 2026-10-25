import { appendFile, readFile } from 'node:fs/promises';
import { b64, canonicalize, consistencyProof, inclusionProof, leafHash, signCheckpoint, treeRoot } from '@thelakeprotocol/core';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * The transparency log (SPEC §11.8): an append-only RFC 9162 Merkle tree of signed things (payment receipts, arbiter
 * rulings, anything an agent wants on the record), with signed C2SP checkpoints. Anyone can ask for an entry's
 * inclusion proof, or for proof that today's tree still holds yesterday's (consistency), so a receipt or a ruling can't
 * be quietly rewritten or dropped afterwards. It logs what it's given; it vouches for nothing inside.
 */
const MAX_ENTRY = 64_000;
const PER_HOUR = 60;

export interface Logger { add: (entry: string, kind: string) => Promise<{ index: number; origin: string; checkpoint: string }> }

export async function createLog(o: SpecialistOptions & { dataDir: string }): Promise<Specialist & Logger> {
  const file = `${o.dataDir}/tlog.jsonl`;
  const entries: { entry: string; kind: string; at: string }[] = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const leaves = entries.map((e) => leafHash(e.entry));
  const byHash = new Map(leaves.map((h, i) => [b64(h), i]));
  const origin = `${o.domain}/log`;
  let checkpoint = { size: -1, note: '' };
  const current = async () => {
    if (checkpoint.size !== leaves.length) checkpoint = { size: leaves.length, note: await signCheckpoint(origin, leaves.length, treeRoot(leaves), o.id) };
    return checkpoint.note;
  };
  // One append at a time: the index is the order of arrival.
  let queue: Promise<unknown> = Promise.resolve();
  const add = (entry: string, kind: string) => (queue = queue.then(async () => {
    const h = leafHash(entry);
    const known = byHash.get(b64(h));
    if (known !== undefined) return { index: known, origin, checkpoint: await current() };
    const at = new Date().toISOString();
    await appendFile(file, `${JSON.stringify({ entry, kind, at })}\n`);
    entries.push({ entry, kind, at });
    leaves.push(h);
    byHash.set(b64(h), leaves.length - 1);
    return { index: leaves.length - 1, origin, checkpoint: await current() };
  })) as Promise<{ index: number; origin: string; checkpoint: string }>;

  const asked = new Map<string, number[]>();
  const s: Specialist = await specialist<{ kind: string } & Record<string, unknown>>(o, 'Transparency log', `An append-only log anyone can check (RFC 9162 Merkle tree, C2SP signed checkpoints; origin "${origin}"). { kind: "log.add", entry } puts something on the record (a string, or JSON, logged in its canonical form) and returns its index, inclusion proof and the signed checkpoint; { kind: "log.find", entry | leaf_hash } proves an entry is in it; { kind: "log.consistency", from } proves today's tree still holds the tree of that size; { kind: "log.checkpoint" } is the current one. Payment receipts and arbiter rulings are logged here as they are made. It logs; it vouches for nothing inside.`, 'log', async (p, from) => {
    const proofFor = async (index: number) => ({ index, size: leaves.length, leaf_hash: b64(leaves[index]!), proof: inclusionProof(index, leaves).map(b64), checkpoint: await current(), entry_kind: entries[index]!.kind, at: entries[index]!.at });
    const text = (x: unknown) => (typeof x === 'string' ? x : x === undefined ? '' : canonicalize(x));
    // What the record says about one agent: only entries the payments agent and the arbiter logged themselves count (an
    // agent's own log.add can't pad it). Facts with counts, not a score.
    if (p.kind === 'log.record') {
      const who = String(p.webId ?? '');
      if (!who) return { kind: 'refused', problems: ['webId: whose record'] };
      const r = { sales: 0, purchases: 0, refunds_given: 0, held_now: 0, rulings: { delivered: 0, not_delivered: 0 } };
      const amounts: Record<string, number> = {};
      for (const e of entries) {
        if (e.kind === 'agent') continue;
        let sub: Record<string, any> | undefined;
        try { sub = JSON.parse(Buffer.from(e.entry.split('.')[1] ?? '', 'base64url').toString()).credentialSubject; } catch { continue; }
        if (!sub) continue;
        if ((e.kind === 'receipt' || e.kind === 'capture') && sub.settlement === 'simulated' && sub.id === who) { r.sales++; amounts[sub.amount?.currency ?? 'USD'] = Math.round(((amounts[sub.amount?.currency ?? 'USD'] ?? 0) + Number(sub.amount?.value ?? 0)) * 100) / 100; }
        if ((e.kind === 'receipt' || e.kind === 'capture') && sub.settlement === 'simulated' && sub.payer === who) r.purchases++;
        if (e.kind === 'receipt' && sub.settlement === 'held' && sub.id === who) r.held_now++;
        if ((e.kind === 'capture' || e.kind === 'void') && sub.seller === who) r.held_now = Math.max(0, r.held_now - 1);
        if (e.kind === 'void' && sub.seller === who) r.refunds_given++;
        if (e.kind === 'ruling' && sub.seller === who) sub.delivered ? r.rulings.delivered++ : r.rulings.not_delivered++;
      }
      return { kind: 'log.record', webId: who, ...r, sold: amounts, size: leaves.length, note: 'counted from receipts and rulings the payments agent and the arbiter put on this log; nothing an agent added itself' };
    }
    if (p.kind === 'log.checkpoint') return { kind: 'log.checkpoint', origin, size: leaves.length, checkpoint: await current() };
    if (p.kind === 'log.add') {
      const entry = text(p.entry);
      if (!entry || entry.length > MAX_ENTRY) return { kind: 'refused', problems: [`entry: 1 to ${MAX_ENTRY} characters (a string, or JSON)`] };
      const recent = (asked.get(from) ?? []).filter((t) => Date.now() - t < 3_600_000);
      if (recent.length >= PER_HOUR) return { kind: 'refused', problems: [`at most ${PER_HOUR} entries an hour from one agent`] };
      asked.set(from, [...recent, Date.now()]);
      const { index } = await add(entry, 'agent');
      return { kind: 'log.added', ...(await proofFor(index)) };
    }
    if (p.kind === 'log.find') {
      const hash = typeof p.leaf_hash === 'string' ? p.leaf_hash : b64(leafHash(text(p.entry)));
      const index = byHash.get(hash);
      return index === undefined ? { kind: 'log.absent', leaf_hash: hash, size: leaves.length, checkpoint: await current() } : { kind: 'log.found', ...(await proofFor(index)) };
    }
    if (p.kind === 'log.consistency') {
      const m = Number(p.from);
      if (!Number.isInteger(m) || m < 1 || m > leaves.length) return { kind: 'refused', problems: [`from: a size from 1 to ${leaves.length}`] };
      return { kind: 'log.consistency', from: m, size: leaves.length, proof: consistencyProof(m, leaves).map(b64), checkpoint: await current() };
    }
    return { kind: 'refused', problems: ['send log.add { entry }, log.find { entry | leaf_hash }, log.consistency { from } or log.checkpoint'] };
  }, [], true);
  // Monitors watch the checkpoint without signing anything.
  s.app.get('/checkpoint', async (_req, res) => void res.type('text/plain').send(await current()));
  return Object.assign(s, { add: (entry: string, kind: string) => add(entry, kind) });
}
