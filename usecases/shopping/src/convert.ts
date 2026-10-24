import type { Claim } from '@thelakeprotocol/core';
import { DIETS, type Receipts } from './synthetic.js';

/** What an auditor certifies: this converter, at this version. */
export const CONVERTER = '@thelakeprotocol/usecase-shopping/receipts@1.0.0';

/**
 * Receipts → the coarse facts a grocer needs to price a weekly shop, inside the house: how many people, which diets,
 * the staples bought in most weeks (at least five of eight), and the average weekly spend rounded to $5. Names,
 * stores and dates stay in the original. Pure; no network.
 */
export function extractClaims(s: Receipts): Claim[] {
  const weeks = s.shops.length || 1;
  const counts = new Map<string, number>();
  for (const shop of s.shops) for (const it of new Set(shop.items.map((x) => x.item))) counts.set(it, (counts.get(it) ?? 0) + 1);
  const staples = [...counts].filter(([, n]) => n >= Math.ceil(weeks * 0.6)).map(([item]) => item).sort();
  const spend = s.shops.reduce((a, x) => a + x.total, 0) / weeks;
  return [
    { field: 'household_size', value: String(s.household.people) },
    ...s.household.diets.filter((d) => (DIETS as readonly string[]).includes(d)).map((d) => ({ field: 'dietary_needs', value: d, code: d })),
    ...staples.map((item) => ({ field: 'staples', value: item, code: item })),
    { field: 'weekly_spend', value: String(Math.round(spend / 5) * 5) },
  ];
}
