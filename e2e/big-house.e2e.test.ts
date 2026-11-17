import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { generateIdentity } from '../packages/core/src/index.js';
import { ask, makeVisitor } from '../packages/visitor/src/knock.js';
import { podFolder, seedBigHouse } from './big-house.js';

// Every page of the owner's app on a house as big as a real one, at phone size, light and dark: each shows real content
// within a few seconds, never a skeleton or "Looking…" for long, never wider than the phone, and nothing throws
// (18 Nov, the owner: "I don't want to see things not working in the app"; pages that loaded for ever on their house
// passed every test on small ones). A page seen once opens at once the second time.

const procs: ChildProcess[] = [];
let dir: string, site: string, browser: Browser, page: Page, houseArgs: string[];
const errors: string[] = [];
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
function start(args: string[], ready: RegExp): Promise<ChildProcess> {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    const timer = setTimeout(() => fail(new Error(`timed out:\n${out.slice(-2000)}`)), 180_000);
    const on = (b: Buffer) => { out += b; if (ready.test(out)) { clearTimeout(timer); ok(p); } };
    p.stdout!.on('data', on); p.stderr!.on('data', on);
    p.once('exit', (c) => fail(new Error(`exited ${c}:\n${out.slice(-2000)}`)));
  });
}
const SIZE = { consents: 3000, receipts: 1500, audits: 400 };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lake-big-'));
  const [np, sp, pp, hp] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const node = `http://localhost:${np}`, specialists = `http://localhost:${sp}`;
  site = `http://localhost:${hp}`;
  await start(['packages/lake/dist/main.js', '--port', String(np), '--data', join(dir, 'node')], /Lake node on/);
  await start(['packages/specialists/dist/main.js', 'all', '--port', String(sp), '--data', join(dir, 'specialists'), '--lake', node, '--packs', 'health,shopping'], /register registered with the Lake node/);
  houseArgs = ['packages/house/dist/main.js', '--name', 'big', '--rules', 'personas/stan.yaml', '--data', join(dir, 'house'), '--issuer-url', `${specialists}/issuer`, '--auditor-url', `${specialists}/auditor`,
    '--pod-port', String(pp), '--port', String(hp), '--lake', node, '--seed', '7', '--open-pairing', '--public-url', site];
  let house = await start(houseArgs, /joined the Lake/);
  const card = await (await fetch(`${site}/.well-known/agent-card.json`)).json() as { capabilities: { extensions: { params: { webId: string } }[] } };
  const owner = card.capabilities.extensions[0]!.params.webId;
  // Stopped while its pod is filled, then started again with nothing it read before.
  await new Promise<void>((ok) => { house.once('exit', () => ok()); house.kill('SIGTERM'); });
  const pod = await podFolder(join(dir, 'house'));
  const t = Date.now();
  const n = await seedBigHouse({ pod, owner, house: site, payments: `${specialists}/payments/#payments`, ...SIZE });
  console.log(`seeded ${n} files in ${Date.now() - t} ms`);
  for (const f of ['pod-index.json', 'money-cache.json', 'consent-index.json']) await rm(join(dir, 'house', 'big', f), { force: true }).catch(() => {});
  house = await start(houseArgs, /joined the Lake/);
  // People who wrote: sixty notes from thirty senders, through the door as real notes (the People list, Today's counts).
  const senders = await Promise.all(Array.from({ length: 30 }, async (_, i) => makeVisitor(await generateIdentity(), `writer-${i}.example`)));
  for (let r = 0; r < 2; r++) await Promise.all(senders.map((v, i) => ask(`${site}/a2a`, v, { kind: 'note', text: `Hello from writer ${i}, note ${r + 1}: could we talk about the garden this weekend?` }).catch(() => {})));
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
  // One phone, paired once, for every test here.
  page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${site}/owner/`);
  await page.getByRole('button', { name: 'Use this phone' }).click();
  await page.locator('ion-tab-button').first().waitFor({ timeout: 30_000 });
}, 600_000);

afterAll(async () => {
  await browser?.close();
  for (const p of procs) p.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

// Settled: no skeleton or spinner on the page in front, and no "Looking…".
const settle = async (p: Page, budget: number) => {
  const t = Date.now();
  const busy = () => p.evaluate(() => {
    const top = [...document.querySelectorAll('.ion-page:not(.ion-page-hidden)')].pop() ?? document.body;
    return [...top.querySelectorAll('ion-skeleton-text')].filter((e) => e.getBoundingClientRect().height > 0).length + (/(^|\n)\s*Looking…/.test((top as HTMLElement).innerText) ? 1 : 0);
  });
  while (Date.now() - t < budget && await busy()) await p.waitForTimeout(200);
  return { ms: Date.now() - t, done: !(await busy()) };
};

const PAGES: [string, string][] = [['#inbox', 'Today'], ['#chats', 'People'], ['#ai', 'My AI'], ['#you', 'You'], ['#door', 'Your door'], ['#free', 'When you can meet'], ['#rules', 'Rules'],
  ['#mydata', 'My data'], ['#access', 'Who has access'], ['#seen', 'Seen from outside'], ['#data', 'What your house holds'], ['#money', 'Money'], ['#offers', 'Offers for you'], ['#address', 'Delivery address'],
  ['#phone', 'This phone'], ['#notify', 'Notifications'], ['#key', 'New or lost phone'], ['#about', 'About this house']];

describe('the owner\'s app on a big house, at phone size', () => {
  for (const scheme of ['dark', 'light'] as const) {
    it(`every page shows real content within a few seconds (${scheme}), and opens at once the second time`, async () => {
      await page.emulateMedia({ colorScheme: scheme });
      // Which looks are still on their way when a page doesn't settle, and how long each took.
      const waiting = new Map<unknown, { kind: string; at: number }>(), took: string[] = [];
      page.on('request', (r) => { if (r.url().endsWith('/owner/api')) { try { waiting.set(r, { kind: JSON.parse(r.postData() ?? '{}').payload?.kind ?? '?', at: Date.now() }); } catch { /* not ours */ } } });
      page.on('requestfinished', (r) => { const w = waiting.get(r); if (w) { took.push(`${w.kind} ${Date.now() - w.at}ms`); waiting.delete(r); } });
      const still = () => [...waiting.values()].map((w) => `${w.kind} ${Date.now() - w.at}ms`).join(', ');
      await page.goto(`${site}/owner/`);
      await page.locator('ion-tab-button').first().waitFor({ timeout: 30_000 });
      const first: Record<string, number> = {}, again: Record<string, number> = {};
      for (const [hash, name] of PAGES) {
        await page.evaluate((h) => { location.hash = h; }, hash);
        const s = await settle(page, 10_000);
        first[name] = s.ms;
        expect(s.done, `${name} still loading after 10 s (${scheme}); still waiting on: ${still()}; slowest done: ${took.filter((x) => Number(x.split(' ').pop()!.replace('ms', '')) > 2000).join(', ')}`).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} wider than the phone`).toBe(true);
      }
      for (const [hash, name] of PAGES.filter(([, n]) => ['Money', 'My data', 'What your house holds', 'Who has access'].includes(n))) {
        await page.evaluate(() => { location.hash = '#inbox'; });
        await page.waitForTimeout(300);
        await page.evaluate((h) => { location.hash = h; }, hash);
        again[name] = (await settle(page, 10_000)).ms;
        expect(again[name], `${name} the second time (${scheme})`).toBeLessThan(1500);
      }
      console.table(Object.keys(first).map((k) => ({ page: k, first_ms: first[k], again_ms: again[k] ?? '' })));
      expect(errors).toEqual([]);
    }, 400_000);
  }

  it('taps every tile on Today and every row under You: each opens its own page, settled, and Money says what Today says', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const top = () => page.locator('.ion-page:not(.ion-page-hidden)').last();
    const go = async (h: string) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(500); await settle(page, 10_000); };
    // Today's tiles, each to the page about it.
    await go('#inbox');
    const tiles = await top().locator('.handled-tile').allTextContents();
    expect(tiles.length).toBeGreaterThan(0);
    const SUBJECT: [RegExp, string][] = [[/came in/, '#money'], [/stud/, '#mydata'], [/request/, '#access'], [/fake|turned away/, '#about'], [/door note/, '#chats']];
    let moneyTile = '';
    for (const t of tiles) {
      await go('#inbox');
      await top().locator('.handled-tile', { hasText: t.slice(0, 20) }).first().click();
      await page.waitForTimeout(500);
      const s = await settle(page, 10_000);
      expect(s.done, `the tile "${t}" opened a page still loading`).toBe(true);
      const want = SUBJECT.find(([re]) => re.test(t));
      if (want) expect(page.url(), `the tile "${t}"`).toContain(want[1]);
      if (/came in today/.test(t)) moneyTile = /\$[\d,.]+|A\$[\d,.]+/.exec(t)?.[0] ?? '';
    }
    // The same money on Money as on Today (18 Nov: "$420 came in" on Today, "$4129 Earned" on Money, neither saying which).
    // Twenty of the seeded payments are from today: the tile is there, and Money says the same.
    expect(moneyTile, `no "came in today" tile among: ${tiles.join(' | ')}`).not.toBe('');
    {
      await go('#money');
      expect(await top().locator('.stat-today').textContent()).toContain(moneyTile);
    }
    // Every row under You and the pages under it opens somewhere, settled, and isn't wider than the phone.
    for (const hub of ['#you', '#mydata', '#money', '#phone', '#door']) {
      await go(hub);
      const rows = (await top().locator('ion-item.lake-row, ion-item.you-row, .you-row').evaluateAll((es) => es.filter((e) => (e as HTMLElement & { button?: boolean }).button || e.classList.contains('you-row')).map((e) => (e.querySelector('h3') ?? e).textContent!.trim()))).filter(Boolean);
      for (const r of rows) {
        await go(hub);
        const before = page.url(), len = () => top().evaluate((e) => (e as HTMLElement).innerText.length), was = await len();
        await top().locator('ion-item, .you-row', { hasText: r }).first().click();
        await page.waitForTimeout(600);
        const s = await settle(page, 10_000);
        // A page, a sheet, or something opened in place ("Show all", a row's details).
        expect(page.url() !== before || await page.locator('ion-modal.show-modal').count() > 0 || (await len()) !== was, `${hub} → "${r}" opened nothing`).toBe(true);
        expect(s.done, `${hub} → "${r}" still loading after 10 s`).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${hub} → "${r}" wider than the phone`).toBe(true);
        if (await page.locator('ion-modal.show-modal').count()) await page.keyboard.press('Escape');
      }
    }
    // People: the list, and a chat from it.
    await go('#chats');
    await top().locator('ion-item').filter({ hasText: /writer|Hello/ }).first().click();
    await page.waitForTimeout(600);
    expect((await settle(page, 10_000)).done).toBe(true);
    expect(errors).toEqual([]);
  }, 400_000);

  it('takes a yes back, then every yes, within seconds on a big house, and the page says so (round 85, a privacy-minded owner)', async () => {
    const top = () => page.locator('.ion-page:not(.ion-page-hidden)').last();
    const confirm = async (name: string) => { await page.locator('ion-action-sheet').getByRole('button', { name, exact: true }).click(); };
    const nowCount = async () => Number(await top().locator('.stat.mint b').first().textContent());
    await page.evaluate(() => { location.hash = '#access'; });
    await settle(page, 10_000);
    const before = await nowCount();
    expect(before, 'the seeded house has yeses from today').toBeGreaterThan(1);
    // One agent's yeses.
    const row = top().locator('ion-item.access-row', { hasText: 'Take it back' }).first();
    const who = (await row.locator('h3').textContent())!.trim();
    let t = Date.now();
    await row.locator('ion-button', { hasText: 'Take it back' }).first().click();
    await confirm('Take back');
    await page.locator('ion-toast', { hasText: 'Taken back' }).waitFor({ timeout: 8000 });
    const one = Date.now() - t;
    await expect.poll(nowCount, { timeout: 8000 }).toBe(before - 1);
    expect(await top().locator('ion-item.access-row', { hasText: who }).filter({ hasText: 'Take it back' }).count(), `${who} still shows Take it back`).toBe(0);
    // Every yes.
    t = Date.now();
    await page.locator('ion-button', { hasText: 'Take everything back' }).last().click();
    await confirm('Take everything back');
    await page.locator('ion-toast', { hasText: 'Taken back' }).last().waitFor({ timeout: 15_000 });
    const all = Date.now() - t;
    await expect.poll(nowCount, { timeout: 10_000 }).toBe(0);
    console.log(`took back one agent's yeses in ${one} ms, every yes in ${all} ms`);
    expect(one).toBeLessThan(6000);
    expect(all).toBeLessThan(10_000);
    expect(errors).toEqual([]);
  }, 120_000);
});
