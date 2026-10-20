#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { cardUrlFor, lakeAgentApp, LakeLinks, loadOrCreateIdentity, signMessage, verifyLakeCard, type LakeData } from '@thelakeprotocol/core';
import { dispatch, makeHuman, readmissionStudy, SANDBOX_STUDIES } from './dispatch.js';
import type { Study } from '@thelakeprotocol/core';
import { attack, houseUrls, swarm } from './attack.js';
import { ask, knock, makeVisitor, PRESETS, type Tamper } from './knock.js';

const HELP = `lake — talk to the Lake

  lake knock <house-url> [--offer research|gp|marketing|injection] [--as <domain>]
             [--purpose p --fields a,b --price 2 --retention none] [--note "..."]
             [--tamper forge-card|unsigned|replay|impersonate] [--json]

  lake dispatch [--goal "Do over-60s on drug X get readmitted less?"] [--price 2] [--budget 5000] [--as uni.example]
                [--extra-fields postcode] [--epsilon 2] [--node http://lake-node:7000]
                [--ethics http://ethics:4500] [--auditor http://auditor:4400] [--payments http://payments:4600]
                [--wait 30] [--unpaid] [--concurrency 32] [--port 4800] [--json]

  lake demo [--pace 2000]          the on-stage script: dispatch (bloc, owner's tap), then an attacker
  lake reset                       demo reset: every node's counters, history and quarantines (needs LAKE_RESET_TOKEN)
  lake card <agent-url>            fetch and verify any agent's card from its own .well-known path (no node needed)
  lake ask <agent-url> <kind|json> [--as <domain>]   one signed message to any agent; prints its verified reply
                                   e.g. lake ask https://sandbox.lake.doneinfifty.com/s/guide/a2a hello
                                        lake ask <guide>/a2a '{"kind":"tour","step":2}'
  lake attack [--count 10] [--node http://lake-node:7000] [<house-url> …]
  lake sponsor [--every 600] [--as open-science.example]   sandbox life: a paid, certified study every few minutes,
                                   rotating questions, prices and asks, so new houses get knocked, bargain and get paid
  lake swarm [--traders 8] [--attackers 1] [--interval 2000] [--node http://lake-node:7000]`;

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
    wait: { type: 'string', default: '0' },
    concurrency: { type: 'string', default: '32' },
    pace: { type: 'string', default: '0' },
    budget: { type: 'string', default: '5000' },
    payments: { type: 'string', default: process.env.LAKE_PAYMENTS_URL ?? 'http://payments:4600' },
    unpaid: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    count: { type: 'string', default: '10' },
    traders: { type: 'string', default: '8' },
    attackers: { type: 'string', default: '1' },
    interval: { type: 'string', default: '2000' },
    every: { type: 'string', default: '600' },
  },
});

if (cmd === 'knock') await knockCmd();
else if (cmd === 'dispatch') await dispatchCmd();
else if (cmd === 'demo') {
  // The on-stage script (spec, "On-stage script"): pace it so people can follow on the map.
  const node = a.node!.split(',')[0]!.trim();
  const s = await (await fetch(`${node}/state`)).json();
  console.log(`THE LAKE  ${s.counters.houses} houses, ${s.counters.agents} agents, ${s.guilds?.length ?? 0} guilds. Records moved: ${s.counters.recordsMoved}.\n`);
  a.pace = a.pace === '0' ? '2000' : a.pace;
  a['extra-fields'] ??= 'postcode';
  a.wait = a.wait === '0' ? '20' : a.wait;
  await dispatchCmd();
  console.log('\nATTACK    releasing an attacker. Watch the houses block it and the Lake quarantine it.');
  const houses = await houseUrls(node);
  const r = await attack({ houses, count: 6, log: (l) => console.log(`          ${l}`) });
  console.log(`DONE      ${Object.entries(r.tally).map(([k, n]) => `${n} ${k}`).join(', ')}. No human involved.`);
}
else if (cmd === 'reset') {
  const t0 = Date.now();
  for (const node of a.node!.split(',').map((u) => u.trim())) {
    const res = await fetch(`${node}/reset`, { method: 'POST', headers: { 'x-lake-reset': process.env.LAKE_RESET_TOKEN ?? '' } }).catch((e: Error) => ({ ok: false, status: e.message }) as const);
    console.log(`${node}: ${res.ok ? 'reset' : `not reset (${res.status})`}`);
  }
  console.log(`done in ${Date.now() - t0} ms`);
} else if (cmd === 'card') {
  // Registries are search indexes, not gatekeepers: every agent can be found at its own address.
  const at = positionals[0];
  if (!at) throw new Error('lake card <agent url, e.g. https://house.example/a2a or https://house.example>');
  const url = at.endsWith('/a2a') ? cardUrlFor(at) : `${at.replace(/\/$/, '')}/.well-known/agent-card.json`;
  const card = await (await fetch(url, { headers: { 'A2A-Version': '1.0' } })).json();
  const p = await verifyLakeCard(card);
  console.log(a.json ? JSON.stringify(card, null, 2) : `✓ ${card.name} — signed card verified
  role ${p.role} · owner ${p.ownerDomain} · WebID ${p.webId}
  key ${p.publicJwk.kid} · tags ${p.tags.join(', ') || 'none'}
  A2A ${card.supportedInterfaces[0]?.url}`);
} else if (cmd === 'ask') {
  const [to, what] = positionals;
  if (!to || !what) throw new Error('lake ask <agent A2A url> <kind, or a JSON message>');
  const payload = what.trim().startsWith('{') ? JSON.parse(what) : { kind: what };
  const domain = a.as ?? 'cli.example';
  const me = await makeVisitor(await loadOrCreateIdentity(`${homedir()}/.lake/visitor-${domain}.json`), domain);
  const { reply, from } = await ask(to, me, payload);
  if (!a.json) console.log(`✓ signed reply from ${from.ownerDomain} (key ${from.publicJwk.kid}), verified`);
  const { nonce: _n, iat: _i, exp: _e, iss: _s, ...body } = reply;
  console.log(JSON.stringify(body, null, 2));
} else if (cmd === 'attack') {
  const houses = positionals.length ? positionals : await houseUrls(a.node!);
  const r = await attack({ houses, count: Number(a.count), log: (l) => console.log(l) });
  console.log(`DONE      attacker ${r.domain}: ${Object.entries(r.tally).map(([k, n]) => `${n} ${k}`).join(', ')}`);
} else if (cmd === 'swarm') {
  console.log(`swarm: ${a.traders} traders, ${a.attackers} attacker(s), one move every ~${a.interval} ms. Ctrl-C to stop.`);
  await swarm({ node: a.node!, traders: Number(a.traders), attackers: Number(a.attackers), intervalMs: Number(a.interval), log: (l) => console.log(l) });
}
else if (cmd === 'sponsor') {
  // Each run asks something else, at another price; every other one also asks for the postcode, so blocs form and counter.
  a.as ??= 'open-science.example';
  a.wait = a.wait === '0' ? '20' : a.wait;
  for (let i = 0; ; i++) {
    const study = SANDBOX_STUDIES[i % SANDBOX_STUDIES.length]!;
    a.price = String(2 + (i % 4));
    a['extra-fields'] = i % 2 ? 'postcode' : undefined;
    console.log(`\nSPONSOR   run ${i + 1}: "${study.question}"`);
    await dispatchCmd(study).catch((e: Error) => console.log(`FAILED    ${e.message}`));
    await new Promise((r) => setTimeout(r, Number(a.every) * 1000));
  }
}
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

async function dispatchCmd(chosen?: Study) {
  const domain = a.as ?? 'uni.example';
  const port = Number(a.port);
  // Serve our card while the mission runs, so a node can verify it and show us on the map.
  const url = `http://${existsSync('/.dockerenv') ? hostname() : 'localhost'}:${port}/a2a`;
  const id = await loadOrCreateIdentity(`${homedir()}/.lake/visitor-${domain}.json`);
  const visitor = await makeVisitor(id, domain, `Research agent (${domain})`, url);
  const reply = async (): Promise<LakeData> => ({ lake: '0.1', card: visitor.card, envelope: (await signMessage({ kind: 'rejected', code: 'busy', why: 'a research agent on a mission' }, id, { iss: visitor.webId })) as LakeData['envelope'] });
  const server = lakeAgentApp(visitor.card, reply).listen(port);
  const link = new LakeLinks({ nodeUrls: a.node!.split(',').map((u) => u.trim()), card: visitor.card, identity: id, webId: visitor.webId, log: (m) => { if (!a.json) console.log(`NODE      ${m}`); } });
  await link.register(6);

  const say = (step: string, detail: string) => { if (!a.json) console.log(`${step.toUpperCase().padEnd(9)} ${detail}`); };
  const study = chosen ?? readmissionStudy(a.goal, Number(a.epsilon));
  say('dispatch', `"${study.question}"  (as ${domain}, $${a.price ?? 2} per participant)`);
  try {
    const r = await dispatch({
      visitor, node: a.node!, ethics: a.ethics!, auditor: a.auditor!, link, log: say, houseCache: `${homedir()}/.lake/houses.json`,
      study,
      priceUsd: Number(a.price ?? 2),
      extraFields: a['extra-fields']?.split(',').filter(Boolean),
      waitSeconds: Number(a.wait),
      concurrency: Number(a.concurrency),
      paceMs: Number(a.pace),
      money: a.unpaid ? undefined : {
        human: await makeHuman(await loadOrCreateIdentity(`${homedir()}/.lake/human-${domain}.json`), domain),
        budgetUsd: Number(a.budget),
        payments: a.payments!,
      },
    });
    if (a.json) console.log(JSON.stringify({ ...r, grants: r.grants.map((g) => g.house) }, null, 2));
    else {
      for (const x of r.excluded) console.log(`EXCLUDED  ${x.house}: ${x.why}`);
      console.log(`DONE      ${r.participants} answers from ${r.houses} houses in ${r.seconds}s. Records moved: see the map (computed from each house's audit log).`);
    }
  } finally {
    server.close();
  }
}
