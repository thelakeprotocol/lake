import { randomUUID } from 'node:crypto';
import {
  buildCard, cardUrlFor, cellCount, cellLabels, unshardCounts, fieldSpec, collectiveCounter, makeEvent, signAgreement, signCard, signIntentMandate, signPaymentMandate, studyFields, studyId,
  pickTellers, type AgentCard, type Attachment, type Identity, type LakeEvent, type Offer, type SignedAgreement, type TellerRef, type Study,
} from '@thelakeprotocol/core';
import { readFile, writeFile } from 'node:fs/promises';
import { ask, type Visitor } from './knock.js';

/** The human at the research organisation who signs the spending mandate. Not the agent: a separate key. */
export interface Human {
  id: Identity;
  card: AgentCard;
  webId: string;
}

export async function makeHuman(id: Identity, domain: string, name = `Research lead (${domain})`): Promise<Human> {
  const webId = `https://${domain}/people/lead#me`;
  const card = await signCard(
    buildCard({ name, description: 'A person who signs spending mandates for agents.', url: `https://${domain}/people/lead`, skills: [], profile: { role: 'agent', webId, ownerDomain: domain, tags: ['human'] } }, id),
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
  /** Money: the human who signs the mandate, the cap, and who settles. Without it the study runs unpaid. */
  money?: { human: Human; budgetUsd: number; payments: string };
  link?: { report(e: LakeEvent): void; flush(): Promise<void> } | null;
  log?: (step: string, detail: string) => void;
}

interface House { id: string; name: string; url: string }
interface Joined { house: House; grant: string; agreement?: SignedAgreement; priceUsd: number }

export interface StudyRun {
  study: string;
  question: string;
  houses: number;
  decisions: Record<string, number>;
  bloc: { members: number; priceUsd: number; fields: string[] } | null;
  participants: number;
  excluded: { house: string; why: string }[];
  /** The exact table, from the two tellers' sums; empty when too few houses answered to publish one. */
  cells: { label: string; count: number }[];
  answer: { onX: { rate: number; n: number }; notOnX: { rate: number; n: number }; summary: string; reliable: boolean };
  paid: { total: number; houses: number; receiptsFiled: number; refused?: string; notFiled?: string[] } | null;
  seconds: number;
  /** The keys this agent was given, by house. Its own to keep until they expire or are revoked. */
  grants: { house: string; url: string; grant: string }[];
  /**
   * Everything signed that this study rests on, to show anyone (run 22 asked for it): the ethics approval and audit
   * certificate, the human's mandate, each house's countersigned agreement, both tellers' signed shares (their sum is
   * the table), and the payments agent's receipts. Each checks on its own; none needs this agent's word.
   */
  evidence: {
    ethics: Attachment; audit: Attachment; mandate?: Attachment;
    agreements: { house: string; agreement: SignedAgreement }[];
    tellers: { leader?: unknown; helper?: unknown };
    receipts: { payee: string; credential: string; card?: AgentCard; logged?: { index: number; origin: string } }[];
  };
}
/** The old name for a study run, kept so code written against it still compiles. */
export type MissionResult = StudyRun;

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

/** A study run: mandate → ethics → audit → discover → knock → bargain → agree → compute in place → pay → answer. */
export async function dispatch(o: DispatchOptions): Promise<StudyRun> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const report = (kind: Parameters<typeof makeEvent>[0], data: Record<string, string | number | boolean>) => o.link?.report(makeEvent(kind, 'self', undefined, data));
  // Who counts the answers is part of the study (ethics and the auditor approve it, houses check they trust both):
  // a study that names none gets two from the Lake before anything else.
  const study: Study = o.study.privacy.tellers?.length ? o.study : { ...o.study, privacy: { ...o.study.privacy, tellers: await findTellers(o, log) } };
  const id = studyId(study);
  const beat = () => new Promise((r) => setTimeout(r, o.paceMs ?? 0));
  const fields = [...studyFields(study), ...(o.extraFields ?? [])];
  // Every agreement this agent countersigns is a promise to pay. Without a budget to pay from, it offers $0 and accepts nothing more.
  const budget = o.money?.budgetUsd ?? 0;
  if (o.priceUsd > 0 && !o.money) throw new Error(`can't offer $${o.priceUsd} a house with no budget to pay it: set a budget, or offer $0`);

  let intent: Attachment | null = null;
  if (o.money) {
    const credential = await signIntentMandate(o.money.human.id, o.money.human.webId, {
      id: o.visitor.webId, natural_language_description: study.question, study: id,
      budget: { currency: 'USD', amount: o.money.budgetUsd }, intent_expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(), user_cart_confirmation_required: false,
    });
    intent = { credential, card: o.money.human.card };
    log('mandate', `${o.money.human.card.name} signed an Intent Mandate: this study only, budget $${o.money.budgetUsd}`);
  }

  log('ethics', 'asking the ethics agent to review the protocol');
  const ethics = await ask(o.ethics, o.visitor, { kind: 'ethics-review', protocol: { study, purpose: 'research', fields, retention: 'none' } });
  if (ethics.reply.kind !== 'approved') throw new Error(`ethics refused: ${(ethics.reply.problems ?? []).join('; ')}`);
  // Named by its signed domain, not the address it was reached at (inside a hosting setup, an internal hostname).
  log('ethics', `approved by ${ethics.from.ownerDomain}`);
  const ethicsAtt: Attachment = { credential: ethics.reply.credential, card: await cardOf(o.ethics) };
  await beat();

  log('audit', 'asking the auditor to certify the study');
  const audit = await ask(o.auditor, o.visitor, { kind: 'audit-study', study });
  if (audit.reply.kind !== 'certified') throw new Error(`auditor refused: ${(audit.reply.problems ?? []).join('; ')}`);
  log('audit', `certified by ${audit.from.ownerDomain}`);
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
        const { reply } = await askPatiently(h.url, o.visitor, { kind: 'offer', offer, study, attachments: { ethics: ethicsAtt, audit: auditAtt } });
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
  report('offer', { price: o.priceUsd, fields: fields.join(', '), purpose: 'research' });
  await knockAll(houses, offer, true);
  log('decide', Object.entries(decisions).map(([k, n]) => `${n} ${k}`).join(' · '));
  await beat();

  // Houses that countered the same offer bargain as one bloc: the highest price, only fields all accept (SPEC §5.3).
  let bloc: StudyRun['bloc'] = null;
  const b = collectiveCounter(counters.map((c) => c.counter));
  if (b) {
    bloc = { members: b.members, priceUsd: b.priceUsd, fields: b.fields };
    const dropped = fields.filter((f) => !b.fields.includes(f));
    log('bargain', `${b.members} housekeepers countered together: ${b.priceUsd === o.priceUsd ? `$${b.priceUsd}, the price offered` : `$${b.priceUsd}, not $${o.priceUsd}`}${dropped.length ? `, and drop ${dropped.join(', ')}` : ''}`);
    report('counter', { members: b.members, price: b.priceUsd, was: o.priceUsd });
    await beat();
    const everyone = [...new Map([...joined.values()].map((j) => [j.house.url, j.house])).values(), ...counters.map((c) => c.house)];
    const cost = b.priceUsd * everyone.length;
    const missing = studyFields(study).filter((f) => !b.fields.includes(f));
    if (missing.length) log('bargain', `declined: the bloc refuses ${missing.join(', ')}, which the study needs`);
    else if (cost > budget) log('bargain', o.money ? `declined: $${cost} is over the $${budget} mandate; a human must approve` : `declined: the bloc asks $${b.priceUsd} a house, and this study has no budget to pay it`);
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

  // Countersign only what the budget can pay: a house beyond it never gets a signed promise, so no deal is left unpaid.
  const excluded: StudyRun['excluded'] = [];
  let committed = 0;
  const affordable = [...joined.values()].filter((j) => {
    if (committed + j.priceUsd > budget) { excluded.push({ house: j.house.name, why: `over budget: $${budget} pays for no more houses at $${j.priceUsd}` }); return false; }
    committed += j.priceUsd;
    return true;
  });
  if (affordable.length < joined.size) log('compute', `${joined.size - affordable.length} house(s) agreed, but the $${budget} budget can't pay them; not countersigning those`);
  // A table needs at least the study's minimum of houses. With fewer, nothing will be published, so walk away before
  // countersigning (a countersignature is a promise to pay) rather than pay for answers nobody can read (run 13).
  let walkedAway = '';
  if (affordable.length && affordable.length < study.privacy.min) {
    walkedAway = `${affordable.length} joined, and no table is published from fewer than ${study.privacy.min} houses, so nothing was countersigned or paid`;
    log('compute', `only ${affordable.length} house(s) joined; a table needs ${study.privacy.min}: walking away before countersigning, nothing to pay`);
    for (const j of affordable) excluded.push({ house: j.house.name, why: `too few houses joined for a table (${affordable.length} of ${study.privacy.min})` });
    affordable.length = 0;
  }
  log('compute', `countersigning ${affordable.length} agreement(s) and running the certified study inside each house`);
  // One count per run, opened at the Leader, which sets it up with the Helper (DAP): each house sends each one a share.
  const tellers = study.privacy.tellers;
  const [leader, helper] = tellers as [TellerRef, TellerRef];
  const count = `run-${randomUUID()}`;
  if (affordable.length) {
    const { reply, from } = await askPatiently(leader.url, o.visitor, { kind: 'count.open', id: count, length: cellCount(study), min: study.privacy.min, deadline: new Date(Date.now() + 3_600_000).toISOString(), helper, ...(study.privacy.noise ? { noise: study.privacy.noise } : {}) });
    if (from.ownerDomain !== leader.domain) throw new Error(`the teller at ${leader.domain} answered as ${from.ownerDomain}`);
    if (reply.kind !== 'count.opened') throw new Error(`${leader.domain} would not open a count: ${(reply.problems ?? [reply.kind]).join('; ')}`);
    log('count', `opened a count at ${leader.domain} (Leader) with ${helper.domain} (Helper): each house's answer goes to them as two shares with a proof`);
  }
  const answered: (Joined & { webId: string })[] = [];
  await pool(affordable, o.concurrency ?? 32, async (j) => {
    try {
      const countersignature = j.agreement ? await signAgreement(j.agreement.agreement, o.visitor.id) : undefined;
      const { reply, from } = await askPatiently(j.house.url, o.visitor, { kind: 'compute', grant: j.grant, study, countersignature, count });
      if (reply.kind === 'counted' && reply.study === id && reply.count === count) answered.push({ ...j, webId: from.webId });
      else excluded.push({ house: j.house.name, why: String(reply.why ?? reply.kind) });
    } catch (e) {
      excluded.push({ house: j.house.name, why: (e as Error).message });
    }
  });

  await beat();
  // Only houses that answered get paid; excluded ones don't.
  let paid: StudyRun['paid'] = null;
  const kept: StudyRun['evidence']['receipts'] = [];
  if (o.money && intent && answered.length) {
    const webIdOf = (j: Joined) => String(j.agreement?.agreement.assigner ?? '');
    const payable = answered.filter((j) => j.agreement && j.priceUsd > 0);
    const payments = await Promise.all(payable.map((j) => signPaymentMandate(o.visitor.id, o.visitor.webId, { payee: webIdOf(j), amount: j.priceUsd, intentMandate: intent!.credential, agreement: j.agreement!.agreement.uid })));
    // Settle in batches; the payments agent keeps the running total against the human's budget.
    const receipts: { payee: string; credential: string; logged?: { index: number; origin: string } }[] = [];
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
      kept.push(...reply.receipts.map((r) => ({ ...r, card: paymentsCard })));
      log('pay', `Payments settled $${reply.total} with ${reply.receipts.length} participants; ${filed} receipts filed in their pods. $${reply.remaining} of the mandate left${refused ? `. Then refused: ${refused}` : ''}`);
    }
  }

  // Close both counts over the same houses: the ones that said they sent pieces and that both tellers heard from.
  // `took` is how many houses answered; `n` is how many the published table comes from (0 when too few to publish).
  let n = 0, took = 0;
  const tellerSigned: StudyRun['evidence']['tellers'] = {};
  let cells = Array<number>(cellCount(study)).fill(0);
  let tooFew = walkedAway;
  if (answered.length) {
    const reported = new Set(((await askPatiently(leader.url, o.visitor, { kind: 'count.members', id: count })).reply.members as string[] | undefined) ?? []);
    const members = answered.map((j) => j.webId).filter((w) => reported.has(w)).sort();
    took = members.length;
    if (members.length < study.privacy.min) tooFew = `${members.length} answered, and no table is published from fewer than ${study.privacy.min} houses`;
    else {
      // The Leader and Helper check every answer's proof together and each publish one aggregate share; added, the table.
      const leadAsk = await askPatiently(leader.url, o.visitor, { kind: 'count.close', id: count, members });
      const lead = leadAsk.reply;
      tellerSigned.leader = leadAsk.signed;
      const helpAsk = lead.kind === 'count.share' ? await askPatiently(helper.url, o.visitor, { kind: 'count.collect', id: count }) : null;
      const help = helpAsk?.reply ?? lead;
      if (helpAsk) tellerSigned.helper = helpAsk.signed;
      if (lead.kind !== 'count.share' || help.kind !== 'count.share') tooFew = `the tellers would not publish: ${((lead.kind !== 'count.share' ? lead : help).problems ?? ['no share']).join('; ')}`;
      else {
        cells = unshardCounts(cellCount(study), [lead.share, help.share], lead.count);
        n = lead.count;
        if (lead.rejected) log('count', `${lead.rejected} answer(s) failed their proof and were left out`);
      }
    }
  }
  // Bits: 0 the group (over 60), 1 the exposure (on drug X), 2 the outcome (readmitted).
  const [group, exposure, outcome] = study.predicates.map((p) => p.name);
  // With teller noise a small cell can come out below zero: count it as zero for the rates.
  const rate = (readmRaw: number, notRaw: number) => { const readm = Math.max(0, readmRaw), not = Math.max(0, notRaw); return { rate: readm + not > 0 ? readm / (readm + not) : 0, n: Math.round(readm + not) }; };
  const onX = rate(cells[0b111]!, cells[0b011]!);
  const notOnX = rate(cells[0b101]!, cells[0b001]!);
  // Exact counts: a table from a handful of houses is true, just small.
  const reliable = n >= 50;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  // Nobody took part: say so, rather than print a rate made of nothing.
  const summary = n === 0 ? (tooFew ? `No table: ${tooFew}.` : 'No answer: no house took part.') : `${group}, ${exposure}: ${pct(onX.rate)} ${outcome} (${onX.n}) vs ${pct(notOnX.rate)} not ${exposure} (${notOnX.n})`;
  log('answer', n === 0 ? summary : `${summary}. Exact counts from ${n} houses${reliable ? '' : '; a small sample, so read it with care'}`);
  // Houses batch their reports for ~150 ms; let theirs land first so the log reads in order.
  await new Promise((r) => setTimeout(r, 400));
  report('study.result', { participants: took, summary });
  await o.link?.flush();

  return {
    study: id, question: study.question, houses: houses.length, decisions, bloc, participants: took, excluded,
    cells: n ? cellLabels(study).map((label, i) => ({ label, count: cells[i]! })) : [],
    answer: { onX, notOnX, summary, reliable }, paid,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    grants: [...joined.values()].map((j) => ({ house: j.house.name, url: j.house.url, grant: j.grant })),
    evidence: {
      ethics: ethicsAtt, audit: auditAtt, ...(intent ? { mandate: intent } : {}),
      agreements: [...joined.values()].filter((j) => j.agreement).map((j) => ({ house: j.house.name, agreement: j.agreement! })),
      tellers: tellerSigned, receipts: kept,
    },
  };
}

/** Two tellers from the Lake, run under different names: what a study needs before anyone approves it. */
async function findTellers(o: DispatchOptions, log: (step: string, detail: string) => void): Promise<TellerRef[]> {
  const nodes = (Array.isArray(o.node) ? o.node : o.node.split(',')).map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);
  for (const node of nodes) {
    try {
      const found = (await (await fetch(`${node}/cards?skill=teller`, { signal: AbortSignal.timeout(5000) })).json()) as { card: AgentCard }[];
      const picked = pickTellers(found.map((f) => f.card));
      if (picked.length === 2) {
        log('count', `the answers will be counted by ${picked[0]!.domain} and ${picked[1]!.domain}`);
        if (o.houseCache) await writeFile(`${o.houseCache}.tellers`, JSON.stringify(picked)).catch(() => {});
        return picked;
      }
    } catch {
      // try the next node
    }
  }
  // Like houses, tellers are remembered: with every node down, a study still runs with the pair it used last time.
  if (o.houseCache) {
    const cached = JSON.parse(await readFile(`${o.houseCache}.tellers`, 'utf8').catch(() => '[]')) as TellerRef[];
    if (cached.length === 2) {
      log('count', `every node is down: counting with ${cached[0]!.domain} and ${cached[1]!.domain}, as last time`);
      return cached;
    }
  }
  throw new Error('no two tellers on the Lake: a study needs two, run by different parties, to count its answers');
}

/** Ask each node in turn; fall back to the houses remembered last time. Nodes are search indexes, not gatekeepers. */
async function discover(o: DispatchOptions, log: (step: string, detail: string) => void): Promise<House[]> {
  const nodes = (Array.isArray(o.node) ? o.node : o.node.split(',')).map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);
  // Houses advertise one skill per pack they take part in (`health-study`): look for the pack this study reads.
  const pack = studyFields(o.study).map((f) => fieldSpec(f)?.pack.id).find(Boolean);
  const skill = pack ? `${pack}-study` : '';
  for (const node of nodes) {
    try {
      log('discover', `searching the Lake's node for houses${skill ? ` with the ${skill} skill` : ''}`);
      const found = (await (await fetch(`${node}/cards?${skill ? `skill=${skill}&` : ''}role=house`, { signal: AbortSignal.timeout(5000) })).json()) as { id: string; card: AgentCard }[];
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
