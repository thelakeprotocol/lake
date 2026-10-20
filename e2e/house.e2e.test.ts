import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildCard, generateIdentity, signCard, signMessage } from '../packages/core/src/index.js';
import { knock, makeVisitor, PRESETS } from '../packages/visitor/src/knock.js';

// Boots a real Lake node, Issuer and house (Community Solid Server + housekeeper) and knocks over A2A.
const procs: ChildProcess[] = [];
let dir: string;
let house: string;
let node: string;

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });

function start(args: string[], ready: RegExp): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    const timer = setTimeout(() => fail(new Error(`timed out:\n${out}`)), 90_000);
    const on = (b: Buffer) => { out += b; if (ready.test(out)) { clearTimeout(timer); ok(); } };
    p.stdout!.on('data', on);
    p.stderr!.on('data', on);
    p.once('exit', (c) => fail(new Error(`exited ${c}:\n${out}`)));
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lake-e2e-'));
  const [issuerPort, podPort, port, nodePort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  node = `http://localhost:${nodePort}`;
  await start(['packages/lake/dist/main.js', '--port', String(nodePort), '--data', join(dir, 'node')], /Lake node on/);
  await start(['packages/specialists/dist/main.js', 'issuer', '--port', String(issuerPort), '--data', join(dir, 'issuer'), '--lake', node], /registered with the Lake node/);
  await start(
    ['packages/house/dist/main.js', '--name', 'stan', '--rules', 'personas/stan.yaml', '--data', join(dir, 'houses'), '--issuer-url', `http://localhost:${issuerPort}`, '--pod-port', String(podPort), '--port', String(port), '--lake', node],
    /joined the Lake/,
  );
  house = `http://localhost:${port}`;
}, 120_000);

afterAll(async () => {
  procs.forEach((p) => p.kill('SIGTERM'));
  await new Promise((r) => setTimeout(r, 500));
  await rm(dir, { recursive: true, force: true });
});

const visitor = async (domain: string) => makeVisitor(await generateIdentity(), domain);

describe('one house', () => {
  it('serves a signed Lake card at the A2A well-known path', async () => {
    const card = await (await fetch(`${house}/.well-known/agent-card.json`)).json();
    expect(card.signatures).toHaveLength(1);
    expect(card.capabilities.extensions[0].params.role).toBe('house');
  });

  it('joins what a standing rule covers, reading the pod through MCP', async () => {
    const { reply } = await knock(house, await visitor('gp.example'), PRESETS.gp!);
    expect(reply).toMatchObject({ kind: 'decision', decision: 'join', grantHours: 48, holds: ['medications'] });
  });

  it('asks the owner when no rule covers it, declines what a rule refuses', async () => {
    expect((await knock(house, await visitor('uni.example'), PRESETS.research!)).reply.decision).toBe('ask');
    expect((await knock(house, await visitor('ads.example'), PRESETS.marketing!)).reply.decision).toBe('decline');
  });

  it('is not talked round by prompt injection', async () => {
    expect((await knock(house, await visitor('evil.example'), PRESETS.injection!)).reply.decision).toBe('decline');
  });

  it.each(['forge-card', 'unsigned', 'replay', 'impersonate'] as const)('rejects %s', async (tamper) => {
    const { reply } = await knock(house, await visitor('gp.example'), PRESETS.gp!, tamper);
    expect(reply.kind).toBe('rejected');
  });

  it('refuses to join once its own record has been tampered with', async () => {
    const root = join(dir, 'houses', 'stan', 'pod', 'stan', 'health');
    const file = join(root, (await readdir(root)).find((f) => f.startsWith('claims.ttl'))!);
    await writeFile(file, (await readFile(file, 'utf8')).replace(/"(\d)0-(\d)9"/, '"90+"'));
    const { reply } = await knock(house, await visitor('gp.example'), PRESETS.gp!);
    expect(reply).toMatchObject({ decision: 'decline' });
    expect(String(reply.reason)).toContain('signature check');
  });
});

describe('the Lake node', () => {
  it('registered the house and the issuer after verifying them', async () => {
    const state = await (await fetch(`${node}/state`)).json();
    expect(state.participants.map((p: { role: string }) => p.role).sort()).toEqual(['house', 'specialist']);
    const found = await (await fetch(`${node}/cards?skill=health-study`)).json();
    expect(found).toHaveLength(1);
  });

  it('streams what happens at a door: ids, kinds and counts', async () => {
    const ws = new WebSocket(`${node.replace('http', 'ws')}/events`);
    const kinds: string[] = [];
    await new Promise((ok) => ws.once('message', ok)); // snapshot
    ws.on('message', (m) => kinds.push(JSON.parse(String(m)).event.kind));
    await knock(house, await visitor('gp.example'), PRESETS.gp!);
    await new Promise((r) => setTimeout(r, 600));
    ws.close();
    expect(kinds).toEqual(expect.arrayContaining(['knock', 'decision']));
  });

  it('refuses forged cards, and cards for endpoints the registrant does not control', async () => {
    const id = await generateIdentity();
    const input = { name: 'Fake', description: 'x', url: `${house}/a2a`, skills: [], profile: { role: 'house' as const, webId: 'https://fake.example/#me', ownerDomain: 'fake.example', tags: [] } };
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
    expect((await (await fetch(`${node}/state`)).json()).counters.recordsMoved).toBe(0);
  });
});
