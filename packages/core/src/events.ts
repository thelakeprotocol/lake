/** Every observable thing that happens in the Lake. Events carry ids, kinds and counts — never record contents. */
export const EVENT_KINDS = [
  'house.joined', 'house.left', 'agent.registered', 'knock', 'offer', 'counter', 'decision',
  'agreement.signed', 'grant.issued', 'grant.revoked', 'approval.requested', 'approval.answered',
  'payment.settled', 'attack.blocked', 'agent.quarantined', 'guild.formed', 'study.result', 'compute.done', 'record.moved',
  'intent.opened', 'quote.made', 'offer.accepted', 'blueprint.published', 'agent.message', 'tally.update',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface LakeEvent {
  id: string;
  kind: EventKind;
  /** ISO timestamp. */
  at: string;
  /** Agent or house that caused the event (card URL or short id). */
  actor: string;
  /** Who it happened to, if anyone. */
  subject?: string;
  /** Numbers and short labels only. Never personal data. */
  data?: Record<string, string | number | boolean>;
}

let seq = 0;
export function makeEvent(kind: EventKind, actor: string, subject?: string, data?: LakeEvent['data'], at = new Date()): LakeEvent {
  return { id: `${at.getTime().toString(36)}-${(seq++).toString(36)}`, kind, at: at.toISOString(), actor, subject, data };
}

/** One plain-English line per event, for the map's log. */
/**
 * Events between a house and the agent it dealt with: who knocked, who was told yes, whose study ran, whose offer
 * was priced. A house is a person's home, so a node may keep the pair privately (reputation, counts) but publishes
 * the event without the counterparty, and without the reasons and purposes that would point at one (SPEC §8): what
 * happened at a door is public, who was at it is not. A public service helping an agent (ethics, inspection) stays
 * visible; sensitive services are quiet anyway. Attacks keep the attacker's key.
 */
/** Events where one party acted for another: the public feed says what happened, never between whom (SPEC §8). */
export const PAIRED_KINDS = new Set<string>(['knock', 'decision', 'approval.requested', 'approval.answered', 'grant.issued', 'compute.done', 'agreement.signed', 'quote.made', 'offer.accepted']);

/** The version of an event anyone may see. */
export function publicView(e: LakeEvent): LakeEvent {
  // Whoever acted: a house, or a specialist (ethics, auditor, payments) serving one agent (run 11 found those named).
  if (!PAIRED_KINDS.has(e.kind) || !e.subject) return e;
  const { reason: _r, purpose: _p, ...data } = e.data ?? {};
  return { ...e, subject: undefined, data };
}

export function describe(e: LakeEvent): string {
  const d = e.data ?? {};
  switch (e.kind) {
    case 'house.joined': return `${e.actor} joined the Lake.`;
    case 'house.left': return `${e.actor} left the Lake.`;
    case 'agent.registered': return `${e.actor} registered (${d.role ?? 'agent'}).`;
    // Reported by the house that was knocked on (actor), about the visitor (subject); or broadcast by a visitor.
    case 'knock': return d.count !== undefined ? `${e.actor} knocked on ${d.count} houses.` : e.subject ? `${e.subject} knocked on ${e.actor}.` : d.decision ? `${e.actor} knocked on a house and was told: ${d.decision}.` : `Someone knocked on ${e.actor}.`;
    case 'offer': return `${e.actor} offered $${d.price} for ${d.fields} (${d.purpose}).`;
    case 'counter': return `${d.members ?? 1} housekeepers countered together: $${d.price}, not $${d.was}.`;
    case 'decision': return e.subject ? `${e.actor} told ${e.subject}: ${d.decision}${d.reason ? ` (${d.reason})` : ''}.` : `${e.actor} answered: ${d.decision}.`;
    case 'agreement.signed': return e.subject ? `${e.actor} and ${e.subject} signed an agreement.` : `${e.actor} signed an agreement.`;
    case 'grant.issued': return e.subject ? `${e.actor} issued a ${d.hours}-hour key to ${e.subject}.` : `${e.actor} issued a ${d.hours}-hour key.`;
    case 'grant.revoked': return `${e.actor} revoked ${d.count ?? 1} key(s). Connections cut.`;
    case 'approval.requested': return e.subject ? `${e.actor} asked its owner about ${e.subject}.` : `${e.actor} asked its owner.`;
    case 'approval.answered': return `The owner of ${e.actor} tapped ${d.answer}.`;
    case 'payment.settled': return `Payments settled $${d.amount} with ${d.count} participant(s).`;
    // Worded for what it is: a quarantined key is the agent's own key (run 21's assistant read "an agent claiming" as an
    // impersonation of that agent); an impersonation names who pretended to be whom.
    case 'attack.blocked': return d.why === 'quarantined' ? `${e.actor} turned away a quarantined key${d.claimed ? ` (its card says ${d.claimed})` : ''}.`
      : d.why === 'impersonation' && d.from ? `${e.actor} blocked ${d.from}, whose offer claimed to come from ${d.claimed}.`
      : `${e.actor} blocked ${d.claimed ? `a message claiming to be from ${d.claimed}` : e.subject}: ${d.why}.`;
    case 'agent.quarantined': return `Immune response: ${d.claimed ? `the key claiming ${d.claimed}` : e.subject} quarantined after ${d.blocks} blocked attempts. No human involved.`;
    case 'guild.formed': return `Guild formed: ${d.members} houses for ${d.tag} now bargain as one.`;
    case 'study.result': return `${e.actor} got its answer from ${d.participants} houses${d.summary ? `: ${d.summary}` : ''}.`;
    case 'compute.done': return `${e.actor} ran ${e.subject ? `${e.subject}'s` : 'a'} certified study inside its pod. Records out: ${d.recordsOut}.`;
    case 'record.moved': return `ALERT: a record left ${e.actor}.`;
    case 'intent.opened': return `${e.actor} asked for offers (${d.group ?? d.pack}). ${d.members ? `${d.members} households in this group.` : ''}`.trim();
    case 'quote.made': return `${e.subject ? `${e.subject}'s offer` : 'An offer'} was worked out inside ${e.actor}. Only its owner sees it.`;
    // A deal reported without its counterparty (SPEC §8): say that something happened, never with whom.
    case 'agent.message': return !e.subject ? (d.kind === 'payment' ? `${e.actor} made a payment.` : d.kind === 'deal' ? `${e.actor} made a deal.` : `${e.actor} sent a message.`)
      : d.kind === 'payment' ? `${e.actor} paid ${e.subject} ${!d.unit || d.unit === 'USD' ? `$${d.amount}` : `${d.amount} ${d.unit}`}.` : `${e.actor} sent ${e.subject} a ${d.kind} message.`;
    case 'tally.update': return d.state === 'triggered' ? `A pledge reached its threshold: ${d.count} signed, and every signer was told at once.` : d.state === 'lapsed' ? 'A pledge ran out of time below its threshold; its signers stay unknown.' : `A blind tally: ${d.count} of ${d.threshold} signed. Nobody knows who.`;
    case 'blueprint.published': return `${e.actor} published a blueprint: ${d.name} (${d.tag}). Any agent can build it.`;
    case 'offer.accepted': return `The owner of ${e.actor} accepted ${e.subject ? `${e.subject}'s` : 'an'} offer${d.released ? ` and released ${d.released} file(s) to it` : ''}.`;
  }
}
