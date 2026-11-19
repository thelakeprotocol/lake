import { describe, expect, it } from 'vitest';
import type { CartMandate, LakeProfile, Want } from '@thelakeprotocol/core';
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

  it('a problem the owner reports holds the money and tells the shop; sending it again answers it', async () => {
    const { w, saved } = await open([{ want: want('w1'), offers: [offer('o1', 'washer', 'paid', 'hold-1')], bought: 'o1', at: new Date().toISOString() }]);
    const washer = { webId: 'https://washer.example/#agent' } as LakeProfile;
    const sent: { url: string; payload: Record<string, any> }[] = [];
    const x = { payments: 'https://pay.example/a2a', send: async (url: string, payload: Record<string, unknown>) => { sent.push({ url, payload }); return { payload: { kind: payload.kind === 'dispute' ? 'disputed' : payload.kind === 'capture' ? 'captured' : 'received' } }; } };
    // Not before the shop said it sent it: money for something never sent comes back by itself.
    expect(await w.problem('w1', 'not_arrived', x)).toMatchObject({ error: expect.stringMatching(/hasn't said it sent it yet/) });
    expect(await w.shippedIn({ want: 'w1', note: 'Posted. Tracking 1', sha256: 'a'.repeat(64) }, washer)).toMatchObject({ ok: true, again: false, newer: false });
    // The owner's reason is a choice, never their words.
    expect(await w.problem('w1', 'the box was wet', x)).toMatchObject({ error: 'problem: one of not_arrived, not_right' });
    expect(sent).toHaveLength(0);
    expect(await w.problem('w1', 'not_arrived', x)).toMatchObject({ ok: true, offer: { problem: { code: 'not_arrived', held: true } } });
    // Disputed as not as described, naming the note: "not received" would be ruled against, since the note did arrive.
    expect(sent[0]).toEqual({ url: 'https://pay.example/a2a', payload: { kind: 'dispute', hold: 'hold-1', sha256: 'a'.repeat(64), code: 'not_as_described' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[1]).toMatchObject({ url: 'https://washer.example/a2a', payload: { kind: 'want.problem', want: 'w1', cart: 'cart-o1', hold: 'hold-1', problem: 'not_arrived', held: true, at: saved()[0]!.offers[0]!.problem!.at } });
    expect(w.statusFor('w1', washer.webId)).toMatchObject({ state: 'problem', problem: 'not_arrived', says: expect.stringMatching(/hasn't arrived.*send it again.*or refund it/) });
    // Once: the shop knows, and the money is held already.
    expect(await w.problem('w1', 'not_right', x)).toMatchObject({ error: expect.stringMatching(/you told washer already/) });
    // The same note again answers nothing; a new one does, and the owner's time starts again.
    expect(await w.shippedIn({ want: 'w1', note: 'Posted. Tracking 1', sha256: 'a'.repeat(64) }, washer)).toMatchObject({ ok: false, why: expect.stringMatching(/new note/) });
    expect(await w.shippedIn({ want: 'w1', note: 'Sent again. Tracking 2', sha256: 'b'.repeat(64) }, washer)).toMatchObject({ ok: true, again: true, newer: false });
    expect(saved()[0]!.offers[0]).toMatchObject({ state: 'shipped', shipped: { note: 'Sent again. Tracking 2', sha256: 'b'.repeat(64), again: true, notes: 2 } });
    expect(saved()[0]!.offers[0]!.problem).toBeUndefined();
    expect(w.statusFor('w1', washer.webId)).toMatchObject({ state: 'shipped' });
    // A second problem, and the owner finds it after all: the latest note is the one accepted.
    expect(await w.problem('w1', 'not_right', x)).toMatchObject({ ok: true });
    expect(await w.arrived('w1', x)).toMatchObject({ ok: true, offer: { state: 'arrived' } });
    expect(sent.filter((s) => s.url === x.payments).at(-1)!.payload).toEqual({ kind: 'capture', hold: 'hold-1', sha256: 'b'.repeat(64) });
    expect(saved()[0]!.offers[0]!.problem).toBeUndefined();
    expect(await w.problem('w1', 'not_arrived', x)).toMatchObject({ error: 'washer is paid already for this one' });
  });

  // Round 104, an attacker: a shop filed a new delivery straight with the payments agent, ending the dispute unseen.
  it('a new delivery filed without a note while a problem stands is disputed again, and the shop told; an honest one is left alone', async () => {
    const { w, saved } = await open([{ want: want('w1'), offers: [offer('o1', 'washer', 'paid', 'hold-1')], bought: 'o1', at: new Date().toISOString() }]);
    const washer = { webId: 'https://washer.example/#agent' } as LakeProfile;
    const sent: { url: string; payload: Record<string, any> }[] = [];
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const x = { payments: 'https://pay.example/a2a', send: async (url: string, payload: Record<string, unknown>) => { sent.push({ url, payload }); return { payload: { kind: payload.kind === 'dispute' ? 'disputed' : 'ok', until } }; } };
    await w.shippedIn({ want: 'w1', note: 'Posted', sha256: 'a'.repeat(64) }, washer);
    // Nothing to do with no problem standing, or for the note the house already has.
    expect(await w.revised('hold-1', 'c'.repeat(64), x)).toBeNull();
    await w.problem('w1', 'not_right', x);
    expect(saved()[0]!.offers[0]!.problem).toMatchObject({ held: true, until });
    expect(await w.revised('hold-1', 'a'.repeat(64), x)).toBeNull();
    sent.length = 0;
    expect(await w.revised('hold-1', 'c'.repeat(64), x)).toMatchObject({ offer: { problem: { code: 'not_right', held: true } } });
    expect(sent[0]).toEqual({ url: 'https://pay.example/a2a', payload: { kind: 'dispute', hold: 'hold-1', sha256: 'c'.repeat(64), code: 'not_as_described' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[1]).toMatchObject({ url: 'https://washer.example/a2a', payload: { kind: 'want.problem', problem: 'not_right', held: true, until } });
    // "It arrived" now names the latest delivery.
    expect(saved()[0]!.offers[0]!.shipped!.sha256).toBe('c'.repeat(64));
    // An honest shop sends its note: the problem is answered, and a late word about that delivery changes nothing.
    expect(await w.shippedIn({ want: 'w1', note: 'Sent again', sha256: 'd'.repeat(64) }, washer)).toMatchObject({ ok: true, again: true });
    expect(await w.revised('hold-1', 'd'.repeat(64), x)).toBeNull();
  });

  it('a newer dispatch note is kept as the latest, the same one twice is one, and six is the most', async () => {
    const { w, saved } = await open([{ want: want('w1'), offers: [offer('o1', 'washer', 'paid', 'hold-1')], bought: 'o1', at: new Date().toISOString() }]);
    const washer = { webId: 'https://washer.example/#agent' } as LakeProfile;
    const sha = (n: number) => String(n).repeat(64);
    expect(await w.shippedIn({ want: 'w1', note: 'Posted.', sha256: sha(1) }, washer)).toMatchObject({ ok: true, newer: false });
    expect(await w.shippedIn({ want: 'w1', note: 'Posted.', sha256: sha(1) }, washer)).toMatchObject({ ok: true, same: true });
    expect(await w.shippedIn({ want: 'w1', note: 'Posted. Tracking 77', sha256: sha(2) }, washer)).toMatchObject({ ok: true, newer: true, again: false });
    expect(saved()[0]!.offers[0]!.shipped).toMatchObject({ note: 'Posted. Tracking 77', sha256: sha(2), notes: 2 });
    for (const n of [3, 4, 5, 6]) expect(await w.shippedIn({ want: 'w1', note: `Note ${n}`, sha256: sha(n) }, washer)).toMatchObject({ ok: true });
    expect(await w.shippedIn({ want: 'w1', note: 'Note 7', sha256: sha(7) }, washer)).toMatchObject({ ok: false, why: expect.stringMatching(/6 dispatch notes already/) });
    // Another shop's word about this purchase is nobody's.
    expect(await w.shippedIn({ want: 'w1', note: 'Mine', sha256: sha(8) }, { webId: 'https://tapworks.example/#agent' } as LakeProfile)).toMatchObject({ ok: false });
  });

  it('a hold that is no offer\'s is nobody\'s, and a refund past the want\'s date leaves it closed', async () => {
    const { w } = await open([{ want: want('w1', -1), offers: [offer('o1', 'washer', 'paid', 'hold-1')], bought: 'o1', at: new Date().toISOString() }]);
    expect(await w.settled('hold-9', 'voided', 'x')).toBeNull();
    expect(await w.settled('hold-1', 'voided', 'nothing was delivered in time')).toMatchObject({ open: false, offer: { state: 'refunded' } });
    expect(w.open()).toHaveLength(0);
  });
});

describe('a shop hears when its offer ended unbought (SPEC §6.8 want.ended)', () => {
  it('tells each open offer once on a purchase or a close, never the one bought, nor who or why', async () => {
    const { w } = await open([{ want: want('w1'), offers: [offer('o1', 'washer', 'open'), offer('o2', 'tapworks', 'open')], at: new Date().toISOString() }, { want: want('w2'), offers: [offer('o3', 'washer', 'open')], at: new Date().toISOString() }]);
    expect(w.endedUntold()).toEqual([]);
    w.find('w1')!.bought = 'o1'; w.find('w1')!.offers[0]!.state = 'paid';
    const told = w.endedUntold();
    expect(told).toEqual([{ url: 'https://tapworks.example/a2a', payload: { kind: 'want.ended', want: 'w1', offer: 'o2', cart: 'cart-o2', state: 'not_bought', want_open: false, at: expect.any(String) } }]);
    // Nothing of the one bought (its shop, its offer, its price); the time is left out, as 10:34 holds a 34.
    const { at: _at, ...said } = told[0]!.payload;
    expect(JSON.stringify(said)).not.toMatch(/washer|"o1"|34/);
    expect(w.endedUntold()).toEqual([]);
    await w.close('w2');
    expect(w.endedUntold()).toMatchObject([{ payload: { offer: 'o3', state: 'closed' } }]);
  });

  it('a cart that ran out while the want is open is told as expired, and offers that ended before are not told at all', async () => {
    const stale = { ...offer('o1', 'washer', 'open'), expires: new Date(Date.now() - 60_000).toISOString() };
    const { w } = await open([{ want: want('w1'), offers: [offer('o2', 'tapworks', 'open')], closed: new Date().toISOString(), at: new Date().toISOString() }, { want: want('w3'), offers: [offer('o4', 'pipes', 'open')], at: new Date().toISOString() }]);
    expect(w.endedUntold()).toEqual([]);
    w.find('w3')!.offers.push(stale);
    expect(w.endedUntold()).toMatchObject([{ payload: { offer: 'o1', state: 'expired', want_open: true } }]);
  });
});

describe('people who match a want for someone\'s help (SPEC §6.8)', () => {
  const service = (id: string): Want => ({ '@type': 'Demand', id, name: 'Help on Friday evening', availabilityEnds: new Date(Date.now() + 7 * 86_400_000).toISOString(), itemOffered: { '@type': 'Service', name: 'Help', additionalProperty: [{ '@type': 'PropertyValue', name: 'When', value: 'Friday 6-11pm' }, { '@type': 'PropertyValue', name: 'Where', value: 'AU-QLD' }, { '@type': 'PropertyValue', name: 'First aid', value: 'yes' }] } } as Want);
  const house = (name: string) => ({ profile: { webId: `https://${name}.example/#house`, ownerDomain: `${name}.example` } as LakeProfile, card: { name: `${name}'s house`, supportedInterfaces: [{ url: `https://${name}.example/a2a` }] } as never });

  it('keeps only the want\'s own points, one open match a house, and nothing for a want for a thing', async () => {
    const { w, saved } = await open([{ want: service('w1'), offers: [], at: new Date().toISOString() }, { want: want('w2'), offers: [], at: new Date().toISOString() }]);
    const jo = house('jo');
    const r = await w.matchIn({ want: 'w1', matched: ['when', 'First aid', 'Loves dogs'] }, jo.profile, jo.card);
    expect(r).toMatchObject({ ok: true, match: { matched: ['When', 'First aid'], state: 'open', matcher: { name: "jo's house" } }, dropped: ['Loves dogs'] });
    // None of its points: refused, saying which there are.
    expect(await w.matchIn({ want: 'w1', matched: ['Loves dogs'] }, jo.profile, jo.card)).toMatchObject({ ok: false, why: expect.stringContaining('When, Where, First aid') });
    // The same house again replaces its open match.
    const again = await w.matchIn({ want: 'w1', matched: ['When', 'Where', 'First aid'] }, jo.profile, jo.card);
    expect(again).toMatchObject({ ok: true, replaced: (r as { match: { id: string } }).match.id });
    expect(saved()[0]!.matches).toHaveLength(1);
    // A want for a thing takes carts, not matches; a want for help takes no carts.
    expect(await w.matchIn({ want: 'w2', matched: ['When'] }, jo.profile, jo.card)).toMatchObject({ ok: false, why: expect.stringContaining('a shop offers a cart') });
    expect(await w.offerIn({ want: 'w1' }, jo.profile, jo.card, 'https://me.example/#house')).toMatchObject({ ok: false, why: expect.stringContaining('someone who matches') });
    // The owner's answer is kept with it.
    expect(await w.setMatch('w1', (again as { match: { id: string } }).match.id, { state: 'no' })).toMatchObject({ state: 'no' });
    // Set aside stays set aside: the same house sending again changes nothing and isn't told why.
    const third = await w.matchIn({ want: 'w1', matched: ['When'] }, jo.profile, jo.card);
    expect(third).toMatchObject({ ok: true, quiet: true, match: { state: 'no' } });
    expect(saved()[0]!.matches).toHaveLength(1);
    // A closed want takes no more.
    await w.close('w1');
    expect(await w.matchIn({ want: 'w1', matched: ['When'] }, house('sam').profile, house('sam').card)).toMatchObject({ ok: false, why: expect.stringContaining('no longer open') });
  });
});
