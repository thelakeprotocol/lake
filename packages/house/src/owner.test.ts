import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { generateIdentity, signMessage, type JWK } from '@thelakeprotocol/core';
import { OwnerDesk } from './owner.js';

// A sandbox house anyone can claim: the claim is a lease, and the house resets when it ends.
async function leasedDesk(stored: JWK | null = null) {
  let key = stored;
  let released = 0;
  const desk = new OwnerDesk({
    dataDir: await mkdtemp(join(tmpdir(), 'desk-')), webId: 'http://h/me', actor: 'house:h', openPairing: true, emit: () => {},
    readOwnerKey: async () => key, saveOwnerKey: async (k) => { key = k; }, clearOwnerKey: async () => { key = null; },
    writeGrant: async () => {}, saveRevoked: async () => {}, loadRevoked: async () => [],
    leaseHours: 24, onRelease: async () => { released++; },
  });
  await desk.init();
  const app = express().use('/owner', desk.router());
  const server = app.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}/owner`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  return { desk, base, post, released: () => released, stored: () => key, close: () => server.close() };
}

describe('sandbox leases', () => {
  it('a claim lasts 24 hours, shows on the public status, and the owner can hand the house back', async () => {
    const d = await leasedDesk();
    const phone = await generateIdentity('phone');
    const paired = await d.post('/pair', { publicJwk: phone.publicJwk });
    expect(Date.parse(paired.until) - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(await (await fetch(`${d.base}/status`)).json()).toMatchObject({ claimed: true, leaseHours: 24 });
    expect((await d.post('/pair', { publicJwk: (await generateIdentity('other')).publicJwk })).error).toBe('this house already has an owner');

    expect(await d.post('/api', await signMessage({ kind: 'release' }, phone, { iss: 'http://h/me' }))).toEqual({ released: true });
    expect(await (await fetch(`${d.base}/status`)).json()).toMatchObject({ claimed: false });
    expect(d.released()).toBe(1);
    expect((await d.post('/pair', { publicJwk: (await generateIdentity('next')).publicJwk })).paired).toBe(true);
    d.close();
  });

  it('an expired lease frees the house on its own', async () => {
    const old = { ...(await generateIdentity('phone')).publicJwk, claimedAt: Date.now() - 25 * 3_600_000 } as JWK;
    const d = await leasedDesk(old);
    await new Promise((r) => setTimeout(r, 50));
    expect(d.stored()).toBeNull();
    expect(d.released()).toBe(1);
    expect(await (await fetch(`${d.base}/status`)).json()).toMatchObject({ claimed: false });
    d.close();
  });
});
