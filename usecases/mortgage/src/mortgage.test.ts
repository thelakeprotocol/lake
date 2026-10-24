import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import rdf from '@zazuko/env';
import SHACLValidator from 'rdf-validate-shacl';
import { describe, expect, it } from 'vitest';
import { auditProgram, claimsToTurtle, registerPack, runProgram } from '@thelakeprotocol/core';
import mortgage, { extractClaims, grossFromNet, incomeTax, LENDERS, syntheticStatements } from './index.js';

registerPack(mortgage);
const read = (u: string) => new Parser().parse(readFileSync(new URL(u, import.meta.url), 'utf8'));
const shapes = rdf.dataset([...read('../../../model/shapes.ttl'), ...read('../shapes.ttl')]);
const validate = (ttl: string) => new SHACLValidator(shapes, { factory: rdf }).validate(rdf.dataset(new Parser().parse(ttl)));
const prov = { subject: 'http://pod.test/sam/profile/card#me', issuer: 'http://bank/#issuer', originalHash: 'sha256-x', converter: mortgage.source!.converter };
const people = Array.from({ length: 300 }, (_, i) => extractClaims(syntheticStatements(i + 1)));
const intent = { region: 'vic', price_band: 600_000, term_years: 30, first_time_buyer: 'no' };

describe('mortgage@1', () => {
  it('makes the same statements for the same seed', () => {
    expect(syntheticStatements(7)).toEqual(syntheticStatements(7));
  });

  it('turns statements into the five facts a lender needs, in plausible ranges', () => {
    for (const c of people) {
      const n = (f: string) => Number(c.find((x) => x.field === f)!.value);
      expect(n('income_annual')).toBeGreaterThanOrEqual(50_000);
      expect(n('income_annual')).toBeLessThanOrEqual(230_000);
      expect(n('missed_payments_12m')).toBeLessThanOrEqual(4);
    }
  });

  it('works gross income back out of net pay with the 2026–27 tax scales', () => {
    // $100k: 15% of $26,800 + 30% of $55,000 + 2% Medicare = $22,520.
    expect(incomeTax(100_000)).toBeCloseTo(22_520, 0);
    for (const g of [55_000, 98_000, 150_000, 220_000]) expect(grossFromNet(g - incomeTax(g))).toBeCloseTo(g, 0);
  });

  it('the First Home Guarantee waives LMI under the state cap, and only there', () => {
    const p = LENDERS.find((l) => l.name === 'Wattle Mutual')!.program;
    const buyer = [{ field: 'income_annual', value: '130000' }, { field: 'monthly_commitments', value: '0' }, { field: 'savings', value: '45000' },
      { field: 'missed_payments_12m', value: '0' }, { field: 'employment', value: 'employed', code: 'employed' }];
    const at = (region: string, first_time_buyer: string) => runProgram(p, buyer, { region, price_band: 600_000, term_years: 30, first_time_buyer, group_size: 1 }).outputs;
    expect(at('qld', 'yes')).toMatchObject({ first_home_guarantee: 1, lmi: 0 });
    expect(at('qld', 'no').lmi).toBeGreaterThan(0);
    // The Northern Territory's cap is $600k: a $600k home is in, a $750k one is not.
    expect(at('nt', 'yes').first_home_guarantee).toBe(1);
    expect(runProgram(p, buyer, { region: 'nt', price_band: 750_000, term_years: 30, first_time_buyer: 'yes', group_size: 1 }).outputs.first_home_guarantee).toBe(0);
  });

  it('passes its SHACL shapes, for 50 different people', async () => {
    for (let i = 0; i < 50; i++) {
      const report = await validate(claimsToTurtle(mortgage, people[i]!, 'http://pod.test/sam/finance/claims.ttl', prov));
      expect(report.conforms, report.results.map((r) => r.message.map((m) => m.value).join()).join('; ')).toBe(true);
    }
  }, 30_000); // 50 SHACL validations: slow on a busy machine

  it('every lender program is one an auditor would certify', () => {
    for (const l of LENDERS) expect(auditProgram(l.program), l.name).toEqual({ ok: true, problems: [] });
  });

  it('lenders genuinely differ: different people qualify, at different rates', () => {
    const results = LENDERS.map((l) => people.map((c) => runProgram(l.program, c, intent)));
    const eligible = results.map((r) => r.filter((x) => x.eligible).length);
    // Somewhere between "nobody" and "everybody", and not the same for every lender.
    expect(Math.min(...eligible)).toBeGreaterThan(0);
    expect(Math.max(...eligible)).toBeLessThan(people.length);
    expect(new Set(eligible).size).toBeGreaterThan(3);
    const someone = results.map((r) => r.find((x) => x.eligible)?.outputs.rate);
    expect(new Set(someone).size).toBeGreaterThan(3);
  });

  it('refuses a program that reads an identifying field or does something it may not', () => {
    const p = LENDERS[0]!.program;
    expect(auditProgram({ ...p, inputs: [...p.inputs, 'account_number'] }).ok).toBe(false);
    expect(auditProgram({ ...p, outputs: { leak: 'fetch(1.0)' } }).ok).toBe(false);
    expect(auditProgram({ ...p, output: 'asker' as never }).ok).toBe(false);
    // CEL is type-checked before anything runs: unknown names, the wrong type, int mixed with double.
    expect(auditProgram({ ...p, eligible: 'account_number == 1.0' }).ok).toBe(false);
    expect(auditProgram({ ...p, eligible: 'price * 2.0' }).problems).toEqual(['eligible: gives double, needs bool']);
    expect(auditProgram({ ...p, outputs: { twice: 'price * 2' } }).problems.join()).toMatch(/overload/);
    expect(auditProgram({ ...p, eligible: "region == 'nsw' && price > 1.0" }).ok).toBe(true);
  });
});
