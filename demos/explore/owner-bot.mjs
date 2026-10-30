// The owners' phones, for a run where nobody holds them: for each claimed house (owners.json in the run folder) it
// opens the scenario's standing intent, signs an allowance for the house's assistant once it has connected, and taps
// Accept on an offer only when the assistant suggests that very offer, and follows the assistant's advice where it gives
// it as a field (a request, a pledge, a question's recommended answer). A reasonable human, no more. Stops after
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

// A list of regions spreads the houses over them in turn (run 68: every house's shop was in VIC).
for (const [i, o] of owners.entries()) {
  if (!intent.pack) continue;
  const terms = { ...intent.terms, ...(Array.isArray(intent.terms?.region) ? { region: intent.terms.region[i % intent.terms.region.length] } : {}) };
  log(`${o.house}: intent ${JSON.stringify(await call(o)({ kind: 'panel.intent.open', pack: intent.pack, terms }))}`);
}
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
    // A reasonable human follows clear advice, given as a field (run 39: a phone that read "hold off" as yes signed Tom up):
    // a request the assistant advises on is allowed or denied; a pledge it advises signing is signed; a question gets the
    // answer it recommends. "Your call", or no advice, is left waiting.
    for (const sug of v.suggestions ?? []) {
      const req = sug.request && (v.requests ?? []).find((r) => r.offerId === sug.request && r.status === 'pending');
      if (req && (sug.advice === 'do' || sug.advice === 'dont') && !o.given.has(`req:${req.offerId}`)) {
        o.given.add(`req:${req.offerId}`);
        const r = sug.advice === 'dont' ? await c({ kind: 'answer', request: req.offerId, answer: 'deny' })
          : req.grantDraft ? await c({ kind: 'answer', request: req.offerId, answer: 'allow', grant: await issueCredential({ ...req.grantDraft, validFrom: new Date().toISOString() }, o.id) }) : { error: 'no grant to sign' };
        log(`${o.house}: ${sug.advice === 'dont' ? 'denied' : 'allowed'} ${req.visitor?.domain ?? ''} (${req.offerId}) on the assistant's advice: ${JSON.stringify(r)}`);
      }
      // A mute the assistant proposes explicitly (never read from advice): applied. New rules it advises: applied.
      if (sug.note && sug.mute && sug.advice !== 'your_call' && !o.given.has(`mute:${sug.note}`)) {
        o.given.add(`mute:${sug.note}`);
        log(`${o.house}: muted the sender of note ${sug.note} on the assistant's advice: ${JSON.stringify(await c({ kind: 'panel.note.mute', id: sug.note }))}`);
      }
      if (sug.rules && sug.advice === 'do' && !o.given.has(`rules:${sug.id}`)) {
        o.given.add(`rules:${sug.id}`);
        log(`${o.house}: applied new rules on the assistant's advice: ${JSON.stringify(await c({ kind: 'panel.rules.set', text: sug.rules }))}`);
      }
      if (sug.door && sug.advice === 'do' && !o.given.has(`door:${sug.id}`)) {
        o.given.add(`door:${sug.id}`);
        const cur = await c({ kind: 'panel.door' });
        log(`${o.house}: put "${sug.door.about}" on the door on the assistant's advice: ${JSON.stringify(await c({ kind: 'panel.door.set', open: true, about: sug.door.about, ...(cur.name ? { name: cur.name } : {}) }))}`);
      }
      if (sug.pledge && sug.advice === 'do' && !o.given.has(`pledge:${sug.pledge.id}`)) {
        o.given.add(`pledge:${sug.pledge.id}`);
        log(`${o.house}: signed pledge ${sug.pledge.id} on the assistant's advice: ${JSON.stringify(await c({ kind: 'panel.pledge.sign', tally: sug.pledge.tally, id: sug.pledge.id }))}`);
      }
      // A pledge left to the owner: decided after a while, like a question (run 68: two "your call" pledges sat unanswered).
      if (sug.pledge && sug.advice === 'your_call' && Date.now() - Date.parse(sug.at) > 45_000 && !o.given.has(`pledge:${sug.pledge.id}`)) {
        o.given.add(`pledge:${sug.pledge.id}`);
        if (Math.random() < 0.5) log(`${o.house}: signed pledge ${sug.pledge.id} (its own call): ${JSON.stringify(await c({ kind: 'panel.pledge.sign', tally: sug.pledge.tally, id: sug.pledge.id }))}`);
        else log(`${o.house}: let pledge ${sug.pledge.id} pass (its own call)`);
      }
      // A new allowance the assistant proposes (the button the panel shows): signed, unless it advises against or asks for
      // more than twice what this owner gave at the start (run 68: two A$60 requests were never tapped).
      if (sug.allowance && sug.advice !== 'dont' && sug.by && !o.given.has(`allowance:${sug.id}`)) {
        o.given.add(`allowance:${sug.id}`);
        if (sug.allowance.amount > 2 * Number(allowance)) log(`${o.house}: left the ${sug.allowance.currency} ${sug.allowance.amount} allowance request (too much)`);
        else {
          const d = await c({ kind: 'panel.allowance.draft', kid: sug.by, amount: sug.allowance.amount, currency: sug.allowance.currency, days: sug.allowance.days });
          const r = d.draft ? await c({ kind: 'panel.allowance.set', id: d.id, credential: await issueCredential({ ...d.draft, validFrom: new Date().toISOString() }, o.id) }) : d;
          log(`${o.house}: signed the ${sug.allowance.currency} ${sug.allowance.amount} allowance the assistant asked for: ${JSON.stringify(r)}`);
        }
      }
      if (sug.ask && !sug.ask.answered && Number.isInteger(sug.ask.recommend) && !o.given.has(`ask:${sug.id}`)) {
        o.given.add(`ask:${sug.id}`);
        const choice = sug.ask.choices[sug.ask.recommend];
        log(`${o.house}: answered "${choice}" to "${sug.text.slice(0, 80)}" as the assistant recommended: ${JSON.stringify(await c({ kind: 'panel.assistant.answer', id: sug.id, choice }))}`);
      }
      // A question with no advice is the owner's own call: a person answers it after a while, picking for themselves (run 49:
      // the bot never tapped one, and the run stalled). Picked at random here, and logged as the owner's own pick.
      if (sug.ask && !sug.ask.answered && !Number.isInteger(sug.ask.recommend) && Date.now() - Date.parse(sug.at) > 45_000 && !o.given.has(`ask:${sug.id}`)) {
        o.given.add(`ask:${sug.id}`);
        const choice = sug.ask.choices[Math.floor(Math.random() * sug.ask.choices.length)];
        log(`${o.house}: picked "${choice}" (its own call; no advice) for "${sug.text.slice(0, 80)}": ${JSON.stringify(await c({ kind: 'panel.assistant.answer', id: sug.id, choice }))}`);
      }
    }
    // Accept only an offer the assistant names in a suggestion (its Accept button, or the id in the text).
    if (!o.accepted) {
      const m = await c({ kind: 'panel.market' });
      const named = (m.offers ?? []).find((x) => x.status === 'open' && x.result?.eligible && (v.suggestions ?? []).some((s) => s.offer === x.id || s.text.includes(x.id) || s.text.includes(x.id.slice(0, 8))));
      if (named) {
        let r = await c({ kind: 'panel.offer.accept', offer: named.id });
        // As the panel does: over the assistant's allowance, raise it to cover the offer (signed here) and accept.
        if (r.code === 'over_allowance' && r.allowance) {
          const d = await c({ kind: 'panel.allowance.draft', kid: r.allowance.kid, amount: Math.ceil(r.price.amount), currency: r.price.currency, days: 3 });
          const set = await c({ kind: 'panel.allowance.set', id: d.id, credential: await issueCredential({ ...d.draft, validFrom: new Date().toISOString() }, o.id) });
          log(`${o.house}: raised the allowance to ${r.price.currency} ${Math.ceil(r.price.amount)} to accept: ${JSON.stringify(set)}`);
          r = await c({ kind: 'panel.offer.accept', offer: named.id });
        }
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
