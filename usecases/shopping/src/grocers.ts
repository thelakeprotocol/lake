import type { QuoteProgram, QuoterExample } from '@thelakeprotocol/core';
import { DIETS } from './synthetic.js';

/**
 * How a grocer prices a household's weekly shop, as a quote program the house runs on its own data: a basket for this
 * many people and these staples, at the grocer's price level; a surcharge for special diets it can serve, and no offer
 * at all if it can't serve one of them; staples it doesn't stock are substituted; delivery by the day asked for; and a
 * discount when enough households on the same street shop together. Only the owner sees the offer.
 */
export interface GrocerRules {
  /** Price level: dollars per person per week, and per regular item. */
  perPerson: number;
  perItem: number;
  /** Diets it can serve; a household with any other gets no offer. */
  serves: string[];
  /** Surcharge on the basket for a household with special diets, as a fraction. */
  dietMarkup: number;
  /** Staples it doesn't stock: it offers a substitute, and says how many. */
  lacks: string[];
  delivery: { thisWeek: number; tomorrow: number };
  /** States it delivers to. */
  regions: string[];
  group?: { offPct: number; minMembers: number };
}

const dbl = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const list = (xs: string[]) => `[${xs.map((x) => `'${x}'`).join(', ')}]`;

export function grocerProgram(title: string, r: GrocerRules): QuoteProgram {
  return {
    v: 2,
    kind: 'quote',
    pack: 'shopping@1',
    title,
    inputs: ['household_size', 'dietary_needs', 'staples', 'weekly_spend'],
    terms: ['region', 'budget', 'delivery', 'group_size'],
    let: {
      basket: `household_size * ${dbl(r.perPerson)} + double(size(staples)) * ${dbl(r.perItem)}`,
      diet_extra: `size(dietary_needs) > 0 ? basket * ${dbl(r.dietMarkup)} : 0.0`,
      substitutions: `double(size(staples.filter(s, s in ${list(r.lacks)})))`,
      delivery_fee: `delivery == 'tomorrow' ? ${dbl(r.delivery.tomorrow)} : ${dbl(r.delivery.thisWeek)}`,
      group_off: r.group ? `group_size >= ${dbl(r.group.minMembers)} ? ${dbl(r.group.offPct)} : 0.0` : '0.0',
      total: '(basket + diet_extra) * (1.0 - group_off / 100.0) + delivery_fee',
    },
    eligible: [`region in ${list(r.regions)}`, `dietary_needs.all(d, d in ${list(r.serves)})`].join(' && '),
    price: 'total',
    outputs: {
      total: 'round(total, 2)',
      delivery_fee: 'delivery_fee',
      substitutions: 'substitutions',
      group_off: 'group_off',
      within_budget: 'total <= budget ? 1.0 : 0.0',
    },
    labels: {
      total: { label: 'Total to pay, delivery included', unit: 'AUD' },
      delivery_fee: { label: 'of which delivery', unit: 'AUD' },
      substitutions: { label: 'Staples swapped for a substitute' },
      group_off: { label: 'Street discount', unit: '%' },
      within_budget: { label: 'Within your budget', unit: 'yes/no' },
    },
    // Why it isn't for you, and what you'd get instead: run 23's households had to guess both.
    notes: [
      ...(r.regions.length < ALL.length ? [{ when: `!(region in ${list(r.regions)})`, say: `We don't deliver to your region (only ${r.regions.map((x) => x.toUpperCase()).join(', ')})` }] : []),
      ...DIETS.filter((d) => !r.serves.includes(d)).map((d) => ({ when: `'${d}' in dietary_needs`, say: `We can't cater for: ${d.replace('-', ' ')}` })),
      ...r.lacks.map((x) => ({ when: `'${x}' in staples`, say: `${x[0]!.toUpperCase()}${x.slice(1)}: we'd send a substitute` })),
    ],
    output: 'owner',
  };
}

const ALL = ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt'];
const grocer = (name: string, slug: string, r: GrocerRules): QuoterExample =>
  ({ name, domain: `${slug}.lake.local`, ...(MENUS[slug] ? { menu: MENUS[slug] } : {}), program: grocerProgram(`${name}: your weekly shop`, r), currency: 'AUD', acceptedAs: 'order confirmed', next: 'pay the basket total to this shop (lake_pay, naming the order), and it is delivered on the day you asked for' });

// Single things people want (run 67: persimmons, honey, a pomegranate, apricots), on each grocer's signed menu, in AUD.
// Fictional prices; each shop stocks a little differently.
const item = (sku: string, label: string, value: number, unit?: string) => ({ sku, label, price: { currency: 'AUD', value }, ...(unit ? { unit } : {}) });
const MENUS: Record<string, ReturnType<typeof item>[]> = {
  bigmart: [item('bananas', 'Bananas, 1 kg', 3.9, 'kg'), item('milk', 'Full cream milk, 2 L', 3.6), item('bread', 'White sandwich loaf', 3.2), item('eggs', 'Eggs, a dozen', 5.5), item('honey', 'Honey, 500 g jar', 8.5), item('apricots', 'Apricots, 500 g', 6.9)],
  corner: [item('persimmons', 'Persimmons, bag of 4', 6.5), item('pomegranate', 'Pomegranate, each', 3.5), item('apricots', 'Ripe apricots, 500 g', 7.9), item('raw-honey', 'Local raw honey, 500 g jar', 12), item('basil', 'Basil plant, potted', 5), item('sourdough', 'Sourdough loaf', 8)],
  greenbasket: [item('organic-apples', 'Organic apples, 1 kg', 7.5), item('raw-honey', 'Raw organic honey, 350 g jar', 14.9), item('eggs', 'Free-range eggs, a dozen', 8.2), item('oat-milk', 'Oat milk, 1 L', 4.4), item('persimmons', 'Organic persimmons, bag of 3', 7.8)],
};

/** Three fictional grocers that differ for real: cheap but narrow, local and flexible, dearer but serves every diet. */
export const GROCERS: QuoterExample[] = [
  grocer('Big Mart', 'bigmart', { perPerson: 21, perItem: 1.1, serves: ['vegetarian', 'halal'], dietMarkup: 0.05, lacks: ['tofu', 'lentils'], delivery: { thisWeek: 9, tomorrow: 15 }, regions: ALL, group: { offPct: 5, minMembers: 3 } }),
  grocer('Corner Grocer', 'corner', { perPerson: 25, perItem: 1.4, serves: ['vegetarian', 'vegan', 'halal', 'lactose-free'], dietMarkup: 0.08, lacks: ['nappies'], delivery: { thisWeek: 4, tomorrow: 6 }, regions: ['vic', 'nsw'], group: { offPct: 8, minMembers: 3 } }),
  grocer('Green Basket', 'greenbasket', { perPerson: 31, perItem: 1.8, serves: [...DIETS], dietMarkup: 0.04, lacks: [], delivery: { thisWeek: 0, tomorrow: 5 }, regions: ALL, group: { offPct: 10, minMembers: 3 } }),
];
