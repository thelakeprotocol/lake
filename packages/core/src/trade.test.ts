import { describe, expect, it } from 'vitest';
import { generateIdentity } from './crypto.js';
import { cartHash, checkCart, menuProblems, signCart } from './trade.js';

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
});
