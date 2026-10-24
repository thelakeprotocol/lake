import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import rdf from '@zazuko/env';
import SHACLValidator from 'rdf-validate-shacl';
import { describe, expect, it } from 'vitest';
import { auditProgram, claimsToTurtle, offerWarnings, registerPack, runProgram } from '@thelakeprotocol/core';
import shopping, { extractClaims, GROCERS, syntheticReceipts } from './index.js';

registerPack(shopping);
const read = (u: string) => new Parser().parse(readFileSync(new URL(u, import.meta.url), 'utf8'));
const shapes = rdf.dataset([...read('../../../model/shapes.ttl'), ...read('../shapes.ttl')]);
const validate = (ttl: string) => new SHACLValidator(shapes, { factory: rdf }).validate(rdf.dataset(new Parser().parse(ttl)));
const prov = { subject: 'http://pod.test/sam/profile/card#me', issuer: 'http://receipts/#issuer', originalHash: 'sha256-x', converter: shopping.source!.converter };
const households = Array.from({ length: 300 }, (_, i) => extractClaims(syntheticReceipts(i + 1)));
const intent = { region: 'vic', budget: 180, delivery: 'this-week', group_size: 1 };
const codes = (c: ReturnType<typeof extractClaims>, f: string) => c.filter((x) => x.field === f).map((x) => x.code);

describe('shopping@1', () => {
  it('makes the same receipts for the same seed, and turns them into a shopping list, not a diary', () => {
    expect(syntheticReceipts(7)).toEqual(syntheticReceipts(7));
    for (const c of households) {
      expect(Number(c.find((x) => x.field === 'household_size')!.value)).toBeGreaterThanOrEqual(1);
      // Only coarse facts: no store, date or price per item leaves the receipts.
      expect(JSON.stringify(c)).not.toMatch(/Big Mart|Corner Grocer|Green Basket|20\d\d-/);
    }
  });

  it('passes its SHACL shapes, for 30 different households', async () => {
    for (let i = 0; i < 30; i++) {
      const report = await validate(claimsToTurtle(shopping, households[i]!, 'http://pod.test/sam/household/claims.ttl', prov));
      expect(report.conforms, report.results.map((r) => r.message.map((m) => m.value).join()).join('; ')).toBe(true);
    }
  }, 30_000);

  it('every grocer program is one an auditor would certify', () => {
    for (const g of GROCERS) expect(auditProgram(g.program), g.name).toEqual({ ok: true, problems: [] });
  });

  it('grocers really differ: price, who they can serve, where they deliver', () => {
    const results = GROCERS.map((g) => households.map((c) => runProgram(g.program, c, intent)));
    const served = results.map((r) => r.filter((x) => x.eligible).length);
    expect(new Set(served).size).toBe(3);
    // The cheapest offer for one ordinary household comes from Big Mart; Green Basket serves every diet.
    const plain = households.findIndex((c) => !codes(c, 'dietary_needs').length);
    const totals = results.map((r) => r[plain]!.outputs.total);
    expect(totals[0]).toBeLessThan(totals[2]!);
    expect(results[2]!.every((x) => x.eligible)).toBe(true);
  });

  it('a grocer that can\'t serve a diet makes no offer; one that can, does', () => {
    const gf = households.find((c) => codes(c, 'dietary_needs').includes('gluten-free'))!;
    expect(runProgram(GROCERS[0]!.program, gf, intent).eligible).toBe(false); // Big Mart: no gluten-free
    expect(runProgram(GROCERS[2]!.program, gf, intent).eligible).toBe(true); // Green Basket: every diet
  });

  it('the street gets a group price, and Corner Grocer only delivers locally', () => {
    const c = households.find((x) => !codes(x, 'dietary_needs').length)!;
    const alone = runProgram(GROCERS[1]!.program, c, intent).outputs;
    const together = runProgram(GROCERS[1]!.program, c, { ...intent, group_size: 3 }).outputs;
    expect(together.group_off).toBe(8);
    expect(together.total).toBeLessThan(alone.total!);
    expect(runProgram(GROCERS[1]!.program, c, { ...intent, region: 'wa' }).eligible).toBe(false);
  });

  it('warns the owner if dietary needs are asked for to decide about them', () => {
    expect(offerWarnings({ fields: ['dietary_needs'], retention: 'none', purpose: 'insurance' })).toEqual(['asks for sensitive data (dietary needs) to make decisions about you (insurance)']);
  });
});
