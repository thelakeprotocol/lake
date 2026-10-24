import type { QuoteProgram, QuoterExample } from '@thelakeprotocol/core';
import { dbl, taxExpr } from './tax.js';

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

const table = (rows: [number, number][]) => `[${rows.map(([a, b]) => `[${dbl(a)}, ${dbl(b)}]`).join(', ')}]`;

export function lenderProgram(title: string, r: LenderRules): QuoteProgram {
  const maxLvr = r.rates.at(-1)![0];
  // The state's cap, read from the owner's own intent.
  const cap = Object.entries(FHG_CAPS).reduceRight((rest, [state, c]) => `region == '${state}' ? ${dbl(c)} : ${rest}`, '0.0');
  return {
    v: 2,
    kind: 'quote',
    pack: 'mortgage@1',
    title,
    inputs: ['income_annual', 'monthly_commitments', 'savings', 'missed_payments_12m', 'employment'],
    terms: ['region', 'price_band', 'term_years', 'first_time_buyer', 'group_size'],
    let: {
      // The price band's lower bound: a conservative estimate of the purchase price.
      price: 'price_band',
      fhg: r.fhg ? `first_time_buyer == 'yes' && price <= (${cap})` : 'false',
      // Some savings go on stamp duty and fees; the rest is the deposit, up to 40%.
      deposit: 'min(savings * 0.85, price * 0.4)',
      base_loan: 'price - deposit',
      lvr: 'base_loan / price',
      lmi: `fhg ? 0.0 : base_loan * band(lvr, ${table([...LMI, [1e9, 0.05]])})`,
      loan: 'base_loan + lmi',
      group_off: r.group ? `group_size >= ${dbl(r.group.minMembers)} ? ${dbl(r.group.off)} : 0.0` : '0.0',
      rate: `band(lvr, ${table(r.rates)}) + missed_payments_12m * ${dbl(r.missedLoading ?? 0)} - group_off`,
      stressed: `annuity(loan, rate + ${dbl(BUFFER)}, term_years)`,
      take_home: `(income_annual - ${taxExpr('income_annual')}) / 12.0`,
      surplus: `take_home - ${dbl(r.living)} - monthly_commitments`,
    },
    eligible: [
      `lvr <= ${dbl(maxLvr)}`,
      `loan <= income_annual * ${dbl(r.maxDti)}`,
      `missed_payments_12m <= ${dbl(r.maxMissed)}`,
      'stressed <= surplus',
      ...(r.selfEmployed ? [] : ["!('self-employed' in employment)"]),
    ].join(' && '),
    outputs: {
      rate: 'round(rate, 2)',
      monthly: 'round(annuity(loan, rate, term_years), 0)',
      loan: 'round(loan, -3)',
      lvr_pct: 'round(lvr * 100.0, 0)',
      lmi: 'round(lmi, -2)',
      first_home_guarantee: 'fhg ? 1.0 : 0.0',
      max_loan: `round(min(income_annual * ${dbl(r.maxDti)}, price * ${dbl(maxLvr)}), -3)`,
      group_off: 'group_off',
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
