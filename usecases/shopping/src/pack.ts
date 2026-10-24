import { readFileSync } from 'node:fs';
import { seedFrom, type LakePack } from '@thelakeprotocol/core';
import { CONVERTER, extractClaims } from './convert.js';
import { GROCERS } from './grocers.js';
import { syntheticReceipts } from './synthetic.js';

const S = 'https://lake.doneinfifty.com/usecases/shopping/v1#';
export const STATES: Record<string, string> = {
  nsw: 'New South Wales', vic: 'Victoria', qld: 'Queensland', wa: 'Western Australia', sa: 'South Australia', tas: 'Tasmania', act: 'Australian Capital Territory', nt: 'Northern Territory',
};
/** Weekly budgets on offer, "up to" in Australian dollars. */
export const BUDGETS = [60, 90, 130, 180, 250, 350];

/**
 * The weekly food shop: a household says what it needs, and grocers' agents price the basket inside the house, on the
 * household's own receipt history. Only the owner sees the offers; nothing leaves until they accept one, and then only
 * the shopping list goes to that one grocer.
 */
export const shopping: LakePack = {
  id: 'shopping',
  version: '1.0.0',
  title: 'Weekly shop',
  vocab: S,
  folder: 'household/',
  recordClass: `${S}HouseholdRecord`,
  fields: {
    household_size: { class: `${S}HouseholdSize`, kind: 'number', label: 'people in the household', standard: 'https://schema.org/numberOfPeople' },
    // Diets can say something about health or belief: special-category data, so a house warns before it goes to anyone deciding about you.
    dietary_needs: { class: `${S}DietaryNeed`, kind: 'code', label: 'dietary needs', standard: 'https://schema.org/RestrictedDiet', special: true },
    staples: { class: `${S}Staple`, kind: 'code', label: 'staples bought most weeks', standard: 'https://schema.org/Product' },
    weekly_spend: { class: `${S}WeeklySpend`, kind: 'number', unit: 'AUD', label: 'average weekly spend' },
  },
  identifying: ['name', 'address', 'email', 'phone', 'card_number'],
  shapes: readFileSync(new URL('../shapes.ttl', import.meta.url), 'utf8'),
  source: {
    credentialType: 'LakeReceiptHistoryCredential',
    converter: CONVERTER,
    mediaType: 'application/json',
    originalName: 'receipts.json',
    issuer: { name: 'Demo Receipt Wallet', description: 'Signs a household\'s synthetic grocery receipts as Verifiable Credentials. Synthetic data only.', domain: 'receipts.lake.local', path: 'receipts' },
    convert: (original) => extractClaims(JSON.parse(original)),
    synthetic: (subject, asOf) => JSON.stringify(syntheticReceipts(seedFrom(subject.replace(/^https?:\/\/[^/]+/, '')), asOf)),
  },
  intent: {
    terms: {
      region: { kind: 'code', label: 'State or territory', options: Object.keys(STATES), names: STATES },
      budget: { kind: 'number', label: 'Up to (a week)', unit: 'AUD', options: BUDGETS },
      delivery: { kind: 'code', label: 'Delivered', options: ['tomorrow', 'this-week'] },
    },
    groupBy: ['region', 'delivery'],
    // `budget: auto`: the smallest budget above what this household usually spends.
    auto: (claims) => {
      const spend = Number(claims.find((c) => c.field === 'weekly_spend')?.value ?? 0);
      return { budget: BUDGETS.find((b) => b >= spend * 1.1) ?? BUDGETS.at(-1)! };
    },
  },
  authority: {
    name: 'Food Business Register (demo)',
    description: 'Authorises grocers to quote. The demo stand-in for a real register of food businesses.',
    domain: 'foodregister.lake.local',
    path: 'foodregister',
    register: GROCERS.map((g) => g.domain),
  },
  // On acceptance only the shopping list goes, to that one grocer: not eight weeks of receipts.
  release: ['claims'],
  releaseFields: ['household_size', 'dietary_needs', 'staples'],
  examples: { quoters: GROCERS },
};
