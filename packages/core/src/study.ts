import { canonicalize } from './canonical.js';
import { digestSRI } from './vc.js';

/**
 * A study is a declaration, not code: which yes/no questions to ask of each house's canonical claims.
 * Each house answers with ONE cell of the contingency table, randomised locally (unary randomised
 * response, a local-differential-privacy mechanism), so no single answer reveals its owner.
 * Across many houses the noise cancels and the researcher recovers the table.
 */
export type Field = 'age_band' | 'medications' | 'conditions' | 'readmissions';

export type Predicate =
  | { name: string; field: 'age_band'; op: 'age_at_least'; value: number }
  | { name: string; field: 'medications' | 'conditions'; op: 'has_code'; value: string }
  | { name: string; field: 'readmissions'; op: 'present' };

export interface Study {
  v: 1;
  question: string;
  kind: 'contingency';
  predicates: Predicate[];
  privacy: { mechanism: 'unary-randomized-response'; epsilon: number };
  minTier: 'issuer-signed';
}

export interface Claim { field: string; value: string; code?: string }

export const studyId = (s: Study) => `urn:lake:study:${digestSRI(canonicalize(s))}`;
export const studyFields = (s: Study): Field[] => [...new Set(s.predicates.map((p) => p.field))];
export const cellCount = (s: Study) => 2 ** s.predicates.length;

const MAX_EPSILON = 4;

/** What an Auditor checks, and what a house re-checks before running anything. */
export function auditStudy(s: Study): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (s?.v !== 1 || s.kind !== 'contingency') problems.push('only v1 contingency studies are understood');
  if (!Array.isArray(s?.predicates) || s.predicates.length < 1 || s.predicates.length > 4) problems.push('a study asks 1 to 4 yes/no questions');
  for (const p of s?.predicates ?? []) {
    const ok =
      (p.field === 'age_band' && p.op === 'age_at_least' && typeof p.value === 'number') ||
      ((p.field === 'medications' || p.field === 'conditions') && p.op === 'has_code' && typeof p.value === 'string') ||
      (p.field === 'readmissions' && p.op === 'present');
    if (!ok) problems.push(`question "${(p as Predicate)?.name}" is not one the Lake knows how to ask`);
  }
  if (s?.privacy?.mechanism !== 'unary-randomized-response') problems.push('answers must be randomised (unary randomised response)');
  else if (!(s.privacy.epsilon > 0 && s.privacy.epsilon <= MAX_EPSILON)) problems.push(`privacy budget must be in (0, ${MAX_EPSILON}]`);
  if (s?.minTier !== 'issuer-signed') problems.push('only issuer-signed values may be used');
  return { ok: problems.length === 0, problems };
}

function holds(p: Predicate, claims: Claim[]): boolean {
  const mine = claims.filter((c) => c.field === p.field);
  switch (p.op) {
    case 'age_at_least': return mine.some((c) => Number.parseInt(c.value, 10) >= p.value);
    case 'has_code': return mine.some((c) => c.code === p.value);
    case 'present': return mine.length > 0;
  }
}

/** Which cell this person falls in: bit i set when predicate i holds. Runs inside the house only. */
export function cellOf(s: Study, claims: Claim[]): number {
  return s.predicates.reduce((acc, p, i) => acc | (holds(p, claims) ? 1 << i : 0), 0);
}

const probs = (eps: number) => {
  const e = Math.exp(eps / 2);
  return { p: e / (1 + e), q: 1 / (1 + e) };
};

/** The one thing a house sends back: a randomised one-hot vector. Deniable by construction. */
export function randomize(s: Study, cell: number, rand: () => number = Math.random): number[] {
  const { p, q } = probs(s.privacy.epsilon);
  return Array.from({ length: cellCount(s) }, (_, i) => (rand() < (i === cell ? p : q) ? 1 : 0));
}

/** Unbiased estimate of how many houses fall in each cell, from all randomised fragments. */
export function estimate(s: Study, fragments: number[][]): { n: number; cells: number[] } {
  const { p, q } = probs(s.privacy.epsilon);
  const n = fragments.length;
  const sums = Array.from({ length: cellCount(s) }, (_, i) => fragments.reduce((a, f) => a + (f[i] ?? 0), 0));
  return { n, cells: sums.map((c) => Math.max(0, (c - n * q) / (p - q))) };
}

/** Human labels for each cell, e.g. "over 60 · on drug X · not readmitted". */
export function cellLabels(s: Study): string[] {
  return Array.from({ length: cellCount(s) }, (_, cell) => s.predicates.map((p, i) => ((cell >> i) & 1 ? p.name : `not ${p.name}`)).join(' · '));
}
