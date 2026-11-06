import type { Claim } from '@thelakeprotocol/core';
import type { Statements } from './synthetic.js';
import { grossFromNet } from './tax.js';
import { INCUMBENTS, newCustomerRate, overpayBand } from './loans.js';

/** What an auditor certifies: this converter, at this version. */
export const CONVERTER = '@thelakeprotocol/usecase-mortgage/cdr@1.1.0';

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
    ...homeLoanClaims(s),
  ];
}

/**
 * A home loan, if there is one: who lends it, what's owed, its rate, the home's estimated value, its age, and how
 * far its rate sits above what the same bank offers a new customer at the same loan-to-value (in hundredths of a
 * point), with what that costs a year. Worked out here, from the bank's own data, inside the house.
 */
function homeLoanClaims(s: Statements): Claim[] {
  const l = s.loans?.[0];
  const bank = l && Object.entries(INCUMBENTS).find(([, b]) => b.name === l.provider)?.[0];
  if (!l || !bank) return [];
  const balance = -l.balance, lvr = balance / l.estimatedPropertyValue;
  const gap = Math.max(0, Math.round((l.interestRate - newCustomerRate(bank, lvr)) * 100));
  const overpay = Math.round((balance * gap) / 10_000 / 10) * 10;
  const years = Math.max(0, Math.floor((Date.parse(s.period.to) - Date.parse(l.originalStartDate)) / (365 * 86_400_000)));
  return [
    { field: 'home_loan_lender', value: bank, code: bank },
    { field: 'home_loan_balance', value: String(Math.round(balance / 1000) * 1000) },
    { field: 'home_loan_rate', value: l.interestRate.toFixed(2) },
    { field: 'home_value', value: String(Math.round(l.estimatedPropertyValue / 5000) * 5000) },
    { field: 'home_loan_years', value: String(years) },
    { field: 'loyalty_gap', value: String(gap) },
    { field: 'overpay_yearly', value: String(overpay) },
    { field: 'lender_overpay', value: `${bank}:${overpayBand(overpay)}`, code: `${bank}:${overpayBand(overpay)}` },
  ];
}
