import { registerPack, type Study } from '@thelakeprotocol/core';
import { describe, expect, it } from 'vitest';
import { ethicsProblems } from './review.js';

// Fixture packs: one plain, one whose fields a register keeps for agents on it.
registerPack({
  id: 'rfixture', version: '1.0.0', title: 'Fixture', vocab: 'urn:rfixture#', folder: 'rfixture/', recordClass: 'urn:rfixture#Record',
  fields: { band: { class: 'urn:rfixture#Band', kind: 'band', label: 'band' }, drug: { class: 'urn:rfixture#Drug', kind: 'code', label: 'drug', special: true } },
  identifying: ['full_name'], quasiIdentifying: ['area'],
});
registerPack({
  id: 'rguarded', version: '1.0.0', title: 'Guarded', vocab: 'urn:rguarded#', folder: 'rguarded/', recordClass: 'urn:rguarded#Record',
  fields: { list: { class: 'urn:rguarded#List', kind: 'code', label: 'list' } },
  authority: { name: 'Fixture Register', description: 'x', domain: 'register.example', path: 'register', register: [] },
});

const study: Study = {
  v: 1, question: 'q', kind: 'contingency',
  predicates: [{ name: 'over 60', field: 'band', op: 'at_least', value: 60 }, { name: 'on x', field: 'drug', op: 'has_code', value: 'x' }],
  privacy: { mechanism: 'dap-prio3', tellers: [{ url: 'https://a.example/a2a', domain: 'a.example' }, { url: 'https://b.example/a2a', domain: 'b.example' }], min: 3 },
  minTier: 'issuer-signed',
};
const protocol = (fields: string[], s = study) => ({ study: s, purpose: 'research', fields, retention: 'none' });

describe('the demo ethics checklist', () => {
  it('approves a protocol that declares exactly what its study reads', () => {
    expect(ethicsProblems(protocol(['band', 'drug']))).toEqual([]);
  });

  it('refuses fields the study never reads: data minimisation (run 28 padded a study with a register\'s fields)', () => {
    expect(ethicsProblems(protocol(['band', 'drug', 'area']))).toEqual(['data minimisation: the study never reads area; declare only the fields its questions read']);
    expect(ethicsProblems(protocol(['band', 'drug', 'list'])).join()).toMatch(/data minimisation: the study never reads list/);
    // Identifying fields say so, once.
    expect(ethicsProblems(protocol(['band', 'drug', 'full_name']))).toEqual(['directly identifying fields: full_name']);
  });

  it("refuses a study whose questions read a register's fields", () => {
    const reads = { ...study, predicates: [...study.predicates, { name: 'buys x', field: 'list', op: 'has_code' as const, value: 'x' }] };
    expect(ethicsProblems(protocol(['band', 'drug', 'list'], reads)).join()).toMatch(/keeps for agents on it/);
  });

  it('refuses what is missing, kept, or not research', () => {
    expect(ethicsProblems(protocol(['band']))).toEqual(["the study uses fields the protocol doesn't declare: drug"]);
    expect(ethicsProblems({ ...protocol(['band', 'drug']), purpose: 'marketing', retention: 'P1Y' })).toEqual(['purpose must be research', 'results only; no retention of anything else']);
    expect(ethicsProblems(undefined)).toEqual(['no study in the protocol']);
  });
});
