import { describe, expect, it } from 'vitest';
import { consentRecord, withdrawConsent } from './consent.js';

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
});
