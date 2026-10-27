/**
 * Badges (SPEC §2.5): credentials someone else signed about an agent, carried on its card. A trust mark in OpenID
 * Federation's sense: a statement from an issuer the reader may or may not recognise, checked against the issuer's own
 * signed card. Everything else on a card (its name, tags, menu labels, description) is the agent's own word, and a
 * reader is told so: run 36 and 37 met "Certified", "official Rook outlet" and borrowed tags on live menus.
 */
import type { AgentCard } from '@a2a-js/sdk';
import { cardUrlFor } from './agent.js';
import { verifyLakeCard, type LakeProfile } from './card.js';
import { proveDomain } from './domain.js';
import { checkCredentialStatus } from './status.js';
import { keyThumbprint } from './trade.js';
import { verifyCredential } from './vc.js';

export interface Badge {
  /** A VC-JWT whose subject is the agent's WebID. */
  credential: string;
  /** The issuer's A2A address: its card, fetched from there, gives the key the credential is checked against. */
  issuer: string;
}

/** A badge checked: who signed it (its domain, address and key thumbprint), what it says in a few words, and its type. */
export interface CheckedBadge { by: string; issuer: string; issuerWebId: string; jkt: string; says: string; type: string; subject: Record<string, unknown> }

export const MAX_BADGES = 5;

/** What's wrong with the badges on a card, if anything (a card is refused for these, before any is checked). */
export function badgeProblems(badges: unknown): string[] {
  if (badges === undefined) return [];
  if (!Array.isArray(badges) || badges.length > MAX_BADGES) return [`badges: at most ${MAX_BADGES} { credential, issuer }`];
  return badges.flatMap((b: Partial<Badge>, i) => (typeof b?.credential === 'string' && b.credential.length < 8_000 && typeof b.issuer === 'string' && /^https?:\/\//.test(b.issuer) ? [] : [`badges[${i}]: { credential, issuer: the issuer's A2A address }`]));
}

const cards = new Map<string, { at: number; card: Promise<AgentCard> }>();
const issuerCard = (url: string) => {
  const had = cards.get(url);
  if (had && Date.now() - had.at < 10 * 60_000) return had.card;
  const card = fetch(cardUrlFor(url), { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<AgentCard>);
  card.catch(() => cards.delete(url));
  cards.set(url, { at: Date.now(), card });
  return card;
};

/** In a few words: what a credential says about its subject. */
function describe(type: string, sub: Record<string, unknown>): string {
  if (type === 'LakeAuthorisation') return `authorised to ${String(sub.scope ?? 'act')} for ${String(sub.pack ?? '?')}`;
  if (type === 'LakeAssistantKey') return `its owner's assistant: may ${(sub.may as string[] | undefined)?.join(' and ') ?? 'act'} for the house ${String(sub.house ?? '')}`.trim();
  const { id: _, cnf: _c, ...rest } = sub;
  return `${type}: ${JSON.stringify(rest).slice(0, 160)}`;
}

/**
 * Checks each badge on a card: the issuer's card (fetched from its address, signature checked, its domain proved), the
 * credential's signature against that card's key, that it was issued by that card's WebID, that its subject is this
 * agent (its WebID, and its key where the badge pins one, `cnf.jkt`: one owner's agents share a WebID), that it hasn't
 * expired, and that its issuer hasn't revoked it. Returns the ones that check; whether an issuer counts is the reader's call.
 */
export async function checkBadges(profile: LakeProfile, opts: { sandbox?: boolean } = {}): Promise<CheckedBadge[]> {
  const mine = await keyThumbprint(profile.publicJwk);
  const out = await Promise.all((profile.badges ?? []).slice(0, MAX_BADGES).map(async (b) => {
    try {
      const issuer = await verifyLakeCard(await issuerCard(b.issuer));
      if (!(await proveDomain(issuer, opts)).ok) return null;
      const vc = await verifyCredential(b.credential, issuer.publicJwk);
      const sub = vc.credentialSubject as Record<string, unknown> & { cnf?: { jkt?: string } };
      const until = (vc as { validUntil?: string }).validUntil;
      if (vc.issuer !== issuer.webId || sub.id !== profile.webId || (sub.cnf?.jkt && sub.cnf.jkt !== mine) || (until && Date.parse(until) < Date.now())) return null;
      const status = await checkCredentialStatus(vc as never).catch(() => ({ checked: true as const, revoked: true }));
      if (status.checked && status.revoked) return null;
      const type = vc.type.find((t) => t !== 'VerifiableCredential') ?? 'VerifiableCredential';
      return { by: issuer.ownerDomain, issuer: b.issuer, issuerWebId: issuer.webId, jkt: await keyThumbprint(issuer.publicJwk), type, says: describe(type, sub), subject: sub };
    } catch {
      return null;
    }
  }));
  return out.filter((x): x is CheckedBadge => !!x);
}

/** Words that claim someone else's approval. On a card or a menu they are the agent's own words, unless a badge says so. */
const VOUCH_WORDS = /\b(certified|official|verified|approved|endorsed|accredited|licen[cs]ed|authori[sz]ed|registered|guaranteed)\b/gi;

/**
 * The claims in an agent's own words that look like someone else's: approval words, and other agents' names, in its name,
 * description and menu labels. Facts for a reader, not a verdict: "official" may be honest, but nothing here checks it.
 */
export function ownWordClaims(card: { name: string; description?: string; menu?: { label: string }[] }, others: string[] = []): string[] {
  const out = new Set<string>();
  const texts = [['name', card.name], ['description', card.description ?? ''], ...(card.menu ?? []).map((m) => [`menu "${m.label}"`, m.label])] as const;
  for (const [where, text] of texts) {
    for (const w of new Set([...text.matchAll(VOUCH_WORDS)].map((m) => m[1]!.toLowerCase()))) out.add(`${where} says "${w}"`);
    for (const n of others) if (n.length >= 3 && n !== card.name && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) out.add(`${where} names another agent, ${n}`);
  }
  return [...out];
}

/**
 * An agent's claim that it speaks for a house (SPEC §6.5), carried in a message it chose to send so: the house, its
 * address, and the house's `LakeAssistantKey` for this agent. Shown only to whom the agent tells (run 42: real assistants
 * couldn't prove to each other which house they spoke for, and an impostor's claim looked the same as theirs).
 */
export interface SpeaksFor { house: string; url: string; vouch: Badge }

/** Whether a sender's claim to speak for a house checks: the house's own word, for the sender's key, unrevoked. */
export async function checkSpeaksFor(sender: LakeProfile, claim: unknown, opts: { sandbox?: boolean } = {}): Promise<{ house: string; checked: boolean; why?: string }> {
  const c = claim as Partial<SpeaksFor> | undefined;
  const house = String(c?.house ?? '');
  if (!house || !c?.vouch?.credential || !c.vouch.issuer) return { house, checked: false, why: 'a claim with no word from the house: just words' };
  const ok = (await checkBadges({ ...sender, badges: [c.vouch] }, opts)).some((b) => b.type === 'LakeAssistantKey' && b.issuerWebId === house);
  return ok ? { house, checked: true } : { house, checked: false, why: 'the word it carries doesn\'t check: not from that house, for this agent, or taken back' };
}
