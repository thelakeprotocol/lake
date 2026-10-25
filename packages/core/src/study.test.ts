import { describe, expect, it } from 'vitest';
import { addNoise, discloseTable, aggregateReports, auditStudy, buildCard, cellOf, fromWire, generateIdentity, issueCredential, newVerifyKey, prepareReport, registerPack, settleReport, shardAnswer, signCard, checkAttachment, guardedFields, questionId, studyId, toWire, unshardCounts, type Study } from './index.js';

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
  privacy: { mechanism: 'dap-prio3', tellers: [{ url: 'https://teller-a.example/a2a', domain: 'teller-a.example' }, { url: 'https://teller-b.example/a2a', domain: 'teller-b.example' }], min: 20 },
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

  it('give the exact table from two tellers (DAP with Prio3), and drop an answer whose proof fails', async () => {
    const truth = Array(8).fill(0);
    const key = newVerifyKey(8);
    const reports = [];
    for (const cell of [3, 3, 7, 0, 5, 3]) {
      truth[cell]++;
      reports.push(await shardAnswer(8, cell));
    }
    // A dishonest house turns its Helper share into "1000 people in cell 0": the proof no longer holds.
    const forged = fromWire(reports[1]!.shares[1]) as { measurementShare: bigint[] };
    forged.measurementShare[0] = forged.measurementShare[0]! + 1000n;
    reports[1]!.shares[1] = toWire(forged);
    truth[3]--;
    const leader: { state: unknown; message: unknown }[] = [], helper: { state: unknown; message: unknown }[] = [];
    for (const r of reports) {
      const a = await prepareReport(8, key, 0, { ...r, share: r.shares[0] });
      const b = await prepareReport(8, key, 1, { ...r, share: r.shares[1] });
      const message = await settleReport(8, [a.share, b.share]);
      if (!message) continue;
      leader.push({ state: a.state, message });
      helper.push({ state: b.state, message });
    }
    expect(leader).toHaveLength(5);
    expect(unshardCounts(8, [aggregateReports(8, leader), aggregateReports(8, helper)], 5)).toEqual(truth);
  });

  it('blur only the released table when the tellers add noise, never the answers', async () => {
    const key = newVerifyKey(8);
    const leader: { state: unknown; message: unknown }[] = [], helper: { state: unknown; message: unknown }[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await shardAnswer(8, i % 4);
      const a = await prepareReport(8, key, 0, { ...r, share: r.shares[0] });
      const b = await prepareReport(8, key, 1, { ...r, share: r.shares[1] });
      const message = await settleReport(8, [a.share, b.share]);
      leader.push({ state: a.state, message });
      helper.push({ state: b.state, message });
    }
    const exact = unshardCounts(8, [aggregateReports(8, leader), aggregateReports(8, helper)], 40);
    expect(exact).toEqual([10, 10, 10, 10, 0, 0, 0, 0]);
    const noisy = unshardCounts(8, [addNoise(8, aggregateReports(8, leader), 2), addNoise(8, aggregateReports(8, helper), 2)], 40);
    noisy.forEach((c, i) => expect(Math.abs(c - exact[i]!)).toBeLessThan(15));
  });

  it('are refused when they ask for something the Lake cannot ask, or let anyone see a single answer', () => {
    expect(auditStudy(study).ok).toBe(true);
    const one = study.privacy.tellers[0]!;
    expect(auditStudy({ ...study, privacy: { ...study.privacy, tellers: [one, one] } }).problems.join()).toMatch(/different parties/);
    expect(auditStudy({ ...study, privacy: { ...study.privacy, tellers: [one] } }).ok).toBe(false);
    expect(auditStudy({ ...study, privacy: { mechanism: 'unary-randomized-response', epsilon: 2 } as never }).ok).toBe(false);
    expect(auditStudy({ ...study, predicates: [{ name: 'postcode', field: 'postcode' as never, op: 'present' }] }).ok).toBe(false);
  });

  it("are refused when they read a register's fields, unless its pack lets studies read them (run 28)", () => {
    const authority = { name: 'Fixture Register', description: 'x', domain: 'register.example', path: 'register', register: ['member.example'] };
    registerPack({ id: 'guarded', version: '1.0.0', title: 'Guarded', vocab: 'urn:guarded#', folder: 'guarded/', recordClass: 'urn:guarded#Record', fields: { basket: { class: 'urn:guarded#Basket', kind: 'code', label: 'basket' } }, authority });
    registerPack({ id: 'open', version: '1.0.0', title: 'Open to studies', vocab: 'urn:open#', folder: 'open/', recordClass: 'urn:open#Record', fields: { balance: { class: 'urn:open#Balance', kind: 'number', label: 'balance' } }, authority: { ...authority, studies: true } });
    const reads = (field: string, op: 'has_code' | 'present') => ({ ...study, predicates: [...study.predicates, op === 'has_code' ? { name: 'x', field, op, value: 'y' } : { name: 'x', field, op }] });
    const padded = auditStudy(reads('basket', 'has_code'));
    expect(padded.ok).toBe(false);
    expect(padded.problems.join()).toMatch(/"basket", which guarded's register \(Fixture Register\) keeps for agents on it/);
    expect(auditStudy(reads('balance', 'present')).ok).toBe(true);

    // At a house's door: what an agent needs the register's authorisation for.
    expect(guardedFields(['age_band', 'basket', 'balance'])).toEqual([{ pack: expect.objectContaining({ id: 'guarded' }), fields: ['basket'] }, { pack: expect.objectContaining({ id: 'open' }), fields: ['balance'] }]);
    // A certified study reading them covers only the pack that lets studies in, and only the fields the study reads.
    expect(guardedFields(['age_band', 'basket', 'balance'], ['age_band', 'basket', 'balance']).map((g) => g.fields)).toEqual([['basket']]);
    expect(guardedFields(['balance'], ['age_band']).map((g) => g.fields)).toEqual([['balance']]);
    expect(guardedFields(['age_band', 'medications'])).toEqual([]);
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

describe('what a count may publish (the threshold rule, with table redesign)', () => {
  it('publishes a table whose every cell is 0 or at least k, as it is', () => {
    expect(discloseTable([5, 0, 3, 9, 0, 4, 3, 7], 3)).toEqual({ cells: [5, 0, 3, 9, 0, 4, 3, 7], kept: [0, 1, 2] });
  });

  it('collapses a table with a small group, dropping the first question first, and never shows 1 to k-1', () => {
    // Cell 0b001 (question 0 yes, 1 and 2 no) holds one answer: without question 0, cells 0b000 and 0b001 merge.
    const t = discloseTable([4, 1, 3, 5, 3, 6, 4, 3], 3)!;
    expect(t).toEqual({ cells: [5, 8, 9, 7], kept: [1, 2] });
    // Nothing is lost from the total: a collapsed table still counts everyone.
    expect(t.cells.reduce((a, b) => a + b, 0)).toBe(29);
  });

  it('collapses as far as it must, and publishes no table when nothing passes', () => {
    // Eight houses, one per cell (run 31's table): only the last question alone shows groups of 3 or more.
    expect(discloseTable([1, 1, 1, 1, 1, 1, 1, 1], 3)).toEqual({ cells: [4, 4], kept: [2] });
    expect(discloseTable([1, 1, 0, 0, 0, 0, 0, 0], 3)).toBeNull();
  });

  it('holds for any table: what comes out has no cell of 1 to k-1, and the same total', () => {
    const rand = seeded(7);
    for (let n = 0; n < 500; n++) {
      const k = 3 + Math.floor(rand() * 8);
      const cells = Array.from({ length: 2 ** (1 + Math.floor(rand() * 4)) }, () => (rand() < 0.4 ? 0 : Math.floor(rand() * 3 * k)));
      const t = discloseTable(cells, k);
      if (!t) continue;
      expect(t.cells.every((c) => c === 0 || c >= k)).toBe(true);
      expect(t.cells.reduce((a, b) => a + b, 0)).toBe(cells.reduce((a, b) => a + b, 0));
      expect(t.cells).toHaveLength(2 ** t.kept.length);
    }
  });

  it('a count of options (a vote) is all or nothing; noise at or below zero is an empty cell', () => {
    expect(discloseTable([4, 0, 7], 3)).toEqual({ cells: [4, 0, 7], kept: [] });
    expect(discloseTable([4, 2, 7], 3)).toBeNull();
    expect(discloseTable([5, -1, 4, 3], 3)).toEqual({ cells: [5, -1, 4, 3], kept: [0, 1] });
  });

  it('a question id is the same whoever counts it', () => {
    const other = { ...study, privacy: { ...study.privacy, min: 40, tellers: [...study.privacy.tellers].reverse() } };
    expect(studyId(other)).not.toBe(studyId(study));
    expect(questionId(other)).toBe(questionId(study));
  });
});
