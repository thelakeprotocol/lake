import { canonicalize } from './canonical.js';
import { tellersProblem, type TellerRef } from './count.js';
import { fieldSpec, identifyingFields, packId, packs, type Claim, type PackField } from './pack.js';
import { digestSRI } from './vc.js';

/**
 * A study is a declaration, not code: which yes/no questions to ask of each house's canonical claims.
 * Each house works out, truthfully, which ONE cell of the contingency table its owner falls in, and reports it as
 * two shares with a validity proof, one to each of two tellers, Leader and Helper (IETF DAP with Prio3; SPEC §7,
 * §11.5). The researcher gets the exact table and never sees any house's answer.
 */
export type Field = string;

/**
 * One yes/no question about one field. Which comparisons a field allows depends on its kind, declared by
 * the pack that owns it: bands and numbers compare (`at_least`, `at_most`), codes match (`has_code`), and
 * anything can be `present`. `age_at_least` is the v0.1 spelling of `at_least` on a band.
 */
export type Predicate =
  | { name: string; field: Field; op: 'at_least' | 'at_most' | 'age_at_least'; value: number }
  | { name: string; field: Field; op: 'has_code'; value: string }
  | { name: string; field: Field; op: 'present' };

const OPS: Record<PackField['kind'], string[]> = {
  band: ['at_least', 'at_most', 'age_at_least', 'present'],
  number: ['at_least', 'at_most', 'present'],
  code: ['has_code', 'present'],
  flag: ['present'],
};

export interface Study {
  v: 1;
  question: string;
  kind: 'contingency';
  predicates: Predicate[];
  /** Who counts the answers, and the fewest houses a published table may come from. */
  /** noise: the tellers add discrete Laplace noise to the table they release, at this ε (DAP's differential-privacy option). */
  privacy: { mechanism: 'dap-prio3'; tellers: TellerRef[]; min: number; noise?: { epsilon: number } };
  minTier: 'issuer-signed';
}

export type { Claim };

export const studyId = (s: Study) => `urn:lake:study:${digestSRI(canonicalize(s))}`;
export const studyFields = (s: Study): Field[] => [...new Set(s.predicates.map((p) => p.field))];
export const cellCount = (s: Study) => 2 ** s.predicates.length;

/**
 * What's wrong with what a study asks, tellers aside: its shape, its words, and each yes/no question against the
 * field it reads. What someone writing a study of their own checks before they pick tellers and ask an auditor.
 */
export function questionProblems(s: Study): string[] {
  const problems: string[] = [];
  if (s?.v !== 1 || s.kind !== 'contingency') problems.push('only v1 contingency studies are understood');
  // The question is the researcher's own sentence, shown to each owner as their words: a sentence, not a page.
  if (typeof s?.question !== 'string' || !s.question.trim() || s.question.length > 200) problems.push('question: one sentence, up to 200 characters');
  if (!Array.isArray(s?.predicates) || s.predicates.length < 1 || s.predicates.length > 4) problems.push('a study asks 1 to 4 yes/no questions');
  const names = (s?.predicates ?? []).map((p) => p?.name);
  if (names.some((n) => typeof n !== 'string' || !n.trim() || n.length > 60)) problems.push('each yes/no question has a name of up to 60 characters ("over 60", "on drug X")');
  else if (new Set(names).size !== names.length) problems.push('two yes/no questions have the same name');
  for (const p of s?.predicates ?? []) {
    const spec = fieldSpec(p?.field);
    const valueOk = p?.op === 'present' || (p?.op === 'has_code' ? typeof p.value === 'string' : typeof (p as { value?: unknown }).value === 'number');
    // A pack names what identifies someone without declaring it as a field: said as what it is, not as a field nobody knows.
    if (identifyingFields().includes(p?.field)) problems.push(`"${p.field}" is identifying; no study may read it`);
    else if (!spec) problems.push(`question "${p?.name}" reads "${p?.field}", which no pack here declares`);
    else if (!OPS[spec.kind].includes(p.op)) problems.push(`question "${p.name}" can't ask "${p.op}" of ${spec.kind} field "${p.field}": it takes ${OPS[spec.kind].filter((op) => op !== 'age_at_least').join(', ')}`);
    else if (!valueOk) problems.push(`question "${p.name}": "${p.op}" needs a ${p.op === 'has_code' ? 'code (text)' : 'number'} as its value`);
    // A register's fields go only to agents on it, unless its pack lets studies read them (SPEC §5.2): run 28's rogue
    // padded a study with shopping fields and got it certified.
    if (spec?.pack.authority && !spec.pack.authority.studies) problems.push(`question "${p.name}" reads "${p.field}", which ${spec.pack.id}'s register (${spec.pack.authority.name}) keeps for agents on it: its pack lets no study read it`);
    if (p?.op === 'has_code' && typeof p.value === 'string' && (!p.value || p.value.length > 80)) problems.push(`question "${p.name}": a code of up to 80 characters`);
  }
  return problems;
}

/** What an Auditor checks, and what a house re-checks before running anything. */
export function auditStudy(s: Study): { ok: boolean; problems: string[] } {
  const problems = questionProblems(s);
  if (s?.privacy?.mechanism !== 'dap-prio3') problems.push('answers must be counted by two tellers, Leader and Helper, with Prio3 proofs (dap-prio3)');
  else {
    const bad = tellersProblem(s.privacy.tellers);
    if (bad) problems.push(`tellers: ${bad}`);
    if (!(Number.isInteger(s.privacy.min) && s.privacy.min >= 2)) problems.push('min: the fewest houses a table may come from, at least 2');
    if (s.privacy.noise !== undefined && !(s.privacy.noise.epsilon > 0 && s.privacy.noise.epsilon <= MAX_EPSILON)) problems.push(`noise.epsilon: above 0 and at most ${MAX_EPSILON}`);
  }
  if (s?.minTier !== 'issuer-signed') problems.push('only issuer-signed values may be used');
  return { ok: problems.length === 0, problems };
}

/**
 * The most a study's noise may be turned down (its epsilon; smaller is more noise). Each teller adds two-sided geometric
 * noise with q = e^(-epsilon/2) to every cell: at 2 a cell is off by about two, and at 10 (the old limit) a teller left
 * a cell untouched 98.7% of the time, which is noise in name only.
 */
export const MAX_EPSILON = 2;

/**
 * What a count for a study is opened with, from the study alone (SPEC §7, §11.5): its id, how many cells, the fewest
 * houses a table may come from, the noise, and the two tellers it names. A teller takes these from the study and never
 * from whoever opens the count. It reads no pack, so a teller needs none loaded: whether the study may be asked at all
 * is the auditor's and each house's check.
 */
export function countTerms(s: Study): { ok: true; study: string; length: number; min: number; noise?: { epsilon: number }; tellers: [TellerRef, TellerRef] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(s?.predicates) || s.predicates.length < 1 || s.predicates.length > 4) problems.push('study: 1 to 4 yes/no questions');
  if (s?.privacy?.mechanism !== 'dap-prio3') problems.push('study: counted by two tellers (dap-prio3)');
  else {
    const bad = tellersProblem(s.privacy.tellers);
    if (bad) problems.push(`study: ${bad}`);
    if (!(Number.isInteger(s.privacy.min) && s.privacy.min >= 2)) problems.push('study: min, the fewest houses a table may come from, at least 2');
    if (s.privacy.noise !== undefined && !(s.privacy.noise?.epsilon > 0 && s.privacy.noise.epsilon <= MAX_EPSILON)) problems.push(`study: noise.epsilon above 0 and at most ${MAX_EPSILON}`);
  }
  if (problems.length) return { ok: false, problems };
  const { min, noise, tellers } = s.privacy;
  return { ok: true, study: studyId(s), length: cellCount(s), min, ...(noise ? { noise: { epsilon: noise.epsilon } } : {}), tellers: [tellers[0]!, tellers[1]!] };
}

/** A study as someone writes one of their own: the question, its yes/no parts, and how small or blurred a table they'd take. */
export interface StudyDraft {
  question: string;
  predicates: { name: string; field: Field; op: string; value?: string | number }[];
  /** The fewest houses a table may come from (the tellers have a floor of their own). Default 3. */
  min?: number;
  /** Have the tellers add noise to the table, at this ε. */
  noise_epsilon?: number;
}

/**
 * A written study as the declaration that gets certified, with no tellers yet: whoever runs it picks two from the
 * Lake first (they are part of what is certified). Says nothing about whether it may be asked: `questionProblems` does.
 */
export function draftStudy(d: StudyDraft): Study {
  const predicates = (Array.isArray(d?.predicates) ? d.predicates : []).map((p) => {
    const base = { name: String(p?.name ?? '').trim(), field: String(p?.field ?? '') };
    if (p?.op === 'has_code') return { ...base, op: p.op, value: String(p.value ?? '') };
    // A number written as text ("60") is the number.
    if (p?.op === 'at_least' || p?.op === 'at_most' || p?.op === 'age_at_least') return { ...base, op: p.op, value: typeof p.value === 'string' && p.value.trim() !== '' && Number.isFinite(Number(p.value)) ? Number(p.value) : p.value };
    return { ...base, op: p?.op };
  }) as Predicate[];
  return {
    v: 1, question: String(d?.question ?? '').trim(), kind: 'contingency', predicates,
    privacy: { mechanism: 'dap-prio3', tellers: [], min: d?.min ?? 3, ...(d?.noise_epsilon !== undefined ? { noise: { epsilon: d.noise_epsilon } } : {}) },
    minTier: 'issuer-signed',
  };
}

/**
 * What a house would count for a study, one line for each yes/no question, worded from the pack's own labels and
 * never from the researcher's: "age band: 60 or more", "medications: Drug X", "hospital readmissions: any on
 * record". A study's question and the names of its questions are free text; this is what its answer is made of.
 */
export function predicateLines(s: Study): string[] {
  return (s?.predicates ?? []).map((p) => {
    const spec = fieldSpec(p.field);
    const label = spec?.label ?? String(p.field).replaceAll('_', ' ');
    const amount = (v: number) => `${v}${spec?.unit ? ` ${spec.unit}` : ''}`;
    switch (p.op) {
      case 'at_least': case 'age_at_least': return `${label}: ${amount(p.value)} or more`;
      case 'at_most': return `${label}: ${amount(p.value)} or less`;
      // The pack's name for a code, alone: "Hypertension (38341003)" read as a database to an owner (14 Nov); a code with no
      // name is said as one.
      case 'has_code': { const known = spec?.codes?.[p.value]; return known ? `${label}: ${known}` : `${label}: the code ${String(p.value).slice(0, 80)}`; }
      default: return `${label}: any on record`;
    }
  });
}

/** One field a study may ask about: how it compares, and whether its pack lets studies read it at all. */
export interface StudyField {
  field: Field;
  /** The pack that declares it, with its major version (`health@1`). */
  pack: string;
  label: string;
  kind: PackField['kind'];
  /** The comparisons a yes/no question may make of it (`op`). */
  ask: string[];
  unit?: string;
  /** Codes the pack names for a `has_code` question; others it doesn't name can be asked too. */
  codes?: Record<string, string>;
  special?: boolean;
  /** False when the field's pack has a register that keeps its fields for agents on it (SPEC §5.2). */
  studies: boolean;
  why?: string;
}

/** Every field of the loaded packs, as someone writing a study needs it. Identifying fields aren't listed: no study reads them. */
export function studyCatalog(): StudyField[] {
  return packs().flatMap((pk) => Object.entries(pk.fields).map(([field, f]) => {
    const open = !pk.authority || !!pk.authority.studies;
    return {
      field, pack: packId(pk), label: f.label, kind: f.kind, ask: OPS[f.kind].filter((op) => op !== 'age_at_least'),
      ...(f.unit ? { unit: f.unit } : {}), ...(f.codes ? { codes: f.codes } : {}), ...(f.special ? { special: true } : {}),
      studies: open, ...(open ? {} : { why: `${pk.authority!.name} keeps this pack's fields for agents on its register; no study may read them` }),
    };
  }));
}

/** A band ("60-69", "90+") compares by its lower bound; a number by itself. */
const num = (v: string) => Number.parseFloat(v);

function holds(p: Predicate, claims: Claim[]): boolean {
  const mine = claims.filter((c) => c.field === p.field);
  switch (p.op) {
    case 'at_least': case 'age_at_least': return mine.some((c) => num(c.value) >= p.value);
    case 'at_most': return mine.some((c) => num(c.value) <= p.value);
    case 'has_code': return mine.some((c) => c.code === p.value);
    case 'present': return mine.length > 0;
  }
}

/** Which cell this person falls in: bit i set when predicate i holds. Runs inside the house only. */
export function cellOf(s: Study, claims: Claim[]): number {
  return s.predicates.reduce((acc, p, i) => acc | (holds(p, claims) ? 1 << i : 0), 0);
}

/** Human labels for each cell, e.g. "over 60 · on drug X · not readmitted". */
export function cellLabels(s: Study): string[] {
  return Array.from({ length: cellCount(s) }, (_, cell) => s.predicates.map((p, i) => ((cell >> i) & 1 ? p.name : `not ${p.name}`)).join(' · '));
}

/** What a study's table says, for any number of predicates (1 to 4), and how exact it is. */
export interface TableSummary {
  n: number;
  /** How many of the n each predicate was true for. */
  marginals: { name: string; yes: number; share: number }[];
  /**
   * With 2 or more predicates: the last one (the outcome) among those with the one before it (the exposure) against
   * those without, within the houses the others hold for. Absent with one predicate.
   */
  comparison?: { outcome: string; exposure: string; within: string[]; with: { yes: number; of: number; rate: number }; without: { yes: number; of: number; rate: number } };
  /** Exact counts, or the noise both tellers added: the standard deviation of each published cell. */
  precision: { exact: true } | { exact: false; epsilon: number; sdPerCell: number };
  /** A cell under 5: small numbers, read with care. */
  small: boolean;
  summary: string;
}

export function summarizeTable(s: Study, cells: number[], n: number): TableSummary {
  const k = s.predicates.length, names = s.predicates.map((p) => p.name);
  const at = (i: number) => Math.max(0, cells[i] ?? 0); // noise can push a small cell below zero
  const sum = (f: (cell: number) => boolean) => cells.reduce((t, _, i) => t + (f(i) ? at(i) : 0), 0);
  const bit = (cell: number, i: number) => ((cell >> i) & 1) === 1;
  const share = (x: number) => (n > 0 ? Math.round((x / n) * 1000) / 1000 : 0);
  const marginals = names.map((name, i) => { const yes = Math.round(sum((c) => bit(c, i))); return { name, yes, share: share(yes) }; });
  let comparison: TableSummary['comparison'];
  if (k >= 2) {
    const out = k - 1, exp = k - 2, within = names.slice(0, exp);
    const inside = (c: number) => within.every((_, i) => bit(c, i));
    const arm = (e: boolean) => { const yes = Math.round(sum((c) => inside(c) && bit(c, exp) === e && bit(c, out))), of = Math.round(sum((c) => inside(c) && bit(c, exp) === e)); return { yes, of, rate: of > 0 ? Math.round((yes / of) * 1000) / 1000 : 0 }; };
    comparison = { outcome: names[out]!, exposure: names[exp]!, within, with: arm(true), without: arm(false) };
  }
  const eps = s.privacy.noise?.epsilon;
  // Each teller adds a two-sided geometric draw with ratio q = e^(-ε/2): variance 2q/(1-q)² each, two tellers.
  const precision: TableSummary['precision'] = eps ? { exact: false, epsilon: eps, sdPerCell: Math.round((2 * Math.sqrt(Math.exp(-eps / 2)) / (1 - Math.exp(-eps / 2))) * 10) / 10 } : { exact: true };
  const small = n > 0 && cells.some((c) => c > 0 && c < 5);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const summary = n === 0 ? 'No table.'
    : comparison ? `${comparison.within.length ? `${comparison.within.join(', ')}: ` : ''}${comparison.outcome} ${pct(comparison.with.rate)} with ${comparison.exposure} (${comparison.with.yes} of ${comparison.with.of}) vs ${pct(comparison.without.rate)} without (${comparison.without.yes} of ${comparison.without.of}), from ${n} houses`
    : `${marginals[0]!.name}: ${marginals[0]!.yes} of ${n} (${pct(marginals[0]!.share)})`;
  return { n, marginals, ...(comparison ? { comparison } : {}), precision, small, summary: `${summary}${n === 0 ? '' : precision.exact ? '; exact counts' : `; each cell ±${precision.sdPerCell} (noise, ε ${eps})`}${small ? '; small numbers' : ''}` };
}
