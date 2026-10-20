import { randomUUID } from 'node:crypto';
import {
  auditStudy, buildCard, issueCredential, lakeAgentApp, ReplayGuard, signCard, signMessage, studyFields, studyId, verifyLakeData,
  type AgentCard, type Identity, type LakeData, type Study,
} from '@thelakeprotocol/core';
import type express from 'express';

interface SpecialistOptions { id: Identity; url: string; domain: string; sandbox: boolean }
type Reply = { kind: 'approved' | 'certified'; credential: string; notes: string[] } | { kind: 'refused'; problems: string[] };

const IDENTIFYING = ['name', 'dob', 'nhs_number', 'email', 'phone', 'address'];
/** Converters this auditor has reviewed. A real auditor would pin the package digest too. */
const CERTIFIED_CONVERTERS = ['@thelakeprotocol/convert-fhir@0.1.0'];
const DAY = 86_400_000;

async function specialist(o: SpecialistOptions, name: string, description: string, skill: string, decide: (payload: Record<string, unknown>, from: string) => Promise<Reply>) {
  const webId = `${o.url}/#${skill}`;
  const card = await signCard(
    buildCard({ name, description, url: `${o.url}/a2a`, skills: [{ id: skill, name, description }], profile: { role: 'specialist', webId, ownerDomain: o.domain, tags: [skill] } }, o.id),
    o.id,
  );
  const replay = new ReplayGuard();
  const reply = async (body: Reply): Promise<LakeData> => ({ lake: '0.1', card, envelope: (await signMessage(body, o.id, { iss: webId })) as LakeData['envelope'] });
  const app = lakeAgentApp(card, async (data) => {
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox });
    if (!v.ok) return reply({ kind: 'refused', problems: [`${v.rejection.code}: ${v.rejection.why}`] });
    return reply(await decide(v.payload, v.profile.webId));
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
  const s = await specialist(o, 'Ethics (demo checklist)', 'Reviews study protocols against a fixed checklist. A demo, not a human ethics committee.', 'ethics-review', async (p, from) => {
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
  const s = await specialist(o, 'Auditor (demo)', 'Certifies studies (noisy aggregates of known questions) and converter packages.', 'study-audit', async (p) => {
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
