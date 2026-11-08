import { describe, expect, it } from 'vitest';
import { deliversTo, makeWant, purchaseDraft, wantFit, wantProblems } from './want.js';

describe('wants (SPEC §6.8)', () => {
  const want = () => makeWant({ name: 'Handheld shower head', properties: { Type: 'Handheld', 'Spray modes': 3, Finish: 'Chrome' }, area: 'AU-QLD', currency: 'AUD', days: 7 });

  it('makes a schema.org Demand from words and properties, checked', () => {
    const w = want();
    expect(w).toMatchObject({ '@type': 'Demand', name: 'Handheld shower head', areaServed: 'AU-QLD', priceCurrency: 'AUD', itemOffered: { '@type': 'Product', additionalProperty: [{ '@type': 'PropertyValue', name: 'Type', value: 'Handheld' }, { name: 'Spray modes', value: '3' }, { name: 'Finish', value: 'Chrome' }] } });
    expect(w.id).toMatch(/^w-[0-9a-f]{8}$/);
    expect(wantProblems(w)).toEqual([]);
  });

  it('never carries a price, and stays within two weeks and a dozen properties', () => {
    expect(wantProblems({ ...want(), maxPrice: 40 })).toContain('a want never says what you would pay: keep that in your house');
    expect(wantProblems({ ...want(), availabilityEnds: new Date(Date.now() + 30 * 86_400_000).toISOString() }).join()).toMatch(/within 14 days/);
    expect(() => makeWant({ name: 'x'.repeat(81) })).toThrow(/name/);
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, 'v']));
    expect(() => makeWant({ name: 'Lamp', properties: many })).toThrow(/at most 12 properties/);
  });

  it('scores how well an item fits, and says which properties matched (under any name)', () => {
    const w = want();
    expect(wantFit(w, { label: 'Handheld shower head, 3 sprays, chrome', props: { Type: 'Handheld', 'Spray modes': '3', Finish: 'Chrome' } })).toEqual({ score: 1, matched: ['Type', 'Spray modes', 'Finish'] });
    // One shop's "Sprays" is the want's "Spray modes": the value counts wherever the item says it.
    expect(wantFit(w, { label: 'Handheld shower head', props: { Sprays: '3', Colour: 'Chrome' } }).matched).toEqual(['Type', 'Spray modes', 'Finish']);
    // A different number is not a match; a different thing scores nothing.
    expect(wantFit(w, { label: 'Handheld shower head', props: { Type: 'Handheld', 'Spray modes': '5', Finish: 'Chrome' } }).matched).toEqual(['Type', 'Finish']);
    expect(wantFit(w, { label: 'LED light bulb, E27' }).score).toBe(0);
  });

  it('reads values and areas as people write them (a real Claude, 8 Nov: "approx. 100 mm", "1 (single)", "Brisbane, AU-QLD")', () => {
    const w = makeWant({ name: 'Handheld shower head', properties: { 'Face diameter': 'approx. 100 mm', 'Spray modes': '1 (single)', Connection: '1/2 inch BSP (standard AU hose)' } });
    expect(wantFit(w, { label: 'Handheld shower head, single spray, chrome', props: { 'Spray modes': '1', Connection: '1/2 inch BSP', 'Face diameter': '100 mm' } }).matched).toEqual(['Face diameter', 'Spray modes', 'Connection']);
    expect(deliversTo('Brisbane, AU-QLD', ['AU'])).toBe(true);
    expect(deliversTo('Auckland, NZ', ['AU'])).toBe(false);
    expect(deliversTo('Brisbane', ['AU'])).toBe(true);
    expect(deliversTo(undefined, ['AU'])).toBe(true);
  });

  it('drafts a purchase for exactly one cart, its total, for the owner to sign', () => {
    const d = purchaseDraft('https://h.example/#house', { id: 'c1', merchant: 'Shop', total: { currency: 'AUD', value: 34 } }, new Date(Date.now() + 3_600_000));
    expect(d.credentialSubject).toMatchObject({ id: 'https://h.example/#house', study: 'urn:ap2:cart:c1', budget: { currency: 'AUD', amount: 34 } });
  });
});
