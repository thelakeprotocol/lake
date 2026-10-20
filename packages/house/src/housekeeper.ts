import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  evaluate, makeEvent, ReplayGuard, signMessage, verifyLakeData,
  type AgentCard, type Identity, type JWK, type LakeData, type LakeEvent, type Offer, type Rules,
} from '@thelakeprotocol/core';
import { checkRecord, type RecordCheck } from './record.js';
import type { PodClaim } from './pod-mcp.js';

export interface HousekeeperOptions {
  name: string;
  webId: string;
  id: Identity;
  card: AgentCard;
  rules: Rules;
  /** MCP client connected to this house's pod: the housekeeper's only way in. */
  pod: Client;
  claimsUrl: string;
  sandbox: boolean;
  emit: (e: LakeEvent) => void;
}

export type Reply =
  | { kind: 'rejected'; code: string; why: string }
  | { kind: 'decision'; offerId: string; decision: 'join' | 'decline' | 'ask' | 'counter'; reason: string; counter?: { fields: string[]; priceUsd: number }; grantHours?: number; holds: string[]; notes: string[] };

/**
 * Answers every knock by the owner's rules, in code. Never issues a key: a "join" is the owner's
 * standing pre-approval, and keys are minted by the owner's approval flow (milestone 4).
 */
export class Housekeeper {
  private replay = new ReplayGuard();
  private record: RecordCheck = { ok: false, why: 'not checked yet' };
  private actor: string;

  constructor(private o: HousekeeperOptions) {
    this.actor = `house:${o.name}`;
  }

  async read(path: string): Promise<string> {
    const r = await this.o.pod.callTool({ name: 'pod_read', arguments: { path } });
    const t = (r.content as { type: string; text: string }[])[0]?.text ?? '';
    if (r.isError) throw new Error(t);
    return t;
  }

  async verifyOwnRecord(): Promise<RecordCheck> {
    this.record = await checkRecord((p) => this.read(p), { claimsUrl: this.o.claimsUrl, ownJwk: this.o.id.publicJwk as JWK });
    return this.record;
  }

  async handle(data: LakeData | null): Promise<LakeData> {
    const v = await verifyLakeData(data as LakeData<{ kind: string; offer?: Offer }> | null, { replay: this.replay, sandbox: this.o.sandbox });
    if (!v.ok) {
      const who = data?.card?.name ?? 'unknown agent';
      this.o.emit(makeEvent('attack.blocked', this.actor, who, { why: v.rejection.code }));
      return this.reply({ kind: 'rejected', code: v.rejection.code, why: v.rejection.why });
    }
    const { profile, payload } = v;
    const visitor = `agent:${profile.ownerDomain}`;
    if (payload.kind !== 'offer' || !isOffer(payload.offer)) return this.reply({ kind: 'rejected', code: 'malformed', why: 'expected a Lake offer' });
    if (payload.offer.requester !== profile.ownerDomain) {
      this.o.emit(makeEvent('attack.blocked', this.actor, visitor, { why: 'impersonation' }));
      return this.reply({ kind: 'rejected', code: 'impersonation', why: `card is for ${profile.ownerDomain}, offer claims ${payload.offer.requester}` });
    }
    this.o.emit(makeEvent('knock', visitor, this.actor, { purpose: payload.offer.purpose }));

    // Credentials are believed only when they can be verified. Ethics approvals and audit certificates
    // arrive as signed credentials from milestone 3; until then they count as absent, whatever the offer says.
    const offer: Offer = { ...payload.offer, credentials: { sponsorVerified: true, ethicsApproved: false, auditCertified: false } };
    const notes = ['ethics and audit credentials are verified from milestone 3; until then they count as absent'];
    if (v.domainVia === 'sandbox') notes.push('sandbox Lake: the visitor domain was not proved');

    const held = await this.claims(offer.fields);
    const holds = [...new Set(held.map((c) => c.field))];
    let d = evaluate(this.o.rules, offer);
    if (d.decision === 'join' && !(await this.verifyOwnRecord()).ok) {
      const why = (this.record as { why: string }).why;
      d = { decision: 'decline', rule: d.rule, reason: `my own record failed its signature check (${why}), so I won't take part` };
    }
    this.o.emit(makeEvent('decision', this.actor, visitor, { decision: d.decision, reason: d.reason }));
    if (d.decision === 'ask') this.o.emit(makeEvent('approval.requested', this.actor, visitor, { purpose: offer.purpose }));
    return this.reply({
      kind: 'decision',
      offerId: offer.id,
      decision: d.decision,
      reason: d.reason,
      ...(d.decision === 'counter' ? { counter: d.counter } : {}),
      ...(d.decision === 'join' ? { grantHours: d.grantHours } : {}),
      holds,
      notes,
    });
  }

  private async claims(fields: string[]): Promise<PodClaim[]> {
    const r = await this.o.pod.callTool({ name: 'pod_claims', arguments: { fields } });
    return r.isError ? [] : (JSON.parse((r.content as { text: string }[])[0]!.text) as PodClaim[]);
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
