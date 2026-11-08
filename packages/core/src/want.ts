import { createHash } from 'node:crypto';
import { isCurrency, type IntentMandateSubject } from './ap2.js';
import type { MenuItem } from './trade.js';

/**
 * A want (SPEC §6.8): what a person is looking for, said once, so sellers come to them (intentcasting, as Project VRM
 * calls it). Shaped as a schema.org Demand: a short name, the product's properties, how many, where, until when. It is
 * public, on the house's card, like a tag: it never says what the person would pay. That stays in their house.
 */
export interface Want {
  '@type': 'Demand';
  /** The house's own id for it, unique among its wants: `w-<8 hex>`. */
  id: string;
  /** What, in a few words: "Handheld shower head". */
  name: string;
  /** One line more, if it helps: "To replace a worn one; the hose stays". */
  description?: string;
  /** schema.org itemOffered: the thing wanted and its properties, as name/value pairs ("Connection" = "1/2 inch BSP"). */
  itemOffered: { '@type': 'Product'; name: string; additionalProperty: { '@type': 'PropertyValue'; name: string; value: string }[] };
  /** How many. */
  eligibleQuantity?: { '@type': 'QuantitativeValue'; value: number };
  /** Where it should go, as coarse as the person likes: a country, a state ("AU-QLD"), a postcode area. */
  areaServed?: string;
  /** The currency offers should be in, so offers compare. */
  priceCurrency?: string;
  /** When it closes: offers after that are turned away. */
  availabilityEnds: string;
}

export const MAX_WANTS = 5;
export const MAX_WANT_DAYS = 14;
const MAX_PROPS = 12;
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** What a want needs to be listed: short words, a few properties, a date within two weeks. Empty when it's fine. */
export function wantProblems(w: unknown, now = Date.now()): string[] {
  const x = w as Partial<Want> | null;
  if (!x || typeof x !== 'object') return ['a want is { name, itemOffered: { name, additionalProperty }, availabilityEnds }'];
  const out: string[] = [];
  if (x['@type'] !== 'Demand') out.push('@type: "Demand" (schema.org)');
  if (!/^w-[0-9a-f]{8}$/.test(String(x.id ?? ''))) out.push('id: w-<8 hex>');
  if (!text(x.name, 80)) out.push('name: what, in up to 80 characters');
  if (x.description !== undefined && !text(x.description, 280)) out.push('description: up to 280 characters');
  const props = x.itemOffered?.additionalProperty;
  if (x.itemOffered?.['@type'] !== 'Product' || !text(x.itemOffered?.name, 80) || !Array.isArray(props)) out.push('itemOffered: { @type: "Product", name, additionalProperty: [...] }');
  else {
    if (props.length > MAX_PROPS) out.push(`at most ${MAX_PROPS} properties`);
    if (props.some((p) => p?.['@type'] !== 'PropertyValue' || !text(p.name, 40) || !text(p.value, 80))) out.push('each property: { @type: "PropertyValue", name (up to 40), value (up to 80) }');
  }
  const q = x.eligibleQuantity?.value;
  if (x.eligibleQuantity !== undefined && !(Number.isInteger(q) && q! >= 1 && q! <= 100)) out.push('eligibleQuantity.value: 1 to 100');
  if (x.areaServed !== undefined && !text(x.areaServed, 40)) out.push('areaServed: up to 40 characters');
  if (x.priceCurrency !== undefined && !isCurrency(x.priceCurrency)) out.push('priceCurrency: an ISO 4217 code (AUD, USD…)');
  const ends = Date.parse(String(x.availabilityEnds ?? ''));
  if (!Number.isFinite(ends) || ends < now || ends > now + MAX_WANT_DAYS * 86_400_000 + 60_000) out.push(`availabilityEnds: a time within ${MAX_WANT_DAYS} days`);
  // Nothing in a want says what the person would pay: a want with a price in it gives the bargain away.
  if (Object.keys(x).some((k) => /price$|budget|max/i.test(k) && k !== 'priceCurrency')) out.push('a want never says what you would pay: keep that in your house');
  return out;
}

/** A want from plain words and properties (what an AI writes after looking at a photo): checked, ready for a card. */
export function makeWant(o: { name: string; description?: string; properties?: Record<string, string | number>; quantity?: number; area?: string; currency?: string; days?: number }, now = Date.now()): Want {
  const props = Object.entries(o.properties ?? {}).filter(([, v]) => String(v).trim()).map(([name, value]) => ({ '@type': 'PropertyValue' as const, name: name.slice(0, 40), value: String(value).slice(0, 80) }));
  const w: Want = {
    '@type': 'Demand',
    id: `w-${createHash('sha256').update(`${o.name}|${now}|${Math.random()}`).digest('hex').slice(0, 8)}`,
    name: o.name.trim(),
    ...(o.description?.trim() ? { description: o.description.trim() } : {}),
    itemOffered: { '@type': 'Product', name: o.name.trim(), additionalProperty: props },
    ...(o.quantity && o.quantity !== 1 ? { eligibleQuantity: { '@type': 'QuantitativeValue', value: o.quantity } } : {}),
    ...(o.area?.trim() ? { areaServed: o.area.trim() } : {}),
    ...(o.currency ? { priceCurrency: o.currency } : {}),
    availabilityEnds: new Date(now + Math.min(Math.max(o.days ?? 7, 1), MAX_WANT_DAYS) * 86_400_000).toISOString(),
  };
  const problems = wantProblems(w, now);
  if (problems.length) throw new Error(problems.join('; '));
  return w;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9/.½ ]+/g, ' ').split(/\s+/).filter((t) => (t.length > 1 || /\d/.test(t)) && !STOP.has(t));
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'with', 'one', 'new', 'old', 'my', 'it', 'is']);

/**
 * How well something a seller has fits a want, from 0 to 1, by the words they share: its name first, then each property
 * the item also has, value for value. A seller's own matcher can do better; this one is plain and explainable, and says
 * which properties matched, so an offer can show them.
 */
export function wantFit(w: Want, item: { label: string; props?: Record<string, string>; keywords?: string[] }): { score: number; matched: string[] } {
  const have = new Set(words(`${item.label} ${(item.keywords ?? []).join(' ')} ${Object.values(item.props ?? {}).join(' ')}`));
  const nameWords = words(w.itemOffered.name);
  const named = nameWords.length ? nameWords.filter((t) => have.has(t)).length / nameWords.length : 0;
  const matched: string[] = [];
  const own = Object.fromEntries(Object.entries(item.props ?? {}).map(([k, v]) => [k.toLowerCase(), words(v)]));
  // A property matches when the item says the same, under that name or anywhere (one AI's "Thread" is a shop's "Connection").
  for (const p of w.itemOffered.additionalProperty) {
    const theirs = own[p.name.toLowerCase()] ?? [...have];
    const want = words(p.value);
    if (want.length && want.every((t) => theirs.includes(t))) matched.push(p.name);
  }
  const props = w.itemOffered.additionalProperty.length;
  return { score: named < 0.5 ? 0 : Math.round((0.5 * named + 0.5 * (props ? matched.length / props : 1)) * 100) / 100, matched };
}

/** What an offer for a want says beside its signed cart: which want, the fit, the delivery, a picture if the seller has one. */
/** A demo shop a pack brings (SPEC §6.8): it reads the Lake's wants and offers what fits from its catalogue. Invented. */
export interface ShopExample {
  name: string;
  domain: string;
  description: string;
  currency: string;
  /** Where it delivers: prefixes of a want's areaServed ("AU" takes "AU-QLD"); none: anywhere. */
  regions?: string[];
  delivery: { days: number; fee: number };
  items: { sku: string; label: string; price: number; props?: Record<string, string>; keywords?: string[] }[];
}

export interface WantOffer { want: string; cart: unknown; matched?: string[]; delivery?: string; note?: string; image?: string; menu?: MenuItem[] }

/**
 * A purchase the owner signs on their device for one seller's cart (SPEC §6.8): exactly its total, for that cart and
 * nothing else (its `study` names the cart), to be paid by their house and held until the owner says it arrived.
 */
export const purchaseDraft = (houseWebId: string, cart: { id: string; merchant: string; total: { currency: string; value: number } }, until: Date, status?: unknown) => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential', 'IntentMandate'],
  issuer: houseWebId,
  credentialSubject: {
    id: houseWebId, natural_language_description: `Buy from ${cart.merchant.slice(0, 80)}: cart ${cart.id}`, study: `urn:ap2:cart:${cart.id}`,
    budget: { currency: cart.total.currency, amount: cart.total.value }, intent_expiry: until.toISOString(), user_cart_confirmation_required: false,
  } satisfies IntentMandateSubject,
  ...(status ? { credentialStatus: status } : {}),
});
