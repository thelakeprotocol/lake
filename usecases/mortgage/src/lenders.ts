import type { Expr, QuoteProgram, QuoterExample } from '@thelakeprotocol/core';
import { taxExpr } from './tax.js';

/**
 * How an Australian lender decides, simplified from how they really do it, as a quote program the house
 * runs on its own data. Loan-to-value (LVR) sets the rate; above 80% the borrower pays lenders mortgage
 * insurance (LMI), added to the loan, unless the First Home Guarantee covers them. Serviceability follows
 * APRA: the repayment at the rate plus a 3-point buffer must fit what's left of take-home pay after a
 * living-expense benchmark and other commitments; debt-to-income stays under the lender's cap (APRA limits
 * lending at 6× or more). Recent dishonoured payments count against you. All of it happens inside the
 * house; only the owner sees the result.
 */
export interface LenderRules {
  /** [max LVR, rate %] bands, cheapest first. Above the last band: not eligible. */
  rates: [number, number][];
  /** Maximum loan as a multiple of gross income. */
  maxDti: number;
  /** Dishonoured payments in the last 12 months it accepts, and what each one adds to the rate. */
  maxMissed: number;
  missedLoading?: number;
  /** Monthly living expenses it assumes for a single applicant (its HEM-style benchmark). */
  living: number;
  selfEmployed: boolean;
  /** Takes part in the First Home Guarantee: 5% deposit, no LMI, under the state's price cap. */
  fhg: boolean;
  /** Its offer to a group: this much off the rate when at least `minMembers` households share the intent. */
  group?: { off: number; minMembers: number };
}

/** APRA's serviceability buffer, in percentage points over the loan's rate. */
export const BUFFER = 3;

/** First Home Guarantee property price caps from 1 October 2025, capital-city figures (simplified to one per state). */
export const FHG_CAPS: Record<string, number> = { nsw: 1_500_000, vic: 950_000, qld: 1_000_000, wa: 850_000, sa: 900_000, tas: 700_000, act: 1_000_000, nt: 600_000 };

/** LMI premium as a share of the loan, by LVR band. Indicative; real premiums vary by insurer and loan size. */
const LMI: [number, number][] = [[0.8, 0], [0.85, 0.012], [0.9, 0.022], [0.95, 0.036]];

const v = (name: string): Expr => ({ var: name });

export function lenderProgram(title: string, r: LenderRules): QuoteProgram {
  const maxLvr = r.rates.at(-1)![0];
  // The state's cap, as a chain of `is` checks on the owner's own intent.
  const cap = Object.entries(FHG_CAPS).reduceRight<Expr>((rest, [state, c]) => ({ if: [{ is: ['region', state] }, c, rest] }), 0);
  return {
    v: 1,
    kind: 'quote',
    pack: 'mortgage@1',
    title,
    inputs: ['income_annual', 'monthly_commitments', 'savings', 'missed_payments_12m', 'employment'],
    terms: ['region', 'price_band', 'term_years', 'first_time_buyer', 'group_size'],
    let: {
      // The price band's lower bound: a conservative estimate of the purchase price.
      price: v('price_band'),
      fhg: r.fhg ? { and: [{ is: ['first_time_buyer', 'yes'] }, { '<=': [v('price'), cap] }] } : false,
      // Some savings go on stamp duty and fees; the rest is the deposit, up to 40%.
      deposit: { min: [{ '*': [v('savings'), 0.85] }, { '*': [v('price'), 0.4] }] },
      base_loan: { '-': [v('price'), v('deposit')] },
      lvr: { '/': [v('base_loan'), v('price')] },
      lmi: { if: [v('fhg'), 0, { '*': [v('base_loan'), { band: { of: v('lvr'), table: LMI, else: 0.05 } }] }] },
      loan: { '+': [v('base_loan'), v('lmi')] },
      group_off: r.group ? { if: [{ '>=': [v('group_size'), r.group.minMembers] }, r.group.off, 0] } : 0,
      rate: { '-': [{ '+': [{ band: { of: v('lvr'), table: r.rates } }, { '*': [v('missed_payments_12m'), r.missedLoading ?? 0] }] }, v('group_off')] },
      stressed: { annuity: { principal: v('loan'), rate_pct: { '+': [v('rate'), BUFFER] }, years: v('term_years') } },
      take_home: { '/': [{ '-': [v('income_annual'), taxExpr(v('income_annual'))] }, 12] },
      surplus: { '-': [v('take_home'), r.living, v('monthly_commitments')] },
    },
    eligible: {
      and: [
        { '<=': [v('lvr'), maxLvr] },
        { '<=': [v('loan'), { '*': [v('income_annual'), r.maxDti] }] },
        { '<=': [v('missed_payments_12m'), r.maxMissed] },
        { '<=': [v('stressed'), v('surplus')] },
        ...(r.selfEmployed ? [] : [{ not: [{ has: ['employment', 'self-employed'] }] } as Expr]),
      ],
    },
    outputs: {
      rate: { round: [v('rate'), 2] },
      monthly: { round: [{ annuity: { principal: v('loan'), rate_pct: v('rate'), years: v('term_years') } }, 0] },
      loan: { round: [v('loan'), -3] },
      lvr_pct: { round: [{ '*': [v('lvr'), 100] }, 0] },
      lmi: { round: [v('lmi'), -2] },
      first_home_guarantee: { if: [v('fhg'), 1, 0] },
      max_loan: { round: [{ min: [{ '*': [v('income_annual'), r.maxDti] }, { '*': [v('price'), maxLvr] }] }, -3] },
      group_off: v('group_off'),
    },
    labels: {
      rate: { label: 'Rate (variable)', unit: '%' },
      monthly: { label: 'Monthly repayment', unit: 'AUD' },
      loan: { label: 'Loan', unit: 'AUD' },
      lvr_pct: { label: 'Loan to value (LVR)', unit: '%' },
      lmi: { label: 'Lenders mortgage insurance (added to the loan)', unit: 'AUD' },
      first_home_guarantee: { label: 'First Home Guarantee', unit: 'yes/no' },
      max_loan: { label: 'Most they would lend', unit: 'AUD' },
      group_off: { label: 'Group discount', unit: '%' },
    },
    output: 'owner',
  };
}

const lender = (name: string, slug: string, r: Omit<LenderRules, 'group'>, feeOnAccept: number, group?: LenderRules['group']): QuoterExample =>
  ({ name, domain: `${slug}.lake.local`, program: lenderProgram(`${name}: conditional approval`, { ...r, group }), feeOnAccept, currency: 'AUD' });

/**
 * Fictional Australian lenders with different appetites, so offers genuinely differ: variable owner-occupier
 * rates around 5.5–6.6% (late 2026), a specialist non-bank for the self-employed and those with a blemish.
 * Most also bid for groups: a discount when enough households ask together.
 */
export const LENDERS: QuoterExample[] = [
  lender('Wattle Mutual', 'wattle-mutual', { rates: [[0.6, 5.59], [0.7, 5.64], [0.8, 5.74], [0.9, 6.04], [0.95, 6.24]], maxDti: 6, maxMissed: 0, living: 2_300, selfEmployed: true, fhg: true },
    600, { off: 0.15, minMembers: 3 }),
  lender('Ironbark Bank', 'ironbark', { rates: [[0.6, 5.69], [0.7, 5.74], [0.8, 5.84], [0.9, 6.19], [0.95, 6.44]], maxDti: 6, maxMissed: 0, living: 2_500, selfEmployed: true, fhg: true },
    900, { off: 0.2, minMembers: 3 }),
  lender('Coral Coast Bank', 'coral-coast', { rates: [[0.8, 5.79], [0.9, 6.09], [0.95, 6.29]], maxDti: 6, maxMissed: 1, missedLoading: 0.3, living: 2_200, selfEmployed: true, fhg: true },
    500, { off: 0.25, minMembers: 3 }),
  lender('Red Gum Building Society', 'red-gum', { rates: [[0.6, 5.54], [0.8, 5.69], [0.9, 5.99]], maxDti: 5.5, maxMissed: 0, living: 2_300, selfEmployed: false, fhg: false },
    550, { off: 0.2, minMembers: 3 }),
  lender('Saltbush Home Loans', 'saltbush', { rates: [[0.6, 6.39], [0.8, 6.59], [0.9, 7.09]], maxDti: 6, maxMissed: 3, missedLoading: 0.5, living: 2_200, selfEmployed: true, fhg: false },
    400),
  lender('Bluewater Bank', 'bluewater', { rates: [[0.6, 5.49], [0.7, 5.54], [0.8, 5.64]], maxDti: 6, maxMissed: 0, living: 2_400, selfEmployed: false, fhg: false },
    700, { off: 0.15, minMembers: 3 }),
  lender('Kestrel Bank', 'kestrel', { rates: [[0.7, 5.79], [0.8, 5.89], [0.9, 6.14], [0.95, 6.39]], maxDti: 6, maxMissed: 1, missedLoading: 0.25, living: 2_600, selfEmployed: true, fhg: true },
    650, { off: 0.2, minMembers: 3 }),
  lender('Paperbark Credit Union', 'paperbark', { rates: [[0.6, 5.64], [0.8, 5.79], [0.9, 6.09], [0.95, 6.34]], maxDti: 5.5, maxMissed: 2, missedLoading: 0.25, living: 2_100, selfEmployed: true, fhg: true },
    450, { off: 0.1, minMembers: 3 }),
];
