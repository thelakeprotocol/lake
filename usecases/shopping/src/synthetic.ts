import { rng } from '@thelakeprotocol/core';

/**
 * A synthetic household's grocery receipts: eight weeks of itemised shops, in the shape a receipt-wallet app might
 * export. Seeded, so the same seed always makes the same household. No real data, ever.
 */
export interface Receipts {
  app: string;
  period: { from: string; to: string };
  household: { name: string; people: number; diets: Diet[] };
  shops: { date: string; store: string; total: number; items: { item: Staple; qty: number; price: number }[] }[];
}
export const DIETS = ['gluten-free', 'vegetarian', 'vegan', 'nut-allergy', 'lactose-free', 'halal'] as const;
export type Diet = (typeof DIETS)[number];
export const STAPLES = ['milk', 'bread', 'eggs', 'rice', 'pasta', 'apples', 'bananas', 'carrots', 'potatoes', 'tomatoes', 'chicken', 'beef', 'tofu', 'lentils', 'cheese', 'yoghurt', 'cereal', 'coffee', 'tea', 'nappies'] as const;
export type Staple = (typeof STAPLES)[number];
const PRICE: Record<Staple, number> = { milk: 3.2, bread: 4.5, eggs: 6.8, rice: 4, pasta: 2.5, apples: 5, bananas: 3.5, carrots: 2.4, potatoes: 4.2, tomatoes: 5.5, chicken: 12, beef: 16, tofu: 4.5, lentils: 3, cheese: 9, yoghurt: 5.5, cereal: 6, coffee: 14, tea: 6, nappies: 28 };
const STORES = ['Big Mart', 'Corner Grocer', 'Green Basket'];
const day = 86_400_000;

export function syntheticReceipts(seed: number, asOf = Date.UTC(2026, 9, 1)): Receipts {
  const r = rng(seed ^ 0x73686f70);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const people = 1 + Math.floor(r() ** 1.5 * 5);
  const diets: Diet[] = [];
  if (r() < 0.12) diets.push('gluten-free');
  const veg = r();
  if (veg < 0.08) diets.push('vegan');
  else if (veg < 0.2) diets.push('vegetarian');
  if (r() < 0.06) diets.push('nut-allergy');
  if (r() < 0.1) diets.push('lactose-free');
  if (r() < 0.05) diets.push('halal');
  // What this household buys: a core most weeks, the rest now and then; no meat for vegetarians, no dairy for vegans.
  const allowed = STAPLES.filter((s) => !(diets.includes('vegetarian') || diets.includes('vegan')) || !['chicken', 'beef'].includes(s))
    .filter((s) => !diets.includes('vegan') || !['milk', 'eggs', 'cheese', 'yoghurt'].includes(s))
    .filter((s) => people > 2 || s !== 'nappies' || r() < 0.1);
  const core = allowed.filter(() => r() < 0.45);
  const shops: Receipts['shops'] = [];
  for (let w = 0; w < 8; w++) {
    const date = new Date(asOf - (8 - w) * 7 * day).toISOString().slice(0, 10);
    const items = allowed.filter((s) => (core.includes(s) ? r() < 0.85 : r() < 0.15)).map((item) => {
      const qty = Math.max(1, Math.round(people * (0.6 + r() * 0.8)));
      return { item, qty, price: Math.round(PRICE[item] * qty * (0.9 + r() * 0.25) * 100) / 100 };
    });
    shops.push({ date, store: pick(STORES), total: Math.round(items.reduce((a, x) => a + x.price, 0) * 100) / 100, items });
  }
  return { app: 'Demo Receipt Wallet', period: { from: shops[0]!.date, to: shops.at(-1)!.date }, household: { name: 'Synthetic Household', people, diets }, shops };
}
