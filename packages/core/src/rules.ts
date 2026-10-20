import { parse } from 'yaml';
import { DEFAULT_GRANT_HOURS } from './lake.js';
import type { Offer } from './offer.js';

/**
 * rules.yaml — the owner's standing rules, the note on the fridge.
 * Rules are checked top to bottom; the first rule whose `match` fits decides.
 */
export interface Rules {
  owner: string;
  device?: string;
  default: 'join' | 'decline' | 'ask';
  rules: Rule[];
  negotiation?: { join_collectives?: boolean };
  tags?: string[];
  /** Whose signatures count. An approval from anyone not listed counts as no approval. */
  trust?: { ethics?: string[]; auditors?: string[]; issuers?: string[]; payments?: string[] };
}

export interface Rule {
  match: Partial<Record<MatchKey, string | boolean>>;
  allow_fields?: string[];
  deny_fields?: string[];
  min_price_usd?: number;
  retention?: string;
  grant_hours?: number;
  decision: 'join' | 'decline' | 'ask';
}

const MATCH_KEYS = ['purpose', 'requester', 'sponsor_verified', 'ethics_approved', 'audit_certified'] as const;
type MatchKey = (typeof MATCH_KEYS)[number];
const DECISIONS = ['join', 'decline', 'ask'];

export class RulesError extends Error {}

/** Parse and validate rules.yaml. Unknown keys are errors: a typo must never silently widen access. */
export function parseRules(text: string): Rules {
  const raw = parse(text) as Partial<Rules> | null;
  if (!raw || typeof raw !== 'object') throw new RulesError('rules.yaml is empty');
  if (!raw.owner) throw new RulesError('rules.yaml needs an owner');
  const def = raw.default ?? 'ask';
  if (!DECISIONS.includes(def)) throw new RulesError(`default must be join, decline or ask (got ${def})`);
  const rules = (raw.rules ?? []).map((r, i) => {
    if (!r || !DECISIONS.includes(r.decision)) throw new RulesError(`rule ${i + 1}: decision must be join, decline or ask`);
    for (const k of Object.keys(r.match ?? {})) {
      if (!(MATCH_KEYS as readonly string[]).includes(k)) throw new RulesError(`rule ${i + 1}: unknown match key "${k}" (allowed: ${MATCH_KEYS.join(', ')})`);
    }
    return { ...r, match: r.match ?? {} };
  });
  for (const k of Object.keys(raw.trust ?? {})) {
    if (!['ethics', 'auditors', 'issuers', 'payments'].includes(k)) throw new RulesError(`trust: unknown list "${k}" (allowed: ethics, auditors, issuers, payments)`);
  }
  return { ...raw, owner: raw.owner, default: def, rules } as Rules;
}

export type Decision =
  | { decision: 'join'; rule: number | null; reason: string; grantHours: number; fields: string[] }
  | { decision: 'decline'; rule: number | null; reason: string }
  | { decision: 'ask'; rule: number | null; reason: string }
  | { decision: 'counter'; rule: number; reason: string; counter: { fields: string[]; priceUsd: number } };

function matches(m: Rule['match'], o: Offer): boolean {
  const facts: Record<MatchKey, string | boolean> = {
    purpose: o.purpose,
    requester: o.requester,
    sponsor_verified: o.credentials.sponsorVerified,
    ethics_approved: o.credentials.ethicsApproved,
    audit_certified: o.credentials.auditCertified,
  };
  return Object.entries(m).every(([k, v]) => facts[k as MatchKey] === v);
}

/**
 * Decide an offer. Pure and deterministic: same rules + same offer = same answer.
 * The offer's free-text note is never read here, so prompt injection has nothing to grab.
 */
export function evaluate(rules: Rules, offer: Offer): Decision {
  for (const [i, r] of rules.rules.entries()) {
    if (!matches(r.match, offer)) continue;
    const n = i + 1;
    if (r.decision === 'decline') return { decision: 'decline', rule: n, reason: `your rule ${n} declines ${offer.purpose} requests` };
    if (r.decision === 'ask') return { decision: 'ask', rule: n, reason: `your rule ${n} says ask you first about ${offer.purpose} requests` };

    const denied = offer.fields.filter((f) => r.deny_fields?.includes(f));
    const unlisted = r.allow_fields ? offer.fields.filter((f) => !r.allow_fields!.includes(f) && !denied.includes(f)) : [];
    const cheap = r.min_price_usd !== undefined && offer.priceUsd < r.min_price_usd;
    const keeps = r.retention === 'none' && offer.retention !== 'none';

    if (keeps) return { decision: 'decline', rule: n, reason: `it wants to keep your data (${offer.retention}); your rule ${n} allows no retention` };
    if (unlisted.length) return { decision: 'ask', rule: n, reason: `looks like a study you'd join, but it also wants ${list(unlisted)}` };
    if (denied.length || cheap) {
      const counter = { fields: offer.fields.filter((f) => !denied.includes(f)), priceUsd: Math.max(offer.priceUsd, r.min_price_usd ?? 0) };
      const why = [denied.length ? `drop ${list(denied)}` : '', cheap ? `pay at least $${r.min_price_usd}` : ''].filter(Boolean).join(' and ');
      if (rules.negotiation?.join_collectives && counter.fields.length) return { decision: 'counter', rule: n, reason: `you'd join if they ${why}`, counter };
      return { decision: 'ask', rule: n, reason: `you'd normally join, but they'd need to ${why}` };
    }
    return { decision: 'join', rule: n, reason: `matches your rule ${n}`, grantHours: r.grant_hours ?? DEFAULT_GRANT_HOURS, fields: offer.fields };
  }
  const d = rules.default;
  const reason = `no rule covers ${offer.purpose} requests from ${offer.requester}; your default is ${d}`;
  // A default of "join" still needs fields to be bounded: with no rule, there is no allow list, so ask instead.
  if (d === 'join') return { decision: 'ask', rule: null, reason: `${reason}, but no rule limits the fields, so asking you` };
  return { decision: d, rule: null, reason };
}

/**
 * Many housekeepers that countered the same offer bargain as one bloc.
 * The bloc asks for the highest minimum price and only fields every member accepts.
 */
export function collectiveCounter(counters: { fields: string[]; priceUsd: number }[]): { fields: string[]; priceUsd: number; members: number } | null {
  if (!counters.length) return null;
  const fields = counters.map((c) => c.fields).reduce((a, b) => a.filter((f) => b.includes(f)));
  if (!fields.length) return null;
  return { fields, priceUsd: Math.ceil(Math.max(...counters.map((c) => c.priceUsd))), members: counters.length };
}

const list = (xs: string[]) => (xs.length === 1 ? xs[0]! : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
