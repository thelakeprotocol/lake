import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
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
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
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
      // One phone, paired once; the second run switches it to light.
      if (!page) { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 }); page = await ctx.newPage(); }
      await page.emulateMedia({ colorScheme: scheme });
      if (scheme === 'dark') page.on('pageerror', (e) => errors.push(e.message));
      // Which looks are still on their way when a page doesn't settle, and how long each took.
      const waiting = new Map<unknown, { kind: string; at: number }>(), took: string[] = [];
      page.on('request', (r) => { if (r.url().endsWith('/owner/api')) { try { waiting.set(r, { kind: JSON.parse(r.postData() ?? '{}').payload?.kind ?? '?', at: Date.now() }); } catch { /* not ours */ } } });
      page.on('requestfinished', (r) => { const w = waiting.get(r); if (w) { took.push(`${w.kind} ${Date.now() - w.at}ms`); waiting.delete(r); } });
      const still = () => [...waiting.values()].map((w) => `${w.kind} ${Date.now() - w.at}ms`).join(', ');
      await page.goto(`${site}/owner/`);
      if (scheme === 'dark') await page.getByRole('button', { name: 'Use this phone' }).click();
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
});
