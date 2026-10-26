// The owners' phones, for a run where nobody holds them: for each claimed house (owners.json in the run folder) it
// opens the scenario's standing intent, signs an allowance for the house's assistant once it has connected, and taps
// Accept on an offer only when the assistant suggests that very offer, and answers a request the assistant clearly
// advises on (allow or deny). A reasonable human, no more. Stops after
// `minutes`, or when the run folder gets a file called stop-owner-bot.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { importIdentity, issueCredential, signMessage } from '../../packages/core/dist/index.js';

const [run, intentJson = '{}', allowance = '150', minutes = '30', currency = 'USD'] = process.argv.slice(2);
const intent = JSON.parse(intentJson);
const log = (m) => appendFileSync(join(run, 'owner-bot.log'), `${new Date().toISOString()} ${m}\n`);
const owners = await Promise.all(JSON.parse(readFileSync(join(run, 'owners.json'), 'utf8')).map(async (o) => ({ ...o, id: await importIdentity(o.key), given: new Set(), accepted: false })));
// A phone on a bad network: a failed or slow request is an answer ({ error }), never the end of the bot.
const call = (o) => async (p) => {
  try {
    const r = await fetch(`${o.url}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(p, o.id, { iss: o.webId })), signal: AbortSignal.timeout(20_000) });
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
};

for (const o of owners) if (intent.pack) log(`${o.house}: intent ${JSON.stringify(await call(o)({ kind: 'panel.intent.open', pack: intent.pack, terms: intent.terms }))}`);
const until = Date.now() + Number(minutes) * 60_000;
while (Date.now() < until && !existsSync(join(run, 'stop-owner-bot'))) {
  for (const o of owners) try {
    const c = call(o);
    const v = await c({ kind: 'list' });
    // An allowance for each assistant that can have one, once.
    for (const a of v.assistants ?? []) {
      if (!a.canHaveAllowance || a.allowance || o.given.has(a.kid)) continue;
      const d = await c({ kind: 'panel.allowance.draft', kid: a.kid, amount: Number(allowance), currency, days: 3 });
      if (!d.draft) { log(`${o.house}: draft refused: ${JSON.stringify(d)}`); continue; }
      const r = await c({ kind: 'panel.allowance.set', id: d.id, credential: await issueCredential({ ...d.draft, validFrom: new Date().toISOString() }, o.id) });
      o.given.add(a.kid);
      log(`${o.house}: allowance ${currency} ${allowance} for ${a.label}: ${JSON.stringify(r)}`);
    }
    // A request the assistant advises on, by name: a reasonable human follows clear advice ("deny", "allow"), and leaves
    // anything vague waiting (run 38: the GP's request sat pending though the assistant had said "Deny").
    for (const sug of v.suggestions ?? []) {
      const req = sug.request && (v.requests ?? []).find((r) => r.offerId === sug.request && r.status === 'pending');
      if (!req || o.given.has(`req:${req.offerId}`)) continue;
      const no = /\b(deny|decline|say no|refuse|don'?t allow|do not allow)\b/i.test(sug.text);
      const yes = !no && /\b(allow|say yes|approve|accept it)\b/i.test(sug.text);
      if (!no && !yes) continue;
      o.given.add(`req:${req.offerId}`);
      const r = no ? await c({ kind: 'answer', request: req.offerId, answer: 'deny' })
        : req.grantDraft ? await c({ kind: 'answer', request: req.offerId, answer: 'allow', grant: await issueCredential({ ...req.grantDraft, validFrom: new Date().toISOString() }, o.id) }) : { error: 'no grant to sign' };
      log(`${o.house}: ${no ? 'denied' : 'allowed'} ${req.visitor?.domain ?? ''} (${req.offerId}) on the assistant's advice: ${JSON.stringify(r)}`);
    }
    // A pledge the assistant puts in front of the owner (its Sign button): signed, unless the note itself advises against.
    for (const sug of v.suggestions ?? []) {
      if (!sug.pledge || o.given.has(`pledge:${sug.pledge.id}`) || /\b(don'?t|do not|wouldn'?t|not) sign\b/i.test(sug.text)) continue;
      o.given.add(`pledge:${sug.pledge.id}`);
      log(`${o.house}: signed pledge ${sug.pledge.id} on the assistant's advice: ${JSON.stringify(await c({ kind: 'panel.pledge.sign', tally: sug.pledge.tally, id: sug.pledge.id }))}`);
    }
    // Accept only an offer the assistant names in a suggestion (its Accept button, or the id in the text).
    if (!o.accepted) {
      const m = await c({ kind: 'panel.market' });
      const named = (m.offers ?? []).find((x) => x.status === 'open' && x.result?.eligible && (v.suggestions ?? []).some((s) => s.offer === x.id || s.text.includes(x.id) || s.text.includes(x.id.slice(0, 8))));
      if (named) {
        const r = await c({ kind: 'panel.offer.accept', offer: named.id });
        o.accepted = true;
        log(`${o.house}: accepted ${named.quoter?.name} (${named.id}): ${JSON.stringify(r.answer ?? r)}`);
      }
    }
  } catch (e) {
    log(`${o.house}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
log('done');
