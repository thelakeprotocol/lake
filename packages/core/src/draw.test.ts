import { describe, expect, it } from 'vitest';
import { order, pick, QUICKNET, roundAfter, roundTimeMs, sealUntil, verifyBeacon } from './index.js';

// A real quicknet round, as drand published it: checked offline against the pinned key.
const round1m = { chain: QUICKNET.hash, round: 1_000_000, randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3', signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72' };

describe('fair draws (drand)', () => {
  it('accepts a real round and refuses any change to it', async () => {
    expect(await verifyBeacon(round1m)).toBe(true);
    expect(await verifyBeacon({ ...round1m, round: 1_000_001 })).toBe(false);
    expect(await verifyBeacon({ ...round1m, randomness: round1m.randomness.replace(/^b/, 'c') })).toBe(false);
    expect(await verifyBeacon({ ...round1m, chain: 'another-chain' })).toBe(false);
  });

  it('proposes a round that is not out yet, and knows when it comes', () => {
    const now = Date.now();
    const r = roundAfter(15_000, now);
    expect(roundTimeMs(r)).toBeGreaterThanOrEqual(now + 15_000);
    expect(roundTimeMs(r) - now).toBeLessThan(15_000 + 2 * QUICKNET.period * 1000);
  });

  it('picks the same for everyone, a different pick per label, and evenly', () => {
    expect(pick(round1m.randomness, 'coinflip:g1', 2)).toBe(pick(round1m.randomness, 'coinflip:g1', 2));
    const seen = new Array(6).fill(0);
    for (let i = 0; i < 6000; i++) seen[pick(round1m.randomness, `die:${i}`, 6)]++;
    expect(Math.min(...seen)).toBeGreaterThan(850);
    expect(Math.max(...seen)).toBeLessThan(1150);
  });

  it('draws a whole order, its first place the single draw\'s result (run 69)', () => {
    const cousins = ['Ella', 'Sam', 'Noor'];
    const o = order(round1m.randomness, 'gran-rose:draft', cousins);
    expect([...o].sort()).toEqual([...cousins].sort());
    expect(o[0]).toBe(cousins[pick(round1m.randomness, 'gran-rose:draft', 3)]);
    expect(order(round1m.randomness, 'gran-rose:draft', cousins)).toEqual(o);
    // Every order turns up, evenly enough.
    const seen = new Map<string, number>();
    for (let i = 0; i < 6000; i++) { const k = order(round1m.randomness, `d:${i}`, cousins).join(); seen.set(k, (seen.get(k) ?? 0) + 1); }
    expect(seen.size).toBe(6);
    for (const n of seen.values()) expect(n).toBeGreaterThan(850);
  });

  it('seals only to a round still to come (a seal to a past round would open at once)', async () => {
    await expect(sealUntil(1_000_000, 'bid 7')).rejects.toThrow('already out');
  });
});
