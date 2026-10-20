import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { rng, seedFrom } from '@thelakeprotocol/convert-fhir';
import {
  auditStudy, cellOf, checkAttachment, digestSRI, evaluate, issueCredential, makeEvent, randomize, ReplayGuard, signMessage, studyFields, studyId,
  verifyCredential, verifyLakeData,
  type AgentCard, type Attachment, type Identity, type JWK, type LakeData, type LakeEvent, type Offer, type Rules, type Study,
} from '@thelakeprotocol/core';
import { checkRecord, type RecordCheck, type Trust } from './record.js';
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
  claimsUrl: string;
  sandbox: boolean;
  /** Seeded demo runs: the same seed gives the same randomised answers. */
  seed?: string;
  /** The owner's side: pending asks, live grants, revocations. */
  desk: OwnerDesk;
  emit: (e: LakeEvent) => void;
}

type Decision = 'join' | 'decline' | 'ask' | 'counter';
export type Reply =
  | { kind: 'rejected'; code: string; why: string }
  | { kind: 'decision'; offerId: string; decision: Decision; reason: string; counter?: { fields: string[]; priceUsd: number }; grantHours?: number; grant?: string; holds: string[]; notes: string[] }
  | { kind: 'fragment'; study: string; fragment: number[] }
  | { kind: 'excluded'; study: string; why: string };

interface OfferPayload { kind: 'offer'; offer: Offer; study?: Study; attachments?: { ethics?: Attachment; audit?: Attachment } }
interface ComputePayload { kind: 'compute'; grant: string; study: Study }
interface StatusPayload { kind: 'status'; offerId: string }

const HOUR = 3_600_000;

/**
 * Answers every knock by the owner's rules, in code. A "join" under a standing rule the owner wrote is
 * the owner's pre-approval: the housekeeper records it as a signed grant that names that rule.
 * Certified studies run here, inside the house; only a randomised answer leaves.
 */
export class Housekeeper {
  private replay = new ReplayGuard();
  private record: RecordCheck = { ok: false, why: 'not checked yet' };
  private actor: string;

  constructor(private o: HousekeeperOptions) {
    this.actor = `house:${o.name}`;
  }

  async read(path: string): Promise<string> {
    return this.tool('pod_read', { path });
  }

  async verifyOwnRecord(): Promise<RecordCheck> {
    this.record = await checkRecord((p) => this.read(p), { claimsUrl: this.o.claimsUrl, ownJwk: this.o.id.publicJwk as JWK, webId: this.o.webId, trust: this.o.trust, sandbox: this.o.sandbox });
    return this.record;
  }

  async handle(data: LakeData | null): Promise<LakeData> {
    const v = await verifyLakeData(data as LakeData<OfferPayload | ComputePayload | StatusPayload> | null, { replay: this.replay, sandbox: this.o.sandbox });
    if (!v.ok) {
      // Unverified, so only a label: the domain the card claims, or its name.
      const claimed = (data?.card?.capabilities?.extensions?.[0]?.params as { ownerDomain?: unknown } | undefined)?.ownerDomain;
      const who = typeof claimed === 'string' ? `agent:${claimed.slice(0, 60)}` : String(data?.card?.name ?? 'unknown agent').slice(0, 60);
      this.o.emit(makeEvent('attack.blocked', this.actor, who, { why: v.rejection.code }));
      return this.reply({ kind: 'rejected', code: v.rejection.code, why: v.rejection.why });
    }
    const visitor = `agent:${v.profile.ownerDomain}`;
    if (v.payload.kind === 'offer') return this.offer(v.payload as OfferPayload, v.profile.ownerDomain, v.profile.webId, visitor);
    if (v.payload.kind === 'compute') return this.compute(v.payload as ComputePayload, v.profile.webId, visitor);
    if (v.payload.kind === 'status') return this.status(v.payload as StatusPayload, v.profile.webId);
    return this.reply({ kind: 'rejected', code: 'malformed', why: 'expected an offer or a compute request' });
  }

  private async offer(p: OfferPayload, domain: string, visitorWebId: string, visitor: string): Promise<LakeData> {
    const offer = p.offer;
    if (!isOffer(offer)) return this.reply({ kind: 'rejected', code: 'malformed', why: 'expected a Lake offer' });
    if (offer.requester !== domain) {
      this.o.emit(makeEvent('attack.blocked', this.actor, visitor, { why: 'impersonation' }));
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

    const d = evaluate(this.o.rules, { ...offer, credentials: { sponsorVerified: true, ethicsApproved, auditCertified } });
    if (d.decision === 'ask') {
      this.o.desk.ask({
        offerId: offer.id, visitor: { webId: visitorWebId, domain, name: domain }, purpose: offer.purpose, fields: offer.fields, retention: offer.retention,
        priceUsd: offer.priceUsd, study: offer.study ?? null, question: p.study?.question, recommendation: [d.reason, ...notes].join('. '),
      });
    }
    if (d.decision !== 'join') return decide(d.decision, d.reason, d.decision === 'counter' ? { counter: d.counter } : {});
    const chain = await this.verifyOwnRecord();
    if (!chain.ok) return decide('decline', `my own record failed its checks (${chain.why}), so I won't take part`);

    const grant = await issueCredential(
      {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential', 'LakeAccessGrant'],
        issuer: this.o.webId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + d.grantHours * HOUR).toISOString(),
        credentialSubject: { id: visitorWebId, offer: offer.id, study: offer.study ?? null, fields: d.fields, purpose: offer.purpose, authorizedBy: `standing rule ${d.rule}`, rules: digestSRI(this.o.rulesText) },
      } as never,
      this.o.id,
    );
    await this.tool('pod_write', { path: `agreements/${offer.id}.grant.jwt`, content: grant, contentType: 'text/plain' });
    this.o.desk.record({ id: offer.id, jws: grant, visitor: domain, fields: d.fields, purpose: offer.purpose, until: new Date(Date.now() + d.grantHours * HOUR).toISOString(), authorizedBy: `standing rule ${d.rule}` });
    this.o.emit(makeEvent('grant.issued', this.actor, visitor, { hours: d.grantHours }));
    return decide('join', d.reason, { grantHours: d.grantHours, grant });
  }

  private async compute(p: ComputePayload, requester: string, visitor: string): Promise<LakeData> {
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
    const chain = await this.verifyOwnRecord();
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

  /** A visitor waiting on an "ask" checks back: has the owner answered? */
  private async status(p: StatusPayload, requester: string): Promise<LakeData> {
    const req = this.o.desk.pending.get(p.offerId);
    if (!req || req.visitor.webId !== requester) return this.reply({ kind: 'rejected', code: 'malformed', why: 'no such request from you' });
    const base = { kind: 'decision' as const, offerId: req.offerId, holds: [], notes: [] };
    if (req.status === 'allowed') return this.reply({ ...base, decision: 'join', reason: 'your owner tapped Allow', grant: req.grant, grantHours: 48 });
    if (req.status === 'denied') return this.reply({ ...base, decision: 'decline', reason: 'the owner said no' });
    return this.reply({ ...base, decision: 'ask', reason: 'still waiting for the owner' });
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.o.pod.callTool({ name, arguments: args });
    const t = (r.content as { text: string }[])[0]?.text ?? '';
    if (r.isError) throw new Error(t);
    return t;
  }

  private async claims(fields: string[]): Promise<PodClaim[]> {
    try {
      return JSON.parse(await this.tool('pod_claims', { fields })) as PodClaim[];
    } catch {
      return [];
    }
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
