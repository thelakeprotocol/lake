import { randomUUID } from 'node:crypto';
import {
  auditProgram, auditStudy, checkCredentialStatus, verifyOwnerKey, purposeWithin, buildCard, digestSRI, identifyingFields, packs, programId, type QuoteProgram, makeEvent, type LakeEvent, verifyCredential, verifyLakeCard, issueCredential, lakeAgentApp, ReplayGuard, signCard, signMessage, studyFields, studyId, verifyLakeData,
  packId, type AgentCard, type Identity, type LakeData, type LakePack, type LakeProfile, type Study,
} from '@thelakeprotocol/core';
import type express from 'express';

export interface SpecialistOptions { id: Identity; url: string; domain: string; sandbox: boolean; report?: (e: LakeEvent) => void }
type Reply =
  | { kind: 'approved' | 'certified'; credential: string; notes: string[] }
  | { kind: 'settled'; receipts: { payee: string; credential: string }[]; total: number; remaining: number }
  | { kind: 'refused'; problems: string[] };

/** Converters this auditor has reviewed: those of the packs it runs with. A real auditor would pin the package digest too. */
const certifiedConverters = () => packs().map((p) => p.source?.converter).filter(Boolean);
const DAY = 86_400_000;

export type Refused = { kind: 'refused'; problems: string[] };
export interface Specialist { app: express.Express; card: AgentCard; webId: string; vc: (type: string, subject: Record<string, unknown> & { id: string }, days: number) => Promise<string> }

/** A signed Lake agent with one skill: verifies every message before `decide` sees it, signs every reply. */
export async function specialist<R extends { kind: string } = Reply>(o: SpecialistOptions, name: string, description: string, skill: string, decide: (payload: Record<string, unknown>, from: string, profile: LakeProfile, card: AgentCard) => Promise<R | Refused>, extraSkills: { id: string; name: string; description: string }[] = [], quiet = false): Promise<Specialist> {
  const webId = `${o.url}/#${skill}`;
  const card = await signCard(
    // A quiet agent's visitors are nobody's business: it says so on its card, and reports no visits.
    buildCard({ name, description, url: `${o.url}/a2a`, skills: [{ id: skill, name, description }, ...extraSkills], profile: { role: 'specialist', webId, ownerDomain: o.domain, tags: quiet ? [skill, 'quiet'] : [skill] } }, o.id),
    o.id,
  );
  const replay = new ReplayGuard();
  const reply = async (body: R | Refused): Promise<LakeData> => ({ lake: '0.1', card, envelope: (await signMessage(body, o.id, { iss: webId })) as LakeData['envelope'] });
  const app = lakeAgentApp(card, async (data) => {
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox });
    if (!v.ok) return reply({ kind: 'refused', problems: [`${v.rejection.code}: ${v.rejection.why}`] });
    const out = await decide(v.payload, v.profile.webId, v.profile, (data as LakeData).card);
    // Tell the map who just came by, so it can show the visit. Ids and kinds only.
    if (out.kind !== 'refused' && !quiet) o.report?.(makeEvent('decision', 'self', `agent:${v.profile.ownerDomain}`, { decision: out.kind }));
    return reply(out);
  }, o.id);
  const vc = (type: string, subject: Record<string, unknown> & { id: string }, days: number) =>
    issueCredential(
      { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', type], issuer: webId, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + days * DAY).toISOString(), credentialSubject: subject } as never,
      o.id,
    );
  return { app, card, webId, vc };
}

/**
 * The demo Ethics agent: a fixed checklist, clearly labelled. A real one is a door to a human committee;
 * owners decide which ethics domains they trust (rules.yaml → trust.ethics).
 */
export async function createEthics(o: SpecialistOptions): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const s: Specialist = await specialist<Reply>(o, 'Ethics (demo checklist)', 'Reviews study protocols against a fixed checklist. A demo, not a human ethics committee.', 'ethics-review', async (p, from) => {
    if (p.kind !== 'ethics-review') return { kind: 'refused', problems: ['send { kind: "ethics-review", protocol }'] };
    const protocol = p.protocol as { study: Study; purpose: string; fields: string[]; retention: string } | undefined;
    const problems: string[] = [];
    if (!protocol?.study) return { kind: 'refused', problems: ['no study in the protocol'] };
    if (!purposeWithin(protocol.purpose, 'research')) problems.push('purpose must be research');
    if (protocol.retention !== 'none') problems.push('results only; no retention of anything else');
    const identifying = (protocol.fields ?? []).filter((f) => identifyingFields().includes(f));
    if (identifying.length) problems.push(`directly identifying fields: ${identifying.join(', ')}`);
    const missing = studyFields(protocol.study).filter((f) => !protocol.fields.includes(f));
    if (missing.length) problems.push(`the study uses fields the protocol doesn't declare: ${missing.join(', ')}`);
    const audit = auditStudy(protocol.study);
    if (!audit.ok) problems.push(...audit.problems);
    if (problems.length) return { kind: 'refused', problems };
    const credential = await s.vc('LakeEthicsApproval', { id: studyId(protocol.study), question: protocol.study.question, purpose: protocol.purpose, fields: protocol.fields, sponsor: from, reviewedBy: 'demo checklist, not a human committee' }, 90);
    return { kind: 'approved', credential, notes: ['demo approval: counts only with owners who trust this domain'] };
  });
  return { app: s.app, card: s.card, webId: s.webId };
}

/** The demo Auditor: certifies declarative studies the Lake can run safely, and reviewed converter packages. */
export async function createAuditor(o: SpecialistOptions): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const s: Specialist = await specialist<Reply>(o, 'Auditor (demo)', 'Certifies studies (exact totals of known questions, counted by two tellers) and converter packages.', 'study-audit', async (p) => {
    if (p.kind === 'audit-study') {
      const study = p.study as Study;
      const audit = auditStudy(study);
      if (!audit.ok) return { kind: 'refused', problems: audit.problems };
      const credential = await s.vc('LakeStudyCertificate', { id: studyId(study), checks: ['declarative study, no code', 'answers split between two tellers run by different parties', 'totals only', `no table from fewer than ${study.privacy.min} houses`] }, 90);
      return { kind: 'certified', credential, notes: [] };
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
export async function createAuthority(o: SpecialistOptions & { pack: LakePack }): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const a = o.pack.authority!;
  const id = packId(o.pack);
  const s: Specialist = await specialist<Reply>(o, a.name, a.description, 'authorise', async (p, from, profile) => {
    if (p.kind !== 'authorise') return { kind: 'refused', problems: ['send { kind: "authorise", pack }'] };
    if (p.pack !== id) return { kind: 'refused', problems: [`this register covers ${id}`] };
    if (!a.register.includes(profile.ownerDomain)) return { kind: 'refused', problems: [`${profile.ownerDomain} is not on the register`] };
    const credential = await s.vc('LakeAuthorisation', { id: from, domain: profile.ownerDomain, pack: id, scope: 'quote' }, 365);
    return { kind: 'approved', credential, notes: [`authorised to quote for ${id}`] };
  });
  return { app: s.app, card: s.card, webId: s.webId };
}

export const newId = () => randomUUID();

/**
 * The demo Payments agent: checks the AP2 mandate chain (a human's Intent Mandate, the agent's Payment
 * Mandates under it, the budget) and records settlements. Settlement is simulated; receipts are real VCs.
 */
export async function createPayments(o: SpecialistOptions & { onSettled?: (amount: number, count: number) => void }): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const spent = new Map<string, number>();
  const s: Specialist = await specialist<Reply>(o, 'Payments (demo)', 'Verifies AP2 mandate chains and settles. Settlement is simulated; receipts are signed.', 'payments', async (p, agentWebId, agent) => {
    if (p.kind !== 'settle') return { kind: 'refused', problems: ['send { kind: "settle", intent: { credential, card }, payments: [...] }'] };
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
    const m = mandate.credentialSubject as unknown as { id: string; budget: { amount: number; currency?: string }; intent_expiry: string };
    if (!mandate.type.includes('IntentMandate') || m.id !== agentWebId) return { kind: 'refused', problems: ['the Intent Mandate is not for this agent'] };
    if (Date.parse(m.intent_expiry) < Date.now()) return { kind: 'refused', problems: ['the Intent Mandate has expired'] };
    const digest = digestSRI(intent.credential);
    const checked: { payee: string; amount: number; agreement: string }[] = [];
    for (const pm of payments) {
      try {
        const vc = await verifyCredential(pm, agent.publicJwk);
        const x = vc.credentialSubject as unknown as { id: string; amount: { value: number }; intentMandate: string; agreement: string };
        if (!vc.type.includes('PaymentMandate') || x.intentMandate !== digest || !(x.amount.value > 0)) throw new Error();
        // Whole cents, at least one; and an agent can't pay itself (it would only inflate what looks settled).
        if (x.amount.value < 0.01 || Math.abs(x.amount.value * 100 - Math.round(x.amount.value * 100)) > 1e-6) return { kind: 'refused', problems: [`$${x.amount.value}: pay at least $0.01, in whole cents`] };
        if (x.id === agentWebId) return { kind: 'refused', problems: ['an agent can\'t pay itself'] };
        checked.push({ payee: x.id, amount: Math.round(x.amount.value * 100), agreement: x.agreement });
      } catch {
        return { kind: 'refused', problems: ['a Payment Mandate is not signed by the agent under this Intent Mandate'] };
      }
    }
    // Counted in cents, so a budget never drifts by a rounding error.
    const total = checked.reduce((a, c) => a + c.amount, 0);
    const already = spent.get(digest) ?? 0;
    const cap = Math.round(m.budget.amount * 100);
    if (already + total > cap) {
      return { kind: 'refused', problems: [`$${(already + total) / 100} is over the $${m.budget.amount} the human signed for: a human must approve`] };
    }
    spent.set(digest, already + total);
    const receipts = await Promise.all(
      checked.map(async (c) => ({
        payee: c.payee,
        // A settlement id of its own: two payments with the same payer, payee, amount and memo are still two receipts.
        credential: await s.vc('LakeReceipt', { id: c.payee, payer: agentWebId, amount: { currency: m.budget.currency ?? 'USD', value: c.amount / 100 }, agreement: c.agreement, intentMandate: digest, settlement: 'simulated', settlementId: randomUUID() }, 3650),
      })),
    );
    o.onSettled?.(total / 100, checked.length);
    return { kind: 'settled', receipts, total: total / 100, remaining: (cap - already - total) / 100 };
  });
  return { app: s.app, card: s.card, webId: s.webId };
}
