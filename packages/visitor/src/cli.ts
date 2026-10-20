#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { lakeAgentApp, LakeLink, loadOrCreateIdentity, signMessage, type LakeData } from '@thelakeprotocol/core';
import { dispatch, readmissionStudy } from './dispatch.js';
import { knock, makeVisitor, PRESETS, type Tamper } from './knock.js';

const HELP = `lake — talk to the Lake

  lake knock <house-url> [--offer research|gp|marketing|injection] [--as <domain>]
             [--purpose p --fields a,b --price 2 --retention none] [--note "..."]
             [--tamper forge-card|unsigned|replay|impersonate] [--json]

  lake dispatch [--goal "Do over-60s on drug X get readmitted less?"] [--price 2] [--as uni.example]
                [--extra-fields postcode] [--epsilon 2] [--node http://lake-node:7000]
                [--ethics http://ethics:4500] [--auditor http://auditor:4400] [--port 4800] [--json]

Coming: lake attack · lake revoke · lake reset (milestones 4–6)`;

const [cmd, ...rest] = process.argv.slice(2);
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
    goal: { type: 'string', default: 'Do over-60s on drug X get readmitted less?' },
    'extra-fields': { type: 'string' },
    epsilon: { type: 'string', default: '2' },
    node: { type: 'string', default: process.env.LAKE_NODE_URL ?? 'http://lake-node:7000' },
    ethics: { type: 'string', default: process.env.LAKE_ETHICS_URL ?? 'http://ethics:4500' },
    auditor: { type: 'string', default: process.env.LAKE_AUDITOR_URL ?? 'http://auditor:4400' },
    port: { type: 'string', default: '4800' },
    json: { type: 'boolean', default: false },
  },
});

if (cmd === 'knock') await knockCmd();
else if (cmd === 'dispatch') await dispatchCmd();
else {
  console.log(HELP);
  process.exit(cmd && cmd !== 'help' ? 2 : 0);
}

async function knockCmd() {
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
  if (a.json) return void console.log(JSON.stringify({ offer, reply }, null, 2));
  console.log(`→ ${domain} offers $${offer.priceUsd} for ${offer.fields.join(', ')} (${offer.purpose}, retention ${offer.retention})${a.tamper !== 'none' ? `  [tamper: ${a.tamper}]` : ''}`);
  if (reply.kind === 'rejected') return void console.log(`✗ REJECTED (${reply.code}): ${reply.why}`);
  console.log(`← ${String(reply.decision).toUpperCase()}: ${reply.reason}`);
  if (reply.counter) console.log(`  counter: ${JSON.stringify(reply.counter)}`);
  if (reply.grant) console.log(`  grant: ${reply.grantHours} hours, signed under the owner's standing rule, stored in their pod`);
  console.log(`  holds: ${(reply.holds as string[]).join(', ') || 'none of those fields'}`);
  for (const n of reply.notes as string[]) console.log(`  note: ${n}`);
}

async function dispatchCmd() {
  const domain = a.as ?? 'uni.example';
  const port = Number(a.port);
  // Serve our card while the mission runs, so a node can verify it and show us on the map.
  const url = `http://${existsSync('/.dockerenv') ? hostname() : 'localhost'}:${port}/a2a`;
  const id = await loadOrCreateIdentity(`${homedir()}/.lake/visitor-${domain}.json`);
  const visitor = await makeVisitor(id, domain, `Research agent (${domain})`, url);
  const reply = async (): Promise<LakeData> => ({ lake: '0.1', card: visitor.card, envelope: (await signMessage({ kind: 'rejected', code: 'busy', why: 'a research agent on a mission' }, id, { iss: visitor.webId })) as LakeData['envelope'] });
  const server = lakeAgentApp(visitor.card, reply).listen(port);
  const link = new LakeLink({ nodeUrl: a.node!.replace(/\/$/, ''), card: visitor.card, identity: id, webId: visitor.webId });
  await link.register(6);

  const say = (step: string, detail: string) => { if (!a.json) console.log(`${step.toUpperCase().padEnd(9)} ${detail}`); };
  say('dispatch', `"${a.goal}"  (as ${domain}, $${a.price ?? 2} per participant)`);
  try {
    const r = await dispatch({
      visitor, node: a.node!, ethics: a.ethics!, auditor: a.auditor!, link, log: say,
      study: readmissionStudy(a.goal, Number(a.epsilon)),
      priceUsd: Number(a.price ?? 2),
      extraFields: a['extra-fields']?.split(',').filter(Boolean),
    });
    if (a.json) console.log(JSON.stringify(r, null, 2));
    else {
      for (const x of r.excluded) console.log(`EXCLUDED  ${x.house}: ${x.why}`);
      console.log(`DONE      ${r.participants} answers from ${r.houses} houses in ${r.seconds}s. Records moved: see the map (computed from each house's audit log).`);
    }
  } finally {
    server.close();
  }
}
