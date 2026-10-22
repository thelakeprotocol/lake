import type { Expr, QuoteProgram, QuoterExample } from '@thelakeprotocol/core';

/**
 * How a lender decides, simplified from how UK lenders really do it, as a quote program the house runs
 * on its own data. Loan-to-value (LTV) sets the rate band; loan-to-income (LTI) caps the loan; the payment
 * is stress-tested at a higher rate against take-home pay after other commitments; recent missed payments
 * count against you. All of it happens inside the house; only the owner sees the result.
 */
export interface LenderRules {
  /** [max LTV, rate %] bands, cheapest first. Above the last band: not eligible. */
  rates: [number, number][];
  /** Maximum loan as a multiple of income; optionally higher above an income threshold. */
  maxLti: number;
  higherLti?: { from: number; lti: number };
  /** Missed payments in the last 12 months it accepts, and what each one adds to the rate. */
  maxMissed: number;
  missedLoading?: number;
  /** Stress test: rate + this, and the payment must fit this share of take-home pay after commitments. */
  stress: number;
  affordShare: number;
  selfEmployed: boolean;
  /** Its offer to a group: this much off the rate when at least `minMembers` households share the intent. */
  group?: { off: number; minMembers: number };
}

const v = (name: string): Expr => ({ var: name });

export function lenderProgram(title: string, r: LenderRules): QuoteProgram {
  const maxLtv = r.rates.at(-1)![0];
  const lti: Expr = r.higherLti ? { if: [{ '>=': [v('income_annual'), r.higherLti.from] }, r.higherLti.lti, r.maxLti] } : r.maxLti;
  return {
    v: 1,
    kind: 'quote',
    pack: 'mortgage@1',
    title,
    inputs: ['income_annual', 'monthly_commitments', 'savings', 'missed_payments_12m', 'employment'],
    terms: ['price_band', 'term_years', 'group_size'],
    let: {
      // The price band's lower bound: a conservative estimate of the purchase price.
      price: v('price_band'),
      deposit: { min: [v('savings'), { '*': [v('price'), 0.4] }] },
      loan: { '-': [v('price'), v('deposit')] },
      ltv: { '/': [v('loan'), v('price')] },
      group_off: r.group ? { if: [{ '>=': [v('group_size'), r.group.minMembers] }, r.group.off, 0] } : 0,
      rate: { '-': [{ '+': [{ band: { of: v('ltv'), table: r.rates } }, { '*': [v('missed_payments_12m'), r.missedLoading ?? 0] }] }, v('group_off')] },
      stressed: { annuity: { principal: v('loan'), rate_pct: { '+': [v('rate'), r.stress] }, years: v('term_years') } },
      take_home: { '-': [{ '/': [{ '*': [v('income_annual'), 0.72] }, 12] }, v('monthly_commitments')] },
    },
    eligible: {
      and: [
        { '<=': [v('ltv'), maxLtv] },
        { '<=': [v('loan'), { '*': [v('income_annual'), lti] }] },
        { '<=': [v('missed_payments_12m'), r.maxMissed] },
        { '<=': [v('stressed'), { '*': [v('take_home'), r.affordShare] }] },
        ...(r.selfEmployed ? [] : [{ not: [{ has: ['employment', 'self-employed'] }] } as Expr]),
      ],
    },
    outputs: {
      rate: { round: [v('rate'), 2] },
      monthly: { round: [{ annuity: { principal: v('loan'), rate_pct: v('rate'), years: v('term_years') } }, 0] },
      loan: { round: [v('loan'), -3] },
      ltv_pct: { round: [{ '*': [v('ltv'), 100] }, 0] },
      max_loan: { round: [{ min: [{ '*': [v('income_annual'), lti] }, { '*': [v('price'), maxLtv] }] }, -3] },
      group_off: v('group_off'),
    },
    labels: {
      rate: { label: 'Rate', unit: '%' },
      monthly: { label: 'Monthly payment', unit: 'GBP' },
      loan: { label: 'Loan', unit: 'GBP' },
      ltv_pct: { label: 'Loan to value', unit: '%' },
      max_loan: { label: 'Most they would lend', unit: 'GBP' },
      group_off: { label: 'Group discount', unit: '%' },
    },
    output: 'owner',
  };
}

const lender = (name: string, slug: string, r: LenderRules, extra: Omit<QuoterExample, 'name' | 'domain' | 'program'> = {}, group?: LenderRules['group']): QuoterExample =>
  ({ name, domain: `${slug}.lake.local`, program: lenderProgram(`${name}: agreement in principle`, { ...r, group }), ...extra });

/** Fictional lenders with different appetites, so offers genuinely differ. Most also bid for groups: a discount when enough households ask together. */
export const LENDERS: QuoterExample[] = [
  lender('Northern Mutual', 'northern-mutual', { rates: [[0.6, 4.09], [0.75, 4.24], [0.85, 4.49], [0.9, 4.79], [0.95, 5.19]], maxLti: 4.5, maxMissed: 0, stress: 3, affordShare: 0.4, selfEmployed: true },
    { feeOnAccept: 400 }, { off: 0.2, minMembers: 3 }),
  lender('Harbourside Bank', 'harbourside', { rates: [[0.6, 3.99], [0.75, 4.19], [0.85, 4.59], [0.9, 4.99]], maxLti: 4.75, maxMissed: 0, stress: 3, affordShare: 0.38, selfEmployed: false },
    { feeOnAccept: 350 }, { off: 0.25, minMembers: 3 }),
  lender('Peak Building Society', 'peak-bs', { rates: [[0.75, 4.59], [0.9, 4.89], [0.95, 5.09]], maxLti: 4.5, higherLti: { from: 50_000, lti: 5 }, maxMissed: 1, missedLoading: 0.35, stress: 3, affordShare: 0.42, selfEmployed: true },
    { feeOnAccept: 300 }, { off: 0.15, minMembers: 3 }),
  lender('Greenway Bank', 'greenway', { rates: [[0.6, 3.89], [0.75, 4.09], [0.85, 4.39]], maxLti: 4.5, maxMissed: 0, stress: 3, affordShare: 0.35, selfEmployed: false },
    { feeOnAccept: 500 }, { off: 0.3, minMembers: 3 }),
  lender('Old Quay Mutual', 'old-quay', { rates: [[0.6, 4.19], [0.75, 4.29], [0.85, 4.49], [0.9, 4.69], [0.95, 4.99]], maxLti: 4.25, maxMissed: 2, missedLoading: 0.25, stress: 3, affordShare: 0.42, selfEmployed: true },
    { feeOnAccept: 250 }),
  lender('Brightstone Bank', 'brightstone', { rates: [[0.75, 4.14], [0.85, 4.34], [0.9, 4.64]], maxLti: 4.5, higherLti: { from: 75_000, lti: 5.5 }, maxMissed: 0, stress: 3, affordShare: 0.4, selfEmployed: false },
    { feeOnAccept: 450 }, { off: 0.2, minMembers: 3 }),
  lender('Riverside Building Society', 'riverside-bs', { rates: [[0.6, 4.29], [0.75, 4.39], [0.85, 4.59], [0.9, 4.79], [0.95, 5.29]], maxLti: 4.5, maxMissed: 3, missedLoading: 0.5, stress: 3, affordShare: 0.42, selfEmployed: true },
    { feeOnAccept: 300 }, { off: 0.1, minMembers: 3 }),
  lender('Capital Home Loans', 'capital-home', { rates: [[0.6, 3.95], [0.75, 4.15]], maxLti: 4.5, maxMissed: 0, stress: 3, affordShare: 0.38, selfEmployed: false },
    { feeOnAccept: 600 }, { off: 0.2, minMembers: 3 }),
];
