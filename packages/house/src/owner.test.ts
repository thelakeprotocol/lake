import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { generateIdentity, signMessage, type JWK } from '@thelakeprotocol/core';
import { agendaIcs, OwnerDesk } from './owner.js';

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

describe('the agenda', () => {
  it('is a private calendar feed, events confirmed only when the other side agreed, and leaves with the last owner', async () => {
    const d = await leasedDesk();
    const phone = await generateIdentity('phone');
    await d.post('/pair', { publicJwk: phone.publicJwk });
    const owner = async (p: Record<string, unknown>) => d.post('/api', await signMessage(p, phone, { iss: 'http://h/me' }));
    d.desk.agenda = [
      { id: 'a1', what: 'Coffee with Sam', when: 'Tue 10:30', start: '2026-11-02T23:30:00.000Z', where: 'Hospital café, level 2', by: 'Delta', at: '2026-10-27T11:13:38.000Z', agreed: { by: 'Lumen', domain: 'sam.example', said: 'Sam confirms Tuesday 10:30', at: '2026-10-27T11:13:33.000Z' } },
      { id: 'a2', what: 'A call, maybe', when: 'some time', by: 'Delta', at: '2026-10-27T11:14:00.000Z' },
      { id: 'a3', what: 'Talk; at the meetup', when: 'in three weeks', start: '2026-11-17T08:00:00.000Z', by: 'Delta', at: '2026-10-27T11:15:00.000Z' },
    ];
    const { path } = await owner({ kind: 'panel.agenda.feed' });
    const ics = await (await fetch(`${d.base}${path.replace(/^\/owner/, '')}`)).text();
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toContain('DTSTART:20261102T233000Z');
    expect(ics).toContain('DURATION:PT60M');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('SUMMARY:Talk\\; at the meetup'); // escaped, as RFC 5545 says
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics).not.toContain('A call, maybe'); // no start: not a calendar event
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect((await fetch(`${d.base}/agenda.ics?key=guess`)).status).toBe(404);
    // Handed back: the next owner finds no agenda, no notes, and the old calendar address no longer works.
    expect(d.desk.addNote({ from: { name: 'N', domain: 'n.example', webId: 'https://n.example/#a', checked: false }, text: 'hello' })).toBeTruthy();
    expect(d.desk.notes).toHaveLength(1);
    await owner({ kind: 'release' });
    expect(d.desk.agenda).toEqual([]);
    expect(d.desk.notes).toEqual([]);
    expect((await fetch(`${d.base}${path.replace(/^\/owner/, '')}`)).status).toBe(404);
    d.close();
  });

  it('folds long lines at 75 octets', () => {
    const ics = agendaIcs([{ id: 'x', what: 'é'.repeat(80), when: 'soon', start: '2026-11-02T23:30:00.000Z', by: 'A', at: '2026-10-27T11:13:38.000Z' }], 'http://h/me');
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(ics.replace(/\r\n /g, '')).toContain(`SUMMARY:${'é'.repeat(80)}`);
  });
});
