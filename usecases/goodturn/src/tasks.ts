import type { DeedTask } from '@thelakeprotocol/core';

/**
 * Small online volunteer tasks the demo charity certifies (synthetic material; the checks are here in the open, so this
 * is a demo of the mechanism, not of who did the work). Each passing answer earns one deed: an hour of community service.
 */
export const TASKS: DeedTask[] = [
  {
    id: 'sort-pantry',
    title: 'Sort a food bank delivery',
    ask: 'Open Hands food bank got this delivery. Put each item on its shelf: tinned, fresh or dry. Items: baked beans (tin), carrots (bag), rice (2 kg), tuna (tin), apples (crate), pasta (500 g), chickpeas (tin), spinach (bunch).',
    answer_shape: { 'baked beans': 'tinned | fresh | dry', carrots: '…', rice: '…', tuna: '…', apples: '…', pasta: '…', chickpeas: '…', spinach: '…' },
    check: { expected: { 'baked beans': 'tinned', carrots: 'fresh', rice: 'dry', tuna: 'tinned', apples: 'fresh', pasta: 'dry', chickpeas: 'tinned', spinach: 'fresh' }, min: 0.85 },
  },
  {
    id: 'donation-slip',
    title: 'Type up a donation slip',
    ask: 'Type up this handwritten donation slip for the records: "Ref DS-4471 / dropped off 3 Nov 2026 at Northside / 14 items, 9.5 kg / tinned soup, nappies".',
    answer_shape: { ref: 'DS-…', date: 'YYYY-MM-DD', site: '…', items: 'number', weight_kg: 'number' },
    check: { expected: { ref: 'DS-4471', date: '2026-11-03', site: 'Northside', items: '14', weight_kg: '9.5' } },
  },
  {
    id: 'proofread-flyer',
    title: 'Proofread a volunteer flyer',
    ask: 'Which of these lines from our flyer have a spelling mistake? 1: "Volunteers needed on Saturday mornings". 2: "Bring a freind, bring a smile". 3: "No experiance needed". 4: "Tea and biscuits provided".',
    answer_shape: { '1': 'yes | no', '2': '…', '3': '…', '4': '…' },
    check: { expected: { '1': 'no', '2': 'yes', '3': 'yes', '4': 'no' } },
  },
  {
    id: 'roster',
    title: 'Fill a gap in the roster',
    ask: 'Our Saturday roster needs two people at the van at 9am. Mia can do 8-11, Tom 10-12, Ana 9-10, Raj 12-2. Who covers 9am?',
    answer_shape: { first: 'name', second: 'name' },
    check: { expected: { first: 'Mia', second: 'Ana' } },
  },
];
