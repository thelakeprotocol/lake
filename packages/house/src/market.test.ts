import { describe, expect, it } from 'vitest';
import { buildCard, generateIdentity, issueCredential, programId, registerPack, signCard, verifyLakeCard, type Identity, type QuoteProgram } from '@thelakeprotocol/core';
import { Market } from './market.js';
import type { Trust } from './record.js';

// A pack of the test's own: the market is generic, so it's tested with no real use case.
registerPack({
  id: 'toyshop', version: '1.0.0', title: 'Toy shop', vocab: 'urn:toyshop#', folder: 'toyshop/', recordClass: 'urn:toyshop#Record',
  fields: { toy_count: { class: 'urn:toyshop#Count', kind: 'number', label: 'toys' } },
  intent: { terms: { size: { kind: 'code', label: 'Size', options: ['small', 'big'] } }, groupBy: ['size'] },
});
const program: QuoteProgram = { v: 2, kind: 'quote', pack: 'toyshop@1', title: 'Toys', inputs: ['toy_count'], eligible: 'true', outputs: { total: '1.0' }, output: 'owner' };

async function agent(domain: string, name = domain) {
  const id = await generateIdentity();
  const webId = `https://${domain}/#agent`;
  const card = await signCard(buildCard({ name, description: 'x', url: `https://${domain}/a2a`, skills: [], profile: { role: 'agent', webId, ownerDomain: domain, tags: [] } }, id), id);
  return { id, webId, card };
}
const vc = (type: string, issuer: { id: Identity; webId: string }, subject: Record<string, unknown>) =>
  issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', type], issuer: issuer.webId, validFrom: new Date().toISOString(), credentialSubject: subject as { id: string } }, issuer.id);

async function setup() {
  const regulator = await agent('register.example');
  const auditor = await agent('audit.example');
  const trust = { regulators: ['register.example'], auditors: ['audit.example'], issuers: [], ethics: [], payments: [], tellers: [] } satisfies Trust;
  let record: { ok: true } | { ok: false; why: string; transient?: boolean } = { ok: true };
  const said: string[] = [];
  const me = await agent('house.example');
  const market = new Market({
    actor: 'house', webId: me.webId, id: me.id, card: me.card, sandbox: true, trust: () => trust, links: () => null, nodes: [], records: [],
    claims: async () => [{ field: 'toy_count', value: '3' }], read: async () => { throw new Error('none'); }, write: async () => {},
    verifyRecord: async () => record, emit: () => {}, say: (m) => said.push(m),
  });
  const certificate = { credential: await vc('LakeProgramCertificate', auditor, { id: programId(program) }), card: auditor.card };
  /** A shop that quotes, authorised or not. */
  const shop = async (domain: string, authorised = true) => {
    const a = await agent(domain);
    const authorisation = authorised ? { credential: await vc('LakeAuthorisation', regulator, { id: a.webId, pack: 'toyshop@1' }), card: regulator.card } : undefined;
    const profile = await verifyLakeCard(a.card);
    return { quote: () => market.quote({ program, certificate, authorisation }, profile, a.card) };
  };
  return { market, said, shop, breakRecord: (r: typeof record) => { record = r; } };
}

describe('why an intent has no offers (SPEC §12, Refusals)', () => {
  it('warns when the intent opens if this house\'s record can\'t price it, and says so once', async () => {
    const { market, said, breakRecord } = await setup();
    breakRecord({ ok: false, why: 'certified by an auditor this house no longer trusts' });
    const opened = await market.open('toyshop', { size: 'small' });
    expect(opened).toMatchObject({ pack: 'toyshop@1', warning: expect.stringContaining('no longer trusts') });
    expect(said.filter((m) => m.includes('no longer trusts'))).toHaveLength(1);
    expect(await market.status('toyshop@1')).toMatchObject({ agentsTold: 0, turnedAway: [], warning: expect.stringContaining("can't be priced") });
  });

  it('no warning for a healthy record, or for a pod that is only busy', async () => {
    const { market, breakRecord } = await setup();
    expect(await market.open('toyshop', { size: 'small' })).not.toHaveProperty('warning');
    breakRecord({ ok: false, why: 'the pod is busy', transient: true });
    expect(await market.status('toyshop@1')).not.toHaveProperty('warning');
  });

  it('keeps each turned-away agent\'s latest reason, logs a broken record once, and forgets it when the agent quotes', async () => {
    const { market, said, shop, breakRecord } = await setup();
    await market.open('toyshop', { size: 'big' });
    breakRecord({ ok: false, why: 'the chain is broken' });
    const grocer = await shop('grocer.example');
    for (let i = 0; i < 3; i++) expect(await grocer.quote()).toMatchObject({ kind: 'rejected', code: 'no-record' });
    expect(said.filter((m) => m.includes('turning quotes away'))).toHaveLength(1);
    expect((await market.status('toyshop@1')).turnedAway).toEqual([
      { agent: 'grocer.example', domain: 'grocer.example', code: 'no-record', why: "my record isn't usable right now (the chain is broken)", at: expect.any(String) },
    ]);
    breakRecord({ ok: true });
    expect(await grocer.quote()).toMatchObject({ kind: 'quoted' });
    expect(await market.status('toyshop@1')).toEqual({ agentsTold: 0, turnedAway: [] });
    expect(market.offers.size).toBe(1);
  });

  it('keeps only a handful, newest first, leaves out strangers it never told, and starts afresh when the intent closes', async () => {
    const { market, shop, breakRecord } = await setup();
    await market.open('toyshop', { size: 'big' });
    breakRecord({ ok: false, why: 'the chain is broken' });
    for (let i = 0; i < 8; i++) await (await shop(`shop${i}.example`)).quote();
    expect(await (await shop('rogue.example', false)).quote()).toMatchObject({ kind: 'rejected', code: 'unauthorised' });
    const away = (await market.status('toyshop@1')).turnedAway;
    expect(away.map((t) => t.agent)).toEqual(['shop7.example', 'shop6.example', 'shop5.example', 'shop4.example', 'shop3.example', 'shop2.example']);
    await market.close('toyshop');
    expect((await market.status('toyshop@1')).turnedAway).toEqual([]);
  });
});
