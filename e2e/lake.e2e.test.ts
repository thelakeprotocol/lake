import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildCard, generateIdentity, issueCredential, signCard, signMessage, type Identity } from '../packages/core/src/index.js';
import { dispatch, makeHuman, readmissionStudy } from '../packages/visitor/src/dispatch.js';
import { ask, knock, makeVisitor, PRESETS } from '../packages/visitor/src/knock.js';

// Boots a whole Lake from source: a node, the issuer, auditor and ethics specialists, and three houses
// (each a real Community Solid Server + housekeeper), then knocks and runs a mission over A2A.
const procs: ChildProcess[] = [];
let dir: string;
let node: string;
let ethics: string;
let auditor: string;
let payments: string;
const houses: Record<string, string> = {};

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });

function start(args: string[], ready: RegExp): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    const timer = setTimeout(() => fail(new Error(`timed out:\n${out}`)), 120_000);
    const on = (b: Buffer) => { out += b; if (ready.test(out)) { clearTimeout(timer); ok(); } };
    p.stdout!.on('data', on);
    p.stderr!.on('data', on);
    p.once('exit', (c) => fail(new Error(`exited ${c}:\n${out}`)));
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lake-e2e-'));
  const port = async () => String(await freePort());
  const nodePort = await port();
  node = `http://localhost:${nodePort}`;
  await start(['packages/lake/dist/main.js', '--port', nodePort, '--data', join(dir, 'node')], /Lake node on/);
  const [ip, ap, ep, pp] = [await port(), await port(), await port(), await port()];
  auditor = `http://localhost:${ap}`;
  ethics = `http://localhost:${ep}`;
  payments = `http://localhost:${pp}`;
  await Promise.all([
    start(['packages/specialists/dist/main.js', 'issuer', '--port', ip, '--data', join(dir, 'issuer'), '--lake', node], /registered with the Lake node/),
    start(['packages/specialists/dist/main.js', 'auditor', '--port', ap, '--data', join(dir, 'auditor'), '--lake', node], /registered with the Lake node/),
    start(['packages/specialists/dist/main.js', 'ethics', '--port', ep, '--data', join(dir, 'ethics'), '--lake', node], /registered with the Lake node/),
    start(['packages/specialists/dist/main.js', 'payments', '--port', pp, '--data', join(dir, 'payments'), '--lake', node], /registered with the Lake node/),
  ]);
  await Promise.all(
    ['stan', 'strict', 'research'].map(async (name) => {
      const [pp, hp] = [await port(), await port()];
      houses[name] = `http://localhost:${hp}`;
      await start(
        ['packages/house/dist/main.js', '--name', name, '--rules', `personas/${name}.yaml`, '--data', join(dir, 'houses'), '--issuer-url', `http://localhost:${ip}`,
          '--auditor-url', auditor, '--pod-port', pp, '--port', hp, '--lake', node, '--seed', '42'],
        /joined the Lake/,
      );
    }),
  );
}, 240_000);

afterAll(async () => {
  procs.forEach((p) => p.kill('SIGTERM'));
  await new Promise((r) => setTimeout(r, 500));
  await rm(dir, { recursive: true, force: true });
});

const visitor = async (domain: string) => makeVisitor(await generateIdentity(), domain);

describe('one house', () => {
  it('serves a signed Lake card at the A2A well-known path', async () => {
    const card = await (await fetch(`${houses.stan}/.well-known/agent-card.json`)).json();
    expect(card.signatures).toHaveLength(1);
    expect(card.capabilities.extensions[0].params.role).toBe('house');
  });

  it('joins what a standing rule covers, and hands over a signed grant', async () => {
    const { reply } = await knock(houses.stan!, await visitor('gp.example'), PRESETS.gp!);
    expect(reply).toMatchObject({ kind: 'decision', decision: 'join', grantHours: 48, holds: ['medications'] });
    expect(String(reply.grant).split('.')).toHaveLength(3);
  });

  it('asks the owner when no rule covers it, declines what a rule refuses', async () => {
    expect((await knock(houses.stan!, await visitor('uni.example'), PRESETS.research!)).reply.decision).toBe('ask');
    expect((await knock(houses.stan!, await visitor('ads.example'), PRESETS.marketing!)).reply.decision).toBe('decline');
  });

  it('is not talked round by prompt injection', async () => {
    expect((await knock(houses.stan!, await visitor('evil.example'), PRESETS.injection!)).reply.decision).toBe('decline');
  });

  it.each(['forge-card', 'unsigned', 'replay', 'impersonate'] as const)('rejects %s', async (tamper) => {
    const { reply } = await knock(houses.stan!, await visitor('gp.example'), PRESETS.gp!, tamper);
    expect(reply.kind).toBe('rejected');
  });
});

describe('the Lake node', () => {
  it('registered every house and specialist after verifying them', async () => {
    const state = await (await fetch(`${node}/state`)).json();
    expect(state.participants.filter((p: { role: string }) => p.role === 'house')).toHaveLength(3);
    expect(state.participants.filter((p: { role: string }) => p.role === 'specialist')).toHaveLength(4);
  });

  it('streams what happens at a door: ids, kinds and counts', async () => {
    const ws = new WebSocket(`${node.replace('http', 'ws')}/events`);
    const kinds: string[] = [];
    await new Promise((ok) => ws.once('message', ok)); // snapshot
    ws.on('message', (m) => kinds.push(JSON.parse(String(m)).event.kind));
    await knock(houses.stan!, await visitor('gp.example'), PRESETS.gp!);
    await new Promise((r) => setTimeout(r, 600));
    ws.close();
    expect(kinds).toEqual(expect.arrayContaining(['knock', 'decision', 'grant.issued']));
  });

  it('refuses forged cards, and cards for endpoints the registrant does not control', async () => {
    const id = await generateIdentity();
    const input = { name: 'Fake', description: 'x', url: `${houses.stan}/a2a`, skills: [], profile: { role: 'house' as const, webId: 'https://fake.example/#me', ownerDomain: 'fake.example', tags: [] } };
    const card = await signCard(buildCard(input, id), id);
    const notMine = await fetch(`${node}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card }) });
    expect((await notMine.json()).code).toBe('card-mismatch');
    card.name = 'Edited after signing';
    const forged = await fetch(`${node}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card }) });
    expect((await forged.json()).code).toBe('forged-card');
  });

  it('refuses events from anyone not registered', async () => {
    const id = await generateIdentity();
    const env = await signMessage({ kind: 'events', events: [{ id: 'x', kind: 'record.moved', at: new Date().toISOString(), actor: 'house:stan' }] }, id, { iss: 'https://fake.example/#me' });
    const res = await fetch(`${node}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
    expect(res.status).toBe(403);
  });
});

describe('the owner', () => {
  let owner: Identity;
  let webId = '';
  const ownerCall = async (payload: Record<string, unknown>) => {
    const env = await signMessage(payload, owner, { iss: webId || 'owner' });
    return (await fetch(`${houses.strict}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) })).json();
  };
  const pairWith = async (id: Identity, token?: string) =>
    fetch(`${houses.strict}/owner/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: id.publicJwk, token }) });

  it('pairs one device with the one-time token, and no other', async () => {
    owner = await generateIdentity('owner-phone');
    expect((await pairWith(owner, 'wrong')).status).toBe(403);
    const token = (await readFile(join(dir, 'houses', 'strict', 'pairing-token'), 'utf8')).trim();
    const ok = await pairWith(owner, token);
    expect(ok.status).toBe(200);
    webId = (await ok.json()).webId;
    expect((await pairWith(await generateIdentity(), token)).status).toBe(403);
  });

  it("waits for the owner's tap, and the study includes the house once the owner allows it", async () => {
    const v = await visitor('uni.example');
    const mission = dispatch({ visitor: v, node, ethics, auditor, study: readmissionStudy(), priceUsd: 5, waitSeconds: 20 });
    let req: { id: string; offerId: string; visitor: { webId: string }; fields: string[]; purpose: string; study: string } | undefined;
    for (let i = 0; i < 40 && !req; i++) {
      await new Promise((r) => setTimeout(r, 250));
      req = (await ownerCall({ kind: 'list' })).requests[0];
    }
    expect(req).toBeDefined();
    const vc = (fields: string[]) => ({
      '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeAccessGrant'], issuer: webId,
      validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      credentialSubject: { id: req!.visitor.webId, offer: req!.offerId, study: req!.study, fields, purpose: req!.purpose, authorizedBy: 'owner, live' },
    });
    // A grant wider than what the owner was shown is refused.
    expect(await ownerCall({ kind: 'answer', request: req!.id, answer: 'allow', grant: await issueCredential(vc([...req!.fields, 'dob']) as never, owner) })).toMatchObject({ error: expect.any(String) });
    expect(await ownerCall({ kind: 'answer', request: req!.id, answer: 'allow', grant: await issueCredential(vc(req!.fields) as never, owner) })).toEqual({ ok: true });
    const r = await mission;
    expect(r.participants).toBe(3);

    // Revoking cuts the agent off at once.
    const strict = r.grants.find((g) => g.url.startsWith(houses.strict!))!;
    const t0 = Date.now();
    expect((await ownerCall({ kind: 'revoke', revoke: 'all' })).revoked).toBeGreaterThan(0);
    const { reply } = await ask(strict.url, v, { kind: 'compute', grant: strict.grant, study: readmissionStudy() });
    expect(reply).toMatchObject({ kind: 'excluded', why: 'the owner revoked this key' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('refuses owner requests not signed by the owner', async () => {
    const env = await signMessage({ kind: 'revoke', revoke: 'all' }, await generateIdentity('owner-phone'), { iss: webId });
    expect((await fetch(`${houses.strict}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) })).status).toBe(403);
  });
});

describe('money', () => {
  const human = async () => makeHuman(await generateIdentity(), 'uni.example');
  const paidRun = async (priceUsd: number, budgetUsd: number, extraFields: string[] = []) =>
    dispatch({ visitor: await visitor('uni.example'), node, ethics, auditor, study: readmissionStudy(), priceUsd, extraFields, money: { human: await human(), budgetUsd, payments } });

  it('$2 becomes $5: the houses counter as one bloc, drop the postcode, sign, get paid, and file the receipts', async () => {
    const before = (await (await fetch(`${node}/state`)).json()).counters.valueSettled;
    const r = await paidRun(2, 5000, ['postcode']);
    expect(r.decisions).toEqual({ counter: 2, ask: 1 });
    expect(r.bloc).toEqual({ members: 2, priceUsd: 5, fields: ['age_band', 'medications', 'readmissions'] });
    expect(r.participants).toBe(2);
    expect(r.paid).toEqual({ total: 10, houses: 2, receiptsFiled: 2 });
    const receipts = await readdir(join(dir, 'houses', 'stan', 'pod', 'stan', 'receipts'));
    expect(receipts.some((f) => f.includes('.receipt.jwt'))).toBe(true);
    const agreements = await readdir(join(dir, 'houses', 'stan', 'pod', 'stan', 'agreements'));
    const signed = JSON.parse(await readFile(join(dir, 'houses', 'stan', 'pod', 'stan', 'agreements', agreements.find((f) => f.includes('.agreement.json'))!), 'utf8'));
    expect(signed.agreement['@type']).toBe('Agreement');
    await new Promise((ok) => setTimeout(ok, 500));
    expect((await (await fetch(`${node}/state`)).json()).counters.valueSettled - before).toBe(10);
  });

  it("walks away from a bloc it can't afford", async () => {
    const r = await paidRun(2, 6, ['postcode']);
    expect(r.bloc?.priceUsd).toBe(5);
    expect(r.participants).toBe(0);
    expect(r.paid).toBeNull();
  });

  it('cannot spend past what the human signed for', async () => {
    const r = await paidRun(5, 5);
    expect(r.participants).toBe(2);
    expect(r.paid?.refused).toMatch(/a human must approve/);
  });
});

describe('a mission, no money', () => {
  const run = async (o: Partial<Parameters<typeof dispatch>[0]> = {}) =>
    dispatch({ visitor: await visitor('uni.example'), node, ethics, auditor, study: readmissionStudy(), priceUsd: 5, ...o });

  it('goes ethics → audit → knock → decide → grant → compute in place → answer, and moves no records', async () => {
    const r = await run();
    expect(r.houses).toBe(3);
    expect(r.decisions).toEqual({ join: 2, ask: 1 }); // stan and research join; strict asks its owner
    expect(r.participants).toBe(2);
    expect(r.excluded).toEqual([]);
    await new Promise((ok) => setTimeout(ok, 500));
    expect((await (await fetch(`${node}/state`)).json()).counters.recordsMoved).toBe(0);
  });

  it('gives the same answers every time in seeded mode', async () => {
    const [a, b] = [await run(), await run()];
    expect(a.cells).toEqual(b.cells);
  });

  it('cannot get uncertified study code run', async () => {
    const sneaky = { ...readmissionStudy(), privacy: { mechanism: 'unary-randomized-response' as const, epsilon: 40 } };
    await expect(run({ study: sneaky })).rejects.toThrow(/refused/);
  });

  it('drops a house whose record was tampered with', async () => {
    const root = join(dir, 'houses', 'research', 'pod', 'research', 'health');
    const file = join(root, (await readdir(root)).find((f) => f.startsWith('claims.ttl'))!);
    await writeFile(file, (await readFile(file, 'utf8')).replace(/"(\d)0-(\d)9"/, '"90+"'));
    const r = await run();
    expect(r.decisions).toEqual({ join: 1, decline: 1, ask: 1 });
    expect(r.participants).toBe(1);
  });
});
