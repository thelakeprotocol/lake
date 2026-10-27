import { describe, expect, it } from 'vitest';
import { availabilityProblems, freeSlots, parseRules, parseWindow } from './index.js';

describe('availability: when the owner is free, and the slots it leaves (SPEC §9.0)', () => {
  it('reads windows people write', () => {
    expect(parseWindow('mon-fri 09:00-12:00')).toEqual({ days: [1, 2, 3, 4, 5], from: 540, to: 720 });
    expect(parseWindow('sat,sun 10:00-11:30')).toEqual({ days: [0, 6], from: 600, to: 690 });
    expect(parseWindow('fri-mon 08:00-09:00')).toEqual({ days: [0, 1, 5, 6], from: 480, to: 540 });
    expect(parseWindow('mornings')).toMatch(/write it like/);
    expect(availabilityProblems({ tz: 'Mars/Olympus', free: ['mon 09:00-10:00'] })).toEqual([expect.stringMatching(/^availability.tz/)]);
    expect(() => parseRules('owner: x\navailability: { tz: Australia/Sydney, free: ["mon-fri 9-12"] }\n')).toThrow(/write it like/);
    expect(parseRules('owner: x\navailability: { tz: Australia/Sydney, free: ["mon-fri 09:00-12:00"] }\n').availability?.tz).toBe('Australia/Sydney');
  });

  it('cuts windows into meetings in the owner\'s own zone, around what is already agreed', () => {
    // Tuesday 3 Nov 2026, 08:00 in Sydney (UTC+11): the morning's three slots, less the 10:00 coffee already in the agenda.
    const from = new Date('2026-11-02T21:00:00Z');
    const slots = freeSlots({ tz: 'Australia/Sydney', free: ['mon-fri 09:00-12:00'] }, [{ start: '2026-11-02T23:00:00Z' }], from, 1);
    expect(slots).toEqual([{ start: '2026-11-02T22:00:00.000Z', end: '2026-11-02T23:00:00.000Z' }, { start: '2026-11-03T00:00:00.000Z', end: '2026-11-03T01:00:00.000Z' }]);
    // Half-hour meetings, and nothing in the past.
    expect(freeSlots({ tz: 'Australia/Sydney', free: ['mon-fri 09:00-10:00'], meetings: 30 }, [], new Date('2026-11-02T22:10:00Z'), 1)).toEqual([{ start: '2026-11-02T22:30:00.000Z', end: '2026-11-02T23:00:00.000Z' }]);
  });

  it('keeps wall-clock times across a change of clocks', () => {
    // Sydney moves to daylight time on Sunday 4 Oct 2026: 09:00 is 23:00Z the day before, then 22:00Z.
    const slots = freeSlots({ tz: 'Australia/Sydney', free: ['sat,sun,mon 09:00-10:00'] }, [], new Date('2026-10-02T12:00:00Z'), 4);
    expect(slots.map((s) => s.start)).toEqual(['2026-10-02T23:00:00.000Z', '2026-10-03T22:00:00.000Z', '2026-10-04T22:00:00.000Z']);
  });
});
