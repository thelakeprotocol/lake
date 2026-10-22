import { readFileSync } from 'node:fs';
import { seedFrom, type LakePack } from '@thelakeprotocol/core';
import { CONVERTER, extractClaims } from './convert.js';
import { LENDERS } from './lenders.js';
import { syntheticStatements } from './synthetic.js';

const M = 'https://lake.doneinfifty.com/usecases/mortgage/v1#';
const OB = 'https://openbankinguk.github.io/read-write-api-site3/v3.1.11/resources-and-data-models/aisp/';

/** Mortgages: a person's finances, from bank statements a trusted bank signs, priced by lenders inside their house. */
export const mortgage: LakePack = {
  id: 'mortgage',
  version: '1.0.0',
  title: 'Mortgage offers',
  vocab: M,
  folder: 'finance/',
  recordClass: `${M}FinanceRecord`,
  fields: {
    income_annual: { class: `${M}IncomeAnnual`, kind: 'number', unit: 'GBP', label: 'yearly income (estimated, gross)', standard: `${OB}Transactions.html` },
    monthly_commitments: { class: `${M}MonthlyCommitments`, kind: 'number', unit: 'GBP', label: 'monthly loan and card payments', standard: `${OB}DirectDebits.html` },
    savings: { class: `${M}Savings`, kind: 'number', unit: 'GBP', label: 'savings', standard: `${OB}Balances.html` },
    missed_payments_12m: { class: `${M}MissedPayments`, kind: 'number', label: 'missed payments in the last year', standard: `${OB}Transactions.html` },
    employment: { class: `${M}Employment`, kind: 'code', label: 'employment', standard: 'https://schema.org/employmentType' },
  },
  identifying: ['name', 'dob', 'address', 'account_number', 'sort_code', 'email', 'phone'],
  shapes: readFileSync(new URL('../shapes.ttl', import.meta.url), 'utf8'),
  source: {
    credentialType: 'LakeBankStatementCredential',
    converter: CONVERTER,
    mediaType: 'application/json',
    originalName: 'statements.json',
    issuer: { name: 'Demo Bank', description: 'Signs synthetic bank statements (Open Banking style) as Verifiable Credentials. Synthetic data only.', domain: 'bank.lake.local', path: 'bank' },
    convert: (original) => extractClaims(JSON.parse(original)),
    // Seeded by the WebID's path, not its host: the same person has the same finances wherever their pod runs.
    synthetic: (subject, asOf) => JSON.stringify(syntheticStatements(seedFrom(subject.replace(/^https?:\/\/[^/]+/, '')), asOf)),
  },
  intent: {
    terms: {
      region: { kind: 'code', label: 'Region', options: ['north-west', 'north-east', 'yorkshire', 'midlands', 'east', 'london', 'south-east', 'south-west', 'wales', 'scotland'] },
      price_band: { kind: 'band', label: 'Price', options: ['100000-149999', '150000-199999', '200000-249999', '250000-299999', '300000-399999', '400000-499999'] },
      term_years: { kind: 'number', label: 'Term (years)', options: [25, 30, 35] },
      first_time_buyer: { kind: 'code', label: 'First-time buyer', options: ['yes', 'no'] },
    },
    groupBy: ['region', 'price_band', 'first_time_buyer'],
    // `price_band: auto` picks the highest band the owner could plausibly borrow for: about 4.5× income plus most of their savings.
    auto: (claims) => {
      const n = (f: string) => Number(claims.find((c) => c.field === f)?.value ?? 0);
      const reach = n('income_annual') * 4.5 + n('savings') * 0.9;
      const bands = ['100000-149999', '150000-199999', '200000-249999', '250000-299999', '300000-399999', '400000-499999'];
      return { price_band: [...bands].reverse().find((b) => Number.parseInt(b, 10) <= reach) ?? bands[0]! };
    },
  },
  authority: {
    name: 'Financial Register (demo)',
    description: 'Authorises lenders to quote. The demo stand-in for a real register of authorised firms, like the FCA register.',
    domain: 'register.lake.local',
    path: 'register',
    register: LENDERS.map((l) => l.domain),
  },
  release: ['original', 'credential'],
  examples: { quoters: LENDERS },
};
