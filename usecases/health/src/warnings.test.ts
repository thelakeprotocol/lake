import { offerWarnings, registerPack } from '@thelakeprotocol/core';
import { describe, expect, it } from 'vitest';
import health from './index.js';

registerPack(health);

describe('what an owner should look at twice', () => {
  it('flags identifying fields, fields nobody defines, and keeping data for decades', () => {
    const w = offerWarnings({ fields: ['age_band', 'medications', 'name', 'dob', 'full_name'], retention: 'P99Y' });
    expect(w).toEqual(['asks for fields that identify you: name, dob', 'asks for fields no use case here defines: full name', 'wants to keep your data for 99 years']);
  });

  it('says nothing about an ordinary ask', () => {
    expect(offerWarnings({ fields: ['age_band', 'medications'], retention: 'none' })).toEqual([]);
    expect(offerWarnings({ fields: ['age_band'], retention: 'P30D' })).toEqual([]);
  });

  it('flags health data asked for to make decisions about you, like an insurer pricing you', () => {
    expect(offerWarnings({ fields: ['age_band', 'medications'], retention: 'none', purpose: 'insurance' })).toEqual(['asks for sensitive data (medications) to make decisions about you (insurance)']);
    // The same data for research, or non-sensitive data for insurance: no such warning.
    expect(offerWarnings({ fields: ['medications'], retention: 'none', purpose: 'research' })).toEqual([]);
    expect(offerWarnings({ fields: ['age_band'], retention: 'none', purpose: 'insurance' })).toEqual([]);
  });
});
