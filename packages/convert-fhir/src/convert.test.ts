import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import rdf from '@zazuko/env';
import SHACLValidator from 'rdf-validate-shacl';
import { describe, expect, it } from 'vitest';
import { extractClaims, fhirToLake, syntheticPatient } from './index.js';

const asOf = Date.UTC(2026, 9, 1);
const shapes = rdf.dataset(new Parser().parse(readFileSync(new URL('../../../model/shapes.ttl', import.meta.url), 'utf8')));
const validate = (ttl: string) => new SHACLValidator(shapes, { factory: rdf }).validate(rdf.dataset(new Parser().parse(ttl)));

const opts = { subject: 'http://localhost:3000/stan/profile/card#me', base: 'http://localhost:3000/stan/health/claims.ttl', issuer: 'http://issuer:4300/', originalHash: 'sha256-abc', asOf };

describe('synthetic patients', () => {
  it('are deterministic per seed', () => {
    expect(syntheticPatient(42, asOf)).toEqual(syntheticPatient(42, asOf));
    expect(syntheticPatient(42, asOf)).not.toEqual(syntheticPatient(43, asOf));
  });
});

describe('FHIR → canonical Lake model', () => {
  it('extracts age band, medications, conditions and readmissions', () => {
    const claims = extractClaims(syntheticPatient(7, asOf), asOf);
    expect(claims.find((c) => c.field === 'age_band')?.value).toMatch(/^\d0-\d9$|^90\+$/);
    expect(claims.some((c) => c.field === 'medications')).toBe(true);
    expect(claims.some((c) => c.field === 'conditions')).toBe(true);
  });

  it('counts a stay within 30 days of the last discharge as a readmission', () => {
    const enc = (s: string, e: string) => ({ fullUrl: s, resource: { resourceType: 'Encounter', class: { code: 'IMP' }, period: { start: s, end: e } } });
    const bundle = { resourceType: 'Bundle' as const, type: 'collection', entry: [enc('2026-01-01', '2026-01-05'), enc('2026-01-20', '2026-01-22'), enc('2026-06-01', '2026-06-03')] };
    expect(extractClaims(bundle).filter((c) => c.field === 'readmissions')).toHaveLength(1);
  });

  it('passes the SHACL shapes, for 50 different people', async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const report = await validate(fhirToLake(syntheticPatient(seed, asOf), opts).turtle);
      expect(report.conforms, `seed ${seed}: ${report.results.map((r) => r.message).join('; ')}`).toBe(true);
    }
  });

  it('fails SHACL when provenance is missing', async () => {
    const { turtle } = fhirToLake(syntheticPatient(1, asOf), opts);
    const stripped = turtle.split('\n').filter((l) => !l.includes('originalHash')).join('\n');
    expect((await validate(stripped)).conforms).toBe(false);
  });
});
