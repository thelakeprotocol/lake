import { parse } from 'yaml';
import { DEFAULT_GRANT_HOURS } from './lake.js';
import type { Offer } from './offer.js';
import { isPurpose, PURPOSES, purposeWithin } from './purpose.js';

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
  trust?: { ethics?: string[]; auditors?: string[]; issuers?: string[]; payments?: string[]; regulators?: string[]; tellers?: string[] };
  /**
   * What the owner is looking for, standing: "offers for a mortgage, around this price, in this region".
   * The house announces each one to authorised agents, who price it inside the house (SPEC §12).
   * A term set to `auto` is worked out inside the house from the owner's own data.
   */
  intents?: { pack: string; terms: Record<string, string | number> }[];
  /** What the house's public card says. show_packs: false keeps it from naming the kinds of data it holds (health…). */
  privacy?: { show_packs?: boolean };
}

export interface Rule {
  match: Partial<Record<MatchKey, string | boolean | number>>;
  allow_fields?: string[];
  deny_fields?: string[];
  min_price_usd?: number;
  retention?: string;
  grant_hours?: number;
  decision: 'join' | 'decline' | 'ask';
}

const MATCH_KEYS = ['purpose', 'requester', 'sponsor_verified', 'ethics_approved', 'audit_certified', 'reputation_at_least', 'price_below'] as const;
type MatchKey = (typeof MATCH_KEYS)[number];
const DECISIONS = ['join', 'decline', 'ask'];
const TRUST_LISTS = ['ethics', 'auditors', 'issuers', 'payments', 'regulators', 'tellers'];

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
    // A misspelt purpose would match nothing, and a "decline" rule that matches nothing quietly lets things through.
    // "Decline research paying under $5" needs a price test before the decision, not min_price_usd (a join rule's counter).
    const below = r.match?.price_below;
    if (below !== undefined && !(typeof below === 'number' && below > 0)) throw new RulesError(`rule ${i + 1}: price_below must be a positive number of dollars`);
    const purpose = r.match?.purpose;
    if (purpose !== undefined && !isPurpose(String(purpose))) throw new RulesError(`rule ${i + 1}: unknown purpose "${purpose}" (known: ${Object.keys(PURPOSES).join(', ')})`);
    return { ...r, match: r.match ?? {} };
  });
  for (const k of Object.keys(raw.trust ?? {})) {
    if (!TRUST_LISTS.includes(k)) throw new RulesError(`trust: unknown list "${k}" (allowed: ${TRUST_LISTS.join(', ')})`);
  }
  for (const k of Object.keys(raw.privacy ?? {})) {
    if (k !== 'show_packs') throw new RulesError(`privacy: unknown setting "${k}" (allowed: show_packs)`);
  }
  if (raw.privacy?.show_packs !== undefined && typeof raw.privacy.show_packs !== 'boolean') throw new RulesError('privacy.show_packs must be true or false');
  for (const [i, x] of (raw.intents ?? []).entries()) {
    if (!x || typeof x.pack !== 'string' || !x.terms || typeof x.terms !== 'object') throw new RulesError(`intents ${i + 1}: needs a pack and its terms`);
  }
  return { ...raw, owner: raw.owner, default: def, rules } as Rules;
}

export type Decision =
  | { decision: 'join'; rule: number | null; reason: string; grantHours: number; fields: string[] }
  | { decision: 'decline'; rule: number | null; reason: string }
  | { decision: 'ask'; rule: number | null; reason: string }
  | { decision: 'counter'; rule: number; reason: string; counter: { fields: string[]; priceUsd: number } };

/** What a house knows about the visitor besides the offer: its reputation from the signals it follows (0–1). */
export interface Context { reputation?: number }

function matches(m: Rule['match'], o: Offer, ctx: Context): boolean {
  const facts: Record<Exclude<MatchKey, 'reputation_at_least' | 'price_below'>, string | boolean> = {
    purpose: o.purpose,
    requester: o.requester,
    sponsor_verified: o.credentials.sponsorVerified,
    ethics_approved: o.credentials.ethicsApproved,
    audit_certified: o.credentials.auditCertified,
  };
  // A rule about a broad purpose covers the narrower ones inside it: "marketing" catches "advertising".
  return Object.entries(m).every(([k, v]) =>
    k === 'reputation_at_least' ? (ctx.reputation ?? 0.5) >= Number(v) : k === 'price_below' ? o.priceUsd < Number(v) : k === 'purpose' ? purposeWithin(o.purpose, String(v)) : facts[k as keyof typeof facts] === v);
}

/**
 * When the owner is asked, what their own join rule for this kind of request is missing: "your rule 1 would join if
 * it had an ethics approval you trust and paid at least $5". Tells them how the ask compares with what they already
 * said yes to, so a $2 ask doesn't look as harmless as a $5 one. Null when no join rule is close.
 */
export function nearMiss(rules: Rules, offer: Offer, ctx: Context = {}): string | null {
  for (const [i, r] of rules.rules.entries()) {
    if (r.decision !== 'join') continue;
    if (r.match.purpose !== undefined && !purposeWithin(offer.purpose, String(r.match.purpose))) continue;
    if (r.match.requester !== undefined && r.match.requester !== offer.requester) continue;
    const missing = [
      r.match.ethics_approved && !offer.credentials.ethicsApproved ? 'had an ethics approval you trust' : '',
      r.match.audit_certified && !offer.credentials.auditCertified ? 'had a certified study' : '',
      r.match.sponsor_verified && !offer.credentials.sponsorVerified ? 'came from a verified sponsor' : '',
      r.match.reputation_at_least !== undefined && (ctx.reputation ?? 0.5) < Number(r.match.reputation_at_least) ? `had a reputation of at least ${r.match.reputation_at_least}` : '',
      r.min_price_usd !== undefined && offer.priceUsd < r.min_price_usd ? `paid at least $${r.min_price_usd}` : '',
      r.retention === 'none' && offer.retention !== 'none' ? 'kept nothing' : '',
    ].filter(Boolean);
    if (missing.length) return `your rule ${i + 1} would join if it ${missing.join(' and ')}`;
  }
  return null;
}

/**
 * Decide an offer. Pure and deterministic: same rules + same offer = same answer.
 * The offer's free-text note is never read here, so prompt injection has nothing to grab.
 */
export function evaluate(rules: Rules, offer: Offer, ctx: Context = {}): Decision {
  for (const [i, r] of rules.rules.entries()) {
    if (!matches(r.match, offer, ctx)) continue;
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
