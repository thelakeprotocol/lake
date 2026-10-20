import { describe, expect, it } from 'vitest';
import { auditStudy, buildCard, cellOf, estimate, generateIdentity, issueCredential, randomize, signCard, checkAttachment, studyId, type Study } from './index.js';

const study: Study = {
  v: 1,
  question: 'Do over-60s on drug X get readmitted less?',
  kind: 'contingency',
  predicates: [
    { name: 'over 60', field: 'age_band', op: 'age_at_least', value: 60 },
    { name: 'on drug X', field: 'medications', op: 'has_code', value: 'drug-x' },
    { name: 'readmitted', field: 'readmissions', op: 'present' },
  ],
  privacy: { mechanism: 'unary-randomized-response', epsilon: 2 },
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

  it('recover the true table from randomised answers, within 3 standard errors at 4,000 houses', () => {
    const rand = seeded(42);
    const truth = Array(8).fill(0);
    const fragments = Array.from({ length: 4000 }, () => {
      const cell = Math.floor(rand() * 8) === 0 ? 7 : Math.floor(rand() * 4);
      truth[cell]++;
      return randomize(study, cell, rand);
    });
    const { n, cells } = estimate(study, fragments);
    expect(n).toBe(4000);
    const e = Math.exp(1), p = e / (1 + e), q = 1 / (1 + e);
    const se = Math.sqrt(n * 0.25) / (p - q); // worst-case binomial spread, rescaled by the estimator
    cells.forEach((c, i) => expect(Math.abs(c - truth[i])).toBeLessThan(3 * se));
    expect(se).toBeLessThan(70); // ~1.7% of 4,000: plenty to answer the demo question
  });

  it('make any single answer deniable: a one-hot cell is not what gets sent', () => {
    const rand = seeded(7);
    const sent = Array.from({ length: 200 }, () => randomize(study, 3, rand));
    expect(sent.filter((v) => v.join() === [0, 0, 0, 1, 0, 0, 0, 0].join()).length).toBeLessThan(40);
  });

  it('are refused when they ask for something the Lake cannot ask, or skip the noise', () => {
    expect(auditStudy(study).ok).toBe(true);
    expect(auditStudy({ ...study, privacy: { mechanism: 'unary-randomized-response', epsilon: 50 } }).ok).toBe(false);
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
