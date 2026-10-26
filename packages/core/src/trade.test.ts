import { describe, expect, it } from 'vitest';
import { buildCard, signCard } from './card.js';
import { generateIdentity } from './crypto.js';
import { cartHash, cartParty, cartTerms, checkCart, deliveryMisses, deliveryProblems, isParty, keyThumbprint, LAKE_PAYMENT_METHOD, menuHash, menuProblems, signCart } from './trade.js';

describe('trade: AP2 carts the seller signs', () => {
  const make = async (minutes = 30) => {
    const seller = await generateIdentity();
    const cart = await signCart({ seller, sellerWebId: 'https://poet.example/#agent', sellerName: 'Poet', buyerWebId: 'https://buyer.example/#agent', minutes, items: [{ label: 'A haiku', amount: { currency: 'USD', value: 2 } }, { label: 'Rush', amount: { currency: 'USD', value: 0.5 } }] });
    return { seller, cart };
  };

  it('is a W3C PaymentRequest whose lines add up, signed with the hash of its contents', async () => {
    const { seller, cart } = await make();
    expect(cart.contents.payment_request.details.total).toEqual({ label: 'Total', amount: { currency: 'USD', value: 2.5 } });
    expect(await checkCart(cart, seller.publicJwk)).toMatchObject({ seller: 'https://poet.example/#agent', buyer: 'https://buyer.example/#agent', total: { currency: 'USD', value: 2.5 }, hash: cartHash(cart.contents) });
  });

  it('is refused when changed after signing, signed by another key, or expired', async () => {
    const { seller, cart } = await make();
    const cheaper = structuredClone(cart);
    cheaper.contents.payment_request.details.total.amount.value = 0.01;
    cheaper.contents.payment_request.details.display_items = [{ label: 'A haiku', amount: { currency: 'USD', value: 0.01 } }];
    await expect(checkCart(cheaper, seller.publicJwk)).rejects.toThrow(/changed after the seller signed/);
    await expect(checkCart(cart, (await generateIdentity()).publicJwk)).rejects.toThrow(/signature/);
    await expect(checkCart(cart, seller.publicJwk, Date.now() + 31 * 60_000)).rejects.toThrow();
  });

  it('says which menu it was ordered from: the menu\'s digest and the sku, inside the signed contents (run 31)', async () => {
    const seller = await generateIdentity();
    const menu = [{ sku: 'haiku', label: 'A haiku', price: { currency: 'USD', value: 2 } }];
    const cart = await signCart({ seller, sellerWebId: 'https://poet.example/#agent', sellerName: 'Poet', buyerWebId: 'https://buyer.example/#agent', items: [{ label: '1 × A haiku', amount: { currency: 'USD', value: 2 } }], menu: { items: menu, sku: 'haiku' } });
    expect(cart.contents).toMatchObject({ lake_menu_sha256: menuHash(menu), lake_sku: 'haiku' });
    expect(menuHash(menu)).toMatch(/^[0-9a-f]{64}$/);
    expect(menuHash([{ ...menu[0]!, price: { currency: 'USD', value: 1 } }])).not.toBe(menuHash(menu));
    await checkCart(cart, seller.publicJwk);
    // Changing which menu it names breaks the seller's signature like any other change.
    const other = structuredClone(cart);
    other.contents.lake_menu_sha256 = menuHash([]);
    await expect(checkCart(other, seller.publicJwk)).rejects.toThrow(/changed after the seller signed/);
  });

  it('carries the seller\'s delivery terms, signed, and counts a delivery against them (run 36)', async () => {
    const seller = await generateIdentity();
    const delivery = { within_hours: 2, review_hours: 4, revisions: 1, words: { min: 90, max: 110 }, lines: { max: 12 } };
    const cart = await signCart({ seller, sellerWebId: 'https://poet.example/#agent', sellerName: 'Poet', buyerWebId: 'https://buyer.example/#agent', items: [{ label: 'A fact sheet', amount: { currency: 'USD', value: 3 } }], delivery });
    expect(await checkCart(cart, seller.publicJwk)).toMatchObject({ delivery });
    // Part of what the buyer pays for: changing a term breaks the seller's signature.
    const looser = structuredClone(cart);
    (looser.contents.payment_request.method_data[0]!.data as { delivery: { revisions: number } }).delivery.revisions = 5;
    await expect(checkCart(looser, seller.publicJwk)).rejects.toThrow(/changed after the seller signed/);
    // Counts, not quality: 124 words for a ~100-word sheet misses; a haiku in two lines misses a three-line term.
    expect(deliveryMisses(Array(124).fill('heron').join(' '), delivery)).toEqual(['124 words; the cart says 90 to 110']);
    expect(deliveryMisses(Array(100).fill('heron').join(' '), delivery)).toEqual([]);
    expect(deliveryMisses('an old pond\n\na frog jumps in', { lines: { min: 3, max: 3 } })).toEqual(['2 lines; the cart says 3 to 3']);
    expect(deliveryProblems({ revisions: 9, words: { min: 5, max: 2 }, speed: 'fast' })).toHaveLength(3);
    await expect(signCart({ seller, sellerWebId: 'a', sellerName: 'a', buyerWebId: 'b', items: [{ label: 'x', amount: { currency: 'USD', value: 1 } }], delivery: { within_hours: 0 } })).rejects.toThrow(/within_hours/);
  });

  it('holds one currency, and menus are checked before they go on a card', async () => {
    const seller = await generateIdentity();
    await expect(signCart({ seller, sellerWebId: 'a', sellerName: 'a', buyerWebId: 'b', items: [{ label: 'x', amount: { currency: 'USD', value: 1 } }, { label: 'y', amount: { currency: 'AUD', value: 1 } }] })).rejects.toThrow(/one currency/);
    expect(menuProblems([{ sku: 'haiku', label: 'A haiku', price: { currency: 'USD', value: 2 } }])).toEqual([]);
    expect(menuProblems([{ sku: 'Bad Sku', label: '', price: { currency: 'usd', value: 0.001 } }])).toHaveLength(3);
  });

  it('names, inside the signed contents, the payments agents and arbiters the seller accepts, pinned by key (SPEC §6.5)', async () => {
    // Two payments agents with the same name and WebID-shaped claims, on two Lakes: only the key tells them apart.
    const agent = async (url: string, domain: string) => {
      const id = await generateIdentity();
      const card = await signCard(buildCard({ name: 'Payments (demo)', description: 'x', url: `${url}/a2a`, skills: [{ id: 'payments', name: 'Payments', description: 'x' }], profile: { role: 'specialist', webId: `${url}/#payments`, ownerDomain: domain, tags: [] } }, id), id);
      return { id, card };
    };
    const a = await agent('http://lake-a.localhost:8081/s/payments', 'payments.lake.local');
    const b = await agent('http://lake-b.localhost:8082/s/payments', 'payments.lake.local');
    const arbiter = await agent('http://lake-b.localhost:8082/s/arbiter', 'arbiter.lake.local');
    const party = await cartParty(a.card);
    expect(party).toEqual({ url: 'http://lake-a.localhost:8081/s/payments/a2a', webId: 'http://lake-a.localhost:8081/s/payments/#payments', jkt: await keyThumbprint(a.id.publicJwk) });
    const seller = await generateIdentity();
    const cart = await signCart({ seller, sellerWebId: 'https://poet.example/#agent', sellerName: 'Poet', buyerWebId: 'https://buyer.example/#agent', items: [{ label: 'A haiku', amount: { currency: 'USD', value: 2 } }], payments: [await cartParty(b.card), party], arbiters: [await cartParty(arbiter.card)] });
    // A W3C PaymentRequest's method data, method-specific: the Lake method's names who settles.
    expect(cart.contents.payment_request.method_data).toEqual([{ supported_methods: LAKE_PAYMENT_METHOD, data: { payments: [await cartParty(b.card), party], arbiters: [await cartParty(arbiter.card)] } }]);
    const checked = await checkCart(cart, seller.publicJwk);
    expect(checked.payments.map((x) => x.url)).toEqual(['http://lake-b.localhost:8082/s/payments/a2a', 'http://lake-a.localhost:8081/s/payments/a2a']);
    expect(checked.arbiters).toHaveLength(1);
    expect(await isParty({ webId: party.webId, publicJwk: a.id.publicJwk }, checked.payments)).toBe(true);
    // The same WebID with another key (a forger, or another Lake's agent of the same name) is not a party.
    expect(await isParty({ webId: party.webId, publicJwk: (await generateIdentity()).publicJwk }, checked.payments)).toBe(false);
    expect(await isParty({ webId: party.webId, publicJwk: a.id.publicJwk }, checked.arbiters)).toBe(false);
    // Changing whom the cart names breaks the seller's signature: the terms are part of what the buyer pays.
    const swapped = structuredClone(cart);
    (swapped.contents.payment_request.method_data[0]!.data as { payments: unknown[] }).payments = [party];
    await expect(checkCart(swapped, seller.publicJwk)).rejects.toThrow(/changed after the seller signed/);
    // A cart that names nobody (every cart before this) still checks, and names nobody.
    const { seller: s2, cart: plain } = await make();
    expect(cartTerms(plain.contents)).toEqual({ payments: [], arbiters: [] });
    expect(await checkCart(plain, s2.publicJwk)).toMatchObject({ payments: [], arbiters: [] });
    await expect(signCart({ seller, sellerWebId: 'a', sellerName: 'a', buyerWebId: 'b', items: [{ label: 'x', amount: { currency: 'USD', value: 1 } }], payments: [{ url: 'ftp://x', webId: 'w', jkt: 'short' }] })).rejects.toThrow(/payments: each/);
  });
});
