import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import * as jose from 'jose';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCard, canonicalize, droppedConnection, generateIdentity, lakeAgentApp, ReplayGuard, ReplyCache, sendLake, signCard, signMessage, verifyLakeData,
  type Identity, type LakeData, type Signed,
} from './index.js';

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

const agent = async (name: string, url = `https://${name}.example/a2a`) => {
  const id = await generateIdentity();
  const webId = `https://${name}.example/#agent`;
  const card = await signCard(buildCard({ name, description: name, url, skills: [], profile: { role: 'visitor', webId, ownerDomain: `${name}.example`, tags: [] } }, id), id);
  return { id, card, webId };
};

/** Signs like signMessage, but with a nonce of our choosing: a different message that reuses one. */
async function signWithNonce(payload: object, id: Identity, iss: string, nonce: string): Promise<Signed<object>> {
  const iat = Math.floor(Date.now() / 1000);
  const full = { ...payload, nonce, iat, exp: iat + 300, iss };
  const jws = await new jose.FlattenedSign(new TextEncoder().encode(canonicalize(full))).setProtectedHeader({ alg: 'EdDSA', kid: id.kid, typ: 'lake+jws' }).sign(id.privateKey);
  return { payload: full, jws: { protected: jws.protected!, signature: jws.signature } } as Signed<object>;
}

/** A counter agent: each verified `add` adds to its total, once per message. `drop` loses the next reply on the way. */
async function counter() {
  const outer = express();
  const server = outer.listen(0);
  servers.push(server);
  await new Promise((ok) => server.once('listening', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a`;
  const me = await agent('counter', url);
  const state = { total: 0, calls: 0, drop: 0 };
  const replay = new ReplayGuard();
  const reply = async (body: object): Promise<LakeData> => ({ lake: '0.1', card: me.card, envelope: (await signMessage(body, me.id, { iss: me.webId })) as LakeData['envelope'] });
  const app = lakeAgentApp(me.card, async (data) => {
    state.calls++;
    const v = await verifyLakeData<{ kind: string; n?: number }>(data as LakeData<{ kind: string; n?: number }>, { replay, sandbox: true });
    if (!v.ok) return reply({ kind: 'refused', code: v.rejection.code });
    state.total += v.payload.n ?? 0;
    return reply({ kind: 'added', total: state.total });
  }, me.id, { replay });
  // The reply is worked out and then lost: the connection closes before it goes back (what a reset looks like).
  outer.use('/a2a', (req, res, next) => {
    if (req.method === 'POST' && state.drop > 0) {
      state.drop--;
      res.end = (() => { req.socket.destroy(); return res; }) as never;
    }
    next();
  });
  outer.use(app);
  return { url, state };
}

const payloadOf = async (raw: LakeData | null) => {
  const v = await verifyLakeData<Record<string, unknown>>(raw as LakeData<Record<string, unknown>>, { sandbox: true });
  if (!v.ok) throw new Error(v.rejection.why);
  return v.payload;
};

describe('a message sent twice is acted on once (SPEC §3)', () => {
  it('answers an identical copy with the same signed reply, without doing the work again', async () => {
    const c = await counter();
    const me = await agent('sender');
    const data: LakeData = { lake: '0.1', card: me.card, envelope: (await signMessage({ kind: 'add', n: 5 }, me.id, { iss: me.webId })) as LakeData['envelope'] };
    const [a, b] = [await sendLake(c.url, data, { me: me.id }), await sendLake(c.url, data, { me: me.id })];
    expect(await payloadOf(a)).toMatchObject({ kind: 'added', total: 5 });
    expect(canonicalize(b!.envelope)).toBe(canonicalize(a!.envelope));
    expect(c.state).toMatchObject({ total: 5, calls: 1 });
    // Two copies at once: the second waits for the first's answer.
    const twin: LakeData = { ...data, envelope: (await signMessage({ kind: 'add', n: 1 }, me.id, { iss: me.webId })) as LakeData['envelope'] };
    const [x, y] = await Promise.all([sendLake(c.url, twin, { me: me.id }), sendLake(c.url, twin, { me: me.id })]);
    expect(canonicalize(x!.envelope)).toBe(canonicalize(y!.envelope));
    expect(c.state.total).toBe(6);
  });

  it('refuses a different message that reuses a nonce, a changed copy, and an expired one', async () => {
    const c = await counter();
    const me = await agent('sender');
    const first = await signWithNonce({ kind: 'add', n: 1 }, me.id, me.webId, 'n-1');
    expect(await payloadOf(await sendLake(c.url, { lake: '0.1', card: me.card, envelope: first as LakeData['envelope'] }, { me: me.id }))).toMatchObject({ total: 1 });
    const reused = await signWithNonce({ kind: 'add', n: 100 }, me.id, me.webId, 'n-1');
    expect(await payloadOf(await sendLake(c.url, { lake: '0.1', card: me.card, envelope: reused as LakeData['envelope'] }, { me: me.id }))).toMatchObject({ kind: 'refused', code: 'replayed' });
    const changed = { ...first, payload: { ...first.payload, n: 100 } };
    expect(await payloadOf(await sendLake(c.url, { lake: '0.1', card: me.card, envelope: changed as LakeData['envelope'] }, { me: me.id }))).toMatchObject({ kind: 'refused', code: 'bad-signature' });
    const old: LakeData = { lake: '0.1', card: me.card, envelope: (await signMessage({ kind: 'add', n: 7 }, me.id, { iss: me.webId, ttl: 1, now: Date.now() - 60_000 })) as LakeData['envelope'] };
    for (let i = 0; i < 2; i++) expect(await payloadOf(await sendLake(c.url, old, { me: me.id }))).toMatchObject({ kind: 'refused', code: 'expired' });
    expect(c.state.total).toBe(1);
  });

  it('keeps no reply for a message that failed its checks: a copy is checked again', async () => {
    const c = await counter();
    const me = await agent('sender');
    const forged = structuredClone(me.card);
    forged.capabilities!.extensions[0]!.params!.ownerDomain = 'someone-else.example';
    const data: LakeData = { lake: '0.1', card: forged, envelope: (await signMessage({ kind: 'add', n: 3 }, me.id, { iss: me.webId })) as LakeData['envelope'] };
    for (let i = 0; i < 2; i++) expect(await payloadOf(await sendLake(c.url, data, { me: me.id }))).toMatchObject({ kind: 'refused', code: 'forged-card' });
    expect(c.state).toMatchObject({ total: 0, calls: 2 });
  });

  it('a sender whose reply was lost on the way tries again with the same message, and gets the first reply', async () => {
    const c = await counter();
    const me = await agent('sender');
    c.state.drop = 1;
    let retries = 0;
    const data: LakeData = { lake: '0.1', card: me.card, envelope: (await signMessage({ kind: 'add', n: 2 }, me.id, { iss: me.webId })) as LakeData['envelope'] };
    const r = await sendLake(c.url, data, { me: me.id, onRetry: (e) => { retries++; expect(droppedConnection(e)).toBe(true); } });
    expect(retries).toBe(1);
    expect(await payloadOf(r)).toMatchObject({ kind: 'added', total: 2 });
    expect(c.state).toMatchObject({ total: 2, calls: 1 });
    // With no retries left, the dropped connection is the caller's to see.
    c.state.drop = 1;
    const next: LakeData = { ...data, envelope: (await signMessage({ kind: 'add', n: 2 }, me.id, { iss: me.webId })) as LakeData['envelope'] };
    await expect(sendLake(c.url, next, { me: me.id, retries: 0 })).rejects.toSatisfy(droppedConnection);
  });

  it('tells a dropped connection from a timeout or an answer', () => {
    expect(droppedConnection(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }))).toBe(true);
    expect(droppedConnection(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }))).toBe(true);
    expect(droppedConnection(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(false);
    expect(droppedConnection(new Error('HTTP error for SendMessage! Status: 502 Bad Gateway'))).toBe(false);
    expect(droppedConnection(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) }))).toBe(false);
  });
});

describe('the reply cache', () => {
  it('is bounded by count and size, oldest first, and forgets what expired or failed', async () => {
    const now = Date.now();
    const exp = Math.floor(now / 1000) + 300;
    const cache = new ReplyCache<string>({ maxEntries: 3, maxBytes: 1000 });
    for (let i = 0; i < 5; i++) await cache.answer(`k${i}`, exp, async () => `r${i}`, () => true, now);
    expect(cache.size).toBe(3);
    // The newest are kept: k4 answers from memory, k0 is worked out again.
    let work = 0;
    expect(await cache.answer('k4', exp, async () => { work++; return 'new'; }, () => true, now)).toBe('r4');
    expect(await cache.answer('k0', exp, async () => { work++; return 'again'; }, () => true, now)).toBe('again');
    expect(work).toBe(1);
    // Too big to keep many.
    const big = new ReplyCache<string>({ maxBytes: 250 });
    for (let i = 0; i < 5; i++) await big.answer(`b${i}`, exp, async () => 'x'.repeat(100), () => true, now);
    expect(big.size).toBe(2);
    // Not kept: unverified, failed, or already expired.
    const c = new ReplyCache<string>();
    await c.answer('unverified', exp, async () => 'no', () => false, now);
    await c.answer('failed', exp, async () => { throw new Error('x'); }, () => true, now).catch(() => {});
    await c.answer('expired', Math.floor(now / 1000) - 1, async () => 'late', () => true, now);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.size).toBe(0);
    // Kept until its message expires, then not served.
    await c.answer('k', exp, async () => 'first', () => true, now);
    expect(await c.answer('k', exp, async () => 'second', () => true, (exp + 1) * 1000)).toBe('second');
  });
});
