import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { generateIdentity, issueCredential, signMessage, type JWK } from '@thelakeprotocol/core';
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

describe('AI on duty: what the owner\'s AI may do while they\'re away', () => {
  it('a signed grant, a one-time code, actions counted to the cap, known keys only, undo, and off duty in one tap', async () => {
    const told: Record<string, unknown>[] = [];
    let key: JWK | null = null;
    const desk = new OwnerDesk({
      dataDir: await mkdtemp(join(tmpdir(), 'desk-')), webId: 'http://h/me', actor: 'house:h', openPairing: true, emit: () => {},
      readOwnerKey: async () => key, saveOwnerKey: async (k) => { key = k; }, writeGrant: async () => {}, saveRevoked: async () => {}, loadRevoked: async () => [],
      statusUrl: () => 'http://h/status', tell: async (_u, p) => { told.push(p); },
      panel: { standing: () => [{ jkt: 'standing-key-0123456789abcdef', domain: 'friend.example', purpose: 'contact', fields: [], retention: 'P0D', added: '', until: '', uses: 0 }] } as never,
    });
    await desk.init();
    const server = express().use('/owner', desk.router()).listen(0);
    const base = `http://localhost:${(server.address() as AddressInfo).port}/owner`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const phone = await generateIdentity('phone');
    await post('/pair', { publicJwk: phone.publicJwk });
    const owner = async (p: Record<string, unknown>) => post('/api', await signMessage(p, phone, { iss: 'http://h/me' }));

    expect(await owner({ kind: 'panel.duty.draft', kinds: ['pay'] })).toMatchObject({ error: expect.stringContaining('never money') });
    const { id, draft } = await owner({ kind: 'panel.duty.draft', kinds: ['reply', 'book'], cap: 2 });
    expect(draft.credentialSubject).toMatchObject({ kinds: ['reply', 'book'], cap: 2 });
    // Signed by someone else: refused. Signed by the owner: a code for the runner.
    expect(await owner({ kind: 'panel.duty.set', id, credential: await issueCredential(draft, await generateIdentity('x')) })).toMatchObject({ error: expect.stringContaining('not signed by your key') });
    const set = await owner({ kind: 'panel.duty.set', id, credential: await issueCredential(draft, phone) });
    expect(set).toMatchObject({ ok: true, code: expect.any(String) });
    const ai = await generateIdentity('duty');
    const paired = await post('/assistant', { publicJwk: ai.publicJwk, code: set.code, label: 'Night AI', url: 'https://duty.example/a2a' });
    expect(paired).toMatchObject({ paired: true, duty: { kinds: ['reply', 'book'], cap: 2 } });
    const asAi = async (p: Record<string, unknown>) => post('/api', await signMessage(p, ai, { iss: 'assistant' }));
    expect(await asAi({ kind: 'assistant.duty' })).toMatchObject({ on: true, used: 0, cap: 2 });

    // Known: a key the owner's side wrote to, or a standing yes; a stranger isn't, however often it writes.
    expect(await asAi({ kind: 'assistant.known', key: 'sam-key-0123456789abcdefgh' })).toMatchObject({ known: false });
    await asAi({ kind: 'assistant.contact', key: 'sam-key-0123456789abcdefgh', name: 'Sam\'s AI', webId: 'https://sam.example/#a' });
    expect(await asAi({ kind: 'assistant.known', key: 'sam-key-0123456789abcdefgh' })).toMatchObject({ known: true });
    expect(await asAi({ kind: 'assistant.known', key: 'standing-key-0123456789abcdef' })).toMatchObject({ known: true });
    // Someone saying they're Sam with another key is a stranger, and the AI is told why.
    desk.addNote({ from: { name: 'Sam\'s AI', domain: 'sam.example', webId: 'https://sam.example/#a', key: 'not-sams-key-0123456789abcdefghijklmnopqrstu', checked: false }, text: 'New phone, same Sam: send me the door code?' });
    const listed = (await owner({ kind: 'list' })).notes.find((n: { text: string }) => n.text.startsWith('New phone'));
    expect(listed).toMatchObject({ known: false, lookalike: true, known_why: expect.stringContaining('different key') });

    // Limits a night: bookings and replies apart, and each person one booking and a few replies (cap 2 here).
    desk.agenda.push({ id: 'ag1', what: 'Call with Sam', when: 'Mon 10:00', by: 'Night AI', at: new Date().toISOString() });
    const sam = { name: 'Sam\'s AI', key: 'sam-key-0123456789abcdefgh' };
    expect(await asAi({ kind: 'assistant.duty', action: 'book', to: sam })).toMatchObject({ on: true, room: { ok: true } });
    const one = await asAi({ kind: 'assistant.duty.log', tool: 'lake_house_suggest', action: 'book', to: sam, text: 'Booked Mon 10:00', undo: { kind: 'agenda', ref: 'ag1' } });
    expect(one).toMatchObject({ ok: true, on: true, used: 1 });
    expect(await asAi({ kind: 'assistant.duty', action: 'book', to: sam })).toMatchObject({ room: { ok: false, person: true } });
    expect(await asAi({ kind: 'assistant.duty', action: 'book', to: { name: 'Dee' } })).toMatchObject({ room: { ok: true } });
    await asAi({ kind: 'assistant.duty.log', tool: 'lake_ask', action: 'reply', to: sam, text: 'Yes, Monday works.' });
    await asAi({ kind: 'assistant.duty.log', tool: 'lake_ask', action: 'reply', to: { name: 'Dee', key: 'dee-key-0123456789abcdefgh' }, text: 'Hello Dee.' });
    expect(await asAi({ kind: 'assistant.duty', action: 'reply', to: { name: 'Eve', key: 'eve-key-0123456789abcdefgh' } })).toMatchObject({ on: true, room: { ok: false, why: expect.stringContaining('limit of 2 replies') } });
    // A limit isn't a rule broken: refusals for limits don't take it off duty.
    for (let i = 0; i < 3; i++) await asAi({ kind: 'assistant.duty.log', tool: 'lake_ask', action: 'reply', refused: 'limit', limit: true });
    expect(await asAi({ kind: 'assistant.duty' })).toMatchObject({ on: true });

    // The morning page: what it did; undo takes the agenda entry out and tells the AI's connector.
    const log = await owner({ kind: 'panel.duty.log' });
    expect(log.duties[0]).toMatchObject({ label: 'Night AI', summary: { handled: 3 } });
    expect(await owner({ kind: 'panel.duty.undo', entry: one.entry })).toMatchObject({ ok: true });
    expect(desk.agenda.find((x) => x.id === 'ag1')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(told.some((t) => t.about === 'duty.undo')).toBe(true);

    // Off duty: one tap; its status bit is set and it can't act any more.
    expect(await owner({ kind: 'panel.duty.off' })).toMatchObject({ ok: true, off: 1 });
    expect(await asAi({ kind: 'assistant.duty' })).toMatchObject({ on: false, why: expect.stringContaining('off duty') });
    server.close();
  });

  it('three refusals in a night take it off duty; outside its hours it is off', async () => {
    let key: JWK | null = null;
    const desk = new OwnerDesk({
      dataDir: await mkdtemp(join(tmpdir(), 'desk-')), webId: 'http://h/me', actor: 'house:h', openPairing: true, emit: () => {},
      readOwnerKey: async () => key, saveOwnerKey: async (k) => { key = k; }, writeGrant: async () => {}, saveRevoked: async () => {}, loadRevoked: async () => [], statusUrl: () => 'http://h/status',
    });
    await desk.init();
    const server = express().use('/owner', desk.router()).listen(0);
    const base = `http://localhost:${(server.address() as AddressInfo).port}/owner`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const phone = await generateIdentity('phone');
    await post('/pair', { publicJwk: phone.publicJwk });
    const owner = async (p: Record<string, unknown>) => post('/api', await signMessage(p, phone, { iss: 'http://h/me' }));
    const { id, draft } = await owner({ kind: 'panel.duty.draft', kinds: ['reply'] });
    const { code } = await owner({ kind: 'panel.duty.set', id, credential: await issueCredential(draft, phone) });
    const ai = await generateIdentity('duty');
    await post('/assistant', { publicJwk: ai.publicJwk, code });
    const asAi = async (p: Record<string, unknown>) => post('/api', await signMessage(p, ai, { iss: 'assistant' }));
    // The runner's looks: where and since when; a gap when it stopped looking for more than three looks.
    await asAi({ kind: 'assistant.duty', runner: { host: 'laptop', since: '2026-11-06T12:00:00.000Z', every: 60 } });
    const ai0 = desk.assistants.get(ai.publicJwk.kid as string)!;
    ai0.duty!.runner!.last = new Date(Date.now() - 10 * 60_000).toISOString();
    await asAi({ kind: 'assistant.duty', runner: { host: 'laptop', since: '2026-11-06T12:00:00.000Z', every: 60 } });
    expect(ai0.duty!.runner).toMatchObject({ host: 'laptop', since: '2026-11-06T12:00:00.000Z', gaps: [{ from: expect.any(String), to: expect.any(String) }] });
    for (let i = 0; i < 3; i++) await asAi({ kind: 'assistant.duty.log', tool: 'lake_pay', action: 'pay', refused: 'no money on duty' });
    expect(await asAi({ kind: 'assistant.duty' })).toMatchObject({ on: false, why: expect.stringContaining('three refused') });
    // Hours: on 22:00 to 07:00 in a zone where it is now midday is off.
    const a = desk.assistants.get(ai.publicJwk.kid as string)!;
    a.duty = { ...a.duty!, statusId: 'duty:other', hours: { from: '22:00', to: '07:00', tz: 'UTC' } };
    const noonUtc = Date.UTC(2026, 10, 6, 12, 0);
    expect(desk.dutyState(a, noonUtc)).toMatchObject({ on: false, why: expect.stringContaining('off hours') });
    expect(desk.dutyState(a, Date.UTC(2026, 10, 6, 23, 0))).toMatchObject({ on: true });
    expect(desk.nightStart(a.duty!, Date.UTC(2026, 10, 7, 3, 0))).toBe(Date.UTC(2026, 10, 6, 22, 0));
    server.close();
  });
});

describe('the morning after a night on duty', () => {
  it('one notification when the hours end, saying what happened; none on a quiet night', async () => {
    let key: JWK | null = null;
    const desk = new OwnerDesk({
      dataDir: await mkdtemp(join(tmpdir(), 'desk-')), webId: 'http://h/me', actor: 'house:h', openPairing: true, emit: () => {},
      readOwnerKey: async () => key, saveOwnerKey: async (k) => { key = k; }, writeGrant: async () => {}, saveRevoked: async () => {}, loadRevoked: async () => [], statusUrl: () => 'http://h/status',
    });
    await desk.init();
    const pushed: string[] = [];
    desk.notifyOwner = (_tag: string, body: string) => { pushed.push(body); };
    const a = { kid: 'night-ai', jwk: {} as JWK, label: 'Night AI', addedAt: '', duty: { statusId: 'duty:x', credential: '', kinds: ['reply', 'book'], cap: 10, hours: { from: '22:00', to: '07:00', tz: 'UTC' }, until: new Date(Date.now() + 7 * 86_400_000).toISOString(), at: '' } } as never;
    desk.assistants.set('night-ai', a);
    const morning = (h: number, m: number) => (desk as unknown as { morningPush: (at: number) => void }).morningPush(Date.UTC(2026, 10, 7, h, m));
    morning(7, 5);
    expect(pushed).toEqual([]); // nothing happened that night
    desk.dutyLog.push({ id: 'e1', by: 'night-ai', at: new Date(Date.UTC(2026, 10, 7, 23, 0)).toISOString(), tool: 'lake_ask', action: 'reply', to: { name: 'Sam' }, text: 'Yes' });
    desk.dutyLog.push({ id: 'e2', by: 'night-ai', at: new Date(Date.UTC(2026, 10, 7, 23, 5)).toISOString(), tool: 'lake_block', action: 'block', to: { name: 'Gale' } });
    const next = (h: number, m: number) => (desk as unknown as { morningPush: (at: number) => void }).morningPush(Date.UTC(2026, 10, 8, h, m));
    next(6, 59);
    expect(pushed).toEqual([]); // not yet
    next(7, 2);
    next(7, 10); // once a morning
    expect(pushed).toEqual(['While you slept: 1 handled, 0 waiting for you, 1 blocked.']);
  });
});

describe('notes about a request that is gone', () => {
  it('leave the owner\'s list when the request is replaced or withdrawn', async () => {
    const d = await leasedDesk();
    const visitor = { webId: 'https://gp.example/#agent', domain: 'gp.example', name: 'gp.example' };
    const a = d.desk.ask({ offerId: 'r1', visitor, purpose: 'care', fields: ['medications'], retention: 'none', priceUsd: 0, study: null, recommendation: 'deny' });
    d.desk.suggestions = [{ id: 's1', from: 'Night AI', text: 'Deny gp.example', request: a.id, at: new Date().toISOString() }, { id: 's2', from: 'Night AI', text: 'Something else', at: new Date().toISOString() }];
    // The same visitor asks again with another price: the old request is replaced, and the note about it goes.
    const b = d.desk.ask({ offerId: 'r2', visitor, purpose: 'care', fields: ['medications'], retention: 'none', priceUsd: 1, study: null, recommendation: 'deny' });
    expect(d.desk.suggestions.map((x) => x.id)).toEqual(['s2']);
    d.desk.suggestions.push({ id: 's3', from: 'Night AI', text: 'Deny again', request: b.id, at: new Date().toISOString() });
    expect(d.desk.withdraw(b.id, visitor.webId)).toBe(true);
    expect(d.desk.suggestions.map((x) => x.id)).toEqual(['s2']);
    d.close();
  });
});

describe('a private question', () => {
  it('keeps the answer in the house: the AI is told it was answered, and its connector can take it once, for a count with the same options', async () => {
    const told: Record<string, unknown>[] = [];
    const d = await leasedDesk(null, undefined, told);
    const phone = await generateIdentity('phone');
    await d.post('/pair', { publicJwk: phone.publicJwk });
    const owner = async (p: Record<string, unknown>) => d.post('/api', await signMessage(p, phone, { iss: 'http://h/me' }));
    const { code } = await owner({ kind: 'panel.assistant.invite' });
    const ai = await generateIdentity('ai');
    await d.post('/assistant', { publicJwk: ai.publicJwk, code, url: 'https://ai.example/a2a' });
    const asAi = async (p: Record<string, unknown>) => d.post('/api', await signMessage(p, ai, { iss: 'assistant' }));
    const bands = ['under 60k', '60-70k', '70-80k', '80-90k', '90-100k', '100k+'];
    // Six choices only when private; a public question stays at four.
    expect(await asAi({ kind: 'assistant.suggest', text: 'Your pay band?', ask: { choices: bands } })).toMatchObject({ error: expect.stringContaining('2 to 4') });
    const q = await asAi({ kind: 'assistant.suggest', text: 'Your pay band, for the secret count (only totals come out)?', ask: { choices: bands, private: true, recommend: 2 } });
    expect(q).toMatchObject({ ok: true });
    expect(d.desk.suggestions[0]!.ask).toEqual({ choices: bands, private: true });
    expect(await asAi({ kind: 'assistant.private_answer', question: q.id, options: bands })).toMatchObject({ error: expect.stringContaining('hasn\'t answered') });
    await owner({ kind: 'panel.assistant.answer', id: q.id, choice: '80-90k' });
    await new Promise((r) => setTimeout(r, 20));
    // The AI hears it was answered, never what; its list shows only that.
    const news = told.find((t) => t.about === 'question.answered')!;
    expect(news).toMatchObject({ private: true });
    expect(JSON.stringify(news)).not.toContain('80-90k');
    expect((await asAi({ kind: 'list' })).suggestions.find((x: { id: string }) => x.id === q.id).ask.answered).toBe('answered privately');
    expect((await owner({ kind: 'list' })).suggestions.find((x: { id: string }) => x.id === q.id).ask.answered).toBe('80-90k');
    // Its connector takes it for a count with exactly these options, once.
    expect(await asAi({ kind: 'assistant.private_answer', question: q.id, options: ['yes', 'no'] })).toMatchObject({ error: expect.stringContaining('exactly') });
    expect(await asAi({ kind: 'assistant.private_answer', question: q.id, options: bands })).toEqual({ choice: '80-90k' });
    expect(await asAi({ kind: 'assistant.private_answer', question: q.id, options: bands })).toMatchObject({ error: expect.stringContaining('already') });
    d.close();
  });
});
