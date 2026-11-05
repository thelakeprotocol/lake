import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { generateIdentity, signMessage, type JWK } from '@thelakeprotocol/core';
import { agendaIcs, OwnerDesk } from './owner.js';

// A sandbox house anyone can claim: the claim is a lease, and the house resets when it ends.
async function leasedDesk(stored: JWK | null = null, dir?: string, told: Record<string, unknown>[] = []) {
  let key = stored;
  let released = 0;
  const desk = new OwnerDesk({
    dataDir: dir ?? await mkdtemp(join(tmpdir(), 'desk-')), webId: 'http://h/me', actor: 'house:h', openPairing: true, emit: () => {},
    readOwnerKey: async () => key, saveOwnerKey: async (k) => { key = k; }, clearOwnerKey: async () => { key = null; },
    writeGrant: async () => {}, saveRevoked: async () => {}, loadRevoked: async () => [],
    leaseHours: 24, onRelease: async () => { released++; },
    tell: async (_url, payload) => { told.push(payload); },
  });
  await desk.init();
  const app = express().use('/owner', desk.router());
  const server = app.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}/owner`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  return { desk, dir: desk['o'].dataDir as string, base, post, released: () => released, stored: () => key, close: () => server.close() };
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

describe('an assistant\'s questions to the owner', () => {
  it('survive a restart (a deploy), answered or not, and leave with the last owner', async () => {
    const d = await leasedDesk();
    const phone = await generateIdentity('phone');
    await d.post('/pair', { publicJwk: phone.publicJwk });
    const owner = async (p: Record<string, unknown>) => d.post('/api', await signMessage(p, phone, { iss: 'http://h/me' }));
    d.desk.suggestions = [
      { id: 'q1', from: 'Delta', text: 'Sam asks to borrow the ladder on Saturday. Lend it?', ask: { choices: ['Yes', 'No'] }, at: '2026-11-05T11:00:00.000Z' },
      { id: 'q2', from: 'Delta', text: 'A note for you', at: '2026-11-05T11:01:00.000Z' },
    ];
    expect(await owner({ kind: 'panel.assistant.answer', id: 'q1', choice: 'Yes' })).toMatchObject({ answered: 'Yes' });
    d.close();
    // The same house, started again on the same folder: the question is still there, still answered.
    const again = await leasedDesk(d.stored(), d.dir);
    expect(again.desk.suggestions.map((x) => [x.id, x.ask?.answered])).toEqual([['q1', 'Yes'], ['q2', undefined]]);
    await again.post('/api', await signMessage({ kind: 'panel.assistant.dismiss', id: 'q2' }, phone, { iss: 'http://h/me' }));
    again.close();
    const third = await leasedDesk(again.stored(), d.dir);
    expect(third.desk.suggestions.map((x) => x.id)).toEqual(['q1']);
    await third.post('/api', await signMessage({ kind: 'release' }, phone, { iss: 'http://h/me' }));
    third.close();
    const next = await leasedDesk(null, d.dir);
    expect(next.desk.suggestions).toEqual([]);
    next.close();
  });
});

describe('errands: what the owner\'s AI waits on, kept by the house', () => {
  it('a reply while the AI is away becomes the owner\'s question; only the owner\'s tap ends it, and the AI hears', async () => {
    const told: Record<string, unknown>[] = [];
    const d = await leasedDesk(null, undefined, told);
    const phone = await generateIdentity('phone');
    await d.post('/pair', { publicJwk: phone.publicJwk });
    const owner = async (p: Record<string, unknown>) => d.post('/api', await signMessage(p, phone, { iss: 'http://h/me' }));
    const { code } = await owner({ kind: 'panel.assistant.invite', label: 'Delta' });
    const ai = await generateIdentity('ai');
    expect(await d.post('/assistant', { publicJwk: ai.publicJwk, code, label: 'Delta', url: 'https://ai.example/a2a' })).toMatchObject({ paired: true });
    const asAi = async (p: Record<string, unknown>) => d.post('/api', await signMessage(p, ai, { iss: 'assistant' }));
    const sam = { name: 'Sam\'s AI', webId: 'https://sam.example/#agent', key: 'sam-jkt', url: 'https://sam.example/a2a' };

    const opened = await asAi({ kind: 'assistant.suggest', text: 'a lift to the airport on Friday', errand: { kind: 'ask', with: sam } });
    expect(opened).toMatchObject({ ok: true, id: expect.any(String) });
    expect(d.desk.suggestions[0]!.errand).toMatchObject({ state: 'open', arrivals: [] });
    // Sam answers while the AI is away: filed against the errand, put to the owner as a question.
    const held = await asAi({ kind: 'assistant.forward', errand: opened.id, from: { ...sam, domain: 'sam.example' }, text: 'Yes, 7am works. Petrol money?', stranger: true });
    expect(held).toMatchObject({ ok: true, held: opened.id, choices: ['Yes, go ahead', 'No thanks', 'Ask my AI later', 'Block'] });
    expect(d.desk.suggestions[0]!.text).toContain('Petrol money?');
    // A held errand is the owner's now: the AI can't answer or withdraw it.
    expect(await asAi({ kind: 'assistant.suggest', replaces: opened.id, text: '' })).toMatchObject({ error: expect.stringContaining('with your human') });
    // "Ask my AI later" keeps it held; a real answer ends it, and the AI's connector hears who and what.
    await owner({ kind: 'panel.assistant.answer', id: opened.id, choice: 'Ask my AI later' });
    expect(d.desk.suggestions[0]!.errand!.state).toBe('held');
    await owner({ kind: 'panel.assistant.answer', id: opened.id, choice: 'Yes, go ahead' });
    expect(d.desk.suggestions[0]!.errand).toMatchObject({ state: 'answered', ended: { how: 'answered' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(told.at(-1)).toMatchObject({ kind: 'house.news', about: 'question.answered', answer: 'Yes, go ahead', errand: { id: opened.id, with: { key: 'sam-jkt' }, state: 'answered' } });
    d.close();
  });

  it('a cart\'s yes says the AI pays; past its date an errand lapses quietly and the AI is told', async () => {
    const told: Record<string, unknown>[] = [];
    const d = await leasedDesk(null, undefined, told);
    const phone = await generateIdentity('phone');
    await d.post('/pair', { publicJwk: phone.publicJwk });
    const owner = async (p: Record<string, unknown>) => d.post('/api', await signMessage(p, phone, { iss: 'http://h/me' }));
    const { code } = await owner({ kind: 'panel.assistant.invite' });
    const ai = await generateIdentity('ai');
    await d.post('/assistant', { publicJwk: ai.publicJwk, code, url: 'https://ai.example/a2a' });
    const asAi = async (p: Record<string, unknown>) => d.post('/api', await signMessage(p, ai, { iss: 'assistant' }));
    const order = await asAi({ kind: 'assistant.suggest', text: 'a birthday cake', errand: { kind: 'order', ref: 'cake-1' } });
    const r = await asAi({ kind: 'assistant.forward', errand: order.id, arrived: 'trade.cart', ref: 'cart-9', from: { name: 'Bakery', domain: 'bake.example', webId: 'https://bake.example/#a' }, text: 'A cart for A$40' });
    expect(r.choices[0]).toBe('Yes, I\'ll have my AI pay');
    // Another assistant's errand can't be filed into.
    const other = await generateIdentity('other');
    const { code: c2 } = await owner({ kind: 'panel.assistant.invite' });
    await d.post('/assistant', { publicJwk: other.publicJwk, code: c2 });
    expect(await d.post('/api', await signMessage({ kind: 'assistant.forward', errand: order.id, from: { webId: 'https://x/#a' }, text: 'hi' }, other, { iss: 'assistant' }))).toMatchObject({ error: expect.stringContaining('no open errand') });
    // Its date passes: off the list, no question for the owner, the AI's connector told so it can tell the bakery.
    d.desk.suggestions[0]!.errand!.until = new Date(Date.now() - 1000).toISOString();
    (d.desk as unknown as { sweepErrands: () => void }).sweepErrands();
    expect(d.desk.suggestions).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(told.at(-1)).toMatchObject({ about: 'errand.ended', errand: { id: order.id, state: 'expired', ended: 'expired', arrivals: [{ kind: 'trade.cart', ref: 'cart-9' }] } });
    d.close();
  });
});
