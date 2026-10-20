import { randomUUID } from 'node:crypto';
import {
  cellLabels, estimate, makeEvent, studyFields, studyId,
  type AgentCard, type Attachment, type LakeLink, type Offer, type Study,
} from '@thelakeprotocol/core';
import { ask, type Visitor } from './knock.js';

export function readmissionStudy(question = 'Do over-60s on drug X get readmitted less?', epsilon = 2): Study {
  return {
    v: 1,
    question,
    kind: 'contingency',
    predicates: [
      { name: 'over 60', field: 'age_band', op: 'age_at_least', value: 60 },
      { name: 'on drug X', field: 'medications', op: 'has_code', value: 'drug-x' },
      { name: 'readmitted', field: 'readmissions', op: 'present' },
    ],
    privacy: { mechanism: 'unary-randomized-response', epsilon },
    minTier: 'issuer-signed',
  };
}

export interface DispatchOptions {
  visitor: Visitor;
  node: string;
  ethics: string;
  auditor: string;
  study: Study;
  priceUsd: number;
  /** Extra fields to ask for beyond what the study reads (e.g. postcode, to test the houses). */
  extraFields?: string[];
  concurrency?: number;
  /** How long to wait for owners who were asked to tap Allow. 0: don't wait. */
  waitSeconds?: number;
  link?: LakeLink | null;
  log?: (step: string, detail: string) => void;
}

export interface MissionResult {
  study: string;
  question: string;
  houses: number;
  decisions: Record<string, number>;
  participants: number;
  excluded: { house: string; why: string }[];
  cells: { label: string; estimate: number }[];
  answer: { onX: { rate: number; n: number }; notOnX: { rate: number; n: number }; summary: string; reliable: boolean };
  seconds: number;
  /** The keys this agent was given, by house. Its own to keep until they expire or are revoked. */
  grants: { house: string; url: string; grant: string }[];
}

/** The research mission, without money: ethics → audit → discover → knock → decide → grant → compute in place → answer. */
export async function dispatch(o: DispatchOptions): Promise<MissionResult> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const id = studyId(o.study);
  const fields = [...studyFields(o.study), ...(o.extraFields ?? [])];

  log('ethics', `asking ${o.ethics} to review the protocol`);
  const ethics = await ask(o.ethics, o.visitor, { kind: 'ethics-review', protocol: { study: o.study, purpose: 'research', fields, retention: 'none' } });
  if (ethics.reply.kind !== 'approved') throw new Error(`ethics refused: ${(ethics.reply.problems ?? []).join('; ')}`);
  const ethicsAtt: Attachment = { credential: ethics.reply.credential, card: (await cardOf(o.ethics)) };

  log('audit', `asking ${o.auditor} to certify the study`);
  const audit = await ask(o.auditor, o.visitor, { kind: 'audit-study', study: o.study });
  if (audit.reply.kind !== 'certified') throw new Error(`auditor refused: ${(audit.reply.problems ?? []).join('; ')}`);
  const auditAtt: Attachment = { credential: audit.reply.credential, card: await cardOf(o.auditor) };

  log('discover', `searching ${o.node} for houses with the health-study skill`);
  const found = (await (await fetch(`${o.node}/cards?skill=health-study&role=house`)).json()) as { id: string; card: AgentCard }[];
  const houses = found.map((f) => ({ id: f.id, name: f.card.name, url: f.card.supportedInterfaces[0]!.url }));

  const offer: Offer = { id: randomUUID(), requester: o.visitor.domain, purpose: 'research', fields, retention: 'none', priceUsd: o.priceUsd, study: id, credentials: { ethicsApproved: true, sponsorVerified: true, auditCertified: true } };
  log('knock', `knocking on ${houses.length} houses: $${o.priceUsd} for ${fields.join(', ')}`);
  o.link?.report(makeEvent('knock', 'self', undefined, { count: houses.length, purpose: 'research' }));
  o.link?.report(makeEvent('offer', 'self', undefined, { price: o.priceUsd, fields: fields.join(', '), purpose: 'research' }));

  const decisions: Record<string, number> = {};
  const joined: { house: (typeof houses)[number]; grant: string }[] = [];
  const asked: (typeof houses)[number][] = [];
  await pool(houses, o.concurrency ?? 32, async (h) => {
    try {
      const { reply } = await ask(h.url, o.visitor, { kind: 'offer', offer, study: o.study, attachments: { ethics: ethicsAtt, audit: auditAtt } });
      const d = reply.kind === 'decision' ? String(reply.decision) : 'rejected';
      decisions[d] = (decisions[d] ?? 0) + 1;
      if (d === 'join' && reply.grant) joined.push({ house: h, grant: reply.grant });
      if (d === 'ask') asked.push(h);
    } catch {
      decisions.unreachable = (decisions.unreachable ?? 0) + 1;
    }
  });
  log('decide', Object.entries(decisions).map(([k, n]) => `${n} ${k}`).join(' · '));

  if (asked.length && (o.waitSeconds ?? 0) > 0) {
    log('wait', `${asked.length} house(s) asked their owners; waiting up to ${o.waitSeconds}s for a tap`);
    const end = Date.now() + o.waitSeconds! * 1000;
    let waiting = [...asked];
    while (waiting.length && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1000));
      const still: typeof waiting = [];
      await pool(waiting, o.concurrency ?? 32, async (h) => {
        try {
          const { reply } = await ask(h.url, o.visitor, { kind: 'status', offerId: offer.id });
          if (reply.decision === 'join' && reply.grant) {
            joined.push({ house: h, grant: reply.grant });
            log('allow', `the owner of ${h.name} tapped Allow`);
          } else if (reply.decision === 'decline') log('deny', `the owner of ${h.name} said no`);
          else still.push(h);
        } catch {
          still.push(h);
        }
      });
      waiting = still;
    }
  }

  log('compute', `running the certified study inside ${joined.length} houses`);
  const fragments: number[][] = [];
  const excluded: MissionResult['excluded'] = [];
  await pool(joined, o.concurrency ?? 32, async ({ house, grant }) => {
    try {
      const { reply } = await ask(house.url, o.visitor, { kind: 'compute', grant, study: o.study });
      if (reply.kind === 'fragment' && reply.study === id && Array.isArray(reply.fragment)) fragments.push(reply.fragment as number[]);
      else excluded.push({ house: house.name, why: String(reply.why ?? reply.kind) });
    } catch (e) {
      excluded.push({ house: house.name, why: (e as Error).message });
    }
  });

  const { n, cells } = estimate(o.study, fragments);
  // Bits: 0 over 60, 1 on drug X, 2 readmitted.
  const rate = (readm: number, not: number) => ({ rate: readm + not > 0 ? readm / (readm + not) : 0, n: Math.round(readm + not) });
  const onX = rate(cells[0b111]!, cells[0b011]!);
  const notOnX = rate(cells[0b101]!, cells[0b001]!);
  const reliable = n >= 200;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const summary = `over-60s on drug X: ${pct(onX.rate)} readmitted (≈${onX.n}) vs ${pct(notOnX.rate)} not on it (≈${notOnX.n})`;
  log('answer', `${summary}${reliable ? '' : `. Only ${n} answers: randomised answers need a few hundred houses before this means anything`}`);
  // Houses batch their reports for ~150 ms; let theirs land first so the log reads in order.
  await new Promise((r) => setTimeout(r, 400));
  o.link?.report(makeEvent('study.result', 'self', undefined, { participants: n, summary: reliable ? summary : `${n} answers, too few to call` }));
  await o.link?.flush();

  return {
    study: id, question: o.study.question, houses: houses.length, decisions, participants: n, excluded,
    cells: cellLabels(o.study).map((label, i) => ({ label, estimate: Math.round(cells[i]! * 10) / 10 })),
    answer: { onX, notOnX, summary, reliable },
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    grants: joined.map((j) => ({ house: j.house.name, url: j.house.url, grant: j.grant })),
  };
}

const cardCache = new Map<string, Promise<any>>();
function cardOf(agentUrl: string) {
  const u = new URL('/.well-known/agent-card.json', agentUrl).href;
  if (!cardCache.has(u)) cardCache.set(u, fetch(u, { headers: { 'A2A-Version': '1.0' } }).then((r) => r.json()));
  return cardCache.get(u)!;
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}
