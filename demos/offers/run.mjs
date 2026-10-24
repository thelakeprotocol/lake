// Home-loan offers, recorded: a real local Lake (node, bank, register, auditor, payments, eight lenders,
// a hundred hosted first home buyers in Queensland), driven the way owners would drive it. Most owners
// ask through their control panel's API; one asks and accepts on a phone, through the real UI, and that
// phone is filmed. The node records every event; render.mjs turns the recording into a video.
//
//   node demos/offers/run.mjs [--houses 100]        (after `pnpm build`)
//
// Output: demos/runs/offers-<time>/ with run.jsonl (the node's recording), captions.json, the phone
// screenshots, each process's log and score.json: the numbers for the final scoreboard, read from
// the owners' own panels.

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { generateIdentity, signMessage } = await import(join(root, 'packages/core/dist/index.js'));
const { values: a } = parseArgs({ options: { houses: { type: 'string', default: '100' }, chrome: { type: 'string', default: process.env.CHROME ?? '/usr/bin/google-chrome' } } });
const N = Number(a.houses);
const out = join(here, '..', 'runs', `offers-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(out, { recursive: true });

const free = () => new Promise((ok) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [];
function start(name, args, ready, env = {}) {
  const log = openSync(join(out, `${name}.log`), 'w');
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, NODE_ENV: 'production', ...env }, stdio: ['ignore', 'pipe', log] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let seen = '';
    p.stdout.on('data', (d) => { seen += d; writeFileSync(join(out, `${name}.out`), seen); if (ready.test(seen)) ok(p); });
    p.once('exit', (code) => fail(new Error(`${name} exited (${code}); see ${name}.log`)));
  });
}
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', () => { stop(); process.exit(1); });

const captions = [];
const caption = (text, sub, extra = {}) => { captions.push({ t: Date.now(), text, sub, ...extra }); writeFileSync(join(out, 'captions.json'), JSON.stringify(captions, null, 1)); console.log(`· ${text}`); };

const [np, sp, qp, hp, pp] = await Promise.all([free(), free(), free(), free(), free()]);
const node = `http://localhost:${np}`, spec = `http://localhost:${sp}`;
console.log(`run in ${out}`);
await start('node', ['packages/lake/dist/main.js', '--port', String(np), '--domain', 'lake.local', '--guild-min', '100000', '--show-intent-houses', '--data', join(out, 'node'), '--record', join(out, 'run.jsonl')], /Lake node on/);
await start('specialists', ['packages/specialists/dist/main.js', 'bank,register,auditor,payments', '--packs', 'mortgage', '--port', String(sp), '--url', spec, '--lake', node, '--data', join(out, 'specialists')], /payments .* at/);
await start('lenders', ['packages/agent/dist/cli.js', 'quoters', '--packs', 'mortgage', '--port', String(qp), '--public-url', `http://localhost:${qp}`, '--node', node,
  '--auditor', `${spec}/auditor`, '--authority', `${spec}/register`, '--payments', `${spec}/payments`], /8 quoters on/);
await start('houses', ['packages/house/dist/main.js', '--tenants', String(N), '--tenant-prefix', 'b-', '--data', join(out, 'houses'), '--port', String(hp), '--pod-port', String(pp),
  '--lake', node, '--packs', 'mortgage', '--issuers', `mortgage=${spec}/bank`, '--auditor-url', `${spec}/auditor`, '--open-pairing', '--personas-dir', join(here, 'personas')], /houses joined in/);
const names = Array.from({ length: N }, (_, i) => `b-${i}`);
const houseUrl = (n) => `http://localhost:${hp}/t/${n}`;

// Each owner pairs a key (as their phone would) and talks to their own house with it.
const owners = new Map();
async function owner(n) {
  if (owners.has(n)) return owners.get(n);
  const key = await generateIdentity('phone');
  await fetch(`${houseUrl(n)}/owner/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: key.publicJwk }) });
  const call = async (payload) => (await fetch(`${houseUrl(n)}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(payload, key, { iss: 'owner' })) })).json();
  owners.set(n, call);
  return call;
}
const terms = { region: 'qld', price_band: 'auto', term_years: 30, first_time_buyer: 'yes' };

// The filmed phone: one owner in the middle of the pack, on the real control panel.
const star = names[Math.floor(N * 0.37)];
const browser = await chromium.launch({ executablePath: a.chrome });
const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-AU' })).newPage();
phone.on('dialog', (d) => d.accept());
await phone.goto(`${houseUrl(star)}/owner/`, { waitUntil: 'networkidle' });
await phone.click('#pair-btn');
await phone.waitForSelector('#view:not([hidden])');
// The house's address is a localhost URL on this machine; it says nothing on film.
await phone.addStyleTag({ content: '.top .eyebrow { visibility: hidden; }' });
const showCard = () => phone.evaluate(() => document.querySelector('.card.ok')?.scrollIntoView());

// Every owner pairs their phone before filming starts; pairing isn't the story.
const order = names.filter((n) => n !== star);
for (let i = 0; i < order.length; i += 10) await Promise.all(order.slice(i, i + 10).map(owner));

await sleep(4000);
caption(`${N} households in Queensland. Eight lenders. Nobody has shared anything.`, 'Every square is a home with its own pod. On the right: lenders, authorised by a register the households trust.', { speed: 1 });
await sleep(7000);

// Waves of owners asking, so groups visibly form and grow.
caption('They say what they’re looking for. Nothing more.', 'A state, a price band each home works out for itself, a 30-year loan, first home buyer.');
const waves = [order.slice(0, Math.round(N * 0.12)), order.slice(Math.round(N * 0.12), Math.round(N * 0.45)), order.slice(Math.round(N * 0.45))];
const opened = [];
async function ask(list, gapMs) {
  for (const n of list) {
    const call = await owner(n);
    // A busy house gets asked again, as an owner would tap again.
    void (async () => {
      for (let i = 0; i < 4; i++) {
        const r = await call({ kind: 'panel.intent.open', pack: 'mortgage', terms }).catch((e) => ({ error: e.message }));
        if (!r.error) return;
        if (i === 3) console.log(`${n}: ${r.error}`);
        await sleep(3000);
      }
    })();
    opened.push(n);
    await sleep(gapMs);
  }
}
await ask(waves[0], 350);
await sleep(3000);
caption('Each lender sends its rules into every home', 'A certified program runs on the household’s own bank data. The result stays inside. The lender learns nothing, eligible or not.', { speed: 2 });
await sleep(9000);
caption('Households asking for the same thing become a group', 'The Lake only counts them, it never lists them. Groups of three or more get group rates: each home re-runs the lenders’ programs itself.', { speed: 5 });
await ask(waves[1], 140);

// The filmed owner asks on the phone, in the biggest wave.
await phone.evaluate(() => { location.hash = 'offers'; });
await phone.waitForSelector('select[name="region"]');
await phone.selectOption('select[name="region"]', 'qld');
await phone.selectOption('select[name="term_years"]', '30');
await phone.selectOption('select[name="first_time_buyer"]', 'yes');
await phone.screenshot({ path: join(out, 'phone-ask.png') });
await phone.click('button:has-text("Ask for")');
opened.push(star);
await ask(waves[2], 110);
// Wait until every lender has priced every home (eight quotes each), or nothing has moved for a while.
const quoted = () => readFileSync(join(out, 'run.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"quote.made"')).length;
for (let last = -1, still = 0; still < 6; ) {
  await sleep(2500);
  const q = quoted();
  if (q >= 8 * opened.length) break;
  still = q === last ? still + 1 : 0;
  last = q;
}
await sleep(12000); // a couple of group refreshes, so every offer carries its group's size

// Everyone has offers by now; the phone shows its own, cheapest first.
await sleep(3500);
await showCard();
await phone.screenshot({ path: join(out, 'phone-offers.png') });
caption('Only the owner sees the offers', 'Cheapest first, group discount included. Lenders still know nothing about this household.', { image: 'phone-offers.png', until: Date.now() + 9000, speed: 1 });
await sleep(9000);

// Yes, to one lender: on the phone, and for a few other owners through their panels.
caption('Yes, to one lender', 'Only now does anything leave the home: the bank-signed statements, to that one lender. It checks them and confirms.');
await phone.click('article.req button:has-text("Accept")');
await phone.waitForSelector('article.req p.advice', { timeout: 30000 }).catch(() => {});
await sleep(1500);
await phone.evaluate(() => document.querySelector('article.req p.advice')?.scrollIntoView({ block: 'center' }));
await phone.screenshot({ path: join(out, 'phone-accepted.png') });
captions.push({ t: Date.now(), image: 'phone-accepted.png', until: Date.now() + 7000 });
await sleep(5000);
caption('Then everyone else with an offer says yes', 'One tap each. Every lender checks the bank’s signature on what it receives, and confirms.', { speed: 1.5 });
const rest = opened.filter((x) => x !== star);
for (let i = 0; i < rest.length; i += 6) {
  await Promise.all(rest.slice(i, i + 6).map(async (n) => {
    const call = await owner(n);
    const m = await call({ kind: 'panel.market' });
    const best = m.offers?.find((o) => o.result.eligible);
    if (best) await call({ kind: 'panel.offer.accept', offer: best.id }).catch(() => {});
  }));
}
await sleep(3000);

// The scoreboard, from what the owners themselves can see. Lenders and the node never saw any of it.
let households = 0, withOffers = 0, saved = [], cuts = [];
for (const n of opened) {
  const call = await owner(n);
  const m = await call({ kind: 'panel.market' });
  households++;
  const offers = (m.offers ?? []).filter((o) => o.result.eligible);
  if (!offers.length) continue;
  withOffers++;
  const best = offers[0].result.outputs;
  // The same lenders' rates without the group discount: what each owner would have got alone.
  const alone = Math.min(...offers.map((o) => o.result.outputs.rate + (o.result.outputs.group_off ?? 0)));
  const pay = (rate) => { const r = rate / 1200, n2 = 360; return (best.loan * r) / (1 - (1 + r) ** -n2); };
  if (alone > best.rate) { cuts.push(alone - best.rate); saved.push(pay(alone) - pay(best.rate)); }
}
const state = await (await fetch(`${node}/state`)).json();
const lines = readFileSync(join(out, 'run.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// One offer per home and lender: a quote retried after a timeout replaces the first, it isn't another offer.
const quoteCount = new Set(lines.filter((l) => l.event.kind === 'quote.made').map((l) => `${l.event.actor}|${l.event.subject}`)).size;
const firstIntent = lines.find((l) => l.event.kind === 'intent.opened')?.t ?? 0;
const lastQuote = lines.filter((l) => l.event.kind === 'quote.made').at(-1)?.t ?? 0;
const avg = (xs) => xs.reduce((x, y) => x + y, 0) / (xs.length || 1);
const score = {
  households, lenders: 8, quotes: quoteCount, withOffers,
  groupRateCut: Math.round(avg(cuts) * 100) / 100, monthlySaving: Math.round(avg(saved)), groupMembers: cuts.length,
  seconds: Math.round((lastQuote - firstIntent) / 1000), accepted: lines.filter((l) => l.event.kind === 'offer.accepted').length,
  dealSeconds: Math.round(((lines.filter((l) => l.event.kind === 'offer.accepted').at(-1)?.t ?? lastQuote) - firstIntent) / 1000),
  recordsMoved: state.counters.recordsMoved,
};
writeFileSync(join(out, 'score.json'), JSON.stringify(score, null, 2));
// Two numbers, each beside what the same thing takes today.
captions.push({ t: Date.now(), scoreboard: { title: 'Home loans, priced inside homes', rows: [
  [`${score.accepted} deals`, `conditional approvals from ${score.lenders} lenders, for ${score.households} households who asked`, 'Today: weeks for one, one lender at a time'],
  [`${score.dealSeconds} seconds`, 'from the first ask to the last deal, with no bank data shared before a yes', 'Today: every lender you apply to gets your statements'],
] } });
writeFileSync(join(out, 'captions.json'), JSON.stringify(captions, null, 1));
console.log(score);
await sleep(6000);
await browser.close();
stop();
console.log(`done: ${out}\nnow: node demos/offers/render.mjs ${out}`);
