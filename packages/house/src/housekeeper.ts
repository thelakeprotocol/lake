import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  agreementDigest, agreementFor, allFields, auditStudy, fieldSpec, rng, seedFrom, looksLikeInjection, cellOf, checkAttachment, digestSRI, evaluate, issueCredential, makeEvent, randomize, ReplayGuard, signAgreement, signMessage,
  studyFields, studyId, verifyAgreementSignature, verifyCredential, verifyLakeData,
  type AgentCard, type Attachment, type Identity, type JWK, type LakeData, type LakeEvent, type LakePack, type LakeProfile, type Offer, type Rules, type SignedAgreement, type Study,
} from '@thelakeprotocol/core';
import { checkRecord, quickCheck, type RecordCheck, type RecordPaths, type Trust } from './record.js';
import type { OwnerDesk } from './owner.js';
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
  /** Seeded demo runs: the same seed gives the same randomised answers. */
  seed?: string;
  /** The owner's side: pending asks, live grants, revocations. */
  desk: OwnerDesk;
  /** Signals from the nodes this house follows: keys to drop on sight, agents' reputation. */
  signals?: () => { blocklist: Set<string>; reputation: Record<string, number> };
  emit: (e: LakeEvent) => void;
}

type Decision = 'join' | 'decline' | 'ask' | 'counter';
export type Reply =
  | { kind: 'rejected'; code: string; why: string }
  | { kind: 'decision'; offerId: string; decision: Decision; reason: string; counter?: { fields: string[]; priceUsd: number }; bloc?: boolean; grantHours?: number; grant?: string; agreement?: SignedAgreement; holds: string[]; notes: string[] }
  | { kind: 'filed'; receipt: string }
  | { kind: 'busy'; why: string; retryAfterMs: number }
  | { kind: 'fragment'; study: string; fragment: number[] }
  | { kind: 'excluded'; study: string; why: string };

interface OfferPayload { kind: 'offer'; offer: Offer; study?: Study; attachments?: { ethics?: Attachment; audit?: Attachment } }
interface ComputePayload { kind: 'compute'; grant: string; study: Study; countersignature?: string }
interface StatusPayload { kind: 'status'; offerId: string }
interface ReceiptPayload { kind: 'receipt'; receipt: Attachment }

const HOUR = 3_600_000;

/**
 * Answers every knock by the owner's rules, in code. A "join" under a standing rule the owner wrote is
 * the owner's pre-approval: the housekeeper records it as a signed grant that names that rule.
 * Certified studies run here, inside the house; only a randomised answer leaves.
 */
export class Housekeeper {
  private replay = new ReplayGuard();
  /** Per pack: the last check, and when the whole chain was last verified. */
  private checks = new Map<string, { check: RecordCheck; fullAt: number }>();
  /** Agreements this house signed, so a countersignature doesn't need a pod read. The pod copy is the record. */
  private agreements = new Map<string, SignedAgreement & { grant?: string }>();
  private claimCache: { at: number; claims: PodClaim[] } | null = null;
  private actor: string;

  constructor(private o: HousekeeperOptions) {
    this.actor = `house:${o.name}`;
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
    const v = await verifyLakeData(data as LakeData<OfferPayload | ComputePayload | StatusPayload | ReceiptPayload> | null, { replay: this.replay, sandbox: this.o.sandbox });
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
    if (v.payload.kind === 'compute') return this.compute(v.payload as ComputePayload, v.profile, visitor);
    if (v.payload.kind === 'status') return this.status(v.payload as StatusPayload, v.profile.webId);
    if (v.payload.kind === 'receipt') return this.receipt(v.payload as ReceiptPayload);
    return this.reply({ kind: 'rejected', code: 'malformed', why: 'expected an offer or a compute request' });
  }

  private async offer(p: OfferPayload, domain: string, visitorWebId: string, visitor: string, key = ''): Promise<LakeData> {
    const offer = p.offer;
    if (!isOffer(offer)) return this.reply({ kind: 'rejected', code: 'malformed', why: 'expected a Lake offer' });
    if (offer.requester !== domain) {
      // Blame lands on the impersonator's own verified domain and key, never on the domain it pretended to be.
      this.o.emit(makeEvent('attack.blocked', this.actor, key ? `key:${key}` : visitor, { why: 'impersonation', claimed: domain, key, verified: true }));
      return this.reply({ kind: 'rejected', code: 'impersonation', why: `card is for ${domain}, offer claims ${offer.requester}` });
    }
    this.o.emit(makeEvent('knock', this.actor, visitor, { purpose: offer.purpose }));
    const notes: string[] = [];
    const decide = async (decision: Decision, reason: string, extra: Partial<Extract<Reply, { kind: 'decision' }>> = {}) => {
      this.o.emit(makeEvent('decision', this.actor, visitor, { decision, reason }));
      if (decision === 'ask') this.o.emit(makeEvent('approval.requested', this.actor, visitor, { purpose: offer.purpose }));
      const holds = [...new Set((await this.claims(offer.fields)).map((c) => c.field))];
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
      if (!audit.ok || !local.ok) return decide('decline', `uncertified studies never run here (${audit.ok ? local.problems.join('; ') : audit.why})`);
      auditCertified = true;
      const ethics = await checkAttachment(p.attachments?.ethics, { trusted: this.o.trust.ethics, type: 'LakeEthicsApproval', subject: id, sandbox: this.o.sandbox });
      const approvedFields = ethics.ok ? ((ethics.vc.credentialSubject.fields as string[] | undefined) ?? []) : [];
      if (!ethics.ok) notes.push(`no ethics approval you trust: ${ethics.why}`);
      else if (offer.fields.some((f) => !approvedFields.includes(f))) notes.push('asks for more fields than its ethics approval covers');
      else ethicsApproved = true;
    }
    if (this.o.sandbox) notes.push('sandbox Lake: the visitor domain was not proved');

    const d = evaluate(this.o.rules, { ...offer, credentials: { sponsorVerified: true, ethicsApproved, auditCertified } }, { reputation: this.o.signals?.().reputation[domain] });
    if (d.decision === 'ask') {
      this.o.desk.ask({
        offerId: offer.id, visitor: { webId: visitorWebId, domain, name: domain }, purpose: offer.purpose, fields: offer.fields, retention: offer.retention,
        priceUsd: offer.priceUsd, study: offer.study ?? null, question: p.study?.question, recommendation: [d.reason, ...notes].join('. '),
      });
    }
    if (d.decision !== 'join') return decide(d.decision, d.reason, d.decision === 'counter' ? { counter: d.counter, bloc: !!this.o.rules.negotiation?.join_collectives } : {});
    const chain = await this.verifyOwnRecord(d.fields);
    if (!chain.ok && chain.transient) return this.reply({ kind: 'busy', why: chain.why, retryAfterMs: 1000 + Math.floor(Math.random() * 2000) });
    if (!chain.ok) return decide('decline', `my own record failed its checks (${chain.why}), so I won't take part`);

    // The terms and the key are cut from the same cloth: one ODRL agreement, one grant that names it.
    const until = new Date(Date.now() + d.grantHours * HOUR);
    const agreement = await this.agree({ ...offer, fields: d.fields }, visitorWebId, until, false);
    const grant = await issueCredential(
      {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential', 'LakeAccessGrant'],
        issuer: this.o.webId,
        validFrom: new Date().toISOString(),
        validUntil: until.toISOString(),
        credentialSubject: {
          id: visitorWebId, offer: offer.id, study: offer.study ?? null, fields: d.fields, purpose: offer.purpose, authorizedBy: `standing rule ${d.rule}`,
          rules: digestSRI(this.o.rulesText), agreement: agreement.agreement.uid, agreementDigest: agreementDigest(agreement.agreement),
        },
      } as never,
      this.o.id,
    );
    // One file per deal: the agreement with its signatures, and the grant cut from it.
    await this.file(offer.id, { ...agreement, grant });
    this.o.desk.record({ id: offer.id, jws: grant, visitor: domain, fields: d.fields, purpose: offer.purpose, until: new Date(Date.now() + d.grantHours * HOUR).toISOString(), authorizedBy: `standing rule ${d.rule}` });
    this.o.emit(makeEvent('grant.issued', this.actor, visitor, { hours: d.grantHours }));
    return decide('join', d.reason, { grantHours: d.grantHours, grant, agreement });
  }

  private async compute(p: ComputePayload, profile: LakeProfile, visitor: string): Promise<LakeData> {
    const requester = profile.webId;
    const id = p.study ? studyId(p.study) : '';
    const excluded = (why: string) => {
      this.o.emit(makeEvent('decision', this.actor, visitor, { decision: 'excluded', reason: why }));
      return this.reply({ kind: 'excluded', study: id, why });
    };
    // A grant is either the housekeeper's record of a standing rule, or signed live on the owner's device.
    let grant;
    try {
      grant = await verifyCredential(p.grant, this.o.id.publicJwk as JWK);
    } catch {
      try {
        if (!this.o.desk.ownerJwk) throw new Error();
        grant = await verifyCredential(p.grant, this.o.desk.ownerJwk);
      } catch {
        return excluded('that is not a grant this house or its owner issued');
      }
    }
    const g = grant.credentialSubject as { id: string; offer: string; study: string | null; fields: string[] };
    if (this.o.desk.isRevoked(g.offer)) return excluded('the owner revoked this key');
    const until = (grant as { validUntil?: string }).validUntil;
    if (!grant.type.includes('LakeAccessGrant') || g.id !== requester) return excluded('the grant belongs to someone else');
    if (until && Date.parse(until) < Date.now()) return excluded('the grant has expired');
    if (g.study !== id || !auditStudy(p.study).ok) return excluded('the grant does not cover this study');
    // No study runs before both parties have signed the same terms.
    const signed = await this.countersign(g.offer, p.countersignature, profile);
    if (!signed.ok) return excluded(signed.why);
    const chain = await this.verifyOwnRecord(studyFields(p.study));
    if (!chain.ok && chain.transient) return this.reply({ kind: 'busy', why: chain.why, retryAfterMs: 1000 + Math.floor(Math.random() * 2000) });
    if (!chain.ok) return excluded(`my record failed its checks: ${chain.why}`);

    // Inside the house: read only the granted fields, through the pod's MCP door, and randomise.
    const fields = studyFields(p.study).filter((f) => g.fields.includes(f));
    const claims = await this.claims(fields);
    const rand = this.o.seed ? rng(seedFrom(`${this.o.seed}|${id}|${this.o.webId}`)) : Math.random;
    const fragment = randomize(p.study, cellOf(p.study, claims), rand);
    const entry = { at: new Date().toISOString(), study: id, requester, fieldsRead: fields, claimsRead: claims.length, recordsOut: 0, sent: 'one randomised answer' };
    await this.tool('pod_write', { path: `audit/${Date.now()}-${id.slice(-12).replace(/[^a-zA-Z0-9]/g, '')}.json`, content: JSON.stringify(entry) });
    this.o.emit(makeEvent('compute.done', this.actor, visitor, { recordsOut: entry.recordsOut, claimsRead: entry.claimsRead }));
    return this.reply({ kind: 'fragment', study: id, fragment });
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
    const req = this.o.desk.pending.get(p.offerId);
    if (!req || req.visitor.webId !== requester) return this.reply({ kind: 'rejected', code: 'malformed', why: 'no such request from you' });
    const base = { kind: 'decision' as const, offerId: req.offerId, holds: [], notes: [] };
    if (req.status === 'allowed') {
      const g = (await verifyCredential(req.grant!, this.o.desk.ownerJwk!)) as { validUntil?: string };
      const agreement = await this.agreementOnFile(req.offerId) ?? await this.agree(
        { id: req.offerId, requester: req.visitor.domain, purpose: req.purpose, fields: req.fields, retention: req.retention, priceUsd: req.priceUsd, study: req.study ?? undefined, credentials: { ethicsApproved: true, sponsorVerified: true, auditCertified: true } },
        req.visitor.webId, new Date(g.validUntil ?? Date.now() + 48 * HOUR),
      );
      return this.reply({ ...base, decision: 'join', reason: 'your owner tapped Allow', grant: req.grant, grantHours: 48, agreement });
    }
    if (req.status === 'denied') return this.reply({ ...base, decision: 'decline', reason: 'the owner said no' });
    return this.reply({ ...base, decision: 'ask', reason: 'still waiting for the owner' });
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

function isOffer(o: unknown): o is Offer {
  const x = o as Offer;
  return !!x && typeof x.id === 'string' && typeof x.requester === 'string' && typeof x.purpose === 'string'
    && Array.isArray(x.fields) && x.fields.every((f) => typeof f === 'string') && typeof x.retention === 'string' && typeof x.priceUsd === 'number';
}
