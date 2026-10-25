import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addToLog, buildCard, followCheckpoint, generateIdentity, sendLake, signCard, signMessage, verifyLakeData, type AgentCard, type Identity, type LakeData } from '@thelakeprotocol/core';
import { createLog } from './log.js';

// Synthetic receipts: only their credentialSubject matters to log.record (the log vouches for nothing inside).
const vc = (sub: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify({ credentialSubject: sub })).toString('base64url')}.sig${Math.random()}`;
const SELLER = 'https://seller.example/#agent', BUYER = 'https://buyer.example/#agent';
const usd = (value: number) => ({ currency: 'USD', value });

type Agent = { id: Identity; card: AgentCard; webId: string };
const agent = async (domain: string, url: string, id?: Identity): Promise<Agent> => {
  const me = id ?? (await generateIdentity());
  const webId = `https://${domain}/#agent`;
  return { id: me, webId, card: await signCard(buildCard({ name: domain, description: 'x', url, skills: [], profile: { role: 'specialist', webId, ownerDomain: domain, tags: [] } }, me), me) };
};
const listen = (app: express.Express) => new Promise<{ server: Server; url: string }>((ok) => { const server = app.listen(0, () => ok({ server, url: `http://localhost:${(server.address() as { port: number }).port}` })); });

let dir: string;
const servers: Server[] = [];
let logUrl: string, origin: string;
let payments: Agent;
let log: Awaited<ReturnType<typeof createLog>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lake-log-'));
  // The payments agent in a process of its own: the log trusts the key on the card it serves.
  const papp = express();
  const p = await listen(papp);
  servers.push(p.server);
  payments = await agent('payments.example', `${p.url}/a2a`);
  papp.get('/.well-known/agent-card.json', (_req, res) => void res.json(payments.card));
  const lapp = express();
  const l = await listen(lapp);
  servers.push(l.server);
  log = await createLog({ id: await generateIdentity(), url: l.url, domain: 'log.example', sandbox: true, dataDir: dir, trust: [`${p.url}/a2a`] });
  lapp.use(log.app);
  logUrl = `${l.url}/a2a`;
  origin = 'log.example/log';
});

afterAll(async () => {
  servers.forEach((s) => s.close());
  await rm(dir, { recursive: true, force: true });
});

const ask = async (from: Agent, payload: Record<string, unknown>) => {
  const reply = await sendLake(logUrl, { lake: '0.1', card: from.card, envelope: (await signMessage(payload, from.id, { iss: from.webId })) as LakeData['envelope'] }, { me: from.id });
  const v = await verifyLakeData<Record<string, any>>(reply as LakeData<Record<string, any>>, { sandbox: true });
  if (!v.ok) throw new Error(v.rejection.why);
  return v.payload;
};

describe('the transparency log', () => {
  it('counts sales for carts only, a plain refund as a refund its payer gave, and a voided hold as the seller\'s refund', async () => {
    const cart = (id: string) => ({ id, hash: `h-${id}` });
    // A cart sold and paid at once; one held and captured; one held and voided (a refund).
    await log.add(vc({ id: SELLER, payer: BUYER, amount: usd(2), agreement: 'urn:ap2:cart:c1', cart: cart('c1'), settlement: 'simulated' }), 'receipt');
    await log.add(vc({ id: SELLER, payer: BUYER, amount: usd(4), agreement: 'urn:ap2:cart:c2', cart: cart('c2'), settlement: 'held' }), 'receipt');
    await log.add(vc({ id: SELLER, payer: BUYER, amount: usd(4), agreement: 'urn:ap2:cart:c2', cart: cart('c2'), seller: SELLER, settlement: 'simulated', captures: 'h2' }), 'capture');
    await log.add(vc({ id: SELLER, payer: BUYER, amount: usd(3), agreement: 'urn:ap2:cart:c3', cart: cart('c3'), settlement: 'held' }), 'receipt');
    await log.add(vc({ id: BUYER, payer: BUYER, amount: usd(3), agreement: 'urn:ap2:cart:c3', cart: cart('c3'), seller: SELLER, settlement: 'voided', voids: 'h3' }), 'void');
    // The seller pays back cart c1 in full: a refund it gave, not a sale to the buyer nor a purchase by the seller.
    await log.add(vc({ id: BUYER, payer: SELLER, amount: usd(2), agreement: 'urn:lake:order:refund:c1', settlement: 'simulated' }), 'receipt');
    // A plain payment for no cart (a tip, a memo): not a sale.
    await log.add(vc({ id: SELLER, payer: BUYER, amount: usd(1), agreement: 'urn:lake:memo:thanks', settlement: 'simulated' }), 'receipt');
    // Run 33: a "refund" of a cart nobody paid, a second refund of c1, and rulings on a cart nobody paid don't count.
    await log.add(vc({ id: BUYER, payer: SELLER, amount: usd(2), agreement: 'urn:lake:order:refund:c9', settlement: 'simulated' }), 'receipt');
    await log.add(vc({ id: BUYER, payer: SELLER, amount: usd(2), agreement: 'urn:lake:order:refund:c1', settlement: 'simulated', settlementId: 'again' }), 'receipt');
    await log.add(vc({ id: 'urn:ap2:cart:c9', cart: cart('c9'), seller: SELLER, buyer: BUYER, paid: false, delivered: null }), 'ruling');
    await log.add(vc({ id: 'urn:ap2:cart:c9', cart: cart('c9'), seller: SELLER, buyer: BUYER, paid: false, delivered: { sha256: 'x', acknowledged: true } }), 'ruling');
    await log.add(vc({ id: 'urn:ap2:cart:c2', cart: cart('c2'), seller: SELLER, buyer: BUYER, paid: true, delivered: { sha256: 'y', acknowledged: true } }), 'ruling');
    const someone = await agent('someone.example', 'https://someone.example/a2a');
    expect(await ask(someone, { kind: 'log.record', webId: SELLER })).toMatchObject({ sales: 2, purchases: 0, refunds_given: 2, held_now: 0, sold: { USD: 6 }, rulings: { delivered: 1, not_delivered: 0 } });
    expect(await ask(someone, { kind: 'log.record', webId: BUYER })).toMatchObject({ sales: 0, purchases: 2, refunds_given: 0, sold: {} });
  });

  it('takes a kind that counts only from a key it was told to trust, over A2A', async () => {
    const sale = vc({ id: SELLER, payer: BUYER, amount: usd(5), agreement: 'urn:ap2:cart:c9', cart: { id: 'c9', hash: 'h9' }, settlement: 'simulated' });
    // Anyone may log anything, as 'agent', which no record counts; naming a kind that counts is refused.
    const someone = await agent('someone.example', 'https://someone.example/a2a');
    await expect(addToLog(logUrl, vc({ id: SELLER, payer: BUYER, amount: usd(50), cart: { id: 'x', hash: 'x' }, settlement: 'simulated' }), someone, { kind: 'receipt', sandbox: true })).rejects.toThrow(/only the payments agent and the arbiter/);
    // An impostor with the payments agent's name but its own key: refused too.
    const impostor = await agent('payments.example', payments.card.supportedInterfaces![0]!.url);
    await expect(addToLog(logUrl, sale, impostor, { kind: 'receipt', sandbox: true })).rejects.toThrow(/only the payments agent/);
    const padded = await addToLog(logUrl, vc({ id: SELLER, payer: BUYER, amount: usd(50), cart: { id: 'y', hash: 'y' }, settlement: 'simulated' }), someone, { sandbox: true });
    expect(padded.origin).toBe(origin);
    // The payments agent itself, from its own process: counted.
    const logged = await addToLog(logUrl, sale, payments, { kind: 'receipt', sandbox: true });
    expect(logged).toMatchObject({ index: expect.any(Number), origin });
    expect(await ask(someone, { kind: 'log.record', webId: SELLER })).toMatchObject({ sales: 3, sold: { USD: 11 } });
  });

  it('lets a monitor follow it: each checkpoint with the proof it extends the last one', async () => {
    const base = logUrl.replace(/\/a2a$/, '');
    const jwk = log.card.capabilities!.extensions![0]!.params!.publicJwk as never;
    const first = await (await fetch(`${base}/checkpoints`)).json();
    const seen = followCheckpoint(undefined, first.checkpoint, jwk);
    await log.add('one more thing', 'agent');
    const next = await (await fetch(`${base}/checkpoints?from=${seen.size}`)).json();
    expect(next).toMatchObject({ origin, size: seen.size + 1, from: seen.size });
    expect(followCheckpoint(seen, next.checkpoint, jwk, next.consistency).size).toBe(seen.size + 1);
    expect((await fetch(`${base}/checkpoints?from=${seen.size + 5}`)).status).toBe(400);
    // The same over A2A: an inclusion proof and, since the size last seen, the consistency proof, for one tree.
    const found = await ask(await agent('monitor.example', 'https://monitor.example/a2a'), { kind: 'log.find', entry: 'one more thing', since: seen.size });
    expect(found).toMatchObject({ kind: 'log.found', since: seen.size, size: seen.size + 1 });
    expect(followCheckpoint(seen, found.checkpoint, jwk, found.consistency).size).toBe(seen.size + 1);
  });
});
