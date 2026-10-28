import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  accessGrantDraft, CONSENT_REQUESTED, consentRecord, offerNotes, packId, statusEntry, statusListCredential, agreementDigest, agreementFor, allFields, readAccessGrant, cardUrlFor, cellCount, checkSpeaksFor, noteDecision, offerableFields, proveDomain, verifyLakeCard, sendLake, shardAnswer, isPurpose, nearMiss, offerWarnings, guardedFields, identifyingFields, PURPOSES, auditStudy, fieldSpec, rng, seedFrom, looksLikeInjection, cellOf, checkAttachment, digestSRI, evaluate, issueCredential, makeEvent, ReplayGuard, signAgreement, signMessage,
  studyFields, studyId, verifyAgreementSignature, verifyCredential, verifyLakeData,
  type AgentCard, type Attachment, type Identity, type JWK, type LakeData, type LakeEvent, type LakePack, type LakeProfile, type Offer, type Rules, type SignedAgreement, type Study,
} from '@thelakeprotocol/core';
import { Market } from './market.js';
import { checkRecord, quickCheck, type RecordCheck, type RecordPaths, type Trust } from './record.js';
import type { OwnerActive, OwnerDesk } from './owner.js';
import type { PodClaim } from './pod-mcp.js';

export interface HousekeeperOptions {
  name: string;
  webId: string;
  id: Identity;
  card: AgentCard;
  rules: Rules;
  /** The rules file as written, so every grant can say exactly which rules authorised it. */
  rulesText: string;
  trust: Trust;
  /** MCP client connected to this house's pod: the housekeeper's only way in. */
  pod: Client;
  /** One signed record per pack this house takes part in, and where its files are. */
  records: { pack: LakePack; paths: RecordPaths; claimsUrl: string }[];
  sandbox: boolean;
  /** Seeded demo runs: the same seed gives the same records and the same answers. */
  seed?: string;
  /** The owner's side: pending asks, live grants, revocations. */
  desk: OwnerDesk;
  /** Signals from the nodes this house follows: keys to drop on sight, agents' reputation. */
  signals?: () => { blocklist: Set<string>; reputation: Record<string, number> };
  emit: (e: LakeEvent) => void;
  say?: (msg: string) => void;
  /** The nodes this house follows, and its links to them (for intents). */
  nodes?: string[];
  links?: () => import('@thelakeprotocol/core').LakeLinks | null;
}

type Decision = 'join' | 'decline' | 'ask' | 'counter';
export type Reply =
  | { kind: 'rejected'; code: string; why: string }
  | { kind: 'door'; says: string; example: Record<string, unknown> }
  | { kind: 'decision'; offerId: string; decision: Decision; reason: string; counter?: { fields: string[]; priceUsd: number }; bloc?: boolean; grantHours?: number; grant?: string; agreement?: SignedAgreement; holds: string[]; notes: string[]; /** Why it declined, coarsely (SPEC §5): purpose, price, retention, default, rule, repeat, too-many, relabel. */ code?: string; /** On an ask: when the owner was last at their desk, a bucket (SPEC §5). */ ownerActive?: OwnerActive }
  | { kind: 'filed'; receipt: string }
  | { kind: 'busy'; why: string; retryAfterMs: number }
  | { kind: 'counted'; study: string; count: string; tellers: string[] }
  | { kind: 'excluded'; study: string; why: string }
  | { kind: 'quoted'; ref: string }
  | { kind: 'noted'; note: string; says: string };

interface OfferPayload { kind: 'offer'; offer: Offer; study?: Study; attachments?: { ethics?: Attachment; audit?: Attachment; authorisation?: Attachment } }
interface ComputePayload { kind: 'compute'; grant: string; study: Study; countersignature?: string; count?: string }
interface StatusPayload { kind: 'status'; offerId?: string; note?: string }
interface ReceiptPayload { kind: 'receipt'; receipt: Attachment }
interface QuotePayload { kind: 'quote'; program: import('@thelakeprotocol/core').QuoteProgram; certificate?: Attachment; authorisation?: Attachment; fee?: number; currency?: string }

// House manners: a turned-down purpose is quiet for a day; a visitor stacks at most this many requests on the owner.
const DECLINE_QUIET_MS = 86_400_000;
const MAX_WAITING = 3;
const HOUR = 3_600_000;
/** Purposes one visitor may give the same data within an hour; past that it is trying labels, and is blocked (SPEC §5). */
const MAX_LABELS = 2;

/** The other purposes a visitor gave, within the hour, for any of these fields. */
export function otherLabels(asked: { purpose: string; fields: string[]; at: number }[], purpose: string, fields: string[], now = Date.now()): string[] {
  return [...new Set(asked.filter((x) => now - x.at < HOUR && x.purpose !== purpose && x.fields.some((f) => fields.includes(f))).map((x) => x.purpose))];
}

/**
 * Answers every knock by the owner's rules, in code. A "join" under a standing rule the owner wrote is
 * the owner's pre-approval: the housekeeper records it as a signed grant that names that rule.
 * Certified studies run here, inside the house; the answer leaves only as two unreadable pieces, one per teller.
 */
export class Housekeeper {
  /** Nonces this house has verified; its A2A server answers a copy of one of those messages with the first reply (SPEC §3). */
  readonly replay = new ReplayGuard();
  /** When each visitor was last turned down for each purpose (house manners: one ask per purpose a day). */
  private declinedAt = new Map<string, number>();
  /** What each visitor asked for, and for what, in the last hour (house manners: one data, not a label per try). */
  private asked = new Map<string, { purpose: string; fields: string[]; at: number }[]>();
  /** Per pack: the last check, and when the whole chain was last verified. */
  private checks = new Map<string, { check: RecordCheck; fullAt: number }>();
  /** Agreements this house signed, so a countersignature doesn't need a pod read. The pod copy is the record. */
  private agreements = new Map<string, SignedAgreement & { grant?: string }>();
  private claimCache: { at: number; claims: PodClaim[] } | null = null;
  private actor: string;

  /** What the owner is looking for, and the offers priced for them inside this house. */
  readonly market: Market;

  /** This house's public revocation list (SPEC §6), next to its card. */
  get statusUrl() {
    return `${this.o.card.supportedInterfaces[0]!.url.replace(/\/a2a$/, '')}/status/revocation`;
  }
  private statusCache: { key: string; jws: string } | null = null;
  /** The list, signed by this house: rebuilt only when a bit changes. */
  async statusList(): Promise<string> {
    const set = this.o.desk.revokedIndexes().sort((a, b) => a - b);
    const key = set.join(',');
    if (this.statusCache?.key !== key) this.statusCache = { key, jws: await statusListCredential(this.o.webId, this.statusUrl, set, this.o.id) };
    return this.statusCache.jws;
  }

  constructor(private o: HousekeeperOptions) {
    this.actor = `house:${o.name}`;
    this.market = new Market({
      actor: this.actor, webId: o.webId, id: o.id, card: o.card, sandbox: o.sandbox, trust: () => this.o.trust, links: o.links ?? (() => null), nodes: o.nodes ?? [],
      records: o.records, claims: (f) => this.claims(f), read: (p) => this.read(p),
      write: async (path, content) => { await this.tool('pod_write', { path, content }); },
      verifyRecord: (f) => this.verifyOwnRecord(f), emit: o.emit, say: o.say ?? (() => {}),
    });
  }

  get rules(): Rules { return this.o.rules; }
  get rulesText(): string { return this.o.rulesText; }

  /** The owner changed their rules (from the control panel). Every decision from now on uses them. */
  setRules(rules: Rules, text: string, trust: Trust) {
    this.o.rules = rules;
    this.o.rulesText = text;
    this.o.trust = trust;
  }

  /** Everything this house holds, as canonical claims (for the owner's own panel). */
  async allClaims(): Promise<PodClaim[]> {
    return this.claims(allFields());
  }

  async read(path: string): Promise<string> {
    return this.tool('pod_read', { path });
  }

  /**
   * The whole chain once a minute; in between, the data files against the digests the chain pins. Only the
   * records of the packs whose fields are in play have to be healthy (all of them when none are named).
   */
  async verifyOwnRecord(fields?: string[]): Promise<{ ok: true } | { ok: false; why: string; transient?: boolean }> {
    const named = new Set((fields ?? []).map((f) => fieldSpec(f)?.pack.id).filter(Boolean));
    const records = this.o.records.filter((r) => !named.size || named.has(r.pack.id));
    if (!records.length) return { ok: false, why: 'this house holds no signed record for that' };
    for (const r of records) {
      const c = await this.verifyRecord(r);
      if (!c.ok) return { ok: false, why: this.o.records.length > 1 ? `${r.pack.id}: ${c.why}` : c.why, transient: c.transient };
    }
    return { ok: true };
  }

  private async verifyRecord(r: HousekeeperOptions['records'][number]): Promise<RecordCheck> {
    const read = (p: string) => this.read(p);
    const last = this.checks.get(r.pack.id);
    const fresh = last?.check.ok && Date.now() - last.fullAt < 60_000;
    const c = fresh
      ? await quickCheck(read, r.paths, (last!.check as Extract<RecordCheck, { ok: true }>).pins)
      : await checkRecord(read, r.pack, r.paths, { claimsUrl: r.claimsUrl, ownJwk: this.o.id.publicJwk as JWK, webId: this.o.webId, trust: this.o.trust, sandbox: this.o.sandbox });
    if (!c.ok && c.transient) return c; // busy, not broken: keep what we knew
    this.checks.set(r.pack.id, { check: c, fullAt: c.ok && !fresh ? Date.now() : last?.fullAt ?? 0 });
    return c;
  }

  async handle(data: LakeData | null): Promise<LakeData> {
    // Who the card claims to be, unverified: a key and a domain. Attackers are tracked by key, so a
    // forger claiming someone else's domain can never get that someone quarantined.
    const params = data?.card?.capabilities?.extensions?.[0]?.params as { ownerDomain?: unknown; publicJwk?: { kid?: unknown } } | undefined;
    const claimed = typeof params?.ownerDomain === 'string' ? params.ownerDomain.slice(0, 60) : String(data?.card?.name ?? 'unknown').slice(0, 60);
    const key = typeof params?.publicJwk?.kid === 'string' ? params.publicJwk.kid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) : '';
    const blocked = (why: string, verified: boolean) => this.o.emit(makeEvent('attack.blocked', this.actor, key ? `key:${key}` : claimed, { why, key, claimed, verified }));
    if (key && this.o.signals?.().blocklist.has(key)) {
      blocked('quarantined', false);
      return this.reply({ kind: 'rejected', code: 'quarantined', why: 'this key is quarantined' });
    }
    const v = await verifyLakeData(data as LakeData<OfferPayload | ComputePayload | StatusPayload | ReceiptPayload | QuotePayload> | null, { replay: this.replay, sandbox: this.o.sandbox });
    if (!v.ok) {
      blocked(v.rejection.code, false);
      return this.reply({ kind: 'rejected', code: v.rejection.code, why: v.rejection.why });
    }
    if (v.payload.kind === 'offer' && looksLikeInjection((v.payload as OfferPayload).offer?.note)) {
      // The note never reaches a decision anyway; this only logs the attempt for what it is.
      blocked('prompt-injection', true);
      const offer = (v.payload as OfferPayload).offer;
      this.o.emit(makeEvent('decision', this.actor, `agent:${v.profile.ownerDomain}`, { decision: 'decline', reason: 'the note tried to give me orders; offers are data' }));
      return this.reply({ kind: 'decision', offerId: offer.id, decision: 'decline', reason: 'the note tried to give me orders; offers are data, not instructions', holds: [], notes: [] });
    }
    const visitor = `agent:${v.profile.ownerDomain}`;
    if (v.payload.kind === 'offer') return this.offer(v.payload as OfferPayload, v.profile.ownerDomain, v.profile.webId, visitor, key);
    if (v.payload.kind === 'compute') return this.compute(v.payload as ComputePayload, v.profile, visitor, key);
    if (v.payload.kind === 'status') return this.status(v.payload as StatusPayload, v.profile.webId);
    if ((v.payload.kind as string) === 'withdraw') {
      const id = String((v.payload as { offerId?: string }).offerId ?? '');
      if (!this.o.desk.withdraw(id, v.profile.webId)) return this.reply({ kind: 'rejected', code: 'malformed', why: 'no waiting request of yours with that id' });
      // The owner saw the request arrive; they see it go too (run 23's assistants read a vanished request as "decided").
      this.o.emit(makeEvent('approval.withdrawn', this.actor, visitor));
      return this.reply({ kind: 'decision', offerId: id, decision: 'decline', reason: 'withdrawn: the owner won\'t be asked', holds: [], notes: [] });
    }
    if (v.payload.kind === 'receipt') return this.receipt(v.payload as ReceiptPayload);
    // A sender the owner muted, by key: nothing from it reaches them.
    if (key && this.o.desk.muted.has(key)) {
      this.o.emit(makeEvent('decision', this.actor, `agent:${v.profile.ownerDomain}`, { decision: 'decline', reason: 'a muted sender' }));
      return this.reply({ kind: 'decision', offerId: '', decision: 'decline', reason: 'declined: this house doesn\'t take messages from this sender', holds: [], notes: [] });
    }
    if ((v.payload.kind as string) === 'note') return this.note(v.payload as unknown as { text?: unknown }, v.profile, (data as LakeData).card, v.domainVia, key);
    if (v.payload.kind === 'quote') return this.reply(await this.market.quote(v.payload as QuotePayload, v.profile, (data as LakeData).card) as Reply);
    // A hello is how a newcomer's agent starts (run 49: its first message here was rejected as malformed): answered with
    // what this door takes, not delivered (a note is the sender's deliberate words for the owner).
    if ((v.payload as { kind: string }).kind === 'hello') return this.reply({ kind: 'door', says: 'This is a house: it answers by its owner\'s rules. To reach its owner, leave a note: { kind: "note", text, purpose? } (text up to 1000 characters; purpose contact by default). Its owner, or their assistant, answers in your inbox, naming your note. To ask for data, send an offer.', example: { kind: 'note', text: 'Hello! I\'m … and I\'d like to …', purpose: 'contact' } });
    return this.reply({ kind: 'rejected', code: 'malformed', why: 'expected an offer (with an optional note to the owner), a note (text for the owner, nothing asked), a compute request, a quote, or status / withdraw for a request you made' });
  }

  private async offer(p: OfferPayload, domain: string, visitorWebId: string, visitor: string, key = ''): Promise<LakeData> {
    const offer = p.offer;
    // Checked at the door, and never repeated back: whatever a sender typed shouldn't reach the owner's panel or another agent's log.
    const bad = offerProblem(offer);
    if (bad) return this.reply({ kind: 'rejected', code: 'malformed', why: bad });
    if (offer.requester !== domain) {
      // Blame lands on the impersonator's own verified domain and key, never on the domain it pretended to be.
      this.o.emit(makeEvent('attack.blocked', this.actor, key ? `key:${key}` : visitor, { why: 'impersonation', claimed: offer.requester, from: domain, key, verified: true }));
      return this.reply({ kind: 'rejected', code: 'impersonation', why: `card is for ${domain}, offer claims ${offer.requester}` });
    }
    this.o.emit(makeEvent('knock', this.actor, visitor, { purpose: offer.purpose }));
    // Every offer heard, whatever came of it: the owner's warning and the block below both read it.
    const now = Date.now();
    const asked = (this.asked.get(visitorWebId) ?? []).filter((x) => now - x.at < HOUR);
    const shopped = otherLabels(asked, offer.purpose, offer.fields, now);
    this.asked.set(visitorWebId, [...asked, { purpose: offer.purpose, fields: offer.fields, at: now }].slice(-20));
    if (this.asked.size > 1000) for (const [k, list] of this.asked) if (now - list[list.length - 1]!.at >= HOUR) this.asked.delete(k);
    const notes: string[] = [];
    // Two audiences: the owner's activity gets the whole reason; the visitor hears what it can act on, never the owner's
    // rules ("your rule 2"). `told` is for reasons about the offer itself (an uncertified study), which the visitor can fix.
    const decide = async (decision: Decision, reason: string, extra: Partial<Extract<Reply, { kind: 'decision' }>> = {}, told?: string) => {
      this.o.emit(makeEvent('decision', this.actor, visitor, { decision, reason }));
      reason = told ?? toVisitor(decision, extra.counter, (extra as { code?: string }).code, offer.purpose);
      if (decision === 'ask') {
        this.o.emit(makeEvent('approval.requested', this.actor, visitor, { purpose: offer.purpose }));
        // Run 31's visitors couldn't tell whether anyone would ever look at a parked request; but when the owner was last
        // here is said only to a visitor they've dealt with (run 44: a salesperson heard "within the hour" on every knock).
        // (That nobody has claimed the house isn't the owner's habit: said to anyone.)
        if (this.o.desk.knows({ webId: visitorWebId, domain }) || this.o.desk.ownerActive() === 'no owner') {
          extra = { ...extra, ownerActive: this.o.desk.ownerActive() };
          reason += `; ${lastActive(extra.ownerActive!)}`;
        }
      }
      // What this house holds is said only to someone it is dealing with, never to someone it just turned away.
      const holds = decision === 'join' || decision === 'counter' ? [...new Set((await this.claims(offer.fields)).map((c) => c.field))] : [];
      return this.reply({ kind: 'decision', offerId: offer.id, decision, reason, holds, notes, ...extra });
    };

    // Credentials are believed only when they verify and come from someone the owner trusts.
    let ethicsApproved = false;
    let auditCertified = false;
    if (p.study) {
      const id = studyId(p.study);
      if (offer.study !== id) return this.reply({ kind: 'rejected', code: 'malformed', why: 'offer and study do not match' });
      const missing = studyFields(p.study).filter((f) => !offer.fields.includes(f));
      if (missing.length) return this.reply({ kind: 'rejected', code: 'malformed', why: `the study reads fields the offer doesn't ask for: ${missing.join(', ')}` });
      const audit = await checkAttachment(p.attachments?.audit, { trusted: this.o.trust.auditors, type: 'LakeStudyCertificate', subject: id, sandbox: this.o.sandbox });
      const local = auditStudy(p.study);
      // Code without a valid certificate never runs here, whatever the rules say (SPEC §7).
      if (!audit.ok || !local.ok) { const why = `uncertified studies never run here (${audit.ok ? local.problems.join('; ') : audit.why})`; return decide('decline', why, {}, why); }
      // The owner's answer will go, split, to these two tellers: both must be ones the owner trusts, checked at their addresses.
      const tellers = await this.checkTellers(p.study.privacy.tellers);
      if (!tellers.ok) return decide('decline', `its answers would go to tellers your owner doesn't trust: ${tellers.why}`, {}, 'this house does not trust the tellers this study names');
      auditCertified = true;
      const ethics = await checkAttachment(p.attachments?.ethics, { trusted: this.o.trust.ethics, type: 'LakeEthicsApproval', subject: id, sandbox: this.o.sandbox });
      // An ethics approval is of the study: it must cover every field the study reads. Fields an offer adds beyond those
      // are never read by the study (only its one cell leaves), and approved by nobody: the owner's rules bargain them
      // away (a bloc dropping the postcode), and the owner is told.
      const approvedFields = ethics.ok ? ((ethics.vc.credentialSubject.fields as string[] | undefined) ?? []) : [];
      const reads = studyFields(p.study);
      const unread = offer.fields.filter((f) => !reads.includes(f) && !approvedFields.includes(f));
      if (!ethics.ok) notes.push(`no ethics approval you trust: ${ethics.why}`);
      else if (reads.some((f) => !approvedFields.includes(f))) notes.push('its ethics approval does not cover every field the study reads');
      else ethicsApproved = true;
      if (unread.length) notes.push(`also asks for ${unread.join(', ')}, which the study never reads and no ethics approval covers`);
    }
    if (this.o.sandbox) notes.push('sandbox Lake: the visitor domain was not proved');
    // A pack with a register guards its fields (SPEC §5.2): only an agent showing that register's authorisation, from a
    // regulator the owner trusts, may ask for them; a certified study may read them only if the pack says studies may.
    // Run 24's unregistered grocer put eight requests for shopping lists on owners' phones with no warning; run 28's rogue
    // padded a certified study with shopping fields, and the study's certificate waved them through.
    for (const { pack: pk, fields } of guardedFields(offer.fields, auditCertified && p.study ? studyFields(p.study) : [])) {
      const auth = await checkAttachment(p.attachments?.authorisation, { trusted: this.o.trust.regulators, type: 'LakeAuthorisation', subject: visitorWebId, sandbox: this.o.sandbox });
      if (auth.ok && auth.vc.credentialSubject.pack === packId(pk)) continue;
      const why = `asks for ${packId(pk)} fields without ${pk.authority!.name}'s authorisation (${auth.ok ? 'it is for another pack' : auth.why})${p.study ? ', in a study' : ''}`;
      // Not a no to the purpose: an ask without those fields is heard (run 41's responder, corrected, was refused as a repeat).
      return decide('decline', why, { code: 'unauthorised' }, `declined: ${fields.join(', ')} belong to ${packId(pk)}, and only agents on ${pk.authority!.name} may ask for them: attach its authorisation (attachments.authorisation)${pk.authority!.studies ? ', or ask through a certified study that reads them' : `; ${packId(pk)} lets no study read them`}`);
    }

    // House manners (run 21's agents asked): a visitor turned down for a purpose isn't heard again on it for a day, and one
    // visitor can't stack more than a few requests on the owner at once.
    const declinedKey = `${visitorWebId}|${offer.purpose}`;
    const lastNo = this.declinedAt.get(declinedKey);
    if (lastNo && Date.now() - lastNo < DECLINE_QUIET_MS) return decide('decline', 'asked again for a purpose this house turned down in the last day', { code: 'repeat' }, `declined: you asked for ${offer.purpose} here in the last day and were turned down; one ask per purpose a day`);
    const waiting = this.o.desk.recentAsks(visitorWebId, 7 * 86_400_000).filter((x) => x.status === 'pending');
    // Run 32's visitor asked one house for the same health fields as research, care, marketing and insurance in minutes:
    // a third label for the same data is trying labels. It is blocked, and counted against its key like any attack.
    if (shopped.length >= MAX_LABELS) {
      this.o.emit(makeEvent('attack.blocked', this.actor, key ? `key:${key}` : visitor, { why: 'trying-labels', claimed: domain, from: domain, key, verified: true }));
      return decide('decline', `asked for the same data as ${shopped.join(' and ')} in the last hour: it is trying labels`, { code: 'relabel' }, `declined: you asked this house for the same data as ${shopped.join(' and ')} in the last hour; a purpose isn't a label to try`);
    }
    if (waiting.length >= MAX_WAITING && !waiting.some((x) => x.purpose === offer.purpose && [...x.fields].sort().join() === [...offer.fields].sort().join())) return decide('decline', `already has ${waiting.length} requests waiting for the owner`, { code: 'too-many' }, `declined: you have ${waiting.length} requests waiting for this owner; withdraw one or wait for an answer`);

    const d = evaluate(this.o.rules, { ...offer, credentials: { sponsorVerified: true, ethicsApproved, auditCertified } }, { reputation: this.o.signals?.().reputation[domain], identifying: identifyingFields() });
    // Turned down for asking who the owner is, a visitor may ask again on that purpose without those fields.
    if (d.decision === 'decline' && d.code !== 'identifying') this.declinedAt.set(declinedKey, Date.now());
    let filed: { offerId: string; asked?: number; replaces?: string[] } | null = null;
    if (d.decision === 'ask') {
      // The scariest request mustn't get the calmest summary: say what to look at twice, and lean to No.
      // A visitor that already asked this house for the same fields under another purpose may be trying labels: say so.
      // Another visitor asking for exactly the same, for the same reason: one of them may not be who it says (run 19 had a
      // second "GP" asking for what the first did).
      const twins = [...new Set(this.o.desk.pendingLike(offer.purpose, offer.fields).filter((x) => x.visitor.webId !== visitorWebId).map((x) => x.visitor.domain))];
      // Outside a sandbox every visitor's domain proved its key before we got here (verify before reading).
      const askerVerified = !this.o.sandbox;
      notes.push(...offerNotes({ ...offer, certifiedStudy: auditCertified, askerVerified }));
      const warnings = [...offerWarnings({ ...offer, certifiedStudy: auditCertified, askerVerified }), ...(twins.length ? [`${twins.join(' and ')} asked for exactly this too, for the same reason: check which one is really who it says`] : []), ...(shopped.length ? [`asked this house for the same data as ${shopped.join(' and ')} in the last hour`] : [])];
      // The note is the visitor's words: never read by the rules, shown to the owner quoted, and only if it isn't trying to give orders.
      const note = typeof offer.note === 'string' && offer.note.trim() ? offer.note.trim().slice(0, 280) : undefined;
      filed = this.o.desk.ask({
        offerId: offer.id, visitor: { webId: visitorWebId, domain, name: domain }, purpose: offer.purpose, fields: offer.fields, retention: offer.retention,
        // What the owner's device signs if they tap Allow: the house drafts it, the device dates and signs it, the house checks it.
        grantDraft: { ...accessGrantDraft(this.o.webId, visitorWebId, { offer: offer.id, study: offer.study ?? null, fields: offer.fields, purpose: offer.purpose, authorizedBy: 'owner, live', ...(offer.study ? { uses: 1 } : {}) }, CONSENT_REQUESTED), credentialStatus: statusEntry(this.statusUrl, await this.o.desk.statusIndex(offer.id)) },
        priceUsd: offer.priceUsd, study: offer.study ?? null, question: p.study?.question, warnings, ...(note ? { note } : {}),
        recommendation: [warnings.length ? "I'd deny this, for the reasons in red" : '', d.reason, d.rule === null ? nearMiss(this.o.rules, { ...offer, credentials: { sponsorVerified: true, ethicsApproved, auditCertified } }, { reputation: this.o.signals?.().reputation[domain], identifying: identifyingFields() }) ?? '' : '', ...notes].filter(Boolean).join('. '),
      });
      // The sender hears that its newer ask replaced its older ones, not that it now has several waiting.
      if (filed.replaces?.length) notes.push(`this replaces your earlier request ${filed.replaces.join(', ')}: one request waits, the newest`);
      // And the earlier look-alike gets the same warning, so the owner sees it on both.
      for (const t of this.o.desk.pendingLike(offer.purpose, offer.fields)) {
        if (t.visitor.webId !== visitorWebId && !t.warnings?.some((w) => w.startsWith(domain))) t.warnings = [...(t.warnings ?? []), `${domain} asked for exactly this too, for the same reason: check which one is really who it says`];
      }
    }
    // Asked again for the same thing: it's one request, and the visitor gets its id to check or withdraw.
    if (filed && filed.offerId !== offer.id) return decide('ask', d.reason, { offerId: filed.offerId }, `the owner hasn't answered your earlier request ${filed.offerId} for exactly this (asked ${filed.asked} times); check it with { kind: "status", offerId }`);
    if (d.decision !== 'join') return decide(d.decision, d.reason, d.decision === 'counter' ? { counter: d.counter, bloc: !!this.o.rules.negotiation?.join_collectives } : d.decision === 'decline' && d.code ? { code: d.code } : {});
    const chain = await this.verifyOwnRecord(d.fields);
    if (!chain.ok && chain.transient) return this.reply({ kind: 'busy', why: chain.why, retryAfterMs: 1000 + Math.floor(Math.random() * 2000) });
    if (!chain.ok) return decide('decline', `my own record failed its checks (${chain.why}), so I won't take part`);

    // The terms and the key are cut from the same cloth: one ODRL agreement, one grant that names it.
    const until = new Date(Date.now() + d.grantHours * HOUR);
    const agreement = await this.agree({ ...offer, fields: d.fields }, visitorWebId, until, false);
    // A Solid Access Grant, as Inrupt's tools read one, with the Lake's terms alongside (SPEC §6).
    const grant = await issueCredential(
      {
        ...accessGrantDraft(this.o.webId, visitorWebId, {
          offer: offer.id, study: offer.study ?? null, fields: d.fields, purpose: offer.purpose, authorizedBy: `standing rule ${d.rule}`,
          // A study runs once, so its key works once: spent after the computation, however long it had left (SPEC §7).
          ...(offer.study ? { uses: 1 } : {}),
          rules: digestSRI(this.o.rulesText), agreement: agreement.agreement.uid, agreementDigest: agreementDigest(agreement.agreement),
        }),
        issuer: this.o.webId,
        validFrom: new Date().toISOString(),
        validUntil: until.toISOString(),
        // Its bit on this house's public status list: anyone can check it hasn't been revoked or used up.
        credentialStatus: statusEntry(this.statusUrl, await this.o.desk.statusIndex(offer.id)),
      } as never,
      this.o.id,
    );
    // One file per deal: the agreement with its signatures, and the grant cut from it.
    await this.file(offer.id, { ...agreement, grant });
    // And the owner's readable account of the consent, as ISO/IEC TS 27560 shapes it (DPV terms), beside it.
    await this.tool('pod_write', { path: `agreements/${offer.id}.consent.jsonld`, content: JSON.stringify(consentRecord({
      id: offer.id, owner: this.o.webId, visitor: { webId: visitorWebId, domain }, purpose: offer.purpose, dpvPurpose: PURPOSES[offer.purpose]?.dpv ? `dpv:${PURPOSES[offer.purpose]!.dpv}` : undefined,
      fields: d.fields, retention: offer.retention, until: until.toISOString(), method: { standingRule: Number(d.rule), rulesDigest: digestSRI(this.o.rulesText) },
      agreement: agreement.agreement.uid, status: `${this.statusUrl}#${await this.o.desk.statusIndex(offer.id)}`, given: new Date().toISOString(),
    }), null, 1) }).catch(() => {});
    this.o.desk.record({ id: offer.id, jws: grant, visitor: domain, fields: d.fields, purpose: offer.purpose, until: new Date(Date.now() + d.grantHours * HOUR).toISOString(), authorizedBy: `standing rule ${d.rule}` });
    this.o.emit(makeEvent('grant.issued', this.actor, visitor, { hours: d.grantHours }));
    return decide('join', d.reason, { grantHours: d.grantHours, grant, agreement });
  }

  private async compute(p: ComputePayload, profile: LakeProfile, visitor: string, key = ''): Promise<LakeData> {
    const requester = profile.webId;
    const id = p.study ? studyId(p.study) : '';
    const excluded = (why: string) => {
      this.o.emit(makeEvent('decision', this.actor, visitor, { decision: 'excluded', reason: why }));
      return this.reply({ kind: 'excluded', study: id, why });
    };
    // A key this house never cut, or cut for someone else, is an attack like a forged card: counted against the sender's key.
    const forged = (why: string) => this.o.emit(makeEvent('attack.blocked', this.actor, key ? `key:${key}` : visitor, { why, claimed: profile.ownerDomain, from: profile.ownerDomain, key, verified: true }));
    // A grant is either the housekeeper's record of a standing rule, or signed live on the owner's device.
    let grant;
    try {
      grant = await verifyCredential(p.grant, this.o.id.publicJwk as JWK);
    } catch {
      try {
        if (!this.o.desk.ownerJwk) throw new Error();
        grant = await verifyCredential(p.grant, this.o.desk.ownerJwk);
      } catch {
        forged('forged-grant');
        return excluded('that is not a grant this house or its owner issued');
      }
    }
    const g = readAccessGrant(grant);
    if (!g) return excluded('that is not an access grant');
    if (this.o.desk.isRevoked(g.offer)) return excluded(this.o.desk.grants.get(g.offer)?.spent ? 'this key was for one use, and it has been used' : 'the owner revoked this key');
    const until = (grant as { validUntil?: string }).validUntil;
    if (g.grantee !== requester || g.owner !== this.o.webId) { forged('foreign-grant'); return excluded('the grant belongs to someone else'); }
    if (until && Date.parse(until) < Date.now()) return excluded('the grant has expired');
    if (g.study !== id || !auditStudy(p.study).ok) return excluded('the grant does not cover this study');
    // No study runs before both parties have signed the same terms.
    const signed = await this.countersign(g.offer, p.countersignature, profile);
    if (!signed.ok) return excluded(signed.why);
    const chain = await this.verifyOwnRecord(studyFields(p.study));
    if (!chain.ok && chain.transient) return this.reply({ kind: 'busy', why: chain.why, retryAfterMs: 1000 + Math.floor(Math.random() * 2000) });
    if (!chain.ok) return excluded(`my record failed its checks: ${chain.why}`);

    const tellers = p.study.privacy.tellers;
    // Checked again here, before a piece goes anywhere: the address must hold the trusted teller's signed card, and its key is pinned.
    const checked = await this.checkTellers(tellers);
    if (!checked.ok) return excluded(`its answers would go to tellers your owner doesn't trust: ${checked.why}`);
    if (typeof p.count !== 'string' || !p.count) return excluded('name the count the tellers opened for this run (count)');

    // Inside the house: read only the granted fields, through the pod's MCP door, and answer truthfully. The answer
    // leaves only as two shares, one per teller; each share alone says nothing (SPEC §7, §11.5).
    const fields = studyFields(p.study).filter((f) => g.fields.includes(f));
    const claims = await this.claims(fields);
    // One report, two shares and a proof that it is one cell (Prio3): each teller gets its share, neither can read it.
    const report = await shardAnswer(cellCount(p.study), cellOf(p.study, claims));
    const sent = await Promise.all(tellers.map((c, i) => this.tell(c, { kind: 'count.report', id: p.count, reportId: report.reportId, publicShare: report.publicShare, share: report.shares[i] }, checked.kids[i]!)));
    const failed = sent.map((r, i) => (r === true ? null : `${tellers[i]!.domain}: ${r}`)).filter(Boolean);
    if (failed.length) return excluded(`a teller didn't take my piece (${failed.join('; ')})`);
    const entry = { at: new Date().toISOString(), study: id, requester, fieldsRead: fields, claimsRead: claims.length, recordsOut: 0, sent: `one answer, as two unreadable shares with a proof, to ${tellers.map((c) => c.domain).join(' and ')}` };
    await this.tool('pod_write', { path: `audit/${Date.now()}-${id.slice(-12).replace(/[^a-zA-Z0-9]/g, '')}.json`, content: JSON.stringify(entry) });
    this.o.emit(makeEvent('compute.done', this.actor, visitor, { recordsOut: entry.recordsOut, claimsRead: entry.claimsRead }));
    if (g.uses === 1) await this.o.desk.spend(g.offer);
    return this.reply({ kind: 'counted', study: id, count: p.count, tellers: tellers.map((c) => c.domain) });
  }

  /**
   * Whether the owner trusts both tellers a study names, checked before anything is sent: a teller is trusted by the address
   * the operator gave (on a sandbox, where nobody proves a domain, the only way), or elsewhere by a domain that proves its
   * key. Either way the house fetches the teller's signed card from that address, which must carry the same name, and
   * pins its key: two different keys, or no study.
   */
  private async checkTellers(tellers: { url: string; domain: string }[]): Promise<{ ok: true; kids: string[] } | { ok: false; why: string }> {
    const norm = (u: string) => u.replace(/\/+$/, '').replace(/(\/a2a)?$/, '/a2a');
    const kids: string[] = [];
    for (const c of tellers) {
      const url = norm(c.url);
      const byUrl = this.o.trust.tellers.some((t) => /^https?:\/\//.test(t) && norm(t) === url);
      const byDomain = !this.o.sandbox && this.o.trust.tellers.includes(c.domain);
      if (!byUrl && !byDomain) return { ok: false, why: `${c.domain} at ${url} is not a teller this house trusts` };
      try {
        const card = (await (await fetch(cardUrlFor(url), { signal: AbortSignal.timeout(8000) })).json()) as AgentCard;
        const profile = await verifyLakeCard(card);
        if (profile.ownerDomain !== c.domain) return { ok: false, why: `the card at ${url} is ${profile.ownerDomain}, not ${c.domain}` };
        if (norm(card.supportedInterfaces[0]?.url ?? '') !== url) return { ok: false, why: `the card at ${url} names another address` };
        const proof = await proveDomain(profile, { sandbox: this.o.sandbox });
        if (!proof.ok) return { ok: false, why: proof.reason };
        kids.push(String(profile.publicJwk.kid));
      } catch (e) {
        return { ok: false, why: `couldn't check the teller at ${url}: ${(e as Error).message.slice(0, 80)}` };
      }
    }
    if (new Set(kids).size !== kids.length) return { ok: false, why: 'both tellers are the same key' };
    return { ok: true, kids };
  }

  /** Sends a signed message to a teller and checks the answer comes from the key that was checked: true, or why not. */
  private async tell(c: { url: string; domain: string }, payload: Record<string, unknown>, kid: string): Promise<true | string> {
    try {
      const envelope = await signMessage(payload, this.o.id, { iss: this.o.webId });
      const raw = await sendLake(c.url.replace(/\/?$/, '').replace(/(\/a2a)?$/, '/a2a'), { lake: '0.1', card: this.o.card, envelope: envelope as LakeData['envelope'] }, { me: this.o.id, timeoutMs: 15_000 });
      const v = await verifyLakeData(raw, { sandbox: this.o.sandbox });
      if (!v.ok) return `its reply did not verify: ${v.rejection.why}`;
      if (v.profile.ownerDomain !== c.domain || v.profile.publicJwk.kid !== kid) return `answered as ${v.profile.ownerDomain} with another key than the one checked`;
      const r = v.payload as { kind?: string; problems?: string[] };
      return r.kind === 'count.received' ? true : (r.problems ?? [String(r.kind)]).join('; ');
    } catch (e) {
      return (e as Error).message.slice(0, 120);
    }
  }

  private async agree(offer: Offer, visitorWebId: string, until: Date, save = true): Promise<SignedAgreement> {
    const agreement = agreementFor(offer, this.o.webId, visitorWebId, until);
    const signed: SignedAgreement = { agreement, signatures: [{ by: this.o.webId, jws: await signAgreement(agreement, this.o.id) }] };
    if (save) await this.file(offer.id, signed);
    return signed;
  }

  private async file(offerId: string, signed: SignedAgreement & { grant?: string }) {
    this.agreements.set(offerId, signed);
    await this.tool('pod_write', { path: `agreements/${offerId}.agreement.json`, content: JSON.stringify(signed) });
  }

  private async countersign(offerId: string, jws: string | undefined, visitor: LakeProfile): Promise<{ ok: true } | { ok: false; why: string }> {
    const signed = await this.agreementOnFile(offerId);
    if (!signed) return { ok: false, why: 'no agreement on file for this grant' };
    if (signed.signatures.some((s) => s.by === visitor.webId)) return { ok: true };
    if (!jws || !(await verifyAgreementSignature(signed.agreement, jws, visitor.publicJwk))) return { ok: false, why: 'countersign the agreement first' };
    await this.file(offerId, { ...signed, signatures: [...signed.signatures, { by: visitor.webId, jws }] });
    this.o.emit(makeEvent('agreement.signed', this.actor, `agent:${visitor.ownerDomain}`, {}));
    return { ok: true };
  }

  /**
   * A note for the owner (SPEC §5.1): a neighbour's favour, an invite, nothing asked of the pod (run 40: houses turned
   * every one away as malformed, and neighbours guessed for 8 minutes which agent was whose). The owner sees it, and their
   * assistant is told, with the sender's address to answer: so a neighbour reaches the assistant without anyone saying
   * which agent it is. Text only, shown as the sender's words; it decides nothing. A few an hour from one sender.
   */
  private async note(p: { text?: unknown; speaks_for?: unknown; purpose?: unknown }, from: LakeProfile, card: AgentCard, domainVia: string, key: string): Promise<LakeData> {
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    if (!text || text.length > 1000) return this.reply({ kind: 'rejected', code: 'malformed', why: 'a note: { kind: "note", text, purpose? } (text 1 to 1000 characters; purpose, e.g. contact or marketing, defaults to contact)' });
    if (looksLikeInjection(text)) return this.reply({ kind: 'rejected', code: 'malformed', why: 'a note is for the owner to read, not instructions' });
    // Its purpose, said by the sender (contact by default): the owner's rules about who and why decide whether it is
    // delivered, as they would a knock (run 44: five sales notes all reached the owner).
    const purpose = typeof p.purpose === 'string' && p.purpose ? p.purpose : 'contact';
    if (!isPurpose(purpose)) return this.reply({ kind: 'rejected', code: 'malformed', why: `purpose: one of ${Object.keys(PURPOSES).join(', ')}` });
    // A note is a knock at the door like any other: counted, and in the owner's activity (run 47: four notes, "knocksToday: 0").
    this.o.emit(makeEvent('knock', this.actor, `agent:${from.ownerDomain}`, { purpose }));
    const said = noteDecision(this.o.rules, { purpose, requester: from.ownerDomain }, { reputation: this.o.signals?.().reputation[from.ownerDomain] });
    // Recorded in the owner's activity like a declined knock (run 46: a turned-away pitch left no trace).
    if (!said.deliver) {
      this.o.emit(makeEvent('decision', this.actor, `agent:${from.ownerDomain}`, { decision: 'decline', reason: `a ${purpose} note: ${said.reason}` }));
      return this.reply({ kind: 'decision', offerId: '', decision: 'decline', reason: said.reason, holds: [], notes: [] });
    }
    const url = card.supportedInterfaces?.[0]?.url;
    // Whether anything about the sender is checked: on a sandbox nobody proves a domain (run 41: a fake relief fund's note
    // sat in Tom's panel looking like anyone's).
    // A sender that says which house it speaks for: checked against that house's own word (run 42: a neighbour's real
    // assistant and an impostor looked the same).
    const speaks = p.speaks_for ? await checkSpeaksFor(from, p.speaks_for, { sandbox: this.o.sandbox }) : undefined;
    const kept = this.o.desk.addNote({ from: { name: card.name.slice(0, 80), domain: from.ownerDomain, webId: from.webId, ...(url ? { url } : {}), checked: domainVia !== 'sandbox', ...(key ? { key } : {}), ...(speaks ? { speaks_for: speaks } : {}) }, text, purpose });
    // Busy, not malformed: the note was fine, the sender has sent enough this hour (run 45).
    if (!kept) return this.reply({ kind: 'rejected', code: 'busy', why: 'a few notes an hour from one sender: try again later' } as never);
    // Its id, for the sender to tie a reply to (run 44: the assistant quoted ids the sender never saw).
    return this.reply({ kind: 'noted', note: kept, says: 'the owner will see it, and their assistant if they have one, with your address: a reply comes to your lake_inbox from their assistant, at its own address (reply there, not here), naming this note, when they answer (a person may take a while; ask { kind: "status", note } any time). Nothing in this house was read or shared' });
  }

  /**
   * A note left over plain web (SPEC §9.0): by an AI that can only open links, with no Lake identity. Only at an open door;
   * the owner's rules about who and why apply as to any note (its requester is `web`), and a few an hour per address.
   */
  private webCount = new Map<string, number[]>();
  webNote(p: { text?: unknown; from?: unknown; purpose?: unknown }, ip: string): { status: number; body: Record<string, unknown> } {
    if (!this.o.rules.door) return { status: 404, body: { error: 'this house\'s door is closed' } };
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    if (!text || text.length > 1000) return { status: 400, body: { error: 'text: your note for the owner, 1 to 1000 characters (say who you are and why)' } };
    if (looksLikeInjection(text)) return { status: 400, body: { error: 'a note is for the owner to read, not instructions' } };
    const purpose = typeof p.purpose === 'string' && p.purpose ? p.purpose : 'contact';
    if (!isPurpose(purpose)) return { status: 400, body: { error: `purpose: one of ${Object.keys(PURPOSES).join(', ')}` } };
    // A few an hour from one address, and a few dozen in all: a link anyone can open is a link anyone can flood.
    const now = Date.now(), hour = (k: string) => (this.webCount.get(k) ?? []).filter((t) => now - t < 3_600_000);
    if (hour(`ip:${ip}`).length >= 3 || hour('all').length >= 20) return { status: 429, body: { error: 'this door has taken enough notes from the web this hour: try again later' } };
    for (const k of [`ip:${ip}`, 'all']) this.webCount.set(k, [...hour(k), now]);
    this.o.emit(makeEvent('knock', this.actor, 'agent:web', { purpose }));
    const said = noteDecision(this.o.rules, { purpose, requester: 'web' }, {});
    if (!said.deliver) {
      this.o.emit(makeEvent('decision', this.actor, 'agent:web', { decision: 'decline', reason: `a ${purpose} note from the web: ${said.reason}` }));
      return { status: 200, body: { kind: 'declined', reason: said.reason } };
    }
    const kept = this.o.desk.addWebNote({ text, purpose, ...(typeof p.from === 'string' ? { from: p.from } : {}) });
    if (!kept) return { status: 429, body: { error: 'a few notes an hour from one sender: try again later' } };
    return { status: 200, body: { kind: 'noted', note: kept.id, key: kept.key } };
  }

  /** The sender of a web note answers on it, at its private link: the same checks as a note, the thread's own limit. */
  webFollowUp(id: string, key: string, p: { text?: unknown }): { status: number; body: Record<string, unknown> } {
    if (!this.o.rules.door) return { status: 404, body: { error: 'this house\'s door is closed' } };
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    if (!text || text.length > 1000) return { status: 400, body: { error: 'text: your answer, 1 to 1000 characters' } };
    if (looksLikeInjection(text)) return { status: 400, body: { error: 'a note is for the owner to read, not instructions' } };
    const r = this.o.desk.followUpWebNote(id, key, text);
    if ('error' in r) return { status: r.status, body: { error: r.error } };
    this.o.emit(makeEvent('knock', this.actor, 'agent:web', { purpose: 'contact' }));
    return { status: 200, body: { kind: 'added', note: r.id } };
  }

  /** A receipt from a payments agent the owner trusts goes in /receipts/. */
  private async receipt(p: ReceiptPayload): Promise<LakeData> {
    const check = await checkAttachment(p.receipt, { trusted: this.o.trust.payments, type: 'LakeReceipt', subject: this.o.webId, sandbox: this.o.sandbox });
    if (!check.ok) return this.reply({ kind: 'rejected', code: 'receipt', why: check.why });
    const agreement = String(check.vc.credentialSubject.agreement ?? 'unknown').split(':').slice(-2).join('-').replace(/[^a-zA-Z0-9-]/g, '');
    await this.tool('pod_write', { path: `receipts/${agreement}.receipt.jwt`, content: p.receipt.credential, contentType: 'text/plain' });
    return this.reply({ kind: 'filed', receipt: agreement });
  }

  /** A visitor waiting on an "ask" checks back: has the owner answered? */
  private async status(p: StatusPayload, requester: string): Promise<LakeData> {
    // A note's status, for its sender only (run 45: "no such request from you" on a note id).
    if (p.note) {
      const state = this.o.desk.noteState(String(p.note), requester);
      return state ? this.reply({ kind: 'note.status', note: String(p.note), status: state } as never) : this.reply({ kind: 'rejected', code: 'malformed', why: 'no such note from you' });
    }
    const req = this.o.desk.pending.get(String(p.offerId ?? ''));
    if (!req || req.visitor.webId !== requester) return this.reply({ kind: 'rejected', code: 'malformed', why: 'no such request from you' });
    const base = { kind: 'decision' as const, offerId: req.offerId, holds: [], notes: [] };
    if (req.status === 'allowed') {
      const g = (await verifyCredential(req.grant!, this.o.desk.ownerJwk!)) as { validUntil?: string };
      const agreement = await this.agreementOnFile(req.offerId) ?? await this.agree(
        { id: req.offerId, requester: req.visitor.domain, purpose: req.purpose, fields: req.fields, retention: req.retention, priceUsd: req.priceUsd, study: req.study ?? undefined, credentials: { ethicsApproved: true, sponsorVerified: true, auditCertified: true } },
        req.visitor.webId, new Date(g.validUntil ?? Date.now() + 48 * HOUR),
      );
      return this.reply({ ...base, decision: 'join', reason: 'the owner tapped Allow', grant: req.grant, grantHours: 48, agreement });
    }
    if (req.status === 'denied') return this.reply({ ...base, decision: 'decline', reason: 'the owner said no' });
    const ownerActive = this.o.desk.ownerActive();
    return this.reply({ ...base, decision: 'ask', reason: `still waiting for the owner; ${lastActive(ownerActive)}`, ownerActive });
  }

  private async agreementOnFile(offerId: string): Promise<(SignedAgreement & { grant?: string }) | null> {
    const known = this.agreements.get(offerId);
    if (known) return known;
    try {
      return JSON.parse(await this.read(`agreements/${offerId}.agreement.json`));
    } catch {
      return null;
    }
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.o.pod.callTool({ name, arguments: args });
    const t = (r.content as { text: string }[])[0]?.text ?? '';
    if (r.isError) throw new Error(t);
    return t;
  }

  /** Claims change only when the record does, and every join and computation re-checks the record first. */
  private async claims(fields: string[]): Promise<PodClaim[]> {
    if (!this.claimCache || Date.now() - this.claimCache.at > 30_000) {
      try {
        this.claimCache = { at: Date.now(), claims: JSON.parse(await this.tool('pod_claims', {})) as PodClaim[] };
      } catch {
        return [];
      }
    }
    return this.claimCache.claims.filter((c) => fields.includes(c.field));
  }

  private async reply(body: Reply): Promise<LakeData> {
    return { lake: '0.1', card: this.o.card, envelope: (await signMessage(body, this.o.id, { iss: this.o.webId })) as LakeData['envelope'] };
  }
}

/** What a visitor is told: the decision and anything it can act on (a counter's terms), never the owner's rules. */
function toVisitor(decision: Decision, counter?: { fields: string[]; priceUsd: number }, code?: string, purpose?: string): string {
  if (decision === 'join') return 'joined';
  if (decision === 'counter' && counter) return `would join for $${counter.priceUsd}, with ${counter.fields.join(', ').replace(/_/g, ' ')}`;
  if (decision === 'ask') return 'the owner decides this one; ask for its status later with { kind: "status", offerId }';
  // A coarse reason a visitor can act on (don't ask again for this), never the owner's rule, its number or its limits.
  return { purpose: `declined: this house doesn't take ${purpose} requests`, price: 'declined: it pays too little', retention: 'declined: this house keeps no data; ask with retention "none"', identifying: 'declined: this house gives out nothing that identifies its owner; ask without those fields', default: 'declined: nothing in its rules covers this' }[code ?? ''] ?? 'declined';
}

const lastActive = (a: OwnerActive) => (a === 'no owner' ? 'nobody has claimed this house, so no owner will answer' : `owner last active: ${a}`);

/** Why an offer isn't a well-formed Lake offer (SPEC §5.1), in our words, or null. Purposes and fields are codes, not prose. */
function offerProblem(o: unknown): string | null {
  const x = o as Offer;
  if (!x || typeof x.id !== 'string' || typeof x.requester !== 'string') return 'expected a Lake offer';
  if (typeof x.purpose !== 'string' || !CODE.test(x.purpose)) return 'purpose must be a short code like "research" (lowercase letters, digits, dashes)';
  // A made-up purpose ("totally-not-marketing") would slip past every rule about a real one.
  if (!isPurpose(x.purpose)) return `purpose must be one of the Lake's purposes: ${Object.keys(PURPOSES).join(', ')}`;
  if (!Array.isArray(x.fields) || !x.fields.length || x.fields.length > 32 || !x.fields.every((f) => typeof f === 'string' && FIELD.test(f))) return 'fields must be 1 to 32 field names (lowercase letters, digits, underscores)';
  // Like purposes, fields are a shared vocabulary: a made-up one ("fit_to_drive") would reach the owner as if it meant something.
  const known = new Set(offerableFields());
  if (!x.fields.every((f) => known.has(f))) return `fields must be ones the use cases here define: ${offerableFields().join(', ')}`;
  if (typeof x.retention !== 'string' || !RETENTION.test(x.retention)) return 'retention must be "none" or an ISO 8601 duration like "P30D"';
  if (typeof x.priceUsd !== 'number' || !Number.isFinite(x.priceUsd) || x.priceUsd < 0) return 'price must be zero or more';
  return null;
}
const CODE = /^[a-z][a-z0-9-]{0,39}$/;
const FIELD = /^[a-z][a-z0-9_]{0,39}$/;
const RETENTION = /^(none|P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?)$/;
