import { randomBytes, randomInt } from 'node:crypto';
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

/**
 * Noise a teller adds to its own aggregate share before releasing it (DAP's differential-privacy option): a discrete
 * Laplace draw per cell, scaled for one answer changing two cells by one. Houses still answer exactly; only the published
 * table is blurred, a little, so subtracting one study from another can't single out one house.
 */
export function addNoise(length: number, share: unknown, epsilon: number): unknown {
  const v = histogram(length) as unknown as { field: { modulus: bigint } };
  const p = v.field.modulus;
  const q = Math.exp(-epsilon / 2);
  // Two-sided geometric: the difference of two geometric draws with the same ratio q.
  const geometric = () => { let k = 0; while (randomInt(0, 2 ** 32) / 2 ** 32 < q) k++; return k; };
  return toWire((fromWire(share) as bigint[]).map((x) => (((x + BigInt(geometric() - geometric())) % p) + p) % p));
}

/** The two tellers' aggregate shares, added up: the table, from `count` valid answers (exact unless the tellers added noise). */
export const unshardCounts = (length: number, shares: [unknown, unknown], _count: number): number[] => {
  // For a histogram, unsharding is adding the two shares cell by cell in the field. Done here in exact arithmetic,
  // because the library converts to plain numbers, and noise can push a small cell below zero, which the field holds
  // as a number near the modulus: the top half reads as negative.
  const p = (histogram(length) as unknown as { field: { modulus: bigint } }).field.modulus;
  const [a, b] = shares.map((x) => fromWire(x) as bigint[]) as [bigint[], bigint[]];
  return a.map((x, i) => { const v = (x + b[i]!) % p; return Number(v > p / 2n ? v - p : v); });
};

/**
 * What a count may publish (SPEC §11.5): statistical disclosure control by the threshold rule, as statistics offices
 * apply it to frequency tables (Eurostat's SDC handbook: no cell may come from fewer than k contributors), with table
 * redesign as the remedy: when a cell is unsafe, the table is collapsed until every cell it shows is 0 or at least k.
 *
 * Why redesign and not "<k" in a cell: whoever reads a table knows how many answers it came from, so one hidden cell
 * is the total minus the rest, and several hidden cells can still be pinned by their sum; hiding cells safely needs
 * secondary suppression checked by linear programming (what τ-ARGUS does). A collapsed table hides nothing: every
 * number in it is an exact count of 0 or at least k, and the cells it merged are gone, not blanked.
 *
 * For a table of 2^p cells (p yes/no questions, bit i for question i), the questions are dropped from the first: all p
 * questions, then every way of keeping p-1 (dropping question 0 first, then 1, …), down to one question. A study puts
 * the question it can best do without first and its outcome last. The first table that passes is the one published;
 * none passes: no table (the number of answers is still known). Any other length (a vote's options) is all or nothing.
 * Deterministic, so both tellers reach the same table on their own. With noise, a cell at or below 0 counts as empty.
 */
export function discloseTable(cells: number[], k: number): { cells: number[]; kept: number[] } | null {
  const safe = (t: number[]) => t.every((c) => c <= 0 || c >= k);
  const p = Math.log2(cells.length);
  if (!Number.isInteger(p) || p < 1) return safe(cells) ? { cells: [...cells], kept: [] } : null;
  for (let size = p; size >= 1; size--) {
    for (const kept of keeping(p, size)) {
      const table = Array<number>(2 ** size).fill(0);
      cells.forEach((c, i) => { table[kept.reduce((acc, bit, j) => acc | (((i >> bit) & 1) << j), 0)]! += c; });
      if (safe(table)) return { cells: table, kept };
    }
  }
  return null;
}

/** Which `size` of the questions 0..p-1 to keep, in the order a table is tried: drop the earliest questions first. */
function keeping(p: number, size: number): number[][] {
  const all: number[][] = [];
  const pick = (from: number, chosen: number[]) => {
    if (chosen.length === size) { all.push(chosen); return; }
    for (let i = from; i < p; i++) pick(i + 1, [...chosen, i]);
  };
  pick(0, []);
  // Sets that keep later questions come first: the dropped ones are the earliest.
  const dropped = (s: number[]) => Array.from({ length: p }, (_, i) => i).filter((i) => !s.includes(i));
  return all.sort((a, b) => { const x = dropped(a), y = dropped(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return 0; });
}

/** The smallest cell a teller lets a table show, whatever a count asks for: 3 on a sandbox, 10 for real (SPEC §11.5). */
export const minCellFor = (sandbox: boolean) => (sandbox ? 3 : 10);

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
