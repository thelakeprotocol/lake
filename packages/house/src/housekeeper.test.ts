import { describe, expect, it } from 'vitest';
import { otherLabels } from './housekeeper.js';

describe('trying labels (house manners, SPEC §5)', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const asked = [
    { purpose: 'research', fields: ['conditions', 'age_band'], at: now - 10 * 60_000 },
    { purpose: 'care', fields: ['conditions'], at: now - 5 * 60_000 },
    { purpose: 'marketing', fields: ['postcode'], at: now - 60_000 },
    { purpose: 'advertising', fields: ['conditions'], at: now - 2 * 3_600_000 },
  ];

  it('names the other purposes given for any of the same fields within the hour', () => {
    expect(otherLabels(asked, 'insurance', ['conditions', 'medications'], now)).toEqual(['research', 'care']);
  });

  it('ignores the same purpose, other data, and anything older than an hour', () => {
    expect(otherLabels(asked, 'research', ['conditions'], now)).toEqual(['care']);
    expect(otherLabels(asked, 'insurance', ['medications'], now)).toEqual([]);
  });
});
