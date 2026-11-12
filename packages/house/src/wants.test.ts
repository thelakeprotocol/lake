import { describe, expect, it } from 'vitest';
import type { CartMandate, Want } from '@thelakeprotocol/core';
import { openWants, type WantOfferRecord, type WantRecord } from './wants.js';

const want = (id: string, days = 7): Want => ({ id, name: 'Handheld shower head', availabilityEnds: new Date(Date.now() + days * 86_400_000).toISOString(), itemOffered: { additionalProperty: [] } } as unknown as Want);
const offer = (id: string, shop: string, state: WantOfferRecord['state'], hold?: string): WantOfferRecord => ({
  id, at: new Date().toISOString(), seller: { name: shop, webId: `https://${shop}.example/#agent`, url: `https://${shop}.example/a2a`, domain: `${shop}.example` },
  cart: { contents: { id: `cart-${id}` } } as unknown as CartMandate, total: { currency: 'AUD', value: 34 }, items: [], expires: new Date(Date.now() + 3_600_000).toISOString(), state, ...(hold ? { hold } : {}),
});
const open = async (list: WantRecord[]) => { let saved: WantRecord[] = []; const w = await openWants({ load: async () => list, save: async (l) => { saved = JSON.parse(JSON.stringify(l)); } }); return { w, saved: () => saved }; };

describe('how a bought want ends at the payments agent', () => {
  it('a refund opens the want again, and the shop is told its offer was refunded', async () => {
    const { w, saved } = await open([{ want: want('w1'), offers: [offer('o1', 'washer', 'shipped', 'hold-1'), offer('o2', 'tapworks', 'open')], bought: 'o1', at: new Date().toISOString() }]);
    expect(w.open()).toHaveLength(0);
    const r = await w.settled('hold-1', 'voided', 'the seller refunded it');
    expect(r).toMatchObject({ open: true, offer: { id: 'o1', state: 'refunded', ended: 'the seller refunded it' } });
    expect(w.open().map((x) => x.id)).toEqual(['w1']);
    expect(saved()[0]).toMatchObject({ offers: [{ state: 'refunded' }, { state: 'open' }] });
    expect(saved()[0]!.bought).toBeUndefined();
    expect(w.statusFor('w1', 'https://washer.example/#agent')).toMatchObject({ state: 'refunded', says: expect.stringMatching(/went back to the buyer \(the seller refunded it\)/) });
    // The other shop's offer is still there to buy, and says nothing of the refund.
    expect(w.statusFor('w1', 'https://tapworks.example/#agent')).toMatchObject({ state: 'open' });
    // Said again (the payments agent sends it until it's heard): nothing more happens.
    expect(await w.settled('hold-1', 'voided', 'the seller refunded it')).toBeNull();
  });

  it('money released without the owner\'s tap marks it arrived, with why', async () => {
    const { w } = await open([{ want: want('w1'), offers: [offer('o1', 'washer', 'shipped', 'hold-1')], bought: 'o1', at: new Date().toISOString() }]);
    expect(await w.settled('hold-1', 'captured', 'its time ran out with no dispute')).toMatchObject({ open: false, offer: { state: 'arrived', ended: 'its time ran out with no dispute' } });
    expect(w.find('w1')!.bought).toBe('o1');
    // The owner's own "it arrived" already said so: a release that comes after changes nothing.
    expect(await w.settled('hold-1', 'captured', 'the buyer accepted')).toBeNull();
  });

  it('a hold that is no offer\'s is nobody\'s, and a refund past the want\'s date leaves it closed', async () => {
    const { w } = await open([{ want: want('w1', -1), offers: [offer('o1', 'washer', 'paid', 'hold-1')], bought: 'o1', at: new Date().toISOString() }]);
    expect(await w.settled('hold-9', 'voided', 'x')).toBeNull();
    expect(await w.settled('hold-1', 'voided', 'nothing was delivered in time')).toMatchObject({ open: false, offer: { state: 'refunded' } });
    expect(w.open()).toHaveLength(0);
  });
});
