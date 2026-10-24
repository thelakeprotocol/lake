import { randomBytes } from 'node:crypto';
import type { AgentCard } from '@a2a-js/sdk';
import { Prio3Histogram } from '@divviup/prio3';

/**
 * Counting without looking (SPEC §11.5), the IETF way: the Distributed Aggregation Protocol (DAP) with the Prio3
 * histogram VDAF, from ISRG's Divvi Up implementation. Each participant splits its one true answer (one cell of a table)
 * into two shares, one for each of two tellers run by different parties: the Leader and the Helper. Each share alone
 * says nothing. Each answer carries a proof that it is one cell and nothing else; the two tellers check it together
 * without seeing the answer, and drop the ones that fail. Each teller publishes one aggregate share, once, over at
 * least a minimum batch of answers; the two add up to the exact table.
 *
 * Generic: studies use it for their tables; anything that needs a total and not the parts (a vote, a benchmark,
 * demand in a group) can too.
 */

/** A teller, as a count or a study names it: where to send shares, and whose signed card must answer there. */
export interface TellerRef { url: string; domain: string }

/** The VDAF behind a count of `length` cells. (Draft VDAF-08, as @divviup/prio3 0.8 implements it.) */
export const histogram = (length: number) => new Prio3Histogram({ length, chunkLength: Math.max(1, Math.round(Math.sqrt(length))), shares: 2 });

/** The library's values (big integers and bytes) as plain JSON, and back: what goes over the wire. */
export const toWire = (x: unknown): unknown =>
  typeof x === 'bigint' ? { $n: x.toString() } : Buffer.isBuffer(x) || x instanceof Uint8Array ? { $b: Buffer.from(x).toString('base64') }
  : Array.isArray(x) ? x.map(toWire) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toWire(v)])) : x;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fromWire = (x: unknown): any =>
  Array.isArray(x) ? x.map(fromWire) : x && typeof x === 'object'
    ? ('$n' in x ? BigInt((x as { $n: string }).$n) : '$b' in x ? Buffer.from((x as { $b: string }).$b, 'base64') : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fromWire(v)])))
    : x;

/** A participant's answer (the index of its cell), as one report with a share for each teller. */
export async function shardAnswer(length: number, cell: number) {
  const v = histogram(length);
  const nonce = randomBytes(v.nonceSize);
  const { publicShare, inputShares } = await v.shard(cell, nonce, randomBytes(v.randSize));
  // DAP calls the nonce the report ID (and a Lake envelope keeps the word nonce for itself).
  return { reportId: nonce.toString('base64'), publicShare: toWire(publicShare), shares: inputShares.map(toWire) as [unknown, unknown] };
}

/** A fresh key the two tellers share, so they can check proofs together. Never leaves the two of them. */
export const newVerifyKey = (length: number) => randomBytes(histogram(length).verifyKeySize).toString('base64');

/** One teller's first step on one report: its view of the proof, to compare with the other teller's. */
export async function prepareReport(length: number, verifyKey: string, aggregatorId: 0 | 1, report: { reportId: string; publicShare: unknown; share: unknown }) {
  const r = await histogram(length).prepareInit(Buffer.from(verifyKey, 'base64'), aggregatorId, null, Buffer.from(report.reportId, 'base64'), fromWire(report.publicShare), fromWire(report.share));
  return { state: toWire(r.preparationState), share: toWire(r.preparationShare) };
}

/** Both tellers' views of one report's proof: the message that finishes it, or null when the answer isn't one valid cell. */
export async function settleReport(length: number, shares: [unknown, unknown]): Promise<unknown | null> {
  try {
    return toWire(await histogram(length).unshardPreparationShares(null, shares.map(fromWire)));
  } catch {
    return null;
  }
}

/** A teller's share of the valid answers, from its prepared states and the settling messages. */
export function aggregateReports(length: number, prepared: { state: unknown; message: unknown }[]): unknown {
  const v = histogram(length);
  const outputs = prepared.map((p) => {
    const next = v.prepareNext(fromWire(p.state), fromWire(p.message)) as { outputShare?: bigint[] };
    return next.outputShare ?? (next as unknown as bigint[]);
  });
  return toWire(v.aggregate(null, outputs));
}

/** The two tellers' aggregate shares, added up: the exact table, from `count` valid answers. */
export const unshardCounts = (length: number, shares: [unknown, unknown], count: number): number[] =>
  (histogram(length).unshard(null, shares.map(fromWire), count) as (number | bigint)[]).map(Number);

/** Two tellers from a list of cards (those with the `teller` skill), under different names; fewer than two: none. */
export function pickTellers(cards: AgentCard[]): TellerRef[] {
  const picked: TellerRef[] = [];
  for (const card of cards) {
    if (!card.skills?.some((s) => s.id === 'teller')) continue;
    const domain = String((card.capabilities?.extensions?.[0]?.params as { ownerDomain?: string } | undefined)?.ownerDomain ?? '');
    if (domain && !picked.some((c) => c.domain === domain)) picked.push({ url: card.supportedInterfaces[0]!.url, domain });
    if (picked.length === 2) return picked;
  }
  return [];
}

/** Two tellers, at different addresses, under different names: the least a count needs. */
export function tellersProblem(c: unknown): string | null {
  const list = c as TellerRef[];
  if (!Array.isArray(list) || list.length !== 2) return 'name exactly two tellers (a Leader and a Helper)';
  if (!list.every((x) => x && typeof x.url === 'string' && /^https?:\/\//.test(x.url) && typeof x.domain === 'string' && x.domain)) return 'each teller needs a url and a domain';
  if (list[0]!.domain === list[1]!.domain) return 'the two tellers must be different parties';
  const at = (u: string) => u.replace(/\/+$/, '').replace(/\/a2a$/, '');
  if (at(list[0]!.url) === at(list[1]!.url)) return 'the two tellers must be at different addresses';
  return null;
}
