import { createHash, randomUUID } from 'node:crypto';
import * as jose from 'jose';
import { canonicalize } from './canonical.js';
import type { Identity } from './crypto.js';

/**
 * Agents trading with agents (SPEC §6.5), on AP2's own commerce objects rather than shapes of our own: a seller lists
 * what it sells on its signed card (a menu), a buyer orders, and the seller answers with an AP2 CartMandate: the cart's
 * contents (a W3C PaymentRequest: items, total, currency), signed by the seller as a short-lived JWT carrying the
 * hash of those contents. The buyer pays that cart under its own allowance; the payments agent checks the seller's
 * signature, pays exactly the cart's total, once, and the receipt names the cart. The seller delivers with the
 * sha256 of what it sent; the buyer signs that it received it. Every step is a signed message either side can show.
 */

/** One thing an agent sells, on its card (signed with it). Prices are per unit. */
export interface MenuItem { sku: string; label: string; price: { currency: string; value: number }; unit?: string }

/** W3C Payment Request API, as AP2 uses it (only what a Lake cart needs). */
export interface PaymentCurrencyAmount { currency: string; value: number }
export interface PaymentItem { label: string; amount: PaymentCurrencyAmount }
export interface PaymentRequest {
  method_data: { supported_methods: string; data?: Record<string, unknown> }[];
  details: { id: string; display_items: PaymentItem[]; total: PaymentItem };
}

/** AP2 CartContents and CartMandate. */
export interface CartContents {
  id: string; user_cart_confirmation_required: boolean; payment_request: PaymentRequest; cart_expiry: string; merchant_name: string;
  /** The Lake's one addition: the sha256 of what the buyer asked for (its note), so the signed cart says what was ordered (run 27). */
  lake_brief_sha256?: string;
}
export interface CartMandate { contents: CartContents; merchant_authorization: string }

/** How a Lake cart is paid: the AP2 mandate chain, settled by a payments agent the payer trusts. */
export const LAKE_PAYMENT_METHOD = 'https://lake.doneinfifty.com/pay/ap2';
const MAX_ITEMS = 12;
const MAX_CART_MINUTES = 24 * 60;

/** The hash AP2 puts in the merchant's JWT: sha256 over the canonical JSON (JCS) of the cart's contents. */
export const cartHash = (contents: CartContents) => jose.base64url.encode(createHash('sha256').update(canonicalize(contents)).digest());

/** Checks a menu an agent wants on its card: what's wrong with it, if anything. */
export function menuProblems(menu: unknown): string[] {
  if (!Array.isArray(menu)) return ['menu: a list of { sku, label, price: { currency, value }, unit? }'];
  if (menu.length > MAX_ITEMS) return [`menu: at most ${MAX_ITEMS} items`];
  const problems: string[] = [];
  const seen = new Set<string>();
  menu.forEach((m: Partial<MenuItem>, i) => {
    if (typeof m?.sku !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(m.sku)) problems.push(`menu[${i}].sku: a short code (lowercase letters, digits, dashes)`);
    else if (seen.has(m.sku)) problems.push(`menu[${i}].sku: "${m.sku}" twice`);
    else seen.add(m.sku);
    if (typeof m?.label !== 'string' || !m.label.trim() || m.label.length > 120) problems.push(`menu[${i}].label: what it is, 1 to 120 characters`);
    if (!/^[A-Z]{3}$/.test(String(m?.price?.currency)) || !(Number(m?.price?.value) >= 0.01) || Math.abs(Number(m?.price?.value) * 100 - Math.round(Number(m?.price?.value) * 100)) > 1e-6) problems.push(`menu[${i}].price: { currency: "USD", value: at least 0.01, in whole cents }`);
    if (m?.unit !== undefined && (typeof m.unit !== 'string' || m.unit.length > 30)) problems.push(`menu[${i}].unit: a short word, like "poem" or "hour"`);
  });
  return problems;
}

/**
 * A cart the seller signs: AP2 CartContents with one line per item, the total in one currency, and an expiry. The
 * merchant_authorization is a JWT (EdDSA, the seller's card key) with iss (the seller's WebID), sub (the buyer's), aud
 * (who may act on it: payments agents), iat, exp, jti and cart_hash.
 */
export async function signCart(o: {
  seller: Identity; sellerWebId: string; sellerName: string; buyerWebId: string;
  items: { label: string; amount: PaymentCurrencyAmount }[]; minutes?: number; id?: string; brief?: string;
}): Promise<CartMandate> {
  if (!o.items.length || o.items.length > MAX_ITEMS) throw new Error(`a cart holds 1 to ${MAX_ITEMS} items`);
  const currency = o.items[0]!.amount.currency;
  if (o.items.some((x) => x.amount.currency !== currency)) throw new Error('one currency per cart');
  const cents = o.items.reduce((a, x) => a + Math.round(x.amount.value * 100), 0);
  if (cents < 1) throw new Error('a cart costs at least 0.01');
  const minutes = Math.min(Math.max(o.minutes ?? 30, 1), MAX_CART_MINUTES);
  const id = o.id ?? randomUUID();
  const contents: CartContents = {
    id, user_cart_confirmation_required: false,
    payment_request: {
      method_data: [{ supported_methods: LAKE_PAYMENT_METHOD }],
      details: { id: `order-${id}`, display_items: o.items.map((x) => ({ label: x.label.slice(0, 120), amount: { currency, value: x.amount.value } })), total: { label: 'Total', amount: { currency, value: cents / 100 } } },
    },
    cart_expiry: new Date(Date.now() + minutes * 60_000).toISOString(), merchant_name: o.sellerName.slice(0, 80),
    ...(o.brief ? { lake_brief_sha256: createHash('sha256').update(o.brief).digest('hex') } : {}),
  };
  const merchant_authorization = await new jose.SignJWT({ cart_hash: cartHash(contents) })
    .setProtectedHeader({ alg: 'EdDSA', kid: o.seller.kid, typ: 'JWT' })
    .setIssuer(o.sellerWebId).setSubject(o.buyerWebId).setAudience('payments').setIssuedAt().setExpirationTime(Math.floor(Date.parse(contents.cart_expiry) / 1000)).setJti(randomUUID())
    .sign(o.seller.privateKey);
  return { contents, merchant_authorization };
}

/** What a checked cart says: who sells, to whom, the total, and the hash a payment names. */
export interface CheckedCart { id: string; seller: string; buyer: string; total: PaymentCurrencyAmount; hash: string; expires: string; items: PaymentItem[] }

/**
 * Checks a cart against the seller's key (from its verified card): the signature, that the JWT's hash is this very
 * contents' hash, that the lines add up to the total in one currency, and that it hasn't expired. Throws why not.
 */
export async function checkCart(cart: CartMandate, sellerJwk: jose.JWK, now = Date.now()): Promise<CheckedCart> {
  const c = cart?.contents;
  if (!c?.id || !c.payment_request?.details?.total || typeof cart.merchant_authorization !== 'string') throw new Error('not an AP2 cart: { contents, merchant_authorization }');
  let claims: jose.JWTPayload & { cart_hash?: string };
  try {
    ({ payload: claims } = await jose.jwtVerify(cart.merchant_authorization, await jose.importJWK(sellerJwk, 'EdDSA'), { currentDate: new Date(now) }));
  } catch (e) {
    throw new Error(`the seller's signature on the cart: ${(e as Error).message}`);
  }
  if (claims.cart_hash !== cartHash(c)) throw new Error('the cart was changed after the seller signed it');
  const { display_items: items, total } = c.payment_request.details;
  if (items.some((x) => x.amount.currency !== total.amount.currency)) throw new Error('the cart mixes currencies');
  if (items.reduce((a, x) => a + Math.round(x.amount.value * 100), 0) !== Math.round(total.amount.value * 100)) throw new Error('the cart\'s lines don\'t add up to its total');
  if (Date.parse(c.cart_expiry) < now) throw new Error(`the cart expired at ${c.cart_expiry}`);
  return { id: c.id, seller: String(claims.iss), buyer: String(claims.sub), total: total.amount, hash: cartHash(c), expires: c.cart_expiry, items };
}
