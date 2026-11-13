import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filedIndex } from './filed.js';

const root = 'https://pod.example/me/';
/** A pod that counts its folder listings. */
function pod(files: string[], o: { failListings?: number } = {}) {
  const has = new Set(files);
  const calls = { listings: 0, reads: 0 };
  let fail = o.failListings ?? 0;
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input).slice(root.length), method = init?.method ?? 'GET';
    if (method === 'PUT') { has.add(path); return new Response('', { status: 201 }); }
    if (method === 'DELETE') { const ok = has.delete(path); return new Response(null, { status: ok ? 205 : 404 }); }
    if (path.endsWith('/')) {
      calls.listings++;
      if (fail-- > 0) return new Response('busy', { status: 500 });
      return new Response([...has].filter((f) => f.startsWith(path) && !f.slice(path.length).includes('/')).map((f) => `<${root}${path}> <http://www.w3.org/ns/ldp#contains> <${root}${f}>.`).join('\n'), { status: 200, headers: { 'content-type': 'text/turtle' } });
    }
    calls.reads++;
    return new Response(has.has(path) ? '{}' : '', { status: has.has(path) ? 200 : 404 });
  }) as typeof globalThis.fetch;
  return { session: { webId: `${root}profile/card#me`, podRoot: root, fetch }, calls, has };
}
const file = async () => join(await mkdtemp(join(tmpdir(), 'filed-')), 'pod-index.json');

describe('the pod\'s growing folders are listed once (12 Nov: a listing of 10,000 agreements took the pod server past its memory)', () => {
  it('lists a folder the first time, then answers from what it noted as the house filed and deleted', async () => {
    const p = pod(['agreements/a.consent.jsonld', 'agreements/b.agreement.json', 'receipts/r1.receipt.jwt']);
    const filed = await filedIndex(p.session, await file(), ['agreements/', 'receipts/']);
    expect((await filed.list('agreements/')).sort()).toEqual(['agreements/a.consent.jsonld', 'agreements/b.agreement.json']);
    await filed.session.fetch(`${root}agreements/c.consent.jsonld`, { method: 'PUT', body: '{}' });
    await filed.session.fetch(`${root}agreements/a.consent.jsonld`, { method: 'DELETE' });
    await filed.session.fetch(`${root}wallet/identity.json`, { method: 'PUT', body: '{}' });
    expect((await filed.list('agreements/')).sort()).toEqual(['agreements/b.agreement.json', 'agreements/c.consent.jsonld']);
    expect(await filed.list('agreements/')).toHaveLength(2);
    expect(p.calls.listings).toBe(1);
    expect(await filed.list('receipts/')).toEqual(['receipts/r1.receipt.jwt']);
    expect(p.calls.listings).toBe(2);
  });

  it('keeps the index across a restart, with what was filed before the folder was ever listed', async () => {
    const at = await file();
    const p = pod(['audit/1.json']);
    const first = await filedIndex(p.session, at, ['audit/']);
    await first.session.fetch(`${root}audit/2.json`, { method: 'PUT', body: '{}' });
    expect(first.listed('audit/')).toBe(false);
    await first.flush();
    const second = await filedIndex(p.session, at, ['audit/']);
    expect((await second.list('audit/')).sort()).toEqual(['audit/1.json', 'audit/2.json']);
    await second.flush();
    expect(JSON.parse(await readFile(at, 'utf8'))['audit/'].listed).toBe(true);
    const third = await filedIndex(p.session, at, ['audit/']);
    await third.session.fetch(`${root}audit/3.json`, { method: 'PUT', body: '{}' });
    expect(await third.list('audit/')).toHaveLength(3);
    expect(p.calls.listings).toBe(1);
  });

  it('gives what it knows when the listing fails, and doesn\'t ask a busy pod again at once', async () => {
    const p = pod(['receipts/old.receipt.jwt'], { failListings: 1 });
    const filed = await filedIndex(p.session, await file(), ['receipts/'], { retryMs: 60_000 });
    await filed.session.fetch(`${root}receipts/new.receipt.jwt`, { method: 'PUT', body: 'x' });
    expect(await filed.list('receipts/')).toEqual(['receipts/new.receipt.jwt']);
    expect(await filed.list('receipts/')).toEqual(['receipts/new.receipt.jwt']);
    expect(p.calls.listings).toBe(1);
    expect(filed.listed('receipts/')).toBe(false);
    const soon = await filedIndex(p.session, await file(), ['receipts/'], { retryMs: 0 });
    expect(await soon.list('receipts/')).toHaveLength(2);
  });

  it('says which file changed, so what was read of it is read again; a write that failed is not noted', async () => {
    const p = pod([]);
    const filed = await filedIndex(p.session, await file(), ['receipts/']);
    const seen: string[] = [];
    filed.onChange((path) => seen.push(path));
    await filed.session.fetch(`${root}receipts/r.receipt.jwt`, { method: 'PUT', body: 'held' });
    await filed.session.fetch(`${root}receipts/r.receipt.jwt`, { method: 'PUT', body: 'released' });
    await filed.session.fetch(`${root}receipts/gone.receipt.jwt`, { method: 'DELETE' });
    await filed.session.fetch(`${root}receipts/deep/x.json`, { method: 'PUT', body: '{}' });
    expect(seen).toEqual(['receipts/r.receipt.jwt', 'receipts/r.receipt.jwt']);
    expect(await filed.list('receipts/')).toEqual(['receipts/r.receipt.jwt']);
  });
});
