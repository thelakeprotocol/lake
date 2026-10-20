import { randomUUID } from 'node:crypto';
import {
  auditStudy, buildCard, digestSRI, makeEvent, type LakeEvent, verifyCredential, verifyLakeCard, issueCredential, lakeAgentApp, ReplayGuard, signCard, signMessage, studyFields, studyId, verifyLakeData,
  type AgentCard, type Identity, type LakeData, type LakeProfile, type Study,
} from '@thelakeprotocol/core';
import type express from 'express';

export interface SpecialistOptions { id: Identity; url: string; domain: string; sandbox: boolean; report?: (e: LakeEvent) => void }
type Reply =
  | { kind: 'approved' | 'certified'; credential: string; notes: string[] }
  | { kind: 'settled'; receipts: { payee: string; credential: string }[]; total: number; remaining: number }
  | { kind: 'refused'; problems: string[] };

const IDENTIFYING = ['name', 'dob', 'nhs_number', 'email', 'phone', 'address'];
/** Converters this auditor has reviewed. A real auditor would pin the package digest too. */
const CERTIFIED_CONVERTERS = ['@thelakeprotocol/convert-fhir@0.1.0'];
const DAY = 86_400_000;

export type Refused = { kind: 'refused'; problems: string[] };
export interface Specialist { app: express.Express; card: AgentCard; webId: string; vc: (type: string, subject: Record<string, unknown> & { id: string }, days: number) => Promise<string> }

/** A signed Lake agent with one skill: verifies every message before `decide` sees it, signs every reply. */
export async function specialist<R extends { kind: string } = Reply>(o: SpecialistOptions, name: string, description: string, skill: string, decide: (payload: Record<string, unknown>, from: string, profile: LakeProfile) => Promise<R | Refused>, extraSkills: { id: string; name: string; description: string }[] = []): Promise<Specialist> {
  const webId = `${o.url}/#${skill}`;
  const card = await signCard(
    buildCard({ name, description, url: `${o.url}/a2a`, skills: [{ id: skill, name, description }, ...extraSkills], profile: { role: 'specialist', webId, ownerDomain: o.domain, tags: [skill] } }, o.id),
    o.id,
  );
  const replay = new ReplayGuard();
  const reply = async (body: R | Refused): Promise<LakeData> => ({ lake: '0.1', card, envelope: (await signMessage(body, o.id, { iss: webId })) as LakeData['envelope'] });
  const app = lakeAgentApp(card, async (data) => {
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox });
    if (!v.ok) return reply({ kind: 'refused', problems: [`${v.rejection.code}: ${v.rejection.why}`] });
    const out = await decide(v.payload, v.profile.webId, v.profile);
    // Tell the map who just came by, so it can show the visit. Ids and kinds only.
    if (out.kind !== 'refused') o.report?.(makeEvent('decision', 'self', `agent:${v.profile.ownerDomain}`, { decision: out.kind }));
    return reply(out);
  });
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
    if (protocol.purpose !== 'research') problems.push('purpose must be research');
    if (protocol.retention !== 'none') problems.push('results only; no retention of anything else');
    const identifying = (protocol.fields ?? []).filter((f) => IDENTIFYING.includes(f));
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
  const s: Specialist = await specialist<Reply>(o, 'Auditor (demo)', 'Certifies studies (noisy aggregates of known questions) and converter packages.', 'study-audit', async (p) => {
    if (p.kind === 'audit-study') {
      const study = p.study as Study;
      const audit = auditStudy(study);
      if (!audit.ok) return { kind: 'refused', problems: audit.problems };
      const credential = await s.vc('LakeStudyCertificate', { id: studyId(study), checks: ['declarative study, no code', 'answers randomised before leaving a house', 'aggregates only', `privacy budget ε=${study.privacy.epsilon}`] }, 90);
      return { kind: 'certified', credential, notes: [] };
    }
    if (p.kind === 'audit-converter') {
      const pkg = String(p.package ?? '');
      if (!CERTIFIED_CONVERTERS.includes(pkg)) return { kind: 'refused', problems: [`${pkg} has not been reviewed`] };
      const credential = await s.vc('LakeConverterCertificate', { id: `urn:lake:converter:${pkg}`, package: pkg }, 365);
      return { kind: 'certified', credential, notes: [] };
    }
    return { kind: 'refused', problems: ['send { kind: "audit-study", study } or { kind: "audit-converter", package }'] };
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
    const intent = p.intent as { credential: string; card: AgentCard } | undefined;
    const payments = (p.payments as string[] | undefined) ?? [];
    if (!intent?.credential || !intent.card) return { kind: 'refused', problems: ['no Intent Mandate'] };
    let human;
    try {
      human = await verifyLakeCard(intent.card);
    } catch (e) {
      return { kind: 'refused', problems: [`the human's card: ${(e as Error).message}`] };
    }
    if (human.ownerDomain !== agent.ownerDomain) return { kind: 'refused', problems: ['the Intent Mandate was signed by someone outside the agent\'s organisation'] };
    let mandate;
    try {
      mandate = await verifyCredential(intent.credential, human.publicJwk);
    } catch {
      return { kind: 'refused', problems: ['the Intent Mandate signature does not verify'] };
    }
    const m = mandate.credentialSubject as unknown as { id: string; budget: { amount: number }; intent_expiry: string };
    if (!mandate.type.includes('IntentMandate') || m.id !== agentWebId) return { kind: 'refused', problems: ['the Intent Mandate is not for this agent'] };
    if (Date.parse(m.intent_expiry) < Date.now()) return { kind: 'refused', problems: ['the Intent Mandate has expired'] };
    const digest = digestSRI(intent.credential);
    const checked: { payee: string; amount: number; agreement: string }[] = [];
    for (const pm of payments) {
      try {
        const vc = await verifyCredential(pm, agent.publicJwk);
        const x = vc.credentialSubject as unknown as { id: string; amount: { value: number }; intentMandate: string; agreement: string };
        if (!vc.type.includes('PaymentMandate') || x.intentMandate !== digest || !(x.amount.value > 0)) throw new Error();
        checked.push({ payee: x.id, amount: x.amount.value, agreement: x.agreement });
      } catch {
        return { kind: 'refused', problems: ['a Payment Mandate is not signed by the agent under this Intent Mandate'] };
      }
    }
    const total = checked.reduce((a, c) => a + c.amount, 0);
    const already = spent.get(digest) ?? 0;
    if (already + total > m.budget.amount) {
      return { kind: 'refused', problems: [`$${already + total} is over the $${m.budget.amount} the human signed for: a human must approve`] };
    }
    spent.set(digest, already + total);
    const receipts = await Promise.all(
      checked.map(async (c) => ({
        payee: c.payee,
        credential: await s.vc('LakeReceipt', { id: c.payee, amount: { currency: 'USD', value: c.amount }, agreement: c.agreement, intentMandate: digest, settlement: 'simulated' }, 3650),
      })),
    );
    o.onSettled?.(total, checked.length);
    return { kind: 'settled', receipts, total, remaining: m.budget.amount - already - total };
  });
  return { app: s.app, card: s.card, webId: s.webId };
}
