import { offerNotes, offerWarnings, registerPack } from '@thelakeprotocol/core';
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
    // The same data for a certified study (only a total leaves), or non-sensitive data for insurance: no such warning.
    expect(offerWarnings({ fields: ['medications'], retention: 'none', purpose: 'research', certifiedStudy: true })).toEqual([]);
    expect(offerWarnings({ fields: ['age_band'], retention: 'none', purpose: 'insurance' })).toEqual([]);
  });

  it('flags health data asked for outside a certified study, whatever the purpose says (run 28\'s made-up carer)', () => {
    expect(offerWarnings({ fields: ['conditions'], retention: 'none', purpose: 'care' })).toEqual([
      'asks for sensitive data (conditions) for care (someone looking after you), outside any certified study, from a sender whose identity isn\'t verified: allowing it lets this agent use your own conditions, not a total',
    ]);
    // "Research" with no certified study is no study: the same warning.
    expect(offerWarnings({ fields: ['age_band', 'medications'], retention: 'none', purpose: 'research' })).toEqual([expect.stringContaining('sensitive data (medications) for research (academic or commercial), outside any certified study')]);
    // A verified sender (a real GP, its domain proved) gets a calm note, not a red warning: real care shouldn't look like a threat.
    expect(offerWarnings({ fields: ['medications'], retention: 'none', purpose: 'care', askerVerified: true })).toEqual([]);
    expect(offerNotes({ fields: ['medications'], purpose: 'care', askerVerified: true })).toEqual(['includes medications, for care (someone looking after you), from a verified sender: yours to share or not']);
    // Asked to decide about you, it stays red even from a verified sender.
    expect(offerWarnings({ fields: ['conditions'], retention: 'none', purpose: 'insurance', askerVerified: true })[0]).toMatch(/to make decisions about you/);
    expect(offerWarnings({ fields: ['age_band'], retention: 'none', purpose: 'care' })).toEqual([]);
  });
});
