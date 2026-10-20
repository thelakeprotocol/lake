import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateIdentity } from '../packages/core/src/index.js';
import { knock, makeVisitor, PRESETS } from '../packages/visitor/src/knock.js';

// Boots a real Issuer and a real house (Community Solid Server + housekeeper) and knocks over A2A.
const procs: ChildProcess[] = [];
let dir: string;
let house: string;

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
  const [issuerPort, podPort, port] = await Promise.all([freePort(), freePort(), freePort()]);
  await start(['packages/specialists/dist/main.js', 'issuer', '--port', String(issuerPort), '--data', join(dir, 'issuer')], /listening/);
  await start(
    ['packages/house/dist/main.js', '--name', 'stan', '--rules', 'personas/stan.yaml', '--data', join(dir, 'houses'), '--issuer-url', `http://localhost:${issuerPort}`, '--pod-port', String(podPort), '--port', String(port)],
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
