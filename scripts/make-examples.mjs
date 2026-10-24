// Generates spec/examples: one complete study as real, signed Lake objects. Run: pnpm examples
// Every file verifies (see packages/core/src/examples.test.ts). Synthetic and sandbox only.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accessGrantDraft, agreementFor, aggregateReports, buildCard, collectiveCounter, generateIdentity, issueCredential, digestSRI, makeEvent, newVerifyKey, prepareReport, settleReport, shardAnswer, signAgreement, signCard,
  signIntentMandate, signMessage, signPaymentMandate, statusEntry, statusListCredential, studyId,
} from '../packages/core/dist/index.js';

const out = join(import.meta.dirname, '..', 'spec', 'examples');
const decode = (jws) => JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString());
const write = (name, value, about) => {
  writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n');
  files.push([name, about]);
};
const files = [];

const agent = async (role, domain, name, path = '/a2a', tags = [], webIdPath = '/#agent') => {
  const id = await generateIdentity(`${role}-${domain}`);
  const webId = `https://${domain}${webIdPath}`;
  const card = await signCard(buildCard({ name, description: `${name} (example)`, url: `https://${domain}${path}`, skills: role === 'house' ? [{ id: 'health-study', name: 'Health study', description: 'Considers research offers' }] : [], profile: { role, webId, ownerDomain: domain, tags } }, id), id);
  return { id, webId, card, domain };
};
const vc = (issuer, type, subject, days = 90) => issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', type], issuer: issuer.webId, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + days * 864e5).toISOString(), credentialSubject: subject }, issuer.id);
const envelope = async (from, payload) => ({ lake: '0.1', card: from.card, envelope: await signMessage(payload, from.id, { iss: from.webId }) });

const visitor = await agent('visitor', 'uni.example', 'Research agent (uni.example)');
const human = await agent('agent', 'uni.example', 'Research lead (uni.example)', '/people/lead', ['human'], '/people/lead#me');
const house = await agent('house', 'pods.example', 'House stan', '/t/stan/a2a', ['research-volunteers'], '/stan/profile/card#me');
const ethics = await agent('specialist', 'ethics.example', 'Ethics', '/a2a', ['ethics-review'], '/#ethics-review');
const auditor = await agent('specialist', 'audit.example', 'Auditor', '/a2a', ['study-audit'], '/#study-audit');
const payments = await agent('specialist', 'payments.example', 'Payments', '/a2a', ['payments'], '/#payments');
const tellerA = await agent('specialist', 'teller-a.example', 'Teller A', '/a2a', ['teller', 'quiet'], '/#teller');
const tellerB = await agent('specialist', 'teller-b.example', 'Teller B', '/a2a', ['teller', 'quiet'], '/#teller');

write('visitor-card.json', visitor.card, 'A visitor agent\'s signed A2A Agent Card with the Lake extension.');
write('house-card.json', house.card, 'A hosted house\'s signed card. Its card lives next to its endpoint: /t/stan/.well-known/agent-card.json.');

const study = {
  v: 1, question: 'Do over-60s on drug X get readmitted less?', kind: 'contingency',
  predicates: [
    { name: 'over 60', field: 'age_band', op: 'age_at_least', value: 60 },
    { name: 'on drug X', field: 'medications', op: 'has_code', value: 'drug-x' },
    { name: 'readmitted', field: 'readmissions', op: 'present' },
  ],
  privacy: { mechanism: 'dap-prio3', tellers: [{ url: 'https://teller-a.example/a2a', domain: 'teller-a.example' }, { url: 'https://teller-b.example/a2a', domain: 'teller-b.example' }], min: 20 }, minTier: 'issuer-signed',
};
const sid = studyId(study);
write('study.json', { id: sid, study }, 'A declarative study. Its id is urn:lake:study: + the digest of its canonical JSON.');

const fields = ['age_band', 'medications', 'readmissions', 'postcode'];
const ethicsVc = await vc(ethics, 'LakeEthicsApproval', { id: sid, question: study.question, purpose: 'research', fields, sponsor: visitor.webId, reviewedBy: 'example' });
const auditVc = await vc(auditor, 'LakeStudyCertificate', { id: sid, checks: ['declarative study, no code', 'answers split between two tellers run by different parties', 'totals only', 'no table from fewer than 20 houses'] });
write('ethics-approval.json', { credential: ethicsVc, card: ethics.card, decoded: decode(ethicsVc) }, 'An ethics approval (VC-JOSE) for this study and these fields, with its issuer\'s card. Counts only if the owner trusts ethics.example.');
write('study-certificate.json', { credential: auditVc, card: auditor.card, decoded: decode(auditVc) }, 'An auditor\'s certificate for the study. Without one from a trusted auditor, no house runs it.');

const offer = { id: '7f1c0a52-1d1e-4a5e-9c41-2b7d2d0f4e10', requester: visitor.domain, purpose: 'research', fields, retention: 'none', priceUsd: 2, study: sid, credentials: { ethicsApproved: true, sponsorVerified: true, auditCertified: true } };
write('1-offer.json', await envelope(visitor, { kind: 'offer', offer, study, attachments: { ethics: { credential: ethicsVc, card: ethics.card }, audit: { credential: auditVc, card: auditor.card } } }), 'Step 1. The visitor knocks: an A2A data part with its card and a signed envelope carrying the offer, the study and both credentials.');

const counter = { fields: ['age_band', 'medications', 'readmissions'], priceUsd: 4 };
write('2-counter.json', await envelope(house, { kind: 'decision', offerId: offer.id, decision: 'counter', reason: "you'd join if they drop postcode and pay at least $4", counter, bloc: true, holds: ['age_band', 'medications'], notes: [] }), 'Step 2. A house counters, signed, and says it bargains as a bloc.');
const bloc = collectiveCounter([counter, { fields: ['age_band', 'medications', 'readmissions'], priceUsd: 5 }]);
write('3-bloc.json', { rule: 'highest price any member asks; only fields every member accepts', counters: [counter, { fields: ['age_band', 'medications', 'readmissions'], priceUsd: 5 }], bloc }, 'Step 3. The bloc rule (SPEC §5.3), applied to two signed counters: $2 becomes $5 and postcode is dropped.');

const revised = { ...offer, id: '0b3e8c55-6f0a-4c61-8d3e-55d1c3f0a9b2', fields: bloc.fields, priceUsd: bloc.priceUsd };
const until = new Date(Date.now() + 48 * 36e5);
const agreement = agreementFor(revised, house.webId, visitor.webId, until);
const houseSig = await signAgreement(agreement, house.id);
// Every house publishes its revocation list next to its card; each grant names its own bit on it.
const statusUrl = 'https://pods.example/t/stan/status/revocation';
const grant = await issueCredential({ ...accessGrantDraft(house.webId, visitor.webId, { offer: revised.id, study: sid, fields: bloc.fields, purpose: 'research', authorizedBy: 'standing rule 1', uses: 1, rules: digestSRI('rules.yaml as written'), agreement: agreement.uid }), issuer: house.webId, validFrom: new Date().toISOString(), validUntil: until.toISOString(), credentialStatus: statusEntry(statusUrl, 48_213) }, house.id);
write('4-join.json', await envelope(house, { kind: 'decision', offerId: revised.id, decision: 'join', reason: 'matches your rule 1', grantHours: 48, grant, agreement: { agreement, signatures: [{ by: house.webId, jws: houseSig }] }, holds: ['age_band', 'medications'], notes: [] }), 'Step 4. The house joins: a grant under the owner\'s standing rule, and an ODRL Agreement it has signed.');
write('grant.json', { credential: grant, decoded: decode(grant) }, 'The grant, decoded: a Solid Access Grant (Inrupt format, GConsent): the owner (id) gives the visitor (isProvidedTo) read access to these data, for this purpose (a DPV term), with the Lake terms alongside: which offer and study, single use, which rule allowed it.');
const statusList = await statusListCredential(house.webId, statusUrl, [1_207, 90_311], house.id);
write('status-list.json', { credential: statusList, decoded: decode(statusList) }, 'A house\'s revocation list (W3C Bitstring Status List), served at /status/revocation: 131,072 bits, gzipped; a set bit is a key taken back or used up. The grant above names bit 48213 (not set). Anyone can check a key without the house learning which.');

const countersignature = await signAgreement(agreement, visitor.id);
const count = 'run-3b1f6c2e-8f0d-4c7a-9a51-0c2e7d4b9f13';
write('count-open.json', await envelope(visitor, { kind: 'count.open', id: count, length: 8, min: 20, deadline: new Date(Date.now() + 36e5).toISOString(), helper: { url: 'https://teller-b.example/a2a', domain: 'teller-b.example' } }), 'Before any house answers, the visitor opens one count at the Leader teller, naming the Helper; the Leader sets it up with the Helper and a key only the two of them hold (IETF DAP; SPEC §11.5).');
write('5-compute.json', await envelope(visitor, { kind: 'compute', grant, study, countersignature, count }), 'Step 5. The visitor countersigns the agreement and asks the house to run the study inside its pod, naming the count.');
// The house's true answer (over 60, on drug X, not readmitted: cell 0b011) as one Prio3 report: two shares and a proof.
const report = await shardAnswer(8, 0b011);
write('count-report.json', await envelope(house, { kind: 'count.report', id: count, reportId: report.reportId, publicShare: report.publicShare, share: report.shares[0] }), 'Step 6a. What the Leader gets from the house: one share of its answer and the public part of its proof. The Helper gets the other share. Neither share says anything on its own.');
write('6-counted.json', await envelope(house, { kind: 'counted', study: sid, count, tellers: ['teller-a.example', 'teller-b.example'] }), 'Step 6. The house tells the visitor it sent its two shares. Nothing about its owner is in this message.');
// Two more houses, so the aggregate below is a real (tiny) table; the tellers check each proof together, then aggregate.
const key = newVerifyKey(8);
const reports = [report, await shardAnswer(8, 0b111), await shardAnswer(8, 0b011)];
const leaderPrepared = [];
for (const r of reports) {
  const a = await prepareReport(8, key, 0, { ...r, share: r.shares[0] });
  const b = await prepareReport(8, key, 1, { ...r, share: r.shares[1] });
  leaderPrepared.push({ state: a.state, message: await settleReport(8, [a.share, b.share]) });
}
write('count-share.json', await envelope(tellerA, { kind: 'count.share', id: count, count: 3, rejected: 0, share: aggregateReports(8, leaderPrepared) }), "Each teller publishes one aggregate share, once, after both have checked every answer's proof. The Leader's share alone says nothing; added to the Helper's it gives the exact table.");

const intent = await signIntentMandate(human.id, human.webId, { id: visitor.webId, natural_language_description: study.question, study: sid, budget: { currency: 'USD', amount: 5000 }, intent_expiry: new Date(Date.now() + 7 * 864e5).toISOString(), user_cart_confirmation_required: false });
write('intent-mandate.json', { credential: intent, card: human.card, decoded: decode(intent) }, 'AP2 Intent Mandate, signed by a human at the visitor\'s organisation: this study, $5,000 at most.');
const pm = await signPaymentMandate(visitor.id, visitor.webId, { payee: house.webId, amount: 5, intentMandate: intent, agreement: agreement.uid });
write('payment-mandate.json', { credential: pm, decoded: decode(pm) }, 'AP2 Payment Mandate, signed by the agent under the Intent Mandate.');
const receipt = await vc(payments, 'LakeReceipt', { id: house.webId, amount: { currency: 'USD', value: 5 }, agreement: agreement.uid, intentMandate: digestSRI(intent), settlement: 'simulated' }, 3650);
write('7-receipt.json', await envelope(visitor, { kind: 'receipt', receipt: { credential: receipt, card: payments.card } }), 'Step 7. The visitor delivers the payments agent\'s receipt; the house files it in /receipts/.');

write('events.json', [
  makeEvent('knock', 'house:745cdb1d', 'agent:uni.example', { purpose: 'research' }),
  makeEvent('decision', 'house:745cdb1d', 'agent:uni.example', { decision: 'counter', reason: "you'd join if they drop postcode and pay at least $4" }),
  makeEvent('counter', 'visitor:1a2b3c4d', undefined, { members: 2, price: 5, was: 2 }),
  makeEvent('compute.done', 'house:745cdb1d', 'agent:uni.example', { recordsOut: 0, claimsRead: 3 }),
  makeEvent('payment.settled', 'specialist:9f8e7d6c', undefined, { amount: 10, count: 2 }),
  makeEvent('attack.blocked', 'house:745cdb1d', 'key:a1b2c3d4e5f6', { why: 'forged-card', key: 'a1b2c3d4e5f6', claimed: 'trusted-hospital.example', verified: false }),
], 'Events as a node streams them: ids, kinds and counts, never record contents.');

writeFileSync(join(out, 'README.md'), `# Examples: one study, end to end

Real, signed Lake objects, generated by \`pnpm examples\` from the reference code. Every signature verifies (\`packages/core/src/examples.test.ts\`). Synthetic, sandbox domains only. Envelopes expire five minutes after they were made; verify them with the clock set to their \`iat\`.

| File | What it is |
|---|---|
${files.map(([f, a]) => `| [\`${f}\`](${f}) | ${a} |`).join('\n')}

Also at https://lake.doneinfifty.com/examples/v0/<file>.
`);
console.log(`wrote ${files.length} examples to ${out}`);
