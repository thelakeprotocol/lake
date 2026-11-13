import { describe, expect, it } from 'vitest';
import { MAX_EPSILON, addNoise, aggregateReports, auditStudy, countTerms, studyId, draftStudy, predicateLines, questionProblems, studyCatalog, buildCard, cellOf, fromWire, generateIdentity, issueCredential, newVerifyKey, prepareReport, registerPack, settleReport, shardAnswer, signCard, checkAttachment, guardedFields, studyId, toWire, unshardCounts, summarizeTable, type Study } from './index.js';

// A fixture pack: the core knows no fields of its own, so its tests bring some.
registerPack({
  id: 'fixture', version: '1.0.0', title: 'Fixture', vocab: 'urn:fixture#', folder: 'fixture/', recordClass: 'urn:fixture#Record',
  fields: {
    age_band: { class: 'urn:fixture#AgeBand', kind: 'band', label: 'age band' },
    medications: { class: 'urn:fixture#Medication', kind: 'code', label: 'medications', codes: { 'drug-x': 'Drug X' } },
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

  it('says what a count for it is held to, from the study alone (what a teller opens it with)', () => {
    expect(countTerms(study)).toEqual({ ok: true, study: studyId(study), length: 8, min: 20, tellers: study.privacy.tellers });
    expect(countTerms({ ...study, privacy: { ...study.privacy, noise: { epsilon: 1 } } })).toMatchObject({ ok: true, noise: { epsilon: 1 } });
    // It reads no pack: a field no pack declares is the auditor's and the house's to refuse, and a teller needs none loaded.
    expect(countTerms({ ...study, predicates: [{ name: 'x', field: 'nowhere' as never, op: 'present' }] })).toMatchObject({ ok: true, length: 2 });
    const one = study.privacy.tellers[0]!;
    for (const privacy of [{ ...study.privacy, min: 1 }, { ...study.privacy, tellers: [one, one] }, { ...study.privacy, noise: { epsilon: 0 } }, { mechanism: 'unary-randomized-response' }]) expect(countTerms({ ...study, privacy: privacy as never }).ok).toBe(false);
    expect(countTerms({ question: 'x' } as never).ok).toBe(false);
  });

  it('noise is noise: an epsilon above 2 is refused (at 10 a teller left a cell as it was 98.7% of the time)', () => {
    expect(MAX_EPSILON).toBe(2);
    expect(auditStudy({ ...study, privacy: { ...study.privacy, noise: { epsilon: 2 } } }).ok).toBe(true);
    expect(auditStudy({ ...study, privacy: { ...study.privacy, noise: { epsilon: 2.5 } } }).problems).toEqual(['noise.epsilon: above 0 and at most 2']);
    expect(countTerms({ ...study, privacy: { ...study.privacy, noise: { epsilon: 10 } } })).toMatchObject({ ok: false });
  });

  it("are refused when they read a register's fields, unless its pack lets studies read them (run 28)", () => {
    const authority = { name: 'Fixture Register', description: 'x', domain: 'register.example', path: 'register', register: ['member.example'] };
    registerPack({ id: 'guarded', version: '1.0.0', title: 'Guarded', vocab: 'urn:guarded#', folder: 'guarded/', recordClass: 'urn:guarded#Record', fields: { basket: { class: 'urn:guarded#Basket', kind: 'code', label: 'basket' } }, authority });
    registerPack({ id: 'open', version: '1.0.0', title: 'Open to studies', vocab: 'urn:open#', folder: 'open/', recordClass: 'urn:open#Record', fields: { balance: { class: 'urn:open#Balance', kind: 'number', label: 'balance', unit: 'AUD' } }, authority: { ...authority, studies: true } });
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

  it('say what a house would count in the pack\'s words, whatever the researcher called it', () => {
    expect(predicateLines(study)).toEqual(['age band: 60 or more', 'medications: Drug X (drug-x)', 'readmissions: any on record']);
    // A friendly question and friendly names over something else: the lines come from the fields, never from them.
    const dressed: Study = { ...study, question: 'How many of you like tea?', predicates: [{ name: 'likes tea', field: 'medications', op: 'has_code', value: 'drug-q' }, { name: 'is cheerful', field: 'balance', op: 'at_most', value: 500 }] };
    expect(predicateLines(dressed)).toEqual(['medications: the code drug-q', 'balance: 500 AUD or less']);
  });

  it('are refused for a question that is a page, a nameless or twice-named yes/no question, or an endless code', () => {
    const ask = (over: Partial<Study>) => questionProblems({ ...study, ...over }).join('; ');
    expect(questionProblems(study)).toEqual([]);
    expect(ask({ question: 'x'.repeat(201) })).toMatch(/question: one sentence, up to 200 characters/);
    expect(ask({ question: ' ' })).toMatch(/question: one sentence/);
    expect(ask({ predicates: [{ name: '', field: 'readmissions', op: 'present' }] })).toMatch(/a name of up to 60 characters/);
    expect(ask({ predicates: [{ name: 'a', field: 'readmissions', op: 'present' }, { name: 'a', field: 'age_band', op: 'at_least', value: 60 }] })).toMatch(/the same name/);
    expect(ask({ predicates: [{ name: 'a', field: 'medications', op: 'has_code', value: 'x'.repeat(81) }] })).toMatch(/a code of up to 80 characters/);
    // The questions alone: tellers are somebody else's check, so a study with none yet has nothing wrong here.
    expect(questionProblems({ ...study, privacy: { ...study.privacy, tellers: [] } })).toEqual([]);
    expect(auditStudy({ ...study, privacy: { ...study.privacy, tellers: [] } }).ok).toBe(false);
  });

  it('are written as a question and its yes/no parts, and become the declaration that gets certified', () => {
    const own = draftStudy({ question: ' Are over-70s on drug X readmitted more? ', predicates: [{ name: 'over 70', field: 'age_band', op: 'at_least', value: '70' }, { name: 'on drug X', field: 'medications', op: 'has_code', value: 'drug-x' }, { name: 'readmitted', field: 'readmissions', op: 'present', value: 'ignored' }], noise_epsilon: 1 });
    expect(own).toEqual({
      v: 1, question: 'Are over-70s on drug X readmitted more?', kind: 'contingency',
      predicates: [{ name: 'over 70', field: 'age_band', op: 'at_least', value: 70 }, { name: 'on drug X', field: 'medications', op: 'has_code', value: 'drug-x' }, { name: 'readmitted', field: 'readmissions', op: 'present' }],
      privacy: { mechanism: 'dap-prio3', tellers: [], min: 3, noise: { epsilon: 1 } }, minTier: 'issuer-signed',
    });
    expect(questionProblems(own)).toEqual([]);
    // What can't be asked is said in words someone can act on.
    const bad = (p: { name: string; field: string; op: string; value?: string | number }) => questionProblems(draftStudy({ question: 'q', predicates: [p] })).join('; ');
    expect(bad({ name: 'named', field: 'name', op: 'present' })).toMatch(/"name" is identifying; no study may read it/);
    expect(bad({ name: 'old', field: 'age_band', op: 'has_code', value: '60' })).toMatch(/can't ask "has_code" of band field "age_band": it takes at_least, at_most, present/);
    expect(bad({ name: 'old', field: 'age_band', op: 'at_least', value: 'sixty' })).toMatch(/"at_least" needs a number as its value/);
    expect(bad({ name: 'old', field: 'age_band', op: 'older_than', value: 60 })).toMatch(/can't ask "older_than"/);
    expect(questionProblems(draftStudy({} as never)).length).toBeGreaterThan(0);
  });

  it('list every field a study could ask about, how, and which a register keeps to itself', () => {
    const fields = Object.fromEntries(studyCatalog().map((f) => [f.field, f]));
    expect(fields.age_band).toEqual({ field: 'age_band', pack: 'fixture@1', label: 'age band', kind: 'band', ask: ['at_least', 'at_most', 'present'], studies: true });
    expect(fields.medications).toMatchObject({ kind: 'code', ask: ['has_code', 'present'], codes: { 'drug-x': 'Drug X' } });
    expect(fields.readmissions!.ask).toEqual(['present']);
    expect(fields.balance).toMatchObject({ pack: 'open@1', unit: 'AUD', studies: true });
    expect(fields.basket).toMatchObject({ studies: false, why: expect.stringMatching(/Fixture Register keeps this pack's fields/) });
    // Identifying fields aren't on the list at all.
    expect(fields.name).toBeUndefined();
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

describe('a table, summarised (any number of predicates)', () => {
  it('compares the outcome with and without the exposure, within the group, as before', () => {
    // bit 0 over 60, bit 1 on drug X, bit 2 readmitted
    const cells = [5, 4, 3, 6, 1, 2, 2, 1];
    const t = summarizeTable(study, cells, 24);
    expect(t.comparison).toEqual({ outcome: 'readmitted', exposure: 'on drug X', within: ['over 60'], with: { yes: 1, of: 7, rate: 0.143 }, without: { yes: 2, of: 6, rate: 0.333 } });
    expect(t.marginals.map((m) => m.yes)).toEqual([13, 12, 6]);
    expect(t.precision).toEqual({ exact: true });
    expect(t.small).toBe(true);
    expect(t.summary).toBe('over 60: readmitted 14% with on drug X (1 of 7) vs 33% without (2 of 6), from 24 houses; exact counts; small numbers');
  });
  it('works for one, two and four predicates, never NaN', () => {
    const one = summarizeTable({ ...study, predicates: study.predicates.slice(0, 1) }, [7, 13], 20);
    expect(one.comparison).toBeUndefined();
    expect(one.summary).toBe('over 60: 13 of 20 (65%); exact counts');
    const two = summarizeTable({ ...study, predicates: study.predicates.slice(1) }, [10, 5, 3, 2], 20);
    expect(two.comparison).toMatchObject({ within: [], with: { yes: 2, of: 7 }, without: { yes: 3, of: 13 } });
    const four = summarizeTable({ ...study, predicates: [...study.predicates, { name: 'female', field: 'age_band', op: 'present' }] }, Array.from({ length: 16 }, (_, i) => i), 120);
    expect(JSON.stringify(four)).not.toMatch(/NaN|undefined/);
    expect(four.comparison).toMatchObject({ outcome: 'female', exposure: 'readmitted', within: ['over 60', 'on drug X'] });
  });
  it('says how noisy the cells are when the tellers add noise', () => {
    const t = summarizeTable({ ...study, privacy: { ...study.privacy, noise: { epsilon: 1 } } }, [5, -1, 3, 6, 1, 2, 2, 1], 19);
    expect(t.precision).toEqual({ exact: false, epsilon: 1, sdPerCell: 4 });
    expect(t.marginals[0]!.yes).toBe(9); // the cell below zero counts as zero
    expect(t.summary).toMatch(/each cell ±4 \(noise, ε 1\)/);
  });
});
