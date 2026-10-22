import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import rdf from '@zazuko/env';
import SHACLValidator from 'rdf-validate-shacl';
import { describe, expect, it } from 'vitest';
import { auditProgram, claimsToTurtle, registerPack, runProgram } from '@thelakeprotocol/core';
import mortgage, { extractClaims, LENDERS, syntheticStatements } from './index.js';

registerPack(mortgage);
const read = (u: string) => new Parser().parse(readFileSync(new URL(u, import.meta.url), 'utf8'));
const shapes = rdf.dataset([...read('../../../model/shapes.ttl'), ...read('../shapes.ttl')]);
const validate = (ttl: string) => new SHACLValidator(shapes, { factory: rdf }).validate(rdf.dataset(new Parser().parse(ttl)));
const prov = { subject: 'http://pod.test/sam/profile/card#me', issuer: 'http://bank/#issuer', originalHash: 'sha256-x', converter: mortgage.source!.converter };
const people = Array.from({ length: 300 }, (_, i) => extractClaims(syntheticStatements(i + 1)));
const intent = { price_band: 250_000, term_years: 30 };

describe('mortgage@1', () => {
  it('makes the same statements for the same seed', () => {
    expect(syntheticStatements(7)).toEqual(syntheticStatements(7));
  });

  it('turns statements into the five facts a lender needs, in plausible ranges', () => {
    for (const c of people) {
      const n = (f: string) => Number(c.find((x) => x.field === f)!.value);
      expect(n('income_annual')).toBeGreaterThanOrEqual(10_000);
      expect(n('income_annual')).toBeLessThanOrEqual(200_000);
      expect(n('missed_payments_12m')).toBeLessThanOrEqual(4);
    }
  });

  it('passes its SHACL shapes, for 50 different people', async () => {
    for (let i = 0; i < 50; i++) {
      const report = await validate(claimsToTurtle(mortgage, people[i]!, 'http://pod.test/sam/finance/claims.ttl', prov));
      expect(report.conforms, report.results.map((r) => r.message.map((m) => m.value).join()).join('; ')).toBe(true);
    }
  });

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
    expect(auditProgram({ ...p, outputs: { leak: { fetch: [1] } as never } }).ok).toBe(false);
    expect(auditProgram({ ...p, output: 'asker' as never }).ok).toBe(false);
  });
});
