/** Every observable thing that happens in the Lake. Events carry ids, kinds and counts — never record contents. */
export const EVENT_KINDS = [
  'house.joined', 'house.left', 'agent.registered', 'knock', 'offer', 'counter', 'decision',
  'agreement.signed', 'grant.issued', 'grant.revoked', 'approval.requested', 'approval.answered',
  'payment.settled', 'attack.blocked', 'agent.quarantined', 'guild.formed', 'study.result', 'record.moved',
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
export function describe(e: LakeEvent): string {
  const d = e.data ?? {};
  switch (e.kind) {
    case 'house.joined': return `${e.actor} joined the Lake.`;
    case 'house.left': return `${e.actor} left the Lake.`;
    case 'agent.registered': return `${e.actor} registered (${d.role ?? 'agent'}).`;
    case 'knock': return `${e.actor} knocked on ${e.subject ?? `${d.count} houses`}.`;
    case 'offer': return `${e.actor} offered $${d.price} for ${d.fields} (${d.purpose}).`;
    case 'counter': return `${d.members ?? 1} housekeepers countered together: $${d.price}, not $${d.was}.`;
    case 'decision': return `${e.actor} said ${d.decision}${d.reason ? `: ${d.reason}` : '.'}`;
    case 'agreement.signed': return `${e.actor} and ${e.subject} signed an agreement.`;
    case 'grant.issued': return `${e.actor} issued a ${d.hours}-hour key to ${e.subject}.`;
    case 'grant.revoked': return `${e.actor} revoked ${d.count ?? 1} key(s). Connections cut.`;
    case 'approval.requested': return `${e.actor} asked its owner about ${e.subject}.`;
    case 'approval.answered': return `The owner of ${e.actor} tapped ${d.answer}.`;
    case 'payment.settled': return `Payments settled $${d.amount} with ${d.count} participant(s).`;
    case 'attack.blocked': return `${e.actor} blocked ${e.subject}: ${d.why}.`;
    case 'agent.quarantined': return `${e.subject} quarantined after ${d.blocks} blocked attempts. No human involved.`;
    case 'guild.formed': return `Guild formed: ${d.members} houses for ${d.tag} now bargain as one.`;
    case 'study.result': return `Study answered from ${d.participants} houses. Records moved: ${d.recordsMoved}.`;
    case 'record.moved': return `ALERT: a record left ${e.actor}.`;
  }
}
