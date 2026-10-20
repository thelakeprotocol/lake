#!/usr/bin/env node
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { loadOrCreateIdentity } from '@thelakeprotocol/core';
import { knock, makeVisitor, PRESETS, type Tamper } from './knock.js';

const HELP = `lake — talk to the Lake

  lake knock <house-url> [--offer research|gp|marketing|injection] [--as <domain>]
             [--purpose p --fields a,b --price 2 --retention none] [--note "..."]
             [--tamper forge-card|unsigned|replay|impersonate] [--json]

Coming: lake dispatch · lake attack · lake revoke · lake reset (milestones 3–6)`;

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== 'knock') {
  console.log(HELP);
  process.exit(cmd ? 2 : 0);
}
const { positionals, values: a } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    offer: { type: 'string', default: 'research' },
    as: { type: 'string' },
    purpose: { type: 'string' },
    fields: { type: 'string' },
    price: { type: 'string' },
    retention: { type: 'string' },
    note: { type: 'string' },
    tamper: { type: 'string', default: 'none' },
    json: { type: 'boolean', default: false },
  },
});
const house = positionals[0] ?? 'http://localhost:4000';
const preset = PRESETS[a.offer!];
if (!preset) throw new Error(`unknown offer preset ${a.offer}; try ${Object.keys(PRESETS).join(', ')}`);
const domain = a.as ?? (a.offer === 'gp' ? 'gp.example' : a.offer === 'research' ? 'uni.example' : a.offer === 'injection' ? 'evil.example' : 'ads.example');
const terms = {
  ...preset,
  ...(a.purpose ? { purpose: a.purpose } : {}),
  ...(a.fields ? { fields: a.fields.split(',') } : {}),
  ...(a.price ? { priceUsd: Number(a.price) } : {}),
  ...(a.retention ? { retention: a.retention } : {}),
  ...(a.note ? { note: a.note } : {}),
};
const visitor = await makeVisitor(await loadOrCreateIdentity(`${homedir()}/.lake/visitor-${domain}.json`), domain);
const { offer, reply } = await knock(house, visitor, terms, a.tamper as Tamper);

if (a.json) {
  console.log(JSON.stringify({ offer, reply }, null, 2));
} else {
  console.log(`→ ${domain} offers $${offer.priceUsd} for ${offer.fields.join(', ')} (${offer.purpose}, retention ${offer.retention})${a.tamper !== 'none' ? `  [tamper: ${a.tamper}]` : ''}`);
  if (reply.kind === 'rejected') console.log(`✗ REJECTED (${reply.code}): ${reply.why}`);
  else {
    console.log(`← ${String(reply.decision).toUpperCase()}: ${reply.reason}`);
    if (reply.counter) console.log(`  counter: ${JSON.stringify(reply.counter)}`);
    if (reply.grantHours) console.log(`  key: ${reply.grantHours} hours, once the owner's approval flow mints it (milestone 4)`);
    console.log(`  holds: ${(reply.holds as string[]).join(', ') || 'none of those fields'}`);
    for (const n of reply.notes as string[]) console.log(`  note: ${n}`);
  }
}
