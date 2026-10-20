import { randomUUID } from 'node:crypto';
import {
  buildCard, cardUrlFor, cellLabels, collectiveCounter, estimate, makeEvent, signAgreement, signCard, signIntentMandate, signPaymentMandate, studyFields, studyId,
  type AgentCard, type Attachment, type Identity, type LakeEvent, type Offer, type SignedAgreement, type Study,
} from '@thelakeprotocol/core';
import { readFile, writeFile } from 'node:fs/promises';
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

/** Questions the sandbox sponsor rotates through: a group, an exposure and an outcome, all certifiable. */
export const SANDBOX_STUDIES: Study[] = [
  readmissionStudy(),
  cohortStudy('Are people with heart failure on drug Y readmitted more?', { name: 'with heart failure', field: 'conditions', op: 'has_code', value: '84114007' }, { name: 'on drug Y', field: 'medications', op: 'has_code', value: 'drug-y' }),
  cohortStudy('Do over-50s on drug Z end up back in hospital?', { name: 'over 50', field: 'age_band', op: 'age_at_least', value: 50 }, { name: 'on drug Z', field: 'medications', op: 'has_code', value: 'drug-z' }),
  cohortStudy('Diabetes and drug X: more readmissions?', { name: 'with type 2 diabetes', field: 'conditions', op: 'has_code', value: '44054006' }, { name: 'on drug X', field: 'medications', op: 'has_code', value: 'drug-x' }),
  cohortStudy('Hypertension and drug Y: more readmissions?', { name: 'with hypertension', field: 'conditions', op: 'has_code', value: '38341003' }, { name: 'on drug Y', field: 'medications', op: 'has_code', value: 'drug-y' }),
];

function cohortStudy(question: string, group: Study['predicates'][number], exposure: Study['predicates'][number], epsilon = 2): Study {
  return { ...readmissionStudy(question, epsilon), predicates: [group, exposure, { name: 'readmitted', field: 'readmissions', op: 'present' }] };
}

/** The human at the research organisation who signs the spending mandate. Not the agent: a separate key. */
export interface Human {
  id: Identity;
  card: AgentCard;
  webId: string;
}

export async function makeHuman(id: Identity, domain: string): Promise<Human> {
  const webId = `https://${domain}/people/lead#me`;
  const card = await signCard(
    buildCard({ name: `Research lead (${domain})`, description: 'A person who signs spending mandates for agents.', url: `https://${domain}/people/lead`, skills: [], profile: { role: 'agent', webId, ownerDomain: domain, tags: ['human'] } }, id),
    id,
  );
  return { id, card, webId };
}

export interface DispatchOptions {
  visitor: Visitor;
  /** One or more Lake nodes (comma-separated or an array). Discovery tries each in turn. */
  node: string | string[];
  /** Remember discovered houses here, so a study can still find them with every node offline. */
  houseCache?: string;
  ethics: string;
  auditor: string;
  study: Study;
  priceUsd: number;
  /** Extra fields to ask for beyond what the study reads (e.g. postcode, to see houses push back). */
  extraFields?: string[];
  concurrency?: number;
  /** How long to wait for owners who were asked to tap Allow. 0: don't wait. */
  waitSeconds?: number;
  /** Pause between steps, so people can watch the map (stage demos). */
  paceMs?: number;
  /** Money: the human who signs the mandate, the cap, and who settles. Without it the mission runs unpaid. */
  money?: { human: Human; budgetUsd: number; payments: string };
  link?: { report(e: LakeEvent): void; flush(): Promise<void> } | null;
  log?: (step: string, detail: string) => void;
}

interface House { id: string; name: string; url: string }
interface Joined { house: House; grant: string; agreement?: SignedAgreement; priceUsd: number }

export interface MissionResult {
  study: string;
  question: string;
  houses: number;
  decisions: Record<string, number>;
  bloc: { members: number; priceUsd: number; fields: string[] } | null;
  participants: number;
  excluded: { house: string; why: string }[];
  cells: { label: string; estimate: number }[];
  answer: { onX: { rate: number; n: number }; notOnX: { rate: number; n: number }; summary: string; reliable: boolean };
  paid: { total: number; houses: number; receiptsFiled: number; refused?: string; notFiled?: string[] } | null;
  seconds: number;
  /** The keys this agent was given, by house. Its own to keep until they expire or are revoked. */
  grants: { house: string; url: string; grant: string }[];
}

/** Asks, and if the house is busy or doesn't answer in time, asks again (up to 3 tries, jittered backoff). */
async function askPatiently(url: string, v: Visitor, payload: Record<string, unknown>) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await ask(url, v, payload);
      if (r.reply.kind !== 'busy' || attempt === 3) return r;
      await new Promise((ok) => setTimeout(ok, Number(r.reply.retryAfterMs ?? 1500)));
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 + Math.random() * 2000 * attempt));
    }
  }
}

/** The research mission: mandate → ethics → audit → discover → knock → bargain → agree → compute in place → pay → answer. */
export async function dispatch(o: DispatchOptions): Promise<MissionResult> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const report = (kind: Parameters<typeof makeEvent>[0], data: Record<string, string | number | boolean>) => o.link?.report(makeEvent(kind, 'self', undefined, data));
  const id = studyId(o.study);
  const beat = () => new Promise((r) => setTimeout(r, o.paceMs ?? 0));
  const fields = [...studyFields(o.study), ...(o.extraFields ?? [])];

  let intent: Attachment | null = null;
  if (o.money) {
    const credential = await signIntentMandate(o.money.human.id, o.money.human.webId, {
      id: o.visitor.webId, natural_language_description: o.study.question, study: id,
      budget: { currency: 'USD', amount: o.money.budgetUsd }, intent_expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(), user_cart_confirmation_required: false,
    });
    intent = { credential, card: o.money.human.card };
    log('mandate', `${o.money.human.card.name} signed an Intent Mandate: this study only, budget $${o.money.budgetUsd}`);
  }

  log('ethics', `asking ${o.ethics} to review the protocol`);
  const ethics = await ask(o.ethics, o.visitor, { kind: 'ethics-review', protocol: { study: o.study, purpose: 'research', fields, retention: 'none' } });
  if (ethics.reply.kind !== 'approved') throw new Error(`ethics refused: ${(ethics.reply.problems ?? []).join('; ')}`);
  const ethicsAtt: Attachment = { credential: ethics.reply.credential, card: await cardOf(o.ethics) };
  await beat();

  log('audit', `asking ${o.auditor} to certify the study`);
  const audit = await ask(o.auditor, o.visitor, { kind: 'audit-study', study: o.study });
  if (audit.reply.kind !== 'certified') throw new Error(`auditor refused: ${(audit.reply.problems ?? []).join('; ')}`);
  const auditAtt: Attachment = { credential: audit.reply.credential, card: await cardOf(o.auditor) };
  await beat();

  const houses = await discover(o, log);

  const decisions: Record<string, number> = {};
  const joined = new Map<string, Joined>();
  const asked: House[] = [];
  const counters: { house: House; counter: { fields: string[]; priceUsd: number } }[] = [];
  const lost: string[] = [];
  const knockAll = async (targets: House[], offer: Offer, tally: boolean) => {
    await pool(targets, o.concurrency ?? 32, async (h) => {
      try {
        const { reply } = await askPatiently(h.url, o.visitor, { kind: 'offer', offer, study: o.study, attachments: { ethics: ethicsAtt, audit: auditAtt } });
        const d = reply.kind === 'decision' ? String(reply.decision) : 'rejected';
        if (tally) decisions[d] = (decisions[d] ?? 0) + 1;
        if (d === 'join' && reply.grant) joined.set(h.url, { house: h, grant: reply.grant, agreement: reply.agreement, priceUsd: offer.priceUsd });
        if (d === 'ask' && tally) asked.push(h);
        if (d === 'counter' && reply.counter && reply.bloc) counters.push({ house: h, counter: reply.counter });
      } catch {
        if (tally) decisions.unreachable = (decisions.unreachable ?? 0) + 1;
        else lost.push(h.name);
      }
    });
  };

  const terms = (price: number, f: string[]): Offer => ({
    id: randomUUID(), requester: o.visitor.domain, purpose: 'research', fields: f, retention: 'none', priceUsd: price, study: id,
    credentials: { ethicsApproved: true, sponsorVerified: true, auditCertified: true },
  });
  const offer = terms(o.priceUsd, fields);
  log('knock', `knocking on ${houses.length} houses: $${o.priceUsd} for ${fields.join(', ')}`);
  report('knock', { count: houses.length, purpose: 'research' });
  report('offer', { price: o.priceUsd, fields: fields.join(', '), purpose: 'research' });
  await knockAll(houses, offer, true);
  log('decide', Object.entries(decisions).map(([k, n]) => `${n} ${k}`).join(' · '));
  await beat();

  // Houses that countered the same offer bargain as one bloc: the highest price, only fields all accept (SPEC §5.3).
  let bloc: MissionResult['bloc'] = null;
  const b = collectiveCounter(counters.map((c) => c.counter));
  if (b) {
    bloc = { members: b.members, priceUsd: b.priceUsd, fields: b.fields };
    const dropped = fields.filter((f) => !b.fields.includes(f));
    log('bargain', `${b.members} housekeepers countered together: $${b.priceUsd}, not $${o.priceUsd}${dropped.length ? `, and drop ${dropped.join(', ')}` : ''}`);
    report('counter', { members: b.members, price: b.priceUsd, was: o.priceUsd });
    await beat();
    const everyone = [...new Map([...joined.values()].map((j) => [j.house.url, j.house])).values(), ...counters.map((c) => c.house)];
    const cost = b.priceUsd * everyone.length;
    const missing = studyFields(o.study).filter((f) => !b.fields.includes(f));
    if (missing.length) log('bargain', `declined: the bloc refuses ${missing.join(', ')}, which the study needs`);
    else if (o.money && cost > o.money.budgetUsd) log('bargain', `declined: $${cost} is over the $${o.money.budgetUsd} mandate; a human must approve`);
    else {
      log('bargain', `accepted: everyone who joined or countered gets the bloc's terms`);
      joined.clear();
      await knockAll(everyone, terms(b.priceUsd, b.fields), false);
      if (lost.length) log('bargain', `${lost.length} house(s) did not answer the bloc's terms (busy or unreachable)`);
    }
  }

  if (asked.length && (o.waitSeconds ?? 0) > 0) {
    log('wait', `${asked.length} house(s) asked their owners; waiting up to ${o.waitSeconds}s for a tap`);
    const end = Date.now() + o.waitSeconds! * 1000;
    let waiting = [...asked];
    while (waiting.length && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1000));
      const still: House[] = [];
      await pool(waiting, o.concurrency ?? 32, async (h) => {
        try {
          const { reply } = await ask(h.url, o.visitor, { kind: 'status', offerId: offer.id });
          if (reply.decision === 'join' && reply.grant) {
            joined.set(h.url, { house: h, grant: reply.grant, agreement: reply.agreement, priceUsd: offer.priceUsd });
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

  log('compute', `countersigning ${joined.size} agreement(s) and running the certified study inside each house`);
  const fragments: number[][] = [];
  const answered: Joined[] = [];
  const excluded: MissionResult['excluded'] = [];
  await pool([...joined.values()], o.concurrency ?? 32, async (j) => {
    try {
      const countersignature = j.agreement ? await signAgreement(j.agreement.agreement, o.visitor.id) : undefined;
      const { reply } = await askPatiently(j.house.url, o.visitor, { kind: 'compute', grant: j.grant, study: o.study, countersignature });
      if (reply.kind === 'fragment' && reply.study === id && Array.isArray(reply.fragment)) {
        fragments.push(reply.fragment as number[]);
        answered.push(j);
      } else excluded.push({ house: j.house.name, why: String(reply.why ?? reply.kind) });
    } catch (e) {
      excluded.push({ house: j.house.name, why: (e as Error).message });
    }
  });

  await beat();
  // Only houses that answered get paid; excluded ones don't.
  let paid: MissionResult['paid'] = null;
  if (o.money && intent && answered.length) {
    const webIdOf = (j: Joined) => String(j.agreement?.agreement.assigner ?? '');
    const payable = answered.filter((j) => j.agreement && j.priceUsd > 0);
    const payments = await Promise.all(payable.map((j) => signPaymentMandate(o.visitor.id, o.visitor.webId, { payee: webIdOf(j), amount: j.priceUsd, intentMandate: intent!.credential, agreement: j.agreement!.agreement.uid })));
    // Settle in batches; the payments agent keeps the running total against the human's budget.
    const receipts: { payee: string; credential: string }[] = [];
    let total = 0;
    let remaining = o.money.budgetUsd;
    let refused: string | undefined;
    for (let i = 0; i < payments.length && !refused; i += 100) {
      try {
        const { reply } = await askPatiently(o.money.payments, o.visitor, { kind: 'settle', intent, payments: payments.slice(i, i + 100) });
        if (reply.kind !== 'settled') refused = (reply.problems ?? []).join('; ');
        else { receipts.push(...reply.receipts); total += reply.total; remaining = reply.remaining; }
      } catch (e) {
        refused = (e as Error).message.slice(0, 200);
      }
    }
    if (refused && !receipts.length) {
      paid = { total: 0, houses: 0, receiptsFiled: 0, refused };
      log('pay', `refused: ${paid.refused}`);
    } else {
      const reply = { total, remaining, receipts };
      const paymentsCard = await cardOf(o.money.payments);
      let filed = 0;
      const notFiled: string[] = [];
      await pool(payable, o.concurrency ?? 32, async (j) => {
        const r = reply.receipts.find((x) => x.payee === webIdOf(j));
        if (!r) return;
        const { reply: ack } = await askPatiently(j.house.url, o.visitor, { kind: 'receipt', receipt: { credential: r.credential, card: paymentsCard } }).catch((e: Error) => ({ reply: { kind: 'error', why: e.message } as Record<string, any> }));
        if (ack.kind === 'filed') filed++;
        else notFiled.push(`${j.house.name}: ${ack.why ?? ack.kind}`);
      });
      paid = { total: reply.total, houses: reply.receipts.length, receiptsFiled: filed, ...(notFiled.length ? { notFiled } : {}), ...(refused ? { refused } : {}) };
      log('pay', `Payments settled $${reply.total} with ${reply.receipts.length} participants; ${filed} receipts filed in their pods. $${reply.remaining} of the mandate left${refused ? `. Then refused: ${refused}` : ''}`);
    }
  }

  const { n, cells } = estimate(o.study, fragments);
  // Bits: 0 the group (over 60), 1 the exposure (on drug X), 2 the outcome (readmitted).
  const [group, exposure, outcome] = o.study.predicates.map((p) => p.name);
  const rate = (readm: number, not: number) => ({ rate: readm + not > 0 ? readm / (readm + not) : 0, n: Math.round(readm + not) });
  const onX = rate(cells[0b111]!, cells[0b011]!);
  const notOnX = rate(cells[0b101]!, cells[0b001]!);
  const reliable = n >= 200;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const summary = `${group}, ${exposure}: ${pct(onX.rate)} ${outcome} (≈${onX.n}) vs ${pct(notOnX.rate)} not ${exposure} (≈${notOnX.n})`;
  log('answer', `${summary}${reliable ? '' : `. Only ${n} answers: randomised answers need a few hundred houses before this means anything`}`);
  // Houses batch their reports for ~150 ms; let theirs land first so the log reads in order.
  await new Promise((r) => setTimeout(r, 400));
  report('study.result', { participants: n, summary: reliable ? summary : `${n} answers, too few to call` });
  await o.link?.flush();

  return {
    study: id, question: o.study.question, houses: houses.length, decisions, bloc, participants: n, excluded,
    cells: cellLabels(o.study).map((label, i) => ({ label, estimate: Math.round(cells[i]! * 10) / 10 })),
    answer: { onX, notOnX, summary, reliable }, paid,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    grants: [...joined.values()].map((j) => ({ house: j.house.name, url: j.house.url, grant: j.grant })),
  };
}

/** Ask each node in turn; fall back to the houses remembered last time. Nodes are search indexes, not gatekeepers. */
async function discover(o: DispatchOptions, log: (step: string, detail: string) => void): Promise<House[]> {
  const nodes = (Array.isArray(o.node) ? o.node : o.node.split(',')).map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);
  for (const node of nodes) {
    try {
      log('discover', `searching ${node} for houses with the health-study skill`);
      const found = (await (await fetch(`${node}/cards?skill=health-study&role=house`, { signal: AbortSignal.timeout(5000) })).json()) as { id: string; card: AgentCard }[];
      // A relayed house lists one address per node; use the one on the node that answered.
      const houses = found.map((f) => ({ id: f.id, name: f.card.name, url: (f.card.supportedInterfaces.find((i) => i.url.startsWith(node)) ?? f.card.supportedInterfaces[0]!).url }));
      if (o.houseCache) await writeFile(o.houseCache, JSON.stringify(houses)).catch(() => {});
      return houses;
    } catch {
      log('discover', `${node} is unreachable`);
    }
  }
  if (o.houseCache) {
    const cached = JSON.parse(await readFile(o.houseCache, 'utf8').catch(() => '[]')) as House[];
    if (cached.length) {
      log('discover', `every node is down: using ${cached.length} houses remembered from last time (their cards live at their own .well-known)`);
      return cached;
    }
  }
  throw new Error('no node reachable and no houses remembered');
}

const cardCache = new Map<string, Promise<AgentCard>>();
function cardOf(agentUrl: string): Promise<AgentCard> {
  const u = agentUrl.endsWith('/a2a') ? cardUrlFor(agentUrl) : `${agentUrl.replace(/\/$/, '')}/.well-known/agent-card.json`;
  if (!cardCache.has(u)) cardCache.set(u, fetch(u, { headers: { 'A2A-Version': '1.0' } }).then((r) => r.json() as Promise<AgentCard>));
  return cardCache.get(u)!;
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}
