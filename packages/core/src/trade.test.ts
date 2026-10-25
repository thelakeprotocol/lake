import { describe, expect, it } from 'vitest';
import { buildCard, signCard } from './card.js';
import { generateIdentity } from './crypto.js';
import { cartHash, cartParty, cartTerms, checkCart, isParty, keyThumbprint, LAKE_PAYMENT_METHOD, menuProblems, signCart } from './trade.js';

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
