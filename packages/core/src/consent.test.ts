import { describe, expect, it } from 'vitest';
import { consentRecord, readConsentRecord, withdrawConsent } from './consent.js';

describe('consent records (ISO/IEC TS 27560 in DPV terms)', () => {
  const record = consentRecord({
    id: 'offer-1', owner: 'https://pod.example/stan/profile/card#me', visitor: { webId: 'https://uni.example/#agent', domain: 'uni.example' },
    purpose: 'research', dpvPurpose: 'dpv:ResearchAndDevelopment', fields: ['age_band', 'medications'], retention: 'none', until: '2026-10-27T00:00:00Z',
    method: { live: true }, agreement: 'urn:uuid:a1', given: '2026-10-25T10:00:00Z',
  });

  it('says whose data, for whom, for what, how long, and how it was given', () => {
    expect(record).toMatchObject({
      'dct:identifier': 'offer-1', 'dpv:hasDataSubject': 'https://pod.example/stan/profile/card#me', 'dct:valid': '2026-10-25T10:00:00Z/2026-10-27T00:00:00Z',
      'dpv:hasProcess': { 'dpv:hasPurpose': 'dpv:ResearchAndDevelopment', 'dpv:hasProcessing': ['dpv:Use'], 'dpv:hasDataController': { '@id': 'https://uni.example/#agent' } },
      'dpv:hasConsentStatus': [{ '@type': 'dpv:ConsentGiven', 'dpv:hasIndicationMethod': 'urn:lake:consent:live' }],
    });
  });

  it('keeps its history when the owner withdraws, once', () => {
    const w = withdrawConsent(record, '2026-10-26T09:00:00Z');
    expect((w['dpv:hasConsentStatus'] as { '@type': string }[]).map((x) => x['@type'])).toEqual(['dpv:ConsentGiven', 'dpv:ConsentWithdrawn']);
    expect(withdrawConsent(w, '2026-10-26T10:00:00Z')).toBe(w);
  });

  it('reads back as the owner sees it: who, what, why, how, until when, and when it was taken back', () => {
    expect(readConsentRecord(record)).toEqual({
      id: 'offer-1', visitor: { webId: 'https://uni.example/#agent', domain: 'uni.example' }, purposes: ['research'], fields: ['age_band', 'medications'],
      retention: 'none', given: '2026-10-25T10:00:00Z', until: '2026-10-27T00:00:00Z', method: { live: true }, agreement: 'urn:uuid:a1',
    });
    expect(readConsentRecord(withdrawConsent(record, '2026-10-26T09:00:00Z'))?.withdrawn).toBe('2026-10-26T09:00:00Z');
    // A standing rule's number, a purpose DPV doesn't name, one two Lake purposes share, and kept data.
    const byRule = readConsentRecord(consentRecord({
      id: 'offer-2', owner: 'o', visitor: { webId: 'https://gp.example/#agent', domain: 'gp.example' }, purpose: 'care', dpvPurpose: 'dpv:ServiceProvision', fields: ['medications'],
      retention: 'P30D', until: '2026-10-27T00:00:00Z', method: { standingRule: 3, rulesDigest: 'sha256-x' }, agreement: 'urn:uuid:a2', given: '2026-10-25T10:00:00Z',
    }))!;
    expect(byRule).toMatchObject({ method: { standingRule: 3 }, purposes: ['care', 'service'], retention: 'P30D' });
    expect(readConsentRecord(consentRecord({ id: 'x', owner: 'o', visitor: { webId: 'w', domain: 'd' }, purpose: 'insurance', fields: [], retention: 'none', until: '', method: { live: true }, agreement: '', given: '' }))!.purposes).toEqual(['insurance']);
    expect(readConsentRecord({ '@type': 'Something' })).toBeNull();
  });
});
