import { Environment } from '@marcbachmann/cel-js';
import { canonicalize } from './canonical.js';
import { fieldSpec, pack, type Claim } from './pack.js';
import { digestSRI } from './vc.js';

/**
 * A quote program: an offer computed inside the house, on the owner's own data, shown only to the owner
 * (SPEC §12). It is a declaration, not code: a few named inputs (pack fields, and the public terms of
 * the owner's intent), expressions over them in CEL (Google's Common Expression Language: no loops, no I/O,
 * always terminates, type-checked before it runs), a yes/no `eligible`, and numeric outputs. Nothing is sent
 * back: the asker learns only that a quote was delivered, eligible or not. An auditor certifies it; the house
 * re-checks it and runs it.
 */
export interface QuoteProgram {
  v: 2;
  kind: 'quote';
  /** The pack it reads, with major version: `mortgage@1`. */
  pack: string;
  title: string;
  /** Pack fields it reads. Identifying fields never. */
  inputs: string[];
  /** Public terms of the owner's intent it reads (e.g. `price_band`, `term_years`). */
  terms?: string[];
  /** Named intermediate values, CEL expressions evaluated in order; later ones may use earlier ones. */
  let?: Record<string, string>;
  /** A CEL expression of type bool. */
  eligible: string;
  /** What the owner sees: CEL expressions of type double. */
  outputs: Record<string, string>;
  /** The output the owner pays on accepting, when there is one (a basket's total): the house checks it against what the owner's assistant may spend. */
  price?: string;
  /** Plain-English labels and units for the outputs, for the owner's panel. */
  labels?: Record<string, { label: string; unit?: string }>;
  /**
   * Plain-English notes for the owner, each shown when its CEL condition holds: why an offer isn't for them ("we can't
   * cater for a nut allergy"), what changes ("lentils: we'd send a substitute"). Worked out in the house like the rest,
   * seen by the owner only. Text the quoter wrote, so it only explains: it never changes the result.
   */
  notes?: { when: string; say: string }[];
  /** Who sees the result. Always the owner, never the asker. */
  output: 'owner';
}

const LIMITS = { outputs: 12, lets: 24, notes: 16, noteLength: 160, nodes: 300, depth: 32 };

/**
 * Every program may read how many households share the owner's intent group (the node publishes it). A
 * lender's group offer is written into its certified program: "0.2% off when 3 or more of you ask".
 */
export const GROUP_SIZE = 'group_size';

export const programId = (p: QuoteProgram) => `urn:lake:program:${digestSRI(canonicalize(p))}`;

/**
 * The functions a program may call besides CEL's own operators: lookups and finance the declarations need, all pure.
 * CEL never mixes int and double: write 2.0, not 2, next to a double.
 */
const FUNCTIONS: [string, (...a: never[]) => unknown][] = [
  // [[upto, value], …]: the value of the first row whose `upto` is at least x; none: not a number.
  ['band(double, list<list<double>>): double', (x: number, table: number[][]) => table.find((r) => x <= r[0]!)?.[1] ?? Number.NaN],
  ['annuity(double, double, double): double', (principal: number, ratePct: number, years: number) => {
    const r = ratePct / 100 / 12, n = years * 12;
    return r === 0 ? principal / n : (principal * r) / (1 - (1 + r) ** -n);
  }],
  ['min(double, double): double', (a: number, b: number) => Math.min(a, b)],
  ['max(double, double): double', (a: number, b: number) => Math.max(a, b)],
  ['round(double, int): double', (x: number, digits: bigint) => { const k = 10 ** Number(digits); return Math.round(x * k) / k; }],
  ['floor(double): double', (x: number) => Math.floor(x)],
  ['ceil(double): double', (x: number) => Math.ceil(x)],
];

/** What each name a program reads is, in CEL: numbers as double, a flag as bool, the codes a claim holds as a list. */
function inputType(f: string): string | null {
  const kind = fieldSpec(f)?.kind;
  return kind === 'number' || kind === 'band' ? 'double' : kind === 'flag' ? 'bool' : kind === 'code' ? 'list<string>' : null;
}
function termType(packId: string, t: string): string | null {
  if (t === GROUP_SIZE) return 'double';
  const spec = pack(packId)?.intent?.terms[t];
  return !spec ? null : spec.kind === 'code' ? 'string' : 'double';
}

function environment() {
  const env = new Environment({ limits: { maxAstNodes: LIMITS.nodes, maxDepth: LIMITS.depth, maxListElements: 64, maxMapEntries: 0, maxCallArguments: 4 } });
  for (const [sig, fn] of FUNCTIONS) env.registerFunction(sig, fn as never);
  return env;
}

/** What an auditor checks, and what a house re-checks before running one. */
export function auditProgram(p: QuoteProgram): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (p?.v !== 2 || p.kind !== 'quote') return { ok: false, problems: ['only v2 quote programs (CEL) are understood'] };
  if (p.output !== 'owner') problems.push('a quote goes to the owner only');
  const owner = pack(p.pack ?? '');
  if (!owner) problems.push(`no pack here called ${p.pack}`);
  const env = environment();
  for (const f of p.inputs ?? []) {
    const spec = fieldSpec(f);
    if (!spec || spec.pack.id !== owner?.id) problems.push(`input "${f}" is not a field of ${p.pack}`);
    else if (owner?.identifying?.includes(f)) problems.push(`"${f}" is identifying; no program may read it`);
    else env.registerVariable(f, inputType(f)!);
  }
  for (const t of p.terms ?? []) {
    const type = owner ? termType(owner.id, t) : null;
    if (!type) problems.push(`term "${t}" is not one ${p.pack} intents carry`);
    else env.registerVariable(t, type);
  }
  if (problems.length) return { ok: false, problems };
  const lets = Object.entries(p.let ?? {});
  if (lets.length > LIMITS.lets) problems.push(`at most ${LIMITS.lets} intermediate values`);
  const outputs = Object.entries(p.outputs ?? {});
  if (outputs.length < 1 || outputs.length > LIMITS.outputs) problems.push(`1 to ${LIMITS.outputs} outputs`);
  if (p.price !== undefined && !(p.price in (p.outputs ?? {}))) problems.push(`price: the name of one of its outputs`);
  const typed = (where: string, e: unknown, want?: string[]): string | null => {
    if (typeof e !== 'string') { problems.push(`${where}: a CEL expression, as a string`); return null; }
    const c = env.check(e);
    if (!c.valid) { problems.push(`${where}: ${String(c.error?.message ?? 'not valid CEL').split('\n')[0]}`); return null; }
    if (want && !want.includes(c.type!)) { problems.push(`${where}: gives ${c.type}, needs ${want.join(' or ')}`); return null; }
    return c.type!;
  };
  for (const [k, e] of lets) {
    if (env.hasVariable(k)) { problems.push(`let.${k}: the name is taken`); continue; }
    const type = typed(`let.${k}`, e, ['double', 'bool']);
    if (type) env.registerVariable(k, type);
  }
  typed('eligible', p.eligible, ['bool']);
  for (const [k, e] of outputs) typed(`outputs.${k}`, e, ['double']);
  if (p.notes !== undefined) {
    if (!Array.isArray(p.notes) || p.notes.length > LIMITS.notes) problems.push(`notes: a list of at most ${LIMITS.notes}`);
    else p.notes.forEach((n, i) => {
      if (typeof n?.say !== 'string' || !n.say.trim() || n.say.length > LIMITS.noteLength) problems.push(`notes[${i}].say: plain text, 1 to ${LIMITS.noteLength} characters`);
      typed(`notes[${i}].when`, n?.when, ['bool']);
    });
  }
  return { ok: problems.length === 0, problems };
}

export interface QuoteResult { eligible: boolean; outputs: Record<string, number>; /** The notes whose condition held, eligible or not. */ notes?: string[] }

/** Runs inside the house, on its claims and the owner's own intent terms. Assumes an audited program. */
export function runProgram(p: QuoteProgram, claims: Claim[], terms: Record<string, string | number> = {}): QuoteResult {
  const env = environment();
  const context: Record<string, unknown> = {};
  for (const f of p.inputs) {
    const mine = claims.filter((c) => c.field === f);
    const type = inputType(f)!;
    env.registerVariable(f, type);
    // Numbers and bands read as their (lower-bound) value; a flag as whether it's there; codes as the list held.
    context[f] = type === 'double' ? Number.parseFloat(mine[0]?.value ?? 'NaN') : type === 'bool' ? mine.length > 0 : mine.map((c) => String(c.code ?? c.value));
  }
  for (const t of p.terms ?? []) {
    const type = termType(packOf(p), t)!;
    env.registerVariable(t, type);
    context[t] = type === 'string' ? String(terms[t] ?? '') : typeof terms[t] === 'number' ? terms[t] : Number.parseFloat(String(terms[t] ?? 'NaN'));
  }
  const none = { eligible: false, outputs: Object.fromEntries(Object.keys(p.outputs).map((k) => [k, Number.NaN])) };
  try {
    for (const [k, e] of Object.entries(p.let ?? {})) {
      const value = env.evaluate(e, context);
      env.registerVariable(k, typeof value === 'boolean' ? 'bool' : 'double');
      context[k] = value;
    }
    const eligible = env.evaluate(p.eligible, context) === true;
    const outputs: Record<string, number> = {};
    for (const [k, e] of Object.entries(p.outputs)) {
      const v = Number(env.evaluate(e, context));
      outputs[k] = Number.isFinite(v) ? Math.round(v * 100) / 100 : Number.NaN;
    }
    // A note that can't be worked out (missing data) just isn't shown.
    const notes = (p.notes ?? []).filter((n) => { try { return env.evaluate(n.when, context) === true; } catch { return false; } }).map((n) => n.say);
    // Missing data or a broken sum is "not eligible", never a made-up number.
    return { eligible: eligible && Object.values(outputs).every(Number.isFinite), outputs, ...(notes.length ? { notes } : {}) };
  } catch {
    return none;
  }
}

const packOf = (p: QuoteProgram) => pack(p.pack)!.id;
