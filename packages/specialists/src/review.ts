import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  auditProgram, auditStudy, checkCredentialStatus, verifyOwnerKey, purposeWithin, buildCard, digestSRI, identifyingFields, packs, programId, type QuoteProgram, makeEvent, type LakeEvent, verifyCredential, verifyLakeCard, issueCredential, lakeAgentApp, ReplayGuard, sendLake, deliverWithRetries, signCard, signMessage, studyFields, studyId, verifyLakeData,
  packId, pledgeAgreement, checkCart, cartTerms, checkDeed, issueDeed, deedAnswerPasses, DEED_ASSET, checkSplitConsent, cardUrlFor, checkBadges, isParty, keyThumbprint, ASSISTANT_KEY_TYPE, DISPUTE_CODES, EMPTY_SHA256, type DisputeCode, type SettledHow, type CartMandate, type CartParty, type CheckedCart, type AgentCard, type Identity, type LakeData, type LakePack, type LakeProfile, type Study,
} from '@thelakeprotocol/core';
import type express from 'express';

export interface SpecialistOptions { id: Identity; url: string; domain: string; sandbox: boolean; report?: (e: LakeEvent) => void }
type Reply =
  | { kind: 'approved' | 'certified'; credential: string; notes: string[] }
  | { kind: 'settled'; receipts: { payee: string; credential: string; logged?: { index: number; origin: string } }[]; currency?: string; total: number; remaining: number }
  | { kind: 'registered'; pack: string; domain: string; registered: boolean; register: string }
  | { kind: 'refused'; problems: string[] };

/** Converters this auditor has reviewed: those of the packs it runs with. A real auditor would pin the package digest too. */
const certifiedConverters = () => packs().map((p) => p.source?.converter).filter(Boolean);
const DAY = 86_400_000;

export type Refused = { kind: 'refused'; problems: string[] };
export interface Specialist { app: express.Express; card: AgentCard; webId: string; vc: (type: string, subject: Record<string, unknown> & { id: string }, days: number) => Promise<string> }

/** A signed Lake agent with one skill: verifies every message before `decide` sees it, signs every reply. */
export async function specialist<R extends { kind: string } = Reply>(o: SpecialistOptions, name: string, description: string, skill: string, decide: (payload: Record<string, unknown>, from: string, profile: LakeProfile, card: AgentCard, /** The sender's signed envelope, as received. */ envelope: LakeData['envelope']) => Promise<R | Refused>, extraSkills: { id: string; name: string; description: string }[] = [], quiet = false, anonymous?: (payload: Record<string, unknown>) => boolean): Promise<Specialist> {
  const webId = `${o.url}/#${skill}`;
  const card = await signCard(
    // A quiet agent's visitors are nobody's business: it says so on its card, and reports no visits.
    buildCard({ name, description, url: `${o.url}/a2a`, skills: [{ id: skill, name, description }, ...extraSkills], profile: { role: 'specialist', webId, ownerDomain: o.domain, tags: quiet ? [skill, 'quiet'] : [skill] } }, o.id),
    o.id,
  );
  const replay = new ReplayGuard();
  const reply = async (body: R | Refused): Promise<LakeData> => ({ lake: '0.1', card, envelope: (await signMessage(body, o.id, { iss: webId })) as LakeData['envelope'] });
  const app = lakeAgentApp(card, async (data) => {
    // A message whose authority is something it carries (a blind pledge's pass), not who sent it, may come from a
    // throwaway identity whose domain proves nothing; its card and signature are still checked, and replays refused.
    const anon = !!anonymous?.(((data as LakeData | null)?.envelope?.payload ?? {}) as Record<string, unknown>);
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox || anon });
    if (!v.ok) return reply({ kind: 'refused', problems: [`${v.rejection.code}: ${v.rejection.why}`] });
    const out = await decide(v.payload, v.profile.webId, v.profile, (data as LakeData).card, (data as LakeData).envelope);
    // Tell the map who just came by, so it can show the visit. Ids and kinds only.
    if (out.kind !== 'refused' && !quiet) o.report?.(makeEvent('decision', 'self', `agent:${v.profile.ownerDomain}`, { decision: out.kind }));
    return reply(out);
  }, o.id, { replay });
  const vc = (type: string, subject: Record<string, unknown> & { id: string }, days: number) =>
    issueCredential(
      { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', type], issuer: webId, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + days * DAY).toISOString(), credentialSubject: subject } as never,
      o.id,
    );
  return { app, card, webId, vc };
}

export interface Protocol { study: Study; purpose: string; fields: string[]; retention: string }

/**
 * The demo ethics checklist. Data minimisation: a protocol declares exactly the fields its study's questions read, no
 * more (run 28's rogue padded one with shopping fields, and this checklist signed it). A visitor that wants to see owners
 * bargain puts extras in its offer, outside the approval, where owners' rules can drop them.
 */
export function ethicsProblems(protocol: Partial<Protocol> | undefined): string[] {
  if (!protocol?.study) return ['no study in the protocol'];
  const problems: string[] = [];
  const fields = Array.isArray(protocol.fields) ? protocol.fields.map(String) : [];
  if (!purposeWithin(String(protocol.purpose), 'research')) problems.push('purpose must be research');
  if (protocol.retention !== 'none') problems.push('results only; no retention of anything else');
  const identifying = fields.filter((f) => identifyingFields().includes(f));
  if (identifying.length) problems.push(`directly identifying fields: ${identifying.join(', ')}`);
  const reads = studyFields(protocol.study);
  const missing = reads.filter((f) => !fields.includes(f));
  if (missing.length) problems.push(`the study uses fields the protocol doesn't declare: ${missing.join(', ')}`);
  const extra = fields.filter((f) => !reads.includes(f) && !identifying.includes(f));
  if (extra.length) problems.push(`data minimisation: the study never reads ${extra.join(', ')}; declare only the fields its questions read`);
  const audit = auditStudy(protocol.study);
  if (!audit.ok) problems.push(...audit.problems);
  return problems;
}

/**
 * The demo Ethics agent: a fixed checklist, clearly labelled. A real one is a door to a human committee;
 * owners decide which ethics domains they trust (rules.yaml → trust.ethics).
 */
export async function createEthics(o: SpecialistOptions): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const s: Specialist = await specialist<Reply>(o, 'Ethics (demo checklist)', 'Reviews study protocols against a fixed checklist. A demo, not a human ethics committee.', 'ethics-review', async (p, from) => {
    if (p.kind !== 'ethics-review') return { kind: 'refused', problems: ['send { kind: "ethics-review", protocol }'] };
    const protocol = p.protocol as Protocol | undefined;
    const problems = ethicsProblems(protocol);
    if (problems.length || !protocol) return { kind: 'refused', problems };
    // The approval names exactly the fields the study reads.
    const credential = await s.vc('LakeEthicsApproval', { id: studyId(protocol.study), question: protocol.study.question, purpose: protocol.purpose, fields: studyFields(protocol.study), sponsor: from, reviewedBy: 'demo checklist, not a human committee' }, 90);
    return { kind: 'approved', credential, notes: ['demo approval: counts only with owners who trust this domain'] };
  });
  return { app: s.app, card: s.card, webId: s.webId };
}

/** The demo Auditor: certifies declarative studies the Lake can run safely, and reviewed converter packages. */
export async function createAuditor(o: SpecialistOptions): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  // When each study was certified (in memory: a demo auditor's short memory is enough to warn about repeats).
  const certified = new Map<string, number[]>();
  const s: Specialist = await specialist<Reply>(o, 'Auditor (demo)', 'Certifies studies (exact totals of known questions, counted by two tellers) and converter packages.', 'study-audit', async (p) => {
    if (p.kind === 'audit-study') {
      const study = p.study as Study;
      // auditStudy also refuses a study reading a register's fields that its pack keeps from studies (SPEC §5.2).
      const audit = auditStudy(study);
      if (!audit.ok) return { kind: 'refused', problems: audit.problems };
      const credential = await s.vc('LakeStudyCertificate', { id: studyId(study), checks: ['declarative study, no code', 'answers split between two tellers run by different parties', 'totals only', `no table from fewer than ${study.privacy.min} houses`] }, 90);
      // How often this very study was certified lately: run 31's three researchers each paid $45 for the same table, unaware.
      const id = studyId(study), week = Date.now() - 7 * 86_400_000;
      const seen = (certified.get(id) ?? []).filter((t) => t > week);
      certified.set(id, [...seen, Date.now()]);
      return { kind: 'certified', credential, notes: seen.length ? [`this exact study was certified ${seen.length} time${seen.length === 1 ? '' : 's'} in the last 7 days: its answer may already exist; ask around before paying for it again`] : [] };
    }
    if (p.kind === 'audit-program') {
      // Quote programs: declarative, bounded, reading only safe fields of a pack here, shown only to the owner.
      const program = p.program as QuoteProgram;
      const audit = auditProgram(program);
      if (!audit.ok) return { kind: 'refused', problems: audit.problems };
      const credential = await s.vc('LakeProgramCertificate', { id: programId(program), pack: program.pack, checks: ['declarative program, no code', 'reads only safe fields of its pack', 'result shown to the owner only'] }, 90);
      return { kind: 'certified', credential, notes: [] };
    }
    if (p.kind === 'audit-converter') {
      const pkg = String(p.package ?? '');
      if (!certifiedConverters().includes(pkg)) return { kind: 'refused', problems: [`${pkg} has not been reviewed`] };
      const credential = await s.vc('LakeConverterCertificate', { id: `urn:lake:converter:${pkg}`, package: pkg }, 365);
      return { kind: 'certified', credential, notes: [] };
    }
    return { kind: 'refused', problems: ['send { kind: "audit-study", study }, { kind: "audit-program", program } or { kind: "audit-converter", package }'] };
  });
  return { app: s.app, card: s.card, webId: s.webId };
}

/**
 * A demo authority for a pack (for mortgages: a stand-in for a register of authorised firms, like the FCA's).
 * It authorises the agents on its register to quote for that pack, as a signed credential houses check.
 */
export async function createAuthority(o: SpecialistOptions & { pack: LakePack; dataDir?: string }): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const a = o.pack.authority!;
  const id = packId(o.pack);
  // Deeds it certified and redeemed (SPEC §6.7): each spent once, for one cart, kept on disk before it says so.
  const deedFile = o.dataDir ? `${o.dataDir}/deeds-${o.pack.id}.json` : undefined;
  const deeds: { earned: Record<string, number>; spent: Record<string, { cart: string; hash: string; seller: string; receipt: string; at: number }>; lastBy: Record<string, number> } =
    deedFile ? await readFile(deedFile, 'utf8').then((t) => JSON.parse(t)).catch(() => ({ earned: {}, spent: {}, lastBy: {} })) : { earned: {}, spent: {}, lastBy: {} };
  const saveDeeds = async () => { if (!deedFile) return; await mkdir(o.dataDir!, { recursive: true }); await writeFile(`${deedFile}.tmp`, JSON.stringify(deeds)); await rename(`${deedFile}.tmp`, deedFile); };
  const DEED_EVERY_MS = Number(process.env.LAKE_DEED_EVERY_MS ?? 10 * 60_000);
  const s: Specialist = await specialist<Reply>(o, a.name, `${a.description} Anyone may check an agent: { kind: "registered", domain }.`, 'authorise', async (p, from, profile) => {
    if (a.deeds && String(p.kind).startsWith('deed.')) return (await deedReply(p, from, profile)) as unknown as Reply;
    // Anyone may ask whether an agent is on the register (run 26's agents couldn't check a grocer before talking to it).
    if (p.kind === 'registered') {
      const domain = String(p.domain ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/[/#].*$/, '');
      return { kind: 'registered', pack: id, domain, registered: a.register.includes(domain), register: a.name };
    }
    if (p.kind !== 'authorise') return { kind: 'refused', problems: ['send { kind: "authorise", pack } for yourself, or { kind: "registered", domain } to check anyone'] };
    if (p.pack !== id) return { kind: 'refused', problems: [`this register covers ${id}`] };
    if (!a.register.includes(profile.ownerDomain)) return { kind: 'refused', problems: [`${profile.ownerDomain} is not on the register`] };
    // Pinned to the agent's key as well as its WebID (cnf.jkt, RFC 7800): it can go on that agent's card as a badge, and
    // one owner's agents share a WebID.
    const credential = await s.vc('LakeAuthorisation', { id: from, domain: profile.ownerDomain, pack: id, scope: 'quote', cnf: { jkt: await keyThumbprint(profile.publicJwk) } }, 365);
    return { kind: 'approved', credential, notes: [`authorised to quote for ${id}`] };
  });
  // Good turns (SPEC §6.7): tasks it certifies, a deed for each one done (once per person and task), and redeeming deeds
  // for a cart priced in them, each once, anywhere.
  const deedReply = async (p: Record<string, unknown>, from: string, profile: LakeProfile): Promise<Record<string, unknown>> => {
    const no = (why: string) => ({ kind: 'refused', problems: [why] });
    const tasks = a.deeds!.tasks;
    if (p.kind === 'deed.tasks') return { kind: 'deed.tasks', tasks: tasks.map((t) => ({ id: t.id, title: t.title, ask: t.ask, ...(t.answer_shape ? { answer_shape: t.answer_shape } : {}) })), earns: 'one deed for each task done: an Open Badges 3.0 credential for an hour of community service, bound to your key', pays_for: 'menu items priced in HUR that name this organisation' };
    if (p.kind === 'deed.status') { const d = String(p.digest ?? ''); return { kind: 'deed.status', digest: d, spent: !!deeds.spent[d] }; }
    const jkt = await keyThumbprint(profile.publicJwk);
    if (p.kind === 'deed.submit') {
      const t = tasks.find((x) => x.id === p.task);
      if (!t) return no(`task: one of ${tasks.map((x) => x.id).join(', ')}`);
      if (deeds.earned[`${jkt}|${t.id}`]) return no('you have done this task already: each earns one deed per person');
      if (Date.now() - (deeds.lastBy[jkt] ?? 0) < DEED_EVERY_MS) return no(`one deed every ${Math.round(DEED_EVERY_MS / 60_000)} minutes from one key: try again later`);
      if (!deedAnswerPasses(t, p.answer)) return no('not quite: check the answer against the task and its answer_shape');
      deeds.earned[`${jkt}|${t.id}`] = Date.now(); deeds.lastBy[jkt] = Date.now();
      await saveDeeds();
      const credential = await issueDeed({ issuer: o.id, issuerWebId: s.webId, issuerName: a.name, subject: from, jkt, task: t, achievementBase: `${o.url}/achievements` });
      return { kind: 'deed.issued', task: t.id, credential, note: `thank you: one hour of community service, certified by ${a.name}. Keep it: anyone who prices their time in HUR naming this organisation takes it, once` };
    }
    if (p.kind === 'deed.redeem') {
      // The cart, as its seller signed it, priced in deeds and naming this organisation as the one whose word it was paid counts.
      let seller: LakeProfile, c: CheckedCart;
      try {
        seller = await verifyLakeCard(p.seller_card as AgentCard);
        c = await checkCart(p.cart as CartMandate, seller.publicJwk);
      } catch (e) { return no(`cart: ${(e as Error).message}`); }
      if (c.seller !== seller.webId) return no('the cart was not signed by that seller');
      if (c.buyer !== from) return no('pay only a cart made out to you');
      if (c.total.currency !== DEED_ASSET || !Number.isInteger(c.total.value)) return no(`the cart is in ${c.total.currency}, not ${DEED_ASSET}`);
      const accept = cartTerms((p.cart as CartMandate).contents).assets?.[DEED_ASSET]?.accept ?? [];
      if (!(await isParty({ webId: s.webId, publicJwk: o.id.publicJwk }, accept))) return no('the cart doesn\'t name this organisation as the one whose deeds it takes');
      // Paid already: the same receipt again (a retry), never a second payment.
      const again = Object.values(deeds.spent).find((x) => x.cart === c.id && x.hash === c.hash);
      if (again) return { kind: 'deed.redeemed', cart: c.id, receipt: again.receipt, again: true };
      const creds = (Array.isArray(p.credentials) ? p.credentials : []).map(String).slice(0, 100);
      if (creds.length !== c.total.value) return no(`send exactly ${c.total.value} deed${c.total.value === 1 ? '' : 's'}: the cart's total`);
      const digests: string[] = [];
      for (const jws of creds) {
        try {
          const d = await checkDeed(jws, o.id.publicJwk);
          if (d.issuer !== s.webId) throw new Error('not certified here');
          // Only its holder pays with it: the one it names, with the key it was bound to.
          if (d.subject !== from || d.jkt !== jkt) throw new Error('certified to someone else');
          if (deeds.spent[d.digest]) throw new Error('spent already');
          if (digests.includes(d.digest)) throw new Error('the same deed twice');
          digests.push(d.digest);
        } catch (e) { return no(`a deed: ${(e as Error).message}`); }
      }
      const receipt = await issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeReceipt', 'LakeDeedReceipt'], issuer: s.webId, validFrom: new Date().toISOString(),
        credentialSubject: { id: c.seller, payer: from, amount: { value: c.total.value, currency: DEED_ASSET }, cart: { id: c.id, hash: c.hash }, agreement: `urn:ap2:cart:${c.id}`, settlement: 'deed', spent: digests } } as never, o.id);
      for (const d of digests) deeds.spent[d] = { cart: c.id, hash: c.hash, seller: c.seller, receipt, at: Date.now() };
      await saveDeeds();
      return { kind: 'deed.redeemed', cart: c.id, receipt, spent: digests, note: `paid: ${c.total.value} hour${c.total.value === 1 ? '' : 's'} of community service, now spent. Send the seller this receipt ({ kind: "receipt", receipt: { credential, card }, cart })` };
    }
    return no('send deed.tasks, deed.submit { task, answer }, deed.redeem { credentials, cart, seller_card } or deed.status { digest }');
  };
  return { app: s.app, card: s.card, webId: s.webId };
}

export const newId = () => randomUUID();

/** How long a buyer has to answer a delivery before a held payment releases by itself (SPEC §6.5): hours, and the default. */
export const HOLD_HOURS = { min: 1, max: 168, default: 24 } as const;
/** How long a seller has to deliver before a held payment goes back to the buyer. */
export const DELIVER_HOURS = 24;
/** Deliveries one held payment takes: the first and five revisions. */
const MAX_DELIVERIES = 6;

/**
 * A payment held until delivery, as the payments agent keeps it. The hold follows the delivery itself (run 36: it knew
 * only that money was paid, so a buyer could accept before anything came, and an empty delivery took a disputed one):
 * the seller files each delivery's sha256 here, and the buyer accepts or disputes exactly that one. `until` is the one
 * deadline: before a delivery the seller's (nothing delivered: back to the buyer), after it the buyer's (no answer:
 * released). A dispute stops it.
 */
interface Hold {
  id: string; payer: string; payerUrl?: string; payee: string; payeeUrl?: string; amount: number; currency: string; digest: string;
  /** The cart it pays; or, for money held for a pledge, the pledge (and the house whose owner signed for it). */
  cart?: { id: string; hash: string }; pledge?: { tally: string; id: string; bond?: boolean; by: string }; until: number;
  /** What it was for and between whom, carried onto the receipt that settles it. */
  about?: Record<string, unknown>; status: 'held' | 'captured' | 'voided'; settledAt?: number;
  /** The arbiters the seller named in the cart (pinned by key): the buyer paid those terms, so their rulings count here. */
  arbiters?: CartParty[];
  /** The buyer's time to answer each delivery. Holds made before deliveries were filed here have none, nor the fields below. */
  reviewMs?: number;
  /** Deliveries it takes: the first and the revisions the cart promises (all six if it promises none). */
  maxDeliveries?: number;
  /** The latest delivery the seller filed: its sha256 and number (1, then each revision). */
  delivered?: { sha256: string; revision: number; at: number };
  /** The seller who signed the cart, when another is paid (an assistant selling for its owner's house), and its address. */
  seller?: string; sellerUrl?: string;
  /** A team's cart: each member's share (cents), paid to it when the hold is released. */
  split?: { webId: string; url: string; amount: number }[];
  /** Each dispute, about one delivery, and how it ended. */
  disputes?: { code: DisputeCode; sha256: string; at: number; ended?: string }[];
  /** Before deliveries were filed: the buyer disputed it. */
  disputed?: boolean;
}

const openDispute = (h: Hold) => h.disputes?.find((d) => !d.ended);
/** What a held payment's receipts name as its agreement and order: its cart, or its pledge. */
const agreementOf = (h: Hold) => (h.pledge ? pledgeAgreement(h.pledge.tally, h.pledge.id, h.pledge.bond) : `urn:ap2:cart:${h.cart!.id}`);
const orderOf = (h: Hold) => (h.pledge ? `pledge:${h.pledge.id}` : h.cart!.id);
/** Longest money is held for a pledge: its tally's longest deadline and a little over, so it can't sit there forever. */
const PLEDGE_HOLD_DAYS = 32;

/**
 * The demo Payments agent: checks the AP2 mandate chain (a human's Intent Mandate, the agent's Payment
 * Mandates under it, the budget) and records settlements. Settlement is simulated; receipts are real VCs.
 */
export async function createPayments(o: SpecialistOptions & {
  /** Each settlement, for the node's counters: whether it paid a cart, and whether its money is held or a hold being released. */
  onSettled?: (amount: number, count: number, how?: { cart?: boolean; held?: boolean; released?: boolean; currency?: string }) => void; log?: (entry: string, kind: string) => Promise<{ index: number; origin: string }>;
  /** Where held payments, paid carts and budgets spent are kept across restarts. Without it, in memory only. */
  dataDir?: string;
  /** The domains of arbiters whose rulings move a held payment. Default: arbiter.lake.local. */
  arbiters?: string[];
}): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  // Kept in a file, so a restart neither forgets a hold (the seller's money) nor lets a cart be paid twice or a budget
  // be spent again. Written whole to a temporary file and renamed over the old one: a crash leaves one or the other.
  const file = o.dataDir ? `${o.dataDir}/payments.json` : undefined;
  if (o.dataDir) await mkdir(o.dataDir, { recursive: true }).catch(() => {});
  const saved = (file ? JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) : {}) as { holds?: Hold[]; paidCarts?: string[]; spent?: [string, number][]; refunded?: string[] };
  const spent = new Map<string, number>(saved.spent ?? []);
  // Carts already paid, by the hash of their contents: a seller's cart is paid once.
  const paidCarts = new Set<string>(saved.paidCarts ?? []);
  // Carts paid back with a plain refund ("refund:<cart>"), by id: a cart is refunded once (run 36 refunded one twice).
  const refunded = new Set<string>(saved.refunded ?? []);
  /**
   * Payments held until delivery (authorize, then capture, as card payments do): a cart paid with hold is counted
   * against the buyer's budget at once, but reaches the seller only when the buyer accepts, when its time runs out with
   * no dispute, or when an arbiter's ruling says it was delivered; the seller can void it (a refund), and a ruling that
   * it wasn't delivered voids it. Settled ones are kept a while, so a late capture or void is told what happened.
   */
  const holds = new Map<string, Hold>((saved.holds ?? []).filter((h) => h.status === 'held' || (h.settledAt ?? 0) > Date.now() - 30 * DAY).map((h) => [h.id, h]));
  let saving = Promise.resolve();
  const save = () => {
    if (!file) return saving;
    saving = saving.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ holds: [...holds.values()], paidCarts: [...paidCarts], spent: [...spent], refunded: [...refunded] }));
      await rename(tmp, file);
    }).catch(() => {});
    return saving;
  };
  const arbiters = o.arbiters ?? ['arbiter.lake.local'];
  const s: Specialist = await specialist<Reply>(o, 'Payments (demo)', `Verifies AP2 mandate chains and settles. Settlement is simulated; receipts are signed. Pays an AP2 cart a seller signed (SPEC §6.5) for exactly its total, once. With hold: true it holds the money: the seller files each delivery { kind: "delivered", hold, sha256 } (within ${DELIVER_HOURS} hours, or it goes back to the buyer); the buyer accepts or disputes exactly that delivery by its sha256, or after release_after_hours (${HOLD_HOURS.min} to ${HOLD_HOURS.max}, default ${HOLD_HOURS.default}) with no answer it is released. Money for a pledge (hold: true, pledge: { tally, id, until, bond?, payee_url? }, agreement urn:lake:pledge:<tally>|<id>) is held for that tally, and only its word moves it: on to the payee if the pledge fills, back if it lapses, the bond shared among its signers; if the tally never says, it goes back at until.`, 'payments', async (p, agentWebId, agent, agentCard) => {
    if (p.kind === 'capture' || p.kind === 'void' || p.kind === 'dispute' || p.kind === 'rule' || p.kind === 'delivered') return settleHold(p, agentWebId);
    if (p.kind === 'pledge.hold' || p.kind === 'pledge.release' || p.kind === 'pledge.settle') return settlePledge(p, agentWebId) as never;
    if (p.kind !== 'settle') return { kind: 'refused', problems: ['send { kind: "settle", intent: { credential, card }, payments: [...], cart?, hold?, release_after_hours? }, or for a held payment: delivered { hold, sha256 } (the seller), capture { hold, sha256 } or dispute { hold, sha256, code } (the buyer), void { hold } (the seller refunds), rule { hold, ruling: { credential, card } }'] };
    // The buyer says when a held payment releases by itself, within bounds: long enough to check a delivery, short enough
    // that a seller isn't kept waiting for a week and a day.
    let holdMs = HOLD_HOURS.default * 3_600_000;
    if (p.release_after_hours !== undefined) {
      const hours = Number(p.release_after_hours);
      if (p.hold !== true || !p.cart) return { kind: 'refused', problems: ['release_after_hours is for a cart paid with hold: true'] };
      if (!Number.isFinite(hours) || hours < HOLD_HOURS.min || hours > HOLD_HOURS.max) return { kind: 'refused', problems: [`release_after_hours: ${HOLD_HOURS.min} to ${HOLD_HOURS.max} hours (default ${HOLD_HOURS.default})`] };
      holdMs = Math.round(hours * 3_600_000);
    }
    const intent = p.intent as { credential: string; card: AgentCard; owner?: string } | undefined;
    const payments = (p.payments as string[] | undefined) ?? [];
    if (!intent?.credential || !intent.card) return { kind: 'refused', problems: ['no Intent Mandate'] };
    let human;
    try {
      human = await verifyLakeCard(intent.card);
    } catch (e) {
      return { kind: 'refused', problems: [`the human's card: ${(e as Error).message}`] };
    }
    // An owner's allowance: signed with the owner's own key, which their house vouches for (the card is the house's). The
    // owner names the assistant in it, so it needn't share the assistant's organisation. Otherwise: a person of the
    // agent's own organisation signed it with the key on their card.
    let signerJwk = human.publicJwk;
    if (intent.owner) {
      try {
        signerJwk = await verifyOwnerKey(intent.owner, human.publicJwk, human.webId);
      } catch (e) {
        return { kind: 'refused', problems: [`the house's word for its owner's key: ${(e as Error).message}`] };
      }
    } else if (human.ownerDomain !== agent.ownerDomain) return { kind: 'refused', problems: ['the Intent Mandate was signed by someone outside the agent\'s organisation'] };
    let mandate;
    try {
      mandate = await verifyCredential(intent.credential, signerJwk);
    } catch {
      return { kind: 'refused', problems: ['the Intent Mandate signature does not verify'] };
    }
    if (intent.owner && mandate.issuer !== human.webId) return { kind: 'refused', problems: ['the allowance was not issued as this house\'s owner'] };
    // Taken back? The owner revokes an allowance on the house's public status list.
    const status = await checkCredentialStatus(mandate as never).catch((e: Error) => ({ checked: true as const, revoked: true, why: e.message }));
    if (status.checked && status.revoked) return { kind: 'refused', problems: ['the owner has taken this allowance back'] };
    const m = mandate.credentialSubject as unknown as { id: string; budget: { amount: number; currency?: string }; intent_expiry: string; study?: string };
    if (!mandate.type.includes('IntentMandate') || m.id !== agentWebId) return { kind: 'refused', problems: ['the Intent Mandate is not for this agent'] };
    if (Date.parse(m.intent_expiry) < Date.now()) return { kind: 'refused', problems: ['the Intent Mandate has expired'] };
    const digest = digestSRI(intent.credential);
    const currency = m.budget.currency ?? 'USD';
    // Paying a seller's cart: its signature, its total and its buyer are checked here, before any money moves.
    const c = p.cart as { mandate?: CartMandate; card?: AgentCard } | undefined;
    let cart: (CheckedCart & { webId: string }) | undefined;
    if (c) {
      try {
        const seller = await verifyLakeCard(c.card as AgentCard);
        cart = { ...(await checkCart(c.mandate as CartMandate, seller.publicJwk)), webId: seller.webId };
        if (cart.seller !== seller.webId) throw new Error('the cart was signed for another seller');
        if (cart.buyer !== agentWebId) throw new Error('the cart was made out to another buyer');
        // The seller says whose receipts it counts as paid. Money held here for a cart whose seller doesn't count this
        // agent's receipts would sit on a cart the seller sees as unpaid (two Lakes' check found exactly that): refused first.
        if (cart.payments.length && !(await isParty({ webId: s.webId, publicJwk: o.id.publicJwk }, cart.payments))) {
          throw new Error(`the seller takes payment for cart ${cart.id} only through ${cart.payments.map((x) => x.url).join(', ')}, not through this payments agent (${s.webId}): nothing was paid`);
        }
      } catch (e) {
        return { kind: 'refused', problems: [(e as Error).message] };
      }
      if (paidCarts.has(cart.hash)) return { kind: 'refused', problems: [`cart ${cart.id} is paid already`] };
      // Paid to another than its seller only on that payee's word (SPEC §6.5): the house's LakeAssistantKey for this seller,
      // carried in the cart, checked as a badge would be (the house's own card, the seller's key, expiry, status list).
      if (cart.payee) {
        const seller = await verifyLakeCard(c!.card as AgentCard);
        const ok = (await checkBadges({ ...seller, badges: [cart.payee.vouch] }, { sandbox: o.sandbox })).some((b) => b.type === ASSISTANT_KEY_TYPE && b.issuerWebId === cart!.payee!.webId && (b.subject.may as string[] | undefined)?.includes('sell'));
        if (!ok) return { kind: 'refused', problems: [`cart ${cart.id} names ${cart.payee.webId} as payee, but carries no word from it that the seller sells for it: nothing was paid`] };
      }
      // A team's cart: held whole, and each member's consent to its share checked against that member's own card first.
      if (cart.split) {
        if (p.hold !== true) return { kind: 'refused', problems: [`cart ${cart.id} pays a team: pay it with hold: true, so each member is paid its share when it is released`] };
        try {
          for (const share of cart.split) {
            const member = await verifyLakeCard((await (await fetch(cardUrlFor(share.url))).json()) as AgentCard);
            if (member.webId !== share.webId) throw new Error(`the agent at ${share.url} is not ${share.webId}`);
            await checkSplitConsent(share, member.publicJwk, { cart: cart.id, splitHash: cart.splitHash!, currency: cart.total.currency });
          }
        } catch (e) {
          return { kind: 'refused', problems: [`cart ${cart.id}'s team: ${(e as Error).message}: nothing was paid`] };
        }
      }
      if (payments.length !== 1) return { kind: 'refused', problems: ['one payment per cart'] };
    }
    // Money held for a pledge (SPEC §11.4a): a contribution, or its opener's refund bond, held for the tally it names, whose
    // word alone moves it: on to the payee once the pledge has filled; back if it lapses, the bond shared among the signers.
    const pl = p.pledge as { tally?: unknown; id?: unknown; bond?: unknown; until?: unknown; payee_url?: unknown } | undefined;
    let pledge: Hold['pledge'];
    let pledgeUntil = 0;
    if (pl) {
      const tally = String(pl.tally ?? ''), id = String(pl.id ?? '');
      pledgeUntil = Date.parse(String(pl.until ?? ''));
      const problems = [
        ...(cart ? ['a cart or a pledge, not both'] : []),
        ...(p.hold === true ? [] : ['money for a pledge is held: hold: true']),
        ...(/^https?:\/\/\S+#\S+$/.test(tally) && id && id.length <= 80 ? [] : ['pledge: { tally: the tally\'s webId, id, until, bond?, payee_url? }']),
        ...(pledgeUntil > Date.now() && pledgeUntil < Date.now() + PLEDGE_HOLD_DAYS * DAY ? [] : [`pledge.until: when it goes back to you if the tally never settles it, within ${PLEDGE_HOLD_DAYS} days`]),
        ...(payments.length === 1 ? [] : ['one payment per pledge']),
      ];
      if (problems.length) return { kind: 'refused', problems };
      pledge = { tally, id, ...(pl.bond === true ? { bond: true } : {}), by: intent.owner ? human.webId : agentWebId };
    }
    // An owner's signature for one pledge pays that pledge, and only once.
    if (m.study?.startsWith('urn:lake:pledge:') && (!pledge || m.study !== pledgeAgreement(pledge.tally, pledge.id, pledge.bond))) return { kind: 'refused', problems: [`this allowance was signed for ${m.study} only`] };
    const checked: { payee: string; amount: number; agreement: string }[] = [];
    for (const pm of payments) {
      try {
        const vc = await verifyCredential(pm, agent.publicJwk);
        const x = vc.credentialSubject as unknown as { id: string; amount: { value: number; currency?: string }; intentMandate: string; agreement: string; payment_details_id?: string; cart_hash?: string };
        if (!vc.type.includes('PaymentMandate') || x.intentMandate !== digest || !(x.amount.value > 0)) throw new Error();
        // The owner signed a budget in one currency: a payment in another isn't under it (nothing here converts).
        if ((x.amount.currency ?? 'USD') !== currency) return { kind: 'refused', problems: [`the allowance is in ${currency}; this payment is in ${x.amount.currency ?? 'USD'}`] };
        // Whole cents, at least one; and an agent can't pay itself (it would only inflate what looks settled).
        if (x.amount.value < 0.01 || Math.abs(x.amount.value * 100 - Math.round(x.amount.value * 100)) > 1e-6) return { kind: 'refused', problems: [`${currency} ${x.amount.value}: pay at least 0.01, in whole cents`] };
        if (x.id === agentWebId) return { kind: 'refused', problems: ['an agent can\'t pay itself'] };
        if (cart && (x.id !== (cart.payee?.webId ?? cart.webId) || x.cart_hash !== cart.hash || Math.round(x.amount.value * 100) !== Math.round(cart.total.value * 100) || (x.amount.currency ?? 'USD') !== cart.total.currency)) {
          return { kind: 'refused', problems: [`the payment must be exactly the cart: ${cart.total.currency} ${cart.total.value} to ${cart.payee ? 'the payee it names' : 'its seller'}, naming its hash`] };
        }
        // A plain refund of a cart, once, and never of one whose held payment already went back.
        const refundOf = String(x.agreement ?? '').startsWith('urn:lake:order:refund:') ? String(x.agreement).slice('urn:lake:order:refund:'.length) : undefined;
        if (refundOf && (refunded.has(refundOf) || [...holds.values()].some((h) => h.cart?.id === refundOf && h.status === 'voided'))) return { kind: 'refused', problems: [`cart ${refundOf} was refunded already`] };
        if (pledge && x.agreement !== pledgeAgreement(pledge.tally, pledge.id, pledge.bond)) return { kind: 'refused', problems: [`the payment's agreement must be the pledge: ${pledgeAgreement(pledge.tally, pledge.id, pledge.bond)}`] };
        checked.push({ payee: x.id, amount: Math.round(x.amount.value * 100), agreement: x.agreement });
      } catch {
        return { kind: 'refused', problems: ['a Payment Mandate is not signed by the agent under this Intent Mandate'] };
      }
    }
    const hold = (!!cart || !!pledge) && p.hold === true;
    // The cart's signed delivery terms, where it has them, set the clocks and the revisions: the buyer paid those terms.
    // Checked before anything is counted (run 41: a refusal here had already marked the cart paid, so it never could be).
    const d = cart?.delivery;
    if (hold && d?.review_hours !== undefined) {
      if (p.release_after_hours !== undefined && Number(p.release_after_hours) !== d.review_hours) return { kind: 'refused', problems: [`the cart's terms give you ${d.review_hours} hours to answer each delivery: leave release_after_hours out, or ask the seller for another cart`] };
      holdMs = d.review_hours * 3_600_000;
    }
    // Counted in cents, so a budget never drifts by a rounding error.
    const total = checked.reduce((a, c) => a + c.amount, 0);
    const already = spent.get(digest) ?? 0;
    const cap = Math.round(m.budget.amount * 100);
    if (already + total > cap) {
      return { kind: 'refused', problems: [`${currency} ${(already + total) / 100} is over the ${currency} ${m.budget.amount} the human signed for: a human must approve`] };
    }
    spent.set(digest, already + total);
    if (cart) paidCarts.add(cart.hash);
    for (const c of checked) if (c.agreement?.startsWith('urn:lake:order:refund:')) refunded.add(c.agreement.slice('urn:lake:order:refund:'.length));
    // Held: the seller's clock first. The buyer's (holdMs) starts at each delivery.
    const until = pledge ? pledgeUntil : Date.now() + (hold ? (d?.within_hours ?? DELIVER_HOURS) * 3_600_000 : holdMs);
    // What it was for and between whom, as the signed cart and cards say (an owner read "$4 from claude-code-2299….mcp.example"
    // and couldn't tell who paid or what for): the cart's items, and both agents' names.
    const about = {
      ...(agentCard?.name ? { payer_name: String(agentCard.name).slice(0, 80) } : {}),
      ...(cart ? { items: ((c!.mandate as CartMandate).contents.payment_request.details.display_items ?? []).slice(0, 10).map((x) => ({ label: String(x.label).slice(0, 120), amount: x.amount })), ...((c!.card as AgentCard | undefined)?.name ? { seller_name: String((c!.card as AgentCard).name).slice(0, 80) } : {}) } : {}),
    };
    const held: string[] = [];
    const receipts = await Promise.all(
      checked.map(async (c) => {
        // A settlement id of its own: two payments with the same payer, payee, amount and memo are still two receipts.
        const settlementId = randomUUID();
        // Where both sides are reached when it settles: the seller's card came with the cart, the buyer's with this message.
        const sellerUrl = (p.cart as { card?: AgentCard })?.card?.supportedInterfaces?.[0]?.url;
        held.push(settlementId);
        if (pledge) holds.set(settlementId, { id: settlementId, payer: agentWebId, payerUrl: agentCard?.supportedInterfaces?.[0]?.url, payee: c.payee, ...(typeof pl!.payee_url === 'string' ? { payeeUrl: pl!.payee_url } : {}), amount: c.amount, currency, digest, pledge, about, until, status: 'held' });
        else if (hold) holds.set(settlementId, { id: settlementId, payer: agentWebId, payerUrl: agentCard?.supportedInterfaces?.[0]?.url, payee: c.payee, payeeUrl: cart!.payee?.url ?? sellerUrl, ...(cart!.payee ? { seller: cart!.webId, sellerUrl } : {}), amount: c.amount, currency, digest, cart: { id: cart!.id, hash: cart!.hash }, about, until, status: 'held', reviewMs: holdMs, ...(d?.revisions !== undefined ? { maxDeliveries: d.revisions + 1 } : {}), ...(cart!.arbiters.length ? { arbiters: cart!.arbiters } : {}), ...(cart!.split ? { split: cart!.split.map((x) => ({ webId: x.webId, url: x.url, amount: Math.round(x.amount * 100) })) } : {}) });
        return {
          payee: c.payee,
          credential: await s.vc('LakeReceipt', { id: c.payee, payer: agentWebId, amount: { currency, value: c.amount / 100 }, agreement: c.agreement, ...(cart ? { cart: { id: cart.id, hash: cart.hash }, seller: cart.webId } : {}), ...(pledge ? { pledge: { tally: pledge.tally, id: pledge.id, ...(pledge.bond ? { bond: true } : {}) } } : {}), ...about, intentMandate: digest, settlement: hold ? 'held' : 'simulated', settlementId, ...(hold ? { heldUntil: new Date(until).toISOString() } : {}) }, 3650),
        };
      }),
    );
    await save();
    o.onSettled?.(total / 100, checked.length, { cart: !!cart, held: hold, currency });
    // On the record: every receipt goes into the transparency log, so it can't be quietly rewritten or denied later.
    const logged = await Promise.all(receipts.map(async (r) => ({ ...r, ...(o.log ? { logged: await o.log(r.credential, 'receipt').then(({ index, origin }) => ({ index, origin })).catch(() => undefined) } : {}) })));
    return { kind: 'settled', receipts: logged, currency, total: total / 100, remaining: (cap - already - total) / 100, ...(hold ? { held: true, until: new Date(until).toISOString() } : {}), ...(pledge ? { hold: held[0] } : {}) };
  });

  // The money of a held payment moves: to the seller (capture), or back under the buyer's budget (void). Both sides get
  // the signed receipt from this agent itself (run 31: only the seller heard of a release), and it goes on the log, saying
  // how it ended, which delivery, and each dispute and how that ended: what a record is counted from (run 36: a "delivered"
  // ruling on junk looked like a win).
  const finish = async (h: Hold, to: 'captured' | 'voided', how: SettledHow, why: string) => {
    if (h.status !== 'held') return { kind: 'refused', problems: [`it was ${h.status} already`] };
    h.status = to;
    h.settledAt = Date.now();
    // A ruling's end says which way it went: a lost "nothing arrived" claim isn't a mark against the seller (run 37).
    const open = openDispute(h);
    if (open) open.ended = how === 'seller_void' ? 'refund' : how === 'ruling' ? (to === 'captured' ? 'ruling_for_seller' : 'ruling_for_buyer') : how;
    if (to === 'voided') spent.set(h.digest, Math.max(0, (spent.get(h.digest) ?? 0) - h.amount));
    await save();
    const story = { how, ...(h.delivered ? { delivered: h.delivered.sha256, deliveries: h.delivered.revision } : {}), ...(h.disputes?.length ? { disputes: h.disputes.map((d) => ({ code: d.code, ended: d.ended })) } : {}) };
    const what = h.pledge ? { pledge: { tally: h.pledge.tally, id: h.pledge.id, ...(h.pledge.bond ? { bond: true } : {}) } } : { cart: h.cart, seller: h.seller ?? h.payee };
    const credential = await s.vc('LakeReceipt', { id: to === 'captured' ? h.payee : h.payer, payer: h.payer, amount: { currency: h.currency, value: h.amount / 100 }, agreement: agreementOf(h), ...what, ...(h.about ?? {}), ...(to === 'captured' && h.split ? { paid_as_shares: h.split.map((x) => ({ member: x.webId, amount: x.amount / 100 })) } : {}), intentMandate: h.digest, settlement: to === 'captured' ? 'simulated' : 'voided', settlementId: randomUUID(), [to === 'captured' ? 'captures' : 'voids']: h.id, why, ...story }, 3650);
    const logged = o.log ? await o.log(credential, to === 'captured' ? 'capture' : 'void').then(({ index, origin }) => ({ index, origin })).catch(() => undefined) : undefined;
    const envelope = { kind: 'receipt', receipt: { credential, card: s.card }, amount: h.amount / 100, currency: h.currency, ...(h.cart ? { cart: h.cart.id } : { pledge: h.pledge!.id }), order: orderOf(h), hold: h.id, memo: `${to === 'captured' ? 'released' : 'voided'}: ${why}` };
    for (const url of new Set([h.payeeUrl, h.sellerUrl, h.payerUrl].filter((u): u is string => !!u))) {
      deliverWithRetries(async () => sendLake(url, { lake: '0.1', card: s.card, envelope: (await signMessage(envelope, o.id, { iss: s.webId })) as LakeData['envelope'] }, { me: o.id, timeoutMs: 10_000 }));
    }
    // A team's cart: released, each member is paid its share, with a receipt of its own naming the cart and the release.
    const shares = to === 'captured' && h.split ? await Promise.all(h.split.map(async (x) => {
      const share = await s.vc('LakeReceipt', { id: x.webId, payer: h.payer, amount: { currency: h.currency, value: x.amount / 100 }, agreement: agreementOf(h), ...what, ...(h.about ?? {}), intentMandate: h.digest, settlement: 'simulated', settlementId: randomUUID(), captures: h.id, share: true, why }, 3650);
      const note = { kind: 'receipt', receipt: { credential: share, card: s.card }, amount: x.amount / 100, currency: h.currency, ...(h.cart ? { cart: h.cart.id } : { pledge: h.pledge!.id }), order: orderOf(h), hold: h.id, memo: h.pledge ? `your share of the refund bond of the pledge "${h.pledge.id}": ${why}` : `your share of cart ${h.cart!.id}, released: ${why}` };
      deliverWithRetries(async () => sendLake(x.url, { lake: '0.1', card: s.card, envelope: (await signMessage(note, o.id, { iss: s.webId })) as LakeData['envelope'] }, { me: o.id, timeoutMs: 10_000 }));
      return { member: x.webId, amount: x.amount / 100, credential: share };
    })) : undefined;
    if (to === 'captured') o.onSettled?.(h.amount / 100, 1, { cart: !!h.cart, released: true, currency: h.currency });
    return { kind: to, hold: h.id, ...(h.cart ? { cart: h.cart.id } : { pledge: h.pledge!.id }), credential, ...(shares ? { shares } : {}), ...(logged ? { logged } : {}), why };
  };
  // Its deadline passed with nothing open: nothing delivered goes back to the buyer; a delivery nobody answered is released.
  // Checked at start too, for holds whose time passed while this agent was down.
  const sweep = () => {
    for (const h of holds.values()) {
      if (h.status !== 'held' || h.until > Date.now() || h.disputed || openDispute(h)) continue;
      // Money for a pledge its tally never settled goes back: nobody's word released it.
      if (h.pledge) { void finish(h, 'voided', 'pledge_expired', 'the pledge was never settled by its tally'); continue; }
      if (h.reviewMs !== undefined && !h.delivered) void finish(h, 'voided', 'undelivered_expired', 'nothing was delivered in time');
      else void finish(h, 'captured', 'review_expired', 'its time ran out with no dispute');
    }
  };
  setTimeout(sweep, 1_000).unref();
  setInterval(sweep, 60_000).unref();
  const settleHold = async (p: Record<string, unknown>, from: string): Promise<Reply> => {
    const h = holds.get(String(p.hold ?? ''));
    if (!h) return { kind: 'refused', problems: ['no held payment with that id (the receipt\'s settlementId)'] };
    if (h.status !== 'held') return { kind: 'refused', problems: [`it was ${h.status} already`] };
    if (h.pledge) return { kind: 'refused', problems: [`it is held for the pledge "${h.pledge.id}": only its tally's word moves it`] };
    const filed = h.reviewMs !== undefined;
    const sha = String(p.sha256 ?? '').toLowerCase();
    // The buyer answers one delivery, by its sha256: the latest the seller filed (an older one was replaced by a revision).
    const latest = () => !h.delivered ? 'nothing has been delivered yet: the seller delivers first'
      : sha !== h.delivered.sha256 ? `name the delivery you mean by its sha256: the latest is ${h.delivered.sha256} (revision ${h.delivered.revision})` : null;
    if (p.kind === 'delivered') {
      if (from !== (h.seller ?? h.payee)) return { kind: 'refused', problems: ['only the seller files a delivery'] };
      if (!/^[0-9a-f]{64}$/.test(sha)) return { kind: 'refused', problems: ['sha256: the hex sha256 of what you delivered'] };
      if (sha === EMPTY_SHA256) return { kind: 'refused', problems: ['that is the sha256 of nothing: an empty delivery is not a delivery'] };
      if (h.delivered?.sha256 === sha) return { kind: 'refused', problems: ['that delivery is filed already'] };
      const most = h.maxDeliveries ?? MAX_DELIVERIES;
      if ((h.delivered?.revision ?? 0) >= most) return { kind: 'refused', problems: [`${most} ${most === 1 ? 'delivery' : 'deliveries'} filed, all the cart promises: refund it, or the buyer accepts one`] };
      // A new delivery answers an open dispute (a revision), and the buyer's clock starts again for it.
      const open = openDispute(h);
      if (open) open.ended = 'revision';
      h.delivered = { sha256: sha, revision: (h.delivered?.revision ?? 0) + 1, at: Date.now() };
      if (filed) h.until = Date.now() + h.reviewMs!;
      await save();
      return { kind: 'delivered', hold: h.id, revision: h.delivered.revision, until: new Date(h.until).toISOString(), note: `filed: the buyer accepts or disputes it by its sha256; with no answer by then it is released to you` } as never;
    }
    if (p.kind === 'capture') {
      if (from !== h.payer) return { kind: 'refused', problems: ['only the buyer releases it'] };
      const wrong = filed && latest();
      if (wrong) return { kind: 'refused', problems: [wrong] };
      return (await finish(h, 'captured', 'accepted', 'the buyer accepted')) as never;
    }
    if (p.kind === 'void') {
      if (from !== (h.seller ?? h.payee)) return { kind: 'refused', problems: ['only the seller voids it (a refund)'] };
      if (p.amount === undefined) return (await finish(h, 'voided', 'seller_void', 'the seller refunded it')) as never;
      // Part of it back (run 37: a "not what I ordered" dispute froze the money, and a whole refund was the seller's only
      // way out): the rest stays held, for the buyer to accept, as marketplaces settle such disputes with a partial refund.
      const part = Math.round(Number(p.amount) * 100);
      if (!Number.isInteger(part) || part < 1 || part >= h.amount) return { kind: 'refused', problems: [`amount: part of the ${h.currency} ${h.amount / 100} held, at least 0.01; leave it out to refund it all`] };
      h.amount -= part;
      spent.set(h.digest, Math.max(0, (spent.get(h.digest) ?? 0) - part));
      await save();
      const credential = await s.vc('LakeReceipt', { id: h.payer, payer: h.payer, amount: { currency: h.currency, value: part / 100 }, agreement: agreementOf(h), cart: h.cart, seller: h.seller ?? h.payee, intentMandate: h.digest, settlement: 'voided', settlementId: randomUUID(), voids: h.id, partial: true, still_held: h.amount / 100, why: 'the seller refunded part of it' }, 3650);
      const logged = o.log ? await o.log(credential, 'void').then(({ index, origin }) => ({ index, origin })).catch(() => undefined) : undefined;
      const envelope = { kind: 'receipt', receipt: { credential, card: s.card }, amount: part / 100, currency: h.currency, cart: h.cart!.id, order: h.cart!.id, hold: h.id, memo: `part refunded: ${h.currency} ${part / 100}; ${h.currency} ${h.amount / 100} still held` };
      for (const url of new Set([h.payeeUrl, h.sellerUrl, h.payerUrl].filter((u): u is string => !!u))) {
        deliverWithRetries(async () => sendLake(url, { lake: '0.1', card: s.card, envelope: (await signMessage(envelope, o.id, { iss: s.webId })) as LakeData['envelope'] }, { me: o.id, timeoutMs: 10_000 }));
      }
      return { kind: 'voided', partial: true, hold: h.id, cart: h.cart!.id, refunded: part / 100, still_held: h.amount / 100, credential, ...(logged ? { logged } : {}) } as never;
    }
    if (p.kind === 'dispute') {
      if (from !== h.payer) return { kind: 'refused', problems: ['only the buyer disputes it'] };
      if (!filed) {
        h.disputed = true;
        await save();
        return { kind: 'disputed', hold: h.id, note: 'held until you accept (a revised delivery, say), the seller refunds, or an arbiter rules' } as never;
      }
      const code = (p.code ?? 'not_as_described') as DisputeCode;
      if (!DISPUTE_CODES.includes(code)) return { kind: 'refused', problems: [`code: one of ${DISPUTE_CODES.join(', ')}`] };
      // "It never arrived" can't name what never came: it is about the latest delivery the seller filed here.
      if (code === 'not_received' && !sha && !h.delivered) return { kind: 'refused', problems: [`the seller has filed no delivery: if nothing comes by ${new Date(h.until).toISOString()}, it goes back to the buyer by itself`] };
      const wrong = code === 'not_received' && !sha ? null : latest();
      if (wrong) return { kind: 'refused', problems: [wrong] };
      if (openDispute(h)) return { kind: 'refused', problems: ['that delivery is disputed already: it stays held until a revision, your accept, or a refund'] };
      (h.disputes ??= []).push({ code, sha256: sha || h.delivered!.sha256, at: Date.now() });
      await save();
      return { kind: 'disputed', hold: h.id, code, note: code === 'changes_requested' ? 'held while the seller revises it: a revision restarts your time to answer'
        : code === 'not_received' ? 'held: the seller can show it reached you (the Arbiter rules on that), revise, or refund'
        : 'held until the seller revises it and you accept, or the seller refunds: whether it is what you ordered is not something signatures settle, so no ruling moves it' } as never;
    }
    // A ruling, from an arbiter this payments agent trusts or one the seller named in the cart the buyer paid (that very
    // key), about this very cart, that found it paid. It settles only what signatures can: whether the delivery in dispute
    // reached the buyer (delivered and acknowledged releases it; nothing delivered voids it). A dispute about what was
    // delivered stays held: no signature says a poem is the poem ordered.
    const open = openDispute(h);
    if (filed && !open) return { kind: 'refused', problems: ['nothing is disputed: it is released when the buyer accepts, or when the buyer\'s time to answer runs out'] };
    // About what was delivered, only a count the cart's signed terms name is a fact (run 36): a ruling that the disputed
    // delivery misses one refunds it; nothing else does, and meeting the counts proves nothing about quality.
    const counted = open?.code === 'not_as_described';
    if (open && open.code !== 'not_received' && !counted) return { kind: 'refused', problems: [`the dispute is "${open.code}": no ruling moves it: it stays held until the buyer accepts a revision or the seller refunds`] };
    const r = p.ruling as { credential?: string; card?: AgentCard } | undefined;
    try {
      const signer = await verifyLakeCard(r?.card as AgentCard);
      if (!arbiters.includes(signer.ownerDomain) && !(await isParty(signer, h.arbiters))) throw new Error(`${signer.ownerDomain} (${signer.webId}) is neither an arbiter this payments agent trusts nor one the cart names`);
      const vc = await verifyCredential(String(r?.credential ?? ''), signer.publicJwk);
      const sub = vc.credentialSubject as unknown as { cart?: { hash: string }; paid?: boolean; delivered?: { sha256?: string; acknowledged?: boolean; meets_terms?: boolean } | null };
      if (!vc.type.includes('LakeRuling') || sub.cart?.hash !== h.cart!.hash) throw new Error('not a ruling on this cart');
      if (sub.paid !== true) throw new Error('a ruling that found the cart unpaid: ask the arbiter again, with the receipt');
      if (counted) {
        if (sub.delivered?.sha256 === open!.sha256 && sub.delivered.meets_terms === false) return (await finish(h, 'voided', 'ruling', 'an arbiter ruled the delivery misses the cart\'s signed terms')) as never;
        return { kind: 'refused', problems: [sub.delivered?.meets_terms === true ? 'the delivery meets the counts the cart names, and whether it is what was ordered beyond them is not something signatures settle: it stays held until the buyer accepts a revision or the seller refunds' : 'the dispute is "not_as_described": no signature settles that unless the cart names counts the delivery misses; it stays held until the buyer accepts a revision or the seller refunds'] };
      }
      if (sub.delivered?.acknowledged && (!filed || sub.delivered.sha256 === open!.sha256)) return (await finish(h, 'captured', 'ruling', 'an arbiter ruled it reached the buyer')) as never;
      if (!sub.delivered) return (await finish(h, 'voided', 'ruling', 'an arbiter ruled it not delivered')) as never;
      return { kind: 'refused', problems: [filed && sub.delivered?.acknowledged ? 'the ruling is about another delivery than the one disputed: it stays held' : 'the ruling settles neither way: it stays held'] };
    } catch (e) {
      return { kind: 'refused', problems: [(e as Error).message] };
    }
  };
  /**
   * A pledge's money, on its tally's word only (SPEC §11.4a), and only money that names that tally: whether a hold is good
   * (pledge.hold: its amount, payee and the house whose owner signed for it; nothing about anyone else's), a signer taking
   * theirs back before it fills (pledge.release), and how it ended (pledge.settle). Filled: each counted contribution goes
   * on to its payee, and the bond back to its opener. Lapsed: every contribution goes back, and the opener's bond is shared
   * equally among the counted signers: saying yes to a pledge that didn't happen pays (a dominant assurance contract).
   */
  const settlePledge = async (p: Record<string, unknown>, from: string): Promise<Record<string, unknown>> => {
    const id = String(p.id ?? '');
    const mine = (h: Hold | undefined): h is Hold => !!h && h.pledge?.tally === from && h.pledge.id === id;
    const one = holds.get(String(p.hold ?? ''));
    if (p.kind === 'pledge.hold') {
      if (!mine(one)) return { kind: 'refused', problems: [`no money is held for your pledge "${id}" with that id`] };
      return { kind: 'pledge.hold', hold: one.id, status: one.status, amount: one.amount / 100, currency: one.currency, payee: one.payee, by: one.pledge!.by, ...(one.pledge!.bond ? { bond: true } : {}), until: new Date(one.until).toISOString() };
    }
    if (p.kind === 'pledge.release') {
      if (!mine(one) || one.pledge!.bond) return { kind: 'refused', problems: [`no contribution is held for your pledge "${id}" with that id`] };
      return finish(one, 'voided', 'pledge_withdrawn', 'its signer took their signature back before the pledge filled');
    }
    if (p.outcome !== 'filled' && p.outcome !== 'lapsed') return { kind: 'refused', problems: ['pledge.settle { id, outcome: "filled" | "lapsed", holds: [the counted signers\' holds], bond?: the bond\'s hold }'] };
    const counted = new Set((Array.isArray(p.holds) ? p.holds : []).map(String));
    const open = [...holds.values()].filter((h) => mine(h) && h.status === 'held');
    const gifts = open.filter((h) => !h.pledge!.bond), bonds = open.filter((h) => h.pledge!.bond);
    const signers = gifts.filter((h) => counted.has(h.id));
    // Many holds: settled a few at a time, each with its own receipt on the log.
    const each = async <T,>(xs: T[], f: (x: T) => Promise<unknown>) => { for (let i = 0; i < xs.length; i += 20) await Promise.all(xs.slice(i, i + 20).map(f)); };
    let shared: { amount: number; among: number; each: number } | undefined;
    if (p.outcome === 'filled') {
      await each(gifts, (h) => (counted.has(h.id) ? finish(h, 'captured', 'pledge_filled', 'the pledge filled') : finish(h, 'voided', 'pledge_withdrawn', 'it was never counted as a signature')));
      await each(bonds, (h) => finish(h, 'voided', 'pledge_filled', 'the pledge filled: its bond goes back to its opener'));
    } else {
      await each(gifts, (h) => finish(h, 'voided', 'pledge_lapsed', 'the pledge lapsed: not enough signed in time'));
      const bond = bonds.find((h) => h.id === String(p.bond ?? ''));
      for (const h of bonds) {
        if (h !== bond || !signers.length) { await finish(h, 'voided', 'pledge_lapsed', signers.length ? 'not the bond its tally counted' : 'the pledge lapsed with nobody to share its bond'); continue; }
        // Equal shares in whole cents, the odd cents to the first signers; whoever paid for a house is paid at that house.
        const base = Math.floor(h.amount / signers.length), odd = h.amount - base * signers.length;
        h.split = signers.map((x, i) => ({ webId: x.pledge!.by, url: x.payerUrl ?? '', amount: base + (i < odd ? 1 : 0) })).filter((x) => x.amount > 0 && x.url);
        shared = { amount: h.amount / 100, among: h.split.length, each: base / 100 };
        await finish(h, 'captured', 'pledge_lapsed', 'the pledge lapsed: its opener\'s bond is shared among everyone who signed');
      }
    }
    return { kind: 'pledge.settled', id, outcome: p.outcome, settled: open.length, ...(p.outcome === 'filled' ? { paid: signers.length } : { returned: gifts.length }), ...(shared ? { bond: shared } : {}) };
  };
  return { app: s.app, card: s.card, webId: s.webId };
}
