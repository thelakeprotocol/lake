import { rng } from '@thelakeprotocol/core';

/**
 * Synthetic bank statements in the shape of an Open Banking (UK) account-information export: accounts with
 * balances, and twelve months of booked transactions. Seeded, so the same seed always makes the same person.
 * No real data, ever.
 */
export interface Statements {
  provider: string;
  period: { from: string; to: string };
  holder: { name: string };
  accounts: { id: string; type: 'current' | 'savings'; balance: number; currency: 'GBP' }[];
  transactions: { date: string; amount: number; category: Category; status: 'booked' | 'returned'; description: string }[];
}
type Category = 'salary' | 'business_income' | 'loan' | 'credit_card' | 'car_finance' | 'rent' | 'groceries' | 'bills';

const day = 86_400_000;

export function syntheticStatements(seed: number, asOf = Date.UTC(2026, 9, 1)): Statements {
  const r = rng(seed ^ 0x6d6f7274);
  const between = (a: number, b: number) => a + r() * (b - a);
  // Gross income skews low with a long tail, like real earnings: £22k to about £110k.
  const gross = Math.round((22_000 + 88_000 * r() ** 2.2) / 500) * 500;
  const selfEmployed = r() < 0.15;
  const netMonthly = Math.round((gross * 0.72) / 12);
  const savings = Math.round((gross * between(0.05, 1.1) + between(2_000, 12_000)) / 100) * 100;
  const debts: { category: Category; monthly: number }[] = [];
  if (r() < 0.35) debts.push({ category: 'loan', monthly: Math.round(between(80, 420)) });
  if (r() < 0.45) debts.push({ category: 'credit_card', monthly: Math.round(between(30, 260)) });
  if (r() < 0.3) debts.push({ category: 'car_finance', monthly: Math.round(between(150, 420)) });
  const missed = r() < 0.8 ? 0 : r() < 0.6 ? 1 : 2 + Math.floor(r() * 2);
  const rent = Math.round(between(650, 1_600));

  const tx: Statements['transactions'] = [];
  const missedMonths = new Set(Array.from({ length: missed }, () => Math.floor(r() * 12)));
  for (let m = 0; m < 12; m++) {
    const t = asOf - (12 - m) * 30 * day;
    const date = new Date(t).toISOString().slice(0, 10);
    tx.push({ date, amount: Math.round(netMonthly * (selfEmployed ? between(0.6, 1.4) : 1)), category: selfEmployed ? 'business_income' : 'salary', status: 'booked', description: selfEmployed ? 'Client payment' : 'Salary' });
    tx.push({ date, amount: -rent, category: 'rent', status: 'booked', description: 'Rent' });
    tx.push({ date, amount: -Math.round(between(220, 520)), category: 'groceries', status: 'booked', description: 'Groceries' });
    tx.push({ date, amount: -Math.round(between(120, 260)), category: 'bills', status: 'booked', description: 'Utilities' });
    debts.forEach((d, i) => tx.push({ date, amount: -d.monthly, category: d.category, status: missedMonths.has(m) && i === 0 ? 'returned' : 'booked', description: `Direct debit: ${d.category.replace('_', ' ')}` }));
    if (!debts.length && missedMonths.has(m)) tx.push({ date, amount: -Math.round(between(40, 90)), category: 'bills', status: 'returned', description: 'Direct debit: phone' });
  }
  return {
    provider: 'Demo Bank',
    period: { from: new Date(asOf - 360 * day).toISOString().slice(0, 10), to: new Date(asOf).toISOString().slice(0, 10) },
    holder: { name: `Synthetic Person-${seed % 10000}` },
    accounts: [
      { id: `cur-${seed.toString(16)}`, type: 'current', balance: Math.round(between(200, 3_000)), currency: 'GBP' },
      { id: `sav-${seed.toString(16)}`, type: 'savings', balance: savings, currency: 'GBP' },
    ],
    transactions: tx,
  };
}
