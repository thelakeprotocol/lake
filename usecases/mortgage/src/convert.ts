import type { Claim } from '@thelakeprotocol/core';
import type { Statements } from './synthetic.js';
import { grossFromNet } from './tax.js';

/** What an auditor certifies: this converter, at this version. */
export const CONVERTER = '@thelakeprotocol/usecase-mortgage/cdr@1.0.0';

const COMMITMENTS = new Set(['personal_loan', 'credit_card', 'car_loan', 'bnpl']);

/**
 * Bank data → the coarse facts a lender needs, inside the house. Gross income is worked back from a year
 * of net pay with the 2026–27 tax scales and rounded to $1,000; rent, groceries and bills are not
 * commitments (lenders apply their own living-expense benchmark instead). Pure; no network.
 */
export function extractClaims(s: Statements): Claim[] {
  const year = s.transactions;
  const income = year.filter((t) => (t.category === 'salary' || t.category === 'business_income') && t.status === 'posted').reduce((a, t) => a + t.amount, 0);
  const months = new Set(year.map((t) => t.date.slice(0, 7))).size || 12;
  const commitments = year.filter((t) => COMMITMENTS.has(t.category) && t.amount < 0).reduce((a, t) => a - t.amount, 0) / months;
  const savings = s.accounts.filter((a) => a.displayName === 'Savings').reduce((a, x) => a + x.balance, 0);
  const missed = year.filter((t) => t.status === 'dishonoured').length;
  const selfEmployed = year.some((t) => t.category === 'business_income');
  return [
    { field: 'income_annual', value: String(Math.round(grossFromNet(income) / 1000) * 1000) },
    { field: 'monthly_commitments', value: String(Math.round(commitments)) },
    { field: 'savings', value: String(Math.round(savings)) },
    { field: 'missed_payments_12m', value: String(missed) },
    { field: 'employment', value: selfEmployed ? 'self-employed' : 'employed', code: selfEmployed ? 'self-employed' : 'employed' },
  ];
}
