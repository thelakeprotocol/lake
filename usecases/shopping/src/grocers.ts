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
    outputs: {
      total: 'round(total, 2)',
      delivery_fee: 'delivery_fee',
      substitutions: 'substitutions',
      group_off: 'group_off',
      within_budget: 'total <= budget ? 1.0 : 0.0',
    },
    labels: {
      total: { label: 'Basket, delivered', unit: 'AUD' },
      delivery_fee: { label: 'Delivery', unit: 'AUD' },
      substitutions: { label: 'Staples swapped for a substitute' },
      group_off: { label: 'Street discount', unit: '%' },
      within_budget: { label: 'Within your budget', unit: 'yes/no' },
    },
    output: 'owner',
  };
}

const ALL = ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt'];
const grocer = (name: string, slug: string, r: GrocerRules): QuoterExample =>
  ({ name, domain: `${slug}.lake.local`, program: grocerProgram(`${name}: your weekly shop`, r), currency: 'AUD', acceptedAs: 'order confirmed', next: 'pay the basket total to this shop (lake_pay, naming the order), and it is delivered on the day you asked for' });

/** Three fictional grocers that differ for real: cheap but narrow, local and flexible, dearer but serves every diet. */
export const GROCERS: QuoterExample[] = [
  grocer('Big Mart', 'bigmart', { perPerson: 21, perItem: 1.1, serves: ['vegetarian', 'halal'], dietMarkup: 0.05, lacks: ['tofu', 'lentils'], delivery: { thisWeek: 9, tomorrow: 15 }, regions: ALL, group: { offPct: 5, minMembers: 3 } }),
  grocer('Corner Grocer', 'corner', { perPerson: 25, perItem: 1.4, serves: ['vegetarian', 'vegan', 'halal', 'lactose-free'], dietMarkup: 0.08, lacks: ['nappies'], delivery: { thisWeek: 4, tomorrow: 6 }, regions: ['vic', 'nsw'], group: { offPct: 8, minMembers: 3 } }),
  grocer('Green Basket', 'greenbasket', { perPerson: 31, perItem: 1.8, serves: [...DIETS], dietMarkup: 0.04, lacks: [], delivery: { thisWeek: 0, tomorrow: 5 }, regions: ALL, group: { offPct: 10, minMembers: 3 } }),
];
