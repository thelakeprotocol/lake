import { canonicalize } from './canonical.js';
import { fieldSpec, pack, type Claim } from './pack.js';
import { digestSRI } from './vc.js';

/**
 * A quote program: an offer computed inside the house, on the owner's own data, shown only to the owner
 * (SPEC §12). It is a declaration, not code: a few named inputs (pack fields, and the public terms of
 * the owner's intent), arithmetic over them, a yes/no `eligible`, and numeric outputs. No loops, no I/O,
 * nothing sent back: the asker learns only that a quote was delivered, eligible or not. An auditor
 * certifies it; the house re-checks it and runs it.
 */
export interface QuoteProgram {
  v: 1;
  kind: 'quote';
  /** The pack it reads, with major version: `mortgage@1`. */
  pack: string;
  title: string;
  /** Pack fields it reads. Identifying fields never. */
  inputs: string[];
  /** Public terms of the owner's intent it reads (e.g. `price_band`, `term_years`). */
  terms?: string[];
  /** Named intermediate values, evaluated in order; later ones may use earlier ones. */
  let?: Record<string, Expr>;
  eligible: Expr;
  /** What the owner sees: numbers only. */
  outputs: Record<string, Expr>;
  /** Plain-English labels and units for the outputs, for the owner's panel. */
  labels?: Record<string, { label: string; unit?: string }>;
  /** Who sees the result. Always the owner, never the asker. */
  output: 'owner';
}

export type Expr = number | boolean | { var: string } | { has: [string, string] } | { [op: string]: Expr[] | BandArgs | AnnuityArgs };
interface BandArgs { of: Expr; table: [number, number][]; else?: number }
interface AnnuityArgs { principal: Expr; rate_pct: Expr; years: Expr }

const ARITH = ['+', '-', '*', '/', 'min', 'max', 'round', 'floor', 'ceil'] as const;
const LOGIC = ['<', '<=', '>', '>=', '==', '!=', 'and', 'or', 'not', 'if'] as const;
const OPS = new Set<string>([...ARITH, ...LOGIC, 'band', 'annuity', 'has']);
const LIMITS = { nodes: 400, depth: 16, outputs: 12, lets: 24 };

/**
 * Every program may read how many households share the owner's intent group (the node publishes it). A
 * lender's group offer is written into its certified program: "0.2% off when 3 or more of you ask".
 */
export const GROUP_SIZE = 'group_size';

export const programId = (p: QuoteProgram) => `urn:lake:program:${digestSRI(canonicalize(p))}`;

/** What an auditor checks, and what a house re-checks before running one. */
export function auditProgram(p: QuoteProgram): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (p?.v !== 1 || p.kind !== 'quote') return { ok: false, problems: ['only v1 quote programs are understood'] };
  if (p.output !== 'owner') problems.push('a quote goes to the owner only');
  const owner = pack(p.pack ?? '');
  if (!owner) problems.push(`no pack here called ${p.pack}`);
  for (const f of p.inputs ?? []) {
    const spec = fieldSpec(f);
    if (!spec || spec.pack.id !== owner?.id) problems.push(`input "${f}" is not a field of ${p.pack}`);
    if (owner?.identifying?.includes(f)) problems.push(`"${f}" is identifying; no program may read it`);
  }
  for (const t of p.terms ?? []) if (t !== GROUP_SIZE && !owner?.intent?.terms[t]) problems.push(`term "${t}" is not one ${p.pack} intents carry`);
  const lets = Object.keys(p.let ?? {});
  if (lets.length > LIMITS.lets) problems.push(`at most ${LIMITS.lets} intermediate values`);
  if (Object.keys(p.outputs ?? {}).length < 1 || Object.keys(p.outputs ?? {}).length > LIMITS.outputs) problems.push(`1 to ${LIMITS.outputs} outputs`);
  let nodes = 0;
  const known = new Set([...(p.inputs ?? []), ...(p.terms ?? [])]);
  const walk = (e: Expr, depth: number, where: string) => {
    if (++nodes > LIMITS.nodes) return;
    if (depth > LIMITS.depth) { problems.push(`${where}: nested too deep`); return; }
    if (typeof e === 'number') { if (!Number.isFinite(e)) problems.push(`${where}: not a finite number`); return; }
    if (typeof e === 'boolean') return;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { problems.push(`${where}: not an expression`); return; }
    const keys = Object.keys(e);
    if (keys.length !== 1) { problems.push(`${where}: one operator per expression`); return; }
    const op = keys[0]!;
    const arg = (e as Record<string, unknown>)[op];
    if (op === 'var') { if (typeof arg !== 'string' || !known.has(arg)) problems.push(`${where}: unknown name "${String(arg)}"`); return; }
    // { has: [field, code] }: does a code field hold this code? Only for code fields the program declares.
    if (op === 'has') {
      const [f, code] = (arg as unknown as [string, string]) ?? [];
      if (!(p.inputs ?? []).includes(f) || fieldSpec(f)?.kind !== 'code' || typeof code !== 'string') problems.push(`${where}: has takes a declared code field and a code`);
      return;
    }
    if (!OPS.has(op)) { problems.push(`${where}: "${op}" is not an operator programs may use`); return; }
    if (op === 'band') {
      const b = arg as BandArgs;
      if (!Array.isArray(b?.table) || !b.table.every((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite))) problems.push(`${where}: band needs a table of [upto, value] pairs`);
      walk(b?.of as Expr, depth + 1, where);
      return;
    }
    if (op === 'annuity') {
      const a = arg as AnnuityArgs;
      for (const k of ['principal', 'rate_pct', 'years'] as const) walk(a?.[k] as Expr, depth + 1, where);
      return;
    }
    if (!Array.isArray(arg)) { problems.push(`${where}: "${op}" takes a list`); return; }
    for (const x of arg) walk(x as Expr, depth + 1, where);
  };
  for (const [k, e] of Object.entries(p.let ?? {})) { walk(e, 0, `let.${k}`); known.add(k); }
  walk(p.eligible, 0, 'eligible');
  for (const [k, e] of Object.entries(p.outputs ?? {})) walk(e, 0, `outputs.${k}`);
  if (nodes > LIMITS.nodes) problems.push(`at most ${LIMITS.nodes} operations`);
  return { ok: problems.length === 0, problems };
}

export interface QuoteResult { eligible: boolean; outputs: Record<string, number> }

/** Runs inside the house, on its claims and the owner's own intent terms. Assumes an audited program. */
export function runProgram(p: QuoteProgram, claims: Claim[], terms: Record<string, string | number> = {}): QuoteResult {
  const env = new Map<string, number>();
  for (const f of p.inputs) {
    const mine = claims.filter((c) => c.field === f);
    const kind = fieldSpec(f)?.kind;
    // Numbers and bands read as their (lower-bound) value; flags and codes as how many there are.
    env.set(f, kind === 'number' || kind === 'band' ? Number.parseFloat(mine[0]?.value ?? 'NaN') : mine.length);
  }
  for (const t of p.terms ?? []) env.set(t, typeof terms[t] === 'number' ? (terms[t] as number) : Number.parseFloat(String(terms[t] ?? 'NaN')));
  const num = (e: Expr): number => {
    if (typeof e === 'number') return e;
    if (typeof e === 'boolean') return e ? 1 : 0;
    const [op, arg] = Object.entries(e)[0]!;
    const xs = () => (arg as Expr[]).map(num);
    switch (op) {
      case 'var': return env.get(arg as unknown as string) ?? Number.NaN;
      case 'has': { const [f, code] = arg as unknown as [string, string]; return claims.some((c) => c.field === f && (c.code ?? c.value) === code) ? 1 : 0; }
      case '+': return xs().reduce((a, b) => a + b, 0);
      case '-': { const v = xs(); return v.length === 1 ? -v[0]! : v.slice(1).reduce((a, b) => a - b, v[0]!); }
      case '*': return xs().reduce((a, b) => a * b, 1);
      case '/': { const [a, b] = xs(); return b === 0 ? Number.NaN : a! / b!; }
      case 'min': return Math.min(...xs());
      case 'max': return Math.max(...xs());
      case 'round': { const [a, d = 0] = xs(); const k = 10 ** d; return Math.round(a! * k) / k; }
      case 'floor': return Math.floor(xs()[0]!);
      case 'ceil': return Math.ceil(xs()[0]!);
      case 'if': { const [c, a, b] = arg as Expr[]; return truthy(c!) ? num(a!) : num(b!); }
      case 'band': {
        const b = arg as BandArgs;
        const v = num(b.of);
        return b.table.find(([upto]) => v <= upto)?.[1] ?? b.else ?? Number.NaN;
      }
      case 'annuity': {
        const a = arg as AnnuityArgs;
        const P = num(a.principal), r = num(a.rate_pct) / 100 / 12, n = num(a.years) * 12;
        return r === 0 ? P / n : (P * r) / (1 - (1 + r) ** -n);
      }
      default: return truthy(e) ? 1 : 0;
    }
  };
  const truthy = (e: Expr): boolean => {
    if (typeof e === 'boolean') return e;
    if (typeof e === 'number') return e !== 0;
    const [op, arg] = Object.entries(e)[0]!;
    const xs = () => (arg as Expr[]).map(num);
    switch (op) {
      case '<': { const [a, b] = xs(); return a! < b!; }
      case '<=': { const [a, b] = xs(); return a! <= b!; }
      case '>': { const [a, b] = xs(); return a! > b!; }
      case '>=': { const [a, b] = xs(); return a! >= b!; }
      case '==': { const [a, b] = xs(); return a === b; }
      case '!=': { const [a, b] = xs(); return a !== b; }
      case 'and': return (arg as Expr[]).every(truthy);
      case 'or': return (arg as Expr[]).some(truthy);
      case 'not': return !truthy((arg as Expr[])[0]!);
      default: { const v = num(e); return Number.isFinite(v) && v !== 0; }
    }
  };
  for (const [k, e] of Object.entries(p.let ?? {})) env.set(k, num(e));
  const eligible = truthy(p.eligible);
  const outputs: Record<string, number> = {};
  for (const [k, e] of Object.entries(p.outputs)) {
    const v = num(e);
    outputs[k] = Number.isFinite(v) ? Math.round(v * 100) / 100 : Number.NaN;
  }
  // Missing data or a broken sum is "not eligible", never a made-up number.
  return { eligible: eligible && Object.values(outputs).every(Number.isFinite), outputs };
}
