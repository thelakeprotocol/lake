import type { Claim } from '@thelakeprotocol/core';
import type { Statements } from './synthetic.js';

/** What an auditor certifies: this converter, at this version. */
export const CONVERTER = '@thelakeprotocol/usecase-mortgage/openbanking@1.0.0';

const COMMITMENTS = new Set(['loan', 'credit_card', 'car_finance']);

/**
 * Bank statements → the coarse facts a lender needs, inside the house. Gross income is estimated from a
 * year of net pay (net is roughly 72% of gross in the UK at these incomes) and rounded to £1,000; rent,
 * groceries and bills are not commitments. Pure; no network.
 */
export function extractClaims(s: Statements): Claim[] {
  const year = s.transactions;
  const income = year.filter((t) => (t.category === 'salary' || t.category === 'business_income') && t.status === 'booked').reduce((a, t) => a + t.amount, 0);
  const months = new Set(year.map((t) => t.date.slice(0, 7))).size || 12;
  const commitments = year.filter((t) => COMMITMENTS.has(t.category) && t.amount < 0).reduce((a, t) => a - t.amount, 0) / months;
  const savings = s.accounts.filter((a) => a.type === 'savings').reduce((a, x) => a + x.balance, 0);
  const missed = year.filter((t) => t.status === 'returned').length;
  const selfEmployed = year.some((t) => t.category === 'business_income');
  return [
    { field: 'income_annual', value: String(Math.round(income / 0.72 / 1000) * 1000) },
    { field: 'monthly_commitments', value: String(Math.round(commitments)) },
    { field: 'savings', value: String(Math.round(savings)) },
    { field: 'missed_payments_12m', value: String(missed) },
    { field: 'employment', value: selfEmployed ? 'self-employed' : 'employed', code: selfEmployed ? 'self-employed' : 'employed' },
  ];
}
