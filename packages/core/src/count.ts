import { randomInt } from 'node:crypto';
import type { AgentCard } from '@a2a-js/sdk';

/**
 * Counting without looking (SPEC §11.5). Each participant splits its true numbers into two random-looking pieces that
 * add up to them, and sends one piece to each of two tellers run by different parties. A teller only ever sees
 * random numbers; each publishes one sum, once; the two sums add up to the exact totals. Nobody, the tellers
 * included, sees a single participant's numbers unless both tellers pool what they hold.
 *
 * Generic: studies use it for their tables; anything that needs a total and not the parts (a vote, a benchmark,
 * demand for a group buy) can too.
 */

/** Arithmetic is modulo a prime, so a piece on its own is a uniformly random number and says nothing. */
export const COUNT_MODULUS = 2_147_483_647;

/** A teller, as a count or a study names it: where to send pieces, and whose signed card must answer there. */
export interface TellerRef { url: string; domain: string }

const mod = (x: number) => ((x % COUNT_MODULUS) + COUNT_MODULUS) % COUNT_MODULUS;

/** Split whole numbers into two pieces; each piece alone is uniformly random. */
export function splitCount(values: number[], rand: (max: number) => number = (max) => randomInt(max)): [number[], number[]] {
  const a = values.map(() => rand(COUNT_MODULUS));
  const b = values.map((v, i) => mod(v - a[i]!));
  return [a, b];
}

/** Add pieces (or partial sums) together, cell by cell. */
export function addCounts(...parts: number[][]): number[] {
  const n = Math.max(0, ...parts.map((p) => p.length));
  return Array.from({ length: n }, (_, i) => parts.reduce((s, p) => mod(s + (p[i] ?? 0)), 0));
}

/** What the two tellers' sums add up to: the exact totals (as long as each true total is below the modulus). */
export const combineCounts = (a: number[], b: number[]) => addCounts(a, b);

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
  if (!Array.isArray(list) || list.length !== 2) return 'name exactly two tellers';
  if (!list.every((x) => x && typeof x.url === 'string' && /^https?:\/\//.test(x.url) && typeof x.domain === 'string' && x.domain)) return 'each teller needs a url and a domain';
  if (list[0]!.domain === list[1]!.domain) return 'the two tellers must be different parties';
  const at = (u: string) => u.replace(/\/+$/, '').replace(/\/a2a$/, '');
  if (at(list[0]!.url) === at(list[1]!.url)) return 'the two tellers must be at different addresses';
  return null;
}
