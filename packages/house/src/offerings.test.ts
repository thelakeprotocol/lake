import { describe, expect, it } from 'vitest';
import { openOfferings, type OfferingRecord } from './offerings.js';

describe('offerings in the pod (SPEC §6.9)', () => {
  const open = async () => { let saved: OfferingRecord[] = []; const g = await openOfferings({ load: async () => [], save: async (l) => { saved = JSON.parse(JSON.stringify(l)); } }); return { g, saved: () => saved }; };
  it('lists open ones, five at most, closes one, and a released house keeps none of the last owner\'s (round 112)', async () => {
    const { g, saved } = await open();
    const first = await g.post({ name: 'Kids bike', price: 60, currency: 'AUD', tag: 'bike' }, 'ai-1');
    for (let i = 0; i < 4; i++) await g.post({ name: `Thing ${i}` });
    await expect(g.post({ name: 'One more' })).rejects.toThrow(/at most 5/);
    expect(g.live(first.id)).toBe(true);
    expect(await g.close(first.id)).toBe(true);
    expect(g.live(first.id)).toBe(false);
    expect(g.open()).toHaveLength(4);
    await g.reset();
    expect(g.open()).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(saved()).toEqual([]);
  });
});
