import { describe, expect, it } from 'vitest';
import { addCounts, auditStudy, buildCard, cellOf, combineCounts, generateIdentity, issueCredential, oneHot, registerPack, signCard, splitCount, checkAttachment, studyId, COUNT_MODULUS, type Study } from './index.js';

// A fixture pack: the core knows no fields of its own, so its tests bring some.
registerPack({
  id: 'fixture', version: '1.0.0', title: 'Fixture', vocab: 'urn:fixture#', folder: 'fixture/', recordClass: 'urn:fixture#Record',
  fields: {
    age_band: { class: 'urn:fixture#AgeBand', kind: 'band', label: 'age band' },
    medications: { class: 'urn:fixture#Medication', kind: 'code', label: 'medications' },
    readmissions: { class: 'urn:fixture#Readmission', kind: 'flag', label: 'readmissions' },
  },
  identifying: ['name'],
});

const study: Study = {
  v: 1,
  question: 'Do over-60s on drug X get readmitted less?',
  kind: 'contingency',
  predicates: [
    { name: 'over 60', field: 'age_band', op: 'age_at_least', value: 60 },
    { name: 'on drug X', field: 'medications', op: 'has_code', value: 'drug-x' },
    { name: 'readmitted', field: 'readmissions', op: 'present' },
  ],
  privacy: { mechanism: 'split-count', tellers: [{ url: 'https://teller-a.example/a2a', domain: 'teller-a.example' }, { url: 'https://teller-b.example/a2a', domain: 'teller-b.example' }], min: 20 },
  minTier: 'issuer-signed',
};

function seeded(seed: number) {
  let a = seed;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('studies', () => {
  it('put each person in exactly one cell, from claims alone', () => {
    expect(cellOf(study, [{ field: 'age_band', value: '60-69' }, { field: 'medications', value: 'Drug X', code: 'drug-x' }])).toBe(0b011);
    expect(cellOf(study, [{ field: 'age_band', value: '40-49' }, { field: 'readmissions', value: 'x' }])).toBe(0b100);
  });

  it('give the exact table from two tellers, and neither teller alone learns anything', () => {
    const rand = seeded(42);
    const truth = Array(8).fill(0);
    const pieces: [number[], number[]][] = Array.from({ length: 500 }, () => {
      const cell = Math.floor(rand() * 8);
      truth[cell]++;
      return splitCount(oneHot(study, cell));
    });
    const a = addCounts(...pieces.map((p) => p[0])), b = addCounts(...pieces.map((p) => p[1]));
    expect(combineCounts(a, b)).toEqual(truth);
    // One house's piece is a uniformly random number, the same for a 0 as for a 1: it says nothing on its own.
    expect(pieces[0]![0].every((x) => x >= 0 && x < COUNT_MODULUS)).toBe(true);
    expect(pieces[0]![0].some((x) => x > 1)).toBe(true);
  });

  it('are refused when they ask for something the Lake cannot ask, or let anyone see a single answer', () => {
    expect(auditStudy(study).ok).toBe(true);
    const one = study.privacy.tellers[0]!;
    expect(auditStudy({ ...study, privacy: { ...study.privacy, tellers: [one, one] } }).problems.join()).toMatch(/different parties/);
    expect(auditStudy({ ...study, privacy: { ...study.privacy, tellers: [one] } }).ok).toBe(false);
    expect(auditStudy({ ...study, privacy: { mechanism: 'unary-randomized-response', epsilon: 2 } as never }).ok).toBe(false);
    expect(auditStudy({ ...study, predicates: [{ name: 'postcode', field: 'postcode' as never, op: 'present' }] }).ok).toBe(false);
  });
});

describe('trusted attachments', () => {
  async function ethicsAgent(domain: string) {
    const id = await generateIdentity();
    const webId = `https://${domain}/#ethics`;
    const card = await signCard(buildCard({ name: 'Ethics', description: 'x', url: `https://${domain}/a2a`, skills: [], profile: { role: 'specialist', webId, ownerDomain: domain, tags: [] } }, id), id);
    const approve = (subject: string) =>
      issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeEthicsApproval'], issuer: webId, validFrom: new Date().toISOString(), credentialSubject: { id: subject } }, id);
    return { card, approve };
  }

  it('count only from trusted domains, and only for this study', async () => {
    const ox = await ethicsAgent('ethics.ox.example');
    const credential = await ox.approve(studyId(study));
    const o = { type: 'LakeEthicsApproval', subject: studyId(study), sandbox: true };
    expect((await checkAttachment({ credential, card: ox.card }, { ...o, trusted: ['ethics.ox.example'] })).ok).toBe(true);
    expect(await checkAttachment({ credential, card: ox.card }, { ...o, trusted: ['hra.example'] })).toMatchObject({ ok: false });
    expect(await checkAttachment({ credential, card: ox.card }, { ...o, trusted: ['ethics.ox.example'], subject: 'urn:other' })).toMatchObject({ ok: false });
    const fake = await ethicsAgent('ethics.ox.example');
    expect(await checkAttachment({ credential, card: fake.card }, { ...o, trusted: ['ethics.ox.example'] })).toMatchObject({ ok: false });
  });
});
