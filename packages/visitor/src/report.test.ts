import { describe, expect, it } from 'vitest';
import { draftStudy } from '@thelakeprotocol/core';
import { renderStudyReport } from './report.js';
import type { StudyRun } from './dispatch.js';

describe('a study result as one page (round 94, a researcher)', () => {
  it('says what each house counted in its own words, the table, who said no and why, and names no house', () => {
    const study = draftStudy({ question: 'Do over-60s on drug X get readmitted less?', predicates: [{ name: 'over 60', field: 'age_band', op: 'at_least', value: 60 }, { name: 'on X', field: 'medications', op: 'has_code', value: 'drug-x' }, { name: 'readmitted', field: 'readmissions', op: 'present' }] } as never);
    const run = {
      study: 'urn:lake:study:sha256-abc', question: 'Do over-60s on drug X get readmitted less?', houses: 15, decisions: { join: 3, decline: 7 }, bloc: null, participants: 3, excluded: [],
      cells: [{ label: 'a', count: -2 }, { label: 'b', count: 2 }], answer: { summary: 'over 60: readmitted 33% without on drug X (1 of 3)', table: { n: 3, marginals: [], precision: { exact: true }, small: true } },
      declinedBecause: { 'no-owner': 7, 'too-many': 1 }, pending: [{ house: 'Sam (house)', url: 'https://sam.example/a2a', offerId: 'o' }], paid: { total: 15, houses: 3, receiptsFiled: 3 }, seconds: 30, grants: [],
      evidence: { ethics: { credential: 'eyJhbGciOi.ethics.sig', card: { name: 'Ethics (demo)' } }, audit: { credential: 'eyJhbGciOi.audit.sig', card: { name: 'Auditor (demo)' } }, agreements: [], tellers: { leader: { card: { name: 'Teller A (demo)' } }, helper: { card: { name: 'Teller B (demo)' } } }, receipts: [] },
    } as unknown as StudyRun;
    const html = renderStudyReport(run, study as never);
    expect(html).toContain('<title>Do over-60s on drug X get readmitted less?</title>');
    expect(html).toMatch(/medications/);
    expect(html).toContain('7 · nobody has claimed the house yet');
    expect(html).toContain('15 houses asked · 3 answered');
    expect(html).toContain('Some cells are under 5');
    expect(html).toContain('Ethics (demo)');
    expect(html).toContain('Teller A (demo) and Teller B (demo)');
    expect(html).toContain('1 · too many requests already wait for their owner');
    expect(html).not.toContain('>-2<');
    expect(html).toContain('No table is published from fewer than');
    expect(html).not.toContain('sam.example');
    expect(html).not.toContain('Sam (house)');
  });
});
