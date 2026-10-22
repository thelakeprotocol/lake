import { readFileSync } from 'node:fs';
import { seedFrom, type LakePack } from '@thelakeprotocol/core';
import { CONVERTER, extractClaims } from './convert.js';
import { LENDERS } from './lenders.js';
import { syntheticStatements } from './synthetic.js';

const M = 'https://lake.doneinfifty.com/usecases/mortgage/v1#';
const CDR = 'https://consumerdatastandardsaustralia.github.io/standards/';
/** Price bands (Australian dollars), cheapest first. A band's lower bound is the price lenders assume. */
export const PRICE_BANDS = ['200000-299999', '300000-449999', '450000-599999', '600000-749999', '750000-899999', '900000-1099999', '1100000-1399999', '1400000-1799999'];
export const STATES: Record<string, string> = {
  nsw: 'New South Wales', vic: 'Victoria', qld: 'Queensland', wa: 'Western Australia', sa: 'South Australia', tas: 'Tasmania', act: 'Australian Capital Territory', nt: 'Northern Territory',
};

/** Australian home loans: a person's finances, from bank data a trusted bank signs, priced by lenders inside their house. */
export const mortgage: LakePack = {
  id: 'mortgage',
  version: '1.0.0',
  title: 'Mortgage offers',
  vocab: M,
  folder: 'finance/',
  recordClass: `${M}FinanceRecord`,
  fields: {
    income_annual: { class: `${M}IncomeAnnual`, kind: 'number', unit: 'AUD', label: 'yearly income (estimated, gross)', standard: `${CDR}#get-transactions-for-account` },
    monthly_commitments: { class: `${M}MonthlyCommitments`, kind: 'number', unit: 'AUD', label: 'monthly loan, card and buy-now-pay-later payments', standard: `${CDR}#get-direct-debits-for-account` },
    savings: { class: `${M}Savings`, kind: 'number', unit: 'AUD', label: 'savings', standard: `${CDR}#get-bulk-balances` },
    missed_payments_12m: { class: `${M}MissedPayments`, kind: 'number', label: 'dishonoured payments in the last year', standard: `${CDR}#get-transactions-for-account` },
    employment: { class: `${M}Employment`, kind: 'code', label: 'employment', standard: 'https://schema.org/employmentType' },
  },
  identifying: ['name', 'dob', 'address', 'bsb', 'account_number', 'tfn', 'email', 'phone'],
  shapes: readFileSync(new URL('../shapes.ttl', import.meta.url), 'utf8'),
  source: {
    credentialType: 'LakeBankStatementCredential',
    converter: CONVERTER,
    mediaType: 'application/json',
    originalName: 'statements.json',
    issuer: { name: 'Demo Bank', description: 'Signs synthetic bank data (Consumer Data Right style) as Verifiable Credentials. Synthetic data only.', domain: 'bank.lake.local', path: 'bank' },
    convert: (original) => extractClaims(JSON.parse(original)),
    // Seeded by the WebID's path, not its host: the same person has the same finances wherever their pod runs.
    synthetic: (subject, asOf) => JSON.stringify(syntheticStatements(seedFrom(subject.replace(/^https?:\/\/[^/]+/, '')), asOf)),
  },
  intent: {
    terms: {
      region: { kind: 'code', label: 'State or territory', options: Object.keys(STATES), names: STATES },
      price_band: { kind: 'band', label: 'Price', unit: 'AUD', options: PRICE_BANDS },
      term_years: { kind: 'number', label: 'Term (years)', options: [25, 30] },
      first_time_buyer: { kind: 'code', label: 'First home buyer', options: ['yes', 'no'] },
    },
    groupBy: ['region', 'price_band', 'first_time_buyer'],
    // `price_band: auto` picks the highest band the owner could plausibly borrow for: about 4.5× income plus most of their savings.
    auto: (claims) => {
      const n = (f: string) => Number(claims.find((c) => c.field === f)?.value ?? 0);
      const reach = n('income_annual') * 4.5 + n('savings') * 0.85;
      return { price_band: [...PRICE_BANDS].reverse().find((b) => Number.parseInt(b, 10) <= reach) ?? PRICE_BANDS[0]! };
    },
  },
  authority: {
    name: 'Credit Licence Register (demo)',
    description: 'Authorises lenders to quote. The demo stand-in for a real register of licensed lenders, like ASIC\'s register of Australian credit licensees.',
    domain: 'register.lake.local',
    path: 'register',
    register: LENDERS.map((l) => l.domain),
  },
  release: ['original', 'credential'],
  examples: { quoters: LENDERS },
};
