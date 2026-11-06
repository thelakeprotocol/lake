import { rng } from '@thelakeprotocol/core';
import { incomeTax } from './tax.js';
import { INCUMBENTS, newCustomerRate } from './loans.js';

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
  /** A home loan, for those who have one (CDR's RESIDENTIAL_MORTGAGES): who lends it, what's owed, its rate and age. */
  loans?: { accountId: string; productCategory: 'RESIDENTIAL_MORTGAGES'; provider: string; displayName: string; balance: number; interestRate: number; originalStartDate: string; estimatedPropertyValue: number; currency: 'AUD' }[];
  transactions: { date: string; amount: number; category: Category; status: 'posted' | 'dishonoured'; description: string }[];
}
type Category = 'salary' | 'business_income' | 'personal_loan' | 'credit_card' | 'car_loan' | 'bnpl' | 'rent' | 'home_loan' | 'groceries' | 'bills';

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
  const loan = homeLoan(seed, gross, asOf);

  const tx: Statements['transactions'] = [];
  const missedMonths = new Set(Array.from({ length: missed }, () => Math.floor(r() * 12)));
  for (let m = 0; m < 12; m++) {
    const t = asOf - (12 - m) * 30 * day;
    const date = new Date(t).toISOString().slice(0, 10);
    tx.push({ date, amount: Math.round(netMonthly * (selfEmployed ? between(0.6, 1.4) : 1)), category: selfEmployed ? 'business_income' : 'salary', status: 'posted', description: selfEmployed ? 'Invoice paid' : 'Salary' });
    if (loan) tx.push({ date, amount: -loan.repayment, category: 'home_loan', status: 'posted', description: `Home loan repayment: ${INCUMBENTS[loan.bank]!.name}` });
    else tx.push({ date, amount: -rent, category: 'rent', status: 'posted', description: 'Rent' });
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
    ...(loan ? { loans: [{ accountId: `hl-${seed.toString(16)}`, productCategory: 'RESIDENTIAL_MORTGAGES' as const, provider: INCUMBENTS[loan.bank]!.name, displayName: 'Home loan', balance: -loan.balance, interestRate: loan.rate, originalStartDate: loan.start, estimatedPropertyValue: loan.value, currency: 'AUD' as const }] } : {}),
  };
}

/**
 * About three in five have a home loan with one of the big four, from its own seed (so everything else about a person
 * stays the same). The older the loan, the further its rate has drifted above what the bank offers new customers:
 * nothing to about 1.2 points (the ACCC found gaps like this growing with a loan's age).
 */
function homeLoan(seed: number, gross: number, asOf: number) {
  const r = rng(seed ^ 0x686c6f61);
  if (r() > 0.6) return null;
  const banks = Object.keys(INCUMBENTS);
  const bank = banks[Math.floor(r() * banks.length)]!;
  const years = 1 + Math.floor(r() * 12);
  const value = Math.round((450_000 + 1_100_000 * r() ** 1.5) / 5_000) * 5_000;
  const balance = Math.round(Math.min(value * (0.3 + 0.45 * r()), gross * 4) / 1_000) * 1_000;
  const drift = Math.min(1.2, Math.max(0, years * 0.1 + (r() - 0.3) * 0.4));
  const rate = Math.round((newCustomerRate(bank, balance / value) + drift) * 100) / 100;
  const monthly = (rate / 100) / 12, n = Math.max(5, 30 - years) * 12;
  const repayment = Math.round((balance * monthly) / (1 - (1 + monthly) ** -n));
  return { bank, balance, value, rate, repayment, start: new Date(asOf - years * 365 * 86_400_000).toISOString().slice(0, 10) };
}
