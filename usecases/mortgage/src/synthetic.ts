import { rng } from '@thelakeprotocol/core';
import { incomeTax } from './tax.js';

/**
 * Synthetic Australian bank data, loosely in the shape of a Consumer Data Right banking export: accounts
 * with balances, and twelve months of posted transactions. Seeded, so the same seed always makes the same
 * person. No real data, ever.
 */
export interface Statements {
  provider: string;
  period: { from: string; to: string };
  holder: { name: string };
  accounts: { accountId: string; productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS'; displayName: string; balance: number; currency: 'AUD' }[];
  transactions: { date: string; amount: number; category: Category; status: 'posted' | 'dishonoured'; description: string }[];
}
type Category = 'salary' | 'business_income' | 'personal_loan' | 'credit_card' | 'car_loan' | 'bnpl' | 'rent' | 'groceries' | 'bills';

const day = 86_400_000;

export function syntheticStatements(seed: number, asOf = Date.UTC(2026, 9, 1)): Statements {
  const r = rng(seed ^ 0x6d6f7274);
  const between = (a: number, b: number) => a + r() * (b - a);
  // Gross income skews low with a long tail, like real earnings: $55k to about $220k (full-time median is near $95k).
  const gross = Math.round((55_000 + 165_000 * r() ** 2) / 500) * 500;
  const selfEmployed = r() < 0.15;
  const netMonthly = Math.round((gross - incomeTax(gross)) / 12);
  const savings = Math.round((gross * between(0.08, 1.2) + between(5_000, 25_000)) / 100) * 100;
  const debts: { category: Category; monthly: number }[] = [];
  if (r() < 0.3) debts.push({ category: 'car_loan', monthly: Math.round(between(350, 900)) });
  if (r() < 0.45) debts.push({ category: 'credit_card', monthly: Math.round(between(50, 400)) });
  if (r() < 0.25) debts.push({ category: 'personal_loan', monthly: Math.round(between(150, 600)) });
  if (r() < 0.25) debts.push({ category: 'bnpl', monthly: Math.round(between(40, 200)) });
  const missed = r() < 0.8 ? 0 : r() < 0.6 ? 1 : 2 + Math.floor(r() * 2);
  const rent = Math.round(between(2_000, 3_800));

  const tx: Statements['transactions'] = [];
  const missedMonths = new Set(Array.from({ length: missed }, () => Math.floor(r() * 12)));
  for (let m = 0; m < 12; m++) {
    const t = asOf - (12 - m) * 30 * day;
    const date = new Date(t).toISOString().slice(0, 10);
    tx.push({ date, amount: Math.round(netMonthly * (selfEmployed ? between(0.6, 1.4) : 1)), category: selfEmployed ? 'business_income' : 'salary', status: 'posted', description: selfEmployed ? 'Invoice paid' : 'Salary' });
    tx.push({ date, amount: -rent, category: 'rent', status: 'posted', description: 'Rent' });
    tx.push({ date, amount: -Math.round(between(500, 1_000)), category: 'groceries', status: 'posted', description: 'Groceries' });
    tx.push({ date, amount: -Math.round(between(250, 500)), category: 'bills', status: 'posted', description: 'Electricity, internet, phone' });
    debts.forEach((d, i) => tx.push({ date, amount: -d.monthly, category: d.category, status: missedMonths.has(m) && i === 0 ? 'dishonoured' : 'posted', description: `Direct debit: ${d.category.replace('_', ' ')}` }));
    if (!debts.length && missedMonths.has(m)) tx.push({ date, amount: -Math.round(between(40, 90)), category: 'bills', status: 'dishonoured', description: 'Direct debit: phone' });
  }
  return {
    provider: 'Demo Bank',
    period: { from: new Date(asOf - 360 * day).toISOString().slice(0, 10), to: new Date(asOf).toISOString().slice(0, 10) },
    holder: { name: `Synthetic Person-${seed % 10000}` },
    accounts: [
      { accountId: `txn-${seed.toString(16)}`, productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS', displayName: 'Everyday', balance: Math.round(between(300, 4_000)), currency: 'AUD' },
      { accountId: `sav-${seed.toString(16)}`, productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS', displayName: 'Savings', balance: savings, currency: 'AUD' },
    ],
    transactions: tx,
  };
}
